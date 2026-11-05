import { connection } from "next/server";
import { z } from "zod";
import { ONE_SHOT_MODELS, VOICE_SPLIT_IDS, type VoiceSplit } from "@/lib/av/dub";
import { asViewer, bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createDubSession, dubPlanSteps, dubRoomProblem, listDubSessions, planDub, previewDub, startDub, type DubPlan } from "@/server/dub";
import { connectRefusal } from "@/server/connect-refusal";
import { ShortsError } from "@/server/shorts";

const Body = z.object({
  engine: z.enum(["cloud", "open"]),
  mode: z.enum(["oneshot", "steps"]),
  video: z.string().startsWith("/api/files/").max(500),
  title: z.string().max(200).optional(),
  source: z.string().max(12).optional(),
  targets: z.array(z.string().min(2).max(12)).min(1).max(8),
  model: z.enum(ONE_SHOT_MODELS).optional(),
  /** The video's length as the browser measured it (seconds). */
  duration: z.number().positive().max(36_000).optional(),
  /** Open engine: the voice split (MelBand RoFormer or DBS). */
  voiceSplit: z.enum(VOICE_SPLIT_IDS as [VoiceSplit, ...VoiceSplit[]]).optional(),
});

/** Recent dubs with the state of every step: the owner's, or a signed-in account's own (a guest has none). */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return Response.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 30);
  return Response.json({ items: asViewer(viewer, () => listDubSessions(Number.isFinite(limit) ? limit : 30)) });
}

/** Start a dub: one-shot jobs (cloud) or the prepare pipeline (both engines); `?preview=1` only prices it. */
async function post(request: Request, preview: boolean) {
  const viewer = toolViewer(request);
  if (!preview && viewer.kind === "guest") return guestRun();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first?.path[0] === "video" ? "Add the video to translate" : first?.path[0] === "targets" ? "Pick up to 8 languages to dub into" : "Check the dub settings";
    return Response.json({ error: msg }, { status: 400 });
  }
  if (!preview && viewer.kind === "account") {
    // An account's dub: on its own GPU or key, with its own video, after the checks a studio run gets. Its
    // translations run on its own GPU, never on this install's AI helper (src/server/dub.ts planDub).
    const input = parsed.data;
    let plan: DubPlan | null = null;
    return onceForAccount(
      viewer.account,
      "dub",
      undefined,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "dub",
          files: [input.video],
          plan: () => {
            const full = dubRoomProblem();
            if (full) throw new ShortsError(full, 409);
            return dubPlanSteps((plan = planDub(input)));
          },
          start: () => startDub(plan!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201, headers: { "Cache-Control": "no-store" } }),
    );
  }
  try {
    if (preview) return Response.json(previewDub(parsed.data));
    return Response.json(createDubSession(parsed.data), { status: 201 });
  } catch (e) {
    // Nothing connected runs it: the connect card in the owner's browser (never on a price check).
    return connectRefusal(e, request, preview) ?? Response.json({ error: (e as Error).message }, { status: 422 });
  }
}

/**
 * The owner runs as always. A signed-in account dubs on its own GPU or key, and its price check is its own run's
 * (src/server/account-tool-run.ts priceAsRun); a guest's price check is the open engine's, and its run gets the sign-up
 * card.
 */
export async function POST(request: Request) {
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  if (toolViewer(request).kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return preview ? priceAsRun(request, () => post(request, true)) : post(request, false);
}
