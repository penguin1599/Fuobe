"use client";

import { Check, ChevronDown, Heart, Layers, MoreHorizontal, Pin, RotateCcw } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { tileRatio } from "@/components/studio/feed";
import { TileActions, useCanHover, type RunnerOptions } from "@/components/studio/result-actions";
import { LayersStack, MediaThumb, SmallThumb } from "@/components/studio/result-media";
import { OPERATION_LABELS, type Generation } from "@/lib/catalog/types";
import { elapsed, timeAgo } from "@/lib/format";
import { coverOf, trashDaysLeft, userTitle, type LibraryEntry } from "@/lib/library";
import { isLayered, shownOutputs } from "@/lib/output-actions";
import { cn } from "@/lib/utils";
import { PlaceholderChip } from "@/components/demo-mode";
import { TroubleActions, TroubleDetails } from "@/components/gpu/trouble";
import { DRAG_TYPE } from "./folders";
import { ReviewBadge } from "./review";
import type { Layout } from "./view-options";

/** Stable callbacks from the Library (refs inside), so cards re-render only when their own data changes. */
export interface CardApi {
  open: (g: Generation, index: number) => void;
  /** Toggle these generations; shift extends a range from the last toggled card. */
  toggle: (key: string, ids: string[], shift: boolean) => void;
  expand: (key: string) => void;
  /** What a drag carries: the whole selection when the card is part of it. */
  dragIds: (ids: string[]) => string[];
  retry: (g: Generation) => void;
  runner: RunnerOptions;
}

/** A card's width / height: square in the Square layout, else its cover's own shape. */
export function cardRatio(e: LibraryEntry, layout: Layout): number {
  if (layout === "square") return 1;
  if (e.type === "stack") {
    const c = coverOf(e.items);
    return c ? tileRatio(c.g) : 1;
  }
  const g = e.g;
  return g.status === "succeeded" ? (isLayered(g) ? Math.max(tileRatio(g), 0.8) : tileRatio(g)) : Math.max(tileRatio(g), 0.8);
}

const LIST_MENU ="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground";

const idsOf = (e: LibraryEntry) => (e.type === "single" ? [e.g.id] : e.items.map((g) => g.id));

export function StatusCover({ g }: { g: Generation }) {
  if (g.status === "queued" || g.status === "running") {
    const pct = g.progress != null ? Math.round(g.progress * 100) : null;
    return (
      <div className="relative size-full bg-muted">
        <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="shimmer-text animate-shimmer-text truncate text-[13px] font-medium">{g.message ?? (g.status === "queued" ? "Queued" : "Generating…")}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {pct != null ? `${pct}% · ` : ""}
            {elapsed(g.createdAt)}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex size-full flex-col justify-between border border-dashed bg-background p-3">
      <div className="min-h-0 space-y-1 overflow-hidden">
        <p className="text-[13px] font-medium">{g.status === "canceled" ? "Canceled" : "Couldn't generate this one"}</p>
        {g.error && <p className="line-clamp-4 text-[12px] leading-snug break-words text-muted-foreground">{g.error}</p>}
        {/* An account's own GPU or key: what came back (small), and the way out (Start your pod, Check my GPU, Replace key…). */}
        {g.status === "failed" && g.trouble && (
          <>
            <TroubleDetails details={g.trouble.details} />
            <TroubleActions className="pt-1" actions={g.trouble.actions} skip={["retry"]} max={2} />
          </>
        )}
      </div>
    </div>
  );
}

function Cover({ g, fit }: { g: Generation; fit: boolean }) {
  if (g.status !== "succeeded" || !g.outputs.length) return <StatusCover g={g} />;
  if (isLayered(g)) return <LayersStack g={g} />;
  return <MediaThumb output={g.outputs[0]} g={g} fit={fit} className={cn(fit && "bg-muted")} />;
}

function SelectDot({ selected, visible, onToggle, label }: { selected: boolean; visible: boolean; onToggle: (shift: boolean) => void; label: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={selected}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      className={cn(
        "absolute top-2 left-2 z-10 grid size-6 place-items-center rounded-full border-2 transition-opacity",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-white/90 bg-black/25 text-transparent backdrop-blur",
        visible || selected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100",
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  );
}

export const AssetCard = memo(function AssetCard({
  entry,
  layout,
  fit,
  selecting,
  selected,
  expanded,
  api,
}: {
  entry: LibraryEntry;
  layout: Layout;
  fit: boolean;
  selecting: boolean;
  selected: boolean;
  expanded?: boolean;
  api: CardApi;
}) {
  const canHover = useCanHover();
  const [hot, setHot] = useState<false | "bar" | "menu">(false);
  const stack = entry.type === "stack" ? entry : null;
  const cover = useMemo(() => (stack ? coverOf(stack.items) : null), [stack]);
  const g = stack ? (cover?.g ?? stack.items[0]) : (entry as Extract<LibraryEntry, { type: "single" }>).g;
  const ids = useMemo(() => idsOf(entry), [entry]);
  const title = stack ? stack.title : userTitle(g);
  const trashed = !!g.deletedAt;
  const done = g.status === "succeeded" && g.outputs.length > 0;
  const ratio = cardRatio(entry, layout);

  const activate = (shift: boolean) => {
    if (selecting) api.toggle(entry.key, ids, shift);
    else if (stack) api.expand(entry.key);
    else if (done) api.open(g, 0);
  };
  // The card handles mouse clicks; keyboards and screen readers use this button over it, a sibling of
  // the card's other buttons (none sits inside another). It lets the pointer through to the media.
  const target = (
    <button
      type="button"
      aria-label={stack ? `${title} — ${stack.label}` : selecting ? `Select “${title}”` : done ? `Open “${title}”` : title}
      aria-pressed={selecting ? selected : undefined}
      aria-expanded={stack && !selecting ? !!expanded : undefined}
      onClick={(e) => {
        e.stopPropagation();
        activate(e.shiftKey);
      }}
      onKeyDown={(e) => {
        // Shift+Enter extends a selection like a shift-click.
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        activate(e.shiftKey);
      }}
      className="pointer-events-none absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    />
  );
  const common = {
    onClick: (e: React.MouseEvent) => activate(e.shiftKey),
    draggable: canHover && !trashed,
    onDragStart: (e: React.DragEvent) => {
      const dragged = api.dragIds(ids);
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged));
      e.dataTransfer.setData("text/plain", `${dragged.length} item${dragged.length === 1 ? "" : "s"}`);
      e.dataTransfer.effectAllowed = "move";
    },
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === "mouse" && !hot && setHot("bar"),
    onFocus: () => canHover && !hot && setHot("bar"),
  };
  const showActions = !selecting && !stack && done;
  // Audio keeps its player at the bottom of the card: its actions go along the top.
  const audio = done && !stack && g.outputs[0].kind === "audio";
  const count = shownOutputs(g).length;
  // Touch screens: just a ⋯ button that opens every action (at the top for audio, by the badges).
  const touchMenu =
    showActions &&
    !canHover &&
    (hot === "menu" ? (
      <TileActions g={g} index={0} opts={api.runner} menuOnly className={audio ? undefined : "absolute right-2 bottom-2"} />
    ) : (
      <button
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setHot("menu");
        }}
        className={cn("grid size-8 place-items-center rounded-lg bg-black/45 text-white backdrop-blur", !audio && "absolute right-2 bottom-2")}
      >
        <MoreHorizontal className="size-4" />
      </button>
    ));
  const badges = (
    <>
      <div className={cn("absolute top-2 right-2 flex items-center gap-1.5", audio && canHover && "group-focus-within/card:opacity-0 group-hover/card:opacity-0")}>
        {!stack && !trashed && <ReviewBadge narrow status={g.review} />}
        {!stack && count > 1 && !isLayered(g) && <span className="rounded-full bg-black/55 px-1.5 py-0.5 font-mono text-[11px] text-white backdrop-blur">×{count}</span>}
        {g.pinnedAt && !stack && !trashed && (
          <span className="grid size-5 place-items-center rounded-full bg-black/55 text-white backdrop-blur" title="Pinned">
            <Pin className="size-3" aria-label="Pinned" />
          </span>
        )}
        {g.favorite && !stack && <Heart className="m-0.5 size-4 fill-highlight text-highlight drop-shadow" />}
        {audio && touchMenu}
      </div>
      {trashed && (
        <span className="absolute bottom-2 left-2 rounded-full bg-background/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur">
          {trashDaysLeft(g.deletedAt!)} days left
        </span>
      )}
    </>
  );
  const actions = canHover
    ? showActions &&
      hot === "bar" && (
        <TileActions
          g={g}
          index={0}
          opts={api.runner}
          tone={audio ? "surface" : "media"}
          className={cn(
            // Audio: clear of the select dot in the corner.
            audio ? "absolute inset-x-0 top-0 p-2 pl-10" : "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 pt-8",
            "opacity-0 transition-opacity duration-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100",
          )}
        />
      )
    : !audio && touchMenu;

  if (layout === "list") {
    return (
      <div
        {...common}
        className={cn("group/card relative flex min-h-16 cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent", selected && "bg-brand-faint hover:bg-brand-faint-hover")}
      >
        {target}
        <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
          {stack ? cover ? <SmallThumb output={cover.o} g={cover.g} /> : <StatusCover g={g} /> : done ? <SmallThumb output={g.outputs[0]} g={g} /> : <StatusCover g={g} />}
          <SelectDot selected={selected} visible={selecting} onToggle={(s) => api.toggle(entry.key, ids, s)} label={`Select ${title}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{title}</span>
            {g.pinnedAt && !stack && !trashed && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
            {!stack && !trashed && <ReviewBadge status={g.review} className="bg-muted" />}
            {!stack && !selecting && <PlaceholderChip g={g} className="h-6 shrink-0 px-2 text-[11px]" />}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {stack ? `${stack.label} · ` : `${g.modelName ?? g.modelId} · ${OPERATION_LABELS[g.op]} · `}
            {trashed ? `${trashDaysLeft(g.deletedAt!)} days left in Trash` : timeAgo(g.createdAt)}
            {/* "Rendering", as the Status filter calls it: "In progress" is a review status. */}
            {!stack && g.status !== "succeeded" && ` · ${g.status === "failed" ? "Failed" : g.status === "canceled" ? "Canceled" : g.status === "queued" ? "Queued" : "Rendering"}`}
          </p>
        </div>
        {g.favorite && !stack && <Heart className="size-4 shrink-0 fill-highlight text-highlight" />}
        {stack && <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />}
        {!stack && (g.status === "failed" || g.status === "canceled") && !trashed && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.retry(g);
            }}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 text-[12px] font-medium hover:bg-accent"
          >
            <RotateCcw className="size-3" /> Retry
          </button>
        )}
        {showActions &&
          (hot === "menu" ? (
            <TileActions g={g} index={0} opts={api.runner} menuOnly triggerClassName={LIST_MENU} />
          ) : (
            <button
              aria-label="More actions"
              onClick={(e) => {
                e.stopPropagation();
                setHot("menu");
              }}
              className={LIST_MENU}
            >
              <MoreHorizontal className="size-4" />
            </button>
          ))}
      </div>
    );
  }

  return (
    <div className="group/card relative">
      {stack && (
        // The stack look: two sheets peeking out behind the cover.
        <>
          <div className="absolute inset-x-3 -top-1.5 h-4 rounded-xl bg-border" aria-hidden />
          <div className="absolute inset-x-1.5 -top-0.75 h-4 rounded-xl bg-border-strong" aria-hidden />
        </>
      )}
      <div
        {...common}
        className={cn(
          "@container relative w-full cursor-pointer overflow-hidden rounded-xl bg-muted transition-[box-shadow]",
          !selecting && done && !stack && "cursor-zoom-in",
          selected && "ring-3 ring-primary",
          expanded && "ring-2 ring-border-strong",
        )}
        style={{ aspectRatio: ratio }}
      >
        {stack ? cover ? <MediaThumb output={cover.o} g={cover.g} fit={fit} /> : <StatusCover g={g} /> : <Cover g={g} fit={fit} />}
        {target}
        {selected && <div className="pointer-events-none absolute inset-0 bg-primary/15" />}
        {stack && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-3 pt-10 text-white">
            <p className="line-clamp-2 font-heading text-[17px] leading-snug">{title}</p>
            <p className="mt-0.5 flex items-center gap-1 text-[12px] text-white/80">
              <Layers className="size-3" /> {stack.label}
            </p>
          </div>
        )}
        {badges}
        {/* A placeholder says so on the card, past the select dot (not while selecting: a tap there selects). */}
        {!stack && done && !selecting && !trashed && (
          <PlaceholderChip g={g} overlay className={cn("absolute top-2", audio && canHover && "group-focus-within/card:opacity-0 group-hover/card:opacity-0 focus-within:opacity-100! has-data-[state=open]:opacity-100!")} />
        )}
        <SelectDot selected={selected} visible={selecting} onToggle={(s) => api.toggle(entry.key, ids, s)} label={`Select ${title}`} />
        {actions}
        {!stack && (g.status === "failed" || g.status === "canceled") && !trashed && !selecting && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.retry(g);
            }}
            className="absolute bottom-2 left-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] font-medium hover:bg-accent"
          >
            <RotateCcw className="size-3" /> Retry
          </button>
        )}
      </div>
    </div>
  );
});
