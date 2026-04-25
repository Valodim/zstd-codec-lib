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

EXPORTS = malloc _initialize pb cd ds re dS
CODEC_EXPORTS = malloc _initialize pb cd ds re dS ic cD cs cS getInBufferPtr
BIN_DIR = bin
AMALGAMATED_SOURCE = $(BIN_DIR)/zstd_wasm_amalgamated.c
CODEC_AMALGAMATED_SOURCE = $(BIN_DIR)/zstd_wasm_codec_amalgamated.c
OUTPUT_DIR = build
OUTPUT = $(OUTPUT_DIR)/zstd.wasm
OUTPUT_PERF = $(OUTPUT_DIR)/zstd-perf.wasm
OUTPUT_SMALL = $(OUTPUT_DIR)/zstd-small.wasm
OUTPUT_SMALL_PERF = $(OUTPUT_DIR)/zstd-small-perf.wasm
OUTPUT_CODEC = $(OUTPUT_DIR)/zstd-codec.wasm
OUTPUT_CODEC_PERF = $(OUTPUT_DIR)/zstd-codec-perf.wasm
OUTPUT_CODEC_LVL1 = $(OUTPUT_DIR)/zstd-codec-lvl1.wasm
OUTPUT_CODEC_LVL1_PERF = $(OUTPUT_DIR)/zstd-codec-lvl1-perf.wasm

CFLAGS = --target=wasm32

# 8kb stack sufficient for a lightweight decoder only zstd build.
# Codec build overrides this (CFLAGS_CODEC_STACK below) since the
# upstream compress path needs a deeper call stack.
CFLAGS += -nostdlib
CFLAGS += -I$(BIN_DIR)/include -I$(BIN_DIR) -I../../vendor/zstd/lib
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

CFLAGS_SIZE += -DZSTD_NO_INLINE

CFLAGS_SIZE += $(CFLAGS) -Oz -z stack-size=8192
CFLAGS_PERF = $(CFLAGS) -Os -z stack-size=8192

# Small-window variant: caps maxWindowSize at 2 MB + 1 (level 9). Frames
# declaring a larger window are rejected with frameParameter_windowTooLarge.
# Paired with a smaller linear-memory budget (see LDFLAGS_DEC_SMALL).
CFLAGS_SMALL_DEFINES = -DZSTD_WASM_MAX_WINDOW_SIZE=2097153
CFLAGS_SMALL_SIZE = $(CFLAGS_SIZE) $(CFLAGS_SMALL_DEFINES)
CFLAGS_SMALL_PERF = $(CFLAGS_PERF) $(CFLAGS_SMALL_DEFINES)

# Codec needs a deeper stack — upstream ZSTD_compress2 / compressStream2
# call into a few-levels-deep dispatch that exceeds 8KB. 64KB is well
# under the heap_cursor reset point.
# ZSTD_DEPS_NEED_MATH64 enables ZSTD_div64 which compress-side code calls
# (decoder builds don't need it).
CFLAGS_CODEC_SIZE = $(CFLAGS) -Oz -DZSTD_NO_INLINE -DZSTD_DEPS_NEED_MATH64 -z stack-size=65536
CFLAGS_CODEC_PERF = $(CFLAGS) -Os -DZSTD_DEPS_NEED_MATH64 -z stack-size=65536

# Lvl1-only variant: drop the dfast strategy entirely (-DZSTD_EXCLUDE_DFAST_*)
# and shrink the dummy compress in _initialize so workspace is sized
# for level-1 cParams (windowLog=19, ~1MB workspace) rather than level-3
# (windowLog=21, ~3MB). Also caps the decoder's maxWindowSize at 2 MB + 1
# (level 9): the asymmetry is intentional — we only emit level-1 frames
# ourselves (windowLog=19, 512 KB), but we still need to decode foreign
# zstd frames produced by other tools up to level 9. Frames declaring a
# larger window are rejected with frameParameter_windowTooLarge.
# Net: ~5KB smaller binary, 12 MB linear memory (vs. 16 MB before).
# Note: upstream auto-clamps strategy=dfast→fast when DFAST is excluded,
# so callers passing level 2 or 3 silently get fast-strategy output.
CFLAGS_CODEC_LVL1_DEFINES = -DZSTD_EXCLUDE_DFAST_BLOCK_COMPRESSOR -DZSTD_WASM_INIT_LEVEL=1 -DZSTD_WASM_MAX_WINDOW_SIZE=2097153
CFLAGS_CODEC_LVL1_SIZE = $(CFLAGS_CODEC_SIZE) $(CFLAGS_CODEC_LVL1_DEFINES)
CFLAGS_CODEC_LVL1_PERF = $(CFLAGS_CODEC_PERF) $(CFLAGS_CODEC_LVL1_DEFINES)

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

# Decoder-only memory layout (~16 MB, 8KB stack).
LDFLAGS_DEC = $(LDFLAGS) -Wl,--global-base=8192 -Wl,--initial-heap=16580608 -Wl,--initial-memory=16777216
LDFLAGS_DEC += $(foreach fn,$(EXPORTS),-Wl,--export=$(fn))

# Small-window decoder layout (~8 MB). Budget: 8KB stack + 96KB DCtx +
# rodata + 4B ddict ptr + up to 2MB dict + 2MB src buf + ~2.5MB dst buf
# (2MB window + 3*128KB blocks + margin) ≈ 6.6 MB. Round up to 8 MB.
LDFLAGS_DEC_SMALL = $(LDFLAGS) -Wl,--global-base=8192 -Wl,--initial-heap=8192000 -Wl,--initial-memory=8388608
LDFLAGS_DEC_SMALL += $(foreach fn,$(EXPORTS),-Wl,--export=$(fn))

# Codec memory layout (~32 MB) — extra space for the CCtx workspace
# (level 3 with windowLog=21 can need a few MB on top of the existing
# decoder layout) plus headroom for the dst buffer at decode time.
# global-base must be >= stack-size when --stack-first is used.
LDFLAGS_CODEC = $(LDFLAGS) -Wl,--global-base=65536 -Wl,--initial-heap=33161216 -Wl,--initial-memory=33554432
LDFLAGS_CODEC += $(foreach fn,$(CODEC_EXPORTS),-Wl,--export=$(fn))

# Lvl1 codec: same exports + same big-stack global-base. Two instances of
# this module exist at runtime — one decoder-only, one encoder-only — so
# the budget must cover whichever is larger.
#   Encoder (the bigger consumer):
#     64KB stack + ~256KB rodata/static + ~1MB CCtx workspace +
#     4MB src buf (_DEFAULT_MAX_SRC) + ~4.1MB dst buf (compressBound(4MB))
#     ≈ ~10 MB. Round up to 12 MB for headroom.
#   Decoder: 64KB stack + ~256KB rodata + ~1MB CCtx (still allocated by
#     _initialize) + ~96KB DCtx + up to 2MB dict + 2MB src + ~2.5MB dst
#     (2MB window + 3*128KB blocks + margin) ≈ ~8 MB; fits easily.
LDFLAGS_CODEC_LVL1 = $(LDFLAGS) -Wl,--global-base=65536 -Wl,--initial-heap=12386304 -Wl,--initial-memory=12582912
LDFLAGS_CODEC_LVL1 += $(foreach fn,$(CODEC_EXPORTS),-Wl,--export=$(fn))

# --enable-tail-call minimal benefit for relative compat issues
# wasm-opt flags
WASM_OPT_FLAGS_PRE = --monomorphize --generate-global-effects --untee --converge -Os

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
	--ignore-implicit-traps \
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

# Codec wasm-opt flags: drop --ignore-implicit-traps. The compress path
# contains dynamic divisions (hash/chain table sizing) where wasm-opt's
# trap-free assumption was producing real divide-by-zero trains in the
# generated code. Everything else is identical.
WASM_OPT_FLAGS_CODEC_COMMON = $(filter-out --ignore-implicit-traps,$(WASM_OPT_FLAGS_COMMON))
WASM_OPT_FLAGS_CODEC_SIZE = $(WASM_OPT_FLAGS_PRE) -Oz $(WASM_OPT_FLAGS_CODEC_COMMON) $(WASM_OPT_FLAGS_EXTRA)
WASM_OPT_FLAGS_CODEC_PERF = $(WASM_OPT_FLAGS_PRE) $(WASM_OPT_FLAGS_CODEC_COMMON) $(WASM_OPT_FLAGS_EXTRA) -Os

.PHONY: all clean check-tools test tests regenerate-amalgamated regenerate-amalgamated-codec help size perf size-small perf-small codec codec-perf codec-lvl1 codec-lvl1-perf

all: check-tools size perf size-small perf-small codec codec-perf codec-lvl1 codec-lvl1-perf

size: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building size-optimized WASM..."
	@$(CLANG) $(CFLAGS_SIZE) $(LDFLAGS_DEC) $(AMALGAMATED_SOURCE) -o $(OUTPUT)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_SIZE) $(OUTPUT) -o $(OUTPUT); \
	fi
	@echo "Build complete: $(OUTPUT)"
	@ls -lh $(OUTPUT)

perf: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building performance-optimized WASM..."
	@$(CLANG) $(CFLAGS_PERF) $(LDFLAGS_DEC) $(AMALGAMATED_SOURCE) -o $(OUTPUT_PERF)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_PERF) $(OUTPUT_PERF) -o $(OUTPUT_PERF); \
	fi
	@echo "Build complete: $(OUTPUT_PERF)"
	@ls -lh $(OUTPUT_PERF)

size-small: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building size-optimized small-window WASM..."
	@$(CLANG) $(CFLAGS_SMALL_SIZE) $(LDFLAGS_DEC_SMALL) $(AMALGAMATED_SOURCE) -o $(OUTPUT_SMALL)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_SIZE) $(OUTPUT_SMALL) -o $(OUTPUT_SMALL); \
	fi
	@echo "Build complete: $(OUTPUT_SMALL)"
	@ls -lh $(OUTPUT_SMALL)

perf-small: check-tools regenerate-amalgamated $(OUTPUT_DIR)
	@echo "Building performance-optimized small-window WASM..."
	@$(CLANG) $(CFLAGS_SMALL_PERF) $(LDFLAGS_DEC_SMALL) $(AMALGAMATED_SOURCE) -o $(OUTPUT_SMALL_PERF)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_PERF) $(OUTPUT_SMALL_PERF) -o $(OUTPUT_SMALL_PERF); \
	fi
	@echo "Build complete: $(OUTPUT_SMALL_PERF)"
	@ls -lh $(OUTPUT_SMALL_PERF)

# Codec: decoder + level 1-3 compressor. Uses the same freestanding.py
# + combine.py amalgamation pipeline as the decoder; the upstream
# ZSTD_EXCLUDE_*_BLOCK_COMPRESSOR macros (set inside the source) plus
# clang LTO + --gc-sections do the trimming.
codec: check-tools regenerate-amalgamated-codec $(OUTPUT_DIR)
	@echo "Building codec WASM (size-optimized)..."
	@$(CLANG) $(CFLAGS_CODEC_SIZE) $(LDFLAGS_CODEC) $(CODEC_AMALGAMATED_SOURCE) -o $(OUTPUT_CODEC)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_CODEC_SIZE) $(OUTPUT_CODEC) -o $(OUTPUT_CODEC); \
	fi
	@echo "Build complete: $(OUTPUT_CODEC)"
	@ls -lh $(OUTPUT_CODEC)

codec-perf: check-tools regenerate-amalgamated-codec $(OUTPUT_DIR)
	@echo "Building codec WASM (performance-optimized)..."
	@$(CLANG) $(CFLAGS_CODEC_PERF) $(LDFLAGS_CODEC) $(CODEC_AMALGAMATED_SOURCE) -o $(OUTPUT_CODEC_PERF)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_CODEC_PERF) $(OUTPUT_CODEC_PERF) -o $(OUTPUT_CODEC_PERF); \
	fi
	@echo "Build complete: $(OUTPUT_CODEC_PERF)"
	@ls -lh $(OUTPUT_CODEC_PERF)

codec-lvl1: check-tools regenerate-amalgamated-codec $(OUTPUT_DIR)
	@echo "Building lvl1 codec WASM (size-optimized)..."
	@$(CLANG) $(CFLAGS_CODEC_LVL1_SIZE) $(LDFLAGS_CODEC_LVL1) $(CODEC_AMALGAMATED_SOURCE) -o $(OUTPUT_CODEC_LVL1)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_CODEC_SIZE) $(OUTPUT_CODEC_LVL1) -o $(OUTPUT_CODEC_LVL1); \
	fi
	@echo "Build complete: $(OUTPUT_CODEC_LVL1)"
	@ls -lh $(OUTPUT_CODEC_LVL1)

codec-lvl1-perf: check-tools regenerate-amalgamated-codec $(OUTPUT_DIR)
	@echo "Building lvl1 codec WASM (performance-optimized)..."
	@$(CLANG) $(CFLAGS_CODEC_LVL1_PERF) $(LDFLAGS_CODEC_LVL1) $(CODEC_AMALGAMATED_SOURCE) -o $(OUTPUT_CODEC_LVL1_PERF)
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt $(WASM_OPT_FLAGS_CODEC_PERF) $(OUTPUT_CODEC_LVL1_PERF) -o $(OUTPUT_CODEC_LVL1_PERF); \
	fi
	@echo "Build complete: $(OUTPUT_CODEC_LVL1_PERF)"
	@ls -lh $(OUTPUT_CODEC_LVL1_PERF)

clean:
	rm -rf $(OUTPUT_DIR)

test tests: all
	@cd ../.. && pnpm run test

regenerate-amalgamated:
	@cd $(BIN_DIR) && ./create_amalgamated_wasm.sh

regenerate-amalgamated-codec:
	@cd $(BIN_DIR) && ./create_amalgamated_codec_wasm.sh

help:
	@echo "Zstd WASM Decoder Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  all (default)  - Build size and perf optimized WASM + TypeScript build"
	@echo "  size           - Build size-optimized WASM (zstd.wasm, -Oz)"
	@echo "  perf           - Build performance-optimized WASM (zstd-perf.wasm, -Os)"
	@echo "  clean          - Remove build artifacts"
	@echo "  test/tests     - Run test suite"
	@echo "  help           - Show this help"

check-tools:
	@if [ ! -f "$(CLANG)" ]; then \
		echo "Error: clang not found at $(CLANG)"; \
		exit 1; \
	fi

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)
