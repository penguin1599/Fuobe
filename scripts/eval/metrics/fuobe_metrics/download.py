"""Fetch the metric weights at their pinned revisions: python -m fuobe_metrics.download [--identity] [--dinov2] [--asr] [--no-aesthetic].
They go to FUOBE_EVAL_CACHE (default ~/.cache/fuobe-eval); scoring downloads them on first use otherwise."""

from __future__ import annotations

import argparse
import sys

from .models import _download
from .registry import MODELS


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fuobe_metrics.download")
    ap.add_argument("--identity", action="store_true", help="also AuraFace (Apache-2.0) and YuNet (MIT) for identity and the lip-sync face box")
    ap.add_argument("--scrfd", action="store_true", help="also the SCRFD detector AuraFace ships (licence unclear), for --face-detector scrfd")
    ap.add_argument("--no-aesthetic", action="store_true", help="skip CLIP ViT-L/14 and the aesthetic head (about 1.7 GB)")
    ap.add_argument("--dinov2", action="store_true", help="also DINOv2 ViT-S/14 (Apache-2.0, 88 MB) for --style-model dinov2")
    ap.add_argument("--asr", action="store_true", help="also Whisper base.en (MIT, about 290 MB) for the separation suite's word error rate")
    args = ap.parse_args(argv)
    wanted = [("clip-b32", MODELS["clip-b32"]["file"])]
    if not args.no_aesthetic:
        wanted += [("clip-l14", MODELS["clip-l14"]["file"]), ("aesthetic-v2", MODELS["aesthetic-v2"]["file"])]
    if args.dinov2:
        wanted += [("dinov2-small", MODELS["dinov2-small"]["file"])]
    if args.asr:
        wanted += [("whisper-base-en", f) for f in MODELS["whisper-base-en"]["files"]]
    if args.identity:
        wanted += [("auraface", MODELS["auraface"]["recognition"]), ("yunet", MODELS["yunet"]["file"])]
    if args.scrfd:
        wanted += [("scrfd", MODELS["scrfd"]["file"])]
    for key, f in wanted:
        m = MODELS[key]
        print(f"{m['repo']} · {f} @ {m['revision'][:8]} ({m['licence']})", file=sys.stderr)
        print(f"  → {_download(key, f)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
