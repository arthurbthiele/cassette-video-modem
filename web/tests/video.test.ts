import { describe, it, expect } from "vitest";
import vectors from "./vectors.json";
import { DEFAULT_SETTINGS, ModemSettings } from "../src/dsp/settings";
import { rawBitsPerSec, netBitsPerSec, videoBitrateBudget } from "../src/video/budget";
import { packConfig, packFrame, ContainerParser } from "../src/video/container";

describe("bitrate budget (vs Python calculate_bitrate)", () => {
  for (const [name, c] of Object.entries(vectors.bitrate)) {
    const v = c as any;
    it(`net/raw bps match: ${name}`, () => {
      const s: ModemSettings = { ...DEFAULT_SETTINGS, method: v.method, reedSolomon: v.reedSolomon, rsNsym: v.rsNsym, blockDataSize: v.blockDataSize };
      expect(rawBitsPerSec(s)).toBe(v.rawBps);
      expect(netBitsPerSec(s)).toBe(v.netBps);
    });
  }
  it("video budget stays under net throughput", () => {
    const s = { ...DEFAULT_SETTINGS, method: "ofdm" as const };
    expect(videoBitrateBudget(s)).toBeLessThan(netBitsPerSec(s));
    expect(videoBitrateBudget(s)).toBeGreaterThan(0);
  });
});

describe("video container", () => {
  it("round-trips config + frames through the streaming parser", () => {
    const records = [
      packConfig("av01.0.01M.08", Uint8Array.of(1, 2, 3, 4)),
      packFrame(true, 0, Uint8Array.from({ length: 50 }, (_, i) => i)),
      packFrame(false, 66666, Uint8Array.from({ length: 30 }, (_, i) => 255 - i)),
      packFrame(false, 133333, Uint8Array.of(9, 8, 7)),
    ];
    const all = new Uint8Array(records.reduce((s, r) => s + r.length, 0));
    let o = 0;
    for (const r of records) { all.set(r, o); o += r.length; }

    // feed in awkward chunk sizes to exercise partial-record buffering
    const parser = new ContainerParser();
    const got: any[] = [];
    for (let i = 0; i < all.length; i += 7) got.push(...parser.push(all.subarray(i, i + 7)));

    expect(got.length).toBe(4);
    expect(got[0]).toMatchObject({ kind: "config", codec: "av01.0.01M.08" });
    expect(Array.from(got[0].description)).toEqual([1, 2, 3, 4]);
    expect(got[1]).toMatchObject({ kind: "frame", key: true, timestamp: 0 });
    expect(Array.from(got[1].data)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(got[2]).toMatchObject({ kind: "frame", key: false, timestamp: 66666 });
    expect(got[3].data.length).toBe(3);
  });

  it("resyncs when started mid-stream (drops leading garbage)", () => {
    const frame = packFrame(true, 0, Uint8Array.of(10, 20, 30));
    const withGarbage = new Uint8Array(5 + frame.length);
    withGarbage.set([0x00, 0x37, 0x99, 0x12, 0x44], 0); // junk a decoder might land on
    withGarbage.set(frame, 5);
    const got = new ContainerParser().push(withGarbage);
    const frames = got.filter((r) => r.kind === "frame");
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(Array.from((frames[frames.length - 1] as any).data)).toEqual([10, 20, 30]);
  });
});
