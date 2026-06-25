// Play a mono Float sample buffer out the default audio device (e.g. into a
// tape deck's line-in). Browser-only.

export class Playback {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;

  async play(samples: Float32Array, sampleRate: number, onEnded?: () => void): Promise<void> {
    this.stop();
    this.ctx = new AudioContext({ sampleRate });
    const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    const f = new Float32Array(samples.length);
    f.set(samples);
    buf.copyToChannel(f, 0);
    this.src = this.ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.connect(this.ctx.destination);
    this.src.onended = () => onEnded?.();
    this.src.start();
  }

  stop(): void {
    try { this.src?.stop(); } catch { /* already stopped */ }
    this.src = null;
    this.ctx?.close();
    this.ctx = null;
  }
}
