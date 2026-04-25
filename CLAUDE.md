# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`zstd-wasm-decoder` — a tiny, decoder-only Zstandard implementation compiled from the upstream `facebook/zstd` C source (in `vendor/zstd`) to WebAssembly, plus a thin TypeScript wrapper. pnpm workspace; the only package today is `packages/zstd-wasm-decoder`.

Requires Node ≥ 22 and pnpm ≥ 10. Building WASM additionally needs LLVM/clang (with the wasm linker), `binaryen` (`wasm-opt`), and `zopfli`. `shell.nix` provides these. If `LLVM_DIR` is unset the Makefile auto-detects it.

## Common commands

```bash
# Full build = WASM (size + perf variants) + TS bundles/types
pnpm run build:all

# Just the WASM stage (clang + wasm-opt) or just the TS stage
pnpm run build:wasm
pnpm run build:ts

pnpm run clean:decoder        # rm build/, src/_esm, src/_types, src/*.wasm

# Tests: default runs Node + browsers (Playwright) + Bun
pnpm test
pnpm run test:node
pnpm run test:browsers        # TEST_ADAPTER=browser-all under the hood
pnpm run test:bun

# Single test file / pattern (vitest config lives in test/)
pnpm exec vitest run --config test/vitest.config.ts test/suite.test.ts -t "<name pattern>"

# Lint / format (Biome)
pnpm run check                # lint + format check
pnpm run check:fix            # auto-fix
pnpm run lint / lint:fix / format / format:check

# Benchmarks
pnpm run bench:full           # setup + run; bench:setup generates fixtures
```

`packages/zstd-wasm-decoder/Makefile` is the source of truth for WASM flags (`size` / `perf` targets, `regenerate-amalgamated`, `check-tools`). `make` from inside that package == `pnpm run build:wasm`.

## Architecture

The library is two layers stacked tightly together; understanding both at once is necessary to make non-trivial changes.

**WASM layer (`packages/zstd-wasm-decoder/bin/`).** `create_amalgamated_wasm.sh` concatenates a curated subset of `vendor/zstd` decoder sources plus `zstd_wasm_full.c` into `zstd_wasm_amalgamated.c`, which clang compiles to wasm32. Only six symbols are exported (see `EXPORTS` in the Makefile): `malloc`, `_initialize`, `pb`, `cd`, `ds`, `re`, `dS` — short names so the import table stays small. `_initialize` is the reactor entry point and creates the singleton `ZSTD_DCtx`. Two variants are built: `zstd.wasm` (`-Oz`, size) and `zstd-perf.wasm` (`-Os`, perf, ~30% faster, ~4kb larger). Both go through `wasm-opt` with an aggressive flag set tuned in the Makefile.

**Memory model (critical).** The WASM module uses a **fixed, non-growable** linear memory (`--no-growable-memory`, ~16MB initial) laid out as a hand-managed ring buffer. The full layout is documented in the comment header of `src/zstd-wasm.ts` and is sized for level-19 decompression (8 MB window + 3·128 KB blocks + safety margin). JS owns the pointers (`_srcPtr`, `_dstPtr`) and resets them per decompression instead of calling free — there is no real allocator beyond the bump-style `malloc` used during init for the dict and src buffer. Streaming structs live at fixed offsets `0x2000` / `0x2010`. **Do not** assume conventional WASM memory growth or that `malloc`/`free` work at runtime.

**TS layer (`packages/zstd-wasm-decoder/src/`).** `zstd-wasm.ts` wraps the WASM module with `ZstdDecoder` (sync `decompressSync` for buffers ≤ ~9.4 MB after expected-size hint check, falls back to `decompressStream` otherwise). `index.node.ts`, `index.web.ts`, `index.web.inlined.ts`, `index.cloudflare.ts` are environment-specific entrypoints — they differ only in how they obtain the `WebAssembly.Module` (filesystem, fetch, base64-inlined, etc.). `shared.ts` holds env-agnostic glue (e.g. `ZstdDecompressionStream`, `setupZstdDecoder`, dict-from-frame-header detection). `types.d.ts` and `_types/` (generated) are the public type surface.

**Build pipeline (`build.ts`).** `bun build.ts` (after the WASM step) produces the published artifacts: it esbuilds each entrypoint, runs terser with property-mangling restricted to `_`-prefixed names (reserving `_initialize`), and emits both inlined-WASM and external-`.wasm` variants. The `--prep` flag is for partial regeneration. The `default` import is the size-optimized inlined build; `/perf`, `/external`, `/cloudflare` etc. are documented in the README.

**Tests (`test/`).** `suite.test.ts` is the single shared suite, parameterized via env vars. `TEST_ADAPTER` (`node` default, `browser-all`, `wasm`) and `TEST_VARIANT` (`web-inlined`, `web-inlined-perf`, …) pick which built artifact to exercise — that's why `test:release` re-runs with multiple variants. Adapters live in `test/adapters/`; browser tests boot a fixture server (`fixture-server.ts`) and load `test/bundles/test-harness.html` via Playwright. Coverage threshold and timeouts are in `test/vitest.config.ts` (long timeout because some streaming cases are large).

**Generated outputs** under `src/_esm/`, `src/_types/`, and `src/*.wasm` are committed-derived artifacts of the build; don't edit them by hand. After changing C sources or `bin/include/`, you must `regenerate-amalgamated` (the Makefile does this automatically on `size`/`perf` targets).
