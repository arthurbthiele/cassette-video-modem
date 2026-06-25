// Browser integration test (run via Playwright): synthetic video frames →
// WebCodecs encode → container → modem audio → streaming decode → container →
// WebCodecs decode → frames. Verifies the whole video path end-to-end.

import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings } from "./dsp/settings";
import { encodeStream } from "./dsp/modem";
import { DecoderState } from "./dsp/decoderState";
import { encodeToFitChannel } from "./video/encoder";
import { StreamVideoDecoder } from "./video/decoder";
import { ContainerParser } from "./video/container";
import { videoBitrateBudget, netBitsPerSec } from "./video/budget";
import { encodeWav, decodeWav } from "./audio/wav";

const CODEC = "av01.0.01M.08"; // AV1
const W = 128, H = 96, FPS = 10, N = 30;

function imageData(ctx: OffscreenCanvasRenderingContext2D): Uint8ClampedArray {
  return ctx.getImageData(0, 0, W, H).data;
}

async function run() {
  const cvs = new OffscreenCanvas(W, H);
  const ctx = cvs.getContext("2d")!;
  const frames: VideoFrame[] = [];
  const orig: Uint8ClampedArray[] = [];
  for (let i = 0; i < N; i++) {
    ctx.fillStyle = `hsl(${(i * 12) % 360} 70% 40%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.font = "20px sans-serif";
    ctx.fillText("F" + i, 5 + (i * 2) % 80, 50);
    orig.push(imageData(ctx).slice());
    frames.push(new VideoFrame(cvs, { timestamp: Math.round((i * 1e6) / FPS) }));
  }

  const s: ModemSettings = { ...DEFAULT_SETTINGS, method: "ofdm", blockDataSize: 256, preambleMs: 100 };
  const start = videoBitrateBudget(s, { fillFactor: 0.9 });
  const fit = await encodeToFitChannel(frames, { codec: CODEC, width: W, height: H, framerate: FPS, gopSeconds: 1 }, start, netBitsPerSec(s));
  frames.forEach((f) => f.close());
  const container = fit.container;

  const audio = encodeStream(container, s);

  // Go through the WAV round-trip exactly like the UI's file path.
  const wavBlob = encodeWav(Float32Array.from(audio), s.sampleRate);
  const { samples } = decodeWav(await wavBlob.arrayBuffer());

  const ds = new DecoderState(s);
  const data = new Map<number, Uint8Array>();
  for (let i = 0; i < samples.length; i += 4096)
    for (const blk of ds.feedAudio(samples.subarray(i, i + 4096)))
      if (blk.seq !== METADATA_SEQ) data.set(blk.seq, blk.payload);
  const maxSeq = data.size ? Math.max(...data.keys()) : -1;
  const bytesArr: number[] = [];
  for (let i = 0; i <= maxSeq; i++) {
    const p = data.get(i) ?? new Uint8Array(s.blockDataSize);
    for (const b of p) bytesArr.push(b);
  }
  const recovered = Uint8Array.from(bytesArr).subarray(0, container.length);

  let containerByteExact = recovered.length === container.length;
  for (let i = 0; containerByteExact && i < container.length; i++) if (recovered[i] !== container[i]) containerByteExact = false;

  const decoded: Uint8ClampedArray[] = [];
  const dec = new StreamVideoDecoder((f) => {
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext("2d")!;
    cx.drawImage(f, 0, 0);
    decoded.push(cx.getImageData(0, 0, W, H).data.slice());
    f.close();
  });
  dec.pushRecords(new ContainerParser().push(recovered));
  await dec.flush();

  let meanDiff = -1;
  if (decoded.length) {
    let sum = 0, cnt = 0;
    const n = Math.min(decoded.length, orig.length);
    for (let f = 0; f < n; f++) for (let k = 0; k < orig[f].length; k++) { sum += Math.abs(orig[f][k] - decoded[f][k]); cnt++; }
    meanDiff = sum / cnt;
  }

  const audioSeconds = audio.length / s.sampleRate;
  const result = { containerLen: container.length, recoveredLen: recovered.length, containerByteExact, framesIn: N, framesOut: decoded.length, audioSeconds: +audioSeconds.toFixed(2), videoSeconds: N / FPS, realtimeRatio: +(audioSeconds / (N / FPS)).toFixed(2), fits: fit.fits, fitAttempts: fit.attempts, finalBitrate: fit.bitrate, meanPixelDiff: +meanDiff.toFixed(2) };
  (window as any).__result = result;
  document.getElementById("out")!.textContent = JSON.stringify(result, null, 2);
}

run().catch((e) => {
  (window as any).__result = { error: String(e) };
  document.getElementById("out")!.textContent = "ERROR: " + String(e);
});
