/**
 * Compression benchmark for two practical workloads:
 *   - "big" commit:   ~1.5 MB of many entries  (testdata-big2.json)
 *   - "small" commit: ~6.5 KB single entry     (testdata-small.json)
 *
 * Compares for each workload:
 *   - zstd levels 1, 3, 5 (no dict)
 *   - zstd levels 1, 3, 5 with two trained dictionaries
 *   - snappyjs (baseline)
 *
 * Dictionaries are trained from testdata-big.json (the "corpus") so the
 * benchmark targets are not the same bytes the dict was trained on. Training
 * splits the corpus into per-entry JSON samples and invokes the `zstd` CLI.
 *
 * Run with:  pnpm exec tsx test/benchmark/compress-bench.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const CORPUS_FILE = join(TESTDATA, 'testdata-big.json');
const BIG_TARGET = join(TESTDATA, 'testdata-big2.json');
const SMALL_TARGET = join(TESTDATA, 'testdata-small.json');

const DICT_SIZES = [8 * 1024, 64 * 1024] as const;
const LEVELS = [1, 3, 5] as const;

// --- Sample extraction ----------------------------------------------------
// Big files are arrays of `{ uuid: <entry> }` objects; the small file is
// `{ login: { uuid: <entry> } }`. Each entry (with its history.revisions
// flattened out as its own samples) becomes one training sample.
function extractSamples(jsonText: string): Buffer[] {
  const root = JSON.parse(jsonText);
  const entries: any[] = [];
  if (Array.isArray(root)) {
    for (const wrapper of root) {
      for (const e of Object.values(wrapper ?? {})) entries.push(e);
    }
  } else if (root && typeof root === 'object') {
    for (const group of Object.values<any>(root)) {
      if (group && typeof group === 'object') {
        for (const e of Object.values(group)) entries.push(e);
      }
    }
  }
  const samples: Buffer[] = [];
  for (const entry of entries) {
    const { history, ...head } = entry ?? {};
    samples.push(Buffer.from(JSON.stringify(head)));
    const revisions = history?.revisions ?? {};
    for (const rev of Object.values(revisions)) {
      samples.push(Buffer.from(JSON.stringify(rev)));
    }
  }
  return samples;
}

function trainDict(samples: Buffer[], maxDict: number): Buffer {
  const dir = join(tmpdir(), `zstd-bench-train-${maxDict}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const paths: string[] = [];
    samples.forEach((s, i) => {
      const p = join(dir, `s${String(i).padStart(5, '0')}.json`);
      writeFileSync(p, s);
      paths.push(p);
    });
    const dictPath = join(dir, 'out.dict');
    execSync(`zstd --train --maxdict=${maxDict} -o "${dictPath}" ${paths.map((p) => `"${p}"`).join(' ')}`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return readFileSync(dictPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Compressors ----------------------------------------------------------
const compressZstd = (buf: Buffer, level: number, dict?: Buffer): Buffer =>
  zlib.zstdCompressSync(buf, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
    ...(dict ? { dictionary: dict } : {}),
  });

const decompressZstd = (buf: Buffer, dict?: Buffer): Buffer =>
  zlib.zstdDecompressSync(buf, dict ? { dictionary: dict } : {});

const compressWasm = (buf: Buffer, dict?: Buffer): Buffer =>
  Buffer.from(wasmCompressSync(buf, { level: 1, ...(dict ? { dictionary: dict } : {}) }));

const decompressWasm = (buf: Buffer, dict?: Buffer): Buffer =>
  Buffer.from(wasmDecompressSync(buf, undefined, dict ? { dictionary: dict } : undefined));

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
    Math.max(h.length, ...cells.filter((r): r is string[] => r !== null).map((row) => row[i].length)),
  );
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(fmt(headers));
  console.log(sepLine);
  for (const row of cells) console.log(row === null ? sepLine : fmt(row));
}

function benchAll(label: string, original: Buffer, dicts: Record<number, Buffer>, iterations: number, warmup: number) {
  const rows: TableRow[] = [];
  rows.push(
    bench(
      'wasm-zstd L1 (no dict)',
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
        `zstd L${lvl} (no dict)`,
        original,
        () => compressZstd(original, lvl),
        (c) => decompressZstd(c),
        iterations,
        warmup,
      ),
    );
  }
  for (const size of DICT_SIZES) {
    const dict = dicts[size];
    rows.push('sep');
    rows.push(
      bench(
        `wasm-zstd L1 (dict ${size / 1024}KiB)`,
        original,
        () => compressWasm(original, dict),
        (c) => decompressWasm(c, dict),
        iterations,
        warmup,
      ),
    );
    for (const lvl of LEVELS) {
      rows.push(
        bench(
          `zstd L${lvl} (dict ${size / 1024}KiB)`,
          original,
          () => compressZstd(original, lvl, dict),
          (c) => decompressZstd(c, dict),
          iterations,
          warmup,
        ),
      );
    }
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
console.log(`corpus:    ${CORPUS_FILE}`);
console.log(`big target:   ${BIG_TARGET}`);
console.log(`small target: ${SMALL_TARGET}`);

const corpusText = readFileSync(CORPUS_FILE, 'utf-8');
const samples = extractSamples(corpusText);
const samplesTotal = samples.reduce((a, b) => a + b.length, 0);
console.log(`\ntraining from ${samples.length} samples (${samplesTotal} bytes total) of ${CORPUS_FILE.split('/').pop()}`);

const dicts: Record<number, Buffer> = {};
for (const size of DICT_SIZES) {
  const d = trainDict(samples, size);
  dicts[size] = d;
  console.log(`  ${size / 1024} KiB dict: trained, actual size ${d.length} B`);
}

const bigTarget = readFileSync(BIG_TARGET);
const smallTarget = readFileSync(SMALL_TARGET);

// Pre-warm wasm codec pools. setupZstdCodec adds an encoder per
// (dict, level=1) combo. For decoders the pool is only populated via the
// async decompress() path keyed by the frame's dictId, so we round-trip
// a tiny buffer once per dict to seed decoderPools — otherwise
// decompressSync constructs a fresh ZstdDecoder on every call (~1ms),
// which dominates small-payload timings.
const seed = Buffer.from('seed');
await setupZstdCodec({ level: 1 });
await wasmDecompress(wasmCompressSync(seed, { level: 1 }));
for (const size of DICT_SIZES) {
  const dict = dicts[size];
  await setupZstdCodec({ level: 1, dictionary: dict });
  await wasmDecompress(wasmCompressSync(seed, { level: 1, dictionary: dict }), { dictionary: dict });
}

// Few hundred iterations is plenty for ~1.5 MB inputs; small target gets more.
benchAll('big commit  (testdata-big2.json — unseen)', bigTarget, dicts, 200, 20);
benchAll('small commit (testdata-small.json)', smallTarget, dicts, 2000, 100);
