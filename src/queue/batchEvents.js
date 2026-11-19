import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

// Worker publishes a batch id here once its final result is stored, so API
// requests waiting on that batch (?wait=true) can answer immediately instead
// of the client polling.
const CHANNEL = 'codebox:batch-done';

export async function publishBatchDone(redis, batchId) {
  try {
    await redis.publish(CHANNEL, batchId);
  } catch (err) {
    logger.warn({ err: err.message, batchId }, 'Failed to publish batch completion');
  }
}

let subscriber = null;
let subscriberReady = null;
const waiters = new Map(); // batchId -> Set<() => void>

function ensureSubscriber() {
  if (subscriberReady) return subscriberReady;
  subscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => logger.error({ err: err.message }, 'Batch events Redis error'));
  subscriber.on('message', (channel, batchId) => {
    if (channel !== CHANNEL) return;
    const set = waiters.get(batchId);
    if (!set) return;
    waiters.delete(batchId);
    for (const wake of set) wake();
  });
  subscriberReady = subscriber.subscribe(CHANNEL).catch((err) => {
    logger.error({ err: err.message }, 'Batch events subscribe failed');
    subscriberReady = null;
    throw err;
  });
  return subscriberReady;
}

/**
 * Registers a waiter for batchId. Register BEFORE reading the batch state, then
 * re-read after `ready`: a completion published in between is never missed.
 * @returns {{ ready: Promise, done: Promise<void>, cancel: () => void }}
 */
export function watchBatch(batchId, timeoutMs) {
  let cancel;
  const done = new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => cancel(), Math.max(0, timeoutMs));
    cancel = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const set = waiters.get(batchId);
      if (set) {
        set.delete(cancel);
        if (set.size === 0) waiters.delete(batchId);
      }
      resolve();
    };
    if (!waiters.has(batchId)) waiters.set(batchId, new Set());
    waiters.get(batchId).add(cancel);
  });
  return { ready: ensureSubscriber(), done, cancel };
}

export async function closeBatchEvents() {
  if (subscriber) {
    await subscriber.quit().catch(() => {});
    subscriber = null;
    subscriberReady = null;
  }
}

export default { publishBatchDone, watchBatch, closeBatchEvents };
