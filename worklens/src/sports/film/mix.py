"""Pitch Prophet · mix. Builds out/mix.wav for a briefing film from its events.json:
voice lines on their 'voice' cues, a studio-show groove written in code (118→120 BPM grid, kick,
clap, hats, saw bass, pad), a whoosh + low thump on every section wipe, a tick on every hard cut,
music ducked under the voice. Run with lemo-opuscar's Python:

    <lemo>/.venv/Scripts/python.exe mix.py <film dir> <lemo dir>
"""
import json, sys, os
import numpy as np
import soundfile as sf
import soxr

film, lemo = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(lemo, 'core', 'audio'))
import sfx  # noqa: E402  (lemo's procedural foley + mix helpers, 48 kHz)

SR = sfx.SR
ev = json.load(open(os.path.join(film, 'events.json'), encoding='utf-8'))
DUR = float(ev['dur']); N = int(np.ceil((DUR + 0.5) * SR))
rng = np.random.default_rng(11)

# ---------- music: one bar = 4 beats at 120 BPM (a beat is exactly 15 frames at 30 fps) ----------
BPM = 120.0; BEAT = 60.0 / BPM; BAR = 4 * BEAT
CHORDS = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [48, 52, 55]), (55, [55, 59, 62])]   # Am F C G (roots as MIDI)
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
music = np.zeros((N, 2))

def kick():
    d = 0.32; t = sfx.t_(d); f = 45 + 85 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.11)
def clap():
    d = 0.22; n = sfx.bp(sfx.noise(d), 900, 2600) * np.exp(-sfx.t_(d) / 0.06)
    return sfx.norm(n) * 0.8
def hat(open_=False):
    d = 0.18 if open_ else 0.05; return sfx.norm(sfx.hp(sfx.noise(d), 7000) * np.exp(-sfx.t_(d) / (0.06 if open_ else 0.012))) * 0.5
def saw(f, d):
    t = sfx.t_(d); ph = (f * t) % 1.0; return 2 * ph - 1
def bass(m, d):
    x = saw(hz(m - 24), d) + 0.5 * saw(hz(m - 24) * 1.005, d)
    env = np.minimum(1, sfx.t_(d) / 0.005) * np.exp(-sfx.t_(d) / 0.18)
    return sfx.lp(x, 420) * env * 0.55
def pad(notes, d):
    t = sfx.t_(d); x = sum(saw(hz(n) * det, d) for n in notes for det in (0.997, 1.003))
    env = np.minimum(1, t / 0.4) * np.minimum(1, (d - t) / 0.4)
    return sfx.lp(x, 1400) * env * 0.05

K, C, Hc, Ho = kick(), clap(), hat(), hat(True)
end_music = DUR - 0.2
bars = int(np.ceil(DUR / BAR))
for b in range(bars):
    t0 = b * BAR
    root, notes = CHORDS[b % 4]
    sfx.add(music, pad(notes, BAR), t0, 1.0)
    for beat in range(4):
        tb = t0 + beat * BEAT
        if beat in (0, 2): sfx.add(music, K, tb, 0.9)
        if beat == 3 and b % 2: sfx.add(music, K, tb + BEAT / 2, 0.6)
        if beat in (1, 3): sfx.add(music, C, tb, 0.35, pan=0.1)
        for half in (0, 1):
            sfx.add(music, Ho if (half and beat == 3) else Hc, tb + half * BEAT / 2, 0.22 + 0.06 * half, pan=-0.25)
            sfx.add(music, bass(root, BEAT / 2 * 0.9), tb + half * BEAT / 2, 0.8)
# fade in over the first beat, out over the last 2 s
fade = np.ones(N); i0, i1 = int(BEAT * SR), int(end_music * SR)
fade[:i0] = np.linspace(0, 1, i0); fade[max(0, i1 - 2 * SR):i1] = np.linspace(1, 0, min(i1, 2 * SR)); fade[i1:] = 0
music *= fade[:, None]

# ---------- voice ----------
voice = np.zeros((N, 2)); present = np.zeros(N)
for e in ev['ev']:
    if e.get('type') != 'voice': continue
    path = os.path.join(film, 'voice', f"{e['scene']}.wav")
    if not os.path.exists(path): continue
    x, sr = sf.read(path, dtype='float32')
    if x.ndim > 1: x = x.mean(axis=1)
    x = sfx.compress(x / max(1e-6, np.abs(x).max()) * 0.9, thr=0.3, ratio=3.0)
    if sr != SR: x = soxr.resample(x, sr, SR)
    x = sfx.hp(x, 80)
    rms = np.sqrt(np.mean(x[np.abs(x) > 0.02] ** 2)) if np.any(np.abs(x) > 0.02) else 0.1
    x = x * (0.18 / max(rms, 1e-4))                    # every line at the same speech level
    sfx.add(voice, x, e['t'], 1.0)
    s = int(e['t'] * SR); present[s:s + len(x)] = 1

# duck: music down ~9 dB while someone speaks (40 ms attack, 350 ms release)
from scipy.ndimage import uniform_filter1d
duck = 1 - 0.65 * np.clip(uniform_filter1d(present, size=int(0.35 * SR)) * 1.6, 0, 1)
music *= duck[:, None]

# ---------- foley on the picture's events ----------
fx = np.zeros((N, 2))
for e in ev['ev']:
    if e['type'] == 'wipe':
        sfx.add(fx, sfx.whoosh(0.4, 0.5), e['t'] - 0.2, 1.0, pan=-0.3)
        sfx.add(fx, sfx.thump(0.5, 60), e['t'], 0.8)
    elif e['type'] == 'cut':
        sfx.add(fx, sfx.click(1.4, 0.35), e['t'], 1.0, pan=0.2)

mix = voice + music * 0.26 + fx * 0.5
mix = mix[:int((DUR + 0.05) * SR)]
mix = np.stack([sfx.limit(mix[:, 0], 0.89), sfx.limit(mix[:, 1], 0.89)], axis=1)
os.makedirs(os.path.join(film, 'out'), exist_ok=True)
sf.write(os.path.join(film, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
print(json.dumps({'ok': True, 'seconds': round(len(mix) / SR, 2), 'voice_lines': int(sum(1 for e in ev['ev'] if e.get('type') == 'voice'))}))
