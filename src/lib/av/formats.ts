import type { VideoFormat } from "@/lib/catalog/types";

/**
 * How each output format reads in the composer (Higgsfield's SDR to HDR copy for the three it offers),
 * and the file it makes. Pure data, client and server.
 */
export const FORMAT_INFO: Record<VideoFormat, { label: string; short: string; hint: string; ext: string }> = {
  h264: { label: "H.264", short: "H.264", hint: "Plays everywhere. 8-bit, the smallest files.", ext: "mp4" },
  h265_10bit: {
    label: "H.265 10-bit",
    short: "H.265 10-bit",
    hint: "Higher fidelity at a similar size, with less playback support than H.264.",
    ext: "mp4",
  },
  prores_422_hq: { label: "ProRes 422 HQ", short: "ProRes 422 HQ", hint: "Editing-friendly intermediate codec, 10-bit. Much larger files.", ext: "mov" },
  prores_4444: { label: "ProRes 4444", short: "ProRes 4444", hint: "ProRes with full colour detail (4:4:4) for finishing and keying. Larger still.", ext: "mov" },
  ffv1: { label: "FFV1 (lossless)", short: "FFV1", hint: "Lossless archive copy in a .mkv. Very large; few players open it.", ext: "mkv" },
  exr: { label: "EXR frames, 16-bit", short: "EXR 16-bit", hint: "Uncompressed frame sequence for compositing, zipped. Largest files.", ext: "zip" },
  hlg_10bit: { label: "HLG, 10-bit MP4", short: "HLG 10-bit", hint: "BT.2020 HLG: looks right on SDR screens too, and brighter on HDR ones.", ext: "mp4" },
  pq_10bit: { label: "HDR10 (PQ), 10-bit MP4", short: "HDR10 (PQ)", hint: "BT.2020 with the PQ curve of HDR10, in H.264: for HDR displays.", ext: "mp4" },
  webm_alpha: { label: "Transparent WebM", short: "WebM", hint: "Plays in browsers and most editors, with real transparency. Small files.", ext: "webm" },
};

/** The formats offered across `models` (the studio's models on one engine), in their catalog order. */
export function formatsOf(models: { options: { formats?: VideoFormat[] } }[]): VideoFormat[] {
  return [...new Set(models.flatMap((m) => m.options.formats ?? []))];
}

/** "ProRes 422 HQ or H.265 10-bit": a list of formats in words. */
export function formatList(formats: VideoFormat[]): string {
  const names = formats.map((f) => FORMAT_INFO[f]?.short ?? f);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
