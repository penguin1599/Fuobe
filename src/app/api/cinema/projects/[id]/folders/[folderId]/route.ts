import { deleteFolder, updateFolder } from "@/server/cinema";
import { FolderPatch, asCinemaViewer, body } from "@/server/cinema-schemas";

export async function PATCH(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/folders/[folderId]">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id, folderId } = await ctx.params;
      const patch = await body(request, FolderPatch, "Those folder settings aren't valid");
      return Response.json(updateFolder(id, folderId, patch));
    },
    { change: true },
  );
}

/** Its takes and subfolders move up to the parent folder. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/folders/[folderId]">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id, folderId } = await ctx.params;
      deleteFolder(id, folderId);
      return new Response(null, { status: 204 });
    },
    { change: true },
  );
}
