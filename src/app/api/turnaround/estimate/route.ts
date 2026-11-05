import { requestViewer } from "@/server/auth";
import { priceAsRun } from "@/server/account-tool-run";
import { recordExists } from "@/server/records";
import { body, handle } from "@/server/shorts-schemas";
import { previewTurnaround, TurnaroundBodySchema, turnaroundRun } from "@/server/turnaround";
import { worldcastContextNow } from "@/server/worldcast-on";

/**
 * A turnaround's price and plan, as the studio routes' estimates answer it (the evaluation harness prices a job here
 * before running it): the model the film runs on, what it costs, whether it would be a demo, the notes.
 */
async function post(request: Request) {
  return handle(async () => {
    const input = await body(request, TurnaroundBodySchema, "Pick the engine and the character's pictures");
    delete input.requestId;
    // Characters are the owner's library: a visitor (public sign-up) is never told whether one exists.
    if (input.elementId && (requestViewer(request).kind !== "owner" || !recordExists({ kind: "element", ids: [input.elementId] }))) {
      return Response.json({ error: "Character not found" }, { status: 404 });
    }
    await worldcastContextNow();
    const p = previewTurnaround(turnaroundRun(input));
    return Response.json({ ...p, modelId: p.model.id, modelName: p.model.name });
  });
}

/** Priced as the asker's run would go: an account's on its own GPU or key, a guest's on the open engine, never a demo. */
export async function POST(request: Request) {
  return priceAsRun(request, () => post(request));
}
