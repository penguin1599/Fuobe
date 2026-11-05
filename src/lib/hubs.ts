/**
 * Studio hubs: Audio, Video tools and Upscale group several studios, one path per mode
 * (/audio/music, /video-tools/join, /upscale/video, /upscale/fps). The hub's own path is its first mode.
 * Pure data (client and server). Old `/audio?mode=music` links redirect in src/proxy.ts (hubModeLink).
 */
export type HubKind = "audio" | "video-tools" | "upscale";

export interface HubMode {
  id: string;
  label: string;
  /**
   * A mode a guest or an account doesn't see at all (its tab is left out for them). A tool that runs on a self-hosted
   * Fuobe only keeps its tab, and its page says up front that it isn't available here.
   */
  ownerOnly?: true;
  /** The mode's tool runs on a self-hosted Fuobe only: the hub's engine badge says so to anyone but the owner (EngineSwitch). */
  selfHostedOnly?: true;
  /** The mode runs with the visitor's own setup (an own-setup.ts id): its tab carries the label's icon. */
  ownSetup?: string;
}

export const HUB_TITLE: Record<HubKind, string> = { upscale: "Upscale", audio: "Audio", "video-tools": "Video tools" };

export const HUB_MODES: Record<HubKind, HubMode[]> = {
  upscale: [
    { id: "image", label: "Image" },
    { id: "video", label: "Video" },
    { id: "fps", label: "FPS Boost" },
    { id: "hdr", label: "SDR to HDR" },
    { id: "export", label: "Export" },
  ],
  // Clean up voice leads: /audio opens on it, and every list of Audio's modes starts with it.
  audio: [
    { id: "clean", label: "Clean up voice" },
    { id: "speech", label: "Speech" },
    { id: "dialogue", label: "Dialogue" },
    { id: "voice-change", label: "Voice change" },
    { id: "design", label: "Design a voice" },
    { id: "edit-speech", label: "Edit speech", ownSetup: "audio:edit-speech" },
    { id: "translate", label: "Translate" },
    { id: "transcribe", label: "Transcribe" },
    { id: "split", label: "Split soundtrack" },
    { id: "sfx", label: "Sound effects" },
    { id: "music", label: "Music" },
    { id: "song", label: "Extend & remix", ownSetup: "mureka-extend" },
    { id: "loop", label: "Loop / extend" },
    { id: "join", label: "Join" },
    { id: "video", label: "Sound for video" },
  ],
  "video-tools": [
    { id: "matte", label: "Remove background" },
    { id: "green-screen", label: "Green screen" },
    { id: "remove-object", label: "Remove object" },
    { id: "remove-dialogue", label: "Remove dialogue" },
    { id: "remove-person", label: "Remove a person" },
    { id: "evolution", label: "Evolution" },
    { id: "restore", label: "Restore & colourise", ownSetup: "video-tools:restore" },
    { id: "relight", label: "Relight" },
    { id: "depth", label: "Depth map" },
    { id: "captions", label: "Captions" },
    { id: "trim", label: "Trim" },
    { id: "join", label: "Join clips" },
    { id: "colors", label: "Match colors" },
  ],
};

/**
 * A hub whose own URL opened another mode before, and the link params only that mode reads: /audio opened on Speech
 * until Clean up voice came first, so an old `/audio?voice=…`, `?prompt=…` or `?model=…` link opens Speech (src/proxy.ts).
 */
export const FORMER_HOME: Partial<Record<HubKind, { mode: string; params: readonly string[] }>> = {
  audio: { mode: "speech", params: ["voice", "prompt", "model", "preset", "example", "lyrics"] },
};

/** The URL of one mode: the hub itself for the first one, else /<hub>/<mode>. */
export function modeHref(kind: HubKind, mode: string, query?: Record<string, string>): string {
  const path = HUB_MODES[kind][0].id === mode ? `/${kind}` : `/${kind}/${mode}`;
  const q = query ? new URLSearchParams(query).toString() : "";
  return q ? `${path}?${q}` : path;
}

/** The hub a path belongs to (/audio, /audio/music…), if any. */
export function hubOfPath(pathname: string): HubKind | undefined {
  const first = pathname.split(/[?#]/)[0].split("/")[1];
  return (Object.keys(HUB_MODES) as HubKind[]).find((k) => k === first);
}

/** The mode a hub path shows: /audio is the first mode, /audio/music is Music. Undefined outside the hub or for an unknown mode. */
export function modeOfPath(kind: HubKind, pathname: string): string | undefined {
  const parts = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  if (parts[0] !== kind || parts.length > 2) return undefined;
  const id = parts[1] ?? HUB_MODES[kind][0].id;
  return HUB_MODES[kind].some((m) => m.id === id) ? id : undefined;
}
