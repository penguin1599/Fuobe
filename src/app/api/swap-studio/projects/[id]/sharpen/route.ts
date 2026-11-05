import { SharpenSchema, sharpenClip } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const run = jobRoute(SharpenSchema, "Pick a clip and a size", sharpenClip);

/**
 * Sharpen: every chosen take of a clip made sharper at 1080p, 2K or 4K, each a version beside its take to compare. An
 * account's on its own GPU or key (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/sharpen">) {
  return run(request, ctx);
}
