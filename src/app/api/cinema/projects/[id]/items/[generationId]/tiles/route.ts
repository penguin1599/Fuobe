import { setTiles } from "@/server/cinema";
import { TilesPut, asCinemaViewer, body, refsRefused } from "@/server/cinema-schemas";

/** The tiles the browser cut from a grid contact sheet (each already saved as an upload: an account's own). */
export async function PUT(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/items/[generationId]/tiles">) {
  return asCinemaViewer(
    request,
    async (viewer) => {
      const { id, generationId } = await ctx.params;
      const b = await body(request, TilesPut, "Those tiles aren't valid");
      const refused = refsRefused(
        viewer,
        b.tiles.map((t) => t.url),
      );
      if (refused) return refused;
      return Response.json(setTiles(id, generationId, b.tiles));
    },
    { change: true },
  );
}
