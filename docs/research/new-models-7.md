# Fuobe research #7: Open-H3-Regenerate-2K, WorldCast and MOSS-Image Layout

_As of 2026-10-29. Machine-readable twin: [`new-models-7.json`](new-models-7.json) (`items[]`, one per item, with `weights`, `nodePacks`, `graph`, `hosted`, `licences`, `placements`, `risks`, `unknowns` and `sources`; `endpointRecords`, the two fal MOSS-Image endpoints in the record shape `scripts/gen-cloud-models.py` reads; `buildPlan.packages[]`). It builds on [`openjutsu-6.md`](openjutsu-6.md) (MiniMax H3, the Character swap, the H3 licence), [`comfyui-oss-4.md`](comfyui-oss-4.md) (its MOSS-Image row, line 298), [`comfyui-oss.md`](comfyui-oss.md) (Uni3C and ReCamMaster, lines 1188 and 2367) and [`paid-model-apis-2.json`](paid-model-apis-2.json) (fal `minimax/h3-max/camera-controls`, lines 23027–23156)._

**What was asked.** The owner sent three new things and asked to "creatively place all of these effortlessly into our suite of products":

1. **Open-H3-Regenerate-2K** (NVIDIA NVlabs, the Sana team): its project page, the code on Sana's `sol-engine` branch and the Hugging Face weights. The owner asked "Apparently they made it a lora instead?" about Kijai's `MiniMax-H3-experimental` LoRAs, and linked the rdh9616 ComfyUI pack.
2. **WorldCast** (PixCtrol): one photo of a character plus a few reference angles become a cinematic video where the camera flies around them on a custom path. The owner listed it as "Wan2.1-I2V-14B + Depth Anything 3 + SAM 3 + VGGT-Omega".
3. **MOSS-Image Layout** (LinXce's `Comfyui-Moss-LayoutPrompt`): "another canvas editor". You draw one box per element and edit one row per box; it emits the compiled prompt and the canvas size.

The owner's standing rules apply. Every feature runs on two engines (cloud with the user's own fal / Replicate key; open with the user's own ComfyUI). No Higgsfield models or API. Licences are information, not gates: Settings → Models & licences records each one with an on/off switch, and everything starts on.

**How this was produced.** Read-only. Repositories were cloned into empty folders under `/home/user/ext/` (shallow, plus one history-only clone of the rdh pack) and only read: NVlabs/Sana `sol-engine` (sparse, `6e4a44002149418a547434b91d7280a8bbdcace3`), rdh9616/ComfyUI-Open-H3-Regenerate (`9b686c5ffd380e9d1351f9b8beef6d20d703ca3e`), LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler (`40316cf008b2fd8663263270669eb4da23f89d2c`), PixCtrol/WorldCast (`7ccf2e0ded1238bf6dea1b285c29bcf322e337cb`), LinXce/Comfyui-Moss-LayoutPrompt (`326ad58e3e5055cc59b90fe5b5d2bcddf3698a4d`), OpenMOSS/MOSS-Image (`2b46b1e0e13b5aaec253879e0d006a42564b8b27`) and ComfyUI v0.43.1 (sparse, `086099f5d8886163ef77dc354f8382cb7431582a`). Hugging Face sizes and SHA-256 come from the tree API at pinned revisions. A few safetensors headers and tensors were read by HTTP byte range: the zero-tensor check in §2.3 and the fine-tune check in §3.2. Hosted fields and prices come from fal's queue OpenAPI files and model pages, Replicate's model page, MiniMax's and MOSI's API references, and the local ComfyUI's read-only `GET /object_info` (v0.41.0-7, `fc04da91`). Fuobe's own code was read at `claude/fuobe-parity-4` (`7d7a765`). No code from these repositories was run or installed, and nothing was installed into ComfyUI. **Nothing ran on a GPU or a paid API.** Guesses are marked as guesses.

## 1. The short version

**Open-H3-Regenerate-2K (§2)**

- **It is a LoRA on MiniMax H3, not a new model.** NVIDIA froze H3 and trained one refiner LoRA. It takes a soft 384p–768p video draft plus a prompt and redraws it at 1080p, 2K or 4K in three steps. It redraws; it is not a faithful upscaler (§2.1, §2.2).
- **"They made it a LoRA instead?"** It always was one. NVIDIA ships one merged FP32 LoRA in Diffusers keys (refiner + LightX2V Turbo v1.2 + LMS Sharp; rank 576; 12.45 GB). Kijai re-packed only the refiner part in ComfyUI keys (rank 384, 5.87 GB). To match NVIDIA with Kijai's file you also load Turbo v1.2 and LMS Sharp. **New finding:** the 1.24 GB "Sharp curve branches" file adds nothing in the blocks checked, because its `curve_B` tensors are all zero (§2.3).
- **ComfyUI:** the rdh9616 pack (Apache-2.0, 10 nodes) plus LBH's H3 latent-upscaler pack (MIT) run the exact recipe. Everything they import exists at Fuobe's ComfyUI pin; core alone can't do it yet. About 19.6 GB of new files (plus 20.97 GB if the FL2VA base is required). Measured at about 3 minutes per 5 s at 2K on a 72 GB card (§2.6, §2.8).
- **Cloud:** nobody hosts the open model. fal's H3 renders 2K/4K at generation time ($0.13–0.20/s). MiniMax's closed regenerate API and Comfy's partner node take only unmodified H3 768P outputs with their exact prompt (§2.7).
- **Where:** a "Regenerate" finishing step, not a new studio: Upscale → Video ("Regenerate · creative"), a "Regenerate in 2K" action on video results, the Canvas Upscale node, and a 2K finish for Character swap in Genjutsu and Character Swap Studio (§2.10).

**WorldCast (§3)**

- **What it is:** a two-stage fine-tune plus a 0.99-billion-parameter "anchor memory" on Wan2.1-I2V-14B-720P. One photo, 1–4 reference views and a camera path give 81 frames at 480×832; the back and sides match the references. Weights are Apache-2.0 and 10.38 GB (the card says "~2 GB"). It needs 48 GB or more (§3.1, §3.2, §3.4).
- **The owner's component list, corrected:** the paper uses Depth Pro for depth, SAM 3 for masks and VGGT-Omega for poses. Depth Anything 3 is only used to evaluate (§3.1).
- **Not runnable in ComfyUI today.** There is no port, and the tooling that prepares a new case is not released. But Fuobe's pinned core ComfyUI already has the **Uni3C** stand-in, and WorldCast without its anchor memory scores about Uni3C's level (§3.6).
- **Cloud:** no WorldCast endpoint. fal's **H3 Max camera-controls** follows an exact keyframed path (azimuth, elevation, distance) from one photo; H3 Max reference-to-video and FLUX 3 Max keyframes take the reference views (§3.7).
- **Where:** a "Fly path" in Cinema's 3D scene, a "Turnaround video" on cast sheets and characters, and exact orbits in DoP, Cinema moves and Image to 3D (§3.10).

**MOSS-Image Layout (§4)**

- **What it is:** a box editor that compiles boxes into MOSS-Image's JSON layout prompt and outputs the canvas size. It is a pure prompt compiler (Apache-2.0). Fuobe doesn't need the pack: core ComfyUI owns the same node id, so the pack's main node is shadowed. Fuobe ports the compiler to TypeScript (§4.1, §4.2, §4.6).
- **MOSS-Image itself** is Apache-2.0, runs on core nodes at Fuobe's pin (about 13 GB for the int8 / w4a8 set), and is hosted on fal ($0.05 per megapixel) and MOSI (§4.4–§4.7).
- **One box model, many compilers:** the same boxes compile to FLUX.3, Ideogram 4.x and Bria FIBO 2 prompts (§4.3).
- **Where:** a "Layout" mode in the Image studio composer, "Edit layout" on results, a Layout node in Canvas, and "words drawn by the model" in Marketing and Ads (§4.10).

**Build plan (§5):** 11 packages, P0 first. Each one puts the new thing into a place users already work, on both engines where a route exists, and says where one engine has none.

## 2. Open-H3-Regenerate-2K

Sources for this section: the [project page](https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/), the code at [NVlabs/Sana `sol-engine` `models/Open-H3-Regenerate-2K`](https://github.com/NVlabs/Sana/tree/sol-engine/models/Open-H3-Regenerate-2K) (`6e4a4400`, still the branch head on 2026-10-29), the [model card](https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K) at `5809c33730c18b6b1c827b40974855a4288641b3`, [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental/tree/main/loras) at `f5c3b1d5`, and [rdh9616/ComfyUI-Open-H3-Regenerate](https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate) at `9b686c5f`. "code README", `infer.py`, `pipeline.py` and `sigmas.py` are files in that Sana folder; "HF README" is the model card; "rdh README" is the pack's README.

### 2.1 What it is

A video-to-video refiner. It takes a soft, low-resolution video draft and a text prompt and redraws the same scene at a higher native resolution. It is generative regeneration, not a faithful upscaler (HF README L16-17; project page abstract). It is NVIDIA's open answer to MiniMax's closed "H3-Regenerate-2K" API.

| | |
|---|---|
| **Draft** | The card's example is "a 768P H3 draft (1344×768, 121 frames)" (HF README L16-17). The project page also shows 384P, 512P, 576P and 768P drafts from H3 and from other models; LTX-2 and SANA-Video were tested, prepared at 1024×576. The reference code has only two encode sizes, 768p = 1344×768 and 576p = 1024×576 (`pipeline.py` L21); smaller drafts are scaled up to one of them in pixels first. |
| **Draft preparation** | Resampled to 24 fps. Cover-scaled (bilinear) and centre-cropped to 1344×768, or to 1024×576 with `--input-size 576p`. Cut, or padded by holding the last frame, to 121 frames; 3 more copies of the last frame give 124 frames, which is 37 latent frames. The FP32 H3 VAE posterior is sampled with `--vae-seed` (default 42) (code README L111-115; `pipeline.py` `encode_video` L49-60). |
| **Prompt** | Required (`infer.py` L49). A wrong or generic prompt can pull the result away from the draft. |
| **Or a latent** | An already-encoded normalized H3 latent: [24,37,48,84] at 768P or [24,37,36,64] at 576P (`infer.py` L50-51). |
| **Not taken** | No reference image. Audio is held as "fixed encoded silence" (code README L122). |
| **Output sizes** | 768P (refine only); 1080P (computed at 1920×1088, cropped to 1080); **2K, 2560×1440, the default**; 4K, 3840×2160 (computed at 2176 rows through two latent upscales via 2K) (`pipeline.py` L26 `RESOLUTIONS`, `upscale()`). The 4K demo uses a "resolution ladder": refine at 768p with `--start-sigma 0.8 --save-latents`, then refine that latent again at 4K (code README L103-105). |
| **Sound** | The reference MP4 has none (`-an`, `pipeline.py` L319). The ComfyUI pack's Finish node cuts the draft's soundtrack to length and `CreateVideo` muxes it back. |
| **Length** | The reference code fixes 121 frames, about 5 s at 24 fps (`pipeline.py` L19). The project page claims 5–15 s in one pass and shows a 15 s, 360-frame clip done at 2K. The ComfyUI pack takes up to 3,600 frames ("The refine supports 5-15 s (360 frames) in one pass") and pads to H3's 17k+5 frame grid: 124 = 5 s, 362 = 15 s (`regen_core.py` L49-52). |

**Speed (self-reported; one B200/GB200, one 5 s clip, 768P latent → 2560×1440, warm, median of 3).** 87.26 s with `standard_fwd` (dense BF16, released VAE); 37.39 s with `sol_engine_fwd` and the released VAE; **22.45 s** with `sol_engine_fwd` and the fast H3 VAE decoder (3.89×). Upscale plus refine alone: 73.11 s → 20.46 s (HF README L22-34; code README L24-45). The page header says "5.0× faster than the official API · single B200" but gives no API timing; the measured 3.9× is against its own baseline. `--steps 2` (sigmas 0.7 → 0.494118 → 0) is about 30% faster and "visibly softer on fine texture (fur, moss)" (code README L125-135).

**Quality claims (self-reported; RefinerBench-150, both at 2560×1440, against the official API).** VBench average 0.814 vs 0.802; the API is slightly better on motion smoothness (0.984 vs 0.981) and dynamic degree (0.765 vs 0.752). UniPercept average 60.0 vs 53.4. Blind user study: preferred 174 of 200 times (87%) over 50 cases in 20 sessions (project page §4.1–4.3).

**Limits.** The refine re-noises to σ 0.909 and "redraws a lot". In the pack author's test a small fox's face drifted toward a wolf (darker coat, lost ear tips) while layout and motion held; `start_sigma` 0.8 "stays closer to the draft" (rdh README L113-120). The whole frame is redrawn, so backgrounds, text and logos can change. `sol_engine_fwd` is lossy: same-seed PSNR is not usable and the refined latent differs 5–12% from the reference (code README L139-144).

**Relation to MiniMax.** It is MiniMax-H3 itself (`MiniMaxAI/MiniMax-H3` @ `6818f6c`, the Diffusers `transformer/`, the FL2VA family) with the transformer and VAE frozen, plus one refiner LoRA (HF README L48-51). MiniMax's own H3-Regenerate-2K is a different, closed system: "in-context regeneration" that feeds the 768p result back with the original multimodal context, and it is "not yet open-sourced" (MiniMax-H3 README L81, L151-159). NVIDIA's model is trained on degraded copies of real clips and uses only the text prompt.

### 2.2 How it works

1. The H3 VAE encodes the draft once.
2. The community H3 latent upscaler enlarges the normalized 24-channel latent straight onto the target grid. It is LBH-123-AI's `LatentResizer3D` (345,280,216 parameters, trained for 1–4× spatial scale, time unchanged; LBH HF `config.json`). At 2K it maps 36×64 to 90×160, with no decode and re-encode. Above 2K it runs twice, via 2K (`pipeline.py` `upscale()`).
3. The latent is re-noised: start = (1 − 0.909375) · upscaled + 0.909375 · noise.
4. MiniMax-H3 plus the merged LoRA denoises in **3 Euler steps** on sigmas [0.909375, 0.857143, 0.666667, 0], CFG 1, model time 1 − σ. The 2-step grid (0.7, 0.494118, 0) and any `--start-sigma` use the shift-6 rule 6σ/(1+5σ) (`sigmas.py`). Audio is fixed encoded silence, kept clean.
5. Decode with the released H3 VAE, or with the **fast H3 VAE decoder** from StreamRender-H3: non-causal, 24 layers, 1.62B parameters, distilled from the released 36-layer decoder. It takes 1.6 s instead of 15 s at 2K, with 30.0 dB frame PSNR against the released decoder (code README L149-151).

**Training** (project page §3.1). Stage I of SoL-Refiner (high-resolution continual training) with H3 as the base. Real clips at 1280×704 or 2560×1440; the condition is the same clip degraded 8×–64× (antialiased bilinear) and resized back. Flow-matching velocity loss on σ from 0.91 down. Refiner LoRA rank 384, step-5000 EMA. Stages II (ReFL RL) and III (DMD one-step) are "not used yet".

**Runtimes** (code README L17-22, L52-60, L149-153). `standard_fwd`: Diffusers blocks, dense cuDNN attention, BF16. `sol_engine_fwd`: Sol-Attn sparse attention, MXFP8 GEMMs with fused SwiGLU quantisation, `torch.compile`, one CUDA graph per step. Linux, Python 3.11, PyTorch 2.11 + CUDA 13.0; the fast-decoder engine needs flash-attn-4 4.0.0b27 and quack-kernels. The text encoder is the 32B Qwen3-VL, loaded once before the DiT and then freed.

### 2.3 "They made it a LoRA instead?" — what each release contains

It always was a LoRA. Three packagings exist.

| Packaging | What it is | Keys | Size | Notes |
|---|---|---|---|---|
| NVIDIA `lora/open_h3_regenerate_2k_lora.safetensors` | Three adapters concatenated along the rank axis, with strengths and Turbo's alpha/rank (0.0625) folded into B: the refiner (step-5000 EMA, rank 384), LightX2V FL2VA Turbo v1.2 (rank 128, alpha 8; `lightx2v/Minimax-h3-Turbo` @ `3ec17a3`) and LMS Sharp v1.0 (rank 64; `Alissonerdx/Minimax-H3-ComfyUI`). Rank 576 on 312 linears, FP32, applied at scale 1 | Diffusers (`transformer_blocks.N.*`, `token_refiner.refiner_blocks.N.*`) | 12.45 GB | `MERGE_VERIFY.json`: max matvec relative error 2.23e-8 over 312 modules. 312 = 52 blocks (50 transformer blocks + 2 token-refiner blocks) × {to_q, to_k, to_v, to_out.0, ff.net.0.proj, ff.net.2}; 624 F32 tensors counted from the header (HF README "What the LoRA contains"; `lora/lora_config.json`) |
| NVIDIA `lora/sharp_curve_branches.safetensors` | LMS Sharp's 50 AdaLN "curve branches" (`curve_A` [64,8] + `curve_B` [96768,64]). They read an 8-D timestep curve from a 1025×8 `adaln_t_table` that is not redistributed; it comes from Comfy-Org's `minimax_h3_ref2va_pruned_int8_convrot.safetensors` @ `e5eb578a` | — | 1.24 GB | **New finding: the `curve_B` tensors checked are all zero** (blocks 0, 7, 10, 25, 37 and 49 of 50; `curve_A` is non-zero), and so is the source LMS LoRA's `adaln_proj.linear` lora_B (blocks 0, 25, 49). So the branches add exactly zero in the blocks checked; the other blocks are inferred. This matches father558's report ("curve_B … is all zeros … It has no effect") and rdh's note that the fox drift also happened with the branches off |
| Kijai `loras/minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors` | "The refiner part ONLY, doesn't include the LMS or the lightx2v turbo" (Kijai README). Metadata: "refiner ranks 0:384 of the rank-576 merge (refiner\|turbo\|sharp); alpha == rank, strength folded"; qkv block-diagonally fused (rank 1152), SwiGLU halves swapped, scale 1.0 baked | ComfyUI (`diffusion_model.blocks.N.*`, `diffusion_model.token_refiner.blocks.N.*`) | 5.87 GB, 416 BF16 tensors | Uploaded 2026-10-28 (commits `7afab6c`, `a671238`). A rank-16 SVD resize (0.16 GB) is lossy |
| Community repacks | father558 r128 (an SVD of the whole merge, about 4.5% average delta error, SwiGLU order "not confirmed"; ran at about 1080p on a 32 GB RTX 5090 D in 1 min 42 s); DrakenZA rank-576 and r128 "swiglu_fixed" ("Runtime loading and output fidelity NOT yet verified"); a 1038lab mirror with no README | ComfyUI | 1.96–8.80 GB | All 2026-10-28/29, unverified, no licence declared |

**To match NVIDIA's merge with Kijai's file** you also load Turbo v1.2 and LMS Sharp r64 (rdh README L125-131). The Turbo v1.2 ComfyUI file carries per-module alpha tensors (training_alpha 8, rank 128), so core loaders apply the right 0.0625 scale. Because Sharp's AdaLN part is zero, three core `LoraLoaderModelOnly` loads (Kijai r384 + Turbo v1.2 + LMS r64) should equal NVIDIA's merge up to bf16/fp16 rounding. This is inference; it was not run. Loading NVIDIA's merge (or a community full merge) **together with** Kijai's file would apply the refiner twice.

**What the rdh9616 pack adds over core + Kijai** (`__init__.py`, README). It loads NVIDIA's full Diffusers merge at load time (rank 576 → ComfyUI keys, "verified bit-exactly"; 6.2 GB of RAM in bf16, 12.4 GB in fp32). It installs the curve branches (`curve_name` can be "none"). It has the release sigma grids; draft preparation (24 fps, cover-crop to 768p or 576p, portrait sizes, "keep (snap to 32)", the 17k+5 grid, up to 3,600 frames); the LBH upscaler onto the target grid (4K via 2K); an audio-video refine latent with the audio masked clean (a `NestedTensor` noise mask); the StreamRender fast decoder with a tiled fallback to the normal VAE; Finish (trims padding, crops 1088 → 1080 and 2176 → 2160, cuts the soundtrack); Save / Load refined latent; and a "Video to H3 Prompt" node for an OpenAI-compatible vision server.

### 2.4 Weights

Full SHA-256 values are in the JSON (`items[0].weights`).

| File | Repo @ revision | Bytes | SHA-256 | Licence (information) | Needed for |
|---|---|---|---|---|---|
| `lora/open_h3_regenerate_2k_lora.safetensors` | Efficient-Large-Model/Open-H3-Regenerate-2K @ `5809c337` | 12,452,449,080 | `8e36a091…0c681bb04` | MiniMax H3 Community; the merged Turbo and LMS parts keep their own terms ("not covered by a single blanket license") | the pack route (`models/loras`) |
| `lora/sharp_curve_branches.safetensors` | same | 1,238,746,768 | `26ff1c4e…ae92102e4e` | LMS Sharp's terms (not declared) | optional; appears to be a no-op (§2.3) |
| `vae_fast/fast_h3_vae_noncausal_24l.safetensors` (also `Efficient-Large-Model/Sol-H3-VAE` `sol_h3_vae.safetensors` @ `6a8a33fc`, same bytes) | same | 6,471,256,328 | `8658f1e8…f54e77a1` | MiniMax H3 Community (a distilled Model Derivative, licence §I.11); the Sol-H3-VAE copy declares none | fast decode (`models/vae`); optional, a tiled core decode works |
| `latent_upsampler/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` (identical to LBH-123-AI/Minimax_h3_latent_Upscaler @ `3f941d5d`) | same | 690,592,992 | `4f57821f…3b146a5e6` | Apache-2.0 (LBH's HF tag; NVIDIA's copy ships the Apache text). LBH's node code is MIT | the latent hand-off (`models/latent_upscale_models`). LBH also ships fp16 (690,592,672 B) and an fp32 `.pth` (1,381,251,539 B), which rdh's examples load |
| `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | Comfy-Org/MiniMax-H3 @ `1c41cfca` (identical at `e5eb578a`) | 20,970,379,616 | LFS oid `e889202c…` (prefix only) | MiniMax H3 Community | the base rdh's workflows load ("the reference base is FL2VA"). Lighter at `e5eb578a`, untested with the pack: `fl2va_pruned_w6a8` 15,983,746,636 B, `fl2va_pruned_fp8_scaled` 20,958,205,608 B |
| Already pinned by Fuobe: `minimax_h3_ref2va_pruned_int8_convrot` (20,970,379,616 B), `qwen3vl_32b_minimax_h3_nvfp4_awq` (15,687,142,551 B), video VAE fp16 (5,207,808,496 B), audio VAE fp32 (605,254,808 B) | Comfy-Org/MiniMax-H3 @ `1c41cfca` (`scripts/comfy/library.spec.mjs` L189-192) | — | — | MiniMax H3 Community | text encoder and VAEs; the pack reads only the 32 KB `adaln_t_table` from the ref2va file |
| `loras/minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors` | Kijai/MiniMax-H3-experimental @ `f5c3b1d5` | 5,868,409,512 | `4bf30291…7130b88818c2` | not declared (a slice of NVIDIA's merge, so MiniMax H3 Community presumably applies; inference) | the core-only route |
| `loras/…_refiner_rank_16_bf16.safetensors` | same | 155,133,472 | `add559cd…e0217820fbd` | not declared | lossy; not recommended |
| `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | lightx2v/Minimax-h3-Turbo @ `3ec17a32` | 1,956,193,000 | not recorded | Apache-2.0 in the card at `3ec17a3`; the field is gone at main `30f485ed` | the core-only route and a prompt → 768p draft. NVIDIA's merge already contains it. Main also has v1.3; NVIDIA uses v1.2 |
| `loras/minimax_h3_lms_v1.0_r64.safetensors` | Alissonerdx/Minimax-H3-ComfyUI @ `fd3dde7b` | 1,239,664,536 | `16f3195b…dfdeacf60c` | repo "other / mixed-asset-licenses"; LMS has no stated licence | the core-only route. **NVIDIA's pin `849fb3d4` no longer resolves** (history rewritten); the same file is at main `fd3dde7b` |
| `open_h3_regenerate_2k_comfy_swiglu_fixed.safetensors` (+ an r128) | DrakenZA/Open-H3-Regenerate-2K-ComfyUI @ `f81f29e4` | 8,802,581,272 (r128 1,956,195,288) | 1038lab mirror sha `dc08fe95…` / `25f9af42…` | not declared | community; "fidelity NOT yet verified" |
| `base_model/` (Diffusers H3 without FL2VA/, Ref2VA/, transformer_ref/) | Efficient-Large-Model/Open-H3-Regenerate-2K | 144,051,199,094 (whole repo 164,904,315,541) | — | MiniMax H3 Community; `LICENSE-Qwen.txt` is the Apache-2.0 text | NVIDIA's reference code only, not ComfyUI |

### 2.5 Licences, as written (for Settings → Models & licences)

- **MiniMax H3 Community License** (`LICENSE` @ MiniMaxAI/MiniMax-H3 `6818f6c`, 17,604 B; licensor Nanonoble Pte. Ltd.). It covers the base model, the refiner LoRA and the fast VAE decoder (HF card, License section).
  - §I.3 / §I.5: the "Applicable Territory" is worldwide **excluding the European Union, the United Kingdom, the Republic of Korea and the United States**. §II grants royalty-free use, distribution and derivatives only inside it. §V.4 forbids use or display outside it.
  - §III: distribution needs a copy of the Agreement and notices on modified files. Distributions other than through Hosted Services need a NOTICE file reading "MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved." "Powered by MiniMax H3" is only encouraged (§III.3).
  - §IV.1: commercial products earning more than US$20M a year need prior written authorisation (api@minimax.io). §IV.2: commercial products must "prominently display "MiniMax H3"" on their UI.
  - §V.2: recipients and users must be bound to terms at least as protective as §V and Exhibit A, and told so. §V.3: no using the works or outputs to improve other AI models. §V.5: hosted or third-party services keep safeguards and a reporting mechanism. §VI.4: MiniMax claims no rights over outputs. Exhibit A item 12: content generated into public environments must be disclosed as machine-generated.
  - Fuobe already records it as `commercial: true, hostedOk: true` (`src/lib/catalog/character-swap.ts` L81) with the territory text.
- **Comfy's MiniMax H3 docs** (docs.comfy.org, fetched 2026-10-29) say "Commercial use of locally generated outputs requires a MiniMax commercial license", available through Comfy, while Comfy Cloud generations "already include commercial rights". This conflicts with the licence text's royalty-free grant inside the territory. Recorded as information (`docs/research/comfyui-oss.json` L2413 already notes it).
- **Code.** NVlabs/Sana `sol-engine` (this folder and `Sol-H3-ComfyUI`): Apache-2.0; weights follow their own licences. rdh9616 pack: Apache-2.0 (LICENSE, NOTICE); it vendors NVIDIA's `fast_vae/decoder.py` with only a 2-line header added and re-hosts no weights. LBH node code: MIT, "Copyright (c) 2026 LBH-123-AI"; LBH weights: Apache-2.0.
- **LightX2V Turbo** (merged in, and the separate file): Apache-2.0 in the card at `3ec17a3`; at main `30f485ed` (2026-10-20) the licence field is gone and the card defers to an unnamed "repository license". As an H3 derivative, the MiniMax terms may apply too (inference).
- **LMS Sharp v1.0**: no explicit licence (repo "other: mixed-asset-licenses"; `LICENSES.md` covers only the Character Swap and Motion Transfer LoRAs).
- **Kijai, father558, DrakenZA, 1038lab**: no licence declared. father558 will take its file down on request.
- **HyperFlow 8-step adapter** (an optional prompt → 768P drafter in NVIDIA's code; `VideoRebirthAI/hyperflow` @ `5bde94d`): "other / minimax-h3-community-license-agreement". Not needed by Fuobe.
- **Closed alternatives (paid; information only).** MiniMax "MiniMax-H3-Regeneration": $0.05/s of output, and the original task's inputs are billed again (video $0.05/s of the original duration; first 5 images free, then $0.025 each; audio free) (platform.minimax.io `pricing-paygo` L266-276). Comfy partner node "MiniMax H3 Regenerate to 2K": $0.0715/s (its price badge).

### 2.6 ComfyUI: node packs and the graph Fuobe would build

| Pack | Commit | Licence | Node classes |
|---|---|---|---|
| [rdh9616/ComfyUI-Open-H3-Regenerate](https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate) (v1.0.0; 3 commits, all 2026-10-28; still the remote head on 10-29) | `9b686c5ffd380e9d1351f9b8beef6d20d703ca3e` | Apache-2.0 | `OpenH3RegenLora`, `OpenH3RegenSigmas`, `OpenH3RegenPrepareDraft`, `OpenH3RegenUpscale`, `OpenH3RegenRefineLatent`, `OpenH3RegenFastVAEDecode`, `OpenH3RegenFinish`, `OpenH3SaveRefinedLatent`, `OpenH3LoadRefinedLatent`, `OpenH3VideoToPrompt` |
| [LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | `40316cf008b2fd8663263270669eb4da23f89d2c` (2026-09-17) | MIT | `MinimaxH3LatentUpscaler3D`, `MinimaxH3LatentUpscalerNode2D`, `MMH3TemporalSplitParamsV10`, `MMH3SpatialSplitParamsV10`, `MMH3SplitUpscale` |
| ComfyUI core at Fuobe's pin | `fc04da91` (v0.41.0-7) | GPL-3.0 | `UNETLoader`, `CLIPLoader` (type minimax), `VAELoader`, `LoadVideo`, `GetVideoComponents`, `VAEEncode`, `CLIPTextEncode`, `BlockSparseAttention` ("Model Sparse Attention": sol-attn / sla / vsa), `RandomNoise`, `KSamplerSelect`, `BasicGuider`, `SamplerCustomAdvanced`, `ManualSigmas`, `LoraLoaderModelOnly`, `VAEDecodeTiled`, `CreateVideo`, `SaveVideo` |

- The rdh pack needs `av` and `safetensors` (its requirements.txt; both are already in ComfyUI's own requirements: `av>=17.0.0`, `safetensors>=0.4.2`), ComfyUI with native H3 (tested on 0.42.0) and the LBH pack: `OpenH3RegenUpscale` looks up the class `MinimaxH3LatentUpscaler3D` and raises without it (`__init__.py` L415-418). The `comfy.*` modules it imports (`comfy.nested_tensor`, `comfy.ldm.minimax.vae` and `.model`, `comfy.lora`, `comfy.ops`, …) all exist at Fuobe's pin. Nothing was run.
- The LBH pack has no requirements.txt. Its 3D node has three resize modes, `align` 32, temporal chunking, `force_unload`, a device option that includes ROCm, and precision fp32/fp16/bf16. Its README: "saves time, not VRAM". It is not installed on the local ComfyUI.
- Core, even v0.43.1, has no H3 latent upscaler and no open regenerate node. Core's `MinimaxHailuo03RegenerateNode` ("MiniMax H3 Regenerate to 2K") is the **closed** paid API (§2.7).

**The graph Fuobe would hand-build: `video-regenerate-h3`.** Start from rdh's `example_workflows/Open-H3 Regenerate 2K - Draft Video.json` (28 nodes; nodes and links dumped from the file) and make three changes: drop `OpenH3VideoToPrompt` (13) and its two `PreviewAny` nodes (14, 15), and set `CLIPTextEncode` 16's text directly, so no server is called from the graph; drop the `PreviewAny` on the LoRA report (5) and the note (1); and set `curve_name` to "none" (§2.3). Keep `OpenH3SaveRefinedLatent` (24): it writes the refined latent before decoding (about 150 MB for 15 s at 2K), so a failed decode can be redone in about a minute with rdh's "Decode Saved Latent" graph instead of a new refine. Node ids are rdh's.

| id | class | settings (rdh's example) | Fuobe binding |
|---|---|---|---|
| 2 | `UNETLoader` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors`, default | — |
| 3 | `OpenH3RegenLora` | `open_h3_regenerate_2k_lora.safetensors`; curve **none** (rdh: `sharp_curve_branches.safetensors`); curve_table `minimax_h3_ref2va_pruned_int8_convrot.safetensors`; strength 1.0; curve_strength 1.0; lora_dtype bf16 | — |
| 4 | `BlockSparseAttention` | sol-attn, 1.2, 0.0, 0.9, "0,1,49", 12288, 256, exact_kv_and_rows, true | — (Sol-Attn needs comfy-kitchen's kernel, CUDA sm_80+ or ROCm WMMA; without it attention stays dense, about 4× slower) |
| 6 | `CLIPLoader` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`, minimax, default | — |
| 7 / 8 | `VAELoader` | `minimax_h3_video_vae_fp16` / `minimax_h3_audio_vae_fp32` | — |
| 9 | `LoadVideo` | draft.mp4 | `video` |
| 10 | `GetVideoComponents` | images, audio, fps | — |
| 11 | `OpenH3RegenPrepareDraft` | size '768p (1344x768)' \| '576p (1024x576)' \| 'keep (snap to 32)'; max_frames 121 (0–3600); images ← 10.0, source_fps ← 10.2. Output 1 is the frame count that 24 and 26 read | `draftSize`, `frames` |
| 12 | `VAEEncode` | pixels ← 11, vae ← 7 | — |
| 16 | `CLIPTextEncode` | text set directly (rdh links it from 13), clip ← 6 | `prompt` |
| 17 | `OpenH3RegenUpscale` | `minimax_h3_latent_upscaler_3d_conv_v1_fp32.pth` (or the bf16 safetensors), '2k (2560x1440)' (768p / 1080p / 2k / 4k), bf16, temporal_chunking false | `resolution` |
| 18 | `OpenH3RegenRefineLatent` | audio_mode 'silence (reference)' (or 'draft audio', 'keep latent audio'), audio_vae ← 8 | — |
| 19 | `OpenH3RegenSigmas` | steps 3 (1–8), start_sigma 0.0 (0 = the release grid; above 0 = the shift-6 grid) | `steps`, `startSigma` |
| 20 | `RandomNoise` | 1766580932, fixed | `seed` |
| 21 | `KSamplerSelect` | euler | — |
| 22 | `BasicGuider` | model ← 4, conditioning ← 16 | — |
| 23 | `SamplerCustomAdvanced` | noise ← 20, guider ← 22, sampler ← 21, sigmas ← 19, latent_image ← 18 | — |
| 24 | `OpenH3SaveRefinedLatent` | 121, 'open_h3_regen'; samples ← 23, frame_count ← 11.1, audio ← 10.1 | — |
| 25 | `OpenH3RegenFastVAEDecode` | `fast_h3_vae_noncausal_24l.safetensors`, keep_loaded false; samples ← 24, vae (fallback) ← 7 | — |
| 26 | `OpenH3RegenFinish` | 121, crop 'auto (1088 -> 1080, 2176 -> 2160)'; images ← 25, frame_count ← 11.1, audio ← 10.1 | — |
| 27 | `CreateVideo` | 24.0, auto, sRGB, none; images ← 26.0, audio ← 26.1 | — |
| 28 | `SaveVideo` | `video/open_h3_regen_2k`, auto, auto, auto | `filenamePrefix`; output, kind video |

Bindings Fuobe needs: `video`; `prompt`; `resolution` (Fuobe's tiers: 1080p → "1080p", 1440p → "2k", 2160p → "4k"); `draftSize` (768p for H3 drafts, 576p for other models, "keep" for portrait or odd shapes); `frames` (the clip's own frame count at 24 fps, at most 360, on 11's `max_frames`; 24 and 26 read 11's frame-count output); `startSigma` (Close 0.7, Balanced 0.8, More detail 0 = the release 0.909); `steps` (3, or 2 for "Faster"); `seed`; `filenamePrefix`. rdh's other two examples are "Prompt to 2K" (32 nodes: a 768P H3 draft with Turbo 4-step v1.2, 6 steps `er_sde`, handed straight into the same chain) and "Decode Saved Latent" (7 nodes) (§2.10, package N7-10).

**A core-only route (untested; a fallback, not the plan).** `UNETLoader` (FL2VA, or Fuobe's ref2va) → three `LoraLoaderModelOnly` (Kijai r384 + Turbo v1.2 + LMS r64, or one community full merge) → `BlockSparseAttention` → `ManualSigmas` "0.909375, 0.857143, 0.666667, 0" → `RandomNoise` / `BasicGuider` / `SamplerCustomAdvanced` → `VAEDecodeTiled`. Core still lacks the latent hand-off (keep the LBH node, or pixel upscale + `VAEEncode`, which is slower; rdh saw the same fox drift either way) and a refine latent whose audio rows are masked clean.

**Install.** Fuobe's `scripts/comfy/install-comfyui.sh` pins neither pack. It pins `h3_character_swap` @ `0670e4f` (on by default, `H3_PACK=1`) and the opt-in `h3-relay` @ `e2a7665b` (`H3_RELAY=1`) (L63-94). Add an opt-in `OPEN_H3_REGEN=1` block that clones both packs at the commits above. The manifest has no regenerate workflow yet.

### 2.7 Cloud routes

No fal or Replicate endpoint hosts Open-H3-Regenerate-2K. fal model searches for "regenerate", "regeneration", "h3", "minimax", "refine video", "open-h3" and "sol-refiner" found no regenerate endpoint; Replicate hosts `minimax/h3` itself but no regenerate. The only hosted copy of the open model is a Gradio Space (`hugging-apps/efficient-large-model-open-h3-regenerate-2k`, zero-a10g, created 2026-10-28), which is not an API Fuobe uses.

| Provider | Endpoint | What it does | Price |
|---|---|---|---|
| fal | `minimax/h3/reference-to-video/lora` (also `image-to-video/lora`, `text-to-video/lora`) | H3 with LoRAs. `resolution` 480P \| 768P \| 2K \| 4K (default 2K): "480P and 768P are native generation modes; 2K and 4K upscale a 768P base result". Fuobe's Character swap sends only 480P/768P (`character-swap.ts` `falResolution` L172) | $0.0625/s 480p, $0.075/s 768p, **$0.1625/s 2K, $0.20/s 4K** |
| fal | `minimax/h3/image-to-video`, `text-to-video`, `reference-to-video` | The same resolution enum at generation time. Fuobe's `minimax-h3` cloud model already lists 480P–4K (`src/lib/catalog/cloud-models.generated.ts` L6157-6162) | $0.05/s 480p, $0.06/s 768p, $0.13/s 2K, $0.16/s 4K |
| Replicate | `minimax/h3` | `resolution` 768P \| 2K (default 2K), duration 4–15, first/last frame, references. 2K at generation time; no regenerate of an existing clip. Not wired in Fuobe | $0.08/s 768P, $0.13/s 2K |
| MiniMax (direct; no Fuobe provider) | `POST https://api.minimax.io/v2/video_regeneration` | The closed regenerate. Model MiniMax-H3, resolution 2K, `callback_url`, `aigc_watermark`. Either `source_task_id` (whitelist only; the account's own task, under 7 days old) or one `base_video` plus the exact final prompt sent to the model (after H3-Context-IR, ≤ 40,000 chars) and the same references. The source must be an unmodified H3 768P output: 24 fps, sides divisible by 32, 589,824–1,032,192 px, 107–362 frames in steps of 17, with an audio track. Body ≤ 64 MB | $0.05/s of output + the original inputs billed again |
| Comfy partner node | `MinimaxHailuo03RegenerateNode` | The same closed regenerate inside ComfyUI, billed in Comfy credits; needs a Comfy.org account, which Fuobe doesn't wire | $0.0715/s |
| fal | `fal-ai/seedvr/upscale/video` (Fuobe `seedvr-video`) | Faithful restoration upscale | $0.001 per output megapixel (1080p × 121 frames ≈ $0.25) |
| fal | `topaz/upscale/video/generative` (Fuobe `topaz-starlight`) | Generative upscale | 10 s at 30 fps: $1.20 up to 1080p, $2.60 at 4K (Starlight Fast 2: $0.60 / $1.30); 60 fps doubles |
| fal | `topaz/upscale/video/creative` (not in Fuobe) | Astra 2, the most redraw-like hosted upscaler | 10 s at 30 fps: $3.00 up to 1080p, $5.00 at 4K |

**The hosted-parts recipe.** (1) For H3 renders Fuobe makes on fal (Character swap, Swap Studio takes, the `minimax-h3` model), ask for 2K or 4K at generation time. That is a new render, not a sharpened copy of the take; that fal's 2K/4K is MiniMax's regenerate underneath is a guess. (2) For any other clip, use SeedVR (faithful), Starlight, or Topaz creative (the most redraw-like). (3, later) A direct MiniMax provider or Comfy credits for the closed regenerate. These accept only unmodified H3 768P outputs with their exact final prompt and references, so they fit Fuobe-made H3 results whose prompt Fuobe stored, not uploads.

### 2.8 Hardware

| Setup | Result | Source |
|---|---|---|
| One B200/GB200 | "about 150 GB for sol_engine_fwd with CUDA graphs"; 5 s at 2K in 22.45 s (fast decoder) or 87.26 s (`standard_fwd`); the first call for a new latent shape takes 39 s (engine build and graph capture), and a new prompt length re-captures | code README |
| RTX PRO 5000 Blackwell 72 GB, Windows, ComfyUI 0.42, int8 FL2VA base, 5 s 768P → 2560×1440 | refine 122 s + fast decode 24 s ≈ 3 min warm (206 s cold); with ComfyUI's own VAE decode ≈ 3.5 min; **dense attention: refine 474 s, ≈ 9.5 min**; prompt → 768P draft (6 × 16 s) → 2K ≈ 5 min | rdh README "Speed" |
| Fast decoder | 12 s at 1080p; at 2K 22 s / 21 GB peak for 5 s and 69 s / 45 GB for 15 s; VRAM ≈ 6.5 GB + 26 KB per latent token (NVIDIA's own forward peaks near 71 GB at 2K) | rdh README |
| RTX 5090 D 32 GB (community; lossy r128 LoRA) | 3-step sampling at about 1080p in 1 min 42 s; the only sub-48 GB report found | father558 README |

The merged LoRA's RAM copy takes 6.2 GB (bf16) or 12.4 GB (fp32). A saved refined latent is about 150 MB for 15 s at 2K. **New downloads** for the pack route: 12.45 + 6.47 + 0.69 ≈ **19.6 GB**, plus 20.97 GB for the FL2VA base if Fuobe's ref2va file won't do (unknown), plus 1.24 GB for the curve file if kept. Fuobe's H3 advice today is "24 GB of VRAM with offloading and 64–128 GB of RAM; 48 GB+ for 768p" (`character-swap.ts` L462). A 2K refine below 48 GB is untested (guess: 32 GB can reach 1080p; 2K likely needs more). 1080p is lighter: about 75k vs 133k video tokens, computed from the latent grids.

### 2.9 Fuobe today

- **Character swap stops at H3's native sizes.** `CHARACTER.qualities` is ["480p", "768p"] (`src/lib/catalog/character-swap.ts` L27); `characterQuality` maps anything higher to 768p (L160); `falResolution` sends only 480P/768P (L172). Character Swap Studio renders at 0.5 or 1 MP (`qualityFor`, `src/lib/catalog/swap-studio.ts` L81).
- **Swap Studio's Finish is a dead end.** The Assemble stage shows "Finish: clean backplate and alpha compositing" marked Not available (`FINISH_UNAVAILABLE`, `swap-studio.ts` L1356; `src/components/swap-studio/stage-review.tsx` L174, L247-248). Each take already keeps a 16-bit FFV1 lossless master for the next segment (manifest `video-character-swap-h3-segment`, notes).
- **Upscale → Video** (`VIDEO_UPSCALE_STUDIO`, `src/lib/studios.ts` L129): cloud default Topaz Video; open `oss-seedvr2` (default) and `oss-upscale-video-esrgan` with tiers 720p / 1080p / 1440p / 2160p (`VIDEO_UPSCALE_TIERS`, `src/lib/catalog/models.ts` L42; the ModelDefs at L423-445). `seedvr-video`, `topaz-video` and `topaz-starlight` are cloud models.
- **Result actions.** "Render this draft in 1080p" (`src/lib/output-actions.ts` L150) is the only finishing action on a result today.
- **Canvas.** The Upscale node maps `upscale-video` to `topaz-video` / `oss-upscale-video-esrgan` (`src/lib/catalog/canvas.ts` L230, L348).
- **Faceless** "Upscale to 1080p": cloud `seedvr-video`, open `oss-upscale-video-esrgan` (`src/lib/catalog/faceless.ts` L599-654).
- **Cinema** video resolutions are 480p / 720p / 1080p (`VIDEO_RESOLUTIONS`, `src/lib/catalog/cinema.ts` L559).
- **Pins.** `install-comfyui.sh` (L63-94) pins only the Character swap packs. `library.spec.mjs` L189-193 pins the H3 ref2va base, encoder, VAEs and Turbo 8-step v1.0 at `1c41cfca` / `3ec17a3`. No FL2VA base, no Turbo v1.2, no regenerate files.

### 2.10 Where it goes and why

**Regenerate is a finishing step, not a new studio.** It appears wherever a video is already finished and could be sharper. It goes first where H3 drafts are made (the Character swap), because those drafts are exactly what it was trained on.

| Where (exact spot) | What the user does | Open engine | Cloud engine | Priority · package |
|---|---|---|---|---|
| **Upscale → Video**: a model "Open-H3 Regenerate · creative" beside SeedVR2 "Restore · faithful" (`VIDEO_UPSCALE_STUDIO`; new `oss-h3-regenerate` in `models.ts` with tiers 1080p / 1440p / 2160p) | Drops a soft 480–768p AI clip, picks Creativity (Close / Balanced / More detail) and gets 2K with the original sound | `video-regenerate-h3` (§2.6); 576p preset for non-H3 sources; ≤ 15 s per pass, longer clips in 15 s windows joined with the existing concat graphs and a seam note | no hosted open model: `topaz-starlight` stays the creative choice; add `topaz/upscale/video/creative` (Astra 2) | P0 · N7-3 |
| **Result tiles and the Library viewer**: "Regenerate in 2K" in the output menu next to "Render this draft in 1080p" (`output-actions.ts` L150), and in next-step chips for H3, LTX, Wan and SANA videos | One click on a 768p shot they like, with the same prompt | `oss-h3-regenerate` prefilled with the generation's own prompt, 768p preset for H3 outputs, 2K, sound muxed back | fal H3 outputs: "Re-render at 2K" on the same endpoint with the same inputs and seed ($0.13/s, LoRA route $0.1625/s), shown as a new render; other sources: SeedVR or Starlight | P0 · N7-3 |
| **Canvas Upscale node**: a "Regenerate (creative)" choice (`canvas.ts` L230, L348) | Wires any video into it | `oss-h3-regenerate` | `topaz-starlight` | P0 · N7-3 |
| **Character Swap Studio → Assemble → Finish** (`stage-review.tsx` L247-248): split into "Sharpen to 1080p / 2K / 4K" (runnable) and Akatz's "Clean backplate + alpha" (still not available) | The swapped takes came back at 768p and look soft. Picks 2K, sees the price or GPU time; only the character is put back over the original footage, so the background stays as filmed and the sound is untouched | each chosen take's FFV1 master → `video-regenerate-h3` with the take's prompt, `start_sigma` 0.8, a fixed seed; composite only the approved mask (scaled, grown, feathered) from the 2K result over the source frames at the source size; then assemble as today. Takes over 15 s run in 15 s windows | no hosted post-hoc regenerate: re-queue the chosen segments on fal `minimax/h3/reference-to-video/lora` at 2K / 4K ($0.1625 / $0.20 per s instead of $0.075 at 768p) as new takes shown side by side for approval. Fallback for an assembled film: SeedVR or Topaz creative | P0 · N7-4 |
| **Genjutsu → Character swap → Quality** (`character-swap.ts` L27, L160, L172) | Picks 2K and sees "$0.81 for 5 s" in the cloud or "+~3 min on a 72 GB GPU" on their own | keep the 768p swap and add a step to the plan: swap → regenerate at σ 0.8 → mask composite → mux | `resolution` "2K" / "4K" on the fal LoRA route (5 s at 2K = $0.81; 15 s = $2.44). H3 Max Recast stays at 768P / 1080P | P0 · N7-4 |
| **Faceless** "Upscale to 1080p" (`faceless.ts` L599-654) → add "Regenerate to 1080p (sharper, may redraw)" | Each soft scene is redrawn at 1080p with its own scene prompt before the join | per scene (≤ 15 s): 1080p, 576p preset, σ 0.8, then the existing join and music | unchanged: `seedvr-video` (1080p, 121 frames ≈ $0.25) | P2 · N7-10 |
| **Edit video and Shorts segments**: "Enhance (H3 regenerate)" on a selected segment ≤ 15 s | Cleaner 1080p after a restyle, matching the rest of the edit | 1080p, 576p preset, the segment's restyle prompt; Wan VACE output at 16 fps goes through RIFE to 24 fps first | `seedvr-video` or `topaz-starlight` | P2 · N7-10 |
| **Cinema and Video studio H3 shots**: "Finish in 2K" on a keeper, and a 2K tier (`cinema.ts` L559) | Drafts at 768p cheaply, then finishes only the take that made the cut | needs a plain open H3 graph first: rdh's "Prompt to 2K" shape (FL2VA int8 + Turbo 4-step v1.2, 6 steps `er_sde`), handing the latent to the regenerate chain, or saving it for later (`OpenH3SaveRefinedLatent` / NVIDIA's `--save-latents` ladder) | fal `minimax/h3/*` at 2K for the final take ($0.13/s; LoRA route $0.1625/s); drafts at 768P ($0.06/s on fal) | P2 · N7-10 |
| **Settings → Models & licences, About, Workflows page, `install-comfyui.sh`, manifest** | The owner sees the new files and packs with their licences and switches, and one install line | rows for each file and pack (§2.5) | rows for the fal 2K / 4K tiers, Replicate 2K and, if added, MiniMax regeneration and the Comfy partner node | inside each package |

**Since 2026-10-30 (this overrules the table's cloud column).** The cloud uses only models that are hosted, with no substitute model. Nobody hosts Open-H3-Regenerate-2K, so "Regenerate · creative" is GPU-only: on the cloud engine it says "Runs on your GPU (open source)", and Engine mode "Paid APIs only" hides it. `topaz-starlight` is not the cloud "Regenerate" (Upscale → Video keeps it and Topaz Astra 2 under their own names), and the Canvas Upscale node's Regenerate choice is disabled on the cloud rather than mapped to Starlight. The one cloud action kept is a fal H3 result re-rendered at 2K or 4K on the same hosted model ("Re-render at 2K · a new render"), which is the same model asked for a size it offers, not a stand-in. (Built in package n7-3-regenerate-2k.)

### 2.11 Risks and unknowns

**Risks**

- **It redraws, it doesn't just enlarge.** At σ 0.909 a fox's face "drifted toward a wolf" (rdh README L118-120). For the Character swap this can change identity and the background: default to σ 0.8 and composite only the swapped person's mask over the original frames. Copy says "may redraw details".
- **It is not Akatz's Finish.** Clean backplate + alpha stays unavailable; copy must not imply that problem is solved.
- **Licence territory and terms.** The MiniMax H3 Community License does not cover the US, EU, UK or Republic of Korea. It asks for "MiniMax H3" on commercial UIs (§IV.2), authorisation above US$20M (§IV.1), user terms (§V.2) and safeguards for services (§V.5). Comfy's docs add that local commercial output needs a MiniMax licence, which contradicts Fuobe's `commercial: true` record.
- **Dead pin.** NVIDIA's `lora_config.json` pins Alissonerdx revision `849fb3d4`, which no longer resolves ("Invalid rev id"; history rewritten). Pin LMS by SHA-256 `16f3195b…` at `fd3dde7b`. Other community repos may rewrite history the same way.
- **LightX2V's licence moved** (the field is gone at main `30f485ed`). Keep pinning `3ec17a3`, for the merge's parity and for the recorded licence.
- **Zero curve branches** were checked in 6 of 50 blocks. If NVIDIA or Alissonerdx ship non-zero branches later, behaviour changes.
- **Hardware.** Tested on a B200 (~150 GB) and a 72 GB card. 2K on 24–48 GB is untested. Sol-Attn needs CUDA sm_80+; dense attention is about 4× slower (474 s vs 122 s).
- **Downloads.** About 19.6 GB new, plus 1.24 GB for the curve file if kept, plus 20.97 GB for FL2VA if ref2va won't do; 6.2–12.4 GB of RAM for the merged LoRA.
- **Very new, single author.** The rdh pack is v1.0.0 with 3 commits on one day. It replaces AdaLN module forwards. It was tested on ComfyUI 0.42.0; Fuobe pins 0.41.0-7. Its imports exist locally, but nothing has run. NVIDIA's own code targets Linux, PyTorch 2.11 and CUDA 13.0 only.
- **Community single-file LoRAs** (father558, DrakenZA, 1038lab) appeared within a day with self-declared unverified SwiGLU order and fidelity. Don't adopt one without an A/B against the rdh pack. Never load a full merge together with Kijai's slice (the refiner would apply twice).
- **Length.** The reference does exactly 121 frames; the page and the pack claim 360 frames per pass. Longer clips need windows with no shared history, so seams or flicker are likely.
- **Audio.** The refine holds encoded silence and NVIDIA's MP4 has no audio: always mux the source sound back.
- **Prompt dependence.** A prompt is required; a generic one can push content away from the draft.
- **Self-reported numbers.** VBench, UniPercept, the 87% preference and "5.0× faster" are NVIDIA's own.

**Unknowns**

- Whether the refiner LoRA works on Fuobe's pinned `minimax_h3_ref2va_pruned_int8_convrot` instead of the FL2VA base the pack's workflows load (NVIDIA's base is the FL2VA transformer; LMS was trained on ref2va). If FL2VA is required, Fuobe needs another 20.97 GB file (w6a8 at 15.98 GB is untested).
- Whether all 50 `curve_B` tensors are zero (6 of 50 checked in NVIDIA's file, 3 of 50 in the LMS source).
- The VRAM floor for a 1080p or 2K refine on 24 / 32 / 48 GB cards with ComfyUI offloading.
- Whether the rdh pack runs unchanged on Fuobe's pinned `fc04da91` (tested on 0.42.0).
- Quality on non-16:9 drafts such as 9:16 swaps (the reference covers only 1344×768 and 1024×576).
- Whether σ 0.8 keeps a swapped character's identity, and how a mask-only composite of a 2K regenerate looks at the edges.
- What fal's "2K and 4K upscale a 768P base result" runs (guess: MiniMax's closed regenerate); the same for Replicate at 2K.
- Whether MiniMax's `/v2/video_regeneration` or the Comfy node accepts H3 768P files made on fal or Replicate (they need an unmodified output with audio and the exact post-Context-IR prompt).
- Whether a core-only route (Kijai r384 + Turbo v1.2 + LMS r64, or a community full merge) matches the pack's output, and how to mask the audio rows without the pack.
- Whether the community repacks load and match NVIDIA's merge.
- Seams when regenerating clips longer than 15 s in windows.
- The LMS, Kijai and current LightX2V licences, and how Comfy's "local commercial output needs a licence" squares with the MiniMax text.
- Results with the 2-step schedule or 1080p output on consumer GPUs.
- Whether Alissonerdx's `h3_upscaler_lms_v0.1` (fine-tuned from LBH for 2,000 steps on the LMS sharpness data; no stated licence) is a better latent upscaler for this recipe.

## 3. WorldCast

Sources for this section: the [project page](https://pixctrol.github.io/WorldCast/), [arXiv 2610.33135](https://arxiv.org/abs/2610.33135) (v1, 2026-10-23; the HTML version was read in full), the code at [PixCtrol/WorldCast](https://github.com/PixCtrol/WorldCast) `7ccf2e0ded1238bf6dea1b285c29bcf322e337cb` (its only commit, still the head of main on 2026-10-29) and the weights at [ly56/worldcast](https://huggingface.co/ly56/worldcast) `27635f27a2f9414dd8b78542eb390b565a288a53`. File and line references without a repository are in the WorldCast clone.

### 3.1 What it is

WorldCast (PixCtrol; Xiaomi MiLM Plus and Wuhan University) makes a video in which the camera flies around a character on a chosen path, while the character's geometry, look and identity stay consistent (README L22-25; arXiv abstract).

**Inputs** (`demo.py` L135-138, `diffsynth/pipelines/worldcast_pipeline.py`, the bundled `demo_case/`):

- **One photo** of the character: the first frame.
- **1–4 anchor photos** of the same character, named by body side: front, left_side, right_side, back. They take RoPE slots 25 / 30 / 35 / 40, and the first frame takes slot 0 (`ANCHOR_FIXED_SLOTS`, `worldcast_pipeline.py` L414-415). Each comes with a SAM 3 person mask, and `body_views_meta.json` gives its azimuth. In the demo they are crops of frames 0 / 44 / 67 / 100 of a source 360° video: front 0°, right_side 91.79°, back 171.39°, left_side 266.91°, with `left_sign` −1 (`demo_case/A360-031__portrait/body_views_vggt/body_views_meta.json`).
- **A one-sentence prompt.**
- **A camera path.** `cam_info.json` holds 81 camera-to-world poses (OpenCV, +Z forward) and a 3×3 pixel intrinsic. Beside it: `render.mp4` and `render_mask.mp4`, a point-cloud render of the first frame along the path (mask 0 = covered, 255 = hole), and `no_padding_black/{first_frame.png, person_mask/, anchors_aligned_camera_info.json}`. The pipeline reads exactly these files (`worldcast_pipeline.py` L318, L329, L517, L842-869). The demo stores them at 1344×768 and resizes them to the generation size.

**Output** (`demo.py` L78-84, L210-217): 81 frames at 832 high × 480 wide (portrait) by default; 50 steps, CFG 5.0, sigma shift 2.0, seed 42; saved at 15 fps (about 5.4 s); an optional render | generated side-by-side. It was trained on 81-frame clips at 832×480 (paper §4.1).

**The owner's component list, corrected** (checked word for word in the arXiv HTML):

| Component | Role in WorldCast | Source |
|---|---|---|
| Depth Pro [37] | first-frame depth for the point cloud | §3.3: "We estimate the initial-view depth D0 using a pretrained depth estimator [37]" |
| SAM 3 [39] | person masks for the first frame and the anchors | §3.4 |
| VGGT-Omega [40] | "jointly estimates their camera poses" (first frame and anchors) | §3.4; the demo `cam_info.json` says source `vggt_o`, method `vggt_o_self_consistent` |
| Depth Anything 3 [51] | **evaluation only**: recovers cameras from generated videos for ATE / RTE / RRE | Appendix C.3. The "DA3" in `scripts/data/trajectories.py` L118-119 is internal render code, not the model |

**Quality (paper Table 1, the same as the project page; CLACT has 42 scenes, 17 synthetic in UE5 and 25 real, × 6 paths).** Lower is better for ATE, RTE, RRE and MEt3R.

| Method | ATE | RTE | RRE | MEt3R | ArcFace | CLIP | DINO | Subj. | IQ |
|---|---|---|---|---|---|---|---|---|---|
| **WorldCast** | **0.065** | **0.020** | **0.896** | **0.228** | **0.555** | **0.830** | **0.719** | 0.917 | 0.719 |
| Uni3C | 0.098 | 0.033 | 1.069 | 0.324 | 0.374 | 0.823 | 0.691 | 0.911 | 0.711 |
| GEN3C | 0.130 | 0.038 | 1.255 | 0.306 | 0.433 | 0.819 | 0.696 | 0.915 | 0.716 |
| Lyra 2.0 | 0.142 | 0.034 | 1.741 | 0.316 | 0.394 | 0.817 | 0.691 | 0.916 | **0.725** |
| DepthDirector | 0.289 | 0.066 | 1.732 | 0.332 | 0.423 | 0.826 | 0.686 | **0.919** | 0.705 |
| MVGenMaster* | 0.218 | 0.152 | 6.938 | 0.301 | 0.299 | 0.821 | 0.707 | 0.862 | 0.691 |

Uni3C is the runner-up only on camera accuracy (ATE, RTE, RRE). WorldCast is not best on subject consistency (DepthDirector) or image quality (Lyra 2.0). Ablations (Tables 2-3): without the anchor memory (Stage 1 only) ATE is 0.100 and ArcFace 0.370, about Uni3C's level, so **the anchors are what buy identity**. Stage 1 without the UE5 data has ATE 0.359. Going from 1 to 4 anchors improves consistency, with little gain from 3 to 4 (Fig. 5).

**Limits.** Fixed 81 frames at 480×832; 48 GB of VRAM or more recommended (README; HF card); 50 steps at CFG 5. Inference code only: no training code, and the CLACT dataset is "coming soon". **No released tooling makes a new case**: nothing for depth, poses, anchor alignment or the crops; the reproducibility statement promises the pose-alignment procedures "upon publication". `demo.py` L22 and `trajectories.py` L681 point to README sections ("Trajectory generation", "Data format") that don't exist. The authors say the holes that pull-backs and trucks reveal are geometric, not a bug. A version trained on more diverse paths is "undergoing internal review".

### 3.2 How it works

WorldCast is **not a LoRA**. It is a two-stage fine-tune plus a side branch on Wan2.1-I2V-14B-720P, run through a vendored DiffSynth-Studio (paper §4.1; README; `scripts/infer/infer_worldcast.py` L1-15).

- **Stage 1, `checkpoints/base_dit.safetensors`** (8,401,611,192 B, bf16, 406 tensors, 4.20B parameters). The fine-tuned self-attention of all 40 blocks (`q`, `k`, `v`, `o`, `norm_q`, `norm_k`); `camera_proj` (Plücker rays, 6 channels → 256 → 5120, patch 1×2×2); and `i2v_channel_adapter` [36,53,1,1,1], which packs latents 16 + y 20 + render latent 16 + hole mask 1 = 53 channels into Wan's 36. HTTP range reads confirm the attention really is fine-tuned: block 0 `q.bias` matches the Wan 2.1 720P original in only 94 of 5,120 values. Trained on 76,698 rendered SpatialVID sequences plus 50,000 UE5 sequences, 5 epochs, batch 64, AdamW at 1e-4. The paper says Stage 1 also updates "the pretrained patch embedding", but `base_dit` has no patch-embedding tensors, so inference keeps Wan's own (a mismatch; see §3.11).
- **Geometry guidance.** The first frame's depth is lifted to a coloured point cloud, splat-rendered along the target poses into `render.mp4` / `render_mask.mp4`, VAE-encoded, and concatenated before the patch embedding; the coverage masks follow Uni3C [9] (paper §3.3). In training the depth scale is calibrated against the reference video; at inference "No reference-based scale calibration is required": translation is read relative to the estimated scene depth (Appendix A).
- **Stage 2, GAMA, `checkpoints/worldcast_bank.safetensors`** (1,982,937,976 B, bf16, 484 tensors, 0.99B parameters). The base is frozen; only the bank and the anchor adapter train (30,000 Blender samples, 8 epochs). Each anchor is VAE-encoded at its own unpadded size with its person mask through `anchor_channel_adapter` [36,37,1,1,1] and prepended as tokens, with per-anchor Plücker rays through the shared `camera_proj`. The bank has 20 layers after DiT blocks 0, 2, …, 38: 5120 → 1024 (`proj_in`), AdaLN, 8 heads of 128, FFN 1024 ↔ 4096, the DiT's RoPE, and 20 zero-initialised `proj_out` layers back to 5120. **Its tensor shapes match Kijai's `Wan21_Uni3C_controlnet_fp16` (`controlnet_blocks`, `proj_in`, `proj_out`) one for one** (both headers read).
- **Anchor poses** come from `anchors_aligned_camera_info.json` (world-to-camera; the paper aligns them with Umeyama Sim(3) using source-frame metadata or nearest-azimuth matching). The demo file holds `views`, a `gauge_transfer` block and per-view provenance (source frame, azimuth). If the file is missing, the code silently skips the anchor Plücker rays (`worldcast_pipeline.py` L367-378).
- **Sampling:** flow matching, 50 steps, CFG 5.0, sigma shift 2.0, tiled VAE (`demo.py`).
- **Uni3C lineage, confirmed.** `diffsynth/pipelines/camera.py` carries the same "FIXME: PPU does not support inverse in GPU" line as alibaba-damo-academy/Uni3C `src/camera.py`; the manifest fields `reference_image` / `render_path` mirror Uni3C's `cam_control.py`; `demo.py` keeps an `--invert_camera_extrinsic` flag "for old dp3-rendered" world-to-camera `cam_info`, which is the layout Uni3C's public `cam_render.py` writes; and `scripts/data/anchor_views.py` L96 imports a missing `diffsynth.pipelines.uni3c_pipeline`.

### 3.3 Camera paths

WorldCast's presets (README table; `scripts/data/trajectories.py` L1-35 and `TRAJECTORIES` L265-275) are the vocabulary Fuobe should copy. The right-hand column maps each one to fal's H3 Max camera-controls (§3.7). That mapping is Fuobe's proposal, not tested.

| Preset | Path | H3 Max `camera_trajectory` (time 0–1, azimuth°, elevation°, distance) — proposal |
|---|---|---|
| `orbit_360` | a level 360° ring at the first frame's height, closed | (0, 0, e, 1) (0.25, 90) (0.5, 180) (0.75, 270) (1, 360) |
| `orbit_<N>[_cw\|_ccw]` | a level arc, sweep in (0, 360]; with no suffix it continues the base path's f0 → f1 direction | (0, 0) → (1, ±N), a keyframe every ≤ 90° |
| `orbit_tilt_20` | the ring tilted to 20° | azimuth 0 → 360 with elevation e ± 20 as a wave over 5 keyframes (approximation) |
| `orbit_180_push` | a 180° arc with a sinusoidal radius ripple (amp_frac 0.25, 2 waves) | azimuth 0 → 180; distance 1, 0.75, 1, 0.75, 1 at t 0, 0.25, 0.5, 0.75, 1 (approximation) |
| `lemniscate` | a Gerono figure-8 in the screen plane, 60° lobe aperture | small azimuth and elevation oscillations (guess; needs a test) |
| `zoom_out` | a dolly out to 1.5× the distance | distance 1 → 1.5 |
| `zoom_in` | move_frac 0.4 forward (0.6× the distance) | distance 1 → 0.6 |
| `turn_left` / `turn_right` | a truck of 0.5× the subject distance | `free_camera_preset` truck left / right |
| `orbit_360_push`, `spiral` | named on the HF card, **not** in the released `TRAJECTORIES` (the project page's "orbit 360 + push-pull" videos suggest an internal path) | — |

- **H3 Max's keyframes** (fal schema): 2–12 of {time 0–1, azimuth in degrees, unbounded, signed turns kept, at most 32 turns of total travel; elevation −90…90; distance > 0 in "normalized scene units"}. The first pose holds before its time and the last to the end. A `free_camera_preset` (truck, pedestal, dolly, pan, tilt, roll pairs or `s_curve_forward`) replaces the trajectory.
- **Fuobe's scene pose** (`scenePose`, `src/lib/scene3d.ts` L555-575) gives `horizontal` 0–360 (a circular mean), `vertical` clamped to −30…90 and `zoom` = 5 + 5·log2(tighter), clamped 0–10. To map it to H3 Max: azimuth = horizontal, unwrapped to signed turns along the path; elevation = vertical; distance ∝ 2^(−(zoom − 5)/5), the inverse of the zoom formula.
- **WorldCast's own poses** are 81 camera-to-world matrices (OpenCV) plus a pixel intrinsic. Fuobe can build them from the same keyframes: interpolate azimuth, elevation and distance per frame around the subject's pivot (`medianDepth`, `scene3d.ts` L208), look at the pivot, and take the intrinsic from the photo's field of view.
- **Left and right.** WorldCast's left_side sits near 267° (`left_sign` −1). Fuobe's Image to 3D side picker uses the object's own left and right (`src/lib/av/model3d.ts` L81-88). A swapped slot silently hurts identity, so convert once, in one function, with a test.

### 3.4 Weights

| File | Repo @ revision | Bytes | Licence (information) | Role |
|---|---|---|---|---|
| `checkpoints/base_dit.safetensors` | ly56/worldcast @ `27635f27` | 8,401,611,192 | Apache-2.0 (card: "the Wan2.1 base is Apache-2.0; these derived weights are released under the same terms") | Stage 1: fine-tuned attention, camera and channel adapters |
| `checkpoints/worldcast_bank.safetensors` | same | 1,982,937,976 | Apache-2.0 | Stage 2: the anchor memory and anchor adapter. **Both files must come from the same release.** The README and the card say "~2 GB"; the real download is 10.38 GB |
| `diffusion_pytorch_model-0000{1..7}-of-00007.safetensors`, `models_t5_umt5-xxl-enc-bf16.pth`, `models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth`, `Wan2.1_VAE.pth`, the umt5 tokenizer | Wan-AI/Wan2.1-I2V-14B-720P @ `8823af45` | 82.22 GB in all (the DiT shards are stored in F32) | Apache-2.0 | the base, exactly the paths `load_pipeline()` opens |
| `split_files/diffusion_models/wan2.1_i2v_720p_14B_fp8_scaled.safetensors` | Comfy-Org/Wan-2.1 @ `123acf1c` (formerly `Wan_2.1_ComfyUI_repackaged`, which now redirects) | 16,401,356,938 | Apache-2.0 | the ComfyUI form of the base, for a port or the Uni3C stand-in. Fuobe has Wan 2.1 I2V only as the 480p Q8 GGUF (`library.spec.mjs` L160) |
| `Wan21_Uni3C_controlnet_fp16.safetensors` | Kijai/WanVideo_comfy @ `8260d429` | 1,997,314,376 | no licence field; Uni3C itself is Apache-2.0 (alibaba-damo-academy/Uni3C LICENSE; ewrfcas/Uni3C HF) | the stand-in. The header has every key core's `ModelPatchLoader` Uni3C branch reads (`nodes_model_patch.py` L336-365) |
| `vggt_omega_1b_512.pt` (also `_416_reproduce`, `_256_text`) | facebook/VGGT-Omega @ `1041e80f` | 4,576,706,117 | FAIR Noncommercial Research License; gated, manual approval | the paper's pose estimator |
| `depth_pro.pt` | apple/DepthPro @ `ccd1350a` | 1,904,446,787 | Apple ML Research licence: research only, "does not include any commercial exploitation, product development or use in any commercial product or service" | the paper's depth estimator (Uni3C's `cam_render.py` uses it too) |
| `geometry_estimation/depth_anything_3_base.safetensors` (small 137,254,980 B; metric_large and mono_large 1,336,748,056 B each) | Comfy-Org/Depth-Anything-3 @ `8265be07` | 541,524,124 | Apache-2.0 repack; upstream DA3-SMALL / BASE / MONO-LARGE / METRIC-LARGE Apache-2.0, DA3-LARGE / GIANT CC-BY-NC-4.0 | permissive stand-ins for depth and poses; untested with WorldCast. Fuobe already uses mono_large |
| `checkpoints/sam3.1_multiplex_fp16.safetensors` | Comfy-Org/sam3.1 @ `7bb83747` | 1,745,546,848 | Meta SAM License (Fuobe records "royalty-free, commercial use allowed") | person masks; already pinned (`library.spec.mjs` L187) |
| `comfyui/meridian_teacher_lora.safetensors` + `meridian_turbo_lora.safetensors` | Viggle/Meridian @ `9c57d46f` | 1,883,756,424 + 1,883,756,416 | MiniMax H3 Community (territory-restricted); code Apache-2.0 | a related alternative, not part of WorldCast (§3.6) |

### 3.5 Licences, as written

- **WorldCast code** (PixCtrol/WorldCast @ `7ccf2e0d`): Apache-2.0 (LICENSE; README says "inherited from DiffSynth-Studio"; pyproject). **Weights** (ly56/worldcast @ `27635f27`): Apache-2.0 per the card.
- **Training data (information).** The README says WorldCast "uses SpatialVID under CC BY-NC-SA 4.0 and its Terms of Use. The authors confirm that all uses of this dataset are strictly for academic research purposes and not for any commercial applications." Stage 1 used 76,698 rendered SpatialVID sequences. The UE5 and Blender sets use Fab and Sketchfab assets whose licences are not stated (paper §3.5). The CLACT dataset is not released; its licence is unknown.
- **Wan2.1-I2V-14B-720P**: Apache-2.0. **DiffSynth-Studio** (vendored): Apache-2.0.
- **The paper's preprocessing models**: VGGT-Omega is FAIR Noncommercial Research (gated); Depth Pro is Apple research-only.
- **Permissive stand-ins**: Depth Anything 3 small / base / mono-large / metric-large Apache-2.0 (large and giant are CC-BY-NC-4.0); MoGe 2 (Fuobe's `scene-mesh-moge`) MIT; SAM 3 / 3.1 Meta SAM License.
- **Uni3C**: Apache-2.0. Its `cam_render.py` preprocessing pulls in Depth Pro (research-only) and a `tracer_b7` mask net (licence not checked).
- **ComfyUI core** (the Uni3C, DA3, MoGe, SAM 3 and CameraAngle nodes): GPL-3.0. **kijai/ComfyUI-WanVideoWrapper**: Apache-2.0. **Camera H3 Bruxos** (NyckM/3d-Camera-control-H3-Minimax @ `36c4218a`): Apache-2.0.
- **Viggle Meridian** and the H3 orbit LoRAs Fuobe's research already records (pablodawson 360 Orbit, MATLOWAI ORB360; `docs/research/comfyui-oss.json` L7015-7038): MiniMax H3 Community, territory-restricted (EU, UK, Republic of Korea and US excluded).
- **Cloud**: `minimax/h3-max/camera-controls` and `reference-to-video` under fal's and MiniMax's terms; FLUX 3 Max keyframes under BFL's and fal's; fal's Qwen Multiple-Angles LoRA (`fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA`) is Apache-2.0.

### 3.6 ComfyUI: nodes, stand-ins and the graph Fuobe would build

**No WorldCast pack or port exists** (re-checked 2026-10-29). GitHub repository search "worldcast" finds PixCtrol/WorldCast (50 stars, 2 issues, neither about ComfyUI) and unrelated projects with the same name (Ziyang-Ye/WorldCast, teal024/WorldCast, worldcast-video/worldcast). Code search finds no hits for `worldcast_bank` or `SourceSelfAttentionBank`. Hugging Face shows no Spaces or repacks. A port needs custom DiT code: the anchor prefix at RoPE slots 0 / 25 / 30 / 35 / 40, the 53 → 36 adapter, the Plücker `camera_proj` add, the replaced self-attention, and the 20-layer bank. Because the bank's layout equals Uni3C's ControlNet blocks, ComfyUI's `comfy/ldm/wan/uni3c.py` and `WanUni3CCnetPatch` are the natural starting point (assessment).

What exists:

| Pack | Commit | Licence | Relevant classes | Notes |
|---|---|---|---|---|
| ComfyUI core (Fuobe's pin, `install-comfyui.sh` L12) | `fc04da91` | GPL-3.0 | `ModelPatchLoader`, `WanUni3CControlnetApply`, `LoadDA3Model`, `DA3Inference`, `DA3Render`, `DA3GeometryToMesh`, `LoadMoGeModel`, `MoGeInference`, `MoGeRender`, `MoGePointMapToMesh`, `MoGeGeometryToFOV`, `SAM3_Detect`, `SAM3_VideoTrack`, `SAM3_TrackToMask`, `WanCameraEmbedding`, `WanCameraImageToVideo`, `CreateCameraInfo`, `CameraAngle`, `RenderSplat`, `File3DToSplat`, `TransformSplat`, `MiniMaxH3ReferenceToVideo`, `MiniMaxH3SigmaShift` | `ModelPatchLoader` and `WanUni3CControlnetApply` are experimental. The Uni3C node takes model, model_patch, vae, `render_video` (IMAGE, "most commonly warped point cloud renders"), strength 1.0, start/end percent; it has **no render-mask input** and checks the Wan dimension (`nodes_model_patch.py` L934-966). `DA3Inference` multiview (Small / Base) computes poses, but no node exports them. `RenderSplat` with frames > 1 renders only a 360° turntable. `WanCameraEmbedding` has pans, zooms and CW / ACW, no orbit. `CameraAngle` (horizontal 0–360, vertical −30…60, zoom 0–10) outputs a camera_info and a prompt, the same terms as Qwen Multiple Angles and Fuobe's `scenePose` |
| kijai/ComfyUI-WanVideoWrapper (pinned, `install-comfyui.sh` L16) | `088128b2` | Apache-2.0 | `WanVideoUni3C_ControlnetLoader`, `WanVideoUni3C_embeds`, `WanVideoReCamMasterGenerateOrbitCamera`, `WanVideoReCamMasterCameraEmbed`, `WanVideoFunCameraEmbeds` | `WanVideoUni3C_embeds`'s render_mask input is tooltipped "NOT IMPLEMENTED!". The ReCamMaster orbit camera takes degrees −180…180. No WorldCast support |
| NyckM/3d-Camera-control-H3-Minimax (registry: bruxosdovfx/ComfyUI-H3-Camera-Editor, "Camera H3 Bruxos" v33.0.0) | `36c4218a2561328436d440fa9134631ee515471b` | Apache-2.0 | `BruxosH3Camera`, `BruxosH3CameraGuideRender`, `BruxosH3CameraGuideVideo`, `BruxosH3CameraPromptCompose`, `BruxosH3MotionReference`, `BruxosH3SubjectBox`, `BruxosMeridianTextCond`, `BruxosMeridianReference` (+ deprecated aliases) | Not pinned; read from source. `BruxosH3Camera` is a sphere / keyframe camera planner (azimuth, elevation, distance, direction) that "compiles PROMPTS, not camera embeddings". With `depth_animation` "Depth Warp" and a depth map or core `MOGE_GEOMETRY`, it outputs `depth_warp` (IMAGE) and `warp_mask` (MASK): **a server-side point-cloud path renderer**. Only the "Meridian (H3)" format: an 832×480-class canvas, 73 / 90 / 107 / 124 / 141 / 158 / 175 / 243 frames, 24 fps, grey-128 holes (`experimental.py` L16-60; `depth_warp.py` L31-33, L511-512). `pyproject` has no dependencies |
| Viggle/Meridian (custom nodes inside the HF repo) | `9c57d46f` | code Apache-2.0; weights MiniMax H3 Community | `MeridianFrozenPrompt`, `MeridianGeometry` | A geometry-guided re-camera on MiniMax H3: a depth-warp render and the source go in as `<Video 1>` / `<Video 2>` through core `MiniMaxH3ReferenceToVideo`; "You can also create a camera move from a single image". Needs `minimax_h3_fl2va_bf16` (not Fuobe's ref2va int8) plus two LoRAs at 1.0; `MeridianGeometry` shells out to a separate Python with VGGT-Omega. 24 fps, 1344×768 for 16:9, 73–243 frames, no anchors. On one B200: 73 frames ≈ 36 s at 88 GiB; 243 frames ≈ 150 s at 113 GiB |

**The graph Fuobe would build now: `wan21-i2v-uni3c-path`** (proposal; core nodes only; not built or validated). It is the stand-in for WorldCast's path control without the anchor memory.

| id | class | settings | Fuobe binding |
|---|---|---|---|
| 1 | `UNETLoader` | `wan2.1_i2v_720p_14B_fp8_scaled.safetensors` (new pin; or test the 480p Q8 GGUF Fuobe already has, see §3.11) | — |
| 2 | `CLIPLoader` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, type wan (pinned) | — |
| 3 | `VAELoader` | `wan_2.1_vae.safetensors` (pinned) | — |
| 4 | `CLIPVisionLoader` | `clip_vision_h.safetensors` (pinned) | — |
| 5 | `LoadImage` | the photo | `image` |
| 6 | `CLIPVisionEncode` | crop none | — |
| 7 | `LoadVideo` + `GetVideoComponents` | the path render (`render.mp4`) | `video` |
| 8 | `ModelPatchLoader` | `Wan21_Uni3C_controlnet_fp16.safetensors` (`models/model_patches`) | — |
| 9 | `WanUni3CControlnetApply` | model ← 1, model_patch ← 8, vae ← 3, render_video ← 7, strength 1.0, start 0, end 1 | `strength` |
| 10 / 11 | `CLIPTextEncode` | positive / negative | `prompt`, `negativePrompt` |
| 12 | `WanImageToVideo` | 480×832 or 832×480, length 81, start_image ← 5, clip_vision_output ← 6 | `width`, `height` |
| 13 | `KSampler` | model ← 9; steps and CFG as Fuobe's other Wan 2.1 I2V graphs (to confirm on a GPU) | `seed`, `steps` |
| 14 | `VAEDecode` → `CreateVideo` (16 fps) → `SaveVideo` | — | `filenamePrefix`; output video |

The render video comes from Fuobe's browser (§3.10): the three.js scene engine already loads the MoGe mesh or a point cloud (`src/components/cinema/scene-engine.ts`; `buildPointCloud`, `src/lib/scene3d.ts` L414), and the turntable recorder already captures a canvas with MediaRecorder (`src/components/model3d/turntable.ts`). A server-side alternative is `BruxosH3Camera` Depth Warp from core `MoGeInference` (needs pinning; Meridian-shaped output). Loading Kijai's Uni3C file through `ModelPatchLoader` is inferred from its header keys, not run.

**WorldCast itself, later.** Two ways, both GPU-only:

1. **A worker** (recommended first): a small HTTP service on the user's GPU, outside ComfyUI, like the TRIBE v2 worker contract (`docs/workers/tribe-v2.md`). It runs WorldCast's own Apache-2.0 code at `7ccf2e0d` in its own environment (verified combination: torch 2.8.0+cu128 with transformers 5.8.1; `requirements.txt`) with the 82 GB Wan base and the 10.38 GB checkpoints, and takes a case folder Fuobe prepares. It gives exact parity with the reference and can be checked against `demo_case/`.
2. **A Fuobe node pack** on core's Wan model (the bank as a Uni3C-style patch, plus the attention swap, adapters and anchor prefix). Less to install for the user, but much more work and risk; a follow-up once the worker shows the quality is worth it.

Either way Fuobe prepares the case itself, with permissive models: depth from DA3 metric-large or MoGe 2 (the paper used Depth Pro), masks from core `SAM3_Detect`, the path from Fuobe's camera-path code (§3.3), `render.mp4` / `render_mask.mp4` from the same point cloud, and anchor poses on a ring at the subject distance from each view's azimuth (a guess; or leave `anchors_aligned_camera_info.json` out and accept no anchor Plücker rays). The exact crop rules of `no_padding_black/` are not documented; read them from `demo_case/` and `worldcast_pipeline.py` L842-869 before building.

### 3.7 Cloud routes and the hosted-parts recipe

There is no WorldCast endpoint on fal or Replicate (web searches, GitHub and HF searches found none), and the bank needs custom forward code that no hosted Wan LoRA endpoint can load.

| Provider | Endpoint | Inputs that matter | Price | In Fuobe |
|---|---|---|---|---|
| fal | `minimax/h3-max/camera-controls` | `image_url` (the first frame; one image only); `camera_trajectory`: 2–12 keyframes {time, azimuth, elevation, distance}; or `free_camera_preset`; `prompt` (optional; the **default prompt freezes the scene**: "The same elements in the reference are rigid … Only the camera moves", so always send one that lets the character move); `prompt_expansion_mode` disabled / balanced / quality (required); `duration` 0.92–15 s (default 5); `resolution` 480P / 768P / 1080P (1080P is a latent refinement of 768P); `seed` | promo until 2026-10-31: $0.0325 / $0.052 / $0.104 per s at 480p / 768p / 1080p; then $0.05 / $0.08 / $0.16 | recorded only in research (`paid-model-apis-2.json` L23027-23156); no route yet |
| fal | `minimax/h3-max/multi-angle/image-to-video` | a legacy alias: the page 308-redirects to camera-controls and its `llms.txt` is byte-identical | same | use the camera-controls id |
| fal | `minimax/h3-max/reference-to-video` | `reference_image_urls` (named Image 1…n in the prompt), videos and audio, ≤ 12 files; prompt; duration; resolution | $0.05 / $0.08 / $0.16 per s (480p / 768p / 1080p); 4,096 reference tokens included, then $0.02 per 1,000 (5 s at 768p with up to four square references = $0.40) | **already a route**: `minimax-h3-max` op `ref2v` (`cloud-models.generated.ts` L6244) |
| fal | `blackforestlabs/flux-3-max/keyframes-to-video` | up to 10 {image_url, frame_index}; prompt; duration 5–20 s; aspect ratio; sound | promo until 2026-11-07: $0.0425 / $0.0725 per s (720p / 1080p); then $0.17 / $0.29 | **already a route**: `flux-3-max` (L15360); Frames mode's cloud model (`src/lib/catalog/keyframes.ts` L58) |
| fal | `fal-ai/qwen-image-edit-2511-multiple-angles` | image_urls, horizontal_angle 0–360, vertical_angle −30…90, zoom 0–10 | $0.035 per megapixel | **already a route**: `qwen-multiple-angles` (L3475); the Angles app |
| fal | `fal-ai/marigold-v2` | an image → a depth map (Fuobe's browser turns it into a point cloud) | $0.03 per image | **already a route**: `marigold-depth` (L15326), Cinema's cloud 3D scene |

**The hosted-parts recipe ("Fuobe Fly-Around" in the cloud).**

- **(A) An exact path from one photo:** H3 Max camera-controls with the path's keyframes (§3.3), `prompt_expansion_mode` disabled and a prompt that lets the character move. 5 s at 768P: $0.26 on the promo, then $0.40. It ignores reference views, so the hidden sides are invented.
- **(B) An identity-anchored turnaround:** FLUX 3 Max keyframes-to-video with the element's references or a cast sheet (front, three-quarter, profile, back) as keyframes; fill missing angles with Qwen Multiple Angles (horizontal 45–315). Fuobe's Frames mode already runs this chain.
- **(C) References in one call:** H3 Max reference-to-video with the anchors as references and an orbit prompt ("the camera orbits 360 degrees around Image 1 …"). Identity is anchored; the path is loose.
- **(D) Hybrid:** (A) for the motion, then an identity pass if the back or sides drift.
- Default to (A); use (C) or (B) when the user has three or more views or a cast sheet.

### 3.8 Hardware

- **WorldCast:** at least 48 GB of VRAM recommended for 480×832 × 81 frames in bf16; memory grows with resolution and length (README; HF card). The per-clip time is not stated anywhere (README, card, full paper). The vendored DiffSynth core has fp8 and offload plumbing (`ModelConfig` offload settings, `vram_limit`, `fp8_linear` in `diffsynth/core/vram/layers.py` L309-334), but `demo.py` doesn't expose it, so fp8 or offload with the bank is untested.
- **Closest relative, Uni3C** (same base, 81 frames; its official README): one H20 with offload 50.8 GB for about 20 min; 4 × H20 with SP + FSDP 46.1 GB per GPU for under 5 min. WorldCast adds about 1B bank parameters and the anchor tokens, so **20–40 min per clip on one 80 GB card is a guess**.
- **Disk:** 82.22 GB Wan base (F32 shards) or 16.4 GB fp8_scaled in ComfyUI form; 10.38 GB WorldCast; preprocessing VGGT-Omega 4.58 GB, Depth Pro 1.90 GB, SAM 3.1 1.75 GB (already pinned).
- **Stand-ins:** Uni3C via WanVideoWrapper is recorded at 24 GB in Fuobe's research (`comfyui-oss.md` L1188, unverified; the official repo reports 46–51 GB). DA3 base 0.54 GB; MoGe 2 0.66 GB. Wan 2.2 Fun Camera 24 GB (manifest). Meridian on one B200: 88–113 GiB peak, no quantisation or offload in its reference code.

### 3.9 Fuobe today

All paths verified at `claude/fuobe-parity-4` (`7d7a765`). `git grep -i 'vggt|uni3c|recammaster'` matches only `docs/research`; nothing references WorldCast, Meridian or the Bruxos pack.

- **Cinema camera moves** (`src/lib/catalog/cinema.ts`): `RAW_MOVES` (L347) has 33 moves, including drone-orbit (L363), arc-left, arc-right, bullet-time (L367) and helicopter-shot (L380). `MOVE_MOTION` (L473) maps drone-orbit to `motion-360-orbit` (L489). `MOVE_FUN_CAMERA` (L510) covers only pans, zooms and static. `CINEMA_CAMERA_LORA` (L590) is null for the orbit moves (L606-623). Orbits today are prompted or LoRA-driven, with no exact degrees, radius or height.
- **DoP / Motions**: the Orbit category (360 Orbit, Arc Left, Arc Right, Lazy Susan, 3D Rotation, Bullet Time, Lazy Orbit, Glam; `src/lib/catalog/motions.ts` L94-102). `oss-loras.generated.ts` maps 360-orbit (L3040) and the arcs (L3070, L3100) to ostris's Wan 2.2 14B orbit LoRA pair.
- **Cinema's 3D scene** (`src/lib/scene3d.ts`, `src/components/cinema/scene-viewer.tsx`, `scene-engine.ts`): MoGe 2 on the open engine, Marigold in the cloud (`SCENE_MODELS`, `cinema.ts` L1880); a browser point cloud (`buildPointCloud`, L414); fly controls (`FlyPose` L91, `flyStep` L129, `lookStep` L140, `medianDepth` L208); `scenePose` (L555-575). **Capture uploads one still with its pose** (`scene-viewer.tsx` L224-245) and Recompose re-renders that view (`planRecompose`, `cinema.ts` L1914). There is no path or video capture yet.
- **Depth, masks, 3D**: core DA3 (`video-depth-da3`), MoGe 2 (`scene-mesh-moge`) and SAM 3.1 (`video-bg-remove-sam3`) graphs; Image to 3D's side picker front / left / back / right (`model3d.ts` L81-88); a canvas turntable recorder (`turntable.ts`).
- **Multi-angle references**: elements hold up to 80 photos (`src/lib/catalog/elements.ts` L22); the Soul Cast sheet gives "Front, three-quarter, profile and back views" (`src/components/fashion/character-sheet.tsx` L320); the Angles app runs the Multiple-Angles LoRA on both engines (`src/lib/catalog/apps.ts` L265-302).
- **Keyframe films**: up to 10 keyframes (`keyframes.ts` L19); `FRAMES_MODELS` is cloud `flux-3-max`, open `oss-wan22-14b` (L58).
- **Cloud catalog**: `minimax-h3-max` has t2v, i2v, ref2v (`minimax/h3-max/reference-to-video`, L6244) and extend; no camera-controls route.
- **Pins**: ComfyUI `fc04da91` (`install-comfyui.sh` L12), WanVideoWrapper `088128b` (L16). Wan 2.1 I2V only as the 480p Q8 GGUF (`library.spec.mjs` L160), plus `clip_vision_h` and umt5 fp8 from Comfy-Org's renamed Wan repo (L166-168). `docs/research/comfyui-oss.md` L2367 says "Uni3C/ReCamMaster are wrapper-only"; that is now stale, because core has `WanUni3CControlnetApply`.

### 3.10 Where it goes and why

**A camera path is something you draw where you already look at a scene or a character.** So it goes into Cinema's 3D scene (you already fly there), onto cast sheets and saved characters (the references are already there), and into the orbit moves people already pick. The cloud gets an exact path today through H3 Max camera-controls; the open engine gets an exact path today through Uni3C, and WorldCast's anchor memory later.

| Where (exact spot) | What the user does | Open engine | Cloud engine | Priority · package |
|---|---|---|---|---|
| **Cinema → 3D scene viewer**: a "Fly path" strip beside Capture (`scene-viewer.tsx` L224-245; `scene-engine.ts`; `scene3d.ts`) and a "Film this path" action next to Recompose (`planRecompose`, `cinema.ts` L1914) | Flies the camera and drops keyframes, or picks Orbit 360°, Arc 90° left, Push-pull arc, Tilted ring, Figure-8 or Dolly out. Each chip shows time, orbit °, height and distance. Presses Film and gets a 5 s move that follows the path | the browser records the MoGe mesh or point cloud along the path (transparent pixels = holes) → `render.mp4` → `wan21-i2v-uni3c-path` with the still as the start image. Later: WorldCast with the same poses | the keyframes → H3 Max camera-controls `camera_trajectory` (§3.3), prompt expansion off, a motion prompt; 768P $0.052/s until 10-31, then $0.08/s | P0 · N7-5 |
| **Character Sheet page and Soul Cast results** (`src/app/(studio)/character-sheet/page.tsx`; `character-sheet.tsx`): a "Turnaround video" button on a finished sheet. **Elements → a character's page** (`src/app/(studio)/elements/[id]/page.tsx`): "Fly around this character" | One click turns the sheet (or the element's photos) into a 360° turnaround of the same person, for a pitch deck or a casting reel; on an element, also picks the hero photo and a path | now: Frames mode's open chain (Wan 2.2 14B start / end pairs; `createKeyframeFilm`, `src/server/chains.ts` L197) with the views at 0 / 0.25 / 0.5 / 0.75 / 1.0, ending on the front. Later: WorldCast `orbit_360` with the front as the first frame and the sheet as anchors | FLUX 3 Max keyframes-to-video with the 4–5 views ($0.0425/s promo, then $0.17/s at 720p), or `minimax-h3-max` ref2v with the views as references and an orbit prompt ($0.40 for 5 s at 768P); missing angles from Qwen Multiple Angles ($0.035/MP) | P0 · N7-6 |
| **Fuobe DoP / Motions** (Orbit category, `motions.ts` L94-102) and **Cinema's orbit moves** (drone-orbit, arc-left, arc-right, bullet-time; `cinema.ts` L606-623) | An "Exact" switch on 360 Orbit and Arc Left / Right with degrees (30–360), direction, height tilt (0–20°) and a radius pulse; the move follows the numbers | automatic depth (MoGe 2 or DA3 metric) → a browser point-cloud render along the preset → `wan21-i2v-uni3c-path`. The ostris Wan 2.2 orbit LoRAs stay as "Loose" | H3 Max camera-controls with the preset expanded to keyframes; 5 s at 768P = $0.40 list | P1 · N7-7 |
| **Image to 3D** (`src/app/(studio)/image-to-3d/page.tsx`; `model3d.ts`; `turntable.ts`): "Film it photoreal" next to "Animate the spin" | Gets a photoreal orbit whose geometry matches the 3D model, instead of a restyled grey turntable | the TRELLIS.2 / TripoSplat turntable recording → `WanUni3CControlnetApply` render_video, the source photo as the start image; in "From several images" mode the views become WorldCast anchors when that lands | H3 Max camera-controls azimuth 0 → 360 on the source photo, or `minimax-h3-max` ref2v with the views | P1 · N7-7 |
| **Canvas**: a "Camera path" node (keyframes or a preset) and a "Fly around" node (image + optional views + path → video) in `canvas.ts`; an Assist / MCP tool `fly_around` | Wires a character and a path into Fly around, and batches it with the Table node for 10 products | as above (server-side render from MoGe / DA3 depth needs a small point-cloud renderer, or the Bruxos node, because core has none) | H3 Max camera-controls; ref2v or FLUX 3 Max keyframes when there are views | P1 · N7-7 |
| **WorldCast proper** behind the same buttons ("Fuobe Fly-Around" Original, open half) | Same buttons; the back and sides now match the user's photos on their own GPU | a WorldCast worker (§3.6) with Fuobe-prepared cases: DA3 / MoGe depth, SAM 3.1 masks, Fuobe's path, anchors from the views' azimuths | unchanged (A)–(D) | P1 · N7-9 |
| **Settings → Models & licences** and About | Sees WorldCast and its helpers with their licences and switches | rows: WorldCast (Apache-2.0, with the SpatialVID "academic research only" note), Wan 2.1 I2V 720P, Uni3C, VGGT-Omega (FAIR-NC) and Depth Pro (Apple research-only) if ever used, DA3, MoGe 2, SAM 3.1; if adopted, the Bruxos pack and Meridian (MiniMax H3, territory-restricted) | rows for camera-controls (and its alias), reference-to-video, FLUX 3 Max keyframes, Qwen Multiple Angles | inside each package |

### 3.11 Risks and unknowns

**Risks**

- **Preprocessing is only partly released.** Nothing that makes a new case ships; two README sections it points to don't exist. Uni3C's `cam_render.py` can make the render part from one photo (world-to-camera; use `--invert_camera_extrinsic`) but uses Depth Pro (research-only). The anchor-alignment and crop rules have to be read from the demo case.
- **Heavy and slow.** 48 GB or more; bf16; 50 steps at CFG 5 (two passes per step); an 82 GB base download plus 10.38 GB; fp8 / offload untested; Fuobe pins only a 480p GGUF of Wan 2.1 I2V.
- **Not a LoRA.** `base_dit` replaces the self-attention of all 40 blocks. Stacking Wan LoRAs or lightx2v step-distill LoRAs on it is untested (the card: "50 steps / cfg 5.0 without a step-distillation LoRA").
- **Size mislabel** ("~2 GB" vs 10.38 GB) and a **paper / release mismatch** (patch embedding said to be trained, not shipped).
- **Architecture-locked.** `BANK_CONFIG` (20 layers, interval 2, 8 heads, inner 1024, DiT RoPE, per-layer `proj_out`) must match or loading fails (`demo.py` L24-29). A newer checkpoint is in internal review and may change the format.
- **Preset mismatch:** the card lists `orbit_360_push` and `spiral`, which the code doesn't implement.
- **Left / right convention:** WorldCast's left_side is at about 267° (`left_sign` −1); Fuobe's side picker uses the object's own left and right. *(Correction, N7-9, 2026-11-02: the names are where the camera stands, not the body's sides. The demo case's aligned cameras (`no_padding_black/anchors_aligned_camera_info.json`) put `right_side` at +x of the first camera, moved round to the camera's own right, and its `right_side` crop shows the boy facing the lens because the first frame shows him in profile. With the front as the first frame, a person's own right side is WorldCast's `left_side` (270°); `worldcastAnchor` converts it, and `docs/workers/worldcast.md` has the table.)*
- **Licences as information.** Weights are Apache-2.0, but Stage 1 trained on SpatialVID (CC BY-NC-SA 4.0) for "academic research purposes" only, by the authors' own statement. The paper's preprocessing models are non-commercial (VGGT-Omega) or research-only (Depth Pro). The permissive stand-ins (DA3, MoGe 2, SAM 3.1) are unvalidated with this model. Meridian and the H3 orbit LoRAs are territory-restricted.
- **Holes and invention.** Pull-backs and trucks reveal background the first-frame cloud never saw; large orbits lean on the anchors; synthetic anchors (Qwen Multiple Angles) may drift (guess).
- **Name collisions:** other "WorldCast" projects exist; pin repository ids, not names.
- **Project hygiene:** the page footer says "Authors are anonymous during double-blind review" while listing names; the repo is a week old with one commit.
- **Stand-in caveats.** The core Uni3C nodes are experimental; loading Kijai's file through `ModelPatchLoader` is inferred from its keys; Uni3C's official memory is 46–51 GB, not the 24 GB in Fuobe's research. H3 Max camera-controls takes one image, its default prompt freezes the scene, and its promo ends 2026-10-31.
- **Repo rename:** Comfy-Org renamed `Wan_2.1_ComfyUI_repackaged` to `Wan-2.1`; Fuobe's pinned URLs rely on HF's redirect.
- **Consent and misuse:** the paper's ethics statement warns it "could be misused to create misleading or impersonating content". "Fly around this character" should follow Fuobe's Soul ID consent rule for real people.

**Unknowns**

- WorldCast's per-clip time and real peak VRAM (20–40 min on one 80 GB card is a guess); whether it fits 24–32 GB with fp8 / offload; whether any step-distill LoRA works on the fine-tuned attention.
- Whether the patch embedding was meant to be fine-tuned, and whether Wan's original one costs quality.
- How a real user gets anchors and aligned anchor cameras ("more flexible anchor acquisition" is the paper's future work); how much quality drops without `anchors_aligned_camera_info.json` or with generated views.
- Whether Uni3C-style preprocessing output is a valid WorldCast case in practice, and how sensitive WorldCast is to DA3 / MoGe depth scale instead of Depth Pro / VGGT-Omega.
- Whether Kijai's Uni3C file loads through core `ModelPatchLoader` on Fuobe's pin; whether the Wan 2.1 I2V **480p** Q8 GGUF Fuobe already has works with it (saving the 16.4 GB 720p download); whether a Bruxos Depth Warp output works as Uni3C `render_video`. *(Correction, N7-5, 2026-10-29: core's `UNETLoader` reads no GGUF at `fc04da91` — that needs city96's ComfyUI-GGUF pack, which the validation server doesn't have — so the core-only graph pins the 720P fp8 file and takes the 480P fp8 file InfiniteTalk's native graph already uses, `Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors`, as the drop-in to try first; both are dim 5120, which the Uni3C node checks. fal's queue OpenAPI also gives `free_camera_preset`'s 13 values, now in `paid-model-apis-2.json`.)*
- Whether Meridian's LoRAs load on Fuobe's ComfyUI and on the pruned int8 FL2VA H3, and its VRAM below a B200.
- H3 Max camera-controls beyond its schema: the azimuth sign, what distance 1.0 means for a given photo, how well a character moves once the frozen-scene default prompt is overridden, and real limits on 360° orbits.
- The CLACT licence and release date; whether training code and the pose-alignment procedures ship; whether the newer checkpoint keeps the file format; whether Kijai or Comfy-Org will port WorldCast.
- Quality on animals and objects (the gallery has them; the metrics are character-centric).

## 4. MOSS-Image Layout

Sources for this section: [LinXce/Comfyui-Moss-LayoutPrompt](https://github.com/LinXce/Comfyui-Moss-LayoutPrompt) at `326ad58e3e5055cc59b90fe5b5d2bcddf3698a4d` (still the remote head on 2026-10-29), [OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) at `2b46b1e0` (README, `USERGUIDE.md`, `skills/moss-image-prompt-enhancer/`), the weights on Hugging Face, Comfy-Org's workflow templates, the local ComfyUI at Fuobe's pin, fal's OpenAPI for `fal-ai/moss-image` and `fal-ai/moss-image/lora` (fetched again for this note on 2026-10-29), and MOSI's API reference.

### 4.1 What it is

**The editor.** A ComfyUI canvas editor that writes MOSS-Image's "JSON Layout" prompt. You set a canvas size and draw one box per element. Each box gets one row: a label (object, character or text), a caption (how it looks), the exact text for text boxes, and an optional editor colour. A summary card holds the overall caption, meta tags (chips) and a canvas type (single, multi_panel or collage). The node has three outputs: `prompt` (the compiled one-line JSON, which goes to `CLIPTextEncode`), and `width` and `height` (which go to `EmptyFlux2LatentImage`), so the layout and the render are always the same size (README "Workflow"; `nodes.py` L31-32).

- **Canvas rules.** Width and height must be positive multiples of 16 (`layout.py` L69-72). The widgets allow 16–16384 in steps of 16 (`nodes.py` L10-15); `layout.py` doesn't check the 16384 maximum. The draft's own width and height win over the widgets when it has them (`layout.py` L271-272, L288-289); the editor keeps the two in sync, but a headless call that sends a draft with its own size ignores the widgets. "对齐到 8" rounds all four edges of every box up to a multiple of 8. The editor offers 10 ratios (1:1 to 21:9) with long edges from 480 to 3840 (`moss_layout.js` L62-78); above about 2048 that is past what MOSS, fal and MOSI support (§4.11).
- **Draft and compiled forms.** The draft holds pixel boxes `[x1, y1, x2, y2]` from the top-left, plus the canvas size. The compiled prompt has no canvas size, so the width and height must reach the latent node.
- **Editing.** Every box has a numbered tab; click the tab to select a box and drag it to move it. Clicking the same spot inside an overlap again cycles through the stacked boxes. Boxes can be edited in pixels or percentages. Import from a file or the Advance node's `source`; "复制草稿" copies a lossless draft. An empty text field on a text item raises a persistent warning. With no boxes, the node outputs the trimmed summary caption (`layout.py` L300-302).
- **Tolerant parsing — only in the browser.** The JS editor (`parseDraftText`, `moss_layout.js` L589-636) handles prose around the JSON, double-encoded strings, `{layout | draft | source}` wrappers up to 4 levels, `\(` escape repair, legacy `scene_type` / `elements` prompts and compiled `abs_centralized` prompts. The Python side (used when no editor runs) only finds the first draft-like object in prose and converts legacy scene prompts; it raises a `LayoutError` on an already-compiled prompt (`layout.py` L290-294).
- **Limits.** The editor UI is Chinese only (e.g. `moss_layout.js` L41-42, L2270-2337); the README is in English and Chinese. It needs a ComfyUI frontend with DOM widgets. The Advance node is marked experimental (README L41-44).

**The model, MOSS-Image** (OpenMOSS / MOSI AI). The HF repos were created on 2026-10-11 and announced on 2026-10-16. Text-to-image in Base and SFT variants; per the SFT card, "the model weights and bundled inference code are released under" Apache-2.0. Vendor claims: layout control, strong Chinese and English text rendering, prompts up to 4K tokens, anime and photo styles. `USERGUIDE.md` ("MOSS-Image-Base User Guide") recommends 1, 1.5 or 2 MP (it extrapolates from 0.25 MP to 4 MP), any aspect ratio with sides in multiples of 16, ≥ 50 steps, CFG 3 (3–6), shift 5, Euler, two-pass skip-layer guidance at layer 22 (22, 24 and 26 also help), and the negative tags "nsfw, worst quality, bad anatomy, watermark, jpeg artifact". It labels layout prompts **"Experimental"**, says natural language and structure can be mixed, and announces a fine-tuned LLM "layout enhancer" ("Stay tuned").

**Architecture.** A single-stream DiT (`MOSSImageTransformer`: 42 layers, dim 3072, FFN 8192, 24 heads, latent channels 128, text dim 4096). Text encoder: Qwen3.5-9B (Apache-2.0). VAE: FLUX.2 with the small decoder; Comfy-Org's `vae/flux2-vae_small.safetensors` is byte-identical (SHA-256 `d8d52ba0…25bd013b`, 249,521,340 B) to `black-forest-labs/FLUX.2-small-decoder` (Apache-2.0). ComfyUI support at Fuobe's pin (`comfy/supported_models.py` L2037-2068): multiplier 1.0, shift 5.0, `memory_usage_factor` 14.6, `latent_formats.Flux2`, inference dtypes bf16 and fp32 only. Plain text is wrapped in Qwen's chat template with an open think block (`comfy/text_encoders/moss_image.py` L9-13); weight parsing is off (`qwen35.py` ~L1055), so the JSON reaches the model verbatim.

### 4.2 The layout format and the compiler

**Shape** (USERGUIDE "Layout Prompts (Experimental)"; `skills/moss-image-prompt-enhancer/references/layout.md`; MOSI's docs):

```json
{"summary":{"meta":["…"],"canvas":"single","caption":"…","palette":["…"]},
 "items":[{"label":"text","caption":"…","text":"…","bbox":[y_min,x_min,y_max,x_max],"tags":["…"],"palette":["…"]}],
 "bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}
```

Labels are `object`, `character` or `text`; `canvas` is `single`, `multi_panel` or `collage`. Boxes are pixel coordinates with the origin at the canvas centre; x grows to the right and y grows down.

**What `compile_layout` does** (`layout.py` L281-342):

1. Loads and normalises the draft (its width and height win; both multiples of 16; `bbox_coord_space` "abs", `bbox_format` "xyxy").
2. With no items, returns the trimmed summary caption.
3. Checks fields: summary caption / meta / canvas / palette; items label / caption / bbox / text / tags / palette / color. Labels must be object / character / text; a text item needs non-empty text; colour must be `#rrggbb`. Captions may be empty, unlike OpenMOSS's reference compiler, which also requires non-empty captions, a non-empty items list and all root fields (`compile_prompt.py` L65-93).
4. Converts each box: `[floor(round(y1, 9)) − H//2, floor(round(x1, 9)) − W//2, ceil(round(y2, 9)) − H//2, ceil(round(x2, 9)) − W//2]` — the same maths as `compile_prompt.py` L47-52. The box must lie inside the canvas.
5. Drops `color` and keeps the draft's own key order.
6. Emits `json.dumps(..., ensure_ascii=False, separators=(",", ":"), allow_nan=False)`.

The browser preview uses the same maths (`compiledPrompt`, `moss_layout.js` L1956-1981; `collapseNoise` = `Math.round(v·1e9)/1e9` at L1880) without validation.

**Test vectors** (re-derived by hand):

| Canvas | Draft box `[x1, y1, x2, y2]` | Compiled `[y_min, x_min, y_max, x_max]` | Source |
|---|---|---|---|
| 1024×1024 | [128, 96, 896, 224] | [−416, −384, −288, 384] | LinXce's bundled example draft |
| 1024×1024 | [128, 288, 896, 640] | [−224, −384, 128, 384] | same |
| 1024×1024 | [288, 800, 736, 864] | [288, −224, 352, 224] | same |
| 1536×1024 | [176, 224, 800, 864] | [−288, −592, 352, 32] | `layout.md` L68 (the cup example) |
| — | — | [−240, 160, −64, 640] and [−241, 159, −63, 641] | LinXce `tests/test_layout.py` |

**Key order is not consistent across MOSS's own tools.** MOSS's documented examples (USERGUIDE, README, `layout.md`, MOSI's docs) and the core ComfyUI node write summary {meta, canvas, caption} and items {label, caption, text, bbox} (the core node: {label, caption, text, palette, bbox} with summary {caption} only; `nodes_moss_image.py` L34-46). LinXce's editor, once it has synced, rewrites the draft (`buildDraft`, `moss_layout.js` L1935-1954) to summary {caption, canvas, meta?, palette?} and items {label, caption, bbox, color?, text?, tags?, palette?}, so its prompt puts bbox before text. fal's own expanded sample (on the model page) also has bbox before text. Whether the model cares is unknown; Fuobe should pick MOSS's documented order and make its decoder order-blind.

### 4.3 One box model, many models

The vocabulary is MOSS's, but the boxes are general. ComfyUI core already draws boxes once and compiles them for three models.

| Target | Format | Coordinates | Source |
|---|---|---|---|
| MOSS-Image | the JSON above | pixels, origin at the centre, yxyx | §4.2 |
| ComfyUI `CreateBoundingBoxes` (experimental; width / height 64–16384, step 16) | elements `{type: "obj" \| "text", bbox, text, desc, color_palette ≤ 5}` | integers on a 0–1000 grid, yxyx (rounded) | `comfy_extras/nodes_bounding_boxes.py` L276-288, L308-373 |
| Core `MOSSImageLayoutPrompt` (experimental) | maps those elements to MOSS JSON; has `character_boxes`; summary {caption} only | through the 0–1000 grid: loses up to W/2000 px plus 1 px of outward rounding | `nodes_moss_image.py` L9-47 |
| FLUX.3 (`Flux3LayoutPrompt`) | a caption that cites `<obj_N>`, then `[{"id":"obj_N","bbox":[…],"desc":…}]` | 0–1000, yxyx | `nodes_flux.py` L304-330 |
| Ideogram 4 (`BuildJsonPromptIdeogram`) | `{high_level_description?, style_description?, compositional_deconstruction: {background, elements}}` | 0–1000 | `nodes_json_prompt.py` L7-71 |
| Bria FIBO 2 (fal `bria/fibo-2/generate`) | VGL: `objects[].location` and `text_render[].location` as **free text**, not boxes | words ("top left", …) | fal OpenAPI |

So Fuobe needs **one neutral box model and a compiler per target**. Only MOSS-Image, FLUX.3 and Ideogram 4.x read coordinates; Bria gets location words; everything else gets plain sentences.

### 4.4 Weights

| Files | Repo @ revision | Size | Licence (information) | Role |
|---|---|---|---|---|
| `diffusion_models/moss_image_sft_int8_convrot.safetensors` + `text_encoders/qwen3.5_9b_w4a8_gptq.safetensors` + `vae/flux2-vae_small.safetensors` | Comfy-Org/MOSS-Image @ `530a4c94` | 5.414 + 7.344 + 0.250 = **13.01 GB** | Apache-2.0 (repo tag; the small VAE is also Apache-2.0 through BFL's byte-identical FLUX.2-small-decoder) | **the recommended open set** (the Comfy template's default). The template's note gives the encoder as "9.08 GB", which is the int8 file's size in GiB, so that note is wrong |
| The whole repo: `moss_image_{base,sft}_bf16` 10.165 GB each, `moss_image_{base,sft}_int8_convrot` 5.414 each; `qwen3.5_9b` bf16 19.306, int8 9.748, w4a8 7.344; `flux2-vae` 0.336 (byte-identical to Comfy-Org/Flux-2-Klein-4B's, Apache-2.0), `flux2-vae_small` 0.250; LoRAs `moss_image_color_depth_control` 0.313 and `moss_image_edit_lora_rank_64_bf16` 0.297 | same | 68.751 GB | Apache-2.0 tag; the colour / depth LoRA (from darask0) Apache-2.0; the edit LoRA (from chinoll) has no licence tag and its card says the project code is GPLv3 | the LoRAs need core nodes that are only in ComfyUI ≥ v0.43.1 (`MOSSImageControl`, `TextEncodeMOSSImageEdit`) |
| Diffusers layout (transformer 3 shards, text encoder 4 shards, tokenizer, VAE, a custom `pipeline_moss_image.py`) | OpenMOSS-Team/MOSS-Image-SFT @ `f972bd4b` | 27.229 GB | Apache-2.0 | the source weights |
| same layout | OpenMOSS-Team/MOSS-Image-Base @ `85975793` | 27.229 GB | Apache-2.0 | not post-trained; meant for LoRA training (USERGUIDE L5) |
| `lora.safetensors` (v2.0 "Euler-native": 4 steps, CFG 1, any LoRA loader) + 2- and 3-step variants | akhaliq/MOSS-Image-SFT-4-steps @ `2ded95c3` | 1.189 GB | Apache-2.0 | a fast tier |
| `lora.safetensors` (strength 1) or `lora_latest.safetensors` (0.7): 8 evaluations, no CFG; "Trained on compact-JSON scene_graph captions" | lodestones/MOSS-Image-SFT-8-steps-dmd @ `f95df83b` | 1.189 GB | Apache-2.0 | a fast tier |
| `moss_image_sft_8stepdmd_int8_convrot.safetensors`: SFT with the 8-step DMD LoRA merged, a drop-in for Comfy-Org's int8 file, CFG 1 | Spectrallic/MOSS-Image-SFT-8step-DMD-int8-convrot @ `8fdeb392` | 5.414 GB | Apache-2.0 | the simplest fast tier (swap one file) |
| 4 LoRAs: the 4-step v2 at rank 72; a banding fix (blocks 21–49, about −0.5); SFT-minus-Base difference LoRAs at rank 256 and 512 | Kijai/MOSS-image_experimental @ `9869b285` | 4.892 GB | no tag (the 4-step file derives from Apache-2.0 work) | optional |
| banding-fix LoRAs (`L37-41`, `L32-36_extra`, 1.133 GB each), a strong deband LoRA, split-QKV SFT | MATLOWAI/MOSS-Image-SFT-DeBand @ `6d6b6179` | 18.455 GB repo | Apache-2.0 | against SFT's vertical banding |
| FP16-safe Base and SFT (10.165 GB each) | KBlueLeaf/MOSS-Image-FP16-fixed @ `ba636014` | 40.694 GB repo | Apache-2.0 | GPUs without bf16 (core doesn't list fp16 for MOSS) |

### 4.5 Licences, as written

- **LinXce/Comfyui-Moss-LayoutPrompt** (Python and `web/moss_layout.js`): Apache-2.0. 25 commits from 2026-10-17 to 10-27, with merged PRs from two other accounts. Its `pyproject` copies OpenMOSS's plugin metadata (PublisherId "mosi", Repository OpenMOSS/MOSS-Image, a documentation path that doesn't exist upstream); it is not on the Comfy Registry.
- **OpenMOSS/MOSS-Image** (pipeline, Gradio app, `comfyui/moss-image` loader pack, the prompt-enhancer skill): Apache-2.0.
- **MOSS-Image Base and SFT weights**: Apache-2.0. USERGUIDE's "keep the text encoder frozen" is training advice, not a licence term.
- **Qwen3.5-9B**: Apache-2.0. **FLUX.2 VAE files**: the small one is byte-identical to BFL's Apache-2.0 FLUX.2-small-decoder; the full one is byte-identical to the VAE in Comfy-Org/Flux-2-Klein-4B (Apache-2.0). The same bytes also ship in non-commercial FLUX.2 repos, but the Apache-2.0 distribution covers them.
- **Repack LoRAs**: darask0's colour / depth control is Apache-2.0 (its card says its training depth maps came from Depth Anything V2 Large, CC-BY-NC-4.0; information only). chinoll's edit LoRA: no tag; project code GPLv3.
- **Community adapters**: Apache-2.0 for lodestones, akhaliq, Spectrallic, MATLOWAI and KBlueLeaf; no tag for Kijai's repo.
- **ComfyUI core** (MOSS support from `e087d8f6` / PR #17095, in Fuobe's pin; `MOSSImageControl` and `TextEncodeMOSSImageEdit` from v0.43.1): GPL-3.0; Fuobe talks to it over HTTP only.
- **Hosted (paid)**: fal `fal-ai/moss-image` "$0.05 per megapixel", tagged "Commercial use"; its safety checker returns black images for flagged outputs unless the account is authorised to turn it off. `fal-ai/moss-image/lora` shows "$0 per compute second" (looks unpublished). MOSI (api.mosi.cn): no image price listed on 2026-10-29; a visible watermark by default. WaveSpeedAI: from $0.02 (text to image) and $0.025 (LoRA).
- **A Fuobe TypeScript compiler** is Fuobe's own code (`BROWSER_LICENCE` "Fuobe (open source)", `src/lib/licences.ts` L382). The layout format is a documented prompt convention; re-implementing it needs no attribution, and copying Apache-2.0 code should keep its notice.

### 4.6 ComfyUI: nodes and the graph Fuobe would build

| Pack | Commit | Licence | Classes | Notes |
|---|---|---|---|---|
| LinXce/Comfyui-Moss-LayoutPrompt | `326ad58e` | Apache-2.0 | `MOSSImageLayoutPrompt` (inputs width, height 16–16384 step 16, layout; outputs prompt, width, height), `MOSSImageLayoutPromptAdvance` (adds `source`, compiled only when `layout` has no boxes; `nodes.py` L72-76) | `dependencies = []`; frontend extension `web/moss_layout.js` (114,136 B, 2,929 lines; a DOM widget, minimum node size 980×680). **Shadowed by core:** core registers the same node id `MOSSImageLayoutPrompt` (`comfy_extras/nodes_moss_image.py` L13, still in v0.43.1); built-ins load first (`nodes.py` L2597) and a custom node whose id is already taken is skipped (~L2337, ~L2367), so only the Advance node is usable, and the pack's JS still attaches to the core class name (`moss_layout.js` L4, L2918-2928; the UI effect is inferred). **Fuobe should not install it** |
| OpenMOSS `comfyui/moss-image` (Registry "moss-image" by "mosi", v0.1.1) | `2b46b1e0` | Apache-2.0 | `MOSSImageUNETLoader`, `MOSSImageCLIPLoader`, `MOSSImageHFLoader`, `MOSSImageHFDiTLoader`, `MOSSImageHFTextEncoderLoader`, `MOSSImageHFVAELoader` | optional; its own README calls the native core path "recommended". Don't carry its `ModelSamplingSD3` into native graphs (use `ModelSamplingAuraFlow`, multiplier 1, or the model's default shift 5). LinXce's example uses this loader |
| ComfyUI core at Fuobe's pin | `fc04da91` (includes `e087d8f6`, checked with `git merge-base --is-ancestor`) | GPL-3.0 | `UNETLoader`, `CLIPLoader` (type `moss_image`, `nodes.py` L1021), `VAELoader`, `EmptyFlux2LatentImage`, `CLIPTextEncode`, `SkipLayerGuidanceDiTSimple`, `KSampler`, `VAEDecode`, `SaveImage`, `CreateBoundingBoxes`, core `MOSSImageLayoutPrompt`, `Flux3LayoutPrompt`, `BuildJsonPromptIdeogram`, `TextGenerate`, `ModelSamplingAuraFlow` | the int8 / w4a8 files run through comfy-kitchen 0.2.37 (installed); `comfy/quant_ops.py` L22-28 turns its CUDA backend off unless PyTorch is built for CUDA ≥ 13 (cu130) and logs a warning |
| ComfyUI v0.43.1 (2026-10-28) | `086099f5` | GPL-3.0 | adds `MOSSImageControl` (colour / depth maps), `TextEncodeMOSSImageEdit` (edit LoRA formats) | not needed for layouts; needs a pin bump and `comfyui-workflow-templates==0.11.98` |

**The graph Fuobe would hand-build: `moss-image-t2i`.** From Comfy-Org's template subgraph `image_moss_image_t2i_bboxes.json` (workflow_templates head `14220b8b`; SHA-256 `225aa1c2…c808fad2c` — full hash in the JSON), without the subgraph wrapper, the `TextGenerate` upsampler, the box nodes and the switches. Core nodes only; the templates aren't in the packaged templates 0.11.86 that Fuobe's ComfyUI installs.

| id | class | settings | Fuobe binding |
|---|---|---|---|
| 1 | `UNETLoader` | `moss_image_sft_int8_convrot.safetensors` (or Spectrallic's 8-step file for "Fast") | — |
| 2 | `CLIPLoader` | `qwen3.5_9b_w4a8_gptq.safetensors`, type `moss_image` | — |
| 3 | `VAELoader` | `flux2-vae_small.safetensors` | — |
| 4 | `CLIPTextEncode` | positive | `prompt` (plain words, or the compiled layout) |
| 5 | `CLIPTextEncode` | negative "nsfw, worst quality, bad anatomy, watermark, jpeg artifact" | `negativePrompt` |
| 6 | `EmptyFlux2LatentImage` | 1024 × 1024, batch 1 | `width`, `height` |
| 7 | `SkipLayerGuidanceDiTSimple` | the template's ['', '22', 0, 0.5] (LinXce's example: ['', '22', 0, 1]) | — |
| 8 | `KSampler` | Quality: 50 steps, CFG 3, euler (USERGUIDE); Standard: 25 steps, CFG 2.5, er_sde / simple (the template); Fast: 8 steps, CFG 1 with the DMD file | `seed`, `steps`, `cfg` |
| 9 | `VAEDecode` → 10 `SaveImage` | — | `filenamePrefix`; output image |

Manifest entry: `capability` t2i, `limits.dimensionMultiple` 16, `maxWidth` / `maxHeight` 2048, `vramGb` 16 (a guess), licence Apache-2.0, `validated` only after `/prompt` validation on the library's CPU ComfyUI (MOSS support is in the pin, so the graph can be validated here; a real render needs a GPU).

### 4.7 Cloud routes

| Provider | Endpoint | Inputs (fal OpenAPI, re-fetched 2026-10-29) | Price |
|---|---|---|---|
| fal | `fal-ai/moss-image` | `prompt`* (1–16,384 chars; "Supports natural language, tag sequences, and JSON layouts"); `negative_prompt` (default ""; "When empty, guidance uses transformer layer skipping"); **`enable_prompt_expansion` (default true: "Plan a structured layout from your prompt before generation") — send false with a layout**; `image_size` (enum square_hd (default) / square / portrait_4_3 / portrait_16_9 / landscape_4_3 / landscape_16_9, or {width, height}, "rounded to multiples of 16 between 512 and 2048"); `num_inference_steps` 1–100 (50); `guidance_scale` 0–10 (3); `seed`; `num_images` 1–4 (1); `enable_safety_checker` (true); `output_format` jpeg (default) / png / webp; `sync_mode`. Output: `images[]`, `seed`, `has_nsfw_concepts[]`, `actual_prompt` (the expanded layout, when expansion ran) | $0.05 per megapixel (model page) |
| fal | `fal-ai/moss-image/lora` | the same, plus `loras[]` (≤ 3 of {path, scale 0–4, default 1}; "trained on MOSS-Image Base or SFT. Up to 3 LoRAs are merged together") | unclear: the page shows "$0 per compute second"; assume at least $0.05/MP until fal publishes one (guess) |
| MOSI (first party; no Fuobe provider) | `POST https://api.mosi.cn/v1/images/generations`, model `moss-image-sft-1.0` or `moss-image-base-1.0` (or the `-2026-10-09` snapshots); a documented "Layout-to-Image" page uses the same endpoint with the layout JSON as `prompt` | `prompt` (≤ 4,000 chars), `prompt_enhance` (default false), `negative_prompt`, `size` "WxH" (each side 256–2048, multiple of 16, ≤ 2,097,152 px), `n` 1 only, `seed`, `num_inference_steps` 1–100, `guidance_scale` 0–10, `response_format` url, `output_watermark` {enabled} (**a visible watermark is on by default**). Errors include `prompt_enhancement_refused` and `safety_guardrail_blocked` | not listed (the pricing page shows only speech products) |
| WaveSpeedAI (no Fuobe provider) | `wavespeed-ai/moss-image/text-to-image`, `…/text-to-image-lora` | prompt, resolution tiers including 1.5K, ratios 1:3 to 3:1, a $0.001 prompt-enhance option; no mention of JSON layouts | from $0.02 / $0.025 |
| Replicate | none (`openmoss/moss-image`, `openmoss-team/moss-image`, `prunaai/moss-image` all 404) | — | — |
| fal (already in Fuobe as `flux-3`, `cloud-models.generated.ts` L1136) | `blackforestlabs/flux-3/text-to-image` | prompt, aspect_ratio, resolution 768sq … 4k, `enable_prompt_expansion` (default false), safety_tolerance, output_format. A FLUX.3 layout goes inside the prompt (`Flux3LayoutPrompt` shape); whether fal passes it through unchanged is unverified | not recorded in Fuobe |
| fal (already `ideogram-4-5`, L1335) | `ideogram/v4.5` | prompt (≤ 10,000 chars), image_size, `enable_prompt_expansion` (default true: send false), quality. Whether the prompt string accepts Ideogram's JSON is a guess | $0.03 / image |
| fal (already `bria-fibo-2`, L16526) | `bria/fibo-2/generate` | prompt, `vgl` {objects[] with location words, text_render[] with location, background, lighting, …}, aspect_ratio, seed | $0.04 / image |

The two MOSS endpoints are written into `new-models-7.json` → `endpointRecords` in the shape of `paid-model-apis-4.json`'s `endpoints`, so `scripts/gen-cloud-models.py` can read them (package N7-1).

**The hosted-parts recipe.** None needed for MOSS: send the compiled layout as `prompt` with `enable_prompt_expansion: false` and `image_size: {width, height}` equal to the layout canvas (multiples of 16, each side 512–2048) on fal; or `prompt_enhance: false`, `size: "WxH"` and `output_watermark: {enabled: false}` on MOSI (≤ 4,000 characters). Other cloud models get their own compiler (§4.3).

### 4.8 Hardware

- **No official VRAM figure.** The README lists memory modes (GPU resident / Component / Sequential); the template says "If VRAM is tight, lower resolution or use Sequential / CPU offload". The recommended set is about 13 GB on disk (DiT 5.4 + encoder 7.3 + VAE 0.25); a guess is that it fits 12–16 GB GPUs with ComfyUI's offloading (`memory_usage_factor` 14.6).
- **Fast int8 / w4a8 needs** comfy-kitchen 0.2.37 and a PyTorch build for CUDA ≥ 13 (`quant_ops.py` L22-28); otherwise ComfyUI warns and (guess) falls back to a slower path. Core runs MOSS only in bf16 or fp32, so GPUs without bf16 pay fp32 memory (inferred).
- **Measured on Apple silicon** (`docs/macos.md` L60-64, M1 Max 32 GB, SFT): 1024², 20 steps, bf16: 320.4 s; 768×1024, 28 steps, fp16: 344–395 s.
- **Steps:** official quality is ≥ 50 steps at CFG 3; the Comfy template uses 25 steps, CFG 2.5, er_sde (a speed trade-off, its note 29). Few-step options all at CFG 1: akhaliq 4-step, lodestones 8-step DMD, Spectrallic's merged 8-step int8 file.
- LoRA training can need as little as 6 GB (KohakuMossTrainer, README News 2026-10-18).

### 4.9 Fuobe today

Read at `claude/fuobe-parity-4` (`7d7a765`).

- **No MOSS-Image anywhere in the catalog**, no MOSS workflow among the 150 manifest entries, and no layout or box prompt. `git grep -i moss` finds only research docs, `workflows/comfyui/object_info.subset.json` L1736 (`moss_image` in the CLIPLoader type list) and unrelated "mossy" text. Research flagged it twice: `docs/research/comfyui-oss-4.md` L298 ("Add as opt-in after a GPU test") and `paid-model-apis-4.md` L316 ("Seen but not recorded").
- **The pinned ComfyUI** (`install-comfyui.sh` L12, `fc04da91`) has native MOSS-Image and the core box nodes.
- **Sketch and draw**: `src/components/studio/sketch-editor.tsx` (a dialog with mask and draw modes); `applySketch` (`src/lib/catalog/sketch.ts`) runs in the composer (`composer.tsx` L383) and on the server (`src/server/generations.ts` L528); studios opt in with `StudioConfig.sketch` (`studio-context.tsx` L45).
- **Composer modes**: Frames mode is the precedent (`StudioConfig.frames`, `studio-context.tsx` L71; `enterFrames` / `framesRequest` / `leaveFrames`, `src/lib/composer.ts` L541 / L553 / L579; the Video studio sets `frames: true`, `studios.ts` L84). `IMAGE_STUDIO` starts at `studios.ts` L6.
- **Sizes**: `GenParams` (`types.ts` L658) has `aspectRatio` and `resolution` but no width or height, plus `extra` (L729) and `enhancePrompt`. Open models: `computeDimensions` (`src/lib/comfy.ts` L233) and the manifest's `dimensionMultiple` (`src/server/providers/comfyui.ts` L905). Cloud: `FieldMap.size` {key, width, height, multiple, max, base, table} (`types.ts` L427-436), rendered by `sizeValue` (`payload.ts` L101); it has `max` but no `min`. The prompt enhancer runs when `enhancePrompt` is set (`generations.ts` L1129-1137) and would rewrite a layout.
- **Canvas**: `CanvasNodeType` (`canvas.ts` L44), `NODE_SPECS` (L221), `outputType` (L570), `sourceOf` (L814: prompt and table nodes become text).
- **Ads and Marketing**: `planAd` (`src/components/ads/layout.ts` L246) already plans rectangles for headline, body, CTA and logo; `NO_TEXT` (`src/server/ads.ts` L150) asks the model for no text and `visualRequest` (L152); `wordsOnTop` (`marketing.ts` L962) puts the words over the picture in the browser on every open-engine run.
- **Layers**: `rotatedBounds` (`src/lib/layers.ts` L479), `resizeBox` (L617), `rectFrom` (L655) — box maths to reuse; `src/lib/ocr.ts`.
- **Catalog**: `flux-3` (L1136, no price block), `ideogram-4-5` (L1335, $0.03 / image), `bria-fibo-2` (L16526, $0.04 / image); the catalog already supports a "megapixel" price unit.
- **Assist skills**: 20 folders under `skills/` (e.g. `marketing-studio-cards`); no layout skill.

### 4.10 Where it goes and why

**A layout is a way to write a prompt, so it lives in the composer.** The Image studio gets a "Layout" mode next to the sketch tools, like Frames mode in the Video studio. Anything that already knows where things go on a canvas (Ads' rectangles, Layers' boxes, Canvas pipelines) can produce the same draft.

| Where (exact spot) | What the user does | Open engine | Cloud engine | Priority · package |
|---|---|---|---|---|
| **A shared library** `src/lib/layout-prompt.ts` (+ `tests/layout-prompt.test.ts`), used by the browser, the server, Assist, MCP and the CLI | Draws once; the same layout works on their GPU and in the cloud | `compileMoss(draft, w, h)` with the reference maths, MOSS's documented key order, the zero-items rule; `decodeMoss`; a tolerant parser; validation | the same `compileMoss` for fal and MOSI; `compileFlux3`, `compileIdeogram`, `compileVgl`, `compileWords` | P0 · N7-1 |
| **Catalog + library**: open `oss-moss-image` (`moss-image-t2i`) and cloud `moss-image` (`fal-ai/moss-image`; `/lora` for LoRAs), plus Settings → Models & licences rows | Picks MOSS-Image, an Apache-2.0 model that writes clean Chinese and English text, in the Image studio on either engine | §4.6 graph; Fast tier on Spectrallic's 8-step file | fal at $0.05/MP; `enable_prompt_expansion` false for layouts | P0 · N7-1 |
| **Image studio composer**: a "Layout" chip next to the sketch tools (`StudioConfig.layout`, `IMAGE_STUDIO`; a new `layout-editor.tsx` built from `sketch-editor.tsx` and the box maths in `layers.ts`) | Taps Layout, drags a box for the headline, the product and the price tag, types one row per box (Object / Character / Text, what it looks like, the exact words). The picture comes back with everything in place; Reuse reopens the boxes | compiled against the exact size the workflow will render; box-reading models first; `enhancePrompt` forced off; phones get draggable boxes and rows in a sheet | `moss-image` default; `flux-3` and `ideogram-4-5` with their compilers and expansion off; other models get `compileWords` and a one-line note | P0 · N7-2 |
| **Result viewer and feed tile**: "Edit layout" | Opens a render's boxes, moves the title, fixes a word, re-renders with the same seed | the stored draft reopens the editor | for fal runs with expansion on, `actual_prompt` (abs_centralized, yxyx) is decoded into boxes at the image's size, so even a plain prompt becomes an editable layout | P0 · N7-2 |
| **Layout editor Import / Export** (browser only) | Brings layouts from ComfyUI (a LinXce draft, a compiled prompt, a legacy scene prompt, `CreateBoundingBoxes` elements) and copies Fuobe's back out | — | — | P0 · N7-2 |
| **Canvas**: a "Layout" node (`CanvasNodeType` "layout", Inputs group, text output; `NODE_SPECS`, `outputType`, `sourceOf`; a card in `nodes.tsx` with a mini preview and "Edit layout") | Wires a Layout node into any image model; with a Table node upstream, `{Headline}` and `{Price}` placeholders fill row by row: one layout, a batch of posters | `sourceOf(layout)` compiles for the downstream model at its render size; table rows fill text items first | same, per-model compilers | P1 · N7-8 |
| **Marketing Studio formats and Ads Studio** (`wordsOnTop`, `marketing.ts` L962; `planAd`, `layout.ts` L246; `NO_TEXT`, `ads.ts` L150) | On their own GPU, chooses "Words drawn by the model": the headline, price and button come from the model, in place | `AdPlan` rects → a layout (headline, body, CTA as text items; logo area and product as object items) → `oss-moss-image`. Browser compositing stays the default (exact fonts); a "keep clear" layout keeps the product out of the copy rects | `moss-image`, or `ideogram-4-5` / `flux-3`, as extra "draws the exact text in place" choices | P1 · N7-8 |
| **Assist**: `skills/layout-poster/SKILL.md` (adapted from OpenMOSS's Apache-2.0 prompt-enhancer skill and `layout.md`) and a "Plan layout" button in the editor | Types "a sale poster for my candle shop, 30% off" and gets a starting layout to adjust | the LLM writes a pixel draft; the compiler validates and compiles it. Options: Fuobe's text LLM (Ollama / `oss-text-llm`) now; core `TextGenerate` on the MOSS encoder later (unproven on the pin) | `text-llm` writes the draft | P1 · N7-8 |
| **Storyboard** (`/storyboard`, `storyboard.ts`): "One sheet" | Gets the storyboard as one consistent page, then split into frames | `canvas: "multi_panel"`, one item per panel, browser crops; quality is a guess | `moss-image` on fal | P2 · N7-11 |
| **Layers** (`/layers`): "Re-render from layers" | After rearranging layers, one coherent repaint that matches the arrangement | each visible layer's `rotatedBounds` box and name, plus OCR lines as text items → a draft | `moss-image` (or Ideogram / FLUX.3) | P2 · N7-11 |
| **Sketch draw → colour regions / depth** (after a ComfyUI pin bump to ≥ v0.43.1) | Paints flat colour regions or reuses a depth map from Layers to fix where things go | `MOSSImageControl` + the colour / depth LoRA; guess-level, needs a GPU test | none hosted; fall back to the box layout | P2 · N7-11 |

### 4.11 Risks and unknowns

**Risks**

- **Node-id collision** (confirmed from code; the UI effect is inferred): core owns `MOSSImageLayoutPrompt`, so the LinXce stable node is skipped, saved workflows that use it open on the core node (different inputs), and the pack's JS still attaches to that class. Don't install the pack into Fuobe's ComfyUI.
- **Layouts are "Experimental"** (USERGUIDE L55). Box-following and text accuracy are vendor claims with no published benchmark; the core box nodes are `is_experimental`.
- **Prompt rewriting destroys layouts.** Turn off fal's `enable_prompt_expansion` (default **true**), don't enable MOSI's `prompt_enhance`, force Fuobe's `enhancePrompt` off, and keep the Comfy template's `TextGenerate` upsampler out (its own notes disagree on whether it is on).
- **The canvas must match the render exactly.** Fuobe sends aspect ratio and resolution, not width and height; `computeDimensions` and `FieldMap.size` round; fal clamps each side to 512–2048; MOSI allows 256–2048 and ≤ 2,097,152 px; `FieldMap.size` has no `min`. A layout compiled for another size shifts or clips the boxes.
- **Key order** differs across MOSS's own tools (§4.2); the model's sensitivity is unknown.
- **Prompt limits differ:** fal 16,384 characters; MOSI 4,000; MOSS about 4K tokens; Ideogram 10,000.
- **Core's grid rounding:** the core box nodes go through a 0–1000 grid (§4.3); the pixel path is exact.
- **Plugin graphs aren't portable** to native loaders (`ModelSamplingSD3` vs the default shift 5).
- **Heavy for an image model:** 13 GB at best, ≥ 50 steps for official quality; an M1 Max took about 320 s at 20 steps. Fast int8 / w4a8 needs a cu130 PyTorch.
- **SFT banding** (vertical colour bands; Kijai and MATLOWAI cards). The colour / depth and edit LoRAs need ComfyUI ≥ v0.43.1.
- **The LinXce editor** is Chinese-only, its Advance node experimental, and its presets reach 3840 px, beyond MOSS's range.
- **Hosted quirks:** fal's checker returns black images when it flags an output; MOSI watermarks by default and can refuse with `safety_guardrail_blocked`; `fal-ai/moss-image/lora` and MOSI have no published image price.
- **Few-step adapters may not keep layouts:** lodestones' DMD was "Trained on compact-JSON scene_graph captions", not this format (untested).
- **Carried over, not re-verified:** FLUX.3 and Ideogram 4.5 honouring in-prompt layouts on fal; WaveSpeed's LoRA limits; ComfyUI PR numbers #17172 and #17206 (v0.43.1 code was read instead).

**Unknowns**

- An official VRAM figure (12–16 GB for the int8 / w4a8 set is a guess) and the time and VRAM of a 1–2 MP render on a 16–24 GB NVIDIA card at 25 vs 50 steps — the "one GPU render" Fuobe's earlier research asked for.
- Whether fal follows a supplied layout verbatim with expansion off (the schema says it "Supports … JSON layouts"; not run, no key); how its per-megapixel price rounds and whether it multiplies by `num_images`; the real price of the `/lora` endpoint; MOSI's image price and whether its Layout-to-Image route behaves like fal's.
- Whether the model cares about key order.
- Whether Ideogram 4.5 on fal accepts its JSON in the prompt string, and whether fal's FLUX.3 honours an in-prompt layout table.
- How well `multi_panel` and `collage` canvases render with many panels.
- Whether the few-step adapters keep layout and text accuracy.
- Whether `TextGenerate` with the MOSS encoder works on the pin (the think-block fix #17121 and the MOSS `mtp` change came later).
- The int8 / w4a8 speed without a cu130 build (falls back or errors; guess: falls back).
- The edit LoRA's and Kijai's licences; which ComfyUI release first has each MOSS fix.

## 5. Build plan

Rules this plan follows. **Put each thing where people already work**: a button, mode or choice inside an existing studio, not a new page. **Both engines where a route exists**, and say plainly where one engine has none. **One package per natural feature**, small enough for one engineer: a finishing step used by several studios is one package, and the studios that adopt it later are another. Licences are information: every package adds its rows to Settings → Models & licences, all switched on. Nothing here was run on a GPU or a paid API, so every package ends with what it can't verify on this machine.

### 5.1 Order

| # | Package | Priority | Effort | Depends on | What users get | Open engine | Cloud engine |
|---|---|---|---|---|---|---|---|
| N7-1 | MOSS-Image on both engines and the layout compiler | P0 | medium | — | MOSS-Image in the model picker on both engines | core-node graph, 13 GB | fal $0.05/MP |
| N7-2 | Layout mode in the Image studio, Edit layout on results, Import and Export | P0 | large | N7-1 | a Layout mode in the Image studio; Edit layout on results | MOSS-Image | MOSS-Image, FLUX.3, Ideogram 4.5 (+ words for others) |
| N7-3 | Regenerate in 2K: an open finishing step in Upscale, on result tiles and in Canvas | P0 | large | — | Regenerate · creative in Upscale, "Regenerate in 2K" on tiles, Canvas | Open-H3-Regenerate-2K (rdh + LBH packs, ~19.6 GB + FL2VA) | no host: Starlight / Topaz creative; fal H3 re-render at 2K for H3 results |
| N7-4 | Character swap in 2K: Swap Studio's Finish and Genjutsu's Quality | P0 | medium | N7-3 | 2K / 4K Character swaps; Swap Studio's Finish works | regenerate + mask composite | fal H3 LoRA route at 2K / 4K (new takes) |
| N7-5 | Fly path in Cinema's 3D scene, and the camera-path library | P0 | large | — | Fly path in Cinema's 3D scene | Uni3C (core nodes) on a browser path render | H3 Max camera-controls |
| N7-6 | Turnaround video for cast sheets and characters | P0 | small | — | Turnaround video on cast sheets and characters | Frames chain (Wan 2.2 14B) | H3 Max reference-to-video / FLUX 3 Max keyframes |
| N7-7 | Exact orbits in DoP, Cinema moves, Image to 3D and Canvas | P1 | medium | N7-5 | Exact orbits in DoP, Cinema moves, Image to 3D, Canvas, Assist | Uni3C | H3 Max camera-controls |
| N7-8 | Layouts in Canvas, Marketing, Ads and Assist | P1 | medium | N7-1, N7-2 | Layouts in Canvas, Marketing, Ads and Assist | MOSS-Image | MOSS-Image / Ideogram / FLUX.3 |
| N7-9 | WorldCast on your GPU: the Fuobe Fly-Around Original's open half | P1 | large | N7-5, N7-6 | WorldCast behind the fly-around buttons | WorldCast worker (48 GB+) | unchanged |
| N7-10 | Regenerate in Faceless, video segments and Cinema H3 shots | P2 | medium | N7-3 | Regenerate in Faceless, segments and Cinema H3 shots | regenerate graph | SeedVR / Starlight / fal H3 2K |
| N7-11 | MOSS one-sheet storyboards, re-render from Layers, and painted colour / depth control | P2 | medium | N7-1, N7-2 | One-sheet storyboards, re-render from Layers, painted colour / depth | MOSS-Image (+ v0.43.1 control) | MOSS-Image; no hosted control |

Why this order: N7-1 and N7-2 come first: core nodes only, a graph this machine can validate, a hosted route that already exists, and the clearest new ability (boxes that become a picture). N7-3 and N7-4 answer the owner's first link and fix a visible dead end (Swap Studio's Finish). N7-5 and N7-6 give WorldCast's experience on both engines now, with routes Fuobe has or can add in one line; N7-9 brings WorldCast itself once a 48 GB+ GPU can test it. The P2 packages spread finished features to more studios.

### 5.2 N7-1 · MOSS-Image on both engines and the layout compiler

_Priority P0 · effort medium · depends on none · key `n7-1-moss-image` · research §4.1, §4.2, §4.3, §4.4, §4.6, §4.7, §4.9, §4.10_

Goal. Add MOSS-Image (OpenMOSS; Apache-2.0; strong Chinese and English text; reads layout boxes) as an image model on both engines, and a pure TypeScript layout library that every later surface uses. This package adds no new screen: the model appears in the Image studio's model picker, and the Layout mode is N7-2. Research: new-models-7.md §4.1-§4.10.

Where it lands (exact spots).
- New `src/lib/layout-prompt.ts` and `tests/layout-prompt.test.ts`.
- `src/lib/catalog/models.ts`: a new open ModelDef `oss-moss-image` (kind image, op t2i) next to the other open image models.
- `scripts/comfy/hand-built/moss-image-t2i.json`, its entry in `scripts/comfy/library.spec.mjs`, and `workflows/comfyui/manifest.json` (built with `npm run build -- moss-image-t2i` in `scripts/comfy`).
- `scripts/gen-cloud-models.py` (a `model(...)` line for the cloud `moss-image`) and `src/lib/catalog/cloud-models.generated.ts` (regenerated with `pnpm gen:catalog`).
- `src/lib/catalog/types.ts` L427-436 (`FieldMap.size`) and `src/lib/catalog/payload.ts` L101 (`sizeValue`): add a `min`.
- A `ModelOptions.layout?: "moss" | "flux3" | "ideogram" | "vgl"` flag (set on `oss-moss-image`, `moss-image`, `flux-3`, `ideogram-4-5`, `bria-fibo-2`).

The library (`src/lib/layout-prompt.ts`, §4.2-§4.3).
- Neutral types: `LayoutDraft { summary: { caption, meta: string[], canvas: "single" | "multi_panel" | "collage", palette?: string[] }, items: LayoutItem[], aspect? }` and `LayoutItem { label: "object" | "character" | "text", caption, text?, box: [x0, y0, x1, y1] as 0-1 fractions of the canvas, tags?, palette?, color? }`. Fractions keep a draft valid when the render size changes.
- `compileMoss(draft, width, height)`: pixels = fraction x size; top/left = floor(round(v, 9)), bottom/right = ceil(round(v, 9)); subtract H//2 from y and W//2 from x; order yxyx; drop `color`; compact JSON with no ASCII escaping; keys in MOSS's documented order (summary: meta, canvas, caption, palette; item: label, caption, text, bbox, tags, palette; root `bbox_coord_space: "abs_centralized"`, `bbox_format: "yxyx"`); zero items returns the trimmed summary caption.
- `decodeMoss(prompt, width, height)`: back to a draft, blind to key order (fal's `actual_prompt` puts bbox before text).
- `parseLayout(text)`: tolerant like LinXce's browser parser: prose around the JSON, double-encoded strings, `{layout | draft | source}` wrappers up to 4 levels, LinXce drafts (`bbox_coord_space` "abs", `bbox_format` "xyxy", pixel boxes plus width/height), legacy `scene_type` / `elements` prompts, compiled abs_centralized prompts, and ComfyUI `CreateBoundingBoxes` elements (0-1000 grid, yxyx).
- `validateLayout(draft, width, height, target)`: sides multiples of 16; a text item needs its words ("Type the words for box 2"); boxes inside the canvas; a warning above 2048 px a side or 4 MP; MOSI's 4,000-character prompt limit when the target is MOSI.
- Other compilers (§4.3): `compileFlux3` (a caption citing `<obj_N>`, then `[{"id":"obj_N","bbox":[0-1000 yxyx],"desc":...}]`, the shape of ComfyUI's `Flux3LayoutPrompt`, `comfy_extras/nodes_flux.py` L304-330); `compileIdeogram` (`{high_level_description, style_description?, compositional_deconstruction: {background, elements}}`, the shape of `BuildJsonPromptIdeogram`, `nodes_json_prompt.py` L7-71); `compileVgl` (Bria FIBO 2 `objects[].location` / `text_render[].location` as words from a thirds grid); `compileWords` (plain sentences for every other model). `layoutCompilerFor(model)` picks one from `ModelOptions.layout`.

Open engine (§4.6).
- Graph `moss-image-t2i`, core nodes only: UNETLoader `moss_image_sft_int8_convrot.safetensors` -> CLIPLoader `qwen3.5_9b_w4a8_gptq.safetensors` type `moss_image` -> VAELoader `flux2-vae_small.safetensors` -> CLIPTextEncode positive / negative -> EmptyFlux2LatentImage -> SkipLayerGuidanceDiTSimple ('', '22', 0, 0.5) -> KSampler -> VAEDecode -> SaveImage. Bindings: prompt, negativePrompt, width, height, seed, steps, cfg, filenamePrefix. Defaults 1024 x 1024, 25 steps, CFG 2.5, er_sde / simple (the Comfy template); a Quality setting at 50 steps, CFG 3, euler (USERGUIDE). Default negative: "nsfw, worst quality, bad anatomy, watermark, jpeg artifact".
- Weights, pinned at Comfy-Org/MOSS-Image @ 530a4c94f92c35ef6818b1b035a983fe9dcf5f54: `diffusion_models/moss_image_sft_int8_convrot.safetensors` (5.414 GB), `text_encoders/qwen3.5_9b_w4a8_gptq.safetensors` (7.344 GB), `vae/flux2-vae_small.safetensors` (0.250 GB): 13.01 GB in all. Optional Fast tier: Spectrallic/MOSS-Image-SFT-8step-DMD-int8-convrot @ 8fdeb392c6322418687fc2519a7958c954497a22 (`moss_image_sft_8stepdmd_int8_convrot.safetensors`, 5.414 GB, a drop-in UNET at 8 steps, CFG 1; Apache-2.0).
- Manifest: capability t2i, `limits.dimensionMultiple` 16, `maxWidth` / `maxHeight` 2048, `vramGb` 16 with a note that it is a guess, `license` "Apache-2.0 (MOSS-Image SFT, Qwen3.5-9B, FLUX.2 small decoder)", notes on the cu130 PyTorch build that comfy-kitchen's int8 / w4a8 kernels need (`comfy/quant_ops.py` L22-28).
- MOSS is native in Fuobe's pinned ComfyUI (`fc04da91`), so `node validate-workflows.mjs moss-image-t2i` can run `/prompt` validation on the library's CPU ComfyUI. A real render needs a GPU.
- Do not install the LinXce pack or OpenMOSS's loader pack (§4.6: the LinXce node id collides with core's).

Cloud engine (§4.7).
- Make `scripts/gen-cloud-models.py` read `docs/research/new-models-7.json` -> `endpointRecords` (the two fal MOSS records, in the same shape as `paid-model-apis-4.json` `endpoints`) the way it reads RESEARCH_4.
- `model("moss-image", "MOSS-Image", "OpenMOSS", "moss", "image", ...)` with route t2i on `fal-ai/moss-image`; LoRAs through `fal-ai/moss-image/lora` (`loras` <= 3 of {path, scale 0-4}) using Fuobe's existing LoRA plumbing. Pricing unit megapixel, $0.05. The `/lora` price is unpublished ("$0 per compute second" on the page): show it as unknown, never as free.
- FieldMap: prompt, negative_prompt, `size` {key `image_size`, multiple 16, min 512, max 2048}, num_images (1-4), seed, num_inference_steps, guidance_scale, output_format png. `enable_prompt_expansion` is false whenever the request carries a layout (`params.extra.layout`) and true (fal's default) for a plain prompt.
- Demo mode: the mock provider returns a placeholder image as for the other t2i models.

Licences as information (§4.5). Settings -> Models & licences rows (they come from the ModelDefs and the manifest): MOSS-Image SFT Apache-2.0; Qwen3.5-9B Apache-2.0; FLUX.2 small decoder Apache-2.0 (byte-identical to BFL's FLUX.2-small-decoder); the fal endpoint as a paid API (fal's safety checker returns black images for flagged outputs). Everything starts on.

Tests.
- `tests/layout-prompt.test.ts`: the five vectors of §4.2 (1024 x 1024: [128,96,896,224] -> [-416,-384,-288,384], [128,288,896,640] -> [-224,-384,128,384], [288,800,736,864] -> [288,-224,352,224]; 1536 x 1024: [176,224,800,864] -> [-288,-592,352,32]; LinXce's [-240,160,-64,640] and [-241,159,-63,641] cases from `tests/test_layout.py`); zero items -> caption; key order; Chinese text kept unescaped; decode round trip at another key order; every parser case; validation messages; each other compiler's output.
- A library test (new `tests/comfy-library-7.test.ts` or the existing library test): the manifest entry's bindings, limits, model pins and sizes.
- A catalog test: the `moss-image` payload against `endpointRecords` (image_size object at multiples of 16 clamped to 512-2048; expansion false with a layout; the megapixel price for 1024 x 1024 and 1536 x 1024).
Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Image studio's model picker lists MOSS-Image on both engines with its price ($0.05 per megapixel in the cloud; "on your GPU, about 13 GB of files" on the open engine), and Settings -> Models & licences shows the new rows with switches.

What can't be verified here: no GPU (no real render, VRAM, speed or text accuracy); no fal key (payloads are checked against the schema only). Say both in the PR.

### 5.3 N7-2 · Layout mode in the Image studio, Edit layout on results, Import and Export

_Priority P0 · effort large · depends on N7-1 · key `n7-2-layout-mode` · research §4.2, §4.9, §4.10, §4.11_

Goal. Let people draw boxes where they already write prompts. The Image studio composer gets a "Layout" chip next to the sketch tools, the same way the Video studio has Frames mode. Each box gets one row (Object / Character / Text, what it looks like, the exact words). Results can be reopened as boxes. Research: new-models-7.md §4.10 rows 3-5, §4.2, §4.11.

Where it lands (exact spots).
- `src/lib/studios.ts` L6 `IMAGE_STUDIO`: `layout: true`.
- `src/components/studio/studio-context.tsx`: `StudioConfig.layout?: boolean`, next to `frames` (L71).
- `src/lib/composer.ts`: `enterLayout` / `layoutRequest` / `leaveLayout`, mirroring `enterFrames` / `framesRequest` / `leaveFrames` (L541 / L553 / L579).
- `src/components/studio/composer.tsx`: the chip, the draft in composer state, the request (`params.extra.layout` = the neutral draft from N7-1) and Reuse.
- New `src/components/studio/layout-editor.tsx`, built from `src/components/studio/sketch-editor.tsx`'s dialog pattern and the box maths in `src/lib/layers.ts` (`rectFrom` L655, `resizeBox` L617).
- The plan: `src/lib/catalog/plan.ts` compiles the draft once the render size is known. Open: the size from `computeDimensions` (`src/lib/comfy.ts` L233) and the manifest's `dimensionMultiple` (`src/server/providers/comfyui.ts` L905). Cloud: the size from `sizeValue` (`src/lib/catalog/payload.ts` L101). The plan writes the compiled prompt plus the exact width and height the model will render.
- `src/server/generations.ts` L1129-1137: never run the prompt enhancer on a layout request.
- `src/lib/output-actions.ts`: an "Edit layout" action.

UI.
- A canvas preview in the chosen aspect ratio. Drag to draw a box; numbered tabs; select, move, resize; Delete removes a box; arrow keys nudge it; clicking the same spot in an overlap cycles through stacked boxes (as LinXce's editor does).
- The rows: a segmented label (Object / Character / Text), "What it looks like", "Exact words" (required for Text, with an inline error), an optional colour. The composer's prompt box becomes the summary caption. A canvas type (Single / Panels / Collage) and optional tags.
- Desktop: rows beside the canvas. At 390 px: the canvas on top, rows in a bottom sheet, boxes still draggable by touch.
- Import / Export menu (browser only): import a LinXce draft, a compiled MOSS prompt (decoded against the current canvas), a legacy scene prompt or ComfyUI `CreateBoundingBoxes` elements; copy the compiled prompt or the draft.
- Model list: models that read boxes come first with a small "Reads boxes" badge (MOSS-Image, FLUX.3, Ideogram 4.5); any other model shows one line: "This model reads the layout as words, not exact positions."
- A warning when the render size would exceed 2048 px a side or 4 MP.

Engines.
- Open: `oss-moss-image` (N7-1) with the compiled prompt and exact width/height.
- Cloud: `moss-image` on fal with `enable_prompt_expansion: false` and `image_size: {width, height}` equal to the canvas; `flux-3` and `ideogram-4-5` with their own compilers and their prompt expansion off; other models get `compileWords`.

Edit layout on results.
- Shown when the generation has `params.extra.layout`, or when it is a fal MOSS output with `actual_prompt` (decode it with `decodeMoss` at the image's own width and height, so even a plain-prompt render becomes an editable layout).
- Opens the Image studio in Layout mode with the draft and the same seed.

Tests: the composer helpers (enter, leave, request); the plan compiles at the exact size for an open model (multiple 16) and for fal (clamped 512-2048, min respected); `enhancePrompt` is ignored for a layout request; the Edit layout action appears only when it can work; decode from a stored `actual_prompt` fixture; Reuse round trip. Extend the repo's composer e2e script with drawing one box and submitting in demo mode.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: drawing, moving and resizing boxes with mouse and touch; the rows sheet at 390 px; Import / Export; Reuse; Edit layout from a feed tile; the warning line.

What can't be verified here: real MOSS / FLUX.3 / Ideogram renders and how well they follow the boxes (no GPU, no fal key); use demo mode. Layout prompts are "Experimental" per MOSS's own guide: say so in the mode's hint.

### 5.4 N7-3 · Regenerate in 2K: an open finishing step in Upscale, on result tiles and in Canvas

_Priority P0 · effort large · depends on none · key `n7-3-regenerate-2k` · research §2.1, §2.2, §2.3, §2.4, §2.5, §2.6, §2.7, §2.8, §2.9, §2.10_

Goal. Make Open-H3-Regenerate-2K a finishing step people reach from places they already use: Upscale -> Video ("Regenerate · creative" beside SeedVR2 "Restore · faithful"), a "Regenerate in 2K" action on video results, and the Canvas Upscale node. The open engine runs NVIDIA's recipe; the cloud uses the honest hosted analogues because nobody hosts the open model. Research: new-models-7.md §2.

Open engine.
- Install (§2.6): an opt-in `OPEN_H3_REGEN=1` block in `scripts/comfy/install-comfyui.sh` (next to the H3 blocks at L63-94) that clones rdh9616/ComfyUI-Open-H3-Regenerate @ 9b686c5ffd380e9d1351f9b8beef6d20d703ca3e (Apache-2.0) and LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler @ 40316cf008b2fd8663263270669eb4da23f89d2c (MIT) into `custom_nodes`. The rdh pack needs `av` and `safetensors`, which ComfyUI's own requirements.txt already installs (`av>=17.0.0`, `safetensors>=0.4.2`), so nothing goes into the union line. Never install the packs on the library's validation server.
- Weights (§2.4), pinned in `scripts/comfy/library.spec.mjs`: `loras/open_h3_regenerate_2k_lora.safetensors` (12,452,449,080 B, SHA-256 8e36a0912ab72f7f3b00f41e3c7c97c7dfdec21e66c88ab22f08b9b0c681bb04) and `vae/fast_h3_vae_noncausal_24l.safetensors` (6,471,256,328 B, 8658f1e85b5997c4ba716406a2f148bfa36cf97d4d5fcd402c7bd341f54e77a1) from Efficient-Large-Model/Open-H3-Regenerate-2K @ 5809c33730c18b6b1c827b40974855a4288641b3; `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` (690,592,992 B, 4f57821f5837f32f7142b67d815606dbd7550f194e5c769f7d6c3f83b146a5e6; same bytes as LBH-123-AI/Minimax_h3_latent_Upscaler @ 3f941d5d); `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` (20,970,379,616 B, Comfy-Org/MiniMax-H3 @ 1c41cfca8ebba91d0af792a05c5761fb2c3a7975). Reuse the already pinned Qwen3-VL encoder, video and audio VAEs and the ref2va file (the pack reads only its 32 KB `adaln_t_table`). Skip `sharp_curve_branches.safetensors`: its tensors are zero in the blocks checked (§2.3).
- Graph `video-regenerate-h3` (§2.6 table): rdh's "Draft Video" example without the note, the three PreviewAny nodes and `OpenH3VideoToPrompt` (CLIPTextEncode 16 gets the prompt directly), `curve_name` "none", and `OpenH3SaveRefinedLatent` (24) kept so a failed decode can be redone from the saved latent. Bindings: video (9.file), prompt (16.text), resolution (17), draftSize (11.size), frames (11.max_frames; nodes 24 and 26 read 11's frame-count output), startSigma (19.start_sigma), steps (19.steps), seed (20), filenamePrefix (28). The combo values are strings exactly as the pack lists them ('768p (1344x768)', '576p (1024x576)', 'keep (snap to 32)', '1080p ...', '2k (2560x1440)', '4k (3840x2160)'); copy them from the pack's INPUT_TYPES, not from this text.
- Manifest entry: capability `upscale-video`, `customNodes` with both pins, `vramGb` 48 with a note ("measured: about 3 min per 5 s at 2K on a 72 GB RTX PRO 5000; 22 s on a B200; a community run reached about 1080p on 32 GB with a lossy LoRA"), the licence text (§2.5), `validated: false` until it runs on a GPU box.
- ModelDef `oss-h3-regenerate` in `src/lib/catalog/models.ts` next to `oss-seedvr2` (L423): name "Open-H3 Regenerate", tagline "Redraws a soft clip at 1080p, 2K or 4K. Details may change; motion and layout stay." Resolutions 1080p / 1440p / 2160p (`VIDEO_UPSCALE_TIERS`, L42; 1440p -> "2k", 2160p -> "4k"), default 1440p. Controls: Creativity (Close = start_sigma 0.7, Balanced = 0.8 default, More detail = 0, the release 0.909) and Speed (3 steps, or "Faster" = 2 steps). Prompt required.
- Provider (`src/server/providers/comfyui.ts`): frames = round(seconds x 24), at most 360 per pass; clips over 15 s are split into 15 s parts and joined with the existing `video-concat-encoded` graph, with a seam note; the source sound is muxed back (the pack's Finish node keeps it). Draft preset: 768p for H3 sources (the generation's model is an H3 model or a Character swap), 576p for other models, 'keep (snap to 32)' for portrait and odd shapes.
- Prompt: the generation's own prompt when there is one; for uploads, a one-paragraph description written by Fuobe's existing reading route (`oss-reference-brief` on the open engine, the text LLM with frames in the cloud), editable before running. No server is called from inside the graph.

Cloud engine (§2.7).
- No hosted open model. In Upscale -> Video the "creative" choice on the cloud is `topaz-starlight` (exists) plus Topaz creative (Astra 2, `topaz/upscale/video/creative`, already recorded in `docs/research/paid-model-apis.json`; add a `model(...)` line in `scripts/gen-cloud-models.py`): 10 s at 30 fps costs $3.00 up to 1080p, $5.00 at 4K.
- "Regenerate in 2K" on a fal H3 result (the `minimax-h3` model, the cloud Character swap): re-run the same endpoint with the same inputs and seed and `resolution: "2K"` (or "4K"); label it "Re-render at 2K · a new render" with its price ($0.13/s plain H3, $0.1625/s on the LoRA route; 4K $0.16 / $0.20). Other cloud results: SeedVR (faithful, $0.001 per output megapixel) or Starlight.
- MiniMax's closed `/v2/video_regeneration` and Comfy's partner node are not built here (they need unmodified H3 768P outputs and the exact post-Context-IR prompt); record them in the research only.

Placements.
- `VIDEO_UPSCALE_STUDIO` (`src/lib/studios.ts` L129): the open model list shows SeedVR2 "Restore · faithful" and Open-H3 "Regenerate · creative" side by side.
- `src/lib/output-actions.ts` L150: "Regenerate in 2K" next to "Render this draft in 1080p" for finished video results (and in next-step chips for H3 / LTX / Wan / SANA videos), opening Upscale -> Video prefilled with the clip, its prompt and 2K.
- `src/lib/catalog/canvas.ts` L230 / L348: the Upscale node gets a "Regenerate (creative)" choice (open `oss-h3-regenerate`, cloud `topaz-starlight`).

Copy. "Regenerate · creative: redraws your clip at 2K. Details may change; motion and layout stay." "Restore · faithful: keeps every detail and sharpens it." GPU line: "About 3 minutes per 5 s at 2K on a 72 GB GPU. Needs about 40 GB of new files (OPEN_H3_REGEN=1 in install-comfyui.sh)." Blocker without the packs: "Your ComfyUI is missing the Open-H3 Regenerate nodes: run scripts/comfy/install-comfyui.sh with OPEN_H3_REGEN=1."

Licences as information (§2.5): rows for the merged LoRA (MiniMax H3 Community: territory excludes the US, EU, UK and Republic of Korea; show "MiniMax H3"; over US$20M needs MiniMax's OK; plus Comfy's note that local commercial output needs a MiniMax licence; the merged Turbo part is Apache-2.0 at 3ec17a3, the LMS part has no stated licence), the fast VAE and the FL2VA base (MiniMax H3 Community), the LBH upscaler (weights Apache-2.0, code MIT), and `NODE_PACKS` entries in `src/lib/licences.ts` L406 for both packs. All start on.

Tests: manifest bindings (string combos, frames on node 11 only, curve none, start sigma, steps, node 24 kept); the tier -> combo map; window split for 5 / 15 / 20 / 40 s; the draft preset by source; the ModelDef and its controls; output-action presence per source and engine; the cloud re-render payload (same seed and inputs, resolution "2K") and its price; install-script pins.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: Upscale -> Video with both open choices and the Creativity control; the price and GPU lines; the "Regenerate in 2K" menu item on a feed tile and in the Library viewer; the Canvas Upscale choice.

What can't be verified here: any GPU run; whether the rdh pack loads on Fuobe's pinned ComfyUI 0.41.0-7 (tested on 0.42.0); whether Fuobe's ref2va base would do instead of FL2VA; VRAM below 72 GB; any fal call. Validate on a disposable GPU ComfyUI with the packs installed (`node validate-workflows.mjs video-regenerate-h3`).

_Note (since 2026-10-30, this overrules the cloud half above): the cloud has no Regenerate · creative and no stand-in for it (not `topaz-starlight`, not Astra 2); Regenerate is GPU-only, says so on the cloud engine and is hidden in "Paid APIs only"; the Canvas choice is disabled on the cloud. Only the fal H3 re-render at 2K / 4K stays. Topaz Astra 2 may be added under its own name._

### 5.5 N7-4 · Character swap in 2K: Swap Studio's Finish and Genjutsu's Quality

_Priority P0 · effort medium · depends on N7-3 · key `n7-4-character-swap-2k` · research §2.1, §2.6, §2.7, §2.9, §2.10, §2.11_

Goal. Character swaps come back at H3's 768p. Turn Character Swap Studio's dead "Finish" panel into a working "Sharpen to 1080p / 2K / 4K", and let Genjutsu's Character swap offer 1080p, 2K and 4K, on both engines, without touching the background or the sound. Research: new-models-7.md §2.10 rows 4-5, §2.11.

Where it lands (exact spots).
- `src/components/swap-studio/stage-review.tsx` L247-248 (the Finish panel in `AssembleStage`, L174): two cards. "Sharpen to 1080p / 2K / 4K" (runnable: resolution segmented control, price or GPU time, Run). "Clean backplate + alpha" (still Not available, keeping `FINISH_UNAVAILABLE`, `src/lib/catalog/swap-studio.ts` L1356).
- `src/lib/catalog/swap-studio.ts` / `swap-studio-plan.ts`: a finish plan per chosen take.
- `src/lib/catalog/character-swap.ts`: qualities (L27), `characterQuality` (L160), `falResolution` (L172), prices; `src/lib/catalog/genjutsu.ts`: the plan steps.

Open engine.
- Per chosen take: its 16-bit FFV1 master (already kept by `video-character-swap-h3-segment`) -> `video-regenerate-h3` (N7-3) with draftSize 'keep (snap to 32)' (H3's own canvas, any shape; n7-3 found the pinned pack's upscale always targets 16:9 or 9:16, so 'keep' stretches other shapes: use the preset, which cover-crops), the take's prompt, start_sigma 0.8 (rdh: "stays closer to the draft"), the take's seed, and a resolution capped at the source clip's size (never above the source).
- Then a mask composite, so only the character comes from the regenerate: a new core-node graph `video-composite-mask` (LoadVideo source + LoadVideo regenerated scaled to the source size with ImageScale + the approved whole-shot mask from `video-mask-h3-relay` -> ImageToMask (red) -> GrowMask -> FeatherMask -> ImageCompositeMasked -> CreateVideo with the source audio -> SaveVideo). Validate it on the library's CPU ComfyUI (core nodes only).
- Then the existing assembly. Takes over 15 s run in 15 s windows.
- Genjutsu Character swap: keep the 768p swap and add steps to the plan: swap -> regenerate (σ 0.8) -> mask composite -> mux.

Cloud engine.
- There is no hosted post-hoc regenerate. Re-queue the chosen segments on fal `minimax/h3/reference-to-video/lora` with the same prompt, LoRA, references and seed and `resolution` "2K" or "4K" ($0.1625/s or $0.20/s instead of $0.075/s at 768p). They are new takes: show them beside the 768p take for approval (Swap Studio already has takes and comparisons).
- Watch the cloud assembly: `cloudFilmSize` (`swap-studio.ts` L403-411) keeps fal merge-videos' 512-2048 px, so a 2K or 4K take is joined at no more than 2048 px on the long side. Say "joined at 2048 px" or offer 2K only where the join keeps it.
- Genjutsu: `falResolution` returns "2K" / "4K" for those qualities; prices 5 s at 2K = $0.81, 15 s at 2K = $2.44. H3 Max Recast stays at 768P / 1080P.
- Fallback for an already assembled film: SeedVR or Topaz creative (N7-3).

Copy. Sharpen card: "Redraws each chosen take at 2K, then puts only your character back over the original footage. The background and the sound stay as filmed. Faces can change slightly; compare before you keep it." Genjutsu Quality hint: "2K and 4K redraw the 768p swap at the higher size."

Licences: the MiniMax H3 rows already exist for the Character swap; N7-3 adds the regenerate files. "MiniMax H3" stays displayed where H3 runs.

Tests: quality mapping (480p / 768p unchanged; 1080p / 2K / 4K add the finish step); `falResolution` for every quality; the price table; the finish plan per take (regenerate -> composite -> assemble) with the resolution capped at the source; `video-composite-mask` bindings; the cloud re-queue payload; the 2048 px join note; `FINISH_UNAVAILABLE` still shown for the backplate card.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: Swap Studio's Assemble stage with the two Finish cards; Genjutsu's Quality picker with 2K / 4K and their prices.

What can't be verified here: GPU runs; whether σ 0.8 keeps the swapped identity; how the mask edge looks at 2K; any fal call. Add eval cases (scripts/eval) that compare identity (face similarity to the character) and background difference against the source, so a GPU run can decide the default σ.

**Corrections from building it (2026-11-01).** (1) The segment's FFV1 master keeps only the take's last frames (`masterKeep`, the next segment's history), so the regenerate reads the take's own video, not the master. (2) fal's H3 resolution enum is 480P, 768P, 2K and 4K: there is no 1080P, so the cloud offers 2K and 4K (Genjutsu's 1080p on the cloud stays the 768P swap). (3) Both engines join the film at no more than 2048 px a side (the open engine's 24 fps copy and fit graph, fal merge-videos), so "capped at the source" means capped at that size: a 1080p clip sharpens at 1080p on your GPU, and the cloud's 4K adds nothing to such a film. (4) The regenerate keeps a 16:9 (or 9:16) centre of the take, so the composite lays two layers through the mask: the 768p swap over the part of the footage its canvas covers, then the regenerate over the centre its draft kept; a character reaching past that centre keeps the 768p swap there rather than the original person. (5) The composite decodes four streams as float32, so it runs in windows of at most 3 s, joined packet by packet. (6) Main's copy polish (157e5ba2, 2026-11-01) removed the old not-available Finish panel; the backplate card is back for the owner only.

### 5.6 N7-5 · Fly path in Cinema's 3D scene, and the camera-path library

_Priority P0 · effort large · depends on none · key `n7-5-fly-path` · research §3.3, §3.6, §3.7, §3.9, §3.10, §3.11_

Goal. People already fly a camera through Cinema's 3D scene and capture one still. Let them keyframe a path (or pick Orbit 360°, Arc, Push-pull arc, Tilted ring, Figure-8, Dolly in / out) and press "Film this path" to get a 5 s move that follows it exactly. The cloud uses fal's H3 Max camera-controls; the open engine uses a Uni3C render-guided Wan 2.1 graph on core nodes. This package also ships the camera-path library that N7-6, N7-7 and N7-9 reuse. Research: new-models-7.md §3.3, §3.6, §3.7, §3.10 row 1.

The library: `src/lib/camera-path.ts` (pure) + `tests/camera-path.test.ts`.
- `CameraKey { t (0-1), azimuth (degrees, unwrapped, signed), elevation (degrees), distance (1 = the photo's own) }`.
- Presets named after WorldCast's (`scripts/data/trajectories.py`, re-implemented, not copied): orbit_360; orbit_N clockwise / counter-clockwise; orbit_tilt_20; orbit_180_push (radius ripple 25%, 2 waves); lemniscate; zoom_in (0.6x); zoom_out (1.5x); truck left / right. Every path starts at the photo's own pose (t 0, azimuth 0, elevation 0, distance 1).
- `fromScenePose` / `toScenePose` using `scenePose` (`src/lib/scene3d.ts` L555-575): azimuth = horizontal unwrapped along the path; elevation = vertical; distance proportional to 2^(-(zoom - 5) / 5), the inverse of its zoom formula.
- `toH3MaxTrajectory(keys)`: 2-12 keyframes {time 0-1, azimuth (signed, at most 32 turns), elevation clamped -90..90, distance > 0}; trucks become `free_camera_preset`.
- `framePoses(keys, frames, pivotDepth, fovDeg)`: per-frame camera-to-world matrices (OpenCV, +Z forward) looking at the pivot (`medianDepth`, `scene3d.ts` L208) plus a pixel intrinsic: for the browser render now and WorldCast (N7-9) later.

Cloud engine.
- Add `minimax/h3-max/camera-controls` as a route on the existing `minimax-h3-max` model (or a hidden helper model) with a `model(...)` change in `scripts/gen-cloud-models.py`; the endpoint record is already in `docs/research/paid-model-apis-2.json` (L23027-23156). Do not use the legacy alias `minimax/h3-max/multi-angle/image-to-video`.
- Payload: `image_url` = the scene's source photo; `camera_trajectory` from `toH3MaxTrajectory`; `prompt_expansion_mode` "disabled"; `prompt` always sent (the endpoint's default prompt freezes the scene): the user's motion words, defaulting to "The character keeps moving naturally while the camera follows the path"; `duration` 5 (1-15); `resolution` 768P default (480P / 1080P); `seed`.
- Prices (fal, 2026-10-29): $0.0325 / $0.052 / $0.104 per s at 480p / 768p / 1080p until 2026-10-31, then $0.05 / $0.08 / $0.16. Show the price that applies on the run date.

Open engine.
- Graph `wan21-i2v-uni3c-path` (§3.6 table), core nodes only: UNETLoader (Wan 2.1 I2V) -> ModelPatchLoader `Wan21_Uni3C_controlnet_fp16.safetensors` -> WanUni3CControlnetApply (render_video, strength 1, 0-1) -> CLIPLoader umt5 fp8 (type wan) / CLIPVisionLoader clip_vision_h / VAELoader wan_2.1_vae -> WanImageToVideo (81 frames) -> KSampler -> VAEDecode -> CreateVideo (16 fps) -> SaveVideo. Bindings image, video (the path render), prompt, negativePrompt, width, height, seed, steps, strength, filenamePrefix.
- Weights: `model_patches/Wan21_Uni3C_controlnet_fp16.safetensors` (1,997,314,376 B, Kijai/WanVideo_comfy @ 8260d429d19fd7a72304cad059160b95d843913f). First test the Wan 2.1 I2V 480p Q8 GGUF Fuobe already pins (`library.spec.mjs` L160); if Uni3C needs the 720p model, pin `split_files/diffusion_models/wan2.1_i2v_720p_14B_fp8_scaled.safetensors` (16,401,356,938 B, Comfy-Org/Wan-2.1 @ 123acf1cc74bccbb9bfff8ac1ee72edc08c2341d). The encoder, CLIP vision and VAE are already pinned.
- `/prompt` validation on the library's CPU ComfyUI is possible (core nodes); runs need a GPU (Uni3C's own figures: 46-51 GB with offload; Fuobe's older 24 GB note is unverified).
- The render: `src/components/cinema/scene-engine.ts` gains `recordPath(poses, { frames: 81, fps: 16, width, height })`, which renders each frame of the MoGe mesh or point cloud along `framePoses` with a transparent clear and encodes `render.mp4` (MediaRecorder, as `src/components/model3d/turntable.ts` does, or frame-by-frame), plus a hole mask from the alpha (unused by core's Uni3C node, kept for N7-9).

UI.
- `src/components/cinema/scene-viewer.tsx`, beside Capture (L224-245): a "Path" strip with "+ Keyframe" (adds the current pose), preset chips, one chip per key ("1.2 s · 90° · +10° · 1.2x"), a Preview button that flies the viewer's camera along the path, a duration (5 s default), a motion-words field and "Film this path". At 390 px the strip folds into a sheet.
- `src/lib/catalog/cinema.ts`: a `path` action next to Recompose (`planRecompose`, L1914): cloud -> camera-controls; open -> upload the render, then the Uni3C graph. The result lands next to the scene as a new take.

Licences as information: Uni3C (Apache-2.0; Kijai's repo has no licence field), Wan 2.1 I2V (Apache-2.0), fal H3 Max camera-controls (paid; MiniMax's and fal's terms).

Tests: presets -> keys (orbit_360 gives 5 keys 0..360; arcs signed; tilt; push distances; zooms); `toH3MaxTrajectory` limits and clamps; `framePoses` (frame 0 equals the photo pose; orthonormal; looks at the pivot); the scenePose round trip; the cinema `path` plan on both engines; the payload against the camera-controls record; the Uni3C manifest bindings.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Path strip, the chips, Preview, Film; the 390 px sheet; the Recompose and Capture buttons still work.

What can't be verified here: no GPU (Uni3C VRAM, loading Kijai's file through ModelPatchLoader, the 480p GGUF question, quality); no fal key. H3 Max's azimuth sign is not documented: put it behind one constant and flip it after the first paid test.

### 5.7 N7-6 · Turnaround video for cast sheets and characters

_Priority P0 · effort small · depends on none · key `n7-6-turnaround` · research §3.1, §3.3, §3.7, §3.9, §3.10_

Goal. WorldCast's promise is "one photo plus a few angles -> the camera flies around the character, and the back and sides look right". Fuobe can give most of that today with routes it already has: one click on a cast sheet or a saved character makes a 360° turnaround of the same person, on both engines. N7-9 later swaps the open engine for WorldCast itself behind the same buttons. Research: new-models-7.md §3.7 recipes (B) and (C), §3.10 row 2.

Where it lands (exact spots).
- The Character Sheet page result (`src/app/(studio)/character-sheet/page.tsx`; `src/components/fashion/character-sheet.tsx`, the "Front, three-quarter, profile and back views" result near L320) and Cinema's Soul Cast results: a "Turnaround video" button.
- A character's Elements page (`src/app/(studio)/elements/[id]/page.tsx`): "Fly around this character" (pick the hero photo and, once N7-5 lands, a path preset; otherwise Orbit 360°).

Views. One function `viewAzimuth(side)` with tests: front 0°, right 90°, back 180°, left 270°, using the subject's own left and right like Image to 3D's side picker (`src/lib/av/model3d.ts` L81-88). Order the views front -> right -> back -> left -> front. Write down WorldCast's convention for N7-9 (its left_side sits near 267° with `left_sign` -1).

Open engine.
- Frames mode's existing chain (`createKeyframeFilm`, `src/server/chains.ts` L197; `FRAMES_MODELS.open` = `oss-wan22-14b`, `src/lib/catalog/keyframes.ts` L58) with the views at t 0 / 0.25 / 0.5 / 0.75 / 1.0 and a fixed orbit prompt ("The camera orbits 360 degrees around the person at a constant height; the person stands naturally").
- Missing views come from the Angles app's open route (`src/lib/catalog/apps.ts` L265-302) at horizontal 90 / 180 / 270.
- Optional: the pinned MiniMax H3 ref2va route with the sheet as <Picture> references and an orbit prompt (territory-restricted licence; information only).

Cloud engine.
- Three or more views: `minimax-h3-max` op `ref2v` (`minimax/h3-max/reference-to-video`, already in the catalog at `cloud-models.generated.ts` L6244) with the views as Image 1..n and an orbit prompt: 5 s at 768P with up to four square references is $0.40.
- Or FLUX 3 Max keyframes-to-video (`flux-3-max`, Frames mode's cloud model) with the views as keyframes spread over the duration: $0.0425/s on the promo until 2026-11-07, then $0.17/s at 720p.
- Missing angles: `qwen-multiple-angles` ($0.035 per megapixel).
- Only a hero photo: H3 Max camera-controls with Orbit 360° when N7-5's route exists; otherwise ref2v with one image.

Consent. "Fly around this character" on a real person follows Soul ID's consent line (`SOUL_ID_COPY`, `src/lib/catalog/training.ts`); WorldCast's own ethics statement warns about impersonation.

Tests: `viewAzimuth` and the ordering; the plan per engine and per view count (1-5 views, with and without fills); prices; the ref2v payload (`reference_image_urls` <= 9, fal's schema; 12 files in all with videos and audio; the prompt names Image N); the keyframe-film request for the open engine.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the button on the Character Sheet result, on Soul Cast results and on an element's page; the price or GPU line; progress; the result in the feed.

What can't be verified here: GPU runs and paid calls; how well identity holds around the back. Add an eval suite (`scripts/eval/cases`) with ArcFace similarity of sampled frames to the sheet's views, so a GPU / key run can pick the default route.

### 5.8 N7-7 · Exact orbits in DoP, Cinema moves, Image to 3D and Canvas

_Priority P1 · effort medium · depends on N7-5 · key `n7-7-exact-orbits` · research §3.3, §3.6, §3.7, §3.10_

Goal. Orbits are already a pick in Fuobe DoP, Cinema's Director and Image to 3D, but they follow a LoRA's or a prompt's idea of an orbit. Add an "Exact" switch so the move follows numbers: degrees, direction, height tilt and a radius pulse, on both engines, reusing N7-5's library, cloud route and Uni3C graph. Research: new-models-7.md §3.10 rows 3-5.

Where it lands (exact spots).
- Fuobe DoP / Motions: the Orbit category (`src/lib/catalog/motions.ts` L94-102; `src/app/(studio)/motions/page.tsx`): an "Exact" switch on 360 Orbit, Arc Left, Arc Right and Lazy Orbit with degrees (30-360), direction (clockwise / counter-clockwise seen from above), tilt (0-20°) and pulse (none / 25%).
- Cinema's Director: the orbit moves (drone-orbit L363, arc-left L370, arc-right L372, bullet-time L367 in `src/lib/catalog/cinema.ts`; `CINEMA_CAMERA_LORA` is null for them, L606-615): the same switch in the move picker (`src/components/cinema/camera-moves.tsx`).
- Image to 3D (`src/app/(studio)/image-to-3d/page.tsx`; `src/lib/av/model3d.ts`): "Film it photoreal" next to "Animate the spin".
- Canvas (`src/lib/catalog/canvas.ts` `NODE_SPECS` L221): a "Camera path" node (preset or keys) and a "Fly around" node (image + optional views + path -> video).
- Assist / MCP: a `fly_around` tool (`src/server/assist/studio-tools.ts`).

Open engine.
- Automatic depth with the 3D scene's model (`oss-scene-moge`, MoGe 2, MIT) -> the browser point cloud (`buildPointCloud`, `src/lib/scene3d.ts` L414) -> N7-5's `recordPath` along the preset -> `wan21-i2v-uni3c-path`.
- Image to 3D: record the TRELLIS.2 / TripoSplat result along the path as the render instead of a point cloud.
- Canvas and Assist run without a browser view, so they need a server-side render. Option A: pin Camera H3 Bruxos (NyckM/3d-Camera-control-H3-Minimax @ 36c4218a2561328436d440fa9134631ee515471b, Apache-2.0, no Python dependencies) and use `BruxosH3Camera` Depth Warp from core `MoGeInference`; its output is Meridian-shaped (73 / 90 / 107 / 124 ... frames at 24 fps, grey-128 holes), so resample to 81 frames at 16 fps and turn grey holes black. Option B: a small headless point-cloud renderer in Fuobe's server. Pick after a `/prompt` validation of option A on the CPU server.
- The ostris Wan 2.2 orbit LoRAs stay as the "Loose" choice.

Cloud engine. H3 Max camera-controls (N7-5) with the preset as keyframes; with reference views (Canvas "Fly around" with views), `minimax-h3-max` ref2v or FLUX 3 Max keyframes as in N7-6. 5 s at 768P = $0.40 at list price.

Tests: Exact settings -> keys; the DoP plan, the Cinema plan with Exact on both engines, the Image to 3D plan; Canvas node types, ports and outputs; the Assist tool schema; (if option A) the Bruxos pin in `install-comfyui.sh` and its licence row in `NODE_PACKS`.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Exact switch and its controls on the Motions page and in Cinema's move picker; "Film it photoreal" in Image to 3D; the two Canvas nodes.

What can't be verified here: GPU runs and paid calls; whether the Bruxos pack loads on Fuobe's pin.

### 5.9 N7-8 · Layouts in Canvas, Marketing, Ads and Assist

_Priority P1 · effort medium · depends on N7-1, N7-2 · key `n7-8-layouts-everywhere` · research §4.3, §4.9, §4.10_

Goal. Everything in Fuobe that already knows where things go on a canvas can produce a layout: Canvas pipelines, Marketing Studio's formats, Ads Studio's planned rectangles, and Assist. Research: new-models-7.md §4.10 rows 6-8.

Where it lands (exact spots).
- Canvas: a "Layout" node (`CanvasNodeType` "layout" at `src/lib/catalog/canvas.ts` L44; `NODE_SPECS` L221 in the Inputs group; `outputType` L570 returns text; `sourceOf` L814 compiles the draft for the downstream model at that node's render size with N7-1's `layoutCompilerFor`). A card in `src/components/canvas/nodes.tsx` with a mini box preview and "Edit layout" (N7-2's editor). With a Table node upstream, `{Column}` placeholders in text items fill row by row before compiling: one layout, a batch of posters.
- Marketing Studio: `wordsOnTop` (`src/lib/catalog/marketing.ts` L962) is true on every open-engine run today. Add a format option "Words drawn by the model" that turns the format's copy rectangles into a layout (headline, price and button as text items; logo area and product as object items) and renders it with `oss-moss-image`. Browser compositing stays the default because it gives exact fonts.
- Ads Studio: `planAd` (`src/components/ads/layout.ts` L246) already returns the rectangles; map `AdPlan` -> a layout draft. With the new option, `visualRequest` (`src/server/ads.ts` L152) sends the layout instead of the `NO_TEXT` instruction (L150). Without it, a "keep clear" layout (only the product as an object item, the copy rectangles left empty) can keep the product out of the words' space.
- Assist: `skills/layout-poster/SKILL.md`, adapted from OpenMOSS's Apache-2.0 prompt-enhancer skill and its `references/layout.md` (keep the notice), plus a "Plan layout" button in N7-2's editor: Fuobe's text LLM writes a pixel draft from a sentence ("a sale poster for my candle shop, 30% off"); `validateLayout` checks it; the user adjusts it.

Engines. Open: `oss-moss-image`. Cloud: `moss-image` on fal, or `ideogram-4-5` / `flux-3` with their compilers, as "draws the exact text in place" choices (expansion off). Core `TextGenerate` on the MOSS encoder as the planner is unproven on Fuobe's pin (the think-block fix #17121 came later): don't use it yet.

Tests: `sourceOf(layout)` per downstream model and size; table substitution; the `AdPlan` -> draft mapping; `wordsOnTop` with the new option on both engines; the keep-clear layout; the skill file is picked up by Assist's skill loader; the planner's output passes `validateLayout`.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Canvas Layout node and its editor; the Marketing and Ads option and its hint; the Plan layout button.

What can't be verified here: how well MOSS-Image draws the copy (no GPU, no fal key); use demo mode and the eval harness later.

### 5.10 N7-9 · WorldCast on your GPU: the Fuobe Fly-Around Original's open half

_Priority P1 · effort large · depends on N7-5, N7-6 · key `n7-9-worldcast-worker` · research §3.1, §3.2, §3.4, §3.5, §3.6, §3.8, §3.11_

Goal. Put the real WorldCast behind the Fly path (N7-5), Turnaround / Fly around (N7-6) and Exact orbit (N7-7) buttons on the open engine, so the back and sides follow the user's own reference views. WorldCast has no ComfyUI port and needs custom DiT code, so the first step is a worker; a Fuobe node pack can follow if the quality is worth it. Research: new-models-7.md §3.1-§3.6, §3.8, §3.11.

The worker (§3.6 option 1).
- Contract in `docs/workers/worldcast.md`, written like `docs/workers/tribe-v2.md`: an HTTP service on the user's GPU, outside ComfyUI. `POST /cases` (multipart: first_frame.png, person_mask.png, render.mp4, render_mask.mp4, cam_info.json with 81 camera-to-world poses in OpenCV convention and a 3x3 pixel intrinsic, up to four anchors {side, image, mask, azimuth}, an optional anchors_aligned_camera_info.json, prompt, seed, steps 50, cfg 5.0, shift 2.0, height 832, width 480) -> a job id; `GET /jobs/{id}` -> status and progress; `GET /jobs/{id}/video` -> the MP4 (81 frames at 15 fps). A setting `WORLDCAST_URL` (Settings -> Open-source engine, beside the isolated worker URL).
- A thin reference server in `workers/worldcast/` that imports PixCtrol/WorldCast @ 7ccf2e0ded1238bf6dea1b285c29bcf322e337cb (Apache-2.0) in its own virtualenv (the README's verified combination: torch 2.8.0+cu128 with transformers 5.8.1). Review that code before running it. Weights: ly56/worldcast @ 27635f27a2f9414dd8b78542eb390b565a288a53 (`checkpoints/base_dit.safetensors` 8,401,611,192 B and `checkpoints/worldcast_bank.safetensors` 1,982,937,976 B; both from the same release) and Wan-AI/Wan2.1-I2V-14B-720P @ 8823af45fcc58a8aa999a54b04be9abc7d2aac98 (82.22 GB). Check it first on `demo_case_traj5.json`.

Fuobe prepares the case (permissive models only; the paper's Depth Pro and VGGT-Omega are research-only / non-commercial).
- Depth: MoGe 2 (MIT, the 3D scene's `oss-scene-moge`) or Depth Anything 3 metric-large (Apache-2.0, Comfy-Org/Depth-Anything-3 @ 8265be07).
- Masks: core `SAM3_Detect` with the pinned `sam3.1_multiplex_fp16`.
- Path: `framePoses` from N7-5's library; `render.mp4` / `render_mask.mp4` from N7-5's recorder (mask 0 = covered, 255 = hole).
- Anchors: the element's or sheet's views with azimuths in WorldCast's convention (front 0°, right_side about 90°, back about 180°, left_side about 270°, `left_sign` -1; N7-6 converts Fuobe's sides once, in `worldcastAnchor`, `src/lib/catalog/turnaround.ts`); anchor poses on a ring at the subject distance (a guess), or leave `anchors_aligned_camera_info.json` out (the code then skips anchor Plücker rays; quality impact unknown).
- The `no_padding_black/` crops are not documented: read them from `demo_case/` and `diffsynth/pipelines/worldcast_pipeline.py` L842-869 before building.

Fuobe side.
- An open ModelDef `oss-worldcast` routed to the worker. The three buttons prefer it when `WORLDCAST_URL` answers, and otherwise fall back to the Uni3C graph / Frames chain with a line saying so ("Runs on Uni3C: add a WorldCast worker (48 GB+) for sides that match your photos").
- Output is portrait 480 x 832 at 15 fps; offer RIFE to 24 fps and the existing upscalers after it.

Licences as information (§3.5): WorldCast weights Apache-2.0 with the note that Stage 1 trained on SpatialVID (CC BY-NC-SA 4.0) "strictly for academic research purposes" by the authors' statement; Wan 2.1 720P Apache-2.0; MoGe 2 MIT; DA3 Apache-2.0; SAM 3.1 SAM License. VGGT-Omega (FAIR-NC, gated) and Depth Pro (Apple research-only) only if a user opts in.

Tests: the case builder (files, shapes, matrix conventions, the side -> azimuth map); the worker client against a mock server (submit, poll, download, errors); the fallback line when no worker answers; the ModelDef's visibility.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the worker URL row in Settings; the three buttons' engine line with and without a worker.

What can't be verified here: everything on the GPU: at least 48 GB, an 82 GB base download, an unknown run time (20-40 min per clip on one 80 GB card is a guess), quality with DA3 / MoGe depth instead of Depth Pro, and quality without aligned anchor cameras.

### 5.11 N7-10 · Regenerate in Faceless, video segments and Cinema H3 shots

_Priority P2 · effort medium · depends on N7-3 · key `n7-10-regenerate-more` · research §2.6, §2.7, §2.10_

Goal. Once N7-3's regenerate graph exists, offer it in the three other places soft clips are finished: Faceless episodes, edited segments, and H3 shots in Cinema and the Video studio ("draft at 768p, finish only the keeper in 2K"). Research: new-models-7.md §2.10 rows 6-8.

Where it lands (exact spots).
- Faceless "Upscale to 1080p" (`src/lib/catalog/faceless.ts` L599-654): add "Regenerate to 1080p (sharper, may redraw)" on the open engine: per scene (<= 15 s) at 1080p, draft preset 576p, start_sigma 0.8, the scene's own prompt, then the existing join and music. ESRGAN stays the fast default; the cloud keeps `seedvr-video` (1080p, 121 frames ≈ $0.25).
- Edit video and Shorts segments: "Enhance (H3 regenerate)" on a selected segment of at most 15 s: 1080p, 576p preset, the segment's restyle prompt; Wan VACE output at 16 fps goes through the existing RIFE graph to 24 fps first. Cloud: `seedvr-video` or `topaz-starlight`.
- Cinema and the Video studio: "Finish in 2K" on an H3 take, and a 2K tier for H3 models (`VIDEO_RESOLUTIONS`, `src/lib/catalog/cinema.ts` L559, today 480p / 720p / 1080p). Cloud: re-render on fal `minimax/h3/*` at 2K ($0.13/s; LoRA route $0.1625/s). Open: a plain open H3 graph `video-h3-t2v-2k` from rdh's "Prompt to 2K" example (FL2VA pruned int8 + `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` from lightx2v/Minimax-h3-Turbo @ 3ec17a324ced54151364f24f8b5fb6bf7e26414f, 1,956,193,000 B; MiniMaxH3ImageToVideo; BasicScheduler simple 6; er_sde), saving the 768p latent so "Finish in 2K" later decodes from it (`OpenH3SaveRefinedLatent` / `OpenH3LoadRefinedLatent`, or NVIDIA's `--save-latents` ladder).

Licences: Turbo v1.2 is Apache-2.0 in its card at 3ec17a3 (the field is gone at main); the rest as N7-3.

Tests: Faceless plan per engine with the new option; segment length checks (<= 15 s) and the RIFE step; Cinema's 2K tier only for H3 models; the saved-latent hand-off bindings.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Faceless option, the segment action and Cinema's tier.

What can't be verified here: GPU runs, the 768p H3 draft graph, fal calls.

### 5.12 N7-11 · MOSS one-sheet storyboards, re-render from Layers, and painted colour / depth control

_Priority P2 · effort medium · depends on N7-1, N7-2 · key `n7-11-moss-sheets-control` · research §4.4, §4.6, §4.10, §4.11_

Goal. Three later uses of MOSS-Image's layouts, each in a studio people already use. Research: new-models-7.md §4.10 rows 9-11.

- Storyboard (`/storyboard`, `src/lib/catalog/storyboard.ts`): a "One sheet" option. `summary.canvas` "multi_panel", one item per panel with its shot caption; the browser crops the panels into frames afterwards. Open `oss-moss-image`; cloud `moss-image`. Quality on many panels is a guess: gate the option behind a GPU test result.
- Layers (`/layers`; `src/lib/layers.ts`, `src/server/layers.ts`): "Re-render from layers". Each visible layer's `rotatedBounds` box (L479) and name become object items; OCR lines (`src/lib/ocr.ts`) become text items; the result is one coherent repaint that matches the arrangement. Cloud alternatives: `ideogram-4-5`, `flux-3`.
- After a ComfyUI pin bump to >= v0.43.1 (`086099f5`; it requires `comfyui-workflow-templates==0.11.98` and a full library re-validation): the Sketch editor's draw mode feeds MOSS colour regions or a depth map through core `MOSSImageControl` with Comfy-Org's `loras/moss_image_color_depth_control` (0.313 GB, from darask0, Apache-2.0; its training depth maps came from Depth Anything V2 Large, CC-BY-NC-4.0: information only). No hosted equivalent: the cloud falls back to the box layout. Guess-level; needs a GPU test.

Tests: the multi-panel draft and the crop maths; layers -> draft (rotation bounds, OCR text items); the pin-bump checks (install script, manifest re-validation) if that part is taken.

Browser checks: at 1440 px and 390 px wide, in light and in dark theme: the new controls render, labels and prices fit, nothing scrolls sideways, keyboard focus reaches every new control, and touch dragging works at 390 px. Here: the Storyboard option, the Layers action, and (if built) the Sketch editor's colour-region mode.

What can't be verified here: render quality (no GPU, no fal key); the pin bump's effect on the rest of the library needs a full re-validation run.

### 5.13 What this machine can and can't verify

- **Can:** unit tests for every pure library; `/prompt` validation of core-node graphs on the library's CPU ComfyUI (`moss-image-t2i`, `wan21-i2v-uni3c-path`, `video-composite-mask`), because MOSS-Image, the Uni3C nodes and the compositing nodes are core at `fc04da91`; cloud payloads against the stored schemas (`endpointRecords`, `paid-model-apis*.json`); browser checks in demo mode.
- **Can't:** any GPU run (Open-H3 needs about 48–72 GB, WorldCast 48 GB+, Uni3C 46–51 GB by its own figures); `/prompt` validation of graphs that need the rdh / LBH / Bruxos packs (they must not be installed on this server); any paid call (no fal, Replicate, MiniMax or MOSI key). Each package says which of its claims wait for a GPU box or a key.

## Sources (read 2026-10-28 and 2026-10-29)

Open-H3-Regenerate-2K
- Project page: https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/
- Code: https://github.com/NVlabs/Sana/tree/sol-engine/models/Open-H3-Regenerate-2K at `6e4a44002149418a547434b91d7280a8bbdcace3` (sparse read-only clone at `/home/user/ext/sana-sol-engine`): README.md, infer.py, open_h3/pipeline.py, sigmas.py, upscaler.py, download.py, requirements.txt. Sol-H3-ComfyUI at the same commit (`/home/user/ext/sana-sol-h3-comfyui`).
- Weights: https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K at `5809c33730c18b6b1c827b40974855a4288641b3` (tree API with sizes and LFS SHA-256; README; lora_config.json; MERGE_VERIFY.json; NOTICE; latent_upsampler/LICENSE; LICENSE-Qwen.txt; safetensors headers and the `curve_B` tensors of blocks 0, 7, 10, 25, 37, 49 read by HTTP byte range).
- Kijai: https://huggingface.co/Kijai/MiniMax-H3-experimental at `f5c3b1d5a63e008a691fca1b6096fd57a5307536` (tree, commits `7afab6c` and `a671238`, README, safetensors metadata).
- rdh9616 pack: https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate at `9b686c5ffd380e9d1351f9b8beef6d20d703ca3e` (clone `/home/user/ext/comfyui-open-h3-regenerate`; history clone `/home/user/ext/rdh-history`): README.md, NOTICE, LICENSE, pyproject.toml, requirements.txt, `__init__.py`, `regen_core.py`, example_workflows/*.json.
- LBH: https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler at `40316cf008b2fd8663263270669eb4da23f89d2c` (clone `/home/user/ext/lbh-h3-latent-upscaler`); https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler at `3f941d5d182014dd5c0a5e16330420ee2d4aa0c6`.
- MiniMax H3: https://huggingface.co/MiniMaxAI/MiniMax-H3 at `6818f6c32d12b210915e44ad56a4228c2608f160` (LICENSE, README); https://huggingface.co/Comfy-Org/MiniMax-H3 trees at `1c41cfca8ebba91d0af792a05c5761fb2c3a7975` and `e5eb578a89295337b8ff433a035929ce0279e0b6`.
- LightX2V: https://huggingface.co/lightx2v/Minimax-h3-Turbo at `3ec17a324ced54151364f24f8b5fb6bf7e26414f` and main `30f485ed`. Alissonerdx: https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI at `fd3dde7b3ec1ae4e09fafc46f000bedcc2db219b` (`849fb3d4` → "Invalid rev id"). Community: father558/H3-Open-Regenerate-2K-ComfyUI-r128, DrakenZA/Open-H3-Regenerate-2K-ComfyUI at `f81f29e4`, 1038lab/Open-H3-Regenerate-2K. Efficient-Large-Model/Sol-H3-VAE at `6a8a33fc`; VideoRebirthAI/hyperflow at `5bde94d`; the Space hugging-apps/efficient-large-model-open-h3-regenerate-2k.
- Closed regenerate: https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration.md, https://platform.minimax.io/docs/guides/pricing-paygo.md (L266-276); Comfy's https://docs.comfy.org/tutorials/video/minimax/minimax-h3; `MinimaxHailuo03RegenerateNode` in the local `/object_info` and ComfyUI v0.43.1 `comfy_api_nodes/nodes_minimax.py` L1494-1640.
- Hosted: fal models API searches and OpenAPI for `minimax/h3/reference-to-video/lora` and `minimax/h3/image-to-video`; https://replicate.com/minimax/h3.

WorldCast
- https://pixctrol.github.io/WorldCast/; https://arxiv.org/abs/2610.33135 and the full HTML v1.
- https://github.com/PixCtrol/WorldCast at `7ccf2e0ded1238bf6dea1b285c29bcf322e337cb` (clone `/home/user/ext/worldcast`): README.md, requirements.txt, pyproject.toml, LICENSE, demo.py, scripts/infer/infer_worldcast.py, scripts/data/trajectories.py, scripts/data/anchor_views.py, diffsynth/pipelines/{camera.py, worldcast_pipeline.py}, diffsynth/core/vram/layers.py, demo_case/ (cam_info.json, body_views_meta.json, anchors_aligned_camera_info.json, camera_motion.json), demo_case_traj5.json.
- https://huggingface.co/ly56/worldcast at `27635f27a2f9414dd8b78542eb390b565a288a53` (API, tree, commits, README, both safetensors headers, a byte comparison of block 0 against Wan-AI shard 1).
- Wan-AI/Wan2.1-I2V-14B-720P at `8823af45`; Comfy-Org/Wan-2.1 at `123acf1c`; facebook/VGGT-Omega at `1041e80f`; apple/DepthPro at `ccd1350a` (LICENSE); depth-anything/DA3-* and Comfy-Org/Depth-Anything-3 at `8265be07`; Comfy-Org/sam3.1 at `7bb83747`; Kijai/WanVideo_comfy `Wan21_Uni3C_controlnet_fp16.safetensors` at `8260d429` (header); alibaba-damo-academy/Uni3C (README, LICENSE, cam_render.py).
- fal: `minimax/h3-max/camera-controls` (llms.txt and OpenAPI), `minimax/h3-max/multi-angle/image-to-video` (308 to camera-controls), `minimax/h3-max/reference-to-video`, `blackforestlabs/flux-3-max/keyframes-to-video`, `fal-ai/qwen-image-edit-2511-multiple-angles`, `fal-ai/marigold-v2`.
- Viggle/Meridian at `9c57d46f`; NyckM/3d-Camera-control-H3-Minimax at `36c4218a`; GitHub and Hugging Face searches for "worldcast", `worldcast_bank`, `SourceSelfAttentionBank`.

MOSS-Image Layout
- https://github.com/LinXce/Comfyui-Moss-LayoutPrompt at `326ad58e3e5055cc59b90fe5b5d2bcddf3698a4d` (clone `/home/user/ext/moss-layoutprompt/repo`): nodes.py, layout.py, README.md, tests/test_layout.py, web/moss_layout.js, example_workflows/moss-layout-prompt.json, pyproject.toml, LICENSE, git log.
- https://github.com/OpenMOSS/MOSS-Image at `2b46b1e0e13b5aaec253879e0d006a42564b8b27` (clone `/home/user/ext/moss-image/repo`): README.md, USERGUIDE.md, skills/moss-image-prompt-enhancer/ (SKILL.md, references/layout.md, scripts/compile_prompt.py), comfyui/, docs/macos.md.
- Hugging Face: Comfy-Org/MOSS-Image at `530a4c94`, OpenMOSS-Team/MOSS-Image-SFT at `f972bd4b`, MOSS-Image-Base at `85975793`, Kijai/MOSS-image_experimental at `9869b285`, lodestones/MOSS-Image-SFT-8-steps-dmd at `f95df83b`, akhaliq/MOSS-Image-SFT-4-steps at `2ded95c3`, Spectrallic/MOSS-Image-SFT-8step-DMD-int8-convrot at `8fdeb392`, MATLOWAI/MOSS-Image-SFT-DeBand at `6d6b6179`, KBlueLeaf/MOSS-Image-FP16-fixed at `ba636014`, darask0/MOSS-Image-color-depth-control, chinoll/Moss-Image-Edit, Qwen/Qwen3.5-9B, black-forest-labs/FLUX.2-small-decoder at `a3efc24f`, Comfy-Org/Flux-2-Klein-4B at `5b3abca5`.
- Comfy-Org workflow_templates at `14220b8b`: `image_moss_image_t2i_bboxes.json`, `image_moss_image_base_t2i_bboxes.json`, `image_moss_image_t2i.json`, `image_moss_image_base_t2i.json`.
- fal OpenAPI `fal-ai/moss-image` and `fal-ai/moss-image/lora` (re-fetched for this note on 2026-10-29), https://fal.ai/models/fal-ai/moss-image; MOSI https://platform.mosi.cn/en/docs/reference/images-generations and …/layout-image-generation, https://platform.mosi.cn/app/pricing; https://wavespeed.ai/moss-image-api; Replicate slugs (404); https://api.comfy.org/nodes/moss-layoutprompt.

Shared
- Local ComfyUI, read only: `GET http://127.0.0.1:8188/object_info` and `/system_stats` (v0.41.0); `/home/user/ComfyUI` at `fc04da91b2ab12f99e4716371a7e4f98ac982597`; ComfyUI v0.43.1 sparse clone at `/home/user/ext/comfyui-v0.43.1` (`086099f5d8886163ef77dc354f8382cb7431582a`).
- Fuobe at `claude/fuobe-parity-4` (`7d7a765be3ae154610473172680250417b440264`): every path cited in §2.9, §3.9 and §4.9 (checked with `git cat-file -e` and by reading the lines).
