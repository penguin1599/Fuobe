"""Score a run: python -m fuobe_metrics.score <runDir> [options]. Reads run.json and jobs.jsonl,
writes metrics.json next to them: per-job scores, per-group scores (continuity across a film's
shots), which models made them (revision and licence) and why any metric was skipped. A job whose
outputs and settings haven't changed keeps its earlier scores (--force recomputes)."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import sys
import time

import numpy as np

from . import maths
from . import separation as sep
from . import splat
from .media import audio_channels, audio_track, have_ffmpeg, images_of, kind_of, video_frames, video_window
from .models import MODELS, Aesthetic, Asr, Clip, Dino, Faces, Missing, device_of
from .registry import FAMILIES

VERSION = 1


def read_jobs(run_dir: pathlib.Path) -> list[dict]:
    rows: dict[str, dict] = {}
    path = run_dir / "jobs.jsonl"
    if not path.exists():
        return []
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows[row["id"]] = row
    return [r for r in rows.values() if r.get("status") == "succeeded" and r.get("outputs")]


def palette_of(job: dict) -> np.ndarray:
    """The palette a job asked for: its request's params.palette, or a palette-lock route's colours."""
    req = job.get("request") or {}
    body = req.get("body") or {}
    inner = body.get("request") if isinstance(body.get("request"), dict) else {}
    for c in ((req.get("params") or {}).get("palette"), body.get("colors"), (inner.get("params") or {}).get("palette")):
        if isinstance(c, list) and c:
            return maths.hex_colors(c)
    return maths.hex_colors([])


def media_outputs(run_dir: pathlib.Path, job: dict) -> list[pathlib.Path]:
    """The job's picture or clip outputs (masks, first frames and other helpers left out). A preview still that comes
    with a clip (Idol's clean graph renders the input view beside its orbit) is a helper too: the clip is scored."""
    outs = job.get("outputs", [])
    with_clip = any(o.get("kind") == "video" for o in outs)
    out = []
    for o in outs:
        if o.get("role") in {"mask", "first-frame", "depth"} or (with_clip and o.get("role") == "preview" and o.get("kind") == "image"):
            continue
        p = run_dir / o["file"]
        if p.exists() and kind_of(p) in {"image", "video"}:
            out.append(p)
    return out


def splat_outputs(run_dir: pathlib.Path, job: dict) -> list[pathlib.Path]:
    """The job's 3D files (the splat suite reads the splat among them)."""
    return [run_dir / o["file"] for o in job.get("outputs", []) if o.get("kind") == "model3d" and (run_dir / o["file"]).exists()]


# Stem names as the providers write them (src/server/generations.ts STEM_ALIASES), folded to the suite's four.
STEMS = {
    "voice": "voice", "vocals": "voice", "speech": "voice", "target": "voice", "dialogue": "voice",
    "background": "background", "accompaniment": "background", "instrumental": "background", "residual": "background", "no_vocals": "background",
    "music": "music", "effects": "effects", "sfx": "effects",
}


def audio_outputs(run_dir: pathlib.Path, job: dict) -> dict[str, pathlib.Path]:
    """The job's audio stems by name (voice, music, effects, background; other stems such as Demucs's drums keep
    their own names). An unnamed first audio output is the voice (a chain without a stem takes the dialogue)."""
    out: dict[str, pathlib.Path] = {}
    for o in job.get("outputs", []):
        p = run_dir / o["file"]
        if o.get("kind") != "audio" and kind_of(p) != "audio":
            continue
        if not p.exists():
            continue
        name = str(o.get("stem") or o.get("role") or "").lower()
        key = STEMS.get(name, name) or ("voice" if "voice" not in out else f"audio{len(out)}")
        out.setdefault(key, p)
    return out


def text_output(run_dir: pathlib.Path, job: dict, role: str) -> str | None:
    """A text output by role (its file name ends in -<role>.txt)."""
    for o in job.get("outputs", []):
        if o.get("kind") == "text" and (o.get("role") == role or o["file"].endswith(f"-{role}.txt")):
            p = run_dir / o["file"]
            if p.exists():
                return p.read_text(encoding="utf8", errors="replace")
    return None


def references_of(job: dict) -> tuple[dict[str, pathlib.Path], dict]:
    """A separation case's known parts (voice, music, effects, background, noise, mix .flac/.wav) and its meta.json
    (the words spoken, levels and licences), from the folder its references name."""
    files = [pathlib.Path(r) for r in job.get("references", []) if kind_of(r) == "audio" and pathlib.Path(r).exists()]
    stems = {f.stem.lower(): f for f in files}
    meta = {}
    if files:
        m = files[0].parent / "meta.json"
        if m.exists():
            meta = json.loads(m.read_text(encoding="utf8"))
    return stems, meta


def remix_levels(job: dict) -> dict | None:
    """The levels a Clean up dialogue job asked for (graph C's voiceDb, musicDb, effectsDb), or None for a split."""
    extra = ((job.get("request") or {}).get("params") or {}).get("extra") or {}
    if "musicDb" not in extra and "effectsDb" not in extra:
        return None
    music, effects = float(extra.get("musicDb", -100)), float(extra.get("effectsDb", -100))
    # The suite sets music and effects together; when they differ, the bed is scored at the louder one.
    return {"voiceDb": float(extra.get("voiceDb", 0)), "musicDb": music, "effectsDb": effects, "bedDb": max(music, effects)}


def input_file(job: dict) -> pathlib.Path | None:
    ins = job.get("inputs") or {}
    for k in ("audio", "video"):
        v = ins.get(k)
        if isinstance(v, str) and pathlib.Path(v).exists():
            return pathlib.Path(v)
    return None


def fingerprint(run_dir: pathlib.Path, job: dict, config: dict) -> str:
    h = hashlib.sha256(json.dumps(config, sort_keys=True).encode())
    for p in media_outputs(run_dir, job) + splat_outputs(run_dir, job) + list(audio_outputs(run_dir, job).values()) + [pathlib.Path(r) for r in job.get("references", [])]:
        try:
            st = p.stat()
            h.update(f"{p}|{st.st_size}|{int(st.st_mtime)}".encode())
        except OSError:
            h.update(f"{p}|missing".encode())
    h.update(json.dumps(sorted(job.get("metrics", []))).encode())
    return h.hexdigest()[:16]


class Scorer:
    def __init__(self, args):
        self.args = args
        self.device = device_of(args.device)
        self._clip = None
        self._clip_l14 = None
        self._aesthetic = None
        self._faces = None
        self._dino = None
        self._asr = None
        self.run_dir: pathlib.Path | None = None
        self.used: dict[str, dict] = {}
        self.skipped: dict[str, str] = {}

    # Models, loaded on first use; a missing one skips its metric for the whole run with the reason.
    def clip(self):
        if self._clip is None:
            self._clip = Clip(self.args.clip_model, self.device)
            self.used["clip"] = {**MODELS[self.args.clip_model], "key": self.args.clip_model}
        return self._clip

    def aesthetic(self):
        if self._aesthetic is None:
            if self._clip_l14 is None:
                self._clip_l14 = self._clip if self.args.clip_model == "clip-l14" and self._clip else Clip("clip-l14", self.device)
            self._aesthetic = Aesthetic(self._clip_l14)
            self.used["aesthetic"] = {"head": MODELS["aesthetic-v2"], "clip": MODELS["clip-l14"]}
        return self._aesthetic

    def style_model(self):
        """The image embedder style similarity uses: CLIP (default, already loaded for prompt adherence) or DINOv2."""
        if getattr(self.args, "style_model", "clip") != "dinov2":
            self.used["style"] = {**MODELS[self.args.clip_model], "key": self.args.clip_model}
            return self.clip()
        if self._dino is None:
            self._dino = Dino(self.device)
            self.used["style"] = {**MODELS["dinov2-small"], "key": "dinov2-small"}
        return self._dino

    def faces(self):
        if self._faces is None:
            name = self.args.identity_model
            # Licences are information (recorded with every result); --commercial-only refuses a non-commercial metric model.
            if name == "buffalo_l" and getattr(self.args, "commercial_only", False):
                raise Missing("buffalo_l is licensed for non-commercial research only, and --commercial-only is set: keep the default AuraFace (Apache-2.0)")
            detector = getattr(self.args, "face_detector", "yunet")
            self._faces = Faces(name, self.device, detector)
            # The detector is recorded on its own: its licence isn't the recognition model's.
            found = {"detector": {**MODELS[detector], "key": detector}} if name == "auraface" else {}
            self.used["identity"] = {**MODELS[name], "key": name, **found}
        return self._faces

    def asr(self):
        if self._asr is None:
            self._asr = Asr(self.device)
            self.used["wer"] = {**{k: v for k, v in MODELS["whisper-base-en"].items() if k != "files"}, "key": "whisper-base-en"}
        return self._asr

    # Metric families: each returns a dict of keys from registry.FAMILIES plus notes.
    def family(self, name: str, job: dict, outs: list[pathlib.Path]) -> dict:
        return getattr(self, f"m_{name}")(job, outs)

    def m_clip(self, job, outs):
        text = (job.get("prompt") or "").replace("{character}", "a person").strip()
        if not text:
            return {"_note": "no prompt to compare with"}
        pics = [p for o in outs for p in images_of(o, frames=4)]
        if not pics:
            return {"_note": "no picture to score"}
        t = self.clip().texts([text])[0]
        return {"clip": round(maths.mean_clip_score(self.clip().images(pics), t), 3)}

    def m_aesthetic(self, job, outs):
        pics = [p for o in outs for p in images_of(o, frames=4)]
        if not pics:
            return {"_note": "no picture to score"}
        return {"aesthetic": round(float(np.mean(self.aesthetic().scores(pics))), 3)}

    def m_palette(self, job, outs):
        colors = palette_of(job)
        if not len(colors):
            return {"_note": "no palette in the request"}
        pics = [p for o in outs for p in images_of(o, frames=4)]
        if not pics:
            return {"_note": "no picture to score"}
        fits = []
        for p in pics:
            small = p.convert("RGB")
            small.thumbnail((160, 160))
            fits.append(maths.palette_fit(np.asarray(small), colors))
        return {"paletteFit": round(float(np.mean([f["fit"] for f in fits])), 2), "paletteCover": round(float(np.mean([f["cover"] for f in fits])), 3)}

    def reference_pictures(self, job) -> list:
        pics = []
        for r in job.get("references", []):
            if kind_of(r) in {"image", "video"} and pathlib.Path(r).exists():
                pics += images_of(r, frames=4)
        return pics

    def m_style(self, job, outs):
        refs = self.reference_pictures(job)
        if not refs:
            return {"_note": "no style references (add your own images to the case's local/references folder)"}
        pics = [p for o in outs for p in images_of(o, frames=4)]
        if not pics:
            return {"_note": "no picture to score"}
        model = self.style_model()
        ref_emb = model.images(refs)
        out_emb = maths.l2norm(model.images(pics).mean(axis=0))
        s = maths.reference_similarity(out_emb, ref_emb)
        return {"style": round(s["centroid"], 4), "styleNearest": round(s["nearest"], 4), "_refs": s["n"]}

    def m_identity(self, job, outs):
        refs = self.reference_pictures(job)
        if not refs:
            return {"_note": "no reference photos of the person"}
        faces = self.faces()
        ref = [f["embedding"] for f in (faces.largest(p) for p in refs) if f]
        if not ref:
            return {"_note": "no face found in the reference photos"}
        pics = [p for o in outs for p in images_of(o, frames=8)]
        found = [f for f in (faces.largest(p) for p in pics) if f]
        if not found:
            return {"identity": None, "faceRate": 0.0, "_note": "no face found in the output"}
        centroid = maths.l2norm(np.mean(ref, axis=0))
        sims = [float(maths.l2norm(f["embedding"]) @ centroid) for f in found]
        return {"identity": round(float(np.mean(sims)), 4), "faceRate": round(len(found) / len(pics), 3), "_refs": len(ref)}

    def m_temporal(self, job, outs):
        clips = [o for o in outs if kind_of(o) == "video"]
        if not clips:
            return {"_note": "not a clip"}
        res = {}
        frames, _ = video_frames(clips[0], fps=self.args.fps, max_frames=self.args.frames, width=256)
        if len(frames) < 2:
            return {"_note": "the clip has fewer than two frames"}
        from PIL import Image  # noqa: PLC0415

        d = maths.drift(self.clip().images([Image.fromarray(f) for f in frames]))
        res["drift"] = round(d["mean"], 5)
        res["driftMax"] = round(d["max"], 5)
        try:
            import cv2  # noqa: PLC0415
        except ImportError:
            res["_note"] = "warp error needs OpenCV (pnpm eval:setup)"
            return res
        errs = []
        gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
        for a, b, ga, gb in zip(frames[:-1], frames[1:], gray[:-1], gray[1:]):
            fw = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            bw = cv2.calcOpticalFlowFarneback(gb, ga, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            e = maths.warp_error(a, b, fw, maths.valid_flow_mask(fw, bw))
            if not math.isnan(e):
                errs.append(e)
        if errs:
            res["warp"] = round(float(np.mean(errs)), 5)
        return res

    def m_background(self, job, outs):
        """The source clip's frames against the output's on the outer ring of the frame (where the background is): a
        swap that keeps the background as filmed scores near 0 (and a high PSNR). Lined up from the source's start, so a
        case's range starts at 0."""
        clips = [o for o in outs if kind_of(o) == "video"]
        src = (job.get("inputs") or {}).get("video")
        if not clips:
            return {"_note": "not a clip"}
        if not src or not pathlib.Path(src).exists():
            return {"_note": "no source clip to compare with"}
        frames, rate = video_frames(clips[0], fps=self.args.fps, max_frames=self.args.frames, width=256)
        if not len(frames):
            return {"_note": "the clip has no frames"}
        h, w = frames.shape[1:3]
        source = video_window(src, 0.0, len(frames) / rate, rate, w, h)
        d = maths.background_difference(frames, source)
        if not d["frames"]:
            return {"_note": "no source frames in the case's range"}
        return {"bgDiff": round(d["mae"], 5), "bgPsnr": round(d["psnr"], 2)}

    def m_splat(self, job, outs):
        files = splat_outputs(self.run_dir, job)
        if not files:
            return {"_note": "no 3D file in the result"}
        why = []
        for f in files:
            try:
                return splat.haze(splat.opacities(f))
            except splat.NotASplat as e:
                why.append(f"{f.name}: {e}")
        return {"_note": "no splat file to read (" + "; ".join(why) + ")"}

    def m_lipsync(self, job, outs):
        clips = [o for o in outs if kind_of(o) == "video"]
        if not clips:
            return {"_note": "not a clip"}
        fps = 25.0
        frames, rate = video_frames(clips[0], fps=fps, max_frames=750, width=256)
        audio = audio_track(clips[0])
        source = "the clip's sound"
        if audio is None and job.get("inputs", {}).get("audio") and pathlib.Path(job["inputs"]["audio"]).exists():
            audio, source = audio_track(job["inputs"]["audio"]), "the voice track sent"
        if audio is None or len(frames) < 8:
            return {"_note": "no sound to compare the mouth with"}
        box = None
        try:
            from PIL import Image  # noqa: PLC0415

            f = self.faces().largest(Image.fromarray(frames[len(frames) // 2]))
            box = f and f["box"]
        except Missing:
            pass
        h, w = frames.shape[1:3]
        if box:
            x0, y0, x1, y1 = box
            mouth = (int(y0 + 0.62 * (y1 - y0)), int(min(h, y1 + 0.05 * (y1 - y0))), int(x0 + 0.25 * (x1 - x0)), int(x0 + 0.75 * (x1 - x0)))
        else:  # no detector: the lower middle of the frame, where a talking head's mouth usually is
            mouth = (int(0.55 * h), int(0.85 * h), int(0.3 * w), int(0.7 * w))
        region = frames[:, mouth[0] : max(mouth[0] + 2, mouth[1]), mouth[2] : max(mouth[2] + 2, mouth[3])].mean(axis=-1)
        motion = maths.motion_energy(region)
        env = maths.frame_envelope(audio, 16000, rate, len(frames))
        best = maths.best_lag_correlation(motion, env, max_lag=int(round(rate * 0.5)))
        res = {"lipsync": round(max(0.0, best["corr"]), 4), "lipsyncOffset": best["lag"], "_note": f"proxy: mouth-region motion vs {source}{' (face box)' if box else ' (fixed region, no face detector)'}"}
        cmd = os.environ.get("FUOBE_EVAL_SYNCNET_CMD")
        if cmd:
            import shlex  # noqa: PLC0415
            import subprocess  # noqa: PLC0415

            r = subprocess.run([*shlex.split(cmd), str(clips[0])], capture_output=True, text=True, timeout=1800)
            try:
                s = json.loads(r.stdout.strip().splitlines()[-1])
                res["syncnet"] = float(s["confidence"])
                res["syncnetOffset"] = s.get("offset")
            except (ValueError, KeyError, IndexError):
                res["_note"] += f"; SyncNet command gave no JSON ({(r.stderr or '').strip()[:120]})"
        return res


    def m_separation(self, job, outs):
        stems = audio_outputs(self.run_dir, job)
        if not stems:
            return {"_note": "no audio stems in the result"}
        refs, meta = references_of(job)
        sr = int(meta.get("sampleRate") or 44100)
        res: dict = {}
        notes = []
        got = {k: audio_channels(p, sr) for k, p in stems.items()}
        got = {k: v for k, v in got.items() if v is not None}
        # A model without a bed stem (Demucs: drums, bass, other) gets one from every stem that isn't the voice.
        if "background" not in got:
            rest = [v for k, v in got.items() if k != "voice"]
            if rest:
                got["background"] = sum(sep.crop(*rest)) if len(rest) > 1 else rest[0]
        src = input_file(job)
        mix = audio_channels(src, sr) if src else None
        # Stems from a decoded AAC or a hosted model can sit a few hundred samples off: line each one up with the input.
        anchor = mix if mix is not None else (audio_channels(refs["mix"], sr) if "mix" in refs else None)
        if anchor is not None:
            probe = sum(sep.crop(got["voice"], got["background"])) if "voice" in got and "background" in got else next(iter(got.values()))
            lag = sep.best_offset(probe, anchor, max_lag=4096)
            if lag:
                got = {k: sep.shift(v, lag) for k, v in got.items()}
                notes.append(f"stems shifted {lag} samples to line up with the input")
        if mix is not None and "voice" in got and "background" in got:
            res["mixError"] = sep.mixture_error([got["voice"], got["background"]], mix)["db"]
            scale = sep.bed_scale(got["background"], got["voice"], mix)
            if scale is not None:
                res["bedScale"] = scale
        for name in ("voice", "music", "effects", "background"):
            if name in got and name in refs:
                ref = audio_channels(refs[name], sr)
                if ref is None:
                    continue
                res[f"{name}SiSdr"] = round(sep.si_sdr(got[name], ref), 2)
                if name in ("voice", "background"):
                    res[f"{name}Sdr"] = round(sep.sdr(got[name], ref), 2)
        # Clean up dialogue (graph C): one file, the dialogue with the music and effects at the levels asked for. It is
        # scored against what was asked (the voice plus the known bed at that level) and for where the bed landed.
        remix = remix_levels(job)
        if remix is not None and "voice" in got and "voice" in refs and "background" in refs:
            vref, bref = audio_channels(refs["voice"], sr), audio_channels(refs["background"], sr)
            if vref is not None and bref is not None:
                want = sep.mono(vref) * 10 ** (remix["voiceDb"] / 20) + sep.mono(bref) * 10 ** (remix["bedDb"] / 20)
                res["remixSiSdr"] = round(sep.si_sdr(got["voice"], want), 2)
                gains = sep.remix_gains(got["voice"], vref, bref)
                if gains["bed"] is not None:
                    res["bedLevel"] = gains["bed"]
                res["bedPeak"] = round(sep.peak_db(got["voice"]), 2)
                res["_remix"] = {**remix, "gains": gains}
                notes.append(f"one file (the dialogue with music and effects at {remix['bedDb']:g} dB): voiceSiSdr is against the voice alone, remixSiSdr against the voice plus the known bed at that level, bedLevel the bed's gain in it")
        if "background" in got and "background" in refs:
            ref = audio_channels(refs["background"], sr)
            lv = sep.bed_level(got["background"], ref)
            res["bedLevel"], res["bedPeak"] = lv["delta"], lv["peak"]
            st = sep.stereo_check(got["background"], ref)
            res["stereoCorrGap"] = st["corrGap"]
            res["_stereo"] = st
        if "noise" in refs:
            share = sep.noise_share({k: v for k, v in got.items() if k in ("voice", "music", "effects")}, audio_channels(refs["noise"], sr))
            if "voice" in share:
                res["noiseInVoice"] = share["voice"]
            res["_noise"] = share
        report = text_output(self.run_dir, job, "report")
        speed = None
        if report:
            try:
                speed = sep.report_speed(json.loads(report))
            except ValueError:
                speed = None
        if speed is None and mix is not None and (job.get("comfy") or {}).get("execMs"):
            speed = (mix.shape[1] / sr) / (job["comfy"]["execMs"] / 1000.0)
            notes.append("speed from ComfyUI's time for the whole graph")
        if speed:
            res["speedX"] = round(speed, 3)
        if not refs:
            notes.append("no known stems for this input (a real clip: listen on the blind review page)")
        if notes:
            res["_note"] = "; ".join(notes)
        return res

    def m_wer(self, job, outs):
        _, meta = references_of(job)
        text = meta.get("text")
        if not text:
            return {"_note": "no known words for this input"}
        res: dict = {}
        transcript = text_output(self.run_dir, job, "transcript")
        if transcript:
            res["werTranscript"] = round(sep.wer(text, transcript)["wer"], 4)
        stems = audio_outputs(self.run_dir, job)
        src = input_file(job)
        voice = audio_track(stems["voice"]) if "voice" in stems else None
        heard = audio_track(src) if src is not None else None
        if voice is None and heard is None:
            return res
        # Whisper is optional (pnpm eval:setup --asr): without it the job's own transcript is still scored.
        try:
            asr = self.asr()
        except Missing as e:
            # Recorded under its own name so the family keeps running for the jobs that have a transcript.
            self.skipped.setdefault("wer (Whisper)", str(e))
            res["_note"] = f"wer and werInput skipped: {e}"
            return res
        if voice is not None:
            hyp = asr.text(voice)
            res["wer"] = round(sep.wer(text, hyp)["wer"], 4)
            res["_heard"] = hyp
        if heard is not None:
            res["werInput"] = round(sep.wer(text, asr.text(heard))["wer"], 4)
        return res


def group_continuity(scorer: Scorer, run_dir: pathlib.Path, jobs: list[dict]) -> dict:
    """Shot lists: the middle frame of each shot, CLIP-embedded, against the next shot's."""
    groups: dict[str, list[dict]] = {}
    for j in jobs:
        if j.get("shot") and "continuity" in j.get("metrics", []):
            groups.setdefault(f"{j['caseId']}|{j['variant']}|s{j['seed']}", []).append(j)
    out = {}
    for key, members in groups.items():
        members.sort(key=lambda j: j["shot"]["index"])
        pics = []
        for j in members:
            outs = media_outputs(run_dir, j)
            if outs:
                p = images_of(outs[0], frames=3)
                if p:
                    pics.append(p[len(p) // 2])
        if len(pics) >= 2:
            out[key] = {"continuity": round(maths.consecutive_similarity(scorer.clip().images(pics)), 4), "shots": len(pics), "jobs": [j["id"] for j in members]}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fuobe_metrics.score", description="Score an evaluation run's outputs.")
    ap.add_argument("run_dir")
    ap.add_argument("--metrics", help="families to compute (default: each job's own list)")
    ap.add_argument("--device", default="cpu", help="cpu (default), cuda, mps or auto")
    ap.add_argument("--clip-model", default="clip-b32", choices=["clip-b32", "clip-l14"])
    ap.add_argument("--style-model", default="clip", choices=["clip", "dinov2"], help="image embeddings for style similarity")
    ap.add_argument("--identity-model", default="auraface", choices=["auraface", "buffalo_l"])
    ap.add_argument("--accept-noncommercial", action="store_true", help="kept for older scripts: non-commercial metric models run unless --commercial-only")
    ap.add_argument("--commercial-only", action="store_true", help="refuse metric models whose licence is non-commercial (buffalo_l)")
    ap.add_argument("--face-detector", default="yunet", choices=["yunet", "scrfd"], help="finds faces for AuraFace: YuNet (MIT, default) or the SCRFD AuraFace ships (licence unclear)")
    ap.add_argument("--frames", type=int, default=24, help="frames sampled per clip for temporal metrics")
    ap.add_argument("--fps", type=float, default=8.0, help="sampling rate for temporal metrics")
    ap.add_argument("--force", action="store_true", help="recompute every job")
    args = ap.parse_args(argv)

    run_dir = pathlib.Path(args.run_dir).resolve()
    if not (run_dir / "run.json").exists():
        print(f"{run_dir} isn't a run folder (no run.json)", file=sys.stderr)
        return 2
    if not have_ffmpeg():
        print("The metrics need ffmpeg and ffprobe on PATH.", file=sys.stderr)
        return 2
    wanted = set(args.metrics.split(",")) if args.metrics else None
    if wanted and wanted - set(FAMILIES):
        print(f"Unknown metric {', '.join(sorted(wanted - set(FAMILIES)))} (have {', '.join(FAMILIES)})", file=sys.stderr)
        return 2

    out_file = run_dir / "metrics.json"
    previous = json.loads(out_file.read_text(encoding="utf8")) if out_file.exists() and not args.force else {}
    config = {"v": VERSION, "clip": args.clip_model, "style": args.style_model, "identity": args.identity_model, "faceDetector": args.face_detector if args.identity_model == "auraface" else "buffalo_l", "frames": args.frames, "fps": args.fps}
    scorer = Scorer(args)
    scorer.run_dir = run_dir
    jobs = read_jobs(run_dir)
    results: dict[str, dict] = {}
    started = time.time()
    for i, job in enumerate(jobs, 1):
        fams = [f for f in job.get("metrics", []) if f in FAMILIES and f != "continuity" and (not wanted or f in wanted)]
        fp = fingerprint(run_dir, job, {**config, "fams": fams})
        old = previous.get("jobs", {}).get(job["id"])
        if old and old.get("_fp") == fp:
            results[job["id"]] = old
            continue
        outs = media_outputs(run_dir, job)
        row: dict = {"_fp": fp}
        if wanted and old:
            # --metrics re-scores those families only: the job's other scores stay.
            redo = {k for f in wanted for k in FAMILIES.get(f, [])} | {f"_{f}Refs" for f in wanted}
            row.update({k: v for k, v in old.items() if k not in redo and k not in {"_fp", "_notes"}})
        notes = []
        for fam in fams:
            if fam in scorer.skipped:
                continue
            try:
                got = scorer.family(fam, job, outs)
            except Missing as e:
                scorer.skipped[fam] = str(e)
                continue
            except Exception as e:  # one bad file shouldn't stop the run's other scores
                notes.append(f"{fam}: {e}")
                continue
            note = got.pop("_note", None)
            refs = got.pop("_refs", None)
            for k in [k for k in got if k.startswith("_")]:
                row[f"_{fam}{k[1:].capitalize()}"] = got.pop(k)
            if note:
                notes.append(f"{fam}: {note}")
            if refs is not None:
                row[f"_{fam}Refs"] = refs
            row.update(got)
        if notes:
            row["_notes"] = notes
        results[job["id"]] = row
        print(f"[{i}/{len(jobs)}] {job['id']}: " + ", ".join(f"{k} {v}" for k, v in row.items() if not k.startswith("_")), file=sys.stderr)

    groups = {}
    if not wanted or "continuity" in wanted:
        try:
            groups = group_continuity(scorer, run_dir, jobs)
        except Missing as e:
            scorer.skipped["continuity"] = str(e)
    doc = {
        "version": VERSION,
        "computedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "device": scorer.device,
        "config": config,
        "models": {**previous.get("models", {}), **scorer.used},
        "skipped": scorer.skipped,
        "jobs": results,
        "groups": groups,
        "seconds": round(time.time() - started, 1),
    }
    tmp = out_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    tmp.replace(out_file)
    for fam, why in scorer.skipped.items():
        print(f"Skipped {fam}: {why}", file=sys.stderr)
    print(f"Wrote {out_file} ({len(results)} jobs, {len(groups)} groups)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
