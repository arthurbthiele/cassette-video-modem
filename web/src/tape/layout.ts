// Shared description of the tape-characterisation test signal — the single
// source of truth for BOTH the generator (renders this to a WAV) and the
// analyzer (knows what to expect in the played-back capture).
//
// The signal is a sequence of labelled segments, each preceded by a distinctive
// CHIRP MARKER. The analyzer locates segments by matched-filtering for the
// markers, so it survives tape start offset, overall speed error, and partial
// captures (it analyses whatever segments it finds, in order).

import { ModemSettings, DEFAULT_SETTINGS } from "../dsp/settings";

export const SR = 44100;

// Linear chirp marker before every segment (and one trailing). Distinctive under
// cross-correlation; the band stays within cassette reach so it survives the tape.
export const MARKER = { f0: 600, f1: 3800, durSec: 0.25, amp: 0.6 };

export type SegKind = "silence" | "tone" | "sweep" | "twotone" | "agc" | "method";

interface SegBase { id: string; label: string; kind: SegKind; }
export interface SilenceSeg extends SegBase { kind: "silence"; durSec: number; }
export interface ToneSeg extends SegBase { kind: "tone"; freq: number; durSec: number; amp: number; }
export interface SweepSeg extends SegBase { kind: "sweep"; f0: number; f1: number; durSec: number; amp: number; }
export interface TwoToneSeg extends SegBase { kind: "twotone"; f1: number; f2: number; durSec: number; amp: number; }
export interface AgcStep { amp: number; durSec: number; }
export interface AgcSeg extends SegBase { kind: "agc"; freq: number; steps: AgcStep[]; }
export interface MethodSeg extends SegBase { kind: "method"; settings: Partial<ModemSettings>; dataBytes: number; }
export type Segment = SilenceSeg | ToneSeg | SweepSeg | TwoToneSeg | AgcSeg | MethodSeg;

export const LAYOUT: Segment[] = [
  { id: "noise", label: "Noise floor (silence)", kind: "silence", durSec: 1.0 },
  { id: "ref1k", label: "Reference tone 1 kHz — wow/flutter + SNR", kind: "tone", freq: 1000, durSec: 3.0, amp: 0.5 },
  { id: "sweep", label: "Sweep 100 Hz → 8 kHz — frequency response", kind: "sweep", f0: 100, f1: 8000, durSec: 4.0, amp: 0.5 },
  { id: "twotone", label: "Two-tone 1.0 + 1.3 kHz — nonlinearity / IMD", kind: "twotone", f1: 1000, f2: 1300, durSec: 2.0, amp: 0.3 },
  // AGC probe: a steady tone whose level steps loud↔soft. A deck with AGC pulls the
  // soft steps back up (and pumps noise); the analyzer compares captured vs known
  // level per step to recover the gain curve + attack/release.
  { id: "agc", label: "Level steps — AGC tracking", kind: "agc", freq: 1500, steps: [
      { amp: 0.5, durSec: 0.8 }, { amp: 0.06, durSec: 0.8 }, { amp: 0.5, durSec: 0.8 }, { amp: 0.12, durSec: 0.8 },
      { amp: 0.5, durSec: 0.8 }, { amp: 0.25, durSec: 0.8 }, { amp: 0.5, durSec: 0.8 }, { amp: 0.03, durSec: 0.8 } ] },
  { id: "ofdm-narrow", label: "OFDM 500–3000 Hz · 2-phase", kind: "method", dataBytes: 1024,
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 3000, ofdmPhases: 2, ofdmFftSize: 512, ofdmCpSize: 64, ofdmPilotInterval: 8, reedSolomon: true, rsNsym: 16 } },
  { id: "ofdm-wide", label: "OFDM 500–6000 Hz · 4-phase", kind: "method", dataBytes: 1024,
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 6000, ofdmPhases: 4, ofdmFftSize: 512, ofdmCpSize: 64, ofdmPilotInterval: 8, reedSolomon: true, rsNsym: 16 } },
  { id: "dpsk", label: "DPSK 1500 baud @ 1800 Hz · 4-phase", kind: "method", dataBytes: 1024,
    settings: { method: "dpsk", dpskBaud: 1500, dpskCarrier: 1800, dpskPhases: 4, reedSolomon: true, rsNsym: 16 } },
  { id: "silence2", label: "Noise floor tail", kind: "silence", durSec: 1.0 },
];

/** Full modem settings for a method segment — generator and analyzer MUST agree. */
export function methodSettings(seg: MethodSeg): ModemSettings {
  return { ...DEFAULT_SETTINGS, sampleRate: SR, ...seg.settings };
}

/** Deterministic payload for a method segment (so the analyzer knows the truth). */
export function methodData(seg: MethodSeg): Uint8Array {
  const d = new Uint8Array(seg.dataBytes);
  for (let i = 0; i < d.length; i++) d[i] = (i * 37 + 11) % 256;
  return d;
}

/** Expected decoded block count for a method segment. */
export function expectedBlocks(seg: MethodSeg): number {
  return Math.ceil(seg.dataBytes / (seg.settings.blockDataSize ?? DEFAULT_SETTINGS.blockDataSize));
}
