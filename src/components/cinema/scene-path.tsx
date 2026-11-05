"use client";

import { Clapperboard, Loader2, Play, Plus, Square, X } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_MOTION, MAX_KEYS, PATH_FPS, PATH_FRAMES, PATH_PRESETS, keyLabel, type CameraKey } from "@/lib/camera-path";
import { PATH_DURATIONS } from "@/lib/catalog/cinema";
import { WORLDCAST_SECONDS } from "@/lib/catalog/worldcast-plan";
import { WORLDCAST_RUN } from "@/lib/worldcast";
import type { Engine } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";

/**
 * Fly path in Cinema's 3D scene (build plan N7-5), the controls: the keys as chips with "+ Keyframe" and Preview (a strip
 * over the view on wide screens), the moves, the length, the quality, the motion words and "Film this path". The viewer
 * (scene-viewer.tsx) owns the path and the 3D engine; these only draw and report.
 */

/** The open engine always films this long. */
export const OPEN_SECONDS = Math.round((PATH_FRAMES / PATH_FPS) * 10) / 10;

export interface PathKeysProps {
  keys: CameraKey[];
  /** Seconds the chips' times are counted in. */
  seconds: number;
  disabled: boolean;
  previewing: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onGoTo: (index: number) => void;
  onPreview: () => void;
  /** Dark glass over the 3D view, or the sheet's own colours. */
  tone: "overlay" | "panel";
}

/** The keys in order (the start is the still's own camera), "+ Keyframe" and Preview. */
export function PathKeys({ keys, seconds, disabled, previewing, onAdd, onRemove, onGoTo, onPreview, tone }: PathKeysProps) {
  const full = keys.length >= MAX_KEYS;
  const overlay = tone === "overlay";
  const chip = overlay ? "bg-white/12 text-white hover:bg-white/20" : "bg-secondary hover:bg-accent";
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", overlay ? "flex-nowrap" : "flex-wrap")} role="group" aria-label="Path keyframes">
      <div className={cn("flex min-w-0 items-center gap-1", overlay ? "overflow-x-auto [scrollbar-width:none]" : "flex-wrap")}>
        {keys.map((k, i) =>
          i === 0 ? (
            <button
              key="start"
              type="button"
              onClick={() => onGoTo(0)}
              disabled={disabled}
              className={cn("h-8 shrink-0 rounded-full px-3 text-[12px] whitespace-nowrap", chip)}
              aria-label="Keyframe 1: the start, the still's own camera. Go there"
            >
              0 s · the still
            </button>
          ) : (
            <span key={i} className={cn("inline-flex h-8 shrink-0 items-center rounded-full", chip)}>
              <button
                type="button"
                onClick={() => onGoTo(i)}
                disabled={disabled}
                className="h-full rounded-l-full pr-1 pl-3 text-[12px] whitespace-nowrap tabular-nums"
                aria-label={`Keyframe ${i + 1}: ${keyLabel(k, seconds)}. Go there`}
              >
                {keyLabel(k, seconds)}
              </button>
              <button
                type="button"
                onClick={() => onRemove(i)}
                disabled={disabled}
                className={cn("grid h-full w-7 place-items-center rounded-r-full", overlay ? "hover:bg-white/15" : "hover:bg-background/60")}
                aria-label={`Remove keyframe ${i + 1}`}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ),
        )}
      </div>
      <Button
        size="sm"
        variant={overlay ? "secondary" : "outline"}
        className="h-8 shrink-0 rounded-full"
        onClick={onAdd}
        disabled={disabled || full}
        title={full ? `A path holds ${MAX_KEYS} keyframes at most` : "Adds where the camera is now (K)"}
      >
        <Plus /> Keyframe
      </Button>
      <Button size="sm" variant={overlay ? "secondary" : "outline"} className="h-8 shrink-0 rounded-full" onClick={onPreview} disabled={(disabled && !previewing) || keys.length < 2}>
        {previewing ? <Square /> : <Play />} {previewing ? "Stop" : "Preview"}
      </Button>
    </div>
  );
}

export interface PathOptionsProps {
  engine: Engine;
  preset: string | null;
  onPreset: (id: string) => void;
  duration: number;
  onDuration: (s: number) => void;
  resolution: string;
  resolutions: string[];
  onResolution: (r: string) => void;
  words: string;
  onWords: (w: string) => void;
  notes: string[];
  disabled: boolean;
  /** WorldCast films the path on the studio's worker (N7-9): its own length and shape. */
  worldcast?: boolean;
}

/** The moves, the length and quality, the motion words and what will happen. */
export function PathOptions({ engine, preset, onPreset, duration, onDuration, resolution, resolutions, onResolution, words, onWords, notes, disabled, worldcast }: PathOptionsProps) {
  const wordsId = useId();
  const open = engine === "open";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Camera moves">
        {PATH_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            title={p.description}
            disabled={disabled}
            onClick={() => onPreset(p.id)}
            className={cn("h-8 rounded-full px-3 text-[12.5px] whitespace-nowrap", preset === p.id ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-[12px] text-muted-foreground">Length</p>
        {open && worldcast ? (
          <p className="text-[13px]">
            About {WORLDCAST_SECONDS} s{" "}
            <span className="text-muted-foreground">
              · portrait {WORLDCAST_RUN.width} × {WORLDCAST_RUN.height}, {WORLDCAST_RUN.frames} frames at {WORLDCAST_RUN.fps} fps with WorldCast
            </span>
          </p>
        ) : open ? (
          <p className="text-[13px]">
            About {OPEN_SECONDS} s <span className="text-muted-foreground">· {PATH_FRAMES} frames at {PATH_FPS} fps on your GPU</span>
          </p>
        ) : (
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Length">
            {PATH_DURATIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={duration === s}
                disabled={disabled}
                onClick={() => onDuration(s)}
                className={cn("h-8 min-w-11 rounded-full px-2.5 font-mono text-[12px]", duration === s ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}
              >
                {s} s
              </button>
            ))}
          </div>
        )}
      </div>
      {resolutions.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-[12px] text-muted-foreground">Quality</p>
          <div className="inline-flex h-8 rounded-full bg-muted p-0.5" role="radiogroup" aria-label="Quality">
            {resolutions.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={resolution === r}
                disabled={disabled}
                onClick={() => onResolution(r)}
                className={cn("rounded-full px-3 text-[12.5px] font-medium", resolution === r ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
              >
                {r.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <label htmlFor={wordsId} className="text-[12px] text-muted-foreground">
          What moves in the shot (optional)
        </label>
        <Textarea id={wordsId} value={words} onChange={(e) => onWords(e.target.value)} placeholder={DEFAULT_MOTION} className="min-h-16 text-[13px]" maxLength={2000} disabled={disabled} />
      </div>
      {notes.map((n) => (
        <p key={n} className="text-[12px] leading-snug text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

/** "Film this path · price", with the browser's render progress on the open engine. */
export function FilmButton({ onClick, busy, progress, price, disabled, className }: { onClick: () => void; busy: "render" | "send" | null; progress: number; price: string; disabled: boolean; className?: string }) {
  const label = busy === "render" ? `Rendering the path… ${Math.round(progress * 100)}%` : busy === "send" ? "Sending…" : "Film this path";
  return (
    <Button onClick={onClick} disabled={disabled || !!busy} variant="secondary" className={cn("rounded-full", className)}>
      {busy ? <Loader2 className="animate-spin" /> : <Clapperboard />} {label}
      {!busy && <span className="opacity-80">· {price}</span>}
    </Button>
  );
}
