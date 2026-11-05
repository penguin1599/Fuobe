import { priceAsRun } from "@/server/account-tool-run";
import { estimateEvolution, EvolutionEstimateSchema } from "@/server/evolution";
import { body, handle } from "@/server/shorts-schemas";

/** The price, the pieces and the notes for the current settings, before anything runs ("Free" on your GPU). */
async function post(request: Request) {
  return handle(async () => {
    const input = await body(request, EvolutionEstimateSchema, "Add a clip and pick how much should change");
    return Response.json(estimateEvolution(input));
  });
}

/** Priced as the asker's run would go: an account's on its own GPU or key, a guest's on the open engine, never a demo. */
export async function POST(request: Request) {
  return priceAsRun(request, () => post(request));
}
