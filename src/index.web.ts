import { _internal } from './codec-shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export {
  compress,
  compressSync,
  createCodec,
  decompress,
  decompressSync,
  setupZstdCodec,
  ZstdCodec,
} from './codec-shared.js';

export type { CodecOptions, ZstdOptions } from './types.js';

_internal._loader = async (wasmPath?: string) => {
  const wasmUrl = wasmPath || new URL('./zstd.wasm', import.meta.url).href;
  const response = await fetch(wasmUrl);
  return await WebAssembly.compileStreaming(response);
};
