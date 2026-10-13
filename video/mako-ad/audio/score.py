# Original 60 s score for the Mako Market ad. 120 BPM, A minor.
# Structure follows the approved shot list (chapter times in seconds).
import numpy as np, wave, sys

SR = 44100
BPM = 120
BEAT = 60 / BPM
DUR = 60.0
N = int(SR * DUR)
rng = np.random.default_rng(7)

L = np.zeros(N); R = np.zeros(N)
bus = {k: np.zeros((2, N)) for k in ['kick', 'drums', 'bass', 'stab', 'pad', 'fx']}

def add(name, sig, t0, pan=0.0, gain=1.0):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[: N - i] * gain
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    bus[name][0, i:i + len(sig)] += sig * l * 1.414
    bus[name][1, i:i + len(sig)] += sig * r * 1.414

def tt(d): return np.arange(int(d * SR)) / SR

def env(d, a=0.003, dec=0.2, sus=0.0, rel=0.05, hold=None):
    t = tt(d); e = np.ones_like(t)
    e = np.where(t < a, t / a, sus + (1 - sus) * np.exp(-(t - a) / max(dec, 1e-4)))
    if rel: e *= np.clip((d - t) / rel, 0, 1)
    return e

def saw(f, d, fc=4000.0, detune=0.0):
    t = tt(d); out = np.zeros_like(t)
    nmax = int(min(SR / 2.2 / f, 60))
    for n in range(1, nmax + 1):
        w = (1 / n) / np.sqrt(1 + (n * f / fc) ** 4)
        if w < 1e-4: break
        out += w * np.sin(2 * np.pi * n * f * (1 + detune) * t + n * 0.3)
    return out / 1.6

def sine(f, d): return np.sin(2 * np.pi * f * tt(d))

def fnoise(d, lo, hi):
    n = rng.standard_normal(int(d * SR)); F = np.fft.rfft(n)
    fr = np.fft.rfftfreq(len(n), 1 / SR); F[(fr < lo) | (fr > hi)] = 0
    o = np.fft.irfft(F, len(n)); return o / (np.abs(o).max() + 1e-9)

# ---------- instruments
def kick(t0, g=1.0):
    d = 0.45; t = tt(d)
    f = 48 + 110 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t / 0.28) + 0.25 * fnoise(d, 1500, 6000) * np.exp(-t / 0.004)
    add('kick', np.tanh(1.6 * s) * 0.9, t0, 0, g)

def clap(t0, g=1.0):
    d = 0.3; s = np.zeros(int(d * SR))
    for k, off in enumerate([0, 0.008, 0.017, 0.027]):
        n = fnoise(d - off, 900, 7000) * np.exp(-tt(d - off) / (0.012 if k < 3 else 0.11))
        i = int(off * SR); s[i:i + len(n)] += n * (0.6 if k < 3 else 1.0)
    add('drums', s * 0.42, t0, 0.0, g)

def hat(t0, g=1.0, open_=False, pan=0.0):
    d = 0.22 if open_ else 0.06
    s = fnoise(d, 7000, 16000) * np.exp(-tt(d) / (0.07 if open_ else 0.014))
    add('drums', s * 0.22, t0, pan, g)

def tick(t0, g=1.0):
    d = 0.03; s = sine(2400, d) * np.exp(-tt(d) / 0.006)
    add('fx', s * 0.25, t0, 0.2, g)

def bass(t0, f, d, g=1.0, fc=420):
    s = saw(f, d, fc) * 0.8 + sine(f, d) * 0.6
    add('bass', s * env(d, 0.004, 0.35, 0.55, 0.04) * 0.55, t0, 0, g)

def stab(t0, freqs, d=0.22, g=1.0, fc=2600):
    for i, f in enumerate(freqs):
        for det, pan in ((-0.004, -0.55), (0.004, 0.55)):
            s = saw(f, d, fc, det) * env(d, 0.002, 0.09, 0.15, 0.04)
            add('stab', s * 0.16, t0, pan, g)

def pad(t0, freqs, d, g=1.0):
    for f in freqs:
        for det, pan in ((-0.006, -0.8), (0.0, 0.0), (0.006, 0.8)):
            s = saw(f, d, 1200, det) * env(d, 0.6, 9, 1.0, 0.8)
            add('pad', s * 0.06, t0, pan, g)

def pluck(t0, f, g=1.0, pan=0.0):
    d = 0.35; s = saw(f, d, 3200) * np.exp(-tt(d) / 0.12)
    add('stab', s * 0.18, t0, pan, g)

def riser(t0, d, g=1.0):
    t = tt(d); n = rng.standard_normal(len(t))
    # sweep a moving band by mixing progressively brighter filtered noise
    lo = fnoise(d, 300, 1500); mid = fnoise(d, 1500, 5000); hi = fnoise(d, 5000, 14000)
    x = t / d
    s = lo * (1 - x) + mid * np.sin(np.pi * x) + hi * x
    s *= (x ** 1.8) * 0.5
    up = sine(1, d) * 0  # placeholder keeps length
    add('fx', s, t0, 0, g)

def impact(t0, g=1.0):
    d = 2.2; t = tt(d)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.7)
    crash = fnoise(d, 3000, 15000) * np.exp(-t / 0.6) * 0.35
    add('fx', np.tanh(1.4 * boom) * 0.9 + crash, t0, 0, g)

def whoosh(t0, d=0.45, g=1.0):
    x = tt(d) / d; s = fnoise(d, 800, 9000) * np.sin(np.pi * x) ** 2 * 0.35
    add('fx', s, t0 - d * 0.6, 0, g)

# ---------- score
A3, F3, C4, G3 = 220.0, 174.61, 261.63, 196.0
ROOT = [55.0, 43.65, 65.41, 49.0]          # A1 F1 C2 G1
CH = [[440, 523.25, 659.25], [349.23, 440, 523.25], [392, 523.25, 659.25], [392, 493.88, 587.33]]
def bar_of(t): return int(t // (4 * BEAT))
def chord(t): return bar_of(t) % 4

def groove(t_from, t_to, stabs=True, hats16=True, kickg=1.0):
    t = t_from
    while t < t_to - 1e-6:
        b = round(t / BEAT)
        kick(t, kickg)
        if b % 2 == 1: clap(t)
        hat(t + BEAT / 2, 1.0, open_=(b % 4 == 3), pan=0.25)
        if hats16:
            hat(t + BEAT / 4, 0.45, pan=-0.3); hat(t + 3 * BEAT / 4, 0.45, pan=-0.3)
        c = chord(t)
        bass(t + BEAT / 2, ROOT[c] * 2, BEAT * 0.45, 1.0)
        bass(t, ROOT[c], BEAT * 0.4, 0.9)
        if stabs and b % 2 == 0: stab(t + BEAT * 0.5, CH[c])
        if stabs and b % 4 == 3: stab(t + BEAT * 0.75, CH[c], 0.14, 0.8)
        t += BEAT

def halftime(t_from, t_to, c=None, g=0.75):
    t = t_from
    while t < t_to - 1e-6:
        kick(t, g); hat(t + 0.5, 0.55, pan=0.25); clap(t + 1.0, 0.7) if t + 1.0 < t_to else None
        cc = chord(t) if c is None else c
        bass(t, ROOT[cc], 1.8, 0.65, 300)
        t += 2.0

def arp(t_from, t_to, notes, g=1.8):
    t = t_from; k = 0
    while t < t_to - 1e-6:
        pluck(t, notes[k % len(notes)], g, pan=(-0.4 if k % 2 else 0.4)); t += BEAT / 2; k += 1

# 01 HOOK 0-7: lit from frame one, pad + ticks, YES press at 1.0, impact on BET YES OR NO (3.5), groove-lite, riser to 7
pad(0.0, [220, 261.63, 329.63], 3.6, 0.9)
bass(0.0, 55, 3.4, 0.55, 240)
for k in range(7): tick(k * BEAT, 0.6)
riser(2.1, 1.4, 0.9)
impact(3.5, 1.0); stab(3.5, CH[0], 0.45, 1.3, 3400)
groove(3.5, 7.0, stabs=False, hats16=False, kickg=0.85)
riser(5.6, 1.4, 1.0)

# 02 ANYTHING 7-15: full groove, accent hits on each category word, impact on YES OR NO ON ANYTHING (11.5)
impact(7.0, 0.8)
groove(7.0, 15.0)
for t0 in [8.0, 9.0, 10.0, 10.5, 11.0]: stab(t0, CH[chord(t0)], 0.12, 0.9, 3800)
impact(11.5, 0.9)

# 03 SIGN IN 15-22: lighter, friendly: half-time + plucks; build into 22
pad(15.0, [261.63, 329.63, 392, 493.88], 6.0, 1.6)
halftime(15.0, 21.0)
arp(15.0, 20.5, [523.25, 659.25, 783.99, 987.77, 783.99, 659.25])
riser(20.6, 1.4, 1.1)
for k in range(8): hat(21.0 + k * BEAT / 4, 0.25 + k * 0.08)

# 04 BET 22-32: the drop
impact(22.0, 1.0)
groove(22.0, 32.0)
impact(29.5, 0.6)
riser(30.6, 1.4, 0.9)

# 05 PAYOUT 32-40: groove to 36.5, then refund breakdown (filtered half-time)
groove(32.0, 36.5)
pad(36.5, [261.63, 329.63, 392], 3.5, 1.0)
halftime(36.5, 40.0, c=2, g=0.7)
riser(38.6, 1.4, 1.0)

# 06 HOST 40-46: back in with the groove
impact(40.0, 0.9)
groove(40.0, 46.0)

# 07 ROUNDS 46-51: announcement hit, clock ticks breakdown, build
impact(46.0, 1.1); stab(46.0, CH[0], 0.5, 1.3, 3200)
pad(46.0, [220, 261.63, 329.63, 392], 5.0, 1.8)
bass(46.0, 55, 4.8, 0.7, 220)
for k in range(10): tick(46.5 + k * BEAT, 0.7)
for k in range(5): kick(46.0 + k * 1.0, 0.7)
arp(48.0, 50.5, [440, 523.25, 659.25, 783.99])
riser(49.6, 1.4, 1.1)

# 08 BOARD 51-54: full energy
impact(51.0, 1.0)
groove(51.0, 54.0)

# 09 CTA 54-60: fin shimmer, hits into the URL (56), end hit at 58.5 then ring out
pad(54.0, [220, 261.63, 329.63, 440], 2.2, 1.2)
bass(54.0, 55, 2.0, 0.6, 220)
riser(54.6, 1.4, 1.0)
for k, t0 in enumerate([56.0, 56.333, 56.667, 57.0]):
    kick(t0, 1.0); stab(t0, CH[k % 4], 0.2, 1.1)
groove(57.0, 58.5, stabs=False, hats16=True, kickg=0.9)
impact(58.5, 1.1); stab(58.5, [440, 523.25, 659.25, 880], 1.5, 1.2, 3000)
pad(58.5, [220, 261.63, 329.63, 440], 1.5, 1.0)
bass(58.5, 55, 1.45, 0.8, 240)

# ---------- mix: sidechain duck bass/stab/pad on each kick, reverb on stab/pad/fx
kenv = np.abs(bus['kick'][0]) + np.abs(bus['kick'][1])
duck = np.ones(N)
kick_times = []
# rebuild kick onsets from groove calls by envelope peaks
thr = 0.25; above = kenv > thr; on = np.flatnonzero(above[1:] & ~above[:-1])
last = -SR
for i in on:
    if i - last > SR * 0.2:
        kick_times.append(i); last = i
td = np.arange(int(0.25 * SR)) / SR; shape = 1 - 0.6 * np.exp(-td / 0.09)
for i in kick_times:
    seg = duck[i:i + len(shape)]; duck[i:i + len(shape)] = np.minimum(seg, shape[:len(seg)])

def reverb(x, secs=1.6, mix=0.25):
    ir = rng.standard_normal(int(secs * SR)) * np.exp(-np.arange(int(secs * SR)) / SR / (secs / 4))
    ir /= np.sqrt((ir ** 2).sum())
    n = len(x) + len(ir); nf = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nf) * np.fft.rfft(ir, nf), nf)[:len(x)]
    return x * (1 - mix) + y * mix

mix = np.zeros((2, N))
for name, g in [('kick', 1.0), ('drums', 0.9), ('bass', 0.85), ('stab', 0.8), ('pad', 0.9), ('fx', 0.8)]:
    s = bus[name].copy()
    if name in ('bass', 'stab', 'pad'): s *= duck
    if name in ('stab', 'pad', 'fx', 'drums'):
        s = np.stack([reverb(s[0], 1.8 if name == 'pad' else 1.2, 0.35 if name != 'drums' else 0.12),
                      reverb(s[1], 1.8 if name == 'pad' else 1.2, 0.35 if name != 'drums' else 0.12)])
    mix += s * g

# gentle end fade over last 0.6 s, soft clip, normalise peak; loudness set later with ffmpeg
fade = np.ones(N); nf = int(0.6 * SR); fade[-nf:] = np.linspace(1, 0, nf) ** 2
mix *= fade
mix = np.tanh(mix * 0.9)
mix /= np.abs(mix).max() / 0.95
out = (mix.T * 32767).astype(np.int16)
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(out.tobytes())
print('ok', sys.argv[1])
