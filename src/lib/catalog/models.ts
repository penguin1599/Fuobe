import { CLOUD_MODELS, ORIGINAL_CLOUD } from "./cloud-models.generated";
import { HI3D_CHAIN_PARAM } from "@/lib/av/hi3d";
import { DEFAULT_FPS_TARGET, FPS_TARGETS, SLOW_MOTION } from "@/lib/av/fps";
import { ASR_LANGUAGES, WHISPER_LANGUAGES } from "../speech-languages";
import { PROMPT_HELPER_PARAM } from "@/lib/comfy";
import { KANDINSKY_PLACEHOLDER } from "@/lib/kandinsky-prompt";
import { QWEN21_DECODER, QWEN21_GPU, QWEN21_SPEED } from "@/lib/qwen21-speed";
import { QMA_AZIMUTHS, QMA_AZIMUTH_LABELS, QMA_DISTANCES, QMA_DISTANCE_LABELS, QMA_DISTANCE_ZOOM, QMA_ELEVATIONS, QMA_ELEVATION_DEGREES, QMA_ELEVATION_LABELS, QMA_MODEL, QMA_PARAMS } from "@/lib/qma";
import { H3_DECODER, H3_FAST_DECODE_OFFERED, H3_GPU_TIER } from "@/lib/gpu/h3-tier";
import { loraEntry, loraRef } from "./loras";
import { ANGLES_LORA, ANY_ANGLE_LORA, MOSAIC_SCALE, MOSAIC_TARGET, SPEAK_GRAPH, SPEAK_LORA, SPEAK_PROMPT } from "./open-tools";
import { ANY_ANGLE } from "./any-angle";
import { RECOLOR_TAP_FIRST } from "./recolor";
import { CINEMA_CROP, SOUL_ASPECTS, SOUL_TIERS } from "./soul";
import { RESTORE, offlineRestorePrompt } from "./restore";
import { REGEN_COPY, REGEN_DEFAULT_TIER, REGEN_MODEL, REGEN_OFFERED, REGEN_TIERS, REGEN_WORKFLOW } from "./regenerate";
import { RTX_FRAMEGEN_MODEL, RTX_FRAMEGEN_WORKFLOW, RTX_HDR_MODEL, RTX_HDR_WORKFLOW, RTX_UPSCALE_MODEL, RTX_UPSCALE_WORKFLOW } from "./rtx-video";
import { COMPOSITE_MODEL, COMPOSITE_WORKFLOW } from "./sharpen";
import { denoiseFor, EVOLUTION, EVOLUTION_DEFAULT_RESOLUTION, EVOLUTION_RESOLUTIONS, INTENSITIES, type Intensity } from "./evolution";
import { LAST_FRAME_CHAIN, type ModelDef, type ModelOptions, type ModelRoute, type Operation } from "./types";

/*
 * Model catalog.
 * - Cloud models are generated from verified API schemas (docs/research/paid-model-apis.json)
 *   by scripts/gen-cloud-models.py → cloud-models.generated.ts. Edit the script, not the output.
 * - Open models route to ComfyUI workflows from workflows/comfyui/manifest.json.
 */

const comfy = (op: Operation, workflow: string, note?: string): ModelRoute => ({ op, provider: "comfyui", endpoint: workflow, note });
/**
 * "Refine detail · Hi3D 1.0" on the open image-to-3D models (hi3d-refine): after the model is built, Hi3D refines its
 * geometry from the same photo (src/server/chains.ts createRefinedModel). Off unless picked; the Canvas 3D node and
 * the composer show it as a control, Image to 3D as a switch.
 */
const HI3D_REFINE_CONTROL = {
  param: HI3D_CHAIN_PARAM,
  label: "Refine detail · Hi3D 1.0",
  values: ["off", 512, 1024, 1536],
  default: "off",
  labels: { off: "Off", 512: "Hi3D 512 (one pass)", 1024: "Hi3D 1024 (two passes)", 1536: "Hi3D 1536 (three passes)" },
};

/** Chatterbox Multilingual's language list (FL_ChatterboxMultilingualTTS). */
const CHATTERBOX_LANGUAGES = [
  "English (en)", "Spanish (es)", "French (fr)", "German (de)", "Italian (it)", "Portuguese (pt)", "Dutch (nl)", "Polish (pl)", "Russian (ru)",
  "Turkish (tr)", "Arabic (ar)", "Hebrew (he)", "Hindi (hi)", "Japanese (ja)", "Korean (ko)", "Chinese (zh)", "Malay (ms)", "Swedish (sv)",
  "Danish (da)", "Norwegian (no)", "Finnish (fi)", "Greek (el)", "Swahili (sw)",
];
const CHATTERBOX_SLIDERS = [
  { param: "exaggeration", label: "Emotion", min: 0.25, max: 2, step: 0.05, default: 0.5 },
  { param: "cfg", label: "Pace / guidance", min: 0.2, max: 1, step: 0.05, default: 0.5 },
  { param: "temperature", label: "Variety", min: 0.05, max: 2, step: 0.05, default: 0.8 },
];

/**
 * Frames mode on the open engine (Kling 4.0's up to 10 keyframes): one Wan 2.2 start/end-frame clip
 * per pair of frames, as long as the gap between them, then joined (createKeyframeFilm in src/server/chains.ts).
 */
const KEYFRAME_FILM: ModelRoute = { ...comfy("keyframes", "wan22-flf2v-14b", "one start/end-frame clip per pair of frames, joined"), chained: true };

/** Open models have no multi-shot of their own: each shot renders separately, then the clips are joined. */
const CONCAT_SHOTS = { mode: "concat", maxShots: 4 } as const;

const IMG_AR = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "5:4", "4:5"];
const VID_AR = ["16:9", "9:16", "1:1"];
/** Kandinsky 6.0's distilled transformers on your GPU (the graphs' unet): Lite (6.4 GB) and Pro (60.3 GB). */
const K6_LITE = "Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors";
const K6_PRO = "Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors";
/** Open video upscalers: the result's shorter edge (1080p = 1080 px in any shape). */
const VIDEO_UPSCALE_TIERS = ["720p", "1080p", "1440p", "2160p"];


// ---------------------------------------------------------------------------
// Open source · ComfyUI

/** Fuobe Restore's LoRA in the cloud (research adapterLoras): Lightricks' Restore IC-LoRA, gated, sent as Fuobe's mirror. */
const RESTORE_LORA = (() => {
  const e = loraEntry("ltx-2-5-22b-ic-lora-restore-1-0");
  return e ? { ...loraRef(e), adapter: true as const } : undefined;
})();
/** Fuobe Try-On's LoRA (research adapterLoras): xocialize's try-on LoRA for FLUX.2 [klein] 4B, Apache-2.0. */
const TRYON_LORA = loraEntry("tryon-klein-4b");
/** Fuobe Animation's LoRA: bilibili's AniSora 3.2 on Wan 2.2's high-noise expert (Apache-2.0; Kijai's rank-64 extraction). */
const ANISORA_LORA = loraEntry("anisora-3-2-i2v-high");
/** akhaliq's Next-Scene LoRA for Qwen-Image 2.1: the 2.1 next-scene graph loads it, and its switch in Models & licences holds the model. */
const NEXT_SCENE_21_LORA = loraEntry("qwen21-next-scene");
/** gribbliest's QMA camera-angles LoRA for Qwen-Image 2.1: the QMA graph loads it, and its switch in Models & licences holds the model. */
const QMA_LORA = loraEntry("qwen21-qma-angles");
/** The try-on LoRA card's own instruction, for a run with no words. */
export const TRYON_PROMPT = "a full-body photo of a person. Replace the outfit with the top and bottom as shown in the reference images. The final image is a full body shot.";

/**
 * MOSS-Image's sampler settings on your GPU (the graph's own defaults are Standard): Standard is Comfy's template
 * (25 steps, CFG 2.5, er_sde), Quality OpenMOSS's guide (50 steps, CFG 3, euler), Fast Spectrallic's SFT with the
 * 8-step DMD LoRA merged in (8 steps, CFG 1; a 5.4 GB file of its own; untested on layouts), Base MOSS-Image Base, the
 * model before its SFT (the owner's image_moss_image_base_t2i: 50 steps, CFG 3, euler; a 5.4 GB file of its own).
 */
const MOSS_QUALITY: NonNullable<ModelOptions["controls"]>[number] = {
  param: "quality",
  label: "Quality",
  values: ["standard", "quality", "fast", "base"],
  default: "standard",
  labels: { standard: "Standard · 25 steps", quality: "Best · 50 steps", fast: "Fast · 8 steps (extra 5.4 GB file)", base: "Base model · 50 steps (extra 5.4 GB file)" },
  sets: {
    standard: { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple" },
    quality: { steps: 50, cfg: 3, sampler: "euler", scheduler: "simple" },
    fast: { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", unet: "moss_image_sft_8stepdmd_int8_convrot.safetensors" },
    base: { steps: 50, cfg: 3, sampler: "euler", scheduler: "simple", unet: "moss_image_base_int8_convrot.safetensors" },
  },
};

/**
 * FLUX 3 Image Klein's Prompt helper on your GPU: BFL's upsampler (a 6.7 GB Qwen3.5 9B file) turns the words into the full
 * caption Klein is made for (BFL: short prompts give generic pictures); off sends them as typed. A layout that places boxes
 * always goes as typed, which the "on" label says. The cloud's flux-3-klein carries the same control (fal's prompt expansion).
 */
const KLEIN_PROMPT_HELPER: NonNullable<ModelOptions["controls"]>[number] = {
  param: PROMPT_HELPER_PARAM,
  label: "Prompt helper",
  values: ["on", "off"],
  default: "on",
  labels: { on: "On · full caption (not with boxes)", off: "Off · your words as typed" },
};

type OpenSpec = Omit<ModelDef, "engine" | "badges"> & { badges?: ModelDef["badges"] };
const o = (m: OpenSpec): ModelDef => ({ ...m, engine: "open", badges: ["open", ...(m.badges ?? [])] });

const open: ModelDef[] = [
  // ---------------- The owner's newest image models, first picks on your GPU (2026-10-31): text to image in his order
  // (Ideogram 4, Qwen-Image 2.1, Krea 2, MOSS-Image, FIBO 2), then the edit models (Qwen-Image 2.1, FIBO 2, Krea 2).
  // A studio's "Best" list is its default, then the `top` models in this order (bestForStudio in src/lib/composer.ts).
  // Ideogram 4: the prompt is a JSON caption the server writes from the words (promptFormat; src/lib/ideogram-caption.ts).
  o({
    id: "oss-ideogram-4",
    name: "Ideogram 4",
    vendor: "Ideogram",
    family: "ideogram",
    kind: "image",
    tagline: "Typography, posters and photographic stills from structured captions · 24 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("t2i", "ideogram4-t2i", "lean JSON caption; Quality preset")],
    options: {
      aspectRatios: IMG_AR,
      resolutions: ["1K", "1.5K", "2K"],
      seed: true,
      controls: [
        {
          param: "preset",
          label: "Quality",
          values: ["Quality", "Default", "Turbo"],
          default: "Quality",
          labels: { Quality: "Quality (48 steps)", Default: "Balanced (20 steps)", Turbo: "Turbo (12 steps)" },
        },
      ],
      promptFormat: "ideogram4",
    },
    defaults: { aspectRatio: "1:1", resolution: "1.5K" },
  }),

  // Qwen-Image 2.1: text to image, edits with up to 4 references, inpaint and expand; its Turbo makes 8-step edits.
  o({
    id: "oss-qwen-image-21",
    name: "Qwen-Image 2.1",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Native 2K images with clean lettering; edits with up to 4 references, inpaint and expand; Draft to Full speed · English prompts only on a 16 GB GPU, any language on a 20 GB GPU",
    badges: ["new", "top"],
    // Aspect ratio and size are for text to image: an edit or inpaint follows image 1, an expand the canvas its pads grow.
    // The inpaint and expand graphs read the picture alone.
    routes: [
      comfy("t2i", "qwen-image-21-t2i"),
      { ...comfy("edit", "qwen-image-21-edit", "25 steps, up to 4 references"), unsized: true },
      { ...comfy("inpaint", "qwen-image-21-inpaint", "crops around the mask, 25 steps, pasted back"), unsized: true, maxImages: 1 },
      { ...comfy("outpaint", "qwen-image-21-outpaint", "outpaint-v2 LoRA; Qwen3-VL describes the scene"), unsized: true, maxImages: 1 },
    ],
    // Options → Speed (2-8 steps), GPU (the small encoder on a 16 GB card) and Decoder (src/lib/qwen21-speed.ts).
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K"], maxImages: 4, seed: true, controls: [QWEN21_SPEED, QWEN21_GPU, QWEN21_DECODER] },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-qwen-image-21-turbo",
    name: "Qwen-Image 2.1 Turbo",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "8-step edits with up to 4 references, close to the full model except on big camera turns · 20 GB GPU",
    badges: ["new", "top", "fast"],
    routes: [comfy("edit", "qwen-image-21-turbo-edit", "8 steps, up to 4 references")],
    options: { maxImages: 4, seed: true, controls: [QWEN21_DECODER] },
  }),
  // Qwen-Image 2.1 on a 16 GB card: Zen Image Edit's 0.8B encoder, which Qwen-Image 2.1's GPU option picks
  // (Small, or Auto under 20 GB when the route is ready: src/server/qwen21-gpu.ts). Listed for its licence, its node pack and its switch, and for the pre-flight board's row; never in a picker.
  o({
    id: "oss-qwen-image-21-small",
    name: "Qwen-Image 2.1 · Small GPU",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Qwen-Image 2.1 on a 16 GB GPU with a compact text reader: English prompts only, and numbers on signs can come out wrong",
    routes: [
      { ...comfy("t2i", "qwen-image-21-t2i-small", "Zen Image Edit's 0.8B encoder, 30 steps") },
      { ...comfy("edit", "qwen-image-21-edit-small", "Zen Image Edit's 0.8B encoder, up to 4 references"), unsized: true },
    ],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K"], maxImages: 4, seed: true, controls: [QWEN21_DECODER] },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
    hidden: true,
  }),
  // Live edit's model (the Live edit page runs it, as you type): listed for its licence, its model page and its switch in
  // Models & licences, never in a picker.
  o({
    id: "oss-qwen-image-21-live",
    name: "Qwen-Image 2.1 Live",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Live edits as you type with the 2-step DMD2 LoRA · 20 GB GPU",
    routes: [{ ...comfy("edit", "qwen-image-21-live-edit", "2 steps, live"), unsized: true }],
    options: { maxImages: 4, seed: true },
    hidden: true,
  }),
  // Tap to Recolor's model (the app's own page runs it): SAM 3.1 makes the mask from the taps (params.points), and
  // Qwen-Image 2.1 repaints only that piece in the new colour. Listed for its licence and switch, never in a picker.
  o({
    id: "oss-recolor",
    name: "Tap to Recolor",
    vendor: "Alibaba Qwen + Meta SAM 3.1",
    family: "qwen-image",
    kind: "image",
    tagline: "Only the tapped piece takes the new colour; its fabric, folds and shine stay · 20 GB GPU · non-commercial weights",
    routes: [{ ...comfy("edit", "qwen-image-21-recolor", "SAM 3.1 mask from the taps, 25 steps, pasted back"), unsized: true, maxImages: 1 }],
    options: { maxImages: 1, seed: true, requires: { images: 1, points: true, msg: RECOLOR_TAP_FIRST } },
    hidden: true,
  }),

  // FLUX 3 Image Klein (BFL, 2026-10-13; research #10 §6.3): text to image and edits with up to 10 references, a layout of
  // boxes in its own table (compileFlux3), BFL's prompt helper first unless it is off. Klein Base takes your FLUX 3 Klein
  // LoRAs. The cloud halves are flux-3-klein and flux-3-klein-base on fal. Not a default anywhere (the current picks stay).
  o({
    id: "oss-flux3-klein",
    name: "FLUX 3 Klein",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "BFL's open 5.6B model: images up to 4K, edits with up to 10 references, layout boxes · 16-24 GB GPU",
    badges: ["new", "top"],
    // The Image studio's Best list, as its brief asks; the Edit studio offers it, and its Best list stays as it is.
    bestOps: ["t2i"],
    // The edit follows reference 1's shape (about 1 MP); text to image takes the aspect ratio and size.
    routes: [
      comfy("t2i", "flux3-klein-t2i", "16 steps; the prompt helper writes the full caption"),
      { ...comfy("edit", "flux3-klein-edit", "16 steps, up to 10 references"), unsized: true, maxImages: 10 },
    ],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K", "4K"], maxImages: 10, seed: true, layout: "flux3", controls: [KLEIN_PROMPT_HELPER] },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-flux3-klein-base",
    name: "FLUX 3 Klein Base",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "The undistilled Klein your FLUX 3 Klein LoRAs are trained on: 50 steps with them · 16-24 GB GPU",
    badges: ["new"],
    routes: [comfy("t2i", "flux3-klein-base-t2i-lora", "50 steps, CFG 3.5; your LoRAs load after it")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K", "4K"], seed: true, layout: "flux3", controls: [KLEIN_PROMPT_HELPER] },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),

  // Krea 2 text to image (its edit models come after FIBO 2's, as the owner ranks them).
  o({
    id: "oss-krea2-realism",
    name: "Krea 2 Realism",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Natural skin, light and faces from detailed prose · 20 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("t2i", "krea2-realism-t2i", "Krea 2 Turbo + the Realism V2 LoRA, 6 steps")],
    options: {
      aspectRatios: IMG_AR,
      resolutions: ["1K", "1.5K", "2K"],
      seed: true,
      sliders: [{ param: "loraStrength", label: "Realism", min: 0, max: 2, step: 0.05, default: 1 }],
    },
    // Krea 2 makes about 2 MP; at 1 MP it gets noisy.
    defaults: { aspectRatio: "1:1", resolution: "1.5K" },
  }),
  o({
    id: "oss-krea2-turbo",
    name: "Krea 2 Turbo",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Krea 2 in 8 steps: photos and illustrations from prose · 20 GB GPU",
    badges: ["new", "fast"],
    routes: [comfy("t2i", "krea2-turbo-t2i", "8 steps")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K"], seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),

  // MOSS-Image (OpenMOSS, Apache-2.0; research #7 §4.6): plain words, or a layout of boxes compiled to its JSON
  // (src/lib/layout-prompt.ts). The cloud half is `moss-image` on fal.
  o({
    id: "oss-moss-image",
    name: "MOSS-Image",
    vendor: "OpenMOSS",
    family: "moss",
    kind: "image",
    tagline: "Clean Chinese and English text, follows layout boxes · on your GPU, about 15 GB of files",
    badges: ["new", "top"],
    // The int8 Qwen3.5-9B, never the template's w4a8 build: that one faulted the NVIDIA driver here (scripts/comfy/library.spec.mjs).
    routes: [comfy("t2i", "moss-image-t2i", "MOSS-Image SFT int8, Qwen3.5-9B int8, FLUX.2 small decoder; core nodes")],
    options: {
      aspectRatios: IMG_AR,
      resolutions: ["1K", "1.5K"],
      seed: true,
      negativePrompt: true,
      layout: "moss",
      controls: [MOSS_QUALITY],
    },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),

  // FIBO 2 (Bria FIBO 2.0): text to image from Bria's structured JSON prompt, edits with up to 4 references.
  o({
    id: "oss-fibo2-dev",
    name: "FIBO 2 Dev",
    vendor: "Bria",
    family: "bria",
    kind: "image",
    tagline: "Structured JSON prompts for exact control; edits with up to 4 references · 24 GB GPU",
    badges: ["new", "top"],
    routes: [
      comfy("t2i", "fibo2-dev-t2i", "Qwen3.5 writes Bria's structured JSON prompt; 30 steps"),
      // An edit follows image 1's size and shape.
      { ...comfy("edit", "fibo2-dev-edit", "30 steps, up to 4 references"), unsized: true },
    ],
    options: { aspectRatios: IMG_AR, resolutions: ["1K"], maxImages: 4, seed: true, negativePrompt: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-fibo2-edit-turbo",
    name: "FIBO 2 Edit Turbo",
    vendor: "Bria",
    family: "bria",
    kind: "image",
    tagline: "4-step edits with up to 4 references · 16 GB GPU",
    badges: ["new", "top", "fast"],
    routes: [comfy("edit", "fibo2-edit-turbo-edit", "4 steps, up to 4 references")],
    options: { maxImages: 4, seed: true },
  }),

  // Krea 2 edits, image to image, inpaint and expand.
  o({
    id: "oss-krea2-edit",
    name: "Krea 2 Edit",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Instruction edits that keep the picture: relight, recolour, add, remove, restyle; a second photo puts a person in the scene · 20 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("edit", "krea2-edit-general", "General Edit V2 LoRA, 8 steps; image 2 = a person to put in the scene")],
    options: {
      aspectRatios: ["auto", ...IMG_AR],
      resolutions: ["1K", "1.5K"],
      maxImages: 2,
      seed: true,
      imageLabels: ["photo to edit", "a person to put in it (optional)"],
    },
    defaults: { aspectRatio: "auto", resolution: "1K" },
  }),
  o({
    id: "oss-krea2-identity-edit",
    name: "Krea 2 Identity Edit",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Restages a person from one photo: new place, pose or outfit, same face · 20 GB GPU",
    badges: ["new"],
    routes: [comfy("edit", "krea2-edit-identity", "Identity Edit V2 LoRA, 8 steps; image 2 = a second person")],
    options: {
      aspectRatios: ["auto", ...IMG_AR],
      resolutions: ["1K", "1.5K"],
      maxImages: 2,
      seed: true,
      imageLabels: ["photo of the person", "a second person (optional)"],
    },
    defaults: { aspectRatio: "auto", resolution: "1K" },
  }),
  o({
    id: "oss-krea2-i2i",
    name: "Krea 2 Turbo · Image to image",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Your picture redrawn in Krea 2's look at the strength you pick · 20 GB GPU",
    badges: ["new"],
    routes: [comfy("edit", "krea2-turbo-i2i", "about 2 MP, keeps the picture's shape")],
    options: { maxImages: 1, seed: true, sliders: [{ param: "strength", label: "Change", min: 0.1, max: 1, step: 0.05, default: 0.6 }] },
  }),
  o({
    id: "oss-krea2-inpaint",
    name: "Krea 2 Inpaint",
    vendor: "Krea",
    family: "krea",
    kind: "image",
    tagline: "Paints the masked area or extends the canvas · 20 GB GPU · needs the Krea 2 Ostris Edit add-on",
    // No `new`: it stays out of Inpaint's "Best" list while its add-on isn't on the owner's ComfyUI (a pick there would fail).
    routes: [
      comfy("inpaint", "krea2-inpaint", "the masked area made black, then the inpaint-edit LoRA paints it"),
      comfy("outpaint", "krea2-outpaint", "the canvas grown on black, then the inpaint-edit LoRA fills it"),
    ],
    options: { maxImages: 1, seed: true },
  }),

  // ---------------- Image
  o({
    id: "oss-z-image-turbo",
    name: "Z-Image Turbo",
    vendor: "Alibaba Tongyi",
    family: "z-image",
    kind: "image",
    tagline: "Photoreal images in seconds · 12–16 GB GPU",
    badges: ["fast", "top"],
    routes: [comfy("t2i", "z-image-turbo-t2i")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K"], seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-qwen-image",
    name: "Qwen-Image 2512",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Sharp lettering and strong composition",
    routes: [comfy("t2i", "qwen-image-2512-t2i")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-qwen-image-lightning",
    name: "Qwen-Image Lightning",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Qwen-Image, faster",
    badges: ["fast"],
    routes: [comfy("t2i", "qwen-image-2512-t2i-lightning", "4-step Lightning LoRA")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-flux2-dev",
    name: "FLUX.2 [dev]",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "FLUX.2 with multi-reference editing",
    routes: [comfy("t2i", "flux2-dev-t2i"), comfy("edit", "flux2-dev-multiref")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K", "2K"], maxImages: 3, seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-flux2-dev-turbo",
    name: "FLUX.2 [dev] Turbo",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "FLUX.2, faster",
    badges: ["fast"],
    routes: [comfy("t2i", "flux2-dev-t2i-turbo")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-flux1-krea",
    name: "FLUX.1 Krea [dev]",
    vendor: "Black Forest Labs × Krea",
    family: "flux",
    kind: "image",
    tagline: "Natural skin and light, true photorealism",
    routes: [comfy("t2i", "flux1-krea-dev-t2i")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], seed: true },
    defaults: { aspectRatio: "3:4", resolution: "1K" },
  }),
  o({
    id: "oss-flux1-dev",
    name: "FLUX.1 [dev]",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "The classic FLUX, with thousands of styles",
    routes: [comfy("t2i", "flux1-dev-t2i")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], seed: true },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-flux1-schnell",
    name: "FLUX.1 [schnell]",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "FLUX at its fastest",
    badges: ["fast"],
    routes: [comfy("t2i", "flux1-schnell-t2i")],
    options: { aspectRatios: IMG_AR, seed: true },
    defaults: { aspectRatio: "1:1" },
  }),
  o({
    id: "oss-hidream",
    name: "HiDream-I1 Dev",
    vendor: "HiDream.ai",
    family: "hidream",
    kind: "image",
    tagline: "Follows long prompts closely",
    routes: [comfy("t2i", "hidream-i1-dev-t2i")],
    options: { aspectRatios: IMG_AR, seed: true, negativePrompt: true },
    defaults: { aspectRatio: "1:1" },
  }),
  o({
    id: "oss-sdxl",
    name: "SDXL",
    vendor: "Stability AI",
    family: "sdxl",
    kind: "image",
    tagline: "The classic, with thousands of styles",
    routes: [comfy("t2i", "sdxl-t2i")],
    options: { aspectRatios: IMG_AR, seed: true, negativePrompt: true },
    defaults: { aspectRatio: "1:1" },
    // Out of the Image picker; links and earlier runs still resolve.
    hidden: true,
  }),
  o({
    id: "oss-qwen-edit",
    name: "Qwen-Image-Edit 2511",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Edit with words, up to 3 references",
    badges: ["top"],
    routes: [comfy("edit", "qwen-image-edit-2511-multi")],
    options: { maxImages: 3, seed: true, negativePrompt: true },
  }),
  o({
    id: "oss-flux-kontext",
    name: "FLUX.1 Kontext [dev]",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "Open instruction editing that preserves identity",
    routes: [comfy("edit", "flux1-kontext-dev-edit")],
    options: { maxImages: 1, seed: true },
  }),
  o({
    id: "oss-flux-fill",
    name: "FLUX.1 Fill [dev]",
    vendor: "Black Forest Labs",
    family: "flux",
    kind: "image",
    tagline: "Inpaint with a mask, or expand the canvas",
    routes: [comfy("inpaint", "flux1-fill-inpaint"), comfy("outpaint", "flux1-fill-outpaint")],
    options: { maxImages: 1, seed: true },
  }),
  o({
    id: "oss-reactor",
    name: "ReActor face swap",
    vendor: "Open source (inswapper)",
    family: "reactor",
    kind: "image",
    tagline: "Classic fast face swap with face restoration",
    routes: [comfy("face-swap", "face-swap-reactor")],
    options: {},
  }),
  o({
    id: "oss-upscale-image",
    name: "4x ESRGAN upscale",
    vendor: "Open source",
    family: "esrgan",
    kind: "image",
    tagline: "Fast 4x image upscale",
    routes: [comfy("upscale-image", "upscale-image-esrgan")],
    options: {},
  }),
  o({
    // The Vectorize app's open route (Recraft Vectorize on the cloud): tracing, no model weights.
    id: "oss-vtracer",
    name: "VTracer",
    vendor: "visioncortex",
    family: "vtracer",
    kind: "image",
    tagline: "Traces logos, icons and flat art into a clean, editable SVG · CPU, no model",
    routes: [comfy("vectorize", "image-vectorize-vtracer", "colour tracing, stacked shapes")],
    options: {
      promptless: true,
      maxImages: 1,
      controls: [{ param: "curveMode", label: "Curves", values: ["spline", "polygon"], default: "spline" }],
      sliders: [
        { param: "colorPrecision", label: "Colour detail", min: 1, max: 8, step: 1, default: 6 },
        { param: "filterSpeckle", label: "Ignore specks (px)", min: 0, max: 32, step: 1, default: 4 },
      ],
    },
  }),
  o({
    // Layers' Edit text on the open engine (Florence-2 / Ideogram on the cloud): the lines and their boxes.
    id: "oss-ocr-lines",
    name: "OvisOCR3",
    vendor: "ATH-MaaS",
    family: "qwen-llm",
    kind: "text",
    tagline: "Every line of text in an image, with its box · 3 GB GPU",
    routes: [comfy("ocr", "ocr-lines-qwen35", "OvisOCR3 0.8B (a Qwen3.5 OCR fine-tune) on core TextGenerate; boxes come back 0–1000")],
    options: { promptless: true, maxImages: 1 },
  }),
  o({
    id: "oss-seedvr2-image",
    name: "SeedVR2 (image)",
    vendor: "ByteDance Seed",
    family: "seedvr",
    kind: "image",
    tagline: "Diffusion upscaler that restores real detail",
    routes: [comfy("upscale-image", "upscale-image-seedvr2")],
    options: { seed: true },
  }),
  o({
    id: "oss-rmbg",
    name: "BiRefNet background removal",
    vendor: "Open source",
    family: "birefnet",
    kind: "image",
    tagline: "Clean cut-outs in one click",
    routes: [comfy("bg-remove", "bg-remove-birefnet")],
    options: {},
  }),
  // Image cut-outs, Fine hair (nm10-keying): FeyNoBg's matte for hair, fur, lace and glass, its edges refined.
  o({
    id: "oss-matte-feynobg",
    name: "FeyNoBg fine hair",
    vendor: "1038lab",
    family: "feynobg",
    kind: "image",
    tagline: "Cut-outs that keep every strand of hair, fur and see-through edges",
    badges: ["new"],
    routes: [comfy("bg-remove", "image-matte-feynobg")],
    options: {},
  }),

  // ---------------- Video
  // MiniMax H3: text, image and start + end frame to video with its own sound, on the fl2va model. Standard runs larryvrh's
  // turbo v4 LoRA (8 steps) with SLA attention; Sharper ("best", params.extra.quality) runs the 20-step graph without them,
  // Pika Flex ("flex") Pika's post-trained adapter in 6 steps (resolveWorkflowId). References (ref2v) run Pika H3 Flex Ref2VA. The prompt is wrapped in H3's own layout on the server (promptFormat; src/lib/h3-prompt.ts), and
  // the canvas and frame count follow H3's grid (the provider). The graphs are not validated yet (validated: false).
  o({
    id: "oss-minimax-h3",
    name: "MiniMax H3",
    vendor: "MiniMax",
    family: "minimax-h3",
    kind: "video",
    tagline: "Video with its own sound, from words, a start frame, or start and end frames · about 2-3 min for a 5 s clip on a 32 GB GPU",
    badges: ["new", "audio", "top"],
    routes: [
      comfy("t2v", "minimax-h3-t2v", "turbo v4 LoRA, 8 steps"),
      comfy("i2v", "minimax-h3-i2v", "turbo v4 LoRA, 8 steps; the clip takes the start frame's shape"),
      comfy("flf2v", "minimax-h3-flf2v", "turbo v4 LoRA, 8 steps; the clip takes the start frame's shape"),
      // References (Pika H3 Flex Ref2VA, 6 steps): up to 9 images, 3 clips and 3 voice or music clips, cited in order.
      comfy("ref2v", "minimax-h3-flex-ref2va", "Pika H3 Flex, 6 steps: up to 9 images, 3 clips and 3 voice or music clips"),
      // Talk from a voice clip (Lipsync & avatars, Fuobe Speak): one image + the voice as references; a new clip, not a re-sync.
      comfy("avatar", "minimax-h3-flex-ref2va", "Talk from a voice clip: a new clip of the portrait speaking with this voice (2-15 s), not a re-sync of existing footage"),
    ],
    options: {
      aspectRatios: ["auto", "16:9", "9:16", "1:1", "4:3", "3:4"],
      durations: [3, 5, 10, 15],
      resolutions: ["768p"],
      // 2K in the Video studio and Cinema only: a 768p draft, then Open-H3 Regenerate at 2K from it (from its latent for
      // text to video), on your GPU: a 48 GB card (its chip says so, own-setup.ts "regenerate:h3-2k").
      finishTiers: ["2K"],
      seed: true,
      endFrame: true,
      audio: "always",
      promptFormat: "minimax-h3",
      // References mode (Pika H3 Flex Ref2VA): Pika's limits, 12 files in all (src/lib/h3-references.ts).
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
      controls: [
        {
          param: "quality",
          label: "Quality",
          values: ["fast", "best", "flex"],
          default: "fast",
          labels: { fast: "Standard · 8 steps", best: "Sharper · 20 steps, about 2.3x longer", flex: "Fast · Pika Flex (6 steps)" },
          // References and Talk from a voice clip always run Pika H3 Flex: the chip shows on words and frames only.
          ops: { fast: ["t2v", "i2v", "flf2v"], best: ["t2v", "i2v", "flf2v"], flex: ["t2v", "i2v", "flf2v"] },
        },
        // On a card under 32 GB the run picks FastH3 V2 or Trim by itself (src/server/h3-gpu.ts); this picks one on any card.
        H3_GPU_TIER,
        // Options → Decoder (Fast decode, Sol-H3-VAE) joins here once a ComfyUI with its loader (#17411) has validated it: see H3_DECODER.
        ...(H3_FAST_DECODE_OFFERED ? [H3_DECODER] : []),
      ],
    },
    defaults: { aspectRatio: "auto", duration: 5, resolution: "768p" },
    engineNote:
      "Pika H3 Flex (Quality → Fast · Pika Flex, References with images, clips and voice or music clips, and Talk from a voice clip) runs on your GPU only: no cloud service offers it, so the cloud runs MiniMax H3 as hosted, without Flex",
  }),
  o({
    id: "oss-ltx25",
    name: "LTX-2.5",
    vendor: "Lightricks",
    family: "ltx",
    kind: "video",
    tagline: "Open video with native synchronized audio, up to 10s",
    badges: ["audio", "top", "new"],
    routes: [comfy("t2v", "ltx25-t2v"), comfy("i2v", "ltx25-i2v")],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [5, 8, 10], resolutions: ["720p", "1080p"], seed: true, negativePrompt: true, audio: "always" },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "720p" },
  }),
  o({
    id: "oss-wan22-14b-fast",
    name: "Wan 2.2 14B Lightning",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Wan 2.2, fast: a clip in minutes",
    badges: ["fast", "top"],
    routes: [comfy("t2v", "wan22-t2v-14b-lightx2v", "Lightx2v 4-step"), comfy("i2v", "wan22-i2v-14b-lightx2v", "Lightx2v 4-step"), comfy("flf2v", "wan22-flf2v-14b"), KEYFRAME_FILM],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [3, 5], resolutions: ["480p", "720p"], seed: true, negativePrompt: true, endFrame: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "480p" },
  }),
  o({
    id: "oss-wan22-14b",
    name: "Wan 2.2 14B",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Full-quality Wan 2.2 from words, an image, or start and end frames",
    routes: [comfy("t2v", "wan22-t2v-14b"), comfy("i2v", "wan22-i2v-14b"), comfy("flf2v", "wan22-flf2v-14b"), KEYFRAME_FILM],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [3, 5, 7], resolutions: ["480p", "720p"], seed: true, negativePrompt: true, endFrame: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "480p" },
  }),
  // MiniMax H3 on 8-31 GB cards: FastVideo's FastH3 V2 and FastH3 Trim, which MiniMax H3's GPU tier picks
  // (Auto on a smaller card, or asked for: src/server/h3-gpu.ts). Listed for their licence, their switch in Models & licences
  // and the pre-flight's readiness; never in a picker. The speeds and the 8 GB figure are FastVideo's measurements.
  o({
    id: "oss-minimax-h3-fast",
    name: "MiniMax H3 · FastH3 V2",
    vendor: "FastVideo",
    family: "minimax-h3",
    kind: "video",
    tagline: "MiniMax H3 in 8 steps on a 16 GB GPU, from words, a start frame, or start and end frames · MiniMax H3 Community License",
    routes: [
      comfy("t2v", "minimax-h3-fast-t2v", "FastH3 V2, 8 steps"),
      comfy("i2v", "minimax-h3-fast-i2v", "FastH3 V2, 8 steps; the clip takes the start frame's shape"),
      comfy("flf2v", "minimax-h3-fast-flf2v", "FastH3 V2, 8 steps; the clip takes the start frame's shape"),
    ],
    options: { aspectRatios: ["auto", "16:9", "9:16", "1:1", "4:3", "3:4"], durations: [3, 5, 10, 15], resolutions: ["768p"], seed: true, endFrame: true, audio: "always", promptFormat: "minimax-h3" },
    defaults: { aspectRatio: "auto", duration: 5, resolution: "768p" },
    hidden: true,
  }),
  o({
    id: "oss-minimax-h3-trim",
    name: "MiniMax H3 · FastH3 Trim",
    vendor: "FastVideo",
    family: "minimax-h3",
    kind: "video",
    tagline: "MiniMax H3 from words on an 8-12 GB GPU: experimental, below FastH3 V2 in quality · MiniMax H3 Community License",
    routes: [comfy("t2v", "minimax-h3-trim-t2v", "FastH3 Trim, 8 steps, experimental")],
    options: { aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"], durations: [3, 5, 10, 15], resolutions: ["768p"], seed: true, audio: "always", promptFormat: "minimax-h3" },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "768p" },
    hidden: true,
  }),
  o({
    id: "oss-wan22-5b",
    name: "Wan 2.2 5B",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "720p video on a single consumer GPU",
    badges: ["fast"],
    routes: [comfy("t2v", "wan22-ti2v-5b"), comfy("i2v", "wan22-ti2v-5b-i2v")],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [3, 5], resolutions: ["720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "720p" },
  }),
  o({
    id: "oss-ltx2",
    name: "LTX-2",
    vendor: "Lightricks",
    family: "ltx",
    kind: "video",
    tagline: "Fast open video with audio",
    badges: ["audio"],
    routes: [comfy("t2v", "ltx2-t2v"), comfy("i2v", "ltx2-i2v")],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [5, 8], resolutions: ["720p"], seed: true, negativePrompt: true, audio: "always" },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "720p" },
  }),
  // Kandinsky 6.0 (Kandinsky Lab, 2026-10-06, MIT; research #10 §2.1, package nm10-kandinsky6): 5 s clips at 24 fps with 44 kHz
  // sound and lip-synced dialogue, from words or a first frame, on Kandinsky Lab's own packs (kandinsky6). Quality picks the
  // 10-step distilled Lite (3B, the default here: it fits ordinary GPUs) or Pro (29B, a 60 GB file); the Prompt helper runs
  // Kandinsky's Qwen3.5 9B rewrite first. Quoted words are what someone says (promptFormat). The cloud half is kandinsky-6.
  o({
    id: "oss-kandinsky6",
    name: "Kandinsky 6.0",
    vendor: "Kandinsky Lab",
    family: "kandinsky",
    kind: "video",
    tagline: "Kandinsky 6.0 · both engines: 5 s clips with dialogue, lip sync and sound from words or a first frame · Lite on a 24 GB GPU, Pro about 80 GB · MIT",
    badges: ["new", "audio"],
    routes: [
      comfy("t2v", "kandinsky6-t2av", "10-step distilled model; the sound is made with the picture"),
      comfy("i2v", "kandinsky6-i2av", "10-step distilled model; the image is the first frame"),
    ],
    options: {
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      durations: [5],
      resolutions: ["480p"],
      seed: true,
      negativePrompt: true,
      audio: "always",
      promptFormat: "kandinsky6",
      promptPlaceholder: KANDINSKY_PLACEHOLDER,
      controls: [
        {
          param: "quality",
          label: "Quality",
          values: ["lite", "pro"],
          default: "lite",
          labels: { lite: "Lite · 10 steps, fits a 24 GB GPU", pro: "Pro · 10 steps, about 80 GB (extra 60 GB file)" },
          sets: { lite: { unet: K6_LITE }, pro: { unet: K6_PRO } },
        },
        {
          param: PROMPT_HELPER_PARAM,
          label: "Prompt helper",
          values: ["off", "on"],
          default: "off",
          labels: { off: "Off · your words as typed", on: "On · Kandinsky writes a fuller caption (extra 19 GB file)" },
        },
      ],
    },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "480p" },
  }),
  o({
    id: "oss-hunyuan15",
    name: "HunyuanVideo 1.5",
    vendor: "Tencent",
    family: "hunyuan",
    kind: "video",
    tagline: "Lightweight 8.3B model with strong motion",
    routes: [comfy("t2v", "hunyuan15-t2v-720p"), comfy("i2v", "hunyuan15-i2v-720p")],
    options: { multiShot: CONCAT_SHOTS, aspectRatios: VID_AR, durations: [5], resolutions: ["720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "720p" },
  }),
  o({
    id: "oss-wan-vace",
    name: "Wan VACE",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Reference-to-video: put your subject into a new shot",
    routes: [comfy("ref2v", "wan21-vace-14b-ref2v")],
    options: { aspectRatios: VID_AR, durations: [5], resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "480p" },
  }),
  o({
    id: "oss-wan22-fun-camera",
    name: "Wan 2.2 Fun Camera",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Image-to-video with explicit camera control (pan, zoom, roll)",
    routes: [comfy("i2v", "wan22-fun-camera-14b", "camera pose via cameraMotion")],
    options: { aspectRatios: VID_AR, durations: [5], resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9", duration: 5, resolution: "480p" },
    hidden: true,
  }),
  o({
    id: "oss-wan22-animate",
    name: "Wan Animate 2",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Make any character copy a reference performance",
    routes: [comfy("motion-transfer", "wan-animate2")],
    options: { seed: true },
  }),
  o({
    id: "oss-wan22-fun-control",
    name: "Wan 2.2 Fun Control",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Pose/depth-guided motion transfer from a driving video",
    routes: [comfy("motion-transfer", "wan22-fun-control-14b")],
    options: { seed: true },
  }),
  o({
    id: "oss-infinitetalk",
    name: "InfiniteTalk",
    vendor: "MeiGen",
    family: "infinitetalk",
    kind: "video",
    tagline: "Talking avatar from one photo (native, ~6s)",
    badges: ["top"],
    routes: [comfy("avatar", "infinitetalk-native")],
    options: { aspectRatios: VID_AR, seed: true },
    defaults: { aspectRatio: "16:9" },
  }),
  o({
    id: "oss-infinitetalk-long",
    name: "InfiniteTalk Long",
    vendor: "MeiGen",
    family: "infinitetalk",
    kind: "video",
    tagline: "Long talking videos from one photo",
    routes: [comfy("avatar", "infinitetalk-wanwrapper")],
    options: { aspectRatios: VID_AR, seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9" },
  }),
  o({
    id: "oss-wan22-s2v",
    name: "Wan 2.2 S2V",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Speech-to-video with body motion, ~14s",
    routes: [comfy("avatar", "wan22-s2v-14b")],
    options: { aspectRatios: VID_AR, seed: true, negativePrompt: true },
    defaults: { aspectRatio: "9:16" },
  }),
  // Video upscalers run in passes of a few frames (VHS meta-batch), so memory stays flat whatever the clip's
  // length (the whole-clip graphs held about 38 GB of frames for 30 s at 480p). params.resolution = the shorter edge.
  o({
    id: "oss-seedvr2",
    name: "SeedVR2 (video)",
    vendor: "ByteDance Seed",
    family: "seedvr",
    kind: "video",
    tagline: "One-step diffusion restoration and upscale, in passes so long clips fit",
    routes: [comfy("upscale-video", "upscale-video-seedvr2-chunked", "33 frames per pass; each pass restored on its own")],
    options: { seed: true, resolutions: VIDEO_UPSCALE_TIERS },
    defaults: { resolution: "1080p" },
  }),
  // Open-H3 Regenerate 2K (docs/research/new-models-7.md §2): the creative finishing step beside SeedVR2's faithful one. It
  // redraws the clip at 1080p / 2K / 4K from its words (src/lib/catalog/regenerate.ts); GPU-only, nobody hosts it.
  o({
    id: REGEN_MODEL,
    name: "Open-H3 Regenerate",
    vendor: "NVIDIA",
    family: "minimax-h3",
    kind: "video",
    tagline: "Redraws a soft clip at 1080p, 2K or 4K. Details may change; motion and layout stay.",
    badges: ["new", "4k", "audio"],
    hidden: !REGEN_OFFERED,
    routes: [comfy("upscale-video", REGEN_WORKFLOW, "Built on MiniMax H3: redraws the clip at 24 fps, up to 15 s a pass, keeping its sound")],
    options: {
      seed: true,
      resolutions: [...REGEN_TIERS],
      requires: { prompt: true, msg: "Regenerate redraws the clip from words: describe what is in it" },
      promptPlaceholder: REGEN_COPY.prompt,
      controls: [
        {
          param: "creativity",
          label: "Creativity",
          values: ["close", "balanced", "detail"],
          default: "balanced",
          labels: { close: "Close", balanced: "Balanced", detail: "More detail" },
          // The refine's start noise: 0 is the release grid (0.909), which redraws the most.
          sets: { close: { startSigma: 0.7 }, balanced: { startSigma: 0.8 }, detail: { startSigma: 0 } },
        },
        {
          param: "speed",
          label: "Speed",
          values: ["standard", "faster"],
          default: "standard",
          labels: { standard: "3 steps", faster: "Faster · 2 steps" },
          sets: { standard: { steps: 3 }, faster: { steps: 2 } },
        },
      ],
    },
    defaults: { resolution: REGEN_DEFAULT_TIER },
  }),
  // Kandinsky VSR (nm10-kandinsky6): Kandinsky Lab's 2-step distilled video upscaler (kandinsky6-sr pack), 2x, 2.25x (480p to
  // 1080p) or 4x by tiled diffusion, keeping the clip's sound; at most 121 frames at 24 fps (about 5 s), as on fal (kandinsky-vsr).
  o({
    id: "oss-kandinsky6-vsr",
    name: "Kandinsky VSR",
    vendor: "Kandinsky Lab",
    family: "kandinsky",
    kind: "video",
    tagline: "Kandinsky 6.0 · both engines: sharp 2x, 2.25x or 4x video upscale, clips up to 5 s · MIT",
    badges: ["new"],
    routes: [comfy("upscale-video", "video-upscale-kandinsky6-vsr", "2-step distilled upscaler, tiled; keeps the sound")],
    options: { seed: true, resolutions: ["2x", "2.25x", "4x"], maxSourceSeconds: 5 },
    defaults: { resolution: "2.25x" },
  }),
  o({
    id: "oss-upscale-video-esrgan",
    name: "ESRGAN video upscale",
    vendor: "Open source",
    family: "esrgan",
    kind: "video",
    tagline: "Fast frame-by-frame 4x upscale, in passes: any length fits in memory",
    routes: [comfy("upscale-video", "upscale-video-esrgan-chunked", "Real-ESRGAN x4, then scaled to the size asked for")],
    options: { resolutions: VIDEO_UPSCALE_TIERS },
    defaults: { resolution: "1080p" },
  }),
  // FPS Boost: interpolate by m and keep every n-th frame (src/lib/av/fps.ts), for an exact target and slow motion.
  o({
    id: "oss-rife",
    name: "RIFE interpolation",
    vendor: "Open source",
    family: "rife",
    kind: "video",
    tagline: "FPS Boost to 24–120 fps and slow motion; FILM for large motion",
    routes: [comfy("interpolate", "interpolate-rife-fps", "frame rate from the clip's header: interpolate by m, keep every n-th")],
    options: {
      fpsTargets: [...FPS_TARGETS],
      slowdowns: [...SLOW_MOTION],
      controls: [
        {
          param: "checkpoint",
          label: "Model",
          values: ["rife_v4.26.safetensors", "film_net_fp16.safetensors"],
          default: "rife_v4.26.safetensors",
          labels: { "rife_v4.26.safetensors": "RIFE 4.26 (fast)", "film_net_fp16.safetensors": "FILM (large motion, slower)" },
        },
      ],
    },
    defaults: { targetFps: DEFAULT_FPS_TARGET },
  }),
  // SDR to HDR and pro export formats (core ComfyUI and VideoHelperSuite, no model weights).
  o({
    id: "oss-sdr-to-hdr",
    name: "SDR to HDR",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "SDR footage expanded to 10-bit HDR: HLG or HDR10 (PQ) MP4, or 16-bit EXR frames",
    routes: [comfy("sdr-to-hdr", "video-sdr-to-hdr", "an inverse tone map (core ImageSDRToHDR), not a learned model")],
    options: { formats: ["hlg_10bit", "pq_10bit", "exr"], sliders: [{ param: "peakNits", label: "Peak brightness (nits)", min: 200, max: 2000, step: 50, default: 650 }] },
    defaults: { format: "hlg_10bit" },
  }),
  // NVIDIA RTX Video (nm10-rtx-video, src/lib/catalog/rtx-video.ts): Comfy-Org's NVIDIA VFX nodes on NVIDIA's RTX Video SDK,
  // only on an NVIDIA RTX card (frame generation: RTX 40 or later). Listed after each tool's own default so nothing picks
  // them by default; Upscale → Video offers "Quick · RTX" first on a card that runs it. Nobody hosts them: GPU-only.
  o({
    id: RTX_UPSCALE_MODEL,
    name: "RTX Video Super Resolution",
    vendor: "NVIDIA",
    family: "nvidia-rtx-video",
    kind: "video",
    tagline: "Fast upscale up to 4x on NVIDIA RTX cards; sharpens without adding new detail",
    badges: ["fast"],
    routes: [comfy("upscale-video", RTX_UPSCALE_WORKFLOW, "NVIDIA RTX cards only; in passes, so any length fits, sound kept")],
    options: {
      resolutions: VIDEO_UPSCALE_TIERS,
      controls: [
        {
          param: "rtxQuality",
          label: "Source",
          values: ["ULTRA", "HIGHBITRATE_ULTRA", "HIGH"],
          default: "ULTRA",
          labels: { ULTRA: "Most clips", HIGHBITRATE_ULTRA: "Clean, high quality", HIGH: "Faster" },
        },
      ],
    },
    defaults: { resolution: "1080p" },
  }),
  o({
    id: RTX_FRAMEGEN_MODEL,
    name: "RTX Frame Generation",
    vendor: "NVIDIA",
    family: "nvidia-rtx-video",
    kind: "video",
    tagline: "FPS Boost to 24–120 fps and slow motion on RTX 40 series cards and newer; keeps cuts sharp",
    badges: ["fast"],
    routes: [comfy("interpolate", RTX_FRAMEGEN_WORKFLOW, "RTX 40 series cards and newer only; frame rate from the clip's header")],
    options: {
      fpsTargets: [...FPS_TARGETS],
      slowdowns: [...SLOW_MOTION],
      controls: [
        {
          param: "rtxQuality",
          label: "Quality",
          values: ["MEDIUM", "HIGH", "LOW"],
          default: "MEDIUM",
          labels: { MEDIUM: "Balanced", HIGH: "Best", LOW: "Fastest" },
        },
      ],
    },
    defaults: { targetFps: DEFAULT_FPS_TARGET },
  }),
  o({
    id: RTX_HDR_MODEL,
    name: "RTX Video HDR",
    vendor: "NVIDIA",
    family: "nvidia-rtx-video",
    kind: "video",
    tagline: "SDR footage turned into 10-bit HDR by NVIDIA's learned HDR, on NVIDIA RTX cards: HLG or HDR10 (PQ)",
    badges: ["fast"],
    routes: [comfy("sdr-to-hdr", RTX_HDR_WORKFLOW, "NVIDIA RTX cards only; tagged BT.2020 HLG or PQ")],
    options: { formats: ["hlg_10bit", "pq_10bit"], sliders: [{ param: "peakNits", label: "Peak brightness (nits)", min: 400, max: 2000, step: 50, default: 650 }] },
    defaults: { format: "hlg_10bit" },
  }),
  o({
    id: "oss-export-video",
    name: "Pro export",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "ProRes 422 HQ or 4444, H.265 10-bit, lossless FFV1 or 16-bit EXR frames, made on your machine",
    routes: [comfy("export-video", "video-export-pro-chunked", "VideoHelperSuite with the server's ffmpeg, in passes; EXR: core SaveImageAdvanced")],
    options: { formats: ["prores_422_hq", "prores_4444", "h265_10bit", "ffv1", "h264", "exr"] },
    defaults: { format: "prores_422_hq" },
  }),
  o({
    id: "oss-mmaudio",
    name: "MMAudio",
    vendor: "hkchengrex",
    family: "mmaudio",
    kind: "video",
    tagline: "Sound effects for silent clips",
    routes: [comfy("v2a", "v2a-mmaudio")],
    options: { seed: true, negativePrompt: true },
  }),

  // ---------------- Self-test (no weights; verifies a ComfyUI connection end to end)
  o({
    id: "oss-selftest-image",
    name: "ComfyUI self-test (image)",
    vendor: "Fuobe",
    family: "selftest",
    kind: "image",
    tagline: "Inverts an image's colours",
    routes: [comfy("edit", "selftest-image")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-selftest-video",
    name: "ComfyUI self-test (video)",
    vendor: "Fuobe",
    family: "selftest",
    kind: "video",
    tagline: "Turns an image into a short flicker clip",
    routes: [comfy("i2v", "selftest-video")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-selftest-meta-batch",
    name: "ComfyUI self-test (meta-batch)",
    vendor: "Fuobe",
    family: "selftest",
    kind: "video",
    tagline: "Inverts a clip's colours, like Mixed Media",
    routes: [comfy("v2v", "selftest-meta-batch")],
    options: {},
    hidden: true,
  }),

  // ---------------- Video tools (extend, reframe, relight, draw-to-video, mattes, depth)
  o({
    id: "oss-wan22-vace-extend",
    name: "Wan 2.2 Fun VACE Extend",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Continues a clip from its last 16 frames — same look and characters",
    routes: [comfy("extend", "video-extend-wan22-fun-vace", "Lightx2v 4-step")],
    options: { durations: [3, 4, 5, 6], resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { duration: 4, resolution: "480p" },
  }),
  o({
    id: "oss-wan22-vace-reframe",
    name: "Wan 2.2 Fun VACE Reframe",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Outpaints a clip to a new aspect ratio",
    routes: [comfy("reframe", "video-reframe-wan22-fun-vace", "Lightx2v 4-step")],
    options: { aspectRatios: ["9:16", "16:9", "1:1", "4:5", "3:4", "4:3", "21:9"], resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "9:16", resolution: "480p" },
  }),
  o({
    id: "oss-wan-move",
    name: "Wan-Move",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Draw motion paths on the first frame — things move exactly along them",
    badges: ["new"],
    routes: [comfy("i2v", "draw-to-video-wan-move")],
    options: { durations: [3, 4, 5], seed: true, negativePrompt: true, motionPaths: true },
    defaults: { duration: 5 },
  }),
  o({
    id: "oss-bernini-relight",
    name: "Bernini-R Relight",
    vendor: "Bernini",
    family: "wan",
    kind: "video",
    tagline: "Relight a video from a description of the new light",
    routes: [comfy("relight-video", "video-relight-bernini-r", "Wan 2.2 fine-tune, 6 steps")],
    options: { resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { resolution: "480p" },
  }),
  o({
    id: "oss-video-matte-birefnet",
    name: "BiRefNet video matte",
    vendor: "ZhengPeng7",
    family: "birefnet",
    kind: "video",
    tagline: "Cut the subject out of every frame — a transparent WebM, or its alpha mask",
    routes: [comfy("bg-remove-video", "video-bg-remove-birefnet")],
    // The graph saves both; params.matteOutput keeps one (Video tools → Remove background: Cutout video / Alpha mask).
    options: { promptless: true, matteOutputs: ["cutout", "matte"] },
  }),
  o({
    id: "oss-video-matte-sam3",
    name: "SAM 3 video cutout",
    vendor: "Meta",
    family: "sam",
    kind: "video",
    tagline: "Keep just what you name (“the dog”, “the red car”) — a transparent WebM, or its alpha mask",
    routes: [comfy("bg-remove-video", "video-bg-remove-sam3")],
    options: { keepsNamed: true, matteOutputs: ["cutout", "matte"] },
  }),
  // Bria's VRMBG 3.0 on your GPU (nm10-keying): the model behind the cloud's Bria matte, each frame following the one before.
  // Its weights are gated (Bria approves access by hand) and placed by hand; the GPU check says so until they are there.
  o({
    id: "oss-video-matte-vrmbg3",
    name: "Bria VRMBG 3.0",
    vendor: "Bria",
    family: "bria",
    kind: "video",
    tagline: "Steady, flicker-free cut-outs that follow the subject frame to frame — the same model as the cloud's Bria matte · needs Bria's approval for the weights",
    badges: ["new"],
    routes: [comfy("bg-remove-video", "video-matte-vrmbg3", "Bria VRMBG 3.0 (gated weights, placed by hand)")],
    options: { promptless: true, matteOutputs: ["cutout", "matte"], formats: ["webm_alpha", "prores_4444", "exr"] },
    defaults: { format: "webm_alpha" },
  }),
  // Video tools → Green screen on your GPU (nm10-keying): Corridor Digital's CorridorKey 2.0 neural keyer on footage shot on
  // a green screen (its despill takes out green), at native resolution, in passes so long clips fit. The cut-out, its mask or
  // the clean foreground; WebM, ProRes 4444 with alpha, or linear EXR frames. NVIDIA RTX 30-series or newer.
  o({
    id: "oss-video-key-corridorkey",
    name: "CorridorKey 2.0",
    vendor: "Corridor Digital",
    family: "corridorkey",
    kind: "video",
    tagline: "Neural green-screen keying: clean hair, motion blur and see-through edges, with the green spill taken out",
    badges: ["new"],
    routes: [comfy("bg-remove-video", "video-key-corridorkey", "CorridorKey 2.0")],
    options: {
      promptless: true,
      greenScreen: true,
      matteOutputs: ["cutout", "matte", "foreground"],
      formats: ["webm_alpha", "prores_4444", "exr"],
      sliders: [{ param: "despill", label: "Spill cleanup", min: 0, max: 1, step: 0.05, default: 0.5 }],
    },
    defaults: { format: "webm_alpha" },
  }),
  o({
    id: "oss-video-depth-da3",
    name: "Depth Anything 3",
    vendor: "ByteDance",
    family: "depth-anything",
    kind: "video",
    tagline: "Per-frame depth maps for compositing and 3D effects · grayscale",
    routes: [comfy("depth-video", "video-depth-da3")],
    options: { colormaps: ["grayscale"], sideBySide: true },
  }),
  o({
    id: "oss-video-depth-vda",
    name: "Video Depth Anything (small)",
    vendor: "ByteDance",
    family: "depth-anything",
    kind: "video",
    tagline: "Temporally stable, flicker-free depth · grayscale or inferno",
    routes: [comfy("depth-video", "video-depth-vda-small")],
    // VideoDepthAnythingOutput draws gray or inferno only; turbo, magma and viridis are the cloud's.
    options: { colormaps: ["grayscale", "inferno"], sideBySide: true },
  }),
  // Higgsfield's Depth Map runs Video Depth Anything Large (build plan O11). Its weights are CC-BY-NC-4.0: the licence is
  // information (Settings → Models & licences lists it as Non-commercial, with a switch); the Depth map's default stays Small.
  o({
    id: "oss-video-depth-vda-large",
    name: "Video Depth Anything (large)",
    vendor: "ByteDance",
    family: "depth-anything",
    kind: "video",
    tagline: "Steady, detailed depth for video · 8 GB",
    routes: [comfy("depth-video", "video-depth-vda-large", "Video Depth Anything Large (about 1.5 GB, downloaded on first run)")],
    options: { colormaps: ["grayscale", "inferno"], sideBySide: true },
  }),
  // Remove object (Video tools → Remove object; docs/research/comfyui-oss-4.md §b). The prompt names what to remove
  // (the provider sends the objects in it to SAM 3.1 as maskPrompt; the scene the gap is filled with is
  // params.extra.prompt or a neutral default). One window per job: src/lib/catalog/remove-object.ts tiles longer clips
  // and joins them; run on its own (a Canvas node) a job does the first window only, which the taglines say.
  o({
    id: "oss-vace-remove",
    name: "Wan 2.1 VACE Remove",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Name what to remove and it's gone, every other pixel untouched · 81 frames a run (Video tools → Remove object does whole clips) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("remove-object", "video-inpaint-wan-vace", "SAM 3.1 text track + Wan 2.1 VACE 14B with the lightx2v 4-step LoRA; up to 81 frames per window")],
    options: { seed: true, negativePrompt: true },
  }),
  o({
    id: "oss-vace-remove-painted",
    name: "Wan 2.1 VACE Remove (painted)",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Paint what to remove on the first frame, and it's gone from the shot · 81 frames a run (Video tools → Remove object does whole clips) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("remove-object", "video-inpaint-wan-vace-painted", "first-frame mask (white = remove) tracked by SAM 3.1; the last frame's mask starts the next window")],
    options: { seed: true, negativePrompt: true, requires: { mask: true, msg: "Paint what to remove on the first frame" } },
  }),
  o({
    id: "oss-void-remove",
    name: "VOID Remove",
    vendor: "Netflix",
    family: "void",
    kind: "video",
    tagline: "Removes the object and what it causes — shadows, reflections, things it moves · 197 frames a run (Video tools → Remove object does whole clips) · 24–40 GB GPU",
    badges: ["new"],
    routes: [comfy("remove-object", "video-erase-void", "SAM 3.1 text track + VOID (CogVideoX-5B fine-tune), two passes; up to 197 frames per window")],
    options: { seed: true, negativePrompt: true },
  }),
  // Genjutsu's Object swap and Insert on the open engine (docs/research/comfyui-oss-4.md §c). Swap: params.extra.maskPrompt
  // names what goes (else the "replace … with" part of the prompt, see swapTarget), the first reference image is what comes
  // in, the prompt describes the result. Insert: a painted region held for the whole window. One window per job, as the
  // eraser: src/lib/catalog/genjutsu.ts tiles longer clips and joins them.
  o({
    id: "oss-vace-swap",
    name: "Wan 2.1 VACE Swap",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Name what to swap and your reference takes its place, every other pixel untouched · 81 frames a run (Genjutsu does whole clips) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("video-swap", "video-swap-wan-vace", "SAM 3.1 text track + Wan 2.1 VACE 14B with the first reference image; up to 81 frames per window")],
    options: { seed: true, negativePrompt: true, maxImages: 1 },
  }),
  o({
    id: "oss-vace-insert",
    name: "Wan 2.1 VACE Insert",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Paint where it goes on the first frame, and your reference stays there for the whole shot (a still or slow camera) · 81 frames a run (Genjutsu does whole clips) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("video-insert", "video-insert-wan-vace", "painted region (white = where it goes) held for every frame + Wan 2.1 VACE 14B with the first reference image")],
    options: { seed: true, negativePrompt: true, maxImages: 1, requires: { mask: true, msg: "Paint where it goes on the first frame" } },
  }),
  // H3 Relay 2.0 (akatz-ai/h3-relay): Akatz Labs' newer node pack for the same Character swap, native loops instead of the
  // pack's controller (Genjutsu's Character swap lists it as an alternative). It needs the pack installed (H3_RELAY=1).
  o({
    id: "oss-h3-character-swap-relay",
    name: "H3 Character Swap · Relay 2.0",
    vendor: "MiniMax × Akatz Labs",
    family: "minimax-h3",
    kind: "video",
    tagline: "Character swap with smoother long takes · 24 GB GPU with offloading, 48 GB+ advised",
    badges: ["new"],
    routes: [comfy("video-swap", "video-character-swap-h3-relay", "H3 Relay toolkit: SAM 3.1 subject, 124-frame windows with 18 frames of history, the clip's sound kept")],
    options: { seed: true, resolutions: ["480p", "768p"], maxImages: 1 },
  }),
  // Genjutsu's Openjutsu modes (D3voz/openjutsu, MIT; src/lib/openjutsu-graphs.ts): Group swap (2–4 characters by role),
  // Scene edit (change / remove / new background), From picture (the first frame, what happens, the video), Fix faces and
  // Fix colours. Your GPU only. Genjutsu offers them (each opens to everyone after its GPU test), so they stay out of the
  // composer's lists.
  o({
    id: "oss-h3-group-swap",
    name: "Group swap",
    vendor: "MiniMax × Openjutsu",
    family: "minimax-h3",
    kind: "video",
    tagline: "Up to four characters, each taking over the person you name · the clip's sound kept · 24 GB GPU",
    hidden: true,
    routes: [comfy("group-swap", "video-group-swap-h3", "Openjutsu advanced: SAM 3.1 tracks, Qwen3-VL labels each by role, MiniMax H3 + DMAD redraw them clip by clip; one by one (2 characters) runs a pass per person")],
    options: { seed: true, resolutions: ["480p", "720p", "1080p"], maxImages: 4 },
  }),
  o({
    id: "oss-h3-scene-edit",
    name: "Scene edit",
    vendor: "MiniMax × Openjutsu",
    family: "minimax-h3",
    kind: "video",
    tagline: "Change a thing, remove it or put the people somewhere new · the clip's sound kept · 24 GB GPU",
    hidden: true,
    routes: [comfy("scene-edit", "video-scene-edit-h3", "Openjutsu object: SAM 3.1 tracks what you name, MiniMax H3 + DMAD redraw only that, clip by clip")],
    options: { seed: true, resolutions: ["480p", "720p", "1080p"], maxImages: 1 },
  }),
  o({
    id: "oss-from-picture-frame",
    name: "From picture · first frame",
    vendor: "Black Forest Labs × Openjutsu",
    family: "flux",
    kind: "image",
    tagline: "Your character in the pose of the clip's first frame, in your picture's setting and light",
    hidden: true,
    routes: [comfy("picture-frame", "image-from-picture-prepare", "FLUX 3 Image Klein with its prompt upsampler; one pass for pose and light")],
    options: { seed: true, maxImages: 1 },
  }),
  o({
    id: "oss-scene-describe",
    name: "From picture · what happens",
    vendor: "Qwen × Openjutsu",
    family: "utility",
    kind: "text",
    tagline: "What happens in a part of a clip, written for the first frame you picked",
    hidden: true,
    routes: [comfy("describe-video", "video-scene-describe", "Qwen3-VL 8B at 2 frames a second, then rewritten for the picture")],
    options: { maxImages: 1 },
  }),
  // Genjutsu's "Describe my character" on a GPU: who the character in one picture is and what they wear.
  o({
    id: "oss-character-describe",
    name: "Describe my character",
    vendor: "Qwen × Openjutsu",
    family: "utility",
    kind: "text",
    tagline: "Who the character in your picture is and what they wear, in one sentence for the swap · 12 GB GPU",
    hidden: true,
    routes: [comfy("write", "character-describe-qwen3vl", "Qwen3-VL 8B on core TextGenerate, the picture at 1024 px")],
    options: { maxImages: 1, minImages: 1, promptless: true },
  }),
  o({
    id: "oss-from-picture",
    name: "From picture",
    vendor: "MiniMax × Openjutsu",
    family: "minimax-h3",
    kind: "video",
    tagline: "The first frame you approved, moving exactly like the person in the clip · the clip's sound kept · 24 GB GPU",
    hidden: true,
    routes: [comfy("picture-video", "video-from-picture-solar", "SolarRenderer: MiniMax H3 with its 4-step and control LoRAs, Metric3D normals as the motion (or native H3 + DMAD)")],
    options: { seed: true, resolutions: ["480p", "720p"], maxImages: 1 },
  }),
  o({
    id: "oss-h3-motion",
    name: "MiniMax H3",
    vendor: "MiniMax × Openjutsu",
    family: "minimax-h3",
    kind: "video",
    tagline: "Your character from one photo performs the clip's movement in the photo's own setting · the clip's sound kept · 24 GB GPU",
    hidden: true,
    routes: [comfy("motion-transfer", "video-motion-transfer-h3", "Native MiniMax H3 + DMAD: the character photo as the look, the part's Metric3D normals as the motion")],
    options: { seed: true, resolutions: ["480p", "720p"], maxImages: 1 },
  }),
  o({
    id: "oss-h3-fix-faces",
    name: "Fix faces",
    vendor: "MiniMax × Openjutsu",
    family: "minimax-h3",
    kind: "video",
    tagline: "Redraws small or soft faces in a finished video so they match your character's photo · 24 GB GPU",
    hidden: true,
    routes: [comfy("face-fix-video", "video-fix-faces-h3", "H3-FaceRefine tracking and paste-back, MiniMax H3 + DMAD in overlapping sections")],
    options: { seed: true, maxImages: 1 },
  }),
  o({
    id: "oss-fix-colours",
    name: "Fix colours",
    vendor: "Openjutsu",
    family: "utility",
    kind: "video",
    tagline: "A soft film finish for a finished video: gentler contrast, smoother detail, rich blacks · no model",
    hidden: true,
    routes: [comfy("tone-video", "video-fix-colours", "Image Detail Contrast + Orion4D's DCTL tone mapper")],
    options: {},
  }),
  // Remove object's "Remove a person (H3)" (docs/research/openjutsu-6.md §11.1): H3 Relay's Person Removal with Akatz
  // Labs' Person Remover LoRA, from a clean first frame (Remove object makes it, fits the clip to 24 fps, puts the sound back).
  o({
    id: "oss-h3-person-remove",
    name: "H3 Person Removal · Relay 2.0",
    vendor: "MiniMax × Akatz Labs",
    family: "minimax-h3",
    kind: "video",
    tagline: "Name a person and they're removed, with the scene rebuilt behind them · 24 GB GPU with offloading (Video tools → Remove object makes the clean frame and keeps the sound)",
    badges: ["new"],
    routes: [comfy("remove-object", "video-person-remove-h3-relay", "H3 Relay Person Removal: the person painted green, 22-frame windows with 18 of history from the clean first frame (image), 12 steps, silent")],
    options: { seed: true, maxImages: 1 },
  }),
  // Its mask first: the removal graph's own SAM 3.1 chain on the part's first seconds, the person
  // filled green exactly as H3 will see them. Run by Remove object's "Preview the mask", not the composer.
  o({
    id: "oss-h3-removal-mask",
    name: "SAM 3.1 green mask · H3 Person Removal",
    vendor: "Meta × Akatz Labs",
    family: "sam",
    kind: "video",
    tagline: "Who H3 Person Removal will take out: SAM 3.1 finds them, the mask is grown and filled green over the first seconds",
    routes: [comfy("bg-remove-video", "video-person-remove-h3-mask", "SAM 3.1 detect + track, threshold 0.5, grown maskGrow px, filled green: the removal's own mask")],
    options: {},
    hidden: true,
  }),
  // Character Swap Studio (/character-swap, o/h3-studio): Akatz Labs' workbench for whole clips. A segment is one H3 Relay
  // pass (its approved mask, anchor and the previous take's lossless master as history); a mask is SAM 3.1 on any frame
  // of a shot, spliced into the version it corrects. Both run through the studio, not the composer.
  o({
    id: "oss-h3-swap-segment",
    name: "H3 Character Swap · studio segment",
    vendor: "MiniMax × Akatz Labs",
    family: "minimax-h3",
    kind: "video",
    tagline: "One Character Swap segment, continued from the take before · 24 GB GPU with offloading, 48 GB+ advised",
    routes: [comfy("video-swap", "video-character-swap-h3-segment", "H3 Relay segment schedule; saves the segment and its 16-bit FFV1 master")],
    options: { seed: true, resolutions: ["480p", "768p"], maxImages: 2 },
    hidden: true,
  }),
  o({
    id: "oss-h3-person-mask",
    name: "SAM 3.1 person mask · H3 Relay",
    vendor: "Meta × Akatz Labs",
    family: "sam",
    kind: "video",
    tagline: "Who to swap in a shot: SAM 3.1 finds them on any frame (words, largest / leftmost / rightmost / #n, or clicks) and follows them; corrections splice into the mask",
    routes: [comfy("bg-remove-video", "video-mask-h3-relay", "a black-and-white mask video at H3's canvas size, 24 fps")],
    options: { keepsNamed: true, matteOutputs: ["matte"] },
    hidden: true,
  }),
  // Character swap in 2K: only the swapped character goes back over the footage, from the 768p swap and its
  // regenerate, through the person's mask (src/lib/catalog/sharpen.ts). Run by Character Swap Studio and Genjutsu.
  o({
    id: COMPOSITE_MODEL,
    name: "Character over the footage",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Puts only the swapped character back over the original footage, with its own sound · CPU",
    routes: [comfy("composite", COMPOSITE_WORKFLOW, "the swap, then its regenerate, each through the person's mask (grown, feathered); a few seconds a pass")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-qwen-relight",
    name: "Qwen-Image-Edit Relight",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Relight a photo from a description (Relight LoRA, 4 steps)",
    routes: [comfy("edit", "relight-qwen-edit-2509", "Relight LoRA + Lightning")],
    options: { seed: true, negativePrompt: true, maxImages: 1 },
    hidden: true,
  }),
  o({
    id: "oss-qwen-relight-ref",
    name: "Qwen-Image-Edit Relight (reference)",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Relight a photo to match a reference image's light (Relight LoRA, 4 steps)",
    routes: [comfy("edit", "relight-qwen-edit-2509-reference", "Relight LoRA + Lightning, image 2 = lighting reference")],
    options: { seed: true, negativePrompt: true, maxImages: 2 },
    hidden: true,
  }),
  // Storyboard's next frame on your GPU: Qwen-Image 2.1 with akhaliq's 2.1 Next-Scene LoRA (the graph loads
  // it; options.loras holds the model to its switch). The 2509 graph below stays the classic choice and the cloud's recipe.
  o({
    id: "oss-qwen-image-21-next-scene",
    name: "Qwen-Image 2.1 Next Scene",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "The next storyboard panel from the previous one, on Qwen-Image 2.1 with its Next-Scene LoRA · 20 GB GPU",
    routes: [{ ...comfy("edit", "qwen-image-21-next-scene", "2.1 Next-Scene LoRA at 0.7, 28 steps"), unsized: true }],
    options: { seed: true, maxImages: 2, controls: [QWEN21_DECODER], ...(NEXT_SCENE_21_LORA && { loras: [loraRef(NEXT_SCENE_21_LORA)] }) },
    hidden: true,
  }),
  // The Relight tool's Generate lighting (src/components/relight): the photo plus the words written from the placed
  // lights, a picture lit only by those lights that the page blends in. Image 2 is the light-guide picture, when sent.
  o({
    id: "oss-qwen-image-21-relight",
    // Its runs show this name in the Library: plain, as the tool says it (the engine is in the tagline and the licence).
    name: "Relight",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Relight with placed lights: Qwen-Image 2.1 with Viggle's 6-step speed LoRA · 24 GB GPU",
    routes: [{ ...comfy("edit", "qwen-image-21-relight", "6 steps, about 1 MP"), unsized: true }],
    options: { seed: true, maxImages: 2 },
    hidden: true,
  }),
  // Its scene read, once per photo: a depth map (Depth Anything 3) and the subject's matte (BiRefNet) for the page's
  // depth-true preview. A helper step: the Library leaves its runs out.
  o({
    id: "oss-relight-scene",
    name: "Relight scene read",
    vendor: "Open source",
    family: "birefnet",
    kind: "image",
    tagline: "Depth and subject cut-out for the Relight preview",
    routes: [comfy("bg-remove", "relight-scene-read")],
    options: { maxImages: 1 },
    hidden: true,
  }),
  // QMA camera angles: Qwen-Image 2.1 with gribbliest's QMA LoRA re-shoots a picture from one of 96 cameras. The
  // pose is the Angles app's own three settings (horizontal_angle, vertical_angle, zoom); the plan writes the LoRA's words
  // from it (promptFormat "qma", src/lib/qma.ts). Open engine only: fal's Qwen-Image 2.1 takes no LoRAs.
  o({
    id: QMA_MODEL,
    name: "QMA · 96 views",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Re-shoot a picture from any of 96 camera angles: 8 sides, 4 heights, 3 distances · on your GPU, 20 GB",
    badges: ["new"],
    routes: [{ ...comfy("edit", "qwen-image-21-qma", "QMA LoRA at 1.0, 30 steps, CFG 3"), unsized: true, maxImages: 1 }],
    options: {
      seed: true,
      maxImages: 1,
      promptFormat: "qma",
      promptOptional: true,
      promptPlaceholder: "Anything else to change (optional)",
      controls: [
        { param: QMA_PARAMS.horizontal, label: "Angle", values: QMA_AZIMUTHS.map((_, i) => i * 45), default: 45, labels: Object.fromEntries(QMA_AZIMUTHS.map((a, i) => [String(i * 45), QMA_AZIMUTH_LABELS[a]])) },
        { param: QMA_PARAMS.vertical, label: "Height", values: QMA_ELEVATIONS.map((e) => QMA_ELEVATION_DEGREES[e]), default: 0, labels: Object.fromEntries(QMA_ELEVATIONS.map((e) => [String(QMA_ELEVATION_DEGREES[e]), QMA_ELEVATION_LABELS[e]])) },
        { param: QMA_PARAMS.zoom, label: "Distance", values: QMA_DISTANCES.map((d) => QMA_DISTANCE_ZOOM[d]), default: 5, labels: Object.fromEntries(QMA_DISTANCES.map((d) => [String(QMA_DISTANCE_ZOOM[d]), QMA_DISTANCE_LABELS[d]])) },
        { param: "size", label: "Size", values: ["full", "preview"], default: "full", labels: { full: "Full · about 1 MP", preview: "Preview · 768 px, faster" }, sets: { full: { megapixels: 1 }, preview: { megapixels: 0.6 } } },
        QWEN21_DECODER,
      ],
      ...(QMA_LORA && { loras: [loraRef(QMA_LORA)] }),
    },
  }),
  // The Head Swap app's open route: image 1 = the shot to keep, image 2 = the head (hair included).
  o({
    id: "oss-qwen-head-swap",
    name: "Qwen-Image 2.1 Head Swap",
    vendor: "Alibaba Qwen × Alissonerdx",
    family: "qwen-image",
    kind: "image",
    tagline: "Puts the whole head from image 2, hair included, on the person in image 1; everything else stays the shot's own pixels · 20 GB GPU · non-commercial",
    routes: [comfy("edit", "head-swap-qwen-image-21", "BFS head LoRA V1.1; the new head pasted back onto the shot")],
    options: { seed: true, maxImages: 2, requires: { images: 2, msg: "Add the photo to keep, then a photo of the head" } },
    hidden: true,
  }),
  o({
    id: "oss-qwen-next-scene",
    name: "Qwen-Image-Edit Next Scene",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "The next storyboard panel from the previous one (next-scene LoRA)",
    routes: [comfy("edit", "storyboard-qwen-edit-2509-next-scene", "next-scene LoRA v2")],
    options: { seed: true, negativePrompt: true, maxImages: 2 },
    hidden: true,
  }),
  // The Restore Photo app's engine: AusBoss's Restore LoRA keeps the picture on its own frame (0.2 px off, the same
  // faces) where a plain edit redraws it, then SeedVR2 enlarges it 2x. Its strength (params.extra.loraStrength) comes
  // from the app's choice: 0.5 for a blurry photo, 1.0 otherwise.
  o({
    id: "oss-qwen-image-21-restore",
    name: "Qwen-Image 2.1 Restore",
    vendor: "Alibaba Qwen × AusBoss",
    family: "qwen-image",
    kind: "image",
    tagline: "Old, worn or small photos back sharp on the same frame, then enlarged 2x (Restore LoRA + SeedVR2) · 20 GB GPU · non-commercial weights",
    routes: [{ ...comfy("edit", "restore-qwen-image-21", "Restore LoRA, 25 steps at about 2 MP, then SeedVR2 2x"), unsized: true, maxImages: 1 }],
    options: { seed: true, maxImages: 1 },
    hidden: true,
  }),

  // ---------------- Audio
  o({
    id: "oss-chatterbox",
    name: "Chatterbox Multilingual",
    vendor: "Resemble AI",
    family: "chatterbox",
    kind: "audio",
    tagline: "Clone any voice from a short sample, in 23 languages",
    badges: ["top"],
    routes: [comfy("tts", "tts-chatterbox-multilingual")],
    options: { voiceClone: true, languages: CHATTERBOX_LANGUAGES, sliders: CHATTERBOX_SLIDERS, seed: true },
  }),
  o({
    id: "oss-indextts2",
    name: "IndexTTS-2",
    vendor: "Bilibili",
    family: "index-tts",
    kind: "audio",
    tagline: "Expressive zero-shot cloning",
    routes: [comfy("tts", "tts-indextts2")],
    options: { voiceClone: true },
  }),
  // Design a voice: a new voice from words, then reused by cloning the take picked (src/server/voices.ts).
  // Qwen3-TTS 1.7B runs the same weights on fal (qwen-3-tts); VoxCPM2 is hosted nowhere, so it runs on your GPU only.
  o({
    id: "oss-qwen3-tts",
    name: "Qwen3-TTS",
    vendor: "Alibaba Qwen",
    family: "qwen-tts",
    kind: "audio",
    tagline: "Design a voice from a description, or clone one from a short sample, in 10 languages",
    badges: ["new"],
    routes: [comfy("voice-design", "tts-qwen3-design"), comfy("tts", "tts-qwen3-clone")],
    options: { voiceClone: true, seed: true },
  }),
  o({
    id: "oss-voxcpm2",
    name: "VoxCPM2",
    vendor: "OpenBMB",
    family: "voxcpm",
    kind: "audio",
    tagline: "Design or clone a voice in studio-quality 48 kHz, in 30 languages",
    badges: ["new"],
    routes: [comfy("voice-design", "tts-voxcpm2"), comfy("tts", "tts-voxcpm2-clone")],
    options: { voiceClone: true, seed: true },
  }),
  // Edit speech (nm10-speech-edit): Tencent AuK (MIT) changes words, pitch, pace, emotion and noise in a recording, and
  // speaks a line in a voice. Hosted on neither fal nor Replicate, so it runs on your GPU only (src/lib/speech-edit.ts).
  o({
    id: "oss-auk",
    name: "AuK",
    vendor: "Tencent",
    family: "auk",
    kind: "audio",
    tagline: "Change what was said in a recording, or how it was said, or speak a line in a voice: English and Chinese",
    badges: ["new"],
    routes: [comfy("speech-edit", "speech-edit-auk", "every edit window in one job"), comfy("tts", "speech-tts-auk")],
    options: { voiceClone: true, seed: true },
  }),
  o({
    id: "oss-chatterbox-dialogue",
    name: "Chatterbox Dialogue",
    vendor: "Resemble AI",
    family: "chatterbox",
    kind: "audio",
    tagline: "Two speakers, each cloned from a sample",
    routes: [comfy("dialogue", "tts-dialogue-chatterbox")],
    options: {
      voiceClone: true,
      voices: [
        { id: "A", name: "Speaker A" },
        { id: "B", name: "Speaker B" },
      ],
      sliders: CHATTERBOX_SLIDERS,
      seed: true,
    },
  }),
  o({
    id: "oss-chatterbox-vc",
    name: "Chatterbox Voice Conversion",
    vendor: "Resemble AI",
    family: "chatterbox",
    kind: "audio",
    tagline: "Say it in anyone's voice — keeps your timing and emotion",
    routes: [comfy("voice-change", "voice-change-chatterbox")],
    options: { voiceClone: true, seed: true },
  }),
  o({
    id: "oss-ace-step",
    name: "ACE-Step 1.5",
    vendor: "ACE Studio × StepFun",
    family: "ace-step",
    kind: "audio",
    tagline: "Open music generation with lyrics",
    routes: [comfy("music", "music-ace-step-15")],
    options: { durations: [30, 60, 120, 180], seed: true, lyrics: {} },
    defaults: { duration: 60 },
  }),
  // Full songs on core nodes (new-models-10 §6.6). MiniMax Music 3 is the same model the cloud runs as
  // minimax-music-3 (fal hosts it); YuE2 is open-engine only (neither fal nor Replicate hosts it), and covers a song you add.
  o({
    id: "oss-minimax-music-3",
    name: "MiniMax Music 3",
    vendor: "MiniMax",
    family: "minimax-music",
    kind: "audio",
    tagline: "Full songs with expressive vocals up to 5 minutes, from your lyrics and a style",
    badges: ["new", "top"],
    routes: [comfy("music", "music-minimax-3", "int8 DiT and text encoder, 30 steps; songs over 2 minutes decode in tiles")],
    options: { durations: [30, 60, 120, 180, 240, 300], seed: true, lyrics: {} },
    defaults: { duration: 120 },
  }),
  o({
    id: "oss-yue2",
    name: "YuE2",
    vendor: "Multimodal Art Projection",
    family: "yue",
    kind: "audio",
    tagline: "Songs sung from your lyrics, or a cover of a song you add with a new style and words",
    badges: ["new"],
    routes: [comfy("music", "music-yue2-song", "plans the melody and chords, then sings; with a song added, SheetSage2 reads its melody for the cover")],
    options: { durations: [60, 120, 180, 240, 300], seed: true, lyrics: { required: true }, cover: true },
    defaults: { duration: 120 },
  }),
  // Utilities used by chained jobs (multi-shot, storyboard films, extend) and the Video tools page.
  o({
    id: "oss-join-clips",
    name: "Join clips",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Join 2–4 clips into one video, scaled to one size",
    routes: [comfy("concat", "video-concat-{n}")],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p", "1080p"] },
    defaults: { aspectRatio: "16:9", resolution: "720p" },
  }),
  // The open side of fal's extract-frame (Canvas, extend chains, Katana keyframes). Last frame by default;
  // a frame at time t: params.startTime = t, endTime = t + 0.5, extra.frameIndex = 0 (see frameRequest in lib/av-frames.ts).
  o({
    id: "oss-extract-frame",
    name: "Extract frame",
    vendor: "ComfyUI",
    family: "utility",
    kind: "image",
    tagline: "The last frame of a video, or the frame at a moment — decodes only that second · CPU",
    routes: [comfy("frame", "frame-extract", "core Trim Video window + Get Image from Batch")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-palette-image",
    name: "Palette match",
    vendor: "ComfyUI",
    family: "utility",
    kind: "image",
    tagline: "Recolour an image to the palette of a reference image",
    routes: [comfy("color-match", "palette-transfer-image")],
    options: { sliders: [{ param: "strength", label: "Strength", min: 0, max: 1, step: 0.05, default: 0.8 }] },
  }),
  o({
    id: "oss-palette-video",
    name: "Palette match (video)",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Give every frame of a video the colours of a reference image",
    routes: [comfy("color-match", "palette-transfer-video")],
    options: { sliders: [{ param: "strength", label: "Strength", min: 0, max: 1, step: 0.05, default: 0.8 }] },
  }),

  // ---------------- Round 3 (docs/research/comfyui-oss-3.md). Taglines carry the GPU memory and any licence catch.
  // Layers
  o({
    id: "oss-qwen-layered",
    name: "Qwen-Image-Layered",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Splits a picture into editable transparent layers, back to front · 24 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("layers", "layers-qwen-image-layered", "full-canvas RGBA layers with name, z and bounding box")],
    options: { seed: true, sliders: [{ param: "numLayers", label: "Layers", min: 2, max: 10, step: 1, default: 4 }] },
  }),
  o({
    id: "oss-qwen-layered-control",
    name: "Qwen-Image-Layered Control",
    vendor: "DiffSynth-Studio",
    family: "qwen-image",
    kind: "image",
    tagline: "Pulls the element you name (“the guitar”) onto its own layer · 24 GB GPU, 41 GB download",
    badges: ["new"],
    routes: [comfy("layers", "layers-qwen-image-layered-control", "prompt = the element to separate")],
    options: { seed: true, requires: { prompt: true, msg: "Name the element to pull out, e.g. “the guitar”" } },
  }),
  // Moodboards: generate in the look of reference images (op t2i with the references attached)
  o({
    id: "oss-style-qwen-edit",
    name: "Qwen-Image-Edit Style Reference",
    vendor: "Alibaba Qwen",
    family: "style-reference",
    kind: "image",
    tagline: "A new image in the look of your moodboard (1–2 collages): palette, light, grain, mood · 24 GB GPU",
    badges: ["new", "top", "fast"],
    routes: [comfy("t2i", "style-ref-qwen-edit-2511", "Qwen-Image-Edit-2511 + Lightning, 4 steps")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], maxImages: 2, seed: true, requires: { images: 1, msg: "Add 1–2 moodboard images to take the style from" } },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-style-flux2-klein",
    name: "FLUX.2 [klein] Style Reference",
    vendor: "Black Forest Labs",
    family: "style-reference",
    kind: "image",
    tagline: "Fast style transfer from up to 4 references, 4 steps · 10 GB GPU",
    badges: ["new", "fast"],
    routes: [comfy("t2i", "style-ref-flux2-klein-4b")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], maxImages: 4, seed: true, requires: { images: 1, msg: "Add 1–4 style reference images" } },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-style-krea2",
    name: "Krea 2 Style Reference",
    vendor: "Krea",
    family: "style-reference",
    kind: "image",
    tagline: "Trained for style reference (1–2 images) · 20 GB GPU",
    badges: ["new"],
    routes: [comfy("t2i", "style-ref-krea2", "Krea 2 Turbo + style_reference LoRA")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], maxImages: 2, seed: true, requires: { images: 1, msg: "Add 1–2 moodboard images to take the style from" } },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  o({
    id: "oss-style-uso",
    name: "USO Style Reference",
    vendor: "ByteDance",
    family: "style-reference",
    kind: "image",
    tagline: "Style-only reference on FLUX.1 [dev] · 20 GB GPU",
    routes: [comfy("t2i", "style-ref-uso-flux1")],
    options: { aspectRatios: IMG_AR, resolutions: ["1K", "1.5K"], maxImages: 2, seed: true, requires: { images: 1, msg: "Add 1–2 moodboard images to take the style from" } },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
  }),
  // Soul HEX: the palette in the prompt + a ColorTransfer lock to a swatch rendered from params.palette
  o({
    id: "oss-zimage-palette",
    name: "Z-Image Turbo · Palette",
    vendor: "Alibaba Tongyi",
    family: "z-image",
    kind: "image",
    tagline: "Generates in your hex colors and keeps them with a color transfer · 12 GB GPU",
    badges: ["new", "fast"],
    routes: [comfy("t2i", "palette-zimage-hex", "hex list in the prompt + ColorTransfer to a swatch")],
    options: {
      aspectRatios: IMG_AR,
      resolutions: ["1K", "1.5K", "2K"],
      seed: true,
      sliders: [{ param: "strength", label: "Palette lock", min: 0, max: 1, step: 0.05, default: 0.7 }],
      controls: [{ param: "method", label: "Colour match", values: ["mkl_lab", "reinhard_lab", "histogram"], default: "mkl_lab" }],
    },
    defaults: { aspectRatio: "1:1", resolution: "1K" },
    hidden: true,
  }),
  // Video: trim, segment, restyle, Mixed Media
  o({
    id: "oss-trim",
    name: "Trim video",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Keeps the part between a start and an end time, with its sound · CPU",
    routes: [comfy("trim", "video-trim")],
    options: {},
  }),
  // Canvas Video Concatenator: each clip cut, framed, retimed to 30 fps and given its sound (or silence) in one
  // streamed pass, so video-concat-encoded can join the clips packet by packet.
  o({
    id: "oss-fit-clip",
    name: "Fit clip",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Cuts a clip and fits it to one size and frame rate, with its sound or silence · CPU",
    routes: [comfy("trim", "video-fit-clip", "VHS loader in passes: start, length, frame rate; centre crop; sound, or silence when muted")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-segment",
    name: "Cut segment (resampled)",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "One window of a clip at a model's frame rate and size, plus its first frame · CPU",
    routes: [comfy("trim", "video-segment-resample", "VHS loader: fps, start, frame count, size")],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p"] },
    defaults: { aspectRatio: "16:9", resolution: "480p" },
    hidden: true,
  }),
  o({
    id: "oss-wan22-vace-restyle",
    name: "Wan 2.2 Fun VACE Restyle",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Re-renders a ≤5 s clip in the look of its restyled first frame, keeping the motion (depth) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("v2v", "video-restyle-wan22-fun-vace", "image = restyled first frame; Depth Anything 3 control; Lightx2v 4-step")],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p"], durations: [3, 4, 5], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "16:9", resolution: "480p", duration: 5 },
    hidden: true,
  }),
  // Blockout to film (package blockout-film): the grey box's own depth drives Wan 2.2 Fun VACE from a first frame drawn
  // from the references, one 81-frame window per job (Cinema's Blockout chains the windows). Ref2v: Canvas's "Blockout →
  // film" template hands it the depth clip and the first frame as references.
  o({
    id: "oss-wan22-vace-blockout",
    name: "Wan 2.2 Fun VACE Blockout",
    vendor: "Alibaba Wan",
    family: "wan",
    kind: "video",
    tagline: "Renders a grey-box blockout from its depth and a first frame: camera, blocking and timing kept · 24 GB GPU",
    badges: ["new"],
    routes: [
      comfy("v2v", "video-blockout-wan22-fun-vace", "video = the blockout's depth (near = bright); image = the first frame; Lightx2v 4-step"),
      comfy("ref2v", "video-blockout-wan22-fun-vace", "the depth clip and the first frame as references"),
    ],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p"], durations: [3, 4, 5], seed: true, negativePrompt: true, maxImages: 1, maxVideos: 1 },
    defaults: { aspectRatio: "16:9", resolution: "480p", duration: 5 },
    hidden: true,
  }),
  o({
    id: "oss-mixed-media",
    name: "Z-Image Mixed Media",
    vendor: "Alibaba Tongyi",
    family: "z-image",
    kind: "video",
    tagline: "Stylises every frame (sketch, comic, paper…) at 4–24 fps, outlines kept · 16 GB GPU",
    badges: ["new"],
    routes: [comfy("v2v", "mixed-media-zimage-frames", "Z-Image Turbo img2img + Fun Union ControlNet (canny), per frame")],
    options: {
      aspectRatios: ["9:16", "16:9", "1:1"],
      resolutions: ["720p"],
      durations: [2, 4, 6, 8, 10],
      seed: true,
      controls: [{ param: "fps", label: "Frame rate", values: [4, 8, 10, 12, 24], default: 8 }],
      sliders: [{ param: "denoise", label: "Style strength", min: 0.4, max: 0.9, step: 0.05, default: 0.7 }],
    },
    defaults: { aspectRatio: "9:16", resolution: "720p", duration: 4 },
  }),
  // Sound effects (text to audio)
  o({
    id: "oss-stable-audio-3",
    name: "Stable Audio 3 Small SFX",
    vendor: "Stability AI",
    family: "stable-audio",
    kind: "audio",
    tagline: "Sound effects from a description in 8 steps · 6 GB GPU",
    badges: ["new", "top", "fast"],
    routes: [comfy("sfx", "sfx-stable-audio-3-small")],
    options: { durations: [3, 5, 10, 20], seed: true, negativePrompt: true },
    defaults: { duration: 5 },
  }),
  o({
    id: "oss-stable-audio-open",
    name: "Stable Audio Open 1.0",
    vendor: "Stability AI",
    family: "stable-audio",
    kind: "audio",
    tagline: "Effects and loops up to 47 s · 6 GB GPU",
    routes: [comfy("sfx", "sfx-stable-audio-open")],
    options: { durations: [5, 10, 20, 30, 45], seed: true, negativePrompt: true },
    defaults: { duration: 10 },
  }),
  o({
    id: "oss-hunyuan-foley",
    name: "HunyuanVideo-Foley",
    vendor: "Tencent",
    family: "hunyuan",
    kind: "audio",
    tagline: "48 kHz foley from a description · 12 GB GPU",
    routes: [comfy("sfx", "sfx-hunyuan-foley")],
    options: { durations: [3, 5, 8, 10], seed: true, negativePrompt: true },
    defaults: { duration: 5 },
  }),
  // Foley that follows the picture: the same HunyuanVideo-Foley weights, fed the clip's frames (Audio → Sound for video).
  o({
    id: "oss-hunyuan-foley-video",
    name: "HunyuanVideo-Foley (video)",
    vendor: "Tencent",
    family: "hunyuan",
    kind: "video",
    tagline: "48 kHz foley in sync with your whole clip (up to 30 s), laid under the untouched picture · 12 GB GPU",
    badges: ["new"],
    // No length to pick: the sound is as long as the clip (the provider reads it from the MP4 header).
    routes: [comfy("v2a", "v2a-hunyuan-foley", "frames at 8 fps → HunyuanFoleySampler; picture stream-copied; sound as long as the clip")],
    options: { seed: true, negativePrompt: true },
  }),
  o({
    id: "oss-mmaudio-sfx",
    name: "MMAudio (text to audio)",
    vendor: "hkchengrex",
    family: "mmaudio",
    kind: "audio",
    tagline: "Sound effects from text, best at about 8 s · 8 GB GPU",
    routes: [comfy("sfx", "sfx-mmaudio-t2a")],
    options: { durations: [3, 5, 8], seed: true, negativePrompt: true },
    defaults: { duration: 8 },
  }),
  o({
    id: "oss-thinksound",
    name: "ThinkSound",
    vendor: "FunAudioLLM",
    family: "thinksound",
    kind: "audio",
    tagline: "Sound effects from a description, up to 30 s · 12 GB GPU",
    routes: [comfy("sfx", "sfx-thinksound", "isolated worker (scripts/comfy/README.md)")],
    options: { durations: [3, 5, 8, 10, 20, 30], seed: true },
    defaults: { duration: 8 },
    worker: "isolated",
  }),
  // Voice, transcription, captions, translation, lip re-sync, soundtrack
  o({
    id: "oss-voice-separate",
    name: "MelBand RoFormer + Qwen3-ASR",
    vendor: "Open source",
    family: "melband",
    kind: "audio",
    tagline: "Splits the voice from the music and effects, and transcribes the voice with timings · 8 GB GPU",
    badges: ["new"],
    routes: [comfy("separate-audio", "dub-prepare-separate-transcribe", "voice stem, background stem, timed cues, transcript")],
    options: {},
  }),
  // DBS D3: the open dub's first step with DBS for the split (graph B, docs/research/dbs-separation-7.md §4.4): the
  // background keeps the score, the sound effects and any singing. Translate & dub's "Voice split" picks it.
  o({
    id: "oss-dbs-voice-separate",
    name: "DBS + Qwen3-ASR",
    vendor: "Open source",
    family: "dbs",
    kind: "audio",
    tagline: "Splits the dialogue from the music and effects (the split runs on a CPU) and transcribes it with timings · 8 GB GPU for the transcript",
    badges: ["new"],
    routes: [comfy("separate-audio", "dub-prepare-dbs-transcribe", "voice stem, background stem (FLAC), timed cues, transcript; ComfyUI-DBS + ComfyUI-QwenASR")],
    options: {},
  }),
  // DBS (docs/research/dbs-separation-7.md): dialogue, music and effects from any soundtrack, small enough for a CPU. The
  // provider picks the model by the host (DBS-TIGER on CUDA, DBS-BSRNN otherwise) unless one is asked for, and separates
  // a file with more than 2 channels in mono (ComfyUI saves mono or stereo only). Split soundtrack (src/lib/av/split.ts) runs on it.
  o({
    id: "oss-dbs-separate",
    name: "DBS (dialogue, music, effects)",
    vendor: "Open source",
    family: "dbs",
    kind: "audio",
    tagline: "Splits a soundtrack into dialogue, music and effects · 23 MB · CPU or GPU",
    badges: ["new"],
    routes: [comfy("separate-audio", "separate-soundtrack-dbs", "voice, music, effects and music & effects (FLAC) + a speed report; ComfyUI-DBS")],
    options: {
      promptless: true,
      controls: [
        // No default: the host decides (DBS-TIGER on a CUDA GPU, DBS-BSRNN on a CPU, where it runs about 3x faster).
        { param: "separationModel", label: "Model", values: ["DBS-BSRNN-DnR", "DBS-TIGER-DnR"], labels: { "DBS-BSRNN-DnR": "Fast (DBS-BSRNN)", "DBS-TIGER-DnR": "Best (DBS-TIGER)" } },
        { param: "channels", label: "Stems", values: ["mono", "each channel"], default: "mono", labels: { mono: "Mono", "each channel": "Stereo stems (about twice as long)" } },
      ],
    },
  }),
  // DBS graph C (docs/research/dbs-separation-7.md §4.4): the split mixed back into one track at set levels (params.extra
  // voiceDb, musicDb, effectsDb; whole dB, -100 = gone). Clean up dialogue (src/lib/av/clean-dialogue.ts) runs on it: the
  // dialogue alone, or with the music and effects quietly under it.
  o({
    id: "oss-dbs-remix",
    name: "DBS remix (dialogue, music, effects at set levels)",
    vendor: "Open source",
    family: "dbs",
    kind: "audio",
    tagline: "Takes the music and effects out from under the dialogue, or keeps them quietly · 23 MB · CPU or GPU · Apache-2.0",
    badges: ["new"],
    routes: [comfy("separate-audio", "soundtrack-remix-dbs", "one FLAC: the dialogue with the music and effects at the levels asked for + a speed report; ComfyUI-DBS")],
    options: {
      promptless: true,
      controls: [
        { param: "separationModel", label: "Model", values: ["DBS-BSRNN-DnR", "DBS-TIGER-DnR"], labels: { "DBS-BSRNN-DnR": "Fast (DBS-BSRNN)", "DBS-TIGER-DnR": "Best (DBS-TIGER)" } },
        { param: "channels", label: "Channels", values: ["mono", "each channel"], default: "mono", labels: { mono: "Mono", "each channel": "Stereo (about twice as long)" } },
      ],
    },
  }),
  // NVIDIA NemotronLabs RE-USE (universal speech enhancement) on Fuobe's own ComfyUI-RE-USE pack (comfy-nodes/, no mamba-ssm):
  // noise, echo, clipping, codec damage and phone-band audio fixed, the main speaker kept. Open engine only: nothing like it is
  // hosted on fal or Replicate. params.extra.background "keep" runs voice-clean-bed-reuse (DBS keeps the music and effects;
  // src/lib/comfy-variants.ts). Clean up voice (src/lib/av/clean-voice.ts) runs on it.
  o({
    id: "oss-reuse-voice",
    name: "RE-USE (clean up voice)",
    vendor: "NVIDIA",
    family: "reuse",
    kind: "audio",
    tagline: "Removes noise, echo, clipping and codec damage from speech, restores muffled or phone audio to full band · 39 MB · CPU or GPU · OpenMDW-1.1",
    badges: ["new"],
    routes: [comfy("enhance-voice", "voice-clean-reuse", "the clean voice (FLAC) + a speed report; ComfyUI-RE-USE. Keep music & effects: voice-clean-bed-reuse (+ ComfyUI-DBS)")],
    options: {
      promptless: true,
      controls: [
        // Strength is how much of the original stays under the clean voice (room tone).
        {
          param: "strength",
          label: "Strength",
          values: ["full", "natural", "light"],
          default: "full",
          labels: { full: "Full", natural: "Natural (a little room tone)", light: "Light" },
          sets: { full: { roomToneDb: -60 }, natural: { roomToneDb: -24 }, light: { roomToneDb: -14 } },
        },
        {
          param: "reuseModel",
          label: "Model",
          values: ["NemotronLabs-RE-USE.safetensors", "NemotronLabs-RE-USE-laughter.safetensors"],
          default: "NemotronLabs-RE-USE.safetensors",
          labels: { "NemotronLabs-RE-USE.safetensors": "Voice only", "NemotronLabs-RE-USE-laughter.safetensors": "Keep laughter" },
        },
        // No default: the host decides (the source's rate on a GPU, capped on a CPU), as the composer's own Auto.
        { param: "rate", label: "Quality", values: ["48000", "16000"], labels: { "48000": "Full band 48 kHz", "16000": "Fast 16 kHz" } },
      ],
    },
  }),
  o({
    id: "oss-qwen3-asr",
    name: "Qwen3-ASR",
    vendor: "Alibaba Qwen",
    family: "qwen-asr",
    kind: "text",
    tagline: "Timed captions from speech in 30 languages (auto-detect) · 4 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("transcribe", "captions-qwen3-asr", "Qwen3-ASR 0.6B + ForcedAligner; one cue per line")],
    // "tl" is the node's second code for Filipino.
    options: { sliders: [{ param: "maxChars", label: "Characters per caption", min: 12, max: 60, step: 2, default: 32 }], sourceLanguages: Object.keys(ASR_LANGUAGES).filter((c) => c !== "tl") },
  }),
  o({
    id: "oss-captions-burnin",
    name: "Caption burn-in",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Burns timed captions into the frames chunk by chunk, keeping the sound — any length in steady memory · CPU or GPU, no model",
    badges: ["new"],
    routes: [comfy("captions", "captions-burnin", "prompt = timed lines (“0.00-2.40: Hello”) or SRT, e.g. from Qwen3-ASR")],
    options: {
      sliders: [
        { param: "fontSize", label: "Text size", min: 3, max: 12, step: 0.5, default: 6 },
        { param: "wordsPerCaption", label: "Words at a time (0 = whole line)", min: 0, max: 8, step: 1, default: 0 },
      ],
      controls: [
        { param: "captionPosition", label: "Position", values: ["bottom", "top"], default: "bottom" },
        { param: "fontColor", label: "Colour", values: ["#ffffff", "#ffd400", "#00e5ff", "#000000"], default: "#ffffff" },
      ],
    },
  }),
  o({
    id: "oss-captions-whisper",
    name: "Whisper captions",
    vendor: "OpenAI × yuvraj108c",
    family: "whisper",
    kind: "video",
    tagline: "Transcribes and burns word-by-word captions in one job, short clips (whole clip in RAM) · 6 GB GPU",
    routes: [comfy("captions", "captions-whisper-burnin", "Whisper large-v3-turbo + ComfyUI-Whisper (CC-BY-NC-SA code)")],
    options: { sliders: [{ param: "fontSize", label: "Text size (px)", min: 30, max: 160, step: 5, default: 90 }], sourceLanguages: Object.keys(WHISPER_LANGUAGES) },
  }),
  o({
    id: "oss-qwen35-translate",
    name: "Qwen3.5 4B translate",
    vendor: "Alibaba Qwen",
    family: "qwen-llm",
    kind: "text",
    tagline: "Translates text or timed caption lines, timings kept · 10 GB GPU",
    routes: [comfy("translate", "translate-qwen35-textgen")],
    options: { seed: true },
    hidden: true,
  }),
  o({
    id: "oss-gemma4-speech-translate",
    name: "Gemma 4 speech translate",
    vendor: "Google",
    family: "gemma",
    kind: "text",
    tagline: "Speech straight to translated text, no timings (voice-over dubs) · 12 GB GPU",
    routes: [comfy("translate", "speech-translate-gemma4")],
    options: { seed: true },
    hidden: true,
  }),
  // Content Factory "Use as reference": the clip's frames and its sound in one Gemma 4 call → a JSON style brief.
  o({
    id: "oss-reference-brief",
    name: "Reference brief (Gemma 4)",
    vendor: "Google",
    family: "gemma",
    kind: "text",
    tagline: "Watches a reference clip and writes up its style · 12 GB GPU",
    routes: [comfy("write", "reference-brief-gemma4", "first 30 s at 24 fps (every 24th frame read, 384 px wide) with the soundtrack; startTime skips ahead")],
    options: { seed: true, promptless: true },
    hidden: true,
  }),
  o({
    id: "oss-infinitetalk-v2v",
    name: "InfiniteTalk Lip Re-sync",
    vendor: "MeiGen",
    family: "infinitetalk",
    kind: "video",
    tagline: "Re-syncs the lips (and head) of real footage to a new voice, up to 40 s per job; camera and background stay · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("lipsync", "lipsync-v2v-infinitetalk", "video-to-video, 4 steps from step 2; keeps the source's shape")],
    options: { aspectRatios: ["auto", ...VID_AR], resolutions: ["480p", "720p"], seed: true, negativePrompt: true },
    defaults: { aspectRatio: "auto", resolution: "480p" },
  }),
  o({
    id: "oss-latentsync",
    name: "LatentSync 1.6",
    vendor: "ByteDance",
    family: "latentsync",
    kind: "video",
    tagline: "Re-syncs only the mouth of real footage to a new voice; face, camera and background untouched · 20 GB GPU",
    routes: [comfy("lipsync", "lipsync-latentsync16", "isolated worker (scripts/comfy/README.md)")],
    options: {
      seed: true,
      sliders: [
        { param: "lipsExpression", label: "Lip movement", min: 1, max: 3, step: 0.1, default: 1.5 },
        { param: "steps", label: "Steps", min: 10, max: 50, step: 1, default: 20 },
      ],
    },
    worker: "isolated",
  }),
  o({
    id: "oss-mux",
    name: "Add soundtrack",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Puts a new soundtrack on a video, optionally mixed over a background track; the picture is copied untouched · CPU",
    routes: [comfy("mux", "video-mux-audio", "one track: video-mux-audio-replace; two: voice + background mix")],
    options: { sliders: [{ param: "backgroundVolumeDb", label: "Background level (dB)", min: -30, max: 6, step: 1, default: 0 }] },
  }),
  o({
    id: "oss-audio-timeline",
    name: "Voice timeline",
    vendor: "ComfyUI",
    family: "utility",
    kind: "audio",
    tagline: "Places spoken lines at their cue times on a silent track as long as the video (dub voices) · CPU",
    routes: [comfy("timeline", "audio-timeline", "one loader per line, expanded per request")],
    options: {},
    hidden: true,
  }),
  // Faceless / Explainer "Frame by frame" and the Audio hub's Loop / extend and Join (r4/faceless-plus): core nodes, no model.
  o({
    id: "oss-ken-burns",
    name: "Ken Burns",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "A slow pan and zoom over a still, up to 10 s a clip · no model, runs on CPU",
    routes: [comfy("still-motion", "kenburns-still", "zoom + pan, eased or linear; 10 s per job, longer scenes are split and joined")],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p", "1080p"], maxImages: 1, promptless: true },
    defaults: { aspectRatio: "16:9", resolution: "720p" },
    hidden: true,
  }),
  o({
    id: "oss-join-encoded",
    name: "Join clips, fast",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Joins clips the open engine made, packet by packet: no decode, flat memory · CPU",
    routes: [comfy("concat", "video-concat-encoded", "one loader per clip; the clips share one size and frame rate")],
    options: {},
    hidden: true,
  }),
  o({
    id: "oss-audio-loop",
    name: "Crossfade loop",
    vendor: "ComfyUI",
    family: "utility",
    kind: "audio",
    tagline: "Extends a clip to any length up to 10 minutes, crossfading every seam and fading out at the end · CPU",
    routes: [comfy("audio-loop", "audio-loop-crossfade", "equal-power seams; the fade curve is written per job")],
    options: { promptless: true },
    hidden: true,
  }),
  o({
    id: "oss-audio-join",
    name: "Crossfade join",
    vendor: "ComfyUI",
    family: "utility",
    kind: "audio",
    tagline: "Clips one after another with a crossfade at every seam · CPU",
    routes: [comfy("audio-join", "audio-join-crossfade", "every clip in one job")],
    options: { maxAudios: 10, promptless: true },
    hidden: true,
  }),
  // Product 3D, try-on. Every image-to-3D route on ComfyUI (Pixal3D, TRELLIS.2 from one photo or several, Hunyuan3D 2.1) ends in the
  // server's finish (src/server/model3d-finish.ts): a web GLB and, when Chromium and ffmpeg are there, a
  // CPU-rendered turntable video.
  o({
    id: "oss-pixal3d",
    name: "Pixal3D",
    vendor: "Tencent ARC",
    family: "trellis",
    kind: "model3d",
    tagline: "A textured 3D model (.glb) that stays true to your photo (camera-aware), plus a turntable video · 16 GB GPU",
    badges: ["new", "top"],
    routes: [comfy("image-to-3d", "image-to-3d-pixal3d", "MoGe-2 camera → Pixal3D; ~250k triangles; web GLB + turntable made after the job")],
    options: { seed: true, controls: [HI3D_REFINE_CONTROL] },
  }),
  o({
    id: "oss-trellis2",
    name: "TRELLIS.2",
    vendor: "Microsoft",
    family: "trellis",
    kind: "model3d",
    tagline: "A textured 3D model (.glb) from one product photo, plus a turntable video; the fallback to Pixal3D · 16 GB GPU",
    badges: ["new"],
    routes: [comfy("image-to-3d", "image-to-3d-trellis2", "~250k triangles; web GLB + turntable made after the job")],
    options: { seed: true, controls: [HI3D_REFINE_CONTROL] },
  }),
  o({
    id: "oss-hunyuan3d-21",
    name: "Hunyuan3D 2.1",
    vendor: "Tencent",
    family: "hunyuan",
    kind: "model3d",
    tagline: "Untextured 3D shape from a photo · 10 GB GPU",
    routes: [comfy("image-to-3d", "image-to-3d-hunyuan3d-21")],
    options: { seed: true, controls: [HI3D_REFINE_CONTROL] },
  }),
  // hi3d-refine (docs/research/hi3d-refine.json): Hi3D 1.0 refines a finished model's geometry from the photo it came from.
  // Nobody hosts the open model, so it is open-engine only. Geometry only; its results carry "Powered by Hi3D 1.0".
  o({
    id: "oss-hi3d-refine",
    name: "Hi3D 1.0",
    vendor: "Hi3D (Sparc3D)",
    family: "hi3d",
    kind: "model3d",
    tagline: "Refines a 3D model's geometry at 512, 1024 or 1536 from the photo it was made from; geometry only, no colour · Ampere GPU or newer, CUDA 12 · Powered by Hi3D 1.0",
    badges: ["new"],
    routes: [comfy("refine-3d", "mesh-refine-hi3d", "coarse GLB + photo → BiRefNet mask → Hi3D refine (25 steps a pass) → GLB, recentred at unit radius")],
    options: { seed: true, minImages: 1, maxImages: 1, promptless: true },
    engineNote: "Runs on your GPU only: no cloud service hosts the open Hi3D model.",
    hidden: true,
  }),
  // Round 4 (r4/3d-plus): Image to 3D's other modes on the open engine.
  o({
    id: "oss-trellis2-multi",
    name: "TRELLIS.2 Multi-view",
    vendor: "Tencent ARC × Microsoft",
    family: "trellis",
    kind: "model3d",
    tagline: "One textured 3D model (.glb) from photos of 2–4 sides of an object, plus a turntable video · 16 GB GPU",
    badges: ["new"],
    // params.extra.views names each photo's side ("front", "left", "back", "right"); the front is needed.
    routes: [comfy("image-to-3d", "image-to-3d-trellis2-multiview", "Pixal3D multi-view on TRELLIS.2; the front, then any of left, back and right")],
    options: { seed: true, minImages: 2, maxImages: 4, controls: [HI3D_REFINE_CONTROL] },
  }),
  o({
    id: "oss-text-trellis2",
    name: "Qwen-Image 2.1 → TRELLIS.2",
    vendor: "Alibaba Qwen × Microsoft",
    family: "trellis",
    kind: "model3d",
    tagline: "Describe one object and get a textured 3D model with a turntable · 20 GB GPU",
    badges: ["new"],
    // Built on the server as two steps: a Qwen-Image 2.1 still, then image-to-3d-trellis2 on it (src/server/chains.ts).
    routes: [{ op: "text-to-3d", provider: "comfyui", endpoint: "image-to-3d-trellis2", chained: true, note: "a Qwen-Image 2.1 still → TRELLIS.2" }],
    options: { seed: true },
  }),
  o({
    id: "oss-triposplat",
    name: "TripoSplat",
    vendor: "Tripo (VAST)",
    family: "tripo",
    kind: "model3d",
    tagline: "A soft, photoreal 3D capture of the subject in one photo, plus an orbit video · 8 GB GPU",
    badges: ["new"],
    routes: [comfy("splat", "image-to-splat-triposplat", "BiRefNet cut-out → TripoSplat → .spz + a 3 s orbit")],
    options: {
      seed: true,
      maxImages: 1,
      sliders: [{ param: "numGaussians", label: "Gaussians", min: 32768, max: 1048576, step: 32768, default: 262144 }],
    },
  }),
  // Any Angle (app-any-angle, src/lib/catalog/any-angle.ts): two helpers its page runs, hidden from the pickers. The 3D view of
  // a photo, built once (TripoSplat with the cut-out, fixed seeds, a turntable the front view is measured on, a GLB)…
  o({
    id: ANY_ANGLE.buildModel,
    name: "Any Angle 3D view",
    vendor: "Tripo (VAST)",
    family: "tripo",
    kind: "model3d",
    tagline: "A 3D view of the photo's subject for picking camera angles · 8 GB GPU",
    routes: [comfy("splat", ANY_ANGLE.buildGraph, "BiRefNet cut-out → TripoSplat (seed 46) → .spz, a 48-frame turntable, its sweep and a GLB")],
    options: { maxImages: 1, promptless: true },
    hidden: true,
  }),
  // …and one angle from it: the view rendered at the camera, repainted by Qwen-Image 2.1 with the AnyAngle LoRA (its own
  // prompt, so no words of the visitor's). No hosted Qwen-Image 2.1 takes the LoRA, so it runs on a GPU only.
  o({
    id: ANY_ANGLE.shotModel,
    name: "Any Angle",
    vendor: "Qwen (Alibaba) · lilylilith",
    family: "qwen-image",
    kind: "image",
    tagline: "The same photo from a camera you pick: a 3D view rendered there and repainted · Qwen-Image 2.1 + AnyAngle LoRA · 32 GB GPU",
    routes: [comfy("edit", ANY_ANGLE.shotGraph, "the saved 3D view rendered at the camera → Qwen-Image 2.1 int8 + AnyAngle LoRA, 25 steps, cfg 1")],
    options: { maxImages: 1, seed: true, promptless: true, ...(ANY_ANGLE_LORA && { loras: [ANY_ANGLE_LORA] }) },
    hidden: true,
  }),
  // Idol 3D (docs/research/idol-9.md): Speridlabs' Idol, TripoSplat's architecture retrained, on the same core nodes. Its cloud twin
  // is "idol-3d" (fal speridlabs/idol, cloud-models.generated.ts).
  o({
    id: "oss-idol",
    name: "Idol 3D",
    vendor: "Speridlabs",
    family: "idol",
    kind: "model3d",
    tagline: "A Gaussian splat (.spz) of one object from one picture, plus an orbit video · TripoSplat's architecture, retrained · 8 GB GPU · Apache-2.0 · Built with DINOv3",
    badges: ["new"],
    routes: [comfy("splat", "image-to-splat-idol", "Idol on the TripoSplat core nodes → .spz + a 3 s orbit")],
    options: {
      seed: true,
      maxImages: 1,
      sliders: [
        { param: "numGaussians", label: "Gaussians", min: 32768, max: 1048576, step: 32768, default: 262144 },
        { param: "steps", label: "Steps", min: 10, max: 50, step: 1, default: 50 },
      ],
    },
  }),
  // Idol 3D quick mesh (docs/research/idol-9.md §9): Idol's splat turned into a rough vertex-coloured mesh by core SplatToMesh, in From an
  // image. Nobody hosts it (fal's speridlabs/idol gives a splat only), so it is open-engine only.
  o({
    id: "oss-idol-mesh",
    name: "Idol 3D quick mesh",
    vendor: "Speridlabs",
    family: "idol",
    kind: "model3d",
    tagline: "A rough vertex-coloured .glb from one picture, no textures · 8 GB GPU · Apache-2.0 · Built with DINOv3",
    badges: ["new"],
    routes: [comfy("image-to-3d", "image-to-mesh-idol", "Idol splat → core Extract Mesh from Splat → vertex-coloured .glb + a 3 s orbit")],
    options: {
      seed: true,
      maxImages: 1,
      sliders: [{ param: "meshResolution", label: "Mesh detail", min: 128, max: 768, step: 64, default: 384 }],
      controls: [HI3D_REFINE_CONTROL],
    },
    engineNote: "Runs on your GPU only: no cloud service makes this mesh.",
  }),
  // Photo to 3D: Idol (TripoSplat's architecture, Speridlabs' weights) on core nodes; its splat becomes the GLB (SplatToMesh), with the
  // .spz and an orbit clip of the splat beside it (docs/research/idol-9.md). Not hosted anywhere: open engine only.
  o({
    id: "oss-idol-3d",
    name: "Idol 3D Mesh",
    vendor: "Speridlabs",
    family: "tripo",
    kind: "model3d",
    tagline: "A quick 3D model (.glb) of a person or product from one photo, plus an orbit clip · 8 GB GPU · Apache-2.0 · Built with DINOv3",
    badges: ["new"],
    routes: [comfy("image-to-3d", "image-to-3d-idol", "BiRefNet cut-out → Idol → mesh from the splat + .spz + a 4 s orbit")],
    options: { seed: true, maxImages: 1 },
  }),
  // Round 4 (r4/cinema-3d): Cinema Studio's "Create 3D scene". The mesh is in the photo's own camera space
  // (glTF axes, metres), so the viewer starts where the photo was taken.
  o({
    id: "oss-scene-moge",
    name: "MoGe 2 scene",
    vendor: "Microsoft",
    family: "moge",
    kind: "model3d",
    tagline: "The whole photo as a textured 3D mesh to fly a camera through, plus its depth map · runs on a CPU too (a minute or two)",
    badges: ["new"],
    routes: [comfy("scene-3d", "scene-mesh-moge", "MoGe 2 point map → textured GLB of the whole frame + a depth PNG")],
    options: {
      sliders: [
        { param: "resolutionLevel", label: "Detail", min: 0, max: 9, step: 1, default: 9 },
        { param: "decimation", label: "Mesh thinning (1 = every pixel)", min: 1, max: 4, step: 1, default: 1 },
      ],
    },
  }),
  // N7-5: Cinema's "Film this path" on the GPU. The browser renders the 3D scene along the path (Uni3C's render_video);
  // Wan 2.1 I2V starts from the still and Uni3C keeps its camera on the render. 81 frames at 16 fps, always.
  o({
    id: "oss-uni3c-path",
    name: "Wan 2.1 + Uni3C path",
    vendor: "Alibaba (Wan, DAMO Uni3C)",
    family: "wan",
    kind: "video",
    tagline: "A still filmed along the camera path you fly in the 3D scene · 5 s · ~48 GB GPU",
    badges: ["new"],
    hidden: true,
    routes: [comfy("camera-path", "wan21-i2v-uni3c-path", "your browser's render of the path guides Wan 2.1 I2V 720P through core Uni3C")],
    options: {
      resolutions: ["480p", "720p"],
      aspectRatios: ["auto", ...VID_AR],
      seed: true,
      maxImages: 1,
      requires: { images: 1, video: true, msg: "Add the still and the render of the path (Cinema's 3D scene records it when you film a path)" },
    },
    defaults: { resolution: "480p", aspectRatio: "auto" },
  }),
  // World mode (nm10-hy-nomas-world): Hy-Nomas (Tencent Hunyuan, Apache-2.0) through Nynxz's ComfyUI port, a world described
  // once and steered turn by turn. Hosted on neither fal nor Replicate: open engine only. Cinema's World take runs it
  // (src/lib/world.ts); it isn't a model of the Video studio's menu.
  o({
    id: "oss-hy-nomas-world",
    name: "Hy-Nomas",
    vendor: "Tencent Hunyuan",
    family: "hy-nomas",
    kind: "video",
    tagline: "A world you describe once, then steer turn by turn with words and camera moves · 1280 × 704 at 24 fps · Apache-2.0",
    badges: ["new"],
    hidden: true,
    routes: [comfy("world-turn", "world-hy-nomas-turn", "the opening and every turn before this one, then this turn's clip")],
    options: { seed: true },
  }),
  // N7-9: WorldCast (PixCtrol) on the WorldCast worker, outside ComfyUI (docs/workers/worldcast.md). Fly path, Turnaround and
  // the exact orbits prefer it when the worker answers: the still's depth (MoGe 2), SAM 3.1 masks of the still and the views,
  // then one case; the back and sides follow the views. 81 frames, portrait 480 × 832, 15 fps.
  o({
    id: "oss-worldcast",
    name: "WorldCast",
    vendor: "PixCtrol (Xiaomi MiLM Plus, Wuhan University)",
    family: "wan",
    kind: "video",
    tagline: "A still filmed along an exact camera path, with the back and sides following your own views · portrait 480 × 832, 5.4 s · 48 GB+ GPU · Apache-2.0",
    badges: ["new"],
    hidden: true,
    routes: [{ op: "camera-path", provider: "worldcast", endpoint: "cases", note: "WorldCast on Wan 2.1 I2V 720P, on your WorldCast worker" }],
    licence: {
      licence: "Apache-2.0",
      commercial: true,
      note:
        "Apache-2.0 (code at PixCtrol/WorldCast 7ccf2e0d; weights ly56/worldcast 27635f27, on Wan2.1-I2V-14B-720P, Apache-2.0). Stage 1 trained on SpatialVID (CC BY-NC-SA 4.0), which the authors say they used \"strictly for academic research purposes and not for any commercial applications\"",
      checked: "2026-11-02",
    },
    options: {
      seed: true,
      maxImages: 11,
      aspectRatios: ["9:16"],
      requires: { images: 1, msg: "Add the still to film" },
    },
    defaults: { aspectRatio: "9:16" },
  }),
  // N7-9: the paper's own depth models, on the WorldCast worker when it has them (GET /health "depth"): MoGe 2 stays the default.
  o({
    id: "oss-depth-pro",
    name: "Depth Pro",
    vendor: "Apple",
    family: "depth-pro",
    kind: "image",
    tagline: "Metric depth of one photo, the depth WorldCast's paper used · on your WorldCast worker · Apple research licence (no commercial use)",
    hidden: true,
    routes: [{ op: "edit", provider: "worldcast", endpoint: "depth/depth-pro", note: "apple/DepthPro on the WorldCast worker" }],
    licence: {
      licence: "Apple ML Research License (research only; non-commercial)",
      commercial: false,
      note: "apple/DepthPro ccd1350a: research use only; it \"does not include any commercial exploitation, product development or use in any commercial product or service\"",
      checked: "2026-11-02",
    },
    options: { maxImages: 1, requires: { images: 1, msg: "Add the still" } },
  }),
  o({
    id: "oss-vggt-omega",
    name: "VGGT-Omega",
    vendor: "Meta FAIR",
    family: "vggt",
    kind: "image",
    tagline: "Depth and cameras of a photo, the poses WorldCast's paper used · on your WorldCast worker · FAIR Noncommercial (gated download)",
    hidden: true,
    routes: [{ op: "edit", provider: "worldcast", endpoint: "depth/vggt-omega", note: "facebook/VGGT-Omega on the WorldCast worker (gated: the worker needs a Hugging Face token)" }],
    licence: {
      licence: "FAIR Noncommercial Research License",
      commercial: false,
      note: "facebook/VGGT-Omega 1041e80f: FAIR Noncommercial Research License; a gated download that Meta approves by hand",
      checked: "2026-11-02",
    },
    options: { maxImages: 1, requires: { images: 1, msg: "Add the still" } },
  }),
  // N7-9: the person's mask in a picture (SAM 3.1), for WorldCast's still and views.
  o({
    id: "oss-person-mask",
    name: "SAM 3.1 person mask",
    vendor: "Meta",
    family: "sam",
    kind: "image",
    tagline: "A black-and-white mask of the person in a picture · 4 GB GPU · Meta SAM License",
    hidden: true,
    routes: [comfy("bg-remove", "image-person-mask-sam3", "SAM 3.1 finds the person: white where they are")],
    options: { maxImages: 1, requires: { images: 1, msg: "Add the picture" } },
  }),
  o({
    id: "oss-tryon-klein",
    name: "FLUX.2 [klein] Try-On",
    vendor: "Black Forest Labs × xocialize",
    family: "flux",
    kind: "image",
    tagline: "Dresses the person in image 1 in the garment in image 2 (a top, dress or outfit) and an optional bottom in image 3 · 10 GB GPU",
    badges: ["new", "fast"],
    routes: [comfy("edit", "tryon-flux2-klein-4b", "try-on LoRA; old outfit masked out first")],
    // The graph loads the try-on LoRA itself; carrying it here lets Settings → Models & licences switch it off (as Fuobe Try-On's).
    options: { maxImages: 3, seed: true, requires: { images: 2, msg: "Add a photo of the person, then the garment" }, ...(TRYON_LORA && { loras: [loraRef(TRYON_LORA)] }) },
  }),
  // Outfit Swap (the open route of the Outfit Swap app): AusBoss's Outfit Swap LoRA on Qwen-Image 2.1 keeps the person
  // picture in place, so only the clothes change. With an outfit photo Qwen3-VL describes it first; without one the words
  // are the outfit (src/lib/comfy-variants.ts picks the graph by the pictures given).
  o({
    id: "oss-outfit-swap",
    name: "Qwen-Image 2.1 Outfit Swap",
    vendor: "Alibaba Qwen × AusBoss",
    family: "qwen-image",
    kind: "image",
    tagline: "Only the clothes change: from a photo of the outfit, or from words · 20 GB GPU · non-commercial weights",
    badges: ["new"],
    routes: [{ ...comfy("edit", "outfit-swap-qwen-image-21", "Outfit Swap LoRA, 25 steps; the outfit photo described first"), unsized: true }],
    options: {
      maxImages: 2,
      seed: true,
      promptOptional: true,
      requires: { images: 2, promptInstead: true, msg: "Add your photo and the outfit's, or describe the outfit" },
    },
    hidden: true,
  }),
  // Product shot (the open route of the Product shot app): cut out, on white, relit into the scene you describe.
  o({
    id: "oss-product-shot",
    name: "Qwen-Image-Edit Product Shot",
    vendor: "Alibaba Qwen × dx8152",
    family: "qwen-image",
    kind: "image",
    tagline: "Cuts your product out and relights it into the scene you describe (White_to_Scene LoRA, 4 steps) · 24 GB GPU",
    badges: ["new"],
    routes: [comfy("edit", "product-shot-qwen-edit-2509", "BiRefNet cut-out on white → Qwen-Image-Edit 2509 + White_to_Scene LoRA")],
    options: { seed: true, negativePrompt: true, maxImages: 1, requires: { prompt: true, msg: "Describe the scene to put the product in, e.g. “on a marble counter, morning light”" } },
  }),
  // Steam It (the open route of the Steam It app): the clothes found and pressed, every other pixel kept.
  o({
    id: "oss-steam-it",
    name: "Qwen-Image 2.1 Steam It",
    vendor: "Alibaba Qwen",
    family: "qwen-image",
    kind: "image",
    tagline: "Finds the clothes and presses them smooth; the person, pose and background stay exactly as they were · 20 GB GPU · non-commercial weights",
    routes: [{ ...comfy("edit", "steam-it-qwen-image-21", "SAM 3.1 finds the clothes; Qwen-Image 2.1 repaints only them, 25 steps, pasted back"), unsized: true, maxImages: 1 }],
    options: { seed: true, maxImages: 1, requires: { images: 1, msg: "Add a photo of the outfit" } },
    hidden: true,
  }),
  // Cinema Studio grid and Soul Cast (used by those studios)
  o({
    id: "oss-zimage-grid",
    name: "Z-Image Turbo · Grid",
    vendor: "Alibaba Tongyi",
    family: "z-image",
    kind: "image",
    tagline: "One prompt, a whole contact sheet (2×2 to 4×4) that shares one look, cut into tiles · 14 GB GPU",
    routes: [comfy("t2i", "grid-zimage-contact-sheet", "outputs: the sheet, then the tiles")],
    options: {
      aspectRatios: ["16:9", "1:1", "9:16"],
      resolutions: ["2K"],
      seed: true,
      controls: [
        { param: "columns", label: "Columns", values: [2, 3, 4], default: 3 },
        { param: "rows", label: "Rows", values: [2, 3, 4], default: 3 },
      ],
    },
    defaults: { aspectRatio: "16:9", resolution: "2K" },
    hidden: true,
  }),
  o({
    id: "oss-zimage-soul-cast",
    name: "Z-Image Turbo · Soul Cast sheet",
    vendor: "Alibaba Tongyi",
    family: "z-image",
    kind: "image",
    tagline: "A cast member as a turnaround sheet (front, three-quarter, profile, back) plus the four views · 14 GB GPU",
    routes: [comfy("t2i", "soul-cast-sheet-zimage", "outputs: the sheet, then the four views")],
    options: { seed: true },
    defaults: {},
    hidden: true,
  }),
];

/** fal's FFmpeg utilities (docs/research/paid-model-apis-2.md): the cloud side of join clips and Kling extend. */
const cloudTools: ModelDef[] = [
  {
    id: "join-clips",
    name: "Join clips",
    vendor: "fal",
    family: "utility",
    engine: "cloud",
    kind: "video",
    tagline: "Join clips into one video, in order",
    routes: [{ op: "concat", provider: "fal", endpoint: "fal-ai/ffmpeg-api/merge-videos", map: { prompt: false, videos: "video_urls" } }],
    options: {},
    pricing: { unit: "request", usd: 0, note: "billed per compute second, ≈ free" },
  },
  {
    id: "extract-frame",
    name: "Extract frame",
    vendor: "fal",
    family: "utility",
    engine: "cloud",
    kind: "image",
    tagline: "The first, middle or last frame of a video",
    routes: [{ op: "frame", provider: "fal", endpoint: "fal-ai/ffmpeg-api/extract-frame", map: { prompt: false, video: "video_url", fixed: { frame_type: "last" } } }],
    options: {},
    pricing: { unit: "request", usd: 0.001 },
    hidden: true,
  },
  {
    // Shorts Studio: a clip cropped to 9:16 or 16:9 before a restyle model that keeps its input's shape.
    id: "scale-video",
    name: "Crop to size",
    vendor: "fal",
    family: "utility",
    engine: "cloud",
    kind: "video",
    tagline: "Centre-crop (or pad) a clip to an exact size, no AI",
    // Size in params.extra {width, height} (even numbers); "crop" scales to cover, then centre-crops.
    routes: [{ op: "reframe", provider: "fal", endpoint: "fal-ai/workflow-utilities/scale-video", map: { prompt: false, video: "video_url", defaults: { mode: "crop" } } }],
    options: {},
    pricing: { unit: "request", usd: 0.001, note: "billed per compute second" },
    hidden: true,
  },
  // Faceless Studio / Explainer (docs/research/paid-model-apis-3.md §12): the voice-over and a music bed on one film.
  {
    id: "ffmpeg-compose",
    name: "Mix voice and music",
    vendor: "fal",
    family: "utility",
    engine: "cloud",
    kind: "video",
    tagline: "Puts a voice-over and a background track on a video in one pass",
    routes: [{ op: "mux", provider: "fal", endpoint: "fal-ai/ffmpeg-api/compose", map: { prompt: false, tracks: "tracks" } }],
    options: { promptless: true },
    pricing: { unit: "second", usd: 0.0002 },
    hidden: true,
  },
  {
    id: "ffmpeg-loudnorm",
    name: "Level audio",
    vendor: "fal",
    family: "utility",
    engine: "cloud",
    kind: "audio",
    tagline: "Sets a track's loudness (EBU R128), e.g. a music bed well under a voice",
    routes: [{ op: "level", provider: "fal", endpoint: "fal-ai/ffmpeg-api/loudnorm", map: { prompt: false, audio: "audio_url", defaults: { integrated_loudness: -18 } } }],
    options: { promptless: true },
    pricing: { unit: "request", usd: 0, note: "billed per compute second, ≈ free" },
    hidden: true,
  },
  {
    id: "elevenlabs-align",
    name: "ElevenLabs Forced Alignment",
    vendor: "ElevenLabs",
    family: "elevenlabs",
    engine: "cloud",
    kind: "text",
    tagline: "Word timings for a known script and its recording",
    routes: [{ op: "transcribe", provider: "fal", endpoint: "fal-ai/elevenlabs/forced-alignment", map: { prompt: "text", audio: "audio_url" } }],
    options: {},
    pricing: { unit: "request", usd: 0.22, note: "$0.22 per started hour of audio" },
    hidden: true,
  },
];

/**
 * Kling has no extend endpoint: Fuobe continues a clip from its last frame with Kling's own
 * image-to-video and joins the two (fal's FFmpeg tools; src/server/chains.ts).
 */
function withLastFrameExtend(m: ModelDef): ModelDef {
  const i2v = m.routes.find((r) => r.op === "i2v" && r.provider === "fal");
  if (m.family !== "kling" || m.kind !== "video" || !i2v || m.routes.some((r) => r.op === "extend")) return m;
  return { ...m, routes: [...m.routes, { op: "extend", provider: "fal", endpoint: LAST_FRAME_CHAIN, note: "last frame → Kling image-to-video → joined" }] };
}

/**
 * Cloud models (fal and Replicate) and the cloud tools. A launch price (FLUX 3 Max, H3 Max camera controls) stays in
 * Pricing.promo beside the list price: whoever prices reads the clock (./promo), never the catalog, so the studios'
 * slices and the pages prerendered at build time carry both and the browser shows the one of the day it is.
 */
const cloud: ModelDef[] = [...CLOUD_MODELS.map(withLastFrameExtend), ...cloudTools];

// ---------------------------------------------------------------------------
// Fuobe Originals: one model on both engines

const ORIGINAL_HALVES = new Map(ORIGINAL_CLOUD.map((m) => [m.id, m]));

/**
 * A Fuobe Original (build plan O2+): its ComfyUI routes on the user's GPU and its cloud half on hosted open weights
 * (generated from the research by scripts/gen-cloud-models.py), as one model that runs on both engines. The open
 * engine is listed first: it's free. The options are the Original's own (the same on both engines).
 */
function original(spec: { id: string; open: ModelRoute[]; options: ModelOptions; tagline?: string }): ModelDef {
  const cloud = ORIGINAL_HALVES.get(spec.id);
  if (!cloud) throw new Error(`${spec.id} has no cloud half in cloud-models.generated.ts (run pnpm gen:catalog)`);
  return {
    ...cloud,
    engine: "open",
    engines: ["open", "cloud"],
    tagline: spec.tagline ?? cloud.tagline,
    badges: ["new"],
    routes: [...spec.open, ...cloud.routes],
    options: spec.options,
  };
}

/** Fuobe DoP on both engines: a start frame (and an end frame for a transition), 3 or 5 s (49 or 81 frames at 16 fps on Wan). */
const DOP_OPTIONS: ModelOptions = {
  aspectRatios: ["auto", ...VID_AR],
  durations: [3, 5],
  resolutions: ["480p", "720p"],
  seed: true,
  negativePrompt: true,
  endFrame: true,
  maxImages: 1,
  requires: { images: 1, msg: "Add a start frame: Fuobe DoP moves the camera through your picture" },
};

/** Fuobe Evolution's change intensity as a composer control on the GPU graph's own field (its denoise; fal's hosted VACE has none). */
function intensityControl(param: string, value: (i: Intensity) => number): NonNullable<ModelOptions["controls"]>[number] {
  return {
    param,
    label: "Change",
    values: INTENSITIES.map((i) => value(i.id)),
    default: value("medium"),
    labels: Object.fromEntries(INTENSITIES.map((i) => [String(value(i.id)), i.label])),
  };
}

/** Soul's options on both engines (research §4.3): 7 shapes, a 720p (about 1 MP) and a 1080p (about 2 MP) tier, 1–4 images. */
const SOUL_OPTIONS: ModelOptions = { aspectRatios: SOUL_ASPECTS, resolutions: SOUL_TIERS, seed: true, maxOutputs: 4 };

/** Fuobe Soul, Soul HD and Soul Cinema (src/lib/catalog/soul.ts applies the look). */
const originals: ModelDef[] = [
  original({
    id: "fuobe-soul",
    open: [
      comfy("t2i", "z-image-turbo-t2i", "Z-Image Turbo with the look's LoRAs"),
      // Restyle a picture with the look (Soul 2.0's image to image); it keeps the picture's shape.
      comfy("edit", "z-image-turbo-i2i", "Z-Image Turbo image to image with the look's LoRAs"),
    ],
    options: { ...SOUL_OPTIONS, looks: { label: "Look" }, maxImages: 1 },
  }),
  original({
    id: "fuobe-soul-hd",
    open: [comfy("t2i", "qwen-image-2512-t2i", "Qwen-Image 2512: the look's words, clean lettering")],
    options: { ...SOUL_OPTIONS, looks: { label: "Look" }, negativePrompt: true },
  }),
  original({
    id: "fuobe-soul-cinema",
    open: [comfy("t2i", "z-image-turbo-t2i", "Z-Image Turbo with the film-still LoRAs")],
    // 21:9 is a crop of the 16:9 picture, made after generation (research §4.5).
    options: { ...SOUL_OPTIONS, aspectRatios: [...SOUL_ASPECTS, CINEMA_CROP] },
  }),
  // Fuobe DoP (O4): camera motions, Mix and effects (src/lib/catalog/dop.ts maps each preset to its LoRAs). Higgsfield's
  // DoP makes 3 or 5 s clips from a start frame; "auto" keeps the picture's shape.
  {
    ...original({
      id: "fuobe-dop",
      open: [
        // A pose Wan 2.2 Fun Camera makes natively (params.extra.cameraMotion) runs on wan22-fun-camera-14b instead.
        comfy("i2v", "wan22-i2v-14b", "Wan 2.2 14B with the motion's LoRAs on their experts, or Fun Camera's pose"),
        comfy("flf2v", "wan22-flf2v-14b", "Wan 2.2 14B start and end frame with the effect's LoRAs"),
        // Frames mode: one start/end-frame clip per pair of frames, the motion's LoRAs on each, then joined.
        KEYFRAME_FILM,
      ],
      tagline: "Camera motions and effects with their LoRAs on Wan 2.2 · free on your GPU (24 GB), or hosted on fal",
      options: DOP_OPTIONS,
    }),
    // 480p on the user's GPU (720p takes about three times as long); 720p in the cloud, where a run with LoRAs costs the same.
    engineDefaults: { open: { resolution: "480p" } },
  },
  {
    ...original({
      id: "fuobe-dop-ltx",
      open: [
        comfy("i2v", "ltx23-i2v-lora", "LTX-2.3 22B distilled with the motion's LoRAs"),
        comfy("flf2v", "ltx23-flf2v-lora", "LTX-2.3 22B distilled, start and end frame, with the transition LoRA"),
      ],
      // The graphs load the 22B fp8 checkpoint (29.5 GB) and the Gemma text encoder: 32 GB of VRAM (the manifest's vramGb).
      tagline: "FPV, wind and transitions on LTX-2.3 with its camera LoRAs · free on your GPU (32 GB), or hosted on fal",
      options: { ...DOP_OPTIONS, resolutions: ["720p"], audio: true },
    }),
    // Sound in the cloud only (fal's generate_audio): the open LTX-2.3 graphs decode no audio, so no toggle there.
    engineOptions: { open: { audio: false } },
  },
  // Fuobe Animation: keyframe in-betweening. On your GPU one graph makes every gap between 2-10
  // keyframes on one set of Wan 2.2 loaders (AniSora 3.2 high, lightx2v 4-step low), keeps every Nth frame per gap and plays
  // the film at 24 or 16 fps (src/lib/av/inbetween-graph.ts); in the cloud one hosted Wan 2.2 clip per gap with AniSora on
  // the high-noise expert, every frame at 16 fps, joined (createKeyframeFilm). Timing: src/lib/inbetween.ts.
  {
    ...original({
      id: "fuobe-animation",
      open: [comfy("keyframes", "wan22-inbetween-anisora", "every gap on one set of loaders: AniSora 3.2 + lightx2v 4 steps, every Nth frame, one video")],
      tagline: "Keyframes in, the in-betweens drawn, one finished animation · Wan 2.2 + AniSora free on your GPU (24 GB), or hosted on fal",
      options: {
        inbetween: true,
        aspectRatios: ["auto", ...VID_AR],
        resolutions: ["480p", "720p"],
        seed: true,
        negativePrompt: true,
        maxImages: 10,
        promptOptional: true,
        ...(ANISORA_LORA && { loras: [loraRef(ANISORA_LORA)] }),
      },
    }),
    // One clip per gap, joined, in the cloud: a chain like the open Frames film's (src/server/chains.ts createKeyframeFilm).
    routes: [
      comfy("keyframes", "wan22-inbetween-anisora", "every gap on one set of loaders: AniSora 3.2 + lightx2v 4 steps, every Nth frame, one video"),
      ...(ORIGINAL_HALVES.get("fuobe-animation")?.routes ?? []),
      { op: "keyframes", provider: "fal", endpoint: "fal-ai/wan/v2.2-a14b/image-to-video", chained: true, note: "one hosted clip per gap with AniSora, joined" },
    ],
    engineDefaults: { open: { resolution: "720p" } },
    // The GPU graph needs two keyframes; in the cloud each gap's clip runs on its own (a start and an end frame).
    engineOptions: { open: { requires: { images: 2, msg: "Add at least two keyframes: the in-betweens go between them" } } },
    engineNote: "In the cloud every frame is kept and the animation plays at 16 fps; speeds ×2–×4 and 24 fps playback run on your GPU",
  },
  // Fuobe Cinema (O6): Cinema Studio 4.0's Original (src/lib/catalog/cinema.ts compiles the Director into the prompt and
  // turns a camera move into a camera LoRA, a Fun Camera pose or LTX-2.3's camera_lora). On the user's GPU it is Wan 2.2
  // 14B Lightning, 3 or 5 s at 16 fps (extend and edit run on Wan 2.2 Fun VACE, sound on LTX-2.5); in the cloud LTX-2.3
  // 22B with sound, up to 20 s at 24 fps, extend and edit included.
  {
    ...original({
      id: "fuobe-cinema",
      open: [
        comfy("t2v", "wan22-t2v-14b-lightx2v", "Wan 2.2 14B Lightning with the Director's prompt"),
        // A camera pose (params.extra.cameraMotion) runs on wan22-fun-camera-14b instead; a move's camera LoRA is injected.
        comfy("i2v", "wan22-i2v-14b-lightx2v", "Wan 2.2 14B Lightning with the move's camera LoRA, or Fun Camera's pose"),
        comfy("flf2v", "wan22-flf2v-14b", "Wan 2.2 14B start and end frame"),
      ],
      tagline: "Cinema Studio's director, with camera moves · Wan 2.2 Lightning free on your GPU (24 GB), or LTX-2.3 with sound on fal",
      options: ORIGINAL_HALVES.get("fuobe-cinema")?.options ?? {},
    }),
    engineDefaults: { open: { resolution: "480p", duration: 5, generateAudio: false } },
    // Wan 2.2 Lightning: 3 or 5 s, three shapes, 480p or 720p, no sound; several shots render one clip each, then join.
    engineOptions: { open: { durations: [3, 5], aspectRatios: VID_AR, resolutions: ["480p", "720p"], audio: false, multiShot: CONCAT_SHOTS } },
  },
  // Fuobe Genjutsu (O5): Higgsfield's Genjutsu rebuilt on open weights, one model per mode on both engines, and Lite as the
  // cheaper, faster tier of the same Original (src/lib/catalog/genjutsu.ts plans the pieces, masks, looks and sound).
  original({
    id: "fuobe-genjutsu-motion",
    open: [comfy("motion-transfer", "wan-animate2", "Wan Animate 2: the whole selection in 81-frame fragments, the clip's fps and sound kept")],
    tagline: "Your character performs the clip's moves · Wan Animate 2 free on your GPU (24 GB), Wan 2.2 Animate on fal",
    options: { seed: true, resolutions: ["480p", "720p"], maxImages: 1, promptOptional: true },
  }),
  original({
    id: "fuobe-genjutsu-motion-lite",
    open: [comfy("motion-transfer", "wan-animate2", "Wan Animate 2 at 480p with 4 distilled steps")],
    tagline: "The quick tier: 480p · Wan Animate 2 in 4 steps on your GPU, Wan 2.2 Animate turbo on fal",
    options: { seed: true, resolutions: ["480p"], maxImages: 1, promptOptional: true },
  }),
  {
    ...original({
      id: "fuobe-genjutsu-swap",
      open: [comfy("video-swap", "video-swap-wan-vace", "SAM 3.1 follows what you name, Wan 2.1 VACE 14B paints your first reference in; 81 frames per window")],
      tagline: "Swap a thing, a person or an outfit for your reference · Wan VACE + SAM 3.1 free on your GPU (24 GB), or hosted on fal",
      options: { seed: true, negativePrompt: true, resolutions: ["480p", "720p"], maxImages: 4 },
    }),
    engineOptions: { open: { maxImages: 1 } },
  },
  {
    ...original({
      id: "fuobe-genjutsu-swap-lite",
      open: [comfy("video-swap", "video-swap-wan-vace", "SAM 3.1 + Wan 2.1 VACE 14B at 480p")],
      tagline: "The quick tier: 480p · Wan VACE + SAM 3.1 on your GPU, accelerated Wan VACE on fal",
      options: { seed: true, negativePrompt: true, resolutions: ["480p"], maxImages: 4 },
    }),
    engineOptions: { open: { maxImages: 1 } },
  },
  original({
    id: "fuobe-genjutsu-restyle",
    open: [comfy("v2v", "video-restyle-wan22-fun-vace", "the restyled first frame, then every frame with depth; 5 s segments at 16 fps")],
    tagline: "Every frame takes a Fuobe look, motion and framing kept · Wan 2.2 Fun VACE free on your GPU (24 GB), or hosted on fal",
    options: { seed: true, negativePrompt: true, resolutions: ["480p", "720p"], maxImages: 4 },
  }),
  // Fuobe Evolution (O13): Higgsfield Evolution's Original (src/lib/catalog/evolution.ts plans the segments, the direction
  // frame and the sound; Video tools → Evolution is its studio). Wan 2.2 Fun VACE on both engines: the graph on your GPU,
  // fal's hosted depth route in the cloud (since 2026-10-30; LTX-2.3 before). The change intensity is
  // the denoise the GPU graph starts from; fal's route has no such field, so in the cloud the change shapes only the
  // direction frame Evolution makes, and the composer has no Change control there.
  {
    ...original({
      id: EVOLUTION.model,
      open: [comfy("v2v", "video-evolution-wan22-fun-vace", "Wan 2.2 Fun VACE from the noised segment, depth control, image = the direction frame; ≤81 frames at 16 fps")],
      tagline: "Takes your clip further in a creative direction · Wan 2.2 Fun VACE free on your GPU (24 GB), or hosted on fal (there the change level shapes the direction frame only)",
      options: {
        seed: true,
        negativePrompt: true,
        resolutions: EVOLUTION_RESOLUTIONS.cloud,
        maxImages: 1,
        imageLabels: ["direction frame (optional: the clip's first frame as it should look)"],
      },
    }),
    // The cloud half renders the clip's own frames (match_input_num_frames) and is priced on them (clip-windows.ts):
    // only the GPU half asks for a length.
    defaults: { resolution: EVOLUTION_DEFAULT_RESOLUTION.cloud },
    engineNote: "Both engines run Wan 2.2 Fun VACE with a direction frame per segment; in the cloud the change level shapes the direction frame only, and how much of the clip's own look stays is set on your GPU only",
    engineDefaults: { open: { resolution: EVOLUTION_DEFAULT_RESOLUTION.open, aspectRatio: "auto", duration: 5 } },
    engineOptions: {
      open: {
        aspectRatios: ["auto", ...VID_AR],
        resolutions: EVOLUTION_RESOLUTIONS.open,
        durations: [3, 4, 5],
        imageLabels: ["direction frame (the clip's first frame as it should look)"],
        controls: [intensityControl("denoise", denoiseFor)],
        requires: { images: 1, msg: "Add the direction frame: the clip's first frame as it should look (Video tools → Evolution makes it for you)" },
      },
    },
  },
  // Character swap (Openjutsu, Akatz Labs' H3 Character Swap): MiniMax H3 with the Character Swap LoRA. On your GPU the
  // h3_character_swap graph finds the person with SAM 3.1 and regenerates only them in 124-frame windows, keeping the
  // clip's own sound; on fal, H3 reference-to-video with the same LoRA (no mask), the clip's sound put back.
  original({
    id: "fuobe-character-swap",
    open: [comfy("video-swap", "video-character-swap-h3", "SAM 3.1 picks the person on the part's first frame; H3 regenerates them in 124-frame windows, 18 frames of history")],
    tagline: "The person in your clip becomes your character · MiniMax H3 free on your GPU (48 GB+ advised), or hosted on fal",
    options: { seed: true, resolutions: ["480p", "768p"], maxImages: 2 },
  }),
  // Marketing Studio Image and Fashion Factory's try-on (O10): Higgsfield's GPT Image 2.5 templates and Nano Banana outfit
  // steps rebuilt on Apache-2.0 open weights (docs/research/fuobe-originals-recipes-5.json studios[marketing]).
  {
    ...original({
      id: "fuobe-marketing-image",
      open: [
        // A Standalone product shot (params.extra.productShot, one product photo) runs product-shot-qwen-edit-2509 instead:
        // cut out with BiRefNet, put on white, relit into the scene by the White_to_Scene LoRA.
        comfy("edit", "qwen-image-21-edit", "Qwen-Image 2.1 with up to 4 references (product, person, setting) and the template's prompt"),
        comfy("t2i", "qwen-image-21-t2i", "Qwen-Image 2.1 when there is no product photo"),
      ],
      tagline: "Product shots, ads, posters and listings from your product photo · Qwen-Image 2.1 free on your GPU (20 GB), or hosted on fal",
      options: { aspectRatios: IMG_AR, maxImages: 10, maxOutputs: 4, seed: true, negativePrompt: true },
    }),
    // Qwen-Image 2.1's edit graph reads up to four pictures and keeps the first one's shape. Neither of its graphs takes a
    // negative prompt, so the open half has none (the hosted half keeps it).
    engineOptions: { open: { maxImages: 4, negativePrompt: false } },
    // The Standalone recipe's graph has no hosted copy (nothing hosted puts the cut-out on white): it stays the GPU's, and
    // in the cloud Marketing's Standalone format lists the Original as running on your GPU only (marketing.ts).
    engineNote: "A Standalone shot from one product photo runs on your GPU only (cut out, put on white and relit into the scene); in the cloud, the Standalone format offers partner models instead",
  },
  {
    ...original({
      id: "fuobe-tryon",
      open: [comfy("edit", "tryon-flux2-klein-4b", "the try-on LoRA on FLUX.2 [klein] 4B; the old outfit greyed out first (ClothesSegment)")],
      tagline: "Puts the garment in image 2 (a bottom in image 3) on the person in image 1 · FLUX.2 [klein] 4B + try-on LoRA, free on your GPU (10 GB), or hosted on fal",
      options: {
        maxImages: 3,
        seed: true,
        promptOptional: true,
        defaultPrompt: TRYON_PROMPT,
        imageLabels: ["person photo", "garment (a top, dress or whole outfit)", "bottom (optional)"],
        requires: { images: 2, msg: "Add a photo of the person, then the garment" },
        ...(TRYON_LORA && { loras: [loraRef(TRYON_LORA)] }),
      },
    }),
  },
  // Fuobe Mixed Media (O9): Higgsfield's Mixed Media rebuilt on Z-Image Turbo + its Fun ControlNet, every frame drawn
  // again in the look (its LoRA from the research's looks map) at one seed. On your GPU the whole selection is one
  // per-frame job (v2v); in the cloud src/lib/catalog/mixed-media.ts fans the frame route out over every frame and puts
  // them back together. "edit" is one frame in the look on both engines: the preview, Smooth's first frame and DoP's
  // Mixed Media effects (Smooth then carries that frame through the clip on Fuobe Shorts' Wan 2.2 Fun VACE pass).
  {
    ...original({
      id: "fuobe-mixed-media",
      open: [
        comfy("v2v", "mixed-media-zimage-frames", "every frame on Z-Image Turbo + Fun Union ControlNet (canny) with the look's LoRA, one seed"),
        comfy("edit", "z-image-turbo-i2i", "one frame in the look with its LoRA (Smooth's first frame, DoP's Mixed Media effects)"),
      ],
      tagline: "Every frame drawn again in the look · Z-Image Turbo + ControlNet free on your GPU (16 GB), or per frame on fal",
      options: { seed: true, resolutions: ["1K", "2K"], maxImages: 1, maxOutputs: 1 },
    }),
    // The per-frame graph renders up to 1536 px on the long side (its manifest's limit).
    engineOptions: { open: { resolutions: ["1K"] } },
  },
  // Fuobe Shorts (O9): Shorts Studio's Original, the open Shorts chain on both engines: each segment's first frame in the
  // look (Qwen-Image-Edit 2511 with up to two reference images), then Wan 2.2 Fun VACE carries it through every frame by
  // depth; the segments are joined and the clip's own sound put back (src/lib/catalog/shorts.ts plans the steps).
  {
    ...original({
      id: "fuobe-shorts",
      open: [comfy("v2v", "video-restyle-wan22-fun-vace", "the restyled first frame, then every frame with depth; 81 frames at 16 fps a segment")],
      tagline: "Your footage in a new look, motion kept · Wan 2.2 Fun VACE free on your GPU (24 GB), or hosted on fal",
      options: { seed: true, negativePrompt: true, resolutions: ["480p", "720p"], maxImages: 1 },
    }),
    // The GPU graph follows a restyled first frame it can't make itself (fal's route runs without one, on the words).
    engineOptions: { open: { requires: { images: 1, msg: "Add the clip's first frame in the new look: Wan 2.2 Fun VACE carries it through every frame" } } },
  },
  // Fuobe Angles (O11): Higgsfield Angles' recipe, Qwen-Image-Edit 2509 with dx8152's Multiple-angles LoRA. The camera is the
  // hosted route's own fields on both engines (rotate −90…90°, positive = left; tilt −1…1; move forward 0–10; a wide-angle lens in
  // the Angles app); on the GPU src/lib/catalog/open-tools.ts turns them into the LoRA's words. Words of your own are the GPU's
  // only (fal's route has no prompt field).
  {
    ...original({
      id: "fuobe-angles",
      open: [comfy("edit", "qwen-image-edit-2509-angles", "Qwen-Image-Edit 2509 + Lightning + the Multiple-angles LoRA at 1.25, 6 steps")],
      tagline: "The same shot from another camera: rotate, tilt, move closer, go wide · Qwen-Image-Edit 2509 + Multiple-angles LoRA, free on your GPU (24 GB), or hosted on fal",
      options: { maxImages: 1, seed: true, promptOptional: true, sliders: ORIGINAL_HALVES.get("fuobe-angles")?.options.sliders },
    }),
    // The GPU graph loads the LoRA itself; as the recipe's LoRA it is downloaded before a run and has a switch in Settings.
    engineOptions: { open: { ...(ANGLES_LORA && { loras: [ANGLES_LORA] }) }, cloud: { promptless: true } },
  },
  // Fuobe Speak (O11): InfiniteTalk. On the GPU, Higgsfield's Infinite Talk settings on kijai's wrapper graph (FusioniX in place of
  // the lightx2v distill LoRA, 15 motion frames, 25 steps, shift 10, text and audio guidance 5, colour match): about ten times the
  // fast pass's time (InfiniteTalk Long). In the cloud, fal's InfiniteTalk, which takes none of those knobs. As long as the voice.
  {
    ...original({
      id: "fuobe-speak",
      open: [{ ...comfy("avatar", "infinitetalk-wanwrapper", "InfiniteTalk + FusioniX, 25 steps, shift 10, guidance 5 / 5, 15 motion frames"), extra: { ...SPEAK_GRAPH }, loraSlot: true }],
      tagline: "A portrait speaks your voice track, lips, face and head in sync, long takes · InfiniteTalk + the FusioniX LoRA free on your GPU (16 GB), or fal's InfiniteTalk without the LoRA",
      options: { resolutions: ["480p", "720p"], seed: true, maxImages: 1, promptOptional: true, defaultPrompt: SPEAK_PROMPT },
    }),
    engineDefaults: { open: { aspectRatio: "auto" } },
    // fal's InfiniteTalk endpoints (and Replicate) take no LoRA (checked 2026-11-01: research studios[speak].original.cloud).
    engineNote: "Your GPU adds FusioniX to InfiniteTalk; the cloud runs InfiniteTalk without it",
    // The GPU graph frames the portrait itself (its shape by default); the LoRA is the recipe's, downloaded before a run.
    engineOptions: { open: { aspectRatios: ["auto", ...VID_AR], negativePrompt: true, ...(SPEAK_LORA && { loras: [SPEAK_LORA] }) } },
  },
  // Fuobe Speak · Motion (O11): a Speak v1-like route, Wan 2.2 Speech-to-Video. The body and the scene move with the speech; fal
  // makes 2.5–7.5 s a call (num_frames 40–120), the GPU graph up to about 14 s.
  {
    ...original({
      id: "fuobe-speak-motion",
      open: [comfy("avatar", "wan22-s2v-14b", "Wan 2.2 S2V 14B with the lightx2v 4-step LoRA, up to about 14 s")],
      tagline: "Speech with the body and the scene moving · Wan 2.2 S2V free on your GPU (24 GB), or hosted on fal (up to 7.5 s)",
      options: { resolutions: ["480p", "580p", "720p"], seed: true, negativePrompt: true, maxImages: 1, promptOptional: true, defaultPrompt: SPEAK_PROMPT },
    }),
    engineDefaults: { open: { aspectRatio: "9:16" } },
    engineOptions: { open: { aspectRatios: VID_AR, resolutions: ["480p", "720p"] } },
  },
  // Fuobe Restore (package archive-restore): Restore & colourise archive footage with Lightricks' Restore IC-LoRA. On your GPU
  // LTX-2.5 22B distilled with per-step tiled fusion (src/lib/restore-graph.ts: a whole clip in one pass up to 20 s; Video
  // tools → Restore runs any clip in chained 97-frame windows, src/lib/catalog/restore.ts); in the cloud fal's LTX-2.3 22B
  // reference video to video with the same LoRA by Fuobe's mirror, one untiled pass. The GPU graph loads its LoRA itself.
  {
    ...original({
      id: RESTORE.model,
      open: [comfy("restore-video", RESTORE.workflow, "LTX-2.5 22B distilled + the Restore IC-LoRA, 960x544 tiles fused every step, 8 steps; stage 2 the Detail Refine IC-LoRA")],
      tagline:
        "Old, faded or black-and-white footage back in colour and sharp · Lightricks' Restore IC-LoRA on LTX-2.5, free on your GPU (24 GB class), or on LTX-2.3 hosted on fal",
      options: {
        promptOptional: true,
        defaultPrompt: offlineRestorePrompt().prompt,
        negativePrompt: true,
        seed: true,
        maxImages: 1,
        imageLabels: ["reference picture: true colours, a face or a sign (optional)"],
      },
    }),
    // The cloud renders at a tier's size for the clip's shape, and its image is the first frame (already in colour).
    engineDefaults: { cloud: { aspectRatio: "4:3", resolution: RESTORE.cloudResolution } },
    engineOptions: {
      cloud: {
        aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        resolutions: [...RESTORE.cloudResolutions],
        imageLabels: ["first frame, already in colour (optional)"],
        ...(RESTORE_LORA && { loras: [RESTORE_LORA] }),
      },
    },
  },
];

/**
 * Fuobe Soul's face mosaic on the GPU (build plan O11): SAM 3.1 finds the faces (or what the words name) and a block
 * mosaic covers them, in one graph. A helper step after a look that asks for it (PixeletedFace); in the cloud fal's
 * SAM 3.1 makes the masks and Fuobe pixelates under them (sam-3-1-face-mask).
 */
const faceMosaic: ModelDef = o({
  id: "oss-face-mosaic",
  name: "Pixelate faces",
  vendor: "Meta SAM 3.1 + ComfyUI",
  family: "sam",
  kind: "image",
  tagline: "SAM 3.1 finds every face and covers it with large blocks · core nodes, 4 GB",
  routes: [comfy("face-mosaic", "image-face-mosaic-sam3", "SAM 3.1 face mask, grown 12 px, a 25 px block mosaic under it")],
  options: { maxImages: 1, promptOptional: true, defaultPrompt: MOSAIC_TARGET, sliders: [{ param: "mosaicScale", label: "Block size (smaller = bigger blocks)", min: 0.01, max: 0.2, step: 0.01, default: MOSAIC_SCALE }] },
  hidden: true,
});

/**
 * The Watermark Remover app's two steps on the GPU (ComfyUI-Qwen-Watermark): Qwen3-VL finds the marks printed over a photo,
 * then Qwen-Image 2.1 repairs only under the ones kept (or a brushed area). Hidden: the app's own page runs them.
 */
const watermark: ModelDef[] = [
  o({
    id: "oss-watermark-scan",
    name: "Find watermarks",
    vendor: "Qwen3-VL + ComfyUI",
    family: "qwen",
    kind: "text",
    tagline: "Finds text, logos, stickers, mosaics and blocks printed over a photo, with their boxes",
    routes: [{ ...comfy("watermark-scan", "image-watermark-scan-qwen3vl", "Qwen3-VL 8B int8, one pass, boxes in pixels"), unsized: true, maxImages: 1 }],
    options: { maxImages: 1, promptOptional: true },
    hidden: true,
  }),
  o({
    id: "oss-watermark-remover",
    name: "Watermark Remover",
    vendor: "Qwen-Image 2.1 + ComfyUI",
    family: "qwen",
    kind: "image",
    tagline: "Repairs only under the marks kept for removal; every other pixel stays as it was",
    routes: [{ ...comfy("watermark-remove", "image-watermark-remove-qwen21", "Qwen-Image 2.1 int8 repair, a leftover check, a second pass when needed"), unsized: true, maxImages: 1 }],
    options: { maxImages: 1, promptOptional: true, seed: true },
    hidden: true,
  }),
];

/** Tools that run entirely in the browser; recorded in the library like any other result. */
const local: ModelDef[] = [
  {
    id: "local-color-grade",
    name: "Color Grading",
    vendor: "Fuobe",
    family: "local",
    engine: "open",
    kind: "image",
    tagline: "Real-time WebGL grading in your browser — free, nothing leaves your machine",
    routes: [{ op: "grade", provider: "local", endpoint: "webgl" }],
    options: {},
    hidden: true,
  },
  // Relight: a photo blended with its relit picture at the chosen Intensity, kept from the browser.
  {
    id: "local-relight",
    name: "Relight blend",
    vendor: "Fuobe",
    family: "local",
    engine: "open",
    kind: "image",
    tagline: "The relit picture blended into the original in your browser",
    routes: [{ op: "relight", provider: "local", endpoint: "webgl" }],
    options: {},
    hidden: true,
  },
  // Split soundtrack's Export mix: the stems at the levels set in the mixer, written as a WAV in the browser.
  {
    id: "local-mix",
    name: "Stem mix",
    vendor: "Fuobe",
    family: "local",
    engine: "open",
    kind: "audio",
    tagline: "The stems at the levels you set, mixed in your browser",
    routes: [{ op: "mix", provider: "local", endpoint: "webaudio" }],
    options: {},
    hidden: true,
  },
  // Ads Studio: a creative composited over its visual (headline, copy, CTA, logo in the brand fonts), saved from the browser.
  {
    id: "local-ad-compose",
    name: "Ad compositor",
    vendor: "Fuobe",
    family: "local",
    engine: "open",
    kind: "image",
    tagline: "Headline, copy, CTA and logo set over the visual in your brand fonts, in your browser",
    routes: [{ op: "edit", provider: "local", endpoint: "canvas" }],
    options: {},
    hidden: true,
  },
  // Kinetic Motion: motion graphics (an animated end card, text templates) drawn by code in the brand's fonts and
  // colours, rendered and encoded in the browser, then saved like any result.
  {
    id: "local-motion",
    name: "Kinetic Motion",
    vendor: "Fuobe",
    family: "local",
    engine: "open",
    kind: "video",
    tagline: "Motion graphics drawn in your browser in your brand fonts",
    routes: [{ op: "motion", provider: "local", endpoint: "canvas" }],
    options: {},
    hidden: true,
  },
  // Marketing joins that keep the voice (UGC presenter, Click to Ad, Ad Multiplier): oss-join-clips drops every
  // soundtrack and plays all frames at one rate, so a 25 fps presenter joined to 16 fps Wan clips came out silent
  // and slowed down. These resample every clip to 25 fps and keep one clip's own sound.
  o({
    id: "oss-join-sound1",
    name: "Join clips (keep the first clip's sound)",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Join 2–4 clips at their real speed; the soundtrack is the first clip's own sound · CPU",
    routes: [comfy("concat", "video-concat-sound1-{n}", "VHS loader at 25 fps; clip 1's sound from the start")],
    options: { aspectRatios: ["auto", ...VID_AR], resolutions: ["480p", "720p", "1080p"] },
    defaults: { aspectRatio: "9:16", resolution: "480p" },
    hidden: true,
  }),
  // Click to Ad's logo end card (r4/marketing-mixed): core nodes, no model, CPU.
  o({
    id: "oss-append-endcard",
    name: "Append end card",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Ends an ad on a still (its logo card) and keeps the ad's sound; the ad's picture is copied, not re-encoded · CPU",
    routes: [comfy("concat", "video-append-endcard", "the ad (inputs.video) + the card (images[0]) at the ad's own size and frame rate; only for clips the open engine made")],
    options: { maxImages: 1, promptless: true },
    defaults: { duration: 2.5 },
    hidden: true,
  }),
  o({
    id: "oss-still-to-clip",
    name: "Still to clip",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Holds a still (an end card) for a few seconds, with a silent sound track · no model, CPU",
    routes: [comfy("still-motion", "still-to-clip", "centre-cropped to the clip size; joined after clips the open engine didn't make")],
    options: { aspectRatios: VID_AR, resolutions: ["480p", "720p", "1080p"], maxImages: 1, promptless: true },
    defaults: { aspectRatio: "9:16", resolution: "480p", duration: 2.5 },
    hidden: true,
  }),
  o({
    id: "oss-join-sound2",
    name: "Join clips (keep the second clip's sound)",
    vendor: "ComfyUI",
    family: "utility",
    kind: "video",
    tagline: "Join 2–4 clips at their real speed; the second clip's own sound starts where the first clip ends · CPU",
    routes: [comfy("concat", "video-concat-sound2-{n}", "VHS loader at 25 fps; silence for clip 1, then clip 2's sound")],
    options: { aspectRatios: ["auto", ...VID_AR], resolutions: ["480p", "720p", "1080p"] },
    defaults: { aspectRatio: "9:16", resolution: "480p" },
    hidden: true,
  }),
];

export const MODELS: ModelDef[] = [...originals, ...cloud, ...open, faceMosaic, ...watermark, ...local];
