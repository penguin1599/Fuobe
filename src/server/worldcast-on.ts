import "server-only";
import { WORLDCAST_DEPTH, WORLDCAST_MODELS } from "@/lib/catalog/worldcast-plan";
import { isOffered } from "./model-access";
import { ownGpu } from "./providers/comfyui";
import { tenantAccount } from "./tenant";
import { refreshWorldcast, worldcastAnswers } from "./worldcast";

/**
 * What the camera-path planners get for WorldCast (build plan N7-9): true when the studio's worker answers and WorldCast is
 * switched on, false when it is on but no worker answers (the run says what it films on instead), undefined for a visitor
 * (a guest or an account runs on its own GPU, which has no WorldCast worker: nothing is said about the studio's) or when
 * WorldCast (or a step it needs) is switched off in Settings → Models & licences.
 */
export function worldcastContext(): boolean | undefined {
  if (tenantAccount() || ownGpu() || !offered()) return undefined;
  return worldcastAnswers();
}

/**
 * WorldCast and the steps every run of it needs (the person mask, MoGe 2's depth) are switched on: with any of them off
 * the buttons keep their Uni3C / Frames run instead of planning a move that is then refused.
 */
function offered(): boolean {
  return isOffered(WORLDCAST_MODELS.film) && isOffered(WORLDCAST_MODELS.mask) && isOffered(WORLDCAST_DEPTH.moge);
}

/** The same, after asking the worker when the last answer is over a minute old (routes call it before they plan). */
export async function worldcastContextNow(): Promise<boolean | undefined> {
  if (tenantAccount() || ownGpu() || !offered()) return undefined;
  await refreshWorldcast().catch(() => false);
  return worldcastAnswers();
}
