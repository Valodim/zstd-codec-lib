/**
 * Allocator bounds-guard tests (audit finding 1).
 *
 * The wasm uses a hand-managed bump allocator over a fixed, non-growable
 * linear memory. `malloc` must refuse any request that would run past the
 * end of memory by returning NULL (0) — that is the signal upstream zstd's
 * `RETURN_ERROR_IF(x == NULL, memory_allocation)` guards rely on. Without it,
 * an over-budget request hands back a pointer past the end of memory and the
 * first write traps the whole instance.
 *
 * With a correct JS-side memory layout this exhaustion is never reached in
 * practice, so these tests drive the heap cursor to the boundary directly via
 * the `setHeapEnd` export to exercise the guard.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

interface CodecExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  setHeapEnd(cursor: number): void;
}

function instantiate(variant: string): CodecExports {
  const bytes = readFileSync(join(here, '../dist/esm', variant));
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: {} });
  const ex = inst.exports as unknown as CodecExports;
  ex._initialize();
  return ex;
}

describe('malloc bounds guard (finding 1)', () => {
  for (const variant of ['zstd.wasm', 'zstd-perf.wasm']) {
    test(`${variant}: refuses over-budget allocations with NULL instead of trapping`, () => {
      const ex = instantiate(variant);
      const memBytes = ex.memory.buffer.byteLength;

      // A modest allocation from the post-init heap succeeds and stays
      // in-bounds.
      const p = ex.malloc(1024);
      expect(p).toBeGreaterThan(0);
      expect(p + 1024).toBeLessThanOrEqual(memBytes);

      // Park the cursor 64 bytes from the end of linear memory.
      ex.setHeapEnd(memBytes - 64);

      // An allocation that exactly fills the remaining tail is granted and
      // returns the old cursor.
      expect(ex.malloc(64)).toBe(memBytes - 64);

      // The heap is now exactly full: any further byte returns NULL.
      expect(ex.malloc(1)).toBe(0);

      // A request larger than the free tail returns NULL rather than a pointer
      // past the end of memory.
      ex.setHeapEnd(memBytes - 64);
      expect(ex.malloc(65)).toBe(0);

      // Pathological sizes are rejected without integer-overflow wraparound
      // (size_t arithmetic on `memBytes - cursor` must not underflow).
      ex.setHeapEnd(1024);
      expect(ex.malloc(0xffffffff)).toBe(0);
      expect(ex.malloc(memBytes)).toBe(0);

      // Rejected calls must not have advanced the cursor: a request that does
      // fit still succeeds, returning the cursor we last set.
      ex.setHeapEnd(1024);
      expect(ex.malloc(2048)).toBe(1024);
    });
  }
});
