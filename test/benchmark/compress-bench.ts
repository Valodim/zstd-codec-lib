/**
 * Compression benchmark for two practical workloads:
 *   - "big" commit:   ~1.5 MB of many entries  (testdata-big2.json)
 *   - "small" commit: ~6.5 KB single entry     (testdata-small.json)
 *
 * Compares for each workload:
 *   - wasm-zstd level 1
 *   - zstd levels 1, 3, 5 (node:zlib)
 *   - snappyjs (baseline)
 *
 * Run with:  yarn exec tsx test/benchmark/compress-bench.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import snappy from 'snappyjs';
import {
  compressSync as wasmCompressSync,
  decompress as wasmDecompress,
  decompressSync as wasmDecompressSync,
  setupZstdCodec,
} from '../../dist/esm/index.node.js';

const TESTDATA = join(import.meta.dirname || process.cwd(), '..', '..', 'testdata');
const BIG_TARGET = join(TESTDATA, 'testdata-big2.json');
const SMALL_TARGET = join(TESTDATA, 'testdata-small.json');

const LEVELS = [1, 3, 5] as const;

// --- Compressors ----------------------------------------------------------
const compressZstd = (buf: Buffer, level: number): Buffer =>
  zlib.zstdCompressSync(buf, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
  });

const decompressZstd = (buf: Buffer): Buffer => zlib.zstdDecompressSync(buf);

const compressWasm = (buf: Buffer): Buffer => Buffer.from(wasmCompressSync(buf, { level: 1 }));

const decompressWasm = (buf: Buffer): Buffer => Buffer.from(wasmDecompressSync(buf));

// --- Bench harness --------------------------------------------------------
type Row = {
  name: string;
  compressedBytes: number;
  ratio: number;
  encUsPerOp: number;
  encMBps: number;
  decUsPerOp: number;
  decMBps: number;
};

function bench(
  name: string,
  original: Buffer,
  encode: () => Buffer,
  decode: (c: Buffer) => Buffer,
  iterations: number,
  warmup: number,
): Row {
  const c = encode();
  const d = decode(c);
  if (Buffer.compare(d, original) !== 0) throw new Error(`roundtrip mismatch for ${name}`);

  for (let i = 0; i < warmup; i++) encode();
  let t0 = performance.now();
  for (let i = 0; i < iterations; i++) encode();
  const encMs = performance.now() - t0;

  for (let i = 0; i < warmup; i++) decode(c);
  t0 = performance.now();
  for (let i = 0; i < iterations; i++) decode(c);
  const decMs = performance.now() - t0;

  const origMB = (original.length * iterations) / 1024 / 1024;
  return {
    name,
    compressedBytes: c.length,
    ratio: original.length / c.length,
    encUsPerOp: (encMs * 1000) / iterations,
    encMBps: origMB / (encMs / 1000),
    decUsPerOp: (decMs * 1000) / iterations,
    decMBps: origMB / (decMs / 1000),
  };
}

type TableRow = Row | 'sep';

function printTable(title: string, original: Buffer, rows: TableRow[]) {
  console.log('');
  console.log(`=== ${title}  (${original.length} bytes) ===`);
  const headers = ['codec', 'size', 'ratio', 'enc µs', 'enc MB/s', 'dec µs', 'dec MB/s'];
  const cells = rows.map((r) =>
    r === 'sep'
      ? null
      : [
          r.name,
          `${r.compressedBytes} B`,
          `${r.ratio.toFixed(2)}x`,
          r.encUsPerOp.toFixed(1),
          r.encMBps.toFixed(1),
          r.decUsPerOp.toFixed(1),
          r.decMBps.toFixed(1),
        ],
  );
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...cells.filter((r): r is string[] => r !== null).map((row) => row[i].length),
    ),
  );
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]) =>
    row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(fmt(headers));
  console.log(sepLine);
  for (const row of cells) console.log(row === null ? sepLine : fmt(row));
}

function benchAll(label: string, original: Buffer, iterations: number, warmup: number) {
  const rows: TableRow[] = [];
  rows.push(
    bench(
      'wasm-zstd L1',
      original,
      () => compressWasm(original),
      (c) => decompressWasm(c),
      iterations,
      warmup,
    ),
  );
  for (const lvl of LEVELS) {
    rows.push(
      bench(
        `zstd L${lvl}`,
        original,
        () => compressZstd(original, lvl),
        (c) => decompressZstd(c),
        iterations,
        warmup,
      ),
    );
  }
  rows.push('sep');
  rows.push(
    bench(
      'snappyjs',
      original,
      () => Buffer.from(snappy.compress(original)),
      (c) => Buffer.from(snappy.uncompress(c)),
      iterations,
      warmup,
    ),
  );
  printTable(label, original, rows);
}

// --- Main -----------------------------------------------------------------
console.log(`big target:   ${BIG_TARGET}`);
console.log(`small target: ${SMALL_TARGET}`);

const bigTarget = readFileSync(BIG_TARGET);
const smallTarget = readFileSync(SMALL_TARGET);

// Pre-warm wasm codec pools. For decoders the pool is only populated via the
// async decompress() path, so we round-trip a tiny buffer once to seed the
// pool — otherwise decompressSync constructs a fresh ZstdCodec on every
// call (~1ms), which dominates small-payload timings.
const seed = Buffer.from('seed');
await setupZstdCodec({ level: 1 });
await wasmDecompress(wasmCompressSync(seed, { level: 1 }));

// Few hundred iterations is plenty for ~1.5 MB inputs; small target gets more.
benchAll('big commit  (testdata-big2.json — unseen)', bigTarget, 200, 20);
benchAll('small commit (testdata-small.json)', smallTarget, 2000, 100);
