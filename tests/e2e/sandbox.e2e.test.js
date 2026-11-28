// Adversarial end-to-end tests against a REAL CodeBox stack (isolate sandbox,
// Redis, worker). Skipped unless pointed at a disposable stack:
//
//   CODEBOX_E2E_URL=http://127.0.0.1:2399  CODEBOX_E2E_TOKEN=<token>
//   CODEBOX_E2E_WORKER=<worker container>   (process and box inspection)
//   CODEBOX_E2E_REDIS=<redis container>     (only with CODEBOX_E2E_DISRUPT=1)
//   CODEBOX_E2E_DISRUPT=1                   stops Redis and kills the worker
//
// Never point it at a stack other people use. Probe programs build sensitive
// names at run time (os.fork via getattr), like an attacker would, so the
// static source filter is not what is being tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const BASE = process.env.CODEBOX_E2E_URL;
const TOKEN = process.env.CODEBOX_E2E_TOKEN;
const WORKER = process.env.CODEBOX_E2E_WORKER;
const REDIS = process.env.CODEBOX_E2E_REDIS;
const DISRUPT = process.env.CODEBOX_E2E_DISRUPT === '1';
const enabled = Boolean(BASE && TOKEN && WORKER);
const e2e = enabled ? test : (name, fn) => test(name, { skip: 'set CODEBOX_E2E_URL, CODEBOX_E2E_TOKEN and CODEBOX_E2E_WORKER' }, fn);
const disruptive = enabled && DISRUPT && REDIS ? test : (name, fn) => test(name, { skip: 'set CODEBOX_E2E_DISRUPT=1 and CODEBOX_E2E_REDIS' }, fn);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = (tenant) => ({ 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json', ...(tenant ? { 'X-Codebox-Tenant': tenant } : {}) });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const tenantId = (label) => `e2e-${label}-${crypto.randomBytes(4).toString('hex')}`;

const PY = 71;
const PRELUDE = "import importlib, time, signal, sys\nos = importlib.import_module('o' + 's')\nfork = getattr(os, 'fo' + 'rk')\nsetsid = getattr(os, 'set' + 'sid')\n";
const IGNORE_SIGNALS = 'for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT):\n    signal.signal(s, signal.SIG_IGN)\n';

/** Processes running as an isolate box user (uids first_uid..first_uid+999) in the worker container. */
function boxProcesses() {
  const out = docker('exec', WORKER, 'ps', '-eo', 'uid=,pid=,args=');
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => { const uid = Number(l.split(/\s+/)[0]); return uid >= 60000 && uid < 61000; });
}
const boxDirs = () => docker('exec', WORKER, 'sh', '-c', 'ls /var/local/lib/isolate 2>/dev/null || true').split('\n').filter(Boolean);

async function waitForIdleSandbox(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let procs = boxProcesses();
  while (procs.length && Date.now() < until) {
    await sleep(250);
    procs = boxProcesses();
  }
  return procs;
}

async function runSubmission(source, { stdin = '', cpu = 2, wall = 4, tenant } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}/submissions?base64_encoded=false&wait=false`, {
    method: 'POST', headers: headers(tenant),
    body: JSON.stringify({ language_id: PY, source_code: source, stdin, cpu_time_limit: cpu, wall_time_limit: wall }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  for (;;) {
    const sub = await (await fetch(`${BASE}/submissions/${body.token}?base64_encoded=false`, { headers: headers() })).json();
    if (sub.status && ![1, 2].includes(sub.status.id)) return { ...sub, elapsedMs: Date.now() - started };
    if (Date.now() - started > 120000) throw new Error('submission never finished');
    await sleep(100);
  }
}

async function createBatch(source, stdins, { cpu = 1, wall = 2, tenant } = {}) {
  const res = await fetch(`${BASE}/batches`, {
    method: 'POST', headers: headers(tenant),
    body: JSON.stringify({ language_id: PY, source_code: source, testcases: stdins.map((stdin) => ({ stdin })), limits: { cpu_time_limit: cpu, wall_time_limit: wall } }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitBatch(batchId, timeoutMs = 180000) {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/batches?batchId=${batchId}&wait=10000`, { headers: headers() });
    const state = await res.json();
    if (['completed', 'compile_failed', 'failed'].includes(state.status)) {
      await fetch(`${BASE}/batches/${batchId}`, { method: 'DELETE', headers: headers() });
      return { ...state, finishedAt: Date.now() };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`batch ${batchId} never finished`);
  }
}

e2e('infinite CPU loop: Time Limit Exceeded, and no process survives', async () => {
  const r = await runSubmission('while True:\n    pass\n', { cpu: 1, wall: 3 });
  assert.match(r.status.description, /Time Limit/);
  assert.deepEqual(await waitForIdleSandbox(), []);
});

e2e('sleeping program is stopped at the wall-clock limit, not after its sleep', async () => {
  const r = await runSubmission('import time\ntime.sleep(60)\nprint("late")\n', { cpu: 1, wall: 2 });
  assert.match(r.status.description, /Time Limit/);
  assert.ok(r.elapsedMs < 10000, `took ${r.elapsedMs} ms`);
  assert.ok(Number(r.wall_time) <= 3, `wall_time ${r.wall_time}`);
  assert.deepEqual(await waitForIdleSandbox(), []);
});

e2e('forked children that outlive the main process are killed with it', async () => {
  const src = `${PRELUDE}for i in range(5):\n    if fork() == 0:\n        time.sleep(300)\n        os._exit(0)\nprint("parent done")\n`;
  const r = await runSubmission(src, { cpu: 1, wall: 3 });
  assert.equal(r.stdout?.trim(), 'parent done');
  assert.deepEqual(await waitForIdleSandbox(), [], 'no orphan may keep running after the job');
});

e2e('signal-ignoring, setsid, double-forked background children are killed', async () => {
  const src = `${PRELUDE}${IGNORE_SIGNALS}if fork() == 0:\n    setsid()\n    if fork() == 0:\n${IGNORE_SIGNALS.trimEnd().replace(/^/gm, '        ')}
        while True:\n            time.sleep(1)\n    os._exit(0)\nwhile True:\n    time.sleep(1)\n`;
  const r = await runSubmission(src, { cpu: 1, wall: 2 });
  assert.match(r.status.description, /Time Limit/, 'the main process itself ignores SIGTERM and is still stopped');
  assert.deepEqual(await waitForIdleSandbox(), [], 'daemonized grandchildren must not survive');
});

e2e('fork bomb is bounded by the process limit and fully cleaned up', async () => {
  const src = `${PRELUDE}n = 0\ntry:\n    for i in range(500):\n        if fork() == 0:\n            time.sleep(30)\n            os._exit(0)\n        n += 1\nexcept OSError:\n    pass\nprint(n)\n`;
  const r = await runSubmission(src, { cpu: 1, wall: 3 });
  assert.ok(Number(r.stdout) < 100, `forked ${r.stdout}`);
  assert.deepEqual(await waitForIdleSandbox(), []);
});

e2e('batch of sleeping testcases: every case is cut at the wall limit; nothing is left behind', async () => {
  const { status, body } = await createBatch('import time\ntime.sleep(60)\n', ['1', '2', '3', '4', '5', '6'], { cpu: 1, wall: 2, tenant: tenantId('sleepers') });
  assert.equal(status, 201);
  const started = Date.now();
  const state = await waitBatch(body.batchId);
  assert.equal(state.results.length, 6);
  for (const r of state.results) {
    assert.ok(r.wallTimeMs <= 3000, `case wall ${r.wallTimeMs} ms`);
    assert.notEqual(r.status, 'accepted');
  }
  assert.ok(Date.now() - started < 30000, `batch took ${Date.now() - started} ms`);
  assert.deepEqual(await waitForIdleSandbox(), []);
});

e2e('batch duration cap: no testcase starts after max_duration_ms; the rest come back skipped', async () => {
  const res = await fetch(`${BASE}/batches`, {
    method: 'POST', headers: headers(tenantId('capped')),
    body: JSON.stringify({ language_id: PY, source_code: 'import time\ntime.sleep(2)\nprint(1)\n', testcases: Array.from({ length: 8 }, () => ({ stdin: '' })), limits: { cpu_time_limit: 1, wall_time_limit: 3 }, max_duration_ms: 3000 }),
  });
  assert.equal(res.status, 201);
  const started = Date.now();
  const state = await waitBatch((await res.json()).batchId);
  const skipped = state.results.filter((r) => r.status === 'skipped');
  assert.ok(skipped.length >= 2, `${skipped.length} of 8 skipped`);
  assert.ok(skipped.every((r) => /duration cap/.test(r.message)));
  assert.ok(Date.now() - started < 12000, `batch took ${Date.now() - started} ms (uncapped: about 16 s)`);
  assert.deepEqual(await waitForIdleSandbox(), []);
});

e2e('per-tenant cap (Redis, shared by all API instances): a tenant cannot queue more than its share', async () => {
  const tenant = tenantId('cap');
  const src = 'import time\ntime.sleep(1)\nprint(1)\n';
  const created = await Promise.all([1, 2, 3, 4].map(() => createBatch(src, ['1'], { cpu: 1, wall: 3, tenant })));
  const statuses = created.map((c) => c.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 429], `statuses ${statuses}`);
  const refused = created.find((c) => c.status === 429);
  assert.equal(refused.body.code, 'TENANT_BUSY');
  const other = await createBatch(src, ['1'], { cpu: 1, wall: 3, tenant: tenantId('other') });
  assert.equal(other.status, 201, 'another tenant is not affected');
  await Promise.all([...created.filter((c) => c.status === 201), other].map((c) => waitBatch(c.body.batchId)));
  const again = await createBatch(src, ['1'], { cpu: 1, wall: 3, tenant });
  assert.equal(again.status, 201, 'finished jobs free the tenant\'s places');
  await waitBatch(again.body.batchId);
});

e2e('fair scheduling: a light tenant is served before heavy tenants\' queued work', async () => {
  const heavy = [tenantId('heavy1'), tenantId('heavy2')];
  const src = 'import time\ntime.sleep(1.5)\nprint(1)\n';
  // Each heavy tenant fills its 3 places with 2-case sleeping batches.
  const heavyJobs = [];
  for (const tenant of heavy) {
    for (let i = 0; i < 3; i++) {
      const c = await createBatch(src, ['1', '2'], { cpu: 1, wall: 3, tenant });
      assert.equal(c.status, 201);
      heavyJobs.push(c.body.batchId);
    }
  }
  await sleep(300);
  const light = await createBatch('print(1)\n', ['1'], { cpu: 1, wall: 3, tenant: tenantId('light') });
  assert.equal(light.status, 201);
  const [lightDone, ...heavyDone] = await Promise.all([waitBatch(light.body.batchId), ...heavyJobs.map((id) => waitBatch(id))]);
  const finishedAfterLight = heavyDone.filter((h) => h.finishedAt > lightDone.finishedAt).length;
  // Without priorities the light job would run after all 6 heavy batches.
  assert.ok(finishedAfterLight >= 3, `${finishedAfterLight} of 6 heavy batches finished after the light one`);
});

disruptive('Redis outage: new work is refused fast (503) instead of hanging, and service recovers', async () => {
  docker('stop', REDIS);
  try {
    const started = Date.now();
    const res = await fetch(`${BASE}/batches`, {
      method: 'POST', headers: headers(tenantId('redis')),
      body: JSON.stringify({ language_id: PY, source_code: 'print(1)\n', testcases: [{ stdin: '' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'QUEUE_UNAVAILABLE');
    assert.ok(Date.now() - started < 5000, `answered after ${Date.now() - started} ms`);
  } finally {
    docker('start', REDIS);
  }
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(1000);
    const c = await createBatch('print(1)\n', [''], { tenant: tenantId('recovered') }).catch(() => ({ status: 0 }));
    if (c.status === 201) { ok = true; await waitBatch(c.body.batchId); }
  }
  assert.ok(ok, 'CodeBox accepts work again once Redis is back');
});

disruptive('worker crash mid-job: restart cleans every box and process; the job still finishes', async () => {
  const { status, body } = await createBatch('import time\ntime.sleep(2)\nprint(1)\n', ['1', '2', '3', '4'], { cpu: 1, wall: 4, tenant: tenantId('crash') });
  assert.equal(status, 201);
  await sleep(1500);
  docker('kill', WORKER);
  docker('start', WORKER);
  const state = await waitBatch(body.batchId, 240000); // stalled job is picked up again
  assert.ok(['completed', 'failed'].includes(state.status), state.status);
  assert.deepEqual(await waitForIdleSandbox(30000), []);
  assert.deepEqual(boxDirs(), [], 'no box (with another user\'s files) is left on disk');
});
