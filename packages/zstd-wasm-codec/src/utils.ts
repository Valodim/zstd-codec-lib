/**
 * ZSTD frame header parsing utilities.
 *
 * @author 101arrowz
 * @see https://github.com/101arrowz/fzstd/blob/master/src/index.ts
 */

export const err = Error;
export interface DZS {
  d: number; // dictionary ID
  u: number; // uncompressed size
  e: number; // window size
}

export const rb = /*! @__PURE__ */ (d: Uint8Array, b: number, n: number) => {
  let i = 0,
    o = 0;
  for (; i < n; ++i) o |= d[b++] << (i << 3);
  return o;
};

export const _fss = (dat: Uint8Array): number => {
  const flg = dat[4];
  const ss = (flg >> 5) & 1,
    df = flg & 3,
    fcf = flg >> 6;
  // @ts-expect-error
  return rb(dat, 6 - ss + df == 3 ? 4 : df, fcf ? 1 << fcf : ss) + (fcf == 1 && 256);
};

// Read Zstandard frame header
export const rzfh = /*! @__PURE__ */ (dat: Uint8Array): number | DZS => {
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
    // @ts-expect-error
    const e = rb(dat, bt + db, fcf ? 1 << fcf : ss) + (fcf == 1 && 256);
    // window size
    let u = e;
    if (!ss) {
      // window descriptor
      const wb = 1 << (10 + (dat[5] >> 3));
      u = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (e > 10000000) throw new err('win 2 large');
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
