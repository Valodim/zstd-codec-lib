/**
 * Base WebAssembly exports.
 */
export interface BaseWasmExports {
  /** WebAssembly linear memory */
  memory: WebAssembly.Memory;

  /** Allocate memory in the WASM module */
  malloc(size: number): number;
  /** Prune the buffer to a new size (set heap break). */
  setHeapEnd(new_size: number): void;
}

/*
 * Decoder specific exported functions.
 */
export interface DecoderWasmExports extends BaseWasmExports {
  /** Creates a ZSTD decompression context */
  _initialize(): void;

  /** Decompresses data synchronously */
  decompress(dstPtr: number, dstCapacity: number, srcPtr: number, srcSize: number): number;

  /** Decompresses a stream of data */
  decompressStreamStep(): number;

  /** Resets the decompression context */
  resetDecoder(): number;
}

/*
 * Codec-variant exports: superset of decoder exports.
 */
export interface CodecWasmExports extends DecoderWasmExports {
  /** Returns the address of the in/out stream-struct pair (16+16 bytes). */
  getInBufferPtr(): number;

  /** Reset compression context for a fresh frame. */
  initCompressor(level: number): number;

  /** Single-shot compress at a given level. */
  compress(dstPtr: number, dstCapacity: number, srcPtr: number, srcSize: number, level: number): number;

  /** Streaming compress step. endOp: 0=continue 1=flush 2=end-of-frame. */
  compressStreamStep(endOp: number): number;
}

/**
 * Configuration options for the ZSTD encoder.
 */
export interface EncoderOptions {
  /** Compression level. Only level 1 is supported; any other value throws.
   *  Defaults to 1. */
  level?: 1;

  /** Maximum (uncompressed) input buffer size for sync compression */
  maxSrcSize?: number;
}

/**
 * Options for high-level codec API surface.
 */
export interface CodecOptions extends EncoderOptions {
  /** Path to the WASM module (overrides default loader URL) */
  wasmPath?: string;
}

/**
 * Configuration options for the ZSTD decoder.
 */
export interface DecoderOptions {
  /** Maximum (compressed) buffer size in bytes */
  maxSrcSize?: number;

  /** Maximum (decompressed) buffer size in bytes */
  maxDstSize?: number;
}

/**
 * Options for decoder functions and streams.
 */
export interface ZstdOptions {
  /** Path to the WASM module */
  wasmPath?: string;
}

/**
 * Result from a streaming decompression operation.
 */
export interface StreamResult {
  /** Decompressed output buffer */
  buf: Uint8Array;

  /** Offset into the input buffer indicating how much was consumed */
  in_offset: number;
}
