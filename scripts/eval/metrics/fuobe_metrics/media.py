"""Reading outputs and references: images (SVG demo art too, through ffmpeg's librsvg), a clip's
frames sampled at a fixed rate, and its sound. ffmpeg and ffprobe do the decoding."""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".svg"}
VIDEO = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
AUDIO = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}


def kind_of(path: str | pathlib.Path) -> str | None:
    ext = pathlib.Path(path).suffix.lower()
    return "image" if ext in IMAGE else "video" if ext in VIDEO else "audio" if ext in AUDIO else None


def have_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def load_image(path: str | pathlib.Path, max_side: int = 1024) -> Image.Image:
    """An RGB image; SVG is rasterised by ffmpeg (librsvg). Large images are shrunk to max_side."""
    p = pathlib.Path(path)
    if p.suffix.lower() == ".svg":
        if not have_ffmpeg():
            raise RuntimeError("an SVG output needs ffmpeg (with librsvg) to be read")
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "frame.png"
            r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-frames:v", "1", str(out)], capture_output=True)
            if r.returncode != 0 or not out.exists():
                raise RuntimeError(f"ffmpeg couldn't rasterise {p.name}: {r.stderr.decode(errors='replace').strip()[:200]}")
            img = Image.open(out).convert("RGB")
            img.load()
    else:
        img = Image.open(p).convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side))
    return img


def probe(path: str | pathlib.Path) -> dict:
    """{duration, fps, width, height, audio} of a clip."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe couldn't read {pathlib.Path(path).name}")
    j = json.loads(r.stdout or "{}")
    video = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    num, _, den = (video or {}).get("avg_frame_rate", "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    return {
        "duration": float(j.get("format", {}).get("duration") or 0),
        "fps": fps,
        "width": int((video or {}).get("width") or 0),
        "height": int((video or {}).get("height") or 0),
        "audio": any(s.get("codec_type") == "audio" for s in j.get("streams", [])),
    }


def video_frames(path: str | pathlib.Path, fps: float = 4.0, max_frames: int = 32, width: int = 256) -> tuple[np.ndarray, float]:
    """Frames sampled at `fps` (at most max_frames, spread over the clip), as uint8 N×H×W×3, and the rate they were taken at."""
    info = probe(path)
    rate = fps
    if info["duration"] > 0 and info["duration"] * fps > max_frames:
        rate = max_frames / info["duration"]
    w = width - width % 2
    h = max(2, int(round(info["height"] * w / max(1, info["width"]) / 2)) * 2) if info["width"] else w
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={rate},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg couldn't read {pathlib.Path(path).name}: {r.stderr.decode(errors='replace').strip()[:200]}")
    frames = np.frombuffer(r.stdout, dtype=np.uint8)
    n = len(frames) // (w * h * 3)
    return frames[: n * w * h * 3].reshape(n, h, w, 3)[:max_frames], rate


def video_window(path: str | pathlib.Path, start: float, seconds: float, rate: float, width: int, height: int) -> np.ndarray:
    """`seconds` of a clip from `start`, sampled at `rate` and scaled to width × height (to line it up with another clip's frames)."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{seconds:.3f}", "-i", str(path), "-vf", f"fps={rate},scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg couldn't read {pathlib.Path(path).name}: {r.stderr.decode(errors='replace').strip()[:200]}")
    frames = np.frombuffer(r.stdout, dtype=np.uint8)
    n = len(frames) // (width * height * 3)
    return frames[: n * width * height * 3].reshape(n, height, width, 3)


def audio_track(path: str | pathlib.Path, sr: int = 16000) -> np.ndarray | None:
    """The sound as mono float32 at `sr` Hz, or None when there is none."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        return None
    return np.frombuffer(r.stdout, dtype="<i2").astype(np.float32) / 32768.0


def images_of(path: str | pathlib.Path, frames: int = 4) -> list[Image.Image]:
    """A file as pictures: an image itself, or `frames` frames spread over a clip."""
    k = kind_of(path)
    if k == "image":
        return [load_image(path)]
    if k == "video":
        arr, _ = video_frames(path, fps=frames, max_frames=frames, width=384)
        if len(arr) > frames:
            arr = arr[np.linspace(0, len(arr) - 1, frames).astype(int)]
        return [Image.fromarray(a) for a in arr]
    return []


def audio_channels(path: str | pathlib.Path, sr: int = 44100) -> np.ndarray | None:
    """The sound with its channels kept (channels × samples, float32) at `sr` Hz, or None when there is none. Files with
    more than 2 channels come back as they are; the separation metrics compare mono stems with their mono mean."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        channels = int((r.stdout or "").strip().splitlines()[0])
    except (ValueError, IndexError):
        channels = 0
    if not channels:
        return None
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        return None
    a = np.frombuffer(r.stdout, dtype="<f4")
    n = len(a) // channels
    return a[: n * channels].reshape(n, channels).T.copy()
