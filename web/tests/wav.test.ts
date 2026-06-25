import { describe, it, expect } from "vitest";
import { encodeWav, decodeWav } from "../src/audio/wav";

describe("WAV", () => {
  it("round-trips samples within 16-bit quantisation", async () => {
    const sr = 44100;
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.1) * 0.9);
    const blob = encodeWav(samples, sr);
    const { samples: back, sampleRate } = decodeWav(await blob.arrayBuffer());
    expect(sampleRate).toBe(sr);
    expect(back.length).toBe(samples.length);
    let maxErr = 0;
    for (let i = 0; i < samples.length; i++) maxErr = Math.max(maxErr, Math.abs(samples[i] - back[i]));
    expect(maxErr).toBeLessThan(1e-4); // 16-bit quantisation (~1 LSB + 32767/32768 scale)
  });

  it("writes a valid 44-byte header", async () => {
    const blob = encodeWav(Float32Array.of(0, 0.5, -0.5), 48000);
    const dv = new DataView(await blob.arrayBuffer());
    const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getUint16(34, true)).toBe(16); // bits
  });
});
