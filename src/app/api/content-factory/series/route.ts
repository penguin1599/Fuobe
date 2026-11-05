import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, ownGpuTool, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createSeries, handle, listSeries, makeSeries, prepareSeries, ReferenceSchema, seriesReadSteps, seriesReads, type PreparedSeries } from "@/server/content-factory";
import { body } from "@/server/faceless";
import { planned } from "@/server/faceless-account";

const Create = z.object({
  reference: ReferenceSchema.nullable(),
  engine: z.enum(["cloud", "open"]),
  prompt: z.string().max(2000).optional(),
});

/** Series that have been made, newest first: the owner's, or an account's own. */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => Response.json({ items: asViewer(viewer, () => listSeries()) }));
}

/**
 * A new series around a reference: an upload, a link (fetched only through the SSRF-safe fetch; 422 with
 * `needsUpload` when it gives no clip) or a preset. Reading a clip into a style brief starts straight away. A signed-in
 * account's series is its own, and reading its clip (its own upload: the server never fetches a link for an account)
 * runs on its own GPU or key after the checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const input = await body(request, Create, "Add a reference clip, a link or a preset");
    // An account uploads its clip (its composer offers no link): the server never fetches a link for it.
    if (viewer.kind === "account" && input.reference?.kind === "link") return ownGpuTool();
    if (viewer.kind === "owner" || !seriesReads(input)) return Response.json(await asViewer(viewer, () => createSeries(input)), { status: 201 });
    let prepared: PreparedSeries | null = null;
    const out = await runAccountTool(request, viewer.account, {
      tool: "content-factory",
      files: input.reference?.kind === "upload" ? [input.reference.url] : [],
      plan: () => planned(async () => seriesReadSteps((prepared = await prepareSeries(input)))),
      start: () => makeSeries(prepared!),
    });
    return out.ok ? Response.json({ ...out.value, ...(out.gpuWarning && { gpuWarning: out.gpuWarning }) }, { status: 201 }) : out.response;
  }, request);
}
