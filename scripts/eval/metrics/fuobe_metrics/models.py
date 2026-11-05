"""The models behind the metrics, loaded once and only when a metric needs them. Weights come from
Hugging Face at the revisions pinned in registry.py, into FUOBE_EVAL_CACHE (default
~/.cache/fuobe-eval). Everything runs on the CPU unless --device says otherwise."""

from __future__ import annotations

import os
import pathlib

import numpy as np

from .registry import MODELS

CACHE = pathlib.Path(os.environ.get("FUOBE_EVAL_CACHE", pathlib.Path.home() / ".cache" / "fuobe-eval"))


class Missing(RuntimeError):
    """A metric's library or weights aren't installed; the message says how to get them."""


def _torch():
    try:
        import torch  # noqa: PLC0415
    except ImportError as e:
        raise Missing("PyTorch isn't installed: run pnpm eval:setup") from e
    return torch


def device_of(want: str = "cpu") -> str:
    if want == "auto":
        torch = _torch()
        return "cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    return want


def _download(key: str, filename: str) -> str:
    try:
        from huggingface_hub import hf_hub_download  # noqa: PLC0415
    except ImportError as e:
        raise Missing("huggingface_hub isn't installed: run pnpm eval:setup") from e
    m = MODELS[key]
    return hf_hub_download(m["repo"], filename, revision=m["revision"], cache_dir=str(CACHE / "hf"))


class Clip:
    """open_clip image and text embeddings (L2-normalised numpy)."""

    def __init__(self, key: str = "clip-b32", device: str = "cpu"):
        try:
            import open_clip  # noqa: PLC0415
        except ImportError as e:
            raise Missing("open_clip isn't installed: run pnpm eval:setup") from e
        torch = _torch()
        m = MODELS[key]
        weights = _download(key, m["file"])
        self.key = key
        self.device = device
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(m["arch"], pretrained=weights, device=device)
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(m["arch"])
        self.torch = torch

    def images(self, pictures) -> np.ndarray:
        if not pictures:
            return np.zeros((0, 1))
        with self.torch.no_grad():
            out = []
            for i in range(0, len(pictures), 16):
                batch = self.torch.stack([self.preprocess(p) for p in pictures[i : i + 16]]).to(self.device)
                e = self.model.encode_image(batch)
                out.append(self.torch.nn.functional.normalize(e, dim=-1).float().cpu().numpy())
        return np.concatenate(out)

    def texts(self, texts: list[str]) -> np.ndarray:
        with self.torch.no_grad():
            tokens = self.tokenizer(texts).to(self.device)
            e = self.model.encode_text(tokens)
            return self.torch.nn.functional.normalize(e, dim=-1).float().cpu().numpy()


class Dino:
    """DINOv2 ViT-S/14 image embeddings through timm (Apache-2.0), at 224 px for the CPU: a style and content
    descriptor that, unlike CLIP, owes nothing to captions (--style-model dinov2)."""

    def __init__(self, device: str = "cpu"):
        try:
            import timm  # noqa: PLC0415
        except ImportError as e:
            raise Missing("timm isn't installed: run pnpm eval:setup") from e
        torch = _torch()
        m = MODELS["dinov2-small"]
        weights = _download("dinov2-small", m["file"])
        self.model = timm.create_model(m["arch"], pretrained=True, pretrained_cfg_overlay={"file": weights}, num_classes=0, img_size=224)
        self.model.eval().to(device)
        cfg = {**timm.data.resolve_data_config({}, model=self.model), "input_size": (3, 224, 224)}
        self.preprocess = timm.data.create_transform(**cfg)
        self.device = device
        self.torch = torch

    def images(self, pictures) -> np.ndarray:
        if not pictures:
            return np.zeros((0, 1))
        with self.torch.no_grad():
            out = []
            for i in range(0, len(pictures), 16):
                batch = self.torch.stack([self.preprocess(p.convert("RGB")) for p in pictures[i : i + 16]]).to(self.device)
                e = self.model(batch)
                out.append(self.torch.nn.functional.normalize(e, dim=-1).float().cpu().numpy())
        return np.concatenate(out)


class Aesthetic:
    """The LAION improved aesthetic predictor (v2, sac+logos+ava1 linear MSE) on CLIP ViT-L/14 embeddings: about 1–10."""

    def __init__(self, clip_l14: Clip):
        torch = clip_l14.torch
        nn = torch.nn
        self.clip = clip_l14
        self.head = nn.Sequential(
            nn.Linear(768, 1024),
            nn.Dropout(0.2),
            nn.Linear(1024, 128),
            nn.Dropout(0.2),
            nn.Linear(128, 64),
            nn.Dropout(0.1),
            nn.Linear(64, 16),
            nn.Linear(16, 1),
        )
        state = torch.load(_download("aesthetic-v2", MODELS["aesthetic-v2"]["file"]), map_location="cpu", weights_only=True)
        # The original checkpoint names the Sequential "layers".
        self.head.load_state_dict({k.removeprefix("layers."): v for k, v in state.items()})
        self.head.eval().to(clip_l14.device)

    def scores(self, pictures) -> np.ndarray:
        emb = self.clip.images(pictures)
        with self.clip.torch.no_grad():
            t = self.clip.torch.from_numpy(emb).to(self.clip.device)
            return self.head(t).squeeze(-1).float().cpu().numpy()


class Faces:
    """ArcFace-style face embeddings. AuraFace's recognition model (Apache-2.0) by default, with YuNet (MIT) finding
    and aligning the faces; --face-detector scrfd uses the SCRFD detector AuraFace ships instead (its licence is
    unclear). buffalo_l (non-commercial research) is opt-in and brings its own detector."""

    def __init__(self, name: str = "auraface", device: str = "cpu", detector: str = "yunet"):
        try:
            from insightface.app import FaceAnalysis  # noqa: PLC0415
        except ImportError as e:
            raise Missing("insightface isn't installed: run pnpm eval:setup --identity") from e
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
        self.name = name
        self.detector = detector if name == "auraface" else "own"
        self.app = None
        if self.detector == "yunet":
            import cv2  # noqa: PLC0415
            from insightface.model_zoo import get_model  # noqa: PLC0415

            self.rec = get_model(_download("auraface", MODELS["auraface"]["recognition"]), providers=providers)
            self.rec.prepare(ctx_id=0 if device == "cuda" else -1)
            self.yunet = cv2.FaceDetectorYN.create(_download("yunet", MODELS["yunet"]["file"]), "", (320, 320), 0.6, 0.3, 5000)
            return
        root = CACHE / "insightface"
        if name == "auraface":
            folder = root / "models" / "auraface"
            folder.mkdir(parents=True, exist_ok=True)
            for f in MODELS["auraface"]["files"]:
                target = folder / f
                if not target.exists():
                    target.symlink_to(_download("auraface", f))
        self.app = FaceAnalysis(name=name, root=str(root), providers=providers, allowed_modules=["detection", "recognition"])
        self.app.prepare(ctx_id=0 if device == "cuda" else -1, det_size=(640, 640))

    def _yunet_faces(self, bgr) -> list[dict]:
        """YuNet finds faces of about 10–300 px: try the picture at 640 px on its longest side, then at 320."""
        import cv2  # noqa: PLC0415

        from .maths import yunet_face  # noqa: PLC0415

        h, w = bgr.shape[:2]
        for side in (640, 320):
            scale = min(1.0, side / max(h, w))
            img = cv2.resize(bgr, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else bgr
            self.yunet.setInputSize((img.shape[1], img.shape[0]))
            _, rows = self.yunet.detect(img)
            if rows is not None and len(rows):
                return [yunet_face(r, scale) for r in rows]
        return []

    def largest(self, picture) -> dict | None:
        """The largest face in a PIL picture: {embedding, box} or None."""
        bgr = np.ascontiguousarray(np.asarray(picture.convert("RGB"))[:, :, ::-1])
        if self.app is None:
            from insightface.utils import face_align  # noqa: PLC0415

            faces = self._yunet_faces(bgr)
            if not faces:
                return None
            f = max(faces, key=lambda x: (x["box"][2] - x["box"][0]) * (x["box"][3] - x["box"][1]))
            crop = face_align.norm_crop(bgr, landmark=f["kps"], image_size=self.rec.input_size[0])
            emb = np.asarray(self.rec.get_feat(crop), dtype=np.float64).ravel()
            return {"embedding": emb / (np.linalg.norm(emb) or 1.0), "box": f["box"]}
        faces = self.app.get(bgr)
        if not faces:
            return None
        f = max(faces, key=lambda x: float((x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1])))
        return {"embedding": np.asarray(f.normed_embedding, dtype=np.float64), "box": [float(v) for v in f.bbox]}


class Asr:
    """Whisper base.en (transformers) on 16 kHz mono audio → text. Optional: pnpm eval:setup --asr."""

    def __init__(self, device: str = "cpu"):
        try:
            from transformers import WhisperForConditionalGeneration, WhisperProcessor  # noqa: PLC0415
        except ImportError as e:
            raise Missing("speech recognition needs transformers: run pnpm eval:setup --asr") from e
        torch = _torch()
        m = MODELS["whisper-base-en"]
        folder = None
        for f in m["files"]:
            folder = pathlib.Path(_download("whisper-base-en", f)).parent
        self.processor = WhisperProcessor.from_pretrained(str(folder))
        self.model = WhisperForConditionalGeneration.from_pretrained(str(folder)).to(device).eval()
        self.device = device
        self.torch = torch

    def text(self, audio: np.ndarray, sr: int = 16000) -> str:
        """The words in up to the first 30 s of each 30 s window, joined (the suite's clips are 10–30 s)."""
        out = []
        for i in range(0, max(1, len(audio)), 30 * sr):
            chunk = np.asarray(audio[i : i + 30 * sr], dtype=np.float32)
            if len(chunk) < sr // 10:
                continue
            feats = self.processor(chunk, sampling_rate=sr, return_tensors="pt").input_features.to(self.device)
            with self.torch.no_grad():
                ids = self.model.generate(feats)
            out.append(self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
        return " ".join(t for t in out if t)
