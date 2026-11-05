import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EFFECTS, MOTIONS } from "@/lib/catalog";
import { copyText, copyWithToast } from "@/lib/clipboard";
import { loseContext, releaseVideo } from "@/lib/media-release";
import { GLYPHS, MOVE_GLYPH, glyphFor } from "@/lib/move-glyphs";
import {
  CAMERA_MOVES,
  effectFx,
  homeEffects,
  interleaveByCategory,
  motionMove,
  previewFlip,
  stableHash,
  type CameraMove,
} from "@/lib/preset-cards";
import { previewFor, toPresetCard } from "@/lib/preset-card-data";
import { featuredGallery } from "@/lib/preset-featured";
import {
  autoplays,
  browserPlaybackEnv,
  createPlaybackStore,
  FULL_VIEW,
  HOVER_INTENT,
  MAX_PLAYING,
  maxPlaying,
  MIN_VISIBLE,
  pickPlaying,
  playsWhenAsked,
  previewKind,
  SCROLL_SETTLE,
  STAGGER_CYCLE,
  staggered,
  untilPlace,
  type PlaybackEnv,
  type PlaybackStore,
} from "@/lib/preview-playback";
import { pageAfter, progressiveStart, syncProgressive } from "@/lib/progressive";
import { storyboardName } from "@/lib/storyboard-board";

const toasts = vi.hoisted(() => ({ ok: [] as string[], error: [] as string[] }));
vi.mock("sonner", () => ({ toast: Object.assign((m: string) => void toasts.ok.push(m), { error: (m: string) => void toasts.error.push(m) }) }));
// The procedural previews are what these tests look at: no preset has a real cover here.
vi.mock("@/lib/preset-previews.generated", () => ({ PRESET_PREVIEWS: {} }));
import { capabilityGroup, usedByIndex } from "@/lib/workflow-usage";

describe("workflow 'used by' index", () => {
  const used = usedByIndex([
    { endpoint: "flux-dev-t2i", name: "FLUX.1 dev" },
    { endpoint: "flux-dev-t2i", name: "FLUX.1 dev" },
    { endpoint: "flux-dev-t2i", name: "FLUX Krea" },
    { endpoint: "video-concat-{n}", name: "Join clips" },
    { endpoint: "wan.2-{n}x", name: "Dotted" },
  ]);

  it("matches exact endpoints and dedupes names in route order", () => {
    expect(used("flux-dev-t2i")).toEqual(["FLUX.1 dev", "FLUX Krea"]);
    expect(used("flux-dev")).toEqual([]);
  });

  it("matches {n} endpoints for any count, including two-digit ones", () => {
    expect(used("video-concat-2")).toEqual(["Join clips"]);
    expect(used("video-concat-12")).toEqual(["Join clips"]);
    expect(used("video-concat-")).toEqual([]);
    expect(used("video-concat-2b")).toEqual([]);
  });

  it("treats the rest of a pattern literally", () => {
    expect(used("wan.2-4x")).toEqual(["Dotted"]);
    expect(used("wanX2-4x")).toEqual([]);
  });

  it("groups capabilities by what they make, for the filter chips", () => {
    expect(capabilityGroup("t2i")).toBe("Image");
    expect(capabilityGroup("bg-remove-video")).toBe("Video");
    expect(capabilityGroup("separate-audio")).toBe("Audio");
    expect(capabilityGroup("transcribe")).toBe("Text & 3D");
    expect(capabilityGroup("image-to-3d")).toBe("Text & 3D");
    // Not operations, still sorted sensibly.
    expect(capabilityGroup("draw-to-video")).toBe("Video");
    expect(capabilityGroup("camera-motion")).toBe("Video");
    expect(capabilityGroup("style-reference")).toBe("Image");
    expect(capabilityGroup("character-sheet")).toBe("Image");
  });
});

describe("progressive list paging", () => {
  it("keeps its count while the filter is unchanged and starts over when it changes", () => {
    let s = progressiveStart("all", 30);
    s = { ...s, shown: pageAfter(s.shown, 40) };
    expect(s.shown).toBe(70);
    expect(syncProgressive(s, "all", 30)).toBe(s);
    expect(syncProgressive(s, "fire", 30)).toEqual({ key: "fire", shown: 30 });
  });

  it("always grows by at least one", () => {
    expect(pageAfter(5, 0)).toBe(6);
  });
});

/** A fake browser for the playback store, with a clock that only moves when `advance` says so. */
function fakeEnv({ hover = false, reduced = false, width = 1280, height = 800, saveData = false } = {}) {
  let ioCallback: IntersectionObserverCallback | null = null;
  const observed = new Set<Element>();
  const listeners = { scroll: new Set<() => void>(), visibilitychange: new Set<() => void>(), motion: new Set<() => void>() };
  let hidden = false;
  let now = 0;
  const timers = new Set<{ at: number; cb: () => void }>();
  const next = () => [...timers].sort((a, b) => a.at - b.at)[0];
  /** Move the clock on by `ms`, running the timers that come due, in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (let due = next(); due && due.at <= end; due = next()) {
      timers.delete(due);
      now = due.at;
      due.cb();
    }
    now = end;
  };
  const env: PlaybackEnv = {
    matches: (q) => (q.includes("reduced-motion") ? reduced : q.includes("hover") ? hover : false),
    IntersectionObserver: class {
      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
      }
      observe(el: Element) {
        observed.add(el);
      }
      unobserve(el: Element) {
        observed.delete(el);
      }
    },
    delay: (cb, ms) => {
      const t = { at: now + ms, cb };
      timers.add(t);
      return () => void timers.delete(t);
    },
    viewportWidth: () => width,
    viewportHeight: () => height,
    on: (type, cb) => void listeners[type].add(cb),
    off: (type, cb) => void listeners[type].delete(cb),
    hidden: () => hidden,
    saveData: () => saveData,
  };
  /** The connection turns to Save-Data or 2G (no event: the next pick reads it). */
  const setSaveData = (on: boolean) => void (saveData = on);
  /** A card whose box starts `top` px down and `left` px across the screen. */
  const card = (top: number, left = 0, width = 240, height = 180) => ({ getBoundingClientRect: () => ({ top, left, width, height }) }) as unknown as Element;
  const intersect = (entries: [Element, number][]) =>
    ioCallback!(entries.map(([target, ratio]) => ({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 }) as IntersectionObserverEntry), null as never);
  const scrolled = () => listeners.scroll.forEach((f) => f());
  /** The tab goes to the background (or comes back). */
  const setHidden = (h: boolean) => {
    hidden = h;
    listeners.visibilitychange.forEach((f) => f());
  };
  /** The user turns reduced motion on (or off) while the page is open. */
  const setReduced = (r: boolean) => {
    reduced = r;
    listeners.motion.forEach((f) => f());
  };
  return { env, card, intersect, scrolled, setHidden, setReduced, setSaveData, advance, observed, listeners, timers };
}

/** Cards in a grid, `rows` × `cols` of `w` × `h` with 20 px between them, watched by `store` and all in full view: "r1c2" is row 1, column 2. */
function watchGrid(store: PlaybackStore, { card, intersect }: ReturnType<typeof fakeEnv>, rows: number, cols: number, w = 240, h = 180) {
  const cards = new Map<string, Element>();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cards.set(`r${r}c${c}`, card(r * (h + 20), c * (w + 20), w, h));
  for (const [id, el] of cards) store.watch(el, id);
  intersect([...cards.values()].map((el) => [el, 1]));
  return cards;
}

describe("preview playback store", () => {
  it("plays the card the pointer rests on, one at a time", () => {
    const { env, advance } = fakeEnv({ hover: true });
    const store = createPlaybackStore(env);
    const seen: string[][] = [];
    store.subscribe(() => seen.push(store.playing()));
    store.play("a");
    advance(HOVER_INTENT);
    store.play("b");
    advance(HOVER_INTENT);
    expect(store.isPlaying("a")).toBe(false);
    expect(store.isPlaying("b")).toBe(true);
    store.stop("a");
    expect(store.playing()).toEqual(["b"]);
    store.stop("b");
    expect(seen).toEqual([["a"], ["b"], []]);
  });

  it("waits for the pointer to rest on a card before playing it", () => {
    const { env, advance, timers } = fakeEnv({ hover: true });
    const store = createPlaybackStore(env);
    const seen: string[][] = [];
    store.subscribe(() => seen.push(store.playing()));
    // Crossing one card on the way to another starts neither until the pointer stops.
    store.play("a");
    advance(HOVER_INTENT - 20);
    store.stop("a");
    store.play("b");
    advance(HOVER_INTENT - 1);
    expect(store.playing()).toEqual([]);
    advance(1);
    expect(store.playing()).toEqual(["b"]);
    // Leaving before the intent is up calls it off.
    store.play("c");
    store.stop("c");
    expect(timers.size).toBe(0);
    advance(1000);
    expect(seen).toEqual([["b"]]);
  });

  it("plays the cards in view by themselves once scrolling stops, the six nearest the middle of a wide screen", () => {
    const fake = fakeEnv({ hover: true, width: 1280, height: 800 });
    const store = createPlaybackStore(fake.env);
    // Four rows of four: card centres at x 120, 380, 640, 900 and y 90, 290, 490, 690; the screen's middle is (640, 400).
    watchGrid(store, fake, 4, 4);
    // Still scrolling: nothing starts (or downloads) yet.
    fake.advance(SCROLL_SETTLE - 100);
    fake.scrolled();
    fake.advance(SCROLL_SETTLE - 1);
    expect(store.playing()).toEqual([]);
    fake.advance(1);
    expect(store.playing()).toEqual(["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]);
  });

  it("plays at most three at once on a phone", () => {
    const fake = fakeEnv({ width: 390, height: 844 });
    const store = createPlaybackStore(fake.env);
    // Two columns, four rows: card centres at y 70, 230, 390, 550 (the middle is 422).
    watchGrid(store, fake, 4, 2, 175, 140);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toHaveLength(MAX_PLAYING.narrow);
    expect(store.playing()).toEqual(expect.arrayContaining(["r2c0", "r2c1"]));
    expect(maxPlaying(390)).toBe(MAX_PLAYING.narrow);
    expect(maxPlaying(1280)).toBe(MAX_PLAYING.wide);
  });

  it("plays a card once half of it is in view, and stops it as soon as less than half is", () => {
    const { env, card, intersect, advance } = fakeEnv({ width: 1440, height: 900 });
    const store = createPlaybackStore(env);
    const [a, b] = [card(700), card(700, 300)];
    store.watch(a, "a");
    store.watch(b, "b");
    intersect([
      [a, 0.5],
      [b, 0.49],
    ]);
    advance(SCROLL_SETTLE);
    expect(MIN_VISIBLE).toBe(0.5);
    expect(store.playing()).toEqual(["a"]);
    intersect([[a, 0.49]]);
    expect(store.playing()).toEqual([]);
  });

  it("a phone's sideways row: the card in view plays, the one peeking in waits; swiped along, the next one takes over", () => {
    const { env, card, intersect, scrolled, advance } = fakeEnv({ width: 390, height: 844 });
    const store = createPlaybackStore(env);
    // Home's rail on a narrow phone: cards 237 px wide from x 10, the second showing less than half of itself at the edge.
    const row = Array.from({ length: 12 }, (_, i) => card(300, 10 + i * 237, 237, 190));
    row.forEach((el, i) => store.watch(el, `c${i}`));
    intersect([
      [row[0], 1],
      [row[1], 0.4],
    ]);
    advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["c0"]);
    // A swipe: the first card slides out (it stops at once), the second comes in, and plays once the row is still.
    scrolled();
    intersect([
      [row[0], 0.2],
      [row[1], 1],
      [row[2], 0.3],
    ]);
    expect(store.playing()).toEqual([]);
    advance(SCROLL_SETTLE - 1);
    expect(store.playing()).toEqual([]);
    advance(1);
    expect(store.playing()).toEqual(["c1"]);
  });

  it("with more cards in view than may play, the ones most in view win, then the nearest the middle", () => {
    const { env, card, intersect, advance } = fakeEnv({ width: 390, height: 844 });
    const store = createPlaybackStore(env);
    // Three cards partly in view right at the middle of the screen, four in full view further out.
    const partly = [0, 1, 2].map((i) => card(330, i * 130, 120, 180));
    const full = [0, 1, 2, 3].map((i) => card(i < 2 ? 20 : 640, (i % 2) * 200, 180, 180));
    partly.forEach((el, i) => store.watch(el, `p${i}`));
    full.forEach((el, i) => store.watch(el, `f${i}`));
    intersect([...partly.map((el) => [el, 0.7] as [Element, number]), ...full.map((el) => [el, 1] as [Element, number])]);
    advance(SCROLL_SETTLE);
    expect(store.playing()).toHaveLength(MAX_PLAYING.narrow);
    expect(store.playing().every((id) => id.startsWith("f"))).toBe(true);
  });

  it("Home's studio cards (auto: \"always\") play by themselves where a pointer can hover too, as the preset cards do", () => {
    expect(autoplays("clip", true, "always")).toBe(true);
    expect(autoplays("clip", false, "always")).toBe(true);
    expect(autoplays("still", true, "always")).toBe(false);
  });

  it("ranks cards in full view first, then the ones already playing (so a scroll doesn't restart them), then the nearest the middle", () => {
    const c = (id: string, ratio: number, dist: number, playing = false) => ({ id, ratio, dist, playing });
    const cards = [c("partly", FULL_VIEW - 0.1, 0, true), c("near", 1, 10), c("playing", 1, 500, true), c("hidden", MIN_VISIBLE - 0.1, 0), c("far", 1, 600)];
    expect(pickPlaying(cards, 2)).toEqual(["playing", "near"]);
    expect(pickPlaying(cards, 4)).toEqual(["playing", "near", "far", "partly"]);
    // Never a card that isn't mostly in view, whatever the room.
    expect(pickPlaying(cards, 10)).not.toContain("hidden");
    // The same preset twice on a page takes one place.
    expect(pickPlaying([c("a", 1, 0), c("a", 1, 5), c("b", 1, 9)], 2)).toEqual(["a", "b"]);
  });

  it("stops a playing card as soon as it scrolls mostly out of view; the next one waits for the scroll to settle", () => {
    const { env, card, intersect, advance } = fakeEnv({ width: 390 });
    const store = createPlaybackStore(env);
    const cards = [card(0), card(200), card(400), card(600)];
    cards.forEach((el, i) => store.watch(el, `c${i}`));
    intersect(cards.slice(0, 3).map((el) => [el, 1]));
    advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["c0", "c1", "c2"]);
    intersect([
      [cards[0], MIN_VISIBLE - 0.1],
      [cards[3], 1],
    ]);
    expect(store.playing()).toEqual(["c1", "c2"]);
    advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps a hovered card playing while it plays by itself, and plays a hovered one beyond the cap", () => {
    const fake = fakeEnv({ hover: true, width: 390 });
    const store = createPlaybackStore(fake.env);
    watchGrid(store, fake, 4, 2, 175, 140);
    fake.advance(SCROLL_SETTLE);
    const [auto] = store.playing();
    store.play(auto);
    fake.advance(HOVER_INTENT);
    store.stop(auto);
    expect(store.isPlaying(auto)).toBe(true);
    store.play("r0c0");
    fake.advance(HOVER_INTENT);
    expect(store.playing()).toHaveLength(MAX_PLAYING.narrow + 1);
  });

  it("pauses everything while the tab is hidden, and goes on when it's back", () => {
    const fake = fakeEnv({ hover: true, width: 390 });
    const store = createPlaybackStore(fake.env);
    const seen: string[][] = [];
    store.subscribe(() => seen.push(store.playing()));
    watchGrid(store, fake, 1, 2);
    fake.advance(SCROLL_SETTLE);
    store.play("hovered");
    fake.advance(HOVER_INTENT);
    fake.scrolled();
    fake.setHidden(true);
    expect(store.isPlaying("hovered")).toBe(false);
    // A pick waiting for the scroll to settle is called off too.
    expect(fake.timers.size).toBe(0);
    fake.setHidden(false);
    expect(seen).toEqual([["r0c0", "r0c1"], ["hovered", "r0c0", "r0c1"], [], ["hovered", "r0c0", "r0c1"]]);
    // Back in view, it looks again once the page is still.
    expect(fake.timers.size).toBe(1);
  });

  it("with reduced motion nothing plays by itself, but hover and keyboard focus still do", () => {
    const fake = fakeEnv({ reduced: true });
    const store = createPlaybackStore(fake.env);
    watchGrid(store, fake, 1, 2);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual([]);
    store.play("r0c0");
    fake.advance(HOVER_INTENT);
    expect(store.playing()).toEqual(["r0c0"]);
    expect(store.reducedMotion()).toBe(true);
  });

  it("follows reduced motion turned on or off while the page is open", () => {
    const fake = fakeEnv({ hover: true });
    const store = createPlaybackStore(fake.env);
    const off = store.subscribe(() => {});
    expect(fake.listeners.motion.size).toBe(1);
    watchGrid(store, fake, 1, 3);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["r0c0", "r0c1", "r0c2"]);
    // Turned on: what plays by itself stops at once, and a scroll doesn't start it again.
    fake.setReduced(true);
    expect(store.playing()).toEqual([]);
    fake.scrolled();
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual([]);
    // A hover still plays one.
    store.play("r0c1");
    fake.advance(HOVER_INTENT);
    expect(store.playing()).toEqual(["r0c1"]);
    store.stop("r0c1");
    // Turned off: the cards in view play again once the page is still.
    fake.setReduced(false);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["r0c0", "r0c1", "r0c2"]);
    off();
    expect(fake.listeners.motion.size).toBe(0);
  });

  it("with Save-Data or on a 2G connection nothing plays by itself (hover still does)", () => {
    const { env, card, advance, observed, listeners } = fakeEnv({ saveData: true });
    const store = createPlaybackStore(env);
    store.watch(card(300), "a")();
    expect(store.watchedCount()).toBe(0);
    expect(observed.size).toBe(0);
    expect(listeners.scroll.size).toBe(0);
    store.play("a");
    advance(HOVER_INTENT);
    expect(store.playing()).toEqual(["a"]);
  });

  it("stops what plays by itself at the next pick once the connection turns to Save-Data or 2G", () => {
    const fake = fakeEnv();
    const store = createPlaybackStore(fake.env);
    watchGrid(store, fake, 1, 2);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["r0c0", "r0c1"]);
    fake.setSaveData(true);
    fake.scrolled();
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual([]);
  });

  it("reads Save-Data and the connection type from the browser", () => {
    const saveData = (connection?: object) => {
      vi.stubGlobal("navigator", { connection });
      return browserPlaybackEnv.saveData();
    };
    try {
      expect(saveData()).toBe(false);
      expect(saveData({ saveData: true, effectiveType: "4g" })).toBe(true);
      expect(saveData({ saveData: false, effectiveType: "2g" })).toBe(true);
      expect(saveData({ effectiveType: "slow-2g" })).toBe(true);
      expect(saveData({ saveData: false, effectiveType: "3g" })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a tap plays a preview and the next tap stops it (the preset header when nothing plays by itself)", () => {
    const { env, advance } = fakeEnv({ reduced: true });
    const store = createPlaybackStore(env);
    store.toggle("a");
    advance(HOVER_INTENT);
    expect(store.playing()).toEqual(["a"]);
    store.toggle("a");
    expect(store.playing()).toEqual([]);
  });

  it("cleans up: unwatching stops the card and frees its place, the last one removes the listeners", () => {
    const { env, card, intersect, advance, observed, listeners, timers } = fakeEnv({ width: 390 });
    const store = createPlaybackStore(env);
    const off = store.subscribe(() => {});
    expect(listeners.visibilitychange.size).toBe(1);
    expect(listeners.motion.size).toBe(1);
    const els = [card(0), card(200), card(400), card(600)];
    const unwatch = els.map((el, i) => store.watch(el, `c${i}`));
    expect(listeners.scroll.size).toBe(1);
    intersect(els.map((el) => [el, 1]));
    advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["c1", "c2", "c3"]);
    unwatch[2]();
    expect(store.playing()).toEqual(["c1", "c3"]);
    expect(observed.has(els[2])).toBe(false);
    advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["c0", "c1", "c3"]);
    intersect([[els[0], 0.9]]);
    unwatch.forEach((u) => u());
    expect(store.watchedCount()).toBe(0);
    expect(store.playing()).toEqual([]);
    expect(listeners.scroll.size).toBe(0);
    // A pick still waiting for the scroll to settle goes with the last card.
    expect(timers.size).toBe(0);
    off();
    expect(listeners.visibilitychange.size).toBe(0);
    expect(listeners.motion.size).toBe(0);
  });

  it("does nothing without IntersectionObserver", () => {
    const { env, card } = fakeEnv();
    const store = createPlaybackStore({ ...env, IntersectionObserver: undefined });
    store.watch(card(0), "a")();
    expect(store.watchedCount()).toBe(0);
  });

  it("plays a clip by itself everywhere, a procedural preview only where nothing can hover, a still never", () => {
    expect(previewKind({ video: "/previews/presets/a.mp4" })).toBe("clip");
    expect(previewKind({ move: "dolly-in" })).toBe("procedural");
    expect(previewKind({ fx: "fire" })).toBe("procedural");
    expect(previewKind({})).toBe("still");
    expect([true, false].map((hover) => autoplays("clip", hover))).toEqual([true, true]);
    expect([true, false].map((hover) => autoplays("procedural", hover))).toEqual([false, true]);
    expect([true, false].map((hover) => autoplays("still", hover))).toEqual([false, false]);
  });

  it('with auto: "touch" (an area page\'s studio cards) nothing plays by itself where a pointer can hover', () => {
    for (const kind of ["clip", "procedural", "still"] as const) expect(autoplays(kind, true, "touch"), kind).toBe(false);
    // Where nothing can hover (a phone) it plays as any card does.
    expect((["clip", "procedural", "still"] as const).map((kind) => autoplays(kind, false, "touch"))).toEqual([true, true, false]);
    expect((["clip", "procedural", "still"] as const).map((kind) => autoplays(kind, false, "touch"))).toEqual((["clip", "procedural", "still"] as const).map((kind) => autoplays(kind, false)));
  });

  it("paused previews: nothing plays by itself, at once and on every pick, yet a hover still plays; played again, the cards in view are picked", () => {
    const fake = fakeEnv({ hover: true, width: 1280, height: 800 });
    const store = createPlaybackStore(fake.env);
    const seen: string[][] = [];
    store.subscribe(() => seen.push(store.playing()));
    watchGrid(store, fake, 1, 3);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["r0c0", "r0c1", "r0c2"]);
    store.setPaused(true);
    expect(store.isPaused()).toBe(true);
    expect(store.playing()).toEqual([]);
    // Scrolling again picks nothing.
    fake.scrolled();
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual([]);
    // The card the pointer rests on still plays.
    store.play("r0c1");
    fake.advance(HOVER_INTENT);
    expect(store.playing()).toEqual(["r0c1"]);
    store.stop("r0c1");
    expect(store.playing()).toEqual([]);
    // Pausing twice changes nothing; playing again waits for the page to be still, then picks what's in view.
    const before = seen.length;
    store.setPaused(true);
    expect(seen.length).toBe(before);
    store.setPaused(false);
    expect(store.playing()).toEqual([]);
    fake.advance(SCROLL_SETTLE);
    expect(store.playing()).toEqual(["r0c0", "r0c1", "r0c2"]);
  });

  it("tells a card playing because the viewer asked (a hover, focus or tap) from one playing by itself", () => {
    const fake = fakeEnv({ hover: true, width: 1280, height: 800 });
    const store = createPlaybackStore(fake.env);
    store.subscribe(() => {});
    watchGrid(store, fake, 1, 3);
    fake.advance(SCROLL_SETTLE);
    expect([store.isPlaying("r0c0"), store.isAsked("r0c0")]).toEqual([true, false]);
    store.play("r0c0");
    fake.advance(HOVER_INTENT);
    expect([store.isPlaying("r0c0"), store.isAsked("r0c0")]).toEqual([true, true]);
    // The pointer leaves: it goes on playing by itself.
    store.stop("r0c0");
    expect([store.isPlaying("r0c0"), store.isAsked("r0c0")]).toEqual([true, false]);
  });

  it("starts the clips of a row at their own places in a shared cycle, however long each took to load (Home)", () => {
    const places = Array.from({ length: 8 }, (_, i) => staggered(i));
    expect(places[0]).toBe(0);
    expect(new Set(places).size).toBe(8);
    expect(Math.max(...places)).toBeLessThan(STAGGER_CYCLE);
    // Ready at any moment, each clip waits for its place: they start apart by its distance from the others'.
    for (const now of [0, 1234.5, 99_999.9]) {
      const starts = places.map((p) => now + untilPlace(p, now));
      for (const [i, s] of starts.entries()) {
        expect(s - now).toBeGreaterThanOrEqual(0);
        expect(s - now).toBeLessThan(STAGGER_CYCLE);
        expect((((s - places[i]) % STAGGER_CYCLE) + STAGGER_CYCLE) % STAGGER_CYCLE).toBeCloseTo(0, 6);
      }
    }
    // One ready late waits for its next turn, not a fixed time.
    expect(untilPlace(350, 4 * STAGGER_CYCLE + 350)).toBe(0);
    expect(untilPlace(350, 4 * STAGGER_CYCLE + 400)).toBeCloseTo(STAGGER_CYCLE - 50, 6);
  });

  it("with reduced motion a hover or tap plays a clip, but a procedural preview keeps its poster", () => {
    expect([false, true].map((reduced) => playsWhenAsked("clip", reduced))).toEqual([true, true]);
    expect([false, true].map((reduced) => playsWhenAsked("procedural", reduced))).toEqual([true, false]);
    expect([false, true].map((reduced) => playsWhenAsked("still", reduced))).toEqual([false, false]);
  });
});

describe("camera move diagrams", () => {
  it("draws every camera move", () => {
    for (const move of Object.keys(CAMERA_MOVES) as CameraMove[]) {
      const parts = glyphFor(move);
      expect(parts.length, move).toBeGreaterThan(0);
      for (const p of parts) expect(p.d, move).toMatch(/^[MLHVQCSAZmlhvaz\d\s.,-]+$/);
    }
  });

  it("keeps every glyph inside its 48 × 36 box", () => {
    for (const [name, parts] of Object.entries(GLYPHS)) {
      for (const p of parts) {
        // Absolute M/L coordinates only (arcs and relative commands are checked by eye).
        for (const m of p.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
          const [x, y] = [Number(m[1]), Number(m[2])];
          expect(x, name).toBeGreaterThanOrEqual(0);
          expect(x, name).toBeLessThanOrEqual(48);
          expect(y, name).toBeGreaterThanOrEqual(0);
          expect(y, name).toBeLessThanOrEqual(36);
        }
      }
    }
  });

  it("tells the common moves apart", () => {
    const glyph = (name: string) => MOVE_GLYPH[motionMove(MOTIONS.find((m) => m.name === name)!)];
    const names = ["Zoom In", "Zoom Out", "Dolly In", "Dolly Out", "Crash Zoom In", "Dolly Zoom In", "360 Orbit", "Arc Left", "Arc Right", "Crane Up", "Crane Down", "Truck Right", "Dutch Angle"];
    const glyphs = names.filter((n) => MOTIONS.some((m) => m.name === n)).map(glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    // Across the whole gallery the diagrams vary a lot.
    expect(new Set(MOTIONS.map((m) => MOVE_GLYPH[motionMove(m)])).size).toBeGreaterThanOrEqual(25);
  });
});

describe("gallery variety at rest", () => {
  it("hashes ids stably", () => {
    expect(stableHash("motion-zoom-in")).toBe(stableHash("motion-zoom-in"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });

  it("spreads the first page of motions over the stills", () => {
    const scenes = new Set(MOTIONS.slice(0, 15).map((m) => previewFor(m).scene));
    expect(scenes.size).toBeGreaterThanOrEqual(3);
  });

  it("doesn't put every destruction effect on the same still the same way round", () => {
    const destruction = EFFECTS.filter((e) => e.category === "Destruction").map(toPresetCard);
    expect(destruction.length).toBeGreaterThan(3);
    const looks = new Set(destruction.map((c) => `${c.preview.scene}|${previewFlip(c) ? 1 : 0}`));
    expect(looks.size).toBeGreaterThanOrEqual(3);
    // Neighbouring cards get different hues.
    expect(new Set(destruction.map((c) => c.hue)).size).toBe(destruction.length);
  });

  it("lets the categories take turns in a gallery's All view", () => {
    const items = [
      { id: "a1", category: "A" },
      { id: "a2", category: "A" },
      { id: "a3", category: "A" },
      { id: "b1", category: "B" },
      { id: "c1", category: "C" },
      { id: "c2", category: "C" },
    ];
    expect(interleaveByCategory(items).map((i) => i.id)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
    // The first row of /effects (its featured order, which takes turns the same way) shows five categories, not one
    // category's near-identical cards.
    const firstRow = featuredGallery(EFFECTS.map(toPresetCard)).presets.slice(0, 5);
    expect(new Set(firstRow.map((c) => c.category)).size).toBe(5);
    expect(new Set(firstRow.map((c) => c.preview.fx)).size).toBeGreaterThanOrEqual(4);
  });

  it("gives cracks, dust and floating heads their own treatment instead of another explosion", () => {
    const fx = (name: string) => effectFx(EFFECTS.find((e) => e.name === name)!);
    expect(fx("Lens Crack")).toBe("crack");
    expect(fx("Disintegration")).toBe("wind");
    expect(fx("Head Off")).toBe("glow");
    expect(fx("Building Explosion")).toBe("explode");
  });

  it("shows one effect per category on Home, the popular one when there is one", () => {
    const row = homeEffects(EFFECTS, 6);
    expect(row).toHaveLength(6);
    expect(new Set(row.map((e) => e.category)).size).toBe(6);
    for (const e of row) {
      const top = EFFECTS.find((x) => x.category === e.category && x.badges?.includes("top"));
      if (top) expect(e.id).toBe(top.id);
    }
    expect(new Set(row.map((e) => previewFor(e).fx)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("storyboard name", () => {
  it("is the idea, or the first scene written by hand", () => {
    expect(storyboardName("  a fox\n in the snow ", ["wide: a fox — beat 1 of 3"])).toBe("a fox in the snow");
    expect(storyboardName(undefined, ["", "The keeper climbs"])).toBe("The keeper climbs");
    expect(storyboardName("", [])).toBe("Storyboard");
    expect(storyboardName("x".repeat(500), [])).toHaveLength(200);
  });
});

describe("releasing color grading's media", () => {
  it("pauses a detached video, drops its source and resets it (in that order)", () => {
    const calls: string[] = [];
    releaseVideo({ pause: () => calls.push("pause"), removeAttribute: (n) => calls.push(`remove ${n}`), load: () => calls.push("load") });
    expect(calls).toEqual(["pause", "remove src", "load"]);
    expect(() => releaseVideo(null)).not.toThrow();
  });

  it("loses a WebGL context explicitly, and tolerates none", () => {
    const lose = vi.fn();
    loseContext({ getExtension: ((name: string) => (name === "WEBGL_lose_context" ? { loseContext: lose } : null)) as WebGLRenderingContext["getExtension"] });
    expect(lose).toHaveBeenCalledOnce();
    expect(() => loseContext(null)).not.toThrow();
    expect(() => loseContext({ getExtension: (() => null) as WebGLRenderingContext["getExtension"] })).not.toThrow();
  });
});

describe("color grading for everyone", () => {
  const view = fs.readFileSync(path.resolve(__dirname, "../src/components/color-grade-view.tsx"), "utf8");

  it("previews its looks on a full-size photo that stays light enough for a phone", async () => {
    const file = path.resolve(__dirname, "../public/samples/grade-sample.jpg");
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThanOrEqual(1280);
    expect(fs.statSync(file).size).toBeLessThan(300 * 1024);
  });

  it("downloads the graded result straight from the browser; the owner saves it to the library, an account to its runs", () => {
    // Download needs no upload. Save is the owner's library or an account's own runs; a guest's Save asks it to sign up.
    expect(view).toMatch(/onClick=\{\(\) => exportTo\("download"\)\}/);
    expect(view).toMatch(/if \(to === "download"\) downloadBlob\(file, file\.name\);/);
    expect(view).toMatch(/const canSave = !!owner \|\| account \|\| guest;/);
    expect(view).toMatch(/\{canSave && \(\s*<Button[^>]*onClick=\{\(\) => exportTo\("library"\)\}/);
    expect(view).toMatch(/if \(to === "library" && guest\) return askToSignUp\("upload"\);/);
    // An account's graded file is uploaded as a result made in the browser (no GPU or key needed).
    expect(view).toMatch(/uploadFile\(file, \{ kinetic: account \}\)/);
  });
});

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Just enough DOM for the execCommand fallback: `copy` dispatches the copy event (with
   * clipboardData unless `noClipboardData`); `active` is what holds the focus.
   */
  function fakeDom({ result = true, fires = true, noClipboardData = false, active = null as unknown }: { result?: boolean; fires?: boolean; noClipboardData?: boolean; active?: unknown } = {}) {
    const ta = { value: "", style: { cssText: "" }, tabIndex: 0, selectionStart: 0, selectionEnd: 0, setAttribute() {}, focus: vi.fn(), select() {}, setSelectionRange: vi.fn(), remove: vi.fn() };
    const listeners = new Set<(e: unknown) => void>();
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const body = { appendChild: vi.fn() };
    const doc = {
      createElement: () => ta,
      body,
      documentElement: {},
      activeElement: active,
      addEventListener: (type: string, fn: (e: unknown) => void) => type === "copy" && listeners.add(fn),
      removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.delete(fn),
      execCommand: vi.fn(() => {
        if (fires) listeners.forEach((fn) => fn({ clipboardData: noClipboardData ? null : { setData }, preventDefault }));
        return result;
      }),
    };
    vi.stubGlobal("document", doc);
    return { ta, doc, body, setData, preventDefault, listeners };
  }

  it("uses the Clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hi")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });

  it("falls back to execCommand on plain-http origins (no navigator.clipboard): the copy event carries the text", async () => {
    vi.stubGlobal("navigator", {});
    const dom = fakeDom();
    expect(await copyText("fuobe_secret")).toBe(true);
    expect(dom.doc.execCommand).toHaveBeenCalledWith("copy");
    // Set on the event itself, so a focus trap that takes the selection away doesn't matter.
    expect(dom.setData).toHaveBeenCalledWith("text/plain", "fuobe_secret");
    expect(dom.preventDefault).toHaveBeenCalled();
    expect(dom.ta.value).toBe("fuobe_secret");
    expect(dom.ta.remove).toHaveBeenCalled();
    expect(dom.listeners.size).toBe(0);
  });

  it("puts the textarea inside the dialog or menu holding the focus, and gives the focus back", async () => {
    // A Radix dialog or menu traps the focus: a textarea on <body> loses it (and its selection) at once.
    vi.stubGlobal("navigator", {});
    const menu = { appendChild: vi.fn() };
    const item = { closest: vi.fn((sel: string) => (sel.includes('[role="menu"]') ? menu : null)), parentElement: { appendChild: vi.fn() }, focus: vi.fn() };
    const dom = fakeDom({ active: item });
    expect(await copyText("a prompt")).toBe(true);
    expect(menu.appendChild).toHaveBeenCalledWith(dom.ta);
    expect(dom.body.appendChild).not.toHaveBeenCalled();
    expect(item.focus).toHaveBeenCalled();
    // Nothing focused: <body>.
    const plain = fakeDom();
    expect(await copyText("x")).toBe(true);
    expect(plain.body.appendChild).toHaveBeenCalledWith(plain.ta);
  });

  it("doesn't claim a copy that didn't happen (execCommand says true but nothing held)", async () => {
    vi.stubGlobal("navigator", {});
    // No copy event, and the selection is gone (the focus went elsewhere).
    fakeDom({ fires: false });
    expect(await copyText("x")).toBe(false);
    // A browser without clipboardData copies the selection: fine while the textarea still holds it.
    const dom = fakeDom({ noClipboardData: true });
    dom.doc.activeElement = dom.ta;
    dom.ta.selectionEnd = 1;
    expect(await copyText("x")).toBe(true);
  });

  it("says when nothing could be copied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } });
    fakeDom({ result: false, fires: false });
    expect(await copyText("x")).toBe(false);
  });

  it("gives every Copy button the same feedback (copyWithToast)", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
    expect(await copyWithToast("a prompt", "Prompt copied")).toBe(true);
    expect(toasts.ok.at(-1)).toBe("Prompt copied");
    // Plain-http LAN origin and a browser that refuses execCommand too: say how to copy by hand.
    vi.stubGlobal("navigator", {});
    fakeDom({ result: false, fires: false });
    expect(await copyWithToast("a link")).toBe(false);
    expect(toasts.error.at(-1)).toMatch(/select the text/);
  });
});

describe("landmarks", () => {
  it("leaves one <main> per page: the app frame's", () => {
    // Pages render inside StudioChrome, whose <main id="content"> holds them; a second one inside it
    // would give screen readers two main landmarks.
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []));
    const root = path.resolve(__dirname, "../src");
    const mains = [...files(path.join(root, "components")), ...files(path.join(root, "app/(studio)"))]
      .filter((f) => /<main[\s>]/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(mains).toEqual(["components/nav/studio-chrome.tsx"]);
  });
});
