// IIR filtering ported to match scipy.signal: butter() design + lfilter().
// Used by the OFDM timing lock (high-pass) and the carrier-strip / de-emphasis
// decode stages. Pre-emphasis and the constant-power carrier live here too.

type C = [number, number];
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const csub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};

function polyFromRoots(roots: C[]): C[] {
  let coeffs: C[] = [[1, 0]];
  for (const r of roots) {
    const next: C[] = Array.from({ length: coeffs.length + 1 }, () => [0, 0] as C);
    for (let i = 0; i < coeffs.length; i++) {
      next[i] = cadd(next[i], coeffs[i]); // x · coeff
      next[i + 1] = csub(next[i + 1], cmul(coeffs[i], r)); // −r · coeff
    }
    coeffs = next;
  }
  return coeffs;
}

/** scipy.signal.butter(N, Wn, btype) for digital low/high-pass (Wn in 0..1,
 * 1 = Nyquist). Returns transfer-function coefficients {b, a}. */
export function butter(N: number, Wn: number, btype: "low" | "high"): { b: number[]; a: number[] } {
  const fs = 2.0;
  const warped = 2 * fs * Math.tan((Math.PI * Wn) / fs);

  // analog Butterworth lowpass prototype (buttap)
  let z: C[] = [];
  let p: C[] = [];
  for (let m = -N + 1; m < N; m += 2) {
    const t = (Math.PI * m) / (2 * N);
    p.push([-Math.cos(t), -Math.sin(t)]); // −exp(jπm/2N)
  }
  let k = 1;
  const degree = p.length - z.length; // N

  if (btype === "low") {
    z = z.map((zi) => cmul([warped, 0], zi));
    p = p.map((pi) => cmul([warped, 0], pi));
    k *= Math.pow(warped, degree);
  } else {
    let prodNegP: C = [1, 0];
    for (const pi of p) prodNegP = cmul(prodNegP, [-pi[0], -pi[1]]);
    k *= cdiv([1, 0], prodNegP)[0]; // prod(-z)=1 (no zeros)
    p = p.map((pi) => cdiv([warped, 0], pi));
    z = Array.from({ length: degree }, () => [0, 0] as C); // zeros at origin
  }

  // bilinear transform (fs=2)
  const fs2 = 2 * fs;
  const degree2 = p.length - z.length;
  let prodNumZ: C = [1, 0];
  let prodDenP: C = [1, 0];
  const zz = z.map((zi) => { prodNumZ = cmul(prodNumZ, csub([fs2, 0], zi)); return cdiv(cadd([fs2, 0], zi), csub([fs2, 0], zi)); });
  const pz = p.map((pi) => { prodDenP = cmul(prodDenP, csub([fs2, 0], pi)); return cdiv(cadd([fs2, 0], pi), csub([fs2, 0], pi)); });
  for (let i = 0; i < degree2; i++) zz.push([-1, 0]);
  const kz = k * cdiv(prodNumZ, prodDenP)[0];

  return {
    b: polyFromRoots(zz).map((c) => cmul([kz, 0], c)[0]),
    a: polyFromRoots(pz).map((c) => c[0]),
  };
}

/** scipy.signal.lfilter (Direct Form II transposed). Returns output and final
 * state, so a caller can stream by feeding zf back as zi. */
export function lfilter(b: number[], a: number[], x: ArrayLike<number>, zi?: number[]): { y: Float64Array; zf: number[] } {
  const a0 = a[0];
  const bn = b.map((v) => v / a0);
  const an = a.map((v) => v / a0);
  const n = Math.max(an.length, bn.length);
  while (bn.length < n) bn.push(0);
  while (an.length < n) an.push(0);
  const z = zi ? zi.slice() : new Array(Math.max(0, n - 1)).fill(0);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = bn[0] * xi + (z[0] ?? 0);
    for (let j = 1; j < n - 1; j++) z[j - 1] = bn[j] * xi + z[j] - an[j] * yi;
    if (n - 1 > 0) z[n - 2] = bn[n - 1] * xi - an[n - 1] * yi;
    y[i] = yi;
  }
  return { y, zf: z };
}

/** Zero-phase filtering (forward then reverse) — no group delay, so it won't
 * shift the signal (important near OFDM timing). Simpler than scipy's edge
 * handling; the edge transient is negligible for our long signals. */
export function filtfilt(b: number[], a: number[], x: ArrayLike<number>): Float64Array {
  const fwd = lfilter(b, a, x).y;
  fwd.reverse();
  const back = lfilter(b, a, fwd).y;
  back.reverse();
  return back;
}

/** RBJ band-reject (notch) biquad at f0. */
export function notchBiquad(f0: number, sampleRate: number, Q = 12): { b: number[]; a: number[] } {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b: [1 / a0, (-2 * Math.cos(w0)) / a0, 1 / a0],
    a: [1, (-2 * Math.cos(w0)) / a0, (1 - alpha) / a0],
  };
}

export function applyPreEmphasis(audio: Float64Array, alpha: number): Float64Array {
  const out = new Float64Array(audio.length);
  let prev = 0;
  for (let i = 0; i < audio.length; i++) { out[i] = audio[i] - alpha * prev; prev = audio[i]; }
  return out;
}

export function applyDeEmphasis(audio: Float64Array, alpha: number): Float64Array {
  const out = new Float64Array(audio.length);
  let prev = 0;
  for (let i = 0; i < audio.length; i++) { out[i] = audio[i] + alpha * prev; prev = out[i]; }
  return out;
}

/** np.convolve(a, kernel, mode="same"). */
function convolveSame(a: Float64Array, kernel: Float64Array): Float64Array {
  const n = a.length;
  const m = kernel.length;
  const full = new Float64Array(n + m - 1);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < m; j++) full[i + j] += ai * kernel[j];
  }
  const start = Math.floor((m - 1) / 2);
  return full.slice(start, start + n);
}

export function addConstantPowerCarrier(audio: Float64Array, sampleRate: number, carrierHz: number, targetRms: number): Float64Array {
  const n = audio.length;
  const winN = Math.max(1, Math.floor(0.02 * sampleRate));
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) sq[i] = audio[i] * audio[i];
  const kernel = new Float64Array(winN).fill(1 / winN);
  const dp = convolveSame(sq, kernel);
  const out = new Float64Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const ca = Math.sqrt(Math.max(0, targetRms * targetRms - dp[i]));
    out[i] = audio[i] + ca * Math.sin((2 * Math.PI * carrierHz * i) / sampleRate);
    sumSq += out[i] * out[i];
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms > 1e-9) for (let i = 0; i < n; i++) out[i] *= targetRms / rms;
  return out;
}
