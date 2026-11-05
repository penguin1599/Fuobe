"use client";

import { AudioLines, Clapperboard, Cpu, Download, FileVideo, Library, Loader2, Mic2, RotateCcw, Sparkles, Upload, X } from "lucide-react";
import Link from "next/link";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OwnSetupChip, useOwnSetupPress, useOwnSetupViewer } from "@/components/own-setup";
import { Feed } from "@/components/studio/feed";
import { ACCEPT, kindOfFile, LibraryGrid, type SlotValue } from "@/components/studio/media-slot";
import { VoiceRecorder } from "@/components/studio/voice-recorder";
import { Segmented } from "@/components/faceless/controls";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import { useAskBeforeUpload, useCreateGeneration, useEngine, useGenerations, useHydrated } from "@/lib/api";
import { clock } from "@/lib/av/audio-tools";
import type { Generation, OutputFile } from "@/lib/catalog/types";
import type { Cue } from "@/lib/cues";
import type { OwnSetup } from "@/lib/own-setup";
import { parseCues } from "@/lib/cues";
import { downloadHref } from "@/lib/library";
import { readSpeechEditHandoff } from "@/lib/speech-edit-handoff";
import { toastError } from "@/lib/refusals";
import {
  AUK_LANGUAGES,
  AUK_SETTINGS,
  CLOUD_ONLY_SPEECH_EDIT_PROBLEM,
  CLOUD_SPEECH_EDIT_PROBLEM,
  EFFECT_LABELS,
  EMOTIONS,
  PACES,
  PITCH_STEPS,
  PROMPT_HELPER_NOTE,
  QUALITY_HINTS,
  SPEECH_EDIT_FEATURE,
  VOLUME_STEPS,
  type AukQuality,
  type EffectKind,
  type SpeechEffect,
} from "@/lib/speech-edit";
import { cn } from "@/lib/utils";
import { BeforeAfterAudio } from "./before-after-audio";
import { useAudioToolPreview, useAudioToolRun, useSettled, type AudioToolBody } from "./hooks";
import { uploadSource } from "./split-tool";

/**
 * Audio → Edit speech (nm10-speech-edit): add a recording or a video, transcribe it, then change its words (AuK re-speaks
 * just the changed part in the same voice) or how a stretch of it sounds (pitch, pace, volume, emotion, whisper, Clean up,
 * Keep only this speaker). Runs on your GPU (open source): AuK is hosted on neither fal nor Replicate. The result plays
 * against the original with an A/B switch; a video gets its new sound back with the picture copied as it is.
 */

const COPY = "Change a word without re-recording it, or how a line sounds: its pitch, pace, mood or noise. The new words come out in the same voice.";
const SUBTITLE = `${COPY} Free, on your own GPU.`;
/**
 * What Edit speech needs from a guest's or an account's own setup (src/lib/own-setup.ts): its own GPU with AuK's files
 * and 24 GB. A guest signs up first; an account without its own GPU connects one (a key doesn't run AuK).
 */
const OWN_SETUP = "audio:edit-speech";

type Source = SlotValue & { kind: "audio" | "video"; duration?: number };
type Mode = "words" | "sound";

const baseName = (s: { name?: string }) => (s.name ?? "Recording").replace(/\.[a-z0-9]{2,4}$/i, "");
const cuesOf = (g: Generation | undefined): Cue[] | null => {
  const out = g?.outputs.find((o) => o.kind === "text");
  if (!out) return null;
  return Array.isArray(out.meta?.cues) ? (out.meta!.cues as Cue[]) : out.text ? parseCues(out.text) : null;
};
const audioOf = (g: Generation | undefined): OutputFile | undefined => g?.outputs.find((o) => o.kind === "audio");
const videoOf = (g: Generation | undefined): OutputFile | undefined => g?.outputs.find((o) => o.kind === "video");

const EFFECTS: EffectKind[] = ["pitch", "pace", "volume", "emotion", "whisper", "unwhisper", "clean", "isolate"];

function defaultEffect(kind: EffectKind): SpeechEffect {
  switch (kind) {
    case "pitch":
      return { kind, semitones: 2 };
    case "pace":
      return { kind, speed: 1.25 };
    case "volume":
      return { kind, db: 5 };
    case "emotion":
      return { kind, emotion: "happy" };
    default:
      return { kind } as SpeechEffect;
  }
}

/** ?audio= / ?video= from a result's ⋯ menu, and a Captions handoff, read once after hydration. */
function useArrival(take: (s: Source, cues?: Cue[], line?: number) => void) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const kind of ["video", "audio"] as const) {
      const url = q.get(kind);
      if (!url?.startsWith("/api/files/")) continue;
      const handed = readSpeechEditHandoff(url, q);
      return take({ ref: url, preview: url, kind, id: nanoid(8), name: handed?.name ?? decodeURIComponent(url.split("/").pop() ?? "") }, handed?.cues, handed?.line);
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * disabled: nothing is uploaded, recorded or picked. A guest is asked to sign up first, and an account without its own
 * GPU to connect one (the edit runs on a GPU only).
 */
function AddMedia({ onPick, onUpdate, disabled }: { onPick: (s: Source) => void; onUpdate: (next: (cur: Source | null) => Source | null) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const askFirst = useAskBeforeUpload({ gpuOnly: true });
  const inputId = useId();
  const take = (f: File | undefined) => {
    if (!f || disabled || askFirst()) return;
    const kind = kindOfFile(f);
    if (kind !== "audio" && kind !== "video") return void toast("Audio or video only: drop a recording or a clip here");
    void uploadSource(f, kind, onPick, onUpdate);
  };
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn("flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-strong bg-background px-4 py-8 text-center transition-colors sm:py-10", over && "border-primary bg-brand-faint")}
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
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">{over ? <Upload className="size-5" /> : <AudioLines className="size-5" />}</span>
      <div>
        <p className="text-[15px] font-medium">Add a recording or a video with speech</p>
        <p className="mt-1 text-[13px] text-muted-foreground">English or Chinese speech, up to 20 minutes</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" className="rounded-full" disabled={disabled} onClick={() => askFirst() || document.getElementById(inputId)?.click()}>
          <Upload className="size-3.5" /> Upload
        </Button>
        {!disabled && <VoiceRecorder max={300} onRecorded={(v) => onPick({ ...v, id: nanoid(8), kind: "audio", name: "Recording" })} />}
        <Popover open={picking && !disabled} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="rounded-full" disabled={disabled}>
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
        disabled={disabled}
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

/** One transcript line: its words to edit (Words), or a tick to pick it (Sound). */
function Line({ cue, index, text, mode, picked, onText, onPick }: { cue: Cue; index: number; text: string; mode: Mode; picked: boolean; onText: (t: string) => void; onPick: (v: boolean) => void }) {
  const changed = text.trim() !== cue.text.trim();
  return (
    <li className={cn("rounded-xl border px-2.5 py-2 transition-colors", changed ? "border-primary/50 bg-brand-faint/50" : picked && mode === "sound" ? "border-primary/40 bg-brand-faint/40" : "border-border")} data-line={index}>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        {mode === "sound" && <Checkbox checked={picked} onCheckedChange={(v) => onPick(v === true)} aria-label={`Pick line ${index + 1}`} />}
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {clock(cue.start)} – {clock(cue.end)}
        </span>
        {changed && (
          <button type="button" className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => onText(cue.text)} aria-label={`Undo the change to line ${index + 1}`}>
            <RotateCcw className="size-3" /> Undo
          </button>
        )}
      </div>
      {mode === "words" ? (
        <>
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            rows={Math.max(1, Math.ceil(text.length / 70))}
            aria-label={`Words of line ${index + 1}`}
            className="w-full min-w-0 resize-none rounded-md bg-transparent px-1 text-[14px] leading-relaxed outline-none focus:bg-muted focus:ring-2 focus:ring-ring/40"
          />
          {changed && <p className="px-1 text-[12px] text-muted-foreground line-through decoration-muted-foreground/60">{cue.text}</p>}
        </>
      ) : (
        <p className="px-1 text-[14px] leading-relaxed">{cue.text}</p>
      )}
    </li>
  );
}

function EffectOptions({ effect, onChange }: { effect: SpeechEffect; onChange: (e: SpeechEffect) => void }) {
  switch (effect.kind) {
    case "pitch":
      return <Segmented label="Semitones" value={effect.semitones} onChange={(semitones) => onChange({ kind: "pitch", semitones })} options={PITCH_STEPS.map((n) => ({ value: n, label: n > 0 ? `+${n}` : String(n) }))} />;
    case "pace":
      return <Segmented label="Speed" value={effect.speed} onChange={(speed) => onChange({ kind: "pace", speed })} options={PACES.map((n) => ({ value: n, label: `${n}×` }))} />;
    case "volume":
      return <Segmented label="Decibels" value={effect.db} onChange={(db) => onChange({ kind: "volume", db })} options={VOLUME_STEPS.map((n) => ({ value: n, label: `${n > 0 ? "+" : ""}${n} dB` }))} />;
    case "emotion":
      return <Segmented label="Emotion" value={effect.emotion} onChange={(emotion) => onChange({ kind: "emotion", emotion })} options={EMOTIONS.map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) }))} />;
    case "clean":
      return <p className="text-[12px] text-muted-foreground">Takes out background noise and room echo, and keeps everyone speaking.</p>;
    case "isolate":
      return <p className="text-[12px] text-muted-foreground">Keeps the person saying the picked lines and takes out other voices.</p>;
    default:
      return null;
  }
}

/**
 * `setup`: what the page read for "audio:edit-speech" (ownSetupsNow): null once its graph is validated on this studio's
 * GPU, when the label leaves; left out, the static entry.
 */
export function SpeechEditTool({ setup }: { setup?: OwnSetup | null } = {}) {
  const item = setup === undefined ? OWN_SETUP : setup;
  const [engine, setEngine, mode] = useEngine();
  // A guest or an account: its own setup's label beside the title (after hydration, so it matches the server HTML),
  // and a press that asks for it first.
  const hydrated = useHydrated();
  const visitor = useOwnSetupViewer() !== null;
  const press = useOwnSetupPress();
  const create = useCreateGeneration();
  const run = useAudioToolRun();
  const [source, setSource] = useState<Source | null>(null);
  // Lines handed over (Captions' "Fix this line"), else the transcript's; edits are kept by line.
  const [handed, setHanded] = useState<Cue[] | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [focus, setFocus] = useState<number | null>(null);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [view, setView] = useState<Mode>("words");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [effect, setEffect] = useState<SpeechEffect>(defaultEffect("pitch"));
  const [quality, setQuality] = useState<AukQuality>("fast");
  const [resultId, setResultId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const result = useGeneration(resultId);
  const onVideo = useGeneration(videoId);

  const transcript = useGeneration(transcriptId);
  const t = transcript.data;
  const transcribed = useMemo(() => (t?.status === "succeeded" ? cuesOf(t) : null), [t]);
  const cues = handed ?? (transcribed?.length ? transcribed : null);
  const texts = useMemo(() => (cues ?? []).map((c, i) => edits[i] ?? c.text), [cues, edits]);
  const take = useCallback(
    (s: Source, given?: Cue[], line?: number) => {
      setSource(s);
      // A video keeps its length (Pace would put the sound out of step with the picture).
      if (s.kind === "video") setEffect((e) => (e.kind === "pace" ? defaultEffect("pitch") : e));
      setResultId(null);
      setVideoId(null);
      setTranscriptId(null);
      setPicked(new Set());
      setEdits({});
      setHanded(given?.length ? given : null);
      setFocus(given?.length ? (line ?? null) : null);
    },
    [],
  );
  useArrival(take);
  const clear = () => {
    setSource(null);
    setHanded(null);
    setEdits({});
    setTranscriptId(null);
    setResultId(null);
    setVideoId(null);
    setPicked(new Set());
  };

  // A finished transcript with no lines: said once.
  useEffect(() => {
    if (t?.status === "succeeded" && !cuesOf(t)?.length) toast("No speech found in this recording");
  }, [t]);
  // A handed-over line: scrolled into view and focused.
  useEffect(() => {
    if (focus === null) return;
    const el = document.querySelector<HTMLTextAreaElement>(`[data-line="${focus}"] textarea`);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  }, [focus, cues]);

  const ready = source && !source.uploading && source.ref ? source : null;
  const changes = cues ? texts.filter((x, i) => x.trim() !== cues[i]?.text.trim()).length : 0;
  const range = useMemo(() => {
    if (!cues || !picked.size) return null;
    const idx = [...picked].sort((a, b) => a - b);
    return { start: cues[idx[0]].start, end: cues[idx[idx.length - 1]].end };
  }, [cues, picked]);
  const body: AudioToolBody | null = useMemo(() => {
    if (!ready || !cues?.length) return null;
    const base = { tool: "speech-edit" as const, engine, media: ready.ref, kind: ready.kind, name: baseName(ready), cues, quality, ...(ready.duration && { sourceDuration: ready.duration }) };
    if (view === "words") return changes ? { ...base, edited: texts } : null;
    return range ? { ...base, range, effect } : null;
  }, [ready, cues, texts, changes, view, range, effect, engine, quality]);
  const preview = useAudioToolPreview(useSettled(engine === "open" ? body : null, 500));
  const p = preview.data;
  const error = preview.error ? (preview.error as Error).message : null;
  const cloudProblem = mode === "cloud" ? CLOUD_ONLY_SPEECH_EDIT_PROBLEM : CLOUD_SPEECH_EDIT_PROBLEM;
  const blocker = !source
    ? "Add a recording"
    : source.uploading
      ? "Uploading…"
      : engine === "cloud"
        ? cloudProblem
        : !cues
          ? "Transcribe it first"
          : view === "words" && !changes
            ? "Change the words of a line"
            : view === "sound" && !range
              ? "Tick the lines to change"
              : null;
  const g = result.data;
  const busy = run.isPending || g?.status === "queued" || g?.status === "running" || onVideo.data?.status === "queued" || onVideo.data?.status === "running";
  const transcribing = create.isPending || t?.status === "queued" || t?.status === "running";

  const transcribe = () => {
    if (!ready || !press(item)) return;
    create.mutate(
      { feature: SPEECH_EDIT_FEATURE, modelId: "oss-qwen3-asr", engine: "open", op: "transcribe", inputs: ready.kind === "video" ? { video: ready.ref } : { audio: ready.ref }, title: `Transcript · ${baseName(ready)}` },
      { onSuccess: (items) => setTranscriptId(items[0]?.id ?? null), onError: (e) => toastError(e) },
    );
  };
  const go = () => {
    if (blocker) return void toast(blocker);
    if (error) return void toast.error(error);
    if (!press(item)) return;
    run.mutate(body!, {
      onSuccess: (r) => {
        const edit = r.items.find((x) => x.op === "speech-edit") ?? r.result;
        setResultId(edit.id);
        setVideoId(r.items.find((x) => x.op === "mux")?.id ?? null);
        toast.success("Editing the speech on your GPU");
      },
      onError: (e) => toastError(e),
    });
  };
  const out = g?.status === "succeeded" ? audioOf(g) : undefined;
  const clip = onVideo.data?.status === "succeeded" ? videoOf(onVideo.data) : undefined;
  const warning = p && source?.kind === "video" ? p.notes.find((n) => /Lipsync/.test(n)) : undefined;

  return (
    <ToolShell title="Audio">
      {!source && (
        <ToolHero title="Edit speech" subtitle={SUBTITLE}>
          {hydrated && visitor && <OwnSetupChip setup={item} short={false} className="mt-3" />}
        </ToolHero>
      )}
      <div className={cn("mx-auto max-w-[860px] space-y-3", source ? "pt-4" : "mt-6")}>
        {!source ? (
          <AddMedia onPick={(s) => take(s)} onUpdate={setSource} />
        ) : (
          <SourcePanel source={source} onDuration={(duration) => setSource((s) => (s ? { ...s, duration } : s))} onRemove={clear} />
        )}
        {source && engine === "cloud" && (
          <Panel>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">Edit speech runs on your GPU (open source).</span>{" "}
                {mode === "cloud" ? "This install is set to paid cloud APIs only (Settings → Engine mode), and AuK isn't hosted on fal or Replicate." : "AuK isn't hosted on fal or Replicate, so the cloud engine can't change what was said."}
              </p>
              {mode === "both" ? (
                <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={() => setEngine("open")}>
                  <Cpu className="size-3.5" /> Use open source
                </Button>
              ) : null}
            </div>
          </Panel>
        )}
        {source && engine === "open" && !cues && (
          <Panel title="1 · Transcribe">
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">Fuobe writes down what was said, line by line, so you can change it like text. Free on your GPU.</p>
              <Button className="rounded-full" onClick={transcribe} disabled={!ready || transcribing}>
                {transcribing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Transcribe
              </Button>
            </div>
            {t?.status === "failed" && (
              <p className="mt-2 text-[13px] text-destructive" role="alert">
                {t.error ?? "Transcribing failed"}
              </p>
            )}
          </Panel>
        )}
        {source && engine === "open" && cues && (
          <Panel
            title="2 · Change it"
            aside={<Segmented label="What to change" value={view} onChange={setView} options={[{ value: "words", label: "Words" }, { value: "sound", label: "How it sounds" }]} />}
          >
            <p className="mb-2 text-[12px] text-muted-foreground">
              {view === "words"
                ? "Edit a line's words: replace, add or remove a few. Only the changed part is re-spoken, with a second of the recording around it, in the same voice."
                : "Tick the lines to change, then pick what to do to them."}
            </p>
            {view === "sound" && (
              <div className="mb-3 space-y-2 rounded-xl bg-muted/50 p-2.5">
                <Segmented label="Effect" value={effect.kind} onChange={(k) => setEffect(defaultEffect(k))} options={EFFECTS.filter((k) => k !== "pace" || source.kind !== "video").map((k) => ({ value: k, label: EFFECT_LABELS[k] }))} />
                <EffectOptions effect={effect} onChange={setEffect} />
              </div>
            )}
            <ol className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">
              {cues.map((c, i) => (
                <Line
                  key={i}
                  cue={c}
                  index={i}
                  text={texts[i] ?? c.text}
                  mode={view}
                  picked={picked.has(i)}
                  onText={(x) => setEdits((all) => ({ ...all, [i]: x }))}
                  onPick={(v) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (v) n.add(i);
                      else n.delete(i);
                      return n;
                    })
                  }
                />
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="w-16 shrink-0 text-[13px]">Quality</span>
              <Segmented label="Quality" value={quality} onChange={setQuality} options={(["fast", "best"] as const).map((q) => ({ value: q, label: AUK_SETTINGS[q].label }))} />
              <span className="text-[12px] text-muted-foreground">{QUALITY_HINTS[quality]}</span>
            </div>
          </Panel>
        )}
        {source && (
          <div className="space-y-2">
            {!blocker && !error && p && (
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
                {engine === "cloud" ? (
                  mode === "cloud" ? (
                    "Not available on this install: it is set to paid cloud APIs only"
                  ) : (
                    "Switch to the open engine to edit speech"
                  )
                ) : blocker ? (
                  blocker
                ) : error ? (
                  error
                ) : p ? (
                  <>
                    <span className="font-mono text-foreground">{p.demo ? "Demo · free" : "Free · runs on your GPU"}</span>
                    {view === "words" ? ` · ${changes} line${changes === 1 ? "" : "s"} changed` : ""}
                  </>
                ) : (
                  "Checking…"
                )}
              </p>
              <Button size="lg" className={cn("rounded-full", (blocker || error) && "bg-muted text-subtle-foreground hover:bg-muted")} onClick={go} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Edit speech
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              {PROMPT_HELPER_NOTE} AuK understands {AUK_LANGUAGES.join(" and ")}. Only change recordings of your own voice, or of someone who agreed to it.
            </p>
          </div>
        )}
        {g && (g.status === "queued" || g.status === "running") && (
          <Panel>
            <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" /> {g.message ?? "Re-speaking the changed parts"}…{g.progress ? ` ${Math.round(g.progress * 100)}%` : ""}
            </p>
          </Panel>
        )}
        {g?.status === "failed" && (
          <p className="text-[13px] text-destructive" role="alert">
            {g.error ?? "Editing failed"}
          </p>
        )}
        {source && out && (
          <Panel title="Original and edited">
            <BeforeAfterAudio key={out.url} before={source.preview} after={out.url} labels={{ before: "Original", after: "Edited" }} />
            {warning && <p className="mt-2 text-[12px] text-muted-foreground">{warning}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" asChild>
                <a href={downloadHref(out.url, `${baseName(source)} · edited.flac`)} download>
                  <Download className="size-3.5" /> Download
                </a>
              </Button>
              {clip ? (
                <>
                  <Button variant="outline" size="sm" className="rounded-full" asChild>
                    <a href={downloadHref(clip.url, `${baseName(source)} · edited.mp4`)} download>
                      <Clapperboard className="size-3.5" /> Download the video
                    </a>
                  </Button>
                  {warning && (
                    <Button size="sm" className="rounded-full" asChild>
                      <Link href={`/lipsync?video=${encodeURIComponent(source.ref)}&audio=${encodeURIComponent(out.url)}`}>
                        <Mic2 className="size-3.5" /> Lipsync it
                      </Link>
                    </Button>
                  )}
                </>
              ) : source.kind === "video" && onVideo.data && onVideo.data.status !== "failed" ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Putting the new sound on the video…
                </span>
              ) : null}
            </div>
          </Panel>
        )}
      </div>
      <Results />
    </ToolShell>
  );
}

/** Earlier edits (and their videos). */
function Results() {
  const items = useGenerations({ features: [SPEECH_EDIT_FEATURE], limit: 12 }).data?.filter((g) => g.op !== "transcribe") ?? [];
  if (!items.length) return null;
  return (
    <section className="mx-auto mt-10 max-w-[1040px]" aria-labelledby="speech-edit-results">
      <h3 id="speech-edit-results" className="mb-3 font-heading text-[22px]">
        Your edited speech
      </h3>
      <Feed items={items} />
    </section>
  );
}
