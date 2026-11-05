import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { body, deleteChannel, FacelessError, GenreSchema, getChannel, handle, listEpisodes, SettingsSchema, updateChannel } from "@/server/faceless";
import { filesRefused, settingsFiles } from "@/server/faceless-account";

const Patch = z.object({
  name: z.string().max(60).optional(),
  idea: z.string().max(500).optional(),
  genre: GenreSchema.optional(),
  avatarUrl: z.string().startsWith("/api/files/").max(500).nullable().optional(),
  reference: z.string().max(500).nullable().optional(),
  settings: SettingsSchema.pick({ engine: true, styleId: true, styleRefs: true, voice: true, aspect: true, subtitles: true, music: true, animation: true, length: true }).partial().optional(),
});

/** The channel with its episodes: the owner's, or an account's own (another's, or the owner's, reads as not found). */
export async function GET(request: Request, ctx: RouteContext<"/api/faceless/channels/[id]">) {
  await connection();
  const viewer = toolViewer(request);
  return handle(async () => {
    const { id } = await ctx.params;
    return asViewer(viewer, () => {
      const channel = getChannel(id);
      if (!channel) throw new FacelessError("Channel not found", 404);
      return Response.json({ channel, episodes: listEpisodes({ channelId: id, limit: 200 }) });
    });
  });
}

/** Rename it, change its idea or genre, its picture, its reference or its saved look. An account's pictures must be its own. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/faceless/channels/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const patch = await body(request, Patch, "Those channel settings aren't valid");
    if (viewer.kind === "account") {
      const refused = filesRefused(viewer.account.id, [patch.avatarUrl, ...settingsFiles(patch.settings)]);
      if (refused) return refused;
    }
    return Response.json(await asViewer(viewer, () => updateChannel(id, patch)));
  }, request);
}

/** Deletes the channel and its episodes, stopping what they still render (finished videos stay in the Library, or in an account's runs). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/faceless/channels/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    await asViewer(viewer, () => deleteChannel(id));
    return new Response(null, { status: 204 });
  }, request);
}
