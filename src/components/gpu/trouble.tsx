"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink, KeyRound, Loader2, Play, RefreshCw, RotateCcw, Settings2, Shuffle, Stethoscope, Monitor } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import type { GpuTroubleView } from "@/lib/api";
import { backoffMs, retryPlan, type TroubleAction, type TroubleActionKind } from "@/lib/diagnose";
import { cn } from "@/lib/utils";

/**
 * What an account sees when its own GPU or key has a problem (src/lib/diagnose.ts): the plain sentence, a small details
 * line for the curious, and the buttons that help (Start your pod, Check my GPU, Settings → Your GPU or Your keys, Run
 * with your fal.ai key, Add credit, Retry). Used by a failed run's tile, Settings → Your GPU and the composer's check
 * before Run.
 */

/** What "Check my GPU" learnt: the GPU answered (and what it is), or why not, in plain words. */
export type GpuCheck = { ok: true; device?: string } | { ok: false; words: string; trouble?: GpuTroubleView; retryAfterS?: number };

/**
 * Check my GPU: the saved address asked again now (PUT /api/account/gpu?test=1 { saved: true }), the same check as
 * Settings' Test. The status strip, the composer and Settings learn its answer.
 */
export async function checkMyGpu(qc?: QueryClient): Promise<GpuCheck> {
  let res: Response;
  try {
    res = await fetch("/api/account/gpu?test=1", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saved: true }) });
  } catch {
    return { ok: false, words: "We couldn't check right now. Check this computer's internet, then try again." };
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string; trouble?: GpuTroubleView; info?: { device?: string } };
  void qc?.invalidateQueries({ queryKey: ["status"] });
  void qc?.invalidateQueries({ queryKey: ["account-gpu"] });
  if (res.ok) return { ok: true, device: j.info?.device };
  const retryAfterS = Number(res.headers.get("retry-after")) || undefined;
  return { ok: false, words: j.trouble?.words ?? j.error ?? "Your GPU didn't answer.", trouble: j.trouble, ...(retryAfterS && { retryAfterS }) };
}

const ICONS: Record<TroubleActionKind, typeof Play> = {
  retry: RotateCcw,
  "check-gpu": Stethoscope,
  "gpu-settings": Settings2,
  "key-settings": KeyRound,
  "run-with-key": Shuffle,
  "add-credit": CreditCard,
  "pick-model": Shuffle,
  "start-gpu": Play,
  pair: RefreshCw,
  "use-computer": Monitor,
};

/** The first button stands out (the one most likely to help); the rest are quieter. */
const PILL = "inline-flex h-7 w-fit items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium";
const MAIN = "bg-highlight text-highlight-foreground hover:opacity-90";
const QUIET = "bg-secondary hover:bg-accent";

export interface TroubleHandlers {
  onRetry?: () => void;
  /** "Run with your fal.ai key": the caller runs the cloud version (an explicit click: it spends the person's credit). */
  onRunWithKey?: (a: TroubleAction) => void;
  onPickModel?: () => void;
  /** "Use this computer": the caller switches runs to the ComfyUI on this computer. */
  onUseComputer?: () => void;
}

/**
 * The buttons of a diagnosis, in its order. A button with nothing to do here is left out (Retry without a run, Pick another
 * model without a picker). `max`: at most so many; `skip`: kinds the caller shows itself (a tile's own Retry).
 */
export function TroubleActions({ actions, handlers = {}, max, skip = [], className }: { actions: TroubleAction[]; handlers?: TroubleHandlers; max?: number; skip?: TroubleActionKind[]; className?: string }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const usable = actions.filter((a) => {
    if (skip.includes(a.kind)) return false;
    if (a.kind === "retry") return !!handlers.onRetry;
    if (a.kind === "run-with-key") return !!handlers.onRunWithKey;
    if (a.kind === "pick-model") return !!handlers.onPickModel;
    if (a.kind === "use-computer") return !!handlers.onUseComputer;
    return true;
  });
  const shown = max ? usable.slice(0, max) : usable;
  if (!shown.length) return null;
  const check = async () => {
    setChecking(true);
    try {
      const r = await checkMyGpu(qc);
      if (r.ok) toast.success(`Your GPU answered${r.device ? `: ${r.device}` : ""}. Press Retry to run it again.`);
      else toast(r.words, { id: "check-gpu" });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {shown.map((a, i) => {
        const Icon = ICONS[a.kind];
        const cls = cn(PILL, i === 0 && a.kind !== "retry" ? MAIN : QUIET);
        const stop = (e: React.MouseEvent) => e.stopPropagation();
        if ((a.kind === "start-gpu" || a.kind === "add-credit") && a.target) {
          return (
            <a key={a.kind} href={a.target} target="_blank" rel="noopener noreferrer" onClick={stop} className={cls}>
              <Icon className="size-3" /> {a.label}
              <ExternalLink className="size-3 opacity-60" aria-hidden />
            </a>
          );
        }
        if ((a.kind === "gpu-settings" || a.kind === "key-settings" || a.kind === "pair") && a.target) {
          return (
            <Link key={a.kind} href={a.target} onClick={stop} className={cls}>
              <Icon className="size-3" /> {a.label}
            </Link>
          );
        }
        const run =
          a.kind === "check-gpu"
            ? () => void check()
            : a.kind === "retry"
              ? handlers.onRetry
              : a.kind === "run-with-key"
                ? () => handlers.onRunWithKey?.(a)
                : a.kind === "pick-model"
                  ? handlers.onPickModel
                  : a.kind === "use-computer"
                    ? handlers.onUseComputer
                    : undefined;
        return (
          <button
            key={a.kind}
            type="button"
            disabled={a.kind === "check-gpu" && checking}
            onClick={(e) => {
              e.stopPropagation();
              run?.();
            }}
            className={cls}
          >
            {a.kind === "check-gpu" && checking ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />} {a.label}
          </button>
        );
      })}
    </div>
  );
}

/** The small details line under the sentence: what came back, for the curious. */
export function TroubleDetails({ details, className }: { details?: string; className?: string }) {
  if (!details) return null;
  return (
    <p title={details} className={cn("line-clamp-2 font-mono text-[10.5px] leading-snug break-all text-muted-foreground/80", className)}>
      {details}
    </p>
  );
}

/** How long Settings waits before checking again by itself (diagnose.ts retryPlan "check"), or null: it doesn't. */
export function autoCheckIn(cause: GpuTroubleView["cause"], attempt: number, startedAt: number, now = Date.now()): number | null {
  const plan = retryPlan(cause, "check");
  if (!plan) return null;
  const wait = backoffMs(attempt, plan);
  return now - startedAt + wait > plan.budgetMs ? null : wait;
}
