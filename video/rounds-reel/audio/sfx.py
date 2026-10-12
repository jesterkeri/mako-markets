import numpy as np, wave, sys
SR=44100; N=int(SR*30); out=np.zeros((2,N)); rng=np.random.default_rng(3)
def tt(d): return np.arange(int(d*SR))/SR
def fnoise(d,lo,hi):
    n=rng.standard_normal(int(d*SR)); F=np.fft.rfft(n); fr=np.fft.rfftfreq(len(n),1/SR); F[(fr<lo)|(fr>hi)]=0
    o=np.fft.irfft(F,len(n)); return o/(np.abs(o).max()+1e-9)
def put(sig,t0,g=1.0,pan=0.0):
    i=int(t0*SR); sig=sig[:N-i]*g; l=np.cos((pan+1)*np.pi/4)*1.414; r=np.sin((pan+1)*np.pi/4)*1.414
    out[0,i:i+len(sig)]+=sig*l; out[1,i:i+len(sig)]+=sig*r
def click(t0,g=1.0):   # UI tap: short body thump + bright tick
    d=0.08; t=tt(d)
    s=np.sin(2*np.pi*(900+1200*np.exp(-t/0.004))*t)*np.exp(-t/0.012)*0.6 + fnoise(d,3000,9000)*np.exp(-t/0.003)*0.5
    put(s,t0-0.002,g)
def lock(t0,g=1.0):    # lock-on snap: two quick ticks + metallic ring
    d=0.35; t=tt(d)
    ring=(np.sin(2*np.pi*1760*t)+0.5*np.sin(2*np.pi*2637*t))*np.exp(-t/0.09)*0.25
    s=ring+fnoise(d,2500,12000)*np.exp(-t/0.004)*0.6
    put(s,t0-0.03,g*0.8); put(fnoise(0.03,3000,12000)*np.exp(-tt(0.03)/0.003)*0.5,t0,g)
def key(t0,g=1.0):
    d=0.05; t=tt(d); s=fnoise(d,1800,8000)*np.exp(-t/0.006)*0.5+np.sin(2*np.pi*420*t)*np.exp(-t/0.01)*0.3
    put(s,t0,g,pan=rng.uniform(-0.2,0.2))
click(5.45,1.0)          # 2b: cursor taps UP
click(8.05,0.9)          # 3a: taps the 0.10 chip
lock(16.45,1.0); lock(17.2,1.0)   # 5b: START then CLOSE lock
for k in range(12): key(26.15+k*0.05,0.6)   # 8a: email typing
out=np.tanh(out); peak=np.abs(out).max(); out/=peak/0.9
with wave.open(sys.argv[1],'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out.T*32767).astype(np.int16).tobytes())
print('ok')
