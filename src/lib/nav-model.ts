/**
 * The navigation's one model: every place the top bar, the Studios launcher, the phone tabs and sheets, the search
 * palette, Home's goal row and the next steps under a result link to. Pure data and helpers (no React, no icons as
 * components, no catalog), so the server and the browser share it: icons are names (src/lib/nav-icons.ts maps them),
 * covers are preset ids (src/lib/nav-covers.ts resolves them on the server). Every href is a route that exists; none
 * is renamed here.
 */
import GPU_TESTED from "../../workflows/comfyui/gpu-tested.json";
import { HUB_MODES, modeHref, type HubKind } from "./hubs";
import { navActive, NEW_CREATION_HREF } from "./nav";

export type ViewerKind = "guest" | "account" | "owner";
/** "area": a page that shows everything one of the bar's menus holds (/create, /studios, /motions-and-effects). */
export type NavKind = "home" | "action" | "create" | "studio" | "presets" | "tool" | "library" | "settings" | "area";
/** Launcher columns, the Studios sheet chips and the palette's "Every studio" chips. */
export type LauncherGroupId = "film" | "social" | "sell" | "people" | "sound" | "finish";
/** The goal row on Home. An entry can serve several goals. */
export type GoalId = "film" | "social" | "sell" | "people" | "edit" | "sound";
/** A key of NAV_ICONS (src/lib/nav-icons.ts), where it is typed as keyof typeof NAV_ICONS. */
export type NavIconName = string;

export interface NavEntry {
  /** Stable slug, unique ("cinema", "audio-clean", "setting-comfyui"). */
  id: string;
  /** An existing route; may carry a query (/library?tab=favorites) or a hash (/settings#comfyui). */
  href: string;
  label: string;
  /** Phone tile label, 12 characters at most. */
  short?: string;
  /** One line, 34 characters at most, sentence case, no full stop. */
  what: string;
  /**
   * The sentence under its cover card on an area page (/create, /studios): 64 characters at most, sentence case, a full
   * stop at the end. Home's own line wins where Home has a card for the same page (HOME_STUDIOS).
   */
  line?: string;
  kind: NavKind;
  /** Set: it is in the launcher, the Studios sheet and "Every studio". */
  group?: LauncherGroupId;
  /** The group's lead card (one per group). */
  lead?: true;
  /** Goal bands it can appear in. */
  goals: GoalId[];
  /** Search words: what people type for it that its label doesn't say. */
  keywords: string;
  /** A preset id with a real cover, or a studio's own cover (studio-covers.ts): either way in PRESET_COVERS. */
  cover?: string;
  icon: NavIconName;
  /** Who sees it anywhere (bar, menus, sheets, search, next steps). Omitted: everyone. */
  visibility?: readonly ViewerKind[];
  /** First in "Every studio" before a search, and among the featured studios. */
  popular?: true;
  /** ISO date: a "New" badge until then. */
  newUntil?: string;
  /** Prefetched as soon as it's on screen: the few routes most visits start from. */
  eager?: true;
  /** A tool's studio id ("audio" for audio-clean): search shows "Audio › Clean up voice". */
  parent?: string;
  /**
   * A tool's name on its studio's own tab, where its label says more for search ("Upscale video" is the Upscale tab
   * "Video"): the links under its studio show this one.
   */
  tab?: string;
}

export interface LauncherGroup {
  id: LauncherGroupId;
  label: string;
  chip: string;
}

export interface Goal {
  id: GoalId;
  label: string;
  icon: NavIconName;
  title: string;
  line: string;
  /** "Studios" | "Tools" | "Audio and voice". */
  cardsLabel: string;
  /** 4-5 NavEntry ids (4:3 cover cards). */
  cards: string[];
  tapLabel: string;
  /** 2-4 listed presets. */
  taps: { preset: string; kind: "App" | "Camera motion" | "Effect" }[];
  /** "Finish" | "Picture tools". */
  finishLabel: string;
  /** 2-3 NavEntry ids (text links). */
  finish: string[];
  /** Show "Plan it with Assist" (to the owner only). */
  assist?: true;
}

const OWNER: readonly ViewerKind[] = ["owner"];
const ACCOUNT: readonly ViewerKind[] = ["account"];
const GUEST: readonly ViewerKind[] = ["guest"];
const VISITORS: readonly ViewerKind[] = ["guest", "account"];

/**
 * Genjutsu's Finish mode is everyone's once one of its tools (Fix faces, Fix colours) has passed its GPU test, as the
 * studio's page shows it (modeOpen in src/lib/catalog/genjutsu.ts, from src/server/genjutsu-live.ts, which reads the
 * same record with the workflows' manifest; tests/nav-subfeatures.test.ts holds the two to the same answer). Until
 * then its link is the owner's.
 */
const passedOnGpu = (feature: string) => (GPU_TESTED.features as Record<string, { passed?: boolean } | undefined>)[feature]?.passed === true;
const FINISH_OPEN = passedOnGpu("finish-faces") || passedOnGpu("finish-colours");

/** Where the source lives (as connections.ts says it; kept here so this module imports nothing heavy). */
const REPO = "https://github.com/workingprototype/fuobe";
/** A "do this" entry that isn't a page: the palette toggles the theme. */
export const THEME_ACTION = "action:theme";

/**
 * "New" badges: a studio added after the first ones shows one for 30 days from the day its page was added (its
 * route's first commit). The first studios (the first week) never do.
 */
const newFor30Days = (added: string) => new Date(Date.parse(added) + 30 * 86_400_000).toISOString().slice(0, 10);

/** Top level, create, presets, library and settings pages. */
const PAGES: NavEntry[] = [
  { id: "home", href: "/", label: "Home", what: "Start from words or a picture", kind: "home", goals: [], keywords: "start new creation home", icon: "Home", eager: true },
  { id: "new", href: NEW_CREATION_HREF, label: "New creation", what: "A fresh composer on Home", kind: "action", goals: [], keywords: "new creation start fresh blank compose", icon: "Plus" },
  { id: "assist", href: "/assist", label: "Assist", what: "Plan it with an agent", kind: "create", goals: [], keywords: "agent chat plan assistant ai helper", icon: "MessageCircle", eager: true },
  { id: "image", href: "/image", label: "Image", what: "Text to image", kind: "create", goals: [], keywords: "text to image picture photo generate", cover: "app-poster", icon: "ImageIcon", eager: true, popular: true },
  { id: "video", href: "/video", label: "Video", what: "Text or image to video", kind: "create", goals: ["film"], keywords: "text to video image to video animate clip", cover: "motion-fpv-drone", icon: "Video", eager: true, popular: true },
  { id: "edit", href: "/edit", label: "Edit", what: "Change a picture with words", kind: "create", goals: ["edit"], keywords: "edit image change photo retouch", cover: "app-relight", icon: "Wand2" },
  { id: "live-edit", href: "/live-edit", label: "Live edit", what: "Changes as you type", kind: "create", goals: ["edit"], keywords: "realtime live as you type instant change", icon: "Zap", newUntil: newFor30Days("2026-11-01") },
  { id: "inpaint", href: "/inpaint", label: "Inpaint", what: "Paint over a part", kind: "create", goals: ["edit", "people"], keywords: "mask fill remove brush fix", cover: "app-change-background", icon: "Brush" },
  { id: "layers", href: "/layers", label: "Layers", what: "Split a picture into layers", kind: "create", goals: ["edit"], keywords: "layered psd split cutout", cover: "app-packshot", icon: "Layers2" },
  { id: "color-grade", href: "/color-grade", label: "Color grading", what: "Grade and match colors", kind: "create", goals: ["edit", "film"], keywords: "grade lut colour color", cover: "app-color-grading", icon: "SlidersHorizontal" },
  { id: "canvas", href: "/canvas", label: "Canvas", what: "Wire models together", kind: "create", goals: [], keywords: "nodes flow workflow graph", icon: "Network" },
  { id: "motions", href: "/motions", label: "Camera motions", what: "Crane and drone moves for any shot", kind: "presets", goals: ["film"], keywords: "camera moves presets dolly crane drone orbit", cover: "motion-crane-up", icon: "Film" },
  { id: "effects", href: "/effects", label: "Effects", what: "Cinematic effects from one photo", kind: "presets", goals: ["film", "social"], keywords: "vfx presets visual effects", cover: "effect-nature-bloom", icon: "Sparkles" },
  { id: "library", href: "/library", label: "All creations", what: "Everything you have made", kind: "library", goals: [], keywords: "library history results creations", icon: "Library", eager: true },
  { id: "favorites", href: "/library?tab=favorites", label: "Favorites", what: "The ones you starred", kind: "library", goals: [], keywords: "starred liked", icon: "Star" },
  { id: "settings", href: "/settings", label: "Settings", what: "Account, GPU and preferences", kind: "settings", goals: [], keywords: "account gpu preferences", icon: "Settings" },
  { id: "connect", href: "/connect", label: "Connect your GPU", what: "Run on your own ComfyUI, free", kind: "settings", goals: [], keywords: "comfyui gpu own server sign up account open source", icon: "Cpu", visibility: VISITORS },
  {
    id: "models-licences",
    href: "/settings/models",
    label: "Models & licences",
    what: "Switch models on or off",
    kind: "settings",
    goals: [],
    keywords: "licence license commercial non-commercial switch off turn on admin providers node packs allow block",
    icon: "Scale",
    visibility: OWNER,
  },
  {
    id: "thanks",
    href: "/settings/licences",
    label: "Thanks & licences",
    what: "The open models Fuobe is built on",
    kind: "settings",
    goals: [],
    keywords: "about credits thanks licence license open source models loras node packs libraries attribution",
    icon: "Heart",
  },
];

/** The launcher's studios (and Apps), column by column; each column's lead first. */
const STUDIOS: NavEntry[] = [
  // Film & video
  { id: "cinema", href: "/cinema", label: "Cinema Studio", short: "Cinema", what: "Direct shots like a film set", kind: "studio", group: "film", lead: true, goals: ["film"], keywords: "film director shots movie cinematic scene", cover: "motion-arc-left", icon: "Clapperboard", popular: true },
  { id: "storyboard", href: "/storyboard", label: "Storyboard", short: "Storyboard", what: "Plan a film frame by frame", kind: "studio", group: "film", goals: ["film"], keywords: "frames story plan shots", cover: "app-shots", icon: "GalleryHorizontal" },
  { id: "motion-control", href: "/motion-control", label: "Motion control", short: "Motion", what: "Copy any dance or pose", kind: "studio", group: "film", goals: ["film", "people"], keywords: "pose dance transfer choreography", cover: "motion-static", icon: "PersonStanding" },
  { id: "extend", href: "/extend", label: "Extend video", short: "Extend", what: "Make a clip longer", kind: "studio", group: "film", goals: ["film", "edit"], keywords: "longer continue lengthen", cover: "motion-aerial-pullback", icon: "FastForward" },
  { id: "reframe", href: "/reframe", label: "Reframe", short: "Reframe", what: "Any shape, vertical first", kind: "studio", group: "film", goals: ["film", "social", "edit"], keywords: "aspect ratio outpaint vertical crop resize", cover: "app-expand-image", icon: "Crop" },
  { id: "video-edit", href: "/video-edit", label: "Edit video", short: "Edit video", what: "Restyle a clip with words", kind: "studio", group: "film", goals: ["film", "edit"], keywords: "video edit restyle change clip", cover: "effect-outfit-switch", icon: "Scissors" },
  { id: "katana", href: "/katana", label: "Katana", short: "Katana", what: "Cut clips into a story", kind: "studio", group: "film", goals: ["film"], keywords: "cut edit clips timeline montage", cover: "app-clipcut", icon: "Swords" },
  {
    id: "video-tools",
    href: "/video-tools",
    label: "Video tools",
    short: "Video tools",
    what: "Trim, matte, depth, captions",
    kind: "studio",
    group: "film",
    goals: ["film", "edit"],
    keywords: "join trim matte depth captions evolution remove object restore colourise colorize archive old footage black and white",
    cover: "app-video-background-remover",
    icon: "Layers",
  },
  // Social & shorts
  { id: "shorts", href: "/shorts", label: "Shorts Studio", short: "Shorts", what: "Vertical reels ready to post", kind: "studio", group: "social", lead: true, goals: ["social"], keywords: "vertical reels tiktok short instagram", cover: "motion-catwalk", icon: "Smartphone", popular: true },
  { id: "faceless", href: "/faceless", label: "Faceless Studio", short: "Faceless", what: "A channel without a face", kind: "studio", group: "social", goals: ["social"], keywords: "youtube channel episodes faceless", cover: "motion-hyperlapse", icon: "Tv" },
  { id: "content-factory", href: "/content-factory", label: "Content Factory", short: "Content", what: "A series from one brief", kind: "studio", group: "social", goals: ["social", "sell"], keywords: "series reference brief episodes batch", cover: "app-transitions", icon: "Factory", newUntil: newFor30Days("2026-10-24") },
  { id: "lipsync", href: "/lipsync", label: "Lipsync & avatars", short: "Lipsync", what: "A photo that talks", kind: "studio", group: "social", goals: ["social", "sound", "people"], keywords: "talking avatar lip sync speak presenter", cover: "app-talking-photo", icon: "Mic2", popular: true },
  { id: "explainer", href: "/explainer", label: "Explainer", short: "Explainer", what: "Slides into a video", kind: "studio", group: "social", goals: ["social"], keywords: "slides pdf video presentation tutorial", cover: "app-breakdown", icon: "Presentation" },
  { id: "virality", href: "/virality", label: "Hook check", short: "Hook check", what: "Score your first 3 seconds", kind: "studio", group: "social", goals: ["social"], keywords: "virality predictor hook score retention", cover: "app-hook-frame", icon: "TrendingUp" },
  // Sell & advertise
  { id: "marketing", href: "/marketing", label: "Marketing Studio", short: "Marketing", what: "UGC and product films", kind: "studio", group: "sell", lead: true, goals: ["sell"], keywords: "ugc product ads commercial brand", cover: "app-macroshot-product", icon: "Megaphone", popular: true },
  { id: "ads", href: "/ads", label: "Ads Studio", short: "Ads", what: "Campaigns in every size", kind: "studio", group: "sell", goals: ["sell"], keywords: "brand campaign advert banner sizes", cover: "app-billboard-ad", icon: "Target" },
  { id: "kinetic", href: "/kinetic", label: "Fuobe Kinetic Motion", short: "Kinetic", what: "Brand motion graphics", kind: "studio", group: "sell", goals: ["sell", "social"], keywords: "kinetic motion graphics animated text typography titles end card logo sting stat quote", cover: "kinetic-runway-titles", icon: "LetterText", newUntil: newFor30Days("2026-11-03") },
  { id: "mixed-media", href: "/mixed-media", label: "Mixed Media", short: "Mixed Media", what: "Collage, paint and photo", kind: "studio", group: "sell", goals: ["sell", "film"], keywords: "collage paint scrapbook", cover: "effect-magazine", icon: "Shapes" },
  { id: "moodboards", href: "/moodboards", label: "Moodboards", short: "Moodboards", what: "Lock a look, reuse it", kind: "studio", group: "sell", goals: ["sell", "people"], keywords: "style references mood look", cover: "app-steal-the-look", icon: "Images" },
  { id: "photodump", href: "/photodump", label: "Photodump", short: "Photodump", what: "A photo pack of one person", kind: "studio", group: "sell", goals: ["sell", "people", "social"], keywords: "photo pack character photoshoot", cover: "app-headshot-generator", icon: "Camera" },
  // People & fashion
  { id: "fashion-factory", href: "/fashion-factory", label: "Fashion Factory", short: "Fashion", what: "Outfits, try-ons, lookbooks", kind: "studio", group: "people", lead: true, goals: ["people", "sell"], keywords: "outfits try-on lookbook dress clothes fashion", cover: "app-outfit-swap", icon: "Shirt", popular: true },
  { id: "influencer", href: "/influencer", label: "AI Influencer", short: "Influencer", what: "Build a character", kind: "studio", group: "people", goals: ["people", "social"], keywords: "character builder avatar creature shuffle", cover: "app-ai-influencer", icon: "UserRoundPen", newUntil: newFor30Days("2026-10-24") },
  { id: "character-sheet", href: "/character-sheet", label: "Character Sheet", short: "Character sheet", what: "One face, every angle", kind: "studio", group: "people", goals: ["people"], keywords: "turnaround angles consistent", cover: "app-fuobe-angles", icon: "UserRoundCog" },
  {
    id: "character-swap",
    href: "/character-swap",
    label: "Character Swap",
    short: "Character swap",
    what: "Swap the star of a clip",
    kind: "studio",
    group: "people",
    goals: ["people", "edit", "film"],
    keywords: "h3 akatz swap character whole clip shots segments takes",
    cover: "app-character-swap",
    icon: "Drama",
    newUntil: newFor30Days("2026-10-27"),
  },
  { id: "genjutsu", href: "/genjutsu", label: "Genjutsu", short: "Genjutsu", what: "Insert or swap anyone", kind: "studio", group: "people", goals: ["people", "edit"], keywords: "swap insert character motion transfer", cover: "genjutsu-group-swap", icon: "WandSparkles", newUntil: newFor30Days("2026-10-23") },
  { id: "elements", href: "/elements", label: "Elements", short: "Elements", what: "Your people, places, props", kind: "studio", group: "people", goals: ["people", "film"], keywords: "characters places props", cover: "app-figurine", icon: "AtSign" },
  // Sound (the Audio studio leads; its main modes follow it, from HUB_TOOLS)
  {
    id: "audio",
    href: "/audio",
    label: "Audio",
    short: "Audio",
    what: "Voice, music and dubbing",
    kind: "studio",
    group: "sound",
    lead: true,
    goals: ["sound"],
    keywords: "voice voiceover tts text to speech narration music sfx dub transcribe sound",
    cover: "app-asmr-host",
    icon: "AudioLines",
  },
  // Finish & convert
  { id: "upscale", href: "/upscale", label: "Upscale", short: "Upscale", what: "Sharper images and video", kind: "studio", group: "finish", lead: true, goals: ["edit"], keywords: "enhance resolution 4k sharpen", cover: "app-upscale", icon: "ZoomIn" },
  { id: "image-to-3d", href: "/image-to-3d", label: "Image to 3D", short: "Image to 3D", what: "A model you can turn", kind: "studio", group: "finish", goals: ["edit", "sell"], keywords: "3d mesh glb model", cover: "app-3d-rotation", icon: "Box" },
  { id: "apps", href: "/apps", label: "Apps", short: "Apps", what: "One-tap photo and clip tools", kind: "presets", group: "finish", goals: ["social", "sell", "people"], keywords: "one-click tools one tap", cover: "app-3d-figure", icon: "LayoutGrid" },
];

/** What each hub mode does, and the words people type for it. */
const TOOL_COPY: Record<string, { what: string; keywords: string; cover?: string; label?: string; short?: string }> = {
  "upscale-image": { what: "Sharper, larger pictures", keywords: "photo picture enhance 4k 8k sharpen resolution" },
  "upscale-video": { label: "Upscale video", what: "Sharper, larger clips", keywords: "4k 8k enhance clip restore faces resolution" },
  "upscale-fps": { what: "Smoother motion", keywords: "frame interpolation 60fps 120fps slow motion slowmo" },
  "upscale-hdr": { what: "10-bit HDR from any clip", keywords: "sdr hdr hdr10 exr prores 10 bit" },
  "upscale-export": { what: "ProRes and lossless files", keywords: "export prores h265 ffv1 exr codec deliver master" },
  "audio-speech": { what: "Text to speech in any voice", keywords: "tts voiceover narration read aloud clone voice" },
  "audio-dialogue": { what: "A conversation, one voice each", keywords: "conversation podcast two speakers multi voice" },
  "audio-voice-change": { what: "Swap the voice, keep the timing", keywords: "voice changer convert speech to speech" },
  "audio-design": { what: "A new voice from a few words", keywords: "voice design create custom new voice describe" },
  "audio-edit-speech": { what: "Change the words, keep the voice", keywords: "edit speech words fix line respeak overdub pitch pace mood whisper" },
  "audio-translate": { what: "Dub into any language", keywords: "dub dubbing localize translate lip sync", cover: "app-asmr-promo", label: "Translate & dub", short: "Translate" },
  "audio-transcribe": { what: "Words from any clip", keywords: "subtitles text speech to text srt vtt captions" },
  "audio-clean": { what: "Remove noise and echo", keywords: "denoise podcast mic fix reverb enhance speech", cover: "app-clean-up-voice", short: "Clean up" },
  "audio-split": { what: "Voice and music apart", keywords: "stems karaoke separate vocals instrumental" },
  "audio-sfx": { what: "Sound effects from words", keywords: "sfx foley whoosh sound effect", cover: "app-asmr-add-on", short: "Sound effects" },
  "audio-music": { what: "A track from a few words", keywords: "song soundtrack beat jingle background music score", cover: "effect-live-concert", short: "Music" },
  "audio-song": { what: "Extend, remix or split a song", keywords: "song extend remix stems lyrics longer vocals mureka" },
  "audio-loop": { what: "Loop or lengthen a track", keywords: "loop extend longer repeat" },
  "audio-join": { what: "Join sounds into one", keywords: "merge combine concatenate audio" },
  "audio-video": { what: "Sound that fits the picture", keywords: "foley sfx v2a video to audio", cover: "app-asmr-classic" },
  "video-tools-matte": { what: "Cut out the background", keywords: "remove background green screen alpha matte rotoscope" },
  "video-tools-green-screen": { what: "Key out a green screen", keywords: "chroma key keyer green screen despill alpha matte" },
  "video-tools-remove-object": { what: "Erase anything from a clip", keywords: "erase clean plate inpaint video object" },
  "video-tools-remove-person": { what: "Take a person out of a clip", keywords: "erase person people remove someone clean plate" },
  "video-tools-remove-dialogue": { what: "Keep the sound, lose the words", keywords: "speech mute voice keep music" },
  "video-tools-evolution": { what: "One shot that morphs over time", keywords: "morph transformation timelapse ageing" },
  "video-tools-restore": { what: "Old footage, sharp and in color", keywords: "colourise colorize archive old footage black and white" },
  "video-tools-relight": { what: "New light on any clip", keywords: "lighting golden hour neon" },
  "video-tools-depth": { what: "A depth map of every frame", keywords: "depth map z pass parallax compositing" },
  "video-tools-captions": { what: "Burned-in captions", keywords: "subtitles srt captions text" },
  "video-tools-trim": { what: "Cut a clip to length", keywords: "cut shorten" },
  "video-tools-join": { what: "Cut clips together", keywords: "merge combine clips" },
  "video-tools-colors": { what: "Match colors to a picture", keywords: "match colors colour palette grade" },
};

const HUB_ORDER: HubKind[] = ["upscale", "audio", "video-tools"];
const HUB_ICON: Record<HubKind, NavIconName> = { upscale: "ZoomIn", audio: "AudioLines", "video-tools": "Layers" };

/**
 * The Sound column: the Audio studio, then its main modes in this order, Clean up voice (the studio's first mode) first.
 * These modes are in the launcher, the Studios sheet and "Every studio" as well as in search.
 */
const SOUND_COLUMN = ["audio", "audio-clean", "audio-music", "audio-sfx", "audio-translate"];

/**
 * A hub's first mode with a row of its own in the menus (Audio's Clean up voice): its own page (/audio/clean, the same
 * tool as /audio), so its row and the studio's card don't share a link.
 */
const OWN_PAGE = new Set(["audio-clean"]);

/** Every hub mode as a tool of its studio (found by search, linked from the goal bands). */
const HUB_TOOLS: NavEntry[] = HUB_ORDER.flatMap((hub) =>
  HUB_MODES[hub].map((m): NavEntry => {
    const id = `${hub}-${m.id}`;
    const copy = TOOL_COPY[id];
    return {
      id,
      href: OWN_PAGE.has(id) ? `/${hub}/${m.id}` : modeHref(hub, m.id),
      label: copy?.label ?? m.label,
      ...(copy?.label && copy.label !== m.label && { tab: m.label }),
      what: copy?.what ?? m.label,
      kind: "tool",
      goals: [],
      keywords: copy?.keywords ?? "",
      // Its studio's icon: in search a tool shows its studio's cover (or its own), so the bar's code carries no extra icons.
      icon: HUB_ICON[hub],
      parent: hub,
      ...(copy?.cover && { cover: copy.cover }),
      ...(copy?.short && { short: copy.short }),
      ...(SOUND_COLUMN.includes(id) && { group: "sound" as const, goals: ["sound" as const] }),
      ...(m.ownerOnly && { visibility: OWNER }),
    };
  }),
);

/** Pages inside a studio that people look for by name (labels as the studio's own tabs say them). */
const SUB_TOOLS: NavEntry[] = [
  { id: "marketing-click-to-ad", href: "/marketing/click-to-ad", label: "Click to Ad", what: "From a product link to an ad", kind: "tool", goals: [], keywords: "product link url to ad shop page amazon", icon: "Megaphone", parent: "marketing" },
  // A tab of Marketing Studio's suite (Marketing Studio · Click to Ad · Ads Studio · Ad Multiplier), so its studio is that one.
  { id: "ads-multiplier", href: "/ads/multiplier", label: "Ad Multiplier", what: "One ad in many versions", kind: "tool", goals: [], keywords: "variations versions sizes multiply ads studio", icon: "Target", parent: "marketing" },
  { id: "assist-skills", href: "/assist/skills", label: "Skills", what: "Reusable recipes", kind: "tool", goals: [], keywords: "skill recipe playbook automation", icon: "MessageCircle", parent: "assist" },
  // An app with a page of its own that Create lists: a tool of Apps, so the bar marks Apps on its page.
  { id: "any-angle", href: "/apps/app-any-angle", label: "Any Angle", what: "See it from any angle", kind: "tool", goals: [], keywords: "angle rotate turn view camera viewpoint orbit 3d", cover: "app-any-angle", icon: "Rotate3d", parent: "apps" },
];

/** A feature inside a studio: one of its tabs or modes, opened by its own link. */
const feature = (parent: string, icon: NavIconName, id: string, href: string, label: string, what: string, keywords: string, visibility?: readonly ViewerKind[]): NavEntry => ({
  id: `${parent}-${id}`,
  href,
  label,
  what,
  kind: "tool",
  goals: [],
  keywords,
  icon,
  parent,
  ...(visibility && { visibility }),
});

/**
 * The modes and tabs inside the studios that have no page of their own, each opened by its link (?mode=, ?tab=):
 * Genjutsu (src/lib/catalog/genjutsu.ts), Character Sheet, Image to 3D (src/lib/av/model3d.ts), Photodump, Cinema
 * Studio, Canvas and Assist. Labels are the studio's own (a test holds them to it).
 */
const STUDIO_FEATURES: NavEntry[] = [
  ...(
    [
      ["motion", "Motion transfer", "Your character, moving as filmed", "motion transfer move copy movement dance performance replace person"],
      ["character", "Character swap", "Your character takes over a part", "character swap replace person face actor recast one part"],
      ["swap", "Object swap", "Swap a thing or an outfit", "object swap replace thing product outfit clothes"],
      ["restyle", "Restyle", "A new look on every frame", "restyle style look anime clay painting filter"],
      ["insert", "Insert", "Add something to the shot", "insert add object put into clip place"],
    ] as const
  ).map(([id, label, what, kw]) => feature("genjutsu", "WandSparkles", id, `/genjutsu?mode=${id}`, label, what, kw)),
  feature("genjutsu", "WandSparkles", "picture", "/genjutsu?mode=picture", "From picture", "Your picture's setting, moving", "from picture photo setting animate motion"),
  feature("genjutsu", "WandSparkles", "finish", "/genjutsu?mode=finish", "Finish", "Fix faces and colours", "finish fix faces colours colors", FINISH_OPEN ? undefined : OWNER),
  ...(
    [
      ["reference", "From Reference", "A sheet from your photos", "reference photo upload face sheet"],
      ["cast", "Build from scratch", "Pick every trait yourself", "build scratch cast traits face body"],
      ["describe", "From a description", "A sheet from a few words", "describe description words text prompt"],
    ] as const
  ).map(([id, label, what, kw]) => feature("character-sheet", "UserRoundCog", id, `/character-sheet?mode=${id}`, label, what, kw)),
  ...(
    [
      ["image", "From an image", "One photo to a 3D model", "photo picture image to 3d glb"],
      ["multi", "From several images", "Photos from 2 to 4 sides", "multi view several photos sides 3d"],
      ["text", "From text", "Describe one object", "text to 3d describe words"],
      ["objects", "Pick an object", "One object out of a photo", "segment pick object out of photo 3d"],
      ["splat", "Splat", "A soft, photoreal 3D capture", "gaussian splat capture photoreal"],
    ] as const
  ).map(([id, label, what, kw]) => feature("image-to-3d", "Box", id, `/image-to-3d?mode=${id}`, label, what, kw)),
  feature("photodump", "Camera", "instadump", "/photodump?tab=instadump", "From a selfie", "A photo pack from one selfie", "instadump selfie one photo pack instagram"),
  feature("cinema", "Clapperboard", "blockout", "/cinema?blockout=1", "Blockout", "Block a scene out in 3D", "blockout block out 3d layout previs scene"),
  feature("canvas", "Network", "skills", "/canvas?tab=skills", "Skills as canvases", "Assist's skills, drawn as boards", "skills recipes boards assist canvas", OWNER),
  feature("assist", "MessageCircle", "memory", "/assist/memory", "Memory", "What Assist remembers", "memory remember facts notes", OWNER),
  feature("assist", "MessageCircle", "scheduled", "/assist/scheduled", "Scheduled", "Tasks that run on a schedule", "scheduled schedule recurring tasks", OWNER),
];

/** The pages that show everything one of the bar's menus holds (src/lib/nav-areas.ts lays them out). */
const AREA_PAGES: NavEntry[] = [
  { id: "area-create", href: "/create", label: "All of Create", what: "Every way to make or edit", kind: "area", goals: [], keywords: "create make edit tools all overview", icon: "Sparkles" },
  { id: "area-studios", href: "/studios", label: "All studios", what: "Every studio, with previews", kind: "area", goals: [], keywords: "studios all overview every studio", icon: "LayoutGrid" },
  { id: "area-motions", href: "/motions-and-effects", label: "Motions & effects", what: "Camera moves and effects", kind: "area", goals: [], keywords: "motions effects camera moves vfx presets overview", icon: "Film" },
];

/**
 * The sentence under each cover card on the area pages (NavEntry.line). Studios that have a card on Home use Home's
 * line instead (HOME_STUDIOS), so a studio says the same thing in both places.
 */
const CARD_LINES: Record<string, string> = {
  image: "Describe it and get a picture, from a portrait to a poster.",
  video: "Turn words or a still into a moving shot.",
  storyboard: "Plan a film frame by frame, then shoot each frame.",
  canvas: "Wire models together into a flow you can run again.",
  edit: "Change a picture with a sentence. The rest stays.",
  "live-edit": "Type a change and watch the picture follow.",
  inpaint: "Paint over one part and say what goes there.",
  layers: "Split a picture into layers you can move and swap.",
  "color-grade": "Grade a shot, or match the colors of another.",
  "any-angle": "See the same subject from any angle you choose.",
  upscale: "Make pictures and clips sharper and larger.",
  "video-edit": "Restyle a clip with words and keep its motion.",
  extend: "Make a clip longer, picking up where it ends.",
  reframe: "Any shape from any shot: vertical, square or wide.",
  "video-tools": "Trim, join, matte and caption any clip.",
  katana: "Cut your clips into a story on a timeline.",
  shorts: "Vertical reels from one idea, ready to post.",
  faceless: "A whole channel of episodes, with no face on camera.",
  "content-factory": "A series of posts and clips from one brief.",
  lipsync: "Make a photo talk, sing or present in any voice.",
  explainer: "Turn slides or a document into a narrated video.",
  virality: "Score the first three seconds before you post.",
  ads: "One campaign in every size and format.",
  moodboards: "Lock a look from references and reuse it anywhere.",
  photodump: "A whole photo pack of one person, in any setting.",
  "fashion-factory": "Outfits, try-ons and lookbooks on real-looking models.",
  influencer: "Build a character with a face that stays the same.",
  "character-sheet": "One face from every angle, ready for any shot.",
  elements: "Save your people, places and props to use anywhere.",
  "audio-music": "A track from a few words, in any mood.",
  "audio-sfx": "Any sound effect from a few words.",
  "audio-translate": "Your video, dubbed into another language.",
  "audio-clean": "Remove noise and echo from any voice.",
};

/**
 * Settings sections (ids as in settings-form.tsx). The install's own settings are its owner's; an account gets its
 * own GPU, keys and account; a guest the way to connect a GPU. Everyone may read Thanks & licences.
 */
const SETTINGS: NavEntry[] = (
  [
    ["cloud", "API keys", "fal replicate paid cloud connect", "KeyRound"],
    ["comfyui", "ComfyUI server", "open source gpu url connect local", "Server"],
    ["engine", "Engine mode", "open source cloud both", "Cpu"],
    ["loras", "LoRAs", "lora folder civitai key looks motions effects download licence", "Layers"],
    ["training", "Training (AI-Toolkit)", "ai-toolkit aitk train lora soul id gpu url token", "GraduationCap"],
    ["text-ai", "AI helper", "claude ollama lm studio unsloth local llm model enhancer prompt enhancement context", "Sparkles"],
    ["assist-connectors", "Assist connectors", "mcp connector claude tools notion linear slack server token", "Plug"],
    ["notifications", "Notifications", "browser done alerts", "Bell"],
    ["security", "Password and API tokens", "security sign in mcp token", "ShieldCheck"],
    ["demo", "Placeholder results", "demo mode placeholder tour free try", "Settings2"],
  ] as const
).map(([section, label, keywords, icon]): NavEntry => ({
  id: `setting-${section}`,
  href: `/settings#${section}`,
  label,
  what: "Settings",
  kind: "settings",
  goals: [],
  keywords,
  icon,
  visibility: OWNER,
}));

const ACCOUNT_SETTINGS: NavEntry[] = [
  { id: "your-gpu", href: "/settings#your-gpu", label: "Your GPU", what: "Run on your own ComfyUI", kind: "settings", goals: [], keywords: "comfyui gpu connect own server open source", icon: "Cpu", visibility: ACCOUNT },
  {
    id: "your-keys",
    href: "/settings#your-keys",
    label: "Your keys",
    what: "Your own paid model keys",
    kind: "settings",
    goals: [],
    keywords: "fal fal.ai replicate api key token paid models nano banana kling veo billing",
    icon: "KeyRound",
    visibility: ACCOUNT,
  },
  { id: "account", href: "/settings#account", label: "Account", what: "Email, sign out, delete", kind: "settings", goals: [], keywords: "email sign out delete account", icon: "UserRound", visibility: ACCOUNT },
];

/** Things to do rather than pages to open: search only. Sign up and Log in get their return path at render. */
const ACTIONS: NavEntry[] = [
  { id: "toggle-theme", href: THEME_ACTION, label: "Toggle dark mode", what: "Switch light and dark", kind: "action", goals: [], keywords: "dark light theme night mode appearance", icon: "SunMoon" },
  { id: "github", href: REPO, label: "Source on GitHub", what: "Open source, MIT", kind: "action", goals: [], keywords: "github code repo repository open source download install self host", icon: "Code" },
  { id: "signup", href: "/login?signup=1", label: "Sign up free", what: "Save your work, run more", kind: "action", goals: [], keywords: "sign up register create account join", icon: "UserPlus", visibility: GUEST },
  { id: "login", href: "/login", label: "Log in", what: "Back to your account", kind: "action", goals: [], keywords: "log in login sign in account", icon: "LogIn", visibility: GUEST },
];

export const NAV_ENTRIES: readonly NavEntry[] = [...PAGES, ...STUDIOS, ...HUB_TOOLS, ...SUB_TOOLS, ...STUDIO_FEATURES, ...AREA_PAGES, ...SETTINGS, ...ACCOUNT_SETTINGS, ...ACTIONS].map((e) =>
  CARD_LINES[e.id] ? { ...e, line: CARD_LINES[e.id] } : e,
);

/**
 * The bar's Create menu and the phone's Create sheet, column by column (create-menu.tsx draws them; the /create page
 * starts from them). Storyboard plans a film, so it sits with Make (its card is in the launcher's Film column).
 */
export const CREATE_COLUMNS = [
  { label: "Make", ids: ["image", "video", "assist", "canvas", "storyboard"] },
  { label: "Edit a picture", ids: ["edit", "live-edit", "inpaint", "layers", "color-grade"] },
] as const;

export const LAUNCHER_GROUPS: readonly LauncherGroup[] = [
  { id: "film", label: "Film & video", chip: "Film" },
  { id: "social", label: "Social & shorts", chip: "Social" },
  { id: "sell", label: "Sell & advertise", chip: "Sell" },
  { id: "people", label: "People & fashion", chip: "People" },
  { id: "sound", label: "Sound", chip: "Sound" },
  { id: "finish", label: "Finish & convert", chip: "Finish" },
];

export const GOALS: readonly Goal[] = [
  {
    id: "film",
    label: "Make a film",
    icon: "Clapperboard",
    title: "Make a film",
    line: "Studios, camera moves and finishing tools for film",
    cardsLabel: "Studios",
    cards: ["cinema", "storyboard", "katana", "motion-control", "extend"],
    tapLabel: "One-tap for films",
    taps: [
      { preset: "motion-drone-reveal", kind: "Camera motion" },
      { preset: "effect-northern-lights", kind: "Effect" },
      { preset: "effect-turning-metal", kind: "Effect" },
      { preset: "app-color-grading", kind: "App" },
    ],
    finishLabel: "Finish",
    finish: ["video-tools", "audio", "upscale"],
    assist: true,
  },
  {
    id: "social",
    label: "Grow on social",
    icon: "TrendingUp",
    title: "Grow on social",
    line: "Studios, one-tap apps and finishing tools for social",
    cardsLabel: "Studios",
    cards: ["shorts", "faceless", "content-factory", "lipsync", "explainer"],
    tapLabel: "One-tap for social",
    taps: [
      { preset: "app-talking-photo", kind: "App" },
      { preset: "app-plushies", kind: "App" },
      { preset: "effect-outfit-switch", kind: "Effect" },
      { preset: "app-renaissance", kind: "App" },
    ],
    finishLabel: "Finish",
    finish: ["virality", "reframe", "video-tools-captions"],
    assist: true,
  },
  {
    id: "sell",
    label: "Sell a product",
    icon: "ShoppingBag",
    title: "Sell a product",
    line: "Studios, one-tap apps and finishing tools for products",
    cardsLabel: "Studios",
    cards: ["marketing", "ads", "photodump", "mixed-media", "moodboards"],
    tapLabel: "One-tap for products",
    taps: [
      { preset: "app-giant-product", kind: "App" },
      { preset: "app-billboard-ad", kind: "App" },
      { preset: "app-commercial-faces", kind: "App" },
      { preset: "motion-drone-reveal", kind: "Camera motion" },
    ],
    finishLabel: "Finish",
    finish: ["upscale", "reframe"],
    assist: true,
  },
  {
    id: "people",
    label: "People & fashion",
    icon: "UserRound",
    title: "People & fashion",
    line: "Studios and one-tap looks for people and fashion",
    cardsLabel: "Studios",
    cards: ["fashion-factory", "influencer", "character-sheet", "genjutsu", "elements"],
    tapLabel: "One-tap for people",
    taps: [
      { preset: "app-makeup-studio", kind: "App" },
      { preset: "app-commercial-faces", kind: "App" },
      { preset: "app-3d-figure", kind: "App" },
      { preset: "app-plushies", kind: "App" },
    ],
    finishLabel: "Finish",
    finish: ["inpaint", "upscale"],
  },
  {
    id: "edit",
    label: "Edit & finish",
    icon: "SlidersHorizontal",
    title: "Edit & finish",
    line: "Change a picture or a clip you already have",
    cardsLabel: "Tools",
    cards: ["video-edit", "character-swap", "upscale", "reframe", "image-to-3d"],
    tapLabel: "One-tap looks",
    taps: [
      { preset: "app-renaissance", kind: "App" },
      { preset: "app-color-grading", kind: "App" },
      { preset: "effect-turning-metal", kind: "Effect" },
      { preset: "app-3d-render", kind: "App" },
    ],
    finishLabel: "Picture tools",
    finish: ["edit", "inpaint", "layers"],
  },
  {
    id: "sound",
    label: "Sound",
    icon: "AudioLines",
    title: "Sound",
    line: "Voice, music and sound for anything you make",
    cardsLabel: "Audio and voice",
    cards: ["audio", "lipsync", "audio-translate", "audio-video"],
    tapLabel: "One-tap with a voice",
    taps: [
      { preset: "app-talking-photo", kind: "App" },
      { preset: "app-asmr-host", kind: "App" },
    ],
    finishLabel: "Finish",
    finish: ["audio-clean", "audio-split", "audio-transcribe"],
  },
];

/**
 * Covers of the next steps under a result (src/lib/next-steps.ts), by step: listed here so coverIds() names every
 * cover the navigation shows, and nav-covers.ts resolves them all on the server.
 */
export const STEP_COVERS = {
  animate: "motion-dolly-in",
  talk: "app-talking-photo",
  sheet: "app-fuobe-angles",
  billboard: "app-billboard-ad",
  upscale: "app-upscale",
  giant: "app-giant-product",
  edit: "app-relight",
  grade: "app-color-grading",
  threeD: "app-3d-rotation",
  extend: "motion-aerial-pullback",
  sound: "effect-live-concert",
  split: "app-asmr-host",
  reframe: "app-expand-image",
  swap: "genjutsu-group-swap",
  voice: "app-asmr-promo",
  clean: "app-clean-up-voice",
  spin: "app-product-360",
} as const;

const byId = new Map(NAV_ENTRIES.map((e) => [e.id, e]));

export function entry(id: string): NavEntry | undefined {
  return byId.get(id);
}

/** Whether a viewer sees an entry anywhere. A viewer not known yet sees what a guest may see, and no more. */
export function visibleTo(e: NavEntry, kind: ViewerKind | undefined): boolean {
  return !e.visibility || e.visibility.includes(kind ?? "guest");
}

export function entriesFor(kind: ViewerKind | undefined): NavEntry[] {
  return NAV_ENTRIES.filter((e) => visibleTo(e, kind));
}

/** Who is looking: the owner, an account (public sign-up) or a guest (signed out while sign-up is open). */
export function viewerKindOf(v: { owner?: boolean; account?: unknown; publicSignup?: boolean } | undefined): ViewerKind | undefined {
  if (!v) return undefined;
  return v.owner ? "owner" : v.account ? "account" : v.publicSignup ? "guest" : "owner";
}

/** The launcher's columns, one per group, each with its lead card and the rest in order. */
export function launcherColumns(kind: ViewerKind | undefined): { group: LauncherGroup; lead: NavEntry; rest: NavEntry[] }[] {
  return LAUNCHER_GROUPS.map((group) => {
    const all = NAV_ENTRIES.filter((e) => e.group === group.id && visibleTo(e, kind));
    if (group.id === "sound") all.sort((a, b) => SOUND_COLUMN.indexOf(a.id) - SOUND_COLUMN.indexOf(b.id));
    const lead = all.find((e) => e.lead) ?? all[0];
    return { group, lead, rest: all.filter((e) => e !== lead) };
  });
}

/** Every launcher entry in column order (the Studios sheet's tiles and the palette's "Every studio"). */
export function launcherEntries(kind: ViewerKind | undefined, group?: LauncherGroupId): NavEntry[] {
  return launcherColumns(kind)
    .filter((c) => !group || c.group.id === group)
    .flatMap((c) => [c.lead, ...c.rest]);
}

const LAUNCHER_HREFS = NAV_ENTRIES.filter((e) => e.group).map((e) => e.href);

/**
 * The launcher entry the path is on (its id), the one whose link matches best: /audio/music is Music, /audio and
 * /audio/dialogue are Audio, /marketing/click-to-ad is Marketing Studio. None for a page outside the launcher.
 */
export function launcherActive(pathname: string): string | undefined {
  let best: NavEntry | undefined;
  for (const e of NAV_ENTRIES) {
    if (!e.group || !navActive(e.href, pathname, new URLSearchParams(), LAUNCHER_HREFS)) continue;
    if (!best || e.href.length > best.href.length) best = e;
  }
  return best?.id;
}

/**
 * What each studio holds inside (its tabs and modes), as the bar lists it under the studio: links under its card or row
 * in the Studios menu, pills under a group's tiles in the phone's Studios sheet, and a row of pills in its section of
 * /studios. Search finds every one of them on its own ("Genjutsu › Restyle").
 * - `ids`: NavEntry ids in the studio's own order (a viewer sees those visibleTo them).
 * - `menu`: how many the Studios menu lists (it never scrolls): these first (`pick`), then "See all N" to the studio
 *   (so not the one its own link opens). Omitted: all of them. 0: none (its column has no room): the sheet, /studios
 *   and search carry them.
 * - `tall`: the menu shows them only on a window this tall (800, 880 or 960 px), where its column has the room.
 * Ads Studio is a tab of Marketing Studio's suite: it lives under Marketing Studio, not as a row of its own.
 */
export interface StudioSubs {
  ids: readonly string[];
  menu?: number;
  pick?: readonly string[];
  tall?: 800 | 880 | 960;
  /** Below `tall`: "line" shows them as one wrapped line of names instead of hiding them (Genjutsu's modes). */
  short?: "line";
  /** The owner's own features in the list (Genjutsu's modes not open to everyone yet) show from this height. */
  ownerTall?: 880 | 960;
}

const hubTools = (hub: HubKind, skip: readonly string[] = []) => HUB_MODES[hub].map((m) => `${hub}-${m.id}`).filter((id) => !skip.includes(id));

export const STUDIO_SUBS: Readonly<Record<string, StudioSubs>> = {
  marketing: { ids: ["marketing-click-to-ad", "ads", "ads-multiplier"] },
  // Its mode ids built here: one of them written out whole is also a retired model id (catalog/replaced.ts).
  genjutsu: { ids: ["motion", "character", "swap", "restyle", "insert", "picture", "finish"].map((m) => `genjutsu-${m}`), tall: 800, short: "line", ownerTall: 880 },
  // The modes that aren't rows of the Sound column already.
  audio: { ids: hubTools("audio", SOUND_COLUMN), menu: 3 },
  upscale: { ids: hubTools("upscale") },
  "video-tools": { ids: hubTools("video-tools"), menu: 3, pick: ["video-tools-relight", "video-tools-captions", "video-tools-remove-object"], tall: 880 },
  photodump: { ids: ["photodump-instadump"] },
  "image-to-3d": { ids: ["image-to-3d-image", "image-to-3d-multi", "image-to-3d-text", "image-to-3d-objects", "image-to-3d-splat"], menu: 3, tall: 800 },
  "character-sheet": { ids: ["character-sheet-reference", "character-sheet-cast", "character-sheet-describe"], menu: 0 },
  cinema: { ids: ["cinema-blockout"], menu: 0 },
  canvas: { ids: ["canvas-skills"] },
  assist: { ids: ["assist-skills", "assist-memory", "assist-scheduled"] },
};

/**
 * Features a guest or an account may open but not run here (their pages say so up front, docs/public-signup.md): the
 * menus and the phone sheet link them for the owner only. Search and /studios still list them.
 */
export const OWNER_RUNS: ReadonlySet<string> = new Set<string>();

/** The studio a feature lives under in the menus (Ads Studio under Marketing Studio). */
const SUB_PARENT = new Map(Object.entries(STUDIO_SUBS).flatMap(([parent, s]) => s.ids.map((id) => [id, parent] as const)));
export const subParent = (id: string): string | undefined => SUB_PARENT.get(id);

/** A studio's features as this viewer sees them: all (`list`, for /studios and search), or as the menus and sheets link them. */
export function studioSubs(parent: string, kind: ViewerKind | undefined, place: "list" | "sheet" | "menu" = "list"): NavEntry[] {
  const spec = STUDIO_SUBS[parent];
  if (!spec) return [];
  const all = spec.ids.map((id) => byId.get(id)).filter((e): e is NavEntry => !!e && visibleTo(e, kind));
  if (place === "list") return all;
  const linked = all.filter((e) => kind === "owner" || !OWNER_RUNS.has(e.id));
  if (place === "sheet") return linked;
  if (spec.menu === 0) return [];
  if (spec.menu === undefined || spec.menu >= linked.length) return linked;
  // A cut list ends on "See all", the studio's own page: the feature that page opens on is left to it.
  const home = byId.get(parent)?.href;
  const pick = spec.pick ?? [];
  const rest = linked.filter((e) => e.href !== home);
  const ordered = [...rest.filter((e) => pick.includes(e.id)).sort((a, b) => pick.indexOf(a.id) - pick.indexOf(b.id)), ...rest.filter((e) => !pick.includes(e.id))];
  return ordered.slice(0, spec.menu);
}

/** A sub-link's name: its studio's own tab name ("Video" under Upscale), else its label. */
export const subLabel = (e: Pick<NavEntry, "label" | "tab">) => e.tab ?? e.label;

/**
 * The studio feature a page is (for aria-current on its link under its studio): the one whose link the path and query
 * match, the longest such link winning. None when the feature's link is its studio's own (/upscale is Upscale, and its
 * "Image" tab is that same page), so the studio stays the one marked.
 */
export function subActive(pathname: string, search: string | URLSearchParams = ""): string | undefined {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  let best: NavEntry | undefined;
  for (const [id, parent] of SUB_PARENT) {
    const e = byId.get(id);
    const p = byId.get(parent);
    if (!e || !p || e.href === p.href) continue;
    const [path, query] = e.href.split("?");
    if (path !== pathname) continue;
    const want = new URLSearchParams(query ?? "");
    if ([...want].some(([k, v]) => q.get(k) !== v)) continue;
    if (!best || e.href.length > best.href.length) best = e;
  }
  return best?.id;
}

/** How many studios there are (Apps is not one): for copy such as "28 studios". */
export function studioCount(): number {
  return NAV_ENTRIES.filter((e) => e.group && e.kind === "studio").length;
}

/** A goal's band on Home: its cards and finishing links that this viewer may see. */
export function goalBand(id: GoalId, kind: ViewerKind | undefined): { goal: Goal; cards: NavEntry[]; finish: NavEntry[] } {
  const goal = GOALS.find((g) => g.id === id);
  if (!goal) throw new Error(`No goal ${id}`);
  const pick = (ids: string[]) => ids.map((i) => byId.get(i)).filter((e): e is NavEntry => !!e && visibleTo(e, kind));
  return { goal, cards: pick(goal.cards), finish: pick(goal.finish) };
}

/** Entries that are pages of their own (no actions, no settings sections, nothing off the site). */
const ROUTES = NAV_ENTRIES.filter((e) => e.kind !== "tool" && e.kind !== "action" && e.href.startsWith("/") && !e.href.includes("#"));
const ROUTE_HREFS = ROUTES.map((e) => e.href);

/**
 * The page the path is on: the entry whose link matches best (navActive, with every other page as a sibling, so
 * /library?tab=favorites wins over /library, and /settings/models over /settings). A hub's modes and a studio's own
 * pages count as the studio (/audio/clean is Audio, /marketing/click-to-ad is Marketing Studio).
 */
export function activeEntry(pathname: string, search: URLSearchParams): NavEntry | undefined {
  let best: NavEntry | undefined;
  for (const e of ROUTES) {
    if (!navActive(e.href, pathname, search, ROUTE_HREFS)) continue;
    if (!best || e.href.length > best.href.length) best = e;
  }
  return best;
}

/** Whether an entry shows its "New" badge now (the browser's clock). */
export function isNew(e: Pick<NavEntry, "newUntil">, now: number = Date.now()): boolean {
  return !!e.newUntil && now < Date.parse(e.newUntil);
}

/** Every preset id the navigation shows a cover for: entries, goal taps, next steps. nav-covers.ts resolves these. */
export function coverIds(): string[] {
  const ids = [
    ...NAV_ENTRIES.map((e) => e.cover),
    ...GOALS.flatMap((g) => g.taps.map((t) => t.preset)),
    ...Object.values(STEP_COVERS),
  ].filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** Where a goal tap's preset opens, as the galleries link it: an app's page, else Video with it picked. */
export const tapHref = (preset: string) => (preset.startsWith("app-") ? `/apps/${preset}` : `/video?preset=${preset}`);
