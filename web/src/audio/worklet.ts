// Shared AudioWorklet that forwards each input block to the main thread.
// Loaded from a Blob URL to avoid bundler-specific worklet handling.

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

export async function addCaptureWorklet(ctx: AudioContext): Promise<void> {
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
