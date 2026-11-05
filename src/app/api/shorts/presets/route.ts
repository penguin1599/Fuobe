import { connection } from "next/server";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, bodyTooBig, guestRun, toolViewer } from "@/server/account-tool-run";
import { createCustomPreset, listCustomPresets } from "@/server/shorts";
import { PresetBodySchema, body, handle } from "@/server/shorts-schemas";

/** The viewer's own presets ("Created by you"): the owner's, or a signed-in account's own (a guest has none). */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => Response.json({ items: asViewer(viewer, () => listCustomPresets()) }));
}

/** Create a preset from up to 10 reference images (an account's: its own pictures only). */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const refused = bodyTooBig(request) ?? projectSavesLimited(viewer.account.id);
    if (refused) return refused;
  }
  return handle(async () => {
    const input = await body(request, PresetBodySchema, "Add 1–10 reference images");
    return Response.json(asViewer(viewer, () => createCustomPreset(input)), { status: 201 });
  }, request);
}
