#!/usr/bin/env python3
"""
cassette_channel.py — a software model of a cheap cassette deck's audio channel.

Lets you test and tune the modem against the real-world enemies WITHOUT a
physical tape: band-limiting, wow & flutter (pitch wobble), AGC pumping, group
delay (phase smear), oxide dropouts, and tape hiss. Pass a clean modem WAV
signal through simulate_cassette() and feed the result to the decoder.

This is a research/tuning tool, not part of the encode/decode path.
"""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from scipy import signal as spsg


@dataclass
class CassetteChannel:
    sample_rate: int = 44100

    # Frequency response — the usable "pipe" of a cheap ferric deck.
    band_low_hz:  float = 300.0
    band_high_hz: float = 6000.0
    band_order:   int   = 4

    # Wow & flutter — slow pitch drift (wow, <4 Hz) + faster flutter (~10 Hz).
    wow_depth:    float = 0.004    # fractional speed deviation (0.4%)
    wow_rate_hz:  float = 0.7
    flutter_depth: float = 0.002
    flutter_rate_hz: float = 11.0

    # Group delay — highs emerge slightly later than lows (phase smear).
    group_delay_hi_ms: float = 0.6   # extra delay at band_high vs band_low

    # AGC — the deck's automatic gain control (attack fast, release slow).
    agc_enabled:    bool  = True
    agc_target_rms: float = 0.25
    agc_attack_ms:  float = 5.0
    agc_release_ms: float = 300.0

    # Dropouts — brief level dips from oxide flaking.
    dropout_per_sec: float = 0.4
    dropout_ms_mean: float = 8.0
    dropout_depth:   float = 0.15   # residual level during a dropout

    # Tape hiss — additive noise to a target SNR.
    snr_db: float = 22.0

    # Reproducible randomness without touching the global RNG.
    seed: int = 0


def _bandlimit(x, ch, rng):
    nyq = ch.sample_rate / 2.0
    lo  = max(1e-3, ch.band_low_hz / nyq)
    hi  = min(0.999, ch.band_high_hz / nyq)
    b, a = spsg.butter(ch.band_order, [lo, hi], btype="band")
    return spsg.lfilter(b, a, x)


def _wow_flutter(x, ch, rng):
    """Resample on a wobbling time base — the tape speed drifts continuously."""
    n  = len(x)
    sr = ch.sample_rate
    t  = np.arange(n)
    # Instantaneous fractional speed deviation (with a random phase per run).
    ph1 = rng.uniform(0, 2*np.pi); ph2 = rng.uniform(0, 2*np.pi)
    dev = (ch.wow_depth     * np.sin(2*np.pi*ch.wow_rate_hz     * t/sr + ph1) +
           ch.flutter_depth * np.sin(2*np.pi*ch.flutter_rate_hz * t/sr + ph2))
    # Warped read positions = integral of (1 + speed deviation). dev is
    # zero-mean, so this stays ≈ t with a sub-sample wobble around it.
    warp = np.cumsum(1.0 + dev)
    warp -= warp[0]                       # start at 0
    warp = np.clip(warp, 0, n - 1)
    return np.interp(warp, t, x)


def _group_delay(x, ch, rng):
    """Frequency-dependent delay: a short allpass-style smear that delays
    high frequencies more than low ones."""
    max_delay = ch.group_delay_hi_ms * 1e-3 * ch.sample_rate
    if max_delay < 0.5:
        return x
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x))               # 0..0.5
    frac = np.clip((f * ch.sample_rate - ch.band_low_hz) /
                   max(1.0, ch.band_high_hz - ch.band_low_hz), 0, 1)
    phase = -2*np.pi * f * (frac * max_delay)  # extra phase ramp for highs
    return np.fft.irfft(X * np.exp(1j*phase), n=len(x))


def _agc(x, ch, rng):
    """Envelope-following gain that pumps when level changes — the enemy of
    amplitude-based schemes, harmless to constant-envelope ones."""
    sr = ch.sample_rate
    atk = np.exp(-1.0 / (ch.agc_attack_ms  * 1e-3 * sr))
    rel = np.exp(-1.0 / (ch.agc_release_ms * 1e-3 * sr))
    env = 0.0
    out = np.empty_like(x)
    target = ch.agc_target_rms
    for i, s in enumerate(x):
        a = abs(s)
        coeff = atk if a > env else rel
        env = coeff*env + (1.0-coeff)*a
        gain = target / (env + 1e-6)
        out[i] = s * gain
    return out


def _dropouts(x, ch, rng):
    n  = len(x); sr = ch.sample_rate
    gain = np.ones(n)
    n_drop = rng.poisson(ch.dropout_per_sec * n / sr)
    for _ in range(n_drop):
        start = rng.randint(0, n)
        dur   = max(1, int(rng.exponential(ch.dropout_ms_mean) * 1e-3 * sr))
        end   = min(n, start + dur)
        # Smooth dip so we don't create a click that helps/hurts artificially.
        w = np.hanning(end - start) if end - start > 1 else np.array([1.0])
        gain[start:end] *= (1.0 - (1.0 - ch.dropout_depth) * w)
    return x * gain


def _hiss(x, ch, rng):
    sig_pow = np.mean(x**2) + 1e-12
    noise_pow = sig_pow / (10.0 ** (ch.snr_db / 10.0))
    return x + rng.normal(0.0, np.sqrt(noise_pow), len(x))


def simulate_cassette(audio: np.ndarray, ch: CassetteChannel) -> np.ndarray:
    """Pass a clean modem signal through the modelled deck. Returns degraded
    audio at the same length/sample-rate, normalised to a sane level."""
    rng = np.random.RandomState(ch.seed)
    x = audio.astype(np.float64)
    x = _wow_flutter(x, ch, rng)
    x = _bandlimit(x, ch, rng)
    x = _group_delay(x, ch, rng)
    x = _dropouts(x, ch, rng)
    if ch.agc_enabled:
        x = _agc(x, ch, rng)
    x = _hiss(x, ch, rng)
    peak = np.max(np.abs(x))
    if peak > 1e-9:
        x = x / peak * 0.95
    return x.astype(np.float32)
