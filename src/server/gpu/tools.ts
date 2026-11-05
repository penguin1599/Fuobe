import "server-only";
import { FLY_MODELS } from "@/lib/catalog/fly-around";
import { DUB_STEP_MODELS } from "@/lib/av/dub";
import { HI3D_MODEL } from "@/lib/av/hi3d";
import { IDOL_VIEWS_WORKFLOW } from "@/lib/av/idol-views";
import { SPLIT_MODEL } from "@/lib/av/split";
import { VOICE_FIRST_MODELS, VOICE_FIRST_MUX } from "@/lib/av/voice-first";
import { BURN_MODELS } from "@/lib/av/captions";
import { CLEAN_DIALOGUE_PRESET, OPEN_MODEL as CLEAN_DIALOGUE_MODEL, OPEN_MUX_MODEL as CLEAN_DIALOGUE_MUX } from "@/lib/av/clean-dialogue";
import { REMOVE_DIALOGUE_MODELS } from "@/lib/av/remove-dialogue";
import { CLEAN_MODEL } from "@/lib/av/clean-voice";
import { getModel, getPreset, MODELS, modelsFor, PRESETS } from "@/lib/catalog";
import { graphLoras, PERSON_REMOVER_LORA } from "@/lib/catalog/character-swap";
import { BLOCKOUT_MODELS, PATH_MODELS } from "@/lib/catalog/cinema";
import { WORLD_JOIN, WORLD_MODEL } from "@/lib/world";
import { dualEngine, onEngine, runsOn } from "@/lib/catalog/engines";
import { FRAMES_MODELS } from "@/lib/catalog/keyframes";
import { PERSON_REMOVAL_TOOLS, REMOVE_TOOLS } from "@/lib/catalog/remove-object";
import { RESTORE, RESTORE_OPEN_JOIN } from "@/lib/catalog/restore";
import { H3_LATENT_DRAFT_WORKFLOW, H3_OPEN_MODEL, REGEN_DEFAULT_TIER, REGEN_JOIN, REGEN_LATENT_WORKFLOW, REGEN_MODEL, regenerateGraphLoras } from "@/lib/catalog/regenerate";
import { pikaFlexGraphLoras } from "@/lib/catalog/pika-flex";
import { RTX_FRAMEGEN_MODEL, RTX_HDR_MODEL, RTX_UPSCALE_MODEL } from "@/lib/catalog/rtx-video";
import { COMPOSITE_MODEL } from "@/lib/catalog/sharpen";
import { ORIGINALS, SHARPEN_TOOLS } from "@/lib/catalog/genjutsu";
import { libraryEntry, loraEntry, loraRef, needsToken } from "@/lib/catalog/loras";
import { ANGLES_2511_LORA } from "@/lib/catalog/open-tools";
import { presetRoutes, recipeRoute } from "@/lib/catalog/preset-recipes";
import { resolveWorkflowId } from "@/lib/comfy-variants";
import { STUDIO_WORKFLOWS } from "@/lib/catalog/swap-studio-plan";
import { FILL_MODELS } from "@/lib/catalog/turnaround";
import { QMA_MODEL } from "@/lib/qma";
import type { LoraRef, ModelDef, Operation } from "@/lib/catalog/types";
import type { LoraNeed } from "@/lib/gpu/readiness";
import { basename } from "@/lib/gpu/requirements";
import type { StudioGroup, ToolRef } from "@/lib/gpu/types";
import * as S from "@/lib/studios";
import type { StudioConfig } from "@/components/studio/studio-context";
import { loadIndex } from "./index-file";

/** Qwen-Image 2.1 on a 16 GB card: the small encoder's model (src/lib/qwen21-speed.ts). */
const QWEN21_SMALL_MODEL = "oss-qwen-image-21-small";

/** The open engine's Join clips (a turnaround's quarter turns become one film). */
const JOIN_CLIPS_MODEL = "oss-join-clips";

/**
 * From the tools people pick (a model's operation, a preset, a studio's open default) to the workflows and
 * LoRAs they run (SPEC §4.4). Variants (a camera pose, EXR frames…) count only when a request asks for them:
 * the gate resolves those per request (src/lib/comfy-variants.ts). Nothing here reads a key or a token: LoRA
 * downloads are described by their public URL and page only (review item 5).
 */

export interface Tool {
  ref: ToolRef;
  name: string;
  kind?: string;
  workflows: string[];
  loras: LoraNeed[];
  /** The same tool on the cloud engine (an Original that runs on both). */
  cloud?: { modelId: string };
  /** Runs in the browser (no ComfyUI): always ready. */
  local?: boolean;
}

/** A LoRA as the plan describes it: its file, public URL, page, size and how it downloads. */
export function loraNeed(l: Pick<LoraRef, "file" | "url">): LoraNeed {
  const e = libraryEntry(l);
  const url = e?.url ?? l.url;
  return {
    file: basename(l.file),
    ...(url && { url }),
    ...(e?.sizeBytes && { sizeBytes: e.sizeBytes }),
    ...(e?.sha256 && { sha256: e.sha256 }),
    download: e?.download ?? (needsToken(url) ? "civitai-token" : "direct"),
    ...(e?.page && { page: e.page }),
  };
}

/** A route endpoint's workflows: "video-concat-{n}" is one per clip count. */
function expand(endpoint: string): string[] {
  const ids = Object.keys(loadIndex().workflows);
  if (!endpoint.includes("{")) return ids.includes(endpoint) ? [endpoint] : [];
  const re = new RegExp(`^${endpoint.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "\\d+")}$`);
  return ids.filter((id) => re.test(id));
}

/** The model as it runs on the open engine (an Original's GPU routes), or undefined when it has none. */
function openModel(m: ModelDef | undefined): ModelDef | undefined {
  if (!m) return undefined;
  if (dualEngine(m)) return runsOn(m, "open") ? onEngine(m, "open") : undefined;
  return m.engine === "open" ? m : undefined;
}

function modelOps(m: ModelDef): Operation[] {
  return [...new Set(m.routes.filter((r) => r.provider === "comfyui" || r.provider === "local").map((r) => r.op))];
}

/** A model's operation on the open engine. */
export function modelTool(modelId: string, op: string): Tool | null {
  const full = getModel(modelId);
  const m = openModel(full);
  if (!m) return null;
  const routes = m.routes.filter((r) => r.op === op && (r.provider === "comfyui" || r.provider === "local"));
  if (!routes.length) return null;
  const workflows = [...new Set(routes.filter((r) => r.provider === "comfyui").flatMap((r) => expand(r.endpoint)))];
  // With the LoRAs a graph loads itself (Open-H3 Regenerate's refiner LoRA, which a run downloads).
  const loras = [
    ...(m.options.loras ?? []),
    ...routes.flatMap((r) => (r.provider === "comfyui" ? [...regenerateGraphLoras(r.endpoint), ...pikaFlexGraphLoras(r.endpoint, {})] : [])),
  ].map(loraNeed);
  return {
    ref: `model:${modelId}#${op}`,
    name: m.name,
    kind: m.kind,
    workflows,
    loras,
    ...(full && dualEngine(full) && runsOn(full, "cloud") && { cloud: { modelId } }),
    ...(!workflows.length && { local: true }),
  };
}

/**
 * A preset: an open route of it, its prestep's, and their LoRAs. By default the route the composer opens it on (the one
 * its preview was made with, when the catalog has its model); `own`: its own route; `modelId`: its route on that model
 * (null when it has none there: the run is the model's alone).
 */
export function presetTool(presetId: string, pick: { own?: boolean; modelId?: string } = {}): Tool | null {
  const p = getPreset(presetId);
  if (!p?.open) return null;
  const routes = presetRoutes(p, "open", (id) => !!getModel(id));
  const route = pick.own ? p.open : pick.modelId ? routes.find((r) => r.modelId === pick.modelId) : (routes[0] ?? p.open);
  if (!route) return null;
  const main = modelTool(route.modelId, route.op);
  if (!main) return null;
  // The graph the route's own settings pick (H3's Orbit graph, its Best one; a camera pose), as the gate resolves a run.
  const extra = route.params?.extra;
  const has = (id: string) => !!loadIndex().workflows[id];
  const graphs = extra ? main.workflows.map((w) => resolveWorkflowId(w, { op: route.op, clips: 0, images: 0, audio2: false, extra, has })) : main.workflows;
  const pre = p.prestep?.open ? modelTool(p.prestep.open.modelId, p.prestep.open.op) : null;
  // An end-frame step (Qwen-Image 2.1 edit that makes the clip's end frame before H3 runs start-to-end).
  const end = route.end ? modelTool(route.end.modelId, route.end.op) : null;
  const loras = new Map<string, LoraNeed>();
  for (const l of [...(route.loras ?? []), ...(p.prestep?.open.loras ?? [])]) loras.set(basename(l.file), loraNeed(l));
  for (const l of [...main.loras, ...(pre?.loras ?? []), ...(end?.loras ?? [])]) loras.set(l.file, l);
  // A route after the first is named by its model too ("preset:motion-jib-up@fuobe-dop"), so its guided fix plans it.
  const first = (routes[0] ?? p.open).modelId === route.modelId;
  // Its cloud alternative: on the route its preview was made with, that recipe hosted (MiniMax H3 on fal) when the
  // catalog has it; else the preset's own cloud route, for an Original that runs on both engines.
  const hosted = !pick.own && recipeRoute(p, "open")?.modelId === route.modelId ? recipeRoute(p, "cloud") : undefined;
  const cloud = hosted && getModel(hosted.modelId) ? hosted.modelId : p.cloud && main.cloud ? p.cloud.modelId : undefined;
  return {
    ref: first ? `preset:${p.id}` : `preset:${p.id}@${route.modelId}`,
    name: p.name,
    kind: main.kind,
    workflows: [...new Set([...graphs, ...(pre?.workflows ?? []), ...(end?.workflows ?? [])])],
    loras: [...loras.values()],
    ...(cloud && { cloud: { modelId: cloud } }),
    ...(main.local && !pre && { local: true }),
  };
}

export interface StudioRowDef {
  href: string;
  label: string;
  group: StudioGroup;
  config?: StudioConfig;
  /** A studio with graphs of its own (Character swap). */
  workflows?: string[];
  /** What such a studio makes (video unless said). */
  kind?: string;
  /**
   * A tool that runs open models' operations in steps (Split soundtrack, Cinema's fly path, the turnaround): their graphs
   * and LoRAs together, with the LoRAs a step adds itself (the turnaround's Angles LoRA). The first names the tool.
   */
  steps?: { modelId: string; op: Operation; loras?: LoraRef[] }[];
  /** Operations of the open default that have a row of their own (MiniMax H3's references: the Ref2VA partition). */
  skipOps?: Operation[];
}

/** The board's rows (src/lib/hubs.ts names the hub modes): each studio's open default. */
export const STUDIO_ROWS: StudioRowDef[] = [
  { href: "/image", label: "Image", group: "Images", config: S.IMAGE_STUDIO },
  { href: "/edit", label: "Edit", group: "Images", config: S.EDIT_STUDIO },
  { href: "/inpaint", label: "Inpaint", group: "Images", config: S.INPAINT_STUDIO },
  // Qwen-Image 2.1 on a 16 GB card: text to image and edits on Zen Image Edit's small encoder, which the
  // Image and Edit studios pick by themselves under 20 GB once it is ready (Options → GPU on Auto). The row's page opens the Image
  // studio on Qwen-Image 2.1.
  {
    href: "/image/small-gpu",
    label: "Image on a 16 GB GPU",
    group: "Images",
    steps: [
      { modelId: QWEN21_SMALL_MODEL, op: "t2i" },
      { modelId: QWEN21_SMALL_MODEL, op: "edit" },
    ],
  },
  { href: "/upscale", label: "Upscale", group: "Images", config: S.UPSCALE_STUDIO },
  // hi3d-refine: Image to 3D with "Refine detail · Hi3D 1.0": the default open model, then Hi3D's refine of its mesh.
  {
    href: "/image-to-3d",
    label: "Image to 3D, refined",
    group: "Images",
    steps: [
      { modelId: "oss-pixal3d", op: "image-to-3d" },
      { modelId: HI3D_MODEL, op: "refine-3d" },
    ],
  },
  // idol-7: Image to 3D's quick mesh (From an image, Idol 3D quick mesh): Idol's splat turned into a vertex-coloured mesh.
  { href: "/image-to-3d?model=oss-idol-mesh", label: "Image to 3D, quick mesh", group: "Images", steps: [{ modelId: "oss-idol-mesh", op: "image-to-3d" }] },
  // idol-8: From several images' "Make the other sides from the front": Idol 3D's four views, which need the ComfyUI-Idol pack.
  { href: "/image-to-3d?mode=multi", label: "Other sides from one picture", group: "Images", kind: "image", workflows: [IDOL_VIEWS_WORKFLOW] },
  // MiniMax H3's references (Pika H3 Flex Ref2VA) need the Ref2VA partition and Pika's adapter: a row of their own, so the
  // Video row stays what text, image and frame clips need.
  { href: "/video", label: "Video", group: "Video", config: S.VIDEO_STUDIO, skipOps: ["ref2v"] },
  { href: "/video?model=oss-minimax-h3", label: "Video from references", group: "Video", steps: [{ modelId: "oss-minimax-h3", op: "ref2v" }] },
  // Keyframe animation (Fuobe Animation): Frames mode's Animation style, every gap in one graph on Wan 2.2 with AniSora.
  { href: "/video?model=fuobe-animation", label: "Keyframe animation", group: "Video", steps: [{ modelId: "fuobe-animation", op: "keyframes" }] },
  { href: "/motion-control", label: "Motion control", group: "Video", config: S.MOTION_CONTROL_STUDIO },
  { href: "/video-edit", label: "Edit video", group: "Video", config: S.VIDEO_EDIT_STUDIO },
  { href: "/extend", label: "Extend", group: "Video", config: S.EXTEND_STUDIO },
  { href: "/reframe", label: "Reframe", group: "Video", config: S.REFRAME_STUDIO },
  { href: "/lipsync", label: "Lipsync", group: "Video", config: S.LIPSYNC_STUDIO },
  // nm10-kandinsky6: Kandinsky 6.0's clips with dialogue and sound (the Video studio, and Lipsync's "talking character from
  // words" link), on Lite unless Quality picks Pro.
  {
    href: "/video?model=oss-kandinsky6",
    label: "Video with dialogue",
    group: "Video",
    steps: [
      { modelId: "oss-kandinsky6", op: "t2v" },
      { modelId: "oss-kandinsky6", op: "i2v" },
    ],
  },
  // Clean the voice first on a lip re-sync of a clip: the voice cleaned, the re-sync on it, and the clip's music and
  // effects put back by the stream-copy mux.
  {
    href: "/lipsync?model=oss-infinitetalk-v2v",
    label: "Lip re-sync, voice cleaned",
    group: "Video",
    steps: [
      { modelId: VOICE_FIRST_MODELS.open, op: "separate-audio" },
      { modelId: "oss-infinitetalk-v2v", op: "lipsync" },
      { modelId: VOICE_FIRST_MUX, op: "mux" },
    ],
  },
  { href: "/character-swap", label: "Character swap", group: "Video", workflows: [STUDIO_WORKFLOWS.mask, STUDIO_WORKFLOWS.segment] },
  // Cinema's 3D scene films a still along a keyframed camera path (N7-5).
  { href: "/cinema", label: "Fly path", group: "Video", steps: [{ modelId: PATH_MODELS.open, op: "camera-path" }] },
  // Exact orbits: Fuobe DoP's and Cinema's orbit moves by their numbers, Canvas's Fly around and Assist's fly_around:
  // MoGe 2 measures the still's depth, the server renders the path, Uni3C films along it.
  {
    href: "/motions",
    label: "Exact orbits and Fly around",
    group: "Video",
    steps: [
      { modelId: FLY_MODELS.depth, op: "scene-3d" },
      { modelId: FLY_MODELS.open, op: "camera-path" },
    ],
  },
  // Cinema's Blockout to film on your GPU: the first frame from the references, the depth cut into windows, each window
  // rendered by the blockout graph and handed over on its last frame, then joined. An upload without a depth pass (the
  // usual Blender render) runs the restyle graph instead, which reads the depth with Depth Anything 3. The projects list
  // takes ?blockout=1 on to the project picked, which opens Blockout to film.
  {
    href: "/cinema?blockout=1",
    label: "Blockout to film",
    group: "Video",
    steps: [
      { modelId: BLOCKOUT_MODELS.open, op: "v2v" },
      { modelId: BLOCKOUT_MODELS.openNoDepth, op: "v2v" },
      { modelId: BLOCKOUT_MODELS.firstFrame, op: "edit" },
      { modelId: "oss-segment", op: "trim" },
      { modelId: "oss-extract-frame", op: "frame" },
      { modelId: "oss-join-encoded", op: "concat" },
    ],
  },
  // World mode (nm10-hy-nomas-world): Cinema's World take, Hy-Nomas turn by turn on Nynxz's port, and the turns joined into
  // one film. The projects list takes ?world=1 on to the project picked, which opens the World panel.
  {
    href: "/cinema?world=1",
    label: "World mode",
    group: "Video",
    steps: [
      { modelId: WORLD_MODEL, op: "world-turn" },
      { modelId: WORLD_JOIN, op: "concat" },
    ],
  },
  // The turnaround (N7-6): Frames mode's start/end-frame clips joined into one film, with the sides it has no picture of
  // drawn first by the Angles app (src/lib/catalog/turnaround.ts).
  {
    href: "/character-sheet",
    label: "Turnaround",
    group: "Video",
    steps: [
      { modelId: FRAMES_MODELS.open.id, op: "keyframes" },
      { modelId: JOIN_CLIPS_MODEL, op: "concat" },
      { modelId: FILL_MODELS.open, op: "edit", loras: [ANGLES_2511_LORA] },
    ],
  },
  // Turnaround stills · 8 views: the character from all 8 sides at eye level, drawn by QMA · 96 views (the
  // turnaround dialog's Stills route; its graph loads the QMA LoRA itself). It also draws a film's missing sides when picked.
  { href: "/character-sheet?stills=1", label: "Turnaround stills · 8 views", group: "Images", steps: [{ modelId: QMA_MODEL, op: "edit" }] },
  { href: "/audio/speech", label: "Voice", group: "Audio", config: S.AUDIO_STUDIO },
  { href: "/audio/dialogue", label: "Dialogue", group: "Audio", config: S.DIALOGUE_STUDIO },
  { href: "/audio/voice-change", label: "Voice change", group: "Audio", config: S.VOICE_CHANGE_STUDIO },
  // Design a voice: Qwen3-TTS designs the takes and clones the one saved (VoxCPM2 is the other choice).
  { href: "/audio/design", label: "Design a voice", group: "Audio", steps: [{ modelId: "oss-qwen3-tts", op: "voice-design" }, { modelId: "oss-qwen3-tts", op: "tts" }] },
  { href: "/audio/transcribe", label: "Transcribe", group: "Audio", config: S.TRANSCRIBE_STUDIO },
  // Edit speech (nm10-speech-edit): Qwen3-ASR times the words, AuK re-speaks the changed parts (a video's sound goes back on
  // the picture with the stream-copy mux).
  { href: "/audio/edit-speech", label: "Edit speech", group: "Audio", steps: [{ modelId: "oss-qwen3-asr", op: "transcribe" }, { modelId: "oss-auk", op: "speech-edit" }] },
  // DBS soundtrack separation (D1): dialogue, music and effects.
  { href: "/audio/split", label: "Split soundtrack", group: "Audio", steps: [{ modelId: SPLIT_MODEL, op: "separate-audio" }] },
  // Clean up dialogue (DBS D5, Split soundtrack's preset): graph C's remix, and the stream-copy mux for a video.
  {
    href: `/audio/split?preset=${CLEAN_DIALOGUE_PRESET}`,
    label: "Clean up dialogue",
    group: "Audio",
    steps: [
      { modelId: CLEAN_DIALOGUE_MODEL, op: "separate-audio" },
      { modelId: CLEAN_DIALOGUE_MUX, op: "mux" },
    ],
  },
  // Clean up voice (NVIDIA RE-USE on ComfyUI-RE-USE).
  { href: "/audio/clean", label: "Clean up voice", group: "Audio", steps: [{ modelId: CLEAN_MODEL, op: "enhance-voice" }] },
  // Translate & dub on the open engine: the voice split with its transcript (the default split, MelBand RoFormer; DBS
  // needs Split soundtrack's pack and weights), the cloned voice, its timeline, lip sync and the mux. The translation
  // runs on the local text model, not a ComfyUI graph.
  {
    href: "/audio/translate",
    label: "Translate & dub",
    group: "Audio",
    steps: [
      { modelId: DUB_STEP_MODELS.open.stems, op: "separate-audio" },
      { modelId: DUB_STEP_MODELS.open.speech, op: "tts" },
      { modelId: DUB_STEP_MODELS.open.timeline, op: "timeline" },
      { modelId: DUB_STEP_MODELS.open.lips, op: "lipsync" },
      { modelId: DUB_STEP_MODELS.open.mux, op: "mux" },
    ],
  },
  { href: "/audio/sfx", label: "Sound effects", group: "Audio", config: S.SFX_STUDIO },
  { href: "/audio/music", label: "Music", group: "Audio", config: S.MUSIC_STUDIO },
  { href: "/audio/video", label: "Sound for video", group: "Audio", config: S.FOLEY_STUDIO },
  { href: "/upscale/video", label: "Upscale video", group: "Video tools", config: S.VIDEO_UPSCALE_STUDIO },
  // Upscale → Video's Regenerate · creative (Open-H3 Regenerate with its refiner LoRA); a clip over 15 s is redrawn in
  // parts joined packet by packet. It needs a 48 GB card: the row says what the connected GPU lacks.
  {
    href: `/upscale/video?model=${REGEN_MODEL}&resolution=${REGEN_DEFAULT_TIER}`,
    label: "Regenerate in 2K",
    group: "Video tools",
    steps: [
      { modelId: REGEN_MODEL, op: "upscale-video" as const },
      { modelId: REGEN_JOIN, op: "concat" as const },
    ],
  } satisfies StudioRowDef,
  // NVIDIA RTX Video in Upscale → Video ("Quick · RTX"), FPS boost and SDR to HDR. An NVIDIA RTX card only (frame
  // generation: RTX 40 or later): elsewhere the row reads "Needs an NVIDIA RTX card".
  { href: `/upscale/video?model=${RTX_UPSCALE_MODEL}`, label: "Quick upscale · RTX", group: "Video tools", steps: [{ modelId: RTX_UPSCALE_MODEL, op: "upscale-video" }] },
  // MiniMax H3 at 2K on your GPU (Cinema and the Video studio's 2K tier, and Finish in 2K on a take): the 768p draft that
  // keeps its latent, and the 2K finish from it. It finishes with Open-H3 Regenerate (a 48 GB card).
  { href: `/video?model=${H3_OPEN_MODEL}&resolution=2K`, label: "MiniMax H3 in 2K", group: "Video", workflows: [H3_LATENT_DRAFT_WORKFLOW, REGEN_LATENT_WORKFLOW] } satisfies StudioRowDef,
  // The Character swap at 1080p / 2K / 4K (Genjutsu, and Sharpen in Character Swap Studio's Finish): the 768p swap, the
  // person's mask (SAM 3.1 on H3 Relay's graph), the part at 24 fps, the swap regenerated, only the character composited
  // over the footage, the windows joined and the part's sound put back. It regenerates with Open-H3 Regenerate (a 48 GB card).
  {
    href: "/genjutsu?mode=character",
    label: "Character swap in 2K",
    group: "Video tools",
    steps: [
      { modelId: ORIGINALS.character, op: "video-swap" as const },
      { modelId: SHARPEN_TOOLS.mask, op: "bg-remove-video" as const },
      { modelId: SHARPEN_TOOLS.fit, op: "trim" as const },
      { modelId: REGEN_MODEL, op: "upscale-video" as const },
      { modelId: COMPOSITE_MODEL, op: "composite" as const },
      { modelId: REGEN_JOIN, op: "concat" as const },
      { modelId: SHARPEN_TOOLS.mux, op: "mux" as const },
    ],
  } satisfies StudioRowDef,
  // Upscale → Video's Kandinsky VSR (2x, 2.25x, 4x; clips up to 5 s).
  { href: "/upscale/video?model=oss-kandinsky6-vsr", label: "Kandinsky VSR", group: "Video tools", steps: [{ modelId: "oss-kandinsky6-vsr", op: "upscale-video" }] },
  { href: "/upscale/fps", label: "FPS boost", group: "Video tools", config: S.FPS_BOOST_STUDIO },
  { href: `/upscale/fps?model=${RTX_FRAMEGEN_MODEL}`, label: "FPS boost · RTX", group: "Video tools", steps: [{ modelId: RTX_FRAMEGEN_MODEL, op: "interpolate" }] },
  { href: "/upscale/hdr", label: "SDR to HDR", group: "Video tools", config: S.SDR_TO_HDR_STUDIO },
  { href: `/upscale/hdr?model=${RTX_HDR_MODEL}`, label: "SDR to HDR · RTX", group: "Video tools", steps: [{ modelId: RTX_HDR_MODEL, op: "sdr-to-hdr" }] },
  { href: "/upscale/export", label: "Export", group: "Video tools", config: S.VIDEO_EXPORT_STUDIO },
  { href: "/video-tools", label: "Remove background", group: "Video tools", config: S.VIDEO_MATTE_STUDIO },
  // nm10-keying: CorridorKey 2.0 on footage shot on a green screen (its own list: ModelOptions.greenScreen).
  { href: "/video-tools/green-screen", label: "Green screen", group: "Video tools", config: S.VIDEO_KEY_STUDIO },
  // DBS D2: the split, then the stream-copy mux (one stem in place of the sound, or the voice over the lowered bed).
  {
    href: "/video-tools/remove-dialogue",
    label: "Remove dialogue",
    group: "Video tools",
    steps: [
      { modelId: REMOVE_DIALOGUE_MODELS.split, op: "separate-audio" },
      { modelId: REMOVE_DIALOGUE_MODELS.mux, op: "mux" },
    ],
  },
  // Captions on your GPU: the voice cleaned first (Clean the voice first, on for a clip once it has passed a real run), its
  // words, and the burn-in.
  {
    href: "/video-tools/captions",
    label: "Captions",
    group: "Video tools",
    steps: [
      { modelId: VOICE_FIRST_MODELS.open, op: "separate-audio" },
      { modelId: "oss-qwen3-asr", op: "transcribe" },
      { modelId: BURN_MODELS.open, op: "captions" },
    ],
  },
  // Remove a person: the part fitted to 24 fps, its first frame cleaned by Qwen-Image 2.1, the green
  // mask preview, H3 Relay's Person Removal with Akatz Labs' Person Remover LoRA, and the sound put back.
  {
    href: "/video-tools/remove-person",
    label: "Remove a person",
    group: "Video tools",
    steps: [
      { modelId: "oss-h3-person-remove", op: "remove-object", loras: [PERSON_REMOVER_LORA] },
      { modelId: PERSON_REMOVAL_TOOLS.mask, op: "bg-remove-video" },
      { modelId: PERSON_REMOVAL_TOOLS.fit, op: "trim" },
      { modelId: PERSON_REMOVAL_TOOLS.frame, op: "frame" },
      { modelId: PERSON_REMOVAL_TOOLS.clean, op: "edit" },
      { modelId: REMOVE_TOOLS.open.mux, op: "mux" },
    ],
  },
  { href: "/video-tools/relight", label: "Relight", group: "Video tools", config: S.VIDEO_RELIGHT_STUDIO },
  { href: "/video-tools/depth", label: "Depth map", group: "Video tools", config: S.VIDEO_DEPTH_STUDIO },
  { href: "/video-tools/join", label: "Join clips", group: "Video tools", config: S.JOIN_CLIPS_STUDIO },
  { href: "/video-tools/colors", label: "Match colors", group: "Video tools", config: S.VIDEO_COLOR_MATCH_STUDIO },
  // Restore & colourise (archive-restore): the tiled-fusion graph with the gated Restore IC-LoRA (the graph loads it
  // itself), then the windows joined packet by packet (the join planRestore runs) and the sound put back. "Restore to 4K"'s Detail Refine LoRA is an option, not listed.
  {
    href: "/video-tools/restore",
    label: "Restore & colourise",
    group: "Video tools",
    steps: [
      { modelId: RESTORE.model, op: "restore-video", loras: [loraRef(loraEntry(RESTORE.loras.restore.key)!)] },
      { modelId: RESTORE_OPEN_JOIN, op: "concat" },
      { modelId: REMOVE_TOOLS.open.mux, op: "mux" },
    ],
  },
];

/** A studio row's tool: its open default model on the studio's operations (or its own graphs, or its steps). */
export function studioTool(row: StudioRowDef): Tool | null {
  if (row.steps) {
    const parts = row.steps.flatMap((s) => {
      const t = modelTool(s.modelId, s.op);
      return t ? [{ ...t, loras: [...t.loras, ...(s.loras ?? []).map(loraNeed)] }] : [];
    });
    if (parts.length !== row.steps.length) return null;
    const loras = new Map(parts.flatMap((p) => p.loras).map((l) => [l.file, l]));
    return {
      ref: `studio:${row.href}`,
      name: parts[0].name,
      kind: parts[0].kind,
      workflows: [...new Set(parts.flatMap((p) => p.workflows))],
      loras: [...loras.values()],
      ...(parts.every((p) => p.local) && { local: true }),
    };
  }
  if (row.workflows) {
    const segment = row.workflows[row.workflows.length - 1];
    const loras = [...graphLoras(segment, {}), ...row.workflows.flatMap((w) => regenerateGraphLoras(w))];
    return { ref: `studio:${row.href}`, name: row.label, kind: row.kind ?? "video", workflows: row.workflows.filter((w) => !!loadIndex().workflows[w]), loras: loras.map(loraNeed) };
  }
  const c = row.config;
  const id = c?.defaultModels.open;
  if (!c || !id) return null;
  const m = openModel(getModel(id));
  if (!m) return null;
  const ops = modelOps(m).filter((op) => c.ops.includes(op) && !row.skipOps?.includes(op));
  const parts = (ops.length ? ops : modelOps(m)).map((op) => modelTool(id, op)).filter((t): t is Tool => !!t);
  if (!parts.length) return null;
  return {
    ref: `studio:${row.href}`,
    name: m.name,
    kind: m.kind,
    workflows: [...new Set(parts.flatMap((p) => p.workflows))],
    loras: parts[0].loras,
    ...(parts[0].cloud && { cloud: parts[0].cloud }),
    ...(parts.every((p) => p.local) && { local: true }),
  };
}

/** A studio's other open models (for "2 other tools fit your GPU"). */
export function studioOthers(row: StudioRowDef): Tool[] {
  const c = row.config;
  if (!c) return [];
  const ops = c.pickerOps ?? c.ops;
  const keyers = c.ops.includes("bg-remove-video");
  return modelsFor({ kind: c.kind, ops, engine: "open" })
    .filter((m) => m.id !== c.defaultModels.open && (!keyers || !!m.options.greenScreen === !!c.greenScreen))
    .flatMap((m) => {
      const op = modelOps(openModel(m) ?? m).find((o) => ops.includes(o));
      const t = op ? modelTool(m.id, op) : null;
      return t ? [t] : [];
    });
}

/** Every open model's operations (the model picker's and composer's chips). */
export function openModelTools(): Tool[] {
  const out: Tool[] = [];
  for (const m of MODELS) {
    const o = openModel(m);
    if (!o) continue;
    for (const op of modelOps(o)) {
      const t = modelTool(m.id, op);
      if (t) out.push(t);
    }
  }
  return out;
}

/** Every preset with an open route (the gallery's chips), on the route it opens on (`own`: its own route). */
export function presetTools(pick: { own?: boolean } = {}): Tool[] {
  return PRESETS.flatMap((p) => {
    const t = presetTool(p.id, pick);
    return t ? [t] : [];
  });
}

/**
 * Every preset's other open routes (Fuobe DoP with the move's LoRAs, an app's own model), each as
 * "preset:<id>@<model id>": the composer's badge and guided fix when one of them is picked.
 */
export function presetRouteTools(): Tool[] {
  return PRESETS.flatMap((p) => {
    const routes = presetRoutes(p, "open", (id) => !!getModel(id));
    const others = [...new Set(routes.slice(1).map((r) => r.modelId))].filter((id) => id !== routes[0]?.modelId);
    return others.flatMap((modelId) => {
      const t = presetTool(p.id, { modelId });
      return t ? [t] : [];
    });
  });
}

let loraNamesCache: string[] | null = null;

/**
 * Every LoRA a preset or a recipe names (what a full check looks for in models/loras): the presets' own routes too (Fuobe
 * DoP's), which stay one pick away when a preset opens on the model its preview was made with.
 */
export function allLoraNames(): string[] {
  loraNamesCache ??= [...new Set([...presetTools(), ...presetTools({ own: true }), ...openModelTools()].flatMap((t) => t.loras.map((l) => l.file)))].sort();
  return loraNamesCache;
}

/** A tool by reference (the plan route takes these from the client: only refs, never URLs or names, R2). */
export function toolFor(ref: string): Tool | null {
  const m = /^model:([^#]+)#(.+)$/.exec(ref);
  if (m) return modelTool(m[1], m[2]);
  const p = /^preset:([^@]+)(?:@(.+))?$/.exec(ref);
  if (p) return presetTool(p[1], p[2] ? { modelId: p[2] } : {});
  const s = /^studio:(.+)$/.exec(ref);
  if (s) {
    const row = STUDIO_ROWS.find((r) => r.href === s[1]);
    return row ? studioTool(row) : null;
  }
  const w = /^workflow:(.+)$/.exec(ref);
  if (w && loadIndex().workflows[w[1]]) return { ref: `workflow:${w[1]}`, name: w[1], workflows: [w[1]], loras: [] };
  return null;
}
