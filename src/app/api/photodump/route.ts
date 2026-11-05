import { connection } from "next/server";
import { z } from "zod";
import { asViewer, toolViewer } from "@/server/account-tool-run";
import { photoRun, photoRunGate, RequestId } from "@/server/photo-apps-http";
import { createPhotodump, listUserPacks, photodumpSteps, previewPhotodump } from "@/server/photodump";

const Body = z
  .object({
    packId: z.string().min(1).max(80),
    engine: z.enum(["cloud", "open"]),
    elementId: z.string().max(40).optional(),
    selfie: z.string().startsWith("/api/files/").max(500).optional(),
    aspectRatio: z.string().max(10).optional(),
    modelId: z.string().max(80).optional(),
    requestId: RequestId,
  })
  .refine((b) => !!b.elementId || !!b.selfie, { message: "Pick a character or add a selfie" });

/** Your own packs (the built-in ones ship with the page): the owner's, or an account's own. */
export async function GET(request: Request) {
  await connection();
  return Response.json({ packs: asViewer(toolViewer(request), listUserPacks) });
}

/**
 * Generate a photodump: one photo per pack shot, as one batch. `?preview=1` prices it instead
 * (model, photo count, cost, demo, notes, or the error that would stop it). An account's runs on its own GPU or key
 * (src/server/photo-apps-http.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const gate = photoRunGate(request);
  if (gate) return gate;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Pick a pack" }, { status: 400 });
  const { requestId, ...input } = parsed.data;
  return photoRun(request, requestId, {
    tool: "photodump",
    files: [input.selfie],
    preview: () => previewPhotodump(input),
    steps: () => photodumpSteps(input),
    start: () => createPhotodump(input),
  });
}
