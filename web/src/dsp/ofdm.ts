// OFDM (constant-amplitude subcarriers, differential phase, pilot carriers for
// common-phase tracking) — ported from Python.

import { bytesToBits } from "./bits";
import { GRAY_DEC, grayEnc } from "./gray";
import { fftInPlace } from "./fft";
import { butter, lfilter } from "./filters";

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

// Streaming OFDM demodulator with wow/flutter timing correction. After a one-time
// cyclic-prefix lock, each symbol's differential pilot phases are fit to a line
// a + b·k: the intercept a is the common phase error (as before), and the slope b
// is the inter-symbol timing drift a wobbling tape induces (a phase ramp across
// carriers). Removing the slope — not just the mean the original decoder removed —
// is what keeps the data carriers clean as the tape speed wanders. Holds the
// differential phase reference and read position across push() calls.
export class OfdmStreamDemod {
  private N: number; private CP: number; private SL: number;
  private bps: number; private step: number; private dec: number[];
  private dc: number[]; private pilots: number[];
  private fMin: number; private sr: number;
  private buf: Float64Array = new Float64Array(0);
  private pos = 0;
  private prev: Float64Array;
  locked = false;

  constructor(p: OfdmParams) {
    this.N = p.fftSize; this.CP = p.cpSize; this.SL = this.N + this.CP;
    this.bps = Math.log2(p.phases); this.step = TWO_PI / p.phases;
    this.dec = GRAY_DEC[p.phases];
    this.fMin = p.fMin; this.sr = p.sampleRate;
    const c = ofdmCarriers(p); this.dc = c.data; this.pilots = c.pilots;
    this.prev = new Float64Array(this.N / 2 + 1);
  }

  // high-pass below the OFDM band — used only for the lock decision, to strip the
  // out-of-band preamble tone / AGC carrier (which correlate flatly and would
  // otherwise drown the data's cyclic-prefix peak). Decoding uses the raw signal.
  private hpForLock(buf: Float64Array): Float64Array {
    const cut = Math.min(0.95, Math.max(0.01, (this.fMin - 50) / (this.sr / 2)));
    const { b, a } = butter(6, cut, "high");
    return lfilter(b, a, buf).y;
  }

  // initial lock: peak CP-correlation offset over the first few symbols, gated
  // on peakiness so the preamble tone / AGC carrier can't trigger a false lock
  private tryLock(): boolean {
    const SL = this.SL, N = this.N, CP = this.CP;
    if (this.buf.length < 3 * SL) return false;
    const nsym = Math.floor((this.buf.length - N - CP) / SL);
    if (nsym < 2) return false;
    const hp = this.hpForLock(this.buf); // strip out-of-band tone so the data peak shows
    const scores = new Float64Array(SL);
    for (let d = 0; d < SL; d++) {
      let num = 0, den = 0;
      for (let k = 0; k < nsym; k++) {
        const base = d + k * SL;
        if (base + N + CP > hp.length) break;
        let ab = 0, aa = 0, bb = 0;
        for (let m = 0; m < CP; m++) {
          const x = hp[base + m], y = hp[base + N + m];
          ab += x * y; aa += x * x; bb += y * y;
        }
        num += Math.abs(ab); den += 0.5 * (aa + bb);
      }
      scores[d] = num / (den + 1e-12);
    }
    let bestD = 0, best = -1;
    for (let d = 0; d < SL; d++) if (scores[d] > best) { best = scores[d]; bestD = d; }
    const sorted = Array.from(scores).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] + 1e-9;
    if (best >= 0.45 && best >= 1.4 * median) { this.pos = bestD; this.locked = true; return true; }
    return false;
  }

  private decodeSymbolAt(start: number, out: number[]): void {
    const N = this.N;
    const re = new Float64Array(N); const im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = this.buf[start + this.CP + k];
    fftInPlace(re, im, false);
    // Least-squares fit of the differential pilot phases to a line a + b·k:
    // a = common phase error, b = inter-symbol timing drift (the wow term).
    let n = 0, sk = 0, sd = 0, skk = 0, skd = 0;
    for (const k of this.pilots) {
      const curr = Math.atan2(im[k], re[k]);
      let diff = mod2pi(curr - this.prev[k]);
      if (diff > Math.PI) diff -= TWO_PI;
      n++; sk += k; sd += diff; skk += k * k; skd += k * diff;
      this.prev[k] = curr;
    }
    const denom = n * skk - sk * sk;
    const b = n >= 2 && Math.abs(denom) > 1e-9 ? (n * skd - sk * sd) / denom : 0;
    const a = n ? (sd - b * sk) / n : 0;
    for (const k of this.dc) {
      const curr = Math.atan2(im[k], re[k]);
      const corr = a + b * k; // remove both common phase and the timing-drift ramp
      const diff = mod2pi(curr - this.prev[k] - corr);
      const sym = this.dec[Math.round(diff / this.step) % this.dec.length];
      for (let j = this.bps - 1; j >= 0; j--) out.push((sym >> j) & 1);
      this.prev[k] = curr - corr;
    }
  }

  push(audio: Float64Array): number[] {
    if (this.buf.length === 0) this.buf = audio.slice();
    else { const n = new Float64Array(this.buf.length + audio.length); n.set(this.buf); n.set(audio, this.buf.length); this.buf = n; }
    const out: number[] = [];
    if (!this.locked && !this.tryLock()) return out;
    const SL = this.SL;
    while (this.pos + SL + 1 <= this.buf.length && this.pos >= 0) {
      this.decodeSymbolAt(this.pos, out);
      this.pos += SL;
    }
    const keep = this.pos - 2 * SL; // retain a little history behind the cursor
    if (keep > SL) { this.buf = this.buf.slice(keep); this.pos -= keep; }
    return out;
  }
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
