import { z } from "zod";
import { createLockedRun, SignatureSchema } from "@/server/palettes";
import { ClientExtra } from "@/server/request-schema";

const Hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/);

/** The image request as the composer builds it (the fields an image studio sends). */
const RequestSchema = z.object({
  feature: z.string().min(1).max(80),
  presetId: z.string().max(120).optional(),
  // A Fuobe Soul look's strength, and the engine an Original runs on (the lock itself is the open engine's).
  presetStrength: z.number().min(0).max(1).optional(),
  engine: z.enum(["open", "cloud"]).optional(),
  modelId: z.string().min(1).max(120),
  op: z.string().max(40).optional(),
  prompt: z.string().max(10_000).optional(),
  negativePrompt: z.string().max(4_000).optional(),
  inputs: z.object({ images: z.array(z.string()).max(14).optional() }).optional(),
  params: z
    .object({
      aspectRatio: z.string().max(20).optional(),
      resolution: z.string().max(20).optional(),
      numOutputs: z.number().int().min(1).max(8).optional(),
      seed: z.number().int().optional(),
      enhancePrompt: z.boolean().optional(),
      palette: z.array(Hex).max(16).optional(),
      styleId: z.string().max(200).optional(),
      extra: ClientExtra.optional(),
    })
    .optional(),
  signature: SignatureSchema,
});

const Body = z.object({ request: RequestSchema, colors: z.array(Hex).min(1).max(16), strength: z.number().min(0).max(1).optional() });

/** Make the images, then recolour each one to the palette (open engine: a chained palette-transfer step). */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    const { items } = createLockedRun(parsed.data.request as Parameters<typeof createLockedRun>[0], parsed.data.colors, parsed.data.strength);
    return Response.json({ items }, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
