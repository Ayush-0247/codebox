import { getExecutor, getExecutorType } from '../../executor/ExecutorFactory.js';
import { createGroupStopper, skippedResult } from '../../executor/IsolateExecutor.js';
import { analyzeCode } from '../../security/codeAnalyzer.js';
import logger from '../../utils/logger.js';

/** Maps a Judge0 status id to a batch testcase status. */
export function judge0StatusToBatchStatus(statusId) {
  switch (statusId) {
    case 3:
    case 4:
      return 'completed';
    case 5:
      return 'time_limit_exceeded';
    case 8:
      return 'output_limit_exceeded';
    case 13:
    case 14:
      return 'internal_error';
    default:
      return statusId >= 7 && statusId <= 12 ? 'runtime_error' : 'internal_error';
  }
}

/**
 * Generic batch execution for executors without native batch support:
 * runs each testcase as an ordinary submission (no compile reuse).
 */
export async function executeBatchPerTestcase(executor, batch) {
  const results = [];
  const stopper = createGroupStopper(batch);
  for (let index = 0; index < batch.testcases.length; index++) {
    if (stopper.shouldSkip(index)) {
      results.push(skippedResult(index));
      continue;
    }
    const result = await executor.execute({
      ...batch,
      ...batch.limits,
      token: `${batch.batchId}:${index}`,
      stdin: batch.testcases[index].stdin || '',
    });
    if (result.status?.id === 6) {
      return {
        status: 'compile_failed',
        compileError: result.compile_output || 'Compilation failed.',
        message: result.compile_output || 'Compilation failed.',
        results: [],
      };
    }
    const timeMs = result.time != null ? Math.round(parseFloat(result.time) * 1000) : 0;
    const wallTimeMs = result.wall_time != null ? Math.round(parseFloat(result.wall_time) * 1000) : 0;
    results.push({
      index,
      status: judge0StatusToBatchStatus(result.status?.id),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      timeMs,
      wallTimeMs,
      memory: result.memory ?? 0,
      exitCode: result.exit_code ?? null,
      exitSignal: result.exit_signal ?? null,
      message: result.message || null,
    });
    stopper.record(index, results[results.length - 1].status);
  }
  return { status: 'completed', results };
}

/**
 * Execute a batch job: one program, many testcases.
 * @returns {{ status, compileError?, message?, results }}
 */
export async function executeBatch(batch) {
  const scan = analyzeCode(batch.source_code, batch.language_id);
  if (scan.rejected) {
    logger.warn({ event: 'batch_code_rejected', batchId: batch.batchId, reason: scan.reason });
    const message = `Rejected: ${scan.reason}`;
    return { status: 'compile_failed', compileError: message, message, results: [] };
  }

  const executor = getExecutor();
  const start = Date.now();
  let outcome;
  try {
    outcome = typeof executor.executeBatch === 'function'
      ? await executor.executeBatch(batch)
      : await executeBatchPerTestcase(executor, batch);
  } catch (error) {
    logger.error({ event: 'batch_failed', batchId: batch.batchId, error: error.message });
    outcome = { status: 'failed', message: error.message, results: [] };
  }

  logger.info({
    event: 'batch_completed',
    batchId: batch.batchId,
    status: outcome.status,
    testcases: batch.testcases.length,
    durationMs: Date.now() - start,
    executor: getExecutorType(),
  });
  return outcome;
}

export default executeBatch;
