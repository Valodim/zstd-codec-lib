import { readFileSync } from 'node:fs';
import { _internal } from './shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export {
  createDecoder,
  decompress,
  decompressStream,
  decompressSync,
  setupZstdDecoder,
  ZstdDecoder,
  ZstdDecompressionStream,
} from './shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export {
  compress,
  compressSync,
  createEncoder,
  setupZstdCodec,
  ZstdCompressionStream,
  ZstdEncoder,
} from './encoder-shared.js';

export type { DecoderOptions, EncoderOptions, CodecOptions, StreamResult } from './types.js';

_internal._loader = () => {
  const wasmUrl = new URL('./zstd-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
