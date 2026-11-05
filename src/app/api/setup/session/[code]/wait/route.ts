import { connection } from "next/server";
import { setupCode } from "@/lib/ai-setup/code";
import { ownSetup, waitSetup } from "@/server/ai-setup";
import { inMinutes, SETUP_HEADERS, tooMany } from "@/server/ai-setup-http";
import { requestAccount } from "@/server/auth";
import { hit } from "@/server/rate";

/**
 * The account's open tab waits here (up to 25 s) for its AI to read the status: `poke: true` asks for a fresh look at
 * its ComfyUI and a report. `slow`: the server holds too many waits, so the tab reports every 10 s instead.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/setup/session/[code]/wait">) {
  await connection();
  const account = requestAccount(request);
  if (!account) return Response.json({ error: "Sign up to set it up with your AI." }, { status: 401, headers: SETUP_HEADERS });
  const code = setupCode((await ctx.params).code);
  const setup = code ? ownSetup(code, account.id) : null;
  if (!setup) return Response.json({ error: "This setup code is not active." }, { status: 404, headers: SETUP_HEADERS });
  const r = hit(`setup:wait:${account.id}`, 30, 60_000);
  if (!r.ok) return tooMany(`Too many waits. Try again in ${inMinutes(r.retryAfterS)}.`, r.retryAfterS);
  return Response.json(await waitSetup(setup, request.signal), { headers: SETUP_HEADERS });
}
