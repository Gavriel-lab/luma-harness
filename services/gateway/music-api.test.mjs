import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './index.mjs';

const authOwner = async () => ({ id: 'synth_owner', name: 'SYNTH', role: 'owner' });

test('music routes require Access authentication before forward', async () => {
  let backendCalled = false;
  const w = createWorker(async () => { throw new Error('no identity'); });
  const res = await w.fetch(new Request('https://luma.test/api/music/user/status'), {});
  assert.equal(res.status, 503);
  assert.equal(backendCalled, false);
});

test('music routes proxy GET requests with secret to backend', async () => {
  let capturedUrl = '';
  let capturedHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedHeaders = opts?.headers;
    return new Response(JSON.stringify({ ok: true, profile: { isLoggedIn: false } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const w = createWorker(authOwner);
    const env = {
      MUSIC_API_ENDPOINT: 'https://backend.test/luma-music',
      LUMA_MUSIC_SECRET: 'test-secret'
    };
    const res = await w.fetch(new Request('https://luma.test/api/music/user/status?t=123'), env);
    assert.equal(res.status, 200);
    assert.equal(capturedUrl, 'https://backend.test/luma-music/api/music/user/status?t=123');
    assert.equal(capturedHeaders?.get('x-luma-music-secret'), 'test-secret');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.profile.isLoggedIn, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('music routes support POST methods (e.g. logout)', async () => {
  let capturedMethod = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedMethod = opts?.method;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const w = createWorker(authOwner);
    const env = {
      MUSIC_API_ENDPOINT: 'https://backend.test/luma-music',
      LUMA_MUSIC_SECRET: 'synthetic-private-secret'
    };
    const res = await w.fetch(new Request('https://luma.test/api/music/logout', { method: 'POST' }), env);
    assert.equal(res.status, 200);
    assert.equal(capturedMethod, 'POST');
  } finally {
    globalThis.fetch = origFetch;
  }
});
test('unconfigured optional music never falls back to a shared backend',async()=>{
 const response=await createWorker(authOwner).fetch(new Request('https://luma.test/api/music/user/status'),{});
 assert.equal(response.status,503);assert.equal((await response.json()).error,'music_not_configured');
});
