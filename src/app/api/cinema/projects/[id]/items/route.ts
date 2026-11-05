import { connection } from "next/server";
import { CinemaError, deleteTakes, getProject, listItems, listStudioGenerations, moveItems, removeItems, setFavorites } from "@/server/cinema";
import { ItemsDelete, ItemsPatch, asCinemaViewer, body } from "@/server/cinema-schemas";

/**
 * The project's generations. `?folder=<id>` one folder (`&nested=1` with its subfolders),
 * `?folder=root` the takes outside any folder, `?favorites=1` liked takes, `?scope=studio` every
 * Cinema Studio generation in every project ("My Generations"). Default: the whole project.
 * A signed-in account reaches its own projects and runs only.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items">) {
  await connection();
  return asCinemaViewer(request, async () => {
    const { id } = await ctx.params;
    const qs = new URL(request.url).searchParams;
    if (qs.get("scope") === "studio") {
      if (!getProject(id)) throw new CinemaError("Project not found", 404);
      return Response.json({ items: listStudioGenerations() });
    }
    const folder = qs.get("folder");
    const items = listItems(id, {
      folderId: folder === "root" ? null : folder || undefined,
      nested: qs.get("nested") === "1",
      favorites: qs.get("favorites") === "1",
    });
    return Response.json({ items });
  });
}

/** Bulk: move to a folder (`folderId`, null = project root) and/or like / unlike. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      const b = await body(request, ItemsPatch, "Pick the takes to change");
      // Only this project's takes change; the counts say how many did.
      const moved = b.folderId !== undefined ? moveItems(id, b.ids, b.folderId) : 0;
      const liked = b.favorite !== undefined ? setFavorites(id, b.ids, b.favorite) : 0;
      return Response.json({ ok: true, moved, liked });
    },
    { change: true },
  );
}

/**
 * Bulk: take out of the project; `deleteGenerations` moves them to the library's Trash (restorable, still filed here).
 * An account has no Trash: its takes are deleted for good. Only this project's takes are touched.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items">) {
  return asCinemaViewer(
    request,
    async (viewer) => {
      const { id } = await ctx.params;
      const b = await body(request, ItemsDelete, "Pick the takes to delete");
      const removed = viewer.kind === "account" && b.deleteGenerations ? await deleteTakes(id, b.ids) : removeItems(id, b.ids, { deleteGenerations: b.deleteGenerations });
      return Response.json({ removed });
    },
    { change: true },
  );
}
