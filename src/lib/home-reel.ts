/**
 * The video tile's reel on Home's first screen (src/components/home/bento-islands.tsx, BentoReel): its clips play one
 * after another, each once, and each crossfades into the next; after the last, the first again. These are the reel's
 * rules, kept apart from the component so they can be tested (tests/home-reel.test.ts).
 */
import { pickWidth, type Sized } from "@/lib/media-pick";

/**
 * One clip of the reel: its preset (or its name, for a clip made for the tile), where the tile anchors it
 * (object-position; without one, the tile's stylesheet frames it), and its copies in each width.
 * `hold`: how long its last frame stays once it ends, before the next clip fades in over it (ms). Without one, the fade
 * starts a fade's length before its end. `fade`: how long its crossfade into the next clip takes (ms; REEL_FADE_MS
 * unless set).
 */
export interface ReelClip {
  id: string;
  position?: string;
  clips: Sized[];
  hold?: number;
  fade?: number;
}

/** How long the crossfade from one clip into the next takes, in ms, unless the clip sets its own. */
export const REEL_FADE_MS = 500;

/**
 * How long the reel waits for the next clip to start once the clip on screen has ended (and held its last frame), in
 * ms. Past that, the clip on screen plays again from its start while the next one goes on loading: the tile never
 * stops on one frame.
 */
export const REEL_STALL_MS = 1500;

/** How long clip `c` takes to crossfade into the next one, in ms. */
export const fadeOf = (c: Pick<ReelClip, "fade">): number => c.fade ?? REEL_FADE_MS;

/** How long clip `c` holds its last frame once it ends, before the next one fades in, in ms. */
export const holdOf = (c: Pick<ReelClip, "hold">): number => c.hold ?? 0;

/** The clip that plays after clip `i` of `n`: the next one, and after the last the first. */
export const nextInReel = (i: number, n: number): number => (i + 1) % n;

/**
 * Each clip's copy for a box that needs `need` pixels of width: the narrowest at least that wide, or the widest it
 * has (a clip is never offered past its own size).
 */
export const reelSources = (reel: readonly ReelClip[], need: number): string[] => reel.map((c) => pickWidth(c.clips, need).src);

/**
 * Whether the crossfade into the next clip is due while clip `c` plays: at `t` of its `d` seconds, within its fade of
 * its end. A clip that holds its last frame is never due while it plays: its fade starts once it has ended and held.
 */
export const fadeDue = (t: number, d: number, c: Pick<ReelClip, "fade" | "hold"> = {}): boolean => holdOf(c) === 0 && d > 0 && t >= d - fadeOf(c) / 1000;

/** How far through the whole reel it is (0 to 1), playing clip `i` of `n` at `t` of its `d` seconds. */
export const reelProgress = (i: number, n: number, t: number, d: number): number => (i + (d > 0 ? Math.min(1, Math.max(0, t / d)) : 0)) / n;

/**
 * A clip that shows a swap as it happens (the Genjutsu tile, scripts/gen-home-bento.mjs WIPES): a divider sweeps across
 * it, the swapped take left of it and the original right of it. `labels`: the words for either side (the original,
 * then the swap). `line`: where the divider is on each frame, a share of the frame's width (under 0 or over 1 when it
 * is outside the frame). `fadeFrom`: the frame its fade to dark starts on (the words go with the picture).
 */
export interface ReelWipe {
  labels: readonly string[];
  fps: number;
  fadeFrom: number;
  line: readonly number[];
}

/** The frame of wipe `w` on screen at `t` seconds into its clip (its first or its last outside the clip). */
export const wipeFrame = (w: Pick<ReelWipe, "fps" | "line">, t: number): number => Math.min(w.line.length - 1, Math.max(0, Math.floor(t * w.fps + 0.01)));
