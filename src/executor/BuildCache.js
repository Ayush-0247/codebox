import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

// Bump when the cache layout or compile semantics change.
const CACHE_VERSION = 'v1';

// Files the executor writes into the box for a run; never part of a build.
export const RUNTIME_FILES = new Set(['_stdin.txt', '_stdout.txt', '_stderr.txt', '_additional.zip']);

/**
 * Copies a directory tree, skipping top-level runtime files, and normalises
 * permissions so the unprivileged sandbox user can read (and execute) every file
 * no matter which user created it.
 */
export async function copyBuildTree(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  await fs.cp(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (src) => path.dirname(src) !== srcDir || !RUNTIME_FILES.has(path.basename(src)),
  });
  await normalizePermissions(destDir);
}

async function normalizePermissions(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fs.chmod(full, 0o755);
      await normalizePermissions(full);
    } else if (entry.isFile()) {
      const { mode } = await fs.stat(full);
      await fs.chmod(full, (mode & 0o111) ? 0o755 : 0o644);
    }
  }));
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

/**
 * Content-addressed cache of compiled builds.
 *
 * Key = hash(language, compile command, compiler options, source, extra files).
 * A successful entry is a directory holding the box contents right after
 * compilation; a failed entry stores only the compiler output, so repeated
 * submissions of the same broken code also skip the compiler.
 *
 * The cache lives on local disk owned by this single worker process, so an
 * in-memory index is authoritative. It is wiped at startup: artifacts built
 * by a previous image (possibly a different compiler) are never reused.
 */
export class BuildCache {
  constructor({ enabled = true, dir, maxBytes = 512 * 1024 * 1024, maxEntries = 2000 } = {}) {
    this.enabled = Boolean(enabled && dir);
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.index = new Map(); // key -> { ok, bytes, lastUsed, compile? }
    this.clock = 0; // monotonic use counter (timestamps tie within a millisecond)
    this.totalBytes = 0;
    this.inflight = new Map(); // key -> Promise (compile in progress)

    if (this.enabled) {
      try {
        fsSync.rmSync(this.dir, { recursive: true, force: true });
        fsSync.mkdirSync(this.dir, { recursive: true });
      } catch (err) {
        logger.warn({ err: err.message, dir: this.dir }, 'Build cache disabled: directory not usable');
        this.enabled = false;
      }
    }
  }

  tick() {
    this.clock += 1;
    return this.clock;
  }

  keyFor(submission) {
    if (!this.enabled) return null;
    const { language } = submission;
    if (!language?.compile_cmd) return null;
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([
        CACHE_VERSION,
        language.id,
        language.compile_cmd,
        language.source_file,
        submission.compiler_options || '',
        submission.source_code || '',
        submission.additional_files || '',
      ]))
      .digest('hex');
  }

  entryDir(key) {
    return path.join(this.dir, key);
  }

  /** Returns { ok: true, dir } | { ok: false, compile } | null. */
  get(key) {
    if (!key) return null;
    const entry = this.index.get(key);
    if (!entry) return null;
    entry.lastUsed = this.tick();
    return entry.ok ? { ok: true, dir: this.entryDir(key) } : { ok: false, compile: entry.compile };
  }

  /**
   * Serialises compiles of identical code. If another job is already compiling
   * this key, waits for it and returns false (caller should re-check the cache);
   * otherwise runs fn and returns its result.
   */
  async exclusive(key, fn) {
    if (!key) return { waited: false, value: await fn() };
    const pending = this.inflight.get(key);
    if (pending) {
      try { await pending; } catch { /* the owner reports its own error */ }
      return { waited: true, value: undefined };
    }
    const promise = (async () => fn())();
    this.inflight.set(key, promise);
    try {
      return { waited: false, value: await promise };
    } finally {
      this.inflight.delete(key);
    }
  }

  async putSuccess(key, workDir) {
    if (!key || this.index.has(key)) return;
    const tmp = path.join(this.dir, `.tmp-${key}-${process.pid}-${Date.now()}`);
    const dest = this.entryDir(key);
    try {
      await copyBuildTree(workDir, tmp);
      const bytes = await dirSize(tmp);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(tmp, dest);
      this.index.set(key, { ok: true, bytes, lastUsed: this.tick() });
      this.totalBytes += bytes;
      await this.evict();
    } catch (err) {
      logger.warn({ err: err.message, key }, 'Build cache store failed');
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async putFailure(key, compile) {
    if (!key || this.index.has(key)) return;
    const bytes = Buffer.byteLength(JSON.stringify(compile || {}));
    this.index.set(key, { ok: false, bytes, lastUsed: this.tick(), compile });
    this.totalBytes += bytes;
    await this.evict();
  }

  async evict() {
    if (this.totalBytes <= this.maxBytes && this.index.size <= this.maxEntries) return;
    const byAge = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of byAge) {
      if (this.totalBytes <= this.maxBytes && this.index.size <= this.maxEntries) break;
      if (this.inflight.has(key)) continue;
      this.index.delete(key);
      this.totalBytes -= entry.bytes;
      if (entry.ok) {
        await fs.rm(this.entryDir(key), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      entries: this.index.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
    };
  }
}

export default BuildCache;
