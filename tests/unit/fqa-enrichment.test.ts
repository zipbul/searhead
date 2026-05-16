import { describe, test, expect } from 'bun:test';

import { recomputeEvidenceStrength } from '../../src/fqa/enrichment-llm';

describe('recomputeEvidenceStrength — direct vs inferred weighting', () => {
  test('bare minimum row sits near base', () => {
    expect(recomputeEvidenceStrength({})).toBe(0.1);
  });

  test('direct counterSourceUrl moves strength more than inferred', () => {
    const direct = recomputeEvidenceStrength({ counterSourceUrl: 'https://x' });
    const inferred = recomputeEvidenceStrength({ counterSourceUrlInferred: 'https://x' });
    expect(direct).toBeGreaterThan(inferred);
  });

  test('direct value masks inferred value for the same field', () => {
    const both = recomputeEvidenceStrength({
      counterSourceUrl: 'https://x',
      counterSourceUrlInferred: 'https://x',
    });
    const directOnly = recomputeEvidenceStrength({ counterSourceUrl: 'https://x' });
    expect(both).toBe(directOnly);
  });

  test('clamps at 1.0 even when every signal is stacked', () => {
    const score = recomputeEvidenceStrength({
      counterSourceUrl: 'https://x',
      counterNliScore: 0.9,
      failureDimension: 'scope-too-broad',
      contextDomain: 'security',
      partialTruth: 0.3,
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.8);
  });

  test('low counter_nli_score does not contribute', () => {
    const low = recomputeEvidenceStrength({ counterNliScore: 0.4 });
    const none = recomputeEvidenceStrength({});
    expect(low).toBe(none);
  });
});
