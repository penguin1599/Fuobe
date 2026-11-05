import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CleanVoiceDemo } from "@/components/audio-tools/clean-voice-demo";
import {
  AUTO_AT,
  AUTO_FADE,
  createDemoAudio,
  DEMO_MEDIA,
  DEMO_START,
  demoReducer,
  gainsFor,
  HINTS,
  isRunning,
  playLabel,
  stateLabel,
  SWITCH_RAMP,
  switchDue,
  type DemoAudioContext,
  type DemoEvent,
  type DemoState,
} from "@/lib/av/clean-voice-demo";

/*
 * Clean up voice's demo (src/lib/av/clean-voice-demo.ts, src/components/audio-tools/clean-voice-demo.tsx): the room plays
 * first and goes by itself at 3 s; a choice switches at once and stops the automatic switch; Play again tells it all again.
 */

const run = (...events: DemoEvent[]) => events.reduce<DemoState>(demoReducer, DEMO_START);
const tap: DemoEvent = { type: "tap" };
const started: DemoEvent = { type: "started" };
const at = (t: number): DemoEvent => ({ type: "time", t });

describe("the demo's story", () => {
  it("starts on the room, with the automatic switch to come", () => {
    const s = run(tap);
    expect(s).toMatchObject({ phase: "loading", clean: false, auto: true, run: 1 });
    expect(playLabel(s)).toBe("Loading…");
    expect(run(tap, started)).toMatchObject({ phase: "playing", clean: false, hint: HINTS.story });
    expect(gainsFor(false)).toEqual([1, 0]);
  });

  it("takes the noise away by itself at 3 s, fading over 1 s, and shows Noise removed once", () => {
    expect(run(tap, started, at(AUTO_AT - 0.01))).toMatchObject({ clean: false, flash: 0 });
    const s = run(tap, started, at(AUTO_AT));
    expect(s).toMatchObject({ clean: true, auto: false, ramp: AUTO_FADE, flash: 1, hint: HINTS.auto });
    expect(gainsFor(true)).toEqual([0, 1]);
    // Later ticks change nothing (the same state, so nothing renders again).
    expect(demoReducer(s, at(AUTO_AT + 1))).toBe(s);
  });

  it("doesn't switch while paused, and switches after resuming", () => {
    const paused = run(tap, started, tap);
    expect(paused.phase).toBe("paused");
    expect(playLabel(paused)).toBe("Resume");
    expect(demoReducer(paused, at(AUTO_AT + 0.5)).clean).toBe(false);
    expect(run(tap, started, tap, tap, at(AUTO_AT)).clean).toBe(true);
  });

  it("cancels the automatic switch when a choice is made", () => {
    const s = run(tap, started, { type: "choose", clean: false });
    expect(s).toMatchObject({ clean: false, auto: false, ramp: SWITCH_RAMP, hint: HINTS.room });
    expect(demoReducer(s, at(AUTO_AT + 1))).toBe(s);
    expect(run(tap, started, { type: "choose", clean: true })).toMatchObject({ clean: true, auto: false, ramp: SWITCH_RAMP, flash: 0, hint: HINTS.voice });
    // After the automatic switch, Noise on puts the room back in a quick ramp.
    expect(run(tap, started, at(AUTO_AT), { type: "choose", clean: false })).toMatchObject({ clean: false, ramp: SWITCH_RAMP });
  });

  it("starts in the mode chosen before playing, with no automatic switch", () => {
    const off = run({ type: "choose", clean: true });
    expect(off).toMatchObject({ phase: "loading", clean: true, auto: false, run: 1 });
    expect(demoReducer(off, started)).toMatchObject({ phase: "playing", hint: HINTS.voice });
    const on = run({ type: "choose", clean: false }, started, at(AUTO_AT + 2));
    expect(on).toMatchObject({ phase: "playing", clean: false, flash: 0, hint: HINTS.room });
    // A choice while the clips load sets the mode they start in.
    expect(run(tap, { type: "choose", clean: true }, started, at(AUTO_AT))).toMatchObject({ clean: true, auto: false, run: 1, flash: 0 });
  });

  it("ends on Play again, which tells the whole story again", () => {
    const done = run(tap, started, at(AUTO_AT), { type: "ended" });
    expect(done).toMatchObject({ phase: "done", hint: HINTS.done });
    expect(playLabel(done)).toBe("Play again");
    expect(isRunning(done)).toBe(false);
    const again = demoReducer(done, tap);
    expect(again).toMatchObject({ phase: "loading", clean: false, auto: true, run: 2 });
    expect(run(tap, started, at(AUTO_AT), { type: "ended" }, tap, started, at(AUTO_AT))).toMatchObject({ clean: true, flash: 2 });
    // A choice after the end plays again in that mode.
    expect(demoReducer(done, { type: "choose", clean: false })).toMatchObject({ phase: "loading", clean: false, auto: false, run: 2 });
  });

  it("ignores taps while loading, and offers to try again when the sound doesn't load", () => {
    const loading = run(tap);
    expect(demoReducer(loading, tap)).toBe(loading);
    const failed = demoReducer(loading, { type: "failed" });
    expect(failed).toMatchObject({ phase: "failed", hint: HINTS.failed });
    expect(playLabel(failed)).toBe("Tap to try again");
    expect(demoReducer(failed, tap)).toMatchObject({ phase: "loading", run: 2 });
    expect(demoReducer(loading, { type: "failed", unsupported: true })).toMatchObject({ phase: "failed", hint: HINTS.unsupported });
  });

  it("shows Pause on the button while it plays", () => {
    expect(playLabel(run(tap, started))).toBe("Pause");
    expect(playLabel(DEMO_START)).toBe("Tap to listen");
  });

  it("shows a stop from outside the page as paused, so one tap resumes it", () => {
    const stopped = run(tap, started, { type: "interrupted" });
    expect(stopped).toMatchObject({ phase: "paused", clean: false, auto: true });
    expect(demoReducer(stopped, tap).phase).toBe("playing");
    for (const s of [DEMO_START, run(tap), stopped, run(tap, started, { type: "ended" })]) expect(demoReducer(s, { type: "interrupted" })).toBe(s);
  });

  it("starts over, ready to play, when the page is put away and comes back", () => {
    const playing = run(tap, started, at(AUTO_AT));
    for (const s of [playing, demoReducer(playing, tap), demoReducer(playing, { type: "ended" }), run(tap)]) {
      const back = demoReducer(s, { type: "reset" });
      expect(back).toMatchObject({ phase: "idle", clean: false, auto: true, hint: HINTS.ready, run: s.run, flash: s.flash });
      expect(playLabel(back)).toBe("Tap to listen");
      expect(demoReducer(back, tap)).toMatchObject({ phase: "loading", auto: true, run: s.run + 1 });
    }
  });

  it("asks for the automatic switch only when it is due", () => {
    const playing = run(tap, started);
    expect(switchDue(playing, AUTO_AT - 0.01)).toBe(false);
    expect(switchDue(playing, AUTO_AT)).toBe(true);
    expect(switchDue(demoReducer(playing, tap), AUTO_AT)).toBe(false);
    expect(switchDue(run(tap, started, at(AUTO_AT)), AUTO_AT + 1)).toBe(false);
    expect(switchDue(run(tap, started, { type: "choose", clean: false }), AUTO_AT + 1)).toBe(false);
  });

  it("says what is heard on the chip, the same on the studio's demo and on Home's Audio tile", () => {
    expect(stateLabel(DEMO_START.clean)).toBe("Noisy restaurant");
    expect(stateLabel(run(tap, started, at(AUTO_AT)).clean)).toBe("Voice only");
    expect(stateLabel(run(tap, started, at(AUTO_AT), { type: "choose", clean: false }).clean)).toBe("Noisy restaurant");
  });
});

/** A stand-in for an AudioContext that records what the demo asks of it. */
function fakeContext() {
  const log: string[] = [];
  const node = (name: string) => ({
    connect: (to: { name?: string }) => void log.push(`${name} -> ${to.name ?? "?"}`),
    disconnect: () => void log.push(`${name} disconnected`),
  });
  const gains: { name: string; gain: { value: number; ramps: [number, number][] } }[] = [];
  const sources: { name: string; buffer: unknown; when?: number; stopped: boolean; onended: (() => void) | null }[] = [];
  const ctx = {
    currentTime: 10,
    destination: { name: "out" },
    createGain() {
      const name = `gain${gains.length}`;
      const g = {
        ...node(name),
        name,
        gain: {
          value: 1,
          ramps: [] as [number, number][],
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime(v: number, t: number) {
            this.ramps.push([v, t]);
          },
        },
      };
      gains.push(g);
      return g;
    },
    createBufferSource() {
      const name = `source${sources.length}`;
      const s = {
        ...node(name),
        name,
        buffer: null as unknown,
        when: undefined as number | undefined,
        stopped: false,
        onended: null as (() => void) | null,
        start(when: number) {
          this.when = when;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as DemoAudioContext, raw: ctx, log, gains, sources };
}
const clip = (duration: number) => ({ duration }) as AudioBuffer;

describe("the demo's sound", () => {
  it("starts both clips at the same moment, each through its own gain, at the mode's gains", () => {
    const f = fakeContext();
    const audio = createDemoAudio(f.ctx, [clip(8), clip(8.02)]);
    expect(audio.length).toBe(8);
    audio.start(false, () => {});
    expect(f.sources.map((s) => s.when)).toEqual([f.sources[0].when, f.sources[0].when]);
    expect(f.sources[0].when).toBeGreaterThan(10);
    expect(f.gains.map((g) => g.gain.value)).toEqual(gainsFor(false));
    expect(f.log).toEqual(expect.arrayContaining(["gain0 -> out", "gain1 -> out", "source0 -> gain0", "source1 -> gain1"]));
  });

  it("ramps both gains together on a switch", () => {
    const f = fakeContext();
    const audio = createDemoAudio(f.ctx, [clip(8), clip(8)]);
    audio.start(false, () => {});
    audio.switchTo(true, AUTO_FADE);
    expect(f.gains.map((g) => g.gain.ramps)).toEqual([[[0, 10 + AUTO_FADE]], [[1, 10 + AUTO_FADE]]]);
  });

  it("counts time from the start on the context's clock, and calls the end once the room's clip ends", () => {
    const f = fakeContext();
    const audio = createDemoAudio(f.ctx, [clip(8), clip(8)]);
    let ended = 0;
    audio.start(false, () => ended++);
    expect(audio.elapsed()).toBe(0);
    f.raw.currentTime = f.sources[0].when! + 3.5;
    expect(audio.elapsed()).toBeCloseTo(3.5);
    f.sources[0].onended?.();
    expect(ended).toBe(1);
  });

  it("stops the old clips quietly and lets go of their nodes when it starts again or stops", () => {
    const f = fakeContext();
    const audio = createDemoAudio(f.ctx, [clip(8), clip(8)]);
    audio.start(true, () => {});
    const first = [...f.sources];
    audio.start(false, () => {});
    expect(first.every((s) => s.stopped && s.onended === null)).toBe(true);
    expect(f.log).toEqual(expect.arrayContaining(["source0 disconnected", "source1 disconnected", "gain0 disconnected", "gain1 disconnected"]));
    expect(f.gains.slice(2).map((g) => g.gain.value)).toEqual(gainsFor(false));
    audio.stop();
    expect(f.sources.slice(2).every((s) => s.stopped)).toBe(true);
    expect(f.log).toEqual(expect.arrayContaining(["gain2 disconnected", "gain3 disconnected"]));
  });
});

describe("the demo page", () => {
  it("renders the stage before anything plays: the room, Tap to listen, Noise on pressed", () => {
    const html = renderToStaticMarkup(createElement(CleanVoiceDemo));
    expect(html).toContain("Studio-clean voice from any recording.");
    expect(html).toContain(`src="${DEMO_MEDIA.room}"`);
    expect(html).toContain(`src="${DEMO_MEDIA.quiet}"`);
    expect(html).toContain("Tap to listen");
    expect(html).toContain("Noisy restaurant");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Noise on</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Noise off</);
    expect(html).toContain(HINTS.ready);
    expect(html).toContain("min-h-11");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).not.toContain("invisible");
  });

  it("keeps its place unseen until the page knows whether to show it", () => {
    const html = renderToStaticMarkup(createElement(CleanVoiceDemo, { ready: false }));
    expect(html).toMatch(/<section[^>]*class="[^"]*\binvisible\b/);
  });

  it("ships its pictures and two 8 s clips of the same length", () => {
    const pub = path.resolve(__dirname, "..", "public");
    for (const f of Object.values(DEMO_MEDIA)) expect(fs.existsSync(path.join(pub, f)), f).toBe(true);
    for (const f of [DEMO_MEDIA.noisy, DEMO_MEDIA.clean]) {
      const file = path.join(pub, f);
      expect(fs.statSync(file).size).toBeLessThan(200_000);
      let probe: string;
      try {
        probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "compact=p=0", file], { encoding: "utf8" });
      } catch {
        continue; // no ffprobe on this machine
      }
      expect(probe).toMatch(/codec_name=aac\|sample_rate=48000\|channels=1/);
      expect(Number(/duration=([\d.]+)/.exec(probe)?.[1])).toBeCloseTo(8, 1);
    }
  });
});
