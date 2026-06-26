// Cassette Video Modem — browser app. Encode (video → WAV) and Decode
// (WAV / live audio → video). Both expose the full modem configuration and can
// be paired deterministically via a saved .cassette config file.
//
// State model: a single module-level `state` object is the source of truth.
// render() rebuilds the DOM from it and never resets it — so uploads, settings
// and the encoding all persist until the page is reloaded. The encoding is the
// shared artifact: encode writes it, decode reads it (encode output = decode
// input). Only explicit user actions mutate state.

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
const SAMPLES = [
  { file: "gradient.mp4", label: "Gradient — clean demo", note: "Smooth and low-motion — fits the channel easily." },
  { file: "plasma.mp4", label: "Plasma — longer (~16s)", note: "A calmer, longer clip; still fits with room to spare." },
  { file: "detail.mp4", label: "Test chart — detail limit", note: "Fine lines & gratings blur away at 128×96 grayscale." },
  { file: "motion.mp4", label: "Busy motion — bitrate limit", note: "Too busy for the channel — encodes slower than real time and breaks up. Good for seeing the limit." },
  { file: "aerial.mp4", label: "Aerial — real footage (~25s)", note: "Real in-flight footage (CC0 public domain). A longer, natural clip — encoding and decoding take a while." },
];

const AV1 = CODECS["AV1 (best compression)"];
const freshSettings = (i: number): ModemSettings => applyProfile({ ...DEFAULT_SETTINGS }, PROFILES[i]);
const freshVideo = (i: number): VideoConfig => ({ width: PROFILES[i].video.width, height: PROFILES[i].video.height, fps: PROFILES[i].video.fps, codec: AV1, gopSeconds: 2 });

// ── the single source of truth ──────────────────────────────────────────
interface DecodeInput { wav: Blob; name: string; referenceUrl: string | null; sampleIdx: number | null }
interface Encoding { wav: Blob; url: string; sourceUrl: string; modem: ModemSettings; video: VideoConfig; profileIdx: number; summary: string }
const state = {
  tab: "encode" as "encode" | "decode",
  sampleIdx: 0,
  encode: {
    profileIdx: 1,
    settings: freshSettings(1),
    video: freshVideo(1),
    sourceFile: null as File | null,
    sourceAspect: 0, // source height/width, to re-derive height when the profile changes (0 = unknown)
    colour: false,   // encode in colour instead of grayscale (same bitrate → trades detail for colour)
  },
  decode: {
    profileIdx: 1,
    settings: freshSettings(1),
    sourceMode: "file" as "file" | "live",
    input: null as DecodeInput | null, // what to decode (file mode): the encoding, a sample, or a loaded WAV
  },
  encoding: null as Encoding | null, // encode output = decode input
};
let decodeAutoplay = false; // one-shot: "Play it back" wants the next decode render to auto-play
let decodeRaf = 0;
let teardownDecode: (() => void) | null = null; // stops the live decode view's loop/mic/decoder on re-render
const WEBCODECS_OK = typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";

// Replace the stored encoding, revoking the previous one's object URLs (the WAV
// URL is otherwise re-minted on every encode-view render → an unbounded leak).
function setEncoding(enc: Encoding | null): void {
  if (state.encoding) { URL.revokeObjectURL(state.encoding.url); URL.revokeObjectURL(state.encoding.sourceUrl); }
  state.encoding = enc;
}

// Encode a video File to a modem WAV with the given settings — shared by the
// encoder and by the decoder's "Try a sample tape" (which encodes on the fly so
// any bundled sample can be demoed without shipping a WAV for each).
async function encodeFileToWav(file: File, s: ModemSettings, video: VideoConfig, grayscale: boolean, onProgress?: (f: number) => void): Promise<{ wav: Blob; fit: Awaited<ReturnType<typeof encodeToFitChannel>>; audioSecs: number; videoSecs: number }> {
  const frames = await framesFromFile(file, { width: video.width, height: video.height, fps: video.fps, grayscale, onProgress });
  const nFrames = frames.length;
  const fit = await encodeToFitChannel(frames, { codec: video.codec, width: video.width, height: video.height, framerate: video.fps, gopSeconds: video.gopSeconds }, videoBitrateBudget(s, { fillFactor: 0.9 }), netBitsPerSec(s));
  frames.forEach((f) => f.close());
  const audio = Float32Array.from(encodeStream(fit.container, s));
  return { wav: encodeWav(audio, s.sampleRate), fit, audioSecs: audio.length / s.sampleRate, videoSecs: nFrames / video.fps };
}

// Reflect a programmatically-loaded file in the native input's label (Chromium
// allows assigning .files via DataTransfer; harmless no-op where it doesn't).
function setInputFile(input: HTMLInputElement, file: File): void {
  try { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; } catch { /* unsupported */ }
}

function sampleSelect(noteEl: HTMLElement): HTMLSelectElement {
  const sel = el("select") as HTMLSelectElement;
  SAMPLES.forEach((sm, i) => sel.append(el("option", { value: String(i), textContent: sm.label, selected: i === state.sampleIdx })));
  noteEl.textContent = SAMPLES[state.sampleIdx].note;
  sel.onchange = () => { state.sampleIdx = parseInt(sel.value); noteEl.textContent = SAMPLES[state.sampleIdx].note; };
  return sel;
}

// Load a .cassette into the current tab's settings, then re-render. Settings live
// in `state`, so they survive the render (the old bug was rebuilding them from
// the profile after loading).
function loadConfigButton(): HTMLElement {
  const input = el("input", { type: "file", accept: ".cassette,.json,application/json" }) as HTMLInputElement;
  input.style.display = "none";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const { modem, video } = fromConfigJSON(await f.text());
      if (state.tab === "encode") { Object.assign(state.encode.settings, modem); Object.assign(state.encode.video, video); }
      else Object.assign(state.decode.settings, modem);
      render();
    } catch (e) { alert("Could not read config: " + (e as Error).message); }
  };
  const btn = el("button", { className: "secondary", textContent: "Load config (.cassette)" });
  btn.onclick = () => input.click();
  return el("span", {}, [btn, input]);
}

function render() {
  teardownDecode?.(); teardownDecode = null; // tear down the previous decode instance (loop, mic, decoder)
  app.innerHTML = "";
  app.append(
    el("h1", { textContent: "Cassette Video Modem" }),
    el("p", { className: "sub", textContent: "Store video as audio on cassette tape (or any audio medium) and play it back." }),
  );
  if (!WEBCODECS_OK) app.append(el("div", { className: "panel", style: "border-color:#f5a623" }, [
    el("p", { textContent: "⚠ This tool needs Chrome or Edge. Your browser doesn't support the video features (WebCodecs) it relies on, so encoding and decoding won't work here." }),
  ]));
  const tabs = el("div", { className: "tabs" });
  for (const m of ["encode", "decode"] as const) {
    const t = el("div", { className: "tab" + (state.tab === m ? " active" : ""), textContent: m === "encode" ? "Encode" : "Decode" });
    t.onclick = () => { state.tab = m; render(); };
    tabs.append(t);
  }
  app.append(tabs);
  (state.tab === "encode" ? encodeView : decodeView)();
}

// ── ENCODE ──────────────────────────────────────────────────────────────
function encodeView() {
  const E = state.encode;
  const profile = PROFILES[E.profileIdx];
  const s = E.settings; // mutate-in-place → persists in state
  const video = E.video;

  const budget = el("div", { className: "mono" });
  const meter = el("div", { className: "meter" }, [el("span")]);
  const updateBudget = () => {
    const netKBs = netKBytesPerSec(s);
    budget.textContent = `Tape capacity: ${netKBs.toFixed(2)} KB/s  ·  usable for video: ${(videoBitrateBudget(s, { fillFactor: 0.9 }) / 1000).toFixed(1)} kbps  ·  picture ${video.width}×${video.height} at ${video.fps} fps`;
    (meter.firstChild as HTMLElement).style.width = `${Math.min(100, (netKBs / 1.2) * 100)}%`;
  };

  const profileSel = el("select") as HTMLSelectElement;
  PROFILES.forEach((p, i) => profileSel.append(el("option", { value: String(i), textContent: p.name, selected: i === E.profileIdx })));
  profileSel.onchange = () => {
    E.profileIdx = parseInt(profileSel.value);
    E.settings = freshSettings(E.profileIdx); // choosing a preset loads its settings
    E.video = freshVideo(E.profileIdx);
    if (E.sourceAspect > 0) E.video.height = Math.max(64, Math.round((E.video.width * E.sourceAspect) / 8) * 8);
    render();
  };

  const num = (label: string, val: number, on: (v: number) => void, _step = 1, tip = "") => {
    const i = el("input", { type: "number", value: String(val), step: "any" }) as HTMLInputElement; // step="any" → no off-grid "invalid" bubble
    i.style.width = "90px";
    i.oninput = () => { on(parseFloat(i.value) || 0); updateBudget(); };
    return el("div", { className: "row" }, [el("label", { textContent: label, title: tip }), i]);
  };

  const heightInput = el("input", { type: "number", value: String(video.height), step: "any" }) as HTMLInputElement;
  heightInput.style.width = "90px";
  heightInput.oninput = () => { video.height = parseFloat(heightInput.value) || 0; updateBudget(); };

  const colourCheck = el("input", { type: "checkbox", checked: E.colour }) as HTMLInputElement;
  colourCheck.onchange = () => { E.colour = colourCheck.checked; };

  const saveConfigBtn = el("button", { className: "secondary", textContent: "Save config (.cassette)" });
  saveConfigBtn.onclick = () => downloadConfig(s, video, "cassette.cassette");

  const fileIn = el("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  if (E.sourceFile) setInputFile(fileIn, E.sourceFile); // restore the chosen file's label across renders
  const applyVideoFile = (f: File) => new Promise<void>((resolve) => {
    E.sourceFile = f;
    const probe = document.createElement("video");
    probe.preload = "metadata";
    const done = () => { URL.revokeObjectURL(probe.src); resolve(); };
    probe.onloadedmetadata = () => {
      if (probe.videoWidth && probe.videoHeight) {
        E.sourceAspect = probe.videoHeight / probe.videoWidth;
        video.height = Math.max(64, Math.round((video.width * E.sourceAspect) / 8) * 8); // match source aspect (×8, ≥ codec min)
        heightInput.value = String(video.height);
        updateBudget();
      }
      done();
    };
    probe.onerror = done;
    probe.src = URL.createObjectURL(f);
  });
  fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) applyVideoFile(f); };
  const sampleNote = el("span", { className: "muted" });
  const sampleSel = sampleSelect(sampleNote);
  const sampleVideoBtn = el("button", { className: "secondary", textContent: "Try a sample" }) as HTMLButtonElement;
  sampleVideoBtn.onclick = async () => {
    try {
      const sm = SAMPLES[state.sampleIdx];
      log.textContent = `Loading ${sm.label}…`;
      const blob = await (await fetch(`${SAMPLE_BASE}${sm.file}`)).blob();
      const file = new File([blob], sm.file, { type: "video/mp4" });
      setInputFile(fileIn, file);
      await applyVideoFile(file);
      await runEncode(); // one click: load + encode + show the result
    } catch (e) { log.textContent = "Couldn't load sample: " + (e as Error).message; log.className = "log danger"; }
  };
  const codecSel = el("select") as HTMLSelectElement;
  for (const label of Object.keys(CODECS)) codecSel.append(el("option", { value: label, textContent: label, selected: video.codec === CODECS[label] }));
  codecSel.onchange = () => { video.codec = CODECS[codecSel.value]; };

  const log = el("div", { className: "log" });
  const result = el("div", { className: "row" });
  const audioEl = el("audio", { controls: true }) as HTMLAudioElement;
  audioEl.style.display = "none";
  const playbackRow = el("div", { className: "row" }); // "Decode and play back" sits below the audio player
  const encodeBtn = el("button", { textContent: "ENCODE" }) as HTMLButtonElement;

  // (re)build the result panel from the persisted encoding
  const showResult = () => {
    result.innerHTML = "";
    playbackRow.innerHTML = "";
    audioEl.style.display = "none";
    const enc = state.encoding;
    if (!enc) return;
    audioEl.src = enc.url; audioEl.style.display = "";
    log.textContent = enc.summary;
    log.className = enc.summary.includes("⚠") ? "log notice" : "log";
    result.append(
      el("a", { className: "dl", href: enc.url, download: "cassette.wav", textContent: "⬇ Download WAV" }),
    );
    playbackRow.append(
      Object.assign(el("button", { textContent: "▶ Decode and play back" }), {
        onclick: () => {
          state.decode.input = { wav: enc.wav, name: "cassette.wav", referenceUrl: enc.sourceUrl, sampleIdx: null };
          state.decode.profileIdx = enc.profileIdx; state.decode.settings = { ...enc.modem }; state.decode.sourceMode = "file";
          state.tab = "decode"; decodeAutoplay = true; render();
        },
      }),
    );
  };

  const runEncode = async () => {
    if (!E.sourceFile) { log.textContent = "Choose a video file first (or try a sample)."; log.className = "log notice"; return; }
    video.width = Math.max(2, Math.round(video.width / 2) * 2); // codecs need even, integer dimensions
    video.height = Math.max(2, Math.round(video.height / 2) * 2);
    video.fps = Math.max(1, Math.round(video.fps)); // fps 0 would make the budget math blow up
    if (video.width < 96 || video.height < 64) { log.textContent = "Picture too small — the video codec needs at least 96×64 pixels. Pick a roomier profile, or a less extreme crop."; log.className = "log notice"; return; }
    encodeBtn.disabled = true;
    result.innerHTML = "";
    audioEl.style.display = "none";
    log.className = "log";
    try {
      log.textContent = "Reading video frames…";
      const { wav, fit, audioSecs, videoSecs } = await encodeFileToWav(E.sourceFile, s, video, !E.colour, (f) => (log.textContent = `Reading frames… ${(f * 100) | 0}%`));
      const ratio = (audioSecs / videoSecs).toFixed(2);
      const rt = fit.fits
        ? `▶ Fits the channel — plays back from tape in real time.`
        : `⚠ Too busy to play back from tape at normal speed (the audio runs ${ratio}× longer than the video). It still decodes correctly when you scrub; for real-time playback try a smaller picture, lower frame rate, or a calmer clip.`;
      const summary = `Encoded ${fit.container.length} bytes into ${audioSecs.toFixed(1)}s of audio (${(fit.containerBitsPerSec / 1000).toFixed(1)} kbps). ${rt}`;
      // record the encoding and point the Decode tab at it (encode output = decode input)
      setEncoding({ wav, url: URL.createObjectURL(wav), sourceUrl: URL.createObjectURL(E.sourceFile), modem: { ...s }, video: { ...video }, profileIdx: E.profileIdx, summary });
      state.decode.input = { wav, name: "cassette.wav", referenceUrl: state.encoding!.sourceUrl, sampleIdx: null };
      state.decode.profileIdx = E.profileIdx; state.decode.settings = { ...s }; state.decode.sourceMode = "file";
      showResult();
    } catch (e) {
      log.textContent = (e as Error).message;
      log.className = "log danger";
    } finally {
      encodeBtn.disabled = false;
    }
  };
  encodeBtn.onclick = runEncode;

  const panel = settingsPanel(s, updateBudget);
  app.append(
    el("div", { className: "panel" }, [
      el("p", { className: "muted", textContent: "Turn a video into audio you can record onto tape: pick a clip (or a sample), press ENCODE, then download the WAV. To watch it back, open the Decode tab." }),
      el("div", { className: "row" }, [el("label", { textContent: "Profile", title: "Preset for a target medium — sets all the modem settings below. The decoder must use the same profile (or load the saved .cassette)." }), profileSel, loadConfigButton(), saveConfigBtn]),
      el("p", { className: "muted", textContent: `${profile.description} The decoder must use this same profile.` }),
    ]),
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Video file" }), fileIn]),
      el("div", { className: "row" }, [el("label", { textContent: "Or try a sample" }), sampleSel, sampleVideoBtn]),
      el("div", { className: "row" }, [sampleNote]),
      el("div", { className: "row" }, [el("label", { textContent: "Codec", title: "Video codec. AV1 compresses best (recommended for the tiny channel); H.264 is the most broadly supported." }), codecSel]),
      el("div", { className: "row" }, [el("label", { textContent: "Colour", title: "Encode in colour instead of grayscale. Same bitrate, so colour steals detail from the picture — best on roomy profiles (Clean line / CD)." }), colourCheck]),
      num("Width", video.width, (v) => (video.width = v), 16, "Picture width in pixels. Smaller = fewer bits, fits more easily."),
      el("div", { className: "row" }, [el("label", { textContent: "Height (auto)", title: "Picture height — auto-set from your video's aspect ratio. Smaller = fewer bits." }), heightInput]),
      num("Frame rate", video.fps, (v) => (video.fps = v), 1, "Frames per second. Lower = fewer bits and an easier fit."),
      num("Keyframe interval (seconds)", video.gopSeconds, (v) => (video.gopSeconds = v), 1, "Seconds between full keyframes. Longer compresses better, but a dropout costs more until the next keyframe."),
    ]),
    el("div", { className: "panel" }, [el("p", { className: "muted", textContent: "Modem settings (must match the decoder — save a config to pair them)" }), panel]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [el("label", { textContent: "Capacity" }), budget]), el("div", { className: "row" }, [meter])]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [encodeBtn]), result, audioEl, playbackRow, log]),
  );
  updateBudget();
  showResult(); // restore the last encoding's result across renders
}

// ── DECODE ──────────────────────────────────────────────────────────────
function decodeView() {
  const D = state.decode;
  const s = D.settings; // mutate-in-place → persists
  let sourceMode = D.sourceMode;
  let deviceId: string | undefined;

  const meters = new Meters();
  const metersCanvas = el("canvas", { width: 320, height: 90 }) as HTMLCanvasElement;
  metersCanvas.style.cssText = "width:100%;max-width:512px;border:1px solid #2c3038;border-radius:6px";
  const canvas = el("canvas", { id: "screen", width: 160, height: 120 }) as HTMLCanvasElement;
  const ctx2d = canvas.getContext("2d")!;
  const refVideo = el("video", { className: "ref" }) as HTMLVideoElement;
  refVideo.muted = true; (refVideo as any).playsInline = true;
  const decodedCell = el("div", { className: "cmp-cell" }, [el("div", { className: "cmp-label", textContent: "Decoded from audio" }), canvas]);
  const originalCell = el("div", { className: "cmp-cell" }, [el("div", { className: "cmp-label", textContent: "Original" }), refVideo]);
  originalCell.style.display = "none";
  const cmpRow = el("div", { className: "cmp" }, [decodedCell, originalCell]);
  const canvasHolder = el("div", { className: "panel" }, [cmpRow]); // transport appended below the videos
  const setReference = (src: string) => { refVideo.src = src; refVideo.currentTime = 0; originalCell.style.display = ""; };
  const clearReference = () => { refVideo.removeAttribute("src"); refVideo.load(); originalCell.style.display = "none"; };
  const stats = el("div", { className: "mono muted", textContent: "Load an audio file (or pick a device)." });
  const warn = el("div", { className: "danger" }); // only populated on real problems → make it stand out

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

  // ── FILE: a self-paced transport drives real-time decoding of in-memory samples ──
  let samples: Float32Array | null = null;
  let fileRate = 44100;
  let playhead = 0;
  let fed = 0;
  let playing = false;
  let lastTick = 0;
  let loadedSampleIdx: number | null = D.input?.sampleIdx ?? null;
  let decTs = -1;          // content time (s) of the latest decoded frame; -1 = none yet
  let refSynced = false;   // has the "Original" been started for the current play segment
  let preparing = false;   // true while a sample is being (re)encoded on the fly

  const playBtn = el("button", { textContent: "▶ Play" }) as HTMLButtonElement;
  const seek = el("input", { type: "range", min: "0", max: "1000", value: "0" }) as HTMLInputElement;
  seek.style.flex = "1";
  const timeLabel = el("span", { className: "mono muted", textContent: "0.0s" });
  const transport = el("div", { className: "row" }, [playBtn, seek, timeLabel]);
  transport.style.display = "none";

  function reseek(pos: number) {
    buildPipeline(fileRate); playhead = pos; fed = pos; decTs = -1; refSynced = false;
    while (frameQueue.length) frameQueue.shift()!.close();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height); // start fresh (not the stale last frame) on load / replay / scrub
    if (refVideo.getAttribute("src") && refVideo.duration && samples) refVideo.currentTime = Math.max(0, Math.min(refVideo.duration, (pos / samples.length) * refVideo.duration));
  }
  playBtn.onclick = () => {
    if (!samples) return;
    playing = !playing;
    playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
    lastTick = performance.now();
    if (playing && playhead >= samples.length) reseek(0); // replay from start
  };
  seek.oninput = () => { if (samples) reseek(Math.floor((parseInt(seek.value) / 1000) * samples.length)); };

  const fileIn = el("input", { type: "file", accept: "audio/wav,.wav" }) as HTMLInputElement;
  const loadWav = (buf: ArrayBuffer) => {
    warn.textContent = "";
    const dec = decodeWav(buf);
    samples = dec.samples; fileRate = dec.sampleRate;
    reseek(0); playing = false; playBtn.textContent = "▶ Play";
    transport.style.display = ""; // status is shown by the loop ("Ready — press Play" / "Decoding…")
  };
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    D.input = { wav: f, name: f.name, referenceUrl: null, sampleIdx: null };
    loadedSampleIdx = null; clearReference();
    loadWav(await f.arrayBuffer());
  };

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
    } catch { deviceSel.append(el("option", { value: "", textContent: "(allow microphone access to list devices)" })); }
  };
  deviceSel.onchange = () => (deviceId = deviceSel.value || undefined);
  const liveStart = el("button", { textContent: "▶ Start" }) as HTMLButtonElement;
  const liveStop = el("button", { className: "secondary", textContent: "■ Stop" }) as HTMLButtonElement;
  liveStart.onclick = async () => {
    stopAll();
    const cap = new Capture(); liveCap = cap; liveOn = true;
    try {
      await cap.start(deviceId, s.sampleRate, (smp: Float32Array) => { if (!ds) return; meters.push(smp); try { for (const b of ds.feedAudio(smp)) handle(b.seq, b.payload); } catch (err) { warn.textContent = "Decode error: " + (err as Error).message; stopAll(); } });
      buildPipeline(cap.sampleRate); // build at the rate actually achieved
    } catch (e) { liveCap = null; liveOn = false; warn.textContent = "Couldn't start the audio input: " + (e as Error).message; }
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
      // Time-box the synchronous decode per frame (not a fixed sample budget):
      // low-data-rate profiles pack many FFTs per audio-second, which would block
      // the frame and freeze the page. Capping by wall-clock degrades to
      // slower-than-real-time playback instead of locking up.
      const deadline = performance.now() + 8;
      const target = Math.floor(playhead);
      while (fed < target && performance.now() < deadline) {
        const end = Math.min(fed + 4096, target);
        const chunk = samples.subarray(fed, end);
        meters.push(chunk);
        try { for (const b of ds.feedAudio(chunk)) handle(b.seq, b.payload); }
        catch (err) { warn.textContent = "Decode error: " + (err as Error).message + " — check the modem settings."; playing = false; break; }
        fed = end;
      }
      seek.value = String(Math.floor((playhead / samples.length) * 1000));
      timeLabel.textContent = `${(playhead / fileRate).toFixed(1)}s`;
    }
    while (frameQueue.length > 1) frameQueue.shift()!.close();
    const f = frameQueue.shift();
    if (f) {
      if (canvas.width !== f.displayWidth) canvas.width = f.displayWidth;
      if (canvas.height !== f.displayHeight) canvas.height = f.displayHeight;
      ctx2d.drawImage(f, 0, 0);
      if (isFinite(f.timestamp)) decTs = f.timestamp / 1e6; // latest decoded content time
      f.close();
    }
    // The "Original" stays paused through the preamble, then starts at the first
    // real decoded frame and plays at true 1× — no rate-matching, so any gradual
    // drift between the panes honestly shows whether the tape keeps up with
    // real-time (decoded behind = too slow for the channel; ahead = headroom).
    if (refVideo.getAttribute("src") && refVideo.readyState >= 1) {
      const active = sourceMode === "file" && playing;
      if (!active) { if (!refVideo.paused) refVideo.pause(); }
      else if (decTs >= 0) {
        if (!refSynced) { refVideo.currentTime = decTs; refSynced = true; }
        if (refVideo.paused) refVideo.play().catch(() => {});
      }
    }
    meters.draw(metersCanvas, blocks > 0);
    if (!preparing) {
      if (blocks > 0) { stats.textContent = `Decoding — ${blocks} chunk${blocks === 1 ? "" : "s"} recovered.`; stats.className = "mono muted"; }
      else if (sourceMode === "file" && samples && fed > 2 * fileRate) { stats.textContent = "No picture decoded — if this is your own recording, the Profile must match the one it was encoded with (or Load its .cassette config)."; stats.className = "mono notice"; }
      else if (liveOn) { stats.textContent = "Listening for a signal…"; stats.className = "mono muted"; }
      else if (sourceMode === "file" && samples) { stats.textContent = "Ready — press ▶ Play."; stats.className = "mono muted"; }
    }
    decodeRaf = requestAnimationFrame(loop);
  }
  decodeRaf = requestAnimationFrame(loop);
  // tear-down hook used by render() when leaving/refreshing this view, so the
  // loop, mic capture and video decoder don't leak when you switch tabs.
  teardownDecode = () => { cancelAnimationFrame(decodeRaf); liveCap?.stop(); liveCap = null; liveOn = false; if (vdec) { vdec.close(); vdec = null; } while (frameQueue.length) frameQueue.shift()!.close(); };

  // ── source toggle + profile + config ──
  const srcRow = el("div", { className: "row" });
  const liveRow = el("div", { className: "row" }, [deviceSel, liveStart, liveStop]);
  const drawSrc = () => {
    srcRow.innerHTML = "";
    srcRow.append(el("label", { textContent: "Source" }));
    for (const m of ["file", "live"] as const) {
      const b = el("button", { className: "secondary" + (sourceMode === m ? " active" : ""), textContent: m === "file" ? "Audio file" : "Audio device" });
      b.onclick = async () => { stopAll(); sourceMode = m; D.sourceMode = m; if (m === "live") await refreshDevices(); drawSrc(); };
      srcRow.append(b);
    }
    srcRow.append(sourceMode === "file" ? fileIn : el("span"));
    liveRow.style.display = sourceMode === "live" ? "" : "none";
    transport.style.display = sourceMode === "file" && samples ? "" : "none";
  };
  drawSrc();

  const profileSel = el("select") as HTMLSelectElement;
  PROFILES.forEach((p, i) => profileSel.append(el("option", { value: String(i), textContent: p.name, selected: i === D.profileIdx })));
  // Changing profile keeps the loaded audio and re-decodes in place (no full
  // re-render). For a bundled sample we re-encode it under the new profile — a
  // tape only decodes with the profile it was made with.
  profileSel.onchange = () => {
    D.profileIdx = parseInt(profileSel.value);
    Object.assign(s, freshSettings(D.profileIdx)); // mutate in place so the pipeline's `s` stays valid
    const fresh = settingsPanel(s, reapply, { hideSampleRate: true });
    panel.replaceWith(fresh); panel = fresh;
    if (loadedSampleIdx !== null) loadSampleTape().catch((e) => (warn.textContent = "Couldn't prepare sample: " + (e as Error).message));
    else if (samples) reseek(0);
  };
  const reapply = () => { if (samples) reseek(Math.floor(playhead)); };

  // encode the selected bundled clip with the current profile, then decode+play it
  async function loadSampleTape() {
    const sm = SAMPLES[state.sampleIdx];
    loadedSampleIdx = state.sampleIdx;
    sourceMode = "file"; D.sourceMode = "file"; drawSrc();
    preparing = true;
    stats.textContent = `Preparing "${sm.label}" (${PROFILES[D.profileIdx].name}) — encoding…`;
    try {
      const blob = await (await fetch(`${SAMPLE_BASE}${sm.file}`)).blob();
      const file = new File([blob], sm.file, { type: "video/mp4" });
      const { wav } = await encodeFileToWav(file, s, freshVideo(D.profileIdx), true);
      const buf = await wav.arrayBuffer();
      const referenceUrl = URL.createObjectURL(file);
      if (D.input?.referenceUrl && D.input.referenceUrl !== state.encoding?.sourceUrl) URL.revokeObjectURL(D.input.referenceUrl);
      D.input = { wav, name: sm.file.replace(/\.mp4$/, ".wav"), referenceUrl, sampleIdx: state.sampleIdx };
      setInputFile(fileIn, new File([buf], D.input.name, { type: "audio/wav" }));
      setReference(referenceUrl);
      loadWav(buf);
      playing = true; playBtn.textContent = "❚❚ Pause"; lastTick = performance.now(); // auto-play the demo
    } finally { preparing = false; }
  }

  const sampleTapeNote = el("span", { className: "muted" });
  const sampleTapeSel = sampleSelect(sampleTapeNote);
  const sampleTapeBtn = el("button", { className: "secondary", textContent: "▶ Try a sample tape" }) as HTMLButtonElement;
  sampleTapeBtn.onclick = () => loadSampleTape().catch((e) => (warn.textContent = "Couldn't prepare sample: " + (e as Error).message));

  const popBtn = el("button", { className: "secondary", textContent: "⧉ Pop out" });
  popBtn.onclick = async () => {
    const dpip = (window as any).documentPictureInPicture;
    if (!dpip) { warn.textContent = "Pop-out needs Document Picture-in-Picture (Chrome/Edge)."; return; }
    const win = await dpip.requestWindow({ width: 512, height: 288 });
    win.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center";
    win.document.body.append(canvas);
    win.addEventListener("pagehide", () => decodedCell.append(canvas));
  };

  // optional: attach any video as the "Original" for comparison (for your own WAVs)
  const refIn = el("input", { type: "file", accept: "video/*" }) as HTMLInputElement;
  refIn.style.display = "none";
  refIn.onchange = () => { const f = refIn.files?.[0]; if (f) { const u = URL.createObjectURL(f); if (D.input) D.input.referenceUrl = u; setReference(u); } };
  const refBtn = el("button", { className: "secondary", textContent: "Compare with original…" });
  refBtn.onclick = () => refIn.click();

  let panel = settingsPanel(s, reapply, { hideSampleRate: true });
  app.append(
    el("div", { className: "panel" }, [
      el("div", { className: "row" }, [el("label", { textContent: "Profile" }), profileSel, loadConfigButton()]),
      srcRow,
      el("div", { className: "row" }, [el("label", { textContent: "Sample tape" }), sampleTapeSel, sampleTapeBtn]),
      el("div", { className: "row" }, [sampleTapeNote]),
      liveRow,
      el("p", { className: "muted", textContent: "Decode a tape back to video. The Profile must match the one it was encoded with (or Load its .cassette config); then choose the WAV and press Play — it decodes in real time, and you can scrub to start anywhere." }),
      panel,
    ]),
    el("div", { className: "panel" }, [el("div", { className: "row" }, [popBtn, refBtn, refIn]), stats, warn, el("p", { className: "muted", textContent: "Signal: green = locked on and decoding · amber = hearing something but not locked on · grey = silence" }), metersCanvas]),
    canvasHolder,
  );
  canvasHolder.append(transport); // play bar sits below the two videos

  // restore the persisted decode input (the encoding, a sample, or a loaded WAV)
  if (D.input && sourceMode === "file") {
    const inp = D.input;
    const wantAutoplay = decodeAutoplay; decodeAutoplay = false;
    setInputFile(fileIn, new File([inp.wav], inp.name, { type: "audio/wav" }));
    if (inp.referenceUrl) setReference(inp.referenceUrl);
    (async () => {
      loadWav(await inp.wav.arrayBuffer());
      if (wantAutoplay) { playing = true; playBtn.textContent = "❚❚ Pause"; lastTick = performance.now(); }
    })();
  }
}

render();
