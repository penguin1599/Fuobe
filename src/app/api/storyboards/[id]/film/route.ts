import { z } from "zod";
import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createStoryboardFilm, planStoryboardFilm, startStoryboardFilm, storyboardFilmSteps, type StoryboardFilmRun } from "@/server/storyboard";
import { refusedRun } from "@/server/connect-refusal";

const Body = z.object({
  modelId: z.string().max(100).optional(),
  /** Client nonce: a repeat of it (a second click) gets the film the first one started. */
  requestId: z.string().max(64).optional(),
});

/**
 * Animate a storyboard's frames into clips and join them into one film. The owner's board as always; an account's own
 * board only (another's, or the owner's, reads as not found), on its own GPU or key after the checks a studio run gets
 * (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/storyboards/[id]/film">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  const parsed = Body.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { id } = await ctx.params;
  if (viewer.kind === "owner") {
    try {
      return Response.json(createStoryboardFilm(id, parsed.data), { status: 201 });
    } catch (e) {
      return refusedRun(e, request);
    }
  }
  let run: StoryboardFilmRun | null = null;
  // An account's repeat gets its own first film, never another's.
  return onceForAccount(
    viewer.account,
    `storyboard-film:${id}`,
    parsed.data.requestId,
    () =>
      runAccountTool(request, viewer.account, {
        tool: "storyboard-film",
        // Its frames are its own runs (planStoryboardFilm reads only its own); no other file goes in.
        files: [],
        plan: () => storyboardFilmSteps((run = planStoryboardFilm(id, { modelId: parsed.data.modelId }))),
        start: () => startStoryboardFilm(run!),
      }),
    ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
  );
}
