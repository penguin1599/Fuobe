import { z } from "zod";
import { asViewer, toolViewer } from "@/server/account-tool-run";
import { photoRun, photoRunGate, RequestId } from "@/server/photo-apps-http";
import { ownSteps, planRetry, retrySteps, startRetry, type RetryPlan } from "@/server/photodump";
import { ShortsError } from "@/server/shorts";

const Body = z.object({ id: z.string().min(1).max(40), requestId: RequestId });

/**
 * Retry a failed or canceled photo of a Photodump / Fashion Factory / Character Sheet run: the same
 * request in the same batch, replacing the failed one (the owner's goes to the Trash; an account's, which has no Trash,
 * is deleted). An account retries only its own photos, on its own GPU or key (src/server/photo-apps-http.ts).
 */
export async function POST(request: Request) {
  const gate = photoRunGate(request);
  if (gate) return gate;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick the photo to retry" }, { status: 400 });
  const { id, requestId } = parsed.data;
  const viewer = toolViewer(request);
  // Planned as the asker: another's photo (or the owner's, for an account) reads as gone, before anything else.
  let plan: RetryPlan;
  try {
    plan = asViewer(viewer, () => planRetry(id));
  } catch (e) {
    const status = e instanceof ShortsError ? e.status : 422;
    return Response.json({ error: (e as Error).message }, { status });
  }
  return photoRun(request, requestId, {
    tool: "photo-retry",
    files: [],
    preview: () => ({ error: "Pick the photo to retry", notes: [] }),
    steps: () => ownSteps(retrySteps(plan)),
    start: () => ({ items: startRetry(plan) }),
  });
}
