"use client";

import { Cpu, Download, ExternalLink, KeyRound, Loader2, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGenerationList } from "@/components/av/use-generation";
import { VideoCompare } from "@/components/remove-object/video-compare";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { ClipBar, ClipDrop, costText, Field, Segmented } from "@/components/shorts/ui";
import { clipDuration, clipSize, useSourceClip } from "@/components/shorts/use-source-clip";
import { Feed } from "@/components/studio/feed";
import { MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import type { OwnSetup } from "@/lib/own-setup";
import { useEngine, useGenerations, useLikelyVisitor } from "@/lib/api";
import { CLOUD_NOTE, GPU_NOTE, offlineRestorePrompt, RESTORE, RESTORE_UPSCALE, restoreNegative } from "@/lib/catalog/restore";
import type { Engine } from "@/lib/catalog/types";
import { THEN_UPSCALE } from "@/lib/catalog/upscale-first";
import { chainState } from "@/lib/catalog/shorts";
import { downloadHref, downloadName } from "@/lib/library";
import { cn } from "@/lib/utils";
import { grabFrames, useRestoreActions, useRestoreEstimate, type RestoreBody } from "./hooks";

const LIMITS = `MP4, MOV, WebM, MKV or AVI · up to ${RESTORE.maxSeconds / 60} minutes · ${RESTORE.maxBytes / 1024 / 1024 / 1024} GB`;
const BY: Record<string, string> = { claude: "Written by Claude from your frames", local: "Written by a local model", offline: "Fuobe's template: edit it to fit your footage", you: "Your words" };
const DEFAULT_NEGATIVE = restoreNegative();

interface Run {
  final: string;
  ids: string[];
  before: string;
  ratio?: number;
  prompt: string;
  by: string;
}

/**
 * Video tools → Restore & colourise (Fuobe Restore, package archive-restore): an archive clip, a sentence about its
 * period, place and light (written from a few frames if you like), what must not be invented, and on your GPU Restore
 * to 4K, deinterlacing and a reference picture; priced before it runs ("Free" on your GPU); the result with a before /
 * after wipe. A clip handed over from the Library or a result arrives as ?video=.
 */
export function RestoreTool({ setup }: { setup?: OwnSetup | null } = {}) {
  // What the page read for "video-tools:restore" (ownSetupsNow): null once its graph is validated, when the label leaves.
  const item = setup === undefined ? "video-tools:restore" : setup;
  // Guests and accounts: it runs on the visitor's own GPU (own-setup.ts "video-tools:restore"), so their page is the
  // GPU's whatever the engine switch says: the cloud engine carries the gated Restore IC-LoRA, which never goes with a
  // visitor's own key. A guest signs up first, an account without a GPU connects one; the words come from Fuobe's
  // template (the studio's AI helper is the owner's).
  const visitor = useLikelyVisitor();
  const [chosen] = useEngine();
  const engine: Engine = visitor ? "open" : chosen;
  const press = useOwnSetupPress();
  const source = useSourceClip(RESTORE.maxBytes);
  const clip = source.clip;
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState(DEFAULT_NEGATIVE);
  const [by, setBy] = useState<string | null>(null);
  const [refine, setRefine] = useState(false);
  const [deinterlace, setDeinterlace] = useState(false);
  // Upscale → "Restore archive footage first" arrives with ?then=upscale: the upscale runs after, as one job.
  // (Read once: the switch shows only once a clip is in, after the first render, so server and browser agree.)
  const [upscale, setUpscale] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("then") === THEN_UPSCALE);
  const [reference, setReference] = useState<SlotValue | null>(null);
  const [resolution, setResolution] = useState<string>(RESTORE.cloudResolution);
  const [run, setRun] = useState<Run | null>(null);
  const [writing, setWriting] = useState(false);
  const actions = useRestoreActions();
  const runGuard = useSubmitGuard();
  const history = useGenerations({ features: [RESTORE.feature], limit: 24 });

  // Hand-off: /video-tools/restore?video=/api/files/… (a result, a Library clip, Upscale's link).
  useEffect(() => {
    const video = new URLSearchParams(window.location.search).get("video");
    if (video?.startsWith("/api/files/")) source.adopt(video, video.split("/").pop());
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = engine === "open";
  const duration = clipDuration(clip);
  const size = clipSize(clip);
  const ready = !!clip?.url && !clip.uploading && !clip.error && !!duration;
  const body: RestoreBody | null = ready
    ? {
        engine,
        source: { url: clip.url!, name: clip.name, duration, fps: clip.info?.fps, width: size.width, height: size.height, hasAudio: clip.info?.hasAudio },
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(negative.trim() && negative.trim() !== DEFAULT_NEGATIVE ? { negative: negative.trim() } : {}),
        ...(open && refine ? { refine: true } : {}),
        ...(open && deinterlace ? { deinterlace: true } : {}),
        ...(upscale && !(open && refine) ? { upscale: true } : {}),
        ...(reference?.ref && !reference.uploading ? { reference: reference.ref } : {}),
        ...(!open ? { resolution } : {}),
      }
    : null;
  const estimate = useRestoreEstimate(body);
  const est = estimate.data && !estimate.isError ? estimate.data : undefined;

  const blocker = !clip
    ? "Add a clip"
    : clip.error
      ? clip.error
      : clip.uploading
        ? clip.progress < 1
          ? `Uploading… ${Math.round(clip.progress * 100)}%`
          : "Reading the clip…"
        : !duration
          ? "Reading the clip…"
          : reference?.uploading
            ? "Uploading the reference…"
            : estimate.isError
              ? (estimate.error as Error).message
              : null;

  const write = async () => {
    if (!clip) return;
    if (visitor) {
      // Fuobe's template, filled with the words given: edit it to fit the footage.
      const t = offlineRestorePrompt(prompt.trim() || undefined);
      setPrompt(t.prompt);
      setNegative(t.negative);
      setBy("offline");
      return;
    }
    setWriting(true);
    try {
      const frames = await grabFrames(clip.preview, duration).catch(() => []);
      const r = await actions.prompt.mutateAsync({ engine, hint: prompt.trim() || undefined, frames, seconds: duration });
      setPrompt(r.prompt);
      setNegative(r.negative);
      setBy(r.by);
      if (r.by === "offline" && r.why) toast("Written offline", { description: `Fuobe's template filled it in: ${r.why}. Add the period, the place and the light.` });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setWriting(false);
    }
  };

  const start = () => {
    if (blocker || !body) return void toast(blocker ?? "Not ready yet", { id: "restore-blocker" });
    // A visitor without its own GPU or key gets the card that sets one up.
    if (!press(item)) return;
    void runGuard(JSON.stringify(body), (requestId) => actions.run.mutateAsync({ ...body, requestId }))
      .then((r) => {
        if (!r) return;
        const ratio = size.width && size.height ? size.width / size.height : undefined;
        setRun({ final: r.final.id, ids: r.items.map((g) => g.id), before: clip!.preview, ratio, prompt: r.prompt, by: body.prompt ? (by ?? "you") : r.by });
        if (!prompt.trim()) {
          setPrompt(r.prompt);
          setBy(r.by);
        }
        toast("Restoring your clip", { description: "Follow it below — it lands in your Library too." });
      })
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <ToolShell title="Video tools" wide>
      {!clip && (
        <ToolHero
          title="Restore & colourise"
          subtitle="Old scans, tape and black-and-white film back in colour, clean and sharp, free on your own ComfyUI."
        >
          {visitor && <OwnSetupChip setup={item} short={false} className="mt-3" />}
        </ToolHero>
      )}
      <div className={cn("mx-auto", clip ? "pt-4" : "mt-8 max-w-[640px]")}>
        {!clip ? (
          <ClipDrop
            accept={RESTORE.accept}
            limits={LIMITS}
            gpuOnly
            onFile={(f) => {
              // A visitor without its own GPU or key sets one up first (its files are kept for runs there).
              if (!press(item)) return;
              const err = source.pick(f);
              if (err) toast.error(err);
            }}
            onLibrary={(url, name) => source.adopt(url, name)}
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-4">
              <Panel>
                <div className="space-y-3">
                  <ClipBar
                    clip={clip}
                    onRemove={() => {
                      source.clear();
                      setRun(null);
                    }}
                  />
                  <video
                    src={clip.preview}
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-[52vh] w-full rounded-lg bg-black object-contain"
                    onLoadedMetadata={(e) => source.setBrowserMeta?.({ duration: e.currentTarget.duration, width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
                  />
                  {est && (
                    <p className="text-[12px] text-muted-foreground tabular-nums">
                      {`${est.canvas.width}×${est.canvas.height} · restored in ${est.pieces} part${est.pieces > 1 ? "s" : ""}${open && est.refined ? `, then finished at ${est.refined.width}×${est.refined.height}` : ""}`}
                      {est.dropped > 0 ? ` · the last ${est.dropped} frame${est.dropped > 1 ? "s" : ""} left out` : ""}
                    </p>
                  )}
                </div>
              </Panel>
              {est?.loraReady === false && (
                <Panel>
                  <div className="flex gap-3">
                    <KeyRound className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />
                    <div className="min-w-0 space-y-1.5 text-[13px]">
                      <p className="font-medium">One-time setup: the Restore IC-LoRA is gated</p>
                      <p className="text-muted-foreground">
                        Accept its licence on Hugging Face with your account, then add a Hugging Face token. Fuobe
                        downloads the 1.7 GB file once{open ? " into ComfyUI's LoRA folder" : " and gives fal its own copy, never your token"}.
                      </p>
                      <div className="flex flex-wrap gap-2 pt-0.5">
                        <Button asChild size="sm" variant="outline" className="rounded-full">
                          <a href={RESTORE.loras.restore.page} target="_blank" rel="noreferrer">
                            Accept the licence <ExternalLink className="size-3" />
                          </a>
                        </Button>
                        <Button asChild size="sm" variant="outline" className="rounded-full">
                          <Link href="/settings#huggingface">Add your token</Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </Panel>
              )}
            </div>

            <Panel className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)]">
              <p className="flex gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
                <Cpu className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{open ? GPU_NOTE : CLOUD_NOTE}</span>
              </p>

              <Field label="Describe the scene" htmlFor="restore-prompt" hint={by ? BY[by] : "The period, the place, the light, what people wear. Colour comes from these words"}>
                <Textarea
                  id="restore-prompt"
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setBy(e.target.value.trim() ? "you" : null);
                  }}
                  maxLength={4000}
                  rows={4}
                  placeholder="e.g. “a steam locomotive arriving at a rural station in 1896, overcast daylight, passengers in period coats and hats, natural colour” — or a few words, then Write it from the frames"
                  className="max-h-56 resize-y"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => void write()} disabled={writing || !clip}>
                    {writing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Write it from the frames
                  </Button>
                  <span className="text-[12px] text-muted-foreground">{visitor ? "Fuobe's template" : <>{open ? "A local model that sees pictures" : "Claude"}, else Fuobe&apos;s template</>} · never starts a run</span>
                </div>
              </Field>

              <Field label="What it must not invent" htmlFor="restore-negative" hint="Modern things the period didn't have, then the damage to clean up">
                <Textarea id="restore-negative" value={negative} onChange={(e) => setNegative(e.target.value)} maxLength={4000} rows={3} className="max-h-40 resize-y text-[13px]" />
              </Field>

              <div className="space-y-3">
                <Toggle
                  id="restore-4k"
                  label="Restore to 4K"
                  hint={open ? "Adds a detail pass at twice the size (Detail Refine IC-LoRA): restore first, refine second" : "Runs on your GPU (open source): the Detail Refine LoRA isn't hosted in the cloud"}
                  checked={open && refine}
                  disabled={!open}
                  onChange={setRefine}
                />
                <Toggle
                  id="restore-upscale"
                  label="Then upscale"
                  hint={`${open ? RESTORE_UPSCALE.open.label : RESTORE_UPSCALE.cloud.label}, after the restoration, in the same run${open ? " (free)" : " (priced in)"}${open && refine ? ". Restore to 4K already doubles the size" : ""}`}
                  checked={upscale && !(open && refine)}
                  disabled={open && refine}
                  onChange={setUpscale}
                />
                <Toggle
                  id="restore-interlaced"
                  label="Interlaced source (TV, tape)"
                  hint={open ? "Keeps one field of each frame before restoring, so combing isn't read as texture" : "Runs on your GPU (open source)"}
                  checked={open && deinterlace}
                  disabled={!open}
                  onChange={setDeinterlace}
                />
              </div>

              <Field label={open ? "Reference picture (optional)" : "First frame in colour (optional)"} hint={open ? "True colours, a face or a sign: it guides every window" : "The cloud uses a picture as the clip's first frame"}>
                <MediaSlot label="Reference" kind="image" value={reference} onChange={setReference} size="lg" />
              </Field>

              {!open && (
                <Field label="Size">
                  <Segmented label="Size" value={resolution} onChange={setResolution} options={RESTORE.cloudResolutions.map((r) => ({ value: r, label: r, hint: r === "1080p" ? "the card's canvas" : undefined }))} />
                </Field>
              )}

              <div className="space-y-3 border-t pt-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1" aria-live="polite">
                    {blocker ? (
                      <p className="text-[13px] text-muted-foreground">{blocker}</p>
                    ) : (
                      <>
                        <p className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums">
                          {costText(est, engine)}
                          {estimate.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Updating the price" />}
                        </p>
                        {est && (
                          <p className="text-[12px] leading-snug text-muted-foreground">
                            Fuobe Restore · {est.seconds} s{est.resolution ? ` · ${est.resolution}` : ""}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <Button className="rounded-full" onClick={start} disabled={!!blocker || actions.run.isPending}>
                    {actions.run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Restore
                  </Button>
                </div>
                {est && est.notes.length > 0 && !blocker && (
                  <ul className="space-y-1 text-[12px] leading-snug text-muted-foreground">
                    {est.notes
                      .filter((n) => n !== GPU_NOTE && n !== CLOUD_NOTE)
                      .map((n) => (
                        <li key={n} className="flex gap-1.5">
                          <Sparkles className="mt-0.5 size-3 shrink-0 text-brand-text" />
                          <span>{n.replace(/\.$/, "")}.</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>
        )}
      </div>

      {run && <RunPanel run={run} onAgain={start} />}

      {(history.data?.length ?? 0) > 0 && (
        <section className="mt-10" aria-labelledby="restorations">
          <h3 id="restorations" className="mb-3 font-heading text-[22px]">
            Your restorations
          </h3>
          <Feed items={history.data!} />
        </section>
      )}
    </ToolShell>
  );
}

function Toggle({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-describedby={`${id}-hint`} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className={cn("text-[13px] font-medium", disabled && "text-muted-foreground")}>
          {label}
        </label>
        <p id={`${id}-hint`} className="text-[12px] leading-snug text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

/** What a run's steps are doing, then the result with a before / after wipe and the words it ran with. */
function RunPanel({ run, onAgain }: { run: Run; onAgain: () => void }) {
  const list = useGenerationList(run.ids).data;
  const byId = useMemo(() => new Map((list ?? []).map((g) => [g.id, g])), [list]);
  const final = byId.get(run.final);
  const rows: StepRow[] = run.ids.map((id) => {
    const g = byId.get(id);
    return { key: id, label: g?.request.step?.label ?? "A step", g };
  });
  const state = chainState(rows.map((r) => ({ g: r.g, label: r.label })).sort((a, b) => (a.g?.id === run.final ? 1 : b.g?.id === run.final ? -1 : 0)));
  const out = final?.status === "succeeded" ? final.outputs.find((o) => o.kind === "video") : undefined;
  return (
    <section className="mt-6" aria-labelledby="run-title">
      <Panel
        title={<span id="run-title">{final?.request.title ?? "Your restoration"}</span>}
        aside={
          out && final ? (
            <Button asChild size="sm" variant="outline" className="rounded-full">
              <a href={downloadHref(out.url, downloadName(final, out, 0))}>
                <Download className="size-3.5" /> Download
              </a>
            </Button>
          ) : state.status === "failed" ? (
            <Button size="sm" variant="outline" className="rounded-full" onClick={onAgain}>
              <RotateCcw className="size-3.5" /> Try again
            </Button>
          ) : null
        }
      >
        {out ? (
          <VideoCompare before={run.before} after={out.url} ratio={run.ratio} label="Compare the archive clip and the restored one" />
        ) : (
          <div className="space-y-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} aria-label="Progress">
              <div className={cn("h-full origin-left transition-transform duration-(--motion-slow) ease-standard", state.status === "failed" ? "bg-destructive" : "bg-primary")} style={{ transform: `scaleX(${(Math.max(4, state.progress * 100)) / 100})` }} />
            </div>
            <p className={cn("text-[13px]", state.status === "failed" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
              {state.status === "failed" ? `${state.label}: ${state.error}` : state.label}
            </p>
            {rows.length > 1 && <StepList steps={rows} />}
          </div>
        )}
        <p className="mt-3 text-[12px] leading-relaxed break-words text-muted-foreground">
          <span className="font-medium text-foreground">{BY[run.by] ?? "Words"}:</span> {run.prompt}
        </p>
      </Panel>
    </section>
  );
}
