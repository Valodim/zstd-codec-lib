## zstd-wasm-decoder

Tiny & performant decoder-only implementation of Zstandard. Optional compressor (levels 1-3) available via the `/codec` subpath.

|          |                                                                                                                                                                                                                         |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Lightweight**      | 13.19kb / 17.17kb (zipped) for size or perf. optimized decoder build<br>40kb / 52kb (zipped) for size or perf. optimized codec build (decoder + level 1-3 compressor)                                                                                                                              |
| **Dictionary Support** | Multiple and up to 2MB each. Compression dictionaries supported in the codec build.                                                                                                                                  |
| **Performant**       | ~1.6x throughput vs Node.js zlib (V8), ~0.96x vs Bun (JSC)                                                                                                                          |
| **Compatibility**    | • [DecompressionStream API ponyfill](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream) + matching `CompressionStream`-shaped class for the codec build<br>• [>94% worldwide browsers](https://browsersl.ist/#q=%3E0.3%25%2C+chrome+%3E%3D+80%2C+edge+%3E%3D+80%2C+firefox+%3E%3D+113%2C+safari+%3E%3D+16.4%2C+ios_saf+%3E%3D+16.4%2C+not+dead%2C+fully+supports+wasm-simd%2C+fully+supports+wasm-bulk-memory%2C+fully+supports+wasm-signext)<br>• Node 20-24, Cloudflare Workers, Vite, Bun<br>• Can be loaded as [pre-compressed](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/packages/zstd-wasm-decoder/build.ts#L182) inline base64<br> or as separate .wasm for [CSP compliance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution)  |
| **Tested**           | Validated against vectors from the zstd reference implementation. Codec output cross-decoded by the host `zstd` CLI in CI.                                                                                                              |
| **Zero deps**        | No runtime dependencies (excluding build); compiled from source using latest clang & binaryen                                                                                        |

#### Implementation notes:
- Given the [limitations of wasm memory management](https://github.com/WebAssembly/design/issues/1397) and to achieve appropriate code size & performance, memory is allocated to a fixed-size [ring buffer](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/packages/zstd-wasm-decoder/bin/zstd_wasm_full.c#L41), avoiding heap growth entirely. The buffer is [sufficiently sized](https://github.com/tadpole-labs/zstd-codec-lib/blob/main/packages/zstd-wasm-decoder/src/zstd-wasm.ts#L4) to handle the maximum memory required by level 19 compressed data.
- For use in browsers, the module is asynchronously compiled & cached at page load.
- The codec build pulls only the `fast` (lvl 1-2) and `dfast` (lvl 3) strategies from upstream — heavy strategies (`greedy`/`lazy`/`btopt`/`btultra*`) are excluded via the upstream `ZSTD_EXCLUDE_*_BLOCK_COMPRESSOR` macros, so `--gc-sections` + LTO drop them entirely. Higher compression levels are not supported.

## Usage - (Client Side)
```typescript
import { decompress, ZstdDecompressionStream, decompressStream, createDecoder } 
from 'zstd-wasm-decoder'; // Default (Node/browser - automatically inferred)

import { ... } // For strict CSP policies (no unsafe-eval for WASM)
from 'zstd-wasm-decoder/external'; // .wasm fetched from same-origin

import { ... } // If you need the extra perf. (+30%) for +4kb in the browser
from 'zstd-wasm-decoder/perf' // or perf/external
                              // non-browser env uses perf. by default

import { ... }                
from 'zstd-wasm-decoder/cloudflare'; // for cloudflare workers
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
import { setupZstdDecoder } from 'zstd-wasm-decoder';
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

## Compression (Codec)

Compression is opt-in via the `/codec` subpath. The codec build is a superset of the decoder — it exports both APIs from a single wasm module, so a single import gives you round-tripping.

```typescript
import {
  compress,
  decompress,
  ZstdCompressionStream,
  ZstdDecompressionStream,
  createEncoder,
  setupZstdCodec,
} from 'zstd-wasm-decoder/codec';                  // Default (Node/browser inferred)

import { ... } from 'zstd-wasm-decoder/codec/external';   // .wasm fetched from same-origin
import { ... } from 'zstd-wasm-decoder/codec/perf';       // perf-optimized variant
import { ... } from 'zstd-wasm-decoder/codec/cloudflare'; // Cloudflare Workers
```

```typescript
// 1. Simple compress / decompress round-trip
const compressed: Uint8Array = await compress(input, { level: 3 });
const decoded:    Uint8Array = await decompress(compressed);

// 2. Streaming via WHATWG TransformStreams
const compStream: ReadableStream<Uint8Array> = blob.stream()
  .pipeThrough(new ZstdCompressionStream({ level: 3 }));

// Mirrors CompressionStream API — pipe directly into a fetch(), file write, etc.
await fetch('/upload', { method: 'POST', body: compStream });

// 3. With a compression dictionary
const enc = await createEncoder({
  dictionary: await (await fetch('/dict.bin')).arrayBuffer(),
  level: 3,
});
const out = enc.compressSync(input);

// 4. Pre-warm + use sync compressSync afterwards (avoids the await on hot paths)
import { compressSync } from 'zstd-wasm-decoder/codec';
await setupZstdCodec({ level: 3 });
const out2: Uint8Array = compressSync(input, { level: 3 });
```

### Compression caveats
- **Levels 1, 2, 3 only** — higher levels are intentionally excluded to keep the binary small. The compression ratio is competitive with `zstd -3` (the host CLI default), but if you need maximum ratio you'll need a different library.
- The codec uses a fixed ~32 MB linear memory (vs the decoder's 16 MB). Allocation happens up front; the wasm doesn't grow at runtime.
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
cd packages/zstd-wasm-decoder
make check-tools
```

### Development Workflow

```bash
# Full build (WASM + TypeScript)
pnpm run build:all

# Clean build
pnpm run clean:decoder
pnpm run build:all

# Run tests
pnpm test                    # All runtimes (Node + browsers + Bun)
pnpm run test:node           # Node.js only — includes the codec suite
pnpm run test:codec          # Codec round-trip + cross-decode tests only
pnpm run test:browsers       # Browser tests only
pnpm run test:bun            # Bun only

# Run benchmarks
pnpm run bench:full
```

## License

This package is dual-licensed under **Apache-2.0 OR MIT**

The underlying [zstd implementation](https://github.com/facebook/zstd?tab=License-1-ov-file) is licensed under **BSD-3-Clause**.