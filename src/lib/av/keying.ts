/**
 * Green screen and fine hair (nm10-keying): what the open green-screen key writes for each format, and which results
 * can be exported again for an edit. Pure (client and server).
 */
import type { GenParams, MatteOutput, VideoFormat } from "@/lib/catalog/types";
import { FORMAT_INFO, formatList } from "./formats";

/** The formats an open matte that takes a format writes its cut-out in (video-key-corridorkey, video-matte-vrmbg3), the default first. */
export const KEY_FORMATS: VideoFormat[] = ["webm_alpha", "prores_4444", "exr"];

/**
 * The cut-out encoder's values for a format: VideoHelperSuite's WebM with alpha (yuva420p), or ProRes 4444, which it writes
 * with alpha (yuva444p10le) for RGBA frames. EXR keeps the WebM as its preview; the frames are their own output. ProRes and
 * EXR carry the cut-out only: the mask and the clean foreground are plain MP4s.
 */
export function keyFormatValues(format: VideoFormat | undefined, output: MatteOutput | undefined): { format: string; profile?: string } {
  const f = format ?? "webm_alpha";
  if (!KEY_FORMATS.includes(f)) throw new Error(`The cut-out comes as ${formatList(KEY_FORMATS)}, not ${FORMAT_INFO[f]?.short ?? f}`);
  if (f !== "webm_alpha" && output && output !== "cutout") throw new Error(`${FORMAT_INFO[f].label} is for the cut-out: pick Cutout video, or WebM for the mask or the clean foreground`);
  return f === "prores_4444" ? { format: "video/ProRes", profile: "4444" } : { format: "video/webm" };
}

/**
 * Whether a Remove background or Green screen result can go to Export (ProRes 4444, EXR) as it is. The export reads a
 * WebM's colour but not its transparency, so only the black-and-white mask and the clean foreground (no alpha) keep
 * everything there; a cut-out keeps its alpha only when the matte writes ProRes 4444 or EXR itself.
 */
export function exportsCleanly(op: string | undefined, params: Pick<GenParams, "matteOutput"> | undefined): boolean {
  return op === "bg-remove-video" && (params?.matteOutput === "matte" || params?.matteOutput === "foreground");
}
