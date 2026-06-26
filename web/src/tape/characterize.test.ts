// Validates the analyzer against GROUND TRUTH: render the test signal, push it
// through the channel simulator with KNOWN impairments, and assert the analyzer
// recovers them. No real tape needed — simulateChannel is the oracle.

import { describe, it, expect } from "vitest";
import { generateTestSignal } from "./generate";
import { analyzeCapture } from "./analyze";
import { simulateChannel } from "../dsp/channel";
import { SR, LAYOUT } from "./layout";

const gen = generateTestSignal();
const seg = (r: ReturnType<typeof analyzeCapture>, id: string) => r.segments.find((s) => s.id === id)!;

describe("tape characterization analyzer", () => {
  it("clean round-trip: all markers, ~no impairment, methods decode fully", () => {
    const r = analyzeCapture(gen.samples, gen.sr);
    expect(r.markersFound).toBe(r.markersExpected);
    expect(r.markersExpected).toBe(LAYOUT.length + 1);
    expect(r.speedRatioPct).toBeGreaterThan(98);
    expect(r.speedRatioPct).toBeLessThan(102);

    const tone = seg(r, "ref1k");
    expect(Number(tone.metrics.measuredFreqHz)).toBeGreaterThan(990);
    expect(Number(tone.metrics.measuredFreqHz)).toBeLessThan(1010);
    expect(Number(tone.metrics.wowFlutterPct)).toBeLessThan(0.5); // essentially flat
    expect(Number(tone.metrics.snrDb)).toBeGreaterThan(40);

    // every method segment decodes all its blocks on a clean channel
    for (const id of ["ofdm-narrow", "ofdm-wide", "dpsk"]) {
      const m = seg(r, id);
      expect(Number(m.metrics.successPct)).toBeGreaterThanOrEqual(100);
    }

    expect(seg(r, "agc").metrics.agcDetected).toBe("no");
  });

  it("band-limit @3kHz: response rolls off near 3 kHz and the wide OFDM suffers", () => {
    const ch = simulateChannel(gen.samples, { sampleRate: SR, bandLowHz: 300, bandHighHz: 3000, snrDb: 45 });
    const r = analyzeCapture(ch, SR);
    const sweep = seg(r, "sweep");
    // strong at 1 kHz, much weaker at 4 kHz (above the 3 kHz cut)
    expect(Number(sweep.metrics.respDb_1000)).toBeGreaterThan(Number(sweep.metrics.respDb_4000) + 8);
    expect(Number(sweep.metrics.minus6dbHz)).toBeLessThan(4000);
    // the 500–6000 OFDM relies on carriers past 3 kHz → it should lose ground vs the narrow one
    expect(Number(seg(r, "ofdm-wide").metrics.successPct)).toBeLessThan(Number(seg(r, "ofdm-narrow").metrics.successPct) + 1);
  });

  it("wow/flutter: elevated pitch wander is detected", () => {
    const ch = simulateChannel(gen.samples, { sampleRate: SR, wowDepth: 0.006, wowRateHz: 1.5, flutterDepth: 0.003, flutterRateHz: 9, snrDb: 50 });
    const r = analyzeCapture(ch, SR);
    const tone = seg(r, "ref1k");
    const clean = analyzeCapture(gen.samples, gen.sr);
    // wander is clearly above the clean floor and in a plausible range (~0.3–3%)
    expect(Number(tone.metrics.wowFlutterPct)).toBeGreaterThan(Number(seg(clean, "ref1k").metrics.wowFlutterPct) + 0.3);
    expect(Number(tone.metrics.wowFlutterPct)).toBeGreaterThan(0.3);
  });

  it("AGC: a deck whose gain chases the level is flagged", () => {
    const ch = simulateChannel(gen.samples, { sampleRate: SR, agc: true, agcTargetRms: 0.2, agcAttackMs: 10, agcReleaseMs: 150, snrDb: 45 });
    const r = analyzeCapture(ch, SR);
    expect(seg(r, "agc").metrics.agcDetected).toBe("yes");
    expect(Number(seg(r, "agc").metrics.compressionDb)).toBeGreaterThan(5);
  });

  it("noise floor: a noisy channel raises the measured floor and lowers tone SNR", () => {
    const clean = analyzeCapture(gen.samples, gen.sr);
    const ch = simulateChannel(gen.samples, { sampleRate: SR, snrDb: 22 });
    const r = analyzeCapture(ch, SR);
    expect(Number(seg(r, "noise").metrics.noiseFloorDbfs)).toBeGreaterThan(Number(seg(clean, "noise").metrics.noiseFloorDbfs) + 10);
    expect(Number(seg(r, "ref1k").metrics.snrDb)).toBeLessThan(45);
  });
});
