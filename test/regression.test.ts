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
  // _MAX_DST_BUF_DEFAULT (9_830_464) * 64 — the finite floor the constructor
  // must apply when no options are given.
  const FLOOR = 9830464 * 64;

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
 * Formerly large-compressible.test.ts — decoding LARGE, highly-compressible
 * frames (>10 MB decompressed, <2 MB compressed). suite.test.ts's random-data
 * decompression tests never hit this regime (compressed size ~= input size), masking
 * a size-hint misparse and a content-size-vs-window confusion in the internal engine.
 */
describe('large highly-compressible frame (>10MB out, <2MB in)', () => {
  const SIZE = 12 * 1024 * 1024; // 12 MB decompressed — comfortably over 10 MB
  let data: Buffer;
  let compressed: Buffer;

  // Deterministic, highly-compressible payload: repeating tokens, squashed to a
  // few hundred KB. Compressed one-shot, which declares Frame_Content_Size.
  function makeCompressible(size: number): Buffer {
    const buf = Buffer.alloc(size);
    const tokens = [
      'the quick brown fox ',
      'lorem ipsum dolor ',
      '{"k":1,"v":',
      '0000000000',
      'ABCDEF',
    ];
    let off = 0;
    let i = 0;
    while (off < size) {
      const t = tokens[i++ % tokens.length];
      const n = Math.min(t.length, size - off);
      buf.write(t.slice(0, n), off, 'latin1');
      off += n;
    }
    return buf;
  }

  beforeAll(async () => {
    const { createDecoder } = await import('../dist/esm/index.node.js');
    await createDecoder(); // warm the cached wasm module so decompressSync works
    data = makeCompressible(SIZE);
    compressed = Buffer.from(zlib.zstdCompressSync(data, {}));
    expect(data.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(compressed.length).toBeLessThan(2 * 1024 * 1024);
  });

  test('decompress() roundtrips', async () => {
    const { decompress } = await import('../dist/esm/index.node.js');
    expect(hash(Buffer.from(await decompress(compressed)))).toBe(hash(data));
  });

  test('decompressSync() roundtrips', async () => {
    const { decompressSync } = await import('../dist/esm/index.node.js');
    expect(hash(Buffer.from(decompressSync(compressed)))).toBe(hash(data));
  });
});

/**
 * Dictionary support was removed (v0.3.0) — the decoder must reject frames
 * that reference a dictionary ID with a clean ZSTD error (dictionary_wrong,
 * -32) rather than decode garbage or trap.
 */
describe('dictionary-referencing frames are rejected', () => {
  // Minimal hand-crafted frame: magic + FHD(0x21: single-segment, 1-byte
  // dictID) + dictID(5) + FCS(1 byte content) + one raw last-block with a
  // single payload byte.
  const dictFrame = Uint8Array.from([
    0x28,
    0xb5,
    0x2f,
    0xfd, // magic
    0x21, // FHD: singleSegment=1, dictIDflag=1
    0x05, // dictID = 5
    0x01, // frame content size = 1
    0x09,
    0x00,
    0x00, // block header: last=1, type=raw, size=1
    0x42, // payload
  ]);

  test('decompress() fails with a ZSTD error, not garbage output', async () => {
    const { decompress } = await import('../dist/esm/index.node.js');
    await expect(decompress(dictFrame)).rejects.toThrow(/dec err/);
  });

  test('decompressSync() fails likewise', async () => {
    const { decompressSync, createDecoder } = await import('../dist/esm/index.node.js');
    await createDecoder(); // ensure the wasm module is cached
    expect(() => decompressSync(dictFrame)).toThrow();
  });
});

/**
 * Regression — inlined-WASM base64 fallback for runtimes without
 * `Uint8Array.fromBase64` (Chrome < 140, Safari < 18.2, Firefox < 133 — all
 * inside the package's browserslist range). The old fallback,
 * `new TextEncoder().encode(atob(WASM_BASE64))`, UTF-8-encoded the latin1 byte
 * string, so every byte >= 0x80 became two bytes and the deflate-raw'd wasm blob
 * failed to inflate/compile. The fix decodes via a charCodeAt loop. Exercises the
 * real path by deleting Uint8Array.fromBase64 before the loader runs; the inlined
 * bundle carries its own shared.ts state, so the node entrypoint's cache is
 * independent and the loader really fires here.
 */
describe('inlined-WASM base64 fallback (no Uint8Array.fromBase64)', () => {
  test('decodes to a valid wasm module and round-trips a frame', async () => {
    const original = (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
    // delete to force the fallback branch (no Uint8Array.fromBase64)
    delete (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
    try {
      const { createDecoder, decompress } = await import('../dist/esm/index.inlined.js');
      await createDecoder(); // triggers the inlined loader → fallback decode + compile
      const data = Buffer.from('inlined fallback base64 regression '.repeat(64));
      const compressed = Buffer.from(zlib.zstdCompressSync(data, {}));
      expect(hash(Buffer.from(await decompress(compressed)))).toBe(hash(data));
    } finally {
      if (original !== undefined) {
        (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 = original;
      }
    }
  });
});

/**
 * Formerly malloc-bounds.test.ts — the wasm bump allocator over fixed,
 * non-growable memory must refuse any request that would run past the end of
 * memory by returning NULL (0). The cursor is driven to the boundary via
 * setHeapEnd to exercise the guard directly.
 */
describe('malloc bounds guard', () => {
  interface CodecExports {
    memory: WebAssembly.Memory;
    _initialize(): void;
    malloc(size: number): number;
    setHeapEnd(cursor: number): void;
  }

  function instantiate(variant: string): CodecExports {
    const bytes = readFileSync(join(__dirname, '../dist/esm', variant));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: {} });
    const ex = inst.exports as unknown as CodecExports;
    ex._initialize();
    return ex;
  }

  for (const variant of ['zstd.wasm', 'zstd-perf.wasm']) {
    test(`${variant}: refuses over-budget allocations with NULL instead of trapping`, () => {
      const ex = instantiate(variant);
      const memBytes = ex.memory.buffer.byteLength;

      const p = ex.malloc(1024);
      expect(p).toBeGreaterThan(0);
      expect(p + 1024).toBeLessThanOrEqual(memBytes);

      ex.setHeapEnd(memBytes - 64);
      expect(ex.malloc(64)).toBe(memBytes - 64); // exactly fills the tail
      expect(ex.malloc(1)).toBe(0); // heap full → NULL

      ex.setHeapEnd(memBytes - 64);
      expect(ex.malloc(65)).toBe(0); // larger than free tail → NULL

      // Pathological sizes rejected without integer-overflow wraparound.
      ex.setHeapEnd(1024);
      expect(ex.malloc(0xffffffff)).toBe(0);
      expect(ex.malloc(memBytes)).toBe(0);

      // Rejected calls must not have advanced the cursor.
      ex.setHeapEnd(1024);
      expect(ex.malloc(2048)).toBe(1024);
    });
  }
});

/**
 * Audit 2026-07-09 §4.5 — skippable frames. The single-pass decoder
 * (`dm()`, bin/zstd_wasm_full.c) has dedicated handling for skippable frames
 * (magic 0x184D2A50..0x184D2A5F), but nothing exercised it. Cover one
 * skippable frame sandwiched between real frames.
 */
describe('skippable frames are skipped', () => {
  const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

  // magic (LE) + frame_size (LE32) + user data
  const skippable = (payload: Buffer, variant = 0): Buffer => {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32LE(0x184d2a50 + (variant & 0xf), 0);
    hdr.writeUInt32LE(payload.length, 4);
    return Buffer.concat([hdr, payload]);
  };

  test('one-shot: skippable frame mid-concatenation is dropped', async () => {
    const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
    await createDecoder();

    const a = Buffer.from('AAAA'.repeat(500));
    const b = Buffer.from('BBBB'.repeat(500));
    const fa = Buffer.from(zlib.zstdCompressSync(a, {}));
    const fb = Buffer.from(zlib.zstdCompressSync(b, {}));
    const cat = Buffer.concat([fa, skippable(Buffer.from('user metadata — ignore me'), 5), fb]);

    expect(sha(await decompress(cat))).toBe(sha(Buffer.concat([a, b])));
  });
});

/**
 * Audit 2026-07-09 §4.6 — golden decompression fixtures were decoded but never
 * checked against expected bytes (only the all-zeros ones were hashed). Pin the
 * exact output of the non-trivial goldens against an independent oracle
 * (node:zlib), so a silent decode regression can't slip through.
 */
describe('golden decompression — exact output bytes', () => {
  const GOLDEN_DIR = join(__dirname, 'edge-cases', 'golden-decompression');

  for (const file of ['block-128k.zst', 'zeroSeq_2B.zst']) {
    test(`${file} decodes byte-identical to node:zlib`, async () => {
      const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
      await createDecoder();
      const comp = readFileSync(join(GOLDEN_DIR, file));
      const expected = Buffer.from(zlib.zstdDecompressSync(comp));
      expect(hash(Buffer.from(await decompress(comp)))).toBe(hash(expected));
    });
  }
});

/**
 * Audit 2026-07-09 §4.7 / §2.2 — size-hint parsing boundaries.
 *  - `rb`/`_fss` must read an 8-byte Frame_Content_Size (fcf=3) and top-bit-set
 *    4-byte fields without the `<<`-wrap / signedness bug (fixed in 2.2).
 *  - `decompressSync` sizes its single-pass dst buffer from `_fss`, which only
 *    reflects frame ONE. Concatenated frames whose *total* output exceeds that
 *    buffer must still be handled safely — the public one-shot `decompress`
 *    round-trips them, and `decompressSync` must never return corrupt bytes
 *    (it fails cleanly with a ZSTD error instead).
 */
describe('size-hint parsing boundaries', () => {
  test('rb/_fss read fcf=3 (8-byte) and top-bit-set fields exactly', async () => {
    const { rb, _fss } = await import('../src/utils.ts');

    const FOUR_GIB = 4 * 1024 ** 3; // 4294967296 — beyond 32-bit
    const fcs = new Uint8Array(8);
    let v = FOUR_GIB;
    for (let i = 0; i < 8; i++) {
      fcs[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    // magic + flags(fcf=3 → 0xC0, single-segment off, dict off) + window + FCS(8)
    const header = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0xc0, 0x00, ...fcs]);

    expect(rb(fcs, 0, 8)).toBe(FOUR_GIB);
    expect(_fss(header)).toBe(FOUR_GIB);
    // 4-byte little-endian read with the high bit set must stay unsigned.
    expect(rb(Uint8Array.from([0x00, 0x00, 0x00, 0x80]), 0, 4)).toBe(2147483648);
  });

  test('concatenated frames exceeding the sync dst buffer stay safe', async () => {
    const { createDecoder, decompress, decompressSync } = await import('../dist/esm/index.node.js');
    await createDecoder();

    // Each frame declares only ~1 MB (well under the ~9.4 MB sync buffer), but
    // the concatenation totals 12 MB — _fss sees only the first frame's size.
    const oneMB = Buffer.alloc(1024 * 1024, 0xab);
    const frame = Buffer.from(zlib.zstdCompressSync(oneMB, {}));
    const N = 12;
    const cat = Buffer.concat(Array.from({ length: N }, () => frame));
    const expected = hash(Buffer.alloc(N * oneMB.length, 0xab));

    // One-shot public `decompress` handles arbitrary totals.
    expect(hash(Buffer.from(await decompress(cat)))).toBe(expected);

    // Single-pass sync must not return corrupt bytes: either exact, or a clean throw.
    let syncResult: string | null = null;
    try {
      syncResult = hash(Buffer.from(decompressSync(cat)));
    } catch (e) {
      expect(String(e)).toMatch(/dec err/);
    }
    if (syncResult !== null) expect(syncResult).toBe(expected);
  });
});

/**
 * Audit 2026-07-09 §4.8 — hostage-byte tail-drain. The internal streaming decode
 * engine stages output through a fixed 917501-byte buffer; high-ratio frames whose
 * decompressed size lands on (or just off) a multiple of that stride are the
 * boundary where a tail byte could be dropped. Upstream's hostage-byte
 * mechanism covers it — this pins that no truncation creeps in.
 */
describe('hostage-byte tail-drain — no truncation at staging-buffer multiples', () => {
  const STAGE = 917501;

  test('high-ratio frames around 1–4× the staging stride round-trip', async () => {
    const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
    await createDecoder();

    for (const k of [1, 2, 3, 4]) {
      for (const delta of [-2, -1, 0, 1, 2]) {
        const n = k * STAGE + delta;
        const src = Buffer.alloc(n, 0x5a); // maximally compressible
        const comp = Buffer.from(zlib.zstdCompressSync(src, {}));
        const out = Buffer.from(await decompress(comp));
        expect(out.length).toBe(n);
        expect(hash(out)).toBe(hash(src));
      }
    }
  });
});

/**
 * Audit follow-up — truncated frames. The internal decode loop stopped once
 * its input ran out and returned whatever it had decoded, so the one-shot
 * `decompress()` (which always routes through the internal streaming engine) silently returned a
 * *partial* buffer for a truncated frame — while `decompressSync()`'s one-shot
 * `dm()` path correctly errored. The two public APIs disagreed and the async
 * one handed back corrupt data. A `final` flag now makes the one-shot entries
 * assert the frame completed.
 */
describe('truncated frames throw on the one-shot APIs', () => {
  function mk(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 3)) & 0xff; // semi-compressible
    return b;
  }

  async function unknownSizeFrame(buf: Buffer): Promise<Buffer> {
    const z = zlib.createZstdCompress();
    const out: Buffer[] = [];
    z.on('data', (d: Buffer) => out.push(d));
    const done = new Promise<void>((res) => z.on('end', () => res()));
    z.end(buf);
    await done;
    return Buffer.concat(out); // frame with UNKNOWN content size
  }

  test('declared-content-size frame, tail truncated → decompress() throws', async () => {
    const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
    await createDecoder();
    const data = mk(3 * 1024 * 1024);
    const frame = Buffer.from(zlib.zstdCompressSync(data, {}));
    const truncated = frame.subarray(0, frame.length - 20);
    await expect(decompress(truncated)).rejects.toThrow(/truncated|dec err/);
  });

  test('unknown-content-size frame, tail truncated → decompress() throws', async () => {
    const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
    await createDecoder();
    const data = mk(3 * 1024 * 1024);
    const frame = await unknownSizeFrame(data);
    const truncated = frame.subarray(0, frame.length - 20);
    await expect(decompress(truncated)).rejects.toThrow(/truncated|dec err/);
  });

  test('unknown-content-size frame, tail truncated → decompressSync() throws', async () => {
    const { createDecoder, decompressSync } = await import('../dist/esm/index.node.js');
    await createDecoder();
    const data = mk(3 * 1024 * 1024);
    const frame = await unknownSizeFrame(data);
    const truncated = frame.subarray(0, frame.length - 20);
    expect(() => decompressSync(truncated)).toThrow(/truncated|dec err/);
  });

  test('a complete frame still round-trips (no false positive)', async () => {
    const { createDecoder, decompress } = await import('../dist/esm/index.node.js');
    await createDecoder();
    const data = mk(3 * 1024 * 1024);
    for (const frame of [
      Buffer.from(zlib.zstdCompressSync(data, {})),
      await unknownSizeFrame(data),
    ]) {
      expect(hash(Buffer.from(await decompress(frame)))).toBe(hash(data));
    }
  });
});
