# Fuobe Originals: open-weight recipes (round 5)

_As of 2026-10-23. Machine-readable twin: [`fuobe-originals-recipes-5.json`](fuobe-originals-recipes-5.json) (`hostedLoraEndpoints`, `trainers`, `loraLibrary`, `soul`, `presets`, `fuobeTrainedLoras`, `motionsEffects`, `studios`, plus `criticSpotChecks` and `buildPlan` from the critic pass). The implementation order is in the [Build plan](#build-plan) at the end. It builds on [`comfyui-oss.md`](comfyui-oss.md) (LoRAs, base models), [`higgsfield-image-studios.md`](higgsfield-image-studios.md) (the 139 Soul presets), [`higgsfield-api.md`](higgsfield-api.md) (what each Higgsfield product takes) and [`comfyui-oss-4.md`](comfyui-oss-4.md) (Genjutsu routes)._

**The decision this serves.** Fuobe stops calling Higgsfield. Every product Higgsfield sells as its own (Soul and its presets, Soul ID, Soul Cinema, DoP motions and effects, Genjutsu, Mixed Media, Cinema Studio, Upscale, Speak, Popcorn) becomes a *Fuobe Original*: open weights plus LoRAs, runnable (1) on the user's GPU through ComfyUI and (2) in the cloud through hosted *open* models on fal.ai or Replicate. Partner models (Kling, Seedance, Veo, Nano Banana, GPT Image…) stay as separate choices.

**How this was checked (all on 2026-10-23).** fal: the OpenAPI file of every endpoint below (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`), prices from `https://fal.ai/models/<id>/llms.txt`, status and `license_type` from the catalog API (`https://api.fal.ai/v1/models`, 1,523 endpoints). Replicate: the schema and billing embedded in each model page. LoRAs: the Hugging Face model API and README of each repo, and civitai's public API (`/api/v1/models/<id>`: permissions, versions, files). Licences: model cards and the LTX licence on GitHub. No paid call and no GPU run was made, so **nothing here is a quality result**: strengths are the authors' advice or a starting point, and every preset needs an A/B check on a GPU. Facts that could not be confirmed are marked **unverified**.

---

## 1. The short version

- **Hypothesis check.** **Partly right** (§2, and in detail [`higgsfield-originals-5.md`](higgsfield-originals-5.md)). Five Higgsfield-branded tools are open models with public LoRAs, confirmed in its web client: Angles (Qwen-Image-Edit 2509 + Multiple-angles + Lightning LoRAs), Animate / Recast (Wan 2.2 Animate), Infinite Talk (InfiniteTalk + FusioniX), Depth Map (Video Depth Anything) and Remove Background (SAM 3). Soul 2.0 styles carry `lora` / `lora_2` fields, and DoP accepts raw `.safetensors` motions, so Soul and DoP presets are LoRAs on a self-hosted base. That base is not named anywhere public. Cinema Studio 4.0 (Seedance 2.5), Shorts Studio (Gemini Omni Flash), Marketing Studio Image and Ads Studio (GPT Image 2.5) are closed partner models with Higgsfield's prompts on top. The plan does not depend on the answer.
- **Cloud engine for Originals = fal's open-weight LoRA endpoints.** 37 fal and 8 Replicate endpoints were checked (§3). The ones to use: `fal-ai/z-image/turbo/lora` ($0.0085/MP, ≤3 LoRAs), `fal-ai/qwen-image-2512/lora` and `fal-ai/qwen-image-edit-2511/lora` ($0.035/MP, ≤3), `fal-ai/flux-2/klein/4b/lora` ($0.01/MP, ≤3), `fal-ai/wan/v2.2-a14b/image-to-video/lora` ($0.10/s, per-LoRA `transformer: high|low|both`) and `fal-ai/ltx-2.3-22b/image-to-video/lora` ($0.001805 per megapixel of video, plus a built-in `camera_lora`).
- **Licence rule.** Originals only use Apache/MIT bases (Z-Image, Qwen-Image, FLUX.2 [klein] 4B, Wan 2.1/2.2, Wan Animate 2, SeedVR2, InfiniteTalk) or LTX-2.x (free under US$10M annual revenue). FLUX.1/FLUX.2 [dev], Krea [dev] and klein 9B weights are non-commercial: fal clears its *own hosted outputs* of them for commercial use, but self-hosting the same weights is not cleared, so they are not Originals. MiniMax H3 is territory-restricted.
- **Fuobe Soul = Z-Image Turbo + LoRAs + a prompt template + a post grade** (§4). One slot holds the core look (Shakker-Labs AWPortrait-Z, or a phone-realism LoRA), two slots hold the preset's LoRAs. 8 steps, cfg 1, `res_multistep`, shift 3.
- **All 139 Soul presets are mapped** (§5): 108 with a look LoRA, 28 with the core LoRA and words only, 3 prompt-only. Every LoRA used allows commercial outputs and third-party hosting. 87 presets use at least one civitai LoRA, which needs a civitai token or a mirrored copy.
- **16 presets should get a Fuobe-trained LoRA** (CCTV, 0.5x lens, scale surrealism, through-glass, old phone, Frutiger aero, underwater, paper collage, beauty details), plus one `fuobe-soul-core` style LoRA for the overall look (§6). Train on Fuobe-owned or licensed images only, never on Higgsfield outputs.
- **Motions and effects** (§7): of the 78 motions and 219 effects that are prompt-only today, 55 get a LoRA candidate and 6 relights get a relight route (56 of those 61 run on both engines today; the rest are LTX-2.5-only, licence-unclear or LTX-2 19B), 18 get an alias or a Fun Camera pose, 15 colour grades become a post step, 32 Mixed Media looks move to the Mixed Media route and 13 sports moves should use a driving-clip motion library. New since mid-2026: mostly LTX-2.3/2.5 LoRAs (FPV, slow motion, exploded view, wind, car jump, relight) and two Wan 2.2 camera LoRAs (shaky handheld, head-mounted camera). Wan 2.2 LoRA releases have slowed sharply since May 2026.
- **Studios** (§8): Genjutsu = Wan Animate 2 / SCAIL-2 / Wan VACE + SAM 3.1 / Fun VACE restyle; Mixed Media = per-frame Z-Image with the same LoRA library; Cinema Studio = Wan 2.2 or LTX-2.5 with the Director's Panel compiled into the prompt; Upscale = SeedVR2; Speak = InfiniteTalk. Each has a hosted open twin on fal; there is **no hosted Wan Animate 2** (fal has Wan 2.2 Animate, SCAIL-2 and 'Wan Motion').

---

## 2. Is Higgsfield “open models plus LoRAs”?

**Claim (the user's):** Higgsfield's in-house models are open models repackaged with LoRAs or better wrapping.  
**Verdict:** Partly right. Higgsfield runs several open models under its own names, and its Soul and DoP presets are LoRA files in the client code. But no source names the base model of Soul or DoP, and its flagship studios run on closed partner models. *(Updated by the critic pass on 2026-10-23 with the client-code evidence from [`higgsfield-originals-5.md`](higgsfield-originals-5.md) §2.3 and §3.22, re-checked against the cited bundle chunks.)*

| | Evidence | Source |
|---|---|---|
| for | The web bundle's job types include open models run by Higgsfield: infinite_talk (InfiniteTalk, Apache-2.0), sam_3_video (SAM 3), depth_anything_video, z_image (Z-Image), plus wan2_2 ... wan3_0 jobs. | docs/research/higgsfield-inventory.md §3 job-type ids (bundle crawl, 2026-10-16) |
| for | Cinema Studio 4.0 runs on Seedance 2.5 (ByteDance) and Speak has a wan2_5_speak job: flagship 'studios' wrap third-party models. | higgsfield-inventory.md (2026-10-16) |
| for | Soul v1 takes style_id + style_strength 0-1 and custom_reference_id + custom_reference_strength 0-1; 'custom_reference_strength=0 uses the selected style's default character strength'. A per-style weight plus a per-user weight is how stacked LoRAs/adapters are exposed. | docs/research/higgsfield-api.json (docs.higgsfield.ai/docs/models/soul*, 2026-10-16) |
| for | Soul ID trains a reusable character from 1-100 photos into an id with a 0-1 strength, the usual shape of a per-user LoRA. | higgsfield-api.json soul-id/create |
| for | The legacy DoP API takes motions: [{id, strength}] for dop-lite / dop-turbo / dop-standard, the same shape as stacking camera LoRAs on one base. | npm @higgsfield/client 0.2.6 types (higgsfield-api.json legacy/dop; unverified, possibly retired) |
| for | Soul 2.0 costs $0.0032 per 720p image on Higgsfield's API, the price class of a 4-6B distilled open model (fal: Z-Image Turbo $0.005/MP, FLUX.2 klein 4B $0.01/MP). This is an inference from price only. | higgsfield-api.json pricing (dash.higgsfield.ai/api/v2/pricing/models, 2026-10-16); fal llms.txt 2026-10-23 |
| for | Client job types name open models under Higgsfield product names: QWEN_CAMERA_CONTROL = 'Higgsfield Angles' (sends `loras [{lightx}, {camera_angle}]`), WAN2_2_ANIMATE_V3 = 'Higgsfield Recast', InfiniteTalk with a 'fusex' LoRA at rank 32. | `assets.higgsfield.ai/tanstack/assets/1a2c0e3d-rSfLYhMkPbN1soeD.js`, `-j-8rpwEzEMqpgGav.js`, `-WdalZTpoZ_pO7J7g.js` (re-checked 2026-10-23) |
| for | Every Soul 2.0 / Soul Cinema style record has `lora` and `lora_2` fields, shown to staff as 'LoRA 1' / 'LoRA 2' next to '(Dev) Preset Strength' and '(Dev) Character Strength' sliders. DoP's motion picker accepts `loras/<name>.safetensors` ids ('Higgsfield Canary'). | `1a2c0e3d-OWMkRGYJAoV9LLH0.js`, `-ggrIiLPSJckmqaiD.js`, `-Iy-LDiMETMj_D3ZQ.js` (re-checked 2026-10-23) |
| neutral | Higgsfield ships Genjutsu Motion Transfer as a ComfyUI partner node. It is a cloud API node that "downloads no model" and bills per output second, so it says nothing about the model inside. *(Was listed as evidence "for"; moved by the critic pass.)* | https://docs.comfy.org/tutorials/partner-nodes/higgsfield/genjutsu-motion-transfer (read 2026-10-23) |
| against | Higgsfield calls Soul, Popcorn and DOP 'native' models and publishes no model card or base model. | https://higgsfield.ai/creator-hub/help-center/ai-models/which-ai-model-should-i-use (read 2026-10-23) |
| against (weak) | On Soul 2.0's public API, style_strength 'is accepted by the request schema but currently has no effect'. The web client still has a staff preset-strength slider next to the LoRA fields, so the public API ignoring the field does not show that styles aren't LoRAs. | higgsfield-api.json higgsfield-ai/soul/v2/standard; `1a2c0e3d-OWMkRGYJAoV9LLH0.js` |
| against | No public statement, model card or leak found that names Soul's or DoP's base model. | web searches 2026-10-23 (see sources) |

It does not change the plan: every Original below is built from open weights Fuobe can name and licence, whatever Higgsfield uses inside. Do not train Fuobe LoRAs on Higgsfield outputs or preset preview images. Higgsfield's Terms of Use (https://higgsfield.ai/terms-of-use-agreement, last updated 2026-10-23, read that day) forbid it. Section 5.2(iv) bars using "the Service, any Outputs, or any data derived therefrom to train, fine-tune, distill, or otherwise transfer knowledge to any machine-learning model ... whether or not such system competes with the Service". Section 5.1(iii) bars using Outputs to "develop, modify, fine‑tune, distill, or improve" competing products, and 5.2(v) bars reverse engineering the Service. Copyright also applies. Use Fuobe-owned or licensed references. *(Was "secondary sources, unverified wording"; now read from the primary page.)*

---

## 3. Hosted open models that take LoRAs (the cloud engine for Originals)

### 3.1 Inference endpoints

Every row was read from the provider's schema on 2026-10-23. *Weights licence* is the licence of the open base; *commercial* says whether that licence allows commercial use when Fuobe or the user runs the weights (fal additionally marks all of these `license_type: commercial` for output from its own API). LoRA `path` accepts what the *path* column says.

| provider | endpoint | base | op | LoRA field (item shape) | max | path accepts | price | weights licence | commercial | use for Originals |
|---|---|---|---|---|---|---|---|---|---|---|
| fal | `fal-ai/z-image/turbo/lora` | Z-Image Turbo | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.0085 per megapixels | Apache-2.0 | yes | Fuobe Soul default (cloud) |
| fal | `fal-ai/z-image/turbo/image-to-image/lora` | Z-Image Turbo | i2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.0085 per megapixels | Apache-2.0 | yes | Soul image-to-image, Mixed Media frames without control |
| fal | `fal-ai/z-image/turbo/controlnet/lora` | Z-Image Turbo | i2i-control | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.01 per megapixels | Apache-2.0 | yes | Mixed Media per-frame restyle (cloud) |
| fal | `fal-ai/z-image/turbo/inpaint/lora` | Z-Image Turbo | inpaint | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.0115 per megapixels | Apache-2.0 | yes | Soul inpaint with the preset LoRA |
| fal | `fal-ai/z-image/base/lora` | Z-Image (base) | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.012 per megapixels | Apache-2.0 | yes | Runs LoRAs trained on the non-distilled base |
| fal | `fal-ai/qwen-image-2512/lora` | Qwen-Image 2512 | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL or the path to the LoRA weights. | $0.035 per megapixels | Apache-2.0 | yes | Soul HD / typography presets |
| fal | `fal-ai/qwen-image` | Qwen-Image (2508) | t2i | path:string; scale:number default=1 minimum=0 maximum=4 | 3 | URL or the path to the LoRA weights. | $0.02 per megapixels | Apache-2.0 | yes | older Qwen-Image LoRAs |
| fal | `fal-ai/qwen-image-edit-2511/lora` | Qwen-Image-Edit 2511 | edit | path:string; scale:number default=1 minimum=0 maximum=4 | 3 | URL or the path to the LoRA weights. | $0.035 per megapixels | Apache-2.0 | yes | Soul edits, first-frame restyle for Genjutsu / Shorts |
| fal | `fal-ai/qwen-image-edit-plus-lora` | Qwen-Image-Edit 2509 | edit | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL or the path to the LoRA weights. | $0.035 per megapixels | Apache-2.0 | yes | 2509 LoRAs (relight, next-scene, multiple angles) |
| fal | `fal-ai/qwen-image-layered/lora` | Qwen-Image-Layered | layers | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo) to lora weights. | $0.06 per images | Apache-2.0 | yes | Layers |
| fal | `fal-ai/flux-2/klein/4b/lora` | FLUX.2 [klein] 4B distilled | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | Requests cost $0.01 per megapixel | Apache-2.0 | yes | cheap Apache fallback |
| fal | `fal-ai/flux-2/klein/4b/base/lora` | FLUX.2 [klein] 4B base | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | $0.016 per megapixels | Apache-2.0 | yes | LoRAs trained on klein base |
| fal | `fal-ai/flux-2/klein/4b/edit/lora` | FLUX.2 [klein] 4B edit | edit | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | Requests cost $0.01 per megapixel of input and output. Input images will be resized to 1MP. For example, a 1024x1024 generation with 512*512 size image input wi | Apache-2.0 | yes | try-on LoRA route |
| fal | `fal-ai/flux-2/klein/9b/lora` | FLUX.2 [klein] 9B | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | Requests cost $0.015 per megapixel | FLUX Non-Commercial License | no | not for Originals (weights non-commercial) |
| fal | `fal-ai/flux-2/lora` | FLUX.2 [dev] | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | Your request will cost $0.021 per megapixel. LoRAs over 2GB in size will accrue an extra 50% charge per GB (2-3GB total lora size will multiply the price by 1.5 | FLUX [dev] Non-Commercial License | no | not for Originals |
| fal | `fal-ai/flux-lora` | FLUX.1 [dev] | t2i | scale:number default=1 minimum=0 maximum=4; path:string | any number (description) | URL or the path to the LoRA weights. | $0.035 per megapixels | FLUX.1 [dev] Non-Commercial License | no | not for Originals |
| fal | `fal-ai/flux-krea-lora` | FLUX.1 Krea [dev] | t2i | path:string; scale:number default=1 minimum=0 maximum=4 | any number (description) | URL or the path to the LoRA weights. | $0.035 per megapixels | FLUX.1 [dev] Non-Commercial License | no | not for Originals |
| fal | `fal-ai/krea-2/turbo/lora` | Krea 2 Turbo | t2i | path:string; scale:number default=1 minimum=0 maximum=4 | 3 | URL, HuggingFace repo ID (owner/repo), or local path to LoRA | $0.01 per megapixels | Krea 2 Community License (gated, revenue tiers) | conditional | optional, licence tiers |
| fal | `fal-ai/wan/v2.2-a14b/text-to-image/lora` | Wan 2.2 A14B (image) | t2i | transformer:string default="high" enum=["high", "low", "both"]; scale:number default=1 minimum=0 maximum=4; path:string; weight_name:string | not stated | URL or the path to the LoRA weights. | $0.05 per images | Apache-2.0 | yes | Wan-style stills |
| fal | `fal-ai/ernie-image/lora` | ERNIE-Image | t2i | scale:number default=1 minimum=0 maximum=4; path:string | 3 | URL or the path to the LoRA weights. | $0.035 per megapixels | unverified | conditional | not evaluated |
| fal | `fal-ai/lora` | SD 1.5 / SDXL (any checkpoint) | t2i | scale:number default=1 minimum=0 maximum=4; path:string | any number (description) | URL or the path to the embedding weights. | $0 per compute seconds | CreativeML OpenRAIL-M / OpenRAIL++ | yes | legacy |
| fal | `fal-ai/wan/v2.2-a14b/image-to-video/lora` | Wan 2.2 A14B I2V | i2v | transformer:string default="high" enum=["high", "low", "both"]; scale:number default=1 minimum=0 maximum=4; path:string; weight_name:string | not stated | URL or the path to the LoRA weights. | $0.1 per seconds | Apache-2.0 | yes | Motions and Effects (cloud) |
| fal | `fal-ai/wan/v2.2-a14b/text-to-video/lora` | Wan 2.2 A14B T2V | t2v | transformer:string default="high" enum=["high", "low", "both"]; scale:number default=1 minimum=0 maximum=4; path:string; weight_name:string | not stated | URL or the path to the LoRA weights. | $0.1 per seconds | Apache-2.0 | yes | T2V with LoRAs |
| fal | `fal-ai/wan-i2v-lora` | Wan 2.1 I2V 14B | i2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL or the path to the LoRA weights. | $0.75 per videos | Apache-2.0 | yes | Wan 2.1 LoRAs (most Remade VFX) |
| fal | `fal-ai/wan-t2v-lora` | Wan 2.1 T2V 14B | t2v | path:string; scale:number default=1 minimum=0 maximum=4; weight_name:string | not stated | URL or the path to the LoRA weights. | $0.75 per videos | Apache-2.0 | yes | Wan 2.1 T2V LoRAs |
| fal | `fal-ai/wan-flf2v` | Wan 2.1 FLF2V 14B | flf2v | weight_name:string; path:string; scale:number default=1 minimum=0 maximum=4 | not stated | URL or the path to the LoRA weights. | For a video generation, your request will cost $0.20 at 480p resolution and $0.40 at 720p resolution. For $1 you can generate 5 videos at 480p or 2 at 720p with | Apache-2.0 | yes | start + end frame with LoRAs |
| fal | `fal-ai/ltx-2.3-22b/image-to-video/lora` | LTX-2.3 22B | i2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes | camera_lora + LTX LoRAs (cloud) |
| fal | `fal-ai/ltx-2.3-22b/text-to-video/lora` | LTX-2.3 22B | t2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes |  |
| fal | `fal-ai/ltx-2.3-22b/distilled/image-to-video/lora` | LTX-2.3 22B distilled | i2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001405 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes | cheaper |
| fal | `fal-ai/ltx-2.3-22b/video-to-video/lora` | LTX-2.3 22B | v2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes | restyle |
| fal | `fal-ai/ltx-2.3-22b/reference-video-to-video/lora` | LTX-2.3 22B | ref-v2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes | IC-LoRA restyle (ic_lora_type) |
| fal | `fal-ai/ltx-2.3-22b/extend-video/lora` | LTX-2.3 22B | extend | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes |  |
| fal | `fal-ai/ltx-2.3-22b/audio-to-video/lora` | LTX-2.3 22B | a2v | weight_name:string; scale:number default=1 minimum=0 maximum=4; path:string | not stated | URL, HuggingFace repo ID (owner/repo) to lora weights. | Your request will cost $0.001805 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121 f | LTX-2 / LTX-2.x Community License | yes | Speak alternative |
| fal | `fal-ai/ltx-2.3-quality/image-to-video/lora` | LTX-2.3 quality | i2v | transformer:string default="both" enum=["high", "low", "both"]; path:string; scale:number default=1 minimum=0 maximum=2 | 3 | Direct HTTP(S) download URL of the LoRA file (.safetensors). | Billing is calculated at $0.0027075 per megapixel of generated video, using width × height × frames ÷ 1,000,000 and rounding the total up to a whole megapixel.  | LTX-2 / LTX-2.x Community License | yes | higher quality, max 3 LoRAs |
| fal | `fal-ai/ltx-2.3-quality/text-to-video/lora` | LTX-2.3 quality | t2v | transformer:string default="both" enum=["high", "low", "both"]; path:string; scale:number default=1 minimum=0 maximum=2 | 3 | Direct HTTP(S) download URL of the LoRA file (.safetensors). | Billing is calculated at $0.0027075 per megapixel of generated video, using width × height × frames ÷ 1,000,000 and rounding the total up to a whole megapixel.  | LTX-2 / LTX-2.x Community License | yes |  |
| fal | `fal-ai/ltx-2.3-quality/reference-video-to-video/lora` | LTX-2.3 quality | ref-v2v | transformer:string default="both" enum=["high", "low", "both"]; path:string; scale:number default=1 minimum=0 maximum=2 | 3 | Direct HTTP(S) download URL of the LoRA file (.safetensors). | Your request will cost $0.0027075 per megapixel of generated video data (width × height × frames), rounded up. For example, if you generate a video that is 121  | LTX-2 / LTX-2.x Community License | yes |  |
| fal | `minimax/h3/image-to-video/lora` | MiniMax H3 | i2v | weight_name:string; path:string; scale:number default=1 minimum=0 maximum=4 | 3 | URL or HuggingFace repo id (owner/repo) of the LoRA weights. | Video costs $0.0625 per second at 480p, $0.075 per second at 768p, $0.1625 per second at 2K and $0.20 per second at 4K. | MiniMax H3 Community License (territory-restricted) | no | not for Originals (territory-restricted licence) |
| replicate | `prunaai/z-image-turbo-lora` | Z-Image Turbo | t2i | lora_weights: array of URLs (.safetensors, tar, zip); lora_scales: array of floats (default 1.0 each) | array, no maximum stated |  | about $0.0097 per run (Replicate estimate on the page) | Apache-2.0 | yes | second cloud provider |
| replicate | `qwen/qwen-image` | Qwen-Image | t2i | lora_weights: string URL (.safetensors / tar / zip) + lora_scale; extra_lora_weights: array + extra_lora_scale: array | 1 main + extra_lora_weights array |  | $0.025 per output image | Apache-2.0 | yes | second cloud provider |
| replicate | `qwen/qwen-image-edit-2511` | Qwen-Image-Edit 2511 | edit | lora_weights: HF repo slug or .safetensors URL; lora_scale 0-4 | 1 |  | $0.03 per output image | Apache-2.0 | yes | second cloud provider |
| replicate | `wan-video/wan-2.2-i2v-fast` | Wan 2.2 A14B I2V (fast) | i2v | lora_weights_transformer (HIGH expert) + lora_scale_transformer; lora_weights_transformer_2 (LOW) + lora_scale_transformer_2; one LoRA per expert | 1 per expert (high + low) |  | $0.05 (480p) / $0.11 (720p) per video; +interpolation $0.065 / $0.145 | Apache-2.0 | yes | second cloud provider |
| replicate | `wan-video/wan-2.2-t2v-fast` | Wan 2.2 A14B T2V (fast) | t2v | same two-expert fields as the I2V model | 1 per expert (high + low) |  | $0.05 (480p) / $0.10 (720p) per video | Apache-2.0 | yes | second cloud provider |
| replicate | `black-forest-labs/flux-dev-lora` | FLUX.1 [dev] | t2i | lora_weights + lora_scale (-1..3); extra_lora + extra_lora_scale (civitai, HF, Replicate or URL) | 2 |  | $0.032 per output image | FLUX.1 [dev] Non-Commercial License | no | second cloud provider |
| replicate | `zsxkib/hunyuan-video-lora` | HunyuanVideo (2024) | t2v | lora_url (URL or HF repo) + lora_strength (-10..10) | 1 |  | about $0.26 per run (Replicate estimate) | Tencent Hunyuan Community License | conditional | second cloud provider |
| replicate | `fofr/wan2.1-with-lora` | Wan 2.1 14B / 1.3B | t2v | lora_url + lora_strength_model + lora_strength_clip | 1 |  | about $1.47 per run (Replicate estimate) | Apache-2.0 | yes | second cloud provider |

Extra fields that matter:

- **Wan 2.2 on fal** (`fal-ai/wan/v2.2-a14b/*/lora`): each LoRA item is `{path, scale 0–4, transformer: high|low|both (default high), weight_name}`. A high/low-noise pair is two items with the same scale and different `transformer`. 17–161 frames (default 81), 480p/580p/720p (default 720p), 2–40 steps (default 27), shift 1–10 (default 5), `guidance_scale` 3.5 and `guidance_scale_2` 4 by default. **Frame rate trap (critic re-check, fal OpenAPI 2026-10-23):** `frames_per_second` defaults to 16, but `interpolator_model` defaults to `film` with `num_interpolated_frames` 1 and `adjust_fps_for_interpolation` true, so a default request returns 32 fps with doubled frames. For DoP parity (49 or 81 frames at 16 fps) send `interpolator_model: "none"` (or `num_interpolated_frames: 0`). Higgsfield's DoP preset pages use 20 steps and guide scale 6.
- **LTX-2.3 on fal** (`fal-ai/ltx-2.3-22b/*/lora`): `loras` is **required** (send at least one item), plus `camera_lora` = `dolly_in | dolly_out | dolly_left | dolly_right | jib_up | jib_down | static | none` with `camera_lora_scale` 0–1, `distill_lora_first/second_pass_scale` (defaults 0.2 / 0.5), 9–481 frames (default 121), `fps` (default 24), 8–50 steps (default 40). Two defaults must be overridden for Originals: `enable_prompt_expansion` defaults to **true** (it would rewrite Fuobe's compiled Director prompt) and `generate_audio` defaults to **true** (set it from the user's audio toggle). Price: $0.001805 per megapixel of generated video (121 frames at 1280×720 ≈ 111.5 MP ≈ $0.20); distilled $0.001405. The *quality* family (`fal-ai/ltx-2.3-quality/*/lora`) caps LoRAs at 3, scale 0–2, adds `transformer` high/low/both, $0.0027075/MP, and only accepts direct `.safetensors` URLs up to 3 GB.
- **Replicate Wan 2.2 fast** takes exactly one LoRA per expert (`lora_weights_transformer` = high, `lora_weights_transformer_2` = low), so a motion and an effect cannot be stacked there.
- *Added 2026-10-24 (o/lora-plumbing):* the full input schemas of the endpoints Fuobe's catalog routes LoRAs to are now in the JSON (`hostedLoraEndpoints[].inputs` and `keyFields`, plus `hostedBaseEndpoints` for the plain LTX-2.3 22B and FLUX.2 [klein] 4B endpoints), read with `scripts/fetch-hosted-schemas.py` from fal's OpenAPI files and Replicate's schema page. Findings: the plain LTX-2.3 22B endpoints cost $0.001605 per megapixel of video (the `/lora` ones $0.001805); FLUX.2 [klein] 4B costs $0.005/MP plain and $0.01/MP with LoRAs and has no `negative_prompt`; Replicate's `prunaai/z-image-turbo-lora` takes `width` / `height` (no `aspect_ratio`, no `num_outputs`) and runs only by version (`usesVersionlessApi: false`). The plain LTX-2.3 22B `extend-video` and `video-to-video` endpoints were read too: both take `num_frames` (9–481, default 121) and `match_input_fps` (default true); `num_frames` is the length extend adds, and video-to-video follows the input clip's length while `match_video_length` is true (its default). Replicate's `wan-video/wan-2.2-t2v-fast` defaults `interpolate_output` to **true** (30 fps, the same trap as fal's `interpolator_model`), takes only 16:9 / 9:16 and 480p / 720p, and both fast models render 81–121 frames.
- *Added 2026-10-25 (o/soul):* `fal-ai/z-image/turbo/image-to-image/lora` (Fuobe Soul's edit route) now has its full inputs in the JSON too (`scripts/fetch-hosted-schemas.py --only <id>`): `image_url`, `strength` (default 0.6, ≤ 1), `image_size` defaulting to `auto` (the picture's shape), `num_inference_steps` 1–8, `loras` up to 3.
- *Added 2026-10-26 (o/dop):* `fal-ai/qwen-image-edit-plus-lora` (Qwen-Image-Edit 2509 with LoRAs, $0.035/MP, up to 3 LoRAs) now has its full inputs in the JSON too: Fuobe DoP's relight effects relight the start frame there with the 2509 Relight LoRA (trigger `重新照明`) before the clip is made.

### 3.2 What has no hosted LoRA route

- HunyuanVideo 1.5 on fal (fal-ai/hunyuan-video-v1.5/text-to-video, /image-to-video) has no loras field; fal-ai/hunyuan-video-img2vid-lora no longer serves an OpenAPI file (retired).
- LTX-2.5 on fal (lightricks/ltx-2.5/*) takes no LoRAs; it has camera_motion (dolly_in/out/left/right, jib_up/down, static, focus_shift).
- fal's Wan Animate (fal-ai/wan/v2.2-14b/animate/move, /replace), Wan VACE (fal-ai/wan-vace-14b*, fal-ai/wan-22-vace-fun-a14b/*), SCAIL-2, InfiniteTalk and SeedVR2 endpoints take no LoRAs.
- No hosted Wan Animate 2 endpoint was found on fal or Replicate (fal's 'Wan Motion' is described as based on Wan-Animate with pose retargeting).
- No hosted Z-Image LoRA trainer on Replicate was found; fal is the cloud trainer for Z-Image.

### 3.3 Trainers (Soul ID and preset LoRAs)

| provider | trainer | base | required | price | weights licence | status | role |
|---|---|---|---|---|---|---|---|
| fal | `fal-ai/z-image-turbo-trainer-v2` | Z-Image Turbo | image_data_url | Your request will cost $0.85 per 1000-step training run. It scales per step, so a 2000-step training run will cost $1.70. A 500 step floor is applied  | Apache-2.0 | active | Soul ID, preset LoRAs (fast, cheapest) |
| fal | `fal-ai/z-image-trainer` | Z-Image (base) | image_data_url | Your request will cost $2.26 per 1000-step training run. It scales per step, so a 2000-step training run costs $4.52. Note: 100 steps is the minimum s | Apache-2.0 | active | style LoRAs (training_type content \| style \| balanced) |
| fal | `fal-ai/qwen-image-2512-trainer` | Qwen-Image 2512 | image_data_url | Your request will cost $0.0015 per step (minimum of 500 steps is charged). For $1.5 you can fine-tune a LoRA for 1000 steps. | Apache-2.0 | active | typography / HD preset LoRAs |
| fal | `fal-ai/qwen-image-trainer` | Qwen-Image | image_data_url | Your request will cost $0.002 per step (minimum of 250 steps is charged). For $2 you can fine-tune a LoRA for 1000 steps. | Apache-2.0 | unlisted (schema served, not in the catalog) |  |
| fal | `fal-ai/qwen-image-edit-2511-trainer` | Qwen-Image-Edit 2511 | image_data_url | Your request will cost $4.0 per 1000-step training run. It scales per step, so a 2000-step training run costs $8. Note: 100 steps is the minimum step  | Apache-2.0 | unlisted (schema served, not in the catalog) | edit LoRAs (image pairs) |
| fal | `fal-ai/qwen-image-edit-2509-trainer` | Qwen-Image-Edit 2509 | image_data_url | Your request will cost $4.0 per 1000-step training run. It scales per step, so a 2000-step training run costs $8. Note: 100 steps is the minimum step  | Apache-2.0 | active |  |
| fal | `fal-ai/flux-2-klein-4b-base-trainer` | FLUX.2 [klein] 4B base | image_data_url | The cost of training depends on the number of steps. The formula is: 0.005 * steps. With 1000 steps, your request will cost $5.00. | Apache-2.0 | unlisted (schema served, not in the catalog) | Apache image LoRAs |
| fal | `fal-ai/flux-2-klein-9b-base-trainer` | FLUX.2 [klein] 9B base | image_data_url | The cost of training depends on the number of steps. The formula is: 0.0043 * steps. With 1000 steps, your request will cost $4.30. | FLUX Non-Commercial License | active | not for Originals |
| fal | `fal-ai/flux-2-trainer-v2` | FLUX.2 [dev] | image_data_url | The cost of training depends on the number of steps. The formula is: 0.0064 * steps. With 1000 steps, your request will cost $6.40. | FLUX [dev] Non-Commercial License | active | not for Originals |
| fal | `fal-ai/flux-lora-fast-training` | FLUX.1 [dev] | images_data_url | Your request will cost $2 per training run (scales linearly with steps). For $2 you can run this model approximately 1 time. | FLUX.1 [dev] Non-Commercial License | active | not for Originals |
| fal | `fal-ai/flux-lora-portrait-trainer` | FLUX.1 [dev] | images_data_url | Training costs $2.40 for 1,000 requested steps, with a minimum charge of $2.40. Above the minimum, the cost scales at approximately $0.0024 per reques | FLUX.1 [dev] Non-Commercial License | active | not for Originals |
| fal | `fal-ai/krea-2-trainer` | Krea 2 | images_data_url | Your request will cost $0.003 per step (minimum of 100 steps is charged). For $3.00 you can fine-tune a LoRA for 1000 steps. | Krea 2 Community License (gated, revenue tiers) | active | optional |
| fal | `fal-ai/wan-22-image-trainer` | Wan 2.2 (image) | training_data_url, trigger_phrase | Your request will cost $0.0045 per step (minimum of 100 steps is charged). For $4.5 you can fine-tune a LoRA for 1000 steps. | Apache-2.0 | active |  |
| fal | `fal-ai/wan-22-trainer/i2v-a14b` | Wan 2.2 A14B I2V | training_data_url | Your request will cost $0.005 per step (minimum of 100 steps is charged). For $5 you can fine-tune a LoRA for 1000 steps. | Apache-2.0 | active | camera / VFX LoRAs for Motions and Effects |
| fal | `fal-ai/wan-22-trainer/t2v-a14b` | Wan 2.2 A14B T2V | training_data_url | Your request will cost $0.004 per step (minimum of 100 steps is charged). For $4 you can fine-tune a LoRA for 1000 steps. | Apache-2.0 | active |  |
| fal | `fal-ai/wan-trainer/i2v-720p` | Wan 2.1 I2V 720p | training_data_url | $0.005 per steps | Apache-2.0 | active |  |
| fal | `fal-ai/ltx23-trainer-v2/i2v` | LTX-2.3 | training_data_url | The cost of training depends on the number of steps. The formula is: 0.0024 * steps. With 1000 steps, your request will cost $2.40. | LTX-2 / LTX-2.x Community License | active | LTX motion LoRAs |
| fal | `fal-ai/ltx23-trainer-v2/t2v` | LTX-2.3 | training_data_url | The cost of training depends on the number of steps. The formula is: 0.006 * steps. With 1000 steps, your request will cost $6.00. | LTX-2 / LTX-2.x Community License | active |  |
| fal | `fal-ai/ltx23-trainer-v2/ic-lora/v2v` | LTX-2.3 IC-LoRA | training_data_url | The cost of training depends on the number of steps. The formula is: 0.0059 * steps. With 1000 steps, your request will cost $5.90. | LTX-2 / LTX-2.x Community License | active | video-to-video effects |
| fal | `fal-ai/ltx23-video-trainer` | LTX-2.3 | training_data_url | Your request will cost $0.0048 per step. For example, the default 2000-step training will cost $9.60. | LTX-2 / LTX-2.x Community License | active |  |
| replicate | `ostris/flux-dev-lora-trainer` | FLUX.1 [dev] |  | billed by GPU time | FLUX.1 [dev] Non-Commercial License |  | not for Originals |
| replicate | `replicate/fast-flux-trainer` | FLUX.1 [dev] |  | billed by GPU time | FLUX.1 [dev] Non-Commercial License |  | not for Originals |
| replicate | `qwen/qwen-image-lora-trainer` | Qwen-Image |  | billed by GPU time | Apache-2.0 |  | Qwen-Image LoRAs on Replicate (trainings API; the model page loads 'ZIPs produced by cog train') |
| replicate | `ostris/wan-lora-trainer` | Wan 2.1 14B (images) |  | billed by GPU time | Apache-2.0 |  | Wan 2.1 only |
| comfyui/gpu | `ostris/ai-toolkit` | Z-Image Turbo (with ostris/zimage_turbo_training_adapter v2), Z-Image base, Qwen-Image, FLUX.2 klein, Wan 2.2, LTX-2.x |  | free on own GPU | MIT (tool; LICENSE read 2026-10-23) |  | Soul ID and preset LoRAs on the user's GPU (Fuobe already has aiToolkitJob in src/lib/catalog/training.ts) |

The data each fal trainer wants is a zip URL: Z-Image Turbo v2 and Qwen 2512 take `image_data_url` with `001.jpg` + `001.txt` caption pairs and a `default_caption`; Wan 2.2 and LTX-2.3 take `training_data_url` (images and/or videos with same-name `.txt` captions) and a `trigger_phrase`. The Wan 2.2 I2V trainer returns a single `lora_file` (whether fal applies it to both experts is **unverified**: pass it with `transformer: both`).

*Updated 2026-10-27 (o/soul-id): licences are information, not gates (decided 2026-10-27).* Soul ID now trains on every image base above that has a hosted LoRA model, with the weights' licence shown next to the price: FLUX.1 [dev] (`fal-ai/flux-lora-portrait-trainer` → `fal-ai/flux-lora`, `fal-ai/flux-krea-lora`), FLUX.2 [dev] (`fal-ai/flux-2-trainer-v2` → `fal-ai/flux-2/lora`), FLUX.2 [klein] 4B and 9B (their base trainers → `fal-ai/flux-2/klein/4b/lora`, `fal-ai/flux-2/klein/9b/lora`) and Krea 2 (`fal-ai/krea-2-trainer` → `fal-ai/krea-2/turbo/lora`); the "not for Originals" roles in the table are superseded (the JSON keeps them as `roleBefore`). `scripts/fetch-hosted-schemas.py --trainers` read each fal trainer's response schema on 2026-10-27 and recorded where its LoRA comes back (`trainers[].loraOutput`): `diffusers_lora_file` for most, `lora_file` for Krea 2, Qwen-Image (2508) and the Wan / LTX video trainers, and a pair for `fal-ai/wan-22-image-trainer` (`diffusers_lora_file` + `high_noise_lora`, so Wan 2.2 image Soul IDs need a two-LoRA element and are not offered yet). The FLUX portrait and Krea 2 trainers take `images_data_url` (the same `001.jpg` + `001.txt` zip; captions win, `trigger_phrase` fills in) rather than `image_data_url`. The five hosted LoRA endpoints' inputs were read the same day (`hostedLoraEndpoints[].inputs`). AI-Toolkit (README and `extensions_built_in/diffusion_models`, read 2026-10-27) trains FLUX.1 [dev] (`arch: flux`), FLUX.2 [dev] (`flux2`), FLUX.2 [klein] base 4B / 9B (`flux2_klein_4b` / `flux2_klein_9b`), Qwen-Image 2512 (`qwen_image`), Krea 2 (`krea2`) and Z-Image Turbo; whether a LoRA trained on a klein *base* model behaves the same on the distilled klein endpoint is **unverified**. The FLUX.2 [dev] and klein trainers take `output_lora_format` (`fal` by default, or `comfy`: "Dictates the naming scheme for the output weights", `fal-ai/flux-2-trainer-v2` schema read 2026-10-27); Fuobe asks for `comfy` where the family also runs on ComfyUI (FLUX.2 [dev]), the same key names an AI-Toolkit LoRA has, and keeps fal's default for the cloud-only klein families. Whether fal's FLUX.2 LoRA endpoints load `comfy`-named weights is **unverified** (their schemas only say a LoRA is "a URL, HuggingFace repo ID or local path"); a GPU-trained FLUX.2 LoRA sent to fal relies on the same.

### 3.4 Downloading LoRAs

Hugging Face `resolve/main` URLs download without a login (fal, Replicate and ComfyUI can use them as they are). **civitai download URLs answer HTTP 401 without a token**: pass `?token=<the user's civitai API key>` or mirror the file once to Fuobe's or fal's storage (allowed when the civitai permissions include Rent or Sell; whether fal accepts a tokenised civitai URL in `path` is **unverified**). Several civitai files share a name (`V1.safetensors`), so the JSON gives each LoRA a unique local `file` name; Fuobe's `injectLoras` keys on `lora_name`, so names must be unique in `ComfyUI/models/loras`. Gated Hugging Face repos (Lightricks LTX-2.5 LoRAs) need the licence accepted and an HF token. *Corrected 2026-10-24 (o/lora-plumbing):* two Hugging Face files had names many unrelated LoRAs share (`pytorch_lora_weights.safetensors`, `lora_weights_step_02000.safetensors`), so a file already in ComfyUI's folder under that name could be another LoRA; the JSON now names them `suayptalha-z-image-turbo-realism.safetensors` and `theburgstall-earthzoomout-ltx2-19b.safetensors`, and `scripts/gen-lora-library.py` refuses such names. *Added 2026-10-24 (o/lora-plumbing):* every LoRA is pinned to exact bytes. `scripts/fetch-lora-pins.py` read each file's SHA256 and size (Hugging Face: the LFS hash at the commit `main` was at, now in `revision`; civitai: the pinned version's primary file, after checking the version belongs to the entry's model), and the generated library downloads Hugging Face files from `resolve/<revision>/…`, so a file replaced upstream is never fetched silently. The downloader keeps a file only when it matches the pinned hash.

---

## 4. Fuobe Soul (the Soul recipe on open weights)

**Base: Z-Image Turbo (6B, 8-step distilled, Apache-2.0).** Apache-2.0 weights; 8 steps at cfg 1 fit a 16 GB GPU; the largest set of photographic LoRAs of any open base (about 4,000 on civitai and several hundred on Hugging Face on 2026-10-23); the cheapest hosted LoRA endpoint (fal $0.0085 per megapixel, up to 3 LoRAs) and trainer (fal $0.85 per 1,000 steps).

- ComfyUI: z-image-turbo-t2i (existing) + injectLoras (LoraLoaderModelOnly after the model loader). Weights: `z_image_turbo_bf16.safetensors`; `qwen_3_4b.safetensors`; `ae.safetensors` (Comfy-Org/z_image_turbo).
- Cloud: fal-ai/z-image/turbo/lora (Replicate: prunaai/z-image-turbo-lora).

| alternate base | when | hosted |
|---|---|---|
| Qwen-Image 2512 (20B, Apache-2.0) | presets with real words (Y2K Posters, Graffiti) and long prompts | fal-ai/qwen-image-2512/lora ($0.035/MP) |
| FLUX.2 [klein] 4B (Apache-2.0) | cheapest draft tier and edits; few style LoRAs | fal-ai/flux-2/klein/4b/lora ($0.01/MP) |
| Krea 2 Turbo | optional aesthetic tier; Krea 2 Community licence, not a default | fal-ai/krea-2/turbo/lora ($0.01/MP) |
| FLUX.1 Krea [dev] / FLUX.2 [dev] | not for Originals: non-commercial weights (fal clears its own hosted outputs, self-hosting does not) | fal-ai/flux-krea-lora, fal-ai/flux-2/lora |

### 4.1 Core LoRAs and the three-slot rule

| slot | LoRA | strength | trigger | licence |
|---|---|---|---|---|
| core option 1 | [Shakker-Labs AWPortrait-Z](https://huggingface.co/Shakker-Labs/AWPortrait-Z) | 0.6 | — | Apache-2.0 |
| core option 2 | [Danrisi Lenovo UltraReal (phone realism)](https://huggingface.co/Danrisi/Lenovo_UltraReal_Z_Image) | 0.35 | — | Apache-2.0 |
| core option 3 | [Danrisi GrainScape UltraReal (film grain)](https://huggingface.co/Danrisi/GrainScape_UltraReal_ZImage) | 0.3 | — | Apache-2.0 |

Slot 1 holds the look's core (AWPortrait-Z for portraits, Lenovo or Realistic Snapshot for phone looks, none for graphic presets); slots 2-3 hold the preset LoRAs. fal allows 3 LoRAs, so a preset never lists more than 3. Keep the total strength at or below about 1.6 and A/B every preset on a GPU before release (unverified stacking).

### 4.2 Prompt template

`{triggers}, {prompt}. {look}. {tail}` — each LoRA's trigger, joined with ', ' (empty when none). Tails by look:

- **photo**: Editorial photograph, natural skin texture with visible pores and fine hair, true-to-life colour, realistic light fall-off, subtle film grain.
- **phone**: Unretouched smartphone photo, natural skin texture, slight sensor noise, true-to-life colour.
- **flash**: Direct on-camera flash, hard shadow behind the subject, natural skin texture, slight grain.
- **cine**: Cinematic film still, motivated lighting, natural skin texture, fine film grain, shallow depth of field.
- **art**: (none: graphic presets describe their medium in the look sentence)

Example (Indie sleaze): _hardflashy, emoessence, a woman in a silver slip dress leaving a club at 2am. Flash-lit nightlife chaos, smudged eyeliner, blurry rebellion. Direct on-camera flash, hard shadow behind the subject, natural skin texture, slight grain._

Before the template, expand short user prompts to 60-120 words with Fuobe's prompt enhancer (Claude / Ollama / offline): subject, wardrobe, pose, place, light, lens, film stock. Keep the user's own words. Z-Image's Qwen3-4B text encoder follows long natural sentences; negative prompts do nothing at cfg 1.

### 4.3 Sampler and sizes

ComfyUI: steps 8, cfg 1.0, sampler `res_multistep`, scheduler `simple`, shift 3.0 (`ModelSamplingAuraFlow`), `EmptySD3LatentImage`, batch 1 or 4 (Soul's batch sizes). Source: docs.comfy.org Z-Image Turbo tutorial (via comfyui-oss.md round 1); 1080p sizes are a Fuobe choice (multiples of 16), unverified on output quality.

fal: `fal-ai/z-image/turbo/lora` with `num_inference_steps` 8 (the schema's maximum), `acceleration` none (quality), regular (default) or high (fastest), `image_size` {width, height} from the table above, `enable_prompt_expansion` false, `output_format` png, `loras` [{path, scale}] max 3. $0.0085 per megapixel (a 1 MP image is about $0.0085; Soul 2.0 is $0.0032 at 720p on Higgsfield's API).

| aspect | 720p tier (≈1 MP) | 1080p tier (≈2 MP) |
|---|---|---|
| 1:1 | 1024x1024 | 1440x1440 |
| 3:4 | 896x1152 | 1248x1664 |
| 4:3 | 1152x896 | 1664x1248 |
| 2:3 | 832x1248 | 1184x1776 |
| 3:2 | 1248x832 | 1776x1184 |
| 9:16 | 768x1344 | 1088x1920 |
| 16:9 | 1344x768 | 1920x1088 |

### 4.4 Post grade and overlays

- **Grade:** Optional per preset: a preset id from src/lib/grade.ts (natural, split-tone, soft-skin, old-lens, 16mm, teal-orange, portra, noir, faded, golden-hour, cold-steel, pop). Applied in the browser today; for API jobs it needs a server-side port (a small ComfyUI colour node chain or the same shader in a worker).
- **Palette lock:** When the user picks a Soul HEX palette: run oss-palette-image (palette-transfer-image, strength 0.8) after generation, as Fuobe already does for open models.
- **New grade presets needed:** invert (Invertethereal), solarize (Surreal solarization). *(Corrected 2026-10-25, o/soul: the two looks now carry these grades in the table and the JSON; they had none.)*
- **Upscale:** 1080p tier and above: SeedVR2 (open: upscale-image-seedvr2; hosted: fal-ai/seedvr/upscale/image at $0.001 per megapixel).
- **Overlays:** *(Added 2026-10-25, o/soul: `presets[].overlay` in the JSON names it: `date-stamp` DigitalCam, `cctv` CCTV, `photo-booth` Vintage PhotoBooth.)* Text and frames that diffusion draws badly are added in post: date stamp (DigitalCam), CCTV camera ID and time, photo-booth strip layout, ID-card crop (dmv), pixelated face (SAM 3.1 face mask + mosaic).

### 4.5 Soul ID and Soul Cinema

- **What Higgsfield does:** Higgsfield's Soul ID trains a reusable character from 1-100 photos (POST /v1/custom-references, model_version v1 | v2 | cinema) and is used as custom_reference_id with a 0-1 strength.
- **Open:** AI-Toolkit job (existing aiToolkitJob in src/lib/catalog/training.ts) on Z-Image Turbo with ostris/zimage_turbo_training_adapter v2 (Apache-2.0), 10-30 photos, captions with a unique trigger, rank 16-32, 1,500-2,500 steps; output copied into ComfyUI/models/loras.
- **Cloud:** fal-ai/z-image-turbo-trainer-v2: image_data_url (zip of 001.jpg + 001.txt pairs), steps (default 2,000), default_caption, learning_rate 5e-4; $0.85 per 1,000 steps (500-step billing floor), so a default run is $1.70. Output diffusers_lora_file is passed as a loras[] path to fal-ai/z-image/turbo/lora.
- **Strength:** custom_reference_strength 0-1 maps to the character LoRA's scale (0.6-1.0); it takes one of the three LoRA slots. Keep the consent checkbox from round 4 (delta-4 G-items).
- **Soul Cinema:** Fuobe Soul with filmstill 0.7 + moviewide 0.5 (+ the character LoRA), 'cine' tail, grade teal-orange or 16mm, 21:9 crop option.

---

## 5. All 139 Soul presets

Each row is a Fuobe Soul run: the template is `{prompt}. <look>. <tail>` with the LoRAs' triggers in front (full text in the JSON). *LoRAs* lists `key@strength`; keys are defined in §5.2. *Grade* is a `src/lib/grade.ts` preset applied after generation. *Train* = a Fuobe-trained LoRA should replace the public one or the words (§6). Base is Z-Image Turbo except Graffiti (Qwen-Image 2512 for lettering).

### 5.1 Preset map

| # | preset | model · category | LoRAs | grade | train | note |
|---|---|---|---|---|---|---|
| 1 | **General** `464ea177` | soul-v1 · All presets | awportrait@0.6, lenovo@0.35 | natural |  | Soul's default look. Replace the core pair with the Fuobe-trained soul-core LoRA once it exists. |
| 2 | **iPhone** `1b798b54` | soul-v1 · Instagram Aesthetics | lenovo@0.8, snapshot@0.4 | natural |  |  |
| 3 | **Realistic** `1cb4b936` | soul-v1 · Instagram Aesthetics | awportrait@0.6, realism@0.6 | — |  |  |
| 4 | **DigitalCam** `ca4e6ad3` | soul-v1 · TikTok Core | digicam@0.8, hardflash@0.5 | — |  | Burn the date stamp in post (browser text overlay) instead of asking the model to write it. |
| 5 | **Flight mode** `3f90dc5b` | soul-v1 · New | awportrait@0.5, moviewide@0.45 | natural |  |  |
| 6 | **Sunset beach** `26241c54` | soul-v1 · New | awportrait@0.5, goldenhour@0.7 | golden-hour |  |  |
| 7 | **Mt. Fuji** `de0118ba` | soul-v1 · New | awportrait@0.5 | pop |  | Prompt-only beyond the core LoRA. |
| 8 | **Street view** `a13917c7` | soul-v1 · New | awportrait@0.4, snapshot@0.55 | natural |  |  |
| 9 | **Tokyo Streetstyle** `99de6fc5` | soul-v1 · All presets | awportrait@0.5, fe85@0.35 | pop |  |  |
| 10 | **Bimbocore** `f96913e8` | soul-v1 · TikTok Core | awportrait@0.5, hardflash@0.5 | pop |  |  |
| 11 | **CCTV** `07a85fb3` | soul-v1 · TikTok Core | prompt-only | cold-steel | **yes** | No cleared CCTV LoRA found. Train fuobe-cctv; add the timestamp and camera-ID overlay in post. |
| 12 | **Elevator Mirror** `524be50a` | soul-v1 · All presets | snapshot@0.6, hardflash@0.4 | — |  |  |
| 13 | **Y2K** `6b9e6b4d` | soul-v1 · TikTok Core | y2k@0.9, awportrait@0.35 | pop |  |  |
| 14 | **RingSelfie** `9de8ed26` | soul-v1 · All presets | hardflash@0.6, nailart@0.45 | — |  |  |
| 15 | **Spotlight** `40ff999c` | soul-v1 · Mood | hardflash@0.7, awportrait@0.4 | — |  |  |
| 16 | **Y2K Posters** `cbefda85` | soul-v1 · TikTok Core | airbrush80s@0.8, y2k@0.5 | pop |  | For posters with real words, switch the base to Qwen-Image 2512 (better lettering) and drop the Z-Image LoRAs. |
| 17 | **Nail Check** `4b66c2db` | soul-v1 · Surreal | nailart@0.8, awportrait@0.3 | — |  |  |
| 18 | **Gorpcore** `96758335` | soul-v1 · All presets | awportrait@0.5 | natural |  | Prompt-only beyond the core LoRA. |
| 19 | **90s Grain** `f5c094c7` | soul-v1 · Beauty | amateur90s@0.8, grainscape@0.4 | portra |  |  |
| 20 | **0.5 Selfie** `8dd89de9` | soul-v1 · All presets | snapshot@0.6, moviewide@0.4 | — | **yes** | The 0.5x phone-lens stretch is not reliable from prompts. Train fuobe-ultrawide-05. |
| 21 | **0.5 Outfit** `71fecd8c` | soul-v1 · All presets | snapshot@0.5 | — | **yes** | Same LoRA as 0.5 Selfie (fuobe-ultrawide-05). |
| 22 | **Medieval** `1fc861ed` | soul-v1 · All presets | filmstill@0.6, awportrait@0.4 | old-lens |  | Medieval - CE (civitai) has no third-party hosting right, so the film-still LoRA carries the look. |
| 23 | **Japandi** `0089e17c` | soul-v1 · All presets | awportrait@0.5, negspace@0.4 | natural |  |  |
| 24 | **Coquette core** `bd78cfc6` | soul-v1 · All presets | dreamyglow@0.55, awportrait@0.4 | soft-skin |  |  |
| 25 | **Sand** `ba3d7634` | soul-v1 · Mood | filmstill@0.6, awportrait@0.4 | faded |  |  |
| 26 | **2000s Cam** `181b3796` | soul-v1 · Camera Presets | digicam@0.7, y2k@0.5 | — |  |  |
| 27 | **Quiet luxury** `ff1ad8a2` | soul-v1 · All presets | tailored@0.8, awportrait@0.4 | natural |  |  |
| 28 | **Giant Accessory** `70fbb531` | soul-v1 · Surreal | awportrait@0.4 | — | **yes** | Scale surrealism is unreliable from prompts. Train fuobe-scale-surreal (shared with Giant People, Help It's Too Big). |
| 29 | **HairClips** `ea6f4dc0` | soul-v1 · All presets | awportrait@0.5 | — |  | Prompt-only beyond the core LoRA. |
| 30 | **505room** `673cf0d4` | soul-v1 · All presets | afterdark@0.6, awportrait@0.4 | golden-hour |  |  |
| 31 | **Eating Food** `7df83cc9` | soul-v1 · All presets | snapshot@0.7 | — |  |  |
| 32 | **Rainy Day** `53bdadfa` | soul-v1 · Mood | rain@0.7, awportrait@0.4 | cold-steel |  |  |
| 33 | **Foggy Morning** `0fe8ad66` | soul-v1 · Mood | grainscape@0.5, awportrait@0.4 | faded |  |  |
| 34 | **Avant-garde** `0c636e12` | soul-v1 · Mood | fashion2030@0.6, awportrait@0.4 | — |  |  |
| 35 | **Tumblr** `0367d609` | soul-v1 · All presets | amateur90s@0.6, grainscape@0.4 | faded |  |  |
| 36 | **Through The Glass** `1900111a` | soul-v1 · All presets | awportrait@0.4 | — | **yes** | The only reeded-glass LoRA has no licence. Train fuobe-through-glass; until then prompt-only. |
| 37 | **Vintage PhotoBooth** `83caff04` | soul-v1 · All presets | polaroid@0.5, hardflash@0.5 | — |  | Make the strip in post: four takes with one seed family, stacked into a 1x4 strip in the browser. |
| 38 | **Fisheye** `cc4e7248` | soul-v1 · Camera Presets | fisheye@0.9, awportrait@0.3 | — |  |  |
| 39 | **Geominimal** `372cc37b` | soul-v1 · All presets | negspace@0.7, awportrait@0.4 | — |  |  |
| 40 | **7\** `5659c554` | soul-v1 · All presets | glitch@0.7, awportrait@0.3 | — |  |  |
| 41 | **Selfcare** `d24c016c` | soul-v1 · All presets | awportrait@0.5, dreamyglow@0.3 | soft-skin |  |  |
| 42 | **Babydoll MakeUp** `b7c621b5` | soul-v1 · All presets | awportrait@0.6 | soft-skin |  | Prompt-only beyond the core LoRA (the makeup LoRAs found are civitai-only). |
| 43 | **Fairycore** `7f21e7bd` | soul-v1 · Mood | fairycore@0.7, dreamyglow@0.4 | soft-skin |  |  |
| 44 | **Office beach** `e454956b` | soul-v1 · All presets | sunbleach@0.6, awportrait@0.4 | faded |  |  |
| 45 | **Swords Hill** `5b6f467e` | soul-v1 · All presets | filmstill@0.6, awportrait@0.4 | teal-orange |  |  |
| 46 | **Amalfi Summer** `dab472a6` | soul-v1 · All presets | goldenhour@0.6, awportrait@0.4 | golden-hour |  |  |
| 47 | **Creatures** `b3c8075a` | soul-v1 · Surreal | horroratmo@0.4, awportrait@0.4 | — | **yes** | Creature fusion needs a concept LoRA: train fuobe-creatures. |
| 48 | **Grunge** `ad9de607` | soul-v1 · All presets | grunge@0.8, amateur90s@0.3 | faded |  |  |
| 49 | **Glazed doll skin makeup** `a2a42ada` | soul-v1 · All presets | awportrait@0.7 | soft-skin |  | Prompt-only beyond the core LoRA. |
| 50 | **Invertethereal** `82edba1e` | soul-v1 · Graphic Art | awportrait@0.4 | invert |  | Do it in post: an inverted or solarised curve (add an 'Invert' grade preset). No LoRA needed. |
| 51 | **Indie sleaze** `5a72fec7` | soul-v1 · All presets | hardflash@0.7, emo@0.4 | — |  |  |
| 52 | **Mixed Media** `2fcf02e2` | soul-v1 · Graphic Art | montage@0.8 | — |  |  |
| 53 | **Paper Face** `7fa63380` | soul-v1 · Graphic Art | montage@0.6, paperdiorama@0.3 | — | **yes** | Torn-paper face collage needs its own LoRA: train fuobe-paper-collage. |
| 54 | **2000s Fashion** `facaafeb` | soul-v1 · Graphic Art | y2k@0.8, awportrait@0.3 | pop |  |  |
| 55 | **Movie** `811de7ab` | soul-v1 · All presets | filmstill@0.7, moviewide@0.5 | teal-orange |  | Generate at 21:9 or 2.39:1 (crop from 16:9). |
| 56 | **Overexposed** `d8a35238` | soul-v1 · Mood | sunbleach@0.5, awportrait@0.3 | faded |  | Push exposure in the grade. |
| 57 | **Long legs** `12eda704` | soul-v1 · Graphic Art | awportrait@0.4 | — | **yes** | Train fuobe-long-legs (low-angle elongation). |
| 58 | **Night Beach** `62ba1751` | soul-v1 · All presets | afterdark@0.6, awportrait@0.4 | cold-steel |  |  |
| 59 | **90’s Editorial** `710f9073` | soul-v1 · All presets | film90s@0.7, grainscape@0.4 | portra |  |  |
| 60 | **Sitting on the Street** `7696fd45` | soul-v1 · All presets | awportrait@0.5, retrocine@0.4 | natural |  |  |
| 61 | **Glitch** `62355e77` | soul-v1 · Graphic Art | glitchcore@0.8 | — |  |  |
| 62 | **FashionShow** `86fc814e` | soul-v1 · All presets | hardflash@0.6, awportrait@0.4 | — |  |  |
| 63 | **Artwork** `b9e2d7dc` | soul-v1 · Graphic Art | classicpainting@0.8 | — |  |  |
| 64 | **Graffiti** `0b4dac9a` | soul-v1 · Graphic Art | prompt-only | — |  | Use the Qwen-Image 2512 base (legible lettering); prompt-only. |
| 65 | **Angel Wings** `4c24b43b` | soul-v1 · All presets | angels@0.45, dreamyglow@0.4 | soft-skin |  |  |
| 66 | **PixeletedFace** `34c50302` | soul-v1 · All presets | awportrait@0.4 | — |  | Do the pixelation in post: SAM 3.1 face mask, then a mosaic filter on the masked area. |
| 67 | **Grillz Selfie** `255f4045` | soul-v1 · All presets | hardflash@0.6, awportrait@0.4 | — | **yes** | Grillz detail is weak in base models: train fuobe-grillz. |
| 68 | **Shoe Check** `30458874` | soul-v1 · Surreal | snapshot@0.5 | — |  | Prompt-only beyond the snapshot LoRA. |
| 69 | **Bleached Brows** `cc099663` | soul-v1 · All presets | awportrait@0.6 | — | **yes** | Train fuobe-bleached-brows (the base model keeps drawing brows). |
| 70 | **Object Makeup** `b7908955` | soul-v1 · All presets | montage@0.5, awportrait@0.4 | — | **yes** | Train fuobe-object-makeup. |
| 71 | **360 cam** `294bb3ee` | soul-v1 · Camera Presets | view360@0.6, fisheye@0.5 | — |  |  |
| 72 | **Giant People** `a5f63c3b` | soul-v1 · All presets | awportrait@0.4 | — | **yes** | fuobe-scale-surreal. |
| 73 | **Help It's Too Big** `5ad23bca` | soul-v1 · All presets | awportrait@0.4 | — | **yes** | fuobe-scale-surreal. |
| 74 | **Duplicate** `88126a43` | soul-v1 · Graphic Art | twins@0.8 | — |  |  |
| 75 | **Library** `6fb3e1f5` | soul-v1 · New | awportrait@0.5, fe85@0.4 | portra |  |  |
| 76 | **Escalator** `bab6e4bd` | soul-v1 · New | awportrait@0.5, retrocine@0.35 | cold-steel |  |  |
| 77 | **Gallery** `36061eb7` | soul-v1 · New | negspace@0.6, awportrait@0.4 | natural |  |  |
| 78 | **Crossing the street** `d3e2b71d` | soul-v1 · New | awportrait@0.5, sunbleach@0.3 | — |  |  |
| 79 | **Sunbathing** `bc00b419` | soul-v1 · New | awportrait@0.5, goldenhour@0.4 | golden-hour |  |  |
| 80 | **Subway** `d2e8ba04` | soul-v1 · New | snapshot@0.5, filmstill@0.4 | cold-steel |  |  |
| 81 | **birthday mess** `2d47f079` | soul-v1 · All presets | hardflash@0.7, snapshot@0.4 | — |  |  |
| 82 | **static glow** `fb9cee2b` | soul-v1 · All presets | vhs@0.6, dreamyglow@0.4 | — |  |  |
| 83 | **Clouded Dream** `493bda5b` | soul-v1 · All presets | dreamyglow@0.7 | soft-skin |  |  |
| 84 | **Double take** `2a1898d0` | soul-v1 · All presets | twins@0.8 | — |  |  |
| 85 | **Red balloon** `3de71b9e` | soul-v1 · All presets | negspace@0.5, awportrait@0.4 | — |  | Lock the palette to one red accent (palette lock step). |
| 86 | **tokyo drift** `ce9a88c2` | soul-v1 · All presets | cyberpunk@0.5, filmstill@0.5 | teal-orange |  |  |
| 87 | **Rhyme & blues** `c7ea4e7a` | soul-v1 · All presets | albumcover@0.6, awportrait@0.4 | — |  |  |
| 88 | **Bike mafia** `90df2935` | soul-v1 · All presets | bikers@0.8 | faded |  |  |
| 89 | **dmv** `923e4fb0` | soul-v1 · All presets | hardflash@0.4 | — |  | Prompt-only; crop to an ID frame in post. |
| 90 | **Sea breeze** `71ac929c` | soul-v1 · All presets | awportrait@0.5, goldenhour@0.3 | natural |  |  |
| 91 | **It’s french** `79bfaa63` | soul-v1 · All presets | awportrait@0.5, fe85@0.3 | portra |  |  |
| 92 | **Fish-eye twin** `d4775423` | soul-v1 · All presets | fisheye@0.7, twins@0.6 | — |  |  |
| 93 | **hallway noir** `a643a36a` | soul-v1 · All presets | darkroomnoir@0.8 | noir |  |  |
| 94 | **burgundy suit** `84c23cef` | soul-v1 · All presets | tailored@0.6, awportrait@0.4 | — |  |  |
| 95 | **Nicotine glow** `5dbb6a20` | soul-v1 · All presets | afterdark@0.6, awportrait@0.3 | golden-hour |  |  |
| 96 | **green editorial** `91abc4fe` | soul-v1 · All presets | awportrait@0.5, fe85@0.4 | — |  | Lock a green palette (Soul HEX) after generation. |
| 97 | **afterparty cam** `5765d07d` | soul-v1 · All presets | hardflash@0.7, digicam@0.5 | — |  |  |
| 98 | **2049** `53959c8a` | soul-v1 · All presets | filmstill@0.6, cyberpunk@0.4 | teal-orange |  |  |
| 99 | **Fireproof** `373420f7` | soul-v1 · All presets | filmstill@0.6, awportrait@0.4 | — |  |  |
| 100 | **Night rider** `1fba888b` | soul-v1 · All presets | afterdark@0.5, filmstill@0.5 | — |  |  |
| 101 | **chrome exit** `5e01339d` | soul-v1 · All presets | chrome@0.7, cybery2k@0.4 | — |  |  |
| 102 | **brick shade** `f3968a4f` | soul-v1 · All presets | awportrait@0.5, grunge@0.3 | — |  |  |
| 103 | **blackout fit** `f8dac072` | soul-v1 · All presets | awportrait@0.5 | — |  | Prompt-only beyond the core LoRA. |
| 104 | **cocktail** `aed71142` | soul-v1 · All presets | holdingglass@0.6, afterdark@0.4 | golden-hour |  |  |
| 105 | **mount view** `3c975998` | soul-v1 · All presets | awportrait@0.5, moviewide@0.4 | natural |  |  |
| 106 | **Sunburnt** `e439bd89` | soul-v1 · All presets | sunbleach@0.6, goldenhour@0.4 | golden-hour |  |  |
| 107 | **General** `3db34ab5` | soul-v2 · All presets | awportrait@0.6, grainscape@0.3 | natural |  | Soul 2.0 default. |
| 108 | **Warm ambient** `fafd3087` | soul-v2 · Styles | awportrait@0.5, afterdark@0.3 | golden-hour |  |  |
| 109 | **Y2K studio** `7ee16ff3` | soul-v2 · Camera | y2k@0.7, hardflash@0.4 | pop |  |  |
| 110 | **Swag era** `6dffca48` | soul-v2 · Mood | hardflash@0.6, snapshot@0.4 | — |  |  |
| 111 | **Theatrical light** `7876c2a5` | soul-v2 · Styles | filmstill@0.5, awportrait@0.4 | — |  |  |
| 112 | **Y2K street** `d7e58c26` | soul-v2 · Styles | y2k@0.7, snapshot@0.4 | — |  |  |
| 113 | **Flash editorial** `5e87c5bd` | soul-v2 · Styles | hardflash@0.7, awportrait@0.4 | — |  |  |
| 114 | **Old smartphone** `a7cb654b` | soul-v2 · Camera | digicam@0.5, snapshot@0.5 | — | **yes** | The two phone-camera LoRAs on civitai have no cleared rights. Train fuobe-old-phone on photos taken with real 2005-2010 phones. |
| 115 | **Street photography** `95151de0` | soul-v2 · Camera | retrocine@0.5, awportrait@0.4 | natural |  |  |
| 116 | **Retro BW** `069f5a5f` | soul-v2 · Camera | bwphoto@0.7, grainscape@0.5 | noir |  |  |
| 117 | **Asian nostalgia** `99716f25` | soul-v2 · Mood | softfuji@0.6, grainscape@0.4 | portra |  |  |
| 118 | **Surreal solarization** `26bb19d1` | soul-v2 · Mood | awportrait@0.4 | solarize |  | Do it in post: a solarise curve (add a 'Solarize' grade preset). No LoRA needed. |
| 119 | **Subtle flash** `e62e75c2` | soul-v2 · Styles | hardflash@0.4, awportrait@0.5 | natural |  |  |
| 120 | **Digital camera** `74abc530` | soul-v2 · Camera | digicam@0.8, hardflash@0.4 | — |  |  |
| 121 | **Siren** `cfd92ced` | soul-v2 · Mood | awportrait@0.5, neonnoir@0.3 | — |  |  |
| 122 | **Mystique city** `d6371f60` | soul-v2 · Mood | neonnoir@0.6, rain@0.3 | teal-orange |  |  |
| 123 | **Candy pop** `cd55643f` | soul-v2 · Styles | awportrait@0.5 | pop |  | Prompt-only beyond the core LoRA; lock a candy palette in post. |
| 124 | **Double exposure** `7a42d44e` | soul-v2 · Mood | doubleexp@0.8 | — |  | V67 Double Exposure (civitai) is the alternative. |
| 125 | **2000s band** `330789e8` | soul-v2 · Styles | digicam@0.5, hardflash@0.5 | — |  |  |
| 126 | **Frutiger aero** `599d96ce` | soul-v2 · Styles | prompt-only | pop | **yes** | The FrutigerAero LoRA forbids selling outputs. Train fuobe-frutiger-aero from own renders. |
| 127 | **Drain** `8261de31` | soul-v2 · Styles | emo@0.6, amateur90s@0.3 | faded |  |  |
| 128 | **Extraterrestrial** `82e55816` | soul-v2 · All presets | scifi80s@0.5, filmstill@0.4 | teal-orange |  |  |
| 129 | **Editorial street style** `3d5584b2` | soul-v2 · Styles | awportrait@0.5, fe85@0.4 | — |  |  |
| 130 | **Nature light** `dbe816eb` | soul-v2 · All presets | awportrait@0.6, lenovo@0.3 | natural |  |  |
| 131 | **New Indie** `184401c9` | soul-v2 · All presets | grainscape@0.5, amateur90s@0.4 | faded |  |  |
| 132 | **Underwater** `04022c41` | soul-v2 · All presets | awportrait@0.4 | — | **yes** | Train fuobe-underwater on licensed underwater portraits. |
| 133 | **80s horror** `313f3e05` | soul-v2 · All presets | horror80s@0.8, neonnoir@0.3 | — |  |  |
| 134 | **Disposable camera** `7ef8747e` | soul-v2 · All presets | amateur90s@0.6, hardflash@0.5 | — |  |  |
| 135 | **Neutral pastel film** `adbca234` | soul-v2 · All presets | softfuji@0.5, grainscape@0.4 | faded |  |  |
| 136 | **Warm vivid film** `dbaabc25` | soul-v2 · All presets | technicolor@0.6, grainscape@0.3 | pop |  |  |
| 137 | **BW film** `3ece570b` | soul-v2 · All presets | bwphoto@0.6, grainscape@0.5 | noir |  |  |
| 138 | **Warm contrast film** `2c109e42` | soul-v2 · All presets | reversal@0.5, grainscape@0.3 | 16mm |  |  |
| 139 | **Muted cool film** `a15510bf` | soul-v2 · All presets | grainscape@0.5, awportrait@0.3 | cold-steel |  |  |

### 5.2 LoRA library

*commercial* = outputs may be sold; *hosted* = may run on fal/Replicate (civitai 'Rent'); *dl* = `direct` or `civitai-token`.

| key | LoRA | trigger | strength | licence | commercial | hosted | dl | released |
|---|---|---|---|---|---|---|---|---|
| `awportrait` | [Shakker-Labs AWPortrait-Z](https://huggingface.co/Shakker-Labs/AWPortrait-Z) · [file](https://huggingface.co/Shakker-Labs/AWPortrait-Z/resolve/main/AWPortrait-Z.safetensors) | — | 0.6 | Apache-2.0 | yes | yes | direct | 2025-12-14 |
| `lenovo` | [Danrisi Lenovo UltraReal (phone realism)](https://huggingface.co/Danrisi/Lenovo_UltraReal_Z_Image) · [file](https://huggingface.co/Danrisi/Lenovo_UltraReal_Z_Image/resolve/main/lenovo_z.safetensors) | — | 0.7 | Apache-2.0 | yes | yes | direct | 2025-11-30 |
| `grainscape` | [Danrisi GrainScape UltraReal (film grain)](https://huggingface.co/Danrisi/GrainScape_UltraReal_ZImage) · [file](https://huggingface.co/Danrisi/GrainScape_UltraReal_ZImage/resolve/main/grainscape_zimage.safetensors) | — | 0.5 | Apache-2.0 | yes | yes | direct | 2025-12-02 |
| `realism` | [suayptalha Z-Image-Turbo Realism](https://huggingface.co/suayptalha/Z-Image-Turbo-Realism-LoRA) · [file](https://huggingface.co/suayptalha/Z-Image-Turbo-Realism-LoRA/resolve/main/pytorch_lora_weights.safetensors) | Realism | 0.7 | Apache-2.0 | yes | yes | direct | 2025-12-09 |
| `snapshot` | [Yuuuna Realistic Snapshot v5](https://huggingface.co/Yuuuna/RealisticSnapshotZImageTurbo) · [file](https://huggingface.co/Yuuuna/RealisticSnapshotZImageTurbo/resolve/main/RealisticSnapshot-Zimage-Turbov5.safetensors) | amateur digital snapshot, candid, smartphone capture | 0.65 | Apache-2.0 | yes | yes | direct | 2026-06-27 |
| `amateur` (spare) | [rkppvc Z-Image Amateur Photo](https://huggingface.co/rkppvc/z-image_amateur_photo_v1) · [file](https://huggingface.co/rkppvc/z-image_amateur_photo_v1/resolve/main/amateur_photography_zimage_v1.safetensors) | — | 0.7 | Apache-2.0 | yes | yes | direct | 2026-01-02 |
| `technicolor` | [renderartist Technically Color Z](https://huggingface.co/renderartist/Technically-Color-Z-Image-Turbo) · [file](https://huggingface.co/renderartist/Technically-Color-Z-Image-Turbo/resolve/main/Technically_Color_Z_Image_Turbo_v1_renderartist_2000.safetensors) | t3chnic4lly | 0.8 | Apache-2.0 | yes | yes | direct | 2025-11-29 |
| `reversal` | [AIImageStudio Reversal Film Gravure v2.0](https://huggingface.co/AIImageStudio/ReversalFilmGravure_z_Image_turbo_v2.0) · [file](https://huggingface.co/AIImageStudio/ReversalFilmGravure_z_Image_turbo_v2.0/resolve/main/z_image_turbo_ReversalFilmGravure_v2.0.safetensors) | Reversal Film Gravure, analog film photography | 0.5 | Apache-2.0 | yes | yes | direct | 2025-12-12 |
| `sunbleach` | [Quorlen Sunbleached Photograph](https://huggingface.co/Quorlen/z_image_turbo_Sunbleached_Protograph_Style_Lora) · [file](https://huggingface.co/Quorlen/z_image_turbo_Sunbleached_Protograph_Style_Lora/resolve/main/zimageturbo_Sunbleach_Photograph_Style_Lora_TAV2_000002500_%28recommended%29.safetensors) | Act1vate! | 0.8 | MIT | yes | yes | direct | 2025-12-03 |
| `reededglass` (spare) | [Quorlen Behind Reeded Glass](https://huggingface.co/Quorlen/Z-Image-Turbo-Behind-Reeded-Glass-Lora) · [file](https://huggingface.co/Quorlen/Z-Image-Turbo-Behind-Reeded-Glass-Lora/resolve/main/Z_Image_Turbo_Behind_Reeded_Glass_Lora_TAV2_000000750.safetensors) | Act1vate!, Behind reeded glass | 0.8 | none declared | no | no | direct | 2025-12-02 |
| `filmstill` | [artificialguybr Cinematic Film Still Redmond](https://huggingface.co/artificialguybr/CINEMATIC-FILMSTILL-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/CINEMATIC-FILMSTILL-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DFilmStill_Redmond.safetensors) | CINEMATIC, FILM STILL | 0.8 | Apache-2.0 | yes | yes | direct | 2026-02-20 |
| `analog` (spare) | [artificialguybr Analog Redmond](https://huggingface.co/artificialguybr/ANALOG-REDMOND-ZIMAGETURBO) · [file](https://huggingface.co/artificialguybr/ANALOG-REDMOND-ZIMAGETURBO/resolve/main/%5BZImage.Turbo%5DAnalog_Redmond.safetensors) | AnalogRedmAF, ANALOG | 0.8 | Apache-2.0 | yes | yes | direct | 2026-02-19 |
| `filmgrain` (spare) | [artificialguybr Film Grain Redmond](https://huggingface.co/artificialguybr/FILMGRAIN-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/FILMGRAIN-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DFilmGrain_Redmond.safetensors) | FILMGRAIN, FilmGrainAF | 0.7 | Apache-2.0 | yes | yes | direct | 2026-02-25 |
| `fisheye` | [artificialguybr Fish Eye Redmond](https://huggingface.co/artificialguybr/FISHEYE-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/FISHEYE-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DFishEye_Redmond.safetensors) | Fish Eye Lens, Fish eye camera | 0.9 | Apache-2.0 | yes | yes | direct | 2026-02-26 |
| `doubleexp` | [artificialguybr Double Exposure Redmond](https://huggingface.co/artificialguybr/DOUBLEEXPOSURE-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/DOUBLEEXPOSURE-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DDoubleExposure_Redmond.safetensors) | Double Exposure, DoubleExposureREDAF | 0.8 | Apache-2.0 | yes | yes | direct | 2026-02-26 |
| `polaroid` | [artificialguybr Polaroid Redmond](https://huggingface.co/artificialguybr/POLAROID-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/POLAROID-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DPolaroid_Redmond.safetensors) | Polaroid Photo, PolaroidRedAF | 0.7 | Apache-2.0 | yes | yes | direct | 2026-02-26 |
| `snapchat` (spare) | [artificialguybr Snapchat Selfie Redmond](https://huggingface.co/artificialguybr/SNAPCHATSELFIE-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/SNAPCHATSELFIE-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DSnapchatSelfie_Redmond.safetensors) | Snapchat Selfie, Snapchat pic | 0.7 | Apache-2.0 | yes | yes | direct | 2026-02-26 |
| `pixelart` (spare) | [artificialguybr Pixel Art Redmond](https://huggingface.co/artificialguybr/PIXELART-REDMOND-ZIMAGETURBO) · [file](https://huggingface.co/artificialguybr/PIXELART-REDMOND-ZIMAGETURBO/resolve/main/%5BZImage.Turbo%5DPixelArt_Redmond.safetensors) | Pixel Art, PixArFK | 0.8 | Apache-2.0 | yes | yes | direct | 2026-02-17 |
| `view360` | [artificialguybr 360 View Redmond](https://huggingface.co/artificialguybr/360VIEW-REDMOND-ZIMAGETURBO) · [file](https://huggingface.co/artificialguybr/360VIEW-REDMOND-ZIMAGETURBO/resolve/main/%5BZImage.Turbo%5D360viewer_Redmond.safetensors) | 360, 360 VIEW | 0.7 | Apache-2.0 | yes | yes | direct | 2026-02-19 |
| `poster` (spare) | [artificialguybr Poster Redmond](https://huggingface.co/artificialguybr/POSTER-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/POSTER-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DPoster_Redmond.safetensors) | Poster | 0.7 | Apache-2.0 | yes | yes | direct | 2026-03-02 |
| `albumcover` | [artificialguybr Album Cover Redmond](https://huggingface.co/artificialguybr/ALBUMCOVER-REDMOND-ZIMAGE) · [file](https://huggingface.co/artificialguybr/ALBUMCOVER-REDMOND-ZIMAGE/resolve/main/%5BZImage.Turbo%5DAlbumCover_Redmond.safetensors) | ALBUM COVER | 0.7 | Apache-2.0 | yes | yes | direct | 2026-03-01 |
| `digicam` | [AlamandaCathartica Digicam](https://huggingface.co/AlamandaCathartica/Digicam-LoRA) · [file](https://huggingface.co/AlamandaCathartica/Digicam-LoRA/resolve/main/digicam_v1.safetensors) | retrodigicam | 0.8 | BigScience OpenRAIL-M | yes | yes | direct | 2026-03-25 |
| `darkroomnoir` | [frankbarbs DARKROOM Noir](https://huggingface.co/frankbarbs/darkroom-noir-zimage) · [file](https://huggingface.co/frankbarbs/darkroom-noir-zimage/resolve/main/darkroom-noir.safetensors) | drkrm style | 0.8 | Apache-2.0 | yes | yes | direct | 2026-08-08 |
| `airbrush80s` | [tarn59 80s Air Brush](https://huggingface.co/tarn59/80s_air_brush_style_z_image_turbo) · [file](https://huggingface.co/tarn59/80s_air_brush_style_z_image_turbo/resolve/main/80s_air_brush_style_v2_z_image_turbo.safetensors) | 80s Air Brush style | 0.8 | Apache-2.0 | yes | yes | direct | 2025-12-06 |
| `classicpainting` | [renderartist Classic Painting Z](https://huggingface.co/renderartist/Classic-Painting-Z-Image-Turbo-LoRA) · [file](https://huggingface.co/renderartist/Classic-Painting-Z-Image-Turbo-LoRA/resolve/main/Classic_Painting_Z_Image_Turbo_v1_renderartist_1750.safetensors) | class1cpa1nt | 0.8 | Apache-2.0 | yes | yes | direct | 2025-12-02 |
| `grunge` | [jarod2212 Rebel Essence Grunge](https://huggingface.co/jarod2212/RebelEssence_Grunge_Edition) · [file](https://huggingface.co/jarod2212/RebelEssence_Grunge_Edition/resolve/main/Rebel_Essence_Grunge_Edition_000000800.safetensors) | rebelessence | 0.8 | Apache-2.0 | yes | yes | direct | 2026-06-02 |
| `bikers` | [jarod2212 Rebel Essence Bikers](https://huggingface.co/jarod2212/Rebel_Essence_Bikers) · [file](https://huggingface.co/jarod2212/Rebel_Essence_Bikers/resolve/main/Rebel%20Essence_Bikers_000001200.safetensors) | rebelessence | 0.8 | Apache-2.0 | yes | yes | direct | 2026-06-14 |
| `emo` | [jarod2212 Rebel Essence Emo](https://huggingface.co/jarod2212/Rebel_Essence_Emo_Version) · [file](https://huggingface.co/jarod2212/Rebel_Essence_Emo_Version/resolve/main/Rebel_Essence_EMO.safetensors) | emoessence | 0.7 | Apache-2.0 | yes | yes | direct | 2026-06-13 |
| `horror80s` | [neph1 1980s Horror Movies](https://civitai.com/models/1592586) · [file](https://huggingface.co/neph1/80s_horror_movies_lora_zit/resolve/main/80s_horror_z_80.safetensors) | 80s_horror | 0.8 | civitai permissions: Image, Rent, Sell (no credit needed) | yes | yes | direct | 2025-12-07 |
| `scifi80s` | [neph1 1980s SciFi Movies](https://civitai.com/models/1802714) · [file](https://huggingface.co/neph1/80s_scifi_lora_zit/resolve/main/80s_scifi_z_80.safetensors) | 80s_scifi | 0.7 | civitai permissions: Image, Rent, Sell | yes | yes | direct | 2026-01-01 |
| `pencil` (spare) | [Ttio2 Pencil Sketch](https://huggingface.co/Ttio2/Z-Image-Turbo-pencil-sketch) · [file](https://huggingface.co/Ttio2/Z-Image-Turbo-pencil-sketch/resolve/main/Zimage_pencil_sketch.safetensors) | — | 0.8 | Apache-2.0 | yes | yes | direct | 2025-12-08 |
| `y2k` | [V67 Y2K Style](https://civitai.com/models/2979601) · [file](https://civitai.com/api/download/models/3422541) | y2k style, early 2000s aesthetic, digicam flash photography, ccd grain | 0.9 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-10-22 |
| `doubleexp67` (spare) | [V67 Double Exposure](https://civitai.com/models/2505283) · [file](https://civitai.com/api/download/models/3404326) | double exposure, overlapping, analog film aesthetic | 0.8 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-10-14 |
| `bokeh67` (spare) | [V67 Bokeh](https://civitai.com/models/2560499) · [file](https://civitai.com/api/download/models/3402299) | bokeh, soft background blur, creamy defocus circles | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-10-13 |
| `dreamyglow` | [V67 Dreamy Glow](https://civitai.com/models/2783061) · [file](https://civitai.com/api/download/models/3134605) | dreamy glow, soft bloom, ethereal mist, pastel wash | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-07-16 |
| `negspace` | [V67 Negative Space](https://civitai.com/models/2428121) · [file](https://civitai.com/api/download/models/2857606) | negative space, minimalist frame, empty background | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-04-14 |
| `twins` | [V67 Twins and Mirror](https://civitai.com/models/2432659) · [file](https://civitai.com/api/download/models/2765751) | twins, identical twins, doppelganger effect, mirror reflection | 0.8 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-03-12 |
| `goldenhour` | [V67 Golden Hour](https://civitai.com/models/2455960) · [file](https://civitai.com/api/download/models/2969136) | golden hour, sunset, warm tones, soft light | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-05-23 |
| `rain` | [V67 Rain effect](https://civitai.com/models/2781264) · [file](https://civitai.com/api/download/models/3132397) | rain effect, steady rain, wet asphalt, puddle reflections, foggy window | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-07-15 |
| `horroratmo` | [V67 Dark horror atmosphere](https://civitai.com/models/2537838) · [file](https://civitai.com/api/download/models/3003767) | — | 0.5 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-06-04 |
| `cyberpunk` | [V67 Cyberpunk](https://civitai.com/models/2475476) · [file](https://civitai.com/api/download/models/2978876) | cyberpunk, retro-futuristic, neon-lit, rainy street | 0.5 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-05-26 |
| `tailored` | [V67 Fashionable, modest, well-tailored](https://civitai.com/models/2433914) · [file](https://civitai.com/api/download/models/2763080) | fashionable, modest, well-tailored, elegant, refined | 0.8 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-03-11 |
| `angels` | [V67 Angels and Demons](https://civitai.com/models/2476940) · [file](https://civitai.com/api/download/models/2784831) | angel_twin, duality | 0.5 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-03-19 |
| `symbolic` (spare) | [V67 Symbolic Surrealism](https://civitai.com/models/2584401) · [file](https://civitai.com/api/download/models/2903381) | symbolic surrealism | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-04-29 |
| `paperdiorama` | [V67 Layered paper diorama](https://civitai.com/models/2635570) · [file](https://civitai.com/api/download/models/2959128) | layered paper diorama, cut paper art | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-05-19 |
| `moviewide` | [Movie Wide Angle Z-image](https://civitai.com/models/2186574) · [file](https://civitai.com/api/download/models/2462010) | — | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-02 |
| `amateur90s` | [Amateur Photos 90s 77](https://civitai.com/models/1713178) · [file](https://civitai.com/api/download/models/2455887) | AmateurPhotos90s-77 | 0.8 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-11-30 |
| `film90s` | [Last Days of Film - Early 1990s](https://civitai.com/models/2335283) · [file](https://civitai.com/api/download/models/2626911) | — | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-01-24 |
| `vhs` | [vhsCommercial](https://civitai.com/models/2175050) · [file](https://civitai.com/api/download/models/2449356) | vhsCommercial1 | 0.6 | civitai permissions: Image, RentCivit, Rent | yes | yes | civitai-token | 2025-11-29 |
| `softfuji` | [Soft Fuji Film Lighting](https://civitai.com/models/2385614) · [file](https://civitai.com/api/download/models/2682572) | sec_filter | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-02-12 |
| `retrocine` | [Cinematic Retro Photography](https://civitai.com/models/2188839) · [file](https://civitai.com/api/download/models/2464525) | ff-crp | 0.6 | civitai permissions: Image, RentCivit, Rent | yes | yes | civitai-token | 2025-12-03 |
| `prophoto` (spare) | [Z-Image Professional Photographer](https://civitai.com/models/2222143) · [file](https://civitai.com/api/download/models/2501671) | — | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-14 |
| `fe85` | [Portrait Prime FE85F14](https://civitai.com/models/2189507) · [file](https://civitai.com/api/download/models/2465276) | fe85f14 | 0.5 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-03 |
| `helios` (spare) | [Helios 44-2](https://civitai.com/models/2195959) · [file](https://civitai.com/api/download/models/2472573) | h442x | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-05 |
| `afterdark` | [AfterDark (lomo night film)](https://civitai.com/models/2176378) · [file](https://civitai.com/api/download/models/2470291) | 4ft3rd4rk | 0.6 | civitai permissions: Image, RentCivit, Rent | yes | yes | civitai-token | 2025-12-04 |
| `neonnoir` | [Neon Noir Style](https://civitai.com/models/1152256) · [file](https://civitai.com/api/download/models/2666905) | neon_horror_noir_style | 0.5 | civitai permissions: Image, Rent, RentCivit | yes | yes | civitai-token | 2026-02-07 |
| `hardflash` | [Hard Flash](https://civitai.com/models/2187803) · [file](https://civitai.com/api/download/models/2463391) | hardflashy | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-02 |
| `glitch` | [Glitch Effect](https://civitai.com/models/2236698) · [file](https://civitai.com/api/download/models/2517923) | gl1tch | 0.7 | civitai permissions: Image, RentCivit, Rent | yes | yes | civitai-token | 2025-12-19 |
| `glitchcore` | [Glitchcore](https://civitai.com/models/2326983) · [file](https://civitai.com/api/download/models/2617681) | Glitchcore | 0.8 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-01-21 |
| `bwphoto` | [artsyblackandwhitephoto](https://civitai.com/models/2251929) · [file](https://civitai.com/api/download/models/2535018) | — | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-25 |
| `cybery2k` | [Cyber-Y2K](https://civitai.com/models/2321628) · [file](https://civitai.com/api/download/models/2611775) | — | 0.5 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-01-19 |
| `fairycore` | [Fairycore (World Morph)](https://civitai.com/models/1840174) · [file](https://civitai.com/api/download/models/2473211) | — | 0.7 | civitai permissions: Image, RentCivit, Rent | yes | yes | civitai-token | 2025-12-05 |
| `chrome` | [Chrome Enhancer](https://civitai.com/models/2206027) · [file](https://civitai.com/api/download/models/2512220) | — | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-17 |
| `nailart` | [Bingguo Nail Art](https://civitai.com/models/2310703) · [file](https://civitai.com/api/download/models/2599748) | — | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-01-15 |
| `holdingglass` | [Holding glass / woman with a drink](https://civitai.com/models/2186352) · [file](https://civitai.com/api/download/models/2461767) | Holding glass | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-02 |
| `montage` | [XUPLX Unusual Photo Montage](https://civitai.com/models/2264765) · [file](https://civitai.com/api/download/models/2549232) | xuplx | 0.7 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2025-12-30 |
| `fashion2030` | [2030s fashion](https://civitai.com/models/2460753) · [file](https://civitai.com/api/download/models/3388483) | — | 0.6 | civitai permissions: Image, RentCivit, Rent, Sell, SellMerge | yes | yes | civitai-token | 2026-10-06 |

**Looked at and not used** (no commercial-output right, no hosting right, or no licence):

- [Phonecam - Z-Image](https://civitai.com/models/2214238): Image, RentCivit only: no right to run it on fal/Replicate
- [Mobile Cell Phone Photography](https://civitai.com/models/645985): RentCivit, Rent: outputs may not be sold
- [Cinematic Shot](https://civitai.com/models/432586): RentCivit, Image: no third-party hosting
- [Medieval - CE](https://civitai.com/models/754926): Image, RentCivit: no third-party hosting
- [Early 2000s TV](https://civitai.com/models/2191119): Image, RentCivit: no third-party hosting
- [90s Indie Movie](https://civitai.com/models/881194): Image, RentCivit; credit required; newest version is Z-Image base
- [Japan 1980s Photography](https://civitai.com/models/2220971): RentCivit, Rent: outputs may not be sold
- [FrutigerAero](https://civitai.com/models/2421424): RentCivit, Rent: outputs may not be sold
- [Cinematic Pixelated Appearance Effect](https://civitai.com/models/2820030): Image, RentCivit; credit required
- [Ansel Adams Photography](https://civitai.com/models/676722): Image, RentCivit; credit required
- [Behind Reeded Glass](https://huggingface.co/Quorlen/Z-Image-Turbo-Behind-Reeded-Glass-Lora): no licence declared (kept for local tests only)
- [cptsl/2000Retro (HF copy)](https://huggingface.co/cptsl/2000Retro): self-described copy of civitai 2210655, which no longer exists
- [wcde DeJPEG](https://huggingface.co/wcde/Z-Image-Turbo-DeJPEG-Lora): no licence declared
- [JosephMinchala skin texture v4.5](https://huggingface.co/JosephMinchala/JosephMinchala-skin-texture-zturbo-v45): OpenRAIL-M, usable, but AWPortrait-Z covers skin and has a cleaner licence
- [AIImageStudio RadianceChromeVoluptuous](https://huggingface.co/AIImageStudio/RadianceChromeVoluptuous_z_image_turbo_v2.0): expired-film look, but the card samples are sexualised; not used for a default preset

---

## 6. LoRAs Fuobe should train itself

Train only on images Fuobe owns or has licensed for AI training (own shoots, purchased stock with training rights, public-domain or CC0 sets). Do not use Higgsfield outputs or preview images (§2).

| LoRA | kind | presets | data | trainer | steps | use |
|---|---|---|---|---|---|---|
| `fuobe-soul-core` | style | every photographic preset (replaces the AWPortrait-Z + Lenovo slot) | 80-150 editorial and street photos Fuobe owns or licensed with AI-training rights; varied skin tones, ages, light; captions written in Z-Image style (long sentences) | fal-ai/z-image-trainer training_type=style (Z-Image base, $2.26 per 1,000 steps), or AI-Toolkit on Z-Image base / Turbo + ostris training adapter v2 | 2,000-3,000, rank 32, lr 1e-4 | strength 0.5-0.7 |
| `fuobe-cctv` | style | CCTV | 40-80 frames from cameras Fuobe controls (own CCTV, staged scenes); no overlays in the frames | fal-ai/z-image-turbo-trainer-v2 ($0.85 per 1,000 steps) or AI-Toolkit | 1,500-2,000 | strength 0.8; overlay text in post |
| `fuobe-ultrawide-05` | style | 0.5 Selfie, 0.5 Outfit | 60+ selfies and outfit shots taken by the team with phone 0.5x lenses | fal-ai/z-image-turbo-trainer-v2 or AI-Toolkit | 1,500-2,000 | strength 0.7 |
| `fuobe-scale-surreal` | concept | Giant Accessory, Giant People, Help It's Too Big | 40-60 composites (giant props, tiny worlds) made by Fuobe from own photos | fal-ai/z-image-trainer training_type=content | 2,000 | strength 0.7-0.9 |
| `fuobe-through-glass` | style | Through The Glass | 40+ photos shot through fogged, reeded and rain-streaked glass | fal-ai/z-image-turbo-trainer-v2 | 1,500 | strength 0.8 |
| `fuobe-old-phone` | style | Old smartphone (and a second option for iPhone / DigitalCam) | 60+ photos taken on real 2005-2012 camera phones | fal-ai/z-image-turbo-trainer-v2 | 1,500 | strength 0.8 |
| `fuobe-frutiger-aero` | style | Frutiger aero | 40-60 renders Fuobe makes (Blender, own designs) | fal-ai/z-image-trainer training_type=style | 2,000 | strength 0.8 |
| `fuobe-underwater` | style | Underwater | 40+ licensed underwater portraits | fal-ai/z-image-turbo-trainer-v2 | 1,500 | strength 0.8 |
| `fuobe-paper-collage` | style | Paper Face, Object Makeup | 50+ physical paper collages photographed by Fuobe | fal-ai/z-image-trainer training_type=style | 2,000 | strength 0.8 |
| `fuobe-beauty-details` | concept | Grillz Selfie, Bleached Brows, Long legs, Creatures | one small set per concept (20-40 images each), own or licensed | fal-ai/z-image-turbo-trainer-v2, one LoRA per concept | 1,000-1,500 each | strength 0.7 |
| `fuobe-push-in` | motion (Wan 2.2 I2V) | Eyes In, Mouth In, Eating Zoom | 20-40 own-shot push-in clips (2-5 s, 16 fps), released people only | fal-ai/wan-22-trainer/i2v-a14b or AI-Toolkit (wan22_14b_i2v) | 400-1,000 | strength 1.0, both experts |
| `fuobe-timelapse` | motion (Wan 2.2 I2V) | Timelapse, Timelapse Human / Landscape / Glam, Hyperlapse | 30-60 own time-lapse and hyperlapse clips | fal-ai/wan-22-trainer/i2v-a14b or AI-Toolkit | 600-1,000 | strength 1.0, both experts |
| `fuobe-drone-reveal` | motion (Wan 2.2 I2V) | Drone Reveal, Helicopter Shot, Flying | 30-60 own drone reveal clips | fal-ai/wan-22-trainer/i2v-a14b or AI-Toolkit | 600-1,000 | strength 1.0, both experts |

*Added 2026-11-02 (o/o12-training-kit):* the three Wan 2.2 motion rows above (build plan O12) are in the JSON's `fuobeTrainedLoras` too, and every row there now has `group` and `status: "planned"`. The training kit (`scripts/train/`: a job spec and a data-licence log per LoRA, the checks, publishing to Fuobe's Hugging Face org) builds everything up to the run; nothing is trained yet. A row gains a `trained` block (pinned URL, SHA256, licence) when its file is published, and `gen-lora-library.py` then moves it from `PLANNED_LORAS` into the library. AI-Toolkit (main at e9c72b7, read 2026-11-02) trains Wan 2.2 I2V 14B as `wan22_14b_i2v` (`ai-toolkit/Wan2.2-I2V-A14B-Diffusers-bf16`, 4-bit with its accuracy recovery adapter, both experts) and Z-Image base as `zimage` (`Tongyi-MAI/Z-Image`). fal's three trainers' input schemas were read again the same day and match the JSON.

Approximate cost per LoRA on fal: Z-Image Turbo v2 at 2,000 steps $1.70; Z-Image base at 2,000 steps $4.52; Wan 2.2 I2V at 400–1,000 steps $2–5; LTX-2.3 i2v v2 at 2,000 steps $4.80 (prices from the trainers' llms.txt).

---

## 7. Motions and effects

Today `src/lib/catalog/oss-loras.generated.ts` has 93 keys; 18 motions use a LoRA and 11 a Wan 2.2 Fun Camera pose, so 78 motions and 219 effects run prompt-only on the open engine. `scripts/gen-oss-loras.py` only reads Wan I2V LoRAs from `comfyui-oss.json`; the entries below are shaped so it (or a sibling script) can read `motionsEffects` from this file. Each entry has `presets`, `status`, `loras[]` (`url`, `trigger`, `strength`, `target` high/low/both, `base`, `licence`, `commercial`, `hostedOk`), `hosted` and `newSinceMid2026`.

### 7.1 New since mid-2026

Wan 2.2 LoRA releases dropped after May 2026 (civitai's safe-for-work listing, `nsfw=false`, returns only seven Wan 2.2 I2V LoRAs published since 2026-05-01; Hugging Face lists mostly distill and research adapters). The community moved to LTX-2.3/2.5 and MiniMax H3. The useful new ones:

| preset(s) | LoRA | base | released | licence | hosted on |
|---|---|---|---|---|---|
| Handheld, Documentary Snap, Intimate Observer | [Shaky, handheld camera](https://civitai.com/models/2592748) (high) | wan2.2-i2v-a14b | 2026-05-02 | civitai permissions: Image, Rent, Sell | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast |
| Snorricam, Head Tracking | [Headmounted camera / Headbob](https://civitai.com/models/2838538) (high) | wan2.2-i2v-a14b | 2026-08-06 | civitai permissions: Image, Rent, Sell | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast |
| FPV Drone | [chsengni LTX-2.3 FPV motion](https://huggingface.co/chsengni/ltx2.3-fpv-motion) (both) | ltx-2.3-22b | 2026-06-08 | Apache-2.0 (LoRA) on the LTX-2 Community base | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) |
| Slow Motion | [Lightricks LTX-2.5 Slow-Motion-Control](https://huggingface.co/Lightricks/LTX-2.5-22b-LoRA-Slow-Motion-Control) (both) | ltx-2.5-22b | 2026-09-15 | LTX-2.x Community License | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) |
| BTS | [SOLRICKS LTX-2.5 BTS Movie Set](https://huggingface.co/SOLRICKS/LTX-2.5-BTS-Movie-Set) (both) | ltx-2.5-22b | 2026-09-18 | HF card: LTX-2.x Community; civitai 2941912 lists RentCivit only | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) |
| Exploded View | [DigitalByte XPLDV Exploded View (LTX-2.5)](https://huggingface.co/DigitalByte/LTX-2.5-Exploded-View-XPLDV) (both) | ltx-2.5-22b | 2026-09-08 | LTX-2.x Community License | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) |
| Wind to Face | [Lana Wind Motion (LTX-2.3)](https://civitai.com/models/2800393) (both) | ltx-2.3-22b | 2026-07-25 | civitai permissions: Image, Rent, Sell on the LTX-2 Community base | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) |
| Wild Ride, Car Drive | [Car Jump Motion (LTX-2.5 distilled)](https://civitai.com/models/2976868) (both) | ltx-2.5-22b | 2026-10-01 | civitai permissions: Image, Rent, Sell on the LTX-2.x Community base | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) |
| Silhouette, Practicals, Window, Overhead Fall, Contre-jour, Soft Cross | [Lightricks LTX-2.3 IC-LoRA Relight (video)](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Relight) (both) | ltx-2.3-22b | 2026-07-27 | LTX-2 Community License (free under US$10M annual revenue) | fal-ai/ltx-2.3-22b/reference-video-to-video/lora (unverified for this IC-LoRA) |

Also new and worth a later look: Lightricks LTX-2.5 **Cinemagraph** (2026-09-10, gated), LTX-2.5 IC-LoRAs **Water-Simulation**, **Day-To-Night**, **Clean-Plate**, **Refine-Details**, **Pixel-Spatial-Upscaler**, **SDR-To-HDR**, **Alpha-Gen**, **Layout-To-Render** (2026-09, all LTX-2.x Community, video-to-video), Cseti **Cameraman v2** (2026-06-23, copies a camera move from a reference clip, LTX-2.3 IC-LoRA), yuvraj108c **Any-Trajectory-Instruction** (2026-05-18, draw-to-motion for LTX-2.3, Apache), WepeNerd **LTX Ripple** (edit frame 1, propagate; 2026-08-28), AInVFX **fluid** (paint smoke/fire blobs; 2026-09-11) and **Real Stereo Depth Video** for Wan 2.2 (2026-09-19). These are tools for Video tools / Draw to Video, not one-click presets.

### 7.2 Additions to the preset → LoRA map

*commercial / hosted* = the LoRA's licence allows selling outputs / running it on fal or Replicate. *cloud route* = where it can run hosted today.

*Corrected 2026-10-24 (o/lora-plumbing):* BTS was `add-lora`, which would have made a non-commercial LoRA (licence conflict between its Hugging Face and civitai pages) a default. It is now `licence-hold`: BTS stays prompt-only until the author clarifies, and `scripts/gen-lora-library.py` fails when a default row (add-lora, replace, relight-route, weak-candidate, local-only) carries a LoRA with `commercial: false`, or a hostedOk: false LoRA outside a local-only row.

| kind | preset(s) | status | LoRA (target) | trigger | strength | licence | commercial / hosted | cloud route | released |
|---|---|---|---|---|---|---|---|---|---|
| motion | Overhead | add-lora | [Camera Tilt-up Overhead](https://civitai.com/models/1878750) · [high](https://civitai.com/api/download/models/2126493) | (过顶升摇). | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-18 |
|  |  |  | [Camera Tilt-up Overhead](https://civitai.com/models/1878750) · [low](https://civitai.com/api/download/models/2126538) | (过顶升摇). | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-18 |
| motion | Incline | add-lora | [Camera Tilt-down Undershot V2](https://civitai.com/models/1889070) · [high](https://civitai.com/api/download/models/2151623) | 弧降仰底. | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-26 |
|  |  |  | [Camera Tilt-down Undershot V2](https://civitai.com/models/1889070) · [low](https://civitai.com/api/download/models/2151680) | 弧降仰底. | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-26 |
| motion | Handheld, Documentary Snap, Intimate Observer | add-lora | [Shaky, handheld camera](https://civitai.com/models/2592748) · [high](https://civitai.com/api/download/models/2912574) | shaky, handheld | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2026-05-02 |
| motion | Raw Chaos | add-lora | [LuisaP Extreme Handheld Camera](https://civitai.com/models/2103025) · [high](https://civitai.com/api/download/models/2379256) | The camera follows her with a handheld perspective, the viewer shakes | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-05 |
| motion | Snorricam, Head Tracking | add-lora | [Headmounted camera / Headbob](https://civitai.com/models/2838538) · [high](https://civitai.com/api/download/models/3203908) | — | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2026-08-06 |
| motion | POV, Object POV | add-lora | [LuisaP Extreme Bodycam](https://civitai.com/models/2105542) · [high](https://civitai.com/api/download/models/2382055) | the viewer runs through, the hand shows through camera | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-06 |
|  |  |  | [LuisaP Extreme Bodycam](https://civitai.com/models/2105542) · [low](https://civitai.com/api/download/models/2382131) | the viewer runs through, the hand shows through camera | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-06 |
| motion | Downhill POV | add-lora | [First Person POV Parkour](https://civitai.com/models/2144086) · [high](https://civitai.com/api/download/models/2425167) | POV Parkour | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-21 |
|  |  |  | [First Person POV Parkour](https://civitai.com/models/2144086) · [low](https://civitai.com/api/download/models/2425177) | POV Parkour | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-21 |
| motion | Road Rush, Car Grip | add-lora | [LuisaP Driving Crazy](https://civitai.com/models/2066681) · [high](https://civitai.com/api/download/models/2338590) | POVCAR | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-22 |
| motion | Tracking, Dreamy Flow, Catwalk | add-lora | [Flow Camera](https://civitai.com/models/1903906) · [high](https://civitai.com/api/download/models/2155019) | — | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-27 |
| motion | Robo Arm, Robot Arm | add-lora | [Circular shooting](https://civitai.com/models/1926984) · [high](https://civitai.com/api/download/models/2180985) | — | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-09-04 |
| motion | FPV Drone | add-lora | [chsengni LTX-2.3 FPV motion](https://huggingface.co/chsengni/ltx2.3-fpv-motion) · [both](https://huggingface.co/chsengni/ltx2.3-fpv-motion/resolve/main/ltx2.3_fpv_motion.safetensors) | fpv | 1.0 | Apache-2.0 (LoRA) on the LTX-2 Community base | yes / yes | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) | 2026-06-08 |
| motion | Earth Zoom Out | add-lora | [TheBurgstall EarthZoomOut (LTX-2)](https://huggingface.co/TheBurgstall/EarthZoomOut-LoRA-LTX-2-19b) · [both](https://huggingface.co/TheBurgstall/EarthZoomOut-LoRA-LTX-2-19b/resolve/main/lora_weights_step_02000.safetensors) | EARTHZO | 1.0 | LTX-2 Community License (free under US$10M annual revenue) | yes / yes | unverified: fal's LoRA endpoints are LTX-2.3; an LTX-2 19B LoRA may not load | 2026-01-11 |
| motion | Slow Motion | add-lora | [Lightricks LTX-2.5 Slow-Motion-Control](https://huggingface.co/Lightricks/LTX-2.5-22b-LoRA-Slow-Motion-Control) · [both](https://huggingface.co/Lightricks/LTX-2.5-22b-LoRA-Slow-Motion-Control/resolve/main/ltx-2.5-22b-lora-slow-motion-control-1.0.safetensors) | — | 1.0 | LTX-2.x Community License | yes / yes | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) | 2026-09-15 |
| motion | Flying Cam Transition | add-lora | [joyfox LTX-2.3 Transition](https://huggingface.co/joyfox/LTX-2.3-Transition-LORA) · [both](https://huggingface.co/joyfox/LTX-2.3-Transition-LORA/resolve/main/ltx2.3-transition.safetensors) | zhuanchang | 1.0 | Apache-2.0 (LoRA) on the LTX-2 Community base | yes / yes | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) | 2026-03-20 |
| motion | BTS | licence-hold | [SOLRICKS LTX-2.5 BTS Movie Set](https://huggingface.co/SOLRICKS/LTX-2.5-BTS-Movie-Set) · [both](https://huggingface.co/SOLRICKS/LTX-2.5-BTS-Movie-Set/resolve/main/BTSMovieSet_LTX25_v1.safetensors) | btssetstyle | 0.8 | HF card: LTX-2.x Community; civitai 2941912 lists RentCivit only | no / no | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) | 2026-09-18 |
| motion | Wiggle | local-only | [Wiggle Redmond](https://civitai.com/models/2212361) · [high](https://civitai.com/api/download/models/2490836) | Wiggle | 1.0 | civitai permissions: Image, RentCivit (no third-party hosting) | yes / no | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-10 |
|  |  |  | [Wiggle Redmond](https://civitai.com/models/2212361) · [low](https://civitai.com/api/download/models/2490837) | Wiggle | 1.0 | civitai permissions: Image, RentCivit (no third-party hosting) | yes / no | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-10 |
| effect | Building Explosion, Car Explosion | add-lora | [EXPLOSION Redmond](https://civitai.com/models/2100058) · [high](https://civitai.com/api/download/models/2376012) | explosion | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-04 |
|  |  |  | [EXPLOSION Redmond](https://civitai.com/models/2100058) · [low](https://civitai.com/api/download/models/2376017) | explosion | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-04 |
| effect | Atomic | add-lora | [LuisaP NUKE](https://civitai.com/models/2077300) · [high](https://civitai.com/api/download/models/2350486) | NUKE, a nuke explode on the horizon | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-26 |
| effect | Powder Explosion, Plasma Explosion | add-lora | [Wan Video Burst Effect](https://civitai.com/models/1996675) · [high](https://civitai.com/api/download/models/2269611) | — | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-01 |
|  |  |  | [Wan Video Burst Effect](https://civitai.com/models/1996675) · [low](https://civitai.com/api/download/models/2269626) | — | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-01 |
| effect | Freezing | add-lora | [Wan 2.2 Low Frozen effects](https://civitai.com/models/1877231) · [low](https://civitai.com/api/download/models/2124764) | — | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-18 |
| effect | Turning Metal | add-lora | [Metalcification Redmond](https://civitai.com/models/2203812) · [high](https://civitai.com/api/download/models/2481353) | Metalcification | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-07 |
|  |  |  | [Metalcification Redmond](https://civitai.com/models/2203812) · [low](https://civitai.com/api/download/models/2481351) | Metalcification | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-07 |
| effect | Glitch, Datamosh | add-lora | [LuisaP Glitch and Argue (soft)](https://civitai.com/models/2068897) · [high](https://civitai.com/api/download/models/2341106) | Glitch | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-23 |
|  |  |  | [LuisaP Glitch and Argue (soft)](https://civitai.com/models/2068897) · [low](https://civitai.com/api/download/models/2341111) | Glitch | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-10-23 |
| effect | Hero Flight, I Can Fly, Levitation | add-lora | [LuisaP Fly Away](https://civitai.com/models/2093345) · [high](https://civitai.com/api/download/models/2368440) | FLYAWAY, the person is standing then fly away | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-02 |
|  |  |  | [LuisaP Fly Away](https://civitai.com/models/2093345) · [low](https://civitai.com/api/download/models/2368441) | FLYAWAY, the person is standing then fly away | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-02 |
| effect | Exploded View | add-lora | [Item decomposition](https://civitai.com/models/1903456) · [high](https://civitai.com/api/download/models/2154508) | FJ | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-08-27 |
|  |  |  | [DigitalByte XPLDV Exploded View (LTX-2.5)](https://huggingface.co/DigitalByte/LTX-2.5-Exploded-View-XPLDV) · [both](https://huggingface.co/DigitalByte/LTX-2.5-Exploded-View-XPLDV/resolve/main/ltx-2.5-xpldv_v5-lora.safetensors) | — | 0.5 | LTX-2.x Community License | yes / yes | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) | 2026-09-08 |
| effect | Money Rain | add-lora | [Wan2.2 coin fountain (金币喷泉)](https://civitai.com/models/2140472) · [high](https://civitai.com/api/download/models/2421124) | coinfirework | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-19 |
|  |  |  | [Wan2.2 coin fountain (金币喷泉)](https://civitai.com/models/2140472) · [low](https://civitai.com/api/download/models/2421166) | coinfirework | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-19 |
| effect | Wind to Face | add-lora | [Lana Wind Motion (LTX-2.3)](https://civitai.com/models/2800393) · [both](https://civitai.com/api/download/models/3156988) | — | 1.0 | civitai permissions: Image, Rent, Sell on the LTX-2 Community base | yes / yes | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) | 2026-07-25 |
| effect | Wild Ride, Car Drive | add-lora | [Car Jump Motion (LTX-2.5 distilled)](https://civitai.com/models/2976868) · [both](https://civitai.com/api/download/models/3374037) | — | 1.0 | civitai permissions: Image, Rent, Sell on the LTX-2.x Community base | yes / yes | none: fal has no LTX-2.5 LoRA endpoint (ComfyUI only) | 2026-10-01 |
| effect | Seamless Transition, Melt Transition, Smoke Transition, Splash Transition, Flame Transition, Hand Transition, Hole Transition, Jump Transition, Column Wipe, Display Transition, Trucksition, Raven Transition, Lidar Transition | add-lora | [joyfox LTX-2.3 Transition](https://huggingface.co/joyfox/LTX-2.3-Transition-LORA) · [both](https://huggingface.co/joyfox/LTX-2.3-Transition-LORA/resolve/main/ltx2.3-transition.safetensors) | zhuanchang | 1.0 | Apache-2.0 (LoRA) on the LTX-2 Community base | yes / yes | fal-ai/ltx-2.3-22b/image-to-video/lora (IC-LoRAs: fal-ai/ltx-2.3-22b/reference-video-to-video/lora) | 2026-03-20 |
| effect | Flashback | add-lora | [Cinematic Smash Cut](https://civitai.com/models/2126015) · [high](https://civitai.com/api/download/models/2404934) | smash cut to | 1.0 | civitai permissions: Image, Rent, Sell | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-11-14 |
| effect | Thunder God | replace | [ThunderHero Redmond](https://civitai.com/models/2205918) · [high](https://civitai.com/api/download/models/2483698) | Thunder Hero | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=high); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-08 |
|  |  |  | [ThunderHero Redmond](https://civitai.com/models/2205918) · [low](https://civitai.com/api/download/models/2483693) | Thunder Hero | 1.0 | civitai permissions: Image, Rent | yes / yes | fal-ai/wan/v2.2-a14b/image-to-video/lora (transformer=low); Replicate wan-video/wan-2.2-i2v-fast | 2025-12-08 |
| effect | Set On Fire, Fire Breath, Fire Element, Flame On, Burning Man, Firelava | weak-candidate | [Remade-AI Fire (Wan 2.1 T2V)](https://huggingface.co/Remade-AI/Fire) · [both](https://huggingface.co/Remade-AI/Fire/resolve/main/fire_12_epochs.safetensors) | r3al_f1re | 1.0 | Apache-2.0 | yes / yes | fal-ai/wan-t2v-lora (T2V only) | 2025 |
| effect | Silhouette, Practicals, Window, Overhead Fall, Contre-jour, Soft Cross | relight-route | [Qwen-Image-Edit-2509 Relight (start frame)](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) · [both](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/loras/Qwen-Image-Edit-2509-Relight.safetensors) | 重新照明 + lighting description | 1.0 | Apache-2.0 | yes / yes | fal-ai/qwen-image-edit-plus-lora | 2025 |
|  |  |  | [Lightricks LTX-2.3 IC-LoRA Relight (video)](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Relight) · [both](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Relight/resolve/main/ltx-2.3-22b-ic-lora-relight-1.0.safetensors) | — | 1.0 | LTX-2 Community License (free under US$10M annual revenue) | yes / yes | fal-ai/ltx-2.3-22b/reference-video-to-video/lora (unverified for this IC-LoRA) | 2026-07-27 |

### 7.3 Aliases, Fun Camera poses and hosted-native moves

- **Glam, Lazy Orbit** (alias): Reuse the orbit pair at 0.6-0.8 and write 'slow' into the prompt. Hosted: `fal-ai/wan/v2.2-a14b/image-to-video/lora` loras[{path, scale 0-4, transformer high|low|both, weight_name}].
- **Jib Up, Jib Down, Epic Scale** (alias): Open: reuse Remade crane_up / crane_down (already mapped for Crane Up/Down). Cloud: LTX-2.3's built-in camera_lora. Hosted: `fal-ai/ltx-2.3-22b/image-to-video/lora` camera_lora=jib_up|jib_down.
- **Dolly Left, Dolly Right, Truck Left, Truck Right** (fun-camera): Open: Wan 2.2 Fun Camera 'Pan Left/Right' (a translation). Cloud: LTX-2.3 camera_lora (or the Lightricks LTX-2 Dolly Left/Right LoRAs on an LTX-2 host). Hosted: `fal-ai/ltx-2.3-22b/image-to-video/lora` camera_lora=dolly_left|dolly_right.
- **Super Dolly Out** (fun-camera): Open: Fun Camera 'Zoom Out'. Hosted: `fal-ai/ltx-2.3-22b/image-to-video/lora` camera_lora=dolly_out.
- **Zoom, Pan, Pedestal Down, Classic Static, Roll Transition, Aerial Pullback** (fun-camera): Add to FUN_CAMERA_POSE in src/lib/catalog/index.ts: Zoom→Zoom In, Pan→Pan Right, Pedestal Down→Pan Down, Classic Static→Static, Roll Transition→ClockWise (CW), Aerial Pullback→Zoom Out. Hosted: `fal-ai/ltx-2.3-22b/image-to-video/lora` camera_lora (dolly_in / static) or prompt.
- **Focus Change** (hosted-native): Open on GPU: prompt-only on Wan; RackFocus (civitai 1783051) forbids selling outputs. Hosted: `lightricks/ltx-2.5/image-to-video/fast` camera_motion=focus_shift.
- **Muscle Up** (alias): Alias to the existing 'muscle' key (Remade Muscle).
- **Vanish** (alias): Alias to the existing 'disintegration' key.
- *Added 2026-10-26 (o/dop):* the JSON rows now carry these maps in a structured form that `scripts/gen-oss-loras.py` reads: `funCamera` (the Fun Camera pose on the open engine), `cameraLora` (LTX-2.3's `camera_lora` in the cloud: Zoom `dolly_in`, Classic Static `static`, Aerial Pullback `dolly_out`, Pedestal Down `jib_down`; Pan and Roll Transition have none and stay prompt-only in the cloud), `cameraMotion` (Focus Change `focus_shift`) and `aliasOf` (the round-1 key reused: Jib Up / Epic Scale `crane-up`, Jib Down `crane-down`, Muscle Up `muscle`, Vanish `disintegration`). A new row gives Dolly Out and Static, already Fun Camera moves on the open engine, LTX-2.3's `dolly_out` / `static` in the cloud. Roll Transition takes an end frame, which the Fun Camera graph can't, so it stays a Wan start/end-frame clip on its words. Eyes In, Mouth In and Eating Zoom take `dolly_in` in the cloud (their row's hosted field).
- *Correction 2026-10-26 (o/dop):* round 1's wolfer45 Wan 2.2 Bullet Time LoRA (comfyui-oss.json) has no licence on its card ("unspecified"), so the map v2 leaves it out; Bullet Time runs Remade's matrix-shot LoRA (Apache-2.0) instead.

### 7.4 Still prompt-only, and the best route for each group

- **motion · train-own** — Eyes In, Mouth In, Eating Zoom. Wan 'eyes in' (civitai 1877142) forbids selling outputs; Remade Eye-Close-Up is a Wan 2.1 T2V LoRA. Train a Wan 2.2 I2V LoRA on 20-40 own push-in clips (fal-ai/wan-22-trainer/i2v-a14b). Route: `fal-ai/ltx-2.3-22b/image-to-video/lora`.
- **motion · train-own** — Timelapse, Timelapse Human, Timelapse Landscape, Timelapse Glam, Hyperlapse. The Wan 2.2 Time-lapse LoRA (civitai 1877924) forbids selling outputs. Train from own time-lapse footage.
- **motion · prompt-only** — Fisheye. Remade Tiny-Planet-Fisheye is Wan 2.1 T2V only; on Originals, make the still with the Fish Eye Redmond image LoRA and animate it.
- **motion · prompt-only** — Drone Reveal, Helicopter Shot, Flying. DroneShot and Set Reveal forbid selling outputs; keep prompt-only or train own drone clips.
- **motion · prompt-only** — YoYo Zoom, Through Object In, Through Object Out, Buckle Up, Double Dolly, Whip Pan, Hero Cam, Rap Flex, Low Shutter, General, Impossible Camera, One Take. No good cleared LoRA. Through Object In/Out works better as start + end frame (FLF2V) with an end frame Fuobe generates.
- **motion · motion-library** — Baseball Kick, Basketball Dunks, Boxing, Face Punch, Moonwalk Left, Moonwalk Right, Skate Cruise, Skateboard Glide, Skateboard Ollie, Ski Carving, Ski Powder, Snowboard Carving, Snowboard Powder. Better than LoRAs: drive Wan Animate 2 / SCAIL-2 with a short CC0 or own-shot reference clip per preset (a 'motion library'). Route: `fal-ai/wan/v2.2-14b/animate/move or fal-ai/scail-2 (mode=animation)`.
- **effect · post-grade** — Film Colors, Black Gloss, Candy Pink, Lime Jam, Nostalgic Blue, Soft Palette, Overtime, Crimson Vigil, Bleach Bypass, Bleached Warm, Classic BW, Cold Steel, Hyper Neon, Naturalistic Clean, Sodium Decay. A grade, not a generation: animate with no LoRA, then apply a grade.ts preset or the palette-match video workflow. Route: `none (grade in the browser or oss-palette-video on ComfyUI)`.
- **effect · mixed-media-route** — Acid, Akrill, Broken Mirror, Bubbles, Cannabis, Cold Vision, Comic, Flash Comic, Fragments, Hand Paint, LSD, Lava, Layer Mixed Media, Magazine, Marble, Modern, Multiverse, Noir, Ocean, Origami, Overexposed, Palette, Paper, Particles, Random Glow, Sketch, Toxic, Tracking, Two Color, Ultraviolet, Vintage, Windows. These are Mixed Media looks: run the Mixed Media studio's per-frame Z-Image route with a look LoRA (e.g. Sketch→pencil, Noir→darkroomnoir, Vintage→vhs, Paper/Origami→paperdiorama, Overexposed→sunbleach, Comic→prompt). Route: `per-frame fal-ai/z-image/turbo/controlnet/lora, or fal-ai/wan-22-vace-fun-a14b/depth with a restyled first frame`.
- **effect · prompt-only** — Lens Crack, Head Off, Water Splash, Flood, Sand Storm, Earth Element, Earth Wave, Water Element, Water Bending, Ice Rose, Clone Explosion, Duplicate, Portal, Angel Wings, Glowshift, Invisible, Soul Jump, Luminous Gaze, Objects Around, Shadow Smoke, Turn Into Statue, Melting, Medusa Gorgona, Diamond, Werewolf, Gorilla Transfer, Polygon, Wireframe, Point Cloud, Gas Transformation, Bloom Mouth, Floral Eyes, Garden Bloom, Sakura Petals, Floating Fish, Glowing Fish, Jelly Drift, Black Tears, Tentacles, Spiders from Mouth, Paint Splash, Dirty Lens, Paparazzi, X-Ray, Pixelated Face, Censorship, Glow Trace, Visor X, Push To Glass, Super Fast Run, Starship Troopers, Wonderland, Earth Zoom Out, Tiny Planet. No cleared Wan 2.2 / LTX LoRA found on 2026-10-23. Round-1 Wan 2.1 T2V options: Remade Tsunami (Flood), Tornado (Sand Storm), Tiny-Planet-Fisheye (Tiny Planet). Pixelated Face / Censorship are better as SAM 3.1 mask + mosaic in post.
- **effect · prompt-only** — Aquarium, Attack of Clones, Beach Ride, Boiling Point, Clothes Rain, Color Rain, Cotton Cloud, Dream Date, Drunk Master, Fairies Around, Firework, Giant Grab, Group Photo, Helicopter Escape, Live Concert, Look, Boom!, Mystification, Northern Lights, Oni Mask, Pizza Fall, Pool Jump, Spirit Animal, Tattoo Animation, Train Rush, Turning Monkey. Viral templates; Higgsfield's versions are prompt templates on frontier models. Keep prompt-only; train only the ones that get used.
- **effect · prompt-only** — Ballet, Eating, Fix and Pose, Hair Style, Handheld Run, Happy, Morning Routine, Motor Ride, Outfit Check, Peak Moment, Plate Check, Sand Cut, Selfie, Selfie Outfit, Selfie Posing, Static Posing, Sunglasses, Yacht. UGC moves; handheld ones can take the new 'Shaky, handheld camera' LoRA. Static Posing could use the LTX-2.5 Cinemagraph LoRA (gated, 2026-09-10) once checked.
- **effect · prompt-only** — Studio Slide, Smash and Grab, High Flip, Cutout, Act Natural, World Morphing, Lacewalker, Boarding Pass, Monster Dab, Floating Fall, Architecture Wave, Clones, Infinite Clones, Scrapbook Collage, Stop World, Agamemnon, Fallen Angel, Cyclope, Frozen in Motion, Pigeons, Fairytale Castle, Skatedog, Blue Depth, Moonwalk, Dolphin Ride. Blockbuster templates. Stop World / Frozen in Motion can reuse the bullet-time / matrix-shot LoRAs already mapped; World Morphing can use the LTX-2.3 Transition LoRA.

### 7.5 Hosted path for motions and effects

- Wan 2.2 LoRA presets → `fal-ai/wan/v2.2-a14b/image-to-video/lora`: one `loras` item per file, `transformer` = the file's expert (`high` / `low`; Wan 2.1 LoRAs `both`), `scale` = strength. Mix = both presets' items with their scales (fal sets no maximum).
- Camera presets that LTX covers → `fal-ai/ltx-2.3-22b/image-to-video/lora` with `camera_lora` (dolly_in/out/left/right, jib_up/down, static) and, because `loras` is required, at least one LoRA (the preset's LTX LoRA or a neutral one such as the distill LoRA; **unverified** whether an empty-effect LoRA is needed).
- Focus Change → `lightricks/ltx-2.5/image-to-video/fast` with `camera_motion: focus_shift` (open LTX-2.5 weights, hosted; no LoRAs).
- Replicate fallback: `wan-video/wan-2.2-i2v-fast` with one LoRA per expert (no stacking).

---

## 8. Studios

### genjutsu

**Higgsfield:** Genjutsu: motion transfer, object swap, restyle (higgsfield/genjutsu/*/v1.0; Lite variants); also a paid ComfyUI partner node (a cloud API node). Inputs: prompt, video_url (4-30 s, trimmed at 30 s), image_urls (up to 5), resolution 480p/720p/1080p; restyle adds preset_id. What is underneath (from [`higgsfield-originals-5.md`](higgsfield-originals-5.md) §3.9): **likely** Seedance 2.5 edit / reference mode with Higgsfield prompts (same credit ladder, Ad Multiplier lineage, Seedance's 409,600-pixel floor). Genjutsu Lite is **likely** Wan 3.0 reference-to-video (identical price and billing rule). Neither is open, so the Original below is a substitute, not a copy.

- **motion transfer** — open: Wan Animate 2 14B (Apache-2.0; ComfyUI template video_wan_animate2, Fuobe workflow wan-animate2; distilled 10-step variant for 'Lite')
  - hosted: fal-ai/wan/v2.2-14b/animate/move (Wan 2.2 Animate; video_url + image_url; $0.04/0.06/0.08 per video second at 480/580/720p)
  - hosted: fal-ai/scail-2 (SCAIL-2, MIT; mode=animation, driving_type end_to_end\|pose, subject_type human\|animal; $0.20 per second)
  - hosted: fal-ai/wan-motion (Wan-Animate with pose retargeting; $0.06 per second at 720p)
  - hosted: Replicate wan-video/wan-2.2-animate-animation
  - note: No hosted Wan Animate 2 found; Wan 2.2 Animate and SCAIL-2 are the open hosted equivalents.
- **object swap** — open: SAM 3.1 masks + Wan 2.1 VACE 14B inpaint with the reference image (Fuobe video-swap-wan-vace); people: SCAIL-2 replacement (template video_wan21_scail2_character_replacement) or Wan Animate 2 replace
  - hosted: fal-ai/sam-3-1/video (prompt / points / boxes, $0.01 per 16 frames) → fal-ai/wan-vace-14b with task=inpainting, mask_video_url, ref_image_urls ($0.04-0.08 per second)
  - hosted: people: fal-ai/wan/v2.2-14b/animate/replace or fal-ai/scail-2 mode=replacement
  - hosted: Replicate wan-video/wan-2.2-animate-replace ($0.02/0.05 per second at 480/720)
- **restyle** — open: Fuobe video-restyle-wan22-fun-vace: restyle frame 0 with Qwen-Image-Edit 2511 (+ a style LoRA or a Soul preset LoRA via Z-Image img2img), then Wan 2.2 Fun VACE with depth control and the restyled frame as reference
  - hosted: first frame: fal-ai/qwen-image-edit-2511/lora (or fal-ai/z-image/turbo/image-to-image/lora with the preset LoRA)
  - hosted: then fal-ai/wan-22-vace-fun-a14b/depth with first_frame_url = restyled frame, ref_image_urls, match_input_num_frames, match_input_frames_per_second ($0.05/0.075/0.10 per second)
  - hosted: alternative: fal-ai/ltx-2.3-22b/reference-video-to-video/lora (ic_lora_type union) with a style LoRA
  - note: Genjutsu's restyle looks (preset_id) become Fuobe looks = a Z-Image LoRA + prompt applied to the first frame.
- **Licences:** Wan Animate 2 / Wan VACE / Fun VACE Apache-2.0; SCAIL-2 MIT; SAM 3.1 Meta SAM License (commercial use allowed)

### mixed-media

**Higgsfield:** Mixed Media: 33 per-frame stylisation presets on a source video.

- **Open (ComfyUI):** Fuobe mixed-media-zimage-frames: Z-Image Turbo img2img + Fun Union ControlNet per frame at 4-24 fps (VHS meta-batch), with the look's Z-Image LoRA injected (same LoRA library as Fuobe Soul)
- **Hosted:** per frame: fal-ai/z-image/turbo/controlnet/lora ($0.01 per megapixel; a 5 s clip at 12 fps is 60 frames, about $0.30-0.60 at 0.5-1 MP), then join with fal ffmpeg
- **Hosted:** temporally smoother: restyle frame 0 with fal-ai/z-image/turbo/image-to-image/lora, then fal-ai/wan-22-vace-fun-a14b/depth (the Fun VACE restyle route)
- **Hosted:** or fal-ai/krea-wan-14b/video-to-video (Wan 2.1 based, strength 0-1, $0.025 per output second)
- **Note:** The per-frame route is what Higgsfield's Mixed Media looks like (flicker as a style); Fun VACE is the smooth option.
- **Licences:** Apache-2.0 throughout

### cinema-studio

**Higgsfield:** Cinema Studio 4.0: Director's Panel (genre, era, pacing, light, camera body, lens, aperture, move, palette) over Seedance 2.5 (a ByteDance model, not open); image mode with camera stills and grids.

- **Open (ComfyUI):** Wan 2.2 14B I2V (+ Lightning 4-step) or LTX-2.5 22B (audio + video, up to 4K, gated weights) with the panel compiled into the prompt; camera moves from the Motions map (camera LoRAs, Fun Camera poses); palette lock (oss-palette-video); stills from Fuobe Soul (Z-Image) with camera/lens words; Soul Cinema look for image mode; multi-shot as one clip per shot then join, or the Cinematic Hard Cut / Fast Cutting Wan LoRAs inside one clip
- **Hosted:** fal-ai/ltx-2.3-22b/image-to-video/lora (camera_lora dolly_in/out/left/right, jib_up/down, static + up to N loras, generate_audio, num_frames up to 481; $0.001805 per megapixel of video: 121 frames at 1280x720 is about $0.20)
- **Hosted:** lightricks/ltx-2.5/image-to-video/fast (open weights hosted, no LoRAs; camera_motion incl. focus_shift; 720p-4K; $0.09/s at 720p)
- **Hosted:** fal-ai/wan/v2.2-a14b/image-to-video/lora for camera LoRAs ($0.10/s)
- **Note:** Cinema Studio's 3D scene (Gaussian splat → recomposition) is covered by round-4 cinema-3d work.
- **Licences:** Wan Apache-2.0; LTX-2.x Community (free under US$10M revenue)
- **Fuobe Cinema recipe (added 2026-10-26 for O6; JSON: `studios[cinema-studio].original`).** Fuobe's own choices, unmeasured until the evaluation harness runs the `cinema` suite:
  - Cloud: the plain LTX-2.3 22B endpoints (`fal-ai/ltx-2.3-22b/{text-to-video,image-to-video,extend-video,video-to-video}`, $0.001605 per megapixel of video), moving to their `/lora` variants above ($0.001805) only when a LoRA rides along, with `enable_prompt_expansion: false` (the compiled Director prompt is kept), `generate_audio` from the sound toggle, 24 fps, at most 481 frames (20 s); a longer take adds the rest with one `extend-video` call. A take is priced on its tier and shape's size from the table below times its 24n+1 frames, rounded up to whole megapixels. Sizes are a table in multiples of 32 (as LTX-2 wants; the official templates use 1280×704 at 720p): 480p 864×480, 720p 1280×704, 1080p 1920×1088 at 16:9, and 21:9, 4:3, 1:1, 3:4 and 9:16 in each tier. A prequel is `extend-video` with `extend_direction: backward` (unverified: whether the result also holds the source clip); an extend or a prequel adds at most 20 s per run. An edit is `video-to-video` with the take's own scene and the change in one prompt (the endpoint renders a scene, not an instruction), `video_strength` 0.5 (fal's default of 0.01 all but re-renders the clip; Fuobe's guess between build plan O13's low and medium change), `audio_strength` 1 (the take's sound stays), and the first 481 frames of a longer take (`match_video_length: false`); a take made on Seedance 2.5, Kling 3.0 or Veo 3.1 is edited with Kling O3.
  - Camera moves → `camera_lora` where one of its seven moves fits: Dolly In and Slow Zoom In → `dolly_in`; Dolly Out, Slow Zoom Out and Aerial Pullback → `dolly_out`; Truck and Slider Left / Right → `dolly_left` / `dolly_right`; Crane and Pedestal Up / Down → `jib_up` / `jib_down`; Static → `static`. Pans, tilts and the rest have no fit: with a start frame, a move with a Wan 2.2 LoRA (§7) runs it on `fal-ai/wan/v2.2-a14b/image-to-video/lora` (Fuobe DoP; a LoRA that downloads from civitai only with the user's civitai key), Rack Focus runs LTX-2.5's `focus_shift`, and anything else runs on its words.
  - Open: Wan 2.2 14B Lightning with the move's Wan LoRA or a Fun Camera pose (both need a start frame), LTX-2.5 22B as the choice with sound, Wan 2.2 Fun VACE for extend and edit, the palette lock after the clip.
  - Stills on Fuobe Soul Cinema (its 21:9 crop and grade, like Soul Location's Movie grade, applied in the browser by Cinema's feed and builders); Soul Cast with the Realistic look and the 17-field compiler, on Fuobe Soul in the cloud and on the GPU through the Soul Cast sheet graph (`soul-cast-sheet-zimage`, the same Z-Image Turbo with the look's LoRAs and words), which also cuts the sheet's four views; Soul Location on Fuobe Soul with the Movie look, other views by the Multiple-Angles LoRA on both engines. Seedance 2.5, Kling 3.0 and Veo 3.1 stay pickable with the Director in the prompt.
  - Reference clips: none yet. `fal-ai/ltx-2.3-22b/reference-video-to-video/lora` takes one clip, but its inputs haven't been read and it is an IC-LoRA control (depth, pose or canny from the clip) rather than a reference, so a take with reference clips runs on Seedance 2.5 unless Fuobe Cinema is picked from the menu (then the clips are left out, with a note).

### upscale

**Higgsfield:** Upscale image/video (4 models), SDR to HDR, FPS Boost.

- **Open (ComfyUI):** SeedVR2 3B/7B (Apache-2.0; Fuobe upscale-image-seedvr2, upscale-video-seedvr2; ESRGAN fallback); RIFE/FILM for FPS boost; LTX-2.5 IC-LoRA Refine-Details / Pixel-Spatial-Upscaler and SDR-To-HDR (LTX-2.x Community, gated) as newer options
- **Hosted:** fal-ai/seedvr/upscale/image ($0.001 per megapixel)
- **Hosted:** fal-ai/seedvr/upscale/video ($0.001 per megapixel of video: 1920x1080x121 frames is about $0.25; upscale_mode factor\|target, target 720p-2160p, output X264/VP9/ProRes 4444/GIF)
- **Hosted:** fal-ai/ltx-2.3-quality/hdr/lora (SDR→HDR, $0.0027075 per megapixel)
- **Hosted:** fal-ai/rife/video, fal-ai/film/video (FPS boost)
- **Hosted:** Replicate zsxkib/seedvr2 (about $0.061 per run)
- **Licences:** SeedVR2 Apache-2.0; RIFE MIT; LTX-2.x Community

### speak

**Higgsfield:** Speak 2.0 / Lipsync Studio (job types in the bundle include infinite_talk and wan2_5_speak).

- **Open (ComfyUI):** InfiniteTalk (Apache-2.0; Fuobe infinitetalk-native / -wanwrapper, lipsync-v2v-infinitetalk) with Chatterbox / IndexTTS-2 voices; Wan 2.2 S2V (wan22-s2v-14b) as the second option
- **Hosted:** fal-ai/infinitalk (required image_url + audio_url + prompt; num_frames 41–721, default 145; resolution 480p (default) or 720p; acceleration none/regular/high; $0.20 per second; fields re-read from fal's OpenAPI on 2026-10-23). It exposes none of Higgsfield's InfiniteTalk knobs (motion_frame, shift, guidance, LoRA), so the like-for-like copy of Higgsfield's engine (FusioniX LoRA, motion_frame 15, 25 steps, shift 10, guidance 5/5) runs only on the open engine.
- **Hosted:** fal-ai/infinitalk/single-text (text + voice, $0.20 per second)
- **Hosted:** fal-ai/infinitalk/video-to-video (re-sync a video, $0.30 per second)
- **Hosted:** fal-ai/wan/v2.2-14b/speech-to-video ($0.10/0.15/0.20 per second at 480/580/720p)
- **Hosted:** fal-ai/ltx-2.3-22b/audio-to-video/lora (audio-driven LTX with LoRAs)
- **Licences:** InfiniteTalk Apache-2.0; Wan Apache-2.0

### soul-id

**Higgsfield:** Soul ID character training.

- **Open (ComfyUI):** AI-Toolkit job (existing aiToolkitJob in src/lib/catalog/training.ts) on Z-Image Turbo with ostris/zimage_turbo_training_adapter v2 (Apache-2.0), 10-30 photos, captions with a unique trigger, rank 16-32, 1,500-2,500 steps; output copied into ComfyUI/models/loras.
- **Hosted:** fal-ai/z-image-turbo-trainer-v2: image_data_url (zip of 001.jpg + 001.txt pairs), steps (default 2,000), default_caption, learning_rate 5e-4; $0.85 per 1,000 steps (500-step billing floor), so a default run is $1.70. Output diffusers_lora_file is passed as a loras[] path to fal-ai/z-image/turbo/lora.
- **Licences:** Apache-2.0 (Z-Image, AI-Toolkit MIT)

### dop-motions

**Higgsfield:** DoP (dop-lite / dop-turbo / dop-standard) with motions [{id, strength}] stacking.

- **Open (ComfyUI):** Wan 2.2 14B I2V with the preset → LoRA map (src/lib/catalog/oss-loras.generated.ts + this file's motionsEffects); Mix = two LoRAs stacked by strength (already built)
- **Hosted:** fal-ai/wan/v2.2-a14b/image-to-video/lora (loras with transformer high\|low\|both)
- **Hosted:** fal-ai/ltx-2.3-22b/image-to-video/lora (camera_lora + loras)
- **Hosted:** Replicate wan-video/wan-2.2-i2v-fast (one LoRA per expert)
- **Licences:** Apache-2.0 base; per-LoRA licences in motionsEffects

### popcorn

**Higgsfield:** Popcorn storyboards (consistent frames).

- **Open (ComfyUI):** Qwen-Image-Edit 2509 + next-scene LoRA (Fuobe storyboard-qwen-edit-2509-next-scene); stills from Fuobe Soul
- **Hosted:** fal-ai/qwen-image-edit-plus-lora-gallery/next-scene ($0.035/MP)
- **Hosted:** fal-ai/qwen-image-edit-2511/lora with a next-scene LoRA
- **Licences:** Apache-2.0
- **Fuobe Popcorn looks (added 2026-10-29 for O13; JSON: `studios[popcorn].original`).** A board can take one of Fuobe Soul's 139 looks: frame 1 is made on Fuobe Soul with the look (its LoRAs, words and grade) on either engine; the next frames continue from the frame before with the look's words; every frame gets the look's grade and overlay after it is made (the browser's Soul finish), and each next frame is made from the previous frame as it came out, before its finish, so the grade is applied once. With references, frame 1 stays on the reference model (Qwen-Image-Edit 2511 on either engine) with the look's words. Fuobe Soul has no 21:9: a 21:9 board in a look is made at 16:9 and cropped, and its film is 21:9 too, made once the browser has finished the frames. *Corrected 2026-10-29:* the board is open weights on both engines. The next frames are Qwen-Image-Edit 2509 + the next-scene LoRA (`adapterLoras` `next-scene-qwen-edit-2509`, MIT, at 0.75): the GPU graph loads it, and in the cloud it rides along as a URL on `fal-ai/qwen-image-edit-plus-lora` (schema read; $0.035 per megapixel). Frame 1 is Z-Image Turbo without references (hosted `fal-ai/z-image/turbo` in the cloud). The gallery route (`fal-ai/qwen-image-edit-plus-lora-gallery/next-scene`) isn't needed. Nano Banana Pro stays a separate partner choice in the cloud for the whole board (API `partner: "nano-banana-pro"`).

### evolution

**Higgsfield:** Evolution (`hf_evolution`, a gated test model): one video plus up to 40 references, `change_intensity` low / medium / high, an optional creative direction of up to 10,000 characters, 480p / 720p / 1080p ([`higgsfield-originals-5.md`](higgsfield-originals-5.md) §3.20; the engine underneath is speculative).

*Added 2026-10-29 for O13 (JSON: `studios[evolution]`). Fuobe's own recipe, unmeasured until the evaluation harness runs the `evolution` suite.*

- **Change intensity:** denoise 0.45 / 0.65 / 0.85 (build plan O13), and on both engines the direction frame's instruction (refine gently / change / reimagine boldly). fal's hosted Wan 2.2 Fun VACE has no strength field (its 31 inputs, read 2026-11-01), so in the cloud the instruction is all of it.
- **Open (ComfyUI):** Fuobe `video-evolution-wan22-fun-vace`: per ≤81-frame segment at 16 fps (video-segment-resample), Qwen-Image 2.1 Turbo takes the segment's first frame toward the direction (images 2–4 = the first three references; *corrected 2026-11-01: Qwen-Image-Edit 2511 with two references until the image tools moved to Qwen-Image 2.1*), then Wan 2.2 Fun VACE re-renders the segment from the segment itself: reference latent + VAE-encoded frames, noised to denoise = the noise level it starts from ((1 − denoise) × clip + denoise × noise). The simple scheduler with shift 5 reaches that level N − 4 steps into a schedule of N = round(4 × (5 − 4 × denoise) / denoise) steps and the last 4 run (Lightx2v 4-step): low starts at σ 0.455, medium 0.645, high 0.833. Wan 2.2's high-noise expert takes only steps at or above its switch point (σ 0.875), so the three intensities run on the low-noise expert; full denoise is the restyle graph's 2 + 2. Depth Anything 3 depth on every frame, the direction frame as the VACE reference. The graph loads any clip at 16 fps (VHS_LoadVideo, at most `frames` frames, 4n+1) and runs as many frames as it loaded, so a whole clip from Edit video is neither slow motion nor a shape error. Then video-concat-N and the clip's own sound. Same weights as the restyle graph (24 GB). *(Corrected 2026-10-29: the first version noised the way KSampler does, floor(4 / denoise) steps, which with 4 steps and shift 5 started every intensity at σ 0.83–1 and made high the same as full noise.)*
- **Hosted (since 2026-11-01, decided 2026-10-30):** the GPU's own model, `fal-ai/wan-22-vace-fun-a14b/depth`, the way Fuobe Shorts runs it: per piece of up to 10 s and 241 frames as fal works them, fal's trim and extract-frame, hosted `fal-ai/qwen-image-edit-2511` takes the piece's first frame toward the direction with the GPU's frame instruction and the first three references, then VACE gets the piece as `video_url` (`preprocess` on: fal derives the depth) and the direction frame as its reference, `ref_image_urls`, as the GPU graph uses it (WanVaceToVideo's `reference_image`; no `first_frame_url`, which would pin frame 0 where the GPU doesn't: *the first build of 2026-11-01 sent it as `first_frame_url`, the way Shorts does*), frames and rate matched; the clip's own sound goes back on the joined result. $0.10 per video second at 720p ($0.075 at 580p, $0.05 at 480p), frames ÷ 16, plus each direction frame's edit. *(Until 2026-11-01 the cloud ran `fal-ai/ltx-2.3-22b/video-to-video` at `video_strength` 1 − denoise: a different model, and it took no images.)*
- **Direction:** an LLM writes it from the references and the user's few words (Claude in the cloud, Ollama with a vision model on the GPU; up to 8 / 4 references and a frame of the clip are sent), as a description of the finished video; without one (no key, Ollama not running, demo mode, the text model switched off) Fuobe's offline writer builds it from the intensity, the words and the number of references.
- **Unverified:** nothing rendered; the denoise values on the GPU, and in the cloud how far the direction frame plus depth carries each change level; fal's `preprocess` on an RGB clip; Lightx2v's 4-step LoRA at these start levels (it was distilled on the full-noise schedule, σ 1 → 0.94 → 0.83 → 0.63), and whether low (σ 0.45) changes enough to be seen.
- **Licences:** Wan 2.2 Fun VACE, lightx2v, Qwen-Image-Edit 2511 Apache-2.0; Qwen-Image 2.1 (the GPU's direction frame) non-commercial

---

## 9. What Fuobe has to build

*This list is the researcher's summary. The [Build plan](#build-plan) below turns it into ordered packages (O0–O13), with files, workflows, tests and the replacement for each Higgsfield model.*

1. **A preset generator for Soul.** Read `presets[]` (template, triggers, loras, grade, base) into the preset catalog; route open runs to `z-image-turbo-t2i` (+ `injectLoras`) and cloud runs to `fal-ai/z-image/turbo/lora` (`loras[{path: url, scale: strength}]`, `num_inference_steps: 8`). Replace the Higgsfield `style_id` path.
2. **LoRA fetching.** Download HF files directly; for civitai, ask for a civitai key in Settings (or mirror allowed files to Fuobe storage once). Store them under the `file` names given here.
3. **Post steps for Soul:** server-side grade presets (port `src/lib/grade.ts`), new `invert` and `solarize` presets, text overlays (date stamp, CCTV), the photo-booth strip compositor, SAM 3.1 face mosaic, SeedVR2 for the 1080p tier.
4. **Soul ID on Z-Image:** `fal-ai/z-image-turbo-trainer-v2` in the cloud, AI-Toolkit with the ostris turbo adapter on the GPU; the trained LoRA takes one of the three slots.
5. **Motions map v2:** extend `scripts/gen-oss-loras.py` to read `motionsEffects` (Wan 2.2 high/low pairs, Wan 2.1 `both`, LTX LoRAs for an LTX open route), add the Fun Camera poses and aliases from §7.3, and send Wan LoRAs to fal with `transformer` set per file.
6. **An LTX-2.3 open route** for presets whose best LoRA is LTX (FPV Drone, Wind to Face, transitions, Exploded View on LTX-2.5) and for hosted camera moves via `camera_lora`.
7. **Train the §6 LoRAs** from licensed data, starting with `fuobe-soul-core`, `fuobe-cctv` and `fuobe-ultrawide-05`.
8. **A GPU evaluation pass** (task 65's harness): render every preset with and without its LoRAs, check stacking at the listed strengths, and lower strengths that over-cook.

---

## 10. Risks and unverified points

- **No output was rendered.** Strengths without an author recommendation (AWPortrait-Z, Lenovo, GrainScape, most civitai LoRAs) are starting points. Three-LoRA stacks on a distilled 8-step model can over-saturate or lose likeness; check on a GPU.
- **Licences can change.** civitai permissions were read from the API on 2026-10-23; authors can change them. Store the permission snapshot with each mirrored file.
- **Mirrors.** `neph1/80s_*` are the author's own mirrors of civitai models (same uploader name); their HF repos carry no licence field, so Fuobe relies on the civitai permissions.
- **Gated Lightricks LoRAs** (LTX-2.5 Slow-Motion-Control and Cinemagraph, LTX-2.3 IC-LoRA Relight) answer 401 without an HF token and their cards could not be read; usage settings are unverified. The other 40 direct Hugging Face LoRA URLs in this file answered with a download redirect (HEAD check, 2026-10-23).
- **fal behaviour not confirmed:** whether `path` accepts a tokenised civitai URL; whether the Wan 2.2 trainer's single `lora_file` should be applied to both experts; whether LTX-2.3 LoRA endpoints load LTX-2 19B LoRAs (EarthZoomOut).
- **Higgsfield Terms** on training were read on the primary page (https://higgsfield.ai/terms-of-use-agreement, last updated 2026-10-23); see §2. Terms change: re-read them before any training run that touches look references.
- **The Soul look itself** is a target judged by eye. Without Higgsfield's API Fuobe cannot A/B against Soul outputs it did not pay for; compare against public Soul examples by eye only, and do not train on them.

## Sources

- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id> — input schemas of all fal endpoints listed (fetched 2026-10-23)
- https://fal.ai/models/<id>/llms.txt — fal prices (## Pricing), 2026-10-23
- https://api.fal.ai/v1/models — fal catalog: status and license_type for 1,523 endpoints, 2026-10-23
- https://fal.ai/models/fal-ai/flux-lora — 'Commercial use' badge and 'All generated images are cleared for commercial use', 2026-10-23
- https://replicate.com/<owner>/<name> — Replicate input schemas (dereferenced_openapi_schema) and billingConfig, 2026-10-23
- https://huggingface.co/api/models?filter=base_model:adapter:<base> — LoRA lists per base (Z-Image Turbo 500+, Z-Image 152, Qwen-Image-2512 198, FLUX.2 klein 4B 82 + base 110, FLUX.2 dev 80, Krea dev 28, Wan 2.2 I2V 334, LTX-2.3 119, LTX-2.5 37), 2026-10-23
- https://huggingface.co/api/models/<id> and /raw/main/README.md — licence, base, files and triggers of every HF LoRA in loraLibrary, 2026-10-23
- https://civitai.com/api/v1/models?types=LORA&baseModels=ZImageTurbo|Wan Video 2.2 I2V-A14B|LTXV 2.3|LTXV 2.5|LTXV2 — civitai LoRA lists (3,979 Z-Image Turbo, sorted by downloads), 2026-10-23
- https://civitai.com/api/v1/models/<id> — allowCommercialUse / allowNoCredit / versions / files of every civitai LoRA used, 2026-10-23
- https://raw.githubusercontent.com/Lightricks/LTX-2/main/LICENSE-2_x — LTX-2.x Community License: US$10M revenue threshold, 2026-10-23
- https://higgsfield.ai/creator-hub/help-center/ai-models/which-ai-model-should-i-use — Higgsfield calls Soul, Popcorn, DOP 'native', 2026-10-23
- https://higgsfield.ai/terms-of-use-agreement — Higgsfield Terms of Use, last updated 2026-10-23: sections 5.1(iii), 5.2(iv), 5.2(v), read 2026-10-23 (replaces the secondary licenseorg.com summary used before the critic pass)
- https://mindstudio.ai/blog/higgsfield-terms-of-service-backlash — secondary: Higgsfield Terms revision
- https://docs.comfy.org/tutorials/partner-nodes/higgsfield/genjutsu-motion-transfer — the Genjutsu partner node is a cloud API node that downloads no model, 2026-10-23
- docs/research/higgsfield-api.json, higgsfield-inventory.md, higgsfield-image-studios.json, comfyui-oss*.json — Fuobe's earlier rounds (2026-10-16 … 10-22)
- Every LoRA page and file URL is in §5.2 and §7.2 and in the JSON (`loraLibrary`, `motionsEffects[].loras`), each with `checked: 2026-10-23`.

---

## Build plan

_Critic and planner pass, 2026-10-23. It reads this file and [`higgsfield-originals-5.md`](higgsfield-originals-5.md), re-checks their key facts, closes the coverage gaps and orders the work. JSON twin: `buildPlan` and `criticSpotChecks` in [`fuobe-originals-recipes-5.json`](fuobe-originals-recipes-5.json). No code, model or paid call was run; nothing in `src/` was changed._

The end state is no Higgsfield provider, key or preset id in Fuobe. Every product Higgsfield sells as its own becomes a **Fuobe Original** that runs (1) on the user's GPU through ComfyUI and (2) in the cloud on open weights hosted by fal (Replicate where it fits). Partner models (Seedance, Kling, Veo, Nano Banana, GPT Image…) stay as separate choices on fal and Replicate. The order is plumbing first (LoRAs on both engines), then the products Fuobe calls Higgsfield for today (Soul, Soul ID, DoP, Genjutsu, Cinema Studio), then the switch-off, then the rest.

### Critic's spot-checks

All read on 2026-10-23. Wrong or loose facts were fixed in place in both research files (md and JSON); the fixes are marked in the text.

| # | fact | source | result |
|---|---|---|---|
| 1 | `fal-ai/z-image/turbo/lora`: `loras` max 3, items `{path, scale 0–4}`, steps 1–8, $0.0085/MP | fal OpenAPI + llms.txt | holds. Fixed: `acceleration` also takes `high` |
| 2 | `fal-ai/wan/v2.2-a14b/image-to-video/lora`: items `{path, scale 0–4, transformer high\|low\|both (default high), weight_name}`, 17–161 frames, $0.10/s | fal OpenAPI + llms.txt | holds. **Fixed:** "16 fps default" was misleading. Default `interpolator_model: film` returns 32 fps; send `none` for 16 fps (§3.1) |
| 3 | `fal-ai/ltx-2.3-22b/image-to-video/lora`: `loras` required, `camera_lora` enum of 8, 9–481 frames, $0.001805/MP | fal OpenAPI + llms.txt | holds. Added: `fps` 24, `enable_prompt_expansion` and `generate_audio` both default to true |
| 4 | `fal-ai/qwen-image-2512/lora` up to 3 LoRAs; `fal-ai/z-image-turbo-trainer-v2` `image_data_url`, 2,000 steps, lr 5e-4, $0.85 per 1,000 steps, 500-step floor | fal OpenAPI + llms.txt | holds |
| 5 | `fal-ai/infinitalk` $0.20/s; `fal-ai/wan/v2.2-14b/animate/move` $0.04 / 0.06 / 0.08 per s; `fal-ai/scail-2` $0.20/s | fal OpenAPI + llms.txt | holds. Added InfiniteTalk's fields (the provenance file had only checked that it exists) |
| 6 | 52 fal endpoint ids named in this plan exist | https://api.fal.ai/v1/models (1,523 endpoints) | all active. Stable Audio 3 Small is at `fal-ai/stable-audio-3/small/sfx/text-to-audio`. `bytedance/seedance-2.5/*` (non-US) is not in the catalog but its OpenAPI and llms.txt still answer 200. `bytedance/seedance-2.5/video-edit` answers 404 |
| 7 | Hugging Face licences: AWPortrait-Z, Lenovo UltraReal, chsengni LTX-2.3 FPV, joyfox LTX-2.3 Transition (Apache-2.0); Digicam (BigScience OpenRAIL-M) | https://huggingface.co/api/models/<repo> | holds |
| 8 | civitai permissions and pinned version ids: V67 Y2K 3422541, Shaky handheld 2912574, Hard Flash, AfterDark 2470291, Headbob 3203908, EXPLOSION Redmond, Tilt-up Overhead (Image + Rent); FrutigerAero (RentCivit + Rent only, so outputs may not be sold) | https://civitai.com/api/v1/models/<id> | holds. New risk: the *newest* version of Y2K, AfterDark, Shaky handheld and Headbob is for another base (Krea 2, MiniMax H3), so the downloader must pin version ids, never "latest" |
| 9 | Base licences: Z-Image Turbo, FLUX.2 klein 4B, InfiniteTalk, Wan 2.2 Animate, SeedVR2 3B/7B, ThinkSound Apache-2.0; klein 9B FLUX Non-Commercial; LTX-2.x free under US$10M revenue (LICENSE-2_x §2.1); SAM License royalty-free and commercial use allowed | Hugging Face API; github.com/Lightricks/LTX-2 LICENSE-2_x; github.com/facebookresearch/sam3 LICENSE | holds. **New flags:** Video-Depth-Anything-Large, DA3 Large/Giant and MMAudio are CC-BY-NC-4.0; HunyuanVideo 1.5 is Tencent Hunyuan Community (territory-restricted) |
| 10 | Higgsfield client facts marked confirmed (Soul `lora`/`lora_2`, InfiniteTalk + fusex, Angles LoRAs, `.safetensors` motions, Popcorn checkpoints, product labels) | 8 bundle chunks of build 1a2c0e3d | holds, with two corrections in `higgsfield-originals-5`. `WAN2_2_ANIMATE` is "Wan 2.2 Animate" in the main label map. InfiniteTalk's TeaCache and APG are off by default |
| 11 | "Cinema Studio 4.0 runs on Seedance 2.5" | Higgsfield help center | holds, verbatim |
| 12 | Higgsfield Terms forbid training on outputs | https://higgsfield.ai/terms-of-use-agreement (last updated 2026-10-23) | holds. **Fixed:** both files quoted secondary or paraphrased text. The exact 5.1(iii) / 5.2(iv) wording is now in, plus 5.2(v) (no reverse engineering) |
| 13 | "Higgsfield ships Genjutsu as a ComfyUI partner node" counted as evidence for the hypothesis | https://docs.comfy.org/tutorials/partner-nodes/higgsfield/genjutsu-motion-transfer | **reclassified as neutral.** It is a cloud API node that downloads no model |

### Licence rules for Originals

- **Default = commercial-safe on both engines.** An Original's default base and default LoRAs must allow selling outputs *and* running the weights on the user's GPU *and* on fal/Replicate: Apache-2.0, MIT, OpenRAIL-M, the SAM License, or civitai permissions that include `Image` and `Rent`. LTX-2.x is allowed by default, but About & licences shows its US$10M-revenue condition.
- **Flag, never default:** FLUX.1 / FLUX.2 [dev], FLUX.1 Krea [dev], FLUX.2 [klein] 9B, Video-Depth-Anything Base/Large, DA3 Large/Giant/Nested, MMAudio, inswapper (ReActor): non-commercial weights. HunyuanVideo 1.5, HunyuanVideo-Foley, Hunyuan3D 2.1, MiniMax H3: territory-restricted. Krea 2, Stable Audio 3: revenue-tier community licences. A flagged model may be offered as a labelled alternative. A non-commercial model that fal hosts under its own output licence (e.g. `fal-ai/depth-anything-video`, `fal-ai/mmaudio-v2`) is "hosted only, fal's output terms", never an Original.
- **civitai `RentCivit`-only LoRAs** (Wiggle, RackFocus, Medieval-CE…) are `local-only`: they run on the user's GPU and are never sent to fal or Replicate. LoRAs without `Image` (FrutigerAero, Mobile Cell Phone, Japan 1980s, Time-lapse, Eyes In, DroneShot) are not used at all.
- **No Higgsfield data.** Per Terms §5.1(iii) / §5.2(iv) / §5.2(v): no training, captions, prompts, covers or tests built from Higgsfield outputs, preview media or client code. Preset *names* that are generic words stay; Higgsfield preset UUIDs survive only in a one-way migration map for old saved settings.
- **Enforced by tests:** the generators fail when an Original's default LoRA has `commercial: false`, when a cloud payload carries a LoRA with `hostedOk: false`, or when a civitai entry has no pinned version id or permission snapshot.

### Coverage: every Higgsfield in-house product

Every product from [`higgsfield-originals-5.md`](higgsfield-originals-5.md), with the five rebranded open tools listed one by one. *Underneath*: A = closed partner model + Higgsfield prompts and UI, B = open model + public LoRAs under a Higgsfield name, C = self-hosted model with LoRA presets (base not public). Each row has an open recipe and a hosted-open recipe; no row needs a proprietary API.

| # | Higgsfield product | underneath | Fuobe Original | open (ComfyUI) | hosted open (fal / Replicate) | licence | package |
|---|---|---|---|---|---|---|---|
| 1 | Soul v1 (106 presets) | C · self-hosted base + LoRA-like presets; base unknown (likely shares Higgsfield's Wan 2.2 image pipeline) | `fuobe-soul` (v1 looks) | `z-image-turbo-t2i` + `injectLoras` (≤3 LoRAs, 8 steps, cfg 1, shift 3) | `fal-ai/z-image/turbo/lora`; Replicate `prunaai/z-image-turbo-lora` | all 106 commercial + hostable; 87 presets need a civitai key or a mirror | O2 |
| 2 | Soul 2.0 (33 presets / curated moodboards) | C · `lora` + `lora_2` per style confirmed in client | `fuobe-soul` (v2 looks) | same + new `z-image-turbo-i2i` for edit / refiner | `fal-ai/z-image/turbo/lora`; edit `fal-ai/z-image/turbo/image-to-image/lora` | as above | O2 |
| 3 | Soul Cinema | C · fixed style slot on the Soul 2.0 pipeline (likely) | `fuobe-soul-cinema` | Fuobe Soul + filmstill 0.7 + moviewide 0.5, `cine` tail, teal-orange grade, camera / lens words | `fal-ai/z-image/turbo/lora` with the same LoRAs | moviewide is civitai (Image, Rent, Sell; token) | O2 |
| 4 | Soul ID | C · per-person training run (`training_args`) | Fuobe Soul ID (character LoRA) | AI-Toolkit job, Z-Image Turbo + ostris adapter v2 (`aiToolkitJob` exists) | `fal-ai/z-image-turbo-trainer-v2` → LoRA URL in `loras[]` | Apache / MIT; consent checkbox; user's own photos | O3 |
| 5 | Moodboards (personal) | C · style training (`/custom-references/soul-v2-preset`), likely a LoRA | style LoRA as a Fuobe look | AI-Toolkit style preset (exists) | `fal-ai/z-image-trainer` (`training_type: style`, $2.26 per 1,000 steps) | user's own images only | O3 |
| 6 | Soul HEX / Color Transfer | unknown mechanism | palette on any Original | hex in prompt + `palette-transfer-image` / `palette-zimage-hex` (exist) | hex in prompt on fal Z-Image LoRA (fal has no colour-match tool, so the palette-lock pass is open-engine only) | none | O2 |
| 7 | Soul Cast | likely Soul 2.0 + casting-prompt compiler | `fuobe-soul` + the 17-field compiler in `cinema.ts` | `soul-cast-sheet-zimage` (exists) | `fal-ai/z-image/turbo/lora` | none | O6 |
| 8 | Soul Location | confirmed Soul 2.0 job | `fuobe-soul` + another-view edit | `z-image-turbo-t2i`; views: `qwen-image-edit-2511` + Multiple-Angles LoRA | `fal-ai/z-image/turbo/lora`; `fal-ai/qwen-image-edit-2509-lora-gallery/multiple-angles` | Apache-2.0 | O6 |
| 9 | DoP camera motions (113) + Mix | C · motions are LoRA files in client; base likely Wan-14B lineage (16 fps, 49/81 frames) | `fuobe-dop` | `wan22-i2v-14b-lora` + motion map, `wan22-fun-camera-14b`; new `ltx23-i2v-lora` for LTX LoRAs | `fal-ai/wan/v2.2-a14b/image-to-video/lora` (`transformer` per file, `interpolator_model: none`); `fal-ai/ltx-2.3-22b/image-to-video/lora` (`camera_lora`); Replicate `wan-video/wan-2.2-i2v-fast` | per LoRA; `local-only` LoRAs never hosted | O4 |
| 10 | Speak v1 (DoP + audio) | C · DoP-family job `image2video_extend` | `fuobe-speak` | `wan22-s2v-14b` or `infinitetalk-*` | `fal-ai/wan/v2.2-14b/speech-to-video`, `fal-ai/infinitalk` | Apache-2.0 | O11 |
| 11 | Speak v2 | unknown engine | `fuobe-speak` | InfiniteTalk (Higgsfield defaults preset) | `fal-ai/infinitalk` (+ `/single-text`) | Apache-2.0 | O11 |
| 12 | Visual Effects (274) / Effects 2.0 chains | older: presets per model family; 2.0: node chains, 38 of 50 'Prompt based'; engine speculative | `fuobe-dop` effects + chain presets | `wan22-i2v-14b-lora` + effect LoRA (35 today + §7.2); post-grade group → grade step; Mixed Media group → O9 | `fal-ai/wan/v2.2-a14b/image-to-video/lora`; transitions `fal-ai/ltx-2.3-22b/image-to-video/lora` with `end_image_url`; chain step 1 `fal-ai/qwen-image-edit-2511/lora` | Wan 2.1 LoRAs unproven on 2.2; ~130 effects stay prompt-only | O4 |
| 13 | Genjutsu · motion transfer | A · likely Seedance 2.5 edit with Higgsfield prompts | `fuobe-genjutsu-move` | `wan-animate2` (Wan Animate 2) | `fal-ai/wan/v2.2-14b/animate/move`; animals / groups `fal-ai/scail-2` | Apache-2.0 / MIT | O5 |
| 14 | Genjutsu · object swap | A · likely Seedance 2.5 edit | `fuobe-genjutsu-swap` | SAM 3.1 + `video-swap-wan-vace` / `video-insert-wan-vace` | `fal-ai/sam-3-1/video` → `fal-ai/wan-vace-14b/inpainting`; people `fal-ai/wan/v2.2-14b/animate/replace` or `fal-ai/scail-2` (`mode: replacement`) | SAM License (commercial OK) | O5 |
| 15 | Genjutsu · restyle | A · likely Seedance 2.5 edit; looks are `preset_id`s | `fuobe-genjutsu-restyle` | `video-restyle-wan22-fun-vace` (frame 0 by Qwen edit or a Soul look) | frame 0 `fal-ai/qwen-image-edit-2511/lora` or `fal-ai/z-image/turbo/image-to-image/lora` → `fal-ai/wan-22-vace-fun-a14b/depth` | Apache-2.0 | O5 |
| 16 | Genjutsu Lite | A · likely Wan 3.0 reference-to-video (same price and billing rule) | Lite variants of the three | Wan Animate 2 with the lightx2v distill LoRA, 480p | same endpoints at 480p (`use_turbo` on animate) | Apache-2.0 | O5 |
| 17 | Cinema Studio 4.0 (3.x) | A · confirmed Seedance 2.5 (3.x likely Seedance 2.0) | `fuobe-cinema` | Wan 2.2 14B Lightning + camera LoRA / Fun Camera; LTX-2.5 22B (`ltx25-i2v/t2v`) for audio; palette lock | `fal-ai/ltx-2.3-22b/{image,text}-to-video/lora` (`camera_lora`, `generate_audio`); `fal-ai/wan/v2.2-a14b/image-to-video/lora` | LTX-2.x < US$10M; HunyuanVideo 1.5 territory-restricted, not default | O6 |
| 18 | Mixed Media | per-frame chain confirmed; engine speculative (Nano Banana Pro by price) | `fuobe-mixed-media` | `mixed-media-zimage-frames` + look LoRA (exists) | `fal-ai/ffmpeg-api/extract-frame` → `fal-ai/z-image/turbo/controlnet/lora` per frame → `fal-ai/ffmpeg-api/images-to-video` → mux | Apache-2.0 | O9 |
| 19 | Shorts Studio restyle | A · confirmed Gemini Omni Flash | `fuobe-shorts` | segment → Qwen edit frame 0 → `video-restyle-wan22-fun-vace` → join → mux (exists) | `fal-ai/qwen-image-edit-2511/lora` → `fal-ai/wan-22-vace-fun-a14b/depth` per segment → `fal-ai/ffmpeg-api/merge-videos` | Apache-2.0 | O9 |
| 20 | Lipsync Studio 'Infinite Talk' | B · confirmed InfiniteTalk + FusioniX | `oss-infinitetalk` with a 'Higgsfield defaults' preset | `infinitetalk-wanwrapper` + FusioniX LoRA, motion_frame 15, 25 steps, shift 10, guidance 5/5 | `fal-ai/infinitalk` (no tuning fields), `/video-to-video` | Apache-2.0 (FusioniX merges other LoRAs; their licences unchecked) | O11 |
| 21 | Upscale (legacy 'Higgsfield Upscale') | unknown; today's engines are named partners | `fuobe-upscale` | `upscale-video-seedvr2`, `upscale-image-seedvr2`, ESRGAN, `interpolate-rife`; SDR→HDR and FPS from r4/video-finish | `fal-ai/seedvr/upscale/video` / `/image`, `fal-ai/rife/video`, `fal-ai/ltx-2.3-quality/hdr/lora` | SeedVR2 Apache-2.0, RIFE MIT | O11 |
| 22 | Marketing Studio Image | A · confirmed GPT Image 2.5 + prompt templates | `fuobe-marketing-image` | `qwen-image-edit-2511(-multi)` + template prompts; `product-shot-qwen-edit-2509` | `fal-ai/qwen-image-edit-2511/lora`, `fal-ai/qwen-image-2512/lora` | Apache-2.0; FLUX.2 [dev] edit = hosted-only alternative | O10 |
| 23 | Ads Studio | A · confirmed LLM concepts + GPT Image 2.5 | Fuobe Ads pipeline | local LLM or offline copy → `qwen-image-2512-t2i` / Qwen edit → browser compositing (exists) | Claude (or none) → `fal-ai/qwen-image-2512/lora` / `fal-ai/qwen-image-edit-2511/lora` | Apache-2.0 | O10 |
| 24 | AI Influencer | speculative (Seedream 5.0 sheet); builder is a prompt compiler | builder → `fuobe-soul` sheet | `soul-cast-sheet-zimage`; 'Add your face' `qwen-image-edit-2511` | `fal-ai/z-image/turbo/lora`; `fal-ai/qwen-image-edit-2511/lora` | Apache-2.0 | O10 |
| 25 | Photodump (Soul 2.0) | C · Soul batch after a pack retrain | `fuobe-soul` + character LoRA + pack prompts | `z-image-turbo-t2i` + character LoRA | `fal-ai/z-image/turbo/lora` batch | Fuobe's own pack prompts | O10 |
| 26 | Instadump | C · Popcorn keyframes (checkpoint 260000); base speculative | multi-reference edit | `qwen-image-edit-2511-multi` | `fal-ai/qwen-image-edit-2511/lora` with several images | Apache-2.0 | O10 |
| 27 | Popcorn storyboards | C · self-trained checkpoints; base speculative (Wan-style flags) | next-scene storyboard | `storyboard-qwen-edit-2509-next-scene` (exists) | `fal-ai/qwen-image-edit-plus-lora-gallery/next-scene` | Apache-2.0 | O13 |
| 28 | Fashion Factory | half Soul v1 (base shots), half Nano Banana (outfit, photoset) | Soul base shots + open try-on | `z-image-turbo-t2i` + character LoRA → `tryon-flux2-klein-4b` → Qwen edit photoset | `fal-ai/z-image/turbo/lora` → `fal-ai/flux-2/klein/4b/edit/lora` (try-on LoRA; hosting right to check) → `fal-ai/qwen-image-edit-2511/lora` | klein **4B** only (9B is non-commercial) | O10 |
| 29 | Evolution (staff test model) | speculative (Seedance 2.5 by price) | `fuobe-evolution` | `video-restyle-wan22-fun-vace` with denoise by intensity 0.45 / 0.65 / 0.85 | `fal-ai/ltx-2.3-22b/video-to-video/lora` or `fal-ai/wan-vace-apps/video-edit` | LTX-2.x < US$10M | O13 |
| 30 | Higgsfield Angles | B · confirmed Qwen-Image-Edit 2509 + Multiple-angles + Lightning | Angles app | existing 2511 route; new `qwen-image-edit-2509-angles` (dx8152 LoRA + Qwen-Image-Lightning) for an exact copy | `fal-ai/qwen-image-edit-2509-lora-gallery/multiple-angles` (rotate −90…90°, vertical −1…1, forward 0–10, `lora_scale` 1.25, 6 steps) | Apache-2.0 | O11 |
| 31 | Higgsfield Animate / Recast | B · confirmed Wan 2.2 Animate | Motion Control / Recast | `wan-animate2` | `fal-ai/wan/v2.2-14b/animate/move`, `/replace` | Apache-2.0 | O5 |
| 32 | Depth Map | B · confirmed Video Depth Anything **Large** | depth tool | `video-depth-vda-small` or `video-depth-da3` (DA3 Mono-Large) | `fal-ai/depth-anything-video` (fal output terms; variant not stated) | **VDA-Large is CC-BY-NC-4.0: do not self-host it** | O11 |
| 33 | Remove Background (video) | B · confirmed SAM 3 | video matte | `video-bg-remove-sam3` (SAM 3.1) | `fal-ai/sam-3-1/video` | SAM License | O11 |
| 34 | Mirelo SFX / Sonilo music | partner vendors, labelled as such | not an Original (stays a partner) | ThinkSound, Stable Audio 3 Small, ACE-Step 1.5 | partner `mirelo-ai/sfx2.0/*`, `sonilo/v1.1/*`; open-hosted `fal-ai/thinksound`, `fal-ai/ace-step` | MMAudio non-commercial: not a default | — |

### What replaces each Higgsfield model when the provider is removed

Fuobe's Higgsfield surface today: 12 models only on Higgsfield (`HIGGSFIELD_MODELS`), extra Higgsfield routes on 24 partner models (`HIGGSFIELD_ROUTES`), two Soul ID training targets, the live preset lists, and a settings key. Checked against `src/lib/catalog/higgsfield-models.generated.ts` and `cloud-models.generated.ts` on this branch.

| Fuobe item today | replaced by | partner alternatives kept / notes | package |
|---|---|---|---|
| `soul-1` (`higgsfield-ai/soul/standard`) | `fuobe-soul` with the Soul v1 looks | Nano Banana Pro, Seedream 5.0 Pro | O2 |
| `soul-2` t2i (`higgsfield-ai/soul/v2/standard`) | `fuobe-soul` with the Soul 2.0 looks | same | O2 |
| `soul-2` edit (`higgsfield-ai/soul/v2/image-to-image`) | `fuobe-soul` edit route (`z-image-turbo-i2i` / `fal-ai/z-image/turbo/image-to-image/lora`) | Nano Banana Pro edit | O2 |
| `soul-cinema` (`higgsfield-ai/soul/cinema`) | `fuobe-soul-cinema` | Nano Banana Pro, Seedream 5.0 Pro camera stills | O2 / O6 |
| `marketing-studio-image` (`marketing-studio/image`) | `fuobe-marketing-image` (Qwen-Image-Edit 2511 + templates) | GPT Image 2.5, Nano Banana Pro via fal | O7 maps, O10 builds |
| `ads-studio` (`higgsfield/ads-studio/v1.0`) | Fuobe Ads pipeline (LLM copy → Qwen visual → browser compositing) | Nano Banana Pro / GPT Image 2.5 visuals | O7 maps, O10 builds |
| `cinema-studio-4` (`higgsfield/cinema-studio/4.0`) | `fuobe-cinema` | Seedance 2.5, Kling 3.0, Veo 3.1 with the panel compiled into the prompt (today's no-key path) | O6 |
| `genjutsu-motion-transfer` | `fuobe-genjutsu-move` | Kling 3.0 Motion Control | O5 |
| `genjutsu-object-swap` | `fuobe-genjutsu-swap` | Kling O3 edit | O5 |
| `genjutsu-restyle` | `fuobe-genjutsu-restyle` | Kling O3 edit, Lucy Edit Pro, LTX 2.3 Reference Restyle | O5 |
| `genjutsu-lite-motion-transfer`, `genjutsu-lite-object-swap` | Lite variants (480p, distilled / turbo) | — | O5 |
| `happy-horse-1-1` (Higgsfield's resale of Alibaba Happy Horse 1.1) | not an Original. Add fal routes `alibaba/happy-horse/v1.1/{text,image,reference}-to-video` (OpenAPI answers 200 on 2026-10-23; schemas still to be researched) or hide the model | — | O7 |
| `HIGGSFIELD_ROUTES` on 24 partner models | removed; 22 keep every op on fal (Kling 2.5 Turbo and Wan 2.7 also on Replicate) | lost ops: `seedance-2-5` **v2v** (Seedance 2.5 video edit; `bytedance/seedance-2.5/video-edit` is 404 on fal) → Kling O3 edit, Happy Horse video edit or the Wan VACE Original; `ltx-2-5` **flf2v** → `fal-ai/ltx-2.3-22b/image-to-video/lora` with `end_image_url`, or Wan 2.2 FLF2V | O7 |
| Training targets `soul-id-v2`, `soul-id-cinema` | `fal-z-image` (`fal-ai/z-image-turbo-trainer-v2`) and `aitk-z-image`, retargeted to `fuobe-soul` / `fuobe-soul-cinema` | — | O3 |
| Elements with a Higgsfield Soul ID (`ElementLora.referenceId`) | "Retrain for Fuobe Soul" from the element's stored photos (Soul IDs are not exportable) | — | O3 |
| Soul preset list: live `/api/providers/higgsfield/presets` + `SOUL_PRESETS` style_ids | `SOUL_ORIGINALS` (Fuobe looks); Higgsfield UUIDs only in a migration map | — | O2 / O7 |
| Genjutsu looks (Higgsfield `preset_id`, live list) | Fuobe looks (a Soul look LoRA on frame 0) | — | O5 |
| Native Soul HEX palette (`color_palette` on Soul and Cinema Studio) | hex in prompt + palette lock (`oss-palette-image` / `oss-palette-video`) | Recraft V4.1 / Ideogram 3.0 native palettes | O2 / O6 |
| Curated moodboards (Soul 2.0 style_ids); personal moodboards | Fuobe looks; style LoRA per personal board | Recraft V4 Styles, Nano Banana Pro references | O3 |
| Setting `higgsfieldKey` (`HIGGSFIELD_API_KEY`), connection test, vendor mark | removed; a `civitaiKey` secret is added (O1) | — | O7 |

### Packages, in priority order

| # | package | priority | depends on | replaces |
|---|---|---|---|---|
| O0 | Land round 4 first | P0 | — | nothing; avoids rebasing every Originals package over 91 unmerged commits |
| O1 | LoRA plumbing on both engines | P0 | O0 | nothing directly; every later package needs it |
| O2 | Fuobe Soul: Soul v1, Soul 2.0, Soul Cinema and HEX | P0 | O1 | `soul-1`, `soul-2`, `soul-cinema`, Soul style_ids and curated moodboards, the native Soul HEX palette |
| O3 | Fuobe Soul ID and personal moodboards (training) | P0 | O1, O2 | `soul-id-v2`, `soul-id-cinema`; `custom_reference_id` + strength → character LoRA + scale; Higgsfield moodboard training |
| O4 | Fuobe DoP: camera motions, Mix and effects | P0 | O1 | Higgsfield DoP and the `higgsfield` preset family. Fuobe has no DoP catalog model today; the 108 presets ran as prompts on partner models |
| O5 | Fuobe Genjutsu (motion transfer, object swap, restyle, Lite) | P1 | O0, O1, O2 | `genjutsu-motion-transfer`, `genjutsu-object-swap`, `genjutsu-restyle`, `genjutsu-lite-*`, Genjutsu looks |
| O6 | Fuobe Cinema (Cinema Studio 4.0 Original) and Soul Cast / Location | P1 | O0, O2, O4 | `cinema-studio-4`; Cinema's `soul-cinema`, Soul Cast and Soul Location defaults |
| O7 | Remove the Higgsfield provider (the switch) | P1 | O2, O3, O5, O6 | every row of the replacement table |
| O8 | Evaluation harness and real preset covers (task #65) | P1 | O2, O4 | the "quality unverified" caveat; it gates calling any Original "verified" |
| O9 | Mixed Media and Shorts on hosted open models | P2 | O1, O2 | Higgsfield Mixed Media and Shorts as products (Gemini Omni and other partners stay as choices) |
| O10 | Marketing, Ads, AI Influencer, Photodump and Fashion on Originals | P2 | O2, O3, O7 | `marketing-studio-image`, `ads-studio` (as defaults), the AI Influencer app's Higgsfield route, and the Soul-based Photodump and Fashion defaults |
| O11 | Rebranded open tools, Speak and finishing | P2 | O1 | the Higgsfield-branded tools (none of them is in Fuobe's Higgsfield catalog, so nothing is deleted) |
| O12 | Train Fuobe's own LoRAs and the motion library | P2 | O8 | the 16 "train" looks and the prompt-only motions |
| O13 | Popcorn, Evolution and Effects 2.0 chains | P3 | O2, O5 | the Higgsfield Popcorn and Evolution products |

P0 = needed before any Higgsfield model can go; P1 = the switch-off and what it needs; P2 = product parity after the switch; P3 = nice to have.

#### O0 · Land round 4 first (P0)

- **Scope**
  - A gate, not a feature. Merge the seven unmerged round-4 branches into `claude/fuobe-parity-4` (task #3): `r4/genjutsu` (8 commits), `r4/cinema-3d` (11), `r4/video-finish` (15), `r4/video-keyframes` (7), `r4/faceless-plus` (4), `r4/ux-shell` (17), `r4/ux-flows` (29). O5 builds on `r4/genjutsu`, which adds `src/lib/catalog/genjutsu.ts` (`oss-wan22-animate`, `oss-vace-swap`, `oss-vace-insert`, `oss-wan22-vace-restyle`) and the `/genjutsu` studio. O6 builds on `r4/cinema-3d` and O11 on `r4/video-finish` (FPS boost, SDR→HDR).
  - Re-run the ComfyUI library validation after the merge.
- **Files likely touched (`src/`, `scripts/`):** no new files
- **ComfyUI workflows:** re-validate all (`npm run all` in `scripts/comfy`)
- **Catalog changes:** none
- **Tests**
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  - `node validate-workflows.mjs` against a live CPU ComfyUI
- **Replaces:** nothing; avoids rebasing every Originals package over 91 unmerged commits

#### O1 · LoRA plumbing on both engines (P0)

- **Scope**
  - `LoraRef` gains `weightName`, `hostedUrl` (a mirrored copy), `version` (civitai version id) and `licence {commercial, hostedOk, snapshotDate}`. `target` (high / low / both) stays.
  - fal payload: send `transformer` from `target` (Wan 2.1 LoRAs → `both`) and `weight_name`. Drop `hostedOk: false` LoRAs and say so in the plan notes. Cut to the endpoint's maximum (3 on Z-Image, Qwen, klein and LTX-quality). On LTX-2.3, `loras` is required, so always send at least one.
  - `loraEndpoint` for more cloud models: Wan 2.2 A14B i2v / t2v / t2i, Qwen-Image 2512, Qwen-Image-Edit 2511, FLUX.2 [klein] 4B (+ edit), LTX-2.3 22B i2v / t2v / v2v / extend. `gen-cloud-models.py` reads them from this file's `hostedLoraEndpoints`.
  - Replicate payloads: `prunaai/z-image-turbo-lora` (`lora_weights[]`, `lora_scales[]`); `wan-video/wan-2.2-i2v-fast` (one LoRA per expert; Mix falls back to fal).
  - LoRA fetcher `src/server/loras.ts`. Before a ComfyUI submit, a missing file is downloaded into `comfyLorasDir`: Hugging Face direct, civitai by pinned version id with `?token=` from a new `civitaiKey` secret (`CIVITAI_API_KEY`). The fetcher saves the unique `file` name and checks the size or hash that civitai returns. A civitai LoRA with `Rent` may be mirrored once to fal storage (`prepareFile`); the URL and permission snapshot are cached in a `lora_mirrors` table.
  - Generated `src/lib/catalog/lora-library.generated.ts` from `loraLibrary` + `motionsEffects` (new `scripts/gen-lora-library.py`, added to `gen:catalog`).
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/types.ts`, `src/server/providers/fal.ts`, `src/server/providers/replicate.ts`, `src/server/providers/comfyui.ts` (fetch before submit; `explainComfyError`), `src/server/loras.ts` (new), `src/server/settings.ts`, `src/lib/connections.ts`, `src/components/settings-form.tsx`, `src/server/db.ts` (mirror table), `scripts/gen-cloud-models.py`, `scripts/gen-lora-library.py` (new), `package.json` (`gen:catalog`)
- **ComfyUI workflows:** none new; `injectLoras` (`LoraLoaderModelOnly`) already exists
- **Catalog changes:** `lora-library.generated.ts`; `loraEndpoint` on the open-weight cloud models
- **Tests**
  - `tests/fal-lora.test.ts`: transformer per item, max-3 cut with a note, LTX always ≥1 LoRA, `hostedOk: false` filtered
  - `tests/replicate-lora.test.ts`
  - `tests/lora-fetch.test.ts`: HF direct, civitai token appended but never logged, 401 → "add a civitai key", pinned versions, unique names
  - `tests/lora-library.test.ts`: every entry has licence fields and a snapshot date; no duplicate `file`
- **Replaces:** nothing directly; every later package needs it
- **Depends on:** O0
- **Check on the first live run:** whether fal accepts a tokenised civitai URL in `path` (prefer the mirror); whether LTX-2.3 needs a real LoRA when only `camera_lora` is wanted

#### O2 · Fuobe Soul: Soul v1, Soul 2.0, Soul Cinema and HEX (P0)

- **Scope**
  - `scripts/gen-soul-originals.py` → `src/lib/catalog/soul-originals.generated.ts`. It holds the 139 looks from `presets[]`: Fuobe id, name, family v1 / v2, categories, look sentence, tail, triggers, `loras [key@strength]`, grade, base (`z-image` or `qwen-2512`), train flag, note, and `legacyStyleId` (the Higgsfield UUID, migration only).
  - New ModelDefs: `fuobe-soul` (open: `z-image-turbo-t2i` + LoRAs; cloud: `fal-ai/z-image/turbo/lora`; Replicate `prunaai/z-image-turbo-lora`), `fuobe-soul-hd` (Qwen-Image 2512 for lettering presets) and `fuobe-soul-cinema` (filmstill 0.7 + moviewide 0.5, `cine` tail, 16:9 default). Options as Soul: 7 aspects, 720p / 1080p tiers from §4.3, batch 1 or 4, seed 1–1,000,000. Preset strength 0–1 multiplies the look's LoRA scales; character strength 0–1 maps to a character-LoRA scale of 0.6–1.0.
  - Prompt builder `src/lib/catalog/soul.ts`: triggers + the user's prompt (short prompts expanded to 60–120 words by the existing enhancer) + look + tail. Slot rule within fal's 3: character LoRA first, then the look's LoRAs, then the core LoRA if a slot is left.
  - Edit route (Soul 2.0 image-to-image): new `z-image-turbo-i2i` / `fal-ai/z-image/turbo/image-to-image/lora`. An optional refiner pass at denoise ≈ 0.17 (Higgsfield's `time_denoise_from` 0.83) is an experiment until O8.
  - Post steps: the grade preset is applied in the browser when the result arrives (the existing WebGL grade in `src/lib/grade.ts`), stored as a derived output with `meta.grade`. API and MCP clients get `meta.grade`. New `invert` and `solarize` presets. Palette lock (`oss-palette-image`) when a HEX palette is picked on the open engine; hex in the prompt on the cloud. Date-stamp, CCTV and photo-booth overlays are drawn in the browser. The face mosaic waits for O11.
  - Pickers read `SOUL_ORIGINALS` instead of `SOUL_PRESETS`. Covers stay procedural until O8 renders real ones.
- **Files likely touched (`src/`, `scripts/`):** `scripts/gen-soul-originals.py` (new), `src/lib/catalog/soul-originals.generated.ts` (new), `src/lib/catalog/soul.ts` (new), `src/lib/catalog/models.ts`, `src/lib/catalog/packs.ts` (`presetFallback`, `presetPrompt`), `src/lib/catalog/palettes.ts` (`styleWords`, `SIGNATURE_MODELS`), `src/lib/grade.ts`, `src/components/moodboards/{logic.ts,cards.tsx,soul-preset-cards.tsx}`, `src/components/studio/{preset-chips.tsx,model-controls.tsx}`, `src/lib/studio-catalog.ts`, `src/server/generations.ts` (post-step meta), `package.json`
- **ComfyUI workflows:** **add** `z-image-turbo-i2i` (Z-Image Turbo img2img, denoise input, LoRA-injectable); reuse `z-image-turbo-t2i`, `qwen-image-2512-t2i`, `palette-transfer-image`, `palette-zimage-hex`, `upscale-image-seedvr2`; register in `scripts/comfy/library.spec.mjs`, then build and validate
- **Catalog changes:** 3 ModelDefs; 139 looks; 2 grade presets
- **Tests**
  - `tests/soul-originals.test.ts`: 139 looks; ≤3 LoRAs each; every LoRA in the library with `commercial && hostedOk`; trigger order; size table in multiples of 16 with the longest side ≤2048; fal payload `{loras:[{path, scale}], num_inference_steps: 8, image_size}`; ComfyUI binding builds a `LoraLoaderModelOnly` chain
  - update `preset-cards.test.ts`, `image-studios.test.ts`, `open-engine.test.ts` (new workflow binding)
  - grade tests for `invert` / `solarize`
- **Replaces:** `soul-1`, `soul-2`, `soul-cinema`, Soul style_ids and curated moodboards, the native Soul HEX palette
- **Depends on:** O1
- **Check on the first live run:** three-LoRA stacks on 8-step Z-Image Turbo need a GPU A/B (O8); how fal rounds the per-MP price for sub-1 MP images

#### O3 · Fuobe Soul ID and personal moodboards (training) (P0)

- **Scope**
  - Remove the `soul-id-v2` and `soul-id-cinema` targets. Keep `fal-z-image` (`fal-ai/z-image-turbo-trainer-v2`: 2,000 steps, lr 5e-4, about $1.70) and `aitk-z-image` (rank 16–32, 1,500–2,500 steps), retargeted to `fuobe-soul` / `fuobe-soul-cinema`. Optionally add `fal-ai/qwen-image-2512-trainer` for `fuobe-soul-hd`.
  - Photo rules from Higgsfield's help center: 20+ photos recommended (80 max on the web); no sunglasses, groups, filters or cropped faces; one full-body shot. Keep the consent checkbox. "Upgrade character" retrains the same photos on another base.
  - Personal moodboards become a style LoRA: the AI-Toolkit style preset (exists) or `fal-ai/z-image-trainer` with `training_type: style`. The result is used as a Fuobe look.
  - Elements holding a Higgsfield Soul ID can't be exported, so they get a "Retrain for Fuobe Soul" action using their stored photos. The `soulId()` path in `packs.ts` goes.
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/training.ts`, `src/server/training.ts`, `src/lib/catalog/elements.ts`, `src/lib/catalog/packs.ts`, `src/server/photodump.ts`, `src/app/api/photodump/character/route.ts`, `src/server/moodboards.ts`, `src/server/elements.ts`, `src/components/moodboards/*`, `src/components/photodump/subject.tsx`, element training UI
- **ComfyUI workflows:** none (AI-Toolkit runs outside ComfyUI; the LoRA is copied into `ComfyUI/models/loras`)
- **Catalog changes:** training targets
- **Tests**
  - `training.test.ts`: no `higgsfield` provider and every target resolves
  - `training-runtime.test.ts`: fal trainer payload (zip of `001.jpg` + `001.txt`, `default_caption`, `steps`) and `diffusers_lora_file` → `ElementLora.url`
  - elements test: an @mention puts the LoRA on `fuobe-soul`
  - image-studios: Photodump with a trained character
- **Replaces:** `soul-id-v2`, `soul-id-cinema`; `custom_reference_id` + strength → character LoRA + scale; Higgsfield moodboard training
- **Depends on:** O1, O2
- **Check on the first live run:** identity quality against Soul ID is untested; add face crops as extra samples if likeness is weak

#### O4 · Fuobe DoP: camera motions, Mix and effects (P0)

- **Scope**
  - `scripts/gen-oss-loras.py` also reads `motionsEffects` from this file. It takes the statuses add-lora, replace, relight-route and weak-candidate, plus local-only (open only), and emits the base (wan2.2 high / low, wan2.1 both, ltx-2.3, ltx-2.5) and licence flags per LoRA.
  - New ModelDef `fuobe-dop` (i2v). Open: `wan22-i2v-14b-lora`. Cloud: `fal-ai/wan/v2.2-a14b/image-to-video/lora` with `num_frames` 49 or 81, `frames_per_second` 16, `interpolator_model: none`, 20 steps, `transformer` per file. Replicate: `wan-video/wan-2.2-i2v-fast` (one LoRA per expert).
  - `fuobe-dop-ltx` for presets whose best LoRA is LTX-2.3: FPV Drone, Wind to Face, 13 transitions with `end_image_url`, and Earth Zoom Out (unverified). Open: new `ltx23-i2v-lora`. Cloud: `fal-ai/ltx-2.3-22b/image-to-video/lora`, `camera_lora` for the Jib and Dolly aliases. LTX-2.5-only LoRAs (Slow Motion, Exploded View, Car Jump) run on the open engine only; the cloud falls back to the prompt. BTS stays prompt-only on both while its licence is on hold (§7.2).
  - Add the §7.3 Fun Camera poses and aliases to `FUN_CAMERA_POSE`. Focus Change → `lightricks/ltx-2.5/image-to-video/fast` `camera_motion: focus_shift`.
  - Mix sends both presets' LoRAs, each scaled by its strength, on both engines.
  - Effects: the post-grade group (15) becomes a grade step; the relight group (6) runs Qwen-Edit 2509 Relight on the start frame, then Wan; the Mixed Media group (32) moves to O9.
  - `local-only` LoRAs never reach fal or Replicate; the UI says "open engine only".
- **Files likely touched (`src/`, `scripts/`):** `scripts/gen-oss-loras.py`, `src/lib/catalog/oss-loras.generated.ts`, `src/lib/catalog/index.ts` (`withOssLoras`, `FUN_CAMERA_POSE`), `src/lib/catalog/motions.ts`, `src/lib/catalog/apps.ts` (effects), `src/lib/catalog/models.ts`, `src/lib/catalog/payload.ts`, `src/lib/catalog/cinema.ts` (`openCameraRoute`)
- **ComfyUI workflows:** **add** `ltx23-i2v-lora` and `ltx23-t2v-lora` (LTX-2.3 22B distilled + `injectLoras`; Lightricks/LTX-2.3, LTX-2 Community licence); reuse `wan22-i2v-14b-lora`, `wan22-fun-camera-14b`, `wan22-flf2v-14b`, `relight-qwen-edit-2509`
- **Catalog changes:** 2 ModelDefs; the motion / effect → LoRA map v2
- **Tests**
  - `tests/oss-loras.test.ts`: high / low pairs, Wan 2.1 → both, unique files, `local-only` never in a cloud payload
  - `tests/dop-originals.test.ts`: 49 / 81 frames, `interpolator_model: none`, 16 fps, Mix scales
  - motions catalog: every motion and effect has an open and a cloud route
  - `open-engine.test.ts` bindings for the LTX-2.3 graphs
- **Replaces:** Higgsfield DoP and the `higgsfield` preset family. Fuobe has no DoP catalog model today; the 108 presets ran as prompts on partner models
- **Depends on:** O1
- **Check on the first live run:** Wan 2.1 LoRAs on Wan 2.2 (strength, expert); whether LTX-2 19B LoRAs load on fal's LTX-2.3 endpoints

#### O5 · Fuobe Genjutsu (motion transfer, object swap, restyle, Lite) (P1)

- **Scope**
  - Hosted-open routes in the merged `genjutsu.ts`. Motion transfer → `fal-ai/wan/v2.2-14b/animate/move` (480 / 580 / 720p, $0.04–0.08/s), or `fal-ai/scail-2` for animals and several people. Object swap → `fal-ai/sam-3-1/video` mask → `fal-ai/wan-vace-14b/inpainting` with `mask_video_url` and `ref_image_urls`; people → `fal-ai/wan/v2.2-14b/animate/replace` or SCAIL-2 `replacement`. Restyle → frame 0 by `fal-ai/qwen-image-edit-2511/lora` or a Soul look on `fal-ai/z-image/turbo/image-to-image/lora`, then `fal-ai/wan-22-vace-fun-a14b/depth` with `first_frame_url`.
  - Lite: 480p plus `use_turbo` on fal animate; Wan Animate 2 with the lightx2v distill LoRA on the open engine.
  - Higgsfield's limits: source trimmed to 4–30 s (Lite 15 s), ≤10 references, keep audio on (the original sound is muxed back).
  - The look picker lists Fuobe looks (O2) instead of Higgsfield `preset_id`s. Katana's and Ad Multiplier's Genjutsu option points at the Original.
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/genjutsu.ts`, the r4 Genjutsu server module and API routes, `src/components/genjutsu/{genjutsu-studio.tsx,look-picker.tsx,setup-code.tsx}`, `src/lib/av/katana.ts`, `src/lib/catalog/marketing.ts` (Ad Multiplier), `src/lib/catalog/models.ts`
- **ComfyUI workflows:** reuse `wan-animate2`, `video-swap-wan-vace`, `video-insert-wan-vace`, `video-restyle-wan22-fun-vace`, `video-bg-remove-sam3`, `video-mux-audio`; optional **add** `scail2-animate` / `scail2-replace` from the ComfyUI core templates
- **Catalog changes:** 5 Original ModelDefs (3 modes + 2 Lite)
- **Tests**
  - planner per mode × engine
  - chain hand-off: SAM mask → VACE inpaint
  - per-second price estimates
  - `katana` tests
- **Replaces:** `genjutsu-motion-transfer`, `genjutsu-object-swap`, `genjutsu-restyle`, `genjutsu-lite-*`, Genjutsu looks
- **Depends on:** O0, O1, O2
- **Check on the first live run:** Wan VACE inpaint quality with a reference object; SCAIL-2 limits (512p / 704p only)

#### O6 · Fuobe Cinema (Cinema Studio 4.0 Original) and Soul Cast / Location (P1)

- **Scope**
  - `fuobe-cinema` video model. Cloud: `fal-ai/ltx-2.3-22b/image-to-video/lora` and `/text-to-video/lora`, with the Director panel compiled into the prompt (existing compiler) and `enable_prompt_expansion: false`. `generate_audio` follows the toggle. The camera move becomes `camera_lora` when one of the 8 values fits, else the move's LTX or Wan LoRA. Duration → `num_frames` at 24 fps (≤481 frames, about 20 s); 30 s needs one extend. 720p default.
  - Open: Wan 2.2 14B Lightning + camera LoRA / Fun Camera (exists), or LTX-2.5 22B (`ltx25-i2v` / `-t2v`, gated weights) for audio + video. Palette lock via `oss-palette-video`.
  - Extend → `fal-ai/ltx-2.3-22b/extend-video/lora` or Wan Fun VACE extend. Edit → `fal-ai/ltx-2.3-22b/video-to-video/lora` or Wan Fun VACE restyle. Reference clips: none on the open engine (keep the note); one clip via `fal-ai/ltx-2.3-22b/reference-video-to-video/lora` (to verify).
  - Image mode uses `fuobe-soul-cinema`. Soul Cast uses `fuobe-soul` + the 17-field compiler. Soul Location uses `fuobe-soul` + Multiple-angles views.
  - Remove `HIGGSFIELD_ONLY` from `cinema.ts`.
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/cinema.ts` (`HIGGSFIELD_ONLY`, `CINEMA_MODELS`, `CAST_MODELS`, `LOCATION_MODELS`), `src/server/cinema-generate.ts`, `src/server/cinema-director.ts`, `src/server/cinema.ts`, `src/components/cinema/{director-panel.tsx,prompt-bar.tsx,soul-builders.tsx,hooks.ts,cinema-feed.tsx}`, `src/app/api/cinema/projects/[id]/route.ts`, `src/lib/catalog/models.ts`
- **ComfyUI workflows:** reuse `wan22-i2v-14b-lightx2v`, `wan22-fun-camera-14b`, `ltx25-i2v`, `ltx25-t2v`, `palette-transfer-video`, `video-extend-wan22-fun-vace`, `video-restyle-wan22-fun-vace`; `ltx23-*-lora` from O4
- **Catalog changes:** `fuobe-cinema`; Cinema model lists
- **Tests**
  - `cinema.test.ts`, `cinema-api.test.ts`, `cinema-refs.test.ts` with no Higgsfield context
  - payload: all 33 moves → `camera_lora` or a LoRA; duration → frames; estimate
- **Replaces:** `cinema-studio-4`; Cinema's `soul-cinema`, Soul Cast and Soul Location defaults
- **Depends on:** O0, O2, O4
- **Check on the first live run:** LTX-2.3 reference-video for Cinema references; quality will not match Seedance 2.5; the partner models stay pickable

#### O7 · Remove the Higgsfield provider (the switch) (P1)

- **Scope**
  - Delete the provider, its generated catalog, its generator, the settings key, the connection test, the presets API and the `higgsfield` training provider.
  - Add `src/lib/catalog/replaced.ts` (`REPLACED_BY`: old model id or style id → Original + a note). Reuse, saved Cinema / Canvas projects and Assist plans resolve through it. Past generations stay viewable, because the Library reads outputs, not providers.
  - Close the partner gaps: Seedance 2.5 v2v and LTX-2.5 flf2v (table above); Happy Horse 1.1 gets fal routes or is hidden. Marketing Studio Image and Ads Studio map to their partner / Fuobe pipelines until O10 makes the Originals default.
  - Docs: `docs/STATUS.md` rows, `docs/research/README.md` (the Higgsfield research files become history and feed no generator), About & licences.
- **Files likely touched (`src/`, `scripts/`):** **delete** `src/server/providers/higgsfield.ts`, `src/lib/catalog/higgsfield-models.generated.ts`, `scripts/gen-higgsfield-models.py`, `src/app/api/providers/higgsfield/presets/route.ts`, `tests/higgsfield.test.ts`, `src/server/providers/index.ts`, `src/lib/catalog/models.ts` (the `HIGGSFIELD_*` merge), `src/server/settings.ts`, `src/lib/connections.ts`, `src/components/{settings-form.tsx,get-started.tsx,app-sidebar.tsx,studio/vendor-mark.tsx}`, `src/lib/catalog/{training,cinema,packs,palettes,marketing,apps,canvas,faceless,storyboard,shorts-models,remove-object}.ts`, `src/server/{generations,training,photodump,ads,marketing,cinema,cinema-generate,canvas,palettes,layers,brand}.ts`, `src/server/assist/studio-tools.ts`, `src/lib/{assist,composer,library,studio-catalog}.ts`, `src/app/(studio)/settings/about/page.tsx`, `package.json`, `scripts/gen-cloud-models.py`, 122 files mention Higgsfield today; most are UI copy
- **ComfyUI workflows:** none
- **Catalog changes:** `replaced.ts`; Happy Horse 1.1 fal routes (research their schemas first)
- **Tests**
  - catalog integrity: no route has `provider: "higgsfield"`; every `REPLACED_BY` target exists and runs on both engines
  - a grep guard: no `higgsfield` in `src/` outside an allowlist of attribution copy
  - update `providers`, `connections`, `engine-mode`, `cloud-catalog*`, `studio-pickers`, `home-start` tests
  - e2e `no-horizontal-scroll.mjs` and `composer-flows.mjs` in demo mode
- **Replaces:** every row of the replacement table
- **Depends on:** O2, O3, O5, O6
- **Check on the first live run:** the non-US `bytedance/seedance-2.5/*` fal ids serve (OpenAPI 200 on 2026-10-23) but are missing from fal's catalog listing; check before fal becomes their only route

#### O8 · Evaluation harness and real preset covers (task #65) (P1)

- **Scope**
  - `scripts/eval/`: render every Soul look, motion and effect on a GPU (ComfyUI) and on fal under a spend cap, with and without its LoRAs, at the listed strengths. Write a contact sheet and a JSON log (time, VRAM, $). Lower the strengths that over-cook, and record each result back into the research JSON.
  - The renders become the preview media (no Higgsfield previews).
- **Files likely touched (`src/`, `scripts/`):** `scripts/eval/{run.mjs,plan.mjs,report.mjs}` (new), `src/lib/preset-cards.ts`, `public/previews/*`
- **ComfyUI workflows:** reuse all
- **Catalog changes:** strength updates in the research JSON → `gen:catalog`
- **Tests**
  - a dry run lists N jobs and the estimated spend; no GPU needed
- **Replaces:** the "quality unverified" caveat; it gates calling any Original "verified"
- **Depends on:** O2, O4
- **Check on the first live run:** needs a GPU and a fal key; none here

#### O9 · Mixed Media and Shorts on hosted open models (P2)

- **Scope**
  - Mixed Media: a per-index chain slot in `createPipeline` (`src/server/chains.ts`; a STATUS gap). Steps: `fal-ai/ffmpeg-api/extract-frame` → `fal-ai/z-image/turbo/controlnet/lora` per frame (look LoRA, fixed seed) → `fal-ai/ffmpeg-api/images-to-video` → mux the original sound. Up to 10 s × 24 fps = 240 frames, split above 200. The smooth option restyles frame 0, then runs `fal-ai/wan-22-vace-fun-a14b/depth`.
  - Shorts hosted Original: segment → Qwen edit frame 0 → fal Wan Fun VACE depth → `fal-ai/ffmpeg-api/merge-videos` → mux.
  - The 32 Mixed-Media-looking effects use this route.
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/{mixed-media,shorts,shorts-models,plan}.ts`, `src/server/chains.ts` (`createPipeline` per-index fan-out), `src/server/{mixed-media,shorts}.ts`, `src/components/mixed-media/settings.tsx`
- **ComfyUI workflows:** reuse `mixed-media-zimage-frames`, `video-segment-resample`, `video-restyle-wan22-fun-vace`, `video-concat-*`, `video-mux-audio`
- **Catalog changes:** `fuobe-mixed-media`, `fuobe-shorts` cloud routes
- **Tests**
  - `mixed-media.test.ts`: frames = floor(seconds × fps) and cost
  - pipeline fan-out
  - `shorts.test.ts` hosted-open route
- **Replaces:** Higgsfield Mixed Media and Shorts as products (Gemini Omni and other partners stay as choices)
- **Depends on:** O1, O2
- **Check on the first live run:** per-frame cost and flicker

#### O10 · Marketing, Ads, AI Influencer, Photodump and Fashion on Originals (P2)

- **Scope**
  - Marketing Studio Image → Qwen-Image-Edit 2511 (`fal-ai/qwen-image-edit-2511/lora` hosted) + template prompts; GPT Image 2.5 stays a partner choice.
  - Ads Studio → the Fuobe pipeline (LLM copy → Qwen-Image 2512 or edit → browser compositing) as the default.
  - AI Influencer builder (19 categories) → phrase compiler → `fuobe-soul` 16:9 sheet; "Add your face" via Qwen edit.
  - Photodump → `fuobe-soul` + character LoRA + pack prompts. Instadump → Qwen-Image-Edit 2511 multi-reference.
  - Fashion Factory → `fuobe-soul` base shots → FLUX.2 [klein] **4B** try-on (open `tryon-flux2-klein-4b`; hosted `fal-ai/flux-2/klein/4b/edit/lora` if the try-on LoRA allows hosting) → Qwen edit photoset.
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/{marketing,packs,apps}.ts`, `src/server/{marketing,ads,photodump}.ts`, `src/components/{marketing,ads,photodump,fashion}/*`
- **ComfyUI workflows:** reuse `qwen-image-edit-2511`, `qwen-image-edit-2511-multi`, `qwen-image-2512-t2i`, `product-shot-qwen-edit-2509`, `tryon-flux2-klein-4b`, `soul-cast-sheet-zimage`
- **Catalog changes:** `fuobe-marketing-image`; default model lists
- **Tests**
  - `marketing-catalog`, `marketing-api`, `image-studios`, `image-studios-api` without Higgsfield
- **Replaces:** `marketing-studio-image`, `ads-studio` (as defaults), the AI Influencer app's Higgsfield route, and the Soul-based Photodump and Fashion defaults
- **Depends on:** O2, O3, O7
- **Check on the first live run:** the try-on LoRA's hosting right

#### O11 · Rebranded open tools, Speak and finishing (P2)

- **Scope**
  - Angles: a route on `fal-ai/qwen-image-edit-2509-lora-gallery/multiple-angles` with Higgsfield-like controls (rotate −90…90°, vertical −1…1, forward 0–10, wide-angle; `lora_scale` 1.25, 6 steps). Open: new `qwen-image-edit-2509-angles` (dx8152 Multiple-angles + Qwen-Image-Lightning) next to the 2511 route.
  - Depth Map defaults to VDA-Small / DA3 Mono-Large. VDA-Large is flagged non-commercial; `fal-ai/depth-anything-video` is hosted-only under fal's terms.
  - Speak / Lipsync: an InfiniteTalk "Higgsfield defaults" preset (FusioniX LoRA, motion_frame 15, 25 steps, shift 10, guidance 5 / 5, colour correction 1) on the open engine; `fal-ai/infinitalk` hosted; a Speak-v1-like route on Wan 2.2 S2V.
  - Upscale: SeedVR2 (exists) plus FPS boost and SDR→HDR from `r4/video-finish`; hosted `fal-ai/seedvr/upscale/video`, `fal-ai/rife/video`, `fal-ai/ltx-2.3-quality/hdr/lora`.
  - Soul face mosaic: SAM 3.1 face mask + mosaic (open graph; hosted `fal-ai/sam-3-1/image`).
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/{apps,models}.ts`, `src/server/providers/comfyui.ts` (InfiniteTalk params), video-tools and lipsync components
- **ComfyUI workflows:** **add** `qwen-image-edit-2509-angles`; **extend** `infinitetalk-wanwrapper` (FusioniX file + exposed params); **add** `image-face-mosaic-sam3`
- **Catalog changes:** route additions
- **Tests**
  - apps tests
  - ComfyUI binding tests for the new / extended graphs
- **Replaces:** the Higgsfield-branded tools (none of them is in Fuobe's Higgsfield catalog, so nothing is deleted)
- **Depends on:** O1
- **Check on the first live run:** licences of the LoRAs merged into FusioniX

#### O12 · Train Fuobe's own LoRAs and the motion library (P2)

- **Scope**
  - The §6 LoRAs from owned or licensed data, starting with `fuobe-soul-core`, `fuobe-cctv`, `fuobe-ultrawide-05`. Then Wan 2.2 I2V LoRAs for Eyes In / Mouth In, Timelapse and Drone Reveal (`fal-ai/wan-22-trainer/i2v-a14b`).
  - A motion library of short CC0 or own-shot clips for the 13 sports moves (Wan Animate 2 / SCAIL-2 driving clips).
  - Host the files in a Fuobe Hugging Face org, with a data-licence log per LoRA.
- **Files likely touched (`src/`, `scripts/`):** research JSON `loraLibrary` / `motionsEffects` entries, `scripts/train/` (new job specs)
- **ComfyUI workflows:** none
- **Catalog changes:** library entries → `gen:catalog`
- **Tests**
  - the library test rejects an entry without a licence snapshot
- **Replaces:** the 16 "train" looks and the prompt-only motions
- **Depends on:** O8
- **Check on the first live run:** data rights for every training image

#### O13 · Popcorn, Evolution and Effects 2.0 chains (P3)

- **Scope**
  - Popcorn: the storyboard flow exists (next-scene); add Soul looks for the stills.
  - Evolution: one video + up to 40 references; `change_intensity` low / medium / high → denoise 0.45 / 0.65 / 0.85 on Wan Fun VACE restyle (open) or `fal-ai/ltx-2.3-22b/video-to-video/lora` (hosted; check its strength field); an LLM writes the creative direction.
  - Effects 2.0 chains as Canvas templates (image edit → i2v).
- **Files likely touched (`src/`, `scripts/`):** `src/lib/catalog/{storyboard,canvas}.ts`, Video edit catalog
- **ComfyUI workflows:** reuse
- **Catalog changes:** `fuobe-evolution`
- **Tests**
  - planner tests
- **Replaces:** the Higgsfield Popcorn and Evolution products
- **Depends on:** O2, O5

### Still unverified after this pass

- Nothing was rendered: every look, motion, effect and studio route needs the O8 GPU pass before it can be called verified.
- fal behaviour: tokenised civitai URLs in `path`; whether LTX-2.3 LoRA calls need a real LoRA when only `camera_lora` is wanted; whether the Wan 2.2 trainer's single `lora_file` belongs on both experts; whether LTX-2 19B LoRAs load on LTX-2.3; sub-1 MP price rounding.
- civitai permissions can change; the fetcher stores a snapshot with each mirrored file (O1).
- Higgsfield's base models for Soul, DoP and Popcorn remain unknown; the plan does not depend on them.
