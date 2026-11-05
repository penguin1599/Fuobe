/**
 * The open engine's video finishing tools (Upscale hub: FPS Boost, SDR to HDR, Export, chunked upscaling)
 * as plain data and math, shared by the ComfyUI provider and its tests. See scripts/comfy/library.spec.mjs
 * for the workflows (interpolate-rife-fps, video-export-pro-chunked, video-sdr-to-hdr(-exr),
 * video-export-exr, upscale-video-*-chunked).
 */
import type { Operation, VideoFormat } from "@/lib/catalog/types";
import { FORMAT_INFO, formatList } from "./formats";
import { targetShortEdge } from "./upscale";

/** VideoHelperSuite's format (and ProRes profile) for each export format (video-export-pro(-chunked)). */
export const VHS_FORMAT: Partial<Record<VideoFormat, { format: string; profile?: string }>> = {
  prores_422_hq: { format: "video/ProRes", profile: "hq" },
  prores_4444: { format: "video/ProRes", profile: "4444" },
  h265_10bit: { format: "video/h265-mp4" },
  ffv1: { format: "video/ffv1-mkv" },
  h264: { format: "video/h264-mp4" },
};

/** The formats the export graph writes (EXR has a graph of its own). */
export const OPEN_EXPORT_FORMATS: VideoFormat[] = ["prores_422_hq", "prores_4444", "h265_10bit", "ffv1", "h264", "exr"];
/** The open SDR to HDR: CreateVideo's colour space per format (EXR has a graph of its own). */
export const HDR_COLOR_SPACE: Partial<Record<VideoFormat, string>> = { hlg_10bit: "HDR", pq_10bit: "HDR PQ" };
export const OPEN_HDR_FORMATS: VideoFormat[] = ["hlg_10bit", "pq_10bit", "exr"];

/** The workflow a format runs on, when it isn't the route's own (EXR frames). */
export function exrWorkflow(op: "export-video" | "sdr-to-hdr"): string {
  return op === "export-video" ? "video-export-exr" : "video-sdr-to-hdr-exr";
}

/** VHS values for an export, or the reason it can't be written on the open engine. */
export function exportValues(format: VideoFormat | undefined): { format: string; profile?: string } {
  const v = VHS_FORMAT[format ?? "prores_422_hq"];
  if (!v) throw new Error(`Export on the open engine writes ${formatList(OPEN_EXPORT_FORMATS)}${format ? `, not ${FORMAT_INFO[format]?.short ?? format}` : ""}`);
  return v;
}

/** CreateVideo's colour space for an HDR format, or the reason the open engine can't write it. */
export function hdrColorSpace(format: VideoFormat | undefined): string {
  const v = HDR_COLOR_SPACE[format ?? "hlg_10bit"];
  if (!v) {
    throw new Error(
      `The open engine writes HDR as ${formatList(OPEN_HDR_FORMATS)}${format ? `, not ${FORMAT_INFO[format]?.short ?? format}` : ""} — ` +
        "H.265 and ProRes HDR come from Topaz SDR to HDR on the cloud",
    );
  }
  return v;
}

/** A clip's facts as the provider knows them from its header. */
export interface ClipFacts {
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  duration?: number;
}

const FLOAT_RGB = 12; // bytes per pixel of a ComfyUI IMAGE (float32 RGB)
/** What one meta-batch pass may hold in frames (decoded + worked + written). */
export const PASS_BUDGET = 1.5 * 2 ** 30;

/** The shorter edge a chunked upscale writes: params.resolution ("1080p" = 1080), else the graph's default. */
export function upscaleShortSide(resolution: string | undefined, fallback = 1080): number {
  return targetShortEdge(resolution) ?? fallback;
}

/**
 * Frames per meta-batch pass so one pass holds about PASS_BUDGET of frames: the decoded frame, the model's
 * output (`modelScale` × each side, ESRGAN 4) and the frame scaled to `shortSide`. SeedVR2 restores
 * 4n+1 frames at a time, so its passes are 4n+1 long (`fourNPlusOne`). The graph's default when the size is unknown.
 */
export function framesPerPass(clip: ClipFacts, o: { shortSide?: number; modelScale?: number; fourNPlusOne?: boolean; min?: number; max?: number; fallback: number }): number {
  if (!clip.width || !clip.height) return o.fallback;
  const px = clip.width * clip.height;
  const k = o.shortSide ? o.shortSide / Math.min(clip.width, clip.height) : 1;
  const perFrame = FLOAT_RGB * px * (1 + (o.modelScale ?? 0) ** 2 + k * k);
  let n = Math.floor(PASS_BUDGET / perFrame);
  n = Math.max(o.min ?? 4, Math.min(o.max ?? 64, n));
  if (o.fourNPlusOne) n = Math.max(5, Math.floor((n - 1) / 4) * 4 + 1);
  return n;
}

/** The workflow of RTX Video Super Resolution (Upscale → Video's Quick · RTX). */
export const RTX_UPSCALE_WORKFLOW = "upscale-video-rtx";

/**
 * The factor RTX Video Super Resolution runs at in upscale-video-rtx: the shorter edge asked for ÷ the clip's, within the
 * node's 1-4x (the graph works it out the same way from the decoded size, then scales to exactly `shortSide`). 4 when the
 * size is unknown (the most a pass can hold).
 */
export function rtxScale(clip: ClipFacts, shortSide: number): number {
  const short = clip.width && clip.height ? Math.min(clip.width, clip.height) : 0;
  if (!(short > 0)) return 4;
  return Math.min(4, Math.max(1, shortSide / short));
}

/** The node's output size for a scale: each side × scale, rounded to the nearest multiple of 8 (the pack's rule). */
export function rtxOutputSize(width: number, height: number, scale: number): { width: number; height: number } {
  const to8 = (n: number) => Math.max(8, Math.round((n * scale) / 8) * 8);
  return { width: to8(width), height: to8(height) };
}

/**
 * Frames RTX Video Frame Generation returns for `frames` inputs at multiplier m: (N - 1) × m + 1 (one frame comes back
 * unchanged). fps-rtx-framegen holds the last frame once more first, so a clip's N frames become N × m + 1, as RIFE's do.
 */
export function rtxFrameGenFrames(frames: number, multiplier: number): number {
  if (frames < 2) return Math.max(0, frames);
  return (frames - 1) * multiplier + 1;
}

/**
 * Bytes a whole-clip graph holds (FPS Boost, HDR, EXR export decode the whole clip as float32 frames):
 * `copies` frame-sized copies of every source frame (SDR to HDR and EXR 2, FPS Boost 2 + m). Undefined
 * when the clip's size or length is unknown.
 */
export function wholeClipBytes(clip: ClipFacts, copies: number): number | undefined {
  const frames = clip.frames ?? (clip.duration && clip.fps ? Math.round(clip.duration * clip.fps) : undefined);
  if (!clip.width || !clip.height || !frames) return undefined;
  return clip.width * clip.height * FLOAT_RGB * frames * copies;
}

/**
 * An open tool that decodes the whole clip (FPS Boost, SDR to HDR, EXR export, Fix faces): its name and the frame-sized
 * copies of the clip it holds at its peak (`multiplier` = FPS Boost's m). Null for tools that work in passes.
 */
export function wholeClipTool(op: Operation | undefined, format: VideoFormat | undefined, multiplier = 1): { what: string; copies: number; op: Operation } | null {
  if (op === "interpolate") return { what: "FPS Boost on the open engine", copies: multiplier >= 2 ? 2 + multiplier : 2, op };
  if (op === "sdr-to-hdr") return { what: "SDR to HDR on the open engine", copies: 2, op };
  if (op === "export-video" && format === "exr") return { what: "EXR export on the open engine", copies: 2, op };
  // Fix faces decodes the whole clip and pastes the redrawn faces back at full size.
  if (op === "face-fix-video") return { what: "Fix faces", copies: 2, op };
  return null;
}

const GB = 2 ** 30;

/** What a whole-clip graph may hold: half the ComfyUI server's RAM (a 16 GB server assumed when unknown). */
export const wholeClipBudget = (ramBytes: number | undefined) => (ramBytes && ramBytes > 0 ? ramBytes : 16 * GB) / 2;

/** Why a whole-clip tool can't take this clip on a server with `ramBytes` of RAM; null when it fits or the clip's size is unknown. */
export function wholeClipProblem(tool: NonNullable<ReturnType<typeof wholeClipTool>>, clip: ClipFacts, ramBytes: number | undefined): string | null {
  const need = wholeClipBytes(clip, tool.copies);
  const budget = wholeClipBudget(ramBytes);
  if (!need || need <= budget) return null;
  return (
    `${tool.what} holds the whole clip in memory: this one needs about ${Math.ceil(need / GB)} GB of RAM and this ComfyUI can spare ${Math.floor(budget / GB)} GB. ` +
    "Trim it first (Video tools → Trim)" +
    (tool.op === "interpolate" ? ", or pick a lower frame rate" : "")
  );
}
