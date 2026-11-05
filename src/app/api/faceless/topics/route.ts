import { z } from "zod";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { body, EngineSchema, GenreSchema, getChannel, handle, suggestTopics } from "@/server/faceless";

const Ask = z.object({
  idea: z.string().trim().min(1).max(500).optional(),
  channelId: z.string().max(40).optional(),
  genre: GenreSchema.optional(),
  engine: EngineSchema,
  avoid: z.array(z.string().max(200)).max(30).optional(),
  round: z.number().int().min(0).max(50).optional(),
});

/**
 * 4–6 episode topics for a channel (the install's LLM, or templates offline). An account's are the offline ones, for
 * its own channel; a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const q = await body(request, Ask, "Describe the channel first");
    return asViewer(viewer, async () => {
      const channel = q.channelId ? getChannel(q.channelId) : null;
      const idea = q.idea ?? channel?.idea;
      if (!idea) return Response.json({ error: "Describe the channel first" }, { status: 400 });
      const reference = channel?.reference ? [channel.reference.title, channel.reference.author].filter(Boolean).join(" by ") || undefined : undefined;
      return Response.json(await suggestTopics({ idea, genre: q.genre ?? channel?.genre ?? "education", engine: q.engine, avoid: q.avoid, round: q.round, reference }));
    });
  }, request);
}
