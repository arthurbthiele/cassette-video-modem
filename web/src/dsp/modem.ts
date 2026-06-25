// Top-level modem: method dispatch, preamble, constant-power/pilot, the full
// encode-stream builder, and OFDM symbol-timing recovery.

import { ModemSettings, TRAIN_BYTES } from "./settings";
import { frameBlock } from "./framing";
import { modulateFsk, demodulateFsk } from "./fsk";
import { modulateFsk4, demodulateFsk4 } from "./fsk4";
import { modulateDpsk, demodulateDpsk } from "./dpsk";
import { modulateOfdm, demodulateOfdm } from "./ofdm";
import { butter, lfilter, applyPreEmphasis, applyDeEmphasis, addConstantPowerCarrier } from "./filters";

const fskP = (s: ModemSettings) => ({ sampleRate: s.sampleRate, baud: s.fskBaud, f0: s.fskF0, f1: s.fskF1 });
const fsk4P = (s: ModemSettings) => ({ sampleRate: s.sampleRate, baud: s.fsk4Baud, freqs: [s.fsk4F0, s.fsk4F1, s.fsk4F2, s.fsk4F3] as [number, number, number, number] });
const dpskP = (s: ModemSettings) => ({ sampleRate: s.sampleRate, baud: s.dpskBaud, carrier: s.dpskCarrier, phases: s.dpskPhases });
const ofdmP = (s: ModemSettings) => ({ sampleRate: s.sampleRate, fftSize: s.ofdmFftSize, cpSize: s.ofdmCpSize, fMin: s.ofdmFMin, fMax: s.ofdmFMax, pilotInterval: s.ofdmPilotInterval, phases: s.ofdmPhases });

export function modulate(data: Uint8Array, s: ModemSettings): Float64Array {
  let audio: Float64Array;
  switch (s.method) {
    case "fsk": audio = modulateFsk(data, fskP(s)); break;
    case "fsk4": audio = modulateFsk4(data, fsk4P(s)); break;
    case "dpsk": audio = modulateDpsk(data, dpskP(s)); break;
    case "ofdm": audio = modulateOfdm(data, ofdmP(s)); break;
  }
  if (s.preEmphasis) audio = applyPreEmphasis(audio, s.preEmphasisAlpha);
  return audio;
}

export function demodulateRaw(audio: Float64Array | Float32Array, s: ModemSettings): number[] {
  switch (s.method) {
    case "fsk": return demodulateFsk(audio, fskP(s));
    case "fsk4": return demodulateFsk4(audio, fsk4P(s));
    case "dpsk": return demodulateDpsk(audio, dpskP(s));
    case "ofdm": return demodulateOfdm(audio, ofdmP(s));
  }
}

/** Normalised high-pass cutoff that strips the constant-power carrier without
 * eating the low OFDM subcarriers (matches Python _carrier_strip_cut). */
export function carrierStripCut(s: ModemSettings): number {
  let hi = s.constantPowerCarrierHz * 1.3;
  if (s.method === "ofdm") hi = Math.min(hi, s.ofdmFMin - 50);
  return Math.max(0.002, hi / (s.sampleRate / 2));
}

export function preprocessForDecode(audio: Float64Array, s: ModemSettings): Float64Array {
  let a = audio;
  if (s.constantPower) {
    const cut = Math.min(0.95, carrierStripCut(s));
    if (cut > 0.002) {
      const { b, a: aco } = butter(4, cut, "high");
      a = lfilter(b, aco, a).y;
    }
  }
  if (s.preEmphasis) a = applyDeEmphasis(a, s.preEmphasisAlpha);
  return a;
}

/** Samples per symbol for the current method — the unit the data grid steps in. */
export function symbolSamples(s: ModemSettings): number {
  if (s.method === "fsk") return Math.max(1, Math.floor(s.sampleRate / s.fskBaud));
  if (s.method === "fsk4") return Math.max(1, Math.floor(s.sampleRate / s.fsk4Baud));
  if (s.method === "dpsk") return Math.max(1, Math.floor(s.sampleRate / s.dpskBaud));
  return s.ofdmFftSize + s.ofdmCpSize;
}

export function generatePreamble(s: ModemSettings): Float64Array {
  // Round the tone to a whole number of symbols so the data that follows lands
  // on the decoder's symbol grid (FSK/4-FSK/DPSK have no timing recovery; OFDM
  // does, but a multiple is harmless there). A deliberate improvement over the
  // Python reference, which didn't align and relied on RS to mop up.
  const sps = symbolSamples(s);
  const raw = Math.floor((s.sampleRate * s.preambleMs) / 1000);
  const n = Math.max(sps, Math.round(raw / sps) * sps);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.85 * Math.sin((2 * Math.PI * s.constantPowerCarrierHz * i) / s.sampleRate);
  return out;
}

export function addPilotTone(audio: Float64Array, s: ModemSettings): Float64Array {
  const out = new Float64Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] + s.pilotAmp * Math.sin((2 * Math.PI * s.pilotHz * i) / s.sampleRate);
  return out;
}

// ── OFDM symbol-timing recovery (cyclic-prefix correlation) ─────────────
export function ofdmTimingOffset(audio: Float64Array, s: ModemSettings, minConfidence = 0.45): number | null {
  const N = s.ofdmFftSize;
  const CP = s.ofdmCpSize;
  const SL = N + CP;
  if (audio.length < 3 * SL) return null;
  const cut = Math.min(0.95, Math.max(0.01, (s.ofdmFMin - 50) / (s.sampleRate / 2)));
  const { b, a } = butter(6, cut, "high");
  const hp = lfilter(b, a, audio).y;
  const nsym = Math.floor((hp.length - N - CP) / SL);
  if (nsym < 2) return null;
  if (energy(hp, 0, hp.length) < 1e-4 * hp.length) return null;
  const scores = new Float64Array(SL);
  for (let d = 0; d < SL; d++) {
    let num = 0;
    let den = 0;
    for (let k = 0; k < nsym; k++) {
      const base = d + k * SL;
      if (base + N + CP > hp.length) break;
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let m = 0; m < CP; m++) {
        const x = hp[base + m];
        const y = hp[base + N + m];
        ab += x * y;
        aa += x * x;
        bb += y * y;
      }
      num += Math.abs(ab);
      den += 0.5 * (aa + bb);
    }
    scores[d] = num / (den + 1e-12);
  }
  let bestD = 0;
  let best = -1;
  for (let d = 0; d < SL; d++) if (scores[d] > best) { best = scores[d]; bestD = d; }
  const sorted = Array.from(scores).sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1] + 1e-9;
  return best >= minConfidence && best >= 1.4 * median ? bestD : null;
}
function energy(a: Float64Array, start: number, end: number): number {
  let s = 0;
  for (let i = start; i < end; i++) s += a[i] * a[i];
  return s;
}

// ── full encode stream (mirror of Python encode_to_wav's signal build) ──
export function encodeStream(videoBytes: Uint8Array, s: ModemSettings): Float64Array {
  const bs = s.blockDataSize;
  const nBlocks = Math.ceil(videoBytes.length / bs) || 1;
  const parts: Uint8Array[] = [TRAIN_BYTES];
  for (let i = 0; i < nBlocks; i++) {
    const chunk = new Uint8Array(bs);
    chunk.set(videoBytes.subarray(i * bs, Math.min((i + 1) * bs, videoBytes.length)), 0);
    parts.push(frameBlock(chunk, i, s.reedSolomon, s.rsNsym));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const stream = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { stream.set(p, off); off += p.length; }

  const dataAudio = modulate(stream, s);
  const tone = generatePreamble(s);
  const tail = Math.floor(s.sampleRate * 0.2); // brief AGC-settle tail
  let audio: Float64Array = new Float64Array(tone.length + dataAudio.length + tail);
  audio.set(tone, 0);
  audio.set(dataAudio, tone.length);

  if (s.pilotTone) audio = addPilotTone(audio, s);
  if (s.constantPower) audio = addConstantPowerCarrier(audio, s.sampleRate, s.constantPowerCarrierHz, s.constantPowerTargetRms);
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  if (peak > 0) for (let i = 0; i < audio.length; i++) audio[i] = (audio[i] / peak) * 0.95;
  return audio;
}
