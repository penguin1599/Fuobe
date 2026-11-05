import { z } from "zod";
import { asViewer, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { handle, rereadSeries, rereadSteps, seriesClip } from "@/server/content-factory";
import { body } from "@/server/faceless";
import { planned } from "@/server/faceless-account";

const Read = z.object({ engine: z.enum(["cloud", "open"]) });

/**
 * Read the reference clip again (on either engine). An account's runs on its own GPU or key, on its own clip, after the
 * checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]/read">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    const { engine } = await body(request, Read, "Pick an engine");
    if (viewer.kind === "owner") return Response.json(await rereadSeries(id, engine));
    const clip = asViewer(viewer, () => seriesClip(id));
    const out = await runAccountTool(request, viewer.account, { tool: "content-factory", files: [clip], plan: () => planned(() => rereadSteps(id, engine)), start: () => rereadSeries(id, engine) });
    return out.ok ? Response.json({ ...out.value, ...(out.gpuWarning && { gpuWarning: out.gpuWarning }) }) : out.response;
  }, request);
}
