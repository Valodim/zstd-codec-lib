/**
 * Env-agnostic codec glue. One `ZstdCodec` powers both compress and
 * decompress from a single wasm instance / 12 MB buffer.
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
 * Create a codec instance bound to a fresh wasm instance. Loads (and caches)
 * the wasm module on first call, then initializes a `ZstdCodec` against it.
 * The caller owns the returned instance's lifecycle.
 */
export const createCodec = async (options: CodecOptions = {}): Promise<ZstdCodec> => {
  await _loadModule(options.wasmPath);
  return new ZstdCodec(options).init(cachedModule!);
};
