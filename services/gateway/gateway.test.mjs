import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAuthenticator } from './access.mjs';
import { createWorker } from './index.mjs';
import { createLumaClient } from './client/luma-client.mjs';

const env = {
  ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
  ACCESS_AUD: 'a'.repeat(64), OWNER_EMAIL: 'owner@example.com', LUMA_RELEASE: 'test',
};
const keys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey);
jwk.kid = 'synthetic-key';
const app = createWorker(createAuthenticator(createLocalJWKSet({ keys: [jwk] })));
async function token(overrides = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: env.OWNER_EMAIL, type: 'app', sub: 'synthetic-owner',
    iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], iat: now, exp: now + 300, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).sign(privateKey);
}
function call(path, assertion, extraEnv = {}, headers = {}) {
  return app.fetch(new Request(`https://example.com${path}`, {
    headers: { ...(assertion ? { 'cf-access-jwt-assertion': assertion } : {}), ...headers },
  }), { ...env, ...extraEnv });
}

test('Signed owner obtains identity and honest capability status without secrets', async () => {
  const assertion = await token();
  const response = await call('/api/bootstrap', assertion);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.id, 'synthetic-owner');
  assert.equal(data.capabilities.authentication.ready, true);
  assert.equal(data.capabilities.memory.ready, false);
  assert.equal(data.capabilities.memory.authority, 'cloudSync');
  const text = JSON.stringify(data);
  assert.equal(text.includes(assertion), false);
  assert.equal(text.includes(env.OWNER_EMAIL), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await call('/api/session', assertion);
  assert.deepEqual((await session.json()).user, data.user);
});

test('Forged email, missing token and incomplete deployment fail closed', async () => {
  const missing = await call('/api/session', null, {}, { 'cf-access-authenticated-user-email': env.OWNER_EMAIL });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, 'login_required');
  const unconfigured = await call('/api/session', await token(), { ACCESS_AUD: undefined });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error, 'auth_not_configured');
});

test('Other owners, applications, issuers, expired/future and service tokens cannot enter', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { email: 'someone-else@example.com' }, { aud: ['b'.repeat(64)] },
    { iss: 'https://other-team.cloudflareaccess.com' }, { exp: now - 60 },
    { nbf: now + 60 }, { iat: now + 60 }, { iat: now - 90000 },
    { type: 'org' }, { sub: '' }, { email: undefined }, { exp: undefined },
  ]) {
    const response = await call('/api/session', await token(claims));
    assert.equal(response.status, 403, JSON.stringify(claims));
  }
  const otherKeys = await generateKeyPair('RS256');
  assert.equal((await call('/api/session', await token({}, otherKeys.privateKey))).status, 403);
  assert.equal((await call('/api/session', 'not-a-jwt')).status, 403);
});

test('Static assets require the same identity; API misses never serve the SPA', async () => {
  let reads = 0;
  const assets = { ASSETS: { fetch: async () => { reads++; return new Response('<html>synthetic</html>'); } } };
  assert.equal((await call('/', null, assets)).status, 401);
  assert.equal(reads, 0);
  const assertion = await token();
  const page = await call('/', assertion, assets);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  for (const path of ['/api/missing', '/v1/search/memories', '/api', '/v1']) {
    assert.equal((await call(path, assertion, assets)).status, 404);
  }
  assert.equal(reads, 1);
});

test('Browser client distinguishes a login HTML page, network failure and backend errors', async () => {
  for (const response of [
    new Response('<html>Access login</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('', { status: 401 }),
  ]) {
    await assert.rejects(createLumaClient(async () => response).bootstrap(), { code: 'login_required' });
  }
  await assert.rejects(createLumaClient(async () => { throw new Error('synthetic'); }).session(),
    { code: 'network_unavailable' });
  await assert.rejects(createLumaClient(async () => new Response('{"error":"auth_not_configured"}',
    { status: 503 })).bootstrap(), { code: 'auth_not_configured' });
  await createLumaClient(async (path, init) => {
    assert.equal(path, '/api/bootstrap');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.authorization, undefined);
    return new Response('{"schema":"luma.bootstrap/1"}');
  }).bootstrap();
});
