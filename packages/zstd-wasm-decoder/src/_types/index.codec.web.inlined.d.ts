/**
 * Codec variant — inlined WASM. Both decode + encode in a single bundle.
 */
export { createDecoder, decompress, decompressStream, decompressSync, setupZstdDecoder, ZstdDecoder, ZstdDecompressionStream, } from './shared.js';
export { compress, compressSync, createEncoder, setupZstdCodec, ZstdCompressionStream, ZstdEncoder, } from './codec-shared.js';
export type { DecoderOptions, EncoderOptions, CodecOptions, StreamResult } from './types.js';
//# sourceMappingURL=index.codec.web.inlined.d.ts.map