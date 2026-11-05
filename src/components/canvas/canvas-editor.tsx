"use client";

import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { useQueryClient } from "@tanstack/react-query";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FitViewOptions,
  type NodeChange,
  type OnConnectEnd,
  type OnNodeDrag,
  type Viewport,
} from "@xyflow/react";
import { BookmarkPlus, ChevronDown, ChevronLeft, Check, Cloud, Cpu, LayoutGrid, List, Loader2, Play, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState, NotFoundState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { fileToSlot } from "@/components/studio/media-slot";
import { Viewer } from "@/components/studio/viewer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useElements, useEngine, useStatus, type EngineMode } from "@/lib/api";
import { getModel } from "@/lib/catalog";
import { dualEngine, onEngine, runsOn } from "@/lib/catalog/engines";
import {
  BOARD_LIMITS,
  copyPage,
  dragShape,
  groupAround,
  groupMembers,
  nextPageName,
  penShape,
  remapNodeData,
  shapeHit,
  withPageGraph,
  type BoardColor,
  type CanvasPage,
  type CanvasShape,
} from "@/lib/catalog/canvas-board";
import {
  acceptsType,
  cleanGraph,
  connectionError,
  convertEngine,
  counterpart,
  defaultModelForNode,
  describeNode,
  elementUpdates,
  EMPTY_GRAPH,
  graphEngine,
  inputPorts,
  isGenerator,
  newId,
  nodeLabel,
  OPEN_DUB_HINT,
  OUT,
  outputType,
  paletteItems,
  planCanvas,
  PREVIEW_IN,
  singleInput,
  type Canvas,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type CanvasNodeData,
  type ClipSettings,
  type PaletteItem,
  type PortType,
} from "@/lib/catalog/canvas";
import type { Engine, MediaKind, ModelDef } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import { useModKey } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import {
  buildViews,
  DescribeCache,
  EditorActionsContext,
  EditorStore,
  EditorStoreContext,
  foldResultsKeep,
  PORT_COLOR,
  type EditorActions,
  type EditorGlobals,
  type EditorSnapshot,
  type NodeResults,
} from "./canvas-context";
import { BOARD_COLOR_VAR, boardToFlow, commentNode, flowToBoard, focusOnMount, groupNode, isBoardNode, shapeNode } from "./board";
import { NodeList } from "./node-list";
import { NODE_TYPES, type FlowNode } from "./nodes";
import { AddMenu, DRAG_TYPE, Palette, PaletteToggle } from "./palette";
import { BoardToolbar, PAGE_PANEL_ID, PageTabs, pageTabId, TOOL_KEYS, type DragShape, type PageOps, type Tool } from "./toolbar";
import { saveCanvas, useCanvasView, useRunCanvas, type CanvasView } from "./use-canvas";
import { useSkillBuilder } from "@/components/skills/skill-builder-provider";
import { KINETIC_RUN_EVENT } from "./kinetic-node";

const GRID: [number, number] = [16, 16];
const snap = (p: { x: number; y: number }) => ({ x: Math.round(p.x / GRID[0]) * GRID[0], y: Math.round(p.y / GRID[1]) * GRID[1] });

/** Palette width plus its margin: the board's fit leaves this side free while the palette is open. */
const PALETTE_SPACE = 292;
/** Below this zoom a board's text is too small to read with the palette open: the first fit hides the palette instead. */
const READABLE_ZOOM = 0.5;

const toFlowNode = (n: CanvasNode): FlowNode => ({ id: n.id, type: n.type, position: n.position, data: n.data, ...(n.type === "output" && n.width ? { width: n.width } : {}) });
const toFlowEdge = (e: CanvasEdge): Edge => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? OUT, targetHandle: e.targetHandle ?? null });
/** A page's board as React Flow nodes: its groups, drawings and comments first (they sit under the graph), then its nodes. */
const toFlowNodes = (g: CanvasGraph): FlowNode[] => [...boardToFlow(g), ...g.nodes.map(toFlowNode)];

function toGraph(nodes: FlowNode[], edges: Edge[], viewport?: Viewport): CanvasGraph {
  const graphNodes: CanvasNode[] = [];
  const board: FlowNode[] = [];
  for (const n of nodes) {
    if (isBoardNode(n)) board.push(n);
    else
      graphNodes.push({
        id: n.id,
        type: n.type as CanvasNode["type"],
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        data: n.data,
        ...(n.type === "output" && n.width ? { width: n.width } : {}),
      });
  }
  return {
    nodes: graphNodes,
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? OUT, targetHandle: e.targetHandle ?? null })),
    ...(viewport && { viewport: { x: Math.round(viewport.x), y: Math.round(viewport.y), zoom: Math.round(viewport.zoom * 1000) / 1000 } }),
    ...(board.length && flowToBoard(board)),
  };
}

/** A drawing on the board as stored (for the eraser's hit test). */
const asShape = (n: FlowNode): CanvasShape | null =>
  n.type === "shape" ? (flowToBoard([n]).shapes?.[0] ?? null) : null;

/** Focus is in a field (typing there never switches tools). */
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu'], [role='listbox'], [role='dialog']");

/** Select: only the middle button pans (a constant: React Flow re-applies a new array on every render). */
const PAN_MIDDLE = [1];

/** Board tools that turn a drag or click on the board into a drawing, a note or a comment. */
const GESTURE_TOOLS = new Set<Tool>(["draw", "erase", "note", "table", "shape", "text", "comment"]);
/** Tools that place one thing: Enter places it in the middle of the view too. */
const PLACE_TOOLS = new Set<Tool>(["note", "table", "shape", "text", "comment"]);

/** Edges whose handles still exist after a model / op change. */
function pruneEdges(nodes: FlowNode[], edges: Edge[]): Edge[] {
  const keep = new Set(cleanGraph(toGraph(nodes, edges)).edges.map((e) => e.id));
  return edges.filter((e) => keep.has(e.id));
}

/** What a node's output handle carries (no graph walk: the node alone decides). */
const typeOfNode = (n: Pick<FlowNode, "id" | "type" | "data">): PortType | null => outputType(EMPTY_GRAPH, { id: n.id, type: n.type as CanvasNode["type"], data: n.data, position: { x: 0, y: 0 } });

const KIND_INPUT: Record<string, CanvasNode["type"]> = { image: "image-input", video: "video-input", audio: "audio-input" };

/** What a delete took from a board: the nodes, and the edges into or out of them. */
const goneWith = (before: { nodes: FlowNode[]; edges: Edge[] }, ids: ReadonlySet<string>) => ({
  nodes: before.nodes.filter((n) => ids.has(n.id)),
  edges: before.edges.filter((e) => ids.has(e.source) || ids.has(e.target)),
});

/** What a group frames on the board: everything whose top-left corner sits inside it (it moves and copies with it). */
function framed(g: FlowNode, nodes: FlowNode[]): FlowNode[] {
  const box = { x: g.position.x, y: g.position.y, w: g.width ?? g.measured?.width ?? 0, h: g.height ?? g.measured?.height ?? 0 };
  return nodes.filter((n) => n.id !== g.id && n.position.x >= box.x && n.position.y >= box.y && n.position.x <= box.x + box.w && n.position.y <= box.y + box.h);
}

// ---------------------------------------------------------------------------

/**
 * Where a board is kept and what its Run does. The owner's canvases save to the studio (/api/canvases) and run there;
 * a visitor's board (src/components/canvas/visitor-canvas.tsx) saves in this browser or to its account, and its Run
 * explains what running needs instead (`visitor`).
 */
export interface BoardHost {
  /** Saves every page (the autosave); `keepalive` while leaving the page. */
  save: (pages: CanvasPage[], keepalive: boolean) => Promise<void>;
  rename: (name: string) => Promise<void>;
  visitor?: VisitorHost;
}

export interface VisitorHost {
  /** Where the board is kept, said where the owner's editor says "Saved" ("Saved in this browser"). */
  savedLabel: string;
  /** Run, Run selected and ⌘↵: what running a board needs, said plainly (it never runs). */
  run: () => void;
  /** Beside Run: Save to your account, or Sign up to save; `now` gives the board as it is on screen. */
  action?: (now: () => BoardNow) => React.ReactNode;
  /** A note under the header (on a phone: build on a larger screen). */
  note?: React.ReactNode;
}

/** The board as it is on screen: every page and its name. */
export interface BoardNow {
  pages: CanvasPage[];
  name: string;
}

export function CanvasEditor({ id }: { id: string }) {
  const view = useCanvasView(id);
  const host = useMemo<BoardHost>(
    () => ({
      save: async (pages, keepalive) => void (await saveCanvas(id, { pages }, keepalive)),
      rename: async (name) => void (await saveCanvas(id, { name })),
    }),
    [id],
  );
  if (view.isLoading) return <EditorSkeleton />;
  if (!view.data) {
    // A canvas that isn't there gets the shared 404 state; a request that failed otherwise can be retried.
    if (view.error && (view.error as { status?: number }).status !== 404) return <ErrorState error={view.error} retry={() => void view.refetch()} />;
    return <NotFoundState title="This canvas isn’t here">It may have been deleted. Its results are still in your library.</NotFoundState>;
  }
  return (
    <ReactFlowProvider>
      <Editor key={id} id={id} initial={view.data.canvas} view={view.data} host={host} />
    </ReactFlowProvider>
  );
}

/** A visitor's board in the same editor: `initial` from this browser, the account or a ready board; `host` keeps it. */
export function BoardEditor({ id, initial, view, host }: { id: string; initial: Canvas; view: CanvasView; host: BoardHost }) {
  return (
    <ReactFlowProvider>
      <Editor key={id} id={id} initial={initial} view={view} host={host} />
    </ReactFlowProvider>
  );
}

export function EditorSkeleton() {
  return (
    <div className="flex h-content flex-col">
      <div className="flex h-14 items-center gap-3 border-b px-3 sm:px-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="ml-auto h-8 w-24 rounded-full" />
      </div>
      <div className="relative flex-1">
        <Skeleton className="absolute top-[20%] left-[15%] h-40 w-64 rounded-xl" />
        <Skeleton className="absolute top-[30%] left-[45%] h-56 w-72 rounded-xl" />
      </div>
    </div>
  );
}

type SaveState = "saved" | "saving" | "error";

interface MenuState {
  x: number;
  y: number;
  flow: { x: number; y: number };
  connect?: { nodeId: string; handleId: string | null; from: "source" | "target"; type: PortType };
}

function Editor({ id, initial, view, host }: { id: string; initial: Canvas; view: CanvasView; host: BoardHost }) {
  const qc = useQueryClient();
  // The host's latest functions, for the autosave and the handlers (a new host object never re-arms them).
  const hostNow = useRef(host);
  useLayoutEffect(() => {
    hostNow.current = host;
  }, [host]);
  const visitor = host.visitor;
  const rf = useReactFlow<FlowNode, Edge>();
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();
  const [engine, setEngine, mode] = useEngine();
  const status = useStatus().data;
  const runM = useRunCanvas(id);
  const runMutate = runM.mutate;

  // Pages: the active one lives in nodes / edges; the others (and the active one as last switched to) in `pages`.
  const [pages, setPages] = useState<CanvasPage[]>(() => initial.pages);
  const [pageId, setPageId] = useState(() => initial.pages[0].id);
  const [nodes, setNodes] = useState<FlowNode[]>(() => toFlowNodes(initial.pages[0].graph));
  const [edges, setEdges] = useState<Edge[]>(() => initial.pages[0].graph.edges.map(toFlowEdge));
  const [name, setName] = useState(initial.name);
  const [tool, setTool] = useState<Tool>("select");
  const [shapeKind, setShapeKind] = useState<DragShape>("rect");
  const [ink, setInk] = useState<BoardColor>("chart-2");
  const toolNow = useRef(tool);
  useEffect(() => {
    toolNow.current = tool;
  }, [tool]);
  const [tab, setTab] = useState<"board" | "list">("board");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [viewer, setViewer] = useState<{ nodeId: string; index: number } | null>(null);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>("saved");
  /** A save the server refused (a 4xx): retrying won't help, the next edit tries again. */
  const [saveRefused, setSaveRefused] = useState(false);
  const [rev, setRev] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const viewport = useRef<Viewport | undefined>(initial.pages[0].graph.viewport);
  const savedRev = useRef(0);
  const savedName = useRef(initial.name);

  // Latest state for event handlers and the save on leave (synced right after each commit).
  const latest = useRef({ nodes, edges, rev, pages, pageId });
  useLayoutEffect(() => {
    latest.current = { nodes, edges, rev, pages, pageId };
  }, [nodes, edges, rev, pages, pageId]);

  const touch = useCallback(() => setRev((r) => r + 1), []);
  /** Every page as it is now (the active one from the board), as saved. */
  const docOf = useCallback(() => withPageGraph(latest.current.pages, latest.current.pageId, toGraph(latest.current.nodes, latest.current.edges, viewport.current)), []);

  // ---- derived: graph, plan, results, and the per-node views the nodes subscribe to
  const [store] = useState(() => new EditorStore());
  const prev = store.peek();
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const planned = useDeferredValue(graph);
  const runs = view.canvas.runs;
  const gens = useMemo(() => new Map(view.generations.map((g) => [g.id, g])), [view.generations]);
  const statusOf = useCallback((gid: string) => gens.get(gid)?.status, [gens]);
  // Described again only where a node or its inputs changed (one keystroke touches one prompt's consumers).
  const [describer] = useState(() => new DescribeCache());
  const described = useMemo(() => describer.run(planned, mode), [describer, planned, mode]);
  const plan = useMemo(
    () => planCanvas(planned, { runs, status: statusOf, engineMode: mode, describe: (n) => described.get(n.id)?.d ?? describeNode(planned, n, { engineMode: mode }) }),
    [planned, runs, statusOf, mode, described],
  );
  const results = useMemo(() => {
    const m = new Map<string, NodeResults>();
    for (const [nodeId, r] of Object.entries(runs)) {
      const list = r.ids.map((g) => gens.get(g)).filter((g): g is NonNullable<typeof g> => !!g);
      // A node made in several steps shows its last step's outputs (the film), and its progress over all of them.
      m.set(nodeId, foldResultsKeep(prev?.views.get(nodeId)?.results, list, r.out));
    }
    return m;
    // `prev` only lends unchanged objects (identity), it isn't an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, gens]);
  const views = useMemo(
    () =>
      buildViews(
        prev?.views ?? null,
        planned,
        plan,
        (nid) => described.get(nid)?.d,
        results,
        runErrors,
        (n) => described.get(n.id)?.op,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planned, plan, described, results, runErrors],
  );
  // What Run selected runs (the graph's nodes; frames, drawings and comments aren't run).
  const selected = useMemo(() => nodes.filter((n) => n.selected && !isBoardNode(n)).map((n) => n.id), [nodes]);
  const busy = [...results.values()].filter((r) => r.state === "running" || r.state === "queued").length;
  const selectedForGroup = useMemo(() => nodes.filter((n) => n.selected && n.type !== "group" && n.type !== "comment").length, [nodes]);
  const generators = graph.nodes.filter(isGenerator);

  const isDemo = useCallback(
    (m: ModelDef) => {
      if (!status) return false;
      if (status.demoMode === "on") return true;
      if (status.demoMode === "off") return false;
      return !m.routes.some((r) => status.providers[r.provider]?.configured);
    },
    [status],
  );
  const isVisitor = !!host.visitor;
  const globals = useMemo<EditorGlobals>(
    () => ({ canvasId: id, engine, mode, readOnly: isMobile, running: runM.isPending, isDemo, visitor: isVisitor }),
    [id, engine, mode, isMobile, runM.isPending, isDemo, isVisitor],
  );
  const snapshot = useMemo<EditorSnapshot>(() => ({ graph, byId, plan, views, globals }), [graph, byId, plan, views, globals]);
  store.prime(snapshot);
  useLayoutEffect(() => store.set(snapshot), [store, snapshot]);

  // Fit around the nodes, leaving the palette's side free.
  const fitFor = useCallback(
    (withPalette: boolean): FitViewOptions<FlowNode> => ({
      padding: { top: isMobile ? "56px" : "72px", right: "56px", bottom: isMobile ? "56px" : "72px", left: withPalette && !isMobile ? `${PALETTE_SPACE}px` : isMobile ? "16px" : "56px" },
      maxZoom: 1,
      minZoom: isMobile ? 0.3 : 0.5,
    }),
    [isMobile],
  );
  const fitOptions = useMemo(() => fitFor(paletteOpen), [fitFor, paletteOpen]);
  // Phones always start fitted (a viewport saved on a big screen would show an empty board).
  const savedViewport = isMobile ? undefined : initial.pages[0].graph.viewport;
  // The first fit, once every node has its size: a big board may zoom further out than later fits,
  // and when it would be too small to read beside the palette, the palette folds away instead.
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized || fitted.current) return;
    fitted.current = true;
    if (savedViewport || !latest.current.nodes.length) return;
    const frame = requestAnimationFrame(() => {
      const rect = wrapper.current?.getBoundingClientRect();
      let withPalette = paletteOpen && !isMobile;
      if (withPalette && rect) {
        const b = rf.getNodesBounds(latest.current.nodes);
        const zoom = Math.min((rect.width - PALETTE_SPACE - 56) / Math.max(1, b.width), (rect.height - 112) / Math.max(1, b.height));
        if (zoom < READABLE_ZOOM) {
          withPalette = false;
          setPaletteOpen(false);
        }
      }
      void rf.fitView({ ...fitFor(withPalette), minZoom: isMobile ? 0.15 : 0.3 });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, savedViewport, rf, fitFor, paletteOpen, isMobile]);
  // A page opened without a saved view (new, or on a phone): fitted once its nodes have their sizes.
  const pageFit = useRef(false);
  useEffect(() => {
    if (!initialized || !pageFit.current) return;
    pageFit.current = false;
    const frame = requestAnimationFrame(() => void rf.fitView({ ...fitFor(paletteOpen), minZoom: isMobile ? 0.15 : 0.3 }));
    return () => cancelAnimationFrame(frame);
  }, [initialized, nodes.length, rf, fitFor, paletteOpen, isMobile]);

  // ---- autosave
  const save = useCallback(
    async (keepalive = false) => {
      const at = latest.current.rev;
      if (at === savedRev.current) return;
      setSaveState("saving");
      try {
        await hostNow.current.save(docOf(), keepalive);
        savedRev.current = Math.max(savedRev.current, at);
        setSaveState("saved");
        setSaveRefused(false);
        void qc.invalidateQueries({ queryKey: ["canvases"], exact: true });
      } catch (e) {
        setSaveState("error");
        const code = (e as { status?: number }).status;
        if (code && code >= 400 && code < 500) {
          // Retrying the same board won't help: say what's wrong (the server names the node).
          setSaveRefused(true);
          toast.error((e as Error).message, { id: `canvas-save-${id}` });
        }
      }
    },
    [id, qc, docOf],
  );
  // ---- Save as skill (W5): the board saved first, so the skill is made from what's on screen.
  const skillBuilder = useSkillBuilder();
  const saveAsSkill = useCallback(async () => {
    await save();
    skillBuilder?.openCanvas(id, latest.current.pageId);
  }, [id, save, skillBuilder]);
  useEffect(() => {
    if (rev === 0) return;
    const t = setTimeout(() => void save(), 700);
    return () => clearTimeout(t);
  }, [rev, save]);
  // Retry a failed save (a network blip, a restart), and flush when the tab is hidden or closed.
  useEffect(() => {
    if (saveState !== "error" || saveRefused) return;
    const t = setTimeout(() => void save(), 4000);
    return () => clearTimeout(t);
  }, [saveState, saveRefused, save]);
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") void save(true);
    };
    // Leaving with unsaved edits: send them with keepalive (no "leave site?" prompt).
    const leave = () => void save(true);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", leave);
    };
  }, [save]);
  // Leaving through an in-app link (the page unmounts, or Next hides it): send what the debounce still holds.
  const flushOnLeave = useCallback(() => {
    const at = latest.current.rev;
    if (at === savedRev.current) return;
    savedRev.current = at;
    void hostNow.current
      .save(docOf(), true)
      .then(() => qc.invalidateQueries({ queryKey: ["canvases"], exact: true }))
      .catch(() => {
        // Not saved after all: the next edit (or the next visit) saves again.
        savedRev.current = -1;
      });
  }, [qc, docOf]);
  useEffect(() => flushOnLeave, [flushOnLeave]);

  const rename = async (next: string) => {
    const v = next.trim();
    if (!v) return setName(savedName.current);
    if (v === savedName.current) return;
    try {
      await hostNow.current.rename(v);
      savedName.current = v;
      void qc.invalidateQueries({ queryKey: ["canvases"], exact: true });
    } catch (e) {
      toastError(e);
    }
  };

  // ---- editing
  const update = useCallback(
    (nodeId: string, patch: Partial<CanvasNodeData>) => {
      const apply = (ns: FlowNode[]) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n));
      setNodes(apply);
      if ("modelId" in patch || "op" in patch || "mediaKind" in patch) setEdges((es) => pruneEdges(apply(latest.current.nodes), es));
      setRunErrors((r) => {
        if (!(nodeId in r)) return r;
        const next = { ...r };
        delete next[nodeId];
        return next;
      });
      touch();
    },
    [touch],
  );

  // An element renamed (or given a new photo) while the board is open: its nodes follow, and the board saves.
  const elements = useElements().data;
  useEffect(() => {
    if (!elements) return;
    const updates = elementUpdates(toGraph(latest.current.nodes, latest.current.edges), elements);
    if (!updates.size) return;
    setNodes((ns) => ns.map((n) => (updates.has(n.id) ? { ...n, data: { ...n.data, ...updates.get(n.id) } } : n)));
    touch();
  }, [elements, touch]);

  /**
   * Change one page's board, whether it's on screen or not: an Undo clicked after switching pages lands on the page
   * it belongs to. False when that page is gone.
   */
  const editPage = useCallback(
    (pid: string, f: (nodes: FlowNode[], edges: Edge[]) => { nodes: FlowNode[]; edges: Edge[] }) => {
      const now = latest.current;
      if (now.pageId === pid) {
        const r = f(now.nodes, now.edges);
        setNodes(r.nodes);
        setEdges(r.edges);
      } else {
        const page = now.pages.find((p) => p.id === pid);
        if (!page) return false;
        const r = f(toFlowNodes(page.graph), page.graph.edges.map(toFlowEdge));
        setPages((ps) => ps.map((p) => (p.id === pid ? { ...p, graph: toGraph(r.nodes, r.edges, p.graph.viewport) } : p)));
      }
      touch();
      return true;
    },
    [touch],
  );

  /** Put back what a delete took (nodes and their edges) on its page; whatever changed since stays as it is. */
  const restore = useCallback(
    (pid: string, gone: { nodes: FlowNode[]; edges: Edge[] }) =>
      editPage(pid, (ns, es) => {
        const have = new Set(ns.map((n) => n.id));
        const back = gone.nodes.filter((n) => !have.has(n.id)).map((n) => ({ ...n, selected: false }));
        const nodes = [...back.filter(isBoardNode), ...ns, ...back.filter((n) => !isBoardNode(n))];
        const ids = new Set(nodes.map((n) => n.id));
        const edges = [...es];
        for (const e of gone.edges) {
          if (edges.some((x) => x.id === e.id) || !ids.has(e.source) || !ids.has(e.target)) continue;
          // A single input wired to something else since keeps that connection.
          const taken = edges.some((x) => x.target === e.target && x.targetHandle === e.targetHandle);
          if (taken && singleInput(toGraph(nodes, edges), e.target, e.targetHandle)) continue;
          edges.push({ ...e, selected: false });
        }
        return { nodes, edges };
      }),
    [editPage],
  );

  /** Deleted nodes come back with their edges from the toast's Undo (on the page they were deleted from). */
  const offerUndo = useCallback(
    (count: number, gone: { nodes: FlowNode[]; edges: Edge[] }, what = "node") => {
      const pid = latest.current.pageId;
      toast(count === 1 ? `${what[0].toUpperCase()}${what.slice(1)} deleted` : `${count} ${what}s deleted`, {
        duration: 5000,
        action: { label: "Undo", onClick: () => void restore(pid, gone) },
      });
    },
    [restore],
  );

  const remove = useCallback(
    (nodeId: string) => {
      const before = latest.current;
      const type = before.nodes.find((n) => n.id === nodeId)?.type;
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      touch();
      const gone = goneWith(before, new Set([nodeId]));
      // Ungrouping keeps the nodes: the frame alone comes back. An empty comment closing goes quietly.
      if (type === "group") {
        const pid = before.pageId;
        return void toast("Ungrouped — the nodes stay where they are", { duration: 2500, action: { label: "Undo", onClick: () => void restore(pid, gone) } });
      }
      const n = before.nodes.find((x) => x.id === nodeId);
      if (type === "comment" && !String(n?.data.text ?? "").trim()) return;
      offerUndo(1, gone, type === "comment" ? "comment" : type === "shape" ? "drawing" : "node");
    },
    [touch, offerUndo, restore],
  );

  /** Copies of the nodes (a group with what's inside it), wired to each other the way the originals are. */
  const duplicate = useCallback(
    (ids: string | string[]) => {
      const now = latest.current.nodes;
      const list = new Set(Array.isArray(ids) ? ids : [ids]);
      for (const g of now) if (list.has(g.id) && g.type === "group") for (const m of framed(g, now)) list.add(m.id);
      const picked = now.filter((n) => list.has(n.id));
      const map = new Map(picked.map((n) => [n.id, newId(n.type ?? "node")]));
      // A Video concatenator copied with its clips keeps each clip's cut, sound and place in the order.
      const copies = picked.map((n) => ({ ...n, id: map.get(n.id)!, position: { x: n.position.x + 48, y: n.position.y + 48 }, data: { ...remapNodeData(n.data, map), pinned: undefined }, selected: true }));
      if (!copies.length) return;
      const wires = latest.current.edges
        .filter((e) => map.has(e.source) && map.has(e.target))
        .map((e) => ({ ...e, id: newId("e"), source: map.get(e.source)!, target: map.get(e.target)!, selected: false }));
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...copies]);
      if (wires.length) setEdges((es) => [...es, ...wires]);
      touch();
    },
    [touch],
  );

  const addNode = useCallback(
    (item: PaletteItem, at: { x: number; y: number }, connect?: MenuState["connect"]) => {
      if (item.disabled) return void toast(item.disabled);
      const data: CanvasNodeData = { ...item.data };
      if (isGenerator({ type: item.type })) {
        // An install locked to one engine never gets a node on the other.
        const m = defaultModelForNode({ type: item.type, data }, engine) ?? (mode === "both" ? defaultModelForNode({ type: item.type, data }, engine === "open" ? "cloud" : "open") : undefined);
        if (m) data.modelId = m.id;
        // A Fuobe Original (both engines) starts on the engine the board is on.
        if (m && dualEngine(m) && runsOn(m, engine)) data.engine = engine;
      }
      const node: FlowNode = { id: newId(item.type), type: item.type, position: snap(at), data, selected: true };
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
      if (connect) {
        const g = toGraph([...latest.current.nodes, node], latest.current.edges);
        const c: Connection =
          connect.from === "source"
            ? { source: connect.nodeId, sourceHandle: OUT, target: node.id, targetHandle: item.type === "output" ? PREVIEW_IN : (inputPorts(toGraph([node], []).nodes[0]).find((p) => acceptsType(p, connect.type))?.id ?? null) }
            : { source: node.id, sourceHandle: OUT, target: connect.nodeId, targetHandle: connect.handleId };
        if (c.targetHandle && !connectionError(g, c)) {
          setEdges((es) => [...(singleInput(g, c.target, c.targetHandle) ? es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)) : es), { id: newId("e"), ...c }]);
        }
      }
      touch();
      return node.id;
    },
    [engine, mode, touch],
  );

  // A group moves what's inside it: its members as they were when the drag started (not what it sweeps over).
  const groupDrag = useRef(new Map<string, { origin: { x: number; y: number }; members: Map<string, { x: number; y: number }> }>());
  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_e, _node, dragged) => {
    groupDrag.current.clear();
    const moving = new Set(dragged.map((n) => n.id));
    for (const g of dragged) {
      if (g.type !== "group") continue;
      const members = framed(g, latest.current.nodes).filter((n) => !moving.has(n.id));
      groupDrag.current.set(g.id, { origin: { ...g.position }, members: new Map(members.map((m) => [m.id, { ...m.position }])) });
    }
  }, []);
  const onNodeDragStop = useCallback(() => groupDrag.current.clear(), []);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const removed = changes.filter((c) => c.type === "remove");
      const before = latest.current;
      const follow: NodeChange<FlowNode>[] = [];
      for (const c of changes) {
        const drag = c.type === "position" && c.position ? groupDrag.current.get(c.id) : undefined;
        if (!drag || c.type !== "position" || !c.position) continue;
        const dx = c.position.x - drag.origin.x;
        const dy = c.position.y - drag.origin.y;
        for (const [mid, p] of drag.members) follow.push({ type: "position", id: mid, position: { x: p.x + dx, y: p.y + dy }, dragging: c.dragging });
      }
      setNodes((ns) => applyNodeChanges(follow.length ? [...changes, ...follow] : changes, ns));
      if (changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace" || (c.type === "position" && !c.dragging) || (c.type === "dimensions" && c.resizing === false))) touch();
      if (removed.length) {
        const kinds = new Set(removed.map((c) => before.nodes.find((n) => n.id === c.id)?.type));
        const gone = goneWith(before, new Set(removed.map((c) => c.id)));
        offerUndo(removed.length, gone, kinds.size === 1 && kinds.has("comment") ? "comment" : kinds.size === 1 && kinds.has("shape") ? "drawing" : kinds.size === 1 && kinds.has("group") ? "group" : "node");
      }
    },
    [touch, offerUndo],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type !== "select")) touch();
    },
    [touch],
  );
  const isValidConnection = useCallback((c: Connection | Edge) => !connectionError(toGraph(latest.current.nodes, latest.current.edges), c), []);
  const onConnect = useCallback(
    (c: Connection) => {
      const g = toGraph(latest.current.nodes, latest.current.edges);
      const err = connectionError(g, c);
      if (err) return void toast.error(err);
      // A single input (start frame, video, audio…) takes the new edge instead of the old one.
      setEdges((es) => [...(singleInput(g, c.target, c.targetHandle) ? es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)) : es), { id: newId("e"), ...c }]);
      touch();
    },
    [touch],
  );
  const disconnect = useCallback(
    (edgeId: string) => {
      setEdges((es) => es.filter((e) => e.id !== edgeId));
      touch();
    },
    [touch],
  );

  const openMenuAt = useCallback(
    (clientX: number, clientY: number, connect?: MenuState["connect"]) => {
      const rect = wrapper.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.min(Math.max(8, clientX - rect.left), rect.width - 264);
      const y = Math.min(Math.max(8, clientY - rect.top), rect.height - 340);
      setMenu({ x, y, flow: rf.screenToFlowPosition({ x: clientX, y: clientY }), connect });
    },
    [rf],
  );

  // A connection dropped on empty board: offer the nodes that fit, and wire the new one up.
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode || state.toNode) return;
      const pt = "changedTouches" in event ? event.changedTouches[0] : event;
      const g = toGraph(latest.current.nodes, latest.current.edges);
      const from = g.nodes.find((n) => n.id === state.fromNode!.id);
      if (!from) return;
      const fromSource = state.fromHandle?.type === "source";
      const type = fromSource ? outputType(g, from) : inputPorts(from).find((p) => p.id === state.fromHandle?.id)?.type;
      if (!type) return;
      openMenuAt(pt.clientX, pt.clientY, { nodeId: from.id, handleId: state.fromHandle?.id ?? null, from: fromSource ? "source" : "target", type });
    },
    [openMenuAt],
  );

  const palette = useMemo(() => paletteItems(mode, engine), [mode, engine]);
  const menuItems = useMemo(() => {
    const c = menu?.connect;
    if (!c) return palette;
    return palette.filter((p) => {
      const data: CanvasNodeData = { ...p.data };
      const m = isGenerator({ type: p.type }) ? defaultModelForNode({ type: p.type, data }, engine) : undefined;
      if (m) data.modelId = m.id;
      const n: CanvasNode = { id: "probe", type: p.type, position: { x: 0, y: 0 }, data };
      if (c.from === "source") return p.type === "output" ? c.type !== "element" : inputPorts(n).some((port) => acceptsType(port, c.type));
      return outputType({ nodes: [n], edges: [] }, n) === c.type;
    });
  }, [menu, engine, palette]);

  // ---- running (the page on the board)
  const run = useCallback(
    (targets?: string[], force?: boolean, group?: string) => {
      // A visitor's board never runs here: its Run says what running needs.
      if (hostNow.current.visitor) return hostNow.current.visitor.run();
      const go = (t?: string[], f?: boolean) => {
        const at = latest.current.rev;
        runMutate(
          // Every page goes with the run (saved first, like the autosave): a page renamed, added or deleted, or another
          // page's edit still in the autosave's debounce, is saved by it too.
          { page: latest.current.pageId, targets: t, group, force: f, pages: docOf() },
          {
            onSuccess: (r) => {
              // Kinetic nodes render in this tab: they start now, each waiting for what feeds it.
              if (!group) window.dispatchEvent(new CustomEvent(KINETIC_RUN_EVENT, { detail: { canvasId: id, targets: t, ran: r.ran ?? [], errors: r.errors ?? [] } }));
              // The run saved the whole canvas as it was at `at`.
              savedRev.current = Math.max(savedRev.current, at);
              if (latest.current.rev === savedRev.current) setSaveState("saved");
              setRunErrors(Object.fromEntries((r.errors ?? []).map((e) => [e.nodeId, e.message])));
              if (!r.ok) return void toast.error(r.error ?? "Couldn't run this");
              // A Translate (video) dubbing in Translate & dub isn't something to fix here.
              const fix = (r.errors ?? []).filter((e) => e.message !== OPEN_DUB_HINT).length;
              const issues = fix ? `${fix} node${fix > 1 ? "s" : ""} need${fix > 1 ? "" : "s"} attention` : undefined;
              if (!r.ran.length) toast("Everything's up to date", { description: issues, action: { label: "Run again", onClick: () => go(t, true) } });
              else toast.success(r.ran.length === 1 ? "Running 1 node" : `Running ${r.ran.length} nodes`, { description: issues, duration: 1800 });
            },
            onError: (e) => toastError(e),
          },
        );
      };
      go(targets, force);
    },
    [runMutate, docOf, id],
  );

  /**
   * ⌘↵ and Run selected: the selected nodes, and what's inside selected groups (a group alone runs as Run group).
   * Drawings, comments and notes aren't run: with nothing runnable selected, everything runs.
   */
  const runSelection = useCallback(
    (force?: boolean) => {
      const sel = latest.current.nodes.filter((n) => n.selected);
      const groups = sel.filter((n) => n.type === "group");
      const picked = sel.filter((n) => !isBoardNode(n));
      if (groups.length === 1 && !picked.length) return run(undefined, force, groups[0].id);
      const g = toGraph(latest.current.nodes, latest.current.edges);
      const targets = new Set(picked.map((n) => n.id));
      for (const fr of groups) {
        const box = g.groups?.find((x) => x.id === fr.id);
        if (box) for (const m of groupMembers(g, box)) targets.add(m.id);
      }
      if (!targets.size && groups.length) return void toast("Nothing to run in these groups yet — put nodes inside them");
      run(targets.size ? [...targets] : undefined, force);
    },
    [run],
  );

  const cancel = useCallback(
    async (nodeId: string) => {
      const ids = (runs[nodeId]?.ids ?? []).filter((g) => {
        const s = gens.get(g)?.status;
        return s === "queued" || s === "running";
      });
      await Promise.all(ids.map((g) => fetch(`/api/generations/${g}/cancel`, { method: "POST" })));
      void qc.invalidateQueries({ queryKey: ["canvases", id] });
    },
    [runs, gens, qc, id],
  );

  /** An input node holding `file`, below the node it came from; `takeOver` moves that node's outgoing connections onto it. */
  const addInput = (nodeId: string, file: { url: string; kind: string; label?: string }, takeOver = false) => {
    const src = latest.current.nodes.find((n) => n.id === nodeId);
    const type = KIND_INPUT[file.kind];
    if (!src || !type) return;
    const nid = newId("input");
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { id: nid, type, position: snap({ x: src.position.x, y: src.position.y + (src.measured?.height ?? 360) + 48 }), data: { url: file.url, label: file.label ?? `From ${nodeLabel(toGraph([src], []).nodes[0])}` }, selected: true },
    ]);
    const moved = takeOver ? latest.current.edges.filter((e) => e.source === nodeId).length : 0;
    if (moved) setEdges((es) => es.map((e) => (e.source === nodeId ? { ...e, id: newId("e"), source: nid, sourceHandle: OUT } : e)));
    touch();
    toast(moved ? `Added as an input, connected where “${nodeLabel(toGraph([src], []).nodes[0])}” was` : "Added as an input — connect it anywhere");
  };
  const toInput = (nodeId: string) => {
    const out = results.get(nodeId)?.outputs.find((x) => KIND_INPUT[x.o.kind]);
    if (out) addInput(nodeId, { url: out.o.url, kind: out.o.kind });
  };

  /** One clip of a Video concatenator: merged into what the node holds now (several clips report their lengths at once). */
  const patchClip = useCallback(
    (nodeId: string, clipId: string, patch: Partial<ClipSettings>) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== nodeId) return n;
          const clips = { ...n.data.clips };
          const next: ClipSettings = { ...clips[clipId], ...patch };
          for (const k of Object.keys(next) as (keyof ClipSettings)[]) if (next[k] === undefined) delete next[k];
          clips[clipId] = next;
          return { ...n, data: { ...n.data, clips } };
        }),
      );
      touch();
    },
    [touch],
  );

  // ---- groups
  const groupSelection = useCallback(() => {
    const sel = latest.current.nodes.filter((n) => n.selected && n.type !== "group" && n.type !== "comment");
    if (!sel.length) return void toast("Select what to group first: drag a box around the nodes, or ⇧-click them");
    const g = groupAround(newId("group"), [rf.getNodesBounds(sel)], "Group");
    if (!g) return;
    setNodes((ns) => [groupNode(g), ...ns.map((n) => (n.selected ? { ...n, selected: false } : n))]);
    touch();
    toast(`Grouped ${sel.length === 1 ? "1 node" : `${sel.length} nodes`}`, { description: "Drag the group's title to move them together; Run group runs them", duration: 3000 });
  }, [rf, touch]);
  const ungroupSelection = useCallback(() => {
    const ids = latest.current.nodes.filter((n) => n.selected && n.type === "group").map((n) => n.id);
    if (!ids.length) return;
    const gone = goneWith(latest.current, new Set(ids));
    const pid = latest.current.pageId;
    setNodes((ns) => ns.filter((n) => !ids.includes(n.id)));
    touch();
    toast(ids.length === 1 ? "Ungrouped" : `${ids.length} groups ungrouped`, { duration: 2500, action: { label: "Undo", onClick: () => void restore(pid, gone) } });
  }, [touch, restore]);

  // ---- pages
  /** Show another page: the board's page is put back into `pages` first, so nothing on it is lost. */
  const showPage = useCallback(
    (next: CanvasPage[], to: string) => {
      const target = next.find((p) => p.id === to) ?? next[0];
      setPages(next);
      setPageId(target.id);
      setNodes(toFlowNodes(target.graph));
      setEdges(target.graph.edges.map(toFlowEdge));
      setRunErrors({});
      setMenu(null);
      setViewer(null);
      viewport.current = target.graph.viewport;
      if (target.graph.viewport && !isMobile) rf.setViewport(target.graph.viewport);
      else pageFit.current = true;
    },
    [rf, isMobile],
  );
  const pageOps = useMemo<PageOps>(
    () => ({
      switchTo: (to) => {
        if (to !== latest.current.pageId) showPage(docOf(), to);
      },
      add: () => {
        const doc = docOf();
        if (doc.length >= BOARD_LIMITS.pages) return;
        const page: CanvasPage = { id: newId("page"), name: nextPageName(doc), graph: { nodes: [], edges: [] } };
        showPage([...doc, page], page.id);
        touch();
      },
      rename: (pid, nm) => {
        setPages(docOf().map((p) => (p.id === pid ? { ...p, name: nm.slice(0, 60) } : p)));
        touch();
      },
      duplicate: (pid) => {
        const doc = docOf();
        const src = doc.find((p) => p.id === pid);
        if (!src || doc.length >= BOARD_LIMITS.pages) return;
        const copy = copyPage(src, newId("page"), `${src.name} copy`.slice(0, 60), newId);
        const at = doc.indexOf(src) + 1;
        showPage([...doc.slice(0, at), copy, ...doc.slice(at)], copy.id);
        touch();
      },
      remove: (pid) => {
        const doc = docOf();
        if (doc.length < 2) return;
        const was = latest.current.pageId;
        const at = doc.findIndex((p) => p.id === pid);
        const page = doc[at];
        const next = doc.filter((p) => p.id !== pid);
        if (pid === was) showPage(next, next[Math.max(0, at - 1)].id);
        else setPages(next);
        touch();
        toast(`Deleted “${page.name}”`, {
          description: "Its results stay in your library",
          duration: 6000,
          action: {
            label: "Undo",
            // The page comes back where it was; edits made meanwhile on the other pages stay.
            onClick: () => {
              const now = docOf();
              if (now.some((p) => p.id === pid)) return;
              if (now.length >= BOARD_LIMITS.pages) return void toast(`A canvas holds up to ${BOARD_LIMITS.pages} pages — delete one to bring “${page.name}” back`);
              const back = [...now.slice(0, at), page, ...now.slice(at)];
              if (pid === was) showPage(back, pid);
              else setPages(back);
              touch();
            },
          },
        });
      },
    }),
    [docOf, showPage, touch],
  );

  // ---- board tools: a drag or click on the board draws, erases, or places a note, text or comment
  const [stroke, setStroke] = useState<{ points: { x: number; y: number }[]; kind: Tool } | null>(null);
  const placeShape = useCallback(
    (s: CanvasShape, focus = false) => {
      if (focus) focusOnMount.add(s.id);
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...shapeNode(s), selected: !focus }]);
      touch();
    },
    [touch],
  );
  const onToolPointerDown = (e: React.PointerEvent) => {
    if (isMobile || !GESTURE_TOOLS.has(tool) || e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest(".react-flow__panel, .react-flow__controls, .react-flow__minimap, [data-board-ui]")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = wrapper.current!.getBoundingClientRect();
    const flowAt = (x: number, y: number) => rf.screenToFlowPosition({ x, y });
    const start = flowAt(e.clientX, e.clientY);
    const screen = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
    const points = [start];
    const erased: FlowNode[] = [];
    const erase = (p: { x: number; y: number }) => {
      const tol = 8 / rf.getZoom();
      const hits = latest.current.nodes.filter((n) => n.type === "shape").filter((n) => { const sh = asShape(n); return sh && shapeHit(sh, p, tol); });
      const hit = new Set(hits.map((n) => n.id));
      if (!hit.size) return;
      erased.push(...hits);
      latest.current = { ...latest.current, nodes: latest.current.nodes.filter((n) => !hit.has(n.id)) };
      setNodes((ns) => ns.filter((n) => !hit.has(n.id)));
    };
    if (tool === "erase") erase(start);
    const move = (ev: PointerEvent) => {
      const p = flowAt(ev.clientX, ev.clientY);
      points.push(p);
      screen.push({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      if (tool === "erase") erase(p);
      else if (tool === "draw" || tool === "shape") setStroke({ points: tool === "draw" ? [...screen] : [screen[0], screen[screen.length - 1]], kind: tool });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setStroke(null);
      const end = flowAt(ev.clientX, ev.clientY);
      const dragged = Math.hypot(ev.clientX - rect.left - screen[0].x, ev.clientY - rect.top - screen[0].y) > 6;
      if (tool === "erase") {
        if (erased.length) {
          touch();
          offerUndo(erased.length, { nodes: erased, edges: [] }, "drawing");
        }
        return;
      }
      if (tool === "draw") {
        const s = penShape(newId("shape"), points, ink);
        if (s) placeShape(s);
        return;
      }
      place(tool, start, dragged ? end : undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** A placing tool's one thing at `at` (a shape spans to `to` when dragged); then back to Select. */
  const place = (t: Tool, at: { x: number; y: number }, to?: { x: number; y: number }) => {
    if (t === "shape") {
      const b = to ?? { x: at.x + 160, y: at.y + (shapeKind === "arrow" ? 0 : 100) };
      placeShape(dragShape(newId("shape"), shapeKind, at, b, ink));
    } else if (t === "text") {
      placeShape({ id: newId("shape"), kind: "text", x: Math.round(at.x), y: Math.round(at.y - 16), width: 260, height: 40, color: ink, text: "" }, true);
    } else if (t === "note" || t === "table") {
      addNode(palette.find((p) => p.id === t)!, at);
    } else if (t === "comment") {
      const c = commentNode(at);
      focusOnMount.add(c.id);
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), c]);
      touch();
    }
    // Placing is one-off: back to Select (drawing and erasing stay on until switched off).
    setTool("select");
  };
  /** Enter with a placing tool: in the middle of the view (a shape or note centred there). */
  const placeAtCentre = (t: Tool) => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const mid = rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const half = t === "shape" ? { x: 80, y: shapeKind === "arrow" ? 0 : 50 } : t === "note" || t === "table" ? { x: 140, y: 80 } : t === "text" ? { x: 130, y: 0 } : { x: 0, y: 0 };
    place(t, { x: mid.x - half.x, y: mid.y - half.y });
  };

  // ---- engine
  const boardEngine = graphEngine(graph) ?? engine;
  const switchEngine = (e: Engine) => {
    setEngine(e);
    const before = latest.current;
    const { graph: next, changed, missing } = convertEngine(toGraph(before.nodes, before.edges), e);
    if (changed) {
      const byNode = new Map(next.nodes.map((n) => [n.id, n]));
      const after = before.nodes.map((n) => ({ ...n, data: byNode.get(n.id)?.data ?? n.data }));
      const kept = pruneEdges(after, before.edges);
      setNodes(after);
      setEdges(kept);
      touch();
      const pid = before.pageId;
      const was = new Map(before.nodes.filter((n) => byNode.get(n.id) && byNode.get(n.id)!.data !== n.data).map((n) => [n.id, n.data]));
      const dropped = before.edges.filter((x) => !kept.includes(x));
      toast.success(`Switched ${changed} node${changed > 1 ? "s" : ""} to ${e === "open" ? "open-source" : "cloud"} models`, {
        action: {
          label: "Undo",
          // The nodes get their models back on their page, and the edges the switch dropped (inputs the new models
          // don't have) come back too.
          onClick: () =>
            void editPage(pid, (ns, es) => {
              const nodes = ns.map((n) => (was.has(n.id) ? { ...n, data: was.get(n.id)! } : n));
              const ids = new Set(nodes.map((n) => n.id));
              return { nodes, edges: [...es, ...dropped.filter((x) => ids.has(x.source) && ids.has(x.target) && !es.some((y) => y.id === x.id))] };
            }),
        },
      });
    }
    if (missing.length) toast(`${missing.length} node${missing.length > 1 ? "s have" : " has"} no ${e === "open" ? "open-source" : "cloud"} version yet`);
  };
  const offEngine =
    mode === "both"
      ? []
      : generators.filter((n) => {
          const m = n.data.modelId ? getModel(n.data.modelId) : undefined;
          // A Fuobe Original runs on both engines: it's never off the install's engine.
          return m && !runsOn(m, mode);
        });
  const stuck = offEngine.filter((n) => !counterpart(graph, n, mode as Engine));
  const switchable = offEngine.length - stuck.length;

  // ---- the actions nodes call: one object for the editor's lifetime, always reaching the latest handlers
  const handlers = useRef<EditorActions | null>(null);
  useLayoutEffect(() => {
    handlers.current = {
      update,
      remove,
      duplicate,
      run,
      runGroup: (gid) => run(undefined, false, gid),
      patchClip,
      cancel: (nid) => void cancel(nid),
      open: (nid, index = 0) => setViewer({ nodeId: nid, index }),
      toInput,
      addInput,
      connect: (c) => onConnect({ source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? OUT, targetHandle: c.targetHandle ?? null }),
      disconnect,
      getGraph: () => toGraph(latest.current.nodes, latest.current.edges),
    };
  });
  const actions = useMemo<EditorActions>(
    () => ({
      update: (...a) => handlers.current!.update(...a),
      remove: (...a) => handlers.current!.remove(...a),
      duplicate: (...a) => handlers.current!.duplicate(...a),
      run: (...a) => handlers.current!.run(...a),
      runGroup: (...a) => handlers.current!.runGroup(...a),
      patchClip: (...a) => handlers.current!.patchClip(...a),
      cancel: (...a) => handlers.current!.cancel(...a),
      open: (...a) => handlers.current!.open(...a),
      toInput: (...a) => handlers.current!.toInput(...a),
      addInput: (...a) => handlers.current!.addInput(...a),
      connect: (...a) => handlers.current!.connect(...a),
      disconnect: (...a) => handlers.current!.disconnect(...a),
      getGraph: () => handlers.current!.getGraph(),
    }),
    [],
  );

  // What the keys call, as they are now (the listener below is added once).
  const keyHandlers = useRef({ runSelection, placeAtCentre });
  useLayoutEffect(() => {
    keyHandlers.current = { runSelection, placeAtCentre };
  });

  // ---- keyboard: ⌘↵ runs (the selection, else everything), ⌘D duplicates, ⌘G groups (⇧⌘G ungroups),
  // and the board tools by letter: V H D E N ⇧T R T C (Escape goes back to Select)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.altKey || isMobile || typing(e.target)) return;
        if (e.key === "Escape") return void setTool("select");
        // Enter with a tool that places something (a comment, a note, text…) places it in the middle of the view:
        // the keyboard's way to do what a click on the board does. On another button or a link Enter keeps its
        // meaning; on the chosen tool's own toolbar button, pressed again, it places.
        const el = e.target as HTMLElement | null;
        const ownTool = !!el?.closest?.("[role='toolbar'] button[aria-pressed='true']");
        if (e.key === "Enter" && PLACE_TOOLS.has(toolNow.current) && (ownTool || !el?.closest?.("button, a, [role='tab']"))) {
          e.preventDefault();
          return void keyHandlers.current.placeAtCentre(toolNow.current);
        }
        // ⇧T is the table (T alone writes text).
        const t = e.shiftKey && e.key.toLowerCase() === "t" ? "table" : TOOL_KEYS[e.key.toLowerCase()];
        if (!t || e.repeat) return;
        e.preventDefault();
        // R again cycles rectangle → ellipse → arrow.
        if (t === "shape" && toolNow.current === "shape") setShapeKind((k) => (k === "rect" ? "ellipse" : k === "ellipse" ? "arrow" : "rect"));
        setTool(t);
        return;
      }
      if (e.key.toLowerCase() === "g" && !typing(e.target)) {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        keyHandlers.current.runSelection(e.shiftKey);
      } else if (e.key.toLowerCase() === "d" && !(e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")) {
        const sel = latest.current.nodes.filter((n) => n.selected).map((n) => n.id);
        if (!sel.length) return;
        e.preventDefault();
        duplicate(sel);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duplicate, isMobile, groupSelection, ungroupSelection]);

  // ---- drop from the palette, or files from the desktop
  const onDragOver = (e: React.DragEvent) => {
    if (isMobile) return;
    if (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const itemId = e.dataTransfer.getData(DRAG_TYPE);
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (itemId) {
      e.preventDefault();
      const item = palette.find((p) => p.id === itemId);
      if (item) addNode(item, at);
      return;
    }
    const files = [...(e.dataTransfer.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    files.slice(0, 8).forEach((f, i) => {
      const kind: MediaKind | null = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : null;
      if (!kind) return void toast.error(`${f.name} isn't an image, video or audio file`);
      const item = palette.find((p) => p.type === KIND_INPUT[kind])!;
      const nid = addNode(item, { x: at.x + i * 32, y: at.y + i * 32 });
      if (nid) void fileToSlot(f, (v) => v && !v.uploading && update(nid, { url: v.ref, name: v.name }), kind);
    });
  };

  const addAtCenter = (item: PaletteItem) => {
    const rect = wrapper.current?.getBoundingClientRect();
    const at = rf.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2 - 140, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 100 });
    addNode(item, at);
  };

  /** Text prompt → image model → Output, wired (no dragging needed, so phones get it too). */
  const quickStart = () => {
    const rect = wrapper.current?.getBoundingClientRect();
    // Right of the palette, a little below the top.
    const at = rf.screenToFlowPosition({ x: (rect?.left ?? 0) + (isMobile ? 16 : paletteOpen ? 300 : 80), y: (rect?.top ?? 0) + 160 });
    const items = paletteItems();
    const p = addNode(items.find((i) => i.id === "prompt")!, at);
    const m = addNode(items.find((i) => i.id === "model-image")!, { x: at.x + 360, y: at.y - 40 });
    const o = addNode(items.find((i) => i.id === "output")!, { x: at.x + 720, y: at.y });
    if (!p || !m || !o) return;
    setEdges((es) => [...es, { id: newId("e"), source: p, sourceHandle: OUT, target: m, targetHandle: "prompt" }, { id: newId("e"), source: m, sourceHandle: OUT, target: o, targetHandle: PREVIEW_IN }]);
    setTimeout(() => void rf.fitView({ ...fitOptions, duration: 300 }), 60);
  };

  // ---- edges: coloured by what they carry, animated into running nodes. Rebuilt only when that
  // look changes (not on every keystroke), so React Flow doesn't re-render every edge.
  const edgeLook = edges
    .map((e) => {
      const src = byId.get(e.source);
      const r = results.get(e.target);
      return `${e.id}:${src ? typeOfNode(src) : ""}:${r?.state === "running" || r?.state === "queued" ? 1 : 0}`;
    })
    .join("|");
  const flowEdges = useMemo(
    () =>
      edges.map((e) => {
        const src = byId.get(e.source);
        const t = src ? typeOfNode(src) : null;
        const r = results.get(e.target);
        const live = r?.state === "running" || r?.state === "queued";
        return { ...e, animated: live, style: { stroke: t ? PORT_COLOR[t] : undefined, strokeWidth: e.selected ? 3 : 2 } };
      }),
    // byId and results are read through edgeLook (what the edges show of them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, edgeLook],
  );
  const miniColor = useCallback((n: FlowNode) => {
    if (n.type === "group") return "color-mix(in oklab, var(--muted-foreground) 18%, transparent)";
    if (n.type === "shape" || n.type === "comment") return "transparent";
    const t = typeOfNode(n);
    return t ? PORT_COLOR[t] : "var(--muted-foreground)";
  }, []);

  const viewerEntries = viewer ? (results.get(viewer.nodeId)?.outputs ?? []) : [];
  const entry = viewer ? viewerEntries[viewer.index] : undefined;
  const planDemo = plan.steps.some((s) => {
    const m = getModel(s.request.modelId);
    // A Fuobe Original's step names its engine: a demo is about that engine's providers.
    return m && isDemo(s.request.engine ? onEngine(m, s.request.engine) : m);
  });
  // A Translate (video) on an open-only install dubs in Translate & dub: nothing to fix on the board.
  const attention = new Set(plan.errors.filter((e) => e.message !== OPEN_DUB_HINT).map((e) => e.nodeId)).size;
  const summary = [
    // A visitor's board doesn't run here: no count of steps to run and no price, only what needs attention.
    visitor
      ? ""
      : plan.steps.length
        ? `${plan.steps.length} to run · ${planDemo ? "Placeholder · free" : plan.costUnknown ? "price unknown" : plan.costUsd === 0 ? "Free" : `≈ ${formatCost(plan.costUsd)}`}`
        : generators.length && !attention
          ? "Up to date"
          : "",
    attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // ---- what the header and the palette call: stable, so they skip the re-render a keystroke causes
  const uiHandlers = useRef<{
    run: typeof run;
    runSelection: typeof runSelection;
    switchEngine: typeof switchEngine;
    rename: typeof rename;
    addAtCenter: typeof addAtCenter;
    saveAsSkill: typeof saveAsSkill;
    snapshot: () => BoardNow;
  } | null>(null);
  useLayoutEffect(() => {
    uiHandlers.current = { run, runSelection, switchEngine, rename, addAtCenter, saveAsSkill, snapshot: () => ({ pages: docOf(), name: name.trim() || savedName.current }) };
  });
  const ui = useMemo<HeaderUi>(
    () => ({
      saveAsSkill: () => void uiHandlers.current!.saveAsSkill(),
      run: (targets, force) => uiHandlers.current!.run(targets, force),
      runSelected: (force) => uiHandlers.current!.runSelection(force),
      switchEngine: (e) => uiHandlers.current!.switchEngine(e),
      rename: (v) => void uiHandlers.current!.rename(v),
      addAtCenter: (p) => uiHandlers.current!.addAtCenter(p),
      snapshot: () => uiHandlers.current!.snapshot(),
    }),
    [],
  );
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const otherEngineName = mode === "open" ? "cloud" : "open-source";
  const stuckNames = stuck.map((n) => `“${nodeLabel(n)}”`);

  return (
    <EditorStoreContext.Provider value={store}>
      <EditorActionsContext.Provider value={actions}>
        <div className="fuobe-canvas flex h-content min-w-0 flex-col">
          <EditorHeader
            name={name}
            setName={setName}
            saveState={saveState}
            saveRefused={saveRefused}
            busy={busy}
            summary={summary}
            boardEngine={boardEngine}
            selectedCount={isMobile ? 0 : selected.length}
            running={runM.isPending}
            canRun={generators.length > 0 || graph.nodes.some((n) => n.type === "kinetic")}
            mode={mode}
            ui={ui}
            visitor={visitor}
          />
          {visitor?.note}

          {isMobile && (
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              <TabRow role="tablist" aria-label="View" fade={false}>
                {(["board", "list"] as const).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={TAB_PILL} {...onAttr(tab === t)}>
                    {t === "board" ? <LayoutGrid aria-hidden /> : <List aria-hidden />}
                    {t === "board" ? "Board" : "Nodes"}
                  </button>
                ))}
              </TabRow>
              {pages.length > 1 && (
                <select value={pageId} onChange={(e) => pageOps.switchTo(e.target.value)} aria-label="Page" className="h-9 max-w-32 shrink-0 truncate rounded-full bg-muted px-3 text-[13px] font-medium outline-none">
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{busy ? `${busy} running` : summary}</span>
            </div>
          )}

          {offEngine.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-highlight/20 px-4 py-2 text-[13px]">
              <TriangleAlert className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                {offEngine.length} node{offEngine.length > 1 ? "s use" : " uses"} {otherEngineName} models, which aren&apos;t available here.
                {stuck.length > 0 && (
                  <>
                    {" "}
                    {stuckNames.join(", ")} {stuck.length > 1 ? "have" : "has"} no {mode === "open" ? "open-source" : "cloud"} version yet: remove {stuck.length > 1 ? "them" : "it"}, or change Settings → Engine mode.
                  </>
                )}
              </span>
              {switchable > 0 && (
                <Button size="sm" variant="secondary" className="h-7 rounded-full" onClick={() => switchEngine(mode as Engine)}>
                  Switch {switchable > 1 ? `${switchable} nodes` : stuck.length ? "the other" : "it"}
                </Button>
              )}
            </div>
          )}

          {isMobile && tab === "list" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NodeList
                onQuickStart={() => {
                  setTab("board");
                  setTimeout(quickStart, 0);
                }}
              />
            </div>
          ) : (
            <div
              ref={wrapper}
              className="relative min-h-0 flex-1"
              // The page tabs' panel (desktop): the board of the open page.
              {...(!isMobile && { id: PAGE_PANEL_ID, role: "tabpanel", "aria-labelledby": pageTabId(pageId) })}
              data-tool={isMobile ? undefined : tool}
              onPointerDownCapture={onToolPointerDown}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDoubleClick={(e) => {
                if (isMobile || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
                openMenuAt(e.clientX, e.clientY);
              }}
            >
              <ReactFlow<FlowNode, Edge>
                nodes={nodes}
                edges={flowEdges}
                nodeTypes={NODE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onConnectEnd={onConnectEnd}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
                isValidConnection={isValidConnection}
                onPaneContextMenu={(e) => {
                  e.preventDefault();
                  if (!isMobile) openMenuAt(e.clientX, e.clientY);
                }}
                onPaneClick={() => setMenu(null)}
                onMoveEnd={(_, vp) => {
                  // The phone's fitted view isn't saved over the desktop one.
                  if (isMobile) return;
                  viewport.current = vp;
                  touch();
                }}
                defaultViewport={savedViewport}
                fitViewOptions={fitOptions}
                minZoom={0.15}
                maxZoom={2}
                snapToGrid
                snapGrid={GRID}
                zoomOnDoubleClick={false}
                deleteKeyCode={isMobile ? null : ["Backspace", "Delete"]}
                multiSelectionKeyCode={["Meta", "Shift", "Control"]}
                // Select (V): a drag on the board draws a selection box; scrolling, Space-drag or the middle button pans. Pan (H): a
                // drag moves the board. The drawing tools take the pointer themselves (onToolPointerDown).
                panOnDrag={isMobile || tool === "hand" ? true : tool === "select" ? PAN_MIDDLE : false}
                // Scrolling (two fingers on a trackpad) pans; pinch or ⌘/Ctrl-scroll zooms.
                panOnScroll={!isMobile}
                selectionOnDrag={!isMobile && tool === "select"}
                selectionMode={SelectionMode.Partial}
                elementsSelectable={isMobile || tool !== "hand"}
                nodesDraggable={!isMobile && tool === "select"}
                nodesConnectable={!isMobile}
                // Tab goes node to node (each node's menu connects and disconnects from the keyboard).
                edgesFocusable={false}
                connectionRadius={28}
                colorMode={resolvedTheme === "dark" ? "dark" : "light"}
                attributionPosition="top-right"
                aria-label="Canvas board"
              >
                <Background variant={BackgroundVariant.Dots} gap={GRID[0] * 1.5} size={1.4} />
                <Controls position="bottom-left" showInteractive={false} className="canvas-controls" fitViewOptions={fitOptions} />
                {!isMobile && <MiniMap position="bottom-right" pannable zoomable ariaLabel="Mini map" nodeBorderRadius={6} nodeColor={miniColor} />}
                {!isMobile && (
                  <Panel position="top-left" className="m-3! flex max-h-[calc(100%-7rem)] flex-col">
                    {paletteOpen ? <Palette items={palette} onAdd={ui.addAtCenter} onClose={closePalette} /> : <PaletteToggle onOpen={() => setPaletteOpen(true)} />}
                  </Panel>
                )}
                {!isMobile && (
                  <Panel position="top-center" className="m-3! max-w-[min(560px,calc(100%-34rem))] min-w-0">
                    <PageTabs pages={pages} active={pageId} ops={pageOps} readOnly={false} />
                  </Panel>
                )}
                {!isMobile && (
                  <Panel position="bottom-center" className="m-3!">
                    <BoardToolbar tool={tool} setTool={setTool} shape={shapeKind} setShape={setShapeKind} ink={ink} setInk={setInk} selected={selectedForGroup} onGroup={groupSelection} />
                  </Panel>
                )}
              </ReactFlow>
              {stroke && (
                <svg className="pointer-events-none absolute inset-0 z-10 size-full" aria-hidden>
                  {stroke.kind === "draw" ? (
                    <polyline points={stroke.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={BOARD_COLOR_VAR[ink]} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
                  ) : shapeKind === "arrow" ? (
                    <line x1={stroke.points[0].x} y1={stroke.points[0].y} x2={stroke.points[1].x} y2={stroke.points[1].y} stroke={BOARD_COLOR_VAR[ink]} strokeWidth={2.5} strokeLinecap="round" />
                  ) : shapeKind === "ellipse" ? (
                    <ellipse cx={(stroke.points[0].x + stroke.points[1].x) / 2} cy={(stroke.points[0].y + stroke.points[1].y) / 2} rx={Math.abs(stroke.points[1].x - stroke.points[0].x) / 2} ry={Math.abs(stroke.points[1].y - stroke.points[0].y) / 2} fill="none" stroke={BOARD_COLOR_VAR[ink]} strokeWidth={2} strokeDasharray="6 4" />
                  ) : (
                    <rect x={Math.min(stroke.points[0].x, stroke.points[1].x)} y={Math.min(stroke.points[0].y, stroke.points[1].y)} width={Math.abs(stroke.points[1].x - stroke.points[0].x)} height={Math.abs(stroke.points[1].y - stroke.points[0].y)} rx={8} fill="none" stroke={BOARD_COLOR_VAR[ink]} strokeWidth={2} strokeDasharray="6 4" />
                  )}
                </svg>
              )}

              {nodes.length === 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
                  <div className="pointer-events-auto max-w-md text-center">
                    <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">Build freely. Automate visually.</p>
                    <h2 className="mt-2 font-heading text-[28px] leading-tight text-balance">Wire models together, run them in order</h2>
                    <p className="mt-2 text-[14px] text-muted-foreground">
                      {isMobile
                        ? "Start with a ready-made chain or a template, then edit each node from the Nodes tab. Wiring new nodes takes a larger screen."
                        : "Double-click or right-click anywhere to add a node, or drag one in from the palette."}
                    </p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      <Button className="rounded-full" onClick={quickStart}>
                        <Sparkles /> Start with Text → Image
                      </Button>
                      <Button variant="secondary" className="rounded-full" asChild>
                        <Link href="/canvas?tab=templates">Browse templates</Link>
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {menu && (
                <AddMenu
                  x={menu.x}
                  y={menu.y}
                  items={menuItems}
                  title={menu.connect ? (menu.connect.from === "source" ? `Send this ${menu.connect.type} to…` : `Make the ${menu.connect.type} with…`) : undefined}
                  onPick={(p) => {
                    addNode(p, menu.flow, menu.connect);
                    setMenu(null);
                  }}
                  onClose={() => setMenu(null)}
                />
              )}
            </div>
          )}
        </div>
        {entry && (
          <Viewer
            generation={entry.g}
            index={entry.i}
            onClose={() => setViewer(null)}
            onPrev={viewer!.index > 0 ? () => setViewer({ ...viewer!, index: viewer!.index - 1 }) : undefined}
            onNext={viewer!.index < viewerEntries.length - 1 ? () => setViewer({ ...viewer!, index: viewer!.index + 1 }) : undefined}
          />
        )}
      </EditorActionsContext.Provider>
    </EditorStoreContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Header: name, save state, plan summary, engine, Run. Memoized with stable handlers, so typing on
// the board doesn't re-render its menus and tooltips.

interface HeaderUi {
  /** The review screen for a skill made from this page of the canvas (W5), once the board is saved. */
  saveAsSkill: () => void;
  run: (targets?: string[], force?: boolean) => void;
  runSelected: (force?: boolean) => void;
  switchEngine: (e: Engine) => void;
  rename: (name: string) => void;
  addAtCenter: (p: PaletteItem) => void;
  snapshot: () => BoardNow;
}

const EditorHeader = memo(function EditorHeader({
  name,
  setName,
  saveState,
  saveRefused,
  busy,
  summary,
  boardEngine,
  selectedCount,
  running,
  canRun,
  mode,
  ui,
  visitor,
}: {
  name: string;
  setName: (v: string) => void;
  saveState: SaveState;
  saveRefused: boolean;
  busy: number;
  summary: string;
  boardEngine: Engine;
  selectedCount: number;
  running: boolean;
  canRun: boolean;
  mode: EngineMode;
  ui: HeaderUi;
  visitor?: VisitorHost;
}) {
  const mod = useModKey();
  const savedText = visitor?.savedLabel ?? "Saved";
  return (
    <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href="/canvas" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="All canvases">
            <ChevronLeft className="size-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent>All canvases</TooltipContent>
      </Tooltip>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={(e) => ui.rename(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        maxLength={80}
        aria-label="Canvas name"
        className="h-9 w-0 min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 font-heading text-[20px] leading-none outline-none hover:bg-accent focus:bg-muted sm:max-w-[320px] sm:flex-none sm:w-[min(320px,30vw)]"
      />
      <span className={cn("shrink-0 items-center gap-1 text-[12px] text-muted-foreground", saveState === "error" ? "inline-flex" : "hidden sm:inline-flex")} aria-live="polite">
        {saveState === "saving" ? <Loader2 className="size-3 animate-spin" /> : saveState === "error" ? <TriangleAlert className="size-3 text-warning" /> : <Check className="size-3" />}
        <span className={cn(saveState === "error" && "max-sm:sr-only")}>{saveState === "saving" ? "Saving…" : saveState === "error" ? (saveRefused ? "Not saved" : "Not saved — retrying") : savedText}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {busy > 0 && (
          <span className="hidden items-center gap-1.5 text-[12px] font-medium text-brand-text lg:inline-flex">
            <Loader2 className="size-3.5 animate-spin" /> {busy} running
          </span>
        )}
        {summary && <span className="hidden font-mono text-[12px] text-muted-foreground lg:inline">{summary}</span>}
        <div className="hidden md:block">
          <EngineSwitch value={boardEngine} onChange={ui.switchEngine} size="sm" />
        </div>
        {visitor ? (
          <>
            {visitor.action?.(ui.snapshot)}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="secondary" className="h-8 rounded-full px-3" onClick={() => ui.run()} disabled={!canRun} data-visitor-run>
                  <Play /> Run
                </Button>
              </TooltipTrigger>
              <TooltipContent>What running a board needs</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
        {selectedCount > 0 && (
          <Button variant="secondary" size="sm" className="h-8 rounded-full px-3" onClick={() => ui.runSelected()} disabled={running}>
            <Play /> Run selected <span className="font-mono text-muted-foreground">{selectedCount}</span>
          </Button>
        )}
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" className="h-8 rounded-l-full rounded-r-none pr-2.5 pl-3.5" onClick={() => ui.run()} disabled={running || !canRun}>
                {running ? <Loader2 className="animate-spin" /> : <Play />} Run all
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Run every node that changed <Kbd>{mod}</Kbd>
              <Kbd>↵</Kbd>
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-8 rounded-l-none rounded-r-full border-l border-primary-foreground/20 px-2" aria-label="More run options" disabled={!canRun}>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => ui.run()}>
                <Play /> Run all <span className="ml-auto text-[11px] text-muted-foreground">changed nodes</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ui.run(undefined, true)}>
                <RotateCcw /> Re-run everything
              </DropdownMenuItem>
              {selectedCount > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => ui.runSelected()}>
                    <Play /> Run selected ({selectedCount})
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => ui.runSelected(true)}>
                    <RotateCcw /> Re-run selected
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={mode === "cloud"} onSelect={() => ui.switchEngine("open")}>
                <Cpu /> Switch all to open source
              </DropdownMenuItem>
              <DropdownMenuItem disabled={mode === "open"} onSelect={() => ui.switchEngine("cloud")}>
                <Cloud /> Switch all to cloud
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => ui.saveAsSkill()}>
                <BookmarkPlus /> Save as skill…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
          </>
        )}
      </div>
      <PhoneNavButton />
    </header>
  );
});
