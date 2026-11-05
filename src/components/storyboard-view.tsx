"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Clapperboard, Film, ImagePlus, LayoutGrid, Loader2, Minus, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebounced } from "@/components/faceless/hooks";
import { costText } from "@/components/shorts/ui";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { finishGaveUp, useSoulFinish } from "@/components/studio/soul-finish";
import { FailedTile, MediaThumb, PendingTile, tileRatio } from "@/components/studio/feed";
import { fileToSlot, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { Viewer } from "@/components/studio/viewer";
import { StarterParam } from "@/components/starters/starter-param";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { COMPUTER_KICK_EVENT, useCreateGeneration, useEngine, useGenerationActions, useGenerations, useHydrated, useIsAccount, useStatus, uploadFile } from "@/lib/api";
import { askDeleteForGood } from "@/components/studio/delete-for-good";
import {
  MAX_FRAMES,
  ONE_SHEET_GPU_TEST,
  sheetCrop,
  sheetPanelLimit,
  sheetPanelStyle,
  sheetState,
  STORYBOARD_ASPECTS,
  STORYBOARD_PARTNER_IDS,
  type SheetFrames,
  type StoryboardNextScene,
  type StoryboardPartner,
} from "@/lib/catalog/storyboard";
import { lookCard } from "@/lib/catalog/soul-cards";
import type { Engine, Generation } from "@/lib/catalog/types";
import { timeAgo } from "@/lib/format";
import { BOARD_TITLES_KEY, boardTitle, filmReady, rememberTitle } from "@/lib/storyboard-board";
import { animateHref, MAX_KEYS } from "@/lib/inbetween";
import { starterShown, type StarterCardData, type StarterFill } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { ratioValue } from "@/lib/format";
import { responseError, toastError } from "@/lib/refusals";
import { BoardExample, hasBoardExample } from "@/components/empty-examples";

const ASPECTS: readonly string[] = STORYBOARD_ASPECTS;

/** Fuobe Soul's look picker, in its own chunk (the board works without it). */
const LookChip = dynamic(() => import("@/components/studio/look-chip"), {
  loading: () => <span aria-hidden className="h-8 w-28 shrink-0 animate-pulse rounded-full bg-secondary" />,
});

interface BoardEstimate {
  costUsd: number | null;
  demo: boolean;
  frames: number;
  models: string[];
}

/* The idea each board was made from, remembered in this browser (the server keeps only the scenes). */
const titleListeners = new Set<() => void>();
let titleCache: { raw: string | null; map: Record<string, string> } | null = null;
function readTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BOARD_TITLES_KEY);
    if (titleCache?.raw !== raw) titleCache = { raw, map: raw ? (JSON.parse(raw) as Record<string, string>) : {} };
    return titleCache.map;
  } catch {
    return {};
  }
}
const NO_TITLES: Record<string, string> = {};
function saveTitle(batchId: string, idea: string) {
  try {
    localStorage.setItem(BOARD_TITLES_KEY, JSON.stringify(rememberTitle(readTitles(), batchId, idea)));
  } catch {}
  titleListeners.forEach((l) => l());
}
function useBoardTitles() {
  return useSyncExternalStore(
    (cb) => {
      titleListeners.add(cb);
      return () => titleListeners.delete(cb);
    },
    readTitles,
    () => NO_TITLES,
  );
}

const modelName = (g: Generation, names: Record<string, string>) => (g as Generation & { modelName?: string }).modelName ?? names[g.modelId] ?? g.modelId;

/**
 * Start a board or its film. Stopped by the GPU pre-flight, the guided fix opens (src/lib/api.ts watchGuestRefusals), so
 * no error toast goes on top of it. A run started on the ComfyUI on this computer (an account's "Your GPU") is asked for by
 * the tab that runs it at once.
 */
async function startRun<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = (await res.json().catch(() => ({}))) as T & { error?: string; gpuWarning?: string };
  if (res.status === 409 && res.headers.get("x-fuobe-gpu-setup") === "1") throw Object.assign(new Error(b.error ?? "This needs setting up on your GPU"), { refusalShown: true });
  if (!res.ok) throw responseError(res, b.error ?? "Something went wrong. Please try again.");
  window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
  // Its own ComfyUI seems to miss something: said, never a stop.
  if (b.gpuWarning) toast.warning(b.gpuWarning);
  return b;
}

function RatioPill({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Aspect ratio" className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5">
      {ASPECTS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          onClick={() => onChange(a)}
          className={cn("h-7 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition", value === a && "bg-background text-foreground shadow-soft")}
        >
          {a}
        </button>
      ))}
    </div>
  );
}

/** What a cloud board's frames are made on: Fuobe's open recipe, or a partner model for every frame. */
function PartnerPill({ value, onChange, names }: { value?: StoryboardPartner; onChange: (v?: StoryboardPartner) => void; names: Record<string, string> }) {
  const options: { v?: StoryboardPartner; label: string; title: string }[] = [
    { label: "Fuobe", title: "Fuobe's own look, frame to frame" },
    ...STORYBOARD_PARTNER_IDS.map((p) => ({ v: p, label: names[p] ?? p, title: `The frames on ${names[p] ?? p}, a partner model (frame 1 stays on Fuobe Soul in a look)` })),
  ];
  return (
    <div role="radiogroup" aria-label="Frames made on" className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.v ?? "fuobe"}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cn("h-7 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition", value === o.v && "bg-background text-foreground shadow-soft")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** What a GPU board's next frames are made on: Qwen-Image 2.1 (Latest, the default), or the classic recipe boards used before. */
function NextScenePill({ value, onChange }: { value?: StoryboardNextScene; onChange: (v?: StoryboardNextScene) => void }) {
  const options: { v?: StoryboardNextScene; label: string; title: string }[] = [
    { label: "Latest", title: "Each next frame continues the last one on the newest model" },
    { v: "classic", label: "Classic", title: "Each next frame on the model boards used before" },
  ];
  return (
    <div role="radiogroup" aria-label="Next frames made on" className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.v ?? "qwen-21"}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cn("h-7 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition", value === o.v && "bg-background text-foreground shadow-soft")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** How the board is drawn: frame by frame (each from the last), or every panel together on one sheet. */
function SheetPill({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const options = [
    { v: false, label: "Frame by frame", title: "Each frame is made from the one before" },
    { v: true, label: "One sheet", title: "Every panel drawn together on one page, then cut into frames" },
  ];
  return (
    <div role="radiogroup" aria-label="How the board is drawn" className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition", value === o.v && "bg-background text-foreground shadow-soft")}
        >
          {o.v && <LayoutGrid className="size-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The film made from a board: the joined video big, its shots small underneath. */
function FilmStrip({ items, ratio, onOpen }: { items: Generation[]; ratio: number; onOpen: (g: Generation) => void }) {
  const create = useCreateGeneration();
  const sorted = [...items].sort((a, b) => (a.request.step?.index ?? 0) - (b.request.step?.index ?? 0));
  const film = sorted.findLast((g) => g.op === "concat");
  const shots = sorted.filter((g) => g.op !== "concat");
  const tile = (g: Generation, className?: string) =>
    g.status === "succeeded" && g.outputs[0] ? (
      <button onClick={() => onOpen(g)} className={cn("block w-full overflow-hidden rounded-xl bg-muted", className)} style={{ aspectRatio: ratio }}>
        <MediaThumb output={g.outputs[0]} autoPlay={g === film} />
      </button>
    ) : g.status === "failed" || g.status === "canceled" ? (
      <FailedTile g={g} ratio={ratio} onRetry={() => create.mutate(g.request, { onError: (e) => toastError(e) })} />
    ) : (
      <PendingTile g={g} ratio={ratio} />
    );
  return (
    <div className="grid gap-3 rounded-2xl border bg-muted/30 p-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {film && <div className="min-w-0">{tile(film)}</div>}
      <div className="grid min-w-0 grid-cols-2 content-start gap-2">
        {shots.map((g) => (
          <figure key={g.id} className="min-w-0 space-y-1">
            {tile(g)}
            <figcaption className="truncate text-[11px] text-muted-foreground">{g.request.step?.label}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function FrameTile({ g, index, ratio, onOpen }: { g: Generation; index: number; ratio: number; onOpen: (g: Generation) => void }) {
  const create = useCreateGeneration();
  const o = g.outputs[0];
  return (
    <figure className="min-w-0 space-y-1.5">
      <div className="group/tile relative overflow-hidden rounded-xl" style={{ aspectRatio: ratio }}>
        {g.status === "succeeded" && o ? (
          <>
            <button onClick={() => onOpen(g)} className="block size-full cursor-zoom-in bg-muted" aria-label={`Open frame ${index + 1}`}>
              <MediaThumb output={o} />
            </button>
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 pt-8 transition-opacity group-focus-within/tile:opacity-100 sm:opacity-0 sm:group-hover/tile:opacity-100">
              <Link
                href={`/video?image=${encodeURIComponent(o.url)}&prompt=${encodeURIComponent(g.request.frame?.scene ?? "")}`}
                className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-white/20 px-2.5 text-[12px] font-medium whitespace-nowrap text-white backdrop-blur hover:bg-white/30"
              >
                <Clapperboard className="size-3.5" /> Animate
              </Link>
              <Link
                href={`/edit?image=${encodeURIComponent(o.url)}`}
                className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-white/20 px-2.5 text-[12px] font-medium whitespace-nowrap text-white backdrop-blur hover:bg-white/30"
              >
                <Wand2 className="size-3.5" /> Edit
              </Link>
            </span>
          </>
        ) : g.status === "failed" || g.status === "canceled" ? (
          <FailedTile g={g} ratio={ratio} onRetry={() => create.mutate(g.request, { onError: (e) => toastError(e) })} />
        ) : (
          <PendingTile g={g} ratio={ratio} />
        )}
        <span className="pointer-events-none absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-background/90 font-mono text-[11px] font-semibold shadow-soft">
          {index + 1}
        </span>
      </div>
      <figcaption className="line-clamp-2 px-0.5 text-[12px] leading-snug text-muted-foreground">{g.request.frame?.scene}</figcaption>
    </figure>
  );
}

/** A panel of a one-sheet board cut out of the sheet in the browser, stored as a picture of its own (its URL). */
async function cropPanel(url: string, box: SheetFrames["panels"][number]["box"], name: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const [x, y, w, h] = sheetCrop(box, img.naturalWidth, img.naturalHeight);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, w, h);
  const blob = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't cut the panel out"))), "image/png"));
  return (await uploadFile(new File([blob], `${name}.png`, { type: "image/png" }))).url;
}

/** A one-sheet board: the page as it came out, then each panel shown from it as a frame (cut out when it is used). */
function SheetPanels({ g, sheet, onOpen }: { g: Generation; sheet: SheetFrames; onOpen: (g: Generation) => void }) {
  const create = useCreateGeneration();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const o = g.status === "succeeded" ? g.outputs[0] : undefined;
  const panelRatio = ratioValue(sheet.aspect, 16 / 9);
  const sheetRatio = tileRatio(g);
  const use = async (i: number, to: "video" | "edit") => {
    if (!o) return;
    const key = `${to}-${i}`;
    setBusy(key);
    try {
      const url = await cropPanel(o.url, sheet.panels[i].box, `storyboard-panel-${i + 1}`);
      router.push(to === "video" ? `/video?image=${encodeURIComponent(url)}&prompt=${encodeURIComponent(sheet.panels[i].scene)}` : `/edit?image=${encodeURIComponent(url)}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  if (!o) {
    return (
      <div className="max-w-xl">
        {g.status === "failed" || g.status === "canceled" ? (
          <FailedTile g={g} ratio={sheetRatio} onRetry={() => create.mutate(g.request, { onError: (e) => toastError(e) })} />
        ) : (
          <PendingTile g={g} ratio={sheetRatio} />
        )}
      </div>
    );
  }
  const action = "pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-white/20 px-2.5 text-[12px] font-medium whitespace-nowrap text-white backdrop-blur hover:bg-white/30 disabled:opacity-60";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
        {sheet.panels.map((p, i) => (
          <figure key={i} className="min-w-0 space-y-1.5">
            <div className="group/tile relative overflow-hidden rounded-xl bg-muted" style={{ aspectRatio: panelRatio }}>
              <button
                onClick={() => onOpen(g)}
                className="block size-full cursor-zoom-in bg-no-repeat"
                style={{ backgroundImage: `url("${o.url}")`, ...sheetPanelStyle(p.box) }}
                aria-label={`Open the sheet at panel ${i + 1}`}
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 pt-8 transition-opacity group-focus-within/tile:opacity-100 sm:opacity-0 sm:group-hover/tile:opacity-100">
                <button type="button" className={action} disabled={!!busy} onClick={() => void use(i, "video")}>
                  {busy === `video-${i}` ? <Loader2 className="size-3.5 animate-spin" /> : <Clapperboard className="size-3.5" />} Animate
                </button>
                <button type="button" className={action} disabled={!!busy} onClick={() => void use(i, "edit")}>
                  {busy === `edit-${i}` ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Edit
                </button>
              </span>
              <span className="pointer-events-none absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-background/90 font-mono text-[11px] font-semibold shadow-soft">{i + 1}</span>
            </div>
            <figcaption className="line-clamp-2 px-0.5 text-[12px] leading-snug text-muted-foreground">{p.scene}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function Board({
  frames,
  film,
  onOpen,
  idea,
  names,
}: {
  frames: Generation[];
  film: Generation[];
  onOpen: (g: Generation) => void;
  idea?: string;
  names: Record<string, string>;
}) {
  const { trash } = useGenerationActions();
  // An account has no Trash: its board goes for good, so it says so and asks first.
  const account = useIsAccount();
  const qc = useQueryClient();
  const first = frames[0];
  const done = frames.filter((f) => f.status === "succeeded").length;
  // A look board's frames are graded (and cropped) here first: the film starts from them as they look.
  const ready = filmReady(frames, finishGaveUp);
  const ratio = tileRatio(first);
  const sheet = first.request.frame?.sheet;
  // A click's film, once: a repeat of the request (a second click that got through) gets the film the first one started.
  const filmRequest = useRef(nanoid());
  const makeFilm = useMutation({
    mutationFn: () => startRun<{ items: Generation[] }>(`/api/storyboards/${first.batchId}/film`, { requestId: filmRequest.current }),
    onSuccess: (b) => {
      filmRequest.current = nanoid();
      toast.success(`Animating ${b.items.length - 1} shots, then joining them into one film`);
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
    onError: (e) => toastError(e),
  });
  const filmButton = (
    <Button variant="secondary" size="sm" disabled={!ready || makeFilm.isPending} onClick={() => makeFilm.mutate()} className="whitespace-nowrap">
      {makeFilm.isPending ? <Loader2 className="animate-spin" /> : <Film />} Make the film
    </Button>
  );
  return (
    <section className="animate-fade-up space-y-3">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h3 className="line-clamp-2 font-heading text-[19px] leading-snug">{boardTitle(frames, idea)}</h3>
          <p className="text-[12px] text-muted-foreground">
            {sheet
              ? `${sheet.panels.length} panels on one sheet · ${sheetState(first.status)}`
              : `${frames.length} frames · ${done === frames.length ? "done" : `${done}/${frames.length} ready`}`}{" "}
            · {modelName(first, names)} · {timeAgo(first.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {frames.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                {ready ? (
                  <Button asChild variant="ghost" size="sm" className="whitespace-nowrap">
                    <Link href={animateHref(frames.map((f) => f.outputs[0]?.url).filter((u): u is string => !!u), idea)} data-animate-panels>
                      <Sparkles /> Animate these panels
                    </Link>
                  </Button>
                ) : (
                  <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Button variant="ghost" size="sm" disabled className="whitespace-nowrap">
                      <Sparkles /> Animate these panels
                    </Button>
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent>
                {ready
                  ? `The panels become keyframes${frames.length > MAX_KEYS ? ` (the first ${MAX_KEYS})` : ""}, and the motion between them is drawn in an animation style`
                  : `Ready when all ${frames.length} frames are done`}
              </TooltipContent>
            </Tooltip>
          )}
          {!film.length && frames.length > 1 && first.batchId && (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button gets no pointer events, so the tooltip hangs on a wrapper. */}
                <span tabIndex={ready ? -1 : 0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {filmButton}
                </span>
              </TooltipTrigger>
              <TooltipContent>{ready ? "Animate each frame into the next, then join them" : `Ready when all ${frames.length} frames are done`}</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={account ? "Delete storyboard for good" : "Move storyboard to Trash"}
            // One bulk call, and the shared toast with Undo (the frames go to the Trash).
            onClick={() => (account ? askDeleteForGood([...frames, ...film]) : void trash([...frames, ...film], "Storyboard moved to Trash"))}
          >
            <Trash2 /> <span className="hidden sm:inline">{account ? "Delete for good…" : "Move to Trash"}</span>
          </Button>
        </div>
      </header>
      {sheet ? (
        <SheetPanels g={first} sheet={sheet} onOpen={onOpen} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {frames.map((g, i) => (
            <FrameTile key={g.id} g={g} index={i} ratio={ratio} onOpen={onOpen} />
          ))}
        </div>
      )}
      {film.length > 0 && <FilmStrip items={film} ratio={ratio} onOpen={onOpen} />}
    </section>
  );
}

export function StoryboardView({
  modelNames = {},
  starters: given = [],
  fills: givenFills = {},
}: {
  /** Display names of the storyboard models, from the server. */
  modelNames?: Record<string, string>;
  /** The ready stories with their real cover (catalog cards), and what each one puts into the composer, by id. */
  starters?: StarterCardData[];
  fills?: Record<string, StarterFill>;
}) {
  const { owner, starters, fills } = useStarters("storyboard", given, givenFills);
  const qc = useQueryClient();
  const [engine, setEngine] = useEngine();
  // The engine is known once the install's engine mode is and the page has hydrated (until then useEngine answers the
  // server's "cloud"): no price asked for a cloud board an open-only install refuses.
  const hydrated = useHydrated();
  const status = useStatus().data;
  const statusReady = hydrated && !!status;
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [story, setStory] = useState("");
  const [count, setCount] = useState(4);
  const [scenes, setScenes] = useState<string[]>(["", "", ""]);
  const [style, setStyle] = useState("");
  const [aspect, setAspect] = useState("16:9");
  const [refs, setRefs] = useState<SlotValue[]>([]);
  const [look, setLook] = useState<string | undefined>();
  const [lookStrength, setLookStrength] = useState(1);
  // Cloud only: a partner model for every frame instead of Fuobe's open recipe.
  const [partner, setPartner] = useState<StoryboardPartner | undefined>();
  // Your GPU only: the next frames' model (Qwen-Image 2.1 unless the classic recipe is picked).
  const [nextScene, setNextScene] = useState<StoryboardNextScene | undefined>();
  // One sheet: every panel on one MOSS-Image page, offered up to the panels a GPU render showed (the owner's until then).
  // Known once the page has hydrated (useStarters' owner): the server renders it without the viewer.
  const sheetLimit = sheetPanelLimit(owner);
  const [sheetPicked, setSheet] = useState(false);
  const sheet = sheetPicked && sheetLimit > 0;
  const [open, setOpen] = useState<Generation | null>(null);
  // A ready story fills the composer (for everyone: the price shows at once), from its
  // page's link (?starter=<id>) or its card here, then the composer comes into view.
  const storyRef = useRef<HTMLTextAreaElement>(null);
  const applyStarter = (id: string) => {
    const s = Object.hasOwn(fills, id) ? fills[id] : undefined;
    if (s?.kind !== "storyboard") return false;
    setMode("auto");
    setStory(s.story);
    setCount(Math.min(MAX_FRAMES, Math.max(2, s.frames)));
    setAspect(s.aspectRatio);
    setLook(s.look);
    setLookStrength(1);
    requestAnimationFrame(() => {
      storyRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      storyRef.current?.focus({ preventScroll: true });
    });
    return true;
  };
  const hasStarters = starters.some((s) => starterShown(s, !owner));
  const feed = useGenerations({ features: ["storyboard", "storyboard-film"], limit: 240 });
  const titles = useBoardTitles();
  // A board with a look: each frame gets the look's grade and overlay here, once it's made.
  useSoulFinish(feed.data ?? []);

  const films = useMemo(() => {
    const by = new Map<string, Generation[]>();
    for (const g of feed.data ?? []) {
      if (g.feature !== "storyboard-film" || !g.batchId) continue;
      const k = g.batchId.replace(/-film$/, "");
      by.set(k, [...(by.get(k) ?? []), g]);
    }
    return by;
  }, [feed.data]);
  const boards = useMemo(() => {
    const by = new Map<string, Generation[]>();
    for (const g of (feed.data ?? []).filter((x) => x.feature === "storyboard")) {
      const k = g.batchId ?? g.id;
      by.set(k, [...(by.get(k) ?? []), g]);
    }
    return [...by.values()].map((fs) => fs.sort((a, b) => (a.request.frame?.index ?? 0) - (b.request.frame?.index ?? 0)));
  }, [feed.data]);
  const flat = boards.flatMap((b) => [...b, ...(films.get(b[0].batchId ?? "") ?? [])].filter((g) => g.status === "succeeded" && g.outputs[0]));
  const pos = open ? flat.findIndex((g) => g.id === open.id) : -1;

  const boardPartner = engine === "cloud" ? partner : undefined;
  const boardNextScene = engine === "open" ? nextScene : undefined;
  const lookName = look ? lookCard(look)?.name : undefined;
  const filled = scenes.filter((s) => s.trim());
  const sheetCount = Math.min(count, sheetLimit || MAX_FRAMES);
  const boardBody = sheet
    ? { engine, sheet: true, ...(mode === "auto" ? { story, frames: sheetCount } : { scenes: filled.slice(0, sheetLimit) }), references: [] as string[], style: style || undefined, aspectRatio: aspect }
    : {
        engine,
        ...(boardPartner && { partner: boardPartner }),
        ...(boardNextScene && { nextScene: boardNextScene }),
        ...(mode === "auto" ? { story, frames: count } : { scenes: filled }),
        references: refs.filter((r) => r.ref && !r.uploading).map((r) => r.ref),
        style: style || undefined,
        ...(look && { look, lookStrength }),
        aspectRatio: aspect,
      };
  // The price before it runs: the words don't change it, so typing doesn't ask again.
  const priceKey = useDebounced(JSON.stringify({ ...boardBody, story: undefined, scenes: mode === "auto" ? undefined : filled.map(() => "·") }), 300);
  const estimate = useQuery({
    queryKey: ["storyboard-estimate", priceKey],
    queryFn: async () => {
      const res = await fetch("/api/storyboards/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: priceKey });
      const body = await res.json();
      if (!res.ok) throw responseError(res, body.error);
      return body as BoardEstimate;
    },
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
    enabled: statusReady && (JSON.parse(priceKey) as { engine?: string }).engine === engine,
  });
  const est = estimate.data && !estimate.isError ? estimate.data : undefined;
  // A click's board, once: a repeat of the request (a second click that got through) gets the board the first one started.
  const boardRequest = useRef(nanoid());
  const submit = useMutation({
    // A board for anyone: the owner's, or an account's on its own GPU or key. A guest's click opens the sign-up card.
    mutationFn: () =>
      startRun<{ scenes: string[]; batchId?: string }>("/api/storyboards", {
        ...(sheet ? boardBody : { ...boardBody, references: refs.filter((r) => r.ref).map((r) => r.ref) }),
        requestId: boardRequest.current,
      }),
    onSuccess: (b) => {
      boardRequest.current = nanoid();
      const idea = mode === "auto" ? story : scenes.find((s) => s.trim());
      if (b.batchId && idea?.trim()) saveTitle(b.batchId, idea);
      toast.success(sheet ? `${b.scenes.length} panels on the way, drawn together on one sheet` : `${b.scenes.length} frames on the way — each one builds on the last`);
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
    onError: (e) => toastError(e),
  });

  const ready = (mode === "auto" ? story.trim().length > 3 : scenes.some((s) => s.trim())) && (sheet || !refs.some((r) => r.uploading));
  const addRef = (f: File) => {
    const id = nanoid(6);
    void fileToSlot(f, (v) =>
      setRefs((rs) => {
        if (!v) return rs.filter((r) => r.id !== id);
        if (rs.some((r) => r.id === id)) return rs.map((r) => (r.id === id ? { ...v, id } : r));
        // A reference removed while it uploaded stays removed.
        return v.uploading ? [...rs, { ...v, id }] : rs;
      }),
    );
  };

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <Suspense fallback={null}>
        <StarterParam onStarter={applyStarter} />
      </Suspense>
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="min-w-0 truncate font-heading text-[22px] leading-none">Storyboard</h1>
        <div className="ml-auto">
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full min-w-0 max-w-[1240px] flex-1 space-y-10 px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-[820px] pt-6 text-center">
          <h2 className="font-heading text-display text-balance">Tell it frame by frame</h2>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {sheet
              ? `Up to ${sheetLimit} panels drawn together on one page, so faces, wardrobe and light match, then cut into frames.`
              : `Up to ${MAX_FRAMES} consistent frames. Each one is made from the one before, so faces, wardrobe and light carry through.`}
            {!sheet && lookName && !refs.length ? ` Frame 1 sets the ${lookName} look.` : ""}
          </p>
          <div className="mt-6 rounded-[20px] border bg-background p-3 text-left shadow-soft focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint sm:rounded-composer">
            <div role="radiogroup" aria-label="How to write it" className="mb-2 flex items-center gap-1 rounded-full bg-muted p-0.5 text-[13px] font-medium sm:w-fit">
              {(["auto", "manual"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={mode === k}
                  onClick={() => setMode(k)}
                  className={cn("h-8 flex-1 rounded-full px-4 whitespace-nowrap text-muted-foreground transition", mode === k && "bg-background text-foreground shadow-soft")}
                >
                  {k === "auto" ? "From one idea" : "Scene by scene"}
                </button>
              ))}
            </div>
            {mode === "auto" ? (
              <textarea
                ref={storyRef}
                value={story}
                onChange={(e) => setStory(e.target.value)}
                rows={2}
                aria-label="Your story"
                placeholder="The whole story in a sentence or two — e.g. “a model in an emerald gown slips out of a palace ball at midnight and drives a vintage car to the sea”"
                className="field-sizing-content max-h-52 min-h-16 w-full resize-none bg-transparent px-2 py-1.5 text-base leading-relaxed outline-none placeholder:text-subtle-foreground"
              />
            ) : (
              <div className="space-y-1.5">
                {scenes.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-xl border bg-muted/40 p-1.5 pl-2.5">
                    <span className="mt-1.5 font-mono text-[12px] font-semibold text-muted-foreground">{i + 1}</span>
                    <textarea
                      value={s}
                      onChange={(e) => setScenes((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                      rows={1}
                      aria-label={`Frame ${i + 1}`}
                      placeholder={i ? "What happens next?" : "Opening frame — who, where, what"}
                      className="field-sizing-content max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] outline-none placeholder:text-subtle-foreground"
                    />
                    <button
                      type="button"
                      onClick={() => setScenes((xs) => (xs.length > 1 ? xs.filter((_, j) => j !== i) : xs))}
                      className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent"
                      aria-label={`Remove frame ${i + 1}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                {scenes.length < (sheet ? sheetLimit : MAX_FRAMES) && (
                  <button type="button" onClick={() => setScenes((xs) => [...xs, ""])} className="inline-flex items-center gap-1 px-1 text-[12px] font-medium text-brand-text hover:underline">
                    <Plus className="size-3" /> Add frame
                  </button>
                )}
              </div>
            )}
            <input
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              aria-label="Look (optional)"
              placeholder="Look (optional) — e.g. “35mm film, moody teal night, anamorphic”"
              className="mt-2 h-9 w-full rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!sheet && refs.map((r) => (
                <div key={r.id} className="relative size-12 overflow-hidden rounded-lg border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.preview} alt="" className="size-full object-cover" />
                  {r.uploading && <Loader2 className="absolute inset-0 m-auto size-4 animate-spin" />}
                  <button
                    type="button"
                    onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
                    className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-foreground/80 text-background"
                    aria-label="Remove reference"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
              {!sheet && refs.length < 4 && <MediaSlot label="Look ref" kind="image" value={null} onChange={(v) => v && setRefs((rs) => [...rs, { ...v, id: nanoid(6) }])} onFile={addRef} />}
              {mode === "auto" && (
                <div className="flex items-center gap-1 rounded-full bg-secondary px-1 py-0.5 text-[13px] font-medium">
                  <button type="button" onClick={() => setCount((c) => Math.max(2, c - 1))} className="grid size-7 place-items-center rounded-full hover:bg-accent" aria-label="Fewer frames">
                    <Minus className="size-3.5" />
                  </button>
                  <span className="w-16 text-center whitespace-nowrap tabular-nums" aria-live="polite">
                    {sheet ? `${sheetCount} panels` : `${count} frames`}
                  </span>
                  <button type="button" onClick={() => setCount((c) => Math.min(sheet ? sheetLimit : MAX_FRAMES, c + 1))} className="grid size-7 place-items-center rounded-full hover:bg-accent" aria-label="More frames">
                    <Plus className="size-3.5" />
                  </button>
                </div>
              )}
              {sheetLimit > 0 && <SheetPill value={sheet} onChange={setSheet} />}
              {!sheet && <LookChip value={look} strength={lookStrength} onChange={(id) => setLook(id)} onStrength={setLookStrength} none="No look" />}
              <RatioPill value={aspect} onChange={setAspect} />
              {!sheet && engine === "cloud" && <PartnerPill value={partner} onChange={setPartner} names={modelNames} />}
              {!sheet && engine === "open" && <NextScenePill value={nextScene} onChange={setNextScene} />}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className="text-right text-[12px] leading-tight tabular-nums text-muted-foreground" aria-live="polite">
                  {estimate.isError ? (
                    <span className="text-destructive">{(estimate.error as Error).message}</span>
                  ) : (
                    <>
                      <span className="block font-semibold text-foreground">{costText(est, engine as Engine)}</span>
                      {est && (sheet ? `${est.frames} panels · 1 sheet` : `${est.frames} frame${est.frames === 1 ? "" : "s"}`)}
                    </>
                  )}
                </span>
                <Button size="icon" className="size-10 shrink-0 rounded-full" disabled={!ready || submit.isPending || estimate.isError} onClick={() => submit.mutate()} aria-label="Generate storyboard">
                  {submit.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="mt-px size-3 shrink-0" />
              {mode === "auto" ? "Fuobe splits your story into frames." : "One prompt per frame. References keep the cast consistent."}
              {sheet && ` One sheet draws every panel at once on MOSS-Image, then cuts it into frames.${ONE_SHEET_GPU_TEST ? "" : " Not yet tested on a GPU (shown to you as the owner)."}`}
              {!sheet && lookName && ` Every frame gets the ${lookName} look's grade${aspect === "21:9" ? ", made at 16:9 and cropped to 21:9" : ""}.`}
            </p>
          </div>
        </div>

        {feed.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-video rounded-xl" />
            ))}
          </div>
        ) : boards.length ? (
          <div className="space-y-10">
            {boards.map((b) => (
              <Board
                key={b[0].batchId ?? b[0].id}
                frames={b}
                film={films.get(b[0].batchId ?? "") ?? []}
                onOpen={setOpen}
                idea={b[0].batchId ? titles[b[0].batchId] : undefined}
                names={modelNames}
              />
            ))}
            <StarterSection surface="storyboard" starters={given} onFill={applyStarter} row className="col-span-full pt-6" />
          </div>
        ) : hasStarters ? (
          <StarterSection surface="storyboard" starters={given} onFill={applyStarter} />
        ) : (
          <div className="grid place-items-center rounded-xl border border-dashed px-4 py-14 text-center text-muted-foreground">
            {/* An example board (six frames) in place of the icon, once it is published. */}
            {hasBoardExample() ? <BoardExample /> : <ImagePlus className="size-6" />}
            <p className={cn("text-[14px]", hasBoardExample() ? "mt-4" : "mt-2")}>Your storyboards appear here.</p>
          </div>
        )}
      </div>
      {open && pos >= 0 && (
        <Viewer
          generation={flat[pos]}
          index={0}
          onClose={() => setOpen(null)}
          onPrev={pos > 0 ? () => setOpen(flat[pos - 1]) : undefined}
          onNext={pos < flat.length - 1 ? () => setOpen(flat[pos + 1]) : undefined}
        />
      )}
    </div>
  );
}
