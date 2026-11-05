import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createRestore, planRestoreRun, RestoreBodySchema, restoreSteps, startRestore, type RestoreRun } from "@/server/restore";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * Restore & colourise a clip (Fuobe Restore): the prompt is written first when none is given; windows or pieces are
 * joined and the sound put back. The owner's run as always; an account's on its own GPU (its cloud run is refused: the
 * gated Restore IC-LoRA never goes with its key), with its own files and Fuobe's offline template for the words, after
 * the checks every tool run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, RestoreBodySchema, "Add the clip to restore and pick an engine");
    // A repeated requestId (a second click on Restore) gets the run the first one started.
    if (viewer.kind === "owner") {
      const result = await once("restore", input.requestId, () => createRestore(input));
      return Response.json(result, { status: 201 });
    }
    let run: RestoreRun | null = null;
    return onceForAccount(
      viewer.account,
      "restore",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "restore",
          files: [input.source.url, input.reference],
          plan: async () => restoreSteps((run = await planRestoreRun(input))),
          start: () => startRestore(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
