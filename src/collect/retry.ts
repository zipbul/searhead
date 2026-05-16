import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { retryQueue } from '../db/schema';
import { logger } from '../observability/logger';

// Pure DB writer for the ingestion retry queue. The processor that
// dequeues + re-ingests lives in `src/ingest/retry-runner.ts` so the
// engine (which calls enqueueRetry on transient failures) and the
// runner (which calls ingest on dequeue) don't form an import cycle.

/** Add a failed ingestion to the retry queue. */
export async function enqueueRetry(rawContent: string, sourceUrl: string | undefined, errorReason: string): Promise<void> {
  await getDb()
    .insert(retryQueue)
    .values({
      id: ulid(),
      rawContent,
      sourceUrl: sourceUrl ?? null,
      errorReason,
    });
  logger.info({ errorReason }, 'added to retry queue');
}
