import net from 'net';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import config, { validateSecurityConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { authenticate } from './middleware/auth.js';
import { rateLimitMiddleware, unauthenticatedLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { metricsHandler } from './metrics.js';
import routes from './routes/index.js';

const app = express();
app.disable('x-powered-by');

// Host allow-list (ALLOWED_HOSTS), checked on the raw Host header before
// anything else. A web page that rebinds its own domain to 127.0.0.1 would
// otherwise reach a loopback CodeBox as "same origin", and the local token is
// public (FV-2).
export function hostAllowed(hostHeader, allowedHosts = config.server.allowedHosts) {
  if (allowedHosts.length === 0) return true;
  const raw = String(hostHeader || '').trim().toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '');
  return allowedHosts.includes(host);
}
app.use((req, res, next) => {
  if (hostAllowed(req.headers.host)) return next();
  res.status(421).json({ error: 'Misdirected Request', message: 'Unknown host' });
});
// Client IPs for the unauthenticated limiter (1 behind the bundled Caddy).
app.set('trust proxy', config.server.trustProxy);

// Security headers. CORS only for explicitly listed origins: this is a
// server-to-server API and browsers never need to call it.
app.use(helmet());
if (config.server.corsOrigins.length > 0) {
  app.use(cors({ origin: config.server.corsOrigins }));
}

// Request logging: method, path, status, duration, client. Never bodies
// (source code, testcase input) or tokens.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      ip: req.ip,
      client: req.clientId,
    });
  });
  next();
});

// Health check: no token needed. Requests without a valid token use the
// per-IP unauthenticated budget; the backend's own probes (valid token) do not.
app.get('/health', (req, res, next) => (authenticate(req).ok ? next() : unauthenticatedLimiter(req, res, next)), (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Prometheus scrape: only directly from inside the private network (the
// bundled Prometheus container). Anything that came through the reverse
// proxy carries X-Forwarded-For and must authenticate like any other client.
function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^f[cd]/i.test(ip);
}
app.get('/metrics', (req, res, next) => {
  if (!req.get('x-forwarded-for') && isPrivateAddress(req.socket?.remoteAddress)) {
    return metricsHandler(req, res);
  }
  next(); // authenticated route below
});

// Authentication BEFORE body parsing and before the authenticated budget
// (SA-H4, SA-M8): a request without a valid token costs one hash and is
// counted against its own IP's unauthenticated budget only.
app.use((req, res, next) => {
  const result = authenticate(req);
  if (result.ok) {
    req.clientId = result.clientId;
    return next();
  }
  return unauthenticatedLimiter(req, res, () => res.status(401).json(result.body));
});

// Per authenticated client.
app.use(rateLimitMiddleware);

// Request parsing, for authenticated requests only.
app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

// API routes
app.use('/', routes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Start the Express server
 */
export function startServer() {
  const problems = validateSecurityConfig();
  if (problems.length > 0) {
    for (const problem of problems) logger.error({ event: 'unsafe_config' }, problem);
    if (config.server.nodeEnv === 'production') {
      return Promise.reject(new Error(`Refusing to start with unsafe settings: ${problems.join(' ')}`));
    }
  }
  const port = config.server.port;

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`Server started on port ${port}`);
      logger.info(`Environment: ${config.server.nodeEnv}`);
      resolve(server);
    });
    // Slow clients cannot hold connections open indefinitely.
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
  });
}

export default app;
