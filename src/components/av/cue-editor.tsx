"use client";

import { Merge, Plus, Redo2, Scissors, TextCursorInput, Trash2, Undo2 } from "lucide-react";
import { memo, useCallback, useEffect, useReducer, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cueReducer, formatCueTime, normalizeCues, parseCueTime, type CueAction } from "@/lib/av/cue-edit";
import type { Cue } from "@/lib/cues";
import { cn } from "@/lib/utils";
import { useDraft } from "./use-draft";

interface History {
  past: Cue[][];
  present: Cue[];
  future: Cue[][];
  /** The line being typed into: keystrokes in one line make one undo step. */
  typing: number;
}

type HistoryAction = CueAction | { type: "undo" } | { type: "redo" };

function historyReducer(h: History, a: HistoryAction): History {
  if (a.type === "undo") return h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future], typing: -1 } : h;
  if (a.type === "redo") return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), typing: -1 } : h;
  const next = cueReducer(h.present, a);
  if (next === h.present) return h;
  if (a.type === "text" && h.typing === a.index) return { ...h, present: next, future: [] };
  return { past: [...h.past.slice(-99), h.present], present: next, future: [], typing: a.type === "text" ? a.index : -1 };
}

/** Cue list state with undo / redo. */
export function useCueEditor(initial: Cue[]) {
  const [h, dispatch] = useReducer(historyReducer, initial, (c): History => ({ past: [], present: normalizeCues(c), future: [], typing: -1 }));
  return { cues: h.present, dispatch, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

function RowAction({ label, line, onClick, disabled, children }: { label: string; line: number; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          aria-label={`${label} (line ${line + 1})`}
          className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const Row = memo(function Row({
  cue,
  index,
  active,
  last,
  dispatch,
  onSeek,
  onFixLine,
}: {
  cue: Cue;
  index: number;
  active: boolean;
  last: boolean;
  dispatch: (a: CueAction) => void;
  onSeek?: (t: number) => void;
  onFixLine?: (index: number) => void;
}) {
  const text = useRef<HTMLTextAreaElement>(null);
  const [start, setStart, resetStart] = useDraft(formatCueTime(cue.start));
  const [end, setEnd, resetEnd] = useDraft(formatCueTime(cue.end));
  const commit = (which: "start" | "end", raw: string) => {
    const t = parseCueTime(raw);
    if (t === null) return which === "start" ? resetStart() : resetEnd();
    dispatch({ type: "time", index, [which]: t });
  };
  const timeInput = (which: "start" | "end", value: string, set: (v: string) => void) => (
    <input
      value={value}
      onChange={(e) => set(e.target.value)}
      onBlur={(e) => commit(which, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const step = e.shiftKey ? 1 : 0.1;
          dispatch({ type: "time", index, [which]: (which === "start" ? cue.start : cue.end) + (e.key === "ArrowUp" ? step : -step) });
        }
      }}
      inputMode="decimal"
      aria-label={`${which === "start" ? "Start" : "End"} of line ${index + 1}`}
      className="h-7 w-[4.6rem] rounded-md bg-transparent px-1.5 font-mono text-[12px] tabular-nums outline-none hover:bg-muted focus:bg-muted focus:ring-2 focus:ring-ring/40"
    />
  );
  const splitAtCaret = () => dispatch({ type: "split", index, caret: text.current?.selectionStart ?? undefined });
  return (
    <li data-cue={index} className={cn("group/cue rounded-xl border px-2 py-1.5 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_76px]", active ? "border-primary bg-brand-faint/50" : "border-transparent hover:border-border")}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <button type="button" onClick={() => onSeek?.(cue.start)} className="mr-1 font-mono text-[11px] text-muted-foreground tabular-nums hover:text-brand-text" aria-label={`Play from line ${index + 1}`}>
          {String(index + 1).padStart(2, "0")}
        </button>
        {timeInput("start", start, setStart)}
        <span className="text-muted-foreground">→</span>
        {timeInput("end", end, setEnd)}
        <div className="ml-auto flex items-center opacity-100 sm:opacity-0 sm:group-focus-within/cue:opacity-100 sm:group-hover/cue:opacity-100">
          {onFixLine && (
            <RowAction label="Fix this line: change what was said" line={index} onClick={() => onFixLine(index)} disabled={!cue.text.trim()}>
              <TextCursorInput className="size-3.5" />
            </RowAction>
          )}
          <RowAction label="Split at the cursor" line={index} onClick={splitAtCaret} disabled={!cue.text.trim().includes(" ")}>
            <Scissors className="size-3.5" />
          </RowAction>
          <RowAction label="Merge with the next line" line={index} onClick={() => dispatch({ type: "merge", index })} disabled={last}>
            <Merge className="size-3.5" />
          </RowAction>
          <RowAction label="Add a line after" line={index} onClick={() => dispatch({ type: "insert", index })}>
            <Plus className="size-3.5" />
          </RowAction>
          <RowAction label="Delete line" line={index} onClick={() => dispatch({ type: "remove", index })}>
            <Trash2 className="size-3.5" />
          </RowAction>
        </div>
      </div>
      <textarea
        ref={text}
        value={cue.text}
        onChange={(e) => dispatch({ type: "text", index, text: e.target.value })}
        onFocus={() => onSeek?.(cue.start)}
        onKeyDown={(e) => {
          // Alt+Enter splits the line at the cursor.
          if (e.key === "Enter" && e.altKey) {
            e.preventDefault();
            dispatch({ type: "split", index, caret: e.currentTarget.selectionStart });
          }
        }}
        rows={1}
        aria-label={`Line ${index + 1}`}
        placeholder="Empty line"
        className="field-sizing-content w-full resize-none rounded-md bg-transparent px-1.5 py-1 text-[15px] leading-snug outline-none placeholder:text-subtle-foreground focus:bg-muted/60"
      />
    </li>
  );
});

/** The editable list of timed lines, with undo / redo; the line under `currentTime` is highlighted. */
export function CueEditor({
  editor,
  currentTime,
  onSeek,
  className,
  emptyHint = "No lines yet",
  onFixLine,
}: {
  editor: ReturnType<typeof useCueEditor>;
  currentTime?: number;
  onSeek?: (t: number) => void;
  className?: string;
  emptyHint?: string;
  /** "Fix this line": open Edit speech on this line (change what was said in the recording itself). */
  onFixLine?: (index: number) => void;
}) {
  const { cues, dispatch, canUndo, canRedo } = editor;
  const list = useRef<HTMLOListElement>(null);
  const active = currentTime === undefined ? -1 : cues.findIndex((c) => currentTime >= c.start && currentTime < c.end);
  const send = useCallback((a: CueAction) => dispatch(a), [dispatch]);
  // Keep the playing line in view (inside the list only).
  useEffect(() => {
    if (active < 0 || !list.current) return;
    const el = list.current.querySelector<HTMLElement>(`[data-cue="${active}"]`);
    const box = list.current;
    if (!el || box.contains(document.activeElement)) return;
    if (el.offsetTop < box.scrollTop || el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop - 12;
  }, [active]);
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-1 pb-2">
        <span className="text-[12px] text-muted-foreground">
          {cues.length} line{cues.length === 1 ? "" : "s"} · Alt+Enter splits
        </span>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon-sm" className="rounded-full" disabled={!canUndo} onClick={() => dispatch({ type: "undo" })} aria-label="Undo">
            <Undo2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="rounded-full" disabled={!canRedo} onClick={() => dispatch({ type: "redo" })} aria-label="Redo">
            <Redo2 className="size-4" />
          </Button>
        </div>
      </div>
      {cues.length ? (
        <ol ref={list} className="relative min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {cues.map((c, i) => (
            <Row key={i} cue={c} index={i} active={i === active} last={i === cues.length - 1} dispatch={send} onSeek={onSeek} onFixLine={onFixLine} />
          ))}
        </ol>
      ) : (
        <div className="grid flex-1 place-items-center rounded-xl border border-dashed py-10 text-center">
          <div>
            <p className="text-[13px] text-muted-foreground">{emptyHint}</p>
            <Button variant="outline" size="sm" className="mt-3 rounded-full" onClick={() => dispatch({ type: "insert", index: -1 })}>
              <Plus className="size-3.5" /> Add a line
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
