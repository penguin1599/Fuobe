"use client";

import {
  Cpu,
  Download,
  FileVideo,
  Library,
  Loader2,
  MicOff,
  Upload,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Feed } from "@/components/studio/feed";
import {
  ACCEPT,
  fileToSlot,
  kindOfFile,
  LibraryGrid,
} from "@/components/studio/media-slot";
import { Segmented } from "@/components/faceless/controls";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import { useAskBeforeUpload, useEngine, useGenerations } from "@/lib/api";
import {
  CLOUD_ONLY_REMOVE_PROBLEM,
  CLOUD_REMOVE_PROBLEM,
  LOWER_DEFAULT_DB,
  LOWER_MAX_DB,
  LOWER_MIN_DB,
  OUTCOMES,
  REMOVE_DIALOGUE_FEATURE,
  REMOVED_STEM,
  requestedOutcome,
  type DialogueOutcome,
} from "@/lib/av/remove-dialogue";
import {
  clock,
  durationWords,
  openToolPrice,
  QUALITY_LABELS,
  stemLabel,
  type SplitQuality,
  type StemId,
} from "@/lib/av/split";
import type { Engine, Generation } from "@/lib/catalog/types";
import { downloadHref } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import {
  useAudioToolPreview,
  useAudioToolRun,
  useSettled,
  type AudioToolBody,
} from "./hooks";

/**
 * Video tools → Remove dialogue (DBS D2). Drop or pick a video; choose No dialogue (music and effects), Dialogue only or
 * Lower the music (−30…0 dB); DBS splits the soundtrack on your ComfyUI and the stream-copy mux puts the new sound on
 * the picture without re-encoding it. Before / after players, and the stem taken out as a download. There's no hosted
 * DBS (and no other model stands in for it), so the cloud engine says the tool runs on your GPU.
 */

type Source = {
  ref: string;
  preview: string;
  id: string;
  name?: string;
  uploading?: boolean;
  duration?: number;
};

const baseName = (s: { name?: string }) =>
  (s.name ?? "Video").replace(/\.[a-z0-9]{2,4}$/i, "");

const RUN_LABEL: Record<DialogueOutcome, string> = {
  "no-dialogue": "Remove dialogue",
  "dialogue-only": "Keep the dialogue",
  "lower-music": "Lower the music",
};

const COPY =
  "Takes the talking out and keeps the music and sound effects. The picture stays exactly as it was.";

/** ?video= from a result's "Remove dialogue", read once after hydration. */
function useHandoff(take: (s: Source) => void) {
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("video");
    if (url?.startsWith("/api/files/"))
      take({
        ref: url,
        preview: url,
        id: nanoid(8),
        name: decodeURIComponent(url.split("/").pop() ?? ""),
      });
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function AddVideo({
  onPick,
  onUpdate,
  disabled,
}: {
  onPick: (s: Source) => void;
  onUpdate: (next: (cur: Source | null) => Source | null) => void;
  /** Nothing is uploaded or picked. A guest is asked to sign up first, and an account with nothing to run on to connect its GPU. */
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  // A guest, or an account with neither its own GPU nor its own key, gets its card instead of the file chooser.
  const askFirst = useAskBeforeUpload();
  const take = (f: File | undefined) => {
    if (!f || disabled || askFirst()) return;
    if (kindOfFile(f) !== "video")
      return void toast("Video only — drop a clip here (MP4, MOV or WebM)");
    // Shown at once with its local preview, then given its address, or taken away when the upload is refused or fails
    // (the answer counts only while it's still this upload).
    const id = nanoid(8);
    void fileToSlot(
      f,
      (v) => {
        const s: Source | null = v && {
          ref: v.ref,
          preview: v.preview,
          id,
          name: f.name,
          uploading: v.uploading,
        };
        if (s?.uploading) onPick(s);
        else onUpdate((cur) => (cur?.id === id ? s : cur));
      },
      "video",
    );
  };
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-strong bg-background px-4 py-10 text-center transition-colors sm:py-14",
        over && "border-primary bg-brand-faint",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files?.[0]);
      }}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">
        {over ? <Upload className="size-5" /> : <MicOff className="size-5" />}
      </span>
      <div>
        <p className="text-[15px] font-medium">
          Add a video with talking in it
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          MP4, MOV or WebM, up to 200 MB and 30 minutes
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button
          size="sm"
          className="rounded-full"
          disabled={disabled}
          onClick={() => askFirst() || input.current?.click()}
        >
          <Upload className="size-3.5" /> Upload a video
        </Button>
        <Popover open={picking && !disabled} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              disabled={disabled}
            >
              <Library className="size-3.5" /> From library
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[min(92vw,360px)] p-2"
            collisionPadding={12}
          >
            <p className="px-1 pb-2 text-[13px] font-medium">
              From your library
            </p>
            {picking && (
              <LibraryGrid
                kinds={["video"]}
                onPick={(v) => {
                  onPick({
                    ref: v.ref,
                    preview: v.preview,
                    id: v.id ?? nanoid(8),
                    name: v.name,
                  });
                  setPicking(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.video}
        hidden
        disabled={disabled}
        aria-label="Upload a video"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const onDevice = (device?: string) =>
  device === "cuda" ? "on your GPU" : device ? "on your CPU" : "on a CPU";

/** A stem of the split step, as a download. */
function StemDownload({
  split,
  stem,
  name,
  label,
}: {
  split: Generation;
  stem: StemId;
  name: string;
  label?: string;
}) {
  const o = split.outputs.find(
    (x) => x.kind === "audio" && x.meta?.stem === stem,
  );
  if (!o) return null;
  const file = `${name} · ${stemLabel(stem)}.flac`;
  return (
    <Button
      variant="outline"
      size="sm"
      className="max-w-full rounded-full"
      asChild
    >
      <a href={downloadHref(o.url, file)} download={file}>
        <Download className="size-3.5 shrink-0" />{" "}
        <span className="truncate">
          {label ?? `${stemLabel(stem)} (taken out)`}
        </span>
      </a>
    </Button>
  );
}

function ResultPanel({
  before,
  result,
  split,
  outcome,
  name,
}: {
  before: string;
  result: Generation;
  split?: Generation;
  outcome: DialogueOutcome;
  name: string;
}) {
  const video = result.outputs.find((o) => o.kind === "video");
  if (!video) return null;
  const file = `${name} · ${OUTCOMES.find((o) => o.id === outcome)?.label ?? "Remove dialogue"}.mp4`;
  const removed = REMOVED_STEM[outcome];
  return (
    <Panel
      title="Before and after"
      aside={
        <span className="text-[12px] text-muted-foreground">
          Picture copied as it is
        </span>
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
        <figure className="min-w-0 space-y-1.5">
          <video
            src={before}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-xl bg-media object-contain"
            aria-label="The original video"
          />
          <figcaption className="text-[12px] text-muted-foreground">
            Before
          </figcaption>
        </figure>
        <figure className="min-w-0 space-y-1.5">
          <video
            src={video.url}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-xl bg-media object-contain"
            aria-label="The video with its new soundtrack"
          />
          <figcaption className="text-[12px] text-muted-foreground">
            After · {OUTCOMES.find((o) => o.id === outcome)?.label}
          </figcaption>
        </figure>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" className="max-w-full rounded-full" asChild>
          <a href={downloadHref(video.url, file)} download={file}>
            <Download className="size-3.5 shrink-0" />{" "}
            <span className="truncate">Download the video</span>
          </a>
        </Button>
        {split && removed && (
          <StemDownload split={split} stem={removed} name={name} />
        )}
        {split && !removed && (
          <>
            <StemDownload
              split={split}
              stem="voice"
              name={name}
              label="Dialogue"
            />
            <StemDownload
              split={split}
              stem="background"
              name={name}
              label="Music & effects (full level)"
            />
          </>
        )}
      </div>
    </Panel>
  );
}

export function RemoveDialogueTool() {
  const [engine, setEngine, mode] = useEngine();
  const run = useAudioToolRun();
  const [source, setSource] = useState<Source | null>(null);
  const [outcome, setOutcome] = useState<DialogueOutcome>("no-dialogue");
  const [musicDb, setMusicDb] = useState(LOWER_DEFAULT_DB);
  const [quality, setQuality] = useState<SplitQuality | null>(null);
  const [ran, setRan] = useState<{
    result: string;
    split?: string;
    outcome: DialogueOutcome;
    before: string;
    name: string;
  } | null>(null);
  const result = useGeneration(ran?.result);
  const split = useGeneration(ran?.split);
  const sliderId = useId();
  const take = useCallback((s: Source) => {
    setSource(s);
    setRan(null);
  }, []);
  useHandoff(take);
  const ready = source && !source.uploading && source.ref ? source : null;
  const body: AudioToolBody | null = useMemo(
    () =>
      ready
        ? {
            tool: "remove-dialogue",
            engine,
            video: ready.ref,
            name: baseName(ready),
            outcome,
            ...(outcome === "lower-music" && { musicDb }),
            ...(quality && { quality }),
            ...(ready.duration && { sourceDuration: ready.duration }),
          }
        : null,
    [ready, engine, outcome, musicDb, quality],
  );
  const preview = useAudioToolPreview(
    useSettled(engine === "open" ? body : null),
  );
  const p = preview.data;
  const picked: SplitQuality = quality ?? p?.hostPick ?? "fast";
  const cloudProblem =
    mode === "cloud" ? CLOUD_ONLY_REMOVE_PROBLEM : CLOUD_REMOVE_PROBLEM;
  const blocker = !source
    ? "Add a video"
    : source.uploading
      ? "Uploading…"
      : engine === "cloud"
        ? cloudProblem
        : null;
  const error = preview.error ? (preview.error as Error).message : null;
  const g = result.data;
  const busy =
    run.isPending || g?.status === "queued" || g?.status === "running";
  const go = () => {
    if (blocker) return void toast(blocker);
    if (!body) return;
    if (error) return void toast.error(error);
    run.mutate(body!, {
      onSuccess: (r) => {
        setRan({
          result: r.result.id,
          split: r.items.find((x) => x.op === "separate-audio")?.id,
          outcome,
          before: ready!.ref,
          name: baseName(ready!),
        });
        toast.success("Taking the dialogue out on your ComfyUI");
      },
      onError: (e) => toastError(e),
    });
  };
  const s = split.data;
  const stage =
    g?.status === "queued" && s && s.status !== "succeeded"
      ? (s.message ?? "Splitting the soundtrack")
      : (g?.message ?? "Working");
  const progress =
    g?.status === "running"
      ? g.progress
      : s?.status === "running"
        ? s.progress
        : null;

  return (
    <ToolShell title="Video tools">
      {!source && (
        <ToolHero
          title="Remove dialogue"
          subtitle={`${COPY} Runs on your ComfyUI with DBS (open source, 23 MB, CPU or GPU): free.`}
        />
      )}
      <div
        className={cn(
          "mx-auto max-w-[860px] space-y-3",
          source ? "pt-4" : "mt-8",
        )}
      >
        {!source ? (
          <AddVideo onPick={take} onUpdate={setSource} />
        ) : (
          <Panel
            title={
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FileVideo className="size-3.5 shrink-0" />
                <span className="truncate">{baseName(source)}</span>
              </span>
            }
            aside={
              <>
                {source.duration ? (
                  <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
                    {clock(source.duration)}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Remove the video"
                  onClick={() => {
                    setSource(null);
                    setRan(null);
                  }}
                >
                  <X className="size-4" />
                </Button>
              </>
            }
          >
            {source.uploading ? (
              <p
                className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-3.5 animate-spin" /> Uploading…
              </p>
            ) : (
              <video
                key={source.preview}
                src={source.preview}
                controls
                playsInline
                preload="metadata"
                aria-label={`Play ${baseName(source)}`}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0)
                    setSource((cur) => (cur ? { ...cur, duration: d } : cur));
                }}
                className="max-h-[36vh] w-full rounded-xl bg-media object-contain"
              />
            )}
          </Panel>
        )}
        {source && engine === "cloud" && (
          <Panel>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  Remove dialogue runs on your GPU (open source).
                </span>{" "}
                {mode === "cloud"
                  ? "This install is set to paid cloud APIs only (Settings → Engine mode), and DBS isn't hosted on fal or Replicate."
                  : "DBS isn't hosted on fal or Replicate, so there's no cloud route that takes the dialogue out."}
              </p>
              {mode === "both" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-full"
                  onClick={() => setEngine("open" as Engine)}
                >
                  <Cpu className="size-3.5" /> Use open source
                </Button>
              ) : null}
            </div>
          </Panel>
        )}
        {source && engine === "open" && (
          <Panel title="What to keep">
            <div className="space-y-3">
              <Segmented
                label="What to keep"
                value={outcome}
                onChange={setOutcome}
                options={OUTCOMES.map((o) => ({
                  value: o.id,
                  label: o.label,
                  hint: o.hint,
                }))}
              />
              <p className="text-[12px] text-muted-foreground">
                {OUTCOMES.find((o) => o.id === outcome)?.hint}.
              </p>
              {outcome === "lower-music" && (
                <div className="flex min-w-0 items-center gap-3">
                  <label htmlFor={sliderId} className="shrink-0 text-[13px]">
                    Music &amp; effects
                  </label>
                  <Slider
                    id={sliderId}
                    min={LOWER_MIN_DB}
                    max={LOWER_MAX_DB}
                    step={1}
                    value={[musicDb]}
                    onValueChange={([v]) => setMusicDb(v)}
                    aria-label="Music and effects level"
                    aria-valuetext={`${musicDb} dB`}
                    className="min-w-0 flex-1"
                  />
                  <span className="w-14 shrink-0 text-right font-mono text-[12px] tabular-nums">
                    {musicDb === 0 ? "0 dB" : `−${Math.abs(musicDb)} dB`}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-[13px]">Model</span>
                <Segmented
                  label="Model"
                  value={picked}
                  onChange={(v) => setQuality(v)}
                  options={(["fast", "best"] as const).map((q) => ({
                    value: q,
                    label: `${QUALITY_LABELS[q]}${p?.installed && !p.installed.includes(q) ? " · not installed" : ""}`,
                  }))}
                />
                {!quality && p?.hostPick && p.device && (
                  <span className="text-[12px] text-muted-foreground">
                    picked for your {p.device === "cuda" ? "GPU" : "CPU"}
                  </span>
                )}
              </div>
            </div>
          </Panel>
        )}
        {source && (
          <div className="space-y-2">
            {!blocker && !error && p && (
              <div
                className="space-y-1 text-[13px] text-muted-foreground"
                aria-live="polite"
              >
                <p>{p.summary}</p>
                {p.notes.map((n) => (
                  <p key={n} className="text-[12px]">
                    {n}
                  </p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <p
                className={cn(
                  "min-w-0 flex-1 text-[13px]",
                  error && !blocker
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
                aria-live="polite"
              >
                {blocker && engine !== "cloud" ? (
                  blocker
                ) : engine === "cloud" ? (
                  mode === "cloud" ? (
                    "Not available on this install: it is set to paid cloud APIs only"
                  ) : (
                    "Switch to the open engine to remove dialogue"
                  )
                ) : error ? (
                  error
                ) : p ? (
                  <>
                    <span className="font-mono text-foreground">
                      {openToolPrice(p)}
                    </span>
                    {p.estimate && !p.demo
                      ? ` · ${durationWords(p.estimate)} ${onDevice(p.device)}`
                      : ""}
                  </>
                ) : (
                  "Checking…"
                )}
              </p>
              <Button
                size="lg"
                className={cn(
                  "rounded-full",
                  (blocker || error) &&
                    "bg-muted text-subtle-foreground hover:bg-muted",
                )}
                onClick={go}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MicOff className="size-4" />
                )}{" "}
                {RUN_LABEL[outcome]}
              </Button>
            </div>
          </div>
        )}
        {g && (g.status === "queued" || g.status === "running") && (
          <Panel>
            <p
              className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-3.5 animate-spin" /> {stage}…
              {progress ? ` ${Math.round(progress * 100)}%` : ""}
            </p>
          </Panel>
        )}
        {g?.status === "failed" && (
          <p className="text-[13px] text-destructive" role="alert">
            {g.error ?? "It didn't finish"}
          </p>
        )}
        {ran && g?.status === "succeeded" && (
          <ResultPanel
            before={ran.before}
            result={g}
            split={s}
            outcome={ran.outcome}
            name={ran.name}
          />
        )}
      </div>
      <Results
        open={ran?.result ?? null}
        onOpen={(r, splitStep) => {
          const video = r.request.inputs?.video;
          if (!video) return;
          const name = r.request.title?.replace(/^.* · /, "") || "Video";
          setSource({ ref: video, preview: video, id: r.id, name });
          // The controls show what that run was asked for, so the button runs it again, not what was on screen.
          const was = requestedOutcome(r.request);
          setOutcome(was.outcome);
          if (was.outcome === "lower-music") setMusicDb(was.musicDb);
          setRan({
            result: r.id,
            split: splitStep?.id,
            outcome: was.outcome,
            before: video,
            name,
          });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </ToolShell>
  );
}

/** Earlier runs (both steps: the new video and its stems), and a way back to a finished one's before / after. */
function Results({
  onOpen,
  open,
}: {
  onOpen: (g: Generation, split?: Generation) => void;
  open: string | null;
}) {
  const runs = useGenerations({
    features: [REMOVE_DIALOGUE_FEATURE],
    limit: 24,
  });
  const items = runs.data ?? [];
  const reopen = items
    .filter((g) => g.op === "mux" && g.status === "succeeded" && g.id !== open)
    .slice(0, 4);
  if (!items.length) return null;
  return (
    <section
      className="mx-auto mt-10 max-w-[1040px]"
      aria-labelledby="remove-dialogue-results"
    >
      <h3
        id="remove-dialogue-results"
        className="mb-3 font-heading text-[22px]"
      >
        Your videos
      </h3>
      {reopen.length > 0 && (
        <div className="mb-4 flex min-w-0 flex-wrap gap-2">
          {reopen.map((g) => (
            <Button
              key={g.id}
              variant="outline"
              size="sm"
              className="max-w-full rounded-full"
              onClick={() =>
                onOpen(
                  g,
                  items.find(
                    (x) =>
                      x.op === "separate-audio" &&
                      x.batchId &&
                      x.batchId === g.batchId,
                  ),
                )
              }
            >
              <MicOff className="size-3.5 shrink-0" />{" "}
              <span className="truncate">
                Compare {g.request.title ?? "result"}
              </span>
            </Button>
          ))}
        </div>
      )}
      <Feed items={items} />
    </section>
  );
}
