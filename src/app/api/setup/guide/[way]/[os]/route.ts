import { connection } from "next/server";
import { guideText } from "@/lib/ai-setup/guide";
import { isOs, isWay } from "@/lib/ai-setup/ways";
import { FUOBE_CONNECT_PUBLISHED } from "@/lib/fuobe-connect";
import { siteOf } from "@/server/ai-setup";
import { guideModels } from "@/server/ai-setup-guide";
import { inMinutes, SETUP_HEADERS } from "@/server/ai-setup-http";
import { visitorBudget } from "@/server/ai-setup-http";

/**
 * The steps for the person's AI, for one way and one computer (docs/public-signup.md "Set it up with my AI"): plain
 * text, open to everyone. The studio's address in it comes from a fixed list (siteOf), never from what a request says
 * of itself; any other host gets 404. 60 a minute per visitor.
 */
const NOT_HERE = () => new Response("Not found.\n", { status: 404, headers: { ...SETUP_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(request: Request, ctx: RouteContext<"/api/setup/guide/[way]/[os]">) {
  await connection();
  const { way, os } = await ctx.params;
  if (!isWay(way) || !isOs(os) || (way === "connect" && !FUOBE_CONNECT_PUBLISHED)) return NOT_HERE();
  const site = siteOf(request.headers, request.url);
  if (!site) return NOT_HERE();
  const r = visitorBudget("setup:guide", request.headers, 60, 600, 60_000);
  if (!r.ok)
    return new Response(`Too many reads. Try again in ${inMinutes(r.retryAfterS)}.\n`, {
      status: 429,
      headers: { ...SETUP_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(r.retryAfterS) },
    });
  return new Response(guideText({ way, os, site, models: guideModels() }), { headers: { ...SETUP_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}
