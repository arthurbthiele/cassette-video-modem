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
  trackTiming?: boolean; // continuous timing recovery (tape speed offset); off = legacy fixed-step decode
  freqDiff?: boolean;    // differential across frequency (adjacent carriers) instead of across time
}

// Ordered carrier plan: every carrier kLo..kHi in frequency order, flagged pilot or
// data. Needed by the frequency-differential path, which walks carriers contiguously.
export function ofdmCarrierPlan(p: OfdmParams): { k: number; pilot: boolean }[] {
  const res = p.sampleRate / p.fftSize;
  const kLo = Math.max(1, Math.ceil(p.fMin / res));
  const kHi = Math.min(p.fftSize / 2 - 1, Math.floor(p.fMax / res));
  const plan: { k: number; pilot: boolean }[] = [];
  for (let k = kLo; k <= kHi; k++) plan.push({ k, pilot: (k - kLo) % p.pilotInterval === 0 });
  return plan;
}

const wrapPi = (x: number) => { let y = ((x % TWO_PI) + TWO_PI) % TWO_PI; if (y > Math.PI) y -= TWO_PI; return y; };

// Estimate the per-carrier-step phase ramp b (= 2π·timingOffset/N) from the pilots'
// absolute phases this symbol, robust to wrapping (unwrap along k, least-squares slope).
function pilotRamp(re: Float64Array, im: Float64Array, pilots: number[]): number {
  if (pilots.length < 2) return 0;
  let acc = Math.atan2(im[pilots[0]], re[pilots[0]]);
  let prev = acc, sk = 0, sy = 0, skk = 0, sky = 0, n = 0;
  for (let i = 0; i < pilots.length; i++) {
    const k = pilots[i];
    const cur = Math.atan2(im[k], re[k]);
    if (i > 0) { acc += wrapPi(cur - prev); }
    prev = cur;
    sk += k; sy += acc; skk += k * k; sky += k * acc; n++;
  }
  const denom = n * skk - sk * sk;
  return Math.abs(denom) > 1e-9 ? (n * sky - sk * sy) / denom : 0;
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

  const plan = p.freqDiff ? ofdmCarrierPlan(p) : [];
  const cPhase = new Float64Array(N / 2 + 1);
  const out = new Float64Array(nSyms * (N + CP));
  let outIdx = 0;
  for (let symI = 0; symI < nSyms; symI++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const phase = new Float64Array(N / 2 + 1);
    const setCarrier = (k: number) => {
      re[k] = Math.cos(phase[k]);
      im[k] = Math.sin(phase[k]);
      re[N - k] = re[k];
      im[N - k] = -im[k]; // conjugate symmetry → real time signal
    };
    const base = symI * bposs;
    if (p.freqDiff) {
      // Differential across frequency: walk carriers in order; each data carrier's
      // phase steps from its neighbour by enc[val]; pilots reset the chain to 0.
      let running = 0, ci = 0;
      for (const { k, pilot } of plan) {
        if (pilot) { phase[k] = 0; running = 0; }
        else {
          let val = 0;
          for (let b = 0; b < bps; b++) val = (val << 1) | bits[base + ci * bps + b];
          phase[k] = mod2pi(running + enc[val] * step);
          running = phase[k];
          ci++;
        }
        setCarrier(k);
      }
    } else {
      // Differential across time: phase accumulates per carrier across symbols.
      for (const k of pilots) { phase[k] = cPhase[k]; setCarrier(k); } // pilots stay at 0
      dc.forEach((k, ci) => {
        let val = 0;
        for (let b = 0; b < bps; b++) val = (val << 1) | bits[base + ci * bps + b];
        cPhase[k] = mod2pi(cPhase[k] + enc[val] * step);
        phase[k] = cPhase[k];
        setCarrier(k);
      });
    }
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
  // continuous timing recovery: fractional read cursor + tracked sample-rate ratio
  private ipF = 0;
  private rateEst = 1;
  private trackInit = false;
  private lockRate = 1; // rate estimate found at acquisition (seeds the tracker)
  private track: boolean;
  private freqDiff: boolean;
  private plan: { k: number; pilot: boolean }[];

  constructor(p: OfdmParams) {
    this.N = p.fftSize; this.CP = p.cpSize; this.SL = this.N + this.CP;
    this.bps = Math.log2(p.phases); this.step = TWO_PI / p.phases;
    this.dec = GRAY_DEC[p.phases];
    this.fMin = p.fMin; this.sr = p.sampleRate;
    const c = ofdmCarriers(p); this.dc = c.data; this.pilots = c.pilots;
    this.prev = new Float64Array(this.N / 2 + 1);
    this.track = !!p.trackTiming;
    this.freqDiff = !!p.freqDiff;
    this.plan = ofdmCarrierPlan(p);
  }

  // high-pass below the OFDM band — used only for the lock decision, to strip the
  // out-of-band preamble tone / AGC carrier (which correlate flatly and would
  // otherwise drown the data's cyclic-prefix peak). Decoding uses the raw signal.
  private hpForLock(buf: Float64Array): Float64Array {
    const cut = Math.min(0.95, Math.max(0.01, (this.fMin - 50) / (this.sr / 2)));
    const { b, a } = butter(6, cut, "high");
    return lfilter(b, a, buf).y;
  }

  // Acquisition: legacy fixed-rate lock for the bit-exact path; rate-aware lock when
  // timing recovery is on (a tape's speed offset misaligns the fixed-stride average,
  // which would otherwise fail to lock at unlucky rates).
  private tryLock(): boolean {
    return this.track ? this.tryLockRate() : this.tryLockFixed();
  }

  // Rate-aware lock: coarse-search the symbol length (= N·rate + CP) AND the offset,
  // correlating the CP with its tail at the matching lag. Seeds rateEst from the
  // winning rate so the fine tracker starts already close.
  private tryLockRate(): boolean {
    const N = this.N, CP = this.CP, SL = this.SL;
    if (this.buf.length < 4 * SL) return false;
    const hp = this.hpForLock(this.buf);
    let best = -1, bestD = 0, bestL = N, sum = 0, cnt = 0;
    for (let L = Math.round(N * 0.95); L <= Math.round(N * 1.05); L += 2) {
      const SLc = L + CP;
      const nsym = Math.min(6, Math.floor((hp.length - L - CP) / SLc));
      if (nsym < 3) continue;
      for (let d = 0; d < SLc; d += 2) {
        let num = 0, den = 0;
        for (let s = 0; s < nsym; s++) {
          const base = d + s * SLc;
          let ab = 0, aa = 0, bb = 0;
          for (let m = 0; m < CP; m++) { const x = hp[base + m], y = hp[base + L + m]; ab += x * y; aa += x * x; bb += y * y; }
          num += Math.abs(ab); den += 0.5 * (aa + bb);
        }
        const sc = num / (den + 1e-12);
        sum += sc; cnt++;
        if (sc > best) { best = sc; bestD = d; bestL = L; }
      }
    }
    const mean = sum / Math.max(1, cnt);
    if (best >= 0.45 && best >= 1.5 * mean) { this.pos = bestD; this.lockRate = bestL / N; this.locked = true; return true; }
    return false;
  }

  // initial lock: peak CP-correlation offset over the first few symbols, gated
  // on peakiness so the preamble tone / AGC carrier can't trigger a false lock
  private tryLockFixed(): boolean {
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

  // Linear interpolation into the sample buffer at a fractional index — the
  // resampler's kernel. Lets us read a symbol back at *nominal* spacing from a
  // tape that recorded it at a slightly different (and wandering) rate.
  private interp(x: number): number {
    if (x < 0) return 0;
    const j = Math.floor(x);
    if (j + 1 >= this.buf.length) return this.buf[this.buf.length - 1] ?? 0;
    const f = x - j;
    return this.buf[j] * (1 - f) + this.buf[j + 1] * f;
  }

  // Normalised correlation between a window at `s` and one at `s+lag` (both `win`
  // long), read through the interpolator. The cyclic prefix is a copy of the
  // symbol tail, so at the symbol start this peaks when `lag` equals the symbol's
  // *received* N-length — which under tape speed error is N·rate, not N. That's
  // how we read the rate straight off the signal, with no phase-wrap limit.
  private cpCorrAt(s: number, lag: number, win: number): number {
    let ab = 0, aa = 0, bb = 0;
    for (let m = 0; m < win; m++) {
      const x = this.interp(s + m), y = this.interp(s + lag + m);
      ab += x * y; aa += x * x; bb += y * y;
    }
    return Math.abs(ab) / (Math.sqrt(aa * bb) + 1e-12);
  }

  private decodeResampledAt(ip: number, rate: number, out: number[]): number {
    const N = this.N;
    const re = new Float64Array(N); const im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = this.interp(ip + (this.CP + k) * rate); // resample the data part to nominal rate
    fftInPlace(re, im, false);
    if (this.freqDiff) {
      // Differential across frequency: each data carrier is decoded against its
      // neighbour within THIS symbol, so inter-symbol wow can't accumulate. The
      // pilots give the per-step ramp b (= timing offset) to subtract.
      const b = pilotRamp(re, im, this.pilots);
      for (const { k, pilot } of this.plan) {
        if (pilot) continue;
        const d = wrapPi(Math.atan2(im[k], re[k]) - Math.atan2(im[k - 1], re[k - 1]) - b);
        const sym = this.dec[((Math.round(d / this.step) % this.dec.length) + this.dec.length) % this.dec.length];
        for (let j = this.bps - 1; j >= 0; j--) out.push((sym >> j) & 1);
      }
      return b; // ramp doubles as the timing-drift signal for the tracker
    }
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
    return b; // residual inter-symbol timing slope → fine rate-tracking signal
  }

  push(audio: Float64Array): number[] {
    if (this.buf.length === 0) this.buf = audio.slice();
    else { const n = new Float64Array(this.buf.length + audio.length); n.set(this.buf); n.set(audio, this.buf.length); this.buf = n; }
    const out: number[] = [];
    // While unlocked, keep only a recent window. Otherwise a signal that never
    // locks (wrong sample rate, silence, noise) grows buf without bound and
    // tryLock rescans all of it every push → O(n²) → the page freezes/crashes.
    if (!this.locked && this.buf.length > 120 * this.SL) this.buf = this.buf.slice(this.buf.length - 80 * this.SL);
    if (!this.locked && !this.tryLock()) return out;
    const SL = this.SL, N = this.N, CP = this.CP, W = 10;
    if (!this.track) {
      // Legacy fixed-step decode (bit-exact, validated against Python). Decoding at
      // rate 1 / integer positions makes decodeResampledAt identical to the original.
      while (this.pos + SL + 1 <= this.buf.length && this.pos >= 0) {
        this.decodeResampledAt(this.pos, 1, out);
        this.pos += SL;
      }
      const keepL = this.pos - 2 * SL;
      if (keepL > SL) { this.buf = this.buf.slice(keepL); this.pos -= keepL; }
      return out;
    }
    if (!this.trackInit) { this.ipF = this.pos; this.rateEst = this.lockRate; this.trackInit = true; }
    // Per symbol: read the local rate off the cyclic prefix (lag search + parabolic
    // sub-sample peak), smooth it into rateEst (tracks constant offset + slow wow),
    // re-centre the symbol start, then decode the symbol resampled to nominal rate.
    while (this.ipF >= W && this.ipF + (N + CP) * this.rateEst + N * 0.05 + 2 <= this.buf.length) {
      const win = Math.max(16, Math.round(CP * this.rateEst));
      const lo = Math.round(N * this.rateEst * 0.96), hi = Math.round(N * this.rateEst * 1.04);
      let bestL = Math.round(N * this.rateEst), bestC = -1;
      for (let L = lo; L <= hi; L++) { const c = this.cpCorrAt(this.ipF, L, win); if (c > bestC) { bestC = c; bestL = L; } }
      const cm = this.cpCorrAt(this.ipF, bestL - 1, win), cpc = this.cpCorrAt(this.ipF, bestL + 1, win);
      const den = cm - 2 * bestC + cpc;
      const sub = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (cm - cpc) / den)) : 0;
      this.rateEst = Math.min(1.05, Math.max(0.95, this.rateEst + 0.5 * ((bestL + sub) / N - this.rateEst)));
      const lag = Math.round(N * this.rateEst);
      let bestD = 0, bd = -1;
      for (let d = -W; d <= W; d++) { const c = this.cpCorrAt(this.ipF + d, lag, win); if (c > bd) { bd = c; bestD = d; } }
      this.ipF += bestD;
      this.decodeResampledAt(this.ipF, this.rateEst, out);
      this.ipF += (N + CP) * this.rateEst;
      this.pos = Math.floor(this.ipF);
    }
    const keep = Math.floor(this.ipF) - 2 * SL - 16; // retain history behind the cursor for the search windows
    if (keep > SL) { this.buf = this.buf.slice(keep); this.ipF -= keep; this.pos -= keep; }
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
