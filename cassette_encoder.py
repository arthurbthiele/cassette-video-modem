#!/usr/bin/env python3
"""
cassette_encoder.py — GUI encoder: video → modulated audio WAV for cassette tape.

Encodes video with ffmpeg, wraps output in modem frames, modulates to audio.
Saves as WAV file ready to play through a cassette deck's line-in.
"""
from __future__ import annotations
import json, os, subprocess, threading, time, wave
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Optional

import numpy as np

# Must be in the same directory
from cassette_modem import (
    ModemSettings, modulate, frame_block, generate_preamble,
    add_constant_power_carrier, block_wire_size, calculate_bitrate, HAS_RS,
    encode_metadata_block, TRAIN_BYTES,
)


# ═══════════════════════════════════════════════════════════════════════════════
# VIDEO SETTINGS
# ═══════════════════════════════════════════════════════════════════════════════

DEFAULT_VIDEO = dict(
    codec      = 'libx265',
    width      = 256,
    height     = 144,
    fps        = 15,
    crf        = 40,
    gop_secs   = 10,
    grayscale  = True,
    b_frames   = False,   # False = realtime-safe P-frames only
)


# ═══════════════════════════════════════════════════════════════════════════════
# ENCODING PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════

def ffmpeg_encode_video(input_path: str, vset: dict,
                        progress_cb=None) -> bytes:
    """Re-encode video with ffmpeg, return encoded bytes."""
    filters = [f"scale={vset['width']}:{vset['height']}"]
    if vset['grayscale']:
        filters.append('format=gray')
    vf = ','.join(filters)

    cmd = ['ffmpeg', '-y', '-i', input_path,
           '-vf', vf,
           '-r', str(vset['fps'])]

    codec = vset['codec']
    crf   = str(vset['crf'])
    gop   = str(int(vset['fps'] * vset['gop_secs']))

    if codec == 'libx264':
        cmd += ['-vcodec', 'libx264', '-crf', crf, '-preset', 'medium',
                '-g', gop, '-pix_fmt', 'yuv420p' if not vset['grayscale'] else 'gray']
    elif codec == 'libx265':
        cmd += ['-vcodec', 'libx265', '-crf', crf, '-preset', 'medium',
                '-g', gop, '-x265-params', 'log-level=error',
                '-pix_fmt', 'yuv420p' if not vset['grayscale'] else 'gray']
    elif codec == 'libaom-av1':
        cmd += ['-vcodec', 'libaom-av1', '-crf', crf, '-b:v', '0',
                '-cpu-used', '4', '-g', gop,
                '-pix_fmt', 'yuv420p' if not vset['grayscale'] else 'gray']
    else:
        raise ValueError(f'Unknown codec: {codec}')

    if not vset.get('b_frames', True):
        cmd += ['-bf', '0']   # no B-frames → pure P-frame stream, lower latency

    cmd += ['-an', '-f', 'mpegts', 'pipe:1']

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f'ffmpeg failed:\n{stderr.decode(errors="replace")}')
    return stdout


def encode_to_wav(video_bytes: bytes, output_path: str,
                  ms: ModemSettings, vset: Optional[dict] = None,
                  progress_cb=None):
    """Modulate video bytes and write a 16-bit mono WAV file.

    The whole frame stream is modulated in a SINGLE call so the differential
    phase chain (DPSK/OFDM) is never broken at a block boundary. Layout:
        [tone lead-in] [TRAIN_BYTES] [metadata block] [data block 0..n] [silence]
    where everything after the tone is one continuous modulation.
    """
    sr         = ms.sample_rate
    block_size = ms.block_data_size
    n_blocks   = -(-len(video_bytes) // block_size)   # ceiling

    # Build the full byte stream: training lead, metadata, then framed payload.
    stream = bytearray(TRAIN_BYTES)
    if vset is not None:
        stream += encode_metadata_block(vset, ms)
    for i in range(n_blocks):
        # Pad every block to a uniform payload size so the decoder can read a
        # fixed wire size; the final short block is zero-filled.
        chunk   = video_bytes[i * block_size: (i + 1) * block_size]
        chunk   = chunk.ljust(block_size, b"\x00")
        stream += frame_block(chunk, i, ms)
        if progress_cb and i % 25 == 0:
            progress_cb(0.5 * i / max(1, n_blocks))   # framing is first half

    if progress_cb:
        progress_cb(0.5)
    data_audio = modulate(bytes(stream), ms)
    if progress_cb:
        progress_cb(0.95)

    # Pure-tone lead-in pins the AGC before any data; silence tail lets it settle.
    tone = generate_preamble(ms)
    audio = np.concatenate([tone, data_audio, np.zeros(int(sr * 0.5))])

    if ms.constant_power:
        audio = add_constant_power_carrier(audio, ms)

    # Normalise and write WAV
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.95
    pcm = (audio * 32767).astype(np.int16)

    with wave.open(output_path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())

    if progress_cb:
        progress_cb(1.0)


# ═══════════════════════════════════════════════════════════════════════════════
# LABELLED FRAME HELPER
# ═══════════════════════════════════════════════════════════════════════════════

def _lf(parent, label: str, pad=6) -> ttk.LabelFrame:
    f = ttk.LabelFrame(parent, text=label, padding=pad)
    return f


def _row(parent, label: str, row: int, widget_factory, col_span=1):
    ttk.Label(parent, text=label).grid(row=row, column=0, sticky='w', padx=4, pady=2)
    w = widget_factory(parent)
    w.grid(row=row, column=1, columnspan=col_span, sticky='ew', padx=4, pady=2)
    return w


# ═══════════════════════════════════════════════════════════════════════════════
# SLIDER + ENTRY PAIR
# ═══════════════════════════════════════════════════════════════════════════════

class SliderEntry(tk.Frame):
    """A horizontal Scale linked to an Entry box, with optional suffix label."""

    def __init__(self, parent, from_: float, to: float, default: float,
                 resolution: float = 1, suffix: str = '', command=None, **kw):
        super().__init__(parent, **kw)
        self._cmd = command
        self.var  = tk.DoubleVar(value=default)
        self._res = resolution

        self.scale = ttk.Scale(self, from_=from_, to=to, orient='horizontal',
                               variable=self.var, command=self._on_scale)
        self.scale.pack(side='left', fill='x', expand=True)

        self.entry = ttk.Entry(self, textvariable=self.var, width=7)
        self.entry.pack(side='left', padx=(2, 0))
        self.entry.bind('<Return>',    self._on_entry)
        self.entry.bind('<FocusOut>',  self._on_entry)

        if suffix:
            ttk.Label(self, text=suffix).pack(side='left')

        self.var.trace_add('write', self._trace)

    def _on_scale(self, _=None):
        v = round(self.var.get() / self._res) * self._res
        self.var.set(v)
        if self._cmd:
            self._cmd()

    def _on_entry(self, _=None):
        try:
            self.var.set(float(self.entry.get()))
        except ValueError:
            pass
        if self._cmd:
            self._cmd()

    def _trace(self, *_):
        pass

    def get(self) -> float:
        return self.var.get()

    def set(self, v: float):
        self.var.set(v)


# ═══════════════════════════════════════════════════════════════════════════════
# BITRATE DISPLAY WIDGET
# ═══════════════════════════════════════════════════════════════════════════════

class BitrateDisplay(tk.Frame):
    BAR_W = 280
    BAR_H = 22

    def __init__(self, parent, **kw):
        super().__init__(parent, **kw)
        self._info_var = tk.StringVar(value='—')
        ttk.Label(self, textvariable=self._info_var).pack(anchor='w')
        self.canvas = tk.Canvas(self, width=self.BAR_W, height=self.BAR_H,
                                bg='#1e1e1e', highlightthickness=1,
                                highlightbackground='#555')
        self.canvas.pack(anchor='w', pady=2)
        self._bar  = self.canvas.create_rectangle(0, 0, 0, self.BAR_H, fill='#00c87a', outline='')
        self._text = self.canvas.create_text(self.BAR_W // 2, self.BAR_H // 2,
                                             text='', fill='white', font=('Consolas', 9))

    def update(self, br: dict, video_bps: int = 0):
        raw = br['raw_bps']
        net = br['net_bps']
        eff = br['efficiency_pct']
        kBs = br['net_kBps']
        self._info_var.set(
            f"Raw {raw:,} bps  │  Net {net:,} bps  │  "
            f"Framing eff. {eff}%  │  Video budget {video_bps:,} bps"
        )
        fill = min(1.0, net / 20_000)
        color = '#00c87a' if fill < 0.7 else ('#f5a623' if fill < 0.9 else '#e74c3c')
        self.canvas.itemconfig(self._bar, fill=color)
        self.canvas.coords(self._bar, 0, 0, int(self.BAR_W * fill), self.BAR_H)
        self.canvas.itemconfig(self._text, text=f'{kBs:.3f} KB/s  (1024-KB)')


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN GUI
# ═══════════════════════════════════════════════════════════════════════════════

class EncoderGUI:
    CODECS = ['libx264', 'libx265', 'libaom-av1']
    RATES  = [44100, 48000]
    METHODS = ['ofdm', 'dpsk', 'fsk4', 'fsk']

    def __init__(self, root: tk.Tk):
        self.root = root
        root.title('Cassette Tape Encoder')
        root.resizable(False, False)

        self._encode_thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()
        self._ms = ModemSettings()

        nb = ttk.Notebook(root)
        nb.pack(fill='both', expand=True, padx=8, pady=8)

        tab_io    = ttk.Frame(nb, padding=6)
        tab_modem = ttk.Frame(nb, padding=6)
        tab_video = ttk.Frame(nb, padding=6)

        nb.add(tab_io,    text='  Files  ')
        nb.add(tab_modem, text='  Modem  ')
        nb.add(tab_video, text='  Video  ')

        self._build_io(tab_io)
        self._build_modem(tab_modem)
        self._build_video(tab_video)
        self._build_bottom(root)

        self._update_bitrate()

    # ── Files tab ────────────────────────────────────────────────────────────

    def _build_io(self, f):
        f.columnconfigure(1, weight=1)

        ttk.Label(f, text='Input video:').grid(row=0, column=0, sticky='w', pady=4)
        self._in_var = tk.StringVar()
        ttk.Entry(f, textvariable=self._in_var, width=48).grid(
            row=0, column=1, sticky='ew', padx=4)
        ttk.Button(f, text='Browse…', command=self._browse_in).grid(
            row=0, column=2, padx=2)

        ttk.Label(f, text='Output WAV:').grid(row=1, column=0, sticky='w', pady=4)
        self._out_var = tk.StringVar()
        ttk.Entry(f, textvariable=self._out_var, width=48).grid(
            row=1, column=1, sticky='ew', padx=4)
        ttk.Button(f, text='Browse…', command=self._browse_out).grid(
            row=1, column=2, padx=2)

        bf = ttk.Frame(f)
        bf.grid(row=2, column=0, columnspan=3, pady=8)
        ttk.Button(bf, text='Save settings', command=self._save_settings).pack(side='left', padx=4)
        ttk.Button(bf, text='Load settings', command=self._load_settings).pack(side='left', padx=4)

    def _browse_in(self):
        p = filedialog.askopenfilename(
            filetypes=[('Video files', '*.mp4 *.mkv *.avi *.mov *.webm'), ('All', '*.*')])
        if p:
            self._in_var.set(p)
            if not self._out_var.get():
                self._out_var.set(os.path.splitext(p)[0] + '_cassette.wav')

    def _browse_out(self):
        p = filedialog.asksaveasfilename(defaultextension='.wav',
                                         filetypes=[('WAV', '*.wav')])
        if p:
            self._out_var.set(p)

    # ── Modem tab ─────────────────────────────────────────────────────────────

    def _build_modem(self, f):
        f.columnconfigure(0, weight=1)
        row = 0

        # Method selector
        mf = _lf(f, 'Modulation method')
        mf.grid(row=row, column=0, sticky='ew', pady=4); row += 1
        self._method_var = tk.StringVar(value='ofdm')
        for m in self.METHODS:
            ttk.Radiobutton(mf, text=m.upper(), variable=self._method_var,
                            value=m, command=self._method_changed).pack(side='left', padx=8)

        # FSK
        self._fsk_frame = _lf(f, 'FSK settings')
        self._fsk_frame.grid(row=row, column=0, sticky='ew', pady=2); row += 1
        self._fsk_frame.columnconfigure(1, weight=1)
        self._fsk_baud = self._slider_row(self._fsk_frame, 'Baud rate', 0, 1000, 10000, 6000, 100, 'baud')
        self._fsk_f0   = self._slider_row(self._fsk_frame, 'Freq 0 (Hz)', 1,  300,  4000, 1200, 100, 'Hz')
        self._fsk_f1   = self._slider_row(self._fsk_frame, 'Freq 1 (Hz)', 2,  600,  6000, 2400, 100, 'Hz')

        # 4-FSK
        self._fsk4_frame = _lf(f, '4-FSK settings')
        self._fsk4_frame.grid(row=row, column=0, sticky='ew', pady=2); row += 1
        self._fsk4_frame.columnconfigure(1, weight=1)
        self._fsk4_baud = self._slider_row(self._fsk4_frame, 'Baud rate', 0, 500, 6000, 3500, 100, 'baud')
        self._fsk4_f0   = self._slider_row(self._fsk4_frame, 'Freq 0',    1, 300, 3000, 1000, 100, 'Hz')
        self._fsk4_f1   = self._slider_row(self._fsk4_frame, 'Freq 1',    2, 600, 4000, 2000, 100, 'Hz')
        self._fsk4_f2   = self._slider_row(self._fsk4_frame, 'Freq 2',    3, 900, 5000, 3000, 100, 'Hz')
        self._fsk4_f3   = self._slider_row(self._fsk4_frame, 'Freq 3',    4,1200, 6000, 4000, 100, 'Hz')

        # DPSK
        self._dpsk_frame = _lf(f, 'DPSK settings')
        self._dpsk_frame.grid(row=row, column=0, sticky='ew', pady=2); row += 1
        self._dpsk_frame.columnconfigure(1, weight=1)
        self._dpsk_baud    = self._slider_row(self._dpsk_frame, 'Baud rate',    0, 500, 6000, 3500, 100, 'baud')
        self._dpsk_carrier = self._slider_row(self._dpsk_frame, 'Carrier (Hz)', 1, 600, 5500, 3000, 100, 'Hz')
        ttk.Label(self._dpsk_frame, text='Phases').grid(row=2, column=0, sticky='w', padx=4)
        self._dpsk_phases = tk.IntVar(value=4)
        pf = ttk.Frame(self._dpsk_frame)
        pf.grid(row=2, column=1, sticky='w')
        for v, lbl in [(2,'2-DPSK (1 bit)'),(4,'4-DPSK (2 bit)'),(8,'8-DPSK (3 bit)')]:
            ttk.Radiobutton(pf, text=lbl, variable=self._dpsk_phases,
                            value=v, command=self._update_bitrate).pack(side='left', padx=6)

        # OFDM
        self._ofdm_frame = _lf(f, 'OFDM settings')
        self._ofdm_frame.grid(row=row, column=0, sticky='ew', pady=2); row += 1
        self._ofdm_frame.columnconfigure(1, weight=1)
        self._ofdm_fft  = self._slider_row(self._ofdm_frame, 'FFT size',        0, 128, 2048, 512,  128, 'samples')
        self._ofdm_cp   = self._slider_row(self._ofdm_frame, 'Cyclic prefix',   1,  16,  512,  64,   16, 'samples')
        self._ofdm_fmin = self._slider_row(self._ofdm_frame, 'Min freq (Hz)',   2, 200, 2000, 500,   50, 'Hz')
        self._ofdm_fmax = self._slider_row(self._ofdm_frame, 'Max freq (Hz)',   3,2000, 8000,6000,  100, 'Hz')
        self._ofdm_pilot= self._slider_row(self._ofdm_frame, 'Pilot interval',  4,   2,   20,   8,    1, 'carriers')
        ttk.Label(self._ofdm_frame, text='Phases/carrier').grid(row=5, column=0, sticky='w', padx=4)
        self._ofdm_phases = tk.IntVar(value=4)
        of = ttk.Frame(self._ofdm_frame)
        of.grid(row=5, column=1, sticky='w')
        for v, lbl in [(2,'2-DPSK'),(4,'4-DPSK'),(8,'8-DPSK')]:
            ttk.Radiobutton(of, text=lbl, variable=self._ofdm_phases,
                            value=v, command=self._update_bitrate).pack(side='left', padx=6)

        # AGC / pre-emphasis / RS / framing
        af = _lf(f, 'Signal conditioning & framing')
        af.grid(row=row, column=0, sticky='ew', pady=4); row += 1
        af.columnconfigure(1, weight=1)
        self._cp_var    = tk.BooleanVar(value=True)
        self._pe_var    = tk.BooleanVar(value=True)
        self._rs_var    = tk.BooleanVar(value=True)
        ttk.Checkbutton(af, text='Constant-power carrier (AGC management)',
                        variable=self._cp_var, command=self._update_bitrate).grid(
            row=0, column=0, columnspan=2, sticky='w', pady=2)
        self._cp_hz   = self._slider_row(af, '  Carrier freq (Hz)', 1,  50, 800, 300, 10, 'Hz')
        ttk.Checkbutton(af, text='Pre-emphasis / de-emphasis',
                        variable=self._pe_var, command=self._update_bitrate).grid(
            row=2, column=0, columnspan=2, sticky='w', pady=2)
        self._pe_alpha = self._slider_row(af, '  Alpha', 3, 0.50, 0.99, 0.85, 0.01, '')
        ttk.Checkbutton(af, text='Reed-Solomon error correction' +
                        ('' if HAS_RS else '  [reedsolo not installed]'),
                        variable=self._rs_var, command=self._update_bitrate,
                        state='normal' if HAS_RS else 'disabled').grid(
            row=4, column=0, columnspan=2, sticky='w', pady=2)
        self._rs_nsym  = self._slider_row(af, '  Parity symbols', 5, 4, 64, 16, 2, 'bytes')
        self._blk_size = self._slider_row(af, 'Block payload size', 6, 32, 1024, 256, 32, 'bytes')
        self._preamble = self._slider_row(af, 'Preamble duration', 7, 50, 1000, 250, 50, 'ms')

        # Sample rate
        ttk.Label(af, text='Sample rate').grid(row=8, column=0, sticky='w', padx=4)
        self._sr_var = tk.IntVar(value=44100)
        srb = ttk.Frame(af)
        srb.grid(row=8, column=1, sticky='w')
        for sr in self.RATES:
            ttk.Radiobutton(srb, text=str(sr), variable=self._sr_var,
                            value=sr, command=self._update_bitrate).pack(side='left', padx=6)

        self._method_changed()

    def _slider_row(self, parent, label, row, lo, hi, default, res, suffix) -> SliderEntry:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky='w', padx=4, pady=1)
        w = SliderEntry(parent, from_=lo, to=hi, default=default,
                        resolution=res, suffix=suffix, command=self._update_bitrate)
        w.grid(row=row, column=1, sticky='ew', padx=4, pady=1)
        return w

    def _method_changed(self, *_):
        m = self._method_var.get()
        for frame, methods in [
            (self._fsk_frame,  {'fsk'}),
            (self._fsk4_frame, {'fsk4'}),
            (self._dpsk_frame, {'dpsk'}),
            (self._ofdm_frame, {'ofdm'}),
        ]:
            state = 'normal' if m in methods else 'disabled'
            for child in frame.winfo_children():
                try:
                    child.configure(state=state)
                except Exception:
                    pass
        self._update_bitrate()

    # ── Video tab ─────────────────────────────────────────────────────────────

    def _build_video(self, f):
        f.columnconfigure(1, weight=1)

        ttk.Label(f, text='Codec').grid(row=0, column=0, sticky='w', padx=4, pady=3)
        self._codec_var = tk.StringVar(value='libx265')
        ttk.Combobox(f, textvariable=self._codec_var, values=self.CODECS,
                     state='readonly', width=16).grid(row=0, column=1, sticky='w', padx=4)

        self._v_w   = self._slider_row(f, 'Width',          1,  64, 1280, 256,  16, 'px')
        self._v_h   = self._slider_row(f, 'Height',         2,  32,  720, 144,   8, 'px')
        self._v_fps = self._slider_row(f, 'Frame rate',     3,   1,   60,  15,   1, 'fps')
        self._v_crf = self._slider_row(f, 'CRF quality',    4,   0,   63,  40,   1,
                                       '(lower=better)')
        self._v_gop = self._slider_row(f, 'GOP (keyframe)', 5,   1,   60,  10,   1, 's')

        self._gray_var   = tk.BooleanVar(value=True)
        self._bframe_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(f, text='Grayscale (saves ~35% bitrate)',
                        variable=self._gray_var).grid(
            row=6, column=0, columnspan=2, sticky='w', padx=4, pady=3)
        ttk.Checkbutton(f, text='B-frames (better compression but adds latency/buffering)',
                        variable=self._bframe_var).grid(
            row=7, column=0, columnspan=2, sticky='w', padx=4, pady=3)

    def _slider_row(self, parent, label, row, lo, hi, default, res, suffix) -> SliderEntry:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky='w', padx=4, pady=1)
        w = SliderEntry(parent, from_=lo, to=hi, default=default,
                        resolution=res, suffix=suffix, command=self._update_bitrate)
        w.grid(row=row, column=1, sticky='ew', padx=4, pady=1)
        return w

    # ── Bottom bar ────────────────────────────────────────────────────────────

    def _build_bottom(self, root):
        bot = ttk.Frame(root, padding=6)
        bot.pack(fill='x', padx=8, pady=(0, 8))
        bot.columnconfigure(0, weight=1)

        br_frame = _lf(bot, 'Estimated bitrate')
        br_frame.grid(row=0, column=0, sticky='ew', pady=4)
        br_frame.columnconfigure(0, weight=1)
        self._br_disp = BitrateDisplay(br_frame)
        self._br_disp.pack(anchor='w', padx=4, pady=2)

        ctrl = ttk.Frame(bot)
        ctrl.grid(row=1, column=0, sticky='ew')
        self._enc_btn = ttk.Button(ctrl, text='  ENCODE  ', command=self._start_encode)
        self._enc_btn.pack(side='left', padx=4)
        self._stop_btn = ttk.Button(ctrl, text='Stop', command=self._stop_encode,
                                    state='disabled')
        self._stop_btn.pack(side='left', padx=4)

        self._prog_var = tk.DoubleVar(value=0)
        self._prog     = ttk.Progressbar(ctrl, variable=self._prog_var,
                                         maximum=1.0, length=300)
        self._prog.pack(side='left', padx=8, fill='x', expand=True)

        self._status_var = tk.StringVar(value='Ready')
        ttk.Label(bot, textvariable=self._status_var, anchor='w').grid(
            row=2, column=0, sticky='ew', padx=4)

    # ── Settings  save / load ─────────────────────────────────────────────────

    def _collect_modem_settings(self) -> ModemSettings:
        ms = ModemSettings(
            sample_rate          = self._sr_var.get(),
            method               = self._method_var.get(),
            fsk_baud             = int(self._fsk_baud.get()),
            fsk_f0               = int(self._fsk_f0.get()),
            fsk_f1               = int(self._fsk_f1.get()),
            fsk4_baud            = int(self._fsk4_baud.get()),
            fsk4_f0              = int(self._fsk4_f0.get()),
            fsk4_f1              = int(self._fsk4_f1.get()),
            fsk4_f2              = int(self._fsk4_f2.get()),
            fsk4_f3              = int(self._fsk4_f3.get()),
            dpsk_baud            = int(self._dpsk_baud.get()),
            dpsk_carrier         = int(self._dpsk_carrier.get()),
            dpsk_phases          = self._dpsk_phases.get(),
            ofdm_fft_size        = int(self._ofdm_fft.get()),
            ofdm_cp_size         = int(self._ofdm_cp.get()),
            ofdm_f_min           = int(self._ofdm_fmin.get()),
            ofdm_f_max           = int(self._ofdm_fmax.get()),
            ofdm_pilot_interval  = int(self._ofdm_pilot.get()),
            ofdm_phases          = self._ofdm_phases.get(),
            constant_power       = self._cp_var.get(),
            constant_power_carrier_hz = int(self._cp_hz.get()),
            pre_emphasis         = self._pe_var.get(),
            pre_emphasis_alpha   = round(self._pe_alpha.get(), 3),
            reed_solomon         = self._rs_var.get() and HAS_RS,
            rs_nsym              = int(self._rs_nsym.get()),
            block_data_size      = int(self._blk_size.get()),
            preamble_ms          = int(self._preamble.get()),
        )
        return ms

    def _collect_video_settings(self) -> dict:
        return dict(
            codec     = self._codec_var.get(),
            width     = int(self._v_w.get()),
            height    = int(self._v_h.get()),
            fps       = int(self._v_fps.get()),
            crf       = int(self._v_crf.get()),
            gop_secs  = int(self._v_gop.get()),
            grayscale = self._gray_var.get(),
            b_frames  = self._bframe_var.get(),
        )

    def _update_bitrate(self, *_):
        try:
            ms = self._collect_modem_settings()
            br = calculate_bitrate(ms)
            self._br_disp.update(br, br['net_bps'])
        except Exception:
            pass

    def _save_settings(self):
        p = filedialog.asksaveasfilename(defaultextension='.json',
                                         filetypes=[('JSON', '*.json')])
        if not p:
            return
        ms  = self._collect_modem_settings()
        vset = self._collect_video_settings()
        blob = {'modem': json.loads(ms.to_json()), 'video': vset}
        with open(p, 'w') as fh:
            json.dump(blob, fh, indent=2)
        messagebox.showinfo('Saved', f'Settings saved to {p}')

    def _load_settings(self):
        p = filedialog.askopenfilename(filetypes=[('JSON', '*.json')])
        if not p:
            return
        with open(p) as fh:
            blob = json.load(fh)
        ms = ModemSettings.from_json(json.dumps(blob['modem']))
        # (Apply ms back to widgets — abbreviated for clarity)
        self._method_var.set(ms.method)
        self._sr_var.set(ms.sample_rate)
        self._fsk_baud.set(ms.fsk_baud); self._fsk_f0.set(ms.fsk_f0); self._fsk_f1.set(ms.fsk_f1)
        self._fsk4_baud.set(ms.fsk4_baud)
        self._fsk4_f0.set(ms.fsk4_f0); self._fsk4_f1.set(ms.fsk4_f1)
        self._fsk4_f2.set(ms.fsk4_f2); self._fsk4_f3.set(ms.fsk4_f3)
        self._dpsk_baud.set(ms.dpsk_baud); self._dpsk_carrier.set(ms.dpsk_carrier)
        self._dpsk_phases.set(ms.dpsk_phases)
        self._ofdm_fft.set(ms.ofdm_fft_size); self._ofdm_cp.set(ms.ofdm_cp_size)
        self._ofdm_fmin.set(ms.ofdm_f_min); self._ofdm_fmax.set(ms.ofdm_f_max)
        self._ofdm_pilot.set(ms.ofdm_pilot_interval); self._ofdm_phases.set(ms.ofdm_phases)
        self._cp_var.set(ms.constant_power); self._cp_hz.set(ms.constant_power_carrier_hz)
        self._pe_var.set(ms.pre_emphasis); self._pe_alpha.set(ms.pre_emphasis_alpha)
        self._rs_var.set(ms.reed_solomon); self._rs_nsym.set(ms.rs_nsym)
        self._blk_size.set(ms.block_data_size); self._preamble.set(ms.preamble_ms)
        if 'video' in blob:
            v = blob['video']
            self._codec_var.set(v.get('codec', 'libx265'))
            self._v_w.set(v.get('width', 256)); self._v_h.set(v.get('height', 144))
            self._v_fps.set(v.get('fps', 15)); self._v_crf.set(v.get('crf', 40))
            self._v_gop.set(v.get('gop_secs', 10))
            self._gray_var.set(v.get('grayscale', True))
            self._bframe_var.set(v.get('b_frames', False))
        self._method_changed()

    # ── Encode ────────────────────────────────────────────────────────────────

    def _start_encode(self):
        inp = self._in_var.get().strip()
        out = self._out_var.get().strip()
        if not inp or not os.path.isfile(inp):
            messagebox.showerror('Error', 'Select a valid input video file.')
            return
        if not out:
            messagebox.showerror('Error', 'Select an output WAV path.')
            return

        ms   = self._collect_modem_settings()
        vset = self._collect_video_settings()

        self._enc_btn.configure(state='disabled')
        self._stop_btn.configure(state='normal')
        self._stop_flag.clear()
        self._status_var.set('Starting…')
        self._prog_var.set(0)

        self._encode_thread = threading.Thread(
            target=self._encode_worker, args=(inp, out, ms, vset), daemon=True)
        self._encode_thread.start()
        self.root.after(200, self._poll_encode)

    def _encode_worker(self, inp, out, ms, vset):
        try:
            self._set_status('Step 1/2 — Re-encoding video with ffmpeg…')
            video_bytes = ffmpeg_encode_video(inp, vset)

            if self._stop_flag.is_set():
                self._set_status('Cancelled.')
                return

            self._set_status(
                f'Step 2/2 — Modulating {len(video_bytes):,} bytes to audio…')

            def progress(p):
                self._prog_var.set(p)

            encode_to_wav(video_bytes, out, ms, vset=vset, progress_cb=progress)
            self._set_status(f'Done → {out}')
        except Exception as e:
            self._set_status(f'Error: {e}')
            messagebox.showerror('Encode error', str(e))
        finally:
            self.root.after(0, lambda: self._enc_btn.configure(state='normal'))
            self.root.after(0, lambda: self._stop_btn.configure(state='disabled'))

    def _set_status(self, msg):
        self.root.after(0, lambda: self._status_var.set(msg))

    def _stop_encode(self):
        self._stop_flag.set()
        self._status_var.set('Stopping…')

    def _poll_encode(self):
        if self._encode_thread and self._encode_thread.is_alive():
            self.root.after(200, self._poll_encode)


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    root = tk.Tk()
    app  = EncoderGUI(root)
    root.mainloop()
