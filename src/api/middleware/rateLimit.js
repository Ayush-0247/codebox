import config from '../../utils/config.js';

// In-memory fixed-window limiters. One API instance per deployment (see the
// compose files); with several API instances behind a balancer each enforces
// its own budget, so put a limit at the proxy as well.
//
// SA-H4: there are two independent budgets.
//   - unauthenticatedLimiter: per client IP, for every request that does not
//     carry a valid token (health checks, probes, scanners, wrong tokens).
//   - rateLimitMiddleware: per authenticated client (token), after auth.
// Unauthenticated traffic can therefore never consume the budget of the
// backend that calls CodeBox. req.ip is only meaningful with a correct
// TRUST_PROXY (1 behind the bundled Caddy).

const MAX_TRACKED_KEYS = 50_000;

export function createLimiter({ windowMs, max, keyOf }) {
  const clients = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of clients) {
      if (now - value.windowStart > windowMs) clients.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref?.();

  return function limiter(req, res, next) {
    const key = keyOf(req);
    const now = Date.now();
    let client = clients.get(key);

    if (!client || now - client.windowStart > windowMs) {
      if (!client && clients.size >= MAX_TRACKED_KEYS) clients.delete(clients.keys().next().value);
      client = { windowStart: now, count: 0 };
      clients.set(key, client);
    }

    client.count++;

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - client.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil((client.windowStart + windowMs) / 1000)));

    if (client.count > max) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil((client.windowStart + windowMs - now) / 1000),
      });
    }

    next();
  };
}

/**
 * Rate-limit identity of a client address. IPv6 clients get a whole /64 per
 * host, so one address per request would bypass a per-address budget (FV-8).
 */
export function ipKey(address) {
  const ip = String(address || 'unknown').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'), ...tailParts]
    : headParts;
  return `${groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const clientIp = (req) => ipKey(req.ip || req.socket?.remoteAddress || 'unknown');

/** Per-IP budget for requests without a valid token. */
export const unauthenticatedLimiter = createLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.unauthenticatedMaxRequests,
  keyOf: (req) => `ip:${clientIp(req)}`,
});

/** Per-client budget for authenticated requests (key set by authMiddleware). */
export const rateLimitMiddleware = createLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  keyOf: (req) => `client:${req.clientId || clientIp(req)}`,
});

export default rateLimitMiddleware;
