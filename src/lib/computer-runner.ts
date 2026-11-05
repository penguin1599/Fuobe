/**
 * The Fuobe tab's side of "Use the ComfyUI on this computer" (DESIGN.md): it beats to the server, takes the person's
 * jobs one at a time, sends each one's inputs and exact graph to the ComfyUI on 127.0.0.1, follows it (the live socket
 * for steps and previews, the job and history reads for where it is), reports back, and uploads the results the server
 * asks for. It decides nothing about the result. Every address it uses on the person's computer comes from
 * lib/local-comfy.ts, which allows only what a run needs, and it refuses a graph that would read files the run didn't
 * send. No React and no browser-only API is needed: the page (src/components/gpu/computer-runner.tsx) gives it fetch,
 * a socket and a clock, and the tests drive it from Node against a stand-in ComfyUI.
 */
import { isGuard } from "./comfy-guard";
import { fetchWithin } from "./fetch-within";
import { parseComfyBinary, parseComfyText } from "./comfy-ws";
import { graphProblem, localBase, mayDownload, readPath, statsFacts, viewPath, writePath, type SystemStats } from "./local-comfy";
import { DONE_SHOWN_MS, META_BATCH_HISTORY, RELAY_LIMITS, RELAY_TIMES, type BeatAnswer, type ClaimedTask, type ComputerFacts, type HistoryEntryLike, type RelayState, type ReportEvent, type TabFailure, type WantedFile } from "./relay";

/** The parts of a WebSocket the runner uses (the browser's, or Node's). */
export interface SocketLike {
  binaryType: string;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onopen: ((e?: unknown) => void) | null;
  close(): void;
}

export interface RunnerDeps {
  /** Fuobe's own API on this site (the session cookie goes with it). */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** The ComfyUI on this computer: no headers of Fuobe's own, no cookies. */
  local: (url: string, init?: RequestInit) => Promise<Response>;
  /** A socket to the ComfyUI on this computer (null: none, progress comes from reading the job). */
  socket?: (url: string) => SocketLike | null;
  sha256: (data: ArrayBuffer) => Promise<string>;
  /** This site's address, as ComfyUI's setting must name it. */
  origin: string;
  /**
   * ComfyUI stopped answering where the runner looks: is it on another port now? (The page looks on ComfyUI's usual
   * ports, only when the browser already lets Fuobe reach this computer.) The port and host, or null.
   */
  find?: (except: number) => Promise<{ port: number; host?: string } | null>;
  /** The runner moved to another port (the page remembers it). */
  moved?: (port: number, host: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * A worker program's own checks (docs/gpu-workers.md) before a graph goes to its ComfyUI: its node allowlist, path
   * strings, verified models. The failure, or null. (A browser tab has none: graphProblem is its check.)
   */
  vet?: (t: ClaimedTask) => TabFailure | null;
  /** A job ended here, done or not: a worker deletes its files. */
  ended?: (t: ClaimedTask, phase: LocalJob["phase"]) => void | Promise<void>;
  /** More to say in each beat (a worker's pause, its GPU, its inventory), and what the studio answered. */
  beatExtra?: () => Record<string, unknown>;
  onBeat?: (a: BeatAnswer) => void;
}

/** What the page shows about one job this tab runs. */
export interface LocalJob {
  taskId: string;
  generationId: string;
  phase: "sending" | "queued" | "running" | "saving" | "done" | "failed";
  value?: number;
  max?: number;
  position?: number;
  /** The latest live preview (an image the page shows under the tile's shimmer). */
  preview?: Blob;
  saved?: number;
  /** Saving waits for the studio (it is busy saving other results). */
  waiting?: boolean;
  /** When it was saved, or failed (this tab's clock). */
  endedAt?: number;
}

export interface RunnerView {
  /** This computer runs the waiting jobs. */
  runner: boolean;
  /** Another computer does. */
  heldElsewhere: boolean;
  waiting: number;
  /** ComfyUI here: answering, not answering, or answering without Fuobe's setting. */
  comfy: "ok" | "down" | "no-setting";
  /**
   * This browser may not reach apps on this computer yet: it would ask first ("ask"), or it was told no ("blocked").
   * Then the runner only listens (how many wait) and never touches ComfyUI.
   */
  access?: "ask" | "blocked";
  /** Where it looks for ComfyUI. */
  port: number;
  /** The session ended, or the person disconnected: the runner stopped. */
  stopped?: "signed-out" | "disconnected";
  jobs: LocalJob[];
  facts?: ComputerFacts;
}

class Stopped extends Error {}

const PROGRESS_EVERY_MS = 500;
const POLL_MS = 1000;
/** How often a ComfyUI that stopped answering is looked for on the other ports. */
const FIND_EVERY_MS = 20_000;
/** Ended jobs the view keeps (a tile shows the last preview until its run moves on). */
const KEEP_ENDED = 6;
/**
 * How long a look at ComfyUI here (its facts, a job's state) and a beat to the studio wait for an answer. A ComfyUI busy
 * at full load, or a studio that is restarting, can take a request and not answer: the beat then counts it as not
 * answering and the next one tries again, instead of waiting for good and never beating again.
 */
const LOOK_MS = 15_000;
const BEAT_MS = 20_000;
/** How long a result may wait for a busy studio before the run gives up. */
const SAVE_WAIT_MS = 60 * 60_000;

/** Retry-After in ms (1 to 30 s; 2 s when it doesn't say). */
const retryAfter = (res: Response) => Math.min(30, Math.max(1, Number(res.headers.get("retry-after")) || 2)) * 1000;

/** The prompts of a meta-batch job: their entries name the job's filename prefix. */
const hasPrefix = (prompt: unknown, prefix: string) =>
  !!prompt && typeof prompt === "object" && Object.values(prompt as Record<string, { inputs?: Record<string, unknown> }>).some((n) => n?.inputs?.filename_prefix === prefix);

/** A history entry as the server needs it: status and outputs (not the whole graph again). */
const slim = (e: HistoryEntryLike & { prompt?: unknown[] }): HistoryEntryLike => ({ prompt: e.prompt ? [e.prompt[0], e.prompt[1]] : undefined, status: e.status, outputs: e.outputs });

export class ComputerRunner {
  readonly view: RunnerView;
  private listeners = new Set<(v: RunnerView) => void>();
  private busy = false;
  private stopping = new Set<string>();
  private ws: SocketLike | null = null;
  private wsOpen = false;
  private events = new Map<string, { value?: number; max?: number; node?: string; nodesDone: number; done?: boolean }>();
  private factsSentAt = 0;
  private factsWithLoras = 0;
  private foundAt = 0;
  private guard: boolean | undefined;
  private jobsApi: boolean | undefined;
  private alive = true;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private base: string;

  constructor(
    private deps: RunnerDeps,
    private o: { device: string; port: number; host?: string; clientId: string; access?: "ask" | "blocked" },
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = localBase(o.port, o.host);
    this.view = { runner: false, heldElsewhere: false, waiting: 0, comfy: "ok", port: o.port, ...(o.access && { access: o.access }), jobs: [] };
  }

  onChange(fn: (v: RunnerView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.view);
  }

  private job(t: Pick<ClaimedTask, "id" | "generationId">, patch: Partial<LocalJob>) {
    const at = this.view.jobs.findIndex((j) => j.taskId === t.id);
    const was: LocalJob = at >= 0 ? this.view.jobs[at] : { taskId: t.id, generationId: t.generationId, phase: "sending" };
    const ends = (patch.phase === "done" || patch.phase === "failed") && patch.phase !== was.phase;
    const next = { ...was, ...patch, ...(ends && { endedAt: this.now() }) };
    let jobs = at >= 0 ? this.view.jobs.map((j, i) => (i === at ? next : j)) : [...this.view.jobs, next];
    // Ended jobs stay a while (their tile keeps the last preview until the run moves on), the newest few.
    const ended = jobs.filter((j) => j.phase === "done" || j.phase === "failed");
    if (ended.length > KEEP_ENDED) {
      const drop = new Set(ended.slice(0, ended.length - KEEP_ENDED));
      jobs = jobs.filter((j) => !drop.has(j));
    }
    this.view.jobs = jobs;
    this.emit();
  }

  /** Stop for good (the page closes, the person disconnects, the session ended). */
  stop(reason?: RunnerView["stopped"]) {
    this.alive = false;
    if (reason) this.view.stopped = reason;
    try {
      this.ws?.close();
    } catch {}
    this.emit();
  }

  // -------------------------------------------------------------------------
  // The ComfyUI here

  private async read<T>(path: string): Promise<T> {
    const res = await fetchWithin(`${this.base}${readPath(path)}`, LOOK_MS, { credentials: "omit", cache: "no-store" }, this.deps.local);
    if (!res.ok) throw Object.assign(new Error(`ComfyUI ${path.split("?")[0]} answered HTTP ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }

  private async send(path: string, check: unknown, own: { promptIds: string[]; names?: string[] }, init: RequestInit): Promise<Response> {
    return this.deps.local(`${this.base}${writePath(path, check, own)}`, { ...init, method: "POST", credentials: "omit", cache: "no-store" });
  }

  /**
   * ComfyUI here, as every caller sees it: readable (its facts), answering but not to this site (it runs without Fuobe's
   * setting: a no-cors look sees that something answers), or not answering. One look, so the page never hears two
   * stories. Not answering where it was, it is looked for on the other ports now and then (the page's `find`).
   */
  private async look(): Promise<{ comfy: "ok"; stats: SystemStats } | { comfy: "down" | "no-setting" }> {
    let l: { comfy: "ok"; stats: SystemStats } | { comfy: "down" | "no-setting" };
    try {
      l = { comfy: "ok", stats: await this.read<SystemStats>("/system_stats") };
    } catch (e) {
      const answers = (e as { status?: number }).status === 403 || (await fetchWithin(`${this.base}/system_stats`, LOOK_MS, { mode: "no-cors", credentials: "omit", cache: "no-store" }, this.deps.local).then(() => true, () => false));
      l = { comfy: answers ? "no-setting" : "down" };
      if (!answers && (await this.findElsewhere())) return this.look();
    }
    if (this.view.comfy !== l.comfy) {
      this.view.comfy = l.comfy;
      this.emit();
    }
    return l;
  }

  /** ComfyUI isn't where the runner looks: when it answers on another port, the runner goes there. True when it moved. */
  private async findElsewhere(): Promise<boolean> {
    if (!this.deps.find || this.now() - this.foundAt < FIND_EVERY_MS) return false;
    this.foundAt = this.now();
    const there = await this.deps.find(this.o.port).catch(() => null);
    if (!there || there.port === this.o.port) return false;
    const host = there.host ?? "127.0.0.1";
    this.base = localBase(there.port, host);
    Object.assign(this.o, { port: there.port, host });
    this.view.port = there.port;
    this.guard = undefined;
    this.jobsApi = undefined;
    // The live socket was to the old port.
    try {
      this.ws?.close();
    } catch {}
    this.deps.moved?.(there.port, host);
    this.emit();
    return true;
  }

  /** What ComfyUI here is, for the server (its GPU, memory, version, Fuobe's guard; its LoRA names now and then). */
  async facts(o: { loras?: boolean; guard?: boolean } = {}): Promise<ComputerFacts | null> {
    const l = await this.look();
    if (l.comfy !== "ok") return null;
    if (o.guard || this.guard === undefined) this.guard = await this.read<unknown>("/fuobe/guard").then(isGuard, () => false);
    const f: ComputerFacts = statsFacts(l.stats, this.deps.origin, this.guard);
    if (o.loras) {
      const loras = await this.read<unknown>("/models/loras").catch(() => null);
      if (Array.isArray(loras)) f.loras = loras.filter((x): x is string => typeof x === "string");
    }
    this.view.facts = f;
    return f;
  }

  private socket() {
    if (this.wsOpen || this.ws || !this.deps.socket) return;
    let ws: SocketLike | null;
    try {
      ws = this.deps.socket(`${this.base.replace(/^http/, "ws")}${readPath(`/ws?clientId=${this.o.clientId}`)}`);
    } catch {
      ws = null;
    }
    if (!ws) return;
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => (this.wsOpen = true);
    ws.onclose = ws.onerror = () => {
      this.wsOpen = false;
      if (this.ws === ws) this.ws = null;
    };
    ws.onmessage = (m) => {
      if (typeof m.data === "string") {
        const e = parseComfyText(m.data);
        if (!e || !("promptId" in e) || !e.promptId) return;
        const cur = this.events.get(e.promptId) ?? { nodesDone: 0 };
        if (e.type === "progress") Object.assign(cur, { value: e.value, max: e.max, node: e.node });
        else if (e.type === "executing" && e.node) Object.assign(cur, { node: e.node, nodesDone: cur.nodesDone + 1, value: undefined, max: undefined });
        else if (e.type === "success" || e.type === "error" || e.type === "interrupted" || (e.type === "executing" && !e.node)) cur.done = true;
        this.events.set(e.promptId, cur);
        return;
      }
      const p = parseComfyBinary(m.data as ArrayBuffer);
      if (!p) return;
      // A preview goes only to the prompt's own client: this tab's job (a newer ComfyUI also names the prompt).
      const job = this.view.jobs.find((j) => j.phase === "running" && (!p.promptId || this.events.has(p.promptId)));
      if (job) this.job({ id: job.taskId, generationId: job.generationId }, { preview: new Blob([p.data as BlobPart], { type: p.type }) });
    };
  }

  /** Where a prompt is on ComfyUI here. */
  private async where(promptId: string, prefix?: string): Promise<{ s: "pending"; ahead: number } | { s: "running" } | { s: "done"; entry: HistoryEntryLike } | { s: "absent" }> {
    if (this.jobsApi === undefined) this.jobsApi = await this.read("/api/jobs").then(() => true, () => false);
    const history = async () => (await this.read<Record<string, HistoryEntryLike>>(`/history/${promptId}`))[promptId];
    if (this.jobsApi) {
      const res = await fetchWithin(`${this.base}${readPath(`/api/jobs/${promptId}`)}`, LOOK_MS, { credentials: "omit", cache: "no-store" }, this.deps.local);
      if (res.status === 404) return prefix ? this.whereByQueue(promptId) : { s: "absent" };
      if (!res.ok) throw Object.assign(new Error(`ComfyUI answered HTTP ${res.status}`), { status: res.status });
      const j = (await res.json()) as { status?: string };
      if (j.status === "in_progress") return { s: "running" };
      if (j.status === "pending") return this.whereByQueue(promptId);
      const entry = await history();
      return entry ? { s: "done", entry } : { s: "absent" };
    }
    const entry = await history();
    if (entry && (entry.status?.completed || entry.status?.status_str)) return { s: "done", entry };
    return this.whereByQueue(promptId);
  }

  private async whereByQueue(promptId: string): Promise<{ s: "pending"; ahead: number } | { s: "running" } | { s: "done"; entry: HistoryEntryLike } | { s: "absent" }> {
    const q = await this.read<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue");
    if ((q.queue_running ?? []).some((r) => r[1] === promptId)) return { s: "running" };
    const pending = [...(q.queue_pending ?? [])].sort((a, b) => Number(a[0]) - Number(b[0]));
    const at = pending.findIndex((r) => r[1] === promptId);
    if (at >= 0) return { s: "pending", ahead: at + (q.queue_running?.length ?? 0) };
    // It may have finished between the two reads.
    const entry = (await this.read<Record<string, HistoryEntryLike>>(`/history/${promptId}`))[promptId];
    return entry ? { s: "done", entry } : { s: "absent" };
  }

  // -------------------------------------------------------------------------
  // The server

  /** A report about a job (its token in a header, so the studio checks it before it reads the report). */
  private async report(t: ClaimedTask, e: ReportEvent): Promise<{ wanted?: WantedFile[]; follow?: string; stop?: boolean; state?: RelayState }> {
    // A busy studio (429) is waited out, for a while; other failures are tried a few times.
    const until = this.now() + 2 * 60_000;
    for (let i = 0; ; ) {
      const res = await this.deps.api(`/api/gpu/computer/tasks/${t.id}/report`, { method: "POST", headers: { "Content-Type": "application/json", "X-Fuobe-Lease": t.lease }, body: JSON.stringify(e) });
      if (res.ok) return (await res.json()) as { wanted?: WantedFile[]; follow?: string; stop?: boolean; state?: RelayState };
      if (res.status === 401) {
        this.stop("signed-out");
        throw new Stopped();
      }
      // The job ended or another tab has it: this tab lets go.
      if (res.status === 404 || res.status === 409) throw new Stopped();
      if (res.status === 429 && this.now() < until) {
        await this.sleep(retryAfter(res));
        continue;
      }
      if (++i > 4) throw new Error(`The studio answered HTTP ${res.status}`);
      await this.sleep(1000 * i);
    }
  }

  /** One beat: say this computer is here, keep its jobs alive, and stop what the server says to stop. */
  async beat(takeover = false): Promise<BeatAnswer | null> {
    if (!this.alive) return null;
    const t = this.now();
    // A browser that may not reach this computer yet only hears how many jobs wait (never ComfyUI, never the jobs).
    if (this.o.access) return this.beatWith({ device: this.o.device, ready: false, listen: true, running: [] });
    // A look at ComfyUI here every beat (only a computer whose ComfyUI answers takes the jobs); its facts go to the
    // server every minute, the LoRA names every 5 minutes.
    const due = t - this.factsSentAt > 60_000;
    const loras = due && t - this.factsWithLoras > 5 * 60_000;
    const read = await this.facts({ loras, guard: due });
    const facts = due ? read : null;
    if (facts) {
      this.factsSentAt = t;
      if (loras) this.factsWithLoras = t;
    }
    const running = this.view.jobs
      .filter((j) => j.phase !== "done" && j.phase !== "failed")
      .map((j) => {
        const ev = this.events.get(this.promptOf.get(j.taskId) ?? "");
        return { task: j.taskId, ...(j.position !== undefined && { position: j.position }), ...(j.phase === "running" && ev && { value: ev.value, max: ev.max, nodesDone: ev.nodesDone }) };
      });
    const stopped = [...this.stoppedDone];
    return this.beatWith(
      {
        ...this.deps.beatExtra?.(),
        device: this.o.device,
        port: this.o.port,
        ready: !!read,
        ...(this.view.comfy === "no-setting" && { why: "setting" }),
        ...(facts && { facts }),
        running,
        ...(stopped.length && { stopped }),
        ...(takeover && { takeover: true }),
      },
      stopped,
    );
  }

  private async beatWith(body: Record<string, unknown>, stopped: string[] = []): Promise<BeatAnswer | null> {
    const res = await fetchWithin("/api/gpu/computer/beat", BEAT_MS, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, this.deps.api);
    if (res.ok) for (const s of stopped) this.stoppedDone.delete(s);
    if (res.status === 401) {
      this.stop("signed-out");
      return null;
    }
    if (res.status === 403 || res.status === 409) {
      this.stop("disconnected");
      return null;
    }
    if (!res.ok) return null;
    const a = (await res.json()) as BeatAnswer;
    Object.assign(this.view, { runner: a.runner, heldElsewhere: a.heldElsewhere, waiting: a.waiting });
    this.emit();
    this.deps.onBeat?.(a);
    if (!this.o.access) for (const s of a.stops) void this.takeOff(s);
    return a;
  }

  /** Take a job's prompt (and a meta-batch's later passes) off ComfyUI here, then tell the server. */
  private async takeOff(s: BeatAnswer["stops"][number]) {
    if (this.stopping.has(s.task)) return;
    this.stopping.add(s.task);
    try {
      const own = { promptIds: [s.promptId] };
      if (this.jobsApi !== false) {
        const res = await this.send(`/api/jobs/${s.promptId}/cancel`, {}, own, {}).catch(() => null);
        if (res?.status === 404) this.jobsApi = false;
      }
      if (this.jobsApi === false) {
        await this.send("/queue", { delete: [s.promptId] }, own, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [s.promptId] }) }).catch(() => null);
        const q = await this.read<{ queue_running?: unknown[][] }>("/queue").catch(() => null);
        if (q?.queue_running?.some((r) => r[1] === s.promptId)) {
          await this.send("/interrupt", { prompt_id: s.promptId }, own, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: s.promptId }) }).catch(() => null);
        }
      }
      // A meta-batch queues its next pass under a new id: sweep its prefix a few times.
      if (s.prefix) {
        for (let i = 0; i < 5; i++) {
          const q = await this.read<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue").catch(() => null);
          const ids = [...(q?.queue_running ?? []), ...(q?.queue_pending ?? [])].filter((r) => hasPrefix(r[2], s.prefix!)).map((r) => String(r[1]));
          if (!ids.length) break;
          for (const id of ids) await this.send(`/api/jobs/${id}/cancel`, {}, { promptIds: ids }, {}).catch(() => null);
          await this.sleep(1000);
        }
      }
      // Said at the next beat (a stop can be for a job an earlier tab took: this one has no token for it).
      this.stoppedDone.add(s.task);
    } finally {
      this.stopping.delete(s.task);
      const j = this.view.jobs.find((x) => x.taskId === s.task);
      if (j && j.phase !== "done") this.job({ id: j.taskId, generationId: j.generationId }, { phase: "failed" });
    }
  }

  private leases = new Map<string, string>();
  private promptOf = new Map<string, string>();
  private stoppedDone = new Set<string>();

  /**
   * Ask for a job and run it (one at a time). True when there was one. Only while ComfyUI here answers to this site: a
   * computer whose ComfyUI is closed, or runs without Fuobe's setting, keeps its place but takes nothing.
   */
  async claimAndRun(): Promise<boolean> {
    if (!this.alive || this.busy || this.o.access) return false;
    this.busy = true;
    try {
      if ((await this.look()).comfy !== "ok") return false;
      const running = this.view.jobs.filter((j) => j.phase !== "done" && j.phase !== "failed").map((j) => j.taskId);
      const res = await this.deps.api("/api/gpu/computer/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: this.o.device, running }) });
      if (res.status !== 200) {
        if (res.status === 401) this.stop("signed-out");
        return false;
      }
      const { task } = (await res.json()) as { task: ClaimedTask };
      this.leases.set(task.id, task.lease);
      try {
        await this.run(task);
      } catch (e) {
        // Something broke mid-job (the studio or the connection): forget it here, so the next claim picks it up again
        // from where it got to (the job stays this computer's on the server).
        this.view.jobs = this.view.jobs.filter((j) => j.taskId !== task.id);
        this.emit();
        throw e;
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** A whole job, from wherever it was. */
  async run(t: ClaimedTask): Promise<void> {
    try {
      await this.runJob(t);
    } finally {
      const phase = this.view.jobs.find((j) => j.taskId === t.id)?.phase;
      if (this.deps.ended && (phase === "done" || phase === "failed")) await Promise.resolve(this.deps.ended(t, phase)).catch(() => {});
    }
  }

  private async runJob(t: ClaimedTask): Promise<void> {
    this.promptOf.set(t.id, t.promptId);
    this.job(t, { phase: t.resume === "collecting" ? "saving" : t.resume === "running" ? "running" : t.resume === "queued" ? "queued" : "sending" });
    try {
      const problem = graphProblem(t.graph, t.inputs.map((i) => i.name));
      if (problem) {
        await this.report(t, { event: "failed", reason: "unsafe-graph" });
        return this.job(t, { phase: "failed" });
      }
      const refused = this.deps.vet?.(t);
      if (refused) {
        await this.report(t, { event: "failed", reason: refused });
        return this.job(t, { phase: "failed" });
      }
      let entries: HistoryEntryLike[] | null = null;
      let wanted = t.wanted;
      let phase = t.resume ?? "sending";
      for (let attempt = 0; phase !== "collecting" && attempt < 3; attempt++) {
        if (phase === "sending") {
          const sent = await this.sendJob(t);
          if (!sent) return;
        }
        this.socket();
        const done = await this.follow(t);
        if (done === "gone") {
          const a = await this.report(t, { event: "gone" });
          if (a.state !== "sending") return this.job(t, { phase: "failed" });
          phase = "sending";
          continue;
        }
        entries = done.entries;
        if (!done.answer.wanted) return this.job(t, { phase: done.answer.state === "done" ? "done" : "failed" });
        wanted = done.answer.wanted;
        phase = "collecting";
      }
      if (phase !== "collecting" || !wanted) return;
      if (!entries) entries = await this.ownEntries(t);
      await this.collect(t, wanted, entries, t.received ?? []);
    } catch (e) {
      if (e instanceof Stopped) return this.job(t, { phase: "failed" });
      throw e;
    }
  }

  /** The job's own entries on ComfyUI here, to check a resumed upload against. */
  private async ownEntries(t: ClaimedTask): Promise<HistoryEntryLike[]> {
    const own = (await this.read<Record<string, HistoryEntryLike>>(`/history/${t.promptId}`).catch(() => ({}) as Record<string, HistoryEntryLike>))[t.promptId];
    const passes = t.prefix ? Object.values(await this.read<Record<string, HistoryEntryLike>>(`/history?max_items=${META_BATCH_HISTORY}`).catch(() => ({}))).filter((e) => hasPrefix(e.prompt?.[2], t.prefix!)) : [];
    return [...(own ? [own] : []), ...passes];
  }

  /** Send the inputs and the prompt, unless ComfyUI has it already (a resumed job). False when the job ended. */
  private async sendJob(t: ClaimedTask): Promise<boolean> {
    this.job(t, { phase: "sending" });
    const there = await this.where(t.promptId).catch(() => null);
    if (there && there.s !== "absent") {
      await this.report(t, { event: "sent", promptId: t.promptId });
      return true;
    }
    if (!there) await this.waitForComfy(t);
    const names = t.inputs.map((i) => i.name);
    for (const input of t.inputs) {
      const res = await this.deps.api(`/api/gpu/computer/tasks/${t.id}/inputs/${input.n}`, { headers: { "X-Fuobe-Lease": t.lease } });
      if (res.status === 404 || res.status === 409) throw new Stopped();
      if (!res.ok) throw new Error(`The studio answered HTTP ${res.status} for a file`);
      const data = await res.arrayBuffer();
      if ((await this.deps.sha256(data)) !== input.sha256) {
        await this.report(t, { event: "failed", reason: "input-changed" });
        this.job(t, { phase: "failed" });
        return false;
      }
      const form = new FormData();
      form.append("image", new Blob([data], { type: input.contentType }), input.name);
      form.append("type", "input");
      form.append("overwrite", "true");
      const up = await this.send("/upload/image", { name: input.name, type: "input", overwrite: "true" }, { promptIds: [], names }, { body: form }).catch(() => null);
      if (!up) {
        await this.waitForComfy(t);
        return this.sendJob(t);
      }
      if (!up.ok) {
        await this.report(t, { event: "failed", reason: up.status === 413 ? "input-too-big" : "comfy-error", status: up.status });
        this.job(t, { phase: "failed" });
        return false;
      }
    }
    const body = { prompt: t.graph, prompt_id: t.promptId, client_id: this.o.clientId, ...(t.preview && { extra_data: { preview_method: "auto" } }) };
    const res = await this.send("/prompt", body, { promptIds: [t.promptId] }, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) {
      await this.waitForComfy(t);
      return this.sendJob(t);
    }
    const answer = (await res.json().catch(() => ({}))) as { prompt_id?: string; number?: number };
    if (res.status === 400) {
      await this.report(t, { event: "refused", status: 400, body: answer });
      this.job(t, { phase: "failed" });
      return false;
    }
    if (!res.ok || typeof answer.prompt_id !== "string") {
      await this.report(t, { event: "failed", reason: "comfy-error", status: res.status });
      this.job(t, { phase: "failed" });
      return false;
    }
    // An older ComfyUI mints its own id: that is the one to follow.
    if (answer.prompt_id !== t.promptId) {
      t.promptId = answer.prompt_id;
      this.promptOf.set(t.id, t.promptId);
    }
    await this.report(t, { event: "sent", promptId: answer.prompt_id, number: answer.number });
    return true;
  }

  /**
   * ComfyUI here stopped answering, or answers without Fuobe's setting: say which (again when that changes), then wait
   * until it answers to this site again.
   */
  private async waitForComfy(t: ClaimedTask) {
    let told: string | undefined;
    for (;;) {
      if (!this.alive) throw new Stopped();
      const l = await this.look();
      if (l.comfy === "ok") return;
      if (told !== l.comfy) {
        const a = await this.report(t, { event: "comfy-down", ...(l.comfy === "no-setting" && { why: "setting" as const }) });
        if (a.stop) throw new Stopped();
        told = l.comfy;
      }
      await this.sleep(3000);
    }
  }

  /** Follow a sent prompt until it finishes (its entry reported, the server's answer back), or ComfyUI lost it. */
  private async follow(t: ClaimedTask): Promise<"gone" | { entries: HistoryEntryLike[]; answer: { wanted?: WantedFile[]; state?: RelayState } }> {
    let lastSent = 0;
    let lastKey = "";
    let following: string | undefined;
    for (;;) {
      if (!this.alive) throw new Stopped();
      if (following) {
        // A meta-batch: its passes run under new ids, all with its prefix.
        const q = await this.read<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue").catch(() => null);
        if (!q) {
          await this.waitForComfy(t);
          continue;
        }
        const running = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((r) => hasPrefix(r[2], following!));
        // Every pass once the last is done (an EXR export saves frames in each one).
        const passes = running ? [] : Object.values(await this.read<Record<string, HistoryEntryLike>>(`/history?max_items=${META_BATCH_HISTORY}`).catch(() => ({}))).filter((e) => hasPrefix(e.prompt?.[2], following!));
        const a = await this.report(t, { event: "passes", running, entries: running ? [] : passes.map(slim) });
        if (a.stop) throw new Stopped();
        if (!running) return { entries: passes, answer: a };
        this.job(t, { phase: "running" });
        await this.sleep(POLL_MS * 2);
        continue;
      }
      const w = await this.where(t.promptId).catch(() => null);
      if (!w) {
        await this.waitForComfy(t);
        continue;
      }
      if (w.s === "absent") return "gone";
      if (w.s === "done") {
        const a = await this.report(t, { event: "finished", entry: slim(w.entry) });
        if (a.stop) throw new Stopped();
        if (a.follow) {
          following = a.follow;
          continue;
        }
        return { entries: [w.entry], answer: a };
      }
      const ev = this.events.get(t.promptId);
      const report: ReportEvent = w.s === "pending" ? { event: "queued", position: w.ahead } : { event: "running", value: ev?.value, max: ev?.max, node: ev?.node, nodesDone: ev?.nodesDone };
      const key = JSON.stringify(report);
      if (key !== lastKey && this.now() - lastSent >= PROGRESS_EVERY_MS) {
        const a = await this.report(t, report);
        if (a.stop) throw new Stopped();
        lastKey = key;
        lastSent = this.now();
      }
      this.job(t, w.s === "pending" ? { phase: "queued", position: w.ahead } : { phase: "running", value: ev?.value, max: ev?.max });
      // The socket says when steps move; without it, a read a second.
      await this.sleep(this.wsOpen ? PROGRESS_EVERY_MS : POLL_MS);
    }
  }

  /** Upload the results the server asked for, each in parts, from where each got to. */
  private async collect(t: ClaimedTask, wanted: WantedFile[], entries: HistoryEntryLike[], received: { n: number; bytes: number; done: boolean }[]) {
    this.job(t, { phase: "saving", saved: 0 });
    for (const w of wanted) {
      const got = received.find((r) => r.n === w.n);
      if (got?.done) continue;
      // Only a file this job's own prompt saved (a wrong answer from the server can't reach any other).
      if (!mayDownload(w, entries)) {
        await this.report(t, { event: "failed", reason: "output-missing" });
        return this.job(t, { phase: "failed" });
      }
      const res = await this.deps.local(`${this.base}${readPath(viewPath(w))}`, { credentials: "omit", cache: "no-store" }).catch(() => null);
      if (!res?.ok) {
        await this.report(t, { event: "failed", reason: "output-missing" });
        return this.job(t, { phase: "failed" });
      }
      const blob = await res.blob();
      if (blob.size > w.maxBytes) {
        // The server says why (too big, or the account's files are full) when it refuses the size.
        await this.upload(t, w, blob, 0);
        return this.job(t, { phase: "failed" });
      }
      let offset = got?.bytes ?? 0;
      if (offset > 0) {
        const s = await this.deps.api(`/api/gpu/computer/tasks/${t.id}/outputs/${w.n}`, { headers: { "X-Fuobe-Lease": t.lease } });
        offset = s.ok ? ((await s.json()) as { received: number }).received : 0;
      }
      if (!(await this.upload(t, w, blob, offset))) return this.job(t, { phase: "failed" });
    }
    // Saved: the tile says so (over the last preview) until the run itself moves on.
    this.job(t, { phase: "done", saved: 1, waiting: false });
  }

  /**
   * One file in parts of 16 MB; a failed part is tried again (three times in a row at most). A busy studio (429) isn't a
   * failure: the part waits as long as it says, up to an hour in all.
   */
  private async upload(t: ClaimedTask, w: WantedFile, blob: Blob, from: number): Promise<boolean> {
    let offset = from;
    let fails = 0;
    const until = this.now() + SAVE_WAIT_MS;
    while (offset < blob.size || blob.size === 0) {
      if (!this.alive) throw new Stopped();
      const part = blob.slice(offset, Math.min(blob.size, offset + RELAY_LIMITS.partBytes));
      const res = await this.deps
        .api(`/api/gpu/computer/tasks/${t.id}/outputs/${w.n}?offset=${offset}&total=${blob.size}`, {
          method: "PUT",
          headers: { "X-Fuobe-Lease": t.lease, "Content-Type": "application/octet-stream" },
          body: part,
        })
        .catch(() => null);
      if (res?.ok) {
        const r = (await res.json()) as { received: number; done: boolean };
        offset = r.received;
        fails = 0;
        this.job(t, { saved: offset / Math.max(1, blob.size), waiting: false });
        if (r.done) return true;
        continue;
      }
      if (res?.status === 429 && this.now() < until) {
        this.job(t, { waiting: true });
        await this.sleep(retryAfter(res));
        continue;
      }
      if (res && (res.status === 404 || res.status === 413 || res.status === 415)) return false;
      if (res?.status === 409) {
        // Out of step (a part arrived twice): go on from what the server has.
        const s = await this.deps.api(`/api/gpu/computer/tasks/${t.id}/outputs/${w.n}`, { headers: { "X-Fuobe-Lease": t.lease } });
        if (!s.ok) return false;
        const r = (await s.json()) as { received: number; done: boolean };
        if (r.done) return true;
        offset = r.received;
      }
      if (++fails >= 3) {
        await this.report(t, { event: "failed", reason: "save-failed" }).catch(() => null);
        return false;
      }
      await this.sleep(1500 * fails);
    }
    return true;
  }

  /** Let go of the jobs not sent yet (the tab closes): another tab or computer can take them at once. */
  releaseAll(send: (path: string, body: string) => void) {
    for (const j of this.view.jobs) {
      const lease = this.leases.get(j.taskId);
      if (lease && j.phase === "sending") send(`/api/gpu/computer/tasks/${j.taskId}/release`, JSON.stringify({ lease }));
    }
  }
}

/**
 * The job a run's tile shows: the run's latest one. A saved one only for a short while (its tile says it is saving over
 * the last preview until the run itself moves on), so a run's next step, or a run sent again, never shows an old job.
 */
export function tileJob(jobs: readonly LocalJob[], generationId: string, now: number): LocalJob | undefined {
  const job = jobs.findLast((j) => j.generationId === generationId);
  if (!job || (job.phase === "done" && now - (job.endedAt ?? 0) > DONE_SHOWN_MS)) return undefined;
  return job;
}

/** How often the runner beats: faster while it has work. */
export const beatEvery = (busy: boolean) => (busy ? RELAY_TIMES.busyBeatMs : RELAY_TIMES.beatMs);
