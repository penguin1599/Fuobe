import { describeMove, KEN_BURNS_FPS, sceneMoves } from "@/lib/av/ken-burns";
import { SPLIT_MODEL } from "@/lib/av/split";
import { COPY_JOIN_VIDEOS, lengthRange, plannedDurations } from "./clip-lengths";
import { estimateCost } from "./plan";
import { REGEN_FINISH_TIER, REGEN_MODEL, regenFinishSteps, sixteenFpsModel, type FinishStep } from "./regenerate";
import { pricingAt } from "./promo";
import type { ChainSlot, Engine, Generation, GenerationRequest, ModelDef } from "./types";

/*
 * Faceless Studio and the Explainer: the data and the pure planning shared by the browser (wizard,
 * script review, timeline editor) and the server (src/server/faceless.ts).
 *
 * Research: docs/research/higgsfield-marketing-agents.json → faceless (4 genres, 12 styles, 1–5 min,
 * Fully animated / Frame by frame, 16:9 / 9:16, ≤3 style references, ≤5,000-character topics, ≤12,000-character
 * scripts, 10-second blocks) and → explainer (22 styles, Auto / 20 s … 10 min / Manual 15–600 s, ≤3 sources).
 * tests/faceless.test.ts checks the copies against the JSON. The style prompts are Fuobe's own words.
 *
 * An episode is a list of blocks (one scene each, ≤10 s). Rendering builds one graph of chained generations:
 *
 *   still(b) ──► clip(b, s)… ──► join (folded) ──► mix ◄── narration, music ──► captions ──► final
 *
 * - still: a picture per block in the episode's style (Nano Banana Pro / Qwen-Image 2.1; with style
 *   references Nano Banana Pro edit / Krea 2 Style Reference).
 * - clip: the still animated (Gemini Omni Flash, Higgsfield's engine, MiniMax H3 or Seedance 2.5 / MiniMax H3 or
 *   Wan 2.2 Lightning). Clips that carry their own sound (MiniMax H3) lose it in the mix: the narration and the
 *   music take its place (the open join keeps the picture only; oss-mux lays the new soundtrack on).
 *   Frame by frame keeps the still and moves the camera slowly over it with no video model: a real Ken Burns
 *   (src/lib/av/ken-burns.ts) — fal's image-to-video zooms in and out by turns on the cloud; ComfyUI's
 *   kenburns-still zooms and pans on the open engine, at most 10 s a job, so longer scenes are split into
 *   pieces of one move, joined packet by packet with the others (video-concat-encoded).
 * - narration: the whole reviewed script read in one take (one natural voice-over; ElevenLabs v4, or
 *   Chatterbox cloning a voice sample), then timed word by word (ElevenLabs forced alignment on the cloud,
 *   Qwen3-ASR on the open engine).
 * - The render runs in two stages: the pictures, the narration and its timing first; then each block is
 *   cut to where its lines really fall (retimeBlocks) and the clips, joins, music, mix and subtitles follow,
 *   so picture and voice stay together over the whole film, whatever pace the narrator reads at.
 * - music: an instrumental bed (Sonilo / ACE-Step) as long as the film, mixed under the voice: fal's compose
 *   with the bed levelled to -28 LUFS on the cloud, oss-mux at -14 dB on the open engine. A film longer than
 *   the music model makes (ACE-Step: 240 s; Sonilo: 600 s) loops the bed: crossfaded seams on the open engine
 *   (audio-loop-crossfade, up to 600 s), whole plays on the cloud (merge-audios; the mix cuts it to the film).
 * - captions: Auto Subtitle on the cloud; Qwen3-ASR timings + the open burn-in on the open engine.
 */

// ---------------------------------------------------------------------------
// Research data

export type FacelessGenre = "education" | "history" | "kids" | "storytelling";

export interface GenreInfo {
  id: FacelessGenre;
  label: string;
  hint: string;
  /** Style, narrator and music a new channel of this genre starts with. */
  style: string;
  voice: string;
  music: string;
  /** How the scripts should sound. */
  tone: string;
}

export const GENRES: GenreInfo[] = [
  {
    id: "education",
    label: "Education",
    hint: "Explain how something works",
    style: "editorial-motion-graphics",
    voice: "Xb7hH8MSUJpSbSDYk0k2",
    music: "light, curious documentary underscore, soft piano and pizzicato strings, unobtrusive",
    tone: "clear and curious, one idea at a time, concrete examples, no jargon without explaining it",
  },
  {
    id: "history",
    label: "History",
    hint: "Retell what actually happened",
    style: "watercolor-chronicle",
    voice: "JBFqnCBsd6RMkjVDRZzb",
    music: "cinematic orchestral documentary bed, low strings and soft timpani, slow build",
    tone: "vivid but accurate, dates and names where they matter, tell it like a story",
  },
  {
    id: "kids",
    label: "Kids",
    hint: "Bright, simple, and safe",
    style: "colorful-3d",
    voice: "cgSgspJ2msm6clMCkdW9",
    music: "cheerful playful underscore, ukulele, glockenspiel and soft claps",
    tone: "warm, simple words, short sentences, gentle humour, nothing scary",
  },
  {
    id: "storytelling",
    label: "Storytelling",
    hint: "Carry one story to its end",
    style: "fairy-tale-myth",
    voice: "pFZP5JQG7iQjIQuC4Bku",
    music: "warm cinematic ambient score, gentle swells, mysterious and emotional",
    tone: "one story with a beginning, a turn and an ending; vivid images; a narrator who builds suspense",
  },
];

export const genreInfo = (g: string | null | undefined): GenreInfo => GENRES.find((x) => x.id === g) ?? GENRES[0];

/** The examples under "Channel idea" (research: channelIdeaExamples). */
export const CHANNEL_IDEAS = [
  "Channel about survival in the wild",
  "Channel about the rise and fall of empires",
  "Channel about ancient civilizations",
  "Channel with daily history facts",
  "Channel about famous heists and scams",
  "Channel with songs for kids",
];

/** The examples for each genre (CHANNEL_IDEAS sorted by genre, with a few more where a genre had one or none). */
export const GENRE_IDEAS: Record<FacelessGenre, string[]> = {
  education: [
    "Channel about survival in the wild",
    "Channel about how everyday things are made",
    "Channel explaining space in five minutes",
    "Channel about the science of sleep and the body",
  ],
  history: [
    "Channel about the rise and fall of empires",
    "Channel about ancient civilizations",
    "Channel with daily history facts",
    "Channel about famous heists and scams",
  ],
  kids: [
    "Channel with songs for kids",
    "Channel about animals for curious kids",
    "Channel with bedtime stories about friendly dragons",
    "Channel about how things work, for kids",
  ],
  storytelling: [
    "Channel retelling myths and legends",
    "Channel with true mysteries that were never solved",
    "Channel about famous heists and scams",
    "Channel with short ghost stories by the campfire",
  ],
};

export interface VisualStyle {
  id: string;
  name: string;
  description: string;
  /** What every still in this style looks like (Fuobe's own prompt). */
  look: string;
  /** How things move when the still is animated. */
  motion: string;
  /** Card colour (oklch hue). */
  hue: number;
}

const style = (name: string, description: string, look: string, motion: string, hue: number): VisualStyle => ({
  id: styleId(name),
  name,
  description,
  look,
  motion,
  hue,
});

export function styleId(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Every style either studio offers (the 22 Explainer styles; Faceless uses 12 of them). */
export const STYLES: VisualStyle[] = [
  style(
    "Editorial Motion Graphics",
    "Layered cutouts, animated labels, diagrams and documentary pacing",
    "editorial motion-graphics explainer frame: layered photo cutouts and bold flat shapes, clean labels, arrows and simple diagrams, documentary colour grade, generous negative space, crisp modern design",
    "elements slide in on separate layers, labels and arrows pop on, subtle parallax between the layers",
    265,
  ),
  style(
    "Stickman Cartoon",
    "A story or concept told with simple stickman characters",
    "simple stickman cartoon on an off-white background: thick clean black lines, round heads, a few flat colour accents, expressive poses, minimal props",
    "the stick figures move with bouncy, snappy cartoon timing; simple squash and stretch",
    40,
  ),
  style(
    "Watercolor Chronicle",
    "Painterly watercolour documentary look",
    "painterly watercolour documentary illustration: loose washes with bleeding edges, muted historical palette, textured cold-press paper, cinematic composition",
    "watercolour washes bloom gently, figures move slowly, the camera drifts like a documentary",
    30,
  ),
  style(
    "Fairy Tale & Myth",
    "Imaginative scenes inspired by fairy tales and mythology",
    "storybook fairy-tale illustration: mythic, imaginative scenes in soft painterly gouache, glowing magical light, rich jewel tones, ornate decorative details",
    "magical particles drift, cloth and hair sway, slow dreamlike movement",
    300,
  ),
  style(
    "Paper Diorama",
    "Layered paper-like scenes and cutout characters",
    "layered paper diorama: cut-paper scenery and characters arranged in depth layers, visible paper texture, soft shadows between the layers, a handmade miniature set in warm light",
    "gentle parallax between the paper layers, characters move like paper puppets",
    50,
  ),
  style(
    "Pastel Flat 2D",
    "Soft pastel colours and simple flat illustrations",
    "soft pastel flat 2D illustration: simple rounded shapes in flat fills of colour, edges defined by colour alone, gentle gradients, calm friendly characters, lots of breathing room",
    "soft eased motion, elements float gently, calm pacing",
    330,
  ),
  style(
    "Colorful 3D",
    "Bright, toy-like 3D renders",
    "bright colourful 3D render: toy-like rounded shapes, glossy plastic and soft clay materials, soft global illumination, playful saturated palette",
    "bouncy playful 3D animation, soft camera drift",
    200,
  ),
  style(
    "Hand Drawn",
    "Hand-drawn illustrations and animated scenes, sketched and storybook-like",
    "hand-drawn ink and pencil illustration with a light watercolour wash: sketchy linework, storybook feel, off-white paper texture",
    "lines wobble slightly as if redrawn every frame, gentle hand-animated motion",
    70,
  ),
  style(
    "Poster Vector",
    "Flat poster-style vector illustration",
    "bold flat vector poster illustration: strong silhouettes, a limited palette, geometric shapes, subtle screen-print grain, dramatic composition",
    "shapes shift with smooth vector motion, gentle parallax between the planes",
    15,
  ),
  style(
    "Mannequin",
    "Stylized mannequin figures instead of an on-camera presenter",
    "stylized faceless mannequin figures acting out the scene: smooth matte artist-mannequin bodies, a clean studio-lit set, soft shadows, a muted palette",
    "the mannequins move with smooth, deliberate gestures",
    240,
  ),
  style(
    "Whiteboard Doodle",
    "Marker doodles on a whiteboard",
    "whiteboard doodle explainer: black marker line drawings on a clean white board, simple icons, arrows and handwritten-style shapes, a few colour highlights",
    "drawings appear as if being sketched, marker strokes animate on",
    220,
  ),
  style(
    "3D Papercraft",
    "Folded paper models",
    "3D papercraft scene: folded and creased paper models with origami-like geometry, visible paper grain, soft diffuse studio light",
    "paper pieces fold and unfold, a gentle camera move around the models",
    95,
  ),
  style(
    "Mixed Media",
    "Photos, paint and sketches layered together",
    "mixed-media collage: photographs, paint strokes, pencil sketches and graphic shapes layered together, rich textures, editorial art direction",
    "layers slide and blend, painterly marks animate on",
    350,
  ),
  style(
    "Low Poly",
    "Faceted low-poly 3D",
    "low-poly 3D illustration: faceted geometric shapes, flat-shaded polygons, clean gradients, a stylized minimal environment",
    "faceted shapes rotate and shift, a smooth camera glide",
    180,
  ),
  style(
    "2D Illustrator",
    "Polished modern 2D illustration",
    "polished 2D digital illustration: clean linework, rich flat colours with soft shading, modern editorial character design",
    "smooth 2D character animation with layered parallax",
    280,
  ),
  style(
    "Pixel Art",
    "Retro 16-bit pixel art",
    "detailed 16-bit pixel art scene: crisp pixels, a limited retro palette, dithering, a game-like composition",
    "sprite-style animation with a few looping frames",
    140,
  ),
  style(
    "Claymotion",
    "Handmade claymation",
    "claymation stop-motion scene: handmade plasticine characters and sets, fingerprint textures, soft miniature lighting",
    "stop-motion clay animation at a slightly choppy frame rate",
    20,
  ),
  style(
    "Isometric Flat Vector",
    "Isometric flat vector worlds",
    "isometric flat vector illustration on a 30-degree grid: clean geometric buildings and objects, bright flat colours, tiny detailed figures",
    "isometric pieces build up and move along the grid",
    160,
  ),
  style(
    "3D Mix",
    "Clay, plastic and paper in one 3D scene",
    "stylized 3D scene mixing clay, plastic and paper materials: a playful, art-directed composition with soft colourful lighting",
    "playful mixed-material 3D animation",
    120,
  ),
  style(
    "Studio 3D",
    "Clean studio-lit 3D renders",
    "clean studio-lit 3D render: a minimal set on a seamless backdrop, soft key and rim light, physically based materials, product-shot polish",
    "a smooth slow camera orbit, precise 3D motion",
    250,
  ),
  style(
    "Fluffy Toy",
    "A soft plush-toy world",
    "soft fluffy plush-toy world: felt and fur textures, cuddly rounded characters, warm cosy lighting, pastel colours",
    "plush characters wobble and bounce softly",
    320,
  ),
  style(
    "Paper collage",
    "Torn-paper collage cutouts",
    "torn-paper collage: layered magazine cutouts and kraft paper with rough torn edges, halftone print texture, bits of tape",
    "cutouts jitter and slide like stop-motion collage",
    60,
  ),
];

/** Faceless Studio's 12 styles, in Higgsfield's order. */
export const FACELESS_STYLE_IDS = [
  "editorial-motion-graphics",
  "stickman-cartoon",
  "fairy-tale-myth",
  "paper-diorama",
  "hand-drawn",
  "mannequin",
  "poster-vector",
  "colorful-3d",
  "watercolor-chronicle",
  "paper-collage",
  "studio-3d",
  "pastel-flat-2d",
];

/** The Explainer's 22 styles, in Higgsfield's order. */
export const EXPLAINER_STYLE_IDS = STYLES.map((s) => s.id);

export const getStyle = (id: string | null | undefined): VisualStyle => STYLES.find((s) => s.id === id) ?? STYLES[0];

export const MAX_TOPIC = 5000;
export const MAX_SCRIPT = 12_000;
export const MAX_IDEA = 500;
export const MAX_STYLE_REFS = 3;
export const MAX_SOURCES = 3;
/** Faceless lengths: 1–5 minutes. */
export const FACELESS_LENGTHS = [60, 120, 180, 240, 300];
/** Explainer durations ("auto" = as long as the topic needs; "manual" = 15–600 s). */
export const EXPLAINER_DURATIONS: { value: number | "auto" | "manual"; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 180, label: "3 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: "manual", label: "Manual" },
];
export const EXPLAINER_MIN = 15;
export const EXPLAINER_MAX = 600;
/** "Auto" aims for this, the script decides. */
export const AUTO_SECONDS = 60;

/** Higgsfield charges per started 10-second block. */
export const BLOCK_SECONDS = 10;
export const MIN_BLOCK = 3;

// ---------------------------------------------------------------------------
// Settings and script

export type AnimationMode = "animated" | "frames";
export type EpisodeAspect = "16:9" | "9:16";

export const ANIMATION_MODES: { id: AnimationMode; label: string; tagline: string; copy: string; openCopy: string }[] = [
  { id: "animated", label: "Fully animated", tagline: "Seamless motion video", copy: "Continuous animation across every scene", openCopy: "Continuous animation across every scene" },
  {
    id: "frames",
    label: "Frame by frame",
    tagline: "Scene by scene video",
    copy: "Each picture with a slow Ken Burns zoom, in and out by turns — no video model, a fraction of the price",
    openCopy: "Each picture with a slow pan and zoom (Ken Burns) — no video model, so no GPU needed for the motion",
  },
];

/** Who reads the script: a premade voice (cloud) or a recording to clone (any engine). */
export type NarratorVoice = { kind: "preset"; id: string; name?: string } | { kind: "sample"; url: string; name?: string };

export interface EpisodeSettings {
  engine: Engine;
  /** Target length in seconds; the reviewed script decides the actual length. */
  length: number;
  animation: AnimationMode;
  aspect: EpisodeAspect;
  subtitles: boolean;
  music: boolean;
  /** A style preset, or up to 3 style reference images (they replace the preset). */
  styleId: string;
  styleRefs: string[];
  voice: NarratorVoice | null;
  /** @handles of the characters / locations the script may use. */
  elements: string[];
  /** Advanced: the video model and its quality ("" = the mode's default). */
  videoModel?: string;
  /** Advanced: the music bed's model (ENGINE_MODELS.musicChoices; none = the engine's default). */
  musicModel?: string;
  resolution?: string;
  /** Reference images that show the subject (Explainer sources). */
  sourceImages?: string[];
  /** Explainer "Auto": the script decides the length. */
  auto?: boolean;
  /** Content Factory: a reference clip's style brief, applied to the script and the look. */
  brief?: BriefLook;
  /**
   * A clip whose soundtrack becomes the music bed (open engine, with music on): its music and effects, the talking
   * taken out, looped to the film's length (clipBedFor). The cloud makes the music instead.
   */
  bedClip?: BedClip;
}

/** A video or audio file whose soundtrack is the music bed, and how long it is. */
export interface BedClip {
  url: string;
  seconds: number;
  name?: string;
}

/**
 * How a style brief (src/lib/catalog/content-factory.ts) shapes an episode: lines for the script writer, words
 * added to every picture and motion prompt, the music's mood, the scene length the writer aims for, the captions.
 */
export interface BriefLook {
  /** For the script writer: format, hook, pacing, shot types, the narrator's tone. */
  script: string[];
  /** Added to every picture's prompt (medium, palette, lighting, texture). */
  look?: string;
  /** Added to every motion prompt (how the camera moves, how scenes connect). */
  camera?: string;
  /** The music bed's mood (instead of the genre's). */
  music?: string;
  /** Seconds of narration a scene carries (a faster cut rate: more, shorter scenes). */
  sceneSeconds?: number;
  captions?: { position?: "top" | "center" | "bottom"; words?: number };
}

export interface ScriptBlock {
  id: string;
  /** What the narrator says over this block. */
  narration: string;
  /** What the picture shows (may @mention elements). */
  visual: string;
  /** What moves and how the camera moves. */
  motion: string;
  /** The block's length (from its narration when it's planned). */
  seconds: number;
}

/** Speaking rate used to time blocks (≈150 words a minute). Scripts are written a little under it. */
export const WORDS_PER_SECOND = 2.5;
export const WRITE_WORDS_PER_SECOND = 2.2;

export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** How long a block must be for its lines (plus a breath), within one block. */
export function secondsFor(narration: string): number {
  const words = wordCount(narration);
  if (!words) return MIN_BLOCK + 1;
  return Math.max(MIN_BLOCK, Math.min(BLOCK_SECONDS, Math.ceil(words / WORDS_PER_SECOND + 0.6)));
}

/** Lines that need more than one block to be spoken. */
export const tooLong = (narration: string) => wordCount(narration) / WORDS_PER_SECOND + 0.6 > BLOCK_SECONDS;

/** How many blocks a length is (10 s each, at least one). */
export const blockCount = (seconds: number) => Math.max(1, Math.round(seconds / BLOCK_SECONDS));

/** Words a block of this length can carry when the script is written. */
export const wordsFor = (seconds: number) => Math.max(4, Math.floor(seconds * WRITE_WORDS_PER_SECOND));

/** Split a length into blocks of at most 10 s (or `max`), as even as possible (25 s → 9 + 8 + 8). */
export function planBlocks(seconds: number, max = BLOCK_SECONDS): number[] {
  const total = Math.max(MIN_BLOCK, Math.round(seconds));
  const n = Math.ceil(total / Math.max(MIN_BLOCK, Math.min(BLOCK_SECONDS, max)));
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

let uid = 0;
/** Ids for new blocks (stable enough for React keys and edit targets). */
export const blockId = () => `b${Date.now().toString(36)}${(uid++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

const sentences = (text: string) =>
  text
    .replace(/\r/g, "")
    .split(/(?<=[.!?…])\s+|\n{1,}/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Cut text that's too long for one block into pieces that fit, at commas when it can. */
function fitPieces(sentence: string, max: number): string[] {
  if (wordCount(sentence) <= max) return [sentence];
  const parts = sentence.split(/(?<=[,;:—–])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    const next = cur ? `${cur} ${p}` : p;
    if (cur && wordCount(next) > max) {
      out.push(cur);
      cur = p;
    } else cur = next;
  }
  if (cur) out.push(cur);
  // A clause still too long: cut by words.
  return out.flatMap((piece) => {
    const words = piece.split(/\s+/);
    if (words.length <= max) return [piece];
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += max) chunks.push(words.slice(i, i + max).join(" "));
    return chunks;
  });
}

/** A picture to go with lines that came without one (pasted scripts, the offline writer). */
export const visualFromNarration = (narration: string) => {
  const s = narration.replace(/\s+/g, " ").trim().replace(/[.!?…]+$/, "");
  return s ? `A scene that shows: ${s.length > 220 ? `${s.slice(0, 217)}…` : s}` : "An establishing scene";
};

const DEFAULT_MOTION = "slow camera push-in, subtle movement in the scene";

/**
 * A pasted script as blocks: sentences grouped so each block's lines fit in 10 s. Pictures come from the
 * words (the writer can do better when an LLM is connected).
 */
export function splitScript(text: string): ScriptBlock[] {
  const max = Math.floor((BLOCK_SECONDS - 0.6) * WORDS_PER_SECOND);
  const pieces = sentences(text).flatMap((s) => fitPieces(s, max));
  const blocks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    const next = cur ? `${cur} ${p}` : p;
    if (cur && wordCount(next) > max) {
      blocks.push(cur);
      cur = p;
    } else cur = next;
  }
  if (cur) blocks.push(cur);
  return blocks.map((narration) => ({ id: blockId(), narration, visual: visualFromNarration(narration), motion: DEFAULT_MOTION, seconds: secondsFor(narration) }));
}

/**
 * Blocks ready to render: trimmed, each timed from its lines, and blocks whose lines don't fit in 10 s
 * split at sentence boundaries (the picture is reused, the camera keeps moving).
 */
export function normalizeBlocks(blocks: Partial<ScriptBlock>[]): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  for (const b of blocks) {
    const narration = (b.narration ?? "").replace(/\s+/g, " ").trim();
    const visual = (b.visual ?? "").trim() || visualFromNarration(narration);
    const motion = (b.motion ?? "").trim() || DEFAULT_MOTION;
    if (!narration && !(b.visual ?? "").trim()) continue;
    if (!tooLong(narration)) {
      out.push({ id: b.id || blockId(), narration, visual, motion, seconds: secondsFor(narration) });
      continue;
    }
    splitScript(narration).forEach((piece, i) =>
      out.push({ ...piece, id: i === 0 && b.id ? b.id : blockId(), visual: i === 0 ? visual : `${visual} (continued, a new angle)`, motion: i === 0 ? motion : DEFAULT_MOTION }),
    );
  }
  return out;
}

export const totalSeconds = (blocks: Pick<ScriptBlock, "seconds">[]) => blocks.reduce((n, b) => n + b.seconds, 0);

/** "2:05" */
export function formatLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The narration as one voice-over: blocks become paragraphs (a natural pause between them). */
export const narrationText = (blocks: Pick<ScriptBlock, "narration">[]) =>
  blocks
    .map((b) => b.narration.trim())
    .filter(Boolean)
    .join("\n\n");

/** Where each block sits in the film, by its planned length. */
export function blockTimes(blocks: Pick<ScriptBlock, "seconds">[]): { start: number; end: number }[] {
  let t = 0;
  return blocks.map((b) => {
    const start = t;
    t += b.seconds;
    return { start, end: t };
  });
}

// ---------------------------------------------------------------------------
// Models

export interface EngineModels {
  still: string;
  /** Stills that follow style reference images. */
  styleStill: string;
  /** "Change the picture": an edit of the block's current still. */
  editStill: string;
  video: string;
  /** Other video models the settings offer. */
  videoChoices: string[];
  narration: string;
  /** Narration that clones a recorded voice. */
  cloneNarration: string;
  /** Narration models that take long scripts (above `narrationMaxChars`). */
  longNarration: string;
  narrationMaxChars: number;
  music: string;
  /** Other music models the settings offer for the bed, each with the longest bed it makes (MUSIC_MAX). */
  musicChoices: string[];
  /** Extends a bed the music model can't make long enough (crossfaded on the open engine, whole plays on the cloud). */
  loop: string;
  /** Frame by frame: the camera move over each still (Ken Burns). */
  kenBurns: string;
  join: string;
  /** Joins at most this many clips at once (longer films are folded). */
  joinMax: number;
  /** The join of clips on one canvas (Frame by frame, MiniMax H3 on your GPU; open: packet copy, flat memory) and its fold size. */
  framesJoin: string;
  framesJoinMax: number;
  /** Puts the voice on the film (no music). */
  mux: string;
  /** Lays the voice over a music bed on the film. */
  mixMusic: string;
  /** Brings the bed down under the voice before the mix (the cloud mixer has no volume control). */
  levelMusic?: string;
  captions: string;
  /** Word timings of the narration: the scenes are cut to them (and the open captions burn them in). */
  align: string;
  /** The captions are burned from those timings (the cloud captioner transcribes by itself). */
  captionsUseWords: boolean;
  /** Pictures that show the subject of attached images, when the still model can't read images. */
  sourceStill?: string;
  /** "Upscale to 1080p" on a finished episode (cloud: SeedVR2; open: Real-ESRGAN in passes of a few frames, so memory stays flat). */
  upscale?: string;
  /**
   * "Regenerate to 1080p (sharper, may redraw)": each scene redrawn by Open-H3 Regenerate before the join and the music
   * (open engine only: nobody hosts the open refiner, so the cloud keeps its upscaler and shows no Regenerate).
   */
  regenerate?: string;
  write: string;
}

export const ENGINE_MODELS: Record<Engine, EngineModels> = {
  cloud: {
    still: "nano-banana-pro",
    styleStill: "nano-banana-pro",
    editStill: "nano-banana-pro",
    video: "gemini-omni-flash",
    videoChoices: ["gemini-omni-flash", "minimax-h3", "seedance-2-5"],
    narration: "elevenlabs-v4",
    cloneNarration: "chatterbox-cloud",
    longNarration: "elevenlabs-multilingual-v2",
    narrationMaxChars: 5000,
    music: "sonilo-music",
    musicChoices: ["sonilo-music", "minimax-music-3", "elevenlabs-music-2-5"],
    loop: "join-audio",
    kenBurns: "ken-burns",
    join: "join-clips",
    joinMax: 24,
    framesJoin: "join-clips",
    framesJoinMax: 24,
    mux: "merge-audio-video",
    mixMusic: "ffmpeg-compose",
    levelMusic: "ffmpeg-loudnorm",
    captions: "auto-subtitle",
    align: "elevenlabs-align",
    captionsUseWords: false,
    upscale: "seedvr-video",
    write: "text-llm",
  },
  open: {
    still: "oss-qwen-image-21",
    styleStill: "oss-style-krea2",
    editStill: "oss-qwen-image-21-turbo",
    video: "oss-minimax-h3",
    videoChoices: ["oss-minimax-h3", "oss-wan22-14b-fast"],
    narration: "oss-chatterbox",
    cloneNarration: "oss-chatterbox",
    longNarration: "oss-chatterbox",
    narrationMaxChars: Infinity,
    music: "oss-ace-step",
    musicChoices: ["oss-ace-step", "oss-minimax-music-3"],
    loop: "oss-audio-loop",
    kenBurns: "oss-ken-burns",
    join: "oss-join-clips",
    joinMax: 4,
    framesJoin: "oss-join-encoded",
    framesJoinMax: 24,
    mux: "oss-mux",
    mixMusic: "oss-mux",
    captions: "oss-captions-burnin",
    align: "oss-qwen3-asr",
    captionsUseWords: true,
    sourceStill: "oss-qwen-image-21-turbo",
    upscale: "oss-upscale-video-esrgan",
    regenerate: REGEN_MODEL,
    write: "oss-text-llm",
  },
};

/**
 * Clip lengths each block video model can make. Gemini Omni Flash takes any whole number of seconds
 * from 3 to 10 (research: duration 3–10), hosted MiniMax H3 any from 5 to 15 (fal's schema); the Ken Burns
 * moves 1–30 s (fal) and 1–10 s per job (ComfyUI, longer scenes split); MiniMax H3 on your GPU any from 3 to 15
 * (lengthRange), so each scene is cut to where its lines are spoken; the others list their durations in the catalog.
 */
export const DURATION_RANGES: Record<string, [number, number]> = { "gemini-omni-flash": [3, 10], "minimax-h3": [5, 15], "ken-burns": [1, 30], "oss-ken-burns": [1, 10] };

/** Default quality per mode. Frame by frame trades resolution for price on the cloud. */
export const DEFAULT_RESOLUTION: Record<string, Record<AnimationMode, string>> = {
  "gemini-omni-flash": { animated: "720p", frames: "360p" },
  "minimax-h3": { animated: "768P", frames: "768P" },
  "seedance-2-5": { animated: "720p", frames: "480p" },
  "oss-minimax-h3": { animated: "768p", frames: "768p" },
  "oss-wan22-14b-fast": { animated: "480p", frames: "480p" },
  // No model in the loop: 720p costs CPU time and memory (~11 MB a frame), not a GPU.
  "oss-ken-burns": { animated: "720p", frames: "720p" },
};

/**
 * Per-second prices that depend on the resolution (research: Gemini Omni Flash 1.1 is $0.03 / $0.10 /
 * $0.15 / $0.30 per second at 360p / 720p / 1080p / 4K). The catalog lists only the cheapest.
 */
export const PRICE_PER_SECOND: Record<string, Record<string, number>> = {
  "gemini-omni-flash": { "360p": 0.03, "720p": 0.1, "1080p": 0.15, "4k": 0.3 },
  // Seedance 2.5 (research: $0.2205 / $0.473 / $1.164 per second at 480p / 720p / 1080p).
  "seedance-2-5": { "480p": 0.2205, "720p": 0.473, "1080p": 1.164 },
};

/**
 * Music models that make any whole length up to this (Sonilo: up to 600 s; ACE-Step's workflow: up to 240 s; MiniMax Music 3
 * on either engine: 300 s; ElevenLabs Music v2.5: 600 s).
 */
export const MUSIC_MAX: Record<string, number> = { "sonilo-music": 600, "oss-ace-step": 240, "minimax-music-3": 300, "oss-minimax-music-3": 300, "elevenlabs-music-2-5": 600 };

/** Longest bed a loop model makes (the open loop graph's limit; the cloud's whole plays go past any film). */
export const LOOP_MAX: Record<string, number> = { "oss-audio-loop": 600 };

/** Seconds of crossfade at each seam of a looped bed (open engine): long enough to hide the restart. */
export const BED_CROSSFADE = 3;

/** How far the bed sits under the voice: levelled to -28 LUFS on the cloud, lowered by 14 dB by the open mixer. */
export const BED_LUFS = -28;
export const BED_DB = -14;

export type ModelLookup = (id: string) => ModelDef | undefined;

/** Shot lengths that cover a block with the fewest shots, then the least overshoot. */
export function shotsFor(seconds: number, durations: number[] | undefined, range?: [number, number]): number[] {
  const need = Math.max(1, Math.round(seconds));
  if (range) {
    // Any whole length in the range: split as evenly as possible, so the shots add up to the block (11 → 6 + 5).
    const [lo, hi] = range;
    const n = Math.ceil(need / hi);
    const base = Math.floor(need / n);
    const extra = need - base * n;
    return Array.from({ length: n }, (_, i) => Math.min(hi, Math.max(lo, base + (i < extra ? 1 : 0))));
  }
  const ds = [...new Set(durations?.length ? durations : [5])].filter((d) => d > 0).sort((a, b) => a - b);
  const max = ds[ds.length - 1];
  const n = Math.ceil(need / max);
  // Smallest total ≥ need with n shots (n ≤ 4 in practice: try every combination).
  let best: number[] | null = null;
  const walk = (left: number, picked: number[]) => {
    if (left === 0) {
      const sum = picked.reduce((a, b) => a + b, 0);
      if (sum >= need && (!best || sum < best.reduce((a, b) => a + b, 0))) best = [...picked];
      return;
    }
    for (const d of ds) if (!picked.length || d <= picked[picked.length - 1]) walk(left - 1, [...picked, d]);
  };
  walk(n, []);
  return best ?? Array.from({ length: n }, () => max);
}

/** The block video model's shots for a block (MiniMax H3 on your GPU: any 3 to 15 s each). */
export function blockShots(seconds: number, model: ModelDef | undefined): number[] {
  if (!model) return [Math.round(seconds)];
  return shotsFor(seconds, plannedDurations(model), DURATION_RANGES[model.id] ?? lengthRange(model));
}

// ---------------------------------------------------------------------------
// Prompts

const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");

/** The picture for a block, in the episode's style (or its style references), with a brief's look words. */
export function stillPrompt(style: VisualStyle, block: Pick<ScriptBlock, "visual">, o: { aspect: EpisodeAspect; refs: number; sources?: number; look?: string } = { aspect: "16:9", refs: 0 }): string {
  const frame = o.aspect === "9:16" ? "Vertical 9:16 composition, the subject centred for a phone screen" : "Wide 16:9 composition";
  const look = o.refs
    ? `Draw it in the exact visual style of the reference image${o.refs > 1 ? "s" : ""}: the same technique, palette, line and texture`
    : `Style: ${style.look}`;
  const sources = o.sources ? `Use the attached source picture${o.sources > 1 ? "s" : ""} for what the subject looks like` : "";
  const brief = o.look?.trim() && !o.refs ? `Look: ${clean(o.look)}` : "";
  return [clean(block.visual), look, brief, sources, frame, "A clean, full-frame picture of the scene alone"].filter(Boolean).join(". ") + ".";
}

/** What moves when a block's still is animated (Fully animated; Frame by frame moves the camera with no model, see sceneMoves). */
export function motionPrompt(style: VisualStyle, block: Pick<ScriptBlock, "motion">, shot = 0, camera?: string): string {
  const then = shot ? "The camera keeps moving from where the last shot ended. " : "";
  const brief = camera?.trim() ? ` Camera: ${clean(camera)}.` : "";
  return `${then}${clean(block.motion) || DEFAULT_MOTION}. ${style.motion.charAt(0).toUpperCase()}${style.motion.slice(1)}.${brief} Keep the art style, characters and colours exactly as in the first frame, the picture clean throughout.`;
}

export const musicPrompt = (genre: GenreInfo, style: VisualStyle, mood?: string) =>
  `Instrumental background music for a narrated video: ${mood?.trim() ? clean(mood) : genre.music}. It sits under a voice-over: purely instrumental, at a steady level with smooth, even dynamics. Mood to match ${style.name.toLowerCase()} visuals.`;

// ---------------------------------------------------------------------------
// The render graph

export type StepPart = "still" | "clip" | "join" | "narration" | "music" | "mix" | "words" | "captions";

export interface GraphStep {
  key: string;
  part: StepPart;
  /** Block index (0-based) for still and clip steps. */
  block?: number;
  shot?: number;
  label: string;
  request: GenerationRequest;
  after?: string[];
  chain?: ChainSlot[];
  /** How much film the step covers (prices per second or minute: clips, music, mix, subtitles). */
  seconds?: number;
}

export interface GraphInput {
  feature: "faceless" | "explainer";
  title: string;
  genre: GenreInfo;
  settings: EpisodeSettings;
  blocks: ScriptBlock[];
  /** Per block: a picture edit to make instead of a new still (timeline editor). */
  stillEdits?: Record<string, { source: string; instruction: string }>;
  /** A voice to clone when the settings have none (the demo voice). */
  fallbackVoice?: string;
}

export interface ResolvedModels {
  still: string;
  /** "edit": the pictures are drawn from attached source images by an edit model (open engine). */
  stillOp?: "edit";
  video: string;
  resolution: string;
  narration: string;
  music: string | null;
  /** Extends the bed past what the music model makes. */
  loop: string | null;
  /** Brings the bed down under the voice before the mix (cloud). */
  level: string | null;
  mux: string;
  join: string;
  joinMax: number;
  captions: string | null;
  /** Word timings of the narration: the scenes are cut to them. */
  align: string;
  /** The captions are burned from those timings (open engine). */
  captionsUseWords: boolean;
}

/** Which models an episode runs on, from its engine and settings. */
export function resolveModels(settings: EpisodeSettings, narrationChars: number, lookup: ModelLookup): ResolvedModels {
  const m = ENGINE_MODELS[settings.engine];
  // Frame by frame moves a camera over each still (Ken Burns); the video model choice is for Fully animated.
  const frames = settings.animation === "frames";
  const video = frames ? m.kenBurns : settings.videoModel && m.videoChoices.includes(settings.videoModel) ? settings.videoModel : m.video;
  const videoDef = lookup(video);
  const offered = videoDef?.options.resolutions ?? [];
  const wanted = settings.resolution && offered.includes(settings.resolution) ? settings.resolution : (DEFAULT_RESOLUTION[video]?.[settings.animation] ?? videoDef?.defaults?.resolution ?? offered[0] ?? "720p");
  const sample = settings.voice?.kind === "sample";
  const narration = settings.engine === "open" ? m.narration : sample ? m.cloneNarration : narrationChars > m.narrationMaxChars ? m.longNarration : m.narration;
  // Style references win; attached source images otherwise go to a model that reads them.
  const fromSources = !settings.styleRefs.length && !!settings.sourceImages?.length && !!m.sourceStill;
  // Clips that share one canvas and frame rate are joined packet by packet, in flat memory however long the film: the
  // Ken Burns moves, and MiniMax H3 on your GPU from stills drawn in the episode's shape (an edit keeps its source's).
  const copyJoin = frames || (COPY_JOIN_VIDEOS.has(video) && !fromSources);
  return {
    still: settings.styleRefs.length ? m.styleStill : fromSources ? m.sourceStill! : m.still,
    ...(fromSources && { stillOp: "edit" as const }),
    video,
    resolution: wanted,
    narration,
    music: settings.music ? (settings.musicModel && m.musicChoices.includes(settings.musicModel) ? settings.musicModel : m.music) : null,
    loop: settings.music ? m.loop : null,
    level: settings.music ? (m.levelMusic ?? null) : null,
    mux: settings.music ? m.mixMusic : m.mux,
    join: copyJoin ? m.framesJoin : m.join,
    joinMax: copyJoin ? m.framesJoinMax : m.joinMax,
    captions: settings.subtitles ? m.captions : null,
    align: m.align,
    captionsUseWords: m.captionsUseWords,
  };
}

/** Group keys into joins of at most `max`, level by level, so a changed block re-runs only its branch. */
export function foldJoins(keys: string[], max: number): { key: string; after: string[] }[][] {
  const levels: { key: string; after: string[] }[][] = [];
  let level = keys;
  let depth = 0;
  while (level.length > 1) {
    if (level.length <= max) {
      levels.push([{ key: "join", after: level }]);
      break;
    }
    const joins: { key: string; after: string[] }[] = [];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += max) {
      const group = level.slice(i, i + max);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const key = `join-${depth + 1}-${joins.length + 1}`;
      joins.push({ key, after: group });
      next.push(key);
    }
    levels.push(joins);
    level = next;
    depth++;
  }
  return levels;
}

const pick = (lookup: ModelLookup, id: string) => {
  const m = lookup(id);
  if (!m) throw new Error(`Unknown model ${id}`);
  return m;
};

/**
 * How long the music bed is: as long as the film (plus a second) for models that make any length up to
 * their limit (MUSIC_MAX), else the shortest fixed length that covers it, else the longest there is.
 */
export function musicLength(model: ModelDef | undefined, seconds: number): number {
  const max = model ? MUSIC_MAX[model.id] : undefined;
  if (max) return Math.min(max, Math.max(10, Math.ceil(seconds) + 1));
  const ds = [...(model?.options.durations ?? [])].sort((a, b) => a - b);
  if (!ds.length) return Math.ceil(seconds);
  return ds.find((d) => d >= seconds) ?? ds[ds.length - 1];
}

export interface MusicPlan {
  /** Seconds the music model makes. */
  bed: number;
  /**
   * The bed extended to cover the film: crossfaded seams (open), or whole plays the mix cuts to the film
   * (cloud). Null when the bed already covers it.
   */
  loop: { duration: number; crossfade?: number; plays?: number } | null;
  /** Seconds at the end of the film with no music (past what the loop makes, 600 s on the open engine). */
  short: number;
}

/**
 * The music for a film of `seconds`: the bed the music model makes (musicLength) and, when that is shorter
 * than the film, the loop that extends it. 0 seconds of music short means the whole film has music.
 */
export function musicPlan(music: ModelDef | undefined, loop: ModelDef | undefined, seconds: number, bedSeconds?: number): MusicPlan {
  // A clip's soundtrack is as long as the clip (it can't be made longer, only looped).
  const bed = bedSeconds && bedSeconds > 0 ? Math.round(bedSeconds * 100) / 100 : musicLength(music, seconds);
  // The bed runs a second past the film when it can; one that only misses that second needs no loop (a whole
  // second play of Sonilo's 600 s for a 600 s film would be a call for nothing).
  if (bed >= seconds || !loop) return { bed, loop: null, short: Math.max(0, Math.ceil(seconds - bed)) };
  const need = Math.ceil(seconds) + 1;
  const duration = Math.min(LOOP_MAX[loop.id] ?? Infinity, need);
  // A route that only repeats the clip (fal merge-audios) plays it whole; ComfyUI crossfades each seam.
  const repeats = loop.routes.some((r) => r.op === "audio-loop" && !!r.map?.loop);
  return {
    bed,
    loop: { duration, ...(repeats ? { plays: Math.ceil(duration / bed) } : { crossfade: BED_CROSSFADE }) },
    short: Math.max(0, Math.ceil(seconds - duration)),
  };
}

/** Seconds of film a block's shots make (its planned or timed length, rounded up to what the model makes). */
export const filmSeconds = (seconds: number, video: ModelDef | undefined) => blockShots(seconds, video).reduce((a, c) => a + c, 0);

/**
 * Every step of an episode render, in dependency order. Pure: the server turns it into chained
 * generations, the editor uses it to work out what a change re-runs. Blocks carry their length: the
 * planned one, or (once the narration is timed, see sceneTiming) the length cut to their lines.
 */
export function buildEpisodeGraph(input: GraphInput, lookup: ModelLookup): GraphStep[] {
  const { settings, blocks, feature } = input;
  if (!blocks.length) throw new Error("The script has no scenes yet");
  const style = getStyle(settings.styleId);
  const voiceText = narrationText(blocks);
  if (!voiceText) throw new Error("The script has no narration yet");
  const models = resolveModels(settings, voiceText.length, lookup);
  const videoDef = pick(lookup, models.video);
  const ar = settings.aspect;
  const batchTitle = input.title;
  const base = { feature, batchTitle } satisfies Partial<GenerationRequest>;
  const steps: GraphStep[] = [];
  const n = blocks.length;
  const clipKeys: string[] = [];
  const sources = (settings.sourceImages ?? []).slice(0, MAX_SOURCES);
  const refs = settings.styleRefs.slice(0, MAX_STYLE_REFS);
  const stillDef = pick(lookup, models.still);
  const maxImages = stillDef.options.maxImages ?? 1;
  // Reference images go where the still model reads them: a style-reference model takes only the style
  // images; a multi-reference model (Nano Banana Pro) takes them and the sources; an edit model (open,
  // with sources) the sources; a plain t2i model none.
  const takesRefs = stillDef.routes.some((r) => r.op === "edit") || !!stillDef.options.maxImages;
  const stillImages =
    models.stillOp === "edit" ? sources.slice(0, maxImages) : !takesRefs ? [] : stillDef.engine === "open" && refs.length ? refs.slice(0, maxImages) : [...refs, ...sources].slice(0, maxImages);
  const refCount = models.stillOp === "edit" ? 0 : Math.min(refs.length, stillImages.length);
  // Frame by frame: a camera move over the still, no video model. A route that sends the move as one zoom
  // (fal's zoompan) can't pan: those scenes zoom in and out by turns.
  const kenBurns = videoDef.routes.some((r) => r.op === "still-motion");
  const zoomOnly = videoDef.routes.some((r) => r.op === "still-motion" && !!r.map?.zoom);

  blocks.forEach((b, i) => {
    const edit = input.stillEdits?.[b.id];
    const stillKey = `still-${b.id}`;
    const label = `Scene ${i + 1} · picture`;
    steps.push({
      key: stillKey,
      part: "still",
      block: i,
      label,
      request: edit
        ? {
            ...base,
            modelId: ENGINE_MODELS[settings.engine].editStill,
            op: "edit",
            prompt: `${clean(edit.instruction)}. Keep everything else the same: the art style, composition, characters and colours.`,
            inputs: { images: [edit.source] },
            params: { aspectRatio: ar, numOutputs: 1 },
            step: { label, index: i, of: n },
          }
        : {
            ...base,
            modelId: models.still,
            ...(models.stillOp && { op: models.stillOp }),
            prompt: stillPrompt(style, b, { aspect: ar, refs: refCount, sources: stillImages.length - refCount, look: settings.brief?.look }),
            ...(stillImages.length && { inputs: { images: stillImages } }),
            params: { aspectRatio: ar, numOutputs: 1 },
            step: { label, index: i, of: n },
          },
    });
    const shots = blockShots(b.seconds, videoDef);
    // A scene longer than one Ken Burns job is one move cut into pieces (each starts where the last ended).
    const moves = kenBurns ? sceneMoves({ motion: b.motion, visual: b.visual, index: i, pieces: shots, zoomOnly, ignore: DEFAULT_MOTION, fps: KEN_BURNS_FPS }) : null;
    shots.forEach((secs, s) => {
      const key = `clip-${b.id}-${s + 1}`;
      clipKeys.push(key);
      const noun = moves ? "camera move" : "clip";
      const clipLabel = shots.length > 1 ? `Scene ${i + 1} · ${noun} ${s + 1} of ${shots.length}` : `Scene ${i + 1} · ${noun}`;
      const move = moves?.[s];
      steps.push({
        key,
        part: "clip",
        block: i,
        shot: s,
        label: clipLabel,
        seconds: secs,
        after: [stillKey],
        chain: [{ slot: "images", position: "first" }],
        request: move
          ? {
              ...base,
              modelId: models.video,
              op: "still-motion",
              prompt: describeMove(move),
              params: {
                aspectRatio: ar,
                duration: secs,
                resolution: models.resolution,
                fps: KEN_BURNS_FPS,
                zoomFrom: move.zoomFrom,
                zoomTo: move.zoomTo,
                panFrom: move.panFrom,
                panTo: move.panTo,
                easing: move.easing,
                numOutputs: 1,
              },
              step: { label: clipLabel, index: i, of: n },
            }
          : {
              ...base,
              modelId: models.video,
              op: "i2v",
              prompt: motionPrompt(style, b, s, settings.brief?.camera),
              params: {
                aspectRatio: ar,
                duration: secs,
                resolution: models.resolution,
                numOutputs: 1,
                // The narration replaces the clip's own sound.
                ...(videoDef.options.audio === true && { generateAudio: false }),
              },
              step: { label: clipLabel, index: i, of: n },
            },
      });
    });
  });

  // Join the clips (folded when there are more than one join takes).
  const joinDef = pick(lookup, models.join);
  const joinRes = joinDef.options.resolutions?.includes(models.resolution) ? models.resolution : (joinDef.defaults?.resolution ?? undefined);
  const levels = foldJoins(clipKeys, models.joinMax);
  for (const level of levels) {
    for (const j of level) {
      steps.push({
        key: j.key,
        part: "join",
        label: j.key === "join" ? "Joining the scenes" : `Joining scenes (part ${j.key.split("-").slice(1).join(".")})`,
        after: j.after,
        chain: j.after.map(() => ({ slot: "videos" as const })),
        request: {
          ...base,
          modelId: models.join,
          op: "concat",
          prompt: input.title,
          params: { aspectRatio: ar, ...(joinRes && { resolution: joinRes }) },
          step: { label: j.key === "join" ? "Film" : "Joining scenes", index: n, of: n },
        },
      });
    }
  }
  const film = levels.length ? "join" : clipKeys[0];
  const length = blocks.reduce((t, b) => t + filmSeconds(b.seconds, videoDef), 0);

  // The voice-over, read in one take, then timed word by word.
  const narrationDef = pick(lookup, models.narration);
  const voice = settings.voice;
  const sample = voice?.kind === "sample" ? voice.url : narrationDef.options.voiceClone && !narrationDef.options.voices?.length ? input.fallbackVoice : undefined;
  const presetVoice = voice?.kind === "preset" && narrationDef.options.voices?.some((v) => v.id === voice.id) ? voice.id : narrationDef.defaults?.voice;
  steps.push({
    key: "narration",
    part: "narration",
    label: "Narration",
    request: {
      ...base,
      modelId: models.narration,
      op: "tts",
      prompt: voiceText,
      ...(sample && { inputs: { voiceAudio: sample } }),
      params: { ...(presetVoice && !sample && { voice: presetVoice }) },
      step: { label: "Narration", index: n, of: n },
    },
  });
  // Forced alignment reads the known script with the recording; an ASR just listens.
  const alignDef = pick(lookup, models.align);
  const alignReadsText = alignDef.routes.some((r) => r.op === "transcribe" && typeof r.map?.prompt === "string");
  steps.push({
    key: "words",
    part: "words",
    label: "Narration timing",
    after: ["narration"],
    chain: [{ slot: "audio" }],
    request: { ...base, modelId: models.align, op: "transcribe", ...(alignReadsText && { prompt: voiceText }), step: { label: "Narration timing", index: n, of: n } },
  });

  let bedKey = "music";
  // The bed's stem when it comes from a clip's soundtrack (its music and effects, split from the talking).
  let bedStem: string | undefined;
  if (models.music) {
    const musicDef = pick(lookup, models.music);
    const clip = clipBedFor(settings);
    // A clip longer than the film is cut to the film's length and a second first, so DBS separates only what's played.
    const cutTo = clip && clip.seconds > Math.ceil(length) + 1 ? Math.ceil(length) + 1 : undefined;
    const plan = musicPlan(musicDef, models.loop ? lookup(models.loop) : undefined, length, cutTo ?? clip?.seconds);
    const bed = plan.bed;
    if (clip) {
      // A clip's soundtrack as the bed (DBS on your GPU): the talking taken out, its music and effects kept.
      bedStem = "background";
      if (cutTo)
        steps.push({
          key: "music-cut",
          part: "music",
          label: "Music bed · your clip cut to the film",
          seconds: cutTo,
          request: {
            ...base,
            modelId: CLIP_BED_CUT_MODEL,
            op: "timeline",
            inputs: { audio: clip.url },
            params: { duration: cutTo, extra: { timeline: { length: cutTo, clips: [{ start: 0, duration: cutTo }] } } },
            step: { label: "Your clip cut to the film", index: n, of: n },
          },
        });
      steps.push({
        key: "music",
        part: "music",
        label: "Music bed · from your clip",
        seconds: bed,
        ...(cutTo && { after: ["music-cut"], chain: [{ slot: "audio" as const }] }),
        request: {
          ...base,
          modelId: SPLIT_MODEL,
          op: "separate-audio",
          inputs: cutTo ? {} : CLIP_BED_AUDIO.test(clip.url) ? { audio: clip.url } : { video: clip.url },
          params: { sourceDuration: bed, extra: { channels: "mono" } },
          step: { label: "Music from your clip", index: n, of: n },
        },
      });
    } else
      steps.push({
        key: "music",
        part: "music",
        label: "Music bed",
        seconds: bed,
        request: {
          ...base,
          modelId: models.music,
          op: "music",
          prompt: musicPrompt(input.genre, style, settings.brief?.music),
          // A model that sings is asked for an instrumental (ACE-Step, MiniMax Music 3).
          params: { duration: bed, numOutputs: 1, ...(musicDef.options.lyrics && { extra: { lyrics: "[Instrumental]" } }) },
          step: { label: "Music", index: n, of: n },
        },
      });
    // A film longer than the bed: the bed looped (crossfaded seams, or whole plays the mix cuts to the film).
    if (plan.loop && models.loop) {
      const { duration, crossfade } = plan.loop;
      steps.push({
        key: "music-loop",
        part: "music",
        label: "Music bed · looped",
        after: ["music"],
        chain: [{ slot: "audio", ...(bedStem && { stem: bedStem }) }],
        seconds: duration,
        request: {
          ...base,
          modelId: models.loop,
          op: "audio-loop",
          params: { duration, sourceDuration: bed, ...(crossfade && { crossfade }) },
          step: { label: "Music loop", index: n, of: n },
        },
      });
      bedKey = "music-loop";
      bedStem = undefined;
    }
    if (models.level) {
      steps.push({
        key: "level",
        part: "music",
        label: "Music level",
        after: [bedKey],
        chain: [{ slot: "audio" }],
        request: { ...base, modelId: models.level, op: "level", params: { extra: { integrated_loudness: BED_LUFS } }, step: { label: "Music level", index: n, of: n } },
      });
      bedKey = "level";
    }
  }

  const muxDef = pick(lookup, models.mux);
  // A timeline mixer (fal compose) places every track for the film's length.
  const timeline = muxDef.routes.some((r) => r.op === "mux" && !!r.map?.tracks);
  const mixLabel = models.music ? "Mixing voice and music" : "Mixing";
  steps.push({
    key: "mix",
    part: "mix",
    label: mixLabel,
    seconds: length,
    after: models.music ? [film, "narration", bedKey] : [film, "narration"],
    chain: models.music ? [{ slot: "video" }, { slot: "audio" }, { slot: "audio2", ...(bedStem && { stem: bedStem }) }] : [{ slot: "video" }, { slot: "audio" }],
    request: {
      ...base,
      modelId: models.mux,
      op: "mux",
      params: { ...(timeline && { duration: length }), ...(muxDef.engine === "open" && models.music && { extra: { backgroundVolumeDb: BED_DB } }) },
      ...(!models.captions && { title: input.title }),
      step: { label: mixLabel, index: n, of: n },
    },
  });

  if (models.captions) {
    const words = models.captionsUseWords;
    const vertical = ar === "9:16";
    // A brief's caption style: where they sit and how many words show at once (the open burn-in has no centre).
    const cap = settings.brief?.captions;
    const per = cap?.words ? Math.max(1, Math.min(8, Math.round(cap.words))) : vertical ? 3 : 5;
    steps.push({
      key: "captions",
      part: "captions",
      label: "Subtitles",
      seconds: length,
      after: words ? ["mix", "words"] : ["mix"],
      chain: words ? [{ slot: "video" }, { slot: "prompt" }] : [{ slot: "video" }],
      request: {
        ...base,
        modelId: models.captions,
        op: "captions",
        title: input.title,
        params: words
          ? { extra: { fontSize: vertical ? 4 : 6, wordsPerCaption: per, ...(cap?.position && { captionPosition: cap.position === "top" ? "top" : "bottom" }) } }
          : { extra: { words_per_subtitle: per, ...(cap?.position && { position: cap.position }) } },
        step: { label: "Subtitles", index: n, of: n },
      },
    });
  }
  return steps;
}

/** The step whose output is the finished episode. */
export const finalKey = (graph: Pick<GraphStep, "key">[]) => (graph.some((s) => s.key === "captions") ? "captions" : "mix");

// ---------------------------------------------------------------------------
// "Regenerate to 1080p" (package n7-10; docs/research/new-models-7.md §2.10)

/** Keys of the regenerated film's steps (beside the episode's own). */
export const REGEN_PREFIX = "regen-";

export const FACELESS_REGEN_COPY = {
  label: "Regenerate to 1080p",
  hint: "Sharper, may redraw: each scene is redrawn at 1080p from its own words, then joined under the same voice and music.",
  /** The GPU time a visitor sees (no install detail). */
  time: (scenes: number) => `Runs on your GPU · about ${Math.max(1, Math.round(scenes * 1.5))} min`,
  done: "Regenerated (1080p)",
} as const;

/**
 * The regenerated film from an episode's graph: each clip (one scene, or one shot of it; never over 15 s) is redrawn by
 * Open-H3 Regenerate at 1080p with the 576p preset and start sigma 0.8, from the scene's own words (its picture's
 * prompt, and its motion for an animated scene); a 16 fps clip (Wan) goes through RIFE to 24 fps first. Then the clips
 * are joined the way the episode joins them, at 1080p, and the same narration, music bed and subtitles go on top: the
 * steps reuse the episode's narration, bed and timing (their keys stay as they are, for `existing`). `joinMax` is the
 * episode's fold size (resolveModels).
 */
export function regeneratePlan(graph: GraphStep[], o: { engine: Engine; joinMax: number; lookup: ModelLookup }): { steps: FinishStep[]; final: string } {
  const regen = ENGINE_MODELS[o.engine].regenerate;
  if (!regen) throw new Error("Regenerate runs on your GPU (open source): switch the episode to open source to use it");
  const byKey = new Map(graph.map((s) => [s.key, s]));
  const steps: FinishStep[] = [];
  const clips: string[] = [];
  for (const c of graph.filter((s) => s.part === "clip")) {
    const still = c.after?.length ? byKey.get(c.after[0]) : undefined;
    const words = [still?.request.prompt, c.request.op === "i2v" ? c.request.prompt : undefined].filter((w): w is string => !!w?.trim()).join(" ");
    const seconds = c.seconds ?? c.request.params?.duration ?? 5;
    const plan = regenFinishSteps({
      key: `${REGEN_PREFIX}${c.key}`,
      clip: { key: c.key },
      prompt: words || c.request.prompt || "",
      seconds,
      fps: sixteenFpsModel(c.request.modelId) ? 16 : undefined,
      draftFrom: "other",
      helper: { feature: c.request.feature, batchTitle: c.request.batchTitle },
      label: c.label,
    });
    steps.push(...plan.steps);
    clips.push(plan.final);
  }
  if (!clips.length) throw new Error("The episode has no scenes to regenerate");
  // The joins: the episode's own join model, folded the same way, at 1080p where it takes a size.
  const join = graph.find((s) => s.part === "join");
  let film = clips[0];
  if (join) {
    const sized = o.lookup(join.request.modelId)?.options.resolutions?.includes(REGEN_FINISH_TIER);
    const name = (k: string) => (clips.includes(k) ? k : `${REGEN_PREFIX}${k}`);
    for (const level of foldJoins(clips, o.joinMax)) {
      for (const j of level) {
        steps.push({
          key: name(j.key),
          request: { ...join.request, params: { ...join.request.params, ...(sized && { resolution: REGEN_FINISH_TIER }) }, step: { label: j.key === "join" ? "Joining the redrawn scenes" : "Joining scenes", index: 0, of: 1 } },
          after: j.after.map(name),
          chain: j.after.map(() => ({ slot: "videos" as const })),
        });
      }
    }
    if (clips.length > 1) film = `${REGEN_PREFIX}join`;
  }
  // The same voice, bed and subtitles as the episode.
  const mix = graph.find((s) => s.key === "mix");
  if (!mix) throw new Error("The episode has no mix to put on the redrawn scenes");
  const swap = (k: string) => (k === mix.after?.[0] ? film : k);
  steps.push({ key: `${REGEN_PREFIX}mix`, request: { ...mix.request, title: undefined }, after: (mix.after ?? []).map(swap), chain: mix.chain });
  const captions = graph.find((s) => s.key === "captions");
  if (captions) {
    steps.push({ key: `${REGEN_PREFIX}captions`, request: captions.request, after: (captions.after ?? []).map((k) => (k === "mix" ? `${REGEN_PREFIX}mix` : k)), chain: captions.chain });
  }
  const final = captions ? `${REGEN_PREFIX}captions` : `${REGEN_PREFIX}mix`;
  const last = steps.find((s) => s.key === final)!;
  last.request = { ...last.request, title: `${graph[0]?.request.batchTitle ?? "Episode"} · 1080p` };
  return { steps, final };
}

/** The episode steps a regenerated film reads as they are (its clips, narration, timing and bed). */
export function regenerateReuses(steps: FinishStep[]): string[] {
  const own = new Set(steps.map((s) => s.key));
  return [...new Set(steps.flatMap((s) => s.after ?? []).filter((k) => !own.has(k)))];
}

/** Keys that wait (directly or not) on any of `keys`. */
export function descendants(graph: Pick<GraphStep, "key" | "after">[], keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...keys];
  while (queue.length) {
    const k = queue.shift()!;
    for (const s of graph) {
      if (out.has(s.key) || !s.after?.includes(k)) continue;
      out.add(s.key);
      queue.push(s.key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timing: every scene cut to where its lines are spoken

/**
 * The steps rendered before the scenes are timed: the pictures, the narration and its word timings.
 * The clips (and everything after them) wait until the narration is timed (sceneTiming).
 */
export const TIMING_PARTS: ReadonlySet<StepPart> = new Set<StepPart>(["still", "narration", "words"]);

/** A scene is cut this long before the next one's lines start; the last one runs this long past its last word. */
export const SCENE_LEAD = 0.2;
export const SCENE_TAIL = 1;
/** A change keeps a scene's clips when its new length is within this of the old one (the next scene absorbs the rest). */
export const RETIME_TOLERANCE = 1;

/** A timed stretch of the narration: a word, a phrase or a caption line (transcript cues). */
export interface TimedText {
  start: number;
  end: number;
  text: string;
}

const token = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (s: string) => s.split(/\s+/).map(token).filter(Boolean);

/** Where the narration's blocks start (null: a block without lines) and where its last word ends, in seconds. */
export interface SpokenTimes {
  starts: (number | null)[];
  end: number;
}

/**
 * When each block's lines are spoken, from the narration's timings: the script's words matched in
 * order against the timed words (forced alignment gives every word; an ASR may hear some differently,
 * and those are interpolated). Null when the timings can't be this narration (fewer than half the
 * words match, e.g. a demo transcript).
 */
export function spokenTimes(blocks: Pick<ScriptBlock, "narration">[], cues: TimedText[]): SpokenTimes | null {
  const heard: { w: string; start: number; end: number }[] = [];
  for (const c of cues) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end < c.start || typeof c.text !== "string") continue;
    const ws = tokens(c.text);
    const step = (c.end - c.start) / Math.max(1, ws.length);
    ws.forEach((w, j) => heard.push({ w, start: c.start + step * j, end: c.start + step * (j + 1) }));
  }
  const script = blocks.flatMap((b, i) => tokens(b.narration).map((w) => ({ w, block: i })));
  if (!heard.length || !script.length) return null;
  const at: (number | null)[] = script.map(() => null);
  const endAt: (number | null)[] = script.map(() => null);
  let p = 0;
  for (let i = 0; i < script.length; i++) {
    for (let q = p; q < Math.min(heard.length, p + 6); q++) {
      if (heard[q].w !== script[i].w) continue;
      // Skipping heard words is only safe when the next word agrees too (a common word further on isn't a match).
      if (q > p && i + 1 < script.length && q + 1 < heard.length && heard[q + 1].w !== script[i + 1].w) continue;
      at[i] = heard[q].start;
      endAt[i] = heard[q].end;
      p = q + 1;
      break;
    }
  }
  const known = at.flatMap((t, i) => (t === null ? [] : [i]));
  if (known.length < Math.max(1, script.length * 0.5)) return null;
  const first = known[0];
  const last = known[known.length - 1];
  const pace = last > first ? (at[last]! - at[first]!) / (last - first) : 0.4;
  // Words nobody heard: in proportion between the words around them.
  let prev = -1;
  for (const k of known) {
    for (let i = prev + 1; i < k; i++) {
      at[i] = prev < 0 ? Math.max(0, at[k]! - (k - i) * pace) : at[prev]! + ((at[k]! - at[prev]!) * (i - prev)) / (k - prev);
    }
    prev = k;
  }
  for (let i = last + 1; i < script.length; i++) at[i] = at[last]! + (i - last) * pace;
  const starts: (number | null)[] = blocks.map(() => null);
  script.forEach((s, i) => {
    if (starts[s.block] === null) starts[s.block] = at[i];
  });
  const end = endAt[last]! + (script.length - 1 - last) * pace;
  return { starts, end };
}

/**
 * How many seconds of film each block gets: the span of its lines in the narration, made with the video
 * model's shots. Each scene is measured from where the film is so far, so a shot's rounding is absorbed
 * by the next scene and picture and voice stay together over the whole film. Blocks without lines keep
 * their own length (carved out of the scene before them). With `current` (a re-timing after a change),
 * a scene keeps its length — and its clips — when the new one is within RETIME_TOLERANCE.
 */
export function sceneTiming(blocks: ScriptBlock[], spoken: SpokenTimes, video: ModelDef | undefined, current?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  let film = 0;
  blocks.forEach((b, i) => {
    let want = b.seconds;
    if (spoken.starts[i] !== null) {
      let k = i + 1;
      let quiet = 0;
      while (k < blocks.length && spoken.starts[k] === null) quiet += blocks[k++].seconds;
      const until = k < blocks.length ? spoken.starts[k]! - SCENE_LEAD : spoken.end + SCENE_TAIL;
      want = until - quiet - film;
    }
    want = Math.max(MIN_BLOCK, want);
    const keep = current?.[b.id];
    const secs = keep !== undefined && keep >= MIN_BLOCK && Math.abs(keep - want) <= RETIME_TOLERANCE ? keep : filmSeconds(want, video);
    out[b.id] = secs;
    film += secs;
  });
  return out;
}

/** The planned lengths as film (no word timings to cut to). */
export const plannedTiming = (blocks: ScriptBlock[], video: ModelDef | undefined): Record<string, number> => Object.fromEntries(blocks.map((b) => [b.id, filmSeconds(b.seconds, video)]));

/** Blocks with their film lengths (once the narration is timed). */
export const withTiming = (blocks: ScriptBlock[], timing: Record<string, number> | undefined): ScriptBlock[] =>
  timing ? blocks.map((b) => (timing[b.id] !== undefined ? { ...b, seconds: timing[b.id] } : b)) : blocks;

/** Where each scene sits in the film, from the graph's clips (what the film really is). */
export function sceneSpans(graph: Pick<GraphStep, "part" | "block" | "seconds">[], count: number): { start: number; seconds: number }[] {
  const secs = Array.from({ length: count }, () => 0);
  for (const s of graph) if (s.part === "clip" && s.block !== undefined && s.block < count) secs[s.block] += s.seconds ?? 0;
  let t = 0;
  return secs.map((seconds) => {
    const start = t;
    t += seconds;
    return { start, seconds };
  });
}

// ---------------------------------------------------------------------------
// Changes (timeline editor) and retries

export type ChangePart = "picture" | "motion" | "narration";

/** The steps a change touches directly; everything downstream re-runs too. */
export function changedKeys(graph: GraphStep[], blockIds: string[], part: ChangePart): string[] {
  if (part === "narration") return ["narration"];
  const inBlocks = (s: GraphStep) => s.block !== undefined && blockIds.some((id) => s.key === `still-${id}` || s.key.startsWith(`clip-${id}-`));
  return graph.filter((s) => inBlocks(s) && (part === "picture" || s.part === "clip")).map((s) => s.key);
}

export interface RerunPlan {
  /** Steps to create again, in graph order. */
  rerun: string[];
  /** Steps whose current generation is kept. */
  reuse: string[];
}

/**
 * What a change re-runs: the changed steps and everything after them (the joins up the branch, the mix,
 * the subtitles). The other blocks keep their generations.
 */
export function planRerun(graph: GraphStep[], changed: string[]): RerunPlan {
  const dirty = new Set([...changed, ...descendants(graph, changed)]);
  return { rerun: graph.filter((s) => dirty.has(s.key)).map((s) => s.key), reuse: graph.filter((s) => !dirty.has(s.key)).map((s) => s.key) };
}

/**
 * A retry: the steps that failed (or were never made, or whose request changed) and everything waiting
 * on them. `status` maps a key to its generation's status (missing = never made).
 */
export function planRetry(graph: GraphStep[], status: Record<string, string | undefined>): RerunPlan {
  const broken = graph.filter((s) => !status[s.key] || status[s.key] === "failed" || status[s.key] === "canceled").map((s) => s.key);
  return planRerun(graph, broken);
}

/** What a kept step's generation was asked for (its stored request). */
export type MadeRequest = Pick<GenerationRequest, "modelId" | "op" | "params">;

/**
 * Whether a bed (or its loop) made with `had` still serves a film that now needs `want`. It has to cover the
 * film; a whole-play loop (cloud) covers its plays of the bed, whatever length was asked (the route plays
 * ⌈duration / bed⌉ times, at least twice). A crossfaded loop (open) fades out at its end, so one left longer
 * than the film by a second or more is made again: its fade-out would fall past the end and the music stop dead.
 */
export function bedFits(had: GenerationRequest["params"], want: GenerationRequest["params"]): boolean {
  const h = had?.duration ?? 0;
  const w = want?.duration ?? 0;
  if (want?.crossfade) return h >= w && h - w < 1 && had?.crossfade === want.crossfade;
  if (want?.sourceDuration && had?.sourceDuration) return Math.max(2, Math.ceil(h / had.sourceDuration - 1e-6)) * had.sourceDuration >= w;
  return h >= w;
}

/**
 * Steps whose kept generation isn't what the graph asks for now, to make again with everything after them:
 * made by another model or operation (a Frame by frame episode rendered before its scenes became Ken Burns
 * moves still holds video-model clips, of other lengths, under the same keys), a clip of another length, or
 * a music bed that no longer serves the film (bedFits).
 */
export function staleSteps(graph: GraphStep[], made: (key: string) => MadeRequest | undefined): string[] {
  return graph
    .filter((s) => {
      const r = made(s.key);
      if (!r) return false;
      if (r.modelId !== s.request.modelId || (r.op ?? null) !== (s.request.op ?? null)) return true;
      if (s.part === "clip") return (r.params?.duration ?? null) !== (s.request.params?.duration ?? null);
      if (s.part === "music" && s.request.params?.duration !== undefined) return !bedFits(r.params, s.request.params);
      return false;
    })
    .map((s) => s.key);
}

/** Whether two Ken Burns requests make the same camera move (a Motion change that reads as the move a scene has). */
export function sameCameraMove(a: MadeRequest, b: MadeRequest): boolean {
  const pa = a.params ?? {};
  const pb = b.params ?? {};
  const pt = (p?: { x: number; y: number }) => (p ? `${p.x},${p.y}` : "");
  return (
    a.modelId === b.modelId &&
    a.op === b.op &&
    pa.duration === pb.duration &&
    pa.zoomFrom === pb.zoomFrom &&
    pa.zoomTo === pb.zoomTo &&
    pt(pa.panFrom) === pt(pb.panFrom) &&
    pt(pa.panTo) === pt(pb.panTo) &&
    pa.easing === pb.easing
  );
}

/** The camera words a Frame by frame Motion change reads, per engine (the cloud's Ken Burns only zooms). */
export const CAMERA_WORDS: Record<Engine, { placeholder: string; hint: string; same: string }> = {
  open: {
    placeholder: "e.g. slow zoom out, pan left toward the tower",
    hint: "The picture is kept; the camera moves again: zoom in or out, pan left or right, tilt up or down, toward a place you name.",
    same: "That's the camera move this scene already has. Name another: zoom in or out, pan left or right, tilt up or down, or a place to head for (the upper left, the sky).",
  },
  cloud: {
    placeholder: "e.g. zoom out, or zoom in toward the upper left",
    hint: "The picture is kept; the camera moves again: a zoom in or out, toward a place you name.",
    same: "That's the camera move this scene already has. Name another: zoom in or zoom out, or a place to head for (the upper left, the sky).",
  },
};

// ---------------------------------------------------------------------------
// Cost

/**
 * What one step costs: "per 1k chars" prices are per thousand characters of the script (not per request),
 * per-second video prices follow the resolution, and per-second or per-minute tools (soundtrack, subtitles)
 * are priced for the `seconds` of film they cover.
 */
export function stepCostUsd(model: ModelDef | undefined, request: GenerationRequest, seconds?: number): number | null {
  if (!model) return null;
  if (model.engine === "open") return 0;
  // A launch price while it lasts (./promo): read when the episode is priced.
  const p = model.pricing && pricingAt(model.pricing);
  if (!p) return null;
  const params = { ...model.defaults, ...request.params, ...(seconds !== undefined && (p.unit === "second" || p.unit === "minute") && { duration: seconds }) };
  if (p.unit === "request" && /per 1k char/i.test(p.note ?? "")) {
    const chars = request.prompt?.length ?? 0;
    return Math.round(p.usd * Math.max(1, Math.ceil(chars / 1000)) * 1000) / 1000;
  }
  const table = PRICE_PER_SECOND[model.id];
  if (p.unit === "second" && table && params.resolution && table[params.resolution] !== undefined) {
    return Math.round(table[params.resolution] * (params.duration ?? 5) * 1000) / 1000;
  }
  return estimateCost(model, params, 1);
}

export interface CostBreakdown {
  total: number;
  /** Per part: stills, clips, narration… (null = a model with no published price). */
  parts: Partial<Record<StepPart, number>>;
  unknown: boolean;
}

export function estimateGraph(graph: GraphStep[], lookup: ModelLookup, only?: Iterable<string>): CostBreakdown {
  const keep = only ? new Set(only) : null;
  const parts: Partial<Record<StepPart, number>> = {};
  let total = 0;
  let unknown = false;
  for (const s of graph) {
    if (keep && !keep.has(s.key)) continue;
    const c = stepCostUsd(lookup(s.request.modelId), s.request, s.seconds);
    if (c === null) {
      unknown = true;
      continue;
    }
    parts[s.part] = Math.round(((parts[s.part] ?? 0) + c) * 1000) / 1000;
    total += c;
  }
  return { total: Math.round(total * 100) / 100, parts, unknown };
}

/** Blocks for an estimate before the script exists: the target length in 10-second blocks (or `sceneSeconds`). */
export function placeholderBlocks(seconds: number, sceneSeconds = BLOCK_SECONDS): ScriptBlock[] {
  return planBlocks(seconds, sceneSeconds).map((secs, i) => {
    const words = Math.floor(secs * WRITE_WORDS_PER_SECOND);
    return { id: `p${i}`, narration: Array.from({ length: words }, () => "word").join(" "), visual: "A scene", motion: DEFAULT_MOTION, seconds: secs };
  });
}

export const PART_LABELS: Record<StepPart, string> = {
  still: "Pictures",
  clip: "Animation",
  join: "Joining",
  narration: "Narration",
  music: "Music",
  mix: "Mixing",
  words: "Timing",
  captions: "Subtitles",
};

// ---------------------------------------------------------------------------
// Writing: briefs for the LLM, parsers for its answers, and the offline writer

export interface TopicIdea {
  title: string;
  hook: string;
}

export const topicsSystem = `You suggest episode topics for a faceless YouTube channel (one narrator over illustrated scenes).
Reply with JSON only: {"topics": [{"title": string, "hook": string}]}.
- title: a specific, clickable episode title (under 70 characters), not generic.
- hook: one sentence on why someone would watch it.
- Every topic fits the channel and its genre, and they differ from each other.`;

/**
 * The answers' JSON as JSON Schemas, for local models that decode to one (Ollama, LM Studio,
 * Unsloth Studio); they match the prompts, which still ask for the same JSON.
 */
const objectOf = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const listOf = (items: unknown, min: number, max: number) => ({ type: "array", items, minItems: min, maxItems: max });
const STRING = { type: "string" };

export const topicsSchema = (count: number) => ({ name: "topics", schema: objectOf({ topics: listOf(objectOf({ title: STRING, hook: STRING }), count, count) }) });

export function topicsBrief(o: { idea: string; genre: GenreInfo; count: number; avoid?: string[]; reference?: string }): string {
  return [
    `Channel: ${o.idea}`,
    `Genre: ${o.genre.label} — ${o.genre.hint}. Tone: ${o.genre.tone}.`,
    o.reference ? `The channel takes after: ${o.reference}` : "",
    o.avoid?.length ? `Already suggested (don't repeat): ${o.avoid.join("; ")}` : "",
    `Suggest ${o.count} topics.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The first JSON object or array in a reply (models wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start < 0) continue;
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function parseTopics(text: string): TopicIdea[] {
  const j = extractJson(text) as { topics?: unknown } | unknown[] | null;
  const list = Array.isArray(j) ? j : Array.isArray((j as { topics?: unknown })?.topics) ? ((j as { topics: unknown[] }).topics as unknown[]) : [];
  return list
    .map((t) => (typeof t === "string" ? { title: t, hook: "" } : (t as Partial<TopicIdea>)))
    .filter((t): t is TopicIdea => typeof t?.title === "string" && !!t.title.trim())
    .map((t) => ({ title: t.title.trim().slice(0, 140), hook: (t.hook ?? "").toString().trim().slice(0, 240) }));
}

/** "Channel about survival in the wild" → "survival in the wild". */
export function subjectOf(idea: string): string {
  const s = idea
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^(a |an |my )?(youtube )?channel\s+(about|with|on|for|of)\s+/i, "")
    .replace(/^(please\s+)?(explain|describe|tell (me|us) about|show (me|us)|teach (me|us)( about)?)\s+(to (me|us|kids)\s+)?/i, "")
    .replace(/^(about|on)\s+/i, "")
    .trim()
    // "The untold beginning of …" reads as a noun phrase mid-sentence.
    .replace(/^(The|A|An) /, (m) => m.toLowerCase());
  return s || "your subject";
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A channel name from the idea (when no LLM is connected). */
export function channelName(idea: string): string {
  const s = subjectOf(idea)
    .replace(/^(daily|weekly)\s+/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .map((w, i) => (i > 0 && /^(a|an|the|of|in|and|or|for|to|on|at|with)$/i.test(w) ? w.toLowerCase() : capital(w)))
    .join(" ");
  return s.length > 48 ? `${s.slice(0, 47)}…` : s || "My channel";
}

const OFFLINE_TOPICS: Record<FacelessGenre, [string, string][]> = {
  education: [
    ["How {s} really works", "The simple idea behind it, step by step."],
    ["5 surprising facts about {s}", "Things most people get wrong."],
    ["The science behind {s}", "What's actually happening, explained with pictures."],
    ["Myths about {s}, busted", "What's true, what isn't, and why."],
    ["{S} explained in three minutes", "Everything you need, nothing you don't."],
    ["What nobody tells you about {s}", "The part the textbooks skip."],
    ["The biggest mistakes people make with {s}", "And the easy way to avoid them."],
    ["Where {s} came from", "The origin story, in plain words."],
    ["{S}: a beginner's guide", "Start here if you know nothing yet."],
    ["Why {s} matters more than you think", "The everyday impact, made visible."],
    ["The future of {s}", "What changes next, and what stays."],
    ["{S} by the numbers", "The figures that tell the real story."],
  ],
  history: [
    ["The untold beginning of {s}", "Where it really started."],
    ["The day that changed {s} forever", "One moment, and everything after it."],
    ["How {s} shaped the world", "The ripple effects we still live with."],
    ["The rise and fall of {s}", "From the first spark to the end."],
    ["{S}: the mystery historians still argue about", "The evidence, and the theories."],
    ["A day in the life during {s}", "What it was really like to be there."],
    ["The forgotten people of {s}", "Names that deserve to be remembered."],
    ["The biggest mistake in the history of {s}", "One decision, and its price."],
    ["{S} in five turning points", "The moments that decided everything."],
    ["What really caused {s}?", "The causes behind the headlines."],
    ["Myths and truths about {s}", "Separating legend from the record."],
    ["The legacy of {s}", "What it left behind, and where to see it today."],
  ],
  kids: [
    ["Let's learn about {s}!", "A bright, friendly first look."],
    ["{S} for little explorers", "Big questions, simple answers."],
    ["A song about {s}", "Sing along and remember it."],
    ["Why is {s} so amazing?", "Fun facts to share at dinner."],
    ["Counting with {s}", "One, two, three — let's go!"],
    ["Bedtime story: {s}", "A calm story to end the day."],
    ["The colours of {s}", "Spot every colour together."],
    ["{S}: true or false?", "A fun quiz with big surprises."],
    ["A day with {s}", "Follow along from morning to night."],
    ["Let's draw {s}!", "Easy shapes, step by step."],
    ["The ABCs of {s}", "A letter for every fun fact."],
    ["Super silly facts about {s}", "Giggles guaranteed."],
  ],
  storytelling: [
    ["The legend of {s}", "An old tale, told from the beginning."],
    ["A stranger arrives: a story of {s}", "One visitor changes everything."],
    ["The last secret of {s}", "Some secrets are kept for a reason."],
    ["{S}: a story told in one night", "From dusk to dawn, one story."],
    ["The map that led to {s}", "A journey nobody expected to finish."],
    ["When {s} came back", "Some things don't stay gone."],
    ["The keeper of {s}", "Someone has guarded it for a hundred years."],
    ["The promise of {s}", "A vow that could not be broken."],
    ["Lost in {s}", "Finding the way home took everything."],
    ["The thief who stole {s}", "A heist nobody saw coming."],
    ["One stormy night: {s}", "One night, one choice, one storm."],
    ["The final chapter of {s}", "How it all ends."],
  ],
};

const fill = (t: string, s: string) => t.replaceAll("{S}", capital(s)).replaceAll("{s}", s);

/**
 * Topic suggestions without an LLM: 12 templates per genre around the channel's subject. Titles in
 * `avoid` (the ones already shown) are left out, so "Generate new" brings new ones until the templates
 * run out; without `avoid`, each round pages on by `count`.
 */
export function offlineTopics(idea: string, genre: FacelessGenre, count = 5, round = 0, avoid: string[] = []): TopicIdea[] {
  const s = subjectOf(idea);
  // "The rise and fall of {s}" for a channel about the rise and fall of empires would say it twice.
  const lead = (t: string) => t.split("{")[0].replace(/^the\s+/i, "").trim().toLowerCase();
  const all = (OFFLINE_TOPICS[genre] ?? OFFLINE_TOPICS.education)
    .filter(([t]) => !lead(t) || !s.toLowerCase().includes(lead(t)))
    .map(([title, hook]) => ({ title: fill(title, s), hook }));
  const seen = new Set(avoid.map((t) => t.trim().toLowerCase()));
  const fresh = all.filter((t) => !seen.has(t.title.toLowerCase()));
  const n = Math.min(count, all.length);
  if (!seen.size) {
    const start = (round * count) % all.length;
    return Array.from({ length: n }, (_, i) => all[(start + i) % all.length]);
  }
  // Every template shown already: start over with the ones shown longest ago.
  return [...fresh, ...all.filter((t) => seen.has(t.title.toLowerCase()))].slice(0, n);
}

export const scriptSystem = `You write scripts for faceless videos: one narrator speaking over illustrated scenes, no presenter on camera.
Reply with JSON only: {"title": string, "scenes": [{"narration": string, "visual": string, "motion": string}]}.
- narration: only the words the narrator says (no stage directions, no scene numbers); the scenes read as one continuous voice-over.
- visual: one or two sentences describing the illustration for the scene: subject, setting, composition. Never ask for text, letters or captions in the picture.
- motion: a few words on what moves and how the camera moves.
- Keep each scene's narration within its word limit, so the voice fits the scene.
- Start with a hook in the first scene; end with a short, satisfying close.`;

/** `scenes` null: the length decides itself (4 to 12 scenes, as the brief says). */
export const scriptSchema = (scenes: number | null) => ({
  name: "script",
  schema: objectOf({ title: STRING, scenes: listOf(objectOf({ narration: STRING, visual: STRING, motion: STRING }), scenes ?? 4, scenes ?? 12) }),
});

export interface ScriptBrief {
  topic: string;
  genre: GenreInfo;
  /** Number of scenes and the word limit for each. */
  scenes: number;
  wordsPerScene: number;
  channel?: string;
  styleName?: string;
  elements?: { handle: string; kind: string; description?: string | null }[];
  reference?: string;
  /** Source material (documents, summarised links). */
  sources?: string[];
  /** Explainer: the length decides itself. */
  auto?: boolean;
  subtitles?: boolean;
  /** Content Factory: the reference's style brief (format, hook, pacing, shots, tone). */
  style?: string[];
}

export function scriptBrief(b: ScriptBrief): string {
  const els = b.elements?.length
    ? `These characters and places can appear; write their @handle in the visual whenever they do: ${b.elements.map((e) => `@${e.handle} (${e.kind}${e.description ? `: ${e.description}` : ""})`).join(", ")}.`
    : "";
  return [
    `Topic: ${b.topic}`,
    b.channel ? `Channel: ${b.channel}` : "",
    `Genre: ${b.genre.label} — ${b.genre.hint}. Tone: ${b.genre.tone}.`,
    b.styleName ? `The pictures are drawn as ${b.styleName}.` : "",
    b.auto
      ? `Use as many scenes as the topic needs: between 4 and 12, each at most ${b.wordsPerScene} words of narration.`
      : `Write exactly ${b.scenes} scenes, each at most ${b.wordsPerScene} words of narration (about ${Math.max(MIN_BLOCK, Math.round(b.wordsPerScene / WRITE_WORDS_PER_SECOND))} seconds spoken).`,
    els,
    b.reference ? `Match the pacing and tone of: ${b.reference}` : "",
    b.style?.length ? `Follow this style brief:\n${b.style.map((l) => `- ${l}`).join("\n")}` : "",
    b.sources?.length ? `Base the facts on these sources:\n${b.sources.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pictures and motion for a pasted script, numbered line by line. */
export const visualsSystem = `You plan the pictures for a narrated faceless video. The user sends numbered narration lines "[n] text".
Reply with JSON only: {"scenes": [{"n": number, "visual": string, "motion": string}]}, one per line, in order.
- visual: one or two sentences describing the illustration for that line: subject, setting, composition. No text in the picture.
- motion: a few words on what moves and how the camera moves.`;

export const visualsSchema = (count: number) => ({ name: "visuals", schema: objectOf({ scenes: listOf(objectOf({ n: { type: "integer" }, visual: STRING, motion: STRING }), count, count) }) });

export const visualsBrief = (blocks: Pick<ScriptBlock, "narration">[], styleName: string, topic: string) =>
  [`Topic: ${topic}`, `Style: ${styleName}`, ...blocks.map((b, i) => `[${i + 1}] ${b.narration}`)].join("\n");

export function parseVisuals(text: string, count: number): { visual: string; motion: string }[] | null {
  const j = extractJson(text) as { scenes?: unknown } | unknown[] | null;
  const list = (Array.isArray(j) ? j : (j as { scenes?: unknown[] })?.scenes) as { n?: number; visual?: string; motion?: string }[] | undefined;
  if (!Array.isArray(list)) return null;
  const out = Array.from({ length: count }, (_, i) => {
    const s = list.find((x) => Number(x?.n) === i + 1) ?? list[i];
    return typeof s?.visual === "string" && s.visual.trim() ? { visual: s.visual.trim(), motion: (s.motion ?? "").toString().trim() } : null;
  });
  return out.every(Boolean) ? (out as { visual: string; motion: string }[]) : null;
}

export interface ParsedScript {
  title: string | null;
  blocks: ScriptBlock[];
}

/** The LLM's answer as blocks; prose without JSON is used as a pasted script. */
export function parseScript(text: string): ParsedScript | null {
  const j = extractJson(text) as { title?: unknown; scenes?: unknown } | unknown[] | null;
  const scenes = (Array.isArray(j) ? j : (j as { scenes?: unknown })?.scenes) as Partial<ScriptBlock>[] | undefined;
  if (Array.isArray(scenes)) {
    const blocks = normalizeBlocks(
      scenes
        .filter((s) => s && typeof s === "object" && typeof s.narration === "string" && s.narration.trim())
        .map((s) => ({ narration: String(s.narration), visual: typeof s.visual === "string" ? s.visual : "", motion: typeof s.motion === "string" ? s.motion : "" })),
    );
    if (blocks.length) {
      const title = !Array.isArray(j) && typeof (j as { title?: unknown })?.title === "string" ? String((j as { title: string }).title).trim() : null;
      return { title: title || null, blocks };
    }
  }
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();
  if (wordCount(prose) >= 8 && !/^\s*[[{]/.test(prose)) return { title: null, blocks: splitScript(prose) };
  return null;
}

const BEATS: Record<FacelessGenre, { narration: string; visual: string }[]> = {
  education: [
    { narration: "Today's question: {s}. In the next few minutes, it will all make sense.", visual: "An intriguing establishing picture about {s}, seen from a surprising angle" },
    { narration: "Let's start with the basics, and why this matters more than you might think.", visual: "A simple diagram-like picture introducing {s}" },
    { narration: "Here is the first key idea. Once you see it, the rest starts to click.", visual: "A close-up that highlights the first key part of {s}" },
    { narration: "Now add the second piece. This is where most people get confused, so let's slow down.", visual: "Two parts of {s} side by side, showing how they connect" },
    { narration: "Put together, these pieces explain something you see every day.", visual: "An everyday scene connected to {s}" },
    { narration: "So that's the answer, in a nutshell. Now you know more than most people do.", visual: "A satisfying wide picture that sums up {s}" },
  ],
  history: [
    { narration: "This is the story of {s}, and it begins long before most people think.", visual: "A sweeping historical landscape where the story of {s} begins" },
    { narration: "At first, nobody could have guessed how important it would become.", visual: "Ordinary people going about their day in the early days of {s}" },
    { narration: "Then, one decision changed everything.", visual: "A tense meeting of leaders around a table, candlelight" },
    { narration: "The consequences spread further and faster than anyone expected.", visual: "A map-like scene showing the influence of {s} spreading" },
    { narration: "Not everyone welcomed the change, and the struggle that followed would last for years.", visual: "Two opposing groups facing each other across a field" },
    { narration: "Today, the traces of {s} are still all around us, if you know where to look.", visual: "Modern people walking past ruins and monuments linked to {s}" },
  ],
  kids: [
    { narration: "Hello, friends! Today we're going on an adventure to learn all about {s}!", visual: "A cheerful friendly character waving hello in front of {s}" },
    { narration: "Look closely. What can you see? Let's count the colours together!", visual: "A bright, colourful close-up of {s}" },
    { narration: "Did you know? {S} can do something really, really amazing.", visual: "A delightful surprising moment about {s}" },
    { narration: "Let's try it ourselves. Ready? One, two, three!", visual: "Happy children playing and exploring {s}" },
    { narration: "Wow, you did it! You learned so much today.", visual: "A celebration with confetti and smiling friends" },
    { narration: "See you next time, little explorers. Bye-bye!", visual: "The friendly character waving goodbye at sunset" },
  ],
  storytelling: [
    { narration: "Long ago, in a place nobody remembers, there was a story about {s}.", visual: "A misty, mysterious opening scene of a faraway land tied to {s}" },
    { narration: "Our hero had no idea that a single choice would change their life.", visual: "A lone hero standing at a crossroads at dusk" },
    { narration: "The path ahead was dark, and every step brought a new danger.", visual: "The hero walking through a dark, winding forest path" },
    { narration: "Then came the moment of truth. There was no turning back.", visual: "A dramatic confrontation lit by a single glowing light" },
    { narration: "When the dust settled, nothing would ever be the same again.", visual: "Dawn breaking over a changed landscape" },
    { narration: "And that is why, to this day, people still whisper the legend of {s}.", visual: "Villagers telling the story around a warm fire at night" },
  ],
};

/** A demo-quality script without an LLM: the genre's beats around the topic, as many scenes as asked. */
export function offlineScript(topic: string, genre: FacelessGenre, scenes: number): ScriptBlock[] {
  const s = subjectOf(topic).replace(/[.!?]+$/, "");
  const beats = BEATS[genre] ?? BEATS.education;
  const n = Math.max(1, scenes);
  return normalizeBlocks(
    Array.from({ length: n }, (_, i) => {
      // First and last beats open and close; the middle ones repeat as needed.
      const beat = i === 0 ? beats[0] : i === n - 1 && n > 1 ? beats[beats.length - 1] : beats[1 + ((i - 1) % (beats.length - 2))];
      return { narration: fill(beat.narration, s), visual: fill(beat.visual, s), motion: DEFAULT_MOTION };
    }),
  );
}

export const OFFLINE_NOTE = "Written offline — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings for a real script.";

// ---------------------------------------------------------------------------
// Validation the wizard and the API share

/** A YouTube channel, video or playlist link (research: Reference). */
export function youtubeKind(url: string): "channel" | "video" | "playlist" | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return u.pathname.length > 1 ? "video" : null;
  if (host !== "youtube.com" && host !== "music.youtube.com") return null;
  if (u.pathname === "/playlist" && u.searchParams.get("list")) return "playlist";
  if ((u.pathname === "/watch" && u.searchParams.get("v")) || /^\/(shorts|live|embed)\/[\w-]+/.test(u.pathname)) return "video";
  if (/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/.test(u.pathname)) return "channel";
  return null;
}

export const YOUTUBE_ERROR = "That does not look like a YouTube channel, video or playlist link.";

/** Explainer duration → seconds (null = Auto). Throws the research's message for a bad manual value. */
export function explainerSeconds(value: number | "auto"): number | null {
  if (value === "auto") return null;
  if (!Number.isInteger(value) || value < EXPLAINER_MIN || value > EXPLAINER_MAX) throw new Error("Duration must be Auto or a whole number of seconds between 15 and 600");
  return value;
}

/** Which narrator voice a channel or episode starts with. */
export const defaultVoice = (engine: Engine, genre: GenreInfo, explainer = false): NarratorVoice | null =>
  engine === "open" ? null : { kind: "preset", id: explainer ? "XrExE9yKIg1WjnnlVkGX" : genre.voice };

/** Settings a new episode starts with. */
export function defaultSettings(engine: Engine, genre: GenreInfo, o: { explainer?: boolean } = {}): EpisodeSettings {
  return {
    engine,
    length: o.explainer ? AUTO_SECONDS : 60,
    animation: "animated",
    aspect: "16:9",
    subtitles: true,
    // A music bed is on by default, as on Higgsfield (both engines mix it under the voice).
    music: true,
    styleId: genre.style,
    styleRefs: [],
    voice: defaultVoice(engine, genre, o.explainer),
    elements: [],
  };
}

/** Narrator voices and video model choices for the browser (built on the server, so the client needs no catalog). */
export interface PickerData {
  voices: { id: string; name: string; hint?: string }[];
  videoModels: { id: string; name: string; engine: Engine; resolutions: string[] }[];
  /** The music bed's models per engine, each with the longest bed it makes in one go (seconds; longer films loop it). */
  musicModels?: { id: string; name: string; engine: Engine; maxSeconds: number }[];
  /** Frame by frame's camera move per engine (Ken Burns) and the qualities it renders at (none: the still's own size). */
  cameraMoves?: Record<Engine, { id: string; name: string; resolutions: string[] }>;
  /** How many style references each engine's picture model reads (the open one takes 2). */
  maxStyleRefs: Record<Engine, number>;
}

/** Style references an engine's picture model reads. */
export const styleRefLimit = (engine: Engine, lookup: ModelLookup) => Math.min(MAX_STYLE_REFS, lookup(ENGINE_MODELS[engine].styleStill)?.options.maxImages ?? MAX_STYLE_REFS);

export function pickerData(lookup: ModelLookup): PickerData {
  const voices = lookup(ENGINE_MODELS.cloud.narration)?.options.voices ?? [];
  const videoModels = (["cloud", "open"] as const).flatMap((engine) =>
    ENGINE_MODELS[engine].videoChoices.flatMap((id) => {
      const m = lookup(id);
      return m ? [{ id, name: m.name, engine, resolutions: m.options.resolutions ?? [] }] : [];
    }),
  );
  const musicModels = (["cloud", "open"] as const).flatMap((engine) =>
    ENGINE_MODELS[engine].musicChoices.flatMap((id) => {
      const m = lookup(id);
      const max = MUSIC_MAX[id] ?? Math.max(...(m?.options.durations ?? [0]));
      return m && max > 0 ? [{ id, name: m.name.replace(/ · both engines$/, ""), engine, maxSeconds: max }] : [];
    }),
  );
  const camera = (engine: Engine) => {
    const id = ENGINE_MODELS[engine].kenBurns;
    return { id, name: lookup(id)?.name ?? "Ken Burns", resolutions: lookup(id)?.options.resolutions ?? [] };
  };
  return {
    voices: voices.map((v) => ({ id: v.id, name: v.name, ...(v.hint && { hint: v.hint }) })),
    videoModels,
    musicModels,
    cameraMoves: { cloud: camera("cloud"), open: camera("open") },
    maxStyleRefs: { cloud: styleRefLimit("cloud", lookup), open: styleRefLimit("open", lookup) },
  };
}

/** What the music switch does on each engine (settings, the Explainer's popover). */
/**
 * "Use a clip's soundtrack as the bed" (open engine): DBS splits the clip's sound, its music and effects (the talking
 * taken out) loop under the voice with crossfaded seams, at the same level as a made bed (BED_DB). The cloud has no
 * hosted DBS, so it makes the music instead.
 */
export const CLIP_BED_LABEL = "Use a clip's soundtrack as the bed";
export const CLIP_BED_HINT: Record<Engine, string> = {
  open: "Its music and effects, with the talking taken out, under the voice. A short clip loops with a soft crossfade.",
  cloud: "Runs on your GPU (open source). In the cloud the music is made for the film.",
};
/** Clip lengths a bed can come from: long enough for a crossfaded loop, at most as long as the longest film. */
export const CLIP_BED_MIN = 5;
/** Cuts a clip longer than the film to its length (and a second) before the split: the open audio timeline (core nodes, CPU). */
export const CLIP_BED_CUT_MODEL = "oss-audio-timeline";
export const CLIP_BED_MAX = 600;
const CLIP_BED_AUDIO = /[.](wav|mp3|flac|m4a|aac|ogg|opus)([?]|$)/i;

/** The clip whose soundtrack is the bed, when this episode uses one (open engine, music on), else null. */
export function clipBedFor(settings: Pick<EpisodeSettings, "engine" | "music" | "bedClip">): BedClip | null {
  const c = settings.bedClip;
  return settings.engine === "open" && settings.music && c?.url && c.seconds >= CLIP_BED_MIN ? c : null;
}

export const MUSIC_HINT: Record<Engine, string> = {
  cloud: "An instrumental bed under the voice, as long as the film (Sonilo makes up to 10 minutes; past that it plays again)",
  open: "An instrumental bed under the voice (ACE-Step); past 4 minutes it loops with a soft crossfade",
};

/** A short line the narrator reads for a voice preview. */
export const previewLine = (name: string) => `Hi, I'm ${name}. I'll be narrating your episode — here's how I sound.`;

// ---------------------------------------------------------------------------
// What the API sends (shared by the server module and the client hooks)

export interface ChannelReference {
  url: string;
  kind: "channel" | "video" | "playlist";
  title?: string;
  author?: string;
  /** The link's thumbnail, saved as an upload (offered as a style reference). */
  thumbnail?: string;
}

/** Saved on the channel so every episode looks and sounds the same. */
export type ChannelSettings = Pick<EpisodeSettings, "engine" | "styleId" | "styleRefs" | "voice" | "aspect" | "subtitles" | "music" | "animation" | "length" | "brief">;

export interface FacelessChannel {
  id: string;
  name: string;
  idea: string;
  genre: FacelessGenre;
  avatarUrl: string | null;
  /** An avatar being drawn (it becomes avatarUrl once it's done, whoever is watching). */
  avatarJob: string | null;
  reference: ChannelReference | null;
  settings: ChannelSettings;
  createdAt: number;
  updatedAt: number;
  /** Lists: how many episodes, and the newest finished one's poster. */
  episodes?: number;
  cover?: Generation | null;
}

export type EpisodeStatus = "writing" | "write-failed" | "review" | "rendering" | "done" | "failed";

export interface EpisodeScript {
  title?: string;
  blocks: ScriptBlock[];
  /** Written without an LLM (a demo-quality draft), and why. */
  offline?: boolean;
  note?: string;
  source: "ai" | "pasted";
}

/** A source the Explainer read: an image (a reference for the pictures), a document's text, or a summarised link. */
export type ExplainerSource = { kind: "image"; url: string; name?: string } | { kind: "text"; name: string; text: string } | { kind: "link"; url: string; title?: string; text: string };

export interface EpisodeChange {
  at: number;
  blocks: string[];
  part: ChangePart;
  instruction: string;
  costUsd: number | null;
  /** Undone (the version before it is back). */
  undone?: boolean;
}

export type StillEdits = Record<string, { source: string; instruction: string }>;

export interface EpisodePlan {
  batchId: string;
  /** Step key → the generation that made it (the current version). */
  ids: Record<string, string>;
  /** Picture edits the current version was made with. */
  stillEdits?: StillEdits;
  /** Each scene's length in the film, cut to where its lines are spoken (set once the narration is timed). */
  timing?: Record<string, number>;
  /** The scenes follow the planned lengths: the narration's timings couldn't be read (a demo transcript, say). */
  untimed?: boolean;
  /**
   * The pictures, the narration and its timing are rendering; the clips, joins, music, mix and subtitles
   * are created once the narration is timed (stage two).
   */
  awaiting?: boolean;
  /** The version before the last change (Undo). */
  previous?: { ids: Record<string, string>; blocks: ScriptBlock[]; stillEdits?: StillEdits; timing?: Record<string, number>; untimed?: boolean; awaiting?: boolean };
  /** The last finished film, shown while a change renders. */
  lastFinal?: string;
  /** "Upscale to 1080p": the upscaled copy of the finished film. */
  upscaled?: string;
  /** "Regenerate to 1080p" (open engine): its steps by key, and the finished film's generation. */
  regenerated?: { ids: Record<string, string>; final: string };
  changes: EpisodeChange[];
}

export interface FacelessEpisode {
  id: string;
  channelId: string | null;
  kind: "faceless" | "explainer";
  title: string;
  topic: string;
  status: EpisodeStatus;
  error: string | null;
  settings: EpisodeSettings;
  script: EpisodeScript;
  plan: EpisodePlan | null;
  sources: ExplainerSource[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StepView {
  key: string;
  part: StepPart;
  block?: number;
  label: string;
  generation: Generation | null;
}

export interface EpisodeView {
  episode: FacelessEpisode;
  channel: FacelessChannel | null;
  steps: StepView[];
  final: Generation | null;
  /** The previous finished film while a change renders. */
  previousFinal: Generation | null;
  /** 0–1 over every step. */
  progress: number;
  /** What the current version cost so far, and the render's estimate. */
  spentUsd: number;
  estimate: CostBreakdown | null;
  /** Where each scene sits in the film (by block index), from its clips. */
  scenes: { id: string; start: number; seconds: number }[];
  /** "narration": the scenes are cut to the spoken lines; "planned": to the planned lengths (not timed yet, or no timings). */
  timing: "narration" | "planned";
  /** The 1080p copy ("Upscale to 1080p"), once asked for. */
  upscaled: Generation | null;
  /** What "Upscale to 1080p" would cost (null: not offered on this engine). */
  upscale: { costUsd: number | null; demo: boolean } | null;
  /** The film with every scene regenerated at 1080p, once asked for. */
  regenerated: Generation | null;
  /** While it renders: its steps done of all. */
  regenerating: { done: number; of: number } | null;
  /** "Regenerate to 1080p" on this engine (null: not offered, as on the cloud): free on your GPU. */
  regenerate: { scenes: number; demo: boolean } | null;
}

/** One item in the Explainer's history or a channel's episode list. */
export interface EpisodeCard {
  id: string;
  channelId: string | null;
  kind: "faceless" | "explainer";
  title: string;
  status: EpisodeStatus;
  styleId: string;
  /** Made with the user's own style references (not a preset), and the first of them. */
  ownStyle: boolean;
  styleRef: string | null;
  aspect: EpisodeAspect;
  seconds: number;
  favorite: boolean;
  /** The finished film (hover plays it). */
  poster: Generation | null;
  /** The first scene's picture: the card's image (stills show everywhere, before the film is done too). */
  still: Generation | null;
  /** Rendering a change: an earlier version is finished. */
  updating: boolean;
  progress: number;
  createdAt: number;
}

export interface EstimateResult {
  estimate: CostBreakdown;
  demo: boolean;
  seconds: number;
  blocks: number;
  error?: string;
  /** Things to know that don't stop the render (a music bed shorter than the film, images a model can't read). */
  notes?: string[];
}

export interface ChangePreview {
  rerun: string[];
  labels: string[];
  costUsd: number | null;
  demo: boolean;
  /** The narration is read again: scenes whose timing moves by more than a second are animated again too (priced once it's timed). */
  retime?: boolean;
}
