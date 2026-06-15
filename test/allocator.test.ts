/**
 * Allocator suite — pins down the exact contract of the hand-written bump
 * allocator in `bin/zstd_wasm_full.c` (`malloc` / `free` / `setHeapEnd`,
 * over a fixed, non-growable linear memory).
 *
 * Node-only and independent of the TS wrapper: it instantiates the raw wasm
 * directly and drives the allocator's exports, so it documents the allocator
 * itself rather than any decoder/encoder path that happens to use it.
 *
 * The allocator only ever touches the `__heap_cursor` wasm global and
 * `memory.size`; it does not depend on `_initialize`. So these tests skip
 * `_initialize` (which would consume heap committing the CCtx workspace) and
 * instead set a known base with `setHeapEnd` before each assertion — exercising
 * the arithmetic in isolation.
 *
 * Probing the cursor: `get_heap_cursor` is not exported, but `malloc(0)` reads
 * the cursor without advancing it (free >= 0 is never < 0, so it takes the
 * "fits" branch and bumps by zero), which serves as a non-destructive probe.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AllocExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  setHeapEnd(cursor: number): void;
}

const VARIANTS = ['zstd.wasm', 'zstd-perf.wasm'] as const;

describe.each(VARIANTS)('bump allocator (%s)', (wasmFile) => {
  let e: AllocExports;
  let MEM: number;
  /** Non-destructive read of the current heap cursor. */
  const cursor = () => e.malloc(0);

  beforeEach(() => {
    const mod = new WebAssembly.Module(readFileSync(join(__dirname, '../dist/esm/', wasmFile)));
    e = new WebAssembly.Instance(mod, { env: {} }).exports as unknown as AllocExports;
    MEM = e.memory.buffer.byteLength;
    // Known, low base well clear of the wasm static data region.
    e.setHeapEnd(1 << 20);
  });

  test('linear memory is the fixed 12 MB the linker configured (192 pages)', () => {
    expect(MEM).toBe(12 * 1024 * 1024);
    expect(MEM % 65536).toBe(0);
  });

  describe('bump semantics', () => {
    test('malloc returns the cursor and advances it by exactly the request', () => {
      const base = cursor();
      const p = e.malloc(64);
      expect(p).toBe(base);
      expect(cursor()).toBe(base + 64);
    });

    test('consecutive allocations are contiguous and non-overlapping', () => {
      const a = e.malloc(10);
      const b = e.malloc(20);
      const c = e.malloc(30);
      expect(b).toBe(a + 10);
      expect(c).toBe(b + 20);
      expect(cursor()).toBe(c + 30);
    });

    test('no alignment padding — odd sizes bump byte-for-byte', () => {
      // The decoder/encoder layout relies on allocations being packed with no
      // implicit rounding; pin that down with deliberately unaligned sizes.
      const a = e.malloc(1);
      const b = e.malloc(3);
      const c = e.malloc(1);
      expect(b).toBe(a + 1);
      expect(c).toBe(b + 3);
    });
  });

  describe('malloc(0)', () => {
    test('returns the current cursor without advancing it', () => {
      const base = cursor();
      expect(e.malloc(0)).toBe(base);
      expect(e.malloc(0)).toBe(base);
      expect(cursor()).toBe(base);
    });
  });

  describe('exhaustion is a catchable NULL, not a trap', () => {
    test('an exact-fit request (size == free) succeeds and fills memory', () => {
      const base = cursor();
      const free = MEM - base;
      const p = e.malloc(free);
      expect(p).toBe(base);
      expect(cursor()).toBe(MEM); // cursor now sits at the very end
    });

    test('a one-byte-over request (size == free + 1) returns NULL', () => {
      const base = cursor();
      const free = MEM - base;
      expect(e.malloc(free + 1)).toBe(0);
    });

    test('a failed allocation leaves the cursor untouched', () => {
      const base = cursor();
      const free = MEM - base;
      expect(e.malloc(free + 1)).toBe(0);
      expect(cursor()).toBe(base);
      // ...and the largest fitting request still succeeds at the same base.
      expect(e.malloc(free)).toBe(base);
    });

    test('allocating against a full heap returns NULL without trapping', () => {
      e.setHeapEnd(MEM); // free == 0
      expect(e.malloc(1)).toBe(0);
      expect(cursor()).toBe(MEM); // malloc(0) probe still works at the boundary
    });

    test('an absurd (near-4 GB) size is rejected as NULL', () => {
      // size is compared unsigned, so a request larger than all of memory
      // fails the bounds check rather than wrapping around.
      expect(e.malloc(0xffffffff)).toBe(0);
      expect(e.malloc(MEM)).toBe(0); // larger than the free tail at this base
    });
  });

  describe('setHeapEnd', () => {
    test('moves the cursor to the given address', () => {
      e.setHeapEnd(4096);
      expect(cursor()).toBe(4096);
      e.setHeapEnd(8192);
      expect(cursor()).toBe(8192);
    });

    test('rewinding reclaims space (the free-less reset the codec relies on)', () => {
      const base = cursor();
      const first = e.malloc(4096);
      expect(cursor()).toBe(base + 4096);
      e.setHeapEnd(base);
      const second = e.malloc(4096);
      expect(second).toBe(first); // same region handed out again
    });
  });

  describe('free', () => {
    test('is a no-op — it is not even exported', () => {
      // The allocator never reclaims per-allocation; reclamation only happens
      // wholesale via setHeapEnd. Document that there is no free() to call.
      expect((e as unknown as Record<string, unknown>).free).toBeUndefined();
    });
  });
});
