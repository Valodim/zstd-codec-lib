import { readFileSync } from 'node:fs';
import { _internal } from './shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export {
  createDecoder,
  decompress,
  decompressSync,
  setupZstdDecoder,
  ZstdDecoder,
} from './shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export {
  compress,
  compressSync,
  createEncoder,
  setupZstdCodec,
  ZstdEncoder,
} from './encoder-shared.js';

export type { DecoderOptions, EncoderOptions, CodecOptions } from './types.js';

_internal._loader = () => {
  const wasmUrl = new URL('./zstd-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
