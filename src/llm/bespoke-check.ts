import { logger } from '../observability/logger';

// Bespoke-MiniCheck-7B verifier (current SOTA on LLM-AggreFact at
// 77.4% balanced accuracy — beats Claude 3.5 Sonnet and GPT-4 on
// the same benchmark, source: https://llm-aggrefact.github.io).
//
// Used as a *third* signal alongside DeBERTa-FEVER (English NLI)
// and mDeBERTa (multilingual NLI). The three models have different
// architectures and training objectives, so when they agree the
// signal is much stronger than any one alone; when they disagree
// the verifier defers to the higher-confidence vote weighted by
// per-model accuracy on LLM-AggreFact.
//
// Runs through the Ollama HTTP layer (model already pulled by the
// host setup). Quantization is whatever Ollama ships by default
// (Q4_K_M as of pull time) — accuracy degradation vs full precision
// is minimal on this task per the Bespoke Labs evals.

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const BESPOKE_MODEL = process.env.KNOLDR_BESPOKE_MODEL ?? 'bespoke-minicheck';

interface BespokeResult {
  supported: boolean;
  /** Confidence in [0, 1] derived from raw model output. */
  confidence: number;
  rawAnswer: string;
}

const BESPOKE_PROMPT = (document: string, claim: string) =>
  `Document: ${document.slice(0, 6000)}\n\nClaim: ${claim.slice(0, 1000)}\n\nIs the claim supported by the document above? Answer with one word: Yes or No.`;

/**
 * Score whether `document` supports `claim` using Bespoke-MiniCheck.
 * Returns null on transport failure so callers can downgrade
 * gracefully to NLI-only.
 */
async function bespokeCheck(document: string, claim: string): Promise<BespokeResult | null> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: BESPOKE_MODEL,
        prompt: BESPOKE_PROMPT(document, claim),
        stream: false,
        options: { temperature: 0, num_predict: 8 },
      }),
    });
    if (!res.ok) {
      logger.debug({ status: res.status }, 'bespoke-minicheck HTTP error');
      return null;
    }
    const json = (await res.json()) as { response?: string };
    const raw = (json.response ?? '').trim();
    const lower = raw.toLowerCase();
    // Recognize the common English affirmatives/negatives at word
    // boundaries. The previous `startsWith` missed "yeah", "yep",
    // "nope" entirely and classified them as ambiguous (0.3).
    if (/^(yes|yeah|yep|yup|correct|true|supported|affirmative)\b/.test(lower)) {
      return { supported: true, confidence: 0.85, rawAnswer: raw };
    }
    if (/^(no|nope|nah|false|incorrect|unsupported|negative)\b/.test(lower)) {
      return { supported: false, confidence: 0.85, rawAnswer: raw };
    }
    // Ambiguous — treat as low-confidence "neutral".
    return { supported: false, confidence: 0.3, rawAnswer: raw };
  } catch (err) {
    logger.debug({ error: (err as Error).message }, 'bespoke-minicheck call failed');
    return null;
  }
}

export { bespokeCheck };
