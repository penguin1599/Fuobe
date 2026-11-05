"use client";

import { Download, ImagePlus, Loader2, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGenerationList } from "@/components/av/use-generation";
import { VideoCompare } from "@/components/remove-object/video-compare";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { ClipBar, ClipDrop, costText, Field, Segmented } from "@/components/shorts/ui";
import { clipDuration, clipSize, useSourceClip } from "@/components/shorts/use-source-clip";
import { Feed } from "@/components/studio/feed";
import { fileToList, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { VideoTrimmer, type TrimRange, type VideoTrimmerHandle } from "@/components/studio/video-trimmer";
import { useEngine, useGenerations } from "@/lib/api";
import { DIRECTION_CUT_NOTE, directionPrompt, EVOLUTION, EVOLUTION_CLOUD_NOTE, EVOLUTION_DEFAULT_RESOLUTION, EVOLUTION_RESOLUTIONS, INTENSITIES, type Intensity } from "@/lib/catalog/evolution";
import { chainState } from "@/lib/catalog/shorts";
import { downloadHref, downloadName } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { useEvolutionActions, useEvolutionEstimate, type EvolutionBody } from "./hooks";

const LIMITS = `MP4, MOV or WebM · ${EVOLUTION.minSeconds}–${EVOLUTION.maxSeconds} s · ${EVOLUTION.maxBytes / 1024 / 1024} MB`;
const BY: Record<string, string> = { claude: "Written by Claude", ollama: "Written by Ollama on your computer", offline: "Written by Fuobe's offline writer", you: "Your direction" };

interface Run {
  final: string;
  ids: string[];
  before: string;
  start: number;
  ratio?: number;
  direction: string;
  by: string;
}

/** A frame of the clip as a small JPEG data URL, for the direction writer to see. */
async function frameDataUrl(blob: Blob | null | undefined): Promise<string | undefined> {
  if (!blob) return undefined;
  return await new Promise<string | undefined>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" && r.result.length < 1_900_000 ? r.result : undefined);
    r.onerror = () => resolve(undefined);
    r.readAsDataURL(blob);
  });
}

/**
 * Video tools → Evolution (Fuobe Evolution, build plan O13): one clip and up to 40 references, how much should change,
 * and a creative direction you write or an LLM writes from the references; priced before it runs ("Free" on your
 * GPU); the result with a before / after wipe.
 */
export function EvolutionTool() {
  const [engine] = useEngine();
  const source = useSourceClip(EVOLUTION.maxBytes);
  const clip = source.clip;
  const trimmer = useRef<VideoTrimmerHandle>(null);
  const many = useRef<HTMLInputElement>(null);
  const [range, setRange] = useState<TrimRange | null>(null);
  const [intensity, setIntensity] = useState<Intensity>("medium");
  const [direction, setDirection] = useState("");
  const [by, setBy] = useState<string | null>(null);
  const [refs, setRefs] = useState<SlotValue[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [run, setRun] = useState<Run | null>(null);
  const actions = useEvolutionActions();
  const runGuard = useSubmitGuard();
  const history = useGenerations({ features: [EVOLUTION.feature], limit: 24 });

  const resolutions = EVOLUTION_RESOLUTIONS[engine];
  const resolution = picked[engine] && resolutions.includes(picked[engine]) ? picked[engine] : EVOLUTION_DEFAULT_RESOLUTION[engine];
  const duration = clipDuration(clip);
  const size = clipSize(clip);
  const uploaded = refs.filter((r) => r.ref && !r.uploading).map((r) => r.ref!);
  const ready = !!clip?.url && !clip.uploading && !clip.error && !!duration && !!range;
  const body: EvolutionBody | null = ready
    ? {
        engine,
        intensity,
        ...(direction.trim() ? { direction: direction.trim() } : {}),
        references: uploaded,
        resolution,
        source: { url: clip.url!, name: clip.name, duration, fps: clip.info?.fps, width: size.width, height: size.height, hasAudio: clip.info?.hasAudio },
        range: { start: range.startTime, end: range.endTime },
      }
    : null;
  const estimate = useEvolutionEstimate(body);
  const est = estimate.data && !estimate.isError ? estimate.data : undefined;
  // The words stay out of the estimate's key, so a direction too long for the models is said here as you type.
  const cut = useMemo(() => directionPrompt(direction).cut, [direction]);
  const notes = est ? [...est.notes.filter((n) => n !== DIRECTION_CUT_NOTE), ...(cut ? [DIRECTION_CUT_NOTE] : [])] : [];

  const setupBlocker = !clip
    ? "Add a clip"
    : clip.error
      ? clip.error
      : clip.uploading
        ? clip.progress < 1
          ? `Uploading… ${Math.round(clip.progress * 100)}%`
          : "Reading the clip…"
        : !range || !duration
          ? "Reading the clip…"
          : refs.some((r) => r.uploading)
            ? "Uploading references…"
            : estimate.isError
              ? (estimate.error as Error).message
              : null;
  const blocker = setupBlocker;

  const reset = () => {
    source.clear();
    setRange(null);
  };

  const write = async () => {
    const frame = await frameDataUrl(await trimmer.current?.grabFrame(range?.startTime, 768).catch(() => null));
    actions.direction.mutate(
      { engine, intensity, idea: direction.trim() || undefined, references: uploaded, frame, seconds: range ? range.endTime - range.startTime : duration },
      {
        onSuccess: (d) => {
          setDirection(d.direction);
          setBy(d.by);
          if (d.by === "offline" && d.why) toast("Written offline", { description: `Fuobe's own writer wrote it: ${d.why}. Edit it as you like.` });
        },
        onError: (e) => toastError(e),
      },
    );
  };

  const start = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "evolution-blocker" });
    void runGuard(JSON.stringify(body), (requestId) => actions.run.mutateAsync({ ...body, requestId }))
      .then((r) => {
        if (!r) return;
        const ratio = size.width && size.height ? size.width / size.height : undefined;
        // A direction the writer filled in and you sent as it was is still the writer's.
        setRun({ final: r.final.id, ids: r.items.map((g) => g.id), before: clip!.preview, start: range!.startTime, ratio, direction: r.direction, by: body.direction ? (by ?? "you") : r.by });
        if (!direction.trim()) {
          setDirection(r.direction);
          setBy(r.by);
        }
        toast("Evolving your clip", { description: "Follow it below — it lands in your Library too." });
      })
      .catch((e: Error) => toastError(e));
  };

  const addMany = (files: FileList | null) => {
    const room = EVOLUTION.maxReferences - refs.length;
    const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/")).slice(0, room);
    if ((files?.length ?? 0) > room) toast(`Up to ${EVOLUTION.maxReferences} references — ${list.length} added`);
    list.forEach((f) => fileToList(f, setRefs, "image"));
  };

  return (
    <ToolShell title="Video tools" wide>
      {!clip && (
        <ToolHero
          title="Take a clip further"
          subtitle={`Evolution keeps your clip's motion and timing and takes the rest where your references and words point, free on your own ComfyUI.`}
        />
      )}
      <div className={cn("mx-auto", clip ? "pt-4" : "mt-8 max-w-[640px]")}>
        {!clip ? (
          <ClipDrop
            accept={EVOLUTION.accept}
            limits={LIMITS}
            onFile={(f) => {
              const err = source.pick(f);
              if (err) toast.error(err);
              else setRange(null);
            }}
            onLibrary={(url, name) => {
              source.adopt(url, name);
              setRange(null);
            }}
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-4">
              <Panel>
                <div className="space-y-3">
                  <ClipBar clip={clip} onRemove={reset} />
                  <VideoTrimmer
                    ref={trimmer}
                    src={clip.preview}
                    value={range}
                    onChange={setRange}
                    min={EVOLUTION.minSeconds}
                    max={EVOLUTION.maxSeconds}
                    duration={clip.info?.duration}
                    label="Part of the clip to evolve"
                    hint={duration && duration > EVOLUTION.maxSeconds ? `Pick up to ${EVOLUTION.maxSeconds} s — only that part comes out` : "The whole clip, or just the part you need"}
                    onMeta={source.setBrowserMeta}
                  />
                </div>
              </Panel>
              <Panel title="References" aside={<span className="text-[12px] text-muted-foreground tabular-nums">{refs.length}/{EVOLUTION.maxReferences}</span>}>
                <div className="flex flex-wrap gap-2">
                  {refs.map((r) => (
                    <div key={r.id} className="relative">
                      <MediaSlot label="Reference" kind="image" value={r} onChange={(v) => setRefs((xs) => (v ? xs.map((x) => (x.id === r.id ? { ...v, id: r.id } : x)) : xs.filter((x) => x.id !== r.id)))} size="lg" />
                    </div>
                  ))}
                  {refs.length < EVOLUTION.maxReferences && (
                    <MediaSlot
                      label={refs.length ? "Add another" : "Add a reference"}
                      kind="image"
                      value={null}
                      onChange={(v) => v && setRefs((xs) => [...xs, { ...v, id: v.id ?? nanoid(8) }])}
                      onFile={(f) => fileToList(f, setRefs, "image")}
                      size="lg"
                    />
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input ref={many} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => (addMany(e.target.files), (e.target.value = ""))} />
                  {refs.length < EVOLUTION.maxReferences && (
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => many.current?.click()}>
                      <ImagePlus className="size-3.5" /> Add several
                    </Button>
                  )}
                  {refs.length > 0 && (
                    <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setRefs([])}>
                      <X className="size-3.5" /> Clear
                    </Button>
                  )}
                  <p className="min-w-0 flex-1 basis-60 text-[12px] text-muted-foreground">
                    Characters, objects, places or a style.{" "}
                    {engine === "open"
                      ? `On your GPU the first ${EVOLUTION.openReferences} also go into each segment's direction frame; all of them shape the direction.`
                      : `In the cloud the first ${EVOLUTION.cloudReferences} also go into each piece's direction frame; all of them shape the direction.`}
                  </p>
                </div>
              </Panel>
            </div>

            <Panel className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)]">
              <Field label="How much should change?">
                <Segmented label="How much should change?" value={intensity} onChange={setIntensity} options={INTENSITIES.map((i) => ({ value: i.id, label: i.label }))} />
                <p className="text-[12px] text-muted-foreground" aria-live="polite">
                  {INTENSITIES.find((i) => i.id === intensity)?.hint}
                </p>
                {engine === "cloud" && <p className="text-[12px] text-muted-foreground">{EVOLUTION_CLOUD_NOTE}.</p>}
              </Field>

              <Field label="Creative direction" htmlFor="evolution-direction" hint={by ? BY[by] : "Optional: left empty, it's written for you when you start"}>
                <Textarea
                  id="evolution-direction"
                  value={direction}
                  onChange={(e) => {
                    setDirection(e.target.value);
                    setBy(e.target.value.trim() ? "you" : null);
                  }}
                  maxLength={EVOLUTION.maxDirectionChars}
                  rows={5}
                  placeholder="e.g. “the same walk through a neon-lit night market in the rain” — or a few words, then Write it for me"
                  className="max-h-64 resize-y"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => void write()} disabled={actions.direction.isPending || !clip || refs.some((r) => r.uploading)}>
                    {actions.direction.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Write it for me
                  </Button>
                  <span className="text-[12px] text-muted-foreground">
                    {engine === "open" ? "Ollama with a vision model, else Fuobe's offline writer" : "Claude reads your references, else Fuobe's offline writer"} · never starts a run
                  </span>
                </div>
              </Field>

              <Field label="Resolution">
                <Segmented label="Resolution" value={resolution} onChange={(v) => setPicked((p) => ({ ...p, [engine]: v }))} options={resolutions.map((r) => ({ value: r, label: r }))} />
              </Field>

              <div className="space-y-3 border-t pt-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1" aria-live="polite">
                    {blocker ? (
                      <p className="text-[13px] text-muted-foreground">{blocker}</p>
                    ) : (
                      <>
                        <p className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums">
                          {costText(est, engine)}
                          {estimate.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Updating the price" />}
                        </p>
                        {est && (
                          <p className="text-[12px] leading-snug text-muted-foreground">
                            {est.modelName} · {est.seconds} s · {est.resolution}
                            {est.pieces > 1 ? ` in ${est.pieces} ${engine === "open" ? "segments" : "pieces"}` : ""}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <Button className="rounded-full" onClick={start} disabled={!!blocker || actions.run.isPending}>
                    {actions.run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Evolve
                  </Button>
                </div>
                {est && notes.length > 0 && !blocker && (
                  <ul className="space-y-1 text-[12px] leading-snug text-muted-foreground">
                    {notes.map((n) => (
                      <li key={n} className="flex gap-1.5">
                        <Sparkles className="mt-0.5 size-3 shrink-0 text-brand-text" />
                        <span>{n}.</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>
        )}
      </div>

      {run && <RunPanel run={run} onAgain={start} />}

      {(history.data?.length ?? 0) > 0 && (
        <section className="mt-10" aria-labelledby="evolutions">
          <h3 id="evolutions" className="mb-3 font-heading text-[22px]">
            Your evolutions
          </h3>
          <Feed items={history.data!} />
        </section>
      )}
    </ToolShell>
  );
}

/** What a run's steps are doing, then the result with a before / after wipe and the direction it ran with. */
function RunPanel({ run, onAgain }: { run: Run; onAgain: () => void }) {
  const list = useGenerationList(run.ids).data;
  const byId = useMemo(() => new Map((list ?? []).map((g) => [g.id, g])), [list]);
  const final = byId.get(run.final);
  const rows: StepRow[] = run.ids.map((id) => {
    const g = byId.get(id);
    return { key: id, label: g?.request.step?.label ?? "A step", g };
  });
  const state = chainState(rows.map((r) => ({ g: r.g, label: r.label })).sort((a, b) => (a.g?.id === run.final ? 1 : b.g?.id === run.final ? -1 : 0)));
  const out = final?.status === "succeeded" ? final.outputs.find((o) => o.kind === "video") : undefined;
  return (
    <section className="mt-6" aria-labelledby="run-title">
      <Panel
        title={<span id="run-title">{final?.request.title ?? "Your evolution"}</span>}
        aside={
          out && final ? (
            <Button asChild size="sm" variant="outline" className="rounded-full">
              <a href={downloadHref(out.url, downloadName(final, out, 0))}>
                <Download className="size-3.5" /> Download
              </a>
            </Button>
          ) : state.status === "failed" ? (
            <Button size="sm" variant="outline" className="rounded-full" onClick={onAgain}>
              <RotateCcw className="size-3.5" /> Try again
            </Button>
          ) : null
        }
      >
        {out ? (
          <VideoCompare before={run.before} after={out.url} start={run.start} ratio={run.ratio} />
        ) : (
          <div className="space-y-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} aria-label="Progress">
              <div className={cn("h-full origin-left transition-transform duration-(--motion-slow) ease-standard", state.status === "failed" ? "bg-destructive" : "bg-primary")} style={{ transform: `scaleX(${(Math.max(4, state.progress * 100)) / 100})` }} />
            </div>
            <p className={cn("text-[13px]", state.status === "failed" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
              {state.status === "failed" ? `${state.label}: ${state.error}` : state.label}
            </p>
            {rows.length > 1 && <StepList steps={rows} />}
          </div>
        )}
        <p className="mt-3 text-[12px] leading-relaxed break-words text-muted-foreground">
          <span className="font-medium text-foreground">{BY[run.by] ?? "Direction"}:</span> {run.direction}
        </p>
      </Panel>
    </section>
  );
}
