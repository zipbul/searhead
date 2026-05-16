// Multi-source independence detection.
//
// Five sources all supporting a claim look strong, but if they're
// five reposts of the same Reuters wire story they're really one
// source — N copies do not count as N independent corroborations.
// We deduplicate at three layers:
//
// 1. Domain — different reg-domain, different publisher (already
//    enforced when web-search assembles candidates).
// 2. Title — different titles after normalization (catches Medium
//    cross-posts of the exact same article).
// 3. Content simhash — same body text under different titles
//    (catches AP/Reuters wires republished with a fresh headline).

const SHINGLE_LEN = 8;
const HASH_BITS = 64;

interface SourceFingerprint {
  url: string;
  domain: string;
  titleNorm: string;
  simhash: bigint;
}

function fingerprint(url: string, title: string, text: string): SourceFingerprint {
  let domain = '';
  try {
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    /* malformed URL */
  }
  return {
    url,
    domain,
    titleNorm: normalize(title),
    simhash: simhash(text.slice(0, 8000)),
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * 64-bit simhash over word shingles. Cheap, stable across whitespace,
 * good enough to flag obvious wire-story duplicates.
 */
function simhash(text: string): bigint {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < SHINGLE_LEN) {
    return 0n;
  }
  const counts = new Array<number>(HASH_BITS).fill(0);
  for (let i = 0; i <= tokens.length - SHINGLE_LEN; i++) {
    const shingle = tokens.slice(i, i + SHINGLE_LEN).join(' ');
    const h = fnv64(shingle);
    for (let b = 0; b < HASH_BITS; b++) {
      const bit = (h >> BigInt(b)) & 1n;
      counts[b] = (counts[b] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let b = 0; b < HASH_BITS; b++) {
    if (counts[b]! > 0) {
      out |= 1n << BigInt(b);
    }
  }
  return out;
}

function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

export { fingerprint };
export type { SourceFingerprint };
