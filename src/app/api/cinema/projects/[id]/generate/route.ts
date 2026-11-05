import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { cinemaSteps, generateInProject, prepareCinemaRun, startCinemaRun, type CinemaRun } from "@/server/cinema-generate";
import { GenerateBody, body, fileRefs, handle, withStatus } from "@/server/cinema-schemas";

/**
 * Generate from the workspace: plans the run (model, chained steps), checks the project's cost
 * cap, creates the generations and records them in the project (in `folderId`). The owner's run as
 * always; a signed-in account's in its own project, on its own GPU or its own fal.ai or Replicate key,
 * with its own files, after the checks a studio run gets (src/server/account-tool-run.ts); a guest
 * signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/generate">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body(request, GenerateBody, "That request isn't valid");
    if (viewer.kind === "owner") return Response.json(generateInProject(id, b.input, b.folderId ?? null), { status: 201 });
    let run: CinemaRun | null = null;
    return onceForAccount(
      viewer.account,
      `cinema:${id}`,
      undefined,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "cinema",
          files: fileRefs(b.input),
          plan: () => withStatus(() => cinemaSteps((run = prepareCinemaRun(id, b.input, b.folderId ?? null)))),
          start: () => startCinemaRun(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
