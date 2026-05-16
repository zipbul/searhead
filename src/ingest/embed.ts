import { loadWithDeviceFallback } from '../llm/device';
import { logger } from '../observability/logger';

const MAX_TOKENS = 256; // all-MiniLM-L6-v2 max token limit
const EMBEDDING_DIM = 384;

class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

// If KNOLDR_EMBEDDING_BASE_URL is set, use HTTP API (for testing with mock server).
// Otherwise, use local @huggingface/transformers model.
const USE_LOCAL = !process.env.KNOLDR_EMBEDDING_BASE_URL;

let pipelineInstance: ((text: string, opts?: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>) | null = null;

async function getPipeline() {
  if (!pipelineInstance) {
    const { pipeline } = await import('@huggingface/transformers');
    pipelineInstance = (await loadWithDeviceFallback('all-MiniLM-L6-v2', device =>
      pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'q8',
        device,
      } as unknown as Record<string, unknown>),
    )) as unknown as typeof pipelineInstance;
    logger.info('local embedding model loaded: all-MiniLM-L6-v2 (384dim, q8)');
  }
  return pipelineInstance!;
}

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }

  const sentences = text.split(/(?<=[.!?])\s+/);
  let result = '';
  for (const sentence of sentences) {
    const candidate = result ? `${result} ${sentence}` : sentence;
    if (estimateTokens(candidate) > maxTokens) {
      break;
    }
    result = candidate;
  }
  return result || text.slice(0, maxTokens * 4);
}

function buildEmbeddingInput(title: string, content: string): string {
  const combined = `${title}\n\n${content}`;
  return truncateToTokenLimit(combined, MAX_TOKENS);
}

async function generateEmbedding(text: string): Promise<number[]> {
  if (USE_LOCAL) {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return output.tolist()[0]!;
  }
  return generateEmbeddingApi(text);
}

// --- API fallback (for testing with mock server) ---

async function generateEmbeddingApi(text: string): Promise<number[]> {
  const baseUrl = process.env.KNOLDR_EMBEDDING_BASE_URL!;
  const apiKey = process.env.KNOLDR_EMBEDDING_API_KEY ?? 'test';

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'test', input: text }),
  });

  if (!res.ok) {
    throw new EmbeddingError(`Embedding API error ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = json.data?.[0]?.embedding;
  // A zero vector would silently pollute dedup/cross-ref (cosine-0 matches
  // nothing → everything looks unique). Refuse to commit anything the
  // upstream couldn't supply; caller must handle the error and either
  // retry or reject the entry entirely.
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new EmbeddingError('embedding API returned empty or wrong-shape vector');
  }
  return vec;
}

export { buildEmbeddingInput, generateEmbedding };
