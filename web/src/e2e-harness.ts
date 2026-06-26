// Automated end-to-end validation, run in a real browser via Playwright.
// For every device profile: synthetic frames → WebCodecs encode → container →
// modem → WAV → modem decode → container → WebCodecs decode → frames. Asserts
// the video round-trips, exercising the exact code paths the UI uses.

import { DEFAULT_SETTINGS, METADATA_SEQ, ModemSettings } from "./dsp/settings";
import { encodeStream } from "./dsp/modem";
import { DecoderState } from "./dsp/decoderState";
import { netBitsPerSec, videoBitrateBudget } from "./video/budget";
import { encodeToFitChannel } from "./video/encoder";
import { StreamVideoDecoder } from "./video/decoder";
import { ContainerParser } from "./video/container";
import { encodeWav, decodeWav } from "./audio/wav";
import { simulateChannel, ChannelOptions } from "./dsp/channel";
import { pilotResample } from "./dsp/pilot";
import { PROFILES, applyProfile } from "./profiles";
import { modulateOfdm as ofdmMod, demodulateOfdm as ofdmDemod, OfdmStreamDemod } from "./dsp/ofdm";

const out = document.getElementById("out")!;
const CODEC = "av01.0.01M.08";
const SECONDS = 2;

function makeFrames(w: number, h: number, fps: number, n: number): { frames: VideoFrame[]; orig: Uint8ClampedArray[] } {
  const cvs = new OffscreenCanvas(w, h);
  const ctx = cvs.getContext("2d")!;
  const frames: VideoFrame[] = [];
  const orig: Uint8ClampedArray[] = [];
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = `hsl(${(i * 18) % 360} 70% 45%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(10, h / 5)}px sans-serif`;
    ctx.fillText("F" + i, 4, h / 2);
    orig.push(ctx.getImageData(0, 0, w, h).data.slice());
    frames.push(new VideoFrame(cvs, { timestamp: Math.round((i * 1e6) / fps) }));
  }
  return { frames, orig };
}

async function runProfile(name: string, settings: Partial<ModemSettings>, video: { width: number; height: number; fps: number }) {
  const s: ModemSettings = applyProfile({ ...DEFAULT_SETTINGS }, { name, description: "", settings, video });
  const n = video.fps * SECONDS;
  const { frames } = makeFrames(video.width, video.height, video.fps, n);
  const fit = await encodeToFitChannel(frames, { codec: CODEC, width: video.width, height: video.height, framerate: video.fps, gopSeconds: 1 }, videoBitrateBudget(s, { fillFactor: 0.9 }), netBitsPerSec(s));
  frames.forEach((f) => f.close());

  const audio = Float32Array.from(encodeStream(fit.container, s));
  const wav = encodeWav(audio, s.sampleRate);
  const clean = decodeWav(await wav.arrayBuffer()).samples;

  // channel conditions to probe
  const conditions: Record<string, ChannelOptions | null> = {
    clean: null,
    goodDeck: { sampleRate: s.sampleRate, bandLowHz: 200, bandHighHz: 7500, snrDb: 40, dropoutPerSec: 0.1 },
    cheapAGC: { sampleRate: s.sampleRate, bandLowHz: 300, bandHighHz: 6500, snrDb: 26, dropoutPerSec: 0.3, agc: true },
    wow: { sampleRate: s.sampleRate, bandLowHz: 200, bandHighHz: 7500, snrDb: 40, wowDepth: 0.0008, flutterDepth: 0.0004 },
  };
  const cond: Record<string, string> = {};
  for (const [name, ch] of Object.entries(conditions)) {
    const samples = ch ? simulateChannel(clean, ch) : clean;
    const ds = new DecoderState(s);
    const parser = new ContainerParser();
    let blocks = 0, framesDecoded = 0;
    const vdec = new StreamVideoDecoder(() => framesDecoded++, () => {});
    for (let i = 0; i < samples.length; i += 4096)
      for (const b of ds.feedAudio(samples.subarray(i, i + 4096)))
        if (b.seq !== METADATA_SEQ) { blocks++; vdec.pushRecords(parser.push(b.payload)); }
    await vdec.flush();
    vdec.close();
    cond[name] = `${framesDecoded}/${n}f ${blocks}b`;
  }

  return {
    pass: cond.clean.startsWith(`${n}/`),
    res: `${video.width}x${video.height}@${video.fps}`, method: s.method, cp: s.constantPower,
    fits: fit.fits, kbps: +(fit.containerBitsPerSec / 1000).toFixed(1),
    cond,
  };
}

// Validate the pilot tachometer at the data level (the case Python proved):
// FSK + pilot through pure wow/flutter — does the tacho recover the blocks?
function tachoDataTest(method: "fsk" | "dpsk", pilotHz: number) {
  const s = { ...DEFAULT_SETTINGS, method, reedSolomon: true, rsNsym: 16, pilotTone: true, pilotHz, pilotAmp: 0.18 };
  const data = new Uint8Array(2000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  const audio = Float32Array.from(encodeStream(data, s));
  const wow = simulateChannel(audio, { sampleRate: s.sampleRate, wowDepth: 0.003, flutterDepth: 0.0015 });
  const blocksOf = (smp: Float32Array) => {
    const ds = new DecoderState(s);
    let bl = 0;
    for (let i = 0; i < smp.length; i += 4096) for (const b of ds.feedAudio(smp.subarray(i, i + 4096))) if (b.seq !== METADATA_SEQ) bl++;
    return bl;
  };
  const expected = Math.ceil(data.length / s.blockDataSize);
  return { expected, noTacho: blocksOf(wow), withTacho: blocksOf(pilotResample(wow, s.sampleRate, s.pilotHz)) };
}

// Isolate the tracker from the preamble/lock: feed pure OFDM (starts on a symbol
// boundary) and compare its bits to the known-good one-shot demodulator.
function ofdmTrackerUnitTest() {
  const p = { sampleRate: 44100, fftSize: 512, cpSize: 64, fMin: 500, fMax: 6000, pilotInterval: 8, phases: 4 };
  const data = new Uint8Array(1000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  const audio = ofdmMod(data, p);
  const refBits = ofdmDemod(audio, p);
  const dm = new OfdmStreamDemod(p);
  const trk: number[] = [];
  for (let i = 0; i < audio.length; i += 4096) for (const b of dm.push(Float64Array.from(audio.subarray(i, i + 4096)))) trk.push(b);
  const n = Math.min(refBits.length, trk.length);
  let match = 0;
  for (let i = 0; i < n; i++) if (refBits[i] === trk[i]) match++;
  return { locked: (dm as any).locked, pos: (dm as any).pos, refBits: refBits.length, trkBits: trk.length, matchPct: n ? +(100 * match / n).toFixed(1) : 0 };
}

// OFDM through escalating wow/flutter — the per-symbol-timing frontier. No pilot;
// this isolates whether the decoder's symbol timing survives a wobbling tape.
function ofdmWowSweep(depths: number[]) {
  const s = { ...DEFAULT_SETTINGS, method: "ofdm" as const, reedSolomon: true, rsNsym: 16 };
  const data = new Uint8Array(4000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  const audio = Float32Array.from(encodeStream(data, s));
  const expected = Math.ceil(data.length / s.blockDataSize);
  const blocksOf = (smp: Float32Array) => {
    const ds = new DecoderState(s);
    let bl = 0;
    for (let i = 0; i < smp.length; i += 4096) for (const b of ds.feedAudio(smp.subarray(i, i + 4096))) if (b.seq !== METADATA_SEQ) bl++;
    return bl;
  };
  const res: Record<string, string> = { expected: String(expected), clean: `${blocksOf(audio)}/${expected}` };
  for (const d of depths) {
    const wow = simulateChannel(audio, { sampleRate: s.sampleRate, wowDepth: d, flutterDepth: d / 2, snrDb: 45 });
    res[`wow ${d}`] = `${blocksOf(wow)}/${expected}`;
  }
  return res;
}

// Does DPSK need the constant-power carrier on an AGC channel? DPSK is
// constant-envelope, so the hypothesis is it survives AGC without the tone.
function agcCarrierTest() {
  const base = { ...DEFAULT_SETTINGS, method: "dpsk" as const, dpskBaud: 1800, dpskCarrier: 2600, dpskPhases: 8, reedSolomon: true, rsNsym: 16 };
  const data = new Uint8Array(2000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  const expected = Math.ceil(data.length / base.blockDataSize);
  const blocksOf = (s: typeof base, ch: ChannelOptions | null) => {
    const audio = Float32Array.from(encodeStream(data, s));
    const smp = ch ? simulateChannel(audio, ch) : audio;
    const ds = new DecoderState(s);
    let bl = 0;
    for (let i = 0; i < smp.length; i += 4096) for (const b of ds.feedAudio(smp.subarray(i, i + 4096))) if (b.seq !== METADATA_SEQ) bl++;
    return bl;
  };
  const sr = base.sampleRate;
  const agc: ChannelOptions = { sampleRate: sr, bandLowHz: 300, bandHighHz: 6500, snrDb: 26, dropoutPerSec: 0.3, agc: true };
  // 2×2: phases {4,8} × carrier {on,off}, all through the full cheap-AGC channel
  const cell = (phases: number, cp: boolean) => `${blocksOf({ ...base, dpskPhases: phases, constantPower: cp }, agc)}/${expected}`;
  return {
    expected,
    "8phase_carrierON": cell(8, true),
    "8phase_carrierOFF": cell(8, false),
    "4phase_carrierON": cell(4, true),
    "4phase_carrierOFF": cell(4, false),
  };
}

(async () => {
  const results: Record<string, any> = {};
  try { results["_agc carrier (dpsk)"] = agcCarrierTest(); } catch (e) { results["_agc carrier (dpsk)"] = { error: String(e) }; }
  try { results["_ofdm tracker unit"] = ofdmTrackerUnitTest(); } catch (e) { results["_ofdm tracker unit"] = { error: String(e) }; }
  try { results["_ofdm wow sweep"] = ofdmWowSweep([0.0005, 0.001, 0.002, 0.003, 0.005]); } catch (e) { results["_ofdm wow sweep"] = { error: String(e) }; }
  for (const p of PROFILES) {
    out.textContent = `running ${p.name}…`;
    try { results[p.name] = await runProfile(p.name, p.settings, p.video); }
    catch (e) { results[p.name] = { pass: false, error: String(e) }; }
  }
  out.textContent = "tachometer test…";
  try { results["_tacho FSK (data, wow)"] = tachoDataTest("fsk", 700); } catch (e) { results["_tacho FSK"] = { error: String(e) }; }
  try { results["_tacho DPSK (data, wow)"] = tachoDataTest("dpsk", 700); } catch (e) { results["_tacho DPSK"] = { error: String(e) }; }
  const allPass = Object.values(results).every((r: any) => r.pass);
  out.textContent = (allPass ? "ALL PROFILES PASS\n\n" : "SOME PROFILES FAILED\n\n") + JSON.stringify(results, null, 2);
  (window as any).__e2e = { allPass, results };
})();
