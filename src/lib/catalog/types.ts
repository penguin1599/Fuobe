/**
 * Core catalog types shared by the UI and the server.
 *
 * A *model* is something the user picks in the model picker (e.g. "Kling 2.5 Turbo"
 * or "Wan 2.2 (open source)"). Each model has one or more *routes*: a route says how
 * to run one *operation* (text-to-video, image-to-video, ...) on one *provider*
 * (fal, replicate, comfyui, ...). Presets (apps, camera motions, effects) sit on top
 * of models and add prompt templates, fixed inputs and LoRAs.
 */
import type { CameraKey } from "@/lib/camera-path";
import type { SignatureRecord } from "./palettes";
import type { RunTrouble } from "@/lib/diagnose";

export type Engine = "cloud" | "open";

/** "text" = transcripts, translations, scripts (OutputFile.text); "model3d" = a .glb mesh. */
export type MediaKind = "image" | "video" | "audio" | "text" | "model3d";

export type Operation =
  | "t2i" // text → image
  | "edit" // image(s) + instruction → image
  | "inpaint" // image + mask + prompt → image
  | "outpaint"
  | "t2v" // text → video
  | "i2v" // image → video
  | "flf2v" // first + last frame → video
  | "ref2v" // reference images → video
  | "v2v" // video edit / restyle
  | "lipsync" // video + audio → video
  | "avatar" // portrait + audio → talking video
  | "motion-transfer" // character image + driving video → video
  | "upscale-image"
  | "upscale-video"
  | "bg-remove"
  | "face-swap"
  | "tts"
  | "sfx"
  | "music"
  | "v2a" // video → audio/foley
  | "interpolate"
  | "extend" // video → the same clip, continued
  | "grade" // colour grade, rendered in the browser
  | "relight" // the Relight tool's blend of a photo and its relit picture, rendered in the browser
  | "motion" // motion graphics, rendered in the browser
  | "mix" // stems → one track at the levels set in the browser (Split soundtrack's Export mix)
  | "reframe" // video → same video at a new aspect ratio (AI-filled edges)
  | "finalize" // draft video → full-quality render of the same take
  | "dialogue" // several speakers → one audio track
  | "voice-change" // speech audio → the same speech in another voice
  | "dub" // video (or audio) → translated, re-voiced and lip-synced
  | "bg-remove-video" // video → the subject on a transparent background
  | "depth-video" // video → depth map video
  | "relight-video" // video → the same shot under new lighting
  | "concat" // several clips → one video, in order
  | "frame" // video → one of its frames (the last, for extending)
  | "color-match" // image or video + reference image → recoloured to the reference's palette
  | "layers" // image → its layers as RGBA images (OutputFile.meta: name, z, bbox)
  | "text-layers" // image → the background with the text removed + the text blocks (OutputFile.meta.textBlocks)
  | "trim" // video → the part between params.startTime and params.endTime
  | "transcribe" // audio or video → timed text (OutputFile.text, OutputFile.meta.cues)
  | "captions" // video → the same video with burned-in captions
  | "mux" // video + audio → the video with that soundtrack
  | "image-to-3d" // image → a 3D model (.glb), optionally a turntable video
  | "separate-audio" // audio or video → stems (meta.stem): voice and background; DBS also music and effects
  | "enhance-voice" // audio or video → the main speaker's voice, cleaned (meta.stem voice): noise, echo, clipping and codec damage removed
  | "translate" // text → the same text in params.targetLanguage (LLM)
  | "write" // brief → text (LLM: scripts, ad copy, shot lists)
  | "vectorize" // image → the same picture as an SVG
  | "level" // audio → the same audio at a set loudness (a music bed under a voice-over)
  | "timeline" // audio clips placed at their start times over silence → one track as long as the video (dub voices)
  // round 4
  | "remove-object" // video + (prompt naming it | mask: first-frame mask, white = erase | params.points) → the same video without it
  | "video-swap" // video + reference image(s) + prompt (optional mask / points) → the object or person replaced by the reference
  | "video-insert" // video + reference image + prompt (where it goes) → the object added
  | "keyframes" // images (1–10, in order) + params.keyframeTimes → one video through every keyframe
  | "sdr-to-hdr" // video → HDR video (params.format)
  | "export-video" // video → the same video in params.format
  | "ocr" // image → its text lines (OutputFile.text, OutputFile.meta.lines [{text, bbox}])
  | "still-motion" // image → a camera move over it (Ken Burns: zoomFrom/zoomTo, panFrom/panTo, easing)
  | "audio-loop" // audio → the same audio extended to params.duration (params.crossfade at each seam)
  | "audio-join" // audio clips in order → one track (params.crossfade between them)
  | "scene-3d" // image → a whole-scene 3D model (GLB) for camera recomposition
  | "splat" // image → a Gaussian splat of the subject (meta.format "ply" | "spz")
  | "text-to-3d" // prompt → 3D model
  | "rig-3d" // 3D model (+ params.animation) → rigged / animated model
  | "refine-3d" // 3D model + the photo it was made from (+ params.extra.meshResolution) → the same model with finer geometry (Hi3D)
  | "extract-frames" // video → an image every params.frameInterval frames (meta.index)
  | "images-to-video" // images in order → a video at params.fps
  | "overlay" // image + a second image (logo) → composited (params.position, params.scale)
  // round 5 (O11)
  | "face-mosaic" // image → the same picture with the faces (or what the prompt names) pixelated: SAM 3.1 mask + mosaic
  // N7-5
  | "composite" // footage + its redrawn swap + the swap + the person's mask → only the person over the footage (Character swap in 2K)
  | "camera-path" // image + params.cameraPath (+ inputs.video: the open engine's render along the path) → the camera following the path
  // Watermark Remover
  | "watermark-scan" // image → a JSON report of the marks printed over it (text, logos, stickers, mosaics, blocks) with their boxes in pixels
  | "watermark-remove" // image + params.extra.boxes (the marks kept for removal) or a mask (white = remove) → the same picture, only under them repaired
  // archive-restore
  | "restore-video" // archive video (+ prompt: period, place, light; negative: what not to invent) → the same shot clean, in colour, larger
  // Design a voice
  | "voice-design" // params.voiceDescription (who is speaking) + prompt (the line) → the line in a new voice made from the words
  // Genjutsu's Openjutsu modes
  | "face-fix-video" // video + face photo → the same video with small or soft faces redrawn to match the photo
  | "tone-video" // video → the same video with a film finish (detail softened, tone-mapped)
  | "describe-video" // video part (+ a picture) → what happens in it, in words (text)
  | "group-swap" // video part + 1–4 character pictures + roles → each named person replaced by their character
  | "scene-edit" // video part (+ a picture) + params.extra (change / remove / new background) → the scene edited, the rest kept
  | "picture-frame" // video part (+ a character picture) → its first frame with the character in that pose (or relit)
  | "picture-video" // video part + an approved first frame (+ what happens) → the frame animated with the part's motion
  // Hosted tools: insert a moment, retexture
  | "insert-moment" // video + params.startTime / params.endTime (+ prompt, reference images and clips, params.duration: the new scene's length) → the clip with a new scene between them
  | "retexture-3d" // 3D model (inputs.model3d) + prompt or a style image → the same model with new textures
  // Edit speech
  | "speech-edit" // audio or video (its soundtrack) + params.extra.speechWindows (src/lib/speech-edit.ts) → the recording with those parts changed (AuK)
  // A song's cloud tools (Mureka). The song is inputs.audio, or one of Mureka's own (params.extra.songId)
  | "song-extend" // song + lyrics for the new part (+ params.startTime: where it begins; params.extra.extend_type tail | head) → the song, longer
  | "song-remix" // song + a style (prompt) + the whole song's lyrics → a new arrangement of it
  | "song-stems" // song → its vocal and instrument tracks (meta.stem), one file each
  // Worlds (Hy-Nomas)
  | "world-turn"; // params.extra.world (src/lib/world.ts: the opening and the turns) + params.extra.turn → that turn's clip of the world (Hy-Nomas)

export const OPERATION_LABELS: Record<Operation, string> = {
  t2i: "Text to image",
  edit: "Image edit",
  inpaint: "Inpaint",
  outpaint: "Outpaint",
  t2v: "Text to video",
  i2v: "Image to video",
  flf2v: "Start & end frame",
  ref2v: "Reference to video",
  v2v: "Video to video",
  lipsync: "Lipsync",
  avatar: "Talking avatar",
  "motion-transfer": "Motion transfer",
  "upscale-image": "Image upscale",
  "upscale-video": "Video upscale",
  "bg-remove": "Background removal",
  "face-swap": "Face swap",
  tts: "Text to speech",
  sfx: "Sound effects",
  music: "Music",
  v2a: "Video to audio",
  interpolate: "Frame interpolation",
  extend: "Extend video",
  grade: "Color grade",
  relight: "Relight",
  motion: "Motion graphics",
  mix: "Mix",
  reframe: "Reframe",
  finalize: "Final render",
  dialogue: "Dialogue",
  "voice-change": "Voice change",
  "voice-design": "Design a voice",
  "speech-edit": "Edit speech",
  dub: "Translate & dub",
  "bg-remove-video": "Video background removal",
  "depth-video": "Video depth map",
  "relight-video": "Video relight",
  concat: "Join clips",
  frame: "Extract frame",
  "color-match": "Match colors",
  layers: "Layers",
  "text-layers": "Text layers",
  trim: "Trim video",
  transcribe: "Transcribe",
  captions: "Captions",
  mux: "Add soundtrack",
  "image-to-3d": "Image to 3D",
  "separate-audio": "Separate voice",
  "enhance-voice": "Clean up voice",
  translate: "Translate",
  write: "Write",
  vectorize: "Vectorize",
  level: "Level audio",
  timeline: "Place on the timeline",
  "remove-object": "Remove object",
  "video-swap": "Swap object",
  "video-insert": "Add object",
  keyframes: "Keyframes to video",
  "sdr-to-hdr": "SDR to HDR",
  "export-video": "Export video",
  ocr: "Read text",
  "still-motion": "Ken Burns",
  "audio-loop": "Loop audio",
  "audio-join": "Join audio",
  "scene-3d": "3D scene",
  splat: "Gaussian splat",
  "text-to-3d": "Text to 3D",
  "rig-3d": "Rig 3D model",
  "refine-3d": "Refine 3D model",
  "extract-frames": "Extract frames",
  "images-to-video": "Images to video",
  overlay: "Overlay image",
  "face-mosaic": "Pixelate faces",
  "camera-path": "Fly path",
  composite: "Character over the footage",
  "watermark-scan": "Find marks",
  "watermark-remove": "Remove watermark",
  "restore-video": "Restore & colourise",
  "face-fix-video": "Fix faces",
  "tone-video": "Fix colours",
  "describe-video": "Describe a video",
  "group-swap": "Group swap",
  "scene-edit": "Scene edit",
  "picture-frame": "First frame from a picture",
  "picture-video": "Video from a picture",
  "insert-moment": "Insert a moment",
  "retexture-3d": "Retexture",
  "song-extend": "Extend a song",
  "song-remix": "Remix a song",
  "song-stems": "Song stems",
  "world-turn": "World turn",
};

export const OPERATION_OUTPUT: Record<Operation, MediaKind> = {
  t2i: "image",
  edit: "image",
  inpaint: "image",
  outpaint: "image",
  t2v: "video",
  i2v: "video",
  flf2v: "video",
  ref2v: "video",
  v2v: "video",
  lipsync: "video",
  avatar: "video",
  "motion-transfer": "video",
  "upscale-image": "image",
  "upscale-video": "video",
  "bg-remove": "image",
  "face-swap": "image",
  tts: "audio",
  sfx: "audio",
  music: "audio",
  v2a: "video",
  interpolate: "video",
  extend: "video",
  grade: "image",
  relight: "image",
  motion: "video",
  mix: "audio",
  reframe: "video",
  finalize: "video",
  dialogue: "audio",
  "voice-change": "audio",
  "voice-design": "audio",
  "speech-edit": "audio",
  dub: "video",
  "bg-remove-video": "video",
  "depth-video": "video",
  "relight-video": "video",
  concat: "video",
  frame: "image",
  "color-match": "image",
  layers: "image",
  "text-layers": "image",
  trim: "video",
  transcribe: "text",
  captions: "video",
  mux: "video",
  "image-to-3d": "model3d",
  "separate-audio": "audio",
  "enhance-voice": "audio",
  translate: "text",
  write: "text",
  vectorize: "image",
  level: "audio",
  // The open engine returns the track; fal's compose renders it as a video (the result follows the model).
  timeline: "audio",
  "remove-object": "video",
  "video-swap": "video",
  "video-insert": "video",
  keyframes: "video",
  "sdr-to-hdr": "video",
  "export-video": "video",
  ocr: "text",
  "still-motion": "video",
  "audio-loop": "audio",
  "audio-join": "audio",
  "scene-3d": "model3d",
  splat: "model3d",
  "text-to-3d": "model3d",
  "rig-3d": "model3d",
  "refine-3d": "model3d",
  "extract-frames": "image",
  "images-to-video": "video",
  overlay: "image",
  "face-mosaic": "image",
  "camera-path": "video",
  composite: "video",
  "watermark-scan": "text",
  "watermark-remove": "image",
  "restore-video": "video",
  "face-fix-video": "video",
  "tone-video": "video",
  "describe-video": "text",
  "group-swap": "video",
  "scene-edit": "video",
  "picture-frame": "image",
  "picture-video": "video",
  "insert-moment": "video",
  "retexture-3d": "model3d",
  "song-extend": "audio",
  "song-remix": "audio",
  "song-stems": "audio",
  "world-turn": "video",
};

/**
 * Video codecs and containers an export or HDR job can write (params.format): H.264 MP4, 10-bit H.265
 * MP4, ProRes 422 HQ or 4444 in a .mov, lossless FFV1 in a .mkv, or a 16-bit EXR frame sequence.
 * The open engine's HDR is also written as 10-bit H.264 in BT.2020 with the HLG or PQ (HDR10) curve
 * (core ComfyUI has no H.265 encoder).
 */
export type VideoFormat = "h264" | "h265_10bit" | "prores_422_hq" | "prores_4444" | "ffv1" | "exr" | "hlg_10bit" | "pq_10bit" | "webm_alpha";

/**
 * What Remove background makes: the subject on a transparent background, or its black-and-white alpha mask. A green-screen
 * key also makes the clean foreground: the subject's colours with the green spill taken out, for a compositor to use with the mask.
 */
export type MatteOutput = "cutout" | "matte" | "foreground";

/** Depth map colour maps, in Higgsfield's order (grayscale first: every depth model draws it). */
export const COLORMAPS = ["grayscale", "turbo", "inferno", "magma", "viridis"] as const;

/** A point on a picture in its own pixels (the first frame of a video). Negative points mark what to keep. */
export interface PixelPoint {
  x: number;
  y: number;
  label?: "positive" | "negative";
  /** A video's frame the point is on (0, the first, when unset): SAM 3.1 video's `frame_index` on fal. */
  frame?: number;
}

/** A position on a picture as fractions of its width and height (0–1 from the top left). */
export interface FocusPoint {
  x: number;
  y: number;
}

/** "llm" runs text steps (translate, write) on the configured LLM (Claude or a local model) inside the server. */
/** "worldcast" is the WorldCast worker on the owner's GPU, outside ComfyUI (build plan N7-9; docs/workers/worldcast.md). */
export type ProviderId = "fal" | "replicate" | "openai" | "google" | "comfyui" | "mock" | "local" | "llm" | "worldcast";

/** Duration encodings differ between APIs ("5" vs 5 vs "5s"). */
export interface DurationField {
  key: string;
  type: "string" | "number";
  suffix?: string;
  /** e.g. 1000 when the API wants milliseconds. */
  multiplier?: number;
}

export interface EnumField {
  key: string;
  /** Map our canonical value → provider value. Unlisted values pass through. */
  values?: Record<string, string | number | boolean>;
  /**
   * The canonical values this route takes, when they differ from the model's own list (a model on two
   * APIs that take different lists). Any other value is sent as the closest one it takes
   * (aspect ratios by shape, resolutions by size) and left out when none is close ("auto" on an API
   * without it), so the API's default applies.
   */
  accepts?: string[];
}

/**
 * How a canonical {@link GenInput} maps onto a provider payload.
 * Keys are our canonical fields, values are the provider's field names.
 */
export interface FieldMap {
  prompt?: string | false;
  negativePrompt?: string;
  /** Single primary image field, e.g. "image_url". */
  image?: string;
  /** Array of images field, e.g. "image_urls" (receives every reference image). */
  images?: string;
  endImage?: string;
  mask?: string;
  /** What the mask's paint means to this API: white (default), black or transparent = change. */
  maskFormat?: "white" | "black" | "alpha";
  video?: string;
  /** Video field that takes an array (receives the one input video). */
  videoArray?: string;
  /** Array field that receives every clip of `inputs.videos`, in order (join clips; reference videos for reference-to-video). */
  videos?: string;
  audio?: string;
  aspectRatio?: string | EnumField;
  resolution?: string | EnumField;
  duration?: DurationField;
  numOutputs?: string;
  seed?: string;
  /** Inclusive seed limits when the API accepts a narrow range (Fuobe's seeds are folded into it). */
  seedRange?: [number, number];
  /** Boolean field, or an on/off enum such as Kling's `sound: "on" | "off"`. */
  generateAudio?: string | { key: string; on: unknown; off: unknown };
  /** Premade voice name / id (ElevenLabs `voice`). Dotted keys write nested fields. */
  voice?: string;
  /** Reference clip to clone a voice from (zero-shot TTS) or to convert into (voice change). */
  voiceAudio?: string;
  /** Words that describe the voice (voice design: fal's Qwen3-TTS `prompt`). */
  voiceDescription?: string;
  /** What the voice sample says (Qwen3-TTS `reference_text`): a closer clone. */
  voiceTranscript?: string;
  /** A cloned voice as a file (Qwen3-TTS `speaker_voice_embedding_file_url`): GenInput.voiceEmbedding. */
  voiceEmbedding?: string;
  /**
   * A voice sample this API can't take directly is cloned first (fal's Qwen3-TTS: clone-voice, then text-to-speech with the
   * embedding it returns): the endpoint, its audio field, its transcript field and the field of the file it returns.
   */
  cloneFirst?: { endpoint: string; audio: string; text?: string; output: string };
  /** Multi-speaker lines: an array of {text, voice}. */
  dialogue?: { key: string; text: string; voice: string };
  /** Language to translate into (dubbing). */
  targetLanguage?: string;
  /** Native multi-shot: an array of {prompt, duration} (Kling's `multi_prompt`). */
  multiShot?: {
    key: string;
    durationType: "string" | "number";
    json?: boolean;
    shotType?: string;
    flag?: string;
    /** The most characters a shot's prompt takes (Kling 4.0: 512); a longer one is cut at a word. */
    maxPrompt?: number;
    /** Shot lengths in whole seconds (rounded, at least 1). */
    integer?: true;
  };
  /**
   * Kling 4.0's elements (@Element1..): a list of objects, each a frontal image with up to `views` more angles, or a
   * clip (`video`). Filled from params.elements, which groups some of inputs.images / inputs.videos into elements: those
   * leave the image and clip lists, so the rest keep their @Image / @Video numbers.
   */
  elements?: { key: string; frontal: string; views: string; video?: string; max: number; maxViews: number; maxVideos?: number };
  /** Boolean draft switch (Seedance 2.5 renders a cheap 480p take and returns a draft id). */
  draft?: string;
  /** Field that takes the draft id to finish. */
  draftId?: string;
  /** Trim: where the kept part starts and ends (seconds × multiplier). */
  startTime?: DurationField;
  endTime?: DurationField;
  /** Frames per second (frame sampling, images to video). */
  fps?: string;
  /**
   * Colour palette: hex strings converted to the API's shape ("rgb-object" = Recraft on fal [{r,g,b}],
   * "rgb-array" = [{rgb:[r,g,b]}], "ideogram" = {members:[{rgb:{r,g,b}, color_weight}]}).
   * `background` names the API's background-colour field: a hex string sent as params.extra[background]
   * is converted to the same shape.
   */
  palette?: { key: string; format: "hex" | "rgb-object" | "rgb-array" | "ideogram"; background?: string };
  /** A saved style id (Recraft styles, Soul 2.0 moodboards). */
  styleId?: string;
  /** How many layers to split an image into. */
  numLayers?: string;
  /**
   * Language of the speech. With `values` (the API's own list, e.g. VEED's "es-ES"), the request's
   * language is matched to an entry by exact value or ISO code, and left out when nothing matches.
   */
  sourceLanguage?: string | { key: string; values: string[] };
  /** Second image field (inputs.images[1]): a try-on garment, a product shot's scene reference, a style image. */
  image2?: string;
  /** Static fields always sent (e.g. safety checker switches). */
  fixed?: Record<string, unknown>;
  /** Array field that receives `inputs.audios` (reference audio clips: Seedance / Cinema Studio reference-to-video). */
  audios?: string;
  /**
   * Timeline render (fal ffmpeg compose `tracks`): one visual track (inputs.images[0] as a still, else
   * inputs.video) as long as params.extra.timeline.length, and one audio track with inputs.audios placed
   * at params.extra.timeline.clips[i].start for .duration seconds (keyframes in milliseconds).
   */
  timeline?: string;
  /**
   * Fields sent unless the request sets them (a canonical field or params.extra wins): Wizper's
   * `language: null` (detect instead of assuming English), Mirelo's full-length soundtrack.
   */
  defaults?: Record<string, unknown>;
  /**
   * A timeline render (fal ffmpeg compose): one track for `video`, an audio track for `audio` (the voice)
   * and one for `audio2` (a background bed), each placed at 0 and as long as `duration` (seconds).
   */
  tracks?: string;
  /**
   * How this route (or its `loraEndpoint`) takes LoRAs: generated from the research's hostedLoraEndpoints,
   * filled by src/lib/catalog/loras.ts (loraFields) from GenInput.loras.
   */
  loras?: LoraField;
  // Round 4 (research part 4).
  /**
   * Points clicked on the first frame (params.points, pixels) in the API's shape: "bria" = strings like
   * "{'x':100, 'y':100, 'type':'positive'}", "sam" = objects {x, y, label: 1 | 0}.
   */
  points?: { key: string; format: "bria" | "sam" };
  /**
   * Keyframes (inputs.images in order at params.keyframeTimes seconds) as [{[image]: url, [frame]: index}],
   * the frame index counted at the API's `fps`. Without times the keyframes are spread over the clip.
   */
  keyframes?: { key: string; image: string; frame: string; fps: number };
  /** Output codec / container (params.format) as the API's own value; a format the API can't write is left out. */
  format?: { key: string; values: Partial<Record<VideoFormat, string>> };
  /** Seconds of crossfade at each join or loop seam (params.crossfade). */
  crossfade?: string;
  /**
   * A Ken Burns move sent as one zoom toward a focal point (fal's zoompan, which always starts or ends on
   * the whole picture): `factor` = the zoomed-in end, the larger of params.zoomFrom / zoomTo (at most
   * `max`), `direction` in or out, the focal point = the pan point at the zoomed-in end (0–1, or percent),
   * `easing` from params.easing. The other end is the whole picture, whatever params says.
   */
  zoom?: { factor: string; max?: number; direction?: { key: string; in: string; out: string }; x?: string; y?: string; easing?: EnumField; percent?: boolean };
  /** Where an overlay's centre goes (params.position, 0–1 of the background; or percent). */
  position?: { x: string; y: string; percent?: boolean };
  /** An overlay's size (params.scale, 1 = its own size) times `multiplier` (100 for percent). */
  scale?: { key: string; multiplier?: number };
  /** Frame interpolation: the output frame rate (params.targetFps) and slow-motion factor (params.slowdown). */
  targetFps?: string;
  slowdown?: string;
  /** Every Nth frame (params.frameInterval). */
  frameInterval?: string;
  /** Depth map colours (params.colormap: grayscale, turbo, inferno, magma, viridis). */
  colormap?: string | EnumField;
  /** Boolean field: the original clip next to the depth map (params.sideBySide). */
  sideBySide?: string;
  /**
   * Remove background's output (params.matteOutput) as the API's own value: BiRefNet's `output_mask` true adds
   * the mask video, and the job keeps the asked-for file (outputs tagged meta.role "cutout" / "matte").
   */
  matteOutput?: { key: string; values: Partial<Record<MatteOutput, unknown>> };
  /** Images held as video frames: [{[url]: image, [frames]: 1}] in order (images to video at params.fps). */
  frames?: { key: string; url: string; frames: string };
  /**
   * A loop by repetition: inputs.audio listed as many times as params.duration / params.sourceDuration
   * needs (2 to `max` plays; `max` when either is unknown).
   */
  loop?: { key: string; max: number };
  /** The 3D model to work on (inputs.model3d: rig-3d). */
  model3d?: string;
  /** An animation preset (params.animation); `flag` is the API's switch that turns animation on. */
  animation?: { key: string; flag?: string };
  /**
   * A frame count for routes that render only as many frames as asked (LTX 2.3 clean plate and HDR, VOID):
   * the clip's length (params.sourceDuration, else params.duration) × the frame rate (params.fps, else
   * `fps`), kept within min–max. Nothing is sent when the length is unknown (the API's default applies).
   * Also video models whose length is a frame count (Wan 2.2, LTX-2.3 22B), where `step` keeps the count at
   * step·n + 1 (Wan 4n+1, LTX 8n+1). `fromDuration`: the frames to add (extend), so params.duration counts,
   * never the input clip's length, at the clip's own frame rate when it is known (fal's LTX-2.3 extend matches it).
   * `multiple`: a count that must be a multiple of it (fal's Wan 2.2 S2V: 4n). A talking-avatar route (fal's
   * InfiniteTalk, Wan 2.2 S2V) renders as long as the voice: its header's length is params.sourceDuration.
   */
  numFrames?: { key: string; fps: number; min?: number; max?: number; step?: number; multiple?: number; fromDuration?: boolean };
  /**
   * Width and height fields (Replicate's Z-Image LoRA model): the aspect ratio's shape with the area of a
   * `base`×`base` square (1024 when unset), in multiples of `multiple`, neither side above `max` nor below `min`
   * (fal's MOSS-Image takes 512–2048). A size the request asks for (params.extra[key] {width, height}: a layout's
   * canvas) is kept on the same grid and within the same limits, as the API would.
   */
  size?: {
    width?: string;
    height?: string;
    /** One object field that takes {width, height} (fal's image_size) instead of two fields. */
    key?: string;
    multiple: number;
    max?: number;
    min?: number;
    base?: number;
    /** The square each resolution tier is (fal's FLUX 3 Klein: 1K = 1024 … 4K = 4096), over `base`. */
    bases?: Record<string, number>;
    /** Exact sizes per resolution tier and aspect ratio (Fuobe Soul's table); the computed size where it has none. */
    table?: Record<string, Record<string, [number, number]>>;
  };
  /**
   * Limits the API checks on numeric fields Fuobe fills (round 4: target fps, slow motion, frame interval,
   * overlay position and scale, Ken Burns length…): a value is rounded when the field takes whole numbers
   * and kept inside min–max before it is sent. params.extra is sent as given.
   */
  ranges?: Record<string, { min?: number; max?: number; integer?: boolean }>;
  /** The most images this route's image list takes, when fewer than the model's options.maxImages (another route takes more). */
  maxImages?: number;
  /**
   * The API's own prompt expansion switch (fal's enable_prompt_expansion): sent false whenever the request carries a
   * layout (params.extra.layout), which expansion would rewrite; a plain prompt leaves the API's default.
   */
  promptExpansion?: string;
  /**
   * A layout the API takes as boxes of its own (fal's FLUX 3 Klein bounding_boxes: {label, description, box: {x_min, y_min,
   * x_max, y_max} as 0-1 fractions}, at most `max`): the plan writes them into params.extra[key] from the draft, and the
   * prompt names each box as <label> (src/lib/layout-prompt.ts flux3Boxes).
   */
  boundingBoxes?: { key: string; max?: number };
  /**
   * A camera path (params.cameraPath, build plan N7-5) as the API's keyframes [{time, azimuth, elevation, distance}]:
   * `min`–`max` of them, the height kept inside `elevation`, at most `maxTurns` turns of travel. `free`: the API's fixed
   * moves (H3 Max's free_camera_preset), which a pure slide (Truck left / right) is sent as instead of the keyframes.
   */
  cameraPath?: { key: string; min: number; max: number; elevation: [number, number]; maxTurns: number; free?: { key: string; values: string[] } };
  /** An empty prompt is left out rather than sent as "" (APIs that read a missing prompt as "no words": Bria Expand). */
  omitEmptyPrompt?: boolean;
  /** The most characters the API's prompt field takes (its schema's maxLength: Vidu Q4 5,000, Meshy retexture 600): a longer one is refused before it's paid for. */
  promptMax?: number;
  /** params.extra keys this route has no field for (a model-wide control only its other routes read): left out. */
  ignore?: string[];
  /**
   * Song lyrics (params.extra.lyrics, section tags such as [Verse] on lines of their own: src/lib/lyrics.ts): the API's lyrics
   * field and the most characters it takes, or (`inPrompt`) written after the prompt for an API that reads them there
   * (Lyria 3.5). A route without it never sends params.extra.lyrics. `instrumental`: the API's switch for a song with no
   * vocals (MiniMax Music 2.5's is_instrumental), sent in place of lyrics that are only [Instrumental], with its own lyrics
   * writer (`autoLyrics`) off.
   */
  lyrics?: { key?: string; inPrompt?: true; max?: number; instrumental?: string; autoLyrics?: string };
  /**
   * A song tool's source song (Mureka extend / remix): one of the provider's own songs by id (params.extra.songId, kept on a
   * result as meta.songId) in `songId`, else the song file (inputs.audio) sent first to `upload` (Mureka's files/upload with
   * its `purpose`), whose id goes in `uploadId`.
   */
  songSource?: { songId: string; uploadId: string; upload: { endpoint: string; purpose: string } };
  /**
   * An upscaler that takes a factor, not a size (Topaz, FLUX Upscale): params.resolution ("1080p", "4K",
   * "Original" = 1) becomes target ÷ the clip's shorter edge (GenInput.sourceSize), kept within min–max.
   * Nothing is sent when the clip's size is unknown (the API's default factor applies). A factor tier ("2x", "2.25x",
   * "4x": Kandinsky VSR) is sent as that factor.
   */
  upscaleFactor?: { key: string; min?: number; max?: number };
}

export interface ModelRoute {
  op: Operation;
  provider: ProviderId;
  /** fal endpoint id, replicate "owner/name", or ComfyUI workflow id from the manifest. */
  endpoint: string;
  map?: FieldMap;
  /**
   * The parts of `map` the composer previews a result with ("1920×1080 → 2880×1620", an EXR frame count, the canvas a
   * layout is compiled at), kept by slimModel when it drops the field maps for the browser. The server reads `map`.
   */
  preview?: Pick<FieldMap, "upscaleFactor" | "numFrames" | "size">;
  /** Optional note shown in the UI (e.g. "uses Lightx2v 4-step LoRA"). */
  note?: string;
  /**
   * The route runs only when a setting has this value (params.extra[param], after a control's `sets`): Kandinsky 6.0 on fal
   * is one model in Fuobe whose Quality picks Pro's or Lite's endpoint. Routes without `when` always qualify; a run whose
   * setting is unset takes the first route (routesFor).
   */
  when?: { param: string; value: string };
  /**
   * Same model with LoRA support (fal's `/lora` variants): the run switches to it when it carries LoRAs
   * (a trained identity, a preset's look or motion). `map.loras` says how they go in its payload.
   */
  loraEndpoint?: string;
  /**
   * The route runs as several jobs of its workflow, built on the server (ComfyUI keyframes: one
   * start/end-frame clip of `endpoint` per pair of frames, then joined; src/server/chains.ts).
   */
  chained?: true;
  /**
   * A ComfyUI route's graph settings sent unless the request sets them (params.extra wins): Fuobe Speak's InfiniteTalk
   * defaults on kijai's wrapper graph (motion frames, steps, shift, text and audio guidance, colour match), the cloud's
   * FieldMap.defaults for a graph.
   */
  extra?: Record<string, unknown>;
  /**
   * A ComfyUI wrapper graph that loads one LoRA itself (kijai's InfiniteTalk) takes the run's LoRA in that slot, in place of
   * its own: only on a route whose recipe brings that LoRA and the settings it needs (Fuobe Speak's FusioniX with 25 steps).
   * Other routes on the graph refuse a LoRA rather than swap out the one its settings are tuned for.
   */
  loraSlot?: true;
  /**
   * A ComfyUI graph that takes no size: its picture follows image 1 (Qwen-Image 2.1's and FIBO 2 Dev's edits, Qwen-Image
   * 2.1's inpaint) or the canvas its pads grow (expand). The composer shows no Aspect ratio or Resolution for its operation.
   */
  unsized?: true;
  /**
   * A cloud edit whose picture follows image 1's shape at the chosen tier (fal's FLUX 3 Klein, as its GPU edit follows reference
   * 1): the server sends image 1's shape on the tier's square in the route's size field (src/server/generations.ts sizedEdit),
   * so the price stays the tier's. The composer shows Resolution but no Aspect ratio for its operation.
   */
  followsImage?: true;
  /**
   * The most images this route reads, when fewer than the model's options.maxImages (Qwen-Image 2.1's inpaint and expand
   * read the picture alone; its edit takes 4): the composer offers no more for its operation, and the plan refuses more.
   */
  maxImages?: number;
}

/** "30s": takes of up to 30 s in one call (Kling 4.0). */
export type Badge = "new" | "top" | "fast" | "audio" | "4k" | "hd" | "pro" | "open" | "uncensored" | "beta" | "30s";

export interface ModelOptions {
  /**
   * Keyframe animation (Fuobe Animation): its keyframes run with per-gap timing (params.extra.inbetween: frames, every Nth
   * frame, words; the playback rate), src/lib/inbetween.ts. The film is as long as its gaps, not params.duration.
   */
  inbetween?: true;
  aspectRatios?: string[];
  resolutions?: string[];
  /**
   * Tiers a finishing pass reaches after the model's own render, offered only where the brief puts them (the Video
   * studio and Cinema, through studioResolutions): MiniMax H3's 2K on your GPU is a 768p draft redrawn by Open-H3
   * Regenerate. Tier pickers elsewhere (Faceless, Canvas, Assist, Ad Multiplier) keep to `resolutions`.
   */
  finishTiers?: string[];
  durations?: number[];
  /** Max outputs per request the model supports natively. */
  maxOutputs?: number;
  /** Max reference images accepted (edit / multi-ref). */
  maxImages?: number;
  seed?: boolean;
  negativePrompt?: boolean;
  /** true = optional toggle, "always" = native audio always on. */
  audio?: boolean | "always";
  endFrame?: boolean;
  /** Multi-shot support: "native" sends per-shot prompts, "prompt" writes the shots into one prompt. */
  multiShot?: { mode: "native" | "prompt" | "concat"; maxShots: number };
  /**
   * @mentioned Elements go as the model's own elements (Kling 4.0's @Element1..): up to `max`, each a frontal image and up
   * to `views` more angles, or a clip (up to `videos` of them). `voices`: a voice can be bound to one (false: Fuobe has no
   * way to make the provider's voice ids yet, so voices aren't sent).
   */
  elements?: { max: number; views: number; videos: number; voices: false; ops: Operation[] };
  /**
   * The model sings lyrics (Audio → Music's lyrics editor, params.extra.lyrics): the most characters it takes, and whether they
   * go after the prompt (Lyria 3.5) rather than in a field of their own. Section tags ([Verse], [Chorus]) on lines of their own.
   * `instrumentalModel`: the model sings words only, and its maker's instrumental model is this one (Mureka 9.5 → Mureka 9.5
   * Instrumental): the editor offers no Instrumental, and lyrics that are only [Instrumental] are refused with its name.
   */
  lyrics?: { max?: number; inPrompt?: true; required?: true; instrumentalModel?: string };
  /** Takes a song to cover (inputs.audio: YuE2 sings its melody with the new style and lyrics). */
  cover?: true;
  /** Draft mode (cheap preview, then a full render of the take you like). */
  draft?: boolean;
  /**
   * Takes a Fuobe Soul look (src/lib/catalog/soul.ts) as GenerationRequest.presetId, with presetStrength scaling
   * its LoRAs; `label` names the picker.
   */
  looks?: { label: string };
  /** Premade voices the model offers (shown in the voice picker). */
  voices?: { id: string; name: string; hint?: string }[];
  /** Takes a reference recording to clone a voice from. */
  voiceClone?: boolean;
  /** Follows motion paths drawn on the start frame (Wan-Move). */
  motionPaths?: boolean;
  /** Languages it can translate into. */
  languages?: string[];
  /** Numeric settings sent as-is (stability, similarity, speed, exaggeration…). */
  sliders?: { param: string; label: string; min: number; max: number; step: number; default: number }[];
  /**
   * Extra enum settings sent as-is (Cinema Studio's genre, lens, light, grade, camera move…); `labels` names values that read badly
   * (FLUX Upscale's creativity 0 / 1). `sets`: a value that stands for several settings (MOSS-Image's Quality: 50 steps, CFG 3,
   * euler), which the plan writes into params.extra in its place; a setting the request gives itself wins.
   */
  controls?: {
    param: string;
    label: string;
    values: (string | number)[];
    default?: string | number;
    labels?: Record<string, string>;
    sets?: Record<string, Record<string, string | number>>;
    /** The operations a value is offered on, when not all (Qwen-Image 2.1's Turbo speed: edits). The chip shows the rest only. */
    ops?: Record<string, string[]>;
  }[];
  /** Images it needs before it can run (try-on: the person and the garment). */
  minImages?: number;
  /** What each image is, in order ("person photo", "garment"): blockers and slot labels. */
  imageLabels?: string[];
  /** None of its routes takes a prompt (try-on, 3D, transcription): the composer can hide the prompt box. */
  promptless?: boolean;
  /** The prompt box shows, but the model also runs without words (P-Video Replace, Genjutsu Lite object swap). */
  promptOptional?: boolean;
  /**
   * The light goes as a picture of a lit sphere (fal's H3 Max relight: reference_image_url), drawn in the browser from a light
   * preset (src/lib/relight-sphere.ts) and sent as the run's image; no words.
   */
  lightSphere?: boolean;
  /** The words a run takes when none are given (Fuobe Try-On: its try-on LoRA's own instruction). */
  defaultPrompt?: string;
  /** The prompt box's placeholder for this model (Open-H3 Regenerate: describe the clip it redraws). */
  promptPlaceholder?: string;
  /**
   * The prompt the model reads, when it isn't plain words: "ideogram4" = an Ideogram 4 JSON caption. The server writes
   * one from the words before the run (src/lib/ideogram-caption.ts) and keeps it as the run's prompt.
   * "minimax-h3" = MiniMax H3's layout: an alignment line for the start (and end) frame, then integrated_multimodal_description,
   * overall_soundscape and non_diegetic_music. The server wraps the words in it (src/lib/h3-prompt.ts) and keeps the result
   * as the run's prompt; words already in the layout pass through.
   * "kandinsky6" = Kandinsky 6.0's tags: words in quotes become spoken lines (<S>…<E>) and a "Sound:" line the sound caption
   * (<AUDCAP>…<ENDAUDCAP>), on both engines (src/lib/kandinsky-prompt.ts); the run keeps the words as typed.
   * "qma" = the QMA camera-angles LoRA's "<qma> {azimuth} {elevation} {distance}": the plan writes it from the run's pose
   * (params.extra horizontal_angle / vertical_angle / zoom, src/lib/qma.ts), the words after it.
   */
  promptFormat?: "ideogram4" | "minimax-h3" | "kandinsky6" | "qma";
  /**
   * The longest clip it takes, in seconds (Kandinsky VSR: 121 frames at 24 fps on both engines): a longer one is refused
   * before it runs, never cut short.
   */
  maxSourceSeconds?: number;
  /**
   * Factors that need the clip's sides in multiples of a number (fal's Kandinsky VSR: 16 at 2x and 4x; the open pack pads
   * the clip itself): such a clip is refused before it runs, with the factor that takes it.
   */
  sideMultiple?: { of: number; factors: string[] };
  /**
   * LoRAs the model's recipe always loads (Fuobe Try-On's try-on LoRA): every run carries them before the user's own
   * (an API's LoRA cap leaves out the user's first), their trigger words leading the prompt. A ComfyUI graph that loads
   * one itself isn't given it twice (injectLoras), and a run is refused while Settings → Models & licences has one
   * switched off, or when the route leaves one out for any other reason.
   */
  loras?: LoraRef[];
  /** Max reference videos / audio clips it accepts (reference-to-video: inputs.videos / inputs.audios). */
  maxVideos?: number;
  maxAudios?: number;
  /** The most references across its pictures, clips and sound clips together (fal's H3 Max Turbo references: 12 files). */
  maxReferences?: number;
  /** The one format its reference voices are read in (fal's Vidu Q4: mp3); a clip in another is refused before the run. */
  referenceAudio?: string;
  /** Spoken languages it can be told (transcription, captions): sent as params.sourceLanguage; unset = its default. */
  sourceLanguages?: string[];
  /**
   * What this model needs beyond its operation's own inputs, checked before a job is created (the
   * composer shows `msg` inline): reference images for a style-reference t2i model, a prompt for a
   * model whose operation is otherwise promptless, a painted mask or clicked points (video erasers), a video to follow
   * (the open Fly path's render). promptInstead: words stand in for the last of the images (Outfit Swap: a photo of the
   * outfit, or the outfit described).
   */
  requires?: { images?: number; promptInstead?: boolean; prompt?: boolean; mask?: boolean; points?: boolean; video?: boolean; msg: string };
  /** Output formats it can write (params.format: SDR to HDR, export). */
  formats?: VideoFormat[];
  /** Depth maps: the colour maps it draws (params.colormap; see COLORMAPS). Unset = grayscale only. */
  colormaps?: string[];
  /** Depth maps: it can put the original clip next to the depth map (params.sideBySide). */
  sideBySide?: boolean;
  /** Remove background: what it can make (params.matteOutput), its default first. Unset = the cut-out. */
  matteOutputs?: MatteOutput[];
  /** Remove background keeps only what you name (SAM): words, or points clicked on the first frame, are needed. */
  keepsNamed?: boolean;
  /**
   * A keyer for footage shot on a green screen (CorridorKey 2.0, Bria green screen): listed in Video tools → Green
   * screen, kept out of Remove background's list.
   */
  greenScreen?: boolean;
  /** A cut-out that takes optional words about what to keep or drop (Bria's guided cut-out): the cut-out tools show a box for them. */
  guided?: boolean;
  /**
   * Frame rates it can reach (params.targetFps): FPS Boost's 24–120, an upscaler's 24 / 30 / 60. Without a
   * default target (`defaults.targetFps`) the clip's own frame rate is the first choice ("Original").
   */
  fpsTargets?: number[];
  /** Slow-motion factors it takes (params.slowdown; 1 = the clip's speed). */
  slowdowns?: number[];
  /**
   * How it reads a layout (src/lib/layout-prompt.ts): MOSS-Image's JSON boxes, FLUX.3's layout table, Ideogram 4's JSON
   * prompt or Bria FIBO 2's VGL location words. Unset: the layout goes in as plain sentences.
   */
  layout?: LayoutFormat;
}

/** The layout forms models read (ModelOptions.layout). */
export type LayoutFormat = "moss" | "flux3" | "ideogram" | "vgl";

export interface Pricing {
  unit: "image" | "second" | "video" | "request" | "megapixel" | "minute";
  usd: number;
  note?: string;
  /** The price per unit at each resolution (params.resolution), when it differs (Gemini Omni Flash: 360p $0.03/s … 4K $0.30/s); `usd` is the default resolution's. */
  byResolution?: Record<string, number>;
  /**
   * A launch price that runs to the end of `until` (UTC, YYYY-MM-DD); `usd` / `byResolution` are the list
   * prices after it (FLUX 3 Max: $0.0425/s until 2026-11-07, then $0.17/s). The catalog keeps both: whoever prices picks
   * the one that holds when it reads its clock (./promo: the server when it plans a run, the browser when it shows one).
   */
  promo?: { until: string; usd: number; byResolution?: Record<string, number> };
  /**
   * Price multipliers by a setting's value (Topaz 60 fps 2x, ByteDance Pro 10x, FLUX.3 Creative about 1.4x):
   * `param` is "targetFps" or a params.extra key (its control's default when unset); `values` maps a value to its factor.
   */
  factors?: { param: string; values: Record<string, number> }[];
  /** The price per unit when the run carries LoRAs and goes to the route's LoRA endpoint (fal's /lora variants cost more). */
  withLoras?: number;
  /**
   * The LoRA endpoint bills per megapixel of what it makes while the plain one bills per image (fal's FLUX 3 Klein: $0.012
   * per megapixel with LoRAs): a run with LoRAs costs this times the megapixels of the size the route sends.
   */
  withLorasPerMegapixel?: number;
  /** The LoRA endpoint publishes no price yet (fal's MOSS-Image /lora): a run with LoRAs is priced as unknown, never as free. */
  lorasUnknown?: true;
  /** withLoras at each resolution, when it differs (Fuobe Cinema's LTX-2.3 bills per megapixel of video). */
  withLorasByResolution?: Record<string, number>;
  /**
   * Billed per megapixel of video made, width × height × frames rounded up (fal's LTX-2.3): a per-second model whose
   * routes carry a size table and a frame count is priced on the clip's real size for its tier and shape and its frame
   * count, rather than on `usd` / `byResolution` (one shape's per-second rate). `withLoras`: the LoRA endpoint's rate.
   */
  videoMegapixel?: { usd: number; withLoras?: number };
  /** Per-megapixel prices billed on whole megapixels (fal's Qwen-Image 2512); per-minute prices on started minutes (ElevenLabs Music v2.5). */
  roundUp?: true;
  /**
   * Billed per clip by the steps it takes, on the variant a setting picks (fal's Kandinsky 6.0, a 5 s 480p clip: Pro $0.24 at
   * 8 steps, $0.56 at 20, $1.35 at 50; Lite $0.08 at 4, $0.16 at 10, $0.24 at 16). `prices[variant][op]` maps the step counts fal
   * publishes to a clip's price (linear between them); the variant is params.extra[variantKey], the steps params.extra[stepsKey],
   * each from the controls' `sets` when the run leaves them out. Replaces `usd` (the default's price) for a clip.
   */
  steps?: { variantKey: string; stepsKey: string; prices: Record<string, Partial<Record<Operation, Record<string, number>>>> };
  /**
   * Billed per megapixel of every frame made (fal's Kandinsky VSR: $0.00036 per output megapixel per frame): the clip's
   * size (params.sourceSize) times the factor asked (params.resolution "2x" / "2.25x" / "4x"), its frames at `fps` up to
   * `maxFrames` (params.sourceDuration). A clip whose size isn't known yet is priced as `assume` (480p, 16:9).
   */
  outputFrames?: { usd: number; fps: number; maxFrames: number; assume: { width: number; height: number } };
  /** The price per request when the run brings its own lyrics (params.extra.lyrics): Mureka bills a song from lyrics less than one it writes. */
  withLyrics?: number;
  /** What sending the song first costs when it isn't one of the provider's own (params.extra.songId): Mureka's files/upload, $0.01. */
  uploadUsd?: number;
  /** What an animation preset adds to a run (params.animation: Meshy rigging +$0.12). */
  animationUsd?: number;
  /**
   * A run with a clip going in (an edit's source, reference clips, video elements: Kling 4.0) bills this rate per second
   * of input plus output, at least twice the output (fal and Replicate: "2x output if input is shorter than output,
   * otherwise input + output"), in place of `usd` / `byResolution`. `plain`: billed on input + output with no floor
   * (fal's Seedance 2.5 reference-to-video: every second of a reference clip is billed with the output, at 0.6 times the
   * rate of a run without clips).
   */
  clipInput?: { usd: number; byResolution?: Record<string, number>; plain?: true };
  /**
   * A per-second price multiplied by `factor` for a result longer than `over` seconds (fal's H3 Max lip sync: 1.2× for a video
   * over 15 s, the whole video at the higher rate).
   */
  longFactor?: { over: number; factor: number };
  /** A fixed fee each request adds on top of its seconds (fal's H3 Max 3D to video: $0.50 processing). */
  perRequest?: number;
  /** The fewest seconds a per-second request bills (fal's H3 Max 3D to video: 5 s a shot). */
  minSeconds?: number;
  /**
   * A run sent no reference images draws up to `count` of its own, at `usd` each (fal's H3 Max 3D to video: up to 2 at
   * $0.10): priced at the most, through params.drawnRefs (set when the plan sees no images going in).
   */
  generatedRefs?: { usd: number; count: number };
}

/** A model's weights licence, as read in the research: information, never a gate (the owner's decision of 2026-10-27). */
export interface ModelLicence {
  /** As written ("FLUX.1 [dev] Non-Commercial License"). */
  licence: string;
  /** The weights allow selling outputs: true, false (non-commercial) or null (a revenue tier decides). */
  commercial: boolean | null;
  /** What else the research noted (fal's own terms for its hosted outputs). */
  note?: string;
  /** When it was read (YYYY-MM-DD). */
  checked?: string;
}

export interface ModelDef {
  id: string;
  name: string;
  vendor: string;
  family: string;
  engine: Engine;
  kind: MediaKind;
  tagline: string;
  badges?: Badge[];
  /**
   * The operations whose studios rank it in "Best for this studio" by its badges (bestForStudio), when not all of them: FLUX 3
   * Klein is a top pick for text to image, and the Edit studio offers it without changing its Best list. A studio's default
   * still leads its list.
   */
  bestOps?: Operation[];
  routes: ModelRoute[];
  options: ModelOptions;
  defaults?: Partial<Pick<GenParams, "aspectRatio" | "resolution" | "duration" | "numOutputs" | "generateAudio" | "voice" | "targetFps" | "format">>;
  pricing?: Pricing;
  /**
   * The licence of the open weights a hosted model runs (generated from the research), as information: nothing is
   * hidden or refused for it; the admin turns models on or off in Settings.
   */
  licence?: ModelLicence;
  /**
   * A Fuobe Original that runs on both engines: its routes cover ComfyUI and the hosted open weights on fal /
   * Replicate. `engine` is the one it shows first; a request picks one with GenerationRequest.engine, and
   * onEngine() (src/lib/catalog/engines.ts) gives the model as it runs there (that engine's routes only).
   */
  engines?: Engine[];
  /**
   * An Original's defaults on one engine, over `defaults` (Fuobe DoP: 480p on the user's GPU, where 720p takes three
   * times as long; 720p in the cloud, where the LoRA endpoint costs the same at either size).
   */
  engineDefaults?: Partial<Record<Engine, ModelDef["defaults"]>>;
  /**
   * An Original's options on one engine, over `options` (Fuobe DoP · LTX: no sound toggle on the user's GPU, whose
   * LTX-2.3 graphs make silent clips).
   */
  engineOptions?: Partial<Record<Engine, Partial<ModelOptions>>>;
  /**
   * What each engine runs when they differ, in one plain line (each engine does all it can, the cloud only on
   * hosted models, and the UI says so). Settings → Models & licences shows it under the model.
   */
  engineNote?: string;
  /** Hidden from pickers (used only internally by presets). */
  hidden?: boolean;
  /**
   * Open models whose workflow runs on the isolated ComfyUI worker (Settings → Isolated worker URL), not
   * the main server: the picker says so.
   */
  worker?: "isolated";
}

/** User-facing generation parameters (canonical, provider-agnostic). */
export interface GenParams {
  /** The input clip's size, when the caller knows it (Upscale's header read): what an upscale billed per output frame costs. */
  sourceSize?: { width: number; height: number };
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  numOutputs?: number;
  seed?: number;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
  /** Premade voice (TTS, voice change). */
  voice?: string;
  /** Voice design: the voice in words ("a warm, gravelly 60-year-old narrator"). */
  voiceDescription?: string;
  /** What the voice sample says: a closer clone (VoxCPM2's "ultimate" cloning, Qwen3-TTS's reference text). */
  voiceTranscript?: string;
  /** Dialogue lines, each with its own voice. */
  dialogue?: { text: string; voice?: string }[];
  /** Dubbing target language. */
  targetLanguage?: string;
  /** Multi-shot: shots in order (empty/undefined = one shot). "auto" lets the model cut by itself. */
  shots?: { prompt: string; duration: number }[];
  /**
   * @mentioned Elements as the model's elements (ModelOptions.elements, FieldMap.elements): each groups inputs.images by
   * index (0-based; the first is its frontal view), or names one of inputs.videos (a video element).
   */
  elements?: { images?: number[]; video?: number }[];
  /** Seconds of the reference clips that go in (Kling 4.0 bills them with the output: Pricing.clipInput). */
  clipSeconds?: number;
  /** References the provider draws itself because the run sends none (Pricing.generatedRefs); set by the plan. */
  drawnRefs?: number;
  multiShot?: "auto";
  /** Render a cheap draft first (Seedance 2.5 draft mode). */
  draft?: boolean;
  /** Finish this draft at full quality (op "finalize"). */
  draftId?: string;
  /** Trim: the part of the input video to keep, in seconds. */
  startTime?: number;
  endTime?: number;
  /** Output / sampling frame rate. */
  fps?: number;
  /** Colour palette as hex strings ("#1a2b3c"), Soul HEX / Cinema Studio palettes. */
  palette?: string[];
  /** A saved style id (Recraft style, Soul 2.0 moodboard). */
  styleId?: string;
  /** Language of the source speech (transcribe, dub); omit to detect. */
  sourceLanguage?: string;
  /** Layer decomposition: how many layers to ask for. */
  numLayers?: number;
  // Round 4.
  /** Points clicked on the first frame, in its pixels (remove-object, video-swap, 3D objects). */
  points?: PixelPoint[];
  /** Keyframes: when each image is reached, in seconds (one per image, ascending). */
  keyframeTimes?: number[];
  /** Codec / container to write (export-video, sdr-to-hdr). */
  format?: VideoFormat;
  /** Ken Burns: zoom at the start and end (1 = the whole picture, 1.25 = 25% closer), where it looks (0–1) and how it moves. */
  zoomFrom?: number;
  zoomTo?: number;
  panFrom?: FocusPoint;
  panTo?: FocusPoint;
  easing?: "linear" | "ease-in-out";
  /** Seconds of crossfade at each seam (audio-loop, audio-join). */
  crossfade?: number;
  /**
   * The input clip's length in seconds, when the caller knows it: how many plays a cloud loop needs, and how
   * many frames a frame-count route renders (LTX 2.3 clean plate / HDR, VOID; FieldMap.numFrames).
   */
  sourceDuration?: number;
  /**
   * The input clip's frame rate, when the caller knows it: what a clip edit billed by its frames costs (fal's Wan 2.2
   * Fun VACE bills frames ÷ 16; src/lib/catalog/clip-windows.ts). The server's header read wins over it.
   */
  sourceFps?: number;
  /** Extract every Nth frame. */
  frameInterval?: number;
  /** Frame interpolation: the frame rate to reach, and a slow-motion factor (1–8; 2 = twice as long). */
  targetFps?: number;
  slowdown?: number;
  /** Depth map colours: grayscale, turbo, inferno, magma or viridis. */
  colormap?: string;
  /** Depth maps: the original clip next to the result. */
  sideBySide?: boolean;
  /** Remove background: the cut-out (transparent video) or its alpha mask (black and white). */
  matteOutput?: MatteOutput;
  /** Overlay: where its centre goes (0–1 of the background) and its size (1 = its own size). */
  position?: FocusPoint;
  scale?: number;
  /** An animation preset for a rigged model (the provider's preset id). */
  animation?: string | number;
  /** A camera path's keyframes (N7-5, src/lib/camera-path.ts): the cloud route sends them as its trajectory. */
  cameraPath?: CameraKey[];
  /** Free-form advanced params forwarded to the provider payload. */
  extra?: Record<string, unknown>;
}

/**
 * What a LoRA's licence allows, as read on `snapshotDate` (docs/research/fuobe-originals-recipes-5.json).
 * A LoRA with no licence is the user's own (a trained identity or style).
 */
export interface LoraLicence {
  /** Outputs may be sold (civitai: the "Image" permission). */
  commercial: boolean;
  /** The weights may run on a third-party service such as fal or Replicate (civitai: "Rent"). false = the user's GPU only. */
  hostedOk: boolean;
  /** When the licence or the civitai permissions were read (YYYY-MM-DD). */
  snapshotDate: string;
  /** The licence as written ("Apache-2.0", "civitai permissions: Image, Rent, Sell"). */
  name?: string;
  /** civitai's permission list on that date (Image, RentCivit, Rent, Sell, SellMerge). */
  permissions?: string[];
}

export interface LoraRef {
  /** File name as placed in ComfyUI models/loras (unique there: civitai files are renamed, several are called V1.safetensors). */
  file: string;
  /** Where the file downloads from (a pinned civitai version or a Hugging Face file). */
  url?: string;
  strength?: number;
  trigger?: string;
  /** Wan 2.2 MoE: which expert gets the LoRA (fal's `transformer`). Wan 2.1 LoRAs go on both. */
  target?: "high" | "low" | "both";
  /** fal's `weight_name`: the file inside the repo or archive `url` names. */
  weightName?: string;
  /** A copy the cloud engine can fetch without the user's token (a mirror on fal or Replicate storage). */
  hostedUrl?: string;
  /**
   * The version the file is pinned to: a civitai model version id (never "latest": newer versions are often for
   * another base), or the Hugging Face commit its URL resolves at.
   */
  version?: string;
  licence?: LoraLicence;
  /**
   * The user's own trained LoRA (Fuobe Soul ID): Fuobe keeps the file, so a run copies it into ComfyUI's folder or
   * sends it to the cloud provider itself (src/server/loras.ts), whichever engine trained it.
   */
  own?: true;
  /**
   * Set by the server on a run's LoRAs while Settings → Models & licences keeps LoRAs licensed for your GPU only
   * off the cloud: a cloud route then leaves such a LoRA out (localOnly). Without it they are sent like any other.
   */
  keepOnGpu?: true;
  /**
   * The model's own adapter (Fuobe Restore's IC-LoRA): a run without it would be another model. A cloud run carries it
   * even from a gated Hugging Face repo, as Fuobe's copy made with the user's Hugging Face token, and refuses to start
   * without the token. Other gated LoRAs stay optional: a cloud run leaves them out with a note.
   */
  adapter?: true;
}

/** Scale limits of a LoRA field. */
export interface LoraRange {
  min: number;
  max: number;
}

/**
 * How a cloud API takes LoRAs (FieldMap.loras, generated from the research's hostedLoraEndpoints):
 * - "items": fal's `loras: [{path, scale, transformer?, weight_name?}]`, up to `max` (unset: none stated);
 *   `transformer` = the API's default expert when items take one (Wan 2.2, LTX-2.3 quality); `weightName`
 *   = items take a weight_name; `required` = the API refuses an empty list (LTX-2.3 22B);
 * - "arrays": Replicate's `lora_weights: [url]` + `lora_scales: [number]` (prunaai/z-image-turbo-lora);
 * - "experts": one LoRA per Wan 2.2 expert, each a URL field and a scale field (Replicate wan-2.2 fast);
 * - "single": one URL field and one scale field (Replicate qwen-image-edit-2511).
 */
export type LoraField =
  | { shape: "items"; key: string; max?: number; required?: boolean; range?: LoraRange; transformer?: "high" | "low" | "both"; weightName?: boolean }
  | { shape: "arrays"; weights: string; scales: string; max?: number; range?: LoraRange }
  | { shape: "experts"; high: { weights: string; scale: string }; low: { weights: string; scale: string }; range?: LoraRange }
  | { shape: "single"; weights: string; scale: string; range?: LoraRange };

/** What the UI posts to /api/generations. Asset references are local asset ids or URLs. */
export interface GenerationRequest {
  /**
   * Public sign-up: the account whose own ComfyUI runs this ("Your GPU"), never the install's providers. Set by the
   * server from the session only (the request schema drops it from what a client sends).
   */
  account?: string;
  /**
   * Server-only, like `account` (src/server/run-stamp.ts): the run goes to this install's GPUs ("pool", hosted runs);
   * the billing service's hold for it and the words of its charge; the moderation service sees its outputs first.
   */
  place?: "pool";
  hold?: string;
  charge?: string;
  checkOutputs?: boolean;
  /** How long a run on this install's GPUs may wait in line (ms), when the billing service set it. */
  waitMs?: number;
  feature: string;
  presetId?: string;
  modelId: string;
  op?: Operation;
  prompt?: string;
  negativePrompt?: string;
  inputs?: {
    images?: string[];
    endImage?: string;
    mask?: string;
    /** The first image with painted instructions: a red-tinted mask (inpaint) or drawn arrows/notes (draw to edit/video). */
    sketch?: string;
    video?: string;
    audio?: string;
    /** Second audio track: the background stem (or a music bed) mixed under `audio` (mux). */
    audio2?: string;
    /** Reference recording of the voice to speak with / convert into. */
    voiceAudio?: string;
    /** Second speaker's reference voice (open-source dialogue). */
    voiceAudio2?: string;
    /** Several clips in order (join clips), or reference videos (reference-to-video: Seedance, Cinema Studio). */
    videos?: string[];
    /** Reference audio clips (reference-to-video: voices, music or sound the clip should follow). */
    audios?: string[];
    /** A 3D model file (.glb) to work on (rig-3d, refine-3d). */
    model3d?: string;
  };
  params?: GenParams;
  /** Values for preset option pickers (apps). */
  presetOptions?: Record<string, string>;
  /** Motions/effects: how strongly the preset applies (0–1, default 1). */
  presetStrength?: number;
  /** Higgsfield's Mix: a second motion or effect on top of the first, with its own strength. */
  mix?: { presetId: string; strength: number };
  /** LoRAs added by @element mentions (trained identities, server-side), or a recipe's LoRAs sent by the evaluation harness. */
  loras?: LoraRef[];
  /**
   * The engine a model that runs on both (a Fuobe Original, ModelDef.engines) runs on: the composer's switch.
   * Unset: the install's engine mode, else the first one connected (your GPU before the cloud).
   */
  engine?: Engine;
  /** Chained jobs: where the previous job's image goes among `inputs.images` (one dependency). */
  chainFrom?: "first" | "last";
  /** Chained jobs with several dependencies: where each one's first output goes, in dependsOn order. */
  chain?: ChainSlot[];
  /** Server-set when the runner filled the chain slots from the earlier steps' outputs (a retry takes them out again: unfilledRequest). */
  chainFilled?: boolean;
  /**
   * Server-set when the runner left out optional chain slots whose steps failed (ChainSlot.optional): their indexes, and
   * the prompt the request had before the fallback replaced it (a retry puts it back).
   */
  chainSkipped?: { slots: number[]; prompt?: string };
  /** Server-set: what changed while the job ran (an optional input left out), said on the result and carried down the chain. */
  notice?: string;
  /**
   * A step only worth making for the steps after it (a per-frame render's frame edits and clips): while it still
   * waits for its inputs (nothing spent yet), the runner cancels it once every step that would use it has failed
   * or been canceled, so one failed frame doesn't leave the other lanes running up the bill.
   */
  dropWhenUnused?: boolean;
  /** Storyboard frame this request makes (shown under the frame). */
  /**
   * A storyboard frame. `look`: the board's Fuobe Soul look, whose grade and overlay every frame gets after it is made
   * (as meta, like a Soul picture); `crop`: a look board asked for 21:9 is made at 16:9 and cropped after.
   */
  frame?: {
    scene: string;
    index: number;
    of: number;
    look?: string;
    crop?: "21:9";
    /** A one-sheet board (src/lib/catalog/storyboard.ts planOneSheet): every panel on this one picture, cropped in the browser. */
    sheet?: { cols: number; rows: number; aspect: string; panels: { scene: string; box: [number, number, number, number] }[] };
  };
  /** Part of a multi-step job (a shot of a multi-shot film, a step of an extend): shown on its tile. */
  step?: { label: string; index: number; of: number };
  /**
   * Server-set: the picture of a look whose step after it (PixeletedFace's face mosaic) is the next step of the same run
   * (src/server/chains.ts createMosaicRun), so it doesn't start another.
   */
  postMade?: boolean;
  /**
   * Server-set: the take this run finishes in 2K (MiniMax H3's 2K tier, or "Finish in 2K" on a take; package n7-10), so a
   * take that has a 2K finish under way or made isn't offered another (src/server/cinema.ts finishTake).
   */
  finishOf?: string;
  /** Server-set: what the user calls this result, shown instead of the prompt (Library, feeds). */
  title?: string;
  /** Server-set: the name of the batch it belongs to (an Assist plan's summary): the Library stack's title. */
  batchTitle?: string;
  /**
   * Server-set: made by a run of a skill's recipe (src/lib/recipe.ts): the skill's name and the run's id (its batch), so
   * a run's history can be read back. Stripped from API input, like chainFilled.
   */
  skill?: { name: string; run: string };
  /**
   * Server-set: run on the demo provider whatever Settings → Demo mode says (a recipe's free dry run): chooseRoute
   * returns the demo route, and a waiting step runs as a demo after demo steps even with Demo mode off. Stripped from
   * API input.
   */
  demo?: boolean;
  /**
   * Server-set on the row a request that expanded into several rows returns first (a multi-shot film, a Frames film, an
   * extend on a model with no extend API, open text-to-3D, a DoP relight: src/server/chains.ts): the request as it was
   * asked, so a skill made from the result rebuilds that one request, not the steps it became (their number changes
   * with the input). Stripped from API input.
   */
  asked?: GenerationRequest;
  /**
   * The Image studio's style signature (Color signature + Moodboard chips): what was picked, the
   * sentences the server adds to the prompt (`prompt` keeps the user's own words), and the request as
   * it was before the signature routed it (Reuse restores that). See src/lib/catalog/palettes.ts.
   */
  signature?: SignatureRecord;
  /**
   * Server-set: when someone confirmed Soul ID's consent line for the real person this run shows (Turnaround video's
   * steps, src/server/turnaround.ts; a character trained with it carries its training's time). Stripped from API input.
   */
  consentAt?: number;
}

export interface ChainSlot {
  /**
   * "prompt" takes the dependency's text output (OutputFile.text): it replaces "{text}" in the
   * request's prompt, or becomes the prompt when there is no placeholder.
   * "voiceAudio" clones the voice of the dependency's audio output.
   * "audio2" is the second audio track (the background stem mixed under the new voice, mux).
   * "audios" is a list of audio clips (the spoken lines a timeline places at their start times).
   * "model3d" is a 3D model (a mesh to rig).
   * "mask" is what to change (remove-object): a mask video (SAM 3.1's track of the object), or a still mask of a
   * window's first frame (the open engine's painted eraser hands the tracked object on from window to window).
   */
  slot: "images" | "endImage" | "video" | "videos" | "audio" | "voiceAudio" | "audio2" | "audios" | "model3d" | "mask" | "prompt";
  /** For list slots: put it before or after the request's own items (default last). */
  position?: "first" | "last";
  /**
   * For list slots: the place it takes in the finished list (0-based) among the request's own items, instead of before or
   * after them. Slots with `at` go in after the others, in order of `at`, so each lands where it says: a keyframe film's
   * frames that earlier steps make (Turnaround video: the sides the Angles app draws go between the photo's own views).
   */
  at?: number;
  /**
   * Audio slots: take the dependency's output whose `meta.stem` is this (separate-audio makes
   * "voice" and "background", DBS also "music" and "effects"; "voice" also matches vocals/speech/target,
   * "background" also accompaniment/instrumental/residual/no_vocals, "effects" also sfx). Without it, the first
   * output of the slot's kind.
   */
  stem?: string;
  /**
   * Fan-out from a step that makes a list (extract-frames: one image per frame): take the dependency's
   * output number `index` of the slot's kind (0-based, by `meta.index` when the outputs carry it). Past
   * the end it takes the last one, so a provider that returns a frame or two fewer than planned holds the
   * last frame instead of failing the whole render (`of` bounds how many). One step per index fans a list out; a step with one slot
   * per index gathers it back in order.
   */
  index?: number;
  /**
   * With `index`: how many outputs the list was planned to have. A list more than CHAIN_LIST_SLACK short of it
   * fails the step before it runs (a frame or two lost at the clip's end is held; half a clip of frozen, paid
   * frames is not).
   */
  of?: number;
  /**
   * An input the step can do without (Genjutsu's anchor first frame): when the step it comes from fails or is canceled,
   * this step runs without it instead of failing. `prompt` then replaces the request's prompt (the words that named the
   * missing input go), and `notice` is said on the result and on the steps after it.
   */
  optional?: { prompt?: string; notice: string };
  /**
   * Take the picture as the model made it, before Fuobe Soul's finish in the browser (`meta.original`): a storyboard
   * with a look makes each next frame from the previous one, and every frame gets the look's grade on its own.
   */
  raw?: boolean;
  /**
   * "path" (a video slot): the server renders the step's camera path (params.cameraPath) through the
   * scene the dependency made from the step's still (MoGe 2's depth picture), and that render is the input: Uni3C's guide
   * when no browser has drawn one (Canvas, Assist, Fuobe DoP, Cinema's exact orbits). src/server/path-render.ts.
   */
  render?: "path";
}

/** How many outputs a planned list (ChainSlot.of) may be short of before the steps reading it fail. */
export const CHAIN_LIST_SLACK = 2;

/** Canonical, provider-ready input (asset refs already resolved to provider URLs/filenames). */
export interface GenInput extends GenParams {
  prompt?: string;
  negativePrompt?: string;
  images?: string[];
  endImage?: string;
  mask?: string;
  video?: string;
  audio?: string;
  /** Second audio track (mux: the background mixed under `audio`). */
  audio2?: string;
  voiceAudio?: string;
  voiceAudio2?: string;
  /** A saved voice's cloned embedding (fal's Qwen3-TTS), so the sample isn't cloned again (src/server/voices.ts). */
  voiceEmbedding?: string;
  videos?: string[];
  audios?: string[];
  model3d?: string;
  loras?: LoraRef[];
  /**
   * Server-filled from the input clip's header (generations.ts submit): its displayed size (upscale factors,
   * the upscale tier) and frame rate (open FPS Boost's m / n when the provider's own upload cache has none).
   */
  sourceSize?: { width: number; height: number };
  sourceFps?: number;
}

export type GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** Where a result is in review (the Library's review status; none when unset). */
export type ReviewStatus = "in-progress" | "needs-review" | "approved" | "rejected";

export interface OutputFile {
  url: string;
  /** Text outputs (transcribe, translate, write): the content, also saved as a file at `url`. */
  text?: string;
  /**
   * Structured extras a provider returned with this file: a layer's {name, z, bbox: [x, y, w, h]},
   * transcript cues [{start, end, text}], text blocks, a 3D model's preview…
   */
  meta?: Record<string, unknown>;
  /** Draft renders: the id to finish this take at full quality. */
  draftId?: string;
  kind: MediaKind;
  contentType?: string;
  width?: number;
  height?: number;
  assetId?: string;
}

export interface Generation {
  id: string;
  batchId: string | null;
  feature: string;
  presetId: string | null;
  modelId: string;
  engine: Engine;
  provider: ProviderId;
  op: Operation;
  kind: MediaKind;
  status: GenerationStatus;
  progress: number | null;
  message: string | null;
  prompt: string | null;
  request: GenerationRequest;
  outputs: OutputFile[];
  error: string | null;
  costUsd: number | null;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Display names resolved on the server, so result views need no catalog in the browser. */
  modelName?: string;
  presetName?: string | null;
  /** The aspect ratio it was made at (the request's, else the model's default), for tile shapes. */
  aspectRatio?: string | null;
  /** Moved to the Trash at (soft delete; purged after 30 days). */
  deletedAt?: number | null;
  /** Library folder it's in. */
  folderId?: string | null;
  /** Pinned to the top of the Library's views at (null: not pinned). */
  pinnedAt?: number | null;
  /** Review status (null: none). */
  review?: ReviewStatus | null;
  /**
   * A failed ComfyUI run that something missing on the GPU caused (a model file, a node class): its tile offers
   * "Fix it", which opens the GPU pre-flight's guided fix.
   */
  fix?: GenerationFix | null;
  /**
   * An account's failed run on its own GPU or key: why (the cause), a details line for the curious, and the buttons that
   * help (Start your pod, Check my GPU, Replace key…; src/lib/diagnose.ts). The plain sentence is `error`.
   */
  trouble?: RunTrouble;
  /** Failed or stopped before its paid provider took the job (no external id): the card says "Not billed", not its price. */
  notBilled?: true;
  /** Ran on this install's GPUs (hosted runs), not the account's own. */
  place?: "pool";
  /** The billing service's words for what a run on this install's GPUs costs ("7 units"); shown when it succeeded. */
  charge?: string;
  /** A run with a billing hold that failed or was stopped: nothing was charged. */
  notCharged?: true;
  /** "checking": its outputs wait for the moderation service before they show. */
  stage?: "checking";
  /** A run waiting for this install's GPUs: its place in line and the wait, about (GET /api/generations/<id>). */
  queue?: { place: number; etaSeconds: number | null };
  /**
   * What the run leaves out or changes, said when it is created (LoRAs a cloud run can't carry, a clip length
   * the API rounds). Only on the answer that creates it; not stored.
   */
  notes?: string[];
}

/** Why a ComfyUI run failed, when the GPU was missing something (generations.fix_json). */
export interface GenerationFix {
  code: "comfy_missing_model" | "comfy_missing_node" | "comfy_oom";
  workflowId?: string;
  items: { folder?: string; file?: string; class?: string; pack?: string }[];
}

/** Input slot a preset asks the user for. */
export interface InputSlot {
  key: "image" | "image2" | "image3" | "endImage" | "video" | "audio" | "mask" | "sketch" | "voiceAudio" | "voiceAudio2";
  label: string;
  hint?: string;
  accept: MediaKind;
  required?: boolean;
  /** A voice slot: offers "Clean up voice" (RE-USE on the open engine) under it, which cleans the file as it lands. */
  cleanVoice?: boolean;
  /** Shown only for a model that covers a song (ModelOptions.cover: YuE2 in Audio → Music); others never read it. */
  cover?: boolean;
}

export interface PresetChoice {
  value: string;
  label: string;
  /** Text substituted for {option:<key>} in the prompt template. */
  prompt: string;
  /** Model settings this choice sets (params.extra), e.g. the camera angle sliders of Qwen Multiple Angles; what the user set wins. */
  extra?: Record<string, number | string | boolean>;
  /** Settings only the open engine's graph reads (the Restore LoRA's strength), left out of a cloud run. */
  openExtra?: Record<string, number | string | boolean>;
}

export interface PresetOption {
  key: string;
  label: string;
  choices: PresetChoice[];
  default?: string;
}

export interface PresetRoute {
  modelId: string;
  op: Operation;
  params?: GenParams;
  loras?: LoraRef[];
  /** Overrides the preset prompt template for this engine. */
  promptTemplate?: string;
  /**
   * An app on Fuobe Soul, or on a graph that is Soul's own base (the Soul Cast sheet on your GPU): the look its words
   * run in, with the look's LoRAs (the AI Influencer app: the Realistic look).
   */
  look?: string;
  /**
   * A partner model running the preset's words because its Original has nothing of its own here yet (a Fuobe DoP move
   * with no hostable LoRA, camera LoRA, hosted move or step in the cloud keeps Kling 2.5 Turbo until the evaluation
   * harness promotes Fuobe DoP's words). Picking the preset doesn't move the composer to it; an engine switch does.
   */
  partner?: boolean;
  /** MiniMax H3's sound lines for this route's words (its overall_soundscape and non_diegetic_music fields). */
  sound?: { soundscape: string; music: string };
  /**
   * A step that makes the clip's end frame from the person's picture first, as the preset's preview made its own: the
   * clip then runs from the picture to that frame (start and end frames). Only when no end frame is given.
   */
  end?: PresetEndStep;
}

/** The end-frame step of a route (PresetRoute.end): an image edit of the start frame. */
export interface PresetEndStep {
  modelId: string;
  op: Operation;
  /** Its words: "{prompt}" and "{option:key}" fill as in the preset's own template. */
  promptTemplate: string;
  params?: GenParams;
}

/**
 * The recipe that made a preset's preview (src/lib/catalog/preset-recipe-book.json), written for any picture: the
 * preview's own subject and setting became "the subject" and "the scene", and the effect's words stayed.
 */
export interface PresetRecipeBook {
  /** A MiniMax H3 clip. */
  clip?: {
    /** fast: the 8-step Turbo graph; best: the 20-step graph; orbit: the Orbit LoRA (its training caption's words). */
    quality: "fast" | "best" | "orbit";
    /** The clip's length on H3's frame grid at 24 fps (3 s = 73 frames, 5 s = 124). */
    seconds: number;
    /** H3's [Shot 1] description (an orbit has none: ORBIT_WORDS). */
    words?: string;
    /** H3's overall_soundscape and non_diegetic_music. */
    sound?: string;
    music?: string;
    /** The end frame the clip runs to, made from the start frame first. */
    end?: PresetRecipeEdit;
  };
  /** An image app's result: the Qwen-Image 2.1 edit that made its preview. */
  edit?: PresetRecipeEdit;
}

/** A Qwen-Image 2.1 step of a recipe. */
export interface PresetRecipeEdit {
  /** turbo: its 8-step Turbo edit; full: its 25-step edit; expand: its outpaint (grey margins, filled). */
  graph: "turbo" | "full" | "expand";
  /** The instruction (expand: the words for the new margins). */
  prompt: string;
  /** The long side the pictures are scaled to first (the graphs' default is 2048). */
  maxDimension?: number;
  /** expand: the pixels added on the left, top, right and bottom. */
  pads?: [number, number, number, number];
  /** A crop of the picture first, as fractions of its width and height (x, y, width, height), scaled back to its size. */
  crop?: [number, number, number, number];
}

export type PresetType = "app" | "motion" | "effect";

export interface Preset {
  id: string;
  type: PresetType;
  name: string;
  category: string;
  description: string;
  /** Visual identity for the card when we have no media preview. */
  look: { icon: string; from: string; to: string };
  badges?: Badge[];
  inputs: InputSlot[];
  options?: PresetOption[];
  /** "{prompt}" = user text, "{option:key}" = selected option prompt. */
  promptTemplate: string;
  userPrompt: "none" | "optional" | "required";
  promptPlaceholder?: string;
  cloud: PresetRoute | null;
  open: PresetRoute | null;
  /**
   * More routes on your GPU after the open one, each its own pick in the app's model picker (the Angles app's QMA · 96 views):
   * a model the cloud has no hosted version of keeps its place on the open engine.
   */
  openAlso?: PresetRoute[];
  /** Research confidence / parity notes shown in docs and the UI. */
  parity?: string;
  /** Fuobe DoP's colour-grade effects: a src/lib/grade.ts preset the browser applies to the finished clip. */
  grade?: string;
  /** Fuobe DoP's relight effects: a step that makes the start frame first, on each engine (src/lib/catalog/dop.ts). */
  prestep?: PresetPrestep;
  /** An app that is a tool of its own: its page renders that tool rather than the composer (Clean up voice, Relight, Any Angle, Tap to Recolor, Watermark Remover). */
  tool?: "clean-voice" | "relight" | "any-angle" | "recolor" | "watermark";
  /** The recipe its preview was made with (src/lib/catalog/preset-recipe-book.json): the route it opens on follows it. */
  recipe?: PresetRecipeBook;
}

/**
 * A step whose picture becomes a preset's start frame (Fuobe DoP relights the still, or draws it in a Mixed Media look
 * on Fuobe Mixed Media, then animates it).
 */
export interface PresetPrestep {
  open: PrestepRoute;
  cloud: PrestepRoute;
}

export interface PrestepRoute {
  modelId: string;
  op: Operation;
  prompt: string;
  loras?: LoraRef[];
  /** The step's own settings (Fuobe Mixed Media: its seed, control scale or strength). */
  params?: GenParams;
  /** What the step and the clip after it are called in a run ("Start frame in the look", "Restyled clip"); relight's when unset. */
  labels?: { step: string; clip: string };
  /** What the step costs (a 1-megapixel picture), added to the clip's price before the run; 0 on the user's GPU. */
  usd?: number;
}

/** Route endpoint for models without an extend API: last frame → image-to-video → join (src/server/chains.ts). */
export const LAST_FRAME_CHAIN = "chain:last-frame";
