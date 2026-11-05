"use client";

import { OriginalSoundPicker } from "@/components/av/original-sound-picker";
import type { OriginalSound } from "@/lib/av/original-sound";
import { ArrowDown, ArrowRight, Cloud, Cpu, Info, Loader2, Search, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { OldFootageOffer } from "@/components/restore/old-footage";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { VideoTrimmer } from "@/components/studio/video-trimmer";
import { useAskBeforeUpload, useEngine, useModelAccess } from "@/lib/api";
import {
  clipShapeProblem,
  coveredFirst,
  rangeProblem,
  SHORTS,
  SHORTS_CATEGORIES,
  SHORTS_LANGUAGES,
  SHORTS_PRESETS,
  SHORTS_ORIGINAL,
  SHORTS_RATIOS,
  shortsPreview,
  type ShortsCustomPreset,
  type ShortsRatio,
} from "@/lib/catalog/shorts";
import type { RestyleModelInfo } from "@/lib/catalog/shorts-models";
import type { Engine } from "@/lib/catalog/types";
import type { TrimRange } from "@/lib/trim-range";
import { keepOffered, offered } from "@/lib/model-access";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow, useSwapFade } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { CustomPresetDialog } from "./custom-preset-dialog";
import { useShortsActions, useShortsEstimate, useShortsPresets, useSubmitGuard, type ShortsBody } from "./hooks";
import { CreateCard, CustomCard, LookCard } from "./preset-card";
import { ShortsHistory } from "./history";
import { ClipBar, ClipDrop, costText, Field, Segmented, Steps, tabKeys } from "./ui";
import { clipDuration, clipSize, useSourceClip } from "./use-source-clip";
import { plainTagline } from "@/lib/plain-tagline";

export type ModelChoice = RestyleModelInfo;

const STEPS = ["Choose preset", "Upload video", "Download"];
const CUSTOM = "Created by you";

/** Shorts Studio: choose a preset → upload and trim a clip → generate a session (then /shorts/[id]). */
export function ShortsStudio({ models }: { models: Record<Engine, ModelChoice[]> }) {
  const [tab, setTab] = useState<"presets" | "history">("presets");
  const body = useSwapFade<HTMLDivElement>(tab);
  const [engine, setEngine] = useEngine();
  // Restyle models switched off in Settings → Models & licences leave the menu (the default is the first one on).
  const access = useModelAccess();
  const engineModels = keepOffered(models[engine], (m) => offered(access, m.id, engine));
  const [presetId, setPresetId] = useState<string | null>(null);
  const source = useSourceClip(SHORTS.maxBytes);
  const { clip } = source;
  const [range, setRange] = useState<TrimRange | null>(null);

  // Hand-offs: /shorts?tab=history, ?preset=shorts-claymation, ?video=/api/files/….
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect -- read once after hydration (no Suspense boundary needed) */
    if (p.get("tab") === "history") setTab("history");
    const preset = p.get("preset");
    if (preset) setPresetId(preset);
    /* eslint-enable react-hooks/set-state-in-effect */
    const video = p.get("video");
    if (video?.startsWith("/api/files/")) source.adopt(video, video.split("/").pop());
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTab = (t: "presets" | "history") => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "history") url.searchParams.set("tab", "history");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="min-w-0 truncate font-heading text-[22px] leading-none">Shorts Studio</h1>
        <TabRow role="tablist" aria-label="Shorts Studio" onKeyDown={tabKeys} fade={false} className="ml-1 shrink-0 sm:ml-3">
          {(["presets", "history"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => pickTab(t)}
              className={TAB_PILL}
              {...onAttr(tab === t)}
            >
              {t === "presets" ? "Presets" : "History"}
            </button>
          ))}
        </TabRow>
        <div className="ml-auto shrink-0">
          {/* A phone's header has room for the title and the tabs, not "Add key" too. */}
          <EngineSwitch value={engine} onChange={setEngine} wordless />
        </div>
        <PhoneNavButton />
      </header>
      <div ref={body} className="mx-auto w-full max-w-[1240px] min-w-0 flex-1 px-4 pb-28 sm:px-6 lg:pb-16">
        {tab === "history" ? (
          <ShortsHistory onStart={() => pickTab("presets")} />
        ) : (
          <>
            <div className="mx-auto max-w-[720px] pt-8 pb-6 text-center sm:pt-12">
              <p className="text-[12px] font-semibold tracking-[0.14em] text-brand-text uppercase">Restyle your own footage</p>
              <h2 className="mt-2 font-heading text-display text-balance">Give your footage the spotlight</h2>
              <p className="mx-auto mt-2 max-w-[560px] text-body text-pretty text-muted-foreground">
                Upload a clip up to 2 minutes, pick a look, and get a finished short. Your motion and sound stay.
              </p>
              <Steps steps={STEPS} current={!presetId ? 0 : !clip?.url ? 1 : 1} className="mt-5" />
            </div>
            <Workspace
              engine={engine}
              models={engineModels}
              presetId={presetId}
              setPresetId={setPresetId}
              source={source}
              range={range}
              setRange={setRange}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Workspace({
  engine,
  models,
  presetId,
  setPresetId,
  source,
  range,
  setRange,
}: {
  engine: Engine;
  models: ModelChoice[];
  presetId: string | null;
  setPresetId: (id: string) => void;
  source: ReturnType<typeof useSourceClip>;
  range: TrimRange | null;
  setRange: (r: TrimRange | null) => void;
}) {
  const custom = useShortsPresets();
  const [dialog, setDialog] = useState<{ open: boolean; preset?: ShortsCustomPreset }>({ open: false });
  const setup = useRef<HTMLElement>(null);
  const selectedBuiltIn = SHORTS_PRESETS.find((p) => p.id === presetId);
  const selectedCustom = custom.data?.find((p) => p.id === presetId);
  const selectedName = selectedBuiltIn?.name ?? selectedCustom?.name;
  // A preset of your own is made of pictures you upload: a guest is asked to sign up first, and an account with neither
  // its own GPU nor its own key to connect one (as before any upload).
  const askFirst = useAskBeforeUpload();

  // Phones: after picking a look, a bar points down to the upload step until it's on screen.
  const [setupVisible, setSetupVisible] = useState(false);
  useEffect(() => {
    const el = setup.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setSetupVisible(e.isIntersecting), { rootMargin: "0px 0px -30% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
      <section aria-labelledby="shorts-step-1" className="min-w-0 space-y-4">
        <PresetGrid
          custom={custom.data ?? []}
          presetId={presetId}
          onSelect={setPresetId}
          onCreate={() => askFirst() || setDialog({ open: true })}
          onEdit={(id) => setDialog({ open: true, preset: custom.data?.find((p) => p.id === id) })}
        />
      </section>
      <aside ref={setup} id="shorts-setup" aria-labelledby="shorts-step-2" className="scrollbar-none min-w-0 scroll-mt-16 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)] lg:max-h-[calc(var(--content-h)-4.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-2xl">
        <SetupPanel
          engine={engine}
          models={models}
          presetId={presetId}
          presetName={selectedName}
          customRefs={selectedCustom?.references.length ?? 0}
          customDescribed={!!selectedCustom?.description.trim()}
          source={source}
          range={range}
          setRange={setRange}
        />
      </aside>
      {selectedName && !setupVisible && (
        <div className="fixed inset-x-3 bottom-[max(calc(var(--chrome-bottom)+0.75rem),env(safe-area-inset-bottom))] z-30 lg:hidden">
          <button
            type="button"
            onClick={() => setup.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex h-12 w-full items-center gap-2 rounded-full bg-foreground px-4 text-[14px] font-medium text-background shadow-strong"
          >
            <Sparkles className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{selectedName}</span>
            <span className="flex shrink-0 items-center gap-1">
              Upload video <ArrowDown className="size-4" />
            </span>
          </button>
        </div>
      )}
      <CustomPresetDialog open={dialog.open} preset={dialog.preset} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} onSaved={(p) => setPresetId(p.id)} />
    </div>
  );
}

function PresetGrid({
  custom,
  presetId,
  onSelect,
  onCreate,
  onEdit,
}: {
  custom: ShortsCustomPreset[];
  presetId: string | null;
  onSelect: (id: string) => void;
  onCreate?: () => void;
  onEdit: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const grid = useSwapFade<HTMLDivElement>(cat);
  const query = useDeferredValue(q.trim().toLowerCase());
  const cats = ["All", ...(custom.length ? [CUSTOM] : []), ...SHORTS_CATEGORIES];
  const list = useMemo(
    () => coveredFirst(SHORTS_PRESETS.filter((p) => (cat === "All" || p.category === cat) && (!query || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(query)))),
    [cat, query],
  );
  const mine = custom.filter((p) => (cat === "All" || cat === CUSTOM) && (!query || `${p.name} ${p.description}`.toLowerCase().includes(query)));
  const showBuiltIn = cat !== CUSTOM;
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <h3 id="shorts-step-1" className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-6 place-items-center rounded-full bg-primary text-[12px] text-primary-foreground">1</span>
          Choose a preset
        </h3>
        <div className="relative w-full sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${SHORTS_PRESETS.length} presets`}
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
      <TabRow role="group" aria-label="Categories" follow>
        {cats.map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={TAB_PILL} {...onAttr(cat === c)}>
            {c}
          </button>
        ))}
      </TabRow>
      <div ref={grid} className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-4">
        {onCreate && !query && (cat === "All" || cat === CUSTOM) && <CreateCard onClick={onCreate} />}
        {mine.map((p) => (
          <CustomCard key={p.id} {...p} selected={presetId === p.id} onSelect={onSelect} onEdit={onEdit} />
        ))}
        {showBuiltIn &&
          list.map((p) => (
            <LookCard key={p.id} id={p.id} name={p.name} description={p.description} preview={shortsPreview(p)} hue={p.hue} selected={presetId === p.id} onSelect={onSelect} badge={p.type ? "Type" : undefined} />
          ))}
      </div>
      {showBuiltIn && !list.length && !mine.length && (
        <div className="py-12 text-center">
          <p className="font-heading text-[22px]">No presets match “{q.trim()}”</p>
          <button type="button" onClick={() => (setQ(""), setCat("All"))} className="mt-3 h-8 rounded-full border px-3 text-[13px] font-medium hover:bg-accent">
            Clear filters
          </button>
        </div>
      )}
    </>
  );
}

const LIMITS = "MP4 or MOV · 4 s to 2 min · up to 200 MB";

function SetupPanel({
  engine,
  models,
  presetId,
  presetName,
  customRefs,
  customDescribed,
  source,
  range,
  setRange,
}: {
  engine: Engine;
  models: ModelChoice[];
  presetId: string | null;
  presetName?: string;
  customRefs: number;
  /** The custom preset has words of its own (a words-only model has something to go on). */
  customDescribed: boolean;
  source: ReturnType<typeof useSourceClip>;
  range: TrimRange | null;
  setRange: (r: TrimRange | null) => void;
}) {
  const router = useRouter();
  const { clip } = source;
  const [ratio, setRatio] = useState<ShortsRatio>("9:16");
  const [language, setLanguage] = useState("auto");
  // What of the clip's sound goes back (the cloud: all of it).
  const [originalSound, setOriginalSound] = useState<OriginalSound>("everything");
  const [pickedModel, setModel] = useState<Record<Engine, string>>({ cloud: "", open: "" });
  // A custom preset is its reference images: on cloud, start on the first model that reads them
  // (Kling O3 4K Edit, then Happy Horse) unless a model was picked.
  const refModel = models.find((m) => m.refs > 0)?.id;
  // A pick that has since been switched off in Settings → Models & licences counts as no pick.
  const pickedOn = models.some((m) => m.id === pickedModel[engine]) ? pickedModel[engine] : "";
  const modelId = pickedOn || (customRefs > 0 && engine === "cloud" && refModel ? refModel : models[0]?.id);
  const model = models.find((m) => m.id === modelId);
  const priceOf = (m?: ModelChoice) => m?.price;
  const duration = clipDuration(clip);
  const actions = useShortsActions();
  const presetType = SHORTS_PRESETS.find((p) => p.id === presetId)?.type;

  const size = clipSize(clip);
  const shortsRange = range ? { start: range.startTime, end: range.endTime } : null;
  const problem = clipShapeProblem(size.width, size.height) ?? (shortsRange ? rangeProblem(shortsRange, duration) : null);
  const estimateBody: ShortsBody | null =
    presetId && shortsRange && !problem
      ? {
          engine,
          presetId,
          source: {
            url: clip?.url ?? "/api/files/placeholder.mp4",
            name: clip?.name,
            duration,
            ...(size.width && size.height ? { width: size.width, height: size.height } : {}),
            ...(clip?.info?.fps ? { fps: clip.info.fps } : {}),
          },
          range: shortsRange,
          aspectRatio: ratio,
          language,
          modelId,
          ...(engine === "open" && originalSound !== "everything" && { originalSound }),
        }
      : null;
  const estimate = useShortsEstimate(estimateBody);
  const est = estimate.data;

  const blocker = !presetId
    ? "Pick a preset first"
    : !clip
      ? "Upload a video"
      : clip.error
        ? clip.error
        : !duration || !range
          ? "Reading the clip…"
          : problem
            ? problem
            : customRefs > 0 && engine === "cloud" && model && !model.refs && !customDescribed
              ? "Describe the look in your preset, or pick a model that reads reference images"
              : clip.uploading
                ? clip.progress < 1
                  ? `Uploading… ${Math.round(clip.progress * 100)}%`
                  : "Reading the clip…"
                : estimate.error
                  ? (estimate.error as Error).message
                  : null;

  const guard = useSubmitGuard();
  const [leaving, setLeaving] = useState(false);
  const busy = actions.create.isPending || leaving;
  const generate = () => {
    if (blocker) return void toast(blocker, { id: "shorts-blocker" });
    if (busy || !estimateBody) return;
    // One session per click: a second click while this one is on its way does nothing (and the
    // server answers a repeated request id with the session it already started).
    void guard(JSON.stringify(estimateBody), (requestId) => actions.create.mutateAsync({ ...estimateBody, requestId }), { hold: true })
      .then((s) => {
        if (!s) return;
        setLeaving(true);
        router.push(`/shorts/${s.id}`);
      })
      .catch((e: Error) => toastError(e));
  };

  return (
    <div className="space-y-5 rounded-2xl border bg-background p-4 shadow-soft sm:p-5">
      <h3 id="shorts-step-2" className="flex items-center gap-2 text-[15px] font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-primary text-[12px] text-primary-foreground">2</span>
        Upload your video
      </h3>
      <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
        <Sparkles className="size-4 shrink-0 text-brand-text" />
        {presetName ? (
          <span className="min-w-0 truncate">
            Preset: <span className="font-medium">{presetName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Please select a preset</span>
        )}
      </div>

      {!clip ? (
        <ClipDrop
          accept={SHORTS.accept}
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
            src={clip.preview}
            value={range}
            onChange={setRange}
            min={SHORTS.minSeconds}
            max={SHORTS.maxSeconds}
            duration={clip.info?.duration}
            label="Part of the clip to restyle"
            onMeta={source.setBrowserMeta}
          />
          {clip.url && !clip.uploading && !clip.error && <OldFootageOffer url={clip.url} src={clip.preview} />}
        </div>
      )}

      <Field label="Output">
        <Segmented
          label="Output ratio"
          value={ratio}
          onChange={setRatio}
          options={SHORTS_RATIOS.map((r) => ({ value: r.value, label: r.label, hint: r.hint }))}
        />
      </Field>

      {clip && clip.info?.hasAudio !== false && <OriginalSoundPicker engine={engine} value={originalSound} onChange={setOriginalSound} />}

      <Field label="Language" hint={presetType ? "for the on-screen words" : "used by type presets"}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="w-full" aria-label="Language">
            <SelectValue>{language === "auto" ? "Auto-detect" : language}</SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="auto">Auto-detect</SelectItem>
            {SHORTS_LANGUAGES.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Model" hint={engine === "open" ? <span className="inline-flex items-center gap-1"><Cpu className="size-3" /> Open source</span> : <span className="inline-flex items-center gap-1"><Cloud className="size-3" /> Cloud</span>}>
        {models.length > 1 ? (
          <Select value={modelId} onValueChange={(v) => setModel((m) => ({ ...m, [engine]: v }))}>
            <SelectTrigger className="w-full" aria-label="Restyle model">
              <SelectValue>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{model?.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{priceOf(model)}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{priceOf(m)}</span>
                    {m.refs > 0 && <span className="shrink-0 rounded bg-brand-faint px-1 text-[10px] text-brand-text">refs</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="rounded-lg border px-3 py-2 text-[13px]">
            <span className="font-medium">{model?.name ?? "—"}</span> <span className="text-muted-foreground">· {priceOf(model)}</span>
          </div>
        )}
        {model && (
          <p className="text-[12px] leading-snug text-muted-foreground">
            {engine === "open"
              ? "Each part of up to 5 s takes the look on its first frame, then every frame follows it."
              : model.id === SHORTS_ORIGINAL
                ? "Fuobe Original: the look is painted on, then carried through every frame."
                : plainTagline(model.tagline)}
          </p>
        )}
        {customRefs > 0 && engine === "cloud" && model && !model.refs && (
          <p className="flex gap-1.5 text-[12px] leading-snug text-warning">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {model.name} restyles from words only — your reference images are used by {models.filter((m) => m.refs).map((m) => m.name).join(" and ")}.
          </p>
        )}
      </Field>

      <div className="space-y-3 border-t pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">{est ? `${est.segments} segment${est.segments === 1 ? "" : "s"} · ${est.seconds} s` : "Estimate"}</span>
          <span className="flex items-center gap-1.5 font-mono text-[13px] font-medium tabular-nums" aria-live="polite">
            {estimate.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            {estimateBody ? costText(est, engine) : "—"}
          </span>
        </div>
        {est && !est.demo && engine === "cloud" && <p className="text-[12px] text-muted-foreground">You&apos;re only charged for the actual length.</p>}
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
          disabled={busy}
          aria-disabled={!!blocker || busy}
          aria-describedby={blocker ? "shorts-blocker" : undefined}
          className={cn(
            "flex h-11 w-full items-center justify-center gap-2 rounded-full text-[14px] font-medium transition-colors",
            blocker ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {busy ? "Starting your short…" : "Generate short"}
          <ArrowRight className="size-4" />
        </button>
        {blocker && (
          <p id="shorts-blocker" className="text-center text-[12px] text-muted-foreground">
            {blocker}
          </p>
        )}
        <p className="text-center text-[12px] text-muted-foreground">Next: export as one video, or download the parts separately.</p>
      </div>
    </div>
  );
}
