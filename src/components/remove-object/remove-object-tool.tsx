"use client";

import { OriginalSoundPicker } from "@/components/av/original-sound-picker";
import { ORIGINAL_SOUND_FEATURE, originalSoundDefault, type OriginalSound } from "@/lib/av/original-sound";
import { Brush, Cloud, Cpu, Dices, Download, Eraser as EraserIcon, Eye, Loader2, RotateCcw, Sparkles, Type, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration, useGenerationList } from "@/components/av/use-generation";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { ClipBar, ClipDrop, costText, Field, Segmented } from "@/components/shorts/ui";
import { clipDuration, clipSize, useSourceClip } from "@/components/shorts/use-source-clip";
import { Feed } from "@/components/studio/feed";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { SketchEditor, type Stroke } from "@/components/studio/sketch-editor";
import { VideoTrimmer, type TrimRange, type VideoTrimmerHandle } from "@/components/studio/video-trimmer";
import { useEngine, useGenerations, useModelAccess, useSoundLive } from "@/lib/api";
import {
  CLICK_OPEN_PROBLEM,
  chooseEraser,
  erasersFor,
  REMOVE,
  REMOVE_EXAMPLES,
  REMOVE_MODES,
  rerollProblem,
  reviewOfOutput,
  type Eraser,
  type RemoveMode,
} from "@/lib/catalog/remove-object";
import { chainState } from "@/lib/catalog/shorts";
import type { Generation, PixelPoint } from "@/lib/catalog/types";
import { downloadHref, downloadName } from "@/lib/library";
import { keepOffered, offered } from "@/lib/model-access";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { FrameStage, frameFromBlob, type Frame } from "./frame-stage";
import { useRemovalActions, useRemovalEstimate, type RemovalBody } from "./hooks";
import { VideoCompare } from "./video-compare";

const LIMITS = `MP4, MOV or WebM · up to ${REMOVE.maxSeconds} s at a time · ${REMOVE.maxBytes / 1024 / 1024} MB`;

interface Paint {
  mask: string;
  overlay: string;
  strokes: Stroke[];
}

/** The mask preview being shown, and whether it is the eraser's own mask (see previewIsEraserMask). */
interface PreviewOf {
  id: string;
  exact: boolean;
  eraser: string;
  /** H3 Person Removal's green mask. */
  green?: boolean;
}

interface Run {
  final: string;
  ids: string[];
  /** The original the result is compared with: the clip and where the selection starts. */
  before: string;
  start: number;
  /** The clip's shape, so the compare has its size before the videos load. */
  ratio?: number;
}

/**
 * Video tools → Remove object: say what goes by typing it, clicking it on the first frame or painting over it;
 * see the price (or "Free" on the open engine) and an optional mask preview before anything runs; get the
 * result with a before / after wipe. Long clips are cut into pieces or windows, erased and joined with their
 * own sound (src/lib/catalog/remove-object.ts).
 */
/** The open eraser "Remove a person" picks: H3 Person Removal (MiniMax H3 with Akatz Labs' Person Remover). */
export const PERSON_ERASER = "oss-h3-person-remove";

const noSubscribe = () => () => {};
/** ?person=1: a result's "Remove a person" link. */
const personInUrl = () => new URLSearchParams(window.location.search).get("person") === "1";

export function RemoveObjectTool({ person = false }: { person?: boolean } = {}) {
  const [engine, setEngine, engineMode] = useEngine();
  const access = useModelAccess();
  const source = useSourceClip(REMOVE.maxBytes);
  const clip = source.clip;
  const trimmer = useRef<VideoTrimmerHandle>(null);
  const framePanel = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<TrimRange | null>(null);
  const [mode, setMode] = useState<RemoveMode>("type");
  const [prompt, setPrompt] = useState("");
  const [effects, setEffects] = useState(false);
  // "Remove a person" (its own Video tools tab, or ?person=1 from a result's menu): H3 Person Removal on your GPU.
  const personLinked = useSyncExternalStore(noSubscribe, personInUrl, () => false);
  const personAsked = person || personLinked;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [maskGrow, setMaskGrow] = useState<number>(REMOVE.maskGrow.default);
  const [points, setPoints] = useState<PixelPoint[]>([]);
  const [pointLabel, setPointLabel] = useState<"positive" | "negative">("positive");
  const [paint, setPaint] = useState<Paint | null>(null);
  const [painting, setPainting] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState(false);
  const [previewOf, setPreviewOf] = useState<PreviewOf | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const actions = useRemovalActions();
  const runGuard = useSubmitGuard();
  const previewGuard = useSubmitGuard();
  const history = useGenerations({ features: [REMOVE.feature], limit: 24 });
  // Earlier H3 person removals whose windows can still be redone (the step that made them carries the review).
  const reviewable = useGenerations({ features: [REMOVE.feature, REMOVE.stepFeature], models: [PERSON_ERASER], statuses: ["succeeded"], limit: 12 });
  const earlier = (reviewable.data ?? []).filter((g) => !run?.ids.includes(g.id) && reviewOfOutput(g.outputs.find((o) => o.kind === "video")?.meta));

  // Hand-off: /video-tools/remove-object?video=/api/files/… (a result's menu in the Library, the feed or Cinema).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const video = q.get("video");
    if (video?.startsWith("/api/files/")) source.adopt(video, video.split("/").pop());
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const duration = clipDuration(clip);
  const size = clipSize(clip);
  const choiceKey = `${engine}:${mode}`;
  // Erasers switched off in Settings → Models & licences leave the list, and the pick falls back to one that is on.
  const isOn = (id: string) => offered(access, id, engine);
  const choice = chooseEraser({ engine, mode, effects: mode === "type" && effects, modelId: picked[choiceKey] ?? (personAsked && choiceKey === "open:type" ? PERSON_ERASER : undefined), offered: isOn });
  const eraser: Eraser | null = "eraser" in choice ? choice.eraser : null;
  const options = keepOffered(
    erasersFor(engine, mode).filter((e) => !e.effects),
    (e) => isOn(e.id),
  );
  const everyone = !!eraser?.everyone;
  const h3 = !!eraser?.cleanFrame;
  // Removing a person with H3 runs on your GPU only (nothing hosted fills the person green for it): said on the cloud.
  const personOnCloud = personAsked && engine === "cloud";
  // H3 Person Removal switched off in Settings → Models & licences: said, so the fallback isn't a surprise.
  const personOff = personAsked && engine === "open" && mode === "type" && !isOn(PERSON_ERASER);

  // The selection's first frame, grabbed by the browser: what points and paint are made on.
  const startAt = range ? Math.round(range.startTime * 100) / 100 : null;
  const previewSrc = clip?.preview;
  useEffect(() => {
    if (!previewSrc || startAt === null) return;
    let alive = true;
    const t = setTimeout(async () => {
      const blob = await trimmer.current?.grabFrame(startAt, 1280);
      if (!alive) return;
      if (!blob) return setFrameError(true);
      const f = await frameFromBlob(blob).catch(() => null);
      if (!alive || !f) return;
      setFrameError(false);
      setFrame((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return f;
      });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [previewSrc, startAt]);
  // A new first frame: points and paint made on the old one no longer line up.
  const [frameAt, setFrameAt] = useState<string | null>(null);
  const frameKey = `${previewSrc}|${startAt}`;
  if (frameKey !== frameAt) {
    setFrameAt(frameKey);
    if (points.length || paint) {
      setPoints([]);
      setPaint(null);
    }
    setPreviewOf(null);
  }

  const pickMode = (m: RemoveMode) => {
    setMode(m);
    setPreviewOf(null);
    // Clicking and painting happen on the first frame: bring it into view when it's off screen.
    const el = framePanel.current;
    if (m === "type" || !el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 160 || r.top > window.innerHeight - 160) {
      el.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  };

  const reset = () => {
    source.clear();
    setRange(null);
    setFrame(null);
    setFrameError(false);
    setPoints([]);
    setPaint(null);
    setPreviewOf(null);
  };

  const ready = !!clip?.url && !clip.uploading && !clip.error && !!duration && !!range;
  const marked =
    mode === "type" ? everyone || !!prompt.trim() : mode === "click" ? points.some((p) => p.label !== "negative") : !!paint;
  // What of the clip's sound goes back: Everything until the split has passed a real run, then Music & effects only when a person is removed on your GPU.
  const [soundAsked, setOriginalSound] = useState<OriginalSound | null>(null);
  const soundLiveNow = useSoundLive(ORIGINAL_SOUND_FEATURE);
  const originalSound = soundAsked ?? originalSoundDefault({ replacesPerson: !!eraser?.cleanFrame, engine, live: soundLiveNow });
  const body: RemovalBody | null =
    ready && eraser && marked
      ? {
          engine,
          mode,
          modelId: eraser.id,
          effects: mode === "type" && effects,
          ...(mode === "type" && !everyone ? { prompt: prompt.trim() } : {}),
          ...(mode === "click" ? { points } : {}),
          ...(mode === "paint" && paint ? { mask: paint.mask } : {}),
          ...(mode !== "type" && frame ? { frame: { width: frame.width, height: frame.height } } : {}),
          ...(h3 ? { maskGrow } : {}),
          source: { url: clip.url!, name: clip.name, duration, fps: clip.info?.fps, width: size.width, height: size.height, hasAudio: clip.info?.hasAudio },
          range: { start: range.startTime, end: range.endTime },
          ...(engine === "open" && originalSound !== "everything" && { originalSound }),
        }
      : null;
  const estimate = useRemovalEstimate(body);
  const est = estimate.data && !estimate.isError ? estimate.data : undefined;

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
          : !eraser
            ? mode === "click" && engine === "open"
              ? "Switch to Type it or Paint it"
              : "problem" in choice
                ? choice.problem
                : "Pick how to point at it"
            : !marked
              ? mode === "type"
                ? "Say what to remove"
                : mode === "click"
                  ? "Click what to remove on the first frame"
                  : "Paint over what to remove"
              : estimate.isError
                ? (estimate.error as Error).message
                : null;
  const blocker = setupBlocker;

  const start = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "remove-blocker" });
    void runGuard(JSON.stringify(body), (requestId) => actions.run.mutateAsync({ ...body, requestId }))
      .then((r) => {
        if (!r) return;
        const ratio = size.width && size.height ? size.width / size.height : undefined;
        setRun({ final: r.final.id, ids: r.items.map((g) => g.id), before: clip!.preview, start: range!.startTime, ratio });
        toast("Removing it", { description: "Follow it below — it lands in your Library too." });
      })
      .catch((e: Error) => toastError(e));
  };

  const canPreview = !!body && est?.previewUsd != null;
  const makePreview = () => {
    if (!body || !canPreview || !est) return;
    const of = { exact: est.previewExact, eraser: est.modelName, green: est.previewGreen };
    void previewGuard(JSON.stringify(body), (requestId) => actions.preview.mutateAsync({ ...body, requestId }))
      .then((g) => g && setPreviewOf({ id: g.id, ...of }))
      .catch((e: Error) => toastError(e));
  };
  const preview = useGeneration(previewOf?.id ?? null).data;

  return (
    <ToolShell title="Video tools" wide>
      {!clip && (
        <ToolHero
          title={personAsked ? "Remove a person from a video" : "Remove anything from a video"}
          subtitle={
            personAsked
              ? `Name who goes, check their green mask, and the scene is rebuilt behind them — redo any part that comes out weak, free on your own ComfyUI.`
              : `Type what goes, click it, or paint over it — the gap is filled frame by frame and the sound stays, free on your own ComfyUI.`
          }
        />
      )}
      <div className={cn("mx-auto", clip ? "pt-4" : "mt-8 max-w-[640px]")}>
        {!clip ? (
          <ClipDrop
            accept={REMOVE.accept}
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
                    min={REMOVE.minSeconds}
                    max={REMOVE.maxSeconds}
                    duration={clip.info?.duration}
                    label="Part of the clip to clean up"
                    hint={duration && duration > REMOVE.maxSeconds ? `Pick up to ${REMOVE.maxSeconds} s — only that part comes out` : "The whole clip, or just the part you need"}
                    onMeta={source.setBrowserMeta}
                  />
                </div>
              </Panel>
              <div ref={framePanel} className="scroll-mt-[120px]">
                <Panel
                  title="First frame"
                  aside={
                    mode === "click" && engine === "cloud" ? (
                      <Segmented
                        label="What a click marks"
                        value={pointLabel}
                        onChange={setPointLabel}
                        className="w-auto"
                        options={[
                          { value: "positive", label: "Remove" },
                          { value: "negative", label: "Keep" },
                        ]}
                      />
                    ) : null
                  }
                >
                  {frame ? (
                    <FrameStage
                      frame={frame}
                      points={mode === "click" ? points : []}
                      onPoints={mode === "click" && engine === "cloud" ? setPoints : undefined}
                      pointLabel={pointLabel}
                      overlay={mode === "paint" ? paint?.overlay : undefined}
                      clickable={mode === "click" && engine === "cloud"}
                      maxPoints={REMOVE.maxPoints}
                    />
                  ) : (
                    <div className="grid aspect-video place-items-center rounded-xl bg-muted text-[13px] text-muted-foreground">
                      {frameError ? (
                        <p className="max-w-xs px-4 text-center">This browser can&apos;t show the clip&apos;s frames (an H.265 or ProRes file?). Type it works without them.</p>
                      ) : (
                        <Loader2 className="size-5 animate-spin" aria-label="Reading the first frame" />
                      )}
                    </div>
                  )}
                  <p className="mt-2 text-[12px] text-muted-foreground">{frameHint(mode, engine, points.length, !!paint)}</p>
                  {/* Said for the eraser picked now (the preview itself is SAM's, whichever eraser runs). */}
                  {preview && previewOf && <MaskPreview g={preview} exact={est?.previewExact ?? previewOf.exact} eraser={est?.modelName ?? previewOf.eraser} green={previewOf.green} />}
                </Panel>
              </div>
            </div>

            <Panel className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)]">
              <Field label="How do you point at it?">
                <Segmented
                  label="How do you point at it?"
                  value={mode}
                  onChange={pickMode}
                  options={REMOVE_MODES.map((m) => ({ value: m.id, label: m.label }))}
                />
              </Field>

              {mode === "type" && (
                <Field label="What to remove" htmlFor="remove-what" hint={everyone ? "Not needed: every person goes" : undefined}>
                  <Textarea
                    id="remove-what"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={everyone}
                    maxLength={REMOVE.maxPromptChars}
                    rows={3}
                    placeholder="e.g. “the coffee cup in her hand”"
                    className="resize-none"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {REMOVE_EXAMPLES.map((x) => (
                      <button
                        key={x.label}
                        type="button"
                        disabled={everyone}
                        onClick={() => setPrompt(x.prompt)}
                        className="inline-flex h-7 items-center rounded-full bg-muted px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {mode === "click" && engine === "open" && (
                <div className="space-y-2 rounded-xl bg-muted/60 p-3 text-[13px]" role="status">
                  <p>{CLICK_OPEN_PROBLEM}.</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => pickMode("type")}>
                      <Type className="size-3.5" /> Type it
                    </Button>
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => pickMode("paint")}>
                      <Brush className="size-3.5" /> Paint it
                    </Button>
                    {engineMode === "both" && (
                      <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEngine("cloud")}>
                        <Cloud className="size-3.5" /> Use the cloud
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {mode === "click" && engine === "cloud" && (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    {points.length ? `${points.length} point${points.length === 1 ? "" : "s"}` : "No points yet"} — click the object; switch to Keep for things next to it that stay.
                  </p>
                  <Button size="sm" variant="ghost" className="rounded-full" disabled={!points.length} onClick={() => setPoints(points.slice(0, -1))}>
                    <Undo2 className="size-3.5" /> Undo
                  </Button>
                </div>
              )}

              {mode === "paint" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button className="rounded-full" variant={paint ? "outline" : "default"} disabled={!frame} onClick={() => setPainting(true)}>
                    <Brush className="size-4" /> {paint ? "Touch up the paint" : "Paint over it"}
                  </Button>
                  {paint && (
                    <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setPaint(null)}>
                      <RotateCcw className="size-3.5" /> Clear
                    </Button>
                  )}
                  <p className="w-full text-[12px] text-muted-foreground">
                    {engine === "open" ? "SAM 3.1 follows what you paint through the clip." : "SAM 3.1 follows what you paint through the clip, then Bria erases it."} Painting needs a mouse, pen or finger — Type it works from the keyboard.
                  </p>
                </div>
              )}

              {clip?.url && (
                <p className="text-[12px] text-muted-foreground">
                  Want something in its place?{" "}
                  <Link href={`/genjutsu?mode=swap&video=${encodeURIComponent(clip.url)}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                    Swap it with Genjutsu
                  </Link>
                </p>
              )}

              {mode === "type" && (
                <label className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">Shadows and reflections too</span>
                    <span className="block text-[12px] leading-snug text-muted-foreground">VOID also removes what the object causes: its shadow, reflections, things it moves</span>
                  </span>
                  <Switch checked={effects} onCheckedChange={setEffects} disabled={everyone} aria-label="Shadows and reflections too" />
                </label>
              )}

              {eraser && options.length > 1 && !(mode === "type" && effects) && (
                <Field label="Eraser">
                  <EraserList options={options} value={eraser.id} onChange={(id) => setPicked((p) => ({ ...p, [choiceKey]: id }))} />
                </Field>
              )}
              {eraser && (options.length <= 1 || (mode === "type" && effects)) && (
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground">{eraser.label}</span> · {eraser.note}
                </p>
              )}

              {personOnCloud && (
                <div className="space-y-2 rounded-xl bg-muted/60 p-3 text-[13px]" role="status">
                  <p className="flex gap-1.5">
                    <Cpu className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Removing a person with MiniMax H3 runs on your GPU (open source): the person is filled green and the scene rebuilt behind them. In the cloud, Kling O3 Omni or Bria erase who you name, and LTX
                      Clean Plate removes everyone.
                    </span>
                  </p>
                  {engineMode === "both" && (
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEngine("open")}>
                      <Cpu className="size-3.5" /> Use your GPU
                    </Button>
                  )}
                </div>
              )}

              {personOff && (
                <p className="flex gap-1.5 rounded-xl bg-muted/60 p-3 text-[13px]" role="status">
                  <Cpu className="mt-0.5 size-3.5 shrink-0" />
                  <span>Person removal with MiniMax H3 is turned off here{eraser ? `, so ${eraser.label} is used instead` : ""}.</span>
                </p>
              )}

              {h3 && (
                <Field label="Mask expansion" htmlFor="remove-grow" hint={`${REMOVE.maskGrow.min}–${REMOVE.maskGrow.max} px`}>
                  <div className="flex items-center gap-2">
                    <Input
                      id="remove-grow"
                      type="number"
                      inputMode="numeric"
                      min={REMOVE.maskGrow.min}
                      max={REMOVE.maskGrow.max}
                      value={maskGrow}
                      onChange={(e) => setMaskGrow(Math.max(REMOVE.maskGrow.min, Math.min(REMOVE.maskGrow.max, Math.round(Number(e.target.value) || 0))))}
                      className="h-9 w-24"
                    />
                    <span className="text-[12px] leading-snug text-muted-foreground">Grow it if a hand, hair or shadow shows outside the green; more makes H3 invent more background.</span>
                  </div>
                </Field>
              )}
              {clip?.info?.hasAudio !== false && <OriginalSoundPicker engine={engine} value={originalSound} onChange={setOriginalSound} />}

              <div className="space-y-3 border-t pt-3">
                {body && est?.previewUsd != null && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="rounded-full" onClick={makePreview} disabled={actions.preview.isPending || (preview && (preview.status === "queued" || preview.status === "running"))}>
                      {actions.preview.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />} {est.previewGreen ? "Check the green mask" : "Preview the mask"}
                    </Button>
                    <span className="min-w-0 text-[12px] leading-snug text-muted-foreground">
                      first {REMOVE.previewSeconds} s · {est.demo ? "demo" : engine === "open" ? "free" : costText({ costUsd: est.previewUsd, demo: false }, "cloud")}
                      {!est.previewExact && ` · how SAM 3.1 reads it — ${est.modelName} finds the object itself`}
                    </span>
                  </div>
                )}
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
                            {est.modelName} · {est.seconds} s{est.pieces > 1 ? ` in ${est.pieces} ${engine === "open" ? "windows" : "pieces"}` : ""}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <Button className="rounded-full" onClick={start} disabled={!!blocker || actions.run.isPending}>
                    {actions.run.isPending ? <Loader2 className="size-4 animate-spin" /> : <EraserIcon className="size-4" />} Remove it
                  </Button>
                </div>
                {est && est.notes.length > 0 && !blocker && (
                  <ul className="space-y-1 text-[12px] leading-snug text-muted-foreground">
                    {est.notes.map((n) => (
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

      {run && <RunPanel run={run} onAgain={start} onRedo={(r) => setRun({ ...run, final: r.final.id, ids: r.items.map((g) => g.id) })} />}

      {earlier.length > 0 && (
        <section className="mt-10" aria-labelledby="earlier-windows">
          <h3 id="earlier-windows" className="mb-1 font-heading text-[22px]">
            Redo a window
          </h3>
          <p className="mb-3 text-[13px] text-muted-foreground">Your earlier person removals, window by window. Open one to redo a weak part.</p>
          <div className="space-y-2">
            {earlier.map((g) => (
              <details key={g.id} className="group rounded-xl border px-3 py-2">
                <summary className="cursor-pointer truncate text-[13px] font-medium">{g.request.batchTitle ?? g.request.title ?? "Remove a person"}</summary>
                <WindowReview
                  g={g}
                  onRedo={(r) => setRun({ final: r.final.id, ids: r.items.map((x) => x.id), before: g.request.inputs?.video ?? g.outputs.find((o) => o.kind === "video")?.url ?? "", start: 0 })}
                />
              </details>
            ))}
          </div>
        </section>
      )}

      {(history.data?.length ?? 0) > 0 && (
        <section className="mt-10" aria-labelledby="removals">
          <h3 id="removals" className="mb-3 font-heading text-[22px]">
            Your removals
          </h3>
          <Feed items={history.data!} />
        </section>
      )}

      {frame && (
        <SketchEditor
          open={painting}
          onOpenChange={setPainting}
          image={frame.url}
          mode="mask"
          initialStrokes={paint?.strokes}
          onDone={(r) => r.mask && setPaint({ mask: r.mask, overlay: r.overlay, strokes: r.strokes })}
        />
      )}
    </ToolShell>
  );
}

function frameHint(mode: RemoveMode, engine: "cloud" | "open", points: number, painted: boolean): string {
  if (mode === "type") return "Name it in the panel — the first frame is here to check what you mean.";
  if (mode === "click") return engine === "open" ? "Points need the cloud engine's SAM 3.1 — the open graphs follow words or paint." : points ? "Add more points on the same object, or mark what stays with Keep." : "Click the object you want gone. Keyboard: arrows move the crosshair, Enter adds a point.";
  return painted ? "Red is what goes. Touch up the paint, or clear it to start over." : "Paint over what should go — the paint only needs to cover it on this frame.";
}

/** The erasers for this engine and way of pointing, one line each (what it's good at, its limits). */
function EraserList({ options, value, onChange }: { options: Eraser[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Eraser" onKeyDown={radioKeys} className="space-y-1.5">
      {options.map((e) => (
        <button
          key={e.id}
          type="button"
          role="radio"
          aria-checked={value === e.id}
          tabIndex={radioTab(value === e.id)}
          onClick={() => onChange(e.id)}
          className={cn(
            "flex w-full min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            value === e.id && "border-primary bg-brand-faint hover:bg-brand-faint-hover",
          )}
        >
          <span className={cn("mt-1 size-3 shrink-0 rounded-full border-2", value === e.id ? "border-primary bg-primary" : "border-border-strong")} />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">{e.label}</span>
            <span className="block text-[12px] leading-snug text-muted-foreground">{e.note}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The mask preview: SAM 3.1's mask video (cloud) or the SAM 3 matte (open), white = what goes. When the eraser finds
 * the object itself (Kling O3 edit, Bria by name, Bria's own clicks), it's only SAM 3.1's reading of what you said.
 */
function MaskPreview({ g, exact, eraser, green }: { g: Generation; exact: boolean; eraser: string; green?: boolean }) {
  const out = g.outputs.find((o) => o.kind === "video");
  return (
    <div className="mt-3 rounded-xl border p-2.5">
      <p className="mb-2 text-[12px] font-medium">
        {green ? (
          <>
            Green mask <span className="font-normal text-muted-foreground">· green is what H3 rebuilds — keep every part of the person covered</span>
          </>
        ) : exact ? (
          <>
            Mask preview <span className="font-normal text-muted-foreground">· white is what goes</span>
          </>
        ) : (
          <>
            How SAM 3.1 reads it <span className="font-normal text-muted-foreground">· white is what it finds; {eraser} finds the object itself, so its result can differ</span>
          </>
        )}
      </p>
      {g.status === "succeeded" && out ? (
        <video
          src={out.url}
          autoPlay
          loop
          muted
          playsInline
          className="max-h-48 w-full rounded-lg bg-media object-contain"
        />
      ) : g.status === "failed" || g.status === "canceled" ? (
        <p className="text-[12px] text-destructive">{g.error ?? "The preview didn't finish"}</p>
      ) : (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {g.message ?? "Making the preview…"}
        </p>
      )}
    </div>
  );
}

/** What a removal's steps are doing, then the result with a before / after wipe (and, for H3, each window to redo). */
function RunPanel({ run, onAgain, onRedo }: { run: Run; onAgain: () => void; onRedo: (r: { final: Generation; items: Generation[] }) => void }) {
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
        title={<span id="run-title">{final?.request.title ?? "Your removal"}</span>}
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
          <>
            <VideoCompare before={run.before} after={out.url} start={run.start} ratio={run.ratio} />
            {(list ?? []).map((g) => (reviewOfOutput(g.outputs.find((o) => o.kind === "video")?.meta) ? <WindowReview key={g.id} g={g} onRedo={onRedo} /> : null))}
          </>
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
      </Panel>
    </section>
  );
}

/**
 * H3 Person Removal's windows (H3 Relay's Review Windows): each 22-frame window's preview, and "Redo from here" with a
 * new seed — every window before it comes back exactly, the ones after it continue from the new one.
 */
function WindowReview({ g, onRedo }: { g: Generation; onRedo: (r: { final: Generation; items: Generation[] }) => void }) {
  const review = reviewOfOutput(g.outputs.find((o) => o.kind === "video")?.meta)!;
  const actions = useRemovalActions();
  const guard = useSubmitGuard();
  const [busy, setBusy] = useState<number | null>(null);
  const redo = (index: number) => {
    // A new seed for the window: the server draws one.
    const body = { id: g.id, window: index };
    setBusy(index);
    void guard(`${g.id}:${index}`, (requestId) => actions.reroll.mutateAsync({ ...body, requestId }))
      .then((r) => {
        if (!r) return;
        onRedo(r);
        toast(`Redoing from window ${index + 1}`, { description: "The windows before it stay exactly as they are." });
      })
      .catch((e: Error) => toastError(e))
      .finally(() => setBusy(null));
  };
  const fps = 24;
  const why = (index: number) => rerollProblem(review, index);
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-medium">Windows</h4>
        <p className="text-[12px] text-muted-foreground">A weak part? Redo it with a new seed — every window before it is kept.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {review.windows.map((w) => {
          const video = w.video ? review.links[w.video] : undefined;
          const poster = w.poster ? review.links[w.poster] : undefined;
          const from = (w.start / fps).toFixed(1);
          return (
            <li key={w.index} className="min-w-0 rounded-xl border p-2">
              {video && /^\/api\/files\//.test(video) ? (
                <video src={video} poster={poster} muted loop playsInline controls className="aspect-video w-full rounded-lg bg-media object-cover" />
              ) : poster && /^(\/api\/files\/|data:)/.test(poster) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={poster} alt={`Window ${w.index + 1}`} className="aspect-video w-full rounded-lg bg-media object-cover" />
              ) : (
                <div className="grid aspect-video w-full place-items-center rounded-lg bg-muted text-[12px] text-muted-foreground">No preview</div>
              )}
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                  {w.index + 1} · {from} s{w.reused ? " · kept" : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 rounded-full px-2 text-[12px]"
                  disabled={busy !== null || !!why(w.index)}
                  title={why(w.index) ?? undefined}
                  onClick={() => redo(w.index)}
                  aria-label={`Redo from here, window ${w.index + 1}`}
                >
                  {busy === w.index ? <Loader2 className="size-3 animate-spin" /> : <Dices className="size-3" />} Redo from here
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
