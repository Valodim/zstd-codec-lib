/**
 * Codec variant — inlined WASM. Both decode + encode in a single bundle.
 */
export { createDecoder, decompress, decompressSync, setupZstdDecoder, ZstdDecoder, } from './shared.js';
export { compress, compressSync, createEncoder, setupZstdCodec, ZstdEncoder, } from './encoder-shared.js';
export type { DecoderOptions, EncoderOptions, CodecOptions } from './types.js';
//# sourceMappingURL=index.web.inlined.d.ts.map