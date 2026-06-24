I want a program that does roughly the following:

Converts video into live audio to be stored to a recording device, and can play it back live from a device, or file, with the device itself controlling pausing by stopping the stream

basically, i want to get as much video as possible onto a cassette tape, experimentally, but this program should be scalable to better tape, worse tape, CD, wave files, records, basically any audio storage means, maybe not records, it should be relatively easy to test differnt configurations of the digital compression and the analogue format to push the limits of what's possible with experimentation, ideally it would be able to reach watchable-ish video on a cassette tape playing live, specifically, it would do this on an old, not very well maintained computer cassette recorder with agc connected to an ordinary computer, encoding the video as audio to be stored on it and played out through a PC (so not exceeding the capabilities of a PC either, unless configured to)

claude has previously been working on this with a few specific ideas, in python, feel free to change anything suboptimal, don't dumb it down but ideally make it easy enough to use, so a decent GUI, which is not optional, tooltips, shifting visible values, but it working at the bare minimum, without major flaws, is the main requirement, the only real requirement. So to clarify, you'll be designing a program (ideally but optionally one i can just run on my computer easilly without compiling it) optionall using i.e. ffmpeg, that converts and stores digital video as compressed video on cassette-like mediums, primarily meant for video on cassette tapes but fully scalable up to things like CD, if you have it split into two programs, which is fine, have them able to use wav files, and have configurations shareable between them, metadata in the stream is ehh, you decide on that, I genuinely don't know, don't be afraid to make good calls that I didn't. And a very important note, you won't be able to ask the user followup questions, because it's being passed on, so this is all you have to work on, no followups possible at all, so please do not waste that time, but don't fret, do it correctly, you can.

Bonus, here are some assorted ideas before i give you the markdown file with the existing project's details, they might be horrible so use some common sense and logical thought, remember the primary goal is to have it work without some hitch.

If we throw out 1980s computing constraints and let a modern PC use 21st-century Software-Defined Radio (SDR) math to encode and decode the audio, the absolute upper limit of a standard, cheap, AGC-driven cassette deck is roughly 6,000 to 8,000 bits per second (bps). That translates to about 750 to 1,000 Bytes per second, meaning a standard 60-minute cassette (C-60) could hold a rock-solid, error-corrected 2.7 Megabytes of data.

To achieve this, the modern PC has to treat the cassette deck not as a computer peripheral, but as an extremely hostile, fading, non-linear radio channel. To get 8,000 bps through it, we have to defeat four distinct physical villains:

Villain 1: The AGC (Automatic Gain Control)
The Problem: AGC is the mortal enemy of standard telephone modems. If a modem uses Amplitude Modulation (AM) or QAM—where a "loud" wave is a 1 and a "quiet" wave is a 0—the AGC will instantly ruin it. When the modem goes quiet, the deck's preamp will panic, crank the gain to maximum, suck up the tape hiss, and distort the next "loud" wave until the capacitor discharges.

The PC’s Solution: Strict Constant-Envelope Modulation. We cannot use volume to convey data. The audio track sent to the deck must sit at an absolute, unvarying 100% Volume RMS from the millisecond the tape starts rolling to the millisecond it stops. The AGC will get pinned to its floor within the first 200 milliseconds and stay paralyzed there forever.

Villain 2: Wow & Flutter
The Problem: The tape is being dragged across a metal head by a cheap DC motor pulling a slightly stretched rubber belt. The pitch of the audio is constantly wobbling up and down by about 0.2% to 0.5%. If you try to use standard Phase Shift Keying (where the computer measures the exact angle of the sine wave to call it a 00, 01, 10, or 11), the tape stretching by an extra micrometer will accidentally rotate the phase 45 degrees and flip your data into garbage.

The PC’s Solution: Differential QPSK (DQPSK) + a Pilot Tachometer. Instead of the PC asking the tape, "What is the exact phase right now?", it asks, "Did the phase shift by 90 degrees compared to the wave I heard 1 millisecond ago?" Because the rubber belt cannot stretch fast enough to meaningfully distort a time window of 0.001 seconds, the data survives.
Furthermore, the PC injects two dead-steady sine waves into the audio—say, at 1,000 Hz and 4,500 Hz—carrying zero data. The decoding software watches those two "Pilot Tones" wobble up and down in pitch, uses them as a live digital tachometer, and dynamically re-samples the surrounding audio in real-time to mathematically un-stretch the tape.

Villain 3: The 6 kHz Brick Wall
The Problem: A high-end Nakamichi deck with Chrome tape can hit 19,000 Hz. A 1984 shoebox recorder with a normal Ferric (Type I) voice tape falls off a cliff at about 6,500 Hz, and the low-end cheap transformer rolls off below 300 Hz. Your usable "pipe" is strictly 300 Hz to 6,000 Hz.

The PC’s Solution: COFDM (Coded Orthogonal Frequency Division Multiplexing). Instead of sending one super-fast, high-frequency squeal (which the tape head will turn into mush), the PC splits the 5,700 Hz of usable bandwidth into 32 parallel, slow-moving sub-carriers. It’s the exact same math used by 5G Wi-Fi and Digital Shortwave Radio (DRM). If a piece of oxide flakes off the tape and creates a momentary "dropout" that kills the 4,000 Hz band, the other 31 sub-carriers carry the load.

Villain 4: Group Delay (Phase Smearing)
The Problem: Cheap analog tape heads do not pass all frequencies at the same speed. High notes (5 kHz) physically emerge from the magnetic playback head a fraction of a millisecond later than low notes (500 Hz). If you send a sharp digital square wave in, it comes out looking like a melted Dali clock.

The PC’s Solution: The "Chirp" Lead-in. When you press Record on the PC, it doesn't send data for the first 4 seconds. It sends a repeating, highly precise logarithmic sweep: “wwoooOOOP! wwoooOOOP!”. When you play it back into the PC, the DSP software looks at the distorted sweep, calculates the exact millisecond delay of every frequency across the spectrum, builds an inverted mathematical mirror of the cassette deck's crappy physical head, and applies it as a live digital filter.

What would the tape sound like?
If you took this optimized tape and put it in your car stereo, it wouldn't sound like the classic, rhythmic “beeeep-boop-baap” of a 1982 Commodore 64 loading Jumpman.

Because 32 phase-shifting sine waves crammed together at 100% constant volume mathematically approach the distribution of pure Gaussian noise, it would sound like a screaming, completely uniform jet engine of deafening white static, preceded by four seconds of a weird sci-fi laser sound.

The "Reality Check" limit
Why can't we get 33.6 kbps like a 1990s US Robotics phone modem?

Because of the Signal-to-Noise Ratio (SNR). A clean copper telephone line gives you about 35 to 40 dB of clean headroom above the static. A normal commercial Type-I cassette tape, driven hard into an un-bypassed AGC circuit, gives you an effective SNR of about 20 to 22 dB.

Claude Shannon’s Law of Information Theory dictates that in a 5,700 Hz pipe with a 21 dB SNR, the literal physical limit of the universe is 24,600 bps. Once you subtract the real-world overhead required for heavy Low-Density Parity Check (LDPC) forward error correction—so that a speck of dust doesn't corrupt a .zip file—you land right at the ~7,500 bps sweet spot.

You could load the entire shareware installer of DOOM (1993) off Side A of a Maxell UR-90 in about 24 minutes, and it would install without a single bad checksum.

In Step 2, we used 16-APSK and spent 12% of our total bits on a separate Error Correction code.
We will upgrade to 32-TCM (Trellis-Coded Modulation). Invented by Gottfried Ungerboeck in the late 70s (and the sole reason 56k dial-up modems worked), TCM does something paradoxical: it glues the Error Correction directly into the physical geometry of the sound waves. Instead of adding check-bits to the end of a word, it restricts which sound waves are legally allowed to follow other sound waves. If the PC hears a transition from Wave A to Wave C, it knows with 100% mathematical certainty that it was a tape glitch, because the Trellis grammar dictates Wave A can only be followed by B, D, or E.
We then apply 2020s Probabilistic Constellation Shaping (PCS)—the tech used in trans-oceanic fiber optic cables: In standard data, the symbols `00000` and `11111` occur with equal 3.1% probability. PCS uses a streaming distribution matcher to intentionally starve the high-energy outer rings of the constellation, forcing the data to ride almost exclusively on the quiet, low-energy inner symbols, only spiking out to the loud symbols once every few hundred cycles. To the deck's AGC, the audio looks like a soft, purring, completely inert pink noise.

now the project notes:




# Cassette Tape Digital Video — Project Notes

## Goal
Store and play back digital video on standard cheap cassette tape using a modern PC as the modem.
Play/pause tape = play/pause video.

## Current pipeline
```
VIDEO FILE → ffmpeg (re-encode at target bitrate) → mpegts bytes
           → metadata block (JSON: resolution, fps, codec, modem settings)
           → frame into fixed-size blocks (SYNC + header + CRC + Reed-Solomon)
           → modulate to audio (FSK / 4-FSK / DPSK / OFDM)
           → optional: constant-power AGC carrier at 300 Hz
           → optional: pre-emphasis
           → 16-bit mono WAV file

WAV FILE → play through line-out to cassette deck → tape

TAPE → play through line-in → audio chunks
     → DecoderState (streaming, IIR filter state preserved across chunks)
     → demodulate → byte stream → scan for SYNC_MAGIC
     → deframe blocks → RS error correction → reassemble byte stream
     → ffmpeg (stdin pipe, mpegts → raw RGB frames)
     → display in tkinter canvas
     → pause detection: RMS below threshold for >300ms → PAUSED overlay
```

## Achieved bitrates (net, after framing overhead, default settings)
| Method | Net bps | KB/s (1024) | Notes |
|--------|---------|-------------|-------|
| FSK    | ~1,100  | 0.13        | Most reliable, 1200 baud |
| 4-FSK  | ~2,200  | 0.27        | 2 bits/symbol |
| DPSK   | ~2,800  | 0.34        | 4-phase differential |
| OFDM   | ~7,600  | 0.93        | Best, ~56 subcarriers |

60-min tape at OFDM default: ~4 MB usable data

## Known bugs / incomplete (as of this snapshot)
- DPSK and OFDM round-trip fail when constant_power=True (filter interaction bug, being fixed)
- Pre-emphasis (pre_emphasis=True) + constant_power interaction not fully correct in decoder
- Default: constant_power=False, pre_emphasis=False — these work cleanly
- Video playback via ffmpeg pipe: works in principle, needs ffmpeg on PATH
- Decoder WAV player timeline: UI exists but playback thread needs final wiring
- Settings shared format (.cassette JSON) implemented but not fully tested cross-program
- ffmpeg path detection for Windows needs testing on real machine

## File structure
- cassette_modem.py   — all DSP, framing, Reed-Solomon, DecoderState (no GUI)
- cassette_encoder.py — encoder GUI: file I/O, modem settings, video settings, output device player
- cassette_decoder.py — decoder GUI: live/file input, video display, WAV player with timeline
- requirements.txt    — pip dependencies + ffmpeg note
- PROJECT_NOTES.md    — this file

## Specific goals not yet met
1. DPSK/OFDM + constant_power round-trip (filter order bug)
2. WAV player timeline fully wired in decoder
3. Resolution auto-detected from metadata on decoder side (metadata block exists, decoder needs to parse and reconfigure VideoReconstructor)
4. ffmpeg not-found error should show a helpful dialog with install instructions
5. Proper playback interface (play/pause/stop/seek) for WAV player in both programs

## Advanced ideas from research (future)
### Constant-Envelope OFDM (already doing this)
All subcarriers at equal amplitude. 300 Hz carrier pins AGC. ✓

### Pilot-tone tachometer for wow & flutter
Two fixed sine waves (e.g. 1000 Hz + 4500 Hz) carry zero data.
Decoder watches their pitch drift, resamples the audio stream in real-time.
Would improve OFDM phase coherence significantly. Not yet implemented.

### Chirp lead-in for group delay calibration
4-second log sweep "wwooOOOP" before data.
Decoder measures per-frequency delay, builds inverse filter, applies as live EQ.
Would flatten the cassette head's phase response across the band.
Not yet implemented.

### 32-TCM (Trellis-Coded Modulation) — Ungerboeck 1970s
Glues ECC into constellation geometry. Legal transitions defined by trellis grammar.
Illegal transitions = detected errors with zero overhead bits.
Gain: ~3-6 dB coding gain vs separate ECC at same spectral efficiency.
Would replace Reed-Solomon. Complex to implement. High value.

### Probabilistic Constellation Shaping (PCS)
Used in trans-oceanic fiber. Starves outer constellation rings, concentrates
energy on inner symbols. Looks like pink noise to AGC. ~1 dB gain.
Distribution matcher (CCDM) needed. Very complex. Low priority.

### LDPC instead of Reed-Solomon
Lower overhead for same correction capability. Industry standard for modern
digital broadcast (DVB-S2, WiFi 6). Would improve effective bitrate by ~5-10%.
Available as scipy.fec or custom. Medium priority.

### Shannon limit reminder
5700 Hz bandwidth, ~21 dB SNR on cheap tape → theoretical max ~24,600 bps.
After LDPC overhead: ~7,500 bps is the real-world target ceiling.
Current OFDM default hits ~7,600 bps raw, ~6,700 net. We're close.
