// Synthesises the tape-characterisation test signal described declaratively in
// layout.ts. Pure TypeScript (no browser/WebCodecs APIs) so it runs in vitest.
//
// Output layout: MARKER, seg[0], MARKER, seg[1], …, MARKER, seg[N-1], MARKER —
// a chirp marker before every segment plus one trailing marker. The analyzer
// re-finds segments by matched-filtering for the markers; the returned manifest
// (sample offsets) is for validation/reference only.

import {
  SR,
  MARKER,
  LAYOUT,
  Segment,
  SegKind,
  ToneSeg,
  SweepSeg,
  TwoToneSeg,
  AgcSeg,
  MethodSeg,
  SilenceSeg,
  methodSettings,
  methodData,
} from "./layout";
import { encodeStream } from "../dsp/modem";

export interface GenSegment {
  id: string;
  kind: SegKind;
  startSample: number;
  endSample: number;
}

export interface GenResult {
  samples: Float32Array;
  sr: number;
  manifest: GenSegment[];
  markerPositions: number[];
}

const FADE_SEC = 0.005;

/** Apply a raised-cosine fade-in/out of `fadeSec` to both ends of `buf` in place. */
function applyFades(buf: Float64Array, fadeSec: number): void {
  const fadeSamples = Math.min(Math.floor(fadeSec * SR), Math.floor(buf.length / 2));
  for (let i = 0; i < fadeSamples; i++) {
    const gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    buf[i] *= gain;
    buf[buf.length - 1 - i] *= gain;
  }
}

function renderMarker(): Float64Array {
  const n = Math.round(MARKER.durSec * SR);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    const freq = MARKER.f0 + (MARKER.f1 - MARKER.f0) * frac;
    out[i] = MARKER.amp * Math.sin(phase);
    phase += (2 * Math.PI * freq) / SR;
  }
  applyFades(out, FADE_SEC);
  return out;
}

function renderSilence(seg: SilenceSeg): Float64Array {
  return new Float64Array(Math.round(seg.durSec * SR));
}

function renderTone(seg: ToneSeg): Float64Array {
  const n = Math.round(seg.durSec * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = seg.amp * Math.sin((2 * Math.PI * seg.freq * i) / SR);
  }
  applyFades(out, FADE_SEC);
  return out;
}

function renderSweep(seg: SweepSeg): Float64Array {
  const n = Math.round(seg.durSec * SR);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const freq = seg.f0 * Math.pow(seg.f1 / seg.f0, t / seg.durSec);
    out[i] = seg.amp * Math.sin(phase);
    phase += (2 * Math.PI * freq) / SR;
  }
  applyFades(out, FADE_SEC);
  return out;
}

function renderTwoTone(seg: TwoToneSeg): Float64Array {
  const n = Math.round(seg.durSec * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = seg.amp * Math.sin(2 * Math.PI * seg.f1 * t) + seg.amp * Math.sin(2 * Math.PI * seg.f2 * t);
  }
  applyFades(out, FADE_SEC);
  return out;
}

function renderAgc(seg: AgcSeg): Float64Array {
  let total = 0;
  for (const step of seg.steps) total += Math.round(step.durSec * SR);
  const out = new Float64Array(total);
  let off = 0;
  let phase = 0;
  for (const step of seg.steps) {
    const stepLen = Math.round(step.durSec * SR);
    for (let i = 0; i < stepLen; i++) {
      out[off + i] = step.amp * Math.sin(phase);
      phase += (2 * Math.PI * seg.freq) / SR;
    }
    off += stepLen;
  }
  // Fades only at the very start and end — the inter-step transitions stay abrupt
  // so the deck's AGC attack/release is visible.
  applyFades(out, FADE_SEC);
  return out;
}

function renderMethod(seg: MethodSeg): Float64Array {
  const s = methodSettings(seg);
  const data = methodData(seg);
  const audio = encodeStream(data, s);
  // encodeStream already normalises to ~0.95 peak; copy as-is (do NOT renormalise
  // per-segment in a way that breaks decoding).
  return audio;
}

function renderSegment(seg: Segment): Float64Array {
  switch (seg.kind) {
    case "silence":
      return renderSilence(seg);
    case "tone":
      return renderTone(seg);
    case "sweep":
      return renderSweep(seg);
    case "twotone":
      return renderTwoTone(seg);
    case "agc":
      return renderAgc(seg);
    case "method":
      return renderMethod(seg);
  }
}

export function generateTestSignal(): GenResult {
  const marker = renderMarker();
  const segmentBuffers = LAYOUT.map((seg) => ({ seg, buf: renderSegment(seg) }));

  // markers before each segment + one trailing marker
  let totalLength = marker.length * (LAYOUT.length + 1);
  for (const { buf } of segmentBuffers) totalLength += buf.length;

  const samples = new Float32Array(totalLength);
  const manifest: GenSegment[] = [];
  const markerPositions: number[] = [];

  let off = 0;
  const writeMarker = () => {
    markerPositions.push(off);
    samples.set(marker, off);
    off += marker.length;
  };

  for (const { seg, buf } of segmentBuffers) {
    writeMarker();
    const startSample = off;
    samples.set(buf, off);
    off += buf.length;
    manifest.push({ id: seg.id, kind: seg.kind, startSample, endSample: off });
  }
  writeMarker();

  return { samples, sr: SR, manifest, markerPositions };
}
