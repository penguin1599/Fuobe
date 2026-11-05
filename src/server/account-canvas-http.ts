import "server-only";
import { requestAccount } from "@/server/auth";
import { ACCOUNT_CANVAS_LIMITS, AccountCanvasError } from "@/server/account-canvas";
import { pagesProblem } from "@/server/canvas";
import { hit } from "@/server/rate";

/**
 * An account's own canvases (public sign-up, src/server/account-canvas.ts). Only a signed-in account reaches its own
 * boards here: a guest is answered by the proxy (401, sign up to save), and the owner keeps boards in /api/canvases.
 */
export function accountOf(request: Request) {
  return requestAccount(request);
}

export const notAccount = () => Response.json({ error: "Create a free account to save your canvases." }, { status: 401 });

/** Saves a minute per account: a runaway tab can't fill the database. */
export function tooMany(accountId: string): Response | null {
  const rate = hit(`account-canvas:${accountId}`, ACCOUNT_CANVAS_LIMITS.savesPerMinute, 60_000);
  return rate.ok ? null : Response.json({ error: "Saving too often. Wait a moment, then try again." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } });
}

export function refused(e: unknown): Response {
  if (e instanceof AccountCanvasError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

export const badPages = (input: unknown) => Response.json({ error: pagesProblem(input) }, { status: 400 });
