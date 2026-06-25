// 2-tone FSK, phase-continuous — ported from the Python reference.

import { bytesToBits } from "./bits";

export interface FskParams {
  sampleRate: number;
  baud: number;
  f0: number;
  f1: number;
}

export function modulateFsk(data: Uint8Array, p: FskParams): Float64Array {
  const bits = bytesToBits(data);
  const sr = p.sampleRate;
  const n = Math.floor(sr / p.baud); // samples per symbol (int, as in Python)
  const out = new Float64Array(bits.length * n);
  const TWO_PI = 2 * Math.PI;
  let phase = 0;
  let idx = 0;
  for (const bit of bits) {
    const freq = bit ? p.f1 : p.f0;
    for (let k = 0; k < n; k++) out[idx++] = Math.sin((TWO_PI * freq * k) / sr + phase);
    phase = (phase + (TWO_PI * freq * n) / sr) % TWO_PI;
  }
  return out;
}

// Goertzel power of `freq` over audio[start..start+len).
function goertzel(audio: Float64Array | Float32Array, start: number, len: number, freq: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = audio[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s2 * s2 + s1 * s1 - coeff * s1 * s2;
}

export function demodulateFsk(audio: Float64Array | Float32Array, p: FskParams): number[] {
  const sr = p.sampleRate;
  const sps = Math.max(1, Math.floor(sr / p.baud));
  const nsym = Math.floor(audio.length / sps);
  const bits: number[] = [];
  for (let i = 0; i < nsym; i++) {
    const start = i * sps;
    const p1 = goertzel(audio, start, sps, p.f1, sr);
    const p0 = goertzel(audio, start, sps, p.f0, sr);
    bits.push(p1 > p0 ? 1 : 0);
  }
  return bits;
}
