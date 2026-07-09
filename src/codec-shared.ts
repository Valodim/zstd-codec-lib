/**
 * Env-agnostic codec glue. One `ZstdCodec` powers both compress and
 * decompress; a single pool of instances is shared across both directions
 * (each instance runs one operation at a time via its lock).
 *
 * The environment-specific entrypoints (index.node / index.web /
 * index.web.inlined) set `_internal._loader` to obtain the WebAssembly.Module.
 */

import ZstdCodec from './zstd-wasm-codec.js';
import type { CodecOptions } from './types.js';
import { err } from './utils.js';

export { default as ZstdCodec, _MAX_SRC_BUF } from './zstd-wasm-codec.js';

export const _internal = {
  _loader: null as ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null,
};

let cachedModule: WebAssembly.Module | null = null;

async function _loadModule(wasmPath?: string): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule;
  if (!_internal._loader) throw new err('codec loader not set');
  const m = _internal._loader(wasmPath);
  cachedModule = m instanceof Promise ? await m : m;
  return cachedModule;
}

/**
 * Codec pool. A slot holds a ZstdCodec bound to one wasm instance; lock state
 * tracks in-flight use so concurrent operations don't corrupt shared state.
 * Pool key encodes the options that get baked into the instance's buffers.
 */
const _MAX_POOL = 3;
const pools = new Map<string, ZstdCodec[]>();
const locks = new Map<string, boolean[]>();

const _DEFAULT_MAX_SRC = 4 * 1024 * 1024;
// Key on the options baked into an instance's buffers/guards. Compression
// level is NOT included: it's a per-call argument to compressSync, not baked
// into the instance, and decode-only callers may pass an arbitrary level.
const _poolKey = (o: CodecOptions): string =>
  `${o.maxSrcSize ?? _DEFAULT_MAX_SRC}|${o.maxCompressedSize ?? 0}|${o.maxDecompressedSize ?? 0}`;

function _createCodec(opts: CodecOptions): ZstdCodec {
  return new ZstdCodec(opts).init(cachedModule!);
}

/**
 * Take a free pool slot for `key`, or make a new codec. idx === -1 means the
 * codec is transient (pool was full) and the caller must _destroy() it.
 * Assumes the module is already cached.
 */
function _take(opts: CodecOptions): [ZstdCodec, number, string] {
  const key = _poolKey(opts);
  if (!pools.has(key)) {
    pools.set(key, []);
    locks.set(key, []);
  }
  const pool = pools.get(key)!;
  const lk = locks.get(key)!;

  for (let i = 0; i < lk.length; i++) {
    if (!lk[i]) {
      lk[i] = true;
      return [pool[i], i, key];
    }
  }

  const codec = _createCodec(opts);
  if (lk.length >= _MAX_POOL) return [codec, -1, key]; // transient

  const idx = lk.length;
  pool.push(codec);
  lk.push(true);
  return [codec, idx, key];
}

async function _acquire(opts: CodecOptions = {}): Promise<[ZstdCodec, number, string]> {
  await _loadModule(opts.wasmPath);
  return _take(opts);
}

function _acquireSync(opts: CodecOptions = {}): [ZstdCodec, number, string] {
  if (!cachedModule) throw new err('codec not init — call setupZstdCodec or an async helper first');
  return _take(opts);
}

function _release(idx: number, key: string): void {
  if (idx < 0) return;
  const lk = locks.get(key);
  if (lk) lk[idx] = false;
}

/**
 * One-time codec setup. Optional — codecs are created lazily on first use
 * otherwise. Loads the wasm module and pre-warms a pooled instance.
 */
export const setupZstdCodec = async (options: CodecOptions = {}): Promise<void> => {
  await _loadModule(options.wasmPath);
  const [, idx, key] = _take(options);
  _release(idx, key);
};

/** Create a standalone codec instance (caller manages its lifecycle). */
export const createCodec = async (options: CodecOptions = {}): Promise<ZstdCodec> => {
  await _loadModule(options.wasmPath);
  return _createCodec(options);
};

/** Compress a buffer. Acquires a codec from the pool, releases when done. */
export const compress = async (
  input: Uint8Array,
  options: CodecOptions = {},
): Promise<Uint8Array> => {
  const [c, idx, key] = await _acquire(options);
  try {
    return c.compressSync(input, options.level);
  } finally {
    if (idx === -1) c._destroy();
    else _release(idx, key);
  }
};

/**
 * Synchronous compression — requires the codec module to be cached already
 * (via setupZstdCodec or a prior async helper call).
 */
export const compressSync = (input: Uint8Array, options: CodecOptions = {}): Uint8Array => {
  const [c, idx, key] = _acquireSync(options);
  try {
    return c.compressSync(input, options.level);
  } finally {
    if (idx === -1) c._destroy();
    else _release(idx, key);
  }
};

/**
 * Decompress a buffer. One-shot: the whole input is provided, so decode with
 * `final` set — an incomplete frame means the input was truncated and throws.
 */
export const decompress = async (
  input: Uint8Array,
  options: CodecOptions = {},
): Promise<Uint8Array> => {
  const [c, idx, key] = await _acquire(options);
  try {
    return c._decompressStream(input, true, true).buf;
  } finally {
    if (idx === -1) c._destroy();
    else _release(idx, key);
  }
};

/**
 * Synchronous decompression — requires the codec module to be cached already
 * (via setupZstdCodec or a prior async helper call).
 */
export const decompressSync = (
  input: Uint8Array,
  expectedSize?: number,
  options: CodecOptions = {},
): Uint8Array => {
  const [c, idx, key] = _acquireSync(options);
  try {
    return c.decompressSync(input, expectedSize);
  } finally {
    if (idx === -1) c._destroy();
    else _release(idx, key);
  }
};
