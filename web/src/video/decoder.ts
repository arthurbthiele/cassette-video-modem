// Container records → WebCodecs VideoDecoder → frames. Browser-only.
// Waits for a config and the first key frame before decoding, so it can start
// mid-stream (joins at the next GOP).

import { VideoRecord } from "./container";

export class StreamVideoDecoder {
  private dec: VideoDecoder | null = null;
  private configured = false;
  private sawKey = false;
  private closed = false;

  constructor(private onFrame: (f: VideoFrame) => void, private onError?: (e: DOMException) => void) {}

  pushRecords(records: VideoRecord[]): void {
    if (this.closed) return;
    for (const r of records) {
      if (r.kind === "config") {
        if (!this.configured) {
          this.dec = new VideoDecoder({ output: (f) => (this.closed ? f.close() : this.onFrame(f)), error: (e) => this.onError?.(e) });
          const cfg: VideoDecoderConfig = { codec: r.codec };
          if (r.description) cfg.description = r.description;
          this.dec.configure(cfg);
          this.configured = true;
        }
      } else {
        if (!this.configured || !this.dec || this.dec.state === "closed") continue;
        if (!this.sawKey) {
          if (!r.key) continue; // wait for a key frame to start
          this.sawKey = true;
        }
        try {
          this.dec.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: r.timestamp, data: r.data }));
        } catch (e) {
          this.onError?.(e as DOMException); // e.g. a delta after a reset before its key frame
        }
      }
    }
  }

  async flush(): Promise<void> {
    if (this.dec && this.dec.state === "configured") {
      try { await this.dec.flush(); } catch { /* closed mid-flush */ }
    }
  }
  close(): void {
    this.closed = true;
    if (this.dec && this.dec.state !== "closed") this.dec.close();
  }
}
