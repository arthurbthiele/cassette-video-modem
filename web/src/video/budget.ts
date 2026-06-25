// Real-time bitrate budgeting — the heart of "1 second of audio carries ~1
// second of video". The video encoder's target bitrate is set to what the modem
// can actually carry per second, so playback keeps pace with the tape.

import { ModemSettings } from "../dsp/settings";
import { blockWireSize } from "../dsp/framing";
import { ofdmCarriers } from "../dsp/ofdm";

/** Raw channel bits/sec before framing overhead (matches Python calculate_bitrate). */
export function rawBitsPerSec(s: ModemSettings): number {
  switch (s.method) {
    case "fsk": return s.fskBaud;
    case "fsk4": return s.fsk4Baud * 2;
    case "dpsk": return Math.floor(s.dpskBaud * Math.log2(s.dpskPhases));
    case "ofdm": {
      const { data } = ofdmCarriers({ sampleRate: s.sampleRate, fftSize: s.ofdmFftSize, cpSize: s.ofdmCpSize, fMin: s.ofdmFMin, fMax: s.ofdmFMax, pilotInterval: s.ofdmPilotInterval, phases: s.ofdmPhases });
      return Math.floor((data.length * Math.log2(s.ofdmPhases) * s.sampleRate) / (s.ofdmFftSize + s.ofdmCpSize));
    }
  }
}

/** Net usable bits/sec after framing + Reed-Solomon overhead. */
export function netBitsPerSec(s: ModemSettings): number {
  const eff = s.blockDataSize / blockWireSize(s.blockDataSize, s.reedSolomon, s.rsNsym);
  return Math.floor(rawBitsPerSec(s) * eff);
}

export interface BudgetOptions {
  /** Fraction of net throughput given to video (leaves headroom for the
   * per-frame container overhead and an optional audio track). */
  fillFactor?: number;
  /** Reserve this many bits/sec for an audio track. */
  audioBitsPerSec?: number;
}

/** Target bits/sec to hand the video encoder so the stream fits the channel. */
export function videoBitrateBudget(s: ModemSettings, opts: BudgetOptions = {}): number {
  const fill = opts.fillFactor ?? 0.9;
  const audio = opts.audioBitsPerSec ?? 0;
  return Math.max(1000, Math.floor(netBitsPerSec(s) * fill) - audio);
}

/** KB (1024) per second of net throughput — handy for UI meters. */
export function netKBytesPerSec(s: ModemSettings): number {
  return netBitsPerSec(s) / 8 / 1024;
}
