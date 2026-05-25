# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`zstd-wasm-codec` — a tiny Zstandard codec (decoder + level 1-3 compressor) compiled from the upstream `facebook/zstd` C source (in `vendor/zstd`) to WebAssembly, plus a thin TypeScript wrapper. pnpm workspace; the only package today is `packages/zstd-wasm-codec`.

Requires Node ≥ 22 and pnpm ≥ 10. Building WASM additionally needs LLVM/clang (with the wasm linker), `binaryen` (`wasm-opt`), and `zopfli`. `shell.nix` provides these. If `LLVM_DIR` is unset the Makefile auto-detects it.

## Common commands

```bash
# Full build = WASM (size + perf + lvl1 variants) + TS bundles/types
pnpm run build

# Just the WASM stage (clang + wasm-opt) or just the TS stage
pnpm run build:wasm
pnpm run build:ts

pnpm run clean                # rm build/, src/_esm, src/_types

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

`packages/zstd-wasm-codec/Makefile` is the source of truth for WASM flags (`size` / `perf` / `lvl1` / `lvl1-perf` targets, `regenerate-amalgamated`, `check-tools`). `make` from inside that package == `pnpm run build:wasm`.

## Architecture

The library is two layers stacked tightly together; understanding both at once is necessary to make non-trivial changes.

**WASM layer (`packages/zstd-wasm-codec/bin/`).** `create_amalgamated_wasm.sh` concatenates a curated subset of `vendor/zstd` sources plus `zstd_wasm_full.c` into `zstd_wasm_amalgamated.c`, which clang compiles to wasm32. Exports (see `EXPORTS` in the Makefile): `malloc`, `_initialize`, `pb`, `cd`, `ds`, `re`, `dS` (decoder) + `ic`, `cD`, `cs`, `cS`, `getInBufferPtr` (codec) — short names so the import table stays small. `_initialize` is the reactor entry point and creates the singleton `ZSTD_DCtx`. Four variants are built: `zstd.wasm` (-Oz size) / `zstd-perf.wasm` (-Os perf, ~30% faster, ~4kb larger), plus `zstd-lvl1.wasm` / `zstd-lvl1-perf.wasm` (level-1-only compressor, smaller binary, 12 MB linear memory, decoder window capped at 2 MB). All variants go through `wasm-opt` with an aggressive flag set tuned in the Makefile.

**Memory model (critical).** The WASM module uses a **fixed, non-growable** linear memory (`--no-growable-memory`, ~32 MB for the full codec / ~12 MB for lvl1) laid out as a hand-managed ring buffer. The decoder-side layout is documented in the comment header of `src/zstd-wasm-decoder.ts`. JS owns the pointers (`_srcPtr`, `_dstPtr`) and resets them per decompression instead of calling free — there is no real allocator beyond the bump-style `malloc` used during init for the dict and src buffer. The codec build queries stream-struct offsets via the exported `getInBufferPtr()` at init (its larger stack pushes them past the decoder's old fixed offsets). **Do not** assume conventional WASM memory growth or that `malloc`/`free` work at runtime.

**TS layer (`packages/zstd-wasm-codec/src/`).** `zstd-wasm-decoder.ts` wraps the WASM module with `ZstdDecoder` (sync `decompressSync` for buffers ≤ ~9.4 MB after expected-size hint check, falls back to `decompressStream` otherwise). `zstd-wasm-encoder.ts` wraps the compress side (`ZstdEncoder`, levels 1-3). `index.node.ts`, `index.web.ts`, `index.web.inlined.ts` are environment-specific entrypoints — they differ only in how they obtain the `WebAssembly.Module` (filesystem, fetch, base64-inlined, etc.). The `.lvl1` variants point at the smaller wasm. `shared.ts` holds env-agnostic decoder glue (`ZstdDecompressionStream`, `setupZstdDecoder`, dict-from-frame-header detection); `encoder-shared.ts` holds the analogous encoder glue. `types.d.ts` and `_types/` (generated) are the public type surface.

**Build pipeline (`build.ts`).** `bun build.ts` (after the WASM step) produces the published artifacts: it esbuilds each entrypoint, runs terser with property-mangling restricted to `_`-prefixed names (reserving `_initialize`), and emits both inlined-WASM and external-`.wasm` variants. The `--prep` flag is for partial regeneration. The `default` import is the size-optimized inlined build; `/perf`, `/external`, `/lvl1`, etc. are documented in the README.

**Tests (`test/`).** `suite.test.ts` is the shared decoder suite, parameterized via env vars. `codec.test.ts` covers the encoder side and cross-decodes through the host `zstd` CLI. `TEST_ADAPTER` (`node` default, `browser-all`, `wasm`) and `TEST_VARIANT` (`web-inlined`, `web-inlined-perf`, …) pick which built artifact to exercise — that's why `test:release` re-runs with multiple variants. Adapters live in `test/adapters/`; browser tests boot a fixture server (`fixture-server.ts`) and load `test/bundles/test-harness.html` via Playwright. Coverage threshold and timeouts are in `test/vitest.config.ts` (long timeout because some streaming cases are large).

**Generated outputs** under `src/_esm/`, `src/_types/`, and `src/*.wasm` are committed-derived artifacts of the build; don't edit them by hand. After changing C sources or `bin/include/`, you must `regenerate-amalgamated` (the Makefile does this automatically on the build targets).
