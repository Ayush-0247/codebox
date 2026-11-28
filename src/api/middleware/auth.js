import crypto from 'crypto';
import config from '../../utils/config.js';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Index of the configured token that matches, or -1. Compares fixed-length
 * digests with timingSafeEqual and always checks every token, so response
 * timing does not reveal how much of a guess was right.
 */
export function matchToken(candidate, tokens = config.auth.tokens) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) return -1;
  const given = digest(candidate);
  let match = -1;
  tokens.forEach((token, index) => {
    if (crypto.timingSafeEqual(given, digest(token)) && match === -1) match = index;
  });
  return match;
}

/** Stable, non-secret identifier of an authenticated client (for rate limiting and logs). */
export const clientIdForToken = (index) => `token-${index}`;

/**
 * Checks the request's token without answering it.
 * @returns {{ ok: true, clientId: string } | { ok: false, body: object }}
 */
export function authenticate(req) {
  if (config.auth.tokens.length === 0) return { ok: true, clientId: 'anonymous-dev' };
  let token = null;
  for (const header of config.auth.headers) {
    token = req.get(header);
    if (token) break;
  }
  if (!token) return { ok: false, body: { error: 'Authentication required', message: 'Missing authentication header' } };
  const index = matchToken(token);
  if (index < 0) return { ok: false, body: { error: 'Authentication failed', message: 'Invalid authentication token' } };
  return { ok: true, clientId: clientIdForToken(index) };
}

/**
 * Authentication middleware (runs before body parsing and before the
 * authenticated rate limit, SA-H4). Accepts the token from any configured
 * header (X-Auth-Token, x-rapidapi-key, ...). Sets req.clientId on success.
 */
export function authMiddleware(req, res, next) {
  // Skip auth if no tokens configured (refused at startup in production).
  if (config.auth.tokens.length === 0) {
    req.clientId = 'anonymous-dev';
    return next();
  }

  let token = null;
  for (const header of config.auth.headers) {
    token = req.get(header);
    if (token) break;
  }

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Missing authentication header',
    });
  }

  const index = matchToken(token);
  if (index < 0) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid authentication token',
    });
  }

  req.clientId = clientIdForToken(index);
  next();
}

export default authMiddleware;
