import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  heuristicScenes,
  MAX_FRAMES,
  parseScenes,
  planOneSheet,
  planStoryboard,
  sheetPanelLimit,
  SPLIT_SYSTEM,
  STORYBOARD_NEXT_SCENE_IDS,
  STORYBOARD_PARTNER_IDS,
  type StoryboardLook,
  type StoryboardNextScene,
  type StoryboardPartner,
  type FrameRequest,
} from "@/lib/catalog/storyboard";
import { soulLook } from "@/lib/catalog/soul";
import type { Engine, Generation, GenerationRequest, ModelDef } from "@/lib/catalog/types";
import { storyboardName } from "@/lib/storyboard-board";
import { supportsOp } from "@/lib/catalog";
import { COPY_JOIN_VIDEOS } from "@/lib/catalog/clip-lengths";
import { filmModel, joinClips, joinModelId } from "./chains";
import { llmText } from "./enhance";
import { createGenerations, listGenerations, previewChained } from "./generations";
import { ShortsError } from "./shorts";
import { tenantAccount } from "./tenant";

/** The body of POST /api/storyboards and /api/storyboards/estimate. */
export const StoryboardBodySchema = z.object({
  engine: z.enum(["cloud", "open"]),
  /** A partner model for every frame instead of Fuobe's open recipe (cloud only): "nano-banana-pro". */
  partner: z.enum(STORYBOARD_PARTNER_IDS).optional(),
  /** The next frames on your GPU: "qwen-21" (Qwen-Image 2.1 + its Next-Scene LoRA, the default) or "classic" (Qwen-Image-Edit 2509). */
  nextScene: z.enum(STORYBOARD_NEXT_SCENE_IDS).optional(),
  scenes: z.array(z.string().max(1000)).max(8).optional(),
  story: z.string().max(4000).optional(),
  frames: z.number().int().min(1).max(8).optional(),
  references: z.array(z.string().startsWith("/api/files/")).max(4).optional(),
  style: z.string().max(500).optional(),
  /** A Fuobe Soul look id ("v1-general"): frame 1 on Fuobe Soul, the look's grade on every frame. */
  look: z.string().max(80).optional(),
  lookStrength: z.number().min(0).max(1).optional(),
  aspectRatio: z.string().max(10).optional(),
  resolution: z.string().max(10).optional(),
  /** One sheet: every panel drawn on one MOSS-Image page (a layout box per panel), cropped into frames in the browser. */
  sheet: z.boolean().optional(),
  /** Client nonce: a repeat of it (a second click) gets the board the first one started. */
  requestId: z.string().max(64).optional(),
});

export interface StoryboardRequest {
  engine: Engine;
  /** A partner model for the whole board (cloud only); unset: Fuobe's open recipe (Qwen-Image-Edit + next-scene). */
  partner?: StoryboardPartner;
  /** The next frames' model on your GPU (open only): Qwen-Image 2.1's Next-Scene LoRA unless "classic". */
  nextScene?: StoryboardNextScene;
  /** Manual: one prompt per frame. */
  scenes?: string[];
  /** Auto: one story, split into `frames`. */
  story?: string;
  frames?: number;
  references?: string[];
  style?: string;
  /** A Fuobe Soul look for the board (build plan O13): frame 1 on Fuobe Soul, the look's grade on every frame. */
  look?: string;
  lookStrength?: number;
  aspectRatio?: string;
  resolution?: string;
  /** One sheet: the whole board as one MOSS-Image page, one panel per scene, cropped into frames in the browser. */
  sheet?: boolean;
}

/**
 * Split a story into scenes with the configured LLM, or a deterministic shot list offline. Inside an account's run (or a
 * visitor's price check) the install's AI helper is never asked (enhance.ts llmTextBackend): the shot list is used.
 */
export async function splitStory(story: string, n: number): Promise<string[]> {
  // A local model that decodes to a schema gets exactly n strings (the prompt asks for the same array).
  const json = { name: "frames", schema: { type: "array", items: { type: "string" }, minItems: n, maxItems: n } };
  const text = await llmText(SPLIT_SYSTEM, `Story: ${story}\nFrames: ${n}`, { json });
  return (text && parseScenes(text, n)) || heuristicScenes(story, n);
}

/** The look as the planner takes it (its words), or an error for an unknown one. */
function boardLook(r: Pick<StoryboardRequest, "look" | "lookStrength">): StoryboardLook | undefined {
  if (!r.look) return undefined;
  const look = soulLook(r.look);
  if (!look) throw new Error("That look doesn't exist — pick another one");
  return { id: look.id, words: look.look, ...(r.lookStrength !== undefined && { strength: r.lookStrength }) };
}

/** Who a board is for: the owner, or a visitor (a signed-in account's run, or a price check). */
export interface StoryboardViewer {
  owner: boolean;
}
const OWNER: StoryboardViewer = { owner: true };

/**
 * The board's requests: one sheet (one MOSS-Image page with every panel; no look, references or partner model), or a frame
 * each, every later one made from the one before. One sheet is the owner's until a GPU render of it is recorded
 * (ONE_SHEET_GPU_TEST), then everyone's up to the panels that render showed.
 */
function boardFrames(r: StoryboardRequest, scenes: string[], batchTitle?: string, viewer: StoryboardViewer = OWNER): FrameRequest[] {
  if (r.sheet) {
    if (!viewer.owner && !sheetPanelLimit(false)) throw new Error("One sheet isn't available yet: make the board frame by frame");
    if (r.look) throw new Error("A one-sheet board has no look: make it frame by frame to use one");
    return [planOneSheet({ engine: r.engine, scenes, references: r.references, style: r.style, aspectRatio: r.aspectRatio, resolution: r.resolution, batchTitle })];
  }
  return planStoryboard({ engine: r.engine, partner: r.partner, nextScene: r.nextScene, scenes, references: r.references, style: r.style, look: boardLook(r), aspectRatio: r.aspectRatio, resolution: r.resolution, batchTitle });
}

/** What a board costs before it runs: each frame's price (frame 1 alone, the rest as chained steps), and whether it would be a demo. */
export function estimateStoryboard(r: StoryboardRequest, viewer: StoryboardViewer = OWNER): { costUsd: number | null; demo: boolean; frames: number; models: string[] } {
  const n = Math.max(1, Math.min(MAX_FRAMES, r.scenes?.filter((s) => s.trim()).length || r.frames || 4));
  const scenes = Array.from({ length: n }, (_, i) => r.scenes?.[i]?.trim() || `scene ${i + 1}`);
  const frames = boardFrames(r, scenes, undefined, viewer);
  let cost: number | null = 0;
  let demo = false;
  const models: string[] = [];
  frames.forEach((f, i) => {
    const p = previewChained(f, i ? 1 : 0);
    demo ||= p.demo;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
    if (!models.includes(p.model.name)) models.push(p.model.name);
  });
  return { costUsd: cost === null ? null : Math.round((cost as number) * 10000) / 10000, demo, frames: n, models };
}

/** A board planned (its story split into scenes, every frame's request made), not started yet. */
export interface StoryboardRun {
  scenes: string[];
  frames: FrameRequest[];
}

/**
 * Plan a board as it will start: nothing is made yet. An account's board is planned inside its own work
 * (src/server/account-tool-run.ts), so every frame is checked before any starts.
 */
export async function planStoryboardRun(r: StoryboardRequest, viewer: StoryboardViewer = OWNER): Promise<StoryboardRun> {
  const n = Math.max(1, Math.min(MAX_FRAMES, r.scenes?.length || r.frames || 4));
  const scenes = r.scenes?.length ? r.scenes.slice(0, MAX_FRAMES).map((s) => s.trim()).filter(Boolean) : await splitStory(r.story ?? "", n);
  if (!scenes.length) throw new Error("Describe the story or write at least one scene");
  // The board is named after the user's idea on every device (the Library's stack title too).
  const batchTitle = storyboardName(r.scenes?.length ? undefined : r.story, scenes);
  return { scenes, frames: boardFrames(r, scenes, batchTitle, viewer) };
}

/** A planned board's frames as the steps a run checks: frame 1 alone, each later frame waiting for the one before. */
export const storyboardSteps = (run: StoryboardRun): { request: GenerationRequest; deps: number }[] => run.frames.map((request, i) => ({ request, deps: i ? 1 : 0 }));

/** Start a planned board: frame 1 first, every later frame made from the one before. */
export function startStoryboard(run: StoryboardRun): { batchId: string; scenes: string[]; items: Generation[] } {
  const batchId = nanoid(10);
  const items: Generation[] = [];
  let previous: string | undefined;
  for (const request of run.frames) {
    const [g] = createGenerations(request, { batchId, dependsOn: previous });
    items.push(g);
    previous = g.id;
  }
  return { batchId, scenes: run.scenes, items };
}

/** Plan and start a board (the owner's; an account's goes through src/server/account-tool-run.ts). */
export async function createStoryboard(r: StoryboardRequest): Promise<{ batchId: string; scenes: string[]; items: Generation[] }> {
  return startStoryboard(await planStoryboardRun(r));
}

/** A board's film planned: each shot's request and the frames it waits for, then the join. Nothing is made yet. */
export interface StoryboardFilmRun {
  filmBatch: string;
  model: ModelDef;
  batchTitle: string;
  aspectRatio?: string;
  shots: { request: GenerationRequest & { batchTitle?: string }; after: string | string[] }[];
}

/**
 * Plan a storyboard's film: each frame is animated toward the next one (start + end frame when the model can, else from
 * its frame alone), then the clips are joined. Frames still rendering are waited for. Only the asker's own board: inside
 * an account's work its own frames (another's board, or the owner's, reads as not found); outside it, the owner's.
 */
export function planStoryboardFilm(batchId: string, opts: { modelId?: string } = {}): StoryboardFilmRun {
  const account = tenantAccount();
  const frames = listGenerations({ batchId, feature: "storyboard", limit: 50, ...(account && { account }) }).sort((a, b) => (a.request.frame?.index ?? 0) - (b.request.frame?.index ?? 0));
  if (account && !frames.length) throw new ShortsError("We can't find that storyboard.", 404);
  if (frames.length < 2) throw new Error("A film needs at least two frames");
  const broken = frames.find((f) => f.status === "failed" || f.status === "canceled");
  if (broken) throw new Error(`Frame ${(broken.request.frame?.index ?? 0) + 1} didn't render — retry it first`);
  const model = filmModel(frames[0].engine, opts.modelId);
  const flf = supportsOp(model, "flf2v");
  // Boards made before the server stored a name fall back to the first scene.
  const batchTitle = (frames[0].request as { batchTitle?: string }).batchTitle?.trim() || frames[0].request.frame?.scene || "Storyboard film";
  // A 21:9 board in a look is made at 16:9 and cropped after (frame.crop): its film is 21:9, like its frames.
  const aspectRatio = frames[0].request.frame?.crop ?? frames[0].request.params?.aspectRatio;
  const n = frames.length;
  const shots = frames.map((f, i) => {
    const next = flf ? frames[i + 1] : undefined;
    const scene = f.request.frame?.scene ?? f.request.prompt ?? "";
    const request: GenerationRequest & { batchTitle?: string } = {
      feature: "storyboard-film",
      modelId: model.id,
      prompt: next ? `${scene}. The shot moves naturally toward the next moment: ${next.request.frame?.scene ?? ""}` : `${scene}. Natural, cinematic motion.`,
      params: { aspectRatio, duration: model.defaults?.duration },
      chain: next ? [{ slot: "images", position: "first" }, { slot: "endImage" }] : [{ slot: "images", position: "first" }],
      step: { label: `Shot ${i + 1} of ${n}`, index: i, of: n },
      batchTitle,
    };
    return { request, after: next ? [f.id, next.id] : f.id };
  });
  return { filmBatch: `${batchId}-film`, model, batchTitle, aspectRatio, shots };
}

/** How many clips one join takes (ComfyUI's join takes 4 at a time unless it copies the clips as they are). */
const joinTakes = (run: StoryboardFilmRun) => (run.model.engine === "open" && !COPY_JOIN_VIDEOS.has(run.model.id) ? 4 : 24);

/**
 * A planned film as the steps a run checks: each shot (waiting for its frames), then the join waiting for the shots (once,
 * at the most clips one join takes: a longer film's joins run the same way).
 */
export function storyboardFilmSteps(run: StoryboardFilmRun): { request: GenerationRequest; deps: number }[] {
  const takes = Math.min(run.shots.length, joinTakes(run));
  const join: GenerationRequest = {
    feature: "storyboard-film",
    modelId: joinModelId(run.model.engine, COPY_JOIN_VIDEOS.has(run.model.id)),
    op: "concat",
    prompt: run.batchTitle,
    params: { aspectRatio: run.aspectRatio, resolution: run.model.defaults?.resolution },
    chain: Array.from({ length: takes }, () => ({ slot: "videos" as const })),
  };
  return [...run.shots.map((s) => ({ request: s.request, deps: Array.isArray(s.after) ? s.after.length : 1 })), { request: join, deps: takes }];
}

/** Start a planned film: the shots, then the join. */
export function startStoryboardFilm(run: StoryboardFilmRun): { batchId: string; items: Generation[] } {
  const n = run.shots.length;
  const clips = run.shots.map((s) => createGenerations(s.request, { batchId: run.filmBatch, dependsOn: s.after })[0]);
  const film = joinClips(
    clips.map((c) => c.id),
    {
      engine: run.model.engine,
      feature: "storyboard-film",
      batchId: run.filmBatch,
      title: run.batchTitle,
      aspectRatio: run.aspectRatio,
      resolution: run.model.defaults?.resolution,
      copy: COPY_JOIN_VIDEOS.has(run.model.id),
      step: { label: `Film · ${n} shots`, index: n, of: n + 1 },
    },
  );
  return { batchId: run.filmBatch, items: [film, ...clips] };
}

/** Turn a storyboard into a film (the owner's; an account's goes through src/server/account-tool-run.ts). */
export function createStoryboardFilm(batchId: string, opts: { modelId?: string } = {}): { batchId: string; items: Generation[] } {
  return startStoryboardFilm(planStoryboardFilm(batchId, opts));
}
