"use client";

import { ArrowRight, FileText, Link2, ListChecks, Loader2, Sparkles, Upload, Wand2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useEdgeFade } from "@/components/studio/use-edge-fade";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { useEngine, useIsOwner } from "@/lib/api";
import { GENRE_IDEAS, GENRES, MAX_IDEA, MAX_SCRIPT, wordCount, youtubeKind, YOUTUBE_ERROR, type FacelessGenre } from "@/lib/catalog/faceless";
import { starterShown, type StarterCardData } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { ChannelCard, EmptyChannels } from "./cards";
import { useChannels, useCreateChannel } from "./hooks";

/** The pasted or uploaded script travels to the new channel's first episode in this tab. */
export const pendingScriptKey = (channelId: string) => `fuobe.faceless.script.${channelId}`;

const STEPS = [
  { icon: Sparkles, title: "Describe the channel", text: "A genre and an idea. The name and the look come with it." },
  { icon: ListChecks, title: "Pick a topic", text: "From suggestions, or your own — then the length, style and narrator." },
  { icon: Wand2, title: "Review and render", text: "Edit the script scene by scene, render, then fix any scene in the timeline." },
];

/** starters: the ready channels (src/lib/starters/catalog.ts): first while you have no channels, one row under yours after. */
export function FacelessHome({ starters: given = [] }: { starters?: StarterCardData[] }) {
  const { starters } = useStarters("faceless", given);
  const router = useRouter();
  const [engine, setEngine] = useEngine();
  const [genre, setGenre] = useState<FacelessGenre>("education");
  const [idea, setIdea] = useState("");
  const [reference, setReference] = useState("");
  const [refError, setRefError] = useState("");
  const [script, setScript] = useState<{ name: string; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const create = useCreateChannel();
  const channels = useChannels();
  const ideaId = useId();
  const refId = useId();
  const g = GENRES.find((x) => x.id === genre)!;
  const [genreRow, genreFade] = useEdgeFade<HTMLDivElement>();
  const [ideaRow, ideaFade] = useEdgeFade<HTMLDivElement>();
  const owner = useIsOwner();
  const hasChannels = !!channels.data?.length;
  // Until the viewer is known to be the owner, only starters with their real cover show (StarterSection).
  const readyShown = starters.some((s) => starterShown(s, !owner));

  const checkRef = (v: string) => {
    const bad = v.trim() && !youtubeKind(v);
    setRefError(bad ? YOUTUBE_ERROR : "");
    return !bad;
  };

  const submit = () => {
    if (!idea.trim()) return void toast("Describe the channel first", { id: "faceless-blocker" });
    if (!checkRef(reference)) return;
    create.mutate(
      { idea: idea.trim(), genre, engine, ...(reference.trim() && { reference: reference.trim() }) },
      {
        onSuccess: (c) => {
          if (script) {
            try {
              sessionStorage.setItem(pendingScriptKey(c.id), script.text);
            } catch {}
          }
          router.push(`/faceless/${c.id}/new`);
        },
        onError: (e) => toastError(e),
      },
    );
  };

  return (
    <div className="flex min-h-content min-w-0 flex-col">
      <header className="max-md:sticky top-chrome z-20 flex h-14 items-center gap-2 bg-background/85 px-4 backdrop-blur sm:px-6">
        <h1 className="truncate font-heading text-[22px] leading-none">Faceless Studio</h1>
        <div className="ml-auto">
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
        <PhoneNavButton />
      </header>
      <div className="mx-auto w-full max-w-[1240px] min-w-0 flex-1 space-y-12 px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-[760px] pt-[6vh] text-center sm:pt-[9vh]">
          <h2 className="font-heading text-display text-balance">Create your Faceless channel</h2>
          <p className="mx-auto mt-2 max-w-[560px] text-body text-muted-foreground">A narrated, illustrated show — scripts, voice-over, animation, music and subtitles — with the same look in every episode.</p>

          <div className="mt-7 rounded-[20px] border bg-background p-3 text-left shadow-soft transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint sm:rounded-composer sm:p-4">
            <div ref={genreRow} style={genreFade} role="radiogroup" aria-label="Genre" onKeyDown={radioKeys} className="scrollbar-none flex gap-1 overflow-x-auto">
              {GENRES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={genre === x.id}
                  tabIndex={radioTab(genre === x.id)}
                  onClick={() => setGenre(x.id)}
                  className={cn(
                    "h-8 shrink-0 rounded-full px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    genre === x.id ? "bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <p className="px-1 pt-1.5 text-[12px] text-muted-foreground">{g.hint}</p>
            <label htmlFor={ideaId} className="sr-only">
              Channel idea
            </label>
            <textarea
              id={ideaId}
              value={idea}
              maxLength={MAX_IDEA}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="Channel idea, e.g. “Channel about survival in the wild”"
              className="mt-2 w-full resize-none bg-transparent px-1 text-body leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle-foreground"
            />
            <div ref={ideaRow} style={ideaFade} className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {GENRE_IDEAS[genre].map((ex) => (
                <button key={ex} type="button" onClick={() => setIdea(ex)} className="h-7 shrink-0 rounded-full bg-secondary px-2.5 text-[12px] text-secondary-foreground hover:bg-accent">
                  {ex.replace(/^Channel (about|with) /, "")}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-3">
              <div className="flex h-8 min-w-0 flex-1 basis-56 items-center gap-1.5 rounded-full bg-secondary px-3">
                <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                <label htmlFor={refId} className="sr-only">
                  Reference (YouTube link)
                </label>
                <input
                  id={refId}
                  value={reference}
                  onChange={(e) => {
                    setReference(e.target.value);
                    if (refError) checkRef(e.target.value);
                  }}
                  onBlur={() => checkRef(reference)}
                  placeholder="Reference: a YouTube channel, video or playlist"
                  aria-invalid={!!refError}
                  aria-describedby={refError ? `${refId}-err` : undefined}
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
                />
              </div>
              {script ? (
                <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-brand-faint pr-1 pl-3 text-[13px] font-medium text-brand-text">
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {script.name} · {wordCount(script.text)} words
                  </span>
                  <button type="button" onClick={() => setScript(null)} className="grid size-6 place-items-center rounded-full hover:bg-brand-faint-hover" aria-label="Remove the script">
                    <X className="size-3.5" />
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => file.current?.click()} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium hover:bg-accent">
                  <Upload className="size-3.5" /> Upload script
                </button>
              )}
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
                  if (!text) return void toast.error("That file is empty");
                  setScript({ name: f.name, text });
                }}
              />
              <Button onClick={submit} disabled={create.isPending} className="ml-auto h-9 rounded-full px-4">
                {create.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                {create.isPending ? "Creating…" : "Next"}
              </Button>
            </div>
            {refError && (
              <p id={`${refId}-err`} role="alert" className="px-1 pt-2 text-[12px] text-destructive">
                {refError}
              </p>
            )}
          </div>
        </div>

        {!channels.isLoading && !hasChannels && <StarterSection surface="faceless" starters={given} />}

        {(channels.isLoading || hasChannels || !readyShown) && (
          <section aria-labelledby="channels-title" className="space-y-4">
            <h2 id="channels-title" className="font-heading text-[24px]">
              My channels
            </h2>
            {channels.isLoading ? (
              <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i}>
                    <Skeleton className="aspect-video rounded-xl" />
                    <Skeleton className="mt-3 h-4 w-2/3" />
                  </div>
                ))}
              </div>
            ) : channels.data?.length ? (
              <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
                {channels.data.map((c) => (
                  <ChannelCard key={c.id} channel={c} />
                ))}
              </div>
            ) : (
              <EmptyChannels />
            )}
          </section>
        )}

        {hasChannels && <StarterSection surface="faceless" starters={given} row />}

        <section aria-label="How it works" className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex gap-3 rounded-2xl bg-muted/50 p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-background text-brand-text shadow-soft">
                <s.icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{s.text}</p>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
