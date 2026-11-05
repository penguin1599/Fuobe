"use client";

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { AssistThread, AssistThreadSummary, AssistThreadView } from "./assist";
import { make3dOffered, type OwnerGpuView, type TestProvider } from "./connections";
import type { ElementKind, StudioElement } from "./catalog/elements";
import type { Engine, Generation, GenerationRequest, MediaKind, ReviewStatus } from "./catalog/types";
import {
  applyToCanvasView,
  applyToList,
  applyToPages,
  applyToThread,
  backoff,
  needsCatchUp,
  parseSse,
  shareById,
  sharePagesById,
  streamResponse,
  toChannelMessage,
  toStreamEvent,
  type CanvasViewLike,
  type ChannelMessage,
  type Pages,
  type StreamEvent,
} from "./generation-stream";
import { fetchWithin, READ_LIMIT_MS } from "./fetch-within";
import { cursorAfter, filterToSearch, type AssetUse, type FeedFilter, type Folder } from "./library";
import { markRefusalShown, responseError } from "./refusals";
import { postFile } from "./upload";
import type { ShareCreated, ShareInfo, ShareListItem, SharePatch, ShareRequest } from "./share";
import type { AccessSummary } from "./model-access";
import { ADD_KEY_HEADER, isCloudProvider, type CloudProvider } from "./your-keys";
import type { Diagnosis } from "./diagnose";
import { BILLING_EVENT, BILLING_HEADER, type BillingAction, type BillingRefusalDetail, type HostedBalance } from "./hosted";

/** What the status strip says of a GPU that didn't answer (src/server/account-gpu.ts VisitorTrouble). */
export type GpuTroubleView = Pick<Diagnosis, "cause" | "words" | "actions" | "retryable" | "details">;

export interface Asset {
  id: string;
  kind: MediaKind;
  name: string | null;
  url: string;
  contentType: string;
  size: number;
  source: "upload" | "generation";
  createdAt: number;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  // With its status, so a refusal or a missing thing isn't retried (src/app/providers.tsx).
  // Its code too, when the refusal has one (a run that waits for a place: ACTIVE_RUNS_CODE).
  const given = (body as { code?: unknown }).code;
  const code = typeof given === "string" ? given : undefined;
  if (!res.ok) throw responseError(res, Object.assign(new Error(body.error ?? "Something went wrong. Please try again."), { status: res.status }, code && { code }));
  return body;
}

// ---------------------------------------------------------------------------
// Generations
//
// Lists live under ["generations", filter] (studio feeds, home) and ["library", filter] (the
// Library's paged lists); Assist threads hold theirs in ["assist", id]. Every change (the live
// stream, the user's own actions) goes through applyEvent(), which patches all of them by id.

export type { FeedFilter } from "./library";

const isActive = (g: Generation) => g.status === "queued" || g.status === "running";
/** Poll while something renders: fast without the live stream, a slow safety net with it. */
const pollEvery = (items: Generation[] | undefined, live: boolean) => (items?.some(isActive) ? (live ? 10_000 : 1500) : false);

/** Apply one change to every cached list and thread, skipping caches it doesn't change. */
function applyEvent(qc: QueryClient, ev: StreamEvent): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: ["generations"] })) {
    const data = q.state.data as Generation[] | undefined;
    const next = applyToList(data, (q.queryKey[1] ?? {}) as FeedFilter, ev);
    if (next !== data) qc.setQueryData(q.queryKey, next);
  }
  for (const q of qc.getQueryCache().findAll({ queryKey: ["library"] })) {
    if (q.queryKey.length !== 2 || typeof q.queryKey[1] !== "object") continue;
    const data = q.state.data as Pages | undefined;
    const next = applyToPages(data, q.queryKey[1] as FeedFilter, ev);
    if (next !== data) qc.setQueryData(q.queryKey, next);
  }
  for (const q of qc.getQueryCache().findAll({ queryKey: ["assist"] })) {
    if (typeof q.queryKey[1] !== "string") continue;
    const data = q.state.data as AssistThreadView | undefined;
    const next = applyToThread(data, ev);
    if (next !== data) qc.setQueryData(q.queryKey, next);
  }
  // Canvas boards (["canvases", id]): a result trashed in the Viewer or the Library leaves its node.
  for (const q of qc.getQueryCache().findAll({ queryKey: ["canvases"] })) {
    if (q.queryKey.length !== 2 || typeof q.queryKey[1] !== "string") continue;
    const data = q.state.data as CanvasViewLike | undefined;
    const next = applyToCanvasView(data, ev);
    if (next !== data) qc.setQueryData(q.queryKey, next);
  }
}

/** The freshest copy of a generation in any cache (a viewer may hold an older object). */
function cached(qc: QueryClient, id: string): Generation | undefined {
  let best: Generation | undefined;
  const consider = (g: Generation | undefined) => {
    if (g?.id === id && (!best || g.updatedAt >= best.updatedAt)) best = g;
  };
  for (const q of qc.getQueryCache().findAll({ queryKey: ["generations"] })) (q.state.data as Generation[] | undefined)?.forEach(consider);
  for (const q of qc.getQueryCache().findAll({ queryKey: ["library"] })) (q.state.data as Pages | undefined)?.pages?.forEach((p) => p.forEach(consider));
  for (const q of qc.getQueryCache().findAll({ queryKey: ["assist"] })) (q.state.data as AssistThreadView | undefined)?.generations?.forEach(consider);
  for (const q of qc.getQueryCache().findAll({ queryKey: ["canvases"] })) if (q.queryKey.length === 2) (q.state.data as CanvasViewLike | undefined)?.generations?.forEach(consider);
  return best;
}

/**
 * A local edit, applied before the server answers. It keeps the server's updatedAt (the browser's
 * clock may be ahead of the server's, and a copy stamped with it would make the reducers drop the
 * server's own events for that row as "late"); events at or after that time replace it.
 */
const patched = (g: Generation, patch: Partial<Generation>): Generation => ({ ...g, ...patch });

// --- Live updates (GET /api/generations/stream, built by the runtime) -------------------------
//
// One stream per browser, not one per tab: over HTTP/1.1 a browser opens at most ~6 connections
// to a host, so a stream held open in every tab would leave the 6th tab unable to load anything.
// The tabs elect a leader with the Web Locks API: the leader reads the stream and passes every
// event (and whether it's connected) to the other tabs on a BroadcastChannel. Without Web Locks
// (an http:// address other than localhost) each tab reads its own. Either way a tab that has been
// hidden for 30 s lets go (its stream, or its place in line to lead) and catches up when shown.

const LOCK = "fuobe-generation-stream";
const CHANNEL = "fuobe-generations";
const HIDDEN_GRACE_MS = 30_000;

interface ClientStreamState {
  connected: boolean;
  everConnected: boolean;
  /** Mounted views showing generations in this tab. */
  subscribers: number;
  listeners: Set<() => void>;
  /** Raw event listeners (views that keep their own caches: useGenerationEvents). */
  handlers: Set<(ev: StreamEvent) => void>;
  client: QueryClient | null;
  /** Taking part: leading, or listening to the leader and waiting in line. */
  running: boolean;
  leader: boolean;
  abort: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  /** Our place in line for the lock (aborted to withdraw). */
  ticket: AbortController | null;
  /** Gives the lock back. */
  release: (() => void) | null;
  channel: BroadcastChannel | null;
  hiddenTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  hooked: boolean;
  /** Keep the stream (or our place in line) while hidden: browser notifications are on and a job hasn't had its notification yet. */
  keepHidden: (() => boolean) | null;
  /** "Anyone on screen?" questions waiting for an answer, by id. */
  seen: Map<string, () => void>;
}

declare global {
  // On window, so a hot-reloaded module keeps the lock and stream it already holds.
  var __fuobeClientStream: ClientStreamState | undefined;
}

const live = (): ClientStreamState =>
  (globalThis.__fuobeClientStream ??= {
    connected: false,
    everConnected: false,
    subscribers: 0,
    listeners: new Set(),
    handlers: new Set(),
    client: null,
    running: false,
    leader: false,
    abort: null,
    timer: null,
    attempt: 0,
    ticket: null,
    release: null,
    channel: null,
    hiddenTimer: null,
    stopTimer: null,
    hooked: false,
    keepHidden: null,
    seen: new Map(),
  });

const shared = () => typeof navigator !== "undefined" && !!navigator.locks && typeof BroadcastChannel !== "undefined";

function post(m: ChannelMessage) {
  try {
    live().channel?.postMessage(m);
  } catch {}
}

function setLive(v: boolean) {
  const s = live();
  if (s.connected === v) return;
  const catchUp = needsCatchUp(s.connected, v, s.everConnected);
  s.connected = v;
  if (v) s.everConnected = true;
  if (s.leader) post({ type: "state", connected: v });
  // Back after a drop: whatever changed meanwhile.
  if (catchUp && s.client) {
    void s.client.invalidateQueries({ queryKey: ["generations"] });
    void s.client.invalidateQueries({ queryKey: ["library"] });
    void s.client.invalidateQueries({ queryKey: ["canvases"] });
  }
  s.listeners.forEach((l) => l());
}

function receive(ev: StreamEvent) {
  const s = live();
  if (s.client) applyEvent(s.client, ev);
  s.handlers.forEach((h) => h(ev));
}

/** Read the stream (this tab's own, or as the leader for every tab). */
async function connect() {
  const s = live();
  s.timer = null;
  if (s.abort || !s.running || !s.client || (shared() && !s.leader)) return;
  const ctrl = new AbortController();
  s.abort = ctrl;
  let retryIn = 0;
  try {
    const res = await fetch("/api/generations/stream", { headers: { Accept: "text/event-stream" }, signal: ctrl.signal, cache: "no-store" });
    const next = streamResponse({ ok: res.ok, status: res.status, contentType: res.headers.get("content-type"), hasBody: !!res.body }, s.attempt++);
    if (!next.open || !res.body) {
      void res.body?.cancel().catch(() => {});
      retryIn = next.open ? backoff(s.attempt) : next.retryIn;
    } else {
      s.attempt = 0;
      setLive(true);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseSse(buf + value);
        buf = parsed.rest;
        for (const m of parsed.events) {
          const ev = toStreamEvent(m);
          if (!ev) continue;
          receive(ev);
          if (s.leader) post({ type: "event", ev });
        }
      }
      retryIn = backoff(s.attempt++);
    }
  } catch {
    if (ctrl.signal.aborted) return;
    retryIn = backoff(s.attempt++);
  }
  if (s.abort !== ctrl) return;
  s.abort = null;
  setLive(false);
  if (s.running && (!shared() || s.leader)) s.timer = setTimeout(() => void connect(), retryIn);
}

/** Wait in line for the lock; holding it, read the stream for every tab until we let go. */
function lead() {
  const s = live();
  const ticket = new AbortController();
  s.ticket = ticket;
  navigator.locks
    .request(LOCK, { signal: ticket.signal }, () => {
      // Withdrawn meanwhile: give it straight back.
      if (s.ticket !== ticket || !s.running) return;
      s.ticket = null;
      return new Promise<void>((resolve) => {
        s.leader = true;
        s.release = resolve;
        // Whatever the last leader said: our own stream decides now (and catches up when it opens).
        setLive(false);
        void connect();
      });
    })
    .catch(() => {});
}

function openChannel() {
  const s = live();
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const m = toChannelMessage(e.data);
    if (!m) return;
    // Any tab: say so when asked whether Fuobe is on screen; the asker hears the first answer.
    if (m.type === "seen?") {
      if (document.visibilityState === "visible") post({ type: "seen", id: m.id });
      return;
    }
    if (m.type === "seen") {
      s.seen?.get(m.id)?.();
      return;
    }
    if (m.type === "hello") {
      if (s.leader) post({ type: "state", connected: s.connected });
      return;
    }
    if (s.leader) return;
    if (m.type === "state") setLive(m.connected);
    else receive(m.ev);
  };
  s.channel = ch;
  post({ type: "hello" });
}

function start() {
  const s = live();
  if (s.running || !s.client) return;
  s.running = true;
  if (shared()) {
    openChannel();
    lead();
  } else void connect();
}

function stop() {
  const s = live();
  if (!s.running) return;
  s.running = false;
  s.ticket?.abort();
  s.ticket = null;
  s.abort?.abort();
  s.abort = null;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  setLive(false);
  s.leader = false;
  const release = s.release;
  s.release = null;
  release?.();
  s.channel?.close();
  s.channel = null;
}

function onVisibility() {
  const s = live();
  if (document.visibilityState === "hidden") {
    const arm = () =>
      setTimeout(() => {
        // Notifications on and a job not yet notified (running, or finished and settling): the stream is how we hear it, so keep it.
        if (s.keepHidden?.()) return void (s.hiddenTimer = arm());
        s.hiddenTimer = null;
        stop();
      }, HIDDEN_GRACE_MS);
    s.hiddenTimer ??= arm();
    return;
  }
  if (s.hiddenTimer) clearTimeout(s.hiddenTimer);
  s.hiddenTimer = null;
  if (s.subscribers) start();
}

/** Share one stream between every list on the page (and every tab, and canvas boards); returns whether it's connected. */
export function useGenerationStream(): boolean {
  const qc = useQueryClient();
  useEffect(() => {
    const s = live();
    s.client = qc;
    s.subscribers++;
    if (s.stopTimer) clearTimeout(s.stopTimer);
    s.stopTimer = null;
    if (!s.hooked) {
      s.hooked = true;
      document.addEventListener("visibilitychange", onVisibility);
    }
    // A tab opened in the background waits until it's shown.
    if (document.visibilityState !== "hidden") start();
    return () => {
      s.subscribers--;
      if (s.subscribers) return;
      // Keep it through quick remounts (route changes); drop it when nothing shows generations.
      s.stopTimer = setTimeout(() => {
        s.stopTimer = null;
        if (!s.subscribers) stop();
      }, 5000);
    };
  }, [qc]);
  return useSyncExternalStore(
    (cb) => {
      const s = live();
      s.listeners.add(cb);
      return () => s.listeners.delete(cb);
    },
    () => live().connected,
    () => false,
  );
}

/** Whether this tab reads the live stream for the browser (its leader), or its own (no Web Locks). */
export function leadsStream(): boolean {
  const s = live();
  return s.running && (!shared() || s.leader);
}

/** Keep this tab's stream while it's hidden whenever `keep()` says so (null: the usual 30 s grace). */
export function keepStreamWhileHidden(keep: (() => boolean) | null): void {
  live().keepHidden = keep;
}

/** Whether another Fuobe tab is on screen: asked on the tabs' channel, answered within `ms` (false without one). */
export function anotherTabVisible(ms = 200): Promise<boolean> {
  const s = live();
  if (!s.channel) return Promise.resolve(false);
  const id = Math.random().toString(36).slice(2);
  // (A state kept across a hot reload may predate the map.)
  s.seen ??= new Map();
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      s.seen.delete(id);
      resolve(v);
    };
    const timer = setTimeout(() => done(false), ms);
    s.seen.set(id, () => done(true));
    post({ type: "seen?", id });
  });
}

/**
 * Listen to the shared live stream (one per browser) from a view with its own caches, instead of
 * opening another EventSource. Returns whether it's connected; poll when it isn't.
 */
export function useGenerationEvents(onEvent: (ev: StreamEvent) => void): boolean {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => {
    const h = (ev: StreamEvent) => ref.current(ev);
    const s = live();
    s.handlers.add(h);
    return () => void s.handlers.delete(h);
  }, []);
  return useGenerationStream();
}

// --- Lists ----------------------------------------------------------------------------------

function feedKey(f: FeedFilter) {
  return ["generations", f] as const;
}

export function useGenerations(filter: FeedFilter, opts: { keepPrevious?: boolean } = {}) {
  const connected = useGenerationStream();
  return useQuery({
    queryKey: feedKey(filter),
    queryFn: async () => (await json<{ items: Generation[] }>(await fetchWithin(`/api/generations?${filterToSearch(filter)}`, READ_LIMIT_MS.list))).items,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
    structuralSharing: shareById,
    refetchInterval: (q) => pollEvery(q.state.data, connected),
  });
}

const RUNNING: FeedFilter = { statuses: ["queued", "running"], steps: true, limit: 100 };

/**
 * Everything queued or running, anywhere (the tab title's job count). The live stream keeps it
 * current (a job that finishes leaves the list); polling is only a slow safety net.
 */
export function useRunningGenerations() {
  const connected = useGenerationStream();
  return useQuery({
    queryKey: feedKey(RUNNING),
    queryFn: async () => (await json<{ items: Generation[] }>(await fetchWithin(`/api/generations?${filterToSearch(RUNNING)}`, READ_LIMIT_MS.list))).items,
    structuralSharing: shareById,
    refetchInterval: (q) => (q.state.data?.length ? (connected ? 30_000 : 5000) : false),
  });
}

export const LIBRARY_PAGE = 60;

/** The Library's paged list ("Load more" pages back with the before cursor). */
export function useLibrary(filter: FeedFilter, opts: { enabled?: boolean } = {}) {
  const connected = useGenerationStream();
  const f = { ...filter, limit: filter.limit ?? LIBRARY_PAGE };
  return useInfiniteQuery({
    queryKey: ["library", f] as const,
    enabled: opts.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (await json<{ items: Generation[] }>(await fetch(`/api/generations${f.trashed ? "/trash" : ""}?${filterToSearch(f, pageParam)}`))).items,
    // The last row's timestamp and id: rows sharing a timestamp across the page boundary aren't skipped.
    getNextPageParam: (last) => (last.length < f.limit ? undefined : cursorAfter(last.at(-1)!, f)),
    placeholderData: keepPreviousData,
    structuralSharing: sharePagesById,
    refetchInterval: (q) => pollEvery(q.state.data?.pages.flat(), connected),
  });
}

export interface LibraryFacets {
  models: { id: string; name: string; count: number }[];
  kinds: Partial<Record<MediaKind, number>>;
  total: number;
  favorites: number;
  failed: number;
  trash: number;
  pinned: number;
  /** Helper steps, counted whether they're shown or not. */
  steps: number;
  reviews: Partial<Record<ReviewStatus, number>>;
}

/** Counts for the Library's tabs and filters (with the helper steps counted in when they're shown). */
export function useLibraryFacets(opts: { steps?: boolean } = {}) {
  return useQuery({
    queryKey: ["library-facets", { steps: !!opts.steps }],
    queryFn: async () => json<LibraryFacets>(await fetch(`/api/generations/facets${opts.steps ? "?steps=1" : ""}`)),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useCreateGeneration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: GenerationRequest) => {
      const res = await fetch("/api/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      // Stopped by the GPU pre-flight: the guided fix opens (watchGuestRefusals), so no error toast on top of it.
      if (res.status === 409 && res.headers.get("x-fuobe-gpu-setup") === "1") {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(b.error ?? "This tool needs setting up on your GPU"), { gpuSetup: true });
      }
      const { items, notes, gpuWarning } = await json<{ items: Generation[]; notes?: string[]; gpuWarning?: string }>(res);
      // What the run leaves out or changes (a LoRA that runs only on your GPU, a length the API rounds) is said, not dropped silently.
      if (notes?.length) toast.warning(notes.length > 1 ? "This run changes a few things" : "This run changes one thing", { description: notes.join(". ") });
      // The studio's own ComfyUI seems to miss something (the owner is warned, never stopped).
      if (gpuWarning) toast.warning(gpuWarning, { action: { label: "See what", onClick: () => window.location.assign(new URL("/connect", window.location.origin).toString()) } });
      return items;
    },
    onSuccess: (items) => {
      // Show new cards instantly in the feeds they belong to (newest first, like the server), then let polling take over.
      for (const g of items) applyEvent(qc, { type: "generation", generation: { ...g, deletedAt: null } });
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library-facets"] });
    },
  });
}

export type BulkAction = "trash" | "restore" | "delete" | "favorite" | "unfavorite" | "move" | "pin" | "unpin" | "review";

/** The bulk endpoint takes this many ids per request. */
export const BULK_MAX = 500;

/** One bulk action, sent in batches of BULK_MAX (a select-all after a few "Load more" can be bigger). */
async function bulkRequest(action: BulkAction, ids: string[], extra: { folderId?: string | null; review?: ReviewStatus | null } = {}): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    const body = JSON.stringify({ action, ids: ids.slice(i, i + BULK_MAX), ...extra });
    n += (await json<{ count: number }>(await fetch("/api/generations/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body }))).count;
  }
  return n;
}

/** Stable result actions (one object per QueryClient), so memoized tiles don't re-render. */
export function useGenerationActions() {
  const qc = useQueryClient();
  return useMemo(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["library-facets"] });
      void qc.invalidateQueries({ queryKey: ["folders"] });
    };
    /** A patch for every one (or per one, from its freshest copy); null removes them from the caches. */
    type Patch = Partial<Generation> | ((cur: Generation) => Partial<Generation>) | null;
    const local = (gs: Generation[], patch: Patch) => {
      for (const g of gs) {
        const cur = cached(qc, g.id) ?? g;
        const p = typeof patch === "function" ? patch(cur) : patch;
        applyEvent(qc, p ? { type: "generation", generation: patched(cur, p) } : { type: "deleted", id: g.id });
      }
    };
    /** Optimistic, then the server; on failure the caches are refetched and the error shown. */
    const run = async (gs: Generation[], patch: Patch, action: BulkAction, extra?: Parameters<typeof bulkRequest>[2]) => {
      if (!gs.length) return 0;
      local(gs, patch);
      try {
        return await bulkRequest(action, gs.map((g) => g.id), extra);
      } catch (e) {
        toast.error((e as Error).message);
        return 0;
      } finally {
        refresh();
      }
    };
    const restore = (gs: Generation[]) => run(gs, { deletedAt: null }, "restore");
    const trash = (gs: Generation[], what?: string) => {
      // The server cancels jobs still rendering: say so.
      const active = gs.filter((g) => isActive(cached(qc, g.id) ?? g)).length;
      const p = run(gs, { deletedAt: Date.now() }, "trash");
      const said =
        gs.length === 1 ? (active ? "Canceled and moved to Trash" : "Moved to Trash") : `${gs.length} moved to Trash${active ? ` · ${active} canceled` : ""}`;
      toast(what ?? said, {
        id: "trash-undo",
        duration: 6000,
        action: { label: "Undo", onClick: () => void p.then(() => restore(gs)) },
      });
      return p;
    };
    return {
      /** Toggle (or set) a favorite from the freshest cached copy, so a stale viewer object can't send the wrong value. */
      favorite: async (g: Generation, value?: boolean) => {
        const cur = cached(qc, g.id) ?? g;
        const next = value ?? !cur.favorite;
        local([cur], { favorite: next });
        const res = await fetch(`/api/generations/${g.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: next }) });
        if (!res.ok) refresh();
      },
      favoriteMany: (gs: Generation[], value: boolean) => run(gs, { favorite: value }, value ? "favorite" : "unfavorite"),
      /** Move to the Trash quietly (callers that announce it themselves). */
      remove: (g: Generation) => run([g], { deletedAt: Date.now() }, "trash"),
      /** Move to the Trash with an Undo toast. */
      trash,
      restore,
      deleteForever: (gs: Generation[]) => run(gs, null, "delete"),
      /**
       * An account's own runs, deleted for good (an account has no Trash): DELETE /api/generations/<id> one by one, which
       * the proxy lets through for the account's own runs only. Optimistic, then the server; on a refusal the caches are
       * refetched and its words shown. How many went.
       */
      deleteOwn: async (gs: Generation[]) => {
        if (!gs.length) return 0;
        local(gs, null);
        let n = 0;
        try {
          for (const g of gs) {
            const res = await fetch(`/api/generations/${encodeURIComponent(g.id)}?forever=1`, { method: "DELETE" });
            if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "It couldn't be deleted. Try again.");
            n++;
          }
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          refresh();
        }
        return n;
      },
      emptyTrash: async () => {
        await fetch("/api/generations/trash", { method: "DELETE" });
        refresh();
      },
      move: (gs: Generation[], folderId: string | null) => run(gs, { folderId }, "move", { folderId }),
      /** Pin to the top of the Library (ones already pinned keep their place), or unpin. */
      pin: (gs: Generation[], value: boolean) => {
        const now = Date.now();
        // One already pinned keeps its pin time (and its place), as on the server.
        return run(gs, (cur) => ({ pinnedAt: value ? (cur.pinnedAt ?? now) : null }), value ? "pin" : "unpin");
      },
      review: (gs: Generation[], review: ReviewStatus | null) => run(gs, { review }, "review", { review }),
      cancel: async (g: Generation) => {
        local([g], { status: "canceled" });
        await fetch(`/api/generations/${g.id}/cancel`, { method: "POST" });
        refresh();
      },
    };
  }, [qc]);
}

const UPLOADS_PAGE = 100;

/** Files you uploaded (the Library's Uploads tab), newest first, paged like the Library ("Load more"). */
export function useUploads(kind?: MediaKind) {
  return useInfiniteQuery({
    queryKey: ["assets", "upload", kind, "paged"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ source: "upload", limit: String(UPLOADS_PAGE) });
      if (kind) qs.set("kind", kind);
      if (pageParam) qs.set("before", pageParam);
      return (await json<{ items: Asset[] }>(await fetch(`/api/assets?${qs}`))).items;
    },
    getNextPageParam: (last) => (last.length < UPLOADS_PAGE ? undefined : `${last.at(-1)!.createdAt}:${last.at(-1)!.id}`),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Library folders

export function useFolders() {
  return useQuery({
    queryKey: ["folders"],
    queryFn: async () => (await json<{ items: Folder[] }>(await fetch("/api/folders"))).items,
    staleTime: 10_000,
  });
}

export function useFolderActions() {
  const qc = useQueryClient();
  return useMemo(() => {
    const send = async <T,>(url: string, method: string, body?: unknown) => {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const out = res.status === 204 ? (undefined as T) : await json<T>(res);
      void qc.invalidateQueries({ queryKey: ["folders"] });
      return out;
    };
    return {
      /** A new folder; with parentId, a subfolder. */
      create: (body: { name: string; color?: string; parentId?: string | null }) => send<Folder>("/api/folders", "POST", body),
      /** Rename, recolour, pin, or move (parentId; null: the library root). */
      update: (id: string, body: { name?: string; color?: string; parentId?: string | null; pinned?: boolean }) => send<Folder>(`/api/folders/${id}`, "PATCH", body),
      /** Delete; its results and subfolders move up to its parent. */
      remove: async (id: string) => {
        await send<void>(`/api/folders/${id}`, "DELETE");
        void qc.invalidateQueries({ queryKey: ["library"] });
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    };
  }, [qc]);
}

// ---------------------------------------------------------------------------
// Share links (Library → Shared, the Share dialog, the Publish wizard)

/** Every link, and whether sign-in is on (a link to a studio without a password opens more than the page). */
export function useShares(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["shares"],
    queryFn: async () => json<{ items: ShareListItem[]; signIn: boolean }>(await fetch("/api/shares")),
    staleTime: 10_000,
    enabled: opts.enabled ?? true,
  });
}

export function useShareActions() {
  const qc = useQueryClient();
  return useMemo(() => {
    const send = async <T,>(url: string, method: string, body?: unknown) => {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const out = res.status === 204 ? (undefined as T) : await json<T>(res);
      void qc.invalidateQueries({ queryKey: ["shares"] });
      return out;
    };
    return {
      /** A new link; the answer carries its token once. */
      create: (body: ShareRequest) => send<ShareCreated>("/api/shares", "POST", body),
      /** Change it; with newLink, a new token (in the answer) replaces the old one. */
      update: (id: string, patch: SharePatch) => send<{ share: ShareInfo; token?: string; path?: string }>(`/api/shares/${id}`, "PATCH", patch),
      /** Revoke: the link stops working at once. */
      revoke: (id: string) => send<void>(`/api/shares/${id}`, "DELETE"),
    };
  }, [qc]);
}

// ---------------------------------------------------------------------------
// Uploads & assets

/**
 * Upload a file as it is (streamed by the server: src/lib/upload.ts). `kinetic`: a result rendered in the page (a
 * Kinetic Motion clip or poster, a colour grade, a Relight blend), which any account may save (KINETIC_UPLOAD_HEADER).
 */
export async function uploadFile(file: File, opts: { kinetic?: boolean } = {}): Promise<Asset> {
  return postFile(file, undefined, opts);
}

/** A stored file's uses: where it's used, in one line ("2 results and the element “Maya”"), empty when nothing uses it. */
export async function assetUsage(id: string): Promise<{ uses: AssetUse[]; usedBy: string }> {
  return json<{ uses: AssetUse[]; usedBy: string }>(await fetch(`/api/assets/${encodeURIComponent(id)}`));
}

/** Delete an upload for good (refused, with where it's used, while anything still uses it). */
export function useDeleteUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status !== 204) await json(res);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["assets"] }),
  });
}

export function useAssets(source?: "upload" | "generation", kind?: MediaKind) {
  return useQuery({
    queryKey: ["assets", source, kind],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (source) qs.set("source", source);
      if (kind) qs.set("kind", kind);
      return (await json<{ items: Asset[] }>(await fetch(`/api/assets?${qs}`))).items;
    },
  });
}

// ---------------------------------------------------------------------------
// Elements (@characters, locations, props, styles)

export function useElements() {
  return useQuery({
    queryKey: ["elements"],
    queryFn: async () => (await json<{ items: StudioElement[] }>(await fetch("/api/elements"))).items,
    staleTime: 10_000,
  });
}

export function useElement(id: string) {
  return useQuery({
    queryKey: ["elements", id],
    queryFn: async () => json<StudioElement>(await fetch(`/api/elements/${id}`)),
    // An unknown element is a 404 page, not a network hiccup: don't retry it.
    retry: (n, e) => !/not found|\(404\)/i.test((e as Error).message) && n < 1,
    // Pick up the trained identity as soon as a training job finishes.
    refetchInterval: (q) => (q.state.data?.status === "training" ? 3000 : false),
  });
}

export function useSaveElement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      id?: string;
      name: string;
      kind?: ElementKind;
      description?: string | null;
      references: string[];
      /** Design a voice: the model that made the take, its words and its line (the server keeps the rest). */
      voice?: { modelId: string; description?: string; transcript?: string };
    }) => {
      const { id, ...rest } = body;
      return json<StudioElement>(
        await fetch(id ? `/api/elements/${id}` : "/api/elements", {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        }),
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["elements"] }),
  });
}

export function useDeleteElement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/elements/${id}`, { method: "DELETE" });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["elements"] }),
  });
}

// ---------------------------------------------------------------------------
// Provider status

export type EngineMode = "both" | "open" | "cloud";

export interface StatusInfo {
  /** `ramBytes`: the connected ComfyUI's RAM (comfyui only, when it says). */
  providers: Record<string, { label: string; configured: boolean; ramBytes?: number }>;
  demoMode: string;
  engineMode: EngineMode;
  cloudProvider: string;
  /** The text LLM: Settings → AI helper, whether Claude takes text steps, and the local model server in use. */
  llm?: {
    helper: "auto" | "anthropic" | "local" | "none";
    claude: boolean;
    /** Settings' local server: "auto" or the one pinned. */
    provider: string;
    context: number;
    local: { kind: string; label: string; url: string; model: string | null; loaded: boolean | null; context: number | null; warning: string | null } | null;
    /** Why no local server can run, when one says. */
    problem: string | null;
    detected: { kind: string; label: string; url: string; up: boolean; auth: string; models: number; model: string | null; problem: string | null }[];
  };
  /** The first-run guide was put away, or something the engine mode generates with was connected once. */
  onboarded?: boolean;
  /** Settings → Models & licences: what is switched off (absent while everything is on). */
  access?: AccessSummary;
  /**
   * Public sign-up: a guest or an account is looking. Then everything else here is its own view
   * (its own GPU as ComfyUI, its own fal.ai and Replicate keys, no Demo mode), never the install's
   * (src/server/account-gpu.ts). `keys`: the providers it has its own key for (src/lib/your-keys.ts).
   */
  viewer?: {
    kind: "guest" | "account";
    gpu: {
      connected: boolean;
      mode?: "computer" | "link";
      online?: boolean;
      comfy?: "down" | "no-setting";
      device?: string;
      vramBytes?: number;
      /** A link that didn't answer its last status check: why, in plain words, and what helps (src/lib/diagnose.ts). */
      trouble?: GpuTroubleView;
      /** A link's kind: a RunPod pod's port gets "Start your pod". */
      host?: "runpod" | "tunnel" | "web";
    };
    keys?: CloudProvider[];
    paidAllowed?: boolean;
    /** Hosted runs (FUOBE_HOSTED_RUNS=1): runs may go to this studio's GPUs, so a GPU of one's own is optional. */
    hosted?: boolean;
    /** The billing service's words for the account's balance (src/server/billing.ts). */
    balance?: HostedBalance;
    links?: BillingAction[];
    notice?: { id: string; text: string; url?: string };
  };
  /**
   * The owner's ComfyUI runs on the owner's computer (Settings): what the owner's Fuobe tab there last said. Never
   * `viewer` (that is a visitor's view of the studio).
   */
  ownerGpu?: OwnerGpuView;
}

/** The viewer's own GPU for the status strip and the header pill: an account's, or the owner's computer. */
export function ownGpuOf(s: StatusInfo | undefined): NonNullable<StatusInfo["viewer"]>["gpu"] | undefined {
  if (s?.viewer) return s.viewer.gpu;
  const g = s?.ownerGpu;
  return g ? { connected: true, mode: "computer", online: g.online, ...(g.comfy && { comfy: g.comfy }), ...(g.device && { device: g.device }), ...(g.vramBytes && { vramBytes: g.vramBytes }) } : undefined;
}

/** A connection test's answer (POST /api/providers/test). `code` "on-your-computer": a hosted page's local address, not called. */
export interface ConnectionTest {
  ok: boolean;
  detail: string;
  code?: "on-your-computer";
}

/**
 * Test a provider, with unsaved values (by setting name) in place of the saved ones when given.
 * `field` is the setting being checked (the Anthropic key, Ollama's address…), so the test checks that one.
 * `place: "hosted"`: the page isn't on the server's machine (lib/page-place.ts), so a ComfyUI address on the server's
 * own machine or network is refused without a call.
 */
export async function testConnection(provider: TestProvider, values?: Record<string, string>, field?: string, o: { place?: "hosted" } = {}): Promise<ConnectionTest> {
  const res = await fetch("/api/providers/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, values, field, ...(o.place && { place: o.place }) }) });
  const body = (await res.json().catch(() => null)) as ConnectionTest | null;
  return body && typeof body.ok === "boolean" ? body : { ok: false, detail: `The test didn't answer (${res.status})` };
}

/** Save settings by name (PUT /api/settings); throws the server's message when a value isn't allowed. */
export async function saveSettings(patch: Record<string, string>): Promise<void> {
  await json(await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }));
}

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: async () => json<StatusInfo>(await fetchWithin("/api/status", READ_LIMIT_MS.status)),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** What an uploaded clip's header says: length, size, frame rate and sound (empty for formats the server can't read). */
export interface ClipFacts {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}

/** The attached clip's facts (Upscale hub: prices by its length, "24 → 60 fps"). Only for uploads and results on this server. */
export function useClipFacts(url: string | undefined) {
  return useQuery({
    queryKey: ["clip-facts", url],
    enabled: !!url && url.startsWith("/api/files/"),
    queryFn: async () =>
      json<ClipFacts>(await fetch("/api/media/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })),
    staleTime: Infinity,
    retry: false,
  });
}

export async function enhance(prompt: string, kind: MediaKind, op: string): Promise<string> {
  return (
    await json<{ prompt: string }>(
      await fetch("/api/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, kind, op }),
      }),
    )
  ).prompt;
}

/** Audio → Music's "Write the lyrics": tagged lyrics for the song `idea` describes (the install's AI helper writes them). */
export async function writeLyrics(idea: string, o: { seconds?: number; max?: number } = {}): Promise<string> {
  return (
    await json<{ lyrics: string }>(
      await fetch("/api/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: idea, target: "lyrics", ...o }),
      }),
    )
  ).lyrics;
}

// ---------------------------------------------------------------------------
// Engine preference (Cloud vs Open source), shared across tabs via localStorage.
// Settings → Engine mode can lock the install to one engine; then the toggle is disabled.

const ENGINE_KEY = "fuobe.engine";
const MODE_KEY = "fuobe.engineMode";
const listeners = new Set<() => void>();

function readEngine(): Engine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "open" ? "open" : "cloud";
  } catch {
    return "cloud";
  }
}

function readCachedMode(): EngineMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "open" || m === "cloud" ? m : "both";
  } catch {
    return "both";
  }
}

const noopSubscribe = () => () => {};

/** false while hydrating (matches the server HTML), true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** The install's engine mode (from the server, cached locally so pages don't flash). */
export function useEngineMode(): EngineMode {
  const hydrated = useHydrated();
  const status = useStatus().data;
  const cached = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readCachedMode,
    () => "both" as EngineMode,
  );
  const serverMode = status?.engineMode;
  useEffect(() => {
    if (!serverMode || serverMode === readCachedMode()) return;
    try {
      localStorage.setItem(MODE_KEY, serverMode);
    } catch {}
    listeners.forEach((l) => l());
  }, [serverMode]);
  // Suspense subtrees can hydrate after the status query resolved; render the server's view until hydrated.
  if (!hydrated) return "both";
  return serverMode ?? cached;
}

/**
 * What Settings → Models & licences switched off, for pickers to leave out (src/lib/model-access.ts offered()).
 * Undefined until hydrated and while everything is on; the server refuses an off model either way.
 */
export function useModelAccess(): AccessSummary | undefined {
  const hydrated = useHydrated();
  const access = useStatus().data?.access;
  return hydrated ? access : undefined;
}

export function useEngine(): [Engine, (e: Engine) => void, EngineMode] {
  const mode = useEngineMode();
  const engine = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    readEngine,
    () => "cloud" as Engine,
  );
  const set = useCallback(
    (e: Engine) => {
      if (mode !== "both") return;
      try {
        localStorage.setItem(ENGINE_KEY, e);
      } catch {}
      listeners.forEach((l) => l());
    },
    [mode],
  );
  return [mode === "both" ? engine : mode, set, mode];
}

/**
 * Whether Idol 3D runs on the owner's open engine here (make3dOffered): the install runs open models, ComfyUI is
 * connected (or placeholder results are on), the viewer is the owner, and Idol 3D is switched on in Settings → Models &
 * licences. False until hydrated and while the status is unknown.
 */
export function useOpenEngine(): boolean {
  const hydrated = useHydrated();
  const status = useStatus().data;
  return hydrated && make3dOffered(status);
}

/** Remember the engine the studios start on, before the mode allows it (an account that just added its own key: Cloud). */
export function preferEngine(e: Engine): void {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {}
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------------------
// Assist

export function useAssistThreads() {
  return useQuery({
    queryKey: ["assist"],
    queryFn: async () => json<{ threads: AssistThreadSummary[]; agent: AssistThread["agent"] }>(await fetch("/api/assist")),
  });
}

export function useAssistThread(id: string | null) {
  return useQuery({
    queryKey: ["assist", id],
    enabled: !!id,
    queryFn: async () => json<AssistThreadView>(await fetch(`/api/assist/${id}`)),
    // Fast while the agent works, slower while generations render, idle otherwise.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.thread.status === "running") return 900;
      return d.generations.some((g) => g.status === "queued" || g.status === "running") ? 1500 : false;
    },
  });
}

export function useAssistActions() {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: ["assist", id] });
    void qc.invalidateQueries({ queryKey: ["assist"], exact: true });
  };
  const post = async <T,>(url: string, body: unknown, method = "POST") =>
    json<T>(await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return {
    start: async (body: { text: string; attachments?: string[]; engine: Engine; autoApprove: boolean }) => {
      const t = await post<AssistThread>("/api/assist", body);
      qc.setQueryData<AssistThreadView>(["assist", t.id], { thread: t, generations: [] });
      refresh(t.id);
      return t;
    },
    send: async (id: string, body: { text: string; attachments?: string[] }) => {
      const t = await post<AssistThread>(`/api/assist/${id}/messages`, body);
      qc.setQueryData<AssistThreadView>(["assist", id], (old) => ({ thread: t, generations: old?.generations ?? [] }));
      refresh(id);
    },
    answer: async (id: string, approve: boolean) => {
      const t = await post<AssistThread>(`/api/assist/${id}/approval`, { approve });
      qc.setQueryData<AssistThreadView>(["assist", id], (old) => ({ thread: t, generations: old?.generations ?? [] }));
      refresh(id);
    },
    setAutoApprove: async (id: string, autoApprove: boolean) => {
      await post(`/api/assist/${id}`, { autoApprove }, "PATCH");
      refresh(id);
    },
    remove: async (id: string) => {
      await fetch(`/api/assist/${id}`, { method: "DELETE" });
      qc.removeQueries({ queryKey: ["assist", id] });
      void qc.invalidateQueries({ queryKey: ["assist"], exact: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Who is looking (public sign-up: GET /api/auth/me)

export interface ViewerInfo {
  signedIn: boolean;
  /** The install password's session or an API token (also everyone while no password is set). */
  owner: boolean;
  /** Guests may browse and anyone may sign up. */
  publicSignup: boolean;
  account?: { email: string };
  /** Runs go to the ComfyUI on the person's own computer, which a Fuobe tab of theirs runs (components/gpu/computer-runner.tsx). */
  computer?: boolean;
  /** The port their computer's tab last found ComfyUI on (a browser that remembers none starts there). */
  comfyPort?: number;
  /** The sound features that have passed a real run (src/server/sound-live.ts), e.g. "clean-voice-first". */
  soundLive?: string[];
}

export function useViewer() {
  return useQuery({
    queryKey: ["viewer"],
    queryFn: async () => json<ViewerInfo>(await fetchWithin("/api/auth/me", READ_LIMIT_MS.viewer)),
    staleTime: 60_000,
  });
}

/** A guest browsing a public studio: signed out while sign-up is open. */
export function useIsGuest(): boolean {
  const v = useViewer().data;
  return !!v && v.publicSignup && !v.signedIn;
}

/** A signed-in account (public sign-up), not the studio's owner. */
export function useIsAccount(): boolean {
  const v = useViewer().data;
  return !!v?.account && !v.owner;
}

/** Whether a sound feature has passed a real run (src/server/sound-live.ts; the viewer's soundLive). */
export function useSoundLive(feature: string): boolean {
  return !!useViewer().data?.soundLive?.includes(feature);
}

/** This browser's tabs hear on it that who is signed in changed (src/app/providers.tsx asks again). */
export const AUTH_CHANNEL = "fuobe-auth";

/** Tells this browser's other tabs that someone signed in or out, so they don't go on as the one before. */
export function announceAuthChange(): void {
  try {
    const c = new BroadcastChannel(AUTH_CHANNEL);
    c.postMessage("changed");
    c.close();
  } catch {}
}

/** Who used this browser last ("owner", "account" or "guest"): the app frame's first-paint script reads it (CHROME_STATE_SCRIPT in nav.ts). */
export const VIEWER_KEY = "fuobe:viewer";

/**
 * Who the next page is for, said before it loads (signing in or out): the top bar keeps the right room from its first
 * frame, so its menu doesn't move when the viewer is known.
 */
export function rememberViewer(kind: "owner" | "account" | "guest"): void {
  try {
    localStorage.setItem(VIEWER_KEY, kind);
  } catch {}
}

/** A word for the next page this tab loads (sessionStorage), when the change itself leaves nothing to see on it. */
const NOTICE_KEY = "fuobe:notice";
export type Notice = "account-deleted";

/** Leaves a notice for the next page, which shows it once (src/app/providers.tsx). */
export function leaveNotice(notice: Notice): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, notice);
  } catch {}
}

/** The notice the last page left, once: reading it removes it. */
export function takeNotice(): Notice | null {
  try {
    const n = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return n === "account-deleted" ? n : null;
  } catch {
    return null;
  }
}

/** Signing out: the server forgets the session, the other tabs hear of it, and the page starts again signed out. */
export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
  rememberViewer("guest");
  announceAuthChange();
  window.location.reload();
}

/**
 * A guest or an account, once known: the studio's library, projects and settings are its owner's, not theirs. False
 * until the page has hydrated: another Suspense boundary may have filled the cache first, and the first render must
 * match the server's HTML.
 */
export function useIsVisitor(): boolean {
  const v = useViewer().data;
  const hydrated = useHydrated();
  return hydrated && !!v && !v.owner;
}

/** Who used this browser last (VIEWER_KEY), or null. Read after hydration only: the server's HTML can't know it. */
function lastViewer(): string | null {
  try {
    return localStorage.getItem(VIEWER_KEY);
  } catch {
    return null;
  }
}

/**
 * A guest or an account, as useIsVisitor, but from the first paint: true until the viewer is known to be the owner. For
 * the tools that run on a self-hosted Fuobe only: a guest's first paint already has their words, the note and the
 * buttons that are off, so nothing changes or moves when the viewer comes. The owner's page switches instead, at
 * hydration in a browser the owner used last (VIEWER_KEY), where the note is hidden from the first paint too
 * (src/components/self-host-note.tsx).
 */
export function useLikelyVisitor(): boolean {
  const v = useViewer().data;
  const hydrated = useHydrated();
  if (!hydrated) return true;
  if (v) return !v.owner;
  return lastViewer() !== "owner";
}

/**
 * The studio's owner, once known (and after hydration, as useIsVisitor): what only the owner can do (Assist's Create
 * and Schedule, the Library's folders, shares and Trash) shows from then on, so a visitor never sees it flash in and out.
 */
export function useIsOwner(): boolean {
  const v = useViewer().data;
  const hydrated = useHydrated();
  return hydrated && !!v?.owner;
}

/** "Sign up" / "Log in" with a way back here. */
export function signInHref(mode: "signup" | "login", next?: string): string {
  const p = new URLSearchParams();
  if (mode === "signup") p.set("signup", "1");
  if (next && next !== "/") p.set("next", next);
  const q = p.toString();
  return q ? `/login?${q}` : "/login";
}

export const GUEST_PROMPT_EVENT = "fuobe:guest-prompt";
export const CONNECT_GPU_EVENT = "fuobe:connect-gpu";
/**
 * What opened "Connect your GPU": `action` a refusal (watchGuestRefusals, or a file chooser that asks first): a refused
 * run's card keeps that run and starts it once connected; `reason` the runner's note; `look` a button that said "Use the
 * ComfyUI on this computer". With none of them, a button that only opens the card: no run waits. `needs`: what would
 * run the owner's refused run (Demo mode off, nothing connected): a GPU, a fal.ai or Replicate key, or either.
 */
export interface ConnectGpuDetail extends RefusalDetail {
  reason?: "setting" | "find" | "browser";
  look?: boolean;
  needs?: ConnectNeeds;
  /** A tool only a GPU runs (no fal.ai or Replicate key can): the card offers the GPU alone, to accounts too. */
  gpuOnly?: boolean;
}
export type ConnectNeeds = "gpu" | "key" | "any";
const asNeeds = (v: string | null): ConnectNeeds | undefined => (v === "gpu" || v === "key" || v === "any" ? v : undefined);
/** A run started from this tab (components/gpu/computer-runtime.ts listens). */
export const COMPUTER_KICK_EVENT = "fuobe:computer-kick";
/** The guided fix (src/components/gpu/guided-fix.tsx): { ref, plan? }. */
export const GPU_SETUP_EVENT = "fuobe:gpu-setup";
/** "Add your key" (src/components/keys/your-keys.tsx): { provider, modelId? }. */
export const ADD_KEY_EVENT = "fuobe:add-key";

/** A card GuestPrompt shows for a refusal: "Create a free account" (coming back to `here` after) or "Connect your GPU". */
export type RefusalCard = { kind: "guest"; here: string } | { kind: "gpu" };

/** What a refusal card is about, for its words: a run (or any other change), or adding a file of one's own. */
export type RefusalAction = "run" | "upload";

/** What the cards' events may say (GUEST_PROMPT_EVENT, CONNECT_GPU_EVENT). Without it, a card is about a run. */
export interface RefusalDetail {
  action?: RefusalAction;
}

/** The requests that add a file of the visitor's own: their refusal's card says "add your own files", not "run this". */
const UPLOAD_PATHS = new Set(["/api/uploads", "/api/media/probe"]);

/** A request's path, whichever way fetch was given it (a path, a URL or a Request). Empty when it can't be read. */
function requestPath(input: RequestInfo | URL): string {
  try {
    return new URL(input instanceof Request ? input.url : String(input), window.location.href || "http://localhost").pathname;
  } catch {
    return "";
  }
}

/** Opens "Create a free account" on its own (GuestPrompt), e.g. before a guest's file chooser: it could only be refused. */
export function askToSignUp(action: RefusalAction = "upload"): void {
  window.dispatchEvent(new CustomEvent<RefusalDetail>(GUEST_PROMPT_EVENT, { detail: { action } }));
}

/**
 * For a file chooser, a drop or a paste: asks first whoever the upload would refuse, instead of letting them pick a file
 * for nothing. A guest gets "Create a free account", an account with neither its own GPU nor its own key "Connect your
 * GPU or add a key". The function returns true when it asked (the chooser stays shut, the file stays out), and false
 * for anyone the upload takes, and while who is looking isn't known yet (the server's refusal opens the same card).
 * `action` "run" asks the same way before a run of a picture already on the site (a GPU-only tool's hand-off).
 */
export function useAskBeforeUpload({ gpuOnly = false }: { gpuOnly?: boolean } = {}): (action?: RefusalAction) => boolean {
  const guest = useIsGuest();
  const seen = useStatus().data?.viewer;
  // With hosted runs on, an account adds pictures for runs on this studio's GPUs: the upload says if a kind isn't taken.
  // A GPU-only tool (gpuOnly) asks for the GPU even when the account has a key: no key runs it.
  const nowhere = seen?.kind === "account" && !seen.gpu.connected && (gpuOnly || !seen.keys?.length) && !seen.hosted;
  return useCallback((action: RefusalAction = "upload") => {
    if (guest) askToSignUp(action);
    else if (nowhere) window.dispatchEvent(new CustomEvent<ConnectGpuDetail>(CONNECT_GPU_EVENT, { detail: { action, ...(gpuOnly && { gpuOnly }) } }));
    else return false;
    return true;
  }, [guest, nowhere, gpuOnly]);
}

/**
 * The card a refusal opens on this page. None on the sign-in page: the visitor is signing in already,
 * and a wrong password there is the form's own error.
 */
export function refusalCard(kind: RefusalCard["kind"], at: { pathname: string; search: string }): RefusalCard | null {
  if (at.pathname === "/login") return null;
  return kind === "guest" ? { kind, here: at.pathname + at.search } : { kind };
}

/**
 * A guest tried to change something (the proxy answers a guest's change with a 401 marked
 * x-fuobe-guest): open "Create a free account" (GuestPrompt). An account tried to run something
 * (a 403 marked x-fuobe-connect-gpu): open "Connect your GPU". Watches every fetch, so the studio's
 * own helpers (json() here, and the components' own) all get it. The response is marked
 * (src/lib/refusals.ts): the error json() and postFile() throw for it shows no toast on top of the
 * card. Never on the sign-in page (refusalCard). Installed once. A refused upload's card says so ("add your own
 * files"), not "run this".
 */
export function watchGuestRefusals(): void {
  const w = window as typeof window & { __fuobeGuestFetch?: boolean };
  if (w.__fuobeGuestFetch) return;
  w.__fuobeGuestFetch = true;
  const original = window.fetch.bind(window);
  const open = (res: Response, kind: RefusalCard["kind"], path: string) => {
    if (!refusalCard(kind, window.location)) return;
    markRefusalShown(res);
    const needs = asNeeds(res.headers.get("x-fuobe-connect-needs"));
    const detail: ConnectGpuDetail = { action: UPLOAD_PATHS.has(path) ? "upload" : "run", ...(needs && { needs }) };
    window.dispatchEvent(new CustomEvent(kind === "guest" ? GUEST_PROMPT_EVENT : CONNECT_GPU_EVENT, { detail }));
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (res.status === 401 && res.headers.get("x-fuobe-guest") === "1" && method !== "GET" && method !== "HEAD") open(res, "guest", requestPath(input));
    if (res.status === 403 && res.headers.get("x-fuobe-connect-gpu") === "1") open(res, "gpu", requestPath(input));
    // The owner's run with nothing connected that runs it (Demo mode off): the connect card too, never an error toast.
    // On a hosted page it offers the ComfyUI on this computer first; on the server's own machine, the server's address.
    if (res.status === 422 && res.headers.get("x-fuobe-connect-gpu") === "1") open(res, "gpu", requestPath(input));
    // A run started here, on the ComfyUI on this computer: the tab that runs it asks for it at once.
    if (res.status === 201 && method === "POST" && requestPath(input) === "/api/generations") {
      window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
    }
    // An account's paid run without its own key for that provider (x-fuobe-add-key: fal | replicate): "Add your key".
    const addKey = res.status === 403 ? res.headers.get(ADD_KEY_HEADER) : null;
    if (isCloudProvider(addKey) && refusalCard("gpu", window.location)) {
      markRefusalShown(res);
      window.dispatchEvent(new CustomEvent(ADD_KEY_EVENT, { detail: { provider: addKey } }));
    }
    // A run the billing service refused (its own words, and a link or an offer): the billing card opens.
    const billing = res.status >= 400 ? res.headers.get(BILLING_HEADER) : null;
    if (billing && refusalCard("gpu", window.location)) {
      markRefusalShown(res);
      res
        .clone()
        .json()
        .then((b: Omit<BillingRefusalDetail, "code">) => window.dispatchEvent(new CustomEvent<BillingRefusalDetail>(BILLING_EVENT, { detail: { ...b, code: billing } })))
        .catch(() => {});
    }
    // A run the GPU pre-flight stopped (something missing on the viewer's ComfyUI): the guided fix opens with its plan.
    if (res.status === 409 && res.headers.get("x-fuobe-gpu-setup") === "1") {
      res
        .clone()
        .json()
        .then((b: { ref?: string; plan?: unknown }) => b.ref && window.dispatchEvent(new CustomEvent(GPU_SETUP_EVENT, { detail: { ref: b.ref, plan: b.plan } })))
        .catch(() => {});
    }
    return res;
  };
}
