import { sql, gt, and, ne, lt } from 'drizzle-orm';
import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { entry, ingestLog } from '../db/schema';
import { logger } from '../observability/logger';
import { IngestAction } from '../score/enums';

const BATCH_SIZE = 100;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const DISTANCE_THRESHOLD = 0.05;

/**
 * Daily batch dedup job.
 *
 * Walks recent (last 7 days) entries in ascending id order, using the
 * previous batch's last id as a keyset cursor for the next batch. This
 * is *required* because the loop deletes rows mid-walk — an OFFSET-
 * based pagination skipped entries whose positional index shifted left
 * when their predecessors were deleted (reproduced: 250 entries → only
 * 200 visited, 50 missed).
 *
 * Keep higher authority; on tie, keep older (smaller ULID). Deletes
 * cascade through FK to related tables.
 */
export async function batchDedup(): Promise<number> {
  const startTime = Date.now();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;
  // Cursor: keep advancing by id > lastId instead of OFFSET so deletes
  // can't shift rows out of future batches.
  let lastId = '';

  logger.info('batch dedup started');

  while (Date.now() - startTime < MAX_DURATION_MS) {
    const recentEntries = await getDb()
      .select({
        id: entry.id,
        createdAt: entry.createdAt,
        authority: entry.authority,
        embedding: entry.embedding,
      })
      .from(entry)
      .where(and(gt(entry.createdAt, sevenDaysAgo), lastId ? gt(entry.id, lastId) : sql`TRUE`))
      .orderBy(entry.id)
      .limit(BATCH_SIZE);

    if (recentEntries.length === 0) {
      break;
    }
    lastId = recentEntries[recentEntries.length - 1]!.id;

    for (const current of recentEntries) {
      if (Date.now() - startTime > MAX_DURATION_MS) {
        break;
      }

      const vecStr = `[${(current.embedding as number[]).join(',')}]`;

      // HNSW-friendly shape: ORDER BY distance LIMIT N. Threshold
      // filter happens in JS so the index doesn't degrade to a Seq
      // Scan on entry-growth.
      const neighborRows = await getDb()
        .select({
          id: entry.id,
          createdAt: entry.createdAt,
          authority: entry.authority,
          distance: sql<number>`${entry.embedding} <=> ${vecStr}::vector`,
        })
        .from(entry)
        .where(and(ne(entry.id, current.id), lt(entry.authority, 2.0)))
        .orderBy(sql`${entry.embedding} <=> ${vecStr}::vector`)
        .limit(5);

      const neighbors = neighborRows.filter(n => n.distance < DISTANCE_THRESHOLD);

      for (const neighbor of neighbors) {
        let deleteId: string;
        let deleteCreatedAt: Date;
        let keepId: string;

        if (neighbor.authority > current.authority) {
          deleteId = current.id;
          deleteCreatedAt = current.createdAt;
          keepId = neighbor.id;
        } else if (neighbor.authority < current.authority) {
          deleteId = neighbor.id;
          deleteCreatedAt = neighbor.createdAt;
          keepId = current.id;
        } else {
          // Same authority → keep older (smaller ULID = earlier timestamp)
          if (current.id < neighbor.id) {
            deleteId = neighbor.id;
            deleteCreatedAt = neighbor.createdAt;
            keepId = current.id;
          } else {
            deleteId = current.id;
            deleteCreatedAt = current.createdAt;
            keepId = neighbor.id;
          }
        }

        await getDb().transaction(async tx => {
          await tx.delete(entry).where(and(sql`${entry.id} = ${deleteId}`, sql`${entry.createdAt} = ${deleteCreatedAt}`));
          await tx.insert(ingestLog).values({
            id: ulid(),
            entryId: deleteId,
            entryCreatedAt: deleteCreatedAt,
            action: IngestAction.Duplicate,
            reason: `batch_dedup: similar_to=${keepId}`,
          });
        });

        totalDeleted++;
        logger.debug({ deleted: deleteId, kept: keepId }, 'batch dedup: removed duplicate');

        if (deleteId === current.id) {
          break;
        }
      }
    }
  }

  logger.info({ totalDeleted, durationMs: Date.now() - startTime }, 'batch dedup completed');
  return totalDeleted;
}
