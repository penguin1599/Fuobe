import "server-only";
import { hit, peek } from "./rate";
import { visitorKey } from "./ai-setup";

/** Every answer of the setup routes: never cached or indexed, and no address leaks in a Referer. */
export const SETUP_HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/** The status as JSON: ?format=json, or an Accept that names application/json. Any other parameter is ignored. */
export function wantsJson(request: Request): boolean {
  const format = new URL(request.url).searchParams.get("format");
  if (format === "json") return true;
  if (format === "text") return false;
  return (request.headers.get("accept") ?? "").includes("application/json");
}

/** An answer as JSON or plain text (the text form is the JSON's `text`, or its error). */
export function answer(request: Request, status: number, body: Record<string, unknown>, text: string, headers: Record<string, string> = {}): Response {
  const h = { ...SETUP_HEADERS, ...headers };
  return wantsJson(request) ? Response.json(body, { status, headers: h }) : new Response(text, { status, headers: { ...h, "Content-Type": "text/plain; charset=utf-8" } });
}

/** "Try again in 2 min." */
export const inMinutes = (s: number) => (s <= 60 ? `${Math.max(1, s)} s` : `${Math.ceil(s / 60)} min`);

/** A 429 with Retry-After, as JSON. */
export const tooMany = (error: string, retryAfterS: number) =>
  Response.json({ error, retryAfterS }, { status: 429, headers: { ...SETUP_HEADERS, "Retry-After": String(retryAfterS) } });

/**
 * A visitor's budget for a public read: its own when the studio can tell visitors apart (FUOBE_TRUST_PROXY), and
 * always one shared by everyone, much larger (so one busy visitor can't use it up for the rest, and a studio that can't
 * tell visitors apart never gives everyone one visitor's budget).
 */
export function visitorBudget(name: string, headers: Headers, perVisitor: number, everyone: number, windowMs: number): { ok: boolean; retryAfterS: number } {
  const key = visitorKey(headers);
  const shared = peek(`${name}:all`, everyone, windowMs);
  const own = key ? peek(`${name}:${key}`, perVisitor, windowMs) : { ok: true, retryAfterS: 0 };
  if (!shared.ok || !own.ok) return { ok: false, retryAfterS: Math.max(shared.retryAfterS, own.retryAfterS) };
  hit(`${name}:all`, everyone, windowMs);
  if (key) hit(`${name}:${key}`, perVisitor, windowMs);
  return { ok: true, retryAfterS: 0 };
}
