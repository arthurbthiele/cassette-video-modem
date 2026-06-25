// Block framing: SYNC + header + payload + CRC, matching the Python reference.
// Header layout (big-endian, no padding): sync[4] ver[1] flags[1] seq[4] dlen[2].
// Reed-Solomon (FLAG_RS) is not ported yet — RS-off path only for now.

import { crc32 } from "./crc";
import { rsEncode, rsDecode } from "./reedsolomon";

export const SYNC_MAGIC = Uint8Array.of(0xca, 0x55, 0xe7, 0x7e);
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 12;
export const CRC_SIZE = 4;
export const FLAG_RS = 0x01;

export function frameBlock(payload: Uint8Array, seq: number, useRs = false, rsNsym = 16): Uint8Array {
  const dlen = payload.length;
  const body = new Uint8Array(HEADER_SIZE + dlen + CRC_SIZE);
  const dv = new DataView(body.buffer);
  body.set(SYNC_MAGIC, 0);
  dv.setUint8(4, PROTOCOL_VERSION);
  dv.setUint8(5, useRs ? FLAG_RS : 0);
  dv.setUint32(6, seq >>> 0, false);
  dv.setUint16(10, dlen, false);
  body.set(payload, HEADER_SIZE);
  dv.setUint32(HEADER_SIZE + dlen, crc32(body.subarray(0, HEADER_SIZE + dlen)), false);
  return useRs ? rsEncode(body, rsNsym) : body;
}

export interface DeframeResult {
  seq: number;
  payload: Uint8Array;
}

export function deframeBlock(raw: Uint8Array, useRs = false, rsNsym = 16): DeframeResult | null {
  let body = raw;
  if (useRs) {
    try {
      body = rsDecode(raw, rsNsym);
    } catch {
      return null; // uncorrectable
    }
  }
  if (body.length < HEADER_SIZE + CRC_SIZE) return null;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let i = 0; i < 4; i++) if (body[i] !== SYNC_MAGIC[i]) return null;
  if (dv.getUint8(4) !== PROTOCOL_VERSION) return null;
  const seq = dv.getUint32(6, false);
  const dlen = dv.getUint16(10, false);
  const total = HEADER_SIZE + dlen + CRC_SIZE;
  if (body.length < total) return null;
  const want = dv.getUint32(HEADER_SIZE + dlen, false);
  if (crc32(body.subarray(0, HEADER_SIZE + dlen)) !== want) return null;
  return { seq, payload: body.subarray(HEADER_SIZE, HEADER_SIZE + dlen) };
}

/** Wire size of a full fixed-size block (matches Python block_wire_size). */
export function blockWireSize(blockDataSize: number, useRs: boolean, rsNsym: number): number {
  const body = HEADER_SIZE + blockDataSize + CRC_SIZE;
  if (!useRs) return body;
  const nchunks = Math.ceil(body / (255 - rsNsym));
  return body + nchunks * rsNsym;
}

