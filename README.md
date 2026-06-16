## zstd-wasm-codec

Tiny & performant Zstandard codec for WebAssembly. Decoder + level-1 compressor in a single module.

|          |                                                                                                                                                                                                                         |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Lightweight**      | 38kb / 48kb (zipped) for the size/perf-optimized codec (12 MB linear memory, decoder capped to a 4 MB window — level 9)                                                                                                                              |
| **Dictionary Support** | Multiple and up to 2MB each. Compression and decompression dictionaries both supported.                                                                                                                                  |
| **Performant**       | ~1.6x throughput vs Node.js zlib (V8), ~0.96x vs Bun (JSC)                                                                                                                          |
| **Compatibility**    | • [DecompressionStream API ponyfill](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream) + matching `CompressionStream`-shaped class<br>• [>94% worldwide browsers](https://browsersl.ist/#q=%3E0.3%25%2C+chrome+%3E%3D+80%2C+edge+%3E%3D+80%2C+firefox+%3E%3D+113%2C+safari+%3E%3D+16.4%2C+ios_saf+%3E%3D+16.4%2C+not+dead%2C+fully+supports+wasm-simd%2C+fully+supports+wasm-bulk-memory%2C+fully+supports+wasm-signext)<br>• Node ≥ 22, Vite, Bun<br>• Can be loaded as [pre-compressed](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/build.ts) inline base64<br> or as separate .wasm for [CSP compliance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution)  |
| **Tested**           | Validated against vectors from the zstd reference implementation. Codec output cross-decoded by the host `zstd` CLI in CI.                                                                                                              |
| **Zero deps**        | No runtime dependencies (excluding build); compiled from source using latest clang & binaryen                                                                                        |

#### Implementation notes:
- Given the [limitations of wasm memory management](https://github.com/WebAssembly/design/issues/1397) and to achieve appropriate code size & performance, memory is allocated to a fixed-size [ring buffer](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/bin/zstd_wasm_full.c), avoiding heap growth entirely. The buffer is [sufficiently sized](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/src/zstd-wasm-decoder.ts) to handle the maximum memory required by a level-9 frame (4 MB decoder window).
- For use in browsers, the module is asynchronously compiled & cached at page load.
- Only the `fast` (lvl 1) strategy is pulled from upstream — heavier strategies (`dfast`/`greedy`/`lazy`/`btopt`/`btultra*`) are excluded via the upstream `ZSTD_EXCLUDE_*_BLOCK_COMPRESSOR` macros, so `--gc-sections` + LTO drop them entirely. Higher compression levels are not supported (passing `level: 2` or `3` silently clamps to fast strategy).

## Decompression
```typescript
import { decompress, ZstdDecompressionStream, decompressStream, createDecoder } 
from 'zstd-wasm-codec'; // Default (Node/browser - automatically inferred)

import { ... } // For strict CSP policies (no unsafe-eval for WASM)
from 'zstd-wasm-codec/external'; // .wasm fetched from same-origin

import { ... } // If you need the extra perf. (+30%) for +4kb in the browser
from 'zstd-wasm-codec/perf' // or perf/external
                            // non-browser env uses perf. by default
```
```typescript
// 1. Simple decompression (with optional dictionary)
const data: Uint8Array = await decompress(compressedData, { 
  dictionary: await (await fetch('/dict.bin')).arrayBuffer()
});
```
**Note:** In development mode, the inlined version is served for `/external` to avoid bundler issues (e.g., in Vite).
```typescript
// 2. Streaming API - fetch response
const stream: ReadableStream<string> = (await fetch('/file.zst')).body!
  .pipeThrough(new ZstdDecompressionStream())
  .pipeThrough(new TextDecoderStream());

// 3. Streaming API - with dictionary
const ds = new ZstdDecompressionStream({ 
  dictionary: await (await fetch('/dict.bin')).arrayBuffer()
});

// Alternatively
import { setupZstdDecoder } from 'zstd-wasm-codec';
await setupZstdDecoder({ 
  dictionaries: ['/dict.bin'] // Accepts URLs
});
const ds = new ZstdDecompressionStream(); // Auto-detects dict from frame header

const ds: ReadableStream<Uint8Array> = blob.stream().pipeThrough(ds);
```
```typescript
// 4. Manual streaming (for chunked data)
const { buf, in_offset }: { buf: Uint8Array, in_offset: number } = await decompressStream(chunk, reset);

// 5. Reusable decoder instance
const decoder = await createDecoder();
const result1: Uint8Array = decoder.decompressSync(data1);
const result2: Uint8Array = decoder.decompressSync(data2);
```

## Compression

Compression and decompression are exported from the same module — a single import gives you round-tripping.

```typescript
import {
  compress,
  decompress,
  ZstdCompressionStream,
  ZstdDecompressionStream,
  createEncoder,
  setupZstdCodec,
} from 'zstd-wasm-codec';                  // Default (Node/browser inferred)

import { ... } from 'zstd-wasm-codec/external';   // .wasm fetched from same-origin
import { ... } from 'zstd-wasm-codec/perf';       // perf-optimized variant
```

```typescript
// 1. Simple compress / decompress round-trip
const compressed: Uint8Array = await compress(input, { level: 1 });
const decoded:    Uint8Array = await decompress(compressed);

// 2. Streaming via WHATWG TransformStreams
const compStream: ReadableStream<Uint8Array> = blob.stream()
  .pipeThrough(new ZstdCompressionStream({ level: 1 }));

// Mirrors CompressionStream API — pipe directly into a fetch(), file write, etc.
await fetch('/upload', { method: 'POST', body: compStream });

// 3. With a compression dictionary
const enc = await createEncoder({
  dictionary: await (await fetch('/dict.bin')).arrayBuffer(),
  level: 1,
});
const out = enc.compressSync(input);

// 4. Pre-warm + use sync compressSync afterwards (avoids the await on hot paths)
import { compressSync } from 'zstd-wasm-codec';
await setupZstdCodec({ level: 1 });
const out2: Uint8Array = compressSync(input, { level: 1 });
```

### Compression caveats
- **Level 1 only** — only the `fast` strategy is included to keep the binary small. Passing `level: 2` or `level: 3` does not error: upstream auto-clamps to the `fast` strategy, so you get level-1-equivalent output. If you need maximum ratio you'll need a different library.
- The codec uses a fixed 12 MB linear memory. Allocation happens up front; the wasm doesn't grow at runtime.
- The compressor emits level-1 frames (512 KB window); the decoder accepts foreign frames up to level 9 (4 MB window). Frames declaring a larger window — e.g. level-19 output from the `zstd` CLI — are refused with `frameParameter_windowTooLarge`.
- Output frames are spec-compliant — round-tripping through the upstream `zstd` CLI is verified by CI.

### Important Considerations
- The default export is pre-minified and mangled. All builds tested against the full suite.
- Legacy ZSTD format is not supported, and the presence of magic bytes is expected; some libraries have this disabled by default.
- Consult [the reference](https://github.com/facebook/zstd/blob/448cd340879adc0ffe36ed1e26823ee2dcb3217b/lib/zstd_errors.h#L60) to interpret error codes, should any occur.
- **Do not** use the wasm module standalone (without js).
- **Do not** send any (compressed) sensitive data over continous, long-running streams.
<br><sub>
[Side-channel attacks](https://blog.cloudflare.com/ai-side-channel-attack-mitigated/) &nbsp;|&nbsp;
[CRIME](https://en.wikipedia.org/wiki/CRIME) &nbsp;|&nbsp;
[BREACH](https://breachattack.com/) &nbsp;|&nbsp;
[Lucky Thirteen](https://en.wikipedia.org/wiki/Lucky_Thirteen_attack)
</sub>

## Contributing
### Prerequisites

**macOS:**
```bash
brew install llvm binaryen pnpm zopfli
```

**Linux:**
```bash
sudo apt-get install clang lld binaryen zopfli
```

**Note:** macOS's default `/usr/bin/clang` is a symlink to Apple Clang 17, which lacks the linker 
required for WebAssembly builds. You must install the full LLVM toolchain from Homebrew, build from 
source, or download the binaries (as done by the [CI runner](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/.github/workflows/build-setup.yml))

### Setup

1. **Clone and install dependencies:**
```bash
git clone --recursive https://github.com/tadpole-labs/zstd-codec-lib.git
cd zstd-codec-lib
pnpm install
```

2. **Configure LLVM path** (if not auto-detected):
```bash
# macOS with Homebrew:
export LLVM_DIR=/opt/homebrew/opt/llvm

# Linux:
export LLVM_DIR=/usr
```

3. **Verify toolchain:**
```bash
make check-tools
```

### Development Workflow

```bash
# Full build (WASM + TypeScript)
yarn build

# Clean build
yarn clean
yarn build

# Run tests
yarn test                    # All runtimes (Node + browsers + Bun)
yarn test:node               # Node.js only — includes the codec suite
yarn test:codec              # Codec round-trip + cross-decode tests only
yarn test:browsers           # Browser tests only
yarn test:bun                # Bun only

# Run benchmarks
yarn bench:full
```

## License

This package is dual-licensed under **Apache-2.0 OR MIT**

The underlying [zstd implementation](https://github.com/facebook/zstd?tab=License-1-ov-file) is licensed under **BSD-3-Clause**.
