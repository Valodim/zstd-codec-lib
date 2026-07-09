import { Buffer } from 'node:buffer';

import type { ZstdOptions } from '../../src/types.js';

// Dynamically select which build variant to test based on TEST_VARIANT env var
const TEST_VARIANT = process.env.TEST_VARIANT || 'node';
const variantMap: Record<string, string> = {
  node: 'index.node',
  'web-inlined': 'index.inlined',
  'web-inlined-perf': 'index.inlined.perf',
};

const buildFile = variantMap[TEST_VARIANT] || 'index.node';
const { createCodec, decompressSync } = await import(`../../dist/esm/${buildFile}.js`);

export interface WasmDecoderAdapter {
  decompress(data: Buffer | Uint8Array, options?: ZstdOptions): Promise<Buffer>;
}

export const wasmAdapter: WasmDecoderAdapter = {
  async decompress(data: Buffer | Uint8Array, options = {}): Promise<Buffer> {
    const result = decompressSync(data, undefined, options);
    return Buffer.from(result);
  },
};

export async function initWasmAdapter(): Promise<void> {
  await createCodec();
}
