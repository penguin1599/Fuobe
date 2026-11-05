import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createEvolution, EvolutionBodySchema, evolutionSteps, planEvolutionRun, startEvolution, type EvolutionRun } from "@/server/evolution";
import { body, handle, once } from "@/server/shorts-schemas";

/**
 * Evolve a clip (Fuobe Evolution): the direction is written first when none is given; pieces are joined and the sound put
 * back. The owner's run as always; an account's on its own GPU or its own fal.ai or Replicate key, with its own files and
 * Fuobe's offline writer for the direction, after the checks every tool run gets (src/server/account-tool-run.ts); a
 * guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, EvolutionBodySchema, "Add a clip and pick how much should change");
    // A repeated requestId (a second click on Evolve) gets the run the first one started.
    if (viewer.kind === "owner") {
      const result = await once("evolution", input.requestId, () => createEvolution(input));
      return Response.json(result, { status: 201 });
    }
    let run: EvolutionRun | null = null;
    return onceForAccount(
      viewer.account,
      "evolution",
      input.requestId,
      () =>
        runAccountTool(request, viewer.account, {
          tool: "evolution",
          files: [input.source.url, ...input.references],
          plan: async () => evolutionSteps((run = await planEvolutionRun(input))),
          start: () => startEvolution(run!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
    );
  }, request);
}
