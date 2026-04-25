import { readFileSync } from 'node:fs';
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
} from './codec-shared.js';

export type { DecoderOptions, EncoderOptions, CodecOptions, StreamResult } from './types.js';

_internal._loader = () => {
  const wasmUrl = new URL('./zstd-codec-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
