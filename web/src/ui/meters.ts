// Live signal meters for the decoder: a level bar + spectrum. Shows there's a
// signal (and where its energy sits) even when nothing decodes — so a user can
// tell "wrong settings" (energy present, no lock) from "no signal".

import { fftInPlace } from "../dsp/fft";

const N = 1024;

export class Meters {
  private buf = new Float32Array(N);
  private w = 0;
  private re = new Float64Array(N);
  private im = new Float64Array(N);

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.w] = samples[i];
      this.w = (this.w + 1) % N;
    }
  }

  draw(cv: HTMLCanvasElement, locked: boolean): void {
    const ctx = cv.getContext("2d")!;
    const W = cv.width;
    const H = cv.height;
    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, W, H);

    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const v = this.buf[(this.w + i) % N]; // oldest→newest
      this.re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); // Hann window
      this.im[i] = 0;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / N);
    fftInPlace(this.re, this.im, false);

    const bins = N / 2;
    const mags = new Float64Array(bins);
    let peak = 1e-9;
    for (let k = 1; k < bins; k++) { mags[k] = Math.hypot(this.re[k], this.im[k]); if (mags[k] > peak) peak = mags[k]; }
    // auto-scale to the peak bin so the shape is always visible when there's signal
    ctx.fillStyle = locked ? "#00c87a" : rms > 0.01 ? "#f5a623" : "#555";
    const top = 6;
    for (let k = 1; k < bins; k++) {
      const norm = rms > 0.005 ? mags[k] / peak : 0;
      const x = (k / bins) * W;
      ctx.fillRect(x, top + (H - top) * (1 - norm), Math.max(1, W / bins), (H - top) * norm);
    }
    // level bar across the top
    ctx.fillStyle = rms > 0.01 ? "#00c87a" : "#555";
    ctx.fillRect(0, 0, Math.min(1, rms / 0.5) * W, 4);
  }
}
