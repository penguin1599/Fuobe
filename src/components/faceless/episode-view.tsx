"use client";

import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  Clapperboard,
  Download,
  Film,
  Heart,
  History,
  ListChecks,
  Loader2,
  MonitorUp,
  MoreHorizontal,
  Music,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import { NotFoundState } from "@/components/empty-state";
import { MediaThumb } from "@/components/studio/feed";
import { Viewer } from "@/components/studio/viewer";
import {
  CAMERA_WORDS,
  formatLength,
  getStyle,
  PART_LABELS,
  tooLong,
  type ChangePart,
  type EpisodeView as View,
  type StepView,
} from "@/lib/catalog/faceless";
import type { Generation } from "@/lib/catalog/types";
import { useEngineMode } from "@/lib/api";
import { FACELESS_REGEN_COPY } from "@/lib/catalog/faceless";
import { timeAgo } from "@/lib/format";
import { downloadHref, downloadName } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { Segmented, usd } from "./controls";
import { useApplyChange, useChangePreview, useDeleteEpisode, useEpisode, useEpisodeAction, useUpdateEpisode, type ChangeDraft } from "./hooks";
import { ScriptReview } from "./script-review";

const done = (g: Generation | null | undefined) => g?.status === "succeeded";
const broken = (g: Generation | null | undefined) => g?.status === "failed" || g?.status === "canceled";
const active = (g: Generation | null | undefined) => g?.status === "queued" || g?.status === "running";

function StatusDot({ g, className }: { g: Generation | null | undefined; className?: string }) {
  if (done(g)) return <Check className={cn("size-3 text-success", className)} aria-label="Done" />;
  if (broken(g)) return <AlertTriangle className={cn("size-3 text-destructive", className)} aria-label="Failed" />;
  if (g?.status === "running") return <Loader2 className={cn("size-3 animate-spin text-brand-text", className)} aria-label="Running" />;
  return <span className={cn("size-2 rounded-full bg-border-strong", className)} aria-label="Waiting" />;
}

/** The finished film, the last one while a change renders, or the progress of the first render. */
function Player({ view, onRetry, retrying }: { view: View; onRetry: () => void; retrying: boolean }) {
  const ep = view.episode;
  const film = view.final ?? view.previousFinal;
  const out = film?.outputs.find((o) => o.kind === "video");
  const vertical = ep.settings.aspect === "9:16";
  const stepsDone = view.steps.filter((s) => done(s.generation)).length;
  return (
    <div className={cn("relative mx-auto overflow-hidden rounded-2xl bg-media", vertical ? "aspect-[9/16] max-h-[72vh] max-w-[420px]" : "aspect-video w-full")}>
      {out ? (
        <video key={out.url} src={out.url} controls playsInline preload="metadata" className="size-full bg-black object-contain" aria-label={`${ep.title} — the episode`} />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-muted p-6">
          <div className="skeleton-sweep absolute inset-0 animate-skeleton" />
          <div className="relative max-w-sm text-center">
            {ep.status === "failed" ? (
              <>
                <AlertTriangle className="mx-auto size-6 text-destructive" />
                <p className="mt-3 font-heading text-[22px]">A step didn&apos;t finish</p>
                <p className="mt-1 line-clamp-4 text-[13px] text-muted-foreground">{ep.error}</p>
                <Button className="mt-4" onClick={onRetry} disabled={retrying}>
                  {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry what failed
                </Button>
              </>
            ) : (
              <>
                <p className="shimmer-text animate-shimmer-text font-heading text-[24px]">Generating your episode</p>
                <p className="mt-1 text-[13px] text-muted-foreground">This can take a while for longer videos. You can close this page — it will keep running.</p>
                <div className="mx-auto mt-4 h-1.5 w-56 overflow-hidden rounded-full bg-background/70" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)} aria-label="Episode progress">
                  <div className="h-full rounded-full bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(Math.max(3, Math.round(view.progress * 100))) / 100})` }} />
                </div>
                <p className="mt-2 font-mono text-[12px] text-muted-foreground tabular-nums">
                  {stepsDone} of {view.steps.length} steps · {Math.round(view.progress * 100)}%
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {!view.final && view.previousFinal && ep.status === "rendering" && (
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-medium text-white backdrop-blur">
          <Loader2 className="size-3 animate-spin" /> Updating · {Math.round(view.progress * 100)}%
        </span>
      )}
    </div>
  );
}

interface SceneRow {
  id: string;
  index: number;
  narration: string;
  seconds: number;
  start: number;
  still: StepView | undefined;
  clips: StepView[];
}

/** A scene in the timeline: its picture, how far it got, its length. */
function SceneTile({ scene, selected, onSelect, aspect }: { scene: SceneRow; selected: boolean; onSelect: (e: React.MouseEvent) => void; aspect: string }) {
  const still = scene.still?.generation;
  const img = still?.outputs.find((o) => o.kind === "image");
  const clipsDone = scene.clips.filter((c) => done(c.generation)).length;
  const failed = [scene.still, ...scene.clips].some((s) => broken(s?.generation));
  const running = [scene.still, ...scene.clips].some((s) => active(s?.generation));
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Scene ${scene.index + 1}, ${formatLength(scene.start)}, ${failed ? "failed" : running ? "rendering" : clipsDone === scene.clips.length ? "done" : "waiting"}`}
      onClick={onSelect}
      className={cn(
        "group/scene relative w-[132px] shrink-0 overflow-hidden rounded-xl border-2 bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-[156px]",
        selected ? "border-primary" : "border-transparent hover:border-border-strong",
      )}
    >
      <div className={cn("relative w-full", aspect === "9:16" ? "aspect-[3/4]" : "aspect-video")}>
        {img ? <MediaThumb output={img} /> : <div className={cn("absolute inset-0", running && "skeleton-sweep animate-skeleton")} />}
        {failed && <div className="absolute inset-0 grid place-items-center bg-destructive/15"><AlertTriangle className="size-5 text-destructive" /></div>}
        <span className="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-background/90 font-mono text-[10px] font-semibold shadow-soft">{scene.index + 1}</span>
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/55 px-1 font-mono text-[10px] text-white tabular-nums">{scene.seconds}s</span>
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <StatusDot g={still} />
        {scene.clips.map((c) => (
          <StatusDot key={c.key} g={c.generation} />
        ))}
        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground tabular-nums">{formatLength(scene.start)}</span>
      </div>
    </button>
  );
}

const TAIL_ICON = { join: Film, narration: AudioLines, music: Music, mix: Clapperboard, words: Captions, captions: Captions } as const;

/** The steps after the scenes: joining, the voice-over, music, the mix and subtitles. */
function TailSteps({ steps, onOpen }: { steps: StepView[]; onOpen: (g: Generation) => void }) {
  const tail = steps.filter((s) => s.part !== "still" && s.part !== "clip");
  const groups = new Map<string, StepView[]>();
  for (const s of tail) groups.set(s.part, [...(groups.get(s.part) ?? []), s]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...groups.entries()].map(([part, list]) => {
        const Icon = TAIL_ICON[part as keyof typeof TAIL_ICON] ?? Film;
        const last = list[list.length - 1];
        const g = last.generation;
        const all = list.filter((s) => done(s.generation)).length;
        // A bed split from a clip's soundtrack plays its music and effects (the background stem), not the talking.
        const sounds = part === "narration" || part === "music" ? (g?.outputs ?? []).filter((o) => o.kind === "audio") : [];
        const audio = sounds.find((o) => o.meta?.stem === "background") ?? sounds[0];
        return (
          <button
            key={part}
            type="button"
            disabled={!done(g)}
            onClick={() => g && onOpen(g)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[12px] font-medium transition-colors enabled:hover:bg-accent disabled:cursor-default"
            title={g?.error ?? undefined}
          >
            <Icon className="size-3.5 text-muted-foreground" />
            {PART_LABELS[part as keyof typeof PART_LABELS]}
            {list.length > 1 && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{all}/{list.length}</span>}
            <StatusDot g={g} />
            {audio && <span className="sr-only">Opens the audio</span>}
          </button>
        );
      })}
    </div>
  );
}

/** "picture, clip, joining the scenes, voice-over, subtitles" from the steps a change re-runs. */
const stepWords = (labels: string[]) =>
  [...new Set(labels.map((l) => l.replace(/^Scene \d+ · /, "").replace(/^Joining scenes.*$/, "Joining the scenes").replace(/ \d+ of \d+$/, "")))]
    .map((l) => l.charAt(0).toLowerCase() + l.slice(1))
    .join(", ");

const PART_OPTIONS: { value: ChangePart; label: string }[] = [
  { value: "picture", label: "Picture" },
  { value: "motion", label: "Motion" },
  { value: "narration", label: "Narration" },
];

/** Change the selected scenes: describe the change, see what re-runs and the price, apply or discard. */
function SceneEditor({ view, scenes, onClose, onOpen }: { view: View; scenes: SceneRow[]; onClose: () => void; onOpen: (g: Generation) => void }) {
  const ep = view.episode;
  const [part, setPart] = useState<ChangePart>("picture");
  const [instruction, setInstruction] = useState("");
  const [lines, setLines] = useState<string[]>(() => scenes.map((s) => s.narration));
  const apply = useApplyChange(ep.id);
  const retry = useEpisodeAction(ep.id);
  const ids = scenes.map((s) => s.id);
  const failedStep = scenes.flatMap((s) => [s.still, ...s.clips]).find((x) => broken(x?.generation));
  const draft: ChangeDraft | null =
    part === "narration"
      ? lines.some((l, i) => l.trim() && l.trim() !== scenes[i].narration)
        ? { blocks: ids, part, narration: lines }
        : null
      : instruction.trim()
        ? { blocks: ids, part, instruction: instruction.trim() }
        : null;
  const preview = useChangePreview(ep.id, draft);
  const busy = ep.status === "rendering";
  const one = scenes.length === 1 ? scenes[0] : null;
  const still = one?.still?.generation;
  const stillImg = still?.outputs.find((o) => o.kind === "image");
  // Frame by frame moves a camera over the picture (Ken Burns): its Motion reads camera words only.
  const camera = ep.settings.animation === "frames" ? CAMERA_WORDS[ep.settings.engine] : null;

  const discard = () => {
    setInstruction("");
    setLines(scenes.map((s) => s.narration));
  };
  const go = () => {
    if (!draft) return void toast(part === "narration" ? "Change the lines first" : "Describe the change first", { id: "faceless-blocker" });
    apply.mutate(draft, {
      onSuccess: () => {
        toast.success(`Re-rendering ${scenes.length > 1 ? `${scenes.length} scenes` : `scene ${scenes[0].index + 1}`}`);
        discard();
      },
      onError: (e) => toastError(e),
    });
  };

  return (
    <section aria-label="Change scenes" className="animate-fade-up rounded-2xl border bg-background p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-medium">{one ? `Scene ${one.index + 1}` : `${scenes.length} scenes`}</h3>
        <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{one ? `${formatLength(one.start)} – ${formatLength(one.start + one.seconds)}` : scenes.map((s) => s.index + 1).join(", ")}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="Close the scene editor">
          <X />
        </Button>
      </div>
      {one && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!done(still)} onClick={() => still && onOpen(still)} className="relative aspect-video overflow-hidden rounded-lg bg-muted" aria-label="Open the picture">
              {stillImg && <MediaThumb output={stillImg} />}
              <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 text-[10px] text-white">Picture</span>
            </button>
            {one.clips.slice(0, 1).map((c) => {
              const v = c.generation?.outputs.find((o) => o.kind === "video");
              return (
                <button key={c.key} type="button" disabled={!done(c.generation)} onClick={() => c.generation && onOpen(c.generation)} className="relative aspect-video overflow-hidden rounded-lg bg-muted" aria-label="Open the clip">
                  {v && <MediaThumb output={v} />}
                  <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 text-[10px] text-white">Clip{one.clips.length > 1 ? ` · ${one.clips.length}` : ""}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">“{one.narration}”</p>
        </div>
      )}
      {failedStep && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px]">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {failedStep.label} didn&apos;t finish{failedStep.generation?.error ? `: ${failedStep.generation.error}` : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending || busy}
            onClick={() => retry.mutate("retry", { onSuccess: () => toast.success("Retrying what failed"), onError: (e) => toastError(e) })}
          >
            <RotateCcw /> Retry
          </Button>
        </div>
      )}
      <div className="mt-4 space-y-3">
        <Segmented label="What to change" value={part} options={PART_OPTIONS} onChange={setPart} />
        {part === "narration" ? (
          <div className="space-y-2">
            {scenes.map((s, i) => (
              <label key={s.id} className="block space-y-1">
                <span className="text-[12px] text-muted-foreground">Scene {s.index + 1}</span>
                <textarea
                  value={lines[i]}
                  maxLength={2000}
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? e.target.value : l)))}
                  rows={2}
                  className="w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-[14px] outline-none [field-sizing:content] focus:border-primary"
                />
                {tooLong(lines[i]) && <span className="text-[12px] text-warning">Longer than the scene: the voice runs over into the next one.</span>}
              </label>
            ))}
            <p className="text-[12px] text-muted-foreground">The whole voice-over is read again, so it stays one natural take; then the scenes are cut to the new lines, and a scene that moves by more than a second is animated again.</p>
          </div>
        ) : (
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={1000}
            rows={2}
            aria-label={part === "picture" ? "Describe what to change in the picture" : camera ? "Describe the new camera move" : "Describe the new movement"}
            placeholder={part === "picture" ? "e.g. make it night, add a lighthouse on the cliff" : (camera?.placeholder ?? "e.g. slow zoom out, the flags wave in the wind")}
            className="w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-[14px] outline-none [field-sizing:content] focus:border-primary placeholder:text-subtle-foreground"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground" aria-live="polite">
            {busy
              ? "Wait for the current render to finish to change scenes."
              : !draft
                ? part === "picture"
                  ? "The picture is edited, then the scene is animated again."
                  : part === "motion"
                    ? (camera?.hint ?? "The picture is kept; the scene is animated again.")
                    : "Edit the lines above."
                : preview.isError
                  ? (preview.error as Error).message
                  : preview.data
                    ? `Re-renders ${preview.data.labels.length} step${preview.data.labels.length === 1 ? "" : "s"} (${stepWords(preview.data.labels)})${preview.data.retime ? ", plus any scene whose timing moves" : ""} · ${preview.data.demo ? "Placeholder · free" : ep.settings.engine === "open" ? "Free · your GPU" : preview.data.costUsd === null ? "price unknown" : `≈ ${usd(preview.data.costUsd)}${preview.data.retime ? "+" : ""}`}`
                    : "Pricing…"}
          </p>
          <Button variant="ghost" onClick={discard} disabled={!draft}>
            Discard
          </Button>
          <Button onClick={go} disabled={!draft || busy || apply.isPending || preview.isError} className="rounded-full">
            {apply.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />} Apply
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Applying re-renders this change and publishes it when it&apos;s done; Undo brings the version before back. What it already spent isn&apos;t refunded.</p>
      </div>
    </section>
  );
}

function Timeline({ view, onOpen }: { view: View; onOpen: (g: Generation) => void }) {
  const ep = view.episode;
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  // Touch screens have no Shift or ⌘: "Select several" makes a tap add or remove a scene.
  const [several, setSeveral] = useState(false);
  const scenes = useMemo<SceneRow[]>(() => {
    // Where each scene sits in the film (cut to the narration once it's timed), from the server.
    const times = new Map(view.scenes.map((s) => [s.id, s]));
    return ep.script.blocks.map((b, i) => ({
      id: b.id,
      index: i,
      narration: b.narration,
      seconds: times.get(b.id)?.seconds ?? b.seconds,
      start: times.get(b.id)?.start ?? 0,
      still: view.steps.find((s) => s.key === `still-${b.id}`),
      clips: view.steps.filter((s) => s.part === "clip" && s.key.startsWith(`clip-${b.id}-`)),
    }));
  }, [ep.script.blocks, view.steps, view.scenes]);
  const pick = (i: number, e: React.MouseEvent) => {
    const id = scenes[i].id;
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSelected(scenes.slice(a, b + 1).map((s) => s.id).slice(0, 12));
      return;
    }
    if (several || e.metaKey || e.ctrlKey) {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(0, 12)));
      setAnchor(i);
      return;
    }
    setSelected((s) => (s.length === 1 && s[0] === id ? [] : [id]));
    setAnchor(i);
  };
  const chosen = scenes.filter((s) => selected.includes(s.id));
  return (
    <section aria-labelledby="timeline-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline-title" className="font-heading text-[22px]">
          Timeline
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-[12px] text-muted-foreground">
            {view.timing === "narration" ? "Each scene is cut to its lines · " : ""}Pick a scene to change it<span className="pointer-coarse:hidden"> · Shift for a run, ⌘/Ctrl for several</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={several}
            onClick={() => {
              setSeveral((v) => !v);
              if (several) setSelected((s) => s.slice(0, 1));
            }}
            className={cn("h-7 rounded-full px-2.5 text-[12px]", several && "bg-brand-faint text-brand-text hover:bg-brand-faint-hover")}
          >
            <ListChecks /> Select several
          </Button>
        </div>
      </div>
      <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-0 sm:px-0" role="group" aria-label="Scenes">
        {scenes.map((s) => (
          <SceneTile key={s.id} scene={s} selected={selected.includes(s.id)} onSelect={(e) => pick(s.index, e)} aspect={ep.settings.aspect} />
        ))}
      </div>
      <TailSteps steps={view.steps} onOpen={onOpen} />
      {chosen.length > 0 && <SceneEditor key={chosen.map((s) => s.id).join("|")} view={view} scenes={chosen} onClose={() => setSelected([])} onOpen={onOpen} />}
    </section>
  );
}

function Changes({ view }: { view: View }) {
  const changes = view.episode.plan?.changes ?? [];
  if (!changes.length) return null;
  const blocks = view.episode.script.blocks;
  return (
    <details className="group/changes rounded-2xl border px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium">
        <History className="size-4 text-muted-foreground" /> {changes.length} change{changes.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {[...changes].reverse().map((c) => (
          <li key={c.at} className={cn("flex flex-wrap items-baseline gap-x-2 text-[12px]", c.undone && "text-muted-foreground")}>
            <span className={cn("font-medium", c.undone && "line-through")}>
              Scene {c.blocks.map((b) => blocks.findIndex((x) => x.id === b) + 1 || "?").join(", ")} · {c.part}
            </span>
            <span className={cn("min-w-0 truncate text-muted-foreground", c.undone && "line-through")}>{c.instruction}</span>
            {c.undone && <span className="text-[11px] font-medium">Undone</span>}
            <span className="ml-auto font-mono text-muted-foreground tabular-nums">
              {c.costUsd != null ? `≈ ${usd(c.costUsd)} · ` : ""}
              {timeAgo(c.at)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One episode (Faceless or Explainer): writing → review → render, then the film and its timeline editor. */
export function EpisodeView({ id, backHref, backLabel }: { id: string; backHref: string; backLabel: string }) {
  const router = useRouter();
  const { data: view, error, isLoading } = useEpisode(id);
  const action = useEpisodeAction(id);
  const engineMode = useEngineMode();
  const update = useUpdateEpisode(id);
  const del = useDeleteEpisode();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState<Generation | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Regenerate to 1080p needs a 48 GB card (own-setup.ts): a visitor runs it on its own GPU, else gets the step that sets it up.
  const press = useOwnSetupPress();

  if (error && /not found/i.test((error as Error).message)) return <NotFoundState title="This episode doesn't exist">It may have been deleted. Its videos are still in your library.</NotFoundState>;
  const ep = view?.episode;
  // The download is the 1080p copy once it's made (the newer of the upscaled and the regenerated film), else the film.
  const upscaled = view?.upscaled?.status === "succeeded" ? view.upscaled : null;
  const upscaling = !!view?.upscaled && active(view.upscaled);
  const regenerated = view?.regenerated?.status === "succeeded" ? view.regenerated : null;
  const regenerating = view?.regenerating ?? null;
  // Regenerate runs on your GPU only: Engine mode "Paid APIs only" hides it.
  const regenOffer = engineMode !== "cloud" ? view?.regenerate : null;
  const sharp = [upscaled, regenerated].filter((g): g is Generation => !!g).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const film = sharp ?? view?.final;
  const filmOut = film?.outputs.find((o) => o.kind === "video");
  const run = (a: "retry" | "rewrite" | "undo" | "upscale" | "regenerate", ok?: string) => action.mutate(a, { onSuccess: () => ok && toast.success(ok), onError: (e) => toastError(e) });

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <Link href={backHref} className="inline-flex min-w-0 shrink items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4 shrink-0" />
          <span className="truncate">{view?.channel?.name ?? backLabel}</span>
        </Link>
        {ep && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {upscaling && (
              <span className="hidden items-center gap-1.5 text-[12px] text-muted-foreground sm:inline-flex" aria-live="polite">
                <Loader2 className="size-3 animate-spin" /> Upscaling to 1080p
              </span>
            )}
            {regenerating && (
              <span className="hidden items-center gap-1.5 text-[12px] text-muted-foreground sm:inline-flex" aria-live="polite">
                <Loader2 className="size-3 animate-spin" /> Regenerating · {regenerating.done} of {regenerating.of} steps
              </span>
            )}
            {filmOut && film && (
              <Button asChild variant="outline" size="sm">
                <a href={downloadHref(filmOut.url, downloadName(film, filmOut, 0))} download aria-label={sharp ? "Download (1080p)" : "Download"}>
                  <Download /> <span className="hidden sm:inline">{sharp ? "Download 1080p" : "Download"}</span>
                </a>
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-pressed={ep.favorite} aria-label={ep.favorite ? "Unlike" : "Like"} onClick={() => update.mutate({ favorite: !ep.favorite })}>
              <Heart className={cn(ep.favorite && "fill-highlight text-highlight")} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Episode actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem
                  onClick={() => {
                    setTitle(ep.title);
                    setRenaming(true);
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                {ep.plan?.previous && ep.status !== "rendering" && (
                  <DropdownMenuItem onClick={() => run("undo", "Back to the version before")}>
                    <Undo2 /> Undo the last change
                  </DropdownMenuItem>
                )}
                {view?.upscale && !upscaled && (
                  <DropdownMenuItem disabled={upscaling || action.isPending} onClick={() => run("upscale", "Upscaling to 1080p — the download switches to it when it's done")}>
                    <MonitorUp /> {upscaling ? "Upscaling to 1080p…" : "Upscale to 1080p"}
                    <span className="ml-auto pl-3 font-mono text-[11px] text-muted-foreground tabular-nums">
                      {view.upscale.demo ? "Placeholder" : view.upscale.costUsd === null ? "" : view.upscale.costUsd === 0 ? "Free" : `≈ ${usd(view.upscale.costUsd)}`}
                    </span>
                  </DropdownMenuItem>
                )}
                {regenOffer && !regenerated && (
                  <DropdownMenuItem
                    disabled={!!regenerating || action.isPending}
                    onClick={() => press("regenerate:faceless", () => run("regenerate", "Regenerating each scene at 1080p — the download switches to it when it's done"))}
                    className="items-start"
                  >
                    <Sparkles className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-baseline gap-3">
                        <span>{regenerating ? `Regenerating… ${regenerating.done} of ${regenerating.of}` : FACELESS_REGEN_COPY.label}</span>
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">Free</span>
                      </span>
                      <span className="text-[11.5px] leading-snug text-muted-foreground">Sharper, may redraw · {FACELESS_REGEN_COPY.time(regenOffer.scenes)}</span>
                      <OwnSetupChip setup="regenerate:faceless" className="mt-0.5" />
                    </span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => setTimeout(() => setConfirm(true))}>
                  <Trash2 /> Delete episode
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full max-w-[1100px] min-w-0 flex-1 space-y-6 px-4 pb-16 sm:px-6">
        {isLoading || !view || !ep ? (
          <div className="space-y-4 pt-6">
            <Skeleton className="h-8 w-96 max-w-full" />
            <Skeleton className="aspect-video w-full rounded-2xl" />
          </div>
        ) : (
          <>
            <div className="pt-5">
              {renaming ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    update.mutate({ title });
                    setRenaming(false);
                  }}
                >
                  <input
                    autoFocus
                    value={title}
                    maxLength={120}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                    aria-label="Episode title"
                    className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 font-heading text-[26px] outline-none focus:border-primary"
                  />
                  <Button type="submit" size="icon" aria-label="Save the title">
                    <Check />
                  </Button>
                </form>
              ) : (
                <h1 className="font-heading text-[30px] leading-tight text-balance">{ep.title}</h1>
              )}
              <p className="mt-1 text-[13px] text-muted-foreground">
                {ep.settings.styleRefs.length ? "Your own style" : getStyle(ep.settings.styleId).name} · {ep.settings.aspect === "9:16" ? "Vertical" : "Horizontal"} ·{" "}
                {ep.settings.animation === "frames" ? "Frame by frame" : "Fully animated"}
                {ep.script.blocks.length > 0 && ` · ${formatLength(view.scenes.length ? view.scenes.reduce((n, s) => n + s.seconds, 0) : ep.script.blocks.reduce((n, b) => n + b.seconds, 0))}`}
                {view.spentUsd > 0 && <span className="font-mono"> · ≈ {usd(view.spentUsd)} spent</span>}
              </p>
            </div>

            {ep.status === "writing" ? (
              <div className="grid min-h-[40vh] place-items-center rounded-2xl border border-dashed p-8 text-center">
                <div>
                  <Loader2 className="mx-auto size-6 animate-spin text-brand-text" />
                  <p className="shimmer-text animate-shimmer-text mt-3 font-heading text-[24px]">{ep.script.source === "pasted" ? "Splitting your script into scenes…" : "Writing your script…"}</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">A few seconds with Claude, up to a minute with a local model.</p>
                </div>
              </div>
            ) : ep.status === "write-failed" ? (
              <div className="grid min-h-[30vh] place-items-center rounded-2xl border border-dashed p-8 text-center">
                <div className="max-w-md">
                  <AlertTriangle className="mx-auto size-6 text-destructive" />
                  <p className="mt-3 font-heading text-[24px]">Couldn&apos;t write the script</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">{ep.error}</p>
                  <Button className="mt-4" onClick={() => run("rewrite")} disabled={action.isPending}>
                    <RotateCcw /> Try again
                  </Button>
                </div>
              </div>
            ) : ep.status === "review" ? (
              <ScriptReview view={view} />
            ) : (
              <>
                <Player view={view} onRetry={() => run("retry", "Retrying what failed")} retrying={action.isPending} />
                {ep.status === "failed" && film === null && view.previousFinal && (
                  <p role="alert" className="flex items-center gap-2 text-[13px] text-destructive">
                    <AlertTriangle className="size-4" /> {ep.error}
                    <Button size="sm" variant="outline" onClick={() => run("retry", "Retrying what failed")}>
                      <RotateCcw /> Retry
                    </Button>
                  </p>
                )}
                <Timeline view={view} onOpen={setOpen} />
                <Changes view={view} />
              </>
            )}
          </>
        )}
      </div>
      {open && <Viewer generation={open} index={0} onClose={() => setOpen(null)} />}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this episode?</AlertDialogTitle>
            <AlertDialogDescription>
              It&apos;s removed from {view?.channel ? "the channel" : "your explainers"}{ep?.status === "rendering" ? ", and what's still rendering stops" : ""}. Its finished pictures, clips and video stay in your Library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                del.mutate(id, {
                  onSuccess: () => {
                    toast("Episode deleted");
                    router.push(backHref);
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
    </div>
  );
}
