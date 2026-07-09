/**
 * Env-agnostic codec glue. One `ZstdCodec` powers both compress and
 * decompress from a single wasm instance / 12 MB buffer.
 *
 * The environment-specific entrypoints (index.node / index.web /
 * index.web.inlined) set `_internal._loader` to obtain the WebAssembly.Module.
 */
import ZstdCodec from './zstd-wasm-codec.js';
import type { CodecOptions } from './types.js';
export { default as ZstdCodec, _MAX_SRC_BUF } from './zstd-wasm-codec.js';
export declare const _internal: {
    _loader: ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null;
};
/**
 * Create a codec instance bound to a fresh wasm instance. Loads (and caches)
 * the wasm module on first call, then initializes a `ZstdCodec` against it.
 * The caller owns the returned instance's lifecycle.
 */
export declare const createCodec: (options?: CodecOptions) => Promise<ZstdCodec>;
//# sourceMappingURL=codec-shared.d.ts.map