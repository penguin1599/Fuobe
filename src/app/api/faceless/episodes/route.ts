import { connection } from "next/server";
import { z } from "zod";
import { CF_LENGTH_VALUES } from "@/lib/catalog/content-factory";
import { FACELESS_LENGTHS, MAX_SCRIPT, MAX_TOPIC } from "@/lib/catalog/faceless";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { body, composeScript, createEpisode, FacelessError, getChannel, handle, listEpisodes, SettingsSchema } from "@/server/faceless";
import { filesRefused, settingsFiles } from "@/server/faceless-account";

const Create = z.object({
  channelId: z.string().max(40),
  topic: z.string().max(MAX_TOPIC, "Keep the topic under 5,000 characters"),
  script: z.string().max(MAX_SCRIPT, "That script is too long to narrate. Shorten it and try again.").optional(),
  settings: SettingsSchema,
  /** Save this episode's look and sound as the channel's (default: only for its first episode). */
  saveLook: z.boolean().optional(),
});

/** Episodes, newest first (`?channel=` for one channel): the owner's, or an account's own. */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => {
    const p = new URL(request.url).searchParams;
    return Response.json({ items: asViewer(viewer, () => listEpisodes({ channelId: p.get("channel") ?? undefined, kind: "faceless", q: p.get("q") ?? undefined, limit: 200 })) });
  });
}

/**
 * A new episode: the script is written (or your pasted script split into scenes) in the background, then it waits for
 * your review. An account's is written at once, in its own channel, with only its own files; it renders on its own GPU
 * or key once it is reviewed (the render route's checks). A guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const input = await body(request, Create, "Pick a topic and the video settings");
    if (viewer.kind === "account") {
      const refused = filesRefused(viewer.account.id, settingsFiles(input.settings));
      if (refused) return refused;
    }
    return asViewer(viewer, async () => {
      // A Content Factory channel (its settings carry a style brief) also makes 30-second episodes.
      const channel = getChannel(input.channelId);
      if (!channel) throw new FacelessError("Channel not found", 404);
      const lengths = channel.settings.brief ? CF_LENGTH_VALUES : FACELESS_LENGTHS;
      if (!lengths.includes(input.settings.length)) throw new FacelessError("Choose one of the offered video lengths");
      const ask = { kind: "faceless" as const, channelId: input.channelId, topic: input.topic, script: input.script, settings: input.settings, saveLook: input.saveLook };
      if (viewer.kind === "owner") return Response.json(createEpisode(ask), { status: 201 });
      if (!input.topic.trim() && !input.script?.trim()) throw new FacelessError("Add a topic, or bring your own script");
      const composed = await composeScript({ kind: "faceless", channelId: input.channelId, topic: input.topic.trim(), settings: input.settings, sources: [] }, input.script?.trim() ?? "");
      return Response.json(createEpisode({ ...ask, composed }), { status: 201 });
    });
  }, request);
}
