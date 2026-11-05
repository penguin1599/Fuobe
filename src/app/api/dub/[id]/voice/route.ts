import { z } from "zod";
import { asViewer, bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { CueSchema, getDubSession, planVoiceDub, previewVoiceDub, startVoiceDub, voiceDub, voicePlanSteps, type VoicePlan } from "@/server/dub";

const Body = z.object({
  lang: z.string().min(2).max(12),
  /** The reviewed lines (saved with the run); omitted = the saved draft or the translation. */
  cues: z.array(CueSchema).max(3000).optional(),
  lipsync: z.boolean().optional(),
});

/** Speak one language's reviewed lines in the cloned voice: the voice pipeline; `?preview=1` only prices it. */
async function post(request: Request, ctx: RouteContext<"/api/dub/[id]/voice">, preview: boolean) {
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (!preview && viewer.kind === "guest") return guestRun();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick the language to voice" }, { status: 400 });
  // An account's own dub only (another's, or the owner's, reads as not found).
  const session = viewer.kind === "guest" ? null : asViewer(viewer, () => getDubSession(id));
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  const opts = { cues: parsed.data.cues, lipsync: parsed.data.lipsync };
  if (!preview && viewer.kind === "account") {
    let plan: VoicePlan | null = null;
    return onceForAccount(
      viewer.account,
      `dub-voice:${id}`,
      undefined,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "dub",
          // Its own video (the voice and the background are its own dub's first steps' results).
          files: [session.video],
          plan: () => voicePlanSteps((plan = planVoiceDub(id, parsed.data.lang, opts))),
          start: () => startVoiceDub(plan!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201, headers: { "Cache-Control": "no-store" } }),
    );
  }
  try {
    if (preview) return Response.json(previewVoiceDub(id, parsed.data.lang, opts));
    return Response.json(voiceDub(id, parsed.data.lang, opts), { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}

/**
 * The owner runs as always. A signed-in account voices its own dub on its own GPU or key, and its price check is its
 * own run's (src/server/account-tool-run.ts priceAsRun); a guest's run gets the sign-up card.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/dub/[id]/voice">) {
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  if (toolViewer(request).kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return preview ? priceAsRun(request, () => post(request, ctx, true)) : post(request, ctx, false);
}
