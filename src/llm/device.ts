import { logger } from '../observability/logger';

/**
 * Selects the onnxruntime execution device for transformers.js model
 * loads. Reads KNOLDR_INFERENCE_DEVICE (cuda | cpu, default cpu) and
 * caches the result so every model loader uses a consistent backend.
 *
 * `loadWithDeviceFallback()` wraps a `from_pretrained` invocation:
 * tries the preferred device first, falls back to CPU on failure so
 * missing CUDA libs / driver mismatch don't hard-stop the container.
 */

type Device = 'cpu' | 'cuda';

function preferredDevice(): Device {
  const v = (process.env.KNOLDR_INFERENCE_DEVICE ?? 'cpu').trim().toLowerCase();
  return v === 'cuda' || v === 'gpu' ? 'cuda' : 'cpu';
}

let resolvedDevice: Device | null = null;

function getInferenceDevice(): Device {
  if (resolvedDevice) {
    return resolvedDevice;
  }
  resolvedDevice = preferredDevice();
  return resolvedDevice;
}

/**
 * Call `loader(device)` with the preferred device. On failure retry
 * with "cpu". Caches the winner so subsequent loads don't re-probe.
 */
export async function loadWithDeviceFallback<T>(label: string, loader: (device: Device) => Promise<T>): Promise<T> {
  const preferred = getInferenceDevice();
  if (preferred === 'cpu') {
    return loader('cpu');
  }
  try {
    const out = await loader('cuda');
    logger.info({ model: label, device: 'cuda' }, 'model loaded on GPU');
    return out;
  } catch (err) {
    logger.warn({ model: label, error: (err as Error).message }, 'GPU load failed, falling back to CPU');
    resolvedDevice = 'cpu';
    return loader('cpu');
  }
}
