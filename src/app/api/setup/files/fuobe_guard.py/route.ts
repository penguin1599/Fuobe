import { connection } from "next/server";
import { GUARD_FILE_NAME, GUARD_SOURCE } from "@/lib/comfy-guard";
import { inMinutes } from "@/server/ai-setup-http";
import { visitorBudget } from "@/server/ai-setup-http";

/**
 * Fuobe's guard for ComfyUI (src/lib/comfy-guard.ts), as a download for the person's AI: the guide checks it against
 * its SHA-256. Open to everyone, 60 a minute per visitor.
 */
export async function GET(request: Request) {
  await connection();
  const r = visitorBudget("setup:file", request.headers, 60, 600, 60_000);
  if (!r.ok) return new Response(`Too many downloads. Try again in ${inMinutes(r.retryAfterS)}.\n`, { status: 429, headers: { "Retry-After": String(r.retryAfterS), "Cache-Control": "no-store" } });
  return new Response(GUARD_SOURCE, {
    headers: {
      "Content-Type": "text/x-python; charset=us-ascii",
      "Content-Disposition": `attachment; filename="${GUARD_FILE_NAME}"`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
