// Decode an input video FILE into frames at a target fps, using the browser's
// own video pipeline (format-agnostic) + requestVideoFrameCallback. Browser-only.
// Encode is offline, so playing the clip through once to grab frames is fine.

export interface FrameSourceOptions {
  width: number;
  height: number;
  fps: number;
  grayscale?: boolean;
  onProgress?: (fraction: number) => void;
}

/** Returns scaled VideoFrames (caller closes them). Plays the file start→end,
 * sampling at the target fps. */
export async function framesFromFile(file: File, opts: FrameSourceOptions): Promise<VideoFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  (video as any).playsInline = true;
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error("could not load video"));
  });

  const canvas = new OffscreenCanvas(opts.width, opts.height);
  const ctx = canvas.getContext("2d")!;
  const frames: VideoFrame[] = [];
  const dur = video.duration;
  const dt = 1 / opts.fps;

  // Seek-and-grab: deterministic and avoids realtime-playback timing jitter.
  for (let t = 0, i = 0; t < dur; t += dt, i++) {
    await seek(video, t);
    ctx.drawImage(video, 0, 0, opts.width, opts.height);
    // Grayscale by hand, not via ctx.filter — Canvas filter is unsupported on
    // iOS/mobile Safari, where it silently no-ops and colour leaks through.
    if (opts.grayscale) {
      const img = ctx.getImageData(0, 0, opts.width, opts.height);
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) {
        const y = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
        d[p] = d[p + 1] = d[p + 2] = y;
      }
      ctx.putImageData(img, 0, 0);
    }
    frames.push(new VideoFrame(canvas, { timestamp: Math.round(i * dt * 1e6) }));
    opts.onProgress?.(Math.min(1, t / dur));
  }
  URL.revokeObjectURL(url);
  return frames;
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const done = () => { video.removeEventListener("seeked", done); res(); };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}
