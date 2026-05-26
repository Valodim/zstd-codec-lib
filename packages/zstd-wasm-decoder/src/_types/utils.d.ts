/**
 * ZSTD frame header parsing utilities.
 *
 * @author 101arrowz
 * @see https://github.com/101arrowz/fzstd/blob/master/src/index.ts
 */
export declare const err: ErrorConstructor;
export interface DZS {
    d: number;
    u: number;
    e: number;
}
export declare const rb: (d: Uint8Array, b: number, n: number) => number;
export declare const _fss: (dat: Uint8Array) => number;
export declare const rzfh: (dat: Uint8Array) => number | DZS;
export declare function _concatUint8Arrays(arrays: Uint8Array[], ol: number): Uint8Array;
//# sourceMappingURL=utils.d.ts.map