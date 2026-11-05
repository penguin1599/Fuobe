"use client";

import { Check, CircleAlert, Film, Library, Loader2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LibraryGrid } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useAskBeforeUpload } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SourceClip } from "./use-source-clip";

/** Small pieces shared by Shorts Studio and Mixed Media. */

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  className,
  describedBy,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
  /** The id of text that says more (why some options are turned off). */
  describedBy?: string;
}) {
  // The Tab stop is the checked option, or the first one that can be picked when it's turned off
  // (a disabled button can't take focus, and the whole group would be skipped).
  const stop = options.some((o) => o.value === value && !o.disabled) ? value : options.find((o) => !o.disabled)?.value;
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} onKeyDown={radioKeys} className={cn("flex w-full rounded-full bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={radioTab(stop === o.value)}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-full px-2 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground",
            value === o.value && "bg-background text-foreground shadow-soft",
          )}
        >
          {o.label}
          {o.hint && <span className="hidden text-[11px] font-normal text-muted-foreground sm:inline">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Tabs pattern for a role="tablist": arrows (and Home / End) move to the next tab and open it; only the open tab is a Tab stop. */
export function tabKeys(e: React.KeyboardEvent<HTMLElement>) {
  const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  // A disabled tab (one the engine can't run) is skipped: it can't take focus.
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not(:disabled)')];
  if (!tabs.length) return;
  e.preventDefault();
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (Math.max(at, 0) + step + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

/** A labelled block in a setup panel. */
export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] font-medium">
            {label}
          </label>
        ) : (
          <span className="text-[13px] font-medium">{label}</span>
        )}
        {hint && <span className="truncate text-[12px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * "Upload a video to edit": click, drop, or pick from the Library. disabled: a tool that can't run here for this
 * visitor (the page says why), so nothing is uploaded only to be refused. Anyone the upload would refuse is asked first
 * (useAskBeforeUpload): a guest to sign up, an account with neither its own GPU nor its own key to connect one.
 */
export function ClipDrop({
  accept,
  limits,
  onFile,
  onLibrary,
  disabled,
  gpuOnly,
}: {
  accept: string;
  limits: string;
  onFile: (f: File) => void;
  onLibrary: (url: string, name?: string) => void;
  disabled?: boolean;
  /** A tool no key runs (Restore & colourise): an account without a GPU is asked for one, even when it has a key. */
  gpuOnly?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [lib, setLib] = useState(false);
  const askFirst = useAskBeforeUpload({ gpuOnly });
  return (
    <div
      aria-disabled={disabled || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled && !askFirst()) onFile(f);
      }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-4 py-7 text-center transition-colors",
        over && "border-primary bg-brand-faint",
      )}
    >
      <span className="grid size-11 place-items-center rounded-full bg-brand-faint text-brand-text">{over ? <Upload className="size-5" /> : <Film className="size-5" />}</span>
      <div>
        <p className="text-[14px] font-medium">Upload a video to edit</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{limits}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => askFirst() || input.current?.click()}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          <Upload className="size-3.5" /> Choose a video
        </button>
        <Popover open={lib && !disabled} onOpenChange={setLib}>
          <PopoverTrigger asChild>
            <button type="button" disabled={disabled} className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3.5 text-[13px] font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50">
              <Library className="size-3.5" /> From library
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(92vw,340px)] p-2" collisionPadding={12}>
            <p className="px-1 pb-2 text-[13px] font-medium">Videos in your library</p>
            {lib && (
              <LibraryGrid
                kinds={["video"]}
                onPick={(v) => {
                  setLib(false);
                  onLibrary(v.ref ?? v.preview, v.name);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
      <p className={cn("text-[11px] text-muted-foreground", disabled && "invisible")}>or drop it here</p>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Asked again here too: a file can arrive without the button (a file picker opened another way).
          if (f && !askFirst()) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The clip's name, upload progress and a remove button. */
export function ClipBar({ clip, onRemove }: { clip: SourceClip; onRemove: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2">
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full", clip.error ? "bg-destructive/10 text-destructive" : "bg-background text-muted-foreground")}>
        {clip.error ? <CircleAlert className="size-3.5" /> : clip.uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5 text-success" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{clip.name}</p>
        {/* An error is read whole (two lines), not cut off like the size line. */}
        <p className={cn("text-[11px]", clip.error ? "line-clamp-2 text-destructive" : "truncate text-muted-foreground")} aria-live="polite">
          {clip.error
            ? clip.error
            : clip.uploading
              ? clip.progress < 1
                ? `Uploading… ${Math.round(clip.progress * 100)}%`
                : "Reading the clip…"
              : [clip.size ? mb(clip.size) : null, clip.info?.fps ? `${Math.round(clip.info.fps)} fps` : null, clip.info?.hasAudio === false ? "no sound" : null].filter(Boolean).join(" · ") || "Uploaded"}
        </p>
        {clip.uploading && clip.progress < 1 && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-background">
            <div className="h-full bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(Math.round(clip.progress * 100)) / 100})` }} />
          </div>
        )}
      </div>
      <button type="button" onClick={onRemove} aria-label="Remove the clip" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** "1 Choose preset · 2 Upload video · 3 Download", with the steps done so far ticked. */
export function Steps({ steps, current, className }: { steps: string[]; current: number; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]", className)} aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === current ? "step" : undefined}>
          {i > 0 && <span className="h-px w-4 bg-border-strong sm:w-6" aria-hidden />}
          <span
            className={cn(
              "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
              i < current ? "bg-success text-white" : i === current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {i < current ? <Check className="size-3" /> : i + 1}
          </span>
          <span className={cn("font-medium whitespace-nowrap", i === current ? "text-foreground" : "text-muted-foreground")}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** "≈ $0.42", "Placeholder · free", "Free · your GPU". A visitor's price is never a demo (src/server/visitor.ts priceAs). */
export function costText(e: { costUsd: number | null; demo: boolean } | undefined, engine: "cloud" | "open"): string {
  if (!e) return "…";
  if (e.demo) return "Placeholder · free";
  if (engine === "open") return "Free · your GPU";
  if (e.costUsd === null) return "Price unknown";
  if (e.costUsd === 0) return "Free";
  return `≈ $${e.costUsd < 1 ? e.costUsd.toFixed(3).replace(/0$/, "") : e.costUsd.toFixed(2)}`;
}
