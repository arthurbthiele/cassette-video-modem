// Bit/byte conversion — MSB-first, matching the Python reference exactly.

export function bytesToBits(data: Uint8Array | number[]): number[] {
  const bits: number[] = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  return bits;
}

export function bitsToBytes(bits: number[]): Uint8Array {
  const n = bits.length;
  const padded = n % 8 === 0 ? n : n + (8 - (n % 8));
  const out = new Uint8Array(padded / 8);
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] ?? 0);
    out[i] = b;
  }
  return out;
}
