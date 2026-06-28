// Streaming decoder — feed real-time audio chunks, get decoded (seq, payload)
// blocks. Ported from the Python DecoderState: bit-level sync search across all
// phase offsets, one-symbol overlap for differential continuity, OFDM
// cyclic-prefix timing lock, optional carrier-strip / de-emphasis preprocessing.

import { ModemSettings } from "./settings";
import { bytesToBits, bitsToBytes } from "./bits";
import { SYNC_MAGIC, deframeBlock, blockWireSize } from "./framing";
import { demodulateRaw, carrierStripCut } from "./modem";
import { butter, lfilter } from "./filters";
import { ofdmCarriers, OfdmStreamDemod } from "./ofdm";

const SYNC_BITS = bytesToBits(SYNC_MAGIC); // 32 bits

export interface DecodedBlock {
  seq: number;
  payload: Uint8Array;
}

export class DecoderState {
  pauseThreshold = 0.008;
  pauseTimeout = 0.3;
  isPaused = false;

  private s: ModemSettings;
  private bits: number[] = [];
  private partial: Float64Array = new Float64Array(0);
  private prevTail: Float64Array | null = null;
  private lastSig = 0;
  private seen = new Set<number>();
  private sps: number;
  private bitsPerBlock: number;
  private ofdmDemod: OfdmStreamDemod | null = null;

  // filter state (carried across chunks)
  private hp: { b: number[]; a: number[]; zi: number[] } | null = null;
  private de: { b: number[]; a: number[]; zi: number[] } | null = null;

  constructor(s: ModemSettings) {
    this.s = s;
    this.sps = this.calcSps();
    this.bitsPerBlock = this.calcBitsPerBlock();
    if (s.method === "ofdm") this.ofdmDemod = new OfdmStreamDemod(ofdmParams(s));
    if (s.constantPower) {
      const cut = Math.min(0.95, carrierStripCut(s));
      if (cut > 0.002) {
        const { b, a } = butter(4, cut, "high");
        this.hp = { b, a, zi: new Array(Math.max(0, Math.max(a.length, b.length) - 1)).fill(0) };
      }
    }
    if (s.preEmphasis) {
      this.de = { b: [1], a: [1, -s.preEmphasisAlpha], zi: [0] };
    }
  }

  private calcSps(): number {
    const s = this.s;
    if (s.method === "fsk") return Math.max(1, Math.floor(s.sampleRate / s.fskBaud));
    if (s.method === "fsk4") return Math.max(1, Math.floor(s.sampleRate / s.fsk4Baud));
    if (s.method === "dpsk") return Math.max(1, Math.floor(s.sampleRate / s.dpskBaud));
    return s.ofdmFftSize + s.ofdmCpSize;
  }
  private calcBitsPerBlock(): number {
    const s = this.s;
    if (s.method === "fsk") return 1;
    if (s.method === "fsk4") return 2;
    if (s.method === "dpsk") return Math.log2(s.dpskPhases);
    return ofdmCarriers(ofdmParams(s)).data.length * Math.log2(s.ofdmPhases);
  }

  private preprocess(audio: Float64Array): Float64Array {
    let a = audio;
    if (this.hp) { const r = lfilter(this.hp.b, this.hp.a, a, this.hp.zi); a = r.y; this.hp.zi = r.zf; }
    if (this.de) { const r = lfilter(this.de.b, this.de.a, a, this.de.zi); a = r.y; this.de.zi = r.zf; }
    return a;
  }

  feedAudio(chunk: Float32Array | Float64Array): DecodedBlock[] {
    let rms = 0;
    for (let i = 0; i < chunk.length; i++) rms += chunk[i] * chunk[i];
    rms = Math.sqrt(rms / Math.max(1, chunk.length));
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    if (rms > this.pauseThreshold) { this.lastSig = now; this.isPaused = false; }
    else if (now - this.lastSig > this.pauseTimeout) { this.isPaused = true; return []; }

    // OFDM: per-symbol timing-tracking demodulator (survives wow/flutter)
    if (this.ofdmDemod) {
      const proc = this.preprocess(Float64Array.from(chunk));
      for (const b of this.ofdmDemod.push(proc)) this.bits.push(b);
      return this.extractBlocks();
    }

    const neu = concat(this.partial, Float64Array.from(chunk));
    const nc = Math.floor(neu.length / this.sps) * this.sps;
    this.partial = neu.slice(nc);
    if (nc === 0) return [];

    const proc = this.preprocess(neu.slice(0, nc));
    let bits: number[];
    if (this.prevTail) {
      bits = demodulateRaw(concat(this.prevTail, proc), this.s).slice(this.bitsPerBlock);
    } else {
      bits = demodulateRaw(proc, this.s);
    }
    this.prevTail = proc.slice(proc.length - this.sps);
    for (const b of bits) this.bits.push(b);
    return this.extractBlocks();
  }

  private findSync(start: number): number {
    const arr = this.bits;
    const L = SYNC_BITS.length;
    outer: for (let p = start; p + L <= arr.length; p++) {
      for (let i = 0; i < L; i++) if (arr[p + i] !== SYNC_BITS[i]) continue outer;
      return p;
    }
    return -1;
  }

  private extractBlocks(): DecodedBlock[] {
    const found: DecodedBlock[] = [];
    const neededBits = blockWireSize(this.s.blockDataSize, this.s.reedSolomon, this.s.rsNsym) * 8;
    let pos = 0;
    let consumed = 0;
    for (;;) {
      const idx = this.findSync(pos);
      if (idx === -1) { consumed = Math.max(0, this.bits.length - (SYNC_BITS.length - 1)); break; }
      if (idx + neededBits > this.bits.length) { consumed = idx; break; }
      const blockBytes = bitsToBytes(this.bits.slice(idx, idx + neededBits));
      const r = deframeBlock(blockBytes, this.s.reedSolomon, this.s.rsNsym);
      if (r) {
        if (this.seen.size > 8192) this.seen.clear(); // bound for long live sessions (dedup only needs recent seqs)
        if (!this.seen.has(r.seq)) { this.seen.add(r.seq); found.push({ seq: r.seq, payload: r.payload }); }
        consumed = idx + neededBits;
        pos = consumed;
      } else {
        pos = idx + 1;
      }
    }
    this.bits = this.bits.slice(consumed);
    return found;
  }
}

function concat(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function ofdmParams(s: ModemSettings) {
  return { sampleRate: s.sampleRate, fftSize: s.ofdmFftSize, cpSize: s.ofdmCpSize, fMin: s.ofdmFMin, fMax: s.ofdmFMax, pilotInterval: s.ofdmPilotInterval, phases: s.ofdmPhases, trackTiming: s.ofdmTrackTiming };
}
