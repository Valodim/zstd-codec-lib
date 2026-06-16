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
