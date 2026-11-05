"""The separation scorer between the maths and a run: stem names folded from what providers write, Demucs's stems
summed into a bed, the alignment, the fast stereo bed's scaling, Clean up dialogue's one file, the WER family with a
fake ASR (and without one), and the download of the Whisper weights. Needs ffmpeg (the scorer reads files with it)."""

import argparse
import json
import pathlib
import shutil
import subprocess

import numpy as np
import pytest

from fuobe_metrics import download, score
from fuobe_metrics import separation as sep
from fuobe_metrics.models import Missing

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs ffmpeg")

SR = 44100
N = SR  # one second
RNG = np.random.default_rng(3)
TEXT = "the quick brown fox jumps over the lazy dog"


def write(path: pathlib.Path, x: np.ndarray, float_wav: bool = False) -> None:
    x = np.atleast_2d(x)
    pcm = x.T.astype("<f4").tobytes()
    codec = ["-c:a", "pcm_f32le"] if float_wav else ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[0]), "-i", "-", *codec, str(path)], input=pcm, check=True)


def parts():
    t = np.arange(N) / SR
    voice = 0.2 * np.sin(2 * np.pi * 300 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))
    music = np.stack([0.15 * np.sin(2 * np.pi * 110 * t), 0.12 * np.sin(2 * np.pi * 165 * t)])
    effects = 0.05 * RNG.standard_normal((2, N))
    return np.stack([voice, voice]), music, effects


@pytest.fixture()
def case(tmp_path):
    """A mix with known parts and meta.json, like make-separation.py writes."""
    voice, music, effects = parts()
    bed = music + effects
    mix = voice + bed
    refs = tmp_path / "refs"
    for name, x in [("mix", mix), ("voice", voice), ("music", music), ("effects", effects), ("background", bed)]:
        write(refs / f"{name}.flac", x)
    (refs / "meta.json").write_text(json.dumps({"text": TEXT, "sampleRate": SR}), encoding="utf8")
    return {"dir": tmp_path, "refs": refs, "voice": voice, "music": music, "effects": effects, "bed": bed, "mix": mix}


def job(case, outputs, extra=None, transcript=None):
    run = case["dir"]
    files = []
    for i, (stem, x) in enumerate(outputs):
        f = f"outputs/j/{i}.flac"
        write(run / f, x)
        files.append({"file": f, "kind": "audio", **({"stem": stem} if stem else {})})
    if transcript is not None:
        (run / "outputs/j/t-transcript.txt").write_text(transcript, encoding="utf8")
        files.append({"file": "outputs/j/t-transcript.txt", "kind": "text", "role": "transcript"})
    return {
        "id": "j",
        "inputs": {"audio": str(case["refs"] / "mix.flac")},
        "references": [str(p) for p in sorted(case["refs"].glob("*.flac"))],
        "request": {"params": {"extra": extra or {}}},
        "outputs": files,
    }


def scorer(run_dir):
    s = score.Scorer(argparse.Namespace(device="cpu"))
    s.run_dir = run_dir
    return s


def test_stem_names_fold_and_an_unnamed_first_output_is_the_voice(case):
    voice, bed = case["voice"], case["bed"]
    j = job(case, [(None, voice), ("residual", bed), ("drums", 0.5 * bed)])
    stems = score.audio_outputs(case["dir"], j)
    assert set(stems) == {"voice", "background", "drums"}
    j = job(case, [("vocals", voice), ("no_vocals", bed), ("sfx", case["effects"]), ("music", case["music"])])
    assert set(score.audio_outputs(case["dir"], j)) == {"voice", "background", "effects", "music"}


def test_references_and_meta(case):
    j = job(case, [("voice", case["voice"])])
    refs, meta = score.references_of(j)
    assert set(refs) == {"mix", "voice", "music", "effects", "background"}
    assert meta["text"] == TEXT


def test_separation_of_a_clean_split(case):
    # The fast stereo bed: the input minus the mono speech, every channel.
    j = job(case, [("voice", case["voice"][:1]), ("background", case["mix"] - case["voice"][:1])])
    res = scorer(case["dir"]).m_separation(j, [])
    assert res["voiceSiSdr"] > 60 and res["backgroundSiSdr"] > 60
    assert res["mixError"] < -60
    assert abs(res["bedLevel"]) < 0.01 and abs(res["bedScale"]) < 0.01
    assert res["stereoCorrGap"] < 0.01


def test_a_bed_scaled_down_under_full_scale_shows(case):
    # AudioMerge divides a result that peaks over 1.0 by its peak: here 1.25, about −1.94 dB.
    j = job(case, [("voice", case["voice"]), ("background", (case["mix"] - case["voice"]) / 1.25)])
    res = scorer(case["dir"]).m_separation(j, [])
    assert res["bedScale"] == pytest.approx(-1.938, abs=0.01)
    assert res["bedLevel"] == pytest.approx(-1.94, abs=0.02)
    assert res["backgroundSiSdr"] > 60  # the scale alone doesn't change SI-SDR


def test_demucs_stems_are_summed_into_a_bed_and_a_late_stem_is_lined_up(case):
    bed = case["bed"]
    late = lambda x: sep.shift(x, -300)  # noqa: E731  (300 samples late, like a decoder's priming)
    j = job(case, [("vocals", late(case["voice"])), ("drums", late(0.5 * bed)), ("bass", late(0.25 * bed)), ("other", late(0.25 * bed))])
    res = scorer(case["dir"]).m_separation(j, [])
    # Lined up, only the last 300 samples are missing (about 22 dB for one second); unaligned it would be far lower.
    assert res["backgroundSiSdr"] > 18
    assert res["voiceSiSdr"] > 18
    assert "shifted 300 samples" in res["_note"] or "shifted -300 samples" in res["_note"]


def test_clean_dialogue_is_scored_against_the_level_asked(case):
    # Graph C: one file, the dialogue with the music and effects at −18 dB, mono.
    g = 10 ** (-18 / 20)
    out = sep.mono(case["voice"]) + g * sep.mono(case["bed"])
    extra = {"separationModel": "DBS-BSRNN-DnR", "channels": "mono", "voiceDb": 0, "musicDb": -18, "effectsDb": -18}
    j = job(case, [("voice", out)], extra=extra)
    res = scorer(case["dir"]).m_separation(j, [])
    assert res["remixSiSdr"] > 60
    assert res["bedLevel"] == pytest.approx(-18, abs=0.05)
    assert 15 < res["voiceSiSdr"] < 30  # the bed under it counts as "not the voice" here
    assert "mixError" not in res and "bedScale" not in res
    assert score.remix_levels(j) == {"voiceDb": 0.0, "musicDb": -18.0, "effectsDb": -18.0, "bedDb": -18.0}
    assert score.remix_levels(job(case, [("voice", out)], extra={"channels": "mono"})) is None


class FakeAsr:
    def text(self, audio, sr=16000):
        return TEXT if len(audio) else ""


def test_wer_with_a_fake_asr_and_without_one(case, monkeypatch):
    j = job(case, [("voice", case["voice"])], transcript="the quick brown fox jumps over a lazy dog")
    s = scorer(case["dir"])
    s._asr = FakeAsr()
    res = s.m_wer(j, [])
    assert res["wer"] == 0 and res["werInput"] == 0
    assert res["werTranscript"] == pytest.approx(1 / 9, abs=1e-3)
    # Without Whisper the job's own transcript is still scored, and the family isn't switched off for later jobs.
    s = scorer(case["dir"])

    def missing():
        raise Missing("speech recognition needs transformers: run pnpm eval:setup --asr")

    monkeypatch.setattr(s, "asr", missing)
    res = s.m_wer(j, [])
    assert res["werTranscript"] == pytest.approx(1 / 9, abs=1e-3)
    assert "wer" not in res and "werInput" not in res and "skipped" in res["_note"]
    assert "wer" not in s.skipped and "wer (Whisper)" in s.skipped


def test_download_asr_fetches_whisper_at_its_revision(monkeypatch):
    got = []
    monkeypatch.setattr(download, "_download", lambda key, f: got.append((key, f)) or f"/cache/{f}")
    assert download.main(["--asr", "--no-aesthetic"]) == 0
    whisper = [f for k, f in got if k == "whisper-base-en"]
    assert set(whisper) == set(download.MODELS["whisper-base-en"]["files"])
    assert "model.safetensors" in whisper


def test_bed_scale_and_remix_gains_on_plain_arrays():
    voice, music, effects = parts()
    mix = voice + music + effects
    assert sep.bed_scale((mix - voice[:1]) / 2, voice[:1], mix) == pytest.approx(-6.021, abs=0.01)
    assert sep.bed_scale(np.zeros_like(mix), voice, np.zeros_like(mix)) is None
    g = sep.remix_gains(voice[0] + 0.1 * (music + effects).mean(0), voice, music + effects)
    assert g["voice"] == pytest.approx(0, abs=0.01) and g["bed"] == pytest.approx(-20, abs=0.05)
