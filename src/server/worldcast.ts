import "server-only";
import type { CasePart } from "@/lib/worldcast";
import { ProviderError } from "./providers/types";
import { getSetting } from "./settings";
import { tenantAccount } from "./tenant";

/**
 * The WorldCast worker's client (build plan N7-9; the contract is docs/workers/worldcast.md): an HTTP service on the owner's
 * GPU, outside ComfyUI, at Settings → Open-source engine · WORLDCAST_URL. POST /cases takes a case Fuobe prepared
 * (src/server/worldcast-case.ts) and answers a job id; GET /jobs/{id} says how it goes; GET /jobs/{id}/video is the MP4.
 *
 * It is the install's worker: an account's run never reaches it (its runs go to its own ComfyUI; the provider refuses one).
 */

export const WORLDCAST_SETTING = "Settings → Open-source engine · ComfyUI → WorldCast worker URL";
/** How long a health check waits: the three buttons ask before they plan. */
const HEALTH_TIMEOUT_MS = 3000;
/** How long an answer stays good for the planners (they are synchronous: they read this). */
const HEALTH_TTL_MS = 60_000;
/** A job id as the worker gives it: anything else is refused, never put in a path. */
export const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function worldcastBase(): string {
  return (getSetting("worldcastUrl") ?? "").trim().replace(/\/+$/, "");
}

export interface WorldcastHealth {
  ok: boolean;
  detail: string;
  model?: string;
  vramGb?: number;
  /** The extra depth models the worker can run itself ("depth-pro", "vggt-omega"), when it has them installed. */
  depth?: string[];
}

function guard(): void {
  if (tenantAccount()) throw new ProviderError("WorldCast runs on the studio's own GPU only.");
}

/** The Bearer header for the worker when a WORLDCAST_TOKEN is set (the reference server then refuses calls without it). */
export function worldcastHeaders(): Record<string, string> {
  const t = (getSetting("worldcastToken") ?? "").trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function call(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  guard();
  const base = worldcastBase();
  if (!base) throw new ProviderError(`No WorldCast worker is set up: add its address in ${WORLDCAST_SETTING} (or WORLDCAST_URL)`);
  try {
    return await fetch(`${base}${path}`, { ...init, headers: { ...worldcastHeaders(), ...(init.headers as Record<string, string> | undefined) }, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`The WorldCast worker at ${base} doesn't answer (${(e as Error).message}). Start it (workers/worldcast/README.md) or check ${WORLDCAST_SETTING}`);
  }
}

/** The worker's error text: its JSON `error` / `detail`, never an HTML page. */
async function said(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown; detail?: unknown };
    const m = typeof j.error === "string" ? j.error : typeof j.detail === "string" ? j.detail : "";
    if (m) return m.slice(0, 300);
  } catch {
    // not JSON
  }
  return /^\s*</.test(text) ? "" : text.trim().slice(0, 300);
}

async function failure(what: string, res: Response): Promise<ProviderError> {
  const detail = await said(res);
  return new ProviderError(`The WorldCast worker answered HTTP ${res.status} to ${what}${detail ? `: ${detail}` : ""}`, res.status);
}

/** GET /health. */
export async function worldcastHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<WorldcastHealth> {
  if (!worldcastBase()) return { ok: false, detail: "No WorldCast worker address set" };
  try {
    const res = await call("/health", {}, timeoutMs);
    if (!res.ok) return { ok: false, detail: (await failure("a health check", res)).message };
    const j = (await res.json()) as { ok?: boolean; model?: string; vram_gb?: number; depth?: unknown };
    if (j.ok !== true) return { ok: false, detail: "The WorldCast worker says it isn't ready yet (still loading its weights?)" };
    const depth = Array.isArray(j.depth) ? j.depth.filter((d): d is string => typeof d === "string") : [];
    const vram = typeof j.vram_gb === "number" ? ` · ${Math.round(j.vram_gb)} GB` : "";
    return { ok: true, detail: `WorldCast worker${j.model ? ` · ${j.model}` : ""}${vram}`, ...(j.model && { model: j.model }), ...(typeof j.vram_gb === "number" && { vramGb: j.vram_gb }), depth };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

declare global {
  var __fuobeWorldcast: { base: string; at: number; ok: boolean; depth?: string[]; pending?: Promise<boolean> } | undefined;
}

/** Ask the worker now (or reuse an answer under a minute old for the same address). */
export async function refreshWorldcast(force = false): Promise<boolean> {
  const base = worldcastBase();
  const cur = globalThis.__fuobeWorldcast;
  if (!base) return false;
  if (!force && cur?.base === base && Date.now() - cur.at < HEALTH_TTL_MS) return cur.ok;
  if (cur?.base === base && cur.pending) return cur.pending;
  const pending = worldcastHealth().then((h) => {
    globalThis.__fuobeWorldcast = { base, at: Date.now(), ok: h.ok, depth: h.depth ?? [] };
    return h.ok;
  });
  globalThis.__fuobeWorldcast = { base, at: cur?.base === base ? cur.at : 0, ok: cur?.base === base ? cur.ok : false, pending };
  return pending;
}

/**
 * Does the worker answer, as last seen (the planners are synchronous)? A stale answer starts a fresh look in the
 * background. Never for an account: the worker is the studio's own.
 */
export function worldcastAnswers(): boolean {
  if (tenantAccount()) return false;
  const base = worldcastBase();
  if (!base) return false;
  const cur = globalThis.__fuobeWorldcast;
  if (cur?.base !== base || Date.now() - cur.at >= HEALTH_TTL_MS) void refreshWorldcast().catch(() => false);
  return cur?.base === base && cur.ok;
}

/** The extra depth models the worker said it has ("depth-pro", "vggt-omega"), as last seen. */
export function worldcastDepths(): string[] {
  const cur = globalThis.__fuobeWorldcast;
  return cur?.base === worldcastBase() && cur.ok ? (cur.depth ?? []) : [];
}

/** POST /cases: the case as multipart; the job id. */
export async function submitCase(parts: CasePart[]): Promise<string> {
  const form = new FormData();
  for (const p of parts) {
    if ("value" in p) form.append(p.name, p.value);
    else form.append(p.name, new Blob([new Uint8Array(p.data)], { type: p.contentType }), p.filename);
  }
  const res = await call("/cases", { method: "POST", body: form }, 5 * 60_000);
  if (!res.ok) throw await failure("the case", res);
  const j = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (typeof j.id !== "string" || !JOB_ID.test(j.id)) throw new ProviderError("The WorldCast worker didn't answer with a job id");
  return j.id;
}

export type WorldcastJob =
  | { status: "queued" | "running"; progress?: number; message?: string }
  | { status: "succeeded" }
  | { status: "failed"; error: string };

/** GET /jobs/{id}. */
export async function jobStatus(id: string): Promise<WorldcastJob> {
  if (!JOB_ID.test(id)) throw new ProviderError("That isn't a WorldCast job");
  const res = await call(`/jobs/${id}`);
  if (res.status === 404) return { status: "failed", error: "The WorldCast worker no longer has this job (was it restarted?). Run it again" };
  if (!res.ok) throw await failure("a status check", res);
  const j = (await res.json()) as { status?: unknown; progress?: unknown; message?: unknown; error?: unknown };
  const progress = typeof j.progress === "number" && Number.isFinite(j.progress) ? Math.max(0, Math.min(1, j.progress)) : undefined;
  const message = typeof j.message === "string" ? j.message.slice(0, 200) : undefined;
  switch (j.status) {
    case "queued":
    case "running":
      return { status: j.status, ...(progress !== undefined && { progress }), ...(message && { message }) };
    case "succeeded":
      return { status: "succeeded" };
    case "failed":
      return { status: "failed", error: typeof j.error === "string" && j.error ? `WorldCast: ${j.error.slice(0, 300)}` : "WorldCast stopped without saying why" };
    default:
      throw new ProviderError("The WorldCast worker answered a status Fuobe doesn't know");
  }
}

/** The finished clip's address (GET /jobs/{id}/video). */
export function jobVideoUrl(id: string): string {
  if (!JOB_ID.test(id)) throw new ProviderError("That isn't a WorldCast job");
  return `${worldcastBase()}/jobs/${id}/video`;
}

/** The extra depth models the worker may run (POST /depth). */
export const WORKER_DEPTH = ["depth-pro", "vggt-omega"] as const;
export type WorkerDepth = (typeof WORKER_DEPTH)[number];

/** POST /depth: one picture's depth with the paper's own model, as a job; its picture is GET /jobs/{id}/depth.png. */
export async function submitDepth(model: WorkerDepth, image: Buffer, contentType = "image/png"): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([new Uint8Array(image)], { type: contentType }), "image.png");
  const res = await call("/depth", { method: "POST", body: form }, 5 * 60_000);
  if (!res.ok) throw await failure("a depth job", res);
  const j = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (typeof j.id !== "string" || !JOB_ID.test(j.id)) throw new ProviderError("The WorldCast worker didn't answer with a job id");
  return j.id;
}

/** A depth job's picture (GET /jobs/{id}/depth.png). */
export function jobDepthUrl(id: string): string {
  if (!JOB_ID.test(id)) throw new ProviderError("That isn't a WorldCast job");
  return `${worldcastBase()}/jobs/${id}/depth.png`;
}

/** GET /jobs/{id}/video: the MP4. */
export async function jobVideo(id: string): Promise<Buffer> {
  if (!JOB_ID.test(id)) throw new ProviderError("That isn't a WorldCast job");
  const res = await call(`/jobs/${id}/video`, {}, 5 * 60_000);
  if (!res.ok) throw await failure("the video", res);
  return Buffer.from(await res.arrayBuffer());
}

/** DELETE /jobs/{id}: stop it (a job that is gone already counts as stopped). */
export async function cancelJob(id: string): Promise<void> {
  if (!JOB_ID.test(id)) return;
  const res = await call(`/jobs/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await failure("a stop", res);
}
