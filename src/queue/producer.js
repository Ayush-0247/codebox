import { Queue } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

// Redis connection
let redis = null;
let submissionQueue = null;

/**
 * Initialize Redis and BullMQ queue
 */
export async function initializeQueue() {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis');
  });

  submissionQueue = new Queue('submissions', {
    connection: redis,
    defaultJobOptions: defaultJobOptions(),
  });

  logger.info('BullMQ queue initialized');
  return submissionQueue;
}

/** Options every queued job gets. */
export function defaultJobOptions() {
  return {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    // Job-level options win over the worker's (BullMQ), so both use the same values.
    ...jobRetentionOptions(),
  };
}

/** How long BullMQ keeps finished jobs (see config.queue). */
export function jobRetentionOptions(queueConfig = config.queue) {
  return {
    removeOnComplete: { ...queueConfig.keepCompleted },
    removeOnFail: { ...queueConfig.keepFailed },
  };
}

/** Parses the text of a Redis INFO reply into { key: number | string }. */
export function parseRedisInfo(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const value = line.slice(i + 1).trim();
    out[line.slice(0, i)] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

/** Redis memory usage and limit (bytes and human-readable), or null without a connection. */
export async function getRedisMemory(client = redis) {
  if (!client) return null;
  const info = parseRedisInfo(await client.info('memory'));
  return {
    used_memory_bytes: info.used_memory ?? null,
    used_memory_peak_bytes: info.used_memory_peak ?? null,
    maxmemory_bytes: info.maxmemory ?? null,
    used_memory_human: info.used_memory_human ?? null,
    maxmemory_human: info.maxmemory_human ?? null,
    maxmemory_policy: info.maxmemory_policy ?? null,
  };
}

/**
 * Get Redis connection
 */
export function getRedis() {
  return redis;
}

/**
 * Get submission queue
 */
export function getQueue() {
  return submissionQueue;
}

/**
 * Add submission to queue and cache
 */
export async function addSubmission(submission) {
  if (!redis || !submissionQueue) {
    throw new Error('Queue not initialized');
  }

  // Store initial submission state in Redis
  await redis.setex(
    `submission:${submission.token}`,
    config.cache.resultTtl,
    JSON.stringify(submission)
  );

  // Add job to queue
  await submissionQueue.add('execute', submission, {
    jobId: submission.token,
  });

  logger.debug({
    event: 'submission_queued',
    token: submission.token,
  });

  return submission;
}

/**
 * Add a batch (one program, many testcases) to the queue.
 * The stored record omits source/stdin to keep polling responses small.
 */
export async function addBatch(batch) {
  if (!redis || !submissionQueue) {
    throw new Error('Queue not initialized');
  }

  await redis.setex(
    `batch:${batch.batchId}`,
    config.cache.resultTtl,
    JSON.stringify({
      batchId: batch.batchId,
      status: 'queued',
      language_id: batch.language_id,
      testcaseCount: batch.testcases.length,
      created_at: batch.created_at,
      finished_at: null,
      results: [],
    })
  );

  await submissionQueue.add('batch', batch, { jobId: `batch-${batch.batchId}` });

  logger.debug({ event: 'batch_queued', batchId: batch.batchId, testcases: batch.testcases.length });
  return batch;
}

/**
 * Get batch state from cache
 */
export async function getBatch(batchId) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }
  const data = await redis.get(`batch:${batchId}`);
  return data ? JSON.parse(data) : null;
}

/**
 * Get submission from cache
 */
export async function getSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const data = await redis.get(`submission:${token}`);
  if (!data) return null;

  return JSON.parse(data);
}

/**
 * Update submission in cache
 */
export async function updateSubmission(token, updates) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const existing = await getSubmission(token);
  if (!existing) return null;

  const updated = { ...existing, ...updates };

  await redis.setex(
    `submission:${token}`,
    config.cache.resultTtl,
    JSON.stringify(updated)
  );

  return updated;
}

/**
 * Delete submission from cache
 */
export async function deleteSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const exists = await redis.exists(`submission:${token}`);
  if (!exists) return false;

  await redis.del(`submission:${token}`);
  return true;
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  if (!submissionQueue) {
    return { submissions: { total: 0, in_queue: 0, processing: 0, completed: 0 } };
  }

  const [waiting, active, completed, failed] = await Promise.all([
    submissionQueue.getWaitingCount(),
    submissionQueue.getActiveCount(),
    submissionQueue.getCompletedCount(),
    submissionQueue.getFailedCount(),
  ]);

  return {
    submissions: {
      total: waiting + active + completed + failed,
      in_queue: waiting,
      processing: active,
      completed: completed,
      failed: failed,
    },
  };
}

/**
 * Get worker statistics
 */
export async function getWorkerStats() {
  if (!submissionQueue) {
    return [];
  }

  const workers = await submissionQueue.getWorkers();
  return workers.map(w => ({
    id: w.id,
    name: w.name,
    active: true,
  }));
}

/**
 * Close Redis connection
 */
export async function closeQueue() {
  if (submissionQueue) {
    await submissionQueue.close();
  }
  if (redis) {
    await redis.quit();
  }
  logger.info('Queue connections closed');
}

export default {
  initializeQueue,
  getRedis,
  getQueue,
  addSubmission,
  addBatch,
  getBatch,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  getQueueStats,
  getWorkerStats,
  closeQueue,
};
