/**
 * ZSTD frame header parsing utilities.
 *
 * @author 101arrowz
 * @see https://github.com/101arrowz/fzstd/blob/master/src/index.ts
 */

export const err = Error;
export interface DZS {
  d: number; // dictionary ID
  u: number; // window size
  e: number; // uncompressed (content) size; 0 when not declared in the header
}

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
  const flg = dat[4];
  const ss = (flg >> 5) & 1,
    df = flg & 3,
    fcf = flg >> 6;
  // Frame_Content_Size sits after the (optional) Window_Descriptor and the
  // Dictionary_ID field: offset = (6 - singleSegment) + dictIdBytes.
  // (Mind JS precedence — this MUST be parenthesised, see rzfh below.)
  const off = 6 - ss + (df == 3 ? 4 : df);
  return rb(dat, off, fcf ? 1 << fcf : ss) + (fcf == 1 ? 256 : 0);
};

// Read Zstandard frame header
export const rzfh = (dat: Uint8Array): number | DZS => {
  if ((dat[0] | (dat[1] << 8) | (dat[2] << 16)) == 0x2fb528 && dat[3] == 253) {
    // Zstandard frame
    const flg = dat[4];
    const ss = (flg >> 5) & 1,      // single segment
      df = flg & 3,                 // dict flag
      fcf = flg >> 6;               // frame content flag
    // byte
    const bt = 6 - ss;
    // dict bytes
    const db = df == 3 ? 4 : df;
    // dictionary id
    const d = rb(dat, bt, db);
    const e = rb(dat, bt + db, fcf ? 1 << fcf : ss) + (fcf == 1 ? 256 : 0);
    // window size
    let u = e;
    if (!ss) {
      // window descriptor
      const wb = 1 << (10 + (dat[5] >> 3));
      u = wb + (wb >> 3) * (dat[5] & 7);
    }
    // Guard the *window* size (u), not the content size (e): large payloads
    // are normal and must still decode (future-proof up to level 9 → 4 MB
    // window). Match the wasm decoder's hard cap (ZSTD_WASM_MAX_WINDOW_SIZE
    // = 4 MB + 1, windowLog 22 / level 9) so over-cap frames fail here at the
    // same threshold rather than only later inside the wasm.
    if (u > 4194305) throw new err('win 2 large');
    return { d, u, e };
  }
  throw new err('bad zstd dat');
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
