#!/usr/bin/env bash
# Reproducible CPU-only ComfyUI install used to export + validate Fuobe's workflow library.
# (No GPU and no model weights are needed: validation uses zero-byte placeholder files.)
#
# Usage: scripts/comfy/install-comfyui.sh            # installs into /home/user/ComfyUI
#        COMFYUI_DIR=~/ComfyUI scripts/comfy/install-comfyui.sh
# Re-running is safe (existing clones are kept).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMFYUI_DIR="${COMFYUI_DIR:-/home/user/ComfyUI}"
# Versions the committed library was generated/validated with (2026-10-16; round-3 packs 2026-10-17).
# MiniMax H3's Sol-H3-VAE loader (#17411, 0df1646a) and H3 latent upscaler (#17412, 35060f01) were merged into master on
# 2026-10-28 and are in no release yet (v0.43.2 lacks them). Master 17ff1dcc (2026-11-01; frontend 1.57.6, workflow templates
# 0.11.100, comfy-kitchen 0.2.40, comfy-aimdo 0.6.0) has both, but the library has not been validated on it yet, so it is opt-in:
# COMFYUI_REF=17ff1dcce963bd9f23095ec9b28febbfc4db8388. Move the default only after a full re-validation on it (npm run build,
# node validate-workflows.mjs) updates the manifest's comfyuiCommit.
COMFYUI_REF="${COMFYUI_REF:-fc04da91b2ab12f99e4716371a7e4f98ac982597}"   # v0.41.0-7
PYTHON_VERSION="${PYTHON_VERSION:-3.13}"

declare -A NODES=(
  [ComfyUI-WanVideoWrapper]="https://github.com/kijai/ComfyUI-WanVideoWrapper 088128b224242e110d3906c6750e9a3a348a659b"
  [ComfyUI-VideoHelperSuite]="https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite 4d907bee61e92c2e65af3bd6383a4e4d356126d1"
  [ComfyUI-KJNodes]="https://github.com/kijai/ComfyUI-KJNodes 17195fcfa8a05f601b766a0f09c9733284f47416"
  [ComfyUI-Frame-Interpolation]="https://github.com/Fannovel16/ComfyUI-Frame-Interpolation 26545cc2dd95bc3d27f056016300673bdeee78f5"
  # 3.3.0 (2026-10-20; no tag, so the commit): adds AILab_VRMBG (Bria VRMBG 3.0) and AILab_FeyNoBg for nm10-keying; RMBG and
  # ClothesSegment keep their inputs. Its requirements add nobg and refiners.
  [ComfyUI-RMBG]="https://github.com/1038lab/ComfyUI-RMBG a66a5e641a54988d80ed6aad18946081c85f309e"
  [ComfyUI-ReActor]="https://github.com/Gourieff/ComfyUI-ReActor 3be5f356fe5b120a7a274d2509c0ecef5d0a7498"
  [ComfyUI-MMAudio]="https://github.com/kijai/ComfyUI-MMAudio 8eaeb72edc3aaf2059b57f2d96a1f6f689f19ae2"
  # audio / video-depth packs added with the comfyui-oss-2 workflows (2026-10-16)
  [ComfyUI_Fill-ChatterBox]="https://github.com/filliptm/ComfyUI_Fill-ChatterBox f7d7a16187430abcaf91a3039b9c83aa9960816a"
  [ComfyUI-IndexTTS2]="https://github.com/snicolast/ComfyUI-IndexTTS2 5b33e02bc0112b8aaf1fc823d5e5a609ca07fc27"
  [ComfyUI-Video-Depth-Anything]="https://github.com/yuvraj108c/ComfyUI-Video-Depth-Anything a0db08e63d1ea571601c45cde4aaee0acdd0544d"
  # round-3 packs (2026-10-17, docs/research/comfyui-oss-3.md): voice separation, ASR/subtitles, foley
  [ComfyUI-MelBandRoFormer]="https://github.com/kijai/ComfyUI-MelBandRoFormer 92c86854e6654f4aacc97484471af95c98ea16d4"
  [ComfyUI-QwenASR]="https://github.com/1038lab/ComfyUI-QwenASR 3f9a652a617e578e4e3bd090e3dbc75274bf4775"
  [ComfyUI-HunyuanVideo-Foley]="https://github.com/phazei/ComfyUI-HunyuanVideo-Foley afd2960b8ad9036a9f55a15daf514112ff68e010"
  # round 4 (2026-10-22): VTracer image → SVG (the Vectorize app's open route)
  [ComfyUI-ToSVG]="https://github.com/Yanick112/ComfyUI-ToSVG 1022ba05318dccb4fe586ce5bbd09f1f0b3c7909"
  # DBS soundtrack separation (dialogue / music / effects; docs/research/dbs-separation-7.md §4). MIT code, vendored DBS
  # code Apache-2.0. The Comfy Registry flags its only version (0.1.0, dbs-soundtrack-separation) and gives no public
  # reason; the code was read at this commit (no network, exec or download paths in the nodes). It needs einops and
  # safetensors only, both already installed below. Weights: the DBS_WEIGHTS block at the end of this script.
  [ComfyUI-DBS]="https://github.com/hiroki-abe-58/ComfyUI-DBS f656e53434b5485c148a2866fbd6ddc6b6152ed6"
  # Lightricks' LTX nodes for Restore & colourise (package archive-restore): LTXICLoRALoaderModelOnly, LTXAddVideoICLoRAGuide
  # and LTXVTiledFusionSampler (per-step tiled latent fusion). LTX-2 Community License (the repository's LICENSE: free below
  # US$10M annual revenue). Read at this commit (2026-10-20); its requirements are installed below.
  [ComfyUI-LTXVideo]="https://github.com/Lightricks/ComfyUI-LTXVideo 220e1d45aa0469f518e982102fca4dca92a61862"
  # MiniMax H3 video (minimax-h3-t2v / i2v / flf2v): larryvrh's turbo LoRA loader and sampler (Apache-2.0, v1.2.3, no
  # dependencies) and PlagueKind's SLA attention and AdaLN LoRA fix (MIT, v1.5.6; the SLA kernel imports triton, installed below).
  [ComfyUI-MiniMax-H3-Turbo]="https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo 77bfa67575b14e3be6214f1747732e540c68b5dd"
  [plaguekind-nodes]="https://github.com/PlagueKind/ComfyUI-PlagueKind-Nodes d58d006a4ea32c25c06499f2ff104f0852a045a6"
  # Green screen: hashu786's CorridorKey 2.0 nodes (Corridor Key Licence 2.0, like CorridorKey itself; they
  # vendor Corridor's CorridorKey 2.0 code unmodified at 485f5e9). Read at this commit: nothing is installed at run time; the
  # node downloads the 2.0 weights and the three frozen models it builds on (about 5.1 GB, into models/corridorkey2/) the
  # first time it runs, never at import (CORRIDORKEY2_NO_DOWNLOAD=1 turns that off). Its requirements are in the union below.
  [ComfyUI-CorridorKey2]="https://github.com/hashu786/ComfyUI-CorridorKey2 d1228b68796786acee92b6497f72a60d70d1a844"
  # Idol 3D's clean splats (image-to-splat-idol-clean; docs/research/idol-9.md §5.1-5.2): Nynxz's Idol nodes (Preprocess
  # Image, Camera, Prune Splat). Apache-2.0, no Python dependencies, no model code (the model runs on the core TripoSplat
  # nodes). Read at this commit: 3 AI-assisted commits on 2026-10-30, not in the Comfy Registry. It goes in the main
  # ComfyUI, not the isolated worker. Without it the provider runs image-to-splat-idol on core nodes.
  [ComfyUI-Idol]="https://github.com/Nynxz/ComfyUI-Idol 4d3a4f671028f0e062d9f004cda1a2dd73360d35"
  # World mode (world-hy-nomas-turn; research #10 §6.14): Nynxz's native Hy-Nomas port. Apache-2.0, no Python
  # dependencies; importing it registers the Nomas DiT and the PixelUMM decoder with the core loaders' model detection.
  # Read at this commit (2026-10-24, three commits, not in the Comfy Registry). Weights: about 25 GB from nynxz/Hy-Nomas
  # (model-pins.json), the PixelUMM decoder under the NVIDIA One-Way Noncommercial License.
  [ComfyUI-HyNomas]="https://github.com/Nynxz/ComfyUI-HyNomas a89e0515619924da71093aa3fe52dbb7104cb06e"
  # Watermark Remover (image-watermark-*): overflowofedge's Qwen watermark nodes (MIT), read at this commit (no network,
  # subprocess, eval or file writes). Its requirements.txt is NOT installed: it asks for opencv-contrib-python-headless,
  # which next to opencv-python can leave cv2 broken; core cv2 has every function it uses, and segment-anything is in the
  # union below. Its SAM ViT-B file goes in models/sams (the SAM ViT-B block near the end).
  [ComfyUI-Qwen-Watermark]="https://github.com/overflowofedge/ComfyUI-Qwen-Watermark eef829d34d6e9d0d2ae0c1386fab7371a864cf34"
)
# Licences are information (Settings → Models & licences has the switches): every pack is installed, the
# non-commercial ComfyUI-Whisper (CC-BY-NC-SA-4.0, used by the captions-whisper-burnin workflow) included.
# NC_PACKS=0 leaves the non-commercial packs out of this install.
if [ "${NC_PACKS:-1}" = "1" ]; then
  NODES[ComfyUI-Whisper]="https://github.com/yuvraj108c/ComfyUI-Whisper 006a709848259ed3d69e2f9fcfd7a75f6c860ddd"
fi

if [ ! -d "$COMFYUI_DIR/.git" ]; then
  git clone https://github.com/comfyanonymous/ComfyUI "$COMFYUI_DIR"
fi
if [ "${PIN:-1}" = "1" ]; then git -C "$COMFYUI_DIR" checkout -q "$COMFYUI_REF" || echo "warn: could not pin ComfyUI to $COMFYUI_REF"; fi

cd "$COMFYUI_DIR"
[ -x .venv/bin/python ] || uv venv --python "$PYTHON_VERSION" .venv
PY="$COMFYUI_DIR/.venv/bin/python"
uv pip install --python "$PY" torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
uv pip install --python "$PY" -r requirements.txt   # pulls comfyui-frontend-package + comfyui-workflow-templates*

for name in "${!NODES[@]}"; do
  read -r url ref <<<"${NODES[$name]}"
  dest="$COMFYUI_DIR/custom_nodes/$name"
  if [ ! -d "$dest/.git" ]; then git clone -q "$url" "$dest"; fi
  if [ "${PIN:-1}" = "1" ]; then
    git -C "$dest" fetch -q --depth 1 origin "$ref" 2>/dev/null || true
    git -C "$dest" checkout -q "$ref" 2>/dev/null || echo "warn: could not pin $name to $ref (using $(git -C "$dest" rev-parse --short HEAD))"
  fi
done

# Genjutsu's Character swap (docs/research/openjutsu-6.md §4): Akatz Labs' h3_character_swap pack (GPL-3.0) lives in a
# subfolder of their H3 Character Swap tool, pinned at the commit Openjutsu uses (the last one with the pack). It is
# used unpatched (the workflows send the resolution as "480" / "768") and needs FFmpeg and FFprobe on PATH; its own
# requirements (numpy, scipy, Pillow, opencv-python-headless) are in the union below. H3_PACK=0 leaves it out.
H3_TOOL_REF="${H3_TOOL_REF:-0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b}"
if [ "${H3_PACK:-1}" = "1" ] && [ ! -d "$COMFYUI_DIR/custom_nodes/h3_character_swap" ]; then
  h3tmp="$(mktemp -d)"
  # Each step is guarded (set -e): a failed fetch warns and the rest of the install goes on.
  if git clone -q --filter=blob:none --no-checkout https://github.com/akatz-labs/h3-character-swap-tool "$h3tmp/tool" \
    && git -C "$h3tmp/tool" sparse-checkout set --no-cone /worker_nodes/h3_character_swap/ \
    && git -C "$h3tmp/tool" checkout -q "$H3_TOOL_REF" \
    && cp -r "$h3tmp/tool/worker_nodes/h3_character_swap" "$COMFYUI_DIR/custom_nodes/h3_character_swap"; then
    :
  else
    echo "warn: could not fetch h3_character_swap at $H3_TOOL_REF"
  fi
  rm -rf "$h3tmp"
fi
if [ "${H3_PACK:-1}" = "1" ] && { ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; }; then
  echo "warn: the h3_character_swap pack needs ffmpeg and ffprobe on PATH (Genjutsu's Character swap)"
fi
# H3 Relay 2.0 (Akatz Labs' newer nodes for the same swap, GPL-3.0; the video-character-swap-h3-relay workflow) registers
# HTTP routes and an in-memory H3 layout compatibility layer when it loads, so it is opt-in: H3_RELAY=1 (or install it on
# the isolated worker, scripts/comfy/install-isolated-worker.sh, the same way).
H3_RELAY_REF="${H3_RELAY_REF:-e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220}"   # 2.0.1, 2026-10-21
if [ "${H3_RELAY:-0}" = "1" ]; then
  dest="$COMFYUI_DIR/custom_nodes/h3-relay"
  if [ -d "$dest/.git" ] || git clone -q https://github.com/akatz-ai/h3-relay "$dest"; then
    git -C "$dest" fetch -q --depth 1 origin "$H3_RELAY_REF" 2>/dev/null || true
    git -C "$dest" checkout -q "$H3_RELAY_REF" 2>/dev/null || echo "warn: could not pin h3-relay to $H3_RELAY_REF"
  else
    echo "warn: could not fetch h3-relay"
  fi
fi
# Open-H3 Regenerate 2K (Upscale → Video's "Regenerate · creative", docs/research/new-models-7.md §2.6): rdh9616's pack
# (Apache-2.0) runs NVIDIA's refine recipe, and its upscale node calls LBH-123-AI's H3 latent upscaler (MIT), so both go
# in. Opt-in, since the graph needs about 40 GB of new files and a 48 GB+ GPU: OPEN_H3_REGEN=1. The rdh pack needs av and
# safetensors, which ComfyUI's own requirements.txt already installs; the LBH pack has no requirements. (ComfyUI core
# master merged its own H3 latent upscaler on 2026-10-28, but the rdh pack looks up LBH's class by name.)
OPEN_H3_REGEN_REF="${OPEN_H3_REGEN_REF:-9b686c5ffd380e9d1351f9b8beef6d20d703ca3e}"   # v1.0.0, 2026-10-28
H3_LATENT_UPSCALER_REF="${H3_LATENT_UPSCALER_REF:-40316cf008b2fd8663263270669eb4da23f89d2c}"   # 2026-09-17
if [ "${OPEN_H3_REGEN:-0}" = "1" ]; then
  for pack in "ComfyUI-Open-H3-Regenerate https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate $OPEN_H3_REGEN_REF" \
              "Comfyui_Minimax_h3_latent_Upscaler https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler $H3_LATENT_UPSCALER_REF"; do
    read -r name url ref <<<"$pack"
    dest="$COMFYUI_DIR/custom_nodes/$name"
    if [ -d "$dest/.git" ] || git clone -q "$url" "$dest"; then
      git -C "$dest" fetch -q --depth 1 origin "$ref" 2>/dev/null || true
      git -C "$dest" checkout -q "$ref" 2>/dev/null || echo "warn: could not pin $name to $ref"
    else
      echo "warn: could not fetch $name"
    fi
  done
fi
# NVIDIA RTX Video (Upscale → Video "Quick · RTX", FPS Boost "RTX Frame Generation", SDR to HDR "RTX Video HDR";
# docs/research/new-models-10.md §6): Comfy-Org's ComfyUI Nvidia VFX Nodes 0.2.1 (Apache-2.0) and NVIDIA's nvidia-vfx
# runtime (its requirements.txt; NVIDIA Software License Agreement, a wheel from pypi.nvidia.com with the SDK's models).
# They run only on an NVIDIA RTX card (frame generation: RTX 40 or later) with a CUDA PyTorch (cu130 or newer, the
# pack's README) and a recent driver, so they go in only where nvidia-smi names an RTX card on an x86_64 machine (or
# RTX_VIDEO=1); RTX_VIDEO=0 leaves them out. nvidia-vfx 0.2.0.0 has no Linux arm64 wheel, so a DGX Spark (GB10) is skipped. This script installs CPU PyTorch: on a GPU server install a CUDA build too.
RTX_VIDEO_REF="${RTX_VIDEO_REF:-38d790ded00650681fa3645362efe28c8560cf40}"   # 0.2.1 (registry comfyui_nvidia_rtx_nodes), 2026-10-14
rtx_card="$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | grep -i -m1 -E 'RTX' || true)"
[ "$(uname -m)" = "x86_64" ] || rtx_card=""
if [ "${RTX_VIDEO:-auto}" = "1" ] || { [ "${RTX_VIDEO:-auto}" = "auto" ] && [ -n "$rtx_card" ]; }; then
  dest="$COMFYUI_DIR/custom_nodes/ComfyUI_Nvidia_VFX_Nodes"
  if [ -d "$dest/.git" ] || git clone -q https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes "$dest"; then
    git -C "$dest" fetch -q --depth 1 origin "$RTX_VIDEO_REF" 2>/dev/null || true
    git -C "$dest" checkout -q "$RTX_VIDEO_REF" 2>/dev/null || echo "warn: could not pin ComfyUI_Nvidia_VFX_Nodes to $RTX_VIDEO_REF"
    uv pip install --python "$PY" "nvidia-vfx==0.2.0.0" || echo "warn: could not install nvidia-vfx (NVIDIA RTX Video)"
    "$PY" -c 'import torch, sys; v = torch.version.cuda; sys.exit(0 if v and tuple(map(int, v.split(".")[:2])) >= (13, 0) else 1)' 2>/dev/null \
      || echo "warn: the NVIDIA RTX Video nodes need a CUDA PyTorch (cu130 or newer); this ComfyUI's PyTorch isn't one"
  else
    echo "warn: could not fetch ComfyUI_Nvidia_VFX_Nodes"
  fi
fi

# Kandinsky 6.0 (nm10-kandinsky6): Kandinsky Lab's own packs, each the comfyui/ folder of its repository (the Comfy Registry's
# kandinsky6 1.0.2 and kandinsky6-sr 0.1.2), pinned at the commits Fuobe's graphs follow: kandinsky6 (MIT; text / image to
# video with sound, ComfyUI 0.38+) and kandinsky6-sr (Apache-2.0; the VSR upscaler). Their requirements (einops,
# huggingface-hub, librosa, loguru, omegaconf, pydantic, pyyaml, safetensors) are in the union below. Neither downloads
# anything when it loads (their "Download models" button does, when clicked). K6_PACKS=0 leaves them out.
K6_REF="${K6_REF:-7ceeefad7fb625011f7db602c43893a989f19c15}"        # kandinskylab/kandinsky-6, 2026-10-25
K6_SR_REF="${K6_SR_REF:-b15e2aac526519c51f59dfec2b848355bb8902de}"  # kandinskylab/kandinsky-6-sr, 2026-10-20
if [ "${K6_PACKS:-1}" = "1" ]; then
  for pack in "kandinsky6 https://github.com/kandinskylab/kandinsky-6 $K6_REF" "kandinsky6-sr https://github.com/kandinskylab/kandinsky-6-sr $K6_SR_REF"; do
    read -r name url ref <<<"$pack"
    [ -d "$COMFYUI_DIR/custom_nodes/$name" ] && continue
    k6tmp="$(mktemp -d)"
    if git clone -q --filter=blob:none --no-checkout "$url" "$k6tmp/repo" \
      && git -C "$k6tmp/repo" sparse-checkout set --no-cone /comfyui/ \
      && git -C "$k6tmp/repo" checkout -q "$ref" \
      && cp -r "$k6tmp/repo/comfyui" "$COMFYUI_DIR/custom_nodes/$name"; then
      :
    else
      echo "warn: could not fetch $name at $ref"
    fi
    rm -rf "$k6tmp"
  done
fi

# Hi3D 1.0 mesh refinement (Image to 3D's "Refine detail", the mesh-refine-hi3d workflow; docs/research/hi3d-refine.json):
# T8star's Comfyui-Hi3d-T8 (MIT code; the Hi3D code it vendors and the weights are under the Hi3D Open License 1.0, which
# asks for "Powered by Hi3D 1.0" wherever its results show). Opt-in: HI3D=1. It needs an NVIDIA GPU of compute capability
# 8.0+ (RTX 30 series / A-series or newer) and CUDA 12: its requirements.txt pins spconv-cu126 2.3.8 and triton, and keeps
# ComfyUI's own torch. There is no CPU path. The weights (10.66 GB: Hi3D 7.73 GB, DINOv2-L 1.22 GB, CLIP ViT-L/14 1.71 GB)
# go into models/Hi3D/{hi3d,dino,clip}/ at pinned revisions, each checked with sha256sum -c; HI3D_WEIGHTS=0 skips them.
HI3D_REF="${HI3D_REF:-73848490976e6a9b0c735ce02984c03866a495e7}"   # v0.5.1, 2026-10-26
if [ "${HI3D:-0}" = "1" ]; then
  dest="$COMFYUI_DIR/custom_nodes/Comfyui-Hi3d-T8"
  if [ -d "$dest/.git" ] || git clone -q https://github.com/T8mars/Comfyui-Hi3d-T8 "$dest"; then
    git -C "$dest" fetch -q --depth 1 origin "$HI3D_REF" 2>/dev/null || true
    git -C "$dest" checkout -q "$HI3D_REF" 2>/dev/null || echo "warn: could not pin Comfyui-Hi3d-T8 to $HI3D_REF"
    uv pip install --python "$PY" -r "$dest/requirements.txt" || echo "warn: Comfyui-Hi3d-T8's requirements did not install (it needs an NVIDIA GPU with CUDA 12)"
  else
    echo "warn: could not fetch Comfyui-Hi3d-T8"
  fi
  if [ "${HI3D_WEIGHTS:-1}" = "1" ]; then
    HI3D_DIR="$COMFYUI_DIR/models/Hi3D"
    for spec in "hi3d hi3d-official/Hi3Dv1.0 d502e938cbedc6e87aba8884614c5ca6d177a4b6 model_index.json scheduler/scheduler_config.json vae/config.json vae/model.safetensors transformer_512/config.json transformer_512/model.safetensors transformer_1024/config.json transformer_1024/model.safetensors" \
                "dino facebook/dinov2-large 47b73eefe95e8d44ec3623f8890bd894b6ea2d6c config.json model.safetensors" \
                "clip openai/clip-vit-large-patch14 32bd64288804d66eefd0ccbe215aa642df71cc41 config.json model.safetensors"; do
      read -r sub repo rev files <<<"$spec"
      for f in $files; do
        [ -s "$HI3D_DIR/$sub/$f" ] && continue
        mkdir -p "$(dirname "$HI3D_DIR/$sub/$f")"
        if curl -fsSL --retry 3 -o "$HI3D_DIR/$sub/$f.part" "https://huggingface.co/$repo/resolve/$rev/$f"; then
          mv "$HI3D_DIR/$sub/$f.part" "$HI3D_DIR/$sub/$f"
        else
          rm -f "$HI3D_DIR/$sub/$f.part"
          echo "warn: could not download $repo/$f at $rev"
        fi
      done
    done
    (cd "$HI3D_DIR" && sha256sum -c --quiet <<'SHA'
8ba88311dccf23463c6e10dd0d3bd5e0c5c35d1608c6f466413b6428b5ad8e56  hi3d/transformer_512/model.safetensors
a2ca5e44dde51cacecd59b42fceeb5f14e75d55e6dd047337752c4e6f281008c  hi3d/transformer_1024/model.safetensors
605d207c77f8db0b33c567a5861252f0090cf3c3604dfda1cfee09e8f0b53f3e  hi3d/vae/model.safetensors
399fba97a95f22c36834418bc69373364a99af3a1153da1c0fb31db567c92e23  dino/model.safetensors
a2bf730a0c7debf160f7a6b50b3aaf3703e7e88ac73de7a314903141db026dcb  clip/model.safetensors
SHA
    ) || echo "warn: a Hi3D weight file is missing or failed its SHA-256 check (delete it from models/Hi3D and re-run)"
  fi
fi

# Tencent AuK (Audio → Edit speech and AuK speech, nm10-speech-edit; MIT code and weights): ComfyUI-AuK is the comfyui
# folder of Tencent-Hunyuan/AuK, which imports the auk package from the same checkout. So the whole repository is cloned
# beside custom_nodes at the pinned commit, installed editable with its [comfyui] extra, and the node folder linked into
# custom_nodes; its relative model paths (ckpts/...) then resolve inside that checkout. Opt-in, since the weights are about
# 19 GB and it wants a 24 GB+ NVIDIA GPU (17 GB with the loader's cpu_offload): AUK=1. AUK_WEIGHTS=1 also downloads
# AuK-Flash and the Qwen2.5-Omni-3B encoder into AuK/ckpts (AUK_BASE=1 adds the 32-step base model). The Prompt Enhancer
# stays off in Fuobe's graphs, so no LLM_* variables are needed.
AUK_REF="${AUK_REF:-0d40366b1039e37c6cad008ab4713f6ad6d954b7}"   # 2026-10-27
AUK_FLASH_REV="${AUK_FLASH_REV:-575b92f0895f75180bf2cbd35f2e176c5732b8ed}"
AUK_BASE_REV="${AUK_BASE_REV:-790742b71a4430120daf2b2099192abae449eb9f}"
AUK_QWEN_REV="${AUK_QWEN_REV:-f75b40e3da2003cdd6e1829b1f420ca70797c34e}"
if [ "${AUK:-0}" = "1" ]; then
  AUK_HOME_DIR="$COMFYUI_DIR/AuK"
  if [ -d "$AUK_HOME_DIR/.git" ] || git clone -q https://github.com/Tencent-Hunyuan/AuK "$AUK_HOME_DIR"; then
    git -C "$AUK_HOME_DIR" fetch -q --depth 1 origin "$AUK_REF" 2>/dev/null || true
    git -C "$AUK_HOME_DIR" checkout -q "$AUK_REF" 2>/dev/null || echo "warn: could not pin AuK to $AUK_REF"
    uv pip install --python "$PY" -e "$AUK_HOME_DIR[comfyui]" || echo "warn: AuK's Python package failed to install"
    ln -sfn "$AUK_HOME_DIR/comfyui/ComfyUI-AuK" "$COMFYUI_DIR/custom_nodes/ComfyUI-AuK"
    if [ "${AUK_WEIGHTS:-0}" = "1" ]; then
      uv pip install --python "$PY" "huggingface_hub[cli]"
      "$COMFYUI_DIR/.venv/bin/hf" download tencent/AuK-Flash --revision "$AUK_FLASH_REV" --local-dir "$AUK_HOME_DIR/ckpts/AuK-Flash" || echo "warn: could not download AuK-Flash"
      "$COMFYUI_DIR/.venv/bin/hf" download Qwen/Qwen2.5-Omni-3B --revision "$AUK_QWEN_REV" --local-dir "$AUK_HOME_DIR/ckpts/Qwen2.5-Omni-3B" || echo "warn: could not download Qwen2.5-Omni-3B"
      if [ "${AUK_BASE:-0}" = "1" ]; then
        "$COMFYUI_DIR/.venv/bin/hf" download tencent/AuK --revision "$AUK_BASE_REV" --local-dir "$AUK_HOME_DIR/ckpts/AuK" || echo "warn: could not download AuK"
      fi
    fi
  else
    echo "warn: could not fetch Tencent-Hunyuan/AuK"
  fi
fi

# Genjutsu's Openjutsu modes (D3voz/openjutsu @ 7fe118bb, MIT): Group swap, Scene edit, From picture, Fix faces and Fix
# colours. Opt-in, since the H3 graphs need about 52 GB of weights touched one stage after another: OPENJUTSU_MODES=1.
# Six packs, each pinned and cloned only (no pip: every Python dependency is already in ComfyUI's own requirements).
# SolarRenderer is NEVER pip-installed (its pyproject pins torch 2.8); the long-clip patch lets it render past 170 frames.
# The swap pack's H3 prompts get Fuobe's positive wording. Context Loop needs long paths on Windows. Its HTTP routes are
# local-only: keep ComfyUI on 127.0.0.1. H3-FaceRefine, Impact Pack and controlnet_aux come from the registry.
OJ_CONTEXT_LOOP_REF="${OJ_CONTEXT_LOOP_REF:-43afeffcc570beb5f7382593e79e4b211c7e02f6}"   # 0.7.3
OJ_PROMPT_BUILDER_REF="${OJ_PROMPT_BUILDER_REF:-22e719fe89336c628383363182a4da3cb58d4f9b}"   # 1.8.3
OJ_ONECLICK_SWAP_REF="${OJ_ONECLICK_SWAP_REF:-e44a56e92920000e675d14be484aea0d7498d63e}"
OJ_DETAIL_CONTRAST_REF="${OJ_DETAIL_CONTRAST_REF:-485a5e246424ce012b998862b45f06d21e8d63b2}"
OJ_ORION_FXMAX_REF="${OJ_ORION_FXMAX_REF:-7048e8423ad7d1a6a52119d0d4870c2b7fc2885f}"   # 1.0.0
OJ_SOLAR_REF="${OJ_SOLAR_REF:-0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d}"   # 1.0.0
if [ "${OPENJUTSU_MODES:-0}" = "1" ]; then
  for pack in "ComfyUI-MiniMaxH3-Context-Loop https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop $OJ_CONTEXT_LOOP_REF" \
              "ComfyUI-Fantastic-MiniMaxH3-PromptBuilder https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder $OJ_PROMPT_BUILDER_REF" \
              "comfyui-h3-oneclick-swap https://github.com/D3voz/comfyui-h3-oneclick-swap $OJ_ONECLICK_SWAP_REF" \
              "comfyui-image-detail-contrast https://github.com/D3voz/comfyui-image-detail-contrast $OJ_DETAIL_CONTRAST_REF" \
              "Orion4D_FXMax https://github.com/orion4d/Orion4D_FXMax $OJ_ORION_FXMAX_REF" \
              "SolarRenderer https://github.com/Enderfga/SolarRenderer $OJ_SOLAR_REF"; do
    read -r name url ref <<<"$pack"
    dest="$COMFYUI_DIR/custom_nodes/$name"
    if [ -d "$dest/.git" ] || git -c core.longpaths=true clone -q "$url" "$dest"; then
      git -C "$dest" fetch -q --depth 1 origin "$ref" 2>/dev/null || true
      git -C "$dest" -c core.longpaths=true checkout -q "$ref" 2>/dev/null || echo "warn: could not pin $name to $ref"
      patch=""
      [ "$name" = "SolarRenderer" ] && patch="$SCRIPT_DIR/patches/solarrenderer-long-clips.patch"
      [ "$name" = "comfyui-h3-oneclick-swap" ] && patch="$SCRIPT_DIR/patches/h3-oneclick-swap-wording.patch"
      # Fresh or already installed: applied once (a patch that reverses cleanly is already there).
      if [ -n "$patch" ] && ! git -C "$dest" apply --reverse --check "$patch" 2>/dev/null; then
        git -C "$dest" apply "$patch" || echo "warn: could not apply $(basename "$patch") to $name"
      fi
    else
      echo "warn: could not fetch $name"
    fi
  done
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    echo "warn: Genjutsu's Openjutsu modes need ffmpeg and ffprobe on PATH (the Context Loop pack assembles the clips with them)"
  fi
fi

# Fuobe's live edit nodes (fuobe_live.py, one file Fuobe ships, MIT): Live edit's loader, cached reference encode,
# crop, paste-back and socket save. Written from the copy in this checkout (src/lib/comfy-live-nodes.ts).
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/write-live-nodes.mjs" "$COMFYUI_DIR/custom_nodes" || echo "warn: could not write Fuobe's live nodes"
else
  echo "warn: node not found: download fuobe_live.py from Fuobe (Live edit's setup card) into $COMFYUI_DIR/custom_nodes"
fi

# Union of the packs' requirements, minus GPU-only / unbuildable extras
# (onnxruntime-gpu, cupy, groundingdino-py). triton + decord + pycocotools are needed only so
# ComfyUI-RMBG's SAM3 module imports (otherwise the whole RMBG pack fails to load).
uv pip install --python "$PY" \
  opencv-python opencv-python-headless imageio-ffmpeg color-matcher matplotlib mss ftfy \
  "accelerate>=1.2.1" "diffusers>=0.33.1" "peft>=0.17.0" "sentencepiece>=0.2.0" protobuf pyloudnorm "gguf>=0.17.1" scipy \
  "librosa>=0.10.1" "torchdiffeq>=0.2.3" "timm>=1.0.8" "omegaconf>=2.3.0" "open_clip_torch>=2.29.0" \
  "rotary_embedding_torch>=0.5.3" huggingface-hub transparent-background segment-anything onnxruntime hydra-core iopath \
  albumentations onnx ultralytics colour-science kornia insightface triton decord pycocotools \
  resampy s3tokenizer conformer soundfile einops easydict Imath OpenEXR
# ^ last line: ComfyUI_Fill-ChatterBox (Chatterbox TTS/VC) + ComfyUI-Video-Depth-Anything.
# ComfyUI-IndexTTS2 registers its nodes with numpy only (everything else is imported lazily), which is
# all validation needs. Its *runtime* stack (pynini, WeTextProcessing, modelscope, descript-audiotools, ...)
# is heavy and pins old versions; on a GPU server install it in an isolated worker:
#   INDEXTTS_RUNTIME=1 scripts/comfy/install-comfyui.sh   (pynini 2.1.7 has a cp313 wheel; 2.1.6 must be built)
if [ "${INDEXTTS_RUNTIME:-0}" = "1" ]; then
  uv pip install --python "$PY" "pynini>=2.1.6" WeTextProcessing cn2an ffmpeg-python g2p-en jieba json5 munch textstat modelscope \
    "git+https://github.com/descriptinc/audiotools" || echo "warn: IndexTTS2 runtime deps failed to install"
fi
# Chatterbox's Perth watermarker (recommended in production for cloned voices; optional for validation):
#   uv pip install --python "$PY" resemble-perth

# ComfyUI-HunyuanVideo-Foley needs loguru; ComfyUI-Whisper (unless NC_PACKS=0) needs openai-whisper (built from sdist).
# ComfyUI-MelBandRoFormer needs rotary_embedding_torch + einops (installed above).
# ComfyUI-QwenASR: do NOT install its requirements.txt (nagisa/DyNet38 have no cp313 wheels and are unused on the
# Hugging Face path); transformers>=5.13 from ComfyUI's requirements is all it needs.
uv pip install --python "$PY" loguru
# kandinsky6 / kandinsky6-sr (above): pydantic and pyyaml besides what the union has.
if [ "${K6_PACKS:-1}" = "1" ]; then uv pip install --python "$PY" "pydantic>=2.11.0" "pyyaml>=6.0.2" "safetensors>=0.8.0" || echo "warn: the Kandinsky packs' requirements failed to install"; fi
# ComfyUI-ToSVG imports vtracer (MIT), potracer and PyMuPDF (AGPL-3.0, used only by its SVG-to-image node) at load time.
uv pip install --python "$PY" "vtracer==0.6.15" "potracer==0.0.4" "PyMuPDF==1.26.5"
# ComfyUI-LTXVideo (Restore & colourise): its requirements.txt at the pinned commit. colour-science, diffusers, einops,
# huggingface_hub, kornia and transformers are already in the union above; OpenImageIO is for its HDR EXR nodes.
uv pip install --python "$PY" "ninja~=1.11.1.4" openimageio || echo "warn: ComfyUI-LTXVideo's extra requirements failed to install"
if [ "${NC_PACKS:-1}" = "1" ]; then uv pip install --python "$PY" "openai-whisper==20250625"; fi

# Optional isolated worker (never in this install or its venv): LatentSync 1.6 lipsync and ThinkSound SFX change
# process-wide state or pin old packages, so they run on a second ComfyUI with its own code copy, base directory,
# HOME and virtualenv: scripts/comfy/install-isolated-worker.sh (see README.md, "Isolated worker").
# The workflows lipsync-latentsync16 and sfx-thinksound carry "worker": "isolated" in manifest.json.

# ComfyUI-ReActor downloads ~1 GB of face-restore models into models/facerestore_models whenever that
# folder is empty -- even on a plain GET /object_info. On this validation-only (no weights) install keep a
# zero-byte placeholder there. Set REAL_MODELS=1 on a production server to skip this.
if [ "${REAL_MODELS:-0}" != "1" ]; then
  mkdir -p "$COMFYUI_DIR/models/facerestore_models"
  [ -n "$(ls -A "$COMFYUI_DIR/models/facerestore_models")" ] || touch "$COMFYUI_DIR/models/facerestore_models/placeholder_do_not_use.pth"
fi

# --- DBS weights (separate-soundtrack-dbs): 4 files, 23 MB, at the revisions docs/research/dbs-separation-7.md §3.1 read,
# into models/dbs/<model>/ (the ComfyUI-DBS loader reads config.json + model.safetensors from there), each checked with
# sha256sum -c. Small enough to fetch here; DBS_WEIGHTS=0 skips it.
if [ "${DBS_WEIGHTS:-1}" = "1" ]; then
  DBS_DIR="$COMFYUI_DIR/models/dbs"
  mkdir -p "$DBS_DIR/DBS-BSRNN-DnR" "$DBS_DIR/DBS-TIGER-DnR"
  for spec in "DBS-BSRNN-DnR 5af343f57f106fbb95efe8a60f1a3999eeb0aef8" "DBS-TIGER-DnR 22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b"; do
    read -r name rev <<<"$spec"
    for f in config.json model.safetensors; do
      [ -s "$DBS_DIR/$name/$f" ] && continue
      if curl -fsSL --retry 3 -o "$DBS_DIR/$name/$f.part" "https://huggingface.co/JusperLee/$name/resolve/$rev/$f"; then
        mv "$DBS_DIR/$name/$f.part" "$DBS_DIR/$name/$f"
      else
        rm -f "$DBS_DIR/$name/$f.part"
        echo "warn: could not download JusperLee/$name/$f at $rev"
      fi
    done
  done
  (cd "$DBS_DIR" && sha256sum -c --quiet <<'SHA'
26290f93e7b501113325e922e7b0c18edca944634e6b9be39856a55204628405  DBS-BSRNN-DnR/model.safetensors
57055e2b71913d98a4e1ed426b71617f0dfc372901cc5a8a3bc4a5c69415043e  DBS-BSRNN-DnR/config.json
3d8205743f2a6f5a6704f5d4104d7cf5bf7bf02dab2fd728da31f4c69225cadb  DBS-TIGER-DnR/model.safetensors
c7f7893323e78f9b99747a13090558a13c4f4b77383a38acb9979709fd04d1d8  DBS-TIGER-DnR/config.json
SHA
  ) || echo "warn: a DBS weight file is missing or failed its SHA-256 check (delete models/dbs/<model> and re-run)"
fi
# --- end DBS weights

# --- ComfyUI-RE-USE (Clean up voice: NVIDIA RE-USE speech enhancement). Fuobe's own pack, kept in this repository at
# comfy-nodes/ComfyUI-RE-USE (MIT; the network code adapted from NVIDIA's repository keeps its OpenMDW-1.1 notices). It is
# copied from the checkout this script runs in, so it always matches this install. It needs no Python package beyond
# ComfyUI's own (no mamba-ssm). REUSE_PACK=0 leaves it out.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ "${REUSE_PACK:-1}" = "1" ] && [ -d "$REPO_ROOT/comfy-nodes/ComfyUI-RE-USE" ]; then
  rm -rf "$COMFYUI_DIR/custom_nodes/ComfyUI-RE-USE"
  cp -r "$REPO_ROOT/comfy-nodes/ComfyUI-RE-USE" "$COMFYUI_DIR/custom_nodes/"
  rm -rf "$COMFYUI_DIR/custom_nodes/ComfyUI-RE-USE/tests"
fi
# RE-USE weights (voice-clean-reuse, voice-clean-bed-reuse): 2 files, 39 MB each, from the NemotronLabs repositories
# (OpenMDW-1.1) at pinned revisions, into models/reuse/, each checked with sha256sum -c. Never nvidia/RE-USE: that older
# release is non-commercial. The laughter model is the optional "Keep laughter". REUSE_WEIGHTS=0 skips them.
if [ "${REUSE_WEIGHTS:-1}" = "1" ]; then
  REUSE_DIR="$COMFYUI_DIR/models/reuse"
  mkdir -p "$REUSE_DIR"
  for spec in "NemotronLabs-RE-USE 31f82f2efad1095034492f236e8dac9239ba713b" "NemotronLabs-RE-USE-laughter 1b1521dd659608e1e063ada83e0acfe1da473a8b"; do
    read -r name rev <<<"$spec"
    [ -s "$REUSE_DIR/$name.safetensors" ] && continue
    if curl -fsSL --retry 3 -o "$REUSE_DIR/$name.safetensors.part" "https://huggingface.co/nvidia/NVIDIA-$name/resolve/$rev/model.safetensors"; then
      mv "$REUSE_DIR/$name.safetensors.part" "$REUSE_DIR/$name.safetensors"
    else
      rm -f "$REUSE_DIR/$name.safetensors.part"
      echo "warn: could not download nvidia/NVIDIA-$name at $rev"
    fi
  done
  (cd "$REUSE_DIR" && sha256sum -c --quiet <<'SHA'
06badaf4029b297f97f7fe48d62990b48d5482608210df577354e0d4e0ed70e1  NemotronLabs-RE-USE.safetensors
35c2a4e284515275d2e49a8e8cb5cd392ae67a1f1d345de1c12a0202c7b6b610  NemotronLabs-RE-USE-laughter.safetensors
SHA
  ) || echo "warn: a RE-USE weight file is missing or failed its SHA-256 check (delete it from models/reuse and re-run)"
fi
# --- end ComfyUI-RE-USE

# --- SAM ViT-B (image-watermark-remove-qwen21: sticker outlines), 375 MB (Meta's file, from a pinned Hugging Face mirror), into models/sams, checked with
# sha256sum -c before it is kept (a .pth can run code when it loads). Only with REAL_MODELS=1 (validation needs no weights).
if [ "${REAL_MODELS:-0}" = "1" ]; then
  SAM_DIR="$COMFYUI_DIR/models/sams"
  mkdir -p "$SAM_DIR"
  if [ ! -s "$SAM_DIR/sam_vit_b_01ec64.pth" ]; then
    if curl -fsSL --retry 3 -o "$SAM_DIR/sam_vit_b_01ec64.pth.part" "https://huggingface.co/ybelkada/segment-anything/resolve/7790786db131bcdc639f24a915d9f2c331d843ee/checkpoints/sam_vit_b_01ec64.pth" \
      && (cd "$SAM_DIR" && echo "ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912  sam_vit_b_01ec64.pth.part" | sha256sum -c --quiet); then
      mv "$SAM_DIR/sam_vit_b_01ec64.pth.part" "$SAM_DIR/sam_vit_b_01ec64.pth"
    else
      rm -f "$SAM_DIR/sam_vit_b_01ec64.pth.part"
      echo "warn: could not fetch SAM ViT-B (or it failed its SHA-256 check)"
    fi
  fi
fi
# --- end SAM ViT-B

echo "ComfyUI installed in $COMFYUI_DIR. Start it with: $SCRIPT_DIR/start-comfyui.sh"
