import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { refusedRun } from "@/server/connect-refusal";
import { asAccount } from "@/server/generations";
import { getKatana, katanaRoom, katanaRetrySteps, katanaRunSteps, planKatanaRun, rerunBody, rerunKatana, retryKatana, startKatana, type KatanaRun } from "@/server/katana";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * Retry the failed steps of a run (and the ones after them); `?all=1` starts the same run again from scratch. An account
 * retries its own runs only, on its own GPU or key (src/server/account-tool-run.ts); a guest signs up first.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/katana/[id]/retry">) {
  const { id } = await ctx.params;
  const all = new URL(request.url).searchParams.get("all") === "1";
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "owner") {
    if (!getKatana(id)) return notFound();
    try {
      return Response.json(all ? rerunKatana(id) : retryKatana(id), { status: 201 });
    } catch (e) {
      return refusedRun(e, request);
    }
  }
  const account = viewer.account;
  const big = bodyTooBig(request);
  if (big) return big;
  const job = asAccount(account.id, () => getKatana(id));
  if (!job) return notFound();
  let run: KatanaRun | null = null;
  return onceForAccount(
    account,
    all ? "katana-rerun" : "katana-retry",
    request.headers.get("x-request-id") ?? undefined,
    () =>
      runAccountTool(request, account, {
        tool: "katana",
        // Its own reference and photos, checked again (a file it deleted since can't go in).
        files: [job.reference, ...job.photos],
        plan: () => {
          if (!all) return katanaRetrySteps(id);
          katanaRoom(account.id);
          return katanaRunSteps((run = planKatanaRun(rerunBody(id))));
        },
        start: () => (all ? startKatana(run!) : retryKatana(id)),
      }),
    ({ value }) => Response.json(value, { status: 201 }),
  );
}
