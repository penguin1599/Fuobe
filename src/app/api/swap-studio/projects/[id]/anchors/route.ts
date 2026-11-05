import { AnchorSchema, makeAnchor } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const run = jobRoute(AnchorSchema, "Pick a shot", makeAnchor);

/**
 * A scene anchor for a shot (or a reference for a segment): your character put into its first frame. An account's on its
 * own GPU or key (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/anchors">) {
  return run(request, ctx);
}
