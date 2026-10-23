# Music bed and sound effects for the $100 trading competition video (48.5 s), synthesized with numpy.
# Match-day broadcast feel: a 128 BPM stadium beat, crowd ambience, a referee whistle, stinger whooshes
# on every cut, a slam on the title, coin ticks on the prize count-up and a full-time whistle.
# Usage: python3 audio/sound.py out.wav
import sys
import wave

import numpy as np

SR = 44100
DUR = 48.5
N = int(SR * DUR)
out = np.zeros((2, N))
rng = np.random.default_rng(7)

CUTS = [4.5, 9.5, 16.5, 22.0, 28.0, 35.5, 42.5]
BPM = 128
BEAT = 60 / BPM


def tt(d):
    return np.arange(int(d * SR)) / SR


def fnoise(d, lo, hi):
    n = rng.standard_normal(int(d * SR))
    F = np.fft.rfft(n)
    fr = np.fft.rfftfreq(len(n), 1 / SR)
    F[(fr < lo) | (fr > hi)] = 0
    o = np.fft.irfft(F, len(n))
    return o / (np.abs(o).max() + 1e-9)


def put(sig, t0, g=1.0, pan=0.0):
    i = int(t0 * SR)
    if i < 0:
        sig, i = sig[-i:], 0
    sig = sig[: N - i] * g
    l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
    out[0, i:i + len(sig)] += sig * l
    out[1, i:i + len(sig)] += sig * r


# ---- music ----
music = np.zeros((2, N))


def mput(sig, t0, g=1.0, pan=0.0):
    i = int(t0 * SR)
    sig = sig[: N - i] * g
    l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
    music[0, i:i + len(sig)] += sig * l
    music[1, i:i + len(sig)] += sig * r


def kick():
    t = tt(0.4)
    f = 48 + 110 * np.exp(-t / 0.035)
    return np.tanh(2.2 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)) * 0.9


def clap():
    d = 0.25
    t = tt(d)
    s = fnoise(d, 900, 6000) * (np.exp(-t / 0.05) + 0.6 * np.exp(-((t - 0.012) ** 2) / 2e-6))
    return s * 0.45


def hat(open_=False):
    d = 0.22 if open_ else 0.06
    t = tt(d)
    return fnoise(d, 7000, 15000) * np.exp(-t / (0.07 if open_ else 0.015)) * 0.22


def saw(f, d):
    t = tt(d)
    return 2 * ((t * f) % 1) - 1


def lowpass(x, cut):
    F = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    F *= 1 / (1 + (fr / cut) ** 4)
    return np.fft.irfft(F, len(x))


def note(f, d, cut=1800, g=0.2):
    t = tt(d)
    env = np.minimum(1, t / 0.008) * np.exp(-t / (d * 0.6))
    s = (saw(f, d) + saw(f * 1.006, d) + saw(f * 0.497, d) * 0.6) * env
    return lowpass(s, cut) * g


# A minor anthem: Am F C G, one chord per bar.
CH = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [130.81, 196.0, 261.63], [196.0, 246.94, 293.66]]
BASS = [55.0, 43.65, 65.41, 49.0]
BAR = 4 * BEAT
start_full = 4.5  # full beat after the open
t = 0.0
bar = 0
while t < DUR - 1.5:
    chord, bass = CH[bar % 4], BASS[bar % 4]
    full = t >= start_full - 0.01
    for b in range(4):
        tb = t + b * BEAT
        if tb >= DUR - 1.5:
            break
        if full or b in (0, 2):
            mput(kick(), tb, 0.9)
        if full and b in (1, 3):
            mput(clap(), tb, 0.8)
        for h in range(2):
            mput(hat(open_=(h == 1 and b == 3)), tb + h * BEAT / 2, 0.8 if full else 0.4, pan=0.25)
        # bass on the eighths, octave bounce
        for h in range(2):
            mput(note(bass * (2 if h else 1), BEAT / 2 * 0.95, cut=500, g=0.32), tb + h * BEAT / 2)
    # brass-ish stabs on beat 1 and the "and" of 2
    for off in (0, 1.5 * BEAT):
        for f in chord:
            mput(note(f * 2, 0.32, cut=2600, g=0.09 if full else 0.05), t + off, pan=rng.uniform(-0.4, 0.4))
    t += BAR
    bar += 1

# Ducking: drop the beat around each stinger so the whoosh reads, and fade the end.
env = np.ones(N)
for c in CUTS:
    i0, i1 = int((c - 0.25) * SR), int((c + 0.15) * SR)
    env[i0:i1] *= 0.55
fade0 = int((DUR - 2.2) * SR)
env[fade0:] *= np.linspace(1, 0, N - fade0) ** 1.5
music *= env

# ---- crowd ambience ----
crowd = fnoise(DUR, 250, 2600) * 0.12
swell = np.ones(N) * 0.55
for t0, t1, a in ((0.0, 4.5, 1.0), (36.6, 39.5, 1.6), (44.5, 48.5, 1.2)):
    i0, i1 = int(t0 * SR), int(t1 * SR)
    swell[i0:i1] = np.maximum(swell[i0:i1], a * np.sin(np.linspace(0, np.pi, i1 - i0)) ** 0.7)
put(crowd * swell, 0, 1.0, pan=-0.2)
put(fnoise(DUR, 300, 2400) * 0.1 * swell, 0, 1.0, pan=0.2)


def whistle(t0, d, g=1.0):
    t = tt(d)
    trill = 1 + 0.035 * np.sin(2 * np.pi * 34 * t)
    s = np.sin(2 * np.pi * np.cumsum(3150 * trill) / SR) + 0.3 * np.sin(2 * np.pi * np.cumsum(6300 * trill) / SR)
    env = np.minimum(1, t / 0.02) * np.minimum(1, (d - t) / 0.05)
    put((s + fnoise(d, 2500, 5000) * 0.25) * env * 0.22, t0, g)


def whoosh(c, g=1.0):
    d = 0.75
    x = tt(d) / d
    s = (fnoise(d, 500, 3000) * (1 - x) + fnoise(d, 2500, 10000) * x) * np.sin(np.pi * x) ** 2 * 0.55
    i = int((c - d * 0.55) * SR)
    for ch in (0, 1):
        w = (1 - x) if ch == 0 else x
        out[ch, i:i + len(s)] += s * (0.4 + 0.9 * w) * g


def slam(t0, g=1.0):
    d = 0.5
    t = tt(d)
    body = np.sin(2 * np.pi * np.cumsum(50 + 150 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.18)
    put(np.tanh(2 * body) * 0.8 + fnoise(d, 1500, 9000) * np.exp(-t / 0.01) * 0.5, t0, g)


def coin(t0, g=1.0):
    d = 0.18
    t = tt(d)
    f = rng.choice([2093, 2637, 3136])
    put((np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.5 * t)) * np.exp(-t / 0.05) * 0.2, t0, g,
        pan=rng.uniform(-0.4, 0.4))


def thud(t0, g=1.0):
    d = 0.2
    t = tt(d)
    put(np.sin(2 * np.pi * 120 * t) * np.exp(-t / 0.05) * 0.5 + fnoise(d, 800, 4000) * np.exp(-t / 0.01) * 0.3, t0, g)


whistle(0.15, 0.32)
whistle(0.6, 0.9)
slam(0.42, 1.0)
for c in CUTS:
    whoosh(c)
# panel landings
for t0 in (4.5 + 0.6, 9.5 + 2.6, 16.5 + 0.7, 16.5 + 2.1, 22.0 + 1.6, 22.0 + 2.3):
    thud(t0, 0.7)
for i in range(4):  # league-table rows
    thud(28.0 + 0.8 + i * 1.25, 0.6)
# prize count-up: coin ticks while each number climbs
for p0 in (35.5 + 1.2, 35.5 + 1.5, 35.5 + 1.8):
    for k in range(7):
        coin(p0 + k * 0.11, 0.8)
thud(35.5 + 3.6, 0.8)  # VAR banner
whistle(46.4, 0.35)
whistle(46.85, 0.35)
whistle(47.3, 1.0)

mix = music * 0.55 + out
mix /= np.abs(mix).max() + 1e-9
mix *= 0.89
pcm = (np.clip(mix.T, -1, 1) * 32767).astype("<i2")
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "sound.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", DUR, "s")
