import ZstdDecoder from './zstd-wasm-decoder.js';
export { default as ZstdDecoder, _MAX_SRC_BUF } from './zstd-wasm-decoder.js';

import type { StreamResult, ZstdOptions } from './types.js';
import { rzfh, type DZS, err, _concatUint8Arrays } from './utils.js';

export const _internal = {
  _loader: null as ((wasmPath?: string) => WebAssembly.Module | Promise<WebAssembly.Module>) | null,
  buffer: {
    maxSrcSize: 0,
    maxDstSize: 0,
  },
};

// Decoder pool: up to _MAX_POOL instances, lock state tracks in-flight use.
const _MAX_POOL = 3;
const decoderPool: ZstdDecoder[] = [];
const poolLocks: boolean[] = [];

let isInitialized = false;
let cachedModule: WebAssembly.Module;

function _createDecoderInstance(): ZstdDecoder {
  const decoder = new ZstdDecoder({ ..._internal.buffer });
  decoder.init(cachedModule);
  return decoder;
}

export const setupZstdDecoder = async (options: {
  maxSrcSize?: number;
  maxDstSize?: number;
}) => {
  if (options.maxSrcSize) _internal.buffer.maxSrcSize = options.maxSrcSize;
  if (options.maxDstSize) _internal.buffer.maxDstSize = options.maxDstSize;
};

/**
 * Returns [decoder, idx]. idx === -1 means the decoder is transient (pool
 * was full) and the caller must call _destroy() when done.
 */
async function _acquireDecoder(): Promise<[ZstdDecoder, number]> {
  if (!cachedModule) {
    const module = _internal._loader!();
    cachedModule = module instanceof Promise ? await module : module;
  }

  for (let i = 0; i < poolLocks.length; ++i) {
    if (!poolLocks[i]) {
      poolLocks[i] = true;
      return [decoderPool[i], i];
    }
  }

  const decoder = _createDecoderInstance();

  if (poolLocks.length >= _MAX_POOL) return [decoder, -1];

  const newIdx = poolLocks.length;
  decoderPool.push(decoder);
  poolLocks.push(true);
  return [decoder, newIdx];
}

function _releaseDecoder(idx: number): void {
  if (idx >= 0) poolLocks[idx] = false;
}

export const createDecoder = async (
  options: ZstdOptions = {},
): Promise<ZstdDecoder> => {
  if (!isInitialized) {
    cachedModule = await _internal._loader!(options.wasmPath);
    isInitialized = true;
  }
  return _createDecoderInstance();
};

const _toUint8Array = (chunk: BufferSource): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk as ArrayBuffer);
};

export class ZstdDecompressionStream {
  /**
   * The resulting decompressed stream to read output from.
   * @type {ReadableStream<Uint8Array>}
   */
  readonly readable: ReadableStream;
  /**
   * The writable end of the stream to pipe compressed chunks into.
   * @type {WritableStream<BufferSource>}
   */
  readonly writable: WritableStream;

  /**
   * @param {ZstdOptions} [options] - Optional decoder configuration.
   */
  constructor(options?: ZstdOptions) {
    let decoder: ZstdDecoder;
    let idx: number = -1;
    // A temporary buffer to hold data until the header can be read.
    const initialBuffer: Uint8Array[] = [];
    let headerInfo: DZS = { d: 0, u: 0, e: -1 };
    let bytesRead: number = 0;
    let minRecvSize: number = 262144;

    const { readable, writable } = new TransformStream<BufferSource, Uint8Array>({
      async transform(
        chunk: BufferSource,
        controller: TransformStreamDefaultController<Uint8Array>,
      ) {
        const data = _toUint8Array(chunk);
        bytesRead += data.length;
        // Retain compressed chunks only until the decoder is live; once it
        // exists each chunk is fed incrementally and must not accumulate,
        // otherwise initialBuffer grows with the entire input.
        if (!decoder) initialBuffer.push(data);
        // Wait until we have at least enough bytes for a full frame header.
        if (bytesRead < 12) {
          return;
        } else if (headerInfo.e == -1) {
          // Gather all data so far for actual header probing.
          const headerBuffer = _concatUint8Arrays(initialBuffer, bytesRead);
          try {
            headerInfo = rzfh(headerBuffer) as DZS;
          } catch (er) {
            controller.error(new err(`dec err ${er}`));
            return;
          }
          // Adapt minimum receive size depending on header, but cap it so a
          // frame declaring a huge (decompressed) content size can't force
          // buffering the whole compressed input before streaming begins.
          minRecvSize = Math.min(
            1 << 20,
            Math.max(minRecvSize, headerInfo.e, headerInfo.u >> 4, 1 << 17),
          );
        }
        if (bytesRead < minRecvSize || headerInfo.e == -1) return;

        // After header probing, start streaming/decoding. Once the decoder
        // exists, each subsequent chunk is fed incrementally.
        if (decoder) {
          const result = decoder.decompressStream(data, false).buf;
          if (result.length > 0) {
            controller.enqueue(result);
          }
          return;
        }

        try {
          // First decode after the buffering threshold: feed EVERYTHING
          // buffered so far (header + all earlier chunks), not just the chunk
          // that crossed the threshold. The earlier chunks were held in
          // initialBuffer and were never handed to the decoder — feeding only
          // the latest one drops the prefix and corrupts the stream.
          const buffered = _concatUint8Arrays(initialBuffer, bytesRead);
          [decoder, idx] = await _acquireDecoder();

          const result = decoder.decompressStream(buffered, true).buf;
          if (result.length > 0) {
            controller.enqueue(result);
          }
        } catch (er) {
          controller.error(new err(`dec err ${er}`));
        }
      },

      async flush(controller: TransformStreamDefaultController<Uint8Array>) {
        // Only one-shot here when the decoder was never acquired (input
        // stayed below minRecvSize). If a decoder exists it already consumed
        // every chunk incrementally, and initialBuffer no longer holds them.
        if (!decoder && bytesRead > 6) {
          try {
            const res = await decompressStream(
              _concatUint8Arrays(initialBuffer, bytesRead),
              true,
              options,
            );
            controller.enqueue(res.buf);
          } catch (er) {
            controller.error(new err(`dec err ${er}`));
          }
        }
        if (idx == -1) {
          decoder?._destroy();
        } else {
          _releaseDecoder(idx);
        }
        controller.terminate();
      },
    });

    this.readable = readable;
    this.writable = writable;
  }
}

export const decompress = async (
  input: Uint8Array,
  options?: ZstdOptions,
): Promise<Uint8Array> => {
  return (await decompressStream(input, true, options)).buf;
};

export const decompressStream = async (
  input: Uint8Array,
  reset = false,
  _options?: ZstdOptions,
): Promise<StreamResult> => {
  const [decoder, idx] = await _acquireDecoder();
  const result = decoder.decompressStream(input, reset);
  idx == -1 ? decoder._destroy() : _releaseDecoder(idx);
  return result;
};

export const decompressSync = (
  input: Uint8Array,
  expectedSize?: number,
  _options?: ZstdOptions,
): Uint8Array => {
  // Never reuse a pool slot that a ZstdDecompressionStream may hold locked
  // across awaits — decompressSync resets the shared ZSTD_DCtx and heap
  // cursor, which would corrupt that in-flight stream. Take a free slot if
  // one exists, otherwise run on a transient instance.
  let idx = -1;
  for (let i = 0; i < poolLocks.length; ++i) {
    if (!poolLocks[i]) {
      poolLocks[i] = true;
      idx = i;
      break;
    }
  }
  const decoder = idx >= 0 ? decoderPool[idx] : _createDecoderInstance();
  try {
    return decoder.decompressSync(input, expectedSize);
  } finally {
    if (idx >= 0) _releaseDecoder(idx);
    else decoder._destroy();
  }
};
