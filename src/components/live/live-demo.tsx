"use client";

import { Zap } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  changesWord,
  countChanges,
  type Demo,
  type DemoView,
  demoEnds,
  FADE_MS,
  frameFile,
  frameOrder,
  LIVE_DEMO,
  pickDemo,
  pillText,
  SETTLE_FADE_MS,
  SMALL_W,
  startView,
  SWEEP_MS,
  sweepPath,
  tierFor,
  typeDelays,
  viewBefore,
} from "@/lib/live/demo";
import { cn } from "@/lib/utils";

/**
 * A recorded live edit session, played back: one prompt that keeps growing. The words type themselves onto the end of
 * the prompt in the dock, each live frame is drawn across the picture as it arrives, the full-quality picture settles
 * and the change count goes up; at the end a compare sweep shows the original against the last picture. The whole
 * picture always shows (a zoom step in the file is not played). It loops, pauses off screen and in a hidden tab and
 * picks up where it stopped, and under reduced motion it is a still before/after. Each card loads the files as wide as
 * it is on the screen, in the order the script shows them, once it is in view; the first picture shows from its small
 * file at once and turns sharp when its sharp file is decoded, and never goes back. No GPU, no requests beyond the
 * files: guests, Home and the Apps card see it.
 */

export { LIVE_DEMO };

let loaded: Promise<Demo | null> | null = null;
/** The session this page shows: picked once, at random, so every player on the page agrees. */
let chosen: ReturnType<typeof pickDemo> | null = null;
// A failed fetch is not kept, so the next player tries again (the same session).
const loadDemo = () =>
  (loaded ??= fetch(`${(chosen ??= pickDemo()).src}?v=${chosen.v}`)
    .then((r) => (r.ok ? (r.json() as Promise<Demo>) : null))
    .catch(() => null)
    .then((d) => {
      if (!d) loaded = null;
      return d;
    }));

/** Each frame file is fetched and decoded once per page, however many players show it. */
const decoded = new Map<string, Promise<void>>();
/** The files decoded so far. */
const done = new Set<string>();
function ready(url: string) {
  let p = decoded.get(url);
  if (!p) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    p = img.decode().then(
      () => {
        done.add(url);
      },
      // A failed decode is tried again the next time the frame is needed.
      () => {
        decoded.delete(url);
      },
    );
    decoded.set(url, p);
  }
  return p;
}
/** Files load this many at a time, in order, so the next frames are there first. */
const LOAD_AT_ONCE = 4;
function preload(urls: string[], alive: () => boolean) {
  let i = 0;
  const next = (): Promise<void> | undefined => (alive() && i < urls.length ? ready(urls[i++]).then(next) : undefined);
  for (let k = 0; k < LOAD_AT_ONCE; k++) void next();
}

/** A 2×2 AVIF: a browser that can't show it gets the WebP files. */
const AVIF_PROBE =
  "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAApbWRhdBIACgc4ADaQENBpMhQZQmMEwAA0AACQQMkY4Jp6ObLjaA==";
let avifProbe: Promise<boolean> | null = null;
const avifOk = () =>
  (avifProbe ??= new Promise<boolean>((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth > 0);
    img.onerror = () => res(false);
    img.src = AVIF_PROBE;
  }));
/** A slow file never stalls the loop for long. */
const READY_CAP_MS = 1200;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** A visitor's keys, for the change they type themselves: each key types the next letter of it. */
export interface KeyBus {
  /** Resolves true at the next key (at once if one is waiting), or false after `ms` with none. */
  wait(ms: number): Promise<boolean>;
  press(n?: number): void;
  clear(): void;
}

/** Keys pressed faster than they can be typed wait their turn, up to a word or so. */
const KEYS_HELD = 24;

export function createKeyBus(): KeyBus {
  let pending = 0;
  let waiter: ((key: boolean) => void) | null = null;
  return {
    wait: (ms) =>
      new Promise<boolean>((res) => {
        if (pending > 0) {
          pending--;
          return res(true);
        }
        const t = setTimeout(() => {
          if (waiter === done) waiter = null;
          res(false);
        }, ms);
        const done = (key: boolean) => {
          clearTimeout(t);
          res(key);
        };
        waiter = done;
      }),
    press: (n = 1) => {
      pending = Math.min(KEYS_HELD, pending + n);
      if (waiter && pending > 0) {
        const w = waiter;
        waiter = null;
        pending--;
        w(true);
      }
    },
    clear: () => {
      pending = 0;
      waiter = null;
    },
  };
}

/** How long the visitor's turn waits for a first key before it types itself, and for the next key once they type. */
export const TURN_WAIT_MS = 4000;
export const KEY_IDLE_MS = 1600;

export interface PlayerOptions {
  /** Play one round and rest on the last picture, rather than going round again. */
  once?: boolean;
  /** The change (0-based) the visitor types with `keys`; a key types the next letter, and it types itself when idle. */
  keyChange?: number;
  keys?: KeyBus;
}

/**
 * The recorded session's player, for any card that shows it: it loads the file, measures the card (`box`) to pick the
 * files it needs, plays while the card is in view and returns what is on screen now (`v`). Under reduced motion `v` is
 * the start, and the card shows a still compare. Both players use it: the picture with its dock (LiveDemo), which goes
 * round for ever, and the picture with its sentence and chat (LiveChatDemo), which plays once, lets the visitor type a
 * change and then `show`s whatever picture of the session they go back to (mode "rest" until `replay`).
 */
export function useDemoPlayer(opts: PlayerOptions = {}) {
  const options = useRef(opts);
  useLayoutEffect(() => {
    options.current = opts;
  });
  /** "play" runs the script; "rest" holds the picture `show` put up, or the last one of a round played `once`. */
  const [mode, setMode] = useState<"play" | "rest">("play");
  /** How many rounds have played to the end (with `once`). */
  const [ended, setEnded] = useState(0);
  const [demo, setDemo] = useState<Demo | null>(null);
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  // Nothing plays or loads until the observer says the player is in view.
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<DemoView | null>(null);
  /** The script step to run next, kept across pauses so the loop picks up where it stopped. */
  const at = useRef(0);
  /** How many times the loop has gone round since the page loaded: a chat beside the picture keeps every round. */
  const [round, setRound] = useState(0);
  /**
   * The files this card needs (see tierFor), and whether the browser shows AVIF; nothing loads before both are known.
   * The card keeps the largest files it has needed, so a narrower window does not load smaller copies of them.
   */
  const [tier, setTier] = useState(0);
  const [avif, setAvif] = useState<boolean | null>(null);
  /** The first picture shows from its small file until its sharp one is decoded; once sharp, it stays sharp. */
  const [firstSharp, setFirstSharp] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setTier((t) => Math.max(t, tierFor(el.getBoundingClientRect().width * (window.devicePixelRatio || 1))));
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    void avifOk().then((ok) => alive && setAvif(ok));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void loadDemo().then((d) => alive && setDemo(d));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // One callback can carry several entries for the player; the newest is the one that counts.
    const io = new IntersectionObserver(
      (es) => {
        const e = es[es.length - 1];
        if (e) setVisible(e.isIntersecting && document.visibilityState === "visible");
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    const onVis = () => {
      if (document.visibilityState !== "visible") return setVisible(false);
      const r = el.getBoundingClientRect();
      setVisible(r.bottom > 0 && r.top < window.innerHeight);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const fileOf = (id: string, need: number) => {
    const f = demo?.frames[id];
    return f && demo ? frameFile(f, need, demo.size[0], avif !== false) : "";
  };
  const first = demo ? (frameOrder(demo)[0] ?? demoEnds(demo).before) : null;
  const src = (id: string | null) => {
    if (!id) return "";
    const sharp = fileOf(id, tier);
    // A still (reduced motion) loads nothing ahead, so it shows the sharp file straight away.
    return id === first && !reduced && !firstSharp && !done.has(sharp) ? fileOf(id, SMALL_W) : sharp;
  };

  // The player: one step at a time, each with its own small animation, then round again.
  useEffect(() => {
    if (!demo || reduced || !visible || !tier || avif === null || mode !== "play") return;
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const wait = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(() => {
          timers.delete(t);
          r();
        }, ms);
        timers.add(t);
      });
    const url = (id: string, need = tier) => {
      const f = demo.frames[id];
      return f ? frameFile(f, need, demo.size[0], avif) : "";
    };
    const shown = (id: string) => Promise.race([ready(url(id)), wait(READY_CAP_MS)]);
    const order = frameOrder(demo);
    const { before, after } = demoEnds(demo);
    // The first picture already shows from its small file (it went into the page before this ran). Every frame now
    // loads in the order the script shows them, and the first one's sharp file takes over once it is decoded.
    preload(order.map((id) => url(id)), () => alive);
    if (order[0]) void ready(url(order[0])).then(() => alive && setFirstSharp(true));
    void (async () => {
      let i = at.current;
      let typed = "";
      /** The change being made, and on the visitor's: whether it has begun, and whether their last wait ended in a key. */
      let change = 0;
      let opened = false;
      let keyed = false;
      if (i > 0) {
        const v = viewBefore(demo, i);
        typed = v.typed;
        change = v.changes;
        setView(v);
      } else setView((v) => startView(before, v && v.frame !== before ? v.frame : null));
      while (alive) {
        for (; i < demo.script.length; i++) {
          if (!alive) return;
          at.current = i;
          const s = demo.script[i];
          if (s.type === "frame") {
            await shown(s.frame);
            if (!alive) return;
            // The same frame again (the original at a new round) keeps its slower fade back; the full-quality picture
            // fades in over the live frame before it gently, so it reads as the same picture settling.
            setView(
              (v) =>
                v && {
                  ...v,
                  under: v.frame === s.frame ? v.under : v.frame,
                  frame: s.frame,
                  fade: v.frame === s.frame ? v.fade : !s.live && v.sweep ? SETTLE_FADE_MS : FADE_MS,
                  sweep: !!s.live,
                },
            );
            await wait(s.ms);
          } else if (s.type === "zoom") {
            if (s.ms > 0) await wait(s.ms);
          } else if (s.type === "type") {
            const base = typed;
            const delays = typeDelays(s.text, s.ms);
            const { keys, keyChange } = options.current;
            // The visitor's change: each letter waits for a key (the first for a while), and types itself when none comes.
            const mine = !!keys && keyChange === change;
            for (let c = 0; c < delays.length; c++) {
              if (!alive) return;
              if (mine) {
                keyed = await keys.wait(keyed ? KEY_IDLE_MS : opened ? delays[c] : TURN_WAIT_MS);
                opened = true;
                if (!alive) return;
              }
              const t = base + [...s.text].slice(0, c + 1).join("");
              setView((v) => v && { ...v, typed: t });
              if (!mine) await wait(delays[c]);
            }
            typed = base + s.text;
          } else if (s.type === "change") {
            setView((v) => v && { ...v, changes: v.changes + 1 });
            change++;
            opened = keyed = false;
            await wait(s.ms);
          } else if (s.type === "compare") {
            const t0 = performance.now();
            while (alive && performance.now() - t0 < s.ms) {
              const p = (performance.now() - t0) / s.ms;
              setView((v) => v && { ...v, compare: 50 + 42 * Math.sin(p * Math.PI * 2) });
              await wait(33);
            }
            // The line stays where the sweep ends (the middle), rather than vanishing: a round played `once` rests on it
            // for the visitor to drag, and a looping one keeps it until the next round goes back to the original.
            if (alive) setView((v) => v && { ...v, compare: 50 });
          } else await wait(s.ms);
        }
        if (!alive) return;
        at.current = 0;
        // Played once: rest on the last picture until the visitor goes back through it or plays it again.
        if (options.current.once) {
          setEnded((n) => n + 1);
          setMode("rest");
          return;
        }
        // Round again: the last picture fades back to the original.
        i = 0;
        typed = "";
        change = 0;
        setRound((r) => r + 1);
        setView((v) => startView(before, v ? (v.frame !== before ? v.frame : null) : after !== before ? after : null));
      }
    })();
    return () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
      options.current.keys?.clear();
    };
  }, [demo, reduced, visible, tier, avif, mode]);

  /**
   * Stop playing and put up one picture of the session: drawn across like a live frame (sweep), faded in, or cut to at
   * once. The words and the count stay as they were; the caller says which words the picture holds.
   */
  const show = useCallback((frame: string, how: "sweep" | "fade" | "cut" = "fade") => {
    setMode("rest");
    setView((v) => v && (v.frame === frame ? v : { ...v, under: v.frame, frame, sweep: how === "sweep", fade: how === "fade" ? FADE_MS : 0, compare: null }));
  }, []);
  /** Move the compare line (0 to 100, the original on the left) while the player rests on it. */
  const compareTo = useCallback((n: number) => {
    setView((v) => v && v.compare !== null ? { ...v, compare: Math.min(100, Math.max(0, n)) } : v);
  }, []);
  /** Play the session again from the start: a new round. */
  const replay = useCallback(() => {
    at.current = 0;
    setRound((r) => r + 1);
    setMode("play");
  }, []);

  const ends = demo ? demoEnds(demo) : null;
  // Under reduced motion the still compare shows, with nothing left over from a loop that was playing.
  const v = ends && (reduced || !view) ? startView(ends.before) : view;
  // Nothing shows before the card knows which files it needs, so no file is fetched that it then drops.
  const showImages = (visible || view !== null) && tier > 0 && avif !== null;
  return { box, demo, ends, v, round, ended, mode, visible, reduced, src, showImages, show, replay, compareTo };
}

type Player = ReturnType<typeof useDemoPlayer>;

/**
 * The picture itself: the frame on screen, the one fading out under it, a live frame's sweep and the compare. Under
 * reduced motion, a still before/after to drag.
 */
export function DemoPicture({ demo, ends, v, reduced, src, showImages, mode, compareTo, alt = "A live edit: the picture changing as the words are typed" }: Player & { alt?: string }) {
  const dragging = useRef(false);
  if (!demo || !ends || !v || !showImages) return null;
  if (reduced) return <StillCompare before={src(ends.before)} after={src(ends.after)} changes={countChanges(demo)} />;
  const sweep = sweepPath({ s: 1, x: 0 });
  const compare = v.compare;
  // Once the player rests on the compare, its line is a slider: drag it, tap where it goes, or use the arrow keys.
  const draggable = compare !== null && mode === "rest";
  const at = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * 100;
  };
  return (
    <div
      className={cn("absolute inset-0", draggable && "cursor-ew-resize touch-pan-y select-none")}
      onPointerDown={
        draggable
          ? (e) => {
              if (e.button !== 0) return;
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              compareTo(at(e.currentTarget, e.clientX));
            }
          : undefined
      }
      onPointerMove={draggable ? (e) => dragging.current && compareTo(at(e.currentTarget, e.clientX)) : undefined}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      style={
        {
          "--sweep-from": `${sweep.from}%`,
          "--sweep-to": `${sweep.to}%`,
          "--scan-from": `${sweep.scanFrom}%`,
          "--scan-to": `${sweep.scanTo}%`,
        } as CSSProperties
      }
    >
      {/* Both pictures sit in one keyed list, so the frame that drops underneath keeps its painted image. */}
      {[v.under, v.frame]
        .filter((id): id is string => !!id)
        .map((id) => {
          const top = id === v.frame;
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={id}
              src={src(id)}
              alt={top ? alt : ""}
              className="absolute inset-0 size-full object-cover"
              style={top ? { animation: v.sweep ? `live-sweep ${SWEEP_MS}ms cubic-bezier(.45,0,.55,1)` : v.fade ? `live-fade ${v.fade}ms ease-out` : "none" } : undefined}
              onError={
                top
                  ? (e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }
                  : undefined
              }
              draggable={false}
            />
          );
        })}
      {/* The leading edge of a live frame as it is drawn across. */}
      {v.sweep && (
        <span key={`s-${v.frame}`} className="pointer-events-none absolute inset-0 opacity-0" style={{ animation: `live-scan ${SWEEP_MS}ms cubic-bezier(.45,0,.55,1)` }} aria-hidden>
          <span className="absolute inset-y-0 left-0 w-10 -translate-x-1/2 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          <span className="absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-white/70 shadow-[0_0_10px_rgba(255,255,255,.6)]" />
        </span>
      )}
      {compare !== null && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src(ends.before)} alt="" className="absolute -inset-px object-cover" style={{ width: "calc(100% + 2px)", height: "calc(100% + 2px)", clipPath: `inset(-2px ${100 - compare}% -2px 0)` }} draggable={false} />
          <span className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,.5)]" style={{ left: `${compare}%` }} />
          {draggable && (
            <span
              role="slider"
              tabIndex={0}
              aria-label="Compare the original with the last picture"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(compare)}
              aria-valuetext={`Original ${Math.round(compare)}%, edited ${100 - Math.round(compare)}%`}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 25 : 5;
                const next =
                  e.key === "ArrowLeft" || e.key === "ArrowDown" ? compare - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? compare + step : e.key === "Home" ? 0 : e.key === "End" ? 100 : null;
                if (next === null) return;
                e.preventDefault();
                compareTo(next);
              }}
              className="absolute top-1/2 -mt-3.5 -ml-3.5 grid size-7 place-items-center rounded-full bg-white text-black shadow-[0_2px_8px_rgb(0_0_0/30%)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-safe:animate-[live-fade_300ms_ease-out]"
              style={{ left: `${compare}%` }}
            >
              <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="currentColor">
                <path d="M6 4 2 8l4 4V4Zm4 0v8l4-4-4-4Z" />
              </svg>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** The pill in the picture's corner: Live, and on a compact card the count once there are two changes. */
export function LivePill({ v, compact }: { v: DemoView | null; compact?: boolean }) {
  const pill = v ? pillText(v, compact) : { main: "Live", count: null };
  return (
    <span className={cn("absolute inline-flex items-center gap-1.5 rounded-full bg-black/45 font-medium whitespace-nowrap backdrop-blur", compact ? "top-1.5 left-1.5 px-2 py-0.5 text-[10.5px]" : "top-3 left-3 px-2.5 py-1 text-[11px]")} role="status" aria-live="off">
      <span className="size-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
      {pill.main}
      {pill.count && <span className="text-white/75">· {pill.count}</span>}
    </span>
  );
}

/** The compare sweep's labels: the original on the left, the changes on the right. */
export function CompareLabels({ v, compact, className }: { v: DemoView | null; compact?: boolean; className?: string }) {
  if (!v || v.compare === null) return null;
  return (
    <div className={cn("pointer-events-none absolute inset-x-3 flex justify-between text-[11px] font-medium", compact ? "inset-x-2 bottom-12" : "bottom-16", className)} data-live-compare>
      <span className="rounded-full bg-black/45 px-2 py-0.5 backdrop-blur">Original</span>
      <span className="rounded-full bg-white/90 px-2 py-0.5 text-black">{changesWord(v.changes)}</span>
    </div>
  );
}

export function LiveDemo({ compact, className, onTypeAttempt }: { compact?: boolean; className?: string; onTypeAttempt?: () => void }) {
  const player = useDemoPlayer();
  const { box, demo, v } = player;
  const ratio = demo ? `${demo.size[0]} / ${demo.size[1]}` : "4 / 3";
  // The typed text fades on the left only once it is wider than the bar; short text shows whole.
  const typedOuter = useRef<HTMLSpanElement>(null);
  const typedInner = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const typedNow = v?.typed ?? "";
  useLayoutEffect(() => {
    const o = typedOuter.current;
    const i = typedInner.current;
    setClipped(!!typedNow && !!o && !!i && i.offsetWidth > o.clientWidth + 1);
  }, [typedNow]);

  return (
    <div ref={box} className={cn("@container relative isolate overflow-hidden rounded-2xl bg-media text-white", className)} style={{ aspectRatio: compact ? ratio : undefined }} data-live-demo>
      <DemoPicture {...player} />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-black/10" />
      <LivePill v={v} compact={compact} />
      {/* The compare sweep has its own labels; the count steps aside while it plays. */}
      {!compact && v && <ChangeCount changes={v.changes} hidden={v.compare !== null} />}
      <CompareLabels v={v} compact={compact} />
      <div className={cn("absolute inset-x-3 bottom-3 flex items-center gap-2", compact && "inset-x-2 bottom-2")}>
        <button
          type="button"
          tabIndex={onTypeAttempt ? 0 : -1}
          onClick={onTypeAttempt}
          className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/12 text-left ring-1 ring-white/15 backdrop-blur-md", compact ? "h-8 px-2 text-[11.5px]" : "h-11 px-3 text-[14px]")}
          aria-label="Type a change"
        >
          <Zap className={cn("shrink-0 text-amber-300", compact ? "size-3" : "size-3.5")} />
          {/* The end of the text stays in view as it grows; text cut off on the left fades out rather than ending mid-letter. */}
          <span
            ref={typedOuter}
            className={cn("flex min-w-0 overflow-hidden whitespace-nowrap", v?.typed && "justify-end", v?.typed && clipped && "[mask-image:linear-gradient(90deg,transparent,#000_1.25rem)]")}
            data-live-typed-clipped={(v?.typed && clipped) || undefined}
          >
            {v?.typed ? (
              <span ref={typedInner} className="shrink-0" data-live-typed>
                {v.typed}
              </span>
            ) : (
              <span className="truncate text-white/55">Type a change, then keep adding…</span>
            )}
          </span>
          <span className="-ml-1.5 h-4 w-px shrink-0 bg-white/80 motion-safe:animate-[live-caret_1s_steps(1)_infinite]" />
        </button>
      </div>
    </div>
  );
}

/**
 * How many changes the one prompt holds so far: "One prompt" and the count, which pops each time a change settles. The
 * words themselves are in the dock.
 */
export function ChangeCount({ changes, hidden }: { changes: number; hidden?: boolean }) {
  if (!changes) return null;
  return (
    <div className={cn("pointer-events-none absolute top-3 right-3 flex items-center gap-1 text-[11px] transition-opacity duration-300", hidden && "opacity-0")} aria-hidden={hidden || undefined} data-live-count={changes}>
      <span className="shrink-0 rounded-full bg-black/45 px-2 py-0.5 backdrop-blur max-[420px]:hidden">One prompt</span>
      <span key={changes} className="shrink-0 rounded-full bg-white/95 px-2 py-0.5 font-medium text-black tabular-nums ring-2 ring-primary/60 animate-[live-chip_260ms_ease-out]">
        {changesWord(changes)}
      </span>
    </div>
  );
}

function StillCompare({ before, after, changes }: { before: string; after: string; changes: number }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="absolute inset-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt="After a live edit" className="absolute inset-0 size-full object-cover" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={before} alt="Before" className="absolute inset-0 size-full object-cover" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Compare before and after" className="absolute inset-x-6 top-1/2 opacity-0" />
      <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${pos}%` }} />
      {changes > 0 && (
        <div className="pointer-events-none absolute inset-x-3 top-12 flex justify-between text-[11px] font-medium">
          <span className="rounded-full bg-black/45 px-2 py-0.5 backdrop-blur">Original</span>
          <span className="rounded-full bg-white/90 px-2 py-0.5 text-black">{changesWord(changes)}</span>
        </div>
      )}
    </div>
  );
}
