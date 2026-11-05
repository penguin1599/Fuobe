"use client";

import { ArrowLeftToLine, ArrowRightToLine, ArrowUp, AtSign, AudioLines, Box, Check, ChevronDown, Clapperboard, Clock, Copy as CopyIcon, FileVideo, Globe, Grid2x2, ImageIcon, ImagePlus, Loader2, MapPin, Maximize, Plus, RectangleHorizontal, SlidersHorizontal, Sparkles, UserRoundPlus, Video, Volume2, VolumeX, Wand2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PromptInput, ELEMENT_ICONS, type PromptInputHandle } from "@/components/studio/prompt-input";
import { ShotsEditor } from "@/components/studio/shots-editor";
import { ResponsivePanel } from "@/components/studio/responsive-panel";
import { useEdgeFade } from "@/components/studio/use-edge-fade";
import { uploadFile, useAssets, useIsOwner, useModelAccess, useStatus } from "@/lib/api";
import { OwnSetupChip, OwnSetupMark } from "@/components/own-setup";
import { ownSetupLabel, ownSetupOnly } from "@/lib/own-setup";
import { offered } from "@/lib/model-access";
import { getModel } from "@/lib/catalog";
import {
  BATCH,
  CINEMA_MODEL,
  CINEMA_MODELS,
  DURATION,
  GRID_SIZES,
  GRID_TYPES,
  IMAGE_ASPECTS,
  IMAGE_RESOLUTIONS,
  ORIGINAL_LINES,
  VIDEO_ASPECTS,
  checkReferences,
  videoResolutionsFor,
  modelLine,
  planCinema,
  type DirectorSettings,
} from "@/lib/catalog/cinema";
import { findMentions, type StudioElement } from "@/lib/catalog/elements";
import type { Engine, MediaKind } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import { modKey } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { MoveChips, MovePicker, prefetchMoves } from "./camera-moves";
import { ExactOrbitControls } from "@/components/exact-orbit-controls";
import { exactDefaults, takesExact } from "@/lib/exact-orbit";
import { CameraChip, EmotionChip, FilmSetupChip, LightingChip, PaletteChip } from "./director-panel";
import { directorPicks, draftToInput, withMoves, type BarAction, type CinemaDraft, type RefItem } from "./draft";
import { useCinemaGenerate } from "./hooks";
import { firstFrame, mediaDuration } from "./media";
import { formatUsd } from "./money";
import { placeholdersOn } from "@/lib/demo-mode";
import { plainTagline } from "@/lib/plain-tagline";

const chip = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors";
const chipIdle = "bg-secondary text-secondary-foreground hover:bg-accent";
const chipOn = "bg-brand-faint text-brand-text hover:bg-brand-faint-hover";

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; icon?: typeof Video }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex h-8 shrink-0 rounded-full bg-muted p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium transition-colors",
            value === o.id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon && <o.icon className="size-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PickChip<T extends string | number>({
  icon: Icon,
  label,
  value,
  options,
  onChange,
  format,
  describe,
}: {
  icon: typeof Video;
  label: string;
  value: T;
  options: T[];
  onChange: (v: T) => void;
  format?: (v: T) => string;
  describe?: (v: T) => string;
}) {
  const f = format ?? ((v: T) => String(v));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(chip, chipIdle)} aria-label={`${label}: ${f(value)}`}>
          <Icon className="size-3.5" />
          {f(value)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(value)} onValueChange={(v) => onChange(options.find((o) => String(o) === v)!)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={String(o)} value={String(o)} className={describe ? "items-start" : undefined}>
              {describe ? (
                <span>
                  <span className="block">{f(o)}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{describe(o)}</span>
                </span>
              ) : (
                f(o)
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DurationChip({ value, effective, onChange }: { value: number; effective?: number; onChange: (v: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Named by its content, with the words a screen reader needs hidden from sight: "Duration: 5s, the model makes 6s". */}
        <button type="button" className={cn(chip, chipIdle)}>
          <Clock className="size-3.5" aria-hidden />
          <span className="sr-only">Duration: </span>
          {effective && effective !== value ? (
            <span>
              <span className="text-muted-foreground line-through">{value}s</span>
              <span className="sr-only">, the model makes</span> {effective}s
            </span>
          ) : (
            `${value}s`
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3 p-3" align="start" side="top" collisionPadding={12}>
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-medium">Duration</p>
          <span className="font-mono text-[13px]">{value}s</span>
        </div>
        <Slider value={[value]} min={DURATION.min} max={DURATION.max} step={1} onValueChange={([v]) => onChange(v)} aria-label="Duration in seconds" />
        <div className="flex flex-wrap gap-1">
          {[4, 5, 8, 10, 15, 20, 30].map((d) => (
            <button key={d} type="button" onClick={() => onChange(d)} className={cn("h-6 rounded-full px-2 font-mono text-[11.5px]", value === d ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}>
              {d}s
            </button>
          ))}
        </div>
        {effective && effective !== value && <p className="text-[11.5px] text-muted-foreground">This model makes {effective}s clips — use Extend to make the scene longer.</p>}
      </PopoverContent>
    </Popover>
  );
}

function RefThumb({ r, index, startFrame, onRemove }: { r: RefItem; index: number; startFrame: boolean; onRemove: () => void }) {
  const kindLabel = r.kind === "image" ? `Image ${index + 1}` : r.kind === "video" ? `Video ${index + 1}` : `Audio ${index + 1}`;
  return (
    <div className="group/ref relative size-14 shrink-0 overflow-hidden rounded-xl border bg-muted" title={r.name ?? kindLabel}>
      {r.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.preview} alt="" className="size-full object-cover" />
      ) : r.kind === "video" ? (
        <video src={`${r.preview}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center bg-brand-faint text-brand-text">
          <AudioLines className="size-5" />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1 pt-2 pb-0.5 text-[9.5px] font-medium text-white">
        {startFrame ? "Start frame" : kindLabel}
        {r.duration && Number.isFinite(r.duration) ? ` · ${Math.round(r.duration)}s` : ""}
      </span>
      {r.uploading && (
        <span className="absolute inset-0 grid place-items-center bg-background/60">
          <Loader2 className="size-4 animate-spin" />
        </span>
      )}
      <button type="button" onClick={onRemove} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background" aria-label={`Remove ${kindLabel}`}>
        <X className="size-3" />
      </button>
    </div>
  );
}

const kindOf = (f: File): MediaKind => (f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image");

/** Upload files into the reference tray (preview first, then the server URL; durations measured for clips). */
export function useAddRefs(setDraft: (fn: (d: CinemaDraft) => Partial<CinemaDraft>) => void) {
  return (files: FileList | File[]) => {
    for (const f of [...files]) {
      if (f.size > 200 * 1024 * 1024) {
        toast.error("That file's over 200 MB. Try a smaller one.");
        continue;
      }
      const id = nanoid(6);
      const kind = kindOf(f);
      const preview = URL.createObjectURL(f);
      setDraft((d) => ({ refs: [...d.refs, { id, ref: "", preview, kind, name: f.name, uploading: true }] }));
      if (kind === "video" || kind === "audio") void mediaDuration(preview, kind).then((duration) => setDraft((d) => ({ refs: d.refs.map((r) => (r.id === id ? { ...r, duration } : r)) })));
      uploadFile(f)
        .then((a) => setDraft((d) => ({ refs: d.refs.map((r) => (r.id === id ? { ...r, ref: a.url, preview: a.url, uploading: false } : r)) })))
        .catch((e) => {
          setDraft((d) => ({ refs: d.refs.filter((r) => r.id !== id) }));
          toastError(e, "Upload failed. Please try again.");
        });
    }
  };
}

function AddRef({ onFiles, onPick, compact }: { onFiles: (f: FileList) => void; onPick: (r: RefItem) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const assets = useAssets(undefined, undefined);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {compact ? (
              <button type="button" className={cn("grid size-8 shrink-0 place-items-center rounded-full", chipIdle)} aria-label="Add references">
                <ImagePlus className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-border-strong text-muted-foreground transition-colors hover:border-primary hover:bg-brand-faint hover:text-brand-text"
                aria-label="Add references"
              >
                <Plus className="size-4" />
                <span className="text-[10px] font-medium">Add</span>
              </button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Images, videos or audio as references · drop or paste anywhere</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[min(92vw,360px)] p-2" align="start" side="top" collisionPadding={12}>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] font-medium hover:bg-accent"
        >
          <ImagePlus className="size-4" /> Upload images, videos or audio
        </button>
        <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">From your library</p>
        <div className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
          {(assets.data ?? []).slice(0, 40).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                onPick({ id: nanoid(6), ref: a.url, preview: a.url, kind: a.kind, name: a.name ?? undefined });
                setOpen(false);
              }}
              className="relative aspect-square overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Use ${a.name ?? a.kind}`}
            >
              {a.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
              ) : a.kind === "video" ? (
                <video src={`${a.url}#t=0.1`} muted preload="metadata" className="size-full object-cover" />
              ) : (
                <AudioLines className="m-auto size-4 text-muted-foreground" />
              )}
            </button>
          ))}
          {!assets.isLoading && !assets.data?.length && <p className="col-span-4 px-2 py-3 text-[12px] text-muted-foreground">Nothing in your library yet.</p>}
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = "";
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface PromptBarProps {
  projectId: string;
  folderId: string | null;
  engine: Engine;
  draft: CinemaDraft;
  setDraft: (patch: Partial<CinemaDraft> | ((d: CinemaDraft) => Partial<CinemaDraft>)) => void;
  settings: DirectorSettings;
  onSettings: (patch: Partial<DirectorSettings>) => void;
  palettes: { name: string; hex: string[] }[];
  onPalettes: (p: { name: string; hex: string[] }[]) => void;
  context: { cloudAllowed: boolean; civitai?: boolean; worldcast?: boolean; worldReady?: boolean };
  brief: string;
  spentUsd: number;
  costCapUsd: number | null;
  elements: StudioElement[];
  promptRef: React.RefObject<PromptInputHandle | null>;
  onCast: () => void;
  onLocation: () => void;
  /** Blockout to film: a grey-box blockout (uploaded or built) as the take's camera, blocking and timing. */
  onBlockout?: () => void;
  /** World mode (nm10-hy-nomas-world): a world described once, steered turn by turn. Absent when the engine mode is "Paid APIs only". */
  onWorld?: () => void;
}

const ACTIONS: { id: BarAction; label: string; icon: typeof Video; hint: string }[] = [
  { id: "generate", label: "New take", icon: Sparkles, hint: "Use the selected take only as context" },
  { id: "extend-forward", label: "Extend", icon: ArrowRightToLine, hint: "Sequel: continue the take forward" },
  { id: "extend-backward", label: "Prequel", icon: ArrowLeftToLine, hint: "What happened just before the take" },
  { id: "edit", label: "Edit", icon: Wand2, hint: "Change something in the take (object, face, weather)" },
];

export function PromptBar(props: PromptBarProps) {
  const { projectId, folderId, engine, draft, setDraft, settings, onSettings, context, brief, spentUsd, costCapUsd, elements, promptRef } = props;
  const generate = useCinemaGenerate(projectId);
  // World mode on a visitor's own GPU: its mark until its graph has passed on this studio's GPU (src/lib/own-setup.ts).
  const owner = useIsOwner();
  const worldSetup = !owner && !context.worldReady ? ownSetupOnly("cinema:world") : null;
  const status = useStatus().data;
  const [movesOpen, setMovesOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const addRefs = useAddRefs((fn) => setDraft(fn));
  const input = useMemo(() => draftToInput(draft, engine, settings), [draft, engine, settings]);
  const plan = useMemo(() => planCinema({ ...input, brief }, context), [input, brief, context]);
  const model = plan.model;
  const mentions = useMemo(() => findMentions(draft.prompt, elements), [draft.prompt, elements]);
  const characters = mentions.filter((e) => e.kind === "character");
  const refCheck = checkReferences({
    images: draft.refs.filter((r) => r.kind === "image").length,
    videos: draft.refs.filter((r) => r.kind === "video").map((r) => r.duration ?? NaN),
    audios: draft.refs.filter((r) => r.kind === "audio").map((r) => r.duration ?? NaN),
    elements: mentions.length,
  });
  const demo = placeholdersOn(status?.demoMode);
  const cost = demo ? 0 : plan.costUsd;
  const overCap = costCapUsd != null && cost != null && cost > 0 && spentUsd + cost > costCapUsd + 1e-9;
  const uploading = draft.refs.some((r) => r.uploading);
  const blocker = uploading
    ? "Uploading…"
    : refCheck ?? plan.blocker ?? (overCap ? `Over the project's ${formatUsd(costCapUsd)} limit (≈ ${formatUsd(spentUsd)} spent) — raise it in project settings` : undefined);
  // An empty bar needs no warning line (the placeholder says it); everything else is spelled out under the bar.
  const quietBlocker = !draft.prompt.trim() && !draft.refs.length && blocker === plan.blocker && /^Describe/.test(blocker ?? "");
  const blockerId = useId();
  const [directorRow, directorFade] = useEdgeFade<HTMLDivElement>();
  const [settingsRow, settingsFade] = useEdgeFade<HTMLDivElement>();
  const [directorOpen, setDirectorOpen] = useState(false);
  // Reference clips make the take reference-to-video: the first image is then a reference, not the start frame.
  const refMode = plan.steps.find((s) => s.key === "main")?.request.op === "ref2v";
  const video = draft.mode === "video";
  const action = input.action;
  const busy = generate.isPending || preparing;
  // The take's length: the main clip, plus what an extend adds (Fuobe Cinema past 20 s in the cloud).
  const stepSeconds = (key: string) => plan.steps.find((s) => s.key === key)?.request.params?.duration;
  const effectiveDuration = stepSeconds("main") !== undefined ? stepSeconds("main")! + (stepSeconds("more") ?? 0) : undefined;

  const submit = async () => {
    if (busy) return;
    if (blocker) {
      toast.error(blocker);
      return;
    }
    let frame: string | undefined;
    const src = draft.source;
    if (src?.kind === "video" && (action === "extend-backward" || (action === "edit" && engine === "open"))) {
      setPreparing(true);
      frame = (await firstFrame(src.url)) ?? undefined;
      setPreparing(false);
    }
    generate.mutate(
      { input: draftToInput(draft, engine, settings, frame), folderId },
      {
        onSuccess: (r) => {
          toast.success(r.items.length > 1 ? `${r.items.length} jobs queued` : "Queued", { duration: 1500 });
          // The scene was deleted meanwhile: say where the take went.
          if (folderId && r.folderId === null) toast(r.plan.notes[0] ?? "That scene was deleted, so the take is in Home", { duration: 4000 });
        },
        onError: (e) => toastError(e),
      },
    );
  };
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  // ⌘/Ctrl+Enter generates from any field of the bar (onKeyDown below), and from the page when nothing
  // else has focus — never from a dialog, a sheet or another text field (Soul Cast, the brief, settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      if (e.target !== document.body && e.target !== document.documentElement) return;
      e.preventDefault();
      void submitRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPrompt = (v: string) => {
    // Typing "#" opens the camera-move picker (the # itself doesn't stay in the prompt): its list loads while a
    // video prompt is typed, so the search box is there for what's typed after the "#".
    if (video) prefetchMoves();
    const el = document.activeElement as HTMLTextAreaElement | null;
    const caret = el?.tagName === "TEXTAREA" ? (el.selectionStart ?? v.length) : v.length;
    if (video && v.length === draft.prompt.length + 1 && v[caret - 1] === "#" && (caret === 1 || /\s/.test(v[caret - 2]))) {
      setDraft({ prompt: v.slice(0, caret - 1) + v.slice(caret) });
      setMovesOpen(true);
      return;
    }
    setDraft({ prompt: v });
  };

  const modelKey = `${draft.mode}:${engine}` as const;
  // Models switched off in Settings → Models & licences leave the menu, and the pick falls back to the next one on
  // (with all of them off the menu stays, and a run says which switch to turn back on).
  const access = useModelAccess();
  const allModels = CINEMA_MODELS[draft.mode][engine];
  const onModels = allModels.filter((id) => offered(access, id, engine));
  const modelList = onModels.length ? onModels : allModels;
  // The model picked in the menu (a take may run on another: Fuobe DoP for a move's Wan camera LoRA, a references edit…).
  const chosen = draft.models[modelKey];
  const picked = chosen && modelList.includes(chosen) ? chosen : modelList[0];
  // The move pickers badge how Fuobe Cinema (or Wan 2.2 on the GPU) drives a move; a partner model gets the moves in words.
  const moveBadges = picked === CINEMA_MODEL || (engine === "open" && getModel(picked)?.family === "wan");
  const pickable = action === "generate" && !(draft.mode === "image" && draft.imageTool === "grid");
  const placeholder = video
    ? action === "edit"
      ? "Describe the change, e.g. “make it snow”, “replace the car with a horse”"
      : action === "extend-forward"
        ? "What happens next? (optional)"
        : action === "extend-backward"
          ? "What happened just before? (optional)"
          : "Describe your scene – use @ to add characters & locations, # for camera moves"
    : draft.imageTool === "grid"
      ? "Describe the scene – the whole grid shares it"
      : "Describe your still – use @ to add characters & locations";

  // MiniMax H3 adds a 2K tier (fal's 2K, or a 768p draft finished by Open-H3 Regenerate on your GPU).
  const videoTiers = videoResolutionsFor(model);
  // 2K on your GPU finishes with Open-H3 Regenerate: a 48 GB card, said with the tier (own-setup.ts).
  const twoKSetup = ownSetupOnly("regenerate:h3-2k");
  // Secondary settings: inline on wide bars, in one Settings popover on narrow ones.
  const settingsItems: { label: string; node: React.ReactNode }[] = [
    {
      label: "Aspect ratio",
      node: <PickChip key="aspect" icon={RectangleHorizontal} label="Aspect ratio" value={draft.aspect[draft.mode]} options={video ? VIDEO_ASPECTS : IMAGE_ASPECTS} onChange={(v) => setDraft((d) => ({ aspect: { ...d.aspect, [d.mode]: v } }))} />,
    },
    ...(video && action !== "edit" ? [{ label: "Duration", node: <DurationChip key="duration" value={draft.duration} effective={effectiveDuration} onChange={(duration) => setDraft({ duration })} /> }] : []),
    {
      label: "Resolution",
      node: (
        <PickChip
          key="resolution"
          icon={Maximize}
          label="Resolution"
          value={video && !videoTiers.includes(draft.resolution.video) ? "1080p" : draft.resolution[draft.mode]}
          options={video ? videoTiers : IMAGE_RESOLUTIONS}
          describe={video && videoTiers.includes("2K") ? (v) => (v !== "2K" ? "" : model.engine === "open" ? `768p draft, then redrawn at 2K${twoKSetup ? ` · ${ownSetupLabel(twoKSetup)}` : " on your GPU"}` : "Rendered from a 768P base") : undefined}
          onChange={(v) => setDraft((d) => ({ resolution: { ...d.resolution, [d.mode]: v } }))}
        />
      ),
    },
    ...(action === "generate" && !(draft.mode === "image" && draft.imageTool === "grid")
      ? [
          {
            label: video ? "Takes" : "Images",
            node: <PickChip key="batch" icon={CopyIcon} label={video ? "Takes" : "Images"} value={draft.batch} options={Array.from({ length: BATCH.max }, (_, i) => i + 1)} onChange={(batch) => setDraft({ batch })} format={(v) => `×${v}`} />,
          },
        ]
      : []),
    ...(video && model.options.audio === true
      ? [
          {
            label: "Sound",
            node: (
              <Tooltip key="audio">
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => setDraft((d) => ({ audio: !d.audio }))} className={cn(chip, draft.audio ? chipOn : chipIdle)} aria-pressed={draft.audio} aria-label="Audio">
                    {draft.audio ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />} Audio
                  </button>
                </TooltipTrigger>
                <TooltipContent>{draft.audio ? "This generation will include generated audio." : "Silent take"}</TooltipContent>
              </Tooltip>
            ),
          },
        ]
      : []),
    ...(video && action === "generate"
      ? [
          {
            label: "Shots",
            node: (
              <PickChip
                key="multishot"
                icon={FileVideo}
                label="Multi-shot"
                value={draft.multiShot.mode}
                options={["off", "auto", "manual"]}
                onChange={(mode) => setDraft((d) => ({ multiShot: { mode, shots: mode === "manual" && !d.multiShot.shots.length ? [{ prompt: "", duration: 3 }, { prompt: "", duration: 3 }] : d.multiShot.shots } }))}
                format={(v) => (v === "off" ? "Single shot" : v === "auto" ? "Multi-shot · Auto" : "Multi-shot · Manual")}
              />
            ),
          },
        ]
      : []),
  ];
  const settingsSummary = [
    draft.aspect[draft.mode],
    video && action !== "edit" ? `${effectiveDuration ?? draft.duration}s` : null,
    draft.resolution[draft.mode],
    draft.batch > 1 && action === "generate" ? `×${draft.batch}` : null,
    video && draft.multiShot.mode !== "off" && action === "generate" ? "Multi-shot" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The live cost sits next to Generate at every width (short on narrow bars).
  const costShort = demo ? "Placeholder" : cost === 0 ? (engine === "open" ? "Free · GPU" : "Free") : cost != null ? `≈ ${formatCost(cost)}` : "≈ ?";
  const costLong = demo ? "Placeholder · free" : cost === 0 ? (engine === "open" ? "Free · your GPU" : "Free") : cost != null ? `≈ ${formatCost(cost)}` : "Price unknown";

  // The Director's Panel chips: their own row from sm up; on phones one "Director" chip opens them in a sheet.
  const directorChips = (
    <>
      <FilmSetupChip settings={settings} onChange={onSettings} mode={draft.mode} />
      <CameraChip
        settings={settings}
        onChange={onSettings}
        mode={draft.mode}
        engine={engine}
        moves={draft.moves}
        onMovesChange={(moves) => setDraft({ moves })}
        required={draft.mode === "image" && draft.imageTool === "still"}
        badges={moveBadges}
        civitai={context.civitai}
      />
      <PaletteChip settings={settings} onChange={onSettings} engine={engine} saved={props.palettes} onSave={props.onPalettes} />
      <LightingChip settings={settings} onChange={onSettings} />
      <EmotionChip settings={settings} onChange={onSettings} characters={characters} />
      <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />
      {/* Cast and Location open their own dialog: the phone sheet closes first. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => {
              setDirectorOpen(false);
              props.onCast();
            }} className={cn(chip, chipIdle)} aria-label="Soul Cast: build a character">
            <UserRoundPlus className="size-3.5" /> Cast
          </button>
        </TooltipTrigger>
        <TooltipContent>Soul Cast: build an AI actor and save it as a character</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => {
              setDirectorOpen(false);
              props.onLocation();
            }} className={cn(chip, chipIdle)} aria-label="Soul Location: build a location">
            <MapPin className="size-3.5" /> Location
          </button>
        </TooltipTrigger>
        <TooltipContent>Soul Location: keep every scene in the same world</TooltipContent>
      </Tooltip>
      {draft.mode === "video" && props.onBlockout && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => {
                setDirectorOpen(false);
                props.onBlockout!();
              }} className={cn(chip, chipIdle)} aria-label="Blockout: film a grey-box blockout">
              <Box className="size-3.5" /> Blockout
            </button>
          </TooltipTrigger>
          <TooltipContent>Blockout to film: a grey box from Blender or built here sets the camera and timing</TooltipContent>
        </Tooltip>
      )}
      {draft.mode === "video" && props.onWorld && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => {
                setDirectorOpen(false);
                props.onWorld!();
              }} className={cn(chip, chipIdle)} aria-label="World: describe a world, then steer it turn by turn">
              <Globe className="size-3.5" /> World
              {worldSetup && <OwnSetupMark setup={worldSetup} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            World: describe a world once, then steer it turn by turn with words and camera moves (your GPU)
            {worldSetup && <span className="block">{ownSetupLabel(worldSetup)}</span>}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
  const picks = directorPicks(settings, draft.mode);
  // A cinematic still needs camera, lens and focal length: the folded chip warns as the Camera chip does.
  const cameraNeeded = draft.mode === "image" && draft.imageTool === "still" && (!settings.camera || !settings.lens || !settings.focal);
  // Starts with what the chip shows ("Director 2"), so the spoken name contains the visible one.
  const directorName = `Director${picks ? `: ${picks} set` : "'s Panel"}${cameraNeeded ? ", camera needed" : ""}`;

  return (
    <div
      className="group/composer @container w-full rounded-[20px] border bg-background p-2.5 shadow-normal transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint sm:rounded-composer"
      onKeyDown={(e) => {
        // Only the bar's own fields: React bubbles events from portals (the palette editor dialog, popovers) up here too.
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void submit();
        }
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (files.length) {
          e.preventDefault();
          addRefs(files);
        }
      }}
    >
      {/* Selected take: extend forward / backward or edit it */}
      {video && draft.source?.kind === "video" && (
        <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
          <span className="relative h-9 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
            <video src={`${draft.source.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" />
          </span>
          <span className="min-w-0 text-[12px] text-muted-foreground">
            <span className="block truncate font-medium text-foreground">{draft.source.label}</span>
            Selected take
          </span>
          <div className="scrollbar-none flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-muted p-0.5" role="radiogroup" aria-label="What to do with the take">
            {ACTIONS.map((a) => (
              <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.action === a.id}
                    onClick={() => setDraft({ action: a.id })}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium",
                      draft.action === a.id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <a.icon className="size-3.5" /> {a.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{a.hint}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <button type="button" onClick={() => setDraft({ source: null, action: "generate" })} className="ml-auto grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear the selected take">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* References */}
      <div className={cn("scrollbar-none items-center gap-2 overflow-x-auto px-1 pt-0.5 pb-2", draft.refs.length ? "flex" : "hidden sm:flex")}>
        {(() => {
          const n: Record<string, number> = {};
          return draft.refs.map((r) => {
            const i = (n[r.kind] = (n[r.kind] ?? -1) + 1);
            return <RefThumb key={r.id} r={r} index={i} startFrame={r.kind === "image" && i === 0 && video && action === "generate" && !refMode} onRemove={() => setDraft((d) => ({ refs: d.refs.filter((x) => x.id !== r.id) }))} />;
          });
        })()}
        <AddRef onFiles={addRefs} onPick={(r) => setDraft((d) => ({ refs: [...d.refs, r] }))} />
        {!draft.refs.length && <span className="hidden text-[12px] text-muted-foreground sm:inline">Start frame, references, clips or audio — or @ a character</span>}
      </div>

      {video && <MoveChips moves={draft.moves} onChange={(moves) => setDraft(withMoves(draft, moves))} />}
      {video && action === "generate" && takesExact(draft.moves[0]) && (
        <div className="px-2 pb-1.5">
          <ExactOrbitControls compact engine={engine} value={draft.exact ?? null} defaults={exactDefaults(draft.moves[0])} onChange={(exact) => setDraft({ exact })} />
          {/* The exact orbit films with a 48 GB GPU or a fal.ai key: said with its controls (own-setup.ts). */}
          {!owner && <OwnSetupChip setup="fly-around:exact-orbit" className="mt-1" />}
        </div>
      )}

      <PromptInput ref={promptRef} value={draft.prompt} onChange={onPrompt} onSubmit={() => void submit()} placeholder={placeholder} elements={elements} />

      {video && draft.multiShot.mode === "manual" && (
        <ShotsEditor
          model={model}
          shots={draft.multiShot.shots.length ? draft.multiShot.shots : [{ prompt: "", duration: 3 }]}
          onChange={(shots) => setDraft({ multiShot: shots ? { mode: "manual", shots } : { mode: "off", shots: [] } })}
        />
      )}

      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          {mentions.map((el) => {
            const Icon = ELEMENT_ICONS[el.kind];
            const emo = settings.emotions?.[el.handle.toLowerCase()];
            return (
              <span key={el.id} className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background pr-2.5 pl-0.5 text-[12px] font-medium">
                <span className="grid size-6 place-items-center overflow-hidden rounded-full bg-muted">
                  {el.references[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={el.references[0]} alt="" className="size-full object-cover" />
                  ) : (
                    <Icon className="size-3.5" />
                  )}
                </span>
                {el.name}
                {emo && <span className="text-[11px] text-muted-foreground">· {emo.family}</span>}
              </span>
            );
          })}
        </div>
      )}

      {/* Director's Panel */}
      {/* Narrow bars scroll this row (with faded edges where more chips hide); wide ones wrap it. Phones fold it into the Director chip below. */}
      <div ref={directorRow} style={directorFade} className="scrollbar-none -mx-0.5 flex items-center gap-1.5 overflow-x-auto px-1 pb-1.5 max-sm:hidden @min-[760px]:flex-wrap @min-[760px]:overflow-visible" role="group" aria-label="Director's Panel">
        {directorChips}
      </div>

      {/* Generation settings. Narrow bars (phones, a bar squeezed by the side panel) wrap this row and
          fold the secondary settings into one Settings popover, so nothing hides off-screen. */}
      <div className="flex items-end gap-2">
        {/* Phones: one row that scrolls (faded at the edge), so the bar is the prompt plus one line of chips. */}
        <div ref={settingsRow} style={settingsFade} className="scrollbar-none -my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 sm:flex-wrap sm:overflow-visible">
          <span className="contents sm:hidden">
            <ResponsivePanel
              open={directorOpen}
              onOpenChange={setDirectorOpen}
              title="Director's Panel"
              description="Film setup, camera, palette, light and emotion: every shot follows them."
              trigger={
                <button
                  type="button"
                  className={cn(chip, picks ? chipOn : chipIdle, cameraNeeded && "ring-1 ring-warning/60")}
                  aria-label={directorName}
                >
                  <Clapperboard className="size-3.5" /> Director
                  {picks > 0 && <span className="font-mono text-[11px] tabular-nums">{picks}</span>}
                  {cameraNeeded && <span className="size-1.5 rounded-full bg-warning" aria-hidden />}
                </button>
              }
            >
              <div role="group" aria-label="Director's Panel" className="flex flex-wrap gap-1.5">
                {directorChips}
              </div>
            </ResponsivePanel>
          </span>
          <Segmented
            label="Mode"
            value={draft.mode}
            onChange={(mode) => setDraft({ mode })}
            options={[
              { id: "video", label: "Video", icon: Video },
              { id: "image", label: "Image", icon: ImageIcon },
            ]}
          />
          {!video && (
            <Segmented
              label="Image tool"
              value={draft.imageTool}
              onChange={(imageTool) => setDraft({ imageTool })}
              options={[
                { id: "still", label: "Still" },
                { id: "grid", label: "Grid", icon: Grid2x2 },
              ]}
            />
          )}
          {!video && draft.imageTool === "grid" && (
            <>
              <PickChip icon={Grid2x2} label="Grid size" value={draft.grid.size} options={GRID_SIZES.map((g) => g.id)} onChange={(size) => setDraft((d) => ({ grid: { ...d.grid, size } }))} format={(v) => GRID_SIZES.find((g) => g.id === v)!.name} />
              <PickChip icon={Clapperboard} label="Grid type" value={draft.grid.type} options={GRID_TYPES.map((g) => g.id)} onChange={(type) => setDraft((d) => ({ grid: { ...d.grid, type } }))} format={(v) => GRID_TYPES.find((g) => g.id === v)!.name} describe={(v) => GRID_TYPES.find((g) => g.id === v)!.description} />
            </>
          )}

          {/* Model */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!pickable}>
              <button type="button" className={cn(chip, chipIdle, "max-w-[220px] disabled:opacity-100")} aria-label={`Model: ${model.name}`}>
                <Sparkles className="size-3.5 shrink-0" />
                <span className="truncate">{model.name}</span>
                {pickable && <ChevronDown className="size-3 shrink-0 opacity-60" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-72">
              <DropdownMenuLabel>{engine === "open" ? "Open-source models" : "Cloud models"}</DropdownMenuLabel>
              {modelList.map((id) => {
                const m = getModel(id);
                if (!m) return null;
                const sel = modelList.includes(model.id) ? model.id === id : picked === id;
                return (
                  <DropdownMenuItem key={id} onClick={() => setDraft((d) => ({ models: { ...d.models, [modelKey]: id } }))} className="items-start">
                    <span className="mt-0.5 w-4">{sel && <Check className="size-3.5" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                        {m.name}
                        {ORIGINAL_LINES[id] && <span className="rounded-full bg-brand-faint px-1.5 py-px text-[10.5px] font-medium text-brand-text">Original</span>}
                      </span>
                      <span className="block text-[11.5px] leading-snug text-muted-foreground">{plainTagline(modelLine(m, engine))}</span>
                    </span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                {video
                  ? engine === "open"
                    ? "The Director is written into the prompt; a camera move uses its camera LoRA or a Fun Camera pose when you add a start frame."
                    : "The Director is written into every model's prompt; Fuobe Cinema also drives camera moves with LTX-2.3's camera LoRAs."
                  : "The Director's camera and lens are written into the prompt; Fuobe Soul Cinema adds its film look."}
              </p>
            </DropdownMenuContent>
          </DropdownMenu>

          {!draft.refs.length && (
            <span className="sm:hidden">
              <AddRef compact onFiles={addRefs} onPick={(r) => setDraft((d) => ({ refs: [...d.refs, r] }))} />
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => promptRef.current?.startMention()} className={cn("grid size-8 shrink-0 place-items-center rounded-full", chipIdle)} aria-label="Add an element">
                <AtSign className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add a character, location or prop · type @</TooltipContent>
          </Tooltip>
          {video && (
            <MovePicker
              badges={moveBadges}
              civitai={context.civitai}
              open={movesOpen}
              onOpenChange={(o) => {
                setMovesOpen(o);
                if (!o) requestAnimationFrame(() => promptRef.current?.focus());
              }}
              engine={engine}
              selected={draft.moves}
              onPick={(slug) => setDraft((d) => withMoves(d, [...d.moves, slug]))}
            />
          )}

          <div className="hidden @min-[760px]:contents">{settingsItems.map((s) => s.node)}</div>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={cn(chip, chipIdle, "max-w-full @min-[760px]:hidden")} aria-label={`Settings: ${settingsSummary}`}>
                <SlidersHorizontal className="size-3.5 shrink-0" />
                <span className="truncate">{settingsSummary}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(92vw,320px)] space-y-1 p-2" align="start" side="top" collisionPadding={12}>
              <p className="px-1.5 pt-0.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Settings</p>
              {settingsItems.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                  <span className="text-[13px] text-muted-foreground">{s.label}</span>
                  {s.node}
                </div>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("mb-1.5 shrink-0 rounded-full px-2 py-0.5 font-mono text-[12px] tabular-nums", overCap ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
              <span className="@min-[520px]:hidden">{costShort}</span>
              <span className="hidden @min-[520px]:inline">{costLong}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {demo ? "Placeholder results are on (Settings), so takes are free stand-ins" : cost === 0 ? "Runs on your own GPU" : "Estimated cost of this run, billed by the provider to your key"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              onClick={() => void submit()}
              disabled={busy}
              aria-label={plan.outputs > 1 ? `Generate ${plan.outputs}` : "Generate"}
              aria-disabled={!!blocker || undefined}
              aria-describedby={blocker ? blockerId : undefined}
              className={cn("size-10 shrink-0 rounded-full", blocker && "bg-primary/70 hover:bg-primary/80")}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {blocker ?? (
              <span className="flex items-center gap-1.5">
                Generate{plan.outputs > 1 ? ` ${plan.outputs}` : ""} <Kbd>{modKey()}</Kbd>
                <Kbd>↵</Kbd>
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      {(plan.notes.length > 0 || preparing) && (
        <p className="px-2 pt-1.5 text-[11.5px] leading-snug text-muted-foreground">
          {preparing ? "Reading the take's first frame…" : plan.notes.slice(0, 3).join(" · ")}
        </p>
      )}
      {/* Why Generate can't run, in words (touch screens never see the tooltip). */}
      {blocker && (
        <p id={blockerId} className={cn("px-2 pt-1 text-[11.5px] leading-snug", quietBlocker ? "sr-only" : refCheck || overCap ? "text-destructive" : "text-muted-foreground")}>
          {blocker}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {cost != null ? `Estimated cost ${demo ? "free: placeholder results" : cost === 0 && engine === "open" ? "free, on your GPU" : formatCost(cost)}` : ""}
      </span>
    </div>
  );
}
