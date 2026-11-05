"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { h3ReferenceLabels } from "@/lib/h3-references";
import { MediaSlot, SlotPreview, type SlotValue } from "./media-slot";

type List = "refClips" | "refAudios";

/** Seconds of each clip, read from its preview (its header, in the browser) before anything runs. */
export function useMediaSeconds(values: SlotValue[]): (number | undefined)[] {
  const [seconds, setSeconds] = useState<Record<string, number>>({});
  const keys = values.map((v) => v.preview).join("\n");
  useEffect(() => {
    const els: HTMLMediaElement[] = [];
    for (const v of values) {
      if (!v.preview || seconds[v.preview] !== undefined) continue;
      const el = document.createElement(v.kind === "audio" ? "audio" : "video");
      el.preload = "metadata";
      el.muted = true;
      el.onloadedmetadata = () => {
        if (Number.isFinite(el.duration)) setSeconds((s) => ({ ...s, [v.preview]: el.duration }));
      };
      el.src = v.preview;
      els.push(el);
    }
    return () => {
      for (const el of els) {
        el.onloadedmetadata = null;
        el.removeAttribute("src");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the previews, not the array's identity
  }, [keys]);
  return values.map((v) => seconds[v.preview]);
}

function Tile({ value, label, onRemove }: { value: SlotValue; label: string; onRemove: () => void }) {
  return (
    <div className="relative size-14 shrink-0 overflow-hidden rounded-xl border bg-muted">
      <SlotPreview value={value} />
      <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-center text-[10px] font-medium">{label}</span>
      {value.uploading && (
        <div className="absolute inset-0 grid place-items-center bg-background/60" role="status" aria-label="Uploading">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background"
        aria-label={`Remove ${label}`}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * References mode's clips and voice or music clips (MiniMax H3 on your GPU, Pika H3 Flex): tiles in order, named as the
 * prompt can cite them (Clip 1, Voice 1), and an "add" tile for each kind while there is room.
 */
export function ReferenceTiles({
  clips,
  audios,
  images,
  limits,
  onFile,
  onPick,
  onRemove,
}: {
  clips: SlotValue[];
  audios: SlotValue[];
  images: number;
  limits: { videos: number; audios: number };
  onFile: (list: List, f: File, max: number) => void;
  onPick: (list: List, v: SlotValue, max: number) => void;
  onRemove: (list: List, v: SlotValue) => void;
}) {
  const labels = h3ReferenceLabels({ images, videos: clips.length, audios: audios.length }).slice(images);
  return (
    <>
      {clips.map((v, i) => (
        <Tile key={v.id ?? v.ref} value={v} label={labels[i]} onRemove={() => onRemove("refClips", v)} />
      ))}
      {limits.videos > clips.length && <MediaSlot slotKey="refClips" label="Add clip" kind="video" value={null} onFile={(f) => onFile("refClips", f, limits.videos)} onChange={(v) => v && onPick("refClips", v, limits.videos)} />}
      {audios.map((v, i) => (
        <Tile key={v.id ?? v.ref} value={v} label={labels[clips.length + i]} onRemove={() => onRemove("refAudios", v)} />
      ))}
      {limits.audios > audios.length && <MediaSlot slotKey="refAudios" label="Add voice" kind="audio" value={null} onFile={(f) => onFile("refAudios", f, limits.audios)} onChange={(v) => v && onPick("refAudios", v, limits.audios)} />}
    </>
  );
}

/** The order the prompt cites the references in, and what to fix before a run (Pika's limits). */
export function ReferenceOrder({ images, clips, audios, problem }: { images: number; clips: number; audios: number; problem: string | null }) {
  const labels = h3ReferenceLabels({ images, videos: clips, audios });
  if (!labels.length && !problem) return null;
  return (
    <p className="px-2 pb-1.5 text-[12px] text-muted-foreground" aria-live="polite">
      {problem ? (
        <span className="text-destructive">{problem}</span>
      ) : (
        <>
          References in order: <span className="font-medium text-foreground">{labels.join(", ")}</span>. Name them in your prompt, e.g. “the woman in Image 1 speaks
          with Voice 1”.
        </>
      )}
    </p>
  );
}
