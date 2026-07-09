import ZstdDecoder from './zstd-wasm-decoder.js';
export { default as ZstdDecoder, _MAX_SRC_BUF } from './zstd-wasm-decoder.js';

import type { ZstdOptions } from './types.js';

export const _internal = {
  _loader: null as ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null,
  buffer: {
    maxSrcSize: 0,
    maxDstSize: 0,
  },
};

// Decoder pool: up to _MAX_POOL instances, lock state tracks in-flight use.
const _MAX_POOL = 3;
const decoderPool: ZstdDecoder[] = [];
const poolLocks: boolean[] = [];

let isInitialized = false;
let cachedModule: WebAssembly.Module;

function _createDecoderInstance(): ZstdDecoder {
  const decoder = new ZstdDecoder({ ..._internal.buffer });
  decoder.init(cachedModule);
  return decoder;
}

export const setupZstdDecoder = async (options: {
  maxSrcSize?: number;
  maxDstSize?: number;
}) => {
  if (options.maxSrcSize) _internal.buffer.maxSrcSize = options.maxSrcSize;
  if (options.maxDstSize) _internal.buffer.maxDstSize = options.maxDstSize;
};

/**
 * Returns [decoder, idx]. idx === -1 means the decoder is transient (pool
 * was full) and the caller must call _destroy() when done.
 */
async function _acquireDecoder(): Promise<[ZstdDecoder, number]> {
  if (!cachedModule) {
    const module = _internal._loader!();
    cachedModule = module instanceof Promise ? await module : module;
  }

  for (let i = 0; i < poolLocks.length; ++i) {
    if (!poolLocks[i]) {
      poolLocks[i] = true;
      return [decoderPool[i], i];
    }
  }

  const decoder = _createDecoderInstance();

  if (poolLocks.length >= _MAX_POOL) return [decoder, -1];

  const newIdx = poolLocks.length;
  decoderPool.push(decoder);
  poolLocks.push(true);
  return [decoder, newIdx];
}

function _releaseDecoder(idx: number): void {
  if (idx >= 0) poolLocks[idx] = false;
}

export const createDecoder = async (
  options: ZstdOptions = {},
): Promise<ZstdDecoder> => {
  if (!isInitialized) {
    cachedModule = await _internal._loader!(options.wasmPath);
    isInitialized = true;
  }
  return _createDecoderInstance();
};

export const decompress = async (
  input: Uint8Array,
  _options?: ZstdOptions,
): Promise<Uint8Array> => {
  // One-shot: the whole input is provided, so decode with `final` set — a
  // frame left incomplete means the input was truncated and must throw
  // rather than silently returning partial output.
  const [decoder, idx] = await _acquireDecoder();
  try {
    return decoder._decompressStream(input, true, true).buf;
  } finally {
    idx == -1 ? decoder._destroy() : _releaseDecoder(idx);
  }
};

export const decompressSync = (
  input: Uint8Array,
  expectedSize?: number,
  _options?: ZstdOptions,
): Uint8Array => {
  // Take a free pool slot if one exists, otherwise run on a transient
  // instance. Each pooled decoder is its own wasm instance, so a free slot
  // can't be mid-decode elsewhere.
  let idx = -1;
  for (let i = 0; i < poolLocks.length; ++i) {
    if (!poolLocks[i]) {
      poolLocks[i] = true;
      idx = i;
      break;
    }
  }
  const decoder = idx >= 0 ? decoderPool[idx] : _createDecoderInstance();
  try {
    return decoder.decompressSync(input, expectedSize);
  } finally {
    if (idx >= 0) _releaseDecoder(idx);
    else decoder._destroy();
  }
};
