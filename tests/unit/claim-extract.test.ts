import { describe, test, expect, beforeAll } from 'bun:test';

import { extractClaims, gateBySourceEntailment } from '../../src/claim/extract';
import { ClaimType, Modality, Quantifier, enumValues } from '../../src/score/enums';

// Both LLM CLIs are forced to fail so extractClaims falls through to
// returning []. The LLM-bound success path is exercised by integration
// tests; unit tests verify the contract around failure.
beforeAll(() => {
  process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
  process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '200';
});

describe('extractClaims — LLM unavailable', () => {
  test('returns empty array when both CLIs fail', async () => {
    const result = await extractClaims('Title', 'Some content about Bun.');
    expect(result).toEqual([]);
  });

  test('does not throw on empty inputs', async () => {
    const result = await extractClaims('', '');
    expect(result).toEqual([]);
  });
});

describe('ClaimType invariants', () => {
  test('covers the four DESIGN.md v0.3 epistemic categories', () => {
    expect(enumValues(ClaimType)).toEqual([ClaimType.Factual, ClaimType.Subjective, ClaimType.Predictive, ClaimType.Normative]);
  });

  test('modality enum covers v0.4 distortion categories', () => {
    expect(enumValues(Modality)).toEqual([
      Modality.Asserted,
      Modality.Hedged,
      Modality.Possible,
      Modality.Conditional,
      Modality.Quoted,
    ]);
  });

  test('quantifier enum covers v0.4 scope categories', () => {
    expect(enumValues(Quantifier)).toEqual([
      Quantifier.Universal,
      Quantifier.Existential,
      Quantifier.Majority,
      Quantifier.Minority,
      Quantifier.Specific,
      Quantifier.None,
    ]);
  });
});

describe('gateBySourceEntailment — boundary behavior', () => {
  test('returns empty array on empty input without invoking NLI', async () => {
    const result = await gateBySourceEntailment([]);
    expect(result).toEqual([]);
  });

  test('drops claim whose quote is missing', async () => {
    const result = await gateBySourceEntailment([{ statement: 'Bun is fast', type: ClaimType.Factual }]);
    expect(result).toEqual([]);
  });

  test('drops claim whose quote is an empty / whitespace string', async () => {
    const result = await gateBySourceEntailment([{ statement: 'Bun is fast', type: ClaimType.Factual, quote: '   ' }]);
    expect(result).toEqual([]);
  });
});
