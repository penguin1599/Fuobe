import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createRemovalPreview, planRemovalPreview, RemovalBodySchema, removalSteps, startRemoval, type RemovalRun } from "@/server/remove-object";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * A mask preview of the first seconds: what the engine would remove (SAM 3.1). An account's runs on its own GPU or key
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
    const input = await body(request, RemovalBodySchema, "Add a clip and say, click or paint what to remove");
    if (viewer.kind === "owner") {
      const preview = await once("remove-object-preview", input.requestId, () => createRemovalPreview(input));
      return Response.json(preview, { status: 201 });
    }
    let run: RemovalRun | null = null;
    return onceForAccount(
      viewer.account,
      "remove-object-preview",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "remove-object",
          files: [input.source.url, input.mask],
          plan: async () => removalSteps((run = await planRemovalPreview(input))),
          start: () => startRemoval(run!).final,
        }),
      ({ value }) => Response.json(value, { status: 201 }),
    );
  }, request);
}
