/**
 * Centralize @huggingface/transformers (onnxruntime-web) thread tuning.
 *
 * By default onnxruntime-web uses as many intra-op threads as the host
 * exposes. On a 24+ core host with multiple models loaded (NLI,
 * reranker, QA, embedding), every forward pass fans out across all
 * cores — a single verify tick of batchSize=6 saturates the whole
 * machine and starves every other worker (reclassify / claim-extract
 * / invariants) that shares the process.
 *
 * Cap per-op threads at a modest number so concurrent model forwards
 * can overlap without piling on the same CPU pool. Operators can
 * tune via KNOLDR_ONNX_THREADS when deploying on bigger hardware.
 *
 * Call `configureOnnxRuntime()` ONCE before the first model import.
 * The settings are read when onnxruntime initializes; late changes
 * have no effect.
 */

let configured = false;

export async function configureOnnxRuntime(): Promise<void> {
  if (configured) {
    return;
  }
  configured = true;
  const threads = Math.max(1, Number(process.env.KNOLDR_ONNX_THREADS ?? 2));
  try {
    const mod = (await import('@huggingface/transformers')) as unknown as {
      env?: {
        backends?: { onnx?: { wasm?: { numThreads?: number; proxy?: boolean } } };
      };
    };
    const wasm = mod.env?.backends?.onnx?.wasm;
    if (wasm) {
      wasm.numThreads = threads;
    }
  } catch {
    // transformers.js not importable yet — harmless, callers will
    // import again on their own code paths.
  }
}
