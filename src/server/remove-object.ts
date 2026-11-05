import "server-only";
import { ORIGINAL_SOUND_IDS, originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import { PERSON_REMOVER_LORA } from "@/lib/catalog/character-swap";
import {
  chooseEraser,
  getEraser as chooseEraserById,
  paintedPoints,
  pieceSeconds,
  planPieces,
  planMaskPreview,
  planRemoval,
  previewIsEraserMask,
  previewIsGreen,
  rangeProblem,
  REMOVE,
  removalProblem,
  removalTitle,
  scalePoints,
  wholeClip,
  type Eraser,
  type RemovalPlanInput,
  type RemoveMode,
  type RemoveRange,
  type RemoveSource,
  MAX_WINDOW_SEED,
  REVIEW_EXTRA,
  rerollControls,
  rerollProblem,
  reviewOfOutput,
} from "@/lib/catalog/remove-object";
import type { PlanStep } from "@/lib/catalog/shorts";
import type { Engine, GenParams, Generation, GenerationRequest, PixelPoint } from "@/lib/catalog/types";
import { generationAccount } from "./account-library";
import { createPipeline } from "./chains";
import { ConnectComfyError, getGeneration, previewChained } from "./generations";
import { db } from "./db";
import { ACCESS_PLACE } from "@/lib/model-access";
import { isOffered, offeredLoras } from "./model-access";
import { decodePng } from "./png";
import { engineMode } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { readRef } from "./storage";
import { tenantAccount } from "./tenant";

/**
 * Video tools → Remove object: plans, prices and starts a removal (src/lib/catalog/remove-object.ts) as one
 * pipeline of ordinary generations: feature "remove-object" for the finished video, "remove-object-step" for
 * the cuts, tracks, pieces and joins, "remove-object-preview" for mask previews. No table of its own: the
 * page's history is a feed.
 */

export { ShortsError as RemovalError };

export interface RemovalBody {
  engine: Engine;
  mode: RemoveMode;
  /** The eraser picked (defaults per engine and mode). */
  modelId?: string;
  /** "Shadows and reflections too": VOID. */
  effects?: boolean;
  /** Type it: what to remove. */
  prompt?: string;
  /** Click it: points on the first frame of the range, in `frame` pixels. */
  points?: PixelPoint[];
  /** The picture the points or the paint were made on (the first frame the browser showed). */
  frame?: { width: number; height: number };
  /** Paint it: the mask of that frame (white = remove), an uploaded PNG. */
  mask?: string;
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean };
  range?: RemoveRange;
  seed?: number;
  /** H3 Person Removal: how far the person's mask is grown, in pixels. */
  maskGrow?: number;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
}

const fileUrl = z.string().startsWith("/api/files/").max(500);
const seconds = z.number().finite().min(0).max(3600);
const point = z.object({ x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000), label: z.enum(["positive", "negative"]).optional() });

/** The body of /api/remove-object (and /estimate, /preview). */
export const RemovalBodySchema = z.object({
  engine: z.enum(["cloud", "open"]),
  mode: z.enum(["type", "click", "paint"]),
  modelId: z.string().max(80).optional(),
  effects: z.boolean().optional(),
  // The page stops at REMOVE.maxPromptChars; longer is refused in words by planInput.
  prompt: z.string().max(2500).optional(),
  points: z.array(point).max(REMOVE.maxPoints).optional(),
  frame: z.object({ width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000) }).optional(),
  mask: fileUrl.optional(),
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
  seed: z.number().int().min(0).max(2 ** 48).optional(),
  maskGrow: z.number().int().min(REMOVE.maskGrow.min).max(REMOVE.maskGrow.max).optional(),
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound: z.enum(ORIGINAL_SOUND_IDS).optional(),
  /** A client nonce for one submit: a repeat gets the first answer (see once()). */
  requestId: z.string().trim().min(8).max(64).optional(),
});

/** The estimate is asked for before the upload finishes: any URL stands in. */
export const RemovalEstimateSchema = RemovalBodySchema.extend({
  source: RemovalBodySchema.shape.source.extend({ url: z.string().max(500).default("/api/files/placeholder.mp4") }),
  mask: z.string().max(500).optional(),
});

/**
 * Kling O3 edit is priced per generated second ($0.168/s, paid-model-apis-4.md §3), but the catalog model has no
 * price of its own (its text- and image-to-video routes cost less): the removal estimate uses the edit price.
 */
const EDIT_USD_PER_SECOND: Record<string, number> = { "kling-o3": 0.168 };

/**
 * LTX 2.3 Clean Plate is billed per megapixel of the video it makes ($0.0024075 × width × height × frames, rounded up;
 * paid-model-apis-4.md §3), not the catalog's flat $0.27 (121 frames at 1280×720): at 720p the source's shape with a
 * 720 px short side, for the piece's own frames.
 */
const MEGAPIXEL_USD: Record<string, number> = { "ltx-2-3-clean-plate": 0.0024075 };

function megapixels(params: GenParams | undefined, source: Pick<RemoveSource, "width" | "height">): number {
  const frames = Math.round((params?.sourceDuration ?? params?.duration ?? 0) * (params?.fps ?? 24));
  const { width: w, height: h } = source;
  const [ow, oh] = w && h ? (w >= h ? [Math.round((720 * w) / h), 720] : [720, Math.round((720 * h) / w)]) : [1280, 720];
  return Math.ceil((ow * oh * frames) / 1e6);
}

const mustMatchMode = (engine: Engine) => {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
};

/** Points a SAM 3.1 track starts from: the deepest points of the paint, in the clip's pixels. */
export async function pointsFromPaint(mask: string, size: { width?: number; height?: number }, empty = "Paint over what to remove first"): Promise<PixelPoint[]> {
  let png: ReturnType<typeof decodePng>;
  try {
    png = decodePng((await readRef(mask)).data);
  } catch {
    throw new ShortsError("Couldn't read the painted mask — paint it again", 400);
  }
  const on = new Uint8Array(png.width * png.height);
  for (let i = 0; i < on.length; i++) on[i] = png.data[i * 4] > 127 ? 1 : 0;
  const found = paintedPoints(on, png.width, png.height);
  if (!found.length) throw new ShortsError(empty);
  return size.width && size.height ? scalePoints(found, png, { width: size.width, height: size.height }) : found;
}

interface Planned {
  input: RemovalPlanInput;
  eraser: Eraser;
  notes: string[];
}

async function planInput(body: RemovalBody, opts: { probe: boolean; preview?: boolean }): Promise<Planned> {
  const info = opts.probe ? await probeSource(body.source.url) : {};
  const painted = body.mode === "paint" && body.engine === "cloud" && opts.probe && body.mask ? await pointsFromPaint(body.mask, { width: info.width ?? body.source.width, height: info.height ?? body.source.height }) : undefined;
  return planInputNow(body, opts, info, painted);
}

/** planInput once the clip's header and the paint's points are read (nothing to wait for). */
function planInputNow(body: RemovalBody, opts: { probe: boolean; preview?: boolean }, info: Awaited<ReturnType<typeof probeSource>> | Record<string, never>, painted?: PixelPoint[]): Planned {
  mustMatchMode(body.engine);
  const picked = chooseEraser({ engine: body.engine, mode: body.mode, effects: body.effects, modelId: body.modelId, offered: (id) => isOffered(id, body.engine) });
  if ("problem" in picked) throw new ShortsError(picked.problem, 422);
  const eraser = picked.eraser;
  // The header's facts win over what the browser read (the estimate runs before the upload is read).
  const source: RemoveSource = {
    url: body.source.url,
    duration: info.duration ?? body.source.duration,
    fps: info.fps ?? body.source.fps,
    width: info.width ?? body.source.width,
    height: info.height ?? body.source.height,
    // Sound we couldn't read counts as none (putting it back would fail after the erasing was paid for).
    hasAudio: opts.probe ? (info.hasAudio ?? false) : (body.source.hasAudio ?? false),
  };
  const range = body.range ?? (source.duration ? { start: 0, end: source.duration } : null);
  if (!range) throw new ShortsError("Reading the clip… try again in a moment");
  // A mask preview runs on SAM 3.1 alone: the eraser's own limits don't apply to it.
  const problem = opts.preview ? rangeProblem(source, range) : removalProblem(eraser, source, range);
  if (problem) throw new ShortsError(problem, 422);

  let points: PixelPoint[] | undefined;
  if (body.mode === "type" && !eraser.everyone && !body.prompt?.trim()) throw new ShortsError(eraser.cleanFrame ? "Say who to remove, e.g. “the man in the grey shirt”" : "Say what to remove, e.g. “the coffee cup in her hand”");
  // The Person Remover LoRA is what the H3 graph loads: switched off in Settings → Models & licences, it can't run.
  if (eraser.cleanFrame && offeredLoras([PERSON_REMOVER_LORA]).dropped.length) throw new ShortsError(`The H3 Person Remover LoRA is switched off in ${ACCESS_PLACE} — turn it on, or pick Wan 2.1 VACE + SAM 3.1`, 422);
  // Kling O3 edit takes 2500 characters, its template included: refused here, not after the cuts have run.
  if ((body.prompt?.trim().length ?? 0) > REMOVE.maxPromptChars) throw new ShortsError(`Say what to remove in up to ${REMOVE.maxPromptChars} characters`, 422);
  if (body.mode === "click") {
    const given = (body.points ?? []).slice(0, REMOVE.maxPoints);
    if (!given.some((p) => p.label !== "negative")) throw new ShortsError("Click what to remove on the first frame");
    points = body.frame && source.width && source.height ? scalePoints(given, body.frame, { width: source.width, height: source.height }) : given;
  }
  if (body.mode === "paint") {
    if (!body.mask) throw new ShortsError("Paint over what to remove first");
    // The cloud's tracker takes points, not paint; the open graph reads the mask itself.
    if (eraser.engine === "cloud") points = painted ?? [{ x: 1, y: 1, label: "positive" }];
  }

  const notes: string[] = [];
  const len = range.end - range.start;
  const model = getModel(eraser.id);
  const eraserName = model?.name ?? eraser.label;
  const fps = source.fps ?? 30;
  // The pieces (cloud) or windows (open) the selection is erased in.
  const pieces = eraser.window && !source.fps ? [] : planPieces(eraser, source, range);
  const count = eraser.window && !source.fps ? Math.ceil((len * fps) / eraser.window.cap) : pieces.length;
  // Frame-count erasers work in steps of frames: what's left at the end of the selection isn't erased (or kept).
  const dropped = eraser.window && pieces.length ? Math.round((len - (pieces[pieces.length - 1].end - range.start)) * fps) : 0;
  if (dropped > 0) {
    notes.push(`${eraserName} works in steps of ${eraser.window!.step} frames: the selection's last ${dropped === 1 ? "frame" : `${dropped} frames`} (${(dropped / fps).toFixed(2)} s) ${dropped === 1 ? "is" : "are"} left out`);
  }
  if (eraser.engine === "open") {
    const per = (eraser.window?.cap ?? 81) / fps;
    if (count > 1) {
      notes.push(`${eraserName} works on ${eraser.window?.cap} frames at a time (${per.toFixed(1)} s of this clip): the clip runs as ${count} windows, joined with its own sound`);
      if (eraser.modes.includes("paint")) notes.push("SAM 3.1 hands what you painted on from window to window (each starts on the last frame of the one before), so the windows run one after another");
    }
    if (eraser.cleanFrame) {
      notes.push(
        "Qwen-Image 2.1 first makes a clean copy of the part's first frame with the person gone; MiniMax H3 with Akatz Labs' Person Remover LoRA then rebuilds what was behind them, 22 frames at a time from it, and the clip's sound goes back on",
        "People only — for an object, pick Wan 2.1 VACE + SAM 3.1",
        "Preview the mask first: the person filled green, as H3 will see them — keep every part of them covered (hands, hair, a shadow); grow the mask if an edge shows",
        "When it's done, each 22-frame window has its own preview: redo a weak one with a new seed, and every window before it is kept exactly",
        "Needs the H3 Relay nodes on your ComfyUI and 24 GB of VRAM with offloading (64–128 GB of RAM); the part runs at 24 fps",
      );
    } else notes.push(eraser.effects ? "VOID needs a 24–40 GB GPU" : "Wan 2.1 VACE 14B needs a 24 GB GPU");
  } else {
    const max = pieceSeconds(eraser, source.fps);
    const limit = eraser.window ? `up to ${eraser.window.cap} frames (${max.toFixed(1)} s of this clip)` : max < 5 ? "clips under 5 s" : `up to ${Math.floor(max)} s`;
    if (count > 1) notes.push(`${eraserName} takes ${limit}: the clip is cut into ${count} pieces, erased one by one and joined, with its own sound put back`);
    if (body.mode !== "type" && (body.mode === "paint" || count > 1)) notes.push("SAM 3.1 first follows what you " + (body.mode === "paint" ? "painted" : "clicked") + " through the whole selection; Bria then erases that mask");
    if (eraser.everyone) notes.push("LTX Clean Plate removes every person in the shot — it doesn't take a target");
  }
  if (!wholeClip(range, source.duration)) notes.push("Only the selected part comes out (the rest of the clip isn't kept)");

  const name = (body.source.name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, 40);
  const title = removalTitle({ mode: body.mode, prompt: body.prompt, everyone: eraser.everyone });
  return {
    eraser,
    notes,
    input: {
      engine: body.engine,
      mode: body.mode,
      eraser,
      title: name ? `${title} · ${name}` : title,
      source,
      range,
      prompt: body.prompt?.trim() || undefined,
      points,
      mask: body.mode === "paint" && eraser.engine === "open" ? body.mask : undefined,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(eraser.cleanFrame && body.maskGrow !== undefined ? { maskGrow: body.maskGrow } : {}),
      // What of the clip's sound goes back: the cloud puts it all back (DBS runs on your GPU).
      ...(body.originalSound && { originalSound: originalSoundOn(body.originalSound, body.engine) }),
    },
  };
}

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** What the steps cost together (null when a price is unknown) and whether they would run as a demo. */
function price(steps: PlanStep[], source: RemoveSource): { costUsd: number | null; demo: boolean } {
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
    const edit = EDIT_USD_PER_SECOND[s.request.modelId];
    const perMp = MEGAPIXEL_USD[s.request.modelId];
    const usd =
      !p.demo && perMp !== undefined ? perMp * megapixels(s.request.params, source) : (p.costUsd ?? (edit !== undefined ? edit * (s.request.params?.duration ?? 0) : null));
    cost = cost === null || usd === null ? null : cost + usd;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo };
}

export interface RemovalEstimate {
  costUsd: number | null;
  demo: boolean;
  /** The eraser that runs (the default for the mode, or the one picked). */
  modelId: string;
  modelName: string;
  /** Pieces (cloud) or windows (open) the clip is erased in. */
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
  /** The mask preview's price, or null when this engine and mode have none. */
  previewUsd: number | null;
  /** The preview is H3 Person Removal's green mask (the person filled green, thresholded and grown). */
  previewGreen: boolean;
  /**
   * Whether the preview is the mask the eraser works from; false: only how SAM 3.1 reads the words or clicks
   * (Kling O3 edit and Bria find the object themselves).
   */
  previewExact: boolean;
}

export async function estimateRemoval(body: RemovalBody): Promise<RemovalEstimate> {
  return estimateRemovalNow(body);
}

/** The estimate without waiting (it reads nothing: the browser's facts stand in for the header). */
export function estimateRemovalNow(body: RemovalBody): RemovalEstimate {
  const { input, eraser, notes } = planInputNow(body, { probe: false }, {});
  const plan = planRemoval(input);
  const preview = planMaskPreview(input);
  return {
    ...price(plan.steps, input.source),
    modelId: eraser.id,
    modelName: getModel(eraser.id)?.name ?? eraser.label,
    pieces: plan.pieces.length,
    seconds: Math.round((input.range.end - input.range.start) * 100) / 100,
    steps: plan.steps.length,
    notes,
    previewUsd: preview ? price(preview, input.source).costUsd : null,
    previewExact: !!preview && previewIsEraserMask(eraser, plan.tracked),
    previewGreen: previewIsGreen(eraser),
  };
}

function run(steps: PlanStep[]) {
  try {
    return createPipeline(steps);
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

/** A planned run: its steps and the key of the one that makes the finished video. Nothing is created yet. */
export interface RemovalRun {
  steps: PlanStep[];
  final: string;
}

/** A planned run's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts). */
export const removalSteps = (r: RemovalRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** Start a planned run; returns the finished video's generation and every step. */
export function startRemoval(r: RemovalRun): { final: Generation; items: Generation[] } {
  const p = run(r.steps);
  return { final: p.byKey[r.final], items: p.items };
}

/** Plan a removal (the clip's header and the paint are read; nothing is created). */
export async function planRemovalRun(body: RemovalBody): Promise<RemovalRun> {
  const { input } = await planInput(body, { probe: true });
  const plan = planRemoval(input);
  return { steps: plan.steps, final: plan.final };
}

/** Start the removal; returns the finished video's generation (the other steps wait for each other). */
export async function createRemoval(body: RemovalBody): Promise<{ final: Generation; items: Generation[] }> {
  return startRemoval(await planRemovalRun(body));
}

/** Plan a mask preview of the first seconds (nothing is created). */
export async function planRemovalPreview(body: RemovalBody): Promise<RemovalRun> {
  const { input } = await planInput(body, { probe: true, preview: true });
  const steps = planMaskPreview(input);
  if (!steps) throw new ShortsError(input.engine === "open" ? "The open engine previews masks of what you type — your paint is the preview here" : "Name, click or paint what to remove first", 422);
  return { steps, final: "preview" };
}

/** A mask preview of the first seconds: what the engine would remove. */
export async function createRemovalPreview(body: RemovalBody): Promise<Generation> {
  return startRemoval(await planRemovalPreview(body)).final;
}

// ---------------------------------------------------------------------------
// "Redo from here": an H3 removal drawn again from one window, the windows before it kept exactly

export const RerollSchema = z.object({
  /** The removal step that made the windows (the one whose result carries the review). */
  id: z.string().min(1).max(64),
  /** The window to draw again (0-based); every window before it is kept. */
  window: z.number().int().min(0).max(1000),
  /** Its new seed (blank: a random one). */
  seed: z.number().int().min(0).max(MAX_WINDOW_SEED).optional(),
  requestId: z.string().trim().min(8).max(64).optional(),
});
export type RerollBody = z.infer<typeof RerollSchema>;

const NOT_FOUND = "We can't find that removal.";

/** The step that puts the sound back on a removal step's video, if the removal had one. */
function soundStepAfter(g: Generation): Generation | null {
  const rows = db()
    .prepare("SELECT id FROM generations WHERE batch_id IS ? AND (depends_on = ? OR depends_on LIKE ?) ORDER BY created_at")
    .all(g.batchId, g.id, `%"${g.id}"%`) as { id: string }[];
  for (const r of rows) {
    const next = getGeneration(r.id);
    if (next?.op === "mux") return next;
  }
  return null;
}

/** The step that cut the clip's original sound for a removal's mux (when the part isn't the whole clip). */
function soundCutOf(mux: Generation): Generation | null {
  const rows = db().prepare("SELECT id FROM generations WHERE batch_id IS ? AND op = 'trim' ORDER BY created_at").all(mux.batchId) as { id: string }[];
  for (const r of rows) {
    const g = getGeneration(r.id);
    if (g && g.id !== mux.id && g.request.step?.label === "Original sound") return g;
  }
  return null;
}

/** A step's request as it was asked, without what belonged to that run only. */
function askedAgain<T extends object>(request: T): T {
  const req = { ...request } as T & Record<string, unknown>;
  for (const k of ["asked", "chainFilled", "chainSkipped", "notice", "chain"]) delete req[k];
  return req;
}

/**
 * Redo an H3 person removal from one window: the same graph sent to the same ComfyUI with H3 Relay's window controls,
 * so the windows before it come back from their checkpoints exactly, the window is drawn with a new seed and the ones
 * after it continue from it; then the clip's sound goes back on as before. Returns the new finished video.
 */
export async function createRemovalReroll(body: RerollBody): Promise<{ final: Generation; items: Generation[] }> {
  return startRemoval(planRemovalReroll(body));
}

/**
 * Plan "Redo from here" (nothing is created). The removal must be the asker's own: an account's own run, or the owner's
 * when the owner asks; anyone else's reads as not found.
 */
export function planRemovalReroll(body: RerollBody): RemovalRun {
  const erase = getGeneration(body.id);
  if (!erase || (erase.feature !== REMOVE.feature && erase.feature !== REMOVE.stepFeature)) throw new ShortsError(NOT_FOUND, 404);
  if ((generationAccount(erase.id) ?? null) !== (tenantAccount() ?? null)) throw new ShortsError(NOT_FOUND, 404);
  if (!getEraserCleanFrame(erase.modelId)) throw new ShortsError("Only an H3 person removal can be redone from a window", 422);
  if (erase.status !== "succeeded") throw new ShortsError("Wait for the removal to finish first", 409);
  mustMatchMode("open");
  const out = erase.outputs.find((o) => o.kind === "video");
  const review = reviewOfOutput(out?.meta);
  const problem = rerollProblem(review, body.window);
  if (problem || !review) throw new ShortsError(problem ?? NOT_FOUND, 422);
  const seed = body.seed ?? Math.floor(Math.random() * 2 ** 32);
  const controls = rerollControls(review, body.window, seed);
  if (!controls) throw new ShortsError("The windows before this one weren't saved — redo from the first window", 422);

  // The step as it ran (its chained inputs filled in), without what belongs to that run only.
  const req = askedAgain(erase.request);
  const masterSeed = Number(review.seed);
  const mux = soundStepAfter(erase);
  // The sound goes back as before: the mux's own audio, or (when that mux never started) the original sound cut again.
  const audio = mux?.request.inputs?.audio;
  const cut = mux && !audio ? soundCutOf(mux) : null;
  if (mux && !audio && !cut) throw new ShortsError("This removal's sound wasn't ready — run the removal again", 409);
  const was = (erase.request.batchTitle ?? erase.request.title ?? "Remove a person").replace(/ · from window \d+$/, "");
  const title = `${was} · from window ${body.window + 1}`;
  const steps: PlanStep[] = [
    {
      key: "erase0",
      request: {
        ...req,
        feature: mux ? REMOVE.stepFeature : REMOVE.feature,
        batchTitle: title,
        title,
        params: {
          ...erase.request.params,
          ...(Number.isSafeInteger(masterSeed) ? { seed: masterSeed } : {}),
          extra: { ...erase.request.params?.extra, [REVIEW_EXTRA.controls]: controls, [REVIEW_EXTRA.reuse]: review.reuse },
        },
        step: { label: `Redo from window ${body.window + 1} (MiniMax H3)`, index: 0, of: 2 },
      },
    },
  ];
  if (cut) steps.push({ key: "sound", request: { ...askedAgain(cut.request), batchTitle: title } });
  if (mux) {
    steps.push({
      key: "final",
      request: {
        feature: REMOVE.feature,
        batchTitle: title,
        title,
        modelId: mux.modelId,
        op: "mux",
        ...(audio ? { inputs: { audio } } : {}),
        step: { label: "Put the sound back", index: 1, of: 2 },
      },
      after: cut ? ["erase0", "sound"] : ["erase0"],
      chain: cut ? [{ slot: "video" }, { slot: "audio" }] : [{ slot: "video" }],
    });
  }
  return { steps, final: mux ? "final" : "erase0" };
}

const getEraserCleanFrame = (modelId: string) => !!chooseEraserById(modelId)?.cleanFrame;
