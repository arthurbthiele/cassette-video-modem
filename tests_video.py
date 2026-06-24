#!/usr/bin/env python3
"""
End-to-end VIDEO round-trip test (needs ffmpeg + the GUI deps installed).

Exercises the real pipeline the synthetic byte tests can't reach:
  ffmpeg re-encode -> modulate -> WAV -> streaming demod -> reassemble
  -> VideoReconstructor (ffmpeg decode) -> RGB frames

Generates a short synthetic clip with ffmpeg, so it needs no input file.
Run:  python tests_video.py
"""
import os, subprocess, tempfile, wave, queue, time, sys
import numpy as np

from cassette_encoder import ffmpeg_encode_video, encode_to_wav, DEFAULT_VIDEO
from cassette_decoder import VideoReconstructor
from cassette_modem import (ModemSettings, DecoderState, METADATA_SEQ,
                            decode_metadata_payload, ffmpeg_available)


def main():
    if not ffmpeg_available():
        print("ffmpeg not on PATH — skipping video test."); return 1
    tmp = tempfile.mkdtemp(prefix="cassette_vid_")
    vid = os.path.join(tmp, "src.mp4")
    wav = os.path.join(tmp, "cassette.wav")
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi",
                    "-i", "testsrc=size=256x144:rate=15:duration=3",
                    "-pix_fmt", "yuv420p", vid], check=True, capture_output=True)

    all_ok = True
    for method in ["ofdm", "dpsk", "fsk4", "fsk"]:
        ms   = ModemSettings(method=method, reed_solomon=True)
        vset = dict(DEFAULT_VIDEO)
        vbytes = ffmpeg_encode_video(vid, vset)
        encode_to_wav(vbytes, wav, ms, vset=vset)

        with wave.open(wav) as wf:
            ms.sample_rate = wf.getframerate()
            audio = np.frombuffer(wf.readframes(wf.getnframes()),
                                  np.int16).astype(np.float32) / 32768.0
        ds = DecoderState(ms)
        data, meta = {}, None
        for i in range(0, len(audio), 4096):
            for seq, pl in ds.feed_audio(audio[i:i + 4096]):
                if seq == METADATA_SEQ:
                    meta = decode_metadata_payload(pl)
                else:
                    data[seq] = pl
        recon = bytearray()
        for i in range(max(data) + 1 if data else 0):
            recon += data.get(i, b"\x00" * ms.block_data_size)
        recon = bytes(recon)[:len(vbytes)]

        # Reconstruct frames through the real VideoReconstructor.
        w = meta["video"]["width"] if meta else 256
        h = meta["video"]["height"] if meta else 144
        vr = VideoReconstructor(dict(width=w, height=h))
        vr.start()
        frames = []
        for seq in sorted(data):
            vr.feed_block(seq, data[seq])
            try:
                while True:
                    frames.append(vr.frame_queue.get_nowait())
            except queue.Empty:
                pass
        vr.stop()
        time.sleep(0.3)
        try:
            while True:
                frames.append(vr.frame_queue.get_nowait())
        except queue.Empty:
            pass

        ok = (recon == vbytes) and meta is not None and len(frames) > 0
        all_ok &= ok
        print(f"{method:5s}: bytes={'OK' if recon==vbytes else 'FAIL'} "
              f"({len(recon)}/{len(vbytes)})  meta={w}x{h}  frames={len(frames)}  "
              f"{'PASS' if ok else 'FAIL'}")
    print("ALL VIDEO TESTS PASS" if all_ok else "SOME VIDEO TESTS FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
