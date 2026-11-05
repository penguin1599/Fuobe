import "server-only";
import { ACTIVE_RUNS_CODE, CONNECT_GPU_HEADER, GUEST_HEADER, GUEST_RUN_MESSAGE, OWN_GPU_TOOL_MESSAGE } from "@/lib/guest-access";
import { ANY_ANGLE } from "@/lib/catalog/any-angle";
import { graphLoras as h3GraphLoras } from "@/lib/catalog/character-swap";
import { pikaFlexGraphLoras } from "@/lib/catalog/pika-flex";
import { regenerateGraphLoras } from "@/lib/catalog/regenerate";
import type { GenerationRequest, MediaKind } from "@/lib/catalog/types";
import { missingFilesMessage, type MissingFiles } from "@/lib/missing-files";
import { restoreGraphLoras } from "@/lib/restore-graph";
import { ADD_KEY_HEADER } from "@/lib/your-keys";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "./account-files";
import { accountInputProblem } from "./account-inputs";
import { checkAccountLoras } from "./account-loras";
import { requestViewer, type Account } from "./auth";
import { db } from "./db";
import { accountRun, AccountRunError, asAccount, asVisitor, outputKind, previewChained, type AccountRunRefusal } from "./generations";
import { gateGeneration, GPU_SETUP_HEADER } from "./gpu/gate";
import { gpuTargetFor } from "./gpu/target";
import { moderateRun } from "./hosted-run";
import { hit, unhit } from "./rate";
import { withRunStamp, type RunStamp } from "./run-stamp";
import { once } from "./shorts-schemas";
import { ShortsError } from "./shorts";

/**
 * A tool's run for a signed-in account (public sign-up): Genjutsu first, then the other tools that plan a run as a
 * pipeline of ordinary generations (createGenerations / createPipeline). It makes the checks POST /api/generations makes
 * for a studio run, for every step of the tool's plan, before anything is queued:
 *
 * - room on the server and in the account's files, its runs going at once and its runs an hour (one tool run is one run:
 *   its steps share a batch);
 * - only its own files (uploads and results) or Fuobe's published example files (account-inputs.ts);
 * - each step's provider is one the account has: its own ComfyUI ("Your GPU") or its own fal.ai or Replicate key
 *   ("Your keys"); never the install's GPU, keys or AI helper (accountRun: 403 connect-gpu, add-key or own-gpu-tool);
 * - the GPU pre-flight on its own ComfyUI (409 gpu-setup with the guided fix), and the LoRAs a step adds (409
 *   comfy_missing_model);
 * - the moderation service's check, when one is set (hosted-run.ts moderateRun);
 * - a 3D model only on the account's own GPU or key (model3dAllowed): its finish runs on this server under its limits.
 *
 * Then the tool's own start runs inside asAccount (tenant.ts): every generation it creates is stamped as the account's,
 * reads only its files and goes to its GPU or key. Where a run goes is decided in one place (`placeOf`): today always the
 * account's own GPU or key. Hosted runs (the install's GPUs) hook in there.
 *
 * The owner's runs never come here: a route runs them as before.
 */

/** Who is asking: the owner, a signed-in account, or a guest (who signs up first). */
export type ToolViewer = { kind: "owner" } | { kind: "account"; account: Account } | { kind: "guest" };

export const toolViewer = (request: Request): ToolViewer => requestViewer(request) as ToolViewer;

const NO_STORE = { "Cache-Control": "no-store" };

/** A guest's run: the "Create a free account to run this" card (the proxy answers it first; this is the route's own). */
export const guestRun = () => Response.json({ error: GUEST_RUN_MESSAGE }, { status: 401, headers: { [GUEST_HEADER]: "1", ...NO_STORE } });

/** A tool (or a step of one) that doesn't run on an account's own GPU or key: one answer, no sign-up card. */
export const ownGpuTool = () => Response.json({ error: OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" }, { status: 403, headers: NO_STORE });

/**
 * Run `fn` as the viewer's work: the owner's as it is; an account's inside asAccount (its files, its runs, its GPU, its
 * keys and its engine mode). A guest has no work of its own: asVisitor (the open engine, no GPU, no demo).
 */
export function asViewer<T>(v: ToolViewer, fn: () => T): T {
  if (v.kind === "owner") return fn();
  return v.kind === "account" ? asAccount(v.account.id, fn) : asVisitor(null, fn);
}

/**
 * A tool's price check as the asker's run would go: the owner's as always; an account's as its own run (its GPU, its
 * keys, so a paid model on its own key is priced too); a guest's on the open engine with no GPU and no demo. Unlike
 * visitor.ts priceAs (a studio's price check for a visitor, always the open engine), an account with its own key prices
 * the cloud engine. A price check never calls a GPU: the planners read files' headers only.
 */
export function priceAsRun<T>(request: Request, fn: () => T): T {
  return asViewer(toolViewer(request), fn);
}

/** A refused run, kept as its parts so a repeat of the same request id gets its own copy of the answer. */
class Refused {
  constructor(
    readonly status: number,
    readonly headers: [string, string][],
    readonly text: string,
  ) {}
}

/**
 * An account's tool run once per client request id (shorts-schemas.ts once): a repeat of the id (a second click that got
 * through, a retried POST) gets the first run, and never another account's. A refusal isn't kept: sent again (after the
 * account connects its GPU, say), the run is checked again. `ok` turns the started run into the route's answer.
 */
export async function onceForAccount<T>(
  account: Account,
  scope: string,
  id: string | undefined,
  fn: () => Promise<AccountToolResult<T>>,
  ok: (r: { value: T; gpuWarning?: string }) => Response,
): Promise<Response> {
  try {
    const r = await once(`${scope}:acct:${account.id}`, id, async () => {
      const out = await fn();
      if (!out.ok) throw new Refused(out.response.status, [...out.response.headers], await out.response.text());
      return out;
    });
    return ok(r);
  } catch (e) {
    if (e instanceof Refused) return new Response(e.text, { status: e.status, headers: e.headers });
    throw e;
  }
}

/** An account's runs going now (queued or running), counted as runs: a run's jobs and steps share a batch. */
export function activeAccountRuns(accountId: string): number {
  const r = db()
    .prepare("SELECT COUNT(DISTINCT COALESCE(batch_id, id)) AS n FROM generations WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') = ?")
    .get(accountId) as { n: number };
  return r.n;
}

/** A request body over what an account's run may weigh (its files are uploaded first): 413 before it is read. */
export function bodyTooBig(request: Request): Response | null {
  return Number(request.headers.get("content-length") ?? 0) > ACCOUNT_LIMITS.runBodyBytes ? refuse(413, ACCOUNT_MESSAGES.bodyTooBig) : null;
}

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });

/** An account's step that can't go where it was planned: Connect your GPU, Add your key (the client opens either). */
export function refusalResponse(r: AccountRunRefusal): Response {
  const headers: Record<string, string> = r.code === "connect-gpu" ? { [CONNECT_GPU_HEADER]: "1" } : r.code === "add-key" && r.provider ? { [ADD_KEY_HEADER]: r.provider } : {};
  return refuse(403, r.error, { code: r.code, ...(r.provider && { provider: r.provider }) }, headers);
}

/** One step of a tool's plan: the request it will create, and how many earlier steps it waits for (their outputs go in). */
export interface ToolStep {
  request: GenerationRequest;
  /** Earlier steps it waits for (createPipeline's `after`): 0 for a step that starts at once. */
  deps?: number;
}

/** Where an account's tool run goes. Today always its own GPU or key ("own"); hosted runs add the install's GPUs ("pool"). */
export type ToolPlace = { kind: "own" } | { kind: "pool" };

/**
 * Whether a run placed here may make a 3D model. A 3D model is finished on this server under the account's own limits
 * (model3d-finish.ts): allowed on the account's own GPU or key, never on this install's GPUs (hosted runs don't offer 3D yet).
 */
export const model3dAllowed = (place: ToolPlace): boolean => place.kind === "own";

/**
 * Where this run goes. The one place a tool run's placement is decided: hosted runs (hosted-run.ts decidePlace, the
 * billing hold and runOnPool) hook in here for tools, as POST /api/generations does for the studios. Until then a tool
 * runs on the account's own GPU or key, whatever FUOBE_HOSTED_RUNS says (docs/public-signup.md: "Every other tool still
 * needs the account's own GPU").
 */
export async function placeOf(account: Account, steps: ToolStep[]): Promise<ToolPlace> {
  void account;
  void steps;
  return { kind: "own" };
}

export interface AccountToolRun<T> {
  /** The tool, for the run limit's key and the logs ("genjutsu"). */
  tool: string;
  /** Every file the request names (its clip, pictures, masks…): only the account's own, or Fuobe's example files. */
  files: (string | null | undefined)[];
  /**
   * The run's steps, planned as the account (inside asAccount): what will be created, for the provider, pre-flight and
   * LoRA checks. Throw a ShortsError (its status) or an Error (422) to refuse with its words.
   */
  plan: () => ToolStep[] | Promise<ToolStep[]>;
  /** Creates the run (inside asAccount, after every check): createGenerations / createPipeline, nothing else. */
  start: () => T | Promise<T>;
  /** `gpuCheck: "skip"` from the request (the pre-flight's "Run anyway"). */
  skipGpuCheck?: boolean;
}

export type AccountToolResult<T> = { ok: true; value: T; gpuWarning?: string } | { ok: false; response: Response };

type Planned = { step: ToolStep; p: ReturnType<typeof previewChained> };

/**
 * The LoRA files the run's ComfyUI steps load that the account's ComfyUI doesn't have (call it inside asAccount): each
 * step's added LoRAs and the ones its graph loads itself, as accountLoraFix reads them for a studio run. Null when
 * nothing is missing, or its list couldn't be read.
 */
async function missingLoras(planned: Planned[]): Promise<MissingFiles | null> {
  const items: MissingFiles["items"] = [];
  let workflowId: string | undefined;
  for (const { step, p } of planned) {
    if (p.route.provider !== "comfyui") continue;
    const extra = step.request.params?.extra;
    const needs = [...p.loras.applied, ...h3GraphLoras(p.route.endpoint, extra), ...restoreGraphLoras(p.route.endpoint, extra), ...regenerateGraphLoras(p.route.endpoint, extra), ...pikaFlexGraphLoras(p.route.endpoint, extra)];
    const f = await checkAccountLoras(needs, p.route.endpoint);
    if (!f) continue;
    workflowId ??= f.workflowId;
    for (const i of f.items) if (!items.some((x) => x.file === i.file)) items.push(i);
  }
  return items.length ? { code: "comfy_missing_model", ...(workflowId && { workflowId }), items } : null;
}

const CLIP = /\.(mp4|mov|webm|mkv|avi)$/i;
const SOUND = /\.(mp3|wav|ogg|flac|m4a)$/i;

/** A run's files by kind (by their stored names), for the moderation service. */
function filesAsInputs(files: string[]): GenerationRequest["inputs"] {
  const videos = files.filter((f) => CLIP.test(f));
  const audios = files.filter((f) => SOUND.test(f));
  const images = files.filter((f) => !videos.includes(f) && !audios.includes(f));
  return { ...(images.length && { images }), ...(videos.length && { videos }), ...(audios.length && { audios }) };
}

/** A user-facing error while planning or starting: its status (ShortsError), the account's refusal, or a 422. */
function errorResponse(e: unknown): Response {
  if (e instanceof AccountRunError) return refusalResponse(e.refusal);
  if (e instanceof ShortsError) return refuse(e.status, e.message);
  return refuse(422, (e as Error).message || "Something went wrong. Please try again.");
}

/**
 * Check and start an account's tool run (see the header). The answer is the tool's own value, or the response that
 * refuses it. Nothing is queued unless every check passed; a refused run doesn't count against the account's hour.
 */
export async function runAccountTool<T>(request: Request, account: Account, run: AccountToolRun<T>): Promise<AccountToolResult<T>> {
  const id = account.id;
  const no = (response: Response): AccountToolResult<T> => ({ ok: false, response });
  if (!diskHasRoom()) return no(refuse(503, ACCOUNT_MESSAGES.diskLow));
  if (accountUsage(id).total >= accountTotalBytes(id)) return no(refuse(413, filesFullMessage(id)));
  if (activeAccountRuns(id) >= ACCOUNT_LIMITS.activeRuns) return no(refuse(429, ACCOUNT_MESSAGES.activeRuns, { code: ACTIVE_RUNS_CODE }, { "Retry-After": "30" }));
  const rate = hit(`run:${id}`, ACCOUNT_LIMITS.runsPerHour, 60 * 60_000);
  if (!rate.ok) return no(refuse(429, ACCOUNT_MESSAGES.runRate, {}, { "Retry-After": String(rate.retryAfterS) }));
  // From here a refusal gives the run back to the hour.
  const back = (response: Response): AccountToolResult<T> => {
    unhit(`run:${id}`);
    return no(response);
  };
  // Only files it uploaded here, or its own results (no links, no data: URIs, nobody else's).
  const files = run.files.filter((f): f is string => typeof f === "string" && f.length > 0);
  const problem = files.length ? accountInputProblem({ inputs: { images: files } }, id) : null;
  if (problem) return back(refuse(problem.status, problem.error, { code: problem.code }));
  let steps: ToolStep[];
  try {
    steps = await asAccount(id, run.plan);
  } catch (e) {
    return back(errorResponse(e));
  }
  if (!steps.length) return back(refuse(422, "Nothing to run yet."));
  const place = await placeOf(account, steps);
  let gpuWarning: string | undefined;
  let kind: MediaKind = "video";
  let onKey = false;
  try {
    // Each step's provider must be one the account has; a 3D model only where model3dAllowed says.
    const planned: Planned[] = steps.map((s) => ({ step: s, p: asAccount(id, () => previewChained(s.request, s.deps ?? 0)) }));
    if (place.kind === "own") {
      for (const provider of new Set(planned.map((x) => x.p.route.provider))) {
        const own = accountRun(id, provider, "submit");
        if ("error" in own) return back(refusalResponse(own));
      }
    }
    if (!model3dAllowed(place) && planned.some(({ p }) => outputKind(p.op, p.model) === "model3d" && p.model.id !== ANY_ANGLE.buildModel)) return back(ownGpuTool());
    // GPU pre-flight on its own ComfyUI: a step sure to fail for something missing stops the run with the plan that
    // fixes it (never when the check is unknown). Each workflow once.
    const target = gpuTargetFor(request, "read");
    const seen = new Set<string>();
    for (const { step, p } of planned) {
      if (p.route.provider !== "comfyui" || seen.has(p.route.endpoint)) continue;
      seen.add(p.route.endpoint);
      const gate = await gateGeneration(target, { request: step.request, route: p.route, op: p.op, modelId: p.model.id, gpu: p.gpu, h3: p.h3, skip: run.skipGpuCheck, actor: id });
      if (!gate.ok) return back(refuse(409, gate.message, { code: "gpu-setup", ref: gate.ref, plan: gate.plan }, { [GPU_SETUP_HEADER]: "1" }));
      gpuWarning ??= gate.warning;
    }
    // The LoRAs its steps load (added to the request, or the graph's own) must be on its own ComfyUI: which to download,
    // before anything is queued. The same check runs again when each step is handed over.
    const fix = await asAccount(id, () => missingLoras(planned));
    if (fix) return back(refuse(409, missingFilesMessage(fix), { code: "comfy_missing_model", fix }));
    const last = planned[planned.length - 1].p;
    kind = outputKind(last.op, last.model);
    onKey = planned.some(({ p }) => p.route.provider !== "comfyui");
  } catch (e) {
    return back(errorResponse(e));
  }
  // The moderation service's check (none set: nothing is checked), on the run's words and its files.
  const first = steps.find((s) => !s.deps) ?? steps[0];
  const words = steps.map((s) => s.request.prompt?.trim()).filter(Boolean);
  const checked: GenerationRequest = { ...first.request, prompt: [...new Set(words)].join("\n").slice(0, 8000), inputs: filesAsInputs(files) };
  const mod = await moderateRun(account, checked, null, "own", { kind, place: onKey ? "own-key" : "own-gpu" });
  if (!mod.ok) return back(refuse(mod.refusal.status, mod.refusal.body.error, mod.refusal.body, mod.refusal.headers));
  const stamp: RunStamp | null = mod.checkOutputs ? { checkOutputs: true } : null;
  // Counted again just before the run is stored, with nothing awaited in between.
  if (activeAccountRuns(id) >= ACCOUNT_LIMITS.activeRuns) return back(refuse(429, ACCOUNT_MESSAGES.activeRuns, { code: ACTIVE_RUNS_CODE }, { "Retry-After": "30" }));
  try {
    const value = await asAccount(id, () => (stamp ? withRunStamp(stamp, run.start) : run.start()));
    return { ok: true, value, ...(gpuWarning && { gpuWarning }) };
  } catch (e) {
    return back(errorResponse(e));
  }
}
