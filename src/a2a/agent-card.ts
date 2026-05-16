import type { AgentCard } from '@a2a-js/sdk';

import pkg from '../../package.json' with { type: 'json' };

export const agentCard: AgentCard = {
  protocolVersion: '0.3.0',
  name: 'knoldr',
  description:
    'AI-native universal data platform. Searches stored knowledge and auto-collects from the web when results are insufficient. All skills accept JSON input via parts[0].data = { skill, input }.',
  url: `http://${process.env.KNOLDR_HOST ?? '0.0.0.0'}:${process.env.KNOLDR_PORT ?? '5100'}`,
  version: pkg.version,
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'find',
      name: 'Find',
      tags: ['search', 'query', 'research', 'retrieve', 'explore'],
      description: `Search stored knowledge. If results are insufficient, automatically crawls the web to collect new data, then re-searches.

Input: {
  query?: string,          // keyword search (omit for filter-only browsing)
  topic?: string,          // alias for query
  domain?: string,         // filter by domain
  tags?: string[],         // filter by tags
  language?: string,       // ISO 639-1 code
  minAuthority?: number,   // 0-1
  minTrustLevel?: "high"|"medium"|"low",
  limit?: number,          // default 10, max 50
  cursor?: string          // pagination
}

Output: {
  entries: [{ id, title, content, domains, tags, sources, authority, claims?, factuality? }],
  scores: [{ relevance, authority, freshness, final }],
  trustLevels: ["high"|"medium"|"low"],
  nextCursor?: string,
  // Verified-fact surface — atomic claims + 1-hop graph context.
  // Empty when no verified claims exist for the result set. Each
  // bundle includes the verbatim source span, modality / polarity /
  // quantifier / time-validity, and four edge lists drawn from the
  // claim_relation graph.
  factBundles: [{
    id, entryId, statement, type, verdict, certainty,
    sourceSpan, sourceUrl, modality, polarity, quantifier,
    validFrom, validUntil,
    supports:     [{ claimId, statement, verdict, certainty }],
    contradicts:  [{ claimId, statement, verdict, certainty }],
    derivesFrom:  [{ claimId, statement, verdict, certainty }],
    supersededBy: [{ claimId, statement, verdict, certainty }],
    refines:      [{ claimId, statement, verdict, certainty }]
  }],
  researched: boolean,
  research?: { urlsCrawled, entriesStored }
}`,
      examples: [
        '{ "skill": "find", "input": { "query": "Bun performance benchmarks" } }',
        '{ "skill": "find", "input": { "query": "xz-utils vulnerability", "domain": "security", "minTrustLevel": "medium" } }',
        '{ "skill": "find", "input": { "domain": "javascript", "limit": 10 } }',
      ],
    },
    {
      id: 'feedback',
      name: 'Feedback',
      tags: ['feedback', 'rating', 'authority', 'rerank'],
      description: `Record a positive or negative signal against a stored entry. Atomically adjusts the entry's authority score so future \`find\` rankings reflect usage quality.

Input: {
  entryId: string,            // entry.id returned from find
  signal: "positive"|"negative",
  reason?: string,            // freeform, max 1000 chars
  agentId: string             // stable identifier for the caller
}

Rate limits:
  - 1 feedback per (agentId, entryId) per hour
  - 10 feedbacks per entry per hour (any agent)

Output:
  { ok: true,  entryId, newAuthority }
  { ok: false, error: "rate_limited"|"not_found"|"invalid_input", message }`,
      examples: [
        '{ "skill": "feedback", "input": { "entryId": "01HX...", "signal": "positive", "agentId": "agent-42" } }',
        '{ "skill": "feedback", "input": { "entryId": "01HX...", "signal": "negative", "reason": "outdated", "agentId": "agent-42" } }',
      ],
    },
    {
      id: 'claim_feedback',
      name: 'Claim Feedback',
      tags: ['feedback', 'claim', 'verification', 'fact-quality'],
      description: `Record claim-level structured feedback. Distinct from the entry-level \`feedback\` skill: this one targets a specific atomic claim and captures HOW the claim was applied, the OUTCOME, and WHICH dimension failed if it did. The reporter agent supplies its own ID; a feedback_authority score is maintained per reporter and weights how much future submissions can move claim certainty.

Input: {
  claimId: string,                  // claim.id (ULID) returned from find
  reporterAgentId: string,          // stable agent identifier
  applicationMethod: "verified"|"applied"|"cited"|"reasoned-over",
  outcome: "held"|"failed"|"partial",

  // Failure detail (required when outcome is failed/partial, prohibited when held)
  failureDimension?: "fully-false"|"scope-too-broad"|"time-expired"
                    |"modality-too-strong"|"context-mismatch"|"partially-correct",
  partialTruth?: number,            // 0-1 estimate of how much is true

  // Context the claim was applied in
  contextDomain?: string,
  contextTimeFrom?: string,         // ISO datetime
  contextTimeUntil?: string,
  contextScope?: object,            // arbitrary key-value scope tags

  // Counter-evidence (strongly raises evidence_strength)
  counterSourceUrl?: string,
  counterClaimText?: string,
  counterNliScore?: number,         // 0-1

  auditNote?: string                // free-form, <= 4000 chars; for audit only
}

Output:
  { ok: true,  feedbackId, claimId, evidenceStrength, reporterFeedbackAuthority, enrichmentStatus }
  { ok: false, error: "invalid_input"|"claim_not_found", message, missingRequired? }

Update mode: pass an existing \`feedbackId\` to merge new fields into
the same row instead of creating a duplicate. Only fields currently
NULL in the row are filled; previously-set direct values are preserved
to prevent reporters from overwriting their own past submissions.
reporterAgentId on update must match the row's original reporter.

Notes:
- enrichmentStatus = 'not_needed' (held or already strong), 'pending'
  (awaiting background LLM enrichment of audit_note), or
  'awaiting-pull' (background worker decided the claim is worth more
  detail — call this skill again with the same feedbackId once you
  have more info).
- A background worker LLM-infers missing structured fields from the
  audit_note. Reporters that want to add evidence later re-submit via
  the same skill with feedbackId set; there is no push channel.
- evidenceStrength × reporterFeedbackAuthority is the effective weight
  this feedback carries when claim authority is later reconsidered.`,
      examples: [
        '{ "skill": "claim_feedback", "input": { "claimId": "01HX...", "reporterAgentId": "agent-42", "applicationMethod": "applied", "outcome": "failed", "failureDimension": "scope-too-broad", "partialTruth": 0.3, "counterSourceUrl": "https://example.com/bench", "counterNliScore": 0.82 } }',
        '{ "skill": "claim_feedback", "input": { "claimId": "01HX...", "reporterAgentId": "agent-42", "applicationMethod": "verified", "outcome": "held" } }',
      ],
    },
    {
      id: 'neighbors',
      name: 'Entity Neighbors',
      tags: ['kg', 'graph', 'entity'],
      description: `Walk the entity KG from a root entity. Returns connected entities up to \`hops\` away, each tagged with its shortest distance and the relation labels on the path.

Input:  { entity: string, entityType?: string, relationType?: string, hops?: number (1-4, default 1), limit?: number (default 50) }
Output: { ok, root: { id, name, type }, neighbors: [{ id, name, type, distance, viaRelations[] }] }
        | { ok: false, error: "invalid_input"|"entity_not_found"|"ambiguous_entity", message, candidates? }

entity may be either a ULID (entity.id) or a human name (case-insensitive match).
The (type, lower(name)) unique key allows the same name across types — when a
name resolves to multiple entities the call returns ambiguous_entity with the
list of candidates so the caller can re-issue with entityType set.`,
      examples: [
        '{ "skill": "neighbors", "input": { "entity": "Bun", "hops": 2 } }',
        '{ "skill": "neighbors", "input": { "entity": "xz-utils", "relationType": "affects", "hops": 1, "limit": 20 } }',
      ],
    },
    {
      id: 'provenance',
      name: 'Claim Provenance',
      tags: ['kg', 'graph', 'claim', 'provenance'],
      description: `Walk the \`derives_from\` chain from a claim back to its supporting ancestors. Each ancestor carries its statement, verdict, certainty, and source URL.

Input:  { claimId: string, maxDepth?: number (1-8, default 4) }
Output: { ok, rootClaimId, ancestors: [{ claimId, statement, verdict, certainty, sourceUrl, depth }] }
        | { ok: false, error: "invalid_input"|"claim_not_found", message }`,
      examples: ['{ "skill": "provenance", "input": { "claimId": "01HX..." } }'],
    },
    {
      id: 'ingest',
      name: 'Ingest',
      tags: ['ingest', 'submit', 'multimodal', 'write'],
      description: `Submit pre-extracted text into Knoldr. Multimodal entry point: the agent owns format conversion (PDF parsing, OCR, ASR, local file read) and then hands plain text to Knoldr. Two modes:

Mode 1 — raw text (unstructured):
  Input:  { raw: string (<=200000 chars), sources?: [{ url, sourceType, trust? }] }
  Knoldr's LLM decomposer splits the raw blob into atomic entries automatically.

Mode 2 — pre-structured entries:
  Input:  {
    entries: [{ title, content, domain: string[], tags?: string[], language?: string }],
    sources?: [...]
  }
  Skips decompose; ideal when the caller has already classified material.

Source schema:
  { url, sourceType: "official-docs"|"github-release"|"cve-db"|"official-blog"|
                    "research-paper"|"established-blog"|"community-forum"|
                    "personal-blog"|"ai-generated"|"reference-wiki"|"unknown",
    trust?: 0-1 }

Output:
  { ok: true, results: [{ entryId, authority, decayRate, action, reason? }],
    storedCount, duplicateCount, rejectedCount }
  | { ok: false, error: "invalid_input"|"engine_error", message }

Notes:
  - Duplicates are detected by URL hash + embedding similarity; resubmitting is cheap.
  - Stored entries flow through claim extraction (with source-entailment NLI gate)
    and verification automatically — no separate trigger needed.
  - Rejected rows include a reason (e.g. decompose_failed, embedding_failed,
    low_quality_content).`,
      examples: [
        '{ "skill": "ingest", "input": { "raw": "GPT-4 was released in March 2023...", "sources": [{ "url": "https://openai.com/blog/gpt-4", "sourceType": "official-blog" }] } }',
        '{ "skill": "ingest", "input": { "entries": [{ "title": "xz-utils backdoor", "content": "A backdoor was discovered...", "domain": ["security"], "tags": ["cve", "supply-chain"] }] } }',
      ],
    },
    {
      id: 'contradictions',
      name: 'Surface Contradictions',
      tags: ['kg', 'graph', 'claim', 'dispute'],
      description: `Surface CONTRADICTS edges for either a specific claim or an entity-shaped area of the graph. Always returns claim PAIRS so the agent sees both sides of the dispute.

Input: { claimId?: string, entity?: string, limit?: number }   // one of claimId/entity required
Output: { ok, pairs: [{ fromClaimId, fromStatement, fromVerdict, fromCertainty,
                        toClaimId, toStatement, toVerdict, toCertainty, weight }] }
        | { ok: false, error: "invalid_input", message }`,
      examples: [
        '{ "skill": "contradictions", "input": { "claimId": "01HX..." } }',
        '{ "skill": "contradictions", "input": { "entity": "xz-utils", "limit": 10 } }',
      ],
    },
  ],
};
