import { readFileSync } from 'node:fs';
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

_internal._loader = () => {
  const wasmUrl = new URL('./zstd-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
