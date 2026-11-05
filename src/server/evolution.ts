import "server-only";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import {
  DIRECTION_CUT_NOTE,
  DIRECTION_SYSTEM,
  directionRequest,
  EVOLUTION,
  EVOLUTION_CLOUD_NOTE,
  EVOLUTION_DEFAULT_RESOLUTION,
  EVOLUTION_RESOLUTIONS,
  evolutionProblem,
  evolutionTitle,
  offlineDirection,
  planEvolution,
  resolutionChoices,
  tidyDirection,
  type EvolutionPlanInput,
  type Intensity,
} from "@/lib/catalog/evolution";
import { SHORTS, vaceDownsample, type PlanStep } from "@/lib/catalog/shorts";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { ACCESS_PLACE } from "@/lib/model-access";
import { createPipeline } from "./chains";
import { llmText, llmTextBackend } from "./enhance";
import { ConnectComfyError, previewChained } from "./generations";
import { isOffered, offeredModel } from "./model-access";
import { probeOllama } from "./providers/llm";
import { engineMode, getSetting } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { readRef } from "./storage";
import { tenantAccount } from "./tenant";

/**
 * Video tools → Evolution (Fuobe Evolution, build plan O13): plans, prices and starts a run (src/lib/catalog/evolution.ts)
 * as one pipeline of ordinary generations: feature "evolution" for the finished video, "evolution-step" for the cuts,
 * direction frames, segments and joins. The creative direction is written by an LLM from the references (Claude, or
 * Ollama on the open engine), else by Fuobe's offline writer. No table of its own: the page's history is a feed.
 */

export { ShortsError as EvolutionError };

const fileUrl = z.string().startsWith("/api/files/").max(500);
const seconds = z.number().finite().min(0).max(3600);
const intensity = z.enum(["low", "medium", "high"]);
// Hard caps on what a body may carry, well past the limits: a run over the limits is refused by evolutionProblem in
// words ("Use up to 40 references"), which a schema failure can't say.
const DIRECTION_CAP = EVOLUTION.maxDirectionChars * 10;
const REFERENCES_CAP = EVOLUTION.maxReferences * 10;

/** The body of /api/evolution (and /estimate). */
export const EvolutionBodySchema = z.object({
  engine: z.enum(["cloud", "open"]),
  intensity: intensity.default("medium"),
  /** The creative direction; empty: written before the run (LLM or offline writer). */
  direction: z.string().max(DIRECTION_CAP).optional(),
  /** Your few words for the writer, when the direction is left to it. */
  idea: z.string().max(2000).optional(),
  references: z.array(fileUrl).max(REFERENCES_CAP).default([]),
  source: z.object({
    url: fileUrl,
    name: z.string().max(200).optional(),
    duration: z.number().finite().positive().max(3600).optional(),
    fps: z.number().finite().positive().max(240).optional(),
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional(),
    hasAudio: z.boolean().optional(),
  }),
  range: z.object({ start: seconds, end: seconds }).optional(),
  resolution: z.string().max(10).optional(),
  seed: z.number().int().min(0).max(2 ** 48).optional(),
  /** A client nonce for one submit: a repeat gets the first answer (see once()). */
  requestId: z.string().trim().min(8).max(64).optional(),
});
export type EvolutionBody = z.input<typeof EvolutionBodySchema>;

/** The estimate is asked for before the upload finishes: any URL stands in, references may still be uploading. */
export const EvolutionEstimateSchema = EvolutionBodySchema.extend({
  source: EvolutionBodySchema.shape.source.extend({ url: z.string().max(500).default("/api/files/placeholder.mp4") }),
  references: z.array(z.string().max(500)).max(REFERENCES_CAP).default([]),
});

/** The body of /api/evolution/direction: what the writer works from. */
export const DirectionSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  intensity: intensity.default("medium"),
  idea: z.string().max(2000).optional(),
  references: z.array(fileUrl).max(REFERENCES_CAP).default([]),
  /** A frame of the clip the browser grabbed (a JPEG or PNG data URL, at most about 1.5 MB). */
  frame: z
    .string()
    .max(2_000_000)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
    .optional(),
  seconds: z.number().finite().positive().max(3600).optional(),
});

const mustMatchMode = (engine: Engine) => {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
};

const mustBeOffered = (engine: Engine) => {
  if (!isOffered(EVOLUTION.model, engine)) throw new ShortsError(`Fuobe Evolution is switched off ${engine === "open" ? "on your GPU" : "in the cloud"} in ${ACCESS_PLACE}`, 422);
};

// ---------------------------------------------------------------------------
// The creative direction

export interface DirectionAnswer {
  direction: string;
  /** Who wrote it. */
  by: "claude" | "ollama" | "offline";
  /** Why the offline writer wrote it, when it did. */
  why?: string;
}

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;

/** The references the writer can see: the first few, pictures only, each under 8 MB. */
async function referenceImages(urls: string[], max: number) {
  const out: { data: Buffer; contentType: string }[] = [];
  for (const u of urls) {
    if (out.length >= max) break;
    const f = await readRef(u).catch(() => null);
    if (f && IMAGE.test(f.contentType) && f.data.length <= 8 * 1024 * 1024) out.push({ data: f.data, contentType: f.contentType });
  }
  return out;
}

/**
 * Write the creative direction: Claude (cloud engine) or Ollama with a vision model (open engine, or no Claude key) sees
 * the clip's frame and the first references; without one (no key, Ollama not running, demo mode, the text model
 * switched off) Fuobe's offline writer builds it from the intensity, your words and the number of references.
 */
export async function writeDirection(body: z.infer<typeof DirectionSchema>): Promise<DirectionAnswer> {
  mustMatchMode(body.engine);
  if (body.references.length > EVOLUTION.maxReferences) throw new ShortsError(`Use up to ${EVOLUTION.maxReferences} references`, 422);
  const offline = (why: string): DirectionAnswer => ({ direction: offlineDirection({ intensity: body.intensity as Intensity, idea: body.idea, references: body.references.length }), by: "offline", why });
  // A signed-in account's direction is Fuobe's offline writer's: never this studio's AI helper (its LLM or its key), and
  // no word about the studio's setup.
  if (tenantAccount()) return { direction: offline("").direction, by: "offline" };
  if (getSetting("demoMode") === "on") return offline("demo mode");
  const textModel = getModel(body.engine === "open" ? "oss-text-llm" : "text-llm");
  if (!textModel || !offeredModel(textModel)) return offline(`the text model is switched off in ${ACCESS_PLACE}`);
  const backend = llmTextBackend();
  const ollama = backend === "ollama" || (backend === "claude" && body.engine === "open");
  if (!backend) return offline("no text model is set up (Settings → AI helper)");
  if (ollama && !(await probeOllama())) return offline("Ollama isn't running");
  const max = EVOLUTION.llmReferences[body.engine];
  const frame = body.frame ? [{ data: Buffer.from(body.frame.split(",")[1], "base64"), contentType: body.frame.slice(5, body.frame.indexOf(";")) }] : [];
  const refs = await referenceImages(body.references, max - frame.length);
  const user = directionRequest({ intensity: body.intensity as Intensity, idea: body.idea, references: body.references.length, sent: refs.length, frame: frame.length > 0, seconds: body.seconds });
  const answer = tidyDirection(await llmText(DIRECTION_SYSTEM, user, [...frame, ...refs], { ollamaOnly: body.engine === "open" }));
  if (!answer) return offline(ollama ? "Ollama didn't answer (it needs a vision model to see the references: qwen3-vl, gemma3…)" : "the text model didn't answer");
  return { direction: answer, by: ollama ? "ollama" : "claude" };
}

// ---------------------------------------------------------------------------
// Plan, price, run

interface Planned {
  input: EvolutionPlanInput;
  notes: string[];
}

function planInput(body: z.infer<typeof EvolutionBodySchema>, info: Awaited<ReturnType<typeof probeSource>> | Record<string, never>, direction: string, probed: boolean): Planned {
  const engine = body.engine;
  const source = {
    url: body.source.url,
    duration: info.duration ?? body.source.duration,
    fps: info.fps ?? body.source.fps,
    width: info.width ?? body.source.width,
    height: info.height ?? body.source.height,
    // Sound we couldn't read counts as none (putting it back would fail after the run was paid for).
    hasAudio: probed ? (info.hasAudio ?? false) : (body.source.hasAudio ?? false),
  };
  const range = body.range ?? (source.duration ? { start: 0, end: source.duration } : null);
  if (!range) throw new ShortsError("Reading the clip… try again in a moment");
  const resolution = body.resolution ?? EVOLUTION_DEFAULT_RESOLUTION[engine];
  const problem = evolutionProblem({ engine, source, range, references: body.references.length, direction, resolution });
  if (problem) throw new ShortsError(problem, 422);

  const notes: string[] = [];
  const name = getModel(EVOLUTION.model)?.name ?? "Fuobe Evolution";
  const n = body.references.length;
  if (engine === "open") {
    const k = Math.min(n, EVOLUTION.openReferences);
    notes.push(`Each ≤5 s segment: Qwen-Image 2.1 Turbo takes its first frame toward the direction${n ? ` with your first ${k === 1 ? "reference" : `${k} references`}` : ""}, then Wan 2.2 Fun VACE re-renders it from itself at 16 fps`);
    if (n > EVOLUTION.openReferences) notes.push(`The other ${n - EVOLUTION.openReferences} reference${n - EVOLUTION.openReferences > 1 ? "s" : ""} shape the direction only`);
    notes.push("Needs a 24 GB GPU");
  } else {
    const k = Math.min(n, EVOLUTION.cloudReferences);
    notes.push(`${name} runs the GPU's model hosted on fal: each ≤10 s piece's first frame is taken toward the direction by Qwen-Image-Edit 2511${n ? ` with your first ${k === 1 ? "reference" : `${k} references`}` : ""}, then Wan 2.2 Fun VACE re-renders the piece by its depth with that frame as its reference, in your clip's shape`);
    if (n > EVOLUTION.cloudReferences) notes.push(`The other ${n - EVOLUTION.cloudReferences} reference${n - EVOLUTION.cloudReferences > 1 ? "s" : ""} shape the direction only`);
    notes.push(EVOLUTION_CLOUD_NOTE);
    // fal bills frames ÷ 16 as video seconds; a clip above 30 fps is worked at a fraction of its rate (as in Shorts).
    const fps = source.fps;
    if (fps && fps > SHORTS.original.billFps + 0.5) notes.push(`fal bills this clip's ${Math.round(fps)} fps as ${(fps / SHORTS.original.billFps).toFixed(1)}× its length (video seconds at ${SHORTS.original.billFps} fps)`);
    if (vaceDownsample(fps)) notes.push(`Wan 2.2 Fun VACE works this ${Math.round(fps!)} fps clip at ${Math.round(fps! / (vaceDownsample(fps) + 1))} fps and brings it back to its own rate`);
  }
  if (source.hasAudio) notes.push("Your clip's own sound is put back on the result");
  const title = evolutionTitle(direction, body.source.name);
  return {
    notes,
    input: {
      engine,
      title,
      source,
      range,
      intensity: body.intensity as Intensity,
      direction,
      references: body.references,
      resolution,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
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
      if (e instanceof ConnectComfyError) throw e;
      throw new ShortsError((e as Error).message, 422);
    }
    demo ||= p.demo;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo };
}

export interface EvolutionEstimate {
  costUsd: number | null;
  demo: boolean;
  modelName: string;
  engine: Engine;
  resolution: string;
  /** Pieces (cloud) or segments (GPU). */
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
}

export function estimateEvolution(body: z.infer<typeof EvolutionEstimateSchema>): EvolutionEstimate {
  mustMatchMode(body.engine);
  mustBeOffered(body.engine);
  // The price doesn't depend on the words: a stand-in direction when none is written yet.
  const { input, notes } = planInput(body, {}, body.direction?.trim() || "the same scene", false);
  const plan = planEvolution(input);
  if (plan.cut) notes.push(DIRECTION_CUT_NOTE);
  return {
    ...price(plan.steps),
    modelName: getModel(EVOLUTION.model)?.name ?? "Fuobe Evolution",
    engine: body.engine,
    resolution: input.resolution ?? EVOLUTION_DEFAULT_RESOLUTION[body.engine],
    pieces: plan.pieces,
    seconds: Math.round((input.range.end - input.range.start) * 100) / 100,
    steps: plan.steps.length,
    notes,
  };
}

/** A planned run: its steps, the key of the finished video's step, and the direction it uses. Nothing is created yet. */
export interface EvolutionRun {
  steps: PlanStep[];
  final: string;
  direction: string;
  by: DirectionAnswer["by"] | "you";
}

/** A planned run's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts). */
export const evolutionSteps = (r: EvolutionRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** Start a planned run; returns the finished video's generation, every step and the direction used. */
export function startEvolution(r: EvolutionRun): { final: Generation; items: Generation[]; direction: string; by: DirectionAnswer["by"] | "you" } {
  let p: ReturnType<typeof createPipeline>;
  try {
    p = createPipeline(r.steps);
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
  return { final: p.byKey[r.final], items: p.items, direction: r.direction, by: r.by };
}

/** Start the run; a run with no direction gets one written first. Returns the finished video's generation and the direction used. */
export async function createEvolution(body: z.infer<typeof EvolutionBodySchema>): Promise<{ final: Generation; items: Generation[]; direction: string; by: DirectionAnswer["by"] | "you" }> {
  return startEvolution(await planEvolutionRun(body));
}

/** Plan the run (the clip's header is read, a direction written when none is given); nothing is created. */
export async function planEvolutionRun(body: z.infer<typeof EvolutionBodySchema>): Promise<EvolutionRun> {
  mustMatchMode(body.engine);
  mustBeOffered(body.engine);
  if (body.resolution && !EVOLUTION_RESOLUTIONS[body.engine].includes(body.resolution)) throw new ShortsError(`Pick ${resolutionChoices(body.engine)}`, 422);
  const info = await probeSource(body.source.url);
  let direction = body.direction?.trim() ?? "";
  let by: DirectionAnswer["by"] | "you" = "you";
  // Refused before the writer is asked (a clip too short, too many references).
  if (!direction) planInput(body, info, "the same scene", true);
  if (!direction) {
    const written = await writeDirection({ engine: body.engine, intensity: body.intensity, idea: body.idea, references: body.references, seconds: info.duration ?? body.source.duration });
    direction = written.direction;
    by = written.by;
  }
  const { input } = planInput(body, info, direction, true);
  const plan = planEvolution(input);
  return { steps: plan.steps, final: plan.final, direction, by };
}
