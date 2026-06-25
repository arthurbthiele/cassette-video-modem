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
  const frames: VideoFrame[] = [];
  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error("Couldn't read this video — your browser may not support its format. Try an MP4 or WebM (H.264, VP9 or AV1)."));
      setTimeout(() => rej(new Error("Couldn't read this video (timed out loading it). Try an MP4 or WebM (H.264, VP9 or AV1).")), 15000);
    });

    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error("Couldn't read this video's length — the file may be in a format the browser can't fully decode. Try re-saving it as MP4 (H.264) or WebM.");

    const canvas = new OffscreenCanvas(opts.width, opts.height);
    const ctx = canvas.getContext("2d")!;
    const dt = 1 / opts.fps;

    // Seek-and-grab: deterministic, avoids realtime-playback timing jitter. The
    // seek wait is bounded — some files/browsers don't reliably fire 'seeked',
    // which would otherwise hang the encode forever.
    let consecutiveTimeouts = 0;
    for (let t = 0, i = 0; t < dur; t += dt, i++) {
      const ok = await seek(video, t);
      if (ok) consecutiveTimeouts = 0;
      else if (++consecutiveTimeouts >= 4) throw new Error("Couldn't read frames from this video — seeking kept failing. Try re-saving it as MP4 (H.264) or WebM.");
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
    if (!frames.length) throw new Error("No frames could be read from this video.");
    URL.revokeObjectURL(url);
    return frames;
  } catch (e) {
    frames.forEach((f) => f.close()); // don't leak partially-extracted frames on failure
    URL.revokeObjectURL(url);
    throw e;
  }
}

// Resolves true if the 'seeked' event fired, false if it timed out (so the
// caller can grab whatever frame is there and keep going rather than hang).
function seek(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((res) => {
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; video.removeEventListener("seeked", onSeeked); clearTimeout(timer); res(ok); };
    const onSeeked = () => finish(true);
    video.addEventListener("seeked", onSeeked);
    const timer = setTimeout(() => finish(false), 2500);
    video.currentTime = t;
  });
}
