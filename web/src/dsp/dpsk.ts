// Differential PSK (Gray-coded, 2/4/8 phase) — ported from Python.
// Demod uses quadrature mix-and-integrate (equivalent to the Python Hilbert
// path for recovering the differential phase, but needs no arbitrary-size FFT).

import { bytesToBits } from "./bits";
import { GRAY_DEC, grayEnc } from "./gray";

export interface DpskParams {
  sampleRate: number;
  baud: number;
  carrier: number;
  phases: number; // 2 | 4 | 8
}

export function modulateDpsk(data: Uint8Array, p: DpskParams): Float64Array {
  const bps = Math.log2(p.phases);
  const enc = grayEnc(p.phases);
  const step = (2 * Math.PI) / p.phases;
  const bits = bytesToBits(data);
  while (bits.length % bps) bits.push(0);
  const sr = p.sampleRate;
  const sps = Math.floor(sr / p.baud);
  const out = new Float64Array((bits.length / bps) * sps);
  const TWO_PI = 2 * Math.PI;
  let phase = 0;
  let idx = 0;
  for (let i = 0; i < bits.length; i += bps) {
    let val = 0;
    for (let b = 0; b < bps; b++) val = (val << 1) | bits[i + b];
    phase = (phase + enc[val] * step) % TWO_PI;
    for (let k = 0; k < sps; k++) out[idx++] = Math.cos((TWO_PI * p.carrier * k) / sr + phase);
  }
  return out;
}

export function demodulateDpsk(audio: Float64Array | Float32Array, p: DpskParams): number[] {
  const bps = Math.log2(p.phases);
  const dec = GRAY_DEC[p.phases];
  const step = (2 * Math.PI) / p.phases;
  const sr = p.sampleRate;
  const sps = Math.floor(sr / p.baud);
  const nsym = Math.floor(audio.length / sps);
  const TWO_PI = 2 * Math.PI;
  const bits: number[] = [];
  let prevRe = 0;
  let prevIm = 0;
  let havePrev = false;
  for (let i = 0; i < nsym; i++) {
    // c = Σ chunk[k]·exp(-j·2π·fc·k/sr) — its angle is the symbol's phase.
    let re = 0;
    let im = 0;
    for (let k = 0; k < sps; k++) {
      const t = (TWO_PI * p.carrier * k) / sr;
      const s = audio[i * sps + k];
      re += s * Math.cos(t);
      im -= s * Math.sin(t);
    }
    let sym = 0;
    if (havePrev) {
      // pd = angle(c · conj(prev)) in [0, 2π)
      const cr = re * prevRe + im * prevIm;
      const ci = im * prevRe - re * prevIm;
      let pd = Math.atan2(ci, cr);
      if (pd < 0) pd += TWO_PI;
      sym = dec[Math.round(pd / step) % p.phases];
    }
    for (let j = bps - 1; j >= 0; j--) bits.push((sym >> j) & 1);
    prevRe = re;
    prevIm = im;
    havePrev = true;
  }
  return bits;
}
