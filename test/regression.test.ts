/**
 * Regression suite — guards specific bugs fixed in this codebase.
 *
 * Unlike suite.test.ts, this is NOT parameterized per runtime/adapter: it runs
 * once under node (wired into the `test:node` script only, not test:browsers /
 * test:bun). Each case targets a node-level surface — the built entrypoint, a
 * source module, or a directly-instantiated wasm — rather than the
 * cross-browser decode path, so running it in every runtime adds no coverage.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { hash } from './lib/utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Regression — commit "fix(encoder): commit the CCtx workspace at init; fail
 * cleanly when buffers don't fit". With the workspace committed at a fixed low
 * address, an over-budget maxSrcSize exhausts the fixed 12 MB linear memory and
 * malloc returns 0; init must throw rather than write at offset 0 and clobber
 * the stack. Instantiates the codec wasm directly, independent of the dist bundle.
 */
describe('encoder fails cleanly when buffers do not fit', () => {
  const codecModule = () =>
    new WebAssembly.Module(readFileSync(join(__dirname, '../dist/esm/zstd-perf.wasm')));

  test('over-budget maxSrcSize throws OOM at init, not a memory trap', async () => {
    const { ZstdEncoder } = await import('../src/zstd-wasm-encoder.ts');
    // 32 MB src (+ its compressBound dst) cannot fit the fixed 12 MB memory.
    expect(() => new ZstdEncoder({ maxSrcSize: 32 * 1024 * 1024 }).init(codecModule())).toThrow(
      /oom/i,
    );
  });

  test('within-budget encoder initializes and round-trips (workspace committed)', async () => {
    const { ZstdEncoder } = await import('../src/zstd-wasm-encoder.ts');
    const enc = new ZstdEncoder({ level: 1 }).init(codecModule());
    // > 64 bytes, so the committed level-1 (windowLog-19) workspace is used —
    // the path that corrupted memory before the workspace was committed at init.
    const src = Buffer.from('regression: workspace committed at init. '.repeat(256));
    const out = enc.compressSync(src);
    expect(hash(Buffer.from(zlib.zstdDecompressSync(out)))).toBe(hash(src));
  });
});

/**
 * Regression — commit "fix(decoder): default size limits to a finite value
 * instead of NaN". A bare `new ZstdDecoder()` used to compute
 * Math.max(undefined, floor) = NaN, and `x > NaN` is always false, silently
 * disabling both the input-size guard and the decompression-bomb output guard.
 */
describe('decoder default size limits are finite (not NaN)', () => {
  // _MAX_DST_BUF_DEFAULT (9_830_464) << 6 — the finite floor the constructor
  // must apply when no options are given.
  const FLOOR = 9830464 << 6;

  test('bare new ZstdDecoder() applies the finite floor, never NaN', async () => {
    const { ZstdDecoder } = await import('../src/zstd-wasm-decoder.ts');
    const dec = new ZstdDecoder() as unknown as { _maxSrcSize: number; _maxDstSize: number };
    expect(Number.isNaN(dec._maxSrcSize)).toBe(false);
    expect(Number.isNaN(dec._maxDstSize)).toBe(false);
    expect(dec._maxSrcSize).toBe(FLOOR);
    expect(dec._maxDstSize).toBe(FLOOR);
  });

  test('explicit limits below the floor clamp up; larger ones win', async () => {
    const { ZstdDecoder } = await import('../src/zstd-wasm-decoder.ts');
    type Limits = { _maxSrcSize: number; _maxDstSize: number };
    const small = new ZstdDecoder({ maxSrcSize: 1, maxDstSize: 1 }) as unknown as Limits;
    expect(small._maxSrcSize).toBe(FLOOR);
    expect(small._maxDstSize).toBe(FLOOR);
    const big = FLOOR * 2;
    const large = new ZstdDecoder({ maxSrcSize: big, maxDstSize: big }) as unknown as Limits;
    expect(large._maxSrcSize).toBe(big);
    expect(large._maxDstSize).toBe(big);
  });
});

/**
 * Regression — commit "fix(utils): tighten rzfh window guard to the level-9 cap
 * (4 MB + 1)". The JS-side pre-check used to reject only windows > 10 MB, looser
 * than the decoder's hard 4 MB + 1 cap; frames declaring a 5-10 MB window slipped
 * past and were only refused deep in the wasm. The guard now matches the cap.
 */
describe('rzfh window guard caps at 4 MB + 1', () => {
  // Minimal 6-byte frame header: magic + flags(0) + window descriptor.
  // flags = 0 → single_segment off, so rzfh derives the window from byte[5]:
  //   exponent = byte5 >> 3   (windowLog = 10 + exponent)
  //   mantissa = byte5 & 7    (window = base + (base / 8) * mantissa)
  const frameHeader = (windowDescriptor: number) =>
    Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, windowDescriptor]);
  const wd = (exponent: number, mantissa: number) => (exponent << 3) | mantissa;

  test('accepts a 4 MB window (windowLog 22 — the level-9 cap)', async () => {
    const { rzfh } = await import('../src/utils.ts');
    const header = rzfh(frameHeader(wd(12, 0))); // 4194304 ≤ 4194305
    expect(typeof header).toBe('object');
    expect((header as { u: number }).u).toBe(4194304);
  });

  test('rejects a ~5 MB window — the gap the old 10 MB guard let through', async () => {
    const { rzfh } = await import('../src/utils.ts');
    // windowLog 22, mantissa 2 → 4194304 + 2 * 524288 = 5242880 (~5 MB).
    expect(() => rzfh(frameHeader(wd(12, 2)))).toThrow('win 2 large');
  });

  test('rejects just over the cap (windowLog 22, mantissa 1 → ~4.5 MB)', async () => {
    const { rzfh } = await import('../src/utils.ts');
    expect(() => rzfh(frameHeader(wd(12, 1)))).toThrow('win 2 large'); // 4718592
  });

  test('rejects an 8 MB window (windowLog 23, level > 9)', async () => {
    const { rzfh } = await import('../src/utils.ts');
    expect(() => rzfh(frameHeader(wd(13, 0)))).toThrow('win 2 large'); // 8388608
  });
});
