/**
 * The recorded live edit sessions the LiveDemo players show (Live edit's guest view and the Edit studio's Live pane, the
 * Live edit section and drawn Live card on Home, the Apps card): a room makeover (public/previews/live-edit/room/) and a
 * portrait (public/previews/live-edit/demo.json, which Home's first-screen live tile always plays, src/lib/home-bento.ts).
 * Each page picks one of them at random (pickDemo), so visitors see either. Also
 * the pure parts of its player: how long each step takes, where a paused loop picks up again, which frames are the
 * before and after, which file of a frame a card needs, and where the camera sits when it zooms in on a change. The
 * session is one prompt that keeps growing: each frame shows the picture with all the words so far. The player
 * itself is src/components/live/live-demo.tsx.
 */

export const LIVE_DEMO = "/previews/live-edit/room/demo.json";
/**
 * The file's content version: the first 8 hex digits of the SHA-256 of demo.json (line endings as \n). The player
 * fetches the file with it (?v=), so a new session reaches returning visitors at once; a test keeps it in step.
 */
export const LIVE_DEMO_V = "8444cdca";
/** The portrait session: Home's first-screen tile, and the other session the players may show. Versioned the same way. */
export const PORTRAIT_DEMO = "/previews/live-edit/demo.json";
export const PORTRAIT_DEMO_V = "57bf61aa";
/** The sessions a player may show. */
export const LIVE_DEMOS = [
  { src: LIVE_DEMO, v: LIVE_DEMO_V },
  { src: PORTRAIT_DEMO, v: PORTRAIT_DEMO_V },
] as const;
/** One of them at random (r in [0, 1)): a page picks once, so all its players show the same session. */
export const pickDemo = (r = Math.random()) => LIVE_DEMOS[Math.min(LIVE_DEMOS.length - 1, Math.floor(r * LIVE_DEMOS.length))];

/** A typed character never goes faster than this. */
export const TYPE_MIN_CHAR_MS = 28;
/** A space waits a little longer, the way people type. */
export const TYPE_SPACE_MS = 40;
/**
 * The picture fades in over the last one; the full-quality picture fades in over the live frame before it more slowly,
 * and at the loop's restart it fades back to the original more slowly still.
 */
export const FADE_MS = 140;
export const SETTLE_FADE_MS = 350;
export const REWIND_MS = 320;
/** One full round stays short enough to watch to the end. */
export const LOOP_MAX_MS = 45_000;
/** A live frame is drawn across the picture, left to right, in this long. */
export const SWEEP_MS = 520;
/** The camera glides in on the area a step changes, and back out, in this long. */
export const ZOOM_MS = 700;
/** It never comes closer than this, so a live frame stays crisp enough to read. */
export const ZOOM_MAX = 1.7;
/** Room left around the changed area, as a share of its size on each side. */
export const ZOOM_PAD = 0.12;

/** The width of a frame's `mid` and `small` files. */
export const MID_W = 768;
export const SMALL_W = 512;

/**
 * One picture of the session, in up to three sizes. Every file may end in ?v= and the first 8 hex digits of its
 * SHA-256, so a new file is never served from cache.
 */
export interface DemoFrame {
  /** The sharpest file: `w` px wide (the demo's width when left out). */
  src: string;
  w?: number;
  /** MID_W px wide, for a card that needs no more. */
  mid?: string;
  /** SMALL_W px wide: the small card, and the first picture while its sharp file loads. */
  small?: string;
  /** WebP copies of `small`, `mid` and `src`, for a browser that can't show AVIF. */
  webp?: string;
  webpMid?: string;
  webpSrc?: string;
}

/**
 * How wide a card's files need to be, from its width on the screen in device pixels: the small files, the middle ones
 * or the sharpest (Infinity). 0 until the card is measured.
 */
export const tierFor = (devicePx: number) =>
  !(devicePx > 0) ? 0 : devicePx <= SMALL_W / 0.92 ? SMALL_W : devicePx <= MID_W / 0.92 ? MID_W : Number.POSITIVE_INFINITY;

const isAvif = (src: string) => /\.avif(\?|$)/i.test(src);

/**
 * The file of a frame for a card `need` device pixels wide (its width times the screen's pixel ratio): the smallest
 * that is about as wide, or the largest there is. The WebP copies are only for a browser without AVIF, which gets no
 * AVIF file.
 */
export function frameFile(f: DemoFrame, need: number, demoW: number, avif = true): string {
  const full = f.w ?? demoW;
  const files = [
    { w: SMALL_W, src: f.small },
    { w: MID_W, src: f.mid },
    { w: full, src: f.src },
    ...(avif
      ? []
      : [
          { w: SMALL_W, src: f.webp },
          { w: MID_W, src: f.webpMid },
          { w: full, src: f.webpSrc },
        ]),
  ]
    .filter((x): x is { w: number; src: string } => !!x.src && (avif || !isAvif(x.src)))
    .sort((a, b) => a.w - b.w);
  if (!files.length) return f.src;
  return (files.find((x) => x.w >= need * 0.92) ?? files[files.length - 1]).src;
}

/** An area of the picture, as shares of its width and height: [left, top, right, bottom]. */
export type Box = [number, number, number, number];

export type DemoStep =
  /** live: a live frame (the pill says Live); it is drawn across the picture rather than faded in. */
  | { type: "frame"; frame: string; live?: boolean; ms: number }
  | { type: "type"; text: string; ms: number }
  /** The words so far are one more change (its settled picture is on screen): the count goes up, the words stay. */
  | { type: "change"; ms: number }
  /** from/to: the frames to compare (the script's first and last frames when left out). */
  | { type: "compare"; ms: number; from?: string; to?: string }
  | { type: "pause"; ms: number }
  /**
   * The camera glides in on the area the step changes (box), or back out to the whole picture (null). The glide takes
   * ZOOM_MS whatever `ms` is; `ms` is how long the script waits before its next step (0 lets the next one start at once).
   */
  | { type: "zoom"; box: Box | null; ms: number };

export interface Demo {
  v?: number;
  size: [number, number];
  frames: Record<string, DemoFrame>;
  script: DemoStep[];
}

/** Each character's wait, so a type step takes its `ms` (or longer, when that would mean typing too fast). */
export function typeDelays(text: string, ms: number): number[] {
  const chars = [...text];
  if (!chars.length) return [];
  const spaces = chars.filter((c) => c === " ").length;
  const per = Math.max(TYPE_MIN_CHAR_MS, Math.floor((ms - spaces * TYPE_SPACE_MS) / chars.length));
  return chars.map((c) => per + (c === " " ? TYPE_SPACE_MS : 0));
}

export function stepMs(s: DemoStep): number {
  if (s.type === "type") return typeDelays(s.text, s.ms).reduce((a, b) => a + b, 0);
  return s.ms;
}

/** One round of the loop. */
export const loopMs = (d: Pick<Demo, "script">) => d.script.reduce((a, s) => a + stepMs(s), 0);

/** The original and the final picture: the compare step's, or the script's first and last frames. */
export function demoEnds(d: Demo): { before: string; after: string } {
  const shown = d.script.flatMap((s) => (s.type === "frame" ? [s.frame] : []));
  const keys = Object.keys(d.frames);
  const cmp = d.script.find((s) => s.type === "compare");
  return {
    before: (cmp?.type === "compare" && cmp.from) || shown[0] || keys[0],
    after: (cmp?.type === "compare" && cmp.to) || shown.at(-1) || keys.at(-1) || keys[0],
  };
}

/** The frame ids in the order the script shows them, each once. */
export const frameOrder = (d: Pick<Demo, "script">) => [...new Set(d.script.flatMap((s) => (s.type === "frame" ? [s.frame] : [])))];

export interface DemoView {
  frame: string;
  /** The frame under it, fading out. */
  under: string | null;
  /** How long the frame on top fades in; 0 shows it at once (a loop picking up again). */
  fade: number;
  /** The frame on top is drawn across the picture (a live frame) rather than faded in. */
  sweep: boolean;
  typed: string;
  /** How many changes the words hold so far. */
  changes: number;
  compare: number | null;
  /** The area the camera is on; null is the whole picture. */
  zoom: Box | null;
}

export const startView = (frame: string, under: string | null = null): DemoView => ({
  frame,
  under,
  fade: under ? REWIND_MS : FADE_MS,
  sweep: false,
  typed: "",
  changes: 0,
  compare: null,
  zoom: null,
});

/**
 * The view just before script step `at` runs: where a loop paused off screen picks up again. Its picture is shown at
 * once, with no fade from the dark background behind it.
 */
export function viewBefore(d: Demo, at: number): DemoView {
  const v = { ...startView(demoEnds(d).before), fade: 0 };
  for (const s of d.script.slice(0, at)) {
    if (s.type === "frame") Object.assign(v, { frame: s.frame, sweep: false });
    else if (s.type === "type") v.typed += s.text;
    else if (s.type === "change") v.changes++;
    else if (s.type === "zoom") v.zoom = s.box;
  }
  return v;
}

/**
 * Where the camera sits to show `box` large: a scale and a shift, both as shares of the picture, for
 * `translate(x, y) scale(s)` from the top-left corner. The area is centred where it can be; the picture always fills
 * the frame, and the camera never comes closer than ZOOM_MAX. An area that already fills most of the picture keeps
 * the whole picture.
 */
export function cameraFor(box: Box | null, max = ZOOM_MAX): { s: number; x: number; y: number } {
  if (!box) return { s: 1, x: 0, y: 0 };
  const [l, t, r, b] = box;
  const w = (r - l) * (1 + 2 * ZOOM_PAD);
  const h = (b - t) * (1 + 2 * ZOOM_PAD);
  const fit = Math.min(max, 1 / Math.max(w, 1e-3), 1 / Math.max(h, 1e-3));
  if (fit < 1.15) return { s: 1, x: 0, y: 0 };
  const s = Math.round(fit * 100) / 100;
  const shift = (c: number) => Math.min(0, Math.max(1 - s, 0.5 - s * c));
  return { s, x: shift((l + r) / 2), y: shift((t + b) / 2) };
}

/**
 * Where a live frame's sweep starts and ends, so its soft edge crosses exactly the part of the picture the camera
 * shows. The new frame is masked by a gradient 2.5 picture-widths wide (opaque to 46 %, clear from 54 %, see
 * live-sweep in globals.css); `from`/`to` are its mask-position (%), and `scanFrom`/`scanTo` where the bright line
 * riding the edge goes (% of the picture's width). The edge starts just left of the view and ends just right of it.
 */
export function sweepPath(cam: { s: number; x: number }) {
  const M = 2.5;
  const half = ((0.54 - 0.46) / 2) * M;
  const centre = 0.5 * M;
  const left = -cam.x / cam.s - half;
  const right = (1 - cam.x) / cam.s + half;
  const pos = (c: number) => Math.round(((centre - c) / (M - 1)) * 1000) / 10;
  const pct = (c: number) => Math.round(c * 1000) / 10;
  return { from: pos(left), to: pos(right), scanFrom: pct(left), scanTo: pct(right) };
}

const isBox = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number" && n >= 0 && n <= 1) && b[0] < b[2] && b[1] < b[3];

/** The pill's words: compact cards add the change count once there are two. */
export function pillText(v: Pick<DemoView, "changes">, compact = false) {
  return { main: "Live", count: compact && v.changes > 1 ? String(v.changes) : null };
}

/** Every file of a frame. */
export const frameFiles = (f: DemoFrame) => [f.src, f.mid, f.small, f.webp, f.webpMid, f.webpSrc].filter((x): x is string => !!x);

/** A frame's file, without the ?v= content version. */
export const framePath = (src: string) => src.split("?")[0];

export const changesWord = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/** How many changes a session makes. */
export const countChanges = (d: Pick<Demo, "script">) => d.script.filter((s) => s.type === "change").length;

/** One change of a session, as the chat player lists it. */
export interface DemoChange {
  /** The words this change added to the prompt, without the ", " that joins them on. */
  words: string;
  /** Its settled picture: the last frame shown before the count went up. */
  frame: string;
  /** How long the whole prompt is once this change is in, so the words typed after it can be told apart. */
  end: number;
}

/** Joins a change's words onto the ones before it. */
const trimJoin = (s: string) => s.replace(/^[\s,]+/, "");

/** The session's changes in order: what each one added and the picture it settled on. */
export function changeLog(d: Pick<Demo, "script">): DemoChange[] {
  const out: DemoChange[] = [];
  let typed = "";
  let from = 0;
  let frame = "";
  for (const s of d.script) {
    if (s.type === "type") typed += s.text;
    else if (s.type === "frame") frame = s.frame;
    else if (s.type === "change") {
      out.push({ words: trimJoin(typed.slice(from)), frame, end: typed.length });
      from = typed.length;
    }
  }
  return out;
}

/** A picture of the session, placed at the letter of the prompt it was drawn for. */
export interface SentenceMark {
  /** How long the prompt was when this frame was drawn: the frame is the original with text.slice(0, at). */
  at: number;
  frame: string;
  /** A live frame, drawn while the words were still being typed; otherwise the full-quality picture. */
  live: boolean;
  /** The change it belongs to (0-based); the original is in change 0 at 0. */
  change: number;
}

/**
 * The whole session as one sentence: its text, where each change's own words start and end (without the ", " that
 * joins them on), and every picture at the letter it was drawn for. Only these prefixes were ever drawn, so going back
 * through the sentence can only cut words off the end, the way Undo does.
 */
export function sentence(d: Pick<Demo, "script">): { text: string; clauses: { start: number; end: number }[]; marks: SentenceMark[] } {
  let text = "";
  let from = 0;
  const clauses: { start: number; end: number }[] = [];
  const marks: SentenceMark[] = [];
  for (const s of d.script) {
    if (s.type === "type") text += s.text;
    else if (s.type === "frame") marks.push({ at: text.length, frame: s.frame, live: !!s.live, change: clauses.length });
    else if (s.type === "change") {
      clauses.push({ start: from + (text.slice(from).match(/^[\s,]*/)?.[0].length ?? 0), end: text.length });
      from = text.length;
    }
  }
  return { text, clauses, marks };
}

/** The picture drawn for the first `caret` letters: the last mark at or before it (a settled picture wins a tie). */
export const markAt = (marks: SentenceMark[], caret: number) => marks.reduce<SentenceMark | undefined>((m, k) => (k.at <= caret ? k : m), undefined) ?? marks[0];

/** Where the caret can rest: the letters a picture was drawn for, once each. */
export const stops = (marks: SentenceMark[]) => [...new Set(marks.map((m) => m.at))];

/** How many words the first `at` letters hold. */
export const wordsIn = (text: string, at: number) => text.slice(0, at).split(/[\s,]+/).filter(Boolean).length;

/** The words typed since the last change that settled: what is in the chat player's box right now. */
export const pendingWords = (log: DemoChange[], typed: string, changes: number) => trimJoin(typed.slice(log[Math.min(changes, log.length) - 1]?.end ?? 0));

/** What is wrong with a demo file, in words; empty when it plays. `exists` checks that a frame's file is there. */
export function demoProblems(d: Demo, exists?: (src: string) => boolean): string[] {
  const out: string[] = [];
  if (!Array.isArray(d.size) || d.size.length !== 2 || d.size.some((n) => !(n > 0))) out.push("size must be [width, height]");
  const ids = Object.keys(d.frames ?? {});
  if (!ids.length) out.push("no frames");
  for (const [id, f] of Object.entries(d.frames ?? {})) {
    for (const src of frameFiles(f)) {
      if (!src.startsWith("/previews/")) out.push(`frame ${id}: ${src} is not under /previews/`);
      else if (exists && !exists(framePath(src))) out.push(`frame ${id}: ${src} is missing`);
    }
  }
  if (!d.script?.length) return [...out, "no script"];
  if (d.script[0].type !== "frame") out.push("the script must start with a frame");
  const used = new Set<string>();
  d.script.forEach((s, i) => {
    if (s.type === "zoom") {
      if (!(Number.isFinite(s.ms) && s.ms >= 0)) out.push(`step ${i}: ms must be 0 or more`);
      if (s.box !== null && !isBox(s.box)) out.push(`step ${i}: a zoom box is [left, top, right, bottom], each 0 to 1`);
      return;
    }
    if (!(Number.isFinite(s.ms) && s.ms > 0)) out.push(`step ${i}: ms must be positive`);
    if (s.type === "frame") {
      if (s.live && s.ms < SWEEP_MS) out.push(`step ${i}: a live frame shows for at least ${SWEEP_MS} ms`);
      used.add(s.frame);
      if (!d.frames[s.frame]) out.push(`step ${i}: no frame ${s.frame}`);
    } else if (s.type === "type") {
      if (!s.text) out.push(`step ${i}: nothing to type`);
    } else if (s.type === "compare") {
      for (const f of [s.from, s.to]) if (f && !d.frames[f]) out.push(`step ${i}: no frame ${f}`);
    } else if (s.type !== "pause" && s.type !== "change") out.push(`step ${i}: unknown step`);
  });
  for (const id of ids) if (!used.has(id)) out.push(`frame ${id} is never shown`);
  if (loopMs(d) > LOOP_MAX_MS) out.push(`one round takes ${loopMs(d)} ms, over ${LOOP_MAX_MS}`);
  return out;
}
