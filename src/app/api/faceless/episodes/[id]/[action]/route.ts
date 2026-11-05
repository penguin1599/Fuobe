import type { GenerationRequest } from "@/lib/catalog/types";
import { asViewer, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import {
  episodeView,
  graphFiles,
  graphToolSteps,
  handle,
  regenerateEpisode,
  regenerateToolSteps,
  renderEpisode,
  renderGraph,
  retryEpisode,
  retryGraph,
  rewriteEpisode,
  undoChange,
  upscaleEpisode,
  upscaleToolSteps,
} from "@/server/faceless";
import { planned } from "@/server/faceless-account";

const ACTIONS = {
  /** Render the reviewed script. */
  render: renderEpisode,
  /** Redo the failed steps and what waited on them. */
  retry: retryEpisode,
  /** Write the script again. */
  rewrite: rewriteEpisode,
  /** Go back to the version before the last change. */
  undo: undoChange,
  /** Upscale the finished film to 1080p (cloud). */
  upscale: upscaleEpisode,
  /** Redraw every scene at 1080p with Open-H3 Regenerate, then join and mix again (open engine). */
  regenerate: regenerateEpisode,
} as const;

type Action = keyof typeof ACTIONS;
type Work = { steps: { request: GenerationRequest; deps: number }[]; files: string[] };

/** What an account's action runs, for its run's checks (the others make nothing new: a rewrite is the offline writer's). */
const RUNS: Partial<Record<Action, (id: string) => Work>> = {
  render: (id) => {
    const g = renderGraph(id);
    return { steps: graphToolSteps(g), files: graphFiles(g) };
  },
  retry: (id) => {
    const g = retryGraph(id);
    return { steps: graphToolSteps(g), files: graphFiles(g) };
  },
  upscale: (id) => ({ steps: upscaleToolSteps(id), files: [] }),
  // Its own GPU only, one with the memory it needs (regenerateEpisode's gate); the episode's own results are its files.
  regenerate: (id) => ({ steps: regenerateToolSteps(id), files: [] }),
};

/**
 * An episode's action. A signed-in account's, on its own episode: a render, a retry, an upscale and Regenerate to 1080p
 * run on its own GPU or key after the checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/faceless/episodes/[id]/[action]">) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return handle(async () => {
    const { id, action } = await ctx.params;
    const run = ACTIONS[action as Action];
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });
    if (viewer.kind === "owner") {
      run(id);
      return Response.json(episodeView(id));
    }
    const checked = RUNS[action as Action];
    const work = checked ? asViewer(viewer, () => checked(id)) : null;
    if (!checked || !work?.steps.length) {
      // Nothing new to run (an undo, a rewrite, an upscale made or making already): the action as it is.
      return Response.json(
        asViewer(viewer, () => {
          run(id);
          return episodeView(id);
        }),
      );
    }
    const out = await runAccountTool(request, viewer.account, { tool: "faceless", files: work.files, plan: () => planned(() => checked(id).steps), start: () => run(id) });
    if (!out.ok) return out.response;
    return Response.json({ ...asViewer(viewer, () => episodeView(id)), ...(out.gpuWarning && { gpuWarning: out.gpuWarning }) });
  }, request);
}
