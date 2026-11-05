import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createGenjutsu, GenjutsuBodySchema, genjutsuSteps, planGenjutsuRun, startGenjutsu, type GenjutsuRun } from "@/server/genjutsu";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * Run a Genjutsu: the pieces or windows are made, joined, and the clip's sound put back. The owner's run as always; an
 * account's on its own GPU or its own fal.ai or Replicate key, with its own files, after the checks a studio run gets
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
    const input = await body(request, GenjutsuBodySchema, "Add a clip, pick a mode and add your references");
    // A repeated requestId (a second click on Generate) gets the run the first one started.
    if (viewer.kind === "owner") {
      const { final, items } = await once("genjutsu", input.requestId, () => createGenjutsu(input, { owner: true }));
      return Response.json({ final, items }, { status: 201 });
    }
    const look = input.look?.kind === "custom" ? input.look.images : [];
    let run: GenjutsuRun | null = null;
    // An account's repeat gets its own first run, never another's.
    return onceForAccount(viewer.account, "genjutsu", input.requestId, () =>
      runAccountTool(request, viewer.account, {
        tool: "genjutsu",
        files: [input.source.url, input.mask, input.picture?.frame, ...(input.references ?? []), ...look],
        plan: async () => genjutsuSteps((run = await planGenjutsuRun(input, { owner: false, ownSetup: true }))),
        start: () => startGenjutsu(run!),
      }),
      ({ value, gpuWarning }) => Response.json({ final: value.final, items: value.items, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
