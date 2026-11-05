import { guestRun } from "@/server/account-tool-run";
import { body } from "@/server/shorts-schemas";
import { stopTake, TakeRefSchema } from "@/server/swap-studio";
import { asViewer } from "@/server/swap-studio-account";

/** Stop a take (waiting: it doesn't run; running: it is canceled, and the takes waiting on it stop too). An account's: its own. */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/takes/stop">) {
  return asViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      return Response.json(await stopTake(id, await body(request, TakeRefSchema, "Pick a take")));
    },
    { guest: guestRun },
  );
}
