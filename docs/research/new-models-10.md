# Fuobe research #10: what is new in open and hosted media models (September-October 2026), and what Fuobe is missing

_As of 2026-11-01. Machine-readable twin: [`new-models-10.json`](new-models-10.json) (`sources[]`, `models[]` with licence, VRAM, hosted endpoints, ComfyUI support, release date, `inFuobe` and `confirmed`, and `packages[]` with a self-contained build brief each, in the shape of `docs/handoff/queue.json`). It builds on [`new-models-7.md`](new-models-7.md) (Open-H3-Regenerate-2K, WorldCast, MOSS-Image Layout), [`comfyui-oss-4.md`](comfyui-oss-4.md) §h (open models 2026-09-15 to 10-22) and [`paid-model-apis-4.md`](paid-model-apis-4.md) (hosted endpoints to 2026-10-22)._

**What was asked.** Find what Fuobe is missing right now: the newest open-weight and hosted models in every area Fuobe covers (image, video, video-to-video, lipsync, speech, music, SFX, upscaling, 3D, matting, depth, relighting, interpolation, LoRAs), the new ComfyUI nodes and techniques (speed LoRAs, distillation, caching, FP8 / NVFP4 / INT8 / GGUF, long video, multi-reference), what competing apps shipped, and what the community is excited about; check each against the repository; rank the gaps; propose 8-15 packages.

**How this was produced.** Read-only. Sources, all read on 2026-11-01: the ComfyUI Wiki news feed pages 1-8 (every item from 2026-09-04 to 2026-10-30), kombitz's weekly roundups of 10-10, 10-24 and 10-31, Hugging Face's trending API (overall and per media pipeline tag), **fal's full model catalog through `https://api.fal.ai/v1/models` (1,464 endpoints, filtered to the 155 dated 2026-09-01 or later)**, `llms.txt` pages for the endpoints that matter, Replicate's explore page, the Hugging Face API for licence tags, revisions and file sizes, and the model cards and repositories cited in each row. Reddit did not appear in any search result (the search index returned no r/StableDiffusion, r/comfyui, r/LocalLLaMA, r/aivideo or r/VideoEditing threads for the period), so "what the community is excited about" is measured by Hugging Face trending and likes, the ComfyUI Wiki feed and GitHub activity instead; that is marked as a gap in §7. Fuobe was read at `claude/fuobe-parity-4`: the catalog (`src/lib/catalog/models.ts`, 104 open models; `cloud-models.generated.ts`, 233 entries), `workflows/comfyui/manifest.json` (181 workflows, ComfyUI 0.42.0 @ `5841c187`), `docs/FEATURES.md`, the research files and `docs/handoff/queue.json` (38 queued packages). Nothing was installed or run, and no paid API was called. Facts that could not be confirmed from a primary source are marked "unconfirmed" here and `confirmed: false` in the JSON.

## 1. The short version

- **The month belonged to MiniMax H3.** Around the open H3 (which Fuobe already runs at 32 GB) the community shipped: FastH3 Trim (a 42-block H3 that ran at an 8 GB cap), FastH3 V2, Pika's post-trained **Pika H3 Flex** (6 steps, a Ref2VA mode with up to 9 images, 3 clips and 3 audio clips; open on 10-29), NVIDIA's Open-H3-Regenerate-2K and Sol-H3-VAE, core H3 latent upscaling (ComfyUI PRs #17411/#17412, 10-28), PTD / DMAD / PDMD / HyperFlow few-step LoRAs, sparse attention (Spark-H3, Veda, a core node), and more than a dozen task LoRAs (character swap, person removal, orbit, transformation, VFX edit, sharpness, anti-burn, ControlNet Union 2.0, structure-to-video). Fuobe's biggest open-engine gaps are **H3 on ordinary GPUs** and **H3 with references** (§4 rows 3-4).
- **New open image models:** **FLUX 3 Image Klein** (BFL, 5.6B, 10-13; #1 trending image-to-image repo; tops the open models on Artificial Analysis' October arena as cited by Freefield) is not in Fuobe on either engine, although fal hosts it with LoRAs and a trainer since 10-26. Qwen-Image 2.1 got 2-, 4- and 6-step LoRAs and a 0.8B-encoder build that cuts its 17.5 GB encoder to 1.7 GB.
- **Hosted:** **Kling 4.0** opened its fal API (round 4 held it back as playground-only; on 11-01 its `llms.txt` pages show live endpoints) and is on Replicate. fal also added H3 Max lip-sync (15 min of audio), relight, insert-video and styles, Vidu Q4, Kandinsky 6, Mureka 8/9, VEED dubbing, Meshy retexture and a "worlds" category (H3 Max Director realtime steering, Abot World 0, Lingbot World 2, Eden Live).
- **Audio:** **MiniMax Music 3** (open, core ComfyUI node, also on fal) and **YuE2** give open full songs with vocals; Fuobe's open Music has only ACE-Step. **Tencent AuK** (MIT) edits the words in a recording. **Qwen3-TTS** and **VoxCPM2** design voices from a description. Fish Audio's **Drama 3** (35B MoE) is open but has no local ComfyUI node.
- **Matting and finishing:** **CorridorKey 2.0** (neural green-screen keying, 10-13), Bria **VRMBG 3.0** now runs in ComfyUI (the same model Fuobe's cloud matte calls), **FeyNoBg** for hair, and Comfy-Org's **NVIDIA RTX Video** nodes (instant upscale, HDR, 16x frame generation).
- **Already covered or queued:** Qwen-Image 2.1, Krea 2, FIBO 2, MOSS-Image, Pixal3D, TRELLIS.2, VOID, DBS, Nano Banana 2.1, FLUX 3 Max, Krea 3, Ideogram 4.5, HeyGen Video, Grok Imagine 1.5 and Seedance 2.5 draft are in; Open-H3-Regenerate-2K, QMA angles, Idol, Hi3D, LTX-2.5 Restore and WorldCast are queued (§3). Five queued briefs are affected by newer facts (§5): most importantly **Idol is now hosted on fal** (`speridlabs/idol`, 10-30), and **core ComfyUI now has the H3 latent upscaler** that n7-3 installs a pack for.
- **Build plan (§6):** 13 packages, 6 of them P0: `nm10-kling-4`, `nm10-flux3-klein`, `nm10-h3-any-gpu`, `nm10-pika-flex`, `nm10-music3`, `nm10-qwen21-fast`; then `nm10-speech-edit`, `nm10-voice-design`, `nm10-keying`, `nm10-rtx-video`, `nm10-hosted-catchup` (P1) and `nm10-kandinsky6`, `nm10-hy-nomas-world` (P2).

## 2. What is new, by area

Columns: licence as written by the publisher; VRAM as published (guesses are marked); "hosted" means fal or Replicate (the only clouds counted); ComfyUI: native core, an official pack, or community. "In Fuobe": **yes** built, **queued** in docs/handoff/queue.json, **no** missing.

### 2.1 Video generation (open)

| Model (date) | What | Licence | VRAM / size | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|---|
| **Pika H3 Flex** (10-29) | H3 post-trained by Pika: 6-step FL2VA (t2v, first / last / first+last frame) and Ref2VA (≤9 images, ≤3 clips, ≤3 audio, 12 total), 480p / 768p, 5-15 s, 32 kHz stereo | MiniMax H3 Community (adapters are derivatives; NOTICE required) | adapters 1.96 GB (Comfy bf16) on the int8 H3 base; Pika tested H100 80 GB; consumer VRAM unpublished | native: stock LoRA loader, templates `video_pika_h3_flex_{t2v,fl2va,ref2va}` | no (Pika's own API only) | no |
| **FastH3 Trim** (10-06) | 42-block pruned H3, 8 steps, T2V template | MiniMax H3 Community | nvfp4 11.9 GB (Blackwell), fp8 19.7, int8 18.9, bf16 37.5; 5 s 480p in 13.4 s (5090), 43.9 s (4090), 82 s (4090 capped at 8 GB) | native template (ComfyUI ≥ 0.36) | no | no |
| FastH3 8-Step V2 (09-15) | 8-step H3, quality pick over Trim | MiniMax H3 Community | fits 16 GB, not 12 GB (FastVideo) | native templates | no | no |
| FastH3 Omni (10-20) | 8-step H3 with image / video / audio references | unconfirmed | unconfirmed | ComfyUI weights | no | no |
| H3 PTD LoRAs + RefAsymOPD (10-20..22) | Ref2VA in 4 or 8 steps | MiniMax H3 Community | 5.58 / 11.11 GB | community loader | no | no |
| DMAD, PDMD, HyperFlow, VDN-H3 Turbo, LongLive-Plug, SMD (09-04..10-13) | more few-step H3 LoRAs | mostly MiniMax H3 Community | — | Kijai / community | no | no (Fuobe uses LightX2V Turbo v4) |
| **Kandinsky 6.0 Video** Pro 29B / Lite 3B (10-06) | 5 s clips with 44 kHz audio, dialogue lip sync; VSR to Full HD | **MIT** | unpublished (round 4: 27.7 / 90.0 GB on disk) | first-party Registry packs `kandinsky6`, `kandinsky6-sr`; core PR #16825 open | fal Pro, Lite, VSR | no |
| **Hy-Nomas** (10-21) | interactive world model: 720p 24 fps, steered turn by turn with words and camera trajectories | **Apache-2.0** | INT8 DiT 9.06 GB, VAE 15.8-31.6 GB; one-4090 config with offload; port: ~21 s per 3 s turn on a 5090 | community port `Nynxz/ComfyUI-HyNomas` (stock loaders) | no | no |
| Prism (10-06) | Tencent / Fudan / ZJU joint 2K audio-video research preview | MIT | 720p needs one 80 GB GPU | not stated | no | no (research) |
| XGEN-JING (09-16), TaoMate-H3 streaming (09-07), TaoMate FL2VA (10-15) | egocentric interactive H3; 35 fps streaming chunks; streaming first/last frame | MiniMax H3 Community | — | conversions | no | no |
| LTX-2.5 IC-LoRAs: Alpha-Gen, Ingredients, Clean-Plate, Pixel-Spatial-Upscaler, Layout-To-Render, SDR-To-HDR, Refine-Details (08-11..09-28) | video tools on LTX-2.5 | LTX-2.x Community (gated) | ~1.3-1.7 GB each; Alpha-Gen very heavy at 4K | ComfyUI-LTXVideo | partly (fal LTX-2.3 clean plate, HDR) | partly: spatial upscaler yes, Restore + Refine queued (`archive-restore`) |

### 2.2 Video generation and editing (hosted)

| Model (date) | Endpoints | Price | In Fuobe |
|---|---|---|---|
| **Kling 4.0** (fal catalog 10-16; API live by 11-01) | fal `kling/v4/{text-to-video, image-to-video, reference-to-video, video-to-video/edit}`; Replicate `kwaivgi/kling-v4.0` | $0.157 / $0.235 per s (720p / 1080p); edit and clip references billed on input + output seconds, min 2x output | no (researched, held back as playground-only) |
| Kling 4.0 Flash (early access 09-28) | not hosted | — | no |
| **MiniMax H3 Max lip sync** (09-17) | `minimax/h3-max/lip-sync/image-to-video`: image + 5 s-15 min audio, 480P-2K | $0.05-0.32 per s, x1.2 over 15 s | no (researched) |
| MiniMax H3 Max relight (10-07), insert-video (09-28), styles x5 (09-17), 3D to video (09-16) | `minimax/h3-max/{relight, insert-video, styles/*, 3d-to-video}` | $0.05-0.16 per s | no (researched) |
| MiniMax H3 Max Turbo (09-02, 10-09) | `minimax/h3-max-turbo/{t2v, i2v, reference-to-video, extend-video}` | $0.016-0.052 per s | no |
| MiniMax H3 Lite / HighSpeed | Replicate `minimax/h3-lite`, `minimax/h3-highspeed` | unconfirmed | no |
| MiniMax H3 Max Director (09-03), Reference Director (10-15) | `minimax/h3-max/director` (realtime WebRTC: steer while it streams; 60 s minimum) | $0.056 per s 11-01..15, then $0.08 | no (record only) |
| **Vidu Q4** (fal 10-05; preview 10-07) | `fal-ai/vidu/q4/{image-to-video, reference-to-video}` (Vidu: 15 image + 3 audio references, up to 4K) | from $0.0315 per s | no (researched) |
| Kandinsky 6.0 Pro / Lite / VSR (09-28..10-05) | `fal-ai/kandinsky6-{pro,lite}/{t2v,i2v}`, `fal-ai/kandinsky6-vsr(/lite)` | Pro $0.24-1.40 per 5 s; VSR ≈ $0.08-0.09 per 5 s 480p→1080p | no |
| Seedance 2.5 US (09-19) and Draft Complete (10-30) | `bytedance/seedance-2.5/us/*` | — | Seedance 2.5 and its draft-complete route yes (non-US) |
| fal "worlds": Abot World 0 (10-15), Lingbot World 2 (10-16, research licence), VAST Eden Live 5B / 14B (10-22) | `alibaba/abot-world-0`, `robbyant/lingbot-world-2`, `vast/eden-live-*` | — | no (record only) |
| Mischief 1 (10-28), Motion to Code GLSL / GSAP (10-27), Storyfed-1 (Replicate) | — | — | no (record only) |
| Already in Fuobe | FLUX 3 Max video, H3 Max camera controls / reframe / recast / extend, HeyGen Video, Grok Imagine Video 1.5, OmniHuman v2, Pixverse V6 Max, Wan 3 | — | yes |

### 2.3 Image generation and editing

| Model (date) | What | Licence | Size / VRAM | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|---|
| **FLUX 3 Image Klein** + Base + prompt upsampler (10-13) | 5.6B t2i, edit, up to 10 references, layout boxes; 16 steps (Base 50) | FLUX Kommunity License v1.0 (non-commercial; commercial output for < US$5M revenue); Qwen3-VL-4B encoder Apache-2.0; gated "auto" | int8 DiT 5.83 GB, encoder int8 4.86 GB, upsampler w4a8 6.72 GB; B200 peak 25-31 GB; 17.8 GB measured by Freefield | native (templates 10-15) | fal `blackforestlabs/flux-3/klein/*` incl. `/lora` and trainers (10-26) | no (round 4 parked it on licence) |
| Qwen-Image 2.1 speed: LightX2V Lightning 4-step (10-13), DMD2 2-step (10-23), Pruna P-Q-Image 6-step v0.2 (10-27), Fun Acc 4-step (09-24), Turbo8, Viggle Turbo | 2-8 steps at CFG 1 | Lightning Apache-2.0 (per comfyui-wiki; HF tag empty); the rest Qwen Research | LoRAs | LoRAs; Pruna ships official workflows | no | no (Fuobe has the official Turbo checkpoint) |
| **Zen Image Edit** (09-22) | Qwen-Image 2.1 with a 0.8B encoder (17.5 → 1.7 GB) + a cleaner VAE | Qwen Research | ~17.5 GB resident | custom (two routes) | no | no |
| Qwen-Image 2.1 LoRAs: Next-Scene, Multiple-Angles (72 views), AnyAngle, Consistency, Restore, Outfit Swap, Head Swap (BFS), Fun ControlNet Union | storyboards, angles, edits on frame, control | Next-Scene / Multiple-Angles Apache-2.0 (per comfyui-wiki); AnyAngle MIT; others vary | LoRAs; ControlNet 7.5 GB | LoRAs / custom | fal has 2509/2511 gallery LoRAs only (fal's own Qwen-Image 2.1 and its edit, read 11-02, take no LoRAs) | QMA angles built (open engine) |
| Krea 2 BBOX (10-27), Kroma v0.3.1 (10-07), Krea 2 Turbo 2- and 3-step distills, Krea 2 Edit V2, Inpaint Edit, Lineart Edit, Anygles | layout boxes, speed, edits | Krea 2 Community; others unconfirmed | BBOX single files 26 GB | stock nodes / ComfyUI-Krea2Edit | no | Krea 2 family yes; these no |
| MOSS-Image Edit LoRA (10-22, core node), Edit HQ v5 (10-25), Kromoss (10-19, Apache-2.0), rapid-moss 4-step, DMD 8-step, MAX ULTRA LoHa (4 MP), Destripe, Color/Depth control (core), KohakuMoss trainer | edits, speed, hi-res, control | mostly Apache-2.0 / unconfirmed | LoRAs | core edit node after v0.42.1 | no | MOSS-Image yes; control queued (`n7-11`); edit no |
| Ming-Image 0.1 Design / Design-Layer (09-17) | design images, RGBA layer split | MIT | Comfy repack 162 GB, 80 GB GPU | Design native (v0.38) | no | no |
| LLaDA-Image (09-04), Anima Reference Adapter (10-27), Iris-3B (10-18), Primal VAE (10-30) | other image models and parts | various | — | custom | no | no (low priority) |
| Hosted: Nano Banana 2.1 (10-06), FLUX 3 image (10-01), Krea 3 (10-14) + **Krea 3 Realtime**, Ideogram 4.5 / Vector, GPT Image 2.5 Flare / Sunburst, Seedream 5 Flash + layerize, Bria FIBO 2, Recraft V4.1 Flash, Bria product holding | — | proprietary | — | partner nodes | fal | all yes except Krea 3 Realtime, Recraft 4.1 Flash, Bria product holding no |

### 2.4 Lip sync and talking heads

| Model | What | Licence | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|
| Pika H3 Flex Ref2VA (10-29) | an image + a voice clip + words → a clip with that voice, from H3 | MiniMax H3 Community | native templates | no | no |
| Kandinsky 6.0 (10-06) | generated characters speaking the prompt's dialogue | MIT | packs | fal | no |
| MiniMax H3 Max Lip Sync (09-17) | one image + up to 15 min of audio | proprietary | — | fal | no |
| LongCat-Video-Avatar 1.5 (05-21) | portrait + audio, two-person dialogue, 8 steps | MIT | community (WanVideoWrapper, GGUF) | fal hosts v1 only (`fal-ai/longcat-single-avatar`) | no (next round) |
| Already in Fuobe | InfiniteTalk, LatentSync 1.6, Wan S2V, Kling Avatar 2, OmniHuman 2, Sync 3, HeyGen | — | — | — | yes |

### 2.5 Speech, voice, music and sound

| Model (date) | What | Licence | Size / VRAM | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|---|
| **Tencent AuK / AuK-Flash** (09-09) | edit words, pitch, pace, emotion in a recording; TTS; cloning; denoise; speaker isolation; ≤ 30 s per call | **MIT** | AuK-Flash 6.12 GB + VAE 0.64 GB + Qwen2.5-Omni-3B encoder | official ComfyUI-AuK | no | no |
| **Qwen3-TTS 1.7B** (Jan 2026) | voice design, cloning, TTS | Apache-2.0 | ~6-8 GB | custom packs | fal voice-design / clone / tts | no (researched in round 1) |
| **VoxCPM2** (04-03, trending) | voice design, 48 kHz cloning, 30 languages | Apache-2.0 | ~8 GB | custom (Saganaki22, RunningHub) | no | no |
| Fish Audio **Drama 3** (10-01) | directable TTS, 16 speakers, 83 languages | Fish Audio Research License | ~40 GB (35B MoE, 3B active) | partner node only (Fish API); local via SGLang-Omni | no | no (no local node) |
| Ming-3.0-tts-0.5B, KittenTTS 2, maya2-native, phonon, Audio8-TTS, Breeze-TTS 2, Rumik OSS 1 (Indic, NC) | small / regional TTS | various | small | mostly none | Replicate maya-2 (Indic) | no (low priority) |
| **MiniMax Music 3** (weights 08-07; Comfy repack) | full songs with vocals up to 5 min, 32 kHz stereo | MiniMax-Music3 Community License (permissive with notice); Comfy repack tagged Apache-2.0 | int8 DiT 2.5 GB + encoder 9.2 GB; < 24 GB | **native core** | fal `minimax/music-3` | no (recommended in round 1, never built) |
| **YuE2-3B** (09-09) | lyrics-to-song, covers; community LoRA trainer and real-audio encoder; piano-roll pack | CC-BY-NC-4.0 | — | native (v0.36) | no | no |
| Mureka 8 / 9 / 9.5 (09-14..10-30) | songs, instrumentals, soundtracks, extend, remix, stems, edit, voice clone, lyrics | proprietary | — | — | fal `mureka/*` | older Mureka song only yes |
| ElevenLabs Music v2 / v2.5, Lyria 3.5 (09-14 / 09-19), MiniMax Music 2.6 (Replicate) | hosted music | proprietary | — | — | fal / Replicate | no |
| VEED Dubbing / Pro (10-28) | hosted dubbing | proprietary | — | VEED partner node | fal | no (heygen / elevenlabs dubbing yes) |
| Kotoba STT / TTS / realtime translation (10-09..14), Inworld Realtime TTS 2 (Replicate) | — | proprietary | — | — | fal / Replicate | no (low priority) |
| Stable Audio 3 Medium (05-17), MOSS-SoundEffect 2.0 (05-25, Apache-2.0) | music / SFX | Stable Audio Community; Apache-2.0 | — | — | — | Stable Audio 3 small yes; these no |
| Already in Fuobe | Chatterbox (+VC, dialogue), IndexTTS2, Qwen3-ASR, Whisper, DBS split, ACE-Step 1.5, Stable Audio 3 small / Open, MMAudio, HunyuanVideo-Foley, ThinkSound, ElevenLabs v4, Gemini 3.8 TTS, HeyGen Voice, MiniMax Speech 2.8, Mirelo SFX 2.0 | — | — | — | — | yes |

### 2.6 Upscaling, restoration, HDR and interpolation

| Model (date) | What | Licence | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|
| **NVIDIA RTX Video nodes 0.2.1** (10-13) | RTX VSR (1-4x), RTX Video HDR (HLG / PQ), RTX Frame Generation (2-16x, RTX 40+) | pack Apache-2.0 (its LICENSE; corrected 11-02); the `nvidia-vfx` 0.2.0.0 runtime it loads is NVIDIA proprietary (NVIDIA Software License Agreement + Product-Specific Terms for AI Products, models under the NVIDIA Open Model License), wheels on pypi.nvidia.com for Linux x86_64 and Windows only | Comfy-Org official pack, template "RTX Video Enhance" | no | yes (`nm10-rtx-video`) |
| Kandinsky 6 VSR (09-28) | x2 / x2.25 / x4 video SR, 2-5 steps | MIT | `kandinsky6-sr` pack | fal | no |
| Open-H3-Regenerate-2K + Sol-H3-VAE + core H3 latent upscaler (10-27/28) | 2K / 4K H3 redraw; fast decode | see new-models-7 | core (master) + packs | no | queued `n7-3` |
| LTX-2.5 native-resolution Tiled Fusion + Restore / Refine IC-LoRAs (09-29) | 4K-8K tiled video edits, archive restore | LTX-2.x Community | ComfyUI-LTXVideo | — | queued `archive-restore` |
| FluxSR (10-13) | one-step 4x image SR LoRA for FLUX.1-dev | FLUX.1-dev NC | community pack | no | no (low priority: SeedVR2 yes) |
| H3 X2 Detail VAE (09-30), H3 Sharpness LoRA (09-06) | H3 detail recovery | MiniMax H3 Community / Apache-2.0 | custom / native | no | no |
| Bria increase-resolution (09-07) | image upscale up to 4x | proprietary | — | fal | no (Topaz, SeedVR, Recraft Crisp yes) |

### 2.7 3D, splats and worlds

| Model (date) | What | Licence | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|
| Speridlabs **Idol** (10-28) | one image → Gaussian splat in 7.2 GB | Apache-2.0 | community node; core TripoSplat graph | **fal `speridlabs/idol` (10-30)** | queued `idol-1..9` (open only in the briefs) |
| Hi3D v1.0 (10-23; corrected by `hi3d-refine`) | coarse mesh → 1536³ geometry | Hi3D Open License 1.0 | `T8mars/Comfyui-Hi3d-T8` (weights repo `t8star/Hi3d-Comfy`) | no | `hi3d-refine` (open engine only) |
| UltraTex (10-03) | 2K multi-view texturing of meshes | unconfirmed | custom pack | no | no |
| Meshy 6 / 7 Retexture (10-14), Meshy 7.1 text-to-3D, Tripo P2 (09-20) | retexture, production meshes | proprietary | — | fal | Meshy 7.1 image / multi-image yes; these no |
| HairDeck (10-27, Apache-2.0), UniForge3D (10-10, CC-BY-NC-4.0), StableGen 0.4 (Blender + ComfyUI texturing / rigging, GPL-3.0) | hair, assets, texturing | as listed | various | no | no (watch) |
| Hy-Nomas (10-21), fal worlds (above), HY-World 2.0, Marble | worlds | Apache-2.0 / proprietary | port / — | fal / World Labs | no (Hunyuan World and Marble researched in round 4) |

### 2.8 Segmentation, matting, depth and relighting

| Model (date) | What | Licence | ComfyUI | Hosted | In Fuobe |
|---|---|---|---|---|---|
| **CorridorKey 2.0** (10-13) | neural green / blue-screen keying, linear EXR, 4-6 GB | corridor-key-licence-2.0 (no paid API / resale) | community wrappers (v2 support unconfirmed) | no | no |
| **Bria VRMBG 3.0** in ComfyUI-RMBG 3.3.0 (10-20) | video matting | bria-vrmbg-3.0, gated | custom pack | fal `bria/video/background-removal/v3` | cloud yes, open no |
| FeyNoBg (10-09), Finegrain Box Segmenter, YOLO26-seg (in RMBG 3.3.0) | hair matting; box cut-outs; fast segmentation | FeyNoBg unconfirmed | custom pack | no | no |
| Bria green-screen despill (08-27), Bria guided background removal (10-10) | keying; cut-out with plain-language corrections | proprietary | — | fal | no |
| LTX-2.5 Alpha-Gen (10-02) | video → alpha matte, no green screen | LTX-2.x Community (gated) | ComfyUI-LTXVideo | no | no |
| SAM 3.1 Multiplex (RMBG 3.2.0, 09-30) | multi-object tracking | SAM licence | custom | fal SAM 3.1 video yes | SAM 3.1 yes |
| Marigold V2 (core 09-15), MoGe 3 (core 09-20), PURE depth (10-15) | depth / normals / albedo; metric point maps | various (MoGe 3 MIT) | native | fal Marigold V2 | yes (Marigold cloud; MoGe in `scene-mesh-moge`) |
| H3 Max Relight (10-07), ID-V2V Relight (09-14) | video relight | proprietary | — | fal | no (Bernini, Qwen relight, LightX yes) |

### 2.9 ComfyUI core, techniques and tools

- **Core releases:** v0.36.0 (09-15: Marigold V2, Video Concatenate, FastH3, YuE2, H3 VAE int8 / comfy-kitchen kernels), v0.37.0 (09-20: Qwen-Image 2.1, MoGe 3), v0.38.0 (09-29: Ming-Image, Wan ID-V2V, **w6a8 quantisation**, faster SeedVR2 and YuE2), v0.42.0 / 0.42.1 (10-18: MOSS-Image, Krea 3 partner node), then master: Fibo 2.0, the MOSS edit-LoRA node, **H3 latent upscaling and Sol-H3-VAE (#17411/#17412, 10-28)**. Fuobe pins 0.42.0 @ `5841c187`. Also native **loops** (Start Loop / End Loop, 09-15) and a core **block sparse attention node + "Comfy Compiler"** memory compiler for long runs (09-06).
- **Quantisation that matters:** INT8 ConvRot is now the default Comfy-Org repack format (H3, FLUX 3 Klein, MOSS, Music 3); NVFP4 files for Blackwell (FLUX 3 Klein 5.28 GB, FastH3 Trim 11.9 GB, the Qwen3-VL 32B encoder Fuobe already uses); w4a8 encoders (MOSS, Klein upsampler); w6a8 in core; GGUF for H3, Qwen-Image 2.1 Turbo, Krea 2 Turbo, FLUX 3 Klein, Zen Image Edit and LongCat.
- **Speed:** few-step LoRAs for everything (H3: Turbo v4 / PTD / DMAD / PDMD / HyperFlow / SMD; Qwen-Image 2.1: 2-8 steps; Krea 2: 2-3 steps; MOSS: 4-8 steps); decoder distillation (Sol-H3-VAE, LightVAE); sparse attention (Spark-H3, Veda, Ref2VA VSA, core); progressive-resolution sampling (SelfLift, H3 SPEED V2); an RTX 30 BF16 unlock kernel module (+31-60% BF16 on a 3090 Ti; system-level).
- **Long video and continuity:** obvpm Timeline (extend / prepend / bridge / loop H3 clips), ComfyUI-Continuity 3.2 (casts and seam control across H3, LTX 2.5), H3 Anti-Burn LoRA for chained clips, TaoMate streaming, Hy-Nomas turns.
- **Multi-reference and identity:** Pika Flex Ref2VA (12 refs), FastH3 Omni, H3 RefMods (1 MB zero-training reference adapters), OmniChar `.char` files across H3 / FLUX.2 / Krea 2, Fizgig LoRA isolation (one face, no leakage).
- **Front ends and rebuilds (competitors and sources of recipes):** Comfy Org's **#OpenSourceHiggsfield challenge** ($25,000, closed 10-30) produced **Freefield** (MIT; 120 Higgsfield-style apps as ComfyUI workflows with `app.json` manifests; FLUX 3 Klein is its image default since 10-24); **ComfyArt** (MIT, a Lovart-style canvas agent), **Comfy Agent** on Comfy Cloud (10-01), HEISS UI (no-graph front end), Vlo 0.3 (video editor with a ComfyUI bridge), AI Movie Studio 2, OpenFill (GIMP / PhotoCraft fill), Scumble, Kokon (Qwen-Image 2.1 desktop editor with an MCP server), Character Card Studio, StableGen 0.4.

### 2.10 Competing apps

| App | What shipped (Sep-Oct 2026) | Fuobe |
|---|---|---|
| Kling | Kling 4.0 (3-30 s, 10 keyframes, 15 references, edit up to 5 clips, 10-bit HDR and 2-minute extension "coming soon"); 4.0 Flash early access 09-28 | Kling 4.0 no → `nm10-kling-4`; Frames mode via FLUX 3 Max yes |
| Higgsfield | Kling 4.0 since 10-21; features built with GPT-6 Astra (09-21); Explainer (07), Supercomputer agent, Personal Clipper, CLI (05) | Explainer, Assist, CLI yes; clipper no |
| Pika | Pika H3 Flex (open, 10-29), app on 11-02 with 4K and 5 audio stems (hosted) | `nm10-pika-flex` (open half only) |
| CapCut 19.9 (10-23, from the APK) | EditPilot agent editing the timeline, AI Audio Studio (text-to-audio, voice clone and extraction, audio polish), Skill Templates | Assist + skills yes; voice design / speech edit no → `nm10-voice-design`, `nm10-speech-edit` |
| Vidu | Q4 (10-07): 15 image + 3 audio references, 4K; first AI-cast feature film (10-27) | `nm10-hosted-catchup` |
| Google / Midjourney | Nano Banana 2.1 GA 10-06 (thinking, 14 references); Midjourney "Rerun (Thinking)" 10-08 (no API) | Nano Banana 2.1 yes; Midjourney has no API |
| Krea | Krea 3 (10-14) and Krea 3 Realtime | Krea 3 yes; Realtime no (record) |
| MiniMax | H3 Max lip sync, relight, insert, styles, Director realtime, Turbo | `nm10-hosted-catchup` |
| Topaz / Adobe | Adobe completed its Topaz acquisition (reported 09-23); no new Topaz model found in October | Topaz yes |
| Runway, Luma, Hedra, Freepik (now Magnific), OpenArt | no dated October launch found (searches returned nothing primary) | — |
| Comfy | Comfy Agent (10-01), #OpenSourceHiggsfield challenge, RTX Video nodes, partner nodes for VEED, Mirelo, Krea 3, Fish Audio Drama 3, HY Image 3.5, Seedream 5 Flash | see above |

## 3. What Fuobe already covers

| New thing | Where it is in Fuobe |
|---|---|
| MiniMax H3 (FL2VA int8 + Turbo v4, HQ, Orbit LoRA), Character swap, Person remover, H3 Relay | `oss-minimax-h3`, `minimax-h3-*` graphs, Character Swap Studio, Remove object (FEATURES.md) |
| Hosted H3 / H3 Max (camera controls, reframe, recast, extend) | `minimax-h3`, `minimax-h3-max`, `minimax-h3-max-camera`, `minimax-h3-max-reframe`, `h3-max-recast` |
| Qwen-Image 2.1 and Turbo; Krea 2 (Realism, Turbo, Edit, Identity, i2i, Inpaint); FIBO 2; MOSS-Image | `qwen-image-21-*`, `krea2-*`, `fibo2-*`, `moss-image-t2i` graphs and the cloud `bria-fibo-2`, `moss-image` |
| Pixal3D, TRELLIS.2 (single and multi-view), Hunyuan3D 2.1, TripoSplat, MoGe scene mesh | `image-to-3d-*`, `image-to-splat-triposplat`, `scene-mesh-moge` |
| VOID video inpainting, DBS soundtrack split | `video-erase-void`, `void-video-inpainting`; `separate-soundtrack-dbs` |
| Nano Banana 2.1, FLUX 3 (image and Max video), Krea 3, Ideogram 4.5 + Vector, GPT Image 2.5 (Flare / Sunburst), Seedream 5 Flash + layers, HeyGen Video / Voice, Grok Imagine Video 1.5 + Image 2, OmniHuman v2, Gemini 3.8 TTS, ElevenLabs v4, Mirelo SFX 2.0, Marigold V2, Seedance 2.5 + draft complete, Pixverse V6 Max, Creatify Boreal, Pixelcut looping | `cloud-models.generated.ts` |
| Bria VRMBG 3.0 (cloud), SAM 3.1 (both engines), BiRefNet | `bria-video-bg`, `sam-3-1-video-mask`, `video-bg-remove-*` |
| Queued, not built: Open-H3-Regenerate-2K (`n7-3`, `n7-4`, `n7-10`), QMA angles (`qma-angles`), Idol (`idol-1..9`), Hi3D (`hi3d-refine`), LTX-2.5 Restore + Refine (`archive-restore`), WorldCast (`n7-9`), in-betweening (`inbetweening`), blockout to film (`blockout-film`), DBS D2-D9 | `docs/handoff/queue.json` |

## 4. Gaps, ranked by user value × feasibility

Value: how many Fuobe users would use it and how visible the improvement is (1-5). Feasibility: how much of it is catalog work or native nodes this machine can validate, versus custom packs, huge files or unproven ports (1-5). Ties keep the more broadly useful one first.

| Rank | Gap | Value | Feasibility | Score | Package |
|---|---|---|---|---|---|
| 1 | Kling 4.0 (newest flagship video; API open on fal and Replicate) | 5 | 5 | 25 | `nm10-kling-4` |
| 2 | FLUX 3 Image Klein on both engines (top open image model; hosted with LoRAs and a trainer) | 5 | 4 | 20 | `nm10-flux3-klein` |
| 3 | Qwen-Image 2.1 in 2-6 steps and on 16 GB; 2.1 Next-Scene | 4 | 4 | 16 | `nm10-qwen21-fast` |
| 4 | Full songs with vocals on the open engine (MiniMax Music 3, YuE2) + Mureka 9 tools | 4 | 4 | 16 | `nm10-music3` |
| 5 | Open H3 on 8-24 GB GPUs (FastH3 V2 / Trim) and fast H3 decode | 5 | 3 | 15 | `nm10-h3-any-gpu` |
| 6 | H3 with references (images, clips, voice) on the open engine: Pika H3 Flex | 5 | 3 | 15 | `nm10-pika-flex` |
| 7 | Edit the words in a recording (AuK) | 4 | 3 | 12 | `nm10-speech-edit` |
| 8 | Hosted catch-up: H3 Max lip-sync (15 min), relight, insert, styles, Turbo; Vidu Q4; retexture | 3 | 4 | 12 | `nm10-hosted-catchup` |
| 9 | Design a voice from words (Qwen3-TTS both engines; VoxCPM2) | 3 | 4 | 12 | `nm10-voice-design` |
| 10 | Instant RTX upscale / HDR / frame generation (NVIDIA RTX owners only) | 3 | 4 | 12 | `nm10-rtx-video` |
| 11 | Green-screen keying and hair mattes (CorridorKey 2.0, VRMBG 3.0 open, FeyNoBg; Bria despill / guided) | 3 | 3 | 9 | `nm10-keying` |
| 12 | Kandinsky 6.0 (MIT video with dialogue) + Kandinsky VSR | 3 | 3 | 9 | `nm10-kandinsky6` |
| 13 | A steerable world model (Hy-Nomas) | 3 | 2 | 6 | `nm10-hy-nomas-world` |
| — | Two-person talking video (LongCat-Video-Avatar 1.5, MIT) | 3 | 3 | 9 | next round |
| — | H3 ControlNet Union 2.0 (pose / depth / scribble / layout on H3) and SolarRenderer (grey box → video) | 3 | 2 | 6 | next round (SolarRenderer: see `blockout-film` note) |
| — | MOSS-Image Edit LoRA, Krea 2 BBOX / Edit V2 / 3-step, Anima Reference Adapter | 2 | 3 | 6 | next round |
| — | Fish Audio Drama 3 locally (no ComfyUI node; ~40 GB) | 3 | 1 | 3 | watch |
| — | Retexture on the open engine (UltraTex: licence and VRAM unconfirmed) | 2 | 2 | 4 | watch (Meshy retexture is in `nm10-hosted-catchup`) |
| — | Realtime steering (H3 Max Director, Eden Live, Krea 3 Realtime): WebRTC sessions, a new runtime in Fuobe | 3 | 1 | 3 | open |

The build order in §6.1 groups these by priority: the H3 packages (ranks 5-6) are P0 despite a lower feasibility score because they upgrade the open engine's flagship video model, which most owners hit.

## 5. Effect on queued briefs

| Queued package | Newer fact | Suggested change |
|---|---|---|
| `n7-3-regenerate-2k` (and `n7-4`, `n7-10`) | ComfyUI core merged MiniMax H3 latent upscalers (PR #17412) and a Sol-H3-VAE loader (PR #17411) on 2026-10-28 (master, not v0.43.1). Sol-H3-VAE decodes 2K in 0.89 s instead of 14.5 s on a GB200. | After a pin bump (done in `nm10-h3-any-gpu`), use the core upscaler instead of installing the LBH pack, and test Sol-H3-VAE as the decoder. The rdh pack is still needed for the refine recipe. |
| (n7-3 as built, 2026-11-01) | The CPU ComfyUI here is 0.41.0 (`fc04da91`): its `/object_info` has no core H3 latent upscaler and no Sol-H3-VAE loader. rdh9616's `OpenH3RegenUpscale` looks up LBH's `MinimaxH3LatentUpscaler3D` class by name (`__init__.py` L415-418) and raises without it, so the core upscaler alone would not serve the rdh graph. | n7-3 installs both packs (`OPEN_H3_REGEN=1`). Dropping the LBH pack needs the core upscaler in the pin and a change to the rdh node (or a graph on core nodes): revisit with `nm10-h3-any-gpu`'s pin bump. |
| (2026-11-02) | Read at the source: #17412 adds core `MiniMaxH3LatentUpscaleWithModel` (model/latent/minimax) and teaches core `LatentUpscaleModelLoader` the H3 upscaler's state dict; #17411 teaches the core `VAELoader` the Sol decoder (no new node). Open-H3-Regenerate's `vae_fast/fast_h3_vae_noncausal_24l.safetensors` is byte-identical to Sol-H3-VAE's `sol_h3_vae.safetensors` (SHA-256 `8658f1e8…`, 6.47 GB); Comfy-Org repacks it as `minimax_h3_sol_vae_int8_convrot` (1.99 GB) and `_fp16` (3.6 GB) at `912b6e38`. Both PRs are on master only (v0.43.2 lacks them; master's `comfyui_version.py` still reads 0.43.0). | `install-comfyui.sh` keeps `fc04da91` as its default and names master `17ff1dcc` (2026-11-01, has both PRs) as an opt-in `COMFYUI_REF`: the library is not yet re-validated on it (the running CPU server here is still `fc04da91`), so the default moves, and Fast decode is offered, only after a session validates the whole library there. The LBH pack is unnecessary only for a graph built on the core nodes (`LatentUpscaleModelLoader` → `MiniMaxH3LatentUpscaleWithModel`) with the upscaler file Regenerate already pins (`minimax_h3_latent_upscaler_3d_conv_v1_bf16`, the same bytes as LBH's; its header has the three keys the core loader looks for, read 2026-11-02); rdh9616's `OpenH3RegenUpscale` still calls LBH's class by name, so `video-regenerate-h3` keeps both packs until its upscale step moves to the core nodes. Regenerate's fast decoder could move to the core `VAELoader` on the new pin (same file). |
| `idol-1` … `idol-9` | `speridlabs/idol` is **hosted on fal** (active since 2026-10-30). idol-1 says "Idol is not on fal or Replicate (§6). Do not add a cloud half". | Idol now qualifies for a cloud route: fetch the schema and add the cloud half to idol-1 (or a small follow-up), labelled as Idol. |
| `qma-angles` | akhaliq's Qwen-Image-2.1 Multiple-Angles LoRA (72 framings; Apache-2.0 per comfyui-wiki), AnyAngle (MIT, renders from a splat or GLB), Krea 2 Anygles and Fisher Pose appeared. Speed LoRAs (`nm10-qwen21-fast`) can cut QMA's 30 steps. | Keep QMA (the owner's pick); record the alternatives; try the 4-step Lightning LoRA with QMA as an optional fast preview. |
| `blockout-film` | fal `minimax/h3-max/3d-to-video` (09-16) turns a Blender / 3D proxy animation (≤ 15 s, ≤ 32 shots) plus references into a finished video; SolarRenderer (H3 LoRAs, 10-13) renders grey boxes, semantic maps or SMPL meshes in 4 steps on the open engine. | Both are the same task as the brief: offer H3 Max 3D-to-video as a cloud model under its own name next to Seedance 2.5, and record SolarRenderer as the open route to test. |
| `inbetweening` | Pika H3 Flex FL2VA (first + last frame, 6 steps, with sound) and TaoMate-H3-FL2VA. | Optional H3 in-between route once `nm10-pika-flex` lands; Wan 2.2 FLF2V stays the default. |
| `n7-4-character-swap-2k` / Character Swap Studio | Alissonerdx's H3 Character Swap v1.1 (80 MB dynamic-rank LoRA, better likeness; BFS-Character-Swap-Community-1.1 licence). | Record it; A/B against Akatz Labs' LoRA in the evaluation harness before offering it. |
| `n7-9-worldcast-worker` | Hy-Nomas (Apache-2.0) is a different, steerable world model. | No change; `nm10-hy-nomas-world` reuses its camera-path pieces. |
| `dbs-d3` / `dbs-d5` | fal added VEED Dubbing / Pro (10-28) and Mureka stems. | Neither is a DBS stand-in; use only under their own names, if at all. The "no SAM Audio stand-in" rule is unaffected. |
| `archive-restore` | RTX Video Super Resolution and Kandinsky VSR give fast preview tiers. | Optional: reuse `nm10-rtx-video`'s graph as the "quick look" before the LTX restore. |
| Soul ID training | fal's FLUX 3 Klein LoRA trainers (10-26). | Added as a target in `nm10-flux3-klein`. |

## 6. Build plan

Rules this plan follows (docs/HANDOFF.md): no Higgsfield API, keys or models; licences are information, not gates (every package records its licences in Settings → Models & licences, all switched on); each engine does all it can, the cloud uses only models hosted on fal or Replicate with no substitute model, and the open engine keeps every capability it has; no SAM Audio stand-in in the cloud (nothing here proposes one). Put each thing where people already work. Each brief in the JSON twin is self-contained and ends with the standard CLOUD, MAIN CHANGED and PUBLIC SIGN-UP paragraphs copied from the queue.

### 6.1 Order

| # | Key | Package | Lane | Priority | Effort | Depends on | Open engine | Cloud engine |
|---|---|---|---|---|---|---|---|---|
| 1 | `nm10-kling-4` | Kling 4.0 in the cloud | R | P0 | small | — | — (closed model) | fal kling/v4/* ($0.157-0.235/s); Replicate kwaivgi/kling-v4.0 |
| 2 | `nm10-flux3-klein` | FLUX 3 Image Klein on both engines | R | P0 | medium | — | native graphs, int8 5.8 GB DiT + 4.9 GB encoder (+ 6.7 GB upsampler) | fal flux-3/klein (+ /lora, trainer) |
| 3 | `nm10-h3-any-gpu` | MiniMax H3 on 8-24 GB GPUs, and faster H3 decoding | R | P0 | large | — | FastH3 V2 / Trim tiers (8-24 GB), Sol-H3-VAE, core H3 upscaler (pin bump) | unchanged |
| 4 | `nm10-pika-flex` | Pika H3 Flex on your GPU | O | P0 | large | nm10-h3-any-gpu | Pika Flex FL2VA + Ref2VA adapters, 6 steps | only if fal's H3 LoRA endpoints run the adapters at Pika's schedule |
| 5 | `nm10-music3` | Full songs on both engines | R | P0 | medium | — | MiniMax Music 3 (core), YuE2 (core) | fal minimax/music-3, Mureka 9 tools, ElevenLabs Music v2.5, Lyria 3.5 |
| 6 | `nm10-qwen21-fast` | Qwen-Image 2.1 in 2-6 steps and on 16 GB cards | R | P0 | small | — | 2/4/6-step LoRAs, Zen 0.8B encoder, 2.1 Next-Scene | — (2.1 not hosted) |
| 7 | `nm10-speech-edit` | Edit what was said | R | P1 | medium | — | Tencent AuK (ComfyUI-AuK) | — (not hosted) |
| 8 | `nm10-voice-design` | Design a voice from a description, and clone at 48 kHz | R | P1 | small | — | Qwen3-TTS, VoxCPM2 (custom packs) | fal qwen-3-tts (same model) |
| 9 | `nm10-keying` | Green screen and fine hair | R | P1 | medium | — | CorridorKey 2.0, VRMBG 3.0, FeyNoBg (Alpha-Gen on 48 GB+) | Bria green-screen despill, Bria guided cut-out |
| 10 | `nm10-rtx-video` | Instant upscale, HDR and frame generation on RTX cards with Comfy-Org's NVIDIA VFX nodes | R | P1 | small | — | Comfy-Org NVIDIA VFX nodes (RTX only) | — (SDK, not hosted) |
| 11 | `nm10-hosted-catchup` | Hosted catch-up | R | P1 | medium | — | — (closed models) | H3 Max lip-sync / relight / insert / styles / Turbo, Vidu Q4, H3 Lite & HighSpeed, Meshy retexture, Tripo P2 |
| 12 | `nm10-kandinsky6` | Kandinsky 6.0 on both engines | R | P2 | medium | — | kandinsky6 + kandinsky6-sr packs | fal kandinsky6-pro / -lite / -vsr (same model) |
| 13 | `nm10-hy-nomas-world` | World mode on your GPU | O | P2 | large | — | Hy-Nomas via Nynxz/ComfyUI-HyNomas | — (not hosted) |

Why this order: the P0 packages are either catalog-only wins on the newest hosted model (Kling 4.0) or the open models the community is using most this month (FLUX 3 Klein, H3 on ordinary GPUs and Pika Flex, Qwen-Image 2.1 speed, songs). The P1 packages add abilities Fuobe lacks outright (editing words in a recording, designing a voice, real keying, RTX instant tiers) and catch up the hosted catalog. The P2 packages are worth having but heavier or less proven (Kandinsky 6, a world model).

### 6.2 nm10-kling-4 · Kling 4.0 in the cloud: 3-30 s takes, multi-shot, references and video edit, now that fal's API is open

_Lane R · priority P0 · effort small · depends on none_

**Why.** Kling 4.0 is the flagship closed video model of the month (Higgsfield has offered it since 2026-10-21). Round 4 recorded its four fal endpoints but held them back as 'playground-only'. On 2026-11-01 the llms.txt pages for kling/v4/text-to-video and kling/v4/video-to-video/edit document live fal.run endpoints with no 'coming soon', and Replicate lists kwaivgi/kling-v4.0. It is the cheapest big win: catalog work only.

**Where it shows up.** Video studio model menu (Best list), Cinema Studio takes (multi-shot up to 30 s, @Elements), Edit video (Kling 4 edit), Genjutsu Swap / Insert model picker, Assist and MCP model lists.

**Brief.** Research record: docs/research/paid-model-apis-4.json already holds kling/v4/text-to-video, image-to-video, reference-to-video and video-to-video/edit with status 'playground-only' (catalog date 2026-10-16) and a recommendation not to route until the page drops "API access is coming soon". On 2026-11-01 https://fal.ai/models/kling/v4/text-to-video/llms.txt and .../video-to-video/edit/llms.txt describe live endpoints (fal.run, Key auth) with no waitlist (docs/research/new-models-10.md §2.2). FIRST re-fetch all four OpenAPI schemas with the existing scripts (the same way round 4 did) and confirm image-to-video and reference-to-video are live too; flip each record's status to active only if its page is live, and note the date. Replicate: replicate.com/explore lists kwaivgi/kling-v4.0 ("3-30 second videos up to 1080p and edits existing videos"): fetch its schema and add it as a second provider only if its inputs map cleanly.

Facts to build on (from the fal pages; re-check): text-to-video takes prompt OR multi_prompt (a list of shots whose durations sum to the total), duration 3-30 s (default 5), resolution 720p | 1080p (default 1080p), aspect_ratio 16:9 | 9:16 | 1:1 | 21:9; $0.157/s at 720p, $0.235/s at 1080p. image-to-video adds start_image_url (required) and end_image_url. reference-to-video takes image_urls, video_urls, elements, start_image_url, multi_prompt. video-to-video/edit takes prompt (the source is @Video1), video_url (3-30.05 s, <= 300 MB, 700-4553 px a side, aspect 0.40-2.50, 23.9-60.05 fps), image_urls (@Image1..), video_urls (up to 4, @Video2..; source + references + element videos <= 30 s in all), elements (up to 7; up to 3 with a voice_id, up to 3 video elements), voice_ids (up to 3, made with fal's create-voice model), duration 3-30, resolution; billed $0.094/s (720p) or $0.141/s (1080p) on input plus output seconds with a minimum of 2x the output. Kling's own spec (atlascloud summary of the release note) adds 10 keyframes, 15 mixed references, 10-bit HDR "coming soon" and 2-minute extension "coming soon": the fal API exposes none of the keyframe, HDR or extension features, so do not claim them.

Build:

1. scripts/gen-cloud-models.py: model("kling-4", "Kling 4.0", "Kuaishou", "kling", "video", ...) with routes t2v, i2v, flf2v (start + end image), ref2v (images, clips, @Elements) and v2v (edit), price per second by resolution, and the edit / clip-reference billing rule (input + output seconds, minimum 2x output) in the price function, never shown as the plain per-second rate. Regenerate src/lib/catalog/cloud-models.generated.ts (pnpm gen:catalog). Badges: top, 30s. Place it in the Video studio's Best list next to Seedance 2.5 and FLUX 3 Max.

2. Multi-shot: map Fuobe's shot list (Cinema multi-shot takes, the Video studio's multi-shot) to multi_prompt [{prompt, duration}], so a 30 s take is one call; keep the automatic extend for longer takes on models that need it.

3. Elements: Fuobe Elements @mentions become Kling elements (images, or a short clip for a video element); a voice element needs a fal voice id: if Fuobe has no fal create-voice flow, leave voices out and say so in the picker ("voices: not yet").

4. Edit video: Kling 4 edit as a model in Edit video and in Genjutsu's Swap / Insert pickers, with the 30 s and 300 MB limits checked before upload and the input-plus-output price shown first.

5. Frames mode stays on FLUX 3 Max keyframes (src/lib/catalog/keyframes.ts says Kling 4.0 takes 10 frames; the hosted API does not): fix that comment so it does not promise Kling keyframes.

6. Engine labels: Kling 4.0 is a closed model, so it is cloud-only like the other partner models; "Open source only" hides it. The open engine keeps its own models: nothing changes there.

7. Licence row: proprietary paid API (Kuaishou via fal / Replicate), switched on.

Tests: payload tests for each route against the stored schemas (multi_prompt durations sum, 21:9, 1080p default, start/end image, 4 reference videos, 7 elements), the price function (5 s at 720p = $0.785; a 10 s edit at 1080p bills max(input+output, 2x output) seconds), Cinema multi-shot mapping, the mock provider. Browser checks of the Video studio menu, a Cinema take and Edit video at 1440 and 390 px, light and dark, in demo mode. No paid call can be made here: say so.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.3 nm10-flux3-klein · FLUX 3 Image Klein on both engines: text to image, edits with up to 10 references, layout boxes, LoRAs and a Soul ID training target

_Lane R · priority P0 · effort medium · depends on none_

**Why.** BFL's open 5.6B FLUX 3 Image Klein (2026-10-13) is the most-downloaded new image repo on Hugging Face (flux-3-image-klein-comfy is #1 trending image-to-image) and tops the open models on Artificial Analysis' October arena (1043 Elo vs Qwen-Image 2.1 1042, as cited by Freefield). Round 4 (comfyui-oss-4.md §h) parked it as 'opt-in only (licence)', which is now overruled: licences are information. fal hosts the same model with LoRAs (2026-10-26) and a LoRA trainer, so it fits both engines exactly.

**Where it shows up.** Image studio model menu (Best list beside Ideogram 4 and Qwen-Image 2.1), Edit studio (multi-reference), Layout mode (the flux3 compiler already exists), Settings → LoRAs, Elements → Train (a new training target), Canvas image node, Assist.

**Brief.** Model facts (black-forest-labs/flux-3-image-klein @ 337337621b85, -comfy @ feef60b0aaf6; read the cards as data): distilled 5.6B transformer, 16 steps, no guidance; Klein Base 50 steps, guidance 3.5 (the one to train LoRAs on); text to image, single-reference edit and multi-reference generation with up to 10 reference images; bounding-box layout; text rendering 'may be inaccurate'. BFL says not to use it without the 9B prompt upsampler (short prompts give generic results). Licence: FLUX Kommunity License v1.0 (non-commercial use; commercial output for 'Qualifying Users' under US$5M gross annual revenue; other commercial use needs a BFL licence; not blanket permission to fine-tune or redistribute commercially); the Qwen3-VL-4B encoder is Apache-2.0. Record both in Settings → Models & licences, switched on. VRAM (card, B200, 1 MP, upsampler off): 31 GB bf16, 26 GB fp8, 25 GB nvfp4; Freefield measured 17.8 GB for its int8 create-image app: give vramGb 16-24 as a guess and say so.

Comfy-Org files (sizes from the HF tree, pin the revision): diffusion_models/flux3-image-klein-int8-convrot.safetensors 5.83 GB (default), -nvfp4 5.28 GB (Blackwell), -bf16 11.1 GB; flux3-image-klein-base-* (same three); text_encoders/qwen3vl_4b_int8_convrot.safetensors 4.86 GB (bf16 8.88 GB); prompt upsampler text_encoders/qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors 6.72 GB (int8 9.75 GB, bf16 18.82 GB); vae/flux2-vae.safetensors 0.34 GB. The repo is gated 'auto': downloads need an HF token after accepting the terms (handle it like the other gated repos).

Open engine: ComfyUI has native Klein support with official templates (2026-10-15, after Fuobe's pin 0.42.0 @ 5841c187 for some nodes: check every class against object_info and report which need a pin bump). Hand-built graphs from the official templates (read them from Comfy-Org/workflow_templates as data): flux3-klein-t2i (with an optional upsampler branch: Options → Prompt helper on/off, default on), flux3-klein-edit (1-10 references), flux3-klein-base-t2i-lora (LoRA stack on Base). Spec in scripts/comfy/library.spec.mjs, build, validate on the CPU ComfyUI; pin files in model-pins.json; ModelDefs oss-flux3-klein, oss-flux3-klein-edit (kind image; ops t2i, edit; maxImages 10). Layout: ModelOptions.layout 'flux3' already has compileFlux3 (src/lib/layout-prompt.ts L511) writing the shape of core Flux3LayoutPrompt: wire it to the open graph.

Cloud engine (fal; fetch every schema with the existing scripts first): blackforestlabs/flux-3/klein/text-to-image and /edit-image (paid-model-apis.json recorded planned per-image prices $0.008 768px ... $0.036 4K: re-check), /text-to-image/lora and /edit-image/lora (loras <= 3 of {path, scale 0-4}; image_size 256-4096 a side; num_images 1-4; enable_prompt_expansion default true; bounding_boxes with fractional coordinates; $0.012 per megapixel), /base/text-to-image/lora, /base/edit-image/lora, and the trainers /base/trainer and /base/trainer/edit (2026-10-26). model("flux-3-klein", ...) with t2i, edit, LoRA routes through Fuobe's existing LoRA plumbing; layout boxes go to bounding_boxes; enable_prompt_expansion off when a layout is attached.

Training: add a training target "FLUX 3 Klein" in src/lib/catalog/training.ts on fal's trainer (price it from the schema/page; record the licence and the 'not blanket permission for commercial fine-tuning' line). On the open engine add an AI-Toolkit target only if AI-Toolkit (the version Fuobe pins) supports FLUX 3 Klein Base: check its config list and say what you found; otherwise the open engine trains nothing new for Klein and the target says 'cloud trainer'.

Placements: Image studio Best list; Edit studio multi-reference (10 slots); the Canvas image node; Soul ID 'Train for' picker; Assist's model knowledge. Do not make it a default anywhere (Ideogram 4 / Qwen-Image 2.1 stay) for now; note the arena result in the PR.

Tests: library test for the three graphs (bindings, limits, pins, sizes); payload tests for each fal route (LoRA list, bounding_boxes from compileFlux3, prompt expansion off with a layout, megapixel price at 1024 and 2048); training target pricing; browser checks of the Image studio picker, Edit with 10 references and the training dialog at 1440 and 390 px, light and dark, in demo mode. No GPU and no fal key here: say what waits for them.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.4 nm10-h3-any-gpu · MiniMax H3 on 8-24 GB GPUs, and faster H3 decoding: FastH3 V2 and Trim tiers, Sol-H3-VAE and the core H3 latent upscaler

_Lane R · priority P0 · effort large · depends on none_

**Why.** Fuobe's open H3 graphs (Video studio, Cinema, Character swap, Person remover) ask for 32 GB (manifest vramGb 32: fl2va pruned int8 21 GB + Qwen3-VL 32B nvfp4 encoder + Turbo v4 LoRA + SLA attention). In October the community made H3 run on ordinary cards: FastVideo's FastH3 Trim ran at an 8 GB cap (nvfp4) and does a 5 s 480p clip in 13 s on a 5090 and 44 s on a 4090; FastH3 V2 fits 16 GB; ComfyUI core merged a distilled decoder (2K decode 14.5 s -> 0.89 s) and H3 latent upscalers. This turns 'Needs a bigger GPU' into 'Ready' for most owners.

**Where it shows up.** Video studio (H3 Quality / GPU tier), the /connect pre-flight board, Settings → Models & licences (tier rows), and every studio that runs open H3 (Cinema takes, Genjutsu, Character Swap Studio, Remove object) through the shared ModelDef.

**Brief.** What exists: oss-minimax-h3 with graphs minimax-h3-{t2v,i2v,flf2v} (Turbo v4 LoRA, 8 steps, H3SLAAttention needs Triton), -hq variants (20 steps), minimax-h3-orbit, and the Character Swap / Person remover graphs (Ref2VA). Read workflows/comfyui/manifest.json entries and src/lib/catalog/models.ts first.

New pieces (record each in the research JSON with revision, sizes, licence):

- FastVideo/FastVideo-FastH3-8-Step-V2 @ 3da2ddfe (MiniMax H3 Community; native templates since ComfyUI 0.36, 2026-09-15; fits 16 GB, not 12 GB, in FastVideo's tests).

- FastVideo/FastVideo-FastH3-Trim-Comfy @ f66c13dc (2026-10-06; MiniMax H3 Community License; 42 of 50 blocks; 8 steps DMD2; res_multistep / simple; MiniMaxH3SigmaShift 10 video / 3 audio): fastvideo_fasth3_trim_8step_nvfp4 11.9 GB (Blackwell: RTX 50, RTX PRO 6000, DGX Spark), _fp8 19.7 GB (Ada+), _int8_convrot 18.9 GB (any recent NVIDIA; template default), _bf16 37.5 GB; plus Qwen3-VL encoders (bf16 / int8 / nvfp4-awq) and the H3 VAEs in the same repo. Measured end to end for 5 s with audio: 5090 13.4 s at 480p, 35.4 s at 768p; 4090 43.9 s / 132.8 s; 4090 capped at 8 GB 82 s at 480p. Labelled experimental: quality is below V2. Only a text-to-video template is named: test whether first-frame / first-last-frame conditioning works on Trim before offering i2v / flf2v on it, and report.

- Sol-H3-VAE (Efficient-Large-Model/Sol-H3-VAE @ 6a8a33fc; licence tag empty: record 'unconfirmed') with its core loader, ComfyUI PR #17411, and the core H3 latent upscaler nodes, PR #17412, both merged 2026-10-28 into master (not in v0.43.1). LightVAE (ModelTC; Apache-2.0 per comfyui-wiki; up to 2.94x faster Wan/H3 decode) as an alternative if Sol needs the new loader.

- Optional speed: Spark-H3 block sparse attention (Apache-2.0, prebuilt for RTX 40/50, 1.73x DiT at 10% density) and the Veda node (~3x claimed): offer only behind an 'Experimental speed' switch, never default.

Build:

1. A pure, tested tier chooser (src/lib/gpu/h3-tier.ts or next to readiness.ts): device (VRAM, compute capability from the GPU status check: lastGpuDevice in src/server/account-gpu.ts for accounts, /system_stats for the owner) → tier: >= 32 GB 'Standard' (today's graphs); 16-31 GB 'FastH3 V2'; 12-15 GB 'Trim int8 / fp8' with offload; 8-11 GB Blackwell 'Trim nvfp4'; below 8 GB or pre-Ada 'Needs a bigger GPU'. The user can override in Options → GPU tier. The chooser also picks the encoder variant (nvfp4-awq vs int8) the way the repo pairs them.

2. Graphs: minimax-h3-fast-t2v (FastH3 V2 template), minimax-h3-trim-t2v (Trim template), and i2v / flf2v variants only where step 1's test says they work. scripts/comfy hand-built specs, build, validate on the CPU ComfyUI; pins and sizes in model-pins.json; manifest vramGb per tier with a note that the 8 GB figure is FastVideo's capped-memory test.

3. ComfyUI pin bump: Sol-H3-VAE and the H3 latent upscaler need a master commit at or after the 2026-10-28 merges. Bump scripts/comfy/install-comfyui.sh and the manifest's comfyuiCommit to a tested master commit, re-validate the whole library (report every graph's result), and add 'Fast decode (Sol-H3-VAE)' as an H3 option once it validates. Coordinate with n7-3-regenerate-2k: its brief installs the LBH latent-upscaler pack; with core #17412 that pack may be unnecessary: say so in your report and in docs/research/new-models-10.md §5.

4. Studios that run Ref2VA (Character Swap, Person remover, the H3 Relay graphs) keep their current requirements unless a Ref2VA Trim exists (none found): their /connect rows say so plainly.

5. /connect: STUDIO_ROWS show the tier a device gets ('Ready on this GPU: FastH3 Trim (fp8)'), and Settings → Models lists the tier files with their licence.

Cloud: unchanged (fal's hosted MiniMax H3 / H3 Max). Hosted cheaper tiers (fal H3 Max Turbo, Replicate minimax/h3-lite and h3-highspeed) are catalogued by nm10-hosted-catchup, under their own names.

Tests: tier chooser table tests (every VRAM / arch edge), library tests for the new graphs, a re-validation report of the full library after the pin bump, readiness tests for each tier; browser checks of the Video studio's tier display and /connect at 1440 and 390 px, light and dark, in demo mode. No GPU here: speeds and the 8 GB claim are FastVideo's, and must be labelled that way.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.5 nm10-pika-flex · Pika H3 Flex on your GPU: 6-step H3 with sound, and a References mode (up to 9 images, 3 clips and 3 voice or music clips) for the Video studio, Cinema and Lipsync

_Lane O · priority P0 · effort large · depends on nm10-h3-any-gpu_

**Why.** Pika open-sourced its post-trained MiniMax H3 on 2026-10-29 as two LoRA adapters with three official ComfyUI templates: 6 steps instead of 8-20, Pika's reward-tuned look, and a Ref2VA mode that takes ordered image, video and audio references in one call (reference-to-video, motion transfer, character swap, talking from a voice clip). Pika says it is #1 among open-weight models on DesignArena text-to-video. Fuobe's open engine has no multi-reference H3 mode today (open ref2v is Wan 2.1 VACE), so this is the biggest open video upgrade of the month.

**Where it shows up.** Video studio (H3 Quality 'Fast · Pika Flex'; a References tray with image / clip / audio slots), Cinema Studio takes with @Elements and reference clips, Lipsync & avatars ('Talk from a voice clip' on H3), Genjutsu Motion (open engine option), Fuobe Speak (an H3 option), Assist.

**Brief.** Facts (Pika-Labs/Pika-H3-Flex @ 3ff166447d5e; comfyui-wiki 2026-10-29; read the card and the Comfy tutorial docs.comfy.org/tutorials/video/pika/pika-h3-flex as data): adapters fl2va/adapter.safetensors and ref2va/adapter.safetensors (FP32, 2.77 GB each; rank 128, fused QKV merged to rank 384); Comfy BF16 files comfy/loras/pika_h3_flex_fl2va_comfy_bf16.safetensors and pika_h3_flex_ref2va_comfy_bf16.safetensors (1.96 GB each), loaded with stock LoraLoaderModelOnly at a fixed 1.0 on the pruned int8 H3 base (FL2VA on the fl2va partition, Ref2VA on the ref2va partition; Fuobe already pins both). Sampling: LCM with ManualSigmas 1000, 750, 500, 250, 100, 40, 0 (6 steps), BasicGuider CFG 1.0, video shift 12, audio shift 3, fresh intermediate noise; Pika says generic 6-step Euler is not equivalent, and stacking another speed LoRA (Turbo, Lightning) breaks the output. Templates: video_pika_h3_flex_t2v.json, video_pika_h3_flex_fl2va.json, video_pika_h3_flex_ref2va.json. FL2VA does t2v, first frame, last frame and first+last frame. Ref2VA: up to 9 images, 3 videos and 3 standalone audio clips (12 files in all), at least one image or video; each video or audio clip 2-15 s; each group <= 15 s combined; a video's own soundtrack is not counted as an audio file. Output 480p or 768p in 11 aspect ratios (21:9 to 9:21), 24 fps, 5-15 s (124 to 362 frames), 32 kHz stereo audio. Pika: "no end-to-end ComfyUI render was verified as part of the upload". Licence: MiniMax H3 Community License (the adapters are model derivatives; keep Pika's NOTICE with the Mellis, Inc. copyright); example code Apache-2.0. Pika's hosted extras (1080p-4K draft upsampling, five audio stems, prompt enhancement) are Pika's own API, not fal or Replicate.

Alternatives to record (not build unless cheap): Taobao's MiniMax-H3-PTD-LoRAs (Ref2VA 4-step 5.58 GB, 8-step 11.11 GB; MiniMax H3 Community) and RefAsymOPD; FastVideo's FastH3 Omni (8-step references with audio).

Build:

1. Graphs minimax-h3-flex-t2v, -flex-i2v / -flex-flf2v (FL2VA template with first and/or last frame bound) and -flex-ref2va (references bound as ordered lists: images[], videos[], audios[] with the template's own nodes). Specs, build, validate on the CPU ComfyUI, pin the two Comfy LoRA files with sizes and SHA-256 from the HF tree, manifest notes (6 steps, no other speed LoRA, 480p/768p, the 17n+5-style frame grid H3 uses: 124 frames = 5 s).

2. oss-minimax-h3: a Quality choice 'Fast · Pika Flex (6 steps)' beside Standard (Turbo v4, 8) and Sharper (20). Since it needs the Ref2VA partition too, show the extra download on /connect.

3. A References mode on the open engine for H3: the Video studio's existing reference images and clips gain an audio slot (voice or music) when the model is H3 Flex; validation of the limits above before upload; a clear order ('Image 1, Image 2, Clip 1, Voice 1') the prompt can cite. Cinema: @Elements and reference clips feed Ref2VA on the open engine. Lipsync & avatars: 'Talk from a voice clip' = one image + one audio reference + words (H3 makes the clip with its own sound): label it as generation, not lip-sync of existing footage.

4. Do not replace Character swap's Akatz LoRA graph (a different LoRA on the same partition); Character Swap Studio is untouched.

5. CLOUD: Pika H3 Flex itself is not on fal or Replicate (fal's full catalog on 2026-11-01 has no Pika H3 endpoint). Its base, MiniMax H3, is hosted with LoRA support (minimax/h3/image-to-video/lora, minimax/h3/reference-to-video/lora): fetch both schemas and check whether they accept these Diffusers-format adapters by URL AND let the run use Pika's 6-step schedule; build a cloud route only if both are true. If fal runs its own step count, the adapter would run off its training schedule: then Flex is open-engine only, and the cloud keeps today's hosted H3 under its own name.

6. Licence rows (adapters, NOTICE text, the H3 base) in Settings → Models & licences, switched on.

Tests: library tests for the four graphs; reference-limit validation tests (12 files, 15 s per group, at least one image or video); mapping tests for Cinema and Lipsync; payload tests for the fal LoRA routes only if built; browser checks of the Video studio References tray, a Cinema take and Lipsync at 1440 and 390 px, light and dark, in demo mode. No GPU here: Pika's quality and speed claims are Pika's.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.6 nm10-music3 · Full songs on both engines: MiniMax Music 3 (vocals, up to 5 minutes), YuE2 covers and lyrics-to-song on your GPU, and Mureka 9's song tools in the cloud

_Lane R · priority P0 · effort medium · depends on none_

**Why.** Fuobe's open Music studio has only ACE-Step 1.5. MiniMax Music 3 (open weights, ComfyUI core node, also hosted on fal as minimax/music-3) writes full songs with vocals up to five minutes; round 1 already recommended it (comfyui-oss.md §TTS/music table, row 2) but it was never built. YuE2 (CC-BY-NC-4.0, ComfyUI native since v0.36) does lyrics-to-song and covers with a community LoRA trainer. In the cloud, fal added Mureka 8/9/9.5 with song extend, remix, stems and voice cloning (Sep-Oct), ElevenLabs Music v2.5 and Lyria 3.5. Music for Shorts, Faceless and Ads is a daily need.

**Where it shows up.** Audio → Music (model menu, a lyrics editor with [Verse]/[Chorus] tags, length up to 5:00), music result actions (Extend, Remix, Stems in the cloud), Faceless / Shorts / Content Factory background music pickers, Assist.

**Brief.** Models (record each with licence, revision, sizes):

- MiniMax Music 3: MiniMaxAI/MiniMax-Music3 @ 1b525ccb685a, LICENSE 'MiniMax-Music3 COMMUNITY LICENSE' (MIT-style grant with notice and compliance-with-law conditions; read it in full as data; HF licence tag empty); Comfy-Org/MiniMax-Music-3 @ 9e364ccd290a (tagged Apache-2.0): diffusion_models/minimax_music3_dit_int8_convrot.safetensors 2.5 GB (fp16 4.91, fp32 9.83), text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors 9.2 GB (pruned bf16 16.71, full bf16 18.47), vae/minimax_music3_dav.safetensors 0.22 GB. Card: songs up to 5 min (9,000 acoustic frames at 25 fps), 32 kHz 16-bit stereo, expressive vocals, lyrics with section tags ([Verse], [Chorus], [Instrumental], [Solo]); full precision under 24 GB, ~22 GB with CPU offload, 8 GB with layer streaming. ComfyUI core native; Comfy template audio_minimax_music_3 and the tutorial docs.comfy.org/tutorials/audio/minimax/minimax-music-3 (comfyui-oss.md L1928-1957 lists the same files). Hosted: fal minimax/music-3 (active since 2026-08-13; paid-model-apis.json recorded $0.002 per second: re-check).

- YuE2-3B: m-a-p/YuE2-3B @ 8f24312f1877, CC-BY-NC-4.0; ComfyUI native (v0.36.0, templates 2026-09-14; faster in v0.38.0); covers and lyrics-to-song; community ComfyUI-YuE2-Trainer (LoRA from your own mp3/wav) and the YuE2 real-audio encoder ('bring your own music'). Not on fal or Replicate (check): open engine only.

- Cloud song tools on fal (fetch every schema first): mureka/v9/generate/{song,instrumental,soundtrack} (2026-10-26), mureka/v9.5/generate/{song,instrumental,soundtrack} (2026-09-14), mureka/v8/song/extend, mureka/v8/song/remix (2026-10-23/30), mureka/api/song/stem, mureka/api/song/edit, mureka/api/voice/clone, mureka/api/generate/lyrics; elevenlabs/music/v2.5 ($0.60 per output minute per research), google/lyria-3.5. Fuobe today calls mureka/api/generate/song (cloud id mureka-song): move it to the newest version the schema supports and keep the old id working (src/lib/catalog/replaced.ts pattern if the id changes).

Open engine: graphs music-minimax-3 (core nodes; bindings: tags/style prompt, lyrics, seconds up to 300, seed; tiled decode for long songs as the template does) and music-yue2-song / music-yue2-cover (core YuE2 nodes; cover takes an uploaded song). Validate on the CPU ComfyUI. ModelDefs oss-minimax-music-3 (op music) and oss-yue2. Manifest vramGb: 24 for Music 3 int8 (guess; the card's 8 GB needs layer streaming the core node may not do: check and say), YuE2 unverified.

Cloud engine: model lines for minimax-music-3 (same model as the open one: label it 'MiniMax Music 3 · both engines'), mureka-9 (song, instrumental, soundtrack), elevenlabs-music-2-5, lyria-3-5; result actions 'Extend', 'Remix' and 'Stems' on music results through Mureka's endpoints where the source song is one Mureka can take (check whether its song id or an uploaded file is needed: mureka/api/files/upload exists).

UI: Audio → Music: a lyrics editor with section tags and a duration up to 5:00 when the model allows; 'Write the lyrics' through Fuobe's existing LLM helper; the open engine says which models are free on your GPU; Faceless, Shorts and Content Factory music pickers list the new models with lengths. Split soundtrack (DBS) is a different tool (dialogue / music / effects): do not label Mureka stems as DBS.

Tests: library tests for the three graphs; payload and price tests for each new cloud route; lyrics tag parser tests; replaced-id test if mureka-song moves; browser checks of the Music studio and a music result's actions at 1440 and 390 px, light and dark, in demo mode. No GPU or paid key here.

**Read again on 2026-11-01 for the build (corrections).** Hugging Face: MiniMaxAI/MiniMax-Music3 @ `1b525ccb` (LICENSE as stated; its HF licence tag is empty; the commercial terms also ask a product to show "MiniMax-Music3" in its interface, written authorisation above US$20M yearly revenue, and safeguards for a hosted service), Comfy-Org/MiniMax-Music-3 @ `9e364ccd` (Apache-2.0 tag; the int8 DiT 2.50 GB, pruned int8 encoder 9.20 GB, DAV VAE 0.22 GB as listed). YuE2 for ComfyUI is Comfy-Org/YuE2 @ `2f76ca75` (CC-BY-NC-4.0): `yue2_3b_int8_convrot` 3.96 GB (bf16 7.8 GB) and SheetSage2 bf16 1.39 GB (m-a-p/SheetSage2 @ `b83c3d79`, CC-BY-NC-4.0), which the cover template uses to read the source song's melody. The card's 8 GB figure for Music 3 is diffusers' layer-by-layer group offload; the core ComfyUI node doesn't stream layers (not measured). The CPU ComfyUI here is v0.41.0 and already has the MiniMax Music 3 and YuE2 core nodes and templates (comfyui_workflow_templates_json 0.1.112).
fal (schemas and llms.txt): `minimax/music-3` $0.002 per second (catalog created 2026-08-18), lyrics required, duration 1-300 s. Mureka's endpoints all list 2026-10-30 in fal's catalog: v9.5 song $0.50 from a prompt / $0.15 with lyrics (duration 120-300 s), v9 song $0.30 / $0.045, v9 instrumental $0.045, v9.5 instrumental $0.15, soundtracks $0.10 (a picture or clip by an id from `mureka/api/files/upload`, $0.01 an upload), v8 extend "$0.004 per request" as its page states, v8 remix $0.20, stems $0.06 / $0.20 / $0.70 by separation model (answered as a zip, plus a MIDI zip), song edit $0.10, voice clone $5.00, lyrics $0.009. Extend, remix and edit take a `song_id` from a Mureka answer or an uploaded file's id. The versioned `mureka/api/generate/song` still answers but its catalog entry lost its metadata; its 9.5 price is $0.50 / $0.15 (Fuobe had recorded $0.75 / $0.225). `elevenlabs/music/v2.5`: $0.60 per output minute, rounded up to a whole minute; a seed only with a composition plan, where lyrics also go (timed chunks). `google/lyria-3.5`: $0.10 a generation, lyrics and section timings in the prompt, no negative prompt; not on Replicate. YuE2 is hosted on neither (fal's `fal-ai/yue` page is gone; Replicate's `fofr/yue` is YuE s1-7B, the first version).

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.7 nm10-qwen21-fast · Qwen-Image 2.1 in 2-6 steps and on 16 GB cards: speed LoRAs, the 0.8B-encoder build, and the 2.1 Next-Scene LoRA in Storyboard

_Lane R · priority P0 · effort small · depends on none_

**Why.** Qwen-Image 2.1 is Fuobe's open default for Edit and Inpaint (and the Image default for accounts and guests). In five weeks the community shipped official and third-party 2-6-step LoRAs, a cleaner VAE decoder and Zen Image Edit, which swaps the 17.5 GB Qwen3-VL-8B encoder for a 1.7 GB one. Together they make 2.1 several times faster and usable on 16 GB cards. akhaliq's 2.1 Next-Scene LoRA (Apache-2.0) lets Storyboard leave Qwen-Image-Edit 2509.

**Where it shows up.** Image, Edit, Inpaint / Outpaint studios (Options → Speed: Draft · Fast · Turbo · Full), /connect (a 'small GPU' route), Storyboard and Cinema 'next scene', the Canvas edit node.

**Brief.** What exists: workflows qwen-image-21-{t2i,edit,inpaint,outpaint,turbo-edit}, the official Turbo checkpoint (8 steps, CFG 1), ModelDefs oss-qwen-image-21 and -turbo; Storyboard's next scene runs storyboard-qwen-edit-2509-next-scene. Read them first.

Candidates (record licence, revision, size, settings for each; pick by test on the validation server's graph check only, since there is no GPU):

- lightx2v/Qwen-Image-2.1-Lightning @ 6b0a1176327c: 4-step DMD LoRA for t2i and multi-reference edit (Apache-2.0 per comfyui-wiki 2026-10-13; HF tag empty: confirm from the repo LICENSE).

- linoyts/Qwen-Image-2.1-DMD2-2steps @ 5bae28369ece: 2 steps at CFG 1, t2i and multi-ref edit (Qwen Research License).

- PrunaAI/P-Q-Image-2.1 v0.2 (2026-10-27; Qwen Research): two 6-step adapters (one with the prompt upsampler distilled in, one for preservation edits), strength 1.0, Euler, CFG 1, custom ManualSigmas schedules (not interchangeable with v0.1), six official ComfyUI workflows in P-Q-Image-2.1-Comfy.

- The official Qwen-Image 2.1 Fun Acc 4-step LoRA (346 MB, own sigma schedule; Qwen Research).

- AiArtLab/zen-image-edit @ 3d5717559ff5 (Qwen Research): Qwen3.5-0.8B encoder (1.7 GB fp16) + a 158M fusion adapter (adapter_v12.safetensors 0.64 GB) reproducing the 17.5 GB encoder's conditioning (cosine 0.95 text / 0.97 vision); a decoder-only VAE finetune (lattice artefacts 2.631 -> 0); ~17.5 GB resident at 1024 px; English only; numerals on signs can be wrong. Two ComfyUI routes, both custom: recoilme/zen-image-edit-comfyui (needs transformers >= 5.17: check the pinned environment) or the t8star single-file loader (Manager-installable).

- Texture-Fix VAE for Qwen-Image 2.1 (2026-09-24): a retrained decoder that loads like any VAE.

- akhaliq's Qwen-Image-2.1 Next-Scene LoRA (2026-10-07; Apache-2.0 per comfyui-wiki; the HF API refused an anonymous read: confirm) and Multiple-Angles LoRA (72 azimuth/elevation framings): the latter is only a note for qma-angles (the QMA LoRA is the pick).

Build:

1. Options → Speed on every Qwen-Image 2.1 graph: Draft (2 steps, DMD2), Fast (4 steps: Lightning, or Fun Acc if it validates better), Turbo (8, today), Full (base). One LoraLoaderModelOnly + ManualSigmas branch per tier, chosen by binding; the prompt-upsampler 6-step Pruna adapter as 'Fast · writes the details' if it validates. Defaults unchanged.

2. A 'Small GPU (16 GB)' encoder route with Zen Image Edit for t2i and edit, picked automatically by the readiness chooser when VRAM < 24 GB (reuse the H3 tier chooser from nm10-h3-any-gpu if it has landed; otherwise a local function), with its English-only note in the model card.

3. Texture-Fix VAE as Options → Decoder 'Clean' (default off until tested).

4. Storyboard and Cinema 'next scene' on the open engine: a qwen-image-21-next-scene graph with the 2.1 Next-Scene LoRA; keep the 2509 graph as the fallback and for the cloud (fal hosts the 2509 next-scene gallery LoRA, not 2.1: Qwen-Image 2.1 is not hosted on fal or Replicate, so all 2.1 speed routes are open-engine only).

5. Licence rows for each LoRA / encoder / VAE, switched on.

Tests: library tests (each tier's sigmas, LoRA pins, sizes), chooser tests, Storyboard mapping tests; browser checks of the Speed control and Storyboard at 1440 and 390 px, light and dark, in demo mode. No GPU here: speed and quality claims are the authors'.

**Checked at the sources while building (2026-11-01).** Corrections and additions to the candidates above:

- Lightning (`lightx2v/Qwen-Image-2.1-Lightning` @ 6b0a1176): still no LICENSE file and no licence tag in the repository, so its licence stays "not stated" (comfyui-wiki's Apache-2.0 is unconfirmed). One file, `pytorch_lora_weights.safetensors` (67,144,280 bytes, diffusers keys). The card's schedule is [1.0, 0.75, 0.5, 0.25] with exponential dynamic shifting (base_shift 0.5, max_shift 0.9, 256-8192 tokens; Qwen-Image 2.1 has one token per 16 × 16 px), i.e. 1.0, 0.857192, 0.666756, 0.400096 at 1 MP.
- DMD2 (`linoyts/…-DMD2-2steps` @ 5bae2836): the pinned revision also holds a **v1.5** file (`pytorch_lora_weights_v1_5.safetensors`, 2026-10-30, better prompt adherence and edit fidelity, same settings); licence confirmed as Qwen Research (card and NOTICE). Sigmas [1.0, 0.5], no shift.
- Pruna: the ComfyUI export is `PrunaAI/P-Q-Image-2.1-Comfy` @ aa7dcecb (the base repo is @ b479282e). Both v0.2 adapters load with the core LoraLoaderModelOnly (344 MB each); v0.2 ManualSigmas 1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.222292, 0; strength 1, euler, CFG 1; trained at 1K only; at most 3 references for edits. "6-steps-upsampled" is the one with the prompt upsampler distilled in; "6-steps" is the preservation one.
- Fun Acc (`alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs` @ f7545234, 345.6 MB, Qwen Research): not a plain LoRA. It is a Parallel Decoding Distillation export that replaces the output head and overrides the attention norms (`pdd_config.json`, `lora_utils_pdd.py`), with its own 4-step grid 1.0, 0.917, 0.786, 0.549, 0; core ComfyUI can't load it as a LoRA, so Fast uses Lightning.
- Zen Image Edit: the 0.64 GB `adapter_v12.safetensors` isn't in the Hugging Face repository (`AiArtLab/zen-image-edit` @ 3d571755 holds the merged diffusers model, 14.5 GB DiT + 1.7 GB encoder + VAE); it is a GitHub release asset of `recoilme/zen-image-edit-comfyui` (release v2 @ 7a29e58c, nodes Apache-2.0, `transformers>=5.17`: the pinned ComfyUI's venv has 5.22.1). Its loader reads the adapter by path and fetches Qwen/Qwen3.5-0.8B by id. Fuobe tracks the adapter as a pinned download in models/text_encoders (release v2, 638,987,136 bytes, sha256 85578cd0b41dfac3fad1845be2755971367deee5348a692feb589a09d120ea8c, read 2026-11-01) and binds its full path from the server's model folders; Qwen/Qwen3.5-0.8B is pinned at 2fc06364715b967f1860aea9cf38778875588b17 (Apache-2.0) in its setup command, and used from models/text_encoders/qwen3.5_0.8b when present. Auto picks this route only on a card under 20 GB where the pre-flight reads it ready (a 24 GB card reads about 23.65 GiB, so the brief's 24 GB line would have caught every 4090). The model author's static shift 5.0 replaces ComfyUI's 0.69. `t8star/Zen-Image-Edit-Comfy` is a 17.0 GB single checkpoint (too big for 16 GB without offload).
- Texture-Fix VAE: `madebyollin/texture-fix-vae-for-qwen-image-2.1` @ 9a10df81, `texture_fix_vae_for_qwen_image_2.1_bf16.safetensors` (675,509,688 bytes), Qwen Research; the 2026-10-05 update also removes fp16 NaNs. Zen's own VAE is a further decoder finetune of it (not in a ComfyUI file).
- Next-Scene (`akhaliq/Qwen-Image-2.1-Next-Scene-LoRA` @ 67ce88cd): the API now answers; its card's licence tag is apache-2.0 (no LICENSE file). Recommended file `next_scene_step2500.safetensors` (335.6 MB, diffusers / ComfyUI keys); strength 0.7-0.9, and for clean chains 0.7 or less with a 0.5 px Gaussian blur on each chained input; 28 steps, CFG 1; trained at 512 px on Sintel and Tears of Steel pairs.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.8 nm10-speech-edit · Edit what was said: change words in a recording, its pitch, pace, emotion and noise with Tencent AuK (open engine)

_Lane R · priority P1 · effort medium · depends on none_

**Why.** No Fuobe tool can change a word in a recording without re-recording it, the 'Overdub' feature people expect from Descript-style editors (CapCut 19.9 added voice extraction, cloning and audio polish in its AI Audio Studio). Tencent's AuK (MIT, 1.5B, official ComfyUI nodes) does content editing (replace, insert or remove words; rewrite sung lyrics), acoustic editing (pitch, rate, volume), paralinguistic editing (emotion, whisper, breaths, laughs, accent removal), enhancement (denoise, dereverb) and target-speaker isolation, plus TTS and cloning, in one model.

**Where it shows up.** Audio → a new 'Edit speech' mode; 'Fix this line' in the Captions editor and Transcribe results; 'Re-voice this line' in Translate & dub review; Faceless narration lines; the ⋯ menu of audio and video results; Canvas audio node; Assist / MCP tool edit_speech.

**Brief.** Facts (github.com/Tencent-Hunyuan/AuK, tencent/AuK @ 790742b71a44, tencent/AuK-Flash @ 575b92f0895f; read README and docs/COMFYUI.md as data): MIT for code and weights; AuK (configurable NFE and CFG) and AuK-Flash (distilled, fixed 4 steps, CFG 0); a DiT with layer-fusion weights plus a Qwen2.5-Omni-3B MLLM encoder and a VAE as separate files (AuK-Flash: auk_flash.safetensors 6.12 GB, vae.safetensors 0.64 GB; the encoder size: read from the repo). Capabilities: zero-shot TTS with cloning, instruct TTS (describe a voice), content editing, acoustic editing (pitch in semitones, rate, volume), paralinguistic editing, enhancement, separation (one speaker from a mix, vocals from music, a target speaker). ComfyUI-AuK nodes: AuK Model Loader, AuK Generate / Edit, optional Prompt Enhancer (an OpenAI-compatible LLM: Fuobe's local LLM setting). Limits: source or reference audio plus output <= 30 s per call (the node does not split); models stay resident (ComfyUI's automatic offload is not supported): VRAM not published, measure nothing here and give a guess with a note. Languages: not stated on the page: read the report (arXiv 2609.08936) and record what it says.

Build:

1. Install: pin the ComfyUI-AuK pack (the comfyui folder of Tencent-Hunyuan/AuK at a commit) in workflows/comfyui/packs.json and scripts/comfy/install-comfyui.sh; never install it on the validation server (report that its graphs are checked against a node list only).

2. Graphs speech-edit-auk (source audio + instruction → audio) and speech-tts-auk (text + optional reference): hand-built from the bundled auk.json; pins and sizes; ModelDef oss-auk with ops speech-edit (new op name, or reuse 'voice-change' with a sub-mode: pick what the catalog types allow with the least churn), tts.

3. The editing flow (pure, tested library src/lib/speech-edit.ts): transcript with word times (Qwen3-ASR / Whisper graphs Fuobe has) → the user edits the text → diff to the smallest changed span → a window of <= 30 s around it, cut at silences, with at least 1 s of untouched context on each side → AuK's content-edit instruction ('replace "X" with "Y"') → crossfade the edited window back (audio-join-crossfade graph or the server's ffmpeg) → a new version with an A/B toggle. Several edits run as several windows. Pitch / pace / volume / emotion / whisper sliders and 'Clean up' (denoise + dereverb) and 'Keep only this speaker' run on the selected range the same way.

4. On a video: the edited audio replaces the original (video-mux-audio-replace, picture stream-copied) and the result warns when a changed word is on camera, offering Lipsync.

5. CLOUD: AuK is not hosted on fal or Replicate, so Edit speech is open-engine only; the cloud engine says 'Runs on your GPU (open source)' and Engine mode 'Paid APIs only' hides it. Hosted cleaners (VEED Clean Audio, ElevenLabs voice isolation) are dbs-d5's, under their own names: do not duplicate them here.

6. Licence row (MIT) and the Prompt Enhancer's LLM use stated in the UI.

Tests: diff and window tests (word boundaries, 30 s cap, silence cuts, several edits, edits at the start and end), crossfade timing, library tests for both graphs, MCP tool schema, browser checks of Edit speech and the Captions 'Fix this line' at 1440 and 390 px, light and dark, in demo mode. No GPU here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.9 nm10-voice-design · Design a voice from a description, and clone at 48 kHz: Qwen3-TTS on both engines, VoxCPM2 on your GPU

_Lane R · priority P1 · effort small · depends on none_

**Why.** Fuobe clones voices (Chatterbox, IndexTTS2, ElevenLabs, MiniMax) but cannot make a new voice from words ('a warm, gravelly 60-year-old narrator'). Qwen3-TTS 1.7B (Apache-2.0) does voice design and cloning and is hosted on fal with the same model, so it gives both engines one feature; VoxCPM2 (Apache-2.0, 8 GB, 30 languages incl. nine Chinese dialects, 48 kHz) is trending on Hugging Face with ComfyUI nodes. Both were researched in round 1 (comfyui-oss.md L1500-1531; paid-model-apis-2.md L282-311) and never built.

**Where it shows up.** Audio → Voice: a 'Design a voice' tab (describe → three takes → save as an Element voice); the voice pickers in Dialogue, Faceless narrator, AI Influencer and Translate & dub; Elements → Voices.

**Brief.** Models:

- Qwen3-TTS 1.7B (12 Hz): Qwen/Qwen3-TTS-12Hz-1.7B-Base and its VoiceDesign / CustomVoice siblings (Apache-2.0; ~6-8 GB; read the cards for the voice-design model id and record revisions). ComfyUI: custom packs 1038lab/ComfyUI-QwenTTS (pick one, pin a commit; flybirdxx/ComfyUI-Qwen-TTS and DarioFT/ComfyUI-Qwen3-TTS are alternatives). Hosted on fal (active since 2026-01-26): fal-ai/qwen-3-tts/voice-design/1.7b (a prompt describes the voice; returns audio only, no reusable id: clone the result to reuse it), fal-ai/qwen-3-tts/clone-voice/1.7b (audio <= 5 min → a speaker_embedding file; $0.0008 per minute), fal-ai/qwen-3-tts/text-to-speech/1.7b (voice enum or speaker_voice_embedding_file_url; $0.09 per 1,000 characters). Fetch the schemas first.

- VoxCPM2: openbmb/VoxCPM2 @ 32279effe8c1 (Apache-2.0; 2B; ~8 GB; 30 languages; 48 kHz output from 16 kHz references; voice design from a description; 'controllable' cloning from a short clip and 'ultimate' cloning with the clip's transcript). ComfyUI: Saganaki22/ComfyUI-VoxCPM2 (TTS with an optional voice-design field, Voice Clone, LoRA training nodes) or RunningHub's ComfyUI_RH_VoxCPM (one node for design and both clone modes; model folder models/voxcpm/VoxCPM2/). Not hosted on fal or Replicate: open engine only.

- Considered, not built: Fish Audio Drama 3 (fishaudio/drama-3; Fish Audio Research License; 35B MoE ~40 GB; 16 speakers, bracketed directions, 83 languages): no local ComfyUI node (only the Fish Audio API partner node) and not on fal or Replicate; it would need an SGLang-Omni worker. Record it in the research JSON for a later package.

Build:

1. Graphs tts-qwen3-design, tts-qwen3-clone, tts-voxcpm2 (design / clone / ultimate clone), pinned packs and files, validated against node lists (packs are not on the validation server: report it). ModelDefs oss-qwen3-tts and oss-voxcpm2 (ops tts, voice-design).

2. Cloud model qwen-3-tts with routes voice-design, clone (two steps: clone-voice then text-to-speech with the embedding file; store the embedding as the Element voice's asset) and tts. Label it 'Qwen3-TTS · both engines'.

3. Design a voice: a description box with starter chips (age, gender, accent, tone, pace), a test line, three takes, 'Save as voice' → an Element voice that stores the model, the description and (for reuse) a reference clip or embedding, so later lines reuse the same voice on either engine (on the cloud a designed voice is re-used by cloning the chosen take, as fal's page says).

4. Voice pickers: designed voices appear wherever Element voices do, with their engine.

5. Licence rows (Apache-2.0 for both; fal as a paid API), switched on.

Tests: Element voice storage tests, payload tests for the three fal routes and the two-step clone chain, library tests, browser checks of Design a voice and the Dialogue picker at 1440 and 390 px, light and dark, in demo mode. No GPU or fal key here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.10 nm10-keying · Green screen and fine hair: CorridorKey 2.0 keying and Bria VRMBG 3.0 matting on your GPU, FeyNoBg for stills, Bria's despill and guided cut-outs in the cloud

_Lane R · priority P1 · effort medium · depends on none_

**Why.** Fuobe's video matte uses BiRefNet or SAM 3.1 on the open engine and Bria VRMBG 3.0 in the cloud; none of them keys green-screen footage with despill, and none is tuned for hair. In October Corridor Digital released CorridorKey 2.0 (native-resolution neural keying, linear EXR, 4-6 GB), ComfyUI-RMBG 3.3.0 brought Bria's VRMBG 3.0 (the same model Fuobe's cloud matte calls) and FeyNoBg hair matting to ComfyUI, and fal added Bria's green-screen despill and a guided cut-out that takes 'keep the shadow'.

**Where it shows up.** Video tools → Matte: a 'Green screen' mode and a 'VRMBG 3.0' choice on the open engine; Image and Layers cut-outs: 'Fine hair' (open) and 'Guided' (cloud, with a what-to-keep box); exports through the existing ProRes 4444 / EXR export; Canvas matte node; Character Swap Studio Finish (person cut-outs).

**Brief.** Models (record licence, revision, size):

- CorridorKey 2.0: nikopueringer/CorridorKey2.0 @ cf44a8db3f02, corridorkey_v2.safetensors 2.66 GB (+ foundation_stats.safetensors); licence 'corridor-key-licence-2.0' (a CC BY-NC-SA 4.0 variant: free use including commercial projects; selling it or offering it as a paid API or inference service is not allowed; derivatives under the same licence; organisations above US$20M revenue need a seat per user): record it as information and keep it on the open engine. Per-frame matte plus clean foreground, optional hints, scene-linear OpenEXR; NVIDIA RTX 30+; 4 GB up to 1440p, 6 GB for 4K. ComfyUI: community wrappers pixelworldai/ComfyUI-CorridorKeyWrapper (loader, Chroma Key Prepass, Greenscreen node with alpha, despilled foreground, RGBA; it auto-downloads CorridorKey_v1.0.pth), TrentHunter82/TrentNodes (CorridorKey Green Screen Keyer, linear-input switch), SeanBRVFX/ComfyUI-CorridorKey. CHECK which loads the 2.0 weights; if none does, build on v1.0 and say v2 waits for a wrapper.

- Bria VRMBG 3.0 open weights: briaai/VRMBG-3.0 (gated, manual approval; licence bria-vrmbg-3.0) through ComfyUI-RMBG v3.3.0's AILab_VRMBG node (2026-10-20; conditions each frame on the previous frame; reset_state for batches; weights downloaded by hand to models/RMBG/VRMBG-3.0/). It is the model behind Fuobe's cloud bria/video/background-removal/v3, so the matte becomes the same model on both engines when the owner has access.

- FeyNoBg: 1038lab/FeyNobg (263M Swin-L matting, 1.05 GB, built-in foreground refine, no trimap; licence not stated: record 'unknown') via ComfyUI-RMBG 3.3.0. Also in the pack: Finegrain Box Segmenter, YOLO26-seg.

- LTX-2.5 IC-LoRA Alpha-Gen (Lightricks, LTX-2.x Community License, gated; beta 0.9 at step 25,000; a grayscale matte the same size as the input; aimed at hair, fur, smoke, glass, water; one tester saw ~90 GB at 3200x1900 for 49 frames): offer as 'Best · Alpha-Gen' only on 48 GB+ and only if the LTX-2.5 IC-LoRA graph validates; otherwise record it for later.

- Cloud (fal; fetch schemas): bria/video/background-removal/green-screen-despill (2026-08-27: chroma footage with spill suppression) and bria/guided-remove-background (2026-10-10; $0.03 per image; plain-language corrections such as 'keep the shadow', 'remove the hand'; optional autocrop).

Build:

1. Graphs video-key-corridorkey (video → RGBA / matte / despilled foreground; chunked like video-bg-remove-*), video-matte-vrmbg3, image-matte-feynobg; packs pinned (ComfyUI-RMBG at the 3.3.0 tag; the chosen CorridorKey wrapper); validation against node lists where the packs are missing on the server.

2. Video tools → Matte gains 'Green screen' (open: CorridorKey; cloud: Bria green-screen despill, labelled as Bria) and 'VRMBG 3.0' (open, when the gated weights are present; /connect explains the gate). Outputs: transparent WebM as today, plus 'ProRes 4444' and 'EXR (linear)' through video-export-pro / video-export-exr.

3. Image cut-outs (Image tools, Layers 'Cut out', Save as element): 'Fine hair (FeyNoBg)' on the open engine; 'Guided' in the cloud with a 'what to keep or drop' text box.

4. Character Swap Studio Finish and Remove object reuse the new matte where it is better (offer, do not switch defaults).

5. Licence rows (CorridorKey's paid-API restriction stated plainly; VRMBG gated; FeyNoBg unknown), switched on.

Tests: library tests, chunking tests, export path tests, payload tests for both Bria routes, browser checks of Matte and the image cut-out at 1440 and 390 px, light and dark, in demo mode. No GPU here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

**Checked while building (2026-11-02).**

- ComfyUI wrappers for CorridorKey 2.0 (re-checked 2026-11-02, shallow clones). The three the brief named (pixelworldai/ComfyUI-CorridorKeyWrapper `7eb44e48`, SeanBRVFX/ComfyUI-CorridorKey `0f724f7c`, TrentNodes `3d80a9df`) load only `CorridorKey_v1.0.pth` (nikopueringer/CorridorKey_v1.0, 0.40 GB; Corridor Key Licence 1.0), and pixelworldai's pip-installs Corridor's v1 engine from GitHub's main branch the first time it loads. Three newer packs load the 2.0 weights, all under the Corridor Key Licence 2.0: hashu786/ComfyUI-CorridorKey2 (`d1228b68`, 2026-10-28; one `CorridorKey2` node: image, optional hint mask; outputs fg, matte, processed, QC, RGBA cutout; vendors Corridor's `corridorkey/` package at `485f5e9` byte for byte), miguelangelarribas/ComfyUI-CorridorKey2 (`ab948899`, 2026-10-29; loader + keyer, also vendors `485f5e9` unmodified, with a parity test against upstream) and marawan206/ComfyUI-CorridorKey2.0 (`c3abf212`, 2026-11-02; a large pack with fine-tuning and analysis nodes; it patches upstream's `blocks.py` for newer PyTorch). Fuobe builds on hashu786's: the simplest graph (one node gives the RGBA cut-out, the matte and the despilled foreground), Corridor's code unchanged, nothing pip-installed at run time, and its first-run download fetches the three frozen models at pinned revisions (C-RADIOv4-SO400M `c0457f5d` 1.72 GB, MoGe-2 ViT-B `ca5f0e07` 0.42 GB, RVM small 0.27 GB md5-checked) and Corridor's weights from the main revision (`cf44a8db` when checked: corridorkey_v2.safetensors 2,661,698,720 B, sha256 c43596de…). About 5.1 GB in all, into models/corridorkey2/. v1.0 is dropped: 2.0 keys at native resolution in 4-6 GB, where v1 needs about 10 GB at its 2048 px working size. Both versions' despill takes out green only.
- Corridor Key Licence 2.0 (LICENSE at `cf44a8db`) adds two terms the summary above leaves out. Nobody may charge for access to the code or weights. A commercial software package or inference service that wants to include it needs a written agreement with Corridor Digital.
- ComfyUI-RMBG has no 3.3.0 tag. It is pinned at commit `a66a5e64` (2026-10-20, version 3.3.0). FeyNoBg also needs the `nobg` Python package.
- VRMBG 3.0's card says "non-commercial use only; commercial use requires a commercial agreement with Bria AI". The repo is `59716e19`, and `model.safetensors` is 0.88 GB.
- FeyNoBg's licence is **unknown**: the Hugging Face repo (`59dd27c6`) has no card, no licence tag and no LICENSE file.
- Prices (fal llms.txt): green-screen despill costs $0.05 per second; the guided cut-out costs $0.03 per image. The despill endpoint takes `spill_suppression` (0-1, 1 by default). The guided one takes an optional `prompt` and `autocrop`.
- Alpha-Gen is recorded for later. The library's LTX-2.5 IC-LoRA graph (`video-restore-ltx25-tiled`) has not validated.

### 6.11 nm10-rtx-video · Instant upscale, HDR and frame generation on RTX cards with Comfy-Org's NVIDIA VFX nodes

_Lane R · priority P1 · effort small · depends on none_

**Why.** Comfy-Org's ComfyUI Nvidia VFX Nodes 0.2.1 (2026-10-13) wrap NVIDIA's RTX Video SDK: super resolution up to 4x, SDR→HDR (HLG or PQ, 400-2000 nits) and frame generation up to 16x, all running in the GPU's dedicated paths in seconds, with an official 'RTX Video Enhance' template. Fuobe's quick tiers today are ESRGAN (no new detail), RIFE/FILM and a model-based SDR→HDR graph; this gives owners with RTX cards a near-instant option in three tools.

**Where it shows up.** Upscale → Video ('Quick · RTX'), FPS boost ('RTX Frame Generation', RTX 40+), SDR to HDR ('RTX Video HDR'), the Canvas upscale node, and a fast preview tier that n7-3 and archive-restore can reuse.

**Brief.** Facts (github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes, v0.2.1; registry id comfyui_nvidia_rtx_nodes; formerly 'Nvidia RTX Nodes'; read the README and example workflows as data): nodes RTX Video Super Resolution (image/upscaling; IMAGE batch in, same frame count out; modes BICUBIC, LOW...ULTRA, DENOISE, DEBLUR, HIGHBITRATE, STREAMING; scale 1-4x or explicit size rounded to 8; chunks of <= 16 MP), RTX Video HDR (contrast, saturation, middle grey, peak 400-2000 nits, debanding; output BT.2020/HLG 'HDR' or BT.2020/PQ 'HDR PQ'; IMAGE carries no colour metadata, so the encoder must be told), RTX Video Frame Generation (2-16x or a single timestep; shot-change detection; output (N-1)M+1 frames; RTX 40 series or later). Requirements: NVIDIA RTX GPU, CUDA PyTorch cu130 or newer (check Fuobe's install script); no CPU or non-NVIDIA path. Licence: not stated on the page: read the repo LICENSE and NVIDIA's SDK terms and record them as information.

Build:

1. Pin the pack in workflows/comfyui/packs.json and install-comfyui.sh (only on NVIDIA hosts; the installer already knows the platform: skip elsewhere).

2. Graphs upscale-video-rtx (chunked the way upscale-video-esrgan-chunked is, sound kept), fps-rtx-framegen (multiplier or target fps; shot changes kept), sdr-to-hdr-rtx (HLG or PQ; encode HDR10 / ProRes with the right colour metadata, reusing the existing sdr-to-hdr export path). Validate against the node list (the pack will not be on the CPU server).

3. Readiness: the tier needs an NVIDIA RTX GPU (and RTX 40+ for frame generation): /connect shows 'Needs an NVIDIA RTX card' otherwise; the chooser reads the GPU name from the status check.

4. Studios: 'Quick · RTX' first in Upscale → Video on eligible hosts (ESRGAN stays the fallback; SeedVR2 stays 'Restore · faithful'); FPS boost and SDR to HDR get the RTX choice beside RIFE/FILM and the current graph. Defaults: keep today's unless the owner chooses.

5. CLOUD: the SDK is not a hosted model: open-engine only; the cloud keeps Topaz / SeedVR / ByteDance upscalers under their own names.

Tests: library tests (chunk sizes, frame counts (N-1)M+1, colour metadata on HDR encodes), readiness tests for GPU names, browser checks of the three studios at 1440 and 390 px, light and dark, in demo mode. No GPU here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.12 nm10-hosted-catchup · Hosted catch-up: Vidu Q4, H3 Max lip-sync, relight, insert and styles, H3 Max Turbo, H3 Lite and HighSpeed, Meshy retexture and Tripo P2

_Lane R · priority P1 · effort medium · depends on none_

**Why.** fal added (or Fuobe's research recorded) a dozen hosted models in September-October that fill real gaps but never reached the catalog: an H3 lip-sync that takes 15 minutes of audio, H3 relight of real footage, inserting a generated moment into the middle of a clip, five H3 looks, cheap H3 Max Turbo, Vidu Q4 with references, 3D retexturing and Tripo's production tier. Each is a catalog line plus a placement.

**Where it shows up.** Lipsync & avatars, Video tools → Relight, Edit video ('Insert a moment'), Effects / Mixed Media looks, the Video studio menu, Image to 3D ('Retexture'), Assist.

**Brief.** For every endpoint: fetch the OpenAPI schema with the existing scripts, add or update the record in the research JSON (prices from the page), add model() lines in scripts/gen-cloud-models.py, regenerate the catalog, add mock results and payload tests. These are closed hosted models: cloud-only, hidden by 'Open source only'; the open engine keeps its own tools.

1. minimax/h3-max/lip-sync/image-to-video (2026-09-17): image (aspect 0.4-2.5) + audio 5 s to 15 min → video the audio's length; 480P / 768P (default) / 1080P / 2K; optional enable_transcription; $0.05 / 0.08 / 0.16 / 0.32 per second, x1.2 over 15 s. Lipsync & avatars model menu ('H3 Max Lip Sync · up to 15 min'); priced on the audio length.

2. minimax/h3-max/relight (2026-10-07): source <= 15 s (resampled to 24 fps) + reference_image_url, which is a render of a lit sphere showing the target light (paid-model-apis-2.json notes): render the sphere in the browser from Fuobe's light presets (the relight tools already have presets); $0.05/s at 480p and up. Video tools → Relight cloud choice.

3. minimax/h3-max/insert-video (2026-09-28): generates a scene between start_time and resume_time inside a clip ($0.05-0.06 per generated second). Edit video → 'Insert a moment' with a two-handle range on the timeline.

4. minimax/h3-max/styles/{16bit-pixel, hand-drawn, low-poly, retro-toon-70s, vhs} (2026-09-17): text or first frame → 5-15 s clip in the look, with audio; VHS has damage_level light | medium | heavy; $0.08/s at 768p. Effects / Mixed Media 'looks' as generation (not video-to-video: say so in the card).

5. minimax/h3-max-turbo/{text-to-video, image-to-video, reference-to-video, extend-video} (2026-09-02 / 10-01 / 10-09): $0.01625-0.052 per second by resolution: 'H3 Max Turbo' in the Video studio menu and as Cinema's cheap draft model.

6. Replicate minimax/h3-lite and minimax/h3-highspeed (listed as latest on replicate.com/explore on 2026-11-01): fetch the schemas; add if they map onto existing ops.

7. fal-ai/vidu/q4/image-to-video and reference-to-video (2026-10-05; $0.0315/s at 540p and up; Vidu says Q4 takes up to 15 image and 3 audio references with synced audio up to 4K: record what the fal schema actually exposes). Video studio menu; references through the existing ref2v plumbing.

8. meshy/v7/retexture and meshy/v6/retexture (2026-10-14): a 3D model + text or image style → retextured model. Image to 3D: a 'Retexture' action on 3D results (cloud). Tripo P2 (tripo3d/p2/image-to-3d, $1.00-1.30 per model) as a production-tier choice in Image to 3D.

9. Not in this package: Kandinsky 6 (nm10-kandinsky6), Kling 4 (nm10-kling-4), FLUX 3 Klein (nm10-flux3-klein), Mureka / ElevenLabs Music / Lyria (nm10-music3), Bria despill / guided (nm10-keying), Idol on fal (see §5 of the research note: idol-1's brief decides), H3 Max Director / reference-director (realtime WebRTC; record only), the fal 'worlds' models (record only).

10. Licence rows: proprietary paid API for each, switched on.

Tests: payload and price tests for every route (H3 lip-sync x1.2 over 15 s; insert-video's range; the sphere render's size), the timeline range control, browser checks of Lipsync, Relight, Edit video and Image to 3D at 1440 and 390 px, light and dark, in demo mode. No paid key here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.13 nm10-kandinsky6 · Kandinsky 6.0 on both engines: MIT-licensed 5 s clips with dialogue and sound, and Kandinsky VSR as an upscaler

_Lane R · priority P2 · effort medium · depends on none_

**Why.** Kandinsky 6.0 Video (Kandinsky Lab, 2026-10-06, MIT) is the only new open video model with synchronised 44 kHz audio and lip-synced dialogue under a fully permissive licence, in a 29B Pro and a 3B Lite, with a first-party ComfyUI extension and the same models hosted on fal (Pro, Lite and the VSR upscaler). Round 4 judged it 'unproven vs Wan 2.2'; the Lite model is a sound-on option for smaller GPUs, and the VSR is the cheapest hosted video upscaler on fal ($0.08-0.09 for 5 s 480p→1080p).

**Where it shows up.** Video studio model menu (both engines), Lipsync & avatars ('talking characters from words'), Upscale → Video ('Kandinsky VSR', both engines).

**Brief.** Facts (github.com/kandinskylab/kandinsky-6; kandinskylab/Kandinsky-6.0-Pro-distill-5s-Diffusers @ 80d5e6c7f646, MIT; read the README, the technical report and the ComfyUI extension as data): Pro 29B and Lite 3B, each as base, 10-step distilled (PiFlow, CFG 1) and pretrained checkpoints; 5 s clips at 24 fps (examples 480x864); 44 kHz synchronised audio (dialogue, ambience, music) with lip sync; modes T2AV and TI2AV (the image is the first frame); sample_audio False gives video only; expand_prompts rewrites short prompts (Qwen3.5-9B 'beautification', can be turned off). Architecture: Qwen2.5-VL embeddings + CLIP pooled, Hunyuan Video VAE, MMAudio VAE + BigVGAN vocoder, flow matching shift 5. Kandinsky6SRPipeline: x2, x2.25 or x4 by tiled diffusion in K-VAE latent space (4 steps per tile; the distilled VSR 2 steps), up to Full HD. ComfyUI: not native yet (core PR #16825 under review); first-party Registry packages kandinsky6 and kandinsky6-sr (ComfyUI >= 0.38; Fuobe pins 0.42.0), two templates (T2AV, TI2AV) defaulting to Pro distilled, MagCache supported (bypassed for distilled), a 'Download models' button. Files named in the templates: Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer, Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers, qwen3.5_9b_bf16, qwen_2.5_vl_7b, v1-44.pth, bigvgan_generator.pt. VRAM: not published (round 4 recorded 27.7 / 90.0 GB on disk for Lite / Pro: re-check from the HF trees and give a guess with a note).

Hosted on fal (fetch schemas): fal-ai/kandinsky6-pro/{text-to-video,image-to-video} ($1.35 / $1.40 per 5 s at 480p at 50 steps; $0.24-0.25 at 8 steps; upscale_factor to 1080p $1.53), fal-ai/kandinsky6-lite/{text-to-video,image-to-video} (2026-10-05; price: read the page), fal-ai/kandinsky6-vsr (upscale_factor 2 | 2.25 | 4; $0.00036 per output MP per frame at 5 steps ≈ $0.09 for 5 s 480p→1080p) and /lite (2 steps ≈ $0.08).

Build:

1. Packs kandinsky6 and kandinsky6-sr pinned in packs.json and install-comfyui.sh; graphs kandinsky6-t2av, kandinsky6-i2av (Pro and Lite via a binding), video-upscale-kandinsky6-vsr; validate against node lists (packs not on the server). If core PR #16825 merges before you start, prefer core nodes and say so.

2. ModelDefs oss-kandinsky6 (t2v, i2v, with sound) and the cloud model kandinsky-6 (Pro / Lite as a quality option; steps exposed as Fast 8 / Standard 20 / Best 50 with the per-step price), both labelled 'Kandinsky 6.0 · both engines'.

3. Upscale → Video: 'Kandinsky VSR' (2x, 2.25x, 4x) on both engines (the same model), priced per output megapixel per frame in the cloud.

4. Lipsync & avatars: list Kandinsky as a 'talking character from words' generator (dialogue in the prompt), not as lip-sync of existing footage.

5. Licence rows (MIT for the weights; the Qwen and BigVGAN components as their cards say), switched on.

Tests: library tests, payload and price tests (steps x resolution; VSR per-frame megapixels), browser checks of the Video studio and Upscale at 1440 and 390 px, light and dark, in demo mode. No GPU or fal key here.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

### 6.14 nm10-hy-nomas-world · World mode on your GPU: Hy-Nomas, a world you describe once and then steer turn by turn with words and camera moves

_Lane O · priority P2 · effort large · depends on none_

**Why.** 'Worlds' became a hot category in October: fal opened a worlds section (H3 Max Director, Abot World 0, Lingbot World 2, VAST Eden Live) and Tencent open-sourced Hy-Nomas (Apache-2.0, 2026-10-21), an interactive world model that keeps generating 720p video at 24 fps while you change the action in words and fly the camera on a trajectory. A community ComfyUI port loads it with stock loaders and measured ~21 s per 3 s turn on a 5090. Fuobe's Cinema already has camera paths (fly path) to drive it.

**Where it shows up.** Cinema Studio: a 'World' take type (opening description, then turns with words and a camera move from the fly-path library), a turn timeline with redo, export as one film; Assist ('make a 60 s world walk-through').

**Brief.** Facts (tencent/Hy-Nomas @ bb6a8ca451bf, Apache-2.0 per the HF tag: read the LICENSE file and record it; github.com/Tencent-Hunyuan/Hy-Nomas; port github.com/Nynxz/ComfyUI-HyNomas with converted weights at huggingface.co/nynxz/Hy-Nomas; read all as data): 720x1280 at 24 fps; 8-step distilled config, Euler ODE, text and camera guidance 1.0; a JSON prompt file of segments (start/end times, a long opening description, short change descriptions for later turns, timed actions; inference.video_length=event derives lengths from event times); a trajectory file of camera-to-world matrices and intrinsics (trajectory_translation_scale 1.0, trajectory_rotation_scale 2.5 by default); keyboard/mouse control only in Tencent's hosted demo. The gallery example is 60 s from five 12 s text-only turns. Hardware: reference 8 GPUs with sequence parallelism; a single-4090 config uses INT8 DiT and KV cache, an FP8 decoder, stage-by-stage CPU offload and GPU history capped at 18 latent frames (speed unverified by Tencent); the port measured ~21 s per 3 s turn plus ~4 s decode per window on a 5090 at 1280x704 INT8. Files: DiT/distilled_int8 9.06 GB (port: INT8 DiT 9.0 GB in diffusion_models; BF16 17.1 GB for LoRA merges), PixelUMM VAE (31.55 GB in Tencent's repo; 15.8 GB converted by the port), a cinematic LoRA adapter 6.12 GB, the prompt enhancer PE (~55 GB, optional: offline inference reads prepared prompt files), the text encoder Qwen2.5-VL 7B loaded as type qwen_image from Comfy-Org/Qwen-Image_ComfyUI (Fuobe may already pin it: check).

Build:

1. Pin the port (Nynxz/ComfyUI-HyNomas at a commit) and the converted weights in packs.json / model-pins.json; graph world-hy-nomas-turn: one turn = the previous turn's state (the port's history mechanism: read how it carries history between queue runs) + the turn's words + the turn's camera trajectory → 3-12 s of video; validate against the node list. If the port cannot carry history between separate /prompt calls, build the whole film as one graph with N turns and say so.

2. A pure, tested converter src/lib/world-path.ts: Fuobe's camera paths (scene3d keyframes / the fly-path library: orbits, dollies, trucks, figure-8) → Hy-Nomas camera-to-world matrices and intrinsics at 24 fps, with the default scales.

3. Cinema 'World' take: opening description, turns list (words + a camera move chip + seconds), Preview the path, Run turn, Redo from here (keeps earlier turns), Export (join with video-concat). Sound: Hy-Nomas makes none: offer the existing Foley / music tools after.

4. CLOUD: Hy-Nomas is not hosted on fal or Replicate: open engine only ('Runs on your GPU (open source)'; 'Paid APIs only' hides it). fal's worlds models (H3 Max Director realtime WebRTC sessions with a 60 s minimum; Abot World 0; Lingbot World 2 'research' licence; Eden Live) are different models, not stand-ins: record them in the research JSON; whether to offer any of them under its own name is the decision.

5. Relation to queued work: n7-9-worldcast-worker (WorldCast fly-around from one photo) is a different model and stays; reuse its camera-path pieces if they landed first.

6. /connect row: 'World mode' with the 24 GB+ (guess) requirement and the ~25 GB of files; licence row Apache-2.0 (and the PE and VAE licences as their cards say).

Tests: converter tests (matrix conventions, intrinsics, frame counts, scales), turn-state tests, library test, browser checks of the World take at 1440 and 390 px, light and dark, in demo mode. No GPU here: every speed figure is the port author's.

Every brief also carries the standard CLOUD ONLY WHERE IT IS HOSTED, MAIN CHANGED THIS AREA and PUBLIC SIGN-UP paragraphs (in the JSON twin).

## 7. What could not be verified

- **Reddit.** No search returned threads from r/StableDiffusion, r/comfyui, r/LocalLLaMA, r/aivideo or r/VideoEditing for September-October 2026, and the pages were not fetched directly. Community interest is measured here by Hugging Face trending and likes, the ComfyUI Wiki feed (which summarises Reddit and Discord launches) and GitHub. A pass on Reddit itself is still owed.
- **Kling 4.0:** text-to-video and video edit `llms.txt` pages show live endpoints; image-to-video and reference-to-video were not re-fetched (the brief says to). Whether Kling 4.0 reached general availability in Kling's own app is reported by one secondary source only. The Replicate schema for `kwaivgi/kling-v4.0` was not fetched.
  - _Checked by `nm10-kling-4` on 2026-11-01 (correction):_ all four fal endpoints are `active` in fal's catalog with live `llms.txt` pages (re-read with `scripts/fetch-hosted-schemas.py --part4` into `paid-model-apis-4.json`), and Replicate's official `kwaivgi/kling-v4.0` (version f4dc4504, 2026-10-26) was read: one model for text, start/middle/end frames, reference images and clips and edits (`base_video`), with no shots or elements. Since round 4 the fal schemas gained `middle_image_urls` (up to 8 ordered keyframes between the first and last frame, with no time for each) on image- and reference-to-video, `video_urls` (up to 4) and `voice_ids` on the edit, and `voice_ids` / `end_image_url` on references; an element's clip is 3-8 s. So the hosted API does take ordered keyframes, but not timed ones: Frames mode stays on FLUX 3 Max, as §6.2 says, for that reason.
- **FLUX 3 Image Klein** (checked by `nm10-flux3-klein` on 2026-11-01, corrections and additions):
  - The ComfyUI repack is `black-forest-labs/flux-3-image-klein-comfy` (BFL's own repository, not Comfy-Org's), revision `feef60b0`, gated "auto"; every size in §6.3 matches its tree. Its Qwen3-VL-4B int8 encoder and flux2-vae have the same names and byte sizes as the ungated Comfy-Org FIBO 2 and flux2-dev files Fuobe already pins (the gated tree hides their SHA-256, so identity is by size only). The repack's own `workflows/` folder is gated too; the graphs were read from Comfy-Org's templates (`image_flux3_klein_*`, workflow_templates 0.11.86, minComfyUIVersion 0.41.0), whose model notes name `flux3_image_klein_sd_int8_convrot.safetensors`, a file that is not in the repository (the files are `flux3-image-klein-*-int8-convrot`). The distilled template runs 15 steps (the card says 16). Every class the graphs use (TextGenerate, ReferenceMultiLatent, BatchImagesNode, EmptyFlux2LatentImage, CLIPLoader type `flux3`) is in ComfyUI v0.41.0-7 (`fc04da91`): no pin bump.
  - The card's download line names the int8 prompt upsampler (9.75 GB); the Comfy templates load the w4a8 one (6.72 GB), which Fuobe uses. The upsampler (`black-forest-labs/flux-3-image-klein-pup`, revision `3f3edb52`) is Apache-2.0 and ungated; its README gives the decoding (greedy, top_p 0.95, top_k 20, presence penalty 1.5 for text to image and 0 for edits) and four system prompts (`t2i`, `i2i`, `t2i_bbox`, `i2i_bbox`).
  - fal: all six inference endpoints and both trainers are `active` (read with `scripts/fetch-hosted-schemas.py --new10` into this file's `endpointRecords` and the Originals research's `trainers[]`). Prices confirmed: per image $0.008 at 768², $0.009 1K, $0.011 1.5K, $0.014 2K, $0.036 4K ("planned"); /lora $0.012 per megapixel; Klein Base /lora $0.035 per megapixel; trainer $0.0043 a step (at least 100); the edit trainer $0.002 a step times a factor per reference image (x2.11 with 1 … x23.44 with 10). Schema drift since round 4: text-to-image's `image_size` now says "256 to 4096 pixels (native 4K)". Correction (the package's review, re-read the same day): the plain `base/text-to-image` and `base/edit-image` endpoints are active and in fal's catalog (`api.fal.ai/v1/models?endpoint_id=…` lists both), with the same inputs as the /lora twins minus `loras`, and planned per-image prices of $0.024 at 768², $0.027 at 1K, $0.033 at 1.5K, $0.042 at 2K and $0.108 at 4K. They are now `flux-3-klein-base`'s routes, with the /lora twins as their `loraEndpoint` (a Base run without LoRAs is $0.108 at 4K, not $0.56 on the /lora route); read with `scripts/fetch-hosted-schemas.py --new10 <endpoint …>` into `endpointRecords`. fal's trainer page says to run its LoRAs on the Klein LoRA endpoints, "base recommended".
  - AI-Toolkit (main `e9c72b7`, 2026-10-31) trains FLUX 3 Image Klein Base: `extensions_built_in/diffusion_models/flux3`, arch `flux3`, `black-forest-labs/flux-3-image-klein-base` (gated), its UI's defaults convrot8 quantization, shift timesteps, guidance 3.5, 28 sample steps. Fuobe pins no AI-Toolkit version (it links the repository), so the open engine trains Klein on that.
- **Licences not confirmed from a LICENSE file:** FastH3 Omni, Sol-H3-VAE (HF tag empty), LightVAE, Veda, the LightX2V Qwen-Image 2.1 Lightning LoRA (HF tag empty; comfyui-wiki says Apache-2.0), akhaliq's Qwen-Image 2.1 Next-Scene and Multiple-Angles LoRAs (HF API refused an anonymous read; on 2026-11-01 Next-Scene's card tag read apache-2.0, still no LICENSE file), FeyNoBg, UltraTex, the NVIDIA VFX node pack, Kroma, Krea 2 Edit V2, Anima Reference Adapter. (FeyNoBg checked 2026-11-02: no card, tag or LICENSE file, so its licence is unknown.) MiniMax Music 3's own LICENSE ("MiniMax-Music3 Community License") differs from the Comfy-Org repack's Apache-2.0 tag: both are recorded.
- **VRAM:** almost no publisher gives consumer-GPU VRAM. Figures here are the publisher's tests (FastH3 Trim's 8 GB cap; FLUX 3 Klein's B200 peaks; CorridorKey's 4-6 GB; VoxCPM2's 8 GB) or third-party measurements (Freefield's 17.8 GB for Klein; one tester's ~90 GB for Alpha-Gen at 4K; the Hy-Nomas port's 5090 timings). Nothing ran on a GPU here.
- **Quality claims** (Pika's DesignArena rank and five-metric win; FLUX 3 Klein's arena Elo as cited by Freefield; FastH3 Trim's speed; Sol-H3-VAE's 16x decode; Zen Image Edit's similarity scores) are the authors' or a single third party's.
- **ComfyUI support details:** whether FastH3 Trim conditions on a first frame (only a T2V template is named); whether any CorridorKey wrapper loads the 2.0 weights; whether Hy-Nomas' port carries history between separate `/prompt` calls; whether fal's MiniMax H3 LoRA endpoints can run Pika's adapters at Pika's 6-step schedule.
- **Hosted prices** for Kandinsky 6 Lite, Replicate's `minimax/h3-lite` / `h3-highspeed`, Meshy retexture and the Mureka 8/9 endpoints were not read; each brief says to fetch them.
- **Competitors:** CapCut 19.9's features are inferred from APK resource names by one blog; no dated October launch was found for Runway, Luma, Hedra, Freepik / Magnific or OpenArt; Adobe's completion of the Topaz purchase is from one French report.
- **Dates** taken from the ComfyUI Wiki listing sometimes differ from the article URL slug (noted in the JSON where it matters). Hugging Face `createdAt` dates are repository creation, not public release.

## Sources (read 2026-11-01)

News feeds and catalogs
- ComfyUI Wiki news, pages 1-8: https://comfyui-wiki.com/en/news and `?page=2` … `?page=8` (items 2026-09-04 to 2026-10-30), plus the item pages cited in each row.
- kombitz roundups: https://www.kombitz.com/2026/10/31/ai-image-video-model-news-roundup-october-31-2026/ , …/2026/10/24/… , …/2026/10/10/… (the 10-17 page returned 403).
- Hugging Face API: `https://huggingface.co/api/models?sort=trendingScore` (overall and per pipeline tag), `/api/models/<repo>` for licence tags and revisions, `/api/models/<repo>/tree/main` for file sizes.
- fal: `https://api.fal.ai/v1/models` (all 1,464 endpoints, paged); `llms.txt` for `kling/v4/text-to-video`, `kling/v4/video-to-video/edit`, `blackforestlabs/flux-3/klein/text-to-image/lora`, `minimax/h3-max/lip-sync/image-to-video`, `minimax/h3-max/director`.
- Replicate: https://replicate.com/explore

Models (primary pages)
- Pika H3 Flex: https://huggingface.co/Pika-Labs/Pika-H3-Flex (`3ff16644`), https://pika.art/blog/pika-h3-flex , https://docs.comfy.org/tutorials/video/pika/pika-h3-flex (via comfyui-wiki), https://creatorstoolbox.com/blog/pika-h3-flex
- FLUX 3 Image Klein: https://huggingface.co/black-forest-labs/flux-3-image-klein (`33733762`), https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy (`feef60b0`)
- Kling 4.0: fal pages above; https://www.atlascloud.ai/de/blog/tips/kling-4-flash-vs-full
- FastH3: https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy (`f66c13dc`), https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2 (`3da2ddfe`), https://haoailab.com/blogs/fasth3-rtx/ (via comfyui-wiki)
- H3 core and speed: https://github.com/comfyanonymous/ComfyUI/pull/17411 , https://github.com/comfyanonymous/ComfyUI/pull/17412 , https://huggingface.co/Efficient-Large-Model/Sol-H3-VAE (`6a8a33fc`), https://huggingface.co/taobao-content-ai/MiniMax-H3-PTD-LoRAs (`56a28ad9`)
- Kandinsky 6.0: https://github.com/kandinskylab/kandinsky-6 , https://huggingface.co/kandinskylab/Kandinsky-6.0-Pro-distill-5s-Diffusers (`80d5e6c7`)
- Hy-Nomas: https://huggingface.co/tencent/Hy-Nomas (`bb6a8ca4`), https://github.com/Tencent-Hunyuan/Hy-Nomas , https://github.com/Nynxz/ComfyUI-HyNomas
- MiniMax Music 3: https://huggingface.co/MiniMaxAI/MiniMax-Music3 (`1b525ccb`, LICENSE), https://huggingface.co/Comfy-Org/MiniMax-Music-3 (`9e364ccd`); YuE2: https://huggingface.co/m-a-p/YuE2-3B (`8f24312f`)
- AuK: https://github.com/Tencent-Hunyuan/AuK , https://huggingface.co/tencent/AuK (`790742b7`), https://huggingface.co/tencent/AuK-Flash (`575b92f0`)
- VoxCPM2: https://huggingface.co/openbmb/VoxCPM2 (`32279eff`), https://github.com/Saganaki22/ComfyUI-VoxCPM2 ; Qwen3-TTS: comfyui-oss.md L1495-1531 and paid-model-apis-2.md L282-311 (round 1-2 research)
- Drama 3: https://huggingface.co/fishaudio/drama-3 (`78e5ab79`), https://github.com/Comfy-Org/ComfyUI/pull/16999 (via comfyui-wiki)
- CorridorKey 2.0: https://huggingface.co/nikopueringer/CorridorKey2.0 (`cf44a8db`); wrappers listed at https://comfy.icu/extension/pixelworldai__ComfyUI-CorridorKeyWrapper and https://www.runcomfy.com/comfyui-nodes/ComfyUI-CorridorKey
- ComfyUI-RMBG 3.3.0: https://github.com/1038lab/ComfyUI-RMBG ; https://huggingface.co/briaai/VRMBG-3.0 (gated); https://huggingface.co/1038lab/FeyNobg
- LTX-2.5 Alpha-Gen: https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Alpha-Gen (gated), https://www.creativeainews.com/articles/ltx-alpha-gen-ai-alpha-matte-no-green-screen-2026/
- NVIDIA VFX nodes: https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes
- Qwen-Image 2.1 add-ons: https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning (`6b0a1176`), https://huggingface.co/linoyts/Qwen-Image-2.1-DMD2-2steps (`5bae2836`), https://huggingface.co/PrunaAI/P-Q-Image-2.1 , https://huggingface.co/AiArtLab/zen-image-edit (`3d571755`)
- LongCat-Video-Avatar 1.5: https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5 (`92016c71`), https://huggingface.co/vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI
- Freefield: https://github.com/neuregex/freefield (via https://comfyui-wiki.com/en/news/2026-10-27-freefield)
- Competitors: https://www.androidsage.com/2026/10/23/capcut-19-9-0-apk/ , https://letsdatascience.com/news/google-rolls-out-nano-banana-21-image-model-c6ac3b89 , https://globenewswire.com/news-release/2026/10/27/3389469/0/en/vidu-powers-china-s-first-ai-feature-length-film-demonstrating-its-full-cinematic-potential.html

Fuobe (read only)
- `src/lib/catalog/models.ts`, `src/lib/catalog/cloud-models.generated.ts`, `src/lib/studios.ts`, `src/lib/layout-prompt.ts`, `src/lib/catalog/keyframes.ts`, `src/lib/catalog/training.ts`, `workflows/comfyui/manifest.json`, `docs/FEATURES.md`, `docs/HANDOFF.md`, `docs/handoff/queue.json`, `docs/research/README.md`, `new-models-7.md`, `comfyui-oss.md`, `comfyui-oss-4.md`, `paid-model-apis*.json`.

## Correction (2026-11-02)

- **fal now serves Qwen-Image 2.1**: `fal-ai/qwen-image-2.1` (text to image, $0.02 per megapixel) and `fal-ai/qwen-image-2.1/edit` (1-10 references, $0.0367 per megapixel). Neither shows in fal's model search yet, and neither takes LoRA URLs (no `/lora` twin), so LoRA features on 2.1 (QMA, Next-Scene, the speed LoRAs) stay on the open engine. A plain cloud Qwen-Image 2.1 model is now possible: a package of its own (research record, `gen-cloud-models.py`). Replicate still has no Qwen-Image 2.1.
- The QMA camera-angles LoRA (gribbliest @ 13007eec, 318,820,224 bytes, Apache-2.0 on its card, non-commercial through its base) is recorded in `new-models-10.json` and in `fuobe-originals-recipes-5.json` adapterLoras (`qwen21-qma-angles`).
