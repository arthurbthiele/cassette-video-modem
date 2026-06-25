// Device-quality presets — "realistic, slightly conservative" defaults for a
// range of media, so a user can pick their target and get sane settings instead
// of tuning a dozen knobs. (skamlox's request.)

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
    description: "A clean digital channel (line-in/out, CD, soundcard). High-bitrate OFDM, light error correction, the biggest picture that still fits in real time.",
    settings: { method: "ofdm", ofdmFMin: 300, ofdmFMax: 6000, ofdmPhases: 8, reedSolomon: true, rsNsym: 8, constantPower: false },
    video: { width: 160, height: 120, fps: 10 },
  },
  {
    name: "Good cassette / tape deck",
    description: "A decent deck and tape with light wow/flutter. OFDM within the usable band, moderate error correction.",
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 6000, ofdmPhases: 4, reedSolomon: true, rsNsym: 16, constantPower: false },
    video: { width: 128, height: 96, fps: 8 },
  },
  {
    name: "Cheap cassette deck (AGC)",
    description: "A cheap deck with automatic gain control. Differential PSK + a constant-power carrier so the AGC stops hunting; strong error correction. Low bitrate → small picture.",
    settings: { method: "dpsk", dpskCarrier: 2400, dpskPhases: 4, constantPower: true, reedSolomon: true, rsNsym: 24 },
    video: { width: 96, height: 64, fps: 5 },
  },
  {
    name: "Hostile / very cheap deck",
    description: "Worst case: weak, noisy, AGC. The most robust mode — 2-tone FSK + constant-power carrier + heavy error correction. Tiny picture.",
    settings: { method: "fsk", fskBaud: 1200, constantPower: true, reedSolomon: true, rsNsym: 32 },
    video: { width: 64, height: 48, fps: 3 },
  },
  {
    name: "Telephone line (narrow)",
    description: "A narrow ~500–3400 Hz voice channel. OFDM squeezed into the band.",
    settings: { method: "ofdm", ofdmFMin: 500, ofdmFMax: 3400, reedSolomon: true, rsNsym: 16, constantPower: false },
    video: { width: 96, height: 64, fps: 6 },
  },
];

export function applyProfile(base: ModemSettings, p: DeviceProfile): ModemSettings {
  return { ...base, ...p.settings };
}
