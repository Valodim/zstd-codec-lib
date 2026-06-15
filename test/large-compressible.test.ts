/**
 * Regression tests for decoding LARGE, HIGHLY-COMPRESSIBLE frames (>10 MB
 * decompressed, but only a few hundred KB compressed).
 *
 * Why this file exists separately from suite.test.ts:
 *   suite.test.ts already has 16 MB / 256 MB streaming tests, but they all
 *   use INCOMPRESSIBLE random data. For random data the compressed size is
 *   ~= the input size, so it exceeds _MAX_SRC_BUF (2 MB) and the decoder is
 *   forced down the streaming path regardless of the size hint. That path
 *   masks two real bugs that only surface when the compressed input is small
 *   (<= 2 MB) while the decompressed output is large (> ~8 MB):
 *
 *     1. ZstdDecompressionStream throws "win 2 large" — rzfh() rejects any
 *        frame whose *declared content size* exceeds 10 MB (it checks the
 *        content size, not the window size, and the throw is uncaught inside
 *        TransformStream.transform).
 *
 *     2. decompressSync() throws "dec err -70" (dstSize_tooSmall) — the frame
 *        size hint (_fss) misparses the header, returns a negative number,
 *        and the routing logic therefore picks the bounded sync buffer
 *        (~8 MB) instead of streaming, which then overflows.
 *
 * Real-world payloads (logs, JSON, HTML, telemetry) are exactly this shape:
 * large when expanded, tiny when compressed. They are the "future proof up
 * to level 9" decode case, so they deserve direct coverage.
 *
 * Run with:
 *   yarn vitest run --config test/vitest.config.ts test/large-compressible.test.ts
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';

// Same import surface the wasm-adapter uses: the built node entrypoint.
const {
  createDecoder,
  decompress,
  decompressSync,
  ZstdDecompressionStream,
} = await import('../dist/esm/index.node.js');

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Deterministic, highly-compressible payload of `size` bytes: a small set of
 * repeating tokens, so zstd squashes it to a few hundred KB. Compressed via
 * node:zlib one-shot, which declares Frame_Content_Size in the header (the
 * trigger for both bugs).
 */
function makeCompressible(size: number): Buffer {
  const buf = Buffer.alloc(size);
  const tokens = ['the quick brown fox ', 'lorem ipsum dolor ', '{"k":1,"v":', '0000000000', 'ABCDEF'];
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

const SIZE = 12 * 1024 * 1024; // 12 MB decompressed — comfortably over 10 MB
let data: Buffer;
let compressed: Buffer;

beforeAll(async () => {
  // Warm the cached wasm module so the synchronous decompressSync() works.
  await createDecoder();

  data = makeCompressible(SIZE);
  compressed = Buffer.from(zstdCompressSync(data, {}));
  // Sanity: this is the regime the existing suite never exercises.
  expect(data.length).toBeGreaterThan(10 * 1024 * 1024);
  expect(compressed.length).toBeLessThan(2 * 1024 * 1024);
});

async function streamDecompress(buf: Buffer): Promise<Buffer> {
  const stream = new ZstdDecompressionStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  void writer.write(buf);
  void writer.close();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe('large highly-compressible frame (>10MB decompressed, <2MB compressed)', () => {
  test('decompress() function roundtrips', async () => {
    const out = await decompress(compressed);
    expect(hash(out)).toBe(hash(data));
  });

  test('decompressSync() roundtrips', () => {
    const out = decompressSync(compressed);
    expect(hash(out)).toBe(hash(data));
  });

  test('ZstdDecompressionStream roundtrips', async () => {
    const out = await streamDecompress(compressed);
    expect(hash(out)).toBe(hash(data));
  });
});
