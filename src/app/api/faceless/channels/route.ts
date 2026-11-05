import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { avatarRequest, body, createChannel, EngineSchema, GenreSchema, handle, listChannels, makeAvatar } from "@/server/faceless";
import { planned } from "@/server/faceless-account";

const Create = z.object({
  idea: z.string().trim().min(1, "Describe the channel first").max(500, "Keep the channel idea under 500 characters"),
  genre: GenreSchema,
  engine: EngineSchema,
  reference: z.string().max(500).optional(),
  name: z.string().max(60).optional(),
});

/** Your channels, newest first, with episode counts and the latest finished episode: the owner's, or an account's own. */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => Response.json({ items: asViewer(viewer, () => listChannels()) }));
}

/**
 * Create a channel (its name is written for you when you don't give one). A signed-in account's is its own (a reference
 * link is kept as it is: the server never fetches a link for an account); its avatar
 * is a picture on its own GPU or key, made after that run's checks (without one, the channel shows its initials and
 * "Draw an avatar"). A guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const input = await body(request, Create, "Describe the channel and pick a genre");
    if (viewer.kind === "owner") return Response.json(await createChannel(input), { status: 201 });
    const channel = await asViewer(viewer, () => createChannel(input));
    const avatar = await runAccountTool(request, viewer.account, {
      tool: "faceless",
      files: [],
      plan: () => planned(() => [{ request: avatarRequest(channel.id) }]),
      start: () => makeAvatar(channel.id),
    });
    return Response.json(avatar.ok ? { ...channel, avatarJob: avatar.value.id } : channel, { status: 201 });
  }, request);
}
