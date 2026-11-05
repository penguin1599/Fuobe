import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getModel } from "@/lib/catalog";
import type { Engine } from "@/lib/catalog/types";
import { ownSetupGraphs, ownSetupOnly, type OwnSetup } from "@/lib/own-setup";

const MANIFEST = path.join(process.cwd(), "workflows", "comfyui", "manifest.json");

/** The graphs the manifest marks validated (empty when it can't be read). */
function validatedGraphs(manifest: string): Set<string> {
  try {
    const m = JSON.parse(fs.readFileSync(manifest, "utf8")) as { workflows?: { id?: string; validated?: boolean }[] };
    return new Set((m.workflows ?? []).filter((w) => w.validated === true && typeof w.id === "string").map((w) => w.id as string));
  } catch {
    return new Set();
  }
}

/**
 * Whether a model's ComfyUI graphs have all passed their check on this studio's GPU (the manifest's `validated`), read
 * when a page is made. Until then its surface marks it with what it runs on (src/lib/own-setup.ts); the mark leaves by
 * itself once the flags say so. False for a model with no ComfyUI graph, or when the manifest can't be read.
 */
export function graphsReady(modelId: string, manifest = MANIFEST): boolean {
  const graphs = (getModel(modelId)?.routes ?? []).filter((r) => r.provider === "comfyui").map((r) => r.endpoint);
  if (!graphs.length) return false;
  const validated = validatedGraphs(manifest);
  return graphs.every((g) => validated.has(g));
}

/**
 * ownSetupOnly as it stands now, for a server check (the hosted runs' pool gate, a price check): an item whose graphs
 * the manifest marks validated runs as any other (null); everything else is ownSetupOnly's answer.
 */
export function ownSetupOnlyNow(id: string, engine?: Engine, manifest = MANIFEST): OwnSetup | null {
  const graphs = ownSetupGraphs(id);
  if (graphs.length) {
    const validated = validatedGraphs(manifest);
    if (graphs.every((g) => validated.has(g))) return null;
  }
  return ownSetupOnly(id, engine);
}

/**
 * The setups of these own-setup items as they stand now, by id: an item whose graphs (own-setup.ts `graphs`) the
 * manifest marks validated has none (null), so its label leaves without a code change; any other keeps ownSetupOnly's.
 * A page reads this when it is made and hands it to its client, which can't read the manifest.
 */
export function ownSetupsNow<K extends string>(ids: readonly K[], manifest = MANIFEST): Record<K, OwnSetup | null> {
  const validated = validatedGraphs(manifest);
  const now = (id: K): OwnSetup | null => {
    const graphs = ownSetupGraphs(id);
    return graphs.length && graphs.every((g) => validated.has(g)) ? null : ownSetupOnly(id);
  };
  return Object.fromEntries(ids.map((id) => [id, now(id)])) as Record<K, OwnSetup | null>;
}
