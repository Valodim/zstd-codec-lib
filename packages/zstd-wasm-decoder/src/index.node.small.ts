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

export type { DecoderOptions, StreamResult } from './types.js';

_internal._loader = () => {
  const wasmUrl = new URL('./zstd-decoder-small-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
