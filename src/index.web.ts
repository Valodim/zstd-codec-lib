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

_internal._loader = async (wasmPath?: string) => {
  const wasmUrl = wasmPath || new URL('./zstd.wasm', import.meta.url).href;
  const response = await fetch(wasmUrl);
  return await WebAssembly.compileStreaming(response);
};
