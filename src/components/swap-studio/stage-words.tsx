"use client";

import { Loader2, Mic, Wand2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useVoiceFirstLive, useVoiceFirstShown, VoiceFirstSwitch } from "@/components/audio-tools/voice-first-switch";
import { voiceFirstDefault } from "@/lib/av/voice-first";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "@/components/av/tool-shell";
import { buildShotPrompt, ROLE_LABELS, secondsLabel, shotDialogue, shotSpeaker, SWAP_STUDIO, voiceLabel, voicesOf, type SwapRole } from "@/lib/catalog/swap-studio";
import { toastError } from "@/lib/refusals";
import { useTranscribe } from "./hooks";
import { GenChip, JobError, Note, priceText, SavedText } from "./parts";
import type { StageProps } from "./workbench";

const ROLES = Object.keys(ROLE_LABELS) as SwapRole[];
const stamp = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function RoleSelect({ value, onChange, label, auto }: { value: SwapRole | null; onChange: (v: SwapRole | null) => void; label: string; auto?: SwapRole }) {
  return (
    <Select value={value ?? "auto"} onValueChange={(v) => onChange(v === "auto" ? null : (v as SwapRole))}>
      <SelectTrigger className="h-8 w-full min-w-0 text-[13px] sm:w-56" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {auto && <SelectItem value="auto">From the words · {ROLE_LABELS[auto].label}</SelectItem>}
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABELS[r].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Words: the clip's transcript (both engines' speech to text), who each voice is, and each shot's speaker, words and prompt. */
export function WordsStage({ id, project, clip, gens, estimate, edit }: StageProps) {
  const transcribe = useTranscribe(id);
  // "Clean the voice first": on for the clip's speech on your GPU, off in the cloud (a paid step there).
  const voiceFirstShown = useVoiceFirstShown(true);
  const voiceFirstLive = useVoiceFirstLive();
  const [voiceFirst, setVoiceFirst] = useState<boolean | null>(null);
  const cleanFirst = voiceFirstShown && (voiceFirst ?? (project.engine === "open" && voiceFirstDefault("video", voiceFirstLive)));
  const t = clip.transcript;
  const voices = voicesOf(t?.cues);
  const busy = !!t?.genId && (gens[t.genId]?.status === "queued" || gens[t.genId]?.status === "running");
  return (
    <div className="space-y-3">
      <Panel
        title="Transcript"
        aside={
          <span className="flex items-center gap-2">
            {t?.genId && <GenChip genId={t.genId} gens={gens} />}
            <Button
              size="sm"
              variant={t?.cues ? "outline" : "default"}
              className="h-8 rounded-full"
              disabled={busy || transcribe.isPending || !clip.source.hasAudio}
              onClick={() => transcribe.mutate({ clipId: clip.id, ...(cleanFirst && { cleanVoiceFirst: true }) }, { onError: (e) => toastError(e) })}
            >
              {busy || transcribe.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Mic className="size-3.5" />}
              {t?.cues ? "Transcribe again" : "Transcribe"}
              <span className="font-mono text-[11px] opacity-80">{priceText(estimate?.transcribe[clip.id], { demo: estimate?.demo, engine: project.engine })}</span>
            </Button>
          </span>
        }
      >
        {!clip.source.hasAudio ? (
          <Note>This clip has no sound: every shot is “No dialogue”.</Note>
        ) : !t?.cues ? (
          <div className="space-y-3">
            <Note>
              {project.engine === "open" ? "Qwen3-ASR on your ComfyUI" : "ElevenLabs Scribe v2 (fal)"} writes the clip&apos;s words with their times{project.engine === "cloud" ? " and who says them" : ""}; each shot and segment then takes the words spoken in it.
            </Note>
            {voiceFirstShown && <VoiceFirstSwitch engine={project.engine} on={cleanFirst} onChange={setVoiceFirst} seconds={clip.source.duration} />}
          </div>
        ) : (
          <div className="space-y-3">
            {voices.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12px] font-medium">Who is each voice?</p>
                {voices.map((v) => (
                  <div key={v} className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-[13px]">{voiceLabel(voices, v)}</span>
                    <RoleSelect label={`${voiceLabel(voices, v)} is`} value={t.voices[v] ?? "target"} onChange={(r) => void edit({ type: "voices", clipId: clip.id, voices: { [v]: r ?? "target" } })} />
                  </div>
                ))}
              </div>
            )}
            <ol className="max-h-56 space-y-1 overflow-y-auto rounded-lg bg-muted p-2 text-[12px]" aria-label="Transcript lines">
              {t.cues.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{stamp(c.start)}</span>
                  {voices.length > 1 && <span className="shrink-0 text-muted-foreground">{voiceLabel(voices, c.speaker || "voice")}</span>}
                  <span className="min-w-0">{c.text}</span>
                </li>
              ))}
              {!t.cues.length && <li className="text-muted-foreground">No words found.</li>}
            </ol>
          </div>
        )}
        <div className="mt-2">
          <JobError genId={t?.genId} gens={gens} />
        </div>
      </Panel>

      <Panel
        title="Shot prompts"
        aside={
          <Button size="sm" className="h-8 rounded-full" onClick={() => void edit({ type: "build-prompts", clipId: clip.id })} disabled={!clip.shots.some((s) => s.mode === "generate")}>
            <Wand2 className="size-3.5" /> Build shot prompts
          </Button>
        }
      >
        <Note className="mb-3">H3&apos;s reference tags: &lt;Video 1&gt; is the clip, &lt;Picture 1&gt; your character, &lt;Picture 2&gt; the scene anchor, &lt;Audio 1&gt; the clip&apos;s sound. On the cloud they become Video 1, Image 1 and Image 2.</Note>
        <ol className="space-y-3">
          {clip.shots.map((s, i) =>
            s.mode !== "generate" ? (
              <li key={s.id} className="rounded-lg border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
                Shot {i + 1} · {secondsLabel(s.end - s.start)} · kept as filmed
              </li>
            ) : (
              <li key={s.id} className="space-y-2 rounded-lg border px-3 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">
                    Shot {i + 1} <span className="font-normal text-muted-foreground">· {secondsLabel(s.end - s.start)}</span>
                  </span>
                  <div className="ml-auto w-full sm:w-auto">
                    <RoleSelect label={`Shot ${i + 1}: who speaks`} value={s.speaker} auto={shotSpeaker(clip, { ...s, speaker: null })} onChange={(speaker) => void edit({ type: "shot", clipId: clip.id, shotId: s.id, patch: { speaker } })} />
                  </div>
                </div>
                <SavedText
                  label="Words"
                  rows={2}
                  max={SWAP_STUDIO.maxPromptChars}
                  value={shotDialogue(clip, s)}
                  hint={s.dialogue === null ? "from the transcript" : "your words"}
                  onSave={(dialogue) => void edit({ type: "shot", clipId: clip.id, shotId: s.id, patch: { dialogue } })}
                />
                <SavedText
                  label="Prompt"
                  rows={4}
                  max={SWAP_STUDIO.maxPromptChars}
                  value={s.prompt ?? buildShotPrompt(project, clip, s)}
                  hint={s.prompt === null ? "built from the above — edit to keep your own" : "yours"}
                  onSave={(prompt) => void edit({ type: "shot", clipId: clip.id, shotId: s.id, patch: { prompt } })}
                />
              </li>
            ),
          )}
        </ol>
      </Panel>
    </div>
  );
}
