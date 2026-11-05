import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createRemovalReroll, planRemovalReroll, removalSteps, RerollSchema, startRemoval, type RemovalRun } from "@/server/remove-object";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * "Redo from here": an H3 person removal drawn again from one window, the windows before it kept exactly. An account
 * redoes its own removal only, on its own GPU (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, RerollSchema, "Pick the window to redo");
    if (viewer.kind === "owner") {
      const made = await once("remove-object-reroll", input.requestId, () => createRemovalReroll(input));
      return Response.json(made, { status: 201 });
    }
    let run: RemovalRun | null = null;
    return onceForAccount(
      viewer.account,
      "remove-object-reroll",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "remove-object",
          files: [],
          plan: () => removalSteps((run = planRemovalReroll(input))),
          start: () => startRemoval(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ final: value.final, items: value.items, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
