"use client";

import { ArrowRight, Loader2, Plus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StepFlow } from "@/components/canvas/template-card";
import { useEngine, useIsOwner } from "@/lib/api";
import { responseError, toastError } from "@/lib/refusals";
import { STARTER_SURFACES, VISITOR_MAKES, starterHref, starterShown, type OwnerStarters, type StarterCardData, type StarterFill, type StarterSurface } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { StarterCard } from "./starter-card";
import { StarterIcon } from "./starter-icon";
import { StepsGlyph } from "./steps-glyph";

/**
 * A studio's starters for the viewer: the covered ones its page was given (everyone's), and for the owner every one,
 * loaded once from GET /api/starters (a starter with no cover yet never reaches a visitor's page). `fills`: what each
 * one puts in its composer (Content Factory, Explainer), the owner's with the starter's narrator sample.
 */
export function useStarters(surface: StarterSurface, starters: StarterCardData[], fills: Record<string, StarterFill> = {}) {
  const owner = useIsOwner();
  const q = useQuery({
    queryKey: ["starters", surface],
    queryFn: async (): Promise<OwnerStarters> => {
      const res = await fetch(`/api/starters?surface=${encodeURIComponent(surface)}`);
      if (!res.ok) throw new Error("Starters didn't load");
      return (await res.json()) as OwnerStarters;
    },
    enabled: owner,
    staleTime: 5 * 60_000,
  });
  const mine = owner ? q.data : undefined;
  return { owner, starters: mine?.starters ?? starters, fills: mine ? { ...fills, ...mine.fills } : fills };
}

/**
 * The owner's "Use template": a starter made on the server (POST /api/starters/<id>) opens where it answers; one that
 * fills a composer fills it here (`onFill`, on its own studio's page) or opens its studio with `?starter=`.
 */
export function useStarterUse(onFill?: (id: string) => void) {
  const router = useRouter();
  const qc = useQueryClient();
  const [engine] = useEngine();
  const [making, setMaking] = useState<string | null>(null);
  // The page it opens may be this one (Click to Ad, Marketing Studio): busy until that address has rendered.
  const [opening, setOpening] = useState<string | null>(null);
  const [navigating, startTransition] = useTransition();
  const use = async (s: StarterCardData) => {
    if (s.use.kind === "fill" || s.use.kind === "link") {
      if (onFill && s.use.kind === "fill") onFill(s.id);
      else router.push(s.use.href);
      return;
    }
    setMaking(s.id);
    try {
      const res = await fetch(`/api/starters/${encodeURIComponent(s.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine }) });
      const body = (await res.json().catch(() => ({}))) as { href?: string; note?: string; error?: string };
      if (!res.ok || !body.href) throw responseError(res, body.error ?? "That starter couldn't be made. Please try again.");
      // What it made (a brand, a product, a channel, a film, an element) is in the lists the next page picks it from,
      // before it opens.
      await Promise.all(
        [["brands"], ["products"], ["faceless"], ["cinema", "projects"], ["elements"]].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
      const href = body.href;
      // What to do with it next (an element's @name), where it opens.
      if (body.note) toast.success(body.note);
      setOpening(s.id);
      startTransition(() => router.push(href));
    } catch (e) {
      toastError(e);
    } finally {
      setMaking(null);
    }
  };
  return { use, busy: making ?? (navigating ? opening : null) };
}

/**
 * One starter as a card: the whole card opens its page; the owner's action makes or fills it. A link starter (the
 * Library's) opens its studio, with everything loaded, for everyone.
 */
export function StarterTile({ s, owner, busy, onUse, wide, compact }: { s: StarterCardData; owner: boolean; busy: boolean; onUse: () => void; wide?: boolean; compact?: boolean }) {
  const link = s.use.kind === "link";
  return (
    <StarterCard
      wide={wide}
      compact={compact}
      coverKey={s.coverKey}
      cover={s.cover}
      hue={s.hue}
      flow={<StepFlow steps={s.flow} />}
      overlay={<StepsGlyph steps={s.steps.length} className="p-6" />}
      icon={<StarterIcon name={s.icon} className="size-4" />}
      title={s.name}
      description={s.description}
      href={starterHref(s, owner)}
      coverTop={s.coverTop}
      badge={owner && !s.cover ? "No cover yet" : undefined}
      action={
        link ? (
          <span className="inline-flex items-center gap-1 text-[13px] font-medium text-foreground">
            Open it <ArrowRight className="size-3.5 transition-transform group-hover/starter:translate-x-0.5" />
          </span>
        ) : owner || VISITOR_MAKES.has(s.surface) ? (
          <Button size="sm" className="w-fit rounded-full" onClick={onUse} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Use template
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 text-[13px] font-medium text-foreground">
            See how it works <ArrowRight className="size-3.5 transition-transform group-hover/starter:translate-x-0.5" />
          </span>
        )
      }
    />
  );
}

/**
 * A surface's ready-made starters ("Start from a ready channel"…): every one for the owner (a card with no cover yet is
 * marked), only those with their real cover for a guest or an account. Nothing at all when there is none to show.
 * `row`: one short row (the first three, "See all" for the rest), under the person's own work; a snap scroller on a phone.
 */
export function StarterSection({
  surface: surfaceId,
  starters: given,
  row = false,
  onFill,
  className,
  headingLevel = "h2",
  narrow = false,
  center = false,
  compact = false,
  hide,
}: {
  surface: StarterSurface;
  /** The covered starters the page was given; the owner's view adds the rest (useStarters). */
  starters: StarterCardData[];
  row?: boolean;
  onFill?: (id: string) => void;
  className?: string;
  headingLevel?: "h2" | "h3";
  /** In a narrow column (Explainer's history): two cards a row at most. */
  narrow?: boolean;
  /** Under a centred hero: the section centred, at the width of its cards. */
  center?: boolean;
  /** On a phone, each card as a thumbnail beside its words (Marketing Studio's, above its docked composer). */
  compact?: boolean;
  /** Starters this viewer has already made (an element saved from one): left out of the row. */
  hide?: (s: StarterCardData) => boolean;
}) {
  // Until the viewer is known to be the owner, the page is a visitor's: only starters with their real cover show.
  const { owner, starters } = useStarters(surfaceId, given);
  const { use, busy } = useStarterUse(onFill);
  const [all, setAll] = useState(false);
  const shown = starters.filter((s) => starterShown(s, !owner) && !hide?.(s));
  if (!shown.length) return null;
  const surface = STARTER_SURFACES[surfaceId];
  const items = row && !all ? shown.slice(0, 3) : shown;
  // Two cards or fewer: two columns at most, so no column stands empty beside them, with wider, lower covers. Four:
  // two by two, or one row of four on a wide screen, never three and one.
  const few = items.length <= 2;
  const four = items.length === 4;
  const H = headingLevel;
  // A snap row on a phone reaches the screen's edges: it steps out of the page's 16 px gutter and snaps back inside it.
  const snap = row && !all && items.length > 1;
  return (
    <section id="starters" aria-labelledby="starters-title" className={cn("scroll-mt-20", center && few && !narrow && "mx-auto w-full lg:max-w-[880px]", className)}>
      <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <H id="starters-title" className="font-heading text-[24px] leading-tight">
            {surface.section}
          </H>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{owner ? surface.note : (surface.visitorNote ?? surface.note)}</p>
        </div>
        {row && shown.length > 3 && (
          <button type="button" onClick={() => setAll((v) => !v)} className="text-[13px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {all ? "Show fewer" : "See all"}
          </button>
        )}
      </div>
      <div
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2",
          !narrow && !few && (four ? "xl:grid-cols-4" : "lg:grid-cols-3"),
          !narrow && few && "lg:max-w-[880px]",
          snap && "-mx-4 flex scroll-px-4 snap-x snap-mandatory overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:scroll-px-0 sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:w-[78%] [&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:w-auto",
        )}
      >
        {items.map((s) => (
          <StarterTile key={s.id} s={s} owner={owner} busy={busy === s.id} onUse={() => void use(s)} wide={few && !narrow} compact={compact} />
        ))}
      </div>
    </section>
  );
}
