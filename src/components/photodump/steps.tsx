"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** Numbered wizard steps; steps already reached can be revisited. */
export function Steps({ steps, current, reached, onGo }: { steps: string[]; current: number; reached: number; onGo?: (i: number) => void }) {
  return (
    <ol aria-label="Steps" className="scrollbar-none flex items-center gap-1 overflow-x-auto">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const can = !!onGo && i <= reached && !active;
        return (
          <li key={label} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden className={cn("h-px w-3 sm:w-6", i <= current ? "bg-primary/60" : "bg-border")} />}
            <button
              type="button"
              disabled={!can}
              aria-current={active ? "step" : undefined}
              onClick={() => can && onGo(i)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                active ? "bg-brand-faint text-brand-text" : done ? "text-foreground hover:bg-accent" : "text-muted-foreground",
                !can && !active && "cursor-default",
              )}
            >
              <span className={cn("grid size-5 place-items-center rounded-full text-[11px]", active ? "bg-primary text-primary-foreground" : done ? "bg-success text-white" : "bg-muted")}>
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className={cn(!active && "max-sm:hidden")}>{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * "Runs on Nano Banana Pro · 10 photos · ≈ $1.50" (or the reason it can't run). An account's run is priced on its own GPU
 * or key ("Free · your GPU" on its GPU).
 */
export function RunLine({ preview, loading }: { preview?: { modelName?: string; count?: number; costUsd?: number | null; demo?: boolean; notes: string[]; error?: string }; loading?: boolean }) {
  if (!preview) return <p className="h-5 text-[12.5px] text-muted-foreground">{loading ? "Pricing…" : ""}</p>;
  if (preview.error) return <p className="text-[12.5px] text-destructive">{preview.error}</p>;
  const cost = preview.demo ? "Placeholder · free" : preview.costUsd === 0 ? "Free · your GPU" : preview.costUsd == null ? "price unknown" : `≈ $${preview.costUsd.toFixed(2)}`;
  return (
    <div className="space-y-0.5 text-[12.5px] text-muted-foreground">
      <p>
        Runs on <span className="font-medium text-foreground">{preview.modelName}</span> · {preview.count} photo{preview.count === 1 ? "" : "s"} · <span className="tabular-nums">{cost}</span>
      </p>
      {preview.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}
