"use client";

import { ArrowLeft, Download, Film, ImagePlus, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, ToolShell } from "@/components/av/tool-shell";
import { tabKeys } from "@/components/shorts/ui";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { uploadFile, useAskBeforeUpload } from "@/lib/api";
import { limitMb, useClipLimit } from "@/lib/clip-limit";
import { postFileWithProgress } from "@/lib/upload";
import { clipExtension, clipNeedsPreview, clipProblem, jobState, MODE_LABELS, pageClip, secondsLabel, SWAP_STUDIO, type GenSummary, type StudioEstimate, type SwapClip, type SwapProject, type SwapShot } from "@/lib/catalog/swap-studio";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { decisionsHref, useAddClip, usePrepareClip, useSwapEdit, useSwapEstimate, useSwapProject, type EditInput } from "./hooks";
import { GenChip, JobError, Note, priceText, SavedText } from "./parts";
import { AnchorsStage } from "./stage-anchors";
import { AssembleStage, ReviewStage } from "./stage-review";
import { SegmentsStage } from "./stage-segments";
import { ShotsStage } from "./stage-shots";
import { WhoStage } from "./stage-who";
import { WordsStage } from "./stage-words";

/** What every stage gets: the project, the clip and shot it works on, the jobs' states and prices, and the edit call. */
export interface StageProps {
  id: string;
  project: SwapProject;
  clip: SwapClip;
  gens: Record<string, GenSummary>;
  estimate: StudioEstimate | undefined;
  shot: SwapShot | null;
  setShot: (id: string) => void;
  edit: (e: EditInput) => Promise<SwapProject | undefined>;
  /** The clip as the page plays it (your GPU's 24 fps copy, or the cloud's browser copy, once it's made). */
  src: string;
}

const STAGES = [
  { id: "shots", label: "Shots" },
  { id: "words", label: "Words" },
  { id: "who", label: "Who to swap" },
  { id: "anchors", label: "Scene anchors" },
  { id: "segments", label: "Segments" },
  { id: "review", label: "Takes & review" },
  { id: "assemble", label: "Assemble" },
] as const;
type Stage = (typeof STAGES)[number]["id"];

/** Upload a clip with progress, as the file itself (the server reads its header when it's added). */
const uploadClip = (file: File, onProgress: (p: number) => void) => postFileWithProgress(file, onProgress);

/** What the browser reads of a clip before the server does (a format it can't play just has none of it). */
function browserFacts(file: File): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (x: { duration?: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(url);
      resolve(x);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => done({ duration: Number.isFinite(v.duration) ? v.duration : undefined, width: v.videoWidth || undefined, height: v.videoHeight || undefined });
    v.onerror = () => done({});
    setTimeout(() => done({}), 6000);
    v.src = url;
  });
}

export function SwapWorkbench({ id }: { id: string }) {
  const q = useSwapProject(id);
  const v = q.data;
  const project = v?.project;
  const estimate = useSwapEstimate(id, project?.revision, project?.engine).data;
  const editMutation = useSwapEdit(id);
  const [clipId, setClipId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("shots");
  const [shotId, setShotId] = useState<string | null>(null);
  const tabsId = useId();
  // The clip size this viewer may upload: an account's is smaller than the studio's own (src/lib/clip-limit.ts).
  const clipMax = useClipLimit(SWAP_STUDIO.maxBytes);

  const clip = project?.clips.find((c) => c.id === clipId) ?? project?.clips[0] ?? null;
  const shot = clip?.shots.find((s) => s.id === shotId) ?? clip?.shots.find((s) => s.mode === "generate") ?? clip?.shots[0] ?? null;

  const edit = async (e: EditInput) => {
    try {
      return await editMutation.mutateAsync(e);
    } catch (err) {
      toastError(err);
      return undefined;
    }
  };

  if (q.error) {
    return (
      <ToolShell title="Character Swap Studio" engineSwitch={false}>
        <div className="mx-auto max-w-md pt-16 text-center">
          <h2 className="font-heading text-[28px]">Project not found</h2>
          <p className="mt-2 text-[14px] text-muted-foreground">{(q.error as Error).message}</p>
          <Button asChild className="mt-6 rounded-full">
            <Link href="/character-swap">All projects</Link>
          </Button>
        </div>
      </ToolShell>
    );
  }
  if (!v || !project) {
    return (
      <ToolShell title="Character Swap Studio" engineSwitch={false} wide>
        <div className="mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
          <Skeleton className="h-80 rounded-2xl" />
          <Skeleton className="h-[480px] rounded-2xl" />
        </div>
      </ToolShell>
    );
  }

  const src = clip ? pageClip(project.engine, clip) : "";
  const props: StageProps | null = clip ? { id, project, clip, gens: v.gens, estimate, shot, setShot: setShotId, edit, src } : null;
  const clipMb = limitMb(clipMax);

  return (
    <ToolShell
      title={project.name}
      engineSwitch={false}
      wide
      header={
        <>
          <Button asChild variant="ghost" size="sm" className="hidden rounded-full sm:inline-flex">
            <a href={decisionsHref(id)} download>
              <Download className="size-4" /> Export decisions
            </a>
          </Button>
          <EngineSwitch value={project.engine} onChange={(engine) => engine !== project.engine && void edit({ type: "engine", engine })} />
        </>
      }
    >
      <Link href="/character-swap" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All projects
      </Link>
      <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <ProjectPanel project={project} estimate={estimate} edit={edit} />
          <CharacterPanel project={project} edit={edit} />
          <ClipsPanel id={id} project={project} gens={v.gens} maxBytes={clipMax} selected={clip?.id ?? null} onSelect={(c) => {
              setClipId(c);
              setShotId(null);
            }} edit={edit} />
        </div>

        <div className="min-w-0">
          {!clip || !props ? (
            <Panel>
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Film className="size-8 text-muted-foreground" aria-hidden />
                <p className="text-[14px] font-medium">Add a clip to start</p>
                <p className="max-w-sm text-[12px] text-muted-foreground">MP4, MOV, MKV, WebM or AVI, up to 149.66 s and {clipMb} MB. {project.engine === "open" ? "Your GPU works on a 24 fps copy, made as soon as it's added." : "The cloud reads it as filmed."}</p>
              </div>
            </Panel>
          ) : (
            <section aria-label={`Clip ${clip.name}`} className="min-w-0 space-y-3">
              <ClipHeader {...props} />
              <TabRow role="tablist" aria-label="Stages" onKeyDown={tabKeys} follow>
                {STAGES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    id={`${tabsId}-${s.id}`}
                    aria-selected={stage === s.id}
                    aria-controls={`${tabsId}-panel`}
                    tabIndex={stage === s.id ? 0 : -1}
                    onClick={() => setStage(s.id)}
                    className={TAB_PILL}
                    {...onAttr(stage === s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </TabRow>
              {stage !== "shots" && stage !== "words" && stage !== "assemble" && <ShotStrip clip={clip} shot={shot} onPick={setShotId} gens={v.gens} />}
              <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${stage}`} className="min-w-0">
                {stage === "shots" && <ShotsStage key={clip.id} {...props} />}
                {stage === "words" && <WordsStage {...props} />}
                {stage === "who" && <WhoStage key={`${clip.id}-${shot?.id}`} {...props} />}
                {stage === "anchors" && <AnchorsStage {...props} />}
                {stage === "segments" && <SegmentsStage key={`${clip.id}-${shot?.id}`} {...props} />}
                {stage === "review" && <ReviewStage {...props} />}
                {stage === "assemble" && <AssembleStage {...props} />}
              </div>
            </section>
          )}
        </div>
      </div>
    </ToolShell>
  );
}

function ProjectPanel({ project, estimate, edit }: { project: SwapProject; estimate: StudioEstimate | undefined; edit: StageProps["edit"] }) {
  const nameId = useId();
  return (
    <Panel title="Project">
      <label htmlFor={nameId} className="sr-only">
        Project name
      </label>
      <input
        id={nameId}
        key={project.name}
        defaultValue={project.name}
        maxLength={SWAP_STUDIO.maxNameChars}
        onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== project.name && void edit({ type: "rename", name: e.currentTarget.value })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-9 w-full rounded-md border bg-background px-2.5 text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <div className="rounded-lg bg-muted px-2.5 py-2">
          <dt className="text-muted-foreground">Every shot&apos;s queue</dt>
          <dd className="mt-0.5 font-medium">
            {estimate ? `${estimate.project.segments} segment${estimate.project.segments === 1 ? "" : "s"}` : "…"}
            <span className="block font-mono text-[12px]">{priceText(estimate?.project.costUsd, { demo: estimate?.demo, engine: project.engine })}</span>
          </dd>
        </div>
        <div className="rounded-lg bg-muted px-2.5 py-2">
          <dt className="text-muted-foreground">Engine</dt>
          <dd className="mt-0.5 font-medium">{project.engine === "open" ? "Your GPU (ComfyUI)" : "Cloud (fal)"}</dd>
        </div>
      </dl>
      {estimate?.demo && <Note className="mt-2">Placeholder results: nothing is paid for and the takes are sample clips. Connect {project.engine === "open" ? "ComfyUI" : "fal"} in Settings to run it for real.</Note>}
      <Button asChild variant="outline" size="sm" className="mt-3 w-full rounded-full sm:hidden">
        <a href={decisionsHref(project.id)} download>
          <Download className="size-4" /> Export decisions
        </a>
      </Button>
    </Panel>
  );
}

function CharacterPanel({ project, edit }: { project: SwapProject; edit: StageProps["edit"] }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File) => {
    if (!file.type.startsWith("image/")) return toast.error("Pick an image of your character");
    setBusy(true);
    try {
      const a = await uploadFile(file);
      await edit({ type: "character", image: a.url });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Your character">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="relative grid size-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed bg-muted text-muted-foreground hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={project.character.image ? "Replace the character picture" : "Add a picture of your character"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {project.character.image ? <img src={project.character.image} alt="" className="size-full object-cover" /> : <ImagePlus className="size-6" aria-hidden />}
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-background/70">
              <Loader2 className="size-5 animate-spin" />
            </span>
          )}
        </button>
        <p className="min-w-0 text-[12px] leading-snug text-pretty text-muted-foreground">
          One clear picture of who comes in (<span className="font-medium text-foreground">Picture 1</span>). A new picture un-approves the scene anchors made with the old one.
        </p>
      </div>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      <div className="mt-3">
        <SavedText
          label="Description"
          value={project.character.description}
          max={SWAP_STUDIO.maxDescriptionChars}
          placeholder="a woman in her thirties, short black hair, yellow raincoat"
          onSave={(description) => void edit({ type: "character", description })}
          hint="in every prompt"
        />
      </div>
    </Panel>
  );
}

function ClipsPanel({
  id,
  project,
  gens,
  maxBytes,
  selected,
  onSelect,
  edit,
}: {
  id: string;
  project: SwapProject;
  gens: Record<string, GenSummary>;
  /** The clip size this viewer may upload. */
  maxBytes: number;
  selected: string | null;
  onSelect: (id: string) => void;
  edit: StageProps["edit"];
}) {
  const add = useAddClip(id);
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [remove, setRemove] = useState<SwapClip | null>(null);
  // Whoever the upload would refuse is asked first (a guest signs up, an account without a GPU or key connects one).
  const askFirst = useAskBeforeUpload();

  const pick = async (file: File) => {
    const tooBig = file.size > maxBytes ? `Keep clips under ${limitMb(maxBytes)} MB` : null;
    const problem = !clipExtension(file.name) ? "Add an MP4, MOV, MKV, WebM or AVI clip" : (tooBig ?? clipProblem({ bytes: file.size }));
    if (problem) return toast.error(problem);
    const facts = await browserFacts(file);
    const long = clipProblem({ duration: facts.duration });
    if (long) return toast.error(long);
    // A clip this browser can't play (AVI, or a codec it lacks): the cloud makes a copy the page can play.
    const playable = facts.duration !== undefined && facts.width !== undefined;
    setUpload({ name: file.name, progress: 0 });
    try {
      const up = await uploadClip(file, (p) => setUpload({ name: file.name, progress: p }));
      const p = await add.mutateAsync({ url: up.url, name: file.name, bytes: file.size, playable, ...facts });
      onSelect(p.clips.at(-1)!.id);
    } catch (e) {
      toastError(e);
    } finally {
      setUpload(null);
    }
  };

  return (
    <Panel
      title={`Clips · ${project.clips.length}`}
      aside={
        <Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-[12px]" onClick={() => {
            if (!askFirst()) input.current?.click();
          }} disabled={!!upload || project.clips.length >= SWAP_STUDIO.maxClips}>
          <Plus className="size-3.5" /> Add clip
        </Button>
      }
    >
      <input ref={input} type="file" accept={SWAP_STUDIO.accept} className="hidden" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      {upload && (
        <div className="mb-2 rounded-lg bg-muted px-2.5 py-2 text-[12px]">
          <span className="block truncate font-medium">{upload.name}</span>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-background" role="progressbar" aria-valuenow={Math.round(upload.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Uploading">
            <div className="h-full bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(Math.round(upload.progress * 100)) / 100})` }} />
          </div>
        </div>
      )}
      {!project.clips.length && !upload ? (
        <p className="text-[12px] text-muted-foreground">No clips yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {project.clips.map((c) => {
            const norm = project.engine === "open" && !c.normalized?.url ? jobState(c.normalized?.genId, undefined, gens) : null;
            const copy = project.engine === "cloud" && clipNeedsPreview("cloud", c) && !c.preview?.url ? jobState(c.preview?.genId, undefined, gens) : null;
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={selected === c.id ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected === c.id ? "bg-brand-faint" : "hover:bg-muted",
                  )}
                >
                  <span className="truncate text-[13px] font-medium">{c.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {secondsLabel(c.frames)} · {c.shots.length} shot{c.shots.length === 1 ? "" : "s"} · {c.shots.filter((s) => s.mode === "generate").length} swapped
                    {c.assembly?.genId ? " · assembled" : ""}
                    {norm ? ` · 24 fps copy: ${norm.status === "succeeded" ? "ready" : norm.status}` : ""}
                    {copy ? ` · browser copy: ${copy.status === "succeeded" ? "ready" : copy.status}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setRemove(c)}
                  aria-label={`Remove ${c.name}`}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog open={!!remove} onOpenChange={(o) => !o && setRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{remove?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Its shots, masks, anchors and takes leave the project (an assembled clip stays in the Library).</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove && void edit({ type: "remove-clip", clipId: remove.id })}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function ClipHeader({ id, project, clip, gens }: StageProps) {
  const prepare = usePrepareClip(id);
  const norm = jobState(clip.normalized?.genId, undefined, gens);
  const copy = jobState(clip.preview?.genId, undefined, gens);
  const copied = project.engine === "cloud" && clipNeedsPreview("cloud", clip);
  const needsCopy = copied && !clip.preview?.url;
  const s = clip.source;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="min-w-0 truncate text-[16px] font-semibold">{clip.name}</h2>
      <span className="text-[12px] text-muted-foreground">
        {secondsLabel(clip.frames)} · {clip.frames} frames at 24 fps{s.fps ? ` (filmed at ${Math.round(s.fps * 100) / 100} fps)` : ""}
        {s.width && s.height ? ` · ${s.width}×${s.height}` : ""} · {s.hasAudio ? "with sound" : "silent"}
      </span>
      {project.engine === "open" && !clip.normalized?.url && (
        <span className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">24 fps copy</span>
          <GenChip genId={clip.normalized?.genId} gens={gens} />
          {(!clip.normalized?.genId || norm.status === "failed" || norm.status === "canceled" || norm.status === "missing") && (
            <Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-[12px]" disabled={prepare.isPending} onClick={() => prepare.mutate({ clipId: clip.id }, { onError: (e) => toastError(e) })}>
              <RotateCcw className="size-3.5" /> Prepare at 24 fps
            </Button>
          )}
        </span>
      )}
      {needsCopy && (
        <span className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">Browser copy</span>
          <GenChip genId={clip.preview?.genId} gens={gens} />
          {(!clip.preview?.genId || copy.status === "failed" || copy.status === "canceled" || copy.status === "missing") && (
            <Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-[12px]" disabled={prepare.isPending} onClick={() => prepare.mutate({ clipId: clip.id }, { onError: (e) => toastError(e) })}>
              <RotateCcw className="size-3.5" /> Make a browser copy
            </Button>
          )}
        </span>
      )}
      <div className="w-full">
        <JobError genId={clip.normalized?.genId} gens={gens} />
        {project.engine === "cloud" && <JobError genId={clip.preview?.genId} gens={gens} />}
      </div>
      {copied && (
        <Note className="w-full">
          Your browser can&apos;t play this clip ({clipExtension(s.name ?? s.url)?.toUpperCase() ?? "its format"}), so the page shows a copy fal makes as an H.264 MP4 — for finding the edits and clicking who to swap. The jobs read the clip as filmed.
        </Note>
      )}
    </div>
  );
}

/** The clip's shots as a strip (widths by length): pick the shot a stage works on. */
export function ShotStrip({ clip, shot, onPick, gens }: { clip: SwapClip; shot: SwapShot | null; onPick: (id: string) => void; gens: Record<string, GenSummary> }) {
  const busy = useMemo(() => new Set(Object.entries(gens).filter(([, g]) => g.status === "queued" || g.status === "running").map(([k]) => k)), [gens]);
  const current = Math.max(0, clip.shots.findIndex((s) => s.id === shot?.id));
  // A radio group is one tab stop: the arrow keys (and Home / End) move between shots and pick them.
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const n = clip.shots.length;
    const to = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : step ? (current + step + n) % n : -1;
    if (to < 0) return;
    e.preventDefault();
    onPick(clip.shots[to].id);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[to])?.focus();
  };
  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto pb-1" role="radiogroup" aria-label="Shot" onKeyDown={keys}>
      {clip.shots.map((s, i) => {
        const working = (s.segments ?? []).some((g) => g.takes.some((t) => t.state === "waiting" || (t.genId && busy.has(t.genId))));
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={shot?.id === s.id}
            tabIndex={i === current ? 0 : -1}
            onClick={() => onPick(s.id)}
            title={`${MODE_LABELS[s.mode].label} · ${secondsLabel(s.end - s.start)}`}
            style={{ flexGrow: Math.max(1, s.end - s.start) }}
            className={cn(
              "flex h-12 min-w-[4.5rem] shrink-0 basis-0 flex-col justify-center rounded-lg border px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              s.mode === "generate" ? "border-brand-text/30 bg-brand-faint" : "bg-muted",
              shot?.id === s.id && "ring-2 ring-foreground",
            )}
          >
            <span className="flex items-center gap-1 text-[12px] font-semibold">
              Shot {i + 1}
              {working && <Loader2 className="size-3 animate-spin text-brand-text" aria-label="making takes" />}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {secondsLabel(s.end - s.start)} · {s.mode === "generate" ? "replace" : "keep"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
