export type { BaseWasmExports, DecoderWasmExports } from './types.js';

/**
 * Web Streams API transform for Zstandard decompression.
 *
 * Provides a `TransformStream`-compatible class that accepts ZSTD-compressed
 * chunks on its writable side and yields decompressed `Uint8Array` chunks
 * from its readable side.
 *
 * The stream automatically buffers input until it can read a full ZSTD frame
 * header, then acquires a decoder from the internal pool and begins
 * decompressing. When the stream is closed it will either release or destroy
 * the underlying decoder as appropriate.
 *
 * @example
 * ```ts
 * const ds = new ZstdDecompressionStream();
 * const response = await fetch('/file.zst');
 * const decompressed = response.body!.pipeThrough(ds);
 * ```
 *
 * @see {@link ReadableStream}
 * @see {@link WritableStream}
 * @see {@link decompressStream}
 */
export declare class ZstdDecompressionStream {
  /**
   * The resulting decompressed stream to read output from.
   * @type {ReadableStream<Uint8Array>}
   */
  readonly readable: ReadableStream;
  /**
   * The writable end of the stream to pipe compressed chunks into.
   * @type {WritableStream<BufferSource>}
   */
  readonly writable: WritableStream;

  /**
   * @param {ZstdOptions} [options] - Optional decoder configuration.
   */
  constructor(options?: ZstdOptions);
}

/**
 * Decompress a Zstandard-compressed buffer into a `Uint8Array`.
 *
 * Promise-based helper for one-shot decompression when the entire
 * compressed buffer is already available in memory. Internally it calls
 * {@link decompressStream} and returns only the `.buf` field.
 *
 * @param input - The compressed Zstandard data.
 * @param options - Optional decompression options.
 * @returns A promise that resolves with the decompressed buffer.
 *
 * @example
 * const decompressed = await decompress(compressedData);
 *
 * @see {@link decompressStream}
 */
export declare function decompress(input: Uint8Array, options?: ZstdOptions): Promise<Uint8Array>;

/**
 * Decompresses a Zstandard-compressed buffer into a {@link StreamResult}.
 *
 * This helper wraps the internal decoder pool and can be called repeatedly as
 * `(chunk, reset)` for **sequential** incremental decoding, as long as calls
 * for a given dictionary ID are not interleaved or made concurrently.
 *
 * Because it acquires and releases pooled decoders on every call, it does not
 * provide strong streaming guarantees under concurrency. For a robust
 * incremental streaming API, prefer {@link ZstdDecompressionStream}, which
 * owns a single decoder instance for the lifetime of the stream.
 *
 * @param input - The compressed Zstandard data.
 * @param reset - Whether to reset the decoder context before decompression (default: `false`).
 * @param options - Optional decompression options (e.g., dictionary, WASM path).
 * @returns A promise that resolves with the decompressed output and number of input bytes consumed.
 *
 * @example
 * const first = await decompressStream(chunk1, true);
 * const next = await decompressStream(chunk2, false);
 *
 */
export declare function decompressStream(
  input: Uint8Array,
  reset?: boolean,
  options?: ZstdOptions,
): Promise<StreamResult>;

/**
 * Decompress a Zstandard-compressed buffer synchronously.
 *
 * Provides fast synchronous decompression. If the expected size is not
 * provided it will be inferred from the frame header when possible, and
 * very large payloads may fall back internally to streaming decompression.
 *
 * @param input - The compressed Zstandard data.
 * @param expectedSize - Optional expected size of the decompressed output, in bytes.
 * @param options - Optional decompression options (e.g., dictionary).
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
 * helpers such as {@link decompress} or {@link decompressStream}.
 *
 * @param options - Decoder configuration options (dictionary, WASM path, limits).
 * @returns A promise that resolves to an initialized decoder instance.
 */
export declare function createDecoder(options?: ZstdOptions): Promise<ZstdDecoder>;

/**
 * Low-level ZSTD decoder class.
 *
 * This class wraps a single ZSTD decompression context living inside a
 * WebAssembly instance. It can be used for both single-shot and incremental
 * streaming decompression via {@link ZstdDecoder.decompressStream}.
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
   * Decompresses data using the low-level streaming API.
   *
   * Multiple calls with `reset=false` will continue the current stream; a call
   * with `reset=true` resets the internal context and starts a new stream.
   *
   * @param data - ZSTD compressed data chunk.
   * @param reset - Whether to reset the decompression context for a new stream.
   * @returns Stream result with decompressed buffer and input offset metadata.
   */
  decompressStream(data: Uint8Array, reset?: boolean): StreamResult;

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

export type { DecoderOptions, StreamResult, ZstdOptions };

declare const _default: {
  createDecoder: typeof createDecoder;
  decompress: typeof decompress;
  decompressSync: typeof decompressSync;
  decompressStream: typeof decompressStream;
  ZstdDecompressionStream: typeof ZstdDecompressionStream;
};

export default _default;
