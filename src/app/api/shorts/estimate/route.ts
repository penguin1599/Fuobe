import { priceAsRun } from "@/server/account-tool-run";
import { estimateShorts } from "@/server/shorts";
import { ShortsEstimateSchema, body, handle } from "@/server/shorts-schemas";

/**
 * What a session would cost (or that it runs as a demo), how many segments it makes, and notes. A visitor (public
 * sign-up) gets the price of its run as it would go: an account's on its own GPU or its own key (with its own presets),
 * a guest's on the open engine; never a demo (src/server/account-tool-run.ts priceAsRun).
 */
export async function POST(request: Request) {
  return priceAsRun(request, () =>
    handle(async () => {
      const input = await body(request, ShortsEstimateSchema, "Pick a preset and the part of the clip to restyle");
      return Response.json(await estimateShorts(input));
    }),
  );
}
