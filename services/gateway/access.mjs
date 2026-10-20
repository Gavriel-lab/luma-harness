import { createRemoteJWKSet, jwtVerify } from 'jose';

const resolvers = new Map();
export class AccessError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function configuration(env) {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') ||
      !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD || '') || !env.OWNER_EMAIL) {
    throw new AccessError('auth_not_configured', 503);
  }
  return issuer;
}

// The injected key resolver is a test seam, never an environment-variable bypass.
export function createAuthenticator(keyResolver) {
  return async (request, env) => {
    const issuer = configuration(env);
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new AccessError('login_required', 401);
    if (token.length > 16384) throw new AccessError('access_denied', 403);
    let resolver = keyResolver;
    if (!resolver) {
      resolver = resolvers.get(issuer);
      if (!resolver) {
        resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
          timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000,
        });
        resolvers.set(issuer, resolver);
      }
    }
    try {
      const { payload } = await jwtVerify(token, resolver, {
        algorithms: ['RS256'], issuer, audience: env.ACCESS_AUD,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'], clockTolerance: 5, maxTokenAge: '24h',
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub ||
          typeof payload.email !== 'string' ||
          payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
        throw new AccessError('access_denied', 403);
      }
      return { id: payload.sub, name: env.OWNER_NAME || '使用者', role: 'owner' };
    } catch (error) {
      if (error instanceof AccessError) throw error;
      if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) {
        throw new AccessError('identity_unavailable', 503);
      }
      throw new AccessError('access_denied', 403);
    }
  };
}

export const authenticate = createAuthenticator();
