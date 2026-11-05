import { z } from "zod";
import { photoRun, photoRunGate, RequestId } from "@/server/photo-apps-http";
import { createFashion, fashionSteps, previewFashion, type FashionRun } from "@/server/photodump";

const File = z.string().startsWith("/api/files/").max(500);
const Engine = z.enum(["cloud", "open"]);

const Body = z.discriminatedUnion("step", [
  z.object({ step: z.literal("base"), templateId: z.string().max(80), elementId: z.string().max(40), engine: Engine, requestId: RequestId }),
  z.object({ step: z.literal("outfit"), templateId: z.string().max(80), base: File, garment: File, engine: Engine, modelId: z.string().max(80).optional(), requestId: RequestId }),
  z.object({ step: z.literal("photoset"), templateId: z.string().max(80), dressed: File, engine: Engine, modelId: z.string().max(80).optional(), requestId: RequestId }),
]);

/**
 * Fashion Factory steps: 4 base shots of the character in the template's set, the outfit (try-on),
 * and the photoset (one photo per template shot). `?preview=1` prices a step instead. An account's runs on its own GPU
 * or key, with its own character and files (src/server/photo-apps-http.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const gate = photoRunGate(request);
  if (gate) return gate;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Template required" }, { status: 400 });
  const { requestId, ...rest } = parsed.data;
  const input = rest as FashionRun;
  return photoRun(request, requestId, {
    tool: "fashion",
    files: input.step === "outfit" ? [input.base, input.garment] : input.step === "photoset" ? [input.dressed] : [],
    preview: () => previewFashion(input),
    steps: () => fashionSteps(input),
    start: () => createFashion(input),
  });
}
