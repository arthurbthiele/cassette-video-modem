// WebCodecs video encode → container bytes. Browser-only (uses VideoEncoder).
// Encode is offline (not real-time), so it can run as fast as the CPU allows.

import { packConfig, packFrame } from "./container";

export interface VideoEncodeOptions {
  codec: string; // e.g. "av01.0.01M.08", "vp09.00.10.08", "avc1.42001E"
  width: number;
  height: number;
  framerate: number;
  bitrate: number; // bits/sec — from videoBitrateBudget()
  gopSeconds: number;
}

function descriptionBytes(desc: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!desc) return undefined;
  if (ArrayBuffer.isView(desc)) return new Uint8Array(desc.buffer as ArrayBuffer, desc.byteOffset, desc.byteLength);
  return new Uint8Array(desc as ArrayBuffer);
}

/** Encode a sequence of frames into the modem container byte stream. The codec
 * config is re-emitted before every key frame so a decoder can join mid-stream. */
export async function encodeFramesToContainer(frames: Iterable<VideoFrame>, opts: VideoEncodeOptions): Promise<Uint8Array> {
  const chunks: { bytes: Uint8Array; key: boolean; ts: number }[] = [];
  let decoderConfig: VideoDecoderConfig | null = null;

  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push({ bytes: b, key: chunk.type === "key", ts: chunk.timestamp });
    },
    error: (e) => { throw e; },
  });
  enc.configure({ codec: opts.codec, width: opts.width, height: opts.height, bitrate: opts.bitrate, framerate: opts.framerate });

  const gop = Math.max(1, Math.round(opts.gopSeconds * opts.framerate));
  let i = 0;
  for (const frame of frames) {
    enc.encode(frame, { keyFrame: i % gop === 0 });
    i++; // caller owns the frames (so they can be re-encoded to fit the channel)
  }
  await enc.flush();
  enc.close();

  // (cast: TS control-flow doesn't track the assignment inside output())
  const dc = decoderConfig as VideoDecoderConfig | null;
  const cfgBytes = packConfig(dc?.codec ?? opts.codec, descriptionBytes(dc?.description));
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.key) parts.push(cfgBytes); // re-send config at every GOP boundary
    parts.push(packFrame(c.key, c.ts, c.bytes));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface FitResult {
  container: Uint8Array;
  bitrate: number; // final encoder target used
  attempts: number;
  containerBitsPerSec: number;
  fits: boolean; // container rate ≤ channel net rate
}

/** Encode the frames, iterating the target bitrate down until the encoded
 * stream fits the channel's net throughput — so playback stays real-time.
 * The encoder (esp. AV1) overshoots low targets, so one pass isn't enough. */
export async function encodeToFitChannel(
  frames: VideoFrame[],
  opts: Omit<VideoEncodeOptions, "bitrate">,
  startBitrate: number,
  netBitsPerSec: number,
  maxAttempts = 4,
): Promise<FitResult> {
  const durationSec = frames.length / opts.framerate;
  const target = netBitsPerSec * 0.92; // leave headroom for modem framing + jitter
  let bitrate = Math.min(startBitrate, Math.floor(target));
  let container: Uint8Array = new Uint8Array(0);
  let attempts = 0;
  let containerBitsPerSec = 0;
  for (; attempts < maxAttempts; attempts++) {
    container = await encodeFramesToContainer(frames, { ...opts, bitrate });
    containerBitsPerSec = (container.length * 8) / durationSec;
    if (containerBitsPerSec <= target) break;
    // overshot — scale the target down proportionally and retry
    bitrate = Math.max(1000, Math.floor(bitrate * (target / containerBitsPerSec) * 0.95));
  }
  return { container, bitrate, attempts: attempts + 1, containerBitsPerSec, fits: containerBitsPerSec <= netBitsPerSec };
}
