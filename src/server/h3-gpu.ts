import "server-only";
import { deviceOf, H3_TIER_GRAPH, H3_TIER_MODEL, h3TierFor, H3_TIER_PARAM, TIER_BEST_NOTE, TIER_DECODER_NOTE, TIER_FLEX_REFUSAL, TIER_NOTES, tierChoice, tierGraphFor, tierOfGraph, SOL_VAE, type H3Tier, type H3TierChoice } from "@/lib/gpu/h3-tier";
import { getModel } from "@/lib/catalog";
import { H3_FLEX_GRAPH } from "@/lib/comfy-variants";
import { preflightOn } from "./gpu/index-file";
import { readSnapshot } from "./gpu/snapshots";
import { runTarget } from "./gpu/target";
import { isOffered, offReason } from "./model-access";
import { loadManifest } from "./providers/comfyui";
import { tenantAccount } from "./tenant";

/**
 * MiniMax H3's Options → GPU tier for one run (src/lib/gpu/h3-tier.ts), decided once while the run is planned: the GPU
 * pre-flight's gate and the provider then read the same tier and file from the run's options, so both take the same graph.
 *
 * - A tier asked for: that tier, with the file the card's last check calls for (refused, naming the switch, when Settings →
 *   Models & licences has it off). Trim asked for on a start-frame mode keeps the full model (Trim has text to video only).
 * - Auto: the tier the last GPU check's card gets (FastH3 V2 on 16-31 GB, Trim on 12-15 GB or 8-15 GB on Blackwell), when its
 *   switch is on and ComfyUI has accepted its graph (the manifest's `validated`); a CPU, no reading, an unknown card, 32 GB or more, or a card no build fits keep the full model, which the
 *   pre-flight then judges as it does today. Auto routes to a smaller build before its files are there: they are pinned and
 *   the pre-flight offers them, where the full model could never run on that card.
 * - An orbit keeps the Orbit LoRA graph (full model only).
 * - Quality → Fast · Pika Flex keeps the full model too (Pika's adapters are made for it): with Auto the run stays Standard
 *   and the pre-flight judges the card; FastH3 V2 or Trim picked with it is refused in plain words, so neither choice is dropped.
 */

export interface H3GpuChoice {
  /** The tier the run carries (params.extra.gpuTier). */
  gpuTier: H3TierChoice["tier"];
  /** The diffusion file a FastH3 graph loads on this card (params.extra.unet). */
  unet?: string;
  /** What the run says about it (FastH3's limits). */
  note?: string;
}

declare global {
  /** Tests only: every smaller H3 build's graph counts as accepted. */
  var __fuobeTestH3Accepted: boolean | undefined;
}

/** Whether ComfyUI has accepted a graph of the library (the manifest's `validated`). */
export function acceptedGraph(id: string): boolean {
  if (process.env.VITEST === "true" && globalThis.__fuobeTestH3Accepted) return true;
  return loadManifest().workflows.some((w) => w.id === id && w.validated === true);
}

/** A smaller H3 build Auto may pick: switched on in Models & licences, and every graph of it accepted by ComfyUI. */
export function tierOpen(tier: Exclude<H3Tier, "standard">): boolean {
  return isOffered(H3_TIER_MODEL[tier], "open") && Object.values(H3_TIER_GRAPH).every((t) => !t[tier] || acceptedGraph(t[tier]));
}

/** The last GPU check's card for a run in the current scope, when the pre-flight has one. */
function lastCard() {
  if (!preflightOn()) return undefined;
  const t = runTarget();
  const snap = t ? readSnapshot(t) : null;
  return snap?.inventory.reachable ? snap.inventory : undefined;
}

/**
 * Options → GPU tier for a MiniMax H3 run on `endpoint` (the route's graph before variants), or undefined when the run takes no
 * tier either way (another model, an orbit, a graph with no smaller build). A FastH3 graph itself keeps its own tier. `has`: is a graph in the library.
 */
export function h3Gpu(endpoint: string, extra: Record<string, unknown>, has: (id: string) => boolean, validated: (id: string) => boolean = acceptedGraph): H3GpuChoice | undefined {
  // A FastH3 graph run directly (its hidden model named in the request): its build is fixed, and the file is still the card's,
  // chosen here, never one the request names.
  const own = tierOfGraph(endpoint);
  if (own) return { gpuTier: own, unet: tierChoice(own, deviceOf(lastCard())).unet, note: TIER_NOTES[own] };
  if (!H3_TIER_GRAPH[endpoint] || extra.orbit === true) return undefined;
  const asked = extra[H3_TIER_PARAM];
  const flex = extra.quality === "flex" && !!H3_FLEX_GRAPH[endpoint] && has(H3_FLEX_GRAPH[endpoint]);
  // Fast · Pika Flex with Auto: the full model (the card's own tier never replaces it).
  if (flex && asked !== "fast" && asked !== "trim") return { gpuTier: "standard" };
  const inv = lastCard();
  const choice = h3TierFor(asked, deviceOf(inv));
  if (choice.tier === "standard") return { gpuTier: "standard" };
  const graph = tierGraphFor(endpoint, choice.tier, has);
  // Trim on a start-frame mode: the tier has no graph for it, so the full model runs.
  if (!graph) return { gpuTier: "standard" };
  // Auto routes to a smaller build only once ComfyUI has accepted its graph; until then only Options → GPU tier runs it.
  if (asked !== choice.tier && !validated(graph)) return { gpuTier: "standard" };
  // Fast · Pika Flex with a smaller tier picked: refused, rather than running one choice without the other.
  if (flex) throw new Error(TIER_FLEX_REFUSAL);
  const model = H3_TIER_MODEL[choice.tier];
  if (!isOffered(model, "open")) {
    if (asked !== choice.tier) return { gpuTier: "standard" };
    throw new Error(tenantAccount() ? `Pick 32 GB or more for ${choice.label.replace(/ \(.*\)$/, "")}` : offReason(getModel(model)!));
  }
  // (Options → Decoder has become the file it loads by now: controlSets in src/lib/catalog/plan.ts.)
  const notes = [TIER_NOTES[choice.tier], ...(extra.quality === "best" ? [TIER_BEST_NOTE] : []), ...(extra.vae === SOL_VAE ? [TIER_DECODER_NOTE] : [])];
  return { gpuTier: choice.tier, unet: choice.unet, note: notes.join(". ") };
}
