import type { EncoderOptions } from './types.js';
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
 * ║            │   (~3-4 MB at level 3)             │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │   Dictionary (optional)            │            ║
 * ║            ├────────────────────────────────────┤            ║
 * ║            │   Source buffer (compressing)      │            ║
 * ║            │   Destination buffer               │            ║
 * ║            │     For compress:    ~src + bound  │            ║
 * ║            │     For decompress:  9.4 MB        │            ║
 * ║   ~32 MB   └────────────────────────────────────┘            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
declare const _CODEC_PB_RESET = 262144;
declare class ZstdEncoder {
    private _exports;
    private _HEAPU8;
    private _HEAPU32;
    private readonly _dictionary?;
    private readonly _level;
    private readonly _maxSrcSize;
    /** Address of the (in_buffer, out_buffer) struct pair within wasm memory. */
    private _inStructPtr;
    private _outStructPtr;
    /** Stable working buffers carved out of wasm memory after _initialize. */
    private _srcPtr;
    private _dstPtr;
    private _dstCap;
    /** Drain threshold for the streaming dst staging buffer. */
    private _flushAt;
    constructor(options?: EncoderOptions);
    /** Initialize against a compiled codec WebAssembly module. */
    init(wasmModule: WebAssembly.Module): ZstdEncoder;
    _initWithInstance(wasmInstance: WebAssembly.Instance): ZstdEncoder;
    private _initCommon;
    /**
     * Single-shot compression. Returns a freshly-allocated Uint8Array.
     *
     * Falls back to streaming when the input exceeds maxSrcSize.
     */
    compressSync(input: Uint8Array, level?: number): Uint8Array;
    private _writeStreamStruct;
    private _readStreamPos;
    /**
     * Streaming compression — drains the input and ends the frame, returning
     * the full compressed output. Use ZstdCompressionStream for incremental.
     */
    compressStream(input: Uint8Array, reset?: boolean, level?: number): Uint8Array;
    /**
     * Streaming compression — feed a chunk and return whatever output is
     * available so far. Caller is responsible for sequencing reset/end.
     */
    compressStreamChunk(input: Uint8Array, endOfStream: boolean): Uint8Array;
    /** Reset for a fresh frame; keeps the loaded dictionary. */
    reset(level?: number): void;
    _destroy(): void;
}
export default ZstdEncoder;
export { ZstdEncoder, _CODEC_PB_RESET };
export type { EncoderOptions } from './types.js';
//# sourceMappingURL=zstd-wasm-codec.d.ts.map