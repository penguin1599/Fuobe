import { toolViewer } from "@/server/account-tool-run";
import { asAccount } from "@/server/generations";
import { framesProgress } from "@/server/mixed-media";
import { handle } from "@/server/shorts-schemas";

/**
 * How far a per-frame render's frame edits are (?id=<the render's finished video>): counts, and the first frame that
 * failed. An account reads its own renders only (another's reads as gone); a guest has none (the proxy answers it).
 */
export async function GET(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return Response.json({ error: "This render no longer exists" }, { status: 404 });
  return handle(() => {
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id || id.length > 64) return Response.json({ error: "Which render?" }, { status: 400 });
    const progress = viewer.kind === "account" ? asAccount(viewer.account.id, () => framesProgress(id)) : framesProgress(id);
    return progress ? Response.json(progress) : Response.json({ error: "This render no longer exists" }, { status: 404 });
  });
}
