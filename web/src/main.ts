// Cassette Video Modem — browser app. Encode (video → WAV) and Decode
// (WAV / live audio → video). Both expose the full modem configuration and can
// be paired deterministically via a saved .cassette config file.

import "./style.css";
import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings } from "./dsp/settings";
import { encodeStream } from "./dsp/modem";
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
import { Meters } from "./ui/meters";
import { el } from "./ui/dom";

const CODECS: Record<string, string> = {
  "AV1 (best compression)": "av01.0.01M.08",
  "VP9": "vp09.00.10.08",
  "H.264": "avc1.42001E",
};
const app = document.getElementById("app")!;
const SAMPLE_BASE = `${import.meta.env.BASE_URL}samples/`; // bundled demo assets
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

// Reflect a programmatically-loaded file in the native input's label (Chromium
// allows assigning .files via DataTransfer; harmless no-op where it doesn't).
function setInputFile(input: HTMLInputElement, file: File): void {
  try { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; } catch { /* unsupported */ }
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

  const heightInput = el("input", { type: "number", value: String(video.height), step: "8" }) as HTMLInputElement;
  heightInput.style.width = "90px";
  heightInput.oninput = () => { video.height = parseFloat(heightInput.value) || 0; updateBudget(); };

  const fileIn = el("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  const applyVideoFile = (f: File) => new Promise<void>((resolve) => {
    videoFile = f;
    const probe = document.createElement("video");
    probe.preload = "metadata";
    const done = () => { URL.revokeObjectURL(probe.src); resolve(); };
    probe.onloadedmetadata = () => {
      if (probe.videoWidth && probe.videoHeight) {
        // match the source's aspect ratio (rounded to a multiple of 8)
        video.height = Math.max(8, Math.round((video.width * probe.videoHeight) / probe.videoWidth / 8) * 8);
        heightInput.value = String(video.height);
        updateBudget();
      }
      done();
    };
    probe.onerror = done;
    probe.src = URL.createObjectURL(f);
  });
  fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) applyVideoFile(f); };
  const sampleVideoBtn = el("button", { className: "secondary", textContent: "Try a sample" }) as HTMLButtonElement;
  sampleVideoBtn.onclick = async () => {
    try {
      log.textContent = "Loading sample video…";
      const blob = await (await fetch(`${SAMPLE_BASE}gradient.mp4`)).blob();
      const file = new File([blob], "gradient.mp4", { type: "video/mp4" });
      setInputFile(fileIn, file); // so the input shows "gradient.mp4", not "no file chosen"
      await applyVideoFile(file);
      await runEncode(); // one click: load + encode + show the result
    } catch (e) { log.textContent = "Couldn't load sample: " + (e as Error).message; }
  };
  const codecSel = el("select") as HTMLSelectElement;
  for (const label of Object.keys(CODECS)) codecSel.append(el("option", { value: label, textContent: label, selected: video.codec === CODECS[label] }));
  codecSel.onchange = () => { video.codec = CODECS[codecSel.value]; };

  const log = el("div", { className: "log" });
  const result = el("div", { className: "row" });
  const audioEl = el("audio", { controls: true }) as HTMLAudioElement;
  audioEl.style.display = "none";
  const encodeBtn = el("button", { textContent: "ENCODE" }) as HTMLButtonElement;

  const runEncode = async () => {
    if (!videoFile) { log.textContent = "Choose a video file first."; return; }
    if (video.width < 96 || video.height < 64) { log.textContent = "Resolution too small to decode reliably — use at least 96×64 (the video codec has a minimum)."; return; }
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
  encodeBtn.onclick = runEncode;

  const panel = settingsPanel(s, updateBudget);
  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Target device" }), profileSel, loadConfigButton(s, (v) => Object.assign(video, v), () => render())]),
      el("p", { className: "muted", textContent: profile.description }),
    ]),
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Video file" }), fileIn, sampleVideoBtn]),
      el("div", { className: "row" }, [el("label", { textContent: "Codec" }), codecSel]),
      num("Width", video.width, (v) => (video.width = v), 16),
      el("div", { className: "row" }, [el("label", { textContent: "Height (auto from source)" }), heightInput]),
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
let decodeProfileIdx = 1; // module-level so re-renders don't reset the selection
let decodeRaf = 0;

function decodeView() {
  cancelAnimationFrame(decodeRaf);
  const s: ModemSettings = { ...DEFAULT_SETTINGS };
  Object.assign(s, PROFILES[decodeProfileIdx].settings);
  let sourceMode: "file" | "live" = "file";
  let deviceId: string | undefined;

  const meters = new Meters();
  const metersCanvas = el("canvas", { width: 320, height: 90 }) as HTMLCanvasElement;
  metersCanvas.style.cssText = "width:100%;max-width:512px;border:1px solid #2c3038;border-radius:6px";
  const canvas = el("canvas", { id: "screen", width: 160, height: 120 }) as HTMLCanvasElement;
  const ctx2d = canvas.getContext("2d")!;
  const canvasHolder = el("div", { className: "panel" }, [canvas]);
  const stats = el("div", { className: "mono muted", textContent: "Load an audio file (or pick a device)." });
  const warn = el("div", { className: "muted" });

  // ── decode pipeline (rebuilt on load / seek / settings change) ──
  let ds: DecoderState | null = null;
  let parser = new ContainerParser();
  let vdec: StreamVideoDecoder | null = null;
  let blocks = 0;
  const frameQueue: VideoFrame[] = [];
  function buildPipeline(sampleRate: number) {
    s.sampleRate = sampleRate;
    ds = new DecoderState(s);
    parser = new ContainerParser();
    if (vdec) vdec.close();
    vdec = new StreamVideoDecoder((f) => { if (frameQueue.length < 6) frameQueue.push(f); else f.close(); }, () => {});
    blocks = 0;
    while (frameQueue.length) frameQueue.shift()!.close();
  }
  function handle(seq: number, payload: Uint8Array) {
    if (seq === METADATA_SEQ) return; // frame size comes from the frame itself
    blocks++;
    vdec!.pushRecords(parser.push(payload));
  }

  // ── FILE: a self-paced transport (own play/pause/seek clock) drives real-time
  // decoding of the in-memory samples — no autoplay gate, no capture loss. ──
  let samples: Float32Array | null = null;
  let fileRate = 44100;
  let playhead = 0;   // sample position of the play clock
  let fed = 0;        // samples fed to the decoder so far
  let playing = false;
  let lastTick = 0;

  const playBtn = el("button", { textContent: "▶ Play" }) as HTMLButtonElement;
  const seek = el("input", { type: "range", min: "0", max: "1000", value: "0" }) as HTMLInputElement;
  seek.style.flex = "1";
  const timeLabel = el("span", { className: "mono muted", textContent: "0.0s" });
  const transport = el("div", { className: "row" }, [playBtn, seek, timeLabel]);
  transport.style.display = "none";

  function reseek(pos: number) { buildPipeline(fileRate); playhead = pos; fed = pos; while (frameQueue.length) frameQueue.shift()!.close(); }
  playBtn.onclick = () => {
    if (!samples) return;
    playing = !playing;
    playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
    lastTick = performance.now();
    if (playing && playhead >= samples.length) reseek(0); // replay from start
  };
  seek.oninput = () => { if (samples) reseek(Math.floor((parseInt(seek.value) / 1000) * samples.length)); };

  const fileIn = el("input", { type: "file", accept: "audio/wav,.wav" }) as HTMLInputElement;
  const loadWav = (buf: ArrayBuffer, label: string) => {
    warn.textContent = "";
    const dec = decodeWav(buf);
    samples = dec.samples; fileRate = dec.sampleRate;
    reseek(0); playing = false; playBtn.textContent = "▶ Play";
    transport.style.display = "";
    stats.textContent = `${label} ${(samples.length / fileRate).toFixed(1)}s — press play (or scrub to start anywhere)`;
  };
  fileIn.onchange = async () => { const f = fileIn.files?.[0]; if (f) loadWav(await f.arrayBuffer(), "loaded"); };

  // ── LIVE: realtime capture ──
  let liveCap: Capture | null = null;
  let liveOn = false;
  const deviceSel = el("select") as HTMLSelectElement;
  const refreshDevices = async () => {
    deviceSel.innerHTML = "";
    deviceSel.append(el("option", { value: "", textContent: "(default input)" }));
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      for (const d of await listInputDevices()) deviceSel.append(el("option", { value: d.deviceId, textContent: d.label }));
    } catch { deviceSel.append(el("option", { value: "", textContent: "(grant mic access to list devices)" })); }
  };
  deviceSel.onchange = () => (deviceId = deviceSel.value || undefined);
  const liveStart = el("button", { textContent: "▶ Start" }) as HTMLButtonElement;
  const liveStop = el("button", { className: "secondary", textContent: "■ Stop" }) as HTMLButtonElement;
  liveStart.onclick = async () => {
    liveCap?.stop();
    const cap = new Capture(); liveCap = cap; liveOn = true;
    try { await cap.start(deviceId, (() => { buildPipeline(cap.sampleRate); return (smp: Float32Array) => { meters.push(smp); for (const b of ds!.feedAudio(smp)) handle(b.seq, b.payload); }; })()); }
    catch (e) { liveCap = null; liveOn = false; warn.textContent = "Input error: " + (e as Error).message; }
  };
  liveStop.onclick = () => { liveCap?.stop(); liveCap = null; liveOn = false; };
  function stopAll() { liveCap?.stop(); liveCap = null; liveOn = false; playing = false; }

  // ── loop: advance the clock + feed (file), then draw the newest frame ──
  function loop() {
    if (sourceMode === "file" && samples && ds) {
      if (playing) {
        const now = performance.now();
        playhead = Math.min(samples.length, playhead + ((now - lastTick) / 1000) * fileRate);
        lastTick = now;
        if (playhead >= samples.length) { playing = false; playBtn.textContent = "▶ Play"; }
      }
      let budget = Math.floor(fileRate * 0.5);
      const target = Math.floor(playhead);
      while (fed < target && budget > 0) {
        const end = Math.min(fed + 4096, target);
        const chunk = samples.subarray(fed, end);
        meters.push(chunk);
        for (const b of ds.feedAudio(chunk)) handle(b.seq, b.payload);
        budget -= end - fed;
        fed = end;
      }
      seek.value = String(Math.floor((playhead / samples.length) * 1000));
      timeLabel.textContent = `${(playhead / fileRate).toFixed(1)}s`;
    }
    while (frameQueue.length > 1) frameQueue.shift()!.close();
    const f = frameQueue.shift();
    if (f) { if (canvas.width !== f.displayWidth) canvas.width = f.displayWidth; if (canvas.height !== f.displayHeight) canvas.height = f.displayHeight; ctx2d.drawImage(f, 0, 0); f.close(); }
    const active = (sourceMode === "file" && playing) || liveOn;
    meters.draw(metersCanvas, blocks > 0);
    stats.textContent = `blocks: ${blocks}` + (active && blocks === 0 && fed > fileRate ? "  ·  no data — check the profile/settings match the encoder" : "");
    decodeRaf = requestAnimationFrame(loop);
  }
  decodeRaf = requestAnimationFrame(loop);

  // ── source toggle + profile + config ──
  const srcRow = el("div", { className: "row" });
  const liveRow = el("div", { className: "row" }, [deviceSel, liveStart, liveStop]);
  const drawSrc = () => {
    srcRow.innerHTML = "";
    srcRow.append(el("label", { textContent: "Source" }));
    for (const m of ["file", "live"] as const) {
      const b = el("button", { className: "secondary" + (sourceMode === m ? " active" : ""), textContent: m === "file" ? "Audio file" : "Audio device" });
      b.onclick = async () => { stopAll(); sourceMode = m; if (m === "live") await refreshDevices(); drawSrc(); };
      srcRow.append(b);
    }
    srcRow.append(sourceMode === "file" ? fileIn : el("span"));
    liveRow.style.display = sourceMode === "live" ? "" : "none";
    transport.style.display = sourceMode === "file" && samples ? "" : "none";
  };
  drawSrc();

  const profileSel = el("select") as HTMLSelectElement;
  PROFILES.forEach((p, i) => profileSel.append(el("option", { value: String(i), textContent: p.name, selected: i === decodeProfileIdx })));
  profileSel.onchange = () => { decodeProfileIdx = parseInt(profileSel.value); Object.assign(s, PROFILES[decodeProfileIdx].settings); if (samples) reseek(0); render(); };
  const reapply = () => { if (samples) reseek(Math.floor(playhead)); };

  const sampleTapeBtn = el("button", { className: "secondary", textContent: "▶ Try a sample tape" }) as HTMLButtonElement;
  sampleTapeBtn.onclick = async () => {
    try {
      stats.textContent = "Loading sample tape…";
      decodeProfileIdx = 1; Object.assign(s, PROFILES[1].settings); profileSel.value = "1"; // match how the sample was encoded
      sourceMode = "file"; drawSrc();
      const buf = await (await fetch(`${SAMPLE_BASE}gradient.wav`)).arrayBuffer();
      setInputFile(fileIn, new File([buf], "gradient.wav", { type: "audio/wav" })); // show "gradient.wav" in the input
      loadWav(buf, "sample tape —");
      playing = true; playBtn.textContent = "❚❚ Pause"; lastTick = performance.now(); // auto-play the demo
    } catch (e) { warn.textContent = "Couldn't load sample: " + (e as Error).message; }
  };

  const popBtn = el("button", { className: "secondary", textContent: "⧉ Pop out" });
  popBtn.onclick = async () => {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) { warn.textContent = "Pop-out needs Document Picture-in-Picture (Chrome/Edge)."; return; }
    const win = await dpip.requestWindow({ width: 512, height: 288 });
    win.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center";
    win.document.body.append(canvas);
    win.addEventListener("pagehide", () => canvasHolder.append(canvas));
  };

  const panel = settingsPanel(s, reapply, { hideSampleRate: true });
  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Profile" }), profileSel, loadConfigButton(s, () => {}, () => render())]),
      srcRow,
      el("div", { className: "row" }, [sampleTapeBtn, el("span", { className: "muted", textContent: "one-click demo — the Encode tab's sample clip, already encoded to a tape, played back" })]),
      transport,
      liveRow,
      el("p", { className: "muted", textContent: "Pick the profile (or Load the encoder's .cassette config), choose the WAV, press play — it decodes in real time; scrub to start anywhere. Changing settings re-syncs." }),
      panel,
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [popBtn]), stats, warn, el("p", { className: "muted", textContent: "Signal (green = locked/decoding, amber = signal but no lock, grey = silent):" }), metersCanvas]),
    canvasHolder,
  );
}

render();
