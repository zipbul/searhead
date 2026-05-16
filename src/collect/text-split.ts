/**
 * Recursive text chunking — no LLM, no quota.
 *
 * Splits LangSearch summary content into entry-sized chunks using
 * paragraph boundaries, heading markers, and sentence breaks as
 * recursive fallback levels. 2026 benchmarks (Vecta) show this
 * outperforms semantic/embedding-based chunking (69% vs 54%).
 *
 * Target: 400-500 tokens (~1600-2000 chars). Overlap: ~10% for
 * context continuity across chunk boundaries.
 */

const TARGET_CHARS = 1800;
const MAX_CHARS = 2500;
const MIN_CHARS = 80;
const OVERLAP_CHARS = 180;

const HEADING_RE = /^#{1,4}\s/m;
const DOUBLE_NEWLINE = /\n{2,}/;
const SENTENCE_END = /(?<=[.!?])\s+/;

interface TextChunk {
  index: number;
  text: string;
}

/**
 * Split raw text into chunks. Recursive strategy:
 *   1. Headings (## ...)
 *   2. Double newlines (paragraph breaks)
 *   3. Sentence boundaries
 *   4. Hard char limit (last resort)
 */
function splitText(raw: string): TextChunk[] {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_CHARS) {
    return trimmed.length >= MIN_CHARS ? [{ index: 0, text: trimmed }] : [];
  }

  const rawSections = splitRecursive(trimmed);
  const merged = mergeSmall(rawSections);
  const overlapped = addOverlap(merged);

  return overlapped.filter(t => t.length >= MIN_CHARS).map((text, index) => ({ index, text }));
}

function splitRecursive(text: string): string[] {
  if (text.length <= MAX_CHARS) {
    return [text];
  }

  // Try heading splits first
  if (HEADING_RE.test(text)) {
    const parts = text.split(/(?=^#{1,4}\s)/m).filter(Boolean);
    if (parts.length > 1) {
      return parts.flatMap(splitRecursive);
    }
  }

  // Try paragraph splits
  const paras = text.split(DOUBLE_NEWLINE).filter(Boolean);
  if (paras.length > 1) {
    return paras.flatMap(splitRecursive);
  }

  // Try sentence splits
  const sentences = text.split(SENTENCE_END).filter(Boolean);
  if (sentences.length > 1) {
    const groups: string[] = [];
    let buf = '';
    for (const s of sentences) {
      if (buf.length + s.length > TARGET_CHARS && buf.length >= MIN_CHARS) {
        groups.push(buf.trim());
        buf = s;
      } else {
        buf = buf ? `${buf} ${s}` : s;
      }
    }
    if (buf) {
      groups.push(buf.trim());
    }
    return groups;
  }

  // Hard split as last resort
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TARGET_CHARS) {
    chunks.push(text.slice(i, i + TARGET_CHARS).trim());
  }
  return chunks;
}

function mergeSmall(sections: string[]): string[] {
  const merged: string[] = [];
  let buf = '';
  for (const sec of sections) {
    if (buf.length + sec.length < TARGET_CHARS) {
      buf = buf ? `${buf}\n\n${sec}` : sec;
    } else {
      if (buf) {
        merged.push(buf);
      }
      buf = sec;
    }
  }
  if (buf) {
    merged.push(buf);
  }
  return merged;
}

function addOverlap(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, i) => {
    if (i === 0) {
      return chunk;
    }
    const prev = chunks[i - 1]!;
    const tail = prev.slice(-OVERLAP_CHARS);
    const overlapStart = tail.indexOf(' ');
    const overlap = overlapStart >= 0 ? tail.slice(overlapStart + 1) : tail;
    return `${overlap}\n\n${chunk}`;
  });
}

function deriveTitle(chunk: string, maxLen = 120): string {
  const firstLine = chunk.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > 10 && firstLine.length <= maxLen) {
    return firstLine.replace(/^#+\s*/, '');
  }
  return chunk.slice(0, maxLen).replace(/\s+/g, ' ').trim();
}

export { splitText, deriveTitle };
