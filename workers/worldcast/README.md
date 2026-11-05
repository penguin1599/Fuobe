# WorldCast worker (reference server)

A small HTTP service that runs [PixCtrol/WorldCast](https://github.com/PixCtrol/WorldCast) on your own GPU, outside
ComfyUI, for Fuobe's Fly path, Turnaround and exact orbits. Fuobe prepares each case and sends it here. The contract is
[`docs/workers/worldcast.md`](../../docs/workers/worldcast.md).

`server.py` is Fuobe's code (it has no dependencies on the rest of Fuobe). WorldCast's own code runs inside it, from
WorldCast's clone, in WorldCast's own virtualenv. Read WorldCast's code before you run it, as you would any project
you download.

## What it needs

- **A GPU with at least 48 GB of VRAM** (WorldCast's README and model card). Runtime per clip isn't published; on one
  80 GB card expect tens of minutes (a guess from Uni3C's figures, not measured).
- **About 95 GB of disk**: the Wan 2.1 I2V 720P base (82.22 GB) and WorldCast's two checkpoints (10.38 GB in all,
  though the card says "~2 GB").
- Linux with CUDA 12.8, Python 3.10–3.12, ffmpeg.

## Install

Pin everything to the versions Fuobe was written against:

```bash
git clone https://github.com/PixCtrol/WorldCast /opt/WorldCast
cd /opt/WorldCast && git checkout 7ccf2e0ded1238bf6dea1b285c29bcf322e337cb
python -m venv .venv && . .venv/bin/activate
# WorldCast's verified combination (requirements.txt, 2026-10-23)
pip install torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128
pip install transformers==5.8.1
pip install -r requirements.txt
pip install -r /path/to/fuobe/workers/worldcast/requirements.txt

# Weights (both checkpoints must come from the same release)
hf download ly56/worldcast --revision 27635f27a2f9414dd8b78542eb390b565a288a53 \
  checkpoints/base_dit.safetensors checkpoints/worldcast_bank.safetensors --local-dir .
hf download Wan-AI/Wan2.1-I2V-14B-720P --revision 8823af45fcc58a8aa999a54b04be9abc7d2aac98 \
  --local-dir pretrained/Wan2.1-I2V-14B-720P
```

Expected sizes: `checkpoints/base_dit.safetensors` 8,401,611,192 bytes and `checkpoints/worldcast_bank.safetensors`
1,982,937,976 bytes.

## Check WorldCast first

Before you start the worker, run WorldCast's own demo once, so you know the install works on your GPU:

```bash
python demo.py --manifest demo_case_traj5.json \
  --model_root pretrained/Wan2.1-I2V-14B-720P \
  --ckpt checkpoints/worldcast_bank.safetensors \
  --init_dit_from checkpoints/base_dit.safetensors
```

It writes five clips to `outputs_demo/`. If that fails, the worker fails the same way.

## Start

```bash
cd /opt/WorldCast && . .venv/bin/activate
WORLDCAST_REPO=/opt/WorldCast python /path/to/fuobe/workers/worldcast/server.py --port 8190
```

It loads the weights in the background: `GET /health` answers `"ok": false` until they're in. Then add the address
in Fuobe, in **Settings → Open-source engine → WorldCast worker URL** (or `WORLDCAST_URL=http://127.0.0.1:8190`), and
press **Save & test**.

Listen on `127.0.0.1` (the default) when Fuobe runs on the same machine. If Fuobe runs elsewhere, never leave the worker
open: set `WORLDCAST_TOKEN` to a long random secret here and the same value as `WORLDCAST_TOKEN` in Fuobe's environment
(Fuobe sends it as `Authorization: Bearer …` on every call, and the worker answers 401 without it), and put it behind a
tunnel or a proxy that only Fuobe's server can reach. The server warns when it listens beyond this machine without a token.

| Variable | Default |
|---|---|
| `WORLDCAST_REPO` | the current folder |
| `WORLDCAST_MODEL_ROOT` | `$WORLDCAST_REPO/pretrained/Wan2.1-I2V-14B-720P` |
| `WORLDCAST_CKPT` | `$WORLDCAST_REPO/checkpoints/worldcast_bank.safetensors` |
| `WORLDCAST_BASE_DIT` | `$WORLDCAST_REPO/checkpoints/base_dit.safetensors` |
| `WORLDCAST_WORK_DIR` | `$WORLDCAST_REPO/fuobe_jobs` (the 50 latest jobs are kept) |
| `WORLDCAST_DEPTH_PRO` | `$WORLDCAST_REPO/checkpoints/depth_pro.pt` |
| `WORLDCAST_TOKEN` | none: no token asked (keep it on `127.0.0.1` then) |

## Optional: the paper's depth model

Fuobe measures depth with MoGe 2 (MIT) by default. The paper used Apple's **Depth Pro**, under Apple's research licence
(no commercial use). To offer it, install [apple/ml-depth-pro](https://github.com/apple/ml-depth-pro) into the same
virtualenv and put `depth_pro.pt` (apple/DepthPro @ `ccd1350a`) at `WORLDCAST_DEPTH_PRO`. `GET /health` then lists
`"depth": ["depth-pro"]`, and Fuobe offers it where its admin has it switched on in Settings → Models & licences.

**VGGT-Omega** (facebook/VGGT-Omega, FAIR Noncommercial, a gated download) is recorded in Fuobe with its licence and its
switch, but this reference server doesn't run it yet.

## Licences

- WorldCast code and weights: Apache-2.0. Its README says Stage 1 trained on SpatialVID (CC BY-NC-SA 4.0), which the
  authors used "strictly for academic research purposes and not for any commercial applications".
- Wan2.1-I2V-14B-720P: Apache-2.0.
- Depth Pro (optional): Apple ML Research licence, research only.
- VGGT-Omega (optional, not wired): FAIR Noncommercial Research License.
