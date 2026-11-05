"""Source-separation maths on plain numpy arrays (channels × samples, float), so it is tested without a model or a file:
SI-SDR and SDR of a stem against its known reference, whether the stems add back up to the input, the level and peak
of a bed against the reference bed (AudioMerge scales a bed down when it peaks over full scale), a stereo check
(left/right correlation and width), where a known noise ends up, and the word error rate of a transcript."""

from __future__ import annotations

import math
import re
import unicodedata

import numpy as np

EPS = 1e-12


def as_channels(x) -> np.ndarray:
    """A signal as channels × samples (float64): a 1-D array is one channel."""
    a = np.asarray(x, dtype=np.float64)
    return a[None, :] if a.ndim == 1 else a


def mono(x) -> np.ndarray:
    """The mean of the channels."""
    return as_channels(x).mean(axis=0)


def match_channels(est, ref) -> tuple[np.ndarray, np.ndarray]:
    """Both signals with the same channel count: a mono one is compared with the other's mean (a mono stem against a
    stereo reference is scored against the reference's mono mean, never copied to two channels)."""
    e, r = as_channels(est), as_channels(ref)
    if e.shape[0] == r.shape[0]:
        return e, r
    if e.shape[0] == 1:
        return e, r.mean(axis=0, keepdims=True)
    if r.shape[0] == 1:
        return e.mean(axis=0, keepdims=True), r
    c = min(e.shape[0], r.shape[0])
    return e[:c], r[:c]


def crop(*xs) -> list[np.ndarray]:
    """Every signal cut to the shortest one's length."""
    xs = [as_channels(x) for x in xs]
    n = min(x.shape[1] for x in xs)
    return [x[:, :n] for x in xs]


def best_offset(est, ref, max_lag: int) -> int:
    """The shift (in samples, |lag| ≤ max_lag) that lines `est` up with `ref` best: est[t + lag] ≈ ref[t]. A decoder's
    priming samples (AAC) or a hosted model's padding can move a stem by a few hundred samples."""
    a, b = mono(est), mono(ref)
    n = min(len(a), len(b))
    if n < 2 or max_lag <= 0:
        return 0
    a, b = a[:n], b[:n]
    size = 1 << int(math.ceil(math.log2(2 * n)))
    corr = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    lags = np.concatenate([corr[: max_lag + 1], corr[-max_lag:]])
    idx = np.concatenate([np.arange(0, max_lag + 1), np.arange(-max_lag, 0)])
    return int(idx[int(np.argmax(lags))])


def shift(x, lag: int) -> np.ndarray:
    """x moved left by `lag` samples (x[t + lag]), the end padded with silence; a negative lag moves it right."""
    x = as_channels(x)
    if lag == 0:
        return x
    out = np.zeros_like(x)
    if lag > 0:
        out[:, : x.shape[1] - lag] = x[:, lag:]
    else:
        out[:, -lag:] = x[:, : x.shape[1] + lag]
    return out


def _db(num: float, den: float) -> float:
    return float(10.0 * math.log10((num + EPS) / (den + EPS)))


def si_sdr(est, ref) -> float:
    """Scale-invariant SDR in dB (Le Roux et al. 2019), the mean over channels; both signals zero-mean. Higher is
    better; a stem's level doesn't change it."""
    e, r = crop(*match_channels(est, ref))
    vals = []
    for ec, rc in zip(e, r):
        ec = ec - ec.mean()
        rc = rc - rc.mean()
        alpha = float(ec @ rc) / (float(rc @ rc) + EPS)
        target = alpha * rc
        vals.append(_db(float(target @ target), float((ec - target) @ (ec - target))))
    return float(np.mean(vals))


def sdr(est, ref) -> float:
    """SDR in dB as MUSDB's newer scoring defines it (signal over error, no projection): the level counts, so a stem
    that comes out quieter than its reference scores lower. The mean over channels."""
    e, r = crop(*match_channels(est, ref))
    return float(np.mean([_db(float(rc @ rc), float((rc - ec) @ (rc - ec))) for ec, rc in zip(e, r)]))


def rms_db(x) -> float:
    """RMS level in dBFS over every channel (−inf for silence is clipped to −200)."""
    a = as_channels(x)
    v = float(np.sqrt(np.mean(a**2))) if a.size else 0.0
    return max(-200.0, 20.0 * math.log10(v + EPS))


def peak_db(x) -> float:
    """Sample peak in dBFS (0 = full scale)."""
    a = as_channels(x)
    v = float(np.max(np.abs(a))) if a.size else 0.0
    return max(-200.0, 20.0 * math.log10(v + EPS))


def mixture_error(stems: list, mix) -> dict:
    """Do the stems add up to the input? The error of their sum against the mix, as dB under the mix's level (−60 dB
    or lower: the same sound; 16-bit FLAC stems land around −90 dB) and the largest sample difference."""
    total = None
    for s in stems:
        s = as_channels(s)
        total = s if total is None else crop(total, s)[0] + crop(total, s)[1]
    if total is None:
        return {"db": None, "maxAbs": None}
    t, m = crop(*match_channels(total, mix))
    err = t - m
    return {"db": round(rms_db(err) - rms_db(m), 2), "maxAbs": float(np.max(np.abs(err))) if err.size else 0.0}


def bed_level(est, ref) -> dict:
    """The bed's level and peak against the reference bed's: delta in dB (0 = same level; a bed that AudioMerge scaled
    down under full scale comes out negative) and its own peak in dBFS."""
    e, r = crop(*match_channels(est, ref))
    return {"delta": round(rms_db(e) - rms_db(r), 2), "peak": round(peak_db(e), 2), "peakRef": round(peak_db(r), 2)}


def bed_scale(bed, voice, mix) -> float | None:
    """How a bed made as "the input minus the speech" was scaled, in dB: the least-squares gain of the bed against
    mix − voice (a mono voice taken from every channel, as AudioMerge broadcasts it). 0 = as subtracted; AudioMerge
    divides the whole result by its peak when that is over full scale, which shows as −(the overshoot in dB)."""
    b, v, m = as_channels(bed), as_channels(voice), as_channels(mix)
    if v.shape[0] == 1 and m.shape[0] > 1:
        v = np.repeat(v, m.shape[0], axis=0)
    elif m.shape[0] == 1 and v.shape[0] > 1:
        v = v.mean(axis=0, keepdims=True)
    v, m = crop(v, m)
    unscaled = m - v
    e, u = crop(*match_channels(b, unscaled))
    den = float(np.sum(u * u))
    if den <= EPS:
        return None
    g = float(np.sum(e * u)) / den
    return round(20.0 * math.log10(g), 3) if g > 0 else None


def remix_gains(out, voice, bed) -> dict:
    """A remix (the dialogue with the music and effects mixed back under it, Clean up dialogue) against its known
    parts: the least-squares gains of the voice and the bed in it, solved together on the mono mean, as dB (0 = as in
    the input). The model's own errors are uncorrelated with the parts, so a bed asked at −18 dB reads about −18."""
    o, v, b = crop(mono(out)[None, :], mono(voice)[None, :], mono(bed)[None, :])
    a = np.stack([v[0], b[0]], axis=1)
    (gv, gb), *_ = np.linalg.lstsq(a, o[0], rcond=None)
    db = lambda g: round(20.0 * math.log10(g), 2) if g > 1e-6 else None  # noqa: E731
    return {"voice": db(float(gv)), "bed": db(float(gb))}


def stereo(x) -> dict:
    """Left/right correlation (1 = mono, 0 = unrelated, −1 = out of phase) and width (side over mid energy, dB) of a
    2-channel signal; a mono one says so."""
    a = as_channels(x)
    if a.shape[0] < 2:
        return {"channels": int(a.shape[0]), "corr": 1.0, "width": None}
    left, right = a[0] - a[0].mean(), a[1] - a[1].mean()
    corr = float(left @ right) / (math.sqrt(float(left @ left) * float(right @ right)) + EPS)
    mid, side = (a[0] + a[1]) / 2, (a[0] - a[1]) / 2
    return {"channels": int(a.shape[0]), "corr": round(corr, 4), "width": round(_db(float(side @ side), float(mid @ mid)), 2)}


def stereo_check(est, ref) -> dict:
    """The bed's stereo image against the reference bed's: both correlations, the gap between them, the width gap
    (dB), and each channel's level against the reference's (dB). A mono bed against a stereo reference shows as a
    correlation of 1 and no width."""
    e, r = as_channels(est), as_channels(ref)
    se, sr = stereo(e), stereo(r)
    out = {"corr": se["corr"], "corrRef": sr["corr"], "corrGap": round(abs(se["corr"] - sr["corr"]), 4), "channels": se["channels"]}
    if se["width"] is not None and sr["width"] is not None:
        out["widthGap"] = round(se["width"] - sr["width"], 2)
    if e.shape[0] >= 2 and r.shape[0] >= 2:
        ec, rc = crop(e[:2], r[:2])
        out["levelLeft"] = round(rms_db(ec[0]) - rms_db(rc[0]), 2)
        out["levelRight"] = round(rms_db(ec[1]) - rms_db(rc[1]), 2)
    return out


def noise_share(stems: dict, noise) -> dict:
    """Where a known steady noise (hum, hiss) ended up: each stem's projection onto the noise, as a share of it
    (<stem, noise> / <noise, noise>, on the mono mean). The other sources are uncorrelated with the noise and the
    stems add up to the mix, so the shares add up to about 1."""
    n = mono(noise)
    n = n - n.mean()
    den = float(n @ n) + EPS
    out = {}
    for name, s in stems.items():
        sm = mono(s)
        k = min(len(sm), len(n))
        out[name] = round(float((sm[:k] - sm[:k].mean()) @ n[:k]) / den, 3)
    return out


_NUMBERS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten"}


def words(text: str) -> list[str]:
    """A transcript as words for WER: lower case, accents kept, punctuation dropped (an apostrophe inside a word stays),
    hyphens split words, single digits spelt out (Whisper writes "3", the script says "three")."""
    t = unicodedata.normalize("NFKC", text or "").lower().replace("’", "'").replace("-", " ")
    t = re.sub(r"[^\w\s']", " ", t)
    out = []
    for w in t.split():
        w = w.strip("'")
        if w:
            out.append(_NUMBERS.get(w, w))
    return out


def wer(reference: str, hypothesis: str) -> dict:
    """Word error rate: (substitutions + deletions + insertions) / reference words, by Levenshtein alignment on
    words(). 0 is perfect; it can exceed 1 when the hypothesis adds many words."""
    ref, hyp = words(reference), words(hypothesis)
    n, m = len(ref), len(hyp)
    # d[i][j]: (cost, subs, dels, ins) to turn ref[:i] into hyp[:j]
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)]
        for j in range(1, m + 1):
            same = ref[i - 1] == hyp[j - 1]
            c_sub = prev[j - 1]
            c_del = prev[j]
            c_ins = cur[j - 1]
            options = [
                (c_sub[0] + (0 if same else 1), c_sub[1] + (0 if same else 1), c_sub[2], c_sub[3]),
                (c_del[0] + 1, c_del[1], c_del[2] + 1, c_del[3]),
                (c_ins[0] + 1, c_ins[1], c_ins[2], c_ins[3] + 1),
            ]
            cur.append(min(options))
        prev = cur
    cost, subs, dels, ins = prev[m]
    return {"wer": (cost / n) if n else (0.0 if m == 0 else 1.0), "words": n, "substitutions": subs, "deletions": dels, "insertions": ins}


def report_speed(report: dict) -> float | None:
    """Times real time from ComfyUI-DBS's JSON report (audio seconds per second of work, all channels' passes
    included), or None when the report doesn't say."""
    if not isinstance(report, dict):
        return None
    for key in ("times_real_time", "realtime_factor", "x_realtime", "times_realtime", "speed_x_realtime", "realtime_x", "rtf_x"):
        v = report.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    audio = report.get("audio_seconds") or report.get("audio_sec") or report.get("duration_seconds")
    run = report.get("run_seconds") or report.get("elapsed_seconds") or report.get("seconds")
    if isinstance(audio, (int, float)) and isinstance(run, (int, float)) and run > 0:
        return float(audio) / float(run)
    return None
