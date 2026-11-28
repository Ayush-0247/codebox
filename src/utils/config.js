// TRUST_PROXY: hop count, "true"/"false", or an Express trust-proxy string.
// Behind the bundled Caddy it must be 1; with no proxy (local compose) false.
// Never "true" in production: every client could choose its own IP.
function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

// Integer setting within [min, max]; unset or invalid values use the default
// (0 is a valid value, unlike `parseInt(x) || default`).
function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    bodyLimit: process.env.BODY_LIMIT || '5mb',
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    // Browser access is never needed (server-to-server API): CORS is off
    // unless origins are listed explicitly (comma-separated).
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Host header allow-list (DNS-rebinding protection for a loopback API
    // whose token is public, FV-2). Empty: any host.
    allowedHosts: (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  auth: {
    tokens: (process.env.AUTH_TOKEN || '').split(' ').filter(Boolean),
    headers: (process.env.AUTH_HEADERS || 'X-Auth-Token x-rapidapi-key').split(' ').filter(Boolean),
  },

  execution: {
    defaultCpuTimeLimit: parseInt(process.env.DEFAULT_CPU_TIME_LIMIT) || 5,
    maxCpuTimeLimit: parseInt(process.env.MAX_CPU_TIME_LIMIT) || 15,
    defaultWallTimeLimit: parseInt(process.env.DEFAULT_WALL_TIME_LIMIT) || 10,
    maxWallTimeLimit: parseInt(process.env.MAX_WALL_TIME_LIMIT) || 30,
    defaultMemoryLimit: parseInt(process.env.DEFAULT_MEMORY_LIMIT) || 128000,
    maxMemoryLimit: parseInt(process.env.MAX_MEMORY_LIMIT) || 512000,
    maxProcesses: parseInt(process.env.MAX_PROCESSES) || 60,
    maxSourceSize: parseInt(process.env.MAX_SOURCE_SIZE) || 65536,
    maxAdditionalFilesSize: parseInt(process.env.MAX_ADDITIONAL_FILES_SIZE) || 2097152, // 2MB base64
    defaultStackLimit: parseInt(process.env.DEFAULT_STACK_LIMIT) || 64000,
    compileCpuTimeLimit: parseInt(process.env.COMPILE_CPU_TIME_LIMIT) || 15,
    compileWallTimeLimit: parseInt(process.env.COMPILE_WALL_TIME_LIMIT) || 30,
  },

  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 4,
    warmup: (process.env.WORKER_WARMUP || 'true').toLowerCase() !== 'false',
  },

  cache: {
    resultTtl: parseInt(process.env.RESULT_CACHE_TTL) || 3600,
  },

  // BullMQ keeps a copy of every finished job - including its source code and
  // stdin - for inspection. Results are served from the submission:/batch:
  // keys, never from these copies, so they are kept only briefly; otherwise
  // large submissions stay in Redis (256 MB, noeviction) until 100 newer jobs
  // push them out. Ages are in seconds.
  queue: {
    keepCompleted: {
      age: parseInt(process.env.QUEUE_KEEP_COMPLETED_AGE) || 600,
      count: parseInt(process.env.QUEUE_KEEP_COMPLETED_COUNT) || 100,
    },
    keepFailed: {
      age: parseInt(process.env.QUEUE_KEEP_FAILED_AGE) || 86400,
      count: parseInt(process.env.QUEUE_KEEP_FAILED_COUNT) || 100,
    },
  },

  // Compiled-build cache: identical code (Run -> Submit, retries, batches) skips the compiler.
  buildCache: {
    enabled: (process.env.BUILD_CACHE_ENABLED || 'true').toLowerCase() !== 'false',
    dir: process.env.BUILD_CACHE_DIR || '/var/cache/codebox/builds',
    maxBytes: (parseInt(process.env.BUILD_CACHE_MAX_MB) || 512) * 1024 * 1024,
    maxEntries: parseInt(process.env.BUILD_CACHE_MAX_ENTRIES) || 2000,
  },

  // Batch execution: compile once, run many testcases.
  batch: {
    maxTestcases: parseInt(process.env.BATCH_MAX_TESTCASES) || 200,
    // Sandboxes used in parallel per batch; match the worker's CPU count.
    parallelism: parseInt(process.env.BATCH_PARALLELISM) || 2,
    // Longest time a ?wait=true request is held open before answering with
    // the current (unfinished) state; clients then simply ask again.
    maxWaitMs: parseInt(process.env.BATCH_MAX_WAIT_MS) || 25000,
    // Longest a single batch may keep running testcases (round 2); later
    // testcases come back skipped. Bounds one job's hold on a worker.
    maxDurationMs: intEnv('BATCH_MAX_DURATION_MS', 120000, 1000, 3600000),
  },

  // Per-tenant fairness (round 2, SA-H2). A tenant is one end user of a
  // client (the backend sends an opaque id in X-Codebox-Tenant); requests
  // without it count as their authenticated client. Shared by every API and
  // backend instance because it lives in Redis.
  tenants: {
    // Jobs a tenant may have queued or running at once (429 TENANT_BUSY).
    maxActiveJobs: intEnv('TENANT_MAX_ACTIVE_JOBS', 3, 1, 1000),
    // Sandbox time (ms, max of CPU and wall per testcase, at least the job's
    // elapsed time) a tenant may use per window; 0 disables the budget.
    budgetMs: intEnv('TENANT_BUDGET_MS', 1800000, 0, 86400000),
    windowMs: intEnv('TENANT_WINDOW_MS', 3600000, 60000, 86400000),
    // Queue priority drops one level per this much sandbox time used in the
    // current window, so light users are served before heavy ones.
    // (2 s: any real usage already ranks a tenant behind a newcomer).
    priorityStepMs: intEnv('TENANT_PRIORITY_STEP_MS', 2000, 100, 3600000),
    // A job that never reports back (worker crash) frees its place after this.
    activeTtlMs: intEnv('TENANT_ACTIVE_TTL_MS', 600000, 60000, 86400000),
    // Requests without X-Codebox-Tenant: one tenant per client token.
    untaggedMaxActiveJobs: intEnv('TENANT_UNTAGGED_MAX_ACTIVE_JOBS', 1000, 1, 100000),
    // Redis must answer admission within this; otherwise 503 (fail closed).
    redisTimeoutMs: intEnv('TENANT_REDIS_TIMEOUT_MS', 2000, 100, 30000),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    // Per authenticated client (token), not shared with anyone else.
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    // Per client IP for requests without a valid token (health checks,
    // probes, scanners). Kept apart from the authenticated budget (SA-H4).
    unauthenticatedMaxRequests: parseInt(process.env.RATE_LIMIT_UNAUTHENTICATED_MAX) || 60,
  },

  // Program output kept per run (characters); longer output is truncated
  // with a "[truncated]" marker. Every byte stays in Redis until the result
  // expires or is deleted, so keep this small.
  output: {
    maxChars: parseInt(process.env.MAX_OUTPUT_CHARS) || 65536,
  },

  docker: {
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    containerTimeout: parseInt(process.env.CONTAINER_TIMEOUT) || 30000,
  },

  executor: {
    // 'auto' | 'isolate' | 'firecracker' | 'docker'
    // auto: prefers isolate > firecracker > docker
    type: process.env.EXECUTOR_TYPE || 'auto',
  },

  firecracker: {
    baseDir: process.env.FC_BASE_DIR || '/var/lib/codebox/firecracker',
    kernelPath: process.env.FC_KERNEL_PATH || '/var/lib/codebox/firecracker/kernels/vmlinux',
  },
};

/**
 * Startup checks of security settings. Returns error strings (never token
 * values). In production the API refuses to start when any is returned.
 */
export function validateSecurityConfig(cfg = config, env = process.env) {
  const problems = [];
  const production = cfg.server.nodeEnv === 'production';
  if (production) {
    if (cfg.auth.tokens.length === 0) problems.push('AUTH_TOKEN must be set in production (an empty token disables authentication).');
    if (cfg.auth.tokens.some((t) => t.length < 32)) problems.push('Every AUTH_TOKEN must be at least 32 characters in production.');
    if (cfg.server.trustProxy === true) problems.push('TRUST_PROXY=true lets any client choose its own IP; use the number of proxies (1 behind Caddy).');
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification.');
  }
  return problems;
}

export default config;
