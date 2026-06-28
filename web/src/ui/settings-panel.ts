// Full modem settings panel — every parameter, bound to a ModemSettings object.
// Shared by the encoder and decoder so both expose the same configuration and
// can be matched exactly (or paired via a saved .cassette config).

import { ModemSettings, Method } from "../dsp/settings";
import { el } from "./dom";

type Num = "sampleRate" | "fskBaud" | "fskF0" | "fskF1" | "fsk4Baud" | "fsk4F0" | "fsk4F1" | "fsk4F2" | "fsk4F3" |
  "dpskBaud" | "dpskCarrier" | "dpskPhases" | "ofdmFftSize" | "ofdmCpSize" | "ofdmFMin" | "ofdmFMax" |
  "ofdmPilotInterval" | "ofdmPhases" | "constantPowerCarrierHz" | "rsNsym" | "blockDataSize";
type Bool = "constantPower" | "preEmphasis" | "reedSolomon" | "ofdmTrackTiming" | "ofdmFreqDiff";

export function settingsPanel(s: ModemSettings, onChange: () => void, opts: { hideSampleRate?: boolean } = {}): HTMLElement {
  const root = el("div");

  const rebuild = () => {
    root.innerHTML = "";
    root.append(el("p", { className: "muted", style: "margin:0 0 8px", textContent: "Your profile already sets these — change them only to experiment. The encoder and decoder must use the same values, so save a .cassette to keep them matched. (Hover a label for what it does.)" }));

    const methodRow = el("div", { className: "row" }, [el("label", { textContent: "Modulation", title: "How the data rides in the audio. OFDM = fastest / biggest picture; DPSK = robust on cheap AGC decks; FSK / 4-FSK = most robust, but too slow to carry video (kept for data/experiments)." })]);
    const methodSel = el("select") as HTMLSelectElement;
    for (const m of ["ofdm", "dpsk", "fsk4", "fsk"]) methodSel.append(el("option", { value: m, textContent: m.toUpperCase(), selected: s.method === m }));
    methodSel.onchange = () => { s.method = methodSel.value as Method; onChange(); rebuild(); };
    methodRow.append(methodSel);
    root.append(methodRow);

    const num = (label: string, key: Num, _step = 1, tip = "") => {
      const i = el("input", { type: "number", value: String(s[key]), step: "any" }) as HTMLInputElement; // step="any" → no off-grid "invalid" bubble (e.g. DPSK baud/carrier)
      i.style.width = "90px";
      i.oninput = () => { (s[key] as number) = parseFloat(i.value) || 0; onChange(); };
      return el("div", { className: "row" }, [el("label", { textContent: label, title: tip }), i]);
    };
    const check = (label: string, key: Bool, tip = "") => {
      const c = el("input", { type: "checkbox", checked: s[key] }) as HTMLInputElement;
      c.onchange = () => { (s[key] as boolean) = c.checked; onChange(); rebuild(); };
      return el("div", { className: "row" }, [el("label", { textContent: label, title: tip }), c]);
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
      root.append(num("Speed (baud)", "dpskBaud", 100, "Symbols per second — the raw signalling rate."), num("Carrier (Hz)", "dpskCarrier", 100, "Centre frequency of the DPSK carrier."));
      root.append(phasesRow("Phases per carrier", s, "dpskPhases", onChange));
    }
    if (s.method === "ofdm") {
      root.append(
        num("FFT size", "ofdmFftSize", 128, "OFDM block size in samples. Larger = more subcarriers / finer frequency steps."),
        num("Cyclic prefix", "ofdmCpSize", 16, "Guard samples copied before each symbol — absorbs echo and timing slop."),
        num("Min freq (Hz)", "ofdmFMin", 50, "Bottom of the audio band used. Keep within your medium (cheap tape ≈ 300–6000 Hz)."),
        num("Max freq (Hz)", "ofdmFMax", 100, "Top of the audio band used. Cheap tape rolls off around 6 kHz."),
        num("Pilot interval", "ofdmPilotInterval", 1, "Every Nth subcarrier is a known pilot, used to track phase and timing."),
      );
      root.append(phasesRow("Phases per carrier", s, "ofdmPhases", onChange));
      root.append(check("Track tape speed (decode)", "ofdmTrackTiming", "Decoder-only: continuously re-locks symbol timing so a tape playing slightly fast or slow still decodes. Recovers a constant speed offset. Leave off for clean digital files."));
      root.append(check("Wow-robust mode (tape)", "ofdmFreqDiff", "Encodes data across adjacent carriers within each symbol instead of across symbols, so tape wow/flutter (speed wobble) can't scramble it. MUST match on encoder and decoder (save a .cassette). For tape, turn this AND 'Track tape speed' on. Off for clean digital files."));
    }

    root.append(el("hr", { style: "border-color:#2c3038" }));
    root.append(check("Constant-power carrier (AGC)", "constantPower", "Adds a steady tone so a deck's automatic gain control stays pinned. Helps cheap AGC decks."));
    if (s.constantPower) root.append(num("  Carrier freq (Hz)", "constantPowerCarrierHz", 10, "Frequency of the AGC-pinning tone (placed below the data band)."));
    root.append(check("Pre-emphasis", "preEmphasis", "Boosts high frequencies before recording; the decoder undoes it. Can improve SNR on some media."));
    root.append(check("Reed-Solomon", "reedSolomon", "Error correction — recovers data through dropouts and noise, at the cost of some capacity."));
    if (s.reedSolomon) root.append(num("  Parity symbols", "rsNsym", 2, "Reed-Solomon strength: more = corrects more errors, less room for payload."));
    root.append(num("Block size (bytes)", "blockDataSize", 32, "Payload bytes per framed block, before error-correction is added."));
  };

  rebuild();
  return root;
}

function phasesRow(label: string, s: ModemSettings, key: "dpskPhases" | "ofdmPhases", onChange: () => void): HTMLElement {
  const row = el("div", { className: "row" }, [el("label", { textContent: label, title: "Bits per subcarrier: 2 / 4 / 8 phases = 1 / 2 / 3 bits. More = faster but needs a cleaner signal." })]);
  for (const v of [2, 4, 8]) {
    const id = `${key}-${v}`;
    const r = el("input", { type: "radio", name: key, id, value: String(v), checked: s[key] === v }) as HTMLInputElement;
    r.onchange = () => { (s[key] as number) = v; onChange(); };
    row.append(r, el("label", { htmlFor: id, textContent: String(v) }));
  }
  return row;
}
