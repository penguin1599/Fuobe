import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createRemoval, planRemovalRun, RemovalBodySchema, removalSteps, startRemoval, type RemovalRun } from "@/server/remove-object";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * Remove an object from a clip: the pieces or windows are erased, joined, and the clip's sound put back. The owner's run
 * as always; an account's on its own GPU or its own fal.ai or Replicate key, with its own files, after the checks every
 * tool run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, RemovalBodySchema, "Add a clip and say, click or paint what to remove");
    // A repeated requestId (a second click on Remove) gets the run the first one started.
    if (viewer.kind === "owner") {
      const { final, items } = await once("remove-object", input.requestId, () => createRemoval(input));
      return Response.json({ final, items }, { status: 201 });
    }
    let run: RemovalRun | null = null;
    return onceForAccount(
      viewer.account,
      "remove-object",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "remove-object",
          files: [input.source.url, input.mask],
          plan: async () => removalSteps((run = await planRemovalRun(input))),
          start: () => startRemoval(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ final: value.final, items: value.items, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
