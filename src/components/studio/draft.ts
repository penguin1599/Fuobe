/**
 * A studio's draft, built: what a page starts from (its link's hand-off), what Reuse brings back from a past run, and an
 * example a page loads into its composer. Plain functions, shared by the studio page and its tests.
 */
import { nanoid } from "nanoid";
import type { Generation, GenerationRequest, MediaKind, ModelDef, Preset } from "@/lib/catalog/types";
import { handoffFrames, presetModel, presetParams, routeParams, withoutLayout } from "@/lib/composer";
import { presetRoutes } from "@/lib/catalog/preset-recipe-routes";
import { positionsFrom, spread } from "@/lib/catalog/keyframes";
import { songFromRun } from "@/lib/lyrics";
import { reuseSignature, withSignatureWords } from "@/lib/catalog/palettes";
import { movedAppRequest } from "@/lib/catalog/plan";
import { studioResolutions } from "@/lib/catalog/regenerate";
import { currentModelId, migrateRequest } from "@/lib/catalog/replaced";
import { matchSpokenLanguage } from "@/lib/speech-languages";
import type { ExampleRequest } from "@/lib/examples/types";
import type { SlotValue } from "./media-slot";
import type { Draft, StudioConfig } from "./studio-context";

export function kindOfUrl(url: string): MediaKind {
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return "video";
  if (/\.(mp3|wav|ogg|flac|m4a)(\?|$)/i.test(url)) return "audio";
  return "image";
}

/** A slot holding a file by its URL (its own preview), with an id of its own. */
export const slot = (url: string | null | undefined, preview?: string): SlotValue | null =>
  url ? { ref: url, preview: preview ?? url, kind: kindOfUrl(url), id: nanoid(6) } : null;

export function initialDraft(
  config: StudioConfig,
  sp: URLSearchParams,
  engine: "cloud" | "open",
  lookup: { getModel: (id: string) => ModelDef | undefined; getPreset: (id: string) => Preset | undefined },
): Draft {
  const preset = sp.get("preset") ? lookup.getPreset(sp.get("preset")!) : config.preset;
  // A link or Assist hand-off that names a model Fuobe retired opens on the one that replaced it (replaced.ts).
  const requested = sp.get("model") && currentModelId(sp.get("model")!);
  const has = (id: string) => !!lookup.getModel(id);
  // An app starts on the model its preview was made with on this engine, else its own route (else the other engine's,
  // for an app with no version here); opened on one of its models (?model=, from ⌘K), on that model's route.
  const other = engine === "open" ? "cloud" : "open";
  const appRoutes = preset?.type === "app" ? [...presetRoutes(preset, engine, has), ...presetRoutes(preset, other, has)] : [];
  const appRoute = appRoutes.find((r) => !!requested && r.modelId === requested) ?? appRoutes[0];
  // A camera motion or effect starts on the model its preview was made with (MiniMax H3), else its Original (Fuobe DoP),
  // when the studio has it.
  const presetOwn = presetModel(preset, engine, has);
  const modelId =
    (requested && lookup.getModel(requested)?.id) ||
    appRoute?.modelId ||
    (presetOwn && lookup.getModel(presetOwn)?.id) ||
    config.defaultModels[engine] ||
    config.defaultModels.cloud ||
    // Open-only tools (Match colors) keep their open model under the Cloud switch, like cloud-only ones do under Open.
    config.defaultModels.open;
  const model = lookup.getModel(modelId);
  // The route's own settings (Wan 2.2 at 480p; a recipe on H3 at the Quality its cover was made at) on its own model.
  const routeSettings = appRoute && modelId === appRoute.modelId ? routeParams(appRoute, "app") : presetOwn && modelId === presetOwn ? presetParams(preset, engine, has) : {};
  const slots: Draft["slots"] = {};
  const imageSlot = config.slots.find((s) => s.accept === "image")?.key ?? preset?.inputs.find((s) => s.accept === "image")?.key;
  const refs: SlotValue[] = [];
  if (sp.get("image") && imageSlot) slots[imageSlot] = slot(sp.get("image"));
  if (sp.get("ref")) {
    if (config.multiRef) refs.push(slot(sp.get("ref"))!);
    else if (imageSlot) slots[imageSlot] = slot(sp.get("ref"));
  }
  if (sp.get("video")) slots.video = slot(sp.get("video"));
  if (sp.get("audio")) slots.audio = slot(sp.get("audio"));
  // A Mureka song handed over (a music result's Extend, Remix or Stems): its id goes with it.
  const song = sp.get("audio") && sp.get("song") ? { id: sp.get("song")!, url: sp.get("audio")! } : undefined;
  // A song's lyrics handed over with it (a sung result's Remix, which needs the whole song's words).
  const lyrics = sp.get("lyrics") ?? undefined;
  // A voice sample handed over (Clean up voice → "Use as a voice sample"): the voice a cloning model speaks with.
  if (sp.get("voice")) slots.voiceAudio = slot(sp.get("voice"));
  // An output format handed over in the link (Export → "ProRes in the cloud"), when the model writes it.
  const format = model?.options.formats?.find((f) => f === sp.get("format"));
  // A size handed over (Regenerate in 2K → 1440p), when the model offers it.
  const resolution = studioResolutions(model?.options)?.find((r) => r === sp.get("resolution"));
  // Stills handed over as frames (Storyboard's "Animate these panels", a Character Sheet's poses): Frames mode, evenly spaced.
  const handed = config.frames ? handoffFrames(sp.get("frames")) : [];
  const frames = handed.length ? handed.map((u, i) => ({ value: slot(u)!, at: spread(handed.length)[i] })) : undefined;
  return {
    prompt: sp.get("prompt") ?? "",
    negativePrompt: "",
    modelId,
    params: { ...model?.defaults, ...routeSettings, ...(format && { format }), ...(resolution && { resolution }) },
    slots,
    refs,
    presetId: sp.get("preset") ?? config.preset?.id,
    presetOptions: {},
    ...(frames && { frames }),
    ...(song && { song }),
    ...(lyrics && { lyrics }),
  };
}

/** Rebuild a composer draft from a past generation ("Reuse"). */
export function draftFromGeneration(g: Generation, config: StudioConfig, getModel: (id: string) => ModelDef | undefined, getPreset: (id: string) => Preset | undefined): Partial<Draft> {
  return draftFromRequest(g.request, config, getModel, getPreset);
}

/**
 * A composer draft from a run's request: Reuse of a past generation, and an example a page loads (applyExample). Every
 * input comes back to its slot: the pictures in slot order, the end frame, the painted area, the voice, the clip.
 */
export function draftFromRequest(request: GenerationRequest, config: StudioConfig, getModel: (id: string) => ModelDef | undefined, getPreset: (id: string) => Preset | undefined): Partial<Draft> {
  // A run styled by the Color signature / Moodboard chips comes back as it was before they routed it,
  // with the picks on the chips (studios without the chips get the styled prompt instead).
  const signed = config.signature ? reuseSignature(request) : null;
  const asked = signed ? { ...request, modelId: signed.modelId, params: signed.params } : config.signature ? request : withSignatureWords(request);
  // A run on a model Fuobe retired comes back on the one that replaced it (src/lib/catalog/replaced.ts): a Soul style
  // becomes its Fuobe look, the retired API's own settings are dropped. An app run on the model its app ran on before comes
  // back on the app's model now (movedAppRequest).
  const r = movedAppRequest(migrateRequest(asked).request, getModel, getPreset).request;
  const imgs = signed ? signed.images : (r.inputs?.images ?? []);
  const imageKeys = config.slots.filter((s) => s.accept === "image" && s.key !== "endImage" && s.key !== "mask").map((s) => s.key);
  const slots: Draft["slots"] = {};
  imageKeys.forEach((k, i) => (slots[k] = slot(imgs[i])));
  const refs = config.multiRef ? imgs.slice(imageKeys.length).map((u) => slot(u)!).filter(Boolean) : [];
  if (r.inputs?.endImage) slots.endImage = slot(r.inputs.endImage);
  if (r.inputs?.video) slots.video = slot(r.inputs.video);
  if (r.inputs?.audio) slots.audio = slot(r.inputs.audio);
  // The painted area of an inpaint (and its red-tinted picture), and the voice a cloning model speaks with.
  if (r.inputs?.mask) slots.mask = slot(r.inputs.mask);
  if (r.inputs?.sketch) slots.sketch = slot(r.inputs.sketch);
  if (r.inputs?.voiceAudio) slots.voiceAudio = slot(r.inputs.voiceAudio);
  if (r.inputs?.voiceAudio2) slots.voiceAudio2 = slot(r.inputs.voiceAudio2);
  const params = { ...r.params };
  // A keyframes run comes back in Frames mode, each still at its place in the clip.
  const times = params.keyframeTimes;
  const frames =
    config.frames && times?.length && times.length === imgs.length && imgs.length > 1
      ? positionsFrom(times, params.duration ?? times[times.length - 1]).map((at, i) => ({ value: slot(imgs[i])!, at }))
      : undefined;
  delete params.keyframeTimes;
  // A spoken language stored as a name (Assist's "Spanish") or a locale comes back as the model's own code.
  const languages = getModel(r.modelId)?.options.sourceLanguages;
  if (languages?.length && params.sourceLanguage) params.sourceLanguage = matchSpokenLanguage(params.sourceLanguage, languages) ?? params.sourceLanguage;
  // A song's lyrics come back in the lyrics editor. One of Mureka's own songs (an extend or remix by its id) comes back as
  // the attached song's id, so a song swapped in afterwards is sent as itself, never as the old id.
  const sung = songFromRun(params.extra, r.inputs?.audio);
  params.extra = sung.extra;
  const { lyrics, song } = sung;
  // A layout run comes back in Layout mode (studios that have it): its boxes in the editor, the prompt as their caption.
  const laid = config.layout ? withoutLayout(params) : { params, layout: undefined };
  return {
    prompt: r.prompt ?? "",
    negativePrompt: r.negativePrompt ?? "",
    modelId: r.modelId,
    params: laid.params,
    layout: laid.layout,
    slots: frames ? {} : slots,
    refs: frames ? [] : refs,
    frames,
    presetId: r.presetId,
    presetOptions: r.presetOptions ?? {},
    presetStrength: r.presetStrength,
    mix: r.mix,
    signature: signed?.signature,
    lyrics,
    song,
  };
}

/**
 * An example's draft (a page's "Start from an example"): its own files, words and settings over the page's starting
 * draft (`base`: initialDraft for the page, opened on the example's preset). An example that names no model keeps the
 * base's, so it runs on whichever engine the visitor is on, through the preset's own route there. Slots the example
 * doesn't fill are cleared: the draft holds nothing else.
 */
export function applyExample(
  example: ExampleRequest,
  base: Draft,
  config: StudioConfig,
  lookup: { getModel: (id: string) => ModelDef | undefined; getPreset: (id: string) => Preset | undefined },
): Draft {
  const modelId = example.modelId ?? base.modelId;
  const request: GenerationRequest = { feature: config.feature, ...example, modelId, presetId: example.presetId ?? base.presetId };
  const d = draftFromRequest(request, config, lookup.getModel, lookup.getPreset);
  return {
    ...base,
    prompt: example.prompt ?? "",
    negativePrompt: "",
    modelId: d.modelId ?? modelId,
    // The route's own settings stay (the base), with what the example set over them.
    params: { ...base.params, ...(example.params ?? {}) },
    slots: d.slots ?? {},
    refs: d.refs ?? [],
    frames: undefined,
    layout: undefined,
    presetId: request.presetId,
    presetOptions: { ...(example.presetOptions ?? {}) },
    presetStrength: undefined,
    mix: undefined,
    // Set, not left out: the draft merges what it gets, and a Color signature picked earlier would change the run.
    signature: undefined,
  };
}
