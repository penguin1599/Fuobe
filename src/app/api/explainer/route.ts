import { connection } from "next/server";
import { z } from "zod";
import { MAX_TOPIC } from "@/lib/catalog/faceless";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, bodyTooBig, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { body, composeScript, createEpisode, draftGraph, FacelessError, graphToolSteps, handle, listEpisodes, SettingsSchema, SourceSchema } from "@/server/faceless";
import { filesRefused, planned, settingsFiles, sourceFiles } from "@/server/faceless-account";

const Create = z.object({
  prompt: z.string().max(MAX_TOPIC, "Prompt is too long (max 5000 characters)"),
  sources: z.array(SourceSchema).max(3, "Up to 3 sources per video — remove one to add another").optional(),
  settings: SettingsSchema,
  /** Show the script for review before rendering (default: render straight away). */
  review: z.boolean().optional(),
});

/** History: your explainers, newest first (`?q=` search, `?liked=1`): the owner's, or an account's own. */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return handle(() => {
    const p = new URL(request.url).searchParams;
    return Response.json({ items: asViewer(viewer, () => listEpisodes({ kind: "explainer", q: p.get("q") ?? undefined, liked: p.get("liked") === "1", limit: 200 })) });
  });
}

/**
 * Explain something: the script is written from the prompt and sources, then rendered. A signed-in account's script is
 * written at once (the offline writer: no AI helper), its sources' pictures must be its own, and its render runs on its
 * own GPU or key after the checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request) ?? projectSavesLimited(viewer.account.id);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, Create, "Add a prompt, or attach a file or link");
    if (viewer.kind === "owner") {
      const episode = createEpisode({ kind: "explainer", topic: input.prompt, sources: input.sources, settings: input.settings, autoRender: !input.review });
      return Response.json(episode, { status: 201 });
    }
    const sources = input.sources ?? [];
    const files = [...settingsFiles(input.settings), ...sourceFiles(sources)];
    const refused = filesRefused(viewer.account.id, files);
    if (refused) return refused;
    if (!input.prompt.trim() && !sources.length) throw new FacelessError("Add a prompt, or attach a file or link");
    const composed = await asViewer(viewer, () => composeScript({ kind: "explainer", channelId: null, topic: input.prompt.trim(), settings: input.settings, sources }, ""));
    const ask = { kind: "explainer" as const, topic: input.prompt, sources, settings: input.settings, composed };
    if (input.review) return Response.json(asViewer(viewer, () => createEpisode(ask)), { status: 201 });
    const out = await runAccountTool(request, viewer.account, {
      tool: "explainer",
      files,
      plan: () => planned(() => graphToolSteps(draftGraph({ kind: "explainer", title: composed.title ?? input.prompt, settings: input.settings, sources, script: composed }))),
      start: () => createEpisode({ ...ask, autoRender: true }),
    });
    return out.ok ? Response.json({ ...out.value, ...(out.gpuWarning && { gpuWarning: out.gpuWarning }) }, { status: 201 }) : out.response;
  }, request);
}
