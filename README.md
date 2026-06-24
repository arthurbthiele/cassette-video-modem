# Cassette Video Modem

Store digital video as audio on a cassette tape (or any audio medium / WAV
file) using a PC as a software modem, and play it back live — pausing the tape
pauses the video. Four modulation schemes, fastest → most robust: **OFDM, DPSK,
4-FSK, FSK**.

```
VIDEO ──ffmpeg──▶ bytes ──frame+RS──▶ modulate ──▶ WAV ──▶ [tape] ──▶ WAV/line-in
                                                                          │
   tkinter ◀── ffmpeg ◀── reassemble ◀── deframe+RS ◀── demodulate ◀──────┘
```

## Install & run

```
pip install -r requirements.txt        # numpy scipy sounddevice Pillow reedsolo crcmod
# also needs ffmpeg on PATH:  brew install ffmpeg | apt install ffmpeg | winget install ffmpeg

python cassette_encoder.py             # choose video + output .wav, press ENCODE
python cassette_decoder.py             # source: WAV file, choose the .wav, press START
```

Use the encoder's **Save settings** → decoder's **Load settings** to guarantee
the two match (every demod parameter must match the encoder exactly). Defaults
are a verified-working config; hover any control for a tooltip; the bitrate bar
updates live.

## Status

The full encode → WAV → decode → reassemble pipeline is verified bit-exact for
all four methods in the default and pre-emphasis configs, and for FSK/4-FSK/DPSK
with the constant-power AGC carrier. **OFDM + constant-power carrier** is the one
known-imperfect combo (loses bits). See **[HANDOVER.md](HANDOVER.md)** for the
full story of what was fixed and why, what's verified, and open questions.

Tests (run from anywhere, e.g. `python tests/tests_e2e.py`):

- `tests/tests_e2e.py`, `tests/tests_robust.py` — software modem round-trip (no ffmpeg/audio needed)
- `tests/tests_video.py` — full video round-trip (needs ffmpeg + GUI deps)
- `tests/tests_channel.py` — robustness against the simulated cassette channel

## Files

| File | Role |
|---|---|
| `cassette_modem.py` | DSP core: modulation, framing, Reed-Solomon, streaming decoder |
| `cassette_encoder.py` | Encoder GUI |
| `cassette_decoder.py` | Decoder GUI |
| `cassette_channel.py` | Cassette-channel simulator (a tuning/testing tool) |
| `tests/` | Software, video, and channel-robustness tests |
| `docs/original-brief.md` | skamlox's original project brief & research notes |
| `HANDOVER.md` | What we changed and why; verified status; open questions |
