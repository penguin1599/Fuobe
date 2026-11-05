import { photoProjectChange } from "@/server/photo-apps-http";
import { deleteUserPack } from "@/server/photodump";

/** Delete one of your own packs (an account's own only: another's reads as not found). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/photodump/packs/[id]">) {
  const { id } = await ctx.params;
  return photoProjectChange(request, () => (deleteUserPack(id) ? new Response(null, { status: 204 }) : Response.json({ error: "Not found" }, { status: 404 })));
}
