"use client";

import { Captions, Download, FileUp, Flame, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Feed } from "@/components/studio/feed";
import type { SlotValue } from "@/components/studio/media-slot";
import { CueEditor, useCueEditor } from "@/components/av/cue-editor";
import { realDuration } from "@/components/av/frame-sampler";
import { SourceLanguageSelect } from "@/components/av/language-picker";
import { MediaDrop } from "@/components/av/media-drop";
import { StepList } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGeneration } from "@/components/av/use-generation";
import { useCreateGeneration, useEngine, useGenerations } from "@/lib/api";
import { useVoiceFirstLive, useVoiceFirstShown, VoiceFirstSwitch } from "@/components/audio-tools/voice-first-switch";
import { voiceFirstDefault } from "@/lib/av/voice-first";
import { cueProblems } from "@/lib/av/cue-edit";
import {
  BURN_CAPS,
  burnNote,
  burnPricePerMinute,
  burnRequest,
  burnRouteFor,
  CAPTION_STYLES,
  lookFor,
  OPEN_FONT_SIZE,
  previewText,
  styleById,
  transcribeRequest,
  usesCues,
  type BurnRoute,
  type CaptionLook,
  type CaptionPosition,
  type CaptionSize,
} from "@/lib/av/captions";
import { parseCues, toSrt, toVtt, type Cue } from "@/lib/cues";
import { speechEditLink } from "@/lib/speech-edit-handoff";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";

const STORE = "fuobe.captions";

interface Saved {
  video: SlotValue;
  cues: Cue[];
  look: CaptionLook;
  transcriptId?: string;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

const DEFAULT_LOOK: CaptionLook = { style: "clean", size: "M", position: "bottom" };

/**
 * A hand-off: /video-tools/captions?video=<file>&transcript=<generation id> opens the editor on that
 * video and fills the lines from the transcript when it's done (Assist and MCP link the captions they
 * burn). Lines already edited in this browser for the same video and transcript are kept.
 */
function handoff(): Saved | null {
  const p = new URLSearchParams(window.location.search);
  const video = p.get("video");
  if (!video?.startsWith("/api/files/")) return null;
  const transcriptId = p.get("transcript") || undefined;
  const local = load();
  if (local?.video.ref === video && (!transcriptId || local.transcriptId === transcriptId)) return local;
  return { video: { ref: video, preview: video, kind: "video", name: video.split("/").pop() }, cues: [], look: DEFAULT_LOOK, ...(transcriptId && { transcriptId }) };
}

/** Leaving the handed-off video: a reload then shows this browser's own project. */
function dropHandoff() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("video") && !url.searchParams.has("transcript")) return;
  url.searchParams.delete("video");
  url.searchParams.delete("transcript");
  window.history.replaceState(null, "", url);
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Captions (Video tools → Captions): transcribe, fix every line, style, burn in — or export .srt / .vtt. */
export function CaptionsStudio() {
  // The last project comes back after a reload (this browser only); a hand-off link wins. Both are read
  // once mounted: on a link from Assist the address only changes as the new page commits, so reading
  // it while rendering would still see /assist.
  const [saved, setSaved] = useState<Saved | null | undefined>(undefined);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the address and this browser's project once mounted
    setSaved(handoff() ?? load());
  }, []);
  const [picked, setVideo] = useState<SlotValue | null | undefined>(undefined);
  const video = picked === undefined ? (saved?.video ?? null) : picked;
  const results = useGenerations({ features: ["captions"], kinds: ["video"], limit: 24 });
  return (
    <ToolShell title="Video tools">
      {saved === undefined ? null : video && !video.uploading ? (
        <Editor
          key={video.ref}
          video={video}
          restored={saved?.video.ref === video.ref ? saved : null}
          onReplace={(v) => {
            setVideo(v);
            dropHandoff();
            try {
              localStorage.removeItem(STORE);
            } catch {}
          }}
        />
      ) : (
        <div className="pb-6">
          <ToolHero title="Captions that say exactly what was said" subtitle="Transcribe the speech, fix any line and its timing, pick a style, then burn it in — or export .srt / .vtt." />
          <div className="mx-auto mt-8 max-w-[760px]">
            <MediaDrop kind="video" value={video} onChange={setVideo} title="Add a video to caption" hint="MP4, MOV or WebM up to 200 MB" />
          </div>
        </div>
      )}
      {(results.data?.length ?? 0) > 0 && (
        <section className="mt-10" aria-labelledby="captioned">
          <h3 id="captioned" className="mb-3 font-heading text-[22px]">
            Captioned videos
          </h3>
          <Feed items={results.data!} />
        </section>
      )}
    </ToolShell>
  );
}

function Editor({ video, restored, onReplace }: { video: SlotValue; restored: Saved | null; onReplace: (v: SlotValue | null) => void }) {
  const [engine, , mode] = useEngine();
  const router = useRouter();
  const create = useCreateGeneration();
  const editor = useCueEditor(restored?.cues ?? []);
  const [look, setLook] = useState<CaptionLook>(restored?.look ?? DEFAULT_LOOK);
  const [transcriptId, setTranscriptId] = useState<string | undefined>(restored?.transcriptId);
  const [source, setSource] = useState("auto");
  const [quick, setQuick] = useState(false);
  // "Clean the voice first": on for a video's speech on your GPU, off in the cloud (it adds a paid step there).
  const voiceFirstShown = useVoiceFirstShown();
  const voiceFirstLive = useVoiceFirstLive();
  const [voiceFirst, setVoiceFirst] = useState<boolean | null>(null);
  const cleanFirst = voiceFirstShown && (voiceFirst ?? (engine === "open" && voiceFirstDefault("video", voiceFirstLive)));
  const transcript = useGeneration(transcriptId);
  const player = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState<number | undefined>(undefined);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const route = burnRouteFor(engine, quick);
  const { cues, dispatch } = editor;
  const loaded = useRef<string | null>(restored?.cues.length ? (restored.transcriptId ?? "restored") : null);

  // The finished transcript fills the editor once (later edits are yours).
  const t = transcript.data;
  useEffect(() => {
    if (!t || t.status !== "succeeded" || loaded.current === t.id) return;
    const out = t.outputs.find((o) => o.kind === "text");
    const list = Array.isArray(out?.meta?.cues) ? (out!.meta!.cues as Cue[]) : out?.text ? parseCues(out.text) : null;
    loaded.current = t.id;
    if (list?.length) {
      dispatch({ type: "reset", cues: list });
      toast.success(`${list.length} lines transcribed`);
    } else toast("No speech found in this clip");
  }, [t, dispatch]);

  // Keep the project in this browser.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify({ video, cues, look, transcriptId } satisfies Saved));
      } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [video, cues, look, transcriptId]);

  const transcribe = () =>
    create.mutate(transcribeRequest({ engine, video: video.ref, sourceLanguage: source, cleanVoiceFirst: cleanFirst, seconds: duration }), {
      onSuccess: (items) => {
        loaded.current = null;
        setTranscriptId(items[0].id);
      },
      onError: (e) => toastError(e),
    });

  const importFile = useRef<HTMLInputElement>(null);
  const problems = cueProblems(cues, duration);
  const burn = () => {
    if (usesCues(route) && problems.length) return void toast(problems[0], { id: "captions-blocker" });
    let req;
    try {
      req = burnRequest({ route, video: video.ref, cues, look: lookFor(route, look), sourceLanguage: source });
    } catch (e) {
      return void toast((e as Error).message);
    }
    create.mutate(req, {
      onSuccess: () => toast.success("Burning captions — it'll show under Captioned videos"),
      onError: (e) => toastError(e),
    });
  };
  const transcribing = t && (t.status === "queued" || t.status === "running");
  const name = (video.name ?? "captions").replace(/\.[a-z0-9]+$/i, "");

  return (
    <div className="grid gap-4 pt-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <div className="min-w-0 space-y-3 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)] lg:self-start">
        <Preview video={video} cues={cues} look={lookFor(route, look)} route={route} player={player} onTime={setTime} onDuration={setDuration} />
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{video.name}</p>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => onReplace(null)}>
            Another video
          </Button>
        </div>
        <StylePanel look={look} route={route} onChange={setLook} />
      </div>

      <div className="min-w-0 space-y-3">
        <Panel
          title="Lines"
          aside={
            <>
              <input
                ref={importFile}
                type="file"
                accept=".srt,.vtt,text/vtt,application/x-subrip"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const list = parseCues(await f.text());
                  if (!list?.length) return void toast.error("That file has no timed lines (.srt or .vtt)");
                  dispatch({ type: "reset", cues: list });
                  toast.success(`${list.length} lines imported`);
                }}
              />
              <Button variant="ghost" size="sm" className="rounded-full" onClick={() => importFile.current?.click()}>
                <FileUp className="size-3.5" /> Import
              </Button>
            </>
          }
        >
          {!cues.length && (
            <div className="mb-3 rounded-xl bg-muted/60 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Label htmlFor="cap-source" className="text-[13px] sm:w-28">
                  Spoken language
                </Label>
                <SourceLanguageSelect id="cap-source" value={source} onChange={setSource} />
              </div>
              <Button className="mt-3 w-full rounded-full sm:w-auto" onClick={transcribe} disabled={create.isPending || !!transcribing}>
                {transcribing ? <Loader2 className="size-4 animate-spin" /> : <Captions className="size-4" />}
                {transcribing ? "Transcribing…" : "Transcribe the speech"}
              </Button>
              <p className="mt-2 text-[12px] text-muted-foreground">{engine === "open" ? "Detects 30 languages." : "ElevenLabs Scribe v2 (word timings, ≈ $0.008 per minute)."}</p>
              {voiceFirstShown && <VoiceFirstSwitch className="mt-3" engine={engine} on={cleanFirst} onChange={setVoiceFirst} seconds={duration} />}
              {t && <StepList className="mt-3" steps={[{ key: "t", label: "Transcript", g: t }]} />}
            </div>
          )}
          <CueEditor
            editor={editor}
            currentTime={time}
            onSeek={(s) => {
              if (player.current) player.current.currentTime = s;
            }}
            className="max-h-[60vh]"
            emptyHint="Transcribe the clip, import an .srt / .vtt, or write the lines yourself."
            /* Fix this line: change what was said in the clip itself (Edit speech, your GPU only). */
            onFixLine={mode === "cloud" ? undefined : (i) => router.push(speechEditLink({ media: video.ref, kind: "video", name: video.name, cues, line: i }))}
          />
        </Panel>

        <Panel title="Burn in">
          {engine === "cloud" && (
            <div role="radiogroup" aria-label="Burner" className="mb-3 grid gap-2 sm:grid-cols-2">
              <RouteCard
                on={!quick}
                onClick={() => setQuick(false)}
                icon={<Flame className="size-4" />}
                title="Your lines"
                note={`VEED Subtitles burns your edited lines in your style (≈ $${burnPricePerMinute("veed", look.style).toFixed(2)} per minute${burnPricePerMinute("veed", look.style) > 0.1 ? ` — ${styleById(look.style).name} is one of VEED's dynamic styles` : ""}).`}
              />
              <RouteCard on={quick} onClick={() => setQuick(true)} icon={<Wand2 className="size-4" />} title="Quick karaoke" note="Auto Subtitle transcribes again and burns word-by-word captions, the spoken word highlighted (≈ $0.03 per minute) — your edits aren't used." />
            </div>
          )}
          {engine === "open" && <p className="mb-3 text-[12px] text-muted-foreground">Your captions are burned into the video, and the sound stays.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button className={cn("rounded-full", usesCues(route) && problems.length > 0 && "bg-muted text-muted-foreground hover:bg-muted")} onClick={burn} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Burn captions
            </Button>
            <Button variant="outline" className="rounded-full" disabled={!cues.length} onClick={() => download(`${name}.srt`, toSrt(cues), "application/x-subrip")}>
              <Download className="size-3.5" /> .srt
            </Button>
            <Button variant="outline" className="rounded-full" disabled={!cues.length} onClick={() => download(`${name}.vtt`, toVtt(cues), "text/vtt")}>
              <Download className="size-3.5" /> .vtt
            </Button>
          </div>
          {usesCues(route) && problems.length > 0 && cues.length > 0 && <p className="mt-2 text-[12px] text-muted-foreground">Fix first: {problems.join(" · ")}</p>}
        </Panel>
      </div>
    </div>
  );
}

function RouteCard({ on, onClick, icon, title, note }: { on: boolean; onClick: () => void; icon: React.ReactNode; title: string; note: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className={cn("flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-colors", on ? "border-primary bg-brand-faint" : "hover:bg-accent")}>
      <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground">{note}</span>
      </span>
    </button>
  );
}

/** The video with the active line drawn the way the burner will draw it. */
function Preview({
  video,
  cues,
  look,
  route,
  player,
  onTime,
  onDuration,
}: {
  video: SlotValue;
  cues: Cue[];
  look: CaptionLook;
  route: BurnRoute;
  player: React.RefObject<HTMLVideoElement | null>;
  onTime: (t: number) => void;
  onDuration: (t: number) => void;
}) {
  const [t, setT] = useState(0);
  const [h, setH] = useState(360);
  useEffect(() => {
    const el = player.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight || 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, [player]);
  const style = styleById(look.style);
  const shown = previewText(cues, t, look, route);
  const color = look.color ?? style.color;
  // Only what this burner draws: no box on the open engine, no highlight where the spoken word isn't marked.
  const box = style.box && BURN_CAPS[route].box;
  const words = useMemo(() => shown?.text.split(" ") ?? [], [shown]);
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-media">
      <video
        ref={player}
        src={video.ref}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(e) => {
          setT(e.currentTarget.currentTime);
          onTime(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration) && el.duration > 0) onDuration(el.duration);
          else void realDuration(el).then((d) => d && onDuration(d));
        }}
        className="max-h-[52vh] w-full object-contain"
      />
      {shown && (
        <div
          aria-live="off"
          className={cn("pointer-events-none absolute inset-x-[6%] flex justify-center text-center", look.position === "top" ? "top-[8%]" : look.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-[14%]")}
        >
          <span
            className={cn("leading-tight", box && "rounded-md bg-black/60 px-2 py-0.5")}
            style={{
              fontFamily: `${style.font}, var(--font-sans), sans-serif`,
              fontWeight: style.weight,
              fontSize: Math.max(11, (h * OPEN_FONT_SIZE[look.size]) / 100),
              color,
              textShadow: box ? undefined : "0 0 3px #000, 0 0 3px #000, 0 1px 2px #000",
            }}
          >
            {words.map((w, i) => (
              <span key={i} style={shown.highlight === i && style.highlight ? { color: style.highlight } : undefined}>
                {w}
                {i < words.length - 1 ? " " : ""}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

const SIZES: CaptionSize[] = ["S", "M", "L"];
const POSITIONS: { id: CaptionPosition; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "center", label: "Middle" },
  { id: "bottom", label: "Bottom" },
];

function StylePanel({ look, route, onChange }: { look: CaptionLook; route: BurnRoute; onChange: (l: CaptionLook) => void }) {
  const seg = (on: boolean) => cn("h-7 rounded-full px-3 text-[12px] font-medium transition disabled:pointer-events-none disabled:opacity-40", on ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground");
  const caps = BURN_CAPS[route];
  const position = lookFor(route, look).position;
  return (
    <Panel title="Style">
      <div role="radiogroup" aria-label="Caption style" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {CAPTION_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={look.style === s.id}
            onClick={() => onChange({ ...look, style: s.id, color: undefined })}
            className={cn("flex flex-col items-center gap-1 rounded-xl border p-2 transition-colors", look.style === s.id ? "border-primary bg-brand-faint" : "hover:bg-accent")}
          >
            <span aria-hidden className={cn("grid h-9 w-full place-items-center rounded-md bg-[oklch(0.3_0.02_260)] text-[13px] leading-none", s.box && caps.box && "px-1")} style={{ fontWeight: s.weight, fontFamily: `${s.font}, var(--font-sans), sans-serif` }}>
              <span className={cn(s.box && caps.box && "rounded bg-black/70 px-1 py-0.5")} style={{ color: s.color, textShadow: s.box && caps.box ? undefined : "0 0 2px #000" }}>
                {s.upper ? "AA" : "Aa"}
                {s.karaoke && <span style={caps.highlight !== "none" ? { color: s.highlight } : undefined}>a</span>}
              </span>
            </span>
            <span className="text-[11px] font-medium">{s.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {caps.sizes && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Size</span>
            <div role="radiogroup" aria-label="Size" className="inline-flex rounded-full bg-muted p-0.5">
              {SIZES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={look.size === s} onClick={() => onChange({ ...look, size: s })} className={seg(look.size === s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">Position</span>
          <div role="radiogroup" aria-label="Position" className="inline-flex rounded-full bg-muted p-0.5">
            {POSITIONS.map((p) => {
              const can = caps.positions.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={position === p.id}
                  disabled={!can}
                  title={can ? undefined : "This burner draws at the top or the bottom"}
                  onClick={() => onChange({ ...look, position: p.id })}
                  className={seg(position === p.id)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          Colour
          <input
            type="color"
            value={look.color ?? styleById(look.style).color}
            onChange={(e) => onChange({ ...look, color: e.target.value })}
            className="size-7 cursor-pointer rounded-full border bg-transparent p-0.5"
            aria-label="Caption colour"
          />
        </label>
      </div>
      <p className="mt-3 text-[12px] text-muted-foreground">{burnNote(route)}</p>
    </Panel>
  );
}
