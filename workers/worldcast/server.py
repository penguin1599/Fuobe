#!/usr/bin/env python3
"""Fuobe's WorldCast worker: a thin HTTP service around PixCtrol/WorldCast @ 7ccf2e0d (Apache-2.0).

The contract is docs/workers/worldcast.md in the Fuobe repository. Fuobe prepares each case (the still and its person
mask, the camera path's point-cloud render and hole mask, cam_info.json, the anchors and their masks); this server lays
it out the way WorldCast's demo_case/ is laid out, cuts the no_padding_black/ crops, and runs the same pipeline wiring
as WorldCast's demo.py (the released anchor-drop checkpoint's fixed architecture). One job at a time, in order.

Run it from WorldCast's own clone, in WorldCast's own virtualenv (README.md beside this file):

    WORLDCAST_REPO=/opt/WorldCast python server.py --port 8190

Nothing here is Fuobe's code at run time: Fuobe only talks to it over HTTP.
"""
import argparse
import hmac
import io
import json
import os
import shutil
import sys
import threading
import time
import traceback
import uuid
from collections import OrderedDict

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image

REPO = os.path.abspath(os.environ.get("WORLDCAST_REPO", "."))
WORK = os.path.abspath(os.environ.get("WORLDCAST_WORK_DIR", os.path.join(REPO, "fuobe_jobs")))
MODEL_ROOT = os.environ.get("WORLDCAST_MODEL_ROOT", os.path.join(REPO, "pretrained", "Wan2.1-I2V-14B-720P"))
CKPT = os.environ.get("WORLDCAST_CKPT", os.path.join(REPO, "checkpoints", "worldcast_bank.safetensors"))
BASE_DIT = os.environ.get("WORLDCAST_BASE_DIT", os.path.join(REPO, "checkpoints", "base_dit.safetensors"))
DEPTH_PRO_CKPT = os.environ.get("WORLDCAST_DEPTH_PRO", os.path.join(REPO, "checkpoints", "depth_pro.pt"))
MODEL_NAME = "PixCtrol/WorldCast@7ccf2e0"
KEEP_JOBS = 50
MAX_UPLOAD = 512 * 2**20
# A shared secret: when set, every call needs "Authorization: Bearer <token>" (Fuobe sends its WORLDCAST_TOKEN setting).
TOKEN = os.environ.get("WORLDCAST_TOKEN", "").strip()

VIEWS = ("front", "left_side", "right_side", "back")
FRAMES, FPS, WIDTH, HEIGHT = 81, 15, 480, 832
JOB_ID_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789")

app = FastAPI(title="Fuobe WorldCast worker")
jobs: "OrderedDict[str, dict]" = OrderedDict()
lock = threading.Lock()
wake = threading.Condition(lock)
state = {"ready": False, "error": None, "pipe": None, "parts": None, "depth_pro": None}


class Canceled(Exception):
    pass


# ---------------------------------------------------------------------------
# The pipeline, loaded once (demo.py's wiring)


def load_worldcast():
    for p in (REPO, os.path.join(REPO, "scripts", "infer")):
        if p not in sys.path:
            sys.path.insert(0, p)
    from safetensors.torch import load_file
    from infer_worldcast import load_pipeline, load_checkpoint
    from diffsynth.pipelines.worldcast_pipeline_interleave import model_fn_worldcast
    import demo  # WorldCast's own demo.py: BANK_CONFIG, ANCHOR_PRIORITY, build_bank, build_anchor_adapter

    pipe = load_pipeline(model_root=MODEL_ROOT)
    pipe.anchor_max_frames = 4
    pipe.use_anchor_nopad_mask = True
    pipe.use_anchor_no_padding_black = True
    pipe.use_anchor_random_count = True
    pipe.anchor_random_count_no_shuffle = True
    pipe.anchor_random_count_priority = demo.ANCHOR_PRIORITY
    pipe.anchor_random_count_min = demo.ANCHOR_K
    pipe.anchor_random_count_max = demo.ANCHOR_K
    pipe.anchor_random_count_zero_fill = True
    pipe.use_first_frame_anchor = True
    pipe.use_anchor_selected_views_order = True
    pipe.use_anchor_plucker = True
    pipe.model_fn = model_fn_worldcast
    ckpt = load_file(CKPT)
    camera_proj, i2v_channel_adapter = load_checkpoint(pipe, ckpt, init_dit_from=BASE_DIT)
    bank = demo.build_bank(pipe, ckpt)
    adapter = demo.build_anchor_adapter(pipe, ckpt)
    state["pipe"] = pipe
    state["parts"] = dict(camera_proj=camera_proj, i2v_channel_adapter=i2v_channel_adapter, source_self_attn_bank=bank, anchor_channel_adapter=adapter)


def depth_models():
    """The extra depth models this worker can run (Fuobe offers them only when listed in GET /health)."""
    out = []
    try:
        import depth_pro  # noqa: F401  (apple/ml-depth-pro, installed by hand: Apple research licence)

        if os.path.isfile(DEPTH_PRO_CKPT):
            out.append("depth-pro")
    except ImportError:
        pass
    # VGGT-Omega (facebook/VGGT-Omega, FAIR Noncommercial, gated) is not wired in this reference server yet.
    return out


# ---------------------------------------------------------------------------
# Cases: Fuobe's files laid out as WorldCast's demo_case/


def binary(mask: Image.Image) -> Image.Image:
    return mask.convert("L").point(lambda v: 255 if v >= 128 else 0)


def nopad(image: Image.Image, mask: Image.Image):
    """no_padding_black/: the person kept, the background black, cropped tight to the mask (the demo case's crops touch
    the person on all four sides and carry a 0/255 mask of the same size)."""
    m = binary(mask.resize(image.size, Image.NEAREST))
    box = m.getbbox()
    if box is None:
        raise ValueError("the person mask is empty: no person was found in a picture")
    rgb = np.array(image.convert("RGB"))
    rgb[np.array(m) < 128] = 0
    return Image.fromarray(rgb).crop(box), m.crop(box)


def write_case(job_dir: str, form) -> dict:
    render = os.path.join(job_dir, "render")
    anchors_dir = os.path.join(job_dir, "anchors")
    os.makedirs(os.path.join(render, "no_padding_black", "person_mask"), exist_ok=True)
    os.makedirs(os.path.join(anchors_dir, "no_padding_black", "person_mask"), exist_ok=True)
    os.makedirs(os.path.join(anchors_dir, "person_mask"), exist_ok=True)

    def data(name, required=True):
        f = form.get(name)
        if f is None or isinstance(f, str):
            if required:
                raise ValueError(f"{name} is missing")
            return None
        return f

    def image(name):
        return Image.open(io.BytesIO(data(name)))

    first = image("first_frame.png").convert("RGB")
    if first.size != (WIDTH, HEIGHT):
        raise ValueError(f"first_frame.png is {first.size[0]}x{first.size[1]}, not {WIDTH}x{HEIGHT}")
    first.save(os.path.join(render, "first_frame.png"))
    crop, cmask = nopad(first, image("person_mask.png"))
    crop.save(os.path.join(render, "no_padding_black", "first_frame.png"))
    cmask.save(os.path.join(render, "no_padding_black", "person_mask", "first_frame.png"))
    for name in ("render.mp4", "render_mask.mp4"):
        with open(os.path.join(render, name), "wb") as out:
            out.write(data(name))
    cam = json.loads(data("cam_info.json"))
    if len(cam.get("extrinsic", [])) != FRAMES:
        raise ValueError(f"cam_info.json needs {FRAMES} poses")
    with open(os.path.join(render, "cam_info.json"), "w") as out:
        json.dump(cam, out)
    aligned = data("anchors_aligned_camera_info.json", required=False)
    if aligned:
        with open(os.path.join(render, "no_padding_black", "anchors_aligned_camera_info.json"), "wb") as out:
            out.write(aligned)

    anchors = json.loads(form.get("anchors") or "[]")
    if len(anchors) > 4:
        raise ValueError("up to four anchors")
    selected, per_view = [], {}
    for a in anchors:
        side = a.get("side")
        if side not in VIEWS or side in per_view:
            raise ValueError(f"unknown or repeated anchor side {side!r}")
        pic = Image.open(io.BytesIO(data(a["image"]))).convert("RGB")
        crop, cmask = nopad(pic, Image.open(io.BytesIO(data(a["mask"]))))
        fname = f"body_view_{side}.png"
        pic.save(os.path.join(anchors_dir, fname))
        crop.save(os.path.join(anchors_dir, "no_padding_black", fname))
        cmask.save(os.path.join(anchors_dir, "no_padding_black", "person_mask", fname))
        cmask.save(os.path.join(anchors_dir, "person_mask", fname))
        per_view[side] = {"azimuth_deg": float(a.get("azimuth", 0))}
    selected = [v for v in VIEWS if v in per_view]
    with open(os.path.join(anchors_dir, "body_views_meta.json"), "w") as out:
        json.dump({"az_front_deg": 0.0, "left_sign": -1, "selected_views": selected, "per_view": per_view}, out)

    num = lambda k, d, cast=float: cast(form.get(k) or d)  # noqa: E731
    return dict(
        prompt=str(form.get("prompt") or ""),
        seed=num("seed", 42, int),
        steps=num("steps", 50, int),
        cfg=num("cfg", 5.0),
        shift=num("shift", 2.0),
        height=num("height", HEIGHT, int),
        width=num("width", WIDTH, int),
        render=render,
        anchors=anchors_dir if selected else "",
    )


def run_case(job: dict):
    from diffsynth.utils.data import save_video

    a = job["args"]
    total = a["steps"]

    def progress(it):
        for i, x in enumerate(it):
            if job.get("cancel"):
                raise Canceled()
            job["progress"] = round(0.02 + 0.93 * i / max(1, total), 3)
            yield x

    first = os.path.join(a["render"], "first_frame.png")
    video = state["pipe"](
        prompt=a["prompt"],
        reference_image_path=first,
        render_path=a["render"],
        input_image=Image.open(first).convert("RGB"),
        seed=a["seed"],
        tiled=True,
        height=a["height"],
        width=a["width"],
        num_frames=FRAMES,
        nframe=FRAMES,
        num_inference_steps=a["steps"],
        cfg_scale=a["cfg"],
        sigma_shift=a["shift"],
        invert_camera_extrinsic=False,
        viewpoint_anchors_path=a["anchors"],
        anchor_plucker_use_camera_proj=True,
        progress_bar_cmd=progress,
        **state["parts"],
    )
    out = os.path.join(job["dir"], "worldcast.mp4")
    save_video(video, out, fps=FPS, quality=5)
    job["output"] = out


def run_depth(job: dict):
    import depth_pro

    if state["depth_pro"] is None:
        cfg = depth_pro.depth_pro.DEFAULT_MONODEPTH_CONFIG_DICT
        cfg.checkpoint_uri = DEPTH_PRO_CKPT
        model, transform = depth_pro.create_model_and_transforms(config=cfg)
        model.eval()
        state["depth_pro"] = (model, transform)
    model, transform = state["depth_pro"]
    image, _, f_px = depth_pro.load_rgb(job["args"]["image"])
    depth = model.infer(transform(image), f_px=f_px)["depth"].squeeze().detach().cpu().numpy()
    # Near is bright: inverse depth spread over 0-255 (Fuobe's point cloud reads either way round).
    inv = 1.0 / np.clip(depth, 1e-3, None)
    lo, hi = np.percentile(inv, 1), np.percentile(inv, 99)
    grey = np.clip((inv - lo) / max(1e-6, hi - lo), 0, 1) * 255
    out = os.path.join(job["dir"], "depth.png")
    Image.fromarray(grey.astype(np.uint8)).save(out)
    job["output"] = out


def runner():
    while True:
        with wake:
            while not any(j["status"] == "queued" for j in jobs.values()):
                wake.wait()
            job = next(j for j in jobs.values() if j["status"] == "queued")
            job["status"] = "running"
            job["started"] = time.time()
        try:
            (run_depth if job["kind"] == "depth" else run_case)(job)
            job["status"], job["progress"] = "succeeded", 1.0
        except Canceled:
            job["status"], job["error"] = "failed", "stopped"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["status"], job["error"] = "failed", f"{type(e).__name__}: {e}"[:300]
        finally:
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass


def new_job(kind: str) -> dict:
    jid = uuid.uuid4().hex[:16]
    d = os.path.join(WORK, jid)
    os.makedirs(d, exist_ok=True)
    return {"id": jid, "kind": kind, "dir": d, "status": "queued", "progress": 0.0, "created": time.time()}


def enqueue(job: dict):
    with wake:
        jobs[job["id"]] = job
        # Forget the oldest finished jobs (and their files).
        done = [k for k, j in jobs.items() if j["status"] in ("succeeded", "failed")]
        for k in done[: max(0, len(jobs) - KEEP_JOBS)]:
            shutil.rmtree(jobs.pop(k)["dir"], ignore_errors=True)
        wake.notify()


def find(jid: str) -> dict:
    if not jid or set(jid) - JOB_ID_CHARS or jid not in jobs:
        raise HTTPException(404, "no such job")
    return jobs[jid]


async def read_form(request: Request):
    # A body without a length (chunked) is refused, so the cap can't be skipped; uvicorn holds a body to its stated length.
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        raise HTTPException(411, "send the case with a Content-Length")
    if int(length) > MAX_UPLOAD:
        raise HTTPException(413, "the case is too big")
    form = await request.form()
    out = {}
    for k, v in form.multi_items():
        out[k] = v if isinstance(v, str) else await v.read()
    return out


# ---------------------------------------------------------------------------
# HTTP


@app.exception_handler(HTTPException)
async def http_error(_req, e: HTTPException):
    return JSONResponse({"error": str(e.detail)}, status_code=e.status_code)


@app.middleware("http")
async def check_token(request: Request, call_next):
    if TOKEN:
        sent = request.headers.get("authorization", "")
        if not hmac.compare_digest(sent.encode(), f"Bearer {TOKEN}".encode()):
            return JSONResponse({"error": "this worker needs its token (WORLDCAST_TOKEN)"}, status_code=401)
    return await call_next(request)


@app.get("/health")
def health():
    vram = None
    try:
        import torch

        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_memory / 2**30
    except Exception:  # noqa: BLE001
        pass
    busy = any(j["status"] in ("queued", "running") for j in jobs.values())
    body = {"ok": state["ready"], "model": MODEL_NAME, "vram_gb": vram, "busy": busy, "depth": depth_models()}
    if state["error"]:
        body["error"] = state["error"]
    return body


@app.post("/cases")
async def cases(request: Request):
    if not state["ready"]:
        raise HTTPException(503, state["error"] or "still loading WorldCast's weights")
    form = await read_form(request)
    job = new_job("case")
    try:
        job["args"] = write_case(job["dir"], form)
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        shutil.rmtree(job["dir"], ignore_errors=True)
        raise HTTPException(422, str(e))
    enqueue(job)
    return {"id": job["id"]}


@app.post("/depth")
async def depth(request: Request):
    form = await read_form(request)
    model = form.get("model")
    if model not in depth_models():
        raise HTTPException(501, f"{model} isn't installed on this worker")
    pic = form.get("image")
    if not pic or isinstance(pic, str):
        raise HTTPException(422, "image is missing")
    job = new_job("depth")
    path = os.path.join(job["dir"], "image.png")
    Image.open(io.BytesIO(pic)).convert("RGB").save(path)
    job["args"] = {"image": path, "model": model}
    enqueue(job)
    return {"id": job["id"]}


@app.get("/jobs/{jid}")
def job_status(jid: str):
    j = find(jid)
    body = {"id": j["id"], "status": j["status"], "progress": j["progress"]}
    if j["status"] == "queued":
        ahead = [k for k, x in jobs.items() if x["status"] in ("queued", "running")].index(jid)
        body["message"] = f"{ahead} job(s) ahead" if ahead else "next"
    if j.get("error"):
        body["error"] = j["error"]
    return body


@app.get("/jobs/{jid}/video")
def job_video(jid: str):
    j = find(jid)
    if j["status"] != "succeeded" or j["kind"] != "case":
        raise HTTPException(409, "the clip isn't ready")
    return FileResponse(j["output"], media_type="video/mp4", filename="worldcast.mp4")


@app.get("/jobs/{jid}/depth.png")
def job_depth(jid: str):
    j = find(jid)
    if j["status"] != "succeeded" or j["kind"] != "depth":
        raise HTTPException(409, "the depth isn't ready")
    return FileResponse(j["output"], media_type="image/png", filename="depth.png")


@app.delete("/jobs/{jid}")
def job_cancel(jid: str):
    j = find(jid)
    if j["status"] == "queued":
        j["status"], j["error"] = "failed", "stopped"
    elif j["status"] == "running":
        j["cancel"] = True
    return {"ok": True}


def load_in_background():
    try:
        os.chdir(REPO)
        load_worldcast()
        state["ready"] = True
        print("WorldCast is ready", flush=True)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        state["error"] = f"WorldCast couldn't load: {type(e).__name__}: {e}"[:300]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8190)
    args = p.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not TOKEN:
        print("Warning: listening beyond this machine without WORLDCAST_TOKEN: anyone who reaches it can queue jobs on this GPU", flush=True)
    os.makedirs(WORK, exist_ok=True)
    threading.Thread(target=load_in_background, daemon=True).start()
    threading.Thread(target=runner, daemon=True).start()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
