import { requestViewer } from "@/server/auth";
import { priceAsRun } from "@/server/account-tool-run";
import { estimateGenjutsu, GenjutsuEstimateSchema } from "@/server/genjutsu";
import { body, handle } from "@/server/shorts-schemas";

/**
 * The price, the model, the pieces and the notes for the current settings, before anything runs. A visitor (public
 * sign-up) gets the price of its run as it would go: an account's on its own GPU or its own key, a guest's on the open
 * engine; never a demo (src/server/account-tool-run.ts priceAsRun).
 */
export async function POST(request: Request) {
  return priceAsRun(request, () =>
    handle(async () => {
      const input = await body(request, GenjutsuEstimateSchema, "Add a clip and pick a mode");
      // A feature that hasn't opened on this studio's GPU is priced as a visitor's own-setup run (src/lib/own-setup.ts).
      return Response.json(await estimateGenjutsu(input, { owner: requestViewer(request).kind === "owner", ownSetup: true }));
    }),
  );
}
