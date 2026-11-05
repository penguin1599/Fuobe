import { z } from "zod";
import { MAX_CLOTHING, MAX_DIRECTION } from "@/lib/influencer";
import { createInfluencer, influencerSteps, previewInfluencer, type InfluencerBody } from "@/server/influencer";
import { photoRun, photoRunGate, RequestId } from "@/server/photo-apps-http";

const File = z.string().startsWith("/api/files/").max(500);

const Body = z.object({
  engine: z.enum(["cloud", "open"]),
  state: z.record(z.string(), z.unknown()),
  direction: z.string().max(MAX_DIRECTION).optional(),
  start: z.enum(["scratch", "reference", "face"]),
  photo: File.optional(),
  clothing: z.array(File).max(MAX_CLOTHING).optional(),
  modelId: z.string().max(60).optional(),
  requestId: RequestId,
});

/** What's wrong with a body, in Higgsfield's words where it has them. */
function bodyError(issues: z.core.$ZodIssue[]): string {
  const at = (key: string) => issues.some((i) => i.path[0] === key);
  if (at("engine")) return "Pick Cloud or Open source";
  if (at("direction")) return "Keep the direction under 4,000 characters";
  if (at("clothing")) return issues.some((i) => i.path[0] === "clothing" && i.code === "too_big") ? "You can add up to three clothing references" : "Upload the clothing references again";
  if (at("photo")) return "Upload the photo again";
  if (at("start")) return "Pick how to start: from scratch, from a reference or with your face";
  return "Build your character first";
}

/**
 * AI Influencer builder: a character sheet from the builder's picks — Fuobe Soul in the cloud (Nano Banana Pro or
 * Seedream 5.0 Pro when asked), the Soul Cast sheet workflow on the open engine, each followed by Qwen-Image-Edit 2511
 * for a face, a reference or clothing. `?preview=1` (or POST /api/influencer/estimate) prices it instead. An account's
 * runs on its own GPU or key, with its own photos (src/server/photo-apps-http.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const gate = photoRunGate(request);
  if (gate) return gate;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: bodyError(parsed.error.issues) }, { status: 400 });
  const { requestId, ...rest } = parsed.data;
  const body = rest as InfluencerBody;
  return photoRun(request, requestId, {
    tool: "influencer",
    files: [body.photo, ...(body.clothing ?? [])],
    preview: () => previewInfluencer(body),
    steps: () => influencerSteps(body),
    start: () => createInfluencer(body),
  });
}
