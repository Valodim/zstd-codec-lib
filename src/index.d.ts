export type {
  BaseWasmExports,
  CodecWasmExports,
  DecoderWasmExports,
  CodecOptions,
  ZstdOptions,
} from './types.js';

import type { CodecOptions } from './types.js';

/**
 * Decompress a Zstandard-compressed buffer into a `Uint8Array`.
 *
 * Promise-based helper for one-shot decompression when the entire
 * compressed buffer is already available in memory.
 *
 * @param input - The compressed Zstandard data.
 * @param options - Optional codec options.
 * @returns A promise that resolves with the decompressed buffer.
 */
export declare function decompress(input: Uint8Array, options?: CodecOptions): Promise<Uint8Array>;

/**
 * Decompress a Zstandard-compressed buffer synchronously.
 *
 * Requires the codec module to be cached already (via {@link setupZstdCodec}
 * or a prior async helper call). If the expected size is not provided it is
 * inferred from the frame header when possible, and very large payloads may
 * fall back internally to streaming decompression.
 *
 * @param input - The compressed Zstandard data.
 * @param expectedSize - Optional expected size of the decompressed output, in bytes.
 * @param options - Optional codec options.
 * @returns The decompressed output buffer.
 */
export declare function decompressSync(
  input: Uint8Array,
  expectedSize?: number,
  options?: CodecOptions,
): Uint8Array;

/**
 * Compress a buffer using Zstandard.
 *
 * @param input - Uncompressed input.
 * @param options - Optional codec options (level must be 1).
 */
export declare function compress(input: Uint8Array, options?: CodecOptions): Promise<Uint8Array>;

/**
 * Synchronously compress a buffer. Requires the codec module to be cached
 * already (via {@link setupZstdCodec} or a prior async helper call).
 */
export declare function compressSync(input: Uint8Array, options?: CodecOptions): Uint8Array;

/**
 * Pre-initialize the codec (loads the wasm module, pre-warms a pooled
 * instance). Optional — codecs are created lazily on first use otherwise.
 */
export declare function setupZstdCodec(options?: CodecOptions): Promise<void>;

/**
 * Create a standalone {@link ZstdCodec} instance with an auto-loaded WASM
 * module. A low-level helper for callers that want to manage instances
 * themselves instead of going through the pooled helpers.
 */
export declare function createCodec(options?: CodecOptions): Promise<ZstdCodec>;

/**
 * Low-level ZSTD codec class — one WebAssembly instance serving both
 * compression (level 1 only) and decompression.
 */
export declare class ZstdCodec {
  /**
   * Note: the underlying WASM module is not loaded by the constructor. Use
   * {@link ZstdCodec.init} or {@link createCodec} to obtain an initialized
   * instance.
   */
  constructor(options?: CodecOptions);

  /** Initializes the codec with a compiled WebAssembly module. */
  init(wasmModule: WebAssembly.Module): ZstdCodec;

  /** Compresses data synchronously (level 1 only). */
  compressSync(data: Uint8Array, level?: number): Uint8Array;

  /** Decompresses data synchronously. */
  decompressSync(data: Uint8Array, expectedSize?: number): Uint8Array;

  /**
   * Cleans up codec resources and detaches references to the underlying WASM
   * memory. After calling this, the instance must not be used again.
   */
  _destroy(): void;
}

declare const _default: {
  createCodec: typeof createCodec;
  compress: typeof compress;
  compressSync: typeof compressSync;
  decompress: typeof decompress;
  decompressSync: typeof decompressSync;
  setupZstdCodec: typeof setupZstdCodec;
};

export default _default;
