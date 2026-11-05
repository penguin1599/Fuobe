/**
 * What you can do with one result, shared by feed tiles, the viewer and the Library, so the same
 * action is in the same place everywhere (U15). Pure: the UI maps ids to icons and handlers.
 *
 * placement: "primary" = the labelled pill (Animate / Extend …), "bar" = icon buttons on tiles
 * (Download, Favorite), "menu" = the ⋯ menu. The viewer shows them all as labelled buttons.
 */
import type { Generation, OutputFile, VideoFormat } from "./catalog/types";
import { cueText, type Cue } from "./cues";
import { downloadHref, downloadName, extensionOf } from "./library";
import { PRESETS as GRADE_PRESETS } from "./grade";
import { storedPath } from "./share";
import { decodeMoss, LAYOUT_PARAM, readLayout, type LayoutDraft } from "./layout-prompt";
import { REMOVE_DIALOGUE_FEATURE } from "./av/remove-dialogue";
import { canEnhance, canRerender, ENHANCE_LABEL, REGEN_OFFERED, regenerateFamily, regenerateHref, rerenderLabel } from "./catalog/regenerate";
import { CLEAN_FEATURE } from "./av/clean-voice";
import { exportsCleanly } from "./av/keying";
import { anyAngleHref } from "./catalog/any-angle";
import { isInstrumental, lyricsOf, songFormat, STEMS_FORMATS } from "./lyrics";
import { CLEAN_DIALOGUE_FEATURE, cleanDialogueHref } from "./av/clean-dialogue";
import { MAX_SIDE as MAX_WATERMARK_SIDE, WATERMARK_APP_ID, WATERMARK_FEATURE } from "./watermark";

export type OutputActionId =
  | "animate"
  | "new-angle"
  | "edit"
  | "live-edit"
  | "relight"
  | "recolor"
  | "upscale"
  | "reference"
  | "grade"
  | "layers"
  | "edit-layout"
  | "save-character"
  | "extend"
  | "reframe"
  | "lipsync"
  | "add-sound"
  | "genjutsu"
  | "voice-change"
  | "loop-audio"
  | "extend-song"
  | "remix-song"
  | "song-stems"
  | "split-soundtrack"
  | "remove-dialogue"
  | "remove-person"
  | "clean-voice"
  | "clean-dialogue"
  | "edit-speech"
  | "remove-watermark"
  | "copy-text"
  | "view-3d"
  | "remix-kinetic"
  | "download"
  | "download-txt"
  | "download-srt"
  | "download-vtt"
  | "download-all"
  | "download-exr"
  | "download-splat"
  | "make-3d"
  | "favorite"
  | "finalize"
  | "regenerate"
  | "rerender-2k"
  | "enhance-h3"
  | "compare"
  | "reuse"
  | "make-skill"
  | "copy-prompt"
  | "share"
  | "pin"
  | "review"
  | "delete"
  | "delete-upload"
  | "delete-own"
  | "restore"
  | "restore-video"
  | "export-pro"
  | "delete-forever";

export interface OutputAction {
  id: OutputActionId;
  label: string;
  placement: "primary" | "bar" | "menu";
  /** A page to hand the output to (open with prefetch off) or a file to download. */
  href?: string;
  /** Set on file links: the browser downloads instead of navigating. */
  download?: string;
  destructive?: boolean;
  /** An item that runs on the visitor's own setup (src/lib/own-setup.ts): its label sits next to the action's. */
  ownSetup?: string;
}

export interface ActionContext {
  /** The view can load the request back into a composer. */
  reuse?: boolean;
  /** The output has a source image to compare with (viewer only). */
  compare?: boolean;
  /** Shown in the viewer: actions that only open the viewer are left out. */
  inViewer?: boolean;
  /**
   * The install's Engine mode: "Paid APIs only" leaves out what only runs on your GPU (Regenerate in 2K). Unknown
   * (a server render, a share page): as "both".
   */
  engineMode?: "both" | "open" | "cloud";
  /** A guest or an account: hand-offs to the tools that run on a self-hosted Fuobe only are left out. */
  visitor?: boolean;
  /** A signed-in account (public sign-up): it has no Trash, so a delete is for good ("Delete for good…", asked first). */
  account?: boolean;
  /** Placeholder results are on (Settings): a new render is a free stand-in, so "paid" is left out. */
  placeholders?: boolean;
}

/** A draft's one-tap 1080p render: a new paid run, said before the tap (left out while placeholders are on). */
export const draftRenderPaid = (placeholders: boolean | undefined): string => (placeholders ? "" : " · paid");

const q = (url: string) => encodeURIComponent(url);

/** Image to 3D → Splat on Idol 3D's Quick look with a picture in the slot (the link Image to 3D reads: readModel3dLink). */
export function make3dHref(url: string, photo = false): string {
  return `/image-to-3d?mode=splat&model=oss-idol&quality=quick&image=${q(url)}${photo ? "&photo=1" : ""}`;
}

/** The model a Kinetic Motion result records (components/motion/save.ts MOTION_MODEL). */
const KINETIC_MODEL = "local-motion";

/** Every action for output `index` of `g`, in display order. */
export function outputActions(g: Generation, index: number, ctx: ActionContext = {}): OutputAction[] {
  const o = g.outputs[index];
  if (!o) return [];
  const name = downloadName(g, o, index);
  const ext = extensionOf(o);
  const file: OutputAction = { id: "download", label: o.kind === "text" ? `Download .${ext}` : "Download", placement: "bar", href: downloadHref(o.url, name), download: name };
  if (g.deletedAt) {
    return [
      { id: "restore", label: "Restore", placement: "primary" },
      file,
      { id: "delete-forever", label: "Delete forever", placement: "menu", destructive: true },
    ];
  }
  const out: OutputAction[] = [];
  const link = (id: OutputActionId, label: string, href: string, placement: OutputAction["placement"] = "menu") => {
    out.push({ id, label, href, placement });
  };
  // A Kinetic Motion result (a clip, a frame, a contact sheet or a version) opens its recipe in the Kinetic editor.
  // A visitor opens only their own (an owner's result shown on a public page would not open for them).
  if (g.modelId === KINETIC_MODEL && g.status === "succeeded" && (!ctx.visitor || !!g.request.account)) link("remix-kinetic", "Remix in Kinetic", `/kinetic?from=${q(g.id)}`, "primary");
  switch (o.kind) {
    case "image":
      if (isVector(g, o)) {
        // The hand-offs all send the picture to models that read pixels, and nothing rasterises an .svg on the way.
        out.push({ ...file, label: "Download .svg" }, { id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
        break;
      }
      link("animate", "Animate", `/video?image=${q(o.url)}`, "primary");
      out.push(file, { id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
      link("edit", "Edit", `/edit?image=${q(o.url)}`);
      link("relight", "Relight", `/apps/app-relight?image=${q(o.url)}&gen=${q(g.id)}`);
      link("live-edit", "Change it as you type", `/live-edit?image=${q(o.url)}&gen=${q(g.id)}&from=library`);
      link("recolor", "Recolor", `/apps/app-tap-to-recolor?image=${q(o.url)}`);
      link("upscale", "Upscale", `/upscale?image=${q(o.url)}`);
      // Any Angle: the same photo from another camera (its 3D view is built once per photo).
      link("new-angle", "New angle", anyAngleHref(o.url));
      // The Watermark Remover's own results go back through its brush instead; a picture known to be past its size limit isn't offered.
      if (g.feature !== WATERMARK_FEATURE && !(Math.max(o.width ?? 0, o.height ?? 0, Number(o.meta?.width) || 0, Number(o.meta?.height) || 0) > MAX_WATERMARK_SIDE)) link("remove-watermark", "Remove watermark", `/apps/${WATERMARK_APP_ID}?image=${q(o.url)}`);
      link("reference", "Use as reference", `/image?ref=${q(o.url)}`);
      link("grade", "Color grade", `/color-grade?image=${q(o.url)}`);
      link("layers", "Open in Layers", layersHref(g, o.url));
      // A picture drawn from a layout (or one fal's MOSS-Image planned itself) reopens as boxes in the Image studio.
      if (editableLayout(g, index)) link("edit-layout", "Edit layout", editLayoutHref(g, index));
      link("genjutsu", "Animate with Genjutsu", `/genjutsu?mode=motion&image=${q(o.url)}`);
      link("make-3d", "Make it 3D", `/apps/app-photo-to-3d?image=${q(o.url)}`);
      out.push({ id: "save-character", label: "Save as character", placement: "menu" });
      break;
    case "video": {
      link("extend", "Extend", `/extend?video=${q(o.url)}`, "primary");
      out.push(file);
      // An HDR or export job's EXR frames ride along on its preview clip (meta.artifacts.exr): a stored zip, or
      // the provider's own link when it couldn't be kept (unreachable when the job finished; it expires).
      const exr = (o.meta?.artifacts as Record<string, unknown> | undefined)?.exr;
      if (typeof exr === "string" && /^(\/api\/files\/|https?:\/\/)/.test(exr)) {
        const zip = name.replace(/\.[^.]+$/, "-exr.zip");
        const stored = exr.startsWith("/api/files/");
        out.push({ id: "download-exr", label: stored ? "Download EXR frames (.zip)" : "Download EXR frames (.zip, provider link)", placement: "bar", href: stored ? downloadHref(exr, zip) : exr, download: zip });
      }
      out.push({ id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
      link("reframe", "Reframe", `/reframe?video=${q(o.url)}`);
      link("lipsync", "Lipsync", `/lipsync?video=${q(o.url)}`);
      link("upscale", "Upscale", `/upscale/video?video=${q(o.url)}`);
      // Old, faded or black-and-white footage (Fuobe Restore): Video tools → Restore & colourise with the clip in. It runs
      // on the viewer's own GPU or fal.ai key (own-setup.ts), and says so.
      out.push({ id: "restore-video", label: "Restore & colourise", href: `/video-tools/restore?video=${q(o.url)}`, placement: "menu", ownSetup: "video-tools:restore" });
      // A mask or clean foreground from Remove background or Green screen: on to ProRes 4444 or EXR for the edit (Export runs on
      // your GPU). A cut-out isn't offered: Export would drop its transparency (src/lib/av/keying.ts).
      if (ctx.engineMode !== "cloud" && exportsCleanly(g.op, g.request?.params)) link("export-pro", "Export as ProRes or EXR", `/upscale/export?video=${q(o.url)}&format=prores_4444`);
      link("add-sound", "Add sound", `/audio/video?video=${q(o.url)}`);
      link("split-soundtrack", "Split soundtrack", `/audio/split?video=${q(o.url)}`);
      link("remove-dialogue", "Remove dialogue", `/video-tools/remove-dialogue?video=${q(o.url)}`);
      // H3 Person Removal: Video tools → Remove a person with the clip in.
      link("remove-person", "Remove a person", `/video-tools/remove-person?video=${q(o.url)}`);
      // Clean up voice on a video's soundtrack: results that carry sound, and uploads (a clip from a phone or a call).
      if (g.feature === "upload" || (g.op && SOUNDED_VIDEO_OPS.has(g.op))) link("clean-voice", "Clean up voice", `/audio/clean?video=${q(o.url)}`);
      // Clean up dialogue (Split soundtrack's preset): the music and effects out from under the speech, or a cloud cleaner.
      if ((g.feature === "upload" || (g.op && SOUNDED_VIDEO_OPS.has(g.op))) && g.feature !== CLEAN_DIALOGUE_FEATURE) link("clean-dialogue", "Clean up dialogue", cleanDialogueHref("video", o.url));
      // Edit speech (AuK, your GPU only): change what someone says in a clip with sound.
      if ((g.feature === "upload" || (g.op && SOUNDED_VIDEO_OPS.has(g.op))) && ctx.engineMode !== "cloud") link("edit-speech", "Edit speech", `/audio/edit-speech?video=${q(o.url)}`);
      // A Fuobe DoP colour-grade effect: the clip opens in Color grading with its grade picked (one click to export).
      const dopGrade = gradeOf(o);
      link("grade", dopGrade ? `Apply the ${dopGrade.name} grade` : "Color grade", `/color-grade?video=${q(o.url)}${dopGrade ? `&preset=${q(dopGrade.id)}` : ""}`);
      link("genjutsu", "Use in Genjutsu", `/genjutsu?video=${q(o.url)}`);
      break;
    }
    case "audio":
      link("lipsync", "Lipsync", `/lipsync?audio=${q(o.url)}`, "primary");
      out.push(file, { id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
      link("voice-change", "Change voice", `/audio/voice-change?audio=${q(o.url)}`);
      link("loop-audio", "Loop / extend", `/audio/loop?audio=${q(o.url)}`);
      // A song's cloud tools (Mureka, Audio → Extend & remix): any song, one of Mureka's own by its id. Not on an install
      // that runs open models only. Remix only where there are vocals to keep (with the song's lyrics, which it needs whole),
      // Stems only on an MP3 or M4A song (what Mureka separates).
      if (g.op && SONG_OPS.has(g.op) && ctx.engineMode !== "open") {
        const song = typeof o.meta?.songId === "string" ? `&song=${q(o.meta.songId)}` : "";
        link("extend-song", "Extend song", `/audio/song?model=mureka-extend&audio=${q(o.url)}${song}`);
        if (!instrumentalSong(g)) {
          // The whole song's words: an extension's run holds only its new part's.
          const words = g.op === "song-extend" ? "" : lyricsOf(g.request?.params?.extra);
          const lyrics = words && q(words).length <= HANDOVER_LYRICS_MAX ? `&lyrics=${q(words)}` : "";
          link("remix-song", "Remix", `/audio/song?model=mureka-remix&audio=${q(o.url)}${song}${lyrics}`);
        }
        const format = songFormat(o.contentType, o.url);
        if (!format || STEMS_FORMATS.includes(format)) link("song-stems", "Stems", `/audio/song?model=mureka-stems&audio=${q(o.url)}`);
      }
      link("split-soundtrack", "Split soundtrack", `/audio/split?audio=${q(o.url)}`);
      // Not on music or sound effects (it keeps only a voice), nor on a voice it already cleaned.
      if (g.op !== "music" && g.op !== "sfx" && g.feature !== CLEAN_FEATURE) link("clean-voice", "Clean up voice", `/audio/clean?audio=${q(o.url)}`);
      if (g.op !== "music" && g.op !== "sfx" && g.feature !== CLEAN_DIALOGUE_FEATURE) link("clean-dialogue", "Clean up dialogue", cleanDialogueHref("audio", o.url));
      // Edit speech (AuK, your GPU only): change a word, the pitch, the pace or the mood of what was said.
      if (g.op !== "music" && g.op !== "sfx" && ctx.engineMode !== "cloud") link("edit-speech", "Edit speech", `/audio/edit-speech?audio=${q(o.url)}`);
      break;
    case "text":
      out.push({ id: "copy-text", label: "Copy", placement: "primary" }, file, { id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
      if (ext !== "txt" && o.text) out.push({ id: "download-txt", label: "Download .txt", placement: "menu" });
      if (cuesOf(o).length) {
        if (ext !== "srt") out.push({ id: "download-srt", label: "Download .srt", placement: "menu" });
        if (ext !== "vtt") out.push({ id: "download-vtt", label: "Download .vtt", placement: "menu" });
      }
      break;
    case "model3d": {
      if (!ctx.inViewer) out.push({ id: "view-3d", label: "View in 3D", placement: "primary" });
      out.push({ ...file, label: `Download .${ext}` }, { id: "favorite", label: g.favorite ? "Unfavorite" : "Favorite", placement: "bar" });
      // A GLB made from a splat (Photo to 3D): the splat too.
      const splat = o.meta?.role ? undefined : g.outputs.findIndex((x) => x !== o && x.kind === "model3d" && x.meta?.role === "splat");
      if (splat !== undefined && splat >= 0) {
        const s = g.outputs[splat];
        const splatName = downloadName(g, s, splat);
        out.push({ id: "download-splat", label: `Download 3D splat (.${extensionOf(s)})`, placement: "menu", href: downloadHref(s.url, splatName), download: splatName });
      }
      break;
    }
  }
  // Uploads (the Library's Uploads tab) are files, not generations: hand-offs, download, and a
  // delete that first checks nothing uses the file.
  if (g.feature === "upload") {
    // An upload's Regenerate (it has no words of its own) sits with its other hand-offs.
    // Open-H3 Regenerate needs a 48 GB card: the item says so (own-setup.ts), and a visitor runs it on its own GPU only.
    if (o.kind === "video" && ctx.engineMode !== "cloud") out.push({ id: "regenerate", label: "Regenerate in 2K", placement: "menu", href: regenerateHref(o.url), ownSetup: "regenerate:upscale" });
    return [...out.filter((a) => a.id !== "favorite"), { id: "delete-upload", label: "Delete for good…", placement: "menu", destructive: true }];
  }
  if (g.outputs.length > 1) out.push({ id: "download-all", label: `Download all ${g.outputs.length} (.zip)`, placement: "menu", href: `/api/generations/zip?ids=${g.id}`, download: "" });
  if (o.draftId) out.push({ id: "finalize", label: `Render this draft in 1080p${ctx.placeholders ? "" : " · a new paid render"}`, placement: "menu" });
  // Finishing in 2K beside it: a fal H3 result renders again at 2K on the same hosted model (a new render, priced); a clip
  // made on your GPU (or uploaded) opens Upscale → Video on Open-H3 Regenerate, which runs on your GPU only. Other cloud
  // results keep their upscalers in Upscale.
  if (o.kind === "video" && g.status === "succeeded") {
    if (canRerender(g, ctx.engineMode)) out.push({ id: "rerender-2k", label: rerenderLabel(g.modelId), placement: "menu" });
    else if ((g.engine === "open" || g.feature === "upload") && ctx.engineMode !== "cloud") out.push({ id: "regenerate", label: "Regenerate in 2K", placement: "menu", href: regenerateHref(o.url, g.feature === "upload" ? null : g.request.prompt), ownSetup: "regenerate:upscale" });
    // An Edit video result (up to 15 s): redrawn at 1080p on your GPU, from the edit's own words (a 48 GB card).
    if (canEnhance(g, o, ctx.engineMode)) out.push({ id: "enhance-h3", label: ENHANCE_LABEL, placement: "menu", ownSetup: "regenerate:enhance" });
  }
  if (ctx.compare) out.push({ id: "compare", label: "Compare with original", placement: "menu" });
  if (ctx.reuse) out.push({ id: "reuse", label: "Reuse settings", placement: "menu" });
  // The steps behind a finished result, as a skill that runs again with new inputs (src/components/skills).
  if (g.status === "succeeded") out.push({ id: "make-skill", label: "Make a skill from this…", placement: "menu" });
  // The Watermark Remover's prompt is its own fixed instruction, not the visitor's words: nothing to copy.
  if (g.prompt && g.feature !== WATERMARK_FEATURE) out.push({ id: "copy-prompt", label: "Copy prompt", placement: "menu" });
  // A read-only link (src/lib/share.ts): finished results whose files Fuobe keeps.
  if (g.status === "succeeded" && g.outputs.some((x) => storedPath(x.url))) out.push({ id: "share", label: "Share link…", placement: "menu" });
  // Library: pinned results stay at the top of their view; the review status is a sub-menu of its own.
  out.push({ id: "pin", label: g.pinnedAt ? "Unpin" : "Pin to top", placement: "menu" }, { id: "review", label: "Review status", placement: "menu" });
  // The owner's goes to the Trash (restorable for 30 days), so it says so; a run still going is canceled first. An
  // account has no Trash: its delete is for good, so it says that and asks first.
  if (ctx.account) out.push({ id: "delete-own", label: "Delete for good…", placement: "menu", destructive: true });
  else out.push({ id: "delete", label: "Move to Trash", placement: "menu", destructive: true });
  return out;
}

/** Results that are songs: made, extended or remixed. */
const SONG_OPS = new Set<Generation["op"]>(["music", "song-extend", "song-remix"]);

/** Music models that make instrumentals only, and those that make one when they're given no words to sing. */
const INSTRUMENTAL_MODELS = new Set(["mureka-9-instrumental", "mureka-9-5-instrumental", "sonilo-music", "stable-audio-3-music", "stable-audio-2-5"]);
const INSTRUMENTAL_WITHOUT_WORDS = new Set(["minimax-music-3", "oss-minimax-music-3", "oss-ace-step"]);

/** A song with no vocals: an instrumental model's, one whose lyrics are only [Instrumental], or a model's own with no words. */
export function instrumentalSong(g: Pick<Generation, "modelId" | "op" | "request">): boolean {
  if (INSTRUMENTAL_MODELS.has(g.modelId)) return true;
  // An extension's lyrics are its new part's only: the song it extends may sing.
  if (g.op === "song-extend") return false;
  const words = lyricsOf(g.request?.params?.extra);
  if (words) return isInstrumental(words);
  return g.op === "music" && INSTRUMENTAL_WITHOUT_WORDS.has(g.modelId);
}

/** The most of a song's lyrics a Remix link carries (encoded): longer ones are written again in the editor. */
const HANDOVER_LYRICS_MAX = 6000;

/** The hand-offs offered as next steps under a fresh result, best first (UX-18). */
const NEXT_STEPS: Partial<Record<OutputFile["kind"], OutputActionId[]>> = {
  image: ["animate", "upscale", "edit"],
  video: ["extend", "upscale", "add-sound"],
  audio: ["lipsync", "voice-change", "split-soundtrack"],
};
/** Clips made with their sound (or keeping the source's): Split soundtrack instead of Add sound. */
const SOUNDED_VIDEO_OPS = new Set<Generation["op"]>(["v2a", "mux", "lipsync", "trim", "captions"]);
/**
 * Sounded clips likely to carry speech also offer Remove dialogue (after Upscale, so it stays): not Sound for video
 * (v2a: generated effects), and not a Remove dialogue result itself.
 */
function likelySpeech(g: Generation): boolean {
  return g.op !== "v2a" && g.feature !== REMOVE_DIALOGUE_FEATURE;
}

/**
 * Up to `max` next steps for output `index` (Animate, Upscale, Edit for a picture), taken from
 * outputActions so they go where the tile's own actions go. Only hand-offs to another studio.
 */
export function nextSteps(g: Generation, index: number, max = 3, ctx: Pick<ActionContext, "engineMode" | "visitor"> = {}): OutputAction[] {
  const o = g.outputs[index];
  if (!o || g.status !== "succeeded") return [];
  const all = outputActions(g, index, ctx);
  // A clip with a grade still to apply (a Fuobe DoP colour-grade effect) offers it first.
  const sounded = o.kind === "video" && !!g.op && SOUNDED_VIDEO_OPS.has(g.op);
  const video: OutputActionId[] | undefined = sounded
    ? ["extend", "upscale", ...(likelySpeech(g) ? (["remove-dialogue"] as const) : []), "split-soundtrack"]
    : NEXT_STEPS.video;
  // H3, LTX, Wan and SANA clips (the drafts Open-H3 Regenerate was shown on) offer Regenerate in 2K right after Upscale.
  const regen = REGEN_OFFERED && o.kind === "video" && regenerateFamily(g.modelId) ? (["regenerate"] as const) : [];
  const withRegen = (ids: OutputActionId[] | undefined) => {
    if (!ids || !regen.length) return ids;
    const at = ids.indexOf("upscale");
    return at < 0 ? [...regen, ...ids] : [...ids.slice(0, at + 1), ...regen, ...ids.slice(at + 1)];
  };
  // A picture made in Edit: Relight in place of Edit (its composer is right there).
  const image: OutputActionId[] | undefined = o.kind === "image" && g.feature === "edit" ? ["animate", "relight", "upscale"] : NEXT_STEPS[o.kind];
  // A song: its song tools first (where they're offered), then Split soundtrack.
  const song: OutputActionId[] = ["extend-song", "remix-song", "song-stems", "split-soundtrack"];
  const order: OutputActionId[] =
    o.kind === "video"
      ? [...(gradeOf(o) ? (["grade"] as const) : []), ...(withRegen(video) ?? [])]
      : o.kind === "audio" && g.op && SONG_OPS.has(g.op) && all.some((a) => a.id === "extend-song")
        ? song
        : (image ?? []);
  return order
    .map((id) => all.find((a) => a.id === id && a.href))
    .filter((a): a is OutputAction => !!a)
    .slice(0, max);
}

/** The grade a clip still asks for (meta.grade: a Fuobe DoP colour-grade effect), as a Color grading preset. */
export function gradeOf(o: Pick<OutputFile, "kind" | "meta">): { id: string; name: string } | undefined {
  const id = o.kind === "video" && typeof o.meta?.grade === "string" ? o.meta.grade : undefined;
  const p = id ? GRADE_PRESETS.find((x) => x.id === id) : undefined;
  return p && { id: p.id, name: p.name };
}

/**
 * A vector result (an SVG: Vectorize, Recraft's vector styles, an uploaded .svg). Demo pictures are
 * SVG placeholders standing in for raster results, so they keep the raster hand-offs (except Vectorize's).
 */
export function isVector(g: Pick<Generation, "provider" | "op">, o: Pick<OutputFile, "url" | "kind" | "contentType">): boolean {
  if (o.kind !== "image") return false;
  const svg = /^image\/svg\+xml\b/i.test(o.contentType ?? "") || o.url.startsWith("data:image/svg+xml") || extensionOf(o) === "svg";
  return svg && (g.provider !== "mock" || g.op === "vectorize");
}

// ---------------------------------------------------------------------------
// Edit layout: a picture's boxes, back in the Image studio's Layout mode

/** The query param that opens the Image studio on a result's layout: `<generation id>` or `<id>.<output index>`. */
export const EDIT_LAYOUT_PARAM = "layout";

export const editLayoutHref = (g: Pick<Generation, "id">, index: number) => `/image?${EDIT_LAYOUT_PARAM}=${q(index ? `${g.id}.${index}` : g.id)}`;

/** `<id>` or `<id>.<index>` → the generation and output it names (null for anything else). */
export function readEditLayoutParam(v: string | null | undefined): { id: string; index: number } | null {
  const m = /^([A-Za-z0-9_-]{4,64})(?:\.(\d{1,2}))?$/.exec(v ?? "");
  return m ? { id: m[1], index: Number(m[2] ?? 0) } : null;
}

export interface EditableLayout {
  draft: LayoutDraft;
  /** The words for the whole picture (the composer's prompt in Layout mode). */
  caption: string;
  /** The seed this picture was drawn with, when it is known: the one its provider reported (meta.seed), else the request's. */
  seed?: number;
  /** Where the boxes came from: the layout the request carried, or the one fal's prompt expansion planned. */
  from: "request" | "expansion";
}

/**
 * The layout a picture can be reopened as (Edit layout): the request's own (params.extra.layout), else, for a picture
 * fal's MOSS-Image planned itself (its actual_prompt), that plan decoded at the picture's own size, so even a plain
 * prompt's render opens as boxes. Null when there is none to open (no layout, or a plan with no boxes).
 */
export function editableLayout(g: Pick<Generation, "status" | "request" | "outputs">, index: number): EditableLayout | null {
  const o = g.outputs[index];
  if (g.status !== "succeeded" || o?.kind !== "image") return null;
  const params = g.request.params ?? {};
  const reported = typeof o.meta?.seed === "number" ? o.meta.seed : undefined;
  const seed = reported ?? (params.seed !== undefined && params.seed >= 0 ? params.seed : undefined);
  const own = readLayout(params.extra?.[LAYOUT_PARAM]);
  if (own?.items.length) return { draft: own, caption: g.request.prompt?.trim() || own.summary.caption, ...(seed !== undefined && { seed }), from: "request" };
  const planned = typeof o.meta?.actualPrompt === "string" ? o.meta.actualPrompt : undefined;
  const width = Number(o.meta?.width ?? o.width);
  const height = Number(o.meta?.height ?? o.height);
  if (!planned || !(width > 0 && height > 0)) return null;
  const draft = decodeMoss(planned, width, height);
  if (!draft?.items.length) return null;
  return { draft, caption: draft.summary.caption.trim() || g.request.prompt?.trim() || "", ...(seed !== undefined && { seed }), from: "expansion" };
}

/**
 * Open an image in the Layers editor (/layers?image=…). A layers result opens with its layers
 * already split, on the picture it was made from.
 */
export function layersHref(g: Pick<Generation, "id" | "op" | "status" | "request">, url: string): string {
  const source = g.request?.inputs?.images?.[0];
  if (g.op === "layers" && g.status === "succeeded" && source?.startsWith("/api/files/")) return `/layers?image=${q(source)}&generation=${g.id}`;
  return `/layers?image=${q(url)}`;
}

// ---------------------------------------------------------------------------
// Text, layers and 3D outputs

/** Timed lines of a transcript (OutputFile.meta.cues, seconds; SRT / VTT writers in src/lib/cues.ts). */
export function cuesOf(o: Pick<OutputFile, "meta">): Cue[] {
  const cues = o.meta?.cues;
  if (!Array.isArray(cues)) return [];
  return cues.filter((c): c is Cue => !!c && typeof c === "object" && typeof c.start === "number" && typeof c.end === "number" && typeof c.text === "string");
}

/** 75.5 → "1:15.5": the viewer's short timing (files use the SRT / VTT stamps). */
export function cueTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const tenths = Math.floor((ms % 1000) / 100);
  return `${h ? `${h}:${p(m)}` : m}:${p(sec)}${tenths ? `.${tenths}` : ""}`;
}

/** The text of a text output: OutputFile.text, else the cues joined. */
export function textOf(o: Pick<OutputFile, "text" | "meta">): string {
  return o.text ?? cueText(cuesOf(o));
}

/**
 * The outputs a result shows as tiles (and the viewer browses): a 3D model's turntable video is
 * its preview, not a result of its own, and so is a splat beside the GLB made from it.
 */
export function shownOutputs(g: Pick<Generation, "kind" | "outputs">): number[] {
  const all = g.outputs.map((_, i) => i);
  if (g.kind !== "model3d") return all;
  // A splat that came beside the GLB made from it (Photo to 3D) is one of the GLB's downloads, not a tile of its own.
  const mesh = g.outputs.some((o) => o.kind === "model3d" && !o.meta?.role);
  const own = all.filter((i) => g.outputs[i].kind === "model3d" && !(mesh && g.outputs[i].meta?.role === "splat"));
  return own.length ? own : all;
}

/** A layer's name and stacking order (meta.name / meta.z, or meta.layer.{name,z}). */
export function layerInfo(o: Pick<OutputFile, "meta">, index: number): { name: string; z: number } {
  const m = (o.meta ?? {}) as Record<string, unknown>;
  const layer = (m.layer && typeof m.layer === "object" ? m.layer : {}) as Record<string, unknown>;
  const name = typeof m.name === "string" ? m.name : typeof layer.name === "string" ? layer.name : index === 0 ? "Background" : `Layer ${index + 1}`;
  const z = typeof m.z === "number" ? m.z : typeof layer.z === "number" ? layer.z : index;
  return { name, z };
}

/** A generation whose outputs are the layers of one picture (Layers, text layers). */
export function isLayered(g: Pick<Generation, "op" | "outputs">): boolean {
  return (g.op === "layers" || g.op === "text-layers" || g.outputs.some((o) => !!(o.meta && ("layer" in o.meta || "z" in o.meta)))) && g.outputs.length > 1;
}

/**
 * A still for a clip's tile, shown before it loads (and where the browser can't decode it): the
 * output's own meta.poster / thumbnail, else, for a clip made from a start frame (image-to-video,
 * start + end frame), that frame. Undefined when there's nothing better than the clip's first frame.
 */
export function videoPoster(g: Partial<Pick<Generation, "op" | "request">> | undefined, o: Pick<OutputFile, "kind" | "meta">): string | undefined {
  if (o.kind !== "video") return undefined;
  const m = (o.meta ?? {}) as Record<string, unknown>;
  const own = ["poster", "thumbnail"].map((k) => m[k]).find((v): v is string => typeof v === "string" && v.length > 0);
  if (own) return own;
  if (g?.op !== "i2v" && g?.op !== "flf2v") return undefined;
  return g.request?.inputs?.images?.[0] || undefined;
}

/**
 * A pro export browsers don't play (ProRes in a .mov, FFV1 in a .mkv): its tile is a file card, not a black
 * player. Judged by the request (an export or HDR job's format) and the file's extension.
 */
export function editOnlyFormat(g: Partial<Pick<Generation, "op" | "request">> | undefined, o: Pick<OutputFile, "url" | "kind">): VideoFormat | undefined {
  if (o.kind !== "video") return undefined;
  const ext = extensionOf(o);
  if (ext === "mkv") return "ffv1";
  const f = g?.request?.params?.format;
  // A demo run's placeholder is a plain .mp4, whatever the format asked for.
  if ((g?.op === "export-video" || g?.op === "sdr-to-hdr") && ext === "mov" && (f === "prores_422_hq" || f === "prores_4444")) return f;
  return undefined;
}

/** A 3D model's still and turntable: meta.poster / meta.preview, meta.video / meta.turntable, or a sibling output. */
export function modelPreview(g: Pick<Generation, "outputs">, o: OutputFile): { poster?: string; video?: string } {
  const m = (o.meta ?? {}) as Record<string, unknown>;
  const str = (...keys: string[]) => keys.map((k) => m[k]).find((v): v is string => typeof v === "string" && v.length > 0);
  return {
    poster: str("poster", "preview", "thumbnail", "image") ?? g.outputs.find((x) => x.kind === "image")?.url,
    video: str("video", "turntable") ?? g.outputs.find((x) => x.kind === "video")?.url,
  };
}
