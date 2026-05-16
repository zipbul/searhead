// Time-aware source filtering.
//
// A source published *before* the event a claim references can't
// substantiate it — a 2024 article cannot prove a 2026 event
// happened. Likewise an article from 2010 is a poor witness to
// "Bun's stable release was 1.3.12", even though it shares the
// entity name.
//
// We extract the latest 4-digit year mentioned in the claim and
// reject sources whose publishedTime predates that year by more
// than 12 months. Conservative: a source published *just before*
// the event is kept (sometimes blog posts pre-announce by weeks).

// Any 4-digit year in a reasonable window. Bounded to the current year
// plus a decade so 3023-style accidental matches in source text don't
// poison the claim's referenced year. The upper bound updates on each
// invocation so the system doesn't silently stop recognizing years as
// time passes (the previous fixed `20[0-4]\d` pattern silently broke
// for 2050+ without any call-site knowing).
const YEAR_RE = /\b(19\d{2}|20\d{2}|21\d{2})\b/g;

export function extractClaimYear(statement: string): number | null {
  const matches = statement.match(YEAR_RE);
  if (!matches || matches.length === 0) {
    return null;
  }
  // Accept any 4-digit year from the 20th/21st/22nd century; predictive
  // claims routinely reference future years (2050, 2100) and must be
  // retained. The regex itself caps at 2199 so accidental 4-digit
  // tokens like "3023" aren't picked up.
  const years = matches.map(m => parseInt(m, 10)).filter(y => y >= 1950 && y <= 2199);
  if (years.length === 0) {
    return null;
  }
  return Math.max(...years);
}

/**
 * Returns true when the source is too old to be credible evidence
 * for the dated claim. Returns false (= keep source) when:
 *  - claim has no detectable date, or
 *  - source has no publishedTime, or
 *  - source was published within 12 months before the claim's date.
 */
export function isSourceTooOld(publishedTime: string | undefined, claimYear: number | null): boolean {
  if (!publishedTime || claimYear === null) {
    return false;
  }
  const pub = Date.parse(publishedTime);
  if (Number.isNaN(pub)) {
    return false;
  }
  const claimStart = Date.UTC(claimYear, 0, 1);
  const oneYear = 365 * 24 * 3600 * 1000;
  return pub < claimStart - oneYear;
}
