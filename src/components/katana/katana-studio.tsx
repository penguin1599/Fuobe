"use client";

import { ChevronDown, Download, Film, Loader2, RotateCcw, ScanLine, Sparkles, Trash2, Users } from "lucide-react";
import { nanoid } from "nanoid";
import { useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fileToList, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { frameDiff, openVideo, releaseVideo, sampleFrames } from "@/components/av/frame-sampler";
import { MediaDrop } from "@/components/av/media-drop";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { ExampleRow } from "@/components/studio/example-row";
import { useAskBeforeUpload, useEngine, useIsGuest, useModelAccess, useStatus } from "@/lib/api";
import { againPrice, againWhere, placeholdersOn } from "@/lib/demo-mode";
import { formatCueTime } from "@/lib/av/cue-edit";
import { againKeys, detectCutIndices, KATANA_LIMITS, katanaProgress, katanaStage, motionModel, MOTION_MODELS, nearestAspect, OPEN_KEYFRAME_PHOTOS, planSegments, refineCut, refineTimes, type KatanaJobView, type Segment } from "@/lib/av/katana";
import { keepOffered, offered } from "@/lib/model-access";
import type { ExampleRowData } from "@/lib/examples/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { useKatanaActions, useKatanaJobs, useKatanaPreview, type KatanaBody } from "./hooks";

type SplitMode = "fixed" | "scenes";

/**
 * Scene cuts by a frame-difference pass in the browser: about 6 samples a second at 48 px, then each
 * jump is pinned down with 5 finer samples between the two around it, so the cut sits on the first
 * frame of the new shot (within a frame at 30 fps), not between samples.
 */
async function findCuts(src: string, duration: number, onProgress: (p: number) => void): Promise<number[]> {
  const fps = Math.min(6, 180 / Math.max(1, duration));
  const times = Array.from({ length: Math.max(2, Math.floor(duration * fps)) }, (_, i) => i / fps);
  const v = await openVideo(src);
  try {
    const frames = await sampleFrames(v, times, { width: 48, onProgress: (d) => onProgress(d * 0.8) });
    const at = frames.map((f) => f.t);
    const diffs = frames.slice(1).map((f, i) => frameDiff(frames[i].data, f.data));
    const coarse = detectCutIndices(diffs, at);
    const cuts: number[] = [];
    for (const [n, i] of coarse.entries()) {
      const fine = await sampleFrames(v, refineTimes(at[i], at[i + 1]), { width: 48 });
      cuts.push(refineCut(fine.slice(1).map((f, k) => frameDiff(fine[k].data, f.data)), fine.map((f) => f.t)));
      onProgress(0.8 + (0.2 * (n + 1)) / coarse.length);
    }
    return cuts;
  } finally {
    releaseVideo(v);
  }
}

const money = (usd: number | null | undefined, demo?: boolean, open?: boolean) => (demo ? "Placeholder · free" : open ? "Free · your GPU" : usd == null ? "Price unknown" : `≈ $${usd.toFixed(2)}`);

/**
 * Katana: rebuild a reference edit with your subject, shot for shot.
 * examples: "More to try" (exampleRow(), from the page), where the runs go until there is one.
 */
export function KatanaStudio({ examples }: { examples?: ExampleRowData | null }) {
  const [engine] = useEngine();
  // A guest is asked to sign up, and an account with neither its own GPU nor its own key to connect one, before a photo
  // is added (the reference's drop asks the same).
  const askFirst = useAskBeforeUpload();
  const guest = useIsGuest();
  const jobs = useKatanaJobs();
  const { start } = useKatanaActions();
  const [reference, setReference] = useState<SlotValue | null>(null);
  const [meta, setMeta] = useState<{ duration: number; aspect: "16:9" | "9:16" | "1:1" } | null>(null);
  // The browser can't decode the clip (H.265…): the server reads its length from the file and plans evenly.
  const [unreadable, setUnreadable] = useState(false);
  const [photos, setPhotos] = useState<SlotValue[]>([]);
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<SplitMode>("fixed");
  const [length, setLength] = useState<number | null>(null);
  const [cuts, setCuts] = useState<number[] | null>(null);
  const [scanning, setScanning] = useState<number | null>(null);
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  const [keepAudio, setKeepAudio] = useState(true);
  // Motion models switched off in Settings → Models & licences leave the menu, and the pick falls back to one that is on.
  const access = useModelAccess();
  const motionModels = keepOffered(MOTION_MODELS[engine], (x) => offered(access, x.id, engine));
  const m = motionModel(engine, modelId && motionModels.some((x) => x.id === modelId) ? modelId : motionModels[0].id);
  const len = Math.min(m.max, Math.max(m.min, length ?? m.max));

  const segments = useMemo<Segment[] | null>(() => {
    if (!meta) return null;
    try {
      if (mode === "scenes" && !cuts) return null;
      return mode === "scenes" && cuts ? planSegments({ duration: meta.duration, mode: "scenes", cuts, min: m.min, max: m.max }) : planSegments({ duration: meta.duration, mode: "fixed", length: len, min: m.min, max: m.max });
    } catch {
      return null;
    }
  }, [meta, mode, cuts, len, m.min, m.max]);

  const ready = reference && !reference.uploading && photos.length > 0 && photos.every((p) => !p.uploading) && (segments?.length || (unreadable && !meta));
  const body: KatanaBody | null = ready
    ? {
        engine,
        reference: reference.ref,
        photos: photos.map((p) => p.ref),
        instructions: instructions.trim() || undefined,
        ...(meta && segments ? { segments, duration: meta.duration, aspectRatio: meta.aspect } : { length: len }),
        motionModel: m.id,
        keepAudio,
        title: reference.name?.replace(/\.[a-z0-9]+$/i, "") || "Katana edit",
      }
    : null;
  const preview = useKatanaPreview(useDeferredValue(body));
  const shown = segments ?? preview.data?.segments ?? null;
  const setupBlocker = !reference
    ? "Add the reference edit"
    : reference.uploading
      ? "Uploading…"
      : !meta && !unreadable
        ? "Reading the reference…"
        : scanning !== null
          ? "Finding the cuts…"
        : !photos.length
          ? "Add at least one photo of your subject"
          : photos.some((p) => p.uploading)
            ? "Uploading…"
            : meta && !segments?.length
              ? "This clip can't be split for this model"
              : preview.error
                ? (preview.error as Error).message
                : null;
  const blocker = setupBlocker;

  const scan = async () => {
    if (!reference || !meta || scanning !== null) return;
    // The choice shows at once, with its progress; the plan waits for the cuts.
    setMode("scenes");
    setScanning(0);
    try {
      const found = await findCuts(reference.ref, Math.min(meta.duration, KATANA_LIMITS.maxReference), setScanning);
      setCuts(found);
      toast(found.length ? `${found.length} cut${found.length === 1 ? "" : "s"} found` : "No hard cuts — it'll be split evenly");
    } catch (e) {
      if (!cuts) setMode("fixed");
      toastError(e);
    } finally {
      setScanning(null);
    }
  };

  const go = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "katana-blocker" });
    start.mutate(body, {
      onSuccess: (j) => toast.success(`Katana started · ${j.segments.length} segment${j.segments.length === 1 ? "" : "s"}`),
      onError: (e) => toastError(e),
    });
  };

  return (
    <ToolShell title="Katana">
      <ToolHero title="Recreate the edit. Make it yours." subtitle="Drop a reference edit and up to 5 photos of your subject — Katana rebuilds it shot for shot, at the original cut times, with the original sound." />
      <div className="mx-auto mt-8 grid max-w-[1040px] gap-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-3">
          <MediaDrop
            kind="video"
            value={reference}
            onChange={(v) => {
              setReference(v);
              setMeta(null);
              setUnreadable(false);
              setCuts(null);
              setMode("fixed");
            }}
            onDuration={(d) => setMeta((x) => ({ duration: d, aspect: x?.aspect ?? "16:9" }))}
            onUnreadable={() => setUnreadable(true)}
            title="Add the edit you want to recreate"
            hint="1–30 s · MP4, MOV or WebM · the soundtrack is kept"
            compact
          />
          {reference && !reference.uploading && <ShapeProbe src={reference.ref} onShape={(aspect) => setMeta((x) => (x ? { ...x, aspect } : x))} />}
          {unreadable && !meta && (
            <Panel title="Segments" aside={<span className="text-[12px] text-muted-foreground">{shown?.length ?? "…"} × up to {m.max} s</span>}>
              <p className="text-[13px] text-muted-foreground">This browser can&apos;t preview the clip, so it&apos;s cut evenly every {len} s (scene cuts need a preview).</p>
              <div className="mt-3 flex items-center gap-3">
                <Slider min={m.min} max={m.max} step={0.5} value={[len]} onValueChange={(v) => setLength(v[0])} aria-label="Segment length" aria-valuetext={`${len} seconds`} className="max-w-64" />
                <span className="font-mono text-[12px] text-muted-foreground">{len} s</span>
              </div>
              {shown && shown.length > 0 && <SegmentBar segments={shown} duration={shown.at(-1)!.end} />}
            </Panel>
          )}
          {meta && (
            <Panel
              title="Segments"
              aside={
                <span className="text-[12px] text-muted-foreground">
                  {scanning !== null && !cuts ? "…" : (segments?.length ?? 0)} × up to {m.max} s
                </span>
              }
            >
              <div role="radiogroup" aria-label="How to cut the reference" className="inline-flex rounded-full bg-muted p-0.5">
                {(["fixed", "scenes"] as const).map((x) => (
                  <button
                    key={x}
                    type="button"
                    role="radio"
                    aria-checked={mode === x}
                    onClick={() => (x === "scenes" && !cuts ? void scan() : setMode(x))}
                    className={cn("h-7 rounded-full px-3 text-[12px] font-medium transition", mode === x ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
                  >
                    {x === "fixed" ? "Every few seconds" : "At scene cuts"}
                  </button>
                ))}
              </div>
              {mode === "fixed" ? (
                <div className="mt-3 flex items-center gap-3">
                  <Slider min={m.min} max={m.max} step={0.5} value={[len]} onValueChange={(v) => setLength(v[0])} aria-label="Segment length" aria-valuetext={`${len} seconds`} className="max-w-64" />
                  <span className="font-mono text-[12px] text-muted-foreground">{len} s</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="outline" size="sm" className="rounded-full" onClick={() => void scan()} disabled={scanning !== null}>
                    {scanning !== null ? <Loader2 className="size-3.5 animate-spin" /> : <ScanLine className="size-3.5" />}
                    {scanning !== null ? `Looking for cuts… ${Math.round(scanning * 100)}%` : "Find the cuts again"}
                  </Button>
                  <span className="text-[12px] text-muted-foreground" role="status" aria-live="polite">
                    {scanning !== null ? "Reading the clip in your browser" : `${cuts?.length ?? 0} cut${cuts?.length === 1 ? "" : "s"} found in your browser`}
                  </span>
                </div>
              )}
              {scanning !== null && !cuts ? <Skeleton className="mt-3 h-7 w-full rounded-lg" /> : segments && <SegmentBar segments={segments} duration={Math.min(meta.duration, KATANA_LIMITS.maxReference)} />}
              {meta.duration > KATANA_LIMITS.maxReference && <p className="mt-2 text-[12px] text-muted-foreground">Only the first 30 s are recreated.</p>}
            </Panel>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <Panel title="Your subject" aside={<span className="text-[12px] text-muted-foreground">{photos.length}/5</span>}>
            <div
              className="flex flex-wrap gap-2"
              // Anyone whose upload would be refused gets its card instead of the file chooser.
              onClickCapture={(e) => {
                if (askFirst()) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDropCapture={(e) => {
                if (askFirst()) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              {photos.map((p) => (
                <MediaSlot key={p.id} label="Photo" kind="image" value={p} onChange={(v) => setPhotos((xs) => (v ? xs.map((x) => (x.id === p.id ? { ...v, id: p.id } : x)) : xs.filter((x) => x.id !== p.id)))} size="lg" />
              ))}
              {photos.length < KATANA_LIMITS.maxPhotos && <MediaSlot label={photos.length ? "Add photo" : "Add your subject"} kind="image" value={null} onChange={(v) => v && setPhotos((xs) => [...xs, { ...v, id: v.id ?? nanoid(8) }])} onFile={(f) => fileToList(f, setPhotos, "image")} size="lg" required />}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground">
              <Users className="mt-0.5 size-3.5 shrink-0" /> A person, a product or an outfit. Clear, well-lit photos from a couple of angles work best.
            </p>
            {engine === "open" && <p className="mt-1 text-[12px] text-muted-foreground">We use your first {OPEN_KEYFRAME_PHOTOS} photos.</p>}
          </Panel>
          <Panel title="Instructions (optional)">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, KATANA_LIMITS.maxInstructions))}
              placeholder="Anything to pay attention to, e.g. “keep the red jacket, swap the guitar for my product”"
              className="min-h-20 resize-none text-[14px]"
              aria-label="Instructions"
            />
            <p className="mt-1 text-right font-mono text-[11px] text-muted-foreground">
              {instructions.length}/{KATANA_LIMITS.maxInstructions}
            </p>
          </Panel>
          <Panel title="Motion">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <Label htmlFor="katana-model" className="text-[13px] sm:w-20">
                Model
              </Label>
              <Select value={m.id} onValueChange={setModelId}>
                <SelectTrigger id="katana-model" className="h-9 w-full rounded-full sm:w-auto sm:min-w-0 sm:flex-1">
                  {/* The name alone here: the menu says each model's seconds. */}
                  <SelectValue>{m.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {motionModels.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.label} · {x.min}–{x.max} s
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Switch id="katana-audio" checked={keepAudio} onCheckedChange={setKeepAudio} />
              <Label htmlFor="katana-audio" className="text-[13px]">
                Keep the reference&apos;s soundtrack
              </Label>
            </div>
          </Panel>
          <div className="flex items-center gap-3 pt-1">
            <p className="flex-1 text-[13px] text-muted-foreground">
              {preview.data ? (
                <>
                  {preview.data.segments.length} segment{preview.data.segments.length === 1 ? "" : "s"} · {preview.data.steps} steps ·{" "}
                  <span className="font-mono text-foreground">{money(preview.data.costUsd, preview.data.demo, engine === "open")}</span>
                </>
              ) : (
                (blocker ?? "Pricing…")
              )}
            </p>
            <Button size="lg" className={cn("rounded-full", blocker && "bg-muted text-muted-foreground hover:bg-muted")} onClick={go} disabled={start.isPending || scanning !== null}>
              {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Recreate
            </Button>
          </div>
        </div>
      </div>
      {examples && (guest || (jobs.isSuccess && !jobs.data.length)) && <ExampleRow row={examples} className="mt-12" />}
      <Runs jobs={jobs.data} loading={jobs.isLoading} />
    </ToolShell>
  );
}

/** Reads the reference's width and height (the render shape). */
function ShapeProbe({ src, onShape }: { src: string; onShape: (a: "16:9" | "9:16" | "1:1") => void }) {
  return <video src={src} preload="metadata" muted className="hidden" onLoadedMetadata={(e) => e.currentTarget.videoWidth && onShape(nearestAspect(e.currentTarget.videoWidth, e.currentTarget.videoHeight))} />;
}

function SegmentBar({ segments, duration }: { segments: Segment[]; duration: number }) {
  return (
    <div className="mt-3">
      <div className="flex h-7 overflow-hidden rounded-lg" role="list" aria-label="Segments">
        {segments.map((s, i) => (
          <div
            key={i}
            role="listitem"
            className={cn("grid min-w-0 place-items-center border-r border-background text-[11px] font-medium last:border-r-0", i % 2 ? "bg-brand-faint text-brand-text" : "bg-primary/70 text-primary-foreground")}
            style={{ width: `${((s.end - s.start) / duration) * 100}%` }}
            title={`${formatCueTime(s.start)} – ${formatCueTime(s.end)}`}
          >
            <span className="truncate px-1">{i + 1}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>0:00</span>
        <span>{formatCueTime(duration)}</span>
      </div>
    </div>
  );
}

function stepRows(j: KatanaJobView): { segment: number; rows: StepRow[] }[] {
  const labels: Record<string, string> = { cut: "Cut", frame: "First frame", key: "Your subject", move: "Motion" };
  return j.segments.map((_, i) => ({
    segment: i,
    rows: ["cut", "frame", "key", "move"].filter((k) => j.steps[`${k}${i}`]).map((k) => ({ key: `${k}${i}`, label: labels[k], g: j.generations[j.steps[`${k}${i}`]] })),
  }));
}

function Runs({ jobs, loading }: { jobs?: KatanaJobView[]; loading: boolean }) {
  const { remove, retry } = useKatanaActions();
  // A run again is a new run: where it runs (or that it's paid) is said on the button before the tap.
  const placeholders = placeholdersOn(useStatus().data?.demoMode);
  // On the cloud it says the price: the estimates of the steps it makes again (all of them, or the failed ones and after).
  const where = (j: KatanaJobView, all: boolean) => {
    const keys = j.engine === "open" || placeholders ? null : againKeys(j, all);
    return againWhere(j, { placeholders }, keys && againPrice(keys.map((k) => j.generations[j.steps[k]])));
  };
  const again = (id: string, all: boolean) =>
    retry.mutate(
      { id, all },
      { onSuccess: (j) => toast.success(all ? `Started again · ${j.segments.length} segment${j.segments.length === 1 ? "" : "s"}` : "Retrying the failed steps"), onError: (e) => toastError(e) },
    );
  if (loading)
    return (
      <div className="mx-auto mt-10 max-w-[1040px] space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  if (!jobs?.length) return null;
  return (
    <section className="mx-auto mt-12 max-w-[1040px]" aria-labelledby="katana-runs">
      <h3 id="katana-runs" className="mb-3 font-heading text-[22px]">
        Your edits
      </h3>
      <ul className="space-y-3">
        {jobs.map((j) => {
          const stage = katanaStage(j);
          const final = j.generations[j.steps[j.final]];
          const out = final?.status === "succeeded" ? final.outputs.find((o) => o.kind === "video") : undefined;
          const pct = Math.round(katanaProgress(j) * 100);
          const others = ["join", "final", ...Object.keys(j.steps).filter((k) => k.startsWith("join") && k !== "join")].filter((k) => j.steps[k]);
          return (
            <li key={j.id} className="overflow-hidden rounded-2xl border bg-background shadow-soft">
              <div className="grid gap-3 p-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:p-4">
                <div className="aspect-video overflow-hidden rounded-xl bg-media">
                  {out ? <video src={out.url} controls playsInline preload="metadata" className="size-full object-contain" /> : <div className="grid size-full place-items-center text-muted-foreground">{stage === "failed" ? <Film className="size-6" /> : <Loader2 className="size-6 animate-spin" />}</div>}
                </div>
                <div className="min-w-0">
                  {/* On a phone the title has its own line, so the buttons (Run again says its price) never squeeze it away. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                    <p className="min-w-0 flex-1 truncate text-[15px] font-medium max-sm:basis-full">{j.title}</p>
                    {out && (
                      <Button asChild variant="outline" size="sm" className="rounded-full">
                        <a href={out.url} download={`${j.title}.mp4`}>
                          <Download className="size-3.5" /> Download
                        </a>
                      </Button>
                    )}
                    {stage !== "running" && (
                      <Button variant="ghost" size="sm" className="rounded-full" disabled={retry.isPending} onClick={() => again(j.id, stage === "done")}>
                        <RotateCcw className="size-3.5" /> {stage === "failed" ? "Retry failed steps" : "Run again"}
                        {where(j, stage === "done")}
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`Remove ${j.title}`}>
                          <Trash2 className="size-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove this edit?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {stage === "running" ? "Its steps still running are stopped, and it leaves this list." : "It leaves this list."} The clips it already made stay in your Library.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep it</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove.mutate(j.id, { onSuccess: () => toast("Removed — its clips stay in your Library"), onError: (e) => toastError(e) })}>Remove</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {j.segments.length} segment{j.segments.length === 1 ? "" : "s"} · {MOTION_MODELS[j.engine].find((x) => x.id === j.motionModel)?.label ?? j.motionModel} · {j.engine === "open" ? "Open source" : "Cloud"}
                    {final?.provider === "mock" ? " · placeholder" : ""}
                  </p>
                  {stage !== "done" && (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full origin-left transition-transform duration-(--motion-slow) ease-standard", stage === "failed" ? "bg-destructive" : "bg-primary")} style={{ transform: `scaleX(${(Math.max(3, pct)) / 100})` }} />
                      </div>
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        {stage === "failed" ? "A step failed — open the steps for the reason, then retry: the finished steps are kept" : `${pct}% · steps run as soon as the ones before them finish`}
                      </p>
                    </div>
                  )}
                  <Collapsible className="mt-2">
                    <CollapsibleTrigger className="group inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                      Steps <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {stepRows(j).map((s) => (
                          <div key={s.segment}>
                            <p className="mb-1 text-[12px] font-semibold">
                              Segment {s.segment + 1} · {formatCueTime(j.segments[s.segment].start)}–{formatCueTime(j.segments[s.segment].end)}
                            </p>
                            <StepList steps={s.rows} />
                          </div>
                        ))}
                        {others.length > 0 && (
                          <div>
                            <p className="mb-1 text-[12px] font-semibold">Finish</p>
                            <StepList steps={others.map((k) => ({ key: k, label: k === "final" ? "Original soundtrack" : "Join at the cut times", g: j.generations[j.steps[k]] }))} />
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
