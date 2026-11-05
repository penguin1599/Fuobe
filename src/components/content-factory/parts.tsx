"use client";

import { AlertTriangle, Check, ChevronDown, Copy, Film, Info, Loader2, Pencil, RotateCcw, Sparkles, Terminal, X } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StyleArt } from "@/components/faceless/style-art";
import { CoverArt, useCoverPlayback } from "@/components/template-cover";
import { usd } from "@/components/faceless/controls";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import {
  briefLines,
  mcpCommand,
  PLATFORM_LABEL,
  PRESETS,
  type SeriesAnalysis,
  type SeriesEstimate,
  type SeriesReference,
  type StyleBrief,
  type StylePreset,
} from "@/lib/catalog/content-factory";
import { formatLength } from "@/lib/catalog/faceless";
import type { Engine } from "@/lib/catalog/types";
import { copyText } from "@/lib/clipboard";
import { templateCover } from "@/lib/template-covers";
import { cn } from "@/lib/utils";
import { claudePrompt, type SeriesAsk } from "./hooks";

/** The research's pricing line (Higgsfield settles the cost once the video is made; Fuobe's providers do too). */
export const PRICE_NOTE = "Final cost depends on video complexity and is settled once your video is generated. It may be slightly higher or lower than shown.";

async function copy(text: string, what: string) {
  if (await copyText(text)) toast.success(`${what} copied`);
  else toast.error("Couldn't copy — select the text and copy it yourself");
}

// ---------------------------------------------------------------------------
// The reference

/** "TikTok · 0:42 · 9:16" */
function referenceMeta(ref: SeriesReference): string {
  const shape = ref.width && ref.height ? (ref.width > ref.height ? "16:9" : ref.width < ref.height ? "9:16" : "1:1") : null;
  return [ref.kind === "preset" ? "Preset style" : ref.platform ? PLATFORM_LABEL[ref.platform] : "Your clip", ref.seconds ? formatLength(ref.seconds) : null, shape].filter(Boolean).join(" · ");
}

/** The reference in the composer or on the series page: its picture, what it is, and how reading it is going. */
export function ReferenceCard({
  reference,
  analysis,
  styleId,
  onClear,
  onReread,
  rereading,
  className,
}: {
  reference: SeriesReference;
  analysis: SeriesAnalysis | null;
  styleId: string;
  onClear?: () => void;
  onReread?: () => void;
  rereading?: boolean;
  className?: string;
}) {
  const reading = analysis?.status === "reading";
  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-2xl bg-muted/60 p-2 pr-3", className)}>
      <div className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-muted">
        {reference.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={reference.thumbnail} alt="" className="size-full object-cover" />
        ) : reference.url ? (
          <>
            <Film className="absolute inset-0 m-auto size-5 text-muted-foreground" aria-hidden />
            <video src={`${reference.url}#t=0.5`} muted playsInline preload="metadata" className="relative size-full object-cover" aria-hidden />
          </>
        ) : (
          <StyleArt styleId={styleId} sizes="56px" />
        )}
        {reading && (
          <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
            <Loader2 className="size-4 animate-spin" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{reference.title || (reference.kind === "link" ? reference.link : "Reference clip")}</p>
        <p className="truncate text-[12px] text-muted-foreground">{referenceMeta(reference)}</p>
        <p className="mt-0.5 text-[12px]" role="status" aria-live="polite">
          {reading ? (
            <span className="text-muted-foreground">{analysis?.stage ?? "Reading the style…"}</span>
          ) : analysis?.status === "failed" ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertTriangle className="size-3 shrink-0" /> {analysis.error ?? "Couldn't read it"}
            </span>
          ) : analysis?.offline ? (
            <span className="inline-flex items-center gap-1">
              <Info className="size-3 shrink-0 text-warning" /> Rough brief — see its note
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Check className="size-3 shrink-0 text-success" /> {reference.kind === "preset" ? "Ready to use" : "Style brief ready"}
            </span>
          )}
        </p>
      </div>
      {onReread && reference.url && !reading && (
        <Button variant="ghost" size="sm" className="shrink-0 rounded-full" onClick={onReread} disabled={rereading} aria-label="Read the clip again">
          {rereading ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          <span className="hidden sm:inline">Read again</span>
        </Button>
      )}
      {onClear && (
        <button type="button" onClick={onClear} className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Change reference">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The brief

type EditableKey = "format" | "hook" | "pacing" | "look";
const EDITABLE: { key: EditableKey; label: string }[] = [
  { key: "format", label: "Format" },
  { key: "hook", label: "Hook (first 3 seconds)" },
  { key: "pacing", label: "Pacing" },
  { key: "look", label: "Look of every picture" },
];

/** What every episode follows: format, hook, pacing, shots, narrator, music and captions — with the reading's note, and an editor. */
/**
 * The style brief every episode follows, with Edit. `folded`: it starts as one line that opens on a tap (Content
 * Factory's home while there are no series yet, so its ready series stay near the composer).
 */
export function BriefCard({ brief, note, onSave, saving, className, folded = false }: { brief: StyleBrief; note?: string; onSave?: (b: StyleBrief) => void; saving?: boolean; className?: string; folded?: boolean }) {
  const [draft, setDraft] = useState<StyleBrief | null>(null);
  const [open, setOpen] = useState(!folded);
  const id = useId();
  const shut = !open && !draft;
  return (
    <section aria-labelledby={`${id}-t`} className={cn("rounded-2xl border bg-background text-left", shut ? "px-4 py-2.5" : "p-4", className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-brand-text" />
        <h3 id={`${id}-t`} className="text-[14px] font-medium">
          Style brief
        </h3>
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">every episode follows it</span>
        {!draft && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onSave && !shut && (
              <Button variant="ghost" size="sm" className="h-7 rounded-full" onClick={() => setDraft(brief)}>
                <Pencil /> Edit
              </Button>
            )}
            {folded && (
              <Button variant="ghost" size="sm" className="h-7 rounded-full" aria-expanded={open} aria-controls={`${id}-b`} onClick={() => setOpen((v) => !v)}>
                {open ? "Hide" : "Show"} <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
              </Button>
            )}
          </div>
        )}
      </div>
      {note && !shut && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-[12px] text-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="min-w-0">{note}</span>
        </p>
      )}
      {draft ? (
        <form
          className="mt-3 space-y-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            onSave?.(draft);
            setDraft(null);
          }}
        >
          {EDITABLE.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[12px] font-medium text-muted-foreground">{f.label}</span>
              <textarea
                value={draft[f.key]}
                maxLength={f.key === "look" ? 600 : 400}
                rows={2}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="mt-1 w-full resize-none rounded-lg border bg-background px-2.5 py-1.5 text-[13px] leading-snug outline-none [field-sizing:content] focus:border-primary"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground">Narrator</span>
            <input
              value={draft.voice.tone}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, voice: { ...draft.voice, tone: e.target.value } })}
              className="mt-1 h-9 w-full rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground">Music</span>
            <input
              value={draft.music.mood}
              maxLength={300}
              onChange={(e) => setDraft({ ...draft, music: { ...draft.music, mood: e.target.value } })}
              className="mt-1 h-9 w-full rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:border-primary"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />} Save brief
            </Button>
          </div>
        </form>
      ) : (
        <ul id={`${id}-b`} hidden={shut} className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] leading-snug sm:grid-cols-2">
          {[...briefLines(brief), `Look: ${brief.look}`].map((l) => {
            const [k, ...v] = l.split(": ");
            return (
              <li key={l} className="min-w-0">
                <span className="text-muted-foreground">{k}:</span> {v.join(": ")}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Presets ("Pick a trending style to start from")

export function PresetGrid({ value, onPick }: { value: string | null; onPick: (p: StylePreset) => void }) {
  const picked = PRESETS.some((p) => p.id === value);
  return (
    <div role="radiogroup" aria-label="Preset styles" onKeyDown={radioKeys} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {PRESETS.map((p, i) => (
        <PresetTile key={p.id} p={p} on={value === p.id} tabStop={picked ? value === p.id : i === 0} onPick={onPick} />
      ))}
    </div>
  );
}

/** A trending style: its real cover when it has one (a clip plays as the gallery cards' do), else its style's picture. */
export function PresetTile({ p, on, tabStop, onPick }: { p: StylePreset; on: boolean; tabStop: boolean; onPick: (p: StylePreset) => void }) {
  const cover = templateCover("content-factory", p.id);
  const { ref, playing, asked, handlers } = useCoverPlayback<HTMLButtonElement>(`content-factory/${p.id}`, cover);
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={on}
      tabIndex={radioTab(tabStop)}
      {...handlers}
      onClick={() => onPick(p)}
      className={cn(
        "group/preset relative min-w-0 overflow-hidden rounded-2xl border bg-background text-left transition-[box-shadow,border-color] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-primary ring-2 ring-brand-faint" : "hover:border-border-strong",
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden">
        {cover ? (
          <CoverArt cover={cover} sizes="(max-width: 640px) 50vw, 280px" playing={playing} asked={asked} />
        ) : (
          <StyleArt styleId={p.brief.styleId} className="transition-transform duration-300 ease-move group-hover/preset:scale-[1.04]" />
        )}
        <span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">{p.brief.aspect === "9:16" ? "Vertical" : "Horizontal"}</span>
        {on && (
          <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-soft">
            <Check className="size-3.5" />
          </span>
        )}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 text-[14px] leading-tight font-medium" title={p.name}>
          {p.name}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{p.tagline}</p>
        <p className="mt-2 text-[12px] font-medium text-brand-text">{on ? "In use" : "Use as reference"}</p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The price

/**
 * "≈ $4.20 · 3 episodes × $1.40" / "Placeholder · free" / "Free · your GPU", with the research's pricing note.
 */
export function SeriesPriceLine({ data, loading, engine, className }: { data: SeriesEstimate | undefined; loading?: boolean; engine: Engine; className?: string }) {
  if (!data) return <span className={cn("inline-flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground", className)}>{loading && <Loader2 className="size-3 animate-spin" />}Estimating…</span>;
  const p = data.price;
  const each = p.episodes > 1 ? ` · ${p.episodes} × ${usd(p.perEpisode)}` : "";
  const price = data.demo ? "Placeholder · free" : engine === "open" ? "Free · your GPU" : `≈ ${usd(p.total)}${p.unknown ? "+" : ""}${each}`;
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={cn("inline-flex items-center gap-1 font-mono text-[12px] text-foreground tabular-nums hover:underline", loading && "opacity-60")}>
            {price}
            {loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : <Info className="size-3 text-muted-foreground" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3 text-[13px]" collisionPadding={12}>
          <p className="font-medium">How the price works</p>
          <p className="mt-1 text-[12px] text-muted-foreground">{data.demo ? "Some steps aren't connected, so this run makes placeholder results." : engine === "open" ? "Every step runs on your own ComfyUI, free." : PRICE_NOTE}</p>
          {!data.demo && engine === "cloud" && p.episodes > 1 && (
            <p className="mt-2 font-mono text-[12px] tabular-nums">
              {p.episodes} episodes × {usd(p.perEpisode)} = {usd(p.total)}
            </p>
          )}
          {data.notes?.map((n) => (
            <p key={n} className="mt-2 border-t pt-2 text-[12px] text-muted-foreground">
              {n}
            </p>
          ))}
        </PopoverContent>
      </Popover>
      <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
        {formatLength(data.seconds)} · {data.scenes} scene{data.scenes === 1 ? "" : "s"} each
      </span>
      {data.briefPending && <span className="text-[12px] text-muted-foreground">· priced again once the clip is read</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// "Generate in Claude": the claude mcp add line and the message, with copy buttons (nothing is sent anywhere)

function CodeBox({ text, label, wrap, className }: { text: string; label: string; wrap?: boolean; className?: string }) {
  return (
    <div className={cn("relative rounded-xl bg-muted", className)}>
      <pre tabIndex={0} aria-label={label} className={cn("max-h-64 overflow-auto p-3 pr-12 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring", wrap ? "whitespace-pre-wrap" : "whitespace-pre")}>
        {text}
      </pre>
      <button type="button" onClick={() => void copy(text, label)} className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg bg-background text-muted-foreground shadow-soft hover:text-foreground" aria-label={`Copy ${label.toLowerCase()}`}>
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

export function ClaudeDialog({ open, onOpenChange, ask }: { open: boolean; onOpenChange: (v: boolean) => void; ask: (SeriesAsk & { seriesId?: string; presetId?: string }) | null }) {
  const key = ask && JSON.stringify(ask);
  const q = useQuery({ queryKey: ["content-factory", "claude", key], enabled: open && !!key, queryFn: () => claudePrompt(JSON.parse(key!)), retry: false, staleTime: 60_000 });
  const out = q.data ?? null;
  const error = q.error ? (q.error as Error).message : null;
  const [origin] = useState(() => (typeof window === "undefined" ? "http://localhost:3000" : window.location.origin));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Generate in Claude</DialogTitle>
          <DialogDescription>Claude plans and writes the episodes, then makes them with Fuobe through its MCP server. It prices each one and asks you before it spends anything.</DialogDescription>
        </DialogHeader>
        <ol className="min-w-0 space-y-4 text-[13px]">
          <li className="min-w-0 space-y-1.5">
            <p className="font-medium">
              <span className="text-muted-foreground">1.</span> Connect Fuobe to Claude Code (once)
            </p>
            <CodeBox text={mcpCommand(origin, !!out?.needsToken)} label="Command" />
            {out?.needsToken && (
              <p className="text-[12px] text-muted-foreground">
                This studio has a password: create a token in{" "}
                <Link href="/settings#security" className="underline underline-offset-2">
                  Settings → Security
                </Link>{" "}
                and put it in place of fuobe_…
              </p>
            )}
          </li>
          <li className="min-w-0 space-y-1.5">
            <p className="font-medium">
              <span className="text-muted-foreground">2.</span> Paste this into Claude Code
            </p>
            {out?.engineNote && (
              <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-[12px]">
                <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span className="min-w-0">{out.engineNote}</span>
              </p>
            )}
            {out && out.parts > 1 && (
              <p className="flex items-start gap-1.5 text-[12px] text-muted-foreground">
                <Film className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">
                  Each episode comes out as {out.parts} videos of about {formatLength(out.partSeconds)}: Fuobe&apos;s faceless_episode tool makes up to 8 scenes a call. Put them together with{" "}
                  <Link href="/video-tools/join" className="underline underline-offset-2">
                    Video tools → Join clips
                  </Link>
                  .
                </span>
              </p>
            )}
            {error ? (
              <p role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
              </p>
            ) : out ? (
              <CodeBox text={out.message} label="Prompt" wrap />
            ) : (
              <div className="flex h-24 items-center justify-center gap-2 rounded-xl bg-muted text-[12px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Writing the prompt…
              </div>
            )}
          </li>
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Terminal className="size-3.5 shrink-0" /> Nothing is sent from here.
          </p>
          <Button disabled={!out} onClick={() => out && void copy(out.message, "Prompt")}>
            <Copy /> Copy prompt
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
