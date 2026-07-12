/**
 * ZSTD frame header parsing utilities.
 *
 * @author 101arrowz
 * @see https://github.com/101arrowz/fzstd/blob/master/src/index.ts
 */

export const err = Error;

export const rb = (d: Uint8Array, b: number, n: number) => {
  // Accumulate with multiplication rather than `<<`: JS bitwise ops are
  // 32-bit, so shift counts wrap mod 32 (corrupting 8-byte Frame_Content_Size
  // reads, fcf=3) and the result is signed (a 4-byte field with the top bit
  // set — magic, >2 GB size, high dictionary ID — would come back negative).
  // Float math is exact up to 2^53, far beyond what these size/window hints
  // need, and naturally stays unsigned.
  let o = 0;
  for (let i = 0; i < n; ++i) o += d[b++] * 2 ** (i << 3);
  return o;
};

export const _fss = (dat: Uint8Array): number => {
  // Only a real zstd frame (magic 0xFD2FB528) carries a Frame_Content_Size at
  // a fixed offset. Skippable frames (magic 0x184D2A5x) and any other leading
  // bytes would make the byte-4 read below a meaningless descriptor, so bail
  // to "unknown" (0) and let the streaming decoder walk frames one by one.
  // rb() is unsigned and reads out-of-range bytes as NaN, so short inputs also
  // fall through here.
  if (rb(dat, 0, 4) !== 0xfd2fb528) return 0;
  const flg = dat[4];
  const ss = (flg >> 5) & 1,
    df = flg & 3,
    fcf = flg >> 6;
  // Frame_Content_Size sits after the (optional) Window_Descriptor and the
  // Dictionary_ID field: offset = (6 - singleSegment) + dictIdBytes.
  // (Mind JS precedence — the dict-bytes ternary MUST be parenthesised.)
  const off = 6 - ss + (df == 3 ? 4 : df);
  const len = fcf ? 1 << fcf : ss;
  // A header truncated before the FCS field ends would make rb() read
  // out-of-range bytes and return NaN, silently defeating the size-based
  // routing and bomb-guard comparisons downstream. Treat it as "unknown" (0).
  if (off + len > dat.length) return 0;
  return rb(dat, off, len) + (fcf == 1 ? 256 : 0);
};

// Concatenate Uint8Array chunks into a single buffer
export function _concatUint8Arrays(arrays: Uint8Array[], ol: number): Uint8Array {
  if (arrays.length == 1) return arrays[0];
  const buf = new Uint8Array(ol);
  for (let i = 0, b = 0; i < arrays.length; ++i) {
    const chk = arrays[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
}
