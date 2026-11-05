import { alignFrames } from "@/lib/catalog/character-swap";

/**
 * MiniMax H3 on your GPU (oss-minimax-h3): the prompt layout the model reads, its canvas and its frame grid. Pure, so the
 * server (src/server/generations.ts wraps the words, src/server/providers/comfyui.ts sizes the graph) and the tests share it.
 */

/** H3 renders at 24 frames a second, always. */
export const H3_FPS = 24;

/** The sound line when the words don't describe one: only what is wanted. */
export const H3_DEFAULT_SOUND = "The natural sound of the scene, following the action.";

/** The operations H3's layout has an alignment line for (text to video has none). */
export type H3Op = "t2v" | "i2v" | "flf2v";

const I2V_ALIGN = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
const flf2vAlign = (seconds: string) =>
  `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${seconds}-second mark of the target video.`;

/** Frames H3 makes for a clip of `seconds`: its 17n + 5 grid at 24 fps (3 s → 73, 5 s → 124, 10 s → 243, 15 s → 362). */
export const h3Frames = (seconds: number): number => alignFrames(Math.round(seconds * H3_FPS));

/** Words already written in H3's layout (a reused run, an LLM's rewrite). */
export const inH3Layout = (text: string): boolean => /\bintegrated_multimodal_description\s*:/.test(text);

/** An alignment paragraph this layout writes (image to video, or start and end frames), at the start of the words. */
const LEADING_ALIGN = /^(?:For the target video, at [\d.]+ seconds into the target video, <Picture \d+>[^\n]*|How the reference pictures align with the target video[^\n]*)\s*/;

/**
 * The person's words in MiniMax H3's layout (its prompting guide): the alignment line for the reference frames (image to
 * video: the start frame at 0.00 s; start and end frames: the end frame at the clip's length, `frames` on H3's grid over
 * 24 fps, 5.17 s for a 5 s clip), then the shot, the soundscape and the music fields. Words already in the layout keep
 * their fields, and get the alignment line of this run (its operation and length) in place of the one they had. A preset's
 * recipe brings its own sound and music lines (`music`); without them the sound is the scene's and there is no music.
 */
export function h3Prompt(words: string, op: H3Op, frames: number, sound?: string, music?: string): string {
  const text = words.trim();
  const align = op === "i2v" ? I2V_ALIGN : op === "flf2v" ? flf2vAlign((alignFrames(frames) / H3_FPS).toFixed(2)) : "";
  if (inH3Layout(text)) {
    const body = text.replace(LEADING_ALIGN, "").trim();
    return align ? `${align}\n\n${body}` : body;
  }
  const body = [
    `integrated_multimodal_description: [Shot 1] ${text}`,
    `overall_soundscape: ${sound?.trim() || H3_DEFAULT_SOUND}`,
    `non_diegetic_music: ${music?.trim() || "N/A"}`,
  ].join("\n\n");
  return align ? `${align}\n\n${body}` : body;
}

const BASE_SHORT_EDGE = 768;
const MAX_PIXELS = 768 * 1344;
const CANVAS_MULTIPLE = 32;

/** Python's round(): halves go to the even neighbour (ComfyUI's adapt_canvas runs in Python). */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** "16:9" or "1280:720" → width ÷ height; anything else (undefined, "auto") → 16:9. */
function ratioOf(shape: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(shape ?? "");
  const r = m ? Number(m[1]) / Number(m[2]) : NaN;
  return Number.isFinite(r) && r > 0 ? r : 16 / 9;
}

/**
 * H3's canvas for a shape (ComfyUI's adapt_canvas): 768 px on the short side, at most 768 × 1344 pixels, each side a multiple
 * of 32. 16:9 → 1344×768, 4:3 → 1024×768, 1:1 → 768×768, 9:16 → 768×1344. `shape` is an aspect ratio or a still's
 * "width:height"; without one the canvas is 16:9.
 */
export function h3Canvas(shape?: string): { width: number; height: number } {
  const ratio = ratioOf(shape);
  let [w, h] = ratio >= 1 ? [BASE_SHORT_EDGE * ratio, BASE_SHORT_EDGE] : [BASE_SHORT_EDGE, BASE_SHORT_EDGE / ratio];
  if (w * h > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (w * h));
    w *= s;
    h *= s;
  }
  return {
    width: Math.max(CANVAS_MULTIPLE, pyRound(w / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
    height: Math.max(CANVAS_MULTIPLE, pyRound(h / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
  };
}

/**
 * A graph from the MiniMax H3 video family (minimax-h3-t2v, -i2v, -flf2v, their -hq graphs and the orbit graph, and the 768p
 * draft that keeps its latent for a 2K finish, video-h3-t2v-2k).
 */
export const isH3Graph = (workflowId: string): boolean => workflowId.startsWith("minimax-h3-") || workflowId === "video-h3-t2v-2k";
