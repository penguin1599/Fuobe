import { toolViewer } from "@/server/account-tool-run";
import { photoProjectChange } from "@/server/photo-apps-http";
import { deletePhotoCharacter } from "@/server/photodump";

/** Delete one of the account's own characters (another's, or none, reads as not found). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/photodump/characters/[id]">) {
  const { id } = await ctx.params;
  return photoProjectChange(request, () => {
    const viewer = toolViewer(request);
    const done = viewer.kind === "account" && deletePhotoCharacter(viewer.account.id, id);
    return done ? new Response(null, { status: 204 }) : Response.json({ error: "Not found" }, { status: 404 });
  });
}
