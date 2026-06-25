#!/usr/bin/env python3
"""
cassette_decoder.py — GUI decoder: real-time cassette audio → video playback.

Reads from line-in / microphone via sounddevice, demodulates modem frames,
reassembles the video byte stream, and displays it live via ffmpeg + tkinter.

Pause detection: when the tape stops (signal below threshold), playback freezes.
When tape resumes the stream picks up exactly where it left off.
"""
from __future__ import annotations
import json, os, queue, subprocess, threading, time, wave
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Optional
import io

import numpy as np
try:
    import sounddevice as sd
    HAS_SD = True
except ImportError:
    HAS_SD = False

try:
    from PIL import Image, ImageTk, ImageDraw, ImageFont
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

from cassette_modem import (
    ModemSettings, DecoderState, calculate_bitrate, HAS_RS,
    SYNC_MAGIC, METADATA_SEQ, decode_metadata_payload, pilot_resample,
    ffmpeg_available, FFMPEG_INSTALL_HELP,
)


# ═══════════════════════════════════════════════════════════════════════════════
# VIDEO RECONSTRUCTION  (reassemble byte stream → ffmpeg → PIL frames)
# ═══════════════════════════════════════════════════════════════════════════════

class VideoReconstructor:
    """
    Receives ordered (seq, payload) blocks, reassembles the video byte stream,
    pipes it to ffmpeg to decode raw RGB frames, pushes frames into frame_queue.
    Handles gaps gracefully by skipping missing blocks after a short wait.
    """
    GAP_WAIT    = 0.4    # seconds to wait for a missing seq before skipping
    QUEUE_MAX   = 32

    def __init__(self, vset: dict):
        self.vset        = vset
        self.frame_queue : queue.Queue = queue.Queue(maxsize=self.QUEUE_MAX)
        self._block_buf  : dict        = {}   # seq → bytes
        self._next_seq   = 0
        self._gap_since  : float       = 0.0
        self._byte_buf   = bytearray()
        self._ffmpeg     : Optional[subprocess.Popen] = None
        self._reader     : Optional[threading.Thread] = None
        self._lock       = threading.Lock()
        self._running    = False
        self._stats      = {'blocks_rx': 0, 'blocks_lost': 0, 'frames': 0}

    def start(self):
        self._running = True
        self._start_ffmpeg()
        self._reader = threading.Thread(target=self._read_frames, daemon=True)
        self._reader.start()

    def _start_ffmpeg(self):
        w, h = self.vset['width'], self.vset['height']
        cmd = ['ffmpeg', '-loglevel', 'error',
               '-i', 'pipe:0',
               '-vf', f'scale={w}:{h}',
               '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               'pipe:1']
        try:
            self._ffmpeg = subprocess.Popen(
                cmd, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            self._ffmpeg = None

    def _read_frames(self):
        if not self._ffmpeg:
            return
        w, h     = self.vset['width'], self.vset['height']
        frame_sz = w * h * 3
        buf      = bytearray()
        while self._running:
            try:
                chunk = self._ffmpeg.stdout.read(4096)
                if not chunk:
                    break
                buf.extend(chunk)
                while len(buf) >= frame_sz:
                    raw = bytes(buf[:frame_sz])
                    del buf[:frame_sz]
                    if HAS_PIL:
                        img = Image.frombytes('RGB', (w, h), raw)
                    else:
                        img = raw   # fall back to raw bytes
                    try:
                        self.frame_queue.put_nowait(img)
                        self._stats['frames'] += 1
                    except queue.Full:
                        pass   # drop oldest would be ideal; skip for now
            except Exception:
                break

    def feed_block(self, seq: int, payload: bytes):
        with self._lock:
            self._block_buf[seq] = payload
            self._stats['blocks_rx'] += 1
        self._flush_blocks()

    def _flush_blocks(self):
        while True:
            with self._lock:
                if self._next_seq in self._block_buf:
                    data = self._block_buf.pop(self._next_seq)
                    self._next_seq += 1
                    self._gap_since = 0.0
                elif self._block_buf:
                    # Gap — wait a bit then skip
                    if self._gap_since == 0.0:
                        self._gap_since = time.monotonic()
                    elif time.monotonic() - self._gap_since > self.GAP_WAIT:
                        self._stats['blocks_lost'] += 1
                        self._next_seq += 1
                        self._gap_since = 0.0
                    break
                else:
                    break
            # Write payload to ffmpeg outside the lock
            if self._ffmpeg and self._ffmpeg.stdin:
                try:
                    self._ffmpeg.stdin.write(data)
                    self._ffmpeg.stdin.flush()
                except BrokenPipeError:
                    pass

    def stop(self):
        # Close stdin FIRST (signals EOF so ffmpeg flushes its final frames) and
        # keep the reader draining stdout — otherwise ffmpeg blocks writing into
        # a full, unread output pipe and never exits. Only stop the reader once
        # ffmpeg has gone.
        if self._ffmpeg:
            try:
                self._ffmpeg.stdin.close()
            except Exception:
                pass
            try:
                self._ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._ffmpeg.kill()
                try:
                    self._ffmpeg.wait(timeout=2)
                except Exception:
                    pass
        self._running = False

    @property
    def stats(self):
        with self._lock:
            return dict(self._stats)


# ═══════════════════════════════════════════════════════════════════════════════
# AUDIO INPUT THREAD
# ═══════════════════════════════════════════════════════════════════════════════

class AudioInputThread(threading.Thread):
    """Reads audio from sounddevice in real time and pushes chunks to a queue."""

    def __init__(self, device_idx: Optional[int], sample_rate: int,
                 chunk_ms: int = 100):
        super().__init__(daemon=True)
        self._device      = device_idx
        self._sample_rate = sample_rate
        self._chunk_ms    = chunk_ms
        self.chunk_queue : queue.Queue = queue.Queue(maxsize=64)
        self._running     = False
        self.error: Optional[str] = None

    def run(self):
        if not HAS_SD:
            self.error = 'sounddevice not installed'
            return
        chunk_n = int(self._sample_rate * self._chunk_ms / 1000)
        try:
            with sd.InputStream(device=self._device,
                                 samplerate=self._sample_rate,
                                 channels=1, dtype='float32',
                                 blocksize=chunk_n) as stream:
                self._running = True
                while self._running:
                    chunk, _ = stream.read(chunk_n)
                    arr = chunk[:, 0]
                    try:
                        self.chunk_queue.put_nowait(arr)
                    except queue.Full:
                        pass
        except Exception as e:
            self.error = str(e)

    def stop(self):
        self._running = False


# ═══════════════════════════════════════════════════════════════════════════════
# WAV FILE INPUT THREAD  (for testing without live tape)
# ═══════════════════════════════════════════════════════════════════════════════

class WavFileThread(threading.Thread):
    """Streams a WAV file as if it were live input (at real-time speed).

    If `ms.pilot_tone` is set, the whole file is loaded and wow/flutter-corrected
    (pilot_resample) up front before streaming — the realistic 'recorded a tape,
    captured it to a WAV, now decode it' workflow."""

    def __init__(self, path: str, ms: Optional[ModemSettings] = None, chunk_ms: int = 100):
        super().__init__(daemon=True)
        self._path     = path
        self._ms       = ms
        self._chunk_ms = chunk_ms
        self.chunk_queue : queue.Queue = queue.Queue(maxsize=64)
        self._running = False
        self.error: Optional[str] = None
        with wave.open(path) as wf:          # read the rate synchronously up front
            self.sample_rate = wf.getframerate()

    def run(self):
        try:
            with wave.open(self._path) as wf:
                raw = wf.readframes(wf.getnframes())
            arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if self._ms is not None and self._ms.pilot_tone:
                self._ms.sample_rate = self.sample_rate
                arr = pilot_resample(arr, self._ms)
            chunk_n = int(self.sample_rate * self._chunk_ms / 1000)
            self._running = True
            for i in range(0, len(arr), chunk_n):
                if not self._running:
                    break
                try:
                    self.chunk_queue.put_nowait(arr[i:i + chunk_n])
                except queue.Full:
                    pass
                time.sleep(self._chunk_ms / 1000)
        except Exception as e:
            self.error = str(e)

    def stop(self):
        self._running = False


# ═══════════════════════════════════════════════════════════════════════════════
# SLIDER + ENTRY (copied from encoder for standalone use)
# ═══════════════════════════════════════════════════════════════════════════════

class SliderEntry(tk.Frame):
    def __init__(self, parent, from_, to, default, resolution=1, suffix='',
                 command=None, **kw):
        super().__init__(parent, **kw)
        self._cmd = command
        self.var  = tk.DoubleVar(value=default)
        self._res = resolution
        self.scale = ttk.Scale(self, from_=from_, to=to, orient='horizontal',
                               variable=self.var, command=self._on_scale)
        self.scale.pack(side='left', fill='x', expand=True)
        self.entry = ttk.Entry(self, textvariable=self.var, width=7)
        self.entry.pack(side='left', padx=(2, 0))
        self.entry.bind('<Return>',   self._on_entry)
        self.entry.bind('<FocusOut>', self._on_entry)
        if suffix:
            ttk.Label(self, text=suffix).pack(side='left')

    def _on_scale(self, _=None):
        v = round(self.var.get() / self._res) * self._res
        self.var.set(v)
        if self._cmd: self._cmd()

    def _on_entry(self, _=None):
        try:
            self.var.set(float(self.entry.get()))
        except ValueError:
            pass
        if self._cmd: self._cmd()

    def get(self): return self.var.get()
    def set(self, v): self.var.set(v)


def _lf(parent, label, pad=4):
    return ttk.LabelFrame(parent, text=label, padding=pad)


class Tooltip:
    """Hover tooltip: a small yellow popup shown while the pointer is over a widget."""
    def __init__(self, widget, text: str):
        self.widget = widget
        self.text   = text
        self._tip   = None
        widget.bind('<Enter>', self._show, add='+')
        widget.bind('<Leave>', self._hide, add='+')

    def _show(self, _=None):
        if self._tip or not self.text:
            return
        x = self.widget.winfo_rootx() + 18
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 4
        self._tip = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f'+{x}+{y}')
        tk.Label(tw, text=self.text, justify='left', background='#ffffe0',
                 relief='solid', borderwidth=1, wraplength=340,
                 font=('TkDefaultFont', 8)).pack(ipadx=4, ipady=2)

    def _hide(self, _=None):
        if self._tip:
            self._tip.destroy()
            self._tip = None


# ═══════════════════════════════════════════════════════════════════════════════
# SIGNAL LEVEL METER WIDGET
# ═══════════════════════════════════════════════════════════════════════════════

class LevelMeter(tk.Frame):
    W, H = 200, 14

    def __init__(self, parent, **kw):
        super().__init__(parent, **kw)
        self.canvas = tk.Canvas(self, width=self.W, height=self.H,
                                bg='#1e1e1e', highlightthickness=1,
                                highlightbackground='#555')
        self.canvas.pack()
        self._bar  = self.canvas.create_rectangle(0, 0, 0, self.H, fill='#00c87a', outline='')
        self._text = self.canvas.create_text(self.W // 2, self.H // 2,
                                             text='', fill='white', font=('Consolas', 8))

    def update_level(self, rms: float):
        clamped = min(1.0, rms / 0.5)
        color   = '#00c87a' if clamped < 0.7 else ('#f5a623' if clamped < 0.9 else '#e74c3c')
        self.canvas.itemconfig(self._bar, fill=color)
        self.canvas.coords(self._bar, 0, 0, int(self.W * clamped), self.H)
        self.canvas.itemconfig(self._text, text=f'RMS {rms:.4f}')


# ═══════════════════════════════════════════════════════════════════════════════
# DECODER GUI
# ═══════════════════════════════════════════════════════════════════════════════

class DecoderGUI:
    METHODS = ['ofdm', 'dpsk', 'fsk4', 'fsk']
    RATES   = [44100, 48000]

    # Default display size when no video is decoded
    DISPLAY_W = 256
    DISPLAY_H = 144

    def __init__(self, root: tk.Tk):
        self.root = root
        root.title('Cassette Tape Decoder')
        root.resizable(False, False)

        self._audio_thread : Optional[threading.Thread] = None
        self._decode_thread: Optional[threading.Thread] = None
        self._video_recon  : Optional[VideoReconstructor] = None
        self._running      = False

        # Build UI
        main = ttk.PanedWindow(root, orient='horizontal')
        main.pack(fill='both', expand=True, padx=6, pady=6)

        left  = ttk.Frame(main, padding=4)
        right = ttk.Frame(main, padding=4)
        main.add(left); main.add(right)

        self._build_video_panel(right)
        self._build_controls(left)
        self._build_status(root)

        self._update_bitrate()
        self._poll_display()   # start display loop

    # ── Video display panel ───────────────────────────────────────────────────

    def _build_video_panel(self, f):
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)
        self._canvas = tk.Canvas(f, width=self.DISPLAY_W, height=self.DISPLAY_H,
                                  bg='black', highlightthickness=2,
                                  highlightbackground='#333')
        self._canvas.grid(row=0, column=0, sticky='nsew')
        self._tk_image = None
        self._show_standby()

    def _show_standby(self, text='STANDBY'):
        if not HAS_PIL:
            self._canvas.delete('all')
            self._canvas.create_text(
                self.DISPLAY_W // 2, self.DISPLAY_H // 2,
                text=text, fill='#888', font=('Consolas', 14))
            return
        img  = Image.new('RGB', (self.DISPLAY_W, self.DISPLAY_H), (10, 10, 10))
        draw = ImageDraw.Draw(img)
        draw.text((self.DISPLAY_W // 2, self.DISPLAY_H // 2),
                  text, fill=(100, 100, 100), anchor='mm')
        self._show_pil(img)

    def _show_pil(self, img):
        if not HAS_PIL:
            return
        img = img.resize((self.DISPLAY_W, self.DISPLAY_H), Image.NEAREST)
        tk_img = ImageTk.PhotoImage(img)
        self._canvas.delete('all')
        self._canvas.create_image(0, 0, anchor='nw', image=tk_img)
        self._tk_image = tk_img   # prevent GC

    def _overlay_paused(self, img):
        """Draw semi-transparent PAUSED overlay on a PIL image."""
        if not HAS_PIL:
            return img
        overlay = Image.new('RGBA', img.size, (0, 0, 0, 120))
        img_rgba = img.convert('RGBA')
        img_rgba.paste(overlay, mask=overlay)
        draw = ImageDraw.Draw(img_rgba)
        draw.text((img.width // 2, img.height // 2),
                  '⏸  PAUSED', fill=(255, 255, 255, 220), anchor='mm')
        return img_rgba.convert('RGB')

    # ── Controls panel ────────────────────────────────────────────────────────

    def _build_controls(self, f):
        f.columnconfigure(0, weight=1)
        row = 0

        # Audio source
        src = _lf(f, 'Audio source')
        src.grid(row=row, column=0, sticky='ew', pady=4); row += 1
        src.columnconfigure(1, weight=1)

        self._src_var = tk.StringVar(value='live')
        ttk.Radiobutton(src, text='Live input (tape)',  variable=self._src_var,
                        value='live',  command=self._src_changed).grid(
            row=0, column=0, sticky='w')
        ttk.Radiobutton(src, text='WAV file (testing)', variable=self._src_var,
                        value='file',  command=self._src_changed).grid(
            row=0, column=1, sticky='w')

        self._src_frame_live = ttk.Frame(src)
        self._src_frame_live.grid(row=1, column=0, columnspan=2, sticky='ew', pady=2)
        self._src_frame_live.columnconfigure(1, weight=1)
        ttk.Label(self._src_frame_live, text='Input device:').grid(row=0, column=0, sticky='w')
        self._dev_var = tk.StringVar()
        self._dev_combo = ttk.Combobox(self._src_frame_live, textvariable=self._dev_var,
                                        state='readonly', width=26)
        self._dev_combo.grid(row=0, column=1, sticky='ew', padx=4)
        self._populate_devices()

        self._src_frame_file = ttk.Frame(src)
        self._src_frame_file.grid(row=2, column=0, columnspan=2, sticky='ew', pady=2)
        self._src_frame_file.columnconfigure(1, weight=1)
        ttk.Label(self._src_frame_file, text='WAV file:').grid(row=0, column=0, sticky='w')
        self._wav_var = tk.StringVar()
        ttk.Entry(self._src_frame_file, textvariable=self._wav_var, width=22).grid(
            row=0, column=1, padx=2)
        ttk.Button(self._src_frame_file, text='…', width=2,
                   command=self._browse_wav).grid(row=0, column=2)
        self._src_changed()

        # Sample rate
        sr_f = ttk.Frame(src)
        sr_f.grid(row=3, column=0, columnspan=2, sticky='w', pady=2)
        ttk.Label(sr_f, text='Sample rate:').pack(side='left')
        self._sr_var = tk.IntVar(value=44100)
        for sr in self.RATES:
            ttk.Radiobutton(sr_f, text=str(sr), variable=self._sr_var,
                            value=sr, command=self._update_bitrate).pack(side='left', padx=4)

        # Modem settings (collapsible – shown in a notebook)
        modem_nb = ttk.Notebook(f)
        modem_nb.grid(row=row, column=0, sticky='ew', pady=4); row += 1

        tab_mod  = ttk.Frame(modem_nb, padding=4)
        tab_cond = ttk.Frame(modem_nb, padding=4)
        tab_vid  = ttk.Frame(modem_nb, padding=4)
        modem_nb.add(tab_mod,  text='Demod')
        modem_nb.add(tab_cond, text='Conditioning')
        modem_nb.add(tab_vid,  text='Video out')

        self._build_demod_tab(tab_mod)
        self._build_cond_tab(tab_cond)
        self._build_video_tab(tab_vid)

        # Bitrate estimate
        br_lf = _lf(f, 'Expected bitrate (must match encoder)')
        br_lf.grid(row=row, column=0, sticky='ew', pady=4); row += 1
        self._br_var = tk.StringVar(value='—')
        ttk.Label(br_lf, textvariable=self._br_var,
                  font=('Consolas', 9)).pack(anchor='w')

        # Controls
        ctrl = ttk.Frame(f)
        ctrl.grid(row=row, column=0, sticky='ew', pady=4); row += 1
        self._start_btn = ttk.Button(ctrl, text='  START DECODING  ',
                                     command=self._start)
        self._start_btn.pack(side='left', padx=4)
        self._stop_btn  = ttk.Button(ctrl, text='Stop', command=self._stop,
                                     state='disabled')
        self._stop_btn.pack(side='left', padx=4)
        ttk.Button(ctrl, text='Save settings', command=self._save_settings).pack(side='left', padx=4)
        ttk.Button(ctrl, text='Load settings', command=self._load_settings).pack(side='left', padx=4)

    def _build_demod_tab(self, f):
        f.columnconfigure(1, weight=1)

        ml = ttk.Label(f, text='Method:')
        ml.grid(row=0, column=0, sticky='w')
        Tooltip(ml, 'Every setting on this tab MUST match the encoder exactly, or the stream '
                    'will not decode. Easiest path: Load settings from the .json the encoder '
                    'saved.')
        self._method_var = tk.StringVar(value='ofdm')
        mf = ttk.Frame(f)
        mf.grid(row=0, column=1, sticky='w')
        for m in self.METHODS:
            rb = ttk.Radiobutton(mf, text=m.upper(), variable=self._method_var,
                            value=m, command=self._update_bitrate)
            rb.pack(side='left', padx=4)
            Tooltip(rb, 'Must match the encoder\'s modulation method.')

        self._fsk_baud    = self._se(f, 'FSK baud',     1, 1000, 10000, 6000, 100, 'baud')
        self._fsk_f0      = self._se(f, 'FSK f0',       2,  300,  4000, 1200, 100, 'Hz')
        self._fsk_f1      = self._se(f, 'FSK f1',       3,  600,  6000, 2400, 100, 'Hz')
        self._fsk4_baud   = self._se(f, '4FSK baud',    4,  500,  6000, 3500, 100, 'baud')
        self._fsk4_f0     = self._se(f, '4FSK f0',      5,  300,  3000, 1000, 100, 'Hz')
        self._fsk4_f1     = self._se(f, '4FSK f1',      6,  600,  4000, 2000, 100, 'Hz')
        self._fsk4_f2     = self._se(f, '4FSK f2',      7,  900,  5000, 3000, 100, 'Hz')
        self._fsk4_f3     = self._se(f, '4FSK f3',      8, 1200,  6000, 4000, 100, 'Hz')
        self._dpsk_baud   = self._se(f, 'DPSK baud',    9,  500,  6000, 3500, 100, 'baud')
        self._dpsk_carr   = self._se(f, 'DPSK carrier',10,  600,  5500, 3000, 100, 'Hz')
        ttk.Label(f, text='DPSK phases').grid(row=11, column=0, sticky='w', padx=2)
        self._dpsk_phases = tk.IntVar(value=4)
        pf = ttk.Frame(f); pf.grid(row=11, column=1, sticky='w')
        for v, l in [(2,'2'),(4,'4'),(8,'8')]:
            ttk.Radiobutton(pf, text=l, variable=self._dpsk_phases,
                            value=v, command=self._update_bitrate).pack(side='left', padx=3)
        self._ofdm_fft  = self._se(f, 'OFDM FFT',    12,  128,  2048,  512, 128, 'samples')
        self._ofdm_cp   = self._se(f, 'OFDM CP',     13,   16,   512,   64,  16, 'samples')
        self._ofdm_fmin = self._se(f, 'OFDM fmin',   14,  200,  2000,  500,  50, 'Hz')
        self._ofdm_fmax = self._se(f, 'OFDM fmax',   15, 2000,  8000, 6000, 100, 'Hz')
        self._ofdm_pil  = self._se(f, 'OFDM pilots', 16,    2,    20,    8,   1, '/N carriers')
        ttk.Label(f, text='OFDM phases').grid(row=17, column=0, sticky='w', padx=2)
        self._ofdm_phases = tk.IntVar(value=4)
        of = ttk.Frame(f); of.grid(row=17, column=1, sticky='w')
        for v, l in [(2,'2'),(4,'4'),(8,'8')]:
            ttk.Radiobutton(of, text=l, variable=self._ofdm_phases,
                            value=v, command=self._update_bitrate).pack(side='left', padx=3)

    def _build_cond_tab(self, f):
        f.columnconfigure(1, weight=1)
        # Defaults OFF, matching the encoder's safe defaults. These MUST match
        # whatever the encoder used or the stream won't decode.
        self._cp_var    = tk.BooleanVar(value=False)
        self._pe_var    = tk.BooleanVar(value=False)
        self._rs_var    = tk.BooleanVar(value=True)
        cp_cb = ttk.Checkbutton(f, text='Constant-power carrier strip',
                        variable=self._cp_var)
        cp_cb.grid(row=0, column=0, columnspan=2, sticky='w')
        Tooltip(cp_cb, 'MUST match the encoder. Removes the AGC-pinning tone before '
                       'demodulating. Turn on only if the encoder used it.')
        self._cp_hz     = self._se(f, 'CP carrier Hz',  1, 50,  800, 300, 10, 'Hz',
            tip='Carrier frequency to strip — must equal the encoder\'s setting.')
        pe_cb = ttk.Checkbutton(f, text='De-emphasis', variable=self._pe_var)
        pe_cb.grid(row=2, column=0, columnspan=2, sticky='w')
        Tooltip(pe_cb, 'MUST match the encoder\'s pre-emphasis setting, or the audio will '
                       'be filtered wrong and decode to garbage.')
        self._pe_alpha  = self._se(f, 'Alpha',           3, 0.5, 0.99, 0.85, 0.01, '',
            tip='De-emphasis strength — must equal the encoder\'s alpha.')
        ttk.Checkbutton(f, text='Reed-Solomon' + ('' if HAS_RS else ' [not installed]'),
                        variable=self._rs_var,
                        state='normal' if HAS_RS else 'disabled').grid(
            row=4, column=0, columnspan=2, sticky='w')
        self._rs_nsym   = self._se(f, 'RS parity syms', 5,  4,  64,  16,  2, 'bytes')
        self._blk_size  = self._se(f, 'Block payload',  6, 32, 1024, 256, 32, 'bytes')
        self._paus_thr  = self._se(f, 'Pause threshold',7, 0.001, 0.1, 0.008, 0.001, 'RMS',
            tip='Signal level below which the tape counts as stopped. If pausing the tape '
                'doesn\'t freeze playback, raise this; if it falsely pauses, lower it.')
        self._paus_time = self._se(f, 'Pause timeout',  8, 0.05, 2.0, 0.30, 0.05, 's',
            tip='How long the signal must stay low before showing PAUSED. Higher = less '
                'jumpy on brief dropouts.')
        self._pilot_var = tk.BooleanVar(value=False)
        pilot_cb = ttk.Checkbutton(f, text='Pilot wow/flutter correction',
                                   variable=self._pilot_var)
        pilot_cb.grid(row=9, column=0, columnspan=2, sticky='w')
        Tooltip(pilot_cb, 'MUST match the encoder. Uses the pilot tone to undo the tape\'s '
                          'speed wobble. Applied when decoding a WAV file (not yet on the '
                          'live input).')
        self._pilot_hz  = self._se(f, 'Pilot Hz', 10, 400, 2000, 700, 50, 'Hz',
            tip='Pilot frequency — must equal the encoder\'s.')

    def _build_video_tab(self, f):
        f.columnconfigure(1, weight=1)
        self._out_w = self._se(f, 'Display width',  0,  64, 1280, 256,  16, 'px')
        self._out_h = self._se(f, 'Display height', 1,  32,  720, 144,   8, 'px')

    def _se(self, parent, label, row, lo, hi, default, res, suffix, tip='') -> SliderEntry:
        lbl = ttk.Label(parent, text=label)
        lbl.grid(row=row, column=0, sticky='w', padx=2, pady=1)
        w = SliderEntry(parent, from_=lo, to=hi, default=default,
                        resolution=res, suffix=suffix, command=self._update_bitrate)
        w.grid(row=row, column=1, sticky='ew', padx=2, pady=1)
        if tip:
            Tooltip(lbl, tip); Tooltip(w, tip)
        return w

    # ── Status bar ────────────────────────────────────────────────────────────

    def _build_status(self, root):
        sb = ttk.Frame(root, padding=4)
        sb.pack(fill='x', padx=6, pady=(0, 6))
        sb.columnconfigure(2, weight=1)

        ttk.Label(sb, text='Status:').grid(row=0, column=0, sticky='w')
        self._state_var = tk.StringVar(value='● STOPPED')
        ttk.Label(sb, textvariable=self._state_var,
                  font=('Consolas', 9, 'bold')).grid(row=0, column=1, padx=8)

        ttk.Label(sb, text='Signal:').grid(row=0, column=2, sticky='e')
        self._level = LevelMeter(sb)
        self._level.grid(row=0, column=3, padx=4)

        self._stat_var = tk.StringVar(value='Blocks: 0  |  Lost: 0  |  Frames: 0')
        ttk.Label(sb, textvariable=self._stat_var,
                  font=('Consolas', 8)).grid(row=1, column=0, columnspan=4, sticky='w')

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _populate_devices(self):
        if not HAS_SD:
            self._dev_combo['values'] = ['sounddevice not installed']
            return
        devs = sd.query_devices()
        names = [f"{i}: {d['name']}" for i, d in enumerate(devs)
                 if d['max_input_channels'] > 0]
        self._dev_combo['values'] = names or ['(no input devices)']
        if names:
            self._dev_combo.current(0)

    def _src_changed(self):
        is_live = self._src_var.get() == 'live'
        for w in self._src_frame_live.winfo_children():
            try: w.configure(state='normal' if is_live else 'disabled')
            except Exception: pass
        for w in self._src_frame_file.winfo_children():
            try: w.configure(state='disabled' if is_live else 'normal')
            except Exception: pass

    def _browse_wav(self):
        p = filedialog.askopenfilename(filetypes=[('WAV', '*.wav'), ('All', '*.*')])
        if p:
            self._wav_var.set(p)

    def _collect_settings(self) -> ModemSettings:
        return ModemSettings(
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
            dpsk_carrier         = int(self._dpsk_carr.get()),
            dpsk_phases          = self._dpsk_phases.get(),
            ofdm_fft_size        = int(self._ofdm_fft.get()),
            ofdm_cp_size         = int(self._ofdm_cp.get()),
            ofdm_f_min           = int(self._ofdm_fmin.get()),
            ofdm_f_max           = int(self._ofdm_fmax.get()),
            ofdm_pilot_interval  = int(self._ofdm_pil.get()),
            ofdm_phases          = self._ofdm_phases.get(),
            constant_power       = self._cp_var.get(),
            pre_emphasis         = self._pe_var.get(),
            pre_emphasis_alpha   = round(self._pe_alpha.get(), 3),
            pilot_tone           = self._pilot_var.get(),
            pilot_hz             = int(self._pilot_hz.get()),
            reed_solomon         = self._rs_var.get() and HAS_RS,
            rs_nsym              = int(self._rs_nsym.get()),
            block_data_size      = int(self._blk_size.get()),
            constant_power_carrier_hz = int(self._cp_hz.get()),
        )

    def _update_bitrate(self, *_):
        try:
            ms = self._collect_settings()
            br = calculate_bitrate(ms)
            self._br_var.set(
                f"Raw {br['raw_bps']:,} bps  │  Net {br['net_bps']:,} bps  "
                f"│  {br['net_kBps']:.3f} KB/s (1024-KB)  "
                f"│  Overhead {br['efficiency_pct']}% eff."
            )
        except Exception:
            pass

    # ── Start / Stop ──────────────────────────────────────────────────────────

    def _start(self):
        ms   = self._collect_settings()
        vset = dict(width=int(self._out_w.get()), height=int(self._out_h.get()))

        # Audio source
        if self._src_var.get() == 'live':
            if not HAS_SD:
                messagebox.showerror('Error', 'sounddevice not installed.')
                return
            dev_str = self._dev_var.get()
            dev_idx = int(dev_str.split(':')[0]) if dev_str and ':' in dev_str else None
            ath = AudioInputThread(dev_idx, ms.sample_rate)
            ath.start()
            self._audio_thread = ath
        else:
            path = self._wav_var.get().strip()
            if not path or not os.path.isfile(path):
                messagebox.showerror('Error', 'Select a valid WAV file.')
                return
            wft = WavFileThread(path, ms)
            ms.sample_rate = wft.sample_rate
            wft.start()
            self._audio_thread = wft

        if not ffmpeg_available():
            messagebox.showwarning('ffmpeg not found',
                                   FFMPEG_INSTALL_HELP +
                                   '\n\nDecoding will run, but no video can be shown.')

        self._decoder_state = DecoderState(ms)
        self._decoder_state.PAUSE_THRESHOLD = float(self._paus_thr.get())
        self._decoder_state.PAUSE_TIMEOUT   = float(self._paus_time.get())

        # VideoReconstructor is created lazily once we know the resolution:
        # from the metadata block if present, else these UI fallbacks.
        self._fallback_vset = vset
        self._video_recon = None
        self._detected_meta = ''

        self._running = True
        self._last_frame: Optional[object] = None
        self._decode_thread = threading.Thread(target=self._decode_loop, daemon=True)
        self._decode_thread.start()

        self._start_btn.configure(state='disabled')
        self._stop_btn.configure(state='normal')
        self._state_var.set('● DECODING')

    def _decode_loop(self):
        """Background thread: drain audio queue → decoder → video reconstructor."""
        q = self._audio_thread.chunk_queue
        while self._running:
            try:
                chunk = q.get(timeout=0.5)
            except queue.Empty:
                continue
            blocks = self._decoder_state.feed_audio(chunk)
            for seq, payload in blocks:
                if seq == METADATA_SEQ:
                    self._handle_metadata(payload)
                    continue
                if self._video_recon is None:
                    self._ensure_recon(self._fallback_vset)
                self._video_recon.feed_block(seq, payload)

        # Signal thread finished
        self._running = False

    def _handle_metadata(self, payload: bytes):
        """Parse the metadata block and start the reconstructor at the encoded
        resolution, so the decoder doesn't depend on the UI matching the source."""
        meta = decode_metadata_payload(payload)
        if not meta:
            return
        v = meta.get('video', {})
        vset = dict(width=int(v.get('width', self._fallback_vset['width'])),
                    height=int(v.get('height', self._fallback_vset['height'])))
        self._detected_meta = (
            f"detected {vset['width']}x{vset['height']}"
            f"@{v.get('fps','?')}fps {v.get('codec','?')}")
        if self._video_recon is None:
            self._ensure_recon(vset)

    def _ensure_recon(self, vset: dict):
        self._video_recon = VideoReconstructor(vset)
        self._video_recon.start()

    def _stop(self):
        self._running = False
        if self._audio_thread:
            self._audio_thread.stop()
        if self._video_recon:
            self._video_recon.stop()
        self._start_btn.configure(state='normal')
        self._stop_btn.configure(state='disabled')
        self._state_var.set('● STOPPED')
        self._show_standby()

    # ── Display poll loop (runs on main thread) ────────────────────────────────

    def _poll_display(self):
        """Called by tkinter every ~33 ms to update the video canvas."""
        if self._running:
            # Drain available frames; show latest
            latest = None
            if self._video_recon is not None:
                try:
                    while True:
                        latest = self._video_recon.frame_queue.get_nowait()
                except queue.Empty:
                    pass

            if latest is not None:
                self._last_frame = latest

            if self._last_frame is not None and HAS_PIL:
                img = self._last_frame
                if self._decoder_state.is_paused:
                    img = self._overlay_paused(img)
                    self._state_var.set('⏸ PAUSED (no signal)')
                else:
                    self._state_var.set('▶ PLAYING')
                self._show_pil(img)
            elif self._video_recon is None:
                # Audio is being decoded but no block/resolution yet (e.g. OFDM
                # still acquiring symbol lock).
                self._state_var.set('● ACQUIRING…')

            # Update signal level (works during the lock phase too)
            try:
                chunk = self._audio_thread.chunk_queue.queue[-1]
                rms   = float(np.sqrt(np.mean(chunk ** 2)))
                self._level.update_level(rms)
            except (IndexError, AttributeError):
                pass

            # Update stats
            st = self._video_recon.stats if self._video_recon else {
                'blocks_rx': 0, 'blocks_lost': 0, 'frames': 0}
            meta = f"  │  {self._detected_meta}" if self._detected_meta else ''
            self._stat_var.set(
                f"Blocks rx: {st['blocks_rx']:,}  │  "
                f"Lost: {st['blocks_lost']}  │  "
                f"Frames decoded: {st['frames']:,}{meta}")

        self.root.after(33, self._poll_display)   # ~30 fps update rate

    # ── Settings save / load ──────────────────────────────────────────────────

    def _save_settings(self):
        p = filedialog.asksaveasfilename(defaultextension='.json',
                                          filetypes=[('JSON', '*.json')])
        if not p: return
        ms = self._collect_settings()
        blob = {
            'modem': json.loads(ms.to_json()),
            'video': {'width': int(self._out_w.get()), 'height': int(self._out_h.get())},
        }
        with open(p, 'w') as fh:
            json.dump(blob, fh, indent=2)
        messagebox.showinfo('Saved', f'Settings saved to {p}')

    def _load_settings(self):
        p = filedialog.askopenfilename(filetypes=[('JSON', '*.json')])
        if not p: return
        with open(p) as fh:
            blob = json.load(fh)
        ms = ModemSettings.from_json(json.dumps(blob['modem']))
        self._method_var.set(ms.method); self._sr_var.set(ms.sample_rate)
        self._fsk_baud.set(ms.fsk_baud); self._fsk_f0.set(ms.fsk_f0); self._fsk_f1.set(ms.fsk_f1)
        self._fsk4_baud.set(ms.fsk4_baud)
        self._fsk4_f0.set(ms.fsk4_f0); self._fsk4_f1.set(ms.fsk4_f1)
        self._fsk4_f2.set(ms.fsk4_f2); self._fsk4_f3.set(ms.fsk4_f3)
        self._dpsk_baud.set(ms.dpsk_baud); self._dpsk_carr.set(ms.dpsk_carrier)
        self._dpsk_phases.set(ms.dpsk_phases)
        self._ofdm_fft.set(ms.ofdm_fft_size); self._ofdm_cp.set(ms.ofdm_cp_size)
        self._ofdm_fmin.set(ms.ofdm_f_min); self._ofdm_fmax.set(ms.ofdm_f_max)
        self._ofdm_pil.set(ms.ofdm_pilot_interval); self._ofdm_phases.set(ms.ofdm_phases)
        self._cp_var.set(ms.constant_power)
        self._pe_var.set(ms.pre_emphasis); self._pe_alpha.set(ms.pre_emphasis_alpha)
        self._pilot_var.set(ms.pilot_tone); self._pilot_hz.set(ms.pilot_hz)
        self._rs_var.set(ms.reed_solomon); self._rs_nsym.set(ms.rs_nsym)
        self._blk_size.set(ms.block_data_size); self._cp_hz.set(ms.constant_power_carrier_hz)
        if 'video' in blob:
            self._out_w.set(blob['video'].get('width', 256))
            self._out_h.set(blob['video'].get('height', 144))
        self._update_bitrate()


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    root = tk.Tk()
    app  = DecoderGUI(root)
    root.mainloop()
