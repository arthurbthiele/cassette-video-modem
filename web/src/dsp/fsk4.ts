// 4-FSK (4 tones, 2 bits/symbol), phase-continuous — ported from Python.

import { bytesToBits } from "./bits";

export interface Fsk4Params {
  sampleRate: number;
  baud: number;
  freqs: [number, number, number, number];
}

export function modulateFsk4(data: Uint8Array, p: Fsk4Params): Float64Array {
  const bits = bytesToBits(data);
  if (bits.length % 2) bits.push(0);
  const sr = p.sampleRate;
  const n = Math.floor(sr / p.baud);
  const out = new Float64Array((bits.length / 2) * n);
  const TWO_PI = 2 * Math.PI;
  let phase = 0;
  let idx = 0;
  for (let i = 0; i < bits.length; i += 2) {
    const freq = p.freqs[(bits[i] << 1) | bits[i + 1]];
    for (let k = 0; k < n; k++) out[idx++] = Math.sin((TWO_PI * freq * k) / sr + phase);
    phase = (phase + (TWO_PI * freq * n) / sr) % TWO_PI;
  }
  return out;
}

function goertzel(a: ArrayLike<number>, start: number, len: number, freq: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = a[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s2 * s2 + s1 * s1 - coeff * s1 * s2;
}

export function demodulateFsk4(audio: Float64Array | Float32Array, p: Fsk4Params): number[] {
  const sr = p.sampleRate;
  const sps = Math.max(1, Math.floor(sr / p.baud));
  const nsym = Math.floor(audio.length / sps);
  const bits: number[] = [];
  for (let i = 0; i < nsym; i++) {
    let best = 0;
    let bestPow = -Infinity;
    for (let s = 0; s < 4; s++) {
      const pow = goertzel(audio, i * sps, sps, p.freqs[s], sr);
      if (pow > bestPow) { bestPow = pow; best = s; }
    }
    bits.push((best >> 1) & 1, best & 1);
  }
  return bits;
}
