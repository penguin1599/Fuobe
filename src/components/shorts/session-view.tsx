"use client";

import { ArrowLeft, Check, Cloud, Cpu, Download, FolderDown, Layers, Loader2, RotateCcw, Scissors, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { NotFoundState } from "@/components/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaThumb } from "@/components/studio/result-media";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { Viewer } from "@/components/studio/viewer";
import { chainState, ENHANCE_COPY, formatSeconds, segmentSeconds, stitchCurrent, stitchSteps, takeSteps, type ChainState, type ShortsSessionSegment } from "@/lib/catalog/shorts";
import { finishLengthProblem } from "@/lib/catalog/regenerate";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import { originalSoundLabel, originalSoundOn } from "@/lib/av/original-sound";
import { useEngineMode, useIsOwner } from "@/lib/api";
import type { Generation } from "@/lib/catalog/types";
import { formatCost, ratioValue, timeAgo } from "@/lib/format";
import { downloadHref, downloadName } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { onZipLink } from "@/lib/zip-download";
import { useShortsActions, useShortsSession, useSubmitGuard, type ShortsSessionView as View } from "./hooks";
import { Steps } from "./ui";

const STEPS = ["Choose preset", "Upload video", "Download"];

const videoOf = (g?: Generation) => (g?.status === "succeeded" ? g.outputs.find((o) => o.kind === "video") : undefined);

function StateChip({ state }: { state: ChainState }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium",
        state.status === "done" && "bg-success/15 text-success",
        state.status === "working" && "bg-brand-faint text-brand-text",
        (state.status === "failed" || state.status === "gone") && "bg-destructive/10 text-destructive",
      )}
    >
      {state.status === "done" ? <Check className="size-3" /> : state.status === "working" ? <Loader2 className="size-3 animate-spin" /> : null}
      {state.status === "done" ? "Ready" : state.status === "working" ? `${Math.round(state.progress * 100)}%` : state.status === "gone" ? "Deleted" : "Failed"}
    </span>
  );
}

/** Step 3: the session — the full video, the segments with their takes, Regenerate, Stitch again, downloads. */
export function ShortsSessionView({ id }: { id: string }) {
  const q = useShortsSession(id);
  if (q.isLoading)
    return (
      <Frame title="Loading…">
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <Skeleton className="mx-auto aspect-[9/16] w-full max-w-[360px] rounded-2xl" />
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        </div>
      </Frame>
    );
  if (q.error || !q.data)
    return (
      <Frame title="Shorts Studio">
        <NotFoundState title="This short no longer exists">It was deleted, or the link is wrong. Its videos may still be in your Library or the Trash.</NotFoundState>
      </Frame>
    );
  return <Session s={q.data} />;
}

function Frame({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <Link href="/shorts?tab=history" aria-label="Back to your shorts" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="min-w-0 truncate font-heading text-[22px] leading-none">{title}</h1>
        <div className="ml-auto flex items-center gap-1">{actions}</div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full max-w-[1180px] min-w-0 flex-1 px-4 pb-16 sm:px-6">{children}</div>
    </div>
  );
}

function Session({ s }: { s: View }) {
  const router = useRouter();
  const actions = useShortsActions(s.id);
  const engineMode = useEngineMode();
  // The studio's owner keeps a Trash; a signed-in account's short is its own runs (deleted for good, its parts zipped as the owner's are).
  const owner = useIsOwner();
  const [open, setOpen] = useState<Generation | null>(null);
  const [confirm, setConfirm] = useState(false);
  const gens = s.generations;
  const stitch = s.stitches[s.stitches.length - 1];
  const finalState = stitch ? chainState(stitchSteps(stitch, gens)) : null;
  const segStates = s.segments.map((seg) => {
    const take = seg.takes.find((t) => t.look === seg.primary) ?? seg.takes[seg.takes.length - 1];
    return chainState(takeSteps(take, gens));
  });
  const allDone = segStates.every((x) => x.status === "done");
  const outdated = !stitchCurrent(s);
  const final = stitch ? gens[stitch.final] : undefined;
  const finalVideo = videoOf(final);
  const canStitch = allDone && (outdated || finalState?.status === "failed" || finalState?.status === "gone");
  const ratio = ratioValue(s.settings.aspectRatio, 9 / 16);
  const working = segStates.filter((x) => x.status === "working").length;
  const overall = (segStates.reduce((n, x) => n + (x.status === "done" ? 1 : x.progress), 0) + (finalState?.status === "done" ? 1 : (finalState?.progress ?? 0))) / (segStates.length + 1);
  const parts = s.segments.map((g) => g.primary).filter((id) => videoOf(gens[id]));

  // One stitch and one new take per click (the server also answers a repeated request id with the first result).
  const stitchGuard = useSubmitGuard();
  const takeGuard = useSubmitGuard();
  const stitchAgain = () => {
    if (!canStitch || actions.stitch.isPending) return;
    void stitchGuard(`stitch:${s.segments.map((g) => g.primary).join(",")}`, (requestId) => actions.stitch.mutateAsync({ requestId }))
      .then((v) => v && toast("Stitching your short"))
      .catch((e: Error) => toastError(e));
  };
  const enhanceGuard = useSubmitGuard();
  // Enhance needs a 48 GB card: a visitor runs it on its own GPU (own-setup.ts), else gets the step that sets it up.
  const press = useOwnSetupPress();
  const enhance = (i: number) => {
    if (actions.enhance.isPending) return;
    void enhanceGuard(`enhance:${i}:${s.segments[i].primary}`, (requestId) => actions.enhance.mutateAsync({ index: i, requestId }))
      .then((v) => v && toast(`Enhancing segment ${i + 1} at 1080p — pick the new take when it's ready`))
      .catch((e: Error) => toastError(e));
  };
  const regenerate = (i: number) => {
    if (actions.regenerate.isPending) return;
    void takeGuard(`take:${i}:${s.segments[i].takes.length}`, (requestId) => actions.regenerate.mutateAsync({ index: i, requestId }))
      .then((v) => v && toast(`New take of segment ${i + 1} on the way`))
      .catch((e: Error) => toastError(e));
  };

  return (
    <Frame
      title={s.title}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => setConfirm(true)} aria-label="Delete this short" className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-destructive">
              <Trash2 className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete this short</TooltipContent>
        </Tooltip>
      }
    >
      <Steps steps={STEPS} current={finalVideo && !outdated ? 3 : 2} className="pt-6" />
      <div className="mt-6 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
        <section aria-label="Full video" className="min-w-0 space-y-3 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)]">
          <div className="relative mx-auto max-h-[72svh] w-full overflow-hidden rounded-2xl bg-muted" style={{ aspectRatio: ratio, maxWidth: ratio < 1 ? 360 : undefined }}>
            {finalVideo ? (
              <video src={finalVideo.url} controls playsInline preload="metadata" className="size-full bg-black object-contain" aria-label="Your short" />
            ) : finalState?.status === "failed" || finalState?.status === "gone" ? (
              <div className="flex size-full flex-col justify-center gap-2 p-5 text-center">
                <p className="text-[14px] font-medium">{finalState.status === "gone" ? "The full video was deleted" : "Couldn't stitch the full video"}</p>
                {finalState.error && <p className="line-clamp-6 text-[12px] break-words text-muted-foreground">{finalState.error}</p>}
              </div>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center">
                <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
                <p className="shimmer-text relative animate-shimmer-text text-[14px] font-medium">Preparing full video…</p>
                <p className="relative font-mono text-[12px] text-muted-foreground tabular-nums">
                  {working ? `${working} of ${segStates.length} segment${segStates.length === 1 ? "" : "s"} rendering · ` : (finalState?.label ?? "") + " · "}
                  {Math.round(overall * 100)}%
                </p>
                <div className="relative h-1 w-40 overflow-hidden rounded-full bg-background/70">
                  <div className="h-full bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(Math.round(overall * 100)) / 100})` }} />
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2 lg:justify-start">
            {finalVideo && final && (
              <a
                href={downloadHref(finalVideo.url, downloadName(final, finalVideo, 0))}
                download={downloadName(final, finalVideo, 0)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Download className="size-4" /> Download full video
              </a>
            )}
            {parts.length > 0 && (
              <a
                href={`/api/generations/zip?ids=${parts.join(",")}`}
                download
                // Asks first: a refusal (a zip still going, too big) is a toast, never a page of its own.
                onClick={onZipLink}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border bg-background px-4 text-[13px] font-medium hover:bg-accent"
              >
                <FolderDown className="size-4" /> Download parts{parts.length < s.segments.length ? ` (${parts.length})` : ""}
              </a>
            )}
            {(canStitch || (outdated && !allDone)) && (
              <button
                type="button"
                onClick={stitchAgain}
                disabled={actions.stitch.isPending}
                aria-disabled={!canStitch || actions.stitch.isPending}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-[13px] font-medium",
                  canStitch ? "bg-background hover:bg-accent" : "cursor-not-allowed text-muted-foreground",
                )}
                title={canStitch ? undefined : "Ready when every segment has rendered"}
              >
                {actions.stitch.isPending ? <Loader2 className="size-4 animate-spin" /> : <Layers className="size-4" />} Stitch again
              </button>
            )}
          </div>
          {outdated && <p className="text-center text-[12px] text-brand-text lg:text-left">You picked different takes — stitch again to update the full video.</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl bg-muted/50 p-3 text-[12px]">
            <dt className="text-muted-foreground">Preset</dt>
            <dd className="truncate">{s.look.name}</dd>
            {s.source.hasAudio && (
              <>
                <dt className="text-muted-foreground">Sound</dt>
                <dd className="truncate">{originalSoundLabel(originalSoundOn(s.settings.originalSound, s.engine))}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Engine</dt>
            <dd className="flex items-center gap-1">
              {s.engine === "open" ? <Cpu className="size-3" /> : <Cloud className="size-3" />}
              {s.engine === "open" ? "Open source" : "Cloud"}
            </dd>
            <dt className="text-muted-foreground">Selection</dt>
            <dd>
              {formatSeconds(s.range.start)}–{formatSeconds(s.range.end)} ({(s.range.end - s.range.start).toFixed(1)} s)
            </dd>
            <dt className="text-muted-foreground">Output</dt>
            <dd>
              {s.settings.aspectRatio} · {s.settings.language === "auto" ? "Auto language" : s.settings.language}
              {s.source.hasAudio === false ? " · no sound" : ""}
            </dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{timeAgo(s.createdAt)}</dd>
          </dl>
        </section>

        <section aria-labelledby="segments-title" className="min-w-0 space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="segments-title" className="text-[15px] font-semibold">
              {s.segments.length} segment{s.segments.length === 1 ? "" : "s"}
            </h2>
            <span className="text-[12px] text-muted-foreground">Regenerate one, then pick the take you like</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {s.segments.map((seg, i) => (
              <SegmentCard
                key={seg.index}
                seg={seg}
                index={i}
                state={segStates[i]}
                gens={gens}
                ratio={ratio}
                cost={s.regenerateUsd}
                demo={Object.values(gens).some((g) => g.provider === "mock")}
                onOpen={setOpen}
                onRegenerate={() => regenerate(i)}
                regenerating={actions.regenerate.isPending && actions.regenerate.variables?.index === i}
                busy={actions.regenerate.isPending}
                enhanceable={s.engine === "open" && engineMode !== "cloud"}
                onEnhance={() => press("regenerate:enhance", () => enhance(i))}
                enhancing={actions.enhance.isPending && actions.enhance.variables?.index === i}
                onPrimary={(gid) => actions.primary.mutate({ index: i, generationId: gid }, { onError: (e) => toastError(e) })}
              />
            ))}
          </div>
          {/* A cloud short: Enhance (H3 regenerate) needs your GPU, said once rather than on every segment. */}
          {s.engine === "cloud" && engineMode !== "cloud" && <p className="text-[12px] text-muted-foreground">{ENHANCE_COPY.cloudSession}.</p>}
        </section>
      </div>
      {open && <Viewer generation={open} index={0} onClose={() => setOpen(null)} />}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this short?</AlertDialogTitle>
            <AlertDialogDescription>{owner ? "Its segments and videos move to the Trash, where you can restore them for 30 days." : "Its segments and videos are deleted for good."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                actions.remove.mutate(s.id, {
                  onSuccess: () => {
                    toast(owner ? "Moved to Trash" : "Deleted");
                    router.push("/shorts?tab=history");
                  },
                  onError: (e) => toastError(e),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Frame>
  );
}

function SegmentCard({
  seg,
  index,
  state,
  gens,
  ratio,
  cost,
  demo,
  onOpen,
  onRegenerate,
  regenerating,
  busy,
  onPrimary,
  enhanceable,
  onEnhance,
  enhancing,
}: {
  seg: ShortsSessionSegment;
  index: number;
  state: ChainState;
  gens: Record<string, Generation>;
  ratio: number;
  cost: number | null;
  demo: boolean;
  onOpen: (g: Generation) => void;
  onRegenerate: () => void;
  regenerating: boolean;
  /** A new take (of any segment) is on its way. */
  busy: boolean;
  onPrimary: (id: string) => void;
  /** Enhance (H3 regenerate): on an open-source short (Paid APIs only hides it). */
  enhanceable: boolean;
  onEnhance: () => void;
  enhancing: boolean;
}) {
  const primary = gens[seg.primary];
  const chosenTake = seg.takes.find((t) => t.look === seg.primary);
  const tooLong = finishLengthProblem(segmentSeconds(seg));
  const video = videoOf(primary);
  const price = demo ? "Placeholder · free" : cost === null ? "" : cost === 0 ? "Free" : `≈ ${formatCost(cost)}`;
  return (
    <article className="min-w-0 rounded-2xl border bg-background p-3 sm:p-4" aria-label={`Segment ${index + 1}`}>
      <div className="flex items-center gap-2">
        <Scissors className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="text-[14px] font-medium">Segment {index + 1}</h3>
        <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
          {formatSeconds(seg.start)}–{formatSeconds(seg.end)}
        </span>
        <span className="ml-auto">
          <StateChip state={state} />
        </span>
      </div>
      <div className="mt-3 min-w-0 space-y-3">
        <div className="relative mx-auto h-44 max-w-full overflow-hidden rounded-xl bg-muted sm:h-52" style={{ aspectRatio: ratio }}>
          {video && primary ? (
            <button type="button" onClick={() => onOpen(primary)} aria-label={`Open segment ${index + 1}`} className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <MediaThumb output={video} />
            </button>
          ) : state.status === "working" ? (
            <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
          ) : (
            <div className="grid size-full place-items-center p-2 text-center text-[11px] text-muted-foreground">{state.status === "gone" ? "Deleted" : "No video"}</div>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          {state.status === "working" && (
            <p className="shimmer-text animate-shimmer-text text-[13px] font-medium" aria-live="polite">
              {state.label}…
            </p>
          )}
          {(state.status === "failed" || state.status === "gone") && (
            <div className="space-y-0.5">
              <p className="text-[13px] font-medium">{state.label}</p>
              {state.error && <p className="line-clamp-3 text-[12px] break-words text-muted-foreground">{state.error}</p>}
            </div>
          )}
          {state.status === "done" && (
            <p className="text-[13px] text-muted-foreground">
              Take {seg.takes.findIndex((t) => t.look === seg.primary) + 1}
              {chosenTake?.enhance ? " (enhanced, 1080p)" : ""} is in the full video.
            </p>
          )}
          {seg.takes.length > 1 && (
            // Arrow keys move between the takes and pick them (radio pattern); the chosen take is the Tab stop.
            // Only takes that can't be picked (still rendering, failed) are turned off, with the reason in their name.
            <div role="radiogroup" aria-label={`Takes of segment ${index + 1}`} onKeyDown={radioKeys} className="flex flex-wrap gap-1.5">
              {seg.takes.map((t, ti) => {
                const g = gens[t.look];
                const v = videoOf(g);
                const st = chainState(takeSteps(t, gens));
                const chosen = seg.primary === t.look;
                const why = st.status === "done" ? "" : st.status === "working" ? "still rendering" : st.status === "gone" ? "deleted" : "failed";
                return (
                  <button
                    key={t.look}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    aria-label={`Take ${ti + 1}${t.enhance ? ", enhanced" : ""}${why ? ` (${why})` : chosen ? " (in the full video)" : ""}`}
                    tabIndex={radioTab(chosen)}
                    disabled={st.status !== "done" && !chosen}
                    onClick={() => !chosen && st.status === "done" && onPrimary(t.look)}
                    title={st.status === "done" ? (chosen ? "In the full video" : "Use this take") : st.status === "working" ? "Still rendering" : st.error}
                    className={cn(
                      "relative size-12 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      chosen ? "ring-2 ring-primary" : st.status === "done" && "hover:ring-2 hover:ring-border-strong",
                    )}
                  >
                    {v ? <MediaThumb output={v} /> : st.status === "working" ? <Loader2 className="mx-auto size-3.5 animate-spin text-muted-foreground" /> : null}
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/55 px-1 text-[10px] font-semibold text-white">{ti + 1}</span>
                    {t.enhance && <span className="absolute top-0.5 right-0.5 rounded bg-black/55 px-1 text-[9px] font-semibold text-white">HD</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-[12px] font-medium hover:bg-accent disabled:opacity-60"
            >
              {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              Regenerate
              {price && <span className="font-mono text-[11px] font-normal text-muted-foreground">{price}</span>}
            </button>
            {enhanceable && !chosenTake?.enhance && !tooLong && (
              <button
                type="button"
                onClick={onEnhance}
                disabled={state.status !== "done" || enhancing}
                title={state.status !== "done" ? ENHANCE_COPY.notReady : `${ENHANCE_COPY.hint} · ${ENHANCE_COPY.gpu}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-[12px] font-medium hover:bg-accent disabled:opacity-60"
              >
                {enhancing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {ENHANCE_COPY.label}
                <OwnSetupChip setup="regenerate:enhance" />
                <span className="font-mono text-[11px] font-normal text-muted-foreground">1080p · Free</span>
              </button>
            )}
            {video && primary && (
              <a
                href={downloadHref(video.url, downloadName(primary, video, 0))}
                download={downloadName(primary, video, 0)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Download className="size-3.5" /> Part {index + 1}
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
