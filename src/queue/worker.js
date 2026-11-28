import { Worker } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { executeCode, compareOutput } from './jobs/executeCode.js';
import { executeBatch } from './jobs/executeBatch.js';
import { publishBatchDone } from './batchEvents.js';
import { warmUpExecutor } from './warmup.js';
import { getStatusById } from '../languages/index.js';
import { jobRetentionOptions } from './producer.js';
import { settleTenantJob, releaseTenantJob, jobCostMs } from './tenants.js';
import { cleanupStaleBoxes } from '../executor/IsolateExecutor.js';

let redis = null;
let worker = null;

/**
 * Update submission result in Redis
 */
async function updateSubmissionResult(token, result) {
  await redis.setex(
    `submission:${token}`,
    config.cache.resultTtl,
    JSON.stringify(result)
  );
}

/**
 * Send callback to URL if configured
 */
async function sendCallback(callbackUrl, submission) {
  if (!callbackUrl) return;

  try {
    const response = await fetch(callbackUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
    });

    logger.info({
      event: 'callback_sent',
      token: submission.token,
      url: callbackUrl,
      status: response.status,
    });
  } catch (error) {
    logger.error({
      event: 'callback_failed',
      token: submission.token,
      url: callbackUrl,
      error: error.message,
    });
  }
}

/**
 * Process a batch job (one program, many testcases)
 */
async function processBatchJob(job) {
  const batch = job.data;
  const key = `batch:${batch.batchId}`;
  const base = {
    batchId: batch.batchId,
    language_id: batch.language_id,
    testcaseCount: batch.testcases.length,
    created_at: batch.created_at,
  };

  await redis.setex(key, config.cache.resultTtl, JSON.stringify({
    ...base, status: 'processing', finished_at: null, results: [],
  }));

  const outcome = await executeBatch(batch);

  await redis.setex(key, config.cache.resultTtl, JSON.stringify({
    ...base,
    ...outcome,
    finished_at: new Date().toISOString(),
  }));
  await publishBatchDone(redis, batch.batchId);

  // Per-case timings let the tenant be charged for the sandbox time used.
  return { status: outcome.status, results: (outcome.results || []).map((r) => ({ timeMs: r.timeMs, wallTimeMs: r.wallTimeMs })) };
}

/**
 * Process a queue job
 */
async function processJob(job) {
  // Charge the tenant for the sandbox time this attempt used (round 2,
  // SA-H2), whatever the outcome. The tenant's place is freed when the job is
  // done for good: success here, final failure in the 'failed' handler.
  const started = Date.now();
  let outcome = null;
  try {
    outcome = await runJob(job);
    return outcome;
  } finally {
    const tenant = job.data?.tenant;
    if (tenant) {
      const cost = jobCostMs({
        results: outcome?.results,
        timeSec: outcome?.time,
        wallSec: outcome?.wall_time,
        elapsedMs: Date.now() - started,
      });
      await settleTenantJob(redis, tenant, job.id, cost, { release: outcome !== null, logger });
    }
  }
}

async function runJob(job) {
  if (job.name === 'batch') return processBatchJob(job);

  const submission = job.data;
  const token = submission.token;

  logger.info({
    event: 'job_started',
    token,
    jobId: job.id,
  });

  // Update status to Processing
  await updateSubmissionResult(token, {
    ...submission,
    status: getStatusById(2), // Processing
  });

  // Execute the code
  let result = await executeCode(submission);

  // Check expected output if provided
  if (submission.expected_output && result.status.id === 3) {
    const matches = compareOutput(result.stdout, submission.expected_output);
    if (matches === false) {
      result.status = getStatusById(4); // Wrong Answer
    }
  }

  // Store final result
  await updateSubmissionResult(token, result);

  // Send callback if configured
  if (submission.callback_url) {
    await sendCallback(submission.callback_url, result);
  }

  logger.info({
    event: 'job_completed',
    token,
    jobId: job.id,
    status: result.status.id,
  });

  return result;
}

/**
 * Start the worker
 */
export async function startWorker() {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Worker Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Worker connected to Redis');
  });

  // A previous worker may have died mid-job: remove its boxes (and anything
  // still running in them) before taking new work.
  if (config.executor.type === 'isolate') await cleanupStaleBoxes();

  worker = new Worker('submissions', processJob, {
    connection: redis,
    concurrency: config.worker.concurrency,
    // Fallback for jobs created without retention options (same values).
    ...jobRetentionOptions(),
  });

  worker.on('completed', (job, result) => {
    logger.debug({
      event: 'worker_job_completed',
      jobId: job.id,
      token: job.data.token,
    });
  });

  worker.on('failed', (job, err) => {
    // Out of attempts: the job will not run again, so its tenant place is freed.
    if (job?.data?.tenant && job.attemptsMade >= (job.opts?.attempts || 1)) {
      releaseTenantJob(redis, job.data.tenant, job.id);
    }
    logger.error({
      event: 'worker_job_failed',
      jobId: job?.id,
      token: job?.data?.token,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  logger.info({
    event: 'worker_started',
    concurrency: config.worker.concurrency,
  });

  // Load compilers/runtimes (C++ precompiled header, javac class archive, ...)
  // into memory now, so the first real submission after a restart is not slow.
  if (config.worker.warmup) {
    warmUpExecutor().catch((err) => logger.warn({ err: err.message }, 'Warm-up failed'));
  }

  return worker;
}

/**
 * Stop the worker gracefully
 */
export async function stopWorker() {
  if (worker) {
    await worker.close();
    logger.info('Worker stopped');
  }
  if (redis) {
    await redis.quit();
  }
}

// Run as main script
if (process.argv[1].endsWith('worker.js')) {
  startWorker().catch((err) => {
    logger.error({ err }, 'Failed to start worker');
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await stopWorker();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await stopWorker();
    process.exit(0);
  });
}

export default {
  startWorker,
  stopWorker,
};
