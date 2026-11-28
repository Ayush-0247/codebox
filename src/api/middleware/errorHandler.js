import logger from '../../utils/logger.js';
import { TenantLimitError } from '../../queue/tenants.js';

/**
 * Global error handling middleware
 */
export function errorHandler(err, req, res, next) {
  // Per-tenant admission (round 2): expected answers, not server errors, so
  // they are not logged one line per request.
  if (err instanceof TenantLimitError) {
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(err.status).json({
      error: err.status === 503 ? 'Service Unavailable' : err.status === 400 ? 'Bad Request' : 'Too Many Requests',
      code: err.code,
      message: err.message,
      ...(err.retryAfterSeconds ? { retryAfter: err.retryAfterSeconds } : {}),
    });
  }

  // Log the error. Never the body: it holds users' source code and testcase
  // input (privacy, and multi-megabyte log lines).
  logger.error({
    err: { name: err?.name, message: err?.message, type: err?.type, statusCode: err?.statusCode },
    method: req.method,
    path: req.path,
    bodyBytes: Number(req.get?.('content-length')) || undefined,
    ip: req.ip,
    client: req.clientId,
  });

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload Too Large', message: 'Request body is too large' });
  }

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(422).json({
      error: 'Validation Error',
      message: err.message,
    });
  }

  if (err.name === 'SyntaxError' && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  // Default server error
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.name || 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message,
  });
}

/**
 * Not found handler for undefined routes
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.url}`,
  });
}

export default {
  errorHandler,
  notFoundHandler,
};
