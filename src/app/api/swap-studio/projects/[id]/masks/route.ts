import { makeMask, MaskSchema } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const run = jobRoute(MaskSchema, "Pick a shot, a frame and who to swap", makeMask);

/**
 * Who to swap, as a mask: Track shot (from a frame to the shot's end) or Update frame — a new mask version. An account's
 * on its own GPU or key (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/masks">) {
  return run(request, ctx);
}
