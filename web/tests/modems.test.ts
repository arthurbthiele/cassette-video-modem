import { describe, it, expect } from "vitest";
import vectors from "./vectors.json";
import { modulateFsk4, demodulateFsk4 } from "../src/dsp/fsk4";
import { modulateDpsk, demodulateDpsk } from "../src/dsp/dpsk";
import { modulateOfdm, demodulateOfdm, ofdmCarriers } from "../src/dsp/ofdm";

function maxAbsDiff(a: Float64Array, b: number[]): number {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe("4-FSK", () => {
  const v = vectors.fsk4;
  const p = { sampleRate: v.params.sampleRate, baud: v.params.baud, freqs: v.params.freqs as [number, number, number, number] };
  it("modulate matches reference audio", () => {
    const a = modulateFsk4(Uint8Array.from(v.bytes), p);
    expect(a.length).toBe(v.audio.length);
    expect(maxAbsDiff(a, v.audio)).toBeLessThan(1e-6);
  });
  it("demodulate recovers reference bits", () => {
    const a = modulateFsk4(Uint8Array.from(v.bytes), p);
    expect(demodulateFsk4(a, p)).toEqual(v.demodBits);
  });
});

describe("DPSK", () => {
  const v = vectors.dpsk;
  const p = { sampleRate: v.params.sampleRate, baud: v.params.baud, carrier: v.params.carrier, phases: v.params.phases };
  it("modulate matches reference audio", () => {
    const a = modulateDpsk(Uint8Array.from(v.bytes), p);
    expect(a.length).toBe(v.audio.length);
    expect(maxAbsDiff(a, v.audio)).toBeLessThan(1e-6);
  });
  it("demodulate recovers reference bits", () => {
    const a = modulateDpsk(Uint8Array.from(v.bytes), p);
    expect(demodulateDpsk(a, p)).toEqual(v.demodBits);
  });
});

describe("OFDM", () => {
  const v = vectors.ofdm;
  const p = {
    sampleRate: v.params.sampleRate, fftSize: v.params.fftSize, cpSize: v.params.cpSize,
    fMin: v.params.fMin, fMax: v.params.fMax, pilotInterval: v.params.pilotInterval, phases: v.params.phases,
  };
  it("carrier split matches reference", () => {
    const c = ofdmCarriers(p);
    expect(c.data).toEqual(v.carriers.data);
    expect(c.pilots).toEqual(v.carriers.pilots);
  });
  it("modulate matches reference audio", () => {
    const a = modulateOfdm(Uint8Array.from(v.bytes), p);
    expect(a.length).toBe(v.audio.length);
    expect(maxAbsDiff(a, v.audio)).toBeLessThan(1e-5);
  });
  it("demodulate recovers reference bits", () => {
    const a = modulateOfdm(Uint8Array.from(v.bytes), p);
    expect(demodulateOfdm(a, p)).toEqual(v.demodBits);
  });
});
