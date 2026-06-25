import { describe, it, expect } from "vitest";
import vectors from "./vectors.json";
import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings, Method } from "../src/dsp/settings";
import { encodeStream, decodeMetadataPayload } from "../src/dsp/modem";
import { DecoderState } from "../src/dsp/decoderState";

function decodeAll(audio: Float64Array, s: ModemSettings): Map<number, Uint8Array> {
  const ds = new DecoderState(s);
  const data = new Map<number, Uint8Array>();
  for (let i = 0; i < audio.length; i += 4096) {
    for (const blk of ds.feedAudio(audio.subarray(i, i + 4096))) {
      if (blk.seq !== METADATA_SEQ) data.set(blk.seq, blk.payload);
    }
  }
  return data;
}

function reassemble(data: Map<number, Uint8Array>, blockSize: number, len: number): Uint8Array {
  if (data.size === 0) return new Uint8Array(0);
  const maxSeq = Math.max(...data.keys());
  const out: number[] = [];
  for (let i = 0; i <= maxSeq; i++) {
    const p = data.get(i) ?? new Uint8Array(blockSize);
    for (const b of p) out.push(b);
  }
  return Uint8Array.from(out.slice(0, len));
}

describe("full modem round-trip (TS encode → streaming decode)", () => {
  for (const method of ["fsk", "fsk4", "dpsk", "ofdm"] as Method[]) {
    it(`${method}: recovers the payload bit-exact`, () => {
      const s: ModemSettings = { ...DEFAULT_SETTINGS, method };
      const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
      const audio = encodeStream(payload, s, { width: 256, height: 144, fps: 15 });
      const data = decodeAll(audio, s);
      expect(Array.from(reassemble(data, s.blockDataSize, payload.length))).toEqual(Array.from(payload));
    });
  }
});

describe("constant-power carrier (AGC defeat) round-trips for FSK/DPSK", () => {
  for (const method of ["fsk", "dpsk"] as Method[]) {
    it(`${method} + constant_power recovers the payload`, () => {
      const s: ModemSettings = { ...DEFAULT_SETTINGS, method, constantPower: true };
      const payload = Uint8Array.from({ length: 250 }, (_, i) => (i * 53) % 256);
      const audio = encodeStream(payload, s);
      const data = decodeAll(audio, s);
      expect(Array.from(reassemble(data, s.blockDataSize, payload.length))).toEqual(Array.from(payload));
    });
  }
});

describe("cross-validation: TS decodes Python-encoded OFDM audio", () => {
  it("recovers the payload from the Python e2e audio vector", () => {
    const v = vectors.ofdmE2E;
    const s: ModemSettings = { ...DEFAULT_SETTINGS, method: "ofdm", blockDataSize: v.settings.blockDataSize, preambleMs: v.settings.preambleMs, reedSolomon: true, rsNsym: v.settings.rsNsym };
    const audio = Float64Array.from(v.audio);
    const data = decodeAll(audio, s);
    expect(Array.from(reassemble(data, s.blockDataSize, v.payload.length))).toEqual(v.payload);
  });
});

describe("metadata", () => {
  it("decodeMetadataPayload reads the encoded video params", () => {
    const s: ModemSettings = { ...DEFAULT_SETTINGS, method: "fsk" };
    const audio = encodeStream(Uint8Array.from({ length: 64 }, (_, i) => i), s, { width: 256, height: 144, fps: 15 });
    const ds = new DecoderState(s);
    let meta: Record<string, unknown> | null = null;
    for (let i = 0; i < audio.length; i += 4096) {
      for (const blk of ds.feedAudio(audio.subarray(i, i + 4096))) {
        if (blk.seq === METADATA_SEQ) meta = decodeMetadataPayload(blk.payload);
      }
    }
    expect(meta).not.toBeNull();
    expect((meta!.video as any).width).toBe(256);
  });
});
