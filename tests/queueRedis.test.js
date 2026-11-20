// Redis safety: queue retention settings and Redis memory reporting.
// No Redis server needed (clients are faked).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEYS = ['QUEUE_KEEP_COMPLETED_AGE', 'QUEUE_KEEP_COMPLETED_COUNT', 'QUEUE_KEEP_FAILED_AGE', 'QUEUE_KEEP_FAILED_COUNT'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
KEYS.forEach((k) => delete process.env[k]);

const { default: config } = await import('../src/utils/config.js');
const { defaultJobOptions, jobRetentionOptions, parseRedisInfo, getRedisMemory } = await import('../src/queue/producer.js');

test.after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('finished jobs are kept briefly by default (they hold source code and stdin)', () => {
  assert.deepEqual(config.queue.keepCompleted, { age: 600, count: 100 });
  assert.deepEqual(config.queue.keepFailed, { age: 86400, count: 100 });
  const opts = defaultJobOptions();
  assert.deepEqual(opts.removeOnComplete, { age: 600, count: 100 });
  assert.deepEqual(opts.removeOnFail, { age: 86400, count: 100 });
  assert.equal(opts.attempts, 3, 'retry behaviour unchanged');
  assert.deepEqual(opts.backoff, { type: 'exponential', delay: 1000 });
});

test('retention is configurable through the environment', async () => {
  process.env.QUEUE_KEEP_COMPLETED_AGE = '120';
  process.env.QUEUE_KEEP_COMPLETED_COUNT = '20';
  process.env.QUEUE_KEEP_FAILED_AGE = '3600';
  process.env.QUEUE_KEEP_FAILED_COUNT = '10';
  const { default: overridden } = await import('../src/utils/config.js?env-override');
  assert.deepEqual(jobRetentionOptions(overridden.queue), {
    removeOnComplete: { age: 120, count: 20 },
    removeOnFail: { age: 3600, count: 10 },
  });
  KEYS.forEach((k) => delete process.env[k]);
});

test('retention options are copies (a caller cannot mutate the config)', () => {
  const a = jobRetentionOptions();
  a.removeOnComplete.age = 1;
  assert.equal(config.queue.keepCompleted.age, 600);
});

test('worker uses the same retention as queued jobs', async () => {
  // BullMQ applies the job's own options first and the worker's only as a
  // fallback; both must agree so behaviour never depends on who created a job.
  const fs = await import('node:fs/promises');
  const workerSrc = await fs.readFile(new URL('../src/queue/worker.js', import.meta.url), 'utf8');
  assert.match(workerSrc, /\.\.\.jobRetentionOptions\(\)/);
  assert.doesNotMatch(workerSrc, /removeOnFail: \{ count: 1000 \}/);
});

const INFO_MEMORY = [
  '# Memory',
  'used_memory:94884864',
  'used_memory_human:90.49M',
  'used_memory_peak:274585600',
  'used_memory_peak_human:261.86M',
  'maxmemory:536870912',
  'maxmemory_human:512.00M',
  'maxmemory_policy:noeviction',
  'mem_fragmentation_ratio:1.10',
  '',
].join('\r\n');

test('parses a Redis INFO reply', () => {
  const info = parseRedisInfo(INFO_MEMORY);
  assert.equal(info.used_memory, 94884864);
  assert.equal(info.maxmemory_human, '512.00M');
  assert.equal(info.maxmemory_policy, 'noeviction');
  assert.equal(info.mem_fragmentation_ratio, 1.1);
  assert.equal(info['# Memory'], undefined, 'section headers are skipped');
  assert.deepEqual(parseRedisInfo(''), {});
});

test('reports Redis memory usage and limit', async () => {
  const calls = [];
  const fakeRedis = { info: async (section) => { calls.push(section); return INFO_MEMORY; } };
  const memory = await getRedisMemory(fakeRedis);
  assert.deepEqual(calls, ['memory']);
  assert.deepEqual(memory, {
    used_memory_bytes: 94884864,
    used_memory_peak_bytes: 274585600,
    maxmemory_bytes: 536870912,
    used_memory_human: '90.49M',
    maxmemory_human: '512.00M',
    maxmemory_policy: 'noeviction',
  });
  assert.equal(await getRedisMemory(null), null, 'no connection -> null');
});
