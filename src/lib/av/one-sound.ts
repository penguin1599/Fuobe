/**
 * One sound at a time on a page. A sound player (the Clean up voice demo, on its studio page and on Home's Audio tile)
 * claims the page's sound when it starts: every other sound stops (a video or audio element playing with its sound on
 * is paused; another player hears the claim and pauses itself). While it plays it also listens: when an element on the
 * page starts to play with its sound on, or a playing one is unmuted, the player pauses. Muted previews (Home's clips)
 * are never touched and never pause anything.
 *
 * The page's window and document are passed in, so the rules can be checked without a browser (tests/one-sound.test.ts).
 */

/** The event a player sends on the window when it claims the page's sound; `detail` is its own id. */
export const SOUND_EVENT = "fuobe:sound";

/** The parts of a media element the rules use. */
export type MediaLike = Pick<HTMLMediaElement, "paused" | "ended" | "muted" | "volume" | "pause">;

/** The parts of a document the rules use: its media elements, and its events (play and volumechange don't bubble). */
export interface SoundDocument {
  querySelectorAll(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, listener: (e: Event) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (e: Event) => void, capture: boolean): void;
}
export type SoundWindow = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;

const isMedia = (t: unknown): t is MediaLike =>
  !!t && typeof t === "object" && "paused" in t && "muted" in t && "volume" in t && typeof (t as MediaLike).pause === "function";

/** A media element that can be heard now: playing, with its sound on. */
export const audible = (m: unknown): boolean => isMedia(m) && !m.paused && !m.ended && !m.muted && m.volume > 0;

/**
 * Claims the page's sound for player `id`: pauses every media element that can be heard and tells the other players.
 * Returns how many elements it paused.
 */
export function claimSound(id: string, doc: SoundDocument, win: SoundWindow): number {
  let paused = 0;
  for (const m of Array.from(doc.querySelectorAll("audio, video"))) {
    if (!audible(m)) continue;
    (m as MediaLike).pause();
    paused++;
  }
  win.dispatchEvent(new CustomEvent(SOUND_EVENT, { detail: id }));
  return paused;
}

/**
 * Calls `stop` whenever another sound starts on the page: another player's claim, an element starting to play with
 * its sound on, or a playing element being unmuted. Returns the function that stops listening.
 */
export function onOtherSound(id: string, stop: () => void, doc: SoundDocument, win: SoundWindow): () => void {
  const claim = (e: Event) => {
    if ((e as CustomEvent).detail !== id) stop();
  };
  const media = (e: Event) => {
    if (audible(e.target)) stop();
  };
  win.addEventListener(SOUND_EVENT, claim);
  doc.addEventListener("play", media, true);
  doc.addEventListener("volumechange", media, true);
  return () => {
    win.removeEventListener(SOUND_EVENT, claim);
    doc.removeEventListener("play", media, true);
    doc.removeEventListener("volumechange", media, true);
  };
}
