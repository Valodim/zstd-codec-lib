export type {
  BaseWasmExports,
  CodecWasmExports,
  DecoderWasmExports,
  EncoderOptions,
  CodecOptions,
} from './types.js';

/**
 * Decompress a Zstandard-compressed buffer into a `Uint8Array`.
 *
 * Promise-based helper for one-shot decompression when the entire
 * compressed buffer is already available in memory.
 *
 * @param input - The compressed Zstandard data.
 * @param options - Optional decompression options.
 * @returns A promise that resolves with the decompressed buffer.
 *
 * @example
 * const decompressed = await decompress(compressedData);
 */
export declare function decompress(input: Uint8Array, options?: ZstdOptions): Promise<Uint8Array>;

/**
 * Decompress a Zstandard-compressed buffer synchronously.
 *
 * Provides fast synchronous decompression. If the expected size is not
 * provided it will be inferred from the frame header when possible, and
 * very large payloads may fall back internally to streaming decompression.
 *
 * @param input - The compressed Zstandard data.
 * @param expectedSize - Optional expected size of the decompressed output, in bytes.
 * @param options - Optional decompression options.
 * @returns The decompressed output buffer.
 *
 * @example
 * const decompressed = decompressSync(compressedData, 123456);
 * // or without expectedSize:
 * const decompressed2 = decompressSync(compressedData);
 */
export declare function decompressSync(
  input: Uint8Array,
  expectedSize?: number,
  options?: ZstdOptions,
): Uint8Array;

/**
 * Creates a decoder instance with an auto-loaded WASM module.
 *
 * This is a low-level helper for cases where you want to manage
 * {@link ZstdDecoder} instances yourself instead of going through the pooled
 * helper {@link decompress}.
 *
 * @param options - Decoder configuration options (WASM path, limits).
 * @returns A promise that resolves to an initialized decoder instance.
 */
export declare function createDecoder(options?: ZstdOptions): Promise<ZstdDecoder>;

/**
 * Low-level ZSTD decoder class.
 *
 * This class wraps a single ZSTD decompression context living inside a
 * WebAssembly instance and exposes single-shot decompression.
 */
export declare class ZstdDecoder {
  /**
   * Creates a new ZSTD decoder instance.
   *
   * Note: the underlying WASM module is not loaded by the constructor. Use
   * {@link ZstdDecoder.init} or {@link createDecoder} to obtain an initialized
   * instance.
   *
   * @param options - Decoder configuration options.
   */
  constructor(options?: DecoderOptions);

  /**
   * Initializes the decoder with a WebAssembly module.
   *
   * @param wasmModule - Compiled WebAssembly module
   * @returns Promise that resolves to the initialized decoder
   */
  init(wasmModule?: WebAssembly.Module): Promise<ZstdDecoder>;

  /**
   * Decompresses data synchronously.
   *
   * @param data - ZSTD compressed data
   * @param expectedSize - Expected size of the decompressed data
   * @returns Decompressed data
   */
  decompressSync(data: Uint8Array, expectedSize?: number): Uint8Array;

  /**
   * Cleans up decoder resources and detaches references to the underlying
   * WASM memory. After calling this, the instance must not be used again.
   */
  _destroy(): void;
}

export type { DecoderOptions, ZstdOptions };

/**
 * Compress a buffer using Zstandard.
 * @param input - Uncompressed input.
 * @param options - Optional compression options (level must be 1).
 */
export declare function compress(input: Uint8Array, options?: CodecOptions): Promise<Uint8Array>;

/**
 * Synchronously compress a buffer. Requires the codec to be initialized
 * already (via {@link setupZstdCodec} or a prior {@link compress} call).
 */
export declare function compressSync(input: Uint8Array, options?: CodecOptions): Uint8Array;

/**
 * Pre-initialize the codec (loads the wasm module, primes the encoder
 * pool). Optional — encoders are created lazily on first compress() call.
 */
export declare function setupZstdCodec(options?: CodecOptions): Promise<void>;

/**
 * Creates an encoder instance with an auto-loaded WASM module.
 */
export declare function createEncoder(options?: EncoderOptions): Promise<ZstdEncoder>;

/**
 * Low-level ZSTD encoder class. Only compression level 1 is supported;
 * any other level throws.
 */
export declare class ZstdEncoder {
  constructor(options?: EncoderOptions);
  init(wasmModule?: WebAssembly.Module): Promise<ZstdEncoder>;
  compressSync(data: Uint8Array, level?: number): Uint8Array;
  _destroy(): void;
}

declare const _default: {
  createDecoder: typeof createDecoder;
  createEncoder: typeof createEncoder;
  compress: typeof compress;
  compressSync: typeof compressSync;
  decompress: typeof decompress;
  decompressSync: typeof decompressSync;
};

export default _default;
