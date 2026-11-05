/**
 * Pure composer logic shared by the studio composer and its tests: the settings summary chip,
 * blocker messages, attachment placement and model-picker grouping. No catalog import here, so
 * nothing in this file pulls the model list into the browser bundle.
 */
import { FORMAT_INFO } from "./av/formats";
import { fpsPlan, fpsSummary } from "./av/fps";
import { sideMultipleProblem, targetShortEdge, upscaledSize, upscaleFactorFor, upscaleTier } from "./av/upscale";
import { wholeClipProblem, wholeClipTool } from "./av/video-finish";
import { clipFpsProblem, clipSizeProblem, clipWindowProblem } from "./catalog/clip-windows";
import { clipBilling, sourceLengthProblem } from "./catalog/plan";
import { addFrameAt, frameTimes, framesInputs, removeFrameAt, spread, type FrameSupport } from "./catalog/keyframes";
import { keyTimes, totalSeconds, type InbetweenTiming } from "./inbetween";
import { FACE_MOSAIC_MODELS } from "./catalog/open-tools";
import { pricingOn, type PriceClock } from "./catalog/promo";
import { soulPostStep } from "./catalog/soul";
import { studioResolutions } from "./catalog/regenerate";
import { appModels, ownRoute, presetRoutes, type HasModel, type RecipePreset } from "./catalog/preset-recipe-routes";
import { COLORMAPS, type Engine, type GenParams, type InputSlot, type MatteOutput, type MediaKind, type ModelDef, type Operation, type Preset, type PresetRoute, type VideoFormat } from "./catalog/types";
import { formatCost } from "./format";
import { spokenLanguageName } from "./speech-languages";
import { LAYOUT_MAX_PIXELS, LAYOUT_MAX_SIDE, LAYOUT_PARAM, readLayout, readsBoxes, type LayoutDraft } from "./layout-prompt";

// ---------------------------------------------------------------------------
// Settings summary ("16:9 · 720p · 5s · ×1")

/** Operations that transform one input into one result — no batch count. */
export const SINGLE_TAKE = new Set<Operation>([
  "lipsync", "avatar", "upscale-video", "upscale-image", "dub", "extend", "reframe", "finalize", "v2a", "interpolate",
  "bg-remove", "bg-remove-video", "depth-video", "concat", "color-match", "frame", "sdr-to-hdr", "export-video",
]);

/** A length as it reads on a chip: seconds up to a minute ("10s"), minutes and seconds after it ("2:00", "4:30": a song). */
export const durationLabel = (v: number) =>
  v >= 1000 ? `${Math.round(v / 1000)}s` : v >= 60 ? `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}` : `${v}s`;

export interface SettingsShape {
  /** Show the aspect-ratio control (the model offers several and the operation isn't framed by an input). */
  aspect: string[] | null;
  resolution: string[] | null;
  duration: number[] | null;
  /** Batch count (×1–×4). */
  count: boolean;
  draft: boolean;
  audio: boolean;
  multiShot: boolean;
  enhance: boolean;
  sliders: boolean;
  negativePrompt: boolean;
  /** The spoken languages a transcriber can be told (unset = it detects): the "Spoken language" picker. */
  sourceLanguages: string[] | null;
  /** Remove background: the cut-out or its alpha mask, as far as the model makes them (one is still shown, with a note). */
  matteOutput: MatteOutput[] | null;
  /** Depth maps: the colour maps the model draws (grayscale alone is still shown, with where the others are). */
  colormap: string[] | null;
  /** Depth maps: the original clip next to the map. */
  sideBySide: boolean;
  /** Frame rates to reach (FPS Boost, upscalers): `original` adds the clip's own rate as the first choice. */
  fps: { values: number[]; original: boolean } | null;
  /** Slow-motion factors (1 = off). */
  slowdown: number[] | null;
  /** Output formats (SDR to HDR, export): the model's, or every format the studio's models write. */
  formats: VideoFormat[] | null;
}

/**
 * Which output settings apply to this model, operation and studio. `studioOps` are the studio's
 * operations: when the operation isn't known yet (nothing attached) and they're all one-take
 * transforms (Lipsync), there's still no batch count.
 */
export function settingsShape(
  model: (Pick<ModelDef, "options" | "defaults"> & Partial<Pick<ModelDef, "routes">>) | undefined,
  op: Operation | undefined,
  kind: MediaKind,
  showPrompt: boolean,
  params: GenParams = {},
  studioOps: Operation[] = [],
  studioFormats?: VideoFormat[],
): SettingsShape {
  const o = model?.options ?? {};
  const formats = studioFormats?.length ? studioFormats : o.formats;
  const many = <T,>(xs: T[] | undefined) => (xs && xs.length > 1 ? xs : null);
  const single = op ? SINGLE_TAKE.has(op) : studioOps.length > 0 && studioOps.every((x) => SINGLE_TAKE.has(x));
  // The operation, or the studio's only one before anything is attached (Video tools → Depth map).
  const is = (x: Operation) => op === x || (!op && studioOps.length > 0 && studioOps.every((y) => y === x));
  // A graph that takes no size (ModelRoute.unsized: Qwen-Image 2.1's edit follows image 1) has none to pick for this
  // operation, or for any of the studio's while the operation isn't known yet (Inpaint before a prompt).
  const ops = op ? [op] : studioOps;
  const routes = (model?.routes ?? []).filter((r) => ops.includes(r.op));
  const sized = !routes.length || routes.some((r) => !r.unsized);
  // A cloud edit that follows image 1's shape at the chosen tier (ModelRoute.followsImage: fal's FLUX 3 Klein) keeps Resolution only.
  const shaped = routes.length > 0 && routes.every((r) => r.unsized || r.followsImage);
  return {
    aspect: !sized || shaped || op === "i2v" || op === "flf2v" ? null : many(o.aspectRatios),
    // With the tiers a finishing pass reaches (MiniMax H3's 2K on your GPU: a 768p draft redrawn by Open-H3 Regenerate).
    resolution: sized ? many(studioResolutions(o)) : null,
    duration: params.shots ? null : many(o.durations),
    count: (kind === "image" || kind === "video") && !single,
    draft: !!o.draft,
    audio: o.audio === true,
    multiShot: !!o.multiShot,
    enhance: showPrompt,
    sliders: !!o.sliders?.length,
    negativePrompt: !!o.negativePrompt,
    sourceLanguages: o.sourceLanguages?.length ? o.sourceLanguages : null,
    matteOutput: is("bg-remove-video") && model ? (o.matteOutputs ?? ["cutout"]) : null,
    colormap: is("depth-video") && model ? (o.colormaps ?? ["grayscale"]) : null,
    sideBySide: is("depth-video") && !!o.sideBySide,
    fps: o.fpsTargets?.length ? { values: o.fpsTargets, original: model?.defaults?.targetFps === undefined } : null,
    slowdown: many(o.slowdowns),
    formats: formats && formats.length > 0 ? formats : null,
  };
}

/**
 * Frames mode's settings: the strip has its own length control, frames and shots don't mix, and the open
 * chain makes one film (its clips are the jobs), so it has no batch count.
 */
export function framesShape(shape: SettingsShape, chained: boolean): SettingsShape {
  return { ...shape, duration: null, multiShot: false, count: shape.count && !chained };
}

/** Layout mode's settings: the boxes are compiled as drawn, so nothing rewrites the prompt (no Enhance). */
export function layoutShape(shape: SettingsShape): SettingsShape {
  return { ...shape, enhance: false };
}

export const MATTE_OUTPUT_LABELS: Record<MatteOutput, string> = { cutout: "Cutout video", matte: "Alpha mask", foreground: "Clean foreground" };
export const colormapLabel = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/**
 * What a Remove background or Depth map model can't make, said under its picker (Higgsfield offers five colour
 * maps and both outputs on one model; here they depend on the model and the engine).
 */
export function videoToolNote(model: Pick<ModelDef, "name" | "engine" | "options">, what: "matte" | "colormap"): string | null {
  const o = model.options;
  if (what === "matte") {
    const outs = o.matteOutputs ?? ["cutout"];
    if (outs.length > 1) return null;
    if (outs[0] === "cutout" && o.greenScreen) return `${model.name} makes the cut-out only — CorridorKey on your GPU also makes the mask and the clean foreground.`;
    if (outs[0] === "cutout") return `${model.name} makes the cut-out only — BiRefNet and SAM also make the alpha mask.`;
    return model.engine === "cloud"
      ? "Name what to keep and get its mask, or cut out the whole subject."
      : `${model.name} makes the alpha mask only.`;
  }
  const maps = o.colormaps ?? ["grayscale"];
  if (maps.length >= COLORMAPS.length) return null;
  if (model.engine === "open") {
    return maps.length > 1
      ? `${maps.map(colormapLabel).join(" and ")} work with open-source models. Turbo, Magma and Viridis need Cloud.`
      : `${model.name} draws grayscale only. Video Depth Anything adds Inferno; Turbo, Magma and Viridis need Cloud.`;
  }
  return `${model.name} draws ${maps.map(colormapLabel).join(", ")}.`;
}

/** The parts of the summary chip label, in reading order. */
export function settingsSummary(shape: SettingsShape, params: GenParams, model?: Pick<ModelDef, "options" | "defaults">): string[] {
  const parts: string[] = [];
  const d = model?.defaults ?? {};
  if (shape.aspect) {
    const ar = params.aspectRatio ?? d.aspectRatio ?? shape.aspect[0];
    parts.push(ar === "auto" ? "Auto" : ar);
  }
  if (shape.resolution) parts.push(params.resolution ?? d.resolution ?? shape.resolution[0]);
  if (params.shots?.length) parts.push(`${params.shots.length} shots`);
  else if (shape.duration) parts.push(durationLabel(params.duration ?? d.duration ?? shape.duration[0]));
  if (shape.count) parts.push(`×${params.numOutputs ?? 1}`);
  if (shape.multiShot && !params.shots && params.multiShot === "auto") parts.push("Multi-shot");
  if (shape.draft && params.draft) parts.push("Draft");
  if (shape.audio && params.generateAudio === false) parts.push("No audio");
  if (shape.fps) {
    const fps = params.targetFps ?? d.targetFps;
    if (fps) parts.push(`${fps} fps`);
    else if (!shape.fps.original) parts.push(`${shape.fps.values[0]} fps`);
  }
  if (shape.slowdown && (params.slowdown ?? 1) > 1) parts.push(`${params.slowdown}× slow`);
  if (shape.formats) {
    const f = formatOf(params, model, shape.formats);
    if (f) parts.push(FORMAT_INFO[f]?.short ?? f);
  }
  if (shape.enhance && params.enhancePrompt) parts.push("Enhance");
  // Detecting the language is the default, so only a picked one is worth a word.
  if (shape.sourceLanguages && params.sourceLanguage) parts.push(spokenLanguageName(params.sourceLanguage));
  if (shape.matteOutput) parts.push(MATTE_OUTPUT_LABELS[params.matteOutput && shape.matteOutput.includes(params.matteOutput) ? params.matteOutput : shape.matteOutput[0]]);
  if (shape.colormap) parts.push(colormapLabel(params.colormap ?? shape.colormap[0]));
  if (shape.sideBySide && params.sideBySide) parts.push("Side by side");
  return parts;
}

/**
 * Whether the composer shows the prompt box: not for a preset or model that takes no prompt; in a studio
 * that hides it, only for a model that reads an optional prompt when the studio words one (`modelPrompt`).
 */
export function showsPrompt(
  studio: { hidePrompt?: boolean; modelPrompt?: string },
  options: (Pick<ModelDef["options"], "promptless" | "promptOptional"> & { needsPrompt?: boolean }) | undefined,
  presetPrompt?: "none" | "optional" | "required",
): boolean {
  if (presetPrompt === "none" || options?.promptless) return false;
  // A model that needs words (requires.prompt: Open-H3 Regenerate) shows the box even in a tool that hides it.
  return !studio.hidePrompt || !!options?.needsPrompt || (!!studio.modelPrompt && !!options?.promptOptional);
}

/** The output format a request writes: the one picked, else the model's default or first, else the studio's first. */
export function formatOf(params: GenParams, model: Pick<ModelDef, "options" | "defaults"> | undefined, studio: VideoFormat[] = []): VideoFormat | undefined {
  return params.format ?? model?.defaults?.format ?? model?.options.formats?.[0] ?? studio[0];
}

// ---------------------------------------------------------------------------
// What a video tool makes of the attached clip (Upscale hub), from its header.

const clipSeconds = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}` : `${Math.round(n * 10) / 10} s`);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One line under the clip saying what comes out: "1280×720 → 3840×2160", "24 → 60 fps · 2× slow motion ·
 * 5 s → 10 s", "1920×1080 · 12 s → ProRes 422 HQ (.mov)". Null when the header told nothing (or the tool isn't one of these).
 */
export function clipOutcome(
  op: Operation | undefined,
  facts: { width?: number; height?: number; fps?: number; duration?: number } | undefined,
  params: GenParams,
  model: (Pick<ModelDef, "engine" | "options" | "defaults"> & Partial<Pick<ModelDef, "name" | "routes" | "pricing">>) | undefined,
  now?: PriceClock,
): string | null {
  if (!facts || !model) return null;
  const { width, height, fps, duration } = facts;
  const size = width && height ? `${width}×${height}` : "";
  const length = duration ? clipSeconds(duration) : "";
  // "LTX 2.3 HDR", not "LTX 2.3 HDR (EXR frames)".
  const name = model.name?.replace(/\s*\([^)]*\)$/, "");
  // The route's field-map rules (the browser's catalog keeps them as `preview`).
  const rules = (o: Operation) => {
    const r = model.routes?.find((x) => x.op === o);
    return r?.map ?? r?.preview;
  };
  if (op === "upscale-video") {
    if (!size) return null;
    const res = params.resolution ?? model.defaults?.resolution;
    const rate = params.targetFps ? ` · ${params.targetFps} fps` : "";
    if (res?.toLowerCase() === "original") return `${size}, cleaned up at its own size${rate}`;
    const short = Math.min(width!, height!);
    // A tier that wouldn't enlarge the clip: a default moves up (as the server does), a picked one is refused.
    const tier = upscaleTier(res, model.options.resolutions, { width: width!, height: height! }, params.resolution !== undefined);
    if ("error" in tier) return tier.error;
    const moved = tier.resolution !== res ? ` · ${tier.resolution}, as the clip is already ${short}p` : "";
    if (tier.resolution?.toLowerCase() === "original") return `${size}, cleaned up at its own size${moved}${rate}`;
    // An API that takes a factor keeps it within its range: say what that makes, not the tier.
    const range = rules("upscale-video")?.upscaleFactor;
    const target = targetShortEdge(tier.resolution);
    const factor = range ? upscaleFactorFor(tier.resolution, { width: width!, height: height! }, range.min, range.max) : undefined;
    const out = upscaledSize({ width: width!, height: height! }, tier.resolution, factor);
    if (!out) return null;
    const clamped = factor !== undefined && target ? Math.abs(factor - target / short) > 0.01 : false;
    const why = clamped ? ` (${name ?? "this model"} upscales ${factor! > target! / short ? "at least" : "at most"} ${factor}×)` : "";
    return `${size} → ${out.width}×${out.height}${why}${moved}${rate}`;
  }
  if (op === "interpolate") {
    const slowdown = Math.max(1, params.slowdown ?? 1);
    const longer = duration && slowdown > 1 ? ` · ${clipSeconds(duration)} → ${clipSeconds(duration * slowdown)}` : "";
    const target = params.targetFps ?? model.defaults?.targetFps;
    // A route with no frame-rate field (hosted RIFE) doubles the frames at the clip's speed.
    if (!model.options.fpsTargets?.length) return fps ? `Twice the frames: ${round2(fps)} → ${round2(fps * 2)} fps` : null;
    if (!target) return null;
    // The open engine reaches the target as source × m / n: say so when this clip's rate doesn't divide into it.
    if (model.engine === "open" && fps) {
      const plan = fpsPlan(fps, target, slowdown);
      if (!plan.exact) return `${round2(fps)} → about ${plan.fps} fps (the nearest this clip's rate allows)${slowdown > 1 ? ` · ${slowdown}× slow motion` : ""}${longer}`;
    }
    return `${fpsSummary(fps, target, slowdown)}${longer}`;
  }
  if (op === "sdr-to-hdr" || op === "export-video") {
    const f = formatOf(params, model);
    const info = f ? FORMAT_INFO[f] : undefined;
    const head = [size, length].filter(Boolean).join(" · ");
    if (!head) return null;
    // EXR frames: every frame of the clip, or what a frame-count route renders (LTX 2.3 HDR: 24 fps, 481 at most).
    let frames = "";
    const count = rules(op)?.numFrames;
    if (f === "exr" && duration && count) {
      const rate = params.fps && params.fps > 0 ? params.fps : count.fps;
      const want = duration * rate;
      const n = Math.round(Math.max(count.min ?? 1, Math.min(count.max ?? Infinity, want)));
      frames = ` (${n} frames at ${rate} fps${n < want - 0.5 ? `: only the first ${clipSeconds(n / rate)}, the most ${name ?? "it"} takes` : ""})`;
    } else if (f === "exr" && duration && fps) frames = ` (${Math.round(duration * fps)} frames)`;
    return info ? `${head} → ${info.short}${frames}, .${info.ext}` : head;
  }
  // An edit billed on the seconds in and out (Kling 4.0): what's billed, before the total.
  const billing = duration && model.engine === "cloud" ? clipBilling(model, { ...params, sourceDuration: duration }, op, now) : undefined;
  if (billing) {
    const twice = billing.billed > billing.input + billing.output + 1e-9 ? " (at least twice the output)" : "";
    return `${clipSeconds(billing.input)} in + ${clipSeconds(billing.output)} out: billed on ${clipSeconds(billing.billed)}${twice} at ${formatCost(billing.rate)}/s`;
  }
  return null;
}


/**
 * What the attached clip's header rules out before Generate, in the server's words: a clip edit outside the model's
 * window (Edit video: Happy Horse takes 3–15 s); a tier that wouldn't enlarge the clip (Upscale hub: one picked; a
 * default moves up), or an open tool that holds the whole clip (FPS Boost, SDR to HDR, EXR export) in more memory
 * than half the ComfyUI's RAM (`ramBytes`, when it said).
 */
export function clipBlocker(
  op: Operation | undefined,
  facts: { width?: number; height?: number; fps?: number; duration?: number } | undefined,
  params: GenParams,
  model: (Pick<ModelDef, "engine" | "options" | "defaults"> & Partial<Pick<ModelDef, "id" | "name">>) | undefined,
  ramBytes: number | undefined,
): string | null {
  // (A clip relit, extended or given a new moment on a hosted model with a window of its own: H3 Max relight up to 15 s.)
  if ((op === "v2v" || op === "relight-video" || op === "insert-moment" || op === "extend") && model?.id && (facts?.duration || facts?.width)) {
    const named = { id: model.id, name: model.name ?? model.id, engine: model.engine };
    return (
      (facts.duration ? clipWindowProblem(named, facts.duration, facts.fps) : null) ??
      (facts.width && facts.height ? clipSizeProblem(named, facts.width, facts.height) : null) ??
      (facts.fps ? clipFpsProblem(named, facts.fps) : null)
    );
  }
  const long = model && "name" in model && model.name ? sourceLengthProblem({ name: model.name, options: model.options }, facts?.duration) : null;
  if (long) return long;
  if (!facts?.width || !facts.height || !model) return null;
  if (op === "upscale-video") {
    const tier = upscaleTier(params.resolution ?? model.defaults?.resolution, model.options.resolutions, { width: facts.width, height: facts.height }, params.resolution !== undefined);
    if ("error" in tier) return tier.error;
    return sideMultipleProblem(model.name ?? "This model", model.options.sideMultiple, model.options.resolutions, tier.resolution, { width: facts.width, height: facts.height });
  }
  if (model.engine !== "open" || !ramBytes || !facts.duration || !facts.fps) return null;
  const target = params.targetFps ?? model.defaults?.targetFps;
  const m = op === "interpolate" && target ? fpsPlan(facts.fps, target, Math.max(1, params.slowdown ?? 1)).multiplier : 1;
  const tool = wholeClipTool(op, formatOf(params, model), m);
  return tool ? wholeClipProblem(tool, facts, ramBytes) : null;
}

/** How many settings differ from their defaults beyond what the summary shows (seed, negative prompt, sliders). */
export function hiddenChanges(params: GenParams, negativePrompt: string, model?: Pick<ModelDef, "options">): number {
  let n = 0;
  if (params.seed !== undefined) n++;
  if (negativePrompt.trim()) n++;
  for (const s of model?.options.sliders ?? []) {
    const v = params.extra?.[s.param];
    if (typeof v === "number" && v !== s.default) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Blockers ("Add a target photo")

const VOWEL = /^[aeiou]/i;
const DETERMINER = /^(your|the|a|an|some|any|my|this|that)\b/i;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Models that name their images (try-on: "person photo", then "garment") label the studio's image
 * slots in that order, and the next reference tile after the `refs` already added ("Add garment").
 * Same array when nothing changes.
 */
export function namedImageSlots(slots: InputSlot[], names: string[] | undefined, refLabel?: string, refs = 0): { slots: InputSlot[]; refLabel?: string } {
  if (!names?.length) return { slots, refLabel };
  let i = 0;
  const named = slots.map((s) => (s.accept === "image" && s.key !== "mask" && s.key !== "sketch" && names[i] ? { ...s, label: sentence(names[i++]) } : s));
  const next = names[i + refs];
  return { slots: i ? named : slots, refLabel: refLabel && next ? `Add ${next}` : refLabel };
}

/** "Target photo" → "Add a target photo"; "Your clip" → "Add your clip"; "Image" → "Add an image". */
export function slotMessage(label: string): string {
  const l = label.trim();
  // Keep acronyms ("SVG logo") and proper names as they are; lower-case an ordinary first word.
  const word = /^[A-Z][a-z]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l;
  if (DETERMINER.test(word)) return `Add ${word}`;
  const head = word.split(/\s+/)[0];
  // Plurals ("Photos", "Clips") read better without an article.
  if (/[^s]s$/i.test(head) && !/(us|is|ss)$/i.test(head) && head.length > 3 && !word.includes(" ")) return `Add ${word}`;
  return `Add ${VOWEL.test(word) ? "an" : "a"} ${word}`;
}

const GENERIC_NOUN = /^(photo|image|picture|frame|clip|video|file|shot)s?$/i;

/**
 * A filled tile's caption, in the slot's own words without the generic noun the thumbnail already
 * shows: "Target photo" → "Target", "Start frame" → "Start", "Face" → "Face". Labels that would
 * lose their meaning ("Your clip", "Image") stay whole.
 */
export function slotCaption(label: string): string {
  const words = label.trim().split(/\s+/);
  if (words.length > 1 && GENERIC_NOUN.test(words[words.length - 1]) && !DETERMINER.test(words[0])) return words.slice(0, -1).join(" ");
  return words.join(" ");
}

type SlotValues = Partial<Record<InputSlot["key"], { ref: string; uploading?: boolean } | null>>;

/** A missing input: one required slot, or (`group`) a set of optional slots of which one is needed ("a portrait or a video"). */
export type MissingSlot = InputSlot & { group?: InputSlot[] };

/**
 * The first input Generate is waiting for, in the order the tiles are shown: an empty required
 * slot, or a group from `anyOf` (studio config: "one of these") with none of its slots filled.
 * A group comes back as its first slot plus `group`, so Generate pulses that tile.
 */
export function firstMissingSlot(slots: InputSlot[], values: SlotValues, anyOf: InputSlot["key"][][] = []): MissingSlot | undefined {
  const filled = (k: InputSlot["key"]) => !!values[k]?.ref || !!values[k]?.uploading;
  const groups = anyOf.map((g) => slots.filter((s) => g.includes(s.key))).filter((g) => g.length > 0);
  for (const s of slots) {
    if (s.required && !filled(s.key)) return s;
    const group = groups.find((g) => g[0].key === s.key);
    if (group && !group.some((x) => filled(x.key))) return group.length > 1 ? { ...s, group } : s;
  }
  return undefined;
}

/** ["a portrait", "a video"] → "a portrait or a video"; three → "a, b or c". */
const orList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** "Add a portrait or a video" for a group, else the slot's own message. */
export function missingMessage(m: MissingSlot): string {
  if (!m.group || m.group.length < 2) return slotMessage(m.label);
  return `Add ${orList(m.group.map((s) => slotMessage(s.label).replace(/^Add /, "")))}`;
}

export const WRITE_PROMPT = "Write a prompt first";

export interface Blocker {
  message: string;
  /** The attachment to point at (pulse) when Generate is pressed ("mask": the Paint area tile; "frames": Frames mode's Add frame tile). */
  slot?: InputSlot["key"] | "frames";
  /** Passes by itself or is plain to see (loading, uploading, the empty prompt box): never spelled out under the composer. */
  quiet?: boolean;
}

/**
 * Whether Generate is waiting for a painted area: the studio offers the mask brush, its image is
 * in (or uploading), nothing is painted yet, and the model only changes a picture through a mask
 * (FLUX Fill: an inpaint route and no instruction edit to fall back on). The planner's own message
 * names both inputs ("Add an image and paint the area to change"), which reads wrong with the image
 * right there, and comes after its prompt check, though Inpaint asks for the painting first.
 */
export function needsMask(model: Pick<ModelDef, "routes"> | undefined, sketch: ("mask" | "draw")[] | undefined, slots: SlotValues): boolean {
  if (!model || !sketch?.includes("mask")) return false;
  const image = slots.image;
  if (!image?.ref && !image?.uploading) return false;
  if (slots.mask?.ref) return false;
  const ops = new Set(model.routes.map((r) => r.op));
  return ops.has("inpaint") && !ops.has("edit");
}

/**
 * What stops Generate, most actionable first: missing model, missing attachment (named with the
 * studio's own slot label, not the planner's generic message), uploads in flight, the area to
 * paint (needsMask), then whatever the planner says (prompt, voice, language…).
 */
export function blockerFor(s: {
  loading?: string | null;
  model: boolean;
  engineError?: string | null;
  missing?: MissingSlot;
  /** Frames mode: the start frame to add, or a model that can't follow frames (framesBlocker in catalog/keyframes.ts). */
  frames?: Blocker | null;
  uploading: boolean;
  /** A voice slot's "Clean up voice" is still running: the run waits for the clean file. */
  cleaning?: boolean;
  maskMissing?: boolean;
  planError?: string | null;
  promptMissing: boolean;
}): Blocker | null {
  if (s.loading) return { message: s.loading, quiet: true };
  if (!s.model) return { message: "Pick a model" };
  if (s.engineError) return { message: s.engineError };
  if (s.frames) return s.frames;
  if (s.missing) return { message: missingMessage(s.missing), slot: s.missing.key };
  if (s.uploading) return { message: "Uploading…", quiet: true };
  if (s.cleaning) return { message: "Waiting for the clean voice", quiet: true };
  if (s.maskMissing) return { message: "Paint the area to change", slot: "mask" };
  // The planner says "Write a prompt first" too (an empty prompt on a model that needs one): as quiet as the composer's own.
  if (s.planError) return s.planError === WRITE_PROMPT ? { message: WRITE_PROMPT, quiet: true } : { message: s.planError };
  if (s.promptMissing) return { message: WRITE_PROMPT, quiet: true };
  return null;
}

/**
 * Where the composer spells its blocker out in a line under the toolbar ("Add a target photo",
 * which opens that tile when tapped): wherever the tiles it points at are folded away (docked and
 * collapsed: "always"), else only where the Generate button's tooltip can't be seen (no hover:
 * phones and tablets, "touch", which the page decides with a media query so the server's HTML is
 * the same). Never for a quiet blocker.
 */
export function blockerLine(b: Blocker | null, collapsed: boolean): "always" | "touch" | null {
  if (!b || b.quiet) return null;
  return collapsed ? "always" : "touch";
}

/**
 * Whether the composer shows a prompt box (and the studio its prompt suggestions): not when the
 * studio or app has none, nor for a model that takes no prompt (try-on, upscalers, 3D, transcription).
 */
export function promptShown(hidePrompt: boolean | undefined, userPrompt: Preset["userPrompt"] | undefined, promptless: boolean | undefined): boolean {
  return !hidePrompt && userPrompt !== "none" && !promptless;
}

/** Placeholder refs for empty required slots, so cost and plan can be computed before anything is attached. */
export const PLACEHOLDER: Record<MediaKind, string> = {
  image: "/api/files/placeholder.png",
  video: "/api/files/placeholder.mp4",
  audio: "/api/files/placeholder.wav",
  text: "/api/files/placeholder.txt",
  model3d: "/api/files/placeholder.glb",
};

// ---------------------------------------------------------------------------
// Attachments: where a pasted / dropped / uploaded file goes

export interface Attachment {
  id?: string;
  ref: string;
  preview: string;
  kind: MediaKind;
  name?: string;
  uploading?: boolean;
}

export interface AttachState {
  slots: Partial<Record<InputSlot["key"], Attachment | null>>;
  refs: Attachment[];
}

/**
 * Put a new attachment somewhere sensible: the first empty slot of its kind, else the reference
 * list (when the studio takes references of that kind and has room), else replace the first slot
 * of its kind. Returns null when the studio can't take it.
 */
export function placeAttachment<T extends Attachment>(
  state: { slots: Partial<Record<InputSlot["key"], T | null>>; refs: T[] },
  slots: InputSlot[],
  multiRef: { kind?: MediaKind } | undefined,
  refMax: number,
  v: T,
): { slots?: Partial<Record<InputSlot["key"], T | null>>; refs?: T[] } | null {
  const fits = slots.filter((s) => s.accept === v.kind && s.key !== "mask" && s.key !== "sketch");
  const empty = fits.find((s) => !state.slots[s.key]);
  if (empty) return { slots: { ...state.slots, [empty.key]: v } };
  if (multiRef && (multiRef.kind ?? "image") === v.kind && state.refs.length < refMax) return { refs: [...state.refs, v] };
  if (fits[0]) return { slots: { ...state.slots, [fits[0].key]: v } };
  return null;
}

/**
 * Swap an in-flight upload for its result (or drop it on failure), by id. If the user removed or
 * replaced it meanwhile, nothing changes: a finished upload never brings a removed item back.
 */
export function replaceAttachment<T extends Attachment>(
  state: { slots: Partial<Record<InputSlot["key"], T | null>>; refs: T[]; frames?: FrameAttachment<T>[]; refClips?: T[]; refAudios?: T[] },
  id: string,
  v: T | null,
): { slots?: Partial<Record<InputSlot["key"], T | null>>; refs?: T[]; frames?: FrameAttachment<T>[]; refClips?: T[]; refAudios?: T[] } | null {
  for (const [k, s] of Object.entries(state.slots) as [InputSlot["key"], T | null][]) {
    if (s?.id === id) return { slots: { ...state.slots, [k]: v ? { ...v, id } : null } };
  }
  if (state.refs.some((r) => r.id === id)) {
    return { refs: v ? state.refs.map((r) => (r.id === id ? { ...v, id } : r)) : state.refs.filter((r) => r.id !== id) };
  }
  // References mode's clips and voice or music clips (Pika H3 Flex) keep their order.
  for (const list of ["refClips", "refAudios"] as const) {
    const items = state[list];
    if (items?.some((r) => r.id === id)) return { [list]: v ? items.map((r) => (r.id === id ? { ...v, id } : r)) : items.filter((r) => r.id !== id) };
  }
  // A frame keeps its place in the clip when its upload finishes; a failed one leaves the strip.
  const f = state.frames?.findIndex((x) => x.value.id === id) ?? -1;
  if (f >= 0) return { frames: v ? state.frames!.map((x, i) => (i === f ? { ...x, value: { ...v, id } } : x)) : removeFrame(state.frames!, f) };
  return null;
}

// ---------------------------------------------------------------------------
// Frames mode (Video studio): up to 10 stills, each at its own place in the clip

/** A frame: its still, and where it sits in the clip (0 = the start, 1 = the end; see src/lib/catalog/keyframes.ts). */
export interface FrameAttachment<T extends Attachment = Attachment> {
  value: T;
  at: number;
}

/** One more frame at the end (evenly spaced frames stay evenly spaced, placed ones keep their places). */
export function addFrame<T extends Attachment>(frames: FrameAttachment<T>[], value: T): FrameAttachment<T>[] {
  const ats = addFrameAt(frames.map((f) => f.at));
  return [...frames, { value, at: 1 }].map((f, i) => ({ ...f, at: ats[i] }));
}

/** Frame i taken out; the next one becomes the start frame when the first goes. */
export function removeFrame<T extends Attachment>(frames: FrameAttachment<T>[], i: number): FrameAttachment<T>[] {
  const ats = removeFrameAt(frames.map((f) => f.at), i);
  return frames.filter((_, j) => j !== i).map((f, j) => ({ ...f, at: ats[j] }));
}

/** Frames mode on: the start and end frames already attached become the first frames (a drawing on the start frame goes). */
export function enterFrames<T extends Attachment>(slots: Partial<Record<InputSlot["key"], T | null>>): { frames: FrameAttachment<T>[]; slots: Partial<Record<InputSlot["key"], T | null>> } {
  const values = [slots.image, slots.endImage].filter((v): v is T => !!v);
  const ats = spread(values.length);
  return { frames: values.map((value, i) => ({ value, at: ats[i] })), slots: { ...slots, image: null, endImage: null, mask: null, sketch: null } };
}

/**
 * What Frames mode sends: the stills in order at their times (or the first and last as start and end
 * frame, as the model takes them), at the strip's length. Every frame at its time is a keyframes run
 * (`op`, so a camera motion preset's own operation doesn't replace it). A frame still uploading has no
 * ref yet and is left out here, so the composer holds Generate ("Uploading…") until every frame is in.
 */
export function framesRequest(
  frames: FrameAttachment[],
  ctx: { support: FrameSupport; duration: number; chained: boolean; animation?: { timing: InbetweenTiming } },
): { op?: "keyframes"; images: string[]; endImage?: string; params: Pick<GenParams, "duration" | "keyframeTimes" | "shots" | "multiShot" | "numOutputs"> } {
  // Keyframe animation (Fuobe Animation): the keyframes sit where their gaps' timing puts them, and the film is as long as the gaps.
  if (ctx.animation) {
    const times = keyTimes(ctx.animation.timing);
    const refs = frames.map((f) => f.value.ref).filter((r): r is string => !!r);
    const whole = refs.length === frames.length;
    return {
      op: "keyframes",
      images: refs,
      params: { duration: Math.max(1, Math.ceil(totalSeconds(ctx.animation.timing))), keyframeTimes: whole ? times : undefined, shots: undefined, multiShot: undefined, numOutputs: 1 },
    };
  }
  const times = frameTimes(frames.map((f) => f.at), ctx.duration);
  const kept = frames.map((f, i) => ({ ref: f.value.ref, time: times[i] })).filter((f) => !!f.ref);
  const sent = framesInputs(kept.map((f) => f.ref), kept.map((f) => f.time), ctx.support);
  // Frames and shots don't mix; the open chain makes one film (its clips are the jobs).
  return {
    ...(sent.keyframeTimes && { op: "keyframes" as const }),
    images: sent.images ?? [],
    endImage: sent.endImage,
    params: { duration: ctx.duration, keyframeTimes: sent.keyframeTimes, shots: undefined, multiShot: undefined, ...(ctx.chained && { numOutputs: 1 }) },
  };
}

/** Frames mode has its own strip: the studio's start and end frame tiles (a camera motion's too) aren't asked for. */
export const framesSlots = <S extends Pick<InputSlot, "key">>(slots: S[]): S[] => slots.filter((s) => s.key !== "image" && s.key !== "endImage");

/** Frames still uploading: Generate waits for them, as it does for any other attachment. */
export const framesUploading = (frames: FrameAttachment[] | undefined): boolean => !!frames?.some((f) => f.value.uploading);

/**
 * Frames mode off: the first frame is the start frame again and the last (with two or more) the end
 * frame. `dropped` counts the frames in between that have no slot to go to (the composer offers Undo).
 */
export function leaveFrames<T extends Attachment>(frames: FrameAttachment<T>[], slots: Partial<Record<InputSlot["key"], T | null>>): { slots: Partial<Record<InputSlot["key"], T | null>>; dropped: number } {
  const end = frames.length > 1 ? frames[frames.length - 1].value : null;
  return { slots: { ...slots, image: frames[0]?.value ?? null, endImage: end, mask: null, sketch: null }, dropped: Math.max(0, frames.length - 2) };
}

// ---------------------------------------------------------------------------
// Layout mode (Image studio): boxes on the picture, one row per box (src/lib/layout-prompt.ts)

/**
 * Layout mode on: an empty layout on the picture's shape (the aspect ratio picked, else the model's). The prompt stays
 * as it is: in Layout mode it is the whole picture's caption.
 */
export function enterLayout(params: GenParams, model?: Pick<ModelDef, "defaults">): LayoutDraft {
  const aspect = params.aspectRatio ?? model?.defaults?.aspectRatio;
  return { summary: { caption: "", meta: [], canvas: "single" }, items: [], ...(aspect && aspect !== "auto" && { aspect }) };
}

/**
 * What Layout mode sends: the prompt as written, and the layout as params.extra.layout with the prompt as its caption,
 * on the shape it is drawn on. The plan compiles it for the model at the size it renders (src/lib/catalog/plan.ts
 * planLayout) and turns prompt rewriting off; the request keeps the draft for Reuse and Edit layout.
 */
export function layoutRequest(layout: LayoutDraft, prompt: string, params: GenParams): { prompt: string; params: GenParams } {
  const aspect = params.aspectRatio && params.aspectRatio !== "auto" ? params.aspectRatio : layout.aspect;
  const draft: LayoutDraft = { ...layout, summary: { ...layout.summary, caption: prompt.trim() }, ...(aspect && { aspect }) };
  return { prompt, params: { ...params, extra: { ...params.extra, [LAYOUT_PARAM]: draft } } };
}

/**
 * Layout mode off: the boxes go (`dropped` counts them, so the composer offers Undo) and any layout the params still
 * carry with them; the prompt stays as written.
 */
export function leaveLayout(layout: LayoutDraft | undefined, params: GenParams): { params: GenParams; dropped: number } {
  return { params: withoutLayout(params).params, dropped: layout?.items.length ?? 0 };
}

/**
 * A request's params with its layout taken out (Reuse, Edit layout): the layout goes back to Layout mode, the rest to
 * the settings. `layout` is undefined when there was none (or it can't be read).
 */
export function withoutLayout(params: GenParams): { params: GenParams; layout?: LayoutDraft } {
  if (!params.extra || !(LAYOUT_PARAM in params.extra)) return { params };
  const extra = { ...params.extra };
  const layout = readLayout(extra[LAYOUT_PARAM]) ?? undefined;
  delete extra[LAYOUT_PARAM];
  return { params: { ...params, extra: Object.keys(extra).length ? extra : undefined }, ...(layout && { layout }) };
}

/** The one line under the boxes for a model that doesn't place them by their coordinates (none for one that does). */
export function layoutModelNote(model: Pick<ModelDef, "options"> | undefined): string | null {
  return !model || readsBoxes(model) ? null : "This model reads the layout as words, not exact positions.";
}

/**
 * The warning when the picture asked for is past what box-reading models were made for (2048 px a side, 4 MP): said
 * with the size the model renders instead, when it scales it down (the boxes keep their places), else that the boxes
 * may drift. Null when the size is within range.
 */
export function layoutSizeWarning(canvas: { width: number; height: number; asked: { width: number; height: number }; exact: boolean }, modelName: string): string | null {
  const { asked } = canvas;
  if (Math.max(asked.width, asked.height) <= LAYOUT_MAX_SIDE && asked.width * asked.height <= LAYOUT_MAX_PIXELS) return null;
  const size = `${canvas.exact ? "" : "about "}${asked.width} × ${asked.height}`;
  const scaled = canvas.width !== asked.width || canvas.height !== asked.height;
  return scaled
    ? `${size} is past ${LAYOUT_MAX_SIDE} px a side, so ${modelName} renders ${canvas.width} × ${canvas.height}; the boxes keep their places`
    : `${size} is past ${LAYOUT_MAX_SIDE} px a side or 4 megapixels: ${modelName} may place the boxes less exactly`;
}

/**
 * The lines under the Layout strip: a model that reads the layout as words says so (its boxes are never placed by
 * position, so it gets no size warning); a box reader past its range gets the size warning.
 */
export function layoutNotes(
  model: Pick<ModelDef, "options" | "name"> | undefined,
  canvas: Parameters<typeof layoutSizeWarning>[0] | undefined,
): { text: string; tone: "info" | "warn" }[] {
  if (!model) return [];
  const words = layoutModelNote(model);
  if (words) return [{ text: words, tone: "info" }];
  const big = canvas && layoutSizeWarning(canvas, model.name);
  return big ? [{ text: big, tone: "warn" }] : [];
}

/** The box reader the words-model line offers instead ("Use MOSS-Image"): only when Settings → Models & licences offers it. */
export function layoutBoxModel(
  model: Pick<ModelDef, "id" | "options" | "engine"> | undefined,
  pick: { id: string; getModel: (id: string) => ModelDef | undefined; offered: (id: string, engine?: Engine) => boolean },
): ModelDef | undefined {
  if (!model || !layoutModelNote(model) || !pick.offered(pick.id, model.engine)) return undefined;
  const m = pick.getModel(pick.id);
  return m && m.id !== model.id ? m : undefined;
}

/**
 * Where a batch of files would land, before any of them uploads: each file's index goes to
 * `placed` (it gets a slot or a reference tile) or `rejected` (no room: the references are full or
 * the model takes none). Placement is simulated in order, as `placeAttachment` does it for real.
 */
export function fitAttachments(
  state: AttachState,
  slots: InputSlot[],
  multiRef: { kind?: MediaKind } | undefined,
  refMax: number,
  kinds: MediaKind[],
): { placed: number[]; rejected: number[] } {
  let s = state;
  const placed: number[] = [];
  const rejected: number[] = [];
  kinds.forEach((kind, i) => {
    const next = placeAttachment(s, slots, multiRef, refMax, { id: `fit-${i}`, ref: "", preview: "", kind });
    if (!next) return void rejected.push(i);
    placed.push(i);
    s = { slots: next.slots ?? s.slots, refs: next.refs ?? s.refs };
  });
  return { placed, rejected };
}

/** What to tell someone whose attachment found no room ("This model takes up to 3 reference images"). */
export function noRoomMessage(refMax: number, kind: MediaKind = "image"): string {
  const noun = kind === "video" ? "clip" : kind === "audio" ? "audio file" : "reference image";
  if (refMax <= 0) return `This model doesn't take ${noun}s — pick another model to add one`;
  return `This model takes up to ${refMax} ${noun}${refMax === 1 ? "" : "s"}`;
}

/**
 * A drawing (inpaint mask, sketch, Wan-Move motion paths) belongs to the image it was drawn on:
 * when the image slot gets another image, or none, the drawing goes with it. Returns the patch
 * to apply with the new slots (the same slots when the image didn't change, e.g. its upload finished).
 */
export function onImageChange<T extends Attachment>(
  prev: { slots: Partial<Record<InputSlot["key"], T | null>>; params: GenParams },
  nextSlots: Partial<Record<InputSlot["key"], T | null>>,
): { slots: Partial<Record<InputSlot["key"], T | null>>; params?: GenParams } {
  const before = prev.slots.image ?? null;
  const after = nextSlots.image ?? null;
  const same = before === after || (!!before && !!after && ((!!before.id && before.id === after.id) || (!!before.ref && before.ref === after.ref)));
  if (same) return { slots: nextSlots };
  const slots = { ...nextSlots, mask: null, sketch: null };
  if (prev.params.extra?.motionPaths === undefined) return { slots };
  const extra = { ...prev.params.extra };
  delete extra.motionPaths;
  return { slots, params: { ...prev.params, extra: Object.keys(extra).length ? extra : undefined } };
}

/** Which kinds the "+" menu (and paste / drop) can take for this studio. Voice samples have their own picker. */
export function acceptedKinds(slots: InputSlot[], multiRef?: { kind?: MediaKind }): MediaKind[] {
  const kinds = new Set<MediaKind>(slots.filter((s) => s.key !== "mask" && s.key !== "sketch" && s.key !== "voiceAudio" && s.key !== "voiceAudio2").map((s) => s.accept));
  if (multiRef) kinds.add(multiRef.kind ?? "image");
  return [...kinds];
}

// ---------------------------------------------------------------------------
// Hand-off params ("/video?image=…") arriving after the first paint

/** The URL params a studio prefills its draft from; anything else in the query is ignored. */
export const HANDOFF_PARAMS = ["image", "ref", "video", "audio", "prompt", "preset", "model", "format", "resolution", "frames"] as const;

/** Most frames a hand-off opens Frames mode with ("/video?frames=a,b,c": Storyboard's panels, a Character Sheet's poses). */
export const HANDOFF_FRAMES = 10;
/** The stills a "frames" hand-off names, in order (file URLs, comma-separated). */
export const handoffFrames = (v: string | null | undefined): string[] =>
  (v ?? "").split(",").map((x) => x.trim()).filter((x) => /^(\/api\/files\/|https:\/\/)/.test(x)).slice(0, HANDOFF_FRAMES);

/** A stable key for the hand-off part of a query string ("" when there's none). */
export function handoffKey(search: string | URLSearchParams | null | undefined): string {
  const sp = typeof search === "string" || !search ? new URLSearchParams(search ?? "") : search;
  const out = new URLSearchParams();
  for (const k of HANDOFF_PARAMS) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export interface DraftShape {
  prompt: string;
  negativePrompt: string;
  modelId: string;
  params: GenParams;
  slots: Partial<Record<InputSlot["key"], Attachment | null>>;
  refs: Attachment[];
  presetId?: string;
  presetOptions: Record<string, string>;
  presetStrength?: number;
  mix?: { presetId: string; strength: number };
  /** Frames mode's stills (Video studio). */
  frames?: FrameAttachment[];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameAttachment = (a: Attachment | null | undefined, b: Attachment | null | undefined) => (a ?? null) === (b ?? null) || (!!a && !!b && a.id === b.id && a.ref === b.ref);

type PresetRoutes = RecipePreset;

const isMove = (preset: PresetRoutes | undefined): preset is PresetRoutes => preset?.type === "motion" || preset?.type === "effect";

/**
 * The route a camera motion or effect runs on by default on an engine: the one its preview was made with (MiniMax H3)
 * when the viewer's catalog has its model (`has`), else its own (Fuobe DoP, or the route its move names: a camera LoRA
 * in the cloud runs on Fuobe DoP · LTX; a move with nothing of the Original's own in the cloud keeps its partner model
 * there). Undefined for apps and without a preset.
 */
function moveRoute(preset: PresetRoutes | undefined, engine: Engine, has: HasModel): PresetRoute | undefined {
  return isMove(preset) ? presetRoutes(preset, engine, has)[0] : undefined;
}

/** The model a camera motion or effect runs on by default on an engine (moveRoute). Undefined for apps and without a preset. */
export function presetModel(preset: PresetRoutes | undefined, engine: Engine, has: HasModel): string | undefined {
  return moveRoute(preset, engine, has)?.modelId;
}

/**
 * The model a camera motion or effect moves the composer to when it is picked or linked: its recipe's (MiniMax H3),
 * else its Original (Fuobe DoP on this engine). Never a partner route (a move Fuobe DoP has nothing of its own for in
 * the cloud): the person's model stays.
 */
export function presetOriginal(preset: PresetRoutes | undefined, engine: Engine, has: HasModel): string | undefined {
  const route = moveRoute(preset, engine, has);
  return route && !route.partner ? route.modelId : undefined;
}

/**
 * The settings a preset's route starts the composer with on its model (Focus Change: 6 s, 720p, silent; a recipe on H3:
 * 5 s at the Quality its cover was made at), over the model's defaults. Only values the composer shows: the route's other
 * extras (a camera LoRA, a pose, the orbit) stay the preset's, so the next preset picked on the same model doesn't inherit
 * them. The planner adds them to the run.
 */
export function presetParams(preset: PresetRoutes | undefined, engine: Engine, has: HasModel): GenParams {
  return routeParams(moveRoute(preset, engine, has), "motion");
}

/**
 * The settings a preset's route starts the composer with: an app's route's as they are (they are its own); a camera
 * motion's or effect's plain ones and its Quality (presetParams).
 */
export function routeParams(route: Pick<PresetRoute, "params"> | undefined, type: Preset["type"]): GenParams {
  if (type === "app") return { ...route?.params };
  const plain: GenParams = { ...route?.params };
  const quality = route?.params?.extra?.quality;
  delete plain.extra;
  return quality === undefined ? plain : { ...plain, extra: { quality } };
}

/**
 * A route's settings over a draft that is already on the route's model: each setting still at the model's default takes
 * the route's value (a linked preset that loads after the first draft: Whip Pan at Best, 360 Orbit at 3 s). A setting
 * the person changed stays. Undefined when nothing changes.
 */
export function untouchedParams(params: GenParams, defaults: GenParams, route: GenParams): GenParams | undefined {
  const next: Record<string, unknown> = { ...params };
  let changed = false;
  for (const [k, v] of Object.entries(route)) {
    if (k === "extra") continue;
    const now = (params as Record<string, unknown>)[k];
    if (same(now, (defaults as Record<string, unknown>)[k]) && !same(now, v)) {
      next[k] = v;
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(route.extra ?? {})) {
    const now = params.extra?.[k];
    if (same(now, defaults.extra?.[k]) && !same(now, v)) {
      next.extra = { ...(next.extra as GenParams["extra"]), [k]: v };
      changed = true;
    }
  }
  return changed ? (next as GenParams) : undefined;
}

/** An app's route for a model on an engine (its recipe's or its own), if the app runs on that model there. */
export function appRoute(preset: PresetRoutes | undefined, engine: Engine, modelId: string, has: HasModel): PresetRoute | undefined {
  return preset?.type === "app" ? presetRoutes(preset, engine, has).find((r) => r.modelId === modelId) : undefined;
}

/**
 * Where the composer goes when the viewer can't run the route a preset opens on (its recipe: a Replicate-only account and
 * hosted MiniMax H3, which is on fal alone; a model switched off in Settings → Models & licences): the first of the
 * preset's other routes on this engine the viewer can run (`runs`). Undefined when the composer isn't on the first
 * route's model, the viewer can run it, or no other route runs for them (Generate then says what is missing).
 */
export function presetFallback(preset: PresetRoutes | undefined, engine: Engine, modelId: string | undefined, has: HasModel, runs: HasModel): PresetRoute | undefined {
  if (!preset || !modelId) return undefined;
  const routes = presetRoutes(preset, engine, has);
  if (routes.length < 2 || routes[0].modelId !== modelId || runs(modelId)) return undefined;
  return routes.slice(1).find((r) => r.modelId !== modelId && runs(r.modelId));
}

/**
 * Whether the server writes Ideogram 4's JSON caption for this viewer (src/server/enhance.ts ideogramCaption): with the
 * install's own local model, never Claude. An account's or a guest's run never uses the install's LLM, and an install whose
 * local model doesn't answer has none; then Ideogram 4 gets the words as they are, and its safety filter answers about half
 * the pictures of people with a grey card. Undefined while the status loads.
 */
export function writesCaptions(status: { viewer?: unknown; llm?: { helper: string; local: unknown } } | undefined): boolean | undefined {
  if (!status) return undefined;
  return !status.viewer && !!status.llm && status.llm.helper !== "none" && !!status.llm.local;
}

/**
 * A studio's defaults as this viewer runs them: where the server can't write the default's caption (writesCaptions false),
 * the stand-in the studio names for it (StudioConfig.uncaptioned: the Image studio's Qwen-Image 2.1 for Ideogram 4).
 */
export function viewerDefaults<D extends { cloud: string; open: string }>(defaults: D, uncaptioned: Partial<D> | undefined, writes: boolean | undefined): D {
  return writes === false && uncaptioned ? { ...defaults, ...uncaptioned } : defaults;
}

/**
 * What the engine switch (or a model change) does to the composer's model: the model id to move to, or undefined to
 * keep it. An app runs only on its own models for the engine (its recipe's, then its route's): any other model, even
 * one that also runs on this engine (Fuobe Soul, AI Influencer's cloud model), gives way to the first. A model that
 * doesn't run on the engine gives way to the preset's model there, else the studio's default. A camera motion or effect
 * on a model of the other engine follows its move to this one's (MiniMax H3 hosted → on the GPU; Jib Up: Fuobe DoP on
 * the GPU, Fuobe DoP · LTX in the cloud), but only when the engine has just changed: the sibling model picked on purpose
 * on the same engine stays.
 */
export function engineSwitchModel(o: {
  model: Pick<ModelDef, "id" | "engine">;
  preset: PresetRoutes | undefined;
  engine: Engine;
  /** The engine the composer was on before (the same one when only the model changed). */
  from: Engine;
  defaults: Partial<Record<Engine, string>>;
  has: HasModel;
}): string | undefined {
  const { model, preset, engine, has } = o;
  if (preset?.type === "app") {
    const ids = appModels(preset, engine, has);
    return ids.includes(model.id) || !ids.length ? undefined : ids[0];
  }
  const otherEngine: Engine = engine === "open" ? "cloud" : "open";
  const want = presetModel(preset, engine, has);
  // The same choice on the other engine (the recipe's model, or the move's own route's) moves to its sibling here.
  let follows: string | undefined;
  if (isMove(preset) && o.from !== engine) {
    const mine = presetRoutes(preset, engine, has);
    const theirs = presetRoutes(preset, otherEngine, has);
    const i = theirs.findIndex((r) => r.modelId === model.id);
    const sibling = i >= 0 ? (mine[i]?.modelId ?? want) : undefined;
    if (sibling && sibling !== model.id) follows = sibling;
  }
  if (follows) return follows;
  if (model.engine === engine) return undefined;
  return want ?? o.defaults[engine];
}

/**
 * The settings an Original takes on another engine (Fuobe DoP: 480p on the GPU, 720p in the cloud): each one whose
 * default differs there moves to the new default when the person left it at the old one. Undefined when nothing moves.
 */
export function followEngineParams(params: GenParams, from: GenParams, to: GenParams): GenParams | undefined {
  const keys = (Object.keys({ ...from, ...to }) as (keyof GenParams)[]).filter((k) => k !== "extra" && !same(from[k], to[k]));
  const moved = keys.filter((k) => params[k] === undefined || same(params[k], from[k]));
  if (!moved.length) return undefined;
  return { ...params, ...Object.fromEntries(moved.map((k) => [k, to[k]])) };
}

/**
 * A step after the run that costs on its own: Fuobe Soul's PixeletedFace look pixelates each picture's faces (SAM 3.1:
 * free on the GPU, fal's per-request price in the cloud), one step per picture.
 */
export function postStepCost(
  modelId: string | undefined,
  look: string | undefined,
  engine: Engine,
  pictures: number,
  getModel: (id: string) => ModelDef | undefined,
  now?: PriceClock,
): number {
  if (!modelId || soulPostStep(modelId, look) !== "face-mosaic") return 0;
  const step = getModel(FACE_MOSAIC_MODELS[engine]);
  const price = step?.engine === "cloud" && step.pricing ? pricingOn(step.pricing, now) : undefined;
  return price?.unit === "request" ? price.usd * Math.max(1, pictures) : 0;
}

/**
 * What a step before the clip adds to its price (Fuobe DoP relights a start frame first), when the run is on the
 * preset's own model: a partner model runs the effect's words alone.
 */
export function prestepCost(preset: Pick<Preset, "type" | "open" | "cloud" | "prestep"> | undefined, modelId: string | undefined, engine: Engine): number {
  // A preset with a step has no recipe: its own route is the one that runs the step.
  if (!preset?.prestep || !modelId || ownRoute(preset, engine)?.modelId !== modelId) return 0;
  return preset.prestep[engine].usd ?? 0;
}

/**
 * The draft a hand-off compares with, after the page's own model swap: the engine is read after hydration (or
 * switched while the page loads), and the composer swaps an untouched draft's studio default for that engine's
 * default (or that default's stand-in where the server writes no caption: `standIns`, the studio's uncaptioned). That
 * swap isn't the person's pick, so the base follows it and the hand-off's model (?model=) still applies; without this, a
 * link opened on the open engine kept the open default (Z-Image Turbo), or the stand-in (Qwen-Image 2.1).
 */
export function followEngineDefault<D extends DraftShape>(
  base: D,
  current: D,
  defaults: Partial<Record<Engine, string>>,
  engine: Engine,
  standIns: Partial<Record<Engine, string>> = {},
): D {
  const own = Object.values(defaults).filter(Boolean);
  const swapped = current.modelId === defaults[engine] || (!!standIns[engine] && current.modelId === standIns[engine]);
  if (current.modelId === base.modelId || !own.includes(base.modelId) || !swapped) return base;
  return { ...base, modelId: current.modelId, params: current.params };
}

/**
 * Apply a draft computed from hand-off params (`next`) to the live draft (`current`) without
 * undoing what the person already did: a field still equal to the draft the composer started
 * with (`base`) takes the hand-off value; a field they changed (typed a prompt before the page
 * hydrated, attached a photo) keeps theirs. Returns the patch.
 */
export function mergeHandoff<D extends DraftShape>(base: D, current: D, next: D): Partial<D> {
  const patch: Partial<D> = {};
  if (current.prompt === base.prompt && current.prompt !== next.prompt) patch.prompt = next.prompt;
  if (current.negativePrompt === base.negativePrompt && current.negativePrompt !== next.negativePrompt) patch.negativePrompt = next.negativePrompt;
  if (current.modelId === base.modelId && same(current.params, base.params) && (current.modelId !== next.modelId || !same(current.params, next.params))) {
    patch.modelId = next.modelId;
    patch.params = next.params;
  }
  const keys = new Set([...Object.keys(base.slots), ...Object.keys(current.slots), ...Object.keys(next.slots)] as InputSlot["key"][]);
  let slotsChanged = false;
  const slots = { ...current.slots };
  for (const k of keys) {
    if (sameAttachment(current.slots[k], base.slots[k]) && !sameAttachment(current.slots[k], next.slots[k])) {
      slots[k] = next.slots[k] ?? null;
      slotsChanged = true;
    }
  }
  if (slotsChanged) patch.slots = slots as D["slots"];
  const refsUntouched = current.refs === base.refs || (current.refs.length === base.refs.length && current.refs.every((r, i) => sameAttachment(r, base.refs[i])));
  if (refsUntouched && (next.refs.length || current.refs.length)) patch.refs = next.refs as D["refs"];
  // Frames handed over (Storyboard's "Animate these panels") open Frames mode, unless the strip was changed already.
  const framesKey = (d: D) => d.frames?.map((f) => f.value.ref);
  if (next.frames?.length && same(framesKey(current), framesKey(base))) patch.frames = next.frames as D["frames"];
  const preset = (d: D) => [d.presetId, d.presetOptions, d.presetStrength, d.mix];
  if (same(preset(current), preset(base)) && !same(preset(current), preset(next))) {
    patch.presetId = next.presetId;
    patch.presetOptions = next.presetOptions;
    patch.presetStrength = next.presetStrength;
    patch.mix = next.mix;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Home's Start: "/image?prompt=…&go=<token>" runs the handed-over prompt once

/** The query flag that asks a studio to run its handed-over draft once (Home's Start). Its value is a one-time token. */
export const START_PARAM = "go";

/** Where this tab keeps the token Home's Start just issued (sessionStorage, with a copy in memory). */
const START_TOKEN_KEY = "fuobe:start";
let startToken: string | null = null;

/**
 * Home's Start: a one-time token for `go=<token>`, kept in this tab. A studio runs the hand-off
 * only when `go` carries it, so a link from anywhere else (another site, an email, a chat) with a
 * `go` flag only prefills the studio and never starts a job on the user's keys. It is random, not
 * a counter: a tab that came from elsewhere can't guess one Home left behind.
 */
export function issueStartToken(): string {
  // getRandomValues, not randomUUID: it also works on a plain-http LAN address.
  const token = Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join("");
  startToken = token;
  try {
    sessionStorage.setItem(START_TOKEN_KEY, token);
  } catch {}
  return token;
}

/** Whether a `go` value is the token this tab's Home issued. The token is used up either way, so it runs once. */
export function claimStartToken(value: string | null | undefined): boolean {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(START_TOKEN_KEY);
    sessionStorage.removeItem(START_TOKEN_KEY);
  } catch {}
  const issued = [startToken, stored];
  startToken = null;
  return !!value && issued.includes(value);
}

/** The same address without the start flag, so a reload or Back doesn't run it again. */
export function withoutStart(href: string): string {
  const u = new URL(href, "http://x");
  u.searchParams.delete(START_PARAM);
  const rest = `${u.pathname}${u.search}${u.hash}`;
  return /^https?:\/\//.test(href) ? `${u.origin}${rest}` : rest;
}

/**
 * The same address with the camera motion or effect the composer shows (`?preset=`), or without one once it's
 * cleared, so a reload or a shared link opens on it.
 */
export function withPreset(href: string, id: string | undefined): string {
  const u = new URL(href, "http://x");
  if (id) u.searchParams.set("preset", id);
  else u.searchParams.delete("preset");
  const rest = `${u.pathname}${u.search}${u.hash}`;
  return /^https?:\/\//.test(href) ? `${u.origin}${rest}` : rest;
}

/**
 * What a studio does with a start request now: wait while models, presets or uploads are still
 * loading (their blockers are temporary), run when nothing blocks, else explain — the blocker's
 * toast names what's missing and points at its slot (Edit and Video's photo).
 */
export function startStep(s: { settling: boolean; blocker: Blocker | null }): "wait" | "run" | "explain" {
  if (s.settling) return "wait";
  return s.blocker ? "explain" : "run";
}

// ---------------------------------------------------------------------------
// Models for a studio and the picker's groups

export function filterModels(models: ModelDef[], opts: { kind?: MediaKind; ops?: Operation[] }): ModelDef[] {
  return models.filter((m) => !m.hidden && (!opts.kind || m.kind === opts.kind) && (!opts.ops || m.routes.some((r) => opts.ops!.includes(r.op))));
}

/**
 * "Best for this studio": the studio's default first, then top picks, then what's new — among
 * the models that do the studio's main operation (`op`, e.g. text-to-image in the Image studio),
 * so a single-purpose tool (garment try-on) never ranks above a general model.
 */
export function bestForStudio(models: ModelDef[], engine: Engine, defaultId: string | undefined, max = 4, op?: Operation): ModelDef[] {
  const pool = models.filter((m) => m.engine === engine && (!op || m.id === defaultId || m.routes.some((r) => r.op === op)));
  // A model ranked by its badges only for some operations (ModelDef.bestOps) isn't ranked in the other studios' lists.
  const ranked = (m: ModelDef) => !op || !m.bestOps || m.bestOps.includes(op);
  const score = (m: ModelDef) => (m.id === defaultId ? 0 : !ranked(m) ? 9 : m.badges?.includes("top") ? 1 : m.badges?.includes("new") ? 2 : 9);
  return pool
    .map((m, i) => [m, score(m), i] as const)
    .filter(([, s]) => s < 9)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .slice(0, max)
    .map(([m]) => m);
}

/**
 * A studio picker's "Best for this studio": the models that do what the default model does first, when the studio
 * offers that (`ops`, its main operation first). A default that does something else first (Qwen-Image 2.1 makes
 * pictures from words first, in the Edit and Inpaint studios) ranks the models that do the first of the studio's
 * operations it does instead, leaving out the tools that take no words (a garment try-on) unless the default is one.
 */
export function studioBest(models: ModelDef[], engine: Engine, defaultId: string | undefined, ops?: Operation[]): string[] {
  const def = models.find((m) => m.id === defaultId);
  const first = def?.routes[0]?.op;
  if (!def || !first || !ops?.length || ops.includes(first)) return bestForStudio(models, engine, defaultId, 4, first).map((m) => m.id);
  const op = ops.find((o) => def.routes.some((r) => r.op === o)) ?? ops[0];
  const pool = models.filter((m) => m === def || !m.options.promptless || def.options.promptless);
  return bestForStudio(pool, engine, defaultId, 4, op).map((m) => m.id);
}

export interface ModelGroup {
  id: "boxes" | "recent" | "starred" | "best" | "all" | "results" | "paid";
  label: string;
  models: ModelDef[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Search score: 0 = name starts with the query, 1 = a word starts with it, 2 = anywhere; -1 = no match. */
export function matchScore(m: Pick<ModelDef, "name" | "vendor" | "tagline" | "family">, query: string): number {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const name = norm(m.name);
  const hay = norm(`${m.name} ${m.vendor} ${m.family} ${m.tagline}`);
  if (!terms.every((t) => hay.includes(t))) return -1;
  if (name.startsWith(terms[0])) return 0;
  if (new RegExp(`\\b${terms[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)) return 1;
  return 2;
}

/**
 * The picker's sections. Without a query: Recent (last 3 used), Starred, Best for this studio
 * and the rest, for the selected engine. Every model shows once: it sits in the first section
 * it belongs to, so the last section lists only the ones the sections above it leave out ("More
 * models" under them, "All models" when it is the only one). `count` is still every model of
 * the engine. With a query: one list across every allowed engine, best
 * matches first.
 */
export function groupModels(input: {
  models: ModelDef[];
  engine: Engine;
  /** Engines the install allows (Settings → Engine mode). */
  engines: Engine[];
  query: string;
  recent: string[];
  starred: string[];
  best: string[];
  /** Layout mode: the models that place boxes by their coordinates come first ("Reads your boxes"). */
  boxes?: boolean;
  /** A short list in its own order (an app's models): one group. */
  flat?: boolean;
}): { groups: ModelGroup[]; count: number } {
  const { models, engine, engines, query, recent, starred, best, boxes } = input;
  const q = query.trim();
  if (q) {
    const hits = models
      .filter((m) => engines.includes(m.engine))
      .map((m, i) => ({ m, s: matchScore(m, q), i }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || (boxes ? Number(!readsBoxes(a.m)) - Number(!readsBoxes(b.m)) : 0) || Number(a.m.engine !== engine) - Number(b.m.engine !== engine) || a.i - b.i)
      .map((x) => x.m);
    return { groups: hits.length ? [{ id: "results", label: "Results", models: hits }] : [], count: hits.length };
  }
  const pool = models.filter((m) => m.engine === engine);
  if (input.flat) return { groups: pool.length ? [{ id: "all", label: "Models", models: pool }] : [], count: pool.length };
  const byId = new Map(pool.map((m) => [m.id, m]));
  const used = new Set<string>();
  const take = (ids: string[], max: number) => {
    const out: ModelDef[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m || used.has(id) || out.length >= max) continue;
      used.add(id);
      out.push(m);
    }
    return out;
  };
  const top = (
    [
      ...(boxes ? [{ id: "boxes" as const, label: "Reads your boxes", models: take(pool.filter((m) => readsBoxes(m)).map((m) => m.id), 50) }] : []),
      { id: "recent", label: "Recent", models: take(recent, 3) },
      { id: "starred", label: "Starred", models: take(starred, 50) },
      { id: "best", label: "Best for this studio", models: take(best, 4) },
    ] satisfies ModelGroup[]
  ).filter((g) => g.models.length);
  const rest = pool.filter((m) => !used.has(m.id));
  const groups: ModelGroup[] = [...top, ...(rest.length ? [{ id: "all" as const, label: top.length ? "More models" : "All models", models: rest }] : [])];
  return { groups, count: pool.length };
}

/** Keep a most-recent-first id list without duplicates. */
export function pushRecent(list: string[], id: string, max = 12): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// ---------------------------------------------------------------------------
// Cost hint

/**
 * The price beside Generate. `gpu`: it runs on the person's own GPU, said with "Free" so a free run never reads as
 * free of anything (the run still takes their GPU's time).
 */
export function costLabel(s: { demo: boolean; cost: number | null; compact?: boolean; unknown?: boolean; gpu?: boolean }, format: (usd: number) => string): string {
  if (s.demo) return s.compact ? "Placeholder" : "Placeholder · free";
  if (s.cost === 0) return s.gpu ? (s.compact ? "Free · GPU" : "Free · your GPU") : "Free";
  if (s.cost != null) return `≈ ${format(s.cost)}`;
  // A price the provider hasn't published (fal's MOSS-Image with LoRAs): said, never shown as free.
  return s.unknown ? "Price unknown" : "";
}

/**
 * Whether the price says "your GPU": an open-engine run on the person's own GPU. On a hosted studio an open run may go
 * to the studio's GPUs instead, and the "Your GPU" / "This studio's GPUs" chip or the price's hint says where, so the
 * price never claims the person's GPU there.
 */
export const saysYourGpu = (engine: string | undefined, hostedHere: boolean): boolean => engine === "open" && !hostedHere;

/** Prompts with an @mention: spellcheck would underline every handle. */
export const hasMention = (text: string) => /(^|\s)@[\p{L}\p{N}_-]+/u.test(text);

/**
 * The controls as an operation offers them: each control's values for `op` (ModelOptions.controls[].ops), and only the
 * controls left with a choice to make.
 */
export function controlsFor(controls: NonNullable<ModelDef["options"]["controls"]>, op?: string): NonNullable<ModelDef["options"]["controls"]> {
  if (!op) return controls;
  return controls.flatMap((c) => {
    if (!c.ops) return [c];
    const values = c.values.filter((v) => c.ops?.[String(v)]?.includes(op) ?? true);
    return values.length > 1 ? [{ ...c, values }] : [];
  });
}

/** A related studio's link (StudioConfig.related), opened on its model for this engine when it names one (Lipsync → Kandinsky 6.0). */
export function relatedHref(related: { href: string; models?: Partial<Record<Engine, string>> }, engine: Engine): string {
  const model = related.models?.[engine];
  if (!model) return related.href;
  return `${related.href}${related.href.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
}
