"""Writes the separation suite's test mixes with known stems (scripts/eval/cases/separation.json) into
scripts/eval/local/separation/<mix>/ (git-ignored): mix.flac (the input), voice.flac, music.flac, effects.flac,
background.flac (everything but the voice), noise.flac (the hum or hiss, when the mix has one), a video for the video
case, and meta.json (the words spoken, the levels, the pan and every source's licence).

  python3 -I scripts/eval/fixtures/make-separation.py --speech <folder> [--seconds 12]   (needs numpy and ffmpeg)

The speech is yours to bring, with its words: a folder of <name>.flac|.wav files next to <name>.txt (or an
index.json [{"id", "text"}]), mono, any rate, and its licence: --speech-licence "<source, licence>" or a licence.txt in
the folder (meta.json records it; there is no default, so a rerun with other speech can't be credited to the wrong
source). Fuobe's own TTS lines (open Chatterbox) are the intended source; the suite's measured runs used LibriSpeech
dev-clean utterances (CC BY 4.0). The music, the
effects, the hum and the hiss are synthesized here from fixed seeds (Fuobe's own, CC0), so every stem is known
exactly and the mixes are the same on every machine.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "local" / "separation"
SR = 44100
SYNTH_LICENCE = "Synthesized by scripts/eval/fixtures/make-separation.py from fixed seeds (Fuobe's own, CC0)"


def db(x: float) -> float:
    return 10 ** (x / 20)


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x**2)) + 1e-12)


def at_level(x: np.ndarray, dbfs: float) -> np.ndarray:
    return x * (db(dbfs) / rms(x))


def read_audio(path: pathlib.Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype="<f4").astype(np.float64)


def write_flac(path: pathlib.Path, x: np.ndarray) -> None:
    """Channels × samples, float, written as 24-bit FLAC (the stems stay exact to about −140 dB)."""
    x = np.atleast_2d(x)
    pcm = np.clip(x.T, -1, 1).astype("<f4").tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[0]), "-i", "-", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(path)], input=pcm, check=True)


def write_float_wav(path: pathlib.Path, x: np.ndarray) -> None:
    """Channels × samples as 32-bit float WAV: values over full scale are kept."""
    x = np.atleast_2d(x)
    pcm = x.T.astype("<f4").tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[0]), "-i", "-", "-c:a", "pcm_f32le", str(path)], input=pcm, check=True)


def speech_lines(folder: pathlib.Path) -> list[tuple[str, np.ndarray, str]]:
    index = folder / "index.json"
    items = []
    if index.exists():
        for row in json.loads(index.read_text(encoding="utf8")):
            f = next((folder / f"{row['id']}{ext}" for ext in (".flac", ".wav") if (folder / f"{row['id']}{ext}").exists()), None)
            if f:
                items.append((row["id"], f, row["text"]))
    else:
        for f in sorted(folder.iterdir()):
            if f.suffix.lower() in (".flac", ".wav") and f.with_suffix(".txt").exists():
                items.append((f.stem, f, f.with_suffix(".txt").read_text(encoding="utf8").strip()))
    return [(i, read_audio(f), t) for i, f, t in items]


def speech_track(lines, ids: list[str], seconds: float) -> tuple[np.ndarray, str, list[str]]:
    """The named utterances one after the other from 0.5 s, 0.4 s apart, cut to the clip; only whole ones count."""
    n = int(seconds * SR)
    out = np.zeros(n)
    t = int(0.5 * SR)
    said, used = [], []
    by_id = {i: (a, txt) for i, a, txt in lines}
    for i in ids:
        a, txt = by_id[i]
        if t + len(a) > n:
            break
        out[t : t + len(a)] += a
        t += len(a) + int(0.4 * SR)
        said.append(txt)
        used.append(i)
    return out, " ".join(said).lower(), used


def music(seconds: float, seed: int) -> np.ndarray:
    """A stereo chord bed with a bass line and soft plucks: different voicings left and right, so it is wide."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    chords = [[220.0, 277.18, 329.63], [196.0, 246.94, 293.66], [174.61, 220.0, 261.63], [196.0, 246.94, 329.63]]
    bar = 2.0
    left, right = np.zeros(n), np.zeros(n)
    for k in range(int(np.ceil(seconds / bar))):
        a, b = int(k * bar * SR), min(n, int((k + 1) * bar * SR))
        seg = t[a:b] - t[a]
        env = np.minimum(1, seg / 0.05) * np.exp(-seg * 0.6)
        ch = chords[k % len(chords)]
        for j, f in enumerate(ch):
            tone = np.sin(2 * np.pi * f * seg) + 0.3 * np.sin(4 * np.pi * f * seg) + 0.12 * np.sin(6 * np.pi * f * seg)
            (left if j % 2 == 0 else right)[a:b] += 0.6 * env * tone
            (right if j % 2 == 0 else left)[a:b] += 0.25 * env * tone
        bass = np.sin(2 * np.pi * ch[0] / 2 * seg) * np.exp(-seg * 1.2)
        left[a:b] += 0.5 * bass
        right[a:b] += 0.5 * bass
        for p in range(4):  # plucks on the beat, alternating sides
            s = a + int(p * bar / 4 * SR)
            e = min(b, s + int(0.3 * SR))
            ps = t[s:e] - t[s]
            f = ch[rng.integers(0, 3)] * 2
            pl = np.sin(2 * np.pi * f * ps) * np.exp(-ps * 12)
            (left if p % 2 == 0 else right)[s:e] += 0.35 * pl
    return np.stack([left, right])


def effects(seconds: float, seed: int) -> np.ndarray:
    """Door knocks, a whoosh, footsteps and a glass clink, placed at fixed times and panned."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = np.zeros((2, n))

    def put(sig, at, pan):
        s = int(at * SR)
        e = min(n, s + len(sig))
        if s >= n:
            return
        out[0, s:e] += sig[: e - s] * np.cos(pan * np.pi / 2)
        out[1, s:e] += sig[: e - s] * np.sin(pan * np.pi / 2)

    def knock():
        m = int(0.12 * SR)
        tt = np.arange(m) / SR
        noise = rng.standard_normal(m)
        low = np.convolve(noise, np.ones(30) / 30, mode="same")
        return (0.8 * low + 0.6 * np.sin(2 * np.pi * 140 * tt)) * np.exp(-tt * 45)

    def whoosh():
        m = int(1.2 * SR)
        tt = np.arange(m) / SR
        noise = rng.standard_normal(m)
        k = 1 + (np.sin(np.pi * tt / tt[-1]) * 60).astype(int)
        sm = np.array([noise[max(0, i - k[i]) : i + 1].mean() for i in range(m)])
        return 2.5 * sm * np.sin(np.pi * tt / tt[-1]) ** 2

    def step():
        m = int(0.08 * SR)
        tt = np.arange(m) / SR
        return np.convolve(rng.standard_normal(m), np.ones(12) / 12, mode="same") * np.exp(-tt * 70) * 1.2

    def clink():
        m = int(0.6 * SR)
        tt = np.arange(m) / SR
        return (np.sin(2 * np.pi * 2637 * tt) + 0.6 * np.sin(2 * np.pi * 3951 * tt)) * np.exp(-tt * 9) * 0.5

    for i, at in enumerate([1.1, 1.35, 1.6]):
        put(knock(), at, 0.15)
    put(whoosh(), 3.2, 0.8)
    for i in range(8):
        put(step(), 5.0 + i * 0.45, 0.3 + 0.05 * i)
    put(clink(), 9.4, 0.65)
    if seconds > 11:
        put(whoosh(), seconds - 1.6, 0.25)
    return out


def hum(seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    h = sum(a * np.sin(2 * np.pi * f * t) for f, a in [(50, 1.0), (100, 0.5), (150, 0.35), (200, 0.2), (250, 0.1)])
    return np.stack([h, h])


def hiss(seconds: float, seed: int) -> np.ndarray:
    """Pink-ish hiss (white noise through a gentle 1/f filter), uncorrelated left and right."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = []
    for _ in range(2):
        w = rng.standard_normal(n)
        spec = np.fft.rfft(w)
        f = np.fft.rfftfreq(n, 1 / SR)
        spec /= np.sqrt(np.maximum(f, 20))
        out.append(np.fft.irfft(spec, n))
    return np.stack(out)


MIXES = {
    "centre": {"title": "Dialogue in the centre over music and effects", "speech": ["1272-141231-0003", "1272-141231-0004", "1272-141231-0019"], "pan": 0.5},
    "off-centre": {"title": "Dialogue panned left over the same music and effects", "speech": ["1272-141231-0003", "1272-141231-0004", "1272-141231-0019"], "pan": 0.2},
    "hum": {"title": "Dialogue with a steady 50 Hz mains hum", "speech": ["1272-135031-0003", "1272-135031-0004", "1272-135031-0007"], "pan": 0.5, "noise": "hum", "noiseDb": -34},
    "hiss": {"title": "Dialogue with steady tape hiss", "speech": ["1272-135031-0005", "1272-135031-0006", "1272-135031-0008"], "pan": 0.5, "noise": "hiss", "noiseDb": -36},
    "loud": {"title": "A loud master (peaks at −0.1 dBFS)", "speech": ["1272-141231-0016", "1272-141231-0017", "1272-141231-0018"], "pan": 0.5, "peak": -0.1, "musicDb": -18},
    # The music and effects carry the master's peaks, so the bed (the mix minus the speech) goes over full scale where
    # the speech pulls the other way: AudioMerge's peak scaling (research §2.1) has something to scale.
    "loud-bed": {"title": "A loud master whose music and effects reach full scale", "speech": ["1272-141231-0016", "1272-141231-0017", "1272-141231-0018"], "pan": 0.5, "peak": -0.1, "musicDb": -12, "effectsDb": -16},
}


def speech_licence(folder: pathlib.Path, given: str | None) -> str:
    """The speech's source and licence: --speech-licence, else the folder's licence.txt."""
    if given:
        return given
    for name in ("licence.txt", "LICENCE.txt", "license.txt", "LICENSE.txt"):
        f = folder / name
        if f.exists() and f.read_text(encoding="utf8").strip():
            return f.read_text(encoding="utf8").strip()
    raise SystemExit(f"Say where the speech comes from and its licence: --speech-licence \"<source, licence>\" or a licence.txt in {folder}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--speech", required=True, help="folder of speech files with their words (see above)")
    ap.add_argument("--speech-licence", help='the speech\'s source and licence, recorded in meta.json (else the folder\'s licence.txt); the measured runs used "LibriSpeech dev-clean, speaker 1272 (Panayotov et al. 2015, openslr.org/12), CC BY 4.0, read from hf-internal-testing/librispeech_asr_dummy@5be91486"')
    ap.add_argument("--seconds", type=float, default=12.0)
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    licence = speech_licence(pathlib.Path(args.speech), args.speech_licence)
    lines = speech_lines(pathlib.Path(args.speech))
    have = {i for i, _, _ in lines}
    out = pathlib.Path(args.out)
    sec = args.seconds
    for name, m in MIXES.items():
        ids = [i for i in m["speech"] if i in have] or [i for i, _, _ in lines[:3]]
        sp, text, used = speech_track(lines, ids, sec)
        sp = at_level(sp, -20)
        pan = m["pan"]
        voice = np.stack([sp * np.cos(pan * np.pi / 2), sp * np.sin(pan * np.pi / 2)]) * np.sqrt(2)
        mus = at_level(music(sec, 11), m.get("musicDb", -26))
        fx = at_level(effects(sec, 23), m.get("effectsDb", -30))
        noise = None
        if m.get("noise") == "hum":
            noise = at_level(hum(sec), m["noiseDb"])
        elif m.get("noise") == "hiss":
            noise = at_level(hiss(sec, 37), m["noiseDb"])
        parts = [voice, mus, fx] + ([noise] if noise is not None else [])
        mix = sum(parts)
        scale = db(m["peak"]) / np.max(np.abs(mix)) if "peak" in m else min(1.0, db(-1.0) / np.max(np.abs(mix)))
        voice, mus, fx, mix = voice * scale, mus * scale, fx * scale, mix * scale
        if noise is not None:
            noise = noise * scale
        bed = mix - voice
        d = out / name
        d.mkdir(parents=True, exist_ok=True)
        for f, x in [("mix", mix), ("voice", voice), ("music", mus), ("effects", fx), ("background", bed)] + ([("noise", noise)] if noise is not None else []):
            for old in (d / f"{f}.flac", d / f"{f}.wav"):
                old.unlink(missing_ok=True)
            if np.max(np.abs(x)) > 1:
                write_float_wav(d / f"{f}.wav", x)  # a known part over full scale stays exact (FLAC would clip it)
            else:
                write_flac(d / f"{f}.flac", x)
        meta = {
            "title": m["title"],
            "text": text,
            "speech": used,
            "sampleRate": SR,
            "seconds": sec,
            "pan": pan,
            "levelsDbfs": {k: round(20 * np.log10(rms(x)), 2) for k, x in [("mix", mix), ("voice", voice), ("music", mus), ("effects", fx)] + ([("noise", noise)] if noise is not None else [])},
            "peakDbfs": round(20 * np.log10(np.max(np.abs(mix))), 2),
            # The known bed's peak, and the fast stereo bed's with a perfect separation (each channel minus the mono speech):
            # over 0 dBFS, AudioMerge divides the whole bed by its peak.
            "bedPeakDbfs": round(20 * np.log10(np.max(np.abs(bed))), 2),
            "fastBedPeakDbfs": round(20 * np.log10(np.max(np.abs(mix - voice.mean(0)))), 2),
            "licences": {"speech": licence, "music": SYNTH_LICENCE, "effects": SYNTH_LICENCE, **({"noise": SYNTH_LICENCE} if noise is not None else {})},
        }
        (d / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
        print(f"{name}: {text[:60]}… mix {meta['levelsDbfs']['mix']} dBFS, peak {meta['peakDbfs']}")
    # The video case: the centre mix as a phone-style clip (H.264 + AAC 192 kb/s) on a plain picture.
    v = out / "video"
    v.mkdir(parents=True, exist_ok=True)
    c = out / "centre"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x30343c:s=320x180:r=25:d={sec}", "-i", str(c / "mix.flac"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", str(v / "clip.mp4")],
        check=True,
    )
    for f in ["voice", "music", "effects", "background", "mix"]:
        (v / f"{f}.flac").write_bytes((c / f"{f}.flac").read_bytes())
    meta = json.loads((c / "meta.json").read_text(encoding="utf8"))
    meta["title"] = "The centre mix inside a video (H.264 + AAC)"
    (v / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(f"video: {v / 'clip.mp4'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
