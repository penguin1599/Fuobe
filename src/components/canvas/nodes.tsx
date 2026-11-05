"use client";

import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  AudioLines,
  Box,
  Cable,
  Check,
  Cloud,
  Copy,
  Cpu,
  Download,
  ImagePlus,
  Library,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  Upload,
  Volume2,
  VolumeX,
  Table,
  LayoutDashboard,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LanguageChip, SliderControls } from "@/components/studio/audio-controls";
import { downloadName } from "@/components/studio/feed";
import { fileToSlot, type SlotValue } from "@/components/studio/media-slot";
import { ControlsChip } from "@/components/studio/model-controls";
import { ModelPicker } from "@/components/studio/model-picker";
import { ResponsivePanel } from "@/components/studio/responsive-panel";
import { VoiceRecorder } from "@/components/studio/voice-recorder";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAssets, useClipFacts as useFileFacts, useElements, useModelAccess } from "@/lib/api";
import { offered } from "@/lib/model-access";
import { dualEngine, onEngine } from "@/lib/catalog/engines";
import {
  CANVAS_TEXT_MAX,
  cameraPathOf,
  CONCAT_LIMITS,
  CONCAT_MODELS,
  CONCAT_RATIOS,
  CONCAT_SIZE,
  concatClips,
  concatRatio,
  connectionError,
  defaultModelFor,
  EMPTY_GRAPH,
  inputPorts,
  isGenerator,
  modelChoices,
  NODE_SPECS,
  nodeLabel,
  nodeModel,
  nodeOps,
  OPEN_DUB_HINT,
  OUT,
  outputLabel,
  TABLE_LIMITS,
  tableRows,
  outputType,
  PORT_TYPE_LABEL,
  PREVIEW_IN,
  promptPlaceholder,
  SPLIT_OUTPUTS,
  sanitizeParams,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type ClipSettings,
  type Connection,
  type PortDef,
  type PortType,
} from "@/lib/catalog/canvas";
import { OPERATION_LABELS, type Engine, type MediaKind, type ModelDef, type OutputFile } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import { dubResult, languageStage, type DubSessionView, type DubStage } from "@/lib/av/dub";
import { DUB_LANGUAGES, supportsTarget } from "@/lib/av/languages";
import { matchSpokenLanguage, spokenLanguageName, spokenLanguageOptions } from "@/lib/speech-languages";
import { keyCombo } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { responseError, toastError } from "@/lib/refusals";
import { KIND_COLOR } from "@/lib/layout-edit";
import { readLayout, readsBoxes, type LayoutDraft } from "@/lib/layout-prompt";
import { layoutCanvas } from "@/lib/catalog/plan";
import { getModel } from "@/lib/catalog";
import type { EditorCanvas } from "@/components/studio/layout-editor";
import { BOARD_NODE_TYPES, type BoardType } from "./board";
import { KineticNodeBody } from "./kinetic-node";
import { ExactOrbitControls } from "@/components/exact-orbit-controls";
import { PATH_PRESETS } from "@/lib/camera-path";
import { exactDefaults } from "@/lib/exact-orbit";
import { EXAMPLE_FEATURE, NodeIcon, PORT_COLOR, useEditorActions, useEditorGlobals, useEditorSelector, useNodeResults, useNodeView, type EditorSnapshot, type NodeResults } from "./canvas-context";

/** A node on the board: a graph node, or a group, comment pin or drawing (./board.tsx). */
export type FlowNode = Node<CanvasNodeData, CanvasNodeType | BoardType>;

/** Interactive controls inside a node must not drag the node or zoom the board. */
const NO_DRAG = "nodrag nopan nowheel";
const chip = cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 text-[12px] font-medium text-secondary-foreground transition-colors hover:bg-accent", NO_DRAG);

function asNode(id: string, type: CanvasNodeType, data: CanvasNodeData): CanvasNode {
  return { id, type, data, position: { x: 0, y: 0 } };
}

/**
 * Nodes re-render when their own data or selection changes, not on every drag frame or size
 * measurement (what they show from the rest of the board comes from the editor store).
 */
const sameNodeProps = (a: NodeProps<FlowNode>, b: NodeProps<FlowNode>) => a.id === b.id && a.type === b.type && a.data === b.data && a.selected === b.selected;

// ---------------------------------------------------------------------------
// Handles

function InPort({ port, count }: { port: PortDef; count: number }) {
  return (
    <div className="relative flex h-6 items-center gap-1.5 pr-3 pl-3.5 text-[11px] text-muted-foreground">
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        className="canvas-handle"
        style={{ "--port": PORT_COLOR[port.type] } as React.CSSProperties}
        aria-label={`${port.label} input (${PORT_TYPE_LABEL[port.type]})`}
      />
      <span className={cn("font-medium", count > 0 && "text-foreground")}>{port.label}</span>
      {count > 0 && port.multiple && <span className="font-mono text-muted-foreground">{count}</span>}
    </div>
  );
}

function OutPort({ type }: { type: PortType }) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={OUT}
      className="canvas-handle canvas-handle-out"
      style={{ "--port": PORT_COLOR[type] } as React.CSSProperties}
      aria-label={`${PORT_TYPE_LABEL[type]} output`}
      title={`${PORT_TYPE_LABEL[type]} out — drag to connect`}
    />
  );
}

/**
 * Split soundtrack's four outputs, one row each, every one carrying its stem on. A hidden OUT sits on Dialogue: an edge
 * saved before the node had four outputs (or made by "Connect output to…") draws from there and carries the dialogue.
 */
function StemOutPorts() {
  return (
    <div className="border-t py-1" role="group" aria-label="Outputs">
      {SPLIT_OUTPUTS.map((o, k) => (
        <div key={o.id} className="relative flex h-6 items-center justify-end gap-1.5 pr-3.5 pl-3 text-[11px] text-muted-foreground">
          <span className="font-medium">{o.label}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={o.id}
            className="canvas-handle canvas-handle-out"
            style={{ "--port": PORT_COLOR.audio } as React.CSSProperties}
            aria-label={`${o.label} output (Audio)`}
            title={`${o.label} out — drag to connect`}
          />
          {k === 0 && <Handle type="source" position={Position.Right} id={OUT} isConnectable={false} className="canvas-handle pointer-events-none opacity-0" aria-hidden tabIndex={-1} />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menus: the ⋯ button and right-click show the same items (keyboard users get Rename, Connect and Disconnect)

interface MenuItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  shortcut?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

interface MenuKit {
  Item: typeof DropdownMenuItem;
  Separator: typeof DropdownMenuSeparator;
  Shortcut: typeof DropdownMenuShortcut;
  Sub: typeof DropdownMenuSub;
  SubTrigger: typeof DropdownMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent;
}

const DROPDOWN: MenuKit = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Shortcut: DropdownMenuShortcut, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };
const CONTEXT = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
} as unknown as MenuKit;

const byBoardPosition = (a: CanvasNode, b: CanvasNode) => a.position.x - b.position.x || a.position.y - b.position.y;

function portLabel(n: CanvasNode | undefined, handle: string | null | undefined): string {
  if (!n) return "";
  if (n.type === "output") return "Preview";
  return inputPorts(n).find((p) => p.id === handle)?.label ?? handle ?? "";
}

/** "Connect output to…": every input on the board this node's output may go into. */
function ConnectItems({ id, kit }: { id: string; kit: MenuKit }) {
  const actions = useEditorActions();
  const graph = actions.getGraph();
  const options: { key: string; label: string; c: Connection }[] = [];
  for (const t of [...graph.nodes].sort(byBoardPosition)) {
    if (t.id === id || t.type === "note") continue;
    const handles = t.type === "output" ? [PREVIEW_IN] : inputPorts(t).map((p) => p.id);
    for (const h of handles) {
      const c: Connection = { source: id, sourceHandle: OUT, target: t.id, targetHandle: h };
      if (graph.edges.some((e) => e.source === id && e.target === t.id && e.targetHandle === h) || connectionError(graph, c)) continue;
      options.push({ key: `${t.id}:${h}`, label: `${nodeLabel(t)} · ${portLabel(t, h)}`, c });
    }
  }
  if (!options.length) return <kit.Item disabled>Nothing on the board takes this output</kit.Item>;
  return (
    <>
      {options.map((o) => (
        <kit.Item key={o.key} onSelect={() => actions.connect(o.c)}>
          {o.label}
        </kit.Item>
      ))}
    </>
  );
}

/** "Disconnect": this node's connections, in and out. */
function DisconnectItems({ id, kit }: { id: string; kit: MenuKit }) {
  const actions = useEditorActions();
  const graph: CanvasGraph = actions.getGraph();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const self = byId.get(id);
  const edges: CanvasEdge[] = graph.edges.filter((e) => e.source === id || e.target === id);
  if (!edges.length) return <kit.Item disabled>No connections yet</kit.Item>;
  return (
    <>
      {edges.map((e) => {
        const incoming = e.target === id;
        const other = byId.get(incoming ? e.source : e.target);
        const from = incoming ? "" : outputLabel(self, e.sourceHandle);
        const label = incoming ? `${portLabel(self, e.targetHandle)} ← ${other ? nodeLabel(other) : "?"}` : `${from ? `${from} ` : ""}→ ${other ? nodeLabel(other) : "?"} · ${portLabel(other, e.targetHandle)}`;
        return (
          <kit.Item key={e.id} onSelect={() => actions.disconnect(e.id)}>
            {label}
          </kit.Item>
        );
      })}
    </>
  );
}

function MenuItems({ id, kit, items, canConnect, onRename }: { id: string; kit: MenuKit; items: MenuItem[]; canConnect: boolean; onRename: () => void }) {
  const actions = useEditorActions();
  const entry = (m: MenuItem) => (
    <div key={m.label}>
      {m.separatorBefore && <kit.Separator />}
      <kit.Item onSelect={m.onSelect} variant={m.destructive ? "destructive" : "default"}>
        <m.icon className="size-4" />
        {m.label}
        {m.shortcut && <kit.Shortcut>{m.shortcut}</kit.Shortcut>}
      </kit.Item>
    </div>
  );
  return (
    <>
      {items.map(entry)}
      {items.length > 0 && <kit.Separator />}
      <kit.Item onSelect={onRename}>
        <Pencil className="size-4" />
        Rename
      </kit.Item>
      {canConnect && (
        <kit.Sub>
          <kit.SubTrigger>
            <Cable className="size-4" />
            Connect output to…
          </kit.SubTrigger>
          <kit.SubContent className="max-h-80 w-64 overflow-y-auto">
            <ConnectItems id={id} kit={kit} />
          </kit.SubContent>
        </kit.Sub>
      )}
      <kit.Sub>
        <kit.SubTrigger>
          <Unplug className="size-4" />
          Disconnect
        </kit.SubTrigger>
        <kit.SubContent className="max-h-80 w-64 overflow-y-auto">
          <DisconnectItems id={id} kit={kit} />
        </kit.SubContent>
      </kit.Sub>
      {entry({ label: "Duplicate", icon: Copy, onSelect: () => actions.duplicate(id), shortcut: keyCombo("D"), separatorBefore: true })}
      {entry({ label: "Delete", icon: Trash2, onSelect: () => actions.remove(id), shortcut: "⌫", destructive: true })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell: header (icon, title, badges, menu), body, footer

function EditableTitle({
  value,
  placeholder,
  onChange,
  readOnly,
  editing,
  setEditing,
}: {
  value?: string;
  placeholder: string;
  onChange: (v: string | undefined) => void;
  readOnly: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [wasEditing, setWasEditing] = useState(false);
  // Opening the editor (double-click or the menu's Rename) starts from the current name.
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) setDraft(value ?? placeholder);
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={80}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          onChange(draft.trim() || undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
          e.stopPropagation();
        }}
        aria-label="Node name"
        className={cn("h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[13px] font-semibold outline-none focus:border-primary", NO_DRAG)}
      />
    );
  }
  return (
    <span
      className="min-w-0 flex-1 truncate text-[13px] font-semibold"
      onDoubleClick={(e) => {
        if (readOnly) return;
        e.stopPropagation();
        setEditing(true);
      }}
      title={readOnly ? undefined : "Double-click to rename"}
    >
      {value || placeholder}
    </span>
  );
}

function NodeShell({
  id,
  type,
  data,
  selected,
  out,
  badge,
  menu = [],
  footer,
  children,
  width = 300,
  tone,
}: {
  id: string;
  type: CanvasNodeType;
  data: CanvasNodeData;
  selected: boolean;
  out?: PortType | null;
  badge?: React.ReactNode;
  menu?: MenuItem[];
  footer?: React.ReactNode;
  children?: React.ReactNode;
  width?: number;
  tone?: "running" | "failed" | "note";
}) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  const [renaming, setRenaming] = useState(false);
  // Rename opens the title field once the menu has closed (an open menu keeps the focus), and the
  // menu doesn't hand the focus back to its trigger then.
  const wantRename = useRef(false);
  const rename = () => {
    wantRename.current = true;
  };
  const keepFocus = (e: Event) => {
    if (!wantRename.current) return;
    wantRename.current = false;
    e.preventDefault();
    setRenaming(true);
  };
  const placeholder = nodeLabel({ type, data: { ...data, label: undefined } });
  const label = data.label || placeholder;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={readOnly}>
        <div
          className={cn(
            "group/node rounded-xl border bg-card text-card-foreground shadow-soft transition-[box-shadow,border-color]",
            selected && "border-primary ring-4 ring-brand-faint",
            tone === "running" && !selected && "border-primary/50",
            tone === "failed" && !selected && "border-destructive/50",
            tone === "note" && "border-highlight/70 bg-highlight/15",
          )}
          style={{ width }}
          data-testid={`canvas-node-${id}`}
        >
          <div className="relative flex h-10 items-center gap-2 border-b px-3">
            <NodeIcon name={NODE_SPECS[type].icon} className="size-4 shrink-0 text-muted-foreground" />
            <EditableTitle value={data.label} placeholder={placeholder} onChange={(l) => actions.update(id, { label: l })} readOnly={readOnly} editing={renaming} setEditing={setRenaming} />
            {badge}
            {!readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={cn("-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", NO_DRAG)} aria-label={`Actions for ${label}`}>
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={keepFocus}>
                  <MenuItems id={id} kit={DROPDOWN} items={menu} canConnect={!!out} onRename={rename} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {out && type !== "split-soundtrack" && <OutPort type={out} />}
          </div>
          {children}
          {type === "split-soundtrack" && <StemOutPorts />}
          {footer}
        </div>
      </ContextMenuTrigger>
      {!readOnly && (
        <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocus}>
          <MenuItems id={id} kit={CONTEXT} items={menu} canConnect={!!out} onRename={rename} />
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Results

function OutputThumb({ o, onOpen, className, large }: { o: OutputFile; onOpen: () => void; className?: string; large?: boolean }) {
  const media = cn("w-full object-cover", large ? "max-h-80" : "max-h-44");
  if (o.kind === "text") {
    return (
      <button onClick={onOpen} className={cn("block w-full rounded-lg bg-muted p-2.5 text-left text-[12px] leading-snug whitespace-pre-line", NO_DRAG, className)}>
        <span className="line-clamp-6">{o.text ?? "Text result"}</span>
      </button>
    );
  }
  if (o.kind === "model3d") {
    return (
      <button onClick={onOpen} className={cn("flex h-20 w-full items-center justify-center gap-2 rounded-lg bg-muted text-[12px] font-medium text-muted-foreground hover:text-foreground", NO_DRAG, className)}>
        <Box className="size-4" /> 3D model
      </button>
    );
  }
  if (o.kind === "audio") {
    return (
      <div className={cn("flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg bg-brand-faint p-2 text-brand-text", NO_DRAG, className)}>
        <AudioLines className="size-4 shrink-0" />
        <audio src={o.url} controls preload="metadata" className="h-8 w-full min-w-0 flex-1" />
      </div>
    );
  }
  return (
    <button onClick={onOpen} className={cn("block w-full overflow-hidden rounded-lg bg-muted", NO_DRAG, className)} aria-label="Open result">
      {o.kind === "video" ? (
        <video
          src={`${o.url}#t=0.1`}
          poster={typeof o.meta?.poster === "string" ? o.meta.poster : undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
          onMouseLeave={(e) => e.currentTarget.pause()}
          className={media}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={o.url} alt="" loading="lazy" className={media} />
      )}
    </button>
  );
}

function Results({ id, r, compact }: { id: string; r: NodeResults; compact?: boolean }) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  if (r.state === "queued" || r.state === "running") {
    const pct = r.progress != null ? Math.round(r.progress * 100) : null;
    return (
      <div className="relative overflow-hidden rounded-lg bg-muted" style={{ height: compact ? 56 : 96 }}>
        <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2.5">
          <p className="shimmer-text animate-shimmer-text truncate text-[12px] font-medium">{r.message ?? (r.state === "queued" ? "Queued" : "Generating…")}</p>
          {pct != null && <span className="font-mono text-[11px] text-muted-foreground">{pct}%</span>}
        </div>
        {pct != null && <div className="absolute inset-x-0 top-0 h-0.5 bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(pct) / 100})` }} />}
      </div>
    );
  }
  if (r.state === "failed" || r.state === "canceled") {
    return (
      <div className="rounded-lg border border-dashed p-2.5">
        <p className="text-[12px] font-medium">{r.state === "canceled" ? "Canceled" : "Couldn't generate this"}</p>
        {r.error && <p className="mt-0.5 line-clamp-4 text-[12px] leading-snug break-words text-muted-foreground">{r.error}</p>}
        {!readOnly && (
          <button onClick={() => actions.run([id], true)} className={cn(chip, "mt-2")}>
            <RotateCcw className="size-3" /> Retry
          </button>
        )}
      </div>
    );
  }
  if (!r.outputs.length) return null;
  const shown = r.outputs.slice(0, 4);
  return (
    <div className={cn("grid gap-1.5", shown.length > 1 ? "grid-cols-[repeat(2,minmax(0,1fr))]" : "grid-cols-[minmax(0,1fr)]")}>
      {shown.map((x, k) => (
        <OutputThumb key={`${x.g.id}-${x.i}`} o={x.o} onOpen={() => actions.open(id, k)} />
      ))}
      {r.outputs.length > 4 && <p className="col-span-2 text-[11px] text-muted-foreground">+{r.outputs.length - 4} more — open to see them all</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generator nodes (any model, and the utilities)

/**
 * A compact select. Its options mount only while it's open (a closed Radix Select still renders
 * every item, which adds up to thousands on a big board); the trigger shows the value itself.
 */
function OptionSelect<T extends string | number>({ value, options, onChange, label, format }: { value: T | undefined; options: T[]; onChange: (v: T) => void; label: string; format?: (v: T) => string }) {
  const [open, setOpen] = useState(false);
  const text = (v: T) => (format ? format(v) : String(v));
  return (
    <Select open={open} onOpenChange={setOpen} value={value === undefined ? undefined : String(value)} onValueChange={(v) => onChange((typeof options[0] === "number" ? Number(v) : v) as T)}>
      <SelectTrigger size="sm" aria-label={label} className={cn("h-7 gap-1 rounded-full border-0 bg-secondary px-2.5 text-[12px] font-medium shadow-none hover:bg-accent dark:bg-secondary", NO_DRAG)}>
        <SelectValue placeholder={label}>{value === undefined ? undefined : text(value)}</SelectValue>
      </SelectTrigger>
      {open && (
        <SelectContent className="max-h-72">
          {options.map((o) => (
            <SelectItem key={String(o)} value={String(o)} className="text-[13px]">
              {text(o)}
            </SelectItem>
          ))}
        </SelectContent>
      )}
    </Select>
  );
}

function ModelOptions({ id, model, data }: { id: string; model: ModelDef; data: CanvasNodeData }) {
  const actions = useEditorActions();
  const p = data.params ?? {};
  const o = model.options;
  const d = model.defaults ?? {};
  const set = (patch: Partial<NonNullable<CanvasNodeData["params"]>>) => actions.update(id, { params: { ...p, ...patch } });
  const extra = (p.extra ?? {}) as Record<string, unknown>;
  const setExtra = (param: string, v?: string | number) => {
    const next = { ...extra };
    if (v === undefined) delete next[param];
    else next[param] = v;
    set({ extra: Object.keys(next).length ? (next as Record<string, string | number>) : undefined });
  };
  const text = model.kind === "text";
  const items: React.ReactNode[] = [];
  if (o.aspectRatios?.length) items.push(<OptionSelect key="ar" label="Aspect ratio" value={p.aspectRatio ?? d.aspectRatio} options={o.aspectRatios} onChange={(v) => set({ aspectRatio: v })} />);
  if (o.durations?.length && o.durations.length > 1) items.push(<OptionSelect key="dur" label="Duration" value={p.duration ?? d.duration} options={o.durations} onChange={(v) => set({ duration: v })} format={(v) => `${v}s`} />);
  if (o.resolutions?.length && o.resolutions.length > 1) items.push(<OptionSelect key="res" label="Quality" value={p.resolution ?? d.resolution} options={o.resolutions} onChange={(v) => set({ resolution: v })} />);
  if ((o.maxOutputs ?? 1) > 1) items.push(<OptionSelect key="n" label="Count" value={p.numOutputs ?? 1} options={Array.from({ length: Math.min(4, o.maxOutputs!) }, (_, i) => i + 1)} onChange={(v) => set({ numOutputs: v })} format={(v) => `×${v}`} />);
  if (o.voices?.length) items.push(<OptionSelect key="voice" label="Voice" value={p.voice ?? d.voice ?? o.voices[0].id} options={o.voices.map((v) => v.id)} onChange={(v) => set({ voice: v })} format={(v) => o.voices!.find((x) => x.id === v)?.name ?? v} />);
  // A text model writes; picking a language makes it translate (Auto), and "Don't translate" goes back to writing.
  if (o.languages?.length && !(text && data.op === "write")) {
    items.push(<LanguageChip key="lang" languages={o.languages} value={p.targetLanguage} onChange={(v) => set({ targetLanguage: v })} label={text ? "Translate to…" : "Language"} />);
    if (text && p.targetLanguage && data.op !== "translate")
      items.push(
        <button key="lang-x" className={chip} onClick={() => set({ targetLanguage: undefined })}>
          <X className="size-3" /> Don&apos;t translate
        </button>,
      );
  }
  // Transcribers: the language of the speech, detected unless you pick one.
  if (o.sourceLanguages?.length) {
    const listed = spokenLanguageOptions(o.sourceLanguages).map((l) => l.code);
    // A stored language the model doesn't list (or lists by another code) shows as what is sent.
    const value = p.sourceLanguage ? (matchSpokenLanguage(p.sourceLanguage, listed) ?? p.sourceLanguage) : "auto";
    const codes = ["auto", ...(listed.includes(value) || value === "auto" ? [] : [value]), ...listed];
    items.push(
      <OptionSelect
        key="spoken"
        label="Spoken language"
        value={value}
        options={codes}
        onChange={(v) => set({ sourceLanguage: v === "auto" ? undefined : v })}
        format={(v) => (v === "auto" ? "Detect language" : spokenLanguageName(v))}
      />,
    );
  }
  if (o.audio === true)
    items.push(
      <button key="audio" onClick={() => set({ generateAudio: !(p.generateAudio ?? d.generateAudio ?? false) })} className={cn(chip, (p.generateAudio ?? d.generateAudio) && "bg-brand-faint text-brand-text hover:bg-brand-faint-hover")} aria-pressed={!!(p.generateAudio ?? d.generateAudio)}>
        <AudioLines className="size-3" /> Sound
      </button>,
    );
  if (o.sliders?.length) items.push(<div key="sliders" className={NO_DRAG}><SlidersChip model={model} values={extra} onChange={setExtra} /></div>);
  if (o.controls?.length) items.push(<div key="controls" className={NO_DRAG}><ControlsChip controls={o.controls} values={extra} onChange={setExtra} op={data.op} /></div>);
  if (!items.length) return null;
  return <div className={cn("flex flex-wrap gap-1 [&_button]:h-7 [&_button]:text-[12px]", NO_DRAG)}>{items}</div>;
}

/** A model's numeric settings behind one chip (the studio composer shows them in its settings panel). */
function SlidersChip({ model, values, onChange }: { model: ModelDef; values: Record<string, unknown>; onChange: (param: string, v?: number) => void }) {
  const changed = (model.options.sliders ?? []).filter((s) => typeof values[s.param] === "number" && values[s.param] !== s.default).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, changed > 0 && "bg-brand-faint text-brand-text hover:bg-brand-faint-hover")}>
          <SlidersHorizontal className="size-3" /> {changed ? `Settings · ${changed}` : "Settings"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start" side="top">
        <SliderControls model={model} values={values} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

function EngineBadge({ model }: { model?: ModelDef }) {
  if (!model) return null;
  const open = model.engine === "open";
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold", open ? "bg-success/15 text-success" : "bg-brand-faint text-brand-text")}>
      {open ? <Cpu className="size-3" /> : <Cloud className="size-3" />}
      {open ? "Open source" : "Cloud"}
    </span>
  );
}

function costLabel(isDemo: (m: ModelDef) => boolean, model: ModelDef | undefined, cost: number | null): string {
  if (!model) return "";
  if (isDemo(model)) return "Placeholder · free";
  if (model.engine === "open") return "Free · your GPU";
  return cost == null ? "Price unknown" : cost === 0 ? "Free" : `≈ ${formatCost(cost)}`;
}

const GeneratorNode = memo(function GeneratorNode({ id, type: flowType, data, selected }: NodeProps<FlowNode>) {
  const type = flowType as CanvasNodeType;
  const actions = useEditorActions();
  const g = useEditorGlobals();
  const v = useNodeView(id);
  const node = useMemo(() => asNode(id, type, data), [id, type, data]);
  // A Fuobe Original as it runs on this node's engine (its routes and price).
  const model = useMemo(() => nodeModel(node, g.mode), [node, g.mode]);
  const ports = useMemo(() => inputPorts(node), [node]);
  const out = outputType(EMPTY_GRAPH, node);
  const r = v.results;
  const ops = useMemo(() => nodeOps(node, model), [node, model]);
  const auto = type === "model" && ops.length > 1;
  // The picker opens on the node's own engine (or the install's only one); its switch browses the other.
  const [browseEngine, setBrowseEngine] = useState<Engine | null>(null);
  const pickerEngine: Engine = g.mode !== "both" ? g.mode : (browseEngine ?? model?.engine ?? g.engine);
  // A Fuobe Original is listed on the engine being browsed (it runs on both). Models switched off in Settings →
  // Models & licences aren't offered (a node already on one says so when it runs).
  const access = useModelAccess();
  const choices = useMemo(
    () =>
      modelChoices(node)
        .filter((m) => offered(access, m.id, pickerEngine))
        .map((m) => onEngine(m, pickerEngine)),
    [node, pickerEngine, access],
  );
  const error = v.runError ?? v.error;

  // Handles change with the model and op: tell React Flow to re-measure them (React Flow measures new nodes itself).
  const updateInternals = useUpdateNodeInternals();
  const portKey = `${ports.map((p) => p.id).join(",")}|${out}`;
  const measuredKey = useRef(portKey);
  useEffect(() => {
    if (measuredKey.current === portKey) return;
    measuredKey.current = portKey;
    updateInternals(id);
  }, [id, portKey, updateInternals]);

  const pickModel = (m: ModelDef) => {
    const keepOp = data.op && m.routes.some((x) => x.op === data.op) ? data.op : undefined;
    // A Fuobe Original runs on the engine it was picked on.
    actions.update(id, { modelId: m.id, op: keepOp, params: sanitizeParams(m, data.params), engine: dualEngine(m) ? m.engine : undefined });
    setBrowseEngine(null);
  };

  // Upscale / Remove background: image or video. Translate: text or video.
  const spec = NODE_SPECS[type];
  const variants = spec.ops && spec.variants ? spec.variants : null;
  const setVariant = (kind: MediaKind) => {
    const op = spec.ops![kind === variants![1] ? 1 : 0];
    const engine = model?.engine ?? g.engine;
    const m = defaultModelFor(op, engine, { hidden: true }) ?? (g.mode === "both" ? defaultModelFor(op, engine === "open" ? "cloud" : "open", { hidden: true }) : undefined);
    actions.update(id, { mediaKind: kind, modelId: m?.id, op: undefined, params: undefined });
  };

  const running = r.state === "running" || r.state === "queued";
  // A pinned node never runs: its menu offers the unpin instead of Run.
  const menu: MenuItem[] = [
    ...(data.pinned
      ? []
      : [
          { label: "Run node", icon: Play, onSelect: () => actions.run([id]) },
          { label: "Re-run", icon: RotateCcw, onSelect: () => actions.run([id], true) },
        ]),
    ...(running ? [{ label: "Cancel", icon: Square, onSelect: () => actions.cancel(id) }] : []),
    { label: data.pinned ? "Unpin result" : "Pin result", icon: data.pinned ? PinOff : Pin, onSelect: () => actions.update(id, { pinned: !data.pinned }), separatorBefore: !data.pinned },
    ...(r.outputs.some((x) => ["image", "video", "audio"].includes(x.o.kind)) ? [{ label: "Use result as an input", icon: ImagePlus, onSelect: () => actions.toInput(id) }] : []),
    ...(r.outputs.length
      ? [
          {
            label: r.outputs.length > 1 ? "Download first result" : "Download result",
            icon: Download,
            onSelect: () => {
              const { g: gen, o, i } = r.outputs[0];
              const a = document.createElement("a");
              a.href = `${o.url}?download=${encodeURIComponent(downloadName(gen, o, i))}`;
              a.click();
            },
          },
        ]
      : []),
  ];
  const promptPort = ports.find((p) => p.id === "prompt");
  // With text wired in, the node's own words are optional: keep the box folded until wanted.
  const [addWords, setAddWords] = useState(false);
  const showPrompt = !!promptPort && (!v.counts.prompt || !!data.prompt || addWords);
  const step = v.step;
  // A ready board's last step on a visitor's board shows the board's published example until it is changed.
  const example = !!g.visitor && r.outputs[0]?.g.feature === EXAMPLE_FEATURE;
  const stateHint = data.pinned
    ? "Pinned"
    : running
      ? "Running"
      : step === "changed"
        ? "Changed"
        : example
          ? "Example"
          : r.state === "failed"
            ? "Failed"
            : r.state === "canceled"
              ? "Canceled"
              : step === "upstream"
                ? "Inputs changed"
                : step
                  ? "Not run yet"
                  : v.reused
                    ? "Up to date"
                    : "";

  return (
    <NodeShell
      id={id}
      type={type}
      data={data}
      selected={!!selected}
      out={out}
      menu={menu}
      tone={running ? "running" : r.state === "failed" ? "failed" : undefined}
      badge={
        <>
          {data.pinned && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Pin className="size-3.5 shrink-0 text-brand-text" aria-label="Pinned" />
              </TooltipTrigger>
              <TooltipContent>Pinned: runs reuse this result</TooltipContent>
            </Tooltip>
          )}
          <EngineBadge model={model} />
        </>
      }
      footer={
        <div className="flex h-10 items-center gap-2 border-t px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {[stateHint, !g.visitor && (step || r.state === "idle") ? costLabel(g.isDemo, model, v.costUsd) : ""].filter(Boolean).join(" · ")}
          </span>
          {!g.readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => (running ? actions.cancel(id) : data.pinned ? actions.update(id, { pinned: false }) : actions.run([id], !step && v.reused))}
                  disabled={g.running && !running}
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50",
                    running || data.pinned ? "bg-muted text-foreground hover:bg-accent" : "bg-primary text-primary-foreground hover:bg-primary/90",
                    NO_DRAG,
                  )}
                  aria-label={running ? "Cancel" : data.pinned ? "Unpin result" : step ? "Run node" : "Run node again"}
                >
                  {running ? <Square className="size-3" /> : data.pinned ? <PinOff className="size-3.5" /> : step ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{running ? "Cancel" : data.pinned ? "Unpin to run it again" : step ? "Run this node (and what it needs)" : "Run it again"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      }
    >
      {ports.length > 0 && <div className="border-b py-1">{ports.map((p) => <InPort key={p.id} port={p} count={v.counts[p.id] ?? 0} />)}</div>}
      <div className="space-y-2 p-3">
        {variants && (
          <div className={cn("inline-grid h-7 grid-cols-2 rounded-full bg-muted p-0.5 text-[12px] font-medium", NO_DRAG)} role="radiogroup" aria-label={`${variants[0]} or ${variants[1]}`}>
            {variants.map((k) => (
              <button key={k} role="radio" aria-checked={(data.mediaKind ?? variants[0]) === k} disabled={g.readOnly} onClick={() => setVariant(k)} className={cn("rounded-full px-2.5 capitalize", (data.mediaKind ?? variants[0]) === k ? "bg-background shadow-soft" : "text-muted-foreground")}>
                {k}
              </button>
            ))}
          </div>
        )}
        {type === "concat" ? (
          <ConcatPanel id={id} data={data} engine={model?.engine} />
        ) : v.error === OPEN_DUB_HINT ? null : (
        <div className={cn("flex flex-wrap items-center gap-1.5 [&>button]:h-7 [&>button]:text-[12px]", g.readOnly && "pointer-events-none")}>
          {choices.length ? (
            <div className={NO_DRAG}>
              <ModelPicker models={choices} value={model} onChange={pickModel} engine={pickerEngine} onEngineChange={setBrowseEngine} />
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{type === "translate" ? "No open-source dubbing model yet." : "No model for this yet."}</p>
          )}
          {auto && model && (
            <OptionSelect
              label="Operation"
              value={data.op ?? "__auto"}
              options={["__auto", ...ops]}
              onChange={(o) => actions.update(id, { op: o === "__auto" ? undefined : (o as (typeof ops)[number]) })}
              format={(o) => (o === "__auto" ? `Auto${v.op ? ` · ${OPERATION_LABELS[v.op]}` : ""}` : OPERATION_LABELS[o as keyof typeof OPERATION_LABELS])}
            />
          )}
        </div>
        )}
        {promptPort && !showPrompt && !g.readOnly && (
          <button className={chip} onClick={() => setAddWords(true)}>
            <Plus className="size-3" /> Add your own words
          </button>
        )}
        {showPrompt && (
          <textarea
            value={data.prompt ?? ""}
            onChange={(e) => actions.update(id, { prompt: e.target.value })}
            onBlur={() => !data.prompt && setAddWords(false)}
            autoFocus={addWords && !data.prompt}
            readOnly={g.readOnly}
            rows={2}
            maxLength={CANVAS_TEXT_MAX}
            placeholder={promptPlaceholder(v.op ?? ops[0])}
            aria-label={`${promptPort.label} for ${data.label || nodeLabel(node)}`}
            className={cn("field-sizing-content max-h-36 min-h-14 w-full resize-none rounded-lg bg-muted px-2.5 py-2 text-[13px] leading-snug outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-brand-faint", NO_DRAG)}
          />
        )}
        {model && !g.readOnly && type !== "concat" && <ModelOptions id={id} model={model} data={data} />}
        {v.rows && (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Table className="size-3.5 shrink-0" /> Runs once per table row: {v.rows === 1 ? "1 run" : `${v.rows} runs`}
          </p>
        )}
        <Results id={id} r={r} />
        {error && r.state !== "failed" && (
          <p className={cn("flex items-start gap-1.5 text-[12px] leading-snug", v.runError ? "text-destructive" : "text-warning")}>
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
        {error === OPEN_DUB_HINT && !g.readOnly && <OpenDub id={id} data={data} />}
      </div>
    </NodeShell>
  );
}, sameNodeProps);

// ---------------------------------------------------------------------------
// Translate a video on the open engine: the dub is made step by step in Translate & dub (the translation is
// reviewed before it's spoken), so the node starts it there with its clip and language.

const OPEN_DUB_LANGUAGES = DUB_LANGUAGES.filter((l) => supportsTarget("open", l));

const selectVideoIn = (s: EditorSnapshot, id: string): string | undefined => {
  const e = s.graph.edges.find((x) => x.target === id && x.targetHandle === "video");
  const src = e && s.byId.get(e.source);
  if (!src) return undefined;
  return src.type === "video-input" ? src.data.url : s.views.get(src.id)?.results.outputs.find((x) => x.o.kind === "video")?.o.url;
};

/** Whether an input node on the board already holds this file (the dub brought back once). */
const selectHasFile = (s: EditorSnapshot, url: string) => !!url && s.graph.nodes.some((n) => n.data.url === url);

const DUB_STAGE: Record<DubStage, string> = {
  preparing: "Transcribing and translating…",
  review: "Ready for you to check the translation",
  voicing: "Speaking the translation…",
  done: "Dubbed",
  failed: "The dub failed — open it to retry",
};

function OpenDub({ id, data }: { id: string; data: CanvasNodeData }) {
  const actions = useEditorActions();
  const video = useEditorSelector(selectVideoIn, id);
  const lang = data.params?.targetLanguage && OPEN_DUB_LANGUAGES.some((l) => l.code === data.params?.targetLanguage) ? data.params.targetLanguage : undefined;
  const [busy, setBusy] = useState(false);
  // The dub this node started, while it's still for this clip and language (its result comes back to the board from here).
  const session = useQuery({
    queryKey: ["dub", data.dubId],
    enabled: !!data.dubId,
    queryFn: async () => {
      const res = await fetch(`/api/dub/${data.dubId}`);
      if (!res.ok) throw Object.assign(new Error("gone"), { status: res.status });
      return (await res.json()) as DubSessionView;
    },
    refetchInterval: (q) => {
      const s = q.state.data;
      const stage = s && lang ? languageStage(s, lang) : undefined;
      // Waiting on a step: every 5 s. Waiting on the person (the review, in Translate & dub): now and then.
      return stage === "preparing" || stage === "voicing" ? 5000 : stage === "review" ? 15_000 : false;
    },
    retry: false,
  }).data;
  const current = session && lang && session.video === video && session.targets.includes(lang) ? session : undefined;
  const stage = current && lang ? languageStage(current, lang) : undefined;
  const result = current && lang ? dubResult(current, lang)?.outputs.find((o) => o.kind === "video") : undefined;
  const onBoard = useEditorSelector(selectHasFile, result?.url ?? "");
  const start = async () => {
    if (!video || !lang) return;
    setBusy(true);
    try {
      const res = await fetch("/api/dub", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine: "open", mode: "steps", video, targets: [lang], source: "auto", title: data.label || "Canvas dub" }) });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw responseError(res, body.error ?? "Couldn't start the dub");
      actions.update(id, { dubId: body.id });
      toast.success("Dub started", { description: "Check the translation in Translate & dub, then have it spoken. The dubbed video comes back here." });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("space-y-1.5", NO_DRAG)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <OptionSelect label="Dub into" value={lang} options={OPEN_DUB_LANGUAGES.map((l) => l.code)} onChange={(v) => actions.update(id, { params: { ...data.params, targetLanguage: v } })} format={(v) => OPEN_DUB_LANGUAGES.find((l) => l.code === v)?.name ?? v} />
        {current ? (
          <Link href={`/audio/translate?dub=${current.id}`} className={chip}>
            {stage === "review" ? "Check the translation" : "Open the dub"}
          </Link>
        ) : (
          <button className={chip} onClick={() => void start()} disabled={!video || !lang || busy} title={!video ? "Connect a video (an upload, or a finished clip)" : !lang ? "Pick the language to dub into" : "Free on your GPU"}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} Start in Translate &amp; dub
          </button>
        )}
        {result && !onBoard && (
          <button className={chip} onClick={() => actions.addInput(id, { url: result.url, kind: "video", label: `${data.label || "Translate"} · dubbed` }, true)} title="A Video input with the dubbed clip, connected where this node was">
            <Plus className="size-3" /> Use the dubbed video
          </button>
        )}
      </div>
      <p className="text-[12px] leading-snug text-muted-foreground" aria-live="polite">
        {stage === "done" && onBoard ? "Dubbed — it's on the board as a Video input" : stage ? DUB_STAGE[stage] : "When it's dubbed, bring it back here as a Video input."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video concatenator: the film's frame, and each clip's cut and sound in the order they play

interface ClipRow {
  nodeId: string;
  label: string;
  /** The clip's file when it's known now: an uploaded clip, or a finished result upstream. */
  url?: string;
  /** A node run once per table row gives a clip per row (each with this cut and sound). */
  rows?: number;
}

const sameRows = (a: ClipRow[], b: ClipRow[]) => a.length === b.length && a.every((x, i) => x.nodeId === b[i].nodeId && x.label === b[i].label && x.url === b[i].url && x.rows === b[i].rows);

const selectClipRows = (s: EditorSnapshot, id: string): ClipRow[] => {
  const n = s.byId.get(id);
  if (!n) return [];
  return concatClips(s.graph, n).map(({ nodeId }) => {
    const src = s.byId.get(nodeId);
    const url = src?.type === "video-input" ? src.data.url : s.views.get(nodeId)?.results.outputs.find((x) => x.o.kind === "video")?.o.url;
    const rows = s.views.get(nodeId)?.rows;
    return { nodeId, label: src ? nodeLabel(src) : "Clip", ...(url && !rows && { url }), ...(rows && { rows }) };
  });
};

const seconds = (v: number | undefined) => (v === undefined ? "" : `${Math.round(v * 10) / 10} s`);

/** A clip's length and frame size, read from its file's header in the browser (once per file). */
function useClipFacts(url: string | undefined, onFacts: (f: Pick<ClipSettings, "length" | "width" | "height">) => void) {
  const report = useRef(onFacts);
  useEffect(() => {
    report.current = onFacts;
  });
  useEffect(() => {
    if (!url) return;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) report.current({ length: Math.round(v.duration * 1000) / 1000, ...(v.videoWidth && { width: v.videoWidth, height: v.videoHeight }) });
      v.removeAttribute("src");
      v.load();
    };
    v.addEventListener("loadedmetadata", done, { once: true });
    v.src = url;
    return () => {
      v.removeEventListener("loadedmetadata", done);
      v.removeAttribute("src");
    };
  }, [url]);
}

function TimeField({ label, value, placeholder, max, onChange, disabled }: { label: string; value?: number; placeholder: string; max?: number; onChange: (v: number | undefined) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={max}
        step={0.1}
        value={draft ?? (value === undefined ? "" : String(Math.round(value * 100) / 100))}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const n = draft.trim() === "" ? undefined : Number(draft);
          setDraft(null);
          onChange(n === undefined || !Number.isFinite(n) ? undefined : Math.max(0, max ? Math.min(n, max) : n));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          e.stopPropagation();
        }}
        aria-label={label}
        className={cn("h-7 w-16 rounded-md bg-muted px-1.5 font-mono text-[12px] text-foreground outline-none focus:ring-2 focus:ring-brand-faint disabled:opacity-60", NO_DRAG)}
      />
    </label>
  );
}

function ClipItem({ id, row, index, count, settings, readOnly, onMove }: { id: string; row: ClipRow; index: number; count: number; settings: ClipSettings; readOnly: boolean; onMove: (from: number, to: number) => void }) {
  const actions = useEditorActions();
  const set = (patch: Partial<ClipSettings>) => actions.patchClip(id, row.nodeId, patch);
  // The file's facts (length, size) are what the cuts are checked against.
  useClipFacts(row.url, (f) => {
    if (f.length !== settings.length || f.width !== settings.width || f.height !== settings.height) set(f);
  });
  // Whether it has sound, from its header on the server (a browser can't tell): a silent clip gets a silent track on
  // the cloud. Its length too, when this browser couldn't read the file.
  const header = useFileFacts(row.url).data;
  useEffect(() => {
    if (!header) return;
    const patch: Partial<ClipSettings> = {};
    if (typeof header.hasAudio === "boolean" && header.hasAudio !== settings.audio) patch.audio = header.hasAudio;
    if (settings.length === undefined && header.duration) patch.length = Math.round(header.duration * 1000) / 1000;
    if (Object.keys(patch).length) actions.patchClip(id, row.nodeId, patch);
  }, [header, settings.audio, settings.length, actions, id, row.nodeId]);
  const muted = !!settings.mute;
  return (
    <li className="rounded-lg bg-muted/60 p-2">
      <div className="flex items-center gap-1.5">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-background font-mono text-[10px]">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{row.label}</span>
        {row.rows && <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title="A clip per table row, in row order">× {row.rows} rows</span>}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{seconds(settings.length)}</span>
        {!readOnly && (
          <>
            <button onClick={() => set({ mute: !muted })} aria-pressed={muted} aria-label={muted ? `Unmute clip ${index + 1}` : `Mute clip ${index + 1}`} title={muted ? "Muted: plays silent" : "Plays with its sound"} className={cn("grid size-6 place-items-center rounded-md hover:bg-accent", muted ? "text-warning" : "text-muted-foreground", NO_DRAG)}>
              {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
            <button onClick={() => onMove(index, index - 1)} disabled={index === 0} aria-label={`Move clip ${index + 1} earlier`} className={cn("grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-30", NO_DRAG)}>
              <ArrowUp className="size-3.5" />
            </button>
            <button onClick={() => onMove(index, index + 1)} disabled={index === count - 1} aria-label={`Move clip ${index + 1} later`} className={cn("grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-30", NO_DRAG)}>
              <ArrowDown className="size-3.5" />
            </button>
          </>
        )}
      </div>
      {!readOnly && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <TimeField label="From" value={settings.start} placeholder="0" max={settings.length} onChange={(v) => set({ start: v })} />
          <TimeField label="to" value={settings.end} placeholder={settings.length ? String(Math.round(settings.length * 10) / 10) : "end"} max={settings.length} onChange={(v) => set({ end: v })} />
        </div>
      )}
    </li>
  );
}

/** `engine`: the engine of the node's tools (none yet on a node made without them, e.g. through the API). */
function ConcatPanel({ id, data, engine }: { id: string; data: CanvasNodeData; engine?: Engine }) {
  const actions = useEditorActions();
  const g = useEditorGlobals();
  const rows = useEditorSelector(selectClipRows, id, sameRows);
  const ratio = concatRatio(data.params?.aspectRatio);
  const size = CONCAT_SIZE[ratio];
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const order = rows.map((r) => r.nodeId);
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    actions.update(id, { order });
  };
  return (
    <div className="space-y-2">
      <div className={cn("flex flex-wrap items-center gap-1.5", g.readOnly && "pointer-events-none")}>
        <OptionSelect label="Aspect ratio" value={ratio} options={[...CONCAT_RATIOS]} onChange={(v) => actions.update(id, { params: { ...data.params, aspectRatio: v } })} />
        {(g.mode === "both" || !engine) && (
          <div className={cn("inline-flex h-7 rounded-full bg-muted p-0.5 text-[12px] font-medium", NO_DRAG)} role="radiogroup" aria-label="Engine">
            {(g.mode === "both" ? (["cloud", "open"] as const) : [g.mode]).map((e) => (
              <button key={e} role="radio" aria-checked={engine === e} onClick={() => actions.update(id, { modelId: CONCAT_MODELS[e] })} className={cn("rounded-full px-2.5", engine === e ? "bg-background shadow-soft" : "text-muted-foreground")}>
                {e === "cloud" ? "Cloud" : "Open source"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {size.width}×{size.height} · {CONCAT_LIMITS.fps} fps · up to {CONCAT_LIMITS.clips} clips, 512 MB each
      </p>
      {rows.length ? (
        <ol className="max-h-80 space-y-1.5 overflow-y-auto" aria-label="Clips, in the order they play">
          {rows.map((row, i) => (
            <ClipItem key={row.nodeId} id={id} row={row} index={i} count={rows.length} settings={data.clips?.[row.nodeId] ?? {}} readOnly={g.readOnly} onMove={move} />
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed p-2.5 text-[12px] text-muted-foreground">Connect clips to Clips: they play top to bottom, and you can reorder, cut and mute each one here.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs

const PromptNode = memo(function PromptNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} out="text" width={280}>
      <div className="p-3">
        <textarea
          value={data.text ?? ""}
          onChange={(e) => actions.update(id, { text: e.target.value })}
          readOnly={readOnly}
          rows={3}
          maxLength={CANVAS_TEXT_MAX}
          placeholder="e.g. “a lighthouse on a cliff at golden hour, cinematic”"
          aria-label={`Text of ${data.label || "Text prompt"}`}
          className={cn("field-sizing-content max-h-60 min-h-20 w-full resize-none rounded-lg bg-muted px-2.5 py-2 text-[13px] leading-snug outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-brand-faint", NO_DRAG)}
        />
      </div>
    </NodeShell>
  );
}, sameNodeProps);

/** "Exact orbit" in the Camera path node's move list: the orbit set by its numbers. */
const EXACT_PICK = "exact";

/** A Camera path's move: a preset, or an exact orbit by its numbers (the board's node and the phone's card). */
export function CameraPathFields({ data, onChange, disabled, label }: { data: CanvasNodeData; onChange: (patch: Partial<CanvasNodeData>) => void; disabled?: boolean; label: string }) {
  const pick = data.orbit ? EXACT_PICK : (data.pathPreset ?? "orbit_360");
  const { keys } = cameraPathOf(data.orbit ? { data } : { data: { pathPreset: pick } });
  return (
    <div className="grid gap-2">
      <Select
        value={pick}
        disabled={disabled}
        onValueChange={(v) => onChange(v === EXACT_PICK ? { orbit: data.orbit ?? exactDefaults("motion-360-orbit"), pathPreset: undefined, keys: undefined } : { pathPreset: v, orbit: undefined, keys: undefined })}
      >
        <SelectTrigger size="sm" className="w-full text-[13px]" aria-label={`Move of ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PATH_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          <SelectItem value={EXACT_PICK}>Exact orbit…</SelectItem>
        </SelectContent>
      </Select>
      {data.orbit ? (
        <ExactOrbitControls compact value={data.orbit} defaults={exactDefaults("motion-360-orbit")} onChange={(orbit) => onChange(orbit ? { orbit } : { orbit: undefined, pathPreset: "orbit_360" })} className="border-0 bg-muted/50 p-2.5" />
      ) : (
        <p className="text-[12px] text-muted-foreground">{PATH_PRESETS.find((p) => p.id === pick)?.description}</p>
      )}
      <p className="text-[11.5px] text-subtle-foreground">{keys.length} keyframes</p>
    </div>
  );
}

/** Camera path: a preset move, or an exact orbit by its numbers, for Fly around nodes to follow. */
// ---------------------------------------------------------------------------
// Kinetic: words as motion graphics, rendered in this tab once per row

const KineticNode = memo(function KineticNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const v = useNodeView(id);
  const node = useMemo(() => asNode(id, "kinetic", data), [id, data]);
  const ports = useMemo(() => inputPorts(node), [node]);
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} out="video" width={280}>
      <div className="border-b py-1">
        {ports.map((p) => (
          <InPort key={p.id} port={p} count={v.counts[p.id] ?? 0} />
        ))}
      </div>
      <KineticNodeBody id={id} data={data} />
    </NodeShell>
  );
}, sameNodeProps);

const CameraPathNode = memo(function CameraPathNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} out="path" width={300}>
      <div className={cn("p-3", NO_DRAG)}>
        <CameraPathFields data={data} disabled={readOnly} label={data.label || "Camera path"} onChange={(patch) => actions.update(id, patch)} />
      </div>
    </NodeShell>
  );
}, sameNodeProps);

const KIND_OF: Partial<Record<CanvasNodeType, "image" | "video" | "audio">> = { "image-input": "image", "video-input": "video", "audio-input": "audio" };

function LibraryGrid({ kind, onPick }: { kind: MediaKind; onPick: (url: string, name?: string) => void }) {
  const assets = useAssets(undefined, kind);
  return (
    <>
      <p className="px-1 pb-2 text-[13px] font-medium max-md:hidden">From your library</p>
      {assets.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : assets.data?.length ? (
        <div className="grid max-h-72 grid-cols-4 gap-1.5 overflow-y-auto max-md:max-h-none">
          {assets.data.map((a) => (
            <button key={a.id} className="aspect-square overflow-hidden rounded-md bg-muted ring-primary transition hover:ring-2" onClick={() => onPick(a.url, a.name ?? undefined)} aria-label={a.name ?? "Library item"}>
              {a.kind === "video" ? (
                <video src={`${a.url}#t=0.1`} muted preload="metadata" className="size-full object-cover" />
              ) : a.kind === "audio" ? (
                <span className="grid size-full place-items-center bg-brand-faint text-brand-text">
                  <AudioLines className="size-4" />
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">Nothing here yet.</p>
      )}
    </>
  );
}

/** Pick an image, video or audio file from the library: a popover on the board, a sheet on phones. */
export function LibraryButton({ kind, onPick, className }: { kind: MediaKind; onPick: (url: string, name?: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <ResponsivePanel
      open={open}
      onOpenChange={setOpen}
      title="From your library"
      className="w-80 p-2"
      trigger={
        <button className={className ?? chip}>
          <Library className="size-3" /> Library
        </button>
      }
    >
      <LibraryGrid
        kind={kind}
        onPick={(url, name) => {
          onPick(url, name);
          setOpen(false);
        }}
      />
    </ResponsivePanel>
  );
}

function MediaPreview({ kind, url }: { kind: MediaKind; url: string }) {
  if (kind === "video") return <video src={url} muted playsInline loop controls preload="metadata" className={cn("max-h-52 w-full rounded-lg bg-media object-contain", NO_DRAG)} />;
  if (kind === "audio")
    return (
      <div className={cn("flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg bg-brand-faint p-2 text-brand-text", NO_DRAG)}>
        <AudioLines className="size-4 shrink-0" />
        <audio src={url} controls preload="metadata" className="h-8 w-full min-w-0 flex-1" />
      </div>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="max-h-52 w-full rounded-lg bg-muted object-contain" />;
}

const MediaInputNode = memo(function MediaInputNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  const kind = KIND_OF[type as CanvasNodeType]!;
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<SlotValue | null>(null);
  const [over, setOver] = useState(false);
  const take = (f: File) =>
    void fileToSlot(
      f,
      (v) => {
        if (!v) return setPending(null);
        if (v.uploading) return setPending(v);
        setPending(null);
        actions.update(id, { url: v.ref, name: v.name });
      },
      kind,
    );
  const accept = kind === "image" ? "image/png,image/jpeg,image/webp,image/gif" : kind === "video" ? "video/mp4,video/webm,video/quicktime" : "audio/*";
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} out={kind} width={260}>
      <div
        className="space-y-2 p-3"
        onDragOver={(e) => {
          if (readOnly || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0];
          if (!f || readOnly) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          take(f);
        }}
      >
        {pending ? (
          <div className="relative">
            <MediaPreview kind={kind} url={pending.preview} />
            <div className="absolute inset-0 grid place-items-center rounded-lg bg-background/60">
              <Loader2 className="size-5 animate-spin" />
            </div>
          </div>
        ) : data.url ? (
          <MediaPreview kind={kind} url={data.url} />
        ) : (
          <button
            onClick={() => input.current?.click()}
            disabled={readOnly}
            className={cn(
              "flex h-28 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-muted-foreground transition-colors hover:border-primary hover:bg-brand-faint hover:text-brand-text",
              over && "border-primary bg-brand-faint text-brand-text",
              NO_DRAG,
            )}
          >
            <Upload className="size-4" />
            <span className="text-[12px] font-medium">Drop {kind === "audio" ? "an audio file" : `a${kind === "image" ? "n" : ""} ${kind}`} or click to upload</span>
          </button>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-1">
            {data.url && (
              <button className={chip} onClick={() => input.current?.click()}>
                <Upload className="size-3" /> Replace
              </button>
            )}
            <LibraryButton kind={kind} onPick={(url, name) => actions.update(id, { url, name })} />
            {data.url && (
              <button className={chip} onClick={() => actions.update(id, { url: undefined, name: undefined })} aria-label="Remove file">
                <X className="size-3" /> Remove
              </button>
            )}
          </div>
        )}
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) take(f);
            e.target.value = "";
          }}
        />
      </div>
    </NodeShell>
  );
}, sameNodeProps);

/** Pick an @character, location, prop or style from Elements (a popover on the board, a sheet on phones). */
export function ElementPicker({ data, onPick, className }: { data: CanvasNodeData; onPick: (patch: Partial<CanvasNodeData>) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <ResponsivePanel open={open} onOpenChange={setOpen} title="Pick an element" className="w-72 p-1.5" trigger={<button className={className ?? chip}>{data.handle ? "Change" : "Pick an element"}</button>}>
      <ElementList
        current={data.elementId}
        onPick={(patch) => {
          onPick(patch);
          setOpen(false);
        }}
      />
    </ResponsivePanel>
  );
}

function ElementList({ current, onPick }: { current?: string; onPick: (patch: Partial<CanvasNodeData>) => void }) {
  const elements = useElements();
  const visual = (elements.data ?? []).filter((e) => e.kind !== "voice");
  if (elements.isLoading) return <p className="p-3 text-[13px] text-muted-foreground">Loading…</p>;
  if (!visual.length) {
    return (
      <p className="p-3 text-[13px] text-muted-foreground">
        No elements yet.{" "}
        <Link href="/elements" className="text-brand-text underline-offset-4 hover:underline">
          Create one
        </Link>
      </p>
    );
  }
  return (
    <div className="max-h-72 overflow-y-auto max-md:max-h-none">
      {visual.map((e) => (
        <button
          key={e.id}
          onClick={() => onPick({ elementId: e.id, handle: e.handle, name: e.name, preview: e.references[0] })}
          className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent", e.id === current && "bg-brand-faint")}
        >
          <span className="size-8 shrink-0 overflow-hidden rounded-md bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {e.references[0] && <img src={e.references[0]} alt="" className="size-full object-cover" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{e.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              @{e.handle} · {e.kind}
            </span>
          </span>
          {e.id === current && <Check className="size-3.5 text-brand-text" />}
        </button>
      ))}
    </div>
  );
}

const ElementNode = memo(function ElementNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} out="element" width={240}>
      <div className="space-y-2 p-3">
        {data.handle ? (
          <div className="flex items-center gap-2.5">
            <span className="size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {data.preview && <img src={data.preview} alt="" className="size-full object-cover" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{data.name ?? data.handle}</span>
              <span className="block truncate font-mono text-[12px] text-brand-text">@{data.handle}</span>
            </span>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">Adds an @character, location, prop or style to the models it connects to.</p>
        )}
        {!readOnly && <ElementPicker data={data} onPick={(patch) => actions.update(id, patch)} />}
      </div>
    </NodeShell>
  );
}, sameNodeProps);

// ---------------------------------------------------------------------------
// Clone voice: a sample to speak with (recorded, uploaded, a saved voice, or wired in)

const selectSampleSource = (s: EditorSnapshot, id: string) => {
  const e = s.graph.edges.find((x) => x.target === id && x.targetHandle === "audio");
  const n = e && s.byId.get(e.source);
  return n ? nodeLabel(n) : null;
};

const CloneVoiceNode = memo(function CloneVoiceNode({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  const qc = useQueryClient();
  const wired = useEditorSelector(selectSampleSource, id);
  const voices = (useElements().data ?? []).filter((e) => e.kind === "voice" && e.references[0]);
  const node = useMemo(() => asNode(id, "clone-voice", data), [id, data]);
  const ports = useMemo(() => inputPorts(node), [node]);
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const take = (f: File) => {
    if (f.size > 11 * 1024 * 1024) return void toast.error("That sample is over 11 MB — 10–60 s of speech is plenty");
    setPending(true);
    void fileToSlot(
      f,
      (v) => {
        if (v?.uploading) return;
        setPending(false);
        if (v) actions.update(id, { url: v.ref, name: v.name, elementId: undefined });
      },
      "audio",
    );
  };
  const saved = voices.find((e) => e.id === data.elementId || e.references[0] === data.url);
  const save = async () => {
    const name = naming?.trim();
    if (!name || !data.url) return;
    const res = await fetch("/api/elements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, kind: "voice", references: [data.url] }) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
    if (!res.ok || !body.id) return void toast.error(body.error ?? "Couldn't save the voice");
    actions.update(id, { elementId: body.id, name: body.name });
    setNaming(null);
    void qc.invalidateQueries({ queryKey: ["elements"] });
    toast.success(`Saved “${body.name}” to your voices`);
  };
  return (
    <NodeShell id={id} type="clone-voice" data={data} selected={!!selected} out="voice" width={270}>
      <div className="border-b py-1">
        {ports.map((p) => (
          <InPort key={p.id} port={p} count={wired ? 1 : 0} />
        ))}
      </div>
      <div className="space-y-2 p-3">
        {wired ? (
          <p className="text-[12px] text-muted-foreground">
            Speaks with the voice in <span className="font-medium text-foreground">“{wired}”</span>.
          </p>
        ) : pending ? (
          <div className="flex h-12 items-center justify-center gap-2 rounded-lg bg-muted text-[12px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Uploading…
          </div>
        ) : data.url ? (
          <>
            <MediaPreview kind="audio" url={data.url} />
            <p className="truncate text-[12px] text-muted-foreground">{saved ? `Your voice “${saved.name}”` : (data.name ?? "Your sample")}</p>
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">Record or upload 10–60 s of clean speech (MP3 or WAV, up to 11 MB), or pick one of your voices.</p>
        )}
        {!readOnly && !wired && (
          <div className="flex flex-wrap gap-1">
            <div className={NO_DRAG}>
              <VoiceRecorder clean onRecorded={(v) => actions.update(id, { url: v.ref, name: v.name ?? "Recording", elementId: undefined })} className={chip} />
            </div>
            <button className={chip} onClick={() => file.current?.click()}>
              <Upload className="size-3" /> {data.url ? "Replace" : "Upload"}
            </button>
            {voices.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={chip}>
                    <Library className="size-3" /> My voices
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
                  {voices.map((e) => (
                    <DropdownMenuItem key={e.id} onSelect={() => actions.update(id, { url: e.references[0], name: e.name, elementId: e.id })}>
                      <AudioLines className="size-4" /> <span className="truncate">{e.name}</span>
                      {e.id === saved?.id && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {data.url && !saved && naming === null && (
              <button className={chip} onClick={() => setNaming(data.name?.replace(/\.[a-z0-9]+$/i, "") ?? "My voice")}>
                <Plus className="size-3" /> Save as a voice
              </button>
            )}
          </div>
        )}
        {naming !== null && (
          <div className={cn("flex items-center gap-1", NO_DRAG)}>
            <input
              autoFocus
              value={naming}
              maxLength={60}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setNaming(null);
                e.stopPropagation();
              }}
              aria-label="Voice name"
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px] outline-none focus:border-primary"
            />
            <button className={chip} onClick={() => void save()} disabled={!naming.trim()}>
              Save
            </button>
          </div>
        )}
        <input
          ref={file}
          type="file"
          accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/webm,audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) take(f);
            e.target.value = "";
          }}
        />
      </div>
    </NodeShell>
  );
}, sameNodeProps);

// ---------------------------------------------------------------------------
// Output preview and notes

type Source = Pick<CanvasNode, "id" | "type" | "data">;

const sameSources = (a: Source[], b: Source[]) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.type === b[i].type && s.data === b[i].data);

/** What feeds an Output node, top to bottom. */
const selectSources = (s: EditorSnapshot, id: string): Source[] =>
  s.graph.edges
    .filter((e) => e.target === id)
    .map((e) => s.byId.get(e.source))
    .filter((n): n is CanvasNode => !!n)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((n) => ({ id: n.id, type: n.type, data: n.data }));

/** The saved width (templates set one), not React Flow's measured width (that would feed back). */
const selectWidth = (s: EditorSnapshot, id: string) => s.byId.get(id)?.width;

const OutputNode = memo(function OutputNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  // Re-renders only when that list or one of those nodes changes.
  const sources = useEditorSelector(selectSources, id, sameSources);
  const width = useEditorSelector(selectWidth, id);
  const w = width ?? (sources.length > 1 ? 560 : 320);
  const menu: MenuItem[] = [{ label: "Run what feeds this", icon: Play, onSelect: () => actions.run([id]) }];
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} menu={menu} width={w}>
      <div className="relative p-3">
        <Handle type="target" position={Position.Left} id={PREVIEW_IN} className="canvas-handle canvas-handle-any" aria-label="Preview input (any type)" />
        {sources.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">Connect results here to preview them side by side.</p>
        ) : (
          <div className={cn("grid gap-2", sources.length > 2 && w >= 540 ? "grid-cols-3" : sources.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {sources.map((s) => (
              <figure key={s.id} className="min-w-0 space-y-1">
                <SourcePreview node={s} />
                <figcaption className="truncate text-[11px] text-muted-foreground">{nodeLabel(s)}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </NodeShell>
  );
}, sameNodeProps);

function SourcePreview({ node }: { node: Source }) {
  const actions = useEditorActions();
  const r = useNodeResults(node.id);
  if (isGenerator(node) || node.type === "kinetic") {
    if (r.outputs.length) return <OutputThumb o={r.outputs[0].o} onOpen={() => actions.open(node.id, 0)} large />;
    if (r.state !== "idle") return <Results id={node.id} r={r} compact />;
    return <div className="grid h-20 place-items-center rounded-lg bg-muted text-[11px] text-muted-foreground">Not run yet</div>;
  }
  const kind = node.type === "clone-voice" ? "audio" : KIND_OF[node.type];
  if (kind && node.data.url) return <MediaPreview kind={kind} url={node.data.url} />;
  if (node.type === "prompt") return <p className="line-clamp-6 rounded-lg bg-muted p-2.5 text-[12px] leading-snug">{node.data.text || "Empty text"}</p>;
  return <div className="grid h-20 place-items-center rounded-lg bg-muted text-[11px] text-muted-foreground">Nothing yet</div>;
}

const NoteNode = memo(function NoteNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  return (
    <NodeShell id={id} type={type as CanvasNodeType} data={data} selected={!!selected} width={240} tone="note">
      <div className="p-3">
        <textarea
          value={data.text ?? ""}
          onChange={(e) => actions.update(id, { text: e.target.value })}
          readOnly={readOnly}
          rows={3}
          maxLength={CANVAS_TEXT_MAX}
          placeholder="A note for this board"
          aria-label="Note"
          className={cn("field-sizing-content max-h-72 min-h-16 w-full resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-muted-foreground", NO_DRAG)}
        />
      </div>
    </NodeShell>
  );
}, sameNodeProps);

// ---------------------------------------------------------------------------
// Table: rows of words, each row one run of the node it feeds

const TableNode = memo(function TableNode({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useEditorActions();
  const { readOnly } = useEditorGlobals();
  const columns = data.columns?.length ? data.columns : ["Subject"];
  const rows = data.rows?.length ? data.rows : [[""]];
  const filled = tableRows({ data: { columns, rows } }).length;
  const grid = useRef<HTMLTableSectionElement>(null);
  const setRows = (next: string[][]) => actions.update(id, { columns, rows: next });
  const setCell = (i: number, j: number, v: string) => setRows(rows.map((r, k) => (k === i ? Array.from({ length: columns.length }, (_, c) => (c === j ? v : (r[c] ?? ""))) : r)));
  const addRow = (focus = false) => {
    if (rows.length >= TABLE_LIMITS.rows * 2) return;
    setRows([...rows, columns.map(() => "")]);
    if (focus) requestAnimationFrame(() => grid.current?.querySelector<HTMLInputElement>(`tr:last-child input`)?.focus());
  };
  const addColumn = () => {
    if (columns.length >= TABLE_LIMITS.columns) return;
    actions.update(id, { columns: [...columns, `Column ${columns.length + 1}`], rows: rows.map((r) => [...r, ""]) });
  };
  const removeColumn = (j: number) => actions.update(id, { columns: columns.filter((_, c) => c !== j), rows: rows.map((r) => r.filter((_, c) => c !== j)) });
  const cell = cn("h-7 w-full min-w-0 rounded-md bg-muted px-2 text-[12px] outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-brand-faint", NO_DRAG);
  return (
    <NodeShell id={id} type="table" data={data} selected={!!selected} out="text" width={Math.min(560, 120 + columns.length * 150)}>
      <div className="space-y-2 p-3">
        <table className="w-full border-separate border-spacing-1 text-left">
          <thead>
            <tr>
              <th className="w-5" aria-hidden />
              {columns.map((c, j) => (
                <th key={j} scope="col" className="font-normal">
                  <div className="flex items-center gap-0.5">
                    <input
                      value={c}
                      readOnly={readOnly}
                      maxLength={TABLE_LIMITS.column}
                      onChange={(e) => actions.update(id, { columns: columns.map((x, k) => (k === j ? e.target.value : x)), rows })}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={`Column ${j + 1} name`}
                      className={cn(cell, "bg-transparent font-mono text-[11px] font-semibold text-muted-foreground")}
                    />
                    {!readOnly && columns.length > 1 && (
                      <button onClick={() => removeColumn(j)} className={cn("grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", NO_DRAG)} aria-label={`Remove column ${c || j + 1}`}>
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="w-5" aria-hidden />
            </tr>
          </thead>
          <tbody ref={grid}>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="text-center font-mono text-[10px] text-muted-foreground">{i + 1}</td>
                {columns.map((c, j) => (
                  <td key={j}>
                    <input
                      value={r[j] ?? ""}
                      readOnly={readOnly}
                      maxLength={TABLE_LIMITS.cell}
                      onChange={(e) => setCell(i, j, e.target.value)}
                      onKeyDown={(e) => {
                        // Enter on the last row starts a new one.
                        if (e.key === "Enter" && i === rows.length - 1 && !readOnly) addRow(true);
                        e.stopPropagation();
                      }}
                      placeholder={i === 0 ? (c ? `${c}…` : "…") : undefined}
                      aria-label={`Row ${i + 1}, ${c || `column ${j + 1}`}`}
                      className={cell}
                    />
                  </td>
                ))}
                <td>
                  {!readOnly && rows.length > 1 && (
                    <button onClick={() => setRows(rows.filter((_, k) => k !== i))} className={cn("grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", NO_DRAG)} aria-label={`Remove row ${i + 1}`}>
                      <X className="size-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!readOnly && (
          <div className="flex flex-wrap gap-1">
            <button className={chip} onClick={() => addRow(true)} disabled={rows.length >= TABLE_LIMITS.rows * 2}>
              <Plus className="size-3" /> Row
            </button>
            <button className={chip} onClick={addColumn} disabled={columns.length >= TABLE_LIMITS.columns}>
              <Plus className="size-3" /> Column
            </button>
          </div>
        )}
        <p className={cn("text-[11px] leading-snug", filled > TABLE_LIMITS.rows ? "text-warning" : "text-muted-foreground")}>
          {filled > TABLE_LIMITS.rows
            ? `${filled} rows: up to ${TABLE_LIMITS.rows} run at once`
            : `${filled === 1 ? "1 filled row" : `${filled} filled rows`}: what this feeds runs once per row. Write {${columns.find((c) => c.trim())?.trim() || "Subject"}} in its prompt to place a cell.`}
        </p>
      </div>
    </NodeShell>
  );
}, sameNodeProps);

// ---------------------------------------------------------------------------
// Layout: boxes for a headline, a product, a price; the image model it feeds draws each in its place

const LayoutEditor = dynamic(() => import("@/components/studio/layout-editor").then((m) => m.LayoutEditor));

const LAYOUT_ASPECTS = ["1:1", "4:5", "3:4", "2:3", "9:16", "16:9", "3:2", "4:3"];
const EMPTY_LAYOUT: LayoutDraft = { summary: { caption: "", meta: [], canvas: "single" }, items: [], aspect: "1:1" };

/** The first model a node feeds ("node id|model id|aspect ratio"), so the editor draws on the shape that model renders. */
const downstreamOf = (s: EditorSnapshot, id: string): string => {
  for (const e of s.graph.edges) {
    if (e.source !== id) continue;
    const t = s.byId.get(e.target);
    if (t?.data.modelId) return `${t.id}|${t.data.modelId}|${t.data.params?.aspectRatio ?? getModel(t.data.modelId)?.defaults?.aspectRatio ?? ""}`;
  }
  return "";
};

/** A canvas of that shape, 1024 px on its longer side in steps of 16 (no image model to ask). */
function plainCanvas(aspect: string | undefined): EditorCanvas {
  const r = ratioNum(aspect);
  const r16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  const width = r >= 1 ? 1024 : r16(1024 * r);
  const height = r >= 1 ? r16(1024 / r) : 1024;
  return { width, height, asked: { width, height }, exact: false };
}

const ratioNum = (aspect: string | undefined) => {
  const [a, b] = (aspect ?? "1:1").split(":").map(Number);
  return a > 0 && b > 0 ? a / b : 1;
};

/** What a Layout node's card and its row in the Nodes list need: the draft, the model it feeds and the shape. */
function useLayoutNode(id: string, data: CanvasNodeData) {
  const draft = readLayout(data.layout) ?? EMPTY_LAYOUT;
  const feeds = useEditorSelector(downstreamOf, id);
  const [target, modelId, auto] = feeds.split("|");
  const found = modelId ? getModel(modelId) : undefined;
  const texts = draft.items.filter((it) => it.label === "text").length;
  // The picture's shape is the model's (its node's aspect ratio): a square canvas when the model leaves it to "auto".
  const nodeAspect = auto === "auto" ? "1:1" : auto;
  return {
    draft,
    found,
    target,
    model: found?.kind === "image" ? found : undefined,
    aspect: nodeAspect || draft.aspect || "1:1",
    summary: draft.items.length ? `${draft.items.length} box${draft.items.length === 1 ? "" : "es"}${texts ? ` · ${texts} with words` : ""}` : "No boxes yet",
  };
}

/** The Layout editor for a node (Image studio's editor), sized as the model it feeds renders. */
function LayoutNodeEditor({ id, data, open, onOpenChange }: { id: string; data: CanvasNodeData; open: boolean; onOpenChange: (o: boolean) => void }) {
  const actions = useEditorActions();
  const { draft, model, aspect, target } = useLayoutNode(id, data);
  const params = useEditorSelector((s, key) => (key ? s.byId.get(key)?.data.params : undefined), target ?? "");
  if (!open) return null;
  const aspects = model?.options.aspectRatios?.filter((a) => a !== "auto") ?? LAYOUT_ASPECTS;
  const canvasFor = (a: string | undefined): EditorCanvas => (model ? layoutCanvas(model, { ...(a && { aspectRatio: a }) }, "t2i") : plainCanvas(a));
  return (
    <LayoutEditor
      open={open}
      onOpenChange={onOpenChange}
      layout={draft}
      caption={draft.summary.caption}
      aspect={aspect}
      aspects={aspects}
      canvasFor={canvasFor}
      model={model}
      onDone={(r) => {
        actions.update(id, { layout: { ...r.layout, summary: { ...r.layout.summary, caption: r.caption.trim() }, ...(r.aspect && { aspect: r.aspect }) } });
        // A new shape picked in the editor is the picture's: the model it feeds renders it.
        if (target && model && r.aspect && r.aspect !== aspect) actions.update(target, { params: { ...params, aspectRatio: r.aspect } });
      }}
    />
  );
}

/** Phones edit in the Nodes list (the board is read-only there): the Layout node's row, with Edit layout. */
export function LayoutNodeRow({ id, data, className }: { id: string; data: CanvasNodeData; className?: string }) {
  const [open, setOpen] = useState(false);
  const { summary, aspect } = useLayoutNode(id, data);
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="min-w-0 truncate text-[13px] text-muted-foreground">
        {aspect} · {summary}
      </p>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <LayoutDashboard className="size-3.5" /> Edit layout
      </button>
      <LayoutNodeEditor id={id} data={data} open={open} onOpenChange={setOpen} />
    </div>
  );
}

const LayoutNode = memo(function LayoutNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { readOnly } = useEditorGlobals();
  const [open, setOpen] = useState(false);
  const { draft, found, aspect, summary } = useLayoutNode(id, data);
  return (
    <>
      <NodeShell id={id} type="layout" data={data} selected={!!selected} out="text" width={260}>
        <div className="space-y-2 p-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={readOnly}
            aria-label={`Edit layout: ${summary}`}
            className={cn("relative mx-auto block w-full overflow-hidden rounded-md border border-dashed border-border-strong bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none", NO_DRAG)}
            style={{ aspectRatio: `${ratioNum(aspect)}`, maxWidth: `calc(12rem * ${ratioNum(aspect)})` }}
          >
            {draft.items.map((it, i) => (
              <span
                key={i}
                aria-hidden
                className="absolute overflow-hidden rounded-[2px] border px-0.5 text-left text-[8px] leading-tight text-foreground/80"
                style={{
                  left: `${it.box[0] * 100}%`,
                  top: `${it.box[1] * 100}%`,
                  width: `${(it.box[2] - it.box[0]) * 100}%`,
                  height: `${(it.box[3] - it.box[1]) * 100}%`,
                  borderColor: it.color ?? KIND_COLOR[it.label],
                  background: `color-mix(in oklab, ${it.color ?? KIND_COLOR[it.label]} 14%, transparent)`,
                }}
              >
                {it.label === "text" ? it.text : ""}
              </span>
            ))}
            {!draft.items.length && <span className="absolute inset-0 grid place-items-center p-2 text-center text-[12px] text-muted-foreground">Draw boxes for a headline, a product, a price</span>}
          </button>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-muted-foreground">
              {aspect} · {summary}
            </span>
            {!readOnly && (
              <button type="button" className={chip} onClick={() => setOpen(true)}>
                <LayoutDashboard className="size-3" /> Edit layout
              </button>
            )}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {found && !readsBoxes(found) ? "This model reads the layout as words, not exact positions." : "Wire it into an image model's Prompt. With a table, {Column} in a box's words fills row by row."}
          </p>
        </div>
      </NodeShell>
      {/* Beside the card, not in it: the card's menus and clicks stay out of the editor. */}
      <LayoutNodeEditor id={id} data={data} open={open} onOpenChange={setOpen} />
    </>
  );
}, sameNodeProps);

export const NODE_TYPES = {
  prompt: PromptNode,
  "image-input": MediaInputNode,
  "video-input": MediaInputNode,
  "audio-input": MediaInputNode,
  element: ElementNode,
  model: GeneratorNode,
  join: GeneratorNode,
  frame: GeneratorNode,
  upscale: GeneratorNode,
  "bg-remove": GeneratorNode,
  tts: GeneratorNode,
  "voice-change": GeneratorNode,
  "clean-voice": GeneratorNode,
  "split-soundtrack": GeneratorNode,
  "clone-voice": CloneVoiceNode,
  translate: GeneratorNode,
  concat: GeneratorNode,
  restore: GeneratorNode,
  "fly-around": GeneratorNode,
  kinetic: KineticNode,
  "camera-path": CameraPathNode,
  table: TableNode,
  layout: LayoutNode,
  output: OutputNode,
  note: NoteNode,
  ...BOARD_NODE_TYPES,
} satisfies Record<CanvasNodeType | BoardType, React.ComponentType<NodeProps<FlowNode>>>;

export { MediaPreview, OutputThumb, Results, EngineBadge, costLabel };
