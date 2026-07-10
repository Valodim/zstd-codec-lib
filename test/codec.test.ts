/**
 * Codec (encoder) tests. Round-trip via the codec wasm's own decoder,
 * plus host-zstd cross-decode to verify spec-compliant output.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { describe, expect, test, beforeAll } from 'vitest';

import { createCodec, type ZstdCodec } from '../dist/esm/index.node.js';

// Compression is level-1-only — the encoder rejects any other level.
const LEVELS = [1] as const;
// Decoding must stay future-proof for foreign frames up to level 9.
const DECODE_LEVELS = [1, 3, 6, 9] as const;

let codec: ZstdCodec;

beforeAll(async () => {
  codec = await createCodec({});
});

const txt = (n: number): Uint8Array =>
  new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(n));

function bufEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('ZstdCodec compress/decompress', () => {
  for (const level of LEVELS) {
    test(`round-trip text @ level ${level}`, () => {
      const src = txt(500); // ~22 KB compressible text
      const compressed = codec.compressSync(src, level);
      expect(compressed.length).toBeLessThan(src.length / 2);
      const decoded = codec.decompressSync(compressed);
      expect(bufEq(decoded, src)).toBe(true);
    });

    test(`round-trip random @ level ${level}`, () => {
      const src = new Uint8Array(randomBytes(64 * 1024));
      const compressed = codec.compressSync(src, level);
      // Random data won't compress meaningfully — but it must round-trip.
      const decoded = codec.decompressSync(compressed);
      expect(bufEq(decoded, src)).toBe(true);
    });
  }
});

/**
 * The combined codec time-shares one 12 MB arena between compress and
 * decompress on a single instance. This exercises the interleaving that
 * stresses that sharing: streaming-compress → a large decode that writes
 * across the arena → streaming-compress again on the SAME instance. The
 * compressor's static workspace is pinned below _srcPtr, which decode never
 * writes, so every round-trip must stay correct regardless of order.
 */
describe('single-instance compress↔decompress interleave', () => {
  test('sync + streaming round-trips interleave cleanly on one instance', async () => {
    const local = await createCodec({
      level: 1,
      maxSrcSize: 1 * 1024 * 1024, // small, so >1 MB inputs take the streaming path
    });

    // Distinct payloads so a stale-buffer bug would surface as a mismatch.
    const small = txt(50); // sync compress path
    const bigText = txt(200_000); // ~9 MB → streaming compress + streaming decode
    const bigRandom = new Uint8Array(randomBytes(3 * 1024 * 1024)); // streaming, incompressible

    const rt = (src: Uint8Array): void => {
      const comp = local.compressSync(src);
      const back = local.decompressSync(comp);
      expect(bufEq(back, src)).toBe(true);
    };

    // Alternate directions and sizes repeatedly on the one instance.
    rt(small);
    rt(bigText); // streaming compress, then a large streaming decode
    rt(small); // sync compress right after a big decode (stale-staging guard)
    rt(bigRandom);
    rt(bigText);
    rt(small);
  });
});

/**
 * Guards the nastiest arena overlap: a streaming compress, then a large
 * *single-pass* decode (declared FCS, compressed < 2 MB) whose output spans
 * the high arena, then another compress. The compressor's static workspace is
 * pinned below _srcPtr and the decoder never writes there, so the second
 * compress must still produce a correct frame. (The plain interleave test
 * above takes the *streaming* decode path, whose small rolling buffer stays
 * low; this one drives the single-pass path that writes high.)
 */
describe('workspace-clobber regression (streaming-compress → single-pass decode → compress)', () => {
  test('a large single-pass decode does not corrupt the compressor workspace', async () => {
    const zlib = await import('node:zlib');
    const local = await createCodec({ level: 1, maxSrcSize: 1 * 1024 * 1024 });

    // Foreign frame with declared FCS whose compressed size stays under the
    // 2 MB single-pass input cap but decodes to ~6 MB — its output spans the
    // high arena where a large decode writes.
    const bigConst = new Uint8Array(6 * 1024 * 1024).fill(0xab);
    const frame = new Uint8Array(
      zlib.zstdCompressSync(bigConst, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
      }),
    );
    expect(frame.length).toBeLessThan(2 * 1024 * 1024);

    const streamInput = txt(200_000); // ~9 MB > maxSrcSize → streaming compress

    // 1) streaming compress on the shared arena.
    expect(bufEq(local.decompressSync(local.compressSync(streamInput)), streamInput)).toBe(true);
    // 2) large single-pass decode writes across the high arena.
    expect(bufEq(local.decompressSync(frame), bigConst)).toBe(true);
    // 3) streaming compress again must neither trap nor emit a corrupt frame.
    expect(bufEq(local.decompressSync(local.compressSync(streamInput)), streamInput)).toBe(true);

    // Same sequence, then a *sync* compress — guards the single-shot path too.
    local.compressSync(streamInput);
    local.decompressSync(frame);
    const small = txt(50);
    expect(bufEq(local.decompressSync(local.compressSync(small)), small)).toBe(true);
  });
});

describe('host zstd cross-decode', () => {
  // Skip if host zstd isn't installed.
  const hostZstd = spawnSync('zstd', ['--version']);
  const hostAvailable = hostZstd.status === 0;

  for (const level of LEVELS) {
    test.skipIf(!hostAvailable)(`wasm-encode → host zstd-decode @ level ${level}`, () => {
      const src = txt(500);
      const compressed = codec.compressSync(src, level);
      const decoded = spawnSync('zstd', ['-d', '--stdout'], {
        input: Buffer.from(compressed),
        encoding: 'buffer',
      });
      expect(decoded.status).toBe(0);
      expect(bufEq(new Uint8Array(decoded.stdout), src)).toBe(true);
    });
  }

  // The decoder must handle foreign frames produced at higher levels.
  for (const level of DECODE_LEVELS) {
    test.skipIf(!hostAvailable)(`host zstd-encode → wasm-decode @ level ${level}`, () => {
      const src = txt(500);
      const result = spawnSync('zstd', [`-${level}`, '--stdout'], {
        input: Buffer.from(src),
        encoding: 'buffer',
      });
      expect(result.status).toBe(0);
      const decoded = codec.decompressSync(new Uint8Array(result.stdout));
      expect(bufEq(decoded, src)).toBe(true);
    });
  }
});

describe('edge cases', () => {
  test('empty input', () => {
    const compressed = codec.compressSync(new Uint8Array(0));
    const decoded = codec.decompressSync(compressed);
    expect(decoded.length).toBe(0);
  });

  test('1-byte input', () => {
    const src = new Uint8Array([42]);
    const compressed = codec.compressSync(src);
    const decoded = codec.decompressSync(compressed);
    expect(bufEq(decoded, src)).toBe(true);
  });

  test('large highly-compressible input (1 MB)', () => {
    const src = new Uint8Array(1024 * 1024);
    src.fill(0xab);
    const compressed = codec.compressSync(src, 1);
    expect(compressed.length).toBeLessThan(1024); // should compress to almost nothing
    const decoded = codec.decompressSync(compressed);
    expect(bufEq(decoded, src)).toBe(true);
  });

  test('rejects any compression level other than 1', () => {
    // The encoder is level-1-only; every other level throws at runtime.
    expect(() => codec.compressSync(txt(10), 2)).toThrow();
    expect(() => codec.compressSync(txt(10), 3)).toThrow();
    expect(() => codec.compressSync(txt(10), 5)).toThrow();
    expect(() => codec.compressSync(txt(10), 0)).toThrow();
  });
});

/**
 * Memory-model stress test. The compressor and decoder time-share one 12 MB
 * arena on a single instance; the compressor's workspace is a fixed static
 * CCtx pinned below _srcPtr that the decoder must never disturb. This drives a
 * long, seeded-random sequence of mixed operations — every combination of
 * (sync | streaming) compress and (single-pass | streaming) decode, across
 * sizes and compressibilities — and asserts that:
 *   • every round-trip / oracle decode is byte-correct, and
 *   • a fixed canary payload always self-compresses to the exact same bytes.
 * Corruption of the static workspace or an arena overlap would surface as a
 * failed round-trip, canary drift, or a wasm trap. Deterministic (seeded), so
 * any failure reproduces.
 */
describe('stress: long randomized interleave keeps the shared arena intact', () => {
  // Small maxSrcSize so mid-size inputs exercise the streaming compress path.
  let codecStress: ZstdCodec;
  beforeAll(async () => {
    codecStress = await createCodec({ level: 1, maxSrcSize: 512 * 1024 });
  });

  // mulberry32 — tiny deterministic PRNG so failures are reproducible.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

  test('mixed compress/decompress operations never corrupt memory', () => {
    const rnd = mulberry32(0xc0ffee);
    const ri = (n: number): number => Math.floor(rnd() * n);

    // Payload generators spanning the compressibility spectrum.
    const gens: Record<string, (n: number) => Uint8Array> = {
      zeros: (n) => new Uint8Array(n),
      constant: (n) => new Uint8Array(n).fill(0xab),
      text: (n) => {
        const t = new TextEncoder().encode('the quick brown fox jumps over 42 lazy dogs. ');
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = t[i % t.length];
        return b;
      },
      semi: (n) => {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 3) + ri(4)) & 0xff;
        return b;
      },
      random: (n) => {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = ri(256);
        return b;
      },
    };
    const genNames = Object.keys(gens);
    // Sizes straddling every path boundary: maxSrcSize (512 KB → streaming
    // compress), _MAX_SRC_BUF (2 MB compressed → streaming decode), and the
    // ~7.4 MB single-pass decode cap.
    const sizes = [
      0,
      1,
      100,
      4096,
      60 * 1024,
      300 * 1024,
      800 * 1024,
      3 * 1024 * 1024,
      9 * 1024 * 1024,
    ];

    const local = codecStress;

    // Canary: < maxSrcSize so it uses the deterministic single-shot path. Its
    // compressed bytes must never change — drift ⇒ workspace/param corruption.
    const canary = gens.text(200 * 1024);
    const canaryComp = Buffer.from(local.compressSync(canary));
    expect(canaryComp.length).toBeGreaterThan(0);

    const ITER = 200;
    for (let i = 0; i < ITER; i++) {
      switch (ri(4)) {
        case 0: {
          // Canary self-round-trip + byte-stable compressed output.
          const c = local.compressSync(canary);
          expect(Buffer.from(c).equals(canaryComp)).toBe(true);
          expect(eq(local.decompressSync(c), canary)).toBe(true);
          break;
        }
        case 1: {
          // Random self round-trip (own encoder → own decoder).
          const src = gens[genNames[ri(genNames.length)]](sizes[ri(sizes.length)]);
          expect(eq(local.decompressSync(local.compressSync(src)), src)).toBe(true);
          break;
        }
        case 2: {
          // Decode a foreign frame (node:zlib) against the original bytes.
          const src = gens[genNames[ri(genNames.length)]](sizes[ri(sizes.length)]);
          const frame = Buffer.from(zlib.zstdCompressSync(Buffer.from(src), {}));
          expect(eq(local.decompressSync(new Uint8Array(frame)), src)).toBe(true);
          break;
        }
        default: {
          // Large highly-compressible foreign frame: 4 MB → single-pass decode;
          // 8/12 MB → over the sync cap, forcing the streaming decode engine.
          const size = [4, 8, 12][ri(3)] * 1024 * 1024;
          const src = new Uint8Array(size).fill(0xcd);
          const frame = Buffer.from(zlib.zstdCompressSync(Buffer.from(src), {}));
          const back = local.decompressSync(new Uint8Array(frame));
          expect(back.length).toBe(size);
          expect(back[0]).toBe(0xcd);
          expect(back[size - 1]).toBe(0xcd);
        }
      }
    }

    // The canary must still compress identically and round-trip after the run.
    expect(Buffer.from(local.compressSync(canary)).equals(canaryComp)).toBe(true);
    expect(eq(local.decompressSync(canaryComp), canary)).toBe(true);
  }, 180000);
});
