import { connection } from "next/server";
import { z } from "zod";
import { asViewer, toolViewer } from "@/server/account-tool-run";
import { photoProjectChange } from "@/server/photo-apps-http";
import { createUserPack, listUserPacks } from "@/server/photodump";

const Body = z.object({ name: z.string().max(200), refs: z.array(z.string().startsWith("/api/files/")).max(40) });

/** Your own packs: the owner's, or an account's own (never another's); a guest has none. */
export async function GET(request: Request) {
  await connection();
  return Response.json({ packs: asViewer(toolViewer(request), listUserPacks) });
}

/** Create a pack from up to 15 reference photos: each becomes one photo of the dump. An account's from its own photos. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Upload your reference set up to 15 photos" }, { status: 400 });
  return photoProjectChange(request, () => Response.json(createUserPack(parsed.data), { status: 201 }));
}
