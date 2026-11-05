import "server-only";
import { originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { getModel } from "@/lib/catalog";
import {
  clampFps,
  cleanValues,
  FRAME_LIMITS,
  frameResolution,
  frameSampling,
  getMixedPreset,
  MIXED_FEATURE,
  MIXED_FRAME_FEATURE,
  MIXED_FRAME_MODELS,
  MIXED_FRAME_MOVES,
  MIXED_MODELS,
  MIXED_MODES,
  MIXED_OPEN_LEGACY,
  MIXED_ORIGINAL,
  MIXED_SMOOTH_MODEL,
  mixedFrames,
  mixedRangeProblem,
  nearestResolution,
  planMixed,
  planMixedPreview,
  type MixedMode,
  type MixedPlanInput,
  type MixedResolution,
} from "@/lib/catalog/mixed-media";
import { mixedLoras } from "@/lib/catalog/mixed-media-looks";
import { clipLengthProblem, originalSegmentProblem, planSegments, type PlanStep } from "@/lib/catalog/shorts";
import { sourceSeconds, takesImage } from "@/lib/catalog/shorts-models";
import type { Engine, Generation, GenerationRequest, ProviderId } from "@/lib/catalog/types";
import { generationAccount } from "./account-library";
import { createPipeline } from "./chains";
import { db } from "./db";
import { ConnectComfyError, DROPPED_UNUSED, getGeneration, previewChained, unfilledRequest, waitedOnFailure } from "./generations";
import { withoutMissingOnComfy, withoutUnreachableCivitai } from "./loras";
import { comfyLoraFiles, probeComfy } from "./providers/comfyui";
import { engineMode, getSetting } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { tenantAccount } from "./tenant";

/**
 * Mixed Media renders and preview frames. No table of its own: every render is a pipeline of
 * ordinary generations (feature "mixed-media" for the finished video, "mixed-media-step" for the
 * cut and the soundtrack-less render, "mixed-media-preview" for preview frames), so History is a feed.
 */

export { ShortsError as MixedError };

export interface MixedBody {
  engine: Engine;
  presetId: string;
  values?: Record<string, unknown>;
  /** width / height / fps: what the browser read, for estimates made before the server has the file. */
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number };
  range: { start: number; end: number };
  fps: number;
  resolution: MixedResolution;
  /** Per frame: the frame model (MIXED_FRAME_MODELS in the cloud, the Original on your GPU); Fast: the restyle model; Smooth: the Original. */
  modelId?: string;
  /** Frame by frame, Smooth or (cloud) Fast. Without it, Fast for a Fast restyle model, else Per frame. */
  mode?: MixedMode;
  /** Cloud: the approved preview still (anchors the render: Per frame always, Fast when the model takes an image). */
  anchor?: string;
  /** Cloud preview: the frame the browser grabbed at the start of the selection. */
  frameUrl?: string;
  seed?: number;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
}

/**
 * How a render restyles: the mode asked for, else Fast when the model named is a Fast restyle model (an API caller from
 * before Per frame), else Per frame. A model that belongs to another mode is refused, not swapped; Smooth is the
 * Original's own, and Fast is the cloud's.
 */
function renderMode(body: Pick<MixedBody, "engine" | "mode" | "modelId">): MixedMode {
  const fastModel = !!body.modelId && MIXED_MODELS.cloud.includes(body.modelId);
  const frameModel = !!body.modelId && (MIXED_FRAME_MODELS as readonly string[]).includes(body.modelId) && body.modelId !== MIXED_ORIGINAL;
  const mode = body.mode ?? (body.engine === "cloud" && fastModel ? "fast" : "frames");
  const name = (id: string) => getModel(id)?.name ?? id;
  if (!MIXED_MODES[body.engine].includes(mode)) throw new ShortsError("Fast runs in the cloud — on your GPU pick Per frame or Smooth", 422);
  if (body.engine === "cloud" && mode === "frames" && fastModel) {
    throw new ShortsError(`${name(body.modelId!)} restyles the clip as video — pick Fast for it, or ${MIXED_FRAME_MODELS.map(name).join(" or ")} to redraw each frame`, 422);
  }
  if (mode === "fast" && (frameModel || body.modelId === MIXED_ORIGINAL)) {
    throw new ShortsError(`${name(body.modelId!)} redraws single frames — pick Per frame${frameModel ? "" : " or Smooth"} for it, or a Fast restyle model`, 422);
  }
  if (mode === "smooth" && body.modelId && body.modelId !== MIXED_ORIGINAL) throw new ShortsError(`Smooth is ${name(MIXED_ORIGINAL)}'s own — pick Per frame or Fast for ${name(body.modelId)}`, 422);
  return mode;
}

/** The models a mode chooses from on an engine (the first is its default). */
function modeModels(engine: Engine, mode: MixedMode): readonly string[] {
  if (mode === "smooth") return [MIXED_ORIGINAL];
  if (mode === "fast") return MIXED_MODELS.cloud;
  // On your GPU, an API caller that names the per-frame model from before the Original keeps it.
  return engine === "cloud" ? MIXED_FRAME_MODELS : [...MIXED_MODELS.open, MIXED_OPEN_LEGACY];
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

async function planInput(body: MixedBody, opts: { probe: boolean }): Promise<{ input: MixedPlanInput; frames: number; fps: number; notes: string[] }> {
  const engines = engineMode();
  if (engines !== "both" && engines !== body.engine) {
    throw new ShortsError(engines === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
  const preset = getMixedPreset(body.presetId);
  if (!preset) throw new ShortsError("Pick a preset");
  const info = opts.probe ? await probeSource(body.source.url) : {};
  const duration = info.duration ?? body.source.duration;
  const sourceFps = info.fps ?? body.source.fps;
  const problem = mixedRangeProblem(body.range, duration, sourceFps);
  if (problem) throw new ShortsError(problem);
  const fps = clampFps(body.fps, sourceFps);
  // A frame model Per frame has moved on from runs on its successor, and says so.
  const movedFrom = body.modelId && MIXED_FRAME_MOVES[body.modelId] ? body.modelId : undefined;
  if (movedFrom) body = { ...body, modelId: MIXED_FRAME_MOVES[movedFrom] };
  const mode = renderMode(body);
  const choices = modeModels(body.engine, mode);
  const modelId = body.modelId && choices.includes(body.modelId) ? body.modelId : choices[0];
  const model = getModel(modelId);
  const len = body.range.end - body.range.start;
  const notes: string[] = [];
  if (movedFrom && modelId === body.modelId) notes.push(`${getModel(movedFrom)?.name ?? movedFrom} is now ${model?.name ?? modelId} here`);
  let frames = mixedFrames(len, fps);
  let rate = fps;
  const size = info.width && info.height ? { width: info.width, height: info.height } : body.source.width && body.source.height ? { width: body.source.width, height: body.source.height } : undefined;
  const original = modelId === MIXED_ORIGINAL;
  if (body.engine === "cloud" && mode === "frames") {
    // Frames are every Nth frame of the clip: say so when that isn't the rate picked.
    if (!sourceFps) throw new ShortsError("Couldn't read this clip's frame rate — pick Fast to restyle it as video", 422);
    const s = frameSampling(len, fps, sourceFps);
    frames = s.frames;
    rate = s.fps;
    if (Math.abs(s.fps - fps) > 0.01) notes.push(`Frames are every ${s.interval === 1 ? "" : `${ordinal(s.interval)} `}frame of this ${+sourceFps.toFixed(2)} FPS clip: ${+s.fps.toFixed(2)} FPS, ${frames} frames`);
    if (modelId === "seedream-5-flash") notes.push(`Seedream 5.0 Flash takes no seed, so frames vary a little more than with Nano Banana 2.1${body.resolution === "4K" ? "; it draws up to 2K" : ""}`);
    else if (original && body.resolution === "4K") notes.push(`${model?.name} draws frames at up to 2K (about 4 megapixels)`);
    else if (frames > FRAME_LIMITS.perClip && body.resolution !== "1K") {
      // merge-videos sizes the joined clips 512–2048 px a side.
      notes.push(`Over ${FRAME_LIMITS.perClip} frames are made as clips and joined at up to ${FRAME_LIMITS.joinMaxPx} px${frameResolution(frames, body.resolution) !== body.resolution ? ", so frames are drawn at 2K" : ""}`);
    }
  } else if (mode === "fast") {
    // A cut the model won't take is paid for, then refused: say so before anything runs.
    const fits = (id: string) => clipLengthProblem({ name: getModel(id)?.name ?? id, minSeconds: sourceSeconds(id).min, maxSeconds: sourceSeconds(id).max }, len);
    const tooShort = fits(modelId);
    if (tooShort) {
      const other = MIXED_MODELS.cloud.find((id) => !fits(id));
      const more = (sourceSeconds(modelId).min ?? 0) > len;
      throw new ShortsError(`${tooShort} — select ${more ? "more" : "less"}${other ? `, or pick ${getModel(other)?.name ?? other}` : ""}`);
    }
  }
  // The partner editors start each lane from the approved preview; the Original draws every frame on its own (one seed).
  const anchor = mode === "frames" && body.engine === "cloud" && !original ? body.anchor : mode === "fast" && body.anchor && takesImage(modelId, "cloud") ? body.anchor : undefined;
  if (mode === "fast") {
    if (body.anchor && !anchor) notes.push(`${model?.name} restyles from words only — the preview frame isn't sent`);
    notes.push(`${model?.name} restyles the clip as smooth video in one pass — Per frame redraws every frame of it instead`);
  } else if (mode === "smooth") {
    const segments = planSegments(body.range, body.engine, { modelId: MIXED_SMOOTH_MODEL, fps: sourceFps });
    const pieces = segments.length;
    // fal's Wan 2.2 Fun VACE takes 17 frames or more, at 5 fps or more: refused here, before the cut and the first frame are paid for.
    const vace = body.engine === "cloud" ? segments.map((s) => originalSegmentProblem(s.end - s.start, sourceFps)).find(Boolean) : null;
    if (vace) throw new ShortsError(`${vace} — or pick Per frame`, 422);
    notes.push(
      body.engine === "open"
        ? `Smooth draws the first frame in the look, then Wan 2.2 Fun VACE carries it through the clip by depth: 480p at 16 fps on your GPU${pieces > 1 ? `, in ${pieces} pieces of up to 5 s` : ""}`
        : `Smooth draws the first frame in the look, then Wan 2.2 Fun VACE carries it through the clip by depth at 720p${pieces > 1 ? `, in ${pieces} pieces (each starts from its own first frame)` : ""}`,
    );
    if (body.engine === "cloud" && sourceFps && sourceFps > 16.5) notes.push(`fal bills this clip's ${Math.round(sourceFps)} fps as ${(sourceFps / 16).toFixed(1)}× its length (video seconds at 16 fps)`);
  } else if (body.engine === "open" && body.resolution !== "1K") notes.push("The open engine renders up to 1536 px on the long side");
  // The look's LoRA: one that downloads from civitai needs the civitai key; without it the look runs on its words.
  let reach = original && mode !== "fast" ? withoutUnreachableCivitai(mixedLoras(preset.id), body.engine === "open" ? "comfyui" : "fal") : undefined;
  // On your GPU without a LoRA folder (Settings → LoRAs) Fuobe can't download one, so ComfyUI must have it already: a LoRA
  // it doesn't list is left out and said here, rather than the render failing once it's handed over.
  // An account's own ComfyUI is asked when its run is checked (account-tool-run.ts: the LoRAs it lacks, before anything
  // is queued), never on a price check.
  if (reach?.loras.length && body.engine === "open" && !tenantAccount() && !getSetting("comfyLorasDir") && (await probeComfy())) {
    const onComfy = withoutMissingOnComfy(reach.loras, await comfyLoraFiles());
    reach = { loras: onComfy.loras, notes: [...reach.notes, ...onComfy.notes] };
  }
  if (reach) notes.push(...reach.notes);
  const name = (body.source.name ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, 40);
  return {
    frames,
    fps: rate,
    notes,
    input: {
      engine: body.engine,
      title: name ? `${preset.name} · ${name}` : `${preset.name} mixed media`,
      preset,
      values: cleanValues(preset, body.values),
      // Sound we couldn't read counts as none (the soundtrack step would fail after the restyle was paid for).
      source: { url: body.source.url, duration, hasAudio: info.hasAudio ?? false },
      range: body.range,
      fps,
      resolution: body.resolution,
      modelId,
      mode,
      sourceFps,
      ...(size && { sourceSize: size }),
      ...(reach && { loras: reach.loras }),
      anchor,
      modelResolution: mode === "fast" ? nearestResolution(model?.options.resolutions, body.resolution) : undefined,
      // LTX follows the clip's outlines, like the open engine's canny ControlNet.
      extra: modelId === "ltx-2-3-restyle" ? { preprocessor: "canny" } : undefined,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      // What of the clip's sound goes back: the cloud puts it all back (DBS runs on your GPU).
      ...(body.originalSound && { originalSound: originalSoundOn(body.originalSound, body.engine) }),
    },
  };
}

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** Every step validated and priced; steps alike but for their place in the chain (a frame each) are previewed once. */
function price(steps: PlanStep[]): { costUsd: number | null; demo: boolean; providers: ProviderId[] } {
  let cost: number | null = 0;
  let demo = false;
  const providers = new Set<ProviderId>();
  const seen = new Map<string, ReturnType<typeof previewChained>>();
  for (const s of steps) {
    const req = withChain(s);
    const key = JSON.stringify([req.modelId, req.op, req.prompt, req.inputs, req.params, req.chain?.map((c) => c.slot), s.after?.length ?? 0]);
    const p = seen.get(key) ?? previewChained(req, s.after?.length ?? 0);
    seen.set(key, p);
    demo ||= p.demo;
    providers.add(p.providerId);
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo, providers: [...providers] };
}

export interface MixedEstimate {
  costUsd: number | null;
  previewUsd: number | null;
  demo: boolean;
  /** The model that restyles the clip, and where the steps run ("mock" for demo steps), for the evaluation harness. */
  modelId: string;
  providers: ProviderId[];
  frames: number;
  /** The frame rate the frames are taken at (cloud Per frame: the clip's own over a whole number). */
  fps: number;
  /** Cloud: how it restyles. */
  mode?: MixedMode;
  /** Cloud Per frame: the price of redrawing one frame (Higgsfield's 2 credits a frame). */
  perFrameUsd?: number | null;
  notes: string[];
}

export async function estimateMixed(body: MixedBody): Promise<MixedEstimate> {
  const { input, frames, fps, notes } = await planInput(body, { probe: false });
  const plan = planMixed(input);
  const full = price(plan.steps);
  const preview = price([planMixedPreview({ ...input, frameUrl: body.frameUrl ?? "/api/files/placeholder.png" })]);
  const frame = input.mode === "frames" ? plan.steps.find((s) => s.key === "f0") : undefined;
  const perFrameUsd = frame ? previewChained(withChain(frame), frame.after?.length ?? 0).costUsd : undefined;
  return {
    ...full,
    previewUsd: preview.costUsd,
    modelId: input.modelId,
    frames,
    fps,
    notes,
    ...(input.mode && { mode: input.mode }),
    ...(perFrameUsd !== undefined && { perFrameUsd }),
  };
}

function run(steps: PlanStep[], opts: { existing?: Record<string, string> } = {}): { batchId: string; items: Generation[]; byKey: Record<string, Generation> } {
  try {
    return createPipeline(steps, opts);
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

/** What the page follows of a render: every step but the per-frame edits (their count instead). */
const followed = (p: { items: Generation[] }) => ({ items: p.items.filter((g) => g.feature !== MIXED_FRAME_FEATURE), frames: p.items.filter((g) => g.feature === MIXED_FRAME_FEATURE).length });

/** A planned render (or retry, or preview frame): its steps and the finished video's key. Nothing is created yet. */
export interface MixedRun {
  steps: PlanStep[];
  final: string;
  /** A retry: the steps it keeps (their ids), and the waiting steps it stops once the new ones are made. */
  existing?: Record<string, string>;
  stop?: string[];
}

/** A planned run's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts). */
export const mixedSteps = (r: MixedRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** Start a planned render or retry; returns the finished video's generation, the steps the page follows and the frame count. */
export function startMixed(r: MixedRun): { final: Generation; items: Generation[]; frames: number } {
  const p = run(r.steps, r.existing ? { existing: r.existing } : {});
  // Old steps that would only fail after the ones they wait for: stop them (nothing was spent on them yet).
  for (const id of r.stop ?? []) cancelWaiting(id);
  return { final: p.byKey[r.final], ...followed(p) };
}

/** Plan the full render (the clip's header is read; nothing is created). */
export async function planMixedRun(body: MixedBody): Promise<MixedRun> {
  const { input } = await planInput(body, { probe: true });
  const plan = planMixed(input);
  return { steps: plan.steps, final: plan.final };
}

/** Start the full render; returns the finished video's generation (the others wait for it). */
export async function createMixed(body: MixedBody): Promise<{ final: Generation; items: Generation[]; frames: number }> {
  return startMixed(await planMixedRun(body));
}

/**
 * Whether this render is the asker's own: an account's own run, or the owner's when the owner asks (an account's render
 * reads as gone to anyone else).
 */
const ownRender = (id: string) => (generationAccount(id) ?? null) === (tenantAccount() ?? null);

interface StepRow {
  id: string;
  feature: string;
  status: Generation["status"];
  error: string | null;
  depends_on: string | null;
}

const depList = (v: string | null): string[] => (!v ? [] : v.startsWith("[") ? (JSON.parse(v) as string[]) : [v]);

/**
 * A render's steps: its finished video and every step it waits for, across earlier tries (a retry's new steps
 * wait for the ones that had finished), inputs before the steps that take them. Null when one is gone.
 */
function renderSteps(finalId: string): StepRow[] | null {
  const get = db().prepare("SELECT id, feature, status, error, depends_on FROM generations WHERE id = ?");
  const rows = new Map<string, StepRow>();
  const order: StepRow[] = [];
  let gone = false;
  // Depth-first: a lane of frames is a dozen deep, so the recursion stays shallow.
  const visit = (id: string) => {
    if (rows.has(id) || gone) return;
    const r = get.get(id) as StepRow | undefined;
    if (!r) {
      gone = true;
      return;
    }
    rows.set(id, r);
    for (const d of depList(r.depends_on)) visit(d);
    order.push(r);
  };
  visit(finalId);
  return gone ? null : order;
}

/**
 * Try a render again (History's "Try again"): the steps that failed or were canceled, and every step after them,
 * are made anew (in a new batch) from their stored requests; they wait for the steps that finished, or are still
 * running, which aren't made or paid for again. A render with nothing failed is made again from its first step.
 */
export function retryMixed(id: string): { final: Generation; items: Generation[]; frames: number } {
  return startMixed(planMixedRetry(id));
}

/** Plan a retry (nothing is created): the steps made anew, the ones kept and the waiting ones to stop. */
export function planMixedRetry(id: string): MixedRun {
  const final = getGeneration(id);
  if (!final || final.feature !== MIXED_FEATURE || !ownRender(id)) throw new ShortsError("This render no longer exists", 404);
  const mode = engineMode();
  if (mode !== "both" && mode !== final.engine) {
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
  const rows = renderSteps(id);
  if (!rows) throw new ShortsError("Part of this render was deleted — make it again from the editor", 409);
  // In input order, so a step is redone when it failed or any step it waits for is redone.
  const redo = new Set<string>();
  for (const r of rows) if (r.status === "failed" || r.status === "canceled" || depList(r.depends_on).some((d) => redo.has(d))) redo.add(r.id);
  const again = redo.size ? rows.filter((r) => redo.has(r.id)) : rows;
  const existing = Object.fromEntries(rows.filter((r) => redo.size && !redo.has(r.id)).map((r) => [r.id, r.id]));
  const steps: PlanStep[] = again.map((r) => {
    const g = getGeneration(r.id);
    if (!g) throw new ShortsError("Part of this render was deleted — make it again from the editor", 409);
    const after = depList(r.depends_on);
    // Chained inputs were filled in when the step ran: the new run fills them from the new (or kept) steps.
    const { chain, ...request } = unfilledRequest(g.request, after.length);
    const inputs = { ...request.inputs };
    for (const c of chain ?? []) if (c.slot !== "images" && c.slot !== "videos" && c.slot !== "audios" && c.slot !== "prompt") delete inputs[c.slot];
    return { key: r.id, request: { ...request, inputs: Object.keys(inputs).length ? inputs : undefined }, ...(after.length ? { after, chain } : {}) };
  });
  return { steps, final: id, existing, stop: again.filter((r) => r.status === "queued" && r.depends_on).map((r) => r.id) };
}

/** Stop a step still waiting for its inputs (nothing spent yet). */
function cancelWaiting(id: string): void {
  db()
    .prepare("UPDATE generations SET status = 'canceled', message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND external_id IS NULL AND depends_on IS NOT NULL")
    .run(Date.now(), Date.now(), id);
}

export interface FramesProgress {
  /** Frame edits in the render. */
  total: number;
  done: number;
  running: number;
  /**
   * The first frame that failed with its own error, or that someone canceled. Unset when the frames only failed
   * because an earlier step did (the cut, the extraction): that step's own error says why.
   */
  failed?: { label: string; error: string };
}

/** A per-frame render's frame edits at a glance (the page follows the main steps, not hundreds of frames), by its finished video's id. */
export function framesProgress(finalId: string): FramesProgress | null {
  // Another's render reads as gone (an account's to the owner, the owner's or another account's to an account),
  // in the Trash too: the steps are read from the table itself, so the check can't lean on the Library's view.
  if (!ownRender(finalId)) return null;
  const rows = renderSteps(finalId);
  if (!rows) return getGeneration(finalId) ? { total: 0, done: 0, running: 0 } : null;
  const frames = rows.filter((r) => r.feature === MIXED_FRAME_FEATURE);
  const out: FramesProgress = { total: frames.length, done: frames.filter((r) => r.status === "succeeded").length, running: frames.filter((r) => r.status === "running").length };
  const waited = new Set([waitedOnFailure(false), waitedOnFailure(true)]);
  const own = frames.filter((r) => r.status === "failed" && !waited.has(r.error ?? ""));
  const stopped = frames.filter((r) => r.status === "canceled" && r.error !== DROPPED_UNUSED);
  const at = (r: StepRow) => {
    const req = (db().prepare("SELECT request_json FROM generations WHERE id = ?").get(r.id) as { request_json: string }).request_json;
    return (JSON.parse(req) as Generation["request"]).step;
  };
  const first = (list: StepRow[]) => list.map((r) => ({ r, step: at(r) })).sort((a, b) => (a.step?.index ?? 0) - (b.step?.index ?? 0))[0];
  const bad = first(own) ?? first(stopped);
  if (bad) out.failed = { label: bad.step?.label ?? "A frame", error: bad.r.status === "canceled" ? "Canceled" : (bad.r.error ?? "Something went wrong") };
  return out;
}

/** Plan one frame with the current settings (nothing is created). */
export async function planMixedPreviewRun(body: MixedBody): Promise<MixedRun> {
  const { input } = await planInput(body, { probe: true });
  if (input.engine === "cloud" && !body.frameUrl?.startsWith("/api/files/")) throw new ShortsError("Couldn't grab a frame from this clip in the browser — generate the full video instead");
  return { steps: [planMixedPreview({ ...input, frameUrl: body.frameUrl })], final: "preview" };
}

/** One frame with the current settings. */
export async function createMixedPreview(body: MixedBody): Promise<Generation> {
  const r = await planMixedPreviewRun(body);
  return run(r.steps).byKey[r.final];
}
