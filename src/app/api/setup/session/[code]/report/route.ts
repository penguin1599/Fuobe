import { z } from "zod";
import { setupCode } from "@/lib/ai-setup/code";
import { TabFactsSchema } from "@/lib/ai-setup/facts";
import { toPublic } from "@/lib/ai-setup/status";
import { freshPart, ownSetup, reportSetup, resumeToken, viewOf } from "@/server/ai-setup";
import { inMinutes, SETUP_HEADERS, tooMany } from "@/server/ai-setup-http";
import { requestAccount } from "@/server/auth";
import { hit } from "@/server/rate";

/**
 * The account's open Fuobe tab says what it sees of its setup (fixed values only: unknown keys answer 400). The answer
 * is the status the person's AI reads, with when the AI last read it, when the code ends, whether this tab leads the
 * setup, and a fresh resume token. Another account's code answers 404.
 */
const Body = TabFactsSchema.extend({ claim: z.boolean().optional() });

export async function POST(request: Request, ctx: RouteContext<"/api/setup/session/[code]/report">) {
  const account = requestAccount(request);
  if (!account) return Response.json({ error: "Sign up to set it up with your AI." }, { status: 401, headers: SETUP_HEADERS });
  const code = setupCode((await ctx.params).code);
  const setup = code ? ownSetup(code, account.id) : null;
  if (!setup) return Response.json({ error: "This setup code is not active." }, { status: 404, headers: SETUP_HEADERS });
  const mine = hit(`setup:report:${setup.code}`, 60, 60_000);
  const all = mine.ok ? hit(`setup:report-a:${account.id}`, 120, 60_000) : mine;
  if (!all.ok) return tooMany(`Too many reports. Try again in ${inMinutes(all.retryAfterS)}.`, all.retryAfterS);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return Response.json({ error: "Send JSON." }, { status: 415, headers: SETUP_HEADERS });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "That report has a value Fuobe doesn't take." }, { status: 400, headers: SETUP_HEADERS });
  const { claim, ...facts } = parsed.data;
  const now = Date.now();
  const { mine: leads } = reportSetup(setup, facts, { claim }, now);
  const status = toPublic({ ...viewOf(setup), code: setup.code, expiresAt: setup.expiresAt, fresh: freshPart() }, now);
  return Response.json({ ...status, aiReadAt: setup.aiReadAt ?? null, expiresAt: setup.expiresAt, mine: leads, resume: resumeToken(setup) }, { headers: SETUP_HEADERS });
}
