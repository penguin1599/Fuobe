import { z } from "zod";
import { priceAsRun } from "@/server/account-tool-run";
import { BlockSchema, body, estimateEpisode, GenreSchema, handle, SettingsSchema } from "@/server/faceless";

const Ask = z.object({
  kind: z.enum(["faceless", "explainer"]),
  settings: SettingsSchema,
  blocks: z.array(BlockSchema).max(80).optional(),
  genre: GenreSchema.optional(),
});

/**
 * What an episode would cost (by part), whether it runs as a demo, and what's in the way. A visitor (public sign-up)
 * gets the price of its run as it would go: an account's on its own GPU or its own key, a guest's on the open engine;
 * never a demo (src/server/account-tool-run.ts priceAsRun).
 */
export async function POST(request: Request) {
  return priceAsRun(request, () => handle(async () => Response.json(estimateEpisode(await body(request, Ask, "Those settings aren't valid")))));
}
