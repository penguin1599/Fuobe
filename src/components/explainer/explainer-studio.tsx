"use client";

import { Download, FileText, Image as ImageIcon, Link2, Loader2, Paperclip, Search, Settings2, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { grabFrames } from "@/components/restore/hooks";
import { OldFootageOffer } from "@/components/restore/old-footage";
import { fileToSlot } from "@/components/studio/media-slot";
import { StarterParam } from "@/components/starters/starter-param";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { useAskBeforeUpload, useEngine, useIsOwner } from "@/lib/api";
import {
  ANIMATION_MODES,
  AUTO_SECONDS,
  defaultSettings,
  defaultVoice,
  EXPLAINER_DURATIONS,
  EXPLAINER_MAX,
  EXPLAINER_MIN,
  EXPLAINER_STYLE_IDS,
  genreInfo,
  getStyle,
  MAX_SOURCES,
  MAX_TOPIC,
  MUSIC_HINT,
  type EpisodeSettings,
  type ExplainerSource,
  type NarratorVoice,
  type PickerData,
} from "@/lib/catalog/faceless";
import { starterShown, type StarterCardData, type StarterFill } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { EpisodeTile } from "../faceless/cards";
import { EstimateLine, Segmented, ToggleRow } from "../faceless/controls";
import { readDocument, readLink, useCreateExplainer, useEstimate, useExplainers, useLikeEpisode } from "../faceless/hooks";
import { NarratorChip } from "../faceless/narrator";
import { StyleArt, StyleGrid } from "../faceless/style-art";

const DOC_TYPES = /\.(txt|md|markdown|csv|srt|vtt|json)$/i;
const MAX_DOC = 20_000;
/** PDF and Word files are read on the server. */
const READ_TYPES = /\.(pdf|docx)$/i;
const READ_MIME = /^application\/(pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/;
const MAX_READ_MB = 20;

/** " (12 pages)", or " (the first 20 of 150 pages)" when a long PDF was read only in part. */
const pagesNote = (r: { pages?: number; readPages?: number }) =>
  !r.pages ? "" : r.readPages ? ` (the first ${r.readPages} of ${r.pages} pages)` : ` (${r.pages} page${r.pages === 1 ? "" : "s"})`;

type Draft =
  | { kind: "image"; id: string; url: string; name: string; preview: string; uploading?: boolean }
  /** A PDF or Word file being read on the server. */
  | { kind: "reading"; id: string; name: string }
  | Exclude<ExplainerSource, { kind: "image" }>;

const STEPS = [
  { icon: Sparkles, title: "Choose a style", text: "One of 22 looks: whiteboard, pixel art, paper diorama…" },
  { icon: Paperclip, title: "Attach a file or just prompt", text: "Images, old footage, a PDF, Word or text document, or a link — or only a topic." },
  { icon: Download, title: "Download your result", text: "A narrated, subtitled video; fix any scene in the timeline." },
];

function SourceChip({ s, onRemove }: { s: Draft; onRemove: () => void }) {
  const label = s.kind === "link" ? (s.title ?? s.url) : s.name;
  return (
    <span className="inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-secondary pr-1 pl-1 text-[12px] font-medium">
      {s.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={s.preview} alt="" className="size-7 rounded-full object-cover" />
      ) : (
        <span className="grid size-7 place-items-center rounded-full bg-background text-muted-foreground">{s.kind === "link" ? <Link2 className="size-3.5" /> : <FileText className="size-3.5" />}</span>
      )}
      <span className="min-w-0 truncate">{label}</span>
      {((s.kind === "image" && s.uploading) || s.kind === "reading") && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Reading" />}
      <button type="button" onClick={onRemove} className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-accent" aria-label={`Remove ${label}`}>
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** Paste a link: the page is fetched and summarised for the writer. */
function LinkPopover({ engine, disabled, onAdd }: { engine: EpisodeSettings["engine"]; disabled: boolean; onAdd: (s: Extract<ExplainerSource, { kind: "link" }>) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      onAdd(await readLink(url.trim(), engine));
      setUrl("");
      setOpen(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            if (disabled) {
              e.preventDefault();
              toast("Up to 3 sources per video — remove one to add another");
            }
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent"
        >
          <Link2 className="size-3.5" /> Paste a link
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,380px)] p-3" align="start" collisionPadding={12}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          className="space-y-2"
        >
          <label htmlFor={id} className="text-[13px] font-medium">
            Paste a link – article, page
          </label>
          <div className="flex gap-2">
            <input id={id} autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:border-primary" />
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : "Add"}
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">The page is read and summarised for the script. Public pages only.</p>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Higgsfield Explainer's form: a style, what to explain, up to 3 sources, the format; plus your history.
 * starters: the ready explainers (src/lib/starters/catalog.ts), where the history is while it's empty, one row under it
 * after; fills: what each one puts in the form.
 */
export function ExplainerStudio({ picker, starters: given = [], fills: givenFills = {} }: { picker: PickerData; starters?: StarterCardData[]; fills?: Record<string, StarterFill> }) {
  const { starters, fills } = useStarters("explainer", given, givenFills);
  const router = useRouter();
  const [engine, setEngine] = useEngine();
  // Files of your own: a guest is asked to sign up first, and an account with neither its own GPU nor its own key to
  // connect one (an explainer renders there).
  const askFirst = useAskBeforeUpload();
  // The estimate's problem (no narrator voice yet…) is a hint until Generate is pressed.
  const [tried, setTried] = useState(false);
  const genre = genreInfo("education");
  const [draft, setDraft] = useState<EpisodeSettings>(() => ({ ...defaultSettings("cloud", genre, { explainer: true }), auto: true }));
  const [prompt, setPrompt] = useState("");
  const [sources, setSources] = useState<Draft[]>([]);
  const [duration, setDuration] = useState<string>("auto");
  const [manual, setManual] = useState("45");
  const [review, setReview] = useState(false);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "liked">("all");
  const [q, setQ] = useState("");
  const file = useRef<HTMLInputElement>(null);
  /** Old footage attached: its still is a picture source; the clip itself is offered to Restore & colourise. */
  const [footage, setFootage] = useState<{ id: string; name: string; preview: string; url?: string } | null>(null);
  const create = useCreateExplainer();
  const history = useExplainers({ q, liked: tab === "liked" });
  const like = useLikeEpisode();
  const promptId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const owner = useIsOwner();
  const readyShown = starters.some((s) => starterShown(s, !owner));
  const noHistory = !history.isLoading && !history.data?.length && tab === "all" && !q;

  /** A ready explainer in the form: its topic, style, length, shape and narrator. */
  const fill = (id: string) => {
    const f = fills[id];
    if (f?.kind !== "explainer") return false;
    setPrompt(f.prompt);
    // Open source narration clones a voice: the starter's own narrator sample, while it has one; else its preset voice.
    const voice: NarratorVoice | undefined = engine === "open" && f.voiceSample ? { kind: "sample", url: f.voiceSample, name: "Narrator" } : f.voice ? { kind: "preset", id: f.voice } : undefined;
    set({ styleId: f.styleId, aspect: f.aspect, ...(voice && { voice }) });
    if (f.duration === "auto" || EXPLAINER_DURATIONS.some((d) => d.value === f.duration)) setDuration(String(f.duration));
    else {
      setDuration("manual");
      setManual(String(f.duration));
    }
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      promptRef.current?.focus({ preventScroll: true });
    });
    return true;
  };

  const manualSecs = Math.round(Number(manual));
  const manualBad = duration === "manual" && (!Number.isInteger(Number(manual)) || manualSecs < EXPLAINER_MIN || manualSecs > EXPLAINER_MAX);
  const length = duration === "auto" ? AUTO_SECONDS : duration === "manual" ? Math.max(EXPLAINER_MIN, Math.min(EXPLAINER_MAX, manualSecs || AUTO_SECONDS)) : Number(duration);
  const voice = engine === "open" && draft.voice?.kind === "preset" ? null : engine === "cloud" && !draft.voice ? defaultVoice("cloud", genre, true) : draft.voice;
  const settings: EpisodeSettings = {
    ...draft,
    engine,
    voice,
    length,
    auto: duration === "auto",
    sourceImages: sources.flatMap((s) => (s.kind === "image" && !s.uploading ? [s.url] : [])),
  };
  const estimate = useEstimate({ kind: "explainer", settings });
  const set = (p: Partial<EpisodeSettings>) => setDraft((d) => ({ ...d, ...p }));
  const style = getStyle(settings.styleId);

  const addFiles = async (files: File[]) => {
    let room = MAX_SOURCES - sources.length;
    for (const f of files) {
      if (room <= 0) return void toast("Up to 3 sources per video — remove one to add another");
      if (f.type.startsWith("image/") || f.type.startsWith("video/")) {
        room--;
        const id = `${f.name}:${Date.now()}:${room}`;
        let image: File = f;
        if (f.type.startsWith("video/")) {
          // Old footage: a still from its middle is the source the pictures read; the clip goes up for the restore step.
          const preview = URL.createObjectURL(f);
          const [still] = await grabFrames(preview, undefined, [0.5], 1280);
          if (!still) {
            URL.revokeObjectURL(preview);
            toast.error(`${f.name}: couldn't read a frame from this clip in the browser — try an MP4`);
            room++;
            continue;
          }
          image = new File([await (await fetch(still)).blob()], `${f.name.replace(/\.[^.]+$/, "")} still.jpg`, { type: "image/jpeg" });
          setFootage({ id, name: f.name, preview });
          void fileToSlot(f, (v) => v && !v.uploading && setFootage((x) => (x?.id === id ? { ...x, url: v.ref } : x)), "video");
        }
        void fileToSlot(
          image,
          (v) =>
            setSources((xs) => {
              const at = xs.findIndex((x) => x.kind === "image" && x.id === id);
              if (!v) return xs.filter((_, i) => i !== at);
              const next: Draft = { kind: "image", id, url: v.ref, name: image.name, preview: v.preview, uploading: v.uploading };
              // A source removed while it uploads stays removed.
              if (at < 0) return v.uploading ? [...xs, next] : xs;
              return xs.map((x, i) => (i === at ? next : x));
            }),
          "image",
        );
      } else if (DOC_TYPES.test(f.name) || f.type.startsWith("text/")) {
        const text = (await f.text()).trim().slice(0, MAX_DOC);
        if (!text) {
          toast.error(`${f.name} is empty`);
          continue;
        }
        room--;
        setSources((xs) => [...xs, { kind: "text", name: f.name, text }]);
      } else if (READ_TYPES.test(f.name) || READ_MIME.test(f.type)) {
        if (f.size > MAX_READ_MB * 1024 * 1024) {
          toast.error(`${f.name} is over ${MAX_READ_MB} MB — add the part that matters, or paste its text into the prompt`);
          continue;
        }
        room--;
        const id = `${f.name}:${Date.now()}:${room}`;
        setSources((xs) => [...xs, { kind: "reading", id, name: f.name }]);
        readDocument(f, engine).then(
          (r) => {
            // A source removed while it's read stays removed.
            setSources((xs) => xs.map((x) => (x.kind === "reading" && x.id === id ? r.source : x)));
            toast.success(`Read ${f.name}${pagesNote(r)}${r.summarized ? " and summarised it for the script" : ""}`);
          },
          (e: Error) => {
            setSources((xs) => xs.filter((x) => !(x.kind === "reading" && x.id === id)));
            toastError(e);
          },
        );
      } else if (/\.(doc|odt|rtf|pages|pptx?|key)$/i.test(f.name) || /msword|opendocument|rtf|presentation/.test(f.type)) {
        toast.error(`${f.name}: save it as PDF or Word (.docx), or paste the text into the prompt`);
      } else {
        toast.error(`${f.name}: add an image (PNG, JPEG, WebP), a clip (MP4, MOV, WebM), a PDF, a Word file (.docx) or a text file (.txt, .md, .csv)`);
      }
    }
  };

  const generate = () => {
    // A guest is asked to sign up, and an account with neither its own GPU nor its own key to connect one, before any
    // hint about the settings (the run would be refused for them whatever the settings say).
    if (askFirst("run")) return;
    setTried(true);
    if (!prompt.trim() && !sources.length) return void toast("Add a prompt, or attach a file or link", { id: "faceless-blocker" });
    if (manualBad) return void toast("Duration must be Auto or a whole number of seconds between 15 and 600", { id: "faceless-blocker" });
    if (sources.some((s) => s.kind === "image" && s.uploading)) return void toast("Uploading…", { id: "faceless-blocker" });
    const reading = sources.find((s) => s.kind === "reading");
    if (reading) return void toast(`Reading ${reading.name}…`, { id: "faceless-blocker" });
    if (engine === "open" && settings.voice?.kind !== "sample" && estimate.data?.error) return void toast(estimate.data.error, { id: "faceless-blocker" });
    const payload: ExplainerSource[] = sources.flatMap((s): ExplainerSource[] => (s.kind === "image" ? [{ kind: "image", url: s.url, name: s.name }] : s.kind === "reading" ? [] : [s]));
    create.mutate(
      { prompt: prompt.trim(), sources: payload, settings, review },
      {
        onSuccess: (ep) => router.push(`/explainer/${ep.id}`),
        onError: (e) => toastError(e),
      },
    );
  };

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="truncate font-heading text-[22px] leading-none">Explainer</h1>
        <div className="ml-auto">
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto grid w-full max-w-[1240px] min-w-0 flex-1 gap-8 px-4 pt-6 pb-16 sm:px-6 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
        <section aria-label="New explainer" className="min-w-0 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)] lg:self-start">
          <div className="rounded-[20px] border bg-background p-3 shadow-soft transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint sm:rounded-composer sm:p-4">
            <p className="px-1 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Fuobe Explainer</p>
            <div className="mt-2 flex items-center gap-3 rounded-2xl bg-muted/60 p-2">
              <div className="h-14 w-24 shrink-0 overflow-hidden rounded-xl">
                <StyleArt styleId={settings.styleId} sizes="96px" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[14px] leading-tight font-medium" title={style.name}>
                  {style.name}
                </p>
                <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">{style.description}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStylesOpen(true)}>
                Change
              </Button>
            </div>

            <label htmlFor={promptId} className="mt-4 block px-1 text-[13px] font-medium">
              What should the video explain?
            </label>
            <textarea
              id={promptId}
              ref={promptRef}
              value={prompt}
              maxLength={MAX_TOPIC}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  generate();
                }
              }}
              rows={4}
              placeholder="Type a topic, or attach files below — e.g. “Explain how dinosaurs went extinct, for kids”"
              className="mt-1 w-full resize-none bg-transparent px-1 text-body leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle-foreground"
            />
            <p className="px-1 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
              {prompt.length.toLocaleString()} / {MAX_TOPIC.toLocaleString()}
            </p>

            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {sources.map((s, i) => (
                <SourceChip key={i} s={s} onRemove={() => setSources((xs) => xs.filter((_, j) => j !== i))} />
              ))}
              <button
                type="button"
                onClick={() => (sources.length >= MAX_SOURCES ? toast("Up to 3 sources per video — remove one to add another") : askFirst() || file.current?.click())}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent"
              >
                <Paperclip className="size-3.5" /> Attach a file
              </button>
              {/* A link is read by the studio's server: the owner's. A visitor attaches the file or pastes the words. */}
              {owner && <LinkPopover engine={engine} disabled={sources.length >= MAX_SOURCES} onAdd={(s) => setSources((xs) => [...xs, s].slice(0, MAX_SOURCES))} />}
              <input
                ref={file}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,.markdown,.csv,text/plain,text/markdown"
                hidden
                onChange={(e) => {
                  const fs = [...(e.target.files ?? [])];
                  e.target.value = "";
                  void addFiles(fs);
                }}
              />
            </div>
            {footage && sources.some((x) => x.kind === "image" && x.id === footage.id) && (
              <OldFootageOffer url={footage.url} src={footage.preview} className="mt-2 px-1" />
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
              <Segmented
                label="Aspect ratio"
                value={settings.aspect}
                options={[
                  { value: "16:9", label: "Horizontal" },
                  { value: "9:16", label: "Vertical" },
                ]}
                onChange={(aspect) => set({ aspect })}
              />
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger className="h-8 w-auto gap-1.5 rounded-full border-0 bg-secondary px-3 text-[13px] font-medium" aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPLAINER_DURATIONS.map((d) => (
                    <SelectItem key={String(d.value)} value={String(d.value)}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {duration === "manual" && (
                <label className="inline-flex h-8 items-center gap-1 rounded-full bg-secondary pr-3 pl-1 text-[13px]">
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                    inputMode="numeric"
                    aria-label="Seconds (15–600)"
                    aria-invalid={manualBad}
                    className={cn("h-7 w-12 rounded-full bg-background text-center font-mono text-[13px] outline-none", manualBad && "text-destructive")}
                  />
                  s
                </label>
              )}
              <NarratorChip engine={engine} voices={picker.voices} value={settings.voice} onChange={(v) => set({ voice: v })} />
              <label className="inline-flex h-8 items-center gap-2 rounded-full bg-secondary px-3 text-[13px] font-medium">
                Subtitles
                <Switch size="sm" checked={settings.subtitles} onCheckedChange={(subtitles) => set({ subtitles })} aria-label="Subtitles" />
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="grid size-8 place-items-center rounded-full bg-secondary hover:bg-accent" aria-label="More settings">
                    <Settings2 className="size-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(92vw,340px)] space-y-4 p-3" align="start" collisionPadding={12}>
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Animation</p>
                    <Segmented label="Animation" value={settings.animation} options={ANIMATION_MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(animation) => set({ animation, resolution: undefined })} />
                    <p className="text-[12px] text-muted-foreground">{(() => {
                      const m = ANIMATION_MODES.find((x) => x.id === settings.animation);
                      return engine === "open" ? m?.openCopy : m?.copy;
                    })()}</p>
                  </div>
                  <ToggleRow label="Background music" hint={MUSIC_HINT[engine]} checked={settings.music} onChange={(music) => set({ music })} />
                  <ToggleRow label="Review the script first" hint="Edit the scenes before anything renders" checked={review} onChange={setReview} />
                </PopoverContent>
              </Popover>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <EstimateLine data={estimate.data} loading={estimate.isFetching} engine={engine} className="min-w-0 flex-1" quiet={!tried} />
              <Button onClick={generate} disabled={create.isPending} className="rounded-full">
                {create.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate
              </Button>
            </div>
          </div>

          <ol className="mt-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-1" aria-label="How it works">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-2.5 rounded-2xl bg-muted/50 p-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-brand-text shadow-soft">
                  <s.icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">
                    {i + 1}. {s.title}
                  </span>
                  <span className="block text-[12px] leading-snug text-muted-foreground">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* While there is no history yet, the ready explainers stand in its place; its tabs and search wait for a first one. */}
        <section aria-labelledby={noHistory && readyShown ? "starters-title" : "history-title"} className="min-w-0 space-y-4">
          <div className={cn("flex flex-wrap items-center gap-2", noHistory && readyShown && "hidden")}>
            <h2 id="history-title" className="mr-auto font-heading text-[24px]">
              History
            </h2>
            {!noHistory && (
              <>
                <Segmented
                  label="Show"
                  value={tab}
                  options={[
                    { value: "all", label: "Show all" },
                    { value: "liked", label: "Liked" },
                  ]}
                  onChange={setTab}
                />
                <div className="flex h-8 w-full items-center gap-1.5 rounded-full bg-secondary px-3 sm:w-52">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search your explainers" className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground" />
                </div>
              </>
            )}
          </div>
          {history.isLoading ? (
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="aspect-video rounded-xl" />
              ))}
            </div>
          ) : history.data?.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 xl:grid-cols-3">
              {history.data.map((ep) => (
                <EpisodeTile key={ep.id} ep={ep} href={`/explainer/${ep.id}`} onLike={() => like.mutate({ id: ep.id, favorite: !ep.favorite })} />
              ))}
            </div>
          ) : noHistory && readyShown ? (
            <StarterSection surface="explainer" starters={given} onFill={fill} narrow />
          ) : (
            <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center">
              <div className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">{tab === "liked" ? <ImageIcon className="size-5" /> : <Sparkles className="size-5" />}</div>
              <p className="mt-3 font-heading text-[22px]">{q ? `Nothing matches “${q}”` : tab === "liked" ? "No liked explainers yet" : "Your explainers show up here"}</p>
              <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{tab === "liked" ? "Like an explainer to keep it here." : "Pick a style, say what to explain, and press Generate."}</p>
            </div>
          )}
          {!!history.data?.length && tab === "all" && !q && <StarterSection surface="explainer" starters={given} onFill={fill} headingLevel="h3" narrow row className="pt-6" />}
        </section>
      </div>

      <Suspense fallback={null}>
        <StarterParam onStarter={fill} />
      </Suspense>
      <Sheet open={stylesOpen} onOpenChange={setStylesOpen}>
        {/* The Sheet's own width is set for its side (data-[side=right]:…): only the same variant overrides it. */}
        <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
          <SheetHeader>
            <SheetTitle>Styles</SheetTitle>
            <SheetDescription>One visual style for the whole video.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-8">
            <StyleGrid
              ids={EXPLAINER_STYLE_IDS}
              value={settings.styleId}
              onChange={(styleId) => {
                set({ styleId });
                setStylesOpen(false);
              }}
              className="sm:grid-cols-3 lg:grid-cols-3"
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
