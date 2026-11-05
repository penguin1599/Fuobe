"use client";

import { Cloud, Copy, Cpu, Download, FolderDown, Heart, MoreHorizontal, RotateCcw, Sparkles, Trash2, Wrench, X } from "lucide-react";
import { lineWords } from "@/lib/hosted";
import { openGpuSetup } from "@/hooks/use-gpu";
import { useLocalJob } from "@/components/gpu/computer-runner";
import { jobFraction, jobWords } from "@/lib/relay";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OPERATION_LABELS, type Generation } from "@/lib/catalog/types";
import { onCloudKey } from "@/lib/before-run";
import { TroubleActions, TroubleDetails } from "@/components/gpu/trouble";
import { useCreateGeneration, useGenerationActions, useStatus } from "@/lib/api";
import { placeholdersOn } from "@/lib/demo-mode";
import { useSoulFinish } from "./soul-finish";
import { elapsed, formatCost, leftLabel, notePace, ratioValue, timeAgo, timeLeft } from "@/lib/format";
import { downloadHref, downloadName, userTitle } from "@/lib/library";
import { draftRenderPaid, isLayered, shownOutputs } from "@/lib/output-actions";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { toastError } from "@/lib/refusals";
import { TileActions, useCanHover, type RunnerOptions } from "./result-actions";
import { LayersStack, MediaThumb } from "./result-media";
import { useNow } from "./use-now";
import { PlaceholderChip } from "@/components/demo-mode";
import { Viewer } from "./viewer";
import { NextSteps } from "@/components/nav/next-steps";
import { reservedRowHeight, useArrival, useEnter, useFollowRow, useLiveRun } from "./feed-motion";

export { MediaThumb } from "./result-media";
export { downloadName } from "@/lib/library";

/** A result's tile shape: its aspect ratio (the request's or the model's default, from the server). */
export function tileRatio(g: Generation): number {
  if (g.kind === "audio") return 1.6;
  if (g.kind === "text") return 0.85;
  const ar = g.request.params?.aspectRatio ?? g.aspectRatio ?? undefined;
  return ratioValue(ar && ar !== "auto" ? ar : undefined, g.kind === "video" ? 16 / 9 : 1);
}

export function PendingTile({ g, ratio }: { g: Generation; ratio: number }) {
  const { cancel } = useGenerationActions();
  // The clock runs between the job's reports (a fal queue or Higgsfield may report rarely).
  const now = useNow(1000);
  // Running on the ComfyUI on this computer: its live preview (sharper with each step), where it runs, and its step now.
  // Its % and time left come from its own steps then, so they agree with "step 9 of 12".
  const local = useLocalJob(g.id, now);
  useLiveRun(g.id);
  const label = (local && jobWords(local.job, g.kind, g.message ?? undefined, local.comfy)) ?? (g.status === "queued" ? (g.message ?? "Queued") : (g.message ?? "Generating…"));
  const steps = local ? jobFraction(local.job) : null;
  const saving = local && (local.job.phase === "saving" || local.job.phase === "done");
  const fraction = local ? (saving ? null : steps) : g.progress;
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  // When progress moved (not every poll: each one rewrites updatedAt) gives the pace, so the time left.
  // Keyed by id: a chain's tile moves on to its next step's generation.
  const report = local ? steps : g.status === "running" ? g.progress : null;
  const at = local ? now : g.updatedAt;
  const [track, setTrack] = useState(() => ({ id: g.id, pace: notePace(null, at, report) }));
  const pace = track.id === g.id ? notePace(track.pace, at, report) : notePace(null, at, report);
  if (track.id !== g.id || pace !== track.pace) setTrack({ id: g.id, pace });
  const left = !saving && pace.first && pace.last ? timeLeft(pace.first, pace.last, now) : null;
  // The bar: the steps, or how much of the result has reached the studio.
  const bar = saving ? Math.round((local.job.phase === "done" ? 1 : (local.job.saved ?? 0)) * 100) : pct;
  const where = local ? (local.here ? "Keep this tab open" : "Running in another Fuobe tab") : null;
  return (
    // max-w-full: in a grid row stretched by a taller neighbour (a card with a footer), h-full + aspect-ratio would
    // otherwise make the tile wider than its column and spill over the next card.
    <div className="relative h-full max-w-full overflow-hidden rounded-xl bg-muted" style={{ aspectRatio: ratio }}>
      <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
      {local?.preview && (
        // eslint-disable-next-line @next/next/no-img-element -- a live frame from the person's own ComfyUI (a blob: address)
        <img
          src={local.preview}
          alt=""
          // Shown once a frame decodes (a frame that doesn't keeps the shimmer).
          onLoad={(e) => (e.currentTarget.style.opacity = "0.9")}
          onError={(e) => (e.currentTarget.style.opacity = "0")}
          className="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-300"
        />
      )}
      <div className={cn("absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3", local?.preview && "bg-gradient-to-t from-background/85 to-transparent pt-8")}>
        <div className="min-w-0">
          <p title={label} className="shimmer-text animate-shimmer-text line-clamp-2 text-[13px] font-medium">
            {label}
          </p>
          {where && (
            <p title={where} className="line-clamp-2 text-[11px] text-muted-foreground">
              {where}
            </p>
          )}
          <p className="flex flex-wrap gap-x-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
            {pct != null && <span>{pct}%</span>}
            <span className={cn(pct != null && "before:mr-1.5 before:content-['·']")}>{elapsed(g.createdAt, Math.max(now, g.createdAt))}</span>
            {left != null && <span className="before:mr-1.5 before:content-['·']">{leftLabel(left)}</span>}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void cancel(g);
              }}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-background/70 text-muted-foreground hover:text-foreground"
              aria-label="Cancel"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Cancel</TooltipContent>
        </Tooltip>
      </div>
      {bar != null && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-transparent">
          <div className="h-full origin-left bg-primary transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${bar / 100})` }} />
        </div>
      )}
    </div>
  );
}

export function FailedTile({ g, ratio, onRetry }: { g: Generation; ratio: number; onRetry: () => void }) {
  const create = useCreateGeneration();
  const trouble = g.status === "failed" ? g.trouble : undefined;
  return (
    <div className="flex h-full max-w-full flex-col justify-between rounded-xl border border-dashed bg-background p-3" style={{ aspectRatio: Math.max(ratio, 0.8) }}>
      <div className="min-h-0 space-y-1 overflow-hidden">
        <p className="text-[13px] font-medium">{g.status === "canceled" ? "Canceled" : "Couldn't generate this one"}</p>
        {g.error && <p className="line-clamp-5 text-[12px] leading-snug break-words whitespace-pre-line text-muted-foreground">{g.error}</p>}
        {/* An account's own GPU or key: what came back, small, for the curious. */}
        <TroubleDetails details={trouble?.details} />
      </div>
      {trouble && (
        <TroubleActions
          className="mt-2"
          actions={trouble.actions}
          skip={["retry"]}
          max={3}
          handlers={{ onRunWithKey: (a) => create.mutate(onCloudKey(g.request, a), { onError: (e) => toastError(e) }) }}
        />
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {g.status === "failed" && g.fix && (
          // Something was missing on the GPU: the guided fix shows what, and how to add it.
          <button
            onClick={(e) => {
              e.stopPropagation();
              openGpuSetup({ ref: g.presetId ? `preset:${g.presetId}` : `model:${g.modelId}#${g.op}`, name: g.presetName ?? g.modelName });
            }}
            className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-highlight px-2.5 text-[12px] font-medium text-highlight-foreground hover:opacity-90"
          >
            <Wrench className="size-3" /> Fix it
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] font-medium hover:bg-accent"
        >
          <RotateCcw className="size-3" /> Retry
        </button>
      </div>
    </div>
  );
}

/** Seedance draft mode: render the chosen 480p take again at 1080p with the same seed and settings. */
export function useFinalizeDraft() {
  const create = useCreateGeneration();
  return (g: Generation, draftId: string) =>
    create.mutate(
      { feature: g.feature, modelId: g.modelId, op: "finalize", prompt: g.request.prompt, params: { draftId, resolution: "1080p", duration: g.request.params?.duration } },
      { onSuccess: () => toast.success("Rendering the final 1080p version"), onError: (e) => toastError(e) },
    );
}

// ---------------------------------------------------------------------------
// Feed: one stable context for every group, so a poll or a keystroke re-renders only what changed.

interface FeedApi {
  open: (g: Generation, index: number) => void;
  retry: (g: Generation) => void;
  runner: RunnerOptions;
  reuse?: (g: Generation) => void;
}

const FeedCtx = createContext<FeedApi | null>(null);

function useFeed(): FeedApi {
  const c = useContext(FeedCtx);
  if (!c) throw new Error("GenerationGroup outside Feed");
  return c;
}

function DraftButton({ g, draftId }: { g: Generation; draftId: string }) {
  const finalize = useFinalizeDraft();
  const placeholders = placeholdersOn(useStatus().data?.demoMode);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        finalize(g, draftId);
      }}
      className="absolute top-2 left-2 inline-flex h-7 items-center gap-1 rounded-full bg-black/55 pr-2.5 pl-2 text-[12px] font-medium text-white backdrop-blur transition-colors hover:bg-black/75"
    >
      <Sparkles className="size-3.5" /> Draft · render 1080p{draftRenderPaid(placeholders)}
    </button>
  );
}

const SHOW_ON_HOVER = "opacity-0 transition-opacity duration-100 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100";

const OutputTile = memo(function OutputTile({ g, index, ratio, layered, count }: { g: Generation; index: number; ratio: number; layered?: boolean; count: number }) {
  const feed = useFeed();
  const canHover = useCanHover();
  // Actions mount on first hover / focus / tap: a long feed shouldn't hold thousands of menus and tooltips.
  const [hot, setHot] = useState<false | "bar" | "menu">(false);
  const o = g.outputs[index];
  const audio = o.kind === "audio";
  const ctx = useMemo(() => ({ reuse: !!feed.reuse }), [feed.reuse]);
  const arrive = useArrival<HTMLDivElement>(g.id, index);
  return (
    // The tile opens on click; keyboards and screen readers use the Open button over it (a sibling of
    // the action buttons, so no button sits inside another).
    <div
      ref={arrive}
      onClick={() => feed.open(g, index)}
      onPointerEnter={(e) => e.pointerType === "mouse" && !hot && setHot("bar")}
      onFocus={() => canHover && !hot && setHot("bar")}
      className="group/tile relative h-56 max-w-full cursor-zoom-in overflow-hidden rounded-xl bg-muted sm:h-64"
      style={{ aspectRatio: audio ? 1.6 : layered ? Math.max(ratio, 0.8) : ratio }}
    >
      {layered ? <LayersStack g={g} /> : <MediaThumb output={o} g={g} inset={!canHover || g.favorite} />}
      <button
        type="button"
        aria-label={`Open “${userTitle(g)}”${count > 1 ? ` · ${index + 1} of ${count}` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          feed.open(g, index);
        }}
        className="pointer-events-none absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      {o.draftId && <DraftButton g={g} draftId={o.draftId} />}
      {/* A placeholder says so on the picture itself, with the ways out (a text card keeps its header clear: the chip goes at the bottom). */}
      <PlaceholderChip
        g={g}
        overlay
        className={cn("absolute", o.kind === "text" ? "bottom-2" : o.draftId ? "top-11" : "top-2", audio && canHover && "group-focus-within/tile:opacity-0 group-hover/tile:opacity-0 focus-within:opacity-100! has-data-[state=open]:opacity-100!")}
      />
      {g.favorite && <Heart className={cn("absolute top-2 right-2 size-4 fill-highlight text-highlight drop-shadow", audio && canHover && "group-focus-within/tile:opacity-0 group-hover/tile:opacity-0")} />}
      {canHover && hot === "bar" && (
        <TileActions
          g={g}
          index={index}
          ctx={ctx}
          opts={feed.runner}
          // Audio keeps its player at the bottom: its actions go along the top.
          tone={audio ? "surface" : "media"}
          className={cn(audio ? "absolute inset-x-0 top-0 p-2" : "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 pt-8", SHOW_ON_HOVER)}
        />
      )}
      {!canHover &&
        (hot === "menu" ? (
          <TileActions g={g} index={index} ctx={ctx} opts={feed.runner} menuOnly className={cn("absolute right-2", g.favorite ? "top-8" : "top-2")} />
        ) : (
          <button
            aria-label="More actions"
            onClick={(e) => {
              e.stopPropagation();
              setHot("menu");
            }}
            className={cn("absolute right-2 grid size-8 place-items-center rounded-lg bg-black/45 text-white backdrop-blur", g.favorite ? "top-8" : "top-2")}
          >
            <MoreHorizontal className="size-4" />
          </button>
        ))}
    </div>
  );
});

/** One request: the user's words in serif, a meta line, then its outputs (or progress / failure). */
export const GenerationGroup = memo(function GenerationGroup({ g, newest, first }: { g: Generation; newest?: boolean; /** The feed's top request (newest first). */ first?: boolean }) {
  const feed = useFeed();
  const { favorite, trash } = useGenerationActions();
  const ratio = tileRatio(g);
  const active = g.status === "queued" || g.status === "running";
  const placeholders = Math.max(1, g.request.params?.numOutputs ?? 1);
  const enter = useEnter<HTMLElement>(g.id, active, g.createdAt);
  // The top run on its way, with one picture to come: its next-steps row will land under it, so its room is kept now.
  const reserve = first && active && placeholders === 1 ? reservedRowHeight() : 0;
  const layered = g.status === "succeeded" && isLayered(g);
  const shown = shownOutputs(g);
  const single = g.status === "succeeded" && shown.length === 1 ? g.outputs[shown[0]] : null;
  const singleName = single ? downloadName(g, single, shown[0]) : "";
  const p = g.request.params ?? {};
  // A layout run says so, with its box count (Edit layout reopens them).
  const boxes = (p.extra?.layout as { items?: unknown[] } | undefined)?.items?.length;
  const meta = [
    g.request.step?.label,
    boxes ? `Layout · ${boxes} box${boxes === 1 ? "" : "es"}` : undefined,
    g.presetName,
    g.modelName ?? g.modelId,
    OPERATION_LABELS[g.op],
    p.aspectRatio,
    p.resolution,
    p.duration ? `${p.duration >= 1000 ? p.duration / 1000 : p.duration}s` : undefined,
  ].filter((x, i, all) => x && all.indexOf(x) === i);

  return (
    <section ref={enter} data-gen-id={g.id} className="group/gen space-y-2.5 [contain-intrinsic-size:auto_330px] [content-visibility:auto]">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-heading text-[19px] leading-snug" title={g.prompt ?? undefined}>
            {userTitle(g)}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {g.engine === "open" ? <Cpu className="size-3" /> : <Cloud className="size-3" />}
              {g.provider === "mock" ? "Placeholder" : g.provider === "local" ? "Browser" : g.engine === "open" ? "Open source" : "Cloud"}
            </span>
            {meta.map((m, i) => (
              <span key={i} className="before:mr-1.5 before:content-['·']">
                {m}
              </span>
            ))}
            <span className="before:mr-1.5 before:content-['·']">{timeAgo(g.createdAt)}</span>
            {/* A run its provider never took (a refused key, an empty balance) cost nothing: said, not priced. */}
            {/* On this studio's GPUs (hosted runs): the billing service's words for its charge, or that it cost nothing. */}
            {g.queue ? <span className="before:mr-1.5 before:content-['·']">{lineWords(g.queue)}</span> : null}
            {g.stage === "checking" ? <span className="before:mr-1.5 before:content-['·']">Checking</span> : null}
            {g.place === "pool" ? (
              g.notCharged ? (
                <span className="before:mr-1.5 before:content-['·']">Not charged</span>
              ) : g.charge ? (
                <span className="before:mr-1.5 before:content-['·']">{g.charge}</span>
              ) : null
            ) : g.costUsd && g.notBilled ? (
              <span className="before:mr-1.5 before:content-['·']">Not billed</span>
            ) : g.costUsd ? (
              <span className="font-mono before:mr-1.5 before:content-['·']">{formatCost(g.costUsd)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/gen:opacity-100 sm:focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {feed.reuse && (
            <button
              onClick={() => feed.reuse?.(g)}
              title="Load prompt, model and settings into the composer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="size-3.5" /> Reuse
            </button>
          )}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="More">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => void copyWithToast(g.prompt ?? "", "Prompt copied")}
              >
                <Copy /> Copy prompt
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => feed.retry(g)}>
                <RotateCcw /> Run again
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void favorite(g)}>
                <Heart /> {g.favorite ? "Remove from favorites" : "Add to favorites"}
              </DropdownMenuItem>
              {single && !layered && (
                <DropdownMenuItem asChild>
                  <a href={downloadHref(single.url, singleName)} download={singleName}>
                    <Download /> Download
                  </a>
                </DropdownMenuItem>
              )}
              {g.status === "succeeded" && g.outputs.length > 1 && (
                <DropdownMenuItem asChild>
                  <a href={`/api/generations/zip?ids=${g.id}`} download>
                    <FolderDown /> Download all ({g.outputs.length})
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void trash([g])}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="flex flex-wrap gap-2">
        {active &&
          Array.from({ length: placeholders }, (_, i) => (
            <div key={i} className="h-56 max-w-full sm:h-64">
              <PendingTile g={g} ratio={ratio} />
            </div>
          ))}
        {(g.status === "failed" || g.status === "canceled") && (
          <div className="h-56 max-w-full sm:h-64">
            <FailedTile g={g} ratio={ratio} onRetry={() => feed.retry(g)} />
          </div>
        )}
        {g.status === "succeeded" &&
          (layered ? (
            <OutputTile g={g} index={0} ratio={ratio} layered count={1} />
          ) : (
            shown.map((i) => <OutputTile key={g.outputs[i].url} g={g} index={i} ratio={ratio} count={shown.length} />)
          ))}
      </div>
      {/* Under the newest result: where it can go next, with it attached. A group with several takes has none: which one to take on is picked on its tile. */}
      {newest && !layered && shown.length === 1 && <NextStepsRow g={g} index={shown[0]} />}
      {reserve > 0 && <div aria-hidden style={{ height: reserve }} />}
    </section>
  );
});

/** The next-steps row under the newest result (it follows its result in when that just arrived). */
function NextStepsRow({ g, index }: { g: Generation; index: number }) {
  const row = useFollowRow<HTMLDivElement>(g.id);
  return (
    // Nothing to show (a text result): it takes no room, as before (its margin in the section's spacing cancels out).
    <div ref={row} className="empty:-mt-2.5">
      <NextSteps g={g} index={index} variant="row" max={5} className="pt-1" />
    </div>
  );
}

export function Feed({
  items,
  onReuse,
  empty,
}: {
  items: Generation[];
  onReuse?: (g: Generation) => void;
  empty?: React.ReactNode;
}) {
  const [open, setOpen] = useState<{ id: string; index: number } | null>(null);
  const create = useCreateGeneration();
  // Fuobe Soul results get their look's grade and overlay here, once.
  useSoulFinish(items);
  // Groups get stable callbacks that read the latest props through refs.
  const createRef = useRef(create);
  const reuseRef = useRef(onReuse);
  useEffect(() => {
    createRef.current = create;
    reuseRef.current = onReuse;
  });
  const hasReuse = !!onReuse;
  const openAt = useCallback((g: Generation, index: number) => setOpen({ id: g.id, index }), []);
  const api = useMemo<FeedApi>(
    () => ({
      open: openAt,
      retry: (g) => createRef.current.mutate(g.request, { onError: (e) => toastError(e) }),
      reuse: hasReuse ? (g) => reuseRef.current?.(g) : undefined,
      runner: { onOpen: openAt, onReuse: hasReuse ? (g) => reuseRef.current?.(g) : undefined },
    }),
    [openAt, hasReuse],
  );
  if (!items.length) return <>{empty}</>;
  // The feed is newest first: the next steps go under the first finished result.
  const newest = items.find((g) => g.status === "succeeded")?.id;
  const flat = items.flatMap((g) => (g.status === "succeeded" ? (isLayered(g) ? [{ g, i: 0 }] : shownOutputs(g).map((i) => ({ g, i }))) : []));
  const pos = open ? flat.findIndex((f) => f.g.id === open.id && (f.i === open.index || isLayered(f.g))) : -1;
  return (
    <FeedCtx.Provider value={api}>
      <div className="space-y-9">
        {items.map((g, i) => (
          <GenerationGroup key={g.id} g={g} newest={g.id === newest} first={i === 0} />
        ))}
      </div>
      {open && pos >= 0 && (
        <Viewer
          generation={flat[pos].g}
          index={isLayered(flat[pos].g) ? open.index : flat[pos].i}
          onIndex={(index) => setOpen({ id: flat[pos].g.id, index })}
          onClose={() => setOpen(null)}
          onPrev={pos > 0 ? () => setOpen({ id: flat[pos - 1].g.id, index: flat[pos - 1].i }) : undefined}
          onNext={pos < flat.length - 1 ? () => setOpen({ id: flat[pos + 1].g.id, index: flat[pos + 1].i }) : undefined}
          onReuse={onReuse}
        />
      )}
    </FeedCtx.Provider>
  );
}
