import { sql, eq } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { entry } from '../db/schema';
import { logger } from '../observability/logger';

const DISTANCE_THRESHOLD = 0.05; // cosine distance < 0.05 = similarity > 0.95
const CANDIDATE_LIMIT = 8;

/**
 * Check if an embedding is a near-duplicate of an existing ACTIVE entry.
 *
 * Uses the HNSW index via `ORDER BY embedding <=> $vec LIMIT N` — this
 * is the only ANN-eligible shape for pgvector's hnsw operator class. A
 * bare `WHERE distance < threshold` would force a Seq Scan and make
 * every ingest O(N) on entry count. With the LIMIT form, the index
 * returns a small approximate top-N and we filter by the distance
 * threshold in JS.
 *
 * Filters to status='active' so draft / soft-deleted rows don't count
 * against new ingestions.
 */
export async function isDuplicate(embedding: number[]): Promise<boolean> {
  const vecStr = `[${embedding.join(',')}]`;

  const candidates = await getDb()
    .select({
      id: entry.id,
      distance: sql<number>`${entry.embedding} <=> ${vecStr}::vector`,
    })
    .from(entry)
    .where(eq(entry.status, 'active'))
    .orderBy(sql`${entry.embedding} <=> ${vecStr}::vector`)
    .limit(CANDIDATE_LIMIT);

  const duplicates = candidates.filter(c => c.distance < DISTANCE_THRESHOLD);

  if (duplicates.length > 0) {
    logger.debug(
      {
        count: duplicates.length,
        closest: duplicates[0]?.id,
        closestDistance: duplicates[0]?.distance,
      },
      'duplicate(s) detected',
    );
  }

  return duplicates.length > 0;
}
