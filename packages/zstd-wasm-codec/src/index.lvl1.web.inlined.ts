/**
 * Codec lvl1-only — inlined WASM. Smaller bundle (~3 KB gzipped less)
 * and 12 MB linear memory budget (vs. 32 MB for the full codec).
 */

import { _internal } from './shared.js';

// biome-ignore lint/performance/noBarrelFile: entrypoint module
export {
  createDecoder,
  decompress,
  decompressStream,
  decompressSync,
  setupZstdDecoder,
  ZstdDecoder,
  ZstdDecompressionStream,
} from './shared.js';

// biome-ignore lint/performance/noBarrelFile: entrypoint module
export {
  compress,
  compressSync,
  createEncoder,
  setupZstdCodec,
  ZstdCompressionStream,
  ZstdEncoder,
} from './encoder-shared.js';

export type { DecoderOptions, EncoderOptions, CodecOptions, StreamResult } from './types.js';

_internal._loader = async () => {
  return await WebAssembly.compile(
    await new Response(
      new Blob([
        typeof (Uint8Array as any).fromBase64 === 'function'
          ? (Uint8Array as any).fromBase64(WASM_BASE64)
          : new TextEncoder().encode(atob(WASM_BASE64)).buffer,
      ])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
};
const WASM_BASE64 = '__WASM_BASE64_PLACEHOLDER__';
