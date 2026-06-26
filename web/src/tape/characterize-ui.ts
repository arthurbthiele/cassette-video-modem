// Standalone tape-characterisation page. Generates a test-tone WAV the user
// records to cassette and plays back, then analyses an uploaded capture of that
// playback to measure the deck (frequency response, wow/flutter, AGC, noise,
// and which modem settings survive). DSP lives elsewhere — this is UI only.

import "../style.css";
import { el } from "../ui/dom";
import { LAYOUT } from "./layout";
import { generateTestSignal } from "./generate";
import { analyzeCapture } from "./analyze";
import { encodeWav, decodeWav } from "../audio/wav";

const app = document.getElementById("app")!;

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}m ${s.toFixed(1)}s` : `${s.toFixed(1)}s`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Generate panel -------------------------------------------------------

const genStatus = el("span", { className: "muted" });

const genButton = el("button", {
  textContent: "⬇ Generate & download test WAV",
  onclick: () => {
    genStatus.textContent = "Generating…";
    // Defer so the status paints before the (synchronous) synthesis blocks.
    setTimeout(() => {
      try {
        const { samples, sr } = generateTestSignal();
        const blob = encodeWav(samples, sr);
        triggerDownload(blob, "tape-test.wav");
        const durationSec = samples.length / sr;
        genStatus.textContent = `Downloaded tape-test.wav — ${fmtDuration(durationSec)} @ ${sr} Hz`;
      } catch (err) {
        genStatus.textContent = "";
        genStatus.className = "danger";
        genStatus.textContent = `Generation failed: ${(err as Error).message}`;
      }
    }, 0);
  },
});

const contents = el("ul", { className: "muted" });
for (const seg of LAYOUT) contents.append(el("li", { textContent: seg.label }));

const generatePanel = el("section", { className: "panel" }, [
  el("h2", { textContent: "1 · Get the test tone", style: "font-size:15px;margin:0 0 8px" }),
  el("p", { className: "muted", style: "margin-top:0" }, [
    "Download this WAV, record it to your cassette, then play it back and capture the playback to a WAV. The signal contains:",
  ]),
  contents,
  el("div", { className: "row" }, [genButton, genStatus]),
]);

// --- Analyse panel --------------------------------------------------------

const analyseError = el("div", { className: "danger" });
const analyseStatus = el("span", { className: "muted" });
const report = el("div");

const fileInput = el("input", {
  type: "file",
  accept: "audio/wav,.wav",
  onchange: onFileChosen,
}) as HTMLInputElement;

function onFileChosen(): void {
  const file = fileInput.files?.[0];
  if (!file) return;
  analyseError.textContent = "";
  report.replaceChildren();
  analyseStatus.textContent = "Analysing…";
  fileInput.disabled = true;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const buf = reader.result as ArrayBuffer;
      const { samples, sampleRate } = decodeWav(buf);
      const result = analyzeCapture(samples, sampleRate);
      renderReport(result);
      analyseStatus.textContent = `Analysed ${file.name}`;
    } catch (err) {
      analyseStatus.textContent = "";
      analyseError.textContent = `Analysis failed: ${(err as Error).message}`;
    } finally {
      fileInput.disabled = false;
    }
  };
  reader.onerror = () => {
    analyseStatus.textContent = "";
    analyseError.textContent = "Could not read the file.";
    fileInput.disabled = false;
  };
  reader.readAsArrayBuffer(file);
}

type AnalysisResult = ReturnType<typeof analyzeCapture>;

function renderReport(r: AnalysisResult): void {
  report.replaceChildren();

  report.append(
    el("div", { className: "row" }, [
      el("span", {}, [
        "Markers ",
        el("b", { className: "mono", textContent: `${r.markersFound}/${r.markersExpected}` }),
        " found · speed ",
        el("b", { className: "mono", textContent: `${r.speedRatioPct.toFixed(2)}%` }),
        " · duration ",
        el("b", { className: "mono", textContent: fmtDuration(r.durationSec) }),
        ` @ ${r.sr} Hz`,
      ]),
    ]),
  );

  if (r.summary.length) {
    const list = el("ul", { className: "notice", style: "margin:8px 0" });
    for (const line of r.summary) list.append(el("li", { textContent: line }));
    report.append(list);
  }

  for (const seg of r.segments) {
    const header = el("div", { className: "row", style: "margin-bottom:4px" }, [
      el("b", { textContent: seg.label }),
      seg.found
        ? el("span", { className: "muted", textContent: `(${seg.kind})` })
        : el("span", { className: "notice", textContent: "not found" }),
    ]);
    const segPanel = el("div", { className: "panel", style: "margin-bottom:10px" }, [header]);

    const keys = Object.keys(seg.metrics);
    if (keys.length) {
      for (const key of keys) {
        segPanel.append(
          el("div", { className: "row", style: "margin:2px 0" }, [
            el("label", { textContent: key }),
            el("span", { className: "mono", textContent: String(seg.metrics[key]) }),
          ]),
        );
      }
    } else if (!seg.found) {
      segPanel.append(el("div", { className: "muted", textContent: "No metrics — segment was not located in the capture." }));
    }

    report.append(segPanel);
  }
}

const analysePanel = el("section", { className: "panel" }, [
  el("h2", { textContent: "2 · Analyse your capture", style: "font-size:15px;margin:0 0 8px" }),
  el("p", { className: "muted", style: "margin-top:0" }, [
    "Upload the WAV you captured from the cassette playback. We'll measure your deck against the known test signal.",
  ]),
  el("div", { className: "row" }, [
    el("label", { textContent: "Tape capture" }),
    fileInput,
    analyseStatus,
  ]),
  analyseError,
  report,
]);

// --- Page -----------------------------------------------------------------

app.append(
  el("h1", { textContent: "Tape Characterisation" }),
  el("p", { className: "sub" }, [
    "Record this test tone to your cassette, play it back, and capture the playback to a WAV. " +
      "Upload it here and we'll measure your deck — frequency response, wow & flutter, AGC behaviour, " +
      "noise, and which modem settings survive.",
  ]),
  generatePanel,
  analysePanel,
);
