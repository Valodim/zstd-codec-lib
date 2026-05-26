/**
 * Zstd WASM Decoder - Inlined WASM variant
 *
 * WASM is pre-compressed with deflate-raw compliant zopfli stream, encoded as base64,
 * then decompressed at runtime using DecompressionStreams API
 */
export { createDecoder, decompress, decompressStream, decompressSync, setupZstdDecoder, ZstdDecoder, ZstdDecompressionStream, } from './shared.js';
export type { DecoderOptions, StreamResult } from './types.js';
//# sourceMappingURL=index.web.inlined.d.ts.map