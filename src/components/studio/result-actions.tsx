"use client";

import {
  ArchiveRestore,
  LetterText,
  Disc3,
  Layers3,
  ListMusic,
  AudioLines,
  BookmarkPlus,
  Box,
  CircleDot,
  Clapperboard,
  Columns2,
  Copy,
  Crop,
  Download,
  FastForward,
  FileArchive,
  FileDown,
  FolderDown,
  Heart,
  ImagePlus,
  Lamp,
  Layers2,
  Palette,
  Film,
  ScanLine,
  LayoutDashboard,
  Mic2,
  MicOff,
  UserX,
  MoreHorizontal,
  Pin,
  Repeat,
  Rotate3d,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  SlidersVertical,
  AudioWaveform,
  Sparkles,
  Trash2,
  UserRoundPlus,
  TextCursorInput,
  Wand2,
  WandSparkles,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReviewMenuItems } from "@/components/library/review";
import { useShare } from "@/components/share/share-provider";
import { useSkillBuilder } from "@/components/skills/skill-builder-provider";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCreateGeneration, useEngineMode, useGenerationActions, useIsAccount, useLikelyVisitor, useSaveElement, useStatus } from "@/lib/api";
import { askDeleteForGood } from "@/components/studio/delete-for-good";
import { placeholdersOn } from "@/lib/demo-mode";
import { ELEMENT_KINDS, type ElementKind } from "@/lib/catalog/elements";
import { OPERATION_LABELS, type Generation, type OutputFile } from "@/lib/catalog/types";
import { downloadName, userTitle } from "@/lib/library";
import { toSrt, toVtt } from "@/lib/cues";
import { cuesOf, outputActions, textOf, type ActionContext, type OutputAction, type OutputActionId } from "@/lib/output-actions";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { enhanceRequest, rerenderRequest } from "@/lib/catalog/regenerate";
import { toastError } from "@/lib/refusals";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";

export const ACTION_ICONS: Record<OutputActionId, LucideIcon> = {
  animate: Clapperboard,
  "new-angle": Rotate3d,
  edit: Wand2,
  "live-edit": Zap,
  recolor: Palette,
  upscale: ZoomIn,
  "remove-watermark": ScanLine,
  reference: ImagePlus,
  grade: SlidersHorizontal,
  relight: Lamp,
  layers: Layers2,
  "edit-layout": LayoutDashboard,
  "save-character": UserRoundPlus,
  extend: FastForward,
  reframe: Crop,
  lipsync: Mic2,
  "add-sound": AudioLines,
  genjutsu: WandSparkles,
  "voice-change": AudioLines,
  "loop-audio": Repeat,
  "split-soundtrack": SlidersVertical,
  "remove-dialogue": MicOff,
  "remove-person": UserX,
  "clean-voice": AudioWaveform,
  "clean-dialogue": AudioLines,
  "edit-speech": TextCursorInput,
  "copy-text": Copy,
  "view-3d": Box,
  download: Download,
  "download-txt": FileDown,
  "download-srt": FileDown,
  "download-vtt": FileDown,
  "download-all": FolderDown,
  "download-exr": FileArchive,
  "download-splat": FileDown,
  "make-3d": Rotate3d,
  favorite: Heart,
  finalize: Sparkles,
  regenerate: Sparkles,
  "rerender-2k": Sparkles,
  "enhance-h3": Sparkles,
  compare: Columns2,
  reuse: RotateCcw,
  "make-skill": BookmarkPlus,
  "copy-prompt": Copy,
  share: Share2,
  pin: Pin,
  review: CircleDot,
  delete: Trash2,
  "delete-upload": Trash2,
  "delete-own": Trash2,
  restore: ArchiveRestore,
  "restore-video": Palette,
  "export-pro": Film,
  "extend-song": ListMusic,
  "remix-song": Disc3,
  "remix-kinetic": LetterText,
  "song-stems": Layers3,
  "delete-forever": Trash2,
};

/** "a 26-year-old surfer from Lisbon, freckles" → "Surfer From Lisbon": a starting name the popover lets you change. */
export function characterName(prompt: string | undefined): string {
  const words = (prompt ?? "")
    .replace(/@\S+/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/\d/.test(w) && !/^(the|and|with|from|who|year|old|of)$/i.test(w));
  const pick = words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return pick || "New character";
}

function saveBlob(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download a file URL without navigating (keyboard shortcut, menus). */
export function downloadUrl(href: string, name?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name ?? "";
  a.click();
}

export interface RunnerOptions {
  onOpen?: (g: Generation, index: number) => void;
  onReuse?: (g: Generation) => void;
  onCompare?: () => void;
  onDeleted?: () => void;
}

// ---------------------------------------------------------------------------
// Delete forever always asks first, for one item or many (the Trash's cards, viewer and bulk bar).

type ConfirmForever = (gs: Generation[], after?: () => void) => void;
const ForeverCtx = createContext<ConfirmForever | null>(null);

/** Asks before anything is deleted for good. Wrap views that show the Trash. */
export function ForeverConfirmProvider({ children }: { children: React.ReactNode }) {
  const actions = useGenerationActions();
  const [pending, setPending] = useState<{ gs: Generation[]; after?: () => void } | null>(null);
  const ask = useCallback<ConfirmForever>((gs, after) => {
    if (gs.length) setPending({ gs, after });
  }, []);
  const n = pending?.gs.length ?? 0;
  return (
    <ForeverCtx.Provider value={ask}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(v) => !v && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {n === 1 ? "this for good" : `${n} items for good`}?</AlertDialogTitle>
            <AlertDialogDescription>{n === 1 ? "It's" : "They're"} removed with the files and can&apos;t be recovered.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pending) return;
                void actions.deleteForever(pending.gs).then((done) => done && toast(done === 1 ? "Deleted for good" : `Deleted ${done} for good`));
                pending.after?.();
              }}
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ForeverCtx.Provider>
  );
}

/** The Trash's confirm step (null outside a ForeverConfirmProvider). */
export const useConfirmForever = () => useContext(ForeverCtx);

/**
 * Deleting an upload checks first that nothing uses it (UploadDeleteProvider in
 * components/library/upload-delete.tsx fills this in; null elsewhere, where uploads aren't shown).
 */
export const UploadDeleteContext = createContext<((g: Generation, after?: () => void) => void) | null>(null);

/** Handlers for the actions that aren't plain links. "save-character" is handled by the caller's popover. */
export function useActionRunner(opts: RunnerOptions = {}) {
  const actions = useGenerationActions();
  const create = useCreateGeneration();
  const confirmForever = useConfirmForever();
  const deleteUpload = useContext(UploadDeleteContext);
  const share = useShare();
  const skillBuilder = useSkillBuilder();
  const press = useOwnSetupPress();
  return (a: OutputAction, g: Generation, index: number) => {
    const o = g.outputs[index];
    // An item that runs on the visitor's own setup: a guest signs up, an account without it connects its GPU first.
    if (a.ownSetup && !a.href && !press(a.ownSetup)) return;
    switch (a.id) {
      case "favorite":
        return void actions.favorite(g);
      case "copy-text":
        return void copyWithToast(textOf(o));
      case "copy-prompt":
        return void copyWithToast(g.prompt ?? "", "Prompt copied");
      case "share":
        if (!share) return void toast.error("Share from the Library or a studio page");
        // The prompt-made title only while prompts are shared (the dialog switches between them).
        return share.share({ kind: "result", id: g.id, title: `${OPERATION_LABELS[g.op] ?? "Result"}${g.modelName ? ` · ${g.modelName}` : ""}`, promptTitle: userTitle(g).slice(0, 120) });
      case "download-txt":
        return saveBlob(textOf(o), downloadName(g, o, index, "txt"), "text/plain");
      case "download-srt":
        return saveBlob(toSrt(cuesOf(o)), downloadName(g, o, index, "srt"), "application/x-subrip");
      case "download-vtt":
        return saveBlob(toVtt(cuesOf(o)), downloadName(g, o, index, "vtt"), "text/vtt");
      case "finalize":
        return create.mutate(
          { feature: g.feature, modelId: g.modelId, op: "finalize", prompt: g.request.prompt, params: { draftId: o.draftId, resolution: "1080p", duration: g.request.params?.duration } },
          { onSuccess: () => toast.success("Rendering the final 1080p version"), onError: (e) => toastError(e) },
        );
      case "rerender-2k":
        // fal's H3 at 2K: the same inputs, words and seed, a new render on the same hosted model (priced per second).
        return create.mutate(rerenderRequest(g), { onSuccess: () => toast.success("Rendering it again at 2K"), onError: (e) => toastError(e) });
      case "enhance-h3":
        // Open-H3 Regenerate at 1080p on your GPU (RIFE first for a 16 fps edit), from the edit's own words.
        return create.mutate(enhanceRequest(g, o.url), { onSuccess: () => toast.success("Enhancing at 1080p on your GPU"), onError: (e) => toastError(e) });
      case "reuse":
        return opts.onReuse?.(g);
      case "make-skill":
        if (!skillBuilder) return void toast.error("Make a skill from the Library or a studio page");
        return skillBuilder.open([g.id]);
      case "compare":
        return opts.onCompare?.();
      case "view-3d":
        return opts.onOpen?.(g, index);
      case "pin":
        void actions.pin([g], !g.pinnedAt);
        return void toast(g.pinnedAt ? "Unpinned" : "Pinned to the top of the Library", { id: "pin" });
      case "delete-own":
        return askDeleteForGood([g], opts.onDeleted);
      case "delete-upload":
        return deleteUpload?.(g, opts.onDeleted);
      case "delete":
        void actions.trash([g]);
        return opts.onDeleted?.();
      case "restore":
        void actions.restore([g]);
        return void toast("Restored");
      case "delete-forever":
        if (confirmForever) return confirmForever([g], opts.onDeleted);
        if (!window.confirm("Delete this for good? It's removed with its files and can't be recovered.")) return;
        void actions.deleteForever([g]).then((done) => done && toast("Deleted for good"));
        return opts.onDeleted?.();
    }
  };
}

/** Name + kind before saving an output as an @element (U26). */
export function SaveElementForm({ g, o, onDone }: { g: Generation; o: OutputFile; onDone: () => void }) {
  const save = useSaveElement();
  const router = useRouter();
  const [name, setName] = useState(() => characterName(g.request.prompt));
  const [kind, setKind] = useState<ElementKind>("character");
  const nameRef = useRef<HTMLInputElement>(null);
  // Focus once the menu that opened this has finished moving focus around.
  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.select(), 60);
    return () => clearTimeout(t);
  }, []);
  const submit = () =>
    save.mutate(
      { name: name.trim() || "New character", kind, references: [o.url] },
      {
        onSuccess: (el) => {
          onDone();
          toast.success(`Saved as @${el.handle}`, { action: { label: "Open", onClick: () => router.push(`/elements/${el.id}`) } });
        },
        onError: (e) => toastError(e),
      },
    );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="space-y-1">
        <label htmlFor={`el-name-${g.id}`} className="text-[12px] font-medium text-muted-foreground">
          Save as element
        </label>
        <input
          id={`el-name-${g.id}`}
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="e.g. “Maya”"
          className="h-9 w-full rounded-lg border bg-background px-3 text-[14px] outline-none focus:border-primary focus:ring-4 focus:ring-brand-faint"
        />
      </div>
      <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1 rounded-full bg-muted p-0.5">
        {ELEMENT_KINDS.filter((k) => k.kind !== "voice").map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            onClick={() => setKind(k.kind)}
            className={cn("h-7 flex-1 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors", kind === k.kind ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
          >
            {k.label}
          </button>
        ))}
      </div>
      <button
        type="submit"
        disabled={save.isPending}
        className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-[13px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        <UserRoundPlus className="size-3.5" /> Save
      </button>
    </form>
  );
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const HOVER = "(hover: hover)";
/** Whether the device can hover (mouse, trackpad); false on touch screens. True until hydrated. */
export function useCanHover(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(HOVER);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(HOVER).matches,
    () => true,
  );
}

const TILE_ICON = "grid size-8 place-items-center rounded-lg text-white/90 transition-colors hover:bg-white/20 hover:text-white focus-visible:bg-white/20 outline-none";
/** On a light surface (audio tiles): the same buttons in the brand colour. */
const SURFACE_ICON = "grid size-8 place-items-center rounded-lg text-brand-text transition-colors hover:bg-background/80 focus-visible:bg-background/80 outline-none";

/** Below this strip width (content box) Download and Favorite go into the ⋯ menu, so ⋯ always fits. */
const NARROW_STRIP = 160;

/**
 * The action strip on a result tile: a labelled primary pill, Download and Favorite icons, and a ⋯
 * menu with the rest. Tiles mount it lazily (on first hover or focus), so long feeds don't mount
 * thousands of tooltips, menus and mutation observers. It fits small cards: under 220 px the pill
 * loses its label, under 160 px Download and Favorite move into the menu. `menuOnly` (touch
 * screens): just the ⋯ menu with every action, opened right away.
 */
export function TileActions({
  g,
  index,
  ctx,
  opts,
  menuOnly,
  className,
  triggerClassName,
  tone = "media",
}: {
  g: Generation;
  index: number;
  ctx?: ActionContext;
  opts?: RunnerOptions;
  menuOnly?: boolean;
  className?: string;
  /** menuOnly: the ⋯ button's look (default: white on a dark chip, for media). */
  triggerClassName?: string;
  /** "media": white on a dark gradient; "surface": on a light card (audio). */
  tone?: "media" | "surface";
}) {
  const run = useActionRunner(opts);
  const engineMode = useEngineMode();
  const visitor = useLikelyVisitor();
  const placeholders = placeholdersOn(useStatus().data?.demoMode);
  const account = useIsAccount();
  const list = useMemo(() => outputActions(g, index, { ...ctx, engineMode, visitor, placeholders, account }), [g, index, ctx, engineMode, visitor, placeholders, account]);
  const [saving, setSaving] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < NARROW_STRIP));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const popover = saving && (
    <Popover open onOpenChange={(v) => !v && setSaving(false)}>
      <PopoverAnchor className="absolute right-2 bottom-2" />
      {/* Opened from a closing menu, which moves focus around: only a click outside or Esc closes it. */}
      <PopoverContent align="end" collisionPadding={12} className="w-72" onClick={stop} onFocusOutside={(e) => e.preventDefault()}>
        <SaveElementForm g={g} o={g.outputs[index]} onDone={() => setSaving(false)} />
      </PopoverContent>
    </Popover>
  );
  if (menuOnly) {
    return (
      <div className={className} onClick={stop} onKeyDown={stop}>
        <ActionMenu g={g} index={index} list={list} run={run} onSave={() => setSaving(true)} defaultOpen triggerClassName={triggerClassName ?? cn(TILE_ICON, "bg-black/45 backdrop-blur")} />
        {popover}
      </div>
    );
  }
  const primary = list.find((a) => a.placement === "primary");
  const bar = list.filter((a) => a.placement === "bar");
  const menu = list.filter((a) => a.placement === "menu");
  const icon = tone === "surface" ? SURFACE_ICON : TILE_ICON;
  const pill = cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium shadow-soft transition-colors outline-none @min-[220px]:px-3",
    tone === "surface" ? "bg-background text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" : "bg-white/90 text-black hover:bg-white focus-visible:ring-2 focus-visible:ring-white",
  );
  const PrimaryIcon = primary ? ACTION_ICONS[primary.id] : null;
  const pillBody = primary && PrimaryIcon && (
    <>
      <PrimaryIcon className="size-3.5" /> <span className="hidden @min-[220px]:inline">{primary.label}</span>
    </>
  );
  return (
    <div ref={strip} className={cn("@container flex items-center gap-0.5", className)} onClick={stop} onKeyDown={stop}>
      {primary &&
        pillBody &&
        (primary.href ? (
          <Link href={primary.href} prefetch={false} className={pill} aria-label={primary.label}>
            {pillBody}
          </Link>
        ) : (
          <button className={pill} aria-label={primary.label} onClick={() => run(primary, g, index)}>
            {pillBody}
          </button>
        ))}
      <span className="flex-1" />
      {bar.map((a) => {
        const Icon = ACTION_ICONS[a.id];
        const body = <Icon className={cn("size-4", a.id === "favorite" && g.favorite && "fill-current")} />;
        const cls = cn(icon, "hidden @min-[160px]:grid");
        return (
          <Tooltip key={a.id}>
            <TooltipTrigger asChild>
              {a.download !== undefined ? (
                <a href={a.href} download={a.download} className={cls} aria-label={a.label}>
                  {body}
                </a>
              ) : (
                <button className={cls} aria-label={a.label} aria-pressed={a.id === "favorite" ? g.favorite : undefined} onClick={() => run(a, g, index)}>
                  {body}
                </button>
              )}
            </TooltipTrigger>
            <TooltipContent>{a.label}</TooltipContent>
          </Tooltip>
        );
      })}
      <ActionMenu g={g} index={index} list={narrow ? [...bar, ...menu] : menu} run={run} onSave={() => setSaving(true)} triggerClassName={icon} />
      {popover}
    </div>
  );
}

/** The ⋯ menu. On touch screens tiles show only this (every action is inside). */
export function ActionMenu({
  g,
  index,
  list,
  run,
  onSave,
  triggerClassName,
  label = "More actions",
  defaultOpen,
}: {
  g: Generation;
  index: number;
  list: OutputAction[];
  run: ReturnType<typeof useActionRunner>;
  onSave: () => void;
  triggerClassName?: string;
  label?: string;
  defaultOpen?: boolean;
}) {
  const actions = useGenerationActions();
  const destructive = list.filter((a) => a.destructive);
  const rest = list.filter((a) => !a.destructive);
  // Focus goes back to ⋯ when the menu closes, except when it hands over to the Save-as-element popover.
  const handingOff = useRef(false);
  const item = (a: OutputAction) => {
    const Icon = ACTION_ICONS[a.id];
    if (a.id === "review") {
      return (
        <DropdownMenuSub key={a.id}>
          <DropdownMenuSubTrigger>
            <Icon /> {a.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent collisionPadding={12} className="min-w-44">
            <ReviewMenuItems value={g.review ?? null} onPick={(r) => void actions.review([g], r)} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    if (a.href && a.download !== undefined) {
      return (
        <DropdownMenuItem key={a.id} asChild>
          <a href={a.href} download={a.download}>
            <Icon /> {a.label}
          </a>
        </DropdownMenuItem>
      );
    }
    if (a.href) {
      return (
        <DropdownMenuItem key={a.id} asChild>
          <Link href={a.href} prefetch={false}>
            <Icon /> {a.label}
            <OwnSetupChip setup={a.ownSetup} className="ml-auto" />
          </Link>
        </DropdownMenuItem>
      );
    }
    return (
      <DropdownMenuItem
        key={a.id}
        variant={a.destructive ? "destructive" : "default"}
        onSelect={() => {
          if (a.id !== "save-character") return run(a, g, index);
          handingOff.current = true;
          onSave();
        }}
      >
        <Icon className={cn(a.id === "favorite" && g.favorite && "fill-current")} /> {a.id === "save-character" ? "Save as element…" : a.label}
        <OwnSetupChip setup={a.ownSetup} className="ml-auto" />
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu modal={false} defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <button className={triggerClassName} aria-label={label} onClick={stop}>
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        className="min-w-48"
        onClick={stop}
        onCloseAutoFocus={(e) => {
          if (!handingOff.current) return;
          e.preventDefault();
          handingOff.current = false;
        }}
      >
        {rest.map(item)}
        {destructive.length > 0 && <DropdownMenuSeparator />}
        {destructive.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
