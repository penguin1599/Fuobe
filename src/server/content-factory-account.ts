import "server-only";
import { projectRefsProblem } from "./account-projects";
import { runAccountTool } from "./account-tool-run";
import type { Account } from "./auth";
import { claimSeries, seriesRunFiles, seriesRunSteps, startSeriesRun, type SeriesRun } from "./content-factory";
import { planned } from "./faceless-account";
import { asAccount } from "./generations";
import { ShortsError } from "./shorts";

/**
 * A signed-in account's "Generate here" or "Next episode" on its own series (public sign-up). The run is planned first,
 * as the account: the episodes' titles and scripts (the offline writer's) and every step their renders run. Its
 * episodes render as one run on its own GPU or key, after the checks a studio run gets (src/server/account-tool-run.ts).
 * With `review` they're written and wait for review instead: nothing renders yet, so there's no run to check. One run
 * at a time per series (claimSeries).
 */
export async function runSeries(request: Request, account: Account, id: string, kind: SeriesRun["kind"], review: boolean, plan: () => Promise<SeriesRun>): Promise<Response> {
  const release = claimSeries(id, kind);
  try {
    if (review) return Response.json(await asAccount(account.id, async () => startSeriesRun(await plan())));
    let run: SeriesRun | null = null;
    const out = await runAccountTool(request, account, {
      tool: "content-factory",
      files: [],
      plan: () =>
        planned(async () => {
          run = await plan();
          // Every file its episodes read (a narrator's sample, style pictures) must be its own.
          const problem = projectRefsProblem(account.id, { files: seriesRunFiles(run) });
          if (problem) throw new ShortsError(problem.error, problem.status);
          return seriesRunSteps(run);
        }),
      start: () => startSeriesRun(run!),
    });
    return out.ok ? Response.json({ ...out.value, ...(out.gpuWarning && { gpuWarning: out.gpuWarning }) }) : out.response;
  } finally {
    release();
  }
}
