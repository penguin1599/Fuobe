import { connection } from "next/server";
import { decisions } from "@/server/swap-studio";
import { asViewer, guestProjectRead } from "@/server/swap-studio-account";

/** "Export decisions": every clip's review and every take's favourite, decision and notes, as a JSON download. */
export async function GET(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/decisions">) {
  await connection();
  return asViewer(
    request,
    async () => {
      const out = decisions((await ctx.params).id);
      const name = out.project.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "character-swap";
      return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}-decisions.json"` } });
    },
    { guest: guestProjectRead },
  );
}
