import "server-only";
import { MODELS } from "@/lib/catalog";
import { characterLora } from "@/lib/catalog/character-swap";
import { PIKA_FLEX_LORAS } from "@/lib/catalog/pika-flex";
import { H3_TURBO_4STEP_LORA, REGEN_LORA } from "@/lib/catalog/regenerate";
import { onEngine, providerEngine } from "@/lib/catalog/engines";
import { LORA_LIBRARY } from "@/lib/catalog/lora-library.generated";
import { libraryEntry, loraName } from "@/lib/catalog/loras";
import { OSS_LORAS } from "@/lib/catalog/oss-loras.generated";
import type { Engine, LoraRef, ModelDef, ModelLicence, ModelRoute } from "@/lib/catalog/types";
import type { ManifestWorkflow } from "@/lib/comfy";
import {
  BROWSER_LICENCE,
  CLASS_HINT,
  CLASS_LABEL,
  LICENCE_CLASSES,
  llmLicence,
  licenceInfo,
  UNKNOWN_LICENCE,
  loraLicenceInfo,
  mergeLicences,
  NODE_PACKS,
  paidApiLicence,
  PROVIDER_NAME,
  workflowLicence,
  type LicenceClass,
  type LicenceInfo,
} from "@/lib/licences";
import {
  accessSummary as summarize,
  ACCESS_PLACE,
  applyChange,
  gateModel,
  offMessage,
  offSwitches,
  parseAccess,
  routeOff,
  switchLabel,
  type AccessChange,
  type AccessList,
  type AccessSummary,
  type ModelEntry,
  type FactsOf,
  type ModelAccess,
} from "@/lib/model-access";
import { db } from "./db";
import { localModelInUse } from "./llm";
import { loadManifest } from "./providers/comfyui";
import { characterLoraLicence, loraLicenceRows, regenLoraLicence, turbo4StepLicence } from "@/lib/lora-licences";

/**
 * Settings → Models & licences on the server: the switches (one settings row, JSON), each route's licence and
 * node packs (the ComfyUI manifest for open routes, the provider's terms for paid ones), and the checks every
 * run, listing and automatic pick goes through. Licences are information; only the admin's switches turn
 * anything off, and everything is on by default.
 */

const KEY = "models.access";

let cached: { raw: string | null; llm: string; access: ModelAccess } | null = null;

/** The local text model as the licence reads it ("LM Studio|google/gemma-3-12b"). */
const llmKey = () => {
  const m = localModelInUse();
  return `${m.label}|${m.model}`;
};

/**
 * The switches in effect (the same object while they don't change, so gated model views stay cached). With a
 * licence class off, another local text model makes a new object too: its licence decides whether the class
 * switch reaches the text model.
 */
export function readAccess(): ModelAccess {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  const raw = row?.value ?? null;
  if (!cached || cached.raw !== raw) cached = { raw, llm: "", access: parseAccess(raw) };
  if (cached.access.classes.length) {
    const llm = llmKey();
    if (cached.llm !== llm) cached = { raw, llm, access: parseAccess(raw) };
  }
  return cached.access;
}

export function saveAccess(next: ModelAccess): ModelAccess {
  const raw = JSON.stringify(next);
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, raw);
  return readAccess();
}

/** Flip switches in one write (read, change, write inside one transaction). */
export function changeAccess(changes: AccessChange[]): ModelAccess {
  return db().transaction(() => saveAccess(changes.reduce(applyChange, readAccess())))();
}

// ---------------------------------------------------------------------------
// Licences and node packs per route

/** Workflow ids a ComfyUI endpoint names: one id, or a family (`video-concat-{n}`). */
function workflowsOf(endpoint: string, all: ManifestWorkflow[]): ManifestWorkflow[] {
  if (!endpoint.includes("{")) return all.filter((w) => w.id === endpoint);
  const re = new RegExp(`^${endpoint.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "\\d+")}$`);
  return all.filter((w) => re.test(w.id));
}

let factsCache: { manifest: object; byEndpoint: Map<string, { licence: LicenceInfo; packs: string[]; workflows: string[] }> } | null = null;

/** An open route's licence (its workflows' weights, the strictest one naming it), node packs and workflow ids. */
function comfyFacts(endpoint: string): { licence: LicenceInfo; packs: string[]; workflows: string[] } {
  const manifest = loadManifest();
  if (factsCache?.manifest !== manifest) factsCache = { manifest, byEndpoint: new Map() };
  const hit = factsCache.byEndpoint.get(endpoint);
  if (hit) return hit;
  const wfs = workflowsOf(endpoint, manifest.workflows);
  const largestFirst = (w: ManifestWorkflow) => [...w.models].sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0)).flatMap((m) => (m.url ? [m.url] : []));
  const facts = {
    licence: wfs.length ? mergeLicences(wfs.map((w) => licenceInfo(workflowLicence(w), largestFirst(w)))) : licenceInfo(workflowLicence({ id: endpoint })),
    packs: [...new Set(wfs.flatMap((w) => w.customNodes.map((n) => n.name)))],
    workflows: wfs.map((w) => w.id),
  };
  factsCache.byEndpoint.set(endpoint, facts);
  return facts;
}

/** A route's licence: the weights' for ComfyUI, the provider's terms for a paid API, Fuobe's own code in the browser. */
export function routeLicence(route: ModelRoute, model: Pick<ModelDef, "vendor" | "licence">): LicenceInfo {
  if (route.provider === "comfyui") return comfyFacts(route.endpoint).licence;
  // The WorldCast worker (N7-9): the weights it runs, as the catalog records them (ModelDef.licence).
  if (route.provider === "worldcast") return model.licence ? weightsLicence(model.licence) : licenceInfo(UNKNOWN_LICENCE);
  if (route.provider === "local") return BROWSER_LICENCE;
  if (route.provider === "llm") {
    const local = localModelInUse();
    return llmLicence(route.endpoint, local.model, local.label);
  }
  return paidApiLicence(model.vendor, [route]);
}

export const factsOf: FactsOf = (route, model) => ({
  class: routeLicence(route, model).class,
  packs: route.provider === "comfyui" ? comfyFacts(route.endpoint).packs : [],
});

// ---------------------------------------------------------------------------
// The checks

/** The model as this install offers it (only its routes that are on), or undefined when it is off. */
export function offeredModel(m: ModelDef): ModelDef | undefined {
  return gateModel(m, readAccess(), factsOf);
}

/** Listings (the API, Assist, MCP, the CLI): only what is on, each model with the routes that are on. */
export function offeredModels(list: ModelDef[]): ModelDef[] {
  const access = readAccess();
  return list.flatMap((m) => gateModel(m, access, factsOf) ?? []);
}

/** Why a model is off, as the refusal names it ("…turned off in Settings → Models & licences (fal.ai is switched off)"). */
export function offReason(m: ModelDef, routes?: ModelRoute[]): string {
  return offMessage(m.name, offSwitches(m, readAccess(), factsOf, routes));
}

/**
 * The model a run may use, refusing one that is off with a message naming the switch. `engine` (an Original's
 * engine asked for) refuses that engine when only its routes are off.
 */
export function requireOffered(m: ModelDef, engine?: Engine): ModelDef {
  const view = offeredModel(m);
  if (!view) throw new Error(offReason(m));
  if (engine && m.engines?.includes(engine) && !view.engines?.includes(engine) && view.engine !== engine) {
    throw new Error(offReason(m, onEngine(m, engine).routes).replace(m.name, `${m.name} ${engine === "open" ? "on your GPU" : "in the cloud"}`));
  }
  return view;
}

/** The routes of these that are on (a run's candidates); throws naming the switches when none is. */
export function offeredRoutes(m: ModelDef, routes: ModelRoute[]): ModelRoute[] {
  const access = readAccess();
  const on = routes.filter((r) => !routeOff(m, r, access, factsOf));
  if (routes.length && !on.length) throw new Error(offReason(m, routes));
  return on;
}

/**
 * A LoRA the model's recipe can't run without (Fuobe Try-On's try-on LoRA, ModelOptions.loras) that Settings switches
 * off (by file or licence class): the model is on, but a run of it is refused naming that LoRA.
 */
export function recipeLoraOff(m: Pick<ModelDef, "options">): LoraRef | undefined {
  const loras = m.options.loras;
  if (!loras?.length) return undefined;
  const { dropped } = offeredLoras(loras);
  return loras.find((l) => dropped.some((d) => d.file === l.file));
}

/**
 * Whether a model id is offered (an unknown id is not): its switch and routes, and the LoRAs its recipe can't run
 * without, so a studio's picker and its server-side default move on to the next model.
 */
export function isOffered(id: string | undefined, engine?: Engine): boolean {
  const m = id ? MODELS.find((x) => x.id === id) : undefined;
  const view = m && offeredModel(m);
  return !!view && !recipeLoraOff(m!) && (!engine || !m!.engines || (view.engines ?? [view.engine]).includes(engine));
}

/**
 * A studio's default among its own models (Shorts' restyle models, a Layers tool's): the first that is on, else
 * the first (its run then refuses, naming the switch to turn back on).
 */
export function firstOn(ids: readonly string[], engine?: Engine): string | undefined {
  return ids.find((id) => isOffered(id, engine)) ?? ids[0];
}

/**
 * A default that is on, else the next model that is on and does the same job on this engine (same kind, an
 * operation in common, not a hidden helper), else the default itself: a run of it then refuses, naming the switch
 * to turn back on. Assist's own picks and the studios' defaults in /api/models go through it.
 */
export function offeredDefault(id: string | undefined, engine: Engine): string | undefined {
  if (!id || isOffered(id, engine)) return id;
  const own = MODELS.find((m) => m.id === id);
  if (!own) return id;
  const ops = new Set(onEngine(own, engine).routes.map((r) => r.op));
  const next = MODELS.find((m) => !m.hidden && m.id !== id && m.kind === own.kind && isOffered(m.id, engine) && onEngine(offeredModel(m)!, engine).routes.some((r) => ops.has(r.op) && providerEngine(r.provider) === engine));
  return next?.id ?? id;
}

/**
 * A default someone can run (`ready`: an account's own keys reach one of its providers), else the first model that is on,
 * does the same job on this engine and is ready, else the default itself (its run then asks for the key it needs).
 */
export function reachableDefault(id: string | undefined, engine: Engine, ready: (m: ModelDef) => boolean): string | undefined {
  const own = id ? MODELS.find((m) => m.id === id) : undefined;
  if (!own || ready(own)) return id;
  const ops = new Set(onEngine(own, engine).routes.map((r) => r.op));
  const next = MODELS.find((m) => !m.hidden && m.id !== id && m.kind === own.kind && isOffered(m.id, engine) && ready(m) && onEngine(offeredModel(m)!, engine).routes.some((r) => ops.has(r.op) && providerEngine(r.provider) === engine));
  return next?.id ?? id;
}

/**
 * The summary the browser filters its pickers with (undefined while everything is on). A model whose recipe LoRA is
 * switched off counts as off there too (isOffered).
 */
export function offeredSummary(): AccessSummary | undefined {
  const summary = summarize(MODELS, readAccess(), factsOf);
  const blocked = MODELS.filter((m) => recipeLoraOff(m) && !summary?.off.includes(m.id)).map((m) => m.id);
  return blocked.length ? { ...summary, off: [...(summary?.off ?? []), ...blocked] } : summary;
}

// ---------------------------------------------------------------------------
// LoRAs

/** A LoRA's licence: the ref's snapshot, else the library's; a LoRA with neither is the user's own. */
export function loraLicence(l: Pick<LoraRef, "file" | "url" | "licence">): LicenceInfo {
  // The Character swap's LoRAs carry MiniMax H3's own terms (restricted regions), or Turbo's Apache-2.0.
  const h3 = characterLora(l.file);
  if (h3) return characterLoraLicence(h3);
  if (l.file === REGEN_LORA.file) return regenLoraLicence();
  if (l.file === H3_TURBO_4STEP_LORA.file) return turbo4StepLicence();
  const e = libraryEntry(l);
  return loraLicenceInfo(l.licence ?? e?.licence, e?.page);
}

/**
 * The LoRAs a run may load: one switched off, or whose licence class is, is left out (the plan's notes say
 * which switch). With "keep GPU-only LoRAs on your GPU" on, each LoRA is marked so a cloud route leaves the ones
 * licensed for the user's GPU only out (src/lib/catalog/loras.ts localOnly).
 */
export function offeredLoras(loras: LoraRef[]): { loras: LoraRef[]; notes: string[]; dropped: { file: string; reason: string }[] } {
  const access = readAccess();
  const dropped: { file: string; reason: string }[] = [];
  const kept: LoraRef[] = [];
  for (const l of loras) {
    // The user's own LoRAs (a trained @character, no licence recorded) aren't anyone's licensed work: only their own switch counts.
    const own = !l.licence && !libraryEntry(l);
    const reason = access.loras.includes(l.file) ? "it is switched off" : !own && access.classes.includes(loraLicence(l).class) ? "its licence class is switched off" : undefined;
    if (reason) dropped.push({ file: l.file, reason: `${reason} in ${ACCESS_PLACE}` });
    else kept.push(access.keepGpuOnlyLoras ? { ...l, keepOnGpu: true } : l);
  }
  const notes = dropped.length ? [`${dropped.map((d) => loraName({ file: d.file })).join(", ")} ${dropped.length > 1 ? "are" : "is"} left out: turned off in ${ACCESS_PLACE}`] : [];
  return { loras: kept, notes, dropped };
}

// ---------------------------------------------------------------------------
// Settings → Models & licences: everything with its licence and its switch

const isOpenRoute = (r: ModelRoute) => providerEngine(r.provider) === "open";

/**
 * The open weights a hosted model runs (fal's MOSS-Image, Replicate's FLUX dev LoRA builds), as their own line: their
 * licence's name and class, and what the research noted about them and the host (fal's black-image safety checker).
 * `commercial` from the research decides the class when the licence's name alone doesn't say.
 */
function weightsLicence(l: ModelLicence): LicenceInfo {
  const info = licenceInfo(l.licence);
  const cls: LicenceClass =
    l.commercial === false ? (info.class === "research" ? "research" : "non-commercial") : l.commercial === null && info.class === "commercial" ? "conditions" : info.class;
  return { ...info, class: cls, note: l.note?.trim() || l.licence };
}

/**
 * A model's licence as the list shows it: the open half names it, the cloud half is said beside it. A hosted open model
 * (only cloud routes, open weights recorded) also gets `weights`: the provider's terms name it, the weights' line follows.
 */
export function modelLicence(m: ModelDef): { licence: LicenceInfo; cloud?: LicenceInfo; weights?: LicenceInfo; packs: string[] } {
  const open = m.routes.filter(isOpenRoute);
  const cloud = m.routes.filter((r) => !isOpenRoute(r));
  const packs = [...new Set(open.flatMap((r) => (r.provider === "comfyui" ? comfyFacts(r.endpoint).packs : [])))];
  const openLicence = open.length ? mergeLicences([...new Map(open.map((r) => [r.endpoint, routeLicence(r, m)])).values()]) : undefined;
  const cloudRoutes = cloud.filter((r) => r.provider !== "llm");
  const cloudLicence = cloudRoutes.length ? paidApiLicence(m.vendor, cloudRoutes) : cloud.length ? routeLicence(cloud[0], m) : undefined;
  if (openLicence) return { licence: openLicence, ...(cloudLicence && { cloud: cloudLicence }), packs };
  if (!cloudLicence) return { licence: { name: "Not recorded", class: "unknown", note: "" }, packs };
  return { licence: cloudLicence, ...(m.licence && cloudLicence.class === "paid-api" && { weights: weightsLicence(m.licence) }), packs };
}

/**
 * Whether a switch names something this install has (a model, a provider in use, a node pack, a LoRA the
 * library or the preset map loads): the settings API refuses a typo rather than storing a switch that does nothing.
 */
export function knownSwitch(kind: "model" | "provider" | "pack" | "lora", id: string): boolean {
  switch (kind) {
    case "model":
      return MODELS.some((m) => m.id === id);
    case "provider":
      return MODELS.some((m) => m.routes.some((r) => r.provider === id));
    case "pack":
      return NODE_PACKS.some((p) => p.name === id);
    case "lora":
      return LORA_LIBRARY.some((e) => e.file === id) || Object.values(OSS_LORAS).some((refs) => refs.some((r) => r.file === id)) || !!characterLora(id) || id === REGEN_LORA.file || PIKA_FLEX_LORAS.some((l) => l.file === id) || id === H3_TURBO_4STEP_LORA.file;
  }
}

export function accessList(): AccessList {
  const access = readAccess();
  const models: ModelEntry[] = MODELS.map((m) => {
    const { licence, cloud, weights, packs } = modelLicence(m);
    const others = { ...access, models: access.models.filter((x) => x !== m.id) };
    const off = m.routes.map((r) => routeOff(m, r, others, factsOf)).filter((s): s is NonNullable<typeof s> => !!s);
    const labels = [...new Set(off.map(switchLabel))];
    const all = off.length === m.routes.length;
    return {
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      kind: m.kind,
      ...(m.hidden && { hidden: true as const }),
      engines: m.engines ?? [m.engine],
      providers: [...new Set(m.routes.map((r) => r.provider))],
      licence,
      ...(cloud && { cloud }),
      ...(weights && { weights }),
      ...(m.engineNote && { engineNote: m.engineNote }),
      packs,
      on: !access.models.includes(m.id),
      offBy: all ? labels : [],
      partly: all ? [] : labels,
    };
  });
  const count = (f: (e: ModelEntry) => boolean) => models.filter(f).length;
  const routeClasses = (id: string) => {
    const m = MODELS.find((x) => x.id === id)!;
    return new Set(m.routes.map((r) => factsOf(r, m).class));
  };
  const classesOf = new Map(models.map((e) => [e.id, routeClasses(e.id)]));
  const loras = loraLicenceRows(access.loras);
  return {
    access,
    classes: LICENCE_CLASSES.map((id) => ({
      id,
      label: CLASS_LABEL[id],
      hint: CLASS_HINT[id],
      models: count((e) => classesOf.get(e.id)!.has(id)),
      loras: loras.filter((l) => l.licence.class === id).length,
      on: !access.classes.includes(id),
    })),
    providers: [...new Set(MODELS.flatMap((m) => m.routes.map((r) => r.provider)))].map((id) => ({
      id,
      label: PROVIDER_NAME[id] ?? id,
      models: count((e) => e.providers.includes(id)),
      on: !access.providers.includes(id),
    })),
    packs: NODE_PACKS.map((p) => ({ ...p, models: count((e) => e.packs.includes(p.name)), on: !access.packs.includes(p.name) })),
    models,
    loras,
  };
}
