"use client";

import { AudioLines, Check, Loader2, Mic, Pause, Play, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fileToSlot } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { VoiceRecorder } from "@/components/studio/voice-recorder";
import { useMaybeClean } from "@/components/audio-tools/clean-voice-switch";
import { useAskBeforeUpload, useElements, useLikelyVisitor } from "@/lib/api";
import type { NarratorVoice, PickerData } from "@/lib/catalog/faceless";
import type { Engine } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { voicePreview, waitFor } from "./hooks";
import { voiceOrigin } from "@/lib/voice-design";

/** One shared player, so starting a sample stops the one before. */
const player = { audio: null as HTMLAudioElement | null, owner: "" };

function usePlayer() {
  const [playing, setPlaying] = useState("");
  const [loading, setLoading] = useState("");
  const cache = useRef(new Map<string, string>());
  useEffect(
    () => () => {
      player.audio?.pause();
    },
    [],
  );
  const play = (key: string, url: string) => {
    player.audio?.pause();
    const a = new Audio(url);
    player.audio = a;
    player.owner = key;
    a.onended = () => setPlaying((p) => (p === key ? "" : p));
    a.onpause = () => setPlaying((p) => (p === key ? "" : p));
    void a.play().then(
      () => setPlaying(key),
      // A sample that took a while to make may not autoplay any more: it's cached, the next press plays it.
      (e: Error) => (e.name === "NotAllowedError" ? toast("Sample ready — press play to listen", { id: "voice-sample" }) : toast.error("Couldn't play that sample", { id: "voice-sample" })),
    );
  };
  const toggle = async (key: string, load: () => Promise<string | null>) => {
    if (playing === key) return void player.audio?.pause();
    const known = cache.current.get(key);
    if (known) return play(key, known);
    setLoading(key);
    try {
      const url = await load();
      if (!url) return;
      cache.current.set(key, url);
      play(key, url);
    } catch (e) {
      toastError(e);
    } finally {
      setLoading((l) => (l === key ? "" : l));
    }
  };
  return { playing, loading, toggle };
}

/** A premade voice's sample: one short speech generation the first time, the same file after that. */
async function presetSample(id: string): Promise<string | null> {
  const g = await voicePreview(id);
  const done = g.status === "succeeded" ? g : await waitFor(g.id);
  if (done.status !== "succeeded") throw new Error(done.error ?? "Couldn't make a sample of that voice");
  return done.outputs.find((o) => o.kind === "audio")?.url ?? null;
}

function PlayButton({ active, loading, onClick, label }: { active: boolean; loading: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={active ? `Pause ${label}` : `Play a sample of ${label}`}
      className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
    </button>
  );
}

const sameVoice = (a: NarratorVoice | null, b: NarratorVoice) => !!a && a.kind === b.kind && (a.kind === "preset" ? a.id === (b as { id: string }).id : a.url === (b as { url: string }).url);

/**
 * Pick the narrator: a premade voice (cloud, each with a sample to play) or your own voice to clone —
 * a saved voice element, a recording or an upload (any engine; the only choice for open-source narration).
 */
export function NarratorList({ engine, voices, value, onChange }: { engine: Engine; voices: PickerData["voices"]; value: NarratorVoice | null; onChange: (v: NarratorVoice) => void }) {
  const saved = (useElements().data ?? []).filter((e) => e.kind === "voice" && e.references[0]);
  const file = useRef<HTMLInputElement>(null);
  // Your own file: a guest is asked to sign up, and an account with neither its own GPU nor its own key to connect one,
  // before the chooser opens (as Record does).
  const askFirst = useAskBeforeUpload();
  // Saved voices are the studio owner's Elements: a visitor records or uploads one.
  const visitor = useLikelyVisitor();
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  // "Clean up voice" on the sample: the narration is cloned from the clean file (Faceless and Explainer both).
  const clean = useMaybeClean();
  const p = usePlayer();
  const list = voices.filter((v) => !q || `${v.name} ${v.hint ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const own = value?.kind === "sample" && !saved.some((e) => e.references[0] === value.url) ? value : null;
  // One Tab stop for the whole list: the picked voice, else the first one shown.
  const shown: NarratorVoice[] = [
    ...(engine === "cloud" ? list.map((v): NarratorVoice => ({ kind: "preset", id: v.id })) : []),
    ...saved.map((e): NarratorVoice => ({ kind: "sample", url: e.references[0] })),
    ...(own ? [own] : []),
  ];
  const picked = shown.some((v) => sameVoice(value, v));

  const row = (key: string, v: NarratorVoice, name: string, hint: string | undefined, sample: () => Promise<string | null>) => {
    const active = sameVoice(value, v);
    const stop = active || (!picked && !!shown[0] && sameVoice(shown[0], v));
    return (
      <div key={key} className={cn("flex items-center gap-1.5 rounded-lg pl-1.5 transition-colors hover:bg-accent", active && "bg-brand-faint hover:bg-brand-faint-hover")}>
        <PlayButton active={p.playing === key} loading={p.loading === key} onClick={() => void p.toggle(key, sample)} label={name} />
        <button
          type="button"
          role="radio"
          aria-checked={active}
          tabIndex={radioTab(stop)}
          onClick={() => onChange(v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-[13px] font-medium", active && "text-brand-text")}>{name}</span>
            {hint && <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>}
          </span>
          {active && <Check className="size-4 shrink-0 text-brand-text" />}
        </button>
      </div>
    );
  };

  return (
    <div
      className="space-y-3"
      role="radiogroup"
      aria-label="Narrator voice"
      // The arrow keys move between voices, except while typing in the search box.
      onKeyDown={(e) => !(e.target as HTMLElement).closest("input, textarea") && radioKeys(e)}
    >
      {engine === "cloud" && (
        <div>
          <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Narrators</p>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search voices"
              aria-label="Search voices"
              className="h-7 w-36 rounded-md border bg-background px-2 text-[12px] outline-none focus:border-primary"
            />
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
            {list.map((v) => row(`preset:${v.id}`, { kind: "preset", id: v.id, name: v.name }, v.name, v.hint, () => presetSample(v.id)))}
            {!list.length && <p className="px-2 py-3 text-[13px] text-muted-foreground">No voice matches “{q}”.</p>}
          </div>
        </div>
      )}
      <div>
        <p className="px-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{engine === "open" ? "Narrator to clone" : "Your own voice"}</p>
        {engine === "open" && <p className="px-1 pb-2 text-[12px] text-muted-foreground">Open-source narration clones a voice: {saved.length ? "pick a saved voice, or record or upload" : "record or upload"} 10–60 s of clean speech.</p>}
        <div className="space-y-0.5">
          {saved.map((e) => row(`saved:${e.id}`, { kind: "sample", url: e.references[0], name: e.name }, e.name, voiceOrigin(e.voice) ?? e.description ?? "Saved voice", async () => e.references[0]))}
          {own && row(`own:${own.url}`, own, own.name ?? "Your recording", "Recorded or uploaded", async () => own.url)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-1 pt-2">
          <VoiceRecorder clean onRecorded={(v) => onChange({ kind: "sample", url: v.ref, name: v.name ?? "Your recording" })} />
          <button
            type="button"
            onClick={() => askFirst() || file.current?.click()}
            disabled={uploading}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent disabled:opacity-60"
          >
            {uploading || clean.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} {clean.busy ? "Cleaning…" : "Upload"}
          </button>
          <input
            ref={file}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              void fileToSlot(
                f,
                (v) => {
                  setUploading(!!v?.uploading);
                  if (v && !v.uploading) void clean.run(v, (c) => onChange({ kind: "sample", url: c.ref, name: `${f.name.replace(/\.[^.]+$/, "")}${c.original ? " · cleaned" : ""}` }));
                },
                "audio",
              );
            }}
          />
          {!saved.length && !visitor && (
            <Link href="/elements?new=1" className="ml-auto text-[12px] text-brand-text hover:underline">
              Save voices in Elements
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export function voiceLabel(value: NarratorVoice | null, voices: PickerData["voices"], engine: Engine): string {
  if (!value) return engine === "open" ? "Add a voice" : "Default voice";
  if (value.kind === "sample") return value.name ?? "Your voice";
  return value.name ?? voices.find((v) => v.id === value.id)?.name ?? "Narrator";
}

/** The narrator as a chip that opens the list (Explainer's settings row, the channel page). */
export function NarratorChip(props: { engine: Engine; voices: PickerData["voices"]; value: NarratorVoice | null; onChange: (v: NarratorVoice) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const label = voiceLabel(props.value, props.voices, props.engine);
  const missing = props.engine === "open" && props.value?.kind !== "sample";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Narrator: ${label}`}
          className={cn(
            "inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
            missing ? "bg-secondary text-muted-foreground hover:bg-accent" : "bg-brand-faint text-brand-text hover:bg-brand-faint-hover",
            props.className,
          )}
        >
          {props.value?.kind === "sample" ? <Mic className="size-3.5 shrink-0" /> : <AudioLines className="size-3.5 shrink-0" />}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,360px)] p-2" align="start" collisionPadding={12}>
        <NarratorList
          {...props}
          onChange={(v) => {
            props.onChange(v);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
