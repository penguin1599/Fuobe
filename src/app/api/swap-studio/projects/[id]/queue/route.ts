import { QueueSchema, queueTakes } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const run = jobRoute(QueueSchema, "Pick a segment to queue", queueTakes);

/**
 * Queue segment / Queue from here / Queue all segments: a take for each, continuations waiting for what they continue
 * from. An account's queue is one run on its own GPU or key, every take checked before any starts
 * (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/queue">) {
  return run(request, ctx);
}
