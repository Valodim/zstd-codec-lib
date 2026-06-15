/**
 * Regression tests for ZstdDecompressionStream fed in SMALL CHUNKS.
 *
 * The class buffers incoming chunks until `bytesRead` reaches `minRecvSize`,
 * then begins decoding. The bug: when the threshold is crossed after more
 * than one chunk has been buffered, the decoder is handed only the *current*
 * chunk — every chunk buffered before it is silently dropped. The decoder
 * then sees mid-frame bytes and fails ("dec err -10", prefix_unknown), or
 * would otherwise emit corrupt output.
 *
 * This only shows up when the compressed stream is larger than minRecvSize
 * (~256 KB, or the declared content size) AND arrives in pieces smaller than
 * that — i.e. essentially any real network/file stream of a non-tiny frame.
 * The existing suite's ZstdDecompressionStream tests use <=100 KB inputs, so
 * they always stay under the threshold and fall back to the one-shot flush
 * path, masking this.
 *
 * Run with:
 *   yarn vitest run --config test/vitest.config.ts test/streaming-chunked.test.ts
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';

const { createDecoder, ZstdDecompressionStream } = await import('../dist/esm/index.node.js');

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Deterministic, incompressible payload (so compressed size ~= input size,
 * comfortably above the ~256 KB minRecvSize threshold). */
function makeIncompressible(size: number): Buffer {
  const out = Buffer.alloc(size);
  let seed = createHash('sha256').update('streaming-chunked-seed').digest();
  for (let off = 0; off < size; off += 32) {
    seed = createHash('sha256').update(seed).digest();
    seed.copy(out, off, 0, Math.min(32, size - off));
  }
  return out;
}

/** One-shot compression: declares Frame_Content_Size in the header. */
const oneShot = (buf: Buffer): Buffer => Buffer.from(zlib.zstdCompressSync(buf, {}));

/** Streaming compression: emits a frame with UNKNOWN content size. */
async function streamingCompress(buf: Buffer): Promise<Buffer> {
  const z = zlib.createZstdCompress();
  const out: Buffer[] = [];
  z.on('data', (d: Buffer) => out.push(d));
  const done = new Promise<void>((res) => z.on('end', () => res()));
  z.end(buf);
  await done;
  return Buffer.concat(out);
}

async function streamDecompressChunked(compressed: Buffer, chunkSize: number): Promise<Buffer> {
  const stream = new ZstdDecompressionStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  (async () => {
    for (let i = 0; i < compressed.length; i += chunkSize) {
      await writer.write(compressed.subarray(i, i + chunkSize));
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

const SIZE = 1024 * 1024; // 1 MB → compressed comfortably over the 256 KB threshold
let data: Buffer;
let declaredFrame: Buffer;
let unknownFrame: Buffer;

beforeAll(async () => {
  await createDecoder(); // warm the cached wasm module
  data = makeIncompressible(SIZE);
  declaredFrame = oneShot(data);
  unknownFrame = await streamingCompress(data);
  expect(declaredFrame.length).toBeGreaterThan(256 * 1024);
  expect(unknownFrame.length).toBeGreaterThan(256 * 1024);
});

describe('ZstdDecompressionStream chunked input', () => {
  for (const chunkSize of [16 * 1024, 64 * 1024]) {
    test(`declared content size, ${chunkSize / 1024}KB chunks`, async () => {
      const out = await streamDecompressChunked(declaredFrame, chunkSize);
      expect(hash(out)).toBe(hash(data));
    });

    test(`unknown content size, ${chunkSize / 1024}KB chunks`, async () => {
      const out = await streamDecompressChunked(unknownFrame, chunkSize);
      expect(hash(out)).toBe(hash(data));
    });
  }
});
