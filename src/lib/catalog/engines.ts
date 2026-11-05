/**
 * Which engine a model runs on. Most models run on one (ModelDef.engine). A Fuobe Original runs on both
 * (ModelDef.engines): its ComfyUI routes on the user's GPU, its hosted open-weight routes on fal / Replicate.
 * The composer's engine switch picks one (GenerationRequest.engine); onEngine() gives the model as it runs
 * there, so the rest of the app (planning, prices, route choice, the stored row) sees a one-engine model.
 * Pure, no catalog import: the browser and the server both use it.
 */
import type { Engine, ModelDef, ModelRoute, ProviderId } from "./types";

/** The engines a model runs on. */
export const enginesOf = (m: Pick<ModelDef, "engine" | "engines">): Engine[] => m.engines ?? [m.engine];

/** Runs on this engine (a Fuobe Original runs on both). */
export const runsOn = (m: Pick<ModelDef, "engine" | "engines">, engine: Engine): boolean => enginesOf(m).includes(engine);

/** A model that runs on both engines. */
export const dualEngine = (m: Pick<ModelDef, "engines"> | undefined): boolean => (m?.engines?.length ?? 0) > 1;

/** The engine a provider runs on: ComfyUI, the WorldCast worker and the browser are the open engine, the rest the cloud. */
export const providerEngine = (p: ProviderId): Engine => (p === "comfyui" || p === "local" || p === "worldcast" ? "open" : "cloud");

const views = new WeakMap<ModelDef, Partial<Record<Engine, ModelDef>>>();

/**
 * The model as it runs on `engine`: an Original keeps that engine's routes only, with its defaults and options there
 * (the same object every time, so React memos and caches stay put). Any other model comes back as it is.
 */
export function onEngine(m: ModelDef, engine: Engine): ModelDef {
  if (!dualEngine(m) || !runsOn(m, engine)) return m;
  let cached = views.get(m);
  if (!cached) views.set(m, (cached = {}));
  const own = m.engineDefaults?.[engine];
  const options = m.engineOptions?.[engine];
  return (cached[engine] ??= {
    ...m,
    engine,
    routes: m.routes.filter((r: ModelRoute) => providerEngine(r.provider) === engine),
    ...(own && { defaults: { ...m.defaults, ...own } }),
    ...(options && { options: { ...m.options, ...options } }),
  });
}

/**
 * The engine an Original runs on for a request: the one asked for, else the install's engine mode, else the
 * first one that has a provider connected (the user's GPU first: it is free), else the model's own (a demo).
 * Throws when the install's engine mode rules out the engine asked for.
 */
export function pickEngine(
  m: ModelDef,
  asked: Engine | undefined,
  mode: Engine | "both",
  ready: (engine: Engine) => boolean,
): Engine {
  const engines = enginesOf(m);
  if (asked && engines.includes(asked)) {
    if (mode !== "both" && asked !== mode) {
      throw new Error(
        mode === "open"
          ? `${m.name} on the cloud isn't available here. Switch to Open source to run it on your GPU`
          : `${m.name} on your GPU isn't available here. Switch to Cloud to run it there`,
      );
    }
    return asked;
  }
  if (mode !== "both" && engines.includes(mode)) return mode;
  return engines.find(ready) ?? m.engine;
}

const FREE_ON_GPU = String.raw`free on your GPU(?: \([^)]*\))?`;

/**
 * A model's note as a guest or a free account reads it, in a tool that doesn't run on their own GPU yet (the page says
 * so): without "free", "free on your GPU (24 GB)" and "on your GPU". "… · free on your GPU (24 GB) · Apache-2.0" →
 * "… · Apache-2.0"; "Qwen-Image-Edit 2511 on your GPU" → "Qwen-Image-Edit 2511".
 */
export function withoutOwnGpu(note: string): string {
  return note
    .split(" · ")
    .map((part) =>
      part
        .replace(new RegExp(`^(?:${FREE_ON_GPU}|free)(?:, (?:or )?|$)`), "")
        .replace(/^on your GPU(?:, |$)/, "")
        .replace(new RegExp(`,? ${FREE_ON_GPU}`, "g"), "")
        .replace(/ on your GPU\b/g, ""),
    )
    .filter(Boolean)
    .join(" · ");
}
