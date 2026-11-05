"use client";

import { ArrowLeft, ArrowRight, Check, FileText, Loader2, RefreshCw, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { NotFoundState } from "@/components/empty-state";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useEngine, useIsOwner } from "@/lib/api";
import {
  defaultVoice,
  FACELESS_STYLE_IDS,
  genreInfo,
  MAX_SCRIPT,
  MAX_TOPIC,
  splitScript,
  wordCount,
  type EpisodeSettings,
  type PickerData,
  type TopicIdea,
} from "@/lib/catalog/faceless";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { ChannelAvatar } from "./cards";
import { EstimateLine, Section, Segmented, ToggleRow } from "./controls";
import { pendingScriptKey } from "./faceless-home";
import { suggestTopics, useChannel, useCreateEpisode, useEstimate } from "./hooks";
import { EpisodeSettingsForm } from "./settings-form";

function Steps({ step }: { step: 1 | 2 }) {
  const items = ["Topic", "Video settings", "Review the script"];
  return (
    <ol className="flex items-center gap-2 text-[12px] font-medium" aria-label="Steps">
      {items.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "next";
        return (
          <li key={label} className="flex min-w-0 items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            {i > 0 && <span className="h-px w-4 bg-border sm:w-8" aria-hidden />}
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-[11px]",
                state === "done" ? "bg-primary text-primary-foreground" : state === "current" ? "bg-brand-faint text-brand-text" : "bg-muted text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3" /> : n}
            </span>
            <span className={cn("truncate", state === "next" ? "hidden text-muted-foreground sm:inline" : state === "done" ? "hidden sm:inline" : "")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * New episode: a topic (suggested or your own), the video settings and the script source; then the script is written for review.
 * initialTopic: a ready channel's first topic (its starter), in "Or write your own".
 */
export function EpisodeWizard({ channelId, picker, initialTopic }: { channelId: string; picker: PickerData; initialTopic?: string }) {
  const router = useRouter();
  const { data, error } = useChannel(channelId);
  const [engine, setEngine] = useEngine();
  const create = useCreateEpisode();
  const [step, setStep] = useState<1 | 2>(1);
  const [topics, setTopics] = useState<TopicIdea[] | null>(null);
  const [offline, setOffline] = useState(false);
  // Suggestions written offline say how to get fresher ones: the studio's AI helper, which only its owner sets up.
  const owner = useIsOwner();
  const [round, setRound] = useState(0);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [own, setOwn] = useState(initialTopic ?? "");
  const [scriptMode, setScriptMode] = useState<"ai" | "pasted">("ai");
  const [script, setScript] = useState("");
  const [draft, setDraft] = useState<EpisodeSettings | null>(null);
  // The first episode sets the channel's look; later ones only when ticked.
  const [saveLook, setSaveLook] = useState<boolean | null>(null);
  const keepLook = saveLook ?? data?.episodes.length === 0;
  const file = useRef<HTMLInputElement>(null);
  const ownId = useId();
  const scriptId = useId();
  const channel = data?.channel;
  const genre = genreInfo(channel?.genre);

  // Start from the channel's saved look and sound (once the channel has loaded), and the script uploaded with it.
  const [startedFor, setStartedFor] = useState<string | null>(null);
  if (channel && startedFor !== channel.id) {
    setStartedFor(channel.id);
    const s = channel.settings;
    setDraft({ ...s, styleRefs: s.styleRefs ?? [], elements: [], engine });
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(pendingScriptKey(channel.id));
    } catch {}
    if (pending) {
      setScript(pending);
      setScriptMode("pasted");
    }
  }
  useEffect(() => {
    if (!startedFor) return;
    try {
      sessionStorage.removeItem(pendingScriptKey(startedFor));
    } catch {}
  }, [startedFor]);

  // The engine follows the header switch; a premade voice doesn't exist on the open engine.
  const settings = useMemo<EpisodeSettings | null>(() => {
    if (!draft) return null;
    const voice = engine === "open" && draft.voice?.kind === "preset" ? null : engine === "cloud" && !draft.voice ? defaultVoice("cloud", genre) : draft.voice;
    return { ...draft, engine, voice, videoModel: draft.engine === engine ? draft.videoModel : undefined, resolution: draft.engine === engine ? draft.resolution : undefined };
  }, [draft, engine, genre]);

  // Every topic shown so far: "Generate new" asks for others.
  const shown = useRef<string[]>([]);
  const loadTopics = async (r: number) => {
    setLoadingTopics(true);
    try {
      const res = await suggestTopics({ channelId, engine, round: r, avoid: shown.current.slice(-30) });
      shown.current = [...new Set([...shown.current, ...res.topics.map((t) => t.title)])];
      setTopics(res.topics);
      setOffline(res.offline);
      setPicked(null);
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingTopics(false);
    }
  };
  const asked = useRef(false);
  useEffect(() => {
    if (!channel || asked.current) return;
    asked.current = true;
    void loadTopics(0);
    // Once, when the channel arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  const topic = own.trim() || topics?.find((t) => t.title === picked)?.title || "";
  const pastedBlocks = scriptMode === "pasted" && script.trim() ? splitScript(script) : undefined;
  const estimate = useEstimate(settings && step === 2 ? { kind: "faceless", settings, genre: genre.id, ...(pastedBlocks && { blocks: pastedBlocks }) } : null);

  if (error && /not found/i.test((error as Error).message)) return <NotFoundState title="This channel doesn't exist" />;

  // Next waits for a topic (or a pasted script); the line beside it says so and takes you to the topics.
  const ready = !!topic || (scriptMode === "pasted" && !!script.trim());
  const focusTopics = () => {
    const el = document.querySelector<HTMLElement>('[aria-label="Suggested topics"] [role="radio"][tabindex="0"]') ?? document.getElementById(ownId);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  };
  const next = () => {
    if (!ready) return void toast("Pick a topic, or write your own", { id: "faceless-blocker" });
    setStep(2);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const write = () => {
    if (!settings) return;
    if (scriptMode === "pasted" && !script.trim()) return void toast("Paste your script, or let it be written for you", { id: "faceless-blocker" });
    if (settings.engine === "open" && settings.voice?.kind !== "sample" && estimate.data?.error) return void toast(estimate.data.error, { id: "faceless-blocker" });
    create.mutate(
      { channelId, topic: topic || script.trim().slice(0, 120), script: scriptMode === "pasted" ? script : undefined, settings, saveLook: keepLook },
      {
        onSuccess: (ep) => router.push(`/faceless/${channelId}/${ep.id}`),
        onError: (e) => toastError(e),
      },
    );
  };

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <Link href={`/faceless/${channelId}`} className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4 shrink-0" />
          <span className="truncate">{channel?.name ?? "Channel"}</span>
        </Link>
        <div className="ml-auto">
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full max-w-[920px] min-w-0 flex-1 px-4 pb-32 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <Steps step={step} />
        </div>
        {!channel || !settings ? (
          <div className="space-y-3 pt-8">
            <Skeleton className="h-9 w-80 max-w-full" />
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          </div>
        ) : step === 1 ? (
          <div className="space-y-6 pt-6">
            <div className="flex items-center gap-3">
              <ChannelAvatar channel={channel} />
              <div className="min-w-0">
                <h1 className="font-heading text-[30px] leading-tight text-balance">{data.episodes.length ? "Choose the next episode's topic" : "Choose topic of the first episode"}</h1>
                <p className="text-[13px] text-muted-foreground">
                  {genre.label} · {genre.hint}
                </p>
              </div>
            </div>

            <section aria-label="Topic suggestions" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={cn("text-[13px] text-muted-foreground", loadingTopics && "shimmer-text animate-shimmer-text")}>{loadingTopics ? "Writing topic suggestions…" : offline && owner ? "Suggestions written offline — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings for fresher ones." : "Tick one, or write your own below."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingTopics}
                  onClick={() => {
                    const r = round + 1;
                    setRound(r);
                    void loadTopics(r);
                  }}
                >
                  <RefreshCw className={cn(loadingTopics && "animate-spin")} /> Generate new topic suggestions
                </Button>
              </div>
              <div role="radiogroup" aria-label="Suggested topics" onKeyDown={radioKeys} className="grid gap-2.5 sm:grid-cols-2">
                {loadingTopics && !topics
                  ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)
                  : topics?.map((t, i) => {
                      const on = picked === t.title && !own.trim();
                      const anyOn = !!picked && !own.trim() && topics.some((x) => x.title === picked);
                      return (
                        <button
                          key={t.title}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          tabIndex={radioTab(anyOn ? on : i === 0)}
                          onClick={() => {
                            setPicked(t.title);
                            setOwn("");
                          }}
                          className={cn(
                            "flex min-w-0 items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            on ? "border-primary ring-2 ring-brand-faint" : "hover:border-border-strong",
                            loadingTopics && "opacity-60",
                          )}
                        >
                          <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-border-strong")}>{on && <Check className="size-3" />}</span>
                          <span className="min-w-0">
                            <span className="block text-[14px] leading-snug font-medium">{t.title}</span>
                            {t.hook && <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{t.hook}</span>}
                          </span>
                        </button>
                      );
                    })}
              </div>
            </section>

            <section className="space-y-2">
              <label htmlFor={ownId} className="text-[13px] font-medium">
                Or write your own
              </label>
              <div className="rounded-2xl border bg-background p-3 transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint">
                <textarea
                  id={ownId}
                  value={own}
                  maxLength={MAX_TOPIC}
                  onChange={(e) => setOwn(e.target.value)}
                  rows={3}
                  placeholder="What is the episode about? e.g. “How Roman roads were built, and why some still stand”"
                  className="w-full resize-none bg-transparent text-body outline-none [field-sizing:content] placeholder:text-subtle-foreground"
                />
                <p className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                  {own.length.toLocaleString()} / {MAX_TOPIC.toLocaleString()}
                </p>
              </div>
            </section>
          </div>
        ) : (
          <div className="space-y-8 pt-6">
            <div>
              <h1 className="font-heading text-[30px] leading-tight text-balance">Video settings</h1>
              <p className="mt-1 line-clamp-2 text-[14px] text-muted-foreground">{topic || "Your script"}</p>
            </div>

            <Section title="Script">
              <Segmented
                label="Script"
                value={scriptMode}
                options={[
                  { value: "ai", label: "Write it for me" },
                  { value: "pasted", label: "Use my script" },
                ]}
                onChange={setScriptMode}
              />
              {scriptMode === "pasted" && (
                <div className="rounded-2xl border bg-background p-3 transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint">
                  <label htmlFor={scriptId} className="sr-only">
                    Your script
                  </label>
                  <textarea
                    id={scriptId}
                    value={script}
                    maxLength={MAX_SCRIPT}
                    onChange={(e) => setScript(e.target.value)}
                    rows={8}
                    placeholder="Paste the narration. It's split into scenes of about 10 seconds; you can edit them before rendering."
                    className="max-h-[50vh] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle-foreground"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button type="button" onClick={() => file.current?.click()} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] font-medium hover:bg-accent">
                      <Upload className="size-3.5" /> Upload .txt
                    </button>
                    <input
                      ref={file}
                      type="file"
                      accept=".txt,.md,text/plain,text/markdown"
                      hidden
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        const text = (await f.text()).trim();
                        if (text.length > MAX_SCRIPT) return void toast.error("That script is too long to narrate. Shorten it and try again.");
                        setScript(text);
                      }}
                    />
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {wordCount(script)} words · {script.length.toLocaleString()} / {MAX_SCRIPT.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
              {scriptMode === "ai" && <p className="text-[12px] text-muted-foreground">The script is written for this channel, paced for the length you pick. You review every scene before anything renders.</p>}
            </Section>

            <EpisodeSettingsForm kind="faceless" value={settings} onChange={(p) => setDraft((d) => ({ ...d!, ...p, engine }))} picker={picker} styleIds={FACELESS_STYLE_IDS} />

            <div className="rounded-xl border p-3">
              <ToggleRow
                label="Save as the channel's look"
                hint="New episodes start with this style, narrator, format and music. Leave it off to try something just for this episode."
                checked={keepLook}
                onChange={setSaveLook}
              />
            </div>
          </div>
        )}
      </div>

      {channel && settings && (
        <div className="sticky bottom-chrome z-20 border-t bg-background/90 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto flex w-full max-w-[920px] min-w-0 flex-wrap items-center gap-3 px-4 pt-3 sm:px-6">
            {step === 2 ? (
              <>
                <Button variant="ghost" onClick={() => setStep(1)}>
                  <ArrowLeft /> Topic
                </Button>
                <EstimateLine data={estimate.data} loading={estimate.isFetching} engine={engine} className="min-w-0 flex-1" />
                <Button onClick={write} disabled={create.isPending} className="rounded-full">
                  {create.isPending ? <Loader2 className="animate-spin" /> : scriptMode === "pasted" ? <FileText /> : <Sparkles />}
                  {scriptMode === "pasted" ? "Split into scenes" : "Write the script"}
                </Button>
              </>
            ) : (
              <>
                {ready ? (
                  <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{topic ? `Topic: ${topic}` : "Your script is ready to split"}</p>
                ) : (
                  <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                    <button type="button" onClick={focusTopics} className="underline decoration-border-strong underline-offset-2 hover:text-foreground hover:decoration-current">
                      Pick a topic to continue
                    </button>
                  </p>
                )}
                <Button onClick={next} disabled={!ready} className="rounded-full">
                  Next <ArrowRight />
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
