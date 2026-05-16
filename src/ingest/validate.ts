import { z } from 'zod/v4';

import { Signal, SortBy, SourceType, TrustLevel } from '../score/enums';

// -- Source schema (shared)
const sourceSchema = z.object({
  url: z.url(),
  sourceType: z.enum(SourceType),
  trust: z.number().min(0).max(1).optional(),
});

type Source = z.infer<typeof sourceSchema>;

// -- Mode 1: raw input
const rawStoreSchema = z.object({
  raw: z.string().min(1).max(200_000),
  sources: z.array(sourceSchema).max(20).optional(),
});

// -- Mode 2: structured input
const structuredEntrySchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50_000),
  domain: z
    .array(
      z
        .string()
        .max(50)
        .regex(/^[\p{Ll}\p{Lo}\p{N}-]+$/u),
    )
    .min(1)
    .max(5),
  tags: z
    .array(
      z
        .string()
        .max(50)
        .regex(/^[\p{Ll}\p{Lo}\p{N}-]+$/u),
    )
    .max(20)
    .optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  decayRate: z.number().min(0.0001).max(0.1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type StructuredEntry = z.infer<typeof structuredEntrySchema>;

const structuredStoreSchema = z.object({
  entries: z.array(structuredEntrySchema).min(1).max(20),
  sources: z.array(sourceSchema).max(20).optional(),
});

// -- Discriminated store input: raw XOR entries, never both
type StoreInput = z.infer<typeof rawStoreSchema> | z.infer<typeof structuredStoreSchema>;

function parseStoreInput(input: unknown): StoreInput {
  const obj = input as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Store input must be an object.');
  }

  const hasRaw = 'raw' in obj;
  const hasEntries = 'entries' in obj;

  if (hasRaw && hasEntries) {
    throw new Error("Cannot have both 'raw' and 'entries'. Use one mode only.");
  }
  if (!hasRaw && !hasEntries) {
    throw new Error("Must provide either 'raw' (Mode 1) or 'entries' (Mode 2).");
  }

  if (hasRaw) {
    return rawStoreSchema.parse(input);
  }
  return structuredStoreSchema.parse(input);
}

function isRawInput(input: StoreInput): input is z.infer<typeof rawStoreSchema> {
  return 'raw' in input;
}

// -- Query input
const queryInputSchema = z.object({
  query: z.string().min(1).max(1000),
  domain: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  minAuthority: z.number().min(0).max(1).optional(),
  minTrustLevel: z.enum(TrustLevel).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

type QueryInput = z.infer<typeof queryInputSchema>;

// -- Explore input
const exploreInputSchema = z.object({
  domain: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  minAuthority: z.number().min(0).max(1).optional(),
  minTrustLevel: z.enum(TrustLevel).optional(),
  sortBy: z.enum(SortBy).default(SortBy.Authority),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

type ExploreInput = z.infer<typeof exploreInputSchema>;

// -- Feedback input
const feedbackInputSchema = z.object({
  entryId: z.string().min(1),
  signal: z.enum(Signal),
  reason: z.string().max(1000).optional(),
  agentId: z.string().min(1),
});

// -- Audit input
const auditInputSchema = z.object({
  domain: z.string().max(50).optional(),
});

// -- LLM decompose response validation
const decomposeResponseSchema = z.object({
  entries: z
    .array(
      z.object({
        title: z.string().max(500),
        content: z.string().max(50_000),
        domain: z
          .array(
            z
              .string()
              .max(50)
              .regex(/^[\p{Ll}\p{Lo}\p{N}-]+$/u),
          )
          .min(1)
          .max(5),
        tags: z
          .array(
            z
              .string()
              .max(50)
              .regex(/^[\p{Ll}\p{Lo}\p{N}-]+$/u),
          )
          .max(20)
          .default([]),
        language: z.string().regex(/^[a-z]{2}$/),
        decayRate: z.number().min(0.0001).max(0.1),
      }),
    )
    .min(1)
    .max(20),
});

type DecomposeResponse = z.infer<typeof decomposeResponseSchema>;

// -- HTML tag stripping utility
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

export {
  parseStoreInput,
  isRawInput,
  queryInputSchema,
  exploreInputSchema,
  feedbackInputSchema,
  auditInputSchema,
  decomposeResponseSchema,
  stripHtml,
};
export type { Source, StructuredEntry, StoreInput, QueryInput, ExploreInput, DecomposeResponse };
