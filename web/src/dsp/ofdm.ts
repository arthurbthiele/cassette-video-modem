// OFDM (constant-amplitude subcarriers, differential phase, pilot carriers for
// common-phase tracking) — ported from Python.

import { bytesToBits } from "./bits";
import { GRAY_DEC, grayEnc } from "./gray";
import { fftInPlace } from "./fft";

export interface OfdmParams {
  sampleRate: number;
  fftSize: number;
  cpSize: number;
  fMin: number;
  fMax: number;
  pilotInterval: number;
  phases: number;
}

export function ofdmCarriers(p: OfdmParams): { data: number[]; pilots: number[] } {
  const res = p.sampleRate / p.fftSize;
  const kLo = Math.max(1, Math.ceil(p.fMin / res));
  const kHi = Math.min(p.fftSize / 2 - 1, Math.floor(p.fMax / res));
  const data: number[] = [];
  const pilots: number[] = [];
  for (let k = kLo; k <= kHi; k++) ((k - kLo) % p.pilotInterval === 0 ? pilots : data).push(k);
  return { data, pilots };
}

const TWO_PI = 2 * Math.PI;
const mod2pi = (x: number) => ((x % TWO_PI) + TWO_PI) % TWO_PI;

export function modulateOfdm(data: Uint8Array, p: OfdmParams): Float64Array {
  const N = p.fftSize;
  const CP = p.cpSize;
  const bps = Math.log2(p.phases);
  const step = TWO_PI / p.phases;
  const enc = grayEnc(p.phases);
  const { data: dc, pilots } = ofdmCarriers(p);
  const bits = bytesToBits(data);
  const bposs = dc.length * bps;
  const nSyms = Math.max(1, Math.ceil(bits.length / bposs));
  while (bits.length < nSyms * bposs) bits.push(0);

  const cPhase = new Float64Array(N / 2 + 1);
  const out = new Float64Array(nSyms * (N + CP));
  let outIdx = 0;
  for (let symI = 0; symI < nSyms; symI++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const setCarrier = (k: number) => {
      re[k] = Math.cos(cPhase[k]);
      im[k] = Math.sin(cPhase[k]);
      re[N - k] = re[k];
      im[N - k] = -im[k]; // conjugate symmetry → real time signal
    };
    for (const k of pilots) setCarrier(k); // pilots stay at phase 0 (constant reference)
    const base = symI * bposs;
    dc.forEach((k, ci) => {
      let val = 0;
      for (let b = 0; b < bps; b++) val = (val << 1) | bits[base + ci * bps + b];
      cPhase[k] = mod2pi(cPhase[k] + enc[val] * step);
      setCarrier(k);
    });
    fftInPlace(re, im, true); // ifft → re holds the real time-domain symbol
    let mx = 0;
    for (let k = 0; k < N; k++) mx = Math.max(mx, Math.abs(re[k]));
    const scale = mx > 0 ? 0.9 / mx : 1;
    for (let k = 0; k < CP; k++) out[outIdx++] = re[N - CP + k] * scale; // cyclic prefix
    for (let k = 0; k < N; k++) out[outIdx++] = re[k] * scale;
  }
  return out;
}

export function demodulateOfdm(audio: Float64Array | Float32Array, p: OfdmParams): number[] {
  const N = p.fftSize;
  const CP = p.cpSize;
  const SL = N + CP;
  const bps = Math.log2(p.phases);
  const step = TWO_PI / p.phases;
  const dec = GRAY_DEC[p.phases];
  const { data: dc, pilots } = ofdmCarriers(p);
  const nSyms = Math.floor(audio.length / SL);
  const prev = new Float64Array(N / 2 + 1);
  const bits: number[] = [];
  for (let symI = 0; symI < nSyms; symI++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = audio[symI * SL + CP + k]; // skip the cyclic prefix
    fftInPlace(re, im, false);
    // common phase error from pilots
    const errors: number[] = [];
    for (const k of pilots) {
      const curr = Math.atan2(im[k], re[k]);
      let diff = mod2pi(curr - prev[k]);
      if (diff > Math.PI) diff -= TWO_PI;
      errors.push(diff);
      prev[k] = curr;
    }
    const corr = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    for (const k of dc) {
      const curr = Math.atan2(im[k], re[k]);
      const diff = mod2pi(curr - prev[k] - corr);
      const sym = dec[Math.round(diff / step) % p.phases];
      for (let j = bps - 1; j >= 0; j--) bits.push((sym >> j) & 1);
      prev[k] = curr - corr;
    }
  }
  return bits;
}
