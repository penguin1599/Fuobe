"use client";

import { ArrowDownToDot, Box, FlipVertical2, Loader2, Move3d, Plus, Rotate3d, Scaling, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { priceLine, useCreate3d, useRunPreview } from "@/components/model3d/hooks";
import { OwnSetupChip, useOwnSetupPress, useOwnSetupViewer } from "@/components/own-setup";
import { useGenerations, useStatus } from "@/lib/api";
import type { OwnSetup } from "@/lib/own-setup";
import { IDOL_MODELS, IDOL_QUALITIES, MODEL3D_FEATURE, model3dRequest, type IdolQuality } from "@/lib/av/model3d";
import { getModel } from "@/lib/catalog";
import type { Generation } from "@/lib/catalog/types";
import { offered } from "@/lib/model-access";
import { toastError } from "@/lib/refusals";
import { MAX_PROPS, propCandidate, propMakerBlocker, wrapDeg, type PropCandidate, type SceneProp } from "@/lib/scene-props";
import { cn } from "@/lib/utils";
import type { PropHandle } from "./scene-engine";

/**
 * Props in Cinema's 3D scene (idol-9): "Add a prop" (a splat from the Library, Idol 3D and TripoSplat on either engine,
 * or a picture made into one with Idol 3D on your GPU), and the list of placed props with their handles.
 */

export const propName = (modelId: string | undefined) => (modelId && getModel(modelId)?.name) || "3D prop";

/** The features whose results can hold a splat (Image to 3D, and its app). */
const PROP_FEATURES = [MODEL3D_FEATURE, "app:app-image-to-3d"];

export function AddPropDialog({
  open,
  onOpenChange,
  onPlace,
  onMaking,
  full,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPlace: (c: PropCandidate & { name: string }) => void;
  /** An Idol 3D run started from a picture: the viewer places its splat when it lands. */
  onMaking: (generationId: string) => void;
  /** The scene holds MAX_PROPS already. */
  full: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-heading text-[22px] font-normal">
            <Box className="size-5 text-brand-text" /> Add a prop
          </DialogTitle>
          <DialogDescription>Place an object made from a picture in the scene, then move, turn and size it. It shows in captures and in paths filmed on your GPU.</DialogDescription>
        </DialogHeader>
        {full ? <p className="rounded-lg bg-muted/60 p-3 text-[13px]">This scene holds {MAX_PROPS} props at most, counting any still being made. Remove one to add another.</p> : open && <AddPropBody onPlace={onPlace} onMaking={onMaking} />}
      </DialogContent>
    </Dialog>
  );
}

function AddPropBody({ onPlace, onMaking }: { onPlace: (c: PropCandidate & { name: string }) => void; onMaking: (generationId: string) => void }) {
  const results = useGenerations({ features: PROP_FEATURES, limit: 48 });
  const candidates = (results.data ?? []).map((g) => ({ g, c: propCandidate(g) })).filter((x): x is { g: Generation; c: PropCandidate } => !!x.c);
  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-labelledby="prop-library">
        <h3 id="prop-library" className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          From your Library
        </h3>
        {results.isLoading ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Looking for 3D splats…
          </p>
        ) : candidates.length ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {candidates.map(({ g, c }) => {
              const name = propName(c.modelId);
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => onPlace({ ...c, name })}
                    aria-label={`Place ${name}${g.createdAt ? `, made ${new Date(g.createdAt).toLocaleDateString()}` : ""}`}
                    className="group block w-full overflow-hidden rounded-lg border bg-muted text-left outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {c.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.poster} alt="" className="aspect-square w-full object-cover" />
                    ) : (
                      <span className="grid aspect-square w-full place-items-center text-muted-foreground">
                        <Box className="size-6" aria-hidden />
                      </span>
                    )}
                    <span className="block truncate px-2 py-1 text-[11.5px]">{name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">No 3D splats yet. Make one from a picture below, or in Image to 3D → Splat.</p>
        )}
      </section>
      <MakeFromPicture onMaking={onMaking} />
    </div>
  );
}

/** A prop from a picture runs Idol 3D on a visitor's own GPU. */
const PROP_SETUP: OwnSetup = { need: "gpu" };

function MakeFromPicture({ onMaking }: { onMaking: (generationId: string) => void }) {
  const status = useStatus().data;
  // The owner's run on the studio's GPU; a visitor's goes to Image to 3D's own route (its own GPU, its checks).
  const create = useCreate3d();
  const visitor = !!useOwnSetupViewer();
  const press = useOwnSetupPress();
  const [photo, setPhoto] = useState<SlotValue | null>(null);
  const [quality, setQuality] = useState<IdolQuality>("best");
  const blocker = propMakerBlocker(status && { ...status, idolOn: offered(status.access, IDOL_MODELS.open, "open") });
  // Idol's looser photo crop for an upload; a picture made here is framed already (idol-1's rule).
  const req =
    !blocker && photo && !photo.uploading
      ? model3dRequest({ engine: "open", mode: "splat", modelId: IDOL_MODELS.open, photo: photo.ref, quality, photoCrop: photo.source !== "generation" })
      : null;
  const preview = useRunPreview(req);
  // No price until the preview has one (not while it loads, or when it failed).
  const price = priceLine(preview.data);
  const make = () => {
    if (!req) return;
    void create.mutateAsync(req).then(
      (items) => {
        const g = items[0];
        if (g) onMaking(g.id);
        setPhoto(null);
      },
      (e) => toastError(e, "Couldn't start the prop"),
    );
  };
  return (
    <section className="space-y-2.5" aria-labelledby="prop-picture">
      <h3 id="prop-picture" className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
        From a picture
      </h3>
      {blocker ? (
        <p className="rounded-lg bg-muted/60 p-3 text-[13px]">{blocker}</p>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <MediaSlot label="Picture" kind="image" value={photo} onChange={setPhoto} />
            <div className="min-w-0 flex-1 space-y-2 text-[13px]">
              <p>One object, whole, on a plain background works best. Idol 3D makes it on your GPU (open source), and it lands in the scene when it&apos;s ready.</p>
              {visitor && <OwnSetupChip setup={PROP_SETUP} />}
              <div className="inline-flex h-8 rounded-full bg-muted p-0.5" role="radiogroup" aria-label="Idol 3D quality">
                {IDOL_QUALITIES.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    role="radio"
                    aria-checked={quality === q.id}
                    title={q.hint}
                    onClick={() => setQuality(q.id)}
                    className={cn("rounded-full px-3 text-[12.5px] font-medium", quality === q.id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Button className="w-full rounded-full" disabled={!req || create.isPending} onClick={() => press(PROP_SETUP, make)}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Make the prop{price ? ` · ${price}` : ""}
          </Button>
        </>
      )}
    </section>
  );
}

/** Places the splat of each Idol 3D run started from a picture once it lands (and says so when one fails). */
export function MakingWatch({ ids, onDone }: { ids: string[]; onDone: (id: string, g: Generation | null) => void }) {
  const results = useGenerations({ features: PROP_FEATURES, limit: 24 });
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const g of results.data ?? []) {
      if (!ids.includes(g.id) || seen.current.has(g.id)) continue;
      if (g.status === "succeeded" || g.status === "failed" || g.status === "canceled") {
        seen.current.add(g.id);
        onDone(g.id, g.status === "succeeded" ? g : null);
      }
    }
  }, [results.data, ids, onDone]);
  return null;
}

const HANDLES: { id: PropHandle; label: string; icon: typeof Move3d }[] = [
  { id: "translate", label: "Move", icon: Move3d },
  { id: "rotate", label: "Turn", icon: Rotate3d },
  { id: "scale", label: "Size", icon: Scaling },
];

/** The placed props: pick one to put the handle on it, its handle mode, size and turn, and the ways to fix it. */
export function PropsPanel({
  props,
  picked,
  onPick,
  handle,
  onHandle,
  loading,
  making,
  sizeRange,
  onChange,
  onRemove,
  onBring,
  onTurnOver,
  onAdd,
  disabled,
  note,
}: {
  props: SceneProp[];
  picked: string | null;
  onPick: (id: string | null) => void;
  handle: PropHandle;
  onHandle: (h: PropHandle) => void;
  loading: Record<string, "loading" | "error">;
  making: number;
  sizeRange: { min: number; max: number };
  onChange: (p: SceneProp) => void;
  onRemove: (id: string) => void;
  onBring: (id: string) => void;
  onTurnOver: (id: string) => void;
  onAdd: () => void;
  disabled?: boolean;
  /** What the engine films of the props (the cloud follows the still itself). */
  note?: string;
}) {
  const current = props.find((p) => p.id === picked);
  // The size slider is logarithmic over its range.
  const lnMin = Math.log(sizeRange.min);
  const lnMax = Math.log(sizeRange.max);
  const toPos = (s: number) => Math.round(((Math.log(Math.min(sizeRange.max, Math.max(sizeRange.min, s))) - lnMin) / (lnMax - lnMin)) * 1000);
  const fromPos = (pos: number) => Math.exp(lnMin + (pos / 1000) * (lnMax - lnMin));
  return (
    <div className="space-y-3">
      {props.length ? (
        <ul className="space-y-1" aria-label="Props in the scene">
          {props.map((p, i) => {
            const state = loading[p.id];
            return (
              <li key={p.id} className={cn("flex items-center gap-2 rounded-lg border p-1.5", picked === p.id && "border-ring bg-accent/40")}>
                <button
                  type="button"
                  onClick={() => onPick(picked === p.id ? null : p.id)}
                  aria-pressed={picked === p.id}
                  aria-label={`Prop ${i + 1}: ${p.name}`}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {p.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.poster} alt="" className="size-8 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded bg-muted">
                      <Box className="size-4" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{p.name}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {state === "loading" ? "Loading…" : state === "error" ? "Couldn't load it" : picked === p.id ? "Drag the handle in the view" : "Pick to move it"}
                    </span>
                  </span>
                  {state === "loading" && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                </button>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => onRemove(p.id)} aria-label={`Remove ${p.name}`} disabled={disabled}>
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">Place an object made from a picture, then film it with the scene.</p>
      )}
      {making > 0 && (
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" /> Making {making > 1 ? `${making} props` : "a prop"} on your GPU — {making > 1 ? "they land" : "it lands"} here when ready
        </p>
      )}
      {current && !loading[current.id] && (
        <div className="space-y-3 rounded-lg bg-muted/50 p-2.5">
          <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Handle">
            {HANDLES.map((h) => (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={handle === h.id}
                onClick={() => onHandle(h.id)}
                className={cn("flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium", handle === h.id ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent")}
              >
                <h.icon className="size-3.5" aria-hidden /> {h.label}
              </button>
            ))}
          </div>
          <label className="block space-y-1.5 text-[12.5px]">
            <span className="flex justify-between">
              <span>Size</span>
              <span className="font-mono">{current.size < 1 ? current.size.toFixed(2) : current.size.toFixed(1)} m</span>
            </span>
            <Slider min={0} max={1000} step={1} value={[toPos(current.size)]} onValueChange={([v]) => onChange({ ...current, size: Math.round(fromPos(v) * 1e4) / 1e4 })} aria-label="Prop size" disabled={disabled} />
          </label>
          <label className="block space-y-1.5 text-[12.5px]">
            <span className="flex justify-between">
              <span>Turn</span>
              <span className="font-mono">{Math.round(current.rotation[1])}°</span>
            </span>
            <Slider
              min={-180}
              max={180}
              step={1}
              value={[Math.round(current.rotation[1])]}
              onValueChange={([v]) => onChange({ ...current, rotation: [current.rotation[0], wrapDeg(v), current.rotation[2]] })}
              aria-label="Prop turn"
              disabled={disabled}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" className="rounded-full" onClick={() => onBring(current.id)} disabled={disabled}>
              <ArrowDownToDot /> In front of the camera
            </Button>
            <Button variant="secondary" size="sm" className="rounded-full" onClick={() => onTurnOver(current.id)} disabled={disabled}>
              <FlipVertical2 /> Turn over
            </Button>
          </div>
        </div>
      )}
      {note && props.length > 0 && <p className="text-[12px] leading-snug text-muted-foreground">{note}</p>}
      <Button variant="secondary" className="w-full rounded-full" onClick={onAdd} disabled={disabled || props.length >= MAX_PROPS}>
        <Plus /> Add a prop
      </Button>
    </div>
  );
}
