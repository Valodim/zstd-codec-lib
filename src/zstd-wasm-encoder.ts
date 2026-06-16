import type { CodecWasmExports, EncoderOptions } from './types.js';
import { err, _concatUint8Arrays } from './utils.js';

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                  Codec Memory Layout                         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   0x00000  ┌────────────────────────────────────┐            ║
 * ║            │      Stack Space (64 KB)           │            ║
 * ║   0x10000  ├────────────────────────────────────┤            ║
 * ║            │   Stream structs (32 b):           │            ║
 * ║            │     in_buffer  (16 b)              │            ║
 * ║            │     out_buffer (16 b)              │            ║
 * ║            │   Shared between decode + encode.  │            ║
 * ║            │   Address = exports.getInBufferPtr()           ║
 * ║   0x10020  ├────────────────────────────────────┤            ║
 * ║            │   Static ZSTD_DCtx (~96 KB)        │            ║
 * ║            │   + read-only constants            │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║   0x40000  │   pb-reset point (262144)          │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │   ZSTD_CCtx + cwksp workspace      │            ║
 * ║            │   (~1 MB at level 1)               │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │   Dictionary (optional)            │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │   Source buffer (compressing)      │            ║
 * ║            │   Destination buffer               │            ║
 * ║            │     For compress:    ~src + bound  │            ║
 * ║            │     For decompress:  up to ~9.4 MB │            ║
 * ║   ~12 MB   └────────────────────────────────────┘            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const _CODEC_PB_RESET = 262144;
const _DEFAULT_MAX_SRC = 4 * 1024 * 1024; // 4 MiB

/** Only compression level 1 is supported. The wasm is built level-1-only
 * (ZSTD_WASM_INIT_LEVEL=1, dfast excluded) and its fixed 12 MB layout only
 * has headroom for the level-1 workspace; higher levels carry a larger
 * windowLog/hashLog and can push the bump allocator past linear memory.
 * Reject anything else up front instead of producing undefined behaviour. */
const _assertLevel1 = (level: number): number => {
  if (level !== 1) throw new err(`level ${level} unsupported; only level 1`);
  return level;
};

/** ZSTD_COMPRESSBOUND(srcSize) — upper bound on compressed output.
 * Mirrors the upstream macro in lib/zstd.h. */
const _compressBound = (srcSize: number): number =>
  srcSize + (srcSize >>> 8) + (srcSize < 128 * 1024 ? (128 * 1024 - srcSize) >>> 11 : 0);

class ZstdEncoder {
  private _exports!: CodecWasmExports;
  private _HEAPU8!: Uint8Array;
  private _HEAPU32!: Uint32Array;

  private readonly _dictionary?: Uint8Array;
  private readonly _level: number;
  private readonly _maxSrcSize: number;

  /** Address of the (in_buffer, out_buffer) struct pair within wasm memory. */
  private _inStructPtr = 0;
  private _outStructPtr = 0;

  /** Stable working buffers carved out of wasm memory after _initialize. */
  private _srcPtr = 0;
  private _dstPtr = 0;
  private _dstCap = 0;
  /** Drain threshold for the streaming dst staging buffer. */
  private _flushAt = 0;

  constructor(options: EncoderOptions = {}) {
    this._dictionary = options.dictionary;
    this._level = _assertLevel1(options.level ?? 1);
    this._maxSrcSize = options.maxSrcSize ?? _DEFAULT_MAX_SRC;
  }

  /** Initialize against a compiled codec WebAssembly module. */
  init(wasmModule: WebAssembly.Module): ZstdEncoder {
    return this._initCommon(new WebAssembly.Instance(wasmModule, { env: {} }));
  }

  _initWithInstance(wasmInstance: WebAssembly.Instance): ZstdEncoder {
    return this._initCommon(wasmInstance);
  }

  private _initCommon(wasmInstance: WebAssembly.Instance): ZstdEncoder {
    this._exports = wasmInstance.exports as unknown as CodecWasmExports;
    const _memory = this._exports.memory as WebAssembly.Memory;
    this._HEAPU8 = new Uint8Array(_memory.buffer);
    this._HEAPU32 = new Uint32Array(_memory.buffer);

    this._exports._initialize();

    // Streaming structs: in_buffer at base, out_buffer at base+16.
    this._inStructPtr = this._exports.getInBufferPtr();
    this._outStructPtr = this._inStructPtr + 16;

    // Optional compression dict (persistent across resets).
    if (this._dictionary) {
      const len = this._dictionary.length;
      const dictPtr = this._exports.malloc(len);
      // malloc returns 0 (NULL) when the request doesn't fit the fixed,
      // non-growable linear memory. Writing at offset 0 would clobber the
      // stack, so fail loudly instead.
      if (!dictPtr) throw new err('oom: dict exceeds wasm memory');
      this._HEAPU8.set(this._dictionary, dictPtr);
      const r = this._exports.loadEncoderDict(dictPtr, len);
      if (r < 0) throw new err(`dict load err ${r >>> 0}`);
    }

    this._srcPtr = this._exports.malloc(this._maxSrcSize);
    this._dstCap = _compressBound(this._maxSrcSize);
    this._dstPtr = this._exports.malloc(this._dstCap);
    // A 0 pointer means the configured maxSrcSize (+ dict) doesn't fit the
    // 12 MB linear memory. Surface it now rather than corrupting low memory
    // on the first compress.
    if (!this._srcPtr || !this._dstPtr) {
      throw new err('oom: maxSrcSize too large for wasm memory');
    }
    // Drain when the dst staging is at least half-full (or 128KB if larger),
    // so subsequent cS() iterations have headroom. Math.max guards against
    // tiny _dstCap configurations from going negative.
    this._flushAt = Math.max(0, this._dstCap - Math.min(this._dstCap >>> 1, 1 << 17));
    return this;
  }

  /**
   * Single-shot compression. Returns a freshly-allocated Uint8Array.
   *
   * Falls back to streaming when the input exceeds maxSrcSize.
   */
  compressSync(input: Uint8Array, level?: number): Uint8Array {
    if (!this._exports) throw new err('not init');
    const srcSize = input.length;
    if (srcSize > this._maxSrcSize) return this.compressStream(input, true);

    // Buffers stay where _initialize left them; reset heap_cursor so
    // future malloc()s (e.g. dict reload) don't accumulate forever.
    // For sync compress we don't need to pb() since we already pre-allocated.
    this._HEAPU8.set(input, this._srcPtr);
    const lvl = _assertLevel1(level ?? this._level);
    const r = this._exports.compress(this._dstPtr, this._dstCap, this._srcPtr, srcSize, lvl);
    if (r < 0) throw new err(`compress err ${r >>> 0}`);
    return this._HEAPU8.slice(this._dstPtr, this._dstPtr + r);
  }

  private _writeStreamStruct(ptr: number, bufPtr: number, size: number, pos = 0): void {
    const i = ptr >>> 2;
    this._HEAPU32[i] = bufPtr;
    this._HEAPU32[i + 1] = size;
    this._HEAPU32[i + 2] = pos;
  }
  private _readStreamPos(ptr: number): number {
    return this._HEAPU32[(ptr + 8) >>> 2];
  }

  /**
   * Streaming compression — drains the input and ends the frame, returning
   * the full compressed output. Use ZstdCompressionStream for incremental.
   */
  compressStream(input: Uint8Array, reset = true, level?: number): Uint8Array {
    if (!this._exports) throw new err('not init');

    const lvl = _assertLevel1(level ?? this._level);
    if (reset) {
      const r = this._exports.initCompressor(lvl);
      if (r < 0) throw new err(`initCompressor err ${r >>> 0}`);
    }

    const inLen = input.length;
    const outChunks: Uint8Array[] = [];
    let outTotal = 0;

    // We feed the input in fixed-size slices from this._srcPtr and drain
    // the output to this._dstPtr, flushing it back to JS each pass.
    const inChunkMax = Math.min(this._maxSrcSize, 1 << 20); // 1 MiB at a time
    let inOff = 0;

    const flushOut = () => {
      const written = this._readStreamPos(this._outStructPtr);
      if (written > 0) {
        outChunks.push(this._HEAPU8.slice(this._dstPtr, this._dstPtr + written));
        outTotal += written;
      }
      this._writeStreamStruct(this._outStructPtr, this._dstPtr, this._dstCap, 0);
    };

    this._writeStreamStruct(this._outStructPtr, this._dstPtr, this._dstCap, 0);

    while (inOff < inLen) {
      const take = Math.min(inChunkMax, inLen - inOff);
      this._HEAPU8.set(input.subarray(inOff, inOff + take), this._srcPtr);
      this._writeStreamStruct(this._inStructPtr, this._srcPtr, take, 0);

      while (this._readStreamPos(this._inStructPtr) < take) {
        const r = this._exports.compressStreamStep(0); // ZSTD_e_continue
        if (r < 0) throw new err(`compressStreamStep err ${r >>> 0}`);
        if (this._readStreamPos(this._outStructPtr) >= this._flushAt) {
          flushOut();
        }
      }
      inOff += take;
    }

    // End-of-frame
    let r: number;
    do {
      this._writeStreamStruct(this._inStructPtr, this._srcPtr, 0, 0);
      r = this._exports.compressStreamStep(2); // ZSTD_e_end
      if (r < 0) throw new err(`compressStreamStep end err ${r >>> 0}`);
      if (this._readStreamPos(this._outStructPtr) >= this._flushAt) {
        flushOut();
      }
    } while (r > 0);

    flushOut();
    return _concatUint8Arrays(outChunks, outTotal);
  }

  /**
   * Streaming compression — feed a chunk and return whatever output is
   * available so far. Caller is responsible for sequencing reset/end.
   */
  compressStreamChunk(input: Uint8Array, endOfStream: boolean): Uint8Array {
    if (!this._exports) throw new err('not init');

    const inLen = input.length;
    const outChunks: Uint8Array[] = [];
    let outTotal = 0;

    const flushOut = () => {
      const written = this._readStreamPos(this._outStructPtr);
      if (written > 0) {
        outChunks.push(this._HEAPU8.slice(this._dstPtr, this._dstPtr + written));
        outTotal += written;
      }
      this._writeStreamStruct(this._outStructPtr, this._dstPtr, this._dstCap, 0);
    };

    this._writeStreamStruct(this._outStructPtr, this._dstPtr, this._dstCap, 0);

    const inChunkMax = Math.min(this._maxSrcSize, 1 << 20);
    let inOff = 0;
    while (inOff < inLen) {
      const take = Math.min(inChunkMax, inLen - inOff);
      this._HEAPU8.set(input.subarray(inOff, inOff + take), this._srcPtr);
      this._writeStreamStruct(this._inStructPtr, this._srcPtr, take, 0);
      while (this._readStreamPos(this._inStructPtr) < take) {
        const r = this._exports.compressStreamStep(0);
        if (r < 0) throw new err(`compressStreamStep err ${r >>> 0}`);
        if (this._readStreamPos(this._outStructPtr) >= this._flushAt) {
          flushOut();
        }
      }
      inOff += take;
    }

    if (endOfStream) {
      let r: number;
      do {
        this._writeStreamStruct(this._inStructPtr, this._srcPtr, 0, 0);
        r = this._exports.compressStreamStep(2);
        if (r < 0) throw new err(`compressStreamStep end err ${r >>> 0}`);
        if (this._readStreamPos(this._outStructPtr) >= this._flushAt) {
          flushOut();
        }
      } while (r > 0);
    }

    flushOut();
    return _concatUint8Arrays(outChunks, outTotal);
  }

  /** Reset for a fresh frame; keeps the loaded dictionary. */
  reset(level?: number): void {
    const r = this._exports.initCompressor(_assertLevel1(level ?? this._level));
    if (r < 0) throw new err(`initCompressor err ${r >>> 0}`);
  }

  _destroy(): void {
    //@ts-expect-error gc.
    this._exports = this._HEAPU8 = this._HEAPU32 = null;
  }
}

export default ZstdEncoder;
export { ZstdEncoder, _CODEC_PB_RESET };
export type { EncoderOptions } from './types.js';
