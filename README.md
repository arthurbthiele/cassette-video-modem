# Cassette Video Modem

Store digital video as audio on a cassette tape (or any audio medium / WAV file)
using a software modem, and play it back — the tape stopping naturally pauses the
video. Modulation schemes, fastest → most robust: **OFDM, DPSK, 4-FSK, FSK**.

```
VIDEO ─encode─▶ bytes ─frame+RS─▶ modulate ─▶ WAV ─▶ [tape] ─▶ WAV/line-in
                                                                     │
   display ◀── decode ◀── reassemble ◀── deframe+RS ◀── demodulate ◀─┘
```

## Two implementations

| Dir | What | Status |
|---|---|---|
| **`web/`** | Browser/TypeScript app — the primary target. Runs with no install (open a page), real-time playback via WebCodecs, richer UI. | **In progress** (rewrite) |
| **`python/`** | The original Python + tkinter implementation. | Working; now the **reference** the web port is validated against |

### Run the web app (dev)
```
cd web
npm install
npm run dev          # opens a local dev server
npm run build        # static build → web/dist/  (deploys to GitHub/Cloudflare Pages)
```

### Run the Python reference
```
cd python
pip install -r requirements.txt    # numpy scipy sounddevice Pillow reedsolo crcmod
# also needs ffmpeg on PATH:  brew install ffmpeg | apt install ffmpeg | winget install ffmpeg
python cassette_encoder.py         # choose video + output .wav, press ENCODE
python cassette_decoder.py         # source: WAV file, choose the .wav, press START
```
Python tests (run from anywhere): `python python/tests/tests_e2e.py` (modem
round-trip), `tests_video.py` (needs ffmpeg), `tests_channel.py` (robustness vs
the cassette-channel simulator).

## Status

The Python pipeline is verified bit-exact end to end for all four methods
(default + pre-emphasis configs; constant-power for FSK/4-FSK/DPSK). The pilot
tachometer takes FSK from unusable to ~75% on a degraded tape. The browser
rewrite is underway — see `~/claude-plans` notes and **[HANDOVER.md](HANDOVER.md)**
for the full history, verified status, and open questions.

## Layout

| Path | Role |
|---|---|
| `web/` | Browser/TypeScript app (primary) |
| `python/` | Reference implementation (DSP core, GUIs, channel simulator, tests) |
| `browser-spike/` | Throwaway feasibility spike (WebCodecs + DSP timing) |
| `docs/original-brief.md` | skamlox's original project brief & research notes |
| `HANDOVER.md` | What changed and why; verified status; open questions |
