import sys, os, wave
sys.path.insert(0, os.path.expanduser("~/cassette-project"))
import numpy as np
from cassette_modem import (ModemSettings, DecoderState, decode_metadata_payload, METADATA_SEQ,
                            modulate, frame_block, generate_preamble, add_constant_power_carrier,
                            encode_metadata_block, TRAIN_BYTES)

OUT = "/private/tmp/claude-501/-Users-arthurthiele/e991caab-3fb8-4008-9690-8f783c8395e3/scratchpad/_t.wav"

def encode_to_wav(video_bytes, output_path, ms, vset=None, progress_cb=None):
    """Mirror of cassette_encoder.encode_to_wav (modem-only, no tkinter)."""
    sr = ms.sample_rate
    bs = ms.block_data_size
    n_blocks = -(-len(video_bytes)//bs)
    stream = bytearray(TRAIN_BYTES)
    if vset is not None:
        stream += encode_metadata_block(vset, ms)
    for i in range(n_blocks):
        stream += frame_block(video_bytes[i*bs:(i+1)*bs].ljust(bs, b"\x00"), i, ms)
    data_audio = modulate(bytes(stream), ms)
    tone = generate_preamble(ms)
    audio = np.concatenate([tone, data_audio, np.zeros(int(sr*0.5))])
    if ms.constant_power:
        audio = add_constant_power_carrier(audio, ms)
    peak = np.max(np.abs(audio))
    if peak>0: audio = audio/peak*0.95
    pcm = (audio*32767).astype(np.int16)
    with wave.open(output_path,'w') as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())

def reassemble(blocks, block_size):
    """Mimic decoder: order data blocks by seq, concat payloads."""
    data = {}
    meta = None
    for seq, pl in blocks:
        if seq == METADATA_SEQ:
            meta = decode_metadata_payload(pl)
        else:
            data[seq] = pl
    if not data: return b"", meta
    out = bytearray()
    for i in range(max(data)+1):
        out += data.get(i, b"\x00"*block_size)
    return bytes(out), meta

def e2e(method, cp, pe, rs, nbytes=4000, chunk=4096):
    s = ModemSettings(method=method, constant_power=cp, pre_emphasis=pe, reed_solomon=rs)
    rng = np.random.RandomState(42)
    video = bytes(rng.randint(0,256,nbytes,dtype=np.uint8))
    vset = dict(width=256, height=144, fps=15, codec="libx265")
    encode_to_wav(video, OUT, s, vset=vset)
    # decode like the GUI: stream WAV chunks through DecoderState
    with wave.open(OUT) as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    audio = (np.frombuffer(raw, np.int16).astype(np.float32)/32768.0)
    s.sample_rate = sr
    ds = DecoderState(s)
    blocks=[]
    for i in range(0,len(audio),chunk):
        blocks += ds.feed_audio(audio[i:i+chunk])
    recon, meta = reassemble(blocks, s.block_data_size)
    recon = recon[:nbytes]
    ok = recon == video
    metok = meta is not None and meta.get("video",{}).get("fps")==15
    print(f"{method:5s} cp={int(cp)} pe={int(pe)} rs={int(rs)}: bytes={'OK' if ok else 'FAIL'} ({len(recon)}/{nbytes})  meta={'OK' if metok else 'MISS'}")
    return ok and metok

for label,cp,pe in [("clean cp0/pe0",False,False),("pre_emphasis only",False,True),
                     ("constant_power only",True,False),("cp + pe",True,True)]:
    print(f"--- {label} ---")
    for m in ["fsk","fsk4","dpsk","ofdm"]:
        e2e(m, cp, pe, True)
