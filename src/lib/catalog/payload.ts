import { readTimeline, timelineTracks } from "@/lib/av/timeline";
import { isInstrumental, LYRICS_PARAM, lyricsOf, promptWithLyrics, SONG_ID_PARAM } from "@/lib/lyrics";
import { toH3MaxTrajectory, type CameraKey } from "@/lib/camera-path";
import { upscaleFactorFor } from "@/lib/av/upscale";
import { carriesBoxes, carriesLayout, LAYOUT_PARAM } from "@/lib/layout-prompt";
import { PROMPT_HELPER_PARAM } from "@/lib/comfy";
import { loraFields } from "./loras";
import { OPERATION_OUTPUT, type DurationField, type EnumField, type FieldMap, type GenInput, type MatteOutput, type MediaKind, type Operation, type PixelPoint } from "./types";

function enumValue(field: string | EnumField, value: string): [string, unknown] {
  if (typeof field === "string") return [field, value];
  return [field.key, field.values && value in field.values ? field.values[value] : value];
}

/**
 * A camera path as the route takes it (H3 Max camera-controls): the keyframes within the route's limits, or, for a pure
 * slide, the endpoint's own truck move in place of them (the field the schema says replaces the trajectory).
 */
export function cameraPathFields(f: NonNullable<FieldMap["cameraPath"]>, keys: CameraKey[]): Record<string, unknown> {
  const cam = toH3MaxTrajectory(keys, { min: f.min, max: f.max, elevation: f.elevation, maxTurns: f.maxTurns });
  if ("freeCamera" in cam) {
    if (f.free?.values.includes(cam.freeCamera)) return { [f.free.key]: cam.freeCamera };
    // No fixed moves on this route: the slide is sent as a still trajectory (the camera holds its pose).
    const held = toH3MaxTrajectory(keys.map((k) => ({ ...k, truck: 0 })), { min: f.min, max: f.max, elevation: f.elevation, maxTurns: f.maxTurns });
    return "trajectory" in held ? { [f.key]: held.trajectory } : {};
  }
  return { [f.key]: cam.trajectory };
}

/** "16:9" → 16/9; undefined for "auto" and other names. */
function ratioOf(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v.trim());
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : undefined;
}

/** "720p" → 720, "2k" / "4K" → 2000 / 4000: a size to order resolution tiers by. */
function tierOf(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([pk])$/i.exec(v.trim());
  return m ? Number(m[1]) * (m[2].toLowerCase() === "k" ? 1000 : 1) : undefined;
}

/**
 * The value a route takes for `value` (EnumField.accepts): the value itself (in any case), else the
 * closest one it takes: the nearest shape for an aspect ratio, the largest tier not above it for a
 * resolution (the smallest when all are above). Undefined (leave the field out) for "auto" and other
 * names it doesn't take.
 */
export function fitValue(accepts: readonly string[], value: string, kind: "ratio" | "tier"): string | undefined {
  const same = accepts.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  if (same !== undefined) return same;
  const size = kind === "ratio" ? ratioOf : tierOf;
  const want = size(value);
  if (want === undefined) return undefined;
  const sized = accepts.flatMap((a) => {
    const n = size(a);
    return n === undefined ? [] : [{ a, n }];
  });
  if (!sized.length) return undefined;
  if (kind === "ratio") return sized.reduce((best, c) => (Math.abs(Math.log(c.n / want)) < Math.abs(Math.log(best.n / want)) ? c : best)).a;
  const below = sized.filter((c) => c.n <= want);
  if (below.length) return below.reduce((best, c) => (c.n > best.n ? c : best)).a;
  return sized.reduce((best, c) => (c.n < best.n ? c : best)).a;
}

/** Write an enum setting (aspect ratio, resolution) fitted to what the route takes; nothing when it takes nothing close. */
function putEnum(out: Record<string, unknown>, field: string | EnumField, value: string, kind: "ratio" | "tier") {
  const v = typeof field !== "string" && field.accepts ? fitValue(field.accepts, value, kind) : value;
  if (v === undefined) return;
  const [k, sent] = enumValue(field, v);
  out[k] = sent;
}

type Range = NonNullable<FieldMap["ranges"]>[string];

/** A number inside an API's limits: rounded for whole-number fields, then clamped. */
function inRange(n: number, r: Range): number {
  let v = r.integer ? Math.round(n) : n;
  if (r.min !== undefined) v = Math.max(r.min, v);
  if (r.max !== undefined) v = Math.min(r.max, v);
  return v;
}

/** How many frames a frame-count route renders for the clip (FieldMap.numFrames), or undefined when its length is unknown. */
export function numFramesValue(f: NonNullable<FieldMap["numFrames"]>, input: Pick<GenInput, "sourceDuration" | "duration" | "fps" | "sourceFps">): number | undefined {
  // Extend adds the length picked; other routes render the clip's own length when there is one.
  const seconds = f.fromDuration ? input.duration : (input.sourceDuration ?? input.duration);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const fps = input.fps !== undefined && input.fps > 0 ? input.fps : f.fromDuration && input.sourceFps && input.sourceFps > 0 ? input.sourceFps : f.fps;
  // Wan wants 4n+1 frames and LTX 8n+1: the nearest count of that form that fits.
  if (f.step) {
    const step = f.step;
    const fit = (n: number) => Math.round((n - 1) / step) * step + 1;
    let n = fit(seconds * fps);
    while (f.max !== undefined && n > f.max) n -= step;
    while (f.min !== undefined && n < f.min) n += step;
    return n;
  }
  // A multiple of n (Wan 2.2 S2V's 4n), inside the limits.
  if (f.multiple) {
    const m = f.multiple;
    let n = Math.max(m, Math.round((seconds * fps) / m) * m);
    while (f.max !== undefined && n > f.max) n -= m;
    while (f.min !== undefined && n < f.min) n += m;
    return n;
  }
  return inRange(seconds * fps, { min: f.min, max: f.max, integer: true });
}

/**
 * The clip length (seconds) a frame-count route makes when asked for `seconds`, or undefined when it makes
 * that length (within a quarter second) or isn't a frame-count route. Replicate's Wan 2.2 fast renders 81–121
 * frames, so 3 s comes back as 5 s and 10 s as 7.5 s.
 */
export function framedLength(f: FieldMap["numFrames"] | undefined, seconds: number | undefined, fps?: number): number | undefined {
  if (!f || seconds === undefined || !(seconds > 0)) return undefined;
  const rate = fps !== undefined && fps > 0 ? fps : f.fps;
  const n = numFramesValue(f, { duration: seconds, fps: rate });
  if (n === undefined) return undefined;
  const made = n / rate;
  return Math.abs(made - seconds) > 0.25 ? made : undefined;
}

/**
 * Width and height for an aspect ratio (FieldMap.size): the table's size for the tier and shape when it has one
 * (Fuobe Soul: its first tier when the tier is unknown), else the shape on a `base`×`base` pixel budget (the tier's own square
 * when `bases` names it: fal's FLUX 3 Klein 2K is 2048 × 2048); or the size
 * the request asks for (`asked`: a layout's canvas) on the route's grid. Neither side above `max` (Replicate's Z-Image
 * takes 1440) nor below `min` (fal's MOSS-Image takes 512–2048): the shape is scaled to fit, then a side that still
 * can't keep it is held at the limit.
 */
export function sizeValue(
  f: NonNullable<FieldMap["size"]>,
  aspectRatio: string | undefined,
  resolution?: string,
  asked?: { width: number; height: number },
): { width: number; height: number } {
  const base = (resolution !== undefined ? f.bases?.[resolution] : undefined) ?? f.base ?? 1024;
  const ratio = (aspectRatio && ratioOf(aspectRatio)) || 1;
  const round = (v: number) => Math.max(f.multiple, Math.round(v / f.multiple) * f.multiple);
  const tier = f.table && (f.table[resolution ?? ""] ?? Object.values(f.table)[0]);
  const exact = tier && aspectRatio ? tier[aspectRatio] : undefined;
  let width = asked ? round(asked.width) : exact ? exact[0] : round(base * Math.sqrt(ratio));
  let height = asked ? round(asked.height) : exact ? exact[1] : round(base / Math.sqrt(ratio));
  if (f.max !== undefined && Math.max(width, height) > f.max) {
    const k = f.max / Math.max(width, height);
    width = Math.min(f.max, round(width * k));
    height = Math.min(f.max, round(height * k));
  }
  if (f.min !== undefined && Math.min(width, height) < f.min) {
    // The smallest side the grid allows at or above the minimum (512 on a 16 grid).
    const least = Math.ceil(f.min / f.multiple) * f.multiple;
    const k = least / Math.min(width, height);
    width = Math.max(least, round(width * k));
    height = Math.max(least, round(height * k));
    if (f.max !== undefined) {
      const most = Math.floor(f.max / f.multiple) * f.multiple;
      width = Math.min(most, width);
      height = Math.min(most, height);
    }
  }
  return { width, height };
}

/** A {width, height} the request asks for (params.extra[key]: a layout's canvas), if it gives one. */
export function askedSize(value: unknown): { width: number; height: number } | undefined {
  const v = value as { width?: unknown; height?: unknown } | null | undefined;
  const width = Number(v?.width);
  const height = Number(v?.height);
  return v && typeof v === "object" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

/** Path segments that would reach Object.prototype (or a constructor) instead of the payload. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Write `a.b.c` as nested objects (MiniMax's voice_setting.voice_id etc.). Keys come from users
 * (params.extra), so prototype-reaching segments are dropped and only own plain objects are descended into.
 */
function setPath(out: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".");
  if (parts.some((p) => !p || UNSAFE_KEYS.has(p))) return;
  let o = out;
  for (const k of parts.slice(0, -1)) {
    const next = Object.hasOwn(o, k) ? o[k] : undefined;
    if (next === null || typeof next !== "object" || Array.isArray(next)) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = value;
}

/** A number of seconds in the API's encoding (seconds or ms, number or "5s"). */
function timeValue(d: DurationField, seconds: number): number | string {
  // Milliseconds are whole (Mureka's extend_at).
  const v = (d.multiplier ?? 1) >= 1000 ? Math.round(seconds * d.multiplier!) : seconds * (d.multiplier ?? 1);
  return d.type === "number" ? v : `${v}${d.suffix ?? ""}`;
}

/** "#1a2b3c" / "1A2B3C" → {r, g, b}; null for anything else. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

type PaletteFormat = NonNullable<FieldMap["palette"]>["format"];

function colorValue(format: PaletteFormat, rgb: { r: number; g: number; b: number }, hex: string): unknown {
  if (format === "rgb-object") return rgb;
  if (format === "rgb-array") return { rgb: [rgb.r, rgb.g, rgb.b] };
  if (format === "ideogram") return { rgb };
  return `#${hex.replace(/^#/, "").toUpperCase()}`;
}

/**
 * A hex palette in the API's own shape. Ideogram weighs members: earlier colours (the dominant ones
 * in an extracted palette) count more, from 1 down to 0.3.
 */
export function paletteValue(format: PaletteFormat, palette: string[]): unknown {
  const colors = palette.flatMap((hex) => {
    const rgb = hexToRgb(hex);
    return rgb ? [{ hex, rgb }] : [];
  });
  if (format === "ideogram") {
    const n = colors.length;
    return {
      members: colors.map((c, i) => ({ rgb: c.rgb, color_weight: n > 1 ? Math.round((1 - (0.7 * i) / (n - 1)) * 100) / 100 : 1 })),
    };
  }
  return colors.map((c) => colorValue(format, c.rgb, c.hex));
}

/** The ISO 639 code in "de", "de-DE", "pt_BR" or "German (de)"; undefined for a bare name. */
function languageCode(v: string): string | undefined {
  return (/\(([a-z]{2,3})(?:-[A-Za-z]+)?\)\s*$/i.exec(v)?.[1] ?? /^([a-z]{2,3})(?:[-_][A-Za-z0-9]+)*$/i.exec(v)?.[1])?.toLowerCase();
}

/**
 * The entry of an API's language list that means `lang`: the same value ("es-MX"), else the entry for
 * its ISO code: the bare code (Wizper's "es"), its home locale ("es-ES", "de-DE"), US English, or the
 * first locale listed ("ko-KR"). Undefined when the API doesn't know it, so the field is left out and
 * the API falls back to detecting it.
 */
export function languageValue(values: string[], lang: string): string | undefined {
  const v = lang.trim();
  const exact = values.find((x) => x.toLowerCase() === v.toLowerCase().replace("_", "-"));
  if (exact) return exact;
  const code = languageCode(v);
  if (!code) return undefined;
  const lower = values.map((x) => x.toLowerCase());
  for (const want of [code, `${code}-${code}`, `${code}-us`]) {
    const i = lower.indexOf(want);
    if (i >= 0) return values[i];
  }
  return values.find((x) => x.toLowerCase().startsWith(`${code}-`));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Clicked points in the API's own shape: Bria's eraser takes strings ("{'x':100, 'y':100, 'type':'positive'}"),
 * SAM 3 takes {x, y, label} with 1 = this thing, 0 = not this. Pixels, rounded.
 */
export function pointsValue(format: NonNullable<FieldMap["points"]>["format"], points: PixelPoint[]): unknown[] {
  return points.map((p) => {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const positive = p.label !== "negative";
    if (format === "bria") return `{'x':${x}, 'y':${y}, 'type':'${positive ? "positive" : "negative"}'}`;
    return { x, y, label: positive ? 1 : 0, ...(Number.isInteger(p.frame) && p.frame! > 0 ? { frame_index: p.frame } : {}) };
  });
}

/**
 * Keyframes pinned to frame indexes at the API's frame rate: each image at its time, or spread evenly over
 * the clip when no times are given. Indexes stay inside the clip and strictly increase (APIs want them unique).
 */
export function keyframesValue(k: NonNullable<FieldMap["keyframes"]>, images: string[], times: number[] | undefined, duration: number | undefined) {
  const last = duration !== undefined ? Math.round(duration * k.fps) : undefined;
  const span = last ?? (images.length - 1) * k.fps;
  const frames: number[] = [];
  images.forEach((_, i) => {
    const t = times?.[i];
    let f = t !== undefined && Number.isFinite(t) ? Math.round(t * k.fps) : images.length > 1 ? Math.round((i * span) / (images.length - 1)) : 0;
    f = Math.max(0, last !== undefined ? Math.min(f, last) : f);
    frames.push(i > 0 ? Math.max(f, frames[i - 1] + 1) : f);
  });
  // Keyframes nudged apart at the very end (4.99 s and 5 s in a 5 s clip) step back so the last stays on the
  // clip's final frame: each one frame before the next.
  if (last !== undefined) for (let i = frames.length - 1; i >= 0; i--) frames[i] = Math.max(0, Math.min(frames[i], i === frames.length - 1 ? last : frames[i + 1] - 1));
  return images.map((url, i) => ({ [k.image]: url, [k.frame]: frames[i] }));
}

/**
 * A Ken Burns move as one zoom (fal's zoompan zooms from the whole picture toward a focal point, or back
 * out to it): the factor is the zoomed-in end (the larger of zoomFrom / zoomTo), so that framing is
 * exact and the other end is the whole picture; the focal point is the pan point at the zoomed-in end.
 * Nothing is sent when the request says nothing about the move (the API's defaults apply).
 */
function zoomValue(z: NonNullable<FieldMap["zoom"]>, input: GenInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const said = input.zoomFrom !== undefined || input.zoomTo !== undefined || input.panFrom || input.panTo;
  if (said) {
    const from = input.zoomFrom ?? 1;
    const to = input.zoomTo ?? from;
    const zoomIn = to >= from;
    const factor = Math.max(1, from, to);
    out[z.factor] = round3(z.max ? Math.min(z.max, factor) : factor);
    if (z.direction) out[z.direction.key] = zoomIn ? z.direction.in : z.direction.out;
    const focus = zoomIn ? (input.panTo ?? input.panFrom) : (input.panFrom ?? input.panTo);
    const k = z.percent ? 100 : 1;
    if (focus && z.x) out[z.x] = round3(focus.x * k);
    if (focus && z.y) out[z.y] = round3(focus.y * k);
  }
  if (z.easing && input.easing) {
    const [k, v] = enumValue(z.easing, input.easing);
    out[k] = v;
  }
  return out;
}

/** `text` cut to `max` characters, at a word where one is near the end (a shot's prompt: Kling 4.0 takes 512). */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.8 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "");
}

/**
 * Kling 4.0's elements (@Element1..) from params.elements: each group's images (its first the frontal view, the next
 * ones more angles) or its clip, up to the API's limits (7 elements, 3 angles, 3 clips); the rest are left out. Returns
 * the list and the images and clips it took, which leave the image and clip lists so the rest keep their numbers.
 */
function elementList(e: NonNullable<FieldMap["elements"]>, images: string[], videos: string[], groups: NonNullable<GenInput["elements"]>) {
  const usedImages = new Set<number>();
  const usedVideos = new Set<number>();
  const list: Record<string, unknown>[] = [];
  for (const g of groups) {
    if (list.length >= e.max) break;
    if (g.video !== undefined && e.video && videos[g.video] !== undefined && !usedVideos.has(g.video) && usedVideos.size < (e.maxVideos ?? e.max)) {
      list.push({ [e.video]: videos[g.video] });
      usedVideos.add(g.video);
      continue;
    }
    const own = (g.images ?? []).filter((i) => images[i] !== undefined && !usedImages.has(i));
    if (!own.length) continue;
    const views = own.slice(1, 1 + e.maxViews);
    list.push({ [e.frontal]: images[own[0]], ...(views.length && { [e.views]: views.map((i) => images[i]) }) });
    for (const i of [own[0], ...views]) usedImages.add(i);
  }
  return { list, usedImages, usedVideos };
}

export { SONG_ID_PARAM };

/** Build a provider payload from canonical input using a route's {@link FieldMap}. Pure + unit-tested. */
export function buildPayload(map: FieldMap, input: GenInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Fallbacks first: every canonical field and params.extra below overrides them.
  for (const [k, v] of Object.entries(map.defaults ?? {})) setPath(out, k, v);
  if (map.prompt !== false && input.prompt !== undefined && !(map.omitEmptyPrompt && !input.prompt.trim())) setPath(out, map.prompt ?? "prompt", input.prompt);
  if (map.negativePrompt && input.negativePrompt) out[map.negativePrompt] = input.negativePrompt;

  const images = input.images ?? [];
  if (map.images && images.length) out[map.images] = images;
  if (map.image && images.length) out[map.image] = images[0];
  if (map.image2 && images.length > 1) out[map.image2] = images[1];
  if (map.endImage && input.endImage) out[map.endImage] = input.endImage;
  if (map.mask && input.mask) out[map.mask] = input.mask;
  if (map.video && input.video) out[map.video] = input.video;
  if (map.videoArray && input.video) out[map.videoArray] = [input.video];
  if (map.videos && input.videos?.length) out[map.videos] = input.videos;
  if (map.audio && input.audio) out[map.audio] = input.audio;
  if (map.audios && input.audios?.length) out[map.audios] = input.audios;
  if (map.tracks && input.video) {
    // fal's compose wants every keyframe's start and length in milliseconds.
    const ms = Math.max(1000, Math.round((input.duration ?? 0) * 1000));
    const track = (id: string, type: "video" | "audio", url: string) => ({ id, type, keyframes: [{ url, timestamp: 0, duration: ms }] });
    out[map.tracks] = [track("video", "video", input.video), ...(input.audio ? [track("voice", "audio", input.audio)] : []), ...(input.audio2 ? [track("background", "audio", input.audio2)] : [])];
  }
  // A timeline render (fal compose): a still or the video as the picture, the clips at their start times.
  if (map.timeline) {
    const spec = readTimeline(input.extra?.timeline);
    const visual = input.images?.[0] ? { url: input.images[0], type: "image" as const } : input.video ? { url: input.video, type: "video" as const } : null;
    if (!spec || !visual) throw new Error("A timeline needs the clips' start times and a picture to render over");
    out[map.timeline] = timelineTracks(spec, visual, input.audios ?? []);
  }

  if (map.aspectRatio && input.aspectRatio) putEnum(out, map.aspectRatio, input.aspectRatio, "ratio");
  if (map.resolution && input.resolution) putEnum(out, map.resolution, input.resolution, "tier");
  if (map.duration && input.duration !== undefined) out[map.duration.key] = timeValue(map.duration, input.duration);
  if (map.numOutputs && input.numOutputs !== undefined) out[map.numOutputs] = input.numOutputs;
  if (map.seed && input.seed !== undefined && input.seed >= 0) {
    const r = map.seedRange;
    out[map.seed] = r ? r[0] + (input.seed % (r[1] - r[0] + 1)) : input.seed;
  }
  if (map.generateAudio && input.generateAudio !== undefined) {
    const g = map.generateAudio;
    if (typeof g === "string") out[g] = input.generateAudio;
    else out[g.key] = input.generateAudio ? g.on : g.off;
  }

  // Native multi-shot replaces the single prompt with per-shot prompts.
  if (map.multiShot && (input.shots?.length || input.multiShot === "auto")) {
    const ms = map.multiShot;
    if (input.shots?.length) {
      const shots = input.shots.map((s) => {
        // Whole seconds where the API takes them (Kling 4.0): the take is as long as its shots, so the duration follows.
        const seconds = ms.integer ? Math.max(1, Math.round(s.duration)) : s.duration;
        return { prompt: ms.maxPrompt ? clipWords(s.prompt, ms.maxPrompt) : s.prompt, duration: ms.durationType === "string" ? String(seconds) : seconds };
      });
      out[ms.key] = ms.json ? JSON.stringify(shots) : shots;
      if (ms.integer && map.duration) out[map.duration.key] = timeValue(map.duration, shots.reduce((n, s) => n + Number(s.duration), 0));
      if (map.prompt !== false) delete out[map.prompt ?? "prompt"];
      if (ms.shotType) out[ms.shotType] = "customize";
    } else if (ms.shotType) {
      out[ms.shotType] = "intelligent";
    }
    if (ms.flag) out[ms.flag] = true;
  }
  if (map.draft && input.draft) out[map.draft] = true;
  if (map.elements && input.elements?.length) {
    const { list, usedImages, usedVideos } = elementList(map.elements, images, input.videos ?? [], input.elements);
    if (list.length) {
      out[map.elements.key] = list;
      const rest = (key: string | undefined, all: string[], used: Set<number>) => {
        if (!key || !used.size) return;
        const left = all.filter((_, i) => !used.has(i));
        if (left.length) out[key] = left;
        else delete out[key];
      };
      rest(map.images, images, usedImages);
      rest(map.videos, input.videos ?? [], usedVideos);
    }
  }
  // Voices, dialogue and dubbing.
  if (map.voice && input.voice) setPath(out, map.voice, input.voice);
  if (map.voiceAudio && input.voiceAudio) out[map.voiceAudio] = input.voiceAudio;
  // Voice design and cloning (Qwen3-TTS): the voice in words, what the sample says, a saved voice's embedding.
  if (map.voiceDescription && input.voiceDescription?.trim()) out[map.voiceDescription] = input.voiceDescription.trim();
  if (map.voiceTranscript && input.voiceTranscript?.trim()) out[map.voiceTranscript] = input.voiceTranscript.trim();
  if (map.voiceEmbedding && input.voiceEmbedding) out[map.voiceEmbedding] = input.voiceEmbedding;
  if (map.dialogue && input.dialogue?.length) {
    const d = map.dialogue;
    out[d.key] = input.dialogue.map((l) => ({ [d.text]: l.text, [d.voice]: l.voice ?? input.voice }));
  }
  if (map.targetLanguage && input.targetLanguage) out[map.targetLanguage] = input.targetLanguage;
  if (map.sourceLanguage && input.sourceLanguage?.trim()) {
    const s = map.sourceLanguage;
    // Free-text language fields take ISO codes ("de-DE" and "German (de)" are sent as "de").
    if (typeof s === "string") out[s] = languageCode(input.sourceLanguage.trim()) ?? input.sourceLanguage.trim();
    else {
      const v = languageValue(s.values, input.sourceLanguage);
      if (v !== undefined) out[s.key] = v;
    }
  }
  if (map.draftId && input.draftId) out[map.draftId] = input.draftId;

  // Trims, frame rates, palettes, saved styles and layer counts (research part 3).
  if (map.startTime && input.startTime !== undefined) out[map.startTime.key] = timeValue(map.startTime, input.startTime);
  if (map.endTime && input.endTime !== undefined) out[map.endTime.key] = timeValue(map.endTime, input.endTime);
  if (map.fps && input.fps !== undefined) out[map.fps] = input.fps;
  if (map.styleId && input.styleId) out[map.styleId] = input.styleId;
  if (map.numLayers && input.numLayers !== undefined) out[map.numLayers] = input.numLayers;
  if (map.palette && input.palette?.length) out[map.palette.key] = paletteValue(map.palette.format, input.palette);
  // An object size field the request fills itself (a layout's canvas) is kept on the route's grid and limits.
  const asked = map.size?.key ? askedSize(input.extra?.[map.size.key]) : undefined;
  if (map.size) {
    const { width, height } = sizeValue(map.size, input.aspectRatio, input.resolution, asked);
    if (map.size.key) out[map.size.key] = { width, height };
    if (map.size.width) out[map.size.width] = width;
    if (map.size.height) out[map.size.height] = height;
  }
  // LoRAs (a look, a motion, a trained identity) in the API's shape; the provider calls the route's LoRA endpoint then.
  if (map.loras && input.loras?.length) Object.assign(out, loraFields(map.loras, input.loras));

  // Round 4: clicked points, keyframes, formats, Ken Burns, overlays, retiming, frames and 3D (research part 4).
  if (map.points && input.points?.length) out[map.points.key] = pointsValue(map.points.format, input.points);
  if (map.keyframes && images.length) out[map.keyframes.key] = keyframesValue(map.keyframes, images, input.keyframeTimes, input.duration);
  if (map.format && input.format) {
    const v = map.format.values[input.format];
    if (v !== undefined) out[map.format.key] = v;
  }
  if (map.crossfade && input.crossfade !== undefined) out[map.crossfade] = input.crossfade;
  if (map.zoom) Object.assign(out, zoomValue(map.zoom, input));
  if (map.position && input.position) {
    const k = map.position.percent ? 100 : 1;
    out[map.position.x] = round3(input.position.x * k);
    out[map.position.y] = round3(input.position.y * k);
  }
  if (map.scale && input.scale !== undefined) out[map.scale.key] = round3(input.scale * (map.scale.multiplier ?? 1));
  if (map.targetFps && input.targetFps !== undefined) out[map.targetFps] = input.targetFps;
  if (map.slowdown && input.slowdown !== undefined) out[map.slowdown] = input.slowdown;
  if (map.frameInterval && input.frameInterval !== undefined) out[map.frameInterval] = input.frameInterval;
  if (map.colormap && input.colormap) {
    const [k, v] = enumValue(map.colormap, input.colormap);
    out[k] = v;
  }
  if (map.sideBySide && input.sideBySide !== undefined) out[map.sideBySide] = input.sideBySide;
  if (map.matteOutput && input.matteOutput) {
    const v = map.matteOutput.values[input.matteOutput];
    if (v !== undefined) out[map.matteOutput.key] = v;
  }
  if (map.frames && images.length) out[map.frames.key] = images.map((url) => ({ [map.frames!.url]: url, [map.frames!.frames]: 1 }));
  if (map.loop && input.audio) {
    // A length that is a whole number of plays counts as that many (30.003 / 10.001 is a hair over 3 in floats).
    const want = input.duration && input.sourceDuration ? Math.ceil(input.duration / input.sourceDuration - 1e-6) : map.loop.max;
    out[map.loop.key] = Array.from({ length: Math.max(2, Math.min(map.loop.max, want)) }, () => input.audio);
  }
  if (map.model3d && input.model3d) out[map.model3d] = input.model3d;
  if (map.animation && input.animation !== undefined && input.animation !== "") {
    const n = typeof input.animation === "number" ? input.animation : Number(input.animation);
    const numeric = Number.isFinite(n) && String(input.animation).trim() !== "";
    const r = map.ranges?.[map.animation.key];
    // Meshy's presets are numbered: a name can't be sent.
    if (r?.integer && !numeric) throw new Error(`Pick the animation by its preset number${r.min !== undefined && r.max !== undefined ? ` (${r.min}–${r.max})` : ""}`);
    out[map.animation.key] = numeric ? n : input.animation;
    if (map.animation.flag) out[map.animation.flag] = true;
  }
  if (map.cameraPath && input.cameraPath?.length) Object.assign(out, cameraPathFields(map.cameraPath, input.cameraPath));
  if (map.numFrames) {
    const n = numFramesValue(map.numFrames, input);
    if (n !== undefined) out[map.numFrames.key] = n;
  }
  // Upscalers that take a factor: the tier asked for over the clip's shorter edge (unknown size: the API's default).
  if (map.upscaleFactor && input.resolution) {
    const f = upscaleFactorFor(input.resolution, input.sourceSize, map.upscaleFactor.min, map.upscaleFactor.max);
    if (f !== undefined) out[map.upscaleFactor.key] = f;
  }
  // The API's limits on what Fuobe filled in (params.extra below is sent as given).
  for (const [k, r] of Object.entries(map.ranges ?? {})) if (typeof out[k] === "number") out[k] = inRange(out[k] as number, r);

  // A layout draft rides in params.extra for Reuse and Edit layout; the prompt already carries it, in the model's own form.
  // Options → Prompt helper (params.extra.promptHelper) is Fuobe's own: it goes out as the API's prompt expansion, below.
  // Song lyrics (params.extra.lyrics) go out only where the route says (FieldMap.lyrics), in the models' own form.
  const ignore = new Set([...(map.ignore ?? []), LAYOUT_PARAM, PROMPT_HELPER_PARAM, LYRICS_PARAM, SONG_ID_PARAM, ...(asked ? [map.size!.key!] : [])]);
  for (const [k, v] of Object.entries({ ...map.fixed, ...input.extra })) if (!(map.timeline && k === "timeline") && !ignore.has(k)) setPath(out, k, v);
  // A song tool's song: one of the provider's own by its id (the fal provider sends any other song first, FieldMap.songSource).
  const songId = input.extra?.[SONG_ID_PARAM];
  if (map.songSource && typeof songId === "string" && songId.trim()) out[map.songSource.songId] = songId.trim();
  const lyrics = map.lyrics ? lyricsOf(input.extra) : "";
  if (lyrics && map.lyrics?.instrumental && isInstrumental(lyrics)) {
    // An instrumental, by the API's own switch (MiniMax Music 2.5): no words, and nothing written for it.
    out[map.lyrics.instrumental] = true;
    if (map.lyrics.autoLyrics) out[map.lyrics.autoLyrics] = false;
  } else if (lyrics && map.lyrics?.key) out[map.lyrics.key] = lyrics;
  else if (lyrics && map.lyrics?.inPrompt && map.prompt !== false) {
    const key = map.prompt ?? "prompt";
    setPath(out, key, promptWithLyrics(typeof out[key] === "string" ? (out[key] as string) : (input.prompt ?? ""), lyrics));
  }
  // The API's prompt expansion would rewrite a layout's boxes: off whenever the request carries one (a route that takes the
  // boxes in a field of their own, fal's FLUX 3 Klein, only when the draft places any). Prompt helper "off" turns it off too;
  // "on" leaves the API's default, or turns it on where the route sends it off by default.
  const laidOut = map.boundingBoxes ? carriesBoxes(input.extra) : carriesLayout(input.extra);
  if (map.promptExpansion && (laidOut || input.extra?.[PROMPT_HELPER_PARAM] === "off")) out[map.promptExpansion] = false;
  // "on" for an API whose expansion is off unless asked (fal's Kandinsky 6.0: the route's default sends false).
  else if (map.promptExpansion && input.extra?.[PROMPT_HELPER_PARAM] === "on" && map.defaults?.[map.promptExpansion] === false) out[map.promptExpansion] = true;
  // A background colour given as hex goes out in the palette's shape (Recraft wants {r,g,b}).
  const bg = map.palette?.background;
  if (bg && typeof out[bg] === "string") {
    const rgb = hexToRgb(out[bg] as string);
    if (rgb) out[bg] = colorValue(map.palette!.format === "ideogram" ? "rgb-object" : map.palette!.format, rgb, out[bg] as string);
  }
  return out;
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|gif)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)(\?|$)/i;
const MODEL3D_EXT = /\.(glb|gltf)(\?|$)/i;

export function guessKind(url: string, contentType?: string, hint?: string): MediaKind {
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("model/") || MODEL3D_EXT.test(url)) return "model3d";
  if (hint && /video/i.test(hint)) return "video";
  if (hint && /audio|speech|music|voice/i.test(hint)) return "audio";
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  return "image";
}

/**
 * Keys of a response that are request lifecycle links or ids, never results: Higgsfield's RequestStatus
 * carries status_url and cancel_url next to the media, fal's queue receipts carry response_url.
 */
const LIFECYCLE_KEYS = new Set(["status_url", "cancel_url", "response_url", "logs_url", "webhook_url", "request_id"]);
const SKIP_KEYS = new Set(["seed", "timings", "has_nsfw_concepts", "logs", ...LIFECYCLE_KEYS]);

/**
 * Extract media URLs from an arbitrary provider response. Handles the common shapes:
 * {images:[{url}]}, {image:{url}}, {video:{url}}, {audio:{url}}, {audio_file:{url}},
 * {output: "https://..."} and {output: ["https://..."]} (Replicate).
 */
export function extractMedia(response: unknown): { url: string; kind: MediaKind; contentType?: string }[] {
  const found: { url: string; kind: MediaKind; contentType?: string }[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, keyHint: string) => {
    if (node == null) return;
    if (typeof node === "string") {
      if (/^(https?:\/\/|data:(image|video|audio)\/)/.test(node) && !seen.has(node)) {
        // Skip obvious non-media links (docs, logs).
        if (/^https?:\/\//.test(node) && !/\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|mp3|wav|ogg|flac|m4a|glb|gltf)(\?|$)/i.test(node) && !/(image|video|audio|output|url|file|media)/i.test(keyHint)) return;
        seen.add(node);
        found.push({ url: node, kind: guessKind(node, undefined, keyHint) });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, keyHint));
      return;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj.url === "string" && !seen.has(obj.url)) {
        seen.add(obj.url);
        const ct = typeof obj.content_type === "string" ? obj.content_type : undefined;
        found.push({ url: obj.url, kind: guessKind(obj.url, ct, keyHint), contentType: ct });
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (SKIP_KEYS.has(k)) continue;
        visit(v, k);
      }
    }
  };
  visit(response, "output");
  return found;
}

// ---------------------------------------------------------------------------
// Structured results: layers, text blocks, transcripts, 3D models, stems.

/** One result file plus what the API said about it (OutputFile.text / OutputFile.meta). */
export interface ExtractedOutput {
  url: string;
  kind: MediaKind;
  contentType?: string;
  /** Text results (transcripts): the content; `url` is a data:text/plain URI of the same text. */
  text?: string;
  meta?: Record<string, unknown>;
}

/** A transcript line: seconds from the start. */
export interface Cue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Drop undefined values so stored meta stays small. */
const compact = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** UTF-8 text as a data URI the runner can persist like any other output (works in Node and browsers). */
export function textDataUri(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/plain;base64,${btoa(bin)}`;
}

/** A file object ({url, content_type}) or a bare URL string. */
function fileOf(v: unknown): { url: string; contentType?: string } | undefined {
  if (typeof v === "string" && /^(https?:|data:)/.test(v)) return { url: v };
  if (isObj(v) && typeof v.url === "string") return { url: v.url, contentType: str(v.content_type) };
  return undefined;
}

/** Replicate wraps everything in `output`; an object output is the result itself. */
function body(response: unknown): unknown {
  return isObj(response) && Object.keys(response).length === 1 && "output" in response && isObj(response.output) ? response.output : response;
}

/** [left, top, right, bottom] → [x, y, w, h]. */
function ltrbToXywh(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number")) return undefined;
  const [l, t, r, b] = v as number[];
  return [l, t, r - l, b - t];
}

const layerName = (z: number) => (z === 0 ? "Background" : `Layer ${z}`);

/**
 * Seedream layerize: layers[] = base image (z 0) + up to 16 RGBA layers, each with z_index, name,
 * description and bounding_box {absolute, normalized} as [l, t, r, b]. Qwen layered (fal images[],
 * Replicate output[]): full-canvas RGBA layers in stacking order, no names or boxes.
 */
function layerOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  if (isObj(r) && Array.isArray(r.layers)) {
    return r.layers.flatMap((l: unknown, i): ExtractedOutput[] => {
      if (!isObj(l)) return [];
      const f = fileOf(l.image) ?? fileOf(l);
      if (!f) return [];
      const z = num(l.z_index) ?? i;
      const box = isObj(l.bounding_box) ? l.bounding_box : undefined;
      return [
        {
          url: f.url,
          kind: "image",
          contentType: f.contentType,
          meta: compact({ name: str(l.name) ?? layerName(z), z, bbox: ltrbToXywh(box?.absolute), bboxNormalized: ltrbToXywh(box?.normalized), description: str(l.description) }),
        },
      ];
    });
  }
  return extractMedia(response)
    .filter((o) => o.kind === "image")
    .map((o, z) => ({ ...o, meta: { name: layerName(z), z } }));
}

/** All `text` strings under a node, in order (Ideogram's container → items → spans). */
function collectText(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (!isObj(node)) return [];
  if (typeof node.text === "string") return [node.text];
  return Object.values(node).flatMap(collectText);
}

/**
 * Ideogram layerize-text: image = the background with the text removed, text_containers = the text
 * (container → items → spans with positions and typography), text_html = an overlay that re-renders it,
 * image_layers = extracted picture layers.
 */
function textLayerOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const bg = isObj(r) ? fileOf(r.image) : undefined;
  if (!isObj(r) || !bg) return layerOutputs(response);
  const blocks = (Array.isArray(r.text_containers) ? r.text_containers : []).map((c) => (isObj(c) && typeof c.text !== "string" ? { ...c, text: collectText(c).join(" ").replace(/\s+/g, " ").trim() } : c));
  const out: ExtractedOutput[] = [
    { url: bg.url, kind: "image", contentType: bg.contentType, meta: compact({ name: "Background", z: 0, textBlocks: blocks, textHtml: str(r.text_html) }) },
  ];
  (Array.isArray(r.image_layers) ? r.image_layers : []).forEach((l, i) => {
    const f = fileOf(isObj(l) ? (l.image ?? l) : l);
    if (!f) return;
    const box = isObj(l) && isObj(l.bounding_box) ? l.bounding_box : undefined;
    out.push({
      url: f.url,
      kind: "image",
      contentType: f.contentType,
      meta: compact({ name: (isObj(l) && str(l.name)) || `Image ${i + 1}`, z: i + 1, bbox: ltrbToXywh(box?.absolute) ?? (isObj(l) && Array.isArray(l.bbox) ? l.bbox : undefined) }),
    });
  });
  return out;
}

interface TimedItem {
  text: string;
  start?: number;
  end?: number;
  speaker?: string;
  type?: string;
}

function timed(v: unknown): TimedItem | null {
  if (!isObj(v)) return null;
  const text = str(v.text) ?? str(v.word);
  if (text === undefined) return null;
  const ts = Array.isArray(v.timestamp) ? v.timestamp : undefined;
  return {
    text,
    start: num(v.start) ?? num(ts?.[0]) ?? num(v.start_time),
    end: num(v.end) ?? num(ts?.[1]) ?? num(v.end_time),
    speaker: str(v.speaker_id) ?? str(v.speaker),
    type: str(v.type),
  };
}

const MAX_CUE_CHARS = 64;

/** Word timings → caption-sized cues: break at sentence ends, pauses, speaker changes and ~64 characters. */
export function wordsToCues(words: TimedItem[]): Cue[] {
  const cues: Cue[] = [];
  const push = (c: Cue | null) => {
    if (c && c.text.trim()) cues.push({ ...c, text: c.text.replace(/\s+/g, " ").trim() });
  };
  const join = (text: string, word: string) => `${text}${text && !/\s$/.test(text) && !/^[,.!?;:]/.test(word) ? " " : ""}${word}`;
  let cur: Cue | null = null;
  for (const w of words) {
    if (w.type === "spacing") {
      if (cur) cur.text += w.text || " ";
      continue;
    }
    if (w.start === undefined) {
      if (cur) cur.text = join(cur.text, w.text);
      continue;
    }
    if (cur && (w.speaker !== cur.speaker || w.start - cur.end > 0.8 || cur.text.length + w.text.length > MAX_CUE_CHARS)) {
      push(cur);
      cur = null;
    }
    cur ??= { start: w.start, end: w.end ?? w.start, text: "", ...(w.speaker ? { speaker: w.speaker } : {}) };
    cur.text = join(cur.text, w.text);
    cur.end = w.end ?? cur.end;
    if (/[.!?…]["')\]]?$/.test(w.text.trim())) {
      push(cur);
      cur = null;
    }
  }
  push(cur);
  return cues;
}

/** Segment-level timings (Whisper chunks, WhisperX segments) are cues already; word-level ones are grouped. */
function cuesFrom(r: Obj): Cue[] {
  const words = Array.isArray(r.words) ? r.words.map(timed).filter((w): w is TimedItem => !!w) : [];
  const segs = (["chunks", "segments", "utterances"] as const).flatMap((k) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(timed).filter((w): w is TimedItem => !!w) : []));
  const items = segs.length ? segs : words;
  if (!items.length) return [];
  const wordLevel = !segs.length || items.every((s) => s.text.trim().split(/\s+/).length <= 1);
  if (wordLevel) return wordsToCues(items);
  return items
    .filter((s) => s.start !== undefined && s.text.trim())
    .map((s, i, all) => ({ start: s.start!, end: s.end ?? all[i + 1]?.start ?? s.start!, text: s.text.trim(), ...(s.speaker ? { speaker: s.speaker } : {}) }));
}

/** The plain-text result of an API that answers with text (transcripts, OCR), or undefined. */
function textOf(response: unknown): string | undefined {
  const r = body(response);
  if (typeof r === "string" && !/^https?:\/\//.test(r)) return r;
  if (!isObj(r)) return undefined;
  for (const k of ["text", "transcription", "transcript"]) if (typeof r[k] === "string") return r[k] as string;
  // Replicate models that stream text return it as an array of string pieces.
  if (Array.isArray(r.output) && r.output.length && r.output.every((x) => typeof x === "string" && !/^https?:\/\//.test(x))) return r.output.join("");
  if (typeof r.output === "string" && !/^(https?:|data:)/.test(r.output)) return r.output;
  return undefined;
}

function transcriptOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const o: Obj = isObj(r) ? r : {};
  const cues = cuesFrom(o);
  const text = (textOf(response) ?? cues.map((c) => c.text).join(" ")).trim();
  if (!text && !cues.length) return [];
  const languages = (o.languages ?? o.inferred_languages) as unknown;
  const language = str(o.language_code) ?? str(o.language) ?? (Array.isArray(languages) ? str(languages[0]) : undefined);
  return [{ url: textDataUri(text), kind: "text", contentType: "text/plain", text, meta: compact({ cues: cues.length ? cues : undefined, language }) }];
}

/**
 * Image-to-3D: the GLB (Hunyuan model_glb, model_urls.glb; Tripo model_mesh; Meshy model_glb), with the
 * other formats and the preview render in meta.
 */
function model3dOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  if (isObj(r)) {
    const urls = isObj(r.model_urls) ? r.model_urls : {};
    const glb = fileOf(r.model_glb) ?? fileOf(urls.glb) ?? fileOf(r.model_mesh) ?? fileOf(r.mesh) ?? fileOf(r.model_file);
    if (glb) {
      // SAM 3D Objects also returns the scene as a Gaussian splat.
      const formats = compact({ ...Object.fromEntries(Object.entries(urls).map(([k, v]) => [k, fileOf(v)?.url])), splat: fileOf(r.gaussian_splat)?.url });
      const preview = fileOf(r.thumbnail)?.url ?? fileOf(r.rendered_image)?.url ?? fileOf(r.preview)?.url;
      // A GLB was asked for; generic or missing types are labelled as one so it is stored as .glb.
      const contentType = !glb.contentType || glb.contentType === "application/octet-stream" || MODEL3D_EXT.test(glb.url) ? "model/gltf-binary" : glb.contentType;
      return [{ url: glb.url, kind: "model3d", contentType, meta: compact({ preview, formats: Object.keys(formats).length ? formats : undefined }) }];
    }
  }
  const media = extractMedia(response);
  const mesh = media.find((m) => m.kind === "model3d") ?? media.find((m) => /\.(obj|fbx|ply|usdz)(\?|$)/i.test(m.url)) ?? media[0];
  return mesh ? [{ url: mesh.url, kind: "model3d", contentType: MODEL3D_EXT.test(mesh.url) ? "model/gltf-binary" : mesh.contentType }] : [];
}

/**
 * A 3D scene: the whole-scene mesh when the model builds one, else (Marigold's `image`) the depth map that
 * Cinema Studio turns into a point cloud in the browser, as an image with meta.role "depth".
 */
function sceneOutputs(response: unknown): ExtractedOutput[] {
  const media = extractMedia(response);
  const depth = media.find((m) => m.kind === "image");
  if (!depth || media.some((m) => m.kind === "model3d" || /\.(obj|fbx|ply|usdz)(\?|$)/i.test(m.url))) return model3dOutputs(response);
  return [{ ...depth, meta: { role: "depth" } }];
}

/**
 * Gaussian splats (TripoSplat's and Idol's model_mesh, a .ply unless it says .spz) with meta.format; the cut-out the
 * model actually saw is the preview.
 */
function splatOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const f = isObj(r) ? (fileOf(r.model_mesh) ?? fileOf(r.splat) ?? fileOf(r.gaussian_splat)) : undefined;
  if (!f) return model3dOutputs(response);
  const format = /\.spz(\?|$)/i.test(f.url) || f.contentType?.includes("spz") ? "spz" : "ply";
  const preview = isObj(r) ? fileOf(r.preprocessed_image)?.url : undefined;
  // Idol's point-cloud preview of the splat's centres (model_glb) rides along as a download ("points").
  const glb = isObj(r) ? fileOf(r.model_glb)?.url : undefined;
  return [{ url: f.url, kind: "model3d", contentType: format === "spz" ? "model/x-spz" : "model/ply", meta: compact({ format, preview, formats: glb ? { points: glb } : undefined }) }];
}

/**
 * Rigging (Meshy): the animated GLB when an animation preset was asked for, else the rigged character;
 * the FBX files and the walking / running clips ride along in meta.formats.
 */
function rigOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const animated = isObj(r) ? fileOf(r.animation_glb) : undefined;
  const main = animated ?? (isObj(r) ? fileOf(r.rigged_character_glb) : undefined);
  if (!isObj(r) || !main) return model3dOutputs(response);
  const basic = isObj(r.basic_animations) ? r.basic_animations : {};
  const formats = compact({
    fbx: fileOf(animated ? r.animation_fbx : r.rigged_character_fbx)?.url,
    rigged: animated ? fileOf(r.rigged_character_glb)?.url : undefined,
    walking: fileOf(basic.walking_glb)?.url,
    running: fileOf(basic.running_glb)?.url,
  });
  return [{ url: main.url, kind: "model3d", contentType: "model/gltf-binary", meta: compact({ rigged: true, animated: !!animated || undefined, formats: Object.keys(formats).length ? formats : undefined }) }];
}

/**
 * OCR: Florence-2's results.quad_boxes [{x, y, w, h, label}] (x, y = top left, in the pixels of the image
 * it read) become one text output: the lines joined by newlines, and meta.lines [{text, bbox}] with
 * bbox = [x, y, w, h] as fractions of the image (pixels in bboxPx when the response gives no size).
 * A list that is already normalized ({lines: [{text, bbox}]}) passes through; an image without text
 * gives an empty text with no lines.
 */
function ocrOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const res = isObj(r) && isObj(r.results) ? r.results : r;
  const boxes = isObj(res) && Array.isArray(res.quad_boxes) ? res.quad_boxes : isObj(r) && Array.isArray(r.lines) ? r.lines : undefined;
  if (!isObj(r) || !boxes) return transcriptOutputs(response);
  const img = isObj(r.image) ? r.image : undefined;
  const w = num(img?.width);
  const h = num(img?.height);
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const lines = boxes.flatMap((b) => {
    if (!isObj(b)) return [];
    const text = (str(b.label) ?? str(b.text))?.trim();
    if (!text) return [];
    if (Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every((n) => typeof n === "number")) return [{ text, bbox: b.bbox as number[] }];
    const box = [num(b.x), num(b.y), num(b.w), num(b.h)];
    if (box.some((n) => n === undefined)) return [{ text }];
    const [x, y, bw, bh] = box as number[];
    return [w && h ? { text, bbox: [r4(x / w), r4(y / h), r4(bw / w), r4(bh / h)] } : { text, bboxPx: [x, y, bw, bh] }];
  });
  const text = lines.map((l) => l.text).join("\n");
  return [{ url: textDataUri(text), kind: "text", contentType: "text/plain", text, meta: compact({ lines, size: w && h ? [w, h] : undefined }) }];
}

/** Extracted frames in order, each with meta.index (its place in the sequence: source frame = index × frameInterval). */
function frameOutputs(response: unknown): ExtractedOutput[] {
  return extractMedia(response)
    .filter((o) => o.kind === "image")
    .map((o, index) => ({ ...o, meta: { index } }));
}

/**
 * SDR to HDR: a playable HDR file (Topaz) is the result. LTX-2.3 HDR answers with a ZIP of 16-bit EXR
 * frames and an SDR preview: the preview is the result and the EXR archive rides along as a link
 * (meta.artifacts.exr), as Higgsfield's extra files do.
 */
function hdrOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const exr = isObj(r) ? fileOf(r.exr_frames_url) : undefined;
  if (!isObj(r) || !exr) return extractMedia(response);
  const preview = fileOf(r.preview_video);
  return preview ? [{ url: preview.url, kind: "video", contentType: preview.contentType, meta: { preview: "sdr", artifacts: { exr: exr.url } } }] : [];
}

// Voice first, then DBS's music and effects, then Demucs's instruments and the backgrounds.
const STEM_ORDER = ["vocals", "voice", "speech", "target", "music", "sfx", "effects", "drums", "bass", "guitar", "piano", "other", "residual", "accompaniment", "instrumental"];

/** Demucs: {vocals, drums, bass, other, guitar, piano} files; SAM Audio: {target, residual}. Voice first. */
function stemOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  if (!isObj(r)) return extractMedia(response);
  const stems = Object.entries(r).flatMap(([k, v]) => {
    const f = fileOf(v);
    return f && !LIFECYCLE_KEYS.has(k) ? [{ url: f.url, kind: "audio" as const, contentType: f.contentType, meta: { stem: k } }] : [];
  });
  const rank = (s: string) => (STEM_ORDER.indexOf(s) === -1 ? STEM_ORDER.length : STEM_ORDER.indexOf(s));
  return stems.length ? stems.sort((a, b) => rank(a.meta.stem) - rank(b.meta.stem)) : extractMedia(response);
}

/**
 * Remove background: BiRefNet answers with the cut-out (`video`) and, when asked, its mask (`mask_video`); both are
 * tagged (meta.role "cutout" / "matte") so the job keeps the one asked for ({@link keepMatte}).
 */
function matteOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  const cut = isObj(r) ? fileOf(r.video) : undefined;
  const mask = isObj(r) ? fileOf(r.mask_video) : undefined;
  if (!cut || !mask) return extractMedia(response);
  return [
    { url: cut.url, kind: "video", contentType: cut.contentType, meta: { role: "cutout" } },
    { url: mask.url, kind: "video", contentType: mask.contentType, meta: { role: "matte" } },
  ];
}

/**
 * Pixelate faces on the cloud (fal's SAM 3.1 image): the answer is masks, not the picture. One answer carries every mask
 * (meta.masks, white = a face): the server pixelates the picture SAM looked at under all of them (src/server/generations.ts
 * mosaicOutput). An answer that found no face (an empty masks list) is still an answer, with no masks: the picture stays
 * as it is, as on the GPU. Anything else is no result.
 */
function faceMaskOutputs(response: unknown): ExtractedOutput[] {
  const r = body(response);
  if (!isObj(r)) return [];
  const masks = Array.isArray(r.masks) ? r.masks.map(fileOf).filter((f): f is NonNullable<ReturnType<typeof fileOf>> => !!f) : [];
  // Without a masks list, the mask preview (`image`) is the one mask.
  const all = Array.isArray(r.masks) ? masks : fileOf(r.image) ? [fileOf(r.image)!] : [];
  if (!all.length) return Array.isArray(r.masks) ? [{ url: "", kind: "image", meta: { role: "mask", masks: [] } }] : [];
  return [{ url: all[0].url, kind: "image", contentType: all[0].contentType, meta: { role: "mask", masks: all.map((m) => m.url) } }];
}

/** The results of a Remove background job: only the asked-for file when the answer tagged both (else all of them). */
export function keepMatte<T extends { meta?: Record<string, unknown> }>(outputs: T[], want: MatteOutput | undefined): T[] {
  if (!want) return outputs;
  const kept = outputs.filter((o) => o.meta?.role === want);
  return kept.length ? kept : outputs;
}

/**
 * Every result of a provider response, with structure the operation defines: layers (name, z, bbox),
 * text blocks, transcripts (text + cues), 3D models and audio stems. A text operation's response with
 * no media but text comes back as one text output; for media operations a text-only answer (a refusal)
 * is no result — {@link noOutputsError} turns it into the job's error.
 */
export function extractOutputs(response: unknown, op?: Operation): ExtractedOutput[] {
  let out: ExtractedOutput[];
  switch (op) {
    case "layers":
      out = layerOutputs(response);
      break;
    case "text-layers":
      out = textLayerOutputs(response);
      break;
    case "transcribe":
      out = transcriptOutputs(response);
      break;
    case "image-to-3d":
    case "text-to-3d":
    case "retexture-3d":
      out = model3dOutputs(response);
      break;
    case "scene-3d":
      out = sceneOutputs(response);
      break;
    case "splat":
      out = splatOutputs(response);
      break;
    case "rig-3d":
      out = rigOutputs(response);
      break;
    case "ocr":
      out = ocrOutputs(response);
      break;
    case "extract-frames":
      out = frameOutputs(response);
      break;
    case "sdr-to-hdr":
      out = hdrOutputs(response);
      break;
    case "separate-audio":
      out = stemOutputs(response);
      break;
    case "bg-remove-video":
      out = matteOutputs(response);
      break;
    case "face-mosaic":
      out = faceMaskOutputs(response);
      break;
    default:
      out = extractMedia(response);
  }
  // Captions endpoints also return what they transcribed: keep it with the captioned video.
  if (op === "captions" && out.length) {
    const t = transcriptOutputs(response)[0];
    if (t) out = [{ ...out[0], meta: { ...out[0].meta, transcript: t.text, ...(t.meta?.cues ? { cues: t.meta.cues } : {}) } }, ...out.slice(1)];
  }
  if (!out.length && (op === undefined || OPERATION_OUTPUT[op] === "text") && textOf(response)?.trim()) out = transcriptOutputs(response);
  const r = body(response);
  if (isObj(r)) {
    // Recraft makes a style from reference images on the fly and returns its id: keep it to reuse the style.
    const styleId = str(r.style_id);
    if (styleId) out = out.map((o) => ({ ...o, meta: { ...o.meta, styleId } }));
    // Mureka's songs come back with an id its song tools take (extend, remix): kept on the song (meta.songId).
    const songId = str(r.song_id);
    if (songId) out = out.map((o) => (o.kind === "audio" ? { ...o, meta: { ...o.meta, songId } } : o));
    // Cut-out endpoints (Bria extract-object) return the matte next to the image: it rides along on the
    // cut-out (meta.mask) instead of landing in the feed as a second result.
    const mask = fileOf(r.mask)?.url;
    if (mask && out.some((o) => o.url !== mask)) out = out.filter((o) => o.url !== mask).map((o) => ({ ...o, meta: { ...o.meta, mask } }));
    // The seed fal drew a picture with (text to image, edits: the runs a layout is drawn for) is kept on each one, so
    // Edit layout draws it again with the same seed: a layout run turns the API's prompt expansion off, and FLUX.3 and
    // Ideogram never return actual_prompt, so the seed can't wait for it. fal's MOSS-Image also returns the layout its
    // expansion planned (actual_prompt): kept with the picture's own size, so Edit layout can reopen it as boxes (decodeMoss).
    const seed = num(r.seed);
    const actualPrompt = str(r.actual_prompt)?.trim();
    if (actualPrompt) {
      const sizes = new Map((Array.isArray(r.images) ? r.images : []).filter(isObj).map((im) => [str(im.url), { width: num(im.width), height: num(im.height) }] as const));
      out = out.map((o) => (o.kind === "image" ? { ...o, meta: { ...o.meta, ...compact({ actualPrompt, seed, ...sizes.get(o.url) }) } } : o));
    } else if (seed !== undefined && (op === "t2i" || op === "edit")) out = out.map((o) => (o.kind === "image" ? { ...o, meta: { ...o.meta, seed } } : o));
  }
  return out;
}

/** The job's error when a response held no result: the model's own words when it answered in text. */
export function noOutputsError(response: unknown): string {
  const text = textOf(response)?.trim();
  if (text) return `The model replied: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
  return `No media in response: ${JSON.stringify(response).slice(0, 300)}`;
}
