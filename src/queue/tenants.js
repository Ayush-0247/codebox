import config from '../utils/config.js';

// Per-tenant fairness and quotas (round 2, SA-H2).
//
// Every job belongs to a tenant: the end user a client runs it for (opaque id
// in X-Codebox-Tenant, chosen by the client) or, without that header, the
// authenticated client itself. State lives in Redis, so the limits hold for
// every API instance and for every backend instance that shares this CodeBox:
//   - at most tenants.maxActiveJobs queued or running jobs per tenant
//     (429 TENANT_BUSY);
//   - at most tenants.budgetMs of sandbox time per tenant per window
//     (429 TENANT_BUDGET_EXHAUSTED);
//   - queue priority falls with the sandbox time used in the current window,
//     so a tenant that has used little is served before heavy users (BullMQ
//     priority: lower number = served first).
// Redis errors are not swallowed: without Redis nothing can be queued anyway,
// and the API answers 503 instead of admitting work it cannot account for.

const TENANT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PRIORITY = 2_000_000; // BullMQ allows up to 2^21

export class TenantLimitError extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Tenant key for a request: "t:<header>" or "c:<client id>". Throws 400 on a malformed header. */
export function tenantFromRequest(req) {
  const header = req.get?.('x-codebox-tenant');
  if (header !== undefined && header !== '') {
    if (!TENANT_ID.test(header)) {
      throw new TenantLimitError(400, 'INVALID_TENANT', 'X-Codebox-Tenant must be 1-64 characters [A-Za-z0-9_.:-].');
    }
    return `t:${header}`;
  }
  return `c:${req.clientId || 'anonymous'}`;
}

const windowIndex = (now, cfg) => Math.floor(now / cfg.windowMs);
const activeKey = (tenant) => `tenant:${tenant}:active`;
const costKey = (tenant, now, cfg) => `tenant:${tenant}:cost:${windowIndex(now, cfg)}`;

// KEYS: active zset, cost counter.
// ARGV: now, jobId, expiresAt, maxActive, budgetMs, keyTtlMs, reserve (1/0)
const ADMIT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local active = redis.call('ZCARD', KEYS[1])
local cost = tonumber(redis.call('GET', KEYS[2]) or '0')
local budget = tonumber(ARGV[5])
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then return {1, cost, active} end
if budget > 0 and cost >= budget then return {-2, cost, active} end
if ARGV[7] ~= '1' then return {1, cost, active} end
if active >= tonumber(ARGV[4]) then return {-1, cost, active} end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
return {1, cost, active}
`;

// KEYS: active zset, cost counter. ARGV: jobId, costMs, costTtlMs, release (1/0)
const SETTLE = `
if ARGV[4] == '1' then redis.call('ZREM', KEYS[1], ARGV[1]) end
local cost = tonumber(ARGV[2])
if cost > 0 then
  redis.call('INCRBY', KEYS[2], cost)
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
return 1
`;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** BullMQ priority for a tenant that has used `costMs` this window and has `active` jobs. */
export function priorityFor(costMs, active, cfg = config.tenants) {
  const level = Math.floor(Math.max(0, costMs) / cfg.priorityStepMs) + Math.max(0, active);
  return Math.min(MAX_PRIORITY, 1 + level);
}

/**
 * Reserves a place for `jobId` before it is queued (reserve: false only
 * checks the budget and computes the priority). Returns { priority }.
 * Throws TenantLimitError (429) when the tenant is busy or out of budget.
 */
export async function admitTenantJob(redis, tenant, jobId, { now = Date.now(), cfg = config.tenants, reserve = true } = {}) {
  // Requests without X-Codebox-Tenant (older clients, internal jobs) are one
  // tenant per client token: a high cap and no budget, so they keep working,
  // but they still get a priority from their usage.
  const tagged = tenant.startsWith('t:');
  const maxActive = tagged ? cfg.maxActiveJobs : cfg.untaggedMaxActiveJobs;
  const budget = tagged ? cfg.budgetMs : 0;
  let reply;
  try {
    reply = await withTimeout(redis.eval(
      ADMIT, 2, activeKey(tenant), costKey(tenant, now, cfg),
      now, jobId, now + cfg.activeTtlMs, maxActive, budget, cfg.activeTtlMs, reserve ? '1' : '0',
    ), cfg.redisTimeoutMs);
  } catch {
    // Fail closed: work that cannot be accounted for is not admitted.
    throw new TenantLimitError(503, 'QUEUE_UNAVAILABLE', 'The execution queue is unavailable; try again shortly.', 5);
  }
  const [ok, cost, active] = reply;
  if (ok === -2) {
    const windowEnd = (windowIndex(now, cfg) + 1) * cfg.windowMs;
    throw new TenantLimitError(429, 'TENANT_BUDGET_EXHAUSTED',
      'Execution time budget for this user is used up; try again later.',
      Math.max(1, Math.ceil((windowEnd - now) / 1000)));
  }
  if (ok === -1) {
    throw new TenantLimitError(429, 'TENANT_BUSY',
      'This user already has the maximum number of jobs queued or running.', 2);
  }
  return { priority: priorityFor(Number(cost) || 0, Number(active) || 0, cfg) };
}

/**
 * Charges a job attempt's sandbox time to the tenant and, unless the job will
 * be retried (release: false), frees its place. Never throws.
 */
export async function settleTenantJob(redis, tenant, jobId, costMs, { now = Date.now(), cfg = config.tenants, logger, release = true } = {}) {
  if (!tenant) return;
  try {
    await redis.eval(SETTLE, 2, activeKey(tenant), costKey(tenant, now, cfg),
      jobId, Math.max(0, Math.round(Number(costMs) || 0)), cfg.windowMs * 2, release ? '1' : '0');
  } catch (err) {
    logger?.warn?.({ event: 'tenant_settle_failed', error: err.message });
  }
}

/** Releases a reservation whose job was never queued. Never throws. */
export async function releaseTenantJob(redis, tenant, jobId) {
  try {
    await redis.zrem(activeKey(tenant), jobId);
  } catch {
    // The reservation expires after tenants.activeTtlMs.
  }
}

/** Sandbox time of a finished job: per testcase max(CPU, wall), and at least the job's elapsed time. */
export function jobCostMs({ results = [], timeSec, wallSec, elapsedMs = 0 } = {}) {
  let sum = 0;
  for (const r of results) {
    sum += Math.max(Number(r?.timeMs) || 0, Number(r?.wallTimeMs) || 0);
  }
  if (timeSec != null || wallSec != null) {
    sum += Math.round(Math.max(parseFloat(timeSec) || 0, parseFloat(wallSec) || 0) * 1000);
  }
  return Math.max(sum, Math.round(Number(elapsedMs) || 0));
}
