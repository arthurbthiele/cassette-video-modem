// Modem settings — mirrors the Python ModemSettings dataclass (field names
// camelCased). Encoder and decoder must agree on every value.

export type Method = "fsk" | "fsk4" | "dpsk" | "ofdm";

export interface ModemSettings {
  sampleRate: number;
  method: Method;

  fskBaud: number;
  fskF0: number;
  fskF1: number;

  fsk4Baud: number;
  fsk4F0: number;
  fsk4F1: number;
  fsk4F2: number;
  fsk4F3: number;

  dpskBaud: number;
  dpskCarrier: number;
  dpskPhases: number;

  ofdmFftSize: number;
  ofdmCpSize: number;
  ofdmFMin: number;
  ofdmFMax: number;
  ofdmPilotInterval: number;
  ofdmPhases: number;
  ofdmTrackTiming: boolean; // continuous timing recovery for tape speed offset (off = bit-exact legacy decode)
  ofdmFreqDiff: boolean; // differential across frequency (adjacent carriers) instead of time → wow-robust

  constantPower: boolean;
  constantPowerCarrierHz: number;
  constantPowerTargetRms: number;

  preEmphasis: boolean;
  preEmphasisAlpha: number;

  pilotTone: boolean;
  pilotHz: number;
  pilotAmp: number;

  reedSolomon: boolean;
  rsNsym: number;

  blockDataSize: number;
  preambleMs: number;
}

export const DEFAULT_SETTINGS: ModemSettings = {
  sampleRate: 44100,
  method: "ofdm",
  fskBaud: 1200, fskF0: 1800, fskF1: 3600,
  fsk4Baud: 1200, fsk4F0: 1200, fsk4F1: 2400, fsk4F2: 3600, fsk4F3: 4800,
  dpskBaud: 1500, dpskCarrier: 3000, dpskPhases: 4,
  ofdmFftSize: 512, ofdmCpSize: 64, ofdmFMin: 500, ofdmFMax: 6000,
  ofdmPilotInterval: 8, ofdmPhases: 4, ofdmTrackTiming: false, ofdmFreqDiff: false,
  constantPower: false, constantPowerCarrierHz: 300, constantPowerTargetRms: 0.7,
  preEmphasis: false, preEmphasisAlpha: 0.85,
  pilotTone: false, pilotHz: 700, pilotAmp: 0.18,
  reedSolomon: true, rsNsym: 16,
  blockDataSize: 256, preambleMs: 400,
};

// Bytes modulated ahead of the payload (OFDM timing lock-on + chain-entry
// absorption). Matches Python TRAIN_BYTES.
export const TRAIN_BYTES: Uint8Array = (() => {
  const b = new Uint8Array(128);
  for (let i = 0; i < 64; i++) { b[i * 2] = 0xaa; b[i * 2 + 1] = 0x55; }
  return b;
})();

export const METADATA_SEQ = 0xfffffffe;
