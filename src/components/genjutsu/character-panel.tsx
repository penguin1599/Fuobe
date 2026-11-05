"use client";

import { VoiceFirstSwitch } from "@/components/audio-tools/voice-first-switch";
import { AudioLines, Cpu, Drama, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, Segmented } from "@/components/shorts/ui";
import { OwnSetupChip } from "@/components/own-setup";
import {
  ANCHOR_MODELS,
  anchorModel,
  CHARACTER_GPU,
  CHARACTER_LIMITS,
  CHARACTER_SWAP,
  historyChoicesFor,
  SPEECH_LABELS,
  SWAP_LORAS,
  WHO_INDEX_LABEL,
  WHO_LABELS,
  WINDOW_CHOICES,
  CHARACTER_QUALITIES,
  characterFinish,
  characterQuality,
  type CharacterChoice,
  type CharacterOptions,
  type SwapLora,
  type SwapSpeech,
  type SwapWho,
} from "@/lib/catalog/character-swap";
import type { GenjutsuTarget, Maker } from "@/lib/catalog/genjutsu";
import { cloudSharpenUsd, OPEN_TIER_OFF, SHARPEN_COPY, type SharpenTier } from "@/lib/catalog/sharpen";
import type { Engine } from "@/lib/catalog/types";
import { limitMb, useClipLimit } from "@/lib/clip-limit";

/** The Quality field's short hint: H3's own sizes in words, a finishing size's price (cloud) or "Free · your GPU". */
export function qualityShort(engine: Engine, q: CharacterChoice): string {
  const finish = characterFinish(q);
  if (!finish) return q === "480p" ? "Faster and cheaper" : "H3's native top";
  return engine === "open" ? "Free · your GPU" : `$${(cloudSharpenUsd(finish, 5) ?? 0).toFixed(2)} for 5 s`;
}

/** What a quality does, in a line: H3's own sizes, or a finishing size with its price (cloud) or GPU time (open). */
export function qualityHint(engine: Engine, q: CharacterChoice): string {
  const finish = characterFinish(q);
  if (!finish) return qualityShort(engine, q);
  if (engine === "open") return `${SHARPEN_COPY.hintOpen} Free on your GPU, about 3 min more per 5 s on a 72 GB GPU. ${SHARPEN_COPY.joinOpen}`;
  const usd = (s: number) => `$${(cloudSharpenUsd(finish, s) ?? 0).toFixed(2)}`;
  return `${SHARPEN_COPY.hint} ${usd(5)} for 5 s, ${usd(15)} for 15 s.`;
}

/** Why a quality can't be picked on this engine (your GPU's 4K: it joins the clip at up to 2048 px a side), or null. */
export const qualityOff = (engine: Engine, q: CharacterChoice): string | null => (engine === "open" ? (OPEN_TIER_OFF[q as SharpenTier] ?? null) : null);

/** A helper the panel offers (Describe my character, the clip's words): its action, whether it's running or can run. */
export interface PanelHelper {
  run: () => void;
  busy: boolean;
  /** Why it can't run yet (it is disabled with this as its hint). */
  blocked?: string | null;
}

/**
 * Character swap's own settings (Openjutsu's and Akatz Labs' H3 Character Swap tool's, on Genjutsu): who to swap,
 * the quality, the first frame made first, what the character looks like (or Describe it from the picture), the seed,
 * and under Advanced the speech (or the clip's own words), the swap LoRA's release and the H3 settings of the open
 * graph. The limits and the GPU line sit under it.
 */
export function CharacterControls({
  engine,
  maker,
  target,
  value,
  onChange,
  quality,
  onQuality,
  seed,
  onSeed,
  seedProblem,
  describe,
  words,
  voiceFirst,
}: {
  engine: Engine;
  maker: Maker | null;
  target?: GenjutsuTarget;
  value: CharacterOptions;
  onChange: (v: CharacterOptions) => void;
  quality: CharacterChoice;
  onQuality: (q: CharacterChoice) => void;
  seed: string;
  onSeed: (s: string) => void;
  seedProblem?: string | null;
  /** "Describe my character" from the character picture (the engine's text model). */
  describe?: PanelHelper;
  /** "Use the clip's words": the part's lines from a transcription of the clip. */
  words?: PanelHelper;
  /** "Clean the voice first" for that transcription (shown when given). */
  voiceFirst?: { on: boolean; onChange: (on: boolean) => void; seconds?: number };
}) {
  const set = (patch: Partial<CharacterOptions>) => onChange({ ...value, ...patch });
  const h3 = !!maker?.h3;
  // Each engine's sizes (the cloud has no 1080p); a size the other engine offered shows as the swap's own.
  const offered = (maker?.qualities as CharacterChoice[] | undefined) ?? CHARACTER_QUALITIES[engine];
  // A size this engine can't make worth it (your GPU's 4K) shows as the largest below it that it can.
  const shown: CharacterChoice = !offered.includes(quality) ? characterQuality(quality) : qualityOff(engine, quality) ? ([...offered].reverse().find((q) => q !== quality && !qualityOff(engine, q) && characterFinish(q)) ?? "768p") : quality;
  const offReasons = offered.flatMap((q) => (qualityOff(engine, q) ? [{ q, reason: qualityOff(engine, q)! }] : []));
  const open = engine === "open";
  const anchors = ANCHOR_MODELS[engine];
  const who: SwapWho = value.who ?? "largest";
  const window = value.windowFrames ?? CHARACTER_SWAP.window;
  const histories = historyChoicesFor(window);
  // fal's H3 route needs a swap LoRA: "None" is a GPU choice.
  const loraChoices = [
    { value: "v1.5" as const, label: "V1.5", title: SWAP_LORAS["v1.5"].label },
    { value: "v1" as const, label: "V1", title: SWAP_LORAS.v1.label },
    ...(open ? [{ value: "none" as const, label: "None", title: "MiniMax H3 with the Turbo LoRA only" }] : []),
  ];
  return (
    <div className="space-y-4">
      {target === "type" && (
        <Field label="Who to swap" hint={who === "largest" ? "The largest person in the first frame" : undefined}>
          <Segmented
            label="Who to swap"
            value={who}
            onChange={(w) => set({ who: w, ...(w === "index" ? { index: value.index ?? 0 } : {}) })}
            options={(Object.keys(WHO_LABELS) as SwapWho[]).map((w) => ({ value: w, label: WHO_LABELS[w] }))}
          />
          {who === "index" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <label htmlFor="gj-person" className="text-[12px] text-muted-foreground" title={WHO_INDEX_LABEL[engine].hint}>
                {WHO_INDEX_LABEL[engine].label}
              </label>
              <Input
                id="gj-person"
                type="number"
                inputMode="numeric"
                min={1}
                max={CHARACTER_SWAP.maxPeople}
                value={(value.index ?? 0) + 1}
                onChange={(e) => set({ index: Math.max(0, Math.min(CHARACTER_SWAP.maxPeople - 1, Math.round(Number(e.target.value) || 1) - 1)) })}
                className="h-8 w-20 text-[13px]"
              />
              {open && <p className="w-full text-[12px] leading-snug text-muted-foreground">{WHO_INDEX_LABEL.open.hint}.</p>}
            </div>
          )}
        </Field>
      )}
      {(target === "type" || !open) && (
        <Field label="Who, in words (optional)" htmlFor="gj-who-words" hint={open ? "What SAM 3.1 looks for" : "Said in the prompt"}>
          <Input
            id="gj-who-words"
            value={value.subject ?? ""}
            onChange={(e) => set({ subject: e.target.value || undefined })}
            maxLength={120}
            placeholder="e.g. “the man in the red jacket”"
            className="text-[13px]"
          />
        </Field>
      )}

      {h3 && (
        <Field label="Quality" hint={qualityShort(engine, shown)}>
          <Segmented
            label="Quality"
            value={shown}
            onChange={onQuality}
            describedBy={offReasons.length ? "character-quality-off" : undefined}
            options={offered.map((q) => ({ value: q, label: q, disabled: !!qualityOff(engine, q), title: qualityOff(engine, q) ?? undefined }))}
          />
          {/* Your GPU's 1080p / 2K / 4K regenerate with Open-H3 Regenerate: a 48 GB card, and the choice says so. */}
          {engine === "open" && characterFinish(shown) && <OwnSetupChip setup="regenerate:swap-sharpen" />}
          {characterFinish(shown) && <p className="text-[12px] leading-snug text-pretty text-muted-foreground">{qualityHint(engine, shown)}</p>}
          {offReasons.length > 0 && (
            <p id="character-quality-off" className="text-[12px] leading-snug text-pretty text-muted-foreground">
              {offReasons.map((o) => `${o.q}: ${o.reason}.`).join(" ")}
            </p>
          )}
        </Field>
      )}

      {maker?.h3?.anchor && (
        <div className="space-y-2 rounded-xl bg-muted/50 p-3">
          <label className="flex items-start justify-between gap-3 text-[13px]">
            <span className="min-w-0">
              <span className="block font-medium">Make the first frame first</span>
              <span className="block text-[12px] leading-snug text-muted-foreground">
                Your character put into the part&apos;s first frame, then H3 follows it. If it can&apos;t be made, the swap runs without it and says so.
              </span>
            </span>
            <Switch checked={value.anchor !== false} onCheckedChange={(on) => set({ anchor: on ? undefined : false })} aria-label="Make the first frame first" />
          </label>
          {value.anchor !== false && anchors.length > 1 && (
            <Segmented
              label="First frame model"
              value={anchorModel(engine, value.anchorModel).id}
              onChange={(id) => set({ anchorModel: id === anchors[0].id ? undefined : id })}
              options={anchors.map((a) => ({ value: a.id, label: a.label, title: a.note }))}
            />
          )}
          {value.anchor !== false && <p className="text-[12px] text-muted-foreground">{anchorModel(engine, value.anchorModel).note}</p>}
        </div>
      )}

      <Field label="What your character looks like (optional)" htmlFor="gj-description" hint={describe?.blocked ?? undefined}>
        <div className="flex flex-col items-start gap-1.5">
          <Input
            id="gj-description"
            value={value.description ?? ""}
            onChange={(e) => set({ description: e.target.value || undefined })}
            maxLength={CHARACTER_SWAP.maxDescriptionChars}
            placeholder="e.g. “a young woman with short silver hair and a green raincoat”"
            className="text-[13px]"
          />
          {describe && (
            <Button type="button" size="sm" variant="outline" className="rounded-full" disabled={describe.busy || !!describe.blocked} onClick={describe.run}>
              {describe.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Describe my character
            </Button>
          )}
        </div>
      </Field>

      <Field label="Seed (optional)" htmlFor="gj-seed" hint={seedProblem ?? "Blank is random"}>
        <Input id="gj-seed" type="number" inputMode="numeric" min={0} max={CHARACTER_SWAP.maxSeed} value={seed} onChange={(e) => onSeed(e.target.value)} placeholder="Random" className="text-[13px]" aria-invalid={!!seedProblem} />
      </Field>

      {h3 && (
        <details className="group rounded-xl border px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
          <summary className="cursor-pointer list-none text-[13px] font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">
            Advanced <span className="text-[12px] font-normal text-muted-foreground">· speech, LoRA{open ? ", mask, windows" : ""}</span>
          </summary>
          <div className="space-y-3 pt-3">
            <Field label="Who speaks in the part" htmlFor="gj-speech">
              <Select value={value.speech ?? "character"} onValueChange={(v) => set({ speech: v === "character" ? undefined : (v as SwapSpeech) })}>
                <SelectTrigger id="gj-speech" className="h-8 w-full text-[13px]">
                  <SelectValue>{SPEECH_LABELS[value.speech ?? "character"].label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SPEECH_LABELS) as SwapSpeech[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SPEECH_LABELS[s].label} — {SPEECH_LABELS[s].hint}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {value.speech !== "none" && (
              <Field label="What's said (optional)" htmlFor="gj-dialogue" hint={words?.blocked ?? undefined}>
                <Textarea
                  id="gj-dialogue"
                  value={value.dialogue ?? ""}
                  onChange={(e) => set({ dialogue: e.target.value || undefined })}
                  maxLength={2000}
                  rows={2}
                  placeholder="The words in the part, so the lips follow them"
                  className="resize-none text-[13px]"
                />
                {words && (
                  <Button type="button" size="sm" variant="outline" className="mt-1.5 rounded-full" disabled={words.busy || !!words.blocked} onClick={words.run}>
                    {words.busy ? <Loader2 className="size-3.5 animate-spin" /> : <AudioLines className="size-3.5" />} {words.busy ? "Listening to the clip…" : "Use the clip's words"}
                  </Button>
                )}
                {words && voiceFirst && <VoiceFirstSwitch className="mt-2" engine={engine} on={voiceFirst.on} onChange={voiceFirst.onChange} seconds={voiceFirst.seconds} />}
              </Field>
            )}
            <Field label="Swap style" hint="How the swap is drawn">
              <Segmented label="Swap style" value={value.lora ?? "v1.5"} onChange={(l: SwapLora) => set({ lora: l === "v1.5" ? undefined : l })} options={loraChoices} />
            </Field>
            {open && (
              <>
                <label className="flex items-center justify-between gap-3 text-[13px]">
                  <span>
                    Audio guide <span className="text-[12px] text-muted-foreground">· the clip&apos;s sound guides the performance</span>
                  </span>
                  <Switch checked={value.audioGuide !== false} onCheckedChange={(on) => set({ audioGuide: on ? undefined : false })} aria-label="Audio guide" />
                </label>
                {maker?.h3?.maskSwitch && (
                  <label className="flex items-center justify-between gap-3 text-[13px]">
                    <span>
                      Masked generation <span className="text-[12px] text-muted-foreground">· only the person is remade</span>
                    </span>
                    <Switch checked={value.useMask !== false} onCheckedChange={(on) => set({ useMask: on ? undefined : false })} aria-label="Masked generation" />
                  </label>
                )}
                <Field label="Mask margin" htmlFor="gj-grow" hint="Pixels around the person">
                  <Input
                    id="gj-grow"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={256}
                    value={value.maskGrow ?? CHARACTER_SWAP.maskGrow}
                    onChange={(e) => set({ maskGrow: Math.max(0, Math.min(256, Math.round(Number(e.target.value) || 0))) })}
                    className="h-8 text-[13px]"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <FrameSelect
                    id="gj-window"
                    label="Window"
                    value={window}
                    choices={WINDOW_CHOICES}
                    onChange={(n) => {
                      // The pack refuses a history as long as the window: it comes down with it.
                      const h = value.historyFrames ?? CHARACTER_SWAP.history;
                      const fit = h < n ? h : Math.max(...historyChoicesFor(n));
                      set({ windowFrames: n === CHARACTER_SWAP.window ? undefined : n, historyFrames: fit === CHARACTER_SWAP.history ? undefined : fit });
                    }}
                  />
                  <FrameSelect id="gj-history" label="History" value={value.historyFrames ?? CHARACTER_SWAP.history} choices={histories} onChange={(n) => set({ historyFrames: n === CHARACTER_SWAP.history ? undefined : n })} />
                </div>
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function FrameSelect({ id, label, value, choices, onChange }: { id: string; label: string; value: number; choices: number[]; onChange: (n: number) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id} className="h-8 w-full text-[13px] tabular-nums">
          <SelectValue>{value} frames</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {choices.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n} frames
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * The limits, the cut warning and the GPU it was tested on (open), as information under the settings; and
 * the way to Character Swap Studio for the whole clip (`onOpenStudio` takes the clip and character along).
 */
export function CharacterFacts({
  engine,
  maker,
  cut,
  onOpenStudio,
  opening,
  waiting,
}: {
  engine: Engine;
  maker: Maker | null;
  cut: string | null;
  onOpenStudio?: () => void;
  opening?: boolean;
  /** Why the studio can't be opened with the clip yet (it is still uploading). */
  waiting?: string | null;
}) {
  // The clip size this viewer may upload (an account's is smaller than the studio's own).
  const clipMax = useClipLimit(CHARACTER_SWAP.maxBytes);
  return (
    <div className="space-y-2 text-[12px] leading-snug text-muted-foreground">
      {cut && (
        <p role="status" className="flex gap-1.5 rounded-lg bg-warning/10 p-2 text-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{cut}.</span>
        </p>
      )}
      <ul className="list-disc space-y-0.5 pl-4">
        {CHARACTER_LIMITS.map((l) => (
          <li key={l}>{l}</li>
        ))}
        <li>Clips up to {limitMb(clipMax)} MB</li>
      </ul>
      {engine === "open" && maker?.h3 && (
        <p className="flex gap-1.5">
          <Cpu className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {CHARACTER_GPU.tested}. {CHARACTER_GPU.advice}. {CHARACTER_GPU.weightsGb} GB of weights.
          </span>
        </p>
      )}
      {/* Whole clips, shot by shot, with masks, anchors, segments and takes: the studio built on the same H3 recipe. */}
      {onOpenStudio ? (
        <button type="button" onClick={onOpenStudio} disabled={opening || !!waiting} className="inline-flex items-center gap-1 rounded-sm text-left font-medium text-brand-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
          {opening ? <Loader2 className="size-3.5 animate-spin" /> : <Drama className="size-3.5" />} Open in Character Swap Studio
          <span className="font-normal text-muted-foreground">— {waiting ?? "this whole clip and character, shot by shot"}</span>
        </button>
      ) : (
        <Link href="/character-swap" className="inline-flex items-center gap-1 font-medium text-brand-text hover:underline">
          <Drama className="size-3.5" /> Open in Character Swap Studio
          <span className="font-normal text-muted-foreground">— whole clips, shot by shot</span>
        </Link>
      )}
    </div>
  );
}
