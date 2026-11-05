import { asViewer, bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { planTakeRun, regenerateSegment, sessionFiles, shortsSteps, ShortsError, startTake, type TakeRun } from "@/server/shorts";
import { NonceSchema, handle, once, optionalBody } from "@/server/shorts-schemas";

/**
 * Regenerate: one more take of this segment (a repeated requestId gets the first answer, not a second take). An
 * account's take runs on its own GPU or key, for its own session only (src/server/account-tool-run.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]/segments/[index]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const { id, index } = await ctx.params;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new ShortsError("No such segment", 404);
    const { requestId } = await optionalBody(request, NonceSchema);
    if (viewer.kind === "owner") return Response.json(await once(`shorts-take:${id}:${i}`, requestId, () => regenerateSegment(id, i)), { status: 201 });
    // Its own session only (another's reads as gone), and the files its runs take.
    const files = asViewer(viewer, () => sessionFiles(id));
    let run: TakeRun | null = null;
    return onceForAccount(
      viewer.account,
      `shorts-take:${id}:${i}`,
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "shorts",
          files,
          plan: () => shortsSteps((run = planTakeRun(id, i)).steps),
          start: () => startTake(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
