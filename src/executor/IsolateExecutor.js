import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import logger from '../utils/logger.js';
import config from '../utils/config.js';
import { getStatusById } from '../languages/index.js';
import { BuildCache, copyBuildTree } from './BuildCache.js';

const execFileAsync = promisify(execFile);

const MULTI_FILE_LANGUAGE_ID = 89;
const MAX_OUTPUT_CHARS = 65536;

// Atomic box-ID counter (0-999). Safe in single-threaded Node.js event loop.
let nextBoxId = 0;
function allocateBoxId() {
  const id = nextBoxId;
  nextBoxId = (nextBoxId + 1) % 1000;
  return id;
}

function truncate(text) {
  if (!text) return text;
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;
}

/**
 * stop_on_failure + testcase groups (e.g. difficulty tiers, in order): once a
 * testcase fails to complete (crash/timeout/memory), testcases in LATER groups
 * are skipped; the rest of the failing group still runs. Wrong answers are not
 * detected here (no expected output), so they never stop a batch.
 */
export function createGroupStopper(batch) {
  const enabled = Boolean(batch.stop_on_failure);
  const groupOf = (index) => Number(batch.testcases[index]?.group ?? 0);
  let stopAfterGroup = Infinity;
  return {
    shouldSkip: (index) => enabled && groupOf(index) > stopAfterGroup,
    record: (index, status) => {
      if (enabled && status !== 'completed') {
        stopAfterGroup = Math.min(stopAfterGroup, groupOf(index));
      }
    },
  };
}

export function skippedResult(index) {
  return {
    index,
    status: 'skipped',
    stdout: '',
    stderr: '',
    timeMs: 0,
    wallTimeMs: 0,
    memory: 0,
    exitCode: null,
    exitSignal: null,
    message: 'Skipped: a testcase in an earlier group failed',
  };
}

async function emptyDir(dir) {
  let entries;
  try { entries = await fs.readdir(dir); } catch { return; }
  await Promise.all(entries.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
}

class IsolateExecutor {
  constructor() {
    this.buildCache = new BuildCache(config.buildCache);
  }

  async initBox(boxId) {
    const { stdout } = await execFileAsync('isolate', ['--init', `--box-id=${boxId}`, '--cg']);
    return stdout.trim(); // e.g. /var/local/lib/isolate/0
  }

  async cleanupBox(boxId) {
    try {
      await execFileAsync('isolate', ['--cleanup', `--box-id=${boxId}`, '--cg']);
    } catch { /* ignore */ }
  }

  /**
   * Execute a submission inside an isolate sandbox.
   */
  async execute(submission) {
    const boxId = allocateBoxId();
    const { language } = submission;

    try {
      const boxDir = await this.initBox(boxId);
      const workDir = path.join(boxDir, 'box'); // host path: <root>/box/ maps to /box inside sandbox
      const stdinPath = path.join(workDir, '_stdin.txt');
      let sourceReady = false;

      // ── Multi-file program: language 89 or ZIP with run script ─────
      const maybeMultiFile = language.id === MULTI_FILE_LANGUAGE_ID
        || (!submission.source_code && submission.additional_files);
      if (maybeMultiFile) {
        await this.setupSource(workDir, submission);
        sourceReady = true;
        if (language.id === MULTI_FILE_LANGUAGE_ID) {
          await fs.writeFile(stdinPath, submission.stdin || '');
          return await this.executeMultiFile(boxId, workDir, submission);
        }
        for (const name of ['run', 'run.sh']) {
          try {
            await fs.access(path.join(workDir, name));
            await fs.writeFile(stdinPath, submission.stdin || '');
            return await this.executeMultiFile(boxId, workDir, submission);
          } catch { /* try next */ }
        }
      }

      // ── Compile (or reuse a cached build) ───────────────────────────
      const build = await this.ensureBuild(boxId, workDir, submission, { sourceReady });
      if (!build.ok) return build.result;

      // ── Run ─────────────────────────────────────────────────────────
      await fs.writeFile(stdinPath, submission.stdin || '');
      let runCmd = language.run_cmd;
      if (submission.command_line_arguments) {
        runCmd += ` ${submission.command_line_arguments}`;
      }

      const result = await this.runIsolate(boxId, workDir, {
        cmd: runCmd,
        stdinFile: stdinPath,
        timeLimit: submission.cpu_time_limit,
        wallTimeLimit: submission.wall_time_limit,
        memoryLimit: submission.memory_limit,
        processes: submission.max_processes_and_or_threads,
        fsize: submission.max_file_size || 1024,
      });

      return this.buildResult(result, submission);
    } catch (error) {
      logger.error({
        event: 'isolate_execution_error',
        token: submission.token,
        error: error.message,
      });
      return {
        status: getStatusById(13),
        message: error.message,
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        compile_output: null,
        exit_code: null,
        exit_signal: null,
      };
    } finally {
      await this.cleanupBox(boxId);
    }
  }

  /**
   * Execute one program against many testcases: compile once, then run each
   * testcase in a freshly reset box (same isolation and limits as separate
   * submissions, without paying for the compile N times).
   *
   * @returns {{ status: string, compileError?: string, message?: string, results: object[] }}
   */
  async executeBatch(batch) {
    const boxId = allocateBoxId();
    const { language } = batch;
    const limits = batch.limits;
    let snapshotDir = null;
    const extraBoxIds = [];

    try {
      const boxDir = await this.initBox(boxId);
      const workDir = path.join(boxDir, 'box');

      const build = await this.ensureBuild(boxId, workDir, batch, { sourceReady: false });
      if (!build.ok) {
        return {
          status: 'compile_failed',
          compileError: build.result.compile_output || 'Compilation failed.',
          message: build.result.compile_output || 'Compilation failed.',
          results: [],
        };
      }

      // Private snapshot of the built box: every testcase starts from it, and
      // cache eviction during a long batch cannot affect us.
      snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebox-batch-'));
      await copyBuildTree(workDir, snapshotDir);

      let runCmd = language.run_cmd;
      if (batch.command_line_arguments) runCmd += ` ${batch.command_line_arguments}`;

      // Run testcases on several sandboxes at once (each its own box/cgroup,
      // so limits and measurements stay per-testcase).
      const total = batch.testcases.length;
      const lanes = [{ boxId, boxDir }];
      const laneCount = Math.max(1, Math.min(config.batch.parallelism, total));
      for (let i = 1; i < laneCount; i++) {
        const id = allocateBoxId();
        extraBoxIds.push(id);
        lanes.push({ boxId: id, boxDir: await this.initBox(id) });
      }

      const results = new Array(total);
      const stopper = createGroupStopper(batch);
      let next = 0;
      const runLane = async ({ boxId: laneBoxId, boxDir: laneBoxDir }) => {
        const laneWorkDir = path.join(laneBoxDir, 'box');
        const stdinPath = path.join(laneWorkDir, '_stdin.txt');
        while (next < total) {
          const index = next++;
          if (stopper.shouldSkip(index)) {
            results[index] = skippedResult(index);
            continue;
          }
          await emptyDir(laneWorkDir);
          await emptyDir(path.join(laneBoxDir, 'tmp'));
          await copyBuildTree(snapshotDir, laneWorkDir);
          await fs.writeFile(stdinPath, batch.testcases[index].stdin || '');

          const run = await this.runIsolate(laneBoxId, laneWorkDir, {
            cmd: runCmd,
            stdinFile: stdinPath,
            timeLimit: limits.cpu_time_limit,
            wallTimeLimit: limits.wall_time_limit,
            memoryLimit: limits.memory_limit,
            processes: limits.max_processes_and_or_threads,
            fsize: limits.max_file_size || 1024,
          });
          results[index] = this.buildBatchCaseResult(run, index, limits);
          stopper.record(index, results[index].status);
        }
      };
      await Promise.all(lanes.map(runLane));

      return { status: 'completed', results };
    } catch (error) {
      logger.error({ event: 'isolate_batch_error', batchId: batch.batchId, error: error.message });
      return { status: 'failed', message: error.message, results: [] };
    } finally {
      if (snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      await Promise.all([boxId, ...extraBoxIds].map((id) => this.cleanupBox(id)));
    }
  }

  /** Writes the source file and extracts additional files into the box. */
  async setupSource(workDir, submission) {
    const { language } = submission;
    if (submission.source_code && language.source_file) {
      await fs.writeFile(path.join(workDir, language.source_file), submission.source_code);
    }
    if (submission.additional_files) {
      await this.extractAdditionalFiles(workDir, submission);
    }
  }

  /**
   * Leaves the box ready to run: either restores a cached build or compiles
   * (and caches the result). Identical concurrent compiles run only once.
   * @returns {{ ok: true } | { ok: false, result: object }}
   */
  async ensureBuild(boxId, workDir, submission, { sourceReady }) {
    const { language } = submission;

    if (!language.compile_cmd) {
      if (!sourceReady) await this.setupSource(workDir, submission);
      return { ok: true };
    }

    const key = this.buildCache.keyFor(submission);

    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = this.buildCache.get(key);
      if (cached?.ok) {
        try {
          await emptyDir(workDir);
          await copyBuildTree(cached.dir, workDir);
          logger.debug({ event: 'build_cache_hit', token: submission.token, language: language.id });
          return { ok: true };
        } catch (err) {
          // Entry vanished (evicted) mid-copy: rebuild from source below.
          logger.warn({ event: 'build_cache_restore_failed', error: err.message });
          await emptyDir(workDir);
          sourceReady = false;
          break;
        }
      }
      if (cached && !cached.ok) {
        return { ok: false, result: this.compileErrorResult(cached.compile) };
      }

      const { waited, value } = await this.buildCache.exclusive(key, () =>
        this.compile(boxId, workDir, submission, { sourceReady, key }));
      if (!waited) return value;
      // Another job just compiled identical code: loop to pick up its result.
    }

    return this.compile(boxId, workDir, submission, { sourceReady, key: null });
  }

  async compile(boxId, workDir, submission, { sourceReady, key }) {
    const { language } = submission;
    if (!sourceReady) await this.setupSource(workDir, submission);

    let compileCmd = language.compile_cmd;
    if (submission.compiler_options) {
      compileCmd += ` ${submission.compiler_options}`;
    }
    const compileResult = await this.runIsolate(boxId, workDir, {
      cmd: compileCmd,
      timeLimit: config.execution.compileCpuTimeLimit,
      wallTimeLimit: config.execution.compileWallTimeLimit,
      memoryLimit: Math.max(submission.memory_limit || 0, language.min_memory || 0),
      processes: submission.max_processes_and_or_threads,
    });

    if (compileResult.exitCode !== 0 || compileResult.isoStatus) {
      const compile = {
        output: compileResult.stderr || compileResult.stdout || compileResult.message,
        exitCode: compileResult.exitCode,
        exitSignal: compileResult.exitSignal,
      };
      // Only a genuine compiler error is deterministic enough to cache;
      // timeouts/kills/internal errors may be load-related.
      if (compileResult.isoStatus === 'RE') await this.buildCache.putFailure(key, compile);
      return { ok: false, result: this.compileErrorResult(compile) };
    }

    await this.buildCache.putSuccess(key, workDir);
    return { ok: true };
  }

  compileErrorResult(compile) {
    return {
      status: getStatusById(6),
      compile_output: compile?.output || null,
      time: null,
      wall_time: null,
      memory: null,
      stdout: null,
      stderr: null,
      exit_code: compile?.exitCode ?? null,
      exit_signal: compile?.exitSignal ?? null,
    };
  }

  /**
   * Multi-file program (language_id 89): compile + run scripts from ZIP.
   */
  async executeMultiFile(boxId, workDir, submission) {
    // Verify run script exists (check both 'run' and 'run.sh')
    let runScript = null;
    for (const name of ['run', 'run.sh']) {
      try {
        await fs.access(path.join(workDir, name));
        runScript = name;
        break;
      } catch { /* try next */ }
    }
    if (!runScript) {
      return {
        status: getStatusById(6),
        compile_output: 'Multi-file program requires a "run" (or "run.sh") script in the ZIP archive',
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        exit_code: null,
        exit_signal: null,
      };
    }

    const stdinPath = path.join(workDir, '_stdin.txt');

    // Optional compile step (check both 'compile' and 'compile.sh')
    let compileScript = null;
    for (const name of ['compile', 'compile.sh']) {
      try {
        await fs.access(path.join(workDir, name));
        compileScript = name;
        break;
      } catch { /* try next */ }
    }

    if (compileScript) {
      const compileResult = await this.runIsolate(boxId, workDir, {
        cmd: `bash /box/${compileScript}`,
        timeLimit: config.execution.compileCpuTimeLimit,
        wallTimeLimit: config.execution.compileWallTimeLimit,
        memoryLimit: Math.max(submission.memory_limit, 512000),
        processes: submission.max_processes_and_or_threads,
      });

      if (compileResult.exitCode !== 0 || compileResult.isoStatus) {
        return {
          status: getStatusById(6),
          compile_output: compileResult.stderr || compileResult.stdout || compileResult.message,
          time: null,
          wall_time: null,
          memory: null,
          stdout: null,
          stderr: null,
          exit_code: compileResult.exitCode,
          exit_signal: compileResult.exitSignal,
        };
      }
    }

    // Run
    const result = await this.runIsolate(boxId, workDir, {
      cmd: `bash /box/${runScript}`,
      stdinFile: stdinPath,
      timeLimit: submission.cpu_time_limit,
      wallTimeLimit: submission.wall_time_limit,
      memoryLimit: submission.memory_limit,
      processes: submission.max_processes_and_or_threads,
      fsize: submission.max_file_size || 1024,
    });

    return this.buildResult(result, submission);
  }

  /**
   * Core isolate invocation.
   * Returns { stdout, stderr, time, wallTime, memory, exitCode, exitSignal, isoStatus, oomKilled }.
   */
  async runIsolate(boxId, workDir, opts) {
    const { cmd, stdinFile, timeLimit, wallTimeLimit, memoryLimit, processes, fsize = 10240 } = opts;

    const metaPath = `/tmp/isolate-meta-${boxId}.txt`;

    // Sandbox-relative paths (used by isolate flags)
    const sandboxStdout = '/box/_stdout.txt';
    const sandboxStderr = '/box/_stderr.txt';

    // Host paths (for reading results after execution)
    const hostStdoutPath = path.join(workDir, '_stdout.txt');
    const hostStderrPath = path.join(workDir, '_stderr.txt');

    // A stale meta/output file from a previous run in this box must never be
    // mistaken for this run's result.
    await Promise.all([
      fs.rm(metaPath, { force: true }),
      fs.rm(hostStdoutPath, { force: true }),
      fs.rm(hostStderrPath, { force: true }),
    ]);

    const args = [
      `--box-id=${boxId}`,
      '--cg',
      `--cg-mem=${memoryLimit}`,           // cgroup memory limit (KB)
      `--meta=${metaPath}`,                // host path (written by parent process)
      `--time=${timeLimit}`,
      `--wall-time=${wallTimeLimit}`,
      `--processes=${processes}`,
      `--fsize=${fsize}`,                     // max output file size (KB)
      `--stdout=${sandboxStdout}`,          // sandbox path
      `--stderr=${sandboxStderr}`,          // sandbox path
      '--dir=/etc:noexec',                 // read-only /etc (Java, Python need it)
      '--dir=/tmp=',                       // writable /tmp
      '--env=PATH=/usr/local/bin:/usr/bin:/bin',
      '--env=HOME=/box',
      '--env=LANG=C.UTF-8',
    ];

    if (stdinFile) {
      args.push(`--stdin=/box/_stdin.txt`);  // sandbox path (file written to workDir on host)
    }

    args.push('--run', '--', '/bin/sh', '-c', `cd /box && ${cmd}`);

    try {
      await execFileAsync('isolate', args, {
        timeout: (wallTimeLimit + 10) * 1000,
      });
    } catch {
      // isolate exits non-zero on TLE, RE, etc. — that's normal
    }

    // Read outputs from HOST paths
    let stdout = '';
    let stderr = '';
    try { stdout = await fs.readFile(hostStdoutPath, 'utf-8'); } catch { /* empty */ }
    try { stderr = await fs.readFile(hostStderrPath, 'utf-8'); } catch { /* empty */ }

    // Parse meta file (isolate's precise measurements)
    const meta = await this.parseMeta(metaPath);

    return { stdout, stderr, ...meta };
  }

  /**
   * Parse isolate's meta file.
   * Format: key:value per line.
   * Keys: time, time-wall, max-rss, cg-mem, status, exitcode, exitsig, message, killed, cg-oom-killed
   */
  async parseMeta(metaPath) {
    const defaults = {
      time: null,
      wallTime: null,
      memory: null,
      exitCode: 0,
      exitSignal: null,
      isoStatus: null,
      message: null,
      oomKilled: false,
    };

    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      const meta = {};
      for (const line of content.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }

      return {
        time: meta.time ? parseFloat(meta.time) : null,
        wallTime: meta['time-wall'] ? parseFloat(meta['time-wall']) : null,
        memory: meta['max-rss'] ? parseInt(meta['max-rss']) : (meta['cg-mem'] ? parseInt(meta['cg-mem']) : null),
        exitCode: meta.exitcode ? parseInt(meta.exitcode) : 0,
        exitSignal: meta.exitsig ? parseInt(meta.exitsig) : null,
        isoStatus: meta.status || null,   // RE, SG, TO, XX
        message: meta.message || null,
        oomKilled: meta['cg-oom-killed'] === '1',
      };
    } catch {
      return defaults;
    }
  }

  /**
   * Extract base64-encoded ZIP into the work directory.
   */
  async extractAdditionalFiles(workDir, submission) {
    const tmpZip = path.join(workDir, '_additional.zip');

    try {
      const zipBuffer = Buffer.from(submission.additional_files, 'base64');
      await fs.writeFile(tmpZip, zipBuffer);

      // Path traversal check
      const { stdout: listing } = await execFileAsync('unzip', ['-l', tmpZip]);
      if (listing.includes('../') || listing.includes('/..')) {
        throw new Error('ZIP archive contains path traversal entries');
      }

      await execFileAsync('unzip', ['-n', '-qq', tmpZip, '-d', workDir]);
      await fs.unlink(tmpZip);

      logger.info({
        event: 'additional_files_extracted',
        token: submission.token,
        size: zipBuffer.length,
      });
    } catch (error) {
      try { await fs.unlink(tmpZip); } catch { /* ignore */ }
      throw new Error(`Failed to extract additional files: ${error.message}`);
    }
  }

  /**
   * Map one batch testcase run to the batch result format.
   * Statuses: completed | time_limit_exceeded | memory_limit_exceeded |
   *           output_limit_exceeded | runtime_error | internal_error
   */
  buildBatchCaseResult(run, index, limits) {
    let status;
    if (run.oomKilled) status = 'memory_limit_exceeded';
    else if (run.isoStatus === 'TO') status = 'time_limit_exceeded';
    else if (run.isoStatus === 'SG') {
      if (run.exitSignal === 25) status = 'output_limit_exceeded';
      else if (run.exitSignal === 9 && run.memory && run.memory >= limits.memory_limit * 0.95) status = 'memory_limit_exceeded';
      else if (run.exitSignal === 9) status = 'time_limit_exceeded';
      else status = 'runtime_error';
    } else if (run.isoStatus === 'RE') status = 'runtime_error';
    else if (run.isoStatus === 'XX') status = 'internal_error';
    else status = run.exitCode === 0 ? 'completed' : 'runtime_error';

    return {
      index,
      status,
      stdout: truncate(run.stdout) || '',
      stderr: truncate(run.stderr) || '',
      timeMs: run.time != null ? Math.round(run.time * 1000) : 0,
      wallTimeMs: run.wallTime != null ? Math.round(run.wallTime * 1000) : 0,
      memory: run.memory ?? 0,
      exitCode: run.exitCode,
      exitSignal: run.exitSignal,
      message: run.message || null,
    };
  }

  /**
   * Map isolate meta to a Judge0-compatible result object.
   */
  buildResult(result, submission) {
    let status;

    if (result.isoStatus === 'TO') {
      status = getStatusById(5);            // Time Limit Exceeded
    } else if (result.isoStatus === 'SG') {
      // Killed by signal
      const sig = result.exitSignal;
      if (sig === 11) status = getStatusById(7);       // SIGSEGV
      else if (sig === 8) status = getStatusById(9);   // SIGFPE
      else if (sig === 6) status = getStatusById(10);  // SIGABRT
      else if (sig === 25) status = getStatusById(8);  // SIGXFSZ
      else if (sig === 9) status = getStatusById(5);   // SIGKILL → TLE/MLE
      else status = getStatusById(12);                 // Other
    } else if (result.isoStatus === 'RE') {
      status = getStatusById(11);           // NZEC
    } else if (result.isoStatus === 'XX') {
      status = getStatusById(13);           // Internal Error
    } else if (result.exitCode === 0) {
      status = getStatusById(3);            // Accepted
    } else {
      status = getStatusById(11);           // NZEC
    }

    let stdout = truncate(result.stdout) || null;
    let stderr = truncate(result.stderr) || null;

    // Merge stderr into stdout if requested
    if (submission.redirect_stderr_to_stdout) {
      stdout = (stdout || '') + (stderr ? '\n' + stderr : '');
      stderr = null;
    }

    return {
      status,
      stdout: stdout || null,
      stderr: stderr || null,
      compile_output: null,
      time: result.time != null ? result.time.toFixed(3) : null,
      wall_time: result.wallTime != null ? result.wallTime.toFixed(3) : null,
      memory: result.memory != null ? result.memory : null,
      exit_code: result.exitCode,
      exit_signal: result.exitSignal,
      message: result.message,
    };
  }
}

export default IsolateExecutor;
