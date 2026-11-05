import { guestRun } from "@/server/account-tool-run";
import { body } from "@/server/shorts-schemas";
import { stopJob, StopSchema } from "@/server/swap-studio";
import { asViewer } from "@/server/swap-studio-account";

/** Stop a mask, anchor, transcript, 24 fps copy or assembly that is still being made (an account's: its own). */
export async function POST(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]/stop">) {
  return asViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      return Response.json(await stopJob(id, await body(request, StopSchema, "Pick a job to stop")));
    },
    { guest: guestRun },
  );
}
