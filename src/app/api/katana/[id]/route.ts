import { connection } from "next/server";
import { toolViewer } from "@/server/account-tool-run";
import { asAccount } from "@/server/generations";
import { deleteKatana, getKatana } from "@/server/katana";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/** One run: the owner's, or a signed-in account's own (another's reads as not found). */
export async function GET(request: Request, ctx: RouteContext<"/api/katana/[id]">) {
  await connection();
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return notFound();
  const job = viewer.kind === "account" ? asAccount(viewer.account.id, () => getKatana(id)) : getKatana(id);
  return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : notFound();
}

/**
 * Forget the run: steps still running are stopped first (the clips it made stay in the Library, or in an account's
 * runs). An account forgets its own runs only.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/katana/[id]">) {
  const { id } = await ctx.params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return notFound();
  const done = viewer.kind === "account" ? asAccount(viewer.account.id, () => deleteKatana(id)) : deleteKatana(id);
  return done ? new Response(null, { status: 204 }) : notFound();
}
