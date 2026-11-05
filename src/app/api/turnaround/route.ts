import { requestViewer } from "@/server/auth";
import { bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { recordExists } from "@/server/records";
import { body, handle, once } from "@/server/shorts-schemas";
import { createTurnaround, planTurnaroundRun, previewTurnaround, startTurnaround, TurnaroundBodySchema, turnaroundRun, turnaroundSteps, type TurnaroundRun } from "@/server/turnaround";
import { worldcastContextNow } from "@/server/worldcast-on";

/**
 * Turnaround video (build plan N7-6): a 360° turnaround of a cast sheet or a character, on either engine. `?preview=1` plans
 * and prices it (the route, the pictures drawn first, the film's frames, the GPU it needs) without running it. The owner's
 * run as always; an account's on its own GPU or its own fal.ai or Replicate key, with its own pictures, after the checks
 * every tool run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
async function post(request: Request) {
  return handle(async () => {
    const { requestId, ...input } = await body(request, TurnaroundBodySchema, "Pick the engine and the character's pictures");
    // Characters are the owner's library: a visitor (public sign-up) is never told whether one exists.
    if (input.elementId && (requestViewer(request).kind !== "owner" || !recordExists({ kind: "element", ids: [input.elementId] }))) {
      return Response.json({ error: "Character not found" }, { status: 404 });
    }
    // An account's run never uses the studio's WorldCast worker, nor asks it anything.
    if (toolViewer(request).kind !== "account") await worldcastContextNow();
    const run = turnaroundRun(input);
    if (new URL(request.url).searchParams.get("preview")) return Response.json(previewTurnaround(run));
    const viewer = toolViewer(request);
    if (viewer.kind !== "account") {
      const result = await once("turnaround", requestId, () => createTurnaround(run));
      return Response.json(result, { status: 201 });
    }
    let planned: TurnaroundRun | null = null;
    return onceForAccount(
      viewer.account,
      "turnaround",
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "turnaround",
          files: [...Object.values(input.views ?? {}), input.sheet],
          plan: () => turnaroundSteps((planned = planTurnaroundRun(run))),
          start: () => startTurnaround(planned!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  });
}

/** A price check (`?preview=1`) is priced as the asker's run would go; a guest's run signs up first. */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  const preview = !!new URL(request.url).searchParams.get("preview");
  if (preview) return priceAsRun(request, () => post(request));
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return post(request);
}
