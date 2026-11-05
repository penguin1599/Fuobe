"use client";

import { ArrowUp, Bot, Check, ClipboardPaste, FileText, Loader2, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { directorSummary, moveBySlug, type CinemaProject, type DirectorMessage, type DirectorSettings, type DirectorShot } from "@/lib/catalog/cinema";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { useIsOwner } from "@/lib/api";
import { toastError } from "@/lib/refusals";
import { useAutosave, useDirectorChat, useUpdateProject } from "./hooks";

const SUGGESTIONS = ["Write a script", "Generate an 8-shot storyboard for a sci-fi chase scene", "Create a 15-second cinematic perfume commercial"];

function ShotCard({ shot, onLoad }: { shot: DirectorShot; onLoad: (s: DirectorShot) => void }) {
  const look = directorSummary(shot.settings as DirectorSettings);
  return (
    <div className="space-y-1.5 rounded-xl border bg-background p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium">{shot.title}</p>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{shot.duration}s</span>
      </div>
      <p className="text-[12.5px] leading-snug text-muted-foreground">{shot.prompt}</p>
      {(shot.moves.length > 0 || look.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {shot.moves.map((m, i) => (
            <span key={`${m}-${i}`} className="rounded-full bg-brand-faint px-1.5 py-px text-[10.5px] font-medium text-brand-text">
              #{moveBySlug(m)?.name ?? m}
            </span>
          ))}
          {look.slice(0, 5).map((l) => (
            <span key={l} className="rounded-full bg-secondary px-1.5 py-px text-[10.5px] text-muted-foreground">
              {l}
            </span>
          ))}
        </div>
      )}
      <Button size="sm" variant="secondary" className="w-full" onClick={() => onLoad(shot)}>
        <ClipboardPaste /> Load into prompt bar
      </Button>
    </div>
  );
}

function Message({ m, onLoad, onBrief }: { m: DirectorMessage; onLoad: (s: DirectorShot) => void; onBrief: (b: string) => void }) {
  // Connecting an AI helper is the owner's (Settings): nobody else is told about it.
  const owner = useIsOwner();
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-[13.5px] leading-snug whitespace-pre-wrap">{m.text}</p>
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-faint text-brand-text">
          <Bot className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{m.text}</p>
          {m.source === "offline" && owner && <p className="mt-0.5 text-[11px] text-muted-foreground">Offline breakdown — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings for a smarter Director.</p>}
        </div>
      </div>
      {m.brief && (
        <div className="ml-8 space-y-2 rounded-xl border bg-background p-2.5">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Proposed brief</p>
          <p className="text-[12.5px] leading-snug whitespace-pre-wrap">{m.brief}</p>
          <Button size="sm" variant="secondary" className="w-full" onClick={() => onBrief(m.brief!)}>
            <FileText /> Use as project brief
          </Button>
        </div>
      )}
      {m.shots?.length ? (
        <div className="ml-8 space-y-2">
          {m.shots.map((s, i) => (
            <ShotCard key={i} shot={s} onLoad={onLoad} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DirectorChat({ projectId, onLoadShot, onBrief, promptText }: { projectId: string; onLoadShot: (s: DirectorShot) => void; onBrief: (b: string) => void; promptText: string }) {
  const { messages, ask, clear } = useDirectorChat(projectId);
  // Only the owner's Director can use an AI helper (a visitor's writes its breakdown without one).
  const owner = useIsOwner();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, ask.isPending]);
  const send = (t = text) => {
    const v = t.trim();
    if (!v || ask.isPending) return;
    setText("");
    ask.mutate(v, { onError: (e) => toastError(e) });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {!messages.length && (
          <div className="space-y-3 pt-4">
            <p className="font-heading text-[22px] leading-tight">Your AI Director</p>
            <p className="text-[13px] text-muted-foreground">Ask it to pick the camera, light the scene, write the prompt, or break a script into shots. It only proposes — nothing renders until you press Generate.</p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="rounded-xl border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} onLoad={onLoadShot} onBrief={onBrief} />
        ))}
        {ask.isPending && (
          <div className="flex items-center gap-2 pl-1">
            <span className="grid size-6 place-items-center rounded-full bg-brand-faint text-brand-text">
              <Sparkles className="size-3.5" />
            </span>
            <span className="shimmer-text animate-shimmer-text text-[13px] font-medium">Directing…</span>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t p-2.5">
        <div className="rounded-2xl border bg-background p-1.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-brand-faint">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask AI Director anything, or paste a script"
            className="field-sizing-content max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1 text-[13.5px] outline-none placeholder:text-subtle-foreground"
            aria-label="Message the AI Director"
          />
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={() => setText((t) => (t ? `${t}\n${promptText}` : promptText))} disabled={!promptText.trim()} className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
                  <ClipboardPaste className="size-3.5" /> Get from prompt box
                </button>
              </TooltipTrigger>
              <TooltipContent>Paste the prompt bar&apos;s text here</TooltipContent>
            </Tooltip>
            {messages.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={() => void clear()} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear the conversation">
                    <Trash2 className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Clear the conversation</TooltipContent>
              </Tooltip>
            )}
            <Button size="icon" className="ml-auto size-8 rounded-full" onClick={() => send()} disabled={!text.trim() || ask.isPending} aria-label="Send">
              {ask.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>
        <p className="px-1 pt-1.5 text-[10.5px] text-muted-foreground">{owner && "LLMs can make mistakes. "}The Director only proposes: nothing runs and nothing is spent until you press Generate.</p>
      </div>
    </div>
  );
}

/**
 * The production's rules: tone, references, do's and don'ts. Prepended to every compiled prompt.
 * Autosaves 0.7 s after typing stops, and at once when the panel closes, the tab switches to the
 * AI Director or the page goes away, so the last words are never lost.
 */
function Brief({ project }: { project: CinemaProject }) {
  const update = useUpdateProject(project.id);
  const [title, setTitle] = useState(project.brief.title);
  const [body, setBody] = useState(project.brief.body);
  const [state, setState] = useState<"saved" | "saving" | "dirty">("saved");
  const saver = useAutosave<{ title: string; body: string }>((brief, { keepalive }) => {
    setState("saving");
    update.mutate({ brief, keepalive }, { onSuccess: () => setState("saved"), onError: (e) => (setState("dirty"), toastError(e)) });
  }, 700);
  const save = (t: string, b: string) => {
    setState("dirty");
    saver.schedule({ title: t, body: b });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Input value={title} onChange={(e) => (setTitle(e.target.value), save(e.target.value, body))} placeholder="Brief title" className="h-9 font-heading text-[18px]" aria-label="Brief title" />
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground" aria-live="polite">
          {state === "saving" ? <Loader2 className="size-3 animate-spin" /> : state === "saved" ? <Check className="motion-confirm size-3" /> : null}
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Editing"}
        </span>
      </div>
      <textarea
        value={body}
        onChange={(e) => (setBody(e.target.value), save(title, e.target.value))}
        placeholder={"This brief is empty.\n\nSet the rules of the production: tone, references, do's and don'ts. Every prompt in this project — and the AI Director — works from it."}
        className="min-h-0 flex-1 resize-none rounded-xl border bg-background p-3 text-[13.5px] leading-relaxed outline-none placeholder:text-subtle-foreground focus:border-primary focus:ring-4 focus:ring-brand-faint"
        aria-label="Brief"
      />
      <p className="text-[11.5px] text-muted-foreground">Prepended to every prompt this project sends (trimmed to about 900 characters).</p>
    </div>
  );
}

export function SidePanel({
  project,
  tab,
  setTab,
  onClose,
  onLoadShot,
  promptText,
}: {
  project: CinemaProject;
  tab: "director" | "brief";
  setTab: (t: "director" | "brief") => void;
  onClose: () => void;
  onLoadShot: (s: DirectorShot) => void;
  promptText: string;
}) {
  const update = useUpdateProject(project.id);
  // A brief applied from the Director replaces what the editor shows.
  const [briefVersion, setBriefVersion] = useState(0);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2.5">
        <TabRow role="tablist" aria-label="Panel" fade={false}>
          {(
            [
              ["director", "AI Director", Bot],
              ["brief", "Project brief", FileText],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={TAB_PILL}
              {...onAttr(tab === id)}
            >
              <Icon aria-hidden />
              {label}
            </button>
          ))}
        </TabRow>
        <button type="button" onClick={onClose} className="ml-auto grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close panel">
          <X className="size-4" />
        </button>
      </div>
      {tab === "director" ? (
        <DirectorChat
          projectId={project.id}
          onLoadShot={onLoadShot}
          promptText={promptText}
          onBrief={(b) =>
            update.mutate(
              { brief: { body: b } },
              {
                onSuccess: () => {
                  setBriefVersion((v) => v + 1);
                  toast.success("Brief updated", { duration: 1500, action: { label: "Open", onClick: () => setTab("brief") } });
                },
                onError: (e) => toastError(e),
              },
            )
          }
        />
      ) : (
        <Brief key={briefVersion} project={project} />
      )}
    </div>
  );
}
