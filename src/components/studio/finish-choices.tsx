"use client";

import { Cpu, Loader2, Sparkles } from "lucide-react";
import type { Engine, ModelDef } from "@/lib/catalog/types";
import { REGEN_COPY, REGEN_MODEL, type FinishChoice } from "@/lib/catalog/regenerate";
import { RTX_COPY, RTX_UPSCALE_MODEL, rtxStanding } from "@/lib/catalog/rtx-video";
import { badgeFor, useGpuBadges } from "@/hooks/use-gpu";
import { OwnSetupChip } from "@/components/own-setup";
import { useIsOwner } from "@/lib/api";
import { cn } from "@/lib/utils";
import { radioKeys, radioTab } from "./radio-keys";

/**
 * Upscale → Video's open finishing steps side by side (StudioConfig.finishChoices): SeedVR2 "Restore · faithful", and
 * Open-H3 "Regenerate · creative" with what it needs (a 48 GB card: OwnSetupChip). On the cloud engine (both engines on) Regenerate says it runs on
 * your GPU, with a button that takes the composer there; with Engine mode "Paid APIs only" nothing shows. GPU-only:
 * nobody hosts it.
 * With Regenerate picked: the GPU line (the install detail for the owner only), the 16:9 / 9:16 shape, and for a clip with
 * no words yet a button that has Fuobe's reading model describe it (`onDescribe`).
 * NVIDIA RTX Video's "Quick · RTX" joins them: first on an NVIDIA RTX card, switched off with the reason on a card that
 * can't run it (a CPU, Apple, AMD or an older NVIDIA card), last when the card isn't known. It is never picked for anyone.
 */
export function FinishChoices({
  choices,
  model,
  engine,
  engineMode,
  offered,
  onPick,
  onDescribe,
  describing,
}: {
  choices: readonly FinishChoice[];
  model: ModelDef | undefined;
  engine: Engine;
  engineMode: "both" | "open" | "cloud";
  /** The choices Settings → Models & licences leaves on (and this catalog has). */
  offered: (id: string) => ModelDef | undefined;
  onPick: (m: ModelDef) => void;
  /** Writes the clip's words into the prompt box (shown while it has none). */
  onDescribe?: () => void;
  describing?: boolean;
}) {
  const owner = useIsOwner();
  const badges = useGpuBadges().data;
  if (engineMode === "cloud") return null;
  const regen = choices.some((c) => c.modelId === REGEN_MODEL) ? offered(REGEN_MODEL) : undefined;
  if (engine === "cloud") {
    if (!regen) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pb-2 text-[12px] leading-snug text-muted-foreground">
        <Cpu className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="font-medium text-foreground">Regenerate · creative</span> · {REGEN_COPY.gpuOnly}
        </span>
        <OwnSetupChip setup="regenerate:upscale" />
        <button
          type="button"
          onClick={() => onPick(regen)}
          className="rounded-full px-1.5 font-medium text-brand-text underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Use it on your GPU
        </button>
      </div>
    );
  }
  const base: { modelId: string; label: string; hint: string; m?: ModelDef; off?: true }[] = choices.map((c) => ({ ...c, m: offered(c.modelId) })).filter((c) => !!c.m);
  // Quick · RTX: where it stands on the viewer's card (its own chip says when the card can't run it).
  const rtx = offered(RTX_UPSCALE_MODEL);
  const chip = badgeFor(badges, { modelId: RTX_UPSCALE_MODEL, op: "upscale-video" });
  const standing = rtxStanding("nvidia-rtx", badges?.gpu, !!chip && chip[0] === "u" && (chip[3] & 24) !== 0);
  const quick = rtx && {
    modelId: RTX_UPSCALE_MODEL,
    label: RTX_COPY.quick,
    hint: standing === "fits" ? RTX_COPY.quickHint : standing === "no" ? RTX_COPY.needsCard : `${RTX_COPY.onRtx}. Adds no new detail.`,
    m: rtx,
    ...(standing === "no" && model?.id !== RTX_UPSCALE_MODEL && { off: true as const }),
  };
  const shown = quick ? (standing === "fits" ? [quick, ...base] : [...base, quick]) : base;
  if (shown.length < 2) return null;
  const picked = shown.find((c) => c.modelId === model?.id);
  return (
    <div className="px-1.5 pb-2">
      <div role="radiogroup" aria-label="How to finish the clip" onKeyDown={radioKeys} className={cn("grid grid-cols-2 gap-1.5", shown.length > 2 && "sm:grid-cols-3")}>
        {shown.map((c, i) => {
          const sel = c.modelId === model?.id;
          return (
            <button
              key={c.modelId}
              type="button"
              role="radio"
              aria-checked={sel}
              aria-disabled={c.off}
              tabIndex={radioTab(sel || (!picked && c === shown[0]))}
              onClick={() => !sel && !c.off && onPick(c.m!)}
              className={cn(
                "min-w-0 rounded-xl border px-2.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                sel ? "border-primary bg-brand-faint" : c.off ? "cursor-not-allowed opacity-60" : "hover:bg-accent",
                // Three choices: the first takes a row of its own on a phone.
                shown.length > 2 && i === 0 && "max-sm:col-span-2",
              )}
            >
              <span className={cn("block text-[12px] font-medium", sel ? "text-brand-text" : "text-foreground")}>{c.label}</span>
              {/* Regenerate · creative needs a 48 GB card: the choice says so (own-setup.ts). Picking it stays free for all. */}
              {c.modelId === REGEN_MODEL && <OwnSetupChip setup="regenerate:upscale" className="my-0.5" />}
              <span className="block text-[11px] leading-snug text-pretty text-muted-foreground">{c.hint}</span>
            </button>
          );
        })}
      </div>
      {model?.id === RTX_UPSCALE_MODEL && <p className="mt-1.5 px-1 text-[11px] leading-snug text-pretty text-muted-foreground">{RTX_COPY.picked}</p>}
      {model?.id === REGEN_MODEL && (
        <>
          <p className="mt-1.5 px-1 text-[11px] leading-snug text-pretty text-muted-foreground">
            {owner ? `Free on your GPU · ${REGEN_COPY.gpu}` : REGEN_COPY.gpuVisitor} {REGEN_COPY.shape}
          </p>
          {(onDescribe || describing) && (
            <button
              type="button"
              onClick={onDescribe}
              disabled={describing}
              className="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-70"
            >
              {describing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
              {describing ? "Watching the clip…" : "Describe the clip for me"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
