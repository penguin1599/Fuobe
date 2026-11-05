"use client";

import { AudioLines, ChevronRight, Clapperboard, Cpu, Download, FileVideo, Library, Loader2, Mic2, Sparkles, Upload, UserRound, X } from "lucide-react";
import Link from "next/link";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Feed } from "@/components/studio/feed";
import { ACCEPT, kindOfFile, LibraryGrid, type SlotValue } from "@/components/studio/media-slot";
import { VoiceRecorder } from "@/components/studio/voice-recorder";
import { Segmented } from "@/components/faceless/controls";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import { GUEST_PROMPT_EVENT, useAskBeforeUpload, useEngine, useGenerations, useHydrated, useIsGuest, useViewer } from "@/lib/api";
import type { AudioToolPreview } from "@/lib/av/audio-tools";
import {
  BACKGROUND_LABELS,
  CLEAN_FEATURE,
  CLEAN_NOTES,
  CLEAN_REMUX_FEATURE,
  CLOUD_ONLY_CLEAN_PROBLEM,
  CLOUD_CLEAN_PROBLEM,
  cleanDefaults,
  durationWords,
  khz,
  LEVEL_LABELS,
  QUALITY_HINTS,
  QUALITY_LABELS,
  REUSE_LABELS,
  reportLine,
  scanHint,
  STRENGTH_LABELS,
  type CleanBackground,
  type CleanLevel,
  type CleanQuality,
  type CleanStrength,
  type ReuseModel,
} from "@/lib/av/clean-voice";
import { clock } from "@/lib/av/audio-tools";
import { DEMO_MEDIA } from "@/lib/av/clean-voice-demo";
import type { Generation, OutputFile } from "@/lib/catalog/types";
import { downloadHref } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { BeforeAfterAudio } from "./before-after-audio";
import { CleanVoiceDemo } from "./clean-voice-demo";
import { useAudioToolPreview, useAudioToolRun, useSettled, type AudioToolBody } from "./hooks";
import { uploadSource } from "./split-tool";

/**
 * Clean up voice ("kinda like an app"): one tool, at /audio/clean and as the Clean up voice app. Drop a recording or a
 * video; NVIDIA RE-USE cleans the voice on your ComfyUI (free, CPU or GPU) and the before/after player plays your own
 * before and after from one playhead. Until someone has cleaned a file of their own, the page opens on the demo
 * (CleanVoiceDemo), so everyone (guests too) hears what it does at once. There's no hosted RE-USE, so the cloud engine says so.
 */

const TOOL_SUBTITLE =
  "Removes noise, echo and room sound, and fixes clipping, muffled or phone-quality audio and bad mics. Keeps the main speaker, in any language. Free, on your own computer.";

type Source = SlotValue & { kind: "audio" | "video"; duration?: number; channels?: number };

const baseName = (s: { name?: string }) => (s.name ?? "Recording").replace(/\.[a-z0-9]{2,4}$/i, "");
const money = (p: AudioToolPreview) => (p.demo ? "Placeholder · free" : "Free · runs on your GPU");
const onDevice = (device?: string) => (device === "cuda" ? "on your GPU" : device ? "on your CPU" : "on a CPU");

/** ?audio= / ?video= from a Library result's "Clean up voice" (or Split's "Clean the dialogue", with background=keep), read once after hydration. */
function useHandoff(take: (s: Source, keep?: boolean) => void) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const kind of ["video", "audio"] as const) {
      const url = q.get(kind);
      if (url?.startsWith("/api/files/")) return take({ ref: url, preview: url, kind, id: nanoid(8), name: decodeURIComponent(url.split("/").pop() ?? "") }, q.get("background") === "keep");
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function AddMedia({ onPick, onUpdate }: { onPick: (s: Source) => void; onUpdate: (next: (cur: Source | null) => Source | null) => void }) {
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const askFirst = useAskBeforeUpload();
  const inputId = useId();
  const take = (f: File | undefined) => {
    if (!f || askFirst()) return;
    const kind = kindOfFile(f);
    if (kind !== "audio" && kind !== "video") return void toast("Audio or video only — drop a recording or a clip here");
    void uploadSource(f, kind, onPick, onUpdate);
  };
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-strong bg-background px-4 py-8 text-center transition-colors sm:py-10",
        over && "border-primary bg-brand-faint",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files?.[0]);
      }}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">{over ? <Upload className="size-5" /> : <AudioLines className="size-5" />}</span>
      <div>
        <p className="text-[15px] font-medium">Add a voice recording or a video to clean</p>
        <p className="mt-1 text-[13px] text-muted-foreground">Speech in any language, up to 200 MB · audio or video</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" className="rounded-full" onClick={() => askFirst() || document.getElementById(inputId)?.click()}>
          <Upload className="size-3.5" /> Upload
        </Button>
        <VoiceRecorder max={300} onRecorded={(v) => onPick({ ...v, id: nanoid(8), kind: "audio", name: "Recording" })} />
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="rounded-full">
              <Library className="size-3.5" /> Pick from Library
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(92vw,360px)] p-2" collisionPadding={12}>
            <p className="px-1 pb-2 text-[13px] font-medium">From your library</p>
            {picking && (
              <LibraryGrid
                kinds={["audio", "video"]}
                onPick={(v) => {
                  onPick({ ...v, kind: v.kind === "video" ? "video" : "audio" });
                  setPicking(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
      <input
        id={inputId}
        type="file"
        accept={`${ACCEPT.audio},${ACCEPT.video}`}
        hidden
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function SourcePanel({ source, onDuration, onRemove }: { source: Source; onDuration: (s: number) => void; onRemove: () => void }) {
  const meta = (e: React.SyntheticEvent<HTMLMediaElement>) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && onDuration(e.currentTarget.duration);
  return (
    <Panel
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {source.kind === "video" ? <FileVideo className="size-3.5 shrink-0" /> : <AudioLines className="size-3.5 shrink-0" />}
          <span className="truncate">{baseName(source)}</span>
        </span>
      }
      aside={
        <>
          {source.duration ? <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{clock(source.duration)}</span> : null}
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Remove the recording" onClick={onRemove}>
            <X className="size-4" />
          </Button>
        </>
      }
    >
      {source.uploading ? (
        <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" /> Uploading…
        </p>
      ) : source.kind === "video" ? (
        <video key={source.preview} src={source.preview} controls playsInline preload="metadata" onLoadedMetadata={meta} className="max-h-[36vh] w-full rounded-xl bg-media object-contain" />
      ) : (
        <audio key={source.preview} src={source.preview} controls preload="metadata" onLoadedMetadata={meta} className="h-9 w-full min-w-0" aria-label={`Play ${baseName(source)}`} />
      )}
    </Panel>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-[13px]">{label}</span>
        {children}
      </div>
      {hint && <p className="text-[12px] text-muted-foreground sm:pl-[6.5rem]">{hint}</p>}
    </div>
  );
}

const cleanOf = (g?: Generation | null): OutputFile | undefined => g?.outputs.find((o) => o.kind === "audio");
const reportOf = (g?: Generation | null): string | undefined => g?.outputs.find((o) => o.kind === "text")?.text;

export function CleanVoiceTool({ app }: { app?: { name: string; description: string } }) {
  const [engine, setEngine, mode] = useEngine();
  // A guest hears the demo and loads its recording; cleaning one is for an account: Clean up voice opens the free
  // account card, and the setup words (which model, which install) stay out of a guest's way.
  const guest = useIsGuest();
  const run = useAudioToolRun();
  const [source, setSource] = useState<Source | null>(null);
  const [model, setModel] = useState<ReuseModel>("voice");
  const [quality, setQuality] = useState<CleanQuality>("auto");
  const [strength, setStrength] = useState<CleanStrength | null>(null);
  const [background, setBackground] = useState<CleanBackground | null>(null);
  const [level, setLevel] = useState<CleanLevel>("match");
  const [remux, setRemux] = useState(true);
  const [resultId, setResultId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const result = useGeneration(resultId);
  const onVideo = useGeneration(videoId);
  const remuxId = useId();
  const take = useCallback((s: Source, keep?: boolean) => {
    setSource(s);
    setResultId(null);
    setVideoId(null);
    setStrength(null);
    setBackground(keep ? "keep" : null);
  }, []);
  useHandoff(take);
  // Someone who has cleaned a file of their own sees their results, not the demo. Until that's known the demo keeps its
  // place unseen (a guest has none, so no need to wait): neither an account with cleans nor a guest sees the page jump.
  // Both wait for hydration, so the first render matches the server's HTML even when the answers came in before it.
  const hydrated = useHydrated();
  const viewer = useViewer().data;
  const own = useGenerations({ features: [CLEAN_FEATURE], statuses: ["succeeded"], limit: 1 });
  const known = hydrated && (viewer?.signedIn === false || own.isFetched || own.isError);
  const demo = !source && !(hydrated && own.data?.length);

  const kind = source?.kind ?? "audio";
  const d = cleanDefaults(kind);
  const pickedStrength = strength ?? d.strength;
  const pickedBackground = background ?? d.background;
  const ready = source && !source.uploading && source.ref ? source : null;
  const body: AudioToolBody | null = useMemo(
    () =>
      ready
        ? {
            tool: "clean",
            engine,
            media: ready.ref,
            kind: ready.kind,
            name: baseName(ready),
            model,
            quality,
            strength: pickedStrength,
            background: pickedBackground,
            level,
            ...(ready.kind === "video" && { remux }),
            ...(ready.channels && { channels: ready.channels }),
            ...(ready.duration && { sourceDuration: ready.duration }),
          }
        : null,
    [ready, engine, model, quality, pickedStrength, pickedBackground, level, remux],
  );
  const preview = useAudioToolPreview(useSettled(engine === "open" ? body : null));
  const p = preview.data;
  const cloudProblem = mode === "cloud" ? CLOUD_ONLY_CLEAN_PROBLEM : CLOUD_CLEAN_PROBLEM;
  const blocker = !source ? "Add a recording to clean" : source.uploading ? "Uploading…" : engine === "cloud" ? cloudProblem : null;
  const error = preview.error ? (preview.error as Error).message : null;
  const g = result.data;
  const busy = run.isPending || g?.status === "queued" || g?.status === "running" || onVideo.data?.status === "queued" || onVideo.data?.status === "running";
  const go = () => {
    if (guest && source && !source.uploading) return void window.dispatchEvent(new CustomEvent(GUEST_PROMPT_EVENT, { detail: { action: "run" } }));
    if (blocker) return void toast(blocker);
    if (error) return void toast.error(error);
    run.mutate(body!, {
      onSuccess: (r) => {
        const clean = r.items.find((x) => x.feature === CLEAN_FEATURE) ?? r.result;
        setResultId(clean.id);
        setVideoId(r.items.find((x) => x.feature === CLEAN_REMUX_FEATURE)?.id ?? null);
        toast.success("Cleaning on your ComfyUI");
      },
      onError: (e) => toastError(e),
    });
  };
  const putBack = () => {
    const out = cleanOf(g);
    if (!source || !out) return;
    run.mutate(
      { tool: "remux", engine: "open", video: source.ref, audio: out.url, name: baseName(source) },
      { onSuccess: (r) => (setVideoId(r.result.id), toast.success("Putting the clean voice on your video (picture copied as it is)")), onError: (e) => toastError(e) },
    );
  };
  const out = g?.status === "succeeded" ? cleanOf(g) : undefined;
  const line = reportLine(reportOf(g));
  const hint = scanHint(reportOf(g));
  const installed = p?.reuse?.installed;
  const laughterMissing = installed && !installed.includes("laughter");

  return (
    <ToolShell
      title={app ? app.name : "Audio"}
      header={
        app ? (
          <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-[13px] text-muted-foreground sm:flex">
            <Link href="/apps" className="hover:text-foreground">
              Apps
            </Link>
            <ChevronRight className="size-3.5" />
            <span className="text-foreground">{app.name}</span>
          </nav>
        ) : undefined
      }
    >
      {!source && !demo && <ToolHero title={app?.name ?? "Clean up voice"} subtitle={TOOL_SUBTITLE} />}
      {/* The demo's photo narrows on a short screen, so its play button and Noise on / off stay above the fold. */}
      <div className={cn("mx-auto space-y-3", demo ? "max-w-[min(760px,max(480px,calc((var(--content-h)_-_356px)*4/3)))] pt-6" : "max-w-[860px]", source ? "pt-4" : !demo && "mt-6")}>
        {demo && (
          <>
            <CleanVoiceDemo name={app?.name ?? "Clean up voice"} ready={known} />
            {/* The tool's one line leads into the upload box under the demo. */}
            <p className="pt-8 text-[13px] text-pretty text-muted-foreground">{TOOL_SUBTITLE}</p>
            {/* The demo's own recording, loaded as the source: its price shows, and it runs with no upload. */}
            <Button
              variant="outline"
              className="h-11 rounded-full px-5"
              onClick={() => take({ ref: DEMO_MEDIA.noisy, preview: DEMO_MEDIA.noisy, kind: "audio", id: nanoid(6), name: "Restaurant recording.m4a" })}
            >
              <Sparkles className="size-4" />
              Try it on this recording
            </Button>
          </>
        )}
        {!source ? (
          <AddMedia onPick={take} onUpdate={setSource} />
        ) : (
          <SourcePanel
            source={source}
            onDuration={(duration) => setSource((s) => (s ? { ...s, duration } : s))}
            onRemove={() => {
              setSource(null);
              setResultId(null);
              setVideoId(null);
            }}
          />
        )}
        {source && engine === "cloud" && !guest && (
          <Panel>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">Clean up voice runs on your GPU (open source).</span>{" "}
                {mode === "cloud"
                  ? "This install is set to paid cloud APIs only (Settings → Engine mode), and NVIDIA RE-USE isn't hosted on fal or Replicate."
                  : "NVIDIA RE-USE isn't hosted on fal or Replicate, so the cloud engine can't clean a voice."}
              </p>
              {mode === "both" ? (
                <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={() => setEngine("open")}>
                  <Cpu className="size-3.5" /> Use open source
                </Button>
              ) : null}
            </div>
          </Panel>
        )}
        {source && (engine === "open" || guest) && (
          <Panel title="Options">
            <div className="space-y-3">
              <Row label="Strength" hint={pickedStrength === "full" ? CLEAN_NOTES.gaps : "Leaves a little of the room under the voice, so pauses sound natural."}>
                <Segmented label="Strength" value={pickedStrength} onChange={setStrength} options={(["full", "natural", "light"] as const).map((s) => ({ value: s, label: STRENGTH_LABELS[s] }))} />
              </Row>
              {!guest && (
              <Row label="Model" hint={model === "laughter" ? "Keep laughter keeps laughs and breaths a little more." : laughterMissing ? "Keep laughter isn't installed on your ComfyUI (models/reuse/NemotronLabs-RE-USE-laughter.safetensors)." : undefined}>
                <Segmented
                  label="Model"
                  value={model}
                  onChange={(m) => (m === "laughter" && laughterMissing ? toast("Keep laughter isn't installed — copy its download from Workflows → Clean up voice") : setModel(m))}
                  options={(["voice", "laughter"] as const).map((m) => ({ value: m, label: `${REUSE_LABELS[m]}${m === "laughter" && laughterMissing ? " · not installed" : ""}` }))}
                />
              </Row>
              )}
              <Row label="Quality" hint={QUALITY_HINTS[quality]}>
                <Segmented label="Quality" value={quality} onChange={setQuality} options={(["auto", "full", "fast"] as const).map((q) => ({ value: q, label: QUALITY_LABELS[q] }))} />
              </Row>
              <Row label="Background" hint={pickedBackground === "keep" ? CLEAN_NOTES.keepNoise : CLEAN_NOTES.speaker}>
                <Segmented label="Background" value={pickedBackground} onChange={setBackground} options={(["remove", "keep"] as const).map((b) => ({ value: b, label: BACKGROUND_LABELS[b] }))} />
              </Row>
              <Row label="Level">
                <Segmented label="Level" value={level} onChange={setLevel} options={(["match", "voice"] as const).map((l) => ({ value: l, label: LEVEL_LABELS[l] }))} />
              </Row>
              {source.kind === "video" && (
                <div className="flex items-center gap-2 sm:pl-[6.5rem]">
                  <Switch id={remuxId} checked={remux} onCheckedChange={setRemux} />
                  <label htmlFor={remuxId} className="text-[13px]">
                    Put back on the video <span className="text-muted-foreground">(the picture is copied as it is)</span>
                  </label>
                </div>
              )}
            </div>
          </Panel>
        )}
        {source && (
          <div className="space-y-2">
            {!guest && !blocker && !error && p && (
              <div className="space-y-1 text-[13px] text-muted-foreground" aria-live="polite">
                <p>{p.summary}</p>
                {p.notes.map((n) => (
                  <p key={n} className="text-[12px]">
                    {n}
                  </p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <p className={cn("min-w-0 flex-1 text-[13px]", error && !blocker ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
                {guest && !source.uploading ? (
                  "Free with an account: create one to clean your own recordings"
                ) : blocker && engine !== "cloud" ? (
                  blocker
                ) : engine === "cloud" ? (
                  mode === "cloud" ? (
                    "Not available on this install: it is set to paid cloud APIs only"
                  ) : (
                    "Switch to the open engine to clean a voice"
                  )
                ) : error ? (
                  error
                ) : p ? (
                  <>
                    <span className="font-mono text-foreground">{money(p)}</span>
                    {p.estimate && !p.demo ? ` · ${durationWords(p.estimate)} ${onDevice(p.device)}` : ""}
                    {p.reuse?.rate && !p.demo ? ` · ${khz(p.reuse.rate)}` : ""}
                  </>
                ) : (
                  "Checking…"
                )}
              </p>
              <Button size="lg" className={cn("rounded-full", !guest && (blocker || error) && "bg-muted text-subtle-foreground hover:bg-muted")} onClick={go} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Clean up voice
              </Button>
            </div>
          </div>
        )}
        {g && (g.status === "queued" || g.status === "running") && (
          <Panel>
            <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" /> {g.message ?? "Cleaning the voice"}…{g.progress ? ` ${Math.round(g.progress * 100)}%` : ""}
            </p>
          </Panel>
        )}
        {g?.status === "failed" && (
          <p className="text-[13px] text-destructive" role="alert">
            {g.error ?? "Cleaning failed"}
          </p>
        )}
        {source && out && (
          <Panel
            title="Your before and after"
            aside={line ? <span className="hidden text-[12px] text-muted-foreground sm:inline">{line}</span> : undefined}
          >
            <BeforeAfterAudio key={out.url} before={source.preview} after={out.url} labels={{ before: "Original", after: "Clean" }} />
            {hint && <p className="mt-2 text-[12px] text-muted-foreground">{hint}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" asChild>
                <a href={downloadHref(out.url, `${baseName(source)} · clean.flac`)} download>
                  <Download className="size-3.5" /> Download
                </a>
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" asChild>
                <Link href={`/lipsync?audio=${encodeURIComponent(out.url)}`}>
                  <Mic2 className="size-3.5" /> Use in Lipsync
                </Link>
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" asChild>
                <Link href={`/audio/speech?voice=${encodeURIComponent(out.url)}`}>
                  <UserRound className="size-3.5" /> Use as a voice sample
                </Link>
              </Button>
              {source.kind === "video" && !videoId && (
                <Button size="sm" className="rounded-full" disabled={busy} onClick={putBack}>
                  <Clapperboard className="size-3.5" /> Put back on the video
                </Button>
              )}
              {onVideo.data?.status === "succeeded" && <span className="text-[12px] text-success">The clean video is in your Library.</span>}
            </div>
          </Panel>
        )}
      </div>
      <Results />
    </ToolShell>
  );
}

/** Earlier cleans (and videos with their clean soundtrack). */
function Results() {
  const cleans = useGenerations({ features: [CLEAN_FEATURE], limit: 12 });
  const videos = useGenerations({ features: [CLEAN_REMUX_FEATURE], limit: 12 });
  const items = [...(videos.data ?? []), ...(cleans.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!items.length) return null;
  return (
    <section className="mx-auto mt-10 max-w-[1040px]" aria-labelledby="clean-results">
      <h3 id="clean-results" className="mb-3 font-heading text-[22px]">
        Your clean voices
      </h3>
      <Feed items={items} />
    </section>
  );
}
