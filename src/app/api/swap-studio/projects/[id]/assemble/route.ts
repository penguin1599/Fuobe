import { ORIGINAL_SOUND_IDS } from "@/lib/av/original-sound";
import { z } from "zod";
import { assemble } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

/** originalSound: what of the clip's sound goes back (src/lib/av/original-sound.ts). */
const Assemble = z.object({ clipId: z.string().min(1).max(80), originalSound: z.enum(ORIGINAL_SOUND_IDS).optional() });

const run = jobRoute(Assemble, "Pick a clip", (id, b) => assemble(id, b.clipId, { originalSound: b.originalSound }));

/**
 * Assemble a clip: its chosen takes over the original timeline, with the clip's own sound. An account's on its own GPU or
 * key (src/server/swap-studio-account.ts); the result is one of its runs, to open and download.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/assemble">) {
  return run(request, ctx);
}
