import { z } from "zod";
import { transcribe } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

/** cleanVoiceFirst: the speech apart from the music and effects before it's read (src/lib/av/voice-first.ts). */
const Transcribe = z.object({ clipId: z.string().min(1).max(80), cleanVoiceFirst: z.boolean().optional() });

// "Clean the voice first" runs on an account's own GPU or key, as in Genjutsu, before it has passed on this studio's GPU
// (src/lib/own-setup.ts).
const run = jobRoute(Transcribe, "Pick a clip", (id, b) => transcribe(id, b.clipId, { cleanVoiceFirst: b.cleanVoiceFirst }), { status: 200 });

/**
 * The clip's words, with who speaks when (Scribe v2 on the cloud, Qwen3-ASR on your GPU). An account's on its own GPU or
 * key (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/transcribe">) {
  return run(request, ctx);
}
