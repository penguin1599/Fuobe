import { createFolder } from "@/server/cinema";
import { FolderCreate, asCinemaViewer, body } from "@/server/cinema-schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/folders">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      const input = await body(request, FolderCreate, "Give the folder a name");
      return Response.json(createFolder(id, input), { status: 201 });
    },
    { change: true },
  );
}
