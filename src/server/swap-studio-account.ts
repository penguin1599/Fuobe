import "server-only";
import type { z } from "zod";
import { GUEST_HEADER, GUEST_LIBRARY_MESSAGE } from "@/lib/guest-access";
import { projectRefsProblem, projectSavesLimited } from "./account-projects";
import { bodyTooBig, guestRun, refusalResponse, runAccountTool, toolViewer } from "./account-tool-run";
import type { Account } from "./auth";
import { AccountRunError, asAccount } from "./generations";
import { body, handle } from "./shorts-schemas";
import { planSwapJob, startSwapJob, StudioError } from "./swap-studio";

/**
 * Character Swap Studio for each kind of viewer (public sign-up), for its routes:
 *
 * - the owner: as always (swap-studio.ts on the owner's projects);
 * - a signed-in account: inside its own work (asAccount), where swap-studio.ts reads and changes only the account's own
 *   projects (account-projects.ts, kind "swap"): another account's, or the owner's, is not found. Every job (a clip's
 *   copy, its words, a mask, an anchor, takes, Sharpen, the assembly) is planned first with nothing made, checked as
 *   every account run is (src/server/account-tool-run.ts: room, its limits, only its own files, its own ComfyUI or
 *   fal.ai key for every step, the GPU pre-flight, the LoRAs, moderation), then started as one run. Files a project
 *   names (the character, an imported anchor, a clip) are its own uploads or results only;
 * - a guest: the sign-up card on a change, "Sign up to see this" on a project (the proxy answers both first).
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** A guest's read of a project (it has none): "Sign up to see this". */
export const guestProjectRead = () => Response.json({ error: GUEST_LIBRARY_MESSAGE }, { status: 401, headers: { [GUEST_HEADER]: "1", ...NO_STORE } });

/** The first file a project would name that isn't the account's own (or one of Fuobe's example files): the answer, or null. */
export function refsRefused(accountId: string, files: (string | null | undefined)[]): Response | null {
  const problem = projectRefsProblem(accountId, { files: files.filter((f): f is string => typeof f === "string" && f.length > 0) });
  return problem ? Response.json({ error: problem.error, code: problem.code }, { status: problem.status, headers: NO_STORE }) : null;
}

/** A refused job: the account's own refusal (Connect your GPU, Add your key), or the planner's words with their status. */
function refused(e: unknown): Response {
  if (e instanceof AccountRunError) return refusalResponse(e.refusal);
  if (e instanceof StudioError) return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE });
  return Response.json({ error: (e as Error).message || "Something went wrong. Please try again." }, { status: 422, headers: NO_STORE });
}

/**
 * One of an account's jobs (see the header): `files` the request names itself (a clip's upload), checked first; then the
 * job planned, checked and started as one run. A job that makes nothing (a clip the cloud reads as filmed) is a save.
 */
export async function runSwapJob(request: Request, account: Account, job: { run: () => unknown; files?: (string | null | undefined)[]; status?: number }): Promise<Response> {
  const bad = refsRefused(account.id, job.files ?? []);
  if (bad) return bad;
  let planned: Awaited<ReturnType<typeof planSwapJob>>;
  try {
    planned = await asAccount(account.id, () => planSwapJob(job.run));
  } catch (e) {
    return refused(e);
  }
  const status = job.status ?? 201;
  if (!planned.steps.length) {
    const limited = projectSavesLimited(account.id);
    if (limited) return limited;
    try {
      return Response.json(await asAccount(account.id, () => startSwapJob(job.run)), { status });
    } catch (e) {
      return refused(e);
    }
  }
  const files = [...(job.files ?? []), ...planned.files].filter((f): f is string => !!f);
  const r = await runAccountTool(request, account, { tool: "character-swap", files, plan: () => planned.steps, start: () => startSwapJob(job.run) });
  return r.ok ? Response.json(r.value, { status }) : r.response;
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * A job route (POST /api/swap-studio/projects/<id>/<job>): the owner's as before; an account's through runSwapJob; a
 * guest's the sign-up card. `files`: what the body names that must be the account's own. `refuse`: a part of the job
 * that isn't open to accounts yet (its answer, or null).
 */
export function jobRoute<S extends z.ZodType>(
  schema: S,
  message: string,
  start: (id: string, b: z.infer<S>) => unknown,
  opts: { status?: number; files?: (b: z.infer<S>) => (string | null | undefined)[]; refuse?: (b: z.infer<S>) => Response | null } = {},
) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    const viewer = toolViewer(request);
    if (viewer.kind === "guest") return guestRun();
    if (viewer.kind === "account") {
      const big = bodyTooBig(request);
      if (big) return big;
    }
    return handle(async () => {
      const { id } = await ctx.params;
      const b = await body(request, schema, message);
      if (viewer.kind === "owner") return Response.json(await start(id, b), { status: opts.status ?? 201 });
      const no = opts.refuse?.(b);
      if (no) return no;
      return runSwapJob(request, viewer.account, { run: () => start(id, b), files: opts.files?.(b), status: opts.status });
    }, request);
  };
}

/**
 * A project route that isn't a run (the list, a project, an edit, a delete, a stop, the prices, the decisions): the
 * owner's as before; an account's inside its own work (its own projects only), with its saves limited when `save`; a
 * guest's `guest` (the sign-up card on a change, "Sign up to see this" on a read).
 */
export function asViewer(request: Request, fn: (account: Account | null) => Response | Promise<Response>, opts: { guest: () => Response; save?: boolean }): Promise<Response> {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return Promise.resolve(opts.guest());
  if (viewer.kind === "owner") return handle(() => fn(null), request);
  const account = viewer.account;
  if (opts.save) {
    const big = bodyTooBig(request);
    if (big) return Promise.resolve(big);
    const limited = projectSavesLimited(account.id);
    if (limited) return Promise.resolve(limited);
  }
  return handle(() => asAccount(account.id, () => fn(account)), request);
}

