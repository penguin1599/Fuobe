"use client";

import { AudioLines, Cloud, Cpu, Library, Loader2, SlidersVertical, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/faceless/controls";
import { Panel } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import {
  BED_LEVELS,
  CLEANERS,
  CLOUD_NOTE,
  cleanerOf,
  DEFAULT_BED,
  DEFAULT_CLEANER,
  OPEN_NOTE,
  RELATION_NOTE,
  type BedLevel,
  type Cleaner,
} from "@/lib/av/clean-dialogue";
import { durationWords, openToolPrice, QUALITY_LABELS, type SplitQuality } from "@/lib/av/split";
import type { Engine } from "@/lib/catalog/types";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import { useAudioToolPreview, useAudioToolRun, useSettled, type AudioToolBody } from "./hooks";

/**
 * Split soundtrack → Clean up dialogue (DBS D5): one run that leaves the speech clear. On your GPU, DBS takes the music
 * and effects out from under the dialogue (or keeps them quietly, at a level picked here) in one job (graph C), and a
 * video gets its soundtrack back with the picture copied. In the cloud, a hosted speech cleaner under its own name. The
 * panel also says how this relates to Clean up voice, which repairs the voice itself.
 */

export interface CleanSource {
  ref: string;
  kind: "audio" | "video";
  name: string;
  duration?: number;
  channels?: number;
}

const bedText = (b: BedLevel) => (b === "off" ? "Off" : `${b} dB`.replace("-", "−"));
const onDevice = (device?: string) => (device === "cuda" ? "on your GPU" : device ? "on your CPU" : "on a CPU");
const price = (p: { costUsd: number | null; demo: boolean } | undefined) =>
  !p ? "…" : p.demo ? "Placeholder · free" : p.costUsd === null ? "Price unknown" : p.costUsd < 0.01 ? "under $0.01" : `≈ $${p.costUsd.toFixed(2)}`;

export function CleanDialoguePanel({
  source,
  engine,
  blocker,
  onMixer,
}: {
  /** The soundtrack, once it's uploaded. */
  source: CleanSource | null;
  /** The header's engine switch: your GPU (DBS) or the cloud (a hosted cleaner). */
  engine: Engine;
  /** Why nothing can run yet (no file, uploading), in words. */
  blocker: string | null;
  /** Switch to Split into stems (the mixer opens on the Clean dialogue preset). */
  onMixer: () => void;
}) {
  const [bed, setBed] = useState<BedLevel>(DEFAULT_BED);
  const [quality, setQuality] = useState<SplitQuality | null>(null);
  const [stereo, setStereo] = useState(false);
  const [cleaner, setCleaner] = useState<Cleaner>(DEFAULT_CLEANER);
  const [remux, setRemux] = useState(true);
  const [resultId, setResultId] = useState<string | null>(null);
  const run = useAudioToolRun();
  const result = useGeneration(resultId);
  const stereoId = useId();
  const remuxId = useId();

  const body: AudioToolBody | null = useMemo(
    () =>
      source
        ? {
            tool: "clean-dialogue",
            engine,
            media: source.ref,
            kind: source.kind,
            name: source.name,
            ...(engine === "open" ? { bed, ...(quality && { quality }), ...(stereo && { stereo }) } : { cleaner }),
            ...(source.kind === "video" && !remux && { remux: false }),
            ...(source.channels && { channels: source.channels }),
            ...(source.duration && { sourceDuration: source.duration }),
          }
        : null,
    [source, engine, bed, quality, stereo, cleaner, remux],
  );
  const settled = useSettled(body);
  const preview = useAudioToolPreview(settled);
  // While a change settles, the last answer is for other settings: say "Checking…" rather than its price.
  const p = settled === body ? preview.data : undefined;
  const error = preview.error ? (preview.error as Error).message : null;
  const picked: SplitQuality = quality ?? p?.hostPick ?? "fast";
  const g = result.data;
  const busy = run.isPending || g?.status === "queued" || g?.status === "running";
  const out = g?.status === "succeeded" ? g.outputs.find((o) => o.kind === "video") ?? g.outputs.find((o) => o.kind === "audio") : undefined;
  const cleanVoiceHref = source ? `/audio/clean?${source.kind}=${encodeURIComponent(source.ref)}` : "/audio/clean";

  const go = () => {
    if (blocker) return void toast(blocker);
    if (error) return void toast.error(error);
    if (!body) return;
    run.mutate(body, {
      onSuccess: (r) => {
        setResultId(r.result.id);
        toast.success("Cleaning the dialogue…");
      },
      onError: (e) => toastError(e),
    });
  };

  return (
    <div className="space-y-3">
      <Panel title="Clean up dialogue">
        <div className="space-y-3">
          {engine === "open" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-[13px]">Under it</span>
                <Segmented label="Music and effects under the dialogue" value={bed} onChange={setBed} options={BED_LEVELS.map((b) => ({ value: b, label: bedText(b), hint: b === "off" ? "The dialogue alone" : `Music and effects kept ${Math.abs(b)} dB down` }))} />
              </div>
              <p className="text-[12px] text-muted-foreground sm:pl-[4.5rem]">{bed === "off" ? "Just the dialogue: music and sound effects removed." : `The dialogue clear, with the music and effects kept quietly ${Math.abs(bed)} dB under it.`}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-[13px]">Model</span>
                <Segmented label="Model" value={picked} onChange={(v) => setQuality(v)} options={(["fast", "best"] as const).map((q) => ({ value: q, label: `${QUALITY_LABELS[q]}${p?.installed && !p.installed.includes(q) ? " · not installed" : ""}` }))} />
              </div>
              {source?.channels !== 1 && !(source?.channels && source.channels > 2) && (
                <div className="flex items-center gap-2">
                  <Switch id={stereoId} checked={stereo} onCheckedChange={setStereo} />
                  <label htmlFor={stereoId} className="text-[13px]">
                    Keep it stereo <span className="text-muted-foreground">(takes about twice as long)</span>
                  </label>
                </div>
              )}
              <p className="flex gap-2 text-[13px] text-muted-foreground">
                <Cpu className="mt-0.5 size-3.5 shrink-0" /> {OPEN_NOTE}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-[13px]">Cleaner</span>
                <Segmented label="Cleaner" value={cleaner} onChange={setCleaner} options={CLEANERS.map((c) => ({ value: c.id, label: c.label, hint: c.hint }))} />
              </div>
              <p className="text-[12px] text-muted-foreground sm:pl-[4.5rem]">{cleanerOf(cleaner).hint}</p>
              <p className="flex gap-2 text-[13px] text-muted-foreground">
                <Cloud className="mt-0.5 size-3.5 shrink-0" /> {CLOUD_NOTE}
              </p>
            </>
          )}
          {source?.kind === "video" && (
            <div className="flex items-center gap-2">
              <Switch id={remuxId} checked={remux} onCheckedChange={setRemux} />
              <label htmlFor={remuxId} className="text-[13px]">
                Put it back on the video {engine === "open" && <span className="text-muted-foreground">(picture copied as it is)</span>}
              </label>
            </div>
          )}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-[12px] text-muted-foreground">
            <span>{RELATION_NOTE}</span>
            <Link href={cleanVoiceHref} className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
              <AudioLines className="size-3.5" /> Clean up voice
            </Link>
          </p>
        </div>
      </Panel>

      <div className="space-y-2">
        {!blocker && !error && p && (
          <div className="space-y-1 text-[13px] text-muted-foreground" aria-live="polite">
            <p>{p.summary}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <p className={cn("min-w-0 flex-1 text-[13px]", error && !blocker ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
            {blocker ? (
              blocker
            ) : error ? (
              error
            ) : !p ? (
              "Checking…"
            ) : engine === "open" ? (
              <>
                <span className="font-mono text-foreground">{openToolPrice(p)}</span>
                {p.estimate && !p.demo ? ` · ${durationWords(p.estimate)} ${onDevice(p.device)}` : ""}
              </>
            ) : (
              <span className="font-mono text-foreground">{price(p)}</span>
            )}
          </p>
          <Button size="lg" className={cn("rounded-full", (blocker || error) && "bg-muted text-subtle-foreground hover:bg-muted")} onClick={go} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Clean it
          </Button>
        </div>
      </div>

      {g && (g.status === "queued" || g.status === "running") && (
        <Panel>
          <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {g.message ?? "Cleaning"}…{g.progress ? ` ${Math.round(g.progress * 100)}%` : ""}
          </p>
        </Panel>
      )}
      {g?.status === "failed" && (
        <p className="text-[13px] text-destructive" role="alert">
          {g.error ?? "The clean failed"}
        </p>
      )}
      {out && (
        <Panel title="Clean dialogue" aside={<span className="rounded-full bg-success/15 px-2 py-0.5 text-[12px] font-medium text-success">In your Library</span>}>
          <div className="space-y-3">
            {out.kind === "video" ? (
              <video src={out.url} controls playsInline preload="metadata" className="max-h-[40vh] w-full rounded-xl bg-media object-contain" />
            ) : (
              <audio src={out.url} controls preload="metadata" className="h-9 w-full min-w-0" aria-label="Play the clean dialogue" />
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="rounded-full" asChild>
                <Link href="/library">
                  <Library className="size-3.5" /> Open Library
                </Link>
              </Button>
              {engine === "open" && (
                <Button variant="ghost" size="sm" className="rounded-full" onClick={onMixer}>
                  <SlidersVertical className="size-3.5" /> Fine-tune in the mixer
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}
      {!out && engine === "open" && (
        <p className="text-[12px] text-muted-foreground">
          Want to set each level yourself?{" "}
          <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onMixer}>
            Split it into stems
          </button>{" "}
          and the mixer opens on Clean dialogue.
        </p>
      )}
    </div>
  );
}
