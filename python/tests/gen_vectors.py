#!/usr/bin/env python3
"""
Generate test vectors from the Python reference for the TypeScript port to
validate against. Writes web/tests/vectors.json.

Run:  python python/tests/gen_vectors.py
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # python/
import numpy as np
from scipy import signal as spsg
from cassette_modem import (ModemSettings, bytes_to_bits, _crc32,
                            frame_block, modulate, modulate_fsk, demodulate_fsk,
                            modulate_fsk4, demodulate_fsk4,
                            modulate_dpsk, demodulate_dpsk,
                            modulate_ofdm, demodulate_ofdm,
                            _rs_encode, _ofdm_carriers,
                            generate_preamble, encode_metadata_block, TRAIN_BYTES)

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

# ── Reed-Solomon encode (matches the reedsolo library) ──────────────────
v["rs"] = {}
for name, (data, nsym) in {
    "short":     (bytes(range(20)), 16),
    "exact_chunk": (bytes(range(239)), 16),     # exactly one 255-nsym chunk
    "multi_chunk": (bytes((i * 7) % 256 for i in range(300)), 16),  # spans chunks
    "nsym8":     (bytes(range(50)), 8),
}.items():
    v["rs"][name] = {"data": list(data), "nsym": nsym, "encoded": list(_rs_encode(data, nsym))}

# ── framing with Reed-Solomon on ────────────────────────────────────────
srs = ModemSettings(reed_solomon=True, rs_nsym=16)
pl = bytes(range(8))
v["frameRsOn"] = {"payload": list(pl), "seq": 3, "rsNsym": 16,
                  "framed": list(frame_block(pl, 3, srs))}

# ── 4-FSK ───────────────────────────────────────────────────────────────
s4 = ModemSettings(method="fsk4")
d4 = bytes([0xCA, 0x55, 0xE7, 0x7E, 0x1B])
a4 = modulate_fsk4(d4, s4)
v["fsk4"] = {"params": {"sampleRate": s4.sample_rate, "baud": s4.fsk4_baud,
                        "freqs": [s4.fsk4_f0, s4.fsk4_f1, s4.fsk4_f2, s4.fsk4_f3]},
             "bytes": list(d4), "audio": [round(float(x), 8) for x in a4],
             "demodBits": demodulate_fsk4(a4, s4)}

# ── DPSK ────────────────────────────────────────────────────────────────
sd = ModemSettings(method="dpsk")
dd = bytes([0xCA, 0x55, 0xE7, 0x7E, 0x1B])
ad = modulate_dpsk(dd, sd)
v["dpsk"] = {"params": {"sampleRate": sd.sample_rate, "baud": sd.dpsk_baud,
                        "carrier": sd.dpsk_carrier, "phases": sd.dpsk_phases},
             "bytes": list(dd), "audio": [round(float(x), 8) for x in ad],
             "demodBits": demodulate_dpsk(ad, sd)}

# ── OFDM ────────────────────────────────────────────────────────────────
so = ModemSettings(method="ofdm")   # fft 512, cp 64, fmin 500, fmax 6000, pilot int 8, phases 4
do = bytes(range(40))
ao = modulate_ofdm(do, so)
dc, pilots = _ofdm_carriers(so)
v["ofdm"] = {"params": {"sampleRate": so.sample_rate, "fftSize": so.ofdm_fft_size,
                        "cpSize": so.ofdm_cp_size, "fMin": so.ofdm_f_min,
                        "fMax": so.ofdm_f_max, "pilotInterval": so.ofdm_pilot_interval,
                        "phases": so.ofdm_phases},
             "carriers": {"data": dc, "pilots": pilots},
             "bytes": list(do), "audio": [round(float(x), 8) for x in ao],
             "demodBits": demodulate_ofdm(ao, so)}

# ── Butterworth design + lfilter (match scipy) ──────────────────────────
v["butter"] = {}
for name, (N, Wn, bt) in {
    "hp4": (4, 0.0177, "high"),
    "hp6": (6, 0.0204, "high"),
    "lp4": (4, 0.1, "low"),
}.items():
    b, a = spsg.butter(N, Wn, btype=bt)
    v["butter"][name] = {"N": N, "Wn": Wn, "btype": bt, "b": list(b), "a": list(a)}

bx, ax = spsg.butter(6, 0.0204, btype="high")
xs = np.sin(2 * np.pi * 0.05 * np.arange(400)) + 0.3 * np.sin(2 * np.pi * 0.4 * np.arange(400))
v["lfilter"] = {"b": list(bx), "a": list(ax), "x": [round(float(x), 8) for x in xs],
                "y": [round(float(y), 8) for y in spsg.lfilter(bx, ax, xs)]}

# ── full OFDM encode stream → audio (cross-validate the TS decode chain) ──
se = ModemSettings(method="ofdm", block_data_size=128, preamble_ms=100, reed_solomon=True)
payload = bytes((i * 5) % 256 for i in range(64))
bs = se.block_data_size
nblk = -(-len(payload) // bs)
stream = bytearray(TRAIN_BYTES) + encode_metadata_block({"width": 128, "height": 96, "fps": 10}, se)
for i in range(nblk):
    stream += frame_block(payload[i * bs:(i + 1) * bs].ljust(bs, b"\x00"), i, se)
audio = np.concatenate([generate_preamble(se), modulate(bytes(stream), se),
                        np.zeros(int(se.sample_rate * 0.5))])
audio = audio / np.max(np.abs(audio)) * 0.95
v["ofdmE2E"] = {
    "settings": {"method": "ofdm", "blockDataSize": bs, "preambleMs": se.preamble_ms,
                 "reedSolomon": True, "rsNsym": se.rs_nsym},
    "payload": list(payload),
    "audio": [round(float(x), 7) for x in audio],
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(v, f)
print(f"wrote {OUT}  ({os.path.getsize(OUT)} bytes)")
print(f"  fsk audio samples: {len(v['fsk']['audio'])}")
