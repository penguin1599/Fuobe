import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  ACTIVE_STATES,
  DEVICE_ID,
  FACT_LIMITS,
  INPUT_NAME,
  RELAY_LIMITS,
  RELAY_TIMES,
  reportAllowed,
  SENT_STATES,
  UUID,
  type BeatAnswer,
  type ClaimedTask,
  type ComputerFacts,
  type HistoryEntryLike,
  type RelayState,
  type ReportEvent,
  type TaskInput,
  type WantedFile,
} from "@/lib/relay";
import { DATA_DIR, db } from "../db";

/**
 * "Use the ComfyUI on this computer" (DESIGN.md): the server keeps each ComfyUI job of a run on someone's computer as a
 * task, and that person's Fuobe tab does it. A task holds the graph exactly as the server built it, the inputs it
 * staged (under names it chose), the prompt id it minted, and later the files it asks for. Tasks belong to a principal
 * ("owner", or "acct:<id>"), which every route takes from the session cookie, never from the request: one principal
 * can't see, take, read or fill another's task (an unknown or foreign task is a 404). A task is taken by one tab at a
 * time: each claim hands out a new lease, and every call about the task carries it. One computer at a time runs a
 * principal's waiting tasks (the runner, renewed by its beats); a task a computer took stays with that computer.
 */

/**
 * Whose tasks: the owner's, an account's, or (for a worker, docs/gpu-workers.md) a pool of the owner's GPUs. A task
 * always belongs to the owner or an account (its `principal`); a task for workers also names the pools that may take it
 * (`pools`), and a worker reaches it only through those.
 */
export type Principal = "owner" | `acct:${string}` | `pool:${string}`;

export const isPool = (p: Principal): p is `pool:${string}` => p.startsWith("pool:");

/** The relay's own folder: staged inputs and received outputs. Never served as it is. */
export const relayDir = () => path.join(DATA_DIR, "relay");
const inputFile = (name: string) => path.join(relayDir(), "in", name);
const taskDir = (id: string) => path.join(relayDir(), "tasks", id);
export const outputFile = (id: string, n: number) => path.join(taskDir(id), `out-${n}`);

declare global {
  /** Live progress by task id (written on every step, so kept in memory, not in SQLite). */
  var __fuobeRelayProgress: Map<string, Progress> | undefined;
}

export interface Progress {
  value?: number;
  max?: number;
  node?: string;
  nodesDone?: number;
  position?: number;
  at: number;
}

const progressMap = () => (globalThis.__fuobeRelayProgress ??= new Map());
export const taskProgress = (id: string): Progress | undefined => progressMap().get(id);

/** The relay's tables are made with the database (db.ts RELAY_TABLES). */
const rdb = () => db();

export interface TaskRow {
  id: string;
  principal: Principal;
  generation_id: string;
  state: RelayState;
  device: string | null;
  lease_hash: string | null;
  graph_json: string | null;
  prompt_id: string;
  prefix: string | null;
  meta_batch: number;
  preview: number;
  workflow_id: string | null;
  extra_json: string | null;
  wanted_json: string | null;
  received_json: string | null;
  result_json: string | null;
  error: string | null;
  refusal_json: string | null;
  stop: number;
  attempts: number;
  down_at: number | null;
  /** Why the computer's ComfyUI can't take it: "setting" (it answers, without Fuobe's setting), else it doesn't answer. */
  down_why: string | null;
  note: string | null;
  /** Workers only (all null for a browser computer's task): see pool.ts. */
  account: string | null;
  pools: string | null;
  rank_at: number | null;
  lane: string | null;
  needs_json: string | null;
  est_ms: number | null;
  tried_json: string | null;
  requeues: number;
  not_after: number | null;
  only_worker: string | null;
  worker_id: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  sent_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  device_seen_at: number | null;
}

interface InputRow {
  name: string;
  principal: string;
  task_id: string | null;
  n: number | null;
  content_type: string;
  size: number;
  sha256: string;
  reads: number;
  created_at: number;
}

export interface Received {
  n: number;
  bytes: number;
  total: number;
  done: boolean;
  contentType?: string;
}

export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const json = <T,>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function setTask(id: string, fields: Partial<TaskRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  rdb()
    .prepare(`UPDATE relay_tasks SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, updated_at: Date.now(), id });
}

/**
 * A principal's task, or null (another principal's task is no task at all). A pool's: a task for workers that this pool
 * may take.
 */
export function getTask(principal: Principal, id: string): TaskRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  if (isPool(principal)) {
    const t = rdb().prepare("SELECT * FROM relay_tasks WHERE id = ? AND pools IS NOT NULL").get(id) as TaskRow | undefined;
    return t && poolsOf(t).includes(principal.slice(5)) ? t : null;
  }
  return (rdb().prepare("SELECT * FROM relay_tasks WHERE id = ? AND principal = ?").get(id, principal) as TaskRow | undefined) ?? null;
}

/** The pools that may take a task (none: a browser computer's). */
export const poolsOf = (t: Pick<TaskRow, "pools">): string[] => (t.pools ? t.pools.split(",").filter(Boolean) : []);

// ---------------------------------------------------------------------------
// Inputs: staged by the server when it plans the run (comfyui.ts prepareFile, ctx.upload)

const extOf = (name: string, contentType: string) => {
  const fromName = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const ext = /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : (contentType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/g, "").slice(0, 5);
  return ext || "bin";
};

/** Keep an input for a principal's next task: returns the name its graph uses (and ComfyUI will get). */
export function stageInput(principal: Principal, data: Buffer, contentType: string, name: string): string {
  const staged = `fuobe_${nanoid(12).replace(/[^A-Za-z0-9_-]/g, "_")}.${extOf(name, contentType)}`;
  if (!INPUT_NAME.test(staged)) throw new Error("Couldn't name that file");
  fs.mkdirSync(path.dirname(inputFile(staged)), { recursive: true });
  fs.writeFileSync(inputFile(staged), data, { mode: 0o600 });
  rdb()
    .prepare("INSERT INTO relay_inputs (name, principal, task_id, n, content_type, size, sha256, reads, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, 0, ?)")
    .run(staged, principal, contentType.split(";")[0].trim().toLowerCase() || "application/octet-stream", data.length, crypto.createHash("sha256").update(data).digest("hex"), Date.now());
  return staged;
}

/** Every string a graph's nodes take (the names of the inputs it loads are among them). */
function graphStrings(graph: Record<string, { inputs?: Record<string, unknown> }>): Set<string> {
  const out = new Set<string>();
  for (const n of Object.values(graph)) for (const v of Object.values(n?.inputs ?? {})) if (typeof v === "string") out.add(v.replace(/ \[input\]$/, ""));
  return out;
}

export interface NewTask {
  principal: Principal;
  generationId: string;
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  prefix?: string;
  metaBatch?: boolean;
  preview?: boolean;
  workflowId?: string;
  /** What the run makes ("image", "video", "audio"…), for the tile's words. */
  made?: string;
  /** The run's LoRAs (for the words of a refusal). */
  loras?: { file: string; url?: string }[];
  /** For workers (pool.ts): the pools that may take it, and what they need to. */
  pool?: { pools: string[]; account?: string; rankAt: number; lane: string; needs: unknown; estMs?: number; notAfter?: number; onlyWorker?: string };
}

/** A ComfyUI job for a computer: the graph, the inputs it names, and a prompt id minted here. */
export function createTask(t: NewTask): { id: string; promptId: string } {
  const id = nanoid(16).replace(/[^A-Za-z0-9_-]/g, "_");
  const promptId = crypto.randomUUID();
  const now = Date.now();
  const d = rdb();
  const named = graphStrings(t.graph);
  d.transaction(() => {
    const pool = t.pool;
    d.prepare(
      `INSERT INTO relay_tasks (id, principal, generation_id, state, graph_json, prompt_id, prefix, meta_batch, preview, workflow_id, extra_json, created_at, updated_at,
         account, pools, rank_at, lane, needs_json, est_ms, not_after, only_worker)
       VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      t.principal,
      t.generationId,
      JSON.stringify(t.graph),
      promptId,
      t.prefix ?? null,
      t.metaBatch ? 1 : 0,
      t.preview ? 1 : 0,
      t.workflowId ?? null,
      JSON.stringify({ made: t.made, loras: t.loras ?? [] }),
      now,
      now,
      pool?.account ?? null,
      pool ? pool.pools.join(",") : null,
      pool ? pool.rankAt : null,
      pool?.lane ?? null,
      pool ? JSON.stringify(pool.needs) : null,
      pool?.estMs ?? null,
      pool?.notAfter ?? null,
      pool?.onlyWorker ?? null,
    );
    const free = d.prepare("SELECT name FROM relay_inputs WHERE principal = ? AND task_id IS NULL ORDER BY created_at").all(t.principal) as { name: string }[];
    let n = 0;
    for (const f of free) if (named.has(f.name)) d.prepare("UPDATE relay_inputs SET task_id = ?, n = ? WHERE name = ?").run(id, n++, f.name);
  })();
  return { id, promptId };
}

export const inputsOf = (taskId: string) => rdb().prepare("SELECT * FROM relay_inputs WHERE task_id = ? ORDER BY n").all(taskId) as InputRow[];

// ---------------------------------------------------------------------------
// The runner: one computer at a time runs a principal's waiting tasks

interface RunnerRow {
  principal: string;
  device: string;
  lease_until: number;
  seen_at: number;
  port: number | null;
  facts_json: string | null;
  /** Its ComfyUI at the last beat: answering ("ok"), not ("down"), or answering without Fuobe's setting. */
  comfy: "ok" | "down" | "no-setting";
}

const runnerOf = (principal: Principal) => rdb().prepare("SELECT * FROM relay_runners WHERE principal = ?").get(principal) as RunnerRow | undefined;

/**
 * The principal's runner is a ComfyUI paired with a code (Fuobe Connect runs inside ComfyUI, device "connect-…"), not
 * a Fuobe tab: a run waiting for it needs that ComfyUI started, not a tab opened.
 */
export function pairedRunner(principal: Principal): boolean {
  return !!runnerOf(principal)?.device.startsWith("connect-");
}

/** Is a computer of this principal's online: it beat in the last 30 s, and its ComfyUI answered? */
export function runnerOnline(principal: Principal, now = Date.now()): boolean {
  const r = runnerOf(principal);
  return !!r && r.comfy === "ok" && now - r.seen_at < RELAY_TIMES.onlineMs;
}

/**
 * What the computer said about its ComfyUI (the last report), and its port. Online: it beat in the last 30 s and its
 * ComfyUI answered then (a tab whose ComfyUI is closed, or runs without Fuobe's setting, keeps beating: not online).
 */
export function runnerFacts(principal: Principal): (ComputerFacts & { port?: number; seenAt: number; online: boolean; comfy?: "down" | "no-setting" }) | null {
  const r = runnerOf(principal);
  if (!r) return null;
  const here = Date.now() - r.seen_at < RELAY_TIMES.onlineMs;
  return { ...json<ComputerFacts>(r.facts_json, {}), ...(r.port && { port: r.port }), seenAt: r.seen_at, online: here && r.comfy === "ok", ...(here && r.comfy !== "ok" && { comfy: r.comfy }) };
}

/**
 * Forget a principal's computer (it disconnected: `disconnected` when the owner pressed Disconnect, its runs moved
 * elsewhere: `switched`, or the account went).
 */
export function forgetComputer(principal: Principal, why: "Stopped" | "switched" | "disconnected" = "Stopped"): void {
  rdb().prepare("DELETE FROM relay_runners WHERE principal = ?").run(principal);
  for (const t of rdb().prepare(`SELECT id FROM relay_tasks WHERE principal = ? AND pools IS NULL AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})`).all(principal, ...ACTIVE_STATES) as { id: string }[]) {
    endTask(t.id, "canceled", { error: why });
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const nonNeg = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Facts as kept: known keys, capped lengths, at most 20,000 LoRA names. */
export function cleanFacts(f: unknown, keep?: ComputerFacts): ComputerFacts {
  const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
  const loras = Array.isArray(o.loras)
    ? o.loras.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= FACT_LIMITS.loraName).slice(0, FACT_LIMITS.loras)
    : keep?.loras;
  return {
    ...(str(o.device, FACT_LIMITS.text) && { device: str(o.device, FACT_LIMITS.text) }),
    ...(nonNeg(o.vramBytes) !== undefined && { vramBytes: nonNeg(o.vramBytes) }),
    ...(nonNeg(o.ramBytes) !== undefined && { ramBytes: nonNeg(o.ramBytes) }),
    ...(str(o.version, 40) && { version: str(o.version, 40) }),
    ...(str(o.os, 40) && { os: str(o.os, 40) }),
    ...(typeof o.portable === "boolean" && { portable: o.portable }),
    ...((o.cors === "exact" || o.cors === "any" || o.cors === "other") && { cors: o.cors }),
    ...(typeof o.guard === "boolean" && { guard: o.guard }),
    ...(loras && { loras }),
  };
}

export interface BeatInput {
  device: string;
  port?: number;
  facts?: unknown;
  /** Tasks this tab is working on, with where each is. */
  running?: { task: string; position?: number; value?: number; max?: number; node?: string; nodesDone?: number }[];
  takeover?: boolean;
  /** Tasks whose prompts this computer took off its ComfyUI, as the server asked. */
  stopped?: string[];
  /** False: this computer's ComfyUI doesn't answer (a phone, a laptop without one, or ComfyUI restarting). */
  ready?: boolean;
  /** Not ready because ComfyUI answers without Fuobe's setting. */
  why?: "setting";
  /** A browser that may not reach this computer's apps yet (it hasn't been allowed): it hears how many wait, never runs them. */
  listen?: boolean;
}

/**
 * A computer's beat: it takes or renews the runner's place when that is free, lapsed, its own, or taken over; it keeps
 * the tasks it works on alive; and it hears which of its prompts to stop. A computer whose ComfyUI doesn't answer only
 * keeps a place it has (its ComfyUI restarting), so a phone or a laptop without ComfyUI never takes the jobs.
 */
export function beat(principal: Principal, b: BeatInput, now = Date.now()): BeatAnswer {
  if (!DEVICE_ID.test(b.device)) throw new RelayError(400, "Bad device");
  const d = rdb();
  sweepPrincipal(principal);
  const cur = runnerOf(principal);
  const elsewhere = !!cur && cur.device !== b.device && cur.lease_until >= now;
  const free = b.listen ? false : b.ready === false ? cur?.device === b.device : !elsewhere || b.takeover === true;
  const port = Number.isInteger(b.port) && b.port! > 0 && b.port! < 65536 ? b.port! : null;
  if (free) {
    const facts = b.facts !== undefined ? cleanFacts(b.facts, json<ComputerFacts>(cur?.facts_json ?? null, {})) : json<ComputerFacts>(cur?.device === b.device ? cur.facts_json : null, {});
    d.prepare(
      `INSERT INTO relay_runners (principal, device, lease_until, seen_at, port, facts_json, comfy) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal) DO UPDATE SET device = excluded.device, lease_until = excluded.lease_until, seen_at = excluded.seen_at, port = excluded.port, facts_json = excluded.facts_json, comfy = excluded.comfy`,
    ).run(principal, b.device, now + RELAY_TIMES.leaseMs, now, port ?? (cur?.device === b.device ? cur.port : null), JSON.stringify(facts), b.ready === false ? (b.why === "setting" ? "no-setting" : "down") : "ok");
  }
  // The tasks this computer works on stay alive, and their live progress is kept.
  for (const r of (b.running ?? []).slice(0, 32)) {
    const t = typeof r?.task === "string" ? getTask(principal, r.task) : null;
    if (!t || t.device !== b.device || !(SENT_STATES as readonly string[]).includes(t.state)) continue;
    setTask(t.id, { device_seen_at: now });
    noteProgress(t.id, r, now);
  }
  for (const id of (b.stopped ?? []).slice(0, 64)) {
    const t = typeof id === "string" ? getTask(principal, id) : null;
    if (t?.device === b.device) setTask(t.id, { stop: 0 });
  }
  const stops = (
    d.prepare("SELECT id, prompt_id, prefix FROM relay_tasks WHERE principal = ? AND device = ? AND stop = 1").all(principal, b.device) as { id: string; prompt_id: string; prefix: string | null }[]
  ).map((s) => ({ task: s.id, promptId: s.prompt_id, ...(s.prefix && { prefix: s.prefix }) }));
  const waiting = (d.prepare("SELECT COUNT(*) AS n FROM relay_tasks WHERE principal = ? AND pools IS NULL AND state = 'waiting'").get(principal) as { n: number }).n;
  return { runner: free, heldElsewhere: !free && elsewhere, waiting, stops };
}

export function noteProgress(id: string, r: Record<string, unknown>, now: number) {
  const p: Progress = { at: now };
  for (const k of ["value", "max", "nodesDone", "position"] as const) {
    const v = nonNeg(r[k]);
    if (v !== undefined) p[k] = Math.min(v, 1e6);
  }
  const node = str(r.node, 64);
  if (node) p.node = node;
  progressMap().set(id, { ...progressMap().get(id), ...p });
}

/**
 * A computer asks for work: first a task it took before and lost track of (a reload: not in `running`), then, when it is
 * the runner, the oldest waiting task. Null when there is none. The claim gets a new lease each time.
 */
export function claim(principal: Principal, device: string, running: string[], now = Date.now()): ClaimedTask | null {
  if (!DEVICE_ID.test(device)) throw new RelayError(400, "Bad device");
  const d = rdb();
  return d.transaction((): ClaimedTask | null => {
    const mine = d
      .prepare(`SELECT * FROM relay_tasks WHERE principal = ? AND pools IS NULL AND device = ? AND state IN ('sending','queued','running','collecting') AND stop = 0 ORDER BY created_at LIMIT 40`)
      .all(principal, device) as TaskRow[];
    let t: TaskRow | undefined = mine.find((x) => !running.includes(x.id));
    if (!t) {
      const r = runnerOf(principal);
      if (!r || r.device !== device || r.lease_until < now) return null;
      // The oldest waiting task, or one another computer took but never sent and went quiet on.
      t = d
        .prepare(
          `SELECT * FROM relay_tasks WHERE principal = ? AND pools IS NULL AND stop = 0 AND (state = 'waiting' OR (state = 'sending' AND sent_at IS NULL AND device != ? AND device_seen_at < ?))
           ORDER BY created_at LIMIT 1`,
        )
        .get(principal, device, now - RELAY_TIMES.leaseMs) as TaskRow | undefined;
      if (!t) return null;
    }
    return takeTask(t, device, now);
  })();
}

/**
 * Hand a task to a computer or worker (inside the caller's transaction): a new lease, and the task as it is sent. A task
 * this device had already resumes where it was; anything else starts by sending its inputs again.
 */
export function takeTask(t: TaskRow, device: string, now: number, fields: Partial<TaskRow> = {}): ClaimedTask {
  const lease = crypto.randomBytes(32).toString("hex");
  const resume = t.state === "waiting" || t.device !== device ? undefined : (t.state as ClaimedTask["resume"]);
  const fresh = t.state === "waiting" || t.device !== device;
  setTask(t.id, { device, lease_hash: hash(lease), state: t.state === "waiting" ? "sending" : t.state, claimed_at: now, device_seen_at: now, ...fields });
  if (fresh) rdb().prepare("UPDATE relay_inputs SET reads = 0 WHERE task_id = ?").run(t.id);
  const inputs: TaskInput[] = inputsOf(t.id).map((i) => ({ n: i.n!, name: i.name, size: i.size, sha256: i.sha256, contentType: i.content_type }));
  return {
    id: t.id,
    generationId: t.generation_id,
    lease,
    graph: json(t.graph_json, {}),
    promptId: t.prompt_id,
    preview: !!t.preview,
    ...(t.prefix && { prefix: t.prefix }),
    ...(t.meta_batch && { metaBatch: true }),
    inputs,
    ...(resume && { resume }),
    ...(t.state === "collecting" && { wanted: json<WantedFile[]>(t.wanted_json, []), received: json<Received[]>(t.received_json, []).map((r) => ({ n: r.n, bytes: r.bytes, done: r.done })) }),
  };
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A task call: the principal's task, taken with this lease. Unknown or foreign: 404. Another tab took it since: 409. */
export function leased(principal: Principal, id: string, lease: unknown): TaskRow {
  const t = getTask(principal, id);
  if (!t) throw new RelayError(404, "Not found");
  if (typeof lease !== "string" || !/^[0-9a-f]{64}$/.test(lease) || !t.lease_hash || !crypto.timingSafeEqual(Buffer.from(hash(lease)), Buffer.from(t.lease_hash))) {
    throw new RelayError(409, "Another tab is running this now", { code: "lease" });
  }
  return t;
}

/** An input's file for its task's tab, while it sends (a few reads each). */
export function inputFor(t: TaskRow, n: number): { path: string; size: number; contentType: string; sha256: string } {
  if (t.state !== "sending") throw new RelayError(409, "This run isn't sending files now");
  const row = rdb().prepare("SELECT * FROM relay_inputs WHERE task_id = ? AND n = ?").get(t.id, n) as InputRow | undefined;
  if (!row) throw new RelayError(404, "Not found");
  if (row.reads >= RELAY_LIMITS.inputReads) throw new RelayError(429, "That file was sent enough times. Press Retry on the run.");
  rdb().prepare("UPDATE relay_inputs SET reads = reads + 1 WHERE name = ?").run(row.name);
  setTask(t.id, { device_seen_at: Date.now() });
  return { path: inputFile(row.name), size: row.size, contentType: row.content_type, sha256: row.sha256 };
}

/**
 * Ends a task (its inputs go; its outputs stay until the run has kept them). `takeOff`: a prompt already on the
 * computer's ComfyUI is taken off it there (the computer hears it at its next beat): a cancel, or a timeout.
 */
export function endTask(id: string, state: "done" | "failed" | "canceled", fields: Partial<TaskRow> = {}, takeOff = state === "canceled") {
  const t = rdb().prepare("SELECT state, device FROM relay_tasks WHERE id = ?").get(id) as { state: RelayState; device: string | null } | undefined;
  const stop = takeOff && t && t.device && (SENT_STATES as readonly string[]).includes(t.state) ? 1 : 0;
  setTask(id, { state, finished_at: Date.now(), down_at: null, down_why: null, ...(stop && { stop }), ...fields });
  progressMap().delete(id);
  for (const i of rdb().prepare("SELECT name FROM relay_inputs WHERE task_id = ?").all(id) as { name: string }[]) fs.rmSync(inputFile(i.name), { force: true });
  rdb().prepare("DELETE FROM relay_inputs WHERE task_id = ?").run(id);
}

/**
 * What is kept of ComfyUI's /prompt refusal, as the tab reported it: the parts the run's words and "Fix it" read (the
 * error, and each node's errors with the value it got), each cut short, at most 16 KB in all.
 */
export function keptRefusal(body: unknown): { error?: Record<string, unknown>; node_errors?: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { error?: unknown; node_errors?: unknown };
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const err = obj(b.error);
  const info = obj(err?.extra_info);
  const error = err && { type: cut(err.type, 64), message: cut(err.message, 1024), ...(info && { extra_info: { class_type: cut(info.class_type, 128) } }) };
  const nodes: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(obj(b.node_errors) ?? {}).slice(0, 24)) {
    const ne = obj(raw);
    const errors = (Array.isArray(ne?.errors) ? ne.errors : []).slice(0, 6).map((x) => {
      const e = obj(x);
      const ei = obj(e?.extra_info);
      return { type: cut(e?.type, 64), message: cut(e?.message, 300), details: cut(e?.details, 300), extra_info: { input_name: cut(ei?.input_name, 64), received_value: cut(ei?.received_value, 256) } };
    });
    nodes[id.slice(0, 32)] = { class_type: cut(ne?.class_type, 128), errors };
  }
  const kept = { ...(error && { error }), node_errors: nodes };
  return JSON.stringify(kept).length <= RELAY_LIMITS.keptRefusalBytes ? kept : { ...(error && { error }), node_errors: {} };
}

/** What the server does with a finished prompt: the files it wants, a meta-batch to follow, or a failure. */
export type FinishedPlan = { wanted: WantedFile[]; outputs: unknown[]; budget: number } | { follow: string } | { error: string };

export interface ReportAnswer {
  ok: true;
  /** Where the task is now (the tab stops when it has ended). */
  state?: RelayState;
  wanted?: WantedFile[];
  follow?: string;
  stop?: boolean;
}

/**
 * A tab's report about its task (each taken only in its state: lib/relay.ts). `plan` turns a finished entry into the
 * files to collect (comfyui.ts, which knows the workflow's outputs).
 */
export function report(t: TaskRow, e: ReportEvent, plan: (entries: HistoryEntryLike[], last: boolean) => FinishedPlan, now = Date.now()): ReportAnswer {
  const a = reportOnce(t, e, plan, now);
  return { ...a, state: getTask(t.principal, t.id)?.state ?? t.state };
}

function reportOnce(t: TaskRow, e: ReportEvent, plan: (entries: HistoryEntryLike[], last: boolean) => FinishedPlan, now: number): ReportAnswer {
  if (t.stop && e.event !== "stopped") return { ok: true, stop: true };
  if (!reportAllowed(e.event, t.state)) {
    if (t.state === "canceled") return { ok: true, stop: true };
    throw new RelayError(409, `That doesn't fit this run now (${t.state})`);
  }
  const seen = { device_seen_at: now, down_at: null, down_why: null };
  switch (e.event) {
    case "sent": {
      const promptId = typeof e.promptId === "string" && UUID.test(e.promptId) ? e.promptId : typeof e.promptId === "string" && /^[\w-]{1,64}$/.test(e.promptId) ? e.promptId : null;
      if (!promptId) throw new RelayError(400, "Bad prompt id");
      setTask(t.id, { ...seen, state: "queued", prompt_id: promptId, sent_at: now, attempts: t.attempts + 1 });
      return { ok: true };
    }
    case "refused":
      setTask(t.id, { refusal_json: JSON.stringify({ status: Number(e.status) || 400, body: keptRefusal(e.body) }) });
      endTask(t.id, "failed");
      return { ok: true };
    case "queued":
      setTask(t.id, seen);
      noteProgress(t.id, { position: e.position }, now);
      return { ok: true };
    case "running":
      setTask(t.id, { ...seen, state: "running", ...(!t.started_at && { started_at: now }), note: null });
      noteProgress(t.id, { ...e, position: undefined }, now);
      return { ok: true };
    case "finished":
    case "passes": {
      if (e.event === "passes" && e.running) {
        setTask(t.id, { ...seen, state: "running" });
        return { ok: true };
      }
      const entries = e.event === "finished" ? [e.entry] : e.entries;
      if (!Array.isArray(entries) || entries.some((x) => !x || typeof x !== "object")) throw new RelayError(400, "Bad history entry");
      const p = plan(entries, e.event === "passes");
      if ("follow" in p) {
        if (!t.meta_batch) {
          endTask(t.id, "failed", { error: "This run finished without a result. Press Retry." });
          return { ok: true };
        }
        setTask(t.id, { ...seen, state: "running" });
        return { ok: true, follow: p.follow };
      }
      if ("error" in p) {
        endTask(t.id, "failed", { error: p.error });
        return { ok: true };
      }
      const received: Received[] = p.wanted.map((w) => ({ n: w.n, bytes: 0, total: 0, done: false }));
      if (!p.wanted.length) {
        endTask(t.id, "done", { result_json: JSON.stringify(p.outputs), wanted_json: "[]", received_json: "[]" });
        return { ok: true, wanted: [] };
      }
      setTask(t.id, {
        ...seen,
        state: "collecting",
        result_json: JSON.stringify(p.outputs),
        wanted_json: JSON.stringify(p.wanted),
        received_json: JSON.stringify(received),
        extra_json: JSON.stringify({ ...extraOf(t), budget: p.budget }),
      });
      return { ok: true, wanted: p.wanted };
    }
    case "gone":
      if (t.attempts < 2 && t.state !== "sending") {
        setTask(t.id, { ...seen, state: "sending", note: "resent", started_at: null });
        rdb().prepare("UPDATE relay_inputs SET reads = 0 WHERE task_id = ?").run(t.id);
        return { ok: true };
      }
      if (t.state === "sending") return { ok: true };
      endTask(t.id, "failed", { error: "lost" });
      return { ok: true };
    case "comfy-down":
      setTask(t.id, { device_seen_at: now, down_why: e.why ?? null, ...(t.down_at ? {} : { down_at: now }) });
      return { ok: true };
    case "stopped":
      setTask(t.id, { stop: 0 });
      return { ok: true };
    case "failed":
      endTask(t.id, "failed", { error: `tab:${e.reason}${e.status ? `:${Number(e.status) | 0}` : ""}` });
      return { ok: true };
  }
}

/** Where an upload of an output stands. */
export function outputStatus(t: TaskRow, n: number): Received {
  const r = json<Received[]>(t.received_json, []).find((x) => x.n === n);
  if (!r) throw new RelayError(404, "Not found");
  return r;
}

/** Bytes in the first part of a file: enough to say what it is. */
export const SNIFF_BYTES = 64;

/**
 * Take part of a wanted output: only while collecting, only a file the server asked for, at exactly the offset already
 * received, never past its size limit, and only once (a finished file can't be sent again). `check` reads the first part
 * and says what the file is (or throws); `write` appends the part.
 */
export async function receivePart(
  t: TaskRow,
  n: number,
  o: { offset: number; total: number; length: number },
  write: (file: string, append: boolean) => Promise<{ bytes: number; head: Buffer }>,
  check: (head: Buffer, w: WantedFile, total: number) => string,
): Promise<Received> {
  if (t.state !== "collecting") throw new RelayError(409, "This run isn't saving results now");
  const wanted = json<WantedFile[]>(t.wanted_json, []).find((w) => w.n === n);
  if (!wanted) throw new RelayError(404, "Not found");
  const all = json<Received[]>(t.received_json, []);
  const cur = all.find((r) => r.n === n)!;
  if (cur.done) throw new RelayError(409, "That file was saved already");
  if (!Number.isInteger(o.total) || o.total < 1 || o.total > wanted.maxBytes) {
    throw new RelayError(413, wanted.maxBytes >= 2 ** 30 ? "tooBig" : "Your ComfyUI made a file bigger than this run can keep", { fail: true });
  }
  if (cur.total && cur.total !== o.total) throw new RelayError(409, "The file's size changed");
  // All the files together fit the room the run had when it finished.
  const others = all.filter((r) => r.n !== n).reduce((s, r) => s + r.total, 0);
  const budget = extraOf(t).budget ?? Infinity;
  if (others + o.total > budget) throw new RelayError(413, "full", { fail: true });
  if (o.offset !== cur.bytes) throw new RelayError(409, "Wrong place in the file", { received: cur.bytes });
  if (o.offset + o.length > o.total || o.length > RELAY_LIMITS.partBytes) throw new RelayError(413, "Too much at once");
  const file = outputFile(t.id, n);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  if (o.offset === 0) fs.rmSync(part, { force: true });
  const got = await write(part, o.offset > 0);
  if (got.bytes !== o.length) {
    // Cut short: what arrived is dropped, so the next try starts where this part did.
    fs.truncateSync(part, o.offset);
    throw new RelayError(400, "The part didn't arrive whole");
  }
  let contentType = cur.contentType;
  if (o.offset === 0) {
    try {
      contentType = check(got.head, wanted, o.total);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw new RelayError(415, (e as Error).message, { fail: true });
    }
  }
  const bytes = o.offset + got.bytes;
  const done = bytes === o.total;
  if (done) fs.renameSync(part, file);
  const fresh = getTask(t.principal, t.id);
  const list = json<Received[]>(fresh?.received_json ?? null, all).map((r) => (r.n === n ? { n, bytes, total: o.total, done, ...(contentType && { contentType }) } : r));
  setTask(t.id, { received_json: JSON.stringify(list), device_seen_at: Date.now() });
  if (list.every((r) => r.done)) endTask(t.id, "done");
  return list.find((r) => r.n === n)!;
}

/** A task failed while saving a result (a file that isn't what it should be, or too big). */
export function failTask(t: TaskRow, error: string): void {
  if ((ACTIVE_STATES as readonly string[]).includes(t.state)) endTask(t.id, "failed", { error });
}

/** The tab let go of a task it hadn't sent yet (the tab closes): another tab or computer may take it at once. */
export function release(t: TaskRow): void {
  if (t.state === "sending" && !t.sent_at) {
    setTask(t.id, { state: "waiting", device: null, lease_hash: null });
    rdb().prepare("UPDATE relay_inputs SET reads = 0 WHERE task_id = ?").run(t.id);
  } else setTask(t.id, { lease_hash: null });
}

/**
 * Stop a task (the run was canceled or timed out): a waiting one ends at once; one a computer took is taken off its
 * ComfyUI at the computer's next beat.
 */
export function requestStop(principal: Principal, id: string): void {
  const t = getTask(principal, id);
  if (!t || !(ACTIVE_STATES as readonly string[]).includes(t.state)) return;
  endTask(t.id, "canceled", { error: "Stopped" });
}

/** The tasks whose run is no longer going (deleted, canceled from elsewhere) stop: a principal's, or everyone's. */
function sweepPrincipal(principal?: Principal) {
  const orphans = rdb()
    .prepare(
      `SELECT t.id FROM relay_tasks t LEFT JOIN generations g ON g.id = t.generation_id
       WHERE ${principal ? "t.principal = ? AND " : ""}t.state IN (${ACTIVE_STATES.map(() => "?").join(",")}) AND (g.id IS NULL OR g.status NOT IN ('queued','running'))`,
    )
    .all(...(principal ? [principal] : []), ...ACTIVE_STATES) as { id: string }[];
  for (const o of orphans) endTask(o.id, "canceled", { error: "Stopped" });
}

/** A deleted account's computer: its place as runner, its tasks and every file the relay kept for it go. */
export function purgeComputer(principal: Principal): void {
  const d = rdb();
  for (const t of d.prepare("SELECT id FROM relay_tasks WHERE principal = ?").all(principal) as { id: string }[]) {
    progressMap().delete(t.id);
    fs.rmSync(taskDir(t.id), { recursive: true, force: true });
  }
  for (const i of d.prepare("SELECT name FROM relay_inputs WHERE principal = ?").all(principal) as { name: string }[]) fs.rmSync(inputFile(i.name), { force: true });
  d.transaction(() => {
    d.prepare("DELETE FROM relay_inputs WHERE principal = ?").run(principal);
    d.prepare("DELETE FROM relay_tasks WHERE principal = ?").run(principal);
    d.prepare("DELETE FROM relay_runners WHERE principal = ?").run(principal);
    // Its paired ComfyUIs (Fuobe Connect) stop with it.
    d.prepare("DELETE FROM relay_workers WHERE kind = 'personal' AND principal = ?").run(principal);
    d.prepare("DELETE FROM relay_pairings WHERE principal = ?").run(principal);
  })();
}

declare global {
  var __fuobeRelaySweep: NodeJS.Timeout | undefined;
}

/** Sweep the relay every 15 minutes (once per process), and forget a deleted account's computer with its account. */
export function ensureRelaySweep(onDeleted: (hook: (id: string) => void) => void): void {
  if (globalThis.__fuobeRelaySweep) return;
  const run = () => {
    try {
      sweepRelay();
    } catch (e) {
      console.warn(`[fuobe] relay sweep failed: ${(e as Error).message}`);
    }
  };
  globalThis.__fuobeRelaySweep = setInterval(run, 15 * 60_000);
  globalThis.__fuobeRelaySweep.unref?.();
  onDeleted((id) => purgeComputer(`acct:${id}`));
  run();
}

/**
 * Files and rows nobody needs: tasks whose run stopped going, inputs staged for a task that never came (an hour), and
 * ended tasks (their folders once the run is no longer going, their rows after a day). Every 15 minutes
 * (ensureRelaySweep); a beat sweeps its own principal's.
 */
export function sweepRelay(now = Date.now()): { inputs: number; tasks: number } {
  const d = rdb();
  sweepPrincipal();
  const stale = d.prepare("SELECT name FROM relay_inputs WHERE task_id IS NULL AND created_at < ?").all(now - RELAY_TIMES.stagedMs) as { name: string }[];
  for (const s of stale) fs.rmSync(inputFile(s.name), { force: true });
  d.prepare("DELETE FROM relay_inputs WHERE task_id IS NULL AND created_at < ?").run(now - RELAY_TIMES.stagedMs);
  const ended = d
    .prepare(
      `SELECT t.id, t.finished_at FROM relay_tasks t LEFT JOIN generations g ON g.id = t.generation_id
       WHERE t.state IN ('done','failed','canceled') AND (g.id IS NULL OR g.status NOT IN ('queued','running') OR t.finished_at < ?)`,
    )
    .all(now - RELAY_TIMES.keepMs) as { id: string; finished_at: number | null }[];
  for (const t of ended) {
    fs.rmSync(taskDir(t.id), { recursive: true, force: true });
    d.prepare("UPDATE relay_tasks SET graph_json = NULL WHERE id = ?").run(t.id);
  }
  const old = d.prepare("DELETE FROM relay_tasks WHERE state IN ('done','failed','canceled') AND finished_at < ?").run(now - RELAY_TIMES.keepMs);
  return { inputs: stale.length, tasks: old.changes };
}

/**
 * The clocks a task's own computer runs on (the run's queue and running clocks are the runner's, generations.ts): a
 * computer that took it and went quiet for 30 minutes, or a ComfyUI that stopped answering for 30 minutes, fails it.
 * Returns the task as it is now.
 */
export function checkClocks(t: TaskRow, now = Date.now()): TaskRow {
  if (t.pools) return poolClocks ? poolClocks(t, now) : t;
  if (!(SENT_STATES as readonly string[]).includes(t.state)) return t;
  if (t.device_seen_at && now - t.device_seen_at > RELAY_TIMES.silentMs) endTask(t.id, "failed", { error: "silent" }, true);
  else if (t.down_at && now - t.down_at > RELAY_TIMES.comfyDownMs) endTask(t.id, "failed", { error: "down" }, true);
  else return t;
  return getTask(t.principal, t.id) ?? t;
}

/** A task for workers keeps the workers' clocks (pool.ts sets this, so this file needn't import it). */
let poolClocks: ((t: TaskRow, now: number) => TaskRow) | null = null;
export const setPoolClocks = (fn: (t: TaskRow, now: number) => TaskRow) => (poolClocks = fn);

/** The file of a received output, for the principal whose task it is (anyone else: null). */
export function receivedFile(principal: Principal, taskId: string, n: number): { path: string; contentType?: string } | null {
  const t = getTask(principal, taskId);
  if (!t) return null;
  const r = json<Received[]>(t.received_json, []).find((x) => x.n === n);
  if (!r?.done) return null;
  const p = outputFile(t.id, n);
  return fs.existsSync(p) ? { path: p, contentType: r.contentType } : null;
}

export const wantedOf = (t: TaskRow) => json<WantedFile[]>(t.wanted_json, []);
export const receivedOf = (t: TaskRow) => json<Received[]>(t.received_json, []);
export const resultOf = <T,>(t: TaskRow) => json<T[]>(t.result_json, []);
export const extraOf = (t: TaskRow) => json<{ made?: string; loras?: { file: string; url?: string }[]; budget?: number }>(t.extra_json, {});
export const refusalOf = (t: TaskRow) => json<{ status: number; body: unknown } | null>(t.refusal_json, null);
export const inputKinds = (t: TaskRow) => (rdb().prepare("SELECT content_type FROM relay_inputs WHERE task_id = ?").all(t.id) as { content_type: string }[]).map((r) => r.content_type);
