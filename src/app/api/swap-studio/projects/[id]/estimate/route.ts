import { connection } from "next/server";
import { estimateProject } from "@/server/swap-studio";
import { asViewer, guestProjectRead } from "@/server/swap-studio-account";

/**
 * Prices before running: one take of each segment, each shot's and the project's queue, masks, anchors, words and
 * assembly. An account's are priced as its runs go: on its own GPU, or its own key (never a demo).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/estimate">) {
  await connection();
  return asViewer(request, async () => Response.json(estimateProject((await ctx.params).id)), { guest: guestProjectRead });
}
