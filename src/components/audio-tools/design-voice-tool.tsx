"use client";

import { AudioLines, Check, Loader2, Mic, RotateCcw, Save, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useCreateGeneration, useEngine, useGenerations, useIsVisitor, useSaveElement } from "@/lib/api";
import { getModel } from "@/lib/catalog";
import { stepCostUsd } from "@/lib/catalog/faceless";
import type { Generation } from "@/lib/catalog/types";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TEST_LINE,
  describeVoice,
  DESIGN_MODELS,
  designBlocker,
  designModelFor,
  TEST_LINE_MAX,
  VOICE_CHIPS,
  VOICE_FEATURE,
  VOICE_TAKES,
  type ChipGroup,
  type ChipPicks,
  type DesignModelKey,
} from "@/lib/voice-design";

/**
 * Audio → Design a voice: describe a voice (starter chips and your own words), hear a test line in
 * three takes, and save the one you like as an Element voice. Qwen3-TTS runs on both engines; VoxCPM2 on your GPU only.
 * A saved voice keeps its take, its words and its line, so later lines reuse it on either engine (src/server/voices.ts).
 */

const chip = "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium transition-colors";

function money(engine: "open" | "cloud", usd: number | null): string {
  if (engine === "open") return "Free on your GPU";
  if (usd === null) return "Price unknown";
  return usd < 0.01 ? "Under $0.01" : `≈ $${usd.toFixed(2)}`;
}

/** One take: play it, then save it as a voice (or, for a visitor, use it right away in Speech). */
function Take({ g, index, description, line, canSave }: { g: Generation; index: number; description: string; line: string; canSave: boolean }) {
  const save = useSaveElement();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const url = g.outputs[0]?.url;
  const busy = g.status === "queued" || g.status === "running";
  const submit = () => {
    if (!url || !name.trim()) return;
    save.mutate(
      {
        name: name.trim(),
        kind: "voice",
        description: (g.request.params?.voiceDescription ?? description).slice(0, 500),
        references: [url],
        voice: { modelId: g.request.modelId, description: g.request.params?.voiceDescription ?? description, transcript: g.request.prompt ?? line },
      },
      {
        onSuccess: (el) => {
          setSaved(true);
          setNaming(false);
          toast.success(`Saved ${el.name}`, { description: "It’s in Elements → Voices and in every voice picker." });
        },
        onError: (e) => toastError(e),
      },
    );
  };
  return (
    <li className="min-w-0 rounded-xl border bg-background p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-faint text-[12px] font-semibold text-brand-text">{index + 1}</span>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">Take {index + 1}</p>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[12px] text-success">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
      {url ? (
        <audio src={url} controls preload="metadata" className="h-9 w-full min-w-0" aria-label={`Play take ${index + 1}`} />
      ) : busy ? (
        <p className="flex h-9 items-center gap-2 text-[13px] text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" /> {g.status === "queued" ? "Waiting to start…" : "Speaking…"}
        </p>
      ) : (
        <p className="text-[13px] text-destructive">{g.error ?? "This take didn’t come through. Try again."}</p>
      )}
      {url && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canSave && !saved && !naming && (
            <Button size="sm" className="rounded-full" onClick={() => setNaming(true)}>
              <Save className="size-3.5" /> Save as voice
            </Button>
          )}
          <Button asChild size="sm" variant="ghost" className="rounded-full">
            <Link href={`/audio/speech?voice=${encodeURIComponent(url)}`}>
              <Mic className="size-3.5" /> Use in Speech
            </Link>
          </Button>
        </div>
      )}
      {naming && (
        <form
          className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it, e.g. Old Narrator" maxLength={60} autoFocus aria-label="Voice name" className="h-8 min-w-0 flex-1 basis-40" />
          <Button size="sm" type="submit" className="rounded-full" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
          </Button>
          <Button size="sm" type="button" variant="ghost" className="rounded-full" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}

export function DesignVoiceTool() {
  const [engine, setEngine, mode] = useEngine();
  const visitor = useIsVisitor();
  const create = useCreateGeneration();
  const [picks, setPicks] = useState<ChipPicks>({});
  const [typed, setTyped] = useState("");
  const [line, setLine] = useState(DEFAULT_TEST_LINE);
  const [choice, setChoice] = useState<DesignModelKey>("qwen");
  const [batch, setBatch] = useState<string | null>(null);
  const description = describeVoice(picks, typed);
  // "Paid APIs only" offers no GPU models: VoxCPM2 is left out, with the reason.
  const choices = DESIGN_MODELS.filter((m) => mode !== "cloud" || m.cloud);
  const key = choices.some((m) => m.key === choice) ? choice : choices[0].key;
  const modelId = designModelFor(key, engine);
  const model = modelId ? getModel(modelId) : undefined;
  const blocker = designBlocker(key, engine) ?? (!description ? "Describe the voice, or pick a few chips" : !line.trim() ? "Write a line for it to say" : null);
  const usd = model ? stepCostUsd(model, { feature: VOICE_FEATURE, modelId: model.id, prompt: line }) : null;
  const price = money(engine, usd === null ? null : usd * VOICE_TAKES);

  const all = useGenerations({ features: [VOICE_FEATURE], limit: 24 });
  const takes = useMemo(() => {
    const items = all.data ?? [];
    const id = batch ?? items[0]?.batchId ?? null;
    return id ? items.filter((g) => g.batchId === id).sort((a, b) => a.createdAt - b.createdAt) : [];
  }, [all.data, batch]);
  const latest = takes[0];

  const pick = (group: ChipGroup, option: string) => setPicks((p) => ({ ...p, [group]: p[group] === option ? undefined : option }));
  const run = () => {
    if (blocker || !modelId) return void toast(blocker ?? "Pick a model");
    create.mutate(
      {
        feature: VOICE_FEATURE,
        modelId,
        engine,
        op: "voice-design",
        prompt: line.trim(),
        title: "Designed voice",
        params: { voiceDescription: description, numOutputs: VOICE_TAKES },
      },
      { onSuccess: (items) => setBatch(items[0]?.batchId ?? null), onError: (e) => toastError(e) },
    );
  };

  return (
    <ToolShell title="Audio">
      <ToolHero title="Design a voice" subtitle="Describe who’s speaking. Hear three takes of your line, then save the one you like as a voice you can use anywhere." />
      <div className="mx-auto mt-8 max-w-[820px] min-w-0 space-y-3">
        <Panel title="The voice">
          <div className="space-y-3">
            {VOICE_CHIPS.map((g) => (
              <div key={g.group} className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={g.label}>
                <span className="w-16 shrink-0 text-[12px] font-medium text-muted-foreground">{g.label}</span>
                {g.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={picks[g.group] === o}
                    onClick={() => pick(g.group, o)}
                    className={cn(chip, picks[g.group] === o ? "bg-brand-faint text-brand-text hover:bg-brand-faint-hover" : "bg-secondary text-secondary-foreground hover:bg-accent")}
                  >
                    {picks[g.group] === o && <Check className="size-3" />} {o}
                  </button>
                ))}
              </div>
            ))}
            <Textarea
              value={typed}
              onChange={(e) => setTyped(e.target.value.slice(0, 400))}
              rows={2}
              placeholder="Add your own words, e.g. “a gravelly 60-year-old narrator with a smile in his voice”"
              aria-label="Describe the voice in your own words"
              className="resize-none text-sm"
            />
            {description && (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">The model hears: </span>
                {description}
              </p>
            )}
          </div>
        </Panel>
        <Panel title="Test line">
          <Textarea value={line} onChange={(e) => setLine(e.target.value.slice(0, TEST_LINE_MAX))} rows={2} aria-label="Test line" className="resize-none text-sm" />
          <p className="mt-1.5 text-[12px] text-muted-foreground">Each take says this line. The take you save keeps it, which helps later lines sound the same.</p>
        </Panel>
        <Panel title="Model">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Model">
            {choices.map((m) => {
              const off = engine === "cloud" && !m.cloud;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={key === m.key}
                  onClick={() => setChoice(m.key)}
                  className={cn("min-w-0 rounded-xl border p-3 text-left transition-colors hover:bg-accent", key === m.key && "border-primary bg-brand-faint hover:bg-brand-faint")}
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <AudioLines className="size-4 shrink-0 text-brand-text" /> {m.label}
                  </span>
                  <span className={cn("mt-1 block text-[12px] text-muted-foreground", off && "text-warning")}>{m.blurb}</span>
                </button>
              );
            })}
          </div>
          {mode === "cloud" && <p className="mt-2 text-[12px] text-muted-foreground">VoxCPM2 runs on your GPU (open source), so it isn’t offered with paid APIs only.</p>}
        </Panel>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <p className={cn("min-w-0 flex-1 text-[13px]", blocker ? "text-muted-foreground" : "text-muted-foreground")} aria-live="polite">
            {blocker ?? (
              <>
                {VOICE_TAKES} takes · <span className="font-mono text-foreground">{price}</span>
              </>
            )}
          </p>
          {engine === "cloud" && key === "voxcpm" && mode === "both" && (
            <Button variant="outline" className="rounded-full" onClick={() => setEngine("open")}>
              Use open source
            </Button>
          )}
          <Button size="lg" className={cn("rounded-full", blocker && "bg-muted text-subtle-foreground hover:bg-muted")} onClick={run} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : takes.length ? <RotateCcw className="size-4" /> : <Sparkles className="size-4" />}{" "}
            {takes.length ? "Make 3 new takes" : "Make 3 takes"}
          </Button>
        </div>
        {latest && (
          <section aria-labelledby="voice-takes" className="pt-4">
            <h3 id="voice-takes" className="mb-1 font-heading text-[22px]">
              Takes
            </h3>
            {latest.request.params?.voiceDescription && <p className="mb-3 text-[13px] text-pretty text-muted-foreground">{latest.request.params.voiceDescription}</p>}
            <ul className="grid gap-2 md:grid-cols-3">
              {takes.map((g, i) => (
                <Take key={g.id} g={g} index={i} description={description} line={line} canSave={!visitor} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </ToolShell>
  );
}
