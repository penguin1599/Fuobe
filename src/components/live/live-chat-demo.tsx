"use client";

import { ArrowLeftRight, ArrowRight, ArrowUp, Check, Cpu, Hash, RotateCcw, Zap } from "lucide-react";
import { IntentLink } from "@/components/intent-link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { changeLog, changesWord, markAt, pendingWords, sentence, stops, wordsIn } from "@/lib/live/demo";
import { cn } from "@/lib/utils";
import { authorOf, CHAT_CREW, type Person, YOU, YOUR_TURN } from "./live-crew";
import { CompareLabels, createKeyBus, DemoPicture, useDemoPlayer } from "./live-demo";
import { Sentence } from "./live-sentence";

/**
 * The recorded live edit session as a room. On the left, the picture and, under it, the one sentence everyone writes:
 * each change in its author's colour, a dot over each letter a live frame was drawn at, and the author's flag on the
 * caret while the picture follows their words. On the right, the room's rolling chat: people join, whoever types
 * decides the next edit, and their message carries the change it made. The sixth change is the visitor's: their own
 * keys type it (a tap types a word), and it types itself if they don't. It plays once and rests on the last picture;
 * then the visitor drags back through the words and every picture of the session comes back, sharp, because each is
 * that much of the sentence drawn on the original. Same file and steps as LiveDemo (useDemoPlayer): no GPU, no requests
 * beyond the files. The chat keeps every round until a reload. Under reduced motion it starts at rest on the last
 * picture, with the whole chat.
 */

export { CHAT_CREW };

/** Rows kept in the chat: the ones above have rolled out of view under the fade by then. */
const KEEP = 9;

export type ChatRow =
  | { key: string; kind: "join"; who: Person }
  | { key: string; kind: "round"; round: number }
  | { key: string; kind: "message"; who: Person; n: number; words: string; frame: string | null };

/**
 * The chat so far, every round since the page loaded: it only starts over on a reload. You are in from the start,
 * everyone else joins just before their first change (once: they stay for the rounds after), and each new round opens
 * with a line saying the picture went back to the original. A change shows as its author types it, unless it is
 * yours: that is typed in your box, and lands once it settles. `frame` is null while the change is still being typed.
 */
export function chatRows(log: { words: string; frame: string }[], round: number, done: number, typing: string): { rows: ChatRow[]; here: Person[] } {
  const rows: ChatRow[] = [{ key: "join-you", kind: "join", who: YOU }];
  const here = new Map([[YOU.id, YOU]]);
  for (let r = 0; r <= round; r++) {
    if (r > 0) rows.push({ key: `round-${r}`, kind: "round", round: r });
    const last = r < round ? log.length - 1 : Math.min(done, log.length - 1);
    for (let i = 0; i <= last; i++) {
      const who = authorOf(i);
      if (!here.has(who.id)) {
        here.set(who.id, who);
        rows.push({ key: `join-${who.id}`, kind: "join", who });
      }
      const settled = r < round || i < done;
      if (settled || (typing && who !== YOU)) rows.push({ key: `${r}-m-${i}`, kind: "message", who, n: i + 1, words: settled ? log[i].words : typing, frame: settled ? log[i].frame : null });
    }
  }
  return { rows, here: [...here.values()] };
}

/** After the first round, the caret goes back through the words once by itself and returns, to show it can. */
const SHOW_BACK_MS = 1400;
const SHOW_STEP_MS = 140;

export function LiveChatDemo({ className }: { className?: string }) {
  const [keys] = useState(createKeyBus);
  const player = useDemoPlayer({ once: true, keyChange: YOUR_TURN, keys });
  const { box, demo, v, round, ended, mode, visible, reduced, src, show, replay } = player;
  const log = useMemo(() => (demo ? changeLog(demo) : []), [demo]);
  const s = useMemo(() => (demo ? sentence(demo) : null), [demo]);
  const markOf = useMemo(() => new Map((s?.marks ?? []).map((m) => [m.frame, m])), [s]);
  const liveFrames = useMemo(() => log.map((_, i) => (s?.marks ?? []).filter((m) => m.live && m.change === i).length), [log, s]);

  const playing = mode === "play" && !reduced;
  /** Where the visitor left the caret at rest; null is the whole sentence. */
  const [restAt, setRestAt] = useState<number | null>(null);
  /** Once the visitor has taken the caret, it never moves by itself. */
  const touched = useRef(false);
  const caret = playing ? (v?.typed.length ?? 0) : (restAt ?? s?.text.length ?? 0);

  const done = reduced ? log.length : Math.min(v?.changes ?? 0, log.length);
  const typing = playing && v ? pendingWords(log, v.typed, v.changes) : "";
  /** The compare is up: as it plays, and after it, when the line stays for the visitor to drag. */
  const comparing = !reduced && !!v && v.compare !== null;
  /** What the visitor typed in the box once the round was over: it needs a GPU to draw, so the box says where to get one. */
  const [ask, setAsk] = useState<string | null>(null);
  /** Whoever is making the change now, once a change is under way. */
  const current = playing && done < log.length ? authorOf(done) : null;
  const yourTurn = current === YOU;
  const { rows, here: people } = chatRows(log, reduced ? 0 : round, done, typing);

  /** The picture on screen, and which words it was drawn for. */
  const frame = reduced && s ? markAt(s.marks, caret).frame : (v?.frame ?? null);
  const mark = frame ? markOf.get(frame) : undefined;
  const words = s && mark ? wordsIn(s.text, mark.at) : 0;
  const stage = comparing ? "Before and after" : !mark || mark.at === 0 ? "Original" : mark.live ? "Live frame" : "Full quality";

  const seek = useCallback(
    (at: number, byVisitor = true) => {
      if (!s) return;
      if (byVisitor) touched.current = true;
      setRestAt(at);
      show(markAt(s.marks, at).frame, "fade");
    },
    [s, show],
  );

  // The visitor's turn: any key types the next letter of their change (not while they are typing somewhere else).
  useEffect(() => {
    if (!yourTurn || !visible) return;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      keys.press();
    };
    window.addEventListener("keydown", on);
    return () => {
      window.removeEventListener("keydown", on);
      keys.clear();
    };
  }, [yourTurn, visible, keys]);

  // At the end of the first round, show once that the words can be gone back through: back to the original, and on.
  // Not while the compare line is still up: it stays for the visitor to drag, until they go back through the words.
  useEffect(() => {
    if (ended !== 1 || touched.current || !s || reduced || comparing) return;
    const at = stops(s.marks);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = SHOW_BACK_MS;
    const path = [...at.slice(0, -1).reverse(), ...at.slice(1)];
    path.forEach((n, k) => {
      timers.push(setTimeout(() => !touched.current && seek(n, false), t));
      t += k === at.length - 2 ? 900 : SHOW_STEP_MS;
    });
    return () => timers.forEach(clearTimeout);
  }, [ended, s, reduced, seek, comparing]);

  const again = () => {
    setRestAt(null);
    setAsk(null);
    replay();
  };
  const tapWord = () => {
    if (!s) return;
    const end = s.clauses[YOUR_TURN]?.end ?? caret;
    const word = s.text.slice(caret, end).match(/^[\s,]*\S+/)?.[0].length ?? 1;
    keys.press(word);
  };

  return (
    <div className={cn("grid overflow-hidden rounded-2xl bg-card ring-1 ring-border shadow-strong md:grid-cols-[minmax(0,1fr)_minmax(17rem,36%)]", className)} data-live-chat>
      <div className="flex min-w-0 flex-col">
        <div ref={box} className="@container relative isolate aspect-[4/3] min-w-0 overflow-hidden bg-media text-white" data-live-demo>
          {reduced && frame ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src(frame)} alt="A live edit: the picture changing as the words are typed" className="absolute inset-0 size-full object-cover" draggable={false} />
          ) : (
            <DemoPicture {...player} />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-black/0 to-black/25" />
          {/* The typer's name rides the edge of each live frame as it is drawn across. */}
          {playing && v?.sweep && mark?.live && (
            <span key={`f-${v.frame}`} className="pointer-events-none absolute inset-0 opacity-0" style={{ animation: "live-scan 520ms cubic-bezier(.45,0,.55,1)" }} aria-hidden>
              <span className={cn("absolute top-[14%] left-0 ml-1.5 rounded-[3px_8px_8px_8px] px-1.5 py-0.5 text-[11px] leading-none font-semibold whitespace-nowrap shadow-[0_2px_8px_rgb(0_0_0/30%)]", authorOf(mark.change).avatar)}>
                {authorOf(mark.change).name}
              </span>
            </span>
          )}
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap backdrop-blur" aria-hidden>
            <span className={cn("size-1.5 rounded-full", stage === "Live frame" ? "bg-emerald-400 motion-safe:animate-pulse" : stage === "Full quality" ? "bg-white" : "bg-white/50")} />
            {stage}
          </span>
          {words > 0 && !comparing && (
            <span className="absolute top-3 right-3 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap tabular-nums backdrop-blur" aria-hidden>
              Original + {words} words
            </span>
          )}
          <CompareLabels v={comparing ? v : null} className="bottom-3" />
        </div>

        {s && (
          <div className="flex flex-1 flex-col border-t border-border px-4 pt-3 pb-4 sm:px-5">
            <div className="mb-1.5 flex min-h-7 items-center justify-between gap-3 text-[12px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {playing ? (
                  yourTurn ? (
                    <>
                      Your turn: <span className="pointer-coarse:hidden">any key types the next letter</span>
                      <span className="hidden pointer-coarse:inline">tap the words to type the next one</span>
                    </>
                  ) : (
                    "One sentence, written as you watch"
                  )
                ) : (
                  "Drag back through the words"
                )}
              </span>
              {!playing && !reduced && (
                <button type="button" onClick={again} className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-foreground ring-1 ring-border transition hover:bg-accent">
                  <RotateCcw className="size-3" />
                  Play again
                </button>
              )}
            </div>
            <Sentence
              text={s.text}
              clauses={s.clauses}
              marks={s.marks}
              authors={log.map((_, i) => authorOf(i))}
              caret={caret}
              playing={playing}
              typer={current}
              yourTurn={yourTurn}
              label={words ? `The picture holds the first ${words} words: ${s.text.slice(0, markAt(s.marks, caret).at)}` : "The original picture"}
              onSeek={(at) => seek(at)}
              onTap={tapWord}
            />
            <p className="mt-auto flex items-center gap-1.5 pt-3 text-[11.5px] text-muted-foreground">
              {playing ? (
                <>
                  <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" />A dot is a live frame, drawn at that letter
                </>
              ) : (
                <>
                  <ArrowLeftRight className="size-3 shrink-0" />
                  Every picture is that much of the sentence, drawn on the original: nothing blurs
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {/* The chat replays a recording, so it is shown, not read out: the summary says what it holds. */}
      <div className="flex h-[340px] min-w-0 flex-col border-t border-border md:h-auto md:border-t-0 md:border-l">
        <p className="sr-only">A recorded session: people in one room take turns typing a change, and the picture follows each one as it is typed, all in one sentence drawn on the original picture.</p>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4" aria-hidden>
          <span className="flex min-w-0 items-center gap-1 text-[13.5px] font-medium">
            <Hash className="size-3.5 shrink-0 text-muted-foreground" />
            live-edit
          </span>
          <span className="flex items-center gap-2">
            <span className="flex -space-x-1.5">
              {people.map((p) => (
                <Avatar key={p.id} who={p} className="size-5 text-[9px] ring-2 ring-card motion-safe:animate-[live-fade_300ms_ease-out]" />
              ))}
            </span>
            <span key={done} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums", done ? "bg-primary text-primary-foreground motion-safe:animate-[live-chip_260ms_ease-out]" : "bg-muted text-muted-foreground")}>
              {changesWord(done)}
            </span>
          </span>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_3.5rem)]" aria-hidden>
          <ol className="absolute inset-x-0 bottom-0 flex flex-col px-4 pb-3">
            {rows.slice(-KEEP).map((r) =>
              r.kind === "join" ? (
                <Roll key={r.key}>
                  <p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <ArrowRight className="size-3 shrink-0 text-emerald-500" />
                    <span>
                      <span className="font-medium text-foreground">{r.who.name}</span> {r.who === YOU ? "joined. Type, and the picture follows" : "joined the edit"}
                    </span>
                  </p>
                </Roll>
              ) : r.kind === "round" ? (
                <Roll key={r.key}>
                  <p className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    Back to the original · round {r.round + 1}
                    <span className="h-px flex-1 bg-border" />
                  </p>
                </Roll>
              ) : (
                <Roll key={r.key}>
                  <Message row={r} picture={r.frame ? src(r.frame) : ""} frames={liveFrames[r.n - 1] ?? 0} />
                </Roll>
              ),
            )}
            {ask && (
              <Roll key={`ask-${ask}`}>
                <div className="flex gap-2.5">
                  <Avatar who={YOU} className="mt-0.5 size-7 text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[12.5px] leading-tight">
                      <span className={cn("font-semibold", YOU.ink)}>{YOU.name}</span>
                      <span className="text-[10.5px] text-muted-foreground">waiting for a GPU</span>
                    </p>
                    <p className="mt-0.5 text-[13px] leading-snug break-words">{ask}</p>
                  </div>
                </div>
              </Roll>
            )}
          </ol>
        </div>

        <div className="shrink-0 px-3 pb-3">
          {ask && <GpuPrompt text={ask} />}
          <p className="flex h-6 min-w-0 items-center gap-1.5 truncate px-1 text-[11.5px] text-muted-foreground" aria-hidden>
            {!playing && !reduced ? (
              "Your turn again: type a change of your own"
            ) : comparing ? (
              `Original against all ${changesWord(done)}`
            ) : typing && current ? (
              <>
                <TypingDots />
                <span className={cn("font-medium", current.ink)}>{current.name}</span>
                {current === YOU ? " are" : " is"} typing, the picture follows
              </>
            ) : yourTurn ? (
              <>
                <TypingDots />
                <span className="font-medium text-primary">Your turn</span>: type anything
              </>
            ) : (
              `${people.length} here · one sentence, on the original`
            )}
          </p>
          {!playing && !reduced ? <OpenComposer onSend={setAsk} /> : <Composer text={yourTurn ? typing : ""} active={yourTurn} />}
        </div>
      </div>
    </div>
  );
}

function Avatar({ who, className }: { who: Person; className?: string }) {
  return <span className={cn("grid shrink-0 place-items-center rounded-full font-semibold", who.avatar, className)}>{who === YOU ? "Y" : who.name[0]}</span>;
}

/** A row grows in from nothing at the bottom, so the ones above roll up rather than jump. */
function Roll({ children }: { children: React.ReactNode }) {
  return (
    <li className="grid motion-safe:animate-[live-roll_420ms_cubic-bezier(.2,.8,.2,1)]">
      <div className="min-h-0 pt-3">{children}</div>
    </li>
  );
}

/** A message: its words as they are typed, then, once the picture settles, the change it made. */
function Message({ row, picture, frames }: { row: Extract<ChatRow, { kind: "message" }>; picture: string; frames: number }) {
  const live = !row.frame;
  return (
    <div className="flex gap-2.5">
      <Avatar who={row.who} className="mt-0.5 size-7 text-[11px]" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[12.5px] leading-tight">
          <span className={cn("font-semibold", row.who.ink)}>{row.who.name}</span>
          {live ? (
            <span className="flex items-center gap-1 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
              live
            </span>
          ) : (
            <span className="text-[10.5px] text-muted-foreground">{frames === 1 ? "1 live frame" : `${frames} live frames`}, then full quality</span>
          )}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug break-words">
          {row.words}
          {live && <span className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-foreground/70 motion-safe:animate-[live-caret_1s_steps(1)_infinite]" />}
        </p>
        {!live && (
          <span className="mt-1.5 inline-flex items-center gap-2 rounded-lg bg-muted py-1 pr-2.5 pl-1 text-[11.5px] motion-safe:animate-[live-fade_300ms_ease-out]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {picture ? <img src={picture} alt="" className="h-6 w-8 rounded bg-media object-cover" draggable={false} /> : <span className="h-6 w-8 rounded bg-media" />}
            <Check className="size-3 text-success" />
            Change {row.n}
          </span>
        )}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex shrink-0 gap-0.5">
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1 rounded-full bg-muted-foreground motion-safe:animate-pulse" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

/** After the round: a real box the visitor types their own change in. */
function OpenComposer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim().slice(0, 600);
        if (!t) return;
        onSend(t);
        setText("");
      }}
      className="flex h-11 items-center gap-2 rounded-xl bg-background px-3 text-[14px] ring-1 ring-border transition-shadow focus-within:ring-2 focus-within:ring-primary/60"
    >
      <Zap className="size-3.5 shrink-0 text-amber-500" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={600}
        placeholder="Type your own change…"
        aria-label="Type a change to the picture"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      <button type="submit" disabled={!text.trim()} aria-label="Send" className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition disabled:opacity-40">
        <ArrowUp className="size-3.5" />
      </button>
    </form>
  );
}

/**
 * The visitor's own words can't be drawn by the recording: they need a GPU. Two ways to see them in action: connect
 * a GPU (their own ComfyUI, checked on /connect), or open Live edit with the words in its box, on whatever the install
 * runs on.
 */
function GpuPrompt({ text }: { text: string }) {
  return (
    <div role="status" className="mb-2 rounded-xl bg-muted/60 p-3 text-[12.5px] ring-1 ring-border motion-safe:animate-[live-fade_300ms_ease-out]">
      <p className="flex items-center gap-1.5 font-medium">
        <Cpu className="size-3.5 shrink-0 text-primary" />
        Connect a GPU to see this drawn live
      </p>
      <p className="mt-0.5 text-muted-foreground">This one is a recording. Your words run on a real GPU: yours, or the one this Fuobe runs on.</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <IntentLink href="/connect" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition hover:opacity-90">
          <Cpu className="size-3.5" />
          Connect your GPU
        </IntentLink>
        <IntentLink
          href={`/live-edit?text=${encodeURIComponent(text)}`}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium ring-1 ring-border transition hover:bg-accent"
        >
          Open in Live edit
          <ArrowRight className="size-3.5" />
        </IntentLink>
      </div>
    </div>
  );
}

/** Your box: empty while others type, and your words as you type them on your turn, the end in view as they grow. */
function Composer({ text, active }: { text: string; active: boolean }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    setClipped(!!text && !!o && !!i && i.offsetWidth > o.clientWidth + 1);
  }, [text]);
  return (
    <div className={cn("flex h-11 items-center gap-2 rounded-xl bg-background px-3 text-[14px] ring-1 transition-shadow", active ? "ring-2 ring-primary/60" : "ring-border")}>
      <Zap className="size-3.5 shrink-0 text-amber-500" />
      <span ref={outer} className={cn("flex min-w-0 flex-1 overflow-hidden whitespace-nowrap", text && "justify-end", clipped && "[mask-image:linear-gradient(90deg,transparent,#000_1.25rem)]")}>
        {text ? (
          <span ref={inner} className="shrink-0" data-live-typed>
            {text}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">Message #live-edit</span>
        )}
        {active && <span className="ml-px h-4 w-px shrink-0 self-center bg-foreground/70 motion-safe:animate-[live-caret_1s_steps(1)_infinite]" />}
      </span>
    </div>
  );
}
