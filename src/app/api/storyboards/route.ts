import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createStoryboard, planStoryboardRun, startStoryboard, StoryboardBodySchema, storyboardSteps, type StoryboardRun } from "@/server/storyboard";
import { refusedRun } from "@/server/connect-refusal";
import { once } from "@/server/shorts-schemas";

/**
 * Popcorn-style storyboard: consecutive frames, each made from the previous one. The owner's board as always; an
 * account's on its own GPU or its own fal.ai or Replicate key, with its own reference pictures, after the checks a studio
 * run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  const parsed = StoryboardBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const input = parsed.data;
  if (viewer.kind === "owner") {
    try {
      // A repeated requestId (a second click on Generate) gets the board the first one started.
      return Response.json(await once("storyboard", input.requestId, () => createStoryboard(input)), { status: 201 });
    } catch (e) {
      return refusedRun(e, request);
    }
  }
  let run: StoryboardRun | null = null;
  // An account's repeat gets its own first board, never another's.
  return onceForAccount(
    viewer.account,
    "storyboard",
    input.requestId,
    () =>
      runAccountTool(request, viewer.account, {
        tool: "storyboard",
        files: input.references ?? [],
        plan: async () => storyboardSteps((run = await planStoryboardRun(input, { owner: false }))),
        start: () => startStoryboard(run!),
      }),
    ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
  );
}
