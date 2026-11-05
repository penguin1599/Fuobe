"use client";

import {
  ArrowLeft,
  Crop,
  Layers,
  Eraser,
  Loader2,
  Paintbrush,
  Plus,
  RefreshCw,
  Rotate3d,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  SquareDashedMousePointer,
  Sun,
  TriangleAlert,
  Type,
  Wand2,
  X,
  ZoomIn,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyPreset, CONTROLS, isNeutral, NEUTRAL, PRESETS, type Grade } from "@/lib/grade";
import {
  addNodes,
  addRevision,
  ANGLES,
  bboxFromAlpha,
  clampLayers,
  DECOMPOSE_COPY,
  decomposeCost,
  defaultLayers,
  ENHANCE_LOOKS,
  enhanceModels,
  expandPads,
  getNode,
  layersLayout,
  INPAINT_SEES_TINT,
  INPAINT_TINT,
  jobStatusText,
  LAYER_PRICES,
  layersModelFor,
  minLayers,
  nativeSize,
  needsDetectedSize,
  placeTextBlocks,
  readableBackdrop,
  reframeDoc,
  RELIGHT_DIRECTIONS,
  RELIGHT_LIGHTS,
  replaceNodes,
  scaledSize,
  STALL_MS,
  textBlocksFrom,
  textChanges,
  textJobTitle,
  TOOL_LABELS,
  TOOL_MODELS,
  type Box,
  type EnhanceLook,
  type LayerJob,
  type LayerJobInput,
  type LayerNode,
  type LayerTool,
  type PlacedText,
  type TextBlock,
} from "@/lib/layers";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { Field, Segmented } from "./bits";
import { costLabel, isFailed, isRunning, latestJob, modelsFor, useEditor, type Target, type ToolId } from "./editor-context";
import { LayerGrader } from "./grade-gl";
import { useKeepAlpha } from "./keep-alpha";
import { LayerThumb } from "./layers-panel";
import { loadImage, ratioOf, renderDoc, renderNative, sizeOf, uploadRender } from "./render";
import { plainTagline } from "@/lib/plain-tagline";

export const TOOLS: { id: ToolId; label: string; icon: typeof Layers; isNew?: boolean; hint: string }[] = [
  { id: "decompose", label: "Layer Decomposition", icon: Layers, isNew: true, hint: "Split the image into editable layers" },
  { id: "edit-text", label: "Edit text", icon: Type, isNew: true, hint: "Rewrite the words, keep the design" },
  { id: "remove-bg", label: "Remove background", icon: Scissors, hint: "Keep the subject on transparency" },
  { id: "regional", label: "Regional editing", icon: SquareDashedMousePointer, hint: "Draw a box and describe the change" },
  { id: "inpaint", label: "Inpaint", icon: Paintbrush, isNew: true, hint: "Paint an area, say what goes there" },
  { id: "upscale", label: "Upscale", icon: ZoomIn, hint: "More pixels, sharper detail" },
  { id: "enhance", label: "Enhancer", icon: Sparkles, isNew: true, hint: "Retouch skin, sharpen, restore detail" },
  { id: "relight", label: "Relight", icon: Sun, hint: "New light on a layer or the picture" },
  { id: "angles", label: "Angles", icon: Rotate3d, hint: "See it from another camera angle" },
  { id: "expand", label: "Expand & Crop", icon: Crop, isNew: true, hint: "Resize the canvas, fill it with AI" },
  { id: "grade", label: "Color grading", icon: SlidersHorizontal, hint: "Film looks and colour, in your browser" },
  { id: "rerender", label: "Re-render from layers", icon: RefreshCw, isNew: true, hint: "Paint the arrangement again as one picture" },
];

// ---------------------------------------------------------------------------
// Shared pieces

/** What a tool works on: the selected layer, else the whole image. */
function useTarget(): { target: Target; node?: LayerNode } {
  const { selected } = useEditor();
  return selected ? { target: { kind: "node", node: selected }, node: selected } : { target: { kind: "whole" } };
}

function Scope({ node }: { node?: LayerNode }) {
  const { select } = useEditor();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/70 px-2.5 py-2 text-[12px]">
      {node ? <LayerThumb node={node} className="size-8" /> : <Layers className="size-4 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{node ? node.name : "The whole image"}</p>
        <p className="truncate text-muted-foreground">{node ? "Deselect the layer to use this tool on the whole image" : "Select a layer to work on it alone"}</p>
      </div>
      {node && (
        <Button size="icon-xs" variant="ghost" aria-label="Use the whole image" onClick={() => select(null)}>
          <X />
        </Button>
      )}
    </div>
  );
}

function ModelSelect({ tool, ids, value, onChange, label = "Model" }: { tool: LayerTool; ids?: string[]; value?: string; onChange: (id: string) => void; label?: string }) {
  const { engine, models, offeredIds } = useEditor();
  const options = modelsFor(models, offeredIds(ids ?? TOOL_MODELS[tool][engine]));
  if (options.length < 2) return options[0] ? <p className="text-[12px] text-muted-foreground">{label} · {options[0].name}</p> : null;
  return (
    <Field label={label}>
      <Select value={value ?? options[0].id} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-full rounded-lg" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The model the tool will run (picked, or the engine's default); `picked` is what the user chose, if anything. */
function useToolModel(tool: LayerTool, ids?: string[]) {
  const { engine, models, offeredIds } = useEditor();
  const [picked, setPicked] = useState<string | undefined>();
  const options = offeredIds(ids ?? TOOL_MODELS[tool][engine]);
  const chosen = picked && options.includes(picked) ? picked : undefined;
  const id = chosen ?? options[0];
  return { modelId: id, model: id ? models[id] : undefined, setModelId: setPicked, picked: chosen };
}

type ToolModel = ReturnType<typeof useToolModel>;

/** A running or failed job of this tool on this target. */
function JobState({ job, onRetry, failedTitle = "That didn't work" }: { job?: LayerJob; onRetry?: () => void; failedTitle?: string }) {
  const { endJob } = useEditor();
  if (!job || job.state !== "pending") return null;
  if (isRunning(job)) {
    const p = job.result?.progress;
    return (
      <div className="space-y-2 rounded-lg bg-muted px-3 py-2.5" role="status">
        <div className="flex items-center gap-2 text-[12px]">
          <Loader2 className="size-3.5 animate-spin text-brand-text" />
          <span className="min-w-0 flex-1 truncate font-medium">{job.label}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => endJob(job.id, "cancel")}>
            Cancel
          </button>
        </div>
        <Progress value={p ? p * 100 : 8} className="h-1" aria-label="Progress" />
        <p className="text-[11px] text-muted-foreground">{jobStatusText(job.result)}</p>
      </div>
    );
  }
  if (isFailed(job)) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[12px]">
        <p className="flex items-center gap-1.5 font-medium text-destructive">
          <TriangleAlert className="size-3.5" /> {failedTitle}
        </p>
        <p className="mt-0.5 text-muted-foreground">{job.result?.error ?? "The model didn't finish."}</p>
        <div className="mt-2 flex gap-3">
          {onRetry && (
            <button type="button" className="font-medium text-brand-text hover:underline" onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => endJob(job.id, "dismiss")}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-[12px]" role="status">
      <Loader2 className="size-3.5 animate-spin" /> Adding the result to your layers…
    </div>
  );
}

function RunRow({ cost, busy, disabled, onClick, children }: { cost: string; busy: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <span className="font-mono text-[12px] text-muted-foreground">{cost}</span>
      <Button className="rounded-full" onClick={onClick} disabled={busy || disabled}>
        {busy && <Loader2 className="animate-spin" />}
        {children}
      </Button>
    </div>
  );
}

function KeepAlpha({ node, value, onChange }: { node?: LayerNode; value: boolean; onChange: (v: boolean) => void }) {
  if (!node) return null;
  return (
    <label className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
      Keep transparency (cut the background back out)
      <Switch checked={value} onCheckedChange={onChange} aria-label="Keep transparency" />
    </label>
  );
}

/**
 * A layer as a model should read it: a transparent one (a decomposition's text layer) on a backdrop
 * its content stands out from, since models see no alpha (transparent pixels read as black). The
 * stored render's URL, or undefined for a layer without transparency (it goes as it is).
 */
async function onBackdrop(node: LayerNode, name: string): Promise<string | undefined> {
  const c = await renderNative(node, 2048);
  const bg = readableBackdrop(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
  if (!bg) return undefined;
  const [flat, f] = blankCanvas(c.width, c.height);
  f.fillStyle = bg;
  f.fillRect(0, 0, c.width, c.height);
  f.drawImage(c, 0, 0);
  return uploadRender(flat, name);
}

function HowItWorks({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-[12px] font-medium">How it works</p>
      <p className="mt-0.5 text-[12px] text-pretty text-muted-foreground">{children}</p>
    </div>
  );
}

/** Run a tool with a busy flag (rendering and uploading the picture can take a moment). */
function useRun() {
  const { run } = useEditor();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    go: async (input: Parameters<typeof run>[0]) => {
      setBusy(true);
      try {
        return await run(input);
      } finally {
        setBusy(false);
      }
    },
  };
}

/** A blank canvas of a size. */
function blankCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

// ---------------------------------------------------------------------------
// Layer Decomposition (and Separate layer)

function DecomposeTool() {
  const { doc, engine, models, isDemo, jobs, splitTarget, setSplitTarget, selected, endJob, decomposed } = useEditor();
  // Separate layer: picked from a layer's menu, or with the button below once the image is decomposed.
  const splitNode = getNode(doc, splitTarget);
  const tool = splitNode ? "split" : "decompose";
  const picker = useToolModel(tool);
  const [resolution, setResolution] = useState<"1K" | "1.5K" | "2K">("1K");
  const [mode, setMode] = useState<"standard" | "fast">("standard");
  /** The slider's value once moved (until then each model's own default). */
  const [layers, setLayers] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const asked = splitNode ? prompt.trim() : "";
  // On the open engine a named element runs on Layered-Control, and only there.
  const auto = tool === "split" && engine === "open";
  const modelId = layersModelFor(tool, engine, picker.modelId, asked) ?? picker.modelId;
  const model = modelId ? models[modelId] : undefined;
  const { busy, go } = useRun();
  const [phase, setPhase] = useState<"setting-up" | "submitting" | null>(null);
  const job = splitNode ? latestJob(jobs, ["split"], splitNode.id) : latestJob(jobs, ["decompose"]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job || !isRunning(job)) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [job]);

  const max = LAYER_PRICES[modelId ?? ""]?.maxLayers ?? 10;
  const min = minLayers(modelId ?? "");
  const n = clampLayers(modelId ?? "", Math.min(layers ?? defaultLayers(tool, modelId), max));
  const hasRes = !!modelId && (modelId.startsWith("seedream") || modelId.startsWith("oss-"));
  const hasMode = modelId === "seedream-5-layers" || !!modelId?.startsWith("oss-");
  const usd = decomposeCost(modelId ?? "", n, resolution);
  const cost = costLabel(model, isDemo(model), usd);

  const start = async () => {
    setPhase("setting-up");
    setTimeout(() => setPhase((p) => (p ? "submitting" : p)), 300);
    const target: Target = splitNode ? { kind: "node", node: splitNode } : { kind: "whole" };
    await go({
      tool,
      target,
      // The model that runs, as the form shows it (a model picked by hand, Layered-Control for a named element).
      ...(picker.picked || modelId !== picker.modelId ? { modelId } : {}),
      prompt: asked || undefined,
      settings: { resolution, mode, layers: n },
      label: splitNode ? `Separating ${splitNode.name}` : "Layer decomposition",
    });
    setPhase(null);
  };

  const state: keyof typeof DECOMPOSE_COPY | null = phase
    ? phase
    : job?.state === "pending"
      ? isRunning(job)
        ? job.result?.status === "queued" && now - job.createdAt > STALL_MS
          ? "stalled"
          : "processing"
        : isFailed(job)
          ? "failed"
          : "ready"
      : !splitNode && decomposed
        ? "decomposed"
        : null;

  if (state && state !== "decomposed") {
    const [title, body] = DECOMPOSE_COPY[state];
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <div className="rounded-xl border bg-card p-4 text-center">
          {state === "failed" || state === "stalled" ? <TriangleAlert className="mx-auto size-5 text-warning" /> : <Loader2 className="mx-auto size-5 animate-spin text-brand-text" />}
          <p className="mt-2 font-heading text-[19px] leading-snug">{splitNode && state === "processing" ? `Separating ${splitNode.name}` : title}</p>
          <p className="mt-1 text-[12px] text-pretty text-muted-foreground">{state === "failed" ? (job?.result?.error ?? body) : body}</p>
          {state === "processing" && job?.result?.progress ? <Progress value={job.result.progress * 100} className="mt-3 h-1" aria-label="Progress" /> : null}
          {(state === "processing" || state === "stalled") && <p className="mt-2 text-[11px] text-muted-foreground">{jobStatusText(job?.result)}</p>}
        </div>
        {state === "failed" && job && (
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 rounded-full" onClick={() => endJob(job.id, "dismiss")}>
              Back to settings
            </Button>
            <Button
              className="flex-1 rounded-full"
              onClick={() => {
                endJob(job.id, "dismiss");
                void start();
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {(state === "processing" || state === "stalled") && job && (
          <Button variant="ghost" className="w-full" onClick={() => endJob(job.id, "cancel")}>
            Cancel
          </Button>
        )}
      </div>
    );
  }

  if (!splitNode && decomposed) {
    const [title, body] = DECOMPOSE_COPY.decomposed;
    return (
      <div className="space-y-3">
        <div className="rounded-xl border bg-card p-4">
          <p className="font-heading text-[19px]">{title}</p>
          <p className="mt-1 text-[12px] text-pretty text-muted-foreground">{body.replace("#", String(doc.nodes.length))}</p>
        </div>
        <p className="text-[12px] text-muted-foreground">An image can only be decomposed once. Select a layer to separate it further, with an optional description of what to pull out.</p>
        {selected && (
          <Button variant="secondary" className="w-full rounded-full" onClick={() => setSplitTarget(selected.id)}>
            <Layers /> <span className="truncate">Separate {selected.name}</span>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {splitNode ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg bg-muted/70 px-2.5 py-2 text-[12px]">
            <LayerThumb node={splitNode} className="size-8" />
            <p className="min-w-0 flex-1 truncate">
              Separate <span className="font-medium">{splitNode.name}</span> into more layers
            </p>
            {splitTarget && (
              <Button size="icon-xs" variant="ghost" aria-label="Stop separating this layer" onClick={() => setSplitTarget(null)}>
                <X />
              </Button>
            )}
          </div>
          <Field label="What to pull out (optional)" htmlFor="split-prompt">
            <Input id="split-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={200} placeholder="e.g. “the guitar”" className="h-9" />
          </Field>
        </div>
      ) : (
        <p className="text-[12px] text-pretty text-muted-foreground">Break the image into clean, editable layers — subject, background and details. An image can only be decomposed once; you can separate any layer again later.</p>
      )}
      {auto ? (
        <div className="space-y-0.5">
          <p className="text-[12px] text-muted-foreground">Model · {model?.name ?? modelId}</p>
          <p className="text-[11px] text-muted-foreground">{asked ? "A named element runs on Qwen-Image-Layered Control." : "Name an element to pull it out with Qwen-Image-Layered Control."}</p>
        </div>
      ) : (
        <ModelSelect tool={tool} value={modelId} onChange={picker.setModelId} />
      )}
      {hasRes && (
        <Field label="Resolution">
          <Segmented
            label="Resolution"
            value={resolution}
            onChange={setResolution}
            options={[
              ["1K", "1K"],
              ["1.5K", "1.5K"],
              ["2K", "2K"],
            ]}
          />
        </Field>
      )}
      {hasMode && (
        <Field label="Mode">
          <Segmented
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              ["standard", "Standard"],
              ["fast", "Fast"],
            ]}
          />
        </Field>
      )}
      <Field label="Layers" hint={modelId?.startsWith("seedream") ? `up to ${n}` : n}>
        <Slider aria-label="Layers" min={min} max={Math.max(min, max)} step={1} value={[n]} onValueChange={([v]) => setLayers(v)} />
      </Field>
      {modelId?.startsWith("seedream") && <p className="text-[11px] text-muted-foreground">Seedream decides the final count (up to 16) and names each layer.</p>}
      {!model && <p className="text-[12px] text-muted-foreground">No {engine === "open" ? "open-source" : "cloud"} model can split layers yet.</p>}
      <RunRow cost={cost} busy={busy} disabled={!model} onClick={() => void start()}>
        <Layers /> {splitNode ? "Separate layer" : "Separate layers"}
      </RunRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit text

function EditTextTool() {
  const { isDemo, jobs, setHighlight, endJob, engine } = useEditor();
  const { target, node } = useTarget();
  const scopeId = node?.id ?? null;
  const detect = latestJob(jobs, ["text-detect"], scopeId);
  const editJob = latestJob(jobs, ["text-edit"], scopeId);
  const { modelId, model, setModelId } = useToolModel("text-edit");
  const detector = useToolModel("text-detect");
  /** Ideogram or Florence-2 on the cloud: the picker stays in reach once rows are listed. */
  const detectors = TOOL_MODELS["text-detect"][engine].length;
  const [keepAlpha] = useKeepAlpha(node);
  const { busy, go } = useRun();
  const [rows, setRows] = useState<{ from: string; to: string; box: Box | null }[]>([]);
  const [restored, setRestored] = useState(false);
  /** The detector answered, but not with lines (shown as a failure to read). */
  const [unreadable, setUnreadable] = useState(false);
  /** Lines typed by hand: the fallback when detection can't run or misses one. */
  const [typing, setTyping] = useState(false);
  /** The detection whose rows are in the list (set once they've loaded). */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Rows from the newest finished detection, laid out in the frame it read. Pixel boxes are measured
  // against what was read: Ideogram's returned background, else (an OCR answer without a size) the
  // picture that was sent. A refetch (or React's strict-mode re-run) mid-load just loads it again.
  useEffect(() => {
    if (!detect || detect.result?.status !== "succeeded" || loadedFor === detect.id) return;
    const out = detect.result.outputs[0];
    const sent = typeof detect.settings?.image === "string" ? detect.settings.image : undefined;
    const measure = out?.kind === "image" ? out.url : needsDetectedSize(out?.meta) ? sent : undefined;
    let gone = false;
    void (measure ? loadImage(measure).then((img) => sizeOf(img)) : Promise.resolve(undefined))
      .catch(() => undefined)
      .then((natural) => {
        if (gone) return;
        const blocks: TextBlock[] = out ? textBlocksFrom(out.meta, natural) : [];
        setRows(placeTextBlocks(blocks, detect.frame));
        setUnreadable(!!out?.meta?.unreadable);
        setRestored(detect.state === "applied");
        setLoadedFor(detect.id);
        if (detect.state === "pending") endJob(detect.id, "applied");
      });
    return () => {
      gone = true;
    };
  }, [detect, endJob, loadedFor]);
  useEffect(() => () => setHighlight(null), [setHighlight]);

  const changes = textChanges(rows);
  const [preparing, setPreparing] = useState(false);
  const detecting = !!detect && isRunning(detect);
  const detectCost = costLabel(detector.model, isDemo(detector.model));
  /** A transparent layer (a decomposition's text) goes on a backdrop its text stands out from, to the detector and the edit model alike. */
  const readable = async () => {
    if (!node) return undefined;
    try {
      return await onBackdrop(node, `${node.name}-text`);
    } catch {
      return undefined; // The layer goes as it is.
    }
  };
  const startDetect = async () => {
    setLoadedFor(null);
    setRestored(false);
    setUnreadable(false);
    setPreparing(true);
    const image = await readable();
    setPreparing(false);
    void go({ tool: "text-detect", target, image, modelId: detector.modelId, label: "Detect text" });
  };
  const addLine = () => {
    setTyping(true);
    setRows([...rows, { from: "", to: "", box: null }]);
  };
  // A see-through layer gets its cut-out back after the edit (the flattened backdrop goes with it).
  const generate = async () => {
    setPreparing(true);
    const image = await readable();
    setPreparing(false);
    void go({ tool: "text-edit", target, image, modelId, settings: { rows: changes.map(({ from, to }) => ({ from, to })), keepAlpha }, label: textJobTitle(changes) });
  };
  const detectorPicker = (
    <>
      <ModelSelect tool="text-detect" value={detector.modelId} onChange={detector.setModelId} label="Detector" />
      {detector.model && detectors > 1 && (
        <p className="text-[11px] text-pretty text-muted-foreground">
          {plainTagline(detector.model.tagline)}
          {detector.model.pricing?.note && !isDemo(detector.model) ? ` · The price is an estimate: ${detector.model.pricing.note}.` : ""}
        </p>
      )}
    </>
  );
  const listed = rows.length > 0 || typing;
  const found = detect?.result?.status === "succeeded" && loadedFor === detect.id;

  return (
    <div className="space-y-4">
      <Scope node={node} />
      <HowItWorks>Edit text finds the text on your image and lists it here. Change any line, then generate a new image with your wording in the original design.</HowItWorks>
      {!rows.length && (
        <div className="space-y-2">
          {detectorPicker}
          <Button variant="secondary" className="w-full rounded-full" onClick={() => void startDetect()} disabled={busy || preparing || detecting || !detector.model}>
            {detecting ? <Loader2 className="animate-spin" /> : <Type />} {detecting ? "Reading the text…" : "Detect text"}
          </Button>
          <p className="text-center font-mono text-[11px] text-muted-foreground">{detectCost}</p>
          {detector.model?.engine === "open" && !detecting && <p className="text-center text-[11px] text-pretty text-muted-foreground">Reads the lines on your ComfyUI: seconds on a GPU, a few minutes on a CPU.</p>}
          {detecting && <JobState job={detect} />}
          {found && !rows.length && (
            <p className="text-center text-[12px] text-muted-foreground" role="status">
              {unreadable ? "Could not read the text on this image." : "No text was found on this image."}
            </p>
          )}
          {detect && isFailed(detect) && <JobState job={detect} failedTitle="Could not read the text on this image." onRetry={() => void startDetect()} />}
          {!typing && (
            <button type="button" className="mx-auto block text-[12px] font-medium text-brand-text hover:underline" onClick={addLine}>
              Type the lines instead
            </button>
          )}
        </div>
      )}
      {restored && rows.length > 0 && <p className="text-[11px] text-muted-foreground">Restored from your last detection — the image may have changed since. Re-detect if the regions look off.</p>}
      {listed && (
        <ol className="space-y-2" aria-label="Text on the image">
          {rows.map((r, i) => (
            <li key={i} className="flex items-start gap-2" onPointerEnter={() => setHighlight(r.box)} onPointerLeave={() => setHighlight(null)} onFocus={() => setHighlight(r.box)} onBlur={() => setHighlight(null)}>
              <span className="mt-2 w-4 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1 space-y-1">
                {!r.box ? (
                  <Input value={r.from} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} placeholder="Text on the image now" aria-label={`Text region ${i + 1}: current text`} className="h-8 text-[13px]" />
                ) : (
                  <p className="truncate text-[11px] text-muted-foreground" title={r.from}>
                    {r.from}
                  </p>
                )}
                <Input
                  value={r.to}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                  placeholder="Remove this text"
                  aria-label={`Text region ${i + 1}`}
                  className={cn("h-8 text-[13px]", r.to.trim() !== r.from.trim() && "border-primary")}
                />
              </div>
              {!r.box && (
                <Button size="icon-xs" variant="ghost" className="mt-1" aria-label={`Remove row ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              )}
            </li>
          ))}
          <li>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={addLine}>
              <Plus /> Add a line
            </Button>
          </li>
        </ol>
      )}
      {listed && (
        <>
          {/* Once rows are listed, "Detect again" runs the detector picked here (detected rows can't be removed). */}
          {rows.length > 0 && detectors > 1 && detectorPicker}
          <ModelSelect tool="text-edit" value={modelId} onChange={setModelId} />
          <JobState job={editJob} failedTitle="Failed to apply the text changes" onRetry={() => void generate()} />
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={found ? "Detect text again" : "Detect text"} onClick={() => void startDetect()} disabled={busy || preparing || detecting || !detector.model}>
                  {detecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {found ? "Detect again" : "Detect text"} · {detectCost}
              </TooltipContent>
            </Tooltip>
            <div className="flex-1">
              <RunRow cost={costLabel(model, isDemo(model))} busy={busy || preparing} disabled={!changes.length || (editJob && isRunning(editJob))} onClick={() => void generate()}>
                <Wand2 /> Generate
              </RunRow>
            </div>
          </div>
          {!changes.length && <p className="text-[11px] text-muted-foreground">Change a line (or empty it to remove that text), then Generate.</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remove background, Upscale, Relight, Angles

function SimpleTool({
  tool,
  verb,
  failedTitle,
  children,
  afterModel,
  settings,
  prompt,
  disabled,
  picker,
}: {
  tool: LayerTool;
  verb: string;
  failedTitle: string;
  children?: React.ReactNode;
  /** Fields that belong to the model picked (Bria guided cut-out's words): below the model select, so they appear under it. */
  afterModel?: React.ReactNode;
  settings?: LayerJobInput["settings"];
  prompt?: string;
  disabled?: boolean;
  /** The model state, when the form above depends on the model (Angles). */
  picker?: ToolModel;
}) {
  const { jobs, isDemo } = useEditor();
  const { target, node } = useTarget();
  const own = useToolModel(tool);
  const { modelId, model, setModelId } = picker ?? own;
  const { busy, go } = useRun();
  const job = latestJob(jobs, [tool], node?.id ?? null);
  const run = () => void go({ tool, target, modelId, prompt, settings, label: verb });
  return (
    <div className="space-y-4">
      <Scope node={node} />
      {children}
      <ModelSelect tool={tool} value={modelId} onChange={setModelId} />
      {afterModel}
      <JobState job={job} failedTitle={failedTitle} onRetry={run} />
      <RunRow cost={costLabel(model, isDemo(model))} busy={busy} disabled={disabled || !model || (!!job && isRunning(job))} onClick={run}>
        {verb}
      </RunRow>
    </div>
  );
}

/** Remove background: the subject on transparency; a guided model (Bria's) also takes words on what to keep or drop. */
function RemoveBgTool() {
  const picker = useToolModel("bg-remove");
  const [guide, setGuide] = useState("");
  const guided = !!picker.model?.guided;
  return (
    <SimpleTool
      tool="bg-remove"
      verb="Remove background"
      failedTitle="Failed to load image. Please try again."
      picker={picker}
      prompt={guided ? guide.trim() || undefined : undefined}
      afterModel={
        guided && (
          <Field label="What to keep or drop (optional)" htmlFor="cutout-guide">
            <Input id="cutout-guide" value={guide} onChange={(e) => setGuide(e.target.value)} maxLength={300} placeholder="e.g. “keep the shadow” or “without the hand”" className="h-9" />
          </Field>
        )
      }
    >
      <HowItWorks>Remove background finds the main subject of your image and cuts everything else away, giving you the subject on a transparent background.</HowItWorks>
    </SimpleTool>
  );
}

function RelightTool() {
  const { selected } = useEditor();
  const [light, setLight] = useState(RELIGHT_LIGHTS[0][0]);
  const [direction, setDirection] = useState(RELIGHT_DIRECTIONS[0][0]);
  const [extra, setExtra] = useState("");
  const [keepAlpha, setKeepAlpha] = useKeepAlpha(selected);
  return (
    <SimpleTool tool="relight" verb="Relight" failedTitle="Couldn't relight it" settings={{ light, direction, keepAlpha }} prompt={extra.trim() || undefined}>
      <Field label="Lighting">
        <Chips label="Lighting" value={light} options={RELIGHT_LIGHTS.map(([l]) => l)} onChange={setLight} />
      </Field>
      <Field label="Direction">
        <Chips label="Direction" value={direction} options={RELIGHT_DIRECTIONS.map(([d]) => d)} onChange={setDirection} />
      </Field>
      <Field label="Anything else (optional)" htmlFor="relight-extra">
        <Input id="relight-extra" value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={300} placeholder="e.g. “a soft blue fill from the right”" className="h-9" />
      </Field>
      <KeepAlpha node={selected} value={keepAlpha} onChange={setKeepAlpha} />
    </SimpleTool>
  );
}

function AnglesTool() {
  const { selected } = useEditor();
  // One model state for the form and its Model select: Qwen Multiple Angles takes sliders, the others a camera.
  const picker = useToolModel("angles");
  const [rotate, setRotate] = useState(45);
  const [tilt, setTilt] = useState(0);
  const [zoom, setZoom] = useState(5);
  const [angle, setAngle] = useState(ANGLES[0][0]);
  const [keepAlpha, setKeepAlpha] = useKeepAlpha(selected);
  const sliders = picker.modelId === "qwen-multiple-angles";
  return (
    <SimpleTool tool="angles" verb="New angle" failedTitle="Couldn't make the new angle" picker={picker} settings={sliders ? { rotate, tilt, zoom, keepAlpha } : { angle, keepAlpha }}>
      {sliders ? (
        <>
          <Field label="Rotate" hint={`${rotate}°`}>
            <Slider aria-label="Rotate" min={0} max={360} step={1} value={[rotate]} onValueChange={([v]) => setRotate(v)} />
          </Field>
          <Field label="Tilt" hint={`${tilt}°`}>
            <Slider aria-label="Tilt" min={-30} max={90} step={1} value={[tilt]} onValueChange={([v]) => setTilt(v)} />
          </Field>
          <Field label="Zoom" hint={zoom}>
            <Slider aria-label="Zoom" min={0} max={10} step={1} value={[zoom]} onValueChange={([v]) => setZoom(v)} />
          </Field>
        </>
      ) : (
        <Field label="Camera">
          <Chips label="Camera angle" value={angle} options={ANGLES.map(([a]) => a)} onChange={setAngle} />
        </Field>
      )}
      <KeepAlpha node={selected} value={keepAlpha} onChange={setKeepAlpha} />
    </SimpleTool>
  );
}

const chipClass = (active: boolean) =>
  cn(
    "inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
    active ? "bg-brand-faint text-brand-text hover:bg-brand-faint-hover" : "bg-secondary text-secondary-foreground hover:bg-accent",
  );

/**
 * A row of chips to pick one of (a radio group): one Tab stop, the arrow keys move the pick. With
 * nothing picked yet, the first chip takes the Tab stop.
 */
function Chips<T extends string>({ label, value, options, onChange, names }: { label: string; value: T | null; options: readonly T[]; onChange: (v: T) => void; names?: (v: T) => string }) {
  const stop = value !== null && options.includes(value) ? value : options[0];
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label} onKeyDown={radioKeys}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} tabIndex={radioTab(o === stop)} onClick={() => onChange(o)} className={chipClass(value === o)}>
          {names ? names(o) : o}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regional editing

function RegionalTool() {
  const { doc, commit, jobs, isDemo, region, setRegion, setMode, select, selected } = useEditor();
  const { modelId, model, setModelId } = useToolModel("regional");
  const [prompt, setPrompt] = useState("");
  const [merging, setMerging] = useState(false);
  const { busy, go } = useRun();
  const job = latestJob(jobs, ["regional"]);
  useEffect(() => {
    setMode("region");
    return () => {
      setMode("select");
      setRegion(null);
    };
  }, [setMode, setRegion]);

  // The newest Original / New pair on the canvas.
  const pair = useMemo(() => {
    const sorted = [...doc.nodes].sort((a, b) => b.z - a.z);
    const edited = sorted.find((n) => n.role === "new");
    if (!edited) return null;
    const original = sorted.find((n) => n.role === "original" && n.z === edited.z - 1 && Math.abs(n.x - edited.x) < 1 && Math.abs(n.y - edited.y) < 1);
    return { edited, original };
  }, [doc.nodes]);

  const run = () => {
    if (!region) return;
    void go({ tool: "regional", target: { kind: "region", rect: region }, modelId, prompt: prompt.trim(), settings: { feather: Math.round(Math.min(region[2], region[3]) * 0.06) }, label: "Editing region" });
  };

  const merge = async () => {
    if (!pair) return;
    setMerging(true);
    const t = toast.loading("Merging…");
    try {
      const { edited, original } = pair;
      const rect: Box = [Math.round(edited.x), Math.round(edited.y), Math.round(edited.w), Math.round(edited.h)];
      const parts = original ? [original, edited] : [edited];
      const flat = await renderDoc({ ...doc, nodes: parts.map((p, i) => ({ ...p, hidden: false, z: i })) }, { rect });
      const url = await uploadRender(flat, "edited-region");
      const at = Date.now();
      const merged: LayerNode = {
        id: nanoid(8),
        name: "Edited region",
        z: 0,
        x: rect[0],
        y: rect[1],
        w: rect[2],
        h: rect[3],
        rotation: 0,
        src: url,
        crop: null,
        natural: [flat.width, flat.height],
        revisions: [{ src: url, crop: null, natural: [flat.width, flat.height], label: "Merged", at }],
        revision: 0,
      };
      commit(replaceNodes(doc, parts.map((p) => p.id), [merged]));
      select(merged.id);
      toast.success("Layers merged", { id: t, duration: 1500 });
    } catch {
      toast.error("Failed to merge layers", { id: t });
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card px-3 py-2.5">
        <p className="text-[12px] font-medium">Select an area to edit</p>
        <p className="mt-0.5 text-[12px] text-pretty text-muted-foreground">Draw a rectangle over the image, then describe your changes in the prompt below it.</p>
      </div>
      {region ? (
        <p className="flex items-center justify-between font-mono text-[12px] text-muted-foreground">
          Area {region[2]} × {region[3]}
          <button type="button" className="font-sans text-[12px] hover:text-foreground hover:underline" onClick={() => setRegion(null)}>
            Clear selection
          </button>
        </p>
      ) : (
        <p className="text-[12px] text-muted-foreground">Drag on the canvas to draw the area.</p>
      )}
      <Field label="Prompt" htmlFor="region-prompt">
        <Textarea id="region-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="e.g. “replace the cup with a glass of orange juice”" className="min-h-16 text-[13px]" />
      </Field>
      <ModelSelect tool="regional" value={modelId} onChange={setModelId} />
      <JobState job={job} failedTitle="Failed to edit image" onRetry={run} />
      <RunRow cost={costLabel(model, isDemo(model))} busy={busy} disabled={!region || !prompt.trim() || !model || (!!job && isRunning(job))} onClick={run}>
        <Wand2 /> Edit region
      </RunRow>
      {pair && (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-[12px] font-medium">Original and New</p>
          <div className="flex gap-1.5">
            {[pair.original, pair.edited].filter((n): n is LayerNode => !!n).map((n) => (
              <Button key={n.id} size="xs" variant={selected?.id === n.id ? "default" : "secondary"} className="rounded-full" onClick={() => select(n.id)}>
                {n.name}
              </Button>
            ))}
          </div>
          <Field label="Mask feather" hint={`${Math.round(pair.edited.feather ?? 0)} px`}>
            <Slider
              aria-label="Mask feather"
              min={0}
              max={Math.round(Math.min(pair.edited.w, pair.edited.h) / 2)}
              step={1}
              value={[Math.round(pair.edited.feather ?? 0)]}
              onValueChange={([v]) => commit({ ...doc, nodes: doc.nodes.map((n) => (n.id === pair.edited.id ? { ...n, feather: v } : n)) }, `feather:${pair.edited.id}`)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="grow rounded-full" onClick={() => void merge()} disabled={merging}>
              {merging && <Loader2 className="animate-spin" />} Merge layers
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="grow rounded-full"
              onClick={() => {
                setRegion(null);
                setPrompt("");
                select(null);
              }}
            >
              Edit another region
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inpaint (brush an area, say what goes there)

function InpaintTool() {
  const { doc, isDemo, jobs, setMode, mode, paint, setPaint, paintVersion, brushSize, setBrushSize } = useEditor();
  const { target, node } = useTarget();
  const { modelId, model, setModelId } = useToolModel("inpaint");
  const [prompt, setPrompt] = useState("");
  const [keepAlpha, setKeepAlpha] = useKeepAlpha(node);
  const [painted, setPainted] = useState<Box | null>(null);
  const { busy, go } = useRun();
  const [preparing, setPreparing] = useState(false);
  const job = latestJob(jobs, ["inpaint"], node?.id ?? null);
  // The painted area matches the picture the tool sends: the layer at its own detail, or the composite (≤ 2048 px).
  const [pw, ph] = node ? nativeSize(node, 2048) : scaledSize(doc.width, doc.height, Math.min(1, 2048 / Math.max(doc.width, doc.height)));
  const surface = `${node ? `${node.id}|${node.src}|${node.crop?.join(",")}` : "whole"}|${pw}x${ph}`;

  useEffect(() => {
    setMode("inpaint");
    return () => {
      setMode("select");
      setPaint(null);
    };
  }, [setMode, setPaint]);
  // A fresh area for each layer (or the whole image) it's painted on.
  const nodeId = node?.id;
  useEffect(() => {
    // (The measuring below then finds it empty.) `surface` names the picture: a new revision starts afresh too.
    setPaint({ nodeId, canvas: blankCanvas(pw, ph)[0], erase: false });
  }, [surface, nodeId, pw, ph, setPaint]);
  // What's painted, measured once the strokes pause.
  useEffect(() => {
    if (!paint) return;
    const t = setTimeout(() => {
      const c = paint.canvas;
      setPainted(bboxFromAlpha(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 8));
    }, 150);
    return () => clearTimeout(t);
  }, [paint, paintVersion]);

  // A fresh canvas, not the old one wiped: the stage keeps its red copy per canvas and stroke count.
  const clear = () => {
    if (!paint) return;
    setPaint({ ...paint, canvas: blankCanvas(paint.canvas.width, paint.canvas.height)[0] });
    setPainted(null);
  };

  const run = async () => {
    if (!paint || !painted) return;
    setPreparing(true);
    try {
      // The picture, its mask (white = change) and, for models without a mask input, the picture tinted where painted.
      const picture = node ? await renderNative(node, 2048) : await renderDoc(doc, { scale: paint.canvas.width / doc.width });
      const { width: W, height: H } = picture;
      const [mask, m] = blankCanvas(W, H);
      m.fillStyle = "#000";
      m.fillRect(0, 0, W, H);
      m.drawImage(paint.canvas, 0, 0, W, H);
      const [tint, t] = blankCanvas(W, H);
      t.drawImage(paint.canvas, 0, 0, W, H);
      t.globalCompositeOperation = "source-in";
      t.fillStyle = INPAINT_TINT;
      t.fillRect(0, 0, W, H);
      const [sketch, sk] = blankCanvas(W, H);
      sk.drawImage(picture, 0, 0);
      sk.drawImage(tint, 0, 0);
      const name = node?.name ?? "image";
      const [image, maskUrl, sketchUrl] = await Promise.all([uploadRender(picture, `inpaint-${name}`), uploadRender(mask, `inpaint-mask-${name}`), uploadRender(sketch, `inpaint-marked-${name}`)]);
      await go({ tool: "inpaint", target, image, mask: maskUrl, sketch: sketchUrl, modelId, prompt: prompt.trim(), settings: { keepAlpha }, label: "Inpaint" });
    } catch (e) {
      toastError(e, "Couldn't prepare the painted area");
    } finally {
      setPreparing(false);
    }
  };

  const erase = !!paint?.erase;
  return (
    <div className="space-y-4">
      <Scope node={node} />
      <HowItWorks>Paint over what you want to change, then say what goes there. Only the painted area changes; the rest stays as it is.</HowItWorks>
      <Field label="Brush" hint={`${brushSize} px`}>
        <div className="space-y-2.5">
          <Segmented
            label="Brush"
            value={mode === "inpaint" && erase ? "erase" : "paint"}
            onChange={(v) => {
              if (paint) setPaint({ ...paint, erase: v === "erase" });
              setMode("inpaint");
            }}
            options={[
              ["paint", "Paint"],
              ["erase", "Erase"],
            ]}
          />
          <Slider aria-label="Brush size" min={4} max={Math.max(64, Math.round(Math.max(doc.width, doc.height) / 6))} step={1} value={[brushSize]} onValueChange={([v]) => setBrushSize(v)} />
        </div>
      </Field>
      <p className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground" role="status">
        {painted ? <span>Painted area {Math.round((painted[2] * (node?.w ?? doc.width)) / (paint?.canvas.width || 1))} × {Math.round((painted[3] * (node?.h ?? doc.height)) / (paint?.canvas.height || 1))}</span> : <span>Paint on the canvas — the area shows in red.</span>}
        {painted && (
          <button type="button" className="shrink-0 hover:text-foreground hover:underline" onClick={clear}>
            <Eraser className="mr-1 inline size-3" />
            Clear
          </button>
        )}
      </p>
      <Field label="What goes there" htmlFor="inpaint-prompt">
        <Textarea
          id="inpaint-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
          placeholder="e.g. “a vase of white tulips”, or “remove it, fill in the background”"
          className="min-h-16 text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && painted && prompt.trim()) void run();
          }}
        />
      </Field>
      <ModelSelect tool="inpaint" value={modelId} onChange={setModelId} />
      {model && <p className="-mt-2 text-[11px] text-muted-foreground">{INPAINT_SEES_TINT.has(model.id) ? `${model.name} has no mask input: it's shown the painted area tinted red.` : `${model.name} takes the painted mask itself.`}</p>}
      <KeepAlpha node={node} value={keepAlpha} onChange={setKeepAlpha} />
      <JobState job={job} failedTitle="Couldn't inpaint it" onRetry={() => void run()} />
      <RunRow cost={costLabel(model, isDemo(model))} busy={busy || preparing} disabled={!painted || !prompt.trim() || !model || (!!job && isRunning(job))} onClick={() => void run()}>
        <Paintbrush /> Inpaint
      </RunRow>
      {!painted ? <p className="text-[11px] text-muted-foreground">Paint the area first{prompt.trim() ? "" : ", then describe it"}.</p> : !prompt.trim() && <p className="text-[11px] text-muted-foreground">Say what should fill the painted area.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enhancer (retouch, sharpen, detail)

function EnhanceTool() {
  const { engine, isDemo, jobs } = useEditor();
  const { target, node } = useTarget();
  const [look, setLook] = useState<EnhanceLook>("skin");
  const info = ENHANCE_LOOKS.find((l) => l.id === look)!;
  const { modelId, model, setModelId } = useToolModel("enhance", enhanceModels(look, engine));
  const [extra, setExtra] = useState("");
  const [keepAlpha, setKeepAlpha] = useKeepAlpha(node);
  const { busy, go } = useRun();
  const job = latestJob(jobs, ["enhance"], node?.id ?? null);
  const detail = look === "detail";
  const run = () => void go({ tool: "enhance", target, modelId, prompt: detail ? undefined : extra.trim() || undefined, settings: { look, keepAlpha: !detail && keepAlpha }, label: info.verb });
  return (
    <div className="space-y-4">
      <Scope node={node} />
      <Field label="Enhance">
        <Chips label="Enhance" value={look} options={ENHANCE_LOOKS.map((l) => l.id)} names={(id) => ENHANCE_LOOKS.find((l) => l.id === id)!.label} onChange={setLook} />
      </Field>
      <p className="-mt-2 text-[12px] text-pretty text-muted-foreground">{info.hint}.</p>
      {!detail && (
        <Field label="Anything else (optional)" htmlFor="enhance-extra">
          <Input id="enhance-extra" value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={300} placeholder="e.g. “keep the freckles”" className="h-9" />
        </Field>
      )}
      <ModelSelect tool="enhance" ids={enhanceModels(look, engine)} value={modelId} onChange={setModelId} />
      {!detail && <KeepAlpha node={node} value={keepAlpha} onChange={setKeepAlpha} />}
      <JobState job={job} failedTitle="Couldn't enhance it" onRetry={run} />
      <RunRow cost={costLabel(model, isDemo(model))} busy={busy} disabled={!model || (!!job && isRunning(job))} onClick={run}>
        <Sparkles /> {info.verb}
      </RunRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expand & Crop

const FRAME_RATIOS: [string, number][] = [
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["3:4", 3 / 4],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

/** The smallest frame of this shape that contains the whole canvas, centred on it. */
function frameAround(w: number, h: number, ratio: number): Box {
  const fw = Math.max(w, h * ratio);
  const fh = fw / ratio;
  return [Math.round((w - fw) / 2), Math.round((h - fh) / 2), Math.round(fw), Math.round(fh)];
}

function ExpandTool() {
  const { doc, commit, engine, isDemo, jobs, frame, setFrame, setMode } = useEditor();
  const { modelId, model } = useToolModel("expand");
  const [fill, setFill] = useState(true);
  const { busy, go } = useRun();
  const job = latestJob(jobs, ["expand"]);
  useEffect(() => {
    setMode("frame");
    setFrame([0, 0, doc.width, doc.height]);
    return () => {
      setMode("select");
      setFrame(null);
    };
    // Reset the frame when the canvas itself changes size.
  }, [setMode, setFrame, doc.width, doc.height]);

  const f = frame ?? ([0, 0, doc.width, doc.height] as Box);
  const pads = expandPads(doc, f);
  const grows = pads.left + pads.top + pads.right + pads.bottom > 0;

  const apply = () => {
    try {
      commit(reframeDoc(doc, f));
      toast.success(grows ? "Canvas expanded" : "Canvas cropped", { duration: 1500 });
    } catch (e) {
      toastError(e);
    }
  };

  const generate = async () => {
    try {
      reframeDoc(doc, f); // the same check as Apply
    } catch (e) {
      toastError(e);
      return;
    }
    const [fx, fy, fw, fh] = f.map(Math.round) as Box;
    if (engine === "open") {
      // FLUX Fill pads the picture itself (multiples of 8, ≤ 2048 px in all).
      const s = Math.min(1, 2048 / Math.max(doc.width + pads.left + pads.right, doc.height + pads.top + pads.bottom));
      const flat = await renderDoc(doc, { scale: s });
      const image = await uploadRender(flat, "expand-source");
      const k = (n: number) => Math.ceil((n * s) / 8) * 8;
      await go({ tool: "expand", target: { kind: "whole" }, image, frame: [fx, fy, fw, fh], modelId, settings: { pads: { left: k(pads.left), top: k(pads.top), right: k(pads.right), bottom: k(pads.bottom) } }, label: "Expand" });
    } else {
      // Cloud edit models fill the grey margins of the larger picture.
      const s = Math.min(1, 2048 / Math.max(fw, fh));
      const flat = await renderDoc(doc, { rect: [fx, fy, fw, fh], scale: s, fill: "#808080" });
      const image = await uploadRender(flat, "expand-source");
      await go({ tool: "expand", target: { kind: "whole" }, image, frame: [fx, fy, fw, fh], modelId, settings: { aspect: ratioOf(fw, fh) }, label: "Expand" });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-pretty text-muted-foreground">Drag the edges or corners. Crop keeps pixels on layers. Expand adds empty canvas, or turn on Fill with AI to generate it.</p>
      <Field label="Shape">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chips
            label="Frame shape"
            value={FRAME_RATIOS.find(([, r]) => Math.abs(f[2] / f[3] - r) < 0.01)?.[0] ?? null}
            options={FRAME_RATIOS.map(([l]) => l)}
            onChange={(l) => setFrame(frameAround(doc.width, doc.height, FRAME_RATIOS.find(([x]) => x === l)![1]))}
          />
          <button type="button" className={chipClass(false)} onClick={() => setFrame([0, 0, doc.width, doc.height])} disabled={f[0] === 0 && f[1] === 0 && f[2] === doc.width && f[3] === doc.height}>
            Reset
          </button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2 font-mono text-[12px] text-muted-foreground">
        <span>
          Now {doc.width} × {doc.height}
        </span>
        <span className="text-right text-foreground">
          New {f[2]} × {f[3]}
        </span>
      </div>
      <label className="flex items-center justify-between gap-2 text-[13px]">
        Fill with AI
        <Switch checked={fill} onCheckedChange={setFill} disabled={!grows} aria-label="Fill with AI" />
      </label>
      <JobState job={job} failedTitle="Could not start Expand & Crop. Please try again." onRetry={() => void generate()} />
      {fill && grows ? (
        <RunRow cost={costLabel(model, isDemo(model))} busy={busy} disabled={!model || (!!job && isRunning(job))} onClick={() => void generate()}>
          <Wand2 /> Generate
        </RunRow>
      ) : (
        <div className="flex justify-end">
          <Button className="rounded-full" onClick={apply} disabled={f[0] === 0 && f[1] === 0 && f[2] === doc.width && f[3] === doc.height}>
            <Crop /> Apply
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color grading (WebGL in the browser, no model)

function GradeTool() {
  const { doc, commit, select, setPreview } = useEditor();
  const { node } = useTarget();
  const [grade, setGrade] = useState<Grade>(NEUTRAL);
  const [preset, setPreset] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const grader = useRef<LayerGrader | null>(null);
  const source = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const previewId = node?.id ?? "__whole";
  const key = node ? `${node.id}|${node.src}|${node.crop?.join(",")}|${node.maskSrc}` : `whole|${doc.nodes.map((n) => `${n.id}${n.src}${n.x}${n.y}${n.w}${n.h}${n.rotation}${n.hidden}`).join(";")}`;

  useEffect(() => {
    try {
      grader.current = new LayerGrader();
    } catch (e) {
      toastError(e);
    }
    return () => {
      grader.current?.dispose();
      grader.current = null;
    };
  }, []);

  // Live preview (at most 1024 px): the layer, or the whole picture as an overlay.
  useEffect(() => {
    let gone = false;
    const run = async () => {
      if (!grader.current) return;
      if (isNeutral(grade)) {
        setPreview(previewId, null);
        return;
      }
      if (source.current?.key !== key) {
        const c = node ? await renderNative(node, 1024) : await renderDoc(doc, { scale: Math.min(1, 1024 / Math.max(doc.width, doc.height)) });
        source.current = { key, canvas: c };
      }
      if (!gone && grader.current) setPreview(previewId, grader.current.grade(source.current.canvas, grade));
    };
    const t = setTimeout(() => void run(), 40);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [grade, key, node, doc, previewId, setPreview]);
  useEffect(() => () => setPreview(previewId, null), [previewId, setPreview]);

  const save = async () => {
    if (!grader.current) return;
    setSaving(true);
    try {
      const full = node ? await renderNative(node, 4096) : await renderDoc(doc);
      const graded = grader.current.grade(full, grade);
      const url = await uploadRender(graded, node ? `${node.name}-graded` : "graded");
      const at = Date.now();
      const label = PRESETS.find((p) => p.id === preset)?.name ?? "Color grade";
      const natural: [number, number] = [graded.width, graded.height];
      if (node) commit({ ...doc, nodes: doc.nodes.map((n) => (n.id === node.id ? addRevision(n, { src: url, crop: null, natural, label, at }) : n)) });
      else {
        const id = nanoid(8);
        commit(addNodes(doc, [{ id, name: "Color graded", z: 0, x: 0, y: 0, w: doc.width, h: doc.height, rotation: 0, src: url, crop: null, natural, revisions: [{ src: url, crop: null, natural, label, at }], revision: 0 }]));
        select(id);
      }
      setGrade(NEUTRAL);
      setPreset(null);
      toast.success("Grade applied", { duration: 1500 });
    } catch (e) {
      toastError(e, "Couldn't apply the grade");
    } finally {
      setSaving(false);
    }
  };

  const groups = ["Light", "Color", "Split tone", "Effects"] as const;
  return (
    <div className="space-y-4">
      <Scope node={node} />
      <Field label="Looks">
        <Chips
          label="Looks"
          value={preset}
          options={PRESETS.map((p) => p.id)}
          names={(id) => PRESETS.find((p) => p.id === id)?.name ?? id}
          onChange={(id) => {
            const p = PRESETS.find((x) => x.id === id)!;
            setPreset(p.id);
            setGrade(applyPreset(p));
          }}
        />
      </Field>
      {groups.map((g) => (
        <fieldset key={g} className="space-y-2.5">
          <legend className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{g}</legend>
          {CONTROLS.filter((c) => c.group === g).map((c) => (
            <Field key={c.key} label={c.label} hint={grade[c.key]}>
              <Slider aria-label={c.label} min={c.min} max={c.max} step={1} value={[grade[c.key]]} onValueChange={([v]) => setGrade({ ...grade, [c.key]: v })} />
            </Field>
          ))}
        </fieldset>
      ))}
      <div className="sticky bottom-0 flex items-center justify-between gap-2 bg-background pt-2 pb-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setGrade(NEUTRAL);
            setPreset(null);
          }}
          disabled={isNeutral(grade)}
        >
          Reset
        </Button>
        <Button className="rounded-full" onClick={() => void save()} disabled={saving || isNeutral(grade)}>
          {saving && <Loader2 className="animate-spin" />} Apply grade
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Runs in your browser — free on both engines.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The rail

// ---------------------------------------------------------------------------
// Re-render from layers

/**
 * The arrangement painted again as one coherent picture: every visible layer's box and name, and the text read off the
 * picture word for word, as a layout for a model that places boxes (MOSS-Image on both engines; Ideogram 4.5 and FLUX.3 in
 * the cloud). The result lands as a new layer on top.
 */
function RerenderTool() {
  const { doc, jobs, isDemo, endJob, setHighlight } = useEditor();
  const { modelId, model, setModelId } = useToolModel("rerender");
  const detector = useToolModel("text-detect");
  const { busy, go } = useRun();
  const [words, setWords] = useState("");
  const [keepText, setKeepText] = useState(true);
  const job = latestJob(jobs, ["rerender"], null);
  const detect = latestJob(jobs, ["text-detect"], null);
  const detecting = !!detect && isRunning(detect);
  const [text, setText] = useState<{ id: string; lines: PlacedText[] } | null>(null);
  // The lines of the newest reading of the whole picture, placed in the document (as Edit text lists them).
  useEffect(() => {
    if (!detect || detect.result?.status !== "succeeded" || text?.id === detect.id) return;
    const out = detect.result.outputs[0];
    const sent = typeof detect.settings?.image === "string" ? detect.settings.image : undefined;
    const measure = out?.kind === "image" ? out.url : needsDetectedSize(out?.meta) ? sent : undefined;
    let gone = false;
    void (measure ? loadImage(measure).then((img) => sizeOf(img)) : Promise.resolve(undefined))
      .catch(() => undefined)
      .then((natural) => {
        if (gone) return;
        const blocks: TextBlock[] = out ? textBlocksFrom(out.meta, natural) : [];
        setText({ id: detect.id, lines: placeTextBlocks(blocks, detect.frame).map((r) => ({ text: r.from, box: r.box })) });
        if (detect.state === "pending") endJob(detect.id, "applied");
      });
    return () => {
      gone = true;
    };
  }, [detect, endJob, text?.id]);
  useEffect(() => () => setHighlight(null), [setHighlight]);
  const plan = useMemo(() => layersLayout(doc, keepText ? (text?.lines ?? []) : [], words), [doc, keepText, text, words]);
  const { counts } = plan;
  const boxes = counts.layers + counts.text;
  const run = () => void go({ tool: "rerender", target: { kind: "whole" }, modelId, prompt: words.trim() || undefined, settings: { layout: plan.draft }, label: TOOL_LABELS.rerender });
  const read = () => void go({ tool: "text-detect", target: { kind: "whole" }, modelId: detector.modelId, label: "Detect text" });
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <div className="space-y-4">
      <HowItWorks>Paints the whole picture again as one image, with every visible layer where it is now. Each layer&apos;s name says what it is, and text read off the picture is kept word for word. The result arrives as a new layer on top.</HowItWorks>
      <p className="text-[12px] text-muted-foreground" role="status">
        {boxes ? `${plural(counts.layers, "layer")} and ${plural(counts.text, "line")} of text in place` : "Show at least one layer to re-render"}
        {counts.backdrop ? ` · ${plural(counts.backdrop, "backdrop layer")} described in words` : ""}
      </p>
      <Field label="Describe the picture (optional)">
        <Textarea value={words} onChange={(e) => setWords(e.target.value)} rows={3} maxLength={1500} placeholder="e.g. a warm studio product shot, soft window light" className="min-h-20 text-[13px]" aria-label="Describe the picture" />
      </Field>
      {text?.lines.length ? (
        <label className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
          Keep the text word for word ({plural(text.lines.length, "line")})
          <Switch checked={keepText} onCheckedChange={setKeepText} aria-label="Keep the text word for word" />
        </label>
      ) : (
        <div className="space-y-1">
          <Button variant="secondary" size="sm" className="w-full rounded-full" onClick={read} disabled={busy || detecting || !detector.model}>
            {detecting ? <Loader2 className="animate-spin" /> : <Type />} {detecting ? "Reading the text…" : "Read the text first"}
          </Button>
          <p className="text-center font-mono text-[11px] text-muted-foreground">{costLabel(detector.model, isDemo(detector.model))}</p>
          {text && !text.lines.length && <p className="text-center text-[12px] text-muted-foreground">No text was found on this image.</p>}
        </div>
      )}
      <ModelSelect tool="rerender" value={modelId} onChange={setModelId} />
      {model?.engine === "cloud" && model.id !== "moss-image" && <p className="text-[11px] text-pretty text-muted-foreground">{model.name} places the boxes from its prompt; MOSS-Image follows them most closely.</p>}
      <JobState job={job} failedTitle="Couldn't re-render the picture" onRetry={run} />
      <RunRow cost={costLabel(model, isDemo(model))} busy={busy} disabled={!boxes || !model || (!!job && isRunning(job))} onClick={run}>
        <RefreshCw /> Re-render
      </RunRow>
    </div>
  );
}

export function ToolRail() {
  const { tool, openTool, mask, selected, setSplitTarget, jobs } = useEditor();
  const current = TOOLS.find((t) => t.id === tool);
  const running = jobs.filter(isRunning).length;
  return (
    // Below 1280 px the list folds to icons (tooltips name them) so the canvas keeps its room; a tool's form stays readable.
    <aside className={cn("flex min-h-0 shrink-0 flex-col border-r bg-background", current ? "w-[240px] lg:w-[256px] xl:w-[280px]" : "w-[60px] xl:w-[280px]")} aria-label="Tools">
      {current ? (
        <>
          <div className="flex h-12 shrink-0 items-center gap-1 px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to tools"
              onClick={() => {
                openTool(null);
                setSplitTarget(null);
              }}
            >
              <ArrowLeft />
            </Button>
            <current.icon className="size-4 text-brand-text" />
            <h2 className="truncate text-[13px] font-semibold">{current.label}</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <div className="px-3 pt-1 pb-6">
              {tool === "decompose" && <DecomposeTool />}
              {/* Its rows belong to one scope: picking another layer (or the whole image) starts afresh. */}
              {tool === "edit-text" && <EditTextTool key={selected?.id ?? "whole"} />}
              {tool === "remove-bg" && <RemoveBgTool />}
              {tool === "regional" && <RegionalTool />}
              {/* Its painted area belongs to one layer (or the whole image): picking another starts afresh. */}
              {tool === "inpaint" && <InpaintTool key={selected?.id ?? "whole"} />}
              {tool === "upscale" && (
                <SimpleTool tool="upscale" verb="Upscale" failedTitle="Couldn't upscale it">
                  <p className="text-[12px] text-muted-foreground">{selected ? "The layer gets more pixels in the same place on the canvas; switch back any time in its versions." : "The upscaled picture arrives as a new layer on top."}</p>
                </SimpleTool>
              )}
              {tool === "enhance" && <EnhanceTool key={selected?.id ?? "whole"} />}
              {tool === "relight" && <RelightTool />}
              {tool === "angles" && <AnglesTool />}
              {tool === "expand" && <ExpandTool />}
              {tool === "grade" && <GradeTool />}
              {tool === "rerender" && <RerenderTool />}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex h-12 shrink-0 items-center justify-center gap-2 px-3 xl:justify-start">
            <h2 className="hidden text-[13px] font-semibold xl:block">Tools</h2>
            {running > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-faint px-2 py-0.5 text-[11px] font-medium text-brand-text xl:ml-auto" title={`${running} running`}>
                <Loader2 className="size-3 animate-spin" /> {running}
                <span className="hidden xl:inline">running</span>
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <ul className="space-y-0.5 px-2 pb-4">
              {TOOLS.map((t) => (
                <li key={t.id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={!!mask}
                        aria-label={t.label}
                        onClick={() => openTool(t.id)}
                        className="flex w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent xl:px-2.5"
                      >
                        <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
                          <t.icon className="size-4" />
                          {t.isNew && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-highlight ring-2 ring-background xl:hidden" aria-hidden />}
                        </span>
                        <span className="hidden min-w-0 flex-1 xl:block">
                          <span className="flex items-center gap-1.5 text-[13px] font-medium">
                            {t.label}
                            {t.isNew && <span className="rounded-full bg-highlight px-1.5 py-px text-[10px] font-semibold text-highlight-foreground">New</span>}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">{t.hint}</span>
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="xl:hidden">
                      {mask ? "Unavailable while editing a mask" : `${t.label} — ${t.hint}`}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
            <p className="hidden px-4 pb-4 text-[11px] text-pretty text-muted-foreground xl:block">Tools act on the selected layer. Deselect the layer to use a tool on the whole image.</p>
          </div>
        </>
      )}
    </aside>
  );
}
