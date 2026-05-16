// In-process FIFO queue + single drain worker for immediate
// enrichment after a claim_feedback insert.
//
// Why not run runEnrichment synchronously inside the handler?
//   claim_feedback's 100ms ack contract — LLM inference takes
//   seconds, can't block the response.
// Why not setImmediate(() => runEnrichment(id))?
//   Under burst load (N feedbacks in one tick) that fires N
//   concurrent LLM calls and saturates Ollama. We want fan-in
//   bounded by a single drainer.
// Why not Postgres LISTEN/NOTIFY?
//   Across separate processes that *would* be the right answer.
//   For a single Knoldr process (the only topology that
//   exists today) an in-process queue is one-line simpler and
//   has identical latency. The periodic audit sweep is the
//   fallback that handles multi-replica + crash recovery cases.
//
// Latency targets:
//   single insert, idle queue → first LLM token ~1s
//   burst of N, sequential drain → each Nth row takes N × per-row
//   crash before drain → next audit sweep picks it up

import { logger } from '../observability/logger';
import { runEnrichment } from './enrich';

const queue: string[] = [];
let workerRunning = false;

function enqueueEnrichment(feedbackId: string): void {
  queue.push(feedbackId);
  if (!workerRunning) {
    workerRunning = true;
    void drain();
  }
}

async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      const feedbackId = queue.shift()!;
      try {
        await runEnrichment(feedbackId);
      } catch (err) {
        // Don't bring the worker down on per-row errors; the
        // periodic audit sweep will retry rows that didn't
        // transition out of `pending`.
        logger.warn(
          { feedbackId, error: (err as Error).message },
          'in-process enrichment failed; will be retried by periodic audit',
        );
      }
    }
  } finally {
    workerRunning = false;
  }
}

/** For tests / introspection. */
function pendingCount(): number {
  return queue.length;
}

export { enqueueEnrichment, pendingCount };
