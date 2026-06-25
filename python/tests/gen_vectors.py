#!/usr/bin/env python3
"""
Generate test vectors from the Python reference for the TypeScript port to
validate against. Writes web/tests/vectors.json.

Run:  python python/tests/gen_vectors.py
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # python/
import numpy as np
from cassette_modem import (ModemSettings, bytes_to_bits, _crc32,
                            frame_block, modulate_fsk, demodulate_fsk)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT  = os.path.join(REPO, "web", "tests", "vectors.json")

v = {}

# ── bits ────────────────────────────────────────────────────────────────
b = bytes([0x00, 0x01, 0xCA, 0x55, 0xFF, 0x80, 0x7E])
v["bytesToBits"] = {"bytes": list(b), "bits": bytes_to_bits(b)}

# ── CRC-32 ──────────────────────────────────────────────────────────────
v["crc32"] = {}
for name, data in [("empty", b""), ("abc", b"abc"),
                   ("sync", bytes([0xCA, 0x55, 0xE7, 0x7E])),
                   ("range16", bytes(range(16)))]:
    v["crc32"][name] = {"bytes": list(data), "crc": _crc32(data)}

# ── framing (Reed-Solomon off) ──────────────────────────────────────────
s = ModemSettings(reed_solomon=False)
payload = bytes(range(8))
v["frameRsOff"] = {
    "payload": list(payload), "seq": 7,
    "framed": list(frame_block(payload, 7, s)),
}

# ── FSK modulate + demodulate (default params, RS off) ──────────────────
sf = ModemSettings(method="fsk", reed_solomon=False)
data = bytes([0xCA, 0x55, 0xE7, 0x7E, 0x01, 0x80, 0x33])
audio = modulate_fsk(data, sf)
v["fsk"] = {
    "params": {"sampleRate": sf.sample_rate, "baud": sf.fsk_baud,
               "f0": sf.fsk_f0, "f1": sf.fsk_f1},
    "bytes": list(data),
    "audio": [round(float(x), 8) for x in audio],     # exact-ish, tolerance-compared
    "demodBits": demodulate_fsk(audio, sf),           # round-trip target
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(v, f)
print(f"wrote {OUT}  ({os.path.getsize(OUT)} bytes)")
print(f"  fsk audio samples: {len(v['fsk']['audio'])}")
