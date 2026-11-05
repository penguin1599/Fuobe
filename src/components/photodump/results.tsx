"use client";

import { Check, Download, Film, Loader2, Maximize2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaThumb, PendingTile } from "@/components/studio/feed";
import { Viewer } from "@/components/studio/viewer";
import { askDeleteForGood } from "@/components/studio/delete-for-good";
import { useGenerationActions, useIsAccount } from "@/lib/api";
import type { Generation, OutputFile } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { downloadZip } from "@/lib/zip-download";
import { useRetryPhoto } from "./hooks";

export interface Tile {
  g: Generation;
  /** Index into g.outputs (finished tiles). */
  i?: number;
  o?: OutputFile;
  key: string;
}

const order = (g: Generation) => g.request.step?.index ?? 0;

/** One tile per finished image, one per expected image while a job runs (a ×4 job shows four placeholders). */
export function tilesOf(items: Generation[]): Tile[] {
  return [...items]
    .sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt)
    .flatMap((g) =>
      g.status === "succeeded"
        ? g.outputs.filter((o) => o.kind === "image").map((o, i) => ({ g, i, o, key: `${g.id}:${i}` }))
        : g.status === "queued" || g.status === "running"
          ? Array.from({ length: Math.max(1, Math.min(4, g.request.params?.numOutputs ?? 1)) }, (_, k) => ({ g, key: `${g.id}:p${k}` }))
          : [{ g, key: `${g.id}:x` }],
    );
}

function IconLink({ href, label, icon: Icon, onClick }: { href?: string; label: string; icon: typeof Film; onClick?: () => void }) {
  const cls = "grid size-7 place-items-center rounded-full bg-background/90 text-foreground shadow-soft outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link href={href} prefetch={false} aria-label={label} className={cls}>
            <Icon className="size-3.5" />
          </Link>
        ) : (
          <button type="button" aria-label={label} onClick={onClick} className={cls}>
            <Icon className="size-3.5" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A photo that failed or was canceled: which one it was ("Photo 3 of 9"), why, and Retry (inside the run). */
function RetryTile({ g, ratio, busy, onRetry }: { g: Generation; ratio: number; busy: boolean; onRetry: () => void }) {
  const which = g.request.step?.label;
  return (
    <div className="flex flex-col justify-between rounded-xl border border-dashed bg-background p-3" style={{ aspectRatio: Math.max(ratio, 0.8) }}>
      <div className="min-h-0 space-y-1 overflow-hidden">
        {which && <p className="text-[11.5px] font-medium text-muted-foreground">{which}</p>}
        <p className="text-[13px] font-medium">{g.status === "canceled" ? "Canceled" : "Couldn't generate this one"}</p>
        {g.error && <p className="line-clamp-4 text-[12px] leading-snug break-words whitespace-pre-line text-muted-foreground">{g.error}</p>}
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        aria-label={`Retry ${which ?? "this photo"}`}
        className="mt-2 inline-flex h-7 w-fit items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Retry
      </button>
    </div>
  );
}

/** How a run is doing: everything made, some still rendering, or some that failed. */
export function runState(items: Generation[]): { total: number; done: number; failed: number; busy: boolean } {
  const tiles = tilesOf(items);
  return {
    total: tiles.length,
    done: tiles.filter((t) => t.o).length,
    failed: items.filter((g) => g.status === "failed" || g.status === "canceled").length,
    busy: items.some((g) => g.status === "queued" || g.status === "running"),
  };
}

/**
 * A grid of results: placeholders while they render, a retry card when one fails, and finished images
 * with Animate / Edit / Delete. With `onPick`, clicking an image selects it (Fashion Factory's "pick 1")
 * and the expand button opens the viewer; otherwise clicking opens the viewer.
 */
export function ResultsGrid({
  items,
  ratio = 3 / 4,
  picked,
  onPick,
  className,
  onRetried,
}: {
  items: Generation[];
  ratio?: number;
  picked?: string;
  onPick?: (url: string) => void;
  className?: string;
  /** A failed photo was retried: `from` is replaced by `to` (runs that track their generation ids). */
  onRetried?: (from: string, to: string[]) => void;
}) {
  const tiles = useMemo(() => tilesOf(items), [items]);
  const done = tiles.filter((t) => t.o);
  const [open, setOpen] = useState<number | null>(null);
  const { trash } = useGenerationActions();
  // An account has no Trash: its delete is for good, so it says so and asks first.
  const account = useIsAccount();
  const retry = useRetryPhoto();
  const viewing = open !== null ? done[open] : undefined;
  return (
    <>
      <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4", className)}>
        {tiles.map((t) => {
          if (!t.o) {
            if (t.g.status === "queued" || t.g.status === "running") return <PendingTile key={t.key} g={t.g} ratio={ratio} />;
            return (
              <RetryTile
                key={t.key}
                g={t.g}
                ratio={ratio}
                busy={retry.isPending && retry.variables === t.g.id}
                onRetry={() =>
                  retry.mutate(t.g.id, {
                    onSuccess: (r) => onRetried?.(t.g.id, r.items.map((x) => x.id)),
                    onError: (e) => toastError(e),
                  })
                }
              />
            );
          }
          const url = t.o.url;
          const sel = picked === url;
          const idx = done.indexOf(t);
          return (
            <div key={t.key} className="group/tile relative overflow-hidden rounded-xl bg-muted animate-fade-up" style={{ aspectRatio: ratio }}>
              <button
                type="button"
                onClick={() => (onPick ? onPick(url) : setOpen(idx))}
                aria-pressed={onPick ? sel : undefined}
                aria-label={onPick ? `Pick ${t.g.request.step?.label ?? "this image"}` : `Open ${t.g.request.step?.label ?? "image"}`}
                className={cn("block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", sel && "ring-3 ring-primary ring-inset")}
              >
                <MediaThumb output={t.o} g={t.g} />
              </button>
              {sel && (
                <span className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-soft">
                  <Check className="size-3.5" />
                </span>
              )}
              <div className="absolute top-2 right-2 flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/tile:opacity-100 sm:group-hover/tile:opacity-100">
                {onPick && <IconLink label="View" icon={Maximize2} onClick={() => setOpen(idx)} />}
                <IconLink href={`/video?image=${encodeURIComponent(url)}`} label="Animate" icon={Film} />
                <IconLink href={`/edit?image=${encodeURIComponent(url)}`} label="Edit" icon={Pencil} />
                <IconLink label={account ? "Delete for good…" : "Move to Trash"} icon={Trash2} onClick={() => (account ? askDeleteForGood([t.g]) : void trash([t.g]))} />
              </div>
              {t.g.request.step && <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-background/85 px-2 py-0.5 text-[11px] font-medium">{t.g.request.step.label}</span>}
            </div>
          );
        })}
      </div>
      {viewing?.o && (
        <Viewer
          generation={viewing.g}
          index={viewing.i ?? 0}
          onClose={() => setOpen(null)}
          onPrev={open! > 0 ? () => setOpen(open! - 1) : undefined}
          onNext={open! < done.length - 1 ? () => setOpen(open! + 1) : undefined}
        />
      )}
    </>
  );
}

/** "Download (8 /10)": a zip of the finished images (the Library's zip endpoint). */
export function DownloadAll({ items, label = "Download" }: { items: Generation[]; label?: string }) {
  const tiles = tilesOf(items);
  const ready = items.filter((g) => g.status === "succeeded");
  const available = tiles.filter((t) => t.o).length;
  const total = tiles.length;
  const href = ready.length ? `/api/generations/zip?ids=${ready.map((g) => g.id).join(",")}` : undefined;
  return (
    <a
      href={href}
      download
      aria-disabled={!href}
      onClick={(e) => {
        // Asks first (src/lib/zip-download.ts): a refusal (a zip still going, too big) is a toast, not a failed download.
        e.preventDefault();
        if (href) void downloadZip(href);
      }}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90",
        !href && "pointer-events-none opacity-50",
      )}
    >
      <Download className="size-3.5" />
      {available === total ? `${label} all` : `${label} (${available}/${total})`}
    </a>
  );
}
