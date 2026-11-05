import { priceAsRun, toolViewer } from "@/server/account-tool-run";
import { estimateStoryboard, StoryboardBodySchema } from "@/server/storyboard";

/**
 * What a board costs before it runs ("Free" on your GPU): every frame, the look's model for frame 1. A visitor (public
 * sign-up) gets the price of its run as it would go: an account's on its own GPU or its own key, a guest's on the open
 * engine; never a demo (src/server/account-tool-run.ts priceAsRun).
 */
export async function POST(request: Request) {
  const owner = toolViewer(request).kind === "owner";
  return priceAsRun(request, async () => {
    const parsed = StoryboardBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
    try {
      return Response.json(estimateStoryboard(parsed.data, { owner }));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 422 });
    }
  });
}
