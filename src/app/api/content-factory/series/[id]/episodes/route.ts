import { z } from "zod";
import { MAX_EPISODES } from "@/lib/catalog/content-factory";
import { guestRun, toolViewer } from "@/server/account-tool-run";
import { addEpisodes, handle, planAdd } from "@/server/content-factory";
import { runSeries } from "@/server/content-factory-account";
import { body } from "@/server/faceless";

const More = z.object({
  count: z.number().int().min(1).max(MAX_EPISODES, `Up to ${MAX_EPISODES} episodes at a time`),
  next: z.string().max(1000).optional(),
  review: z.boolean().optional(),
});

/**
 * "Next episode": plan and start more episodes after the ones already made. An account's are planned and written first,
 * then render on its own GPU or key as one run, after the checks a studio run gets; a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/content-factory/series/[id]/episodes">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    const input = await body(request, More, "Say how many episodes to add");
    if (viewer.kind === "owner") return Response.json(await addEpisodes(id, input));
    return runSeries(request, viewer.account, id, "add", !!input.review, () => planAdd(id, input));
  }, request);
}
