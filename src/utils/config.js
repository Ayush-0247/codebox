const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    bodyLimit: process.env.BODY_LIMIT || '5mb',
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
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
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

export default config;
