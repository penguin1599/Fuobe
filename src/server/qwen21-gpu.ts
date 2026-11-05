import "server-only";
import { gpuVramGb, workflowReadiness } from "@/lib/gpu/readiness";
import { GPU_PARAM, SMALL_GPU_NOTE, smallGpu, smallGraphFor } from "@/lib/qwen21-speed";
import { getModel } from "@/lib/catalog";
import { loadIndex, preflightOn } from "./gpu/index-file";
import { contextFor } from "./gpu/readiness-service";
import { readSnapshot } from "./gpu/snapshots";
import { runTarget } from "./gpu/target";
import { isOffered, offReason } from "./model-access";
import { tenantAccount } from "./tenant";

/**
 * Qwen-Image 2.1's Options → GPU for one run (src/lib/qwen21-speed.ts), decided once while the run is planned: the GPU
 * pre-flight's gate and the provider then read the same choice from the run's options, so both take the same graph.
 *
 * - Small, asked for: the small encoder's graph (refused, naming the switch, when Settings → Models & licences has it off).
 * - Auto: the small encoder only when the last GPU check read a graphics card under 20 GB (rounded as the check reads it; a
 *   CPU or no reading never counts) and the small route is ready there (its add-on, model files and adapter), and its switch
 *   is on. Anything else runs the full graph.
 * - A speed with its own graph runs that graph, whatever the GPU choice.
 */

/** The hidden model whose switch, licence and pre-flight row the small route has. */
export const QWEN21_SMALL_MODEL = "oss-qwen-image-21-small";

export interface Qwen21GpuChoice {
  /** The choice the run carries ("small" | "large"). */
  gpu: "small" | "large";
  /** What the run says about it (Small's English-only limit). */
  note?: string;
}

/** Whether the small route is ready on the GPU this run goes to, and the card is under 20 GB, by its last check. */
function smallFits(graph: string): boolean {
  if (!preflightOn()) return false;
  const t = runTarget();
  const snap = t ? readSnapshot(t) : null;
  if (!t || !snap?.inventory.reachable) return false;
  if (!smallGpu(gpuVramGb(snap.inventory))) return false;
  return workflowReadiness(graph, snap.inventory, loadIndex(), contextFor(t)).state === "ready";
}

/**
 * Options → GPU for a Qwen-Image 2.1 run on `endpoint` (the route's graph before variants), or undefined when the run takes no
 * small-encoder graph either way (another model, inpaint or expand, a speed with its own graph). `has`: is a graph in the library.
 */
export function qwen21Gpu(endpoint: string, extra: Record<string, unknown>, has: (id: string) => boolean): Qwen21GpuChoice | undefined {
  const graph = smallGraphFor(endpoint, extra, has);
  if (!graph) return undefined;
  const asked = extra[GPU_PARAM];
  if (asked === "large") return { gpu: "large" };
  const on = isOffered(QWEN21_SMALL_MODEL, "open");
  if (asked === "small") {
    if (!on) throw new Error(tenantAccount() ? "Pick 20 GB or more for this model" : offReason(getModel(QWEN21_SMALL_MODEL)!));
    return { gpu: "small", note: SMALL_GPU_NOTE };
  }
  return on && smallFits(graph) ? { gpu: "small", note: SMALL_GPU_NOTE } : { gpu: "large" };
}
