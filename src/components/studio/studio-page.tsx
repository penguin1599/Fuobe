"use client";

import { ArrowRight, ArrowUp, Loader2, Upload, Zap } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { HeaderPill } from "@/components/gpu/readiness-chip";
import { badgeFor, openGpuSetup, useGpuBadges } from "@/hooks/use-gpu";
import type { Generation } from "@/lib/catalog/types";
import { GUEST_PROMPT_EVENT, useEngine, useGenerations, useHydrated, useIsGuest, useLikelyVisitor } from "@/lib/api";
import { claimStartToken, followEngineDefault, handoffKey, mergeHandoff, promptShown, relatedHref, START_PARAM, withoutStart, withPreset } from "@/lib/composer";
import { presetGpuKey } from "@/lib/catalog/preset-recipe-routes";
import { editableLayout, EDIT_LAYOUT_PARAM, readEditLayoutParam } from "@/lib/output-actions";
import { movedAppRequest } from "@/lib/catalog/plan";
import { migrateRequest } from "@/lib/catalog/replaced";
import { SoulPresetCards } from "@/components/moodboards/soul-preset-cards";
import type { StudioCatalog } from "@/lib/studio-catalog";
import { EXAMPLE_PARAM, exampleFits, exampleKey, type ExampleCard, type ExampleRowData } from "@/lib/examples/types";
import { ExampleRowSkeleton } from "@/components/examples/example-row-frame";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { ComposerBridgeCtx, useComposerBridge, type ComposerBridge } from "./attachments";
import { CatalogProvider, useCatalog } from "./catalog";
import { Composer } from "./composer";
import { EngineSwitch } from "./engine-switch";
import { HubHeaderExtras, useInHub } from "./hub-chrome";
import { Feed } from "./feed";
import { applyExample, draftFromGeneration, initialDraft, slot } from "./draft";
import { PresetUrlCtx, StartRequestCtx, StudioProvider, usePresetUrl, useStudio, useStudioActions, type Draft, type StudioConfig } from "./studio-context";

// The example cards (and the clip player they bring) are their own chunk: a page with no examples never loads them.
// The row loads under its own Suspense boundary (StudioExamples), whose fallback is the row's skeleton: the same heading
// and card shapes, sized from the row itself, so nothing moves when the cards arrive.
const ExampleRow = lazy(() => import("@/components/examples/example-cards").then((m) => ({ default: m.ExampleRow })));
const ExampleStrip = dynamic(() => import("@/components/examples/example-cards").then((m) => m.ExampleStrip), { loading: () => null });
const ExamplesButton = dynamic(() => import("@/components/examples/example-cards").then((m) => m.ExamplesButton), { loading: () => null });

// Live edit's panel (the Edit studio's Live switch) loads on the first switch.
const LiveEditPanel = dynamic(() => import("@/components/live/live-edit-app").then((m) => m.LiveEditPanel), { ssr: false });

/** The Live switch: the picture changes as you type, on the viewer's own GPU (whatever the engine). */
function LiveSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="Live: the picture changes as you type (runs on your GPU)"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
        on ? "border-primary/40 bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      data-live-switch
    >
      <Zap className="size-3.5" />
      Live
    </button>
  );
}

/** The Live panel, seeded with the composer's picture and words; "Use in Edit" puts the kept picture back in the composer. */
function LiveArea({ onClose }: { onClose: () => void }) {
  const { draft, setSlot } = useStudio();
  const [seed] = useState(() => ({ image: draft.slots.image?.ref, text: draft.prompt }));
  return (
    <LiveEditPanel
      image={seed.image}
      text={seed.text}
      onClose={onClose}
      onUse={(url) => {
        setSlot("image", slot(url));
        onClose();
        toast.success("The kept picture is in Edit");
      }}
    />
  );
}

/**
 * New results land at the top of the feed while the composer is docked at the bottom: when one
 * arrives off-screen (you scrolled down into your history), a pill above the composer jumps to it (U4).
 */
function useOffscreenResults(items: Generation[] | undefined) {
  const since = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  useEffect(() => {
    since.current = Date.now() - 2000;
  }, []);
  useEffect(() => {
    if (!items) return;
    if (!seen.current) {
      seen.current = new Set(items.map((g) => g.id));
      return;
    }
    const known = seen.current;
    const added = items.filter((g) => !known.has(g.id) && g.createdAt >= since.current);
    items.forEach((g) => known.add(g.id));
    if (!added.length) return;
    const raf = requestAnimationFrame(() => {
      const off = added.filter((g) => !inView(g.id)).map((g) => g.id);
      if (off.length) setFresh((f) => [...new Set([...off, ...f])]);
    });
    return () => cancelAnimationFrame(raf);
  }, [items]);
  // Clear the ones you scrolled to.
  const pending = fresh.length > 0;
  useEffect(() => {
    if (!pending) return;
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setFresh((f) => (f.some(inView) ? f.filter((id) => !inView(id)) : f)));
    };
    window.addEventListener("scroll", check, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", check, { capture: true });
    };
  }, [pending]);
  const present = fresh.filter((id) => items?.some((g) => g.id === id));
  const working = present.filter((id) => items?.some((g) => g.id === id && (g.status === "queued" || g.status === "running"))).length;
  const jump = () => {
    document.querySelector(`[data-gen-id="${present[0]}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFresh([]);
  };
  return { count: present.length, working, jump };
}

function inView(id: string): boolean {
  const el = document.querySelector(`[data-gen-id="${id}"]`);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 56 && r.top < window.innerHeight - 160;
}

const EMPTY: Generation[] = [];

// ---------------------------------------------------------------------------
// "Start from an example": one tap puts an example's files, words and settings into this composer

interface ExamplesApi {
  /** The page's own cards (its studio's, or its app's). */
  cards: ExampleCard[];
  /** The page's own surface ("studio:video", "app:<id>"…): a linked example loads only when it belongs here. */
  surface?: string;
  /** The example last loaded (exampleKey), while the draft is still its. */
  activeId?: string;
  /** Load a card, asking first when the draft holds the visitor's own words or files. */
  use: (card: ExampleCard) => void;
  /** Load a card at once (`quiet`: no message, no scroll: the page opened on it). */
  apply: (card: ExampleCard, quiet?: boolean) => void;
}

const ExamplesCtx = createContext<ExamplesApi | null>(null);
const NO_CARDS: ExampleCard[] = [];

/** The surface of a preset's examples: an app's page, or a motion's or effect's in the Video studio. */
const surfaceOf = (presetId: string) => (presetId.startsWith("app-") ? `app:${presetId}` : `preset:${presetId}`);

/**
 * A preset's examples: on its own page, the page's cards; a motion or effect picked in the Video studio fetches its own
 * when picked (the page doesn't carry every preset's).
 */
function usePresetExamples(presetId: string | undefined): ExampleCard[] {
  const { config } = useStudioActions();
  const loader = useContext(ExamplesCtx);
  const own = !!presetId && presetId === config.preset?.id;
  const fetched = useQuery({
    queryKey: ["examples", presetId],
    enabled: !!presetId && !own,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/examples?surface=${encodeURIComponent(surfaceOf(presetId!))}`);
      return res.ok ? ((await res.json()) as { cards: ExampleCard[] }).cards : [];
    },
  });
  if (!presetId) return NO_CARDS;
  if (own) return loader?.cards.filter((c) => c.load.via !== "look") ?? NO_CARDS;
  return fetched.data ?? NO_CARDS;
}

/** What the visitor put in themselves: their words and their files (an example's own don't count). */
const ownContent = (d: Draft) => JSON.stringify([d.prompt.trim(), Object.entries(d.slots).flatMap(([k, v]) => (v?.ref ? [[k, v.ref]] : [])), d.refs.map((r) => r.ref)]);
const isEmpty = (d: Draft) => !d.prompt.trim() && !Object.values(d.slots).some((v) => v?.ref) && !d.refs.length;

/** Loads examples into the composer for every card on the page (the row, a preset's strip, the sheet, `?example=`). */
function ExampleLoader({ cards, surface, baseFor, children }: { cards: ExampleCard[]; surface?: string; baseFor: (presetId?: string) => Draft; children: React.ReactNode }) {
  const { config, draft, setDraft } = useStudio();
  const catalog = useCatalog();
  const presetUrl = usePresetUrl();
  const [loadedAs, setLoadedAs] = useState<{ id: string; content: string } | null>(null);
  const [pending, setPending] = useState<ExampleCard | null>(null);
  const latest = useRef(draft);
  useLayoutEffect(() => {
    latest.current = draft;
  });
  // The ring stays while the draft is still the example's own.
  const activeId = loadedAs && ownContent(draft) === loadedAs.content ? loadedAs.id : undefined;
  const baseRef = useRef(baseFor);
  useLayoutEffect(() => {
    baseRef.current = baseFor;
  });
  const apply = useCallback(
    (card: ExampleCard, quiet = false) => {
      if (card.load.via !== "draft") return;
      const req = card.load.request;
      const next = applyExample(req, baseRef.current(req.presetId), config, catalog);
      setDraft(next);
      setLoadedAs({ id: exampleKey(card), content: ownContent(next) });
      // A motion or effect goes into the address, as picking it does; one that isn't the example's comes out.
      if (!config.preset && (req.presetId || latest.current.presetId)) presetUrl(req.presetId);
      if (quiet) return;
      toast("Example loaded. Change anything, then Generate.", { id: "example-loaded" });
      requestAnimationFrame(() => {
        // This studio's composer: a studio left earlier stays in the page, hidden, with a composer of its own.
        const composer = [...document.querySelectorAll<HTMLElement>("[data-studio] [data-composer]")].find((el) => el.offsetParent !== null);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        composer?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
        // A desktop types next; a phone keeps its keyboard down so the example stays in view.
        if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) composer?.querySelector("textarea")?.focus({ preventScroll: true });
      });
    },
    [config, catalog, setDraft, presetUrl],
  );
  const loadedRef = useRef(loadedAs);
  useLayoutEffect(() => {
    loadedRef.current = loadedAs;
  });
  const use = useCallback(
    (card: ExampleCard) => {
      if (card.load.via !== "draft") return;
      const d = latest.current;
      const was = loadedRef.current;
      // An empty composer is replaced at once; one with words or files the visitor added asks first.
      const own = !isEmpty(d) && (!was || ownContent(d) !== was.content);
      if (own) setPending(card);
      else apply(card);
    },
    [apply],
  );
  const value = useMemo<ExamplesApi>(() => ({ cards, surface, activeId, use, apply }), [cards, surface, activeId, use, apply]);
  return (
    <ExamplesCtx.Provider value={value}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace what&apos;s in the composer?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.inputs.length ? "The example's files, words and settings take the place of yours." : "The example's words and settings take the place of yours."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep mine</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) apply(pending);
                setPending(null);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ExamplesCtx.Provider>
  );
}

/**
 * `?example=<id>`: the page opens with that example loaded (once per id), the page's own card or a fetched one that
 * belongs here (exampleFits: an effect's example never lands in the Image composer).
 */
function ExampleHandoff() {
  const sp = useSearchParams();
  const id = sp.get(EXAMPLE_PARAM);
  const loader = useContext(ExamplesCtx);
  const catalog = useCatalog();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !loader || !catalog.ready || done.current === id) return;
    done.current = id;
    const go = (c: ExampleCard | undefined | null) => {
      // After the link's other hand-off params are in (HandoffSync), so they don't land over it.
      if (c?.load.via === "draft") setTimeout(() => loader.apply(c, true), 0);
    };
    const local = loader.cards.find((c) => c.id === id);
    if (local) return go(local);
    void fetch(`/api/examples?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ card?: ExampleCard; surface?: string }>) : null))
      .then((j) => go(j && exampleFits(j.surface, loader.surface) ? j.card : null))
      .catch(() => {});
  }, [id, loader, catalog.ready]);
  return null;
}

/** The preset card (U23) is its own chunk: only app pages and studios with a motion or effect picked load it. */
const PresetHeader = dynamic(() => import("@/components/preset-header").then((m) => m.PresetHeader));

/** While a preset (app, camera motion, effect) is active and the feed is empty: what it does and what to add, above the composer. */
function ActivePresetHeader() {
  const { config, draft, setDraft } = useStudio();
  const catalog = useCatalog();
  const presetUrl = usePresetUrl();
  const preset = draft.presetId ? catalog.getPreset(draft.presetId) : config.preset;
  const examples = usePresetExamples(preset?.id);
  const loader = useContext(ExamplesCtx);
  if (!preset) return null;
  return (
    <PresetHeader
      preset={preset}
      className="mb-3"
      examples={examples.length ? <ExampleStrip cards={examples} activeId={loader?.activeId} onPick={(c) => loader?.use(c)} /> : undefined}
      modelName={(id) => catalog.getModel(id)?.name}
      gpuKey={presetGpuKey(
        preset,
        (id) => !!catalog.getModel(id),
        draft.modelId,
        draft.params.extra?.quality,
        catalog.getModel(draft.modelId)?.options.controls?.find((c) => c.param === "quality")?.default,
      )}
      onClear={
        config.preset
          ? undefined
          : () => {
              presetUrl(undefined);
              setDraft({ presetId: undefined, mix: undefined, presetStrength: undefined });
            }
      }
    />
  );
}

/**
 * The line under the hero. It follows the picked model: a relight that matches a light picked on a sphere (H3 Max relight)
 * takes no words, so it says to pick a light.
 */
function StudioSubtitle({ text }: { text: string }) {
  const { draft } = useStudio();
  const catalog = useCatalog();
  const sphere = !!catalog.getModel(draft.modelId)?.options.lightSphere;
  return <p className="mt-2 max-w-xl text-[13px] text-muted-foreground">{sphere ? "Pick a light — its direction, colour and softness — and the shot is relit to match." : text}</p>;
}

/**
 * Example prompts under the hero. Its own component: it follows the picked model (a model that
 * takes no prompt, like FASHN try-on, gets none), so it re-renders with the draft, not the page.
 */
function PromptSuggestions({ suggestions }: { suggestions: string[] }) {
  const { config, draft, setDraft } = useStudio();
  const catalog = useCatalog();
  const preset = draft.presetId ? catalog.getPreset(draft.presetId) : config.preset;
  const model = catalog.getModel(draft.modelId);
  if (!promptShown(config.hidePrompt, preset?.userPrompt, model?.options.promptless)) return null;
  return (
    <div className="mt-4 flex w-full min-w-0 flex-wrap justify-center gap-2">
      {suggestions.map((s) => (
        <button
          key={s}
          onClick={() => setDraft({ prompt: s })}
          className="h-8 max-w-full truncate rounded-full border bg-background px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {s.length > 48 ? `${s.slice(0, 46)}…` : s}
        </button>
      ))}
    </div>
  );
}

/** The space between the composer (or what sits right under it) and each section below it. */
const UNDER_COMPOSER = "mt-10 sm:mt-12";

/** The empty composer's width (its column's max-w-[760px]): the row's cards show at that width's share. */
const COMPOSER_WIDTH = 760;

/**
 * How long a guest's row waits for the feed's answer before it shows its cards anyway: a slow feed never leaves grey
 * tiles. A guest has no results of their own, so the cards stay.
 */
const FEED_WAIT_MS = 3000;

/** The cards' code, fetched as soon as the row's skeleton draws: the feed and the code load side by side. */
const preloadExampleCards = () => void import("@/components/examples/example-cards").catch(() => {});

/**
 * "Start from an example" under the empty composer (src/lib/examples): each card loads its own files, words and settings
 * into this composer. Hidden while a motion or effect is picked: its own examples are in its card above the composer.
 * The row fills the composer's column, so its heading and cards line up with the composer. Until the feed has answered
 * (`ready`; for a guest FEED_WAIT_MS at most) and while the cards' code loads, its skeleton holds the same place. A
 * signed-in viewer waits for the feed: with results of their own, the cards (and their covers) are never fetched.
 */
function StudioExamples({ row, ready }: { row: ExampleRowData; ready: boolean }) {
  const { draft, config } = useStudio();
  const loader = useContext(ExamplesCtx);
  const guest = useIsGuest();
  const [waited, setWaited] = useState(false);
  useEffect(preloadExampleCards, []);
  useEffect(() => {
    if (ready || !guest) return;
    const timer = setTimeout(() => setWaited(true), FEED_WAIT_MS);
    return () => clearTimeout(timer);
  }, [ready, guest]);
  if (draft.presetId && draft.presetId !== config.preset?.id) return null;
  // An app's page shows its examples in its card above the composer.
  if (config.preset && row.cards.some((c) => c.load.via !== "look")) return null;
  const skeleton = <ExampleRowSkeleton row={row} layout="column" className={UNDER_COMPOSER} />;
  if (!ready && !(guest && waited)) return skeleton;
  return (
    <Suspense fallback={skeleton}>
      <ExampleRow row={row} activeId={loader?.activeId} onPick={(c) => loader?.use(c)} layout="column" maxWidth={COMPOSER_WIDTH} className={UNDER_COMPOSER} />
    </Suspense>
  );
}

/** Once there are results, "Examples" beside the composer opens the cards: a picked motion's or effect's, else the page's. */
function DockedExamples() {
  const { draft, config } = useStudio();
  const loader = useContext(ExamplesCtx);
  const presetCards = usePresetExamples(draft.presetId && draft.presetId !== config.preset?.id ? draft.presetId : undefined);
  const cards = presetCards.length ? presetCards : (loader?.cards ?? []).filter((c) => c.load.via !== "look");
  if (!loader || !cards.length) return null;
  return <ExamplesButton cards={cards} activeId={loader.activeId} onPick={loader.use} />;
}

/**
 * The picked open model's state on the viewer's GPU (the GPU pre-flight), left of the engine switch: a pill that opens
 * the guided fix. Its own component, so the draft it reads re-renders only this.
 */
function StudioGpuPill() {
  const { config, draft } = useStudio();
  const catalog = useCatalog();
  const [engine] = useEngine();
  const badges = useGpuBadges().data;
  if (engine !== "open" || !badges?.connected) return null;
  const modelId = draft.modelId || config.defaultModels.open;
  const presetId = draft.presetId ?? config.preset?.id;
  // A preset's badge describes its route on the model picked, at the route's Quality (presetGpuKey, as the composer).
  const p = presetId ? catalog.getPreset(presetId) : undefined;
  const m = catalog.getModel(modelId);
  const key = p ? presetGpuKey(p, (id) => !!catalog.getModel(id), modelId, draft.params.extra?.quality, m?.options.controls?.find((c) => c.param === "quality")?.default) : undefined;
  const preset = key ? badges.presets[key] : undefined;
  const op = config.ops.find((o) => badges.models[`${modelId}#${o}`]);
  const badge = preset ?? (op ? badges.models[`${modelId}#${op}`] : badgeFor(badges, { modelId }));
  if (!badge) return null;
  const ref = preset && key ? `preset:${key}` : `model:${modelId}#${op ?? Object.keys(badges.models).find((k) => k.startsWith(`${modelId}#`))?.split("#")[1] ?? ""}`;
  return <HeaderPill badge={badge} gpu={badges.gpu} compact onOpen={() => openGpuSetup({ ref })} />;
}

/**
 * Sticky page header (title + engine), with an optional row of mode tabs under it. Inside a hub (Audio, Upscale) the hub's
 * layout draws the bar, the tabs and the engine switch, so they stay put across modes: the studio adds only its own controls.
 */
function StudioHeader({ title, header, tabs }: { title: string; header?: React.ReactNode; tabs?: React.ReactNode }) {
  const [engine, setEngine] = useEngine();
  const inHub = useInHub();
  if (inHub)
    return (
      <HubHeaderExtras>
        {header}
        <StudioGpuPill />
      </HubHeaderExtras>
    );
  return (
    <div className="max-md:sticky top-chrome z-20 bg-background/85 backdrop-blur">
      <header className="flex h-14 items-center gap-2 px-4 sm:px-6">
        <h1 className="min-w-0 truncate font-heading text-[22px] leading-[1.15]">{title}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {header}
          <StudioGpuPill />
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
        <PhoneNavButton />
      </header>
      {tabs}
    </div>
  );
}

function StudioBody({ header, tabs, examples }: { header?: React.ReactNode; tabs?: React.ReactNode; examples?: ExampleRowData }) {
  // Config and actions only: the draft lives in the composer, so typing doesn't re-render the page or the feed.
  const { config, setDraft } = useStudioActions();
  const [engine, setEngine, engineMode] = useEngine();
  // The engine is the browser's own: a link that names its model (Lipsync → Kandinsky) waits for it, so the page hydrates as rendered.
  const hydrated = useHydrated();
  // A GPU-only step isn't offered while the install runs paid APIs only. A guest or an account sees none: each step
  // opens a tool that runs on a self-hosted Fuobe only.
  const visitor = useLikelyVisitor();
  const firstSteps = visitor ? undefined : config.firstSteps?.filter((f) => !f.openOnly || engineMode !== "cloud");
  const feed = useGenerations(config.feed);
  const bridge = useComposerBridge();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const items = feed.data ?? EMPTY;
  // While the feed loads (and in the prerendered shell) the page shows the hero and the composer, never a blank area.
  const hasItems = items.length > 0;
  const offscreen = useOffscreenResults(feed.data);
  const catalog = useCatalog();
  const [live, setLive] = useState(false);
  const inHub = useInHub();

  const reuse = useCallback(
    (g: Generation) => {
      setDraft(draftFromGeneration(g, config, catalog.getModel, catalog.getPreset));
      // A run on a model (or an operation) Fuobe retired, or an app's old model, comes back on what replaced it: say what changed.
      const retired = migrateRequest(g.request);
      const moved = retired.note ?? movedAppRequest(retired.request, catalog.getModel, catalog.getPreset).note;
      if (moved) toast(moved);
      if (g.engine !== engine) setEngine(g.engine);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus());
    },
    [catalog, config, engine, setDraft, setEngine],
  );

  return (
    <div
      data-studio
      className={cn("relative flex min-w-0 flex-col", inHub ? "flex-1" : "min-h-content")}
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        if (bridge?.current) bridge.current(files);
        else toast("Drop it on the composer");
      }}
    >
      <StudioHeader
        title={config.title}
        header={
          config.live ? (
            <>
              {/* Live always runs on the viewer's GPU: the engine switch has no say while it is on. */}
              {live ? (
                <span className="inline-flex cursor-not-allowed" title="Live runs on your GPU">
                  <span className="pointer-events-none inline-flex opacity-40" aria-disabled>
                    {header}
                  </span>
                </span>
              ) : (
                header
              )}
              <LiveSwitch on={live} onChange={setLive} />
            </>
          ) : (
            header
          )
        }
        tabs={tabs}
      />

      {live && (
        <div className="mx-auto w-full max-w-[1240px] min-w-0 flex-1 px-4 pb-4 sm:px-6">
          <div className="h-[calc(var(--content-h)-4.5rem)] min-h-[520px]">
            <LiveArea onClose={() => setLive(false)} />
          </div>
        </div>
      )}
      <div className={cn("mx-auto w-full max-w-[1240px] min-w-0 px-4 sm:px-6", hasItems && "flex-1 pb-8", live && "hidden")}>
        {hasItems ? (
          <div className="pt-4">
            <Feed items={items} onReuse={reuse} />
          </div>
        ) : (
          <div className="flex flex-col items-center pt-6 text-center sm:pt-[16vh]">
            <h2 className="font-heading text-display text-balance">{config.hero}</h2>
            {config.subtitle && <StudioSubtitle text={config.subtitle} />}
            {config.related && (
              <Link href={hydrated ? relatedHref(config.related, engine) : config.related.href} className="mt-3 inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                {config.related.label}
                <ArrowRight className="size-3" />
              </Link>
            )}
            {firstSteps?.length ? (
              <ul aria-label="Before upscaling" className="mt-3 flex max-w-xl flex-col items-center gap-2">
                {firstSteps.map((f) => (
                  <li key={f.id} className="flex flex-col items-center gap-1">
                    <Link
                      href={f.href}
                      aria-describedby={`first-step-${f.id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {f.label}
                      <ArrowRight className="size-3" />
                    </Link>
                    <span id={`first-step-${f.id}`} className="text-[12px] text-pretty text-muted-foreground">
                      {f.hint}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      {/* One composer for both layouts (centred under the hero, docked under the feed), so it keeps focus and state when the first result arrives. */}
      <div
        className={cn(
          live && "hidden",
          hasItems
            ? "sticky bottom-chrome z-20 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
            : "px-4 pt-6 sm:px-6 sm:pt-10",
        )}
      >
          {hasItems && offscreen.count > 0 && (
            <div className="pointer-events-none absolute inset-x-0 -top-2 flex justify-center">
              <button
                onClick={offscreen.jump}
                className="pointer-events-auto inline-flex h-8 animate-pop-in items-center gap-1.5 rounded-full bg-foreground px-3.5 text-[13px] font-medium text-background shadow-strong transition hover:opacity-90"
              >
                {offscreen.working ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {offscreen.working ? `${offscreen.working} generating` : `${offscreen.count} new result${offscreen.count === 1 ? "" : "s"}`}
                <ArrowUp className="size-3.5" />
              </button>
            </div>
          )}
        {/* Its own boundary: the card's code loads on the first pick, and only the card waits for it, not the whole studio. */}
        {!hasItems && (
          <Suspense fallback={null}>
            <ActivePresetHeader />
          </Suspense>
        )}
        {hasItems && (
          <div className="mx-auto -mt-2 mb-1 flex w-full max-w-[800px] justify-start">
            <DockedExamples />
          </div>
        )}
        <div data-composer className={cn("mx-auto w-full", hasItems ? "max-w-[800px]" : "max-w-[760px]")}>
          <Composer docked={hasItems} />
        </div>
      </div>

      {/* What sits under the empty composer, in the composer's own column: its suggestions right under it, then each
          section a clear step below; the space under them only when there is something. Hidden, not unmounted, while Live
          is on: the page around the panel keeps its state. */}
      <div className={cn("px-4 sm:px-6", (live || hasItems) && "hidden")}>
        <div data-under-composer className="mx-auto flex w-full max-w-[760px] min-w-0 flex-col pb-10 empty:hidden sm:pb-16">
          {/* Examples that load into the composer take the suggestions' place: they come first on a phone. */}
          {!hasItems && config.suggestions && !examples?.cards.some((c) => c.load.via !== "look") && <PromptSuggestions suggestions={config.suggestions} />}
          {!hasItems && config.signature && <SoulPresetCards className={UNDER_COMPOSER} />}
          {/* The cards once the feed has answered (a studio with results would show the row, fetch its covers, then drop
              it); its skeleton until then, never a blank gap that fills in. */}
          {!hasItems && !!examples?.cards.length && <StudioExamples row={examples} ready={!feed.isPending} />}
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-overlay p-8">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background px-12 py-10 shadow-heavy">
            <Upload className="size-6 text-brand-text" />
            <p className="font-medium">Drop to attach</p>
            <p className="text-[13px] text-muted-foreground">Images, videos or audio · up to 200 MB</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface StudioPageProps {
  config: StudioConfig;
  /**
   * The models this studio needs, from the server (`studioCatalog(config)` in a server
   * component). Without it the page loads the catalog chunk itself.
   */
  catalog?: StudioCatalog;
  /** Extra header controls, left of the engine switch. */
  header?: React.ReactNode;
  /** A row under the header (mode tabs). */
  tabs?: React.ReactNode;
  initialRefs?: string[];
  /** Prompt to start with when the URL doesn't carry one (e.g. "@Maya "). */
  initialPrompt?: string;
  /**
   * "Start from an example" under the empty composer, or on an app's page inside its card (`exampleRow()` from
   * src/lib/examples/catalog.ts, in a server component).
   */
  examples?: ExampleRowData | null;
}

type DraftProps = Omit<StudioPageProps, "catalog">;

/** Reports the URL's hand-off params, and its start token (`go`), if any. It reads the URL, so it sits under its own Suspense: the static shell renders without it. */
function UrlParams({ onChange }: { onChange: (key: string, start: string | null) => void }) {
  const sp = useSearchParams();
  const key = handoffKey(sp);
  const start = sp.get(START_PARAM) || null;
  // Layout effect: on a client navigation the prefilled draft is in place before the first paint.
  useLayoutEffect(() => onChange(key, start), [key, start, onChange]);
  return null;
}

/**
 * Applies the URL's hand-off params (`/video?image=…`) to the draft once they're known: right
 * after hydration on a direct visit (the static shell can't know them), or on the first render
 * of a client navigation. Fields the person already changed — a prompt typed before the page
 * hydrated — are kept. A later change of the params (Animate → Video while on Video) starts a
 * fresh draft instead.
 *
 * With `go=<token>` (Home's Start) it then asks the composer to run the draft once (onStart), after
 * the draft was built from the loaded models, and takes `go` out of the address so a reload or Back
 * doesn't run it again. Only the one-time token this tab's Home issued starts a run: a `go` in a
 * link from elsewhere just prefills the studio, so no website or message can spend the user's keys.
 */
function HandoffSync({
  startKey,
  start,
  build,
  adopt,
  follow,
  ownRef,
  ready,
  onNavigate,
  onStart,
}: {
  startKey: string;
  start: Draft;
  build: React.RefObject<(key: string) => Draft>;
  adopt: React.RefObject<(key: string) => void>;
  /** The base after the composer's own engine swap (followEngineDefault). */
  follow: React.RefObject<(base: Draft, current: Draft) => Draft>;
  /** Set here: takes an address the studio wrote itself (a picked or cleared preset) as applied, so it isn't a navigation. */
  ownRef: React.RefObject<(key: string) => void>;
  ready: boolean;
  onNavigate: (key: string) => void;
  onStart: () => void;
}) {
  const { setDraft } = useStudioActions();
  const [url, setUrl] = useState<{ key: string; start: string | null } | null>(null);
  const applied = useRef({ key: startKey, ready, base: start, seen: false });
  const started = useRef(false);
  useLayoutEffect(() => {
    ownRef.current = (key) => void (applied.current.key = key);
  }, [ownRef]);
  const onParams = useCallback((key: string, start: string | null) => setUrl((u) => (u?.key === key && u.start === start ? u : { key, start })), []);
  useLayoutEffect(() => {
    if (url === null) return;
    const a = applied.current;
    if (a.seen && url.key !== a.key) return onNavigate(url.key);
    a.seen = true;
    if (url.key !== a.key || ready !== a.ready) {
      const next = build.current(url.key);
      const base = a.base;
      setDraft((d) => mergeHandoff(follow.current(base, d), d, next));
      adopt.current(url.key);
      applied.current = { key: url.key, ready, base: next, seen: true };
    }
    if (url.start && ready && !started.current) {
      started.current = true;
      if (claimStartToken(url.start)) onStart();
      window.history.replaceState(null, "", withoutStart(window.location.href));
    }
  }, [url, ready, build, adopt, follow, setDraft, onNavigate, onStart]);
  return (
    <Suspense fallback={null}>
      <UrlParams onChange={onParams} />
    </Suspense>
  );
}

/**
 * Edit layout (`/image?layout=<generation>[.<picture>]`, from a result's menu anywhere): the picture's boxes open in
 * Layout mode with its words, model and seed: the request's own layout, or the one fal's MOSS-Image planned (decoded at
 * the picture's size). The param isn't part of the hand-off key, so the draft on screen isn't reset first; it is taken
 * out of the address once read, so a reload doesn't open it again.
 */
function LayoutHandoff() {
  const sp = useSearchParams();
  const value = sp.get(EDIT_LAYOUT_PARAM);
  const { config, setDraft } = useStudioActions();
  const catalog = useCatalog();
  const [engine, setEngine] = useEngine();
  const opened = useRef<string | null>(null);
  const ref = config.layout ? readEditLayoutParam(value) : null;
  useEffect(() => {
    // Once the address no longer holds it (read, then taken out), the same picture's Edit layout opens again next time.
    if (!value) opened.current = null;
    if (!ref || !value || opened.current === value || !catalog.ready) return;
    opened.current = value;
    void fetch(`/api/generations/${encodeURIComponent(ref.id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("That picture isn't in your library any more");
        const g = (await res.json()) as Generation;
        const e = editableLayout(g, ref.index);
        if (!e) throw new Error("This picture has no layout to open");
        const base = draftFromGeneration(g, config, catalog.getModel, catalog.getPreset);
        const params = { ...(base.params ?? {}), ...(e.seed !== undefined && { seed: e.seed }) };
        setDraft({ ...base, prompt: e.caption, params, layout: { ...e.draft, summary: { ...e.draft.summary, caption: "" } } });
        if (g.engine !== engine) setEngine(g.engine);
        toast(e.seed !== undefined ? "Layout opened with the picture's seed: move a box or change a word, then generate" : "Layout opened: move a box or change a word, then generate", { id: "edit-layout" });
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus());
      })
      .catch((err: Error) => toast.error(err.message, { id: "edit-layout" }))
      .finally(() => {
        const u = new URL(window.location.href);
        u.searchParams.delete(EDIT_LAYOUT_PARAM);
        window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
      });
  }, [ref, value, catalog, config, engine, setDraft, setEngine]);
  return null;
}

/**
 * One draft's page: the studio and its hand-off. The start request resets with the draft (a new epoch).
 *
 * A guest's Start from Home opens "Create a free account" here instead of sending a run that can only be refused. It
 * opens after HandoffSync took `go` out of the address (a microtask), so the card's way back is the studio with the
 * prompt filled in. While who is looking isn't known yet, the run is sent and its refusal opens the same card.
 */
function StudioSession({
  header,
  tabs,
  examples,
  sync,
}: {
  header?: React.ReactNode;
  tabs?: React.ReactNode;
  examples?: ExampleRowData | null;
  sync: Omit<React.ComponentProps<typeof HandoffSync>, "onStart">;
}) {
  const [startRequest, setStartRequest] = useState(0);
  const guest = useIsGuest();
  const onStart = useCallback(() => {
    if (guest) queueMicrotask(() => window.dispatchEvent(new CustomEvent(GUEST_PROMPT_EVENT, { detail: { action: "run" } })));
    else setStartRequest((n) => n + 1);
  }, [guest]);
  return (
    <StartRequestCtx.Provider value={startRequest}>
      <StudioBody header={header} tabs={tabs} examples={examples ?? undefined} />
      <HandoffSync {...sync} onStart={onStart} />
      <Suspense fallback={null}>
        <ExampleHandoff />
      </Suspense>
      <Suspense fallback={null}>
        <LayoutHandoff />
      </Suspense>
    </StartRequestCtx.Provider>
  );
}

/**
 * The studio. It renders the same tree in the static shell and after hydration (the URL is read
 * by HandoffSync alone), so the composer the shell painted is the one you type into: nothing
 * typed or focused before hydration is lost.
 */
function StudioDraft({ config, header, tabs, initialRefs, initialPrompt, examples }: DraftProps) {
  const [engine, setEngine] = useEngine();
  const catalog = useCatalog();
  const bridge = useMemo<ComposerBridge>(() => ({ current: null }), []);
  const build = (key: string) => {
    const d = initialDraft(config, new URLSearchParams(key), engine, catalog);
    if (initialRefs?.length) d.refs = [...initialRefs.map((u) => slot(u)!), ...d.refs];
    if (initialPrompt && !d.prompt) d.prompt = initialPrompt;
    return d;
  };
  // A model named in the URL (?model=, from ⌘K or a hand-off) brings its engine along, as Reuse
  // does: left on the other engine, the composer would swap it for that engine's default.
  const adopt = (key: string) => {
    const id = new URLSearchParams(key).get("model");
    const m = id ? catalog.getModel(id) : undefined;
    if (m && m.engine !== engine) setEngine(m.engine);
  };
  // The composer swaps an untouched default for the engine's own when the engine is read after hydration: a
  // hand-off still applies over that swap.
  const follow = (base: Draft, current: Draft) => followEngineDefault(base, current, config.defaultModels, engine, config.uncaptioned);
  const buildRef = useRef(build);
  const adoptRef = useRef(adopt);
  const followRef = useRef(follow);
  useLayoutEffect(() => {
    buildRef.current = build;
    adoptRef.current = adopt;
    followRef.current = follow;
  });
  // The draft the composer starts from: the defaults (the URL is unknown in the static shell), or
  // the hand-off params of a client navigation to new ones (a new epoch remounts the provider).
  const [start, setStart] = useState({ key: "", epoch: 0 });
  const initial = useMemo(() => build(start.key), [start, config]); // eslint-disable-line react-hooks/exhaustive-deps
  const onNavigate = useCallback((key: string) => {
    setStart((s) => ({ key, epoch: s.epoch + 1 }));
    adoptRef.current(key);
  }, []);
  // The picked camera motion or effect goes into the address (a reload or a shared link opens on it). HandoffSync
  // takes that address as applied first: it isn't a hand-off, so the draft isn't rebuilt.
  const ownRef = useRef<(key: string) => void>(() => {});
  const presetUrl = useCallback((id: string | undefined) => {
    const href = withPreset(window.location.href, id);
    if (href === window.location.href) return;
    ownRef.current(handoffKey(new URL(href).searchParams));
    window.history.replaceState(null, "", href);
  }, []);
  // An example starts from the page's own draft, opened on its motion or effect (that preset's route on this engine).
  const baseFor = useCallback((presetId?: string) => buildRef.current(presetId && presetId !== config.preset?.id ? new URLSearchParams({ preset: presetId }).toString() : ""), [config.preset?.id]);
  return (
    <ComposerBridgeCtx.Provider value={bridge}>
      <PresetUrlCtx.Provider value={presetUrl}>
        <StudioProvider key={start.epoch} config={config} initial={initial}>
          <ExampleLoader cards={examples?.cards ?? NO_CARDS} surface={examples?.surface} baseFor={baseFor}>
            <StudioSession header={header} tabs={tabs} examples={examples} sync={{ startKey: start.key, start: initial, build: buildRef, adopt: adoptRef, follow: followRef, ownRef, ready: catalog.ready, onNavigate }} />
          </ExampleLoader>
        </StudioProvider>
      </PresetUrlCtx.Provider>
    </ComposerBridgeCtx.Provider>
  );
}

/**
 * A studio page: header, hero, composer and feed. Everything but the URL is in the static shell:
 * the title, the hero and a composer you can start typing into before the page hydrates. The
 * hand-off params (`?image=`, `?prompt=`…) are applied once known (HandoffSync).
 */
export function StudioPage({ catalog, ...props }: StudioPageProps) {
  return (
    <CatalogProvider catalog={catalog} config={props.config}>
      <StudioDraft {...props} />
    </CatalogProvider>
  );
}
