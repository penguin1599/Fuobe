import { connection } from "next/server";
import { toolViewer } from "@/server/account-tool-run";
import { createProject, listProjects } from "@/server/cinema";
import { ProjectCreate, asCinemaViewer, body, refsRefused } from "@/server/cinema-schemas";

/** The asker's projects: the owner's, or a signed-in account's own (a guest's list is empty). */
export async function GET(request: Request) {
  await connection();
  if (toolViewer(request).kind === "guest") return Response.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  return asCinemaViewer(request, () => Response.json({ items: listProjects() }));
}

/** A new project: the owner's, or the account's own (its cover one of its own files). A guest signs up first. */
export async function POST(request: Request) {
  return asCinemaViewer(
    request,
    async (viewer) => {
      const input = await body(request, ProjectCreate, "Give the project a name");
      const refused = refsRefused(viewer, [input.cover]);
      if (refused) return refused;
      return Response.json(createProject(input), { status: 201 });
    },
    { change: true },
  );
}
