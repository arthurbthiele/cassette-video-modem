# Cassette Video Modem — what we changed and why

Hi skamlox 👋 — Arthur passed your cassette-tape video project over and we
(Arthur + his Claude) took a pass at it. This is the honest account of what
state it was in, what we fixed, what's verified, and what's still open. The
short version: **it now actually works end-to-end** — which, it turned out, it
didn't before, in a way the original notes didn't realise.

---

## What the project is (for anyone new to it)

Turn digital video into audio, record that audio to a cassette tape, and play
the tape back through a PC to watch the video again — using the PC as a
software modem and treating a cheap AGC cassette deck as a hostile radio
channel. Pausing the tape pauses the video. Four modulation schemes are
offered, fastest to most robust: **OFDM, DPSK, 4-FSK, FSK**. It's built to scale
to better media too (CD, WAV files), and to make experimenting with the
digital/analogue trade-offs easy.

Three files:
- `cassette_modem.py` — all the DSP: modulation, framing, Reed-Solomon, the
  streaming decoder. No GUI.
- `cassette_encoder.py` — encoder GUI: video → ffmpeg → modem → WAV.
- `cassette_decoder.py` — decoder GUI: live/WAV audio → modem → ffmpeg → video.

---

## The headline: the decoder decoded nothing

The project notes listed some configs as working "cleanly." That was true of an
**offline** code path (`modulate()` → `demodulate()` on one buffer in one shot).
But the decoder GUI doesn't use that path — it uses the **streaming** decoder
(`DecoderState.feed_audio`, fed audio in real-time chunks). And the streaming
path failed for **every** modulation method. As shipped, pressing "Start
decoding" would have produced a blank screen forever.

We only found this because we ran real round-trips instead of trusting the
notes. It turned out to be four compounding problems:

1. **Byte misalignment across chunks.** The decoder converted each audio
   chunk's bits to bytes *independently*. When a chunk's bit-count wasn't a
   multiple of 8, the leftover bits were zero-padded, shoving every later byte
   out of alignment — so the `SYNC_MAGIC` block marker never reappeared in the
   byte stream and no block was ever found.
   *Fix:* accumulate **bits**, not bytes, and search for the sync marker at all
   8 bit-phase offsets.

2. **Differential phase reset at chunk boundaries.** DPSK and OFDM encode data
   in the *change* of phase between consecutive symbols. The decoder reset its
   phase reference to zero at the start of every chunk, corrupting the first
   symbol of each chunk.
   *Fix:* carry one symbol across each chunk boundary as the phase reference,
   and discard its (re-decoded) bits.

3. **The encoder broke the differential chain at every block.** The encoder
   modulated each ~256-byte block in a *separate* `modulate()` call, which
   resets phase to zero. So even with the decoder fixed, the first symbol of
   every block was garbage — and that's exactly where the sync marker and
   header live. This is why single-block test data worked but real multi-block
   video didn't.
   *Fix:* modulate the whole frame stream in **one continuous call** so the
   differential phase chain is never broken.

4. **OFDM had no symbol-timing recovery at all.** OFDM chops the signal into
   fixed-length symbols and FFTs each one — but only if it knows where each
   symbol *starts*. The preamble (and, on a real tape, the arbitrary point you
   press play) means the data doesn't begin on a neat symbol boundary, so every
   FFT window straddled two symbols → noise.
   *Fix:* added **cyclic-prefix correlation** timing recovery. The cyclic prefix
   is a copy of each symbol's tail, so correlating the signal with a delayed
   copy of itself peaks exactly on symbol boundaries. We gate the lock on
   "peakiness" (a real OFDM peak is sharp; the preamble tone and the AGC carrier
   correlate *flatly*) so neither the tone nor the carrier can trigger a false
   lock.

We also:
- Made every block a **uniform size** (padding the metadata block and the final
  short block) so the fixed-size decoder reads them all reliably.
- Wired in the **metadata block** (your notes wanted resolution auto-detect):
  the decoder now reads the encoded resolution from the stream instead of
  relying on the UI matching the source.
- Removed a hard clip in the constant-power carrier that pre-emphasis was
  pushing the signal into.

---

## What's verified

We tested the full pipeline — encode → WAV file → stream-decode in chunks →
reassemble bytes → compare to the original — across all four methods, three
data sizes, three chunk sizes, and multiple random seeds (216 combinations).

| Config | Result |
|---|---|
| **Default (no carrier, no pre-emphasis)** | ✅ 100% bit-exact, all 4 methods |
| **Pre-emphasis on** | ✅ 100%, all 4 methods |
| **Constant-power carrier on** | ✅ FSK / 4-FSK / DPSK bit-exact |
| Constant-power carrier on, **OFDM** | ❌ locks & decodes but loses bits — see below |
| Metadata / resolution auto-detect | ✅ |
| **Real video round-trip** (ffmpeg encode → WAV → decode → ffmpeg frames) | ✅ byte-exact, all 4 methods |
| **Both GUIs construct** (headless, hidden window) | ✅ |

The test scripts are in `tests/`:
- `tests/tests_e2e.py` / `tests/tests_robust.py` — software modem round-trip
  (numpy/scipy/reedsolo/crcmod only; no ffmpeg or audio hardware needed).
- `tests/tests_video.py` — full **video** round-trip: makes a synthetic clip
  with ffmpeg, runs the real encoder/decoder functions, confirms the recovered
  mpegts is byte-exact and that frames decode. Needs ffmpeg + the GUI deps.
- `tests/tests_channel.py` — runs the modem through the cassette-channel
  simulator and reports robustness (see "Current frontier" below).

We did get ffmpeg + a Tk-enabled Python installed and ran all of the above. The
one thing still not done is an **interactive** click-through with live audio
hardware (recording to/from an actual sound device) — the file-based path that
the GUI's "WAV file (testing)" mode uses is fully exercised; the live-mic path
is code-reviewed only.

---

## Known limitations / open questions

- **OFDM + constant-power carrier still loses bits.** The constant-power trick
  adds a separate loud carrier to keep the deck's AGC pinned; we strip it on
  decode with a high-pass. For the narrowband methods (FSK/DPSK) that's clean,
  but a wideband OFDM signal has data right down near the carrier, and the
  residue left after stripping corrupts enough symbols that Reed-Solomon can't
  always recover. **The defaults are set so you don't hit this** (carrier off),
  and OFDM-without-carrier is rock solid. Properly fixing OFDM-on-AGC-tape
  probably needs a different approach — true constant-envelope modulation, or a
  spectral guard notch around the carrier — rather than the additive carrier.
  **Open question for you:** how important is the AGC carrier for OFDM
  specifically on your target deck? FSK/DPSK don't have the problem, so one
  option is "use OFDM for clean line-level/WAV, use DPSK when you need the AGC
  carrier on a hostile deck."

- **Live audio hardware is untested.** The GUIs construct cleanly and the full
  file-based video round-trip is verified, but recording/playing through a real
  sound device (the decoder's "Live input" source) is code-reviewed only. On a
  real machine, do an interactive sanity pass: `pip install -r requirements.txt`,
  ensure ffmpeg is installed, encode a short clip, then decode the WAV via the
  decoder's "WAV file (testing)" source before trying live line-in.

  (While testing, live-running fixed a real bug: the decoder's video
  reconstructor deadlocked on Stop — it halted the frame reader before closing
  ffmpeg's input, so ffmpeg blocked writing to a full output pipe. Fixed.)

- **Real-tape testing is still ahead.** Everything so far is a clean digital
  round-trip. The real channel (wow/flutter, dropouts, the actual AGC) is the
  next frontier — and where your notes' wishlist comes in.

- **The advanced wishlist is unimplemented** (chirp lead-in for group-delay
  calibration, pilot-tone tachometer for wow/flutter, Trellis-coded modulation,
  LDPC). They're real and valuable but were filed under "future," and the right
  order was "make it work first." The OFDM pilot carriers currently do per-symbol
  common-phase correction, which is a start.

---

## Quick start

```
pip install -r requirements.txt      # numpy, scipy, sounddevice, Pillow, reedsolo, crcmod
# plus ffmpeg on PATH (brew/apt/winget install ffmpeg)

python cassette_encoder.py           # pick a video, pick an output .wav, ENCODE
python cassette_decoder.py           # source = WAV file, point at the .wav, START
```

The encoder's **Save settings** writes a `.json`; the decoder's **Load
settings** reads it — that's the easiest way to guarantee the decoder matches
the encoder (every demod setting has to match exactly). Defaults are the
verified-working config; the bitrate bar at the bottom of the encoder updates
live as you change things, and every control has a hover tooltip.

— Have fun with it. The "video on a cassette" goal is genuinely in reach now
that the pipe is solid. 🎞️📼
