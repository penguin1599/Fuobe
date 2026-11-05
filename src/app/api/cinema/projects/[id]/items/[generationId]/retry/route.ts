import { guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { planRetry, retryItem, retrySteps, startRetry, type RetryPlan } from "@/server/cinema";
import { handle, withStatus } from "@/server/cinema-schemas";

/**
 * Run a failed take again (same request, same folder). A signed-in account's take in its own project, on its own GPU
 * or key, after an account run's checks; a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items/[generationId]/retry">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id, generationId } = await ctx.params;
    if (viewer.kind === "owner") return Response.json({ items: retryItem(id, generationId) }, { status: 201 });
    let plan: RetryPlan | null = null;
    return onceForAccount(
      viewer.account,
      `cinema-retry:${id}:${generationId}`,
      undefined,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "cinema",
          files: [],
          plan: () => withStatus(() => retrySteps((plan = planRetry(id, generationId)))),
          start: () => startRetry(plan!),
        }),
      ({ value, gpuWarning }) => Response.json({ items: value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
