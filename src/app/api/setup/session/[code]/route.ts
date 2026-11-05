import { setupCode } from "@/lib/ai-setup/code";
import { endSetup, ownSetup } from "@/server/ai-setup";
import { inMinutes, SETUP_HEADERS, tooMany } from "@/server/ai-setup-http";
import { requestAccount } from "@/server/auth";
import { hit } from "@/server/rate";

/** End this code: the account's own setup code stops at once (its AI reads "not active" from then on). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/setup/session/[code]">) {
  const account = requestAccount(request);
  if (!account) return Response.json({ error: "Sign up to set it up with your AI." }, { status: 401, headers: SETUP_HEADERS });
  const r = hit(`setup:del:${account.id}`, 20, 60_000);
  if (!r.ok) return tooMany(`Too many changes. Try again in ${inMinutes(r.retryAfterS)}.`, r.retryAfterS);
  const code = setupCode((await ctx.params).code);
  const setup = code ? ownSetup(code, account.id) : null;
  if (!setup) return Response.json({ error: "This setup code is not active." }, { status: 404, headers: SETUP_HEADERS });
  endSetup(setup);
  return new Response(null, { status: 204, headers: SETUP_HEADERS });
}
