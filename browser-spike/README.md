# Browser feasibility spike

Throwaway page to test whether a browser/TypeScript rewrite can do the hard
parts in real time. Serve it (`python -m http.server`) and open in Chrome; it
runs automatically and prints JSON results.

## Findings (run in a software-codec Chromium — a conservative floor)

| Test | Result |
|---|---|
| Real-time video **decode** (256×144@15fps, WebCodecs) | H.264 ~1750×, AV1 ~704×, VP9 ~775× realtime |
| Codec decode support | H.264, HEVC, AV1, VP9 all supported |
| Low-bitrate **encode** (12 kbps target) | AV1 hit ~14 kbps, VP9 ~22, H.264 ~32 |
| OFDM-style **DSP demod** in plain JS (10 s audio) | ~950× realtime |
| Clean line-in **capture** (AGC/NS/EC off) | untested — needs a real device + mic permission |

**Conclusion:** real-time video (WebCodecs) and DSP (plain JS) both have ~1000×
headroom — no WebAssembly needed. The browser rewrite is de-risked. The only
open empirical question is whether the OS/browser honour `autoGainControl:false`
etc. on a real line-in capture.
