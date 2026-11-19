// Unit tests for the build cache and batch execution flow.
// isolate itself is stubbed, so these run anywhere (no Docker/Linux needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebox-test-'));
process.env.BUILD_CACHE_DIR = path.join(tmpRoot, 'cache');
process.env.LOG_LEVEL = 'silent';

const { default: IsolateExecutor } = await import('../src/executor/IsolateExecutor.js');
const { BuildCache } = await import('../src/executor/BuildCache.js');
const { judge0StatusToBatchStatus, executeBatchPerTestcase } = await import('../src/queue/jobs/executeBatch.js');
const { resolveBatchLimits } = await import('../src/api/routes/batches.js');
const { getLanguageById } = await import('../src/languages/index.js');

const cpp = getLanguageById(54);
const python = getLanguageById(71);

/**
 * Executor with isolate stubbed out: boxes are temp dirs, "compiling" writes a
 * `main` file, "running" echoes stdin (or fails for special inputs).
 */
async function makeExecutor() {
  const ex = new IsolateExecutor();
  ex.calls = { compile: 0, run: 0 };
  ex.initBox = async (boxId) => {
    const dir = path.join(tmpRoot, `box-${boxId}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(dir, 'box'), { recursive: true });
    return dir;
  };
  ex.cleanupBox = async () => {};
  ex.runIsolate = async (boxId, workDir, opts) => {
    const base = { stdout: '', stderr: '', time: 0.004, wallTime: 0.006, memory: 3000, exitCode: 0, exitSignal: null, isoStatus: null, message: null, oomKilled: false };
    if (opts.cmd.startsWith('g++')) {
      ex.calls.compile++;
      await new Promise((r) => setTimeout(r, 20));
      const src = await fs.readFile(path.join(workDir, 'main.cpp'), 'utf-8');
      if (src.includes('SYNTAX_ERROR')) return { ...base, exitCode: 1, isoStatus: 'RE', stderr: 'main.cpp:1: error: expected ;' };
      await fs.writeFile(path.join(workDir, 'main'), `binary-of:${src}`, { mode: 0o755 });
      return base;
    }
    ex.calls.run++;
    const files = (await fs.readdir(workDir)).sort();
    const stdin = await fs.readFile(path.join(workDir, '_stdin.txt'), 'utf-8');
    // Leave junk behind to prove each testcase starts from a clean box.
    await fs.writeFile(path.join(workDir, `junk-${ex.calls.run}.txt`), 'x');
    if (stdin === 'crash') return { ...base, isoStatus: 'SG', exitSignal: 11, exitCode: 0 };
    if (stdin === 'loop') return { ...base, isoStatus: 'TO', time: 2.0 };
    if (stdin === 'oom') return { ...base, isoStatus: 'SG', exitSignal: 9, oomKilled: true };
    return { ...base, stdout: `${stdin}|${files.join(',')}` };
  };
  return ex;
}

const sub = (source, extra = {}) => ({
  token: 't', language: cpp, language_id: 54, source_code: source,
  memory_limit: 256000, max_processes_and_or_threads: 60, ...extra,
});

test('build cache: identical code compiles once, then restores from cache', async () => {
  const ex = await makeExecutor();
  const boxA = await ex.initBox(1);
  const first = await ex.ensureBuild(1, path.join(boxA, 'box'), sub('int main(){}'), { sourceReady: false });
  assert.equal(first.ok, true);
  assert.equal(ex.calls.compile, 1);

  const boxB = await ex.initBox(2);
  const second = await ex.ensureBuild(2, path.join(boxB, 'box'), sub('int main(){}'), { sourceReady: false });
  assert.equal(second.ok, true);
  assert.equal(ex.calls.compile, 1, 'cache hit must not compile again');
  assert.equal(await fs.readFile(path.join(boxB, 'box', 'main'), 'utf-8'), 'binary-of:int main(){}');

  await ex.ensureBuild(3, path.join(await ex.initBox(3), 'box'), sub('int main(){return 1;}'), { sourceReady: false });
  assert.equal(ex.calls.compile, 2, 'different source compiles');
  await ex.ensureBuild(4, path.join(await ex.initBox(4), 'box'), sub('int main(){}', { compiler_options: '-O0' }), { sourceReady: false });
  assert.equal(ex.calls.compile, 3, 'different compiler options compile');
});

test('build cache: compile errors are cached too', async () => {
  const ex = await makeExecutor();
  const r1 = await ex.ensureBuild(1, path.join(await ex.initBox(1), 'box'), sub('SYNTAX_ERROR'), { sourceReady: false });
  const r2 = await ex.ensureBuild(2, path.join(await ex.initBox(2), 'box'), sub('SYNTAX_ERROR'), { sourceReady: false });
  assert.equal(r1.ok, false);
  assert.equal(r1.result.status.id, 6);
  assert.match(r2.result.compile_output, /expected ;/);
  assert.equal(ex.calls.compile, 1);
});

test('build cache: concurrent identical compiles run only once', async () => {
  const ex = await makeExecutor();
  const boxes = await Promise.all([1, 2, 3, 4].map((i) => ex.initBox(i)));
  const results = await Promise.all(boxes.map((b, i) =>
    ex.ensureBuild(i, path.join(b, 'box'), sub('int main(){/*same*/}'), { sourceReady: false })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(ex.calls.compile, 1);
  for (const b of boxes) {
    assert.equal(await fs.readFile(path.join(b, 'box', 'main'), 'utf-8'), 'binary-of:int main(){/*same*/}');
  }
});

test('build cache: LRU eviction respects size limit', async () => {
  const cache = new BuildCache({ dir: path.join(tmpRoot, 'lru'), maxBytes: 25, maxEntries: 100 });
  const src = path.join(tmpRoot, 'lru-src');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'main'), '0123456789'); // 10 bytes
  await cache.putSuccess('a', src);
  await cache.putSuccess('b', src);
  cache.get('a'); // a is now most recently used
  await cache.putSuccess('c', src);
  assert.equal(cache.get('b'), null, 'least recently used entry evicted');
  assert.ok(cache.get('a')?.ok);
  assert.ok(cache.get('c')?.ok);
  assert.ok(cache.stats().bytes <= 25);
});

test('batch: compiles once, runs every testcase in a clean box, maps verdicts', async () => {
  const ex = await makeExecutor();
  const out = await ex.executeBatch({
    batchId: 'b1', language: cpp, language_id: 54, source_code: 'int main(){/*batch*/}',
    memory_limit: 256000, max_processes_and_or_threads: 60,
    limits: { cpu_time_limit: 1, wall_time_limit: 2, memory_limit: 256000, max_processes_and_or_threads: 60 },
    testcases: [{ stdin: '1 2' }, { stdin: 'crash' }, { stdin: 'loop' }, { stdin: 'oom' }, { stdin: '3 4' }],
  });
  assert.equal(out.status, 'completed');
  assert.equal(ex.calls.compile, 1, 'one compile for 5 testcases');
  assert.equal(ex.calls.run, 5);
  assert.deepEqual(out.results.map((r) => r.status), [
    'completed', 'runtime_error', 'time_limit_exceeded', 'memory_limit_exceeded', 'completed',
  ]);
  // Each run sees only the build output + its stdin, never junk from earlier runs.
  assert.equal(out.results[0].stdout, '1 2|_stdin.txt,main,main.cpp');
  assert.equal(out.results[4].stdout, '3 4|_stdin.txt,main,main.cpp');
  assert.equal(out.results[0].timeMs, 4);
  assert.equal(out.results[2].timeMs, 2000);
  assert.deepEqual(out.results.map((r) => r.index), [0, 1, 2, 3, 4]);
});

test('batch: compile error reported once for the whole batch', async () => {
  const ex = await makeExecutor();
  const out = await ex.executeBatch({
    batchId: 'b2', language: cpp, language_id: 54, source_code: 'SYNTAX_ERROR',
    memory_limit: 256000, max_processes_and_or_threads: 60,
    limits: { cpu_time_limit: 1, wall_time_limit: 2, memory_limit: 256000, max_processes_and_or_threads: 60 },
    testcases: [{ stdin: '1' }, { stdin: '2' }],
  });
  assert.equal(out.status, 'compile_failed');
  assert.match(out.compileError, /expected ;/);
  assert.equal(ex.calls.run, 0);
});

test('batch: interpreted language (no compile step) works', async () => {
  const ex = await makeExecutor();
  const out = await ex.executeBatch({
    batchId: 'b3', language: python, language_id: 71, source_code: 'print(input())',
    limits: { cpu_time_limit: 1, wall_time_limit: 2, memory_limit: 256000, max_processes_and_or_threads: 60 },
    testcases: [{ stdin: 'a' }, { stdin: 'b' }],
  });
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.results.map((r) => r.stdout), ['a|_stdin.txt,main.py', 'b|_stdin.txt,main.py']);
});

test('batch: single-submission path still works and reuses the cache', async () => {
  const ex = await makeExecutor();
  const r1 = await ex.execute({ ...sub('int main(){/*single*/}'), stdin: '7', cpu_time_limit: 1, wall_time_limit: 2 });
  const r2 = await ex.execute({ ...sub('int main(){/*single*/}'), stdin: '8', cpu_time_limit: 1, wall_time_limit: 2 });
  assert.equal(r1.status.id, 3);
  assert.equal(r1.stdout, '7|_stdin.txt,main,main.cpp');
  assert.equal(r2.stdout, '8|_stdin.txt,main,main.cpp');
  assert.equal(ex.calls.compile, 1);
});

test('generic per-testcase batch fallback maps Judge0 results', async () => {
  const fake = {
    async execute(s) {
      if (s.stdin === 'tle') return { status: { id: 5 }, time: '1.000', stdout: null };
      return { status: { id: 3 }, time: '0.010', wall_time: '0.020', memory: 1000, stdout: `${s.stdin}\n` };
    },
  };
  const out = await executeBatchPerTestcase(fake, {
    batchId: 'x', limits: { cpu_time_limit: 1 }, testcases: [{ stdin: 'a' }, { stdin: 'tle' }],
  });
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.results.map((r) => r.status), ['completed', 'time_limit_exceeded']);
  assert.equal(out.results[0].timeMs, 10);

  const ce = await executeBatchPerTestcase({ execute: async () => ({ status: { id: 6 }, compile_output: 'bad' }) },
    { batchId: 'y', limits: {}, testcases: [{ stdin: '' }] });
  assert.equal(ce.status, 'compile_failed');
});

test('batch: stop_on_failure skips later groups but finishes the failing group', async () => {
  const ex = await makeExecutor();
  const limits = { cpu_time_limit: 1, wall_time_limit: 2, memory_limit: 256000, max_processes_and_or_threads: 60 };
  const out = await ex.executeBatch({
    batchId: 'g1', language: python, language_id: 71, source_code: 'x', limits,
    stop_on_failure: true,
    testcases: [
      { stdin: '1', group: 0 }, { stdin: '2', group: 0 },
      { stdin: 'loop', group: 1 }, { stdin: '3', group: 1 },
      { stdin: '4', group: 2 }, { stdin: '5', group: 2 }, { stdin: '6', group: 2 },
    ],
  });
  const statuses = out.results.map((r) => r.status);
  assert.equal(statuses[2], 'time_limit_exceeded');
  assert.equal(statuses[3], 'completed', 'rest of the failing group still runs');
  // Group 2 is skipped, except a case a parallel lane may have started before the failure was recorded.
  assert.ok(statuses.slice(4).filter((s) => s === 'skipped').length >= 2, statuses.join(','));
  assert.deepEqual(statuses.slice(0, 2), ['completed', 'completed']);

  const noStop = await ex.executeBatch({
    batchId: 'g2', language: python, language_id: 71, source_code: 'x', limits,
    testcases: [{ stdin: 'loop', group: 0 }, { stdin: '1', group: 1 }],
  });
  assert.deepEqual(noStop.results.map((r) => r.status), ['time_limit_exceeded', 'completed'], 'off by default');
});

test('generic fallback also honours stop_on_failure', async () => {
  const fake = { execute: async (s) => (s.stdin === 'crash' ? { status: { id: 11 } } : { status: { id: 3 }, stdout: 'ok' }) };
  const out = await executeBatchPerTestcase(fake, {
    batchId: 'z', limits: {}, stop_on_failure: true,
    testcases: [{ stdin: 'crash', group: 0 }, { stdin: 'a', group: 0 }, { stdin: 'b', group: 1 }],
  });
  assert.deepEqual(out.results.map((r) => r.status), ['runtime_error', 'completed', 'skipped']);
});

test('wait parameter parsing', async () => {
  const { parseWait } = await import('../src/api/routes/batches.js');
  assert.equal(parseWait(undefined), 0);
  assert.equal(parseWait('false'), 0);
  assert.equal(parseWait('true'), 25000);
  assert.equal(parseWait('5000'), 5000);
  assert.equal(parseWait('999999'), 25000, 'capped');
});

test('status mapping and limit clamping', () => {
  assert.equal(judge0StatusToBatchStatus(3), 'completed');
  assert.equal(judge0StatusToBatchStatus(7), 'runtime_error');
  assert.equal(judge0StatusToBatchStatus(8), 'output_limit_exceeded');
  assert.equal(judge0StatusToBatchStatus(13), 'internal_error');
  const l = resolveBatchLimits({ cpu_time_limit: 999, memory_limit: 262144, wall_time_limit: 0 });
  assert.equal(l.cpu_time_limit, 15, 'clamped to max');
  assert.equal(l.memory_limit, 262144);
  assert.equal(l.wall_time_limit, 10, 'invalid -> default');
});

test.after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});
