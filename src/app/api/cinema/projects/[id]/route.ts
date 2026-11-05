import { connection } from "next/server";
import { CinemaError, deleteProject, getProject, listFolders, spentUsd, updateProject } from "@/server/cinema";
import { ProjectPatch, asCinemaViewer, body, refsRefused } from "@/server/cinema-schemas";
import { cinemaContext } from "@/server/cinema-generate";
import { worldcastContextNow } from "@/server/worldcast-on";
import { graphsReady } from "@/server/own-setup-live";
import { WORLD_MODEL } from "@/lib/world";

/**
 * The project with its folders, its estimated spend and what this install can run (cloud models allowed, a civitai key).
 * The owner's projects, or a signed-in account's own (another's, or the owner's, reads as not found).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/cinema/projects/[id]">) {
  await connection();
  return asCinemaViewer(req, async (viewer) => {
    const { id } = await ctx.params;
    const project = getProject(id);
    if (!project) throw new CinemaError("Project not found", 404);
    const { cloudAllowed, civitai } = cinemaContext();
    // The studio's WorldCast worker, for its owner only (N7-9): the Fly path says what it films on.
    const worldcast = viewer.kind === "owner" ? await worldcastContextNow() : undefined;
    // World mode's graph has passed its check on this studio's GPU: its "runs on your own GPU" mark leaves (own-setup.ts).
    const worldReady = graphsReady(WORLD_MODEL);
    return Response.json({ project, folders: listFolders(id), spentUsd: spentUsd(id), context: { cloudAllowed, civitai, worldReady, ...(worldcast !== undefined && { worldcast }) } });
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]">) {
  return asCinemaViewer(
    request,
    async (viewer) => {
      const { id } = await ctx.params;
      const patch = await body(request, ProjectPatch, "Those project settings aren't valid");
      const refused = refsRefused(viewer, [patch.cover]);
      if (refused) return refused;
      return Response.json(updateProject(id, patch));
    },
    { change: true },
  );
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      deleteProject(id);
      return new Response(null, { status: 204 });
    },
    { change: true },
  );
}
