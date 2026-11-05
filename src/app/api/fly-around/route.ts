import { bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { body, handle, once } from "@/server/shorts-schemas";
import { createFlyAround, flyAroundSteps, FlyAroundSchema, planFlyAroundRun, previewFlyAround, startFlyAround, type FlyAroundRun } from "@/server/fly-around";
import { worldcastContextNow } from "@/server/worldcast-on";

/**
 * Fly around: a still filmed along an exact camera path (an orbit's numbers, a preset or keys), on either
 * engine. `?preview=1` plans and prices it without running it. Fuobe DoP, Image to 3D, Canvas and Assist call it.
 * The owner's run as always; an account's on its own GPU or its own fal.ai or Replicate key, with its own files, after
 * the checks every tool run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
async function post(request: Request) {
  return handle(async () => {
    const { requestId, ...input } = await body(request, FlyAroundSchema, "Pick the engine, the still and the path");
    // The WorldCast worker's answer, fresh, before the plan reads it (N7-9). An account's run never uses it.
    // An account's run never uses the studio's WorldCast worker, nor asks it anything.
    if (toolViewer(request).kind !== "account") await worldcastContextNow();
    if (new URL(request.url).searchParams.get("preview")) return Response.json(previewFlyAround(input));
    const viewer = toolViewer(request);
    if (viewer.kind !== "account") {
      // A plan that can't run (FlyAroundError) is a 422 with its reason, as any planner's error is.
      const result = await once("fly-around", requestId, () => createFlyAround(input));
      return Response.json(result, { status: 201 });
    }
    let run: FlyAroundRun | null = null;
    return onceForAccount(
      viewer.account,
      "fly-around",
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "fly-around",
          files: [input.image, input.render, ...(input.views ?? []), ...Object.values(input.sides ?? {})],
          plan: () => flyAroundSteps((run = planFlyAroundRun(input))),
          start: () => startFlyAround(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}

/** A price check (`?preview=1`) is priced as the asker's run would go; a guest's run signs up first. */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (new URL(request.url).searchParams.get("preview")) return priceAsRun(request, () => post(request));
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return post(request);
}
