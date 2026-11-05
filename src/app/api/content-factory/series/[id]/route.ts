import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { BriefSchema, deleteSeries, handle, seriesView, updateSeries } from "@/server/content-factory";
import { body } from "@/server/faceless";

const Patch = z.object({ brief: BriefSchema.optional(), name: z.string().max(60).optional() });

/**
 * The series: its reference, how far reading it has got, the brief, the plan and the episodes. The owner's, or an
 * account's own (another's, or the owner's, reads as not found).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]">) {
  await connection();
  const viewer = toolViewer(request);
  return handle(async () => {
    const { id } = await ctx.params;
    return Response.json(asViewer(viewer, () => seriesView(id)));
  });
}

/** Edit the brief by hand, or rename the series. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const patch = await body(request, Patch, "That brief isn't valid");
    return Response.json(asViewer(viewer, () => updateSeries(id, patch)));
  }, request);
}

/**
 * Deletes the series and its channel, stopping what its episodes still render (finished videos stay in the Library, or
 * in an account's runs). `?draft=1` deletes only a draft that was never made (the composer moving on from a clip it was
 * reading).
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    await asViewer(viewer, () => deleteSeries(id, { draftOnly: new URL(request.url).searchParams.get("draft") === "1" }));
    return new Response(null, { status: 204 });
  }, request);
}
