import type { EncoderOptions } from './types.js';
declare class ZstdEncoder {
    private _exports;
    private _HEAPU8;
    private _HEAPU32;
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
     * Internal streaming engine — not part of the public API. Drains the input
     * and ends the frame, returning the full compressed output. Used only as the
     * fallback path for `compressSync` when the input exceeds maxSrcSize.
     */
    _compressStream(input: Uint8Array, reset?: boolean, level?: number): Uint8Array;
    _destroy(): void;
}
export default ZstdEncoder;
export { ZstdEncoder };
export type { EncoderOptions } from './types.js';
//# sourceMappingURL=zstd-wasm-encoder.d.ts.map