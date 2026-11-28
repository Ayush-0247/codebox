// Regression tests for the 2026-11 security remediation (SA-H4, SA-H5,
// SA-M8 and the archive symlink write). Linux semantics (symlinks, FIFOs,
// O_NOFOLLOW) are required: run in the worker/api image or on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

process.env.AUTH_TOKEN = 'a'.repeat(40) + ' ' + 'b'.repeat(40);
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';
process.env.RATE_LIMIT_UNAUTHENTICATED_MAX = '3';

const { readBoxFile, writeBoxFile, assertNoLinks } = await import('../src/executor/IsolateExecutor.js');
const { copyBuildTree } = await import('../src/executor/BuildCache.js');
const { matchToken, authenticate } = await import('../src/api/middleware/auth.js');
const { createLimiter } = await import('../src/api/middleware/rateLimit.js');
const configModule = await import('../src/utils/config.js');

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cb-sec-'));

// The symlink tests need a host that lets this user create symlinks (Linux,
// the CodeBox containers, or Windows with Developer Mode). Elsewhere they are
// skipped with a reason instead of failing.
const canSymlink = await (async () => {
  const dir = await tmp();
  try {
    await fs.symlink(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})();
const symlinkTest = canSymlink ? test : (name, fn) => test(name, { skip: 'this host cannot create symlinks (run on Linux or in the worker image)' }, fn);

symlinkTest('readBoxFile never follows a symlink (the old fs.readFile did)', async () => {
  const dir = await tmp();
  const secret = path.join(dir, 'secret.txt');
  await fs.writeFile(secret, 'SECRET');
  const box = path.join(dir, '_stdout.txt');
  await fs.symlink(secret, box);
  assert.equal(await fs.readFile(box, 'utf-8'), 'SECRET', 'reference: readFile follows links');
  assert.equal(await readBoxFile(box, 1024), '', 'readBoxFile returns nothing');
});

test('readBoxFile does not block on a FIFO and is bounded', async () => {
  const dir = await tmp();
  const fifo = path.join(dir, '_stdout.txt');
  execFileSync('mkfifo', [fifo]);
  const started = Date.now();
  assert.equal(await readBoxFile(fifo, 1024), '');
  assert.ok(Date.now() - started < 1000);
  const big = path.join(dir, 'big.txt');
  await fs.writeFile(big, 'x'.repeat(100_000));
  assert.equal((await readBoxFile(big, 1000)).length, 1000);
  assert.equal(await readBoxFile(path.join(dir, 'missing'), 10), '');
});

symlinkTest('writeBoxFile replaces a symlink instead of writing through it', async () => {
  const dir = await tmp();
  const target = path.join(dir, 'outside.txt');
  const stdin = path.join(dir, '_stdin.txt');
  await fs.symlink(target, stdin);
  await writeBoxFile(stdin, 'input');
  await assert.rejects(fs.access(target), 'the link target was never created');
  assert.equal((await fs.lstat(stdin)).isFile(), true);
  assert.equal(await fs.readFile(stdin, 'utf-8'), 'input');
});

symlinkTest('assertNoLinks rejects symlinks and hard links in extracted archives', async () => {
  const clean = await tmp();
  await fs.mkdir(path.join(clean, 'sub'));
  await fs.writeFile(path.join(clean, 'sub', 'a.txt'), 'a');
  await assertNoLinks(clean);

  const linked = await tmp();
  await fs.mkdir(path.join(linked, 'sub'));
  await fs.symlink('/etc/passwd', path.join(linked, 'sub', 'x'));
  await assert.rejects(assertNoLinks(linked), /symbolic link/);

  const hard = await tmp();
  await fs.writeFile(path.join(hard, 'a'), 'a');
  await fs.link(path.join(hard, 'a'), path.join(hard, 'b'));
  await assert.rejects(assertNoLinks(hard), /hard link/);
});

symlinkTest('build cache copies never carry symlinks and never chmod through them', async () => {
  const src = await tmp();
  const dest = await tmp();
  const outside = path.join(await tmp(), 'outside.txt');
  await fs.writeFile(outside, 'o');
  await fs.chmod(outside, 0o600);
  await fs.writeFile(path.join(src, 'main'), 'bin');
  await fs.symlink(outside, path.join(src, 'link'));
  await copyBuildTree(src, dest);
  await assert.rejects(fs.lstat(path.join(dest, 'link')), 'symlink not copied');
  assert.equal(((await fs.stat(outside)).mode & 0o777), 0o600, 'link target permissions untouched');
});

test('token comparison: only exact configured tokens match', () => {
  assert.equal(matchToken('a'.repeat(40)), 0);
  assert.equal(matchToken('b'.repeat(40)), 1);
  assert.equal(matchToken('a'.repeat(39)), -1);
  assert.equal(matchToken('a'.repeat(41)), -1);
  assert.equal(matchToken(''), -1);
  assert.equal(matchToken(undefined), -1);
  const req = (headers) => ({ get: (name) => headers[name.toLowerCase()] });
  assert.equal(authenticate(req({ 'x-auth-token': 'b'.repeat(40) })).clientId, 'token-1');
  assert.equal(authenticate(req({})).ok, false);
});

test('rate limit budgets are separate per key', () => {
  const limiter = createLimiter({ windowMs: 60_000, max: 2, keyOf: (req) => req.key });
  const run = (key) => {
    let status = 200;
    const res = { set() {}, status(code) { status = code; return { json() {} }; } };
    limiter({ key }, res, () => {});
    return status;
  };
  assert.deepEqual([run('ip:attacker'), run('ip:attacker'), run('ip:attacker')], [200, 200, 429]);
  assert.equal(run('client:token-0'), 200, 'the attacker cannot exhaust another key');
});

test('unsafe production settings are refused', () => {
  const { validateSecurityConfig } = configModule;
  const base = configModule.default;
  const prod = { ...base, server: { ...base.server, nodeEnv: 'production', trustProxy: 1 }, auth: { ...base.auth, tokens: ['x'.repeat(40)] } };
  assert.deepEqual(validateSecurityConfig(prod, {}), []);
  assert.equal(validateSecurityConfig({ ...prod, auth: { ...prod.auth, tokens: [] } }, {}).length, 1);
  assert.equal(validateSecurityConfig({ ...prod, auth: { ...prod.auth, tokens: ['local-dev-token'] } }, {}).length, 1);
  assert.equal(validateSecurityConfig({ ...prod, server: { ...prod.server, trustProxy: true } }, {}).length, 1);
  assert.equal(validateSecurityConfig(prod, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }).length, 1);
});
