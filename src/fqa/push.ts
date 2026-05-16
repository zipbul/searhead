// FQA push channel — direct HTTP POST to the reporter's enrichment
// callback URL. Best-effort, one-shot, deadline-bounded. The pull
// inbox is always the durable channel; push exists to shorten the
// loop for long-lived reporters that advertise themselves reachable.
//
// Contract (the URL the reporter advertised):
//   POST <callback_url>
//   Content-Type: application/json
//   Body: {
//     type: "feedback_enrichment_request",
//     enrichmentTaskId, feedbackId, claimId, claimText,
//     questions: [...], deadline
//   }
//   Expected reply (200 OK, JSON):
//     { fields: { failureDimension?, partialTruth?, counterSourceUrl?,
//                 counterClaimText?, counterNliScore? } }
//   Any non-200 or malformed reply is treated as a refusal.

import { z } from "zod";
import { logger } from "../observability/logger";
import { FAILURE_DIMENSIONS } from "../a2a/handlers/claim-feedback";

const PUSH_DEADLINE_MS = Number(
  process.env.KNOLDR_FQA_PUSH_DEADLINE_MS ?? 60_000,
);

const replySchema = z.object({
  fields: z.object({
    failureDimension: z.enum(FAILURE_DIMENSIONS).optional(),
    partialTruth: z.number().min(0).max(1).optional(),
    counterSourceUrl: z.url().max(2000).optional(),
    counterClaimText: z.string().max(2000).optional(),
    counterNliScore: z.number().min(0).max(1).optional(),
  }),
});

export type PushOutcome =
  | "success"
  | "timeout"
  | "refused"
  | "error"
  | "unreachable";

export interface PushResult {
  outcome: PushOutcome;
  fields: z.infer<typeof replySchema>["fields"] | null;
  errorMessage?: string;
}

export interface PushPayload {
  enrichmentTaskId: string;
  feedbackId: string;
  claimId: string;
  claimText: string;
  questions: Array<{ field: string; prompt: string; enum?: readonly string[]; optional?: boolean }>;
  deadline: string;
}

export async function pushEnrichmentRequest(
  callbackUrl: string,
  payload: PushPayload,
): Promise<PushResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_DEADLINE_MS);

  let res: Response;
  try {
    res = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "feedback_enrichment_request", ...payload }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      return { outcome: "timeout", fields: null, errorMessage: e.message };
    }
    return { outcome: "unreachable", fields: null, errorMessage: e.message };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return {
      outcome: "refused",
      fields: null,
      errorMessage: `status ${res.status}`,
    };
  }

  let parsed: z.infer<typeof replySchema>;
  try {
    const json = (await res.json()) as unknown;
    parsed = replySchema.parse(json);
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, callbackUrl },
      "fqa push received malformed reply",
    );
    return {
      outcome: "error",
      fields: null,
      errorMessage: (err as Error).message,
    };
  }

  return { outcome: "success", fields: parsed.fields };
}
