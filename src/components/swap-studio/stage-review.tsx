"use client";

import { useSoundLive } from "@/lib/api";
import { OriginalSoundPicker } from "@/components/av/original-sound-picker";
import { ORIGINAL_SOUND_FEATURE, originalSoundDefault, originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { Download, Film, Library, Loader2, Play, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "@/components/av/tool-shell";
import { Segmented } from "@/components/faceless/controls";
import { Segmented as SizePicker } from "@/components/shorts/ui";
import { h3Canvas } from "@/lib/catalog/character-swap";
import { defaultSharpenTier, filmSize, gpuMinutes, joinNote, SHARPEN_COPY, sharpenOptions, type SharpenTier } from "@/lib/catalog/sharpen";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import {
  assemblyPieces,
  assemblyTakes,
  chosenTakes,
  currentSegments,
  DECISION_LABELS,
  jobState,
  secondsLabel,
  SWAP_STUDIO,
  usedFinish,
  WORKERS_NOTE,
  type Decision,
  type GenSummary,
  type SwapTake,
} from "@/lib/catalog/swap-studio";
import { downloadHref } from "@/lib/library";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { decisionsHref, useAssemble, useSharpen, useStopJob } from "./hooks";
import { GenChip, JobError, Note, priceText, SavedText } from "./parts";
import type { StageProps } from "./workbench";

const DECISIONS = Object.keys(DECISION_LABELS) as Decision[];

interface TakeRef {
  key: string;
  label: string;
  url: string;
  shotId: string;
  segmentId: string;
  take: SwapTake;
}

/** Every finished take of the clip, for comparing. */
function finishedTakes({ clip, gens }: Pick<StageProps, "clip" | "gens">): TakeRef[] {
  const out: TakeRef[] = [];
  clip.shots.forEach((s, si) =>
    currentSegments(s).forEach((g, gi) =>
      g.takes.forEach((t, ti) => {
        const url = t.genId && gens[t.genId]?.status === "succeeded" ? gens[t.genId].url : undefined;
        const name = `Shot ${si + 1} · segment ${gi + 1} · take ${ti + 1}`;
        if (url) out.push({ key: t.id, label: `${name}${g.selectedTake === t.id ? " (chosen)" : ""}`, url, shotId: s.id, segmentId: g.id, take: t });
        // Its sharper version, to compare with it before keeping it.
        const f = t.finish;
        const sharp = f?.genId && gens[f.genId]?.status === "succeeded" ? gens[f.genId].url : undefined;
        if (f && sharp) out.push({ key: `${t.id}@${f.id}`, label: `${name} · ${SHARPEN_COPY.version(f.tier)}`, url: sharp, shotId: s.id, segmentId: g.id, take: t });
      }),
    ),
  );
  return out;
}

/** Two takes side by side, played together. */
function Compare({ takes }: { takes: TakeRef[] }) {
  const [a, setA] = useState<string | undefined>(takes[0]?.key);
  const [b, setB] = useState<string | undefined>(takes[1]?.key);
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  if (takes.length < 2) return <Note>Make two takes of a segment (or of two segments) to compare them side by side.</Note>;
  const pick = (k: string | undefined) => takes.find((t) => t.key === k);
  const both = () => {
    for (const v of [va.current, vb.current]) {
      if (!v) continue;
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    }
  };
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["A", a, setA, va],
            ["B", b, setB, vb],
          ] as const
        ).map(([name, value, set, ref]) => (
          <div key={name} className="min-w-0 space-y-1.5">
            <Select value={value} onValueChange={set}>
              <SelectTrigger className="h-8 w-full min-w-0 text-[12px]" aria-label={`Take ${name}`}>
                <SelectValue placeholder={`Take ${name}`} />
              </SelectTrigger>
              <SelectContent>
                {takes.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pick(value) && <video ref={ref} src={pick(value)!.url} controls muted playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-media object-contain" />}
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={both}>
        <Play className="size-3.5" /> Play both from the start
      </Button>
    </div>
  );
}

/** A take's sharper version (Assemble → Finish → Sharpen): how it goes, the video, and whether the assembly uses it. */
function FinishVersion({ take, gens, onUse }: { take: SwapTake; gens: Record<string, GenSummary>; onUse: (use: boolean) => void }) {
  const f = take.finish!;
  const s = jobState(f.genId, f.stepIds, gens);
  const url = s.status === "succeeded" && f.genId ? gens[f.genId]?.url : undefined;
  return (
    <div className={cn("space-y-2 rounded-lg border border-dashed p-2", f.use && "border-success")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[12px] font-medium">
          <Sparkles className="size-3.5" /> {SHARPEN_COPY.version(f.tier)}
        </span>
        <GenChip genId={f.genId} stepIds={f.stepIds} gens={gens} />
      </div>
      {url ? <video src={url} controls muted playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-media object-contain" /> : null}
      <JobError genId={f.genId} stepIds={f.stepIds} gens={gens} />
      {url &&
        (f.use ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-success">{SHARPEN_COPY.usingIt(f.tier)}</span>
            <Button size="sm" variant="ghost" className="h-7 rounded-full px-2.5 text-[12px]" onClick={() => onUse(false)}>
              Use the take instead
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-[12px]" onClick={() => onUse(true)}>
            {SHARPEN_COPY.pick(f.tier)}
          </Button>
        ))}
    </div>
  );
}

/** Assemble → Finish: "Sharpen to 1080p / 2K / 4K" (runnable: the size, its price or GPU time, Run). */
function FinishPanel({ id, project, clip, gens, estimate }: Pick<StageProps, "id" | "project" | "clip" | "gens" | "estimate">) {
  const sharpen = useSharpen(id);
  // Your GPU's sharpen regenerates with Open-H3 Regenerate: a 48 GB card (own-setup.ts), said beside the title.
  const press = useOwnSetupPress();
  const stop = useStopJob(id);
  const engine = project.engine;
  const ownSetup = engine === "open" ? "regenerate:swap-sharpen" : undefined;
  const film = filmSize(clip.source.width, clip.source.height, engine);
  // Your GPU redraws the character inside the part of H3's canvas the regenerate keeps.
  const canvas = film ? h3Canvas(film.width, film.height, "768p") : undefined;
  const options = sharpenOptions(engine, film, canvas);
  const fallback = defaultSharpenTier(engine, film, canvas);
  const [picked, setPicked] = useState<SharpenTier | null>(null);
  const tier = picked && options.some((o) => o.tier === picked && o.available) ? picked : fallback;
  const found = assemblyPieces(project, clip);
  const chosen = "pieces" in found ? chosenTakes(found.pieces) : [];
  const finishes = chosen.map((p) => p.take.finish).filter((f) => !!f && (!tier || f.tier === tier));
  const states = finishes.map((f) => jobState(f!.genId, f!.stepIds, gens).status);
  const busy = chosen.some((p) => p.take.finish && ["queued", "running"].includes(jobState(p.take.finish.genId, p.take.finish.stepIds, gens).status));
  // Every chosen take has a version at this size made or on its way: nothing for Sharpen to do.
  const allMade = chosen.length > 0 && finishes.length === chosen.length && states.every((x) => x !== "failed" && x !== "canceled" && x !== "missing");
  const ready = states.filter((x) => x === "succeeded").length;
  const est = estimate?.sharpen[clip.id];
  const seconds = est?.seconds ?? chosen.reduce((n, p) => n + (p.end - p.start) / SWAP_STUDIO.fps, 0);
  const cost = tier ? est?.costUsd[tier] : undefined;
  const problem = "problem" in found ? SHARPEN_COPY.none : !tier ? (options.find((o) => o.reason)?.reason ?? SHARPEN_COPY.small) : null;
  const priceLine = engine === "open" ? (estimate?.demo ? priceText(0, { demo: true, engine }) : `Free on your GPU · ${gpuMinutes(seconds)}`) : priceText(cost, { demo: estimate?.demo, engine });
  const join = joinNote(film);
  const shownTier = tier ?? (engine === "cloud" ? "2K" : "1080p");
  // Why a size can't be picked, said under the picker (a turned-off button can't take focus or show a tooltip on touch).
  const off = options.filter((o) => !o.available && o.reason && o.reason !== problem);
  const offId = `sharpen-off-${clip.id}`;
  return (
    <Panel title="Finish">
      <section aria-labelledby="sharpen-title" className="min-w-0 space-y-3 rounded-xl border p-3">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="sharpen-title" className="text-[13px] font-semibold">
            {SHARPEN_COPY.title} <OwnSetupChip setup={ownSetup} className="ml-1 align-middle" />
          </h3>
          <span className="font-mono text-[11px] text-muted-foreground">{priceLine}</span>
        </div>
        <p className="text-[12px] leading-snug text-pretty text-muted-foreground">{engine === "open" ? SHARPEN_COPY.card(shownTier) : SHARPEN_COPY.cardCloud(shownTier)}</p>
        <SizePicker
          label="Sharpen to"
          value={shownTier}
          onChange={setPicked}
          describedBy={off.length ? offId : undefined}
          options={options.map((o) => ({ value: o.tier, label: o.tier, disabled: !o.available, title: o.reason }))}
        />
        {off.length > 0 && (
          <ul id={offId} className="space-y-0.5 text-[12px] leading-snug text-pretty text-muted-foreground">
            {off.map((o) => (
              <li key={o.tier}>
                <span className="font-medium text-foreground">{o.tier}:</span> {o.reason}
              </li>
            ))}
          </ul>
        )}
        {chosen.length > 0 && (
          <p className="text-[12px] text-muted-foreground">
            {chosen.length} chosen take{chosen.length === 1 ? "" : "s"} · {Math.round(seconds * 10) / 10} s{tier ? ` · ${SHARPEN_COPY.model(engine, tier)}` : ""}
          </p>
        )}
        {problem ? <Note tone="warn">{problem}</Note> : join ? <p className="text-[12px] leading-snug text-pretty text-muted-foreground">{join}</p> : null}
        {est?.problem && !problem && <Note tone="warn">{est.problem}</Note>}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="h-9 rounded-full"
            disabled={!!problem || !tier || sharpen.isPending || busy || allMade}
            onClick={() => tier && press(ownSetup, () => sharpen.mutate({ clipId: clip.id, tier }, { onSuccess: () => toast(`Sharpening the chosen takes to ${tier}`), onError: (e) => toastError(e) }))}
          >
            {sharpen.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Sharpen{tier ? ` to ${tier}` : ""}
          </Button>
          {finishes.length > 0 && (
            <span className="text-[12px] text-muted-foreground">
              {ready} of {chosen.length} ready{ready ? " · compare and pick them in Takes & review" : ""}
            </span>
          )}
          {busy && (
            <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => stop.mutate({ kind: "finish", clipId: clip.id })}>
              Stop
            </Button>
          )}
        </div>
      </section>
    </Panel>
  );
}

/** Takes & review: compare takes, favourite, keep / maybe / skip with notes, the clip's review, Export decisions. */
export function ReviewStage(props: StageProps) {
  const { id, clip, shot, gens, edit } = props;
  const takes = finishedTakes(props);
  return (
    <div className="space-y-3">
      <Panel
        title="Compare"
        aside={
          <Button asChild size="sm" variant="ghost" className="h-8 rounded-full">
            <a href={decisionsHref(id)} download>
              <Download className="size-3.5" /> Export decisions
            </a>
          </Button>
        }
      >
        <Compare key={clip.id} takes={takes} />
      </Panel>

      {shot && shot.mode === "generate" && (
        <Panel title="This shot's takes">
          {!currentSegments(shot).some((g) => g.takes.length) ? (
            <p className="text-[12px] text-muted-foreground">No takes yet — queue segments in Segments.</p>
          ) : (
            <ol className="space-y-4">
              {currentSegments(shot).map((g, gi) =>
                g.takes.length ? (
                  <li key={g.id} className="space-y-2">
                    <p className="text-[13px] font-medium">
                      Segment {gi + 1} <span className="font-normal text-muted-foreground">· {secondsLabel(g.end - g.start)}</span>
                    </p>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {g.takes.map((t, ti) => {
                        const s = t.state === "launched" ? jobState(t.genId, t.stepIds, gens) : null;
                        const url = s?.status === "succeeded" && t.genId ? gens[t.genId]?.url : undefined;
                        const ref = { clipId: clip.id, shotId: shot.id, segmentId: g.id, takeId: t.id } as const;
                        return (
                          <li key={t.id} className={cn("min-w-0 space-y-2 rounded-xl border p-2.5", g.selectedTake === t.id && "border-success")}>
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium">Take {ti + 1}</span>
                              {s ? <GenChip genId={t.genId} stepIds={t.stepIds} gens={gens} /> : <span className="text-[11px] text-muted-foreground">{t.state === "waiting" ? "Waiting" : (t.reason ?? "Stopped")}</span>}
                              <button
                                type="button"
                                onClick={() => void edit({ type: "take", ...ref, favourite: !t.favourite })}
                                aria-pressed={t.favourite}
                                aria-label={t.favourite ? "Unfavourite" : "Favourite"}
                                className="ml-auto grid size-7 place-items-center rounded-full hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                              >
                                <Star className={cn("size-4", t.favourite ? "fill-warning text-warning" : "text-muted-foreground")} />
                              </button>
                            </div>
                            {url ? <video src={url} controls muted playsInline preload="metadata" className="aspect-video w-full rounded-lg bg-media object-contain" /> : null}
                            <Segmented label={`Take ${ti + 1} decision`} value={t.decision} options={DECISIONS.map((d) => ({ value: d, label: DECISION_LABELS[d] }))} onChange={(decision) => void edit({ type: "take", ...ref, decision })} />
                            <SavedText label="Notes" rows={2} max={SWAP_STUDIO.maxNotesChars} value={t.notes} placeholder="lips drift at the end" onSave={(notes) => void edit({ type: "take", ...ref, notes })} />
                            {url && g.selectedTake !== t.id && (
                              <Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-[12px]" onClick={() => void edit({ type: "take", ...ref, select: true })}>
                                Use this take
                              </Button>
                            )}
                            {t.finish && <FinishVersion take={t} gens={gens} onUse={(finishUse) => void edit({ type: "take", ...ref, finishUse })} />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ) : null,
              )}
            </ol>
          )}
        </Panel>
      )}

      <Panel title="This clip's review">
        <div className="space-y-3">
          <Segmented label="Clip decision" value={clip.review} options={DECISIONS.map((d) => ({ value: d, label: DECISION_LABELS[d] }))} onChange={(review) => void edit({ type: "clip", clipId: clip.id, review })} />
          <SavedText label="Notes" rows={2} max={SWAP_STUDIO.maxNotesChars} value={clip.reviewNotes} onSave={(reviewNotes) => void edit({ type: "clip", clipId: clip.id, reviewNotes })} />
        </div>
      </Panel>
    </div>
  );
}

/** Assemble: the chosen takes over the original timeline with the clip's own sound, and Finish (Sharpen). */
export function AssembleStage({ id, project, clip, gens, estimate }: StageProps) {
  const assemble = useAssemble(id);
  const stop = useStopJob(id);
  const found = assemblyPieces(project, clip);
  const a = clip.assembly;
  const state = jobState(a?.genId, a?.stepIds, gens);
  const result = state.status === "succeeded" && a?.genId ? gens[a.genId]?.url : undefined;
  // What of the clip's sound goes back: Everything until the split has passed a real run, then Music & effects only on your GPU (the new speech).
  const [soundAsked, setOriginalSound] = useState<OriginalSound | null>(null);
  const soundLiveNow = useSoundLive(ORIGINAL_SOUND_FEATURE);
  const originalSound = originalSoundOn(soundAsked ?? a?.originalSound ?? originalSoundDefault({ replacesPerson: true, engine: project.engine, live: soundLiveNow }), project.engine);
  const current = "pieces" in found && !!a && JSON.stringify(a.takes) === JSON.stringify(assemblyTakes(found.pieces)) && (a.originalSound ?? "everything") === originalSound;
  return (
    <div className="space-y-3">
      <Panel title="Assemble the clip" aside={<span className="font-mono text-[11px] text-muted-foreground">{priceText(estimate?.assembly[clip.id], { demo: estimate?.demo, engine: project.engine })}</span>}>
        <div className="space-y-3">
          {"problem" in found ? (
            <Note tone="warn">{found.problem}</Note>
          ) : (
            <>
            {found.stale.length > 0 && (
              <Note tone="warn">
                {found.stale.join("; ")} {found.stale.length === 1 ? "uses a take" : "use takes"} made before later changes (settings, words, the character or the take before). The assembly uses {found.stale.length === 1 ? "it" : "them"} as {found.stale.length === 1 ? "it is" : "they are"} — queue {found.stale.length === 1 ? "it" : "them"} again in Segments for current ones.
              </Note>
            )}
            <ol className="flex min-w-0 flex-wrap gap-1.5" aria-label="Pieces">
              {found.pieces.map((p, i) => (
                <li key={i} className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", p.kind === "take" ? "bg-brand-faint text-brand-text" : "bg-muted text-muted-foreground")}>
                  {p.kind === "take" ? `Your character${usedFinish(p.take) ? ` · ${usedFinish(p.take)!.tier}` : ""}` : "As filmed"} · {secondsLabel(p.end - p.start)}
                </li>
              ))}
            </ol>
            </>
          )}
          <p className="text-[12px] text-muted-foreground">
            {project.engine === "open"
              ? "Each piece is fitted to the clip's size at 24 fps, joined packet by packet, and the clip's own sound goes back on."
              : "The clip's pieces are cut to their frames, every piece is scaled to one frame size, they're joined at 24 fps (H3's rate), and the clip's own sound — or its silence — goes back on."}
          </p>
          {clip.source.hasAudio && <OriginalSoundPicker engine={project.engine} value={originalSound} onChange={setOriginalSound} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="h-9 rounded-full"
              disabled={"problem" in found || assemble.isPending || state.status === "queued" || state.status === "running" || (current && state.status === "succeeded")}
              onClick={() => assemble.mutate({ clipId: clip.id, ...(originalSound !== "everything" && { originalSound }) }, { onSuccess: () => toast("Assembling the clip"), onError: (e) => toastError(e) })}
            >
              {assemble.isPending ? <Loader2 className="size-4 animate-spin" /> : <Film className="size-4" />} {a ? "Assemble again" : "Assemble clip"}
            </Button>
            {a && <GenChip genId={a.genId} stepIds={a.stepIds} gens={gens} />}
            {(state.status === "queued" || state.status === "running") && (
              <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => stop.mutate({ kind: "assembly", clipId: clip.id })}>
                Stop
              </Button>
            )}
            {a && !current && state.status === "succeeded" && <span className="text-[12px] text-muted-foreground">The chosen takes or the sound changed since — assemble again for the new ones.</span>}
          </div>
          <JobError genId={a?.genId} stepIds={a?.stepIds} gens={gens} />
          {result && (
            <div className="space-y-2">
              <video src={result} controls playsInline preload="metadata" className="max-h-[46vh] w-full rounded-xl bg-media" />
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" className="h-8 rounded-full">
                  <a href={downloadHref(result, `${clip.name}-character-swap.mp4`)}>
                    <Download className="size-3.5" /> Download
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline" className="h-8 rounded-full">
                  <Link href="/library">
                    <Library className="size-3.5" /> In the Library
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <FinishPanel id={id} project={project} clip={clip} gens={gens} estimate={estimate} />

      <Panel title="Where it runs">
        <ul className="space-y-1.5 text-[12px] leading-snug text-pretty text-muted-foreground">
          {project.engine === "open" && <li>{WORKERS_NOTE}</li>}
          {(estimate?.notes ?? []).filter((n) => n !== WORKERS_NOTE).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
