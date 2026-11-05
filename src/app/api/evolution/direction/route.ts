import { guestRun, toolViewer } from "@/server/account-tool-run";
import { DirectionSchema, writeDirection } from "@/server/evolution";
import { asAccount } from "@/server/generations";
import { body, handle } from "@/server/shorts-schemas";

/**
 * Write the creative direction from the references and your words: Claude, Ollama, or Fuobe's offline writer. Never
 * generates. A signed-in account's is always the offline writer's (never this studio's AI helper); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const input = await body(request, DirectionSchema, "Pick how much should change, then add references or a few words");
    const write = () => writeDirection(input);
    return Response.json(await (viewer.kind === "account" ? asAccount(viewer.account.id, write) : write()));
  }, request);
}
