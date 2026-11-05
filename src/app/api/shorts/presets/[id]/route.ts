import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, bodyTooBig, guestRun, toolViewer } from "@/server/account-tool-run";
import { deleteCustomPreset, ShortsError, updateCustomPreset } from "@/server/shorts";
import { PresetPatchSchema, body, handle } from "@/server/shorts-schemas";

/** Change one of the viewer's own presets (an account's: its own only; another's reads as gone). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/shorts/presets/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const refused = bodyTooBig(request) ?? projectSavesLimited(viewer.account.id);
    if (refused) return refused;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const patch = await body(request, PresetPatchSchema, "Those preset settings aren't valid");
    return Response.json(asViewer(viewer, () => updateCustomPreset(id, patch)));
  }, request);
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/shorts/presets/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    if (!asViewer(viewer, () => deleteCustomPreset(id))) throw new ShortsError("This preset no longer exists", 404);
    return new Response(null, { status: 204 });
  }, request);
}
