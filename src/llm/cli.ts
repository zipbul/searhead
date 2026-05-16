import { logger } from '../observability/logger';

/**
 * Structured prompt: SYSTEM instructions (authored by us, trusted) and
 * USER content (sourced from crawled web / agent inputs, untrusted).
 *
 * Ollama's `/api/chat` takes a messages array with `role: "system" |
 * "user"`; routing user content through the USER role is the model's
 * own defense against prompt injection and is stronger than any
 * regex-based scrub of the prompt body.
 */
interface StructuredPrompt {
  system: string;
  user: string;
}

type PromptInput = string | StructuredPrompt;

function asStructured(p: PromptInput): StructuredPrompt {
  if (typeof p === 'string') {
    return { system: '', user: p };
  }
  return p;
}

interface LlmTarget {
  name: string;
  model: string;
}

// Env is read at call time (not module load) so tests / hot-reload
// paths can redirect OLLAMA_HOST without re-importing.
const ollamaHost = () => process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const baseFastModel = () => process.env.KNOLDR_OLLAMA_FAST_MODEL ?? 'gemma4:e4b';
const ollamaTimeoutMs = () => Number(process.env.KNOLDR_OLLAMA_TIMEOUT_MS ?? 120_000);

// Auto-pointer to the latest finetune output. The finetune loop registers
// new adapters as `knoldr-judge:vYYYYMMDD-HHMM` after each successful
// training cycle; the verify pipeline should pick up the freshest one
// without a manual env edit. We list Ollama's tags, pick the highest
// versioned `knoldr-judge:*` tag, and fall back to the configured base
// (gemma4:e4b) when none exist.
//
// The lookup is cached for 60 s — `getFastTargets` is called many times
// per batch, so a per-call HTTP probe would dominate latency. The cache
// is invalidated on lookup error so a transient Ollama hiccup doesn't
// freeze the pointer at a stale value.
const FAST_MODEL_TTL_MS = 60_000;
let cachedFastModel: { model: string; expires: number } | null = null;

async function resolveFastModel(): Promise<string> {
  const now = Date.now();
  if (cachedFastModel && cachedFastModel.expires > now) {
    return cachedFastModel.model;
  }
  const fallback = baseFastModel();
  // Allow opt-out: if the operator pinned KNOLDR_OLLAMA_FAST_MODEL_PIN=1
  // the auto-pointer is bypassed and the env value wins unconditionally.
  if (process.env.KNOLDR_OLLAMA_FAST_MODEL_PIN === '1') {
    cachedFastModel = { model: fallback, expires: now + FAST_MODEL_TTL_MS };
    return fallback;
  }
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const judgeTags = (json.models ?? [])
      .map(m => m.name ?? '')
      .filter(n => n.startsWith('knoldr-judge:'))
      .sort()
      .reverse();
    const latest = judgeTags[0] ?? fallback;
    cachedFastModel = { model: latest, expires: now + FAST_MODEL_TTL_MS };
    if (latest !== fallback) {
      logger.debug({ model: latest }, 'fast model auto-resolved to knoldr-judge');
    }
    return latest;
  } catch {
    // Probe failed — don't cache the failure, so the next call retries.
    cachedFastModel = null;
    return fallback;
  }
}

async function getFastTargets(): Promise<LlmTarget[]> {
  const m = await resolveFastModel();
  return [{ name: `ollama:${m}`, model: m }];
}

// ---- Health circuit breaker ----
// Only open the circuit for SUSTAINED failures. A single timeout /
// transient error is common (Ollama can be busy loading another
// model, the host may have just swapped) and should not kill the
// path for minutes. The prior "one failure → 5 min cooldown"
// design turned a single blip into 56 downstream "no healthy LLM"
// errors in production logs.
//
// Contract: a target goes unhealthy after `FAIL_THRESHOLD`
// consecutive failures. One success resets the counter.
const FAIL_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 1000;
interface Breaker {
  failures: number;
  unhealthyUntil: number;
}
const breakers = new Map<string, Breaker>();

function getBreaker(name: string): Breaker {
  let b = breakers.get(name);
  if (!b) {
    b = { failures: 0, unhealthyUntil: 0 };
    breakers.set(name, b);
  }
  return b;
}

function isHealthy(name: string): boolean {
  const b = getBreaker(name);
  if (b.unhealthyUntil && Date.now() >= b.unhealthyUntil) {
    // Cooldown elapsed — half-open: allow one probe call.
    b.unhealthyUntil = 0;
    b.failures = 0;
  }
  return b.unhealthyUntil === 0;
}

function recordFailure(name: string): void {
  const b = getBreaker(name);
  b.failures++;
  if (b.failures >= FAIL_THRESHOLD) {
    b.unhealthyUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    logger.warn({ model: name, consecutiveFailures: b.failures, cooldownMs: CIRCUIT_COOLDOWN_MS }, 'model circuit opened');
  }
}

function recordSuccess(name: string): void {
  const b = getBreaker(name);
  if (b.failures > 0 || b.unhealthyUntil !== 0) {
    b.failures = 0;
    b.unhealthyUntil = 0;
  }
}

/**
 * Call the primary fast-path LLM. Uses KNOLDR_OLLAMA_FAST_MODEL.
 * Throws if the model is unhealthy or the call fails — caller must
 * handle the failure gracefully (no silent fallback).
 */
async function callLlm(prompt: PromptInput): Promise<string> {
  const structured = asStructured(prompt);
  const targets = await getFastTargets();
  let lastError: Error | null = null;

  for (const t of targets) {
    if (!isHealthy(t.name)) {
      continue;
    }
    try {
      const out = await callOllama(t.model, structured);
      recordSuccess(t.name);
      return out;
    } catch (err) {
      lastError = err as Error;
      recordFailure(t.name);
      logger.warn({ model: t.name, error: lastError.message }, 'LLM call failed');
    }
  }

  throw lastError ?? new Error('No healthy LLM target available');
}

async function callOllama(model: string, prompt: StructuredPrompt): Promise<string> {
  // /api/chat returns a message per exchange; we use stream:false and
  // format:"json" to force strict JSON output. Role separation
  // (system vs user) routes untrusted text through the model's own
  // instruction-isolation path — stronger than regex sanitization.
  const messages = prompt.system
    ? [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]
    : [{ role: 'user', content: prompt.user }];
  const res = await fetch(`${ollamaHost()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(ollamaTimeoutMs()),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ollama ${model} HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    message?: { content?: string };
    error?: string;
  };
  if (json.error) {
    throw new Error(`ollama ${model} error: ${json.error}`);
  }
  const content = json.message?.content;
  if (!content) {
    throw new Error(`ollama ${model} empty response`);
  }
  return content;
}

/**
 * Extract JSON from model output. Ollama with format:"json" emits
 * clean JSON, but we keep the fence + substring extractors as a
 * safety net for models that occasionally append a trailing
 * explanation or wrap their answer in a prose preamble.
 */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* ignore */
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim());
    } catch {
      /* ignore */
    }
  }

  const candidates: Array<[string, string]> = [
    ['{', '}'],
    ['[', ']'],
  ];
  for (const [open, close] of candidates) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(`Could not extract JSON from model output: ${text.slice(0, 500)}`);
}

export { callLlm, extractJson };
