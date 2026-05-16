// Negation detection.
//
// NLI models routinely flip on negation: "Bun runs on V8" and "Bun
// does not run on V8" should yield mirror entailment distributions
// against a source that disambiguates, but DeBERTa-FEVER often
// scores both around 0.5 because the surface forms share so many
// tokens that the model defaults to "neutral".
//
// Rather than try to fix the model, we tag negated claims and
// apply a conservative damping on the aggregator output: when the
// claim is negated the verdict needs stronger NLI evidence to
// commit. Worst case we leave a true claim as `unverified` instead
// of confidently flipping it to `verified`.

const NEGATION_PATTERNS = [
  // English contractions and explicit negations
  /\b(not|no|never|none|neither|nor|without)\b/i,
  /\b(isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|can't|cannot|couldn't|shouldn't|haven't|hasn't|hadn't)\b/i,
  /\bn[‘']t\b/i,
  // Korean negation forms
  /\b(?:안|못)\s/,
  /(아니다|아닙니다|아니에요|않는다|않습니다|않아|없다|없습니다|없어|없는)/,
  // Japanese / Chinese
  /(ない|ません|なし|无|不|没|沒)/,
];

export function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some(re => re.test(text));
}

/**
 * Damping factor applied to aggregator certainty when the claim is
 * negated. < 1 reduces certainty so a borderline negated claim
 * doesn't get committed; the verify pipeline interprets the lower
 * certainty against its threshold.
 */
export const NEGATION_DAMPING = 0.7;
