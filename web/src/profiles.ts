// Device-quality presets — "realistic, slightly conservative" defaults for a
// range of media, each sized so the video fits the channel in real time.
//
// Note on physics: a 6 kHz cassette band caps 2-tone FSK at ~1–2 kbps, below
// any video codec's floor — so FSK can't carry real-time video and isn't a
// profile (it's still available in manual settings for data/experiments). OFDM
// (~7 kbps) and DPSK carry video; the lower the channel, the smaller the frame.

import { ModemSettings } from "./dsp/settings";

export interface DeviceProfile {
  name: string;
  description: string;
  settings: Partial<ModemSettings>;
  video: { width: number; height: number; fps: number };
}

export const PROFILES: DeviceProfile[] = [
  {
    name: "Clean line / CD / PC audio",
    description: "A clean digital connection (line-in/out, CD, sound card). The fastest setting — the biggest, sharpest picture.",
    settings: { method: "ofdm", ofdmFMin: 300, ofdmFMax: 6000, ofdmPhases: 8, reedSolomon: true, rsNsym: 8, constantPower: false },
    video: { width: 160, height: 120, fps: 12 },
  },
  {
    name: "Good cassette / tape deck",
    description: "A decent cassette deck and tape with light wow/flutter. A solid all-round default.",
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 6000, ofdmPhases: 4, reedSolomon: true, rsNsym: 16, constantPower: false },
    video: { width: 128, height: 96, fps: 8 },
  },
  {
    name: "Telephone line (narrow)",
    description: "A narrow, phone-quality voice channel (~500–3400 Hz). Smaller picture.",
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 3400, ofdmPhases: 4, reedSolomon: true, rsNsym: 16, constantPower: false },
    video: { width: 96, height: 72, fps: 6 },
  },
  {
    name: "Cheap cassette deck (AGC)",
    description: "A cheap cassette deck whose automatic volume keeps adjusting — uses a steady tone to stop it hunting. Smaller picture.",
    settings: { method: "dpsk", dpskBaud: 1800, dpskCarrier: 2600, dpskPhases: 4, constantPower: false, reedSolomon: true, rsNsym: 16 },
    video: { width: 96, height: 72, fps: 4 },
  },
  {
    name: "Robust (noisy / AGC)",
    description: "For the worst conditions: noisy, with automatic volume control. Heavy error correction. Tiny picture, most reliable.",
    settings: { method: "dpsk", dpskBaud: 1800, dpskCarrier: 2600, dpskPhases: 4, constantPower: false, reedSolomon: true, rsNsym: 24 },
    video: { width: 96, height: 64, fps: 4 },
  },
  {
    // The real-cassette profile: frequency-differential + timing recovery survive a
    // deck's speed wobble (wow/flutter), which defeats the plain profiles. Encode AND
    // decode must use this same profile (the wire format differs).
    name: "Cassette — wow-robust",
    description: "For recording to and from a real cassette deck — survives tape speed wobble (wow/flutter). Use this SAME profile to encode and to decode.",
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 6000, ofdmPhases: 2, ofdmPilotInterval: 8, reedSolomon: true, rsNsym: 24, constantPower: false, ofdmTrackTiming: true, ofdmFreqDiff: true },
    video: { width: 96, height: 72, fps: 6 },
  },
];

export function applyProfile(base: ModemSettings, p: DeviceProfile): ModemSettings {
  return { ...base, ...p.settings };
}
