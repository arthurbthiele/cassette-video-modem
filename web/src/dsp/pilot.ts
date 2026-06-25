// Pilot-tone tachometer — defeats wow & flutter. The encoder adds a steady tone
// at pilot_hz (addPilotTone); on decode we recover that tone's phase, which
// wobbles with the tape's speed, and resample onto a uniform time base so the
// data is un-warped. Pilot phase is recovered by quadrature mixing (no giant
// FFT). Place pilot_hz in a quiet slot — below the data band for OFDM.

import { butter, filtfilt, notchBiquad } from "./filters";

export function addPilotToneTo(audio: Float64Array, sampleRate: number, pilotHz: number, amp: number): Float64Array {
  const out = new Float64Array(audio.length);
  const w = (2 * Math.PI * pilotHz) / sampleRate;
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] + amp * Math.sin(w * i);
  return out;
}

export function pilotResample(audio: Float32Array | Float64Array, sampleRate: number, pilotHz: number): Float32Array {
  const n = audio.length;
  const w = (2 * Math.PI * pilotHz) / sampleRate;

  // quadrature-mix to the pilot's baseband, low-pass to isolate it
  const I = new Float64Array(n);
  const Q = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * i);
    const sgn = Math.sin(w * i);
    I[i] = audio[i] * c;
    Q[i] = -audio[i] * sgn;
  }
  const { b: lb, a: la } = butter(4, Math.min(0.99, 60 / (sampleRate / 2)), "low");
  const Ilp = filtfilt(lb, la, I);
  const Qlp = filtfilt(lb, la, Q);

  // absolute pilot phase = nominal (w·i) + the slow drift from wow/flutter
  const sphase = new Float64Array(n);
  let prev = 0;
  let unwrapped = 0;
  for (let i = 0; i < n; i++) {
    const ang = Math.atan2(Qlp[i], Ilp[i]);
    let d = ang - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    unwrapped += d;
    prev = ang;
    sphase[i] = w * i + unwrapped;
  }

  // resample so the pilot phase advances at exactly w → data returns to uniform
  const out = new Float64Array(n);
  const target0 = sphase[0];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tgt = target0 + k * w;
    while (j < n - 2 && sphase[j + 1] < tgt) j++;
    const denom = sphase[j + 1] - sphase[j];
    let pos = denom > 1e-12 ? j + (tgt - sphase[j]) / denom : j;
    pos = Math.max(0, Math.min(n - 1, pos));
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out[k] = i0 + 1 < n ? audio[i0] * (1 - frac) + audio[i0 + 1] * frac : audio[i0];
  }

  // notch the pilot back out (zero-phase, so OFDM symbol timing is unaffected)
  const { b: nb, a: na } = notchBiquad(pilotHz, sampleRate, 12);
  const cleaned = filtfilt(nb, na, out);
  return Float32Array.from(cleaned);
}
