import { z } from "zod";
import { showCode } from "@/lib/ai-setup/code";
import { OSES, WAYS, type Os, type Way } from "@/lib/ai-setup/ways";
import { FUOBE_CONNECT_PUBLISHED } from "@/lib/fuobe-connect";
import { createSetup, resumeToken, siteOf, willCreate } from "@/server/ai-setup";
import { inMinutes, SETUP_HEADERS, tooMany } from "@/server/ai-setup-http";
import { requestAccount, requestViewer } from "@/server/auth";
import { hit, peek } from "@/server/rate";

/**
 * "Set it up with my AI" (docs/public-signup.md): the account's setup code. Its active code with the way and computer
 * updated (200), or a new one (201): `fresh` ends the active code first, `resume` brings back a code the server forgot
 * in a restart (the account's own sealed token). Accounts only. Limits on new codes: 6 a minute and 20 an hour.
 */
const Body = z.strictObject({
  way: z.enum(WAYS as [Way, ...Way[]]),
  os: z.enum(OSES as [Os, ...Os[]]),
  phone: z.boolean().optional(),
  fresh: z.boolean().optional(),
  resume: z.string().max(512).optional(),
});

const NEW_PER_MINUTE = 6;
const NEW_PER_HOUR = 20;

export async function POST(request: Request) {
  if (requestViewer(request).kind === "owner") return Response.json({ code: "accounts-only", error: "This is for accounts." }, { status: 403, headers: SETUP_HEADERS });
  const account = requestAccount(request);
  if (!account) return Response.json({ error: "Sign up to set it up with your AI." }, { status: 401, headers: SETUP_HEADERS });
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return Response.json({ error: "Send JSON." }, { status: 415, headers: SETUP_HEADERS });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick a way and a computer." }, { status: 400, headers: SETUP_HEADERS });
  const b = parsed.data;
  if (b.way === "connect" && !FUOBE_CONNECT_PUBLISHED) return Response.json({ error: "Pick a way and a computer." }, { status: 400, headers: SETUP_HEADERS });
  const site = siteOf(request.headers, request.url);
  if (!site) return Response.json({ error: "Open Fuobe from its own address to set it up." }, { status: 400, headers: SETUP_HEADERS });
  const any = hit(`setup:any:${account.id}`, 60, 60_000);
  if (!any.ok) return tooMany(`Too many changes. Try again in ${inMinutes(any.retryAfterS)}.`, any.retryAfterS);
  if (willCreate({ accountId: account.id, fresh: b.fresh, resume: b.resume })) {
    const minute = peek(`setup:new:${account.id}`, NEW_PER_MINUTE, 60_000);
    const hour = peek(`setup:new-h:${account.id}`, NEW_PER_HOUR, 60 * 60_000);
    if (!minute.ok || !hour.ok) {
      const s = Math.max(minute.retryAfterS, hour.retryAfterS);
      return tooMany(`Too many new codes. Try again in ${inMinutes(s)}.`, s);
    }
    hit(`setup:new:${account.id}`, NEW_PER_MINUTE, 60_000);
    hit(`setup:new-h:${account.id}`, NEW_PER_HOUR, 60 * 60_000);
  }
  const { setup, created, replaced } = createSetup({ accountId: account.id, site, way: b.way, os: b.os, phone: b.phone, fresh: b.fresh, resume: b.resume });
  const code = showCode(setup.code);
  return Response.json(
    {
      code,
      way: setup.way,
      os: setup.os,
      expiresAt: setup.expiresAt,
      site,
      statusUrl: `${site}/api/setup/${code}`,
      guideUrl: `${site}/api/setup/guide/${setup.way}/${setup.os}`,
      resume: resumeToken(setup),
      ...(replaced && { replaced: true }),
    },
    { status: created ? 201 : 200, headers: SETUP_HEADERS },
  );
}
