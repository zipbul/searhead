import { describe, test, expect, beforeAll } from "bun:test";
import {
  extractClaims,
  gateBySourceEntailment,
  CLAIM_TYPES,
  MODALITY_VALUES,
  QUANTIFIER_VALUES,
} from "../../src/claim/extract";

// Both LLM CLIs are forced to fail so extractClaims falls through to
// returning []. The LLM-bound success path is exercised by integration
// tests; unit tests verify the contract around failure.
beforeAll(() => {
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";
  process.env.KNOLDR_OLLAMA_TIMEOUT_MS = "200";
});

describe("extractClaims — LLM unavailable", () => {
  test("returns empty array when both CLIs fail", async () => {
    const result = await extractClaims("Title", "Some content about Bun.");
    expect(result).toEqual([]);
  });

  test("does not throw on empty inputs", async () => {
    const result = await extractClaims("", "");
    expect(result).toEqual([]);
  });
});

describe("CLAIM_TYPES invariants", () => {
  test("covers the four DESIGN.md v0.3 epistemic categories", () => {
    expect(CLAIM_TYPES).toEqual(["factual", "subjective", "predictive", "normative"]);
  });

  test("modality enum covers v0.4 distortion categories", () => {
    expect(MODALITY_VALUES).toEqual([
      "asserted",
      "hedged",
      "possible",
      "conditional",
      "quoted",
    ]);
  });

  test("quantifier enum covers v0.4 scope categories", () => {
    expect(QUANTIFIER_VALUES).toEqual([
      "universal",
      "existential",
      "majority",
      "minority",
      "specific",
      "none",
    ]);
  });
});

describe("gateBySourceEntailment — boundary behavior", () => {
  test("returns empty array on empty input without invoking NLI", async () => {
    const result = await gateBySourceEntailment([]);
    expect(result).toEqual([]);
  });

  test("drops claim whose quote is missing", async () => {
    const result = await gateBySourceEntailment([
      { statement: "Bun is fast", type: "factual" },
    ]);
    expect(result).toEqual([]);
  });

  test("drops claim whose quote is an empty / whitespace string", async () => {
    const result = await gateBySourceEntailment([
      { statement: "Bun is fast", type: "factual", quote: "   " },
    ]);
    expect(result).toEqual([]);
  });
});
