/**
 * Codec lvl1-only — inlined WASM. Smaller bundle (~3 KB gzipped less)
 * and 12 MB linear memory budget (vs. 32 MB for the full codec).
 */
export { createDecoder, decompress, decompressStream, decompressSync, setupZstdDecoder, ZstdDecoder, ZstdDecompressionStream, } from './shared.js';
export { compress, compressSync, createEncoder, setupZstdCodec, ZstdCompressionStream, ZstdEncoder, } from './encoder-shared.js';
export type { DecoderOptions, EncoderOptions, CodecOptions, StreamResult } from './types.js';
//# sourceMappingURL=index.lvl1.web.inlined.d.ts.map