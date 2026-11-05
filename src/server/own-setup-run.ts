import "server-only";
import { ownSetupDetail, ownSetupOnly } from "@/lib/own-setup";
import type { GenerationRequest } from "@/lib/catalog/types";
import { accountGpu } from "./auth";
import { runnerFacts } from "./computer/tasks";
import { AccountRunError, type AccountRunRefusal } from "./generations";
import { ownGpu } from "./providers/comfyui";
import { tenantAccount } from "./tenant";

/**
 * The account side of "runs with your own setup" (src/lib/own-setup.ts) for the items that need a bigger card than this
 * studio's (Open-H3 Regenerate and what finishes with it, Kandinsky 6.0 Pro): an account runs them on its own GPU only,
 * never on this studio's GPUs, and only when that GPU has the memory they need (when it has said how much it has).
 * Otherwise the answer is "Connect your GPU" with the item's own words. The owner's runs are the caller's (today's rules).
 */

/** What an account's GPU last said of its memory (its Fuobe tab, or the last status check of its link), or undefined. */
function accountVramBytes(id: string): number | undefined {
  const gpu = accountGpu(id);
  if (!gpu) return undefined;
  if (gpu.mode === "computer") return runnerFacts(`acct:${id}`)?.vramBytes;
  const hit = globalThis.__fuobeAccountGpus?.get(id);
  return hit?.url === gpu.url ? hit.info.vramBytes : undefined;
}

/** A card sold as N GB reports a little less (a 48 GB card: about 47.5 GiB): 90% of it counts as enough. */
const enoughVram = (bytes: number, gb: number) => bytes >= gb * 0.9 * 2 ** 30;

/**
 * Why an account's run of an own-setup item can't start where it is (null: it can): no GPU of its own in this run (none
 * connected, or a run placed on this studio's GPUs: `place` "pool"), or one that has said it has less memory than the
 * item needs. Null for the owner, a guest's price check, and anything that isn't a GPU-only item.
 */
export function ownSetupRefusal(id: string, place?: GenerationRequest["place"]): AccountRunRefusal | null {
  const account = tenantAccount();
  if (!account) return null;
  const o = ownSetupOnly(id);
  if (!o || o.need !== "gpu" || o.orKey) return null;
  const refusal: AccountRunRefusal = { error: ownSetupDetail(o), code: "connect-gpu" };
  // On this studio's GPUs, outside the account's own, or with none connected.
  if (place === "pool" || !ownGpu() || !accountGpu(account)) return refusal;
  const vram = accountVramBytes(account);
  if (o.vramGb && vram !== undefined && !enoughVram(vram, o.vramGb)) return refusal;
  return null;
}

/** ownSetupRefusal, thrown as the account's refusal the routes answer with 403 and the "Connect your GPU" card. */
export function ownSetupGate(id: string, place?: GenerationRequest["place"]): void {
  const r = ownSetupRefusal(id, place);
  if (r) throw new AccountRunError(r);
}

/** The own-setup item a request's settings ask for, beside its model's own: Kandinsky 6.0 (open) at Pro quality. */
export function requestOwnSetupItem(req: Pick<GenerationRequest, "modelId" | "params">): string | undefined {
  if (req.modelId === "oss-kandinsky6" && req.params?.extra?.quality === "pro") return "oss-kandinsky6:pro";
  return undefined;
}
