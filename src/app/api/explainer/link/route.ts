import { z } from "zod";
import { ownGpuTool, toolViewer } from "@/server/account-tool-run";
import { body, EngineSchema, handle, summarizeLink } from "@/server/faceless";

const Ask = z.object({ url: z.string().url("Paste a full link, starting with https://").max(2000), engine: EngineSchema });

/**
 * A link source: the page is fetched (public addresses only) and summarised for the script writer. The owner's only: the
 * server never fetches a link for an account (docs/public-signup.md), so an account attaches the file or pastes the text.
 */
export async function POST(request: Request) {
  if (toolViewer(request).kind !== "owner") return ownGpuTool();
  return handle(async () => {
    const { url, engine } = await body(request, Ask, "Paste a link – article, page");
    return Response.json(await summarizeLink(url, engine));
  }, request);
}
