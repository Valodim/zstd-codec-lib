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
  resetDecoder(): void;
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
  compress(
    dstPtr: number,
    dstCapacity: number,
    srcPtr: number,
    srcSize: number,
    level: number,
  ): number;

  /** Streaming compress step. endOp: 0=continue 1=flush 2=end-of-frame. */
  compressStreamStep(endOp: number): number;
}

/**
 * Configuration options for the combined ZSTD codec (compress + decompress).
 */
export interface CodecOptions {
  /** Compression level. Only level 1 is supported; any other value throws.
   *  Defaults to 1. */
  level?: 1;

  /** Maximum (uncompressed) input for one sync compress. Sizes the compress
   *  buffers; larger inputs fall back to streaming. Defaults to 4 MiB when
   *  omitted; a non-positive or NaN value throws. */
  maxSrcSize?: number;

  /** Decompression-bomb guard: maximum compressed input accepted. Defaults to
   *  a large finite floor. */
  maxCompressedSize?: number;

  /** Decompression-bomb guard: maximum decompressed output produced. Defaults
   *  to a large finite floor. */
  maxDecompressedSize?: number;

  /** Path to the WASM module (overrides default loader URL).
   *  Honored only by the web / external loaders — the Node loader always
   *  loads the bundled wasm. Also first-call-wins: the compiled module is
   *  cached after the first `createCodec`, so a `wasmPath` passed to later
   *  calls is ignored. */
  wasmPath?: string;
}

/**
 * Options for codec helper functions.
 */
export interface ZstdOptions {
  /** Path to the WASM module. Honored only by the web / external loaders, and
   *  only on the first `createCodec` (the compiled module is cached after). */
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
