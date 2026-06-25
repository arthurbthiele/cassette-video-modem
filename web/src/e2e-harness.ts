// Automated end-to-end validation, run in a real browser via Playwright.
// For every device profile: synthetic frames → WebCodecs encode → container →
// modem → WAV → modem decode → container → WebCodecs decode → frames. Asserts
// the video round-trips, exercising the exact code paths the UI uses.

import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings } from "./dsp/settings";
import { encodeStream } from "./dsp/modem";
import { DecoderState } from "./dsp/decoderState";
import { netBitsPerSec, videoBitrateBudget } from "./video/budget";
import { encodeToFitChannel } from "./video/encoder";
import { StreamVideoDecoder } from "./video/decoder";
import { ContainerParser } from "./video/container";
import { encodeWav, decodeWav } from "./audio/wav";
import { PROFILES, applyProfile } from "./profiles";

const out = document.getElementById("out")!;
const CODEC = "av01.0.01M.08";
const SECONDS = 2;

function makeFrames(w: number, h: number, fps: number, n: number): { frames: VideoFrame[]; orig: Uint8ClampedArray[] } {
  const cvs = new OffscreenCanvas(w, h);
  const ctx = cvs.getContext("2d")!;
  const frames: VideoFrame[] = [];
  const orig: Uint8ClampedArray[] = [];
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = `hsl(${(i * 18) % 360} 70% 45%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(10, h / 5)}px sans-serif`;
    ctx.fillText("F" + i, 4, h / 2);
    orig.push(ctx.getImageData(0, 0, w, h).data.slice());
    frames.push(new VideoFrame(cvs, { timestamp: Math.round((i * 1e6) / fps) }));
  }
  return { frames, orig };
}

async function runProfile(name: string, settings: Partial<ModemSettings>, video: { width: number; height: number; fps: number }) {
  const s: ModemSettings = applyProfile({ ...DEFAULT_SETTINGS }, { name, description: "", settings, video });
  const n = video.fps * SECONDS;
  const { frames } = makeFrames(video.width, video.height, video.fps, n);
  const fit = await encodeToFitChannel(frames, { codec: CODEC, width: video.width, height: video.height, framerate: video.fps, gopSeconds: 1 }, videoBitrateBudget(s, { fillFactor: 0.9 }), netBitsPerSec(s));
  frames.forEach((f) => f.close());

  const audio = Float32Array.from(encodeStream(fit.container, s, { width: video.width, height: video.height, fps: video.fps }));
  const wav = encodeWav(audio, s.sampleRate);
  const { samples } = decodeWav(await wav.arrayBuffer());

  // decode exactly as the UI does
  const ds = new DecoderState(s);
  const parser = new ContainerParser();
  let blocks = 0, framesDecoded = 0;
  const vdec = new StreamVideoDecoder(() => framesDecoded++, () => {});
  for (let i = 0; i < samples.length; i += 4096)
    for (const b of ds.feedAudio(samples.subarray(i, i + 4096)))
      if (b.seq !== METADATA_SEQ) { blocks++; vdec.pushRecords(parser.push(b.payload)); }
  await vdec.flush();
  vdec.close();

  const audioSecs = audio.length / s.sampleRate;
  return {
    pass: blocks > 0 && framesDecoded > 0,
    blocks, framesDecoded, framesIn: n,
    fits: fit.fits, ratio: +(audioSecs / SECONDS).toFixed(2),
    kbps: +(fit.containerBitsPerSec / 1000).toFixed(1),
    res: `${video.width}x${video.height}@${video.fps}`,
    method: s.method, cp: s.constantPower,
  };
}

(async () => {
  const results: Record<string, any> = {};
  for (const p of PROFILES) {
    out.textContent = `running ${p.name}…`;
    try { results[p.name] = await runProfile(p.name, p.settings, p.video); }
    catch (e) { results[p.name] = { pass: false, error: String(e) }; }
  }
  const allPass = Object.values(results).every((r: any) => r.pass);
  out.textContent = (allPass ? "ALL PROFILES PASS\n\n" : "SOME PROFILES FAILED\n\n") + JSON.stringify(results, null, 2);
  (window as any).__e2e = { allPass, results };
})();
