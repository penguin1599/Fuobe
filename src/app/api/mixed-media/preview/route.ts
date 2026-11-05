import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createMixedPreview, mixedSteps, planMixedPreviewRun, startMixed, type MixedRun } from "@/server/mixed-media";
import { MixedBodySchema, body, handle, once } from "@/server/shorts-schemas";

/** Generate one frame with the current settings before the full video. An account's runs on its own GPU or key; a guest signs up first. */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, MixedBodySchema, "Pick a preset and upload a clip first");
    if (viewer.kind === "owner") return Response.json(await once("mixed-preview", input.requestId, () => createMixedPreview(input)), { status: 201 });
    let run: MixedRun | null = null;
    return onceForAccount(
      viewer.account,
      "mixed-preview",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "mixed-media",
          files: [input.source.url, input.anchor, input.frameUrl],
          plan: async () => mixedSteps((run = await planMixedPreviewRun(input))),
          start: () => startMixed(run!).final,
        }),
      ({ value }) => Response.json(value, { status: 201 }),
    );
  }, request);
}
