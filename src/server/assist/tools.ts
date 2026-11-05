import "server-only";
import { HI3D_CHAIN_PARAM, HI3D_MODEL, HI3D_OP, HI3D_PARAM } from "@/lib/av/hi3d";
import type Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { z } from "zod";
import { keyTimes, type InbetweenTiming, type PlaybackFps, type Speed } from "@/lib/inbetween";
import { getModel, modelsFor } from "@/lib/catalog";
import { offeredModels } from "../model-access";
import { dualEngine, runsOn } from "@/lib/catalog/engines";
import { pricingAt } from "@/lib/catalog/promo";
import { currentModelId } from "@/lib/catalog/replaced";
import { LAYOUT_PARAM, parseLayout } from "@/lib/layout-prompt";
import { OPERATION_LABELS, type ChainSlot, type GenerationRequest, type MediaKind, type ModelDef, type Operation } from "@/lib/catalog/types";
import { type PlannedJob, totalCost } from "@/lib/assist";
import { STORYBOARD_MODELS } from "@/lib/catalog/storyboard";
import { loraFamily, runsSomewhere, TRAINING_FAMILIES } from "@/lib/catalog/training";
import type { ElementLora } from "@/lib/catalog/elements";
import { createPipeline } from "../chains";
import { listElements } from "../elements";
import { createGenerations, currentRequest, getGeneration, listGenerations, outputKind, previewChained } from "../generations";
import { provider } from "../providers";
import { llmBackends, llmLabel } from "../providers/llm";
import { engineMode } from "../settings";
import { readRef } from "../storage";
import { katanaTool } from "../katana";
import { createStoryboard, estimateStoryboard } from "../storyboard";
import { nearestAspect } from "../marketing";
import { LAYOUT_NODE_LIMITS } from "@/lib/catalog/canvas";
import { CONTEXT_TOOLS } from "./context-tools";
import { defineTool, type JobPlace, type ResultContent, type ToolContext, type ToolDef, type ToolOutcome } from "./define";
// Fills STUDIO_ROUTES with the studio modules (Layers, Shorts, dub, Faceless, Ads, Captions).
import "./studio-routes";
import { SKILL_TOOLS } from "./skill-tools";
import { SOUND_TOOLS } from "./sound-tools";
import { STUDIO_TOOLS } from "./studio-tools";

export type { ToolContext, ToolOutcome };

const ref = z.string().describe("A file URL from the chat: an attachment or an earlier output (/api/files/…).");

// ---------------------------------------------------------------------------
// search_models

/** Output kinds: "text" = transcripts, translations and scripts; "model3d" = 3D models (.glb). */
const KINDS = ["image", "video", "audio", "text", "model3d"] as const;

function summarize(m: ModelDef) {
  const o = m.options;
  // The price of the day asked: a launch price while it lasts (the note says when it ends).
  const p = m.pricing && pricingAt(m.pricing);
  const local = m.routes.some((r) => r.provider === "llm");
  const configured = m.routes.some((r) => (r.provider === "llm" ? llmBackends(r).length > 0 : provider(r.provider).isConfigured()));
  return {
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    engine: dualEngine(m)
      ? "Fuobe Original: open source on your GPU (ComfyUI) or hosted open weights in the cloud (pass engine to pick one)"
      : m.engine === "open"
        ? local
          ? `open source (${llmLabel({ endpoint: "ollama" })}, on this machine)`
          : "open source (ComfyUI)"
        : local
          ? `Claude (or ${llmLabel({ endpoint: "ollama" })} when no key is set)`
          : "paid cloud API",
    about: m.tagline,
    does: [...new Set(m.routes.map((r) => r.op))].map((op) => `${op} (${OPERATION_LABELS[op]})`),
    price: dualEngine(m)
      ? `free on your GPU; in the cloud ${p ? `$${p.usd} per ${p.unit}${p.withLoras ? ` ($${p.withLoras} with LoRAs)` : ""}` : "priced per run"}`
      : m.engine === "open"
        ? local
          ? "free (your machine)"
          : "free (your GPU)"
        : p
          ? `$${p.usd} per ${p.unit}${p.note ? ` — ${p.note}` : ""}${p.lorasUnknown ? "; with LoRAs the price is unknown (not published yet)" : ""}${p.withLorasPerMegapixel ? `; with LoRAs $${p.withLorasPerMegapixel} per megapixel` : ""}`
          : "unknown",
    connected: configured,
    ...(o.aspectRatios && { aspectRatios: o.aspectRatios }),
    ...(o.resolutions && { resolutions: o.resolutions }),
    ...(o.durations && { durations: o.durations }),
    ...(o.maxImages && { maxReferenceImages: o.maxImages }),
    ...(o.maxOutputs && { maxOutputsPerRun: o.maxOutputs }),
    ...(o.audio && { nativeAudio: o.audio === "always" ? "always on" : "optional" }),
    ...(o.endFrame && { endFrame: true }),
    ...(o.multiShot && { multiShot: `up to ${o.multiShot.maxShots} shots` }),
    ...(o.voices?.length && { voices: o.voices.slice(0, 12).map((v) => v.id) }),
    ...(o.voiceClone && { voiceClone: true }),
    ...(o.languages?.length && { languages: o.languages.length > 12 ? `${o.languages.slice(0, 12).join(", ")}…` : o.languages.join(", ") }),
    ...(o.looks && { looks: "139 Soul looks: pass a look id as presetId (v1-general, v2-y2k-studio…), presetStrength 0–1 scales its LoRAs" }),
    // A model that places a layout's boxes (FLUX 3 Klein, MOSS-Image, Ideogram 4.x), and the weights' licence as information.
    ...(o.layout && { readsLayoutBoxes: o.layout }),
    ...(m.licence && { licence: `${m.licence.licence}${m.licence.commercial === false ? " (non-commercial weights)" : m.licence.commercial === null ? " (revenue tiers decide commercial use)" : ""}` }),
  };
}

const searchModels = defineTool({
  name: "search_models",
  description:
    "Look up the models this studio can run for a kind of output. Call it before generate whenever you haven't already looked up models for this kind of job in this chat, and whenever the user names a model, asks what's best or cheapest, or wants a capability (audio, end frame, multi-shot, a voice). Returns ids, what each does, price, options and whether a provider is connected.",
  schema: z.object({
    kind: z.enum(KINDS).describe("Output kind: image, video, audio, text (transcripts, translations, scripts) or model3d (3D models)."),
    task: z
      .string()
      .optional()
      .describe(
        "Operation id to filter by, e.g. t2i, edit, t2v, i2v, flf2v, ref2v, extend, lipsync, avatar, tts, upscale-image, layers, text-layers, trim, transcribe, captions, mux, separate-audio, translate, write, image-to-3d, refine-3d, splat. separate-audio splits a soundtrack into stems named in each output's stem: voice (the dialogue) and background (everything else); DBS (oss-dbs-separate) also makes music and effects, so background is music & effects together. split_soundtrack and remove_dialogue do this in one call.",
      ),
    query: z.string().optional().describe("Words to match in the model name, vendor or description, e.g. 'kling', 'cheap', 'photoreal'."),
  }),
  async run({ kind, task, query }, ctx) {
    const mode = engineMode();
    // Only what Settings → Models & licences offers, each model with the routes that are on.
    let list = offeredModels(modelsFor({ kind: kind as MediaKind, ops: task ? [task as Operation] : undefined, engine: mode === "both" ? "all" : mode }));
    if (query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = list.map((m) => {
        const hay = `${m.name} ${m.vendor} ${m.family} ${m.tagline} ${m.id}`.toLowerCase();
        return { m, s: words.filter((w) => hay.includes(w)).length };
      });
      if (scored.some((x) => x.s)) list = scored.filter((x) => x.s).sort((a, b) => b.s - a.s).map((x) => x.m);
    }
    // The engine the user picked first, then the rest.
    list = [...list].sort((a, b) => Number(runsOn(b, ctx.engine)) - Number(runsOn(a, ctx.engine)));
    const shown = list.slice(0, 20);
    return {
      content: JSON.stringify({ engineMode: mode, preferredEngine: ctx.engine, total: list.length, models: shown.map(summarize) }),
      items: [{ id: "", role: "tool", text: `Looked up ${list.length} ${kind} model${list.length === 1 ? "" : "s"}${task ? ` for ${OPERATION_LABELS[task as Operation] ?? task}` : ""}` }],
    };
  },
});

// ---------------------------------------------------------------------------
// list_elements

/** The models an element's trained LoRA runs on: its family's (a LoRA from before O3 names its one model). */
const familyModels = (l: ElementLora): string[] => {
  const f = loraFamily(l);
  return f ? TRAINING_FAMILIES[f].models : [l.modelId];
};

const listElementsTool = defineTool({
  name: "list_elements",
  description:
    "List the user's saved Elements (characters, locations, props, styles, voices). Call it when the user mentions a character, person, place or product by name, or uses an @handle. Writing @handle in a generate prompt makes the model use that element's reference photos or trained identity.",
  schema: z.object({}),
  async run() {
    const els = listElements();
    return {
      content: JSON.stringify(
        els.map((e) => ({
          handle: `@${e.handle}`,
          name: e.name,
          kind: e.kind,
          description: e.description,
          referencePhotos: e.references.length,
          // The models its trained LoRAs run on (every model of each family), from LoRAs a run can use: not a demo
          // training's stand-in or an older Soul ID.
          trainedFor: [...new Set(e.loras.filter(runsSomewhere).flatMap((l) => familyModels(l)))],
        })),
      ),
      items: [{ id: "", role: "tool", text: `Checked your elements (${els.length})` }],
    };
  },
});

// ---------------------------------------------------------------------------
// list_recent / check_generations

function genSummary(id: string) {
  const g = getGeneration(id);
  if (!g) return { id, status: "unknown id" };
  return {
    id: g.id,
    status: g.status,
    model: g.modelId,
    op: g.op,
    kind: g.kind,
    prompt: g.request.prompt?.slice(0, 300),
    ...(g.progress !== null && g.status === "running" && { progress: g.progress }),
    ...(g.error && { error: g.error }),
    ...(g.provider === "mock" && { demo: true }),
    outputs: g.outputs.map((o) => ({
      url: o.url,
      kind: o.kind,
      ...(o.draftId && { draftId: o.draftId }),
      // Text results are read, not opened: a transcript, translation or script comes back inline.
      ...(o.text !== undefined && { text: o.text.length > 6000 ? `${o.text.slice(0, 6000)}… (${o.text.length} characters; the full text is at the URL)` : o.text }),
      ...(o.meta && outputMeta(o.meta)),
    })),
  };
}

/** The structured extras worth telling a model about (layer names and boxes, stems, cue counts). */
function outputMeta(meta: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "z", "bbox", "stem", "language", "turntable", "demo"]) if (meta[k] !== undefined) out[k] = meta[k];
  if (Array.isArray(meta.cues)) out.cues = meta.cues.length;
  if (Array.isArray(meta.textBlocks)) out.textBlocks = meta.textBlocks;
  return Object.keys(out).length ? { meta: out } : {};
}

const listRecent = defineTool({
  name: "list_recent",
  description:
    "List the user's most recent generations with their output URLs. Call it when the user refers to something they made earlier ('animate my last image', 'the one from before') so you can pass its URL as an input.",
  schema: z.object({
    limit: z.number().int().optional().describe("How many (default 8, up to 30)."),
    kind: z.enum(KINDS).optional(),
  }),
  async run({ limit, kind }) {
    const items = listGenerations({ kind, limit: Math.max(1, Math.min(30, limit ?? 8)) });
    return { content: JSON.stringify(items.map((g) => genSummary(g.id))) };
  },
});

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
const LOOK_LIMIT = 4;
const LOOK_BYTES = 3_500_000;

const checkGenerations = defineTool({
  name: "check_generations",
  description:
    "Get the status and output URLs of generations you started. Call it when you need an output to continue (animate an image you just made, upscale it, use it as a reference) — set wait_seconds to wait for them to finish. Set look to true to see finished images yourself, e.g. to pick the best take or check the result matches the brief.",
  schema: z.object({
    ids: z.array(z.string()).describe("Generation ids returned by generate or create_storyboard."),
    wait_seconds: z.number().int().optional().describe("Wait up to this long (max 120) for all of them to finish. 0 = just report."),
    look: z.boolean().optional().describe("Attach finished image outputs so you can see them (up to 4)."),
  }),
  async run({ ids, wait_seconds, look }) {
    const until = Date.now() + Math.max(0, Math.min(120, wait_seconds ?? 0)) * 1000;
    let summaries = ids.slice(0, 20).map(genSummary);
    while (Date.now() < until && summaries.some((s) => !TERMINAL.has(s.status))) {
      await new Promise((r) => setTimeout(r, 1500));
      summaries = ids.slice(0, 20).map(genSummary);
    }
    const blocks: Exclude<ResultContent, string | undefined> = [{ type: "text", text: JSON.stringify(summaries) }];
    if (look) {
      const images = summaries.flatMap((s) => ("outputs" in s ? (s.outputs ?? []).filter((o) => o.kind === "image").map((o) => ({ id: s.id, url: o.url })) : []));
      for (const img of images.slice(0, LOOK_LIMIT)) {
        try {
          const { data, contentType } = await readRef(img.url);
          if (data.length > LOOK_BYTES || !/^image\/(png|jpeg|webp|gif)$/.test(contentType)) continue;
          blocks.push({ type: "text", text: `Output of ${img.id}: ${img.url}` });
          blocks.push({ type: "image", source: { type: "base64", media_type: contentType as "image/png", data: data.toString("base64") } });
        } catch {
          // Unreadable output: the URL is still in the summary.
        }
      }
    }
    return {
      content: blocks,
      items: [{ id: "", role: "tool", text: `Checked ${ids.length} generation${ids.length === 1 ? "" : "s"}${look ? " and looked at the results" : ""}` }],
    };
  },
});

// ---------------------------------------------------------------------------
// generate

const Job = z.object({
  model_id: z.string().describe("Model id from search_models."),
  prompt: z.string().describe("The full prompt (for translate: the text to translate; for write: the brief). Put @handles here to use saved elements."),
  op: z
    .string()
    .optional()
    .describe(
      "Operation id (t2i, edit, t2v, i2v, flf2v, ref2v, extend, tts, layers, transcribe, translate, write, trim, captions, mux, separate-audio, image-to-3d, refine-3d, splat…). Usually inferred from the inputs; set it when ambiguous.",
    ),
  images: z.array(ref).optional().describe("Input images: the image to edit, the start frame, or references, in order."),
  end_image: ref.optional().describe("End frame (first-and-last-frame video)."),
  video: ref.optional().describe("Input video (extend, edit, lipsync, upscale, trim, captions, transcribe…)."),
  audio: ref.optional().describe("Input audio (lipsync, avatar, transcribe, separate-audio, mux; for voice-change the recording to re-voice)."),
  background_audio: ref
    .optional()
    .describe("Mux: a second track mixed under the audio — the background stem from separate-audio (music & effects, everything but the talking; DBS also makes music and effects stems on their own), or a music bed."),
  voice_audio: ref.optional().describe("A recording of the voice to speak with (voice-cloning text to speech) or to change into (voice-change)."),
  model3d: ref
    .optional()
    .describe("A 3D model (.glb) to work on: rig-3d rigs it; refine-3d (oss-hi3d-refine, Hi3D 1.0, the user's GPU only) refines its geometry from the photo in images (the photo it was made from)."),
  mesh_resolution: z
    .union([z.literal(512), z.literal(1024), z.literal(1536)])
    .optional()
    .describe("refine-3d: Hi3D's detail, 512 (one pass), 1024 (two, the default) or 1536 (three). On an open image-to-3d model, setting it also refines the model after it is built. The result is geometry only (colours and textures are lost). On oss-idol-mesh too it means that refine step, not a finer Idol mesh: leave it out to keep the vertex colours."),
  aspect_ratio: z.string().optional().describe("e.g. 16:9, 9:16, 1:1 — one the model lists."),
  resolution: z.string().optional().describe("e.g. 1080p, 2K — one the model lists."),
  duration: z.number().optional().describe("Seconds, for video and music — one the model lists."),
  outputs: z.number().int().optional().describe("How many takes (1–4)."),
  shots: z.number().int().optional().describe("Multi-shot video: cut the clip into this many shots (2–6), for models that list multi-shot."),
  generate_audio: z.boolean().optional().describe("Native audio on/off, for video models that offer it."),
  voice: z.string().optional().describe("Voice id for text to speech."),
  target_language: z.string().optional().describe("Language to translate or dub into, e.g. Spanish."),
  source_language: z.string().optional().describe("Language of the source speech or text, if known."),
  start_time: z.number().optional().describe("Trim: where the kept part starts, in seconds."),
  end_time: z.number().optional().describe("Trim: where the kept part ends, in seconds."),
  num_layers: z.number().int().optional().describe("Layers: how many layers to split the image into."),
  system: z.string().optional().describe("Write: extra instructions for the writer (tone, format, length)."),
  layout: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Image models that place boxes (MOSS-Image, FLUX.3, Ideogram 4.5): a pixel layout draft {width, height, bbox_coord_space: \"abs\", bbox_format: \"xyxy\", summary: {caption, meta, canvas}, items: [{label: object|character|text, caption, text, bbox: [x_min, y_min, x_max, y_max]}]} (the layout-poster skill). Fuobe compiles it for the model at the size it renders; other models read it as sentences.",
    ),
  keyframe_times: z.array(z.number()).optional().describe("Keyframes (2–10 images in order): each image's time in seconds, the first at 0."),
  gaps: z
    .array(z.object({ frames: z.number().int(), speed: z.number().int().optional(), words: z.string().optional() }))
    .optional()
    .describe(
      "Keyframe animation (fuobe-animation): one entry per gap between neighbouring images: frames drawn (4n + 1, 17–81), speed (keep every Nth frame, 1–4; the cloud keeps every frame), and what happens in that gap.",
    ),
  playback_fps: z.number().int().optional().describe("Keyframe animation: 24 (snappier, the default on the GPU) or 16 (true time; the cloud plays at 16)."),
  still_mouth: z.boolean().optional().describe("Keyframe animation: keep the character's mouth still between poses."),
  after: z
    .number()
    .int()
    .optional()
    .describe(
      "Index (0-based) of an earlier job in this same call whose result this job uses: it starts by itself when that job finishes. An image becomes the start frame or the image to edit, a video the input video, audio the soundtrack or the recording to re-voice (the voice to clone, for tts), text the prompt.",
    ),
  negative_prompt: z.string().optional(),
  look: z.string().optional().describe("Fuobe Soul / Soul HD: the look's id from search_models (v1-general, v1-y2k, v2-y2k-studio…). Leave it out for Soul's default look."),
  engine: z.enum(["open", "cloud"]).optional().describe("Fuobe Originals run on both engines: open = the user's GPU (free), cloud = hosted open weights (paid). Leave it out to follow the user's engine."),
});
type JobInput = z.infer<typeof Job>;

const SHOT_TYPES = ["Wide establishing shot", "Medium shot", "Close-up", "Detail shot", "Low-angle hero shot", "Slow push-in to the final frame"];

/** n shots that fit the model: per-shot clips for joined (open) models, one total length for the others. */
function shotList(model: ModelDef | undefined, n: number): { prompt: string; duration: number }[] | undefined {
  const ms = model?.options.multiShot;
  if (!ms) return undefined;
  const count = Math.max(2, Math.min(ms.maxShots, n));
  const durations = model.options.durations ?? [];
  let each = model.defaults?.duration ?? 5;
  if (ms.mode !== "concat") {
    const total = [...durations].sort((a, b) => a - b).find((d) => d % count === 0 && d / count >= 3) ?? Math.max(...durations, count * 3);
    each = total / count;
  }
  return Array.from({ length: count }, (_, i) => ({ prompt: SHOT_TYPES[i % SHOT_TYPES.length], duration: each }));
}

/** The engine the user works on (the install's only one when Settings → Engine mode allows one). */
const engineOf = (ctx: ToolContext): "cloud" | "open" => (engineMode() === "both" ? ctx.engine : (engineMode() as "cloud" | "open"));

/**
 * A job as a request; `engine` is the user's, which a Fuobe Original (both engines) runs on unless the job names one.
 * A retired model id or operation (an older plan, an MCP client's saved call) runs where it went (replaced.ts), so the
 * chain slots and checks below see the model and operation that run.
 */
function toRequest(job: JobInput, engine?: "cloud" | "open"): GenerationRequest {
  const req = currentRequest(asRequest(job)).request;
  const original = engine && dualEngine(getModel(req.modelId));
  return { ...req, ...((job.engine ?? (original ? engine : undefined)) && { engine: job.engine ?? engine }) };
}

/** A job as the request it names, before a retired model or operation is moved (toRequest). */
export function asRequest(j: JobInput): GenerationRequest {
  const inputs = {
    ...(j.images?.length && { images: j.images }),
    ...(j.end_image && { endImage: j.end_image }),
    ...(j.video && { video: j.video }),
    ...(j.audio && { audio: j.audio }),
    ...(j.background_audio && { audio2: j.background_audio }),
    ...(j.voice_audio && { voiceAudio: j.voice_audio }),
    ...(j.model3d && { model3d: j.model3d }),
  };
  const shots = j.shots && j.shots > 1 ? shotList(getModel(currentModelId(j.model_id)), j.shots) : undefined;
  // A layout draft (the layout-poster skill): read on its own canvas, compiled by the plan for the model it runs on.
  // Up to 64 boxes (as a Canvas Layout node); its own shape becomes the run's only as the nearest one the model lists.
  const parsed = j.layout ? parseLayout(j.layout)?.draft : undefined;
  const layout = parsed && { ...parsed, items: parsed.items.slice(0, LAYOUT_NODE_LIMITS.boxes) };
  const layoutAspect = layout?.aspect && nearestAspect(layout.aspect, getModel(currentModelId(j.model_id))?.options.aspectRatios);
  const extra = {
    ...(j.system && { system: j.system }),
    ...(layout && { [LAYOUT_PARAM]: layout }),
    // Hi3D: the refine's own resolution, or on an image-to-3D model the refine step after it.
    ...(j.mesh_resolution && { [j.model_id === HI3D_MODEL || j.op === HI3D_OP ? HI3D_PARAM : HI3D_CHAIN_PARAM]: j.mesh_resolution }),
  };
  const animation = animationOf(j);
  return {
    feature: "assist",
    modelId: j.model_id,
    ...(j.look && { presetId: j.look }),
    op: j.op as Operation | undefined,
    prompt: j.prompt,
    negativePrompt: j.negative_prompt,
    inputs: Object.keys(inputs).length ? inputs : undefined,
    params: {
      aspectRatio: j.aspect_ratio ?? layoutAspect,
      resolution: j.resolution,
      duration: shots ? undefined : j.duration,
      numOutputs: j.outputs ? Math.max(1, Math.min(4, j.outputs)) : undefined,
      generateAudio: j.generate_audio,
      voice: j.voice,
      targetLanguage: j.target_language,
      sourceLanguage: j.source_language,
      startTime: j.start_time,
      endTime: j.end_time,
      numLayers: j.num_layers,
      ...(shots && { shots }),
      ...(j.keyframe_times?.length && { keyframeTimes: j.keyframe_times }),
      ...((Object.keys(extra).length || animation) && { extra: { ...extra, ...animation } }),
      ...(animation?.inbetween?.gaps && !j.keyframe_times?.length && { keyframeTimes: keyTimes({ ...animation.inbetween, fps: animation.inbetween.fps ?? (j.engine === "cloud" ? 16 : 24) }) }),
    },
  };
}

/** A keyframe animation's timing from a job (gaps, playback rate, still mouth), as the request carries it. */
function animationOf(j: JobInput): { inbetween?: InbetweenTiming; stillMouth?: true } | undefined {
  if (!j.gaps?.length && !j.playback_fps && !j.still_mouth) return undefined;
  // Without a rate the engine's own plays it (24 fps on the GPU, 16 in the cloud: src/lib/inbetween.ts requestTiming).
  // A rate with no gaps rides alone: the gaps then come from the keyframe times at that rate.
  const inbetween = j.gaps?.length
    ? ({
        gaps: j.gaps.map((g) => ({ frames: g.frames, speed: (g.speed ?? 1) as Speed, ...(g.words?.trim() && { prompt: g.words.trim() }) })),
        ...(j.playback_fps && { fps: j.playback_fps as PlaybackFps }),
      } as InbetweenTiming)
    : j.playback_fps
      ? ({ fps: j.playback_fps as PlaybackFps } as InbetweenTiming)
      : undefined;
  return { ...(inbetween && { inbetween }), ...(j.still_mouth && { stillMouth: true as const }) };
}

/** Where an earlier job's result goes in a later one, by what it is and what the later job does. */
function slotFor(kind: MediaKind, op: Operation | undefined): ChainSlot {
  if (kind === "text") return { slot: "prompt" };
  if (kind === "video") return { slot: op === "concat" ? "videos" : "video" };
  // tts clones the earlier audio's voice; voice-change re-voices the earlier audio (its target voice is voice_audio);
  // a join takes it as one of its clips.
  if (kind === "audio") return { slot: op === "tts" ? "voiceAudio" : op === "audio-join" ? "audios" : "audio" };
  // A mesh goes on to be rigged or refined.
  if (kind === "model3d") return { slot: "model3d" };
  return { slot: "images", position: "first" };
}

interface ChainedJob {
  job: JobInput;
  req: GenerationRequest;
  /** Index of the job this one waits for. */
  after?: number;
  preview?: ReturnType<typeof previewChained>;
  error?: string;
}

/** Validate and price the jobs of one generate call, wiring `after` into chain slots. Never throws. */
function chainJobs(jobs: JobInput[], engine?: "cloud" | "open"): ChainedJob[] {
  const out: ChainedJob[] = [];
  jobs.forEach((job, i) => {
    const req = toRequest(job, engine);
    const after = job.after;
    if (after === undefined) {
      try {
        out.push({ job, req, preview: previewChained(req, 0) });
      } catch (e) {
        out.push({ job, req, error: (e as Error).message });
      }
      return;
    }
    const dep = out[after];
    if (!Number.isInteger(after) || after < 0 || after >= i || !dep) {
      out.push({ job, req, after, error: `"after" must point at an earlier job in this call (0–${i - 1})` });
      return;
    }
    if (!dep.preview) {
      out.push({ job, req, after, error: `Job ${after} can't run, so this one can't either` });
      return;
    }
    const chained: GenerationRequest = { ...req, chain: [slotFor(outputKind(dep.preview.op, dep.preview.model), req.op)] };
    try {
      out.push({ job, req: chained, after, preview: previewChained(chained, 1) });
    } catch (e) {
      out.push({ job, req: chained, after, error: (e as Error).message });
    }
  });
  return out;
}

function plannedJob(c: ChainedJob): PlannedJob {
  if (c.preview) {
    const p = c.preview;
    return { tool: "generate", modelId: p.model.id, modelName: p.model.name, kind: outputKind(p.op, p.model), op: p.op, prompt: c.job.prompt, count: p.outputs, costUsd: p.costUsd, demo: p.demo };
  }
  const m = getModel(c.job.model_id);
  return { tool: "generate", modelId: c.job.model_id, modelName: m?.name ?? c.job.model_id, kind: m?.kind ?? "image", op: (c.job.op as Operation) ?? "t2i", prompt: c.job.prompt, count: 0, costUsd: 0, demo: false, error: c.error };
}

const GenerateInput = z.object({
  summary: z.string().describe("One short sentence describing the plan, shown on the approval card."),
  jobs: z
    .array(Job)
    .describe("1–6 jobs. Jobs run in parallel, except a job with \"after\", which waits for that earlier job and uses its result (a still, then animate it; transcribe, then translate, then voice it)."),
});

const generate = defineTool({
  name: "generate",
  description:
    "Start image, video, audio, text (transcribe, translate, write) or 3D generations, alone or chained with \"after\". The app shows the user the plan with its cost and runs it once they approve, so call this directly instead of asking for confirmation in text. Returns generation ids; their results appear in the chat by themselves.",
  schema: GenerateInput,
  gated: true,
  // Not strict: the API allows 24 optional parameters across all strict tools in a request, and a
  // job has more. Calls are validated with zod (validateInput / planFor / executeTool) instead, and
  // a malformed one goes back to the model as an error it can fix.
  // Chained jobs are one pipeline (all or nothing); separate jobs start one by one.
  plan: ({ jobs }, ctx) => {
    const list = jobs.slice(0, 6);
    const atomic = list.some((j) => j.after !== undefined) || undefined;
    return chainJobs(list, engineOf(ctx)).map((c) => ({ ...plannedJob(c), atomic }));
  },
  async run({ summary, jobs }, ctx) {
    const list = jobs.slice(0, 6);
    // The plan's jobs share a batch, so the Library stacks them under the plan's summary.
    const batchTitle = summary.trim().slice(0, 200) || undefined;
    if (list.some((j) => j.after !== undefined)) {
      // Chained jobs: one pipeline, created only if every step is valid.
      const chained = chainJobs(list, engineOf(ctx));
      const bad = chained.findIndex((c) => c.error);
      if (bad >= 0) return { content: JSON.stringify({ error: `Job ${bad}: ${chained[bad].error}` }), isError: true };
      const p = createPipeline(chained.map((c, i) => ({ key: `job${i}`, request: { ...c.req, batchTitle }, ...(c.after !== undefined && { after: `job${c.after}` }) })));
      const results = chained.map((c, i) => {
        const g = p.byKey[`job${i}`];
        return { model: c.job.model_id, started: [g.id], ...(c.after !== undefined && { waitsFor: p.byKey[`job${c.after}`].id }), demo: g.provider === "mock" || undefined, costUsd: g.costUsd || undefined };
      });
      return {
        content: JSON.stringify({ results, note: "Chained jobs start by themselves when the job they wait for finishes." }),
        items: [{ id: "", role: "generations", ids: p.items.map((g) => g.id) }],
      };
    }
    const ids: string[] = [];
    const results: unknown[] = [];
    const batch = list.length > 1 ? { batchId: nanoid(10) } : {};
    for (const j of list) {
      try {
        const gens = createGenerations({ ...toRequest(j, engineOf(ctx)), batchTitle }, batch);
        ids.push(...gens.map((g) => g.id));
        results.push({ model: j.model_id, started: gens.map((g) => g.id), demo: gens.some((g) => g.provider === "mock") || undefined, costUsd: gens.reduce((s, g) => s + (g.costUsd ?? 0), 0) || undefined });
      } catch (e) {
        results.push({ model: j.model_id, error: (e as Error).message });
      }
    }
    const failed = results.length && ids.length === 0;
    return {
      content: JSON.stringify(results),
      isError: !!failed,
      items: ids.length ? [{ id: "", role: "generations", ids }] : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// create_storyboard

const StoryboardInput = z.object({
  story: z.string().optional().describe("The story to split into frames (or give scenes)."),
  scenes: z.array(z.string()).optional().describe("One description per frame, in order (up to 8)."),
  frames: z.number().int().optional().describe("Number of frames when splitting a story (1–8, default 4)."),
  references: z.array(ref).optional().describe("Up to 4 character/style reference images used for every frame."),
  style: z.string().optional().describe("A look applied to every frame, e.g. 'moody 35mm film'."),
  aspect_ratio: z.string().optional(),
});

const storyboard = defineTool({
  name: "create_storyboard",
  description:
    "Make a storyboard: up to 8 consecutive frames of one film with the same characters and look, each made from the previous one. Use it for comics, storyboards, shot lists and 'tell this story in N images'. Gated by the same approval card as generate.",
  schema: StoryboardInput,
  gated: true,
  strict: true,
  plan: (s, ctx) => {
    const engine = engineMode() === "both" ? ctx.engine : (engineMode() as "cloud" | "open");
    const m = STORYBOARD_MODELS[engine];
    const n = Math.max(1, Math.min(8, s.scenes?.length || s.frames || 4));
    // Every frame priced on its own model (frame 1, then the next-frame model), as the Storyboard prices a board.
    let est: ReturnType<typeof estimateStoryboard> | null = null;
    let error: string | undefined;
    try {
      est = estimateStoryboard({ engine, story: s.story, scenes: s.scenes, frames: s.frames, references: s.references, style: s.style, aspectRatio: s.aspect_ratio });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!s.story?.trim() && !s.scenes?.some((x) => x.trim())) error = "Give a story or scenes";
    return [
      {
        tool: "create_storyboard",
        modelId: m.first,
        modelName: est?.models.join(" + ") || m.first,
        kind: "image",
        op: "storyboard",
        prompt: s.story || (s.scenes ?? []).join(" / "),
        count: n,
        costUsd: est ? est.costUsd : null,
        demo: est?.demo ?? false,
        error,
      },
    ];
  },
  async run(s, ctx) {
    const engine = engineMode() === "both" ? ctx.engine : (engineMode() as "cloud" | "open");
    const r = await createStoryboard({ engine, story: s.story, scenes: s.scenes, frames: s.frames, references: s.references, style: s.style, aspectRatio: s.aspect_ratio });
    return {
      content: JSON.stringify({ frames: r.items.map((g, i) => ({ id: g.id, scene: r.scenes[i] })), note: "Frames render one after another; each waits for the previous." }),
      items: [{ id: "", role: "generations", ids: r.items.map((g) => g.id), storyboard: true }],
    };
  },
});

// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDef<any>[] = [searchModels, listElementsTool, listRecent, checkGenerations, generate, storyboard, defineTool(katanaTool)];
export const getTool = (name: string) => TOOLS.find((t) => t.name === name);

// Skills, memory and project sources; then whole studios (layers, restyle, dub, faceless, ads, captions); then saved
// skills that run by themselves (run_skill).
TOOLS.push(...CONTEXT_TOOLS, ...STUDIO_TOOLS, ...SOUND_TOOLS, ...SKILL_TOOLS);

/** The approval card's heading for one gated call. */
export function cardTitle(name: string, input: unknown): string {
  const t = getTool(name);
  const parsed = t?.schema.safeParse(input);
  if (t?.title && parsed?.success) return t.title(parsed.data);
  const summary = (input as { summary?: unknown } | null)?.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return name === "create_storyboard" ? "Storyboard" : "Generate";
}

/** JSON Schema for the API: every object closed, constraints the API doesn't take removed (zod still checks them). */
export function apiSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (["$schema", "propertyNames", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "maxItems", "minItems", "multipleOf"].includes(k)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, walk(s)])) : walk(v);
    }
    // A map (a skill's values by input id) says what its values are; every other object is closed.
    if (out.type === "object" && (out.additionalProperties === undefined || out.additionalProperties === true || out.properties)) out.additionalProperties = false;
    return out;
  };
  return walk(json) as Anthropic.Beta.BetaTool.InputSchema;
}

export function apiTools(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: apiSchema(t.schema),
    ...(t.strict && { strict: true }),
  }));
}

const describeIssues = (issues: { path: PropertyKey[]; message: string }[]) => `Invalid input: ${issues.map((i) => `${i.path.map(String).join(".")} ${i.message}`).join("; ")}`;

/** The error a tool call's arguments would get, or null when they're valid (with a chat's context, its own check too). */
export function validateInput(name: string, input: unknown, ctx?: ToolContext): string | null {
  const tool = getTool(name);
  if (!tool) return `Unknown tool ${name}`;
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return describeIssues(parsed.error.issues);
  return ctx && tool.check ? tool.check(parsed.data, ctx) : null;
}

/**
 * Price a gated call. Arguments are validated first: plan() only ever sees input its schema accepts.
 * Studio tools also say where the job opens (studio and its page) or why it runs in the Library.
 */
export function planFor(name: string, input: unknown, ctx: ToolContext): { jobs: PlannedJob[]; total: number | null; error?: string } & JobPlace {
  const t = getTool(name);
  if (!t?.plan) return { jobs: [], total: 0 };
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) return { jobs: [], total: 0, error: describeIssues(parsed.error.issues) };
  const jobs = t.plan(parsed.data, ctx);
  return { jobs, total: totalCost(jobs), ...t.place?.(parsed.data, ctx) };
}

/** Validate and run a tool. Never throws: failures come back as an error result. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = getTool(name);
  if (!tool) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { content: describeIssues(parsed.error.issues), isError: true };
  try {
    return await tool.run(parsed.data, ctx);
  } catch (e) {
    return { content: (e as Error).message, isError: true };
  }
}
