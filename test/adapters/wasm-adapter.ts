import { Buffer } from 'node:buffer';

import type { ZstdOptions } from '../../src/types.js';
import type { ZstdDecoder } from '../../src/zstd-wasm-decoder.js';

// Dynamically select which build variant to test based on TEST_VARIANT env var
const TEST_VARIANT = process.env.TEST_VARIANT || 'node';
const variantMap: Record<string, string> = {
  node: 'index.node',
  'web-inlined': 'index.inlined',
  'web-inlined-perf': 'index.inlined.perf',
};

const buildFile = variantMap[TEST_VARIANT] || 'index.node';
const { createDecoder, decompressSync, ZstdDecompressionStream } = await import(
  `../../dist/esm/${buildFile}.js`
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

export async function initWasmAdapter(): Promise<void> {
  await createDecoder();
}
