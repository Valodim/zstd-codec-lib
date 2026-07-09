import ZstdDecoder from './zstd-wasm-decoder.js';
export { default as ZstdDecoder, _MAX_SRC_BUF } from './zstd-wasm-decoder.js';
import type { ZstdOptions } from './types.js';
export declare const _internal: {
    _loader: ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null;
    buffer: {
        maxSrcSize: number;
        maxDstSize: number;
    };
};
export declare const setupZstdDecoder: (options: {
    maxSrcSize?: number;
    maxDstSize?: number;
}) => Promise<void>;
export declare const createDecoder: (options?: ZstdOptions) => Promise<ZstdDecoder>;
export declare const decompress: (input: Uint8Array, _options?: ZstdOptions) => Promise<Uint8Array>;
export declare const decompressSync: (input: Uint8Array, expectedSize?: number, _options?: ZstdOptions) => Uint8Array;
//# sourceMappingURL=shared.d.ts.map