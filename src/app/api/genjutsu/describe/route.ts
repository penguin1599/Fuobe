import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { describeCharacter, describeOnGpu, describeRequest, DescribeSchema, startStep } from "@/server/genjutsu";
import { body, handle } from "@/server/shorts-schemas";

/**
 * "Describe my character": writes what the character looks like from their picture. The owner's cloud engine asks the
 * site's AI helper and answers with `{ description }`. Otherwise the GPU describer runs as a Genjutsu step (Qwen3-VL 8B
 * in ComfyUI) and the answer is `{ id, modelId }` (201): the page reads the description from that run's text. The
 * owner's open engine runs it on the install's GPU; an account's on its own GPU, after the checks a tool run gets
 * (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, DescribeSchema, "Add a picture of your character first");
    if (viewer.kind === "owner") {
      if (input.engine === "cloud") return Response.json(await describeCharacter(input));
      return Response.json(describeOnGpu(input), { status: 201 });
    }
    // A repeated requestId (a second click) gets the describer the first one started, never another account's.
    return onceForAccount(
      viewer.account,
      "genjutsu-describe",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "genjutsu",
          files: [input.image],
          plan: () => [{ request: describeRequest(input) }],
          start: () => startStep(describeRequest(input)),
        }),
      ({ value }) => Response.json(value, { status: 201 }),
    );
  }, request);
}
