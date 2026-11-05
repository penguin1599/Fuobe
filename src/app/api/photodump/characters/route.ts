import { connection } from "next/server";
import { z } from "zod";
import { toolViewer } from "@/server/account-tool-run";
import { photoProjectChange } from "@/server/photo-apps-http";
import { createPhotoCharacter, listPhotoCharacters } from "@/server/photodump";

const Body = z.object({ name: z.string().max(200), references: z.array(z.string().startsWith("/api/files/").max(500)).min(1).max(80) });

/**
 * An account's own characters for Photodump and Fashion Factory (a name and photos of one person, saved from New
 * character or a Character Sheet). The owner's characters are elements (/api/elements): none here. A guest has none.
 */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  return Response.json({ items: viewer.kind === "account" ? listPhotoCharacters(viewer.account.id) : [] });
}

/** Save one, from its own photos only. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Add a name and a photo of them" }, { status: 400 });
  return photoProjectChange(request, () => {
    const viewer = toolViewer(request);
    if (viewer.kind !== "account") return Response.json({ error: "Save characters on the Elements page." }, { status: 404 });
    return Response.json(createPhotoCharacter(viewer.account.id, parsed.data), { status: 201 });
  });
}
