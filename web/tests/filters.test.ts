import { describe, it, expect } from "vitest";
import vectors from "./vectors.json";
import { butter, lfilter } from "../src/dsp/filters";

describe("Butterworth design", () => {
  for (const [name, c] of Object.entries(vectors.butter)) {
    const v = c as { N: number; Wn: number; btype: "low" | "high"; b: number[]; a: number[] };
    it(`butter matches scipy: ${name}`, () => {
      const r = butter(v.N, v.Wn, v.btype);
      expect(r.b.length).toBe(v.b.length);
      for (let i = 0; i < v.b.length; i++) expect(r.b[i]).toBeCloseTo(v.b[i], 9);
      for (let i = 0; i < v.a.length; i++) expect(r.a[i]).toBeCloseTo(v.a[i], 9);
    });
  }
  it("lfilter matches scipy", () => {
    const v = vectors.lfilter;
    const { y } = lfilter(v.b, v.a, v.x);
    let maxErr = 0;
    for (let i = 0; i < v.y.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - v.y[i]));
    expect(maxErr).toBeLessThan(1e-7);
  });
});
