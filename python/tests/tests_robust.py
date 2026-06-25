import sys, os, wave
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
from cassette_modem import (ModemSettings, DecoderState, METADATA_SEQ, decode_metadata_payload,
                            modulate, frame_block, generate_preamble, add_constant_power_carrier,
                            encode_metadata_block, TRAIN_BYTES)

def enc(video, ms, vset):
    bs=ms.block_data_size; n=-(-len(video)//bs)
    stream=bytearray(TRAIN_BYTES)+encode_metadata_block(vset,ms)
    for i in range(n): stream+=frame_block(video[i*bs:(i+1)*bs].ljust(bs,b"\x00"),i,ms)
    audio=np.concatenate([generate_preamble(ms),modulate(bytes(stream),ms),np.zeros(int(ms.sample_rate*0.5))])
    if ms.constant_power: audio=add_constant_power_carrier(audio,ms)
    peak=np.max(np.abs(audio)); return (audio/peak*0.95).astype(np.float32)

def dec(audio, ms, chunk):
    ds=DecoderState(ms); data={}
    for i in range(0,len(audio),chunk):
        for seq,pl in ds.feed_audio(audio[i:i+chunk]):
            if seq!=METADATA_SEQ: data[seq]=pl
    if not data: return b""
    out=bytearray()
    for i in range(max(data)+1): out+=data.get(i,b"\x00"*ms.block_data_size)
    return bytes(out)

fails=0; tests=0
for method in ["fsk","fsk4","dpsk","ofdm"]:
    for cp,pe in [(False,False),(False,True),(True,False)]:
        for size in [1000, 7777, 20000]:
            for chunk in [2048, 4096, 5000]:
                for seed in [1,2]:
                    tests+=1
                    ms=ModemSettings(method=method,constant_power=cp,pre_emphasis=pe,reed_solomon=True)
                    rng=np.random.RandomState(seed); video=bytes(rng.randint(0,256,size,dtype=np.uint8))
                    audio=enc(video,ms,dict(width=256,height=144,fps=15))
                    recon=dec(audio,ms,chunk)[:size]
                    if recon!=video:
                        fails+=1
                        if fails<=12:
                            nbad=sum(1 for a,b in zip(recon,video) if a!=b)
                            print(f"FAIL {method} cp{int(cp)}pe{int(pe)} size{size} chunk{chunk} seed{seed}: len{len(recon)} baddiff{nbad}")
print(f"\n{tests-fails}/{tests} passed  ({fails} failed)")
