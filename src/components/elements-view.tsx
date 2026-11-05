"use client";

import { AtSign, AudioLines, Check, Copy, GraduationCap, Loader2, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { PageHeader, PageShell } from "@/components/page-shell";
import { PageSkeleton } from "@/components/skeletons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { fileToSlot, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { ELEMENT_ICONS } from "@/components/studio/prompt-input";
import { VoiceRecorder } from "@/components/studio/voice-recorder";
import { useMaybeClean } from "@/components/audio-tools/clean-voice-switch";
import { OtherSides, useOtherSidesOffered } from "@/components/model3d/other-sides";
import { elementViews, IDOL_VIEWS_NOTE, OTHER_SIDES } from "@/lib/av/idol-views";
import type { ViewSide } from "@/lib/av/model3d";
import { SelfHostNote } from "@/components/self-host-note";
import { useEdgeFade } from "@/components/studio/use-edge-fade";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { useDeleteElement, useElements, useIsVisitor, useSaveElement } from "@/lib/api";
import { ELEMENT_KINDS, elementKindInfo, handleFor, MAX_ELEMENT_PHOTOS, type ElementKind, type StudioElement } from "@/lib/catalog/elements";
import { isLegacySoulId, SOUL_ID_PHOTOS } from "@/lib/catalog/training";
import { copyText } from "@/lib/clipboard";
import { starterShown, type StarterCardData } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { voiceOrigin } from "@/lib/voice-design";

const TIPS: Record<ElementKind, string> = {
  character: `3+ clear photos of one person (${SOUL_ID_PHOTOS.recommended}+ to train a Soul ID, up to ${SOUL_ID_PHOTOS.max}): different angles, at least one full-body, no sunglasses, filters or group shots.`,
  location: "1–6 photos of the place from a few viewpoints.",
  prop: "1–4 clean photos of the object, ideally on a plain background.",
  style: "2–10 images that share the look you want: palette, lighting, grain, mood (20+ to train it as a look).",
  voice: "One clean 10–60 second recording of the voice — just speech, no music. Record it here or upload a WAV or MP3.",
};

const MAX_PHOTOS = MAX_ELEMENT_PHOTOS;

/** Each kind's own examples in the name and description fields. */
const EXAMPLES: Record<ElementKind, { name: string; description: string }> = {
  character: { name: "Maya", description: "woman in her 30s, short copper hair, freckles" },
  location: { name: "Rooftop bar", description: "neon-lit rooftop bar at night, city skyline behind" },
  prop: { name: "Red sneaker", description: "glossy red high-top sneaker with a white sole" },
  style: { name: "Film noir", description: "high-contrast black and white, hard shadows, rain" },
  voice: { name: "Narrator Sam", description: "warm, low male voice, calm and unhurried" },
};

function PhotoGrid({ photos, setPhotos }: { photos: SlotValue[]; setPhotos: React.Dispatch<React.SetStateAction<SlotValue[]>> }) {
  const addFiles = (files: FileList | File[]) => {
    for (const f of [...files].slice(0, MAX_PHOTOS - photos.length)) {
      const id = nanoid(6);
      void fileToSlot(f, (v) =>
        setPhotos((ps) => {
          if (!v) return ps.filter((p) => p.id !== id);
          if (ps.some((p) => p.id === id)) return ps.map((p) => (p.id === id ? { ...v, id } : p));
          // Only the first (uploading) call adds the photo; a finished upload of a photo the user
          // already removed must not bring it back.
          return v.uploading ? [...ps, { ...v, id }] : ps;
        }),
      );
    }
  };
  return (
    <div
      className="flex flex-wrap gap-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {photos.map((p) => (
        <div key={p.id} className="relative size-20 overflow-hidden rounded-xl border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.preview} alt="" className="size-full object-cover" />
          {p.uploading && (
            <div className="absolute inset-0 grid place-items-center bg-background/60">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
          <button
            onClick={() => setPhotos((ps) => ps.filter((x) => x.id !== p.id))}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-foreground/80 text-background"
            aria-label="Remove photo"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {photos.length < MAX_PHOTOS && (
        <MediaSlot
          label="Add photos"
          kind="image"
          value={null}
          onChange={(v) => v && setPhotos((ps) => [...ps, { ...v, id: nanoid(6) }])}
          onFile={(f) => addFiles([f])}
          size="lg"
        />
      )}
    </div>
  );
}

interface ElementDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  element?: StudioElement;
  defaultKind?: ElementKind;
  onSaved?: (el: StudioElement) => void;
}

/** Create or edit an element. */
export function ElementDialog(props: ElementDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[560px]">{props.open && <ElementForm {...props} />}</DialogContent>
    </Dialog>
  );
}

function ElementForm({ onOpenChange, element, defaultKind = "character", onSaved }: ElementDialogProps) {
  const save = useSaveElement();
  const [kind, setKind] = useState<ElementKind>(element?.kind ?? defaultKind);
  const [name, setName] = useState(element?.name ?? "");
  const [description, setDescription] = useState(element?.description ?? "");
  const [photos, setPhotos] = useState<SlotValue[]>(() => (element?.references ?? []).map((r) => ({ id: nanoid(6), ref: r, preview: r, kind: "image" })));

  const uploading = photos.some((p) => p.uploading);
  const refs = photos.filter((p) => p.ref).map((p) => p.ref);
  // Characters and products (idol-8): side and back views made from the first photo with Idol 3D on your GPU, once per
  // dialog, while there's room for them.
  const sidesOffered = useOtherSidesOffered();
  const [sidesAdded, setSidesAdded] = useState<string[] | null>(null);
  const first = photos[0];
  const offerSides = sidesOffered && !sidesAdded && (kind === "character" || kind === "prop") && !!first?.ref && !first.uploading && photos.length + OTHER_SIDES.length <= MAX_PHOTOS;
  const addSides = useCallback(
    (made: Partial<Record<ViewSide, string>>) => {
      const urls = elementViews(made);
      setPhotos((ps) => [...ps, ...urls.filter((u) => !ps.some((p) => p.ref === u)).map((url) => ({ id: nanoid(6), ref: url, preview: url, kind: "image" as const, source: "generation" as const }))]);
      setSidesAdded(urls);
    },
    [],
  );
  const canSave = !!name.trim() && (refs.length > 0 || !!description.trim()) && !uploading && !save.isPending;

  const submit = () =>
    save.mutate(
      { id: element?.id, name, kind, description: description || null, references: refs },
      {
        onSuccess: (el) => {
          toast.success(element ? "Saved" : `@${el.handle} is ready — type @ in any prompt`);
          onOpenChange(false);
          onSaved?.(el);
        },
        onError: (e) => toastError(e),
      },
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{element ? `Edit ${element.name}` : "New element"}</DialogTitle>
        <DialogDescription>Save it once, then type @ in any image or video prompt to put it in the shot.</DialogDescription>
      </DialogHeader>
      {!element && (
        <div className="grid grid-cols-5 gap-1 rounded-xl bg-muted p-1">
          {ELEMENT_KINDS.map((k) => {
            const Icon = ELEMENT_ICONS[k.kind];
            return (
              <button
                key={k.kind}
                onClick={() => setKind(k.kind)}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-medium text-muted-foreground transition",
                  kind === k.kind && "bg-background text-foreground shadow-soft",
                )}
              >
                <Icon className="size-4" />
                {k.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Name, e.g. ${EXAMPLES[kind].name}`}
          autoFocus
        />
        <p className="flex items-center gap-1 px-1 text-[12px] text-muted-foreground">
          <AtSign className="size-3" />
          {name.trim() ? handleFor(name) : "handle"} <span className="text-muted-foreground">— how you mention it in prompts</span>
        </p>
      </div>
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder={`Short description (optional) — used when a model can't take ${kind === "voice" ? "a recording" : "photos"}, e.g. “${EXAMPLES[kind].description}”`}
        className="resize-none text-sm"
      />
      <div className="space-y-2">
        <p className="text-[12px] text-muted-foreground">
          {TIPS[kind]}
          {kind !== "voice" && photos.length > 0 && <span className="tabular-nums"> · {photos.length}/{MAX_PHOTOS}</span>}
        </p>
        {kind === "voice" ? (
          <>
            <VoiceSample value={photos[0]} onChange={(v) => setPhotos(v ? [{ ...v, id: nanoid(6) }] : [])} />
            {!photos[0] && (
              <p className="text-[12px] text-muted-foreground">
                No recording?{" "}
                <Link href="/audio/design" className="font-medium text-brand-text underline underline-offset-2">
                  Design a voice
                </Link>{" "}
                from a description instead.
              </p>
            )}
          </>
        ) : (
          <>
            <PhotoGrid photos={photos} setPhotos={setPhotos} />
            {offerSides && first && <OtherSides photo={first.ref} asPhoto={first.source !== "generation"} label="Add side and back views" onMade={addSides} />}
            {sidesAdded?.some((u) => refs.includes(u)) && <p className="text-[12px] text-muted-foreground">Side and back views by Idol 3D: {IDOL_VIEWS_NOTE.charAt(0).toLowerCase() + IDOL_VIEWS_NOTE.slice(1)}</p>}
          </>
        )}
      </div>
      <DialogFooter>
        <Button disabled={!canSave} onClick={submit}>
          {save.isPending && <Loader2 className="animate-spin" />} {element ? "Save" : `Create ${elementKindInfo(kind).label.toLowerCase()}`}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One voice recording: record it here or upload a file, then listen back. */
function VoiceSample({ value, onChange }: { value?: SlotValue; onChange: (v: SlotValue | null) => void }) {
  // "Clean up voice": the saved voice keeps the clean file (references[0]), so every clone made from it is cleaner.
  const clean = useMaybeClean();
  return value?.ref ? (
    <div className="flex items-center gap-2 rounded-xl border bg-muted/40 p-2">
      <audio src={value.preview} controls className="h-9 flex-1" />
      <Button variant="ghost" size="icon" onClick={() => onChange(null)} aria-label="Remove recording">
        <X />
      </Button>
    </div>
  ) : (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <VoiceRecorder onRecorded={onChange} clean />
        <MediaSlot label="Upload" kind="audio" value={null} onChange={(v) => v && !v.uploading && void clean.run(v, onChange)} />
      </div>
      {clean.busy && (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" /> Cleaning the voice…
          <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={clean.skip}>
            Use the original
          </button>
        </p>
      )}
    </div>
  );
}

function HandleCopy({ handle }: { handle: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.preventDefault();
        if (!(await copyText(`@${handle}`))) return void toast.error("Couldn’t copy — select the handle instead");
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title="Copy handle"
    >
      @{handle} {done ? <Check className="size-3" /> : <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}

/** Training, Soul ID (a LoRA that runs), Retrain (only an older Soul ID kept by reference) or Placeholder (only a placeholder training's stand-in). */
function TrainedBadge({ el }: { el: StudioElement }) {
  const real = el.loras.some((l) => !l.demo && !isLegacySoulId(l));
  const legacy = !real && el.loras.some(isLegacySoulId);
  const label = el.status === "training" ? "Training" : real ? "Soul ID" : legacy ? "Retrain" : el.loras.length ? "Placeholder" : null;
  if (!label) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-medium shadow-soft backdrop-blur",
        real || el.status === "training" ? "text-success" : "text-warning",
      )}
      title={legacy ? "An older Soul ID that no longer runs: retrain it for Fuobe Soul on the same photos" : undefined}
    >
      {el.status === "training" ? <Loader2 className="size-3 animate-spin" /> : <GraduationCap className="size-3" />}
      {label}
    </span>
  );
}

function ElementCard({ el }: { el: StudioElement }) {
  const del = useDeleteElement();
  const Icon = ELEMENT_ICONS[el.kind];
  return (
    <div className="group relative overflow-hidden rounded-xl border bg-background transition-shadow hover:shadow-normal">
      {el.kind === "voice" ? (
        <div className="grid aspect-square place-items-center bg-gradient-to-br from-brand-faint to-muted p-4">
          <AudioLines className="size-10 text-brand-text" />
          {el.references[0] && <audio src={el.references[0]} controls className="w-full" />}
        </div>
      ) : (
        <Link href={`/elements/${el.id}`} className="block" aria-label={`Open ${el.name}`}>
          <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 bg-muted">
            {el.references.length ? (
              el.references.slice(0, 4).map((r, i, arr) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${i}:${r}`}
                  src={r}
                  alt=""
                  className={cn(
                    "size-full object-cover",
                    arr.length === 1 && "col-span-2 row-span-2",
                    arr.length === 2 && "row-span-2",
                    arr.length === 3 && i === 0 && "row-span-2",
                  )}
                />
              ))
            ) : (
              <div className="col-span-2 row-span-2 grid place-items-center text-muted-foreground">
                <Icon className="size-8" />
              </div>
            )}
          </div>
        </Link>
      )}
      <TrainedBadge el={el} />
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{el.name}</p>
          <HandleCopy handle={el.handle} />
          {el.kind === "voice" && el.voice && <p className="truncate text-[11px] text-muted-foreground" title={el.voice.description}>{voiceOrigin(el.voice)}</p>}
        </div>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
          <Icon className="size-3" /> {elementKindInfo(el.kind).label}
        </span>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg bg-background/80 text-muted-foreground backdrop-blur transition outline-none group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0"
            aria-label={`Delete ${el.name}`}
          >
            <Trash2 className="size-4" />
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {el.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              @{el.handle} will stop working in prompts{el.loras.length ? " and its trained identity is removed" : ""}. Images you already made stay in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                del.mutate(el.id, {
                  onSuccess: () => toast(`Deleted ${el.name}`),
                  onError: (e) => toastError(e),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ElementsBody({ starters: given }: { starters: StarterCardData[] }) {
  const sp = useSearchParams();
  const router = useRouter();
  const els = useElements();
  const [tab, setTab] = useState<ElementKind | "all">("all");
  const [open, setOpen] = useState(sp.get("new") === "1");
  // An element is saved to the studio's library, which is its owner's: a guest or an account is told so, not given a form.
  const visitor = useIsVisitor();
  const [kinds, kindsFade] = useEdgeFade<HTMLDivElement>();
  const list = useMemo(() => (els.data ?? []).filter((e) => tab === "all" || e.kind === tab), [els.data, tab]);
  // The ready elements this viewer sees (the page carries the covered ones; the owner's view loads every one), less the
  // ones already saved: an element keeps its starter's name.
  const { owner, starters } = useStarters("elements", given);
  const saved = useMemo(() => new Set((els.data ?? []).map((e) => e.name)), [els.data]);
  const unsaved = (s: StarterCardData) => !saved.has(s.name);
  const hasStarters = starters.some((s) => starterShown(s, !owner) && unsaved(s));

  return (
    <PageShell>
      <PageHeader
        title="Elements"
        description="Characters, locations, props and styles you can reuse. Save one once, then type @ in any image or video prompt, and it looks the same every time."
      >
        {visitor ? (
          <SelfHostNote className="max-w-xs">Saving elements runs on your own Fuobe install.</SelfHostNote>
        ) : (
          <Button onClick={() => setOpen(true)}>
            <Plus /> New element
          </Button>
        )}
      </PageHeader>
      <div ref={kinds} style={kindsFade} role="group" aria-label="Kinds" className="scrollbar-none -mx-1 mb-5 flex gap-1 overflow-x-auto px-1">
        {(["all", ...ELEMENT_KINDS.map((k) => k.kind)] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            aria-pressed={tab === k}
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent",
              tab === k && "bg-secondary text-foreground",
            )}
          >
            {k === "all" ? "All" : elementKindInfo(k).plural}
          </button>
        ))}
      </div>
      {els.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
          ))}
        </div>
      ) : list.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((el) => (
            <ElementCard key={el.id} el={el} />
          ))}
          {tab === "all" && <StarterSection surface="elements" starters={given} hide={(s) => !unsaved(s)} row className="col-span-full mt-8" />}
        </div>
      ) : tab === "all" && hasStarters ? (
        <StarterSection surface="elements" starters={given} hide={(s) => !unsaved(s)} />
      ) : (
        <div className="rounded-xl border border-primary/10 bg-brand-faint px-6 py-14 text-center">
          <AtSign className="mx-auto size-8 text-brand-text" />
          <p className="mt-3 font-heading text-[22px]">{tab === "all" ? "No elements yet" : `No ${elementKindInfo(tab).plural.toLowerCase()} yet`}</p>
          <p className="mx-auto mt-1 max-w-md text-[14px] text-muted-foreground">
            Save a person, a place or a product from a few photos. Then write “@Maya walking into @Rooftop_bar” in any prompt.
          </p>
          {!visitor && (
            <Button className="mt-5" variant="outline" onClick={() => setOpen(true)}>
              <Plus /> New element
            </Button>
          )}
        </div>
      )}
      <ElementDialog
        open={open && !visitor}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o && sp.get("new")) router.replace("/elements");
        }}
        defaultKind={tab === "all" ? "character" : tab}
      />
    </PageShell>
  );
}

/** starters: the ready elements (catalog cards, from the page), first while there are none, then in one row under them. */
export function ElementsView({ starters = [] }: { starters?: StarterCardData[] }) {
  return (
    <Suspense fallback={<PageSkeleton title="Elements" rows={2} />}>
      <ElementsBody starters={starters} />
    </Suspense>
  );
}
