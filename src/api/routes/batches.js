import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  validateBatchExecution,
  sanitizeCompilerOptions,
  sanitizeCommandLineArgs,
} from '../middleware/validation.js';
import { addBatch, getBatch } from '../../queue/producer.js';
import { watchBatch } from '../../queue/batchEvents.js';
import { getLanguageById } from '../../languages/index.js';
import { decodeIfNeeded, encodeIfNeeded } from '../../utils/base64.js';
import logger from '../../utils/logger.js';
import config from '../../utils/config.js';

const router = Router();

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Resolves batch limits: defaults for missing values, clamped to configured maximums. */
export function resolveBatchLimits(limits = {}) {
  const ex = config.execution;
  return {
    cpu_time_limit: clamp(limits.cpu_time_limit, ex.defaultCpuTimeLimit, ex.maxCpuTimeLimit),
    wall_time_limit: clamp(limits.wall_time_limit, ex.defaultWallTimeLimit, ex.maxWallTimeLimit),
    memory_limit: clamp(limits.memory_limit, ex.defaultMemoryLimit, ex.maxMemoryLimit),
    max_processes_and_or_threads: clamp(limits.max_processes_and_or_threads, ex.maxProcesses, ex.maxProcesses),
    max_file_size: clamp(limits.max_file_size, 1024, 4096),
  };
}

function formatBatch(state, base64Encoded) {
  if (!base64Encoded) return state;
  return {
    ...state,
    compileError: encodeIfNeeded(state.compileError, true),
    message: encodeIfNeeded(state.message, true),
    results: (state.results || []).map((r) => ({
      ...r,
      stdout: encodeIfNeeded(r.stdout, true),
      stderr: encodeIfNeeded(r.stderr, true),
    })),
  };
}

/**
 * POST /batches
 * Run one program against many testcases. The program is compiled once.
 * Body: { language_id, source_code, testcases: [{ stdin }], limits?: {...},
 *         compiler_options?, command_line_arguments? }
 * Response: 201 { batchId, status: "queued" }
 */
router.post('/', validateBatchExecution, async (req, res, next) => {
  try {
    const data = req.validatedBody;
    const base64Encoded = req.query.base64_encoded === 'true';
    const limits = resolveBatchLimits(data.limits);

    const batch = {
      batchId: uuidv4(),
      language_id: data.language_id,
      language: getLanguageById(data.language_id),
      source_code: decodeIfNeeded(data.source_code, base64Encoded),
      testcases: data.testcases.map((tc) => ({
        stdin: decodeIfNeeded(tc.stdin, base64Encoded) || '',
        group: tc.group,
      })),
      stop_on_failure: data.stop_on_failure,
      limits,
      // Compile step uses the same memory as the run (raised by language min_memory).
      memory_limit: limits.memory_limit,
      max_processes_and_or_threads: limits.max_processes_and_or_threads,
      compiler_options: sanitizeCompilerOptions(data.compiler_options),
      command_line_arguments: sanitizeCommandLineArgs(data.command_line_arguments),
      created_at: new Date().toISOString(),
    };

    await addBatch(batch);

    logger.info({
      event: 'batch_created',
      batchId: batch.batchId,
      language_id: batch.language_id,
      testcases: batch.testcases.length,
    });

    const waitMs = parseWait(req.query.wait);
    if (waitMs > 0) {
      const state = await getBatchWaiting(batch.batchId, waitMs);
      return res.status(201).json({
        ...formatBatch(state, base64Encoded),
        batchId: batch.batchId,
        id: batch.batchId,
      });
    }

    res.status(201).json({ batchId: batch.batchId, id: batch.batchId, status: 'queued' });
  } catch (error) {
    next(error);
  }
});

const TERMINAL = new Set(['completed', 'compile_failed', 'failed']);

/** ?wait=true -> default max wait; ?wait=<ms> -> that long (capped). */
export function parseWait(value) {
  if (value === undefined || value === 'false' || value === '0') return 0;
  if (value === 'true' || value === '') return config.batch.maxWaitMs;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, config.batch.maxWaitMs) : 0;
}

/**
 * Returns the batch state as soon as it is finished, or the current state once
 * waitMs has passed. Woken by the worker's completion message, not polling.
 */
async function getBatchWaiting(batchId, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const watch = watchBatch(batchId, deadline - Date.now());
    try {
      await watch.ready;
    } catch {
      watch.cancel();
      return getBatch(batchId); // no pub/sub: answer with the current state
    }
    const state = await getBatch(batchId);
    if (!state || TERMINAL.has(state.status) || Date.now() >= deadline) {
      watch.cancel();
      return state;
    }
    await watch.done;
  }
}

async function sendBatch(batchId, req, res, next) {
  try {
    if (!batchId) {
      return res.status(400).json({ error: 'Bad Request', message: 'Missing batchId' });
    }
    const waitMs = parseWait(req.query.wait);
    const state = waitMs > 0 ? await getBatchWaiting(batchId, waitMs) : await getBatch(batchId);
    if (!state) {
      return res.status(404).json({ error: 'Not Found', message: `Batch ${batchId} not found` });
    }
    res.json(formatBatch(state, req.query.base64_encoded === 'true'));
  } catch (error) {
    next(error);
  }
}

/**
 * GET /batches?batchId=<id>  |  GET /batches/:batchId
 * Status: queued | processing | completed | compile_failed | failed
 * Each result: { index, status, stdout, stderr, timeMs, wallTimeMs, memory, exitCode, exitSignal }
 */
router.get('/', (req, res, next) => sendBatch(req.query.batchId, req, res, next));
router.get('/:batchId', (req, res, next) => sendBatch(req.params.batchId, req, res, next));

export default router;
