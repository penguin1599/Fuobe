import { guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { avatarRequest, handle, makeAvatar } from "@/server/faceless";
import { planned } from "@/server/faceless-account";

/**
 * Draw a channel avatar in the channel's style (one picture generation; it becomes the channel's picture when it's
 * done). An account's runs on its own GPU or key, for its own channel, after the checks a studio run gets.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/faceless/channels/[id]/avatar">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id } = await ctx.params;
    if (viewer.kind === "owner") return Response.json(makeAvatar(id), { status: 201 });
    const run = await runAccountTool(request, viewer.account, { tool: "faceless", files: [], plan: () => planned(() => [{ request: avatarRequest(id) }]), start: () => makeAvatar(id) });
    return run.ok ? Response.json({ ...run.value, ...(run.gpuWarning && { gpuWarning: run.gpuWarning }) }, { status: 201 }) : run.response;
  }, request);
}
