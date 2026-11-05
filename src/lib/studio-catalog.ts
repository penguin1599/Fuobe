/**
 * The slice of the model catalog one studio needs, computed on the server and passed to the
 * studio page as a prop, so the browser never downloads the whole catalog (every cloud, Higgsfield
 * and open model, 121 apps, 363 motions and effects). Only the composer's lookups are kept:
 * provider field maps stay on the server, which plans and builds the real request itself.
 */
import { getModel, modelsFor } from "./catalog";
import type { ModelDef } from "./catalog/types";
import type { StudioConfig } from "@/components/studio/studio-context";

export interface StudioCatalog {
  /** Models the composer can use or look up (picker list + defaults + the preset's own models). */
  models: ModelDef[];
  /** Models the composer only looks up, never lists (where a Color signature or Moodboard may route a request). */
  lookup?: ModelDef[];
}

/**
 * A model without its provider field maps (server-only detail), keeping what the composer previews results with. Its
 * pricing goes as it is, a launch price (Pricing.promo) and all: the page is prerendered at build time, so the browser
 * picks the price of the day it is (useToday), and nothing here reads the clock.
 */
export function slimModel(m: ModelDef): ModelDef {
  return {
    ...m,
    routes: m.routes.map((r) => {
      const copy = { ...r };
      delete copy.map;
      const { upscaleFactor, numFrames, size } = r.map ?? {};
      if (upscaleFactor || numFrames || size) copy.preview = { ...(upscaleFactor && { upscaleFactor }), ...(numFrames && { numFrames }), ...(size && { size }) };
      return copy;
    }),
  };
}

export function studioCatalog(config: Pick<StudioConfig, "kind" | "ops" | "pickerOps" | "defaultModels" | "preset" | "extraModels" | "appModels" | "greenScreen">): StudioCatalog {
  // Green-screen keyers are listed in Video tools → Green screen only; Remove background lists the other mattes.
  const keyers = config.ops.includes("bg-remove-video");
  const list = modelsFor({ kind: config.kind, ops: config.pickerOps ?? config.ops }).filter((m) => !keyers || !!m.options.greenScreen === !!config.greenScreen);
  const ids = new Set(list.map((m) => m.id));
  // An app's models on both engines: the one its preview was made with and its own route's (withRecipe).
  const own = [...(config.appModels?.cloud ?? []), ...(config.appModels?.open ?? [])];
  const extra = [config.defaultModels.cloud, config.defaultModels.open, config.preset?.cloud?.modelId, config.preset?.open?.modelId, ...own]
    .filter((id): id is string => !!id && !ids.has(id))
    .map((id) => getModel(id))
    .filter((m): m is ModelDef => !!m);
  const models = [...list, ...new Map(extra.map((m) => [m.id, m])).values()];
  const known = new Set(models.map((m) => m.id));
  const lookup = [...new Set(config.extraModels ?? [])]
    .filter((id) => !known.has(id))
    .map((id) => getModel(id))
    .filter((m): m is ModelDef => !!m);
  return { models: models.map(slimModel), ...(lookup.length ? { lookup: lookup.map(slimModel) } : {}) };
}
