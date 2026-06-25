// Container records → WebCodecs VideoDecoder → frames. Browser-only.
// Waits for a config and the first key frame before decoding, so it can start
// mid-stream (joins at the next GOP).

import { VideoRecord } from "./container";

export class StreamVideoDecoder {
  private dec: VideoDecoder | null = null;
  private configured = false;
  private sawKey = false;

  constructor(private onFrame: (f: VideoFrame) => void, private onError?: (e: DOMException) => void) {}

  pushRecords(records: VideoRecord[]): void {
    for (const r of records) {
      if (r.kind === "config") {
        if (!this.configured) {
          this.dec = new VideoDecoder({ output: this.onFrame, error: (e) => this.onError?.(e) });
          const cfg: VideoDecoderConfig = { codec: r.codec };
          if (r.description) cfg.description = r.description;
          this.dec.configure(cfg);
          this.configured = true;
        }
      } else {
        if (!this.configured) continue; // no config yet
        if (!this.sawKey) {
          if (!r.key) continue; // wait for a key frame to start
          this.sawKey = true;
        }
        this.dec!.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: r.timestamp, data: r.data }));
      }
    }
  }

  async flush(): Promise<void> {
    if (this.dec) await this.dec.flush();
  }
  close(): void {
    if (this.dec && this.dec.state !== "closed") this.dec.close();
  }
}
