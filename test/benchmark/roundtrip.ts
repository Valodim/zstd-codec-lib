import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { createDecoder, decompressSync, ZstdDecoder } from '../../dist/esm/index.node.js';
import { hash } from '../lib/utils.js';

const dir = import.meta.dirname || process.cwd();
const testData = readFileSync(join(dir, '../data/test.json'));
const expectedHash = hash(testData);

await createDecoder();

const zstdConfig = {
  [constants.ZSTD_c_compressionLevel]: 19,
  [constants.ZSTD_c_strategy]: constants.ZSTD_btultra2,
  [constants.ZSTD_c_contentSizeFlag]: 1,
  [constants.ZSTD_d_windowLogMax]: 30,
  [constants.ZSTD_c_minMatch]: 3,
  [constants.ZSTD_c_hashLog]: 24,
  [constants.ZSTD_c_chainLog]: 24,
  [constants.ZSTD_c_searchLog]: 8,
  [constants.ZSTD_c_overlapLog]: 14,
  [constants.ZSTD_c_enableLongDistanceMatching]: 1,
};

const compressed = zstdCompressSync(testData, {
  params: zstdConfig,
});

const validate = (result: Uint8Array, label: string) => {
  if (hash(result) !== expectedHash) throw new Error(`${label} failed: hash mismatch`);
  console.log(`✓ ${label}`);
};

console.log('Running roundtrip validation...\n');

validate(decompressSync(compressed), 'decompressSync');

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../../dist/esm/zstd-perf.wasm', import.meta.url)),
);

const decoder = new ZstdDecoder();
decoder.init(wasmModule);

validate(decoder.decompressSync(compressed), 'ZstdDecoder instance (decompressSync)');
