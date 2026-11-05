import { z } from "zod";
import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { mixedSteps, planMixedRetry, retryMixed, startMixed, type MixedRun } from "@/server/mixed-media";
import { body, handle, once } from "@/server/shorts-schemas";

const RetrySchema = z.object({ id: z.string().min(1).max(64), requestId: z.string().trim().min(8).max(64).optional() });

/**
 * Run a render again with the same settings ("Try again" in History); a repeated requestId gets the first answer. An
 * account retries its own render only, on its own GPU or key (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, RetrySchema, "Pick a render to try again");
    if (viewer.kind === "owner") return Response.json(await once("mixed-retry", input.requestId, () => retryMixed(input.id)), { status: 201 });
    let run: MixedRun | null = null;
    return onceForAccount(
      viewer.account,
      "mixed-retry",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "mixed-media",
          files: [],
          plan: () => mixedSteps((run = planMixedRetry(input.id))),
          start: () => startMixed(run!),
        }),
      ({ value }) => Response.json(value, { status: 201 }),
    );
  }, request);
}
