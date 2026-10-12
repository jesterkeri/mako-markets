import numpy as np, wave, sys
SR=44100; N=int(SR*30); out=np.zeros((2,N)); rng=np.random.default_rng(3)
def tt(d): return np.arange(int(d*SR))/SR
def fnoise(d,lo,hi):
    n=rng.standard_normal(int(d*SR)); F=np.fft.rfft(n); fr=np.fft.rfftfreq(len(n),1/SR); F[(fr<lo)|(fr>hi)]=0
    o=np.fft.irfft(F,len(n)); return o/(np.abs(o).max()+1e-9)
def put(sig,t0,g=1.0,pan=0.0):
    i=int(t0*SR)
    if i<0: sig=sig[-i:]; i=0
    sig=sig[:N-i]*g; l=np.cos((pan+1)*np.pi/4)*1.414; r=np.sin((pan+1)*np.pi/4)*1.414
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

def whoosh(t0,d=0.4,g=1.0,lo=700,hi=9000):  # band-passed air, peaks on the cut
    x=tt(d)/d; s=fnoise(d,lo,hi)*np.sin(np.pi*x)**2*0.5
    put(s,t0-d*0.62,g)
def slam(t0,g=1.0):        # word landing: low thump + short noise crack
    d=0.45; t=tt(d)
    body=np.sin(2*np.pi*np.cumsum(55+140*np.exp(-t/0.03))/SR)*np.exp(-t/0.16)
    crack=fnoise(d,1500,9000)*np.exp(-t/0.008)*0.6
    put(np.tanh(1.8*body)*0.8+crack,t0-0.004,g)
def digit(t0,g=1.0):       # 15:00 digit drop: woody tick
    d=0.09; t=tt(d)
    s=np.sin(2*np.pi*(1300+500*np.exp(-t/0.005))*t)*np.exp(-t/0.018)*0.6+fnoise(d,2000,7000)*np.exp(-t/0.003)*0.3
    put(s,t0,g,pan=rng.uniform(-0.15,0.15))
def sparkle(t0,t1,n=26,g=1.0):  # particle sphere: scattered high glints
    for k in range(n):
        tk=t0+(t1-t0)*rng.random(); f=rng.choice([2637,3136,3520,4186,5274]); d=0.5; t=tt(d)
        s=(np.sin(2*np.pi*f*t)+0.3*np.sin(2*np.pi*f*2.01*t))*np.exp(-t/0.12)*0.18
        put(s,tk,g*rng.uniform(0.5,1.0),pan=rng.uniform(-0.8,0.8))
def shimmer(t0,t1,g=1.0):  # coins into the pot: rising metallic shimmer
    n=18
    for k in range(n):
        tk=t0+(t1-t0)*k/(n-1); f=2000*(1+0.6*k/n)*rng.uniform(0.97,1.03); d=0.25; t=tt(d)
        s=(np.sin(2*np.pi*f*t)+0.6*np.sin(2*np.pi*f*1.5*t))*np.exp(-t/0.05)*0.22
        put(s,tk,g*(0.6+0.4*k/n),pan=rng.uniform(-0.5,0.5))
def paper(t0,g=1.0):       # soft paper swish
    d=0.55; x=tt(d)/d; s=fnoise(d,300,4500)*(np.sin(np.pi*x)**1.5)*0.45
    s+=fnoise(d,5000,11000)*np.exp(-tt(d)/0.05)*0.1
    put(s,t0-d*0.55,g)
def pop(t0,g=1.0):         # chip pop
    d=0.12; t=tt(d)
    s=np.sin(2*np.pi*(380+900*np.exp(-t/0.01))*t)*np.exp(-t/0.04)*0.7
    put(s,t0,g)
def whoomp(t0,g=1.0):      # low swell into the URL
    d=0.9; t=tt(d); x=t/d
    s=np.sin(2*np.pi*np.cumsum(45+35*x)/SR)*np.sin(np.pi*np.clip(x*1.6,0,1))**2*np.exp(-np.clip(t-0.55,0,None)/0.25)
    s+=fnoise(d,200,1800)*np.sin(np.pi*x)**2*0.25
    put(np.tanh(1.5*s)*0.9,t0-0.5,g)

click(5.45,1.0)          # 2b: cursor taps UP
click(8.05,0.9)          # 3a: taps the 0.10 chip
lock(16.45,1.0); lock(17.2,1.0)   # 5b: START then CLOSE lock
for k in range(12): key(26.15+k*0.05,0.6)   # 8a: email typing


# --- transition sounds: one per kind of scene switch
def whip(t0,g=1.0):        # whip push: fast bright sweep travelling left to right
    d=0.32; x=tt(d)/d
    lo=fnoise(d,600,3000); hi=fnoise(d,3000,10000)
    s=(lo*(1-x)+hi*x)*np.sin(np.pi*x)**3*0.5
    i=int((t0-d*0.7)*SR)
    for ch,pan in ((0,-1),(1,1)):
        w=(1-x) if ch==0 else x
        out[ch,i:i+len(s)]+=s*w*g*1.2
def swipe(t0,g=1.0):       # slash wipe: sharp falling swipe with a metallic edge
    d=0.38; t=tt(d); x=t/d
    s=fnoise(d,2500,12000)*np.sin(np.pi*x)**2*0.45
    s+=np.sin(2*np.pi*np.cumsum(5200-3600*x)/SR)*np.sin(np.pi*x)**2*0.08
    put(s,t0-d*0.65,g)
def ratchet(t0,d=0.35,g=1.0):  # type-stack scroll: quick accelerating clicks
    n=9
    for k in range(n):
        tk=t0-d+d*(k/(n-1))**0.7; dd=0.025; tt_=tt(dd)
        s=fnoise(dd,2500,8000)*np.exp(-tt_/0.004)*0.35
        put(s,tk,g*(0.5+0.5*k/n))
def air(t0,g=1.0):         # cut into the 3D page: soft low air push
    d=0.45; x=tt(d)/d; s=fnoise(d,150,1400)*np.sin(np.pi*x)**2*0.35
    put(s,t0-d*0.6,g)
def blip(t0,g=1.0,f=1600): # cut to black / HUD: short digital blip
    d=0.07; t=tt(d); s=np.sign(np.sin(2*np.pi*f*t))*np.exp(-t/0.018)*0.12
    put(s,t0,g)
def split(t0,g=1.0):       # split screen: two short swipes, left then right
    d=0.22; x=tt(d)/d; s=fnoise(d,1500,9000)*np.sin(np.pi*x)**2*0.35
    put(s,t0-0.16,g,pan=-0.8); put(s,t0-0.05,g,pan=0.8)
def flick(t0,g=1.0):       # paper type: light page flick
    d=0.18; x=tt(d)/d; s=fnoise(d,1200,7000)*np.sin(np.pi*x)**3*0.3
    put(s,t0-d*0.5,g)
def rise(t0,g=1.0):        # sign-in card rises: soft tonal swell
    d=0.6; t=tt(d); x=t/d
    s=(np.sin(2*np.pi*440*t)+np.sin(2*np.pi*659.25*t))*np.sin(np.pi*np.clip(x,0,1))**2*0.06
    put(s,t0-0.35,g)

T=0.45  # overall transition level (quieter than before)
whip(4.0,T)                         # 1d -> 2a: whip push into the round page
air(5.0,T*0.8)                      # 2a -> 2b: macro push
split(6.0,T)                        # 2b -> 2c: UP / DOWN split screen
air(7.5,T*0.8)                      # 2c -> 3a: back into the page, chips
ratchet(8.5,0.3,T)                  # 3a -> 3b: type stack scrolls
air(9.5,T*0.7)                      # 3b -> 3c: countdown macro
air(11.0,T*0.8)                     # 3c -> 4a: chart
blip(12.0,T,1200)                   # 4a -> 4b: cut to black, 15:00
air(13.0,T*0.6)                     # 4b -> 4c: back over the chart
swipe(14.5,T*1.3)                   # 4c -> 5a: yellow slash into PRICE
blip(16.0,T,1800)                   # 5a -> 5b: HUD to the price line
blip(17.5,T*0.8,900)                # 5b -> 5c: cut to black type
air(19.0,T*0.6)                     # 5c -> 6a: pot bar (score impact carries it)
blip(21.5,T*0.8,1400)               # 6b -> 6c: fee card
paper(23.0,T*1.6)                   # 6c -> 7a: paper slash into REFUND
flick(24.5,T)                       # 7a -> 7b: paper type
rise(26.0,T)                        # 7b -> 8a: sign-in card
# 1.0 / 2.0 / 20.0 / 27.0 / 28.0 are plain cuts on the beat: the music carries them

# --- in-scene action sounds
slam(0.0,0.9); slam(3.0,1.0); slam(17.55,0.9)   # Think / Call it. / Nobody
ratchet(2.0,0.25,T*0.6)                          # 1c: 15 MINUTES stack scrolls in
for i in range(5): digit(12.08+0.07*i,0.9)       # 15:00 digits drop in
sparkle(14.6,15.9,26,0.9)                         # particle sphere
shimmer(20.15,21.2,1.0)                           # shares fly into the pot
for t0 in [27.0,27.333,27.667]: pop(t0,0.9)       # three end chips
whoomp(28.35,1.0)                                 # URL pill opens

out=np.tanh(out); peak=np.abs(out).max(); out/=peak/0.9
with wave.open(sys.argv[1],'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out.T*32767).astype(np.int16).tobytes())
print('ok')
