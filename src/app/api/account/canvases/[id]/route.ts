import { connection } from "next/server";
import { z } from "zod";
import { deleteAccountCanvas, getAccountCanvas, updateAccountCanvas } from "@/server/account-canvas";
import { parseVisitorPages } from "@/server/canvas";
import { accountOf, badPages, notAccount, refused, tooMany } from "@/server/account-canvas-http";

const NOT_FOUND = { error: "This canvas isn't here" };

const Patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  pages: z.unknown().optional(),
});

/** One of the account's own boards (another account's reads as not found). */
export async function GET(request: Request, ctx: RouteContext<"/api/account/canvases/[id]">) {
  await connection();
  const a = accountOf(request);
  if (!a) return notAccount();
  const { id } = await ctx.params;
  const c = getAccountCanvas(a.id, id);
  return c ? Response.json(c) : Response.json(NOT_FOUND, { status: 404 });
}

/** Rename and/or save the pages (the editor's autosave). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/account/canvases/[id]">) {
  const a = accountOf(request);
  if (!a) return notAccount();
  const limited = tooMany(a.id);
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the canvas a name" }, { status: 400 });
  const pages = parsed.data.pages === undefined ? undefined : parseVisitorPages(parsed.data.pages);
  if (pages === null) return badPages(parsed.data.pages);
  try {
    const c = updateAccountCanvas(a.id, id, { name: parsed.data.name, pages });
    return c ? Response.json(c) : Response.json(NOT_FOUND, { status: 404 });
  } catch (e) {
    return refused(e);
  }
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/account/canvases/[id]">) {
  const a = accountOf(request);
  if (!a) return notAccount();
  const { id } = await ctx.params;
  return deleteAccountCanvas(a.id, id) ? new Response(null, { status: 204 }) : Response.json(NOT_FOUND, { status: 404 });
}
