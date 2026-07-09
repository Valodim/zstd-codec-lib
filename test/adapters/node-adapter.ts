/**
 * Reference Implementation Adapter using node:zlib
 */

import { Buffer } from 'node:buffer';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

type DecompressionOptions = Record<string, never>;

type CompressionOptions = {
  level?: number;
};

export interface ZstdAdapter {
  compress(data: Buffer | Uint8Array, options?: CompressionOptions): Buffer;
  decompress(data: Buffer | Uint8Array, options?: DecompressionOptions): Buffer;
}

export const nodeAdapter: ZstdAdapter = {
  compress(data: Buffer | Uint8Array, options: CompressionOptions = {}): Buffer {
    const level = options.level ?? 3;
    const opts: any = {
      params: { [constants.ZSTD_c_compressionLevel]: level },
    };
    return Buffer.from(zstdCompressSync(data, opts));
  },

  decompress(data: Buffer | Uint8Array): Buffer {
    return Buffer.from(zstdDecompressSync(data));
  },
};
