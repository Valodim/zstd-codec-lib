import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { nodeAdapter } from './adapters/node-adapter.ts';
import { initWasmAdapter, wasmAdapter, ZstdDecompressionStream } from './adapters/wasm-adapter.ts';
import { ensureTestData } from './lib/test-data-generator.ts';
import { hash, slice } from './lib/utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMPRESSION_LEVELS = {
  ALL: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  REPRESENTATIVE: [1, 3, 6, 9, 12, 15, 19],
  STREAMING: [1, 6, 12, 19],
};

const TEST_FILES = [
  'tiny-256b.bin',
  'small-highly-compressible.bin',
  'medium-10k.bin',
  'random-10k.bin',
  'repetitive-50k.bin',
  'medium-100k.bin',
  'large-512k.bin',
  'large-1m.bin',
];

const TEST_SIZES = [256, 10 * 1024, 100 * 1024];

const TEST_DATA_DIR = join(__dirname, 'data');
const EDGE_CASES_DIR = join(__dirname, 'edge-cases');

let fixtureServer: any;

let decompressAdapter: any;

// Hash + compare faster than byte for byte comparison
const compressedCache = new Map<string, Buffer>();
const originalDataHashes = new Map<string, string>();

const randomBuffers = new Map<number, Buffer>();
const randomBufferHashes = new Map<number, string>();

beforeAll(async () => {
  ensureTestData();

  console.log('Generating random buffers...');
  [
    256,
    10 * 1024,
    20 * 1024,
    30 * 1024,
    50 * 1024,
    100 * 1024,
    512 * 1024,
    1024 * 1024,
    16 * 1024 * 1024,
  ].forEach((size) => randomBuffer(size));
  console.log(`Generated ${randomBuffers.size} random buffers`);

  console.log('Pre-compressing test data...');
  const testFiles = TEST_FILES.map((f) => loadTestFile(f));

  const compressionJobs: Array<{ data: Buffer; opts: any }> = [];
  for (const data of [...testFiles, ...randomBuffers.values()]) {
    for (const level of COMPRESSION_LEVELS.ALL) {
      compressionJobs.push({ data, opts: { level } });
    }
  }

  await Promise.all(
    compressionJobs.map(({ data, opts }) => Promise.resolve().then(() => compress(data, opts))),
  );

  console.log(`Pre-compressed ${compressedCache.size} variants`);

  await initWasmAdapter();

  const adapterType = process.env.TEST_ADAPTER;

  if (adapterType?.startsWith('browser-')) {
    console.log('Starting fixture server...');
    fixtureServer = spawn('bun', [join(__dirname, 'fixture-server.ts')], {
      stdio: 'inherit',
    });
    await new Promise((resolve) => setTimeout(resolve, 3500));
  }

  if (adapterType === 'browser-all') {
    const { createBrowserAdapter } = await import('./adapters/browser-adapter');
    const browsers = ['chromium', 'firefox', 'webkit'] as const;
    console.log('Launching all browsers in parallel...');
    const adapters = await Promise.all(browsers.map((b) => createBrowserAdapter(b)));
    decompressAdapter = {
      decompress: async (data: any, opts: any) => {
        const results = await Promise.all(adapters.map((a) => a.decompress(data, opts)));
        for (let i = 1; i < results.length; i++) {
          if (!Buffer.from(results[i]).equals(Buffer.from(results[0]))) {
            throw new Error(`Browser ${browsers[i]} result differs from ${browsers[0]}`);
          }
        }
        return results[0];
      },
      decompressStream: async (data: any, isFirst: boolean, opts: any) => {
        const results = await Promise.all(
          adapters.map((a) => a.decompressStream(data, isFirst, opts)),
        );
        for (let i = 1; i < results.length; i++) {
          if (!Buffer.from(results[i].buf).equals(Buffer.from(results[0].buf))) {
            throw new Error(`Browser ${browsers[i]} stream result differs from ${browsers[0]}`);
          }
        }
        return results[0];
      },
      createDecompressionStream: (opts: any) => adapters[0].createDecompressionStream(opts),
      close: () => Promise.all(adapters.map((a) => a.close())),
    };
    console.log('All browsers ready');
  } else if (adapterType?.startsWith('browser-')) {
    const browser = adapterType.replace('browser-', '');
    const { createBrowserAdapter } = await import('./adapters/browser-adapter');
    decompressAdapter = await createBrowserAdapter(browser as any);
    console.log(`Using browser adapter: ${browser}`);
  } else {
    decompressAdapter = wasmAdapter;
  }
}, 1200000);

afterAll(async () => {
  if (fixtureServer) fixtureServer.kill();
  if (decompressAdapter?.close) await decompressAdapter.close();
});

function getCacheKey(data: Buffer, opts: any = {}) {
  const dataHash = hash(data).slice(0, 8);
  return `${dataHash}-${opts.level || 3}`;
}

function compress(data: Buffer, opts = {}): Buffer {
  const key = getCacheKey(data, opts);
  if (!compressedCache.has(key)) {
    compressedCache.set(key, nodeAdapter.compress(data, opts));
    originalDataHashes.set(key, hash(data));
  }
  return compressedCache.get(key)!;
}

const decompress = (data: Buffer | Uint8Array, opts = {}) =>
  decompressAdapter.decompress(data, opts);

async function testRoundtrip(data: Buffer, opts = {}) {
  const key = getCacheKey(data, opts);
  const compressed = compress(data, opts);
  const decompressed = await decompress(compressed, opts);
  const originalHash = originalDataHashes.get(key);

  if (!originalHash) {
    expect(hash(decompressed)).toBe(hash(data));
  } else {
    expect(hash(decompressed)).toBe(originalHash);
  }
}

async function testMultipleLevels(data: Buffer, levels: number[], opts = {}) {
  for (const level of levels) {
    await testRoundtrip(data, { ...opts, level });
  }
}

function loadTestFile(filename: string): Buffer {
  const path = join(TEST_DATA_DIR, filename);
  return readFileSync(path);
}

function randomBuffer(size: number): Buffer {
  if (!randomBuffers.has(size)) {
    const chunks: Buffer[] = [];
    const seed = createHash('sha1').update(`seed-${size}`).digest();
    for (let offset = 0; offset < size; offset += 32) {
      const chunk = createHash('sha1')
        .update(seed)
        .update(Buffer.from([offset >> 24, offset >> 16, offset >> 8, offset]))
        .digest();
      chunks.push(slice(chunk, 0, Math.min(32, size - offset)));
    }
    const buffer = Buffer.concat(chunks);
    randomBuffers.set(size, buffer);
    randomBufferHashes.set(size, hash(buffer));
  }
  return randomBuffers.get(size)!;
}

describe('WASM decompression', () => {
  describe('standard decompression', () => {
    test.each(TEST_FILES)('%s - all levels', async (filename) => {
      const data = loadTestFile(filename);
      await testMultipleLevels(data, COMPRESSION_LEVELS.ALL);
    });

  });

  // Edge case tests
  describe('edge cases', () => {
    test('empty data', async () => {
      await testRoundtrip(Buffer.alloc(0));
      const decompressed = await decompress(compress(Buffer.alloc(0)));
      expect(decompressed.length).toBe(0);
    });

    test('tiny data', async () => {
      await testRoundtrip(Buffer.from([0x42]));
      await testRoundtrip(Buffer.from([0x48, 0x69]));
      await testRoundtrip(Buffer.from('X'));
    });

    test('RLE compression', async () => {
      await testRoundtrip(Buffer.alloc(1024 * 1024, 0xaa));
    });

    test('frame concatenation', async () => {
      const data1 = Buffer.from('Hello ');
      const data2 = Buffer.from('World!');
      const concatenated = Buffer.concat([compress(data1), compress(data2)]);
      const decompressed = await decompress(concatenated);
      const expected = Buffer.concat([data1, data2]);
      expect(hash(decompressed)).toBe(hash(expected));
    });
  });

  // Golden file tests
  describe('golden files', () => {
    test('golden decompression', async () => {
      const files = [
        { file: 'empty-block.zst', expectedSize: 0 },
        { file: 'rle-first-block.zst', expectedSize: 1048576, allZeros: true },
        { file: 'block-128k.zst' },
        { file: 'zeroSeq_2B.zst' },
      ];

      for (const { file, expectedSize, allZeros } of files) {
        const path = join(EDGE_CASES_DIR, 'golden-decompression', file);
        const decompressed = await decompress(readFileSync(path));
        if (allZeros) {
          expect(hash(decompressed)).toBe(
            hash(Buffer.alloc(expectedSize || decompressed.length, 0)),
          );
        }
      }
    });

    test('golden decompression errors', async () => {
      const errorFiles = ['off0.bin.zst', 'truncated_huff_state.zst', 'zeroSeq_extraneous.zst'];

      for (const file of errorFiles) {
        const path = join(EDGE_CASES_DIR, 'golden-decompression-errors', file);
        await expect(decompress(readFileSync(path))).rejects.toThrow();
      }
    });

    test('golden compression roundtrip', async () => {
      const files = [
        'http',
        'huffman-compressed-larger',
        'large-literal-and-match-lengths',
        'PR-3517-block-splitter-corruption-test',
      ];

      for (const file of files) {
        const path = join(EDGE_CASES_DIR, 'golden-compression', file);
        await testRoundtrip(readFileSync(path));
      }
    });
  });

  describe('roundtrip tests', () => {
    test.each(TEST_SIZES)('%i bytes - representative levels', async (size) => {
      for (const level of COMPRESSION_LEVELS.REPRESENTATIVE) {
        const data = randomBuffer(size);
        await testRoundtrip(data, { level });
      }
    });
  });
});

describe('Streaming decompression', () => {
  describe('chunk recombination', () => {
    test('single chunk (no streaming)', async () => {
      const data = Buffer.from('Hello World!');
      const compressed = compress(data);
      const decompressed = await decompress(compressed);
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('2 chunks', async () => {
      const data = randomBuffer(10 * 1024);
      const compressed = compress(data);

      // Split compressed data into 2 chunks
      const mid = Math.floor(compressed.length / 2);
      const chunk1 = slice(compressed, 0, mid);
      const chunk2 = slice(compressed, mid);

      const decompressed = await decompress(Buffer.concat([chunk1, chunk2]));
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('many small chunks', async () => {
      const data = randomBuffer(50 * 1024);
      const compressed = compress(data);

      // Split into 100 tiny chunks
      const chunks: Buffer[] = [];
      for (let i = 0; i < compressed.length; i += 512) {
        chunks.push(slice(compressed, i, Math.min(i + 512, compressed.length)));
      }

      const decompressed = await decompress(Buffer.concat(chunks));
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('uneven chunk sizes', async () => {
      const data = randomBuffer(20 * 1024);
      const compressed = compress(data);

      // Split into deliberately uneven chunks
      const sizes = [100, 1000, 50, 5000, 200, 10000];
      const chunks: Buffer[] = [];
      let offset = 0;

      for (const size of sizes) {
        if (offset >= compressed.length) break;
        chunks.push(slice(compressed, offset, Math.min(offset + size, compressed.length)));
        offset += size;
      }
      if (offset < compressed.length) {
        chunks.push(slice(compressed, offset));
      }

      const decompressed = await decompress(Buffer.concat(chunks));
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('frame boundaries across chunks', async () => {
      // Multiple frames concatenated, split across chunk boundaries
      const data1 = Buffer.from('First frame');
      const data2 = Buffer.from('Second frame');
      const data3 = Buffer.from('Third frame');

      const frame1 = compress(data1);
      const frame2 = compress(data2);
      const frame3 = compress(data3);

      const allFrames = Buffer.concat([frame1, frame2, frame3]);

      // Split in the middle of frame2
      const splitPoint = frame1.length + Math.floor(frame2.length / 2);
      const chunk1 = slice(allFrames, 0, splitPoint);
      const chunk2 = slice(allFrames, splitPoint);

      const decompressed = await decompress(Buffer.concat([chunk1, chunk2]));
      const expected = Buffer.concat([data1, data2, data3]);
      expect(hash(decompressed)).toBe(hash(expected));
    });
  });

  describe('compression levels with chunking', () => {
    test.each(COMPRESSION_LEVELS.STREAMING)('level %i - chunked decompression', async (level) => {
      const data = randomBuffer(30 * 1024);
      const compressed = compress(data, { level });

      // Split into random chunks
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < compressed.length) {
        const chunkSize = Math.min(
          1000 + Math.floor(Math.random() * 5000),
          compressed.length - offset,
        );
        chunks.push(slice(compressed, offset, offset + chunkSize));
        offset += chunkSize;
      }

      const decompressed = await decompress(Buffer.concat(chunks));
      expect(hash(decompressed)).toBe(hash(data));
    });
  });

  describe('large data streaming', () => {
    test('1MB file in chunks', async () => {
      const data = randomBuffer(1024 * 1024);
      const compressed = compress(data);

      const chunkSize = 64 * 1024;
      const chunks: Buffer[] = [];
      for (let i = 0; i < compressed.length; i += chunkSize) {
        chunks.push(slice(compressed, i, Math.min(i + chunkSize, compressed.length)));
      }

      const decompressed = await decompress(Buffer.concat(chunks));
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('highly compressible data streaming', async () => {
      const data = Buffer.alloc(512 * 1024, 0xaa);
      const compressed = compress(data);

      const decompressed = await decompress(compressed);
      expect(hash(decompressed)).toBe(hash(data));
    });
  });

  // decompressStream API tests
  describe('decompressStream API', () => {
    test('stream API with single chunk', async () => {
      if (!decompressAdapter.decompressStream) return;

      const data = Buffer.from('Hello Stream!');
      const compressed = compress(data);

      const result = await decompressAdapter.decompressStream(compressed, true);
      const resultBuf = Buffer.from(result.buf);
      expect(hash(resultBuf)).toBe(hash(data));
    });

    test('stream API with multiple chunks', async () => {
      if (!decompressAdapter.decompressStream) return;

      const data = randomBuffer(10 * 1024);
      const compressed = compress(data);

      const outputs: Buffer[] = [];
      const chunkSize = 2048;

      for (let i = 0; i < compressed.length; i += chunkSize) {
        const chunk = slice(compressed, i, Math.min(i + chunkSize, compressed.length));
        const result = await decompressAdapter.decompressStream(chunk, i === 0);
        if (result.buf.length > 0) outputs.push(Buffer.from(result.buf));
      }

      const decompressed = Buffer.concat(outputs);
      expect(hash(decompressed)).toBe(hash(data));
    });
  });

  // ZstdDecompressionStream class tests (JS wrapper)
  describe('ZstdDecompressionStream', () => {
    async function streamDecompress(compressed: Buffer, opts?: any): Promise<Buffer> {
      const stream = decompressAdapter.createDecompressionStream
        ? decompressAdapter.createDecompressionStream(opts)
        : new ZstdDecompressionStream(opts);

      if (stream._initInBrowser) await stream._initInBrowser();

      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      writer.write(compressed);
      writer.close();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return Buffer.concat(chunks);
    }

    test('single write', async () => {
      const data = randomBuffer(100 * 1024);
      const compressed = compress(data);
      const decompressed = await streamDecompress(compressed);
      expect(hash(decompressed)).toBe(hash(data));
    });

    test('multiple writes', async () => {
      const data = randomBuffer(100 * 1024);
      const compressed = compress(data);

      const stream = decompressAdapter.createDecompressionStream
        ? decompressAdapter.createDecompressionStream()
        : new ZstdDecompressionStream();

      if (stream._initInBrowser) await stream._initInBrowser();

      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      const chunkSize = 8192;
      (async () => {
        for (let i = 0; i < compressed.length; i += chunkSize) {
          await writer.write(slice(compressed, i, Math.min(i + chunkSize, compressed.length)));
        }
        await writer.close();
      })();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const decompressed = Buffer.concat(chunks);
      expect(hash(decompressed)).toBe(hash(data));
    });
  });

  describe('extreme streaming tests', () => {
    test('256MB random noise at level 19', async () => {
      const data = randomBuffer(16 * 1024 * 1024);
      const compressed = compress(data, { level: 9 });

      const decompressed = await decompress(compressed);
      expect(hash(decompressed)).toBe(hash(data));
    }, 300000); // 5 minute timeout

    test('256MB random noise - streamed in 0.1% increments', async () => {
      if (!decompressAdapter.decompressStream) {
        console.log('Skipping chunked streaming test: decompressStream not available');
        return;
      }

      const data = randomBuffer(256 * 1024 * 1024);
      const compressed = compress(data, { level: 9 });

      // 0.1% of the compressed data per chunk
      const chunkSize = Math.max(1, Math.floor(compressed.length * 0.01));
      const outputs: Buffer[] = [];
      console.log(`Streaming ${compressed.length} bytes in ${chunkSize}-byte chunks`);

      for (let i = 0; i < compressed.length; i += chunkSize) {
        const chunk = slice(compressed, i, i + chunkSize);
        const result = await decompressAdapter.decompressStream(chunk, i === 0);
        if (result.buf.length > 0) outputs.push(Buffer.from(result.buf));
      }

      const decompressed = Buffer.concat(outputs);
      expect(hash(decompressed)).toBe(hash(data));
    }, 300000); // 5 minute timeout
    test('256MB random noise - corrupted (skipped bytes)', async () => {
      const data = randomBuffer(16 * 1024 * 1024);
      const compressed = compress(data, { level: 9 });

      // Skip random bytes to corrupt the stream
      const corrupted = Buffer.alloc(compressed.length - 10);
      compressed.copy(corrupted, 0, 0, 1000); // Copy first 1000 bytes
      compressed.copy(corrupted, 1000, 1010); // Skip 10 bytes, then copy rest

      // This should throw an error due to corruption
      await expect(decompress(corrupted)).rejects.toThrow();
    }, 300000); // 5 minute timeout
  });
});
