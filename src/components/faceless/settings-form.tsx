"use client";

import { songLength } from "@/lib/lyrics";
import { AtSign, ChevronDown, Film, Images, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fileToList, SlotPreview, type SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useElements, useLikelyVisitor, useModelAccess } from "@/lib/api";
import { keepOffered, offered } from "@/lib/model-access";
import {
  ANIMATION_MODES,
  DEFAULT_RESOLUTION,
  ENGINE_MODELS,
  FACELESS_LENGTHS,
  MAX_STYLE_REFS,
  MUSIC_HINT,
  type EpisodeSettings,
  type PickerData,
} from "@/lib/catalog/faceless";
import { cn } from "@/lib/utils";
import { ClipBed } from "./clip-bed";
import { Section, Segmented, ToggleRow } from "./controls";
import { NarratorList } from "./narrator";
import { StyleGrid } from "./style-art";

/** Up to 3 style reference images (they replace the preset); `max` is what the engine's picture model reads. */
export function StyleRefs({ value, onChange, max = MAX_STYLE_REFS }: { value: string[]; onChange: (urls: string[]) => void; max?: number }) {
  const [list, setList] = useState<SlotValue[]>(() => value.map((url) => ({ ref: url, preview: url, kind: "image" })));
  const sync = setList;
  // Finished uploads become the settings' references.
  const done = list.filter((x) => !x.uploading && x.ref).map((x) => x.ref);
  const key = done.join("|");
  useEffect(() => {
    if (key !== value.join("|")) onChange(key ? key.split("|") : []);
    // Only when the uploaded list changes; `value` follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {list.map((v, i) => (
        <div key={v.id ?? v.ref ?? i} className="relative size-20 overflow-hidden rounded-xl border bg-muted">
          <SlotPreview value={v} />
          <button
            type="button"
            onClick={() => sync((xs) => xs.filter((x) => x !== v))}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-soft"
            aria-label={`Remove style reference ${i + 1}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {list.length < max && (
        <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border-strong text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-brand-faint hover:text-brand-text focus-within:ring-2 focus-within:ring-ring">
          <Plus className="size-4" />
          Add image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="sr-only"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].slice(0, max - list.length);
              e.target.value = "";
              for (const f of files) fileToList(f, sync, "image");
            }}
          />
        </label>
      )}
    </div>
  );
}

/** Characters and places the script may use (their @handles go into the scenes). */
export function ElementsPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const els = (useElements().data ?? []).filter((e) => e.kind === "character" || e.kind === "location" || e.kind === "prop");
  if (!els.length)
    return (
      <p className="text-[12px] text-muted-foreground">
        Save characters and places in <Link href="/elements?new=1" className="text-brand-text underline underline-offset-2">Elements</Link> to keep them the same in every scene.
      </p>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      {els.map((e) => {
        const on = value.includes(e.handle);
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((h) => h !== e.handle) : [...value, e.handle].slice(0, 8))}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full pr-3 pl-1 text-[13px] font-medium transition-colors",
              on ? "bg-brand-faint text-brand-text hover:bg-brand-faint-hover" : "bg-secondary hover:bg-accent",
            )}
          >
            {e.references[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={e.references[0]} alt="" className="size-6 rounded-full object-cover" />
            ) : (
              <AtSign className="ml-1 size-3.5" />
            )}
            @{e.handle}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Video settings for an episode (Faceless) or an explainer: length, animation, format, style (or style
 * references), narrator, the characters to use, and the video model and quality.
 */
export function EpisodeSettingsForm({
  kind,
  value,
  onChange,
  picker,
  styleIds,
}: {
  kind: "faceless" | "explainer";
  value: EpisodeSettings;
  onChange: (patch: Partial<EpisodeSettings>) => void;
  picker: PickerData;
  styleIds: string[];
}) {
  const [own, setOwn] = useState(value.styleRefs.length > 0);
  const visitor = useLikelyVisitor();
  const maxRefs = picker.maxStyleRefs?.[value.engine] ?? MAX_STYLE_REFS;
  // Frame by frame moves a camera over each picture (Ken Burns, no video model); Fully animated picks a video model.
  const frames = value.animation === "frames";
  const camera = picker.cameraMoves?.[value.engine];
  // Video models switched off in Settings → Models & licences leave the list; the default falls back to one that is on.
  const access = useModelAccess();
  const videos = frames ? [] : keepOffered(picker.videoModels.filter((m) => m.engine === value.engine), (m) => offered(access, m.id, value.engine));
  // A video model picked before it was switched off counts as no pick (the next one that is on runs).
  const offPick = !!value.videoModel && videos.length > 0 && !videos.some((m) => m.id === value.videoModel);
  useEffect(() => {
    if (offPick) onChange({ videoModel: undefined, resolution: undefined });
  }, [offPick, onChange]);
  const video = frames ? (camera && { ...camera, engine: value.engine }) : (videos.find((m) => m.id === value.videoModel) ?? videos.find((m) => m.id === ENGINE_MODELS[value.engine].video) ?? videos[0]);
  const resolution = value.resolution && video?.resolutions.includes(value.resolution) ? value.resolution : (DEFAULT_RESOLUTION[video?.id ?? ""]?.[value.animation] ?? video?.resolutions[0]);
  // The music bed's model (Advanced), with the longest bed each makes; one switched off in Settings leaves the list.
  const beds = keepOffered((picker.musicModels ?? []).filter((m) => m.engine === value.engine), (m) => offered(access, m.id, value.engine));
  const bed = beds.find((m) => m.id === value.musicModel) ?? beds.find((m) => m.id === ENGINE_MODELS[value.engine].music) ?? beds[0];
  return (
    <div className="space-y-7">
      {kind === "faceless" && (
        <Section title="Length">
          <Segmented label="Episode length" value={value.length} options={FACELESS_LENGTHS.map((s) => ({ value: s, label: `${s / 60} min` }))} onChange={(length) => onChange({ length })} />
        </Section>
      )}

      <Section title="Animation">
        <div role="radiogroup" aria-label="Animation" onKeyDown={radioKeys} className="grid gap-2 sm:grid-cols-2">
          {ANIMATION_MODES.map((m) => {
            const on = value.animation === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={radioTab(on)}
                onClick={() => onChange({ animation: m.id, resolution: undefined })}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-primary ring-2 ring-brand-faint" : "hover:border-border-strong",
                )}
              >
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", on ? "bg-brand-faint text-brand-text" : "bg-muted text-muted-foreground")}>
                  {m.id === "animated" ? <Film className="size-4" /> : <Images className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">{m.label}</span>
                  <span className="block text-[12px] leading-snug text-muted-foreground">{value.engine === "open" ? m.openCopy : m.copy}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Format">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Aspect ratio"
            value={value.aspect}
            options={[
              { value: "16:9", label: "Horizontal 16:9" },
              { value: "9:16", label: "Vertical 9:16" },
            ]}
            onChange={(aspect) => onChange({ aspect })}
          />
        </div>
        <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
          <ToggleRow label="Subtitles" hint="Burned into the video, timed to the voice" checked={value.subtitles} onChange={(subtitles) => onChange({ subtitles })} />
          <ToggleRow label="Background music" hint={MUSIC_HINT[value.engine]} checked={value.music} onChange={(music) => onChange({ music })} />
          {kind === "faceless" && value.music && <ClipBed engine={value.engine} value={value.bedClip} onChange={(bedClip) => onChange({ bedClip })} />}
        </div>
      </Section>

      <Section title="Style" hint="Choose either a style preset or your own style references.">
        <Segmented
          label="Style source"
          value={own ? "own" : "preset"}
          options={[
            { value: "preset", label: "Style presets" },
            { value: "own", label: "Use your own style" },
          ]}
          onChange={(v) => {
            setOwn(v === "own");
            if (v === "preset") onChange({ styleRefs: [] });
          }}
        />
        {own ? (
          <div className="space-y-2">
            <StyleRefs key={value.engine} value={value.styleRefs.slice(0, maxRefs)} onChange={(styleRefs) => onChange({ styleRefs })} max={maxRefs} />
            <p className="text-[12px] text-muted-foreground">
              Up to {maxRefs} images in the look you want: palette, technique and texture are matched, nothing is copied.
              {value.engine === "open" && maxRefs < MAX_STYLE_REFS && " (The open-source picture model reads two.)"}
            </p>
          </div>
        ) : (
          <StyleGrid ids={styleIds} value={value.styleId} onChange={(styleId) => onChange({ styleId })} />
        )}
      </Section>

      <Section title="Narrator">
        <div className="rounded-xl border p-2">
          <NarratorList engine={value.engine} voices={picker.voices} value={value.voice} onChange={(voice) => onChange({ voice })} />
        </div>
      </Section>

      {/* Characters and places are the studio owner's Elements: a visitor's script draws its own. */}
      {!visitor && (
        <Section title="Characters and places" hint="The script puts them in the scenes where they belong; their pictures keep them the same.">
          <ElementsPicker value={value.elements} onChange={(elements) => onChange({ elements })} />
        </Section>
      )}

      <Collapsible>
        <CollapsibleTrigger className="group/adv inline-flex items-center gap-1 rounded text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDown className="size-4 transition-transform group-data-[state=open]/adv:rotate-180" /> Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          {videos.length > 1 && (
            <Section title="Video model">
              <Segmented label="Video model" value={video?.id ?? ""} options={videos.map((m) => ({ value: m.id, label: m.name }))} onChange={(videoModel) => onChange({ videoModel, resolution: undefined })} />
            </Section>
          )}
          {value.music && beds.length > 1 && (
            <Section title="Music" hint={value.engine === "open" ? "Longer films play the bed again, with a soft crossfade." : "Longer films play the bed again from the start."}>
              <Segmented
                label="Music model"
                value={bed?.id ?? ""}
                options={beds.map((m) => ({ value: m.id, label: `${m.name} · up to ${songLength(m.maxSeconds)}` }))}
                onChange={(musicModel) => onChange({ musicModel })}
              />
            </Section>
          )}
          {video && video.resolutions.length > 1 && (
            <Section title="Quality" hint={frames ? "The size the camera moves render at: no model runs, larger sizes take longer and more memory." : undefined}>
              <Segmented label="Quality" value={resolution ?? ""} options={video.resolutions.map((r) => ({ value: r, label: r }))} onChange={(r) => onChange({ resolution: r })} />
            </Section>
          )}
          <p className="text-[12px] text-muted-foreground">
            {value.engine === "cloud"
              ? `Pictures: Nano Banana Pro · ${frames ? "Camera: Ken Burns zoom (fal), no video model" : `Video: ${video?.name ?? "Gemini Omni Flash"}`} · Voice: ElevenLabs v4 (Chatterbox for your own voice), timed word by word by ElevenLabs forced alignment · Music: ${bed?.name ?? "Sonilo"} · Subtitles: Auto Subtitle`
              : `Pictures: Qwen-Image 2.1 (Krea 2 Style Reference or Qwen-Image 2.1 Turbo with your images) · ${frames ? "Camera: Ken Burns pan and zoom, scenes over 10 s in pieces" : `Video: ${video?.name ?? "MiniMax H3"}`} · Voice: Chatterbox, timed by Qwen3-ASR · Music: ${bed ? `${bed.name}, looped past ${songLength(bed.maxSeconds)}` : "ACE-Step, looped past 4 minutes"} · Subtitles: Qwen3-ASR + burn-in`}
            {" "}Each scene is cut to where its lines are spoken.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
