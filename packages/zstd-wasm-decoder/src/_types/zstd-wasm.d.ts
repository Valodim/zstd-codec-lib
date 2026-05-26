import type { DecoderOptions, StreamResult } from './types.js';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                        Memory Layout                         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   0x0000   ┌────────────────────────────────────┐            ║
 * ║            │      Stack Space (8 KB)            │            ║
 * ║   0x2000   ├────────────────────────────────────┤            ║
 * ║            │  Stream Structs (32 bytes):        │            ║
 * ║            │    ┌─────────────────────────┐     │            ║
 * ║            │    │ ZSTD_inBuffer (16b)     │     │            ║
 * ║            │    │ - srcPtr  (4 bytes)     │     │            ║
 * ║            │    │ - size    (4 bytes)     │     │            ║
 * ║            │    │ - pos     (4 bytes)     │     │            ║
 * ║            │    │ - pad     (4 bytes)     │     │            ║
 * ║            │    ├─────────────────────────┤     │            ║
 * ║            │    │ ZSTD_outBuffer (16b)    │     │            ║
 * ║            │    │ - dstPtr  (4 bytes)     │     │            ║
 * ║            │    │ - size    (4 bytes)     │     │            ║
 * ║            │    │ - pos     (4 bytes)     │     │            ║
 * ║            │    │ - pad     (4 bytes)     │     │            ║
 * ║            │    └─────────────────────────┘     │            ║
 * ║   0x2020   ├────────────────────────────────────┤            ║
 * ║            │   ZSTD_DCtx Context (~96 KB)       │            ║
 * ║            │   (Decompression context +         │            ║
 * ║            │    64kb workspace)                 │            ║
 * ║  0x19660   ├────────────────────────────────────┤            ║
 * ║            │   Read-only constants  2208b       │            ║
 * ║  0x19f00   ├────────────────────────────────────┤            ║
 * ║            │   ZSTD_DDict Ptr    (4b)           │            ║
 * ║  0x19f04   ├────────────────────────────────────┤            ║
 * ║            │   Dictionary (optional)            │            ║
 * ║            │   (up to 2 MB)                     │            ║
 * ║            │   (only allocated if provided)     │            ║
 * ║    +2MB    ├────────────────────────────────────┤            ║
 * ║            │    Source Buffer (2 MB)            │            ║
 * ║            │    (Compressed input staging)      │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │    Destination Buffer (8.4 MB)     │            ║
 * ║            │    + 1mb margin                    │            ║
 * ║            │  Sized for level 19 compression:   │            ║
 * ║            │  windowSize (8MB) + 3*blockSize    │            ║
 * ║            │  (384KB) + 64 bytes                │            ║
 * ║  +9.4MB    └────────────────────────────────────┘            ║
 * ║                                                              ║
 * ║ Total: ~13.5 MB (with dict), ~11.5 MB (without dict)         ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║                         Notes                                ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║ • This memory layout supports decompression of files         ║
 * ║   compressed at any level up to lvl 19                       ║
 * ║                                                              ║
 * ║ • Input/output does NOT have to fit within these buffer      ║
 * ║   limits. As long as user-configured maxSrcSize & maxDstSize ║
 * ║   aren't crossing the limits, we can decompress arbitrarily  ║
 * ║   large files through streaming                              ║
 * ║                                                              ║
 * ║ • For small files that fit in the buffers, we use fast sync  ║
 * ║   decompression. For larger files, we automatically fallback ║
 * ║   to streaming decompression                                 ║
 * ║                                                              ║
 * ║ • Memory is managed primarily from JS by resetting buffer    ║
 * ║   pointers back to dstPtr at every initialized               ║
 * ║   decompression, avoiding WASM heap growth                   ║
 * ║                                                              ║
 * ║ • The WASM memory can grow into the JS runtime if needed,    ║
 * ║   but we size the initial allocation to handle most common   ║
 * ║   cases without heap growth needed at all                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
/**
 *    https://github.com/facebook/zstd/blob/release/lib/decompress/zstd_decompress.c#L1980
 *
 *    Level 19 memory requirements:
 *
 *  - windowSize:          8 MB     8 * 1024 * 1024 bytes
 *
 *  - 3 * blockSize:     384 KB     3 * 128 KB = 384 KB = 3 * 131072 bytes
 *
 *  - Safety margin:   64 bytes     for fast memcpy functions that may
 *                                  read/write slightly out of bounds
 *
 *    Total Memory = blockSize + (windowSize + 2 * blockSize + 2 * WILDCOPY_OVERLENGTH)
 *
 *
 *    Other relevant sources:
 *      - Zstandard decompressor errata:
 *          https://github.com/facebook/zstd/blob/release/doc/decompressor_errata.md
 *      - Permissiveness / Edge-Cases:
 *          https://github.com/facebook/zstd/blob/release/doc/decompressor_permissive.md
 *      - Zstd manual:
 *          https://facebook.github.io/zstd/zstd_manual.html
 */
export declare const _MAX_SRC_BUF: number;
declare class ZstdDecoder {
    private _exports;
    private _HEAPU8;
    private _HEAPU32;
    /**
     * Stream-struct offsets are 8192 in the decoder-only build (matches the
     * 8KB stack + global-base layout). The codec build moves them up because
     * its stack is bigger; in that case the wasm exports `getInBufferPtr` and
     * we query it at init time.
     */
    private _streamInputStructPtr;
    private _streamOutputStructPtr;
    private readonly _dictionary?;
    private readonly _maxSrcSize;
    private readonly _maxDstSize;
    private _srcPtr;
    private _dstPtr;
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
     * Streadming decompression - can be fed chunks incrementally
     *
     * @param input - Input chunk
     * @param reset - Reset stream for new decompression (default: false)
     * @returns Decompression result with buffer, code, and input offset
     */
    decompressStream(input: Uint8Array, reset?: boolean): StreamResult;
    /**
     * Clean up ZSTD context
     */
    _destroy(): void;
}
export default ZstdDecoder;
export { ZstdDecoder };
export type { DecoderOptions, StreamResult } from './types.js';
//# sourceMappingURL=zstd-wasm.d.ts.map