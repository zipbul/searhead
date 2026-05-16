import { startServer } from './a2a/server';
import { startFqaWorkers } from './fqa/workers';
import { configureOnnxRuntime } from './llm/onnx-env';
import { logger } from './observability/logger';

logger.info('knoldr starting');

// Configure onnxruntime thread pool BEFORE any model import so the
// setting takes effect on the first NLI / reranker / QA load.
await configureOnnxRuntime();

startServer();
// FQA runs as background workers in the same process — no separate
// A2A surface. Reporter-driven completion goes through the main
// `claim_feedback` skill (update mode). Disable entirely with
// KNOLDR_FQA_WORKERS=0.
startFqaWorkers();
