/**
 * High-level codec surface — pairs with shared.ts (decoder side) and
 * shares the same `_internal._loader` so a single codec wasm module
 * powers both decode and encode operations.
 */
import ZstdEncoder from './zstd-wasm-encoder.js';
import type { CodecOptions, EncoderOptions } from './types.js';
export { default as ZstdEncoder } from './zstd-wasm-encoder.js';
/**
 * One-time codec setup. Optional — encoders/decoders are created lazily
 * on first use otherwise. Pre-warms an encoder if any encoder option is
 * provided so the first compression doesn't pay the wasm-init cost.
 */
export declare const setupZstdCodec: (options?: CodecOptions) => Promise<void>;
export declare const createEncoder: (options?: CodecOptions) => Promise<ZstdEncoder>;
/** Compress a buffer. Acquires an encoder from the pool, releases when done. */
export declare const compress: (input: Uint8Array, options?: CodecOptions) => Promise<Uint8Array>;
/**
 * Synchronous compression — requires that the codec was set up already
 * via setupZstdCodec or a prior compress() call (so the wasm module is
 * cached). Picks any free encoder from the pool; if none, throws.
 */
export declare const compressSync: (input: Uint8Array, options?: EncoderOptions) => Uint8Array;
//# sourceMappingURL=encoder-shared.d.ts.map