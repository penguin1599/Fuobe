import { z } from "zod";
import { LIBRARY_MESSAGE } from "@/lib/guest-access";
import { getStarter } from "@/lib/starters/catalog";
import { projectSavesLimited } from "@/server/account-projects";
import { guestRun, toolViewer } from "@/server/account-tool-run";
import { asAccount } from "@/server/generations";
import { createFromStarter, StarterError } from "@/server/starters";

const Body = z.object({ engine: z.enum(["cloud", "open"]).default("cloud") });

/**
 * The owner's "Use template" on a ready-made starter: makes it (a channel set up for its first episode, a brand kit with
 * its product) and answers `{ href }`, where it opens. A signed-in account makes Cinema Studio's ready films and Faceless
 * Studio's ready channels, each as its own project (src/server/cinema.ts, faceless.ts); the rest are saved to the
 * owner's library (403 for an account). A guest signs up first.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/starters/[id]">) {
  const { id } = await params;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const kind = getStarter(id)?.seed.kind;
    if (kind !== "cinema" && kind !== "faceless") return Response.json({ error: LIBRARY_MESSAGE, code: "library" }, { status: 403 });
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Pick an engine" }, { status: 400 });
  try {
    const make = () => createFromStarter(id, parsed.data.engine);
    return Response.json(await (viewer.kind === "account" ? asAccount(viewer.account.id, make) : make()), { status: 201 });
  } catch (e) {
    // A studio's own refusal (an engine this install doesn't use, a missing photo, an account's limit of projects) keeps its status.
    const status = e instanceof StarterError ? e.status : ((e as { status?: number }).status ?? 400);
    return Response.json({ error: (e as Error).message || "That starter couldn't be made" }, { status });
  }
}
