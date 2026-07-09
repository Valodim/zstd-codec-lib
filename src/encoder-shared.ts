/**
 * High-level codec surface — pairs with shared.ts (decoder side) and
 * shares the same `_internal._loader` so a single codec wasm module
 * powers both decode and encode operations.
 */

import ZstdEncoder from './zstd-wasm-encoder.js';
import type { CodecOptions, EncoderOptions } from './types.js';
import { err } from './utils.js';
import { _internal } from './shared.js';

export { default as ZstdEncoder } from './zstd-wasm-encoder.js';

const _toUint8Array = (chunk: BufferSource): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk as ArrayBuffer);
};

/**
 * Codec wasm module — fetched once, shared across all encoder/decoder
 * instances created from the codec entrypoint.
 */
let cachedModule: WebAssembly.Module | null = null;

async function _loadModule(wasmPath?: string): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule;
  if (!_internal._loader) throw new err('codec loader not set');
  const m = _internal._loader(wasmPath);
  cachedModule = m instanceof Promise ? await m : m;
  return cachedModule;
}

/**
 * Encoder pool — mirrors the decoder pool in shared.ts. A pool slot
 * holds a ZstdEncoder bound to one wasm instance; lock state tracks
 * in-flight use so concurrent compressions don't corrupt the
 * encoder's CCtx / stream-struct state.
 *
 * Pool key encodes (level | maxSrcSize) — encoders with different
 * settings can't share a slot because the bound buffers are baked in
 * at init.
 */
const _MAX_POOL = 3;
const encoderPools = new Map<string, ZstdEncoder[]>();
const encoderLocks = new Map<string, boolean[]>();

// Default must mirror ZstdEncoder's _DEFAULT_MAX_SRC so that callers who
// pass the default explicitly hit the same pool slot as those who omit it.
const _DEFAULT_MAX_SRC = 4 * 1024 * 1024;
const _poolKey = (opts: EncoderOptions): string =>
  `${opts.level ?? 1}|${opts.maxSrcSize ?? _DEFAULT_MAX_SRC}`;

async function _createEncoder(opts: EncoderOptions): Promise<ZstdEncoder> {
  const mod = await _loadModule();
  return new ZstdEncoder(opts).init(mod);
}

/**
 * Returns [encoder, idx, key]. idx === -1 means the encoder is transient
 * (pool was full) and the caller must call _destroy() when done.
 */
async function _acquireEncoder(
  opts: EncoderOptions = {},
): Promise<[ZstdEncoder, number, string]> {
  const key = _poolKey(opts);

  if (!encoderPools.has(key)) {
    encoderPools.set(key, []);
    encoderLocks.set(key, []);
  }
  const pool = encoderPools.get(key)!;
  const locks = encoderLocks.get(key)!;

  for (let i = 0; i < locks.length; i++) {
    if (!locks[i]) {
      locks[i] = true;
      return [pool[i], i, key];
    }
  }

  const enc = await _createEncoder(opts);

  if (locks.length >= _MAX_POOL) {
    return [enc, -1, key]; // transient, caller destroys
  }

  const idx = locks.length;
  pool.push(enc);
  locks.push(true);
  return [enc, idx, key];
}

function _releaseEncoder(idx: number, key: string): void {
  if (idx < 0) return;
  const locks = encoderLocks.get(key);
  if (locks) locks[idx] = false;
}

/**
 * One-time codec setup. Optional — encoders/decoders are created lazily
 * on first use otherwise. Pre-warms an encoder if any encoder option is
 * provided so the first compression doesn't pay the wasm-init cost.
 */
export const setupZstdCodec = async (
  options: CodecOptions = {},
): Promise<void> => {
  await _loadModule(options.wasmPath);
  if (options.level || options.maxSrcSize) {
    const [, idx, key] = await _acquireEncoder(options);
    _releaseEncoder(idx, key);
  }
};

export const createEncoder = async (
  options: CodecOptions = {},
): Promise<ZstdEncoder> => {
  const mod = await _loadModule(options.wasmPath);
  return new ZstdEncoder(options).init(mod);
};

/** Compress a buffer. Acquires an encoder from the pool, releases when done. */
export const compress = async (
  input: Uint8Array,
  options: CodecOptions = {},
): Promise<Uint8Array> => {
  const [enc, idx, key] = await _acquireEncoder(options);
  try {
    return enc.compressSync(input, options.level);
  } finally {
    if (idx === -1) enc._destroy();
    else _releaseEncoder(idx, key);
  }
};

/**
 * Synchronous compression — requires that the codec was set up already
 * via setupZstdCodec or a prior compress() call (so the wasm module is
 * cached). Picks any free encoder from the pool; if none, throws.
 */
export const compressSync = (
  input: Uint8Array,
  options: EncoderOptions = {},
): Uint8Array => {
  const key = _poolKey(options);
  const pool = encoderPools.get(key);
  const locks = encoderLocks.get(key);
  if (!pool || !locks) throw new err('codec not init — call setupZstdCodec or compress first');

  for (let i = 0; i < locks.length; i++) {
    if (!locks[i]) {
      locks[i] = true;
      try {
        return pool[i].compressSync(input, options.level);
      } finally {
        locks[i] = false;
      }
    }
  }
  // Whole pool is busy — fall back to the first slot (still safe in
  // single-threaded JS unless the caller is interleaving sync calls
  // from different reentrant contexts, which compressSync explicitly
  // doesn't support).
  return pool[0].compressSync(input, options.level);
};

/** Streaming WHATWG TransformStream — pipes plaintext bytes to compressed bytes. */
export class ZstdCompressionStream {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;

  constructor(options: CodecOptions = {}) {
    let encoder: ZstdEncoder | null = null;
    let poolIdx = -1;
    let poolKey = '';

    const acquire = async () => {
      if (encoder) return;
      [encoder, poolIdx, poolKey] = await _acquireEncoder(options);
      encoder.reset(options.level);
    };

    const release = () => {
      if (!encoder) return;
      if (poolIdx === -1) encoder._destroy();
      else _releaseEncoder(poolIdx, poolKey);
      encoder = null;
    };

    const { readable, writable } = new TransformStream<BufferSource, Uint8Array>({
      async transform(chunk, controller) {
        const data = _toUint8Array(chunk);
        if (data.length === 0) return;
        try {
          await acquire();
          const out = encoder!.compressStreamChunk(data, false);
          if (out.length > 0) controller.enqueue(out);
        } catch (e) {
          release();
          controller.error(new err(`enc err ${e}`));
        }
      },
      async flush(controller) {
        try {
          await acquire();
          const tail = encoder!.compressStreamChunk(new Uint8Array(0), true);
          if (tail.length > 0) controller.enqueue(tail);
        } catch (e) {
          controller.error(new err(`enc end err ${e}`));
        } finally {
          release();
          controller.terminate();
        }
      },
    });

    this.readable = readable;
    this.writable = writable;
  }
}
