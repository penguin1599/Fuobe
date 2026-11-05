"use client";

import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { formatLength, PART_LABELS, type EstimateResult, type StepPart } from "@/lib/catalog/faceless";
import type { Engine } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";

/** A segmented control (Liner style: muted track, white thumb), keyboard like a radio group. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys} className={cn("inline-flex max-w-full flex-wrap gap-0.5 rounded-full bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={radioTab(value === o.value)}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.value ? "bg-background text-foreground shadow-soft" : "hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled switch row. */
export function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

/** A form section with a small uppercase title. */
export function Section({ title, hint, children, className }: { title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2.5", className)}>
      <div>
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {hint && <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/**
 * "≈ $7.02" / "Placeholder · free" / "Free · your GPU", with what it's made of in a popover. quiet: the estimate's problem (no
 * narrator voice yet…) is a plain hint, not a warning: nothing has been asked of the visitor yet. The open engine runs on
 * the viewer's own GPU (an account's own ComfyUI), free.
 */
export function EstimateLine({ data, loading, engine, className, quiet }: { data: EstimateResult | undefined; loading?: boolean; engine: Engine; className?: string; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!data) return <span className={cn("inline-flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground", className)}>{loading && <Loader2 className="size-3 animate-spin" />}Estimating…</span>;
  const price = data.demo ? "Placeholder · free" : engine === "open" ? "Free · your GPU" : `≈ ${usd(data.estimate.total)}${data.estimate.unknown ? "+" : ""}`;
  const parts = Object.entries(data.estimate.parts).filter(([, v]) => (v ?? 0) > 0) as [StepPart, number][];
  const notes = !data.error ? (data.notes ?? []) : [];
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn("inline-flex items-center gap-1 rounded-full font-mono text-[12px] text-foreground tabular-nums transition-opacity hover:underline", loading && "opacity-60")}>
            {price}
            {loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : <Info className="size-3 text-muted-foreground" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3 text-[13px]" collisionPadding={12}>
          <p className="font-medium">How the price works</p>
          <p className="mt-1 text-[12px] text-muted-foreground">You&apos;re only charged for the actual length. The exact cost isn&apos;t known upfront — this is an estimate from your providers&apos; prices.</p>
          {parts.length > 0 && !data.demo && (
            <dl className="mt-2.5 space-y-1">
              {parts.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 font-mono text-[12px] tabular-nums">
                  <dt className="font-sans text-muted-foreground">{PART_LABELS[k]}</dt>
                  <dd>{usd(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.demo && <p className="mt-2 text-[12px] text-muted-foreground">Some steps aren&apos;t connected, so this run makes placeholder results.</p>}
          {/* The notes again: on a phone they live here (the bar shows how many), so it stays one or two lines tall. */}
          {notes.length > 0 && (
            <ul className="mt-2.5 space-y-1 border-t pt-2.5 text-[12px] text-muted-foreground">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
        {formatLength(data.seconds)} · {data.blocks} scene{data.blocks === 1 ? "" : "s"}
      </span>
      {data.error && (
        <span role={quiet ? undefined : "alert"} className={cn("inline-flex min-w-0 items-start gap-1 text-[12px]", quiet ? "text-muted-foreground" : "text-warning")}>
          {quiet ? <Info className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
          <span className="min-w-0">{data.error}</span>
        </span>
      )}
      {notes.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`${notes.length} note${notes.length === 1 ? "" : "s"} on this render — show them with the price`}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-[12px] text-foreground sm:hidden"
        >
          <Info className="size-3 text-muted-foreground" />
          {notes.length} note{notes.length === 1 ? "" : "s"}
        </button>
      )}
      {notes.map((n) => (
        <span key={n} className="hidden min-w-0 items-start gap-1 text-[12px] text-muted-foreground sm:inline-flex">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0">{n}</span>
        </span>
      ))}
    </div>
  );
}
