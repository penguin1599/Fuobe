import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createMixed, mixedSteps, planMixedRun, startMixed, type MixedRun } from "@/server/mixed-media";
import { MixedBodySchema, body, handle, once } from "@/server/shorts-schemas";

/**
 * Render a Mixed Media video (open: per frame; cloud: cut → frames or restyle → original sound). `items` leaves out the
 * per-frame edits (`frames` counts them). The owner's render as always; an account's on its own GPU or its own fal.ai or
 * Replicate key, with its own files, after the checks every tool run gets (src/server/account-tool-run.ts); a guest
 * signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, MixedBodySchema, "Pick a preset, upload a clip and choose up to 10 seconds");
    // A repeated requestId (a second click on Generate video) gets the render the first one started.
    if (viewer.kind === "owner") {
      const { final, items, frames } = await once("mixed-render", input.requestId, () => createMixed(input));
      return Response.json({ final, items, frames }, { status: 201 });
    }
    let run: MixedRun | null = null;
    return onceForAccount(
      viewer.account,
      "mixed-render",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "mixed-media",
          files: [input.source.url, input.anchor, input.frameUrl],
          plan: async () => mixedSteps((run = await planMixedRun(input))),
          start: () => startMixed(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ final: value.final, items: value.items, frames: value.frames, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
