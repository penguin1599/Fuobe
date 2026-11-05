import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { BlockSchema, body, deleteEpisode, episodeView, handle, SettingsSchema, updateEpisode } from "@/server/faceless";
import { filesRefused, settingsFiles } from "@/server/faceless-account";

const Patch = z.object({
  title: z.string().max(120).optional(),
  favorite: z.boolean().optional(),
  blocks: z.array(BlockSchema).min(1, "Keep at least one scene").max(80, "Up to 80 scenes").optional(),
  settings: SettingsSchema.partial().optional(),
});

/** The episode with every step's generation, its progress, spend and estimate: the owner's, or an account's own. */
export async function GET(request: Request, ctx: RouteContext<"/api/faceless/episodes/[id]">) {
  await connection();
  const viewer = toolViewer(request);
  return handle(async () => {
    const { id } = await ctx.params;
    return Response.json(asViewer(viewer, () => episodeView(id)));
  });
}

/** Rename, like, or (before rendering) edit the script and settings. An account's files must be its own. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/faceless/episodes/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const patch = await body(request, Patch, "Those changes aren't valid");
    if (viewer.kind === "account") {
      const refused = filesRefused(viewer.account.id, settingsFiles(patch.settings));
      if (refused) return refused;
    }
    return Response.json(
      asViewer(viewer, () => {
        updateEpisode(id, patch);
        return episodeView(id);
      }),
    );
  }, request);
}

/** Deletes the episode and stops what it still renders (its finished videos stay in the Library, or in an account's runs). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/faceless/episodes/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    await asViewer(viewer, () => deleteEpisode(id));
    return new Response(null, { status: 204 });
  }, request);
}
