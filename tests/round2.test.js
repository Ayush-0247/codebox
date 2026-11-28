// Round-2 security fixes that need neither Redis nor a sandbox:
// N3 validation, IPv6 rate-limit keys, Host allow-list, tenant admission
// decisions (with a fake Redis), and how tenant errors are answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.LOG_LEVEL = 'silent';
process.env.AUTH_TOKEN = 'r'.repeat(40);
process.env.ALLOWED_HOSTS = 'localhost,[::1]';
process.env.TENANT_REDIS_TIMEOUT_MS = '200';

const { validateSubmission } = await import('../src/api/middleware/validation.js');
const { ipKey } = await import('../src/api/middleware/rateLimit.js');
const { default: app, hostAllowed } = await import('../src/api/server.js');
const tenants = await import('../src/queue/tenants.js');
const { errorHandler } = await import('../src/api/middleware/errorHandler.js');

const validate = (body) => new Promise((resolve) => {
  const res = { status(code) { this.code = code; return this; }, json() { resolve(this.code); } };
  validateSubmission({ body }, res, () => resolve('accepted'));
});

test('N3: a submission without a program is refused with 422', async () => {
  assert.equal(await validate({ language_id: 71 }), 422);
  assert.equal(await validate({ language_id: 71, source_code: '' }), 422);
  assert.equal(await validate({ language_id: 71, source_code: null }), 422);
  assert.equal(await validate({ language_id: 71, source_code: 'print(1)' }), 'accepted');
  assert.equal(await validate({ language_id: 89, additional_files: 'UEsDBA==' }), 'accepted', 'multi-file programs carry their files instead');
});

test('FV-8: IPv6 clients are limited per /64, IPv4 per address', () => {
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2::1'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.notEqual(ipKey('203.0.113.7'), ipKey('203.0.113.8'));
});

test('FV-2: only allow-listed Host headers are served (DNS rebinding)', async () => {
  assert.equal(hostAllowed('localhost:2358', ['localhost']), true);
  assert.equal(hostAllowed('LOCALHOST', ['localhost']), true);
  assert.equal(hostAllowed('[::1]:2358', ['[::1]']), true);
  assert.equal(hostAllowed('attacker.example:2358', ['localhost']), false);
  assert.equal(hostAllowed('anything', []), true, 'empty list: allow all');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const { port } = server.address();
    // fetch sends Host: 127.0.0.1:<port>, which is not on the list.
    const rebinding = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(rebinding.status, 421);
    // fetch cannot set Host; a plain request can.
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: `localhost:${port}` } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 200);
  } finally {
    server.close();
  }
});

test('tenant ids: header validated, otherwise the authenticated client', () => {
  const req = (header, clientId = 'token-0') => ({ clientId, get: (h) => (h === 'x-codebox-tenant' ? header : undefined) });
  assert.equal(tenants.tenantFromRequest(req('u_abc-123')), 't:u_abc-123');
  assert.equal(tenants.tenantFromRequest(req(undefined)), 'c:token-0');
  assert.throws(() => tenants.tenantFromRequest(req('bad tenant!')), (e) => e.status === 400 && e.code === 'INVALID_TENANT');
  assert.throws(() => tenants.tenantFromRequest(req('x'.repeat(65))), (e) => e.status === 400);
});

test('tenant priority falls with usage; job cost counts wall time and elapsed time', () => {
  const cfg = { priorityStepMs: 20000 };
  assert.equal(tenants.priorityFor(0, 0, cfg), 1);
  assert.ok(tenants.priorityFor(60000, 0, cfg) > tenants.priorityFor(10000, 0, cfg));
  assert.ok(tenants.priorityFor(0, 2, cfg) > tenants.priorityFor(0, 0, cfg), 'running jobs lower the priority too');
  // A sleeping program: 20 ms CPU but 3.5 s wall per case.
  assert.equal(tenants.jobCostMs({ results: [{ timeMs: 20, wallTimeMs: 3500 }, { timeMs: 20, wallTimeMs: 3500 }] }), 7000);
  assert.equal(tenants.jobCostMs({ results: [{ timeMs: 1, wallTimeMs: 1 }], elapsedMs: 900 }), 900, 'compile and overhead count via elapsed time');
  assert.equal(tenants.jobCostMs({ timeSec: '0.02', wallSec: '1.5' }), 1500);
});

const cfg = { maxActiveJobs: 2, untaggedMaxActiveJobs: 1000, budgetMs: 1000, windowMs: 60000, priorityStepMs: 20000, activeTtlMs: 60000, redisTimeoutMs: 200 };
const fakeRedis = (reply) => ({ eval: async (...args) => (typeof reply === 'function' ? reply(...args) : reply) });

test('tenant admission: busy and out-of-budget tenants get 429; tagged and untagged caps differ', async () => {
  await assert.rejects(tenants.admitTenantJob(fakeRedis([-1, 0, 2]), 't:u1', 'j1', { cfg }), (e) => e.status === 429 && e.code === 'TENANT_BUSY');
  await assert.rejects(tenants.admitTenantJob(fakeRedis([-2, 5000, 0]), 't:u1', 'j1', { cfg, now: 30000 }),
    (e) => e.status === 429 && e.code === 'TENANT_BUDGET_EXHAUSTED' && e.retryAfterSeconds === 30);
  const { priority } = await tenants.admitTenantJob(fakeRedis([1, 40000, 1]), 't:u1', 'j1', { cfg });
  assert.equal(priority, tenants.priorityFor(40000, 1, cfg));
  let argv;
  await tenants.admitTenantJob(fakeRedis((...a) => { argv = a; return [1, 0, 0]; }), 'c:token-0', 'j2', { cfg });
  // eval(script, numkeys, activeKey, costKey, now, jobId, expiresAt, maxActive, budget, ...)
  assert.equal(argv[7], 1000, 'untagged clients: high cap');
  assert.equal(argv[8], 0, 'untagged clients: no budget');
});

test('tenant admission fails closed when Redis errors or hangs (503, no admission)', async () => {
  await assert.rejects(tenants.admitTenantJob({ eval: async () => { throw new Error('ECONNREFUSED'); } }, 't:u1', 'j', { cfg }),
    (e) => e.status === 503 && e.code === 'QUEUE_UNAVAILABLE');
  const started = Date.now();
  await assert.rejects(tenants.admitTenantJob({ eval: () => new Promise(() => {}) }, 't:u1', 'j', { cfg }),
    (e) => e.status === 503 && e.code === 'QUEUE_UNAVAILABLE');
  assert.ok(Date.now() - started < 1500, 'a hanging Redis does not hang the request');
});

test('tenant errors are answered with their status and Retry-After', () => {
  const headers = {};
  let status = 0;
  let body = null;
  const res = { set: (k, v) => { headers[k] = v; return res; }, status: (c) => { status = c; return res; }, json: (b) => { body = b; return res; } };
  errorHandler(new tenants.TenantLimitError(429, 'TENANT_BUSY', 'busy', 2), { method: 'POST', path: '/batches', get: () => undefined }, res, () => {});
  assert.equal(status, 429);
  assert.equal(body.code, 'TENANT_BUSY');
  assert.equal(headers['Retry-After'], '2');
});

test('batch duration cap: max_duration_ms is validated (500 ms to 1 h) and optional', async () => {
  const { validateBatchExecution } = await import('../src/api/middleware/validation.js');
  const check = (extra) => new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, json() { resolve(this.code); } };
    validateBatchExecution({ body: { language_id: 71, source_code: 'print(1)', testcases: [{ stdin: '' }], ...extra } }, res, () => resolve('accepted'));
  });
  assert.equal(await check({}), 'accepted', 'optional (the server cap still applies)');
  assert.equal(await check({ max_duration_ms: 8000 }), 'accepted');
  assert.equal(await check({ max_duration_ms: 100 }), 422);
  assert.equal(await check({ max_duration_ms: 'soon' }), 422);
});
