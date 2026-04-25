


/**
 * \file zstd_wasm_full.c
 * Fully amalgamated Zstandard WASM decoder with wrapper functions.
 *
 * This file combines:
 * - All necessary compiler defines from Makefile
 * - Minimal libc implementation
 * - Zstandard decoder library (zstddeclib)
 * - WASM wrapper functions
 *
 * Generate using:
 * \code
 *   cd ../../vendor/zstd/build/single_file_libs
 *   python3 combine.py -r ../../lib -x legacy/zstd_legacy.h \
 *     -o ../../../../packages/zstd-wasm-decoder/bin/zstd_wasm_full.c \
 *     ../../../../packages/zstd-wasm-decoder/bin/zstd_wasm_full-in.c
 * \endcode
 */

/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */


/* 
    In wasm, there is two possible memory layouts that we get out-of-the box
    Data   <<<      Stack   ---     Heap    >>>
           growing down
           potentially into data
    or
    Stack           Data    ---     Heap    >>>

    Attempting to achieve
         Static Mem
    Stack           Heap    ---     Heap    >>>

    Doesn't work as the linker script / order of the data section seems to be ignored.

    ---
    - Ring buf is the most efficient & memory friendly way of decompressing data.
    
    - We have to put the stack down. And the growing & periodically resetted ring buf higher up.
    Having the in & out buf pointer structs + dctx ptr in one place & at low offsets
    is easier to reson about, with the only remaining pointers to manage being src & dst buf.
    
    .rodata containing 2208 bytes of constants for the decompression context is being put right
    after the stack.
    
    To get to the following layout.
      
                             4b srcPtr          4b srcPtr
                                4b size            4b size     
                                   4b pos             4b pos
                                      4b pad             4b pad                Dctx
    Stack        Heap        ZSTD_inBuffer*    ZSTD_outBuffer*                 95804b       Heap
    0 <--- 8192         --->               --->                --->            Data
                Cursor
                        8192               8208                8224            8224        104028 
    
    The statically allocated dctx consumes about 96k bytes. The final number is rounded up,
    so that static data offsets are better aligned > compressible.
*/



/* xxHash configuration */
#undef  XXH_NAMESPACE
#define XXH_NAMESPACE ZSTD_
#undef  XXH_PRIVATE_API
#define XXH_PRIVATE_API
#undef  XXH_INLINE_ALL
#define XXH_INLINE_ALL

#include "stddef.h"
#include "stdint.h"
#include <wasm_simd128.h>

#define WASM_EXPORT __attribute__((visibility("default")))
#define XXH_FORCE_MEMORY_ACCESS 2
#include "common/zstd_deps.h"

#include "common/entropy_common.c"
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

__attribute__((section(".rodata"))) // It is not read only, but the only way to have llvm respect the order since linker scripts are not working.

// Same for decompression context
// Rationale: Keep writes as far away as possible from the dctx, and the vital pointer structs (those above)
// __stack_pointer & __heap_cursor already "isolated" in global var -> cannot be overwritten through runtime code. Unless global.set is explicitly called.
// The only places where this happens is malloc, or when stack ptr operations occur.
static ZstdBufsObject ZstdBufs; 
typedef struct {
    ZSTD_DCtx dctx;
} __attribute__((aligned(16))) ZstdPadObject;

__attribute__((section(".rodata")))
static ZstdPadObject ZstdPad;
static ZSTD_DCtx* dctx = &ZstdPad.dctx;

static struct ZSTD_DDict_s* ddict;
static ZSTD_inBuffer* const in_buffer = (ZSTD_inBuffer*)&ZstdBufs.in_buffer;
static ZSTD_outBuffer* const out_buffer = (ZSTD_outBuffer*)&ZstdBufs.out_buffer;

// This is not exported in the final binary but prevents from the structs being put after .rodata.
WASM_EXPORT
void* getInBufferPtr(void) {
    return (void*)in_buffer;
}

// Heap_cursor as internal mutable global with initialization
extern unsigned char __heap_cursor;
__asm__(
    ".globaltype __heap_cursor, i32\n"
    "__heap_cursor:\n"
);

#include "decompress/zstd_decompress.c"
#include "decompress/zstd_decompress_block.c"

// Bump only. Reset in JS via pb(ptr) "prune buf"
// Global variables do not live in the linear memory of the wasm module, ruling out overflow into the cursor.
WASM_EXPORT
void* malloc(size_t size) {
    size_t ptr;
    __asm__(
        "local.get %0\n"
        "global.get __heap_cursor\n"
        "local.tee %0\n"
        "i32.add\n"
        "global.set __heap_cursor\n"
        : "=r"(ptr)
        : "r"(size)
    );
    return (void*)ptr;
}

/* Wasmtime 21.0.1
------------------------------

    (module
    (memory (export "memory") 0)
    (global $__heap_cursor (mut i32) (i32.const 1024))
    (func $malloc_global (export "malloc") (param $size i32) (result i32)
        (local $ptr i32)
        global.get $__heap_cursor
        local.tee $ptr
        local.get $size
        i32.add
        global.set $__heap_cursor
        local.get $ptr
    )
    )

    wasm[0]::function[0]:
    pushq	%rbp
    movq	%rsp, %rbp
    movl	0x70(%rdi), %eax
    addl	%eax, %edx
    movl	%edx, 0x70(%rdi)
    movq	%rbp, %rsp
    popq	%rbp
    retq

    ------------------------------

    (module
    (memory (export "memory") 0)
    (global $__heap_cursor (mut i32) (i32.const 1024))
    (func $malloc_load_store (export "malloc2") (param $size i32) (result i32)
        (local $ptr i32)
        (local $new_cursor i32)
        (local.set $ptr (i32.load (i32.const 0)))
        (local.set $new_cursor (i32.add (local.get $ptr) (local.get $size)))
        (i32.store (i32.const 0) (local.get $new_cursor))
        (local.get $ptr)
    )
    )

    wasm[0]::function[0]:
    pushq	%rbp
    movq	%rsp, %rbp
    movq	0x60(%rdi), %r8
    movl	(%r8), %eax
    leal	(%rax,%rdx), %r9d
    movl	%r9d, (%r8)
    movq	%rbp, %rsp
    popq	%rbp
    retq

    ------------------------------
*/

void free(void* ptr) {
    (void)ptr; // no-op
}

// This is not exported in the final binary but prevents from inline asm being "optimized" to i32.const + i32.load
size_t get_heap_cursor(void) {
    size_t cursor;
    __asm__(
        "global.get __heap_cursor\n"
        : "=r"(cursor)
    );
    return cursor;
}

// Prune buffer to overwrite old data.
WASM_EXPORT
void pb(size_t new_size) {
    __asm__(
        "local.get %0\n"
        "global.set __heap_cursor\n"
        : 
        : "r"(new_size)
    );
}

void* calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    void* ptr = malloc(total);
    if (ptr) {
        __builtin_memset(ptr, 0, total);
    }
    return ptr;
}

// Doing 2x i32.store is slightly faster for 64b.
// The compiler doesn't inline anything though (no places where <=64b are written statically)
// So at runtime the check is more expensive than just calling memcpy.
void* memcpy(void* dest, const void* src, size_t n) {
    return __builtin_memcpy(dest, src, n);
}

void* memset(void* s, int c, size_t n) {
    return __builtin_memset(s, c, n);
}

void* memmove(void* dest, const void* src, size_t n) {
    return __builtin_memmove(dest, src, n);
}

// Reset Decompression Context. The bare minimum that we need.
WASM_EXPORT
void re(void)
{
    dctx->streamStage = zdss_init;
    dctx->noForwardProgress = 0;
    dctx->isFrameDecompression = 1;
    dctx->format = ZSTD_f_zstd1;
}

// The ZSTD_createDctx, renamed to _initialize so the compiler understands that this is the entrypoint.
// Those two values are the only ones that are set, the rest is zero initialized implicitly.
// -> since we previously already reserved sufficient space for ZSTD_dctx.
#ifndef ZSTD_WASM_MAX_WINDOW_SIZE
#define ZSTD_WASM_MAX_WINDOW_SIZE 8388609 /* level 19: 8 MB + 1 */
#endif

void _initialize(void) {
    dctx->dictUses = ZSTD_use_indefinitely;
    dctx->maxWindowSize = ZSTD_WASM_MAX_WINDOW_SIZE;
    pb(131072);
}

/*
    Manually folded / inlined ZSTD_createDDict
*/
WASM_EXPORT
void cd(const void* dict, size_t dictSize) {
    ddict = (ZSTD_DDict*) malloc(sizeof(ZSTD_DDict));
    ddict->dictContent = dict;
    ddict->dictSize = dictSize;
    ddict->entropy.hufTable[0] = (HUF_DTable)((ZSTD_HUFFDTABLE_CAPACITY_LOG)*0x1000001);
    ddict->dictID = 0;
    ddict->entropyPresent = 0;
    U32 const magic = MEM_readLE32(ddict->dictContent);
    if (magic == ZSTD_MAGIC_DICTIONARY) {
        ddict->dictID = MEM_readLE32((const char*)ddict->dictContent + ZSTD_FRAMEIDSIZE);
        ZSTD_loadDEntropy(
            &ddict->entropy, ddict->dictContent, ddict->dictSize);
        ddict->entropyPresent = 1;
    }
    dctx->ddict = ddict;
}

/*
    ZSTD_decompressBegin_usingDDict
*/
static size_t decompressBegin_usingDDict(void)
{   
    if (ddict) {
        const char* const dictStart = (const char*)ddict->dictContent;
        size_t const dictSize = ddict->dictSize;
        const void* const dictEnd = dictStart + dictSize;
        dctx->ddictIsCold = (dctx->dictEnd != dictEnd);
    }
    FORWARD_IF_ERROR( ZSTD_decompressBegin(dctx) , "");
    if (ddict) {   /* NULL ddict is equivalent to no dictionary */
        ZSTD_copyDDictParameters(dctx, ddict);
    }
    return 0;
}

/*
    ZSTD_decompressMultiFrame
    
    dict case removed as never have undigest dictionaries.
    so dict is always NULL.
    if ddict is NULL. The function works exactly as the original.
*/
ZSTD_ALLOW_POINTER_OVERFLOW_ATTR
static size_t dm(void* dst, size_t dstCapacity, const void* src, size_t srcSize)
{
    void* const dststart = dst;
    int moreThan1Frame = 0;

    while (srcSize >= ZSTD_startingInputLength(dctx->format)) {
        if (dctx->format == ZSTD_f_zstd1 && srcSize >= 4) {
            U32 const magicNumber = MEM_readLE32(src);
            if ((magicNumber & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
                /* skippable frame detected : skip it */
                size_t const skippableSize = readSkippableFrameSize(src, srcSize);
                FORWARD_IF_ERROR(skippableSize, "invalid skippable frame");
                assert(skippableSize <= srcSize);

                src = (const BYTE *)src + skippableSize;
                srcSize -= skippableSize;
                continue; /* check next frame */
        }   }

        if (ddict) {
            /* we were called from ZSTD_decompress_usingDDict */
            FORWARD_IF_ERROR(decompressBegin_usingDDict(), "");
        } else {
            /* this will initialize correctly with no dict if dict == NULL, so
             * use this in all cases but ddict */
            FORWARD_IF_ERROR(ZSTD_decompressBegin(dctx), "");
        }
        ZSTD_checkContinuity(dctx, dst, dstCapacity);

        {   const size_t res = ZSTD_decompressFrame(dctx, dst, dstCapacity,
                                                    &src, &srcSize);
            RETURN_ERROR_IF(
                (ZSTD_getErrorCode(res) == ZSTD_error_prefix_unknown)
             && (moreThan1Frame==1),
                srcSize_wrong,"");
            if (ZSTD_isError(res)) return res;
            assert(res <= dstCapacity);
            if (res != 0)
                dst = (BYTE*)dst + res;
            dstCapacity -= res;
        }
        moreThan1Frame = 1;
    }  /* while (srcSize >= ZSTD_frameHeaderSize_prefix) */

    RETURN_ERROR_IF(srcSize, srcSize_wrong, "");

    return (size_t)((BYTE*)dst - (BYTE*)dststart);
}


/*
    ZSTD_decompress_usingDDict > MultiFrame
*/
WASM_EXPORT
size_t dS(void* dst, size_t dstCapacity, const void* src, size_t srcSize) {
    return dm(dst, dstCapacity, src, srcSize);
}

/*
    ZSTD_decompressStream(ZSTD_DCtx* zds, ZSTD_outBuffer* output, ZSTD_inBuffer* input)
    
    Removed static dctx check branch, and bunch of other stuff that the compiler is too shy to optimize away.
*/
WASM_EXPORT
size_t ds(void) {
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
                if (ZSTD_isError(hSize)) {
                    return hSize;   /* error */
                }
                if (hSize != 0) {   /* need more input */
                    size_t const toLoad = hSize - dctx->lhSize;   /* if hSize!=0, hSize > dctx->lhSize */
                    size_t const remainingInput = (size_t)(iend-ip);
                    assert(iend >= ip);
                    if (toLoad > remainingInput) {   /* not enough input to load full header */
                        if (remainingInput > 0) {
                            ZSTD_memcpy(dctx->headerBuffer + dctx->lhSize, ip, remainingInput);
                            dctx->lhSize += remainingInput;
                        }
                        in_buffer->pos = in_buffer->size;
                        /* check first few bytes */
                        FORWARD_IF_ERROR(
                            ZSTD_getFrameHeader_advanced(&dctx->fParams, dctx->headerBuffer, dctx->lhSize, dctx->format),
                            "First few bytes detected incorrect" );
                        /* return hint input size */
                        return (MAX((size_t)ZSTD_FRAMEHEADERSIZE_MIN(dctx->format), hSize) - dctx->lhSize) + ZSTD_blockHeaderSize;   /* remaining header bytes + next block header */
                    }
                    ZSTD_memcpy(dctx->headerBuffer + dctx->lhSize, ip, toLoad); dctx->lhSize = hSize; ip += toLoad;
                    break;
            }   }

            /* check for single-pass mode opportunity */
            if (dctx->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN
                && dctx->fParams.frameType != ZSTD_skippableFrame
                && (U64)(size_t)(oend-op) >= dctx->fParams.frameContentSize) {
                size_t const cSize = ZSTD_findFrameCompressedSize_advanced(istart, (size_t)(iend-istart), dctx->format);
                
                if (cSize <= (size_t)(iend-istart)) {
                    /* shortcut : using single-pass mode */
                    size_t const decompressedSize = dm(op, (size_t)(oend-op), istart, cSize);
                    if (ZSTD_isError(decompressedSize)) return decompressedSize;
                    ip = istart + cSize;
                    op += decompressedSize; /* can occur if frameContentSize = 0 (empty frame) */
                    dctx->expected = 0;
                    dctx->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
            }   }

            /* Consume header (see ZSTDds_decodeFrameHeader) */
            FORWARD_IF_ERROR(decompressBegin_usingDDict(), "");

            if (dctx->format == ZSTD_f_zstd1
                && (MEM_readLE32(dctx->headerBuffer) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {  /* skippable frame */
                dctx->expected = MEM_readLE32(dctx->headerBuffer + ZSTD_FRAMEIDSIZE);
                dctx->stage = ZSTDds_skipFrame;
            } else {
                FORWARD_IF_ERROR(ZSTD_decodeFrameHeader(dctx, dctx->headerBuffer, dctx->lhSize), "");
                dctx->expected = ZSTD_blockHeaderSize;
                dctx->stage = ZSTDds_decodeBlockHeader;
            }

            /* control buffer memory usage */
            dctx->fParams.windowSize = MAX(dctx->fParams.windowSize, 1U << ZSTD_WINDOWLOG_ABSOLUTEMIN);
            RETURN_ERROR_IF(dctx->fParams.windowSize > dctx->maxWindowSize,
                            frameParameter_windowTooLarge, "");

            /* Adapt buffer sizes to frame header instructions */
            {   size_t const neededInBuffSize = MAX(dctx->fParams.blockSizeMax, 4 /* frame checksum */);
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
                if (neededInSize==0) {  /* end of frame */
                    dctx->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
                }
                if ((size_t)(iend-ip) >= neededInSize) {  /* decode directly from src */
                    FORWARD_IF_ERROR(ZSTD_decompressContinueStream(dctx, &op, oend, ip, neededInSize), "");
                    ip += neededInSize;
                    /* Function modifies the stage so we must break */
                    break;
            }   }
            if (ip==iend) { someMoreWork = 0; break; }   /* no more input */
            dctx->streamStage = zdss_load;
            ZSTD_FALLTHROUGH;

        case zdss_load:
            {   size_t const neededInSize = dctx->expected;
                size_t const toLoad = neededInSize - dctx->inPos;
                size_t loadedSize;
                /* At this point we shouldn't be decompressing a block that we can stream. */
                assert(neededInSize == ZSTD_nextSrcSizeToDecompressWithInputSize(dctx, (size_t)(iend - ip)));
                if (dctx->stage == ZSTDds_skipFrame) {
                    loadedSize = MIN(toLoad, (size_t)(iend-ip));
                } else {
                    RETURN_ERROR_IF(toLoad > dctx->inBuffSize - dctx->inPos,
                                    corruption_detected,
                                    "should never happen");
                    loadedSize = ZSTD_limitCopy(dctx->inBuff + dctx->inPos, toLoad, ip, (size_t)(iend-ip));
                }
                if (loadedSize != 0) {
                    /* ip may be NULL */
                    ip += loadedSize;
                    dctx->inPos += loadedSize;
                }
                if (loadedSize < toLoad) { someMoreWork = 0; break; }   /* not enough input, wait for more */

                /* decode loaded input */
                dctx->inPos = 0;   /* input is consumed */
                FORWARD_IF_ERROR(ZSTD_decompressContinueStream(dctx, &op, oend, dctx->inBuff, neededInSize), "");
                /* Function modifies the stage so we must break */
                break;
            }
        case zdss_flush:
            {
                size_t const toFlushSize = dctx->outEnd - dctx->outStart;
                size_t const flushedSize = ZSTD_limitCopy(op, (size_t)(oend-op), dctx->outBuff + dctx->outStart, toFlushSize);

                op += flushedSize;

                dctx->outStart += flushedSize;
                if (flushedSize == toFlushSize) {  /* flush completed */
                    dctx->streamStage = zdss_read;
                    if ( (dctx->outBuffSize < dctx->fParams.frameContentSize)
                        && (dctx->outStart + dctx->fParams.blockSizeMax > dctx->outBuffSize) ) {
                        dctx->outStart = dctx->outEnd = 0;
                    }
                    break;
            }   }
            /* cannot complete flush */
            someMoreWork = 0;
            break;

        default:
            assert(0);    /* impossible */
            RETURN_ERROR(GENERIC, "impossible to reach");   /* some compilers require default to do something */
    }   }

    /* result */
    in_buffer->pos = (size_t)(ip - (const char*)(in_buffer->src));
    out_buffer->pos = (size_t)(op - (char*)(out_buffer->dst));

    /* Update the expected output buffer for ZSTD_obm_stable. */
    dctx->expectedOutBuffer = *out_buffer;

    if ((ip==istart) && (op==ostart)) {  /* no forward progress */
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
        if (!nextSrcSizeHint) {   /* frame fully decoded */
            if (dctx->outEnd == dctx->outStart) {  /* output fully flushed */
                if (dctx->hostageByte) {
                    if (in_buffer->pos >= in_buffer->size) {
                        /* can't release hostage (not present) */
                        dctx->streamStage = zdss_read;
                        return 1;
                    }
                    in_buffer->pos++;  /* release hostage */
                }   /* dctx->hostageByte */
                return 0;
            }  /* dctx->outEnd == dctx->outStart */
            if (!dctx->hostageByte) { /* output not fully flushed; keep last byte as hostage; will be released when all output is flushed */
                in_buffer->pos--;   /* note : pos > 0, otherwise, impossible to finish reading last block */
                dctx->hostageByte=1;
            }
            return 1;
        }  /* nextSrcSizeHint==0 */
        nextSrcSizeHint += ZSTD_blockHeaderSize * (ZSTD_nextInputType(dctx) == ZSTDnit_block);   /* preload header of next block */
        assert(dctx->inPos <= nextSrcSizeHint);
        nextSrcSizeHint -= dctx->inPos;   /* part already loaded*/
        return nextSrcSizeHint;
    }
}
