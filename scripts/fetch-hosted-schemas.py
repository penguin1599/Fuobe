#!/usr/bin/env python3
"""
Research helper (needs the network; not part of gen:catalog): read the input schemas of the hosted
open-weight endpoints the catalog routes LoRAs to, and store them in
docs/research/fuobe-originals-recipes-5.json in the same shape as paid-model-apis*.json `inputs`:

- hostedLoraEndpoints[<id>].inputs / keyFields / output  for the LoRA endpoints in LORA (fal OpenAPI,
  or the schema embedded in a Replicate model page, pinned to the research's version);
- hostedBaseEndpoints[]  for the plain endpoints of the same models that no earlier research file
  has (LTX-2.3 22B t2v / i2v / extend / v2v, FLUX.2 [klein] 4B), with their price from fal's llms.txt.

keyFields (which input is the prompt, the image, the clip…) are this script's curation, as in the
earlier research files. scripts/gen-cloud-models.py reads both lists.

- trainers[<id>].loraOutput  for fal's LoRA trainers (--trainers): the response fields that hold the trained
  LoRA files (diffusers_lora_file, lora_file, or Wan 2.2's pair with high_noise_lora), read from each
  trainer's OpenAPI output schema, so src/server/training.ts knows where a finished training's LoRA is.

Run:  python3 scripts/fetch-hosted-schemas.py
      python3 scripts/fetch-hosted-schemas.py --only fal-ai/z-image/turbo/image-to-image/lora   (one endpoint, the rest kept)
      python3 scripts/fetch-hosted-schemas.py --trainers                                         (only the trainers' outputs)
      python3 scripts/fetch-hosted-schemas.py --base-only [endpoint …]                           (Genjutsu's plain endpoints, or O11's / BASE ones by id, the rest kept)
      python3 scripts/fetch-hosted-schemas.py --partner                                          (partner routes in partnerEndpoints, the rest kept)
      python3 scripts/fetch-hosted-schemas.py --part4 [endpoint …]                               (PART4's records in paid-model-apis-4.json, the rest kept)
      python3 scripts/fetch-hosted-schemas.py --new10 [endpoint …]                               (FLUX 3 Klein and Idol: NEW10's and NEW10_SPLATS' records in new-models-10.json, its trainers; or those named)
      python3 scripts/fetch-hosted-schemas.py --kandinsky6 [endpoint …]                          (Kandinsky 6.0 Pro / Lite / VSR: KANDINSKY6's records in new-models-10.json)
      python3 scripts/fetch-hosted-schemas.py --music [endpoint …]                               (full songs: MUSIC10's records in new-models-10.json; or those named)
      python3 scripts/fetch-hosted-schemas.py --catchup [endpoint …]                             (the hosted catch-up's CATCHUP records in new-models-10.json; or those named)
      python3 scripts/fetch-hosted-schemas.py --keying [endpoint …]                              (Bria green-screen despill and guided cut-out: KEYING's records in new-models-10.json)

--part4 re-reads endpoints that research part 4 recorded (docs/research/paid-model-apis-4.json) and refreshes them in
place: their inputs, the price lines of their llms.txt, their status in fal's catalog (active / playground-only, read
from the page) and the day it was checked; a Replicate model in PART4 gets its record made or refreshed the same way.
"""
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "docs/research/fuobe-originals-recipes-5.json"
TODAY = datetime.date.today().isoformat()

# Canonical slots → field names, per endpoint (Fuobe's names: see FieldMap in src/lib/catalog/types.ts).
T2I = {"prompt": "prompt", "negativePrompt": "negative_prompt", "aspectRatio": "image_size", "seed": "seed", "numOutputs": "num_images", "loras": "loras"}
EDIT = {**T2I, "images": "image_urls"}
LTX = {"prompt": "prompt", "negativePrompt": "negative_prompt", "aspectRatio": "video_size", "seed": "seed", "generateAudio": "generate_audio", "numFrames": "num_frames", "fps": "fps", "loras": "loras"}
KLEIN = {k: v for k, v in T2I.items() if k != "negativePrompt"}
LORA = {
    "fal-ai/qwen-image-edit-2511/lora": EDIT,
    # Qwen-Image-Edit 2509 with its LoRAs: Fuobe DoP relights a start frame with the 2509 Relight LoRA (o/dop).
    "fal-ai/qwen-image-edit-plus-lora": EDIT,
    "fal-ai/flux-2/klein/4b/lora": KLEIN,
    "fal-ai/flux-2/klein/4b/edit/lora": {**KLEIN, "images": "image_urls"},
    "fal-ai/ltx-2.3-22b/image-to-video/lora": {**LTX, "image": "image_url", "endImage": "end_image_url"},
    "fal-ai/ltx-2.3-22b/text-to-video/lora": LTX,
    "fal-ai/ltx-2.3-22b/video-to-video/lora": {**LTX, "video": "video_url"},
    "fal-ai/ltx-2.3-22b/extend-video/lora": {**LTX, "video": "video_url", "endImage": "end_image_url"},
    # Fuobe Restore's cloud half (package archive-restore): LTX-2.3 22B reference video to video with an IC-LoRA (Lightricks'
    # Restore IC-LoRA, gated on Hugging Face, sent through Fuobe's LoRA mirror). The archive clip is the reference video;
    # image_url, the optional first frame, takes the previous piece's last restored frame.
    "fal-ai/ltx-2.3-22b/reference-video-to-video/lora": {**LTX, "video": "video_url", "image": "image_url"},
    "fal-ai/wan/v2.2-a14b/image-to-video/lora": {"prompt": "prompt", "image": "image_url", "endImage": "end_image_url", "negativePrompt": "negative_prompt",
                                                 "aspectRatio": "aspect_ratio", "resolution": "resolution", "numFrames": "num_frames", "seed": "seed", "loras": "loras"},
    "fal-ai/wan/v2.2-a14b/text-to-video/lora": {"prompt": "prompt", "negativePrompt": "negative_prompt", "aspectRatio": "aspect_ratio", "resolution": "resolution",
                                                "numFrames": "num_frames", "seed": "seed", "loras": "loras"},
    "fal-ai/wan/v2.2-a14b/text-to-image/lora": {"prompt": "prompt", "negativePrompt": "negative_prompt", "aspectRatio": "image_size", "seed": "seed", "loras": "loras"},
    "fal-ai/z-image/turbo/lora": {k: v for k, v in T2I.items() if k != "negativePrompt"},
    # Fuobe Soul's edit route (O2): image-to-image with the look's LoRAs; image_size "auto" keeps the picture's shape.
    "fal-ai/z-image/turbo/image-to-image/lora": {**{k: v for k, v in T2I.items() if k not in ("negativePrompt", "aspectRatio")}, "image": "image_url"},
    # Fuobe Mixed Media's frames (O9): each frame drawn again under its own outlines (preprocess canny) with the look's
    # LoRAs at a fixed seed; image_size is sent as {width, height} from the clip's shape and the tier.
    "fal-ai/z-image/turbo/controlnet/lora": {**{k: v for k, v in T2I.items() if k not in ("negativePrompt", "aspectRatio")}, "image": "image_url"},
    "fal-ai/qwen-image-2512/lora": T2I,
    "prunaai/z-image-turbo-lora": {"prompt": "prompt", "width": "width", "height": "height", "seed": "seed"},
    # Soul ID on every base fal trains (O3, o/soul-id): the models a LoRA trained on FLUX.1 [dev], FLUX.1 Krea [dev],
    # FLUX.2 [dev], Krea 2 or FLUX.2 [klein] 9B runs on. Their licences are recorded as information, never a gate
    # (the owner's decision of 2026-10-27: the admin turns models on or off in Settings).
    "fal-ai/flux-lora": KLEIN,
    "fal-ai/flux-krea-lora": KLEIN,
    "fal-ai/flux-2/lora": KLEIN,
    "fal-ai/krea-2/turbo/lora": KLEIN,
    "fal-ai/flux-2/klein/9b/lora": KLEIN,
    # Fuobe Genjutsu's Character swap (O5, docs/research/openjutsu-6.md §8): MiniMax H3 reference-to-video with Akatz
    # Labs' Character Swap LoRA. The part of the clip goes as Video 1, the character (and the anchor frame) as Image 1, 2.
    "minimax/h3/reference-to-video/lora": {"prompt": "prompt", "images": "reference_image_urls", "video": "reference_video_urls",
                                           "duration": "duration", "resolution": "resolution", "seed": "seed", "loras": "loras"},
    # Upscale's SDR to HDR with LoRAs (build plan O11): the LTX-2.3 quality HDR pass, its /lora twin taken when a LoRA rides along.
    "fal-ai/ltx-2.3-quality/hdr/lora": {"prompt": "prompt", "video": "video_url", "resolution": "resolution", "numFrames": "num_frames", "fps": "frames_per_second",
                                        "generateAudio": "generate_audio", "seed": "seed", "negativePrompt": "negative_prompt", "loras": "loras"},
}
# LoRA endpoints that join hostedLoraEndpoints with this script (the record is made when it isn't there yet).
NEW_LORA = {
    "minimax/h3/reference-to-video/lora": {
        "provider": "fal", "id": "minimax/h3/reference-to-video/lora", "family": "MiniMax H3", "op": "ref2v",
        "roleForOriginals": "Fuobe Genjutsu Character swap, cloud half (Akatz Labs' Character Swap LoRA V1.5 or V1 by Hugging Face URL)",
        "lora": {"field": "loras", "required": True, "itemFields": "path:string; weight_name:string; scale:number default=1 minimum=0 maximum=4", "maxCount": 3},
        "keyFieldsRequired": ["prompt", "loras"],
        "price": "Video costs $0.0625 per second at 480p, $0.075 per second at 768p, $0.1625 per second at 2K and $0.20 per second at 4K.",
        "baseLicence": "MiniMax H3 Community License: territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax's written authorization; show \"MiniMax H3\" on the product's interface",
        "commercialWeights": True,
        "licenceNote": "Information for Settings → Models & licences, never a gate (the owner's decision of 2026-10-27). Hosted on fal under fal's terms and MiniMax's (docs/research/openjutsu-6.md §7)",
        "status": "active",
        "schemaUrl": "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3/reference-to-video/lora",
        "pageUrl": "https://fal.ai/models/minimax/h3/reference-to-video/lora",
        "pathAccepts": "URL or HuggingFace repo id (owner/repo) of the LoRA weights.",
    },
    "fal-ai/ltx-2.3-quality/hdr/lora": {
        "provider": "fal", "id": "fal-ai/ltx-2.3-quality/hdr/lora", "family": "LTX-2.3 quality", "op": "sdr-to-hdr",
        "roleForOriginals": "Upscale's SDR to HDR (build plan O11): the hosted LTX-2.3 HDR pass when LoRAs ride along (the plain fal-ai/ltx-2.3-quality/hdr otherwise)",
        "lora": {"field": "loras", "required": True, "itemFields": "transformer:string default=\"both\" enum=[\"high\", \"low\", \"both\"]; path:string; scale:number default=1 minimum=0 maximum=2", "maxCount": 3},
        "keyFieldsRequired": ["loras", "prompt", "video_url"],
        "price": "Your request will cost $0.0027075 per megapixel of generated HDR video data (width × height × frames), rounded up. For example, if you generate 121 HDR frames at 1280 × 720, your total generated output is ≈112 MP, and your request will cost $0.3032.",
        "baseLicence": "LTX-2 / LTX-2.x Community License",
        "commercialWeights": True,
        "licenceNote": "Free for companies under US$10M annual revenue; above that a paid licence (github.com/Lightricks/LTX-2 LICENSE-2, LICENSE-2_x, section 2.1). Information, never a gate",
        "status": "active",
        "schemaUrl": "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ltx-2.3-quality/hdr/lora",
        "pageUrl": "https://fal.ai/models/fal-ai/ltx-2.3-quality/hdr/lora",
        "pathAccepts": "Direct HTTP(S) download URL of the LoRA file (.safetensors). Max size: 3 GB.",
    },
}
BASE = {
    "fal-ai/ltx-2.3-22b/image-to-video": ("i2v", {**{k: v for k, v in LTX.items() if k != "loras"}, "image": "image_url", "endImage": "end_image_url"}),
    "fal-ai/ltx-2.3-22b/text-to-video": ("t2v", {k: v for k, v in LTX.items() if k != "loras"}),
    # Read so their routes send num_frames (the length picked), as the /lora variants do.
    # Extend keeps the clip's own size (video_size "auto"), so no aspect ratio is mapped.
    "fal-ai/ltx-2.3-22b/extend-video": ("extend", {**{k: v for k, v in LTX.items() if k not in ("loras", "aspectRatio")}, "video": "video_url", "endImage": "end_image_url"}),
    "fal-ai/ltx-2.3-22b/video-to-video": ("v2v", {**{k: v for k, v in LTX.items() if k != "loras"}, "video": "video_url"}),
    "fal-ai/flux-2/klein/4b": ("t2i", {k: v for k, v in KLEIN.items() if k != "loras"}),
    "fal-ai/flux-2/klein/4b/edit": ("edit", {**{k: v for k, v in KLEIN.items() if k != "loras"}, "images": "image_urls"}),
}
# Fuobe Genjutsu's hosted open routes (O5, research §8 genjutsu) and MiniMax's own person swap (openjutsu-6.md §8).
# Read with --base-only (they are added to hostedBaseEndpoints; the records above are kept as they are).
ANIMATE = {"video": "video_url", "image": "image_url", "seed": "seed", "resolution": "resolution"}
VACE14 = {"prompt": "prompt", "negativePrompt": "negative_prompt", "video": "video_url", "images": "ref_image_urls", "seed": "seed",
          "resolution": "resolution", "aspectRatio": "aspect_ratio", "fps": "frames_per_second"}
GENJUTSU = {
    "fal-ai/wan/v2.2-14b/animate/move": ("motion-transfer", ANIMATE),
    "fal-ai/wan/v2.2-14b/animate/replace": ("video-swap", ANIMATE),
    "fal-ai/scail-2": ("motion-transfer", {"prompt": "prompt", **ANIMATE}),
    "fal-ai/wan-motion": ("motion-transfer", {"prompt": "prompt", "video": "video_url", "image": "image_url", "seed": "seed"}),
    "fal-ai/wan-vace-14b/inpainting": ("video-swap", {**VACE14, "mask": "mask_video_url"}),
    "fal-ai/wan-22-vace-fun-a14b/depth": ("v2v", {**VACE14, "image": "first_frame_url"}),
    "minimax/h3-max/recast": ("video-swap", {"prompt": "prompt", "video": "video_url", "images": "reference_image_urls", "resolution": "resolution", "seed": "seed"}),
}

# Build plan O11 (rebranded open tools, Speak and finishing). Fuobe Angles' hosted half is fal's LoRA-gallery route of
# Qwen-Image-Edit 2509 with dx8152's Multiple-angles LoRA (camera fields, no prompt field); Fuobe Speak · Motion's is
# Wan 2.2 Speech-to-Video; the face mosaic's hosted step is SAM 3.1's image mask (the browser pixelates under it).
# Read with --base-only <ids> (added to hostedBaseEndpoints; the records above are kept as they are).
O11 = {
    "fal-ai/qwen-image-edit-2509-lora-gallery/multiple-angles": ("edit", {"images": "image_urls", "negativePrompt": "negative_prompt", "numOutputs": "num_images", "seed": "seed"}),
    "fal-ai/wan/v2.2-14b/speech-to-video": ("avatar", {"prompt": "prompt", "image": "image_url", "audio": "audio_url", "negativePrompt": "negative_prompt",
                                                      "resolution": "resolution", "numFrames": "num_frames", "fps": "frames_per_second", "seed": "seed"}),
    "fal-ai/sam-3-1/image": ("face-mosaic", {"prompt": "prompt", "image": "image_url"}),
}

# Partner models' fal routes that take over a route Fuobe dropped with its third cloud provider (build plan O7: Happy
# Horse 1.1 had no other route). Read with --partner; stored in partnerEndpoints, which gen-cloud-models.py reads.
HAPPY_HORSE = {"prompt": "prompt", "seed": "seed", "duration": "duration", "resolution": "resolution"}
PARTNER = {
    "alibaba/happy-horse/v1.1/text-to-video": ("t2v", {**HAPPY_HORSE, "aspectRatio": "aspect_ratio"}),
    "alibaba/happy-horse/v1.1/image-to-video": ("i2v", {**HAPPY_HORSE, "image": "image_url"}),
    "alibaba/happy-horse/v1.1/reference-to-video": ("ref2v", {**HAPPY_HORSE, "aspectRatio": "aspect_ratio", "images": "image_urls"}),
}

# Research part 4's records re-read with --part4 (build package nm10-kling-4: Kling 4.0's API opened after round 4 recorded
# it as playground-only). keyFields stay the record's own unless given here; a Replicate model is read by its latest version.
PART4 = {
    "kling/v4/text-to-video": None,
    "kling/v4/image-to-video": None,
    "kling/v4/reference-to-video": None,
    # The edit's reference clips (@Video2..) came after round 4 read it.
    "kling/v4/video-to-video/edit": {"prompt": "prompt", "video": "video_url", "images": "image_urls", "videos": "video_urls", "elements": "elements",
                                     "duration": "duration", "resolution": "resolution"},
    # One Replicate model for text, frames, references and edits. Fuobe routes its text, image and start/end-frame runs
    # there (its reference numbering, @image_1 across start, middle, end and reference images, and its lack of shots and
    # elements keep the reference and edit runs on fal); the edit's source is base_video.
    "replicate:kwaivgi/kling-v4.0": {"prompt": "prompt", "image": "start_image", "endImage": "end_image", "images": "reference_images",
                                     "video": "base_video", "duration": "duration", "resolution": "resolution", "aspectRatio": "aspect_ratio"},
}


# Research #10 (build package nm10-flux3-klein): FLUX 3 Image Klein on fal, read with --new10 into docs/research/new-models-10.json
# endpointRecords (part 4's record shape), and its two LoRA trainers into fuobe-originals-recipes-5.json trainers[] (gen-trainers.py's
# source). Klein reads a layout as fal's bounding_boxes (fractions of the picture) and turns prompt expansion off for one.
KLEIN_T2I = {"prompt": "prompt", "aspectRatio": "image_size", "seed": "seed", "numOutputs": "num_images",
             "enhancePrompt": "enable_prompt_expansion", "boundingBoxes": "bounding_boxes"}
KLEIN_EDIT = {**KLEIN_T2I, "images": "image_urls"}
KLEIN_LICENCE = ("FLUX Kommunity License v1.0: non-commercial use, plus commercial outputs for Qualifying Users under US$5M gross annual revenue "
                 "(affiliates included); other commercial use needs a BFL licence. Its commercial-use exception is not blanket permission for "
                 "commercial fine-tuning or distribution. The Qwen3-VL-4B-Instruct text encoder is Apache-2.0")
NEW10 = {
    "blackforestlabs/flux-3/klein/text-to-image": ("t2i", KLEIN_T2I, "FLUX 3 Klein", "FLUX.3 Klein"),
    "blackforestlabs/flux-3/klein/edit-image": ("edit", KLEIN_EDIT, "FLUX 3 Klein", "FLUX.3 Klein Image Editing"),
    "blackforestlabs/flux-3/klein/text-to-image/lora": ("t2i", {**KLEIN_T2I, "loras": "loras"}, "FLUX 3 Klein LoRA", "FLUX 3 Klein Text to Image LoRA"),
    "blackforestlabs/flux-3/klein/edit-image/lora": ("edit", {**KLEIN_EDIT, "loras": "loras"}, "FLUX 3 Klein LoRA", "FLUX 3 Klein Edit LoRA"),
    # Klein Base's plain routes (no LoRAs; planned per-image prices, $0.027 at 1K) and its /lora twins.
    "blackforestlabs/flux-3/klein/base/text-to-image": ("t2i", KLEIN_T2I, "FLUX 3 Klein Base", "FLUX.3 Klein Base (Text to Image)"),
    "blackforestlabs/flux-3/klein/base/edit-image": ("edit", KLEIN_EDIT, "FLUX 3 Klein Base", "FLUX.3 Klein Base (Image Editing)"),
    "blackforestlabs/flux-3/klein/base/text-to-image/lora": ("t2i", {**KLEIN_T2I, "loras": "loras"}, "FLUX 3 Klein Base LoRA", "FLUX 3 Klein Base Text to Image LoRA"),
    "blackforestlabs/flux-3/klein/base/edit-image/lora": ("edit", {**KLEIN_EDIT, "loras": "loras"}, "FLUX 3 Klein Base LoRA", "FLUX 3 Klein Base Edit LoRA"),
}
# new-models-10 §5: Speridlabs' Idol is hosted on fal since 2026-10-30 (speridlabs/idol; fal-ai/idol answers the same
# schema but has no catalog entry). One picture of one object -> a .ply splat (model_mesh), a point-cloud GLB preview (model_glb) and the
# cut-out it saw (preprocessed_image). image_type "real" is Idol's looser photo crop (1.7), "synthetic" its default (1.2).
NEW10_SPLATS = {
    "speridlabs/idol": {
        "family": "idol", "model": "Idol", "title": "Sperid Labs Idol", "vendor": "Speridlabs",
        "keyFields": {"image": "image_url", "numGaussians": "num_gaussians", "steps": "num_inference_steps", "cfg": "guidance_scale", "seed": "seed", "imageType": "image_type"},
        "license": "Apache-2.0 (speridlabs/idol weights); TripoSplat's architecture (MIT); DINOv3 image encoder under the DINOv3 License (\"Built with DINOv3\")",
        "notes": ("Idol (TripoSplat's architecture, retrained by Speridlabs): one image of one object -> model_mesh, a 3D Gaussian splat (.ply), "
                  "model_glb (a coloured point cloud of the splat centres, for standard 3D viewers), preprocessed_image (the cut-out it saw) and the "
                  "predicted camera. num_inference_steps 1-50 (default 50), num_gaussians 32,768-1,048,576 (default 262,144), guidance_scale 0-10 "
                  "(default 3, Idol's own weight: ComfyUI cfg 4), image_type synthetic | real. No sampler choice and no output format choice."),
    },
}
NEW10_TRAINERS = {
    "blackforestlabs/flux-3/klein/base/trainer": ("FLUX 3 Klein base", "Soul ID on FLUX 3 Image Klein (nm10-flux3-klein; FLUX Kommunity licence, shown as information)"),
    "blackforestlabs/flux-3/klein/base/trainer/edit": ("FLUX 3 Klein base", "Edit LoRAs from before / after pairs on FLUX 3 Image Klein (recorded; Soul ID trains subjects with the plain trainer)"),
}

# Research #10 (build package nm10-keying): Bria's green-screen key with despill and its guided cut-out on fal, read with --keying
# into docs/research/new-models-10.json endpointRecords (part 4's record shape). Both are Bria's own hosted models (proprietary).
KEYING = {
    "bria/video/background-removal/green-screen-despill": (
        "bg-remove-video", {"video": "video_url"}, "Bria green-screen despill", "Bria Video Background Removal: Green Screen Despill",
        "Chroma (green-screen) footage keyed onto a transparent background with the green spill pulled out of the edges. spill_suppression 0-1 "
        "(1 by default, 0 turns it off); output_container_and_codec webm_vp9 keeps the transparency (a codec that can't carry alpha falls back "
        "to black and says so in warning); preserve_audio keeps the sound. Released 2026-08-27."),
    "bria/guided-remove-background": (
        "bg-remove", {"image": "image_url", "prompt": "prompt"}, "Bria guided cut-out", "Bria Guided Remove Background",
        "The photo's obvious subject cut out (the original pixels with a new alpha, RGBA PNG), adjusted by plain words: add something ('the "
        "person with the mat'), drop something ('without the lamp') or narrow it ('only the chair'). The prompt is optional (empty = the plain "
        "cut-out); autocrop tightens the canvas to what is kept. Released 2026-10-10."),
}


# Research #10: full songs in the cloud, read with --music into new-models-10.json endpointRecords.
# MiniMax Music 3 is the same open model the open engine runs (its weights' own licence and the Comfy-Org repack's tag are
# both recorded); Mureka, ElevenLabs and Lyria are proprietary APIs. Mureka's song tools take a song_id from one of its own
# answers or an id from its files/upload (purpose "audio" / "remix"); its stems take a plain URL and answer with a zip.
MM3_LICENCE = ("MiniMax-Music3 Community License (MiniMaxAI/MiniMax-Music3 @ 1b525ccb, LICENSE read 2026-11-01): an MIT-style grant with the notice "
               "kept, use within the law and its Acceptable Use Policy (Exhibit A); commercial products show \"MiniMax-Music3\" in their interface and "
               "need MiniMax's written authorisation above US$20M yearly revenue; a hosted service keeps safeguards against infringing outputs. "
               "The Comfy-Org repack (Comfy-Org/MiniMax-Music-3 @ 9e364ccd) is tagged Apache-2.0 on Hugging Face; the weights' own licence is the one above")
MUREKA_NOTE = "Proprietary hosted API (Mureka on fal); songs come back with a song_id the song tools (extend, remix, edit) take"
MUSIC10 = {
    # endpoint: (op, keyFields, family, model, vendor, licence or note)
    "minimax/music-3": ("music", {"prompt": "prompt", "lyrics": "lyrics", "duration": "duration", "seed": "seed"}, "minimax-music", "MiniMax Music 3", "MiniMax", MM3_LICENCE),
    "mureka/v9.5/generate/song": ("music", {"prompt": "prompt", "lyrics": "lyrics", "duration": "duration"}, "mureka", "Mureka 9.5", "Mureka", MUREKA_NOTE),
    "mureka/v9/generate/song": ("music", {"prompt": "prompt", "lyrics": "lyrics"}, "mureka", "Mureka 9", "Mureka", MUREKA_NOTE),
    "mureka/v9.5/generate/instrumental": ("music", {"prompt": "prompt"}, "mureka", "Mureka 9.5 Instrumental", "Mureka", MUREKA_NOTE),
    "mureka/v9/generate/instrumental": ("music", {"prompt": "prompt"}, "mureka", "Mureka 9 Instrumental", "Mureka", MUREKA_NOTE),
    # Recorded: a soundtrack reads a picture or a clip by an id from mureka/api/files/upload (purpose "soundtrack").
    "mureka/v9.5/generate/soundtrack": ("v2a", {"prompt": "prompt"}, "mureka", "Mureka 9.5 Soundtrack", "Mureka", MUREKA_NOTE),
    "mureka/v9/generate/soundtrack": ("v2a", {"prompt": "prompt"}, "mureka", "Mureka 9 Soundtrack", "Mureka", MUREKA_NOTE),
    "mureka/v8/song/extend": ("song-extend", {"lyrics": "lyrics", "songId": "song_id", "uploadId": "upload_audio_id", "extendAt": "extend_at"}, "mureka", "Mureka 8 Extend", "Mureka", MUREKA_NOTE),
    "mureka/v8/song/remix": ("song-remix", {"prompt": "prompt", "lyrics": "lyrics", "songId": "song_id", "uploadId": "upload_audio_id"}, "mureka", "Mureka 8 Remix", "Mureka", MUREKA_NOTE),
    "mureka/api/song/stem": ("song-stems", {"audio": "audio_url"}, "mureka", "Mureka stems", "Mureka", MUREKA_NOTE),
    "mureka/api/files/upload": ("upload", {"file": "file_url", "purpose": "purpose"}, "mureka", "Mureka file upload", "Mureka", MUREKA_NOTE),
    # Recorded only: an edit of a region's words, voice cloning ($5 a voice) and the lyrics writer.
    "mureka/api/song/edit": ("song-edit", {"lyrics": "lyrics", "songId": "song_id", "uploadId": "upload_audio_id"}, "mureka", "Mureka song edit", "Mureka", MUREKA_NOTE),
    "mureka/api/voice/clone": ("voice-clone", {"audio": "audio_url"}, "mureka", "Mureka voice clone", "Mureka", MUREKA_NOTE),
    "mureka/api/generate/lyrics": ("write", {"prompt": "prompt"}, "mureka", "Mureka lyrics", "Mureka", MUREKA_NOTE),
    # The route Fuobe called before (a version field; 9.5's duration); fal's catalog lists it with no metadata now.
    "mureka/api/generate/song": ("music", {"prompt": "prompt", "lyrics": "lyrics", "duration": "duration"}, "mureka", "Mureka song (versioned)", "Mureka", MUREKA_NOTE),
    "elevenlabs/music/v2.5": ("music", {"prompt": "prompt", "duration": "music_length_ms"}, "elevenlabs", "ElevenLabs Music v2.5", "ElevenLabs",
                              "Proprietary hosted API; billed per output minute, rounded up; lyrics go in a composition plan of timed chunks (recorded, not sent)"),
    "google/lyria-3.5": ("music", {"prompt": "prompt", "image": "image_url", "lyricsInPrompt": "prompt"}, "lyria", "Lyria 3.5", "Google",
                         "Proprietary hosted API; lyrics and section timings go in the prompt (its description says so)"),
}


def music10(ids):
    """Research #10's music records (MUSIC10) in new-models-10.json endpointRecords; only those named in `ids` when it names any."""
    path = ROOT / "docs/research/new-models-10.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    records = {e["endpoint"]: e for e in data.get("endpointRecords") or []}
    for ep, (op, kf, family, model, vendor, licence) in MUSIC10.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        missing = [f for f in kf.values() if f not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        root = json.loads(get(f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}"))
        result = root["paths"][f"/{ep}/requests/{{request_id}}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
        outputs = list(resolve(result, root).get("properties") or {})
        price = llms_price(ep)
        records[ep] = {
            "family": family, "model": model, "title": model, "vendor": vendor, "operation": op, "provider": "fal", "endpoint": ep,
            "falCategory": "text-to-audio", "status": fal_catalog_status(ep), "keyFields": kf, "inputs": inputs,
            "output": "zip_url" if "zip_url" in outputs else ("id" if op == "upload" else "audio.url"), "outputFields": outputs,
            "price": price, "license": licence, "verified": True, "sourceUrl": f"https://fal.ai/models/{ep}",
            "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}", "capability": op, "fetched": TODAY,
        }
        print(f"{ep}: {records[ep]['status']}, {len(inputs)} inputs, out {outputs}, {price}")
    data["endpointRecords"] = list(records.values())
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# Hosted catch-up: fal's September-October MiniMax H3 Max tools (lip sync, relight, insert,
# five looks), H3 Max Turbo, Vidu Q4, Meshy retexture and Tripo P2, and Replicate's H3 Lite and HighSpeed, read with --catchup
# into docs/research/new-models-10.json endpointRecords (part 4's record shape; gen-cloud-models.py merges them last).
# Values: (operation, keyFields, vendor, model, notes).
H3_STYLE = {"prompt": "prompt", "image": "image_url", "duration": "duration", "aspectRatio": "aspect_ratio", "seed": "seed"}
H3_TURBO = {"prompt": "prompt", "duration": "duration", "resolution": "resolution", "seed": "seed"}
H3_REPLICATE = {"prompt": "prompt", "image": "first_frame_image", "endImage": "last_frame_image", "images": "reference_image_urls",
                "video": "reference_video_urls", "audio": "reference_audio_urls", "duration": "duration", "aspectRatio": "ratio"}
CATCHUP = {
    "minimax/h3-max/lip-sync/image-to-video": ("avatar", {"image": "image_url", "audio": "audio_url", "resolution": "resolution", "seed": "seed"},
                                               "MiniMax", "MiniMax H3 Max Lip Sync", "Image (aspect 0.4-2.5) + 5 s to 15 min of audio; the video is as long as the audio. Billed per second, x1.2 over 15 s."),
    "minimax/h3-max/relight": ("relight-video", {"video": "video_url", "image": "reference_image_url", "resolution": "resolution", "aspectRatio": "aspect_ratio", "seed": "seed"},
                               "MiniMax", "MiniMax H3 Max Relight", "reference_image_url is a render of a lit sphere showing the target light (Fuobe draws it in the browser from its light presets). Source up to 15 s, resampled to 24 fps and trimmed to 17n+5 frames, at least 56."),
    "minimax/h3-max/insert-video": ("insert-moment", {"prompt": "prompt", "video": "video_url", "images": "reference_image_urls", "videos": "reference_video_urls",
                                                      "startTime": "start_time", "endTime": "resume_time", "duration": "duration", "resolution": "resolution", "seed": "seed"},
                                    "MiniMax", "MiniMax H3 Max Insert Video", "A new scene of `duration` seconds generated between start_time and resume_time of the clip (both within 60 s, start at least 1.625 s); only the new scene is billed."),
    **{f"minimax/h3-max/styles/{s}": ("t2v+i2v", {**H3_STYLE, **({"damageLevel": "damage_level"} if s == "vhs" else {})}, "MiniMax", f"MiniMax H3 Max {t}",
                                      "Text or a first frame to a 5-15 s clip in the look, with sound; generation, not a restyle of a clip.")
       for s, t in (("16bit-pixel", "16-bit Pixel"), ("hand-drawn", "Hand-drawn"), ("low-poly", "Low Poly"), ("retro-toon-70s", "Retro Toon 70s"), ("vhs", "VHS"))},
    "minimax/h3-max-turbo/text-to-video": ("t2v", {**H3_TURBO, "aspectRatio": "aspect_ratio"}, "MiniMax", "MiniMax H3 Max Turbo", None),
    "minimax/h3-max-turbo/image-to-video": ("i2v", {**H3_TURBO, "image": "image_url", "endImage": "end_image_url"}, "MiniMax", "MiniMax H3 Max Turbo", None),
    "minimax/h3-max-turbo/reference-to-video": ("ref2v", {**H3_TURBO, "aspectRatio": "aspect_ratio", "images": "reference_image_urls", "video": "reference_video_urls",
                                                          "audio": "reference_audio_urls"}, "MiniMax", "MiniMax H3 Max Turbo",
                                                "Billed at H3 Max's own rates ($0.05-0.16/s), not Turbo's; references (images, clips, audio) add up to 12 files."),
    "minimax/h3-max-turbo/extend-video": ("extend", {"prompt": "prompt", "video": "video_url", "audio": "reference_audio_urls", "duration": "duration", "resolution": "resolution",
                                                     "aspectRatio": "aspect_ratio", "seed": "seed"}, "MiniMax", "MiniMax H3 Max Turbo",
                                          "Source 1.625-60 s, up to 50 MB; duration is the seconds added, and only they are billed."),
    "fal-ai/vidu/q4/image-to-video": ("i2v", {"prompt": "prompt", "image": "image_url", "duration": "duration", "resolution": "resolution", "seed": "seed"}, "Shengshu", "Vidu Q4", None),
    "fal-ai/vidu/q4/reference-to-video": ("ref2v", {"prompt": "prompt", "images": "reference_image_urls", "audios": "reference_audio_urls", "duration": "duration",
                                                   "aspectRatio": "aspect_ratio", "resolution": "resolution", "generateAudio": "audio", "seed": "seed"}, "Shengshu", "Vidu Q4",
                                          "fal exposes up to 12 reference images and 3 mp3 voice clips (3-12 s), sound on request; Vidu's own 15 images and 4K references are not all in fal's schema."),
    "meshy/v7/retexture": ("retexture-3d", {"model3d": "model_url", "prompt": "text_style_prompt", "image": "image_style_url"}, "Meshy", "Meshy 7 Retexture", None),
    "meshy/v6/retexture": ("retexture-3d", {"model3d": "model_url", "prompt": "text_style_prompt", "image": "image_style_url"}, "Meshy", "Meshy 6 Retexture", None),
    "tripo3d/p2/image-to-3d": ("image-to-3d", {"image": "image_url"}, "Tripo", "Tripo P2", None),
    "replicate:minimax/h3-lite": ("t2v+i2v+flf2v+ref2v", {**H3_REPLICATE, "resolution": "resolution"}, "MiniMax", "MiniMax H3 Lite", None),
    "replicate:minimax/h3-highspeed": ("t2v+i2v+flf2v+ref2v", H3_REPLICATE, "MiniMax", "MiniMax H3 HighSpeed", None),
}


def get(url, tries=5):
    req = urllib.request.Request(url, headers={"User-Agent": "fuobe-research/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        # fal's catalog API answers 429 to a burst of reads: wait and try again.
        if e.code != 429 or tries <= 1:
            raise
        time.sleep(15)
        return get(url, tries - 1)


def resolve(schema, root):
    while isinstance(schema, dict) and "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        schema = root["components"]["schemas"][name]
    return schema


def spec(p, root, required=False):
    """One OpenAPI property in the research files' shape (type, values, default, minimum…, desc)."""
    p = resolve(p, root)
    out = {}
    variants = p.get("anyOf") or p.get("oneOf")
    if variants:
        real = [resolve(v, root) for v in variants if resolve(v, root).get("type") != "null"]
        if len(real) < len(variants):
            out["nullable"] = True
        if len(real) == 1:
            out.update(spec({**real[0], **{k: v for k, v in p.items() if k not in ("anyOf", "oneOf")}}, root))
        else:
            out["type"] = "union"
            out["variants"] = [spec(v, root) for v in real]
    elif "enum" in p:
        out.update({"type": "enum", "values": p["enum"], "valueType": p.get("type", "string")})
    elif p.get("type") == "array":
        items = resolve(p.get("items") or {}, root)
        out["type"] = "array"
        if items.get("type") == "object" or "properties" in items:
            out["items"] = "object"
            out["itemSchema"] = {k: spec(v, root) for k, v in (items.get("properties") or {}).items()}
            if items.get("required"):
                out["itemRequired"] = items["required"]
        else:
            out["items"] = items.get("type", "string")
        for k in ("minItems", "maxItems"):
            if k in p:
                out[k] = p[k]
    elif p.get("type") == "object" or "properties" in p:
        out["type"] = "object"
        out["fields"] = {k: spec(v, root) for k, v in (p.get("properties") or {}).items()}
    else:
        out["type"] = p.get("type", "string") + (f"({p['format']})" if p.get("format") == "uri" else "")
    if required:
        out["required"] = True
    elif "type" in out and out["type"] not in ("union",) and "required" not in out:
        out["required"] = False
    for src, dst in (("default", "default"), ("minimum", "minimum"), ("maximum", "maximum"), ("exclusiveMinimum", "minimumExclusive"), ("exclusiveMaximum", "maximumExclusive"),
                     ("minLength", "minLength"), ("maxLength", "maxLength")):
        if src in p:
            out[dst] = p[src]
    if p.get("nullable"):
        out["nullable"] = True
    # fal states a file's limits (size, sides, length, frame rate) in limit_description; research part 4 kept them in desc.
    limits = p.get("limit_description")
    desc = p.get("description") or ""
    if limits and limits not in desc:
        desc = f"{desc}\n\n{limits}" if desc else limits
    if desc:
        out["desc"] = desc
    if p.get("examples"):
        out["examples"] = p["examples"][:1]
    return out


def inputs_of(root, schema):
    schema = resolve(schema, root)
    req = set(schema.get("required") or [])
    order = schema.get("x-fal-order-properties") or sorted(schema.get("properties") or {}, key=lambda k: (schema["properties"][k].get("x-order", 999), k))
    props = schema.get("properties") or {}
    return {k: spec(props[k], root, k in req) for k in order if k in props}


def fal(endpoint):
    root = json.loads(get(f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={endpoint}"))
    post = root["paths"][f"/{endpoint}"]["post"]
    schema = post["requestBody"]["content"]["application/json"]["schema"]
    return inputs_of(root, schema)


def replicate(slug, version):
    page = get(f"https://replicate.com/{slug}/api/schema")
    for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', page, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        v = data.get("version") if isinstance(data, dict) else None
        if isinstance(v, dict) and v.get("id") == version:
            root = v["_extras"]["dereferenced_openapi_schema"]
            return inputs_of(root, root["components"]["schemas"]["Input"])
    raise SystemExit(f"{slug}: version {version} not found on its schema page")


def replicate_latest(slug):
    """A Replicate model's latest version: its inputs (dereferenced OpenAPI) and the version's id and date."""
    page = get(f"https://replicate.com/{slug}/api/schema")
    for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', page, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        v = data.get("version") if isinstance(data, dict) else None
        if isinstance(v, dict) and (v.get("_extras") or {}).get("dereferenced_openapi_schema"):
            root = v["_extras"]["dereferenced_openapi_schema"]
            return inputs_of(root, root["components"]["schemas"]["Input"]), v.get("id"), (v.get("created_at") or "")[:10]
    raise SystemExit(f"{slug}: no version schema on its page")


def replicate_prices(slug):
    """Replicate's billing tiers for a model, one line each ("720p, text or image input: $0.157 per second of output video")."""
    page = get(f"https://replicate.com/{slug}")
    m = re.search(r'"billingConfig":\s*(\{.*?"current_tiers":\s*\[.*?\]\})', page, re.S)
    if not m:
        return None
    try:
        tiers = json.loads(m.group(1))["current_tiers"]
    except (json.JSONDecodeError, KeyError):
        return None
    lines = []
    for t in tiers:
        for pr in t.get("prices") or []:
            what = t.get("title") or ""
            if t.get("description") and t.get("description") != what:
                what = f"{what} ({t['description']})" if what else t["description"]
            lines.append(f"{what}: {pr.get('price')} {pr.get('title')}")
    return "; ".join(lines) or None


def fal_catalog_status(endpoint):
    """fal's catalog status of an endpoint (active, deprecated…), or "unlisted"."""
    data = json.loads(get(f"https://api.fal.ai/v1/models?endpoint_id={endpoint}"))
    hits = [x for x in data.get("models") or [] if x.get("endpoint_id") == endpoint]
    return ((hits[0].get("metadata") or {}).get("status") or "active") if hits else "unlisted"


def part4(ids):
    """Refresh research part 4's records (PART4) in docs/research/paid-model-apis-4.json, keeping the rest as they are."""
    path = ROOT / "docs/research/paid-model-apis-4.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    by_key = {(e["provider"], e["endpoint"]): e for e in data["endpoints"]}
    for key, kf in PART4.items():
        if ids and key not in ids and key.split(":", 1)[-1] not in ids:
            continue
        provider, ep = key.split(":", 1) if key.startswith("replicate:") else ("fal", key)
        rec = by_key.get((provider, ep))
        if provider == "fal":
            if not rec:
                sys.exit(f"{ep} is not in paid-model-apis-4.json")
            rec["inputs"] = fal(ep)
            page = get(f"https://fal.ai/models/{ep}/llms.txt")
            listed = fal_catalog_status(ep)
            # Round 4's own status: the page says the API isn't open yet.
            rec["status"] = "playground-only" if re.search(r"API access is coming soon", page, re.I) else listed
            # The "## Pricing" section only (the page's later lines price fal's own GPUs).
            section = re.search(r"(?ims)^## Pricing\s*$(.*?)(?=^## |\Z)", page)
            lines = [l.replace("**", "").strip(" -*") for l in (section.group(1) if section else "").splitlines()]
            rec["price"] = " ".join(l for l in lines if "$" in l) or rec.get("price")
        else:
            inputs, version, created = replicate_latest(ep)
            if not rec:
                rec = {"family": ep.split("/")[1].split("-v")[0], "model": ep, "title": ep, "vendor": "Kuaishou" if ep.startswith("kwaivgi/") else ep.split("/")[0],
                       "operation": "t2v+i2v+flf2v+v2v", "provider": "replicate", "endpoint": ep, "falCategory": None}
                data["endpoints"].append(rec)
            rec.update({"status": "active", "inputs": inputs, "version": version, "versionDate": created, "output": "output",
                        "price": replicate_prices(ep), "verified": True, "sourceUrl": f"https://replicate.com/{ep}",
                        "apiUrl": f"https://api.replicate.com/v1/models/{ep}/predictions"})
        if kf:
            rec["keyFields"] = kf
        missing = [f for f in (rec.get("keyFields") or {}).values() if f.split(".")[0] not in rec["inputs"]]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        rec["checked"] = TODAY
        print(f"{provider}:{ep}: {rec['status']}, {len(rec['inputs'])} inputs")
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def fal_price(endpoint):
    text = get(f"https://fal.ai/models/{endpoint}/llms.txt")
    m = re.search(r"(?im)^.*\$\d[^\n]*$", text)
    return re.sub(r"^(Price:\s*)", "", m.group(0).replace("**", "").strip(" -*")) if m else None


def fal_prices(endpoint):
    """Every price line of an endpoint's llms.txt, joined (per-resolution tables list one line per tier)."""
    text = get(f"https://fal.ai/models/{endpoint}/llms.txt")
    lines = [re.sub(r"^(Price:\s*)", "", m.replace("**", "").strip(" -*")) for m in re.findall(r"(?im)^.*\$\d[^\n]*$", text)]
    lines = [l for l in lines if "FAL_KEY" not in l and "curl" not in l]
    return "; ".join(dict.fromkeys(lines[:6])) or None


# What an answer holds when it's neither pictures (t2i, edit) nor a video: SAM 3.1's face masks (the face mosaic).
OUTPUT_OF = {"face-mosaic": "masks[].url"}


def base_record(ep, op, kf, price=None):
    inputs = fal(ep)
    missing = [f for f in kf.values() if f not in inputs]
    if missing:
        sys.exit(f"{ep}: keyFields {missing} are not inputs")
    print(f"{ep}: {len(inputs)} inputs")
    return {"provider": "fal", "endpoint": ep, "operation": op, "status": "active", "inputs": inputs, "keyFields": kf,
            "output": OUTPUT_OF.get(op) or ("images[].url" if op in ("t2i", "edit") else "video.url"), "price": price if price is not None else fal_price(ep), "verified": True,
            "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}", "checked": TODAY}


def trainer_outputs(data):
    """Record which response fields of each fal trainer hold LoRA files (File fields named *lora*)."""
    for t in data["trainers"]:
        if t.get("provider") != "fal":
            continue
        ep = t["id"]
        root = json.loads(get(f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}"))
        result = root["paths"][f"/{ep}/requests/{{request_id}}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
        props = resolve(result, root).get("properties") or {}
        files = []
        for name, p in props.items():
            refs = [p] + list(p.get("anyOf") or p.get("allOf") or [])
            if any(resolve(r, root).get("title") == "File" or str(r.get("$ref", "")).endswith("/File") for r in refs if isinstance(r, dict)):
                # Configs, debug datasets and validation samples (LTX's video / audio) aren't LoRAs.
                if "lora" in name:
                    files.append(name)
        t["loraOutput"] = files
        t["outputChecked"] = TODAY
        print(f"{ep}: {files}")


def llms_price(ep):
    """The "## Pricing" section of an endpoint's llms.txt, in one line (its later lines price fal's own GPUs)."""
    page = get(f"https://fal.ai/models/{ep}/llms.txt")
    section = re.search(r"(?ims)^## Pricing\s*$(.*?)(?=^## |\Z)", page)
    lines = [l.replace("**", "").strip(" -*") for l in (section.group(1) if section else "").splitlines()]
    return " ".join(l for l in lines if "$" in l) or None


def trainer_field(s):
    """One OpenAPI field as the trainers[] records write it: "integer default=1000 minimum=100 maximum=10000", enums kept."""
    t = s.get("valueType") if s.get("type") == "enum" else s.get("type", "string")
    out = [str(t).replace("(uri)", "")]
    if "default" in s:
        out.append(f"default={json.dumps(s['default'])}")
    if s.get("type") == "enum":
        out.append(f"enum={json.dumps(s.get('values'))}")
    for k in ("minimum", "maximum"):
        if k in s:
            out.append(f"{k}={s[k]}")
    return " ".join(out)


def new10(ids):
    """Research #10's FLUX 3 Klein records: its fal endpoints (endpointRecords in new-models-10.json) and LoRA trainers; only
    the endpoints or trainers named in `ids` when it names any, the rest kept as they are."""
    path = ROOT / "docs/research/new-models-10.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    records = {e["endpoint"]: e for e in data.get("endpointRecords") or []}
    for ep, (op, kf, model, title) in NEW10.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        missing = [f for f in kf.values() if f not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        price = llms_price(ep)
        per_mp = re.search(r"\$(\d+(?:\.\d+)?) per megapixel", price or "")
        # "$0.009 at 1K" (Klein's) or "1K: $0.027" (Klein Base's plain routes).
        tiers = re.findall(r"\$(\d+(?:\.\d+)?) at (\d+(?:\.\d+)?K)\b", price or "") or [
            (v, k) for k, v in re.findall(r"\b(\d+(?:\.\d+)?K): \$(\d+(?:\.\d+)?)", price or "")]
        if per_mp:
            pricing = {"usd": float(per_mp.group(1)), "unit": "megapixel"}
        elif tiers:
            by_res = {k: float(v) for v, k in tiers}
            pricing = {"usd": by_res.get("1K", float(tiers[0][0])), "unit": "image", "byResolution": by_res}
        else:
            pricing = {"usd": None, "unit": "unknown"}
        records[ep] = {
            "family": "flux-3-klein", "model": model, "title": title, "vendor": "Black Forest Labs", "operation": op, "provider": "fal", "endpoint": ep,
            "falCategory": "text-to-image" if op == "t2i" else "image-to-image", "status": fal_catalog_status(ep), "keyFields": kf,
            "inputs": inputs, "output": "images[].url", "price": price, "pricing": pricing, "license": KLEIN_LICENCE,
            "notes": ("Send enable_prompt_expansion false with a Fuobe layout; the boxes go as bounding_boxes ({box: {x_min, y_min, x_max, y_max} as 0-1 "
                      "fractions, label, description}), the prompt naming each box as <label>. image_size takes 256-4096 px a side."),
            "verified": True, "sourceUrl": f"https://fal.ai/models/{ep}", "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}",
            "capability": op, "fetched": TODAY,
        }
        print(f"{ep}: {records[ep]['status']}, {len(inputs)} inputs, {price}")
    for ep, meta in NEW10_SPLATS.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        missing = [f for f in meta["keyFields"].values() if f not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        price = llms_price(ep) or fal_price(ep)
        usd = re.search(r"\$(\d+(?:\.\d+)?)", price or "")
        records[ep] = {
            "family": meta["family"], "model": meta["model"], "title": meta["title"], "vendor": meta["vendor"], "operation": "image-to-splat",
            "provider": "fal", "endpoint": ep, "falCategory": "image-to-3d", "status": fal_catalog_status(ep), "keyFields": meta["keyFields"],
            "inputs": inputs, "output": "model_mesh.url", "price": price,
            "pricing": {"usd": float(usd.group(1)), "unit": "request"} if usd else {"usd": None, "unit": "unknown"},
            "license": meta["license"], "notes": meta["notes"], "verified": True, "sourceUrl": f"https://fal.ai/models/{ep}",
            "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}", "capability": "splat", "fetched": TODAY,
        }
        print(f"{ep}: {records[ep]['status']}, {len(inputs)} inputs, {price}")
    data["endpointRecords"] = list(records.values())
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    # The trainers, in trainers[] of the Originals research (scripts/gen-trainers.py reads it).
    raw = json.loads(FILE.read_text(encoding="utf-8"))
    by_id = {t["id"]: t for t in raw["trainers"]}
    for ep, (family, role) in NEW10_TRAINERS.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        root = json.loads(get(f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}"))
        result = root["paths"][f"/{ep}/requests/{{request_id}}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
        lora_out = [k for k in (resolve(result, root).get("properties") or {}) if "lora" in k]
        rec = by_id.get(ep) or {"provider": "fal", "id": ep}
        rec.update({
            "family": family, "role": role, "required": [k for k, s in inputs.items() if s.get("required")],
            "fields": {k: trainer_field(s) for k, s in inputs.items()}, "price": llms_price(ep),
            "baseLicence": "FLUX Kommunity License v1.0 (non-commercial; commercial outputs for Qualifying Users under US$5M revenue)",
            "commercialWeights": None,
            "licenceNote": "Not blanket permission for commercial fine-tuning or distribution (the model card); information, never a gate",
            "status": fal_catalog_status(ep), "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}", "checked": TODAY,
            "loraOutput": lora_out, "outputChecked": TODAY,
        })
        if ep not in by_id:
            raw["trainers"].append(rec)
        print(f"{ep}: {rec['status']}, fields {list(rec['fields'])}, LoRA in {lora_out}, {rec['price']}")
    FILE.write_text(json.dumps(raw, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def keying(ids):
    """nm10-keying's Bria records (endpointRecords in new-models-10.json); only those named in `ids` when it names any."""
    path = ROOT / "docs/research/new-models-10.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    records = {(e.get("provider", "fal"), e["endpoint"]): e for e in data.get("endpointRecords") or []}
    for ep, (op, kf, model, title, notes) in KEYING.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        missing = [f for f in kf.values() if f not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        price = llms_price(ep)
        m = re.search(r"\$(\d+(?:\.\d+)?) per (second|image)", price or "")
        pricing = {"usd": float(m.group(1)), "unit": m.group(2)} if m else {"usd": None, "unit": "unknown"}
        records[("fal", ep)] = {
            "family": "bria", "model": model, "title": title, "vendor": "Bria", "operation": op, "provider": "fal", "endpoint": ep,
            "falCategory": "video-to-video" if op == "bg-remove-video" else "image-to-image", "status": fal_catalog_status(ep), "keyFields": kf,
            "inputs": inputs, "output": "video.url" if op == "bg-remove-video" else "image.url", "price": price, "pricing": pricing,
            "license": "Bria's hosted model (proprietary; used through fal's API)", "notes": notes,
            "verified": True, "sourceUrl": f"https://fal.ai/models/{ep}", "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}",
            "capability": op, "fetched": TODAY,
        }
        print(f"{ep}: {records[('fal', ep)]['status']}, {len(inputs)} inputs, {price}")
    data["endpointRecords"] = list(records.values())
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def catchup(ids):
    """The hosted catch-up records (CATCHUP) in new-models-10.json endpointRecords: inputs, price lines and catalog status read at
    the source; only those named in `ids` when it names any, the rest kept as they are."""
    path = ROOT / "docs/research/new-models-10.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    records = {(e["provider"], e["endpoint"]): e for e in data.get("endpointRecords") or []}
    for key, (op, kf, vendor, model, notes) in CATCHUP.items():
        provider, ep = key.split(":", 1) if key.startswith("replicate:") else ("fal", key)
        if ids and key not in ids and ep not in ids:
            continue
        rec = {"family": ep.split("/")[1].split("-v")[0] if provider == "replicate" else ep.split("/")[1], "model": model, "title": model, "vendor": vendor,
               "operation": op, "provider": provider, "endpoint": ep, "keyFields": kf, "licence": "proprietary paid API", "verified": True, "fetched": TODAY}
        if provider == "fal":
            inputs = fal(ep)
            rec.update({"status": fal_catalog_status(ep), "inputs": inputs, "price": llms_price(ep),
                        "output": {"retexture-3d": "model_glb.url", "image-to-3d": "model_mesh.url"}.get(op, "video.url"),
                        "sourceUrl": f"https://fal.ai/models/{ep}", "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}"})
        else:
            inputs, version, created = replicate_latest(ep)
            rec.update({"status": "active", "inputs": inputs, "version": version, "versionDate": created, "price": replicate_prices(ep), "output": "output",
                        "sourceUrl": f"https://replicate.com/{ep}", "apiUrl": f"https://api.replicate.com/v1/models/{ep}/predictions"})
        if notes:
            rec["notes"] = notes
        missing = [f for f in kf.values() if f.split(".")[0] not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        records[(provider, ep)] = rec
        print(f"{provider}:{ep}: {rec['status']}, {len(inputs)} inputs, {rec['price']}")
        # Saved after each record, so a refusal part way keeps what was read.
        data["endpointRecords"] = list(records.values())
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# Research #10 (build package nm10-kandinsky6): Kandinsky 6.0 Pro and Lite (text / image to video with sound) and the
# Kandinsky VSR upscaler on fal, read with --kandinsky6 into new-models-10.json endpointRecords. Part 4 recorded Pro and the
# VSR (paid-model-apis-4.json); Lite came after it (2026-10-05). Each record's pricing is parsed from its llms.txt: the price
# of a 5 s 480p clip at each step count fal names (Pro 8 / 20 / 50, Lite 4 / 10 / 16), or per output megapixel per frame.
K6_GEN = {"prompt": "prompt", "aspectRatio": "aspect_ratio", "generateAudio": "generate_audio", "seed": "seed", "steps": "num_inference_steps",
          "enhancePrompt": "enable_prompt_expansion"}
K6_VSR = {"video": "video_url", "scale": "upscale_factor", "steps": "num_inference_steps", "seed": "seed"}
K6_LICENCE = ("MIT (Kandinsky 6.0 weights, kandinskylab/Kandinsky-6.0-*-Diffusers model cards); the Qwen2.5-VL 7B text encoder is Apache-2.0, "
              "the BigVGAN v2 vocoder MIT (NVIDIA), the MMAudio audio VAE MIT")
KANDINSKY6 = {
    "fal-ai/kandinsky6-pro/text-to-video": ("t2v", {**K6_GEN, "negativePrompt": "negative_prompt"}, "Kandinsky 6.0 Pro", "pro"),
    "fal-ai/kandinsky6-pro/image-to-video": ("i2v", {**K6_GEN, "negativePrompt": "negative_prompt", "image": "image_url"}, "Kandinsky 6.0 Pro", "pro"),
    "fal-ai/kandinsky6-lite/text-to-video": ("t2v", K6_GEN, "Kandinsky 6.0 Lite", "lite"),
    "fal-ai/kandinsky6-lite/image-to-video": ("i2v", {**K6_GEN, "image": "image_url"}, "Kandinsky 6.0 Lite", "lite"),
    "fal-ai/kandinsky6-vsr": ("upscale-video", K6_VSR, "Kandinsky 6.0 VSR", "vsr"),
    "fal-ai/kandinsky6-vsr/lite": ("upscale-video", K6_VSR, "Kandinsky 6.0 VSR Lite", "vsr-lite"),
}


def k6_pricing(price):
    """A Kandinsky 6.0 endpoint's price, parsed: per output megapixel per frame (the VSR), or a 5 s 480p clip at each step count."""
    t = price or ""
    per_mp = re.search(r"\$(\d+(?:\.\d+)?) per output megapixel per frame", t)
    if per_mp:
        steps = re.search(r"default (?:of )?(\d+) steps", t)
        return {"usd": float(per_mp.group(1)), "unit": "output megapixel per frame", "defaultSteps": int(steps.group(1)) if steps else None,
                "maxFrames": 121, "fps": 24}
    default = re.search(r"costs \$(\d+(?:\.\d+)?) at the default (\d+) steps", t)
    points = {int(s): float(v) for s, v in re.findall(r"(\d+) steps cost \$(\d+(?:\.\d+)?)", t)}
    if default:
        points[int(default.group(2))] = float(default.group(1))
    up = {"2": r"\$(\d+(?:\.\d+)?) for 2×", "2.25": r"\$(\d+(?:\.\d+)?) for 1080p", "4": r"\$(\d+(?:\.\d+)?) for 4×"}
    upscale = {k: float(m.group(1)) for k, rx in up.items() if (m := re.search(r"adds(?:[^.]|\.\d)*?" + rx, t))}
    return {"usd": float(default.group(1)) if default else None, "unit": "video", "seconds": 5, "resolution": "480p",
            "defaultSteps": int(default.group(2)) if default else None, "bySteps": {str(k): points[k] for k in sorted(points)},
            "upscaleAdds": upscale}


def kandinsky6(ids):
    """Research #10's Kandinsky 6.0 records on fal (endpointRecords in new-models-10.json); only those named in `ids` when it names any."""
    path = ROOT / "docs/research/new-models-10.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    records = {(e["provider"], e["endpoint"]): e for e in data.get("endpointRecords") or []}
    for ep, (op, kf, model, variant) in KANDINSKY6.items():
        if ids and ep not in ids:
            continue
        inputs = fal(ep)
        missing = [f for f in kf.values() if f not in inputs]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        price = llms_price(ep)
        records[("fal", ep)] = {
            "family": "kandinsky-6", "model": model, "title": model, "vendor": "Kandinsky Lab", "operation": op, "provider": "fal", "endpoint": ep,
            "variant": variant, "falCategory": "video-to-video" if op == "upscale-video" else ("text-to-video" if op == "t2v" else "image-to-video"),
            "status": fal_catalog_status(ep), "keyFields": kf, "inputs": inputs, "output": "video.url", "price": price, "pricing": k6_pricing(price),
            "license": K6_LICENCE,
            "notes": ("Clips are resampled to 24 fps and capped at 121 frames (about 5 s); 2x and 4x need sides that are multiples of 16."
                      if op == "upscale-video" else
                      "5 s at 24 fps, 480p; the sound is made with the picture (generate_audio). Spoken lines go in the prompt; "
                      "enable_prompt_expansion rewrites a short prompt first (off by default). upscale_factor runs the VSR after it, at extra cost."),
            "verified": True, "sourceUrl": f"https://fal.ai/models/{ep}", "schemaUrl": f"https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={ep}",
            "capability": op, "fetched": TODAY,
        }
        print(f"{ep}: {records[('fal', ep)]['status']}, {len(inputs)} inputs, {json.dumps(records[('fal', ep)]['pricing'])}")
    data["endpointRecords"] = list(records.values())
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    if "--keying" in sys.argv:
        keying(sys.argv[sys.argv.index("--keying") + 1:])
        return
    if "--kandinsky6" in sys.argv:
        kandinsky6(sys.argv[sys.argv.index("--kandinsky6") + 1:])
        return
    if "--music" in sys.argv:
        music10(sys.argv[sys.argv.index("--music") + 1:])
        return
    if "--catchup" in sys.argv:
        catchup(sys.argv[sys.argv.index("--catchup") + 1:])
        return
    if "--new10" in sys.argv:
        new10(sys.argv[sys.argv.index("--new10") + 1:])
        return
    if "--part4" in sys.argv:
        part4(sys.argv[sys.argv.index("--part4") + 1:])
        return
    raw = FILE.read_text(encoding="utf-8")
    data = json.loads(raw)
    if "--trainers" in sys.argv:
        trainer_outputs(data)
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    if "--partner" in sys.argv:
        # Add or refresh the partner routes (PARTNER) and keep every other record as it is.
        records = {e["endpoint"]: e for e in data.get("partnerEndpoints") or []}
        for ep, (op, kf) in PARTNER.items():
            records[ep] = {**base_record(ep, op, kf, fal_prices(ep)), "replaces": "a route of the provider build plan O7 removed"}
        data["partnerEndpoints"] = list(records.values())
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    if "--base-only" in sys.argv:
        # Add or refresh these plain endpoints (GENJUTSU, or BASE by id) and keep every other record as it is.
        ids = sys.argv[sys.argv.index("--base-only") + 1:] or list(GENJUTSU)
        records = {e["endpoint"]: e for e in data.get("hostedBaseEndpoints") or []}
        for ep in ids:
            op, kf = GENJUTSU.get(ep) or O11.get(ep) or BASE.get(ep) or (None, None)
            if not op:
                sys.exit(f"{ep} is in none of GENJUTSU, O11 and BASE")
            records[ep] = base_record(ep, op, kf, fal_prices(ep) if ep in GENJUTSU or ep in O11 else None)
        data["hostedBaseEndpoints"] = list(records.values())
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    for ep, rec in NEW_LORA.items():
        if not any(e["id"] == ep for e in data["hostedLoraEndpoints"]):
            data["hostedLoraEndpoints"].append({**rec, "checked": TODAY})
    by_id = {e["id"]: e for e in data["hostedLoraEndpoints"]}
    only = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else None
    for ep, kf in LORA.items():
        if only and ep not in only:
            continue
        rec = by_id.get(ep)
        if not rec:
            sys.exit(f"{ep} is not in hostedLoraEndpoints")
        rec["inputs"] = replicate(ep, rec["version"]) if rec["provider"] == "replicate" else fal(ep)
        missing = [f for f in kf.values() if f not in rec["inputs"]]
        if missing:
            sys.exit(f"{ep}: keyFields {missing} are not inputs")
        rec["keyFields"] = kf
        # Image-to-image, controlled and inpainting routes return pictures too (only the video ops return video.url).
        rec["output"] = "images[].url" if rec["op"] in ("t2i", "edit", "i2i", "i2i-control", "inpaint") else "video.url"
        if rec["provider"] == "replicate":
            rec["output"] = "output[]"
        rec["inputsChecked"] = TODAY
        print(f"{ep}: {len(rec['inputs'])} inputs")
    if only:
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    base = [base_record(ep, op, kf) for ep, (op, kf) in BASE.items()]
    base += [base_record(ep, op, kf, fal_prices(ep)) for ep, (op, kf) in GENJUTSU.items()]
    data["hostedBaseEndpoints"] = base
    FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
