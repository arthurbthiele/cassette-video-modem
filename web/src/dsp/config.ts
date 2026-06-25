// Shareable config files (.cassette JSON) — the deterministic way to pair an
// encoder and decoder, plus video params. Round-trips ModemSettings + video.

import { DEFAULT_SETTINGS, ModemSettings } from "./settings";

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  codec: string;
  gopSeconds: number;
}

export interface CassetteConfig {
  _type: "cassette-config";
  _version: 1;
  modem: ModemSettings;
  video: VideoConfig;
}

export function toConfigJSON(modem: ModemSettings, video: VideoConfig): string {
  const cfg: CassetteConfig = { _type: "cassette-config", _version: 1, modem, video };
  return JSON.stringify(cfg, null, 2);
}

/** Parse a .cassette config, tolerating missing fields (filled from defaults). */
export function fromConfigJSON(json: string): { modem: ModemSettings; video: Partial<VideoConfig> } {
  const obj = JSON.parse(json);
  const modemIn = (obj && obj.modem) || obj || {};
  const modem: ModemSettings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof ModemSettings)[]) {
    if (modemIn[k] !== undefined) (modem as any)[k] = modemIn[k];
  }
  return { modem, video: (obj && obj.video) || {} };
}

export function downloadConfig(modem: ModemSettings, video: VideoConfig, filename = "settings.cassette"): void {
  const blob = new Blob([toConfigJSON(modem, video)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
