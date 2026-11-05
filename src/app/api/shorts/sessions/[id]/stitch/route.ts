import { asViewer, bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { planStitchRun, sessionFiles, shortsSteps, startStitch, stitchSession, type StitchRun } from "@/server/shorts";
import { NonceSchema, handle, once, optionalBody } from "@/server/shorts-schemas";

/**
 * Stitch again: join the chosen takes and put the original sound back (a repeated requestId gets the first answer). An
 * account's stitch runs on its own GPU or key, for its own session only (src/server/account-tool-run.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]/stitch">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const { requestId } = await optionalBody(request, NonceSchema);
    if (viewer.kind === "owner") return Response.json(await once(`shorts-stitch:${id}`, requestId, () => stitchSession(id)), { status: 201 });
    // Its own session only (another's reads as gone), and the files its runs take.
    const files = asViewer(viewer, () => sessionFiles(id));
    // One silent segment: its take is the short, and nothing runs.
    const first = asViewer(viewer, () => planStitchRun(id));
    if (!first.steps.length) return Response.json(asViewer(viewer, () => startStitch(first)), { status: 201 });
    let run: StitchRun | null = null;
    return onceForAccount(
      viewer.account,
      `shorts-stitch:${id}`,
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "shorts",
          files: [...files, ...first.files],
          plan: () => shortsSteps((run = planStitchRun(id)).steps),
          start: () => startStitch(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
