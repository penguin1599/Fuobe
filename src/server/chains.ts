import "server-only";
import { nanoid } from "nanoid";
import { getModel, supportsOp } from "@/lib/catalog";
import { MODEL3D_STEP_FEATURE, stillPromptFor3d } from "@/lib/av/model3d";
import { HI3D_CHAIN_PARAM, HI3D_MODEL, HI3D_OP, HI3D_PARAM, chainedRefine } from "@/lib/av/hi3d";
import { chainTiming, chainedWaitMessage, frameTimes, framesWait, planKeyframeClips, spread, type KeyframeClip } from "@/lib/catalog/keyframes";
import { gapPrompt, MAKE_FPS, requestTiming } from "@/lib/inbetween";
import { faceMosaicStep } from "@/lib/catalog/open-tools";
import { planVoiceFirst } from "@/lib/av/voice-first";
import { dualEngine, onEngine } from "@/lib/catalog/engines";
import { routesFor } from "@/lib/catalog/plan";
import type { ChainSlot, Engine, GenParams, Generation, GenerationRequest, LoraRef, ModelDef, ModelRoute, Operation, PresetEndStep } from "@/lib/catalog/types";
import { db } from "./db";
import { cancelGeneration, chooseRoute, createGenerations, getGeneration, previewChained, previewGeneration } from "./generations";
import { provider } from "./providers";
import { llmLabel } from "./providers/llm";
import { loadManifest } from "./providers/comfyui";
import { offeredRoutes, requireOffered } from "./model-access";

/**
 * Multi-step jobs built from chained generations: each step waits for the ones it needs and
 * gets their outputs as inputs (see CreateOptions.dependsOn and GenerationRequest.chain).
 */

const tidy = (p: string | undefined) => (p ?? "").trim().replace(/[.\s]+$/, "");

// ---------------------------------------------------------------------------
// One mode per chain: all real, or all demo

interface ModeStep {
  label: string;
  modelId: string;
  op: Operation;
  /** The engine a Fuobe Original's step runs on (its routes there are the ones checked). */
  engine?: Engine;
}

/** Who can run a model's operation, as Settings names them ("fal.ai", "Claude or LM Studio"). */
export const providerNames = (m: ModelDef, op: Operation) => [...new Set(routesFor(m, op).map((r) => (r.provider === "llm" ? llmLabel(r) : provider(r.provider).label)))].join(" or ");

/**
 * A chain must not mix paid and demo steps: a demo join of paid clips (or a paid step fed a demo
 * placeholder) wastes the money and returns the wrong result. Nor can it reach a step that is switched off in
 * Settings → Models & licences (the refusal names the switch). Throws before any row is created.
 */
export function assertOneMode(steps: ModeStep[]): void {
  const modes = steps.map((s) => {
    const found = getModel(s.modelId);
    if (!found) throw new Error(`Unknown model ${s.modelId}`);
    const m = requireOffered(found, s.engine);
    const routes = offeredRoutes(found, routesFor(s.engine ? onEngine(found, s.engine) : found, s.op));
    return { ...s, model: m, demo: chooseRoute(routes).demo };
  });
  const demo = modes.find((s) => s.demo);
  if (demo && modes.some((s) => !s.demo)) {
    throw new Error(`${demo.label} needs ${providerNames(demo.model, demo.op)} — connect it in Settings (the other steps would run for real), or turn on demo mode to try it all as a demo`);
  }
}

/**
 * Keep the request as it was asked on the row an expansion returns first (GenerationRequest.asked): a skill made from
 * the result (src/server/recipe-builder.ts) rebuilds that one request, not the rows it expanded into, whose number
 * changes with the input (a film of 3 shots is 4 rows, of 5 shots 6).
 */
function withAsked(made: Generation[], asked: GenerationRequest, engine: Engine): Generation[] {
  const [first, ...rest] = made;
  if (!first) return made;
  // A Fuobe Original keeps the engine it ran on, as a plain row's request does (createGenerations).
  const request = { ...asked, ...(dualEngine(getModel(asked.modelId)) && { engine }) };
  for (const k of ["asked", "chainFilled", "chainSkipped", "notice"] as const) delete request[k];
  const stored: GenerationRequest = { ...first.request, asked: request };
  db().prepare("UPDATE generations SET request_json = ? WHERE id = ?").run(JSON.stringify(stored), first.id);
  return [{ ...first, request: stored }, ...rest];
}

/** Steps still waiting for their inputs (nothing spent yet) are canceled when the chain they feed can't be made. */
function cancelWaiting(ids: string[]): void {
  for (const id of ids) {
    db()
      .prepare("UPDATE generations SET status = 'canceled', message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND external_id IS NULL AND depends_on IS NOT NULL")
      .run(Date.now(), Date.now(), id);
  }
}

export interface JoinOptions {
  engine: Engine;
  feature: string;
  batchId: string;
  title: string;
  aspectRatio?: string;
  resolution?: string;
  /** Clips that already exist, placed before the chained ones (extend: the original video). */
  before?: string[];
  step?: GenerationRequest["step"];
  /** A recipe's free dry run (GenerationRequest.demo): the join runs on the demo provider too. */
  demo?: boolean;
  /**
   * The clips share one canvas and frame rate (COPY_JOIN_VIDEOS from stills of one shape): on your GPU they are joined
   * packet by packet (oss-join-encoded, up to 24 at once), each with its own sound, in flat memory.
   */
  copy?: boolean;
}

/** The join a film of clips ends on: ComfyUI on your GPU (copied as they are when `copy`), fal in the cloud. */
export const joinModelId = (engine: Engine, copy = false) => (engine === "open" ? (copy ? "oss-join-encoded" : "oss-join-clips") : "join-clips");

/** Join generations' clips, in order. ComfyUI joins 4 at a time, so longer films are joined in steps. */
export function joinClips(ids: string[], o: JoinOptions): Generation {
  const modelId = joinModelId(o.engine, o.copy);
  const max = o.engine === "open" && !o.copy ? 4 : 24;
  // The clips run for real: the join must too (S9). Clips still waiting are canceled rather than paid for.
  const real = ids.some((id) => {
    const g = getGeneration(id);
    return g && g.provider !== "mock";
  });
  if (real) {
    const m = getModel(modelId)!;
    let demo: boolean;
    try {
      demo = chooseRoute(routesFor(m, "concat")).demo;
    } catch (e) {
      cancelWaiting(ids);
      throw e;
    }
    if (demo) {
      cancelWaiting(ids);
      throw new Error(`Joining clips needs ${providerNames(m, "concat")} — connect it in Settings (the clips would render for real, but they couldn't be joined)`);
    }
  }
  const join = (group: string[], last: boolean): Generation =>
    createGenerations(
      {
        feature: o.feature,
        modelId,
        op: "concat",
        ...(o.demo && { demo: true }),
        prompt: o.title,
        inputs: last && o.before?.length ? { videos: o.before } : undefined,
        // ComfyUI's join plays at the first clip's frame rate (linked in the workflow).
        params: { aspectRatio: o.aspectRatio, resolution: o.resolution },
        chain: group.map(() => ({ slot: "videos" as const })),
        step: last ? o.step : { label: "Joining clips", index: 0, of: 1 },
      },
      { batchId: o.batchId, dependsOn: group },
    )[0];
  // Fold the first `max` clips into one until the rest fit in a final join (8 clips → 3 joins).
  let level = ids;
  const room = max - (o.before?.length ?? 0);
  try {
    while (level.length > room) level = [join(level.slice(0, max), false).id, ...level.slice(max)];
    return join(level, true);
  } catch (e) {
    // A join that can't be made (switched off in Settings → Models & licences, say): clips still waiting aren't paid for.
    cancelWaiting(ids);
    throw e;
  }
}

/**
 * Multi-shot on an open model: one clip per shot (the first gets the start image, the last the end
 * frame), then a join. Returns the film first, then the shots.
 */
export function createShotFilm(original: GenerationRequest, model: ModelDef): Generation[] {
  const shots = (original.params?.shots ?? []).filter((s) => s.prompt.trim());
  const max = model.options.multiShot?.maxShots ?? 4;
  if (shots.length > max) throw new Error(`${model.name} takes up to ${max} shots`);
  const longest = Math.max(...(model.options.durations ?? [Infinity]));
  const tooLong = shots.find((s) => s.duration > longest);
  if (tooLong) throw new Error(`${model.name} makes clips up to ${longest}s — shorten “${tooLong.prompt.slice(0, 40)}”`);
  const canT2v = supportsOp(model, "t2v");
  const firstOp: Operation = original.inputs?.images?.length || !canT2v ? "i2v" : "t2v";
  assertOneMode([
    { label: `${model.name} shots`, modelId: model.id, op: firstOp, engine: model.engine },
    { label: "Joining the shots", modelId: joinModelId(model.engine), op: "concat" },
  ]);
  const batchId = nanoid(10);
  const overall = tidy(original.prompt);
  const params = { ...original.params };
  delete params.shots;
  delete params.multiShot;
  const n = shots.length;
  const clips: Generation[] = [];
  try {
    for (const [i, s] of shots.entries()) {
      const { images, endImage, ...rest } = original.inputs ?? {};
      const inputs = { ...rest, ...((i === 0 || !canT2v) && images?.length && { images }), ...(i === n - 1 && endImage && { endImage }) };
      clips.push(
        createGenerations(
          {
            ...original,
            op: undefined,
            prompt: overall ? `${overall}. ${s.prompt.trim()}` : s.prompt.trim(),
            inputs: Object.keys(inputs).length ? inputs : undefined,
            params: { ...params, duration: s.duration, numOutputs: 1 },
            step: { label: `Shot ${i + 1} of ${n}`, index: i, of: n },
          },
          { batchId },
        )[0],
      );
    }
    const film = joinClips(
      clips.map((c) => c.id),
      {
        engine: model.engine,
        feature: original.feature,
        batchId,
        demo: original.demo,
        title: overall || shots.map((s) => tidy(s.prompt)).join(" / "),
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        step: { label: `Film · ${n} shots`, index: n, of: n + 1 },
      },
    );
    return withAsked([film, ...clips], original, model.engine);
  } catch (e) {
    // Don't leave shots rendering for a film that can't be made.
    for (const g of clips) void cancelGeneration(g.id);
    throw e;
  }
}

/**
 * Frames mode on an open model (Kling 4.0's keyframes, gap G02): one start/end-frame clip per pair of
 * neighbouring frames, each as long as the gap between them in the workflow's own frame steps, then
 * the stretch after the last frame (from it alone) when it isn't at the end, then a join. Two frames
 * at the start and the end make one clip and no join. Returns the film first, then the clips.
 *
 * Frames can come from earlier steps (`waits.dependsOn`, one per chain slot, each an image with its place among the
 * request's own: framesWait). Each clip then waits for the frames it starts or ends on (Turnaround video: the sides the
 * Angles app draws), and the clips between the request's own frames start at once.
 */
export function createKeyframeFilm(original: GenerationRequest, model: ModelDef, route: ModelRoute, waits: { batchId?: string; dependsOn?: string | string[] } = {}): Generation[] {
  const deps = waits.dependsOn === undefined ? [] : Array.isArray(waits.dependsOn) ? waits.dependsOn : [waits.dependsOn];
  const slots = original.chain ?? [];
  if (deps.length && (!framesWait(original) || slots.length !== deps.length)) throw new Error(chainedWaitMessage(model.name, "keyframes"));
  // A film whose frames came from earlier steps, asked again on its own (Run again): those steps are gone.
  if (slots.length && !deps.length) throw new Error(`Some of this film's frames were made by earlier steps — make it again where it was made, so ${model.name} gets them`);
  // The film's frames in order: the request's own, and the ones earlier steps make put in at their places.
  type Frame = { url: string } | { dep: string };
  const frames: Frame[] = (original.inputs?.images ?? []).map((url) => ({ url }));
  slots
    .map((s, i) => ({ at: s.at!, dep: deps[i] }))
    .sort((a, b) => a.at - b.at)
    .forEach((x) => frames.splice(Math.min(x.at, frames.length), 0, { dep: x.dep }));
  // The whole request is checked first (prompt, frame count, gaps), so no clip starts for a film that can't be made; frames
  // still to come are checked as placeholders.
  const asChecked: GenerationRequest = { ...original, op: "keyframes", chain: undefined, inputs: { ...original.inputs, images: frames.map((f) => ("url" in f ? f.url : WAITING_FRAME)) } };
  previewGeneration(asChecked);
  const images = asChecked.inputs?.images ?? [];
  const duration = original.params?.duration ?? model.defaults?.duration ?? 5;
  const times = original.params?.keyframeTimes?.length ? original.params.keyframeTimes : frameTimes(spread(images.length), duration);
  const wf = loadManifest().workflows.find((w) => w.id === route.endpoint);
  // Keyframe animation in the cloud (Fuobe Animation): one hosted clip per gap, as long as the gap's own frames (made at 16 fps,
  // every frame kept), each with its gap's words.
  const animation = model.options.inbetween ? requestTiming(original.params?.extra, images.length, original.params?.keyframeTimes, "cloud") : null;
  const stillMouth = original.params?.extra?.stillMouth === true;
  const clips: (KeyframeClip & { prompt?: string })[] = animation
    ? animation.gaps.map((g, i) => ({ from: i, to: i + 1, frames: g.frames, seconds: (g.frames - 1) / MAKE_FPS, prompt: gapPrompt(original.prompt, g, stillMouth) }))
    : planKeyframeClips(times, duration, {
        ...chainTiming(model),
        fps: Number(wf?.defaults.fps ?? 16),
        step: Number(wf?.defaults.frameStep ?? 4),
        maxFrames: wf?.limits?.maxFrames,
      });
  const tail = clips.some((c) => c.to === null);
  assertOneMode([
    { label: `${model.name} clips`, modelId: model.id, op: "flf2v", engine: model.engine },
    ...(tail ? [{ label: `${model.name} after the last frame`, modelId: model.id, op: "i2v" as const, engine: model.engine }] : []),
    ...(clips.length > 1 ? [{ label: "Joining the clips", modelId: joinModelId(model.engine), op: "concat" as const }] : []),
  ]);
  const batchId = waits.batchId ?? nanoid(10);
  const params = { ...original.params };
  delete params.keyframeTimes;
  if (params.extra) {
    params.extra = { ...params.extra };
    delete params.extra.inbetween;
    delete params.extra.stillMouth;
  }
  delete params.shots;
  delete params.multiShot;
  const rest = { ...original.inputs };
  delete rest.images;
  delete rest.endImage;
  const n = clips.length;
  const made: Generation[] = [];
  try {
    for (const [i, c] of clips.entries()) {
      const label = c.to === null ? `After frame ${c.from + 1}` : `Frames ${c.from + 1} → ${c.to + 1}`;
      // A frame an earlier step makes reaches the clip through its chain: the start as its image, the end as its end frame.
      const inputs: GenerationRequest["inputs"] = { ...rest };
      const chain: ChainSlot[] = [];
      const after: string[] = [];
      const start = frames[c.from];
      if ("url" in start) inputs.images = [start.url];
      else {
        chain.push({ slot: "images" });
        after.push(start.dep);
      }
      const end = c.to === null ? undefined : frames[c.to];
      if (end && "url" in end) inputs.endImage = end.url;
      else if (end) {
        chain.push({ slot: "endImage" });
        after.push(end.dep);
      }
      const request: GenerationRequest = {
        ...original,
        op: c.to === null ? "i2v" : "flf2v",
        ...(c.prompt !== undefined && { prompt: c.prompt }),
        inputs: Object.keys(inputs).length ? inputs : undefined,
        chain: chain.length ? chain : undefined,
        params: { ...params, duration: c.seconds, numOutputs: 1 },
        ...(n > 1 ? { step: { label, index: i, of: n + 1 } } : {}),
      };
      made.push(createGenerations(request, { batchId, ...(after.length && { dependsOn: after }) })[0]);
    }
    if (n === 1) return withAsked(made, original, model.engine);
    const film = joinClips(
      made.map((c) => c.id),
      {
        engine: model.engine,
        feature: original.feature,
        batchId,
        demo: original.demo,
        title: original.title?.trim() || tidy(original.prompt) || (animation ? "Animation" : "Keyframe film"),
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        step: { label: `Film · ${images.length} frames`, index: n, of: n + 1 },
      },
    );
    return withAsked([film, ...made], original, model.engine);
  } catch (e) {
    // Don't leave half a film rendering.
    for (const g of made) void cancelGeneration(g.id);
    throw e;
  }
}

/** Where a frame an earlier step makes sits while the film is checked (it is never sent). */
const WAITING_FRAME = "/api/files/placeholder.png";

/** Extend for models with no extend API (Kling): last frame → image-to-video on the same model → join. */
export function createExtendChain(original: GenerationRequest, model: ModelDef): Generation[] {
  const video = original.inputs?.video;
  if (!video) throw new Error("Add the video to continue");
  if (!supportsOp(model, "i2v")) throw new Error(`${model.name} can't continue a video`);
  // The last frame comes from fal's FFmpeg tool, or ComfyUI's frame-extract on the open engine.
  const frameModel = model.engine === "open" ? "oss-extract-frame" : "extract-frame";
  assertOneMode([
    { label: "Taking the last frame", modelId: frameModel, op: "frame" },
    { label: model.name, modelId: model.id, op: "i2v", engine: model.engine },
    { label: "Joining the clips", modelId: joinModelId(model.engine), op: "concat" },
  ]);
  const batchId = nanoid(10);
  const frame = createGenerations(
    { feature: original.feature, modelId: frameModel, op: "frame", inputs: { video }, step: { label: "Last frame", index: 0, of: 3 } },
    { batchId },
  )[0];
  const made = [frame];
  try {
    const rest = { ...original.inputs };
    delete rest.video;
    delete rest.videos;
    const clip = createGenerations(
      {
        ...original,
        op: "i2v",
        prompt: original.prompt?.trim() || "Continue the shot naturally, same subject, same camera move",
        inputs: Object.keys(rest).length ? rest : undefined,
        chain: [{ slot: "images", position: "first" }],
        step: { label: "Continuation", index: 1, of: 3 },
      },
      { batchId, dependsOn: frame.id },
    )[0];
    made.push(clip);
    const film = joinClips([clip.id], {
      engine: model.engine,
      feature: original.feature,
      batchId,
      demo: original.demo,
      title: tidy(original.prompt) || "Extended video",
      before: [video],
      step: { label: "Extended video", index: 2, of: 3 },
    });
    return withAsked([film, clip, frame], original, model.engine);
  } catch (e) {
    for (const g of made) void cancelGeneration(g.id);
    throw e;
  }
}

/** The still the open text-to-3D route draws first (Qwen-Image 2.1's text-to-image route). */
const STILL_MODEL = "oss-qwen-image-21";
/** The image-to-3D model that runs a text-to-3D route's workflow. */
const BUILDERS_3D: Record<string, string> = { "image-to-3d-trellis2": "oss-trellis2" };

/**
 * Text to 3D on the open engine (a text-to-3d route marked `chained`): Qwen-Image 2.1 draws the object whole on a
 * plain background (a helper step), then the route's workflow (TRELLIS.2) builds the model from that still.
 */
export function createStillTo3d(original: GenerationRequest, model: ModelDef, route: ModelRoute): Generation[] {
  const prompt = original.prompt?.trim();
  if (!prompt) throw new Error("Describe the object");
  const builder = BUILDERS_3D[route.endpoint];
  if (!builder) throw new Error(`${model.name} has no image-to-3D model for ${route.endpoint}`);
  assertOneMode([
    { label: "Drawing the object", modelId: STILL_MODEL, op: "t2i" },
    { label: model.name, modelId: builder, op: "image-to-3d" },
  ]);
  const batchId = nanoid(10);
  const seed = original.params?.seed;
  const still = createGenerations(
    {
      feature: MODEL3D_STEP_FEATURE,
      modelId: STILL_MODEL,
      op: "t2i",
      prompt: stillPromptFor3d(prompt),
      params: { aspectRatio: "1:1", resolution: "1K", ...(seed !== undefined && { seed }) },
      step: { label: "Still", index: 0, of: 2 },
    },
    { batchId },
  )[0];
  try {
    // The model is built from the still alone (a photo sent with the words has no place in this route).
    const inputs = { ...original.inputs };
    delete inputs.images;
    const built = createGenerations(
      {
        ...original,
        modelId: builder,
        op: "image-to-3d",
        inputs: Object.keys(inputs).length ? inputs : undefined,
        chain: [{ slot: "images", position: "first" }],
        step: { label: "3D model", index: 1, of: 2 },
      },
      { batchId, dependsOn: still.id },
    )[0];
    return withAsked([built, still], original, model.engine);
  } catch (e) {
    void cancelGeneration(still.id);
    throw e;
  }
}

/**
 * Image to 3D's "Refine detail · Hi3D 1.0" (params.extra.hi3dRefine, open engine only): the model the user picked builds
 * the coarse mesh from the photo, then Hi3D refines that mesh's geometry with the same photo (chain slot model3d) at the
 * resolution asked for. Both results stay (the refined one is geometry only), in one batch.
 */
export function createRefinedModel(original: GenerationRequest, model: ModelDef, waits: { batchId?: string; dependsOn?: string | string[] } = {}): Generation[] {
  const resolution = chainedRefine(original);
  if (resolution === null) throw new Error("No refine step was asked for");
  // Hi3D runs on your GPU only (nobody hosts the open model): the model before it runs there too.
  if (model.engine !== "open") throw new Error("Refine detail runs on your GPU only: pick an open model, or turn Refine detail off");
  // The model's photo may come from an earlier step (a Canvas image node, an Assist plan's still): Hi3D then waits for
  // that step too, and reads the same photo the model was built from.
  const deps = waits.dependsOn === undefined ? [] : Array.isArray(waits.dependsOn) ? waits.dependsOn : [waits.dependsOn];
  const slots: ChainSlot[] = deps.map((_, i) => original.chain?.[i] ?? { slot: "images", position: original.chainFrom ?? "last" });
  const own = original.inputs?.images?.[0];
  const fed = slots.findIndex((s) => s.slot === "images");
  const fedFirst = fed >= 0 && (slots[fed].at === 0 || (slots[fed].at === undefined && slots[fed].position === "first"));
  const photoStep = fed >= 0 && (!own || fedFirst) ? deps[fed] : undefined;
  const photo = photoStep ? undefined : own;
  if (!photo && !photoStep) throw new Error("Add a photo of the object: Hi3D refines the model from it");
  const op = original.op ?? "image-to-3d";
  assertOneMode([
    { label: model.name, modelId: model.id, op, engine: "open" },
    { label: "Hi3D 1.0", modelId: HI3D_MODEL, op: HI3D_OP, engine: "open" },
  ]);
  const extra = { ...original.params?.extra };
  delete extra[HI3D_CHAIN_PARAM];
  const params: GenParams = { ...original.params, extra };
  if (!Object.keys(extra).length) delete params.extra;
  const batchId = waits.batchId ?? nanoid(10);
  const built = createGenerations(
    { ...original, op, ...(Object.keys(params).length ? { params } : { params: undefined }), step: { label: "3D model", index: 0, of: 2 } },
    { batchId, ...(deps.length && { dependsOn: deps }) },
  )[0];
  try {
    const seed = original.params?.seed;
    const refined = createGenerations(
      {
        feature: original.feature,
        modelId: HI3D_MODEL,
        op: HI3D_OP,
        engine: "open",
        ...(photo && { inputs: { images: [photo] } }),
        params: { extra: { [HI3D_PARAM]: resolution }, ...(seed !== undefined && { seed }) },
        chain: photoStep ? [{ slot: "model3d" }, { slot: "images" }] : [{ slot: "model3d" }],
        step: { label: "Refined detail", index: 1, of: 2 },
      },
      { batchId, dependsOn: photoStep ? [built.id, photoStep] : built.id },
    )[0];
    return withAsked([refined, built], original, "open");
  } catch (e) {
    void cancelGeneration(built.id);
    throw e;
  }
}

/**
 * Fuobe DoP's relight effects (Silhouette, Window, Practicals…): the start frame is relit first (Qwen-Image-Edit 2509
 * with its Relight LoRA, on the engine the clip runs on), then animated with the effect's words. One batch of two steps.
 */
export function createRelitClip(
  original: GenerationRequest,
  relight: { engine: Engine; step: { modelId: string; op: Operation; prompt: string; loras?: LoraRef[]; params?: GenParams; labels?: { step: string; clip: string } } },
): Generation[] {
  const [image, ...rest] = original.inputs?.images ?? [];
  const { engine, step } = relight;
  const mixed = !!step.labels;
  if (!image) throw new Error(mixed ? "Add a start frame to draw in the look" : "Add a start frame to relight");
  // The clip runs on the engine asked for, never quietly on the other one (createGenerations refuses an engine that is off).
  const where = (e: Engine) => (e === "open" ? "on your GPU" : "in the cloud");
  if (original.engine && original.engine !== engine) throw new Error(`This ${mixed ? "effect" : "relight effect"} was planned ${where(engine)}, but ${where(original.engine)} was asked for`);
  assertOneMode([
    { label: step.labels?.step ?? "Relighting the start frame", modelId: step.modelId, op: step.op, engine },
    { label: getModel(original.modelId)?.name ?? original.modelId, modelId: original.modelId, op: original.op ?? "i2v", engine },
  ]);
  const batchId = nanoid(10);
  const relit = createGenerations(
    {
      feature: original.feature,
      // The step's model may run on both engines (Fuobe Mixed Media): it runs on the clip's.
      engine,
      modelId: step.modelId,
      op: step.op,
      prompt: step.prompt,
      inputs: { images: [image] },
      ...(step.loras?.length && { loras: step.loras }),
      ...(step.params && { params: step.params }),
      step: { label: step.labels?.step ?? "Relit start frame", index: 0, of: 2 },
    },
    { batchId },
  )[0];
  try {
    const clip = createGenerations(
      {
        ...original,
        engine,
        inputs: { ...original.inputs, images: rest.length ? rest : undefined },
        chain: [{ slot: "images", position: "first" }],
        step: { label: step.labels?.clip ?? "Relit clip", index: 1, of: 2 },
      },
      { batchId, dependsOn: relit.id },
    )[0];
    return withAsked([clip, relit], original, engine);
  } catch (e) {
    void cancelGeneration(relit.id);
    throw e;
  }
}

/**
 * A preset whose recipe edited the start frame into an end frame first: the Qwen-Image 2.1 edit (the end-frame step),
 * then MiniMax H3 from the start frame to the edited end frame (flf2v). One batch of two steps. An end-frame step is
 * only on the open engine (there is no hosted Qwen-Image 2.1). A transition that already takes an end frame from the
 * person has no end-frame step (the plan checks `!req.inputs?.endImage`).
 */
export function createEndFrameClip(original: GenerationRequest, endStep: PresetEndStep): Generation[] {
  const [image] = original.inputs?.images ?? [];
  if (!image) throw new Error("Add a start frame");
  assertOneMode([
    { label: "End frame", modelId: endStep.modelId, op: endStep.op, engine: "open" },
    { label: getModel(original.modelId)?.name ?? original.modelId, modelId: original.modelId, op: "flf2v", engine: "open" },
  ]);
  const batchId = nanoid(10);
  const endFrame = createGenerations(
    {
      feature: original.feature,
      engine: "open",
      modelId: endStep.modelId,
      op: endStep.op,
      prompt: endStep.promptTemplate,
      inputs: { images: [image] },
      ...(endStep.params && { params: endStep.params }),
      step: { label: "End frame", index: 0, of: 2 },
    },
    { batchId },
  )[0];
  try {
    const clip = createGenerations(
      {
        ...original,
        engine: "open",
        op: "flf2v",
        inputs: { ...original.inputs },
        chain: [{ slot: "endImage" }],
        step: { label: "Clip", index: 1, of: 2 },
      },
      { batchId, dependsOn: endFrame.id },
    )[0];
    return withAsked([clip, endFrame], original, "open");
  } catch (e) {
    void cancelGeneration(endFrame.id);
    throw e;
  }
}

/**
 * Fuobe Soul's PixeletedFace look (O11): each picture, then its faces pixelated on the engine it was made on: one SAM 3.1 +
 * mosaic graph on the GPU; in the cloud fal's SAM 3.1 finds the faces and the server (or, for a picture it can't decode, the
 * browser) pixelates under its masks. One two-step pipeline per picture (a later step takes one result), all in one batch,
 * each picture on its own seed (seed + i, as a batch of jobs gets). A run that waits for earlier steps (a Canvas node, a
 * pipeline step) waits with its picture. The mosaics come first: a caller that takes the first result (a pipeline's next
 * step, a Canvas node) gets the pixelated picture.
 */
export function createMosaicRun(original: GenerationRequest, model: ModelDef, opts: { batchId?: string; dependsOn?: string[] } = {}): Generation[] {
  const n = Math.max(1, Math.min(4, original.params?.numOutputs ?? 1));
  const engine = model.engine;
  const step = faceMosaicStep(engine);
  const words = original.prompt?.trim() || "Pixelated face";
  const seed = original.params?.seed;
  const deps = opts.dependsOn ?? [];
  const existing: Record<string, string> = Object.fromEntries(deps.map((id, i) => [`in${i}`, id]));
  const own = original.step;
  const batchId = opts.batchId ?? nanoid(10);
  const mosaics: Generation[] = [];
  const pictures: Generation[] = [];
  const made: Generation[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const of = n > 1 ? ` ${i + 1} of ${n}` : "";
      const params = { ...original.params, numOutputs: 1, ...(seed !== undefined && seed >= 0 && { seed: seed + i }) };
      const { items, byKey } = createPipeline(
        [
          {
            key: "picture",
            request: { ...original, engine, postMade: true, params, step: { label: own ? `${own.label} · before the face mosaic${of}` : `Before the face mosaic${of}`, index: 0, of: 2 } },
            ...(deps.length > 0 && { after: Object.keys(existing) }),
          },
          {
            key: "mosaic",
            request: {
              feature: original.feature,
              modelId: step.modelId,
              op: step.op,
              prompt: step.prompt,
              title: words,
              ...(original.batchTitle && { batchTitle: original.batchTitle }),
              step: { label: own ? `${own.label}${of}` : `Face mosaic${of}`, index: 1, of: 2 },
            },
            after: "picture",
            chain: [{ slot: "images", position: "first" }],
          },
        ],
        { batchId, ...(deps.length > 0 && { existing }) },
      );
      made.push(...items);
      mosaics.push(byKey.mosaic);
      pictures.push(byKey.picture);
    }
  } catch (e) {
    for (const g of made) void cancelGeneration(g.id);
    throw e;
  }
  return [...mosaics, ...pictures];
}

/**
 * The model a storyboard film is animated with: MiniMax H3 on your GPU (5 s shots, its default), Seedance 2.5 in the
 * cloud. MiniMax H3's shots, made from frames of one shape, are joined packet by packet (copy join), each shot with its
 * own sound; other open shots go through the decode join (video-concat-{n}), which keeps the picture only.
 */
export function filmModel(engine: Engine, modelId?: string): ModelDef {
  const m = getModel(modelId ?? (engine === "open" ? "oss-minimax-h3" : "seedance-2-5"));
  if (!m || m.kind !== "video" || !supportsOp(m, "i2v")) throw new Error("Pick an image-to-video model");
  return m;
}

// ---------------------------------------------------------------------------
// Pipelines: any DAG of steps

export interface PipelineStep {
  /** Unique name of the step within the pipeline (used by `after` and in `byKey`). */
  key: string;
  request: GenerationRequest;
  /** Steps whose output this one takes (the first of the slot's kind, or the slot's stem), in the order of its chain slots. */
  after?: string | string[];
  /** Where each `after` step's output goes (defaults to `request.chain`, else the images). */
  chain?: ChainSlot[];
}

export interface PipelineOptions {
  /** Group the steps (defaults to a new batch id). */
  batchId?: string;
  /**
   * Steps made before, by key → generation id (a retry's steps that finished or are still running): steps
   * may wait for them like for any other step, and they aren't made again.
   */
  existing?: Record<string, string>;
}

export interface Pipeline {
  batchId: string;
  /** Every generation created, in creation (topological) order. */
  items: Generation[];
  /** The generation each step made (for a step that expands into several rows, its final result). */
  byKey: Record<string, Generation>;
}

const asList = (a: string | string[] | undefined) => (a === undefined ? [] : Array.isArray(a) ? a : [a]);

/** Chain slots that take an audio output (and so may pick a stem). */
const AUDIO_SLOTS = new Set<ChainSlot["slot"]>(["audio", "voiceAudio", "audio2"]);

/**
 * Kahn's algorithm: steps in an order where every `after` comes first; throws on a cycle. Linear in steps + edges
 * (a per-frame render has hundreds). Keys that aren't steps (generations made before) are already done.
 */
function topoOrder(steps: PipelineStep[]): PipelineStep[] {
  const keys = new Set(steps.map((s) => s.key));
  const waits = (s: PipelineStep) => new Set(asList(s.after).filter((a) => keys.has(a)));
  const indegree = new Map(steps.map((s) => [s.key, waits(s).size]));
  const next = new Map<string, PipelineStep[]>();
  for (const t of steps) for (const a of waits(t)) next.set(a, [...(next.get(a) ?? []), t]);
  const ready = steps.filter((s) => indegree.get(s.key) === 0);
  const out: PipelineStep[] = [];
  for (let i = 0; i < ready.length; i++) {
    const s = ready[i];
    out.push(s);
    for (const t of next.get(s.key) ?? []) {
      const n = indegree.get(t.key)! - 1;
      indegree.set(t.key, n);
      if (n === 0) ready.push(t);
    }
  }
  if (out.length < steps.length) {
    const stuck = steps.filter((s) => !out.includes(s)).map((s) => `“${s.key}”`);
    throw new Error(`These steps wait for each other in a loop: ${stuck.join(", ")}`);
  }
  return out;
}

/**
 * Create a multi-step job from any graph of steps. Every step is validated (models, inputs,
 * engine mode, prices) and the graph is checked — unknown or duplicate keys, loops, a mix of
 * demo and real steps — before a single row is created; then the rows are created in
 * dependency order and the runner launches each step when the steps it waits for succeed.
 *
 * A chain slot takes the first output of its kind from the step it names, or with `stem` the
 * audio output whose `meta.stem` matches — that's how one separate-audio step feeds both the voice
 * to clone and the background to mix back in — or with `index` its output number i: one step per
 * index fans a list out (a step per extracted frame), one step with a slot per index gathers it back.
 *
 * @example Dub a clip into Spanish in the speaker's own voice, over the original music and effects
 * ```ts
 * const video = "/api/files/uploads/2026-10-17/clip.mp4";
 * const { batchId, byKey } = createPipeline([
 *   // Two stems: meta.stem "voice" and "background".
 *   { key: "stems", request: { feature: "dub", modelId: "oss-voice-separate", op: "separate-audio", inputs: { video } } },
 *   { key: "words", request: { feature: "dub", modelId: "oss-qwen3-asr", op: "transcribe" }, after: "stems", chain: [{ slot: "audio", stem: "voice" }] },
 *   // A transcript's cues go in as a cue list, so the translation keeps the timing.
 *   { key: "spanish", request: { feature: "dub", modelId: "oss-text-llm", op: "translate", params: { targetLanguage: "Spanish" } }, after: "words", chain: [{ slot: "prompt" }] },
 *   // Speak the translation, cloning the voice stem.
 *   { key: "voice", request: { feature: "dub", modelId: "oss-chatterbox", op: "tts" }, after: ["spanish", "stems"], chain: [{ slot: "prompt" }, { slot: "voiceAudio", stem: "voice" }] },
 *   { key: "lips", request: { feature: "dub", modelId: "oss-infinitetalk-v2v", op: "lipsync", inputs: { video } }, after: "voice", chain: [{ slot: "audio" }] },
 *   // The new voice over the background stem (inputs.audio2).
 *   { key: "film", request: { feature: "dub", modelId: "oss-mux", op: "mux" }, after: ["lips", "voice", "stems"], chain: [{ slot: "video" }, { slot: "audio" }, { slot: "audio2", stem: "background" }] },
 * ]);
 * // byKey.film is the finished video; every step shares batchId and shows "Step n of 6".
 * // Paid route: demucs ("vocals" counts as "voice"), scribe-v2, text-llm, chatterbox-cloud, sync-lipsync-3;
 * // merge-audio-video takes one track, so the voice and the other stems are mixed first by compose-timeline
 * // (overlapping clips go on tracks of their own) and that mix is the soundtrack (src/lib/av/dub.ts).
 * ```
 */
export function createPipeline(steps: PipelineStep[], opts: PipelineOptions = {}): Pipeline {
  if (!steps.length) throw new Error("A pipeline needs at least one step");
  const existing = opts.existing ?? {};
  const keys = new Set<string>();
  for (const s of steps) {
    if (!s.key?.trim()) throw new Error("Every step needs a key");
    if (keys.has(s.key) || Object.hasOwn(existing, s.key)) throw new Error(`Two steps are called “${s.key}”`);
    keys.add(s.key);
  }
  for (const s of steps) {
    const after = asList(s.after);
    for (const a of after) {
      if (a === s.key) throw new Error(`Step “${s.key}” can't wait for itself`);
      if (!keys.has(a) && !Object.hasOwn(existing, a)) throw new Error(`Step “${s.key}” waits for “${a}”, which isn't in the pipeline`);
    }
    const chain = s.chain ?? s.request.chain;
    // A step listed twice is two stems of one split (Remove dialogue's voice over its background): each slot it fills
    // names a stem of its own. Anything else listed twice is a mistake.
    const stemsFrom = (a: string) => after.flatMap((x, i) => (x === a ? [chain?.[i]?.stem?.toLowerCase()] : []));
    const twice = after.filter((a, i) => after.indexOf(a) !== i);
    if (twice.some((a) => stemsFrom(a).some((st) => !st) || new Set(stemsFrom(a)).size !== stemsFrom(a).length)) throw new Error(`Step “${s.key}” lists the same step twice`);
    if (chain && chain.length !== after.length) throw new Error(`Step “${s.key}” has ${chain.length} chain slot${chain.length === 1 ? "" : "s"} for ${after.length} earlier step${after.length === 1 ? "" : "s"}`);
    const stray = chain?.find((c) => c.stem && !AUDIO_SLOTS.has(c.slot));
    if (stray) throw new Error(`Step “${s.key}”: a stem (“${stray.stem}”) only goes into an audio slot, not “${stray.slot}”`);
    const badIndex = chain?.find((c) => c.index !== undefined && !(Number.isInteger(c.index) && c.index >= 0));
    if (badIndex) throw new Error(`Step “${s.key}”: an output number must be a whole number from 0 (got ${badIndex.index})`);
    const badCount = chain?.find((c) => c.of !== undefined && (c.index === undefined || !Number.isInteger(c.of) || c.of <= c.index));
    if (badCount) throw new Error(`Step “${s.key}”: a list of ${badCount.of} has no output number ${badCount.index ?? "(none given)"}`);
  }
  const ordered = topoOrder(steps);
  const n = steps.length;
  const indexOf = new Map(ordered.map((s, i) => [s.key, i]));
  const requests = new Map(
    ordered.map((s) => {
      const chain = s.chain ?? s.request.chain;
      const req: GenerationRequest = {
        ...s.request,
        ...(chain && { chain }),
        step: s.request.step ?? { label: `Step ${indexOf.get(s.key)! + 1} of ${n}`, index: indexOf.get(s.key)!, of: n },
      };
      return [s.key, req];
    }),
  );
  // Validate every step now, with placeholders for what earlier steps will make.
  const needed = new Set(steps.flatMap((s) => asList(s.after)));
  const previews = ordered.map((s) => {
    let p: ReturnType<typeof previewChained>;
    try {
      p = previewChained(requests.get(s.key)!, asList(s.after).length);
    } catch (e) {
      throw new Error(`Step “${s.key}”: ${(e as Error).message}`);
    }
    if (needed.has(s.key) && p.jobs > 1) throw new Error(`Step “${s.key}” makes ${p.jobs} jobs; later steps need one result — ask it for fewer outputs`);
    return { key: s.key, ...p };
  });
  const demo = previews.find((p) => p.demo);
  // Steps made before count too: a demo step can't continue what ran for real.
  const madeForReal = Object.values(existing).some((id) => {
    const g = getGeneration(id, { includeDeleted: true });
    return g && g.provider !== "mock";
  });
  if (demo && (madeForReal || previews.some((p) => !p.demo))) {
    throw new Error(`Step “${demo.key}” would run as a demo (${demo.model.name} needs ${providerNames(demo.model, demo.op)}) while the others run for real — connect it in Settings, or turn on demo mode to try it all as a demo`);
  }

  const batchId = opts.batchId ?? nanoid(10);
  const items: Generation[] = [];
  const byKey: Record<string, Generation> = {};
  try {
    for (const s of ordered) {
      const after = asList(s.after);
      const made = createGenerations(requests.get(s.key)!, { batchId, ...(after.length && { dependsOn: after.map((a) => byKey[a]?.id ?? existing[a]) }) });
      byKey[s.key] = made[0];
      items.push(...made);
    }
  } catch (e) {
    // Don't leave half a pipeline running.
    for (const g of items) void cancelGeneration(g.id);
    throw e;
  }
  return { batchId, items, byKey };
}

/**
 * "Clean the voice first" (src/lib/av/voice-first.ts): the speech separated from the music and effects (DBS on your GPU,
 * ElevenLabs voice isolation in the cloud) before the transcriber or the lip sync hears it; after a lip re-sync on your
 * GPU, the music and effects of the same recording go back under it. One batch; the result comes first.
 */
export function createVoiceFirst(original: GenerationRequest, engine: Engine, opts: { batchId?: string } = {}): Generation[] {
  const steps = planVoiceFirst(original, engine);
  assertOneMode(steps.map((s) => ({ label: s.request.step?.label ?? s.key, modelId: s.request.modelId, op: s.request.op ?? "separate-audio", engine })));
  // In the caller's batch when it has one (a studio pipeline's transcript step), else a batch of its own.
  const run = createPipeline(steps.map((s) => ({ key: s.key, request: s.request, ...(s.after && { after: s.after }), ...(s.chain && { chain: s.chain }) })), { batchId: opts.batchId });
  const last = run.byKey[steps[steps.length - 1].key];
  return withAsked([last, ...run.items.filter((g) => g.id !== last.id)], original, engine);
}
