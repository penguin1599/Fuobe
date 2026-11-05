"use client";

import { ArrowLeft, AudioLines, ChevronRight, Cloud, Cpu, Download, Languages, Loader2, Mic2, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { SlotValue } from "@/components/studio/media-slot";
import { CueEditor, useCueEditor } from "@/components/av/cue-editor";
import { PlaceholderChip } from "@/components/demo-mode";
import { SourceLanguageSelect, TargetLanguages } from "@/components/av/language-picker";
import { MediaDrop } from "@/components/av/media-drop";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { CONNECT_GPU_EVENT, useEngine, useIsOwner, useModelAccess, useStatus, type ConnectGpuDetail } from "@/lib/api";
import { isPlaceholder } from "@/lib/demo-mode";
import { keepOffered, offered } from "@/lib/model-access";
import { cueProblems } from "@/lib/av/cue-edit";
import {
  BACKGROUND_DB,
  crowdedLines,
  DBS_OPEN_ONLY_NOTE,
  DEFAULT_VOICE_SPLIT,
  dubResult,
  languageStage,
  MUSIC_MODEL_NOTE,
  ONE_SHOT_MODELS,
  priceLine,
  reviewCues,
  stepsNeedGpu,
  takeLines,
  translateKey,
  VOICE_SPLIT_IDS,
  VOICE_SPLITS,
  voiceOnly,
  type DubPrice,
  type DubSessionView,
  type DubStage,
  type OneShotModel,
  type VoiceSplit,
} from "@/lib/av/dub";
import { languageByCode, supportsTarget, type DubRoute } from "@/lib/av/languages";
import type { Cue } from "@/lib/cues";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { useDubActions, useDubPrice, useDubSessions, useVoicePrice } from "./hooks";

const ONE_SHOT: Record<OneShotModel, { name: string; note: string }> = {
  "heygen-translate": { name: "HeyGen Translate", note: "Lip-synced, 170+ languages and accents · ≈ $0.10 per second" },
  "heygen-translate-fast": { name: "HeyGen Translate Speed", note: "Faster and cheaper, lip-synced · ≈ $0.05 per second" },
  "elevenlabs-dubbing": { name: "ElevenLabs Dubbing", note: "Keeps each speaker's voice, no lip re-sync · ≈ $0.60 per minute" },
};

// The Voice split menu (open engine): what each one does to the soundtrack.
const SPLIT_LABEL: Record<VoiceSplit, string> = { dbs: "Keep music and effects", melband: "Standard" };

const ROUTE_LINE = {
  open: (split: VoiceSplit) =>
    `We separate the voice${split === "dbs" ? " from the music and effects" : ""}, translate every line for your review, speak it in the same voice and re-sync the lips.`,
  // A signed-in account's translations run on its own GPU (Qwen3.5 4B): src/server/dub.ts planDub.
  cloud: (owner: boolean) =>
    `Cloud: ElevenLabs isolates the voice and Demucs lifts out the music and effects → Scribe v2 times the voice → ${owner ? "Claude (or a local model)" : "Qwen3.5 on your GPU"} translates → you review → ElevenLabs speaks each line at its time and Chatterbox turns it into the speaker's voice → Sync Lipsync 3 → mixed back over the music and effects.`,
};

const STAGE: Record<DubStage, { label: string; tone: string }> = {
  preparing: { label: "Translating", tone: "bg-muted text-muted-foreground" },
  // Solid in both themes: dark text on a translucent yellow over the dark page was unreadable.
  review: { label: "Ready to review", tone: "bg-highlight text-highlight-foreground" },
  voicing: { label: "Voicing", tone: "bg-brand-faint text-brand-text" },
  done: { label: "Done", tone: "bg-success/15 text-foreground" },
  failed: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
};

function StageBadge({ stage }: { stage: DubStage }) {
  const s = STAGE[stage];
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", s.tone)}>{s.label}</span>;
}

/** Translate & dub (Audio → Translate): a new dub, the dubs in progress and, opened, one dub's review. */
export function DubStudio() {
  const sessions = useDubSessions();
  const [openId, setOpenId] = useState<string | null>(null);
  // Hand-off: /audio/translate?dub=<id> opens that dub (Assist and MCP link the dubs they start).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("dub");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration (no Suspense boundary needed)
    if (id) setOpenId(id);
  }, []);
  // The open dub is in the address, so a reload or a shared link comes back to it.
  const show = (id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("dub", id);
    else url.searchParams.delete("dub");
    window.history.replaceState(null, "", url);
  };
  // A dub removed elsewhere (another tab) just closes.
  const open = sessions.data?.find((s) => s.id === openId);
  return (
    <ToolShell title="Audio">
      {open ? (
        <SessionView key={open.id} s={open} onBack={() => show(null)} />
      ) : openId && sessions.isLoading ? (
        <div className="mx-auto max-w-[760px] space-y-3 pt-4" aria-label="Opening the dub">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="aspect-video w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <NewDub onStarted={show} />
          <RecentDubs sessions={sessions.data} loading={sessions.isLoading} onOpen={show} />
        </>
      )}
    </ToolShell>
  );
}

function NewDub({ onStarted }: { onStarted: (id: string) => void }) {
  const [engine, setEngine, engineMode] = useEngine();
  // The note about DBS on your GPU is for the studio's own install with both engines.
  const owner = useIsOwner();
  const { create } = useDubActions();
  const [video, setVideo] = useState<SlotValue | null>(null);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  // An account with its key and no GPU starts on One shot: the review's translation runs on its GPU (stepsNeedGpu).
  const keyOnly = stepsNeedGpu(useStatus().data?.viewer);
  const cloudOffered = engineMode !== "open";
  const [pickedMode, setMode] = useState<"steps" | "oneshot" | null>(null);
  const mode = pickedMode ?? (keyOnly && cloudOffered ? "oneshot" : "steps");
  const [picked, setModel] = useState<OneShotModel>("heygen-translate");
  // One-shot dubbing models switched off in Settings → Models & licences leave the menu; the pick falls back to one that is on.
  const access = useModelAccess();
  const oneShotModels = keepOffered(ONE_SHOT_MODELS, (m) => offered(access, m, "cloud"));
  const model: OneShotModel = oneShotModels.includes(picked) ? picked : oneShotModels[0];
  // The open engine's voice split: MelBand RoFormer (the default until the separation evaluation says otherwise) or DBS,
  // either one left out when it's switched off in Settings → Models & licences.
  const [pickedSplit, setSplit] = useState<VoiceSplit>(DEFAULT_VOICE_SPLIT);
  const splits = keepOffered(VOICE_SPLIT_IDS, (k) => offered(access, VOICE_SPLITS[k].modelId, "open"));
  const split: VoiceSplit = splits.includes(pickedSplit) ? pickedSplit : splits[0];
  const [source, setSource] = useState("auto");
  const [targets, setTargets] = useState<string[]>(["es"]);
  const oneShot = mode === "oneshot" && engine === "cloud";
  const route: DubRoute = oneShot ? model : engine === "open" ? "open" : "cloud-steps";
  const usable = targets.filter((c) => {
    const l = languageByCode(c);
    return l && supportsTarget(route, l);
  });
  // "Review the script first" for that account: One shot on its key, or its GPU connected, instead of a Translate that can't run.
  const needsGpu = keyOnly && !oneShot;
  const pickOneShot = () => {
    if (engine === "open") setEngine("cloud");
    setMode("oneshot");
  };
  const connectGpu = () => window.dispatchEvent(new CustomEvent<ConnectGpuDetail>(CONNECT_GPU_EVENT, { detail: { gpuOnly: true, needs: "gpu" } }));
  const blocker = !video ? "Add the video to translate" : video.uploading ? "Uploading…" : !usable.length ? "Pick a language to dub into" : null;
  const body =
    video && !video.uploading && usable.length && !needsGpu
      ? { engine, mode: oneShot ? ("oneshot" as const) : ("steps" as const), model: oneShot ? model : undefined, video: video.ref, source, targets: usable, duration, ...(engine === "open" && { voiceSplit: split }) }
      : null;
  const price = useDubPrice(body);
  const start = () => {
    if (blocker || !body) return void toast(blocker, { id: "dub-blocker" });
    create.mutate(
      { ...body, title: video!.name?.replace(/\.[a-z0-9]+$/i, "") },
      {
        onSuccess: (s) => {
          toast.success(oneShot ? `Dubbing into ${usable.length} language${usable.length === 1 ? "" : "s"}` : "Transcribing and translating");
          setVideo(null);
          setDuration(undefined);
          onStarted(s.id);
        },
        onError: (e) => toastError(e),
      },
    );
  };
  return (
    <div className="pb-10">
      <ToolHero title="Speak every language" subtitle="Translate the speech, keep the speaker's voice and re-sync the lips. Review every line before it's spoken." />
      <div className="mx-auto mt-8 max-w-[760px] space-y-3">
        {/* A guest is asked to sign up before a video is added, and an account with nothing to run on to connect its GPU. */}
        <div>
          <MediaDrop
            kind="video"
            value={video}
            onChange={(v) => {
              setVideo(v);
              if (!v) setDuration(undefined);
            }}
            onDuration={setDuration}
            title="Add the video to translate"
            hint="MP4, MOV or WebM up to 200 MB · one clear speaker works best"
            compact
          />
        </div>
        <Panel title="How">
          <div role="radiogroup" aria-label="How to dub" className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              on={!oneShot}
              icon={<Languages className="size-4" />}
              title="Review the script first"
              onClick={() => setMode("steps")}
              note={
                keyOnly
                  ? "Transcribe and translate, edit every line, then voice it. The translation runs on your GPU."
                  : engineMode === "open"
                    ? "Transcribe and translate, edit every line, then voice it."
                    : "Transcribe and translate, edit every line, then voice it. Cloud and open source."
              }
            />
            {/* One shot is cloud only: an open-source-only studio doesn't offer it (nobody here can switch the engine). */}
            {engineMode !== "open" && (
              <ModeCard
                on={oneShot}
                disabled={engine === "open"}
                icon={<Wand2 className="size-4" />}
                title="One shot"
                onClick={() => setMode("oneshot")}
                note={engine === "open" ? "Cloud only — switch the engine to Cloud" : "HeyGen or ElevenLabs dub the whole video in one go."}
              />
            )}
          </div>
          {oneShot && (
            <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <Label htmlFor="dub-model" className="text-[13px] sm:w-32">
                Model
              </Label>
              <Select value={model} onValueChange={(v) => setModel(v as OneShotModel)}>
                <SelectTrigger id="dub-model" className="h-9 w-full rounded-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {oneShotModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {ONE_SHOT[m].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[12px] text-muted-foreground sm:ml-2">{ONE_SHOT[model].note}</p>
            </div>
          )}
          {!oneShot && engine === "open" && (
            <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-start">
              {/* A label points at the Select; with one split left, the name beside it is plain text. */}
              <Label htmlFor={splits.length > 1 ? "dub-split" : undefined} className="text-[13px] sm:w-32 sm:pt-2">
                Voice split
              </Label>
              <div className="min-w-0 flex-1">
                {splits.length > 1 ? (
                  <Select value={split} onValueChange={(v) => setSplit(v as VoiceSplit)}>
                    <SelectTrigger id="dub-split" className="h-9 w-full rounded-full sm:w-auto sm:min-w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {splits.map((k) => (
                        <SelectItem key={k} value={k}>
                          {SPLIT_LABEL[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="pt-1.5 text-[13px] font-medium">
                    {SPLIT_LABEL[split]}
                  </p>
                )}
                <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">{VOICE_SPLITS[split].note}.</p>
              </div>
            </div>
          )}
          {/* The cloud splits the music and effects with Demucs. */}
          {!oneShot && engine === "cloud" && (
            <div className="mt-3 space-y-1 text-[12px] leading-snug text-muted-foreground">
              <p>Music and effects: Demucs. {MUSIC_MODEL_NOTE}.</p>
              {/* The note about your GPU is for the studio's own install with both engines, not a guest or an account. */}
              {owner && engineMode === "both" && <p>{DBS_OPEN_ONLY_NOTE}.</p>}
            </div>
          )}
        </Panel>
        <Panel title="Languages">
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <Label htmlFor="dub-source" className="text-[13px] sm:w-32">
                Spoken language
              </Label>
              <SourceLanguageSelect id="dub-source" value={source} onChange={setSource} />
            </div>
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
              <span className="pt-1.5 text-[13px] font-medium sm:w-32">Translate into</span>
              <div className="min-w-0 flex-1">
                <TargetLanguages
                  value={targets}
                  onChange={setTargets}
                  available={(l) => supportsTarget(route, l)}
                  unavailableHint={route === "open" ? "Chatterbox doesn't speak this one yet" : "This model doesn't offer it"}
                />
                {targets.length > usable.length && <p className="mt-1.5 text-[12px] text-muted-foreground">Crossed-out languages aren&apos;t available on this route and will be skipped.</p>}
              </div>
            </div>
          </div>
        </Panel>
        {needsGpu ? (
          <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
            <p className="flex-1 text-[12px] leading-relaxed text-muted-foreground">
              {cloudOffered ? "Reviewing the script translates every line on your GPU. On your key, One shot dubs the whole video in one go." : "Reviewing the script translates every line on your GPU."}
            </p>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
              <Button size="lg" variant={cloudOffered ? "outline" : "default"} className="shrink-0 rounded-full" onClick={connectGpu}>
                <Cpu className="size-4" />
                Connect your GPU
              </Button>
              {cloudOffered && (
                <Button size="lg" className="shrink-0 rounded-full" onClick={pickOneShot}>
                  <Wand2 className="size-4" />
                  Use One shot
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
            <p className="flex-1 text-[12px] leading-relaxed text-muted-foreground">
              {oneShot ? `${ONE_SHOT[model].name} returns the finished video for each language.` : engine === "open" ? ROUTE_LINE.open(split) : ROUTE_LINE.cloud(owner)}
            </p>
            <div className="flex shrink-0 items-center gap-3 self-end sm:self-auto">
              <PriceNote price={price.data} loading={price.isFetching && !price.data} error={price.error as Error | null} hint={oneShot ? undefined : "Translating costs little; you'll see the voice's price before it speaks"} />
              <Button size="lg" className={cn("shrink-0 rounded-full", blocker && "bg-muted text-muted-foreground hover:bg-muted")} onClick={start} disabled={create.isPending} aria-describedby={blocker ? "dub-blocker" : undefined}>
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {oneShot ? "Dub it" : "Translate"}
              </Button>
            </div>
          </div>
        )}
        {blocker && (
          <p id="dub-blocker" className="sr-only">
            {blocker}
          </p>
        )}
      </div>
    </div>
  );
}

/** The price of the next step, next to its button: "≈ $8.13 + ElevenLabs v4", "Placeholder · free", "Free on your GPU". */
function PriceNote({ price, loading, error, hint }: { price?: DubPrice; loading?: boolean; error?: Error | null; hint?: string }) {
  if (loading) return <Skeleton className="h-4 w-20" aria-label="Pricing" />;
  if (error) return <span className="max-w-[16rem] text-right text-[12px] leading-snug text-muted-foreground">{error.message}</span>;
  if (!price) return null;
  const extra = price.unpriced.length ? `${price.unpriced.join(" and ")} bill${price.unpriced.length === 1 ? "s" : ""} by the provider's own rate (per character or token).` : undefined;
  return (
    <span className="text-right text-[12px] leading-snug" title={[extra, hint].filter(Boolean).join(" ") || undefined}>
      <span className="font-medium tabular-nums">{priceLine(price)}</span>
      {price.steps > 1 && <span className="block text-muted-foreground">{price.steps} steps</span>}
    </span>
  );
}

function ModeCard({ on, disabled, icon, title, note, onClick }: { on: boolean; disabled?: boolean; icon: React.ReactNode; title: string; note: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
        on ? "border-primary bg-brand-faint" : "hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
    >
      <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{note}</span>
      </span>
    </button>
  );
}

function RecentDubs({ sessions, loading, onOpen }: { sessions?: DubSessionView[]; loading: boolean; onOpen: (id: string) => void }) {
  if (loading)
    return (
      <div className="mx-auto max-w-[760px] space-y-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-16 w-full rounded-2xl" />
      </div>
    );
  if (!sessions?.length) return null;
  return (
    <section className="mx-auto max-w-[760px]" aria-labelledby="recent-dubs">
      <h3 id="recent-dubs" className="mb-2 font-heading text-[22px]">
        Your dubs
      </h3>
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onOpen(s.id)} className="flex w-full min-w-0 items-center gap-3 rounded-2xl border bg-background p-3 text-left transition-colors hover:bg-accent">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-text">{s.engine === "open" ? <Cpu className="size-4" /> : <Cloud className="size-4" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{s.title}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {s.targets.map((c) => (
                    <span key={c} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                      {languageByCode(c)?.name ?? c} <StageBadge stage={languageStage(s, c)} />
                    </span>
                  ))}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PREPARE_LABEL: Record<string, string> = { stems: "Voice, background and transcript", voice: "Clean voice", words: "Transcript", sound: "Original sound", background: "Music and effects" };

function prepareRows(s: DubSessionView, lang: string): StepRow[] {
  // Older open dubs transcribed in a step of their own.
  const keys = Object.keys(s.prepare ?? {}).filter((k) => !k.startsWith("translate:"));
  const label = (k: string) => (k === "stems" && keys.includes("words") ? "Voice and background" : (PREPARE_LABEL[k] ?? k));
  return [...keys.map((k) => ({ key: k, label: label(k), g: s.generations[s.prepare![k]] })), { key: "t", label: `Translate into ${languageByCode(lang)?.name ?? lang}`, g: s.generations[s.prepare?.[translateKey(lang)] ?? ""] }];
}

function voiceRows(s: DubSessionView, lang: string): StepRow[] {
  const run = s.voices?.[lang]?.at(-1);
  if (!run) return [];
  const open = s.engine === "open";
  const label: Record<string, string> = {
    speech: open ? "Speech in their voice" : "Speech",
    track: "Placed at each line's time",
    soundtrack: "Voice track",
    clone: "Their voice",
    lips: "Lips re-synced",
    mix: "Over the music and effects",
    // Older cloud dubs (and cloud dubs with no background) re-synced the lips as their last step.
    film: run.lipsync && !run.ids.lips ? "Lips re-synced" : "Dubbed video",
  };
  const entries = Object.entries(run.ids);
  const lines = entries.filter(([k]) => k.startsWith("line:")).map(([, id]) => s.generations[id]);
  const beds = entries.filter(([k]) => k.startsWith("bed:")).map(([, id]) => s.generations[id]);
  const rows: StepRow[] = [];
  // One row for the takes: a dub of 30 lines would otherwise list 30 near-identical steps.
  if (lines.length) rows.push({ key: "lines", label: `${lines.length} line${lines.length === 1 ? "" : "s"} ${open ? "in their voice" : "spoken"}`, group: lines });
  // And one for the background stems, each lowered a little before the mix.
  if (beds.length) rows.push({ key: "beds", label: `Music and effects ${Math.abs(BACKGROUND_DB)} dB lower`, group: beds });
  for (const [k, id] of entries) if (!k.startsWith("line:") && !k.startsWith("bed:")) rows.push({ key: k, label: label[k] ?? k, g: s.generations[id] });
  return rows;
}

function SessionView({ s, onBack }: { s: DubSessionView; onBack: () => void }) {
  const { remove } = useDubActions();
  const [lang, setLang] = useState(s.targets[0]);
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState<number | undefined>(undefined);
  const stage = languageStage(s, lang);
  const result = dubResult(s, lang);
  return (
    <div className="pt-4 pb-10">
      <div className="mb-4 flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 rounded-full" onClick={onBack}>
          <ArrowLeft className="size-4" /> All dubs
        </Button>
        <h2 className="min-w-0 flex-1 truncate font-heading text-[22px] leading-tight">{s.title}</h2>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Remove this dub">
              <Trash2 className="size-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this dub?</AlertDialogTitle>
              <AlertDialogDescription>Steps still running are stopped, and the review leaves this list. The videos and audio it already made stay in your Library.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  remove.mutate(s.id, {
                    onSuccess: () => {
                      toast("Dub removed");
                      onBack();
                    },
                    onError: (e) => toastError(e),
                  })
                }
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <TabRow role="tablist" aria-label="Languages" follow className="mb-3">
        {s.targets.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={c === lang}
            onClick={() => setLang(c)}
            className={TAB_PILL}
            {...onAttr(c === lang)}
          >
            {languageByCode(c)?.name ?? c}
            <span className={cn("size-1.5 rounded-full", { preparing: "bg-subtle-foreground", review: "bg-highlight", voicing: "bg-primary", done: "bg-success", failed: "bg-destructive" }[languageStage(s, c)])} />
          </button>
        ))}
      </TabRow>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="space-y-3 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)] lg:self-start">
          <div className="overflow-hidden rounded-2xl border bg-media">
            <video ref={video} src={s.video} controls playsInline preload="metadata" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} className="max-h-[42vh] w-full object-contain" />
          </div>
          <p className="text-[12px] text-muted-foreground">Original · {s.source === "auto" ? "language detected" : (languageByCode(s.source)?.name ?? s.source)}</p>
          {result && <ResultCard s={s} lang={lang} />}
        </div>
        <div className="min-w-0 space-y-3">
          {s.mode === "oneshot" ? (
            <Panel title={`Dub into ${languageByCode(lang)?.name ?? lang}`} aside={<StageBadge stage={stage} />}>
              <StepList steps={[{ key: "dub", label: "Translated and voiced in one go", g: s.generations[s.oneshot?.[lang] ?? ""] }]} />
            </Panel>
          ) : (
            <>
              <Panel title="Translation" aside={<StageBadge stage={stage} />}>
                <StepList steps={prepareRows(s, lang)} />
              </Panel>
              {stage === "preparing" ? (
                <Panel>
                  <p className="text-[13px] text-muted-foreground">Transcribing and translating. You&apos;ll review every line here before anything is spoken.</p>
                </Panel>
              ) : stage === "failed" && !s.voices?.[lang]?.length ? (
                <Panel>
                  <p className="text-[13px] text-muted-foreground">A step failed (see above). Start a new dub to try again — check the clip has clear speech.</p>
                </Panel>
              ) : (
                <Review
                  key={`${s.id}:${lang}`}
                  s={s}
                  lang={lang}
                  time={time}
                  onSeek={(t) => {
                    if (video.current) video.current.currentTime = t;
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ s, lang }: { s: DubSessionView; lang: string }) {
  const g = dubResult(s, lang)!;
  const out = g.outputs.find((o) => o.kind === "video");
  if (!out) return null;
  const name = `${s.title} · ${languageByCode(lang)?.name ?? lang}.mp4`;
  return (
    <Panel
      title={`Dubbed · ${languageByCode(lang)?.name ?? lang}`}
      aside={
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <a href={out.url} download={name}>
            <Download className="size-3.5" /> Download
          </a>
        </Button>
      }
    >
      <video src={out.url} controls playsInline preload="metadata" className="max-h-[42vh] w-full rounded-xl bg-media object-contain" />
      {isPlaceholder(g) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <PlaceholderChip g={g} />
          <span>A stand-in, not a real dub.</span>
        </div>
      )}
      {voiceOnly(s) && <p className="mt-2 text-[12px] text-muted-foreground">Voice only: no music or effects were separated from this clip, so the new voice plays alone.</p>}
    </Panel>
  );
}

function Review({ s, lang, time, onSeek }: { s: DubSessionView; lang: string; time?: number; onSeek: (t: number) => void }) {
  const { saveDraft, voice } = useDubActions();
  const initial = useMemo(() => reviewCues(s, lang) ?? [], [s, lang]);
  const editor = useCueEditor(initial);
  const [lipsync, setLipsync] = useState(true);
  const stage = languageStage(s, lang);
  const runs = s.voices?.[lang] ?? [];
  // Autosave the reviewed lines shortly after the last edit (the video's time updates don't restart the wait).
  const [savedBody, setSavedBody] = useState(() => JSON.stringify(initial));
  const cues = editor.cues;
  const save = useRef(saveDraft.mutate);
  const body = JSON.stringify(cues);
  // What's on screen vs. what the server has, for the flush when this review closes.
  const pending = useRef({ body, savedBody, id: s.id, lang });
  useEffect(() => {
    save.current = saveDraft.mutate;
    pending.current = { body, savedBody, id: s.id, lang };
  });
  const dirty = body !== savedBody;
  useEffect(() => {
    if (body === savedBody) return;
    const t = setTimeout(() => {
      setSavedBody(body);
      save.current({ id: s.id, lang, cues: JSON.parse(body) as Cue[] }, { onError: (e) => toastError(e) });
    }, 800);
    return () => clearTimeout(t);
  }, [body, savedBody, s.id, lang]);
  // Edits made just before switching language, going back to all dubs or leaving the page are saved right away.
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      const p = pending.current;
      if (p.body === p.savedBody) return;
      pending.current = { ...p, savedBody: p.body };
      if (keepalive) void fetch(`/api/dub/${p.id}`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: p.lang, cues: JSON.parse(p.body) }) });
      else save.current({ id: p.id, lang: p.lang, cues: JSON.parse(p.body) as Cue[] });
    };
    const leave = () => flush(true);
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      flush(false);
    };
  }, []);
  const problems = cueProblems(cues);
  const crowded = useMemo(() => crowdedLines(cues, s.duration), [cues, s.duration]);
  const price = useVoicePrice(s.id, lang, lipsync, cues, stage !== "preparing" && !problems.length);
  const name = languageByCode(lang)?.name ?? lang;
  const start = (c: Cue[]) =>
    voice.mutate(
      { id: s.id, lang, cues: c, lipsync },
      { onSuccess: () => toast.success(`Voicing ${name}`), onError: (e) => toastError(e) },
    );
  return (
    <>
      <Panel
        title={`Review · ${name}`}
        aside={<span className="text-[12px] text-muted-foreground">{saveDraft.isPending || dirty ? "Saving…" : "Saved"}</span>}
      >
        <CueEditor editor={editor} currentTime={time} onSeek={onSeek} className="max-h-[56vh]" emptyHint="The translation has no lines." />
        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          Each line is spoken at its start time, so pauses stay where they were; a line that runs past the next one is cut there.
          {crowded.length > 0 && (
            <>
              {" "}
              <span className="font-medium text-foreground">
                {crowded.length === 1
                  ? `${takeLines(crowded[0]).replace(/^l/, "L")}${crowded[0].first === crowded[0].last ? " looks" : " (spoken as one take) look"} long for the time before the next line`
                  : `${crowded.length} takes look long for their time (${crowded.slice(0, 4).map(takeLines).join(", ")}${crowded.length > 4 ? "…" : ""})`}
              </span>{" "}
              — shorten the words or start the next line later.
            </>
          )}
        </p>
      </Panel>
      <Panel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2">
            <Switch id={`lips-${lang}`} checked={lipsync} onCheckedChange={setLipsync} />
            <Label htmlFor={`lips-${lang}`} className="text-[13px]">
              Re-sync the lips
            </Label>
            <span className="text-[12px] text-muted-foreground">{s.engine === "open" ? "InfiniteTalk · up to 40 s" : "Sync Lipsync 3 · $8 per minute"}</span>
          </div>
          <div className="flex items-center gap-3 self-end sm:self-auto">
            <PriceNote price={price.data} loading={price.isFetching && !price.data} error={price.error as Error | null} />
            <Button
              className={cn("rounded-full", problems.length && "bg-muted text-muted-foreground hover:bg-muted")}
              disabled={voice.isPending || stage === "voicing"}
              onClick={() => (problems.length ? toast(problems[0], { id: "dub-blocker" }) : start(cues))}
            >
              {voice.isPending || stage === "voicing" ? <Loader2 className="size-4 animate-spin" /> : runs.length ? <Mic2 className="size-4" /> : <AudioLines className="size-4" />}
              {stage === "voicing" ? "Voicing…" : runs.length ? "Voice again" : `Voice it in ${name}`}
            </Button>
          </div>
        </div>
        {voiceOnly(s) && <p className="mt-3 text-[12px] text-muted-foreground">No music or effects were separated from this clip, so the new voice will play alone.</p>}
        {runs.length > 0 && <StepList steps={voiceRows(s, lang)} className="mt-4" />}
      </Panel>
    </>
  );
}

