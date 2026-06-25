// Software model of a cheap cassette deck's channel, for testing robustness
// without a physical tape: band-limiting, tape hiss, oxide dropouts, AGC, and
// wow & flutter (pitch wobble). Ported from the Python cassette_channel.py.
// A research/validation tool — not part of the encode/decode path.

import { butter, lfilter } from "./filters";

export interface ChannelOptions {
  sampleRate: number;
  bandLowHz?: number;
  bandHighHz?: number;
  snrDb?: number;
  dropoutPerSec?: number;
  dropoutMsMean?: number;
  dropoutDepth?: number;
  agc?: boolean;
  agcTargetRms?: number;
  agcAttackMs?: number;
  agcReleaseMs?: number;
  wowDepth?: number; // fractional speed deviation
  wowRateHz?: number;
  flutterDepth?: number;
  flutterRateHz?: number;
  seed?: number;
}

// deterministic PRNG (mulberry32) so runs are reproducible
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(r: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function simulateChannel(audio: Float32Array, o: ChannelOptions): Float32Array {
  const sr = o.sampleRate;
  const r = rng(o.seed ?? 1);
  let x: Float64Array = Float64Array.from(audio);

  // wow & flutter — resample on a wobbling time base (zero-mean, so bounded)
  const wowD = o.wowDepth ?? 0, flD = o.flutterDepth ?? 0;
  if (wowD > 0 || flD > 0) {
    const wowR = o.wowRateHz ?? 0.7, flR = o.flutterRateHz ?? 11;
    const ph1 = r() * 2 * Math.PI, ph2 = r() * 2 * Math.PI;
    const warp = new Float64Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) {
      const dev = wowD * Math.sin((2 * Math.PI * wowR * i) / sr + ph1) + flD * Math.sin((2 * Math.PI * flR * i) / sr + ph2);
      acc += 1 + dev;
      warp[i] = acc;
    }
    const start = warp[0];
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const pos = Math.max(0, Math.min(x.length - 1, warp[i] - start));
      const i0 = Math.floor(pos), frac = pos - i0;
      out[i] = i0 + 1 < x.length ? x[i0] * (1 - frac) + x[i0 + 1] * frac : x[i0];
    }
    x = out;
  }

  // band-limit (highpass at low edge, then lowpass at high edge)
  const nyq = sr / 2;
  const lo = o.bandLowHz ?? 300, hi = o.bandHighHz ?? 6000;
  if (lo > 20) { const { b, a } = butter(4, Math.min(0.99, lo / nyq), "high"); x = lfilter(b, a, x).y; }
  if (hi < nyq - 20) { const { b, a } = butter(4, Math.min(0.99, hi / nyq), "low"); x = lfilter(b, a, x).y; }

  // oxide dropouts — brief smooth level dips
  const dps = o.dropoutPerSec ?? 0;
  if (dps > 0) {
    const depth = o.dropoutDepth ?? 0.15, msMean = o.dropoutMsMean ?? 8;
    const nDrop = Math.round((dps * x.length) / sr);
    for (let d = 0; d < nDrop; d++) {
      const startI = Math.floor(r() * x.length);
      const dur = Math.max(1, Math.floor(-Math.log(1 - r()) * msMean * 1e-3 * sr));
      const end = Math.min(x.length, startI + dur);
      for (let i = startI; i < end; i++) {
        const w = end - startI > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - startI)) / (end - startI - 1)) : 1;
        x[i] *= 1 - (1 - depth) * w;
      }
    }
  }

  // AGC — envelope-following gain (pumps when level changes)
  if (o.agc) {
    const target = o.agcTargetRms ?? 0.25;
    const atk = Math.exp(-1 / ((o.agcAttackMs ?? 5) * 1e-3 * sr));
    const rel = Math.exp(-1 / ((o.agcReleaseMs ?? 300) * 1e-3 * sr));
    let env = 0;
    for (let i = 0; i < x.length; i++) {
      const aMag = Math.abs(x[i]);
      const c = aMag > env ? atk : rel;
      env = c * env + (1 - c) * aMag;
      x[i] = (x[i] * target) / (env + 1e-6);
    }
  }

  // tape hiss to a target SNR
  if (o.snrDb !== undefined) {
    let sigPow = 0;
    for (let i = 0; i < x.length; i++) sigPow += x[i] * x[i];
    sigPow = sigPow / x.length + 1e-12;
    const noisePow = sigPow / Math.pow(10, o.snrDb / 10);
    const sd = Math.sqrt(noisePow);
    for (let i = 0; i < x.length; i++) x[i] += sd * gaussian(r);
  }

  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const out = new Float32Array(x.length);
  if (peak > 1e-9) for (let i = 0; i < x.length; i++) out[i] = (x[i] / peak) * 0.95;
  return out;
}
