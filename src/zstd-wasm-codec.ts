import type { CodecOptions, CodecWasmExports, StreamResult } from './types.js';
import { _fss, err, _concatUint8Arrays } from './utils.js';

/**
 * ╔════════════════════════════════════════════════════════════════════════════╗
 * ║   ZstdCodec — one WebAssembly instance, one 12 MB buffer, both ways.       ║
 * ╠════════════════════════════════════════════════════════════════════════════╣
 * ║  The wasm module is already a combined codec: a single `_initialize`       ║
 * ║  builds the static ZSTD_DCtx (.bss) *and* bump-allocates the ZSTD_CCtx     ║
 * ║  workspace, and one export set serves both directions. Compress and        ║
 * ║  decompress never run at the same time on one instance (they already       ║
 * ║  share the in/out stream-struct pair), so they *timeshare* one working     ║
 * ║  arena instead of each owning a private 12 MB instance.                    ║
 * ║                                                                            ║
 * ║  Linear memory (fixed, non-growable; sized by the Makefile linker):        ║
 * ║                                                                            ║
 * ║   0x00000  stack (64 KB)                                                   ║
 * ║   0x10000  stream structs: in_buffer(16) + out_buffer(16)  ── shared       ║
 * ║            address = exports.getInBufferPtr()                              ║
 * ║   0x10020  static ZSTD_DCtx (~96 KB) + rodata           ── decode-only     ║
 * ║   0x40000  CCtx cwksp workspace (~1 MB, ZSTD_compressBegin)  ── persistent ║
 * ║      H0    heap cursor after _initialize  ── top of per-instance state     ║
 * ║   ────────────────────────────────────────────────────────────────         ║
 * ║   [ H0 ................................. 12 MB ]  SHARED WORKING ARENA     ║
 * ║                                                                            ║
 * ║  Two invariants keep the two contexts from stepping on each other:         ║
 * ║   • decode's arena starts at H0, so decode never touches [0x40000, H0)     ║
 * ║     — the CCtx workspace survives across decodes.                          ║
 * ║   • compress's workspace starts at 0x40000 (above the DCtx), so            ║
 * ║     compress never touches the DCtx.                                       ║
 * ║                                                                            ║
 * ║  Arena anchors (all relative to _srcPtr === H0):                           ║
 * ║   • _srcPtr    = H0                     shared input anchor (both dirs)    ║
 * ║   • _dstPtrEnc = H0 + maxSrcSize        compress output (cap _dstCap)      ║
 * ║   • _dstPtrDec = H0 + _MAX_SRC_BUF      decompress output                  ║
 * ║                                                                            ║
 * ║  Heap discipline (why the lazily-malloc'd staging never collides):         ║
 * ║   • before streaming compress: setHeapEnd(_dstPtrEnc + _dstCap) so the     ║
 * ║     CStream staging is bump-allocated *above* the compress output,         ║
 * ║     deterministically regardless of a prior decode.                        ║
 * ║   • before decompress: setHeapEnd(_dstPtrDec) so the decoder's inBuff/     ║
 * ║     outBuff land above the decompress output.                              ║
 * ║   • sync compress uses only the committed CCtx workspace (no malloc).      ║
 * ╚════════════════════════════════════════════════════════════════════════════╝
 *
 * Level-9 decoder memory budget reference (windowLog 22 → 4 MB window):
 *   https://github.com/facebook/zstd/blob/release/lib/decompress/zstd_decompress.c#L1980
 */

// Decompressed-input staging region for the decoder side (also the sync
// compressed-input cap): the gap between _srcPtr and _dstPtrDec.
export const _MAX_SRC_BUF = 2 * 1024 * 1024; // 2 MB
// Default sync-decompression output cap; clamped to the linear-memory budget
// at init time (see _maxDstBuf).
const _MAX_DST_BUF_DEFAULT = 9830464; // 9.37 MB
// Margin between end of dst sync buffer and end of linear memory; room for the
// streaming inBuff/outBuff ZSTD_decompressStream may malloc on fallback.
const _DST_BUF_TAIL_MARGIN = 1048576; // 1 MB
// Default max raw input for a single sync compress (sizes the compress src/dst
// buffers). Larger inputs fall back to streaming compression.
const _DEFAULT_MAX_SRC = 4 * 1024 * 1024; // 4 MiB

/** Only compression level 1 is supported: the wasm is built level-1-only
 * (dfast excluded) and its fixed 12 MB layout only has headroom for the
 * level-1 workspace. Reject anything else up front. */
const _assertLevel1 = (level: number): number => {
  if (level !== 1) throw new err(`level ${level} unsupported; only level 1`);
  return level;
};

/** ZSTD_COMPRESSBOUND(srcSize) — upper bound on compressed output. */
const _compressBound = (srcSize: number): number =>
  srcSize + (srcSize >>> 8) + (srcSize < 128 * 1024 ? (128 * 1024 - srcSize) >>> 11 : 0);

class ZstdCodec {
  private _exports!: CodecWasmExports;
  private _HEAPU8!: Uint8Array;
  private _HEAPU32!: Uint32Array;

  /** (in_buffer, out_buffer) struct pair — shared by both directions. */
  private _streamInStructPtr = 0;
  private _streamOutStructPtr = 0;

  private readonly _level: number;
  /** Max raw input for one sync compress; sizes the compress buffers. */
  private readonly _maxSrcSize: number;
  /** Decompression guards (bomb protection); default to a finite floor. */
  private readonly _maxDecSrc: number = 0;
  private readonly _maxDecDst: number = 0;

  // Working-buffer anchors, carved out of the arena after _initialize.
  private _srcPtr = 0; // H0 — shared input anchor
  private _dstPtrEnc = 0; // compress output
  private _dstCap = 0; // compress output capacity
  private _dstPtrDec = 0; // decompress output
  private _maxDstBuf = _MAX_DST_BUF_DEFAULT; // sync-decompress output cap
  /** Drain threshold for the streaming compress dst staging. */
  private _flushAt = 0;

  constructor(options: CodecOptions = {}) {
    // Level is a compress-time concern (compressSync/_compressStream assert it
    // per call); a decode-only codec must not throw just because a level was
    // passed. Store the default; don't validate here.
    this._level = options.level ?? 1;
    this._maxSrcSize = options.maxSrcSize ?? _DEFAULT_MAX_SRC;
    // Coalesce undefined → 0 before Math.max: a bare `new ZstdCodec()` must
    // still get the finite floor, not Math.max(undefined, …) === NaN (which
    // would disable the size / decompression-bomb guards entirely).
    // Use `* 64`, not `<< 6`: JS bitwise ops are signed 32-bit, so a larger
    // default would silently wrap negative and re-disable the guards.
    const floor = _MAX_DST_BUF_DEFAULT * 64;
    this._maxDecSrc = Math.max(options.maxCompressedSize ?? 0, floor);
    this._maxDecDst = Math.max(options.maxDecompressedSize ?? 0, floor);
  }

  /** Initialize against a compiled codec WebAssembly module. */
  init(wasmModule: WebAssembly.Module): ZstdCodec {
    return this._initCommon(new WebAssembly.Instance(wasmModule, { env: {} }));
  }

  /** Initialize against an existing WebAssembly instance. */
  _initWithInstance(
    wasmInstance: WebAssembly.Instance,
    _wasmModule?: WebAssembly.Module,
  ): ZstdCodec {
    return this._initCommon(wasmInstance);
  }

  private _initCommon(wasmInstance: WebAssembly.Instance): ZstdCodec {
    this._exports = wasmInstance.exports as unknown as CodecWasmExports;
    const _memory = this._exports.memory as WebAssembly.Memory;
    this._HEAPU8 = new Uint8Array(_memory.buffer);
    this._HEAPU32 = new Uint32Array(_memory.buffer);

    // Builds both DCtx and CCtx; leaves heap_cursor at H0 (top of CCtx wksp).
    this._exports._initialize();

    this._streamInStructPtr = this._exports.getInBufferPtr();
    this._streamOutStructPtr = this._streamInStructPtr + 16;

    // First malloc after _initialize returns H0. Reserving the compress
    // src+dst here also gives us the bounds check for free: an over-budget
    // maxSrcSize makes the bump allocator return 0, which we surface as OOM
    // rather than corrupting low memory on the first compress.
    this._srcPtr = this._exports.malloc(this._maxSrcSize);
    this._dstCap = _compressBound(this._maxSrcSize);
    this._dstPtrEnc = this._exports.malloc(this._dstCap);
    if (!this._srcPtr || !this._dstPtrEnc) {
      throw new err('oom: maxSrcSize too large for wasm memory');
    }

    // Decode output anchor: fixed 2 MB compressed-input region below it (the
    // decode streaming loop stages input/output within [_srcPtr, _dstPtrDec)).
    this._dstPtrDec = this._srcPtr + _MAX_SRC_BUF;
    this._maxDstBuf = Math.min(
      _MAX_DST_BUF_DEFAULT,
      this._HEAPU8.byteLength - this._dstPtrDec - _DST_BUF_TAIL_MARGIN,
    );

    // Drain when the compress dst staging is at least half-full (or 128 KB if
    // larger). Math.max guards tiny _dstCap configs from going negative.
    this._flushAt = Math.max(0, this._dstCap - Math.min(this._dstCap >>> 1, 1 << 17));
    return this;
  }

  /** Optimized struct write using Uint32Array (JIT-friendly when aligned). */
  private _writeStreamStruct(ptr: number, bufPtr: number, size: number, pos = 0): void {
    const i = ptr >>> 2;
    this._HEAPU32[i] = bufPtr;
    this._HEAPU32[i + 1] = size;
    this._HEAPU32[i + 2] = pos;
  }

  private _readStreamPos(ptr: number): number {
    return this._HEAPU32[(ptr + 8) >>> 2];
  }

  // ===== Compress ========================================================

  /**
   * Single-shot compression. Returns a freshly-allocated Uint8Array.
   * Falls back to streaming when the input exceeds maxSrcSize.
   */
  compressSync(input: Uint8Array, level?: number): Uint8Array {
    if (!this._exports) throw new err('not init');
    const srcSize = input.length;
    if (srcSize > this._maxSrcSize) return this._compressStream(input, true, level);

    // Sync compress uses the committed CCtx workspace (below H0); no heap
    // allocation, so no setHeapEnd needed even after a prior decode.
    this._HEAPU8.set(input, this._srcPtr);
    const lvl = _assertLevel1(level ?? this._level);
    const r = this._exports.compress(this._dstPtrEnc, this._dstCap, this._srcPtr, srcSize, lvl);
    if (r < 0) throw new err(`compress err ${r >>> 0}`);
    return this._HEAPU8.slice(this._dstPtrEnc, this._dstPtrEnc + r);
  }

  /**
   * Internal streaming compress engine — not part of the public API. Drains
   * the input and ends the frame, returning the full compressed output. Used
   * only as the fallback for compressSync when input exceeds maxSrcSize.
   */
  _compressStream(input: Uint8Array, reset = true, level?: number): Uint8Array {
    if (!this._exports) throw new err('not init');

    const lvl = _assertLevel1(level ?? this._level);
    if (reset) {
      // Anchor the CStream staging buffers (lazily malloc'd on first stream
      // step) *above* the compress output, so they never collide with the
      // decode arena — regardless of where a prior decode left the cursor.
      this._exports.setHeapEnd(this._dstPtrEnc + this._dstCap);
      const r = this._exports.initCompressor(lvl);
      if (r < 0) throw new err(`initCompressor err ${r >>> 0}`);
    }

    const inLen = input.length;
    const outChunks: Uint8Array[] = [];
    let outTotal = 0;

    const inChunkMax = Math.min(this._maxSrcSize, 1 << 20); // 1 MiB at a time
    let inOff = 0;

    const flushOut = () => {
      const written = this._readStreamPos(this._streamOutStructPtr);
      if (written > 0) {
        outChunks.push(this._HEAPU8.slice(this._dstPtrEnc, this._dstPtrEnc + written));
        outTotal += written;
      }
      this._writeStreamStruct(this._streamOutStructPtr, this._dstPtrEnc, this._dstCap, 0);
    };

    this._writeStreamStruct(this._streamOutStructPtr, this._dstPtrEnc, this._dstCap, 0);

    while (inOff < inLen) {
      const take = Math.min(inChunkMax, inLen - inOff);
      this._HEAPU8.set(input.subarray(inOff, inOff + take), this._srcPtr);
      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, take, 0);

      while (this._readStreamPos(this._streamInStructPtr) < take) {
        const r = this._exports.compressStreamStep(0); // ZSTD_e_continue
        if (r < 0) throw new err(`compressStreamStep err ${r >>> 0}`);
        if (this._readStreamPos(this._streamOutStructPtr) >= this._flushAt) flushOut();
      }
      inOff += take;
    }

    // End-of-frame.
    let r: number;
    do {
      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, 0, 0);
      r = this._exports.compressStreamStep(2); // ZSTD_e_end
      if (r < 0) throw new err(`compressStreamStep end err ${r >>> 0}`);
      if (this._readStreamPos(this._streamOutStructPtr) >= this._flushAt) flushOut();
    } while (r > 0);

    flushOut();
    return _concatUint8Arrays(outChunks, outTotal);
  }

  // ===== Decompress ======================================================

  /**
   * Simple API: decompress a buffer synchronously. Falls back to the internal
   * streaming engine when the expected size is not hinted in advance or is
   * too large for the sync dst buffer.
   *
   * Limitation — concatenated multi-frame input: the output size is inferred
   * via `_fss`, which reads only the FIRST frame's declared Frame_Content_Size.
   * When several frames are concatenated and that first frame declares a size
   * within the sync buffer (`_maxDstBuf`, ~9.4 MB) while the compressed input
   * stays under `_MAX_SRC_BUF` (2 MB), the single-pass path is chosen — but the
   * *total* decompressed output across all frames can exceed the ~9.4 MB sync
   * buffer (e.g. many highly-compressible frames). In that case the decode
   * throws a clean `dec err` (dstSize_tooSmall) rather than returning partial
   * or corrupt bytes; it never silently truncates. A single frame is never
   * affected — its own declared/unknown size routes large outputs to streaming.
   * Callers that decode externally-concatenated, high-ratio streams of unknown
   * total size should not rely on this method for those inputs.
   */
  decompressSync(compressedData: Uint8Array, expectedSize?: number): Uint8Array {
    if (!this._exports) throw new err('not init');

    const srcSize = compressedData.length;
    if (srcSize > this._maxDecSrc) throw new err(`comp dat>maxSrcSize lim`);

    if (!expectedSize) expectedSize = _fss(compressedData);

    // No expected size, or above the sync thresholds => stream. Complete
    // one-shot decode, so require the frame to finish.
    if (expectedSize === 0 || expectedSize > this._maxDstBuf || srcSize > _MAX_SRC_BUF) {
      return this._decompressStream(compressedData, true, true).buf;
    }

    const dstPtr = this._dstPtrDec;
    this._exports.setHeapEnd(dstPtr);
    this._HEAPU8.set(compressedData as Uint8Array, this._srcPtr);
    const result = this._exports.decompress(dstPtr, this._maxDstBuf, this._srcPtr, srcSize);
    if (result < 0) throw new err(`dec err ${result}`);
    return this._HEAPU8.slice(dstPtr, dstPtr + result);
  }

  /**
   * Internal streaming decompress engine — not part of the public API. Fed the
   * whole input at once with final=true for one-shot decodes.
   */
  _decompressStream(input: Uint8Array, reset = false, final = false): StreamResult {
    if (!this._exports) throw new err('not init');

    if (reset) {
      // Reset stream state and anchor the decoder's inBuff/outBuff above the
      // decompress output.
      this._exports.resetDecoder();
      this._exports.setHeapEnd(this._dstPtrDec);
    }
    const inLen = input.length || 0;
    // Fresh object per call — a shared singleton could be mutated by a caller.
    if (inLen == 0) return { buf: new Uint8Array(0), in_offset: 0 };

    const output: Uint8Array[] = [];
    let totalOutputSize = 0;
    let offset = 0;

    // Stage input at _srcPtr; accumulate decoded output just above it, both
    // within the [_srcPtr, _dstPtrDec) 2 MB compressed-input region.
    const dstBufStart = this._srcPtr + 262150;
    let dstOffset = dstBufStart;
    const dstMaxBuf = dstBufStart + 655360;
    let lastOut = 0;
    let lastHint = 0;
    while (offset < inLen) {
      // ZSTD_BLOCKSIZE_MAX + ZSTD_BLOCKHEADERSIZE (131072 + 3) x 2 == 262150
      const toProcess = Math.min(inLen - offset, 262150);
      this._HEAPU8.set((input as Uint8Array).subarray(offset, offset + toProcess), this._srcPtr);

      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, toProcess);

      if (dstOffset == dstBufStart) {
        this._writeStreamStruct(this._streamOutStructPtr, dstOffset, 917501);
      }

      while (this._readStreamPos(this._streamInStructPtr) < toProcess) {
        const result = this._exports.decompressStreamStep();
        if (result < 0) throw new err(`dec err ${result}`);
        lastHint = result;

        const outputPos = this._readStreamPos(this._streamOutStructPtr);

        totalOutputSize += dstOffset == dstBufStart ? outputPos : outputPos - lastOut;
        lastOut = outputPos;
        if (outputPos > 0) {
          dstOffset = dstBufStart + outputPos;

          if (dstOffset >= dstMaxBuf) {
            output.push(this._HEAPU8.slice(dstBufStart, dstOffset));
            dstOffset = dstBufStart;
            this._writeStreamStruct(this._streamOutStructPtr, dstOffset, 917501);
          }

          if (totalOutputSize > this._maxDecDst) {
            throw new err(`dec size>maxDstSize lim`);
          }
        }
      }
      offset += toProcess;
    }

    if (dstOffset != dstBufStart) output.push(this._HEAPU8.slice(dstBufStart, dstOffset));

    // One-shot callers hand us the whole input at once: still mid-frame after
    // consuming all of it means the frame was truncated.
    if (final && lastHint !== 0) throw new err(`truncated: incomplete frame`);

    return { buf: _concatUint8Arrays(output, totalOutputSize), in_offset: inLen };
  }

  _destroy(): void {
    //@ts-expect-error gc.
    this._exports = this._HEAPU8 = this._HEAPU32 = null;
  }
}

export default ZstdCodec;
export { ZstdCodec };
export type { CodecOptions, StreamResult } from './types.js';
