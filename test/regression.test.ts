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

/**
 * Formerly large-compressible.test.ts — decoding LARGE, highly-compressible
 * frames (>10 MB decompressed, <2 MB compressed). suite.test.ts's random-data
 * streaming tests never hit this regime (compressed size ~= input size), masking
 * a size-hint misparse and a content-size-vs-window confusion in the stream.
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

  test('ZstdDecompressionStream roundtrips', async () => {
    const { ZstdDecompressionStream } = await import('../dist/esm/index.node.js');
    const stream = new ZstdDecompressionStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    void writer.write(compressed);
    void writer.close();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(hash(Buffer.concat(chunks))).toBe(hash(data));
  });
});

/**
 * Formerly streaming-chunked.test.ts — ZstdDecompressionStream fed in small
 * chunks. When the buffering threshold is crossed after more than one chunk was
 * buffered, the decoder must receive ALL buffered bytes, not just the latest
 * chunk (else the prefix is dropped and the stream corrupts). Shows up only when
 * the frame exceeds minRecvSize (~256 KB) AND arrives in smaller pieces.
 */
describe('ZstdDecompressionStream chunked input', () => {
  const SIZE = 1024 * 1024; // 1 MB → compressed comfortably over the 256 KB threshold
  let data: Buffer;
  let declaredFrame: Buffer;
  let unknownFrame: Buffer;

  // Deterministic, incompressible payload (compressed size ~= input size).
  function makeIncompressible(size: number): Buffer {
    const out = Buffer.alloc(size);
    let seed = createHash('sha256').update('streaming-chunked-seed').digest();
    for (let off = 0; off < size; off += 32) {
      seed = createHash('sha256').update(seed).digest();
      seed.copy(out, off, 0, Math.min(32, size - off));
    }
    return out;
  }

  // Streaming compression — emits a frame with UNKNOWN content size.
  async function streamingCompress(buf: Buffer): Promise<Buffer> {
    const z = zlib.createZstdCompress();
    const out: Buffer[] = [];
    z.on('data', (d: Buffer) => out.push(d));
    const done = new Promise<void>((res) => z.on('end', () => res()));
    z.end(buf);
    await done;
    return Buffer.concat(out);
  }

  async function streamDecompressChunked(comp: Buffer, chunkSize: number): Promise<Buffer> {
    const { ZstdDecompressionStream } = await import('../dist/esm/index.node.js');
    const stream = new ZstdDecompressionStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    (async () => {
      for (let i = 0; i < comp.length; i += chunkSize) {
        await writer.write(comp.subarray(i, i + chunkSize));
      }
      await writer.close();
    })();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  beforeAll(async () => {
    const { createDecoder } = await import('../dist/esm/index.node.js');
    await createDecoder();
    data = makeIncompressible(SIZE);
    declaredFrame = Buffer.from(zlib.zstdCompressSync(data, {})); // declares content size
    unknownFrame = await streamingCompress(data); // unknown content size
    expect(declaredFrame.length).toBeGreaterThan(256 * 1024);
    expect(unknownFrame.length).toBeGreaterThan(256 * 1024);
  });

  for (const chunkSize of [16 * 1024, 64 * 1024]) {
    test(`declared content size, ${chunkSize / 1024}KB chunks`, async () => {
      expect(hash(await streamDecompressChunked(declaredFrame, chunkSize))).toBe(hash(data));
    });
    test(`unknown content size, ${chunkSize / 1024}KB chunks`, async () => {
      expect(hash(await streamDecompressChunked(unknownFrame, chunkSize))).toBe(hash(data));
    });
  }
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
 * Audit 2026-07-09 §2.1 — pool-lock bypass. A `ZstdDecompressionStream` holds a
 * pooled decoder locked *across awaits*; a `decompressSync` in between used to
 * grab `pool[0]` regardless of lock state, resetting the shared ZSTD_DCtx and
 * heap cursor mid-stream and corrupting the in-flight decode. The fix takes a
 * free slot (or a transient instance), never a locked one. The encoder has the
 * symmetric hazard: `compressSync`'s all-busy fallback must build a transient
 * encoder instead of reusing a slot a `ZstdCompressionStream` is parked on.
 */
describe('pool-lock bypass — sync calls do not disturb in-flight streams', () => {
  const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

  function incompressible(n: number): Buffer {
    const out = Buffer.alloc(n);
    let seed = createHash('sha256').update('pool-lock-seed').digest();
    for (let off = 0; off < n; off += 32) {
      seed = createHash('sha256').update(seed).digest();
      seed.copy(out, off, 0, Math.min(32, n - off));
    }
    return out;
  }

  async function readAll(readable: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  test('decompressSync mid-stream leaves the stream uncorrupted', async () => {
    const { createDecoder, decompressSync, ZstdDecompressionStream } =
      await import('../dist/esm/index.node.js');
    await createDecoder();

    const streamSrc = incompressible(1024 * 1024); // compressed ~= 1 MB, exceeds minRecvSize
    const streamFrame = Buffer.from(zlib.zstdCompressSync(streamSrc, {}));
    const syncSrc = Buffer.from('interleaved sync decode payload '.repeat(2000));
    const syncFrame = Buffer.from(zlib.zstdCompressSync(syncSrc, {}));

    const stream = new ZstdDecompressionStream();
    const writer = stream.writable.getWriter();
    const readPromise = readAll(stream.readable);

    // Feed enough to cross minRecvSize so the stream acquires (and locks) a
    // pooled decoder, then parks between chunks.
    const CH = 64 * 1024;
    let i = 0;
    for (; i < streamFrame.length && i < 400 * 1024; i += CH) {
      await writer.write(streamFrame.subarray(i, i + CH));
    }

    // Interleaved sync decode while the stream holds a pooled slot.
    expect(sha(decompressSync(syncFrame))).toBe(sha(syncSrc));

    for (; i < streamFrame.length; i += CH) await writer.write(streamFrame.subarray(i, i + CH));
    await writer.close();
    expect(sha(await readPromise)).toBe(sha(streamSrc));
  });

  test('compressSync while all pool encoders are held by open streams', async () => {
    const { setupZstdCodec, compressSync, decompress, ZstdCompressionStream } =
      await import('../dist/esm/index.node.js');
    await setupZstdCodec({});

    const N = 3; // == encoder pool max; open enough streams to lock every slot
    const srcs = Array.from({ length: N }, (_, i) => Buffer.from(`stream ${i} body `.repeat(3000)));
    const streams = srcs.map(() => new ZstdCompressionStream({ level: 1 }));
    const writers = streams.map((s) => s.writable.getWriter());
    const reads = streams.map((s) => readAll(s.readable));

    // First chunk to each stream acquires and locks all pool encoders.
    for (let i = 0; i < N; i++) await writers[i].write(srcs[i].subarray(0, 100));

    // Whole pool busy → compressSync must run on a transient encoder.
    const syncSrc = Buffer.from('interleaved sync compress payload '.repeat(2000));
    expect(sha(await decompress(compressSync(syncSrc, { level: 1 })))).toBe(sha(syncSrc));

    for (let i = 0; i < N; i++) {
      await writers[i].write(srcs[i].subarray(100));
      await writers[i].close();
    }
    const comps = await Promise.all(reads);
    for (let i = 0; i < N; i++) {
      expect(sha(await decompress(comps[i]))).toBe(sha(srcs[i]));
    }
  });
});

/**
 * Audit 2026-07-09 §4.5 — skippable frames. Both the single-pass decoder
 * (`dm()`, bin/zstd_wasm_full.c) and the JS streaming path have dedicated
 * handling for skippable frames (magic 0x184D2A50..0x184D2A5F), but nothing
 * exercised it. Cover one skippable frame sandwiched between real frames, and
 * one whose header is split across tiny streaming chunk boundaries.
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

  test('streaming: skippable header split across chunk boundaries', async () => {
    const { createDecoder, ZstdDecompressionStream } = await import('../dist/esm/index.node.js');
    await createDecoder();

    // Payload big enough to force the streaming path (over minRecvSize).
    const payload = Buffer.from('x'.repeat(400 * 1024));
    const frame = Buffer.from(zlib.zstdCompressSync(payload, {}));
    const cat = Buffer.concat([frame, skippable(Buffer.alloc(1000, 7)), frame]);

    const stream = new ZstdDecompressionStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // 7-byte chunks straddle the 8-byte skippable magic/size header.
    void (async () => {
      for (let i = 0; i < cat.length; i += 7) await writer.write(cat.subarray(i, i + 7));
      await writer.close();
    })();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(sha(Buffer.concat(chunks))).toBe(sha(Buffer.concat([payload, payload])));
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
 *    buffer must still be handled safely — the streaming public `decompress`
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

    // Streaming public entry handles arbitrary totals.
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
 * Audit 2026-07-09 §4.8 — hostage-byte tail-drain. The JS streaming decoder
 * stages output through a fixed 917501-byte buffer; high-ratio frames whose
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
