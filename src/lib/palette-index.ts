/**
 * The slim catalog behind the ⌘K palette (GET /api/search-index): names, categories and where each item
 * opens. Built on the server from the catalog, so the palette never ships prompt templates or routes.
 */
import { ALL_MODELS_3D, RETEXTURE_MODELS, RIG_MODEL } from "@/lib/av/model3d";
import { APPS, EFFECTS, MODELS, MOTIONS } from "@/lib/catalog";
import { enginesOf } from "@/lib/catalog/engines";
import { OPERATION_LABELS, type ModelDef, type Operation, type Preset } from "@/lib/catalog/types";
import type { PaletteIndex, PaletteModel, PalettePreset } from "@/lib/command-search";
import { TOOL_MODELS } from "@/lib/layers";
import { presetCover } from "@/lib/preset-covers";
import type { StudioConfig } from "@/components/studio/studio-context";
import {
  AUDIO_STUDIO,
  DIALOGUE_STUDIO,
  EDIT_STUDIO,
  EXTEND_STUDIO,
  FOLEY_STUDIO,
  FPS_BOOST_STUDIO,
  IMAGE_STUDIO,
  INPAINT_STUDIO,
  JOIN_CLIPS_STUDIO,
  LIPSYNC_STUDIO,
  MOTION_CONTROL_STUDIO,
  MUSIC_STUDIO,
  REFRAME_STUDIO,
  SDR_TO_HDR_STUDIO,
  SFX_STUDIO,
  SONG_TOOLS_STUDIO,
  TRANSCRIBE_STUDIO,
  UPSCALE_STUDIO,
  VIDEO_COLOR_MATCH_STUDIO,
  VIDEO_DEPTH_STUDIO,
  VIDEO_EDIT_STUDIO,
  VIDEO_KEY_STUDIO,
  VIDEO_MATTE_STUDIO,
  VIDEO_RELIGHT_STUDIO,
  VIDEO_STUDIO,
  VIDEO_UPSCALE_STUDIO,
  VOICE_CHANGE_STUDIO,
} from "@/lib/studios";

/** Studios a model opens in (with ?model=), first match wins: the studio's picker lists its operation and kind. */
const MODEL_STUDIOS: [string, StudioConfig][] = [
  ["/image", IMAGE_STUDIO],
  ["/video", VIDEO_STUDIO],
  ["/edit", EDIT_STUDIO],
  ["/inpaint", INPAINT_STUDIO],
  ["/lipsync", LIPSYNC_STUDIO],
  ["/motion-control", MOTION_CONTROL_STUDIO],
  ["/video-edit", VIDEO_EDIT_STUDIO],
  ["/extend", EXTEND_STUDIO],
  ["/reframe", REFRAME_STUDIO],
  ["/upscale", UPSCALE_STUDIO],
  ["/upscale/video", VIDEO_UPSCALE_STUDIO],
  ["/upscale/fps", FPS_BOOST_STUDIO],
  ["/upscale/hdr", SDR_TO_HDR_STUDIO],
  ["/audio/speech", AUDIO_STUDIO],
  ["/audio/dialogue", DIALOGUE_STUDIO],
  ["/audio/voice-change", VOICE_CHANGE_STUDIO],
  ["/audio/transcribe", TRANSCRIBE_STUDIO],
  ["/audio/sfx", SFX_STUDIO],
  ["/audio/music", MUSIC_STUDIO],
  ["/audio/song", SONG_TOOLS_STUDIO],
  ["/audio/video", FOLEY_STUDIO],
  ["/video-tools", VIDEO_MATTE_STUDIO],
  ["/video-tools/green-screen", VIDEO_KEY_STUDIO],
  ["/video-tools/relight", VIDEO_RELIGHT_STUDIO],
  ["/video-tools/depth", VIDEO_DEPTH_STUDIO],
  ["/video-tools/join", JOIN_CLIPS_STUDIO],
  ["/video-tools/colors", VIDEO_COLOR_MATCH_STUDIO],
];

/** Image to 3D picks its model from ?model= too (and rigs and retextures its results). */
const IN_3D = new Set([...ALL_MODELS_3D.map((m) => m.id), RIG_MODEL, ...RETEXTURE_MODELS.map((m) => m.id)]);
/** The Layers editor's tools (cut-out, layers, text detection…): its project list is where they start. */
const IN_LAYERS = new Set(Object.values(TOOL_MODELS).flatMap((t) => [...t.cloud, ...t.open]));
/** Where a model no studio, app or tool offers opens: the studio of what it makes. */
const KIND_HOME: Record<ModelDef["kind"], string> = { image: "/image", video: "/video", audio: "/audio/speech", text: "/assist", model3d: "/image-to-3d" };
/** Tools with their own flow (and their own model choice), by operation. */
const TOOL_PAGES: [string, Operation][] = [
  ["/video-tools/captions", "captions"],
  ["/video-tools/trim", "trim"],
  ["/audio/translate", "dub"],
];

/**
 * Where a model opens: the first studio that offers it, Image to 3D, an app that runs it (each with
 * ?model=, which also brings the model's engine), the Layers editor or a tool of its operation, else
 * the main studio of its kind. A model kept out of the pickers (hidden) has no studio to open in.
 */
export function modelHref(m: ModelDef): string {
  const ops = new Set(m.routes.map((r) => r.op));
  const pick = `?model=${encodeURIComponent(m.id)}`;
  // A green-screen keyer opens in Video tools → Green screen, the other mattes in Remove background (studioCatalog's split).
  const studio = MODEL_STUDIOS.find(([, c]) => c.kind === m.kind && (c.pickerOps ?? c.ops).some((op) => ops.has(op)) && (!ops.has("bg-remove-video") || !!c.greenScreen === !!m.options.greenScreen));
  if (studio && !m.hidden) return studio[0] + pick;
  if (IN_3D.has(m.id)) return `/image-to-3d${pick}`;
  const app = APPS.find((a) => a.cloud?.modelId === m.id || a.open?.modelId === m.id);
  if (app) return `/apps/${app.id}${pick}`;
  if (IN_LAYERS.has(m.id)) return "/layers";
  const tool = TOOL_PAGES.find(([, op]) => ops.has(op));
  if (tool) return tool[0];
  return KIND_HOME[m.kind];
}

/** A still at the usual place travels as its version alone (presetThumb, command-search.ts, rebuilds the URL). */
function coverOf(id: string): string | undefined {
  const c = presetCover(id);
  if (!c) return undefined;
  const usual = new RegExp(`^/previews/presets/${id}\\.jpg\\?v=([0-9a-f]+)$`).exec(c.poster);
  return usual ? usual[1] : c.poster;
}

const preset = (p: Preset): PalettePreset => {
  const cover = coverOf(p.id);
  return { id: p.id, name: p.name, category: p.category, cloud: !!p.cloud, open: !!p.open, ...(cover && { cover }) };
};

const model = (m: ModelDef): PaletteModel => ({
  id: m.id,
  name: m.name,
  vendor: m.vendor,
  engine: m.engine,
  // A Fuobe Original runs on both engines.
  ...(enginesOf(m).length > 1 && { engines: enginesOf(m) }),
  href: modelHref(m),
  ops: [...new Set(m.routes.map((r) => OPERATION_LABELS[r.op] ?? r.op))].join(", "),
});

export function paletteIndex(): PaletteIndex {
  return {
    apps: APPS.map(preset),
    motions: MOTIONS.map(preset),
    effects: EFFECTS.map(preset),
    // Chain helpers (hidden) aren't offered anywhere, so the palette leaves them out too.
    models: MODELS.filter((m) => !m.hidden).map(model),
  };
}
