// Cassette Video Modem — browser app. Two modes: Encode (video → WAV) and
// Decode (WAV / live audio → video). Wires the DSP modem + WebCodecs video.

import "./style.css";
import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings, Method } from "./dsp/settings";
import { encodeStream, decodeMetadataPayload } from "./dsp/modem";
import { DecoderState } from "./dsp/decoderState";
import { netKBytesPerSec, videoBitrateBudget } from "./video/budget";
import { framesFromFile } from "./video/source";
import { encodeFramesToContainer } from "./video/encoder";
import { StreamVideoDecoder } from "./video/decoder";
import { ContainerParser } from "./video/container";
import { encodeWav, decodeWav } from "./audio/wav";
import { Playback } from "./audio/playback";
import { Capture, listInputDevices } from "./audio/capture";

const CODECS: Record<string, string> = {
  "AV1 (best compression)": "av01.0.01M.08",
  "VP9": "vp09.00.10.08",
  "H.264": "avc1.42001E",
};

const el = (tag: string, props: Record<string, any> = {}, kids: (Node | string)[] = []): HTMLElement => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};

const app = document.getElementById("app")!;
let mode: "encode" | "decode" = "encode";

function render() {
  app.innerHTML = "";
  app.append(
    el("h1", { textContent: "Cassette Video Modem" }),
    el("p", { className: "sub", textContent: "Store video as audio on cassette tape (or any audio medium) and play it back." }),
  );
  const tabs = el("div", { className: "tabs" });
  for (const m of ["encode", "decode"] as const) {
    const t = el("div", { className: "tab" + (mode === m ? " active" : ""), textContent: m === "encode" ? "Encode" : "Decode" });
    t.onclick = () => { mode = m; render(); };
    tabs.append(t);
  }
  app.append(tabs);
  (mode === "encode" ? encodeView : decodeView)();
}

// ── shared settings widgets ─────────────────────────────────────────────
function methodSelect(s: ModemSettings, onChange: () => void): HTMLElement {
  const sel = el("select") as HTMLSelectElement;
  for (const m of ["ofdm", "dpsk", "fsk4", "fsk"]) sel.append(el("option", { value: m, textContent: m.toUpperCase(), selected: s.method === m }));
  sel.onchange = () => { s.method = sel.value as Method; onChange(); };
  return sel;
}

// ── ENCODE ──────────────────────────────────────────────────────────────
function encodeView() {
  const s: ModemSettings = { ...DEFAULT_SETTINGS };
  const vset = { width: 256, height: 144, fps: 12, grayscale: true, codecLabel: "AV1 (best compression)", gopSeconds: 2, fillFactor: 0.9 };
  let videoFile: File | null = null;

  const budget = el("div", { className: "mono" });
  const meter = el("div", { className: "meter" }, [el("span")]);
  const updateBudget = () => {
    const netKBs = netKBytesPerSec(s);
    const vbps = videoBitrateBudget(s, { fillFactor: vset.fillFactor });
    budget.textContent = `Channel: ${netKBs.toFixed(3)} KB/s net  ·  video budget: ${(vbps / 1000).toFixed(2)} kbps  ·  ${vset.width}×${vset.height} @ ${vset.fps}fps`;
    (meter.firstChild as HTMLElement).style.width = `${Math.min(100, (netKBs / 1.2) * 100)}%`;
  };

  const num = (label: string, val: number, on: (v: number) => void, step = 1) => {
    const i = el("input", { type: "number", value: String(val), step: String(step) }) as HTMLInputElement;
    i.style.width = "80px";
    i.oninput = () => { on(parseFloat(i.value) || 0); updateBudget(); };
    return el("div", { className: "row" }, [el("label", { textContent: label }), i]);
  };

  const fileIn = el("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  fileIn.onchange = () => { videoFile = fileIn.files?.[0] ?? null; };

  const codecSel = el("select") as HTMLSelectElement;
  for (const label of Object.keys(CODECS)) codecSel.append(el("option", { value: label, textContent: label, selected: vset.codecLabel === label }));
  codecSel.onchange = () => { vset.codecLabel = codecSel.value; };

  const log = el("div", { className: "log" });
  const result = el("div", { className: "row" });
  const encodeBtn = el("button", { textContent: "ENCODE" }) as HTMLButtonElement;
  const playback = new Playback();

  encodeBtn.onclick = async () => {
    if (!videoFile) { log.textContent = "Choose a video file first."; return; }
    encodeBtn.disabled = true;
    result.innerHTML = "";
    try {
      log.textContent = "Decoding video frames…";
      const frames = await framesFromFile(videoFile, { width: vset.width, height: vset.height, fps: vset.fps, grayscale: vset.grayscale, onProgress: (f) => (log.textContent = `Reading frames… ${(f * 100) | 0}%`) });
      log.textContent = `Encoding ${frames.length} frames (${vset.codecLabel})…`;
      const bitrate = videoBitrateBudget(s, { fillFactor: vset.fillFactor });
      const container = await encodeFramesToContainer(frames, { codec: CODECS[vset.codecLabel], width: vset.width, height: vset.height, framerate: vset.fps, bitrate, gopSeconds: vset.gopSeconds });
      log.textContent = `Modulating ${container.length} bytes to audio…`;
      const audio = encodeStream(container, s, { width: vset.width, height: vset.height, fps: vset.fps, codec: CODECS[vset.codecLabel] });
      const wav = encodeWav(Float32Array.from(audio), s.sampleRate);
      const url = URL.createObjectURL(wav);
      const secs = (audio.length / s.sampleRate).toFixed(1);
      log.textContent = `Done. ${container.length} B video → ${secs}s of audio (${(wav.size / 1024) | 0} KB WAV).`;
      result.append(
        el("a", { className: "dl", href: url, download: "cassette.wav", textContent: "⬇ Download WAV" }),
        Object.assign(el("button", { className: "secondary", textContent: "▶ Play out" }), { onclick: () => playback.play(Float32Array.from(audio), s.sampleRate) }),
      );
    } catch (e) {
      log.textContent = "Error: " + (e as Error).message;
    } finally {
      encodeBtn.disabled = false;
    }
  };

  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Video file" }), fileIn]),
      el("div", { className: "row" }, [el("label", { textContent: "Codec" }), codecSel]),
      num("Width", vset.width, (v) => (vset.width = v), 16),
      num("Height", vset.height, (v) => (vset.height = v), 8),
      num("Frame rate", vset.fps, (v) => (vset.fps = v)),
      el("div", { className: "row" }, [el("label", { textContent: "Modulation" }), methodSelect(s, updateBudget)]),
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [el("label", { textContent: "Throughput" }), budget]), el("div", { className: "row" }, [meter])]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [encodeBtn]), result, log]),
  );
  updateBudget();
}

// ── DECODE ──────────────────────────────────────────────────────────────
function decodeView() {
  const s: ModemSettings = { ...DEFAULT_SETTINGS };
  let source: "file" | "live" = "file";
  let wavFile: File | null = null;
  let deviceId: string | undefined;

  const W = 512, H = 288;
  const canvas = el("canvas", { id: "screen", width: 256, height: 144 }) as HTMLCanvasElement;
  const stats = el("div", { className: "mono muted", textContent: "idle" });
  let running = false;
  let capture: Capture | null = null;
  const frameQueue: VideoFrame[] = [];
  let displayTimer: number | undefined;
  let fps = 12;

  const drawNext = () => {
    const f = frameQueue.shift();
    if (f) {
      canvas.width = f.displayWidth; canvas.height = f.displayHeight;
      canvas.getContext("2d")!.drawImage(f, 0, 0);
      f.close();
    }
  };

  const onFrame = (f: VideoFrame) => { if (frameQueue.length < 120) frameQueue.push(f); else f.close(); };
  let blocks = 0, framesShown = 0;

  const startDisplay = () => { displayTimer = window.setInterval(() => { if (frameQueue.length) { drawNext(); framesShown++; stats.textContent = `blocks: ${blocks}  ·  frames: ${framesShown}  ·  queued: ${frameQueue.length}`; } }, 1000 / fps); };

  async function start() {
    running = true;
    const ds = new DecoderState(s);
    const parser = new ContainerParser();
    const vdec = new StreamVideoDecoder(onFrame, (e) => console.warn("decode", e));
    blocks = 0; framesShown = 0;
    const handleBytes = (seq: number, payload: Uint8Array) => {
      if (seq === METADATA_SEQ) {
        const meta = decodeMetadataPayload(payload);
        const f = (meta?.video as any)?.fps;
        if (f) fps = f;
        return;
      }
      blocks++;
      vdec.pushRecords(parser.push(payload));
    };
    startDisplay();

    if (source === "file") {
      if (!wavFile) { stats.textContent = "Choose a WAV file."; return; }
      const { samples, sampleRate } = decodeWav(await wavFile.arrayBuffer());
      s.sampleRate = sampleRate;
      const ds2 = new DecoderState(s); // rebuild with the file's sample rate
      const chunk = 4096;
      for (let i = 0; i < samples.length && running; i += chunk) {
        for (const b of ds2.feedAudio(samples.subarray(i, i + chunk))) handleBytes(b.seq, b.payload);
        if (i % (chunk * 20) === 0) await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
      }
      await vdec.flush();
      stats.textContent += "  · done";
    } else {
      capture = new Capture();
      await capture.start(deviceId, (samples) => { for (const b of ds.feedAudio(samples)) handleBytes(b.seq, b.payload); });
    }
  }

  function stop() {
    running = false;
    capture?.stop();
    if (displayTimer) clearInterval(displayTimer);
    while (frameQueue.length) frameQueue.shift()!.close();
  }

  const fileIn = el("input", { type: "file", accept: "audio/wav,.wav" }) as HTMLInputElement;
  fileIn.onchange = () => { wavFile = fileIn.files?.[0] ?? null; };
  const deviceSel = el("select") as HTMLSelectElement;
  deviceSel.append(el("option", { value: "", textContent: "(default input)" }));
  deviceSel.onchange = () => (deviceId = deviceSel.value || undefined);

  const srcRow = el("div", { className: "row" });
  const refreshSrc = () => {
    srcRow.innerHTML = "";
    srcRow.append(el("label", { textContent: "Source" }));
    for (const m of ["file", "live"] as const) {
      const b = el("button", { className: "secondary" + (source === m ? " active" : ""), textContent: m === "file" ? "WAV file" : "Live input" });
      b.onclick = async () => { source = m; if (m === "live") { try { for (const d of await listInputDevices()) deviceSel.append(el("option", { value: d.deviceId, textContent: d.label })); } catch { /* needs permission */ } } refreshSrc(); };
      srcRow.append(b);
    }
    srcRow.append(source === "file" ? fileIn : deviceSel);
  };
  refreshSrc();

  const startBtn = el("button", { textContent: "▶ START" }) as HTMLButtonElement;
  const stopBtn = el("button", { className: "secondary", textContent: "■ Stop" }) as HTMLButtonElement;
  startBtn.onclick = () => { startBtn.disabled = true; stopBtn.disabled = false; start().catch((e) => (stats.textContent = "Error: " + e.message)); };
  stopBtn.onclick = () => { stop(); startBtn.disabled = false; stopBtn.disabled = true; };
  stopBtn.disabled = true;

  const popBtn = el("button", { className: "secondary", textContent: "⧉ Pop out" });
  popBtn.onclick = async () => {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) { stats.textContent = "Pop-out (Document PiP) not supported in this browser."; return; }
    const win = await dpip.requestWindow({ width: W, height: H });
    win.document.body.style.margin = "0";
    win.document.body.style.background = "#000";
    win.document.body.append(canvas);
  };

  app.append(
    el("div", { className: "panel" }, [
      srcRow,
      el("div", { className: "row" }, [el("label", { textContent: "Modulation" }), methodSelect(s, () => {})]),
      el("p", { className: "muted", textContent: "Decode settings must match the encoder. Resolution & fps auto-detect from the stream's metadata." }),
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [startBtn, stopBtn, popBtn]), stats]),
    el("div", { className: "panel" }, [canvas]),
  );
}

render();
