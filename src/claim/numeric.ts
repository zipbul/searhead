// Numeric exact matching for claim verification.
//
// NLI is notoriously weak on quantitative differences. "MiniCheck is
// a 770M parameter model" against a passage saying "Bespoke-MiniCheck
// is a 7B model" gets entailment ~0.6 because the claim is *roughly*
// about the same family — but the actual numbers contradict, and a
// human reader would call this disputed without hesitation.
//
// We extract typed numeric tokens (year / version / percentage /
// scale / money) from both the claim and the source chunk and
// flag mismatches as a strong contradiction override that bypasses
// NLI entirely.

interface NumericFact {
  kind: 'year' | 'version' | 'percentage' | 'scale' | 'money' | 'count';
  value: string; // canonical form for comparison
  raw: string; // original surface form
}

const PATTERNS: Array<{ kind: NumericFact['kind']; re: RegExp; canon: (m: RegExpMatchArray) => string }> = [
  { kind: 'year', re: /\b(19\d{2}|20\d{2}|21\d{2})\b/g, canon: m => m[0]! },
  { kind: 'version', re: /\bv?(\d+\.\d+(?:\.\d+)?)\b/g, canon: m => m[1]! },
  { kind: 'percentage', re: /\b(\d+(?:\.\d+)?)\s?%/g, canon: m => `${m[1]}%` },
  // Scale matters for the MiniCheck-style false positive: 770M ≠ 7B
  { kind: 'scale', re: /\b(\d+(?:\.\d+)?)\s?([KMBkmb])\b/g, canon: m => `${m[1]}${m[2]!.toUpperCase()}` },
  { kind: 'money', re: /[$€£¥₩](\d+(?:[,.]\d+)*(?:\s?[KMB])?)/g, canon: m => m[0]! },
];

function extractNumericFacts(text: string): NumericFact[] {
  const out: NumericFact[] = [];
  for (const p of PATTERNS) {
    const matches = text.matchAll(p.re);
    for (const m of matches) {
      out.push({ kind: p.kind, value: p.canon(m), raw: m[0]! });
    }
  }
  return out;
}

/**
 * Returns true when the claim asserts a numeric fact that the
 * source contradicts: same kind appears in both, but with a
 * different canonical value.
 *
 * Conservative: requires *every* claim numeric to be either matched
 * or absent in the source. A claim with a year that the source
 * never mentions is fine; only a year-vs-different-year clash
 * triggers the override.
 */
export function numericContradicts(claim: string, source: string): boolean {
  const claimFacts = extractNumericFacts(claim);
  if (claimFacts.length === 0) {
    return false;
  }
  const sourceFacts = extractNumericFacts(source);
  if (sourceFacts.length === 0) {
    return false;
  }

  for (const cf of claimFacts) {
    const sameKindInSource = sourceFacts.filter(sf => sf.kind === cf.kind);
    if (sameKindInSource.length === 0) {
      continue;
    }
    const matches = sameKindInSource.some(sf => sf.value === cf.value);
    if (!matches) {
      return true;
    }
  }
  return false;
}
