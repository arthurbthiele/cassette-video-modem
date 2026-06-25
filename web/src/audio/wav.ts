// 16-bit mono PCM WAV read/write — interoperable with the Python reference's
// wave output (so a WAV made here decodes there and vice versa).

function writeStr(dv: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}
function readStr(dv: DataView, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

export function encodeWav(samples: Float32Array | Float64Array, sampleRate: number): Blob {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  writeStr(dv, 0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  writeStr(dv, 8, "WAVE");
  writeStr(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  writeStr(dv, 36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.trunc(s * 32767), true); // matches numpy (audio*32767).astype(int16)
  }
  return new Blob([buf], { type: "audio/wav" });
}

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
}

/** Parse a 16-bit PCM WAV (mono or multi-channel → first channel). */
export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const dv = new DataView(buf);
  if (readStr(dv, 0, 4) !== "RIFF" || readStr(dv, 8, 4) !== "WAVE") throw new Error("not a WAV file");
  let sampleRate = 44100;
  let channels = 1;
  let bits = 16;
  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = readStr(dv, off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === "data") {
      const bytesPer = bits / 8;
      const frames = Math.floor(size / (bytesPer * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = body + i * bytesPer * channels; // first channel only
        out[i] = bits === 16 ? dv.getInt16(p, true) / 32768 : dv.getInt32(p, true) / 2147483648;
      }
      return { samples: out, sampleRate };
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}
