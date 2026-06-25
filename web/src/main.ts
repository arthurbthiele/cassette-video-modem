// Cassette Video Modem — browser app. Encode (video → WAV) and Decode
// (WAV / live audio → video). Both expose the full modem configuration and can
// be paired deterministically via a saved .cassette config file.

import "./style.css";
import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings } from "./dsp/settings";
import { encodeStream, decodeMetadataPayload } from "./dsp/modem";
import { DecoderState } from "./dsp/decoderState";
import { netKBytesPerSec, netBitsPerSec, videoBitrateBudget } from "./video/budget";
import { framesFromFile } from "./video/source";
import { encodeToFitChannel } from "./video/encoder";
import { StreamVideoDecoder } from "./video/decoder";
import { ContainerParser } from "./video/container";
import { encodeWav, decodeWav } from "./audio/wav";
import { Capture, listInputDevices } from "./audio/capture";
import { PROFILES, applyProfile } from "./profiles";
import { downloadConfig, fromConfigJSON, VideoConfig } from "./dsp/config";
import { settingsPanel } from "./ui/settings-panel";
import { el } from "./ui/dom";

const CODECS: Record<string, string> = {
  "AV1 (best compression)": "av01.0.01M.08",
  "VP9": "vp09.00.10.08",
  "H.264": "avc1.42001E",
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

function loadConfigButton(s: ModemSettings, onVideo: (v: Partial<VideoConfig>) => void, after: () => void): HTMLElement {
  const input = el("input", { type: "file", accept: ".cassette,.json,application/json" }) as HTMLInputElement;
  input.style.display = "none";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const { modem, video } = fromConfigJSON(await f.text());
      Object.assign(s, modem);
      onVideo(video);
      after();
    } catch (e) { alert("Could not read config: " + (e as Error).message); }
  };
  const btn = el("button", { className: "secondary", textContent: "Load config (.cassette)" });
  btn.onclick = () => input.click();
  return el("span", {}, [btn, input]);
}

// ── ENCODE ──────────────────────────────────────────────────────────────
let encodeProfileIdx = 1;

function encodeView() {
  const profile = PROFILES[encodeProfileIdx];
  const s: ModemSettings = applyProfile({ ...DEFAULT_SETTINGS }, profile);
  const video: VideoConfig = { width: profile.video.width, height: profile.video.height, fps: profile.video.fps, codec: CODECS["AV1 (best compression)"], gopSeconds: 2 };
  let videoFile: File | null = null;

  const budget = el("div", { className: "mono" });
  const meter = el("div", { className: "meter" }, [el("span")]);
  const updateBudget = () => {
    const netKBs = netKBytesPerSec(s);
    budget.textContent = `Channel: ${netKBs.toFixed(3)} KB/s net  ·  video budget: ${(videoBitrateBudget(s, { fillFactor: 0.9 }) / 1000).toFixed(2)} kbps  ·  ${video.width}×${video.height} @ ${video.fps}fps`;
    (meter.firstChild as HTMLElement).style.width = `${Math.min(100, (netKBs / 1.2) * 100)}%`;
  };

  const profileSel = el("select") as HTMLSelectElement;
  PROFILES.forEach((p, i) => profileSel.append(el("option", { value: String(i), textContent: p.name, selected: i === encodeProfileIdx })));
  profileSel.onchange = () => { encodeProfileIdx = parseInt(profileSel.value); render(); };

  const num = (label: string, val: number, on: (v: number) => void, step = 1) => {
    const i = el("input", { type: "number", value: String(val), step: String(step) }) as HTMLInputElement;
    i.style.width = "90px";
    i.oninput = () => { on(parseFloat(i.value) || 0); updateBudget(); };
    return el("div", { className: "row" }, [el("label", { textContent: label }), i]);
  };

  const fileIn = el("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  fileIn.onchange = () => { videoFile = fileIn.files?.[0] ?? null; };
  const codecSel = el("select") as HTMLSelectElement;
  for (const label of Object.keys(CODECS)) codecSel.append(el("option", { value: label, textContent: label, selected: video.codec === CODECS[label] }));
  codecSel.onchange = () => { video.codec = CODECS[codecSel.value]; };

  const log = el("div", { className: "log" });
  const result = el("div", { className: "row" });
  const audioEl = el("audio", { controls: true }) as HTMLAudioElement;
  audioEl.style.display = "none";
  const encodeBtn = el("button", { textContent: "ENCODE" }) as HTMLButtonElement;

  encodeBtn.onclick = async () => {
    if (!videoFile) { log.textContent = "Choose a video file first."; return; }
    encodeBtn.disabled = true;
    result.innerHTML = "";
    audioEl.style.display = "none";
    try {
      log.textContent = "Reading video frames…";
      const frames = await framesFromFile(videoFile, { width: video.width, height: video.height, fps: video.fps, grayscale: true, onProgress: (f) => (log.textContent = `Reading frames… ${(f * 100) | 0}%`) });
      log.textContent = `Encoding ${frames.length} frames…`;
      const fit = await encodeToFitChannel(frames, { codec: video.codec, width: video.width, height: video.height, framerate: video.fps, gopSeconds: video.gopSeconds }, videoBitrateBudget(s, { fillFactor: 0.9 }), netBitsPerSec(s));
      frames.forEach((f) => f.close());
      log.textContent = `Modulating ${fit.container.length} bytes…`;
      const audio = Float32Array.from(encodeStream(fit.container, s, { width: video.width, height: video.height, fps: video.fps, codec: video.codec }));
      const wav = encodeWav(audio, s.sampleRate);
      const url = URL.createObjectURL(wav);
      const videoSecs = frames.length / video.fps;
      const audioSecs = audio.length / s.sampleRate;
      const rt = fit.fits ? `▶ fits the channel (audio ${(audioSecs / videoSecs).toFixed(2)}× video incl. lead-in)` : `⚠ ${(audioSecs / videoSecs).toFixed(2)}× — lower resolution/fps for real-time`;
      log.textContent = `Done. ${fit.container.length} B → ${audioSecs.toFixed(1)}s audio · ${(fit.containerBitsPerSec / 1000).toFixed(1)} kbps · ${rt}`;
      audioEl.src = url; audioEl.style.display = "";
      result.append(
        el("a", { className: "dl", href: url, download: "cassette.wav", textContent: "⬇ Download WAV" }),
        Object.assign(el("button", { className: "secondary", textContent: "⬇ Save config (.cassette)" }), { onclick: () => downloadConfig(s, video, "cassette.cassette") }),
      );
    } catch (e) {
      log.textContent = "Error: " + (e as Error).message;
    } finally {
      encodeBtn.disabled = false;
    }
  };

  const panel = settingsPanel(s, updateBudget);
  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Target device" }), profileSel, loadConfigButton(s, (v) => Object.assign(video, v), () => render())]),
      el("p", { className: "muted", textContent: profile.description }),
    ]),
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Video file" }), fileIn]),
      el("div", { className: "row" }, [el("label", { textContent: "Codec" }), codecSel]),
      num("Width", video.width, (v) => (video.width = v), 16),
      num("Height", video.height, (v) => (video.height = v), 8),
      num("Frame rate", video.fps, (v) => (video.fps = v)),
      num("Keyframe interval (s)", video.gopSeconds, (v) => (video.gopSeconds = v)),
    ]),
    el("div", { className: "panel" }, [el("p", { className: "muted", textContent: "Modem settings (must match the decoder — save a config to pair them)" }), panel]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [el("label", { textContent: "Throughput" }), budget]), el("div", { className: "row" }, [meter])]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [encodeBtn]), result, audioEl, log]),
  );
  updateBudget();
}

// ── DECODE ──────────────────────────────────────────────────────────────
function decodeView() {
  const s: ModemSettings = { ...DEFAULT_SETTINGS };
  let source: "file" | "live" = "file";
  let wavFile: File | null = null;
  let deviceId: string | undefined;

  const canvas = el("canvas", { id: "screen", width: 256, height: 144 }) as HTMLCanvasElement;
  const canvasHolder = el("div", { className: "panel" }, [canvas]);
  const stats = el("div", { className: "mono muted", textContent: "idle" });
  const warn = el("div", { className: "muted" });

  let running = false;
  let capture: Capture | null = null;
  let displayTimer: number | undefined;
  let fps = 12;
  const frameQueue: VideoFrame[] = [];
  let blocks = 0, framesShown = 0;

  function resetDisplay() {
    if (displayTimer) clearInterval(displayTimer);
    while (frameQueue.length) frameQueue.shift()!.close();
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function start() {
    if (running) return;
    resetDisplay();
    running = true; blocks = 0; framesShown = 0; warn.textContent = "";
    stats.textContent = "decoding…";

    const parser = new ContainerParser();
    let framesDecoded = 0;
    const vdec = new StreamVideoDecoder(
      (f) => { framesDecoded++; if (frameQueue.length < 240) frameQueue.push(f); else f.close(); },
      (e) => console.warn("video decode:", e),
    );
    const handle = (seq: number, payload: Uint8Array) => {
      if (seq === METADATA_SEQ) {
        const meta = decodeMetadataPayload(payload);
        const v = (meta?.video as any);
        if (v?.fps) fps = v.fps;
        if (v) stats.textContent = `metadata: ${v.width}×${v.height}@${v.fps} (${(meta as any).method})`;
        return;
      }
      blocks++;
      vdec.pushRecords(parser.push(payload));
    };

    displayTimer = window.setInterval(() => {
      const f = frameQueue.shift();
      if (f) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; canvas.getContext("2d")!.drawImage(f, 0, 0); f.close(); framesShown++; }
      stats.textContent = `blocks: ${blocks}  ·  frames: ${framesShown}  ·  queued: ${frameQueue.length}`;
    }, 1000 / fps);

    if (source === "file") {
      if (!wavFile) { stop(); stats.textContent = "Choose a WAV file first."; return; }
      const { samples, sampleRate } = decodeWav(await wavFile.arrayBuffer());
      s.sampleRate = sampleRate;
      const ds = new DecoderState(s);
      for (let i = 0; i < samples.length && running; i += 4096) {
        for (const b of ds.feedAudio(samples.subarray(i, i + 4096))) handle(b.seq, b.payload);
        if (i % (4096 * 30) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      await vdec.flush();
      if (blocks === 0) warn.textContent = "⚠ No data decoded. The decoder settings must match the encoder — Load the .cassette config the encoder saved, or set the modulation/parameters to match.";
      else if (framesDecoded === 0) warn.textContent = "⚠ Data decoded but no video frames — codec/container mismatch.";
    } else {
      const ds = new DecoderState(s);
      capture = new Capture();
      try {
        await capture.start(deviceId, (samples) => { for (const b of ds.feedAudio(samples)) handle(b.seq, b.payload); });
        s.sampleRate = capture.sampleRate;
      } catch (e) { stop(); stats.textContent = "Mic/line-in error: " + (e as Error).message; }
    }
  }

  function stop() {
    running = false;
    capture?.stop(); capture = null;
    resetDisplay();
  }

  // source controls
  const fileIn = el("input", { type: "file", accept: "audio/wav,.wav" }) as HTMLInputElement;
  const audioEl = el("audio", { controls: true }) as HTMLAudioElement; // standard playback, separate from decode
  audioEl.style.display = "none";
  fileIn.onchange = () => { wavFile = fileIn.files?.[0] ?? null; if (wavFile) { audioEl.src = URL.createObjectURL(wavFile); audioEl.style.display = ""; } };

  const deviceSel = el("select") as HTMLSelectElement;
  const refreshDevices = async () => {
    deviceSel.innerHTML = "";
    deviceSel.append(el("option", { value: "", textContent: "(default input)" }));
    try {
      // a brief permission grant so device labels are populated
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      for (const d of await listInputDevices()) deviceSel.append(el("option", { value: d.deviceId, textContent: d.label }));
    } catch { deviceSel.append(el("option", { value: "", textContent: "(grant mic access to list devices)" })); }
  };
  deviceSel.onchange = () => (deviceId = deviceSel.value || undefined);

  const srcRow = el("div", { className: "row" });
  const drawSrc = () => {
    srcRow.innerHTML = "";
    srcRow.append(el("label", { textContent: "Source" }));
    for (const m of ["file", "live"] as const) {
      const b = el("button", { className: "secondary" + (source === m ? " active" : ""), textContent: m === "file" ? "Audio file" : "Audio device" });
      b.onclick = async () => { stop(); source = m; if (m === "live") await refreshDevices(); drawSrc(); };
      srcRow.append(b);
    }
    srcRow.append(source === "file" ? fileIn : deviceSel);
  };
  drawSrc();

  const startBtn = el("button", { textContent: "▶ START" }) as HTMLButtonElement;
  const stopBtn = el("button", { className: "secondary", textContent: "■ Stop" }) as HTMLButtonElement;
  startBtn.onclick = () => { start().catch((e) => (stats.textContent = "Error: " + e.message)); };
  stopBtn.onclick = () => stop();

  const popBtn = el("button", { className: "secondary", textContent: "⧉ Pop out" });
  popBtn.onclick = async () => {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) { warn.textContent = "Pop-out needs Document Picture-in-Picture (Chrome/Edge)."; return; }
    const win = await dpip.requestWindow({ width: 512, height: 288 });
    win.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center";
    win.document.body.append(canvas);
    win.addEventListener("pagehide", () => canvasHolder.append(canvas)); // return it on close
  };

  const panel = settingsPanel(s, () => {});
  app.append(
    el("div", { className: "panel" }, [
      srcRow,
      audioEl,
      el("div", { className: "row" }, [loadConfigButton(s, () => {}, () => render())]),
      el("p", { className: "muted", textContent: "Settings must match the encoder. Easiest: Load the .cassette config it saved. Resolution & fps auto-detect from metadata." }),
      panel,
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [startBtn, stopBtn, popBtn]), stats, warn]),
    canvasHolder,
  );
}

render();
