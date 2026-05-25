import { Buffer } from 'node:buffer';

import type { ZstdOptions } from '../../packages/zstd-wasm-codec/src/types.js';
import type { ZstdDecoder } from '../../packages/zstd-wasm-codec/src/zstd-wasm-decoder.js';
import { slice } from '../lib/utils.js';

// Dynamically select which build variant to test based on TEST_VARIANT env var
const TEST_VARIANT = process.env.TEST_VARIANT || 'node';
const variantMap: Record<string, string> = {
  node: 'index.node.js',
  'web-inlined': 'index.inlined.js',
  'web-inlined-perf': 'index.inlined.perf.js',
};

const buildFile = variantMap[TEST_VARIANT] || 'index.node.js';
const { createDecoder, decompressSync, ZstdDecompressionStream } = await import(
  `../../packages/zstd-wasm-codec/src/_esm/${buildFile}`
);

export { ZstdDecompressionStream };

export interface WasmDecoderAdapter {
  decompress(data: Buffer | Uint8Array, options?: ZstdOptions): Promise<Buffer>;
  decompressStream(
    data: Buffer | Uint8Array,
    isFirst: boolean,
    options?: ZstdOptions,
  ): Promise<{ buf: Uint8Array }>;
}

let streamDecoder: ZstdDecoder | null = null;

export const wasmAdapter: WasmDecoderAdapter = {
  async decompress(data: Buffer | Uint8Array, options = {}): Promise<Buffer> {
    const result = decompressSync(data, undefined, options);
    return Buffer.from(result);
  },

  async decompressStream(
    data: Buffer | Uint8Array,
    isFirst: boolean,
    options = {},
  ): Promise<{ buf: Uint8Array }> {
    if (isFirst) {
      streamDecoder = await createDecoder(options);
    }
    if (!streamDecoder) {
      throw new Error('Stream decoder not initialized');
    }
    return streamDecoder.decompressStream(data, isFirst);
  },
};

export const wasmDecoder = {
  async init(dictionary: Buffer | Uint8Array | null = null): Promise<ZstdDecoder> {
    return await createDecoder({ dictionary: dictionary || undefined });
  },

  decompressStream(
    decoder: ZstdDecoder,
    compressed: Buffer,
    numChunks: number,
    isFirst = true,
  ): Buffer {
    const outputChunks: Buffer[] = [];
    const chunkSize = Math.ceil(compressed.length / numChunks);

    for (let i = 0; i < numChunks; i++) {
      const offset = i * chunkSize;
      if (offset >= compressed.length) break;
      const result = decoder.decompressStream(
        slice(compressed, offset, Math.min(offset + chunkSize, compressed.length)),
        i === 0 && isFirst,
      );
      if (result?.buf?.length > 0) outputChunks.push(Buffer.from(result.buf));
    }

    return Buffer.concat(outputChunks);
  },
};

export async function initWasmAdapter(): Promise<void> {
  await createDecoder();
}
