import { bodyTooBig, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { describeScene, SceneSchema, sceneRequest, startStep } from "@/server/genjutsu";
import { body, handle } from "@/server/shorts-schemas";

/**
 * From picture's "What happens": starts the describer on the part; the page waits for its text (a generation). The
 * owner's, or an account's on its own GPU (src/server/account-tool-run.ts).
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, SceneSchema, "Make and pick the first frame first");
    if (viewer.kind === "owner") return Response.json(describeScene(input, { owner: true }), { status: 201 });
    const r = await runAccountTool(request, viewer.account, {
      tool: "genjutsu",
      files: [input.source.url, input.ownPerson ? undefined : input.frame],
      plan: () => [{ request: sceneRequest(input, { owner: false, ownSetup: true }) }],
      start: () => startStep(sceneRequest(input, { owner: false, ownSetup: true })),
    });
    return r.ok ? Response.json(r.value, { status: 201 }) : r.response;
  }, request);
}
