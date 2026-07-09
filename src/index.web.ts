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

_internal._loader = async (wasmPath?: string) => {
  const wasmUrl = wasmPath || new URL('./zstd.wasm', import.meta.url).href;
  const response = await fetch(wasmUrl);
  return await WebAssembly.compileStreaming(response);
};
