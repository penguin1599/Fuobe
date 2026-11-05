"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { OwnSetupMark } from "@/components/own-setup";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { useEngine, useLikelyVisitor } from "@/lib/api";
import { HUB_MODES, HUB_TITLE, hubOfPath, modeHref, modeOfPath, type HubKind } from "@/lib/hubs";
import { prefetchOptions, useIdlePrefetch } from "@/lib/idle-prefetch";
import { isPlainClick, useTappedTab } from "@/lib/use-tapped-tab";
import { onAttr, reducedMotion, TAB_PILL, TabRow } from "@/components/ui/tab-row";

/**
 * The frame of a hub (Audio, Video tools, Upscale): the sticky title bar and the mode tabs live in the hub's layout, shared
 * by /<hub> and every /<hub>/<mode>, so they stay on screen while a tab's page loads ("layouts preserve state, remain
 * interactive, and do not rerender"). Each mode's page draws only its body, and puts its own header controls (the GPU
 * pill, a tool's extra buttons) into the bar with <HubHeaderExtras>.
 */

/**
 * Where a frame's page puts its header controls: the element in the frame's own title bar. A store rather than a value
 * passed down, so the context never changes after the first render: a context change that reaches a part of the page
 * still waiting to hydrate makes React throw that part's server HTML away and show its skeleton until its code arrives.
 */
interface SlotStore {
  get: () => HTMLElement | null;
  set: (el: HTMLElement | null) => void;
  subscribe: (cb: () => void) => () => void;
}

function createSlotStore(): SlotStore {
  let slot: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => slot,
    set: (el) => {
      if (el === slot) return;
      slot = el;
      for (const l of listeners) l();
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

const HubCtx = createContext<SlotStore | null>(null);
const noSlot = () => null;
const noSubscribe = () => () => {};

/** Inside a hub's frame: the page leaves the title bar and tabs to it. */
export function useInHub(): boolean {
  return useContext(HubCtx) !== null;
}

/** A page's own header controls, shown in its hub's title bar left of the engine switch. */
export function HubHeaderExtras({ children }: { children: React.ReactNode }) {
  const store = useContext(HubCtx);
  const slot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? noSlot, noSlot);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Reports while its tab's navigation waits (useLinkStatus is pending only when the page wasn't prefetched yet; a
 * prefetched page skips it). Inside the tab's <Link>.
 */
function TabWaiting({ onWaiting }: { onWaiting?: (waiting: boolean) => void }) {
  const { pending } = useLinkStatus();
  // Before paint: when the page arrives, the skeleton goes in the same frame.
  useLayoutEffect(() => {
    if (!pending || !onWaiting) return;
    onWaiting(true);
    return () => onWaiting(false);
  }, [pending, onWaiting]);
  return null;
}

/**
 * The hub's mode tabs: underline tabs on their own row under the title; they scroll sideways (with faded edges) on
 * phones. Each mode is its own history entry, so Back returns to the mode before.
 *
 * Instant by design: the tapped tab is marked at once (before the route commits), every tab prefetches its whole mode
 * page (each is prerendered, so the prefetch comes from the static cache), and the tabs a phone's row scrolls out of
 * view are prefetched too once the page is idle: a tap then renders the mode from the client cache, with no blank frame.
 */
function HubTabs({
  kind,
  pathname,
  onActive,
  onWaiting,
}: {
  kind: HubKind;
  pathname: string | null;
  onActive?: (mode: string) => void;
  onWaiting?: (waiting: boolean) => void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const visitor = useLikelyVisitor();
  // The tab just tapped: the current one from the next frame on, until the route moves (then the path says).
  const [tapped, tap] = useTappedTab<string>(pathname);
  const shown = pathname ? modeOfPath(kind, pathname) : undefined;
  const active = tapped ?? shown;
  const modes = visitor ? HUB_MODES[kind].filter((m) => !m.ownerOnly || m.id === shown) : HUB_MODES[kind];

  useEffect(() => {
    if (active) onActive?.(active);
  }, [active, onActive]);

  // Keep the selected tab in view when the row scrolls (only the row: the page stays put). The first time, a row the
  // visitor already swiped before the page became interactive stays where they put it (a tap there is on its way).
  const placed = useRef(false);
  useEffect(() => {
    const el = activeRef.current;
    const row = ref.current;
    if (!el || !row) return;
    const first = !placed.current;
    placed.current = true;
    if (first && row.scrollLeft > 0) return;
    const left = el.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left - 12;
  }, [active, ref]);

  // Every mode's whole page, also the ones scrolled out of the row, once the page is idle (a tab on screen already
  // prefetches itself), ahead of the navigation's routes: the "page" lane.
  useIdlePrefetch(
    modes.map((m) => modeHref(kind, m.id)),
    "page",
    true,
  );

  return (
    <nav aria-label="Modes" className="border-b">
      <TabRow ref={ref} className="m-0 px-4 py-1.5 sm:px-6">
        {modes.map((m) => {
          const on = m.id === active;
          const href = modeHref(kind, m.id);
          return (
            <Link
              key={m.id}
              ref={on ? activeRef : undefined}
              href={href}
              prefetch
              scroll={false}
              data-mode={m.id}
              onTouchStart={() => router.prefetch(href, prefetchOptions(true))}
              // A new tab or window (modifier, middle button) leaves this page as it is.
              onClick={(e) => isPlainClick(e) && tap(m.id)}
              aria-current={on ? "page" : undefined}
              className={TAB_PILL}
              {...onAttr(on)}
            >
              {m.label}
              {m.ownSetup && <OwnSetupMark setup={m.ownSetup} />}
              <TabWaiting onWaiting={onWaiting} />
            </Link>
          );
        })}
      </TabRow>
    </nav>
  );
}

/** Reads the path (runtime data while a route prerenders) inside Suspense; the fallback is the same row, unselected. */
function PathTabs({ kind, onActive, onWaiting }: { kind: HubKind; onActive: (mode: string) => void; onWaiting: (waiting: boolean) => void }) {
  const pathname = usePathname();
  return <HubTabs kind={kind} pathname={pathname} onActive={onActive} onWaiting={onWaiting} />;
}

/**
 * The hub body fades in when a mode's page arrives (the path changes with it): the page is there in that frame and only
 * its opacity eases, so a switch is never slower. Inside Suspense (the path is runtime data while a route prerenders).
 */
function PathFade({ body }: { body: React.RefObject<HTMLDivElement | null> }) {
  const pathname = usePathname();
  const last = useRef(pathname);
  useLayoutEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    const el = body.current;
    if (!el || reducedMotion() || typeof el.animate !== "function") return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" });
  }, [pathname, body]);
  return null;
}

/** How long a tapped tab's page may keep the old one on screen before the skeleton replaces it. */
export const HUB_SKELETON_AFTER_MS = 60;

function HubEngine({ kind, mode }: { kind: HubKind; mode: string | undefined }) {
  const [engine, setEngine] = useEngine();
  const selfHostedOnly = !!HUB_MODES[kind].find((m) => m.id === mode)?.selfHostedOnly;
  return <EngineSwitch value={engine} onChange={setEngine} selfHostedOnly={selfHostedOnly} />;
}

/**
 * The title bar and the tabs of a hub. `children`: the mode's page (or, while a route loads, its skeleton). `skeleton`:
 * the page body's skeleton, shown in place of the old page when a tapped tab's page wasn't prefetched yet and hasn't come
 * within HUB_SKELETON_AFTER_MS (the old page stays mounted under it, so its state is kept if the tap is undone).
 */
export function HubFrame({ kind, skeleton, children }: { kind: HubKind; skeleton: React.ReactNode; children: React.ReactNode }) {
  // Made once: the context's value never changes (see SlotStore).
  const [store] = useState(createSlotStore);
  const slotRef = useCallback((el: HTMLElement | null) => store.set(el), [store]);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setLate(true), HUB_SKELETON_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [waiting]);
  // `waiting` ends before paint when the page arrives, so the skeleton never covers the new page.
  const skeletonShown = waiting && late;
  const body = useRef<HTMLDivElement>(null);
  return (
    <div className="flex min-h-content min-w-0 flex-col" data-hub={kind}>
      <div className="max-md:sticky top-chrome z-20 bg-background/85 backdrop-blur" data-hub-chrome>
        <header className="flex h-14 items-center gap-2 px-4 sm:px-6">
          <h1 className="min-w-0 truncate font-heading text-[22px] leading-[1.15]">{HUB_TITLE[kind]}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div ref={slotRef} className="contents" />
            <HubEngine kind={kind} mode={mode} />
          </div>
          <PhoneNavButton />
        </header>
        <Suspense fallback={<HubTabs kind={kind} pathname={null} />}>
          <PathTabs kind={kind} onActive={setMode} onWaiting={setWaiting} />
        </Suspense>
      </div>
      <HubCtx.Provider value={store}>
        <Suspense fallback={null}>
          <PathFade body={body} />
        </Suspense>
        <div ref={body} className="flex min-w-0 flex-1 flex-col" data-hub-body>
          {skeletonShown && skeleton}
          <div className={skeletonShown ? "hidden" : "contents"}>{children}</div>
        </div>
      </HubCtx.Provider>
    </div>
  );
}

function PathSkeleton({ generic, hubBody }: { generic: React.ReactNode; hubBody: React.ReactNode }) {
  const hub = hubOfPath(usePathname());
  return hub ? (
    <HubFrame kind={hub} skeleton={hubBody}>
      {hubBody}
    </HubFrame>
  ) : (
    generic
  );
}

/**
 * The studio's route skeleton (loading.tsx), for a page whose shell wasn't prefetched yet: on the way into a hub it is
 * the hub's real title bar and tabs (the new mode already marked) over the body's skeleton, so nothing moves when the
 * page arrives; elsewhere the generic one.
 */
export function StudioRouteSkeleton({ generic, hubBody }: { generic: React.ReactNode; hubBody: React.ReactNode }) {
  return (
    <Suspense fallback={generic}>
      <PathSkeleton generic={generic} hubBody={hubBody} />
    </Suspense>
  );
}
