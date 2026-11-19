import { Router } from 'express';
import submissionsRouter from './submissions.js';
import batchesRouter from './batches.js';
import languagesRouter from './languages.js';
import systemRouter from './system.js';
import metricsRouter from './metrics.js';

const router = Router();

// Submissions endpoints
router.use('/submissions', submissionsRouter);

// Batch execution: compile once, run many testcases
router.use('/batches', batchesRouter);

// Languages endpoint
router.use('/languages', languagesRouter);

// Metrics endpoint (Prometheus)
router.use('/metrics', metricsRouter);

// System endpoints (statuses, about, workers, etc.)
router.use('/', systemRouter);

export default router;
