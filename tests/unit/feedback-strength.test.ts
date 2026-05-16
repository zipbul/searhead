import { describe, test, expect } from 'bun:test';

import { computeFeedbackEvidenceStrength } from '../../src/score/feedback-strength';

describe('computeFeedbackEvidenceStrength — direct vs inferred weighting', () => {
  test('empty row sits at base 0.1', () => {
    expect(computeFeedbackEvidenceStrength({})).toBe(0.1);
  });

  test('direct URL beats inferred URL on the same field', () => {
    const direct = computeFeedbackEvidenceStrength({ counterSourceUrl: 'https://x' });
    const inferred = computeFeedbackEvidenceStrength({ counterSourceUrlInferred: 'https://x' });
    expect(direct).toBeGreaterThan(inferred);
  });

  test('direct mask: both direct and inferred only earns the direct credit', () => {
    const both = computeFeedbackEvidenceStrength({
      counterSourceUrl: 'https://x',
      counterSourceUrlInferred: 'https://y',
    });
    const directOnly = computeFeedbackEvidenceStrength({ counterSourceUrl: 'https://x' });
    expect(both).toBe(directOnly);
  });

  test('low counter_nli_score contributes nothing', () => {
    expect(computeFeedbackEvidenceStrength({ counterNliScore: 0.4 })).toBe(0.1);
  });

  test('high counter_nli_score contributes 0.2', () => {
    expect(computeFeedbackEvidenceStrength({ counterNliScore: 0.8 })).toBeCloseTo(0.3, 3);
  });

  test('clamps to <= 1 when every weight stacks', () => {
    const score = computeFeedbackEvidenceStrength({
      counterSourceUrl: 'https://x',
      counterNliScore: 0.95,
      failureDimension: 'scope-too-broad',
      contextDomain: 'security',
      partialTruth: 0.5,
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.8);
  });
});
