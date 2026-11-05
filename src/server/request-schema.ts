import "server-only";
import { z } from "zod";
import { FORMAT_INFO } from "@/lib/av/formats";
import type { VideoFormat } from "@/lib/catalog/types";
import { LATENT_EXTRA } from "@/lib/catalog/regenerate";
import { SignatureSchema } from "./palettes";

/**
 * params.extra as a client may send it: any settings, less the ones only the server sets (MiniMax H3's 2K hand-off:
 * latentDraft, latentFrom), the way the run stamp's fields are dropped. The server checks those again when a run starts.
 */
export const ClientExtra = z.record(z.string(), z.unknown()).transform((extra) => {
  const out = { ...extra };
  for (const k of LATENT_EXTRA) delete out[k];
  return out;
});

/** A point on a picture as fractions of its width and height. */
const Focus = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

/**
 * Where a LoRA named in a request may be downloaded from. A file the server doesn't know is fetched from its
 * link before a ComfyUI run (or by fal / Replicate), so an open link would let any token holder make the
 * server fetch an internal address into models/loras. Every research LoRA is on Hugging Face or civitai;
 * trained and mirrored copies live in fal's or Replicate's file stores.
 */
const LORA_HOSTS = ["huggingface.co", "hf.co", "civitai.com", "fal.media", "replicate.delivery"];
function loraHostOk(link: string): boolean {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && LORA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * A generation request as the API takes it (POST /api/generations): every field a client may send, with its limits.
 * Fields the server sets (chainFilled, chainSkipped, notice, skill, demo…) aren't here, so zod drops them from input.
 * A skill recipe's filled requests go through it too (src/server/recipes.ts), so a recipe can't send more than the API.
 */
export const GenerationRequestSchema = z.object({
  feature: z.string().min(1),
  presetId: z.string().optional(),
  modelId: z.string().min(1),
  op: z.string().optional(),
  prompt: z.string().max(10_000).optional(),
  negativePrompt: z.string().max(4_000).optional(),
  inputs: z
    .object({
      images: z.array(z.string()).max(14).optional(),
      endImage: z.string().optional(),
      mask: z.string().optional(),
      sketch: z.string().optional(),
      video: z.string().optional(),
      audio: z.string().optional(),
      audio2: z.string().optional(),
      voiceAudio: z.string().optional(),
      voiceAudio2: z.string().optional(),
      videos: z.array(z.string()).max(24).optional(),
      // Reference audio clips for reference-to-video (Seedance 2.5 / Cinema Studio take up to 10).
      audios: z.array(z.string()).max(10).optional(),
      // A .glb to rig.
      model3d: z.string().optional(),
    })
    .optional(),
  params: z
    .object({
      aspectRatio: z.string().optional(),
      resolution: z.string().optional(),
      duration: z.number().positive().max(600).optional(),
      numOutputs: z.number().int().min(1).max(8).optional(),
      seed: z.number().int().optional(),
      generateAudio: z.boolean().optional(),
      enhancePrompt: z.boolean().optional(),
      shots: z.array(z.object({ prompt: z.string().max(2000), duration: z.number().positive().max(60) })).max(12).optional(),
      multiShot: z.literal("auto").optional(),
      // Kling 4.0's elements: groups of inputs.images (by index, the frontal view first) or one of inputs.videos.
      elements: z
        .array(z.object({ images: z.array(z.number().int().min(0).max(63)).max(4).optional(), video: z.number().int().min(0).max(23).optional() }))
        .max(7)
        .optional(),
      draft: z.boolean().optional(),
      draftId: z.string().max(8192).optional(),
      voice: z.string().max(200).optional(),
      // Design a voice: the voice in words; what a voice sample says (a closer clone).
      voiceDescription: z.string().max(1000).optional(),
      voiceTranscript: z.string().max(2000).optional(),
      dialogue: z.array(z.object({ text: z.string().max(5000), voice: z.string().max(200).optional() })).max(200).optional(),
      targetLanguage: z.string().max(80).optional(),
      startTime: z.number().min(0).max(36_000).optional(),
      endTime: z.number().min(0).max(36_000).optional(),
      fps: z.number().positive().max(240).optional(),
      palette: z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/)).max(16).optional(),
      styleId: z.string().max(200).optional(),
      sourceLanguage: z.string().max(80).optional(),
      numLayers: z.number().int().min(1).max(20).optional(),
      // Round 4: clicked points, keyframe times, output formats, Ken Burns moves, crossfades, retiming, overlays, rigging.
      points: z.array(z.object({ x: z.number(), y: z.number(), label: z.enum(["positive", "negative"]).optional() })).max(64).optional(),
      keyframeTimes: z.array(z.number().min(0).max(600)).max(10).optional(),
      format: z.enum(Object.keys(FORMAT_INFO) as [VideoFormat, ...VideoFormat[]]).optional(),
      zoomFrom: z.number().min(0.1).max(10).optional(),
      zoomTo: z.number().min(0.1).max(10).optional(),
      panFrom: Focus.optional(),
      panTo: Focus.optional(),
      easing: z.enum(["linear", "ease-in-out"]).optional(),
      crossfade: z.number().min(0).max(30).optional(),
      sourceDuration: z.number().positive().max(36_000).optional(),
      sourceFps: z.number().positive().max(1000).optional(),
      sourceSize: z.object({ width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) }).optional(),
      frameInterval: z.number().int().min(1).max(10_000).optional(),
      targetFps: z.number().positive().max(240).optional(),
      slowdown: z.number().min(1).max(8).optional(),
      colormap: z.string().max(40).optional(),
      sideBySide: z.boolean().optional(),
      matteOutput: z.enum(["cutout", "matte", "foreground"]).optional(),
      position: Focus.optional(),
      scale: z.number().positive().max(10).optional(),
      animation: z.union([z.string().max(200), z.number()]).optional(),
      extra: ClientExtra.optional(),
    })
    .optional(),
  presetOptions: z.record(z.string(), z.string()).optional(),
  presetStrength: z.number().min(0).max(1).optional(),
  mix: z.object({ presetId: z.string().max(120), strength: z.number().min(0).max(1) }).optional(),
  // A Fuobe Original runs on both engines: the one to run on (the composer's switch). Unset: the engine mode, else
  // the first connected.
  engine: z.enum(["open", "cloud"]).optional(),
  // A recipe's LoRAs (the evaluation harness, scripts/eval): added after the preset's own. On ComfyUI `file` must
  // already be in models/loras (ComfyUI checks the name against its list); a cloud LoRA endpoint takes `url`.
  loras: z
    .array(
      z.object({
        file: z
          .string()
          .min(1)
          .max(200)
          // Brackets too: Redmond's Z-Image LoRAs are called "[ZImage.Turbo]FilmStill_Redmond.safetensors".
          .regex(/^[\w ()[\]+,.@-]+(\/[\w ()[\]+,.@-]+)*$/, "a file name in ComfyUI's models/loras")
          .refine((f) => !f.split("/").includes(".."), "a file name in ComfyUI's models/loras"),
        // Only the public model hubs and the cloud providers' file stores: the server (or a provider) may fetch it.
        url: z
          .string()
          .max(2000)
          .regex(/^https:\/\//, "an https:// link")
          .refine(loraHostOk, "a LoRA link on Hugging Face, civitai, fal or Replicate")
          .optional(),
        strength: z.number().min(-4).max(4).optional(),
        trigger: z.string().max(200).optional(),
        target: z.enum(["high", "low", "both"]).optional(),
      }),
    )
    .max(8)
    .optional(),
  // Image studio: the Color signature / Moodboard picks (its sentences join the prompt on the server).
  signature: SignatureSchema,
  // What a tool calls its result (Trim · 0:01.0–0:02.5, Captions · Karaoke), shown instead of the prompt.
  title: z.string().max(200).optional(),
  batchTitle: z.string().max(200).optional(),
});
