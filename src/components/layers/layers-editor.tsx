"use client";

import { Check, Loader2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState, NotFoundState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CompareSlider } from "@/components/studio/compare-slider";
import { useIsMobile } from "@/hooks/use-mobile";
import { useEngine, useModelAccess, useStatus } from "@/lib/api";
import { keepOffered, offered } from "@/lib/model-access";
import {
  APPLIES_TO_DOC,
  decomposeCost,
  deleteNode,
  duplicateNode,
  getNode,
  historyReducer,
  LayerLimitError,
  nativeSize,
  roomFor,
  TOOL_LABELS,
  TOOL_MODELS,
  updateNode,
  type Box,
  type LayerDoc,
  type LayerJob,
  type LayerModelInfo,
  type LayerNode,
  type LayerProjectView,
  type LayerTool,
} from "@/lib/layers";
import { toastError } from "@/lib/refusals";
import { applyMeasured, idPool, type Applied } from "./apply";
import { costLabel, Ctx, isFailed, isRunning, keysBelongElsewhere, latestJob, TOOL_FOR_JOB, type EditorCtx, type MaskEdit, type PaintEdit, type RunInput, type StageMode, type ToolId } from "./editor-context";
import { LayersPanel } from "./layers-panel";
import { measureJob } from "./measure";
import { MobileView } from "./mobile-view";
import { loadImage, ratioOf, renderDoc, renderNative, renderSource, toBlob, uploadDerived, uploadRender } from "./render";
import { Stage } from "./stage";
import { ToolRail } from "./tools";
import { TopBar, type SaveState } from "./top-bar";
import { LayersRequestError, saveCover, saveDoc, useLayerActions, useLayerProject } from "./use-layers";

/** Focus is on a control that uses the arrow keys itself. */
const widget = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('[role="radio"],[role="slider"],[role="menuitem"],[role="menu"],[role="tab"],[role="option"],[role="dialog"],[data-reorder]');

/** The document is still just the image it was opened on (models can take the original file as is). */
function pristine(doc: LayerDoc): boolean {
  if (doc.nodes.length !== 1) return false;
  const n = doc.nodes[0];
  return n.src === doc.source && !n.crop && !n.maskSrc && !n.feather && !n.rotation && !n.hidden && (n.opacity ?? 1) === 1 && n.x === 0 && n.y === 0 && n.w === doc.width && n.h === doc.height;
}

/** A layer whose file is exactly what it shows. */
const plain = (n: LayerNode) => !n.crop && !n.maskSrc && !n.feather;

/** Tools whose failures a layer row shows (a text detection's shows in Edit text). */
const NODE_TOOLS = (Object.keys(TOOL_FOR_JOB) as LayerTool[]).filter((t) => t !== "text-detect");

/** Autosave retries after a failure (then every 15 s). */
const RETRY_MS = [2000, 5000, 15000];

function EditorSkeleton() {
  return (
    <div className="flex h-content min-w-0 flex-col overflow-hidden">
      <div className="flex h-14 items-center gap-3 border-b px-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="ml-auto h-8 w-64 rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[280px] space-y-2 border-r p-3 md:block">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-11 rounded-lg" />
          ))}
        </div>
        <div className="grid flex-1 place-items-center bg-muted/40">
          <Skeleton className="aspect-[4/3] w-1/2 rounded-sm" />
        </div>
        <div className="hidden w-[300px] space-y-2 border-l p-3 md:block">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LayersEditor({ id, models }: { id: string; models: Record<string, LayerModelInfo> }) {
  const q = useLayerProject(id);
  if (q.data) return <Editor key={id} view={q.data} refetch={q.refetch} models={models} />;
  if (q.error) {
    if (q.error instanceof LayersRequestError && q.error.status === 404) {
      return <NotFoundState title="This project doesn't exist">It may have been deleted. The images it was opened on are still in your library.</NotFoundState>;
    }
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  }
  return <EditorSkeleton />;
}

function Editor({ view, refetch, models }: { view: LayerProjectView; refetch: () => Promise<{ data?: LayerProjectView }>; models: Record<string, LayerModelInfo> }) {
  // The document is the editor's once loaded; later fetches bring jobs and versions.
  const [initial] = useState(view);
  const id = initial.project.id;
  const actions = useLayerActions();
  const isMobile = useIsMobile();
  const [engine, setEngine] = useEngine();
  const status = useStatus().data;

  const [hist, dispatch] = useReducer(historyReducer, initial.doc, (doc) => ({ past: [], present: doc, future: [] }));
  const doc = hist.present;
  const docRef = useRef(doc);
  const histRef = useRef(hist);
  useLayoutEffect(() => {
    docRef.current = doc;
    histRef.current = hist;
  }, [doc, hist]);
  const headRef = useRef(initial.headVersionId);
  const [head, setHeadState] = useState(initial.headVersionId);
  const setHead = useCallback((v: string) => {
    headRef.current = v;
    setHeadState(v);
  }, []);
  const savedRef = useRef<LayerDoc>(initial.doc);
  const [save, setSave] = useState<SaveState>("saved");
  /** The document a tool's version was saved with: undoing past it saves a new version (the tool's keeps its result). */
  const milestone = useRef<LayerDoc | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = getNode(doc, selectedId);
  const decomposed = doc.decomposed || view.project.decomposed;
  const [tool, setTool] = useState<ToolId | null>(() => (!initial.doc.decomposed && !initial.project.decomposed && initial.doc.nodes.length === 1 ? "decompose" : null));
  const [splitTarget, setSplitTarget] = useState<string | null>(null);
  const [mode, setModeState] = useState<StageMode>("select");
  const [region, setRegion] = useState<Box | null>(null);
  const [frame, setFrame] = useState<Box | null>(null);
  const [highlight, setHighlight] = useState<Box | null>(null);
  const [previews, setPreviews] = useState<Map<string, HTMLCanvasElement>>(() => new Map());
  const [mask, setMask] = useState<MaskEdit | null>(null);
  const [maskVersion, setMaskVersion] = useState(0);
  const [paint, setPaint] = useState<PaintEdit | null>(null);
  const [paintVersion, setPaintVersion] = useState(0);
  const [brushSize, setBrushSize] = useState(() => Math.round(Math.max(initial.doc.width, initial.doc.height) / 30));
  const [compare, setCompare] = useState(false);
  const toolRef = useRef(tool);
  const selectedRef = useRef(selectedId);
  useLayoutEffect(() => {
    toolRef.current = tool;
    selectedRef.current = selectedId;
  }, [tool, selectedId]);

  const commit = useCallback((d: LayerDoc, merge?: string) => dispatch({ type: "commit", doc: d, merge, at: Date.now() }), []);
  const resetTo = useCallback(
    (v: LayerProjectView) => {
      setHead(v.headVersionId);
      savedRef.current = v.doc;
      docRef.current = v.doc;
      milestone.current = null;
      dispatch({ type: "reset", doc: v.doc });
      setSave("saved");
    },
    [setHead],
  );

  // ---- Writes to the server (autosaves, tool results, restores) run one at a time, so they never
  // cross: a result saved as a version can't be overwritten by an autosave started before it.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = writes.current.then(fn);
    writes.current = p.catch(() => {});
    return p;
  }, []);

  // ---- Autosave into the head version (debounced; retried with backoff; flushed with keepalive when leaving).
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The newest saveNow, for its own retries. */
  const saveAgain = useRef<() => Promise<void>>(() => Promise.resolve());
  const saveNow = useCallback(
    (): Promise<void> =>
      serial(async () => {
        if (retry.current) clearTimeout(retry.current);
        retry.current = null;
        const d = docRef.current;
        if (d === savedRef.current) {
          setSave((s) => (s === "conflict" ? s : "saved"));
          return;
        }
        setSave("saving");
        try {
          if (milestone.current && histRef.current.future.includes(milestone.current)) {
            // Undone past a tool's result: that version keeps the result; this becomes a new one.
            const v = await actions.version(id, { doc: d, label: "Edit" });
            setHead(v.headVersionId);
            milestone.current = null;
          } else {
            await saveDoc(id, d, headRef.current);
          }
          savedRef.current = d;
          if (failures.current) toast.dismiss("layers-save");
          failures.current = 0;
          setSave(docRef.current === d ? "saved" : "dirty");
        } catch (e) {
          if (e instanceof LayersRequestError && e.status === 409) {
            setSave("conflict");
            toast.error(e.message, { id: "layers-conflict", action: { label: "Reload", onClick: () => void refetch().then((r) => r.data && resetTo(r.data)) } });
            return;
          }
          setSave("error");
          const n = failures.current++;
          if (n >= 2) toast.error("Your latest changes aren't saved yet", { id: "layers-save", description: `${(e as Error).message || "The server didn't answer"}. Fuobe keeps trying.`, duration: 10_000 });
          retry.current = setTimeout(() => void saveAgain.current(), RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
        }
      }),
    [serial, actions, id, setHead, refetch, resetTo],
  );
  useLayoutEffect(() => {
    saveAgain.current = saveNow;
  }, [saveNow]);
  useEffect(() => {
    if (doc === savedRef.current) {
      setSave((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    setSave((s) => (s === "conflict" || s === "error" ? s : "dirty"));
    const t = setTimeout(() => void saveNow(), 700);
    return () => clearTimeout(t);
  }, [doc, saveNow]);
  useEffect(() => {
    const flush = () => {
      const d = docRef.current;
      if (d !== savedRef.current) void saveDoc(id, d, headRef.current, true).catch(() => {});
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      if (retry.current) clearTimeout(retry.current);
      flush();
    };
  }, [id]);

  // ---- The project card's cover follows the composite (a small JPEG, a few seconds after edits settle).
  useEffect(() => {
    if (doc === initial.doc) return;
    let gone = false;
    const t = setTimeout(async () => {
      try {
        const c = await renderDoc(doc, { scale: Math.min(1, 360 / Math.max(doc.width, doc.height)), fill: "#ffffff" });
        if (!gone) await saveCover(id, c.toDataURL("image/jpeg", 0.8));
      } catch {
        // The card keeps its last cover.
      }
    }, 2500);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [doc, id, initial.doc]);

  // ---- Selection changes end mask editing and per-layer previews.
  const select = useCallback((nid: string | null) => {
    setSelectedId(nid);
    setModeState((m) => (m === "brush" || m === "eraser" ? "select" : m));
    setMask((m) => (m && m.nodeId !== nid ? null : m));
  }, []);

  const openTool = useCallback((t: ToolId | null) => {
    setTool(t);
    if (t !== "decompose") setSplitTarget(null);
  }, []);

  // ---- Jobs: start, and lay out their results as they land.
  const busyJob = useCallback(
    (nodeId: string) => view.jobs.find((j) => j.nodeId === nodeId && j.tool !== "text-detect" && j.state === "pending" && !isFailed(j)),
    [view.jobs],
  );
  const failedJob = useCallback(
    (nodeId: string) => {
      const j = latestJob(view.jobs, NODE_TOOLS, nodeId);
      return j && isFailed(j) && j.result?.status === "failed" ? j : undefined;
    },
    [view.jobs],
  );
  const showJob = useCallback(
    (j: LayerJob) => {
      const node = getNode(docRef.current, j.nodeId);
      select(node ? node.id : null);
      const t = TOOL_FOR_JOB[j.tool];
      if (!t) return;
      setTool(t);
      setSplitTarget(j.tool === "split" && node ? node.id : null);
    },
    [select],
  );

  const run = useCallback<EditorCtx["run"]>(
    async (input: RunInput) => {
      const d = docRef.current;
      const { target, image: given, frame: givenFrame, ...rest } = input;
      try {
        let image = given;
        let jobFrame = givenFrame;
        let aspect: string | undefined;
        const needsImage = input.tool !== "generate-layer" && input.tool !== "rerender";
        if (target.kind === "node") {
          const n = target.node;
          jobFrame ??= [n.x, n.y, n.w, n.h];
          if (!image && needsImage) {
            if (plain(n)) image = n.src;
            else image = await uploadRender(await renderNative(n), `layers-${n.name}`);
          }
          const [w, h] = nativeSize(n, 1e9);
          aspect = ratioOf(w, h);
        } else if (target.kind === "region") {
          jobFrame ??= target.rect;
          if (!image) image = await uploadRender(await renderDoc(d, { rect: target.rect, scale: Math.min(1, 2048 / Math.max(target.rect[2], target.rect[3])) }), "layers-region");
          aspect = ratioOf(target.rect[2], target.rect[3]);
        } else {
          jobFrame ??= [0, 0, d.width, d.height];
          if (!image && needsImage) image = pristine(d) ? d.source : await uploadRender(await renderDoc(d, { scale: Math.min(1, 4096 / Math.max(d.width, d.height)) }), "layers-composite");
          aspect = ratioOf(d.width, d.height);
        }
        return await actions.startJob(id, {
          ...rest,
          engine,
          image,
          frame: jobFrame,
          nodeId: target.kind === "node" ? target.node.id : undefined,
          settings: { aspect, ...rest.settings },
        });
      } catch (e) {
        toastError(e, "Could not start the tool");
        return null;
      }
    },
    [actions, engine, id],
  );

  const endJob = useCallback<EditorCtx["endJob"]>(
    (jobId, how) => void actions.endJob(id, jobId, how).catch((e) => toastError(e)),
    [actions, id],
  );

  // A finished result is measured (its images loaded) first, then laid out on the document as it is
  // right before its version is saved, and once more on the newest document if you edited meanwhile.
  const applying = useRef(new Set<string>());
  useEffect(() => {
    for (const j of view.jobs) {
      if (j.state !== "pending" || j.result?.status !== "succeeded" || !APPLIES_TO_DOC.has(j.tool) || applying.current.has(j.id)) continue;
      applying.current.add(j.id);
      const fail = (e: unknown) => {
        toast.error(`Couldn't add the result to your layers: ${(e as Error).message}`);
        endJob(j.id, "dismiss");
      };
      void measureJob(j).then(
        (measured) =>
          serial(async () => {
            const ids = idPool(() => nanoid(8));
            const at = Date.now();
            const base = docRef.current;
            let res: Applied;
            try {
              res = applyMeasured(base, j, measured, { newId: ids(), at });
            } catch (e) {
              fail(e);
              return;
            }
            try {
              const v = await actions.version(id, { doc: res.doc, label: j.label, jobId: j.id });
              setHead(v.headVersionId);
              savedRef.current = res.doc;
              if (docRef.current !== base) {
                // Edited while the version saved: lay the result out on the newest document (the same
                // new layer ids); the autosave then puts it into the new version.
                try {
                  res = applyMeasured(docRef.current, j, measured, { newId: ids(), at });
                } catch {
                  // The newest document can't take it (e.g. the layer limit): keep the saved one.
                }
              }
              milestone.current = res.doc;
              docRef.current = res.doc;
              dispatch({ type: "commit", doc: res.doc });
              // Select the result unless you've moved on to another layer meanwhile.
              const sel = selectedRef.current;
              if (res.select && (!sel || sel === j.nodeId || !getNode(res.doc, sel))) setSelectedId(res.select);
              if (j.tool === "split") setSplitTarget(null);
              toast.success(res.message, { duration: 2500 });
            } catch (e) {
              if (e instanceof LayersRequestError && e.status === 409) {
                // Another tab laid it out first: take the saved version.
                const r = await refetch();
                if (r.data) resetTo(r.data);
              } else fail(e);
            }
          }),
        fail,
      );
    }
  }, [view.jobs, actions, id, refetch, resetTo, endJob, setHead, serial]);

  // ---- Failures are told once, wherever you are (the tool's form or the layer's card shows them too).
  const told = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!told.current) {
      // Failures from before this visit show on their layers and forms, without a toast each.
      told.current = new Set(view.jobs.filter(isFailed).map((j) => j.id));
      return;
    }
    for (const j of view.jobs) {
      if (!isFailed(j) || told.current.has(j.id)) continue;
      told.current.add(j.id);
      if (j.result?.status !== "failed") continue; // canceled: you asked for it
      const node = getNode(docRef.current, j.nodeId);
      const form = TOOL_FOR_JOB[j.tool];
      const scope = (j.nodeId ?? null) === selectedRef.current;
      // Already in view: the open form (or the selected layer's card) shows the failure.
      if (scope && (form ? toolRef.current === form : j.tool === "regenerate")) continue;
      toast.error(`${TOOL_LABELS[j.tool]} failed${node ? ` on ${node.name}` : ""}`, {
        id: `layers-failed-${j.id}`,
        description: j.result.error ?? "The model didn't finish.",
        ...(form || node ? { action: { label: "View", onClick: () => showJob(j) } } : {}),
      });
    }
  }, [view.jobs, showJob]);

  // ---- Masks (brush paints the layer back, eraser hides it).
  const setMode = useCallback((m: StageMode) => {
    setModeState(m);
    if (m !== "brush" && m !== "eraser") setMask(null);
  }, []);
  useEffect(() => {
    if ((mode !== "brush" && mode !== "eraser") || !selected) return;
    if (mask?.nodeId === selected.id) return;
    let gone = false;
    const node = selected;
    void (async () => {
      const [w, h] = nativeSize(node, 1024);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      if (node.maskSrc) {
        try {
          ctx.drawImage(await loadImage(node.maskSrc), 0, 0, w, h);
        } catch {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
        }
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      if (!gone) setMask({ nodeId: node.id, canvas: c, size: w, version: 0 });
    })();
    return () => {
      gone = true;
    };
  }, [mode, selected, mask?.nodeId]);
  const [savingMask, setSavingMask] = useState(false);
  const finishMask = async () => {
    if (!mask) return;
    setSavingMask(true);
    try {
      const url = await uploadDerived(await toBlob(mask.canvas), "layer-mask");
      commit(updateNode(docRef.current, mask.nodeId, { maskSrc: url }));
      toast.success("Mask saved", { duration: 1500 });
      setMode("select");
    } catch (e) {
      toastError(e);
    } finally {
      setSavingMask(false);
    }
  };

  const setPreview = useCallback((pid: string, c: HTMLCanvasElement | null) => {
    setPreviews((old) => {
      if (!c && !old.has(pid)) return old;
      const next = new Map(old);
      if (c) next.set(pid, c);
      else next.delete(pid);
      return next;
    });
  }, []);

  // ---- Keyboard (never behind a dialog, a menu or in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysBelongElsewhere(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      const d = docRef.current;
      const sel = getNode(d, selectedId);
      if (mod && e.key.toLowerCase() === "d" && sel) {
        e.preventDefault();
        if (e.repeat) return;
        if (!roomFor(d)) toast.error(new LayerLimitError().message, { id: "layers-limit" });
        else commit(duplicateNode(d, sel.id, nanoid(8)));
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "Escape") {
        if (mode === "brush" || mode === "eraser") setMode("select");
        // Inpaint's paint belongs to the layer it's on: Escape doesn't drop it.
        else if (mode !== "inpaint") select(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (busyJob(sel.id)) toast.error("Can't delete while this layer is generating");
        else {
          commit(deleteNode(d, sel.id));
          select(null);
        }
        return;
      }
      // Arrow keys belong to the control that has focus (segmented controls, sliders, menus, the reorder handle).
      if (sel && e.key.startsWith("Arrow") && !widget(e.target)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commit(updateNode(d, sel.id, { x: sel.x + dx, y: sel.y + dy }), `nudge:${sel.id}`);
        return;
      }
      const k = e.key.toLowerCase();
      // Inpaint is open: B paints the area, E erases paint.
      if (paint && (k === "b" || k === "e")) {
        setPaint((p) => (p ? { ...p, erase: k === "e" } : p));
        setMode("inpaint");
        return;
      }
      if (k === "v") setMode("select");
      else if (k === "h") setMode("hand");
      else if ((k === "b" || k === "e") && sel) setMode(k === "b" ? "brush" : "eraser");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, mode, commit, select, setMode, busyJob, paint]);

  // ---- Compare: the original, where it sits in the document now, against the current composite.
  const [pair, setPair] = useState<{ before: string; after: string } | null>(null);
  useEffect(() => {
    if (!compare) return;
    const urls: string[] = [];
    let gone = false;
    const scale = Math.min(1, 1600 / Math.max(doc.width, doc.height));
    void Promise.all([renderSource(doc, scale), renderDoc(doc, { scale })])
      .then((cs) => Promise.all(cs.map((c) => toBlob(c))))
      .then(([b, a]) => {
        if (gone) return;
        urls.push(URL.createObjectURL(b), URL.createObjectURL(a));
        setPair({ before: urls[0], after: urls[1] });
      })
      .catch(() => toast.error("Couldn't render the comparison"));
    return () => {
      gone = true;
      for (const u of urls) URL.revokeObjectURL(u);
      setPair(null);
    };
  }, [compare, doc]);

  const access = useModelAccess();
  const offeredIds = useCallback((ids: readonly string[]) => keepOffered(ids, (x) => offered(access, x, engine)), [access, engine]);
  const isDemo = useCallback(
    (m: LayerModelInfo | undefined) => {
      if (!m || !status) return false;
      if (status.demoMode === "on") return true;
      if (status.demoMode === "off") return false;
      return !m.providers.some((p) => status.providers[p]?.configured);
    },
    [status],
  );

  const busy = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of view.jobs) if (j.nodeId && j.state === "pending" && isRunning(j)) m.set(j.nodeId, j.tool === "split" ? "Separating…" : `${j.label}…`);
    return m;
  }, [view.jobs]);

  const sources = useMemo(() => ({ masks: mask ? new Map([[mask.nodeId, mask.canvas]]) : undefined, maskVersion, previews }), [mask, maskVersion, previews]);
  const overlay = useMemo<LayerNode[] | undefined>(() => {
    if (!previews.has("__whole")) return undefined;
    return [{ id: "__whole", name: "Preview", z: 1e6, x: 0, y: 0, w: doc.width, h: doc.height, rotation: 0, src: doc.source, revisions: [], revision: 0 }];
  }, [previews, doc.width, doc.height, doc.source]);

  const ctx: EditorCtx = {
    projectId: id,
    project: view.project,
    versions: view.versions,
    headVersionId: head,
    doc,
    commit,
    selectedId,
    selected,
    select,
    engine,
    models,
    offeredIds,
    isDemo,
    jobs: view.jobs,
    busyJob,
    failedJob,
    showJob,
    decomposed,
    run,
    endJob,
    mode,
    setMode,
    region,
    setRegion,
    frame,
    setFrame,
    mask,
    paint,
    setPaint,
    paintVersion,
    brushSize,
    setBrushSize,
    setHighlight,
    setPreview,
    tool,
    openTool,
    splitTarget,
    setSplitTarget,
  };

  if (isMobile) {
    const modelId = offeredIds(TOOL_MODELS.decompose[engine])[0];
    const model = models[modelId];
    return (
      <MobileView
        project={view.project}
        doc={doc}
        jobs={view.jobs}
        decomposed={decomposed}
        separateCost={costLabel(model, isDemo(model), decomposeCost(modelId, 8))}
        onSeparate={async () => {
          await run({ tool: "decompose", target: { kind: "whole" }, settings: { resolution: "1K", mode: "standard", layers: 8 }, label: "Layer decomposition" });
        }}
        onDismiss={(jobId) => endJob(jobId, "dismiss")}
      />
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-content min-w-0 flex-col overflow-hidden">
        <TopBar
          name={view.project.name}
          onRename={(n) => void actions.rename(id, n).catch((e) => toastError(e))}
          save={save}
          onRetrySave={() => void saveNow()}
          canUndo={hist.past.length > 0}
          canRedo={hist.future.length > 0}
          onUndo={() => dispatch({ type: "undo" })}
          onRedo={() => dispatch({ type: "redo" })}
          versions={view.versions}
          headVersionId={head}
          onRestore={async (vid) => {
            // Unsaved edits go into the version they were made on first.
            void saveNow();
            try {
              const v = await serial(() => actions.version(id, { from: vid }));
              resetTo(v);
              select(null);
              toast.success("Version restored", { duration: 1500 });
            } catch (e) {
              toastError(e);
            }
          }}
          compare={compare}
          onCompare={setCompare}
          doc={doc}
          jobs={view.jobs}
          engine={engine}
          setEngine={setEngine}
        />
        <div className="flex min-h-0 flex-1">
          <ToolRail />
          <div className="relative flex min-w-0 flex-1 flex-col">
            {compare ? (
              <div className="checkerboard grid min-h-0 flex-1 place-items-center overflow-hidden p-6">
                {pair ? <CompareSlider before={pair.before} after={pair.after} alt="Your layers" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
              </div>
            ) : (
              <Stage
                doc={doc}
                selectedId={selectedId}
                onSelect={select}
                onCommit={commit}
                mode={mode}
                setMode={setMode}
                region={region}
                setRegion={setRegion}
                frame={frame}
                setFrame={setFrame}
                mask={mask}
                onMaskChange={() => setMaskVersion((v) => v + 1)}
                paint={paint}
                paintVersion={paintVersion}
                onPaintChange={() => setPaintVersion((v) => v + 1)}
                setPaintErase={(erase) => setPaint((p) => (p ? { ...p, erase } : p))}
                brushSize={brushSize}
                setBrushSize={setBrushSize}
                highlight={highlight}
                sources={sources}
                overlay={overlay}
                busy={busy}
              />
            )}
            {mask && selected && !compare && (
              <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/95 py-1 pr-1 pl-3.5 text-[12px] shadow-normal backdrop-blur" role="status">
                <span className="max-w-[40vw] truncate">
                  Mask · <span className="font-medium">{selected.name}</span> — the eraser hides, the brush paints back
                </span>
                <Button size="xs" variant="ghost" className="rounded-full" onClick={() => setMode("select")}>
                  <X /> Cancel
                </Button>
                <Button size="xs" className="rounded-full" onClick={() => void finishMask()} disabled={savingMask}>
                  {savingMask ? <Loader2 className="animate-spin" /> : <Check />} Done
                </Button>
              </div>
            )}
          </div>
          <LayersPanel />
        </div>
      </div>
    </Ctx.Provider>
  );
}
