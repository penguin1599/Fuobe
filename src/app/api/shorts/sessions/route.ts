import { connection } from "next/server";
import { asViewer, bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createSession, listSessions, planSessionRun, shortsSteps, startSession, type SessionRun } from "@/server/shorts";
import { ShortsBodySchema, body, handle, once } from "@/server/shorts-schemas";

/** Shorts sessions, newest first (History): the owner's, or a signed-in account's own (a guest has none). */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => Response.json({ items: asViewer(viewer, () => listSessions()) }));
}

/**
 * Start a session: cut the clip into segments, restyle each, stitch them under the original sound. The owner's as
 * always; an account's on its own GPU or its own fal.ai or Replicate key, with its own files, after the checks a studio
 * run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, ShortsBodySchema, "Pick a preset, upload a clip and choose the part to restyle");
    // A repeated requestId (a second click on Generate) gets the session the first one started.
    if (viewer.kind === "owner") return Response.json(await once("shorts-session", input.requestId, () => createSession(input)), { status: 201 });
    let run: SessionRun | null = null;
    // An account's repeat gets its own first session, never another's.
    return onceForAccount(
      viewer.account,
      "shorts-session",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "shorts",
          files: [input.source.url],
          plan: async () => shortsSteps((run = await planSessionRun(input)).plan.steps),
          start: () => startSession(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
