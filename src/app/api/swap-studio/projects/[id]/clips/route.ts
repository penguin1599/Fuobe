import { addClip, ClipSchema } from "@/server/swap-studio";
import { jobRoute } from "@/server/swap-studio-account";

const run = jobRoute(ClipSchema, "Upload a clip first", addClip, { files: (b) => [b.url] });

/**
 * Add an uploaded clip (MP4, MOV, MKV, WebM or AVI, at most 149.66 s); on your GPU its 24 fps copy starts now. An
 * account adds its own upload only, and its copy runs on its own GPU (src/server/swap-studio-account.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/clips">) {
  return run(request, ctx);
}
