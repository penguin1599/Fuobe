"use client";

import { LIVE_NODES_VERSION, liveNodesState } from "@/lib/comfy-live-nodes";
import { parseComfyBinary, parseComfyText } from "@/lib/comfy-ws";
import { loopbackFetch } from "@/lib/gpu/browser-check";
import { FrameReader, type LiveEvent } from "@/lib/live/frames";
import { buildLiveGraph, LIVE_FILES, LIVE_OUTPUT, liveGraphProblem, slotBindings, type LiveGraphParams } from "@/lib/live/graph";
import { inputName, pictureExt, PICTURE_TYPES, pngSize, sha256Hex } from "@/lib/live/names";
import { LiveScheduler, RENDER_DEADLINE_MS, type Slot } from "@/lib/live/scheduler";
import { editSize, type Aspect } from "@/lib/live/sizes";
import { normalize, renderKey } from "@/lib/live/text";
import { graphProblem, localBase, readPath, writePath } from "@/lib/local-comfy";
import { imageSize } from "@/lib/image-size";

/**
 * How the live editor reaches ComfyUI. Two ways, one interface:
 *
 * - ServerTransport: through Fuobe's server (a local install, or an account's linked GPU): one streamed POST per
 *   render (POST /api/live/render), status over server-sent events.
 * - ChannelTransport: from this tab straight to the ComfyUI on this computer ("Use the ComfyUI on this computer"): the
 *   graph is built here, checked by the relay's rules and the live graph check, and sent to 127.0.0.1 with this tab's own
 *   client id; only prompts and pictures this tab made are ever touched. No server hop per render.
 *
 * Every render ends: by its picture, an error, a stop, ComfyUI finishing without a picture, ComfyUI no longer having
 * the prompt, or a deadline.
 */
/** How often a render that hasn't finished checks that ComfyUI still has it. */
const GONE_CHECK_MS = 4000;
/** Staged pictures whose bytes this tab keeps in memory (older ones are read again from their file). */
const COPIES_KEPT = 6;

export interface RenderReq {
  seq: number;
  slot: Slot;
  urgent?: boolean;
  text: string;
  seed: number;
  size: number;
  keepRes: number;
  base?: string;
  refs?: string[];
  mask?: string;
  aspect: Aspect;
  method: string;
}

export interface RenderOut {
  data: Uint8Array;
  type: string;
  w: number;
  h: number;
  /** ComfyUI's render time. */
  ms: number;
  sha256: string;
  key: string;
  /** A kept master: where Fuobe keeps it, and its name in ComfyUI. */
  masterUrl?: string;
  masterName?: string;
  /** Reused the settled render on screen (no new render). */
  reused?: boolean;
}

export type RenderResult = { ok: true; out: RenderOut } | { ok: false; dropped: string } | { ok: false; error: string; code?: string };

export interface StagedPicture {
  name: string;
  w: number;
  h: number;
  sha256: string;
}

export interface LiveFacts {
  nodes: number;
  /** ComfyUI has another copy of the live nodes (an older or changed file): it needs this one. */
  outdated?: boolean;
  highvram: boolean | null;
  /** Model files ComfyUI doesn't list (folder/file). */
  missing: string[];
}

export type OpenResult = ({ ok: true; seed: number } & LiveFacts) | { ok: false; error: string; code?: string };

export interface TransportStatus {
  online: boolean;
  running: "ours" | "other" | null;
  queue: number;
  otherRan: boolean;
}

export interface LiveTransport {
  kind: "server" | "link" | "computer";
  open(): Promise<OpenResult>;
  /** Stage a Fuobe file (the picture being edited, a reference). */
  stageFile(url: string): Promise<StagedPicture>;
  /**
   * Stage bytes made here (a painted mask; on the computer path, a kept master). `reread` gets them back once this tab
   * has let its copy go (a master's file or this browser's copy).
   */
  stageBytes(bytes: Uint8Array, kind: "mask" | "master", reread?: () => Promise<Uint8Array | null>): Promise<StagedPicture>;
  render(req: RenderReq, onEvent: (e: LiveEvent) => void): Promise<RenderResult>;
  hurry(seq: number): void;
  /** Stop renders that no longer matter (the base changed, live was switched off). */
  cancel(match: (seq: number, slot: Slot) => boolean): void;
  onStatus(fn: (s: TransportStatus) => void): () => void;
  close(): void;
}

/** The key a render is cached by (the server computes the same). */
export function keyOf(r: Pick<RenderReq, "base" | "refs" | "mask" | "text" | "seed" | "size" | "keepRes" | "aspect" | "method" | "slot">): string {
  const keep = r.slot === "keep" || r.slot === "settle";
  const prompt = normalize(r.text);
  return renderKey({ base: r.base ?? "", refs: r.refs, mask: r.mask, text: prompt, seed: r.seed, size: keep ? r.keepRes : r.size, aspect: r.aspect, method: r.method, quality: keep ? "keep" : "live" });
}

// ---------------------------------------------------------------------------
// Through Fuobe's server

/** How many times a render asks again after "too many renders" (about half a minute at the server's pace). */
const RETRY_429 = 30;

/** Wait, unless the request is let go first (then it throws, like the aborted fetch would). */
function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export class ServerTransport implements LiveTransport {
  kind: "server" | "link" = "server";
  private sessionId = "";
  private inflight = new Map<number, { ctl: AbortController; slot: Slot }>();
  private es: EventSource | null = null;
  private listeners = new Set<(s: TransportStatus) => void>();
  private status: TransportStatus = { online: false, running: null, queue: 0, otherRan: false };

  /** Its own session, every time (never one another tab or editor might hold: their renders would knock out each other's). */
  async open(): Promise<OpenResult> {
    // Opening again after a close (React's dev double mount) starts afresh; an earlier open that lands late ends its
    // session instead of taking over.
    this.closed = false;
    const opening = ++this.opens;
    const res = await fetch("/api/live/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const j = (await res.json().catch(() => ({}))) as { sessionId?: string; mode?: "server" | "link"; seed?: number; nodes?: { version?: number; outdated?: boolean }; highvram?: boolean | null; missing?: string[]; error?: string; code?: string };
    if (!res.ok || !j.sessionId) return { ok: false, error: j.error ?? `Live edit didn't start (${res.status})`, code: j.code };
    if (this.closed || opening !== this.opens) {
      this.end(j.sessionId);
      return { ok: false, error: "Closed", code: "closed" };
    }
    this.sessionId = j.sessionId;
    this.kind = j.mode === "link" ? "link" : "server";
    this.listen();
    return { ok: true, seed: j.seed ?? 0, nodes: j.nodes?.version ?? 0, outdated: !!j.nodes?.outdated, highvram: j.highvram ?? null, missing: j.missing ?? [] };
  }

  private closed = false;
  private opens = 0;

  private end(id: string) {
    void fetch("/api/live/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id, end: true }), keepalive: true }).catch(() => {});
  }

  private listen() {
    this.es?.close();
    const es = new EventSource(`/api/live/events?session=${encodeURIComponent(this.sessionId)}`);
    this.es = es;
    es.addEventListener("status", (ev) => {
      try {
        this.status = JSON.parse((ev as MessageEvent).data) as TransportStatus;
        for (const l of this.listeners) l(this.status);
      } catch {}
    });
    es.onerror = () => {
      this.status = { ...this.status, online: false };
      for (const l of this.listeners) l(this.status);
    };
  }

  onStatus(fn: (s: TransportStatus) => void) {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  async stageFile(url: string): Promise<StagedPicture> {
    const res = await fetch("/api/live/inputs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, file: url }) });
    const j = (await res.json().catch(() => ({}))) as { name?: string; width?: number; height?: number; sha256?: string; error?: string };
    if (!res.ok || !j.name) throw new Error(j.error ?? `Couldn't add the picture (${res.status})`);
    return { name: j.name, w: j.width ?? 0, h: j.height ?? 0, sha256: j.sha256 ?? "" };
  }

  async stageBytes(bytes: Uint8Array): Promise<StagedPicture> {
    const res = await fetch("/api/live/inputs", { method: "POST", headers: { "content-type": "image/png", "x-live-session": this.sessionId }, body: bytes as BodyInit });
    const j = (await res.json().catch(() => ({}))) as { name?: string; width?: number; height?: number; sha256?: string; error?: string };
    if (!res.ok || !j.name) throw new Error(j.error ?? `Couldn't add the picture (${res.status})`);
    return { name: j.name, w: j.width ?? 0, h: j.height ?? 0, sha256: j.sha256 ?? "" };
  }

  async render(req: RenderReq, onEvent: (e: LiveEvent) => void): Promise<RenderResult> {
    const ctl = new AbortController();
    this.inflight.set(req.seq, { ctl, slot: req.slot });
    const key = keyOf(req);
    try {
      const body = JSON.stringify({ sessionId: this.sessionId, ...req });
      let res = await fetch("/api/live/render", { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctl.signal });
      // Too many at once (a cold GPU's first frames are slow and the next ones queue up): ask again when the server
      // says, until the render is answered or no longer wanted.
      for (let tries = 0; res.status === 429 && tries < RETRY_429; tries++) {
        await abortableWait(Math.min(5, Number(res.headers.get("Retry-After")) || 1) * 1000, ctl.signal);
        res = await fetch("/api/live/render", { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctl.signal });
      }
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        return { ok: false, error: j.error ?? `The render failed (${res.status})`, code: j.code ?? (res.status === 410 ? "session" : undefined) };
      }
      const reader = res.body.getReader();
      const fr = new FrameReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of fr.push(value)) {
          if (f.kind === "event") {
            if (f.event.type === "dropped") return { ok: false, dropped: f.event.why };
            if (f.event.type === "error") return { ok: false, error: f.event.message, code: f.event.code };
            onEvent(f.event);
          } else {
            const h = f.header;
            return { ok: true, out: { data: f.data, type: h.type, w: h.w, h: h.h, ms: h.ms, sha256: h.sha256 ?? (await sha256Hex(f.data)), key, ...(h.url && { masterUrl: h.url }), ...(h.name && { masterName: h.name }) } };
          }
        }
      }
      return { ok: false, dropped: "closed" };
    } catch {
      if (ctl.signal.aborted) return { ok: false, dropped: "cancelled" };
      return { ok: false, error: "Lost the connection to Fuobe", code: "offline" };
    } finally {
      this.inflight.delete(req.seq);
    }
  }

  hurry(): void {
    // The server's scheduler hurries an urgent request itself (it carries `urgent`).
  }

  cancel(match: (seq: number, slot: Slot) => boolean): void {
    const seqs: number[] = [];
    for (const [seq, f] of this.inflight)
      if (match(seq, f.slot) && f.slot !== "keep") {
        f.ctl.abort();
        seqs.push(seq);
      }
    // A backup for a browser whose aborted request doesn't reach the server.
    if (seqs.length) void fetch("/api/live/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, seqs }), keepalive: true }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.cancel(() => true);
    this.es?.close();
    this.es = null;
    if (this.sessionId) this.end(this.sessionId);
  }
}

// ---------------------------------------------------------------------------
// From this tab to the ComfyUI on this computer

interface ChannelJob {
  req: RenderReq;
  params: LiveGraphParams;
  key: string;
  onEvent: (e: LiveEvent) => void;
}

interface Waiter {
  started: boolean;
  startedAt: number;
  onEvent: (e: LiveEvent) => void;
  resolve: (p: { data: Uint8Array; type: string; w: number; h: number; ms: number }) => void;
  reject: (e: Error & { code?: string }) => void;
}

const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

export class ChannelTransport implements LiveTransport {
  kind = "computer" as const;
  private base: string;
  private clientId = `fuobe-live-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  private ws: WebSocket | null = null;
  private online = false;
  private backoff = 250;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Prompt ids this tab minted: the only ones it may stop or take out of the history. */
  private ownIds: string[] = [];
  /**
   * Names this tab staged, with its own copy of the newest ones' bytes and a way to read the others again (to stage
   * them again after ComfyUI restarts). Old copies are let go, so a long session doesn't fill the tab's memory.
   */
  private names = new Map<string, { bytes?: Uint8Array; reread?: () => Promise<Uint8Array | null>; type: string; w: number; h: number; sha256: string }>();
  private waiters = new Map<string, Waiter>();
  private listeners = new Set<(s: TransportStatus) => void>();
  private status: TransportStatus = { online: false, running: null, queue: 0, otherRan: false };
  private waiting = 0;
  private scheduler: LiveScheduler<ChannelJob, RenderOut>;

  constructor(port: number, host = "127.0.0.1") {
    this.base = localBase(port, host);
    this.scheduler = new LiveScheduler<ChannelJob, RenderOut>({ run: (job, signal) => this.run(job.payload, signal) });
  }

  private set(patch: Partial<TransportStatus>) {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    for (const l of this.listeners) l(next);
  }

  onStatus(fn: (s: TransportStatus) => void) {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private get(path: string) {
    return loopbackFetch(`${this.base}${readPath(path)}`);
  }

  private post(path: string, body: unknown) {
    const p = writePath(path, body, { promptIds: this.ownIds, names: [...this.names.keys()] });
    return loopbackFetch(`${this.base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async open(): Promise<OpenResult> {
    this.closed = false;
    try {
      const stats = await this.get("/system_stats");
      if (!stats.ok) return { ok: false, error: "ComfyUI on this computer didn't answer", code: "offline" };
      const argv = ((await stats.json()) as { system?: { argv?: string[] } }).system?.argv;
      const answer = await this.get("/fuobe/live").then(async (r) => (r.ok ? ((await r.json()) as unknown) : null)).catch(() => null);
      const state = liveNodesState(answer);
      const nodes = state === "ok" ? LIVE_NODES_VERSION : 0;
      const missing: string[] = [];
      for (const [folder, file] of [["diffusion_models", LIVE_FILES.unet], ["text_encoders", LIVE_FILES.clip], ["vae", LIVE_FILES.vae], ["loras", LIVE_FILES.lora]] as const) {
        const list = await this.get(`/models/${folder}`).then((r) => (r.ok ? (r.json() as Promise<string[]>) : null)).catch(() => null);
        if (Array.isArray(list) && !list.includes(file)) missing.push(`${folder}/${file}`);
      }
      this.connect();
      return { ok: true, seed: Math.floor(Math.random() * 2 ** 31), nodes, outdated: state === "outdated", highvram: Array.isArray(argv) ? argv.includes("--highvram") || argv.includes("--gpu-only") : null, missing };
    } catch {
      return { ok: false, error: "Can't reach the ComfyUI on this computer", code: "offline" };
    }
  }

  private connect() {
    if (this.closed) return;
    this.timer = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.base.replace(/^http/, "ws")}${readPath(`/ws?clientId=${this.clientId}`)}`);
    } catch {
      return this.retry();
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.online = true;
      this.backoff = 250;
      this.set({ online: true });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.online = false;
      for (const w of this.waiters.values()) w.reject(fail("ComfyUI went away. Reconnecting…", "offline"));
      this.waiters.clear();
      this.waiting = 0;
      this.set({ online: false, running: null });
      this.retry();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        const p = parseComfyBinary(new Uint8Array(ev.data as ArrayBuffer));
        const w = p?.promptId ? this.waiters.get(p.promptId) : undefined;
        if (p && w && (p.live || p.node === LIVE_OUTPUT)) w.resolve({ data: p.data.slice(), type: p.type, w: p.width ?? 0, h: p.height ?? 0, ms: performance.now() - (w.startedAt || performance.now()) });
        return;
      }
      const e = parseComfyText(ev.data);
      if (!e) return;
      if (e.type === "status") {
        const queue = e.queueRemaining ?? 0;
        const runningOurs = [...this.waiters.values()].some((w) => w.started);
        const other = queue > this.waiting + (runningOurs ? 1 : 0);
        this.set({ queue, running: runningOurs ? "ours" : other ? "other" : null, ...(other && { otherRan: true }) });
        return;
      }
      const w = "promptId" in e && e.promptId ? this.waiters.get(e.promptId) : undefined;
      if (!w) {
        // One of this tab's, stopped, that started anyway: interrupt it now that it is ours running.
        if (e.type === "execution_start" && this.stopped.delete(e.promptId)) void this.post("/interrupt", { prompt_id: e.promptId }).catch(() => {});
        return;
      }
      if (e.type === "execution_start") {
        w.started = true;
        w.startedAt = performance.now();
        this.waiting = Math.max(0, this.waiting - 1);
        this.set({ running: "ours" });
        w.onEvent({ type: "started" });
      } else if (e.type === "progress" && e.max <= 8) w.onEvent({ type: "progress", value: e.value, max: e.max });
      else if (e.type === "error") w.reject(fail(e.message ?? "The render failed", e.nodeType === "LoadImageFuobeLive" ? "missing-input" : "failed"));
      else if (e.type === "interrupted") w.reject(fail("Stopped", "stopped"));
      // Finished and no picture came (it is always sent first): an old copy of the nodes served from ComfyUI's cache.
      else if (e.type === "success" || (e.type === "executing" && e.node === null)) w.reject(fail("ComfyUI finished without sending the picture. Update Fuobe's live nodes.", "failed"));
    };
  }

  private retry() {
    if (this.closed || this.timer) return;
    const wait = Math.min(3000, this.backoff) * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(3000, this.backoff * 2);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  private async upload(name: string, bytes: Uint8Array, type: string) {
    const body = { name, type: "input", overwrite: "true" };
    writePath("/upload/image", body, { promptIds: this.ownIds, names: [...this.names.keys()] });
    const form = new FormData();
    form.append("image", new Blob([bytes as BlobPart], { type }), name);
    form.append("type", "input");
    form.append("overwrite", "true");
    const res = await loopbackFetch(`${this.base}/upload/image`, { method: "POST", body: form });
    if (!res.ok) throw fail(`ComfyUI refused the picture (${res.status})`, "failed");
  }

  private async stage(bytes: Uint8Array, reread?: () => Promise<Uint8Array | null>): Promise<StagedPicture> {
    const ext = pictureExt(bytes);
    if (!ext) throw new Error("Only PNG, JPEG or WebP pictures");
    const { name, sha256 } = await inputName(bytes, ext);
    const had = this.names.get(name);
    if (had) {
      // Newest again: it moves to the end, and keeps its bytes for now.
      this.names.delete(name);
      this.names.set(name, { ...had, bytes, reread: reread ?? had.reread });
      this.trim();
      return { name, w: had.w, h: had.h, sha256 };
    }
    const size = (ext === "png" ? pngSize(bytes) : null) ?? (() => {
      const s = imageSize(bytes);
      return s ? { w: s.width, h: s.height } : { w: 0, h: 0 };
    })();
    this.names.set(name, { bytes, reread, type: PICTURE_TYPES[ext], w: size.w, h: size.h, sha256 });
    await this.upload(name, bytes, PICTURE_TYPES[ext]);
    this.trim();
    return { name, w: size.w, h: size.h, sha256 };
  }

  /** Let go of all but the newest copies that can be read again. */
  private trim() {
    const held = [...this.names.values()].filter((x) => x.bytes && x.reread);
    for (const x of held.slice(0, Math.max(0, held.length - COPIES_KEPT))) x.bytes = undefined;
  }

  /** A staged picture's bytes: this tab's copy, or read again. */
  private async bytesOf(name: string): Promise<Uint8Array | null> {
    const c = this.names.get(name);
    if (!c) return null;
    return c.bytes ?? (c.reread ? await c.reread().catch(() => null) : null);
  }

  async stageFile(url: string): Promise<StagedPicture> {
    // Fuobe's own file (same site), then into ComfyUI under its content name.
    if (!url.startsWith("/api/files/") && !url.startsWith("blob:")) throw new Error("Only your own files");
    const read = async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Couldn't read the picture");
      return new Uint8Array(await res.arrayBuffer());
    };
    return this.stage(await read(), url.startsWith("/api/files/") ? read : undefined);
  }

  stageBytes(bytes: Uint8Array, _kind: "mask" | "master", reread?: () => Promise<Uint8Array | null>): Promise<StagedPicture> {
    return this.stage(bytes, reread);
  }

  render(req: RenderReq, onEvent: (e: LiveEvent) => void): Promise<RenderResult> {
    const base = req.base ? this.names.get(req.base) : undefined;
    const liveLong = base?.w ? Math.max(...editSize(req.size, base.w, base.h)) : req.size;
    const bind = slotBindings(req.slot, { liveSize: req.size, keepRes: req.keepRes, hasMask: !!req.mask, to: "socket", liveLongSide: liveLong });
    const prompt = normalize(req.text);
    const params: LiveGraphParams = {
      prompt: req.slot === "warm" ? "warm-up" : prompt,
      seed: req.slot === "warm" ? 0 : req.seed,
      ...bind,
      ...(req.base && { base: req.base }),
      ...(req.refs?.length && { refs: req.refs }),
      ...(req.mask && { mask: req.mask }),
      ...(!req.base && { aspect: req.aspect }),
    };
    const key = keyOf(req);
    return this.scheduler.submit({ seq: req.seq, slot: req.slot, key, urgent: req.urgent, payload: { req, params, key, onEvent } }).then((o) => (o.ok ? { ok: true, out: o.result } : "dropped" in o ? { ok: false, dropped: o.dropped } : { ok: false, error: o.error }));
  }

  hurry(seq: number): void {
    this.scheduler.hurry(seq);
  }

  cancel(match: (seq: number, slot: Slot) => boolean): void {
    this.scheduler.cancel((j) => j.slot !== "keep" && match(j.seq, j.slot));
  }

  private async online_(ms: number) {
    const end = performance.now() + ms;
    while (!this.online && performance.now() < end && !this.closed) await new Promise((r) => setTimeout(r, 30));
    return this.online;
  }

  private async run(job: ChannelJob, signal: AbortSignal): Promise<RenderOut> {
    for (let tries = 0; ; tries++) {
      try {
        return await this.once(job, signal);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (signal.aborted || tries >= 2) throw e;
        if (code === "offline") {
          job.onEvent({ type: "reconnecting" });
          if (!(await this.online_(8000))) throw e;
        } else if (code === "missing-input") {
          // ComfyUI lost its input folder (a restart): send this tab's pictures again.
          const { staged } = buildLiveGraph(job.params);
          for (const n of staged) {
            const c = this.names.get(n);
            const bytes = await this.bytesOf(n);
            if (!c || !bytes) throw fail("A picture of this session is gone. Add it again.", "missing-input");
            await this.upload(n, bytes, c.type);
          }
        } else throw e;
      }
    }
  }

  /** Whether ComfyUI still has a prompt, waiting or running (null: it couldn't be asked). */
  private async inQueue(id: string): Promise<boolean | null> {
    try {
      const r = await this.get("/queue");
      if (!r.ok) return null;
      const q = (await r.json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
      return [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((row) => Array.isArray(row) && row[1] === id);
    } catch {
      return null;
    }
  }

  /** Ours, stopped before they were seen to start: interrupted if they start after all. */
  private stopped = new Set<string>();

  /**
   * Take a prompt of this tab's off ComfyUI: deleted if it waits, interrupted if it runs. An interrupt goes only to a
   * prompt seen running (an older ComfyUI stops whatever runs); one not seen to start is interrupted if it starts.
   */
  private takeOff(id: string, started: boolean) {
    void this.post("/queue", { delete: [id] }).catch(() => {});
    if (started) void this.post("/interrupt", { prompt_id: id }).catch(() => {});
    else {
      this.stopped.add(id);
      if (this.stopped.size > 200) this.stopped.delete(this.stopped.values().next().value!);
    }
  }

  /** End a render of ours that is still waited on. */
  private end(id: string, e: Error) {
    const w = this.waiters.get(id);
    if (!w) return;
    const started = w.started;
    w.reject(e);
    this.takeOff(id, started);
  }

  private async once(job: ChannelJob, signal: AbortSignal): Promise<RenderOut> {
    if (signal.aborted) throw fail("Stopped", "stopped");
    if (!(await this.online_(3000))) throw fail("Can't reach ComfyUI. Reconnecting…", "offline");
    // Stopped while waiting for the socket: nothing was sent.
    if (signal.aborted) throw fail("Stopped", "stopped");
    const { graph, staged } = buildLiveGraph(job.params);
    // The tab's own checks, before anything reaches ComfyUI: the relay's loader rule and the live graph's shape.
    const names = [...this.names.keys()];
    const problem = graphProblem(graph, staged.filter((n) => names.includes(n))) ?? liveGraphProblem(graph, names);
    if (problem) throw fail(problem, "failed");
    const id = crypto.randomUUID();
    this.ownIds.push(id);
    if (this.ownIds.length > 200) this.ownIds.splice(0, this.ownIds.length - 200);
    const t0 = performance.now();
    const done = new Promise<{ data: Uint8Array; type: string; w: number; h: number; ms: number }>((resolve, reject) => {
      const w: Waiter = {
        started: false,
        startedAt: 0,
        onEvent: job.onEvent,
        resolve: (p) => {
          this.waiters.delete(id);
          resolve(p);
        },
        reject: (e) => {
          if (this.waiters.get(id) === w && !w.started) this.waiting = Math.max(0, this.waiting - 1);
          this.waiters.delete(id);
          reject(e);
        },
      };
      this.waiters.set(id, w);
    });
    done.catch(() => {});
    this.waiting++;
    const stop = () => this.end(id, fail("Stopped", "stopped"));
    signal.addEventListener("abort", stop, { once: true });
    const deadline = setTimeout(() => this.end(id, fail("ComfyUI took too long with this render", "failed")), RENDER_DEADLINE_MS[job.req.slot]);
    // A prompt ComfyUI dropped without a word (a cleared queue, a restart): gone twice in a row.
    let gone = 0;
    const watch = setInterval(() => {
      if (!this.waiters.has(id)) return;
      void this.inQueue(id).then((has) => {
        gone = has === false ? gone + 1 : 0;
        if (gone >= 2) this.waiters.get(id)?.reject(fail("ComfyUI dropped the render", "failed"));
      });
    }, GONE_CHECK_MS);
    try {
      try {
        const res = await this.post("/prompt", { prompt: graph, prompt_id: id, client_id: this.clientId, front: true });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
          this.waiters.get(id)?.reject(body.error?.type === "missing_node_type" ? fail("Fuobe's live nodes aren't installed in ComfyUI", "missing-nodes") : fail(body.error?.message ?? `ComfyUI answered ${res.status}`, "failed"));
        } else job.onEvent({ type: "queued", pos: this.status.queue });
      } catch {
        this.waiters.get(id)?.reject(fail("Can't reach ComfyUI", "offline"));
      }
      // Stopped while the prompt was on its way: the first delete may have arrived before it.
      if (signal.aborted) this.takeOff(id, false);
      const p = await done;
      this.set({ otherRan: false });
      const sha256 = await sha256Hex(p.data);
      const size = p.type === "image/png" ? pngSize(p.data) : null;
      return { data: p.data, type: p.type, w: p.w || size?.w || 0, h: p.h || size?.h || 0, ms: p.ms || performance.now() - t0, sha256, key: job.key };
    } finally {
      clearTimeout(deadline);
      clearInterval(watch);
      signal.removeEventListener("abort", stop);
      void this.post("/history", { delete: [id] }).catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
    this.scheduler.cancelAll("closed");
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}
