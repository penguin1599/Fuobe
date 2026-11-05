import { guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { CinemaError, finishTake, planFinish, startFinish, type FinishPlan } from "@/server/cinema";
import { handle, withStatus } from "@/server/cinema-schemas";
import { once } from "@/server/shorts-schemas";

/**
 * Finish in 2K: a MiniMax H3 take made again at 2K (fal), or redrawn at 2K on your GPU (Open-H3 Regenerate), same folder.
 * The body may carry a requestId: a repeat of it (a double click, a retried POST) gets the first answer, not a second run.
 * A signed-in account's take in its own project, on its own GPU or key, after an account run's checks; a guest signs up
 * first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items/[generationId]/finish">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id, generationId } = await ctx.params;
    const text = await request.text().catch(() => "");
    let body: unknown = {};
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new CinemaError("That request body isn't JSON", 400);
    }
    const asked = (body as { requestId?: unknown } | null)?.requestId;
    if (asked !== undefined && !(typeof asked === "string" && /^[\w-]{1,64}$/.test(asked))) throw new CinemaError("Bad request", 400);
    const requestId = asked as string | undefined;
    if (viewer.kind === "owner") {
      const items = await once(`cinema-finish:${id}:${generationId}`, requestId, () => finishTake(id, generationId));
      return Response.json({ items }, { status: 201 });
    }
    let plan: FinishPlan | null = null;
    // An account's repeat gets its own first run, never another's.
    return onceForAccount(
      viewer.account,
      `cinema-finish:${id}:${generationId}`,
      requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "cinema",
          files: [],
          plan: () =>
            withStatus(() => {
              plan = planFinish(id, generationId);
              return [{ request: plan.request }];
            }),
          start: () => startFinish(plan!),
        }),
      ({ value, gpuWarning }) => Response.json({ items: value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
