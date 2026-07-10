/**
 * \file zstd_wasm_full.c
 * Full decoder plus a level-1 compressor (fast strategy only; dfast and the
 * heavier strategies are excluded below via ZSTD_EXCLUDE_*_BLOCK_COMPRESSOR).
 *
 * Those strategies (dfast/greedy/lazy/lazy2/btlazy2/btopt/btultra*) are
 * excluded via upstream's ZSTD_EXCLUDE_*_BLOCK_COMPRESSOR macros, which
 * collapse the static dispatch table entries to NULL so --gc-sections + LTO
 * drop their code paths entirely.
 *
 * Decoder exports: setHeapEnd / decompressStreamStep / resetDecoder /
 *                  decompress.
 *
 * Compression exports:
 *   - initCompressor(level)            init/reset CCtx for a fresh frame
 *   - compress(dst,dCap,src,sSz,level) single-shot compress
 *   - compressStreamStep(endOp)        streaming compress step (mirrors decoder)
 *
 * Dictionaries are not supported (in either direction); frames that
 *  reference a dictionary ID fail with ZSTD_error_dictionary_wrong.
 */


/* xxHash configuration */
#undef  XXH_NAMESPACE
#define XXH_NAMESPACE ZSTD_
#undef  XXH_PRIVATE_API
#define XXH_PRIVATE_API
#undef  XXH_INLINE_ALL
#define XXH_INLINE_ALL

/* Strip every strategy except fast, making this a level-1-only codec.
 * double_fast (lvl 3) is excluded here too — levels 2/3 are auto-clamped to
 * the fast strategy by upstream. The excluded strategies collapse to NULL
 * dispatch-table entries that --gc-sections + LTO drop entirely. */
#define ZSTD_EXCLUDE_GREEDY_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_LAZY_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_LAZY2_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_BTLAZY2_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_BTOPT_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_BTULTRA_BLOCK_COMPRESSOR
#define ZSTD_EXCLUDE_DFAST_BLOCK_COMPRESSOR

#include "stddef.h"
#include "stdint.h"
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))
#define XXH_FORCE_MEMORY_ACCESS 2
#include "common/zstd_deps.h"

#include "common/entropy_common.c"
#include "common/error_private.c"
#include "common/fse_decompress.c"
#include "common/zstd_common.c"

#include "decompress/huf_decompress.c"
#include "decompress/zstd_ddict.c"

typedef struct {
    ZSTD_inBuffer in_buffer;
    unsigned char pad[4];
    ZSTD_outBuffer out_buffer;
    unsigned char pad2[4];
} __attribute__((aligned(32))) ZstdBufsObject;

/* Mutated at runtime (stream structs written from JS each step) — must be
 * writable, so leave it in the default (.bss) section, not .rodata. */
static ZstdBufsObject ZstdBufs;

typedef struct {
    ZSTD_DCtx dctx;
} __attribute__((aligned(16))) ZstdPadObject;

/* The ZSTD_DCtx is mutated throughout decode — keep it writable (.bss). */
static ZstdPadObject ZstdPad;
static ZSTD_DCtx* dctx = &ZstdPad.dctx;

static ZSTD_inBuffer*  const in_buffer  = (ZSTD_inBuffer*)&ZstdBufs.in_buffer;
static ZSTD_outBuffer* const out_buffer = (ZSTD_outBuffer*)&ZstdBufs.out_buffer;

WASM_EXPORT
void* getInBufferPtr(void) {
    return (void*)in_buffer;
}

extern unsigned char __heap_cursor;
__asm__(
    ".globaltype __heap_cursor, i32\n"
    "__heap_cursor:\n"
);

#include "decompress/zstd_decompress.c"
#include "decompress/zstd_decompress_block.c"

/* Compress sources — kept after decoder so the ZSTD_compressBlock_*
 * symbols are available before the dispatch table is materialised. */
#include "compress/hist.c"
#include "compress/fse_compress.c"
#include "compress/huf_compress.c"
#include "compress/zstd_compress_literals.c"
#include "compress/zstd_compress_sequences.c"
#include "compress/zstd_compress_superblock.c"
#include "compress/zstd_fast.c"
#include "compress/zstd_double_fast.c"
/* zstd_ldm.c is included so its symbols resolve at link time; the
 * functions are never actually called because we leave LDM disabled
 * (default), so LTO + --gc-sections drops their bodies. */
#include "compress/zstd_ldm.c"
#include "compress/zstd_preSplit.c"
#include "compress/zstd_compress.c"

WASM_EXPORT
void* malloc(size_t size) {
    /* Bump allocator over the fixed (non-growable) linear memory, with a
     * bounds check: if the request doesn't fit in the free tail, return NULL
     * instead of a pointer past the end of memory. NULL re-arms upstream's
     * `RETURN_ERROR_IF(x == NULL, memory_allocation)` guards, so exhaustion
     * surfaces as a catchable ZSTD error rather than an out-of-bounds trap on
     * first access. With a correct JS-side memory layout this is unreachable.
     *
     * Everything is one self-contained volatile asm block on purpose. The
     * `__heap_cursor` global is opaque to the optimizer; splitting the read,
     * the bump and the check across separate asm statements (or C) lets LTO
     * value-number the distinct `global.get`s together and drop `size`. A
     * single block is one opaque region it cannot reason across.
     *
     * ret (%0) is a single read-write operand ("+r"): it carries `size` in
     * and the pointer (or 0) out. Using one operand avoids clang's unreliable
     * multi-operand loading for wasm inline asm.
     *
     *   free  = (memory.size << 16) - __heap_cursor   ; no underflow: cursor <= end
     *   if (size > free) ret = 0                       ; also rejects absurd sizes
     *   else { ret = __heap_cursor; __heap_cursor += size }
     */
    size_t ret = size;
    __asm__ volatile(
        "memory.size 0\n"
        "i32.const 16\n"
        "i32.shl\n"                      /* memBytes */
        "global.get __heap_cursor\n"
        "i32.sub\n"                      /* free = memBytes - cursor */
        "local.get %0\n"                 /* size (%0 still holds size here) */
        "i32.lt_u\n"                     /* free < size  ->  over budget */
        "if\n"
        "i32.const 0\n"
        "local.set %0\n"                 /* ret = NULL */
        "else\n"
        "global.get __heap_cursor\n"     /* [cursor]  (old cursor, the result) */
        "global.get __heap_cursor\n"     /* [cursor, cursor] */
        "local.get %0\n"                 /* [cursor, cursor, size] */
        "i32.add\n"                      /* [cursor, cursor+size] */
        "global.set __heap_cursor\n"     /* [cursor]  commit bump */
        "local.set %0\n"                 /* ret = old cursor */
        "end_if\n"
        : "+r"(ret)
    );
    return (void*)ret;
}

void free(void* ptr) { (void)ptr; }

size_t get_heap_cursor(void) {
    size_t cursor;
    /* local.set %0 captures the global into the output operand — without it
     * the value is left dangling on the stack (invalid wasm). volatile keeps
     * the read ordered with the bump's global.set. */
    __asm__ volatile(
        "global.get __heap_cursor\n"
        "local.set %0\n"
        : "=r"(cursor)
    );
    return cursor;
}

WASM_EXPORT
void setHeapEnd(size_t new_size) {
    __asm__(
        "local.get %0\n"
        "global.set __heap_cursor\n"
        :
        : "r"(new_size)
    );
}

void* calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    /* Reject multiplication overflow (size_t is 32-bit on wasm32): a wrapped
     * `total` would malloc too little and the memset below would then run
     * past the allocation. */
    if (nmemb != 0 && total / nmemb != size) return NULL;
    void* ptr = malloc(total);
    if (ptr) __builtin_memset(ptr, 0, total);
    return ptr;
}

void* memcpy(void* dest, const void* src, size_t n)  { return __builtin_memcpy(dest, src, n); }
void* memset(void* s, int c, size_t n)               { return __builtin_memset(s, c, n); }
void* memmove(void* dest, const void* src, size_t n) { return __builtin_memmove(dest, src, n); }

/* CCtx singleton. A *static* CCtx (ZSTD_initStaticCCtx) over a fixed
 * workspace bump-allocated once during _initialize, sized from
 * ZSTD_WASM_INIT_LEVEL. A static CCtx never mallocs or resizes at runtime, so
 * every compress reuses this one workspace in place. */
static ZSTD_CCtx* cctx;

WASM_EXPORT
void resetDecoder(void) {
    dctx->streamStage = zdss_init;
    dctx->noForwardProgress = 0;
    dctx->isFrameDecompression = 1;
    dctx->format = ZSTD_f_zstd1;
}

/* Decoder window cap. 4 MB + 1 (windowLog 22, level 9). */
#define ZSTD_WASM_MAX_WINDOW_SIZE 4194305

/* Level whose cParams size the static compressor workspace. */
#define ZSTD_WASM_INIT_LEVEL 1

void _initialize(void) {
    /* Decoder side: same hand-folded ZSTD_createDCtx as the decoder build. */
    dctx->maxWindowSize = ZSTD_WASM_MAX_WINDOW_SIZE;
    /* Bump above all static data — the codec build adds compress-side
     * rodata (default cparams, code tables, etc) so 256KB is safe. */
    setHeapEnd(262144);

    /* Encoder side: reserve a *fixed static* compressor workspace now, at the
     * bottom of the heap (0x40000), before JS starts malloc-ing src/dst. It is
     * sized by ZSTD_estimateCStreamSize(level) — the worst case for this level:
     * full window (pledgedSrcSize=UNKNOWN, so no ZSTD_adjustCParams downsizing)
     * plus the buffered streaming in/out staging. Single-shot compress needs
     * strictly less (non-buffered), so both paths fit this one buffer.
     *
     * Why static: a static CCtx never reallocates. ZSTD_resetCCtx_internal
     * bails with `memory_allocation` instead of resizing when staticSize != 0,
     * and its "workspace too large" shrink path is gated to non-static ctxs —
     * so this workspace is never freed, grown, or relocated. It therefore stays
     * put in [0x40000, H0), which the decoder never writes (its lowest write is
     * _srcPtr == H0), so every compress reuses it in place.
     *
     * wsSize is ~1.3 MB and the heap starts at 0x40000, so the workspace always
     * fits the 12 MB layout; the `ws ? ... : 0` is just belt-and-suspenders for
     * the malloc contract (a NULL cctx would fault on first compress). */
    size_t const wsSize = ZSTD_estimateCStreamSize(ZSTD_WASM_INIT_LEVEL);
    void* const ws = malloc(wsSize);
    cctx = ws ? ZSTD_initStaticCCtx(ws, wsSize) : (ZSTD_CCtx*)0;
}

ZSTD_ALLOW_POINTER_OVERFLOW_ATTR
static size_t dm(void* dst, size_t dstCapacity, const void* src, size_t srcSize) {
    void* const dststart = dst;
    int moreThan1Frame = 0;

    while (srcSize >= ZSTD_startingInputLength(dctx->format)) {
        if (dctx->format == ZSTD_f_zstd1 && srcSize >= 4) {
            U32 const magicNumber = MEM_readLE32(src);
            if ((magicNumber & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
                size_t const skippableSize = readSkippableFrameSize(src, srcSize);
                FORWARD_IF_ERROR(skippableSize, "invalid skippable frame");
                assert(skippableSize <= srcSize);
                src = (const BYTE *)src + skippableSize;
                srcSize -= skippableSize;
                continue;
            }
        }

        /* Enforce the window cap on the single-shot path too. Upstream
         * ZSTD_decompressFrame only rejects windowLog > ZSTD_WINDOWLOG_MAX
         * (~1 GB); without this an over-cap foreign frame (e.g. a >4 MB
         * window, or a single-segment frame whose contentSize exceeds the
         * cap) would decode here even though decompressStreamStep refuses
         * it. fhErr==0 means a complete header was parsed; a partial/short
         * header (fhErr>0) is left to ZSTD_decompressFrame to surface. */
        {   ZSTD_FrameHeader zfh;
            size_t const fhErr = ZSTD_getFrameHeader_advanced(&zfh, src, srcSize, dctx->format);
            if (ZSTD_isError(fhErr)) return fhErr;
            RETURN_ERROR_IF(fhErr == 0 && zfh.windowSize > dctx->maxWindowSize,
                            frameParameter_windowTooLarge, "");
        }

        FORWARD_IF_ERROR(ZSTD_decompressBegin(dctx), "");
        ZSTD_checkContinuity(dctx, dst, dstCapacity);

        {   const size_t res = ZSTD_decompressFrame(dctx, dst, dstCapacity, &src, &srcSize);
            RETURN_ERROR_IF(
                (ZSTD_getErrorCode(res) == ZSTD_error_prefix_unknown)
             && (moreThan1Frame==1),
                srcSize_wrong,"");
            if (ZSTD_isError(res)) return res;
            assert(res <= dstCapacity);
            if (res != 0) dst = (BYTE*)dst + res;
            dstCapacity -= res;
        }
        moreThan1Frame = 1;
    }

    RETURN_ERROR_IF(srcSize, srcSize_wrong, "");
    return (size_t)((BYTE*)dst - (BYTE*)dststart);
}

WASM_EXPORT
size_t decompress(void* dst, size_t dstCapacity, const void* src, size_t srcSize) {
    return dm(dst, dstCapacity, src, srcSize);
}

WASM_EXPORT
size_t decompressStreamStep(void) {
    const char* const src = (const char*)in_buffer->src;
    const char* const istart = src + in_buffer->pos;
    const char* const iend = src + in_buffer->size;
    const char* ip = istart;
    char* const dst = (char*)out_buffer->dst;
    char* const ostart = dst + out_buffer->pos;
    char* const oend = dst + out_buffer->size;
    char* op = ostart;
    U32 someMoreWork = 1;

    while (someMoreWork) {
        switch(dctx->streamStage)
        {
        case zdss_init :
            dctx->streamStage = zdss_loadHeader;
            dctx->lhSize = dctx->inPos = dctx->outStart = dctx->outEnd = 0;
            dctx->hostageByte = 0;
            dctx->expectedOutBuffer = *out_buffer;
            ZSTD_FALLTHROUGH;

        case zdss_loadHeader :
            {   size_t const hSize = ZSTD_getFrameHeader_advanced(&dctx->fParams, dctx->headerBuffer, dctx->lhSize, dctx->format);
                if (ZSTD_isError(hSize)) return hSize;
                if (hSize != 0) {
                    size_t const toLoad = hSize - dctx->lhSize;
                    size_t const remainingInput = (size_t)(iend-ip);
                    assert(iend >= ip);
                    if (toLoad > remainingInput) {
                        if (remainingInput > 0) {
                            ZSTD_memcpy(dctx->headerBuffer + dctx->lhSize, ip, remainingInput);
                            dctx->lhSize += remainingInput;
                        }
                        in_buffer->pos = in_buffer->size;
                        FORWARD_IF_ERROR(
                            ZSTD_getFrameHeader_advanced(&dctx->fParams, dctx->headerBuffer, dctx->lhSize, dctx->format),
                            "First few bytes detected incorrect" );
                        return (MAX((size_t)ZSTD_FRAMEHEADERSIZE_MIN(dctx->format), hSize) - dctx->lhSize) + ZSTD_blockHeaderSize;
                    }
                    ZSTD_memcpy(dctx->headerBuffer + dctx->lhSize, ip, toLoad); dctx->lhSize = hSize; ip += toLoad;
                    break;
            }   }

            if (dctx->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN
                && dctx->fParams.frameType != ZSTD_skippableFrame
                && (U64)(size_t)(oend-op) >= dctx->fParams.frameContentSize) {
                size_t const cSize = ZSTD_findFrameCompressedSize_advanced(istart, (size_t)(iend-istart), dctx->format);
                if (cSize <= (size_t)(iend-istart)) {
                    size_t const decompressedSize = dm(op, (size_t)(oend-op), istart, cSize);
                    if (ZSTD_isError(decompressedSize)) return decompressedSize;
                    ip = istart + cSize;
                    op += decompressedSize;
                    dctx->expected = 0;
                    dctx->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
            }   }

            FORWARD_IF_ERROR(ZSTD_decompressBegin(dctx), "");

            if (dctx->format == ZSTD_f_zstd1
                && (MEM_readLE32(dctx->headerBuffer) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
                dctx->expected = MEM_readLE32(dctx->headerBuffer + ZSTD_FRAMEIDSIZE);
                dctx->stage = ZSTDds_skipFrame;
            } else {
                FORWARD_IF_ERROR(ZSTD_decodeFrameHeader(dctx, dctx->headerBuffer, dctx->lhSize), "");
                dctx->expected = ZSTD_blockHeaderSize;
                dctx->stage = ZSTDds_decodeBlockHeader;
            }

            dctx->fParams.windowSize = MAX(dctx->fParams.windowSize, 1U << ZSTD_WINDOWLOG_ABSOLUTEMIN);
            RETURN_ERROR_IF(dctx->fParams.windowSize > dctx->maxWindowSize,
                            frameParameter_windowTooLarge, "");

            {   size_t const neededInBuffSize = MAX(dctx->fParams.blockSizeMax, 4);
                size_t const neededOutBuffSize = ZSTD_decodingBufferSize_internal(dctx->fParams.windowSize, dctx->fParams.frameContentSize, dctx->fParams.blockSizeMax);

                if ((dctx->inBuffSize + dctx->outBuffSize) >= (neededInBuffSize + neededOutBuffSize) * ZSTD_WORKSPACETOOLARGE_FACTOR)
                    dctx->oversizedDuration++;
                else
                    dctx->oversizedDuration = 0;

                {   int const needsResize = (dctx->inBuffSize < neededInBuffSize) ||
                                            (dctx->outBuffSize < neededOutBuffSize) ||
                                            (dctx->oversizedDuration >= ZSTD_WORKSPACETOOLARGE_MAXDURATION);

                    if (needsResize) {
                        size_t const bufferSize = neededInBuffSize + neededOutBuffSize;
                        dctx->inBuffSize = 0;
                        dctx->outBuffSize = 0;
                        dctx->inBuff = (char*)ZSTD_customMalloc(bufferSize, dctx->customMem);
                        RETURN_ERROR_IF(dctx->inBuff == NULL, memory_allocation, "");
                        dctx->inBuffSize = neededInBuffSize;
                        dctx->outBuff = dctx->inBuff + dctx->inBuffSize;
                        dctx->outBuffSize = neededOutBuffSize;
            }   }   }
            dctx->streamStage = zdss_read;
            ZSTD_FALLTHROUGH;

        case zdss_read:
            {   size_t const neededInSize = ZSTD_nextSrcSizeToDecompressWithInputSize(dctx, (size_t)(iend - ip));
                if (neededInSize==0) {
                    dctx->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
                }
                if ((size_t)(iend-ip) >= neededInSize) {
                    FORWARD_IF_ERROR(ZSTD_decompressContinueStream(dctx, &op, oend, ip, neededInSize), "");
                    ip += neededInSize;
                    break;
            }   }
            if (ip==iend) { someMoreWork = 0; break; }
            dctx->streamStage = zdss_load;
            ZSTD_FALLTHROUGH;

        case zdss_load:
            {   size_t const neededInSize = dctx->expected;
                size_t const toLoad = neededInSize - dctx->inPos;
                size_t loadedSize;
                assert(neededInSize == ZSTD_nextSrcSizeToDecompressWithInputSize(dctx, (size_t)(iend - ip)));
                if (dctx->stage == ZSTDds_skipFrame) {
                    loadedSize = MIN(toLoad, (size_t)(iend-ip));
                } else {
                    RETURN_ERROR_IF(toLoad > dctx->inBuffSize - dctx->inPos,
                                    corruption_detected, "should never happen");
                    loadedSize = ZSTD_limitCopy(dctx->inBuff + dctx->inPos, toLoad, ip, (size_t)(iend-ip));
                }
                if (loadedSize != 0) {
                    ip += loadedSize;
                    dctx->inPos += loadedSize;
                }
                if (loadedSize < toLoad) { someMoreWork = 0; break; }
                dctx->inPos = 0;
                FORWARD_IF_ERROR(ZSTD_decompressContinueStream(dctx, &op, oend, dctx->inBuff, neededInSize), "");
                break;
            }
        case zdss_flush:
            {   size_t const toFlushSize = dctx->outEnd - dctx->outStart;
                size_t const flushedSize = ZSTD_limitCopy(op, (size_t)(oend-op), dctx->outBuff + dctx->outStart, toFlushSize);
                op += flushedSize;
                dctx->outStart += flushedSize;
                if (flushedSize == toFlushSize) {
                    dctx->streamStage = zdss_read;
                    if ( (dctx->outBuffSize < dctx->fParams.frameContentSize)
                        && (dctx->outStart + dctx->fParams.blockSizeMax > dctx->outBuffSize) ) {
                        dctx->outStart = dctx->outEnd = 0;
                    }
                    break;
            }   }
            someMoreWork = 0;
            break;

        default:
            assert(0);
            RETURN_ERROR(GENERIC, "impossible to reach");
        }
    }

    in_buffer->pos = (size_t)(ip - (const char*)(in_buffer->src));
    out_buffer->pos = (size_t)(op - (char*)(out_buffer->dst));
    dctx->expectedOutBuffer = *out_buffer;

    if ((ip==istart) && (op==ostart)) {
        dctx->noForwardProgress ++;
        if (dctx->noForwardProgress >= ZSTD_NO_FORWARD_PROGRESS_MAX) {
            RETURN_ERROR_IF(op==oend, noForwardProgress_destFull, "");
            RETURN_ERROR_IF(ip==iend, noForwardProgress_inputEmpty, "");
            assert(0);
        }
    } else {
        dctx->noForwardProgress = 0;
    }
    {   size_t nextSrcSizeHint = dctx->expected;
        if (!nextSrcSizeHint) {
            if (dctx->outEnd == dctx->outStart) {
                if (dctx->hostageByte) {
                    if (in_buffer->pos >= in_buffer->size) {
                        dctx->streamStage = zdss_read;
                        return 1;
                    }
                    in_buffer->pos++;
                }
                return 0;
            }
            if (!dctx->hostageByte) {
                in_buffer->pos--;
                dctx->hostageByte=1;
            }
            return 1;
        }
        nextSrcSizeHint += ZSTD_blockHeaderSize * (ZSTD_nextInputType(dctx) == ZSTDnit_block);
        assert(dctx->inPos <= nextSrcSizeHint);
        nextSrcSizeHint -= dctx->inPos;
        return nextSrcSizeHint;
    }
}

/* ===== Compression API ===================================================
 * The encoder shares the in_buffer/out_buffer struct pair with the decoder
 * (only one operation runs at a time per wasm instance).
 */

/* Reset CCtx for a fresh frame at the given compression level. */
WASM_EXPORT
size_t initCompressor(int level) {
    // The static workspace persists below _srcPtr, which decode never writes,
    // so a session-only reset reuses it in place.
    size_t const r1 = ZSTD_CCtx_reset(cctx, ZSTD_reset_session_only);
    if (ZSTD_isError(r1)) return r1;
    size_t const r2 = ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level);
    if (ZSTD_isError(r2)) return r2;
    return 0;
}

/* Single-shot compress. Uses ZSTD_compressCCtx so the existing workspace
 * allocated at _initialize time is sufficient (the advanced compress2 path
 * needs a larger workspace that wouldn't fit our fixed-memory layout). */
WASM_EXPORT
size_t compress(void* dst, size_t dstCapacity,
          const void* src, size_t srcSize,
          int level) {
    // Reuses the static workspace in place (see initCompressor); a static CCtx
    // never reallocates, so this makes no heap allocation.
    return ZSTD_compressCCtx(cctx, dst, dstCapacity, src, srcSize, level);
}

/* Streaming compress step. JS sets up in_buffer/out_buffer and calls this
 * repeatedly with endOp (0 = continue, 1 = flush, 2 = end-of-frame). */
WASM_EXPORT
size_t compressStreamStep(int endOp) {
    return ZSTD_compressStream2(cctx, out_buffer, in_buffer, (ZSTD_EndDirective)endOp);
}
