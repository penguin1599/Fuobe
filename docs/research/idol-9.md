# Fuobe research #9: Idol, one picture to a 3D Gaussian splat

_As of 2026-10-30. Machine-readable twin: [`idol-9.json`](idol-9.json) (`verdict`, `idol`, `claims`, `weights`, `newWeightsBytes`, `licences`, `licencesForFuobe`, `pack`, `graphs`, `hosted`, `hostedSummary`, `fuobeToday`, `comparison`, `placements`, `plan`, `risks`, `unknowns`, `sources`). It builds on [`comfyui-oss-4.md`](comfyui-oss-4.md) (the core TripoSplat graph `image-to-splat-triposplat`, Fuobe's open splat today) and on the round-4 Image to 3D work (`src/lib/av/model3d.ts`)._

**What was asked.** The owner saw [speridlabs/idol](https://huggingface.co/speridlabs/idol), a new image-to-3D model that "works with low VRAM" and "generates in ~2 s", and the ComfyUI pack [Nynxz/ComfyUI-Idol](https://github.com/Nynxz/ComfyUI-Idol). This note checks those claims, records the weights and licences (as information, never as a gate), and says where Idol goes in Fuobe. The owner's rule "cloud only where it is hosted" applies: Idol gets a cloud route only if fal or Replicate host Idol itself.

**How this was produced.** Read-only. Two repositories were cloned with `--depth 1` into `/home/user/ext/` and read, never run: ComfyUI-Idol at `4d3a4f671028f0e062d9f004cda1a2dd73360d35` and speridlabs/idol-sdk at `4702a7f00850e34b6e83a2170cc123c3e9570744`. The HF repo's `README.md` and `config.json` at `2731c2291fc65a797c5cb627a5e5526fc1490902` were saved to `/home/user/ext/idol-hf`, and the nynxz/Idol and TripoSplat cards to `/home/user/ext/idol-cards`. `git ls-remote` on 2026-10-30 still shows both GitHub commits as HEAD. Model facts come from the Hugging Face API (sizes, LFS SHA-256, licence, gating). The safetensors headers and the first ≤32 KB of a few tensors were read with HTTP range requests, without downloading the files. fal and Replicate were checked through fal's queue OpenAPI, a full paged scan of `api.fal.ai/v1/models` and Replicate's model pages. The live CPU ComfyUI at `127.0.0.1:8188` was asked only read-only GETs, and its source at `/home/user/ComfyUI` (`fc04da91`, v0.41.0) was read. Fuobe was read at `claude/fuobe-parity-4` (`231e6346`). **Nothing was installed, nothing ran, and no paid call was made.** Every guess is marked as one.

## 1. The short version

- **Idol is TripoSplat with new weights.** Speridlabs (Alejandro Cañada, Chema Garabito) took VAST-AI-Research's TripoSplat architecture and trained different weights. One picture of one object goes in. A 3D Gaussian splat comes out (262,144 Gaussians by default), plus the camera the model thinks the picture was taken from. No mesh, no textures (§2).
- **It runs on Fuobe's existing graph.** ComfyUI 0.41 loads Idol's converted files into its stock TripoSplat nodes. Fuobe's `image-to-splat-triposplat` graph needs only two other weight files (1.32 GB) and Idol's sampler settings (50 Euler steps, cfg 4). No custom node is required (§5.5).
- **"~2 seconds" does not hold.** The card says "can run in under 2 seconds" but gives no settings. Every published number is slower: 3.4 s on a B300, 6.7 s on an H100, 14.1 s on an RTX 5090, 19.1 s on an RTX 4090, 46.2 s on an RTX 3080 (Speridlabs' own table, compiled SDK). In ComfyUI the pack author reports about 22–26 s on an RTX 5090 (§3).
- **"Low VRAM" means about 8 GB.** Speridlabs measured a 7.2 GB peak and says "under 8 GB". That is the same class as TripoSplat (Fuobe's manifest says 8 GB), not a 4–6 GB model. Nobody has measured it in ComfyUI (§3).
- **The quality lead is the vendor's own and small.** On Speridlabs' benchmark Idol beats TripoSplat by +0.014 SSIM, +0.002 IoU and +0.038 DINOv2 similarity. There is no paper, no named test set and no independent check. The weights really are different from TripoSplat's (sampled cosine 0.02–0.26 in the denoiser), so a real difference is plausible (§2.3, §3).
- **The raw output is hazy.** About half the Gaussians are nearly transparent and show as a fuzzy halo. Core ComfyUI can hide it in the orbit video (RenderSplat's opacity threshold) but cannot remove it from the saved file. The pack's `Idol Prune Splat` node can (§2.4, §5).
- **Licences are clean.** Idol's weights are Apache-2.0 and not gated. The pack is Apache-2.0 with no Python dependencies. The DINOv3 encoder brings its "Built with DINOv3" notice, which Fuobe already shows for TripoSplat (§4).
- **Cloud route (corrected 2026-11-02).** On 2026-10-30 Idol was not on fal or Replicate. Since later that day fal hosts it as `speridlabs/idol` ($0.10 per generation), so Fuobe added a cloud half labelled Idol 3D (§6). fal's `tripo3d/triposplat` is a different model and must not be labelled Idol.
- **My verdict.** Idol is not as good as the pitch: not 2 s, not low-VRAM, and its quality edge is unproven. It is still **worth adding, cheaply**: a second open splat model in Image to 3D → Splat, built from a copy of a graph Fuobe already ships, Apache-2.0, 1.32 GB of new weights. Make TripoSplat or Idol the default only after a blind A/B. The build plan has nine packages; one is P0 (§9).

## 2. What Idol is

### 2.1 What goes in and what comes out

| | |
|---|---|
| Input | One RGB picture of one object: a render, a generated image or a photo. No multi-view input. |
| Background | Built in. BiRefNet cuts the object out unless the image already has a real alpha (`idol/preprocess.py` L13–37 in idol-sdk). The alpha is eroded by 1 px (3×3 min filter). |
| Crop | A square of *margin* × the object's bounding box, resized to 1024 × 1024 and composited on black. Margin 1.2 for `synthetic` (renders, generated images; the default) and 1.7 for `real` (photos) (`preprocess.py` L6). ComfyUI's stock `TripoSplatPreprocessImage` is exactly the `synthetic` crop (fixed 1.2, `comfy_extras/nodes_triposplat.py` L25–59). |
| Output | One splat, `num_gaussians` Gaussians (default 262,144; documented as 32,768–1,048,576 in multiples of 32). The SDK only floors to a multiple of 32 and enforces no range (`pipeline.py` L146–153); ComfyUI's `VAEDecodeTripoSplat` clamps to 32,768–1,048,576 (`nodes_triposplat.py` L21–22, L169–171). |
| File | A standard 3DGS `.ply`: 17 float32 values per Gaussian (position, zero normals, degree-0 colour, logit opacity, log scale, rotation), y-up (`gaussian.py` L106–128). About 68 bytes per Gaussian, so 17.8 MB at 262,144 (my arithmetic). ComfyUI's `SplatToFile3D` also writes `.spz` (about 10× smaller) and `.ksplat` (`nodes_gaussian_splat.py` L473–500). |
| Extras | The SDK writes the cropped input and a camera file (yaw, pitch, radius, fov; `camera.py` L7–18). In ComfyUI the camera is decoded by the pack's `Idol Camera` node. |
| Not included | No mesh, no texture, no PBR. Core `SplatToMesh` ("Extract Mesh from Splat") can make a vertex-coloured mesh (`nodes_gaussian_splat.py` L1533–1567). |

The project page lists 0.4 / 3.2 / 12.2 MB for one object at 32,768 / 262,144 / 1,048,576 Gaussians. Those are not `.ply` sizes (that would be 2.2 / 17.8 / 71.3 MB); my guess is a compressed web format such as `.spz`.

### 2.2 How it works

From `config.json` (1,335 bytes) and the SDK at `4702a7f`:

1. **Conditioning** (`idol/conditioning.py`): DINOv3 ViT-H+/16 image tokens (width 1280, layer-normed) and FLUX.2 VAE latent tokens (128 channels, 2×2-packed).
2. **Denoiser:** a rectified-flow DiT, 24 blocks, width 1024, 16 heads, 370.6M parameters. It denoises 8,192 latent tokens × 16 channels plus a 5-value camera token.
3. **Sampler** (`sampler.py` L43–70): Euler, 50 steps on `linspace(1, 0)` shifted by t′ = 3t / (1 + 2t). CFG is (1 + w)·cond − w·uncond with w = 3.0 against an all-zero negative. That is **ComfyUI cfg 4.0**, and the shift 3 is already TripoSplat's built-in shift in ComfyUI (`supported_models.py` L1677–1679).
4. **Decoders:** an octree decoder (50.8M) places `num_gaussians / 32` anchor points; a Gaussian decoder (237.3M) turns each anchor into 32 Gaussians.

Idol's own networks are 0.66B parameters. With BiRefNet (220.7M), DINOv3 (840.6M) and the FLUX.2 VAE (84.1M) a whole request is about 1.8B (HF card table).

- **Paper:** none for Idol. The project page ([speridlabs.com/research/idol](https://speridlabs.com/research/idol)) has a BibTeX entry `@misc{canada2026idol}` and the footer "v0.1 · 04.2026". The architecture's paper is TripoSplat, [arXiv:2605.16355](https://arxiv.org/abs/2605.16355) (Yan, Cao, Wang, Liang, Guo, 2026-05-08).
- **Released:** HF repo created 2026-10-28; last change 2026-10-29 at `2731c229`. idol-sdk has one commit (2026-10-29), no tags. HF Space `speridlabs/idol` (ZeroGPU A10G) runs a demo with compilation off (`demo/model.py` L12–14).

### 2.3 Its relation to TripoSplat

- **Same architecture.** The idol-sdk README says "Idol builds on TripoSplat". Its `config.json` matches the constants the pack's `scripts/convert.py` checks (L31–36). The safetensors headers of `nynxz/Idol` `idol_fp16` and `VAST-AI/TripoSplat` `triposplat_fp16` list the same 559 tensors with the same names, shapes, dtypes and offsets; the decoders match too (388 tensors). The 216-byte difference in file size is exactly the metadata `convert.py` adds.
- **Different weights.** Comparing the first ≤32 KB of several tensors: denoiser weight matrices have cosine similarity 0.02–0.26 against TripoSplat's (adaLN 0.04, block 0 qkv 0.26, block 20 MLP 0.11); norm gains 0.95. The decoders sit at 0.47–0.90. Independent random starts would give about 0.01. **My reading (a guess from 10 tensor prefixes):** Idol started from TripoSplat's MIT weights and was trained further, the denoiser a lot, the decoders less. Speridlabs does not say what it trained on or where it started.
- **ComfyUI support is TripoSplat's.** ComfyUI detects and loads the files through the TripoSplat classes (`comfy/model_detection.py` L832, `comfy/sd.py` L1093–1094) and recomputes the dropped `pos_pe` buffer (Sobol, seed 123; `comfy/ldm/triposplat/model.py` L257), which `convert.py` checks against the stored one (L80–83). TripoSplat first shipped in ComfyUI **v0.23.0**; ComfyUI v0.43.1's TripoSplat code is byte-identical to 0.41.0's. Core ComfyUI has no Idol-specific code.
- **Consequence for Fuobe.** In ComfyUI, Idol and TripoSplat cost the same per step. Speridlabs' "6.8 s against TripoSplat's 9.9 s on an H100" comes from its compiled SDK, not from a cheaper network.

### 2.4 The haze

The pack's README: "Idol emits about half of its gaussians with opacity under 0.05, and viewers draw all of them." The SDK's own `.ply` has the same halo, so it is the model, not the port. What removes it:

| Where | Core ComfyUI 0.41 | With ComfyUI-Idol |
|---|---|---|
| The orbit video | `RenderSplat` `opacity_threshold` (default 0; `nodes_gaussian_splat.py` L959–996) | the same, or prune first |
| A mesh | `SplatToMesh` `min_opacity` (default 0.02; L1560) | the same |
| **The saved `.spz` / `.ply`** | **nothing**: no core node prunes a splat | `Idol Prune Splat` (`min_opacity` 0.05, optional `max_scale`) |

Whether TripoSplat's splats have the same haze is not documented. A viewer with an opacity cut-off would also hide it (package idol-4).

## 3. The claims, checked

| Claim | What the sources show | Verdict |
|---|---|---|
| **Generates in ~2 s** (owner; the card and the SDK README say "can run in under 2 seconds") | No settings are given. Speridlabs' GPU table (50 steps, 262,144 Gaussians, median of 8 images, "same code and settings on every GPU"): B300 3.4 s, B200 3.6 s, H200 6.6 s, H100 6.7 s, RTX 5090 14.1 s, A100 16.3 s, L40S 16.6 s, RTX 4090 19.1 s, RTX 3080 46.2 s, L4 54.6 s. The project page's headline is "3.4 s", never 2 s. The SDK's default `optimize` path (torch.compile, batched CFG, cuDNN attention, TF32; "~1.7x faster", `pipeline.py` L35–74) is on by default, so the table most likely used it (inference). In ComfyUI without compilation the pack author reports about 18 s of sampling plus 4–8 s of decode on an RTX 5090. Guess: under 2 s needs fewer steps (the demo slider goes to 10) and fewer Gaussians on a B200/B300, warm-compiled. | **unconfirmed** |
| **Works with low VRAM** ("7.2 GB" on the card; "under 8 GB" on the project page) | Vendor-measured, GPU and settings not stated. About 3.7–4.4 GB of weights. An RTX 3080 10 GB is in their table. ComfyUI's decode estimate adds about 0.23 GB at 262,144 and 0.74 GB at 1,048,576 Gaussians on top of the 0.58 GB decoder (formula, `nodes_triposplat.py` L173–177; computed, not measured). An 8 GB-class model, like TripoSplat. | **partly** |
| **Runs on consumer GPUs** | RTX 5090 14.1 s, 4090 19.1 s, 3080 46.2 s in the SDK (vendor); about 22–26 s on an RTX 5090 in ComfyUI (pack author). Not independently checked. | **partly** |
| **Better than TripoSplat, TRELLIS and LGM** | Speridlabs' table, 1× H100 each, input view plus seven new views. Idol: SSIM 0.726, LPIPS 0.213, IoU 0.862, DINOv2 0.781, CLIP 0.885, sharpness distance 0.81, PSNR 12.25. TripoSplat: 0.712 / 0.225 / 0.860 / 0.743 / 0.868 / 1.03, PSNR 11.76. TRELLIS ("50 + 50 steps", version not stated; guess v1): 0.716 / 0.235 / 0.845 / 0.754 / 0.868 / 0.97, PSNR 11.89. LGM has the best PSNR (12.46). No paper, no named test set, no TRELLIS.2 or Hunyuan3D. | **unconfirmed** |
| **Up to 1,048,576 Gaussians** | True in ComfyUI (clamped there). In the SDK the range is only a docstring and CLI help. Both the pack README and ComfyUI's tooltip say 262,144 matches the octree's point density: more is denser, not more detailed. | **partly** |
| **Idol is TripoSplat retrained, so it runs natively in ComfyUI** | Same tensor tables; ComfyUI loads both through the same classes; the shift and `pos_pe` match; sampled weights differ (§2.3). The ComfyUI-vs-SDK numeric parity (3e-6 denoiser; 1e-4 to 3e-3 decoders) is the pack author's claim (`tests/parity.py`), not rerun. | **confirmed** |
| **Faster than TripoSplat** (6.8 s against 9.9 s on an H100) | Both numbers are Speridlabs'. The networks are the same size, so the gap is the SDK (compiled, batched) against TripoSplat's reference code. In Fuobe both run the same ComfyUI code: Idol is not faster at equal steps. Fuobe's TripoSplat graph runs 20 `dpmpp_2m` steps; Idol's reference is 50 Euler steps. | **partly** |
| **The pack needs nothing installed** | `pyproject.toml` `dependencies = []`; imports only `comfy.utils`, `comfy_api.latest`, `torch`, `logging`, `math`, `typing_extensions`; no network, subprocess, eval/exec, pickle or `torch.load`. The model loads through stock `UNETLoader` / `VAELoader`. The README's "ComfyUI 0.22 or newer" is wrong: TripoSplat landed in v0.23.0 (commit `462c27fd`, 2026-06-01). | **confirmed** |
| **Needs an NVIDIA GPU with CUDA** (SDK install line) | The code falls back to the CPU (`pipeline.py` L54) and never uses Apple MPS. ComfyUI's TripoSplat supports fp32 (`supported_models.py` L1685). No CPU or Apple timing is published; idol-sdk issues #1 (Apple Silicon) and #2 (CPU only) are unanswered. Guess from FLOPs: tens of minutes per object on a desktop CPU. | **partly** |
| **`nynxz/Idol` is a faithful conversion** | Six denoiser tensors match speridlabs' fp32 at cosine 1.000000 (max difference 1.5e-5 to 4.9e-4, fp16 rounding); four decoder tensors within 2.6e-5 to 4.9e-5; all 388 decoder keys present; only `pos_pe` dropped. Prefixes of 10 tensors, not whole files. | **partly** |

## 4. The weights and their licences

### 4.1 The files

| File | Repo @ revision | Bytes | SHA-256 | ComfyUI folder | Role |
|---|---|---|---|---|---|
| `diffusion_models/idol_fp16.safetensors` | [nynxz/Idol](https://huggingface.co/nynxz/Idol) @ `c718f2b1b95b353edd07d17e845719fc10880a44` | 741,107,210 | `cf452146f78e23a0d34be8f9f79bcde642b9a40ef493046c8e9d5f79096f6dd0` | `diffusion_models` | **new**: Idol's denoiser, fp16, `pos_pe` dropped |
| `vae/idol_decoder_fp16.safetensors` | nynxz/Idol @ `c718f2b1` | 576,148,658 | `c511d99eb668ec4b06d883cb6e43770bc35e3864e16e7058e8d6211ba5c509aa` | `vae` | **new**: octree + Gaussian decoders merged (`octree.` / `gs.` prefixes) |
| `clip_vision/dino_v3_vit_h.safetensors` | VAST-AI/TripoSplat @ `56a96e60` | 1,681,247,696 | `a29ef351…` | `clip_vision` | shared with TripoSplat (already in `KNOWN_MODELS`, `library.spec.mjs` L273) |
| `split_files/vae/flux2-vae.safetensors` | Comfy-Org/Flux-2-Dev @ `9630c1b4` (also VAST-AI/TripoSplat `vae/`) | 336,213,556 | `d64f3a68…` | `vae` | shared (L230; see the URL note below) |
| `background_removal/birefnet.safetensors` | Comfy-Org/BiRefNet @ `884af709` | 444,473,596 | `9ab37426…` | `background_removal` | shared (L168) |

New for Idol: **1.32 GB**. With the shared files: 3.78 GB, the same as TripoSplat.

**The source weights** (for the SDK, or for Fuobe's own conversion with `convert.py`): [speridlabs/idol](https://huggingface.co/speridlabs/idol) @ `2731c2291fc65a797c5cb627a5e5526fc1490902`, all F32: `denoiser.safetensors` 1,482,258,308 B (`ded2cacf…`), `decoder.safetensors` 203,171,696 B (`9da4d767…`), `decoder_gs.safetensors` 949,083,036 B (`3087eb8e…`), `birefnet.safetensors` 444,466,856 B (`44bbc97b…`; BiRefNet without its training heads), `config.json` 1,335 B. The full hashes are in the JSON twin.

**Which files to use.** `nynxz/Idol` is the pack author's re-upload, made by `convert.py` (its file metadata says so). Spot checks match speridlabs' fp32 within fp16 rounding (§3). Fuobe can pin it at `c718f2b1` with the two hashes above, or convert `speridlabs/idol` @ `2731c229` itself with `convert.py` at `4d3a4f6` and host nothing new. The pack README says the fp32 `denoiser.safetensors` loads straight into `UNETLoader` with an "unexpected key" warning; unverified, and the decoders still need merging.

**URL drift.** Fuobe's `flux2-vae` URL points to `Comfy-Org/flux2-dev`. That repo is now `Comfy-Org/Flux-2-Dev`; the old URL still works through a 307 redirect, same file. Worth updating when the manifest is next rebuilt.

**The SDK route needs gated repos.** The SDK downloads DINOv3 from `facebook/dinov3-vith16plus-pretrain-lvd1689m` (gated, manual approval) and the VAE from `black-forest-labs/FLUX.2-dev` (gated, automatic). The ComfyUI route uses the ungated copies above. Fuobe should use the ComfyUI route.

### 4.2 Licences, as information

For Settings → Models & licences. Nothing here is held back.

| Item | Licence | Notes | Source |
|---|---|---|---|
| Idol weights | **Apache-2.0** | Not gated. No non-commercial or territory terms. | HF API `cardData.license`; README front matter @ `2731c229` |
| nynxz/Idol converted files | **Apache-2.0** | Not gated; `base_model: speridlabs/idol`. | card @ `c718f2b1` |
| TripoSplat (the architecture, and likely Idol's starting weights) | **MIT** | "TripoSplat code and weight models are released under the MIT License". The sampled decoder weights correlate with TripoSplat's (§2.3). MIT asks for its notice to travel with substantial portions; neither Idol's card nor idol-sdk carries one. Information only: Fuobe shows "TripoSplat (MIT, VAST-AI-Research)" beside Idol's row. | TripoSplat GitHub README L62; HF card |
| idol-sdk code | Apache-2.0 | `idol/models/dit.py` is adapted from diffusers' `transformer_wan.py` (Apache-2.0). | `LICENSE`, `pyproject.toml` @ `4702a7f` |
| ComfyUI-Idol | **Apache-2.0** | `NOTICE`: ports idol-sdk's `preprocess.py` and `camera.py`; ships no model code. | `LICENSE`, `NOTICE` @ `4d3a4f6` |
| DINOv3 ViT-H+/16 | **DINOv3 License** | Royalty-free, commercial use allowed, trade-control limits, and the app must show "Built with DINOv3". Fuobe already does this for TripoSplat (`manifest.json` `image-to-splat-triposplat` licence; `model3d.ts` L67; `licences.ts` KNOWN L270). | Fuobe's manifest; HF API (`license: other`, `dinov3-license`) |
| FLUX.2 VAE | **Apache-2.0** | "The autoencoder is released under Apache 2.0". The `black-forest-labs/FLUX.2-dev` repo as a whole is FLUX Non-Commercial, and the Comfy-Org repo card names the FLUX.1 [dev] licence for the repo; the VAE file itself is Apache-2.0. Same SHA-256 everywhere. | github.com/black-forest-labs/flux2 README L111 |
| BiRefNet | **MIT** | | Comfy-Org/BiRefNet card |

**For `src/lib/licences.ts`.** The row comes from the new workflow's `license` string (rows are built from the manifest plus `NODE_PACKS`; header L1–11). The string should name Apache-2.0 for Idol, the TripoSplat MIT attribution, the DINOv3 License with its notice in the same words TripoSplat's uses (so `licenceInfo` finds the notice, L296ff), the FLUX.2 VAE and BiRefNet. If the pack is used (idol-2), add a `NODE_PACKS` row for ComfyUI-Idol (Apache-2.0).

## 5. The ComfyUI pack and the graph Fuobe would build

### 5.1 The pack

[Nynxz/ComfyUI-Idol](https://github.com/Nynxz/ComfyUI-Idol) at **`4d3a4f671028f0e062d9f004cda1a2dd73360d35`** (2026-10-30 07:44:55 +1000, "README: the halo is in the reference SDK's output too"; still `main` on `git ls-remote`). Apache-2.0. `pyproject.toml`: `comfyui-idol` 0.1.0, PublisherId `nynxz`, `requires-python >=3.10`, `dependencies = []`. Three nodes in category `3d/idol`, registered through `comfy_api.latest` `ComfyExtension` (`__init__.py` L11–23; `NODES` at `idol/nodes.py` L159). On the live server, `GET /object_info/<class>` returns `{}` for all three: not installed (and nothing was installed).

**`IdolPreprocessImage`** ("Idol Preprocess Image", `nodes.py` L17–74)

| Input | Type | Options / default |
|---|---|---|
| `image` | IMAGE | |
| `mode` | DynamicCombo | `synthetic` (1.2) · `real` (1.7) · `custom` (`crop_margin` FLOAT 1.0–4.0, default 1.2). In API JSON it is written like Fuobe's `CreateCameraInfo` `mode` / `mode.yaw`: `"mode": "real"`, or `"mode": "custom", "mode.crop_margin": 1.5`. |
| `mask` | MASK, optional | 1 = object. For a transparent PNG: Load Image's mask through Invert Mask. |
| `bg_removal_model` | BACKGROUND_REMOVAL, optional | used when no mask is connected; the node raises if both are missing (L59–63) |
| `erode_radius` | INT 0–16 | 1 (advanced) |
| `size` | INT 256–4096, step 16 | 1024 (advanced) |

Outputs: `image` (the object on black, size × size) and `mask`. One difference from the SDK: BiRefNet runs here on the original resolution (`comfy/bg_removal_model.py` L44–59); the SDK runs it after resizing the short side to 1024, so masks can differ slightly.

**`IdolCamera`** (`nodes.py` L77–111): input `samples` (LATENT; must be a KSampler output of a `TripoSplatConditioning` graph, because it reads the camera token). Outputs `camera_info` (LOAD3D_CAMERA) and `yaw`, `pitch`, `distance`, `fov` (FLOAT; `CreateCameraInfo`'s orbit convention). A batch uses its first item. An orthographic prediction becomes distance 1000.

**`IdolPruneSplat`** (`nodes.py` L114–156): inputs `splat` (SPLAT), `min_opacity` FLOAT 0–1 (default 0.05), `max_scale` FLOAT 0–1 (default 0 = off; advanced). Outputs `splat` (padded batch with per-item counts) and `count` INT (first item only, L156). It thresholds activated opacities, which is right: ComfyUI's SPLAT stores opacities in [0, 1] and linear scales (`comfy_api/latest/_util/geometry_types.py` L18–35).

### 5.2 Dependencies, risk scan and maturity

- **No dependencies, no compiled code.** No xformers, nvdiffrast, spconv, flash-attn or custom kernels. No downloads or network calls at run time. A grep of `idol/*.py` and `__init__.py` for `subprocess`, `os.system`, `eval`, `exec`, `pickle` and `torch.load` finds nothing. Weights load through ComfyUI's own loaders.
- **APIs it uses, all present in 0.41.0** (`/home/user/ComfyUI` @ `fc04da91`): `comfy_api/latest/_io.py` `BackgroundRemoval` L619, `Splat` L688, `Load3DCamera` L803, `DynamicCombo` L1231, `search_aliases` L1855, `advanced=` on inputs (L164ff); SPLAT counts (`geometry_types.py` L18–35); `bg_removal_model.encode_image` (L44). Real minimum ComfyUI: **v0.23.0** (TripoSplat), not the README's 0.22.
- **Not run by ComfyUI.** `scripts/convert.py` is run by hand (needs torch, safetensors, huggingface_hub; downloads the speridlabs files, checks the config constants and `pos_pe`, merges the decoders, writes fp16 / bf16 / fp32). `tests/parity.py` and `tests/e2e.py` import ComfyUI and idol-sdk for manual checks.
- **Maturity.** Brand new, one author. Three commits, all on 2026-10-30 within 24 minutes (`b471ad1`, `9c21eeb` adds Prune Splat, `4d3a4f6`). Every commit has a `Co-Authored-By` trailer for an AI model: AI-assisted code. 19 stars, 1 fork, no tags or releases. **Not in the Comfy Registry** (`api.comfy.org/nodes/comfyui-idol` → 404; search "idol" → 0). **Correction (2026-11-02, idol-2):** `api.comfy.org/nodes/comfyui-idol` now answers with a *different* pack: PedroMarinhoDev/ComfyUI-Idol ("Idol (image to 3D splat)", 1.0.0, created 2026-10-30 11:13 UTC, status flagged, ComfyUI ≥ 0.43.0). Nynxz's pack is still not in the Registry, so a Registry install of `comfyui-idol` would fetch the other author's code: Fuobe pins Nynxz's repository by commit (`packs.json` registry null). No CI. The code is small and readable (`nodes.py` 9,262 B, `camera.py` 3,804 B, `preprocess.py` 2,354 B); I found no bugs on reading. Edge cases: Prune's `count` reports item 0 only; Camera uses item 0 of a batch.

### 5.3 The pack's example workflow

`example_workflows/idol_image_to_splat.json` (22 nodes, all enabled): `LoadImage` (`idol_fox.webp`) → `LoadBackgroundRemovalModel` (birefnet) → **`IdolPreprocessImage`** (synthetic, 1, 1024) → `CLIPVisionLoader` (dino_v3_vit_h) + `VAELoader` (flux2-vae) → `TripoSplatConditioning` → `UNETLoader` (idol_fp16) → `KSampler` (seed 42, **50 steps, cfg 4.0, euler / simple**, denoise 1) with `TripoSplatSamplingPreview` → `VAELoader` (idol_decoder_fp16) → `VAEDecodeTripoSplat` (262,144, seed 0) → **`IdolPruneSplat`** (0.05 / 0) → `SplatToFile3D` (ply) → `SaveGaussianSplat` (`3d/idol`); **`IdolCamera`** → `RenderSplat` (1 frame, 1024, black); `RenderSplat` (72 frames, 768, #848484) → `CreateVideo` (24 fps) → `SaveVideo`; two `PreviewImage` and a note. Every stock class exists on Fuobe's 0.41.0 server (`GET /object_info`).

### 5.4 Core ComfyUI is enough for a first version

Fuobe's `image-to-splat-triposplat` (`scripts/comfy/hand-built/image-to-splat-triposplat.json`) already is the stock TripoSplat graph: `LoadImage` 99 → BiRefNet cut-out or the image's own alpha (switch 88:35, binding `cutout`) → `TripoSplatPreprocessImage` 88:2 (the 1.2 crop = Idol's `synthetic`) → `TripoSplatConditioning` 88:24 → `UNETLoader` 88:16 → `KSampler` 88:6 (20 steps, cfg 3, `dpmpp_2m` / simple) → `VAELoader` 88:11 → `VAEDecodeTripoSplat` 88:55 → `SplatToFile3D` 92 (spz) → `SaveGLB` 51; `CreateCameraInfo` 79 (orbit 35° / 30° / 2.5) → `RenderSplat` 75 (75 frames, `opacity_threshold` 0) → `CreateVideo` 41 → `SaveVideo` 42. Idol needs the same graph with other files and settings. Two things are missing without the pack: the `real` photo crop and pruning the saved file. The first can be done with core nodes (below); the second cannot.

### 5.5 The graph Fuobe would build: `image-to-splat-idol` (core nodes only)

A copy of `image-to-splat-triposplat.json` (same node ids) with these changes:

| id | class | change |
|---|---|---|
| 88:16 | `UNETLoader` | `unet_name` **`idol_fp16.safetensors`**, `weight_dtype` default |
| 88:11 | `VAELoader` | `vae_name` **`idol_decoder_fp16.safetensors`** |
| 88:6 | `KSampler` | **`steps` 50, `cfg` 4.0, `sampler_name` euler**, `scheduler` simple, `denoise` 1 (Idol's reference). No `ModelSamplingSD3`: the shift 3 is built in. |
| 88:101 | `ImageScale` (new) | `image` [88:2, 0], `upscale_method` lanczos, `width` 720, `height` 720, `crop` disabled |
| 88:102 | `EmptyImage` (new) | 1024 × 1024, batch 1, `color` 0 (black) |
| 88:103 | `ImageCompositeMasked` (new) | `destination` [88:102, 0], `source` [88:101, 0], `x` 152, `y` 152, `resize_source` false |
| 88:104 | `ComfySwitchNode` (new) | `switch` ← binding `photoCrop` (default false), `on_false` [88:2, 0], `on_true` [88:103, 0] |
| 88:24 | `TripoSplatConditioning` | `image` [88:104, 0] (was [88:2, 0]) |
| 75 | `RenderSplat` | **`opacity_threshold` 0.05** (the orbit video drops the haze; the saved file keeps it) |
| 88:96 | `ComfySwitchNode` | both inputs are the same `UNETLoader` in the TripoSplat file; keep it as is, or wire 88:16 straight into 88:6 |

**The photo crop with core nodes** (my analysis, not run). `TripoSplatPreprocessImage` at 1024 gives the object at 1/1.2 of the frame. Scaling that to 720 px and centring it on a black 1024 canvas puts the object at 720 / 1.2 = 600 px, where Idol's `real` mode puts it at 1024 / 1.7 ≈ 602 px. The background is black in both, the erosion is the same 1 px at 1024 scale, and the source detail is the same (both crop at the 1024 scale). Only the resampling differs. `ComfySwitchNode`'s inputs are lazy (`comfy_extras/nodes_logic.py` L98–111), so the branch not taken does not run. Check it against `IdolPreprocessImage` `real` before shipping (idol-1, "verify here"). **idol-1 (2026-11-02):** shipped behind "It's a photo (looser crop)" and `/prompt`-validated on the CPU server only; the comparison with `IdolPreprocessImage` `real` is still to be done (the pack is not installed here). idol-2 replaces the branch with `IdolPreprocessImage` where the pack is installed.

**Bindings** (the TripoSplat set plus two): `image` 99.image; `cutout` 88:35.switch; `photoCrop` 88:104.switch (new key); `numGaussians` 88:55.num_gaussians; `steps`, `cfg` 88:6; **`sampler` 88:6.sampler_name** (new key); `seed` 88:6.seed and 88:55.seed; `splatFormat` 92.format; `orbitFrames` 75.frames; `filenamePrefix` 51 and 42. Outputs: 51 model3d role `splat`; 42 video role `turntable`.

**Two presets** (set by the page as `params.extra`; the graph's own defaults are Best):

| Preset | steps | sampler | cfg | Gaussians | Why |
|---|---|---|---|---|---|
| **Best** (default) | 50 | euler | 4.0 | 262,144 | Idol's reference settings |
| **Quick look** | 20 | dpmpp_2m | 4.0 | 65,536 | The pack README calls 20 `dpmpp_2m` steps "a faster trade-off" and 65,536 "a fast preview". Quality not measured. |

Label them by steps and Gaussians, never by seconds.

**Manifest entry:** capability `splat`, `customNodes` [], defaults `{ splatFormat: "spz", cutout: true, photoCrop: false }`, `limits.maxGaussians` 1,048,576, `vramGb` 8 ("vendor peak 7.2 GB in the SDK; unmeasured in ComfyUI"), the licence string of §4.2, the five model files of §4.1.

### 5.6 With the pack: `image-to-splat-idol-clean` (package idol-2)

Same graph, with `packs: ['ComfyUI-Idol']`:

- `IdolPreprocessImage` in place of 88:2 and the photo crop branch: `mode` ← binding `cropMode` (`synthetic` | `real`), `mask` [88:35, 0] (Fuobe keeps its own cut-out switch), `erode_radius` 1, `size` 1024.
- `IdolPruneSplat` after 88:55: `min_opacity` 0.05, `max_scale` 0 (0.05 as a "Trim spikes" option). Its splat feeds 92 and 75.
- Optional: `IdolCamera` on 88:6's output → `RenderSplat` (1 frame, 1024, black) → `SaveImage`, as the card's "what the model saw" still.

The provider runs the clean graph when the server has the pack (`GET /object_info/IdolPruneSplat` is not empty) and falls back to `image-to-splat-idol` otherwise.

### 5.7 What this machine can and cannot verify

- **Can:** build the library entry; `/prompt`-validate `image-to-splat-idol` on the shared CPU server (every class is core; the validator makes zero-byte placeholders for missing weights); unit tests; browser checks in demo mode. On an **isolated worker** (never the shared server at 8188) the pack can be installed (no Python dependencies) to validate `image-to-splat-idol-clean` and to compare the core photo crop with `IdolPreprocessImage` on transparent PNGs (no weights needed when the mask comes from the PNG's alpha).
- **Cannot:** any real Idol run (no GPU; the model folders on the server are empty), timing, VRAM, or quality. A CPU run of the full graph is possible in principle (fp32), but my guess is tens of minutes per object on this 4-core host, and the weights are not here.

## 6. Cloud routes

**Correction (2026-11-02).** The check below (2026-10-30) was right that day, but fal published `speridlabs/idol` the same evening (catalog date 2026-10-30T20:19Z, status active; new-models-10 §5). Re-read at the primary source on 2026-11-02 (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=speridlabs/idol`, `api.fal.ai/v1/models`, the model page's billing): category image-to-3d, **$0.10 per generation**, licence type commercial.

- **Inputs:** `image_url` (required); `image_type` `synthetic` (default, tight crop) | `real` (photos, looser crop); `num_gaussians` 32,768–1,048,576 (default 262,144); `num_inference_steps` 1–50 (default 50); `guidance_scale` 0–10 (default 3, Idol's own weight, i.e. ComfyUI cfg 4); `seed`; `enable_safety_checker` (default true). No sampler and no output-format choice.
- **Outputs:** `model_mesh` (the splat, `.ply`), `model_glb` (a coloured point cloud of the splat centres), `preprocessed_image` (the cut-out it saw), `camera` (yaw, pitch, radius, fov), `num_gaussians`, `seed`, `timings`.
- `fal-ai/idol` answers the same schema but has no catalog entry; Fuobe uses `speridlabs/idol`.

So Idol now has a cloud half: Fuobe's cloud model `idol-3d` ("Idol 3D", research record in `new-models-10.json` `endpointRecords`, FieldMap generated by `scripts/gen-cloud-models.py`). Best / Quick look map to `num_inference_steps` 50 / 20 and `num_gaussians` 262,144 / 65,536 (the sampler stays fal's), and "It's a photo" maps to `image_type` `real`. The open engine keeps what fal lacks: the `.spz` file, the orbit video and the sampler choice. Replicate still has no Idol (not re-checked with a token).

The original check of 2026-10-30:

| Where | What I checked | Result |
|---|---|---|
| fal | queue OpenAPI for `fal-ai/idol`, `speridlabs/idol`, `fal-ai/idol/image-to-3d`, `fal-ai/speridlabs-idol`; a full paged scan of `api.fal.ai/v1/models` (1,447 models, 2026-10-30) for idol, speridlabs, splat, gaussian | all 404; the only splat model is `tripo3d/triposplat` (200), a different model |
| Replicate | `replicate.com/speridlabs/idol`, `/nynxz/idol`, `/speridlabs`; the 3D models collection; a site search | all 404 or absent. The API endpoint answers 401 without a token, so that check is inconclusive; the pages are 404. |
| Hugging Face | Space `speridlabs/idol` (RUNNING, ZeroGPU A10G, compile off) and a duplicate `cpuai/Idol-Image-to-3D`; Inference Providers mapping for `speridlabs/idol` | a free demo within ZeroGPU quota, no API product; the mapping is `{}`. Not fal or Replicate, so it does not count. |

Fuobe's existing cloud TripoSplat in Splat mode (`triposplat`, fal `tripo3d/triposplat`, ≤ 262,144 Gaussians, $0.05; `cloud-models.generated.ts` L15265–15307) stays as it is, labelled TripoSplat. It is not Idol and must never be shown as Idol.

## 7. How it compares with what Fuobe uses today

### 7.1 What Fuobe has today

- **Image to 3D** (`/image-to-3d`; `src/components/model3d/model3d-studio.tsx`; `src/lib/av/model3d.ts`). Five modes (L13–21). `MODELS_3D` (L29–59):
  - From an image: cloud Hunyuan3D 3.1 Pro / Rapid, TRELLIS.2, Tripo H3.1, Meshy 7.1; open `oss-trellis2` ("Textured GLB + turntable video · 16 GB GPU · MIT") and `oss-hunyuan3d-21` ("Shape only · 10 GB GPU").
  - From several images: cloud Meshy multi; open `oss-trellis2-multi`. From text: cloud Tripo text; open `oss-text-trellis2`. Pick an object: cloud SAM 3D Objects only.
  - **Splat:** cloud `triposplat` ("The subject as a .ply splat · ≈ $0.05"); open `oss-triposplat` ("The subject as a .spz splat + an orbit video · 8 GB GPU · MIT", L57).
  - `CLOUD_NOTICES` adds "Built with DINOv3" to cloud TripoSplat and TRELLIS.2 (L67). The studio's hint under the button names TripoSplat by hand (`model3d-studio.tsx` L314–320).
- **The open model** `oss-triposplat` (`src/lib/catalog/models.ts` L1380): route `comfy('splat', 'image-to-splat-triposplat')`, a `numGaussians` slider 32,768–1,048,576. Its manifest entry (`workflows/comfyui/manifest.json` L15453) is pinned to ComfyUI 0.41.0 (`fc04da91`): defaults steps 20, cfg 3, 262,144 Gaussians, 75 orbit frames, `.spz`, cut-out on; `vramGb` 8, "VRAM unverified. Validated by /prompt only."
- **Viewers.** GLBs show in `@google/model-viewer` 4.3.1 (`package.json` L35). three 0.183.2 (L56) drives Cinema's scene viewer. **Fuobe does not draw splats**: `result-media.tsx` L248 and `model-card.tsx` L177 say so and point to SuperSplat. *(Since idol-4, 2026-11-03: it does, with Spark; see §9 idol-4.)*
- **Elsewhere.** Canvas: `model3d` nodes default to op `image-to-3d` (`canvas.ts` L404); `splat` takes images (L516); the tile is `canvas/nodes.tsx` L469–472. Feed: image next steps are animate, upscale, edit (`output-actions.ts` L169–170), no 3D action; 3D outputs get "View in 3D" (L146). Library: a 3D tab (`library-view.tsx` L58). Licences: `src/lib/licences.ts` builds rows from the manifest and `NODE_PACKS` (from L406).
- **Name clash.** `src/lib/catalog/apps.ts` L1486 already ships a video app called **"Idol"** ("Become a K-pop idol on stage"), mirroring a Higgsfield effect (`higgsfield-inventory.md` L414). The 3D model needs another name in pickers, ⌘K, the Library and Settings: **"Idol 3D"**.
- **The local ComfyUI** (`127.0.0.1:8188`): v0.41.0, CPU only, 14.3 GB RAM. It has every stock TripoSplat and splat node. The `diffusion_models`, `vae`, `clip_vision` and `background_removal` folders are empty, so nothing 3D can run there; only `/prompt` validation.

### 7.2 Side by side

| | **Idol 3D** (open, proposed) | TripoSplat (open, today) | TripoSplat (cloud, today) | TRELLIS.2 (open) | Hunyuan3D 2.1 (open) |
|---|---|---|---|---|---|
| Output | splat (`.spz` / `.ply`) + orbit video | the same | `.ply` splat, ≤ 262,144 | textured PBR `.glb` + turntable | shape-only `.glb` |
| Graph | a copy of TripoSplat's | `image-to-splat-triposplat` | fal `tripo3d/triposplat` | `image-to-3d-trellis2` | `image-to-3d-hunyuan3d-21` |
| Weights | 3.78 GB, of which 1.32 GB new (the rest shared with TripoSplat) | 3.78 GB | none (hosted) | — | — |
| GPU | 7.2 GB vendor peak; 8 GB listed | 8 GB listed, unverified | hosted | 16 GB | 10 GB |
| Speed (published) | 6.8 s H100, 14.1 s RTX 5090, 46.2 s RTX 3080 (SDK, vendor); ~22–26 s RTX 5090 in ComfyUI (pack author) | 9.9 s H100 (Speridlabs' table); same per-step cost as Idol in ComfyUI | hosted | not compared | not compared |
| Settings | 50 Euler, cfg 4 (Best); 20 dpmpp_2m (Quick) | 20 dpmpp_2m, cfg 3 | | | |
| Quality (vendor only) | SSIM 0.726, LPIPS 0.213, IoU 0.862, DINOv2 0.781 | 0.712 / 0.225 / 0.860 / 0.743 | same model | no shared benchmark | no shared benchmark |
| Licence | Apache-2.0 (+ TripoSplat MIT attribution, DINOv3 notice) | MIT (+ DINOv3 notice) | fal terms (+ DINOv3 notice) | MIT | Tencent licence (leaves out the EU, the UK and South Korea) |
| Best for | looking around one object; orbit videos; splat viewers | the same | the same, no GPU | game-ready, riggable assets | geometry only |

At Idol's reference settings it samples 2.5× the steps of today's TripoSplat graph; my guess is about twice the wall time once fixed costs count. For riggable, textured assets TRELLIS.2 and Hunyuan3D stay the choice. Idol and TripoSplat compete for the same slot, and only a blind A/B on the same inputs should pick the default (idol-3).

## 8. Where it goes in Fuobe and why

Idol goes where people already make 3D. (Written when Idol had no cloud route; Fuobe added fal's `speridlabs/idol` as the cloud half of the first row, see §6. The other rows stay open-engine work.)

| Where | What the user gets | Open engine | Cloud engine | Why | Priority (package) |
|---|---|---|---|---|---|
| **Image to 3D → Splat**, open list, next to TripoSplat | "Idol 3D" with Best and Quick look, and "It's a photo" for the looser crop; a `.spz` and an orbit video | `image-to-splat-idol` on `oss-idol` | none; cloud TripoSplat stays, labelled TripoSplat | The page and the mode already exist; one more model in a list users already open | **P0 (idol-1)** |
| The same, with the ComfyUI-Idol pack | Splat files without the haze, Idol's own crop, a "what the model saw" still | `image-to-splat-idol-clean` | none | The haze is the biggest visible flaw, and core ComfyUI can't remove it from files | P1 (idol-2) |
| **Splat A/B** in `scripts/eval` | Numbers and a blind review before any default changes | Idol Best / Quick against TripoSplat today | none for Idol | The quality claim is the vendor's only | P1 (idol-3) |
| **Look around a splat** on result cards and in the Library | Drag to orbit and zoom; an opacity cut-off that hides haze | a three.js splat viewer for `.spz` / `.ply` | the same viewer draws cloud TripoSplat's `.ply` | Today the page says "Fuobe doesn't draw splats yet"; helps TripoSplat too | P1 (idol-4) |
| **Image results → "Make it 3D (quick)"** | One click from a generated product or character to a turning preview | Splat mode with Idol Quick, prefilled | hidden on cloud-only installs | Puts 3D where pictures are made | P1 (idol-5) |
| Idol result → **"Build the final with TRELLIS.2"** | Check the sides with a quick splat, then spend the 16 GB run | `oss-trellis2` on the same picture | the user's normal Image to 3D choice; not an Idol substitute | A cheap draft before an expensive final | P2 (idol-6) |
| From an image → **Quick mesh** | A vertex-coloured `.glb` that opens in the normal viewer and can go to Rig & animate | Idol → core `SplatToMesh` → `SaveGLB` | none | A riggable rough mesh from one picture; quality unknown | P2 (idol-7) |
| **Fill the other sides** from one picture | Side and back views for From several images, Elements and Soul Cast references | Idol + `IdolCamera` → `RenderSplat` (4 frames, 90° apart) | none | Consistent angles without prompting each one; quality unknown | P2 (idol-8) |
| **Cinema Studio prop** | Drop an object made from a picture into the 3D scene and film it | the splat inside the scene viewer | none | Props for the MoGe scene; needs the viewer first | P2 (idol-9) |

Settings → Models & licences, ⌘K, the Canvas model node, the demo provider and Assist's op names are not placements of their own: they come with idol-1.

## 9. Build plan

Packages in priority order. The full brief of each one (goal, files, graph, bindings, UI, tests, what must not break, what this machine can verify, the cloud rule) is in the JSON twin, `plan.packages[].brief`; below is the short form. Every package: open engine first (since 2026-10-30 fal hosts Idol, so a package may add what `speridlabs/idol` supports on the cloud, labelled Idol, and never a substitute; §6); never promise seconds; "Idol 3D" as the name; tests; a browser check at 1440 px and 390 px in light and dark with no horizontal scroll; `pnpm typecheck`, `pnpm lint`, the targeted tests and the full vitest run; a commit per step.

| # | Package | Priority | Depends on | Effort |
|---|---|---|---|---|
| idol-1 | Idol 3D in Image to 3D → Splat | P0 | — | medium |
| idol-2 | Clean splat files and Idol's own crop (ComfyUI-Idol pack) | P1 | idol-1 | small |
| idol-3 | Splat A/B in the evaluation harness | P1 | idol-1 | medium |
| idol-4 | Look around splats in Fuobe (splat viewer) | P1 | — | medium |
| idol-5 | "Make it 3D (quick)" on image results | P1 | idol-1 | small |
| idol-6 | Draft then final: "Build the final with TRELLIS.2" | P2 | idol-1 | small |
| idol-7 | Quick mesh from Idol | P2 | idol-1 | medium |
| idol-8 | Fill the other sides from one picture | P2 | idol-1, idol-2 | medium |
| idol-9 | Idol props in Cinema Studio's 3D scene | P2 | idol-1, idol-4 | large |

### idol-1 · Idol 3D in Image to 3D → Splat (P0)

- **Weights.** `KNOWN_MODELS` (`scripts/comfy/library.spec.mjs`, after L275): `idol_fp16.safetensors` (`diffusion_models`) and `idol_decoder_fp16.safetensors` (`vae`) at `https://huggingface.co/nynxz/Idol/resolve/c718f2b1b95b353edd07d17e845719fc10880a44/…`, with their sizes and SHA-256 in a comment (§4.1). Optionally move `flux2-vae` to `Comfy-Org/Flux-2-Dev`.
- **Graph.** `scripts/comfy/hand-built/image-to-splat-idol.json` as in §5.5; spec entry beside `image-to-splat-triposplat` (L3349) with bindings `sampler` and `photoCrop` added to `BINDING_KEYS` (`scripts/comfy/build-library.mjs` L98–135), the licence string of §4.2, `vramGb` 8 and honest notes. Build, `/prompt`-validate on the shared CPU server, commit the manifest and validation state.
- **Model.** `oss-idol` "Idol 3D" (vendor Speridlabs, kind `model3d`) after `oss-triposplat` (`models.ts` L1380): route `comfy('splat', 'image-to-splat-idol')`, sliders `numGaussians` and `steps`.
- **Studio.** `MODELS_3D.splat.open` gets Idol 3D after TripoSplat (TripoSplat stays the default until idol-3). `model3dRequest` adds Best / Quick presets and `photoCrop` for `oss-idol`. The studio shows "Best · Quick look" and "It's a photo (looser crop)" (on for uploads, off for images handed over from a Fuobe result), and model-aware copy in place of the TripoSplat-only hint.
- **Elsewhere.** ⌘K (via `ALL_MODELS_3D`), the Canvas model node (check `modelChoices` lists it and that a chain into a video slot takes the orbit video), Assist's op lists (`src/server/assist/tools.ts` L93, L254 add `splat`), the licence row (from the manifest string), demo (the mock's splat answer covers it).
- **Tests, must not break, verify here.** See the brief. TripoSplat's graph, model, tests and the "Idol" K-pop app stay untouched. Optional isolated-worker check of the core photo crop against `IdolPreprocessImage` `real`.

### idol-2 · Clean splat files and Idol's own crop (P1)

Pin ComfyUI-Idol at `4d3a4f67…` (`CUSTOM_NODE_REPOS`, `PACK_CLASSES` `/^Idol(PreprocessImage|Camera|PruneSplat)$/`, `install-comfyui.sh` `NODES`, a `NODE_PACKS` row). Graph `image-to-splat-idol-clean` (§5.6) with bindings `cropMode`, `minOpacity`, `maxScale`. The provider prefers it when `GET /object_info/IdolPruneSplat` answers and falls back to idol-1's graph. "It's a photo" maps to `real`; an advanced "Trim spikes" sets `max_scale` 0.05. Verify on an isolated worker only.

### idol-3 · Splat A/B in the evaluation harness (P1)

A `splat` suite in `scripts/eval/cases/splat.json`, kind `video` (the orbit video is what the harness scores and shows), open engine: Idol Best, Idol Quick, TripoSplat as today, and TripoSplat at 50 Euler steps to separate weights from settings. 8–12 inputs: generated product renders, product photos (photo crop on), figurines, a character, thin parts, glass. Metrics `style` (DINOv2, against the input picture), `temporal`, `aesthetic`, timing and memory, plus the blind A/B page. It decides the Splat mode's open default, the Quick settings and whether the photo crop helps. A person changes defaults in a reviewed commit.

### idol-4 · Look around splats in Fuobe (P1)

A lazily loaded three.js Gaussian-splat viewer for `.spz` / `.ply` / `.ksplat` in `model-card.tsx`, `studio/result-media.tsx` and the Library's 3D tab, replacing "Fuobe doesn't draw splats yet". Orbit, zoom, reset, an opacity cut-off (default 0.05 for Idol), "Save a still" to the Library; the orbit video stays as the poster and the fallback. The library choice (Spark or GaussianSplats3D, say) is a guess and needs its own check of licence, version, `.spz` support and phone performance. Works for TripoSplat results on both engines.

**Built (2026-11-03): Spark 2.3.1.** The two candidates, checked at npm and in the packages themselves:

| | Spark (`@sparkjsdev/spark`) | GaussianSplats3D (`@mkkellogg/gaussian-splats-3d`) |
|---|---|---|
| Licence | MIT (© 2025 World Labs Technologies) | MIT |
| Version | 2.3.1, published 2026-10-01 (2.4.0 of 2026-10-20 was 14 days old: too new) | 0.4.7, 2025-01-25, no release since |
| three | peer `>=0.180.0` (Fuobe has 0.183.2) | peer `>=0.160.0` |
| `.spz` | yes (its README; Fuobe's demo `.spz` v2 parses, see below) | no (`.ply`, `.splat`, `.ksplat` only, its README) |
| `.ply`, degree-0 SH | yes (Idol's 17-float layout parses) | yes |
| `.ksplat` | yes | yes (its own format) |
| WebGL2 | yes ("targeting 98%+ WebGL2 support") | yes |
| Bundle | `spark.module.min.js` 2.60 MB, **0.92 MB gzipped** (the Rust/WASM core is inlined as base64); one dependency, `fflate` | not measured (ruled out on `.spz`) |
| Per-splat opacity cut-off | a `dyno` object modifier (the viewer's "Hide faint haze", live); `transcodeSpz` also takes `opacityThreshold` | `splatAlphaRemovalThreshold` at load only (0-255) |

Spark loads only through a dynamic import (`src/components/model3d/splat-engine.ts`, from `splat-viewer.tsx`); `tests/splat-view.test.ts` checks that nothing else imports it, and `tests/e2e/splat-viewer.mjs` that a page without a splat never fetches it (matched by its WASM glue's module name, so it holds for hashed production chunks too).

Numbers measured here (this container: 4 CPUs, no GPU; Chromium's WebGL2 runs on SwiftShader, a software renderer):

- **Parsing.** Spark's own decoder (`transcodeSpz`, in Node) reads the demo `.ply` and `.spz` (4,096 Gaussians, 1,280 of them haze) to the same 4,096, positions identical to the bit and v2 rotations identical; with `opacityThreshold` 0.05 it keeps 2,816, the solid ones.
- **Sizes at 262,144 Gaussians** (`node scripts/gen-demo-splat.mjs --gaussians=262144`): `.ply` 17,826,208 bytes (matches §2.1's 17.8 MB), `.spz` v2 2,770,631 bytes (6.4×; real splats compress less than this synthetic one, guess).
- **Load.** The 17.8 MB `.ply` from the local server to the toolbar showing: 1.6 s at 390 px (fetch, parse, upload).
- **Frame time: not measured on a phone.** SwiftShader takes about 8 s per frame at 262,144 Gaussians (median of 51 frames while dragging at 390 px), so software rendering says nothing about a phone's GPU. The 4,096-Gaussian demo draws within about 3 s of opening on SwiftShader. Measure on a real phone (an iPhone 12 / Pixel 6 class device, a 262,144-Gaussian `.spz`) before calling it fast; the viewer caps the pixel ratio at 1.5 on touch screens and draws only when something changes (a drag, the slider, Spark finishing a sort), never in a loop.
- **Size limit.** The viewer opens files up to 48 MB on a touch screen (a 262,144-Gaussian `.ply` fits; a 1,048,576 one at 71 MB doesn't) and 160 MB elsewhere; past that the orbit video or picture stays, with the download.

The cut-off starts at 0.05 for Idol 3D (both engines) and at 0 for TripoSplat, until the A/B (idol-3) says what TripoSplat's haze is. The orbit video stays as the fallback with no WebGL2, for a file over the limit, and with reduced motion in the full-screen viewer (until "Look around in 3D").

### idol-5 · "Make it 3D (quick)" on image results (P1)

A menu action on image results (`output-actions.ts`, `case "image"`) that opens `/image-to-3d?mode=splat&model=oss-idol&quality=quick&image=…` with the picture in the slot and the photo crop off. Shown only when the open engine is available (a new `ActionContext.openEngine`); `NEXT_STEPS.image` stays as it is. The studio learns `?image=` and `?quality=`. Copy says "tens of seconds on a consumer GPU", not 2 s.

### idol-6 · Draft then final with TRELLIS.2 (P2)

On an open Idol result card, "Build the final with TRELLIS.2" opens From an image with `oss-trellis2` and the same picture (`model3dView(g).photo`), noting its 16 GB GPU.

### idol-7 · Quick mesh from Idol (P2)

Graph `image-to-mesh-idol`: the Idol graph → core `SplatToMesh` (resolution 384, `min_opacity` 0.02) → `SaveGLB`, plus the orbit video. ModelDef `oss-idol-mesh` "Idol 3D quick mesh" in From an image (open list, after Hunyuan3D 2.1). The `.glb` opens in model-viewer and can go to Rig & animate (cloud Meshy rigging, as today for any GLB). An eval case first; Hi3D refinement waits (CUDA only, geometry only, `/home/user/ext/hi3d/README.md` L60, L119).

**idol-7 (2026-11-03):** built as `image-to-mesh-idol` (core nodes only, `/prompt`-validated on the CPU server, no GPU run) and `oss-idol-mesh`, last in From an image's open list (after Pixal3D, TRELLIS.2 and Hunyuan3D 2.1; Pixal3D became the default after this plan was written). The GLB is the model output with no role, as every image-to-3D graph's, so the server finishes it (web GLB, pivot at the bottom; a finish of a vertex-coloured unlit GLB keeps `COLOR_0` and `KHR_materials_unlit`) and, with Chromium and ffmpeg, replaces the splat orbit with a turntable of the mesh. `meshResolution` is `SplatToMesh.resolution` (64–768, steps of 16). Hi3D (hi3d-refine) now exists: Refine this mesh and Refine detail are offered on these results as on the other open models (Hi3D's result has no colour). The eval cases are `scripts/eval/cases/mesh.json` (idol-3's `splat` suite isn't built yet); mesh quality is still unmeasured.

### idol-8 · Fill the other sides from one picture (P2)

Graph `image-to-views-idol` (needs the pack): the Idol graph → `IdolCamera` → `RenderSplat` with `frames` 4 (four views 90° apart, starting at the input view; `nodes_gaussian_splat.py` L1004–1006) → four images. In From several images, "Make the other sides from the front" fills the left, back and right slots for `oss-trellis2-multi`; in Elements, "Add side and back views". The orbit direction must be matched to Fuobe's side names (`SIDES_HINT`). Quality for faces is unknown: eval first.

### idol-9 · Idol props in Cinema Studio's 3D scene (P2)

Place an Idol splat in the MoGe scene viewer (`src/components/cinema/scene-viewer.tsx`, layout `object` at L633) with move, scale and turn handles, using idol-4's renderer inside the scene. Idol's predicted camera can set the first orientation.

## Results (pending a GPU run)

_Package idol-3 (2026-11-03) built the measurement; no numbers yet. This machine has no GPU, so only the case file and demo runs were checked here, and demo numbers are never results. §3 and §7.2 stay the vendor's until this section has a run._

**The suite.** `scripts/eval/cases/splat.json` (`pnpm eval:validate`), 11 single objects with your own pictures in `scripts/eval/local/splat/` (never committed; the file names are in `scripts/eval/README.md`, "Your own inputs"): three generated product renders (bottle, sneaker, headphones), three photos tagged `photo` (mug, handbag, figurine), a stylised character, a person (made up, or someone who agreed), two with thin parts (chair, plant) and glass with chrome. Three seeds each (1001, 2002, 3003), so the promote rule's three results per case hold. The input picture is each case's reference.

| Variant | Model | Settings | Runs on |
|---|---|---|---|
| `idol-best` (the candidate) | `oss-idol` | 50 euler, cfg 4, 262,144 Gaussians (`IDOL_PRESETS.best`) | every case |
| `idol-quick` | `oss-idol` | 20 dpmpp_2m, cfg 4, 65,536 (`IDOL_PRESETS.quick`) | every case |
| `triposplat-today` | `oss-triposplat` | its graph's defaults: 20 dpmpp_2m, cfg 3, 262,144 | every case |
| `idol-photo-crop` | `oss-idol` | Best with `photoCrop` on (`cropMode` real on the clean graph) | the 3 photos |
| `triposplat-cloud` | fal `tripo3d/triposplat` (`triposplat`), labelled TripoSplat | fal's defaults | cloud runs only; about $0.05 a job, under the spend cap |

TripoSplat at Idol's sampler (50 euler, cfg 4), which would tell the weights from the settings, is not in the suite yet: `image-to-splat-triposplat` binds `steps` and `cfg` but not `sampler`, and adding the binding changes a workflow contract that `tests/comfy-library-4.test.ts` pins. Until it lands, a win for `idol-best` may be its 50 Euler steps rather than its weights.

**What is measured.** The orbit video (role `turntable`) is the scored and reviewed output; the `.spz` stays with each job.

| Number | What it decides |
|---|---|
| `style` (DINOv2 ViT-S/14, Apache-2.0: the orbit's frames against the input picture) | the main metric: how much of the object survives every angle. Picks the default and the Quick settings |
| `drift`, `driftMax`, `warp` (temporal) | that the winner doesn't turn less smoothly (bands 0.004 drift, 0.002 warp) |
| `aesthetic` (LAION v2) | that the winner doesn't look worse (band 0.15) |
| blind ratings (`pnpm eval:review`) | for each pair of variants a rule compares: at least 6 per case, or every such pair the review offered when it offered fewer (3 per case for one reviewer at 3 seeds), and at least 55 % of the non-tie ratings to the winner |
| `haze` (share of Gaussians under opacity 0.05 in the saved file), `gaussians` | whether TripoSplat's files carry Idol's haze (§2.4), so the splat viewer's opacity cut-off (idol-4) knows which models need it. On a ComfyUI with ComfyUI-Idol, Idol's file is pruned at 0.05 by its clean graph, so its haze there is near zero by design |
| `seconds`, `vramGb` (from ComfyUI's `/system_stats` and `/history`) | the time and peak memory on that GPU, to replace "unmeasured in ComfyUI" in the manifest notes and the vendor's figures in §3 |

**The commands** (a Fuobe connected to a ComfyUI on an 8–16 GB GPU with both models' weights; `scripts/eval/README.md`, "The splat suite"):

```bash
pnpm eval:setup --download --dinov2                       # the metrics venv, with DINOv2 fetched now
pnpm eval:run --suite splat --engine open --variants idol-best,idol-quick,triposplat-today,idol-photo-crop --dry-run
pnpm eval:run --suite splat --engine open --variants idol-best,idol-quick,triposplat-today,idol-photo-crop \
  --label "<GPU>, driver <version>, ComfyUI <version>"
pnpm eval:review latest                                   # rate every pair blind
pnpm eval:report latest
pnpm eval:compare latest:triposplat-today latest:idol-best --per-case
pnpm eval:compare latest:idol-best latest:idol-quick --per-case
pnpm eval:promote latest --against triposplat-today       # decision 1 only: Idol Best against TripoSplat today
pnpm eval:run --suite splat --engine cloud --variants triposplat-cloud   # optional: priced before it starts (about $0.05 a job in the catalog today)
```

**What each result changes** (the suite's `decides` field; a person makes each change in its own reviewed commit, with this section filled in):

1. **Splat mode's open default** (`MODELS_3D.splat.open` in `src/lib/av/model3d.ts`, TripoSplat first today): Idol 3D goes first only if `idol-best` scores at least as well as `triposplat-today` on style in at least 8 of the 11 cases, stays within the aesthetic and temporal bands on the suite's means, and takes at least 55 % of the non-tie blind ratings of their pairs, with at least 6 per case or every such pair the review offered when it offered fewer (3 per case for one reviewer at 3 seeds). `pnpm eval:promote latest --against triposplat-today` checks the per-case part; without `--against` it also weighs Idol Quick and the photo crop, which is not this decision. TripoSplat at Idol's sampler should run first (above).
2. **Idol's Quick look** (`IDOL_PRESETS.quick`): stays at 20 dpmpp_2m and 65,536 Gaussians while `idol-quick` is within 0.02 style of `idol-best` on the suite's mean and Best takes no more than 70 % of their non-tie ratings; otherwise the next run tries 30 steps or 131,072 Gaussians.
3. **The photo crop** (on for uploads today): stays on only if `idol-photo-crop` scores at least as well as `idol-best` on style in at least 2 of the 3 photos and takes at least 55 % of their non-tie ratings; otherwise it starts off.

| Run | GPU, driver, ComfyUI | Graphs (core or clean) | Results |
|---|---|---|---|
| _pending_ | | | |

## 10. Risks

- **The "~2 s" expectation will not hold in Fuobe.** The fastest published time is 3.4 s on a B300 through the compiled SDK; consumer cards are 14–46 s there, and about 22–26 s on an RTX 5090 in ComfyUI. Label presets by steps and Gaussians.
- **Same network cost as TripoSplat.** At equal steps Idol is not faster in Fuobe. Its only edge is vendor-reported quality from different weights. A/B before making it the default.
- **Name clash** with the "Idol" K-pop video app (`apps.ts` L1486). Use "Idol 3D" everywhere.
- **Haze in downloads** without the pack. Core ComfyUI 0.41 has no prune node; the saved files keep about half their Gaussians as near-transparent haze. idol-2 or idol-4's viewer cut-off fixes what users see.
- **Brand-new code from one maintainer.** Three AI-assisted commits in 24 minutes, 19 stars, no tags, no Registry entry; idol-sdk has one commit. Pin `4d3a4f6` if the pack is used.
- **Third-party converted weights.** `nynxz/Idol` matches speridlabs' fp32 on 10 tensor prefixes, not whole files. Pin `c718f2b1` and the two SHA-256, or convert from `speridlabs/idol` @ `2731c229`.
- **The pack README is wrong about the ComfyUI minimum** (0.22; really 0.23.0). Harmless for Fuobe's 0.41.0, but the docs were not checked against releases.
- **Thin provenance.** No paper, undisclosed training data, a self-run benchmark. The weights look started from TripoSplat's MIT release, yet no MIT notice travels with them; Fuobe's licence row shows the TripoSplat attribution.
- **DINOv3 terms** carry over ("Built with DINOv3", trade-control limits). Fuobe already handles this for TripoSplat.
- **The SDK route needs gated repos** (DINOv3 manual approval; FLUX.2-dev repo terms). Use the ComfyUI route and the ungated files.
- **URL drift.** `flux2-vae`'s URL works only through HF's rename redirect.
- **Scope.** One object, background removed. Not a scene model (MoGe stays for Cinema). The core photo crop is my analysis until checked.
- **No splat viewer yet,** so "look around it" is an orbit video until idol-4 lands. *(Landed 2026-11-03, Spark 2.3.1; phone frame time still unmeasured.)*
- **VRAM.** A 7.2 GB vendor peak rules out 6 GB GPUs; 8 GB is borderline and unmeasured in ComfyUI.
- **CPU and Apple.** Possible in principle through ComfyUI in fp32, but likely tens of minutes per object (guess). Don't call it quick on CPU-only installs.
- **ComfyUI API drift.** The pack relies on `comfy_api.latest` types and the TripoSplat code. Both are unchanged from 0.41.0 to 0.43.1. The core-only graph is the safer base.

## 11. Unknowns

- Which settings give "under 2 seconds" (steps, Gaussians, GPU, warm compile). None are published.
- Real VRAM peak and run time in ComfyUI on 8–12 GB consumer GPUs; what ComfyUI's offloading does to the 7.2 GB peak; which GPU Speridlabs measured on.
- CPU and Apple MPS run time through ComfyUI.
- Training data, and how Idol's weights relate to TripoSplat's (the "started from TripoSplat" reading is a guess from 10 tensor prefixes).
- Independent quality against TripoSplat, TRELLIS.2 and Hunyuan3D 2.1, especially on photos, people and characters, thin parts and glass. The "TRELLIS" in Speridlabs' table is unversioned.
- Whether TripoSplat's splats have the same haze.
- How the Quick settings (20 `dpmpp_2m` steps, 65,536 Gaussians) affect Idol's quality.
- Whether the core photo crop (§5.5) matches `IdolPreprocessImage` `real` closely enough.
- Full-file fidelity of `nynxz/Idol`; the ComfyUI-vs-SDK numbers (`tests/parity.py`) were not rerun.
- Whether the fp32 `denoiser.safetensors` loads straight into `UNETLoader`, and whether `TorchCompileModel` works with it (both pack claims).
- What format the project page's 0.4 / 3.2 / 12.2 MB file sizes are.
- How good `SplatToMesh` meshes and `RenderSplat` side views of Idol splats are.
- Whether Speridlabs, fal or Replicate will host Idol, and what comes after "v0.1".
- Which three.js splat renderer and version Fuobe should adopt. *(Answered: Spark 2.3.1, §9 idol-4. Still unknown: its frame time on phones.)*

## Sources (read 2026-10-30)

- Hugging Face: https://huggingface.co/speridlabs/idol (README and `config.json` at `2731c2291fc65a797c5cb627a5e5526fc1490902`); https://huggingface.co/api/models/speridlabs/idol and `/tree/main?recursive=true` (apache-2.0, not gated, created 2026-10-28T15:55:17Z, last modified 2026-10-29T18:17:36Z, sizes and LFS SHA-256); https://huggingface.co/api/models/nynxz/Idol and `/tree/c718f2b1b95b353edd07d17e845719fc10880a44?recursive=true` (paths, sizes, SHA-256 re-checked 2026-10-30); https://huggingface.co/VAST-AI/TripoSplat (MIT, tree at `56a96e60`); https://huggingface.co/api/models/Comfy-Org/BiRefNet (`884af709`); https://huggingface.co/api/models/Comfy-Org/Flux-2-Dev (`9630c1b4`; the old `Comfy-Org/flux2-dev` answers 307); https://huggingface.co/api/models/facebook/dinov3-vith16plus-pretrain-lvd1689m (gated manual); https://huggingface.co/api/models/black-forest-labs/FLUX.2-dev (gated auto); https://huggingface.co/api/spaces/speridlabs/idol; https://huggingface.co/api/spaces/cpuai/Idol-Image-to-3D; https://huggingface.co/api/models/speridlabs/idol?expand[]=inferenceProviderMapping (`{}`).
- Safetensors headers and tensor prefixes by HTTP range requests (no full downloads): speridlabs/idol `denoiser`, `decoder`, `decoder_gs` @ `2731c229`; nynxz/Idol @ `c718f2b1`; VAST-AI/TripoSplat @ `56a96e60`.
- Project page: https://speridlabs.com/research/idol (0.66B, "under 8 GB", the GPU and benchmark tables, the 3.4 s headline, BibTeX, "v0.1 · 04.2026", the file sizes).
- idol-sdk: https://github.com/speridlabs/idol-sdk at `4702a7f00850e34b6e83a2170cc123c3e9570744` (clone `/home/user/ext/idol-sdk`): `README.md`, `LICENSE`, `pyproject.toml`, `idol/pipeline.py` L35–153, `preprocess.py` L6–37, `sampler.py` L43–70, `gaussian.py` L106–128, `camera.py` L7–18, `conditioning.py` L15–91, `sample.py` L11–53, `models/dit.py` header, `models/layers.py` L12–27, `demo/model.py` L7–14, `demo/app.py` L155–165, `demo/examples/presets.json`; issues #1 and #2.
- ComfyUI-Idol: https://github.com/Nynxz/ComfyUI-Idol at `4d3a4f671028f0e062d9f004cda1a2dd73360d35` (clone `/home/user/ext/ComfyUI-Idol`; `git ls-remote` 2026-10-30): `README.md`, `NOTICE`, `LICENSE`, `pyproject.toml`, `__init__.py`, `idol/nodes.py`, `idol/camera.py`, `idol/preprocess.py`, `scripts/convert.py`, `tests/e2e.py`, `tests/parity.py`, `example_workflows/idol_image_to_splat.json`; the GitHub page (stars, forks, commits); https://api.comfy.org/nodes/comfyui-idol (404) and `/nodes/search?search=idol` (0).
- TripoSplat: https://raw.githubusercontent.com/VAST-AI-Research/TripoSplat/main/README.md L62; https://arxiv.org/abs/2605.16355. FLUX.2: https://raw.githubusercontent.com/black-forest-labs/flux2/main/README.md L111.
- fal: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/idol (404; also `speridlabs/idol`, `fal-ai/idol/image-to-3d`, `fal-ai/speridlabs-idol`; `tripo3d/triposplat` 200); https://api.fal.ai/v1/models paged scan (1,447 models, 2026-10-30). Replicate: https://replicate.com/speridlabs/idol, `/nynxz/idol`, `/speridlabs` (404); https://replicate.com/collections/3d-models.
- Live ComfyUI (read-only GETs): `http://127.0.0.1:8188/system_stats` (0.41.0, 14.3 GB RAM), `/object_info/<class>` (Idol classes `{}`), `/models/diffusion_models`, `/models/vae`, `/models/clip_vision`, `/models/background_removal` (all empty). Source `/home/user/ComfyUI` @ `fc04da91`: `comfy_extras/nodes_triposplat.py` L21–59, L130, L152–182; `comfy_extras/nodes_gaussian_splat.py` L473–500, L933–1010, L1533–1580; `comfy_extras/nodes_logic.py` L88–116; `comfy_extras/nodes_mask.py` L12–42, L80–104; `nodes.py` L1892–1904 (`ImageScale`), L1988–2002 (`EmptyImage`); `comfy/supported_models.py` L1669–1691; `comfy/model_detection.py` L832; `comfy/sd.py` L1093–1101; `comfy/ldm/triposplat/model.py` L257; `comfy_api/latest/_io.py` L164, L619, L688, L803, L1231, L1855; `comfy_api/latest/_util/geometry_types.py` L18–35; `comfy/bg_removal_model.py` L44–59; git tags v0.22.0–v0.23.0. `/home/user/ext/comfyui-v0.43.1` (TripoSplat files md5-identical to 0.41.0).
- Fuobe @ `claude/fuobe-parity-4` (`231e6346cadbea2822373a5b803e627a5914e199`): `src/lib/av/model3d.ts` L13–67, L91–155, L197–239; `src/components/model3d/model3d-studio.tsx` L67–80, L146–160, L310–320; `src/components/model3d/model-card.tsx` L48, L115, L177; `src/components/studio/result-media.tsx` L248; `src/lib/catalog/models.ts` L1334–1397; `src/lib/catalog/types.ts` L520–590; `src/lib/catalog/apps.ts` L1486–1493; `src/lib/catalog/canvas.ts` L325, L404, L434–441, L500–517; `src/components/canvas/nodes.tsx` L469–472, L627; `src/lib/output-actions.ts` L63–70, L91–106, L146, L169–173; `src/components/library-view.tsx` L58; `src/lib/licences.ts` L1–11, L256–282, L296–315, L392–443; `src/server/providers/comfyui.ts` L763–788, L1149, L1442–1452; `src/server/providers/mock.ts` L306–314; `src/server/generations.ts` L823–836; `src/server/assist/tools.ts` L93, L254; `workflows/comfyui/manifest.json` (header; L15453); `scripts/comfy/hand-built/image-to-splat-triposplat.json`; `scripts/comfy/library.spec.mjs` L124–175, L230, L273–275, L3349–3372; `scripts/comfy/build-library.mjs` L98–135, L277–302; `scripts/comfy/validation-state.json` L182; `scripts/eval/README.md`, `scripts/eval/cases/case.schema.json`, `scripts/eval/cases/angles.json`, `scripts/eval/lib/review.mjs` L19; `tests/model3d.test.ts` L316–341; `tests/comfy-library-4.test.ts` L44, L109, L164, L325; `tests/licences.test.ts` L49; `package.json` L35, L56; `docs/research/comfyui-oss-4.md` L318–335; `docs/research/higgsfield-inventory.md` L414.
- Hi3D: `/home/user/ext/hi3d/README.md` L5–17, L60, L119 (mesh refinement, CUDA only, validated on a 96 GB H20, geometry-only output).
