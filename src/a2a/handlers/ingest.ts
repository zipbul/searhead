// ingest A2A skill — direct external entry point into the storage
// engine. FUTURE.md #1 (multimodal) MVP: Knoldr stays text-centric;
// the *agent* owns format conversion (PDF parser, OCR, ASR, local
// file reader). Once the agent has plain text, it submits via this
// skill and the existing decompose → embed → claim-extract → verify
// pipeline runs uniformly.
//
// Two modes mirror the internal ingest() contract:
//
//   Mode 1 — raw text:
//     { raw: "...text...", sources?: [...] }
//   The LLM decomposer splits long blobs into atomic entries
//   (multiple chunks per submit). Use this when you have unstructured
//   document text.
//
//   Mode 2 — pre-structured entries:
//     { entries: [{ title, content, domain, tags?, language? }], sources?: [...] }
//   Use this when the agent has already classified and titled the
//   material — skips the LLM decompose step.
//
// Returns one IngestResult per produced entry: stored / duplicate /
// rejected, with reason. Duplicates short-circuit early so re-
// submitting the same content is cheap.

import { z } from 'zod';

import type { IngestResult } from '../../ingest/engine';

import { ingest } from '../../ingest/engine';
import { parseStoreInput } from '../../ingest/validate';
import { logger } from '../../observability/logger';

// Top-level zod gate just to bound the JSON payload size at the A2A
// boundary; parseStoreInput re-validates with the precise discriminated
// schema. Validating twice is intentional — the outer cap fails fast on
// 50MB blobs without bringing the full engine schema into agent-facing
// error surface.
const envelopeSchema = z
  .object({
    raw: z.string().max(200_000).optional(),
    entries: z.array(z.unknown()).max(20).optional(),
    sources: z.array(z.unknown()).max(20).optional(),
  })
  .refine(v => v.raw !== undefined || v.entries !== undefined, {
    message: "ingest requires either 'raw' or 'entries'",
  });

type IngestSkillResult =
  | { ok: true; results: IngestResult[]; storedCount: number; duplicateCount: number; rejectedCount: number }
  | { ok: false; error: 'invalid_input' | 'engine_error'; message: string };

export async function handleIngest(input: Record<string, unknown>): Promise<IngestSkillResult> {
  try {
    envelopeSchema.parse(input);
  } catch (err) {
    return { ok: false, error: 'invalid_input', message: (err as Error).message };
  }

  let parsed: ReturnType<typeof parseStoreInput>;
  try {
    parsed = parseStoreInput(input);
  } catch (err) {
    return { ok: false, error: 'invalid_input', message: (err as Error).message };
  }

  let results: IngestResult[];
  try {
    results = await ingest(parsed);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'ingest skill engine failure');
    return {
      ok: false,
      error: 'engine_error',
      message: (err as Error).message,
    };
  }

  const storedCount = results.filter(r => r.action === 'stored').length;
  const duplicateCount = results.filter(r => r.action === 'duplicate').length;
  const rejectedCount = results.filter(r => r.action === 'rejected').length;

  logger.info(
    {
      total: results.length,
      stored: storedCount,
      duplicate: duplicateCount,
      rejected: rejectedCount,
    },
    'ingest skill completed',
  );

  return {
    ok: true,
    results,
    storedCount,
    duplicateCount,
    rejectedCount,
  };
}
