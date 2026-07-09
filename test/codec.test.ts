/**
 * Codec (encoder) tests. Round-trip via the codec wasm's own decoder,
 * plus host-zstd cross-decode to verify spec-compliant output.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, test, beforeAll } from 'vitest';

import { compress, decompress, setupZstdCodec } from '../dist/esm/index.node.js';

// Compression is level-1-only — the encoder rejects any other level.
const LEVELS = [1] as const;
// Decoding must stay future-proof for foreign frames up to level 9.
const DECODE_LEVELS = [1, 3, 6, 9] as const;

beforeAll(async () => {
  await setupZstdCodec({});
});

const txt = (n: number): Uint8Array =>
  new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(n));

function bufEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('high-level compress/decompress', () => {
  for (const level of LEVELS) {
    test(`round-trip text @ level ${level}`, async () => {
      const src = txt(500); // ~22 KB compressible text
      const compressed = await compress(src, { level });
      expect(compressed.length).toBeLessThan(src.length / 2);
      const decoded = await decompress(compressed);
      expect(bufEq(decoded, src)).toBe(true);
    });

    test(`round-trip random @ level ${level}`, async () => {
      const src = new Uint8Array(randomBytes(64 * 1024));
      const compressed = await compress(src, { level });
      // Random data won't compress meaningfully — but it must round-trip.
      const decoded = await decompress(compressed);
      expect(bufEq(decoded, src)).toBe(true);
    });
  }
});

describe('ZstdEncoder direct API', () => {
  for (const level of LEVELS) {
    test(`compressSync @ level ${level}`, async () => {
      const src = txt(200);
      const enc = await (await import('../dist/esm/index.node.js')).createEncoder({ level });
      const out = enc.compressSync(src);
      expect(out.length).toBeLessThan(src.length / 2);
      const decoded = await decompress(out);
      expect(bufEq(decoded, src)).toBe(true);
    });
  }
});

describe('host zstd cross-decode', () => {
  // Skip if host zstd isn't installed.
  const hostZstd = spawnSync('zstd', ['--version']);
  const hostAvailable = hostZstd.status === 0;

  for (const level of LEVELS) {
    test.skipIf(!hostAvailable)(`wasm-encode → host zstd-decode @ level ${level}`, async () => {
      const src = txt(500);
      const compressed = await compress(src, { level });
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
    test.skipIf(!hostAvailable)(`host zstd-encode → wasm-decode @ level ${level}`, async () => {
      const src = txt(500);
      const result = spawnSync('zstd', [`-${level}`, '--stdout'], {
        input: Buffer.from(src),
        encoding: 'buffer',
      });
      expect(result.status).toBe(0);
      const decoded = await decompress(new Uint8Array(result.stdout));
      expect(bufEq(decoded, src)).toBe(true);
    });
  }
});

describe('encoder pool concurrency', () => {
  test('concurrent compress() calls all round-trip cleanly', async () => {
    // 8 inputs of varying content, compressed in parallel. The pool
    // capped at 3 means at least 5 are transient — verifying both
    // pooled and transient paths hold.
    const inputs = Array.from({ length: 8 }, (_, i) =>
      new TextEncoder().encode(`payload ${i}: ${'x'.repeat(1000 * (i + 1))}`),
    );

    const compressed = await Promise.all(inputs.map((src) => compress(src, { level: 1 })));

    const decoded = await Promise.all(compressed.map((c) => decompress(c)));

    for (let i = 0; i < inputs.length; i++) {
      expect(bufEq(decoded[i], inputs[i])).toBe(true);
    }
  });
});

describe('edge cases', () => {
  test('empty input', async () => {
    const compressed = await compress(new Uint8Array(0));
    const decoded = await decompress(compressed);
    expect(decoded.length).toBe(0);
  });

  test('1-byte input', async () => {
    const src = new Uint8Array([42]);
    const compressed = await compress(src);
    const decoded = await decompress(compressed);
    expect(bufEq(decoded, src)).toBe(true);
  });

  test('large highly-compressible input (1 MB)', async () => {
    const src = new Uint8Array(1024 * 1024);
    src.fill(0xab);
    const compressed = await compress(src, { level: 1 });
    expect(compressed.length).toBeLessThan(1024); // should compress to almost nothing
    const decoded = await decompress(compressed);
    expect(bufEq(decoded, src)).toBe(true);
  });

  test('rejects any compression level other than 1', async () => {
    // @ts-expect-error level is typed as `1`; runtime must also reject 2/3/etc.
    await expect(compress(txt(10), { level: 2 })).rejects.toThrow();
    // @ts-expect-error
    await expect(compress(txt(10), { level: 3 })).rejects.toThrow();
    // @ts-expect-error
    await expect(compress(txt(10), { level: 5 })).rejects.toThrow();
    // @ts-expect-error
    await expect(compress(txt(10), { level: 0 })).rejects.toThrow();
  });
});
