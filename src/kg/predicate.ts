// Canonical KG predicate vocabulary. The LLM that extracts triples
// produces noisy verb phrases ("runs on", "is powered by", "built
// upon") that all describe the same relation but mismatch in the KG
// contradiction lookup if stored verbatim. We normalize to a small,
// stable set of canonical predicates so contradiction queries can use
// equality rather than fuzzy matching.
//
// Synonyms are looked up first; anything not in the table falls
// through as itself (lowercased, snake_cased) so genuinely new
// predicates aren't lost.

const SYNONYMS: Record<string, string> = {
  // identity / typing
  is: 'is_a',
  is_an: 'is_a',
  is_a_kind_of: 'is_a',
  type_of: 'is_a',
  instance_of: 'is_a',

  // composition / engine
  runs_on: 'runs_on',
  uses: 'runs_on',
  powered_by: 'runs_on',
  is_powered_by: 'runs_on',
  built_on: 'runs_on',
  is_built_on: 'runs_on',
  built_upon: 'runs_on',
  built_with: 'runs_on',
  based_on: 'runs_on',
  is_based_on: 'runs_on',
  underlying_engine: 'runs_on',

  // creation / authorship
  created_by: 'created_by',
  authored_by: 'created_by',
  developed_by: 'created_by',
  written_by: 'created_by',
  invented_by: 'created_by',
  founded_by: 'created_by',
  is_developed_by: 'created_by',

  // ownership
  owned_by: 'owned_by',
  is_owned_by: 'owned_by',
  belongs_to: 'owned_by',

  // location
  located_in: 'located_in',
  is_located_in: 'located_in',
  is_in: 'located_in',
  found_in: 'located_in',
  capital_of: 'capital_of',
  is_capital_of: 'capital_of',

  // time
  released_at: 'released_at',
  released_on: 'released_at',
  released_in: 'released_at',
  launched_in: 'released_at',
  launched_on: 'released_at',
  first_released: 'released_at',

  // version / supersession
  supersedes: 'supersedes',
  replaces: 'supersedes',
  is_successor_of: 'supersedes',
  succeeds: 'supersedes',

  // dependency / impact
  affects: 'affects',
  impacts: 'affects',
  depends_on: 'depends_on',
  requires: 'depends_on',

  // multi-value (kept distinct, never funneled to functional preds)
  supports: 'supports',
  contains: 'contains',
  includes: 'contains',
  has: 'contains',
};

/**
 * Lowercase, normalize whitespace/separators to underscores, then
 * map through the synonym table. Returns the canonical predicate.
 */
export function normalizePredicate(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return SYNONYMS[slug] ?? slug;
}
