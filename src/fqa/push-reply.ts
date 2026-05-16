// Push enrichment — reporter-side helper.
//
// Reporter agents that opt into the push channel via
// `enrichmentCallbackUrl` + `callbackCapability` receive a POST to
// that URL when FQA wants to enrich their feedback. The payload is
// defined here; this module exports both the type and a builder for
// well-formed reply bodies so reporter implementations stay in sync
// with what FQA expects.
//
// Reporter contract:
//   - Listen on the URL the reporter advertised in claim_feedback.
//   - When a request body with type='feedback_enrichment_request'
//     arrives, fill any of the structured fields the reporter knows.
//   - Reply 200 OK with JSON shaped by buildPushReply / EnrichmentReply.
//   - Anything else (non-200, malformed JSON, timeout) is treated by
//     FQA as a refusal; the task falls back to the pull inbox.

export interface EnrichmentRequestPayload {
  type: "feedback_enrichment_request";
  enrichmentTaskId: string;
  feedbackId: string;
  claimId: string;
  claimText: string;
  questions: Array<{
    field: string;
    prompt: string;
    enum?: readonly string[];
    optional?: boolean;
  }>;
  deadline: string;
}

export interface EnrichmentReplyFields {
  failureDimension?:
    | "fully_false"
    | "scope_too_broad"
    | "time_expired"
    | "modality_too_strong"
    | "context_mismatch"
    | "partially_correct";
  partialTruth?: number; // 0..1
  counterSourceUrl?: string;
  counterClaimText?: string;
  counterNliScore?: number; // 0..1
}

export interface EnrichmentReply {
  fields: EnrichmentReplyFields;
}

/**
 * Construct a well-formed reply body. Reporter agents call this in
 * their HTTP handler to avoid hand-rolling the JSON shape:
 *
 *   import { buildPushReply } from "knoldr/fqa/push-reply";
 *   const reply = buildPushReply({
 *     failureDimension: "scope_too_broad",
 *     counterSourceUrl: "https://...",
 *   });
 *   return Response.json(reply);
 *
 * Drops any undefined fields and rejects out-of-range numerics so a
 * malformed reporter answer doesn't trip FQA's strict zod validation
 * silently.
 */
export function buildPushReply(fields: EnrichmentReplyFields): EnrichmentReply {
  const clean: EnrichmentReplyFields = {};
  if (fields.failureDimension !== undefined) {
    clean.failureDimension = fields.failureDimension;
  }
  if (fields.partialTruth !== undefined) {
    if (fields.partialTruth < 0 || fields.partialTruth > 1) {
      throw new RangeError("partialTruth must be in [0,1]");
    }
    clean.partialTruth = fields.partialTruth;
  }
  if (fields.counterSourceUrl !== undefined) {
    if (fields.counterSourceUrl.length > 2000) {
      throw new RangeError("counterSourceUrl exceeds 2000 chars");
    }
    clean.counterSourceUrl = fields.counterSourceUrl;
  }
  if (fields.counterClaimText !== undefined) {
    clean.counterClaimText = fields.counterClaimText.slice(0, 2000);
  }
  if (fields.counterNliScore !== undefined) {
    if (fields.counterNliScore < 0 || fields.counterNliScore > 1) {
      throw new RangeError("counterNliScore must be in [0,1]");
    }
    clean.counterNliScore = fields.counterNliScore;
  }
  return { fields: clean };
}

/**
 * Type guard for reporter handlers: confirms the body is a valid
 * enrichment request before processing.
 */
export function isEnrichmentRequest(
  body: unknown,
): body is EnrichmentRequestPayload {
  if (!body || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  return (
    o.type === "feedback_enrichment_request" &&
    typeof o.enrichmentTaskId === "string" &&
    typeof o.feedbackId === "string" &&
    typeof o.claimId === "string" &&
    typeof o.claimText === "string" &&
    Array.isArray(o.questions)
  );
}
