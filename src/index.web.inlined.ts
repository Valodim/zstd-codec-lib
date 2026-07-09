/**
 * Codec variant — inlined WASM. Both decode + encode in a single bundle.
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
          : _b64ToBytes(WASM_BASE64),
      ])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );
};
function _b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
const WASM_BASE64 = '__WASM_BASE64_PLACEHOLDER__';
