"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState, type RefObject } from "react";
import {
  createDemoAudio,
  DEMO_MEDIA,
  DEMO_START,
  demoReducer,
  FLASH_MS,
  isRunning,
  switchDue,
  type DemoAudio,
  type DemoState,
} from "@/lib/av/clean-voice-demo";
import { claimSound, onOtherSound } from "@/lib/av/one-sound";

/**
 * The Clean up voice demo's sound, shared by the studio's demo (clean-voice-demo.tsx) and Home's Audio tile
 * (home/bento-voice.tsx): both takes (the room as recorded, her voice alone) start together through Web Audio, one
 * AudioContext with a gain each, so a switch happens at the same moment in her speech. What happens when is decided in
 * src/lib/av/clean-voice-demo.ts; this hook plays it. The context is made and resumed inside the visitor's tap (a phone
 * only lets a tap start sound), so nothing ever plays by itself.
 *
 * It keeps to one sound on the page (src/lib/av/one-sound.ts), and pauses when the tab is hidden, when the sound stops
 * from outside (a call, the lock screen) and, given `view`, when its box leaves the screen: shown as paused, one tap
 * resumes it.
 */

type Win = Window & { webkitAudioContext?: typeof AudioContext };
type Nav = Navigator & { audioSession?: { type: string } };

/** A clip that hasn't arrived by then counts as not loaded (the button offers to try again). */
const FETCH_TIMEOUT_MS = 15_000;
/** With `view`: under this share of the box on screen, the sound pauses. */
export const VIEW_SHARE = 0.25;

const decode = (ctx: AudioContext, bytes: ArrayBuffer) => new Promise<AudioBuffer>((ok, no) => ctx.decodeAudioData(bytes, ok, no));

/** iPhone: play like a video does, with the ringer switch on silent too (asked before the sound starts). */
function playThroughSilentSwitch() {
  try {
    const session = (navigator as Nav).audioSession;
    if (session) session.type = "playback";
  } catch {}
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

export interface CleanVoiceDemoOptions {
  /**
   * Fetch both clips as soon as this is true, so the first tap plays at once (the studio, where the demo is the page).
   * Left out, nothing is fetched until the first tap (Home, where most visitors never play it).
   */
  prefetch?: boolean;
  /** The demo's box: once less than VIEW_SHARE of it is on screen, the sound pauses. */
  view?: RefObject<Element | null>;
}

export interface CleanVoiceDemoPlayer {
  state: DemoState;
  /** "Noise removed" is showing: the noise has just gone by itself. */
  toast: boolean;
  /** The play button (and the photo): play, pause, resume or play again. */
  tap(): void;
  /** Noise on (false) or Noise off (true): switches at once while it plays, or starts it in that mode. */
  choose(clean: boolean): void;
  /** The progress line: its width follows the clips' clock. */
  barRef: RefObject<HTMLElement | null>;
}

export function useCleanVoiceDemo({ prefetch = false, view }: CleanVoiceDemoOptions = {}): CleanVoiceDemoPlayer {
  const [state, dispatch] = useReducer(demoReducer, DEMO_START);
  // The last automatic switch whose "Noise removed" has gone again.
  const [shown, setShown] = useState(0);
  const id = useId();
  const stateRef = useRef<DemoState>(state);
  const ctxRef = useRef<AudioContext | null>(null);
  const bytesRef = useRef<Promise<ArrayBuffer[]> | null>(null);
  const audioRef = useRef<DemoAudio | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** Both clips' bytes, fetched once (again after a failure). */
  const bytes = useCallback(() => {
    bytesRef.current ??= Promise.all([fetchBytes(DEMO_MEDIA.noisy), fetchBytes(DEMO_MEDIA.clean)]).catch((e) => {
      bytesRef.current = null;
      throw e;
    });
    return bytesRef.current;
  }, []);

  useEffect(() => {
    if (prefetch) bytes().catch(() => {});
  }, [prefetch, bytes]);

  /** The AudioContext, made and resumed inside the tap (a phone only lets a tap start sound). */
  const context = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext ?? (window as Win).webkitAudioContext;
      if (!AC) return null;
      playThroughSilentSwitch();
      let ctx: AudioContext;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
      // A call, the lock screen or another app can stop the sound: show it as paused, so one tap resumes it.
      ctx.onstatechange = () => {
        if (ctx.state !== "running") dispatch({ type: "interrupted" });
      };
      ctxRef.current = ctx;
    }
    ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  };

  /** Pauses the sound from outside (the tab hidden, the box off screen, another sound): one tap resumes it. */
  const pause = useCallback(() => {
    if (stateRef.current.phase !== "playing") return;
    ctxRef.current?.suspend().catch(() => {});
    dispatch({ type: "interrupted" });
  }, []);

  // A new run: both clips from the top, at the gains of the mode it starts in.
  useEffect(() => {
    // Only a start asks for one (the page coming back into view runs this again with nothing to start).
    if (!state.run || stateRef.current.phase !== "loading") return;
    let cancelled = false;
    (async () => {
      const ctx = ctxRef.current;
      if (!ctx) throw new Error("No sound");
      if (!audioRef.current) {
        const raw = await bytes();
        // decodeAudioData takes its buffer over: decode copies, so a later decode still has the bytes.
        const buffers = await Promise.all(raw.map((b) => decode(ctx, b.slice(0))));
        if (cancelled || ctxRef.current !== ctx) return;
        audioRef.current = createDemoAudio(ctx, buffers);
      }
      if (cancelled) return;
      audioRef.current.start(stateRef.current.clean, () => dispatch({ type: "ended" }));
      dispatch({ type: "started" });
    })().catch(() => {
      if (!cancelled) dispatch({ type: "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [state.run, bytes]);

  // A switch: both gains ramp at once, so the voice carries on where it was.
  useEffect(() => {
    audioRef.current?.switchTo(state.clean, state.ramp);
  }, [state.clean, state.ramp]);

  // The progress line and the automatic switch follow the clips' own clock (it stops while paused).
  useEffect(() => {
    if (state.phase !== "playing") {
      if (barRef.current && state.phase !== "paused") barRef.current.style.width = state.phase === "done" ? "100%" : "0%";
      return;
    }
    let raf = 0;
    const step = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const t = audio.elapsed();
      if (barRef.current) barRef.current.style.width = `${Math.min(100, (t / audio.length) * 100)}%`;
      if (switchDue(stateRef.current, t)) dispatch({ type: "time", t });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state.phase]);

  // "Noise removed", for a moment, when the noise goes by itself.
  useEffect(() => {
    if (!state.flash) return;
    const flash = state.flash;
    const t = setTimeout(() => setShown(flash), FLASH_MS);
    return () => clearTimeout(t);
  }, [state.flash]);

  // One sound on the page: playing, it stops every other, and pauses when another starts.
  useEffect(() => {
    if (state.phase !== "playing") return;
    claimSound(id, document, window);
    return onOtherSound(id, pause, document, window);
  }, [state.phase, id, pause]);

  // A hidden tab pauses the demo (a phone would otherwise keep playing it in the background).
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) pause();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [pause]);

  // Its box leaving the screen pauses it too (while it plays: nothing is watched before then).
  const playing = state.phase === "playing";
  useEffect(() => {
    const el = view?.current;
    if (!playing || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || e.intersectionRatio < VIEW_SHARE) pause();
      },
      { threshold: [0, VIEW_SHARE] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [playing, view, pause]);

  // Leaving the page (or the page being kept aside for a quick way back) stops the sound and starts the demo over.
  useEffect(
    () => () => {
      audioRef.current?.stop();
      audioRef.current = null;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) {
        ctx.onstatechange = null;
        ctx.close().catch(() => {});
      }
      setShown(stateRef.current.flash);
      dispatch({ type: "reset" });
    },
    [],
  );

  const tap = () => {
    const s = stateRef.current;
    if (s.phase === "loading") return;
    const ctx = ctxRef.current;
    // Stopped from outside while it looked like it was playing: this tap brings the sound back.
    if (s.phase === "playing" && ctx && ctx.state !== "running") return void ctx.resume().catch(() => {});
    if (s.phase === "playing") ctx?.suspend().catch(() => {});
    else if (s.phase === "paused") ctx?.resume().catch(() => {});
    else if (!context()) return void dispatch({ type: "failed", unsupported: true });
    dispatch({ type: "tap" });
  };
  const choose = (clean: boolean) => {
    const s = stateRef.current;
    if (!isRunning(s) && !context()) return void dispatch({ type: "failed", unsupported: true });
    // Paused (from outside, or by a tap): a choice switches and plays on from there.
    if (s.phase === "paused") {
      ctxRef.current?.resume().catch(() => {});
      dispatch({ type: "tap" });
    }
    dispatch({ type: "choose", clean });
  };

  return { state, toast: state.flash > shown, tap, choose, barRef };
}
