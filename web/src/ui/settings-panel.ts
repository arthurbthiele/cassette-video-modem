// Full modem settings panel — every parameter, bound to a ModemSettings object.
// Shared by the encoder and decoder so both expose the same configuration and
// can be matched exactly (or paired via a saved .cassette config).

import { ModemSettings, Method } from "../dsp/settings";
import { el } from "./dom";

type Num = "sampleRate" | "fskBaud" | "fskF0" | "fskF1" | "fsk4Baud" | "fsk4F0" | "fsk4F1" | "fsk4F2" | "fsk4F3" |
  "dpskBaud" | "dpskCarrier" | "dpskPhases" | "ofdmFftSize" | "ofdmCpSize" | "ofdmFMin" | "ofdmFMax" |
  "ofdmPilotInterval" | "ofdmPhases" | "constantPowerCarrierHz" | "rsNsym" | "blockDataSize";
type Bool = "constantPower" | "preEmphasis" | "reedSolomon";

export function settingsPanel(s: ModemSettings, onChange: () => void, opts: { hideSampleRate?: boolean } = {}): HTMLElement {
  const root = el("div");

  const rebuild = () => {
    root.innerHTML = "";

    const methodRow = el("div", { className: "row" }, [el("label", { textContent: "Modulation" })]);
    const methodSel = el("select") as HTMLSelectElement;
    for (const m of ["ofdm", "dpsk", "fsk4", "fsk"]) methodSel.append(el("option", { value: m, textContent: m.toUpperCase(), selected: s.method === m }));
    methodSel.onchange = () => { s.method = methodSel.value as Method; onChange(); rebuild(); };
    methodRow.append(methodSel);
    root.append(methodRow);

    const num = (label: string, key: Num, step = 1) => {
      const i = el("input", { type: "number", value: String(s[key]), step: String(step) }) as HTMLInputElement;
      i.style.width = "90px";
      i.oninput = () => { (s[key] as number) = parseFloat(i.value) || 0; onChange(); };
      return el("div", { className: "row" }, [el("label", { textContent: label }), i]);
    };
    const check = (label: string, key: Bool) => {
      const c = el("input", { type: "checkbox", checked: s[key] }) as HTMLInputElement;
      c.onchange = () => { (s[key] as boolean) = c.checked; onChange(); rebuild(); };
      return el("div", { className: "row" }, [el("label", { textContent: label }), c]);
    };
    if (!opts.hideSampleRate) {
      const srSel = el("select") as HTMLSelectElement;
      for (const r of [44100, 48000]) srSel.append(el("option", { value: String(r), textContent: String(r), selected: s.sampleRate === r }));
      srSel.onchange = () => { s.sampleRate = parseInt(srSel.value); onChange(); };
      root.append(el("div", { className: "row" }, [el("label", { textContent: "Sample rate" }), srSel]));
    }

    if (s.method === "fsk") root.append(num("FSK baud", "fskBaud", 100), num("FSK freq 0 (Hz)", "fskF0", 100), num("FSK freq 1 (Hz)", "fskF1", 100));
    if (s.method === "fsk4") root.append(num("4-FSK baud", "fsk4Baud", 100), num("Freq 0", "fsk4F0", 100), num("Freq 1", "fsk4F1", 100), num("Freq 2", "fsk4F2", 100), num("Freq 3", "fsk4F3", 100));
    if (s.method === "dpsk") {
      root.append(num("DPSK baud", "dpskBaud", 100), num("Carrier (Hz)", "dpskCarrier", 100));
      root.append(phasesRow("DPSK phases", s, "dpskPhases", onChange));
    }
    if (s.method === "ofdm") {
      root.append(num("FFT size", "ofdmFftSize", 128), num("Cyclic prefix", "ofdmCpSize", 16), num("Min freq (Hz)", "ofdmFMin", 50), num("Max freq (Hz)", "ofdmFMax", 100), num("Pilot interval", "ofdmPilotInterval", 1));
      root.append(phasesRow("OFDM phases/carrier", s, "ofdmPhases", onChange));
    }

    root.append(el("hr", { style: "border-color:#2c3038" }));
    root.append(check("Constant-power carrier (AGC)", "constantPower"));
    if (s.constantPower) root.append(num("  Carrier freq (Hz)", "constantPowerCarrierHz", 10));
    root.append(check("Pre-emphasis", "preEmphasis"));
    root.append(check("Reed-Solomon", "reedSolomon"));
    if (s.reedSolomon) root.append(num("  Parity symbols", "rsNsym", 2));
    root.append(num("Block size (bytes)", "blockDataSize", 32));
  };

  rebuild();
  return root;
}

function phasesRow(label: string, s: ModemSettings, key: "dpskPhases" | "ofdmPhases", onChange: () => void): HTMLElement {
  const row = el("div", { className: "row" }, [el("label", { textContent: label })]);
  for (const v of [2, 4, 8]) {
    const id = `${key}-${v}`;
    const r = el("input", { type: "radio", name: key, id, value: String(v), checked: s[key] === v }) as HTMLInputElement;
    r.onchange = () => { (s[key] as number) = v; onChange(); };
    row.append(r, el("label", { htmlFor: id, textContent: String(v) }));
  }
  return row;
}
