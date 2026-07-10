// src/utils.ts
var err = Error;
var rb = (d, b, n) => {
  let o = 0;
  for (let i = 0;i < n; ++i)
    o += d[b++] * 2 ** (i << 3);
  return o;
};
var _fss = (dat) => {
  if (rb(dat, 0, 4) !== 4247762216)
    return 0;
  const flg = dat[4];
  const ss = flg >> 5 & 1, df = flg & 3, fcf = flg >> 6;
  const off = 6 - ss + (df == 3 ? 4 : df);
  return rb(dat, off, fcf ? 1 << fcf : ss) + (fcf == 1 ? 256 : 0);
};
function _concatUint8Arrays(arrays, ol) {
  if (arrays.length == 1)
    return arrays[0];
  const buf = new Uint8Array(ol);
  for (let i = 0, b = 0;i < arrays.length; ++i) {
    const chk = arrays[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
}

// src/zstd-wasm-codec.ts
var _MAX_SRC_BUF = 2 * 1024 * 1024;
var _MAX_DST_BUF_DEFAULT = 9830464;
var _DST_BUF_TAIL_MARGIN = 1048576;
var _DEFAULT_MAX_SRC = 4 * 1024 * 1024;
var _assertLevel1 = (level) => {
  if (level !== 1)
    throw new err(`level ${level} unsupported; only level 1`);
  return level;
};
var _compressBound = (srcSize) => srcSize + (srcSize >>> 8) + (srcSize < 128 * 1024 ? 128 * 1024 - srcSize >>> 11 : 0);

class ZstdCodec {
  _exports;
  _HEAPU8;
  _HEAPU32;
  _streamInStructPtr = 0;
  _streamOutStructPtr = 0;
  _level;
  _maxSrcSize;
  _maxDecSrc = 0;
  _maxDecDst = 0;
  _srcPtr = 0;
  _dstPtrEnc = 0;
  _dstCap = 0;
  _dstPtrDec = 0;
  _maxDstBuf = _MAX_DST_BUF_DEFAULT;
  _flushAt = 0;
  constructor(options = {}) {
    this._level = options.level ?? 1;
    const ms = options.maxSrcSize;
    if (ms !== undefined && !(typeof ms === "number" && ms > 0)) {
      throw new err(`invalid maxSrcSize: ${ms}`);
    }
    this._maxSrcSize = ms ?? _DEFAULT_MAX_SRC;
    const floor = _MAX_DST_BUF_DEFAULT * 64;
    const guard = (v) => typeof v === "number" && v > 0 ? v : floor;
    this._maxDecSrc = guard(options.maxCompressedSize);
    this._maxDecDst = guard(options.maxDecompressedSize);
  }
  init(wasmModule) {
    return this._initCommon(new WebAssembly.Instance(wasmModule, { env: {} }));
  }
  _initWithInstance(wasmInstance, _wasmModule) {
    return this._initCommon(wasmInstance);
  }
  _initCommon(wasmInstance) {
    this._exports = wasmInstance.exports;
    const _memory = this._exports.memory;
    this._HEAPU8 = new Uint8Array(_memory.buffer);
    this._HEAPU32 = new Uint32Array(_memory.buffer);
    this._exports._initialize();
    this._streamInStructPtr = this._exports.getInBufferPtr();
    this._streamOutStructPtr = this._streamInStructPtr + 16;
    this._srcPtr = this._exports.malloc(this._maxSrcSize);
    this._dstCap = _compressBound(this._maxSrcSize);
    this._dstPtrEnc = this._exports.malloc(this._dstCap);
    if (!this._srcPtr || !this._dstPtrEnc) {
      throw new err("oom: maxSrcSize too large for wasm memory");
    }
    this._dstPtrDec = this._srcPtr + _MAX_SRC_BUF;
    this._maxDstBuf = Math.min(_MAX_DST_BUF_DEFAULT, this._HEAPU8.byteLength - this._dstPtrDec - _DST_BUF_TAIL_MARGIN);
    this._flushAt = Math.max(0, this._dstCap - Math.min(this._dstCap >>> 1, 1 << 17));
    return this;
  }
  _writeStreamStruct(ptr, bufPtr, size, pos = 0) {
    const i = ptr >>> 2;
    this._HEAPU32[i] = bufPtr;
    this._HEAPU32[i + 1] = size;
    this._HEAPU32[i + 2] = pos;
  }
  _readStreamPos(ptr) {
    return this._HEAPU32[ptr + 8 >>> 2];
  }
  compressSync(input, level) {
    if (!this._exports)
      throw new err("not init");
    const srcSize = input.length;
    if (srcSize > this._maxSrcSize)
      return this._compressStream(input, true, level);
    this._HEAPU8.set(input, this._srcPtr);
    const lvl = _assertLevel1(level ?? this._level);
    const r = this._exports.compress(this._dstPtrEnc, this._dstCap, this._srcPtr, srcSize, lvl);
    if (r < 0)
      throw new err(`compress err ${r >>> 0}`);
    return this._HEAPU8.slice(this._dstPtrEnc, this._dstPtrEnc + r);
  }
  _compressStream(input, reset = true, level) {
    if (!this._exports)
      throw new err("not init");
    const lvl = _assertLevel1(level ?? this._level);
    if (reset) {
      const r2 = this._exports.initCompressor(lvl);
      if (r2 < 0)
        throw new err(`initCompressor err ${r2 >>> 0}`);
    }
    const inLen = input.length;
    const outChunks = [];
    let outTotal = 0;
    const inChunkMax = Math.min(this._maxSrcSize, 1 << 20);
    let inOff = 0;
    const flushOut = () => {
      const written = this._readStreamPos(this._streamOutStructPtr);
      if (written > 0) {
        outChunks.push(this._HEAPU8.slice(this._dstPtrEnc, this._dstPtrEnc + written));
        outTotal += written;
      }
      this._writeStreamStruct(this._streamOutStructPtr, this._dstPtrEnc, this._dstCap, 0);
    };
    this._writeStreamStruct(this._streamOutStructPtr, this._dstPtrEnc, this._dstCap, 0);
    while (inOff < inLen) {
      const take = Math.min(inChunkMax, inLen - inOff);
      this._HEAPU8.set(input.subarray(inOff, inOff + take), this._srcPtr);
      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, take, 0);
      while (this._readStreamPos(this._streamInStructPtr) < take) {
        const r2 = this._exports.compressStreamStep(0);
        if (r2 < 0)
          throw new err(`compressStreamStep err ${r2 >>> 0}`);
        if (this._readStreamPos(this._streamOutStructPtr) >= this._flushAt)
          flushOut();
      }
      inOff += take;
    }
    let r;
    do {
      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, 0, 0);
      r = this._exports.compressStreamStep(2);
      if (r < 0)
        throw new err(`compressStreamStep end err ${r >>> 0}`);
      if (this._readStreamPos(this._streamOutStructPtr) >= this._flushAt)
        flushOut();
    } while (r > 0);
    flushOut();
    return _concatUint8Arrays(outChunks, outTotal);
  }
  decompressSync(compressedData, expectedSize) {
    if (!this._exports)
      throw new err("not init");
    const srcSize = compressedData.length;
    if (srcSize > this._maxDecSrc)
      throw new err(`comp dat>maxCompressedSize lim`);
    if (!expectedSize)
      expectedSize = _fss(compressedData);
    if (expectedSize > this._maxDecDst)
      throw new err(`dec size>maxDstSize lim`);
    if (expectedSize === 0 || expectedSize > this._maxDstBuf || srcSize > _MAX_SRC_BUF) {
      return this._decompressStream(compressedData, true, true).buf;
    }
    const dstPtr = this._dstPtrDec;
    this._exports.setHeapEnd(dstPtr);
    this._HEAPU8.set(compressedData, this._srcPtr);
    const result = this._exports.decompress(dstPtr, this._maxDstBuf, this._srcPtr, srcSize);
    if (result < 0)
      throw new err(`dec err ${result}`);
    if (result > this._maxDecDst)
      throw new err(`dec size>maxDstSize lim`);
    return this._HEAPU8.slice(dstPtr, dstPtr + result);
  }
  _decompressStream(input, reset = false, final = false) {
    if (!this._exports)
      throw new err("not init");
    if (reset) {
      this._exports.resetDecoder();
      this._exports.setHeapEnd(this._dstPtrDec);
    }
    const inLen = input.length || 0;
    if (inLen == 0)
      return { buf: new Uint8Array(0), in_offset: 0 };
    const output = [];
    let totalOutputSize = 0;
    let offset = 0;
    const dstBufStart = this._srcPtr + 262150;
    let dstOffset = dstBufStart;
    const dstMaxBuf = dstBufStart + 655360;
    let lastOut = 0;
    let lastHint = 0;
    while (offset < inLen) {
      const toProcess = Math.min(inLen - offset, 262150);
      this._HEAPU8.set(input.subarray(offset, offset + toProcess), this._srcPtr);
      this._writeStreamStruct(this._streamInStructPtr, this._srcPtr, toProcess);
      if (dstOffset == dstBufStart) {
        this._writeStreamStruct(this._streamOutStructPtr, dstOffset, 917501);
      }
      while (this._readStreamPos(this._streamInStructPtr) < toProcess) {
        const result = this._exports.decompressStreamStep();
        if (result < 0)
          throw new err(`dec err ${result}`);
        lastHint = result;
        const outputPos = this._readStreamPos(this._streamOutStructPtr);
        totalOutputSize += dstOffset == dstBufStart ? outputPos : outputPos - lastOut;
        lastOut = outputPos;
        if (outputPos > 0) {
          dstOffset = dstBufStart + outputPos;
          if (dstOffset >= dstMaxBuf) {
            output.push(this._HEAPU8.slice(dstBufStart, dstOffset));
            dstOffset = dstBufStart;
            this._writeStreamStruct(this._streamOutStructPtr, dstOffset, 917501);
          }
          if (totalOutputSize > this._maxDecDst) {
            throw new err(`dec size>maxDstSize lim`);
          }
        }
      }
      offset += toProcess;
    }
    if (dstOffset != dstBufStart)
      output.push(this._HEAPU8.slice(dstBufStart, dstOffset));
    if (final && lastHint !== 0)
      throw new err(`truncated: incomplete frame`);
    return { buf: _concatUint8Arrays(output, totalOutputSize), in_offset: inLen };
  }
  _destroy() {
    this._exports = this._HEAPU8 = this._HEAPU32 = null;
  }
}
var zstd_wasm_codec_default = ZstdCodec;
export {
  zstd_wasm_codec_default as default,
  _MAX_SRC_BUF,
  ZstdCodec
};
