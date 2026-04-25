import { _internal, _pushToPool, ZstdDecoder } from './shared.js';
//@ts-expect-error
import wasmModule from './zstd-decoder-small-perf.wasm';

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

let initialized = false;

_internal._loader = async () => {
  const instance = new WebAssembly.Instance(wasmModule, { env: {} });

  if (!initialized) {
    const decoder = new ZstdDecoder(_internal.buffer);
    decoder._initWithInstance(instance, wasmModule);
    _pushToPool(decoder, wasmModule, 0);
    initialized = true;
  }

  return wasmModule;
};
