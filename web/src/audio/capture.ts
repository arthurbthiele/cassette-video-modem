// Live audio capture from a line-in / input device, with the browser's own
// processing (AGC, noise suppression, echo cancellation) DISABLED — essential
// for a modem. Forwards sample blocks via onChunk. Browser-only.

// Worklet runs in the audio render thread; loaded from a Blob URL to avoid
// bundler-specific AudioWorklet handling. It just forwards each input block.
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

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

  async start(deviceId: string | undefined, onChunk: (samples: Float32Array) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
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
