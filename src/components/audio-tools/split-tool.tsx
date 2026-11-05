"use client";

import { AudioLines, Clapperboard, Cpu, Download, FileVideo, Headphones, Library, Loader2, Pause, Play, Save, SlidersVertical, Upload, Volume2, VolumeX, X } from "lucide-react";
import { nanoid } from "nanoid";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Feed } from "@/components/studio/feed";
import { ACCEPT, fileToSlot, kindOfFile, LibraryGrid, type SlotValue } from "@/components/studio/media-slot";
import { Segmented } from "@/components/faceless/controls";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import { useAskBeforeUpload, useEngine, useGenerations, useIsAccount } from "@/lib/api";
import {
  backgroundLowered,
  clock,
  CLOUD_ONLY_PROBLEM,
  CLOUD_SPLIT_PROBLEM,
  dbLabel,
  durationWords,
  openToolPrice,
  exportProblem,
  headroomGain,
  LEVEL_MAX,
  LEVEL_MIN,
  mixerBudget,
  mixerBytes,
  mixerProblem,
  mixName,
  mixPart,
  mixPeak,
  MIX_FEATURE,
  mixPlan,
  ORIGINAL_MIX,
  partFrames,
  presetOf,
  PRESETS,
  presetMix,
  QUALITY_LABELS,
  REMUX_FEATURE,
  setLevel,
  setMute,
  setSolo,
  SPLIT_FEATURE,
  STEMS,
  stemGains,
  type Mix,
  type SplitQuality,
  type StemId,
} from "@/lib/av/split";
import type { Engine, Generation, OutputFile } from "@/lib/catalog/types";
import { downloadHref } from "@/lib/library";
import { probeUrl } from "@/lib/media-probe";
import { cn } from "@/lib/utils";
import { responseError, toastError } from "@/lib/refusals";
import { useAudioToolPreview, useAudioToolRun, useSettled, type AudioToolBody } from "./hooks";
import { CleanDialoguePanel } from "./clean-dialogue-panel";
import { CLEAN_DIALOGUE_PRESET, mixPresetFor } from "@/lib/av/clean-dialogue";

/**
 * Audio → Split soundtrack (DBS D1). Drop a song, podcast, film clip or video; DBS splits it into Dialogue, Music,
 * Effects and Music & effects on your ComfyUI (free, CPU or GPU). The stems are Library outputs; the mixer below plays
 * them live in the browser (WebAudio: solo, mute, level, presets), exports the mix as a WAV into the Library and, for a
 * video, puts it back on the picture (stream-copied on the open engine). There's no hosted DBS, so the cloud engine
 * says so instead of running something else.
 */

type Source = SlotValue & { kind: "audio" | "video"; duration?: number; channels?: number };
type Stem = { id: StemId; url: string; name: string };

const baseName = (s: { name?: string }) => (s.name ?? "Soundtrack").replace(/\.[a-z0-9]{2,4}$/i, "");

/**
 * ?audio= / ?video= from a result's "Split soundtrack" (or "Clean up dialogue": ?preset=clean-dialogue), read once after
 * hydration.
 */
function useHandoff(take: (s: Source) => void, preset?: (id: string) => void) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = q.get("preset");
    if (p && preset) preset(p);
    for (const kind of ["video", "audio"] as const) {
      const url = q.get(kind);
      if (url?.startsWith("/api/files/")) return take({ ref: url, preview: url, kind, id: nanoid(8), name: decodeURIComponent(url.split("/").pop() ?? "") });
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The largest file the page decodes just to count its channels (an hour of film would take gigabytes of memory). */
const DECODE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The channel count the browser decodes, for a file whose header the server can't read (it reads MP4 / MOV, WebM /
 * MKV, WAV, FLAC and MP3 itself: Ogg and the rest), and only a small one: its size first, from a one-byte range.
 */
async function decodedChannels(url: string): Promise<number | undefined> {
  try {
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    const total = Number(/\/(\d+)\s*$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
    await probe.body?.cancel().catch(() => {});
    if (!(total > 0) || total > DECODE_MAX_BYTES) return undefined;
    const data = await (await fetch(url)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return (await ctx.decodeAudioData(data)).numberOfChannels;
  } catch {
    return undefined;
  }
}

/** How much decoded audio this browser is trusted with (navigator.deviceMemory where the browser says it). */
function browserBudget(): number {
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return mixerBudget({ deviceMemoryGb, coarse });
}

/** Let the page paint between slices of a long computation. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Input

/**
 * Upload a file as the soundtrack: `put` shows it at once with its local preview, then `update` gives it its address,
 * or takes it away when the upload is refused (a guest, an account without its GPU, a file of another kind) or fails,
 * so the tool never stays on "Uploading…". Its answer counts only while it's still this upload: a soundtrack removed or
 * replaced meanwhile stays as it is.
 */
export function uploadSource(f: File, kind: "audio" | "video", put: (s: Source) => void, update: (next: (cur: Source | null) => Source | null) => void): Promise<void> {
  const id = nanoid(8);
  return fileToSlot(
    f,
    (v) => {
      const s: Source | null = v && { ...v, id, kind: v.kind === "video" ? "video" : "audio", name: f.name };
      if (s?.uploading) put(s);
      else update((cur) => (cur?.id === id ? s : cur));
    },
    kind,
  );
}

/** disabled: nothing is uploaded or picked. A guest is asked to sign up first, and an account with nothing to run on to connect its GPU. */
function AddMedia({ onPick, onUpdate, disabled }: { onPick: (s: Source) => void; onUpdate: (next: (cur: Source | null) => Source | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  // A guest, or an account with neither its own GPU nor its own key, gets its card instead of the file chooser.
  const askFirst = useAskBeforeUpload();
  const take = (f: File | undefined) => {
    if (!f || disabled || askFirst()) return;
    const kind = kindOfFile(f);
    if (kind !== "audio" && kind !== "video") return void toast("Audio or video only — drop a sound file or a clip here");
    void uploadSource(f, kind, onPick, onUpdate);
  };
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border-strong bg-background px-4 py-10 text-center transition-colors sm:py-14",
        over && "border-primary bg-brand-faint",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files?.[0]);
      }}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">{over ? <Upload className="size-5" /> : <SlidersVertical className="size-5" />}</span>
      <div>
        <p className="text-[15px] font-medium">Add a soundtrack to split</p>
        <p className="mt-1 text-[13px] text-muted-foreground">A song, podcast, film clip or video, up to 200 MB</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" className="rounded-full" disabled={disabled} onClick={() => askFirst() || input.current?.click()}>
          <Upload className="size-3.5" /> Upload audio or video
        </Button>
        <Popover open={picking && !disabled} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="rounded-full" disabled={disabled}>
              <Library className="size-3.5" /> From library
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(92vw,360px)] p-2" collisionPadding={12}>
            <p className="px-1 pb-2 text-[13px] font-medium">From your library</p>
            {picking && (
              <LibraryGrid
                kinds={["audio", "video"]}
                onPick={(v) => {
                  onPick({ ...v, kind: v.kind === "video" ? "video" : "audio" });
                  setPicking(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
      <input
        ref={input}
        type="file"
        accept={`${ACCEPT.audio},${ACCEPT.video}`}
        hidden
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function SourcePanel({ source, onDuration, onRemove }: { source: Source; onDuration: (s: number) => void; onRemove: () => void }) {
  const meta = (e: React.SyntheticEvent<HTMLMediaElement>) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && onDuration(e.currentTarget.duration);
  return (
    <Panel
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {source.kind === "video" ? <FileVideo className="size-3.5 shrink-0" /> : <AudioLines className="size-3.5 shrink-0" />}
          <span className="truncate">{baseName(source)}</span>
        </span>
      }
      aside={
        <>
          {source.duration ? <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{clock(source.duration)}</span> : null}
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Remove the soundtrack" onClick={onRemove}>
            <X className="size-4" />
          </Button>
        </>
      }
    >
      {source.uploading ? (
        <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" /> Uploading…
        </p>
      ) : source.kind === "video" ? (
        <video key={source.preview} src={source.preview} controls playsInline preload="metadata" onLoadedMetadata={meta} className="max-h-[36vh] w-full rounded-xl bg-media object-contain" />
      ) : (
        <audio key={source.preview} src={source.preview} controls preload="metadata" onLoadedMetadata={meta} className="h-9 w-full min-w-0" aria-label={`Play ${baseName(source)}`} />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The live mixer (WebAudio): every stem decoded once, one gain per stem, sources restarted on play and seek.

const BARS = 96;

/** Loudest sample per bar, across channels (0…1), for the waveform. */
function peaksOf(buf: AudioBuffer, bars = BARS): number[] {
  const step = Math.max(1, Math.floor(buf.length / bars));
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return Array.from({ length: bars }, (_, b) => {
    let m = 0;
    for (const d of chans) for (let i = b * step, end = Math.min(d.length, i + step); i < end; i += 16) m = Math.max(m, Math.abs(d[i]));
    return Math.min(1, m);
  });
}

/** Stop sources without their "ended" handlers firing. */
function silence(nodes: AudioBufferSourceNode[]) {
  for (const n of nodes) {
    n.onended = null;
    try {
      n.stop();
    } catch {}
  }
}

function useStemPlayer(stems: Stem[]) {
  const ctx = useRef<AudioContext | null>(null);
  const gains = useRef<Partial<Record<StemId, GainNode>>>({});
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const started = useRef<{ at: number; offset: number } | null>(null);
  const [buffers, setBuffers] = useState<Partial<Record<StemId, AudioBuffer>>>({});
  const [failed, setFailed] = useState<string | null>(null);
  /** Why these stems aren't decoded here (too long for this device), or null. */
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [playing, setPlaying] = useState<false | "mix" | StemId>(false);
  const [position, setPosition] = useState(0);
  const key = stems.map((s) => s.url).join("|");

  // One audio context per set of stems (the mixer is keyed by its result): a gain per stem, every stem decoded once.
  // It closes with the mixer (and React's dev double-mount gets a fresh one, not a closed one). First the stems' FLAC
  // headers say how long they are: stems this device can't hold decoded aren't fetched at all (the tiles still download).
  useEffect(() => {
    let live = true;
    if (!stems.length) return;
    const ac = new AudioContext();
    ctx.current = ac;
    gains.current = {};
    for (const s of stems) {
      const g = ac.createGain();
      g.connect(ac.destination);
      gains.current[s.id] = g;
    }
    void (async () => {
      const facts = await Promise.all(stems.map((s) => probeUrl(s.url)));
      if (!live) return;
      if (facts.every((f) => f?.duration && f.channels)) {
        const problem = mixerProblem(mixerBytes(facts.map((f) => ({ seconds: f!.duration!, channels: f!.channels! })), ac.sampleRate), browserBudget());
        if (problem) return void setTooBig(problem);
      }
      for (const s of stems)
        void fetch(s.url)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          })
          .then((data) => ac.decodeAudioData(data))
          .then((buf) => live && setBuffers((b) => ({ ...b, [s.id]: buf })))
          .catch(() => live && setFailed(`Couldn't load the ${s.name.toLowerCase()} stem in the browser — download it instead`));
    })();
    return () => {
      live = false;
      silence(sources.current);
      sources.current = [];
      started.current = null;
      ctx.current = null;
      gains.current = {};
      void ac.close();
    };
    // The stems' addresses say when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const length = useMemo(() => Math.max(0, ...Object.values(buffers).map((b) => b!.duration)), [buffers]);
  const ready = stems.length > 0 && stems.every((s) => buffers[s.id]);

  const stop = useCallback((keepPosition = true) => {
    silence(sources.current);
    sources.current = [];
    if (keepPosition && started.current && ctx.current) setPosition(Math.min(length, started.current.offset + ctx.current.currentTime - started.current.at));
    started.current = null;
    setPlaying(false);
  }, [length]);

  const play = useCallback(
    (what: "mix" | StemId, from?: number) => {
      const ac = ctx.current;
      if (!ac || !ready) return;
      stop(false);
      void ac.resume();
      const offset = Math.max(0, Math.min(from ?? position, length - 0.05));
      const playingNow = what === "mix" ? stems : stems.filter((s) => s.id === what);
      sources.current = playingNow.map((s) => {
        const src = ac.createBufferSource();
        src.buffer = buffers[s.id]!;
        src.connect(gains.current[s.id]!);
        src.start(0, Math.min(offset, src.buffer.duration));
        return src;
      });
      const longest = sources.current.reduce((a, b) => ((b.buffer?.duration ?? 0) > (a?.buffer?.duration ?? 0) ? b : a), sources.current[0]);
      if (longest)
        longest.onended = () => {
          started.current = null;
          sources.current = [];
          setPlaying(false);
          setPosition(0);
        };
      started.current = { at: ac.currentTime, offset };
      setPosition(offset);
      setPlaying(what);
    },
    [buffers, length, position, ready, stems, stop],
  );

  // The playhead, about 10 times a second while playing.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (started.current && ctx.current) setPosition(Math.min(length, started.current.offset + ctx.current.currentTime - started.current.at));
    }, 100);
    return () => clearInterval(t);
  }, [playing, length]);

  /** Live gains: the mix, or one stem alone at its level while its own Play is on. */
  const apply = useCallback(
    (mix: Mix) => {
      const ac = ctx.current;
      if (!ac) return;
      const g = stemGains(mix);
      for (const s of STEMS) {
        const alone = playing && playing !== "mix" ? (playing === s.id ? 10 ** (mix[s.id].db / 20) : 0) : g[s.id];
        gains.current[s.id]?.gain.setTargetAtTime(alone, ac.currentTime, 0.015);
      }
    },
    [playing],
  );

  return { buffers, ready, failed, tooBig, playing, position, length, play, stop, seek: (t: number) => (playing ? play(playing, t) : setPosition(t)), apply };
}

function Waveform({ buffer, position, length, muted }: { buffer?: AudioBuffer; position: number; length: number; muted: boolean }) {
  const peaks = useMemo(() => (buffer ? peaksOf(buffer) : null), [buffer]);
  const at = length ? position / length : 0;
  return (
    <svg viewBox={`0 0 ${BARS} 40`} preserveAspectRatio="none" className={cn("h-10 w-full", muted ? "text-muted-foreground/40" : "text-primary")} aria-hidden>
      {peaks
        ? peaks.map((p, i) => <rect key={i} x={i + 0.15} width={0.7} y={20 - Math.max(0.6, p * 19)} height={Math.max(1.2, p * 38)} rx={0.3} fill="currentColor" opacity={i / BARS <= at ? 1 : 0.55} />)
        : Array.from({ length: BARS }, (_, i) => <rect key={i} x={i + 0.15} width={0.7} y={19} height={2} className="fill-muted" />)}
    </svg>
  );
}

function StemTile({
  stem,
  mix,
  onMix,
  player,
}: {
  stem: Stem;
  mix: Mix;
  onMix: (m: Mix) => void;
  player: ReturnType<typeof useStemPlayer>;
}) {
  const id = useId();
  const s = mix[stem.id];
  const info = STEMS.find((x) => x.id === stem.id)!;
  const audible = stemGains(mix)[stem.id] > 0;
  const alone = player.playing === stem.id;
  return (
    <li className={cn("min-w-0 rounded-2xl border bg-background p-3 shadow-soft transition-opacity", !audible && "opacity-80")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          variant={alone ? "default" : "outline"}
          size="icon-sm"
          className="shrink-0 rounded-full"
          disabled={!player.ready}
          aria-label={alone ? `Stop ${stem.name}` : `Play ${stem.name} alone`}
          onClick={() => (alone ? player.stop() : player.play(stem.id))}
        >
          {alone ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">{stem.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{info.hint}</p>
        </div>
        <Button
          variant={s.solo ? "default" : "ghost"}
          size="sm"
          className="h-7 shrink-0 rounded-full px-2.5 text-[12px]"
          aria-pressed={s.solo}
          aria-label={`Solo ${stem.name}`}
          onClick={() => onMix(setSolo(mix, stem.id, !s.solo))}
        >
          Solo
        </Button>
        <Button variant="ghost" size="icon-sm" className="shrink-0 rounded-full" aria-pressed={s.mute} aria-label={s.mute ? `Unmute ${stem.name}` : `Mute ${stem.name}`} onClick={() => onMix(setMute(mix, stem.id, !s.mute))}>
          {s.mute ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" className="shrink-0 rounded-full" asChild>
          <a href={downloadHref(stem.url, `${stem.name}.flac`)} download aria-label={`Download ${stem.name}`}>
            <Download className="size-4" />
          </a>
        </Button>
      </div>
      <div className="mt-2">
        <Waveform buffer={player.buffers[stem.id]} position={player.position} length={player.length} muted={!audible} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <label htmlFor={id} className="w-10 shrink-0 text-[12px] text-muted-foreground">
          Level
        </label>
        <Slider
          id={id}
          min={LEVEL_MIN}
          max={LEVEL_MAX}
          step={0.5}
          value={[s.db]}
          onValueChange={([v]) => onMix(setLevel(mix, stem.id, v))}
          disabled={!player.ready}
          aria-label={`${stem.name} level`}
          aria-valuetext={s.mute ? `Muted, ${dbLabel(s.db)}` : dbLabel(s.db)}
          className="min-w-0 flex-1"
        />
        <span className="w-14 shrink-0 text-right font-mono text-[12px] tabular-nums">{s.mute ? "Muted" : dbLabel(s.db)}</span>
      </div>
    </li>
  );
}

/**
 * The mix as it plays (gains, solo, mute; mono stems up-mixed as WebAudio does), kept under full scale, written as a
 * 16-bit WAV and sent to the Library in parts (/api/audio-tools/export; an account's mix is kept as one of its runs):
 * only one part is in memory beside the stems, and no upload cap applies to the whole. The peak is found first, a slice
 * at a time, so the page stays responsive.
 */
async function exportWav(stems: Stem[], buffers: Partial<Record<StemId, AudioBuffer>>, mix: Mix, name: string): Promise<{ url: string; lowered: boolean }> {
  const g = stemGains(mix);
  const decoded = stems.flatMap((s) => (buffers[s.id] ? [{ buf: buffers[s.id]!, gain: g[s.id] }] : []));
  const plan = mixPlan(
    decoded.map(({ buf, gain }) => ({ channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), gain })),
    decoded[0]?.buf.sampleRate ?? 48000,
  );
  const problem = exportProblem(plan.frames, plan.channels);
  if (problem) throw new Error(problem);
  let peak = 0;
  const slice = Math.max(1, Math.floor(2_000_000 / plan.channels));
  for (let f = 0; f < plan.frames; f += slice) {
    peak = Math.max(peak, mixPeak(plan, f, f + slice));
    await tick();
  }
  const k = headroomGain(peak);
  const per = partFrames(plan);
  let id = "";
  let offset = 0;
  for (let f = 0; ; f += per) {
    const last = f + per >= plan.frames;
    const q = new URLSearchParams({ offset: String(offset), ...(id && { id }), ...(last && { last: "1", name }) });
    const res = await fetch(`/api/audio-tools/export?${q}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([mixPart(plan, f, f + per, k) as BlobPart]) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; received?: number; url?: string; outputs?: OutputFile[]; error?: string };
    if (!res.ok) throw responseError(res, body.error ?? "The export didn't finish. Please try again.");
    if (last) {
      // The owner's mix is a Library file; an account's, the run it was kept as.
      const url = body.url ?? body.outputs?.[0]?.url;
      if (!url) throw new Error("Export failed");
      return { url, lowered: k < 1 };
    }
    id = body.id ?? "";
    offset = body.received ?? 0;
    await tick();
  }
}

function Mixer({ stems, source, engine, initial = ORIGINAL_MIX }: { stems: Stem[]; source: Source; engine: Engine; initial?: Mix }) {
  const player = useStemPlayer(stems);
  const [mix, setMixState] = useState<Mix>(initial);
  const [busy, setBusy] = useState<null | "export" | "remux">(null);
  const exported = useRef<{ key: string; url: string } | null>(null);
  const remux = useAudioToolRun();
  const router = useRouter();
  const account = useIsAccount();
  const { apply } = player;
  useEffect(() => apply(mix), [apply, mix]);
  const preset = presetOf(mix);
  const mixKey = JSON.stringify(mix);
  const name = baseName(source);
  // The price of putting a mix back (any stored audio prices it: the cloud merge bills by compute, not by the mix).
  const background = stems.find((s) => s.id === "background")?.url ?? stems[0]?.url;
  const remuxPrice = useAudioToolPreview(source.kind === "video" && background ? { tool: "remux", engine, video: source.ref, audio: background, name } : null);

  const exportMix = async (): Promise<string> => {
    if (exported.current?.key === mixKey) return exported.current.url;
    const { url, lowered } = await exportWav(stems, player.buffers, mix, `${name} · ${mixName(mix)}.wav`);
    exported.current = { key: mixKey, url };
    if (lowered) toast("The mix peaked over full scale, so it was lowered as a whole to stay clean");
    return url;
  };
  const onExport = async () => {
    setBusy("export");
    try {
      await exportMix();
      toast.success(account ? "Mix saved to your runs" : "Mix saved to your Library", { action: { label: account ? "Open your runs" : "Open Library", onClick: () => router.push("/library") } });
    } catch (e) {
      toastError(e, "Couldn't export the mix");
    } finally {
      setBusy(null);
    }
  };
  const onRemux = async () => {
    setBusy("remux");
    try {
      const audio = await exportMix();
      await remux.mutateAsync({ tool: "remux", engine, video: source.ref, audio, name });
      toast.success(engine === "open" ? "Putting the mix on your video (picture copied as it is)" : "Putting the mix on your video");
    } catch (e) {
      toastError(e, "Couldn't put the mix on the video");
    } finally {
      setBusy(null);
    }
  };
  // A loud master's background stem was lowered to fit under full scale (AudioMerge): "Original" is then a little
  // quieter in the background than the source, and the page says so.
  const bed = player.buffers.background;
  const lowered = useMemo(() => {
    if (!bed) return false;
    let peak = 0;
    for (let c = 0; c < bed.numberOfChannels; c++) {
      const d = bed.getChannelData(c);
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
    }
    return backgroundLowered(peak);
  }, [bed]);
  const remuxCost = remuxPrice.data ? (remuxPrice.data.demo ? "Placeholder · free" : engine === "open" ? "Free · your GPU" : remuxPrice.data.costUsd !== null && remuxPrice.data.costUsd < 0.01 ? "under $0.01" : `≈ $${remuxPrice.data.costUsd?.toFixed(2)}`) : null;

  return (
    <section aria-labelledby="mixer" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="mixer" className="font-heading text-[22px] leading-tight">
          Stems and mixer
        </h3>
        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[12px] font-medium text-success">Free · plays in your browser</span>
      </div>
      <p className="text-[13px] text-muted-foreground">Every stem is already in your {account ? "runs" : "Library"}. Mixing here is free: nothing runs until you export.</p>
      {player.failed && (
        <p className="text-[13px] text-destructive" role="alert">
          {player.failed}
        </p>
      )}
      {player.tooBig && (
        <p className="rounded-xl bg-muted px-3 py-2 text-[13px] text-muted-foreground" role="status">
          {player.tooBig}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button className="rounded-full" disabled={!player.ready} onClick={() => (player.playing === "mix" ? player.stop() : player.play("mix"))}>
          {player.tooBig ? <Headphones className="size-4" /> : !player.ready ? <Loader2 className="size-4 animate-spin" /> : player.playing === "mix" ? <Pause className="size-4" /> : <Headphones className="size-4" />}
          {player.tooBig ? "Play the mix" : !player.ready ? "Loading stems…" : player.playing === "mix" ? "Pause" : "Play the mix"}
        </Button>
        <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
          {clock(player.position)} / {clock(player.length)}
        </span>
        <Slider
          min={0}
          max={Math.max(0.1, player.length)}
          step={0.1}
          value={[Math.min(player.position, player.length)]}
          onValueChange={([v]) => player.seek(v)}
          disabled={!player.ready}
          aria-label="Position"
          aria-valuetext={`${clock(player.position)} of ${clock(player.length)}`}
          className="min-w-[8rem] flex-1 basis-40"
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[13px]">Presets</span>
        <Segmented label="Presets" value={preset ?? "custom"} onChange={(id) => id !== "custom" && setMixState(PRESETS.find((p) => p.id === id)!.mix)} options={[...PRESETS.map((p) => ({ value: p.id, label: p.label })), ...(preset ? [] : [{ value: "custom", label: "Custom" }])]} />
      </div>
      {lowered && (
        <p className="text-[12px] text-muted-foreground">
          This is a loud master: Music &amp; effects was lowered a little to fit under full scale, so Original plays the background slightly quieter than the source.
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Stems">
        {stems.map((s) => (
          <StemTile key={s.id} stem={s} mix={mix} onMix={setMixState} player={player} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" className="rounded-full" disabled={!player.ready || busy !== null} onClick={() => void onExport()}>
          {busy === "export" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Export mix
        </Button>
        {source.kind === "video" && (
          <Button className="rounded-full" disabled={!player.ready || busy !== null} onClick={() => void onRemux()}>
            {busy === "remux" ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />} Put back on the video{remuxCost ? ` · ${remuxCost}` : ""}
          </Button>
        )}
        <Button variant="ghost" className="rounded-full" asChild>
          <Link href={`/audio/clean?${source.kind}=${encodeURIComponent(source.ref)}&background=keep`}>
            <AudioLines className="size-4" /> Clean the dialogue
          </Link>
        </Button>
        <span className="text-[12px] text-muted-foreground">{mixName(mix)}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The tool

/** Where the time estimate is for: the host's device when it said; else a CPU's, the figures the estimate then uses. */
const onDevice = (device?: string) => (device === "cuda" ? "on your GPU" : device ? "on your CPU" : "on a CPU");

/** What each model is, shown under the choice (not only on hover). */
const MODEL_HINTS: Record<SplitQuality, string> = {
  fast: "Fast: 18.9 MB, about 3x faster on a CPU.",
  best: "Best: 4.1 MB, cleaner music and effects; the pick on an NVIDIA GPU.",
};

function stemsOf(outputs: OutputFile[]): Stem[] {
  return STEMS.flatMap((s) => {
    const o = outputs.find((x) => x.kind === "audio" && x.meta?.stem === s.id);
    return o ? [{ id: s.id, url: o.url, name: s.label }] : [];
  });
}

export function SplitSoundtrackTool() {
  const [engine, setEngine, mode] = useEngine();
  const run = useAudioToolRun();
  const [source, setSource] = useState<Source | null>(null);
  const [quality, setQuality] = useState<SplitQuality | null>(null);
  const [stereo, setStereo] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const result = useGeneration(resultId);
  const stereoId = useId();
  // Split into stems, or Clean up dialogue (D5: one run, or the mixer opened on its preset).
  const [goal, setGoal] = useState<"split" | "clean">("split");
  const [mixPreset, setMixPreset] = useState<string | null>(null);
  const take = useCallback((s: Source) => {
    setSource(s);
    setResultId(null);
  }, []);
  const arrive = useCallback((id: string) => {
    if (id !== CLEAN_DIALOGUE_PRESET) return;
    setGoal("clean");
    setMixPreset(CLEAN_DIALOGUE_PRESET);
  }, []);
  useHandoff(take, arrive);
  // The mixer opens on the Clean dialogue preset only from Clean up dialogue ("Fine-tune in the mixer", or arriving
  // on the preset); picking Split into stems yourself opens it on the original mix.
  const pickGoal = (next: "split" | "clean") => {
    setGoal(next);
    setMixPreset(mixPresetFor(next));
  };
  const ready = source && !source.uploading && source.ref ? source : null;
  const readyRef = ready?.ref;
  const body: AudioToolBody | null = useMemo(
    () =>
      ready
        ? {
            tool: "split",
            engine,
            media: ready.ref,
            kind: ready.kind,
            name: baseName(ready),
            ...(quality && { quality }),
            ...(stereo && { stereo }),
            ...(ready.channels && { channels: ready.channels }),
            ...(ready.duration && { sourceDuration: ready.duration }),
          }
        : null,
    [ready, engine, quality, stereo],
  );
  const preview = useAudioToolPreview(useSettled(engine === "open" && goal === "split" ? body : null));
  const p = preview.data;
  // A file whose header the server couldn't read (Ogg and the like): the browser counts the channels, if it's small.
  const headerKnown = p?.channels !== undefined;
  const asked = !!p;
  useEffect(() => {
    if (!readyRef || !asked || headerKnown || source?.channels) return;
    let live = true;
    void decodedChannels(readyRef).then((n) => live && n && setSource((s) => (s && s.ref === readyRef ? { ...s, channels: n } : s)));
    return () => {
      live = false;
    };
  }, [readyRef, asked, headerKnown, source?.channels]);
  const channels = p?.channels ?? source?.channels;
  const picked: SplitQuality = quality ?? p?.hostPick ?? "fast";
  const cloudProblem = mode === "cloud" ? CLOUD_ONLY_PROBLEM : CLOUD_SPLIT_PROBLEM;
  const blocker = !source ? "Add a soundtrack to split" : source.uploading ? "Uploading…" : engine === "cloud" ? cloudProblem : null;
  const error = preview.error ? (preview.error as Error).message : null;
  const go = () => {
    if (blocker) return void toast(blocker);
    if (error) return void toast.error(error);
    if (!body) return;
    run.mutate(body, {
      onSuccess: (r) => {
        setResultId(r.result.id);
        toast.success("Splitting…");
      },
      onError: (e) => toastError(e),
    });
  };
  const g = result.data;
  const stems = useMemo(() => (g?.status === "succeeded" ? stemsOf(g.outputs) : []), [g]);

  return (
    <ToolShell title="Audio">
      {!source && (
        <ToolHero
          title={goal === "clean" ? "Clean up dialogue" : "Split any soundtrack"}
          subtitle={goal === "clean" ? "Clear speech from a noisy or musical recording or video: the music and effects out from under it, or kept quietly." : "Dialogue, music and effects from a song, podcast, film clip or video, with a free live mixer."}
        />
      )}
      <div className={cn("mx-auto max-w-[860px] space-y-3", source ? "pt-4" : "mt-8")}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented
            label="What to do"
            value={goal}
            onChange={pickGoal}
            options={[
              { value: "split", label: "Split into stems", hint: "Dialogue, music and effects, with a live mixer" },
              { value: "clean", label: "Clean up dialogue", hint: "The speech made clear, in one run" },
            ]}
          />
        </div>
        {!source ? (
          <AddMedia onPick={take} onUpdate={setSource} />
        ) : (
          <SourcePanel
            source={source}
            onDuration={(duration) => setSource((s) => (s ? { ...s, duration } : s))}
            onRemove={() => {
              setSource(null);
              setResultId(null);
            }}
          />
        )}
        {goal === "clean" && (
          <CleanDialoguePanel
            source={ready ? { ref: ready.ref, kind: ready.kind, name: baseName(ready), duration: ready.duration, channels: ready.channels } : null}
            engine={engine}
            blocker={!source ? "Add a soundtrack to clean" : source.uploading ? "Uploading…" : null}
            onMixer={() => {
              setGoal("split");
              setMixPreset(mixPresetFor("split", true));
            }}
          />
        )}
        {goal === "split" && source && engine === "cloud" && (
          <Panel>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">Split soundtrack runs on your GPU.</span>{" "}
                {mode === "cloud" ? "Turn on open-source models in Settings → Engine mode to use it." : "Switch to Open source to use it."}
              </p>
              {mode === "both" ? (
                <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={() => setEngine("open")}>
                  <Cpu className="size-3.5" /> Use open source
                </Button>
              ) : null}
            </div>
          </Panel>
        )}
        {goal === "split" && source && engine === "open" && (
          <Panel title="Options">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-[13px]">Model</span>
                <Segmented
                  label="Model"
                  value={picked}
                  onChange={(v) => setQuality(v)}
                  options={(["fast", "best"] as const).map((q) => ({ value: q, label: `${QUALITY_LABELS[q]}${p?.installed && !p.installed.includes(q) ? " · not installed" : ""}`, hint: MODEL_HINTS[q] }))}
                />
                {!quality && p?.hostPick && p.device && <span className="text-[12px] text-muted-foreground">picked for your {p.device === "cuda" ? "GPU" : "CPU"}</span>}
              </div>
              <p className="text-[12px] text-muted-foreground sm:pl-[4.5rem]">{MODEL_HINTS[picked]}</p>
              {channels === 1 ? null : channels && channels > 2 ? (
                <p className="text-[13px] text-muted-foreground">This file has {channels} channels: its stems come out in mono, as ComfyUI saves mono or stereo only.</p>
              ) : (
                <div className="flex items-center gap-2">
                  <Switch id={stereoId} checked={stereo} onCheckedChange={setStereo} />
                  <label htmlFor={stereoId} className="text-[13px]">
                    Stereo stems <span className="text-muted-foreground">(takes about twice as long)</span>
                  </label>
                </div>
              )}
            </div>
          </Panel>
        )}
        {goal === "split" && source && (
          <div className="space-y-2">
            {!blocker && !error && p && (
              <div className="space-y-1 text-[13px] text-muted-foreground" aria-live="polite">
                <p>{p.summary}</p>
                {p.notes.map((n) => (
                  <p key={n} className="text-[12px]">
                    {n}
                  </p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <p className={cn("min-w-0 flex-1 text-[13px]", error && !blocker ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
                {blocker && engine !== "cloud" ? (
                  blocker
                ) : engine === "cloud" ? (
                  mode === "cloud" ? (
                    "Split soundtrack works with open-source models, which aren't available here"
                  ) : (
                    "Switch to the open engine to split"
                  )
                ) : error ? (
                  error
                ) : p ? (
                  <>
                    <span className="font-mono text-foreground">{openToolPrice(p)}</span>
                    {p.estimate && !p.demo ? ` · ${durationWords(p.estimate)} ${onDevice(p.device)}` : ""}
                  </>
                ) : (
                  "Checking…"
                )}
              </p>
              <Button size="lg" className={cn("rounded-full", (blocker || error) && "bg-muted text-subtle-foreground hover:bg-muted")} onClick={go} disabled={run.isPending || g?.status === "queued" || g?.status === "running"}>
                {run.isPending || g?.status === "queued" || g?.status === "running" ? <Loader2 className="size-4 animate-spin" /> : <SlidersVertical className="size-4" />} Split it
              </Button>
            </div>
          </div>
        )}
        {goal === "split" && g && (g.status === "queued" || g.status === "running") && (
          <Panel>
            <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" /> {g.message ?? "Splitting"}…{g.progress ? ` ${Math.round(g.progress * 100)}%` : ""}
            </p>
          </Panel>
        )}
        {goal === "split" && g?.status === "failed" && (
          <p className="text-[13px] text-destructive" role="alert">
            {g.error ?? "The split failed"}
          </p>
        )}
        {goal === "split" && source && stems.length > 0 && <Mixer key={`${g!.id}:${mixPreset ?? ""}`} stems={stems} source={source} engine={engine} initial={presetMix(mixPreset)} />}
      </div>
      <Results
        open={resultId}
        onOpen={(r) => {
          const media = r.request.inputs?.video ?? r.request.inputs?.audio;
          if (!media) return;
          setSource({ ref: media, preview: media, kind: r.request.inputs?.video ? "video" : "audio", id: r.id, name: r.request.title?.replace(/^Split · /, "") });
          setResultId(r.id);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </ToolShell>
  );
}

/** Earlier splits, and a way back into the mixer for the finished ones (their stems are kept in the Library). */
function Results({ onOpen, open }: { onOpen: (g: Generation) => void; open: string | null }) {
  const splits = useGenerations({ features: [SPLIT_FEATURE], limit: 12 });
  // Mixes put back on a video, and an account's exported mixes (kept as its runs).
  const made = useGenerations({ features: [REMUX_FEATURE, MIX_FEATURE], limit: 12 });
  const items = [...(made.data ?? []), ...(splits.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const reopen = (splits.data ?? []).filter((g) => g.status === "succeeded" && g.id !== open && stemsOf(g.outputs).length > 0).slice(0, 4);
  if (!items.length) return null;
  return (
    <section className="mx-auto mt-10 max-w-[1040px]" aria-labelledby="split-results">
      <h3 id="split-results" className="mb-3 font-heading text-[22px]">
        Your splits
      </h3>
      {reopen.length > 0 && (
        <div className="mb-4 flex min-w-0 flex-wrap gap-2">
          {reopen.map((g) => (
            <Button key={g.id} variant="outline" size="sm" className="max-w-full rounded-full" onClick={() => onOpen(g)}>
              <SlidersVertical className="size-3.5 shrink-0" /> <span className="truncate">Open {g.request.title?.replace(/^Split · /, "") ?? "split"} in the mixer</span>
            </Button>
          ))}
        </div>
      )}
      <Feed items={items} />
    </section>
  );
}
