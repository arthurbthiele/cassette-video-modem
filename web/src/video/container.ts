// Lightweight container that carries WebCodecs EncodedVideoChunks (and the codec
// config) through the modem byte stream — replaces the Python pipeline's mpegts.
// The codec config is emitted periodically (each GOP), not just once, so a
// decoder can join the stream partway through (skamlox's "jump in midway").
//
// Records (big-endian):
//   CONFIG (0xC0): codecLen:u16, codec(utf8), descLen:u32, desc
//   FRAME  (0xF1): flags:u8 (bit0 = key), timestampMicros:u32, len:u32, data

const CONFIG = 0xc0;
const FRAME = 0xf1;

export interface VideoConfigRecord {
  kind: "config";
  codec: string;
  description?: Uint8Array;
}
export interface VideoFrameRecord {
  kind: "frame";
  key: boolean;
  timestamp: number; // microseconds
  data: Uint8Array;
}
export type VideoRecord = VideoConfigRecord | VideoFrameRecord;

export function packConfig(codec: string, description?: Uint8Array): Uint8Array {
  const codecBytes = new TextEncoder().encode(codec);
  const desc = description ?? new Uint8Array(0);
  const out = new Uint8Array(1 + 2 + codecBytes.length + 4 + desc.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint8(o, CONFIG); o += 1;
  dv.setUint16(o, codecBytes.length, false); o += 2;
  out.set(codecBytes, o); o += codecBytes.length;
  dv.setUint32(o, desc.length, false); o += 4;
  out.set(desc, o);
  return out;
}

export function packFrame(key: boolean, timestampMicros: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 1 + 4 + 4 + data.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint8(o, FRAME); o += 1;
  dv.setUint8(o, key ? 1 : 0); o += 1;
  dv.setUint32(o, timestampMicros >>> 0, false); o += 4;
  dv.setUint32(o, data.length, false); o += 4;
  out.set(data, o);
  return out;
}

/** Streaming parser: push reassembled modem bytes, pull complete records.
 * Buffers partial records across pushes. Resynchronises if it lands mid-stream
 * on bytes that don't parse (drops one byte and retries). */
export class ContainerParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(bytes: Uint8Array): VideoRecord[] {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.length);
    this.buf = merged;
    const out: VideoRecord[] = [];
    let pos = 0;
    for (;;) {
      const rec = this.tryParse(pos);
      if (rec === "incomplete") break;
      if (rec === "bad") { pos += 1; continue; } // resync
      out.push(rec.record);
      pos = rec.next;
    }
    this.buf = this.buf.subarray(pos);
    return out;
  }

  private tryParse(pos: number): { record: VideoRecord; next: number } | "incomplete" | "bad" {
    const b = this.buf;
    if (pos >= b.length) return "incomplete";
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = b[pos];
    if (tag === CONFIG) {
      if (pos + 3 > b.length) return "incomplete";
      const codecLen = dv.getUint16(pos + 1, false);
      let o = pos + 3 + codecLen;
      if (o + 4 > b.length) return "incomplete";
      const descLen = dv.getUint32(o, false);
      o += 4;
      if (o + descLen > b.length) return "incomplete";
      const codec = new TextDecoder().decode(b.subarray(pos + 3, pos + 3 + codecLen));
      if (!/^[\w.-]+$/.test(codec)) return "bad"; // sanity check for resync
      const description = descLen ? b.slice(o, o + descLen) : undefined;
      return { record: { kind: "config", codec, description }, next: o + descLen };
    }
    if (tag === FRAME) {
      if (pos + 10 > b.length) return "incomplete";
      const key = (b[pos + 1] & 1) === 1;
      const timestamp = dv.getUint32(pos + 2, false);
      const len = dv.getUint32(pos + 6, false);
      if (len > 4_000_000) return "bad"; // implausible → resync
      if (pos + 10 + len > b.length) return "incomplete";
      return { record: { kind: "frame", key, timestamp, data: b.slice(pos + 10, pos + 10 + len) }, next: pos + 10 + len };
    }
    return "bad";
  }
}
