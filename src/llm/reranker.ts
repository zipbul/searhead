import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers';

import { logger } from '../observability/logger';
import { loadWithDeviceFallback } from './device';

// Cross-encoder reranker. Embedding-based cosine ranking is fast but
// it scores each chunk independently — same chunk gets the same
// embedding regardless of which claim we're verifying, so a chunk
// that's *topically* close to the claim entity but says something
// unrelated still floats to the top. A cross-encoder takes (claim,
// chunk) jointly and returns a relevance score, which is materially
// better at picking the chunk that *answers* the claim, not just
// mentions its keywords.
//
// bge-reranker-base is the right size for CPU: 278M params, q8 ONNX
// runs in ~30ms per pair on the existing transformers.js setup.

const RERANKER_MODEL = process.env.KNOLDR_RERANKER_MODEL ?? 'Xenova/bge-reranker-base';

interface CachedReranker {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

let cached: CachedReranker | null = null;
let loading: Promise<CachedReranker> | null = null;

async function getHandles(): Promise<CachedReranker> {
  if (cached) {
    return cached;
  }
  if (loading) {
    return loading;
  }
  loading = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
    const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
    const model = await loadWithDeviceFallback(RERANKER_MODEL, device =>
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, {
        dtype: 'q8',
        device,
      } as unknown as Record<string, unknown>),
    );
    cached = { tokenizer, model };
    logger.info({ model: RERANKER_MODEL }, 'reranker model loaded');
    return cached;
  })();
  return loading;
}

/**
 * Rank `passages` by their relevance to `query`. Returns indices
 * into the original array sorted by descending relevance. Higher
 * raw logit = more relevant. Uses a single forward pass per pair
 * (no batching — caller controls cost by limiting passage count).
 */
export async function rerank(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) {
    return [];
  }
  if (passages.length === 1) {
    return [0];
  }
  const h = await getHandles();
  const scores: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < passages.length; i++) {
    // PreTrainedTokenizer is callable (extends a base whose call
    // signature returns `any`); same for PreTrainedModel. We pin the
    // structural shape we actually rely on at the boundary so the
    // rest of the function stays typed.
    const inputs = h.tokenizer(query, {
      text_pair: passages[i]!,
      return_tensors: 'pt',
      truncation: true,
      max_length: 512,
    });
    const out = (await h.model(inputs)) as { logits: { data: Float32Array } };
    // bge-reranker outputs a single relevance logit per pair; higher
    // = more relevant. We keep raw logits (no sigmoid) because we
    // only care about ranking, not absolute probability.
    const score = out.logits.data[0]!;
    scores.push({ idx: i, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.map(s => s.idx);
}
