import { connection } from "next/server";
import { SETUP_BAT } from "@/lib/ai-setup/guide";
import { startFile } from "@/lib/comfy-install";
import { siteOf } from "@/server/ai-setup";
import { inMinutes, SETUP_HEADERS } from "@/server/ai-setup-http";
import { visitorBudget } from "@/server/ai-setup-http";

/**
 * Fuobe's Windows start file for the ComfyUI on a port (src/lib/comfy-install.ts startFile, the same file the setup card
 * downloads): the person's AI downloads it for a portable or Easy-Install ComfyUI. It asks Y or N before it restarts
 * ComfyUI. The site in it comes from the fixed list (siteOf). Open to everyone, 60 a minute per visitor.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/setup/files/start/[port]">) {
  await connection();
  const raw = (await ctx.params).port;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  const site = siteOf(request.headers, request.url);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !site) return new Response("Not found.\n", { status: 404, headers: { ...SETUP_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  const r = visitorBudget("setup:file", request.headers, 60, 600, 60_000);
  if (!r.ok) return new Response(`Too many downloads. Try again in ${inMinutes(r.retryAfterS)}.\n`, { status: 429, headers: { ...SETUP_HEADERS, "Retry-After": String(r.retryAfterS) } });
  return new Response(startFile(port, site), {
    headers: {
      ...SETUP_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${SETUP_BAT}"`,
    },
  });
}
