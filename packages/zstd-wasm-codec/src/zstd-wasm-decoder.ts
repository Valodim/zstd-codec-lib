import type { CodecWasmExports, DecoderOptions, StreamResult } from './types.js';
import { _fss, err, _concatUint8Arrays } from './utils.js';
/**
 * Linear memory layout (fixed, non-growable; sized in the Makefile linker
 * flags — see LDFLAGS_BASE):
 *
 *   [stack | stream structs | rodata | CCtx workspace | DCtx (~96 KB) |
 *    ddict ptr (4b) | optional dict (≤ 2 MB) | src buf (2 MB) | dst buf ]
 *
 * Total 12 MB, 64 KB stack. The decoder caps maxWindowSize at 2 MB so the
 * dst buffer cap is clamped by _maxDstBuf at init time.
 *
 * Stream-struct location is queried at init via the wasm's `getInBufferPtr`
 * export — the codec build's 64 KB stack pushes them past the decoder-only
 * build's old fixed 0x2000 offset.
 *
 * Memory management strategy: JS owns srcPtr / dstPtr and resets them per
 * decompression instead of calling free. The bump-style `malloc` is only
 * used at init for the dict + src buffer. Inputs/outputs larger than the
 * sync buffers automatically fall back to streaming decompression.
 *
 * Level-19 memory budget reference:
 *   https://github.com/facebook/zstd/blob/release/lib/decompress/zstd_decompress.c#L1980
 *   Total = blockSize + (windowSize + 2*blockSize + 2*WILDCOPY_OVERLENGTH)
 *   = 128 KB + 8 MB + 256 KB + 64 B ≈ 8.4 MB
 *
 * Other refs:
 *   https://github.com/facebook/zstd/blob/release/doc/decompressor_errata.md
 *   https://github.com/facebook/zstd/blob/release/doc/decompressor_permissive.md
 *   https://facebook.github.io/zstd/zstd_manual.html
 */

export const _MAX_SRC_BUF = 2 * 1024 * 1024; // 2 MB input buffer
// Default sync-decompression cap for the level-19 layout (8MB window +
// 3*128KB blocks + ~1MB margin). The actual cap is clamped to fit the
// linear-memory budget at init time.
const _MAX_DST_BUF_DEFAULT = 9830464; // 9.37 MB
// Margin between end of dst sync buffer and end of linear memory; leaves
// room for the streaming inBuff/outBuff that ZSTD_decompressStream may
// allocate via malloc when sync mode falls back.
const _DST_BUF_TAIL_MARGIN = 1048576; // 1 MB
const _STREAM_RESULT: StreamResult = { buf: new Uint8Array(0), in_offset: 0 };
class ZstdDecoder {
  private _exports!: CodecWasmExports;
  private _HEAPU8!: Uint8Array;
  private _HEAPU32!: Uint32Array;
  /** Stream-struct location is provided by the wasm via getInBufferPtr at init. */
  private _streamInputStructPtr: number = 0;
  private _streamOutputStructPtr: number = 0;

  private readonly _dictionary?: Uint8Array;
  private readonly _maxSrcSize: number = 0;
  private readonly _maxDstSize: number = 0;


  // Memory pointers - they are tracked primarly here.
  // For the period of an ongoing streaming decompression, they are also tracked within ZSTD_dctx
  private _srcPtr: number = 0;
  private _dstPtr: number = 0;
  private _maxDstBuf: number = _MAX_DST_BUF_DEFAULT;

  constructor(options: DecoderOptions = {}) {
    this._dictionary = options.dictionary
    this._maxSrcSize = Math.max(options.maxSrcSize!, _MAX_DST_BUF_DEFAULT << 6)
    this._maxDstSize = Math.max(options.maxDstSize!, _MAX_DST_BUF_DEFAULT << 6)
  }

  /**
   * Initialize with a compiled WebAssembly module
   */
  init(wasmModule: WebAssembly.Module): ZstdDecoder {
    return this._initCommon(new WebAssembly.Instance(wasmModule, { env: {} }));
  }

  /**
   * Initialize with an existing WebAssembly instance
   */
  _initWithInstance(
    wasmInstance: WebAssembly.Instance,
    _wasmModule?: WebAssembly.Module,
  ): ZstdDecoder {
    return this._initCommon(wasmInstance);
  }

  private _initCommon(wasmInstance: WebAssembly.Instance): ZstdDecoder {
    this._exports = wasmInstance.exports as unknown as CodecWasmExports;
    const _memory = this._exports.memory as WebAssembly.Memory;

    this._HEAPU8 = new Uint8Array(_memory.buffer);
    this._HEAPU32 = new Uint32Array(_memory.buffer);

    this._streamInputStructPtr = this._exports.getInBufferPtr();
    this._streamOutputStructPtr = this._streamInputStructPtr + 16;

    this._exports._initialize();

    // Initialize dictionary if provided
    if (this._dictionary) {
      const _dictLen = this._dictionary.length;
      if (_dictLen > _MAX_SRC_BUF) {
        throw new err('dict>2mb');
      }
      const dictPtr = this._exports.malloc(_dictLen);
      this._HEAPU8.set(this._dictionary as Uint8Array, dictPtr);
      this._exports.loadDecoderDict(dictPtr, _dictLen);
    }
    this._srcPtr = this._exports.malloc(_MAX_SRC_BUF);
    this._dstPtr = this._srcPtr + _MAX_SRC_BUF; // We don't malloc dst buf. Its where dst buf starts. Zstd will malloc
    // Cap the sync-decompression buffer at whatever the linear memory
    // can actually hold (12 MB total minus CCtx workspace + src buf,
    // so the 9.4 MB default may need clamping).
    this._maxDstBuf = Math.min(
      _MAX_DST_BUF_DEFAULT,
      this._HEAPU8.byteLength - this._dstPtr - _DST_BUF_TAIL_MARGIN,
    );
    return this;
  }

  /**
   * Simple API: Decompress a buffer synchronously
   * Falls back to asynchronous compression if the expected size
   * is not hinted in advance.
   *
   * @param compressedData - Compressed data
   * @param expectedSize - Optional expected decompressed size. If not provided, falls back to streaming.
   * @returns Decompressed data
   */
  decompressSync(compressedData: Uint8Array, expectedSize?: number): Uint8Array {
    if (!this._exports) throw new err('not init');

    const srcSize = compressedData.length;

    if (srcSize > this._maxSrcSize) {
      throw new err(`comp dat>maxSrcSize lim`);
    }

    if (!expectedSize) expectedSize = _fss(compressedData);

    // No expected size, or above thresholds for single pass => Use streaming
    if (expectedSize === 0 || expectedSize > this._maxDstBuf || srcSize > _MAX_SRC_BUF) {
      return this.decompressStream(compressedData, true).buf;
    }

    const _dstPtr = this._dstPtr;
    this._exports.setHeapEnd(_dstPtr);
    this._HEAPU8.set(compressedData as Uint8Array, this._srcPtr);
    const result = this._exports.decompress(_dstPtr, this._maxDstBuf, this._srcPtr, srcSize);

    if (result < 0) {
      throw new err(`dec err ${result}`);
    }
    return this._HEAPU8.slice(_dstPtr, _dstPtr + result);
  }

  /**
   * Optimized struct write using Uint32Array when properly aligned / (JIT)
   */
  private _writeStreamStruct(ptr: number, bufPtr: number, size: number): void {
    const u32Index = ptr >>> 2;
    this._HEAPU32[u32Index] = bufPtr;
    this._HEAPU32[u32Index + 1] = size;
    this._HEAPU32[u32Index + 2] = 0;
  }

  /**
   * Optimized struct read using Uint32Array
   */
  private _readStreamPos(ptr: number): number {
    return this._HEAPU32[(ptr + 8) >>> 2];
  }

  /**
   * Streadming decompression - can be fed chunks incrementally
   *
   * @param input - Input chunk
   * @param reset - Reset stream for new decompression (default: false)
   * @returns Decompression result with buffer, code, and input offset
   */
  decompressStream(input: Uint8Array, reset = false): StreamResult {
    if (!this._exports) throw new err('not init');

    // Reset stream state for new decompression - ZSTD_reset_session_only = 1
    if (reset) {
      this._exports.resetDecoder();
      this._exports.setHeapEnd(this._dstPtr);
    }
    const inLen = input.length || 0;
    if (inLen == 0) return _STREAM_RESULT;

    const output: Uint8Array[] = [];

    let totalOutputSize = 0;
    let offset = 0;

    // Assuming 4-8x compressability in the average case
    // Write to src buf less.
    // Let 1mb - 128kb out buf accumulate before we flush it out back to js
    const dstBufStart = this._srcPtr + 262150;
    let dstOffset = dstBufStart;
    const dstMaxBuf = dstBufStart + 655360;
    let lastOut = 0;
    while (offset < inLen) {
      //ZSTD_BLOCKSIZE_MAX + ZSTD_BLOCKHEADERSIZE (131072 + 3) x 2 == 262150
      const toProcess = Math.min(inLen - offset, 262150);
      this._HEAPU8.set((input as Uint8Array).subarray(offset, offset + toProcess), this._srcPtr);

      this._writeStreamStruct(this._streamInputStructPtr, this._srcPtr, toProcess);

      if (dstOffset == dstBufStart) {
        this._writeStreamStruct(this._streamOutputStructPtr, dstOffset, 917501);
      }

      // Process all data in current block
      while (this._readStreamPos(this._streamInputStructPtr) < toProcess) {
        const result = this._exports.decompressStreamStep();
        if (result < 0) throw new err(`dec err ${result}`);

        const outputPos = this._readStreamPos(this._streamOutputStructPtr);

        totalOutputSize += dstOffset == dstBufStart ? outputPos : outputPos - lastOut;
        lastOut = outputPos;
        if (outputPos > 0) {
          dstOffset = dstBufStart + outputPos;

          if (dstOffset >= dstMaxBuf) {
            output.push(this._HEAPU8.slice(dstBufStart, dstOffset));
            dstOffset = dstBufStart;
            this._writeStreamStruct(this._streamOutputStructPtr, dstOffset, 917501);
          }

          if (totalOutputSize > this._maxDstSize) {
            throw new err(
              `dec size>maxDstSize lim`,
            );
          }
        }
      }
      offset += toProcess;
    }

    // Flush remaining chunk
    if (dstOffset != dstBufStart) output.push(this._HEAPU8.slice(dstBufStart, dstOffset));

    return {
      buf: _concatUint8Arrays(output, totalOutputSize),
      in_offset: inLen,
    };
  }

  /**
   * Clean up ZSTD context
   */
  _destroy(): void {
    //@ts-expect-error gc.
    this._exports = this._HEAPU8 = this._HEAPU32 = null;
  }
}

export default ZstdDecoder;
export { ZstdDecoder };
export type { DecoderOptions, StreamResult } from './types.js';
