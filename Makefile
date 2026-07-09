# Build configuration - adjust these paths as needed
# Set LLVM_DIR as an environment variable for your platform:
#   MacOS (Homebrew):  export LLVM_DIR=/opt/homebrew/opt/llvm
#   Linux:             export LLVM_DIR=/usr (or /usr/local)
#   CI/Custom:         export LLVM_DIR=$HOME/llvm-21

# Try to auto-detect LLVM location if not set
ifeq ($(LLVM_DIR),)
    ifneq ($(wildcard /opt/homebrew/opt/llvm/bin/clang),)
        LLVM_DIR := /opt/homebrew/opt/llvm
    else ifneq ($(wildcard /usr/local/bin/clang),)
        LLVM_DIR := /usr/local
    else ifneq ($(wildcard /usr/bin/clang),)
        LLVM_DIR := /usr
    else
        $(error LLVM_DIR not set and clang not found)
    endif
endif

CLANG = $(LLVM_DIR)/bin/clang

EXPORTS = malloc _initialize setHeapEnd decompressStreamStep resetDecoder decompress initCompressor compress compressStreamStep getInBufferPtr
BIN_DIR = bin
AMALGAMATED_SOURCE = $(BIN_DIR)/zstd_wasm_amalgamated.c
OUTPUT_DIR = build
OUTPUT = $(OUTPUT_DIR)/zstd.wasm
OUTPUT_PERF = $(OUTPUT_DIR)/zstd-perf.wasm

CFLAGS = --target=wasm32

CFLAGS += -nostdlib
CFLAGS += -I$(BIN_DIR)/include -I$(BIN_DIR) -Ivendor/zstd/lib
CFLAGS += -ffreestanding
CFLAGS += -msimd128
CFLAGS += -msign-ext

# CFLAGS += -mtail-call # good feature to reduce stack needs
CFLAGS += -mno-atomics
CFLAGS += -mbulk-memory
CFLAGS += -mexec-model=reactor
CFLAGS += -mcpu=generic
CFLAGS += -flto -DNDEBUG -g0
CFLAGS += -fno-stack-protector -fomit-frame-pointer -fno-ident -fno-trapping-math -ffunction-sections -fdata-sections -fno-sanitize=pointer-overflow -fno-sanitize=signed-integer-overflow -fno-math-errno -fmerge-all-constants -fno-strict-aliasing

# Best bang for the byte
CFLAGS += -DHUF_FORCE_DECOMPRESS_X2
CFLAGS += -DZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT

# Needed for SIMD
# CFLAGS += -DZSTD_NO_INTRINSICS
CFLAGS += -DNO_PREFETCH
CFLAGS += -DXXH_NO_PREFETCH
CFLAGS += -Wall -Wextra -Wcast-qual -Wcast-align
CFLAGS += -Wstrict-aliasing=1 -Wstrict-prototypes
CFLAGS += -Wpointer-arith -Wformat=2 -Wwrite-strings
CFLAGS += -Wredundant-decls -Wno-unused-parameter

CFLAGS += -fwrapv-pointer

CFLAGS += -mllvm -polly
CFLAGS += -mllvm -polly-position=before-vectorizer
CFLAGS += -mllvm -polly-vectorizer=stripmine
CFLAGS += -fvectorize
CFLAGS += -fslp-vectorize

# Codec needs a deeper stack — upstream ZSTD_compress2 / compressStream2
# call into a few-levels-deep dispatch that exceeds 8KB. 64KB is well
# under the heap_cursor reset point.
# ZSTD_DEPS_NEED_MATH64 enables ZSTD_div64 which compress-side code calls
# (decoder builds don't need it).
CFLAGS_SIZE = $(CFLAGS) -Oz -DZSTD_NO_INLINE -DZSTD_DEPS_NEED_MATH64 -z stack-size=65536
CFLAGS_PERF = $(CFLAGS) -Os -DZSTD_DEPS_NEED_MATH64 -z stack-size=65536

# _initialize is the entry (the"ultra minimal" ZSTD_createDCtx)
# LDFLAGS = -Wl,--no-entry
LDFLAGS += -Wl,--allow-undefined
LDFLAGS += -Wl,--strip-all
LDFLAGS += -Wl,--threads=1
LDFLAGS += -Wl,--no-growable-memory
LDFLAGS += -Wl,--lto-O3
LDFLAGS += -Wl,--lto-CGO3
LDFLAGS += -Wl,--gc-sections
LDFLAGS += -Wl,--compress-relocations
LDFLAGS += -Wl,--extra-features=mutable-globals

# Safer layout
# https://bugs.llvm.org/show_bug.cgi?id=37181
# https://github.com/rustwasm/team/issues/81#issue-303617986
LDFLAGS += -Wl,--stack-first
LDFLAGS += -Wl,--merge-data-segments
LDFLAGS += -Wl,--print-map

# Lvl1 codec memory layout (12 MB). A single instance of this module serves
# both directions (compress and decompress time-share one working arena; see
# src/zstd-wasm-codec.ts), so the budget must cover whichever op is larger.
#   Compress (the bigger consumer):
#     64KB stack + ~256KB rodata/static + ~1MB CCtx workspace +
#     4MB src buf (_DEFAULT_MAX_SRC) + ~4.1MB dst buf (compressBound(4MB))
#     ≈ ~10 MB. Round up to 12 MB for headroom.
#   Decompress: 64KB stack + ~256KB rodata + ~1MB CCtx (also allocated by
#     _initialize) + ~96KB DCtx + 2MB src + ~4.5MB dst (4MB window +
#     3*128KB blocks + margin) ≈ ~8 MB; fits.
# global-base must be >= stack-size when --stack-first is used.
LDFLAGS_BASE = $(LDFLAGS) -Wl,--global-base=65536 -Wl,--initial-heap=12386304 -Wl,--initial-memory=12582912
LDFLAGS_BASE += $(foreach fn,$(EXPORTS),-Wl,--export=$(fn))

# --enable-tail-call minimal benefit for relative compat issues
# wasm-opt flags
WASM_OPT_FLAGS_PRE = --monomorphize --generate-global-effects --untee --converge -Os

# NOTE: do not add --ignore-implicit-traps. The compress path contains
# dynamic divisions (hash/chain table sizing) where wasm-opt's trap-free
# assumption produced real divide-by-zero trains in the generated code.
WASM_OPT_FLAGS_COMMON = \
	--enable-simd \
	--inlining \
	--inlining-optimizing \
	--enable-sign-ext \
	--enable-bulk-memory \
	--merge-locals  \
	--tuple-optimization \
	--rse \
	--strip-debug \
	--strip-dwarf \
	--strip-eh \
	--strip-producers \
	--strip-target-features \
	--duplicate-function-elimination \
	--merge-similar-functions \
	--code-folding \
	--dce \
	--vacuum \
	--coalesce-locals-learning \
	--low-memory-unused \
	--closed-world

WASM_OPT_FLAGS_EXTRA = \
	--optimize-instructions \
	--optimize-added-constants \
	--optimize-added-constants-propagate \
	--optimize-casts \
	--dae-optimizing \
	--gsi \
	--gto \
	--gufa \
	--type-refining-gufa \
	--gufa-cast-all \
	--gufa-optimizing

WASM_OPT_FLAGS_SIZE = $(WASM_OPT_FLAGS_PRE) -Oz $(WASM_OPT_FLAGS_COMMON) $(WASM_OPT_FLAGS_EXTRA)
WASM_OPT_FLAGS_PERF = $(WASM_OPT_FLAGS_PRE) $(WASM_OPT_FLAGS_COMMON) $(WASM_OPT_FLAGS_EXTRA) -Os

.PHONY: all clean check-tools test tests regenerate-amalgamated help size perf

all: check-tools size perf

# Lvl1-only codec (decoder + level-1 compressor). Level 2/3 callers are
# silently clamped to fast strategy by upstream when DFAST is excluded.
size: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building WASM (size-optimized)..."
	@$(CLANG) $(CFLAGS_SIZE) $(LDFLAGS_BASE) $(AMALGAMATED_SOURCE) -o $(OUTPUT)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_SIZE) $(OUTPUT) -o $(OUTPUT); \
	fi
	@echo "Build complete: $(OUTPUT)"
	@ls -lh $(OUTPUT)

perf: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building WASM (performance-optimized)..."
	@$(CLANG) $(CFLAGS_PERF) $(LDFLAGS_BASE) $(AMALGAMATED_SOURCE) -o $(OUTPUT_PERF)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_PERF) $(OUTPUT_PERF) -o $(OUTPUT_PERF); \
	fi
	@echo "Build complete: $(OUTPUT_PERF)"
	@ls -lh $(OUTPUT_PERF)

clean:
	rm -rf $(OUTPUT_DIR)

test: all
	yarn run test

regenerate-amalgamated:
	@cd $(BIN_DIR) && ./create_amalgamated_wasm.sh

help:
	@echo "Zstd WASM Codec Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  all (default)  - Build all variants"
	@echo "  size           - Build codec (size-optimized)"
	@echo "  perf           - Build codec (perf-optimized)"
	@echo "  clean          - Remove build artifacts"
	@echo "  test           - Run test suite"
	@echo "  help           - Show this help"

check-tools:
	@if [ ! -f "$(CLANG)" ]; then \
		echo "Error: clang not found at $(CLANG)"; \
		exit 1; \
	fi

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)
