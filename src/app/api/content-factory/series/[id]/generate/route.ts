import { z } from "zod";
import { asViewer, bodyTooBig, guestRun, toolViewer } from "@/server/account-tool-run";
import { generateSeries, handle, planGenerate, SeriesInputSchema } from "@/server/content-factory";
import { runSeries } from "@/server/content-factory-account";
import { body } from "@/server/faceless";
import { filesRefused, settingsFiles } from "@/server/faceless-account";

const Generate = SeriesInputSchema.extend({ review: z.boolean().optional() });

/**
 * "Generate here": plan the episodes, make the series' channel and start every episode. A signed-in account's series is
 * planned and written first (the offline writer: no AI helper), then its episodes render on its own GPU or key as one
 * run, after the checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]/generate">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const input = await body(request, Generate, "Say what the video is about and pick the settings");
    if (viewer.kind === "owner") return Response.json(await asViewer(viewer, () => generateSeries(id, input)));
    const refused = filesRefused(viewer.account.id, settingsFiles({ voice: input.voice ?? null }));
    if (refused) return refused;
    return runSeries(request, viewer.account, id, "generate", !!input.review, () => planGenerate(id, input));
  }, request);
}
