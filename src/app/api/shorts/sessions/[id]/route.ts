import { connection } from "next/server";
import { z } from "zod";
import { projectSavesLimited } from "@/server/account-projects";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { deleteSession, getSession, regenerateCost, renameSession } from "@/server/shorts";
import { body, handle } from "@/server/shorts-schemas";

/**
 * The session with its generations (segments, takes, stitches) and what one more take costs. An account opens its own
 * sessions only (another's, or the owner's, reads as gone); a guest has none.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]">) {
  await connection();
  const viewer = toolViewer(request);
  return handle(async () => {
    const { id } = await ctx.params;
    return Response.json(
      asViewer(viewer, () => {
        const s = getSession(id);
        return { ...s, regenerateUsd: regenerateCost(s) };
      }),
    );
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  return handle(async () => {
    const { id } = await ctx.params;
    const { title } = await body(request, z.object({ title: z.string().trim().min(1).max(120) }), "Give the short a name");
    return Response.json(asViewer(viewer, () => renameSession(id, title)));
  }, request);
}

/** Delete the session; its videos move to the Trash unless ?keep=1 (an account has no Trash: its own go for good). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/shorts/sessions/[id]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    const keep = new URL(request.url).searchParams.get("keep") === "1";
    return Response.json({ trashed: await asViewer(viewer, () => deleteSession(id, { keep })) });
  }, request);
}
