import type { CodecOptions, StreamResult } from './types.js';
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
export declare const _MAX_SRC_BUF: number;
declare class ZstdCodec {
    private _exports;
    private _HEAPU8;
    private _HEAPU32;
    /** (in_buffer, out_buffer) struct pair — shared by both directions. */
    private _streamInStructPtr;
    private _streamOutStructPtr;
    private readonly _level;
    /** Max raw input for one sync compress; sizes the compress buffers. */
    private readonly _maxSrcSize;
    /** Decompression guards (bomb protection); default to a finite floor. */
    private readonly _maxDecSrc;
    private readonly _maxDecDst;
    private _srcPtr;
    private _dstPtrEnc;
    private _dstCap;
    private _dstPtrDec;
    private _maxDstBuf;
    /** Drain threshold for the streaming compress dst staging. */
    private _flushAt;
    constructor(options?: CodecOptions);
    /** Initialize against a compiled codec WebAssembly module. */
    init(wasmModule: WebAssembly.Module): ZstdCodec;
    /** Initialize against an existing WebAssembly instance. */
    _initWithInstance(wasmInstance: WebAssembly.Instance, _wasmModule?: WebAssembly.Module): ZstdCodec;
    private _initCommon;
    /** Optimized struct write using Uint32Array (JIT-friendly when aligned). */
    private _writeStreamStruct;
    private _readStreamPos;
    /**
     * Single-shot compression. Returns a freshly-allocated Uint8Array.
     * Falls back to streaming when the input exceeds maxSrcSize.
     *
     * Not equivalent to routing through _compressStream — kept as the fast path:
     *  • ZSTD_compressCCtx pledges srcSize, so the frame header carries the
     *    Frame_Content_Size. The streaming path leaves FCS unknown, which would
     *    defeat decompressSync's _fss fast-path detection on self-round-trips.
     *  • uses only the committed CCtx workspace: no lazily-malloc'd CStream
     *    staging, no setHeapEnd, no chunk concatenation.
     */
    compressSync(input: Uint8Array, level?: number): Uint8Array;
    /**
     * Internal streaming compress engine — not part of the public API. Drains
     * the input and ends the frame, returning the full compressed output. Used
     * only as the fallback for compressSync when input exceeds maxSrcSize.
     *
     * Safe only because it runs to completion within one call. Exposing it for
     * incremental use (reset=false across calls) would require concurrency
     * discipline: it shares the in/out stream structs, the singleton cctx/dctx,
     * and the _srcPtr arena + heap cursor with the decode engine, so a second
     * op interleaved into a partial stream corrupts all three. Only one stream
     * may be in flight per instance.
     */
    _compressStream(input: Uint8Array, reset?: boolean, level?: number): Uint8Array;
    /**
     * Simple API: decompress a buffer synchronously. Falls back to the internal
     * streaming engine when the expected size is not hinted in advance or is
     * too large for the sync dst buffer.
     *
     * Not equivalent to _decompressStream — kept as the fast path: the C
     * `decompress`/`dm` runs ZSTD_decompressFrame straight into the destination,
     * with no window-sized inBuff/outBuff allocation, no copy through staging, and
     * no chunk concatenation. The streaming engine incurs all three.
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
    decompressSync(compressedData: Uint8Array, expectedSize?: number): Uint8Array;
    /**
     * Internal streaming decompress engine — not part of the public API. Fed the
     * whole input at once with final=true for one-shot decodes.
     *
     * Safe only because it runs to completion within one call. Exposing it for
     * incremental use (reset=false across calls) would require concurrency
     * discipline: it shares the in/out stream structs, the singleton dctx/cctx,
     * and the _srcPtr arena + heap cursor with the compress engine, so a second
     * op interleaved into a partial stream corrupts all three. Only one stream
     * may be in flight per instance.
     */
    _decompressStream(input: Uint8Array, reset?: boolean, final?: boolean): StreamResult;
    _destroy(): void;
}
export default ZstdCodec;
export { ZstdCodec };
export type { CodecOptions, StreamResult } from './types.js';
//# sourceMappingURL=zstd-wasm-codec.d.ts.map