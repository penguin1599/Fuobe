"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId } from "react";
import { useEngineMode, useLikelyVisitor } from "@/lib/api";
import type { Generation } from "@/lib/catalog/types";
import { keepGoing, type NextStep } from "@/lib/next-steps";
import { cn } from "@/lib/utils";
import { CoverThumb } from "./cover-thumb";

/** What the heading calls the result, by the kind of output it is. */
const NOUN: Record<string, string> = { image: "picture", video: "clip", audio: "sound", model3d: "model" };

/**
 * Studios that read a handed-over picture with their own small reader (`HandoffImage` below). Image to 3D and
 * Character Sheet run for an account too (on its own GPU or key).
 */
const ADAPTERS = { characterSheet: true, imageTo3d: true } as const;
const VISITOR_ADAPTERS = ADAPTERS;

/** The heading over the steps: "Keep going with this picture" (clip, sound, model). */
export function keepGoingTitle(kind: string | undefined): string {
  return `Keep going with this ${NOUN[kind ?? ""] ?? "result"}`;
}

/**
 * "Keep going with this": the next studios or apps for a finished result, each opening with the result already in
 * it. `row` sits under a result (pills that wrap, one sideways rail inside its own box on a phone); `list` is the
 * Viewer's side panel (stacked rows). Nothing when the result has nowhere to go (failed, deleted, text, vectors).
 */
export function NextSteps({
  g,
  index,
  variant,
  max = 5,
  skip,
  onNavigate,
  className,
}: {
  g: Generation;
  index: number;
  variant: "row" | "list";
  max?: number;
  /** Step ids the view already offers in its own way (the 3D card's own Animate the spin). */
  skip?: readonly string[];
  /** Called when a step is chosen (the Viewer closes itself, so a hand-off to the same studio isn't hidden behind it). */
  onNavigate?: () => void;
  className?: string;
}) {
  const engineMode = useEngineMode();
  const visitor = useLikelyVisitor();
  const titleId = useId();
  const steps = keepGoing(g, index, { engineMode, visitor, adapters: visitor ? VISITOR_ADAPTERS : ADAPTERS }, max + (skip?.length ?? 0))
    .filter((s) => !skip?.includes(s.id))
    .slice(0, max);
  if (!steps.length) return null;
  const title = keepGoingTitle(g.outputs[index]?.kind);
  const list = variant === "list";
  return (
    // A group, not a landmark: a page of results has many of these (one per 3D model card).
    <div role="group" aria-labelledby={titleId} className={cn(list ? "space-y-1.5" : "min-w-0 space-y-2.5", className)}>
      <p id={titleId} className={cn("text-[12px] font-semibold tracking-[0.08em] text-brand-text uppercase", list && "px-1.5")}>
        {title}
      </p>
      {list ? (
        <ul className="space-y-0.5">
          {steps.map((s) => (
            <li key={s.id}>
              <StepLink step={s} variant="list" onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      ) : (
        // Phones: one rail that scrolls sideways inside its own box (the page never does); wider screens: pills that wrap.
        <ul className="scrollbar-none flex gap-2.5 overflow-x-auto overscroll-x-contain max-md:snap-x max-md:snap-mandatory md:flex-wrap md:overflow-visible">
          {steps.map((s) => (
            <li key={s.id} className="shrink-0 snap-start">
              <StepLink step={s} variant="row" onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepLink({ step, variant, onNavigate }: { step: NextStep; variant: "row" | "list"; onNavigate?: () => void }) {
  const row = variant === "row";
  return (
    // The address carries the result itself: no prefetch (it is a page the studio fills in on arrival).
    <Link
      href={step.href}
      prefetch={false}
      onClick={onNavigate}
      className={cn(
        "nav-row flex items-center",
        row ? "h-[52px] gap-2.5 rounded-[14px] border bg-card pr-4 pl-1.5 text-card-foreground nav-hover:border-border-strong" : "min-h-12 gap-2.5 rounded-[10px] px-1.5 py-1.5",
      )}
    >
      <CoverThumb id={step.cover} size="pill" icon="Sparkles" className={row ? undefined : "size-9 rounded-lg"} />
      <span className={cn("flex min-w-0 flex-col leading-tight", !row && "flex-1")}>
        <span className={cn("text-[13.5px] font-semibold", row ? "whitespace-nowrap" : "truncate")}>{step.verb}</span>
        <span className={cn("text-[11.5px] text-muted-foreground", row ? "whitespace-nowrap" : "truncate")}>{step.where}</span>
      </span>
      {!row && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// A handed-over picture on studios without the composer's hand-off (Character Sheet, Image to 3D)

/**
 * A Fuobe file address (`/api/files/…`) a link may hand over, else undefined: no other site's address, and no
 * `..` segment (written or %-encoded) that would step out of the files route.
 */
export function handoffFile(v: string | null | undefined): string | undefined {
  if (!v || !/^\/api\/files\/[\w./%-]{1,300}$/.test(v)) return undefined;
  return /\.\.|%2e/i.test(v) ? undefined : v;
}

/**
 * Reads `?image=` (a result sent here by "Keep going with this"): a Fuobe file is passed to `onImage`, then the param
 * is taken out of the address (router.replace), so a reload or Back doesn't add it again. `onImage` must be stable
 * (useCallback) and may run twice in development (Strict Mode): it should ignore a picture it already has. Under its
 * own Suspense: it reads the URL, so the static shell renders without it.
 */
export function HandoffImage({ onImage }: { onImage: (url: string) => void }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("image");
  useEffect(() => {
    if (raw === null) return;
    const url = handoffFile(raw);
    if (url) onImage(url);
    const rest = new URLSearchParams(sp.toString());
    rest.delete("image");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [raw, sp, router, pathname, onImage]);
  return null;
}
