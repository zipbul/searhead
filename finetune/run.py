"""
Knoldr fact-verifier multi-task fine-tune (continuous loop).

Pulls accumulated pseudo-gold from the live pipeline across FIVE
task formats and trains a single Gemma 4 E4B LoRA adapter on the
mixture. Specializing one model on every prompt the verify pipeline
issues lets each pass through the loop reinforce the others — a
better KG extractor produces better contradiction signals, which
become better verdict labels for the next training cycle.

Tasks (all multiplexed via task-prefix in the prompt):
  1. verdict        — claim + source → verified | disputed
  2. triples        — claim → list of (subject, predicate, object)
  3. subclaims      — complex claim → atomic sub-claims (CoVe)
  4. counter_query  — verified claim → search query that would refute it
  5. citation       — claim + source → exact supporting / refuting sentence

The data sources are the live tables — verdict comes from claims
where source_check + KG agreed, triples from kg_relation linked to
verified claims, subclaims from CoVe evidence, counter_query and
citation from accumulated counter-search and source_check evidence
respectively. All pseudo-gold; no human labels required.

Runs forever as a sleep loop:
  every KNOLDR_FT_INTERVAL_HOURS (default 168 = 1 week),
    if at least KNOLDR_FT_MIN_SAMPLES rows total are available,
      unload Ollama models to free VRAM,
      LoRA-train Gemma 4 E4B on the mixed task dataset,
      export GGUF + register knoldr-judge:vYYYYMMDD-HHMM in Ollama,
    then sleep until next interval.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import psycopg

DATABASE_URL = os.environ["DATABASE_URL"]
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
BASE_MODEL = os.environ.get("KNOLDR_FT_BASE", "unsloth/gemma-4-e4b-it-unsloth-bnb-4bit")
ADAPTER_OUT = Path(os.environ.get("KNOLDR_FT_ADAPTER_OUT", "/adapters"))
GGUF_OUT_DIR = Path(os.environ.get("KNOLDR_FT_GGUF_OUT", "/ollama-models/knoldr"))
MIN_SAMPLES = int(os.environ.get("KNOLDR_FT_MIN_SAMPLES", "200"))
MAX_STEPS = int(os.environ.get("KNOLDR_FT_MAX_STEPS", "600"))
INTERVAL_HOURS = int(os.environ.get("KNOLDR_FT_INTERVAL_HOURS", "168"))  # 1 week
SLEEP_BETWEEN_CHECKS_S = int(os.environ.get("KNOLDR_FT_RECHECK_SECONDS", "3600"))

# Per-task SQL. Each query returns rows that the corresponding
# format_* function turns into a single SFT example. Caps prevent
# any one task from dominating the mixture (verdict claims accumulate
# faster than CoVe ones, etc.).
#
# CRITICAL — every query excludes claims whose statement matches an
# active golden_set_claim row. Golden samples drive the regression
# gate after training; if they leak into training the gate confirms
# the model on data it memorized. The exclusion is *by statement
# text* (not by id) because golden_set lives in its own table.
SQL = {
    "verdict": """
        SELECT statement, verdict, evidence
        FROM claim
        WHERE verdict IN ('verified', 'disputed')
          AND evidence->>'source' IN ('source-check', 'cove', 'kg-contradiction')
          AND created_at > now() - interval '90 days'
          AND statement NOT IN (
            SELECT statement FROM golden_set_claim WHERE active = 1
          )
        LIMIT 3000
    """,
    "triples": """
        SELECT c.statement,
               json_agg(json_build_object(
                   'subject', src.name,
                   'predicate', r.relation_type,
                   'object', tgt.name)) AS triples
        FROM claim c
        JOIN kg_relation r ON r.claim_id = c.id
        JOIN entity src ON src.id = r.source_entity_id
        JOIN entity tgt ON tgt.id = r.target_entity_id
        WHERE c.verdict = 'verified'
          AND c.created_at > now() - interval '90 days'
          AND c.statement NOT IN (
            SELECT statement FROM golden_set_claim WHERE active = 1
          )
        GROUP BY c.id, c.statement
        LIMIT 1500
    """,
    "subclaims": """
        SELECT statement, evidence->'subClaims' AS sub
        FROM claim
        WHERE evidence->>'source' = 'cove'
          AND verdict IN ('verified', 'disputed')
          AND created_at > now() - interval '90 days'
          AND statement NOT IN (
            SELECT statement FROM golden_set_claim WHERE active = 1
          )
        LIMIT 1500
    """,
    "citation": """
        SELECT statement,
               evidence->'sourceChecks'->0->>'citation' AS citation,
               verdict
        FROM claim
        WHERE evidence->>'source' = 'source-check'
          AND evidence->'sourceChecks'->0->>'citation' IS NOT NULL
          AND verdict IN ('verified', 'disputed')
          AND created_at > now() - interval '90 days'
          AND statement NOT IN (
            SELECT statement FROM golden_set_claim WHERE active = 1
          )
        LIMIT 1500
    """,
    # claim_feedback rows where the reporter provided concrete
    # failure detail and the evidence is strong enough to trust. The
    # output teaches the model which dimension of a claim's
    # truthfulness broke when applied — a signal absent from the
    # other four tasks (which only see verified/disputed binaries).
    "feedback": """
        SELECT c.statement,
               cf.failure_dimension,
               cf.counter_claim_text
        FROM claim_feedback cf
        JOIN claim c ON c.id = cf.claim_id
        WHERE cf.outcome IN ('failed', 'partial')
          AND cf.failure_dimension IS NOT NULL
          AND cf.evidence_strength >= 0.5
          AND cf.created_at > now() - interval '90 days'
          AND c.statement NOT IN (
            SELECT statement FROM golden_set_claim WHERE active = 1
          )
        LIMIT 1000
    """,
}


def _format_verdict(row) -> str | None:
    statement, verdict, evidence = row
    if not evidence:
        return None
    checks = evidence.get("sourceChecks") or []
    chunk = None
    for c in checks:
        if c.get("citation"):
            chunk = c["citation"]
            break
        scores = c.get("scores") or {}
        if max(scores.get("entailment", 0), scores.get("contradiction", 0)) >= 0.7:
            chunk = (c.get("url") or "") + "\n" + json.dumps(scores)
            break
    if not chunk:
        return None
    label = "verified" if verdict == "verified" else "disputed"
    return (
        f"[task: verdict]\nClaim: {statement}\nSource: {chunk}\n"
        f"Answer with one word (verified | disputed).\n\n{label}"
    )


def _format_triples(row) -> str | None:
    statement, triples = row
    if not triples:
        return None
    out = json.dumps({"triples": triples}, ensure_ascii=False)
    return (
        f"[task: triples]\nExtract (subject, predicate, object) triples from the claim. "
        f"Respond with JSON only.\n\nClaim: {statement}\n\n{out}"
    )


def _format_subclaims(row) -> str | None:
    statement, sub = row
    if not sub:
        return None
    subs = [s.get("statement") for s in sub if s.get("statement")]
    if not subs:
        return None
    out = json.dumps({"subclaims": subs}, ensure_ascii=False)
    return (
        f"[task: subclaims]\nDecompose the claim into atomic sub-claims. "
        f"Respond with JSON only.\n\nClaim: {statement}\n\n{out}"
    )


def _format_citation(row) -> str | None:
    statement, citation, verdict = row
    if not citation:
        return None
    return (
        f"[task: citation]\nExtract the sentence from the source that best "
        f"{'supports' if verdict == 'verified' else 'refutes'} the claim.\n\n"
        f"Claim: {statement}\n\n{citation}"
    )


# Failure dimensions match the enum in src/db/schema.ts:claim_feedback.
# Kept here as a literal so the Python container doesn't need to import
# anything from the TypeScript side.
FAILURE_DIMENSIONS = (
    "fully-false",
    "scope-too-broad",
    "time-expired",
    "modality-too-strong",
    "context-mismatch",
    "partially-correct",
)


def _format_feedback(row) -> str | None:
    statement, failure_dimension, counter_claim_text = row
    if failure_dimension not in FAILURE_DIMENSIONS:
        return None
    enum_list = " | ".join(FAILURE_DIMENSIONS)
    counter_block = (
        f"\nContext (what an agent observed instead): {counter_claim_text}"
        if counter_claim_text
        else ""
    )
    return (
        f"[task: feedback]\nA claim failed when applied. Which dimension of its "
        f"truth broke? Answer with one label ({enum_list}).\n\n"
        f"Claim: {statement}{counter_block}\n\n{failure_dimension}"
    )


FORMATTERS = {
    "verdict": _format_verdict,
    "triples": _format_triples,
    "subclaims": _format_subclaims,
    "citation": _format_citation,
    "feedback": _format_feedback,
}


def pull_dataset(conn) -> tuple[list[str], dict[str, int]]:
    """Pull all task datasets, format, return mixed example list and
    per-task counts for logging."""
    examples: list[str] = []
    counts: dict[str, int] = {}
    for task, query in SQL.items():
        with conn.cursor() as cur:
            cur.execute(query)
            rows = cur.fetchall()
        n = 0
        for row in rows:
            text = FORMATTERS[task](row)
            if text:
                examples.append(text)
                n += 1
        counts[task] = n
    return examples, counts


def unload_ollama_models() -> None:
    """Free GPU memory before training. Lists running models and
    POSTs generate with keep_alive=0 to each — Ollama interprets
    that as "unload immediately"."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/ps", timeout=5) as resp:
            data = json.loads(resp.read())
        for m in data.get("models", []):
            name = m.get("name")
            if not name:
                continue
            req = urllib.request.Request(
                f"{OLLAMA_HOST}/api/generate",
                data=json.dumps({"model": name, "prompt": "", "keep_alive": 0}).encode(),
                headers={"content-type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=10).read()
            print(f"unloaded ollama model {name}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"ollama unload skipped: {e}")


FT_LOCK_KEY = 0x6B6E6F6C64720001  # 'knoldr\x00\x01' as int64 — namespace for ft job

def train_once() -> int:
    print(f"[{datetime.now(timezone.utc).isoformat()}] knoldr-finetune cycle start")
    # Acquire an exclusive postgres advisory lock that blocks the verify
    # worker (which acquires a SHARED lock on the same key before each
    # batch) from running while training is in flight. Held across the
    # whole cycle — model load, training, GGUF export, Ollama register —
    # so verify never tries to reach an Ollama that's mid-unload.
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (FT_LOCK_KEY,))
            got = cur.fetchone()[0]
        if not got:
            print("could not acquire ft-active lock (another cycle running?); skipping")
            return 0
        try:
            examples, counts = pull_dataset(conn)
            total = len(examples)
            print(f"pulled {total} examples across tasks: {counts}")

            if total < MIN_SAMPLES:
                print(f"insufficient samples ({total} < {MIN_SAMPLES}); skipping")
                return 0

            # Free GPU before allocating ~6GB for 4-bit Gemma + LoRA. Ollama
            # auto-reloads on next inference request after training finishes.
            unload_ollama_models()
            return _do_train(examples)
        finally:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (FT_LOCK_KEY,))


def _do_train(examples: list[str]) -> int:
    # Lazy-import unsloth so the container can boot for inspection
    # even on hosts without GPU drivers exposed.
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from trl import SFTTrainer
    from transformers import TrainingArguments

    # max_seq_length=2048 + bsz=2 left ~4 GB for fused-CE on a 16 GB
    # 4080, which unsloth flags as "negligible". Our prompts are
    # claim+source pairs (~300-800 tokens), so 1024 covers them and
    # halves the activation memory.
    max_seq = int(os.environ.get("KNOLDR_FT_MAX_SEQ", "1024"))
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=max_seq,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_alpha=16,
        lora_dropout=0.0,
        bias="none",
    )

    ds = Dataset.from_list([{"text": e} for e in examples])
    ADAPTER_OUT.mkdir(parents=True, exist_ok=True)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        dataset_text_field="text",
        max_seq_length=max_seq,
        args=TrainingArguments(
            output_dir=str(ADAPTER_OUT),
            # bsz=1 + grad_accum=8 keeps the effective batch at 8 while
            # roughly halving the per-step activation footprint vs
            # bsz=2. Fits the 16 GB 4080 alongside the 4-bit Gemma 4
            # weights (~6 GB) with margin for fused cross-entropy.
            per_device_train_batch_size=int(os.environ.get("KNOLDR_FT_BSZ", "1")),
            gradient_accumulation_steps=int(os.environ.get("KNOLDR_FT_GRAD_ACCUM", "8")),
            warmup_steps=10,
            max_steps=MAX_STEPS,
            learning_rate=2e-4,
            fp16=False,
            bf16=True,
            logging_steps=20,
            save_strategy="no",
            optim="adamw_8bit",
        ),
    )
    trainer.train()

    GGUF_OUT_DIR.mkdir(parents=True, exist_ok=True)
    version_tag = datetime.now(timezone.utc).strftime("v%Y%m%d-%H%M")
    gguf_path = GGUF_OUT_DIR / f"knoldr-judge-{version_tag}.gguf"
    model.save_pretrained_gguf(
        str(GGUF_OUT_DIR),
        tokenizer,
        quantization_method="q4_k_m",
    )
    print(f"saved gguf at {gguf_path}")

    # Stage 1: register the candidate under a *staging* tag so we
    # can probe it without affecting live verify traffic.
    staging_tag = f"knoldr-judge-staging:{version_tag}"
    _ollama_create(staging_tag, gguf_path)
    print(f"registered staging tag {staging_tag}")

    # Stage 2: regression gate. Run prompts from golden_set_claim
    # through the staging model and measure agreement with the
    # expected verdicts.
    eval_result = _run_golden_eval(staging_tag, version_tag)
    accuracy = eval_result.get("accuracy", 0.0) if eval_result else 0.0
    threshold = float(os.environ.get("KNOLDR_FT_PROMOTE_MIN_ACCURACY", "0.6"))
    baseline = _previous_promoted_accuracy()

    # Escape hatch for bootstrap: when there are no golden labels
    # yet (eval_result is None) AND KNOLDR_FT_PROMOTE_WITHOUT_EVAL=1
    # is set, promote on faith. The operator owns that risk; default
    # behavior is to refuse promotion without measurement.
    force_promote = os.environ.get("KNOLDR_FT_PROMOTE_WITHOUT_EVAL") == "1"
    parsed = eval_result.get("parsed", 0) if eval_result else 0

    if eval_result is None:
        eligible = force_promote
    else:
        eligible = (
            parsed > 0
            and accuracy >= threshold
            and (baseline is None or accuracy >= baseline - 0.02)  # tiny drift
        )

    if not eligible:
        # Persist failure row so the next cycle's baseline reflects
        # that this attempt was rejected (and why).
        _persist_eval(eval_result, version_tag, promoted=False)
        reason = (
            "no golden labels and PROMOTE_WITHOUT_EVAL not set"
            if eval_result is None
            else f"accuracy={accuracy:.3f} threshold={threshold:.3f} baseline={baseline} parsed={parsed}"
        )
        print(
            f"NOT PROMOTING ({reason}). "
            f"Staging tag {staging_tag} retained for inspection."
        )
        return 0

    # Stage 3: actually promote *before* recording promoted=True. If
    # the Ollama create call silently fails (network glitch, missing
    # daemon), we must not leave the DB asserting promotion happened.
    history_tag = f"knoldr-judge:{version_tag}"
    history_ok = _ollama_create_strict(history_tag, gguf_path)
    latest_ok = _ollama_create_strict("knoldr-judge:latest", gguf_path)
    if not (history_ok and latest_ok):
        _persist_eval(eval_result, version_tag, promoted=False)
        print(
            "PROMOTE FAILED: ollama create did not succeed; "
            "staging tag retained, baseline left unchanged."
        )
        return 0

    _persist_eval(eval_result, version_tag, promoted=True)
    print(
        f"PROMOTED knoldr-judge:latest -> {version_tag} "
        f"(accuracy={accuracy:.3f}, baseline={baseline})"
    )
    return 0


def _ollama_create_strict(tag: str, gguf_path: Path) -> bool:
    """Strict variant of _ollama_create.
    Ollama /api/create streams NDJSON. The HTTP layer can return 200
    while embedding `{"error":"..."}` in a body line — checking only
    `resp.status` would silently treat a server-side rejection as
    success. We read the body to completion and look for both:
      - non-2xx HTTP status
      - any NDJSON line carrying an `error` field
    Both → False. Body must be drained even on the failure path so
    Ollama doesn't see a half-closed connection and abort midway."""
    payload = json.dumps({"name": tag, "modelfile": f"FROM {gguf_path}"})
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/create",
        data=payload.encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
        if not (200 <= status < 300):
            print(f"WARN: ollama create {tag} returned HTTP {status}; body={body[:300]}")
            return False
        # Walk the NDJSON stream. The contract is "True only when a
        # success indicator was observed AND no error line appeared":
        #   - any embedded {"error": ...} → False
        #   - terminal {"status": "success"} → True
        #   - no parseable JSON at all → False (don't trust a body
        #     we couldn't read; it could be a proxy-mangled response)
        saw_success = False
        for line in body.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("error"):
                print(f"WARN: ollama create {tag} reported error: {obj['error']}")
                return False
            if obj.get("status") == "success":
                saw_success = True
        if not saw_success:
            print(
                f"WARN: ollama create {tag} returned 2xx but no success "
                f"indicator in body; treating as failure. body={body[:300]}"
            )
            return False
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"WARN: ollama create {tag} failed: {e}")
        return False


def _ollama_create(tag: str, gguf_path: Path) -> None:
    """Register a tag pointing at the given GGUF. Idempotent — the
    Ollama /api/create endpoint replaces an existing tag with the
    same name, so this is also how we update `latest`."""
    payload = json.dumps({"name": tag, "modelfile": f"FROM {gguf_path}"})
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/create",
        data=payload.encode(),
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=120).read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"WARN: ollama create {tag} failed: {e}")


def _ollama_generate(model: str, prompt: str, timeout_s: int = 60) -> str | None:
    """One-shot generate. Returns the response text or None on error."""
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        # Verdict prediction needs short answers; capping output tokens
        # prevents the model from emitting reams of justification text.
        "options": {"num_predict": 8, "temperature": 0.0},
    })
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/generate",
        data=payload.encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
        return (data.get("response") or "").strip()
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
        print(f"WARN: ollama generate {model} failed: {e}")
        return None


_VERDICT_PATTERN_VERIFIED = ("verified",)
_VERDICT_PATTERN_DISPUTED = ("disputed", "refuted", "false")


def _parse_verdict_token(resp: str | None) -> str | None:
    """Strict parse of the verdict-task output. Returns 'verified',
    'disputed', or None for unparseable / off-vocabulary responses.
    Unparseable responses are *excluded from the denominator* in
    the eval — counting them as wrong conflates model failure with
    output-format failure and warps the regression signal."""
    if not resp:
        return None
    lower = resp.strip().lower()
    # First non-whitespace token is the most-likely answer; bail on
    # response that doesn't lead with a recognized verdict token to
    # avoid matching mid-sentence "verified" inside justifications.
    first = lower.split(None, 1)[0] if lower.split() else ""
    first = first.strip(".,!?:;\"'`")
    if first in _VERDICT_PATTERN_VERIFIED:
        return "verified"
    if first in _VERDICT_PATTERN_DISPUTED:
        return "disputed"
    # Fall back to a permissive contains check ONLY when the response
    # is short enough that the token is essentially the whole answer.
    if len(lower) <= 30:
        if any(tok in lower for tok in _VERDICT_PATTERN_VERIFIED) and "unverified" not in lower:
            return "verified"
        if any(tok in lower for tok in _VERDICT_PATTERN_DISPUTED):
            return "disputed"
    return None


def _build_eval_source_block(source_urls, source_hint) -> str:
    """Reconstruct a 'Source:' block that matches the *training*
    prompt distribution as closely as possible. The training verdict
    task carries a real citation or URL; the eval should too.

    Preference order:
      1. First source_urls entry (closest to training format)
      2. source_hint (labeler memo)
      3. omit the line entirely so the model isn't forced to
         hallucinate about a missing source
    """
    if source_urls:
        if isinstance(source_urls, list) and source_urls:
            first = source_urls[0]
            if isinstance(first, str) and first:
                return first
        elif isinstance(source_urls, str) and source_urls:
            return source_urls
    if source_hint:
        return source_hint
    return ""


def _run_golden_eval(model_tag: str, version_tag: str) -> dict | None:
    """Run a verdict-only sanity check against the staging model.
    Pulls active factual golden_set_claim rows with binary expected
    verdicts and asks the model to classify each. Returns
    {accuracy, total, correct, parsed, unparseable, byVerdict} or
    None when there are no samples."""
    print(f"running golden regression eval against {model_tag}")
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT statement, expected_verdict, source_hint, source_urls
                FROM golden_set_claim
                WHERE active = 1
                  AND claim_type = 'factual'
                  AND expected_verdict IN ('verified', 'disputed')
            """)
            rows = cur.fetchall()
    if not rows:
        print("golden_set_claim has no factual binary-verdict rows; eval skipped")
        return None

    correct = 0
    unparseable = 0
    by_verdict = {"verified": {"tp": 0, "fp": 0, "fn": 0},
                  "disputed": {"tp": 0, "fp": 0, "fn": 0}}
    for statement, expected, source_hint, source_urls in rows:
        source_block = _build_eval_source_block(source_urls, source_hint)
        prompt_lines = [f"[task: verdict]", f"Claim: {statement}"]
        if source_block:
            prompt_lines.append(f"Source: {source_block}")
        prompt_lines.append("Answer with one word (verified | disputed).")
        prompt = "\n".join(prompt_lines)

        resp = _ollama_generate(model_tag, prompt)
        predicted = _parse_verdict_token(resp)
        if predicted is None:
            unparseable += 1
            continue  # excluded from denominator
        if predicted == expected:
            correct += 1
            by_verdict[predicted]["tp"] += 1
        else:
            by_verdict[predicted]["fp"] += 1
            by_verdict[expected]["fn"] += 1

    parsed = len(rows) - unparseable
    accuracy = correct / parsed if parsed else 0.0
    result = {
        "modelTag": model_tag,
        "versionTag": version_tag,
        "total": len(rows),
        "parsed": parsed,
        "unparseable": unparseable,
        "correct": correct,
        "accuracy": accuracy,
        "byVerdict": by_verdict,
    }
    print(
        f"golden eval: {correct}/{parsed} = {accuracy:.3f}  "
        f"(unparseable={unparseable}/{len(rows)})"
    )
    return result


def _previous_promoted_accuracy() -> float | None:
    """Look up the accuracy of the most recent successfully-promoted
    finetune cycle so the new candidate must at least match it (with
    a small drift allowance). Returns None when no prior promotion
    exists — first cycle uses the absolute threshold only."""
    try:
        with psycopg.connect(DATABASE_URL) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT (metrics->>'accuracy')::double precision
                    FROM golden_set_run
                    WHERE metrics->>'finetune_promoted' = 'true'
                    ORDER BY ran_at DESC
                    LIMIT 1
                """)
                row = cur.fetchone()
        if not row or row[0] is None:
            return None
        return float(row[0])
    except Exception as e:
        print(f"WARN: previous-baseline lookup failed: {e}")
        return None


def _persist_eval(
    eval_result: dict | None,
    version_tag: str,
    promoted: bool,
) -> None:
    """Write the eval outcome into golden_set_run so it's visible to
    the next cycle (and to Knoldr's regression dashboards).

    Column mapping is deliberate:
      - total / correct      → over PARSED samples (unparseable excluded)
      - precision/recall/f1  → all carry the same accuracy figure,
                               because the staging eval is a single-
                               class accuracy proxy. Schema CHECK
                               requires [0,1]; semantic detail lives
                               in metrics.byVerdict.
      - metrics              → full diagnostic JSONB (per-verdict tp/
                               fp/fn, unparseable count, the model
                               tag, and the promotion flag the next
                               cycle reads as baseline)
    """
    if eval_result is None:
        return
    try:
        accuracy = eval_result.get("accuracy") or 0.0
        parsed = eval_result.get("parsed") or 0
        correct = eval_result.get("correct") or 0
        with psycopg.connect(DATABASE_URL) as conn:
            with conn.cursor() as cur:
                metrics = {
                    "accuracy": accuracy,
                    "byVerdict": eval_result.get("byVerdict"),
                    "unparseable": eval_result.get("unparseable"),
                    "totalRows": eval_result.get("total"),
                    "finetune_promoted": promoted,
                    "version_tag": version_tag,
                    "judge_model": eval_result.get("modelTag"),
                    "metric_semantics": "accuracy_only",
                }
                cur.execute(
                    """
                    INSERT INTO golden_set_run (
                        id, ran_at, commit_sha, model_versions, total, correct,
                        precision_overall, recall_overall, f1_overall, metrics,
                        baseline_run_id, regressed
                    ) VALUES (
                        %s, now(), NULL, %s::jsonb, %s, %s,
                        %s, %s, %s, %s::jsonb,
                        NULL, NULL
                    )
                    """,
                    (
                        f"ft-{version_tag}",
                        json.dumps({"judge": eval_result.get("modelTag")}),
                        parsed,
                        correct,
                        accuracy,
                        accuracy,
                        accuracy,
                        json.dumps(metrics),
                    ),
                )
                conn.commit()
    except Exception as e:
        print(f"WARN: persisting eval row failed: {e}")


def main() -> int:
    print(
        f"knoldr-finetune started: interval={INTERVAL_HOURS}h, "
        f"min_samples={MIN_SAMPLES}, recheck={SLEEP_BETWEEN_CHECKS_S}s"
    )
    last_train = 0.0
    # Force-now path: when KNOLDR_FT_FORCE_NOW=1 we run a single cycle
    # immediately on boot, regardless of INTERVAL_HOURS or last_train.
    # This is the bring-up / smoke-test entry: confirms DB, GPU,
    # unsloth, GGUF export, and Ollama registration end-to-end. Cleared
    # after one execution so a restart loop doesn't retrain forever.
    if os.environ.get("KNOLDR_FT_FORCE_NOW") == "1":
        print("KNOLDR_FT_FORCE_NOW=1 — running one cycle immediately")
        try:
            train_once()
        except Exception as e:
            print(f"forced train_once failed: {type(e).__name__}: {e}")
        last_train = time.time()
    while True:
        now = time.time()
        if now - last_train >= INTERVAL_HOURS * 3600:
            try:
                train_once()
                last_train = now
            except Exception as e:
                print(f"train_once failed: {type(e).__name__}: {e}")
        time.sleep(SLEEP_BETWEEN_CHECKS_S)


if __name__ == "__main__":
    sys.exit(main())
