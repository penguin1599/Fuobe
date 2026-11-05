import "server-only";
import { ORIGINAL_SOUND_IDS, originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import { onEngine } from "@/lib/catalog/engines";
import {
  ANCHOR_MODELS,
  anchorModel,
  CHARACTER_GPU,
  CHARACTER_LIMITS,
  CHARACTER_SWAP,
  characterFinish,
  h3Canvas,
  cutWarning,
  h3Windows,
  swapLoraRef,
  SWAP_LORAS,
  TURBO_LORA,
  windowPlan,
  type CharacterOptions,
} from "@/lib/catalog/character-swap";
import { ACCESS_PLACE } from "@/lib/model-access";
import { CHARACTER_DESCRIBER, cleanDescription, DESCRIBE_PICTURE } from "@/lib/character-description";
import { openCapNote, SHARPEN_COPY, SHARPEN_SIGMA_RANGE } from "@/lib/catalog/sharpen";
import {
  ALL_FEATURES,
  chooseMaker,
  cutsInPart,
  faceChunkCount,
  GENJUTSU,
  getMaker,
  modeOpen,
  MOTION_H3,
  OPENJUTSU_LIMITS,
  requestFeatures,
  type FeatureCheck,
  type FinishOptions,
  type ObjectEdit,
  type PictureOptions,
  genjutsuProblem,
  genjutsuTitle,
  makersFor,
  MODE_TARGETS,
  planGenjutsu,
  planMakerPieces,
  qualityFor,
  makerStepUsd,
  resolutionWords,
  SOURCE_LABELS,
  type GenjutsuLook,
  type GenjutsuMode,
  type GenjutsuPlanInput,
  type GenjutsuTarget,
  type GenjutsuTier,
  type Maker,
  type MakerSource,
} from "@/lib/catalog/genjutsu";
import { MASK_TRACKER, REMOVE_TOOLS, scalePoints, wholeClip, type RemoveRange, type RemoveSource } from "@/lib/catalog/remove-object";
import { planSegments, type PlanStep } from "@/lib/catalog/shorts";
import type { Engine, Generation, GenerationRequest, PixelPoint, ProviderId } from "@/lib/catalog/types";
import { silenceWriter } from "./canvas";
import { createPipeline } from "./chains";
import { llmText, llmTextBackend } from "./enhance";
import { AccountRunError, ConnectComfyError, createGenerations, previewChained, previewGeneration } from "./generations";
import { db } from "./db";
import { genjutsuLive } from "./genjutsu-live";
import { ownSetupItem } from "@/lib/own-setup";
import { decodePng } from "./png";
import { LOOK_IDS, paintKeyframe, type LookId, type PaintKeyframe } from "@/lib/openjutsu-graphs";
import { localLabel } from "./llm";
import { isOffered, offeredLoras, offeredModel } from "./model-access";
import { provider } from "./providers";
import { probeOllama } from "./providers/llm";
import { pointsFromPaint } from "./remove-object";
import { engineMode, getSetting } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { readRef } from "./storage";
import { tenantAccount } from "./tenant";

/**
 * Fuobe Genjutsu (/genjutsu): plans, prices and starts a Motion transfer, Character swap, Object swap, Restyle or Insert
 * (src/lib/catalog/genjutsu.ts) as one pipeline of ordinary generations: feature "genjutsu" for the finished video,
 * "genjutsu-step" for the cuts, tracks, anchor frames, pieces and joins. No table of its own: the page's history is a
 * feed, and a setup travels as a code (encodeSetup), not a row. No Higgsfield model runs here.
 */

export { ShortsError as GenjutsuError };

export interface GenjutsuBody {
  engine: Engine;
  mode: GenjutsuMode;
  /** The model picked (defaults per engine and mode: the Fuobe Original). */
  modelId?: string;
  /** Lite ("standard") or the full Original ("high"). */
  tier?: GenjutsuTier;
  quality?: string;
  target?: GenjutsuTarget;
  /** Object swap: what goes. */
  subject?: string;
  /** Guidance (Character swap: your direction). */
  prompt?: string;
  points?: PixelPoint[];
  /** The picture the points or the paint were made on (the first frame the browser showed). */
  frame?: { width: number; height: number };
  mask?: string;
  references?: string[];
  look?: GenjutsuLook;
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean };
  range?: RemoveRange;
  seed?: number;
  /** Character swap's settings. */
  character?: CharacterOptions;
  /** Hard cuts the browser found in the clip (seconds), for the "one continuous shot" warning. */
  cuts?: number[];
  /** What of the clip's sound goes back where it is put back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
  /** Object swap on Scene edit. */
  object?: ObjectEdit;
  /** From picture: the first frame, or the video from an approved one. */
  picture?: PictureOptions;
  /** Finish: Fix faces or Fix colours. */
  finish?: FinishOptions;
}

/**
 * Who is asking: the owner sees and runs every feature; others what has opened (src/server/genjutsu-live.ts), and with
 * `ownSetup` (an account's run on its own GPU, account-tool-run.ts, or a price check) also what runs on a visitor's own
 * setup until it opens (src/lib/own-setup.ts).
 */
export interface GenjutsuViewer {
  owner: boolean;
  ownSetup?: boolean;
}

const OWNER: GenjutsuViewer = { owner: true };

/** The words a visitor gets for a feature that hasn't opened. */
export const NOT_HERE = "That isn't available here.";

const fileUrl = z.string().startsWith("/api/files/").max(500);
const seconds = z.number().finite().min(0).max(3600);
const point = z.object({ x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000), label: z.enum(["positive", "negative"]).optional() });
const look = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.string().max(80) }),
  z.object({ kind: z.literal("soul"), id: z.string().max(80) }),
  z.object({ kind: z.literal("custom"), images: z.array(fileUrl).max(GENJUTSU.maxLookImages), words: z.string().max(300).optional() }),
]);
const character = z.object({
  who: z.enum(["largest", "leftmost", "rightmost", "index"]).optional(),
  index: z.number().int().min(0).max(CHARACTER_SWAP.maxPeople - 1).optional(),
  subject: z.string().max(120).optional(),
  maskGrow: z.number().int().min(0).max(256).optional(),
  anchor: z.boolean().optional(),
  anchorModel: z.enum(["gpt-image-2-5-sunburst", "nano-banana-pro", "oss-qwen-image-21", "oss-krea2-identity-edit", "oss-qwen-edit"]).optional(),
  description: z.string().max(CHARACTER_SWAP.maxDescriptionChars).optional(),
  speech: z.enum(["character", "other", "offscreen", "none"]).optional(),
  dialogue: z.string().max(2000).optional(),
  lora: z.enum(["v1.5", "v1", "none"]).optional(),
  audioGuide: z.boolean().optional(),
  useMask: z.boolean().optional(),
  windowFrames: z.number().int().min(22).max(362).optional(),
  historyFrames: z.number().int().min(0).max(341).optional(),
  /** 1080p / 2K / 4K on your GPU: the regenerate's start noise (an evaluation knob; the page doesn't set it). */
  sharpenSigma: z.number().min(SHARPEN_SIGMA_RANGE.min).max(SHARPEN_SIGMA_RANGE.max).optional(),
  people: z
    .array(z.object({ role: z.string().max(OPENJUTSU_LIMITS.roleChars), pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional() }))
    .max(OPENJUTSU_LIMITS.maxCharacters)
    .optional(),
  onePerPerson: z.boolean().optional(),
  hats: z.boolean().optional(),
  mouthsFollowSound: z.boolean().optional(),
  edge: z.enum(["tight", "normal", "loose"]).optional(),
  motionDetail: z.union([z.literal(512), z.literal(768)]).optional(),
});
const objectEdit = z.object({
  action: z.enum(["change", "remove", "background"]),
  target: z.string().max(120).optional(),
  becomes: z.string().max(300).optional(),
  biggestOnly: z.boolean().optional(),
  keepShape: z.boolean().optional(),
  edge: z.enum(["tight", "normal", "loose"]).optional(),
  motionDetail: z.union([z.literal(512), z.literal(768)]).optional(),
});
const picture = z.object({
  stage: z.enum(["frame", "video"]),
  light: z.union([z.object({ look: z.enum(LOOK_IDS as [LookId, ...LookId[]]) }), z.object({ words: z.string().max(OPENJUTSU_LIMITS.lightChars) })]).optional(),
  ownPerson: z.boolean().optional(),
  keepCrop: z.boolean().optional(),
  adjust: z.string().max(300).optional(),
  frame: fileUrl.optional(),
  scene: z.string().max(OPENJUTSU_LIMITS.sceneChars).optional(),
  renderer: z.enum(["solar", "h3"]).optional(),
  motionDetail: z.union([z.literal(0), z.literal(512), z.literal(768)]).optional(),
});
const finish = z.object({
  tool: z.enum(["faces", "colours"]),
  faceStyle: z.enum(["photo", "mouth"]).optional(),
  chunkSeconds: z.union([z.literal(4), z.literal(6.5), z.literal(10)]).optional(),
  finish: z.enum(["soft", "filmic", "rich", "off"]).optional(),
  strength: z.number().min(0).max(1).optional(),
  soften: z.number().min(0).max(1).optional(),
});

/** The body of /api/genjutsu (and /estimate). */
export const GenjutsuBodySchema = z.object({
  engine: z.enum(["cloud", "open"]),
  mode: z.enum(["motion", "character", "swap", "restyle", "insert", "picture", "finish"]),
  modelId: z.string().max(80).optional(),
  tier: z.enum(["standard", "high"]).optional(),
  quality: z.enum(["480p", "720p", "768p", "1080p", "2K", "4K"]).optional(),
  target: z.enum(["type", "click", "paint"]).optional(),
  subject: z.string().max(300).optional(),
  prompt: z.string().max(GENJUTSU.maxPromptChars).optional(),
  points: z.array(point).max(GENJUTSU.maxPoints).optional(),
  frame: z.object({ width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000) }).optional(),
  mask: fileUrl.optional(),
  references: z.array(fileUrl).max(GENJUTSU.maxReferences).optional(),
  look: look.optional(),
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
  character: character.optional(),
  object: objectEdit.optional(),
  picture: picture.optional(),
  finish: finish.optional(),
  cuts: z.array(seconds).max(200).optional(),
  /** What of the clip's sound goes back where it is put back (src/lib/av/original-sound.ts). */
  originalSound: z.enum(ORIGINAL_SOUND_IDS).optional(),
  /** A client nonce for one submit: a repeat gets the first answer (see once()). */
  requestId: z.string().trim().min(8).max(64).optional(),
});

/** The estimate is asked for before uploads finish: any URL stands in. */
export const GenjutsuEstimateSchema = GenjutsuBodySchema.extend({
  source: GenjutsuBodySchema.shape.source.extend({ url: z.string().max(500).default("/api/files/placeholder.mp4") }),
  mask: z.string().max(500).optional(),
  references: z.array(z.string().max(500)).max(GENJUTSU.maxReferences).optional(),
});

const mustMatchMode = (engine: Engine) => {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
};

interface Planned {
  input: GenjutsuPlanInput;
  maker: Maker;
  notes: string[];
}

/**
 * What this viewer may use: everything for the owner; for a guest or an account, what has opened, and on its own setup
 * the features that run there until they open (never on this studio's GPU: an account's steps go to its own GPU).
 */
function openFor(viewer: GenjutsuViewer): FeatureCheck {
  if (viewer.owner) return ALL_FEATURES;
  const live = genjutsuLive();
  return (f) => live[f] || (!!viewer.ownSetup && !!ownSetupItem(`genjutsu:${f}`));
}

async function planInput(body: GenjutsuBody, opts: { probe: boolean; viewer?: GenjutsuViewer }): Promise<Planned> {
  mustMatchMode(body.engine);
  const open = openFor(opts.viewer ?? OWNER);
  if (!modeOpen(body.mode, open)) throw new ShortsError(NOT_HERE, 422);
  // A model named that hasn't opened yet: the owner's alone.
  const named = body.modelId ? getMaker(body.modelId, body.engine) : undefined;
  if (named?.features && !named.features.some(open)) throw new ShortsError(NOT_HERE, 422);
  const ask = {
    engine: body.engine,
    mode: body.mode,
    target: body.target,
    tier: body.tier,
    look: body.look,
    modelId: body.modelId,
    offered: (id: string) => isOffered(id, body.engine),
    refs: body.references?.length ?? 0,
    action: body.mode === "swap" ? body.object?.action : undefined,
    tool: body.mode === "finish" ? (body.finish?.tool ?? "colours") : undefined,
  };
  const picked = chooseMaker({ ...ask, open });
  if ("problem" in picked) {
    // Something only a feature that hasn't opened yet does (Remove it, say): the owner's alone.
    if (open !== ALL_FEATURES && "maker" in chooseMaker({ ...ask, open: ALL_FEATURES })) throw new ShortsError(NOT_HERE, 422);
    throw new ShortsError(picked.problem, 422);
  }
  const maker = picked.maker;
  // A setting that hasn't opened (one by one, a light, the clip's own person…): the owner's alone.
  if (requestFeatures({ mode: body.mode, maker, character: body.character, object: body.object, picture: body.picture, finish: body.finish }).some((f) => !open(f))) throw new ShortsError(NOT_HERE, 422);
  // The header's facts win over what the browser read (the estimate runs before the upload is read).
  const info = opts.probe ? await probeSource(body.source.url) : {};
  const source: RemoveSource = {
    url: body.source.url,
    duration: info.duration ?? body.source.duration,
    fps: info.fps ?? body.source.fps,
    width: info.width ?? body.source.width,
    height: info.height ?? body.source.height,
    // Sound we couldn't read counts as none (putting it back would fail after the work was paid for).
    hasAudio: opts.probe ? (info.hasAudio ?? false) : (body.source.hasAudio ?? false),
  };
  // Character swap's part defaults to the first 15 s (Openjutsu's Length); From picture's to the first 6 s; Finish takes
  // the whole video (up to its limit); the other modes up to 30 s.
  const longest = maker.review ? 6 : maker.part ? maker.part.max : body.mode === "character" ? CHARACTER_SWAP.maxSeconds : GENJUTSU.maxSeconds;
  const range = body.range ?? (source.duration ? { start: 0, end: Math.min(source.duration, longest) } : null);
  if (!range) throw new ShortsError("Reading the clip… try again in a moment");
  const target = MODE_TARGETS[body.mode].length ? (body.target ?? MODE_TARGETS[body.mode][0]) : undefined;
  const references = body.references ?? [];
  const clicks = (body.points ?? []).filter((p) => p.label !== "negative").length;
  const problem = genjutsuProblem({ mode: body.mode, maker, source, range, references: references.length, target, subject: body.subject, prompt: body.prompt, points: clicks, mask: !!body.mask, look: body.look, seed: body.seed, character: body.character, object: body.object, picture: body.picture, finish: body.finish });
  if (problem) throw new ShortsError(problem, 422);
  // From picture's video starts from a first frame this install made (the review step can't be skipped).
  if (maker.review && body.picture?.stage === "video" && opts.probe && !madeFrame(body.picture.frame)) throw new ShortsError("Make and pick the first frame first", 422);
  // Scene edit's painted area, as the pack's keyframe (one, on the part's first frame).
  let paint: PaintKeyframe[] | undefined;
  if (maker.actions && (body.object?.action ?? "change") === "change" && target === "paint" && body.mask && opts.probe) paint = [await paintFrom(body.mask)];
  const switched = body.mode === "character" && maker.h3 ? characterSwitches(maker, body.character ?? {}) : { character: body.character, notes: [] };

  // Clicks on the first frame, in the clip's pixels; paint is followed from its deepest points (SAM 3.1 on fal).
  let points: PixelPoint[] | undefined;
  const size = source.width && source.height ? { width: source.width, height: source.height } : null;
  if (target === "click") points = body.frame && size ? scalePoints(body.points!.slice(0, GENJUTSU.maxPoints), body.frame, size) : body.points;
  const pieces = planMakerPieces(maker, source, range);
  // Restyle on Fuobe's looks runs in the Shorts chain's segments (the open Original and partners).
  const shortsChain = body.mode === "restyle" && maker.looks === "fuobe" && !(maker.engine === "cloud" && maker.source === "original");
  const n = (shortsChain ? planSegments(range, maker.engine).length : pieces.length) || 1;
  const tracksPaint = maker.engine === "cloud" && body.mode === "swap" && target === "paint" && (maker.source === "original" || n > 1);
  if (tracksPaint) points = opts.probe ? await pointsFromPaint(body.mask!, source, "Paint over what to swap first") : [{ x: 1, y: 1, label: "positive" }];

  const notes = [...switched.notes, ...notesFor({ ...body, character: switched.character }, maker, source, range, n, references.length)];
  const name = (body.source.name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, 40);
  const title = genjutsuTitle({ mode: body.mode, subject: body.subject, look: body.look });
  return {
    maker,
    notes,
    input: {
      engine: body.engine,
      mode: body.mode,
      maker,
      title: name ? `${title} · ${name}` : title,
      source,
      range,
      quality: body.quality ?? (body.mode === "character" ? CHARACTER_SWAP.defaultQuality : GENJUTSU.defaultQuality),
      references,
      target,
      subject: body.subject?.trim() || undefined,
      prompt: body.prompt?.trim() || undefined,
      points,
      mask: target === "paint" ? body.mask : undefined,
      look: body.look,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.mode === "character" ? { character: switched.character ?? {} } : {}),
      ...(body.object ? { object: body.object } : {}),
      ...(body.picture ? { picture: body.picture } : {}),
      ...(body.finish ? { finish: body.finish } : {}),
      ...(paint ? { paint } : {}),
      // What of the clip's sound goes back: the cloud puts it all back (DBS runs on your GPU).
      ...(body.originalSound && { originalSound: originalSoundOn(body.originalSound, maker.engine) }),
    },
  };
}

/**
 * Whether a first frame is one this install's From picture made (and finished) for the asker: the owner's own frames, or
 * inside an account's work (tenant.ts) that account's own. Never another's.
 */
function madeFrame(url: string | undefined): boolean {
  if (!url) return false;
  // Looked up by its address, however old (not in the Trash).
  const row = db()
    .prepare(
      `SELECT 1 FROM generations g
        WHERE g.model_id = 'oss-from-picture-frame' AND g.status = 'succeeded'
          AND json_extract(g.request_json, '$.account') IS ?
          AND NOT EXISTS (SELECT 1 FROM generation_trash t WHERE t.generation_id = g.id)
          AND EXISTS (SELECT 1 FROM json_each(g.outputs_json) o WHERE json_extract(o.value, '$.url') = ?)
        LIMIT 1`,
    )
    .get(tenantAccount() ?? null, url);
  return !!row;
}

/** The painted mask as Scene edit's keyframe (run-length, at most 256 px a side). */
async function paintFrom(mask: string): Promise<PaintKeyframe> {
  let png: ReturnType<typeof decodePng>;
  try {
    png = decodePng((await readRef(mask)).data);
  } catch {
    throw new ShortsError("Couldn't read the painted area — paint it again", 400);
  }
  const k = paintKeyframe({ width: png.width, height: png.height, data: png.data, channels: 4 });
  if (!k.runs.length) throw new ShortsError("Paint over what changes", 422);
  return k;
}

/**
 * The Character swap with what Settings → Models & licences switched off taken out: the first-frame model (the next one
 * that is on, else no first frame) and the swap LoRA (on your GPU H3 runs without it; fal's route needs one). Turbo off
 * on the open engine stops the run: the 8-step graph can't go without it.
 */
function characterSwitches(m: Maker, c: CharacterOptions): { character: CharacterOptions; notes: string[] } {
  const notes: string[] = [];
  let out = c;
  if (m.h3?.anchor && c.anchor !== false) {
    const wanted = anchorModel(m.engine, c.anchorModel);
    if (!isOffered(wanted.id, m.engine)) {
      const next = ANCHOR_MODELS[m.engine].find((a) => isOffered(a.id, m.engine));
      out = next ? { ...out, anchorModel: next.id } : { ...out, anchor: false };
      notes.push(next ? `${wanted.label} is switched off in ${ACCESS_PLACE}: ${next.label} makes the first frame` : `The first-frame models are switched off in ${ACCESS_PLACE}: the swap runs without a first frame`);
    }
  }
  const lora = c.lora ?? "v1.5";
  if (lora !== "none" && offeredLoras([swapLoraRef(lora)]).dropped.length) {
    if (m.engine === "cloud") throw new ShortsError(`The swap LoRA (${SWAP_LORAS[lora].label}) is switched off in ${ACCESS_PLACE}, and fal's H3 route needs one — turn it on, or pick the other release`, 422);
    out = { ...out, lora: "none" };
    notes.push(`The swap LoRA is switched off in ${ACCESS_PLACE}: H3 runs with the Turbo LoRA alone`);
  }
  if (m.engine === "open" && offeredLoras([TURBO_LORA]).dropped.length) throw new ShortsError(`The H3 Turbo LoRA is switched off in ${ACCESS_PLACE}, and the Character swap's 8-step graph needs it — turn it on to run it on your GPU`, 422);
  return { character: out, notes };
}

function notesFor(body: GenjutsuBody, m: Maker, source: RemoveSource, range: RemoveRange, n: number, refs: number): string[] {
  const notes: string[] = [];
  const name = getModel(m.id)?.name ?? m.label;
  const fps = source.fps ?? 30;
  const fuobeLook = body.mode === "restyle" && m.looks === "fuobe";
  const len = range.end - range.start;
  if (m.group || m.actions || m.review || m.tool || m.id === MOTION_H3) {
    notes.push(...openjutsuNotes(body, m, range));
    return notes;
  }
  if (body.mode === "character" && m.h3) {
    const c = body.character ?? {};
    if (m.engine === "open") {
      const plan = windowPlan(c.windowFrames, c.historyFrames);
      const windows = h3Windows(len, plan.window, plan.history);
      notes.push(
        windows > 1
          ? `MiniMax H3 swaps it in ${windows} windows of up to ${plan.window} frames at 24 fps, each continuing from the ${plan.history} frames before it; the clip's sound stays`
          : `MiniMax H3 swaps it in one window of up to ${plan.window} frames at 24 fps; the clip's sound stays`,
      );
      // One prompt for the whole part: past H3's trained range (~362 frames) the pack itself says quality is unverified.
      if (len > CHARACTER_SWAP.maxSeconds + 0.05) notes.push("Past 15 s is beyond what H3 was trained on, so quality there can drop");
    } else if (n > 1) notes.push(`fal's H3 takes up to 15 s a call: the part runs as ${n} pieces, joined with the clip's own sound. Each piece starts fresh (no history between them), so a seam can show where they meet`);
    if (m.engine === "cloud" && !source.hasAudio) notes.push("Your clip has no sound, and neither will the result: fal's H3 makes a soundtrack of its own, which is replaced with silence");
    if (m.h3.anchor && c.anchor !== false) {
      const am = anchorModel(m.engine, c.anchorModel);
      notes.push(`${am.label} first puts your character into the part's first frame${m.engine === "cloud" && n > 1 ? " (one per piece)" : ""}; if that fails the swap runs without it`);
    } else if (!m.h3.anchor) notes.push(`${name} runs without an anchor frame`);
    if (m.engine === "cloud") notes.push("On fal, H3 has no mask: who to swap is said in words, and the whole frame is regenerated around them");
    // 1080p / 2K / 4K (sharpen.ts): what each engine does with the 768p swap.
    const finish = characterFinish(qualityFor(m, body.quality ?? CHARACTER_SWAP.defaultQuality));
    if (finish && m.engine === "cloud") {
      notes.push(`${finish} is made from the 768p swap: the whole frame is redrawn at the higher size`);
      // Pieces are joined by fal's merge-videos, at up to 2048 px a side: only a single piece keeps its 4K.
      if (finish === "4K" && n > 1) notes.push(SHARPEN_COPY.joinCloud4k);
    }
    if (finish && m.engine === "open") {
      notes.push("The 768p swap is redrawn by Open-H3 Regenerate and only your character is put back over your clip: the background and the sound stay as filmed. Faces can change slightly");
      const canvas = source.width && source.height ? h3Canvas(source.width, source.height, CHARACTER_SWAP.defaultQuality) : undefined;
      const capped = openCapNote(source, finish, canvas);
      if (capped) notes.push(capped);
    }
    if (m.engine === "open" && c.who === "index" && !body.points?.length) notes.push("Person numbers follow SAM 3.1's detections, the one it is surest of first — not left to right");
    if (m.engine === "open" && !m.h3.maskSwitch && c.useMask === false) notes.push(`${name} always regenerates only the person: its graph has no switch for the whole frame`);
    const warn = cutWarning(cutsInPart(body.cuts, range));
    if (warn) notes.push(warn);
  } else if (body.mode === "character") {
    notes.push(`${SOURCE_LABELS[m.source]}: ${m.note}`);
    const warn = m.id === "h3-max-recast" ? null : cutWarning(cutsInPart(body.cuts, range));
    if (warn) notes.push(warn);
  }
  if (n > 1 && body.mode !== "character") {
    if (m.engine === "open" && m.window) {
      notes.push(`${name} works on ${m.window.cap} frames at a time (${(m.window.cap / fps).toFixed(1)} s of this clip): it runs as ${n} windows, joined with the clip's own sound`);
    } else if (fuobeLook) {
      notes.push(`${name} restyles ${m.engine === "open" ? "5 s" : m.window ? `${m.window.cap} frames (${(m.window.cap / fps).toFixed(1)} s of this clip)` : "up to 10 s"} at a time: the clip runs as ${n} segments, joined with its own sound`);
    } else {
      const limit = m.window ? `${m.window.cap} frames (${(m.window.cap / fps).toFixed(1)} s of this clip)` : `${m.maxSeconds} s`;
      notes.push(`${name} takes up to ${limit} a call: the clip runs as ${n} pieces, joined with its own sound`);
    }
  }
  if (body.mode !== "restyle" && refs > m.refs.max) notes.push(m.refs.max === 1 ? `${name} uses your first reference image` : `${name} takes ${m.refs.max} references — your first ${m.refs.max} go`);
  if (fuobeLook && refs) notes.push("Restyle changes the whole shot: character references aren't used — try Motion transfer or Character swap for a character");
  if (fuobeLook && body.look?.kind === "custom" && m.readsLookImages && body.look.images.length > m.readsLookImages) notes.push(`${name} reads ${m.readsLookImages} of your look's images`);
  if (fuobeLook && body.look?.kind === "soul" && m.source === "original") notes.push("The Soul look's LoRAs restyle the first frame (Fuobe Soul's edit); every frame then follows it");
  const quality = body.quality ?? (body.mode === "character" ? CHARACTER_SWAP.defaultQuality : GENJUTSU.defaultQuality);
  const res = resolutionWords(m, quality);
  if (res) notes.push(`${name} ${res}${m.qualities ? "" : " (it has no resolution setting)"}`);
  if (m.id === "wan-22-vace-inpaint") {
    notes.push(body.mode === "insert" ? "The spot stays where you painted it for the whole shot — best with a still or slow camera" : "Only the area you marked changes; SAM 3.1 follows it through the selection when it runs as pieces or you clicked");
  }
  if (m.source === "original" && body.mode === "swap" && m.engine === "cloud") notes.push("SAM 3.1 follows what you named, clicked or painted through the selection; Wan VACE paints your reference into its mask");
  if (m.billFps && m.engine === "cloud" && source.fps && source.fps > m.billFps + 0.5) notes.push(`fal bills this clip's ${Math.round(source.fps)} fps as ${(source.fps / m.billFps).toFixed(1)}× its length (video seconds at ${m.billFps} fps)`);
  if (m.id === "oss-vace-insert") notes.push("The spot stays where you painted it for the whole shot — best with a still or slow camera");
  if (m.people && body.mode === "swap") notes.push(`${name} swaps the person on camera — for objects, pick Fuobe Genjutsu or Kling O3`);
  if (m.engine === "open" && body.mode !== "character") {
    if (m.modes.includes("motion")) notes.push("Wan Animate 2 needs a 24 GB GPU");
    else if (m.window) notes.push("Wan 2.1 VACE 14B needs a 24 GB GPU");
  }
  if (!wholeClip(range, source.duration)) notes.push("Only the selected part comes out (the rest of the clip isn't kept)");
  return notes;
}

/** The Openjutsu makers' notes: the time on your GPU, the sound, and what to expect. */
function openjutsuNotes(body: GenjutsuBody, m: Maker, range: RemoveRange): string[] {
  const len = range.end - range.start;
  const notes: string[] = [];
  // Measured on a 32 GB GPU at 720p (1080p about 2.3 times as long, 480p about half).
  const size = m.qualities ? (body.quality === "1080p" ? 2.3 : body.quality === "480p" ? 0.6 : 1) : 1;
  const minutes = (perSecond: number) => Math.max(1, Math.round((len * perSecond * size) / 60));
  if (m.group) {
    const n = body.references?.length ?? 1;
    const twice = body.character?.onePerPerson && n === 2;
    notes.push(`About ${minutes(twice ? 150 : 75)} min on your GPU · keeps the clip's sound`);
    if (n > 1) notes.push("Say who each character replaces, or leave it blank and the people with the most screen time are picked in order");
    const warn = cutWarning(cutsInPart(body.cuts, range));
    if (warn) notes.push(warn);
  } else if (m.actions) {
    notes.push(`About ${minutes(60)} min on your GPU · keeps the clip's sound`);
    if (body.object?.action === "background") notes.push("The people stay exactly as filmed");
  } else if (m.id === MOTION_H3) {
    notes.push(`About ${minutes(60)} min on your GPU · keeps the clip's sound`);
    notes.push("Your character performs the clip's moves in their photo's own setting");
  } else if (m.review) {
    notes.push(body.picture?.stage === "video" ? `About ${minutes(60)} min on your GPU · keeps the clip's sound` : "The first frame takes about a minute: check it before the video is made");
  } else if (m.tool === "faces") {
    const chunks = faceChunkCount(len, body.finish?.chunkSeconds ?? 6.5);
    notes.push(`${chunks} section${chunks > 1 ? "s" : ""} · about ${minutes(45)} min on your GPU · keeps the sound`);
    notes.push("Faces that already fill the frame are left as they are");
  } else if (m.tool === "colours") notes.push(`About ${minutes(16)} min on your GPU · keeps the sound`);
  return notes;
}

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** The helper steps in words, for a run that can't have them (they run on fal; the open ones on ComfyUI). */
const HELPER_WORDS: Record<string, string> = {
  [REMOVE_TOOLS.cloud.cut]: "cutting the clip",
  [REMOVE_TOOLS.cloud.join]: "joining the pieces",
  [REMOVE_TOOLS.cloud.mux]: "putting the sound back",
  [MASK_TRACKER]: "following what you marked",
  "extract-frame": "taking the first frame",
  "scale-video": "fitting the clip",
  "gpt-image-2-5-sunburst": "the first frame with your character",
  "nano-banana-pro": "the first frame with your character",
};

/** The providers a step's model runs its operation on, on the step's engine (any one of them will do). */
const providersOf = (s: PlanStep): ProviderId[] => {
  const m = getModel(s.request.modelId);
  const routes = m ? (s.request.engine ? onEngine(m, s.request.engine) : m).routes : [];
  return [...new Set(routes.filter((r) => !s.request.op || r.op === s.request.op).map((r) => r.provider))];
};

const listWords = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

interface StepMode {
  step: PlanStep;
  /** It would run as a demo (no provider for it), or can't run at all (demo mode off). */
  demo: boolean;
}

/**
 * A run is all real or all a demo (chainMode in src/server/generations.ts): a real step after a demo one runs as a demo
 * too, a demo step after a real one fails, both after the paid steps were made. So when only some of the steps have a
 * provider — Replicate's P-Video without fal for the cuts and joins, say — name the missing key (and the way around
 * it) before anything is paid for.
 */
function mixProblem(modes: StepMode[], cannot: boolean, input: GenjutsuPlanInput): string | null {
  const missing = modes.filter((x) => x.demo);
  if (!missing.length || (!cannot && missing.length === modes.length)) return null;
  const m = input.maker;
  const makerName = getModel(m.id)?.name ?? m.label;
  const own = missing.filter((x) => x.step.request.modelId === m.id);
  const helpers = missing.filter((x) => x.step.request.modelId !== m.id);
  const ids = (xs: StepMode[]) => [...new Set(xs.flatMap((x) => providersOf(x.step)))];
  const label = (xs: ProviderId[]) => xs.map((id) => provider(id).label).join(" or ");
  const [ownIds, helperIds] = [ids(own), ids(helpers)];
  const parts: string[] = [];
  if (own.length) parts.push(`${makerName} runs on ${label(ownIds)}`);
  if (helpers.length) {
    const jobs = [...new Set(helpers.map((x) => HELPER_WORDS[x.step.request.modelId] ?? getModel(x.step.request.modelId)?.name ?? x.step.request.modelId))];
    parts.push(`${own.length ? listWords(jobs) : cap(listWords(jobs))} ${jobs.length > 1 ? "run" : "runs"} on ${label(helperIds)}`);
  }
  // The fewest keys that cover it: one provider both need, else one for each.
  const both = ownIds.filter((id) => helperIds.includes(id));
  const key = !own.length ? `a ${label(helperIds)} key` : !helpers.length ? `a ${label(ownIds)} key` : both.length ? `a ${label(both.slice(0, 1))} key` : `a ${label(helperIds)} key and a ${label(ownIds)} key`;
  const around = own.length ? otherModel(input) : undefined;
  return `${parts.join(", and ")} — add ${key} in Settings → Paid API configuration${around ? `, or ${around}` : ""}`;
}

/** Another model for the same job that runs with the keys set now (the way around a missing key). */
function otherModel(input: GenjutsuPlanInput): string | undefined {
  const runs = (id: string) => {
    const m = getModel(id);
    return !!m && isOffered(id, input.engine) && onEngine(m, input.engine).routes.some((r) => provider(r.provider).isConfigured());
  };
  const other = makersFor(input.engine, input.mode, input.target).find((x) => x.id !== input.maker.id && x.pair !== input.maker.id && runs(x.id));
  return other ? `pick ${other.label}` : undefined;
}

/** Whether a step's model has no route it could run on now (demo mode off: it would refuse). */
const unrunnable = (s: PlanStep) => !providersOf(s).some((id) => provider(id).isConfigured());

/** What the steps cost together (null when a price is unknown) and whether they would run as a demo. */
function price(steps: PlanStep[], input: GenjutsuPlanInput): { costUsd: number | null; demo: boolean; providers: ProviderId[]; tokenBilled: string[] } {
  let cost: number | null = 0;
  const modes: StepMode[] = [];
  const providers = new Set<ProviderId>();
  // Steps fal bills by tokens (the Sunburst first frame): left out of the total, and named.
  const tokenBilled = new Set<string>();
  let cannot = false;
  for (const s of steps) {
    let p: ReturnType<typeof previewChained>;
    try {
      p = previewChained(withChain(s), s.after?.length ?? 0);
    } catch (e) {
      // Demo mode off and no key for it: said with the other missing keys below.
      if (unrunnable(s)) {
        cannot = true;
        modes.push({ step: s, demo: true });
        continue;
      }
      if (e instanceof ConnectComfyError) throw e;
      throw new ShortsError((e as Error).message, 422);
    }
    modes.push({ step: s, demo: p.demo });
    providers.add(p.providerId);
    // Kling O3's edit price isn't the catalog's: the planner's table.
    const own = p.demo ? null : makerStepUsd(s.request.modelId, s.request.params);
    const usd = own ?? p.costUsd;
    const tokens = usd === null ? ANCHOR_MODELS.cloud.find((m) => m.id === s.request.modelId && m.tokens) : undefined;
    if (tokens) {
      tokenBilled.add(`${tokens.label}'s first frame is billed by tokens (${tokens.tokens}) and isn't in the price`);
      continue;
    }
    cost = cost === null || usd === null ? null : cost + usd;
  }
  const problem = mixProblem(modes, cannot, input);
  if (problem) throw new ShortsError(problem, 422);
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo: modes.some((x) => x.demo), providers: [...providers], tokenBilled: [...tokenBilled] };
}

export interface GenjutsuEstimate {
  costUsd: number | null;
  demo: boolean;
  /** Where the steps run ("mock" for demo steps). */
  providers: ProviderId[];
  /** The model that runs (the default, or the one picked), its tier and where it comes from. */
  modelId: string;
  modelName: string;
  source: MakerSource;
  tier?: GenjutsuTier;
  /** The resolution it is asked for (none: it keeps the clip's size). */
  quality?: string;
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
  /** Character swap: anchor frames made, the limits, and the GPU the open route was tested on. */
  anchors?: number;
  limits?: string[];
  gpu?: { weightsGb: number; tested: string; advice: string; speed: string };
}

export async function estimateGenjutsu(body: GenjutsuBody, viewer: GenjutsuViewer = OWNER): Promise<GenjutsuEstimate> {
  const { input, maker, notes } = await planInput(body, { probe: false, viewer });
  let plan: ReturnType<typeof planGenjutsu>;
  try {
    plan = planGenjutsu(input);
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
  const character = body.mode === "character";
  const { tokenBilled, ...cost } = price(plan.steps, input);
  return {
    ...cost,
    modelId: maker.id,
    modelName: getModel(maker.id)?.name ?? maker.label,
    source: maker.source,
    ...(maker.tier ? { tier: maker.tier } : {}),
    ...(qualityFor(maker, input.quality) ? { quality: qualityFor(maker, input.quality) } : {}),
    pieces: plan.pieces,
    seconds: Math.round((input.range.end - input.range.start) * 100) / 100,
    steps: plan.steps.length,
    notes: cost.demo ? notes : [...notes, ...tokenBilled],
    ...(plan.anchors !== undefined ? { anchors: plan.anchors } : {}),
    ...(character ? { limits: [...CHARACTER_LIMITS] } : {}),
    ...(character && maker.h3 && maker.engine === "open" ? { gpu: { ...CHARACTER_GPU } } : {}),
  };
}

/** A Genjutsu run planned and checked, not started yet: its steps, and the one that makes the finished video. */
export interface GenjutsuRun {
  steps: PlanStep[];
  final: string;
}

/**
 * Plan a run as it will start (the clip's header read, every step checked and priced): nothing is made yet. An account's
 * run is planned inside its own work (src/server/account-tool-run.ts), so its steps are checked before any starts.
 */
export async function planGenjutsuRun(body: GenjutsuBody, viewer: GenjutsuViewer = OWNER): Promise<GenjutsuRun> {
  const { input } = await planInput(body, { probe: true, viewer });
  try {
    const plan = planGenjutsu(input);
    // The same check as the estimate: nothing starts when only some of the steps have a provider.
    price(plan.steps, input);
    return { steps: plan.steps, final: plan.final };
  } catch (e) {
    if (e instanceof ShortsError) throw e;
    if (e instanceof ConnectComfyError) throw e;
    if (e instanceof AccountRunError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

/** A planned run's steps as the requests they make, with how many earlier steps each waits for. */
export const genjutsuSteps = (run: GenjutsuRun): { request: GenerationRequest; deps: number }[] => run.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** Start a planned run; returns the finished video's generation (the other steps wait for each other). */
export function startGenjutsu(run: GenjutsuRun): { final: Generation; items: Generation[] } {
  try {
    // A silent clip's cloud swap ends on silence: its WAV is written now (silenceRef, as Canvas mutes a clip).
    const withSilence = silenceWriter();
    const p = createPipeline(run.steps.map((s) => ({ ...s, request: withSilence(s.request) })));
    return { final: p.byKey[run.final], items: p.items };
  } catch (e) {
    if (e instanceof ShortsError) throw e;
    if (e instanceof ConnectComfyError) throw e;
    if (e instanceof AccountRunError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

/** Plan and start it (the owner's runs; an account's go through src/server/account-tool-run.ts). */
export async function createGenjutsu(body: GenjutsuBody, viewer: GenjutsuViewer = OWNER): Promise<{ final: Generation; items: Generation[] }> {
  return startGenjutsu(await planGenjutsuRun(body, viewer));
}

// ---------------------------------------------------------------------------
// Character swap helpers: "Describe my character" and the part's words (Akatz Labs' description and transcript)

const DESCRIBE_SYSTEM =
  "You describe a character from one reference picture for a video model that will put them into a scene. Say only who they are and what they wear: " +
  "apparent age range, build, face, hair, skin tone, clothing, shoes, accessories and their colours. No pose, background, lighting, camera or art style, " +
  "no names, no guesses about personality. One plain sentence under 60 words, starting with \"a\" or \"an\", no quotes, no preamble.";

export const DescribeSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  image: z.string().startsWith("/api/files/").max(500),
  /** A client's id for this click: a repeat gets the describer the first one started (an account's). */
  requestId: z.string().min(8).max(100).optional(),
});

/**
 * "Describe my character" on the site's AI helper (the owner's, on the cloud engine): the text model looks at the
 * character picture and writes the description the prompt and the anchor brief carry (Akatz Labs found generic prompts
 * weak). Claude, else a local model. A text model switched off in Settings → Models & licences doesn't answer. On the
 * open engine, and for an account always, the GPU describer writes it instead (describeRequest).
 */
export async function describeCharacter(body: z.infer<typeof DescribeSchema>): Promise<{ description: string }> {
  mustMatchMode(body.engine);
  const textModel = getModel(body.engine === "open" ? "oss-text-llm" : "text-llm");
  if (!textModel || !offeredModel(textModel)) throw new ShortsError(`The text model is switched off in ${ACCESS_PLACE} — describe your character in your own words`, 422);
  // A local model is asked on your GPU's engine (and when no Anthropic key is set): its server has to be running.
  const backend = llmTextBackend();
  const local = backend === "ollama" || (backend === "claude" && body.engine === "open");
  if (getSetting("demoMode") === "on" || !backend || (local && !(await probeOllama()))) {
    throw new ShortsError("Describing needs a text model: add an Anthropic key, or run a vision model in Ollama, LM Studio or Unsloth Studio (Settings → AI helper)", 422);
  }
  let file: Awaited<ReturnType<typeof readRef>>;
  try {
    file = await readRef(body.image);
  } catch {
    throw new ShortsError("Couldn't read the character picture — add it again", 422);
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.contentType)) throw new ShortsError("Describe works on a PNG, JPEG or WebP picture", 422);
  const answer = await llmText(DESCRIBE_SYSTEM, "Describe the character in this picture.", [{ data: file.data, contentType: file.contentType }], { ollamaOnly: body.engine === "open" });
  const description = cleanDescription(answer);
  if (!description) throw new ShortsError(body.engine === "open" ? `${cap(localLabel())} didn't describe the picture — it needs a vision model (qwen3-vl, gemma3…)` : "The text model didn't answer — try again, or describe your character in your own words", 422);
  return { description };
}

/**
 * "Describe my character" on a GPU: Qwen3-VL 8B reads the picture in ComfyUI (workflow character-describe-qwen3vl, its
 * instruction fixed in the graph) and writes the description as a Genjutsu step; the page reads its text when it is
 * done (src/lib/character-description.ts tidies it). The owner's open engine runs it on the install's GPU; an account's
 * runs on its own, after its run's checks (src/server/account-tool-run.ts). Nothing the person types goes in.
 */
export function describeRequest(body: z.infer<typeof DescribeSchema>): GenerationRequest {
  mustMatchMode("open");
  if (!DESCRIBE_PICTURE.test(body.image.split(/[?#]/)[0])) throw new ShortsError("Describe works on a PNG, JPEG or WebP picture", 422);
  if (!isOffered(CHARACTER_DESCRIBER, "open")) throw new ShortsError(`Describing is switched off in ${ACCESS_PLACE} — describe your character in your own words`, 422);
  return {
    feature: GENJUTSU.stepFeature,
    batchTitle: "Genjutsu · your character",
    modelId: CHARACTER_DESCRIBER,
    op: "write",
    inputs: { images: [body.image] },
    step: { label: "Describe the character", index: 0, of: 1 },
  };
}

/** The owner's describer run on the open engine: refused, not faked, where it would only be a demo (no GPU). */
export function describeOnGpu(body: z.infer<typeof DescribeSchema>): { id: string; modelId: string } {
  const req = describeRequest(body);
  if (previewGeneration(req).demo) throw new ShortsError("Describing needs your GPU: connect it, or describe your character in your own words", 422);
  return startStep(req);
}

export const SceneSchema = z.object({
  engine: z.literal("open"),
  source: z.object({ url: fileUrl, duration: z.number().finite().positive().max(3600).optional() }),
  range: z.object({ start: seconds, end: seconds }),
  /** The approved first frame (left out for the clip's own person). */
  frame: fileUrl.optional(),
  ownPerson: z.boolean().optional(),
});

/**
 * From picture's "What happens": the describer reads the part at 2 frames a second and writes it for the approved first
 * frame (a step of its own; the page waits for its text and puts it in an editable box). Owner-only, like the runs.
 */
export function describeScene(body: z.infer<typeof SceneSchema>, viewer: GenjutsuViewer = OWNER): { id: string; modelId: string } {
  return startStep(sceneRequest(body, viewer));
}

/** The describer's request for "What happens", checked (an account's is checked again by its run's gate first). */
export function sceneRequest(body: z.infer<typeof SceneSchema>, viewer: GenjutsuViewer = OWNER): GenerationRequest {
  mustMatchMode("open");
  if (!openFor(viewer)("picture")) throw new ShortsError(NOT_HERE, 422);
  const len = body.range.end - body.range.start;
  if (!(len >= OPENJUTSU_LIMITS.minSeconds - 0.05 && len <= OPENJUTSU_LIMITS.maxSeconds + 0.05)) throw new ShortsError(`Pick a part between ${OPENJUTSU_LIMITS.minSeconds} and ${OPENJUTSU_LIMITS.maxSeconds} seconds`, 422);
  if (!body.ownPerson && !body.frame) throw new ShortsError("Make and pick the first frame first", 422);
  if (!body.ownPerson && !madeFrame(body.frame)) throw new ShortsError("Make and pick the first frame first", 422);
  const modelId = "oss-scene-describe";
  if (!isOffered(modelId, "open")) throw new ShortsError(`Describing is switched off in ${ACCESS_PLACE} — write what happens in your own words`, 422);
  return {
    feature: GENJUTSU.stepFeature,
    batchTitle: "Genjutsu · what happens",
    modelId,
    op: "describe-video",
    inputs: { video: body.source.url, ...(body.ownPerson ? {} : { images: [body.frame!] }) },
    params: { startTime: body.range.start, extra: { openjutsu: { seconds: len, ownPerson: !!body.ownPerson } } },
    step: { label: "What happens in the part", index: 0, of: 1 },
  };
}

/** Start a helper step (the clip's words, what happens): one generation the page waits for. */
export function startStep(req: GenerationRequest): { id: string; modelId: string } {
  try {
    const [g] = createGenerations(req);
    return { id: g.id, modelId: req.modelId };
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    if (e instanceof AccountRunError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

/** The transcriber per engine (Fuobe's Transcribe studio's defaults). */
export const TRANSCRIBERS: Record<Engine, string> = { cloud: "scribe-v2", open: "oss-qwen3-asr" };

export const TranscribeSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  source: z.object({ url: z.string().startsWith("/api/files/").max(500), duration: z.number().finite().positive().max(3600).optional() }),
  /** The speech apart from the music and effects before it's read (src/lib/av/voice-first.ts). */
  cleanVoiceFirst: z.boolean().optional(),
});

/**
 * The clip's words, for "What's said": one transcription of the whole clip (word-timed cues), so any part picked
 * afterwards takes its own lines from it in the browser (partWords). A Genjutsu step: it stays out of the page's feed.
 */
export function transcribeClip(body: z.infer<typeof TranscribeSchema>): { id: string; modelId: string } {
  return startStep(transcribeRequest(body));
}

/** The transcriber's request for the clip's words, checked (an account's is checked again by its run's gate first). */
export function transcribeRequest(body: z.infer<typeof TranscribeSchema>): GenerationRequest {
  mustMatchMode(body.engine);
  const modelId = TRANSCRIBERS[body.engine];
  if (!isOffered(modelId, body.engine)) throw new ShortsError(`${getModel(modelId)?.name ?? modelId} is switched off in ${ACCESS_PLACE} — type the words instead`, 422);
  const seconds = body.source.duration;
  return {
    feature: GENJUTSU.stepFeature,
    batchTitle: "Genjutsu · the clip's words",
    modelId,
    op: "transcribe",
    inputs: { video: body.source.url },
    ...((seconds || body.cleanVoiceFirst) && { params: { ...(seconds && { duration: seconds, sourceDuration: seconds }), ...(body.cleanVoiceFirst && { extra: { cleanVoiceFirst: true } }) } }),
    step: { label: "The clip's words", index: 0, of: 1 },
  };
}
