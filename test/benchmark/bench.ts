import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { createCodec } from '../../dist/esm/index.node.js';
import { loadCompressedFiles } from './util.js';

const codec = await createCodec();
const wasmDecompress = (buf: Buffer): Buffer => Buffer.from(codec.decompressSync(buf));

const dir = join(import.meta.dirname || process.cwd(), 'compressed');
const metaPath = join(dir, 'metadata.json');
const fileCount = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.match(/^data-\d+\.zst$/)).length
  : 0;

if (!existsSync(metaPath) || fileCount < 1000) await import('./setup.js');

const isBun = typeof Bun !== 'undefined';
const runtime = isBun ? 'Bun' : 'Node.js';

const warmup = async (buffers: Buffer[]) => {
  for (let i = 0; i < 5; i++) {
    for (const buf of buffers) {
      zlib.zstdDecompressSync(buf);
      await new Promise((resolve, reject) =>
        zlib.zstdDecompress(buf, (err, result) => (err ? reject(err) : resolve(result))),
      );
      if (isBun) {
        Bun.zstdDecompressSync(buf);
        await Bun.zstdDecompress(buf);
      }
      await wasmDecompress(buf);
    }
  }
};

const runBenchmark = async (
  name: string,
  fn: (buf: Buffer) => Promise<any> | any,
  buffers: Buffer[],
  fileSizes: number[],
) => {
  let totalMB = 0;
  let totalTime = 0;
  let start = 0;
  for (let i = 0; i < buffers.length; i++) {
    start = performance.now();
    await fn(buffers[i]);
    totalTime += performance.now() - start;
    totalMB += fileSizes[i] / 1024 / 1024;
  }

  const mbps = totalMB / (totalTime / 1000);
  return { name, mbps };
};

const metadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
const benchBuffers = loadCompressedFiles(dir).filter((_, idx, arr) =>
  arr.length > metadata.fileCount ? idx < metadata.fileCount : true,
);

await warmup(
  loadCompressedFiles(dir).filter((_, idx, arr) =>
    arr.length > metadata.fileCount ? idx >= metadata.fileCount : [],
  ),
);

// Run benchmarks
const results: { name: string; mbps: number }[] = [];

results.push(
  await runBenchmark(
    'zstd-wasm (decompress)',
    (buf) => wasmDecompress(buf),
    benchBuffers,
    metadata.fileSizes,
  ),
);

if (isBun) {
  results.push(
    await runBenchmark(
      'Bun native (sync)',
      (buf) => Bun.zstdDecompressSync(buf),
      benchBuffers,
      metadata.fileSizes,
    ),
  );
  results.push(
    await runBenchmark(
      'Bun native (async)',
      (buf) => Bun.zstdDecompress(buf),
      benchBuffers,
      metadata.fileSizes,
    ),
  );
}

results.push(
  await runBenchmark(
    'zlib (sync)',
    (buf) => zlib.zstdDecompressSync(buf),
    benchBuffers,
    metadata.fileSizes,
  ),
);
results.push(
  await runBenchmark(
    'zlib (async)',
    (buf) =>
      new Promise((resolve, reject) =>
        zlib.zstdDecompress(buf, (err, result) => (err ? reject(err) : resolve(result))),
      ),
    benchBuffers,
    metadata.fileSizes,
  ),
);

// Output results
console.log(`${'='.repeat(50)}`);
console.log(`Runtime: ${runtime}`);
console.log(`${'='.repeat(50)}`);
for (const { name, mbps } of results) {
  console.log(`${name.padEnd(30)} ${mbps.toFixed(2).padStart(10)} MB/s`);
}

console.log('\n');
await import('./roundtrip.js');
