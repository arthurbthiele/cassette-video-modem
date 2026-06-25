#!/usr/bin/env python3
"""
Robustness probe: run the modem through the simulated cassette channel
(cassette_channel.py) at a few severities and report block recovery per method.

No ffmpeg or audio hardware needed — pure modem + channel model. Use it to see
how tape-robust a given config is, and to tune settings against a realistic
channel before burning a tape.

    python tests_channel.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
from cassette_modem import (ModemSettings, DecoderState, METADATA_SEQ,
                            modulate, frame_block, generate_preamble,
                            add_constant_power_carrier, add_pilot_tone, pilot_resample,
                            encode_metadata_block, TRAIN_BYTES)
from cassette_channel import CassetteChannel, simulate_cassette

SIZE = 8000


def _encode(video, ms):
    bs = ms.block_data_size
    n  = -(-len(video) // bs)
    stream = bytearray(TRAIN_BYTES) + encode_metadata_block(dict(width=256, height=144, fps=15), ms)
    for i in range(n):
        stream += frame_block(video[i*bs:(i+1)*bs].ljust(bs, b"\x00"), i, ms)
    audio = np.concatenate([generate_preamble(ms), modulate(bytes(stream), ms),
                            np.zeros(int(ms.sample_rate * 0.5))])
    if ms.pilot_tone:
        audio = add_pilot_tone(audio, ms)
    if ms.constant_power:
        audio = add_constant_power_carrier(audio, ms)
    peak = np.max(np.abs(audio))
    return (audio / peak * 0.95).astype(np.float32), n


def _decode(audio, ms):
    if ms.pilot_tone:                       # the WAV-file decode path's correction
        audio = pilot_resample(audio, ms)
    ds = DecoderState(ms)
    data = {}
    for i in range(0, len(audio), 4096):
        for seq, pl in ds.feed_audio(audio[i:i+4096]):
            if seq != METADATA_SEQ:
                data[seq] = pl
    return data


def main():
    rng = np.random.RandomState(7)
    video = bytes(rng.randint(0, 256, SIZE, dtype=np.uint8))
    nblk = -(-SIZE // 256)

    presets = {
        "pristine":   None,
        "good deck":  dict(snr_db=30, wow_depth=0.001, flutter_depth=0.0005,
                           agc_enabled=False, dropout_per_sec=0.05, band_high_hz=8000),
        "decent C60": dict(snr_db=24, wow_depth=0.003, flutter_depth=0.0015,
                           dropout_per_sec=0.2, band_high_hz=6500),
        "cheap/old":  dict(snr_db=20, wow_depth=0.005, flutter_depth=0.003,
                           dropout_per_sec=0.5, band_high_hz=6000),
    }

    def run(label, make_ms):
        print(f"\n{label}")
        print(f"{'method':6s}" + "".join(f"{k:>14}" for k in presets))
        for method in ["fsk", "fsk4", "dpsk", "ofdm"]:
            ms = make_ms(method)
            clean, _ = _encode(video, ms)
            cells = []
            for name, kw in presets.items():
                sig = clean if kw is None else simulate_cassette(
                    clean, CassetteChannel(sample_rate=ms.sample_rate, **kw))
                data = _decode(sig, ms)
                recon = bytearray()
                for i in range(nblk):
                    recon += data.get(i, b"\x00" * 256)
                good = sum(1 for a, b in zip(bytes(recon)[:SIZE], video) if a == b)
                cells.append(f"{100*good//SIZE}% {len(data)}/{nblk}")
            print(f"{method:6s}" + "".join(f"{c:>14}" for c in cells))

    run("PLAIN modem (no pilot):",
        lambda m: ModemSettings(method=m, reed_solomon=True))
    run("TAPE MODE (pilot tachometer; +constant-power for non-OFDM):",
        lambda m: ModemSettings(method=m, reed_solomon=True, pilot_tone=True,
                                ofdm_f_min=900 if m == "ofdm" else 500,
                                constant_power=(m != "ofdm")))
    print("\n(bytes-correct% and blocks-recovered. The pilot tachometer undoes wow & "
          "flutter — the dominant impairment — lifting the robust methods from nothing "
          "to usable on a degraded tape. OFDM+constant-power and live-stream de-tacho "
          "are still open.)")


if __name__ == "__main__":
    main()
