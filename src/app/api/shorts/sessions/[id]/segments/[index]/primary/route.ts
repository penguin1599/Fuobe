import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { makePrimary, ShortsError } from "@/server/shorts";
import { body, handle } from "@/server/shorts-schemas";

/** Make a take the one the stitch uses (an account's own session only). */
export async function POST(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]/segments/[index]/primary">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const { id, index } = await ctx.params;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new ShortsError("No such segment", 404);
    const { generationId } = await body(request, z.object({ generationId: z.string().min(1).max(40) }), "Pick a take");
    return Response.json(asViewer(viewer, () => makePrimary(id, i, generationId)));
  }, request);
}
