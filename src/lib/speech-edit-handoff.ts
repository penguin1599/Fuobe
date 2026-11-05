import type { Cue } from "./cues";

/**
 * Edit speech's handoff (nm10-speech-edit): another page ("Fix this line" in Captions) opens Audio → Edit speech with a
 * clip, its transcript and the line to fix. The transcript rides in sessionStorage (a long one doesn't fit a URL); the
 * clip's URL is in the link, and the page uses the stored lines only when they belong to that clip.
 */

export const SPEECH_EDIT_HANDOFF = "fuobe:speech-edit";

export interface SpeechEditHandoff {
  media: string;
  kind: "audio" | "video";
  name?: string;
  cues: Cue[];
  line?: number;
}

/** Store the handoff and return the link that reads it. */
export function speechEditLink(h: SpeechEditHandoff): string {
  try {
    sessionStorage.setItem(SPEECH_EDIT_HANDOFF, JSON.stringify(h));
  } catch {}
  return `/audio/edit-speech?${h.kind}=${encodeURIComponent(h.media)}&from=handoff`;
}

/** The handoff for this clip, when the link says there is one and it is this clip's. */
export function readSpeechEditHandoff(media: string, search: URLSearchParams): SpeechEditHandoff | null {
  if (search.get("from") !== "handoff") return null;
  try {
    const h = JSON.parse(sessionStorage.getItem(SPEECH_EDIT_HANDOFF) ?? "null") as SpeechEditHandoff | null;
    return h?.media === media && Array.isArray(h.cues) ? h : null;
  } catch {
    return null;
  }
}
