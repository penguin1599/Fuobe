import "server-only";
import { getModel } from "@/lib/catalog";
import type { Engine } from "@/lib/catalog/types";
import { soulRecipe } from "@/lib/catalog/soul";
import { cleanState, INFLUENCER_LOOK, INFLUENCER_OPEN_MODELS, planInfluencer, type InfluencerRun, type InfluencerStart } from "@/lib/influencer";
import { createPipeline } from "./chains";
import { createGenerations } from "./generations";
import { ownSteps, planCaps, previewRun, runEngine } from "./photodump";

/**
 * AI Influencer builder runs (/influencer): the pure plan (src/lib/influencer.ts) for the engine the
 * install allows, priced or created as one batch. With a photo or clothing it is two chained jobs: the sheet (Fuobe
 * Soul in the cloud, the Soul Cast sheet graph on your GPU: a helper step) and the Qwen-Image-Edit pass you see.
 */

export interface InfluencerBody {
  engine: Engine;
  /** The builder's state as the page holds it; cleaned here (unknown, hidden and surplus picks dropped). */
  state: unknown;
  direction?: string;
  start: InfluencerStart;
  photo?: string;
  clothing?: string[];
  modelId?: string;
}

function plan(body: InfluencerBody) {
  const { state } = cleanState(body.state);
  const run: InfluencerRun = { ...body, engine: runEngine(body.engine), state };
  const p = planInfluencer(run, planCaps());
  // The Soul Cast sheet graph is Fuobe Soul's own base: the casting look's LoRAs and words go on it, as in Cinema's Soul Cast.
  const steps = p.steps.map((s) => {
    if (s.request.modelId !== INFLUENCER_OPEN_MODELS.sheet) return s;
    const recipe = soulRecipe("soul", s.request.prompt ?? "", { look: INFLUENCER_LOOK });
    return { ...s, request: { ...s.request, prompt: recipe.prompt, ...(recipe.loras.length && { loras: recipe.loras }) } };
  });
  return { ...p, steps };
}

/** What a run would make and cost, without starting it (errors come back as `error`). */
export function previewInfluencer(body: InfluencerBody) {
  try {
    const p = plan(body);
    const priced = previewRun(
      p.steps.map((s) => s.request),
      p.notes,
    );
    if ("error" in priced) return priced;
    // One sheet, whatever helper step makes it first; the price is every step's.
    return { ...priced, modelId: p.modelId, modelName: getModel(p.modelId)?.name ?? p.modelId, count: 1, steps: p.steps.length };
  } catch (e) {
    return { error: (e as Error).message, notes: [] };
  }
}

/** Its steps, for an account's checks: the face or clothing pass waits for the sheet. */
export const influencerSteps = (body: InfluencerBody) => ownSteps(plan(body).steps.map((s) => ({ request: s.request, ...(s.after && { deps: 1 }) })));

export function createInfluencer(body: InfluencerBody) {
  const p = plan(body);
  const last = p.steps[p.steps.length - 1];
  const title = last.request.title ?? "AI Influencer";
  if (p.steps.length === 1) {
    // One job: no "Step 1 of 1" on its tile.
    const items = createGenerations({ ...last.request, batchTitle: title });
    return { batchId: items[0]?.batchId ?? items[0]?.id, items, sheet: items[items.length - 1], notes: p.notes, modelId: p.modelId };
  }
  const { batchId, items, byKey } = createPipeline(p.steps.map((s) => ({ ...s, request: { ...s.request, batchTitle: title } })));
  return { batchId, items, sheet: byKey[last.key], notes: p.notes, modelId: p.modelId };
}
