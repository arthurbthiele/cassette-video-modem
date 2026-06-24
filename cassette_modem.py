#!/usr/bin/env python3
"""
cassette_modem.py — Core DSP modem library.
Shared by encoder and decoder. No GUI dependencies.
"""
from __future__ import annotations
import struct, json, logging, time
from dataclasses import dataclass, asdict, fields as dc_fields
from typing import List, Optional, Tuple, Dict
import numpy as np
from scipy import signal as spsg
from scipy.signal import hilbert

try:
    import reedsolo as _rs_lib
    HAS_RS = True
except ImportError:
    HAS_RS = False

logger = logging.getLogger(__name__)

# ── Protocol constants ────────────────────────────────────────────────────────
SYNC_MAGIC       = bytes([0xCA, 0x55, 0xE7, 0x7E])
PROTOCOL_VERSION = 1
METADATA_SEQ     = 0xFFFFFFFE   # reserved seq number for metadata block
HEADER_FMT       = ">4sBBIH"    # sync(4)|ver(1)|flags(1)|seq(4)|dlen(2)
HEADER_SIZE      = struct.calcsize(HEADER_FMT)   # 12 bytes
CRC_SIZE         = 4
FLAG_RS          = 0x01

_GRAY_DEC: Dict[int, List[int]] = {2:[0,1], 4:[0,1,3,2], 8:[0,1,3,2,6,7,5,4]}
_GRAY_ENC: Dict[int,Dict[int,int]] = {n:{v:i for i,v in enumerate(t)} for n,t in _GRAY_DEC.items()}

try:
    import crcmod as _crcmod
    _CRC_FN = _crcmod.predefined.mkCrcFun("crc-32")
except ImportError:
    import binascii as _ba
    _CRC_FN = lambda d: _ba.crc32(bytes(d)) & 0xFFFFFFFF


# ── Settings dataclass ────────────────────────────────────────────────────────
@dataclass
class ModemSettings:
    sample_rate: int   = 44100
    method:      str   = "ofdm"   # fsk | fsk4 | dpsk | ofdm

    # FSK  (rule: f0 >= baud*1.5 for >=1.5 cycles/symbol)
    fsk_baud: int = 1200
    fsk_f0:   int = 1800
    fsk_f1:   int = 3600

    # 4-FSK
    fsk4_baud: int = 1200
    fsk4_f0:   int = 1200
    fsk4_f1:   int = 2400
    fsk4_f2:   int = 3600
    fsk4_f3:   int = 4800

    # DPSK
    dpsk_baud:    int = 1500
    dpsk_carrier: int = 3000
    dpsk_phases:  int = 4   # 2|4|8

    # OFDM
    ofdm_fft_size:       int = 512
    ofdm_cp_size:        int = 64
    ofdm_f_min:          int = 500
    ofdm_f_max:          int = 6000
    ofdm_pilot_interval: int = 8
    ofdm_phases:         int = 4   # 2|4|8

    # AGC
    constant_power:            bool  = False
    constant_power_carrier_hz: int   = 300
    constant_power_target_rms: float = 0.70

    # Pre-emphasis
    pre_emphasis:       bool  = False
    pre_emphasis_alpha: float = 0.85

    # Reed-Solomon
    reed_solomon: bool = True
    rs_nsym:      int  = 16

    # Framing
    block_data_size: int = 256
    preamble_ms:     int = 400

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)

    @classmethod
    def from_json(cls, s: str) -> "ModemSettings":
        d  = json.loads(s)
        ok = {f.name for f in dc_fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in ok})


# ── CRC / RS ─────────────────────────────────────────────────────────────────
def _crc32(data: bytes) -> int:
    return _CRC_FN(data)

def _rs_encode(data: bytes, nsym: int) -> bytes:
    return bytes(_rs_lib.RSCodec(nsym).encode(data))

def _rs_decode(data: bytes, nsym: int) -> bytes:
    dec, _, _ = _rs_lib.RSCodec(nsym).decode(data)
    return bytes(dec)


# ── Framing ───────────────────────────────────────────────────────────────────
def frame_block(payload: bytes, seq: int, s: ModemSettings) -> bytes:
    use_rs = s.reed_solomon and HAS_RS
    flags  = FLAG_RS if use_rs else 0
    hdr    = struct.pack(HEADER_FMT, SYNC_MAGIC, PROTOCOL_VERSION, flags,
                         seq & 0xFFFFFFFF, len(payload))
    body   = hdr + payload + struct.pack(">I", _crc32(hdr + payload))
    if use_rs:
        body = _rs_encode(body, s.rs_nsym)
    return body

def deframe_block(raw: bytes, s: ModemSettings) -> Optional[Tuple[int, bytes]]:
    try:
        use_rs = s.reed_solomon and HAS_RS
        if use_rs:
            try:
                raw = _rs_decode(raw, s.rs_nsym)
            except Exception:
                return None
        if len(raw) < HEADER_SIZE + CRC_SIZE:
            return None
        sync, ver, flags, seq, dlen = struct.unpack(HEADER_FMT, raw[:HEADER_SIZE])
        if sync != SYNC_MAGIC or ver != PROTOCOL_VERSION:
            return None
        total = HEADER_SIZE + dlen + CRC_SIZE
        if len(raw) < total:
            return None
        if _crc32(raw[:HEADER_SIZE + dlen]) != struct.unpack(">I", raw[HEADER_SIZE+dlen:total])[0]:
            return None
        return seq, raw[HEADER_SIZE:HEADER_SIZE+dlen]
    except Exception as e:
        logger.debug("deframe: %s", e)
        return None

def block_wire_size(s: ModemSettings) -> int:
    import math
    body = HEADER_SIZE + s.block_data_size + CRC_SIZE
    if s.reed_solomon and HAS_RS:
        # reedsolo splits data into chunks of (255-nsym) bytes; each chunk adds nsym parity
        nchunks = math.ceil(body / (255 - s.rs_nsym))
        rs_pad  = nchunks * s.rs_nsym
    else:
        rs_pad = 0
    return body + rs_pad


# ── Metadata block ────────────────────────────────────────────────────────────
def encode_metadata_block(vset: dict, ms: ModemSettings) -> bytes:
    """First block in every encoded file — carries video params and modem config."""
    payload = json.dumps({
        "_type":    "cassette-meta",
        "_version": 2,
        "video":    vset,
        "modem":    json.loads(ms.to_json()),
    }, separators=(",", ":")).encode()
    return frame_block(payload, METADATA_SEQ, ms)

def decode_metadata_payload(payload: bytes) -> Optional[dict]:
    try:
        d = json.loads(payload.decode())
        return d if d.get("_type") == "cassette-meta" else None
    except Exception:
        return None


# ── Bit helpers ───────────────────────────────────────────────────────────────
def bytes_to_bits(data: bytes) -> List[int]:
    bits = []
    for byte in data:
        for i in range(7, -1, -1):
            bits.append((byte >> i) & 1)
    return bits

def bits_to_bytes(bits: List[int]) -> bytes:
    bits = list(bits)   # copy — never mutate caller list
    while len(bits) % 8:
        bits.append(0)
    out = bytearray()
    for i in range(0, len(bits), 8):
        b = 0
        for j in range(8):
            b = (b << 1) | bits[i+j]
        out.append(b)
    return bytes(out)


# ── Signal utilities ──────────────────────────────────────────────────────────
def goertzel(samples: np.ndarray, freq: float, sr: int) -> float:
    N = len(samples)
    if N == 0: return 0.0
    omega = 2.0 * np.pi * freq * N / sr
    coeff = 2.0 * np.cos(omega / N)
    s1 = s2 = 0.0
    for x in samples:
        s0 = float(x) + coeff*s1 - s2
        s2, s1 = s1, s0
    return s2*s2 + s1*s1 - coeff*s1*s2

def apply_pre_emphasis(audio: np.ndarray, alpha: float) -> np.ndarray:
    return spsg.lfilter([1.0, -alpha], [1.0], audio)

def apply_de_emphasis(audio: np.ndarray, alpha: float) -> np.ndarray:
    return spsg.lfilter([1.0], [1.0, -alpha], audio)

def add_constant_power_carrier(audio: np.ndarray, s: ModemSettings) -> np.ndarray:
    """
    Mix a variable-amplitude anchor carrier so total RMS stays constant.
    When the data signal is louder, carrier amplitude drops to compensate.
    AGC locks once and never hunts. Also preserves amplitude encoding.
    """
    sr     = s.sample_rate
    target = s.constant_power_target_rms
    t      = np.arange(len(audio)) / sr
    carrier = np.sin(2.0 * np.pi * s.constant_power_carrier_hz * t)
    win_n   = max(1, int(0.02 * sr))
    dp      = np.convolve(audio**2, np.ones(win_n)/win_n, mode="same")
    ca      = np.sqrt(np.maximum(0.0, target**2 - dp))
    mixed   = audio + ca * carrier
    rms = np.sqrt(np.mean(mixed**2))
    if rms > 1e-9:
        mixed *= target / rms
    return np.clip(mixed, -1.0, 1.0)


# ── FSK (2-tone, phase-continuous) ────────────────────────────────────────────
def modulate_fsk(data: bytes, s: ModemSettings) -> np.ndarray:
    bits = bytes_to_bits(data)
    sr, sps = s.sample_rate, s.sample_rate / s.fsk_baud
    f0, f1  = s.fsk_f0, s.fsk_f1
    phase   = 0.0
    chunks  = []
    for bit in bits:
        freq = f1 if bit else f0
        n    = int(sps)
        chunks.append(np.sin(2.0*np.pi*freq*np.arange(n)/sr + phase))
        phase = (phase + 2.0*np.pi*freq*n/sr) % (2.0*np.pi)
    return np.concatenate(chunks)

def demodulate_fsk(audio: np.ndarray, s: ModemSettings) -> List[int]:
    sr      = s.sample_rate
    sps     = int(sr / s.fsk_baud)
    f0, f1  = float(s.fsk_f0), float(s.fsk_f1)
    nyq     = sr / 2.0
    bw      = abs(f1 - f0) * 0.45

    def _bp_env(fc):
        lo = max(0.005, (fc - bw) / nyq)
        hi = min(0.995, (fc + bw) / nyq)
        if hi - lo < 0.01: return None
        b, a = spsg.butter(1, [lo, hi], btype="band")
        return np.abs(hilbert(spsg.lfilter(b, a, audio)))

    env0, env1 = _bp_env(f0), _bp_env(f1)
    nsym = len(audio) // sps
    bits = []
    if env0 is not None and env1 is not None:
        for i in range(nsym):
            c = min(i*sps + sps//2, len(env0)-1)
            bits.append(1 if env1[c] > env0[c] else 0)
    else:
        for i in range(nsym):
            chunk = audio[i*sps:(i+1)*sps]
            bits.append(1 if goertzel(chunk,f1,sr) > goertzel(chunk,f0,sr) else 0)
    return bits


# ── 4-FSK (4-tone, 2 bits/symbol) ────────────────────────────────────────────
def modulate_fsk4(data: bytes, s: ModemSettings) -> np.ndarray:
    bits  = bytes_to_bits(data)
    if len(bits) % 2: bits.append(0)
    freqs = [s.fsk4_f0, s.fsk4_f1, s.fsk4_f2, s.fsk4_f3]
    sr, sps = s.sample_rate, s.sample_rate / s.fsk4_baud
    phase = 0.0
    chunks = []
    for i in range(0, len(bits), 2):
        sym  = (bits[i] << 1) | bits[i+1]
        freq = freqs[sym]
        n    = int(sps)
        chunks.append(np.sin(2.0*np.pi*freq*np.arange(n)/sr + phase))
        phase = (phase + 2.0*np.pi*freq*n/sr) % (2.0*np.pi)
    return np.concatenate(chunks)

def demodulate_fsk4(audio: np.ndarray, s: ModemSettings) -> List[int]:
    freqs = [float(s.fsk4_f0), float(s.fsk4_f1), float(s.fsk4_f2), float(s.fsk4_f3)]
    sr    = s.sample_rate
    sps   = int(sr / s.fsk4_baud)
    nyq   = sr / 2.0
    bw    = (freqs[-1]-freqs[0]) / (len(freqs)-1) * 0.45
    envs, ok = [], True
    for fc in freqs:
        lo = max(0.005, (fc-bw)/nyq); hi = min(0.995, (fc+bw)/nyq)
        if hi - lo < 0.01: ok = False; break
        b, a = spsg.butter(1, [lo, hi], btype="band")
        envs.append(np.abs(hilbert(spsg.lfilter(b, a, audio))))
    nsym = len(audio) // sps
    bits = []
    if ok:
        for i in range(nsym):
            c   = min(i*sps + sps//2, len(envs[0])-1)
            sym = int(np.argmax([e[c] for e in envs]))
            bits.append((sym>>1)&1); bits.append(sym&1)
    else:
        for i in range(nsym):
            chunk = audio[i*sps:(i+1)*sps]
            powers = [goertzel(chunk,f,sr) for f in freqs]
            sym    = int(np.argmax(powers))
            bits.append((sym>>1)&1); bits.append(sym&1)
    return bits


# ── DPSK ─────────────────────────────────────────────────────────────────────
def modulate_dpsk(data: bytes, s: ModemSettings) -> np.ndarray:
    ph_n = s.dpsk_phases; bps = int(np.log2(ph_n))
    enc  = _GRAY_ENC[ph_n]; step = 2.0*np.pi/ph_n
    bits = bytes_to_bits(data)
    while len(bits) % bps: bits.append(0)
    sr, sps = s.sample_rate, int(s.sample_rate/s.dpsk_baud)
    t_sym = np.arange(sps) / sr
    phase = 0.0; chunks = []
    for i in range(0, len(bits), bps):
        val = 0
        for b in bits[i:i+bps]: val = (val<<1)|b
        phase = (phase + enc[val]*step) % (2.0*np.pi)
        chunks.append(np.cos(2.0*np.pi*s.dpsk_carrier*t_sym + phase))
    return np.concatenate(chunks)

def demodulate_dpsk(audio: np.ndarray, s: ModemSettings) -> List[int]:
    ph_n = s.dpsk_phases; bps = int(np.log2(ph_n))
    dec  = _GRAY_DEC[ph_n]; step = 2.0*np.pi/ph_n
    sps  = int(s.sample_rate/s.dpsk_baud)
    nsym = len(audio) // sps
    bits = []; prev = np.zeros(sps, dtype=complex)
    for i in range(nsym):
        chunk = audio[i*sps:(i+1)*sps]
        curr  = hilbert(chunk)
        if np.abs(prev).mean() > 1e-6:
            pd  = np.angle(np.mean(curr*np.conj(prev))) % (2.0*np.pi)
            sym = dec[int(round(pd/step)) % ph_n]
        else:
            sym = 0
        for j in range(bps-1, -1, -1): bits.append((sym>>j)&1)
        prev = curr
    return bits


# ── OFDM ─────────────────────────────────────────────────────────────────────
def _ofdm_carriers(s: ModemSettings) -> Tuple[List[int], List[int]]:
    res  = s.sample_rate / s.ofdm_fft_size
    k_lo = max(1, int(np.ceil(s.ofdm_f_min/res)))
    k_hi = min(s.ofdm_fft_size//2-1, int(np.floor(s.ofdm_f_max/res)))
    data, pilots = [], []
    for k in range(k_lo, k_hi+1):
        (pilots if (k-k_lo) % s.ofdm_pilot_interval == 0 else data).append(k)
    return data, pilots

def modulate_ofdm(data: bytes, s: ModemSettings) -> np.ndarray:
    N, CP       = s.ofdm_fft_size, s.ofdm_cp_size
    ph_n, bps   = s.ofdm_phases, int(np.log2(s.ofdm_phases))
    step        = 2.0*np.pi/ph_n; enc = _GRAY_ENC[ph_n]
    dc, pilots  = _ofdm_carriers(s)
    bits        = bytes_to_bits(data)
    bposs       = len(dc)*bps
    n_syms      = max(1, -(-len(bits)//bposs))
    while len(bits) < n_syms*bposs: bits.append(0)
    c_phase = np.zeros(N//2+1); chunks = []
    for sym_i in range(n_syms):
        fd = np.zeros(N, dtype=complex)
        for k in pilots:
            fd[k] = np.exp(1j*c_phase[k]); fd[N-k] = np.conj(fd[k])
        base = sym_i*bposs
        for ci, k in enumerate(dc):
            b = bits[base+ci*bps:base+(ci+1)*bps]; val = 0
            for bit in b: val = (val<<1)|bit
            c_phase[k] = (c_phase[k]+enc[val]*step)%(2.0*np.pi)
            fd[k] = np.exp(1j*c_phase[k]); fd[N-k] = np.conj(fd[k])
        td = np.real(np.fft.ifft(fd))
        mx = np.max(np.abs(td))
        if mx > 0: td = td/mx*0.90
        chunks.append(np.concatenate([td[-CP:], td]))
    return np.concatenate(chunks)

def demodulate_ofdm(audio: np.ndarray, s: ModemSettings) -> List[int]:
    N, CP = s.ofdm_fft_size, s.ofdm_cp_size; SL = N+CP
    ph_n, bps = s.ofdm_phases, int(np.log2(s.ofdm_phases))
    step = 2.0*np.pi/ph_n; dec = _GRAY_DEC[ph_n]
    dc, pilots = _ofdm_carriers(s)
    n_syms = len(audio)//SL; prev = np.zeros(N//2+1); bits = []
    for sym_i in range(n_syms):
        chunk = audio[sym_i*SL+CP:sym_i*SL+SL]
        fd    = np.fft.fft(chunk)
        errors = []
        for k in pilots:
            curr = np.angle(fd[k]); diff = (curr-prev[k])%(2.0*np.pi)
            if diff > np.pi: diff -= 2.0*np.pi
            errors.append(diff); prev[k] = curr
        corr = float(np.mean(errors)) if errors else 0.0
        for k in dc:
            curr = np.angle(fd[k])
            diff = (curr-prev[k]-corr)%(2.0*np.pi)
            sym  = dec[int(round(diff/step))%ph_n]
            for j in range(bps-1,-1,-1): bits.append((sym>>j)&1)
            prev[k] = curr-corr
    return bits


# ── Preamble ──────────────────────────────────────────────────────────────────
def generate_preamble(s: ModemSettings) -> np.ndarray:
    n    = int(s.sample_rate * s.preamble_ms / 1000)
    t    = np.arange(n) / s.sample_rate
    tone = 0.85 * np.sin(2.0*np.pi*s.constant_power_carrier_hz*t)
    tb   = bytes([0xAA, 0x55]*4)
    if   s.method == "fsk":  sig = modulate_fsk(tb, s)
    elif s.method == "fsk4": sig = modulate_fsk4(tb, s)
    elif s.method == "dpsk": sig = modulate_dpsk(tb, s)
    else:                    sig = modulate_ofdm(tb, s)
    return np.concatenate([tone, sig])


# ── Top-level modulate / demodulate ──────────────────────────────────────────
def modulate(data: bytes, s: ModemSettings) -> np.ndarray:
    if   s.method == "fsk":  audio = modulate_fsk(data, s)
    elif s.method == "fsk4": audio = modulate_fsk4(data, s)
    elif s.method == "dpsk": audio = modulate_dpsk(data, s)
    elif s.method == "ofdm": audio = modulate_ofdm(data, s)
    else: raise ValueError(f"Unknown method: {s.method}")
    if s.pre_emphasis:
        audio = apply_pre_emphasis(audio, s.pre_emphasis_alpha)
    return audio

def _demod_raw(audio: np.ndarray, s: ModemSettings) -> List[int]:
    if   s.method == "fsk":  return demodulate_fsk(audio, s)
    elif s.method == "fsk4": return demodulate_fsk4(audio, s)
    elif s.method == "dpsk": return demodulate_dpsk(audio, s)
    elif s.method == "ofdm": return demodulate_ofdm(audio, s)
    else: raise ValueError(f"Unknown method: {s.method}")

def demodulate(audio: np.ndarray, s: ModemSettings) -> bytes:
    # Strip carrier BEFORE de-emphasis (reverse of encode order)
    if s.constant_power:
        cut = min(0.95, s.constant_power_carrier_hz * 2.0 / (s.sample_rate / 2.0))
        if cut > 0.002:
            b, a = spsg.butter(1, cut, btype="high")
            audio = spsg.lfilter(b, a, audio)
    if s.pre_emphasis:
        audio = apply_de_emphasis(audio, s.pre_emphasis_alpha)
    return bits_to_bytes(_demod_raw(audio, s))


# ── Bitrate calculator ────────────────────────────────────────────────────────
def calculate_bitrate(s: ModemSettings) -> dict:
    if   s.method == "fsk":  raw = s.fsk_baud
    elif s.method == "fsk4": raw = s.fsk4_baud * 2
    elif s.method == "dpsk": raw = int(s.dpsk_baud * np.log2(s.dpsk_phases))
    elif s.method == "ofdm":
        dc, _ = _ofdm_carriers(s)
        raw   = int(len(dc) * np.log2(s.ofdm_phases) * s.sample_rate / (s.ofdm_fft_size+s.ofdm_cp_size))
    else: raw = 0
    eff = s.block_data_size / block_wire_size(s)
    net = int(raw * eff)
    return {"raw_bps": raw, "net_bps": net,
            "net_kBps": round(net/8192, 3),
            "efficiency_pct": round(eff*100,1),
            "overhead_bytes": block_wire_size(s)-s.block_data_size}


# ── Streaming decoder state ───────────────────────────────────────────────────
class DecoderState:
    """
    Stateful streaming decoder. Call feed_audio() with real-time chunks.
    Preserves IIR filter state across calls (no boundary artifacts).
    Returns (seq, payload) pairs for each valid decoded block.
    """
    PAUSE_THRESHOLD: float = 0.008
    PAUSE_TIMEOUT:   float = 0.30

    def __init__(self, s: ModemSettings):
        self.s         = s
        self._buf      = bytearray()
        self._partial  = np.array([], dtype=np.float32)
        self._last_sig = 0.0
        self.is_paused = False
        self._seen     : dict = {}
        self.next_seq  = 0
        self._hp_b = self._hp_a = self._hp_zi = None
        self._de_b = self._de_a = self._de_zi = None
        self._init_filters()
        self._sps = self._calc_sps()

    def _calc_sps(self) -> int:
        s = self.s
        if s.method == "fsk":  return max(1, int(s.sample_rate/s.fsk_baud))
        if s.method == "fsk4": return max(1, int(s.sample_rate/s.fsk4_baud))
        if s.method == "dpsk": return max(1, int(s.sample_rate/s.dpsk_baud))
        return s.ofdm_fft_size + s.ofdm_cp_size

    def _init_filters(self):
        s = self.s
        if s.constant_power:
            cut = min(0.95, s.constant_power_carrier_hz * 2.0 / (s.sample_rate / 2.0))
            if cut > 0.002:
                b, a = spsg.butter(1, cut, btype="high")
                self._hp_b, self._hp_a = b, a
                self._hp_zi = spsg.lfilter_zi(b, a) * 0.0
        if s.pre_emphasis:
            b, a = [1.0], [1.0, -s.pre_emphasis_alpha]
            self._de_b, self._de_a = b, a
            self._de_zi = spsg.lfilter_zi(b, a) * 0.0

    def _preprocess(self, audio: np.ndarray) -> np.ndarray:
        if self._hp_zi is not None:
            audio, self._hp_zi = spsg.lfilter(self._hp_b, self._hp_a, audio, zi=self._hp_zi)
        if self._de_zi is not None:
            audio, self._de_zi = spsg.lfilter(self._de_b, self._de_a, audio, zi=self._de_zi)
        return audio

    def feed_audio(self, chunk: np.ndarray) -> List[Tuple[int, bytes]]:
        rms = float(np.sqrt(np.mean(chunk**2)))
        now = time.monotonic()
        if rms > self.PAUSE_THRESHOLD:
            self._last_sig = now; self.is_paused = False
        elif now - self._last_sig > self.PAUSE_TIMEOUT:
            self.is_paused = True; return []

        work = np.concatenate([self._partial, chunk.astype(np.float32)])
        nc   = (len(work)//self._sps)*self._sps
        self._partial = work[nc:]
        if nc == 0: return []

        self._buf.extend(bits_to_bytes(_demod_raw(self._preprocess(work[:nc]), self.s)))
        return self._extract_blocks()

    def _extract_blocks(self) -> List[Tuple[int, bytes]]:
        found = []; buf = bytes(self._buf); pos = 0; consumed = 0
        needed = block_wire_size(self.s)
        while True:
            idx = buf.find(SYNC_MAGIC, pos)
            if idx == -1:
                consumed = max(0, len(buf)-len(SYNC_MAGIC)+1); break
            if idx + needed > len(buf):
                consumed = idx; break
            result = deframe_block(buf[idx:idx+needed], self.s)
            if result is not None:
                seq, payload = result
                if seq not in self._seen:
                    self._seen[seq] = True; found.append((seq, payload))
                consumed = idx+needed; pos = consumed
            else:
                pos = idx+1
        self._buf = bytearray(buf[consumed:])
        return found
