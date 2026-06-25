import { describe, it, expect } from "vitest";
import vectors from "./vectors.json";
import { rsEncode, rsDecode } from "../src/dsp/reedsolomon";

describe("Reed-Solomon", () => {
  for (const [name, c] of Object.entries(vectors.rs)) {
    const { data, nsym, encoded } = c as { data: number[]; nsym: number; encoded: number[] };
    it(`encode matches reedsolo: ${name}`, () => {
      expect(Array.from(rsEncode(Uint8Array.from(data), nsym))).toEqual(encoded);
    });
    it(`decode round-trips: ${name}`, () => {
      expect(Array.from(rsDecode(Uint8Array.from(encoded), nsym))).toEqual(data);
    });
  }

  it("corrects up to nsym/2 byte errors per chunk", () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => (i * 13) % 256);
    const nsym = 16; // corrects up to 8 byte errors per 255-chunk
    const enc = rsEncode(data, nsym);
    const corrupted = Uint8Array.from(enc);
    for (let i = 0; i < 8; i++) corrupted[i * 5] ^= 0x5a; // 8 errors, all in the first chunk
    expect(Array.from(rsDecode(corrupted, nsym))).toEqual(Array.from(data));
  });

  it("throws when errors exceed correction capacity", () => {
    const data = Uint8Array.from({ length: 50 }, (_, i) => i);
    const enc = rsEncode(data, 8); // corrects only 4 bytes
    const corrupted = Uint8Array.from(enc);
    for (let i = 0; i < 10; i++) corrupted[i] ^= 0xff; // 10 errors > capacity
    expect(() => rsDecode(corrupted, 8)).toThrow();
  });
});
