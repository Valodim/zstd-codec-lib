import type { DecoderOptions, StreamResult } from './types.js';
/**
 * Linear memory layout (fixed, non-growable; sized in the Makefile linker
 * flags — see LDFLAGS_BASE):
 *
 *   [stack | stream structs | rodata | CCtx workspace | DCtx (~96 KB) |
 *    src buf (2 MB) | dst buf ]
 *
 * Total 12 MB, 64 KB stack. The decoder caps maxWindowSize at 4 MB + 1
 * (ZSTD_WASM_MAX_WINDOW_SIZE — level 9, windowLog 22) so the dst buffer cap
 * is clamped by _maxDstBuf at init time.
 *
 * Stream-struct location is queried at init via the wasm's `getInBufferPtr`
 * export — the codec build's 64 KB stack pushes them past the decoder-only
 * build's old fixed 0x2000 offset.
 *
 * Memory management strategy: JS owns srcPtr / dstPtr and resets them per
 * decompression instead of calling free. The bump-style `malloc` is only
 * used at init for the src buffer. Inputs/outputs larger than the
 * sync buffers automatically fall back to streaming decompression.
 *
 * Level-9 memory budget reference (windowLog 22 → 4 MB window):
 *   https://github.com/facebook/zstd/blob/release/lib/decompress/zstd_decompress.c#L1980
 *   Total = blockSize + (windowSize + 2*blockSize + 2*WILDCOPY_OVERLENGTH)
 *   = 128 KB + (4 MB + 256 KB + 16 B) ≈ 4.4 MB
 *
 * Other refs:
 *   https://github.com/facebook/zstd/blob/release/doc/decompressor_errata.md
 *   https://github.com/facebook/zstd/blob/release/doc/decompressor_permissive.md
 *   https://facebook.github.io/zstd/zstd_manual.html
 */
export declare const _MAX_SRC_BUF: number;
declare class ZstdDecoder {
    private _exports;
    private _HEAPU8;
    private _HEAPU32;
    /** Stream-struct location is provided by the wasm via getInBufferPtr at init. */
    private _streamInputStructPtr;
    private _streamOutputStructPtr;
    private readonly _maxSrcSize;
    private readonly _maxDstSize;
    private _srcPtr;
    private _dstPtr;
    private _maxDstBuf;
    constructor(options?: DecoderOptions);
    /**
     * Initialize with a compiled WebAssembly module
     */
    init(wasmModule: WebAssembly.Module): ZstdDecoder;
    /**
     * Initialize with an existing WebAssembly instance
     */
    _initWithInstance(wasmInstance: WebAssembly.Instance, _wasmModule?: WebAssembly.Module): ZstdDecoder;
    private _initCommon;
    /**
     * Simple API: Decompress a buffer synchronously
     * Falls back to asynchronous compression if the expected size
     * is not hinted in advance.
     *
     * @param compressedData - Compressed data
     * @param expectedSize - Optional expected decompressed size. If not provided, falls back to streaming.
     * @returns Decompressed data
     */
    decompressSync(compressedData: Uint8Array, expectedSize?: number): Uint8Array;
    /**
     * Optimized struct write using Uint32Array when properly aligned / (JIT)
     */
    private _writeStreamStruct;
    /**
     * Optimized struct read using Uint32Array
     */
    private _readStreamPos;
    /**
     * Internal streaming engine — not part of the public API. Kept private so
     * `decompressSync` can transparently fall back to it for payloads larger
     * than the sync dst buffer, and so the pooled one-shot `decompress` helper
     * can drive it. Fed the whole input at once with `final = true`.
     *
     * @param input - Input chunk
     * @param reset - Reset stream for new decompression (default: false)
     * @param final - Treat `input` as the complete remaining input: after it is
     *   consumed the current frame must have ended, else the data was truncated
     *   and we throw.
     * @returns Decompression result with buffer, code, and input offset
     */
    _decompressStream(input: Uint8Array, reset?: boolean, final?: boolean): StreamResult;
    /**
     * Clean up ZSTD context
     */
    _destroy(): void;
}
export default ZstdDecoder;
export { ZstdDecoder };
export type { DecoderOptions, StreamResult } from './types.js';
//# sourceMappingURL=zstd-wasm-decoder.d.ts.map