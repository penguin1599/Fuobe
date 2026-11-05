"use client";

import { Pause, Play } from "lucide-react";
import { useId } from "react";
import { DEMO_MEDIA, isRunning, playLabel, stateLabel } from "@/lib/av/clean-voice-demo";
import { cn } from "@/lib/utils";
import { useCleanVoiceDemo } from "./use-clean-voice-demo";

/**
 * Clean up voice's demo, for anyone who hasn't cleaned a file of their own yet: a photo of a woman talking in a noisy
 * restaurant, and one tap to take the noise away. Both takes (the room as recorded, her voice alone) start together
 * through Web Audio, one AudioContext with a gain each, so a switch happens at the same moment in her speech; the picture
 * softens with the sound. What happens when is decided in src/lib/av/clean-voice-demo.ts.
 */

export function CleanVoiceDemo({
  name = "Clean up voice",
  ready = true,
  className,
}: {
  name?: string;
  /** False while the page doesn't yet know whether to show the demo: it keeps its place, unseen, and fetches nothing. */
  ready?: boolean;
  className?: string;
}) {
  // The demo's sound (use-clean-voice-demo.ts, shared with Home's Audio tile): its clips are fetched as soon as it shows.
  const { state, toast, tap, choose, barRef } = useCleanVoiceDemo({ prefetch: ready });
  const headingId = useId();

  const playing = state.phase === "playing";
  const moving = isRunning(state) || state.phase === "done";
  const buttonShown = !playing;

  return (
    <section
      className={cn("mx-auto grid w-full max-w-[760px] gap-[18px] transition-opacity duration-300 motion-reduce:transition-none", !ready && "invisible opacity-0", className)}
      aria-labelledby={headingId}
    >
      <header className="grid gap-1.5">
        <span className="text-[12px] font-medium tracking-[.06em] text-muted-foreground uppercase">{name}</span>
        <h2 id={headingId} className="font-heading text-[clamp(34px,7vw,48px)] leading-[1.05] tracking-[-.01em] text-balance">
          Studio-clean voice from any recording.
        </h2>
        <p className="max-w-[52ch] text-[15px] leading-[1.55] text-muted-foreground">
          Recorded on a phone in a noisy restaurant. Press play and the noise disappears while she keeps talking.
        </p>
      </header>

      <div
        role="group"
        aria-label="Demo: a woman talking in a noisy restaurant"
        onClick={tap}
        className="relative isolate aspect-[4/3] w-full max-w-full cursor-pointer touch-manipulation overflow-hidden rounded-xl bg-media [-webkit-tap-highlight-color:transparent]"
      >
        <div
          className={cn(
            "absolute inset-0 origin-[50%_38%] transition-transform duration-[9s] ease-[cubic-bezier(.2,.6,.3,1)] motion-reduce:scale-100 motion-reduce:transition-none",
            moving && "scale-[1.045]",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={DEMO_MEDIA.room}
            alt="A woman talking at a marble table in a busy restaurant, waiters and diners behind her"
            width={1280}
            height={960}
            fetchPriority="high"
            draggable={false}
            className="absolute inset-0 block size-full object-cover select-none"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={DEMO_MEDIA.quiet}
            alt=""
            width={1280}
            height={960}
            draggable={false}
            data-demo-quiet
            className={cn("absolute inset-0 block size-full object-cover transition-opacity duration-1000 ease-in-out select-none motion-reduce:transition-none", state.clean ? "opacity-100" : "opacity-0")}
          />
        </div>

        <span
          className="absolute top-3 left-3 z-[2] inline-flex items-center gap-2 rounded-full bg-[rgb(10_8_6/.55)] py-1.5 pr-3 pl-2.5 text-[13px] font-medium text-white backdrop-blur-[10px]"
          aria-live="polite"
        >
          <span className={cn("size-2 rounded-full motion-reduce:animate-none", state.clean ? "bg-[#7ee2b8]" : "bg-[#ffb347]", playing && !state.clean && "animate-live-dot")} />
          <span data-demo-state>{stateLabel(state.clean)}</span>
        </span>

        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 left-1/2 z-[2] -translate-x-1/2 rounded-full bg-[rgb(10_8_6/.6)] px-[18px] py-2.5 font-heading text-[26px] leading-[1.1] tracking-[.01em] whitespace-nowrap text-white backdrop-blur-[10px] transition-[opacity,translate] duration-600 ease-in-out motion-reduce:transition-none",
            toast ? "-translate-y-1/2 opacity-100" : "-translate-y-[40%] opacity-0",
          )}
        >
          Noise removed
        </span>

        {/* Hidden while it plays, but still reachable from the keyboard: focused, it shows as Pause. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            tap();
          }}
          className={cn(
            "absolute inset-x-0 bottom-[22px] z-[3] mx-auto inline-flex min-h-[52px] w-fit cursor-pointer touch-manipulation items-center gap-2.5 rounded-full border-0 bg-white/92 pr-[22px] pl-4 text-[15px] leading-none font-semibold whitespace-nowrap text-[#141210] shadow-[0_10px_30px_rgb(0_0_0/.35)] transition-[opacity,translate] duration-350 ease-in-out outline-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ring motion-reduce:transition-none",
            buttonShown ? "opacity-100" : "pointer-events-none translate-y-1.5 opacity-0 focus-visible:pointer-events-auto focus-visible:translate-y-0 focus-visible:opacity-100",
          )}
        >
          {playing ? <Pause className="size-[22px] fill-current" aria-hidden="true" /> : <Play className="size-[22px] fill-current" aria-hidden="true" />}
          <span>{playLabel(state)}</span>
        </button>

        <div className="absolute inset-x-0 bottom-0 z-[2] h-[3px] bg-white/18" aria-hidden="true">
          <i ref={barRef} className="block h-full w-0 bg-white" />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex gap-1 rounded-full bg-muted p-1" role="group" aria-label="Noise">
          {[
            { clean: false, label: "Noise on" },
            { clean: true, label: "Noise off" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={state.clean === o.clean}
              onClick={() => choose(o.clean)}
              className={cn(
                "min-h-11 cursor-pointer touch-manipulation rounded-full px-[18px] text-[14px] leading-none font-medium transition-[background-color,color] duration-250 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                state.clean === o.clean ? "bg-background text-foreground shadow-[0_1px_3px_rgb(0_0_0/.12)]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="m-0 text-[13px] text-muted-foreground" data-demo-hint>
          {state.hint}
        </p>
      </div>

      <p className="max-w-[60ch] border-t pt-3.5 text-[13px] text-muted-foreground">
        Same 8 seconds, same moment in her sentence: switching only changes what you hear around her voice.
      </p>
    </section>
  );
}
