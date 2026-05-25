import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import {
  createDecoder,
  decompressStream,
  decompressSync,
  ZstdDecoder,
  ZstdDecompressionStream,
} from '../../packages/zstd-wasm-codec/src/_esm/index.node.js';
import { hash } from '../lib/utils.js';

const dir = import.meta.dirname || process.cwd();
const testData = readFileSync(join(dir, '../data/test.json'));
const dict = readFileSync(join(dir, '../dictionaries/test.json.dict'));
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

const compressedWithDict = zstdCompressSync(testData, {
  params: zstdConfig,
  dictionary: dict,
});

const compressedNoDict = zstdCompressSync(testData, {
  params: zstdConfig,
});

const validate = (result: Uint8Array, label: string) => {
  if (hash(result) !== expectedHash) throw new Error(`${label} failed: hash mismatch`);
  console.log(`✓ ${label}`);
};

const readStream = async (buf: Buffer, dict?: Uint8Array) => {
  const stream = new ZstdDecompressionStream(dict ? { dictionary: dict } : {});
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  writer.write(buf);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

console.log('Running roundtrip validation...\n');

validate(
  decompressSync(compressedWithDict, undefined, { dictionary: dict }),
  'decompressSync (with dict)',
);
validate(
  (await decompressStream(compressedWithDict, true, { dictionary: dict })).buf,
  'decompressStream (with dict)',
);
validate(await readStream(compressedWithDict, dict), 'ZstdDecompressionStream (with dict)');

validate(decompressSync(compressedNoDict), 'decompressSync (no dict)');
validate((await decompressStream(compressedNoDict, true)).buf, 'decompressStream (no dict)');
validate(await readStream(compressedNoDict), 'ZstdDecompressionStream (no dict)');

const wasmModule = new WebAssembly.Module(
  readFileSync(
    new URL('../../packages/zstd-wasm-codec/src/_esm/zstd-perf.wasm', import.meta.url),
  ),
);

let decoderWithDict = new ZstdDecoder({ dictionary: dict });
decoderWithDict.init(wasmModule);

validate(
  decoderWithDict.decompressSync(compressedWithDict),
  'ZstdDecoder instance (decompressSync with dict)',
);
validate(
  decoderWithDict.decompressStream(compressedWithDict, true).buf,
  'ZstdDecoder instance (decompressStream with dict)',
);
validate(
  decoderWithDict.decompressSync(compressedNoDict),
  'ZstdDecoder instance (decompressSync no dict)',
);
validate(
  decoderWithDict.decompressStream(compressedNoDict, true).buf,
  'ZstdDecoder instance (decompressStream no dict)',
);

decoderWithDict = new ZstdDecoder({ dictionary: dict });
decoderWithDict.init(wasmModule);

validate(
  decoderWithDict.decompressSync(compressedNoDict),
  'ZstdDecoder instance (decompressSync no dict)',
);
validate(
  decoderWithDict.decompressStream(compressedNoDict, true).buf,
  'ZstdDecoder instance (decompressStream no dict)',
);
validate(
  decoderWithDict.decompressSync(compressedWithDict),
  'ZstdDecoder instance (decompressSync with dict)',
);
validate(
  decoderWithDict.decompressStream(compressedWithDict, true).buf,
  'ZstdDecoder instance (decompressStream with dict)',
);
