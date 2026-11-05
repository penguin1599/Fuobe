"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import {
  describeNode,
  effectiveOp,
  isGenerator,
  tablesFeeding,
  type CanvasGraph,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasPlan,
  type ClipSettings,
  type Connection,
  type NodeDescription,
  type PortType,
  type RunReason,
} from "@/lib/catalog/canvas";
import type { Engine, Generation, GenerationStatus, ModelDef, Operation, OutputFile } from "@/lib/catalog/types";
import type { EngineMode } from "@/lib/api";

export { ICONS, NodeIcon } from "./node-icon";

/** Edge and handle colours per port type (the app's chart tokens, so both themes work). */
export const PORT_COLOR: Record<PortType, string> = {
  text: "var(--chart-2)",
  image: "var(--chart-5)",
  video: "var(--chart-4)",
  audio: "var(--chart-3)",
  element: "var(--chart-1)",
  voice: "var(--chart-3)",
  path: "var(--chart-1)",
};

export type NodeState = GenerationStatus | "idle";

/** What a generator node has made: its latest run's generations, folded into one status. */
export interface NodeResults {
  gens: Generation[];
  state: NodeState;
  /** 0–1 while running. */
  progress: number | null;
  message: string | null;
  error: string | null;
  /** Every output of the latest run, in order. */
  outputs: { g: Generation; o: OutputFile; i: number }[];
}

export const EMPTY_RESULTS: NodeResults = { gens: [], state: "idle", progress: null, message: null, error: null, outputs: [] };

/** A node's latest run folded into one status; `out` (a node made in several steps) is the generation whose outputs it shows. */
export function foldResults(gens: Generation[], out?: string): NodeResults {
  if (!gens.length) return EMPTY_RESULTS;
  const has = (s: GenerationStatus) => gens.some((g) => g.status === s);
  const state: NodeState = has("running") ? "running" : has("queued") ? "queued" : has("failed") ? "failed" : has("canceled") ? "canceled" : "succeeded";
  const live = gens.filter((g) => g.status === "running" || g.status === "queued");
  const progress = live.length ? live.reduce((n, g) => n + (g.progress ?? 0), 0) / live.length : null;
  return {
    gens,
    state,
    progress: progress && progress > 0 ? progress : null,
    message: live[0]?.message ?? null,
    error: gens.find((g) => g.status === "failed")?.error ?? null,
    outputs: gens.flatMap((g) => (g.status === "succeeded" && (!out || g.id === out) ? g.outputs.map((o, i) => ({ g, o, i })) : [])),
  };
}

/** The same results object when the node's generations are the very same objects (memoized nodes skip a render). */
export function foldResultsKeep(prev: NodeResults | undefined, gens: Generation[], out?: string): NodeResults {
  if (prev && prev.gens.length === gens.length && prev.gens.every((g, i) => g === gens[i])) return prev;
  return foldResults(gens, out);
}

// ---------------------------------------------------------------------------
// The editor's state, as nodes read it.
//
// Every node subscribes to the slice it shows (its own NodeView, a few globals) instead of one
// context object that changes on every keystroke: editing node A re-renders A, not the board.

/** Everything a generator node shows that depends on the rest of the board. */
export interface NodeView {
  /** The op it runs (an Auto model node's inferred op, a utility's fixed op). */
  op?: Operation;
  /** Edges into each input handle, e.g. { prompt: 1, images: 2 }. */
  counts: Readonly<Record<string, number>>;
  /** What to fix before it can run (pick a model, add an image…). */
  error?: string;
  /** One run's estimate (null = unknown); every row's, for a node run per row of a table. */
  costUsd: number | null;
  /** Runs once per row of a table: how many rows. */
  rows?: number;
  /** Why Run all would run it; null when its result is reused (or it can't run). */
  step: RunReason | null;
  reused: boolean;
  /** The server's error for this node from the last run. */
  runError?: string;
  results: NodeResults;
}

export const EMPTY_VIEW: NodeView = { counts: {}, costUsd: null, step: null, reused: false, results: EMPTY_RESULTS };

/** The `feature` of the stand-in result a visitor's ready board shows on its last step (its published example). */
export const EXAMPLE_FEATURE = "canvas-example";

/** Board-wide settings the nodes read (they change rarely). */
export interface EditorGlobals {
  canvasId: string;
  engine: Engine;
  mode: EngineMode;
  /** Phone: pan, zoom and tap only. */
  readOnly: boolean;
  /** A run request is in flight. */
  running: boolean;
  /** True when this model would run on the demo provider (no key / no ComfyUI). */
  isDemo: (m: ModelDef) => boolean;
  /** A visitor's board (visitor-canvas.tsx): it never runs here, so nodes show no price and no run state. */
  visitor?: boolean;
}

export interface EditorSnapshot {
  /** The board as it is now. */
  graph: CanvasGraph;
  byId: ReadonlyMap<string, CanvasNode>;
  plan: CanvasPlan;
  views: ReadonlyMap<string, NodeView>;
  globals: EditorGlobals;
}

const sameCounts = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

const sameView = (a: NodeView, b: NodeView) =>
  a.op === b.op && a.error === b.error && a.costUsd === b.costUsd && a.rows === b.rows && a.step === b.step && a.reused === b.reused && a.runError === b.runError && a.results === b.results && sameCounts(a.counts, b.counts);

/** What the planner knows about one generator node: its description and the op it runs. */
export interface NodeInfo {
  d: NodeDescription;
  op?: Operation;
}

/**
 * describeNode and effectiveOp per generator node, worked out again only for nodes whose own data
 * or whose inputs (the nodes wired into them, their order on the board) changed. Typing in one
 * prompt re-describes that prompt's consumers, not the whole board.
 */
export class DescribeCache {
  private entries = new Map<string, { key: unknown[]; info: NodeInfo }>();
  private mode: string | null = null;
  run(graph: CanvasGraph, mode: EngineMode): Map<string, NodeInfo> {
    if (mode !== this.mode) {
      this.entries.clear();
      this.mode = mode;
    }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const into = new Map<string, CanvasGraph["edges"]>();
    for (const e of graph.edges) {
      const list = into.get(e.target);
      if (list) list.push(e);
      else into.set(e.target, [e]);
    }
    const next = new Map<string, { key: unknown[]; info: NodeInfo }>();
    const out = new Map<string, NodeInfo>();
    // Rows reach a node from a table any number of steps up: the table it runs per row of is an input too
    // (worked out once for the whole board, not per node).
    const feeds = graph.nodes.some((n) => n.type === "table") ? tablesFeeding(graph) : null;
    const tableKey = (n: CanvasNode) => {
      const rows = feeds!(n);
      return rows && "table" in rows ? rows.table.data : rows?.error;
    };
    for (const n of graph.nodes) {
      if (!isGenerator(n)) continue;
      const key: unknown[] = [n.type, n.data];
      if (feeds) key.push(tableKey(n));
      for (const e of into.get(n.id) ?? []) {
        const s = byId.get(e.source);
        key.push(e.source, e.targetHandle, s?.type, s?.data, s?.position.x, s?.position.y);
        // A Video concatenator takes a clip per row from a node run per row: that node's table is its input too.
        if (feeds && n.type === "concat" && s) key.push(tableKey(s));
        // A cloned voice passes on what's wired into it: that is an input of this node too.
        if (s?.type === "clone-voice") for (const f of into.get(s.id) ?? []) key.push(f.source, byId.get(f.source)?.type, byId.get(f.source)?.data);
      }
      const old = this.entries.get(n.id);
      const entry = old && old.key.length === key.length && old.key.every((k, i) => k === key[i]) ? old : { key, info: { d: describeNode(graph, n, { engineMode: mode }), op: effectiveOp(graph, n) } };
      next.set(n.id, entry);
      out.set(n.id, entry.info);
    }
    this.entries = next;
    return out;
  }
}

/**
 * One NodeView per generator node, keeping the previous object whenever nothing it shows changed
 * (so its memoized node doesn't re-render).
 */
export function buildViews(
  prev: ReadonlyMap<string, NodeView> | null,
  graph: CanvasGraph,
  plan: CanvasPlan,
  describe: (id: string) => NodeDescription | undefined,
  results: ReadonlyMap<string, NodeResults>,
  runErrors: Record<string, string>,
  opOf: (n: CanvasNode) => Operation | undefined = (n) => effectiveOp(graph, n),
): Map<string, NodeView> {
  const counts = new Map<string, Record<string, number>>();
  for (const e of graph.edges) {
    if (!e.targetHandle) continue;
    const c = counts.get(e.target) ?? {};
    c[e.targetHandle] = (c[e.targetHandle] ?? 0) + 1;
    counts.set(e.target, c);
  }
  const steps = new Map(plan.steps.map((s) => [s.nodeId, s.reason]));
  const reused = new Set(plan.reused.map((r) => r.nodeId));
  const out = new Map<string, NodeView>();
  for (const n of graph.nodes) {
    // A Kinetic node renders in the browser: its view is what feeds it and what it made (no op, no estimate).
    if (n.type === "kinetic") {
      const next: NodeView = { ...EMPTY_VIEW, counts: counts.get(n.id) ?? EMPTY_VIEW.counts, results: results.get(n.id) ?? EMPTY_RESULTS };
      const old = prev?.get(n.id);
      out.set(n.id, old && sameView(old, next) ? old : next);
      continue;
    }
    if (!isGenerator(n)) continue;
    const d = describe(n.id);
    const next: NodeView = {
      op: opOf(n),
      counts: counts.get(n.id) ?? EMPTY_VIEW.counts,
      error: d?.error,
      costUsd: d?.costUsd ?? null,
      ...(d?.rows && { rows: d.rows }),
      step: steps.get(n.id) ?? null,
      reused: reused.has(n.id),
      runError: runErrors[n.id],
      results: results.get(n.id) ?? EMPTY_RESULTS,
    };
    const old = prev?.get(n.id);
    out.set(n.id, old && sameView(old, next) ? old : next);
  }
  return out;
}

/**
 * A tiny external store: the editor publishes a snapshot after each commit, nodes select from it.
 * The editor also peeks at the last snapshot to keep unchanged NodeViews (and results) identical.
 */
export class EditorStore {
  private snap: EditorSnapshot | null = null;
  private listeners = new Set<() => void>();
  get = (): EditorSnapshot => this.snap!;
  /** The last published snapshot (null before the first render). */
  peek(): EditorSnapshot | null {
    return this.snap;
  }
  /** The first render's snapshot, so the nodes' first render reads real values (nobody listens yet). */
  prime(first: EditorSnapshot) {
    if (!this.snap) this.snap = first;
  }
  set(next: EditorSnapshot) {
    if (next === this.snap) return;
    this.snap = next;
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
}

/** What nodes can do to the board. The object never changes, so it never re-renders a node. */
export interface EditorActions {
  update: (id: string, patch: Partial<CanvasNodeData>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  run: (targets?: string[], force?: boolean) => void;
  /** Run a group's nodes (and what they need upstream). */
  runGroup: (groupId: string) => void;
  /** Change one clip of a Video concatenator (its cut, its sound, or the facts measured from its file). */
  patchClip: (nodeId: string, clipId: string, patch: Partial<ClipSettings>) => void;
  cancel: (id: string) => void;
  open: (id: string, index?: number) => void;
  /** Add an input node holding this node's first output, wired nowhere yet. */
  toInput: (id: string) => void;
  /**
   * Add an input node holding a file made for this node elsewhere (an open-engine dub), below it; `takeOver` moves
   * the node's outgoing connections onto it.
   */
  addInput: (id: string, file: { url: string; kind: "image" | "video" | "audio"; label?: string }, takeOver?: boolean) => void;
  /** Draw an edge (the keyboard's "Connect output to…"). */
  connect: (c: Connection) => void;
  /** Remove an edge (the keyboard's "Disconnect"). */
  disconnect: (edgeId: string) => void;
  /** The board right now, read in event handlers and menus (not a subscription). */
  getGraph: () => CanvasGraph;
}

export const EditorStoreContext = createContext<EditorStore | null>(null);
export const EditorActionsContext = createContext<EditorActions | null>(null);

function useStore(): EditorStore {
  const s = useContext(EditorStoreContext);
  if (!s) throw new Error("Canvas node outside the editor");
  return s;
}

export function useEditorActions(): EditorActions {
  const a = useContext(EditorActionsContext);
  if (!a) throw new Error("Canvas node outside the editor");
  return a;
}

/**
 * Select a slice of the editor's state. The component re-renders only when the slice changes
 * (by `isEqual`). `key` is the selector's only input besides the snapshot (a node id).
 */
export function useEditorSelector<T>(selector: (s: EditorSnapshot, key: string) => T, key: string, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStore();
  // The selector and isEqual are module-level functions in practice; what changes is the key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getSnapshot = useMemo(() => cachedSelector(store, selector, key, isEqual), [store, key]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** getSnapshot for useSyncExternalStore: the same value until the slice really changes. */
function cachedSelector<T>(store: EditorStore, selector: (s: EditorSnapshot, key: string) => T, key: string, isEqual: (a: T, b: T) => boolean): () => T {
  let last: { snap: EditorSnapshot; value: T } | null = null;
  return () => {
    const snap = store.get();
    if (last && last.snap === snap) return last.value;
    const value = selector(snap, key);
    last = { snap, value: last && isEqual(last.value, value) ? last.value : value };
    return last.value;
  };
}

const selectView = (s: EditorSnapshot, id: string) => s.views.get(id) ?? EMPTY_VIEW;
const selectResults = (s: EditorSnapshot, id: string) => s.views.get(id)?.results ?? EMPTY_RESULTS;
const selectGlobals = (s: EditorSnapshot) => s.globals;
const selectAll = (s: EditorSnapshot) => s;

export function useNodeView(id: string): NodeView {
  return useEditorSelector(selectView, id);
}

export function useNodeResults(id: string): NodeResults {
  return useEditorSelector(selectResults, id);
}

export function useEditorGlobals(): EditorGlobals {
  return useEditorSelector(selectGlobals, "");
}

/** The whole snapshot (the phone's node list, which shows everything anyway). */
export function useEditorSnapshot(): EditorSnapshot {
  return useEditorSelector(selectAll, "");
}
