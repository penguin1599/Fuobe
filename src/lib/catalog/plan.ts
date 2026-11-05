import { FORMAT_INFO, formatList } from "@/lib/av/formats";
import { keyFormatValues } from "@/lib/av/keying";
import { factorTier, factorTierProblem } from "@/lib/av/upscale";
import type {
  Engine,
  GenerationRequest,
  GenParams,
  LoraRef,
  ModelDef,
  ModelRoute,
  Operation,
  Preset,
  PresetEndStep,
  PresetRoute,
  Pricing,
} from "./types";
import { billedClipSeconds, editClipsProblem, insertRangeProblem, sourceSeconds } from "./clip-windows";
import { chainGapProblem, chainTiming, FIRST_AT_ZERO, frameTimes, keyframeChain, MAX_KEYFRAMES, spread } from "./keyframes";
import { requestTiming } from "@/lib/inbetween";
import { cloudPath, fitLoras, gated, localOnly, loraCapacity, needsToken, routeLoraField, triggerOf } from "./loras";
import { anglesPrompt, anglesWords, ANGLES_ORIGINAL } from "./open-tools";
import { qmaRunPrompt } from "@/lib/qma";
import { askedSize, clipWords, numFramesValue, sizeValue } from "./payload";
import { characterScale, CINEMA_CROP, soulKind, soulMegapixels, soulRecipe, soulSize, type SoulOverlay } from "./soul";
import { computeDimensions, fitCanvas } from "@/lib/comfy";
import { carriesLayout, flux3Boxes, flux3Caption, layoutCompilerFor, LAYOUT_MAX_SIDE, LAYOUT_MULTIPLE, LAYOUT_PARAM, readLayout, validateLayout, type LayoutDraft, type LayoutFormat } from "@/lib/layout-prompt";
import { pricingOn, type PriceClock } from "./promo";
import { isInstrumental, lyricsOf, lyricsProblem, LYRICS_PARAM, promptLyricsProblem } from "@/lib/lyrics";
import { presetRoutes } from "./preset-recipe-routes";
import { readWorld, worldProblem } from "@/lib/world";
import { checkWatermarkBoxes } from "@/lib/watermark";

export { pricingAt } from "./promo";

/** Operations that make a video from words and stills only: an attached clip has no place in them. */
const MAKES_FROM_STILLS = new Set<Operation>(["t2v", "i2v", "flf2v", "keyframes", "ref2v", "avatar"]);

/** Infer the operation from what the user attached. */
export function inferOperation(model: ModelDef, req: Pick<GenerationRequest, "op" | "inputs" | "params">): Operation {
  if (req.op) return req.op;
  const ops = new Set(model.routes.map((r) => r.op));
  const imgs = req.inputs?.images?.length ?? 0;
  // Reference clips (Cinema Studio, Seedance) only fit reference-to-video.
  const clipRefs = (req.inputs?.videos?.length ?? 0) + (req.inputs?.audios?.length ?? 0);
  const has = (op: Operation) => ops.has(op);
  if (model.kind === "video") {
    if (req.inputs?.video && req.inputs?.audio && has("lipsync")) return "lipsync";
    if (req.inputs?.audio && imgs && has("avatar")) return "avatar";
    if (req.inputs?.video && imgs && has("motion-transfer")) return "motion-transfer";
    if (req.inputs?.video && has("v2v")) return "v2v";
    if (req.inputs?.video && has("extend")) return "extend";
    // Video erasers and swappers (a general video editor above takes these as plain edits unless asked).
    if (req.inputs?.video && imgs && has("video-swap")) return "video-swap";
    if (req.inputs?.video && has("remove-object")) return "remove-object";
    if (imgs && req.inputs?.endImage && has("flf2v")) return "flf2v";
    // Several stills are keyframes when they have times, or when the model takes no references. The open
    // chain (a film of several clips) only with times: stills left over from references stay a start frame.
    if (imgs > 1 && has("keyframes") && (req.params?.keyframeTimes?.length || (!has("ref2v") && !keyframeChain(model)))) return "keyframes";
    if ((imgs > 1 || clipRefs > 0) && has("ref2v")) return "ref2v";
    if (imgs && has("i2v")) return "i2v";
    if (has("t2v")) return "t2v";
  }
  if (model.kind === "image") {
    if (imgs && req.inputs?.mask && has("inpaint")) return "inpaint";
    if (imgs && has("edit")) return "edit";
    if (has("t2i")) return "t2i";
  }
  if (model.kind === "audio") {
    if ((req.inputs?.audios?.length ?? 0) > 1 && has("audio-join")) return "audio-join";
    if (req.inputs?.audio && has("audio-loop")) return "audio-loop";
  }
  if (model.kind === "model3d") {
    if (req.inputs?.model3d && has("rig-3d")) return "rig-3d";
    if (req.inputs?.model3d && has("refine-3d")) return "refine-3d";
    if (imgs && has("image-to-3d")) return "image-to-3d";
    if (!imgs && has("text-to-3d")) return "text-to-3d";
  }
  return model.routes[0].op;
}

/**
 * Why a clip is too long for a model that takes clips up to a length (ModelOptions.maxSourceSeconds: Kandinsky VSR's 121
 * frames at 24 fps), in the words the composer shows and the server refuses with; null when it fits or isn't known.
 */
export function sourceLengthProblem(model: Pick<ModelDef, "name" | "options">, seconds: number | undefined): string | null {
  const max = model.options.maxSourceSeconds;
  if (!max || !seconds || seconds <= max + 0.05) return null;
  return `${model.name} takes clips up to ${max} s, and this one is ${Math.round(seconds * 10) / 10} s: trim it first, or pick SeedVR2 for longer clips`;
}

/**
 * The routes that run `op`. With the run's params, a route that runs only for one value of a setting (ModelRoute.when:
 * Kandinsky 6.0's Pro or Lite on fal) qualifies when the setting has that value, or is unset and it is the first such route.
 */
export function routesFor(model: ModelDef, op: Operation, params?: GenParams): ModelRoute[] {
  const routes = model.routes.filter((r) => r.op === op);
  if (!params || !routes.some((r) => r.when)) return routes;
  return routes.filter((r) => {
    if (!r.when) return true;
    const v = params.extra?.[r.when.param];
    return v === undefined || v === null ? routes.find((x) => x.when?.param === r.when!.param) === r : String(v) === r.when.value;
  });
}

/** Fewer characters than this of the overall prompt in front of a capped shot prompt say too little: it is left out. */
const MIN_SHOT_LEAD = 40;

/**
 * Shots in whole seconds (each at least 1) that keep the take's rounded total: each is floored, and the seconds left go
 * to the shots with the largest remainders, so 2.4 + 2.4 becomes 3 + 2 (5 s), not 2 + 2.
 */
export function wholeShots<S extends { duration: number }>(shots: S[]): S[] {
  const total = Math.max(shots.length, Math.round(shots.reduce((n, s) => n + s.duration, 0)));
  const secs = shots.map((s) => Math.max(1, Math.floor(s.duration)));
  let left = total - secs.reduce((n, v) => n + v, 0);
  const rem = (i: number) => shots[i].duration - Math.floor(shots[i].duration);
  const byRem = shots.map((_, i) => i).sort((a, b) => rem(b) - rem(a) || a - b);
  // Seconds to add go to the largest remainders (at most one each: they add up to less than one per shot); seconds to
  // take back (shots raised to 1 s) come off the longest shots.
  for (const i of byRem) {
    if (left <= 0) break;
    secs[i]++;
    left--;
  }
  while (left < 0) {
    const i = byRem.reduce((best, j) => (secs[j] > 1 && (best < 0 || secs[j] > secs[best]) ? j : best), -1);
    if (i < 0) break;
    secs[i]--;
    left++;
  }
  return shots.map((s, i) => (secs[i] === s.duration ? s : { ...s, duration: secs[i] }));
}

/**
 * The most images a run of `op` sends this model: its routes' own limit when they all have one (ModelRoute.maxImages:
 * Qwen-Image 2.1 inpaints and expands the picture alone), else the model's options.maxImages.
 */
export function imageLimit(model: Pick<ModelDef, "options" | "routes">, op: Operation | undefined): number | undefined {
  const own = op ? model.routes.filter((r) => r.op === op).map((r) => r.maxImages) : [];
  return own.length && own.every((n) => n !== undefined) ? Math.max(...(own as number[])) : model.options.maxImages;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fill a preset prompt template: {prompt}, {prompt|words for when there are none} and {option:key}. Collapses leftover
 * whitespace.
 */
export function composePrompt(
  template: string,
  userPrompt: string | undefined,
  preset: Pick<Preset, "options"> | null,
  selected: Record<string, string> | undefined,
): string {
  const own = (userPrompt ?? "").trim();
  let out = template.replace(/\{prompt\}/g, own).replace(/\{prompt\|([^}]*)\}/g, (_, fallback: string) => own || fallback.trim());
  out = out.replace(/\{option:([a-zA-Z0-9_-]+)\}/g, (_, key: string) => {
    const opt = preset?.options?.find((o) => o.key === key);
    const value = selected?.[key] ?? opt?.default ?? opt?.choices[0]?.value;
    return opt?.choices.find((c) => c.value === value)?.prompt ?? "";
  });
  return out
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:]){2,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:]+|[\s,;:]+$/g, "")
    .trim();
}

/** "Shot 1 [0–3s]: … Shot 2 [3–8s]: …" — the format Seedance, Wan and LTX follow for multi-shot prompts. */
export function composeShots(overall: string, shots: { prompt: string; duration: number }[]): string {
  let t = 0;
  const parts = shots.map((s, i) => {
    const from = t;
    t += s.duration;
    return `Shot ${i + 1} [${from}-${t}s]: ${s.prompt.trim().replace(/[.\s]+$/, "")}.`;
  });
  return [overall.trim() && `${overall.trim().replace(/[.\s]+$/, "")}.`, ...parts].filter(Boolean).join(" ");
}

/** The preset's own route on an engine (its recipe, the route its preview was made with, is in presetRoutes). */
export function presetRoute(preset: Preset, engine: Engine): PresetRoute | null {
  return engine === "open" ? preset.open : preset.cloud;
}

export { presetRoutes };

/**
 * The model apps ran on before they moved to a newer one: the edit apps left Qwen-Image-Edit 2511, Expand and Zoom Out
 * left FLUX Fill, both for Qwen-Image 2.1 (2026-10-31); the talking apps left Kling AI Avatar for Kling Avatar 2.0 in
 * the cloud, and Upscale left 4x ESRGAN for SeedVR2 on your GPU (2026-11-01).
 */
const APP_MODEL_MOVES: Readonly<Record<string, string>> = {
  "oss-qwen-edit": "oss-qwen-image-21",
  "oss-flux-fill": "oss-qwen-image-21",
  "kling-avatar": "kling-avatar-2",
  "oss-upscale-image": "oss-seedvr2-image",
};

/**
 * Apps pin their model, so a stored app run on the model its app ran on before (a retry, Run again, Reuse, a script)
 * would be refused: it runs on the app's model now, with the app's operation, and `note` says so. Anything else is
 * returned as it is (an app a LoRA ties to the old model, Multiple Angles on 2511, still names it).
 */
export function movedAppRequest<T extends Pick<GenerationRequest, "modelId" | "op" | "presetId">>(
  req: T,
  getModel: (id: string) => ModelDef | undefined,
  getPreset: (id: string) => Preset | undefined,
): { request: T; note?: string } {
  const was = getModel(req.modelId);
  const preset = req.presetId ? getPreset(req.presetId) : undefined;
  const route = was && preset?.type === "app" ? presetRoute(preset, was.engine) : null;
  if (!was || !route || route.modelId === was.id || !Object.hasOwn(APP_MODEL_MOVES, was.id) || APP_MODEL_MOVES[was.id] !== route.modelId) return { request: req };
  const now = getModel(route.modelId);
  if (!now) return { request: req };
  return { request: { ...req, modelId: now.id, ...(route.op && { op: route.op }) }, note: `${preset!.name} now runs on ${now.name}` };
}

/** Model families a Mix's LoRA may run on instead (said when it can't join the first preset's model). */
const FAMILY_NAME: Record<string, string> = { "fuobe-dop": "Wan 2.2", "fuobe-dop-ltx": "LTX-2.3", "oss-ltx25": "LTX-2.5" };

/**
 * A Mix's second preset on the model the first runs on (Fuobe DoP, either engine): its LoRAs scaled by the mix
 * strength when that model loads them; a LoRA for another base (an LTX-2.3 effect mixed into a Wan move) can't
 * join, so that preset joins as words only, and the plan says so.
 */
export function mixLoras(second: Preset, modelId: string, engine: Engine, strength: number): { loras: LoraRef[]; trigger?: string; note?: string } {
  const route = presetRoute(second, engine);
  const loras = route?.loras ?? [];
  if (!loras.length) return { loras: [] };
  if (route?.modelId !== modelId) {
    const on = (route && FAMILY_NAME[route.modelId]) ?? "another model";
    return { loras: [], note: `${second.name}'s LoRA runs on ${on}, so it joins this mix as words only` };
  }
  const k = clamp01(strength);
  return { loras: loras.map((l) => ({ ...l, strength: round2((l.strength ?? 1) * k) })), trigger: triggerOf(loras) };
}

export interface Plan {
  model: ModelDef;
  op: Operation;
  prompt: string;
  params: GenParams;
  loras: LoraRef[];
  /** Number of separate provider jobs (models that can't batch need several). */
  jobs: number;
  perJobOutputs: number;
  /** What the plan changed or left out, said before the run (a look's LoRAs that don't fit this base). */
  notes?: string[];
  /**
   * A Fuobe Soul run (src/lib/catalog/soul.ts): the look applied, the user's words inside the prompt (the enhancer
   * expands them, the look stays), the look's LoRA triggers at the front (in order), and what happens after
   * generation (the grade, an overlay) that the result's meta carries.
   */
  soul?: { look?: string; words: string; triggers: string[]; grade?: string; overlay?: SoulOverlay; crop?: "21:9" };
  /**
   * A layout run (params.extra.layout, src/lib/layout-prompt.ts): the form the model reads it in, how many boxes, and
   * the canvas it was compiled at when the model reads pixels (MOSS-Image: the exact size it renders).
   */
  layout?: { format: LayoutFormat | "words"; boxes: number; width?: number; height?: number };
  /** MiniMax H3's sound lines from the preset's route (its preview's), which its layout's sound fields take. */
  sound?: { soundscape: string; music: string };
  /** An end-frame step: an image edit of the start frame that becomes the clip's end frame (H3 flf2v). */
  end?: PresetEndStep;
}

/** Operations that work from their inputs alone. */
const PROMPTLESS = new Set<Operation>([
  "concat", "frame", "color-match", "finalize", "reframe", "dialogue", "voice-change", "dub", "bg-remove-video", "depth-video", "upscale-image", "upscale-video", "bg-remove",
  "interpolate", "v2a", "face-swap", "motion-transfer", "lipsync", "avatar",
  // round 3: tools that work from their inputs (open caption burn-in takes timed lines as its prompt and says so when they're missing)
  "trim", "transcribe", "mux", "separate-audio", "enhance-voice", "speech-edit", "layers", "image-to-3d", "captions", "text-layers", "vectorize", "level",
  // av-tools: the dub voice track (clips placed on the video's timeline)
  "timeline",
  // round 4: tools that work from their inputs (removing an object needs a prompt only on models that read one)
  "sdr-to-hdr", "export-video", "ocr", "still-motion", "audio-loop", "audio-join", "scene-3d", "splat", "rig-3d", "refine-3d", "extract-frames", "images-to-video", "overlay", "composite",
  // round 5 (O11): the face mosaic names the faces itself ("face")
  "face-mosaic",
  // archive-restore: the scene's words help (period, place, light) but a run without them gets a neutral one
  "restore-video",
  // Extending a song takes its lyrics, its stems nothing
  "song-extend", "song-stems",
  // An inserted moment can be left to the model; a retexture takes words or a style picture
  "insert-moment", "retexture-3d",
  // World mode: a world turn's words are in its script (params.extra.world)
  "world-turn",
  // Watermark Remover: the marks are found, kept or brushed; no words
  "watermark-scan", "watermark-remove",
  // Genjutsu's Openjutsu modes: their words (roles, what changes, the scene) travel in their settings, not the prompt
  "group-swap", "scene-edit", "picture-frame", "picture-video", "face-fix-video", "tone-video", "describe-video",
]);

/**
 * The prompt can be left empty: the operation works from its inputs, the model takes no prompt at all
 * (try-on, transcription, 3D), or (when the routes' field maps are known, on the server) none of the
 * routes for this operation sends one.
 */
export function promptOptional(model: ModelDef, op: Operation): boolean {
  if (PROMPTLESS.has(op) || model.options.promptless || model.options.promptOptional) return true;
  const routes = routesFor(model, op);
  return routes.length > 0 && routes.every((r) => r.map?.prompt === false);
}

/**
 * Removing an object: what to erase is named (the prompt), painted (inputs.mask) or clicked (params.points).
 * A mask or points stand in for the words when a route reads them (unknown on the client, whose catalog
 * has no field maps, and on ComfyUI routes, whose workflows bind them).
 */
function markedTarget(model: ModelDef, op: Operation, req: GenerationRequest, params: GenParams): boolean {
  if (op !== "remove-object") return false;
  const routes = routesFor(model, op);
  const reads = (k: "mask" | "points") => routes.some((r) => !r.map || !!r.map[k]);
  return (!!req.inputs?.mask && reads("mask")) || (!!params.points?.length && reads("points"));
}

export function planGeneration(
  req: GenerationRequest,
  getModel: (id: string) => ModelDef | undefined,
  getPreset: (id: string) => Preset | undefined,
): Plan {
  const model = getModel(req.modelId);
  if (!model) throw new Error(`Unknown model ${req.modelId}`);
  // Fuobe Soul takes a look (its presetId is a look id), or runs an app whose route names a look (the AI Influencer app).
  const soul = soulKind(model);
  const found = req.presetId ? getPreset(req.presetId) : undefined;
  const preset = !soul || found?.type === "app" ? found : undefined;
  if (req.presetId && !soul && !preset) throw new Error(`Unknown preset ${req.presetId}`);
  const routeLook = preset?.type === "app" ? presetRoute(preset, model.engine)?.look : undefined;
  const look = soul && preset ? routeLook : req.presetId;

  let prompt = req.prompt?.trim() ?? "";
  let params: GenParams = { ...model.defaults, ...req.params };
  let loras: LoraRef[] = [];
  let op: Operation | undefined = req.op;
  let sound: Plan["sound"];
  let end: Plan["end"];

  if (preset) {
    // The preset's routes on this engine: the one its preview was made with (when this catalog has its model), then its own.
    const routes = presetRoutes(preset, model.engine, (id) => !!getModel(id));
    if (!routes.length) throw new Error(`${preset.name} has no ${model.engine === "open" ? "open-source" : "cloud"} version yet`);
    const matched = routes.find((r) => r.modelId === model.id);
    if (!matched && !preset.type.match(/motion|effect/)) {
      // Apps run on their own models; motions/effects let the user pick any compatible video model.
      throw new Error(`${preset.name} runs on ${[...new Set(routes.map((r) => r.modelId))].join(" or ")}, not ${model.id}`);
    }
    const route = matched ?? routes[0];
    // Preset params/LoRAs are tuned for the route's own model; other compatible models only get the prompt (without
    // a LoRA's trigger word, which means nothing to them).
    const sameModel = !!matched;
    const template = (sameModel ? route.promptTemplate : undefined) ?? preset.promptTemplate;
    prompt = composePrompt(template, req.prompt, preset, req.presetOptions);
    // "{prompt|…}" words stand for the preset's pictures (Outfit Swap: "the outfit from the second image"), so a run
    // without words of its own needs every picture the preset asks for.
    if (template.includes("{prompt|") && !req.prompt?.trim()) {
      const missing = preset.inputs.filter((s) => s.accept === "image")[req.inputs?.images?.length ?? 0];
      if (missing) throw new Error(`Add the ${missing.label.toLowerCase()}, or describe it`);
    }
    // The route's extra settings (H3's orbit, a camera pose) stay under what the request sets itself. A setting the composer
    // shows as a control (H3's Quality) is the request's own: the composer starts it at the route's value, and its Auto
    // sends none, which is the model's default.
    const shown = new Set((model.options.controls ?? []).map((c) => c.param));
    const routeExtra = Object.fromEntries(Object.entries(route.params?.extra ?? {}).filter(([k]) => !shown.has(k)));
    const routePlain = { ...route.params };
    delete routePlain.extra;
    const hasExtra = Object.keys(routeExtra).length > 0 || !!req.params?.extra;
    const extra = sameModel && hasExtra ? { extra: { ...routeExtra, ...req.params?.extra } } : {};
    params = { ...model.defaults, ...(sameModel ? routePlain : {}), ...req.params, ...extra };
    // Option choices that set model settings (Angles: rotate / tilt / zoom; Restore: its LoRA's strength, on the open
    // engine only); a value the user set wins.
    const picks = (preset.options ?? []).map((o) => o.choices.find((c) => c.value === (req.presetOptions?.[o.key] ?? o.default ?? o.choices[0]?.value)));
    const chosen = Object.assign({}, ...picks.map((c) => ({ ...c?.extra, ...(model.engine === "open" && c?.openExtra) })));
    if (sameModel && Object.keys(chosen).length) params = { ...params, extra: { ...chosen, ...params.extra } };
    loras = sameModel ? (route.loras ?? []) : [];
    if (sameModel) op = op ?? route.op;
    if (sameModel && route.sound) sound = route.sound;
    if (sameModel && route.end && !req.inputs?.endImage) end = route.end;
  }

  const notes: string[] = [];
  if (preset && /motion|effect/.test(preset.type)) {
    const k = clamp01(req.presetStrength ?? 1);
    if (k < 1) loras = loras.map((l) => ({ ...l, strength: round2((l.strength ?? 1) * k) }));
    // Fuobe DoP · LTX's built-in camera LoRA follows the preset strength too (camera_lora_scale, 0–1).
    const camera = params.extra?.camera_lora;
    if (camera && k < 1 && params.extra?.camera_lora_scale === undefined) params = { ...params, extra: { ...params.extra, camera_lora_scale: round2(k) } };
    if (req.mix) {
      const second = getPreset(req.mix.presetId);
      if (!second || !/motion|effect/.test(second.type)) throw new Error("Pick a camera motion or effect to mix in");
      if (second.id !== preset.id) {
        const m = clamp01(req.mix.strength);
        // Its LoRAs stack on the same model on either engine (Fuobe DoP), each scaled by the mix strength; a LoRA for
        // another base (an LTX-2.3 effect mixed into a Wan move) can't, so that preset joins as words only.
        const mixed = mixLoras(second, model.id, model.engine, m);
        if (mixed.note) notes.push(mixed.note);
        // The second preset's own words, without the user's prompt (and with its LoRA's trigger); worded by strength.
        const own = composePrompt(second.promptTemplate.replace(/\{prompt\}\.?/g, ""), "", second, undefined).replace(/[.\s]+$/, "");
        const words = mixed.trigger && mixed.loras.length ? `${mixed.trigger}, ${own.charAt(0).toLowerCase()}${own.slice(1)}` : `${own.charAt(0).toLowerCase()}${own.slice(1)}`;
        const lead = m >= 0.75 ? "At the same time" : m >= 0.4 ? "Also, more subtly" : "With a slight hint of this";
        prompt = `${prompt.replace(/[.\s]+$/, "")}. ${lead}: ${words}.`;
        loras = [...loras, ...mixed.loras.filter((l) => !loras.some((x) => x.file === l.file))];
      }
    }
  }

  // The user's own LoRAs (an @character's trained identity) go first: on an API that takes so many, the first
  // ones win, so a look's or motion's LoRAs give way to them (fitLoras).
  let soulPlan: Plan["soul"];
  // The character strength (Fuobe's setting, never the provider's) scales the user's own LoRAs on every model.
  const extra = params.extra ?? {};
  const charStrength = typeof extra.characterStrength === "number" ? extra.characterStrength : undefined;
  if ("characterStrength" in extra) {
    const rest = { ...extra };
    delete rest.characterStrength;
    params = { ...params, extra: Object.keys(rest).length ? rest : undefined };
  }
  if (soul) {
    const r = soulRecipe(soul, prompt, { look, strength: req.presetStrength, userLoras: req.loras, characterStrength: charStrength });
    prompt = r.prompt;
    loras = r.loras;
    notes.push(...r.notes);
    // PixeletedFace: a second step pixelates the faces (src/server/chains.ts createMosaicRun).
    if (r.look?.post === "face-mosaic") {
      notes.push(model.engine === "open" ? "Then SAM 3.1 pixelates the faces on your GPU (free)" : `Then fal's SAM 3.1 finds the faces (${"$"}0.01 a picture) and they're pixelated`);
    }
    const own = new Set(req.loras ?? []);
    soulPlan = {
      ...(r.look && { look: r.look.id }),
      words: r.words.trim().replace(/[.\s]+$/, ""),
      triggers: [...new Set(r.loras.filter((l) => !own.has(l) && l.trigger?.trim()).map((l) => l.trigger!.trim()))],
      ...(r.grade && { grade: r.grade }),
      ...(r.overlay && { overlay: r.overlay }),
    };
  } else if (routeLook) {
    // An app whose graph is Fuobe Soul's own base (the AI Influencer app's Soul Cast sheet on your GPU) runs in its
    // route's look too: the look's words and LoRAs, as the AI Influencer builder and Cinema's Soul Cast send them.
    const r = soulRecipe("soul", prompt, { look: routeLook, userLoras: req.loras, characterStrength: charStrength });
    prompt = r.prompt;
    loras = r.loras;
    notes.push(...r.notes);
  } else if (req.loras?.length) {
    // An @character's trained LoRA on FLUX, klein, Krea or any other model: at the character strength's scale, as on Soul.
    const own = charStrength === undefined ? req.loras : req.loras.map((l) => ({ ...l, strength: characterScale(charStrength) }));
    loras = [...own, ...loras];
  }
  // Fuobe Angles: the camera's fields go to fal as they are; on the GPU they become the Multiple-angles LoRA's own words,
  // the user's note after them. fal's route takes no words of its own.
  if (model.id === ANGLES_ORIGINAL) {
    if (model.engine === "open") prompt = anglesPrompt(params.extra, prompt);
    else {
      if (!anglesWords(params.extra)) throw new Error("Move the camera first: rotate it, tilt it, move it closer or go wide");
      if (prompt) notes.push("The hosted Multiple-angles route takes no words: your note is used on your GPU only");
      prompt = "";
    }
  }
  // QMA camera angles: the run's pose (the Angles app's choices, the model's Angle / Height / Distance, Cinema's camera) becomes
  // the LoRA's own words, nearest of its 96 views, the user's words after them (src/lib/qma.ts).
  if (model.options.promptFormat === "qma") prompt = qmaRunPrompt(prompt, params.extra);
  // The words a model takes when none are given (Fuobe Try-On: its LoRA's own instruction).
  if (!prompt && model.options.defaultPrompt) prompt = model.options.defaultPrompt;
  // A recipe's own LoRAs (Fuobe Try-On's try-on LoRA) go on every run, first (an API's LoRA cap leaves out yours
  // before them), their trigger words leading.
  const recipe = (model.options.loras ?? []).filter((l) => !loras.some((x) => x.file === l.file));
  if (recipe.length) {
    loras = [...recipe, ...loras];
    const lead = recipe.map((l) => l.trigger?.trim()).filter((t): t is string => !!t && !prompt.startsWith(t));
    if (lead.length && prompt) prompt = `${lead.join(", ")} ${prompt}`;
  }
  // A LoRA at strength 0 changes nothing: leave it out, so preset strength 0 is the preset's prompt alone (and its file isn't needed).
  const kept = loras.filter((l) => (l.strength ?? 1) !== 0);
  prompt = withoutTriggers(prompt, loras.filter((l) => !kept.includes(l)), kept);
  loras = kept;

  // Multi-shot: the clip is as long as its shots, and models without per-shot prompts get them written out.
  let shots = params.shots?.filter((s) => s.prompt.trim());
  if (shots?.length) {
    if (!model.options.multiShot) throw new Error(`${model.name} can't do multi-shot — try Kling 3.0, Seedance 2.5 or Wan 2.6`);
    if (shots.length > model.options.multiShot.maxShots) throw new Error(`${model.name} takes up to ${model.options.multiShot.maxShots} shots`);
    // A model whose shots are whole seconds (Kling 4.0) gets them rounded here, keeping the total, so the price, the
    // per-shot lengths and every route's duration (Replicate's too) are the same whole seconds.
    const shotMaps = model.routes.flatMap((r) => (r.map?.multiShot ? [r.map.multiShot] : []));
    const whole = shotMaps.some((m) => m.integer);
    if (whole) shots = wholeShots(shots);
    const total = shots.reduce((n, s) => n + s.duration, 0);
    const max = Math.max(...(model.options.durations ?? [total]));
    const min = Math.min(...(model.options.durations ?? [total]));
    // Joined films (open models) render each shot as its own clip: only each shot has to fit.
    const concat = model.options.multiShot.mode === "concat";
    if (concat && shots.some((s) => s.duration > max)) throw new Error(`${model.name} makes clips up to ${max}s per shot`);
    if (!concat && total > max) throw new Error(`The shots add up to ${total}s — ${model.name} makes up to ${max}s`);
    if (whole && total < min) throw new Error(`The shots add up to ${total}s — ${model.name} makes ${min}s or more`);
    // Per-shot prompts carry the overall description (and @element legend) with them. Where a shot's prompt has a
    // length cap (Kling 4.0: 512 characters), the shot's own words come first: the overall part is cut to the room left,
    // and left out when hardly any is left.
    const overall = prompt.trim().replace(/[.\s]+$/, "");
    const native = model.options.multiShot.mode === "native";
    const caps = shotMaps.flatMap((m) => (m.maxPrompt ? [m.maxPrompt] : []));
    const cap = caps.length ? Math.min(...caps) : undefined;
    const lead = (own: string) => {
      if (cap === undefined || overall.length + own.length + 2 <= cap) return `${overall}. ${own}`;
      const room = cap - own.length - 2;
      const cut = room >= MIN_SHOT_LEAD ? clipWords(overall, room) : "";
      return cut ? `${cut}. ${own}` : own;
    };
    params = { ...params, shots: native && overall ? shots.map((s) => ({ ...s, prompt: lead(s.prompt.trim()) })) : shots, duration: total };
    prompt = composeShots(prompt, shots);
  } else if (params.multiShot === "auto" && model.options.multiShot?.mode === "prompt") {
    prompt = `${prompt.replace(/[.\s]+$/, "")}. Multi-shot sequence: tell it in several distinct shots with clean cuts between them.`;
  }
  const inferred = op === undefined;
  op = op ?? inferOperation(model, req);
  if (model.kind === "video" && inferred) {
    // What the run would drop without a word: a clip on an operation that makes a new video from words and stills (MiniMax H3
    // in Lipsync & avatars makes a new talking clip, it doesn't re-sync one), or reference clips and sound beside an end frame.
    if (req.inputs?.video && MAKES_FROM_STILLS.has(op)) {
      throw new Error(
        routesFor(model, "avatar").length && !routesFor(model, "lipsync").length
          ? `${model.name} makes a new talking video from a portrait and the voice; it doesn't re-sync an existing clip. Add a portrait instead of the video, or pick another model`
          : `${model.name} can't take a video here. Remove it, or pick another model`,
      );
    }
    if (op === "flf2v" && ((req.inputs?.videos?.length ?? 0) || (req.inputs?.audios?.length ?? 0))) {
      throw new Error("Reference clips and sound can't go with an end frame. Remove the end frame, or the clips and sound");
    }
  }
  // Reference clips and video elements on a model that bills them with the output (Kling 4.0, Pricing.clipInput): priced
  // at the least they bill (twice the output) until the server reads their length (params.clipSeconds).
  if (model.pricing?.clipInput && req.inputs?.videos?.length && params.clipSeconds === undefined) params = { ...params, clipSeconds: 0 };
  // A run with no reference images on a model that then draws its own (H3 Max 3D to video): priced at the most it draws.
  // A chained still (a hand-over frame) counts as one going in.
  const gen = model.pricing?.generatedRefs;
  const stills = !!req.inputs?.images?.length || !!req.chain?.some((c) => c.slot === "images");
  params = { ...params, drawnRefs: gen && !stills ? gen.count : undefined };
  if (params.drawnRefs === undefined) delete params.drawnRefs;
  // An edit's reference clips (beside the clip it edits; clip elements are counted on their own): Kling 4.0 takes 4.
  if (op === "v2v" || op === "video-swap" || op === "video-insert") {
    const asElements = params.elements?.filter((g) => g.video !== undefined).length ?? 0;
    const problem = editClipsProblem(model, (req.inputs?.videos?.length ?? 0) - asElements);
    if (problem) throw new Error(problem);
  }
  if (!routesFor(model, op).length) {
    throw new Error(`${model.name} can't do ${op} — try another model`);
  }
  // A layout (the Image studio's Layout mode, Edit layout, an API caller's draft): compiled for this model at the size it
  // renders, the prompt as its caption; nothing rewrites it afterwards (Fuobe's enhancer, the API's prompt expansion).
  let layoutPlan: Plan["layout"];
  if (carriesLayout(params.extra)) {
    const drawn = readLayout(params.extra![LAYOUT_PARAM]);
    if (!drawn) throw new Error("The layout couldn't be read: draw its boxes again");
    const compiled = planLayout(model, op, prompt, drawn, params);
    prompt = compiled.prompt;
    params = compiled.params;
    layoutPlan = compiled.layout;
  }
  // MiniMax H3's orbit of a still (its Orbit LoRA graph, src/lib/comfy-variants.ts) runs at the LoRA's own length, 3 s
  // (73 frames), unless the run names a length.
  if (model.options.promptFormat === "minimax-h3" && op === "i2v" && params.extra?.orbit === true && req.params?.duration === undefined && params.duration === model.defaults?.duration) {
    params = { ...params, duration: 3 };
  }
  // Song lyrics (params.extra.lyrics, Audio → Music's editor): normalized for a model that sings them, checked against its
  // length; a model that writes its own words never gets them, and the run says so when they had words to sing.
  if (params.extra && LYRICS_PARAM in params.extra) {
    const words = lyricsOf(params.extra);
    const rest = { ...params.extra };
    delete rest[LYRICS_PARAM];
    const spec = model.options.lyrics;
    if (spec && words) {
      // Lyrics read after the description (Lyria 3.5) share its limit with it.
      const problem = spec.inPrompt && spec.max ? promptLyricsProblem(prompt, words, spec.max, model.name) : lyricsProblem(words, spec.max, model.name);
      if (problem) throw new Error(problem);
      // A model that sings words only (Mureka's songs): an instrumental is its maker's instrumental model.
      const own = spec.instrumentalModel && op === "music" && isInstrumental(words) ? getModel(spec.instrumentalModel) : undefined;
      if (own) throw new Error(`${model.name} sings the lyrics you write: for an instrumental, pick ${own.name}`);
      params = { ...params, extra: { ...rest, [LYRICS_PARAM]: words } };
    } else {
      if (words && !isInstrumental(words) && op === "music") notes.push(`${model.name} writes its own words from your description: the lyrics aren't sent`);
      params = { ...params, extra: Object.keys(rest).length ? rest : undefined };
    }
  }
  // A model that needs words to sing: a song from lyrics (YuE2), the lyrics of a song's new part or of its remix (Mureka).
  const sung = lyricsOf(params.extra);
  if (model.options.lyrics?.required && (!sung || ((op === "music" || op === "song-remix") && isInstrumental(sung)))) {
    throw new Error(
      op === "song-extend"
        ? "Write the lyrics of the new part"
        : op === "song-remix"
          ? "Write the remix's lyrics: the whole song, with [Verse] and [Chorus] on lines of their own (Mureka remixes songs with vocals, not instrumentals)"
          : `${model.name} sings your lyrics: write them first, with [Verse] and [Chorus] on lines of their own`,
    );
  }
  if (op === "song-remix" && !prompt) throw new Error("Describe the remix: its genre, mood and instruments");
  if (op === "music" && req.inputs?.audio && !model.options.cover) throw new Error(`${model.name} makes a new song: remove the song you added, or pick YuE2 to cover it`);
  const hosted = hostedInputProblem(model, op, prompt, params, req);
  if (hosted) throw new Error(hosted);
  if (op === "finalize" && !params.draftId) throw new Error("Pick a draft to finish");
  if (op === "dialogue" && !params.dialogue?.some((l) => l.text.trim())) throw new Error("Write at least one line");
  if (op === "dub" && !params.targetLanguage) throw new Error("Pick a language to translate into");
  if (op === "voice-design" && !params.voiceDescription?.trim()) throw new Error("Describe the voice you want");
  if (op === "speech-edit" && !(Array.isArray(params.extra?.speechWindows) && params.extra.speechWindows.length)) throw new Error("Edit the words, or pick a range and an effect");
  if (op === "world-turn") {
    const world = readWorld(params.extra?.world);
    const problem = world ? worldProblem(world, Number(params.extra?.turn ?? 0)) : "Describe the world first: the opening is where it starts";
    if (problem) throw new Error(problem);
  }
  if (model.options.motionPaths && !(params.extra?.motionPaths as { paths?: unknown[] } | undefined)?.paths?.length) {
    throw new Error(`Draw on the start frame — ${model.name} moves things along the paths you draw`);
  }
  if (op === "dialogue" && model.options.voiceClone && (!req.inputs?.voiceAudio || !req.inputs?.voiceAudio2)) throw new Error("Add a voice sample for each speaker");
  if ((op === "tts" || op === "voice-change") && model.options.voiceClone && !model.options.voices?.length && !req.inputs?.voiceAudio) {
    throw new Error(op === "tts" ? "Pick or record the voice to speak with" : "Pick or record the voice to change into");
  }
  if (op === "dub" && !req.inputs?.video && !req.inputs?.audio) throw new Error("Add the video to translate");
  if (op === "keyframes") checkKeyframes(model, req.inputs?.images?.length ?? 0, params);
  // A format the model doesn't write (an API caller, or a request moved to another model).
  const formats = model.options.formats;
  if (params.format && formats?.length && !formats.includes(params.format)) {
    throw new Error(`${model.name} writes ${formatList(formats)}, not ${FORMAT_INFO[params.format]?.short ?? params.format}`);
  }
  // A join takes as many clips as the API's list does (fal merge-audios: 5); longer joins run in steps.
  const maxAudios = model.options.maxAudios;
  if (op === "audio-join" && maxAudios && (req.inputs?.audios?.length ?? 0) > maxAudios) throw new Error(`${model.name} joins up to ${maxAudios} clips at a time — join the rest in a second step`);
  const requires = model.options.requires;
  const images = req.inputs?.images?.length ?? 0;
  if (requires?.images && images < requires.images && !(requires.promptInstead && prompt && images === requires.images - 1)) throw new Error(requires.msg);
  if (requires?.prompt && !prompt) throw new Error(requires.msg);
  if (requires?.mask && !req.inputs?.mask) throw new Error(requires.msg);
  if (requires?.video && !req.inputs?.video) throw new Error(requires.msg);
  if (requires?.points && !params.points?.length) throw new Error(requires.msg);
  if (op === "bg-remove-video" || op === "depth-video") checkVideoToolOptions(model, op, prompt, params);
  // Remove background on a model that makes both files: the picker's default (the cut-out) unless asked, so the job
  // makes the one file the picker showed, not both.
  const matteOutputs = model.options.matteOutputs;
  if (op === "bg-remove-video" && !params.matteOutput && matteOutputs && matteOutputs.length > 1) params = { ...params, matteOutput: matteOutputs[0] };
  // Soul's prompt always carries the look's words: it's the user's own words a new picture needs.
  if (soulPlan && op === "t2i" && !soulPlan.words) throw new Error("Write a prompt first");
  // Soul HD (and Soul Cinema) make new pictures only: a picture attached isn't used, and the run says so.
  if (soulPlan && op === "t2i" && req.inputs?.images?.length && !routesFor(model, "edit").length) {
    notes.push(`${model.name} makes new pictures, so it doesn't use the picture you attached (Fuobe Soul restyles a picture with a look)`);
  }
  if (!prompt && !promptOptional(model, op) && !markedTarget(model, op, req, params)) {
    throw new Error(op === "remove-object" ? "Say what to remove, e.g. “the coffee cup in her hand”" : "Write a prompt first");
  }

  const missing = missingInputs(op, req) ?? unreadInputs(model, op, req) ?? missingImages(model, req);
  if (missing) throw new Error(missing);
  // Watermark Remover: the kept marks are checked and rebuilt here (never passed on as sent); a brushed run takes none.
  if (op === "watermark-remove" && params.extra && "boxes" in params.extra) {
    const extra = { ...params.extra };
    if (req.inputs?.mask) delete extra.boxes;
    else extra.boxes = checkWatermarkBoxes(extra.boxes).json;
    params = { ...params, extra };
  }
  const tooMany = extraImages(model, op, req);
  if (tooMany) throw new Error(tooMany);
  const tooLong = sourceLengthProblem(model, params.sourceDuration);
  if (tooLong) throw new Error(tooLong);
  const tier = op === "upscale-video" ? factorTierProblem(model.name, model.options.resolutions, params.resolution) : null;
  if (tier) throw new Error(tier);

  // Soul Cinema's 21:9 (research §4.5: a crop option): made at 16:9 on both engines, then cropped to 21:9 with
  // its grade after generation (meta.crop).
  if (soulPlan && soul === "cinema" && params.aspectRatio === CINEMA_CROP) {
    params = { ...params, aspectRatio: "16:9" };
    soulPlan = { ...soulPlan, crop: CINEMA_CROP };
  }
  // Soul's exact sizes on the user's GPU (the cloud routes send them through FieldMap.size); an edit keeps the
  // picture's shape at the tier's size (about 1 or 2 megapixels).
  if (soul && model.engine === "open" && op === "t2i") {
    const { width, height } = soulSize(params.aspectRatio, params.resolution);
    params = { ...params, extra: { ...params.extra, width, height } };
  }
  if (soul && model.engine === "open" && op === "edit") params = { ...params, extra: { ...params.extra, megapixels: params.resolution === "1080p" ? 2 : 1 } };
  // How much an edit changes the picture (params.extra.strength) means nothing to a new picture.
  if (soul && op === "t2i" && params.extra && "strength" in params.extra) {
    const rest = { ...params.extra };
    delete rest.strength;
    params = { ...params, extra: Object.keys(rest).length ? rest : undefined };
  }

  params = controlSets(model, params);

  const requested = Math.max(1, Math.min(8, params.numOutputs ?? 1));
  const maxPerJob = Math.max(1, model.options.maxOutputs ?? 1);
  const perJobOutputs = Math.min(requested, maxPerJob);
  const jobs = Math.ceil(requested / perJobOutputs);
  return {
    model,
    op,
    prompt,
    params: { ...params, numOutputs: perJobOutputs },
    loras,
    jobs,
    perJobOutputs,
    ...(notes.length && { notes }),
    ...(soulPlan && { soul: soulPlan }),
    ...(layoutPlan && { layout: layoutPlan }),
    ...(sound && { sound }),
    ...(end && { end }),
  };
}

// ---------------------------------------------------------------------------
// Layouts

/** A layout's canvas on your GPU: the graph's 16 px grid, up to 2048 a side (moss-image-t2i's limits), fitted as the ComfyUI provider fits a canvas the request names. */
const OPEN_CANVAS = { dimensionMultiple: LAYOUT_MULTIPLE, maxWidth: LAYOUT_MAX_SIDE, maxHeight: LAYOUT_MAX_SIDE };

/** "4k" / "2K" / "1k" → the resolution tiers computeDimensions knows ("4K"); anything else as it is. */
const tier = (res: string | undefined) => (res && /^\d(\.\d)?k$/i.test(res) ? res.toUpperCase() : res);

export interface LayoutCanvas {
  /** The size the model renders, the size a pixel layout (MOSS-Image) is compiled at. */
  width: number;
  height: number;
  /** The size the aspect ratio and resolution ask for, before the model's limits (a side past 2048 is scaled down). */
  asked: { width: number; height: number };
  /** False when the size is a guess from the resolution's name (a cloud model that takes an aspect ratio and a tier). */
  exact: boolean;
}

/**
 * The canvas a layout is drawn for on this model. On your GPU: the aspect ratio and resolution on the 16 px grid
 * (computeDimensions), up to 2048 a side (fitCanvas, as the ComfyUI provider fits it). In the cloud: the route's size
 * field (sizeValue: fal's MOSS-Image 512–2048), else a guess from the resolution's name (FLUX.3's "4k"). The layout
 * keeps its boxes as fractions, so it is compiled at this size whatever it was drawn on.
 */
export function layoutCanvas(model: ModelDef, params: GenParams, op?: Operation): LayoutCanvas {
  const aspect = params.aspectRatio ?? model.defaults?.aspectRatio;
  const res = params.resolution ?? model.defaults?.resolution;
  if (model.engine !== "open") {
    const route = op ? routesFor(model, op)[0] : model.routes[0];
    const size = route?.map?.size ?? route?.preview?.size;
    if (size) {
      const sent = size.key ? askedSize(params.extra?.[size.key]) : undefined;
      return { ...sizeValue(size, aspect, res, sent), asked: sizeValue({ ...size, min: undefined, max: undefined }, aspect, res, sent), exact: true };
    }
  }
  // A "<side>sq" tier (FLUX.3's 512sq / 768sq) is that square's area in the chosen aspect: a square of that side at 1:1.
  const sq = /^(\d+)sq$/i.exec(res ?? "");
  const side = sq ? Number(sq[1]) : 1024;
  const asked = computeDimensions(aspect, sq ? undefined : tier(res), { width: side, height: side }, LAYOUT_MULTIPLE);
  const fitted = model.engine === "open" ? fitCanvas(asked.width, asked.height, OPEN_CANVAS) : asked;
  return { ...fitted, asked, exact: model.engine === "open" };
}

/**
 * A layout compiled for this model: the person's words (or the draft's own caption) as its caption, every box checked
 * (a text box needs its words), the model's compiler (src/lib/layout-prompt.ts layoutCompilerFor) at the canvas it
 * renders. A pixel layout (MOSS-Image) also names that canvas, so both engines render the size it was compiled at:
 * params.extra.width / height on your GPU, the route's size field (fal's image_size) in the cloud. Bria FIBO 2 gets its
 * VGL beside the words. Prompt rewriting is off for the run.
 */
function planLayout(model: ModelDef, op: Operation, prompt: string, drawn: LayoutDraft, params: GenParams): { prompt: string; params: GenParams; layout: NonNullable<Plan["layout"]> } {
  const draft: LayoutDraft = { ...drawn, summary: { ...drawn.summary, caption: prompt.trim() || drawn.summary.caption.trim() } };
  const format = model.options.layout;
  const pixels = format === "moss";
  const canvas = layoutCanvas(model, params, op);
  // Only a pixel layout depends on the canvas (its sides on MOSS's 16 px grid); the others place boxes on a 0-1000 grid or in words.
  const checkedAt = pixels ? canvas : { width: 1024, height: 1024 };
  // A route that takes the boxes as a field of their own (fal's FLUX 3 Klein bounding_boxes) gets them there, and the
  // caption that names them as its prompt; everything else reads the boxes in its prompt.
  const boxes = routesFor(model, op)[0]?.map?.boundingBoxes;
  const problem = validateLayout(draft, checkedAt.width, checkedAt.height, boxes ? "flux3-boxes" : (format ?? "words")).find((i) => i.level === "error");
  if (problem) throw new Error(problem.message);
  const compiled = boxes && draft.items.length ? { format: "flux3" as const, prompt: flux3Caption(draft) } : layoutCompilerFor(model)(draft, canvas.width, canvas.height);
  const extra: Record<string, unknown> = { ...params.extra };
  if (boxes) {
    if (draft.items.length) extra[boxes.key] = flux3Boxes(draft).slice(0, boxes.max);
    else delete extra[boxes.key];
  }
  if (pixels && draft.items.length) {
    const route = routesFor(model, op)[0];
    const key = (route?.map?.size ?? route?.preview?.size)?.key;
    if (model.engine === "open") Object.assign(extra, { width: canvas.width, height: canvas.height });
    else if (key) extra[key] = { width: canvas.width, height: canvas.height };
  }
  if (compiled.vgl && draft.items.length) extra.vgl = compiled.vgl;
  return {
    prompt: compiled.prompt,
    params: { ...params, enhancePrompt: false, extra },
    layout: { format: compiled.format, boxes: draft.items.length, ...(pixels && { width: canvas.width, height: canvas.height }) },
  };
}

/**
 * A control whose value stands for several settings (ModelOptions.controls[].sets: MOSS-Image's Quality is 50 steps,
 * CFG 3 and euler on your GPU) writes them into params.extra in its own place; a setting the request gives itself wins.
 * The request as asked (Reuse) keeps the control's value.
 */
export function controlSets(model: ModelDef, params: GenParams): GenParams {
  const controls = (model.options.controls ?? []).filter((c) => c.sets);
  if (!controls.length) return params;
  const extra: Record<string, unknown> = { ...params.extra };
  for (const c of controls) {
    const value = extra[c.param] ?? c.default;
    delete extra[c.param];
    const chosen = value === undefined || value === null ? undefined : c.sets?.[String(value)];
    for (const [k, v] of Object.entries(chosen ?? {})) if (!(k in extra)) extra[k] = v;
  }
  return { ...params, extra: Object.keys(extra).length ? extra : undefined };
}

/**
 * Remove background and Depth map options (Higgsfield's Video tools): what to keep, the cut-out or its alpha mask,
 * the colour map and side by side, each checked against what the model makes, so nothing is quietly swapped.
 */
function checkVideoToolOptions(model: ModelDef, op: "bg-remove-video" | "depth-video", prompt: string, params: GenParams) {
  const o = model.options;
  if (op === "bg-remove-video") {
    // A segmenter keeps what is named (or clicked, where its route reads points): with neither it keeps nothing.
    const clicked = !!params.points?.length && routesFor(model, op).some((r) => !!r.map?.points);
    if (o.keepsNamed && !prompt && !clicked) throw new Error("Say what to keep, e.g. “the dog” or “the woman in red”");
    const outputs = o.matteOutputs ?? ["cutout"];
    // ProRes 4444 and EXR carry the cut-out with its alpha (CorridorKey, VRMBG 3.0 on your GPU): not the mask or the foreground.
    if (params.format && o.formats?.length) keyFormatValues(params.format, params.matteOutput);
    if (params.matteOutput && !outputs.includes(params.matteOutput)) {
      throw new Error(
        params.matteOutput === "foreground"
          ? `${model.name} doesn't make a clean foreground — CorridorKey in Green screen does`
          : params.matteOutput === "matte"
            ? `${model.name} makes the cut-out only — pick BiRefNet or SAM for an alpha mask`
            : `${model.name} makes the alpha mask only — pick BiRefNet for a cut-out video`,
      );
    }
    return;
  }
  const maps = o.colormaps ?? ["grayscale"];
  if (params.colormap && !maps.includes(params.colormap.toLowerCase())) {
    throw new Error(
      model.engine === "open"
        ? `${model.name} draws ${maps.length > 1 ? `${maps.slice(0, -1).join(", ")} or ${maps.at(-1)}` : "grayscale only"} — the open engine has no ${params.colormap}; it's on the cloud`
        : `${model.name} has no ${params.colormap} colour map`,
    );
  }
  if (params.sideBySide && !o.sideBySide) throw new Error(`${model.name} can't put the original next to the depth map`);
}

/**
 * Keyframes: one time per image, from 0 up, inside the clip, no more than the model takes. The open
 * chain (one start/end-frame clip per pair) also needs every gap to be a clip its model can make.
 */
function checkKeyframes(model: ModelDef, n: number, params: GenParams) {
  // Keyframe animation: the film is as long as its gaps (params.extra.inbetween, else made from the times), each gap one pass.
  if (model.options.inbetween) {
    requestTiming(params.extra, n, params.keyframeTimes, model.engine);
    return;
  }
  const chain = keyframeChain(model);
  const max = chain ? MAX_KEYFRAMES : model.options.maxImages;
  if (max && n > max) throw new Error(`${model.name} takes up to ${max} keyframes`);
  const times = params.keyframeTimes;
  const duration = params.duration ?? model.defaults?.duration;
  if (times?.length) {
    if (times.length !== n) throw new Error(`Give each of the ${n} keyframes a time`);
    if (times.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= times[i - 1]))) throw new Error("Keyframe times start at 0 or later and go up");
    // The open chain's film starts on the first frame (FLUX 3 Max can start it later).
    if (chain && times[0] !== 0) throw new Error(FIRST_AT_ZERO);
    const last = times[times.length - 1];
    if (duration !== undefined && last > duration) throw new Error(`The last keyframe is at ${last}s — make the clip at least that long`);
  }
  if (chain && n > 1) {
    const length = duration ?? 5;
    const problem = chainGapProblem(times?.length ? times : frameTimes(spread(n), length), length, chainTiming(model));
    if (problem) throw new Error(problem);
  }
}

type InputKey = keyof NonNullable<GenerationRequest["inputs"]>;

const NEEDS: Partial<
  Record<
    Operation,
    { images?: number; video?: boolean; videos?: number; audio?: boolean; audios?: number; endImage?: boolean; mask?: boolean; model3d?: boolean; oneOf?: InputKey[]; msg: string }
  >
> = {
  edit: { images: 1, msg: "Add an image to edit" },
  inpaint: { images: 1, mask: true, msg: "Add an image and paint the area to change" },
  outpaint: { images: 1, msg: "Add an image to extend" },
  i2v: { images: 1, msg: "Add a start frame" },
  flf2v: { images: 1, endImage: true, msg: "Add a start and an end frame" },
  ref2v: { oneOf: ["images", "videos", "audios"], msg: "Add reference images" },
  v2v: { video: true, msg: "Add a video" },
  avatar: { images: 1, audio: true, msg: "Add a portrait and a voice track" },
  lipsync: { video: true, audio: true, msg: "Add a video and a voice track" },
  "motion-transfer": { images: 1, video: true, msg: "Add a character image and a driving video" },
  "upscale-image": { images: 1, msg: "Add an image to upscale" },
  "upscale-video": { video: true, msg: "Add a video to upscale" },
  "bg-remove": { images: 1, msg: "Add an image" },
  "face-swap": { images: 2, msg: "Add a target photo and a face" },
  v2a: { video: true, msg: "Add a video" },
  interpolate: { video: true, msg: "Add a video" },
  extend: { video: true, msg: "Add the video to continue" },
  reframe: { video: true, msg: "Add a video to reframe" },
  "voice-change": { audio: true, msg: "Add the recording to re-voice" },
  "bg-remove-video": { video: true, msg: "Add a video" },
  "depth-video": { video: true, msg: "Add a video" },
  "relight-video": { video: true, msg: "Add a video to relight" },
  concat: { videos: 2, msg: "Add at least two clips to join" },
  frame: { video: true, msg: "Add a video" },
  "color-match": { images: 1, msg: "Add the image or video and a reference image" },
  // round 3 (open engine)
  trim: { video: true, msg: "Add the video to trim" },
  mux: { video: true, audio: true, msg: "Add a video and the soundtrack to put on it" },
  captions: { video: true, msg: "Add the video to caption" },
  layers: { images: 1, msg: "Add the image to split into layers" },
  "image-to-3d": { images: 1, msg: "Add a product or object photo" },
  // round 3 (cloud catalog)
  "text-layers": { images: 1, msg: "Add the image to lift the text from" },
  vectorize: { images: 1, msg: "Add the image to turn into an SVG" },
  transcribe: { oneOf: ["audio", "video"], msg: "Add the audio or video to transcribe" },
  "separate-audio": { oneOf: ["audio", "video"], msg: "Add the audio or video to split" },
  "enhance-voice": { oneOf: ["audio", "video"], msg: "Add the audio or video to clean" },
  "speech-edit": { oneOf: ["audio", "video"], msg: "Add the recording to edit" },
  level: { audio: true, msg: "Add the audio to level" },
  // round 4
  "remove-object": { video: true, msg: "Add the video to remove something from" },
  "video-swap": { video: true, images: 1, msg: "Add the video and a picture of what goes in" },
  "video-insert": { video: true, images: 1, msg: "Add the video and a picture of what to add" },
  keyframes: { images: 1, msg: "Add the keyframes, in order" },
  "sdr-to-hdr": { video: true, msg: "Add the video to convert" },
  "face-mosaic": { images: 1, msg: "Add the picture whose faces to pixelate" },
  "watermark-scan": { images: 1, msg: "Add the picture to check" },
  "watermark-remove": { images: 1, msg: "Add the picture to clean" },
  "restore-video": { video: true, msg: "Add the archive clip to restore" },
  "song-extend": { audio: true, msg: "Add the song to extend" },
  "song-remix": { audio: true, msg: "Add the song to remix" },
  "song-stems": { audio: true, msg: "Add the song to split into stems" },
  "export-video": { video: true, msg: "Add the video to export" },
  ocr: { images: 1, msg: "Add the image to read" },
  "still-motion": { images: 1, msg: "Add the still to move over" },
  "audio-loop": { audio: true, msg: "Add the audio to loop" },
  "audio-join": { audios: 2, msg: "Add at least two audio clips to join" },
  "scene-3d": { images: 1, msg: "Add the image to build the scene from" },
  splat: { images: 1, msg: "Add a photo of the subject" },
  "rig-3d": { model3d: true, msg: "Add the 3D model to rig" },
  "refine-3d": { model3d: true, images: 1, msg: "Add the 3D model to refine and the photo it was made from" },
  "retexture-3d": { model3d: true, msg: "Add the 3D model to retexture" },
  "insert-moment": { video: true, msg: "Add the clip to insert a moment into" },
  "extract-frames": { video: true, msg: "Add the video to take frames from" },
  "images-to-video": { images: 1, msg: "Add the images, in order" },
  overlay: { images: 2, msg: "Add the picture and the overlay to put on it" },
  // Character swap in 2K: the footage, the redrawn swap and the swap, and the person's mask (video-composite-mask).
  composite: { videos: 3, mask: true, msg: "Add the footage, the redrawn clip, the swap and the person's mask to put the character back over it" },
  // N7-5 (the open engine also needs the browser's render along the path: its model's options.requires.video)
  "camera-path": { images: 1, msg: "Add the still to film along the path" },
  // Genjutsu's Openjutsu modes
  "group-swap": { video: true, images: 1, msg: "Add the clip and your characters" },
  "scene-edit": { video: true, msg: "Add the clip to edit" },
  "picture-frame": { video: true, msg: "Add the clip whose first frame sets the pose" },
  "picture-video": { video: true, images: 1, msg: "Add the clip and the first frame" },
  "face-fix-video": { video: true, images: 1, msg: "Add the video and the character photo" },
  "tone-video": { video: true, msg: "Add the video to finish" },
  "describe-video": { video: true, msg: "Add the clip to describe" },
};

const given = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);

/** Human message for the first missing input of an operation, or null. */
export function missingInputs(op: Operation, req: Pick<GenerationRequest, "inputs">): string | null {
  const n = NEEDS[op];
  if (!n) return null;
  const i = req.inputs ?? {};
  if (n.images && (i.images?.length ?? 0) < n.images) return n.msg;
  if (n.video && !i.video) return n.msg;
  // A join may also be one clip and a still appended after it (an ad and its end card).
  const clips = (i.videos?.length ?? 0) + (op === "concat" && i.video && i.images?.length ? 2 : 0);
  if (n.videos && clips < n.videos) return n.msg;
  if (n.audio && !i.audio) return n.msg;
  if (n.audios && (i.audios?.length ?? 0) < n.audios) return n.msg;
  if (n.endImage && !i.endImage) return n.msg;
  if (n.mask && !i.mask) return n.msg;
  if (n.model3d && !i.model3d) return n.msg;
  if (n.oneOf && !n.oneOf.some((k) => given(i[k]))) return n.msg;
  return null;
}

const INPUT_WORDS: Partial<Record<InputKey, string>> = {
  images: "reference images",
  videos: "reference videos",
  audios: "reference audio",
  audio: "audio",
  video: "video",
};

/** Whether a route's field map has a place for this input. */
function readsInput(map: NonNullable<ModelRoute["map"]>, k: InputKey): boolean {
  if (k === "images") return !!(map.image || map.images);
  if (k === "video") return !!(map.video || map.videoArray);
  return !!map[k as keyof typeof map];
}

/**
 * For "this or that" inputs: what was attached is something none of the model's routes can send
 * (Demucs splits audio, not a video; a reference-to-video model that only takes images was given clips).
 * Needs the routes' field maps, so only the server (full catalog) checks it.
 */
function unreadInputs(model: ModelDef, op: Operation, req: Pick<GenerationRequest, "inputs">): string | null {
  const keys = NEEDS[op]?.oneOf;
  const routes = routesFor(model, op);
  if (!keys || !routes.length || routes.some((r) => !r.map)) return null;
  const i = req.inputs ?? {};
  const attached = keys.filter((k) => given(i[k]));
  const reads = (k: InputKey) => routes.some((r) => readsInput(r.map!, k));
  if (!attached.length || attached.some(reads)) return null;
  const words = keys.filter(reads).map((k) => INPUT_WORDS[k] ?? k);
  return words.length ? `${model.name} works from ${words.join(" or ")} — add one` : null;
}

/**
 * More images than the operation's routes read (ModelRoute.maxImages): refused, never dropped without a word (a reference
 * added in the Inpaint studio would be ignored by Qwen-Image 2.1's inpaint graph).
 */
function extraImages(model: ModelDef, op: Operation, req: Pick<GenerationRequest, "inputs">): string | null {
  const routes = routesFor(model, op);
  if (!routes.length || routes.some((r) => r.maxImages === undefined)) return null;
  const max = imageLimit(model, op)!;
  if ((req.inputs?.images?.length ?? 0) <= max) return null;
  if (max === 1 && op === "inpaint") return `${model.name} paints the masked area of one picture — remove the references, or clear the mask to edit with them`;
  if (max === 1 && op === "outpaint") return `${model.name} expands one picture at a time — remove the other images`;
  return `${model.name} takes up to ${max} image${max === 1 ? "" : "s"} for this — remove the others`;
}

/**
 * What a hosted endpoint would refuse after it's paid for, caught first in Fuobe's words: a prompt over the API's own limit
 * (FieldMap.promptMax: Vidu Q4 5,000 characters), a moment inserted outside the clip's first 60 s (H3 Max insert), a relight
 * without its lit sphere, a retexture with neither words nor a style picture.
 */
export function hostedInputProblem(model: Pick<ModelDef, "name" | "routes" | "options">, op: Operation, prompt: string, params: GenParams, req: Pick<GenerationRequest, "inputs">): string | null {
  const max = Math.min(...model.routes.filter((r) => r.op === op && r.map?.promptMax).map((r) => r.map!.promptMax!));
  if (Number.isFinite(max) && prompt.length > max) {
    return `${model.name} takes up to ${max.toLocaleString("en-US")} characters of prompt, and this one has ${prompt.length.toLocaleString("en-US")}: shorten it`;
  }
  const refs = referenceProblem(model, op, req);
  if (refs) return refs;
  if (op === "insert-moment") return insertRangeProblem(params.startTime, params.endTime, params.sourceDuration);
  if (op === "relight-video" && model.options.lightSphere && !req.inputs?.images?.length) return `Pick a light: ${model.name} matches the light on a sphere you choose`;
  if (op === "retexture-3d" && !prompt.trim() && !req.inputs?.images?.length) return "Describe the new look, or add a style picture";
  return null;
}

/** Ops whose image, clip and sound lists are references (a join's clip list has its own limit: audio-join). */
const REFERENCE_OPS = new Set<Operation>(["ref2v", "insert-moment", "extend"]);
const plural = (n: number, [one, many]: readonly [string, string]) => `${n} ${n === 1 ? one : many}`;

/**
 * Reference lists past what the endpoint's lists take (their schema's maxItems, or the count its description gives: H3 Max insert
 * 9 pictures and 3 clips, Vidu Q4 12 pictures and 3 voices), past a total across the lists (ModelOptions.maxReferences: H3 Max
 * Turbo's 12 files), or a voice in a format the endpoint doesn't read (ModelOptions.referenceAudio: Vidu Q4's mp3). Only lists a
 * route of `op` sends whole, so a start frame or an element's pictures are never counted; needs the routes' field maps.
 */
function referenceProblem(model: Pick<ModelDef, "name" | "routes" | "options">, op: Operation, req: Pick<GenerationRequest, "inputs">): string | null {
  if (!REFERENCE_OPS.has(op)) return null;
  const routes = model.routes.filter((r) => r.op === op);
  if (!routes.length || routes.some((r) => !r.map || r.map.elements || r.map.image)) return null;
  const sends = (k: "images" | "videos" | "audios") => routes.every((r) => !!r.map![k]);
  const i = req.inputs ?? {};
  const counts = { images: sends("images") ? (i.images?.length ?? 0) : 0, videos: sends("videos") ? (i.videos?.length ?? 0) : 0, audios: sends("audios") ? (i.audios?.length ?? 0) : 0 };
  const limits = { images: imageLimit(model, op), videos: model.options.maxVideos, audios: model.options.maxAudios };
  const words = { images: ["picture", "pictures"], videos: ["clip", "clips"], audios: ["sound clip", "sound clips"] } as const;
  for (const k of ["images", "videos", "audios"] as const) {
    const most = limits[k];
    if (most !== undefined && counts[k] > most) return `${model.name} takes up to ${plural(most, words[k])} as references, and this run has ${counts[k]}: remove ${counts[k] - most}`;
  }
  const total = counts.images + counts.videos + counts.audios;
  const cap = model.options.maxReferences;
  if (cap !== undefined && total > cap) return `${model.name} takes up to ${cap} references in all — pictures, clips and sound together — and this run has ${total}: remove ${total - cap}`;
  const format = model.options.referenceAudio;
  if (format && counts.audios) {
    const ext = (u: string) => (u.startsWith("data:") ? (/^data:audio\/(mpeg|mp3)[;,]/i.test(u) ? "mp3" : "other") : /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(u)?.[1]?.toLowerCase());
    if (i.audios!.some((u) => { const e = ext(u); return e !== undefined && e !== format; })) return `${model.name} takes ${format.toUpperCase()} voice clips only: convert the others to ${format.toUpperCase()} first`;
  }
  return null;
}

/** Models that need several images (try-on: the person, then the garment). */
function missingImages(model: ModelDef, req: Pick<GenerationRequest, "inputs">): string | null {
  const min = model.options.minImages ?? 0;
  if ((req.inputs?.images?.length ?? 0) >= min) return null;
  const labels = model.options.imageLabels?.slice(0, min);
  return labels?.length === min ? `Add the ${labels.join(" and the ")}` : `${model.name} needs ${min} images`;
}

/**
 * Operations whose result is as long as the clip they're given (upscale, FPS Boost, HDR, export): a per-second
 * price counts the clip's seconds (params.sourceDuration) when the caller knows them, and slow motion bills
 * the whole stretched result.
 */
const CLIP_LENGTH_OPS = new Set<Operation>(["upscale-video", "interpolate", "sdr-to-hdr", "export-video", "restore-video", "relight-video"]);
/** Sound tools billed on the recording's length (per second or per minute of audio). */
const AUDIO_LENGTH_OPS = new Set<Operation>(["enhance-voice"]);

/**
 * The seconds a clip edit that keeps the clip's length is billed for (Happy Horse, Runway Aleph, Lucy Edit, Kling O3 4K
 * edit…: a v2v model with no length to ask for): the clip's (params.sourceDuration, when the caller knows it), up to the
 * most its window takes (./clip-windows), or its frames ÷ 16 on fal's Wan 2.2 Fun VACE (params.sourceFps; 30 fps when
 * not known). Undefined for a model asked for a length, or when the clip's length isn't known.
 */
export function clipEditSeconds(model: Pick<ModelDef, "id" | "options" | "routes"> & Partial<Pick<ModelDef, "engine">>, params: Pick<GenParams, "sourceDuration" | "sourceFps">, op?: Operation): number | undefined {
  const seconds = params.sourceDuration;
  if (op !== "v2v" || !seconds || !(seconds > 0) || model.options.durations?.length) return undefined;
  const routes = model.routes.filter((r) => r.op === "v2v");
  if (!routes.length || routes.some((r) => r.map?.duration)) return undefined;
  const max = sourceSeconds(model.id).max;
  // fal's Wan 2.2 Fun VACE bills a clip's frames ÷ 16 (a 30 fps clip about 1.9× its length): clip-windows.ts.
  return billedClipSeconds(model.id, max !== undefined ? Math.min(seconds, max) : seconds, params.sourceFps, model.engine);
}

/** The edits of a clip that keep its length: the clip goes in whole, and the result is as long (Kling 4.0's edit). */
const CLIP_EDIT_OPS = new Set<Operation>(["v2v", "video-swap", "video-insert", "remove-object"]);

export interface ClipBilling {
  /** Seconds of clips going in: the edited clip's and the reference clips'. */
  input: number;
  output: number;
  /** What's billed: input plus output, at least twice the output. */
  billed: number;
  /** Per billed second. */
  rate: number;
  /** The input's length isn't known yet (no clip header read): priced at the least it bills, twice the output. */
  guessed: boolean;
}

/**
 * How a run with a clip going in is billed, on a model that bills those runs on input plus output (Pricing.clipInput,
 * Kling 4.0): an edit of a clip (its length, params.sourceDuration, in and out: the edit keeps it), or a run with
 * reference clips or video elements (params.clipSeconds: their seconds; 0 while they aren't read yet). Undefined for
 * a run with no clip, or a model that bills them as any other.
 */
export function clipBilling(model: Pick<ModelDef, "pricing" | "defaults">, params: GenParams, op?: Operation, now?: PriceClock): ClipBilling | undefined {
  const p = model.pricing && pricingOn(model.pricing, now);
  const c = p?.clipInput;
  if (!c || p.unit !== "second") return undefined;
  const edit = !!op && CLIP_EDIT_OPS.has(op);
  if (!edit && params.clipSeconds === undefined) return undefined;
  const res = params.resolution ?? model.defaults?.resolution;
  const rate = (res && (c.byResolution?.[res] ?? c.byResolution?.[res.toLowerCase()])) || c.usd;
  const source = params.sourceDuration && params.sourceDuration > 0 ? params.sourceDuration : undefined;
  const output = edit ? (source ?? params.duration ?? model.defaults?.duration ?? 5) : (params.duration ?? model.defaults?.duration ?? 5);
  // Clips not read yet: on a model that bills them with no floor (Seedance 2.5), taken as long as the output until the
  // server reads their headers, rather than as nothing.
  const refs = Math.max(0, params.clipSeconds ?? 0) || (c.plain && !edit ? output : 0);
  const guessed = edit ? !source : !params.clipSeconds;
  const input = (edit ? (source ?? output) : 0) + refs;
  return { input, output, billed: c.plain ? input + output : Math.max(input + output, 2 * output), rate, guessed };
}

/**
 * The seconds a talking avatar is made (and billed) for a voice `seconds` long: as long as the voice, or what a
 * frame-count route's limits make of it, in the seconds it bills (fal's InfiniteTalk: 41–721 frames, 25 a second; Wan 2.2
 * S2V: 40–120 frames, a video second being 16 of them at any frame rate).
 */
export function avatarSeconds(model: Pick<ModelDef, "routes">, seconds: number, fps?: number): number {
  const f = model.routes.find((r) => r.op === "avatar" && r.map?.numFrames)?.map?.numFrames;
  const frames = f ? numFramesValue(f, { sourceDuration: seconds, fps }) : undefined;
  return f && frames ? frames / f.fps : seconds;
}

/**
 * A prompt without the trigger words of LoRAs a run leaves out: an open motion's template starts with its LoRA's
 * trigger ("e13c7r1c electricity effect. …", see withOssLoras), which means nothing to the model without the LoRA.
 * A trigger a kept LoRA shares stays.
 */
export function withoutTriggers(prompt: string, dropped: Pick<LoraRef, "trigger">[], kept: Pick<LoraRef, "trigger">[]): string {
  const keptTriggers = new Set(kept.map((l) => l.trigger).filter(Boolean));
  for (const l of dropped) {
    if (!l.trigger || keptTriggers.has(l.trigger)) continue;
    const lead = [". ", ", ", " "].map((sep) => l.trigger + sep).find((t) => prompt.startsWith(t));
    if (lead) prompt = prompt.slice(lead.length);
  }
  return prompt;
}

/**
 * Which of a plan's LoRAs a route really applies, and why the others are left out: ComfyUI loads every file
 * (injectLoras); a cloud route carries the ones fitLoras keeps (the licence allows hosting, there is a URL to
 * send, the API takes LoRAs and so many). The preview reports it, so a caller (the evaluation harness) records
 * the recipe that ran, not the one it asked for.
 */
export function routeLoras(route: Pick<ModelRoute, "provider" | "map" | "loraEndpoint">, loras: LoraRef[]): { applied: LoraRef[]; dropped: { file: string; reason: string }[] } {
  const applied = fitLoras(loras, route).loras;
  const field = routeLoraField(route);
  const why = (l: LoraRef) => {
    if (localOnly(l)) return "it is licensed for your GPU only, and Settings → Models & licences keeps such LoRAs off the cloud";
    // An optional gated LoRA (Relight, DoP's Slow motion); only a model's own gated adapter goes to the cloud, as Fuobe's copy.
    if (gated(l) && !l.hostedUrl && !l.adapter) return "it is in a gated Hugging Face repo, so it runs only on your GPU";
    if (!cloudPath(l) && !needsToken(l.url) && !l.own) return "no URL to send to the LoRA endpoint";
    if (!field) return "this route takes no LoRAs";
    return field.shape === "experts" ? "this API takes one LoRA per expert" : `this API takes up to ${loraCapacity(field)} LoRAs`;
  };
  return { applied, dropped: loras.filter((l) => !applied.includes(l)).map((l) => ({ file: l.file, reason: why(l) })) };
}

/**
 * The megapixels of video a frame-count model makes in `seconds` (Pricing.videoMegapixel: Fuobe Cinema's LTX-2.3): the
 * size its size table gives the tier and shape (an extend or an edit keeps its take's, priced the same), times the frames
 * its frame count renders. Undefined when no route has both.
 */
function videoMegapixels(model: ModelDef, params: GenParams, seconds: number): number | undefined {
  const sized = model.routes.find((r) => r.map?.size?.table && r.map.numFrames);
  const size = sized?.map?.size;
  const f = sized?.map?.numFrames;
  if (!size || !f) return undefined;
  const { width, height } = sizeValue(size, params.aspectRatio ?? model.defaults?.aspectRatio, params.resolution ?? model.defaults?.resolution);
  const frames = numFramesValue({ ...f, fromDuration: true }, { duration: seconds, fps: params.fps });
  return frames === undefined ? undefined : (width * height * frames) / 1e6;
}

/** The megapixels of a size sent as params.extra.image_size {width, height}, if one is. */
function sentMegapixels(params: GenParams): number | undefined {
  const size = params.extra?.image_size as { width?: unknown; height?: unknown } | undefined;
  const w = Number(size?.width);
  const h = Number(size?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? (w * h) / (1024 * 1024) : undefined;
}

/**
 * The megapixels the run's route makes when it sends a size (FieldMap.size: fal's MOSS-Image image_size): the aspect
 * ratio's size, or the size asked for (a layout's canvas) kept on the route's grid and within its limits, as the
 * payload sends it. fal's megapixel is 1024 × 1024 pixels. Undefined when the route sends no size.
 */
function routeMegapixels(model: ModelDef, params: GenParams, op?: Operation): number | undefined {
  const route = op ? model.routes.find((r) => r.op === op) : model.routes[0];
  // The browser's catalog keeps the size field as route.preview (slimModel).
  const size = route?.map?.size ?? route?.preview?.size;
  if (!size) return undefined;
  const asked = size.key ? askedSize(params.extra?.[size.key]) : undefined;
  const { width, height } = sizeValue(size, params.aspectRatio ?? model.defaults?.aspectRatio, params.resolution ?? model.defaults?.resolution, asked);
  return (width * height) / (1024 * 1024);
}

/**
 * A clip's price by its steps on the variant it runs (Pricing.steps: fal's Kandinsky 6.0): the settings the run carries, else
 * the ones its controls' defaults stand for; between two step counts fal prices, the line between them. Undefined when the
 * variant or the operation has no prices.
 */
function stepsPrice(model: ModelDef, s: NonNullable<Pricing["steps"]>, params: GenParams, op?: Operation): number | undefined {
  const own = controlSets(model, { extra: {} }).extra ?? {};
  const variant = String(params.extra?.[s.variantKey] ?? own[s.variantKey] ?? Object.keys(s.prices)[0]);
  const byOp = s.prices[variant];
  const table = byOp?.[op ?? model.routes[0]?.op] ?? Object.values(byOp ?? {})[0];
  const steps = Number(params.extra?.[s.stepsKey] ?? own[s.stepsKey]);
  if (!table || !Number.isFinite(steps)) return undefined;
  const points = Object.entries(table)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);
  if (!points.length) return undefined;
  const exact = points.find(([k]) => k === steps);
  if (exact) return exact[1];
  const hi = points.findIndex(([k]) => k > steps);
  // Outside the published counts: the nearest two's line, never below nothing.
  const [a, b] = hi <= 0 ? [points[0], points[1] ?? points[0]] : hi === -1 ? [points.at(-2) ?? points[0], points.at(-1)!] : [points[hi - 1], points[hi]];
  if (a[0] === b[0]) return a[1];
  return Math.max(0, a[1] + ((b[1] - a[1]) * (steps - a[0])) / (b[0] - a[0]));
}

/**
 * An upscale billed per output megapixel per frame (Pricing.outputFrames: fal's Kandinsky VSR): the clip's size times the
 * factor, every frame at the API's rate up to its cap. A clip not read yet is priced at the assumed size and the cap.
 */
function outputFramesPrice(o: NonNullable<Pricing["outputFrames"]>, params: GenParams, fallback?: string): number {
  const k = factorTier(params.resolution ?? fallback) ?? 2;
  const src = params.sourceSize?.width && params.sourceSize.height ? params.sourceSize : o.assume;
  const frames = params.sourceDuration && params.sourceDuration > 0 ? Math.min(o.maxFrames, Math.round(params.sourceDuration * o.fps)) : o.maxFrames;
  return o.usd * ((src.width * k * src.height * k) / 1e6) * frames;
}

/**
 * Rough USD estimate for a plan (BYO-key cloud runs). Open-source runs are free. A launch price (Pricing.promo) is read
 * at `now` (./promo): the clock when not given (the server planning a run, the browser after it hydrates); with null (a
 * page prerendering, the browser before it hydrates) a launch-priced model's price isn't known yet (null).
 */
export function estimateCost(model: ModelDef, params: GenParams, jobs = 1, op?: Operation, withLoras = false, now?: PriceClock): number | null {
  if (model.engine === "open" || !model.pricing) return model.engine === "open" ? 0 : null;
  const p = pricingOn(model.pricing, now);
  if (!p) return null;
  // A LoRA endpoint with no published price (fal's MOSS-Image /lora): unknown, never free.
  if (withLoras && p.lorasUnknown) return null;
  const n = params.numOutputs ?? 1;
  const res = params.resolution ?? model.defaults?.resolution;
  // A run with LoRAs goes to the LoRA endpoint, which has its own price.
  const at = (table: Record<string, number> | undefined) => (res && table ? (table[res] ?? table[res.toLowerCase()]) : undefined);
  // A song sung from the run's own lyrics costs less on Mureka (Pricing.withLyrics).
  const sung = p.withLyrics !== undefined && !!model.options.lyrics && !!lyricsOf(params.extra);
  const usd = withLoras && p.withLoras !== undefined ? (at(p.withLorasByResolution) ?? p.withLoras) : sung ? p.withLyrics! : at(p.byResolution) || p.usd;
  let per = usd;
  const clip = op && CLIP_LENGTH_OPS.has(op) && params.sourceDuration && params.sourceDuration > 0 ? params.sourceDuration * (op === "interpolate" ? Math.max(1, params.slowdown ?? 1) : 1) : undefined;
  // A talking avatar is as long as its voice (params.sourceDuration: the voice's header, read by the studio or the server).
  const voice = op === "avatar" && params.sourceDuration && params.sourceDuration > 0 ? avatarSeconds(model, params.sourceDuration, params.fps) : undefined;
  // A voice cleaned (DeepFilterNet 3, VEED) is billed on the recording's length (params.sourceDuration: its header).
  const audioClip = op && AUDIO_LENGTH_OPS.has(op) && params.sourceDuration && params.sourceDuration > 0 ? params.sourceDuration : undefined;
  if (p.unit === "image") per = usd * n;
  // Per image by tier, but per megapixel with LoRAs (fal's FLUX 3 Klein /lora): the route's size in megapixels.
  if (withLoras && p.withLorasPerMegapixel !== undefined) per = p.withLorasPerMegapixel * (routeMegapixels(model, params, op) ?? sentMegapixels(params) ?? 1) * n;
  // Per megapixel of every image made: Soul's sizes are known (about 1 or 2 MP), so is a size sent as fal's image_size
  // {width, height} (Fuobe Mixed Media's frames); other models are taken as 1 MP.
  if (p.unit === "megapixel") {
    const mp = soulKind(model)
      ? soulMegapixels(params.aspectRatio ?? model.defaults?.aspectRatio, params.resolution ?? model.defaults?.resolution)
      : (routeMegapixels(model, params, op) ?? sentMegapixels(params) ?? 1);
    per = usd * (p.roundUp ? Math.ceil(mp - 1e-9) : mp) * n;
  }
  const clipped = p.unit === "second" ? clipBilling(model, params, op, now) : undefined;
  if (clipped) per = clipped.rate * clipped.billed;
  else if (p.unit === "second") {
    // A length the caller set wins (Shorts, Mixed Media and Genjutsu say the seconds they bill); then a clip edit's clip.
    const asked = clip ?? voice ?? params.duration ?? clipEditSeconds(model, params, op) ?? audioClip ?? model.defaults?.duration ?? 5;
    const seconds = p.minSeconds ? Math.max(p.minSeconds, Math.ceil(asked - 1e-9)) : asked;
    const mp = p.videoMegapixel ? videoMegapixels(model, params, seconds) : undefined;
    const rate = p.videoMegapixel && (withLoras && p.videoMegapixel.withLoras !== undefined ? p.videoMegapixel.withLoras : p.videoMegapixel.usd);
    per = mp !== undefined && rate ? Math.ceil(mp - 1e-9) * rate : usd * seconds;
    // A long result billed at a higher rate throughout (fal's H3 Max lip sync: 1.2× over 15 s).
    if (p.longFactor && seconds > p.longFactor.over + 1e-9) per *= p.longFactor.factor;
  }
  if (p.unit === "minute") {
    // A sound tool (Clean up dialogue's VEED, a voice split) bills the clip's length when the caller knows it.
    const heard = (op === "separate-audio" || audioClip) && params.sourceDuration && params.sourceDuration > 0 ? params.sourceDuration : undefined;
    const minutes = (voice ?? params.duration ?? heard ?? 60) / 60;
    // Whole minutes of input, at least one (VEED Clean Audio: whole seconds, then up to the next full minute).
    per = usd * (p.roundUp ? Math.max(1, Math.ceil(Math.round(minutes * 60) / 60 - 1e-9)) : minutes);
  }
  if (p.steps) {
    const clip = stepsPrice(model, p.steps, params, op);
    if (clip !== undefined) per = clip * n;
  }
  if (p.outputFrames) per = outputFramesPrice(p.outputFrames, params, model.defaults?.resolution);
  // Settings that change the price (60 fps, a Pro tier, a cheaper model).
  for (const f of p.factors ?? []) {
    const v = f.param === "targetFps" ? (params.targetFps ?? model.defaults?.targetFps) : (params.extra?.[f.param] ?? model.options.controls?.find((c) => c.param === f.param)?.default);
    const k = v === undefined || v === null ? undefined : f.values[String(v)];
    if (k !== undefined && k > 0) per *= k;
  }
  if (params.generateAudio === false && model.options.audio === true && p.note?.includes("audio-off-half")) per /= 2;
  if (p.animationUsd && params.animation !== undefined && params.animation !== "") per += p.animationUsd;
  if (p.perRequest) per += p.perRequest;
  // A song tool's song goes up first unless it is one of the provider's own (Mureka's files/upload).
  if (p.uploadUsd && typeof params.extra?.songId !== "string") per += p.uploadUsd;
  if (p.generatedRefs && params.drawnRefs) per += p.generatedRefs.usd * Math.min(params.drawnRefs, p.generatedRefs.count);
  return Math.round(per * jobs * 1000) / 1000;
}
