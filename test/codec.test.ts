/**
 * Codec (encoder) tests. Round-trip via the codec wasm's own decoder,
 * plus host-zstd cross-decode to verify spec-compliant output.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
 * The combined codec times-share one 12 MB buffer between compress and
 * decompress on a single instance. This exercises exactly the interleaving
 * that could corrupt shared heap state: streaming-compress (which lazily
 * allocates CStream staging in the arena) → a large decode that overwrites
 * that region → streaming-compress again on the SAME instance.
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
 * Regression: streaming compress relocates the CCtx workspace high into the
 * shared arena. A subsequent large *single-pass* decode (declared FCS,
 * compressed < 2 MB) writes its output over that region. Before the
 * cwksp-rebuild fix (initCompressor/compress free the workspace so it is
 * rebuilt at the JS-anchored cursor), the next compress reused the clobbered
 * workspace and trapped with an out-of-bounds access. The prior interleave
 * test missed this because its big decode took the *streaming* decode path
 * (small rolling buffer), which never overlaps the compressor workspace.
 */
describe('workspace-clobber regression (streaming-compress → single-pass decode → compress)', () => {
  test('a large single-pass decode does not corrupt the compressor workspace', async () => {
    const zlib = await import('node:zlib');
    const local = await createCodec({ level: 1, maxSrcSize: 1 * 1024 * 1024 });

    // Foreign frame with declared FCS whose compressed size stays under the
    // 2 MB single-pass input cap but decodes to ~6 MB — big enough to overlap
    // the relocated streaming-compress workspace.
    const bigConst = new Uint8Array(6 * 1024 * 1024).fill(0xab);
    const frame = new Uint8Array(
      zlib.zstdCompressSync(bigConst, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
      }),
    );
    expect(frame.length).toBeLessThan(2 * 1024 * 1024);

    const streamInput = txt(200_000); // ~9 MB > maxSrcSize → streaming compress

    // 1) streaming compress relocates the workspace high into the arena.
    expect(bufEq(local.decompressSync(local.compressSync(streamInput)), streamInput)).toBe(true);
    // 2) large single-pass decode writes over that region.
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
