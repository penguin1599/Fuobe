import { describe, expect, it } from "vitest";
import { audible, claimSound, onOtherSound, SOUND_EVENT, type SoundDocument } from "@/lib/av/one-sound";

/*
 * One sound at a time on a page (src/lib/av/one-sound.ts): a player that starts stops every other sound, and pauses
 * when another starts; muted previews are never touched and never count.
 */

/** A stand-in media element: an event target with the parts the rules read. */
class Media extends EventTarget {
  paused: boolean;
  ended = false;
  muted: boolean;
  volume = 1;
  pauses = 0;
  constructor({ playing = false, muted = false } = {}) {
    super();
    this.paused = !playing;
    this.muted = muted;
  }
  pause() {
    this.paused = true;
    this.pauses++;
  }
  /** Starts playing, firing "play" as a browser does (it doesn't bubble: the page listens in its capture phase). */
  play(doc: FakeDocument) {
    this.paused = false;
    doc.fire("play", this);
  }
}

/** A stand-in document: its media elements, and capture-phase listeners that see each media event. */
class FakeDocument implements SoundDocument {
  media: Media[] = [];
  private listeners = new Map<string, Set<(e: Event) => void>>();
  querySelectorAll() {
    return this.media;
  }
  addEventListener(type: string, listener: (e: Event) => void, capture: boolean) {
    expect(capture).toBe(true);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (e: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, target: Media) {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: target });
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
}

describe("one sound at a time", () => {
  it("counts only what can be heard: playing, sound on", () => {
    expect(audible(new Media({ playing: true }))).toBe(true);
    expect(audible(new Media({ playing: true, muted: true }))).toBe(false);
    expect(audible(new Media())).toBe(false);
    const quiet = new Media({ playing: true });
    quiet.volume = 0;
    expect(audible(quiet)).toBe(false);
    const over = new Media({ playing: true });
    over.ended = true;
    expect(audible(over)).toBe(false);
    expect(audible(null)).toBe(false);
    expect(audible({ paused: false })).toBe(false);
  });

  it("stops every sound on the page when a player starts, and leaves the muted previews playing", () => {
    const doc = new FakeDocument();
    const win = new EventTarget();
    const loud = new Media({ playing: true });
    const preview = new Media({ playing: true, muted: true });
    const still = new Media();
    doc.media = [loud, preview, still];
    const heard: string[] = [];
    win.addEventListener(SOUND_EVENT, (e) => heard.push((e as CustomEvent).detail));
    expect(claimSound("a", doc, win)).toBe(1);
    expect(loud.paused).toBe(true);
    expect([preview.pauses, still.pauses]).toEqual([0, 0]);
    expect(preview.paused).toBe(false);
    expect(heard).toEqual(["a"]);
  });

  it("pauses a player when another claims the sound, but not on its own claim", () => {
    const doc = new FakeDocument();
    const win = new EventTarget();
    let stopsA = 0;
    let stopsB = 0;
    const offA = onOtherSound("a", () => stopsA++, doc, win);
    const offB = onOtherSound("b", () => stopsB++, doc, win);
    claimSound("a", doc, win);
    expect([stopsA, stopsB]).toEqual([0, 1]);
    claimSound("b", doc, win);
    expect([stopsA, stopsB]).toEqual([1, 1]);
    offA();
    offB();
    claimSound("c", doc, win);
    expect([stopsA, stopsB]).toEqual([1, 1]);
  });

  it("pauses a player when a video or a song on the page starts with its sound on, or is unmuted", () => {
    const doc = new FakeDocument();
    const win = new EventTarget();
    let stops = 0;
    const off = onOtherSound("a", () => stops++, doc, win);
    // Home's previews play muted all the time: they never stop the demo.
    const preview = new Media({ muted: true });
    preview.play(doc);
    expect(stops).toBe(0);
    // A clip with its sound on does.
    new Media().play(doc);
    expect(stops).toBe(1);
    // So does a playing preview being unmuted (a volume change on something that can now be heard).
    preview.muted = false;
    doc.fire("volumechange", preview);
    expect(stops).toBe(2);
    // Muting it again is no reason to stop.
    preview.muted = true;
    doc.fire("volumechange", preview);
    expect(stops).toBe(2);
    off();
    new Media().play(doc);
    expect(stops).toBe(2);
  });
});
