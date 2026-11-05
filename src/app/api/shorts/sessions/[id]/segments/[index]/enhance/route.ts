import { asViewer, bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { enhanceSegment, planEnhanceRun, sessionFiles, shortsSteps, ShortsError, startEnhance, type EnhanceRun } from "@/server/shorts";
import { NonceSchema, handle, once, optionalBody } from "@/server/shorts-schemas";

/**
 * Enhance (H3 regenerate): a 1080p take of this segment, redrawn on a GPU (a repeated requestId gets the first answer).
 * An account's runs on its own GPU only, when that GPU has the memory it needs, for its own session only, after the
 * checks every tool run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]/segments/[index]/enhance">) {
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
    if (viewer.kind === "owner") return Response.json(await once(`shorts-enhance:${id}:${i}`, requestId, () => enhanceSegment(id, i)), { status: 201 });
    // Its own session only (another's reads as gone), and the files its runs take.
    const files = asViewer(viewer, () => sessionFiles(id));
    let run: EnhanceRun | null = null;
    return onceForAccount(
      viewer.account,
      `shorts-enhance:${id}:${i}`,
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "shorts",
          files,
          plan: () => shortsSteps((run = planEnhanceRun(id, i)).plan.steps),
          start: () => startEnhance(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
