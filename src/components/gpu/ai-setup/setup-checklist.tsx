"use client";

import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Step, StepId, StepState } from "@/lib/ai-setup/steps";
import { cn } from "@/lib/utils";

/**
 * The live checklist of "Set it up with my AI": one row per step, ticked off as the open tab sees each one happen. A
 * line joins the rows' dots and fills down in the brand colour as steps are done (the relay from the person's AI to
 * Fuobe). One polite live region says each change of a step, never a quiet look.
 */

const SPOKEN: Record<StepState, string> = { done: "done", todo: "waiting", working: "in progress", warn: "needs attention" };

function Dot({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground motion-safe:animate-pop-in">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  if (state === "warn")
    return (
      <span className="grid size-5 place-items-center rounded-full border-2 border-amber-500/70 bg-background text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-2.5" strokeWidth={3} />
      </span>
    );
  if (state === "working")
    return (
      <span className="relative grid size-5 place-items-center">
        <span className="absolute inline-flex size-3 rounded-full bg-primary/50 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
      </span>
    );
  return <span className="block size-5 rounded-full border-2 border-muted-foreground/30 bg-background" />;
}

export function SetupChecklist({ steps, extras, footer }: { steps: Step[]; extras?: Partial<Record<StepId, React.ReactNode>>; footer?: React.ReactNode }) {
  const [said, setSaid] = useState("");
  const before = useRef<Map<StepId, StepState> | null>(null);
  const done = steps.filter((s) => s.state === "done").length;
  // The first step not done yet is the one Fuobe watches for: its dot pulses while it waits.
  const current = steps.findIndex((s) => s.state !== "done");
  const key = steps.map((s) => `${s.id}:${s.state}`).join();
  useEffect(() => {
    const was = before.current;
    before.current = new Map(steps.map((s) => [s.id, s.state]));
    if (!was) return;
    const changed = steps.find((s) => was.get(s.id) !== s.state);
    if (changed) setSaid(`${changed.label}${changed.state === "done" ? "" : `: ${SPOKEN[changed.state]}`}. ${done} of ${steps.length} done.`);
    // The steps' states are what count (`key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div>
      <ol aria-label="Setup steps" className="space-y-0">
        {steps.map((s, i) => {
          const next = steps[i + 1];
          const extra = extras?.[s.id];
          return (
            <li key={s.id} className={cn("relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-3", next && "pb-3")}>
              {next && (
                <span aria-hidden className="absolute top-[26px] -bottom-[2px] left-[9px] w-0.5 overflow-hidden rounded-full bg-muted-foreground/15">
                  <span
                    className={cn(
                      "block size-full origin-top bg-primary transition-transform duration-300 ease-[var(--ease-move)] motion-reduce:transition-none",
                      s.state === "done" ? "scale-y-100" : "scale-y-0",
                    )}
                  />
                </span>
              )}
              <span className="mt-0.5">
                <Dot state={i === current && s.state === "todo" ? "working" : s.state} />
              </span>
              <div className="min-w-0">
                <div className="flex min-h-6 flex-col sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <p className={cn("text-[14px] font-medium", s.state === "todo" && "text-muted-foreground")}>
                    {s.label}
                    <span className="sr-only">, {SPOKEN[s.state]}</span>
                  </p>
                  {s.detail && (
                    <p className={cn("min-w-0 truncate text-[12px] sm:text-right", s.state === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} title={s.detail}>
                      {s.detail}
                    </p>
                  )}
                </div>
                {extra && <div className="mt-2 mb-1 space-y-2 text-[13px]">{extra}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {footer && <div className="mt-4 border-t pt-3">{footer}</div>}
    </div>
  );
}
