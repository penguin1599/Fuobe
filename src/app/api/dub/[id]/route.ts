import { connection } from "next/server";
import { z } from "zod";
import { asViewer, guestRun, toolViewer } from "@/server/account-tool-run";
import { CueSchema, deleteDubSession, dubView, getDubSession, saveDubDraft } from "@/server/dub";

const Patch = z.object({ lang: z.string().min(2).max(12), cues: z.array(CueSchema).max(3000) });

const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * One dub: the owner's, or a signed-in account's own (src/server/dub.ts: another account's or the owner's reads as not
 * found). A guest has none: its read is not found and its change gets the sign-up card.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/dub/[id]">) {
  await connection();
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return notFound();
  const view = asViewer(viewer, () => {
    const s = getDubSession(id);
    return s ? dubView(s) : null;
  });
  return view ? Response.json(view) : notFound();
}

/** Save the reviewed lines of one language. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/dub/[id]">) {
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Those lines can't be saved" }, { status: 400 });
  return asViewer(viewer, () => {
    try {
      return Response.json(saveDubDraft(id, parsed.data.lang, parsed.data.cues));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: getDubSession(id) ? 422 : 404 });
    }
  });
}

/** Forget the dub (its results stay: in the Library, or an account's runs). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/dub/[id]">) {
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return asViewer(viewer, () => deleteDubSession(id)) ? new Response(null, { status: 204 }) : notFound();
}
