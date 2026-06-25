// Gray-code mappings shared by DPSK and OFDM, matching Python's _GRAY_DEC/_ENC.

// phase-index → data-value
export const GRAY_DEC: Record<number, number[]> = {
  2: [0, 1],
  4: [0, 1, 3, 2],
  8: [0, 1, 3, 2, 6, 7, 5, 4],
};

// data-value → phase-index (inverse of GRAY_DEC)
export function grayEnc(n: number): number[] {
  const dec = GRAY_DEC[n];
  const enc = new Array(n).fill(0);
  dec.forEach((v, i) => (enc[v] = i));
  return enc;
}
