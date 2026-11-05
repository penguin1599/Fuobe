"use client";

import { Box, Clapperboard, Layers, Loader2, Plus, RotateCcw, Trash2, Upload, Volume2, VolumeX } from "lucide-react";
import { nanoid } from "nanoid";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { uploadFile, useAssets, useElements, useStatus } from "@/lib/api";
import { BLOCKOUT, EXAMPLE_SCENE, EXAMPLE_WORDS, REF_ROLES, beatsFrom, roleFor, type BlockoutRef, type BlockoutScene, type RefRole } from "@/lib/blockout";
import { BLOCKOUT_MODELS, BLOCKOUT_SHOTS, blockoutPrompt, planCinema, type CinemaGenerateInput, type DirectorSettings } from "@/lib/catalog/cinema";
import { getModel } from "@/lib/catalog";
import type { Engine } from "@/lib/catalog/types";
import { placeholdersOn } from "@/lib/demo-mode";
import { formatCost } from "@/lib/format";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import type { BuiltBlockout } from "./blockout-builder";
import { useCinemaGenerate } from "./hooks";
import { mediaDuration } from "./media";

/**
 * Blockout to film in Cinema's take composer (package blockout-film): the blockout (an uploaded grey-box render from any
 * 3D app, the builder's render, or the 3D scene's fly path), its beats with words, the reference stills with a role each,
 * the style, sounds and "No" list, the prompt compiled from them (editable), what each engine does, the price, Render.
 */

export interface BlockoutSource {
  video: string;
  depth?: string;
  /** The depth pass is near = dark (Blender's mist pass): the graph inverts it. */
  depthInvert?: boolean;
  firstFrame?: string;
  seconds: number;
  /** The browser couldn't read the upload's length: the server reads it from the file when it films. */
  unmeasured?: boolean;
  /** A WebM render or upload (Seedance 2.5 takes MP4 or MOV). */
  webm?: boolean;
  aspect?: string;
  from: "upload" | "build" | "scene";
  name?: string;
}

export interface BlockoutBeat {
  id: string;
  start: number;
  label: string;
  words: string;
}

export interface BlockoutRefItem extends BlockoutRef {
  id: string;
  uploading?: boolean;
}

export interface BlockoutDraft {
  source: BlockoutSource | null;
  /** The builder's scene (to open it again where it was left). */
  scene: BlockoutScene | null;
  beats: BlockoutBeat[];
  refs: BlockoutRefItem[];
  style: string;
  sounds: string;
  avoid: string;
  constraints: string;
  modelId: string;
  resolution?: string;
  audio: boolean;
  /** The prompt as the user edited it (null: compiled). */
  prompt: string | null;
}

export const initialBlockout = (): BlockoutDraft => ({
  source: null,
  scene: null,
  beats: [],
  refs: [],
  style: "",
  sounds: "",
  avoid: "",
  constraints: "",
  modelId: BLOCKOUT_MODELS.cloud[0],
  audio: true,
  prompt: null,
});

/** The draft's beats after a build: one per marker, keeping the words already written for a marker that stayed. */
export function beatsForScene(scene: BlockoutScene, old: BlockoutBeat[]): BlockoutBeat[] {
  const words = Object.fromEntries(old.map((b) => [b.id, b.words]));
  const example = scene.markers.every((m) => EXAMPLE_SCENE.markers.some((x) => x.id === m.id));
  return beatsFrom(scene.markers, scene.duration, { ...(example ? EXAMPLE_WORDS : {}), ...Object.fromEntries(Object.entries(words).filter(([, w]) => w)) }).map((b) => ({ id: b.id, start: b.start, label: b.label, words: b.words }));
}

const list = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The request body the composer sends (and planCinema prices live). */
export function blockoutInput(d: BlockoutDraft, engine: Engine, settings: DirectorSettings): Omit<CinemaGenerateInput, "brief"> {
  const s = d.source;
  return {
    engine,
    mode: "video",
    action: "blockout",
    modelId: engine === "cloud" ? d.modelId : undefined,
    prompt: engine === "cloud" && d.prompt !== null ? d.prompt : "",
    settings,
    resolution: d.resolution,
    aspectRatio: s?.aspect,
    audio: d.audio,
    blockout: {
      video: s?.video ?? "",
      ...(s?.depth ? { depth: s.depth } : {}),
      ...(s?.depth && s.depthInvert ? { depthInvert: true } : {}),
      ...(s?.firstFrame ? { firstFrame: s.firstFrame } : {}),
      seconds: s?.seconds ?? 0,
      ...(s?.webm ? { webm: true } : {}),
      beats: d.beats.map((b) => ({ id: b.id, start: b.start, label: b.label.trim() || "Beat", words: b.words })),
      refs: d.refs.filter((r) => r.url && !r.uploading).map((r) => ({ url: r.url, role: r.role, ...(r.name?.trim() ? { name: r.name.trim() } : {}) })),
      ...(d.style.trim() ? { style: d.style.trim() } : {}),
      ...(d.constraints.trim() ? { constraints: d.constraints.trim() } : {}),
      ...(list(d.sounds).length ? { sounds: list(d.sounds) } : {}),
      ...(list(d.avoid).length ? { avoid: list(d.avoid) } : {}),
    },
  };
}

const MODEL_LINES: Record<string, string> = {
  "seedance-2-5": "Follows the blockout as its reference video, with sound · up to 30 s a shot",
  "minimax-h3-max-3d": "MiniMax's own blockout model: up to 8 stills, no sound · up to 15 s a shot",
};

const fmt = (n: number) => `${Math.round(n * 10) / 10} s`;

/** The longest prompt the box takes for a model with no limit of its own. */
const PROMPT_MAX = 60_000;

/** The frame shapes a blockout is filmed in: an upload takes the nearest to its own. */
const SHAPES = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/** An uploaded clip's shape, read from its header in the browser (undefined when it can't be read). */
function clipShape(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (shape?: string) => {
      v.removeAttribute("src");
      resolve(shape);
    };
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      const r = v.videoWidth / v.videoHeight;
      if (!(r > 0)) return done();
      const ratio = (a: string) => Number(a.split(":")[0]) / Number(a.split(":")[1]);
      done(SHAPES.reduce((best, a) => (Math.abs(Math.log(ratio(a) / r)) < Math.abs(Math.log(ratio(best) / r)) ? a : best)));
    };
    v.onerror = () => done();
    setTimeout(() => done(), 8000);
    v.src = url;
  });
}
const section = "space-y-2.5 border-t pt-4 first:border-t-0 first:pt-0";
const h3 = "text-[12px] font-medium tracking-wide text-muted-foreground uppercase";

export interface BlockoutPanelProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  folderId: string | null;
  engine: Engine;
  settings: DirectorSettings;
  brief: string;
  context: { cloudAllowed: boolean; civitai?: boolean; worldcast?: boolean };
  draft: BlockoutDraft;
  setDraft: (fn: (d: BlockoutDraft) => BlockoutDraft) => void;
  /** Open the builder (with the draft's scene, or the example). */
  onBuild: (scene: BlockoutScene) => void;
}

export function BlockoutPanel(props: BlockoutPanelProps) {
  const { open, onOpenChange, projectId, folderId, engine, settings, brief, context, draft, setDraft, onBuild } = props;
  const generate = useCinemaGenerate(projectId);
  const status = useStatus().data;
  const demo = placeholdersOn(status?.demoMode);
  const [uploading, setUploading] = useState<"video" | "depth" | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const depthInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const [refsOpen, setRefsOpen] = useState(false);
  const elements = useElements();
  const images = useAssets(undefined, "image");

  const input = useMemo(() => blockoutInput(draft, engine, settings), [draft, engine, settings]);
  const plan = useMemo(() => planCinema({ ...input, brief }, context), [input, brief, context]);
  const compiled = useMemo(() => blockoutPrompt(input), [input]);
  const s = draft.source;
  const built = s?.from === "build";
  const seconds = s?.seconds ?? 0;
  const set = (patch: Partial<BlockoutDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const cost = plan.costUsd;
  const price = demo ? "Placeholder · free" : cost === 0 ? (engine === "open" ? "Free · your GPU" : "Free") : cost != null ? `≈ ${formatCost(cost)}` : "Price unknown";
  const model = getModel(engine === "cloud" ? draft.modelId : BLOCKOUT_MODELS.open);
  const resolutions = engine === "cloud" ? (getModel(draft.modelId)?.options.resolutions ?? []) : ["480p", "720p"];
  const resolution = draft.resolution && resolutions.some((r) => r.toLowerCase() === draft.resolution!.toLowerCase()) ? draft.resolution : (engine === "cloud" ? getModel(draft.modelId)?.defaults?.resolution : "480p");
  const seedance = engine === "cloud" && BLOCKOUT_SHOTS[draft.modelId]?.tag === "seedance";
  // H3 Max 3D to video takes a prompt of up to 2000 characters: the box stops there.
  const promptMax = engine === "cloud" ? (BLOCKOUT_SHOTS[draft.modelId]?.prompt ?? PROMPT_MAX) : PROMPT_MAX;
  const shownPrompt = engine === "cloud" ? (draft.prompt ?? compiled) : compiled;

  const uploadVideo = async (f: File, kind: "video" | "depth") => {
    if (f.size > 200 * 1024 * 1024) return toast.error("That file's over 200 MB. Try a smaller one.");
    setUploading(kind);
    try {
      const preview = URL.createObjectURL(f);
      const [asset, length, aspect] = await Promise.all([uploadFile(f), mediaDuration(preview, "video").catch(() => NaN), clipShape(preview)]);
      URL.revokeObjectURL(preview);
      if (kind === "depth") return set({ source: draft.source ? { ...draft.source, depth: asset.url } : null });
      const measured = Number.isFinite(length) && length > 0;
      // Not readable here (a MOV this browser can't play): a stand-in until filming, when the file's own length is used.
      const secs = measured ? Math.round(length * 100) / 100 : 8;
      if (secs > BLOCKOUT.maxSeconds) toast(`Blockouts run up to ${BLOCKOUT.maxSeconds} s: this one is ${fmt(secs)}, so its first ${BLOCKOUT.maxSeconds} s are used`);
      const webm = f.type === "video/webm" || /\.webm$/i.test(f.name);
      if (webm && engine === "cloud") toast("This is a WebM file: Seedance 2.5 takes MP4 or MOV. Export an MP4 from your 3D app, or film it on your GPU.");
      setDraft((d) => ({
        ...d,
        source: { video: asset.url, seconds: Math.min(BLOCKOUT.maxSeconds, secs), from: "upload", name: f.name, ...(aspect && { aspect }), ...(!measured && { unmeasured: true }), ...(webm && { webm: true }) },
        beats: d.beats.length ? d.beats.filter((b) => b.start < secs) : [{ id: nanoid(6), start: 0, label: "Opening", words: "" }],
        prompt: null,
      }));
    } catch (e) {
      toastError(e, "Upload failed. Please try again.");
    } finally {
      setUploading(null);
    }
  };

  const addRef = (r: Omit<BlockoutRefItem, "id">) => {
    if (draft.refs.length >= BLOCKOUT.maxRefs) return toast.error(`Up to ${BLOCKOUT.maxRefs} references`);
    setDraft((d) => ({ ...d, refs: [...d.refs, { ...r, id: nanoid(6) }], prompt: null }));
    setRefsOpen(false);
  };
  const uploadRef = (f: File) => {
    const id = nanoid(6);
    setDraft((d) => ({ ...d, refs: [...d.refs, { id, url: "", role: d.refs.some((r) => r.role === "character") ? "location" : "character", uploading: true }] }));
    setRefsOpen(false);
    uploadFile(f)
      .then((a) => setDraft((d) => ({ ...d, refs: d.refs.map((r) => (r.id === id ? { ...r, url: a.url, uploading: false } : r)) })))
      .catch((e) => {
        setDraft((d) => ({ ...d, refs: d.refs.filter((r) => r.id !== id) }));
        toastError(e, "Upload failed. Please try again.");
      });
  };

  const run = async () => {
    if (plan.blocker) return toast.error(plan.blocker);
    try {
      await generate.mutateAsync({ input: input as CinemaGenerateInput, folderId });
      onOpenChange(false);
      const silent = engine === "open" || !seedance || !draft.audio;
      toast.success(engine === "open" ? "Filming the blockout on your GPU — it lands in this scene as a new take" : "Filming the blockout — it lands in this scene as a new take", {
        duration: 8000,
        ...(silent ? { description: "It comes without sound: add it afterwards with Sound for video.", action: { label: "Sound for video", onClick: () => window.open("/audio/video", "_self") } } : {}),
      });
    } catch (e) {
      toastError(e, "Couldn't film the blockout");
    }
  };

  const span = (i: number) => {
    const end = i + 1 < draft.beats.length ? draft.beats[i + 1].start : seconds;
    return `${fmt(draft.beats[i].start)}–${fmt(Math.max(draft.beats[i].start, end))}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[100svh] w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[92svh] sm:max-w-2xl">
        <DialogHeader className="border-b px-4 pt-4 pb-3 text-left sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Box className="size-4" /> Blockout to film
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">A grey-box blockout sets the camera, blocking and timing. Your stills and beats say what it becomes.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <section className={section} aria-label="Blockout">
            <h3 className={h3}>Blockout</h3>
            {!s ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => onBuild(draft.scene ?? structuredClone(EXAMPLE_SCENE))} className="flex items-start gap-3 rounded-xl border p-3 text-left hover:border-primary hover:bg-brand-faint">
                  <Layers className="mt-0.5 size-5 shrink-0 text-brand-text" />
                  <span>
                    <span className="block text-[14px] font-medium">Build it here</span>
                    <span className="block text-[12.5px] text-muted-foreground">Boxes, a mannequin and a camera in your browser. Starts from a corridor-and-door example.</span>
                  </span>
                </button>
                <button type="button" onClick={() => videoInput.current?.click()} disabled={!!uploading} className="flex items-start gap-3 rounded-xl border p-3 text-left hover:border-primary hover:bg-brand-faint">
                  {uploading === "video" ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" /> : <Upload className="mt-0.5 size-5 shrink-0 text-brand-text" />}
                  <span>
                    <span className="block text-[14px] font-medium">Upload a render</span>
                    <span className="block text-[12.5px] text-muted-foreground">A grey-box video from Blender, Unreal, Cinema 4D… MP4 or MOV, up to {BLOCKOUT.maxSeconds} s.</span>
                  </span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row">
                <video src={s.video} controls muted playsInline className="aspect-video w-full rounded-lg bg-black sm:w-56" aria-label="The blockout" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-[14px] font-medium">
                    {built ? "Built in your browser" : s.from === "scene" ? "From the 3D scene's fly path" : (s.name ?? "Uploaded render")}
                  </p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {s.unmeasured ? "Length read from the file when you film" : fmt(seconds)}
                    {s.aspect ? ` · ${s.aspect}` : ""}
                    {s.webm ? " · WebM" : ""}
                    {s.depth ? " · with its depth" : engine === "open" ? " · no depth pass: Depth Anything 3 reads it on your GPU" : ""}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {built && (
                      <Button size="sm" variant="secondary" onClick={() => onBuild(draft.scene ?? structuredClone(EXAMPLE_SCENE))}>
                        <Layers className="size-3.5" /> Edit the blockout
                      </Button>
                    )}
                    {!built && (
                      <Button size="sm" variant="secondary" onClick={() => depthInput.current?.click()} disabled={!!uploading}>
                        {uploading === "depth" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} {s.depth ? "Replace depth pass" : "Add a depth pass"}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => set({ source: null, prompt: null })}>
                      <RotateCcw className="size-3.5" /> Start over
                    </Button>
                  </div>
                  {!built && (
                    <div className="space-y-1 text-[12px] text-muted-foreground">
                      <p>A depth pass guides your GPU: near is bright, far is dark, as wide as the render and just as long.</p>
                      {s.depth && (
                        <label className="flex items-center gap-1.5 text-foreground">
                          <input type="checkbox" checked={!!s.depthInvert} onChange={(e) => set({ source: { ...s, depthInvert: e.target.checked } })} className="size-3.5 accent-primary" />
                          Near is dark (Blender’s mist pass): invert it
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => (e.target.files?.[0] && void uploadVideo(e.target.files[0], "video"), (e.target.value = ""))} />
            <input ref={depthInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => (e.target.files?.[0] && void uploadVideo(e.target.files[0], "depth"), (e.target.value = ""))} />
          </section>

          <section className={section} aria-label="Beats">
            <div className="flex items-center justify-between gap-2">
              <h3 className={h3}>Beats</h3>
              {!built && s && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={draft.beats.length >= BLOCKOUT.maxMarkers}
                  onClick={() => setDraft((d) => ({ ...d, beats: [...d.beats, { id: nanoid(6), start: Math.min(seconds - 0.5, (d.beats.at(-1)?.start ?? 0) + 2), label: `Beat ${d.beats.length + 1}`, words: "" }], prompt: null }))}
                >
                  <Plus className="size-3.5" /> Beat
                </Button>
              )}
            </div>
            {seconds > 0 && draft.beats.length > 0 && (
              <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                {draft.beats.map((b, i) => {
                  const end = i + 1 < draft.beats.length ? draft.beats[i + 1].start : seconds;
                  return <span key={b.id} className={cn("h-full border-r-2 border-background", i % 2 ? "bg-primary/45" : "bg-primary/75")} style={{ width: `${(Math.max(0, end - b.start) / seconds) * 100}%` }} />;
                })}
              </div>
            )}
            {!draft.beats.length && <p className="text-[12.5px] text-muted-foreground">{s ? "Add a beat for each thing that happens." : "Markers in the builder become beats; for an upload you add them here."}</p>}
            <ol className="space-y-2">
              {draft.beats.map((b, i) => (
                <li key={b.id} className="grid gap-1.5 rounded-lg border p-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {built ? (
                      <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{span(i)}</span>
                    ) : (
                      <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
                        from
                        <Input
                          type="number"
                          step={0.1}
                          min={0}
                          max={seconds}
                          value={b.start}
                          disabled={i === 0}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n)) setDraft((d) => ({ ...d, beats: d.beats.map((x) => (x.id === b.id ? { ...x, start: Math.max(0, Math.min(seconds, n)) } : x)).sort((a, c) => a.start - c.start), prompt: null }));
                          }}
                          className="h-7 w-16 px-1.5 text-[12.5px] tabular-nums"
                          aria-label={`Beat ${i + 1} starts at (s)`}
                        />
                        s
                      </label>
                    )}
                    <Input value={b.label} onChange={(e) => setDraft((d) => ({ ...d, beats: d.beats.map((x) => (x.id === b.id ? { ...x, label: e.target.value.slice(0, 80) } : x)), prompt: null }))} className="h-7 min-w-0 flex-1 text-[13px] font-medium" aria-label={`Beat ${i + 1} name`} />
                    {!built && i > 0 && (
                      <button type="button" onClick={() => setDraft((d) => ({ ...d, beats: d.beats.filter((x) => x.id !== b.id), prompt: null }))} className="grid size-7 place-items-center rounded-md hover:bg-accent" aria-label={`Remove beat ${i + 1}`}>
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <Textarea
                    value={b.words}
                    onChange={(e) => setDraft((d) => ({ ...d, beats: d.beats.map((x) => (x.id === b.id ? { ...x, words: e.target.value.slice(0, BLOCKOUT.maxBeatWords) } : x)), prompt: null }))}
                    placeholder="What happens: who does what, what we hear"
                    rows={2}
                    className="min-h-0 resize-none text-[13px]"
                    aria-label={`What happens in beat ${i + 1}`}
                  />
                </li>
              ))}
            </ol>
          </section>

          <section className={section} aria-label="References">
            <h3 className={h3}>References</h3>
            <div className="flex flex-wrap gap-2">
              {draft.refs.map((r, i) => (
                <div key={r.id} className="w-[132px] space-y-1">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
                    {r.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.url} alt="" className="size-full object-cover" />
                    ) : (
                      <Loader2 className="absolute inset-0 m-auto size-4 animate-spin text-muted-foreground" />
                    )}
                    <span className="absolute top-1 left-1 rounded bg-black/60 px-1 font-mono text-[10.5px] text-white">{engine === "cloud" && seedance ? `@Image${i + 1}` : `#${i + 1}`}</span>
                    <button type="button" onClick={() => setDraft((d) => ({ ...d, refs: d.refs.filter((x) => x.id !== r.id), prompt: null }))} className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-black/60 text-white" aria-label={`Remove reference ${i + 1}`}>
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                  <select
                    value={r.role}
                    onChange={(e) => setDraft((d) => ({ ...d, refs: d.refs.map((x) => (x.id === r.id ? { ...x, role: e.target.value as RefRole } : x)), prompt: null }))}
                    className="h-7 w-full rounded-md border bg-background px-1.5 text-[12.5px]"
                    aria-label={`Reference ${i + 1} is the`}
                    title={REF_ROLES.find((x) => x.id === r.role)?.hint}
                  >
                    {REF_ROLES.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <Input value={r.name ?? ""} placeholder="Name (optional)" onChange={(e) => setDraft((d) => ({ ...d, refs: d.refs.map((x) => (x.id === r.id ? { ...x, name: e.target.value.slice(0, 60) } : x)), prompt: null }))} className="h-7 px-1.5 text-[12.5px]" aria-label={`Reference ${i + 1} name`} />
                </div>
              ))}
              <Popover open={refsOpen} onOpenChange={setRefsOpen}>
                <PopoverTrigger asChild>
                  <button type="button" disabled={draft.refs.length >= BLOCKOUT.maxRefs} className="flex aspect-[4/3] w-[132px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-[12px] text-muted-foreground hover:border-primary hover:bg-brand-faint hover:text-brand-text disabled:opacity-50">
                    <Plus className="size-4" /> Add a still
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(92vw,360px)] p-2" align="start" collisionPadding={12}>
                  <button type="button" onClick={() => refInput.current?.click()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] font-medium hover:bg-accent">
                    <Upload className="size-4" /> Upload a picture
                  </button>
                  {!!elements.data?.some((e) => e.references.length && e.kind !== "voice") && <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Elements · Soul Cast · Soul Location</p>}
                  <div className="max-h-40 space-y-0.5 overflow-y-auto">
                    {(elements.data ?? [])
                      .filter((e) => e.references.length && e.kind !== "voice")
                      .slice(0, 30)
                      .map((e) => (
                        <button key={e.id} type="button" onClick={() => addRef({ url: e.references[0], role: roleFor({ category: e.kind }), name: e.name })} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={e.references[0]} alt="" className="size-7 rounded object-cover" />
                          <span className="min-w-0 flex-1 truncate">{e.name}</span>
                          <span className="text-[11.5px] text-muted-foreground capitalize">{e.kind}</span>
                        </button>
                      ))}
                  </div>
                  <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">From your library</p>
                  <div className="grid max-h-44 grid-cols-4 gap-1 overflow-y-auto">
                    {(images.data ?? []).slice(0, 40).map((a) => (
                      <button key={a.id} type="button" onClick={() => addRef({ url: a.url, role: "location", name: undefined })} className="aspect-square overflow-hidden rounded-md bg-muted" aria-label={`Use ${a.name ?? "this picture"}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
                      </button>
                    ))}
                    {!images.isLoading && !images.data?.length && <p className="col-span-4 px-2 py-2 text-[12px] text-muted-foreground">Nothing in your library yet.</p>}
                  </div>
                </PopoverContent>
              </Popover>
              <input ref={refInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (e.target.files?.[0] && uploadRef(e.target.files[0]), (e.target.value = ""))} />
            </div>
            <p className="text-[12px] text-muted-foreground">Each still’s role is written into the prompt for you: the interior, who the mannequin becomes, the exterior, a prop.</p>
          </section>

          <section className={section} aria-label="Look and sound">
            <h3 className={h3}>Look and sound</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[12.5px] font-medium">
                Style
                <Input value={draft.style} onChange={(e) => set({ style: e.target.value.slice(0, BLOCKOUT.maxBeatWords), prompt: null })} placeholder="Low-key horror, cold torchlight, 35 mm grain" className="h-8 text-[13px]" />
              </label>
              <label className="grid gap-1 text-[12.5px] font-medium">
                Sounds
                <Input value={draft.sounds} onChange={(e) => set({ sounds: e.target.value.slice(0, 600), prompt: null })} placeholder="Footsteps on concrete, a long door creak" className="h-8 text-[13px]" />
              </label>
              <label className="grid gap-1 text-[12.5px] font-medium">
                No…
                <Input value={draft.avoid} onChange={(e) => set({ avoid: e.target.value.slice(0, 600), prompt: null })} placeholder="jump cuts, text on screen, extra people" className="h-8 text-[13px]" />
              </label>
              <label className="grid gap-1 text-[12.5px] font-medium">
                Rules
                <Input value={draft.constraints} onChange={(e) => set({ constraints: e.target.value.slice(0, BLOCKOUT.maxBeatWords), prompt: null })} placeholder="She never looks at the camera" className="h-8 text-[13px]" />
              </label>
            </div>
          </section>

          <section className={section} aria-label="Render">
            <h3 className={h3}>Render</h3>
            {engine === "cloud" ? (
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Cloud model">
                {BLOCKOUT_MODELS.cloud.map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={draft.modelId === id} onClick={() => set({ modelId: id, resolution: undefined, prompt: null })} className={cn("rounded-xl border p-3 text-left", draft.modelId === id ? "border-primary bg-brand-faint" : "hover:bg-accent")}>
                    <span className="block text-[13.5px] font-medium">{getModel(id)?.name ?? id}</span>
                    <span className="block text-[12px] text-muted-foreground">{MODEL_LINES[id]}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-xl bg-muted/60 p-3 text-[12.5px]">
                <span className="font-medium">Your GPU (open source) · Free.</span> The blockout’s depth drives Wan 2.2 Fun VACE from a first frame drawn from your stills. It follows the depth and timing, not the dialogue or sound: add sound afterwards with{" "}
                <Link href="/audio/video" className="underline underline-offset-2">
                  Sound for video
                </Link>
                .
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12.5px]">
                Quality
                <select value={resolution ?? ""} onChange={(e) => set({ resolution: e.target.value })} className="h-8 rounded-md border bg-background px-2 text-[13px]">
                  {resolutions.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              {seedance && (
                <button type="button" onClick={() => set({ audio: !draft.audio, prompt: null })} aria-pressed={draft.audio} className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium", draft.audio ? "bg-brand-faint text-brand-text" : "bg-secondary")}>
                  {draft.audio ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />} Sound {draft.audio ? "on" : "off"}
                </button>
              )}
            </div>
          </section>

          <section className={section} aria-label="Prompt">
            <div className="flex items-center justify-between gap-2">
              <h3 className={h3}>{engine === "cloud" ? "Prompt" : "Prompt (first window)"}</h3>
              {draft.prompt !== null && engine === "cloud" && (
                <Button size="sm" variant="ghost" onClick={() => set({ prompt: null })}>
                  <RotateCcw className="size-3.5" /> Back to compiled
                </Button>
              )}
            </div>
            <Textarea
              value={shownPrompt}
              readOnly={engine !== "cloud"}
              onChange={(e) => set({ prompt: e.target.value.slice(0, promptMax) })}
              maxLength={promptMax}
              rows={9}
              className="font-mono text-[12px] leading-relaxed"
              aria-label="Compiled prompt"
              aria-describedby={promptMax < PROMPT_MAX ? "blockout-prompt-count" : undefined}
            />
            {promptMax < PROMPT_MAX && (
              <p id="blockout-prompt-count" className={cn("text-right text-[11.5px] tabular-nums", shownPrompt.length > promptMax ? "text-destructive" : "text-muted-foreground")}>
                {shownPrompt.length} / {promptMax} characters
              </p>
            )}
            <p className="text-[12px] text-muted-foreground">
              {engine === "cloud" ? "Compiled from the beats, references and words above. Edit it freely: a film longer than one shot gets each shot's own beats instead." : "Each window gets the beats inside it, briefly: Wan follows the depth for everything else."}
            </p>
          </section>
        </div>
        <div className="border-t px-4 py-3 sm:px-5">
          {!!plan.notes.length && (
            <ul className="mb-2 space-y-0.5 text-[12px] text-muted-foreground">
              {plan.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[12.5px]">
              <span className="font-medium">{price}</span>
              <span className="text-muted-foreground"> · {model?.name ?? (engine === "cloud" ? "Cloud" : "Your GPU")}</span>
              {plan.blocker && <span className="block truncate text-[12px] text-muted-foreground">{plan.blocker}</span>}
            </p>
            <Button onClick={run} disabled={!!plan.blocker || generate.isPending || draft.refs.some((r) => r.uploading)}>
              {generate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />} Film it
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The draft after the builder hands back a render: the source, the scene, its beats (words kept). */
export function withBuilt(d: BlockoutDraft, b: BuiltBlockout, scene: BlockoutScene): BlockoutDraft {
  return { ...d, source: { video: b.video, depth: b.depth, firstFrame: b.firstFrame, seconds: b.seconds, aspect: b.aspect, from: "build", ...(!b.type.includes("mp4") && { webm: true }) }, scene, beats: beatsForScene(scene, d.beats), prompt: null };
}

