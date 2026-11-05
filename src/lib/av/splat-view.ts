import type { OutputFile } from "@/lib/catalog/types";
import { isIdol, splatFormatOf } from "./model3d";

/**
 * Looking around a Gaussian splat (idol-4). The page draws .spz / .ply / .ksplat / .splat with Spark (a three.js
 * splat renderer, loaded only when a splat opens: src/components/model3d/splat-engine.ts); a GLB keeps
 * @google/model-viewer. What decides between them, the haze cut-off a result starts with, and when the orbit
 * video stays instead (no WebGL2, reduced motion, a file too big for the device). Pure, so tests can check it.
 */

/** Which viewer draws a 3D output: the splat viewer, @google/model-viewer for a GLB, or none. */
export type Model3dViewer = "splat" | "glb";

export function viewerFor(o: Pick<OutputFile, "url" | "meta" | "kind"> | undefined): Model3dViewer | undefined {
  if (!o || o.kind !== "model3d") return undefined;
  return splatFormatOf(o) ? "splat" : "glb";
}

/**
 * The opacity a result's viewer hides Gaussians under, to start with. Idol 3D emits about half its Gaussians under
 * 0.05 (ComfyUI-Idol's README; docs/research/idol-9.md §2.4), so its results start at 0.05. TripoSplat's haze isn't
 * documented, so it starts at 0 (everything drawn) until the splat A/B (idol-3) says otherwise.
 */
export const IDOL_HAZE_CUTOFF = 0.05;
export function hazeCutoffFor(modelId: string | null | undefined): number {
  return isIdol(modelId) ? IDOL_HAZE_CUTOFF : 0;
}

/** The slider's range: 0 (draw every Gaussian) to 0.3 (only the solid ones), in steps of 0.01. */
export const HAZE_MAX = 0.3;
export const HAZE_STEP = 0.01;

/** The backgrounds behind the splat. */
export type SplatBackground = "light" | "dark" | "grey";
export const SPLAT_BACKGROUNDS: { id: SplatBackground; label: string; color: string }[] = [
  { id: "light", label: "Light", color: "#f4f4f5" },
  { id: "grey", label: "Grey", color: "#808080" },
  { id: "dark", label: "Dark", color: "#111113" },
];
export const backgroundColor = (id: SplatBackground) => SPLAT_BACKGROUNDS.find((b) => b.id === id)!.color;

/**
 * The biggest file the viewer opens: a 1,048,576-Gaussian .ply is about 71 MB (68 bytes each), an .spz about a
 * tenth. A phone (coarse pointer) stops at 48 MB, about a 700,000-Gaussian .ply; a computer at 160 MB.
 */
export const SPLAT_MAX_BYTES = { coarse: 48 * 1024 * 1024, fine: 160 * 1024 * 1024 } as const;
export const splatTooBig = (bytes: number | undefined, coarse: boolean) => bytes !== undefined && bytes > (coarse ? SPLAT_MAX_BYTES.coarse : SPLAT_MAX_BYTES.fine);

/** Why the orbit video (or picture) stays instead of the viewer, or null when the viewer can open. */
export type SplatFallback = "no-webgl2" | "too-big" | "reduced-motion";
export function splatFallback(o: { webgl2: boolean; bytes?: number; coarse: boolean; reducedMotion: boolean; asked?: boolean }): SplatFallback | null {
  if (!o.webgl2) return "no-webgl2";
  if (splatTooBig(o.bytes, o.coarse)) return "too-big";
  // Reduced motion: nothing opens by itself; "Look around" (asked) still opens it.
  if (o.reducedMotion && !o.asked) return "reduced-motion";
  return null;
}

/** What the page says for each fallback. */
export const FALLBACK_TEXT: Record<SplatFallback, string> = {
  "no-webgl2": "This browser can't draw 3D splats. Download the file to look around it in a splat viewer.",
  "too-big": "This splat is too big to open on this device. Download it to look around it in a splat viewer.",
  "reduced-motion": "",
};

/** The file name a still is saved under: the model's name, then "still". */
export const stillFileName = (name: string) => `${name.replace(/[^\w .-]+/g, "").trim() || "splat"} still.png`;
