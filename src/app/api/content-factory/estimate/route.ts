import { z } from "zod";
import { priceAsRun } from "@/server/account-tool-run";
import { BriefSchema, estimateSeries, handle, SeriesInputSchema } from "@/server/content-factory";
import { body } from "@/server/faceless";

const Ask = SeriesInputSchema.extend({
  seriesId: z.string().max(20).optional(),
  presetId: z.string().max(60).optional(),
  brief: BriefSchema.optional(),
});

/**
 * What the whole series would cost (one episode at the brief's pace × the episodes), and whether it runs as a demo. A
 * visitor (public sign-up) gets the price of its run as it would go: an account's on its own GPU or its own key (with
 * its own series' brief), a guest's on the open engine; never a demo (src/server/account-tool-run.ts priceAsRun).
 */
export async function POST(request: Request) {
  return priceAsRun(request, () => handle(async () => Response.json(estimateSeries(await body(request, Ask, "Those settings aren't valid")))));
}
