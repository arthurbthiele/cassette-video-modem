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
let decodeRaf = 0; // cancelled on re-render

function decodeView() {
  cancelAnimationFrame(decodeRaf);
  const s: ModemSettings = { ...DEFAULT_SETTINGS };
  let profileIdx = 1;
  Object.assign(s, PROFILES[profileIdx].settings);
  let source: "file" | "live" = "file";
  let deviceId: string | undefined;

  const canvas = el("canvas", { id: "screen", width: 256, height: 144 }) as HTMLCanvasElement;
  const ctx2d = canvas.getContext("2d")!;
  const canvasHolder = el("div", { className: "panel" }, [canvas]);
  const stats = el("div", { className: "mono muted", textContent: "Load an audio file (or pick a device)." });
  const warn = el("div", { className: "muted" });

  // FILE: decode the whole clip up front (reliable), then play it back paced by
  // the muted audio element — which gives play/pause/seek-to-any-point for free.
  let frames: { ts: number; frame: VideoFrame }[] = [];
  let lastFile: File | null = null;
  function clearFrames() { for (const { frame } of frames) frame.close(); frames = []; }

  async function decodeFile(file: File) {
    clearFrames();
    warn.textContent = "";
    stats.textContent = "decoding…";
    const buf = await file.arrayBuffer();
    const { samples, sampleRate } = decodeWav(buf);
    s.sampleRate = sampleRate;
    const ds = new DecoderState(s);
    const parser = new ContainerParser();
    let bl = 0;
    const vdec = new StreamVideoDecoder((f) => frames.push({ ts: f.timestamp, frame: f }), () => {});
    for (let i = 0; i < samples.length; i += 4096) {
      for (const b of ds.feedAudio(samples.subarray(i, i + 4096))) {
        if (b.seq !== METADATA_SEQ) { bl++; vdec.pushRecords(parser.push(b.payload)); }
      }
      if (i % (4096 * 40) === 0) { stats.textContent = `decoding… ${((100 * i) / samples.length) | 0}%`; await new Promise((r) => setTimeout(r, 0)); }
    }
    await vdec.flush();
    frames.sort((a, b) => a.ts - b.ts);
    if (bl === 0) warn.textContent = "⚠ No data decoded — the profile/settings must match the encoder (or Load its .cassette config).";
    else if (frames.length === 0) warn.textContent = "⚠ Data decoded but no video frames — codec mismatch.";
    stats.textContent = `${frames.length} frames from ${bl} blocks` + (frames.length ? " — press play, or seek anywhere" : "");
    audioEl.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    audioEl.muted = true; // it's the clock, not for listening (the signal is modem screech)
    audioEl.style.display = "";
    if (frames.length) { canvas.width = frames[0].frame.displayWidth; canvas.height = frames[0].frame.displayHeight; ctx2d.drawImage(frames[0].frame, 0, 0); }
  }

  // LIVE: realtime capture → decode → draw frames as they arrive.
  let liveCap: Capture | null = null;
  const liveQueue: VideoFrame[] = [];
  let liveBlocks = 0;

  function drawLoop() {
    if (source === "file" && frames.length) {
      const t = audioEl.currentTime * 1e6;
      let idx = 0;
      for (let i = 0; i < frames.length; i++) { if (frames[i].ts <= t) idx = i; else break; }
      const fr = frames[idx].frame;
      if (canvas.width !== fr.displayWidth) canvas.width = fr.displayWidth;
      if (canvas.height !== fr.displayHeight) canvas.height = fr.displayHeight;
      ctx2d.drawImage(fr, 0, 0);
    } else if (source === "live") {
      const f = liveQueue.shift();
      if (f) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; ctx2d.drawImage(f, 0, 0); f.close(); }
    }
    decodeRaf = requestAnimationFrame(drawLoop);
  }
  decodeRaf = requestAnimationFrame(drawLoop);

  // ── file player ──
  const audioEl = el("audio", { controls: true }) as HTMLAudioElement;
  audioEl.style.cssText = "width:100%;max-width:512px;display:none";
  const fileIn = el("input", { type: "file", accept: "audio/wav,.wav" }) as HTMLInputElement;
  fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) { lastFile = f; decodeFile(f).catch((e) => (warn.textContent = "Error: " + (e as Error).message)); } };

  // ── live device controls ──
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
    liveQueue.length = 0; liveBlocks = 0;
    const cap = new Capture();
    liveCap = cap;
    try {
      await cap.start(deviceId, (() => {
        const ds = new DecoderState({ ...s, sampleRate: cap.sampleRate });
        const parser = new ContainerParser();
        const vdec = new StreamVideoDecoder((f) => { if (liveQueue.length < 8) liveQueue.push(f); else f.close(); }, () => {});
        return (samples: Float32Array) => { for (const b of ds.feedAudio(samples)) if (b.seq !== METADATA_SEQ) { liveBlocks++; vdec.pushRecords(parser.push(b.payload)); stats.textContent = `live · blocks: ${liveBlocks}`; } };
      })());
    } catch (e) { liveCap = null; warn.textContent = "Input error: " + (e as Error).message; }
  };
  liveStop.onclick = () => { liveCap?.stop(); liveCap = null; };

  function stopAll() { liveCap?.stop(); liveCap = null; }

  const srcRow = el("div", { className: "row" });
  const liveRow = el("div", { className: "row" }, [deviceSel, liveStart, liveStop]);
  const drawSrc = () => {
    srcRow.innerHTML = "";
    srcRow.append(el("label", { textContent: "Source" }));
    for (const m of ["file", "live"] as const) {
      const b = el("button", { className: "secondary" + (source === m ? " active" : ""), textContent: m === "file" ? "Audio file" : "Audio device" });
      b.onclick = async () => { stopAll(); source = m; if (m === "live") await refreshDevices(); drawSrc(); };
      srcRow.append(b);
    }
    srcRow.append(source === "file" ? fileIn : el("span"));
    liveRow.style.display = source === "live" ? "" : "none";
    audioEl.style.display = source === "file" && frames.length ? "" : "none";
  };
  drawSrc();

  // ── profile + config ──
  const profileSel = el("select") as HTMLSelectElement;
  PROFILES.forEach((p, i) => profileSel.append(el("option", { value: String(i), textContent: p.name, selected: i === profileIdx })));
  profileSel.onchange = () => { profileIdx = parseInt(profileSel.value); Object.assign(s, PROFILES[profileIdx].settings); if (lastFile) decodeFile(lastFile); render(); };

  const reDecode = () => { if (source === "file" && lastFile) decodeFile(lastFile); }; // apply settings changes

  const popBtn = el("button", { className: "secondary", textContent: "⧉ Pop out" });
  popBtn.onclick = async () => {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) { warn.textContent = "Pop-out needs Document Picture-in-Picture (Chrome/Edge)."; return; }
    const win = await dpip.requestWindow({ width: 512, height: 288 });
    win.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center";
    win.document.body.append(canvas);
    win.addEventListener("pagehide", () => canvasHolder.append(canvas));
  };

  const panel = settingsPanel(s, reDecode, { hideSampleRate: true });
  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Profile" }), profileSel, loadConfigButton(s, () => {}, () => render())]),
      srcRow,
      audioEl,
      liveRow,
      el("p", { className: "muted", textContent: "Pick the profile (or Load the .cassette config) that matches the encoder, then choose the WAV. It decodes, then plays back with seek — start anywhere. Changing settings re-decodes." }),
      panel,
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [popBtn]), stats, warn]),
    canvasHolder,
  );
}

render();
