import { connection } from "next/server";
import { z } from "zod";
import { createAccountCanvas, listAccountCanvases } from "@/server/account-canvas";
import { parseVisitorPages } from "@/server/canvas";
import { accountOf, badPages, notAccount, refused, tooMany } from "@/server/account-canvas-http";

const Body = z.object({
  name: z.string().max(200).optional(),
  templateId: z.string().max(60).nullish(),
  pages: z.unknown(),
});

/** The account's own canvases, newest first. */
export async function GET(request: Request) {
  await connection();
  const a = accountOf(request);
  if (!a) return notAccount();
  return Response.json({ items: listAccountCanvases(a.id) });
}

/** Save a board (a draft from this browser, a ready board, or a blank one) to the account. */
export async function POST(request: Request) {
  const a = accountOf(request);
  if (!a) return notAccount();
  const limited = tooMany(a.id);
  if (limited) return limited;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "That board couldn't be read" }, { status: 400 });
  const pages = parsed.data.pages === undefined ? undefined : parseVisitorPages(parsed.data.pages);
  if (pages === null) return badPages(parsed.data.pages);
  try {
    return Response.json(createAccountCanvas(a.id, { name: parsed.data.name, templateId: parsed.data.templateId, pages }), { status: 201 });
  } catch (e) {
    return refused(e);
  }
}
