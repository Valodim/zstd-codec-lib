# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`zstd-wasm-codec` — a tiny Zstandard codec (decoder + level-1 compressor) compiled from the upstream `facebook/zstd` C source (in `vendor/zstd`) to WebAssembly, plus a thin TypeScript wrapper. Single-package repo (was previously a pnpm workspace; flattened so the package lives at the repo root).

Requires Node ≥ 22 and Yarn (berry, ≥ 4). Building WASM additionally needs LLVM/clang (with the wasm linker), `binaryen` (`wasm-opt`), and `zopfli`. `shell.nix` provides these. If `LLVM_DIR` is unset the Makefile auto-detects it.

## Common commands

```bash
# Full build = WASM (size + perf) + TS bundles/types
yarn build

# Just the WASM stage (clang + wasm-opt) or just the TS stage
yarn build:wasm
yarn build:ts

yarn clean                    # rm build/, dist/

# Tests: default runs Node + browsers (Playwright) + Bun
yarn test
yarn test:node
yarn test:browsers            # TEST_ADAPTER=browser-all under the hood
yarn test:bun

# Single test file / pattern (vitest config lives in test/)
yarn vitest run --config test/vitest.config.ts test/suite.test.ts -t "<name pattern>"

# Lint + format (oxlint + oxfmt; no biome)
yarn lint                     # oxlint (--fix via yarn lint:fix)
yarn format                   # oxfmt --write (format:check to verify only)
yarn check                    # lint + format:check together

# Benchmarks
yarn bench:full               # setup + run; bench:setup generates fixtures
```

`Makefile` is the source of truth for WASM flags (`size` / `perf` targets, `regenerate-amalgamated`, `check-tools`). `make` == `yarn build:wasm`.

Linting/formatting is `oxlint` (`.oxlintrc.json`) + `oxfmt` (`.oxfmtrc.json`), migrated from biome. oxfmt is scoped to JS/TS only (Markdown/HTML/YAML/JSON are ignored); `src/utils.ts`, `src/zstd-wasm-decoder.ts`, and `src/shared.ts` are excluded from both tools to preserve their hand-tuned layout, and the stale `packages/` leftover is ignored.

## Architecture

The library is two layers stacked tightly together; understanding both at once is necessary to make non-trivial changes.

**WASM layer (`bin/`).** `create_amalgamated_wasm.sh` concatenates a curated subset of `vendor/zstd` sources plus `zstd_wasm_full.c` into `zstd_wasm_amalgamated.c`, which clang compiles to wasm32. Exports (see `EXPORTS` in the Makefile): `malloc`, `setHeapEnd`, `_initialize`, `decompressStreamStep`, `resetDecoder`, `decompress` (decoder) + `initCompressor`, `compress`, `compressStreamStep`, `getInBufferPtr` (codec). `_initialize` is the reactor entry point and creates the singleton `ZSTD_DCtx`. Dictionaries are not supported in either direction; dict-referencing frames fail with `dictionary_wrong`. Two variants are built: `zstd.wasm` (-Oz size) / `zstd-perf.wasm` (-Os perf, ~30% faster, ~4kb larger). Both are level-1-only (dfast strategy excluded), 12 MB linear memory, decoder window capped at 4 MB + 1 (`ZSTD_WASM_MAX_WINDOW_SIZE`, i.e. level 9 — windowLog 22). All variants go through `wasm-opt` with an aggressive flag set tuned in the Makefile.

**Memory model (critical).** The WASM module uses a **fixed, non-growable** linear memory (`--no-growable-memory`, ~12 MB) laid out as a hand-managed ring buffer. The decoder-side layout is documented in the comment header of `src/zstd-wasm-decoder.ts`. JS owns the pointers (`_srcPtr`, `_dstPtr`) and resets them per decompression instead of calling free — there is no real allocator beyond the bump-style `malloc` used during init for the src buffer. The codec build queries stream-struct offsets via the exported `getInBufferPtr()` at init (its larger stack pushes them past the decoder's old fixed offsets). **Do not** assume conventional WASM memory growth or that `malloc`/`free` work at runtime.

**TS layer (`src/`).** The public API is one-shot only — no streaming/WHATWG-stream surface. `zstd-wasm-decoder.ts` wraps the WASM module with `ZstdDecoder` (sync `decompressSync` for buffers ≤ ~9.4 MB after expected-size hint check, falls back internally to the private `_decompressStream` engine otherwise). `zstd-wasm-encoder.ts` wraps the compress side (`ZstdEncoder`, level 1 only; other levels throw; `compressSync` falls back internally to the private `_compressStream` engine for inputs over `maxSrcSize`). `index.node.ts`, `index.web.ts`, `index.web.inlined.ts` are environment-specific entrypoints — they differ only in how they obtain the `WebAssembly.Module` (filesystem, fetch, base64-inlined, etc.). `shared.ts` holds env-agnostic decoder glue (`decompress`, `decompressSync`, `setupZstdDecoder`, the decoder pool); `encoder-shared.ts` holds the analogous encoder glue. `types.d.ts` and `dist/types/` (generated) are the public type surface.

**Build pipeline (`build.ts`).** `bun build.ts` (after the WASM step) produces the published artifacts: it esbuilds each entrypoint, runs terser with property-mangling restricted to `_`-prefixed names (reserving `_initialize`), and emits both inlined-WASM and external-`.wasm` variants. The `--prep` flag is for partial regeneration. The `default` import is the size-optimized inlined build; `/perf`, `/external`, etc. are documented in the README.

**Tests (`test/`).** `suite.test.ts` is the shared decoder suite, parameterized via env vars. `codec.test.ts` covers the encoder side and cross-decodes through the host `zstd` CLI. Dictionaries are unsupported and untested. `TEST_ADAPTER` (`node` default, `browser-all`, `wasm`) and `TEST_VARIANT` (`web-inlined`, `web-inlined-perf`, …) pick which built artifact to exercise — that's why `test:release` re-runs with multiple variants. Adapters live in `test/adapters/`; browser tests boot a fixture server (`fixture-server.ts`) and load `test/bundles/test-harness.html` via Playwright; the server routes `/dist/...` to the built artifacts. Coverage config and timeouts are in `test/vitest.config.ts` (long timeout because some decompression cases are large).

**Generated outputs** under `dist/esm/` (JS + `.wasm`) and `dist/types/` (`.d.ts`) are committed-derived artifacts of the build; don't edit them by hand. After changing C sources or `bin/include/`, you must `regenerate-amalgamated` (the Makefile does this automatically on the build targets).
