// Analyzes a played-back capture of the tape-characterisation test signal (see
// layout.ts / generate.ts) and measures the channel impairments a cassette deck
// imposes: noise floor & hum, wow/flutter & SNR on a reference tone, frequency
// response, intermodulation distortion, AGC behaviour, and end-to-end modem
// block decode rates.
//
// Pure TypeScript (no browser APIs) so it runs under vitest. The capture is the
// generator's signal after a round-trip through a real (or simulated) deck, so
// it differs by: a start offset (leading tape), an overall speed error (capstan
// drift — the whole thing stretched/squeezed), per-frequency amplitude/phase
// distortion, additive noise, and possibly truncation (partial capture).
//
// Pipeline:
//   Step 1 — Segmentation. Rebuild the reference MARKER chirp with the exact
//     generator formula and matched-filter it across the capture (a normalised
//     sliding dot-product). The capture is MARKER seg MARKER seg … MARKER, so
//     the strongest, suitably-spaced correlation peaks are the marker centres;
//     the audio between consecutive markers is a segment, mapped to LAYOUT in
//     order. A coarse stride scan finds candidate peaks cheaply; each is then
//     refined sample-accurately. Speed error is recovered by comparing measured
//     marker spacings against the nominal spacings the generator would produce
//     for the FIXED-duration segments (whose source lengths we know).
//
//   Step 2 — Per-segment metrics, each tolerant of a thrown error (a failing
//     segment reports a single `error` metric rather than aborting the report).
//
//   Step 3 — A few human-readable summary lines with threshold verdicts.
//
// Conventions: levels are dBFS (20·log10 of an amplitude/RMS vs 1.0 full-scale).
// "speedRatioPct" is captured-length / nominal-length ×100, so >100% means the
// capture is longer than it should be (tape ran slow).

import { fftInPlace } from "../dsp/fft";
import { DecoderState } from "../dsp/decoderState";
import { METADATA_SEQ } from "../dsp/settings";
import {
  SR,
  MARKER,
  LAYOUT,
  Segment,
  ToneSeg,
  SweepSeg,
  TwoToneSeg,
  AgcSeg,
  MethodSeg,
  SilenceSeg,
  methodSettings,
  expectedBlocks,
} from "./layout";

export interface SegmentReport {
  id: string;
  label: string;
  kind: string;
  found: boolean;
  metrics: Record<string, number | string>;
}

export interface CaptureReport {
  sr: number;
  durationSec: number;
  markersExpected: number;
  markersFound: number;
  speedRatioPct: number;
  segments: SegmentReport[];
  summary: string[];
}

// ----------------------------------------------------------------------------
// Small DSP helpers
// ----------------------------------------------------------------------------

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function rms(buf: Float64Array, from = 0, to = buf.length): number {
  let s = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / n);
}

function toDbfs(amp: number): number {
  return 20 * Math.log10(Math.max(amp, 1e-12));
}

/** Forward real FFT into provided re/im scratch of length n (power of 2). */
function realFft(samples: Float64Array, n: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(samples.length, n);
  for (let i = 0; i < len; i++) re[i] = samples[i];
  fftInPlace(re, im, false);
  return { re, im };
}

/** Magnitude of FFT bin nearest frequency `f` (no interpolation). */
function magAt(re: Float64Array, im: Float64Array, n: number, sr: number, f: number): number {
  const k = Math.round((f * n) / sr);
  if (k < 0 || k >= n) return 0;
  return Math.hypot(re[k], im[k]);
}

/** Linearly-interpolated magnitude at frequency `f`. */
function magInterp(re: Float64Array, im: Float64Array, n: number, sr: number, f: number): number {
  const kf = (f * n) / sr;
  const k0 = Math.floor(kf);
  const k1 = k0 + 1;
  if (k0 < 0 || k1 >= n) return magAt(re, im, n, sr, f);
  const m0 = Math.hypot(re[k0], im[k0]);
  const m1 = Math.hypot(re[k1], im[k1]);
  const t = kf - k0;
  return m0 * (1 - t) + m1 * t;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** One-pole low-pass (exponential moving average) in place, forward only. */
function onePoleLowpass(buf: Float64Array, cutoffHz: number, sr: number): Float64Array {
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const out = new Float64Array(buf.length);
  let y = buf[0] ?? 0;
  for (let i = 0; i < buf.length; i++) {
    y += alpha * (buf[i] - y);
    out[i] = y;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Reference marker + nominal layout geometry
// ----------------------------------------------------------------------------

/** Rebuild the marker chirp exactly as the generator does (sans fades — fades
 * barely move the matched filter and keeping the full-amplitude reference is
 * marginally more robust). */
function buildMarkerRef(): Float64Array {
  const n = Math.round(MARKER.durSec * SR);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    const freq = MARKER.f0 + (MARKER.f1 - MARKER.f0) * frac;
    out[i] = MARKER.amp * Math.sin(phase);
    phase += (2 * Math.PI * freq) / SR;
  }
  return out;
}

const MARKER_LEN_NOMINAL = Math.round(MARKER.durSec * SR);

/** Nominal source length (in samples at SR) of a segment whose duration we know
 * up front. Returns null for "method" segments — their length depends on the
 * encoder and is not known here. */
function nominalSegmentLength(seg: Segment): number | null {
  switch (seg.kind) {
    case "silence":
      return Math.round((seg as SilenceSeg).durSec * SR);
    case "tone":
      return Math.round((seg as ToneSeg).durSec * SR);
    case "sweep":
      return Math.round((seg as SweepSeg).durSec * SR);
    case "twotone":
      return Math.round((seg as TwoToneSeg).durSec * SR);
    case "agc": {
      let total = 0;
      for (const step of (seg as AgcSeg).steps) total += Math.round(step.durSec * SR);
      return total;
    }
    case "method":
      return null;
  }
}

// ----------------------------------------------------------------------------
// Step 1 — Segmentation (matched-filter the marker chirp)
// ----------------------------------------------------------------------------

interface MarkerDetection {
  center: number; // sample index of the marker's centre
  start: number; // sample index of the marker's start
  end: number; // sample index just past the marker (segment audio begins here)
  score: number; // normalised correlation at the peak
}

/** Resample a reference chirp to a new length by linear interpolation, so we can
 * build a bank of slightly speed-scaled templates. */
function resampleRef(ref: Float64Array, newLen: number): Float64Array {
  const out = new Float64Array(newLen);
  const src = ref.length;
  for (let i = 0; i < newLen; i++) {
    const x = (i * (src - 1)) / Math.max(1, newLen - 1);
    const i0 = Math.floor(x);
    const t = x - i0;
    const a = ref[i0] ?? 0;
    const b = ref[i0 + 1] ?? a;
    out[i] = a * (1 - t) + b * t;
  }
  return out;
}

interface CorrelationResult {
  /** Best normalised score per signal offset, maximised across the template bank. */
  score: Float64Array;
  /** Window length (samples) of the template that won at each offset — used to
   * place the marker END (and hence the segment boundary) speed-correctly. */
  bestLen: Int32Array;
}

/** Full normalised sliding cross-correlation of a chirp over `signal`, evaluated
 * at EVERY start offset, via FFT — and made speed-tolerant by matching against a
 * BANK of time-scaled copies of the reference.
 *
 * Why a bank: a linear chirp's matched-filter response collapses under even ~0.5%
 * time-stretch (its accumulated phase drifts across the 0.25 s sweep), yet tape
 * speed error of several percent is exactly what we must survive and measure. So
 * we correlate against templates spanning ±~6% in length and keep, per offset,
 * the best score and the winning template length.
 *
 * For one template, score[off] = (Σ signal[off+i]·ref[i]) / sqrt(refEnergy ·
 * Σ signal[off+i]²): the numerator is a cross-correlation (linear convolution of
 * `signal` with the time-reversed template, done in the frequency domain,
 * O(N log N)); the per-window energy is a prefix-sum of squares (O(N)). The
 * signal's forward FFT is shared across all templates. */
function correlateChirpBank(signal: Float64Array, ref: Float64Array): CorrelationResult {
  const N = signal.length;
  const baseLen = ref.length;
  if (N < Math.floor(baseLen * 0.9)) {
    return { score: new Float64Array(0), bestLen: new Int32Array(0) };
  }

  // Conv size must hold N + the longest template (use the +6% bound).
  const maxLen = Math.ceil(baseLen * 1.07);
  const conv = nextPow2(N + maxLen);

  // Forward FFT of the signal — computed once, reused per template.
  const Sre = new Float64Array(conv);
  const Sim = new Float64Array(conv);
  for (let i = 0; i < N; i++) Sre[i] = signal[i];
  fftInPlace(Sre, Sim, false);

  // Prefix sum of squares for sliding window energy.
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + signal[i] * signal[i];

  const last = N - Math.floor(baseLen * 0.94); // smallest template still fits up to here
  const bestScore = new Float64Array(Math.max(0, last + 1));
  bestScore.fill(-Infinity);
  const bestLen = new Int32Array(Math.max(0, last + 1));

  // Floor the window energy: a near-silent window divides FFT round-off by a tiny
  // denominator and fakes a >1 correlation. Real markers carry reference-level
  // energy, so clamp anything far below.
  const meanWinEnergy = prefix[N] / Math.max(1, N / baseLen);

  // Template bank: ±6% in ~0.6% steps (≈ every other template stays >0.8 corr
  // even mid-way between speeds, per the chirp's stretch sensitivity).
  const stretches: number[] = [];
  for (let s = 0.94; s <= 1.0601; s += 0.006) stretches.push(s);

  const Tre = new Float64Array(conv);
  const Tim = new Float64Array(conv);
  const Cre = new Float64Array(conv);
  const Cim = new Float64Array(conv);

  for (const s of stretches) {
    const tLen = Math.max(2, Math.round(baseLen * s));
    if (tLen > N) continue;
    const tmpl = resampleRef(ref, tLen);
    let tEnergy = 0;
    for (let i = 0; i < tLen; i++) tEnergy += tmpl[i] * tmpl[i];
    const tNorm = Math.sqrt(tEnergy) || 1e-12;
    const energyFloor = Math.max(tEnergy, meanWinEnergy) * 1e-3;

    Tre.fill(0);
    Tim.fill(0);
    for (let i = 0; i < tLen; i++) Tre[i] = tmpl[tLen - 1 - i]; // time-reverse → correlation
    fftInPlace(Tre, Tim, false);

    for (let k = 0; k < conv; k++) {
      const ar = Sre[k];
      const ai = Sim[k];
      const br = Tre[k];
      const bi = Tim[k];
      Cre[k] = ar * br - ai * bi;
      Cim[k] = ar * bi + ai * br;
    }
    fftInPlace(Cre, Cim, true); // Cre now holds the convolution

    const lastT = N - tLen;
    const upper = Math.min(last, lastT);
    for (let off = 0; off <= upper; off++) {
      const dot = Cre[off + tLen - 1];
      const winEnergy = prefix[off + tLen] - prefix[off];
      const denom = tNorm * Math.sqrt(Math.max(winEnergy, energyFloor));
      const sc = dot / denom;
      if (sc > bestScore[off]) {
        bestScore[off] = sc;
        bestLen[off] = tLen;
      }
    }
  }
  // Any offset never covered by a template (shouldn't happen) → 0.
  for (let i = 0; i < bestScore.length; i++) if (!isFinite(bestScore[i])) bestScore[i] = 0;
  return { score: bestScore, bestLen };
}

/** Find marker positions in the capture. Score every offset with the speed-
 * tolerant FFT matched-filter bank, then pick spacing-separated peaks by greedy
 * non-maximum suppression on the score. We expect LAYOUT.length+1 markers but
 * accept fewer (partial capture). */
function findMarkers(signal: Float64Array, ref: Float64Array): MarkerDetection[] {
  const refLen = ref.length;
  const { score: scores, bestLen } = correlateChirpBank(signal, ref);
  if (scores.length === 0) return [];

  // Minimum spacing between accepted peaks: half the smallest marker-to-marker
  // spacing the generator can produce (MARKER + shortest known segment). A
  // conservative fraction so plausible speed error can't merge two real markers.
  let minSegLen = Infinity;
  for (const seg of LAYOUT) {
    const L = nominalSegmentLength(seg);
    if (L != null) minSegLen = Math.min(minSegLen, L);
  }
  if (!isFinite(minSegLen)) minSegLen = refLen;
  const minSpacing = Math.floor(0.5 * (refLen + minSegLen));

  let maxScore = -Infinity;
  for (let i = 0; i < scores.length; i++) if (scores[i] > maxScore) maxScore = scores[i];
  // Markers can be attenuated by the deck; accept down to a fraction of the best.
  const threshold = Math.max(0.2, maxScore * 0.4);

  interface Cand {
    start: number;
    score: number;
    len: number;
  }
  const cands: Cand[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] >= threshold) cands.push({ start: i, score: scores[i], len: bestLen[i] || refLen });
  }
  if (cands.length === 0) {
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    cands.push({ start: bi, score: scores[bi], len: bestLen[bi] || refLen });
  }

  // Greedy NMS by score, enforcing minSpacing — collapses each peak (and its
  // sidelobes) to a single detection.
  cands.sort((a, b) => b.score - a.score);
  const kept: Cand[] = [];
  for (const c of cands) {
    let ok = true;
    for (const k of kept) {
      if (Math.abs(c.start - k.start) < minSpacing) {
        ok = false;
        break;
      }
    }
    if (ok) kept.push(c);
  }

  const refined: MarkerDetection[] = kept.map((c) => ({
    start: c.start,
    end: c.start + c.len,
    center: c.start + Math.floor(c.len / 2),
    score: c.score,
  }));
  refined.sort((a, b) => a.start - b.start);
  return refined;
}

// ----------------------------------------------------------------------------
// Step 1b — speed ratio from fixed-duration segment spacings
// ----------------------------------------------------------------------------

/** Estimate captured/nominal length ratio. For each consecutive marker pair that
 * brackets a FIXED-duration segment, the nominal spacing is markerLen + segLen;
 * the measured spacing is the gap between detected marker starts. Average the
 * ratios. Returns 1 if nothing usable. */
function estimateSpeedRatio(markers: MarkerDetection[], segCount: number): number {
  if (markers.length < 2) return 1;
  // markers[i] precedes LAYOUT[i]; the i-th segment lies between markers[i] and
  // markers[i+1]. Only use segments we both detected and whose length is known.
  const ratios: number[] = [];
  for (let i = 0; i < segCount && i + 1 < markers.length; i++) {
    const nominalSeg = nominalSegmentLength(LAYOUT[i]);
    if (nominalSeg == null) continue;
    const nominalSpacing = MARKER_LEN_NOMINAL + nominalSeg;
    const measuredSpacing = markers[i + 1].start - markers[i].start;
    if (measuredSpacing > 0 && nominalSpacing > 0) ratios.push(measuredSpacing / nominalSpacing);
  }
  if (ratios.length === 0) return 1;
  ratios.sort((a, b) => a - b);
  // Median is robust to a stray mis-detected marker.
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

// ----------------------------------------------------------------------------
// Step 2 — per-segment metric extractors
// ----------------------------------------------------------------------------

function analyzeSilence(region: Float64Array, sr: number): Record<string, number | string> {
  const floor = rms(region);
  const n = nextPow2(Math.min(region.length, 1 << 16));
  const { re, im } = realFft(region, n);
  // Strongest 40–120 Hz component (mains hum), relative to full scale. FFT bin
  // magnitude → amplitude requires the 2/N scaling (single-sided).
  let humAmp = 0;
  const kLo = Math.max(1, Math.floor((40 * n) / sr));
  const kHi = Math.min(n / 2 - 1, Math.ceil((120 * n) / sr));
  for (let k = kLo; k <= kHi; k++) {
    const a = (2 * Math.hypot(re[k], im[k])) / n;
    if (a > humAmp) humAmp = a;
  }
  return {
    noiseFloorDbfs: round2(toDbfs(floor)),
    humDbfs: round2(toDbfs(humAmp)),
  };
}

function analyzeTone(region: Float64Array, sr: number, seg: ToneSeg): Record<string, number | string> {
  const freq = seg.freq;
  const N = region.length;
  // Complex demodulation to baseband: multiply by e^{-j2πf t}, low-pass each
  // quadrature, then the phase of (I + jQ) carries the instantaneous frequency
  // deviation about `freq`.
  const I = new Float64Array(N);
  const Q = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const ph = (2 * Math.PI * freq * i) / sr;
    I[i] = region[i] * Math.cos(ph);
    Q[i] = region[i] * -Math.sin(ph);
  }
  // Low-pass well below freq to keep only the baseband term (kills the 2·freq
  // image). 200 Hz comfortably passes wow/flutter (<20 Hz) and tone drift.
  const Ilp = onePoleLowpass(I, 200, sr);
  const Qlp = onePoleLowpass(Q, 200, sr);

  // Instantaneous phase, unwrapped.
  const phase = new Float64Array(N);
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    let p = Math.atan2(Qlp[i], Ilp[i]);
    if (i > 0) {
      let d = p - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      acc += d;
    } else {
      acc = p;
    }
    prev = p;
    phase[i] = acc;
  }
  // Δf(t) = (1/2π) dφ/dt  — instantaneous deviation from `freq` (Hz).
  // Trim filter settling at both ends.
  const trim = Math.min(N >> 3, Math.floor(0.05 * sr));
  const lo = trim;
  const hi = N - trim;
  const M = Math.max(0, hi - lo);
  const df = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const a = phase[lo + i];
    const b = phase[lo + i + 1 < N ? lo + i + 1 : lo + i];
    df[i] = ((b - a) * sr) / (2 * Math.PI);
  }

  let meanDf = 0;
  for (let i = 0; i < M; i++) meanDf += df[i];
  meanDf = M ? meanDf / M : 0;

  // Peak deviation (wow+flutter as peak |Δf|/freq). Band-limit Δf to the
  // wow/flutter band (≤20 Hz) first: the raw derivative carries demodulator hiss
  // whose isolated spikes would otherwise dominate the peak and have nothing to
  // do with speed modulation.
  const dfBand = onePoleLowpass(df, 20, sr);
  let peakDev = 0;
  // Skip the lowpass's own settling at both ends (it rings for several time
  // constants of the 20 Hz pole, ~0.1 s).
  const peakSkip = Math.min(M >> 3, Math.floor(0.1 * sr));
  for (let i = peakSkip; i < M - peakSkip; i++) peakDev = Math.max(peakDev, Math.abs(dfBand[i] - meanDf));

  // Split Δf into wow (<4 Hz) and flutter (4–20 Hz) bands via FFT, RMS each.
  const nf = nextPow2(Math.max(2, Math.min(M, 1 << 15)));
  const dre = new Float64Array(nf);
  const dim = new Float64Array(nf);
  for (let i = 0; i < Math.min(M, nf); i++) dre[i] = df[i] - meanDf;
  fftInPlace(dre, dim, false);
  let wowPow = 0;
  let flutterPow = 0;
  const fres = sr / nf;
  for (let k = 1; k < nf / 2; k++) {
    const f = k * fres;
    const p = (dre[k] * dre[k] + dim[k] * dim[k]) / (nf * nf);
    if (f < 4) wowPow += 2 * p;
    else if (f <= 20) flutterPow += 2 * p;
  }
  const wowRms = Math.sqrt(wowPow);
  const flutterRms = Math.sqrt(flutterPow);

  // SNR: power within ±30 Hz of `freq` vs power elsewhere over 0–8 kHz. Window
  // the tone first (Hann) so its spectral leakage doesn't masquerade as noise in
  // the surrounding bins — on a clean tone a rectangular window alone caps SNR
  // around 30 dB regardless of true noise.
  const fftLen = Math.min(N, 1 << 17);
  const n2 = nextPow2(fftLen);
  const wsnr = hann(fftLen);
  const windowed = new Float64Array(fftLen);
  for (let i = 0; i < fftLen; i++) windowed[i] = region[i] * wsnr[i];
  const { re, im } = realFft(windowed, n2);
  const kCenter = Math.round((freq * n2) / sr);
  const band = Math.max(1, Math.round((30 * n2) / sr));
  const k8k = Math.min(n2 / 2 - 1, Math.round((8000 * n2) / sr));
  let sigPow = 0;
  let noisePow = 0;
  for (let k = 1; k <= k8k; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    if (Math.abs(k - kCenter) <= band) sigPow += p;
    else noisePow += p;
  }
  const snrDb = 10 * Math.log10(sigPow / Math.max(noisePow, 1e-12));

  return {
    measuredFreqHz: round2(freq + meanDf),
    wowPct: round3((wowRms / freq) * 100),
    flutterPct: round3((flutterRms / freq) * 100),
    wowFlutterPct: round3((peakDev / freq) * 100),
    snrDb: round2(snrDb),
  };
}

function analyzeSweep(region: Float64Array, sr: number, seg: SweepSeg): Record<string, number | string> {
  const N = region.length;
  const win = 1024;
  if (N < win * 2) throw new Error("sweep region too short");
  const hop = win / 2;
  const w = hann(win);
  const durSec = N / sr; // captured duration of the sweep region

  // The generator sweeps log-frequency: f(t) = f0·(f1/f0)^(t/dur). For a frame
  // centred at time tc the instantaneous frequency is known; read the windowed
  // FFT magnitude there → response(freq).
  const freqs: number[] = [];
  const resp: number[] = [];
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  for (let start = 0; start + win <= N; start += hop) {
    for (let i = 0; i < win; i++) {
      re[i] = region[start + i] * w[i];
      im[i] = 0;
    }
    fftInPlace(re, im, false);
    const tc = (start + win / 2) / sr;
    const f = seg.f0 * Math.pow(seg.f1 / seg.f0, tc / durSec);
    if (f <= 0 || f >= sr / 2) continue;
    const mag = magInterp(re, im, win, sr, f);
    freqs.push(f);
    resp.push(mag);
  }
  if (freqs.length < 2) throw new Error("sweep produced too few frames");

  // Convert to dB normalised to the max in-band response.
  let maxMag = 0;
  for (const m of resp) maxMag = Math.max(maxMag, m);
  const respDb = resp.map((m) => 20 * Math.log10(Math.max(m, 1e-12) / Math.max(maxMag, 1e-12)));

  const interpDbAt = (f: number): number => {
    // freqs are monotonically increasing.
    if (f <= freqs[0]) return respDb[0];
    if (f >= freqs[freqs.length - 1]) return respDb[respDb.length - 1];
    let i = 1;
    while (i < freqs.length && freqs[i] < f) i++;
    const t = (f - freqs[i - 1]) / (freqs[i] - freqs[i - 1]);
    return respDb[i - 1] * (1 - t) + respDb[i] * t;
  };

  const points = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
  const metrics: Record<string, number | string> = {};
  for (const f of points) metrics[`respDb_${f}`] = round2(interpDbAt(f));

  // -3 / -6 dB rolloff: highest frequency before response drops 3/6 dB below the
  // in-band max (scanning upward from the peak frequency). Reference is 0 dB
  // (the normalised max).
  const findRolloff = (dropDb: number): number => {
    // Find the frequency of the max-response frame, then scan upward.
    let peakIdx = 0;
    for (let i = 1; i < respDb.length; i++) if (respDb[i] > respDb[peakIdx]) peakIdx = i;
    let lastGood = freqs[peakIdx];
    for (let i = peakIdx; i < respDb.length; i++) {
      if (respDb[i] >= -dropDb) lastGood = freqs[i];
      else break;
    }
    return lastGood;
  };
  metrics.minus3dbHz = round2(findRolloff(3));
  metrics.minus6dbHz = round2(findRolloff(6));
  return metrics;
}

function analyzeTwoTone(region: Float64Array, sr: number, seg: TwoToneSeg): Record<string, number | string> {
  const n = nextPow2(Math.min(region.length, 1 << 17));
  const { re, im } = realFft(region, n);
  const f1 = seg.f1;
  const f2 = seg.f2;
  const A1 = magAt(re, im, n, sr, f1);
  const A2 = magAt(re, im, n, sr, f2);

  const products: { f: number; mag: number }[] = [
    { f: Math.abs(f2 - f1), mag: magAt(re, im, n, sr, Math.abs(f2 - f1)) },
    { f: 2 * f1 - f2, mag: magAt(re, im, n, sr, 2 * f1 - f2) },
    { f: 2 * f2 - f1, mag: magAt(re, im, n, sr, 2 * f2 - f1) },
    { f: f1 + f2, mag: magAt(re, im, n, sr, f1 + f2) },
    { f: 2 * f1, mag: magAt(re, im, n, sr, 2 * f1) },
    { f: 2 * f2, mag: magAt(re, im, n, sr, 2 * f2) },
  ];

  let prodSq = 0;
  let worst = products[0];
  for (const p of products) {
    prodSq += p.mag * p.mag;
    if (p.mag > worst.mag) worst = p;
  }
  const fundSq = A1 * A1 + A2 * A2;
  const imdPct = (Math.sqrt(prodSq) / Math.sqrt(Math.max(fundSq, 1e-12))) * 100;
  const worstDb = 20 * Math.log10(Math.max(worst.mag, 1e-12) / Math.sqrt(Math.max(fundSq, 1e-12)));

  return {
    imdPct: round3(imdPct),
    worstProductHz: round2(worst.f),
    worstProductDb: round2(worstDb),
  };
}

function analyzeAgc(region: Float64Array, sr: number, seg: AgcSeg): Record<string, number | string> {
  const steps = seg.steps;
  // Nominal total source length → per-step fraction of the captured region.
  let nominalTotal = 0;
  for (const s of steps) nominalTotal += Math.round(s.durSec * SR);
  const N = region.length;

  const inAmps = steps.map((s) => s.amp);
  const outRms: number[] = [];
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    const fracStart = acc / nominalTotal;
    acc += Math.round(steps[i].durSec * SR);
    const fracEnd = acc / nominalTotal;
    let a = Math.floor(fracStart * N);
    let b = Math.floor(fracEnd * N);
    // Skip a small settling margin at each step boundary so a transition isn't
    // averaged into the level.
    const margin = Math.min(Math.floor(0.05 * sr), Math.floor((b - a) / 4));
    a = Math.min(N, a + margin);
    b = Math.max(a + 1, Math.min(N, b - margin));
    outRms.push(rms(region, a, b));
  }

  const inDb = inAmps.map((a) => toDbfs(a));
  const outDb = outRms.map((a) => toDbfs(a));
  const inRange = Math.max(...inDb) - Math.min(...inDb);
  const outRange = Math.max(...outDb) - Math.min(...outDb);
  const compressionDb = inRange - outRange;
  const agcDetected = compressionDb > 6 ? "yes" : "no";

  // Recovery time: after a loud→soft transition, how long the captured envelope
  // takes to settle within a soft step. Find the first step that is much softer
  // than its predecessor, then measure from its start to where its short-window
  // envelope first comes within 10% of the step's steady-state level.
  let recoveryMs: number | string = "n/a";
  if (agcDetected === "yes") {
    let target = -1;
    for (let i = 1; i < steps.length; i++) {
      if (inAmps[i] < inAmps[i - 1] * 0.5) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      let aAcc = 0;
      for (let i = 0; i < target; i++) aAcc += Math.round(steps[i].durSec * SR);
      const startFrac = aAcc / nominalTotal;
      const endFrac = (aAcc + Math.round(steps[target].durSec * SR)) / nominalTotal;
      const a = Math.floor(startFrac * N);
      const b = Math.min(N, Math.floor(endFrac * N));
      const winLen = Math.max(1, Math.floor(0.01 * sr)); // 10 ms envelope window
      const steady = rms(region, Math.max(a, b - winLen * 3), b);
      // Walk forward from the step start; settle = within 10% of steady RMS.
      let settleIdx = b;
      for (let p = a; p + winLen <= b; p += winLen) {
        const e = rms(region, p, p + winLen);
        if (Math.abs(e - steady) <= 0.1 * Math.max(steady, 1e-9)) {
          settleIdx = p;
          break;
        }
      }
      recoveryMs = round1(((settleIdx - a) / sr) * 1000);
    }
  }

  return {
    inLevels: inAmps.map((a) => a.toFixed(3)).join(","),
    outRmsDbfs: outDb.map((d) => round2(d)).join(","),
    agcDetected,
    compressionDb: round2(compressionDb),
    recoveryMs,
  };
}

function analyzeMethod(region: Float64Array, seg: MethodSeg): Record<string, number | string> {
  const settings = methodSettings(seg);
  const decoder = new DecoderState(settings);
  const expected = expectedBlocks(seg);

  // Feed in chunks. Real-time-ish chunking keeps the streaming demod's internal
  // state machine behaving as it does live; feeding the whole region in one shot
  // can change OFDM framing edge behaviour.
  const chunk = 4096;
  let dataBlocks = 0;
  for (let off = 0; off < region.length; off += chunk) {
    const end = Math.min(region.length, off + chunk);
    const slice = region.subarray(off, end);
    const blocks = decoder.feedAudio(slice);
    for (const b of blocks) if (b.seq !== METADATA_SEQ) dataBlocks++;
  }
  const successPct = expected > 0 ? (dataBlocks / expected) * 100 : 0;
  return {
    blocksDecoded: dataBlocks,
    blocksExpected: expected,
    successPct: round1(successPct),
  };
}

// ----------------------------------------------------------------------------
// rounding helpers (keep report numbers readable)
// ----------------------------------------------------------------------------
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ----------------------------------------------------------------------------
// Step 3 — summary
// ----------------------------------------------------------------------------

function buildSummary(report: CaptureReport): string[] {
  const lines: string[] = [];

  if (report.markersFound < report.markersExpected) {
    lines.push(
      `Partial capture: found ${report.markersFound}/${report.markersExpected} markers`
    );
  }

  const speedErr = report.speedRatioPct - 100;
  if (Math.abs(speedErr) >= 0.3) {
    const dir = speedErr > 0 ? "slow" : "fast";
    lines.push(`Tape speed: ${report.speedRatioPct.toFixed(1)}% (${dir} by ${Math.abs(speedErr).toFixed(1)}%)`);
  } else {
    lines.push(`Tape speed: ${report.speedRatioPct.toFixed(1)}% (on spec)`);
  }

  const byId = (id: string) => report.segments.find((s) => s.id === id);

  const tone = byId("ref1k");
  if (tone?.found && typeof tone.metrics.wowFlutterPct === "number") {
    const wf = tone.metrics.wowFlutterPct;
    const verdict = wf < 0.15 ? "excellent" : wf < 0.3 ? "good" : wf < 0.6 ? "fair" : "poor";
    lines.push(`Wow/flutter: ${wf}% peak (${verdict})`);
    if (typeof tone.metrics.snrDb === "number") {
      const snr = tone.metrics.snrDb;
      const sv = snr > 55 ? "excellent" : snr > 45 ? "good" : snr > 35 ? "fair" : "poor";
      lines.push(`SNR: ${snr} dB (${sv})`);
    }
  }

  const sweep = byId("sweep");
  if (sweep?.found && typeof sweep.metrics.minus3dbHz === "number") {
    lines.push(`Response -3 dB at ${(sweep.metrics.minus3dbHz / 1000).toFixed(1)} kHz`);
  }

  const noise = byId("noise");
  if (noise?.found && typeof noise.metrics.noiseFloorDbfs === "number") {
    lines.push(`Noise floor: ${noise.metrics.noiseFloorDbfs} dBFS`);
  }

  const twotone = byId("twotone");
  if (twotone?.found && typeof twotone.metrics.imdPct === "number") {
    const imd = twotone.metrics.imdPct;
    const verdict = imd < 1 ? "low" : imd < 3 ? "moderate" : "high";
    lines.push(`IMD: ${imd}% (${verdict})`);
  }

  const agc = byId("agc");
  if (agc?.found) {
    if (agc.metrics.agcDetected === "yes") {
      lines.push(`AGC: detected, ${agc.metrics.compressionDb} dB compression`);
    } else if (agc.metrics.agcDetected === "no") {
      lines.push(`AGC: not detected`);
    }
  }

  for (const seg of report.segments) {
    if (seg.kind !== "method" || !seg.found) continue;
    const dec = seg.metrics.blocksDecoded;
    const exp = seg.metrics.blocksExpected;
    const pct = seg.metrics.successPct;
    if (typeof dec === "number" && typeof exp === "number" && typeof pct === "number") {
      lines.push(`${seg.label}: ${dec}/${exp} blocks (${pct.toFixed(0)}%)`);
    }
  }

  return lines;
}

// ----------------------------------------------------------------------------
// Top-level
// ----------------------------------------------------------------------------

export function analyzeCapture(samples: Float32Array, sr: number): CaptureReport {
  // Work in Float64 throughout.
  const signal = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) signal[i] = samples[i];

  const markersExpected = LAYOUT.length + 1;
  const durationSec = signal.length / sr;

  const ref = buildMarkerRef();
  const markers = findMarkers(signal, ref);
  const markersFound = markers.length;

  // Speed ratio uses the fixed-duration segments' nominal lengths (computed at
  // SR); if the capture sr differs from SR the geometry comparison must be in the
  // same time base — convert measured spacings (in capture samples) to SR samples.
  const srScale = SR / sr;
  const markersInSrSamples: MarkerDetection[] = markers.map((m) => ({
    ...m,
    start: m.start * srScale,
    center: m.center * srScale,
  }));
  const speedRatio = estimateSpeedRatio(markersInSrSamples, LAYOUT.length);

  const segments: SegmentReport[] = LAYOUT.map((seg, i) => {
    const base: SegmentReport = {
      id: seg.id,
      label: seg.label,
      kind: seg.kind,
      found: false,
      metrics: {},
    };
    // Segment i lives between the end of markers[i] and the start of markers[i+1].
    if (i + 1 >= markers.length) return base;
    const a = markers[i].end;
    const b = markers[i + 1].start;
    if (b - a < Math.floor(0.02 * sr)) {
      // Too short to mean anything.
      return base;
    }
    const region = signal.subarray(a, b);
    try {
      let metrics: Record<string, number | string>;
      switch (seg.kind) {
        case "silence":
          metrics = analyzeSilence(region, sr);
          break;
        case "tone":
          metrics = analyzeTone(region, sr, seg as ToneSeg);
          break;
        case "sweep":
          metrics = analyzeSweep(region, sr, seg as SweepSeg);
          break;
        case "twotone":
          metrics = analyzeTwoTone(region, sr, seg as TwoToneSeg);
          break;
        case "agc":
          metrics = analyzeAgc(region, sr, seg as AgcSeg);
          break;
        case "method":
          metrics = analyzeMethod(region, seg as MethodSeg);
          break;
        default:
          metrics = {};
      }
      return { ...base, found: true, metrics };
    } catch (err) {
      return {
        ...base,
        found: true,
        metrics: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  const report: CaptureReport = {
    sr,
    durationSec: round2(durationSec),
    markersExpected,
    markersFound,
    speedRatioPct: round2(speedRatio * 100),
    segments,
    summary: [],
  };
  report.summary = buildSummary(report);
  return report;
}
