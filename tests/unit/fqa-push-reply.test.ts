import { describe, test, expect } from "bun:test";
import {
  buildPushReply,
  isEnrichmentRequest,
} from "../../src/fqa/push-reply";

describe("buildPushReply — reporter contract", () => {
  test("drops undefined fields", () => {
    const r = buildPushReply({ failureDimension: "fully_false" });
    expect(r.fields).toEqual({ failureDimension: "fully_false" });
  });

  test("rejects partialTruth outside [0,1]", () => {
    expect(() => buildPushReply({ partialTruth: 1.5 })).toThrow(RangeError);
    expect(() => buildPushReply({ partialTruth: -0.1 })).toThrow(RangeError);
  });

  test("rejects counterNliScore outside [0,1]", () => {
    expect(() => buildPushReply({ counterNliScore: 2 })).toThrow(RangeError);
  });

  test("rejects counterSourceUrl over 2000 chars", () => {
    expect(() =>
      buildPushReply({ counterSourceUrl: "x".repeat(2001) }),
    ).toThrow(RangeError);
  });

  test("clips counterClaimText to 2000 chars", () => {
    const text = "x".repeat(2500);
    const r = buildPushReply({ counterClaimText: text });
    expect(r.fields.counterClaimText?.length).toBe(2000);
  });
});

describe("isEnrichmentRequest — type guard", () => {
  test("accepts well-formed request", () => {
    expect(
      isEnrichmentRequest({
        type: "feedback_enrichment_request",
        enrichmentTaskId: "01HX",
        feedbackId: "01HX",
        claimId: "01HX",
        claimText: "x",
        questions: [],
      }),
    ).toBe(true);
  });

  test("rejects wrong type tag", () => {
    expect(
      isEnrichmentRequest({
        type: "something_else",
        enrichmentTaskId: "x",
        feedbackId: "x",
        claimId: "x",
        claimText: "x",
        questions: [],
      }),
    ).toBe(false);
  });

  test("rejects missing fields", () => {
    expect(isEnrichmentRequest({ type: "feedback_enrichment_request" })).toBe(false);
  });

  test("rejects non-object", () => {
    expect(isEnrichmentRequest(null)).toBe(false);
    expect(isEnrichmentRequest("string")).toBe(false);
    expect(isEnrichmentRequest(42)).toBe(false);
  });
});
