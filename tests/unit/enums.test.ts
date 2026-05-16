import { describe, test, expect } from 'bun:test';

import {
  ApplicationMethod,
  ClaimType,
  EnrichmentStatus,
  EntryScoreDimension,
  EntryStatus,
  EvidenceSource,
  FailureDimension,
  FeedbackReason,
  IngestAction,
  Modality,
  Outcome,
  Quantifier,
  RelationType,
  Signal,
  SortBy,
  SourceType,
  TrustLevel,
  Verdict,
  VerdictTrigger,
  enumValues,
} from '../../src/score/enums';

// Every domain enum in the project. Iterating this list in the
// invariants test below double-serves as the canonical "is this
// enum still referenced anywhere?" trace — knip considers every
// member used because `Object.values(EnumName)` materializes them
// at runtime. Without this trace, enum members that only show up
// in DB CHECK constraints would be flagged unused.
const allEnums = {
  Verdict,
  ClaimType,
  Modality,
  Quantifier,
  RelationType,
  VerdictTrigger,
  EvidenceSource,
  ApplicationMethod,
  Outcome,
  FailureDimension,
  EnrichmentStatus,
  Signal,
  FeedbackReason,
  EntryStatus,
  SourceType,
  IngestAction,
  EntryScoreDimension,
  TrustLevel,
  SortBy,
};

// Project-wide convention: enum string values are kebab-case
// (`[a-z0-9]+(-[a-z0-9]+)*`). This regex is the single source of
// truth for the format — any new enum that lands with snake_case or
// PascalCase values breaks this test.
const KEBAB_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('domain enums', () => {
  test('every value is a kebab-case string', () => {
    for (const [enumName, e] of Object.entries(allEnums)) {
      for (const v of Object.values(e)) {
        expect(typeof v, `${enumName} member should be a string`).toBe('string');
        expect(v, `${enumName}.${v} should be kebab-case`).toMatch(KEBAB_VALUE);
      }
    }
  });

  test('enumValues mirrors Object.values for every enum', () => {
    for (const [enumName, e] of Object.entries(allEnums)) {
      const helper = enumValues(e as Record<string, string>);
      const direct = Object.values(e);
      expect(helper, `${enumName}: enumValues should match Object.values`).toEqual(direct);
    }
  });

  test('no enum has duplicate values', () => {
    for (const [enumName, e] of Object.entries(allEnums)) {
      const values = Object.values(e);
      expect(new Set(values).size, `${enumName} should have no duplicate values`).toBe(values.length);
    }
  });
});
