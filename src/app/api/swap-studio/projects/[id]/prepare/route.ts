import { z } from "zod";
import { prepareClip } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const Prepare = z.object({ clipId: z.string().min(1).max(80) });

const run = jobRoute(Prepare, "Pick a clip", (id, b) => prepareClip(id, b.clipId), { status: 200 });

/**
 * Your GPU: make the clip's 24 fps copy (again). The cloud: its browser copy, when the page can't play the clip. An
 * account's on its own GPU or key (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/prepare">) {
  return run(request, ctx);
}
