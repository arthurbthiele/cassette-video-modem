// Live audio capture from a line-in / input device, with the browser's own
// processing (AGC, noise suppression, echo cancellation) DISABLED — essential
// for a modem. Forwards sample blocks via onChunk. Browser-only.

import { addCaptureWorklet } from "./worklet";

export interface InputDevice {
  deviceId: string;
  label: string;
}

export async function listInputDevices(): Promise<InputDevice[]> {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || `Input ${d.deviceId.slice(0, 6)}` }));
}

export class Capture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  sampleRate = 0;

  async start(deviceId: string | undefined, sampleRate: number, onChunk: (samples: Float32Array) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
    // Pin the context to the modem's rate so the browser resamples the device
    // for us — a 192 kHz line-in otherwise won't match the decoder's fixed
    // symbol length and never locks (and used to crash the tab).
    try { this.ctx = new AudioContext(sampleRate ? { sampleRate } : {}); }
    catch { this.ctx = new AudioContext(); }
    this.sampleRate = this.ctx.sampleRate;
    await addCaptureWorklet(this.ctx);
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture-processor");
    this.node.port.onmessage = (e) => onChunk(e.data as Float32Array);
    source.connect(this.node);
    // node is not connected to destination → no monitor feedback
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
