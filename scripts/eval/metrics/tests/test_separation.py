"""The separation maths on constructed signals (numpy only, no model, no file)."""

import math

import numpy as np
import pytest

from fuobe_metrics import separation as sep

RNG = np.random.default_rng(7)
SR = 8000


def tone(freq, seconds=1.0, amp=0.5):
    t = np.arange(int(SR * seconds)) / SR
    return amp * np.sin(2 * np.pi * freq * t)


def test_si_sdr_known_values():
    ref = tone(220)
    # A perfect copy at any level is perfect: SI-SDR ignores the scale.
    assert sep.si_sdr(ref, ref) > 100
    assert sep.si_sdr(0.25 * ref, ref) > 100
    # Orthogonal noise at the reference's power: 0 dB.
    noise = tone(331)
    noise = noise - (noise @ ref) / (ref @ ref) * ref
    noise *= np.linalg.norm(ref) / np.linalg.norm(noise)
    assert sep.si_sdr(ref + noise, ref) == pytest.approx(0.0, abs=0.01)
    # Noise at a tenth of the amplitude: 20 dB.
    assert sep.si_sdr(ref + 0.1 * noise, ref) == pytest.approx(20.0, abs=0.01)


def test_sdr_counts_the_level_and_si_sdr_does_not():
    ref = tone(220)
    half = 0.5 * ref
    assert sep.si_sdr(half, ref) > 100
    # error = 0.5·ref, so SDR = 20·log10(1 / 0.5) = 6.02 dB
    assert sep.sdr(half, ref) == pytest.approx(20 * math.log10(2), abs=0.01)


def test_stereo_against_mono_reference_uses_the_mean():
    ref = tone(220)
    stereo = np.stack([ref, ref])
    assert sep.si_sdr(stereo, ref) > 100
    # A mono stem against a stereo reference: compared with the reference's mean.
    assert sep.si_sdr(ref, np.stack([ref * 0.9, ref * 1.1])) > 100


def test_mixture_error_and_lengths():
    v, b = tone(220), tone(440)
    mix = v + b
    assert sep.mixture_error([v, b], mix)["db"] < -100
    off = sep.mixture_error([v, 0.9 * b], mix)
    # error 0.1·b against mix (v and b same power, uncorrelated): 20·log10(0.1/√2) ≈ −23 dB
    assert off["db"] == pytest.approx(20 * math.log10(0.1 / math.sqrt(2)), abs=0.1)
    # Stems a few samples longer than the mix are cut to it.
    assert sep.mixture_error([np.append(v, [0, 0]), b], mix)["db"] < -100


def test_bed_level_catches_peak_scaling():
    bed = tone(110, amp=0.9)
    # AudioMerge divides a result that peaks over 1.0 by its peak: a bed peaking at 1.25 comes back 1.94 dB down.
    scaled = (bed * 1.25) / 1.25 / 1.25
    lv = sep.bed_level(scaled, bed)
    assert lv["delta"] == pytest.approx(-20 * math.log10(1.25), abs=0.01)
    assert lv["peak"] == pytest.approx(20 * math.log10(0.9 / 1.25), abs=0.01)


def test_stereo_check():
    left, right = tone(220), RNG.standard_normal(SR) * 0.3
    ref = np.stack([left, right])
    same = sep.stereo_check(ref, ref)
    assert same["corrGap"] == pytest.approx(0.0, abs=1e-9)
    assert same["levelLeft"] == pytest.approx(0.0) and same["levelRight"] == pytest.approx(0.0)
    # A mono bed has correlation 1 and no width.
    m = sep.stereo_check(sep.mono(ref), ref)
    assert m["corr"] == 1.0 and m["channels"] == 1 and "widthGap" not in m
    assert m["corrGap"] > 0.5
    # A 6 dB quieter right channel shows on that side only.
    q = sep.stereo_check(np.stack([left, right * 0.5]), ref)
    assert q["levelLeft"] == pytest.approx(0.0) and q["levelRight"] == pytest.approx(-6.02, abs=0.01)
    assert sep.stereo(np.stack([left, left]))["corr"] == pytest.approx(1.0)
    assert sep.stereo(np.stack([left, -left]))["corr"] == pytest.approx(-1.0)


def test_noise_share():
    noise = RNG.standard_normal(SR * 8) * 0.3
    voice, music = tone(220, 8), tone(330, 8)
    stems = {"voice": voice + 0.25 * noise, "music": music + 0.75 * noise}
    share = sep.noise_share(stems, noise)
    assert share["voice"] == pytest.approx(0.25, abs=0.03)
    assert share["music"] == pytest.approx(0.75, abs=0.03)


def test_best_offset_and_shift():
    x = RNG.standard_normal(4000)
    late = np.concatenate([np.zeros(37), x])[:4000]
    lag = sep.best_offset(late, x, max_lag=200)
    assert lag == 37
    assert sep.si_sdr(sep.shift(late, lag)[0][:3900], x[:3900]) > 100
    assert sep.best_offset(x, late, max_lag=200) == -37


def test_wer_on_fixed_strings():
    ref = "The quick brown fox jumps over the lazy dog."
    assert sep.wer(ref, "the quick brown fox jumps over the lazy dog")["wer"] == 0.0
    # Punctuation, case, hyphens and single digits don't count.
    assert sep.wer("It's a well-known fact: 3 cats.", "its a well known fact three cats")["wer"] == pytest.approx(1 / 7)
    assert sep.wer("it's a well-known fact: 3 cats.", "it's a well known fact, three cats")["wer"] == 0.0
    w = sep.wer(ref, "the quick brown fox jumped over lazy dog today")
    assert (w["substitutions"], w["deletions"], w["insertions"], w["words"]) == (1, 1, 1, 9)
    assert w["wer"] == pytest.approx(3 / 9)
    assert sep.wer(ref, "")["wer"] == 1.0
    assert sep.wer("", "")["wer"] == 0.0


def test_report_speed():
    assert sep.report_speed({"times_real_time": 0.2, "audio_seconds": 12.0, "seconds": 60.12}) == 0.2
    assert sep.report_speed({"realtime_factor": 0.27}) == 0.27
    assert sep.report_speed({"audio_seconds": 20.0, "run_seconds": 80.0}) == 0.25
    assert sep.report_speed({"model": "x"}) is None
    assert sep.report_speed("nope") is None
