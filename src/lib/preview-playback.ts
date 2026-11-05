/**
 * Which gallery previews play (preset-preview.tsx). A card with a clip plays by itself while at least
 * half of it is in view, once scrolling has stopped: the cards most in view and nearest the middle of the
 * screen, at most MAX_PLAYING at once, so a gallery with dozens of clips stays smooth and doesn't
 * download them all. Procedural previews (no clip) play by themselves only where nothing can hover
 * (phones); a still never moves. Nothing plays by itself when the user prefers reduced motion, asks
 * for less data (Save-Data, a 2G connection) or the tab is hidden; reduced motion turned on while the
 * page is open stops what plays by itself at once. The viewer can pause previews too (Home's "Pause previews"): then
 * nothing plays by itself, anywhere.
 *
 * The hovered or focused card plays too, on top of those, once the pointer has rested on it for a
 * moment (a pointer crossing the grid doesn't start every card it passes); asked for, it plays even
 * with Save-Data, and a clip even with reduced motion (playsWhenAsked).
 *
 * Pure apart from the environment it's given, so the rules are testable without a browser.
 */

export type PlaybackEvent = "scroll" | "visibilitychange" | "motion";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** What the store needs from the browser. */
export interface PlaybackEnv {
  matches(query: string): boolean;
  /** Undefined where IntersectionObserver doesn't exist (then nothing auto-plays). */
  IntersectionObserver?: new (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) => Pick<IntersectionObserver, "observe" | "unobserve">;
  /** Run `cb` after `ms` milliseconds; returns what cancels it. */
  delay(cb: () => void, ms: number): () => void;
  viewportWidth(): number;
  viewportHeight(): number;
  /** Scrolling anywhere on the page, the tab being hidden or shown, or the reduced-motion setting changing. */
  on(type: PlaybackEvent, cb: () => void): void;
  off(type: PlaybackEvent, cb: () => void): void;
  /** The tab is in the background. */
  hidden(): boolean;
  /** The user asked for less data (Save-Data), or the connection is 2G. */
  saveData(): boolean;
}

/** A card must be at least this much in view to play by itself: half of it. */
export const MIN_VISIBLE = 0.5;
/** In full view, near enough (IntersectionObserver reports ratios only as they cross its thresholds). */
export const FULL_VIEW = 0.85;
/** How long the pointer (or focus) rests on a card before it plays, in ms. */
export const HOVER_INTENT = 120;
/** How long scrolling must have stopped before the cards in view play, in ms. */
export const SCROLL_SETTLE = 400;
/** At most this many previews play by themselves at once: on a narrow screen (a phone), and wider. */
export const MAX_PLAYING = { narrow: 3, wide: 6 };
/** Narrower than this (px) is a phone: the galleries show two columns. */
export const NARROW = 640;

export const maxPlaying = (viewportWidth: number) => (viewportWidth < NARROW ? MAX_PLAYING.narrow : MAX_PLAYING.wide);

/** The cycle a row's clips start on (Home's wall and rows): eight places, 350 ms apart. */
export const STAGGER_CYCLE = 2800;

/**
 * The place (ms into STAGGER_CYCLE) where the clip of a row's `i`th card starts playing by itself: the clips of a row
 * start apart, so they never loop in step (every effect clip is 4 s long) and some card is always at its height.
 */
export const staggered = (i: number) => (i % 8) * (STAGGER_CYCLE / 8);

/**
 * How long (ms) from `now` (performance.now()) until the shared clock next reaches `place` in the cycle. A clip waits
 * for that once it's ready, not for a fixed time from when it was asked for, so clips that take longer or shorter to
 * load still start at their own places.
 */
export const untilPlace = (place: number, now: number) => (((place - now) % STAGGER_CYCLE) + STAGGER_CYCLE) % STAGGER_CYCLE;

/** What a preview shows: a real cover's clip, a procedural animation, or a still. */
export type PreviewKind = "clip" | "procedural" | "still";

export const previewKind = (p: { video?: string; move?: string; fx?: string }): PreviewKind => (p.video ? "clip" : p.move || p.fx ? "procedural" : "still");

/**
 * When a card plays by itself: "always" (while it's in view), or "touch", only where nothing can hover (Home's studio
 * cards: with a mouse they wait for it, so the cards above them keep the screen's few clips).
 */
export type AutoPlay = "always" | "touch";

/**
 * Whether a preview of this kind plays by itself while it's in view: a clip anywhere, a procedural one only where
 * nothing can hover; with "touch", nothing does where a pointer can hover.
 */
export const autoplays = (kind: PreviewKind, canHover: boolean, auto: AutoPlay = "always") =>
  (auto === "always" || !canHover) && (kind === "clip" || (kind === "procedural" && !canHover));

/**
 * Whether a hover, keyboard focus or tap plays a preview of this kind. With reduced motion only a clip
 * does: a procedural preview's animations are off then (globals.css), so it keeps its poster.
 */
export const playsWhenAsked = (kind: PreviewKind, reducedMotion: boolean) => kind === "clip" || (kind === "procedural" && !reducedMotion);

/** A watched card when the store picks which play. */
export interface Candidate {
  id: string;
  /** How much of it is in view, 0..1. */
  ratio: number;
  /** From its centre to the screen's, in px. */
  dist: number;
  playing: boolean;
}

/**
 * Which cards play by themselves, at most `max`: only those at least half in view; the ones in full view
 * first, then the ones already playing (a small scroll doesn't restart them), then the nearest the
 * middle of the screen.
 */
export function pickPlaying(cards: Candidate[], max: number): string[] {
  const tier = (ratio: number) => (ratio >= FULL_VIEW ? 1 : 0);
  const ranked = cards
    .filter((c) => c.ratio >= MIN_VISIBLE)
    .sort((a, b) => tier(b.ratio) - tier(a.ratio) || Number(b.playing) - Number(a.playing) || a.dist - b.dist);
  const ids = new Set<string>();
  for (const c of ranked) if (ids.size < max) ids.add(c.id);
  return [...ids];
}

export function createPlaybackStore(env: PlaybackEnv) {
  const listeners = new Set<() => void>();
  /** The cards playing by themselves, and the one the pointer (or focus) is on. */
  let auto = new Set<string>();
  let hovered: string | null = null;
  const watched = new Map<Element, string>();
  const ratios = new Map<Element, number>();
  let observer: Pick<IntersectionObserver, "observe" | "unobserve"> | null = null;
  /** The card a hover is about to play, and what calls that off. */
  let pending: { id: string; cancel: () => void } | null = null;
  let settle: (() => void) | null = null;
  /** The viewer paused previews: nothing plays by itself; a hover, focus or tap still plays. */
  let paused = false;

  const notify = () => listeners.forEach((l) => l());
  const setHovered = (id: string | null) => {
    if (hovered === id) return;
    hovered = id;
    notify();
  };
  const setAuto = (ids: string[]) => {
    if (ids.length === auto.size && ids.every((id) => auto.has(id))) return;
    auto = new Set(ids);
    notify();
  };
  const reducedMotion = () => env.matches(REDUCED_MOTION);
  const cancelPending = () => {
    pending?.cancel();
    pending = null;
  };
  const cancelSettle = () => {
    settle?.();
    settle = null;
  };

  const pick = () => {
    settle = null;
    if (paused || reducedMotion() || env.saveData()) return setAuto([]);
    const cx = env.viewportWidth() / 2;
    const cy = env.viewportHeight() / 2;
    const cards: Candidate[] = [];
    for (const [el, ratio] of ratios) {
      if (ratio < MIN_VISIBLE) continue;
      const r = el.getBoundingClientRect();
      const id = watched.get(el)!;
      cards.push({ id, ratio, dist: Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy), playing: auto.has(id) });
    }
    setAuto(pickPlaying(cards, maxPlaying(env.viewportWidth())));
  };
  /** Pick once the page is still: every scroll (or visibility change) starts the wait over. */
  const schedule = () => {
    cancelSettle();
    if (!env.hidden()) settle = env.delay(pick, SCROLL_SETTLE);
  };
  // A hidden tab plays nothing (isPlaying says so); back in view, the cards on screen may have changed.
  const onVisibility = () => {
    if (env.hidden()) cancelSettle();
    else if (watched.size) schedule();
    notify();
  };

  // Reduced motion turned on stops what plays by itself at once (isPlaying) and the next pick chooses
  // nothing; turned off, the cards in view are picked again.
  const onMotion = () => {
    if (watched.size) schedule();
    notify();
  };

  const isPlaying = (id: string) => !env.hidden() && (hovered === id || (auto.has(id) && !paused && !reducedMotion()));
  /** Hover / focus: play this one once it has had the pointer for HOVER_INTENT. */
  const play = (id: string) => {
    cancelPending();
    const cancel = env.delay(() => {
      pending = null;
      setHovered(id);
    }, HOVER_INTENT);
    pending = { id, cancel };
  };
  /** Stop this one, if it's the one hovered (or about to be); a card playing by itself goes on. */
  const stop = (id: string) => {
    if (pending?.id === id) cancelPending();
    if (hovered === id) setHovered(null);
  };

  return {
    subscribe(l: () => void) {
      if (!listeners.size) {
        env.on("visibilitychange", onVisibility);
        env.on("motion", onMotion);
      }
      listeners.add(l);
      return () => {
        listeners.delete(l);
        if (listeners.size) return;
        env.off("visibilitychange", onVisibility);
        env.off("motion", onMotion);
      };
    },
    isPlaying,
    /** Playing because the viewer asked (a hover, focus or tap), not by itself. */
    isAsked: (id: string) => !env.hidden() && hovered === id,
    /** Every card playing now, by id (for tests). */
    playing: () => [...new Set([...auto, ...(hovered ? [hovered] : [])])].filter(isPlaying).sort(),
    canHover: () => env.matches("(hover: hover) and (pointer: fine)"),
    isPaused: () => paused,
    /** Pause previews, or play them again: paused, what plays by itself stops at once; played again, the cards in view are picked. */
    setPaused(b: boolean) {
      if (paused === b) return;
      paused = b;
      if (b) {
        cancelSettle();
        auto = new Set();
      } else if (watched.size) schedule();
      notify();
    },
    reducedMotion,
    saveData: () => env.saveData(),
    play,
    stop,
    /** A tap: play this one, or stop it if a tap already did. */
    toggle: (id: string) => (hovered === id || pending?.id === id ? stop(id) : play(id)),
    /** Let visibility decide whether `el` plays by itself (see autoplays). Returns the cleanup. */
    watch(el: Element, id: string): () => void {
      const IO = env.IntersectionObserver;
      // Each card that comes into view would start a download: none with Save-Data or on 2G. With
      // reduced motion it's watched but not picked (pick), so turning the setting off plays it.
      if (!IO || env.saveData()) return () => {};
      observer ??= new IO(
        (entries) => {
          for (const e of entries) {
            const card = watched.get(e.target);
            if (card === undefined) continue;
            const ratio = e.isIntersecting ? e.intersectionRatio : 0;
            ratios.set(e.target, ratio);
            // A playing card stops as soon as less than half of it is in view; the next ones wait for the scroll to settle.
            if (ratio < MIN_VISIBLE && auto.has(card)) setAuto([...auto].filter((a) => a !== card));
          }
          schedule();
        },
        { threshold: [0, MIN_VISIBLE, FULL_VIEW, 1] },
      );
      if (!watched.size) env.on("scroll", schedule);
      watched.set(el, id);
      observer.observe(el);
      return () => {
        observer?.unobserve(el);
        watched.delete(el);
        ratios.delete(el);
        if (auto.has(id)) setAuto([...auto].filter((a) => a !== id));
        if (watched.size) {
          // Its place goes to the next card in view.
          schedule();
        } else {
          env.off("scroll", schedule);
          cancelSettle();
        }
      };
    },
    /** For tests: how many cards are watched. */
    watchedCount: () => watched.size,
  };
}

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;

type Connection = { saveData?: boolean; effectiveType?: string };

/** The reduced-motion query, kept: a change listener comes off only the list it was added to. */
let motionQuery: MediaQueryList | undefined;
const reducedMotionQuery = () => (typeof window.matchMedia === "function" ? (motionQuery ??= window.matchMedia(REDUCED_MOTION)) : undefined);

/** The real browser; every member is safe to call during server rendering. */
export const browserPlaybackEnv: PlaybackEnv = {
  matches: (q) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches,
  get IntersectionObserver() {
    return typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver;
  },
  delay: (cb, ms) => {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  },
  viewportWidth: () => window.innerWidth,
  viewportHeight: () => window.innerHeight,
  // Scrolls are caught from every scroller (capture), a horizontal row's included.
  on: (type, cb) => {
    if (type === "scroll") window.addEventListener("scroll", cb, { passive: true, capture: true });
    else if (type === "motion") reducedMotionQuery()?.addEventListener("change", cb);
    else document.addEventListener(type, cb);
  },
  off: (type, cb) => {
    if (type === "scroll") window.removeEventListener("scroll", cb, { capture: true });
    else if (type === "motion") reducedMotionQuery()?.removeEventListener("change", cb);
    else document.removeEventListener(type, cb);
  },
  hidden: () => typeof document !== "undefined" && document.hidden,
  saveData: () => {
    const c = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { connection?: Connection }).connection;
    // effectiveType is "slow-2g", "2g", "3g" or "4g" (Chromium only; elsewhere this is false).
    return !!c && (c.saveData === true || !!c.effectiveType?.endsWith("2g"));
  },
};
