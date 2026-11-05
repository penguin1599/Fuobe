"use client";

import { type ReactNode, useRef } from "react";
import { type SentenceMark, stops } from "@/lib/live/demo";
import { cn } from "@/lib/utils";
import type { Person } from "./live-crew";

/**
 * The recorded session's one prompt, set as a sentence under the picture: each change in its author's colour, a dot
 * over each letter a live frame was drawn at, and a caret that is the playhead. While it plays, the words after the
 * caret are laid out but hidden, so the sentence never changes height; the author's flag rides the caret. At rest the
 * visitor drags the caret back through the words (or uses the arrow keys, Home and End) and the picture becomes that
 * much of the sentence drawn on the original; the words after it fade. It only stops where a picture was drawn.
 */
export function Sentence({
  text,
  clauses,
  marks,
  authors,
  caret,
  playing,
  typer,
  yourTurn,
  label,
  onSeek,
  onTap,
}: {
  text: string;
  clauses: { start: number; end: number }[];
  marks: SentenceMark[];
  /** Who wrote each clause. */
  authors: Person[];
  /** How many letters the picture holds. */
  caret: number;
  playing: boolean;
  /** Whoever is typing at the caret while it plays. */
  typer: Person | null;
  yourTurn: boolean;
  /** What the slider says for a screen reader. */
  label: string;
  /** The visitor put the caret at `at` (a letter a picture was drawn for). */
  onSeek: (at: number) => void;
  /** A tap on the sentence during the visitor's turn: types their next word. */
  onTap: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = stops(marks);
  const snap = (n: number) => at.reduce((s, k) => (k <= n ? k : s), 0);
  const step = (dir: 1 | -1) => {
    const i = at.indexOf(snap(caret));
    return at[Math.min(at.length - 1, Math.max(0, i + dir))];
  };

  /** The letter under the pointer, as the end of the piece of text it is in; past the end of the text, all of it. */
  const pointAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-end]");
    if (el && box.current?.contains(el)) return Number(el.dataset.end);
    const r = box.current?.getBoundingClientRect();
    if (r && y > r.bottom - 8) return text.length;
    return null;
  };
  const seekTo = (x: number, y: number) => {
    const n = pointAt(x, y);
    if (n !== null) onSeek(snap(n));
  };

  // The markers (caret, dots) are plain inline spans, never inline-blocks: those would let a line break before a comma.
  // The text in pieces, cut wherever something changes: a clause starts or ends, a live frame was drawn, the caret.
  const live = marks.filter((m) => m.live);
  const cuts = [...new Set([0, text.length, caret, ...clauses.flatMap((c) => [c.start, c.end]), ...live.map((m) => m.at)])].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const clauseOf = (a: number) => clauses.findIndex((c) => a >= c.start && a < c.end);
  /** The clause being typed while it plays: the one the caret is in, or about to start. */
  const typing = playing ? clauses.findIndex((c) => caret <= c.end) : -1;

  const pieces: ReactNode[] = [];
  const caretEl = (
    <span key="caret" className="relative" aria-hidden>
      <span className={cn("absolute top-[0.08em] bottom-[0.02em] -left-px w-[2px] rounded-full", playing ? cn(typer?.dot ?? "bg-foreground", "motion-safe:animate-[live-caret_1s_steps(1)_infinite]") : "bg-foreground")} />
      {!playing && <span className="absolute -top-1.5 -left-[5px] size-[10px] rounded-full bg-foreground ring-2 ring-card" />}
      {playing && typer && (
        <span
          key={typer.id}
          className={cn(
            "absolute bottom-full left-[-1px] z-10 mb-0.5 rounded-[3px_8px_8px_8px] px-1.5 py-0.5 font-sans text-[11px] leading-none font-semibold whitespace-nowrap shadow-[0_2px_8px_rgb(0_0_0/18%)] motion-safe:animate-[live-chip_220ms_ease-out]",
            typer.avatar,
            yourTurn && "ring-4 ring-primary/25",
          )}
        >
          {yourTurn ? (
            <>
              You · <span className="pointer-coarse:hidden">type anything</span>
              <span className="hidden pointer-coarse:inline">tap to type</span>
            </>
          ) : (
            typer.name
          )}
        </span>
      )}
    </span>
  );
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    if (a === caret) pieces.push(caretEl);
    const dot = live.find((m) => m.at === a && a > 0);
    if (dot) {
      const who = authors[dot.change];
      pieces.push(
        <span key={`d${a}`} className="relative" aria-hidden>
          <span className={cn("absolute -top-[0.2em] -left-[3px] size-[6px] rounded-full transition-opacity duration-300", who?.dot, a > caret && (playing ? "opacity-0" : "opacity-25"))} />
        </span>,
      );
    }
    const c = clauseOf(a);
    const who = c >= 0 ? authors[c] : null;
    const inPicture = b <= caret;
    pieces.push(
      <span
        key={a}
        data-end={b}
        className={cn(
          "transition-[opacity,color] duration-300",
          who ? cn("underline decoration-2 underline-offset-[6px]", who.line) : "text-muted-foreground",
          c === typing && who && cn("rounded-[3px]", who.tint),
          !inPicture && (playing ? "invisible" : "no-underline opacity-25"),
        )}
      >
        {text.slice(a, b)}
      </span>,
    );
  }
  if (caret === text.length) pieces.push(caretEl);

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label="Go back through the words"
      aria-valuemin={0}
      aria-valuemax={text.length}
      aria-valuenow={caret}
      aria-valuetext={label}
      className={cn(
        "relative rounded-lg font-heading text-[18px] leading-[2.1] text-pretty outline-none select-none [touch-action:pan-y] focus-visible:ring-2 focus-visible:ring-ring sm:text-[20px] lg:text-[22px]",
        playing ? (yourTurn ? "cursor-text" : "cursor-default") : "cursor-ew-resize",
      )}
      onPointerDown={(e) => {
        if (yourTurn) return onTap();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        // While it plays, a grab stops it where it is; at rest it puts the caret under the pointer.
        if (playing) onSeek(snap(caret));
        else seekTo(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current && !playing) seekTo(e.clientX, e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        const next = e.key === "ArrowLeft" ? step(-1) : e.key === "ArrowRight" ? step(1) : e.key === "Home" ? 0 : e.key === "End" ? text.length : null;
        if (next === null || yourTurn) return;
        e.preventDefault();
        onSeek(snap(next));
      }}
    >
      {pieces}
    </div>
  );
}
