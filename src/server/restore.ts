import "server-only";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import {
  CLOUD_NOTE,
  GATED_NOTE,
  GPU_NOTE,
  offlineRestorePrompt,
  parsePromptAnswer,
  planRestore,
  PROMPT_SYSTEM,
  promptRequest,
  RESTORE,
  RESTORE_UPSCALE,
  restoreNegative,
  restoreProblem,
  restoreTitle,
  tileGrid,
  type RestorePlanInput,
  type Size,
} from "@/lib/catalog/restore";
import type { PlanStep } from "@/lib/catalog/shorts";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { ACCESS_PLACE } from "@/lib/model-access";
import { createPipeline } from "./chains";
import { llmText, llmTextBackend } from "./enhance";
import { previewChained } from "./generations";
import { gatedFileReady, gatedHint } from "./loras";
import { isOffered, offeredModel } from "./model-access";
import { localLabel, localWhat, probeLocal } from "./llm";
import { engineMode, getSetting } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { tenant } from "./tenant";

/**
 * Video tools → Restore & colourise (Fuobe Restore, package archive-restore): plans, prices and starts a run
 * (src/lib/catalog/restore.ts) as one pipeline of ordinary generations: feature "restore" for the finished video,
 * "restore-step" for the windows, pieces, hand-off frames and joins. The prompt is written by an LLM from a few frames
 * (Claude, or a local model on the open engine), else by Fuobe's offline template. No table of its own: the page's history is a
 * feed. The gated Restore IC-LoRA is fetched before the first window with the user's Hugging Face token (src/server/loras.ts).
 */

export { ShortsError as RestoreError };

/** An account's answer to a cloud run: it restores on its own GPU (its page runs there already). */
export const RESTORE_ON_YOUR_GPU = "Restore this clip on your own GPU: switch to open source.";

const fileUrl = z.string().startsWith("/api/files/").max(500);

const source = z.object({
  url: fileUrl,
  name: z.string().max(200).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  fps: z.number().finite().positive().max(240).optional(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  hasAudio: z.boolean().optional(),
});

/** The body of /api/restore (and /estimate). */
export const RestoreBodySchema = z.object({
  engine: z.enum(["cloud", "open"]),
  source,
  /** Period, place, light, materials, clothing; empty: written before the run (LLM or the offline template). */
  prompt: z.string().max(4000).optional(),
  /** What it must not invent; empty: the default list. */
  negative: z.string().max(4000).optional(),
  /** Your few words for the writer, when the prompt is left to it. */
  hint: z.string().max(600).optional(),
  /** GPU only: Restore to 4K (the Detail Refine pass). */
  refine: z.boolean().optional(),
  /** GPU only: keep one field of interlaced frames first (ComfyUI has no fieldmatch / yadif / decimate node). */
  deinterlace: z.boolean().optional(),
  /** Upscale the restored clip after (Upscale → Restore archive footage first): Topaz Video in the cloud, SeedVR2 on your GPU. */
  upscale: z.boolean().optional(),
  /** A reference picture (true colours, a face, a sign). */
  reference: fileUrl.optional(),
  resolution: z.string().max(10).optional(),
  seed: z.number().int().min(0).max(2 ** 48).optional(),
  requestId: z.string().trim().min(8).max(64).optional(),
});
export type RestoreBody = z.input<typeof RestoreBodySchema>;

/** The estimate is asked for before the upload finishes: any URL stands in. */
export const RestoreEstimateSchema = RestoreBodySchema.extend({
  source: source.extend({ url: z.string().max(500).default("/api/files/placeholder.mp4") }),
  reference: z.string().max(500).optional(),
});

const frame = z
  .string()
  .max(900_000)
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);

/** The body of /api/restore/prompt: what the writer works from (it stays under the sign-in proxy's 4 MB: next.config.ts). */
export const PromptSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  hint: z.string().max(600).optional(),
  /** A few frames of the clip the browser grabbed (small JPEG or PNG data URLs, under 900 KB each). */
  frames: z.array(frame).max(4).default([]),
  seconds: z.number().finite().positive().max(3600).optional(),
});

const mustMatchMode = (engine: Engine) => {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    throw new ShortsError(
      mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs paid cloud APIs only (Settings → Engine mode), and this runs on your GPU (open source)",
      422,
    );
  }
};

const mustBeOffered = (engine: Engine) => {
  if (!isOffered(RESTORE.model, engine)) throw new ShortsError(`Fuobe Restore is switched off ${engine === "open" ? "on your GPU" : "in the cloud"} in ${ACCESS_PLACE}`, 422);
};

// ---------------------------------------------------------------------------
// The prompt

export interface PromptAnswer {
  prompt: string;
  negative: string;
  /** Claude, a local model (Settings → AI helper: Ollama, LM Studio, Unsloth Studio or another server), or the template. */
  by: "claude" | "local" | "offline";
  why?: string;
}

/**
 * Write the prompt and the negative: Claude (cloud engine) or a local model that sees pictures (open engine, or no
 * Claude key; src/server/llm) sees up to four frames; without one (no key, no local model answering, demo mode, the
 * text model switched off) Fuobe's offline template is filled with the user's words. Never generates video.
 */
export async function writeRestorePrompt(body: z.infer<typeof PromptSchema>): Promise<PromptAnswer> {
  mustMatchMode(body.engine);
  const offline = (why: string): PromptAnswer => ({ ...offlineRestorePrompt(body.hint), by: "offline", why });
  if (getSetting("demoMode") === "on") return offline("demo mode");
  const textModel = getModel(body.engine === "open" ? "oss-text-llm" : "text-llm");
  if (!textModel || !offeredModel(textModel)) return offline(`the text model is switched off in ${ACCESS_PLACE}`);
  const backend = llmTextBackend();
  const local = backend === "ollama" || (backend === "claude" && body.engine === "open");
  if (!backend) return offline("no AI helper is set up (Settings → AI helper)");
  if (local && !(await probeLocal())) return offline(`${localWhat()} isn't running`);
  const images = body.frames.map((f) => ({ data: Buffer.from(f.split(",")[1], "base64"), contentType: f.slice(5, f.indexOf(";")) }));
  const answer = parsePromptAnswer(await llmText(PROMPT_SYSTEM, promptRequest({ hint: body.hint, frames: images.length, seconds: body.seconds }), images, { ollamaOnly: body.engine === "open" }));
  if (!answer) return offline(local ? `${localLabel()} didn't answer (it needs a model that sees pictures for the frames: qwen3-vl, gemma3…)` : "the text model didn't answer");
  return { ...answer, by: local ? "local" : "claude" };
}

// ---------------------------------------------------------------------------
// Plan, price, run

/**
 * Whether the gated LoRAs this run uses are within reach: a Hugging Face token, or what Fuobe already holds (a live
 * copy on fal for the cloud; the files in ComfyUI's LoRA folder on the GPU, the Detail Refine one too for Restore to 4K).
 */
function gatedReady(engine: Engine, refine?: boolean): boolean {
  if (engine === "cloud") return gatedFileReady(RESTORE.loras.restore.file, "fal");
  return gatedFileReady(RESTORE.loras.restore.file, "comfyui") && (!refine || gatedFileReady(RESTORE.loras.refine.file, "comfyui"));
}

function planInput(body: z.infer<typeof RestoreBodySchema>, info: Awaited<ReturnType<typeof probeSource>> | Record<string, never>, prompt: string, probed: boolean): { input: RestorePlanInput; notes: string[] } {
  const engine = body.engine;
  const src = {
    url: body.source.url,
    duration: info.duration ?? body.source.duration,
    fps: info.fps ?? body.source.fps,
    width: info.width ?? body.source.width,
    height: info.height ?? body.source.height,
    // Sound we couldn't read counts as none (putting it back would fail after the run was paid for).
    hasAudio: probed ? (info.hasAudio ?? false) : (body.source.hasAudio ?? false),
  };
  const resolution = engine === "cloud" ? (body.resolution ?? RESTORE.cloudResolution) : undefined;
  const problem = restoreProblem({ engine, source: src, refine: body.refine, resolution, upscale: body.upscale });
  if (problem) throw new ShortsError(problem, 422);
  if (engine === "cloud" && body.deinterlace) throw new ShortsError("Deinterlacing runs on your GPU: the cloud endpoint takes the clip as it is", 422);
  const notes: string[] = [];
  if (engine === "open") {
    notes.push(GPU_NOTE);
    if (body.deinterlace) notes.push("Deinterlacing keeps one field of each frame (ComfyUI has no field-matching filter; telecined film keeps its repeated frames)");
    if (body.refine) notes.push("Restore to 4K adds a detail pass at twice the size with Lightricks' Detail Refine IC-LoRA (1.3 GB, also gated): restore first, refine second");
    if (body.upscale) notes.push(`Then upscaled on your GPU with ${RESTORE_UPSCALE.open.label} (free)`);
  } else {
    notes.push(CLOUD_NOTE);
    notes.push("Each piece of up to 97 frames starts from the last restored frame of the one before, so the colour carries over");
    if (body.upscale) notes.push(`Then upscaled with ${RESTORE_UPSCALE.cloud.label}, priced in`);
  }
  if (body.reference) notes.push(engine === "open" ? "Your reference picture goes to every window at frame_idx −1 (true colours, faces, signs)" : "In the cloud your picture is the first frame: give the clip's first frame already in colour");
  // The token and the copies are the owner's: a visitor (priced as on its own GPU) is never told about them, and
  // Fuobe never downloads onto a visitor's ComfyUI.
  if (!tenant() && !gatedReady(engine, engine === "open" && body.refine)) notes.push(GATED_NOTE);
  if (src.hasAudio) notes.push("Your clip's own sound is put back on the result");
  return {
    notes,
    input: {
      engine,
      title: restoreTitle(prompt, body.source.name),
      source: src,
      prompt,
      negative: body.negative?.trim() || restoreNegative(),
      ...(engine === "open" && body.refine ? { refine: true } : {}),
      ...(engine === "open" && body.deinterlace ? { deinterlace: true } : {}),
      ...(body.reference ? { reference: body.reference } : {}),
      ...(resolution ? { resolution } : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.upscale ? { upscale: true } : {}),
    },
  };
}

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** What the steps cost together (null when a price is unknown) and whether they would run as a demo. */
function price(steps: PlanStep[]): { costUsd: number | null; demo: boolean } {
  let cost: number | null = 0;
  let demo = false;
  for (const s of steps) {
    let p: ReturnType<typeof previewChained>;
    try {
      p = previewChained(withChain(s), s.after?.length ?? 0);
    } catch (e) {
      throw new ShortsError((e as Error).message, 422);
    }
    demo ||= p.demo;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo };
}

export interface RestoreEstimate {
  costUsd: number | null;
  demo: boolean;
  engine: Engine;
  /** Windows (GPU) or pieces (cloud). */
  pieces: number;
  canvas: Size;
  tiles: number;
  refined?: Size;
  seconds: number;
  dropped: number;
  steps: number;
  resolution?: string;
  /**
   * The gated Restore IC-LoRA is within reach: a Hugging Face token is set, or Fuobe already holds a copy the run can
   * use. Left out for a visitor: the owner's token and copies are none of its business.
   */
  loraReady?: boolean;
  notes: string[];
}

export function estimateRestore(body: z.infer<typeof RestoreEstimateSchema>): RestoreEstimate {
  mustMatchMode(body.engine);
  mustBeOffered(body.engine);
  // The price doesn't depend on the words: a stand-in prompt when none is written yet.
  const { input, notes } = planInput(body as z.infer<typeof RestoreBodySchema>, {}, body.prompt?.trim() || offlineRestorePrompt(body.hint).prompt, false);
  const plan = planRestore(input);
  return {
    ...price(plan.steps),
    engine: body.engine,
    pieces: plan.pieces,
    canvas: plan.canvas,
    tiles: body.engine === "open" ? tileGrid(plan.canvas).tiles : 1,
    ...(plan.refined ? { refined: plan.refined } : {}),
    seconds: Math.round((input.source.duration ?? 0) * 100) / 100,
    dropped: plan.dropped,
    steps: plan.steps.length,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(tenant() ? {} : { loraReady: gatedReady(body.engine, body.engine === "open" && body.refine) }),
    notes,
  };
}

/** A run planned (the clip's header read, the words written when none were given), not started yet. */
export interface RestoreRun {
  steps: PlanStep[];
  final: string;
  prompt: string;
  negative: string;
  by: PromptAnswer["by"] | "you";
}

/**
 * Plan the run; a run with no prompt gets one written first. An account's words come from Fuobe's offline template
 * (the studio's AI helpers are the owner's), and its run is checked step by step before anything starts
 * (src/server/account-tool-run.ts).
 */
export async function planRestoreRun(body: z.infer<typeof RestoreBodySchema>): Promise<RestoreRun> {
  mustMatchMode(body.engine);
  mustBeOffered(body.engine);
  // An account restores on its own GPU only (own-setup.ts "video-tools:restore"): the cloud carries the gated Restore
  // IC-LoRA, which never goes with an account's own key (src/server/loras.ts prepareCloudLoras), so its cloud run would
  // only fail at submit, whatever copy or token the install holds.
  if (body.engine === "cloud" && tenant()) throw new ShortsError(RESTORE_ON_YOUR_GPU, 422);
  const info = await probeSource(body.source.url);
  let prompt = body.prompt?.trim() ?? "";
  let negative = body.negative?.trim() ?? "";
  let by: PromptAnswer["by"] | "you" = "you";
  // Refused before the writer is asked (a clip too long, 4K in the cloud).
  if (!prompt) planInput(body, info, "the scene, natural colour", true);
  if (!prompt) {
    const written = tenant() ? { ...offlineRestorePrompt(body.hint), by: "offline" as const } : await writeRestorePrompt({ engine: body.engine, hint: body.hint, frames: [], seconds: info.duration ?? body.source.duration });
    prompt = written.prompt;
    negative ||= written.negative;
    by = written.by;
  }
  const { input } = planInput({ ...body, negative }, info, prompt, true);
  const plan = planRestore(input);
  // The cloud carries the gated Restore IC-LoRA as Fuobe's copy, made with the Hugging Face token: with neither a token nor
  // a copy to send (a live one on fal, or the file on this machine), every piece would fail at submit, so the run is
  // refused before anything starts (a placeholder run needs no file).
  if (body.engine === "cloud" && !gatedReady("cloud") && !price(plan.steps).demo) {
    throw new ShortsError(`${gatedHint("Lightricks' Restore IC-LoRA", RESTORE.loras.restore.page)}. A cloud run gets Fuobe's copy of the file, never your token`, 422);
  }
  return { steps: plan.steps, final: plan.final, prompt, negative: input.negative, by };
}

/** A planned run's steps, for an account's checks. */
export const restoreSteps = (r: RestoreRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** Start a planned run: the finished video's generation, every step, and the words used. */
export function startRestore(r: RestoreRun): { final: Generation; items: Generation[]; prompt: string; negative: string; by: PromptAnswer["by"] | "you" } {
  let p: ReturnType<typeof createPipeline>;
  try {
    p = createPipeline(r.steps);
  } catch (e) {
    throw new ShortsError((e as Error).message, 422);
  }
  return { final: p.byKey[r.final], items: p.items, prompt: r.prompt, negative: r.negative, by: r.by };
}

/** Start the run; a run with no prompt gets one written first. Returns the finished video's generation and the words used. */
export async function createRestore(body: z.infer<typeof RestoreBodySchema>): Promise<{ final: Generation; items: Generation[]; prompt: string; negative: string; by: PromptAnswer["by"] | "you" }> {
  return startRestore(await planRestoreRun(body));
}
