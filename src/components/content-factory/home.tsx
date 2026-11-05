"use client";

import { ArrowRight, Bot, Film, Link2, Loader2, Minus, Plus, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { MediaThumb } from "@/components/studio/feed";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { Segmented, usd } from "@/components/faceless/controls";
import { NarratorChip } from "@/components/faceless/narrator";
import { StyleArt } from "@/components/faceless/style-art";
import { StarterParam } from "@/components/starters/starter-param";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { useEdgeFade } from "@/components/studio/use-edge-fade";
import { uploadFile, useAskBeforeUpload, useEngine, useHydrated, useIsOwner } from "@/lib/api";
import {
  ANIMATION_STYLES,
  CF_LENGTHS,
  getPreset,
  IDEA_EXAMPLES,
  MAX_EPISODES,
  MAX_PROMPT,
  PLATFORM_NOTE,
  referenceLink,
  type AnimationStyleId,
  type SeriesCard,
} from "@/lib/catalog/content-factory";
import { GENRES, type EpisodeAspect, type FacelessGenre, type NarratorVoice, type PickerData } from "@/lib/catalog/faceless";
import { starterShown, type StarterCardData, type StarterFill } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { ApiError, discardDraft, useCreateSeries, useGenerateSeries, useRereadSeries, useSeries, useSeriesEstimate, useSeriesList, useUpdateSeries, type SeriesAsk } from "./hooks";
import { BriefCard, ClaudeDialog, PresetGrid, ReferenceCard, SeriesPriceLine } from "./parts";

/** The clip being read stays in the composer across reloads (this browser only). */
const DRAFT_KEY = "fuobe.content-factory.draft";
const DEFAULT_PRESET = "what-if";

const readDraft = () => {
  try {
    return localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
};
const writeDraft = (id: string | null) => {
  try {
    if (id) localStorage.setItem(DRAFT_KEY, id);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {}
};

const STEPS = [
  { icon: Film, title: "Pick a style", text: "Upload a short you love, paste its link, or start from a trending preset." },
  { icon: Sparkles, title: "Get its brief", text: "Pacing, shots, captions, music mood, hook and narrator — read from the clip." },
  { icon: Bot, title: "Make the series", text: "Say what it's about, how long and how many episodes. Here, or in Claude." },
];

function chipTrigger(className?: string) {
  return cn("h-8 max-w-full gap-1 rounded-full border-0 bg-secondary px-3 text-[13px] font-medium shadow-none hover:bg-accent dark:bg-secondary dark:hover:bg-accent", className);
}

/**
 * starters: the ready series (src/lib/starters/catalog.ts), right under the composer while you have none, one row under
 * yours after; fills: what each one puts in the composer.
 */
export function ContentFactoryHome({ voices, starters: given = [], fills: givenFills = {} }: { voices: PickerData["voices"]; starters?: StarterCardData[]; fills?: Record<string, StarterFill> }) {
  const { starters, fills } = useStarters("content-factory", given, givenFills);
  const router = useRouter();
  const [engine, setEngine] = useEngine();
  const [mode, setMode] = useState<"here" | "claude">("here");
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET);
  // The series being read: picked in this visit, else the draft from an earlier one (this browser).
  const [picked, setSeriesId] = useState<string | null | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [genre, setGenre] = useState<FacelessGenre>("storytelling");
  const [animation, setAnimation] = useState<AnimationStyleId>("fully-animated");
  const [length, setLength] = useState(30);
  const [episodes, setEpisodes] = useState(1);
  const [aspect, setAspect] = useState<EpisodeAspect>("9:16");
  const [voice, setVoice] = useState<NarratorVoice | undefined>(undefined);
  const [review, setReview] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<{ message: string; upload: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [example, setExample] = useState(0);
  // The estimate's problem (no narrator voice yet…) is a hint until Generate is pressed.
  const [tried, setTried] = useState(false);
  // A clip of your own: a guest is asked to sign up first, and an account with neither its own GPU nor its own key to
  // connect one (reading it runs there).
  const askFirst = useAskBeforeUpload();
  const [exampleRow, exampleFade] = useEdgeFade<HTMLDivElement>();
  const file = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const ids = { prompt: useId(), link: useId(), voice: useId() };

  const hydrated = useHydrated();
  const candidate = picked !== undefined ? picked : hydrated ? readDraft() : null;
  const series = useSeries(candidate);
  // A draft that's gone (or already made) is let go.
  const gone = !!series.error || !!series.data?.made;
  const seriesId = gone ? null : candidate;
  const create = useCreateSeries();
  const generate = useGenerateSeries();
  const reread = useRereadSeries();
  const updateBrief = useUpdateSeries();
  const list = useSeriesList();
  const owner = useIsOwner();
  const hasSeries = !!list.data?.length;
  const readyShown = starters.some((s) => starterShown(s, !owner));

  useEffect(() => {
    if (gone) writeDraft(null);
  }, [gone]);

  const view = seriesId ? series.data : undefined;
  const briefFolded = !view && !hasSeries;
  const preset = getPreset(view?.reference?.presetId ?? presetId);
  const brief = view ? view.brief : (preset?.brief ?? null);
  const reading = view?.analysis?.status === "reading";
  const examples = brief?.topics.length ? brief.topics : IDEA_EXAMPLES;

  // A new brief brings its own look: the animation style, the shape (and a preset its genre).
  const briefKey = view ? `${view.id}:${view.analysis?.status}:${view.analysis?.engine}` : presetId;
  const [adopted, setAdopted] = useState<string | null>(null);
  if (brief && !reading && adopted !== briefKey) {
    setAdopted(briefKey);
    setAnimation(brief.animation);
    setAspect(brief.aspect);
    if (!view && preset) setGenre(preset.genre);
  }

  // The examples under the prompt rotate while it's empty.
  useEffect(() => {
    if (prompt) return;
    const t = setInterval(() => setExample((i) => i + 1), 3500);
    return () => clearInterval(t);
  }, [prompt]);

  const ask: SeriesAsk = { prompt: prompt.trim(), settings: { engine, length, episodes, animation, genre, aspect }, ...(voice && { voice }) };
  const source = seriesId ? { seriesId } : { presetId };
  // Priced again when the clip's brief comes in or is edited, not only when a setting changes.
  const estimate = useSeriesEstimate({ ...ask, prompt: ask.prompt || "estimate", ...source }, view ? `${view.analysis?.status ?? "none"}:${view.updatedAt}` : undefined);
  const perMinute = estimate.data?.analysisPerMinute ?? 0;

  /** The draft being left (another clip, a preset, X): reading it stops, so it stops billing, and its row goes. */
  const leaveDraft = (next?: string) => {
    if (seriesId && seriesId !== next) discardDraft(seriesId);
  };

  const choosePreset = (id: string) => {
    leaveDraft();
    setPresetId(id);
    setSeriesId(null);
    writeDraft(null);
    setLinkError(null);
  };

  const startSeries = (reference: Parameters<typeof create.mutate>[0]["reference"]) =>
    create.mutateAsync({ reference, engine }).then((v) => {
      leaveDraft(v.id);
      setSeriesId(v.id);
      writeDraft(v.id);
      setLinkOpen(false);
      setLink("");
      setLinkError(null);
      return v;
    });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm)$/i.test(f.name)) return void toast.error("Add a video clip (MP4, MOV or WebM)");
    setUploading(true);
    try {
      const asset = await uploadFile(f);
      await startSeries({ kind: "upload", url: asset.url, title: f.name });
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  const fetchLink = () => {
    const checked = referenceLink(link);
    if ("error" in checked) return setLinkError({ message: checked.error, upload: false });
    startSeries({ kind: "link", link: checked.url }).catch((e: Error) => setLinkError({ message: e.message, upload: e instanceof ApiError && e.needsUpload }));
  };

  /** A ready series in the composer: its trending style, its idea, its length; the style brings its own look. */
  const fill = (id: string) => {
    const f = fills[id];
    if (f?.kind !== "content-factory") return false;
    choosePreset(f.presetId);
    setPrompt(f.prompt);
    setLength(f.length);
    setEpisodes(f.episodes);
    // Open source narration clones a voice: the starter's own narrator, while it has one.
    if (engine === "open" && f.voiceSample) setVoice({ kind: "sample", url: f.voiceSample, name: "Narrator" });
    setMode("here");
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      promptRef.current?.focus({ preventScroll: true });
    });
    return true;
  };

  const blocker = !prompt.trim() ? "Say what the video is about" : reading ? "The reference is still being read — a moment" : !brief ? "Add a reference or pick a preset" : null;

  // One run at a time: a second Enter (or click) before the first request has re-rendered would plan, make and bill it twice.
  const submitting = useRef(false);
  const submit = async () => {
    if (submitting.current) return;
    setTried(true);
    if (blocker) {
      toast(blocker, { id: "cf-blocker" });
      if (!prompt.trim()) promptRef.current?.focus();
      return;
    }
    if (mode === "claude") return setClaudeOpen(true);
    submitting.current = true;
    try {
      // A preset becomes a series of its own (kept as the draft, so a retry doesn't make another).
      const id = seriesId ?? (await startSeries({ kind: "preset", presetId })).id;
      await generate.mutateAsync({ id, ...ask, review });
      writeDraft(null);
      router.push(`/content-factory/${id}`);
    } catch (e) {
      toastError(e);
    } finally {
      submitting.current = false;
    }
  };

  const busy = create.isPending || generate.isPending;
  const est = estimate.data;

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="truncate font-heading text-[22px] leading-none">Content Factory</h1>
        <div className="ml-auto">
          <EngineSwitch value={engine} onChange={setEngine} selfHostedOnly />
        </div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full max-w-[1240px] min-w-0 flex-1 space-y-12 px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-[780px] pt-[5vh] text-center sm:pt-[8vh]">
          <h2 className="font-heading text-display text-balance">Faceless shorts in the style of a video you love</h2>
          <p className="mx-auto mt-2 max-w-[600px] text-body text-muted-foreground">Show it a reference, say what to make, and get a whole series: script, narrator, pictures, motion, music and captions that follow the same pacing and look.</p>

          <div className="mt-7 rounded-[20px] border bg-background p-3 text-left shadow-soft transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint sm:rounded-composer sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented
                label="Generate with"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "here", label: "Generate here", hint: "Fuobe makes the episodes now" },
                  // Handing the brief to Claude Code needs Fuobe's own MCP server: the owner's.
                  ...(!owner ? [] : [{ value: "claude" as const, label: "Generate in Claude", hint: "Copy a prompt for Claude Code with Fuobe's MCP server" }]),
                ]}
              />
              <span className="text-[12px] text-muted-foreground">{mode === "claude" ? "Claude writes them and runs Fuobe over MCP" : engine === "open" ? "Makes the episodes now, on your ComfyUI" : "Makes the episodes now, with your providers"}</span>
            </div>

            {/* The reference: the brief every episode follows */}
            <div className="mt-3 space-y-2">
              {view?.reference ? (
                <ReferenceCard
                  reference={view.reference}
                  analysis={view.analysis}
                  styleId={view.brief?.styleId ?? "colorful-3d"}
                  onClear={() => choosePreset(DEFAULT_PRESET)}
                  onReread={() => reread.mutate({ id: view.id, engine }, { onError: (e) => toastError(e) })}
                  rereading={reread.isPending}
                />
              ) : seriesId && series.isLoading ? (
                <Skeleton className="h-[72px] rounded-2xl" />
              ) : preset ? (
                <ReferenceCard reference={{ kind: "preset", presetId: preset.id, title: `Preset: ${preset.name}` }} analysis={null} styleId={preset.brief.styleId} />
              ) : null}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => askFirst() || file.current?.click()}
                  disabled={uploading || create.isPending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent disabled:opacity-60"
                >
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {uploading ? "Uploading…" : view?.reference?.url ? "Change video" : "Add a video"}
                </button>
                {/* A link is fetched by the studio's server: the owner's. A visitor adds the clip itself. */}
                {owner && (
                  <button
                    type="button"
                    onClick={() => setLinkOpen((v) => !v)}
                    aria-expanded={linkOpen}
                    aria-controls={ids.link}
                    className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium disabled:opacity-60", linkOpen ? "bg-brand-faint text-brand-text" : "bg-secondary hover:bg-accent")}
                  >
                    <Link2 className="size-3.5" /> TikTok or Instagram link
                  </button>
                )}
                <a href="#presets" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent">
                  <Sparkles className="size-3.5" /> Presets
                </a>
                <span className="text-[12px] text-muted-foreground">
                  {engine === "open" ? "Reading a clip is free (Gemma 4 on your ComfyUI)" : perMinute > 0 ? `Reading a clip costs about ${usd(perMinute)} a minute` : "Reading a clip makes a free placeholder"}
                </span>
                <input ref={file} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden onChange={(e) => (void onFile(e.target.files?.[0]), (e.target.value = ""))} />
              </div>
              {linkOpen && owner && (
                <div id={ids.link} className="space-y-1.5 rounded-2xl bg-muted/60 p-2.5">
                  <form
                    className="flex min-w-0 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      fetchLink();
                    }}
                  >
                    <label htmlFor={`${ids.link}-in`} className="sr-only">
                      Link to a TikTok, Instagram reel or video file
                    </label>
                    <input
                      id={`${ids.link}-in`}
                      value={link}
                      onChange={(e) => {
                        setLink(e.target.value);
                        setLinkError(null);
                      }}
                      inputMode="url"
                      placeholder="https://www.tiktok.com/@…/video/…"
                      aria-invalid={!!linkError}
                      aria-describedby={`${ids.link}-note${linkError ? ` ${ids.link}-err` : ""}`}
                      className="h-9 min-w-0 flex-1 rounded-full border bg-background px-3 text-[13px] outline-none focus:border-primary"
                    />
                    <Button type="submit" size="sm" className="h-9 shrink-0 rounded-full" disabled={!link.trim() || create.isPending}>
                      {create.isPending ? <Loader2 className="animate-spin" /> : null}
                      {create.isPending ? "Fetching…" : "Use"}
                    </Button>
                  </form>
                  {linkError && (
                    <div id={`${ids.link}-err`} role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-destructive">
                      <span className="min-w-0">{linkError.message}</span>
                      {linkError.upload && (
                        <Button type="button" variant="secondary" size="sm" className="h-7 rounded-full" onClick={() => file.current?.click()}>
                          <Upload /> Upload the clip
                        </Button>
                      )}
                    </div>
                  )}
                  <p id={`${ids.link}-note`} className="text-[11px] leading-snug text-muted-foreground">
                    {PLATFORM_NOTE}
                  </p>
                </div>
              )}
            </div>

            <label htmlFor={ids.prompt} className="mt-3 block px-1 text-[12px] font-medium text-muted-foreground">
              Make a video about…
            </label>
            <textarea
              id={ids.prompt}
              ref={promptRef}
              value={prompt}
              maxLength={MAX_PROMPT}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder={`${examples[example % examples.length]}…`}
              className="mt-1 w-full resize-none bg-transparent px-1 text-body leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle-foreground"
            />
            <div ref={exampleRow} style={exampleFade} className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {examples.slice(0, 5).map((ex) => (
                <button key={ex} type="button" onClick={() => setPrompt(ex)} className="h-7 shrink-0 rounded-full bg-secondary px-2.5 text-[12px] text-secondary-foreground hover:bg-accent">
                  {ex}
                </button>
              ))}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-3">
              <Select value={genre} onValueChange={(v) => setGenre(v as FacelessGenre)}>
                <SelectTrigger aria-label="Genre" className={chipTrigger()}>
                  <SelectValue>{GENRES.find((g) => g.id === genre)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {GENRES.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      <span className="flex flex-col">
                        <span>{g.label}</span>
                        <span className="text-[12px] text-muted-foreground">{g.hint}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={animation} onValueChange={(v) => setAnimation(v as AnimationStyleId)}>
                <SelectTrigger aria-label="Animation style" className={chipTrigger()}>
                  <SelectValue>{ANIMATION_STYLES.find((a) => a.id === animation)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[min(92vw,380px)]">
                  {ANIMATION_STYLES.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex flex-col whitespace-normal">
                        <span>{a.label}</span>
                        <span className="text-[12px] leading-snug text-muted-foreground">{engine === "open" ? a.openCopy : a.copy}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(length)} onValueChange={(v) => setLength(Number(v))}>
                <SelectTrigger aria-label="Length of each episode" className={chipTrigger()}>
                  <SelectValue>{CF_LENGTHS.find((l) => l.value === length)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CF_LENGTHS.map((l) => (
                    <SelectItem key={l.value} value={String(l.value)}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div role="group" aria-label="Episodes" className="inline-flex h-8 items-center rounded-full bg-secondary">
                <button type="button" onClick={() => setEpisodes((n) => Math.max(1, n - 1))} disabled={episodes <= 1} className="grid size-8 place-items-center rounded-full hover:bg-accent disabled:opacity-40" aria-label="Fewer episodes">
                  <Minus className="size-3.5" />
                </button>
                <span className="min-w-[5.5rem] text-center text-[13px] font-medium tabular-nums" aria-live="polite">
                  {episodes} episode{episodes === 1 ? "" : "s"}
                </span>
                <button type="button" onClick={() => setEpisodes((n) => Math.min(MAX_EPISODES, n + 1))} disabled={episodes >= MAX_EPISODES} className="grid size-8 place-items-center rounded-full hover:bg-accent disabled:opacity-40" aria-label="More episodes">
                  <Plus className="size-3.5" />
                </button>
              </div>
              <Select value={aspect} onValueChange={(v) => setAspect(v as EpisodeAspect)}>
                <SelectTrigger aria-label="Shape" className={chipTrigger()}>
                  <SelectValue>{aspect === "9:16" ? "9:16" : "16:9"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="9:16">Vertical 9:16 · TikTok, Reels, Shorts</SelectItem>
                  <SelectItem value="16:9">Horizontal 16:9 · YouTube</SelectItem>
                </SelectContent>
              </Select>
              {mode === "here" && <NarratorChip engine={engine} voices={voices} value={voice ?? null} onChange={setVoice} />}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              {mode === "here" ? (
                <SeriesPriceLine data={est} loading={estimate.isFetching} engine={engine} className="min-w-0 flex-1 basis-56" />
              ) : (
                <p className="min-w-0 flex-1 basis-56 text-[12px] text-muted-foreground">Claude prices every episode and asks before it runs.</p>
              )}
              {mode === "here" && (
                <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <Switch checked={review} onCheckedChange={setReview} aria-label="Review each script before it renders" />
                  Review scripts first
                </label>
              )}
              <Button onClick={() => void submit()} disabled={busy} className="ml-auto h-9 rounded-full px-4">
                {busy ? <Loader2 className="animate-spin" /> : mode === "here" ? <ArrowRight /> : <Bot />}
                {busy ? "Planning your episodes…" : mode === "here" ? (episodes > 1 ? `Generate ${episodes} episodes` : "Generate") : "Get the prompt"}
              </Button>
            </div>
            {mode === "here" && est?.error && (
              <p role={tried ? "alert" : undefined} className={cn("mt-2 text-[12px]", tried ? "text-destructive" : "text-muted-foreground")}>
                {est.error}
              </p>
            )}
            {blocker && prompt.trim() && (
              <p className="mt-2 text-[12px] text-muted-foreground" aria-live="polite">
                {blocker}
              </p>
            )}
          </div>

          {brief && !reading && (
            <BriefCard
              // A preset's brief, before there are any series, is one line: the ready series sit right under the composer.
              key={briefFolded ? "folded" : "open"}
              folded={briefFolded}
              className="mt-4"
              brief={brief}
              note={view?.analysis?.note}
              saving={updateBrief.isPending}
              onSave={async (b) => {
                try {
                  // A preset's brief, edited, becomes a series of its own.
                  const id = seriesId ?? (await startSeries({ kind: "preset", presetId })).id;
                  await updateBrief.mutateAsync({ id, brief: b });
                } catch (e) {
                  toastError(e);
                }
              }}
            />
          )}
        </div>

        {!list.isLoading && !hasSeries && <StarterSection surface="content-factory" starters={given} onFill={fill} />}

        <section id="presets" aria-labelledby="presets-title" className="scroll-mt-16 space-y-4">
          <div>
            <h2 id="presets-title" className="font-heading text-[24px]">
              Pick a trending style to start from
            </h2>
            <p className="text-[13px] text-muted-foreground">Ready-made briefs from formats that perform.</p>
          </div>
          <PresetGrid value={view ? (view.reference?.presetId ?? null) : presetId} onPick={(p) => choosePreset(p.id)} />
        </section>

        {(list.isLoading || hasSeries || !readyShown) && (
          <section aria-labelledby="series-title" className="space-y-4">
            <h2 id="series-title" className="font-heading text-[24px]">
              My series
            </h2>
            {list.isLoading ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
                ))}
              </div>
            ) : list.data?.length ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
                {list.data.map((s) => (
                  <SeriesTile key={s.id} s={s} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-10 text-center">
                <div className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">
                  <Film className="size-5" />
                </div>
                <p className="mt-3 font-heading text-[22px]">No series yet</p>
                <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">Pick a style above and say what to make: every episode lands here, and in Faceless Studio as a channel.</p>
              </div>
            )}
          </section>
        )}

        {hasSeries && <StarterSection surface="content-factory" starters={given} onFill={fill} row />}

        <section aria-label="How it works" className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex gap-3 rounded-2xl bg-muted/50 p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-background text-brand-text shadow-soft">
                <s.icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{s.text}</p>
              </div>
            </div>
          ))}
        </section>
      </div>
      <Suspense fallback={null}>
        <StarterParam onStarter={fill} />
      </Suspense>
      <ClaudeDialog open={claudeOpen} onOpenChange={setClaudeOpen} ask={claudeOpen ? { ...ask, ...source } : null} />
    </div>
  );
}

function SeriesTile({ s }: { s: SeriesCard }) {
  const picture = s.poster?.outputs.find((o) => o.kind === "image");
  return (
    <Link href={`/content-factory/${s.id}`} className="group/card card-motion block min-w-0 animate-fade-up rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className={cn("relative overflow-hidden rounded-xl bg-muted", s.aspect === "9:16" ? "aspect-[4/5]" : "aspect-video")}>
        {picture ? (
          <MediaThumb output={picture} className="card-zoom" />
        ) : s.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.thumbnail} alt="" className="size-full object-cover" />
        ) : (
          <StyleArt styleId={s.styleId} className="opacity-90" />
        )}
        {s.rendering > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
            <Loader2 className="size-3 animate-spin" /> {s.rendering} in progress
          </span>
        )}
      </div>
      <div className="mt-2 min-w-0 px-0.5">
        <h3 className="truncate text-[14px] font-medium">{s.name}</h3>
        <p className="truncate text-[12px] text-muted-foreground">
          {s.episodes} episode{s.episodes === 1 ? "" : "s"}
          {s.done ? ` · ${s.done} done` : ""}
        </p>
      </div>
    </Link>
  );
}
