import { LoginGuard } from "@/server/auth";
import { cleanFacts } from "@/server/computer/tasks";
import { PAIR_MS, startPairing } from "@/server/computer/workers";
import { hit } from "@/server/rate";

/** Codes one address may ask for in 10 minutes, and all addresses together in a minute. */
const PER_CLIENT = 10;
const PER_MINUTE = 120;

/**
 * Fuobe Connect (a ComfyUI custom node, integrations/fuobe-connect) asks to pair a ComfyUI with a person's account. The
 * answer is a short code for the person to approve on this site while signed in, and a secret only this ComfyUI knows,
 * which it polls with (./poll). Nothing else happens until the person approves. Open to anyone (no session): a program
 * calls it, and a code alone gives nothing.
 */
export async function POST(request: Request) {
  const key = LoginGuard.clientKey(request.headers);
  const mine = hit(`pair-start:${key}`, key === LoginGuard.DIRECT ? PER_CLIENT * 10 : PER_CLIENT, 10 * 60_000);
  const all = hit("pair-start", PER_MINUTE, 60_000);
  if (!mine.ok || !all.ok) {
    return Response.json({ error: "Too many codes at once. Try again in a few minutes." }, { status: 429, headers: { "Retry-After": String(Math.max(mine.retryAfterS, all.retryAfterS)) } });
  }
  const text = await request.text().catch(() => "");
  if (text.length > 16 * 1024) return Response.json({ error: "Too much at once" }, { status: 413 });
  let body: { name?: unknown; facts?: unknown } = {};
  try {
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json({ error: "Send JSON" }, { status: 400 });
  }
  const facts = cleanFacts(body?.facts);
  delete facts.loras;
  const p = startPairing({ name: typeof body?.name === "string" ? body.name : "ComfyUI", facts });
  // The page asks for the code; it never takes one from its link (someone else's link can't pair their ComfyUI with you).
  const url = new URL("/connect?pair=1", siteOf(request)).toString();
  return Response.json(
    { id: p.id, secret: p.secret, code: p.code, url, expiresAt: p.expiresAt, expiresInS: PAIR_MS / 1000, pollMs: 2000 },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** This studio's own address, as the request reached it (behind a proxy: the forwarded host and scheme). */
function siteOf(request: Request): string {
  const u = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || u.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || u.protocol.replace(":", "");
  return `${proto === "http" ? "http" : "https"}://${host}`;
}
