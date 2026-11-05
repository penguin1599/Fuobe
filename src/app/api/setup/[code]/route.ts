import { connection } from "next/server";
import { setupCode } from "@/lib/ai-setup/code";
import { BAD_CODE, NOT_ACTIVE, notActiveText, toPublic, toText } from "@/lib/ai-setup/status";
import { freshPart, readSetup, setupOf, viewOf } from "@/server/ai-setup";
import { answer, inMinutes, visitorBudget } from "@/server/ai-setup-http";
import { hit } from "@/server/rate";

/**
 * A setup's status for the person's AI, without signing in (docs/public-signup.md "Set it up with my AI"): the steps,
 * the port and the kind of install, and the next step, in fixed words. Plain text, or JSON (?format=json, or an Accept
 * that names it). Every code that isn't active gets the same 404. It reads this server's memory only: at most it asks
 * the account's open tab to look at its own ComfyUI sooner. Limits: 30 reads a minute per code; unknown codes 10 per 10
 * minutes per visitor and 600 for everyone.
 */
const TEN_MINUTES = 10 * 60_000;

export async function GET(request: Request, ctx: RouteContext<"/api/setup/[code]">) {
  await connection();
  const code = setupCode((await ctx.params).code);
  if (!code) return answer(request, 400, { error: BAD_CODE }, `${BAD_CODE}\n`);
  const setup = setupOf(code);
  if (!setup) {
    const r = visitorBudget("setup:miss", request.headers, 10, 600, TEN_MINUTES);
    if (!r.ok) {
      const error = `Too many codes that aren't active. Try again in ${inMinutes(r.retryAfterS)}.`;
      return answer(request, 429, { ...NOT_ACTIVE, error, retryAfterS: r.retryAfterS }, `${error}\n`, { "Retry-After": String(r.retryAfterS) });
    }
    return answer(request, 404, { ...NOT_ACTIVE }, notActiveText());
  }
  const r = hit(`setup:read:${setup.code}`, 30, 60_000);
  if (!r.ok) {
    const error = `Too many reads of this code. Try again in ${inMinutes(r.retryAfterS)}.`;
    return answer(request, 429, { error, retryAfterS: r.retryAfterS }, `${error}\n`, { "Retry-After": String(r.retryAfterS) });
  }
  await readSetup(setup);
  const status = toPublic({ ...viewOf(setup), code: setup.code, expiresAt: setup.expiresAt, fresh: freshPart() }, Date.now());
  return answer(request, 200, status as unknown as Record<string, unknown>, toText(status));
}
