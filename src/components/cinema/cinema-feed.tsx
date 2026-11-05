"use client";

import {
  Box,
  CalendarDays,
  Clapperboard,
  ExternalLink,
  Copy,
  Download,
  Eye,
  FastForward,
  FolderInput,
  Grid3x3,
  Heart,
  ImagePlus,
  LayoutGrid,
  List,
  MapPin,
  MoreHorizontal,
  RotateCcw,
  Rows3,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRoundPlus,
  UserX,
  Video,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FailedTile, MediaThumb, PendingTile, downloadName, tileRatio } from "@/components/studio/feed";
import { useSoulFinish } from "@/components/studio/soul-finish";
import { Viewer } from "@/components/studio/viewer";
import { PlaceholderChip } from "@/components/demo-mode";
import { getModel } from "@/lib/catalog";
import type { CinemaFolder } from "@/lib/catalog/cinema";
import type { Generation, OutputFile } from "@/lib/catalog/types";
import { formatCost, timeAgo } from "@/lib/format";
import { useEngineMode, useIsOwner } from "@/lib/api";
import { finishedTakes, finishIn2k } from "@/lib/catalog/regenerate";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { toastError } from "@/lib/refusals";
import { MoveToItems } from "./folder-sidebar";
import { foreign, useItemActions, type CinemaGeneration } from "./hooks";

type Layout = "square" | "masonry" | "list";
type TypeFilter = "all" | "image" | "video" | "audio";
type DateFilter = "all" | "today" | "7d" | "30d";
type StatusFilter = "all" | "liked" | "rendering" | "failed";

interface Prefs {
  layout: Layout;
  split: boolean;
  fit: boolean;
  type: TypeFilter;
  date: DateFilter;
  status: StatusFilter;
  hideFailed: boolean;
}

const CINEMA_KEY = ["cinema"] as const;
const DEFAULT_PREFS: Prefs = { layout: "square", split: true, fit: false, type: "all", date: "all", status: "all", hideFailed: false };
const PREFS_KEY = "fuobe.cinema.feed";
const prefListeners = new Set<() => void>();
let prefCache: { raw: string | null; value: Prefs } | null = null;

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (prefCache?.raw === raw) return prefCache.value;
    const value = { ...DEFAULT_PREFS, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {}) };
    prefCache = { raw, value };
    return value;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Feed layout and filters, remembered per viewer. */
function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const prefs = useSyncExternalStore(
    (cb) => {
      prefListeners.add(cb);
      return () => prefListeners.delete(cb);
    },
    readPrefs,
    () => DEFAULT_PREFS,
  );
  const set = useCallback((p: Partial<Prefs>) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...p }));
    } catch {}
    prefListeners.forEach((l) => l());
  }, []);
  return [prefs, set];
}

/** One tile: a pending/failed take, one output of a take, a tile cut from a grid sheet, or a 3D scene (shown by its still). */
interface Unit {
  key: string;
  g: CinemaGeneration;
  output?: OutputFile;
  index: number;
  tile?: { row: number; col: number };
  scene?: boolean;
}

const active = (g: Generation) => g.status === "queued" || g.status === "running";

function units(items: CinemaGeneration[]): Unit[] {
  const out: Unit[] = [];
  for (const g of items) {
    if (g.status !== "succeeded") {
      out.push({ key: g.id, g, index: 0 });
      continue;
    }
    // A 3D scene is one tile showing its still; it opens in the 3D viewer.
    if (g.feature === "cinema-scene") {
      const still = g.request.inputs?.images?.[0];
      out.push({ key: g.id, g, output: still ? { url: still, kind: "image" } : g.outputs[0], index: 0, scene: true });
      continue;
    }
    // Open-source grids return the sheet first, then its tiles.
    const sheetTiles = g.feature === "cinema-grid" && g.outputs.length > 1;
    const outputs = sheetTiles ? g.outputs.slice(0, 1) : g.outputs;
    outputs.forEach((o, i) => out.push({ key: `${g.id}:${i}`, g, output: o, index: i }));
    const tiles = g.tiles?.length ? g.tiles.map((t) => ({ url: t.url, row: t.row, col: t.col })) : sheetTiles ? g.outputs.slice(1).map((o, i) => ({ url: o.url, row: -1, col: i })) : [];
    tiles.forEach((t, i) => out.push({ key: `${g.id}:t${i}`, g, output: { url: t.url, kind: "image" }, index: i, tile: { row: t.row, col: t.col } }));
  }
  return out;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? "long" : undefined, month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

const FEATURE_TITLES: Record<string, string> = { "cinema-scene": "3D scene", "cinema-recompose": "Recomposed view", "cinema-path": "Fly path", "cinema-turnaround": "Turnaround", "cinema-blockout": "Blockout film" };
const promptOf = (g: CinemaGeneration) => g.take?.prompt?.trim() || FEATURE_TITLES[g.feature] || g.request.prompt?.trim() || g.prompt || "Untitled";

const STEP_HINT: Record<string, string> = { "cinema-cast": "Cast", "cinema-location": "Location", "cinema-grid": "Grid", "cinema-scene": "3D scene", "cinema-recompose": "Recomposed", "cinema-path": "Fly path", "cinema-turnaround": "Turnaround", "cinema-blockout": "Blockout film" };

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-full bg-black/50 px-1.5 text-[10.5px] font-medium text-white backdrop-blur", className)}>{children}</span>;
}

export interface FeedHandlers {
  onLoad: (g: CinemaGeneration) => void;
  onUseTake: (g: CinemaGeneration, o: OutputFile) => void;
  onAnimate: (url: string) => void;
  onReference: (url: string, kind: OutputFile["kind"]) => void;
  /** Save a still as an element (absent where elements can't be saved: they are the owner's library). */
  onSaveElement?: (g: CinemaGeneration, url: string, kind: "character" | "location") => void;
  /** "Create 3D scene" from a still (asks first, with the price). */
  onCreateScene?: (g: CinemaGeneration, url: string) => void;
  onOpenScene: (g: CinemaGeneration) => void;
  /** What building a scene costs on the current engine ("Free", "≈ $0.03"). */
  scenePrice: string;
}

/**
 * A grid contact sheet and its tiles are one take: moving any of them to the Trash moves the lot. `forever`: whoever has
 * no Trash (a signed-in account) deletes it for good.
 */
export function deleteLabel(g: CinemaGeneration, forever = false): string {
  const tiles = g.tiles?.length ?? (g.feature === "cinema-grid" && g.outputs.length > 1 ? g.outputs.length - 1 : 0);
  if (forever) return tiles ? `Delete grid (sheet + ${tiles} tiles)` : "Delete take";
  return tiles ? `Move grid to Trash (sheet + ${tiles} tiles)` : "Move take to Trash";
}

/** The takes the feed's list already finishes in 2K (finishedTakes). */
const FinishedIn2k = createContext<Set<string>>(new Set());

function TileMenu({ u, folders, projectId, handlers, onDelete }: { u: Unit; folders: CinemaFolder[]; projectId: string; handlers: FeedHandlers; onDelete: (ids: string[]) => void }) {
  const actions = useItemActions(projectId);
  const engineMode = useEngineMode();
  const finished = useContext(FinishedIn2k);
  // One paid submit at a time, with a nonce the server answers a repeat with (a double click is one 2K render).
  const guard = useSubmitGuard();
  // The Trash is the owner's: anyone else's Delete is for good.
  const owner = useIsOwner();
  const o = u.output;
  const elsewhere = foreign(u.g, projectId);
  // Finish in 2K: a MiniMax H3 take below 2K (fal renders it again at 2K; your GPU redraws it with Open-H3 Regenerate),
  // once: not on a take whose 2K finish is under way or made (a 2K run's own 768p draft included).
  // A take from your GPU is finished by Open-H3 Regenerate (perSecond null): a 48 GB card, so it says so (own-setup.ts)
  // and a visitor runs it on its own GPU only.
  const finish = o?.kind === "video" && !u.tile && !finished.has(u.g.id) ? finishIn2k(u.g, engineMode) : null;
  const ownSetup = finish?.perSecond === null ? "regenerate:cinema-finish" : undefined;
  const press = useOwnSetupPress();
  const seconds = Number(u.g.request.params?.duration ?? 0);
  const finishPrice = !finish ? "" : finish.perSecond === null ? "Free" : seconds > 0 ? `≈ ${formatCost(finish.perSecond * seconds)}` : `$${finish.perSecond.toFixed(2)}/s`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="grid size-7 place-items-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white"
          aria-label="More actions"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
        {/* A scene has no prompt to load: it opens in the 3D viewer instead. */}
        {u.scene ? (
          <DropdownMenuItem onClick={() => handlers.onOpenScene(u.g)}>
            <Box /> Open 3D scene
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => handlers.onLoad(u.g)}>
            <RotateCcw /> Load into prompt bar
          </DropdownMenuItem>
        )}
        {o?.kind === "image" && !u.scene && (
          <>
            {handlers.onCreateScene && (
              <DropdownMenuItem onClick={() => handlers.onCreateScene?.(u.g, o.url)}>
                <Box /> Create 3D scene <span className="ml-auto text-[11.5px] text-muted-foreground">{handlers.scenePrice}</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => handlers.onAnimate(o.url)}>
              <Clapperboard /> Animate (start frame)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlers.onReference(o.url, "image")}>
              <ImagePlus /> Use as reference
            </DropdownMenuItem>
            {handlers.onSaveElement && (
              <>
                <DropdownMenuItem onClick={() => handlers.onSaveElement?.(u.g, o.url, "character")}>
                  <UserRoundPlus /> Save as character
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handlers.onSaveElement?.(u.g, o.url, "location")}>
                  <MapPin /> Save as location
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
        {o?.kind === "video" && (
          <>
            <DropdownMenuItem onClick={() => handlers.onUseTake(u.g, o)}>
              <FastForward /> Extend or edit this take
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlers.onReference(o.url, "video")}>
              <ImagePlus /> Use as reference clip
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/video-tools/remove-person?video=${encodeURIComponent(o.url)}`}>
                <UserX /> Remove a person
              </Link>
            </DropdownMenuItem>
            {finish && (
              <DropdownMenuItem
                onClick={() =>
                  press(ownSetup, () =>
                  void guard(`finish-2k:${u.g.id}`, (requestId) => actions.finish2k(u.g, requestId))
                    .then((done) => done !== undefined && toast(finish.perSecond === null ? "Finishing in 2K on your GPU" : "Rendering it again at 2K"))
                    .catch((e) => toastError(e)),
                  )
                }
              >
                <Sparkles /> {finish.label}
                <OwnSetupChip setup={ownSetup} />
                <span className="ml-auto text-[11.5px] text-muted-foreground">{finishPrice}</span>
              </DropdownMenuItem>
            )}
          </>
        )}
        {u.scene
          ? u.g.outputs.slice(0, 1).map((f) => (
              <DropdownMenuItem key={f.url} asChild>
                <a href={`${f.url}?download=${encodeURIComponent(downloadName(u.g, f, 0))}`}>
                  <Download /> {f.kind === "model3d" ? "Download the 3D mesh (.glb)" : "Download the depth map"}
                </a>
              </DropdownMenuItem>
            ))
          : o && (
              <DropdownMenuItem asChild>
                <a href={`${o.url}?download=${encodeURIComponent(downloadName(u.g, o, u.index))}`}>
                  <Download /> Download
                </a>
              </DropdownMenuItem>
            )}
        <DropdownMenuItem onClick={() => void actions.favorite([u.g.id], !u.g.favorite).catch((e) => toastError(e))}>
          <Heart /> {u.g.favorite ? "Unlike" : "Like"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void copyWithToast(u.g.prompt ?? "", "Prompt copied")}
        >
          <Copy /> Copy prompt
        </DropdownMenuItem>
        {elsewhere ? (
          // Another project's take (My Generations): it moves within its own project.
          <DropdownMenuItem asChild>
            <Link href={`/cinema/${u.g.projectId}`}>
              <ExternalLink /> Open its project
            </Link>
          </DropdownMenuItem>
        ) : (
          !u.tile && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput /> Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                <MoveToItems
                  folders={folders}
                  onMove={(f) =>
                    void actions
                      .move([u.g.id], f)
                      .then((n) => toast(n ? "Moved" : "That take isn't in this project", { duration: 1500 }))
                      .catch((e) => toastError(e))
                  }
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onDelete([u.g.id])}>
          <Trash2 /> {deleteLabel(u.g, !owner)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TileView({
  u,
  layout,
  fit,
  selected,
  selecting,
  onToggle,
  onOpen,
  projectId,
  folders,
  handlers,
  onDelete,
  dragIds,
}: {
  u: Unit;
  layout: Layout;
  fit: boolean;
  selected: boolean;
  selecting: boolean;
  onToggle: (shift: boolean) => void;
  onOpen: () => void;
  projectId: string;
  folders: CinemaFolder[];
  handlers: FeedHandlers;
  onDelete: (ids: string[]) => void;
  dragIds: () => string[];
}) {
  const actions = useItemActions(projectId);
  const g = u.g;
  const ratio = u.tile ? 1 : tileRatio(g);
  const aspect = layout === "square" ? 1 : u.output?.kind === "audio" ? 1.6 : ratio;
  const step = u.tile ? `Tile ${u.tile.row >= 0 ? `${u.tile.row + 1}·${u.tile.col + 1}` : u.tile.col + 1}` : (g.request.step?.label ?? STEP_HINT[g.feature]);
  const media =
    active(g) ? (
      <PendingTile g={g} ratio={aspect} />
    ) : g.status !== "succeeded" ? (
      <FailedTile g={g} ratio={aspect} onRetry={() => void actions.retry(g).catch((e) => toastError(e))} />
    ) : (
      <div className={cn("relative size-full", fit && "bg-muted")}>
        {/* Behind the video: visible until (or if) the browser can draw its first frame. */}
        {u.output?.kind === "video" && <Video className="absolute top-1/2 left-1/2 size-6 -translate-1/2 text-subtle-foreground" aria-hidden />}
        <MediaThumb output={u.output!} className={cn("relative", fit && "object-contain")} />
      </div>
    );
  const clickable = g.status === "succeeded";
  const checkbox = (
    <span
      className={cn(
        "absolute top-2 left-2 z-10 transition-opacity",
        selected || selecting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover/tile:opacity-100 sm:group-focus-within/tile:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
    >
      <Checkbox checked={selected} aria-label={selected ? "Unselect" : "Select"} className="size-5 border-white/80 bg-black/30 shadow-soft data-[state=checked]:border-primary" />
    </span>
  );
  if (layout === "list") {
    return (
      <div
        className={cn("group/tile relative flex items-center gap-3 rounded-xl border p-2 transition-colors", selected ? "border-primary bg-brand-faint" : "hover:bg-accent")}
        draggable={!u.tile}
        onDragStart={(e) => e.dataTransfer.setData("application/x-cinema-takes", JSON.stringify(dragIds()))}
      >
        <Checkbox checked={selected} onCheckedChange={() => onToggle(false)} aria-label={selected ? "Unselect" : "Select"} className="ml-1 size-4" />
        <button
          type="button"
          onClick={(e) => (selecting || e.metaKey || e.ctrlKey ? onToggle(e.shiftKey) : clickable && onOpen())}
          className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-36"
          aria-label="Open"
        >
          {g.status === "succeeded" ? <MediaThumb output={u.output!} className={fit ? "object-contain" : undefined} /> : <span className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">{active(g) ? "Rendering…" : "Failed"}</span>}
        </button>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13.5px] leading-snug">{promptOf(g)}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11.5px] text-muted-foreground">
            {[step, getModel(g.modelId)?.name ?? g.modelId, g.provider === "mock" ? "Placeholder" : g.engine === "open" ? "Open source" : "Cloud", timeAgo(g.createdAt), g.costUsd ? formatCost(g.costUsd) : null, g.status === "failed" ? g.error : null]
              .filter(Boolean)
              .map((m, i) => (
                <span key={i} className={cn(i > 0 && "before:mr-1.5 before:content-['·']", m === g.error && "text-destructive")}>
                  {m}
                </span>
              ))}
          </p>
        </div>
        {g.favorite && <Heart className="size-4 shrink-0 fill-highlight text-highlight" />}
        <div className="shrink-0 rounded-lg bg-foreground/70 [&_button]:text-white">
          <TileMenu u={u} folders={folders} projectId={projectId} handlers={handlers} onDelete={onDelete} />
        </div>
      </div>
    );
  }
  // The tile opens (or, while selecting, toggles) through a real button laid over the media, next to
  // the checkbox and the action buttons rather than around them (no nested interactive controls).
  const overlay = (clickable || selecting) && (
    <button
      type="button"
      aria-label={selecting ? `${selected ? "Unselect" : "Select"}: ${promptOf(g)}` : u.scene ? "Open 3D scene" : `Open ${step ? `${step}: ` : ""}${promptOf(g)}`}
      aria-pressed={selecting ? selected : undefined}
      onClick={(e) => {
        if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) onToggle(e.shiftKey);
        else onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === " " && !selecting) {
          e.preventDefault();
          onToggle(false);
        }
      }}
      className={cn("absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", clickable && !selecting && "cursor-zoom-in")}
    />
  );
  return (
    <div
      draggable={!u.tile}
      onDragStart={(e) => e.dataTransfer.setData("application/x-cinema-takes", JSON.stringify(dragIds()))}
      className={cn(
        "group/tile relative overflow-hidden rounded-xl bg-muted",
        layout === "masonry" && "mb-3 break-inside-avoid",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      style={{ aspectRatio: aspect }}
    >
      {media}
      {overlay}
      {checkbox}
      {g.status === "succeeded" && !selecting && <PlaceholderChip g={g} overlay className="absolute top-2 left-10" />}
      <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1">
        {g.favorite && <Heart className="size-4 fill-highlight text-highlight drop-shadow" />}
        {u.scene && (
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-black/55 px-2 text-[11.5px] font-medium text-white backdrop-blur" aria-hidden>
            <Box className="size-3.5" /> 3D
          </span>
        )}
      </div>
      {g.status === "succeeded" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/65 to-transparent p-2 pt-8 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/tile:opacity-100 sm:group-hover/tile:opacity-100">
          <div className="flex min-w-0 flex-wrap gap-1">
            {step && <Badge>{step}</Badge>}
            {u.output?.kind === "video" && g.request.params?.duration ? <Badge>{g.request.params.duration}s</Badge> : null}
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-0.5">
            {u.output?.kind === "video" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => handlers.onUseTake(g, u.output!)} className="grid size-7 place-items-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white" aria-label="Extend or edit this take">
                    <FastForward className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Extend · Prequel · Edit</TooltipContent>
              </Tooltip>
            )}
            {u.scene ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => handlers.onOpenScene(g)} className="grid size-7 place-items-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white" aria-label="Open 3D scene">
                    <Box className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open the 3D scene: fly, frame, capture</TooltipContent>
              </Tooltip>
            ) : (
              u.output?.kind === "image" && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" onClick={() => handlers.onAnimate(u.output!.url)} className="grid size-7 place-items-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white" aria-label="Animate">
                        <Clapperboard className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Animate: use as the start frame</TooltipContent>
                  </Tooltip>
                  {handlers.onCreateScene && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" onClick={() => handlers.onCreateScene?.(g, u.output!.url)} className="grid size-7 place-items-center rounded-lg text-white/90 hover:bg-white/20 hover:text-white" aria-label={`Create 3D scene · ${handlers.scenePrice}`}>
                          <Box className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Create 3D scene · {handlers.scenePrice}</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )
            )}
            <TileMenu u={u} folders={folders} projectId={projectId} handlers={handlers} onDelete={onDelete} />
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChips({ prefs, setPrefs, nested, onNested }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; nested?: boolean; onNested?: (v: boolean) => void }) {
  const n = [prefs.type !== "all", prefs.date !== "all", prefs.status !== "all", prefs.hideFailed].filter(Boolean).length;
  const group = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) => (
    <div className="space-y-1">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map(([id, name]) => (
          <button key={id} type="button" onClick={() => on(id)} className={cn("h-7 rounded-full px-2.5 text-[12px] font-medium", value === id ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium", n ? "bg-brand-faint text-brand-text" : "bg-secondary hover:bg-accent")} aria-label="Filters">
          <SlidersHorizontal className="size-3.5" /> Filters{n ? ` · ${n}` : ""}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,320px)] space-y-3 p-3" collisionPadding={12}>
        {group("Type", prefs.type, [["all", "All types"], ["image", "Image"], ["video", "Video"], ["audio", "Audio"]], (type) => setPrefs({ type }))}
        {group("Date", prefs.date, [["all", "All period"], ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]], (date) => setPrefs({ date }))}
        {group("Status", prefs.status, [["all", "Any"], ["liked", "Liked"], ["rendering", "Rendering"], ["failed", "Failed"]], (status) => setPrefs({ status }))}
        <label className="flex items-center justify-between text-[13px]">
          Hide failed <Switch checked={prefs.hideFailed} onCheckedChange={(hideFailed) => setPrefs({ hideFailed })} />
        </label>
        {onNested && (
          <label className="flex items-center justify-between gap-3 text-[13px]">
            Include generations from nested folders <Switch checked={!!nested} onCheckedChange={onNested} />
          </label>
        )}
        {n > 0 && (
          <button type="button" onClick={() => setPrefs({ type: "all", date: "all", status: "all", hideFailed: false })} className="text-[12px] font-medium text-brand-text hover:underline">
            Clear filters
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function CinemaFeed({
  projectId,
  items,
  folders,
  title,
  empty,
  handlers,
  nested,
  onNested,
  toolbarExtra,
}: {
  projectId: string;
  items: CinemaGeneration[];
  folders: CinemaFolder[];
  title: React.ReactNode;
  empty: React.ReactNode;
  handlers: FeedHandlers;
  nested?: boolean;
  onNested?: (v: boolean) => void;
  toolbarExtra?: React.ReactNode;
}) {
  const [prefs, setPrefs] = usePrefs();
  const actions = useItemActions(projectId);
  const qc = useQueryClient();
  // Takes with a 2K finish under way or made: their menus don't offer Finish in 2K again.
  const finished = useMemo(() => finishedTakes(items), [items]);
  // Stills on Fuobe Soul Cinema and Soul Location's Movie look finish in the browser (the 21:9 crop, the grade).
  useSoulFinish(items, CINEMA_KEY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Date filters count from when the feed opened.
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const age = { today: 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
    return items.filter((g) => {
      // A 3D scene is neither an image nor a video (its depth map is an image output): it shows under All types.
      if (prefs.type !== "all" && (g.feature === "cinema-scene" || !(g.outputs.some((o) => o.kind === prefs.type) || (g.status !== "succeeded" && g.kind === prefs.type)))) return false;
      if (prefs.date === "today" && dayLabel(g.createdAt) !== "Today") return false;
      if (prefs.date !== "all" && prefs.date !== "today" && now - g.createdAt > age[prefs.date]) return false;
      if (prefs.status === "liked" && !g.favorite) return false;
      if (prefs.status === "rendering" && !active(g)) return false;
      if (prefs.status === "failed" && (g.status !== "failed" && g.status !== "canceled")) return false;
      if (prefs.hideFailed && (g.status === "failed" || g.status === "canceled")) return false;
      return true;
    });
  }, [items, prefs, now]);
  const all = useMemo(() => units(filtered), [filtered]);
  const viewable = all.filter((u) => u.g.status === "succeeded" && !u.scene);
  const pos = open ? viewable.findIndex((u) => u.key === open) : -1;
  const ids = useMemo(() => [...new Set(all.map((u) => u.g.id))], [all]);
  const live = [...selected].filter((id) => ids.includes(id));
  const selecting = live.length > 0;

  // Esc unselects (Higgsfield: "Unselect All (Esc)").
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest("input,textarea,[role=dialog]")) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const toggle = (id: string, shift: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (shift && anchor) {
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const groups = useMemo(() => {
    if (!prefs.split) return [{ label: "", units: all }];
    const map = new Map<string, Unit[]>();
    for (const u of all) {
      const k = dayLabel(u.g.createdAt);
      map.set(k, [...(map.get(k) ?? []), u]);
    }
    return [...map.entries()].map(([label, us]) => ({ label, units: us }));
  }, [all, prefs.split]);

  const layoutCls = prefs.layout === "square" ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" : prefs.layout === "masonry" ? "columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5" : "space-y-2";
  // Delete moves to the Trash (the takes stay filed in their project): Undo puts them back. Whoever has no Trash (a
  // signed-in account) deletes for good.
  const owner = useIsOwner();
  const del = async (list: string[]) => {
    setSelected(new Set());
    try {
      await actions.remove(list);
    } catch (e) {
      toastError(e);
      return;
    }
    if (!owner) return void toast(list.length > 1 ? `${list.length} takes deleted` : "Deleted", { id: "cinema-trash", duration: 3000 });
    toast(list.length > 1 ? `${list.length} takes moved to Trash` : "Moved to Trash", {
      id: "cinema-trash",
      duration: 6000,
      action: { label: "Undo", onClick: () => void actions.restore(list).catch((e) => toastError(e)) },
    });
  };
  const own = live.filter((id) => !items.some((g) => g.id === id && foreign(g, projectId)));
  const layouts = [
    ["square", LayoutGrid, "Square"],
    ["masonry", Rows3, "Masonry"],
    ["list", List, "List"],
  ] as const;

  return (
    <FinishedIn2k.Provider value={finished}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">{title}</div>
        {toolbarExtra}
        {/* Phones: layout, split and fit share one View menu so the toolbar fits on a line. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[12.5px] font-medium hover:bg-accent sm:hidden" aria-label="View options">
              <Eye className="size-3.5" /> View
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={prefs.layout} onValueChange={(v) => setPrefs({ layout: v as Layout })}>
              {layouts.map(([id, Icon, label]) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  <Icon /> {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={prefs.split} onCheckedChange={(split) => setPrefs({ split: !!split })}>
              Split by date
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.fit} onCheckedChange={(fit) => setPrefs({ fit: !!fit })}>
              Fit previews (whole frame)
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden h-8 rounded-full bg-muted p-0.5 sm:inline-flex" role="radiogroup" aria-label="Layout">
          {layouts.map(([id, Icon, label]) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={prefs.layout === id}
                  aria-label={label}
                  onClick={() => setPrefs({ layout: id })}
                  className={cn("grid w-8 place-items-center rounded-full", prefs.layout === id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
                >
                  <Icon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-pressed={prefs.split} onClick={() => setPrefs({ split: !prefs.split })} className={cn("hidden size-8 place-items-center rounded-full sm:grid", prefs.split ? "bg-brand-faint text-brand-text" : "bg-secondary hover:bg-accent")} aria-label="Split by date">
              <CalendarDays className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Split by date</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-pressed={prefs.fit} onClick={() => setPrefs({ fit: !prefs.fit })} className={cn("hidden h-8 items-center rounded-full px-2.5 text-[12px] font-medium sm:inline-flex", prefs.fit ? "bg-brand-faint text-brand-text" : "bg-secondary hover:bg-accent")} aria-label={prefs.fit ? "Fit previews" : "Fill previews"}>
              <Grid3x3 className="mr-1 size-3.5" />
              {prefs.fit ? "Fit" : "Fill"}
            </button>
          </TooltipTrigger>
          <TooltipContent>{prefs.fit ? "Fit previews (whole frame)" : "Fill previews (cropped)"}</TooltipContent>
        </Tooltip>
        <FilterChips prefs={prefs} setPrefs={setPrefs} nested={nested} onNested={onNested} />
      </div>

      {selecting && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-1.5 rounded-full border bg-background/95 py-1 pr-1 pl-3 shadow-strong backdrop-blur animate-pop-in">
          <span className="text-[13px] font-medium">{live.length} selected</span>
          <button type="button" onClick={() => setSelected(new Set())} className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-3.5" /> Unselect all <kbd className="ml-0.5 font-mono text-[10px]">Esc</kbd>
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void actions.favorite(live, !items.filter((g) => live.includes(g.id)).every((g) => g.favorite)).catch((e) => toastError(e))}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium hover:bg-accent"
          >
            <Heart className="size-3.5" /> {items.filter((g) => live.includes(g.id)).every((g) => g.favorite) ? "Unlike" : "Like"}
          </button>
          {own.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium hover:bg-accent">
                  <FolderInput className="size-3.5" /> Move to
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                {own.length < live.length && <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">Takes from other projects stay where they are</DropdownMenuLabel>}
                <MoveToItems
                  folders={folders}
                  onMove={(f) =>
                    void actions
                      .move(own, f)
                      .then((n) => {
                        toast(`Moved ${n} take${n === 1 ? "" : "s"}`, { duration: 1500 });
                        setSelected(new Set());
                      })
                      .catch((e) => toastError(e))
                  }
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button type="button" onClick={() => void del(live)} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-destructive hover:bg-destructive/10">
            <Trash2 className="size-3.5" /> {owner ? "Move to Trash" : "Delete"}
          </button>
        </div>
      )}

      {!all.length ? (
        items.length ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">Nothing matches these filters.</p>
        ) : (
          empty
        )
      ) : (
        <div className="space-y-6">
          {groups.map((grp) => (
            <section key={grp.label || "all"} className="space-y-2.5">
              {grp.label && (
                <h2 className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                  {grp.label}
                  <span className="font-mono text-[11px] text-muted-foreground">{grp.units.length}</span>
                </h2>
              )}
              <div className={layoutCls}>
                {grp.units.map((u) => (
                  <TileView
                    key={u.key}
                    u={u}
                    layout={prefs.layout}
                    fit={prefs.fit}
                    selected={selected.has(u.g.id)}
                    selecting={selecting}
                    onToggle={(shift) => toggle(u.g.id, shift)}
                    onOpen={() => (u.scene ? handlers.onOpenScene(u.g) : setOpen(u.key))}
                    projectId={projectId}
                    folders={folders}
                    handlers={handlers}
                    onDelete={(list) => void del(list)}
                    dragIds={() => (selected.has(u.g.id) ? live : [u.g.id])}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {pos >= 0 && (
        <Viewer
          generation={{ ...viewable[pos].g, outputs: [viewable[pos].output!] }}
          index={0}
          onClose={() => {
            setOpen(null);
            // The viewer likes and deletes through /api/generations: pick those changes up.
            void qc.invalidateQueries({ queryKey: ["cinema", projectId, "items"] });
            void qc.invalidateQueries({ queryKey: ["cinema", "studio"] });
          }}
          onPrev={pos > 0 ? () => setOpen(viewable[pos - 1].key) : undefined}
          onNext={pos < viewable.length - 1 ? () => setOpen(viewable[pos + 1].key) : undefined}
          onReuse={(g) => handlers.onLoad(g as CinemaGeneration)}
        />
      )}

    </div>
    </FinishedIn2k.Provider>
  );
}
