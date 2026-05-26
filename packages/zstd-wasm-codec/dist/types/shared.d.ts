import ZstdDecoder from './zstd-wasm-decoder.js';
export { default as ZstdDecoder, _MAX_SRC_BUF } from './zstd-wasm-decoder.js';
import type { StreamResult, ZstdOptions } from './types.js';
export declare const _internal: {
    _loader: ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null;
    buffer: {
        maxSrcSize: number;
        maxDstSize: number;
    };
    dictionaries: string[];
};
export declare const setupZstdDecoder: (options: {
    maxSrcSize?: number;
    maxDstSize?: number;
    dictionaries?: string[];
}) => Promise<void>;
export declare function _pushToPool(decoder: ZstdDecoder, module: WebAssembly.Module, dictId?: number): void;
export declare const createDecoder: (options?: ZstdOptions) => Promise<ZstdDecoder>;
export declare class ZstdDecompressionStream {
    /**
     * The resulting decompressed stream to read output from.
     * @type {ReadableStream<Uint8Array>}
     */
    readonly readable: ReadableStream;
    /**
     * The writable end of the stream to pipe compressed chunks into.
     * @type {WritableStream<BufferSource>}
     */
    readonly writable: WritableStream;
    /**
     * @param {ZstdOptions} [options] - Optional decoder configuration.
     */
    constructor(options?: ZstdOptions);
}
export declare const decompress: (input: Uint8Array, options?: ZstdOptions) => Promise<Uint8Array>;
export declare const decompressStream: (input: Uint8Array, reset?: boolean, options?: ZstdOptions) => Promise<StreamResult>;
export declare const decompressSync: (input: Uint8Array, expectedSize?: number, options?: ZstdOptions) => Uint8Array;
//# sourceMappingURL=shared.d.ts.map