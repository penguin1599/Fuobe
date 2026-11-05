"use client";

import { OriginalSoundPicker } from "@/components/av/original-sound-picker";
import type { OriginalSound } from "@/lib/av/original-sound";
import { ArrowDown, Cloud, Cpu, Download, ImageIcon, Info, Loader2, Search, Sparkles, Wand2, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { MediaThumb } from "@/components/studio/result-media";
import { VideoTrimmer, type VideoTrimmerHandle } from "@/components/studio/video-trimmer";
import { LookCard } from "@/components/shorts/preset-card";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { ClipBar, ClipDrop, costText, Field, Segmented, tabKeys } from "@/components/shorts/ui";
import { clipDuration, clipSize, useSourceClip } from "@/components/shorts/use-source-clip";
import { uploadFile, useEngine, useModelAccess, useStatus } from "@/lib/api";
import { paidSuffix, placeholdersOn } from "@/lib/demo-mode";
import { keepOffered, offered } from "@/lib/model-access";
import {
  clampFps,
  defaultValues,
  fpsChoices,
  FRAME_LIMITS,
  MIXED,
  MIXED_MODES,
  MIXED_ORIGINAL,
  MIXED_PRESETS,
  mixedFrames,
  mixedPreview,
  mixedRangeProblem,
  nearestResolution,
  type MixedMode,
  type MixedPreset,
  type MixedResolution,
  type MixedValues,
} from "@/lib/catalog/mixed-media";
import { chainState, clipLengthProblem } from "@/lib/catalog/shorts";
import type { RestyleModelInfo } from "@/lib/catalog/shorts-models";
import type { Engine, Generation } from "@/lib/catalog/types";
import { downloadHref, downloadName } from "@/lib/library";
import type { TrimRange } from "@/lib/trim-range";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow, useSwapFade } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import type { StudioExampleRow } from "@/lib/studio-examples";
import { MixedHistory } from "./history";
import { HowReveal } from "./how-reveal";
import { isFrameRender, renderSteps, useFramesProgress, useMixedActions, useMixedEstimate, useWatchedChain, useWatchedGeneration, type MixedBody } from "./hooks";
import { AdvancedSettings, loadSaved } from "./settings";
import { plainTagline } from "@/lib/plain-tagline";
import { templateCover } from "@/lib/template-covers";

type Tab = "presets" | "history" | "how";
const TABS: { id: Tab; label: string }[] = [
  { id: "presets", label: "All presets" },
  { id: "history", label: "History" },
  { id: "how", label: "How it works" },
];

const HOW = [
  { step: "Choose a preset", text: "Browse 33 mixed-media looks — sketch, comic, paper, neon, marble — and pick the one that fits your clip." },
  { step: "Upload your video", text: "Add a clip and trim it to up to 10 seconds. It needs at least 4 frames per second." },
  { step: "Customize settings", text: "Each preset has its own colours, materials and intensity. Save them per preset; they stay in this browser." },
  {
    step: "Generate & preview",
    text: "Make one preview frame first to check the look, then render the whole video, frame by frame at the rate you pick. Smooth draws only the first frame in the look and carries it through the clip.",
  },
];

/** What the cloud adds to "How it works", said only where the install offers the cloud. */
const HOW_CLOUD = " On the cloud, Fast restyles it in one video-to-video pass.";

const MODE_OPTIONS: { value: MixedMode; label: string; title: string }[] = [
  { value: "frames", label: "Per frame", title: "Every frame drawn again in the look, with a hand-made flicker" },
  { value: "smooth", label: "Smooth", title: "The first frame in the look, then carried through the clip by depth — no flicker" },
  { value: "fast", label: "Fast", title: "A partner video model restyles the whole clip in one pass" },
];

/** Mixed Media: pick a look, add a ≤10 s clip, tune the settings, preview one frame, render. */
export function MixedStudio({
  models,
  frameModels,
  how,
}: {
  models: Record<Engine, RestyleModelInfo[]>;
  frameModels: Record<Engine, RestyleModelInfo[]>;
  /** "How it works"'s reveal: one look playing out (studioExamples("mixed-media"), from the page). */
  how?: StudioExampleRow;
}) {
  const [tab, setTab] = useState<Tab>("presets");
  const body = useSwapFade<HTMLDivElement>(tab);
  const [engine, setEngine, engineMode] = useEngine();
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
    if (t === "history" || t === "how") setTab(t);
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "presets") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="sr-only font-heading text-[22px] leading-none sm:not-sr-only sm:truncate">Mixed Media</h1>
        <TabRow role="tablist" aria-label="Mixed Media" onKeyDown={tabKeys} follow className="sm:ml-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => pick(t.id)}
              className={TAB_PILL}
              {...onAttr(tab === t.id)}
            >
              {t.label}
            </button>
          ))}
        </TabRow>
        <div className="ml-auto shrink-0">
          {/* A phone's header has room for the tabs, not "Add key" too. */}
          <EngineSwitch value={engine} onChange={setEngine} wordless />
        </div>
        <PhoneNavButton />
      </header>
      <div ref={body} className="mx-auto w-full max-w-[1240px] min-w-0 flex-1 px-4 pb-28 sm:px-6 lg:pb-16">
        {tab === "history" ? (
          <MixedHistory onStart={() => pick("presets")} />
        ) : tab === "how" ? (
          <How onStart={() => pick("presets")} cloud={engineMode !== "open"} reveal={how} />
        ) : (
          <>
            <div className="mx-auto max-w-[720px] pt-8 pb-6 text-center sm:pt-12">
              <p className="text-[12px] font-semibold tracking-[0.14em] text-brand-text uppercase">No prompts, just vibe</p>
              <h2 className="mt-2 font-heading text-display text-balance">Turn any video into mixed-media art</h2>
              <p className="mx-auto mt-2 max-w-[560px] text-body text-pretty text-muted-foreground">
                33 looks, each with its own colours and materials. Preview one frame, then make the whole clip, free on your
                GPU.
              </p>
            </div>
            <Workspace engine={engine} models={models[engine]} frameModels={frameModels[engine]} />
          </>
        )}
      </div>
    </div>
  );
}

function How({ onStart, cloud, reveal }: { onStart: () => void; cloud: boolean; reveal?: StudioExampleRow }) {
  return (
    <div className="mx-auto max-w-[920px] pt-10">
      <h2 className="text-center font-heading text-[34px] leading-tight">How it works</h2>
      {!!reveal?.tiles.length && <HowReveal row={reveal} />}
      <ol className="mt-8 grid gap-3 sm:grid-cols-2">
        {HOW.map((h, i) => (
          <li key={h.step} className="rounded-2xl border bg-background p-5">
            <span className="grid size-7 place-items-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground">{i + 1}</span>
            <p className="mt-3 text-[15px] font-semibold">{h.step}</p>
            <p className="mt-1 text-[14px] text-muted-foreground">
              {h.text}
              {cloud && i === HOW.length - 1 && HOW_CLOUD}
            </p>
          </li>
        ))}
      </ol>
      <div className="mt-6 rounded-2xl bg-muted/60 p-5 text-[13px] text-muted-foreground">
        <p className="font-medium text-foreground">Cost</p>
        <p className="mt-1">
          A render is counted in frames: seconds × frame rate (10 s at 8 fps = 80 frames; at most 240). Fuobe Mixed Media draws every frame again in the
          look, free on your GPU
          {cloud ? ", or in the cloud at about a cent a frame. Nano Banana 2.1 and Seedream 5.0 Flash redraw frames too, priced per frame." : "."} Smooth draws only the
          first frame in the look, then every frame follows it{cloud ? ", priced per second. Fast restyles the clip in one pass, priced by the model" : ""}. You see
          the estimate before you generate.
        </p>
        <p className="mt-2">
          Over {FRAME_LIMITS.perClip} frames, the frames go back together as clips and are joined.
          {cloud &&
            ` Nano Banana 2.1 and Seedream redraw frames in runs of ${FRAME_LIMITS.lane} side by side, each frame matching the one before it and each run starting from your preview frame, so their look can shift slightly every ${FRAME_LIMITS.lane} frames.`}{" "}
          If a frame fails, the frames still waiting stop, and Try again redraws only the frames that didn’t finish.
        </p>
      </div>
      <div className="mt-6 text-center">
        <button type="button" onClick={onStart} className="h-10 rounded-full bg-primary px-5 text-[14px] font-medium text-primary-foreground hover:bg-primary/90">
          Choose a preset
        </button>
      </div>
    </div>
  );
}

function Workspace({ engine, models, frameModels }: { engine: Engine; models: RestyleModelInfo[]; frameModels: RestyleModelInfo[] }) {
  const [hasClip, setHasClip] = useState(false);
  const [presetId, setPresetId] = useState<string | null>(null);
  const preset = MIXED_PRESETS.find((p) => p.id === presetId) ?? null;
  const [values, setValues] = useState<MixedValues>({});
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim().toLowerCase());
  // Looks with a real cover lead; the rest keep their order after them.
  const list = useMemo(() => {
    const hits = MIXED_PRESETS.filter((p) => !query || `${p.name} ${p.description}`.toLowerCase().includes(query));
    return [...hits.filter((p) => templateCover("mixed-media", p.id)), ...hits.filter((p) => !templateCover("mixed-media", p.id))];
  }, [query]);
  const panel = useRef<HTMLElement>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setPanelVisible(e.isIntersecting), { rootMargin: "0px 0px -30% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const select = (id: string) => {
    const p = MIXED_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setValues(loadSaved(p) ?? defaultValues(p));
  };
  // Hand-off: /mixed-media?preset=mixed-sketch.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("preset");
    if (!id) return;
    const p = MIXED_PRESETS.find((x) => x.id === id);
    if (!p) return;
    /* eslint-disable react-hooks/set-state-in-effect -- read once after hydration */
    setPresetId(id);
    setValues(loadSaved(p) ?? defaultValues(p));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
      <section aria-labelledby="mm-presets" className="min-w-0 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <h3 id="mm-presets" className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="grid size-6 place-items-center rounded-full bg-primary text-[12px] text-primary-foreground">1</span>
            Choose a preset
          </h3>
          <div className="relative w-full sm:ml-auto sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${MIXED_PRESETS.length} presets`}
              aria-label="Search presets"
              className="h-9 w-full rounded-full border bg-background pr-9 pl-9 text-[14px] outline-none placeholder:text-subtle-foreground focus:border-primary focus:ring-4 focus:ring-brand-faint [&::-webkit-search-cancel-button]:hidden"
            />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        {list.length ? (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-4">
            {list.map((p) => (
              <LookCard key={p.id} id={p.id} name={p.name} description={p.description} preview={mixedPreview(p)} hue={p.hue} selected={presetId === p.id} onSelect={select} />
            ))}
          </div>
        ) : (
          <div className="py-12 text-center">
            <p className="font-heading text-[22px]">No presets match “{q.trim()}”</p>
            <button type="button" onClick={() => setQ("")} className="mt-3 h-8 rounded-full border px-3 text-[13px] font-medium hover:bg-accent">
              Clear search
            </button>
          </div>
        )}
      </section>
      <aside ref={panel} id="mm-editor" className="scrollbar-none min-w-0 scroll-mt-16 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)] lg:max-h-[calc(var(--content-h)-4.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-2xl">
        <Editor engine={engine} models={models} frameModels={frameModels} preset={preset} values={values} setValues={setValues} onClip={setHasClip} />
      </aside>
      {preset && !panelVisible && (
        <div className="fixed inset-x-3 bottom-[max(calc(var(--chrome-bottom)+0.75rem),env(safe-area-inset-bottom))] z-30 lg:hidden">
          <button
            type="button"
            onClick={() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex h-12 w-full items-center gap-2 rounded-full bg-foreground px-4 text-[14px] font-medium text-background shadow-strong"
          >
            <Sparkles className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{preset.name}</span>
            <span className="flex shrink-0 items-center gap-1">
              {hasClip ? "Settings & render" : "Add a clip"} <ArrowDown className="size-4" />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

const LIMITS = "MP4 or MOV · 1 to 10 s · up to 50 MB · at least 4 FPS";
type FpsChoice = number | "manual";

function Editor({
  engine,
  models: restyleModels,
  frameModels,
  preset,
  values,
  setValues,
  onClip,
}: {
  engine: Engine;
  models: RestyleModelInfo[];
  frameModels: RestyleModelInfo[];
  preset: MixedPreset | null;
  values: MixedValues;
  setValues: (v: MixedValues) => void;
  /** Whether a clip is loaded (the phone bar says what's next). */
  onClip?: (has: boolean) => void;
}) {
  const source = useSourceClip(MIXED.maxBytes);
  const { clip } = source;
  const hasClip = !!clip;
  useEffect(() => onClip?.(hasClip), [hasClip, onClip]);
  // Hand-off: /mixed-media?video=/api/files/… (a result or a Library clip).
  useEffect(() => {
    const video = new URLSearchParams(window.location.search).get("video");
    if (video?.startsWith("/api/files/")) source.adopt(video, video.split("/").pop());
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const trimmer = useRef<VideoTrimmerHandle>(null);
  const [range, setRange] = useState<TrimRange | null>(null);
  const [fpsChoice, setFpsChoice] = useState<FpsChoice>(MIXED.defaultFps as number);
  const [manual, setManual] = useState<number>(MIXED.defaultFps);
  const [resolution, setResolution] = useState<MixedResolution>("1K");
  // Frame by frame (the default, priced per frame), Smooth (the first frame, then carried through by depth) or, on the
  // cloud, Fast (one video-to-video pass). A mode the engine hasn't (Fast on your GPU) reads as Per frame.
  const [picked, setMode] = useState<MixedMode>("frames");
  const mode: MixedMode = MIXED_MODES[engine].includes(picked) ? picked : "frames";
  const cloud = engine === "cloud";
  const frameMode = mode === "frames";
  const smooth = mode === "smooth";
  // Models switched off in Settings → Models & licences leave the menu, and the pick falls back to one that is on.
  const access = useModelAccess();
  const models = keepOffered(
    smooth ? frameModels.filter((m) => m.id === MIXED_ORIGINAL) : frameMode ? frameModels : restyleModels,
    (m) => offered(access, m.id, engine),
  );
  const slot = `${engine}:${mode}`;
  const [pickedModel, setModel] = useState<Record<string, string>>({});
  const modelId = (models.some((m) => m.id === pickedModel[slot]) && pickedModel[slot]) || models[0]?.id;
  const model = models.find((m) => m.id === modelId);
  const priceOf = (m?: RestyleModelInfo) => m?.price;
  const original = modelId === MIXED_ORIGINAL;
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Every main step of the latest render (cut → frames or restyle → sound), so a failed step shows its own error.
  const [renderIds, setRenderIds] = useState<string[]>([]);
  const [renderFrames, setRenderFrames] = useState(0);
  const [anchorOff, setAnchorOff] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const actions = useMixedActions();
  const preview = useWatchedGeneration(previewId).data;
  const render = useWatchedChain(renderIds);

  const duration = clipDuration(clip);
  const sourceFps = clip?.info?.fps;
  // A choice above the clip's own frame rate drops to the highest one allowed ("Uploaded video has 6 FPS" → 4).
  const choices = fpsChoices(sourceFps);
  const allowedFps = choices.filter((c) => !c.disabled);
  const fpsShown: FpsChoice = typeof fpsChoice === "number" && choices.find((c) => c.fps === fpsChoice)?.disabled ? (allowedFps.at(-1)?.fps ?? "manual") : fpsChoice;
  const fps = clampFps(fpsShown === "manual" ? manual : fpsShown, sourceFps);
  const mmRange = range ? { start: range.startTime, end: range.endTime } : null;
  const seconds = mmRange ? mmRange.end - mmRange.start : 0;
  const problem = mmRange ? mixedRangeProblem(mmRange, duration, sourceFps) : null;
  const frames = mmRange ? mixedFrames(seconds, fps) : 0;
  // Fast restyles the cut as video: the resolution is the model's own setting nearest to 1K / 2K / 4K
  // (choices that land on the same one are off). Per frame draws each frame at 1K–4K (Seedream and the Original up to 2K
  // in the cloud; your GPU renders up to 1536 px). Smooth renders at its own size (720p in the cloud, 480p on your GPU).
  const fast = cloud && mode === "fast";
  const lengthIssue = (m: RestyleModelInfo) => (fast && seconds ? clipLengthProblem(m, seconds) : null);
  const resOptions = MIXED.resolutions.map((r, i) => {
    if (frameMode) {
      const capped = r === "4K" && cloud && (modelId === "seedream-5-flash" || original);
      return { value: r, label: r, hint: undefined, disabled: capped, title: capped ? `${model?.name} draws frames up to 2K` : `Each frame at ${r}` };
    }
    const at = fast ? nearestResolution(model?.resolutions, r) : undefined;
    const prev = i > 0 && fast ? nearestResolution(model?.resolutions, MIXED.resolutions[i - 1]) : undefined;
    return { value: r, label: r, hint: at, disabled: fast && !!at && at === prev, title: fast && at === prev ? `${model?.name} renders up to ${at}` : at };
  });
  const showResolution = !smooth && (!fast || resOptions.some((o) => o.hint && !o.disabled && o.value !== "1K"));
  const resShown: MixedResolution = resOptions.find((o) => o.value === resolution)?.disabled ? ([...resOptions].reverse().find((o) => !o.disabled)?.value ?? "1K") : resolution;
  const modelRes = fast ? nearestResolution(model?.resolutions, resShown) : undefined;
  const previewImage = preview?.status === "succeeded" ? preview.outputs.find((o) => o.kind === "image") : undefined;
  // The partner editors start every run of frames from the approved preview; Fast only when the model takes a still. The
  // Original needs no anchor: frame 1 is drawn exactly as the preview was (same look, LoRA and seed).
  const anchor = cloud && !original && (frameMode || (fast && model?.image)) && previewImage && !anchorOff ? previewImage.url : undefined;
  const size = clipSize(clip);
  // What of the clip's sound goes back (the cloud: all of it).
  const [originalSound, setOriginalSound] = useState<OriginalSound>("everything");

  const body: MixedBody | null =
    preset && mmRange && !problem
      ? {
          engine,
          presetId: preset.id,
          values,
          source: {
            url: clip?.url ?? "/api/files/placeholder.mp4",
            name: clip?.name,
            duration,
            fps: sourceFps,
            // The frames' size on the Original (and so their price) follows the clip's shape.
            ...(size.width && size.height ? { width: size.width, height: size.height } : {}),
          },
          range: mmRange,
          fps,
          // Smooth has no Resolution control: its first frame is drawn at 1K (a 2K pick under Per frame doesn't carry over unseen).
          resolution: smooth ? "1K" : resShown,
          modelId,
          mode,
          ...(anchor ? { anchor } : {}),
          ...(!cloud && originalSound !== "everything" && { originalSound }),
        }
      : null;
  const estimate = useMixedEstimate(body);
  const est = estimate.data;
  // The preview frame is a run of its own: on the cloud its button says its price (the estimate's, per frame), else "· paid";
  // nothing on your GPU (free) or while placeholders are on.
  const placeholders = placeholdersOn(useStatus().data?.demoMode);
  const previewPaid = cloud && !(est ? est.demo : placeholders) ? paidSuffix(est?.previewUsd) : "";

  // A new clip, preset or engine starts without a preview (and so does another frame editor: the preview is its own work).
  const key = `${preset?.id}|${clip?.preview}|${engine}|${mode === "fast" ? "" : modelId}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setPreviewId(null);
    setAnchorOff(false);
  }

  const setupBlocker = !preset
    ? "Pick a preset first"
    : !clip
      ? "Add a clip"
      : clip.error
        ? clip.error
        : !duration || !range
          ? "Reading the clip…"
          : problem
            ? problem
            : model && lengthIssue(model)
              ? `${lengthIssue(model)} — select more, or pick another model`
              : clip.uploading
                ? clip.progress < 1
                  ? `Uploading… ${Math.round(clip.progress * 100)}%`
                  : "Reading the clip…"
                : estimate.error
                  ? (estimate.error as Error).message
                  : null;
  const blocker = setupBlocker;

  // One preview and one render per click: a second click while one is on its way does nothing,
  // and the server answers a repeated request id with what the first one started.
  const previewGuard = useSubmitGuard();
  const renderGuard = useSubmitGuard();
  const previewBusy = actions.preview.isPending || grabbing;
  const makePreview = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "mm-blocker" });
    if (previewBusy) return;
    void previewGuard(JSON.stringify(body), async (requestId) => {
      let frameUrl: string | undefined;
      if (engine === "cloud") {
        setGrabbing(true);
        try {
          const blob = await trimmer.current?.grabFrame(range!.startTime);
          if (!blob) throw new Error("This browser can't read frames of this clip — try an MP4 (H.264), or generate the full video");
          frameUrl = (await uploadFile(new File([blob], "frame.jpg", { type: "image/jpeg" }))).url;
        } finally {
          setGrabbing(false);
        }
      }
      const g = await actions.preview.mutateAsync({ ...body, frameUrl, requestId });
      setPreviewId(g.id);
    }).catch((e: Error) => toastError(e));
  };

  const generate = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "mm-blocker" });
    if (actions.render.isPending) return;
    void renderGuard(JSON.stringify(body), (requestId) => actions.render.mutateAsync({ ...body, requestId }))
      .then((r) => {
        if (!r) return;
        setRenderIds(r.items.map((g) => g.id));
        setRenderFrames(r.frames ?? 0);
        toast("Rendering your video", { description: "It shows up in History too." });
      })
      .catch((e: Error) => toastError(e));
  };

  return (
    <div className="space-y-5 rounded-2xl border bg-background p-4 shadow-soft sm:p-5">
      <div className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-text" />
        {preset ? (
          <span className="min-w-0">
            <span className="font-medium">{preset.name}</span> <span className="text-muted-foreground">· {preset.description}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Pick a preset to start</span>
        )}
      </div>

      <Field label="Your video">
        {!clip ? (
          <ClipDrop
            accept={MIXED.accept}
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
          <div className="space-y-3">
            <ClipBar
              clip={clip}
              onRemove={() => {
                source.clear();
                setRange(null);
              }}
            />
            <VideoTrimmer
              ref={trimmer}
              src={clip.preview}
              value={range}
              onChange={setRange}
              min={MIXED.minSeconds}
              max={MIXED.maxSeconds}
              duration={clip.info?.duration}
              label="Part of the clip to transform"
              onMeta={source.setBrowserMeta}
            />
          </div>
        )}
      </Field>

      <Field
        label="Restyle"
        hint={frameMode ? `Every frame drawn again${cloud ? " · priced per frame" : " · free on your GPU"}` : smooth ? `First frame, then carried through${cloud ? " · priced per second" : " · free on your GPU"}` : "One video-to-video pass · priced by the model"}
      >
        <Segmented<MixedMode> label="Restyle" value={mode} onChange={setMode} options={MODE_OPTIONS.filter((o) => MIXED_MODES[engine].includes(o.value))} />
      </Field>

      {frameMode && (
        <Field label="Frame rate" hint={sourceFps ? `Uploaded video has ${Math.round(sourceFps)} FPS` : "8 FPS is the classic stop-motion look"}>
          <Segmented<FpsChoice>
            label="Frame rate"
            value={fpsShown}
            onChange={setFpsChoice}
            options={[
              ...choices.map((c) => ({ value: c.fps as FpsChoice, label: String(c.fps), disabled: c.disabled, title: c.disabled ? "Above the clip's own frame rate" : `${c.fps} FPS` })),
              { value: "manual" as FpsChoice, label: "Manual" },
            ]}
          />
          {fpsShown === "manual" && (
            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
              Choose frames manually
              <input
                type="number"
                min={MIXED.manualFps.min}
                max={Math.min(MIXED.manualFps.max, sourceFps ? Math.floor(sourceFps) : MIXED.manualFps.max)}
                value={manual}
                onChange={(e) => setManual(Number(e.target.value) || MIXED.manualFps.min)}
                aria-label="Frames per second"
                className="h-7 w-16 rounded-md border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-brand-faint"
              />
              FPS
            </label>
          )}
          {fps !== (fpsShown === "manual" ? manual : fpsShown) && <p className="text-[12px] text-warning">Using {fps} FPS — the clip itself has no more frames than that.</p>}
          {fpsShown !== fpsChoice && <p className="text-[12px] text-muted-foreground">Using {fps} FPS — {fpsChoice} is above the clip&apos;s own frame rate.</p>}
        </Field>
      )}

      {showResolution && (
        <Field label="Resolution" hint={cloud && modelRes ? `${model?.name} renders at ${modelRes}` : undefined}>
          <Segmented<MixedResolution> label="Resolution" value={resShown} onChange={setResolution} options={resOptions} />
        </Field>
      )}

      {preset && <AdvancedSettings preset={preset} values={values} onChange={setValues} />}

      <Field
        label="Model"
        hint={
          engine === "open" ? (
            <span className="inline-flex items-center gap-1">
              <Cpu className="size-3" /> Open source
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Cloud className="size-3" /> Cloud
            </span>
          )
        }
      >
        {models.length > 1 ? (
          <Select value={modelId} onValueChange={(v) => setModel((m) => ({ ...m, [slot]: v }))}>
            <SelectTrigger className="w-full" aria-label="Model">
              <SelectValue>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{model?.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{priceOf(model)}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => {
                const issue = lengthIssue(m);
                return (
                  <SelectItem key={m.id} value={m.id} disabled={!!issue && m.id !== modelId}>
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{m.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{priceOf(m)}</span>
                      </span>
                      {issue && <span className="text-[11px] text-muted-foreground">{issue}</span>}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <div className="rounded-lg border px-3 py-2 text-[13px]">
            <span className="font-medium">{model?.name ?? "—"}</span> <span className="text-muted-foreground">· {priceOf(model)}</span>
          </div>
        )}
        {model && (
          <p className="text-[12px] leading-snug text-muted-foreground">
            {smooth
              ? `Fuobe Original: the first frame takes the look, then every frame follows it${cloud ? ", at 720p" : " (480p, 16 fps on your GPU)"}.`
              : original
                ? "Fuobe Original: every frame drawn again in the look, along its own outlines."
                : plainTagline(model.tagline)}
          </p>
        )}
      </Field>

      <div className="space-y-2 rounded-xl border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Preview frame</span>
          <span className="font-mono text-[12px] text-muted-foreground tabular-nums">Preview costs: {est ? costText({ costUsd: est.previewUsd, demo: est.demo }, engine) : "—"}</span>
        </div>
        <p className="text-[12px] text-muted-foreground">Generate one frame with your current settings before creating the full video.</p>
        {preview && (
          <div className="relative mx-auto aspect-video w-full max-w-[320px] overflow-hidden rounded-lg bg-muted">
            {preview.status === "succeeded" && preview.outputs[0] ? (
              <MediaThumb output={preview.outputs[0]} fit />
            ) : preview.status === "failed" || preview.status === "canceled" ? (
              <div className="grid size-full place-items-center p-3 text-center text-[12px] text-muted-foreground">{preview.error ?? "Canceled"}</div>
            ) : (
              <div className="skeleton-sweep grid size-full animate-skeleton place-items-center">
                <span className="shimmer-text animate-shimmer-text text-[12px] font-medium">Restyling one frame…</span>
              </div>
            )}
          </div>
        )}
        {/* The cloud draws the preview and the frames on one route; your GPU draws a Per frame preview on the per-frame graph
            itself (a one-frame clip), but Smooth's first frame on another (Z-Image's image-to-image), so it says nothing there. */}
        {original && (cloud ? !!previewImage : frameMode && preview?.status === "succeeded") && (
          <p className="flex items-center gap-1.5 text-[12px] text-brand-text">
            <Wand2 className="size-3.5 shrink-0" /> {smooth ? "The first frame is drawn just like this, then carried through the clip" : "Every frame is drawn just like this one"}
          </p>
        )}
        {anchor && (
          <p className="flex items-center gap-1.5 text-[12px] text-brand-text">
            <Wand2 className="size-3.5 shrink-0" /> {frameMode ? "Every frame is matched to this one" : `${model?.name} follows this frame for the whole video`}
            <button type="button" onClick={() => setAnchorOff(true)} className="ml-auto text-muted-foreground underline-offset-2 hover:underline">
              Don&apos;t use it
            </button>
          </p>
        )}
        <button
          type="button"
          onClick={makePreview}
          disabled={previewBusy}
          aria-disabled={!!blocker || previewBusy}
          className={cn(
            "flex h-9 w-full items-center justify-center gap-2 rounded-full border text-[13px] font-medium",
            blocker ? "text-muted-foreground" : "bg-background hover:bg-accent",
          )}
        >
          {previewBusy ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
          <span>
            {preview ? "Generate another preview frame" : "Generate preview frame"}
            {previewPaid}
          </span>
        </button>
      </div>

      {clip && clip.info?.hasAudio !== false && <OriginalSoundPicker engine={engine} value={originalSound} onChange={setOriginalSound} />}

      <div className="space-y-3 border-t pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">
            {!mmRange
              ? "Estimate"
              : fast
                ? `${seconds.toFixed(1)} s${modelRes ? ` · ${modelRes}` : ""}`
                : smooth
                  ? `${seconds.toFixed(1)} s · ${cloud ? "720p" : "480p, 16 FPS"}`
                  : `${est?.frames ?? frames} frames · ${+(est?.fps ?? fps).toFixed(2)} FPS`}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[13px] font-medium tabular-nums" aria-live="polite">
            {estimate.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            {body ? costText(est, engine) : "—"}
          </span>
        </div>
        {frameMode && cloud && est && !est.demo && typeof est.perFrameUsd === "number" && (
          <p className="text-[12px] text-muted-foreground tabular-nums">
            {est.frames} frames × ${est.perFrameUsd.toFixed(3).replace(/0$/, "")} a frame ({model?.name}), plus a few cents to cut and rebuild the clip
          </p>
        )}
        {clip?.url && !clip.uploading && !clip.error && clip.info && clip.info.hasAudio === undefined && (
          <p className="flex gap-1.5 text-[12px] leading-snug text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Couldn&apos;t read this clip&apos;s sound track — it&apos;s made without sound.
          </p>
        )}
        {est?.notes.map((n) => (
          <p key={n} className="flex gap-1.5 text-[12px] leading-snug text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {n}
          </p>
        ))}
        <button
          type="button"
          onClick={generate}
          disabled={actions.render.isPending}
          aria-disabled={!!blocker || actions.render.isPending}
          aria-describedby={blocker ? "mm-blocker" : undefined}
          className={cn(
            "flex h-11 w-full items-center justify-center gap-2 rounded-full text-[14px] font-medium transition-colors",
            blocker ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {actions.render.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Generate video
        </button>
        {blocker && (
          <p id="mm-blocker" className="text-center text-[12px] text-muted-foreground">
            {blocker}
          </p>
        )}
        {render.length > 0 && <LatestRender chain={render} frames={renderFrames} />}
      </div>
    </div>
  );
}

/** The latest render: its steps' progress (a per-frame render counts its frames), the failing step's own error, or the video. */
function LatestRender({ chain, frames }: { chain: (Generation | undefined)[]; frames: number }) {
  const g = chain[chain.length - 1];
  // Steps still loading read as working, not as deleted.
  const steps = chain.some((x) => !x) ? null : chainState(renderSteps(chain));
  const perFrame = frames > 0 && isFrameRender(chain);
  const redrawing = perFrame && steps?.status === "working" && steps.label === "Redrawing the frames";
  const progress = useFramesProgress(perFrame ? g?.id : null, redrawing ? "live" : steps?.status === "failed" ? "once" : null).data;
  let state = steps ?? ({ status: "working", label: "Rendering", progress: 0 } as const);
  if (perFrame && state.status === "working") {
    // The frames are most of the work: the cut and the extraction fill the first tenth of the bar, redrawing the
    // frames the next eight, putting them back together (and the sound) the last tenth.
    const at = Math.max(1, chain.findIndex((x) => x?.op === "images-to-video")) / chain.length;
    const p = redrawing ? 0.1 + 0.8 * (progress?.total ? progress.done / progress.total : 0) : state.progress < at ? (state.progress / at) * 0.1 : 0.9 + ((state.progress - at) / (1 - at)) * 0.1;
    state = { ...state, progress: p, ...(redrawing && progress?.total ? { label: `Redrawing frames · ${progress.done} of ${progress.total}` } : {}) };
  }
  // A frame that failed on its own: say which and why (the steps after it only say an earlier step didn't finish).
  // When the cut or the extraction failed, no frame did: that step's own error stands.
  if (state.status === "failed" && progress?.failed) state = { ...state, label: `${progress.failed.label} failed`, error: progress.failed.error };
  const out = g?.status === "succeeded" ? g.outputs.find((o) => o.kind === "video") : undefined;
  return (
    <div className="space-y-2 rounded-xl bg-muted/50 p-3" aria-live="polite">
      <p className="text-[13px] font-medium">Your video</p>
      <div className="relative mx-auto aspect-video w-full overflow-hidden rounded-lg bg-muted">
        {out ? (
          <video src={out.url} controls playsInline preload="metadata" className="size-full bg-black object-contain" />
        ) : state.status === "failed" || state.status === "gone" ? (
          <div className="flex size-full flex-col justify-center gap-1 p-3 text-center">
            <p className="text-[13px] font-medium">{state.label}</p>
            {state.error && <p className="line-clamp-4 text-[12px] break-words text-muted-foreground">{state.error}</p>}
          </div>
        ) : (
          <div className="skeleton-sweep grid size-full animate-skeleton place-items-center">
            <span className="shimmer-text animate-shimmer-text text-[12px] font-medium">
              {g ? `${state.label}… ${Math.round(state.progress * 100)}%` : "Rendering…"}
            </span>
          </div>
        )}
      </div>
      {out && g && (
        <a href={downloadHref(out.url, downloadName(g, out, 0))} download={downloadName(g, out, 0)} className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-[12px] font-medium hover:bg-accent">
          <Download className="size-3.5" /> Download
        </a>
      )}
    </div>
  );
}
