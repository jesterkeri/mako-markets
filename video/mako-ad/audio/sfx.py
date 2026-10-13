# Sound effects for the 60 s Mako Market ad. Transition sounds only on seams that earn one, each a different sound.
import numpy as np, wave, sys
SR=44100; N=int(SR*60); out=np.zeros((2,N)); rng=np.random.default_rng(3)
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
    s=np.sin(2*np.pi*(1300*(0.85+0.3*g)+500*np.exp(-t/0.005))*t)*np.exp(-t/0.018)*0.6+fnoise(d,2000,7000)*np.exp(-t/0.003)*0.3
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
def whoomp(t0,g=1.0):      # low swell into the URL
    d=0.9; t=tt(d); x=t/d
    s=np.sin(2*np.pi*np.cumsum(45+35*x)/SR)*np.sin(np.pi*np.clip(x*1.6,0,1))**2*np.exp(-np.clip(t-0.55,0,None)/0.25)
    s+=fnoise(d,200,1800)*np.sin(np.pi*x)**2*0.25
    put(np.tanh(1.5*s)*0.9,t0-0.5,g)
def glitch(t0,g=1.0):      # glitch slam: bitcrushed digital crunch, stuttered
    d=0.22; t=tt(d)
    s=np.sign(np.sin(2*np.pi*(180+2400*rng.random())*t))*0.15+fnoise(d,800,9000)*0.35
    gate=(np.floor(t/0.018)%2==0)*np.exp(-t/0.09)
    put(np.round(s*gate*8)/8,t0-0.03,g,pan=rng.uniform(-0.3,0.3))
def shutter(t0,g=1.0):     # mechanical shutter: two dry clacks
    for k,dt in enumerate((-0.06,0.0)):
        d=0.05; t=tt(d); s=fnoise(d,900,6000)*np.exp(-t/0.006)*0.6+np.sin(2*np.pi*190*t)*np.exp(-t/0.012)*0.4
        put(s,t0+dt,g*(0.7+0.3*k))
def tape(t0,g=1.0):        # VHS: short warbling tape wobble
    d=0.4; t=tt(d); x=t/d
    s=np.sin(2*np.pi*np.cumsum(330*(1+0.08*np.sin(2*np.pi*11*t))*(1-0.5*x))/SR)*np.sin(np.pi*x)**2*0.14
    s+=fnoise(d,2000,7000)*np.sin(np.pi*x)**2*0.12
    put(s,t0-d*0.5,g)
def flap(t0,dur=0.35,g=1.0,dens=40):  # split-flap clatter: many tiny clacks, randomised each time
    n=int(dens*dur)
    for k in range(n):
        tk=t0+dur*rng.random()**1.3; d=0.018; t=tt(d)
        s=fnoise(d,2500,9000)*np.exp(-t/0.0025)*0.25+np.sin(2*np.pi*rng.uniform(700,1400)*t)*np.exp(-t/0.004)*0.12
        put(s,tk,g*rng.uniform(0.4,1.0),pan=rng.uniform(-0.6,0.6))
def glint(t0,g=1.0):       # short bright chime (cross-warp onto the board)
    d=0.6; t=tt(d)
    s=sum(np.sin(2*np.pi*f*t)*np.exp(-t/0.15)*a for f,a in ((1318.5,.16),(1975.5,.1),(2637,.06)))
    put(s,t0,g,pan=0.2)

T=0.45
# --- seam sounds (each different; the other cuts ride the music)
glitch(3.5,T*1.1)     # 02>03 glitch slam
air(7.0,T*0.9)        # 04>05 zoom through
shutter(11.5,T*1.2)   # 10>11 shutter
flick(15.0,T*1.1)     # 12>13 3D card flip
ratchet(21.0,0.3,T)   # 16>17 staggered blocks
paper(22.0,T*1.5)     # 17>18 colour dip to paper
whip(28.0,T)          # 21>22 whip pan
split(32.0,T)         # 23>24 blinds
tape(36.5,T*1.2)      # 26>27 VHS
blip(46.0,T,1500)     # 31>32 clock wipe
swipe(49.0,T*1.1)     # 33>34 zoom out
rise(54.0,T*1.2)      # 36>37 flash through white
glint(56.0,T*1.1)     # 37>38 cross-warp
# --- in-scene actions
click(1.0,1.0)                    # s01 cursor presses YES
click(28.55,0.85)                 # s22 presses Confirm
digit(48.8,0.8)                   # s33 15:00 ticks to 14:59
for t0,dd,gg in [(3.5,0.4,0.55),(7.0,0.3,0.5),(11.5,0.5,0.6),(21.0,0.35,0.45),(32.0,0.45,0.5),(46.0,0.6,0.55),(56.0,0.5,0.6)]:
    flap(t0+0.02,dd,gg)           # board flips: clatter only on some, never identical
sparkle(51.2,52.2,10,0.5)         # s35 the top row lands on the board
whoomp(58.3,0.9)                  # end card swell

out=np.tanh(out); peak=np.abs(out).max(); out/=peak/0.9
with wave.open(sys.argv[1],'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out.T*32767).astype(np.int16).tobytes())
print('ok')
