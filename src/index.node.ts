import { readFileSync } from 'node:fs';
import { _internal } from './codec-shared.js';

// oxlint-disable-next-line oxc/no-barrel-file -- entrypoint module
export { createCodec, ZstdCodec } from './codec-shared.js';

export type { CodecOptions, ZstdOptions } from './types.js';

// Note: the Node loader always loads the bundled perf wasm and ignores the
// `wasmPath` option (unlike the web / external loaders, which honor it). A
// custom path would only matter for CSP/asset-layout reasons that don't apply
// to a filesystem read of the co-located artifact.
_internal._loader = () => {
  const wasmUrl = new URL('./zstd-perf.wasm', import.meta.url);
  return new WebAssembly.Module(readFileSync(wasmUrl));
};
