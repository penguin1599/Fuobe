import type { ChainSlot, Engine, Generation, GenerationRequest } from "./types";

/**
 * Marketing Studio, Ads Studio, Ad Multiplier and Click to Ad: the shared catalog (formats,
 * Fuobe's own templates, UGC hooks and settings, Click-to-Ad styles, ad angles) and the pure
 * planning helpers the client (live blockers, prices) and the server (pipelines) both use.
 *
 * Structure follows docs/research/higgsfield-marketing-agents.md §1–§4 (categories → formats →
 * capabilities). Template names, prompts and previews are Fuobe's own; no Higgsfield covers.
 */

// ---------------------------------------------------------------------------
// Brand kits and products (shared by every marketing flow)

export interface BrandFonts {
  /** Google Fonts family names (or any installed family), e.g. "Playfair Display". */
  heading?: string;
  body?: string;
}

export interface BrandSocial {
  network: string;
  url: string;
}

export interface BrandKitFields {
  name: string;
  website?: string;
  /** /api/files/… URL. */
  logo?: string;
  tagline?: string;
  overview?: string;
  /** Hex colours, the main one first. */
  colors: string[];
  fonts: BrandFonts;
  values: string[];
  aesthetics: string[];
  tone: string[];
  audience?: string;
  sellingPoints: string[];
  competitors: string[];
  socials: BrandSocial[];
  language?: string;
  /** /api/files/… URLs. */
  images: string[];
  /** Free-form "Detail" entries. */
  details: string[];
}

export type BrandStatus = "researching" | "ready" | "failed" | "canceled";

export interface BrandProgress {
  /** Index into RESEARCH_LABELS. */
  index: number;
  total: number;
  label: string;
  startedAt: number;
}

export interface BrandKit extends BrandKitFields {
  id: string;
  status: BrandStatus;
  progress?: BrandProgress | null;
  /** What the research couldn't do ("We couldn't read the site…"), shown on the review step. */
  note?: string | null;
  error?: string | null;
  source: "website" | "manual";
  /** "assist": made by Fuobe Assist from an ad brief (create_ads without a brand kit); Assist only reuses these. */
  origin?: "assist";
  productCount?: number;
  /** Ads made for this brand (Ads Studio shelf). */
  adCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Product {
  id: string;
  brandId: string | null;
  name: string;
  description?: string;
  price?: number | null;
  currency?: string | null;
  audience?: string;
  sellingPoints: string[];
  url?: string;
  /** /api/files/… URLs, the hero first. */
  images: string[];
  createdAt: number;
  updatedAt: number;
}

export const MAX_SELLING_POINTS = 5;
export const MAX_PRODUCT_IMAGES = 8;

/** Ads Studio's rotating research labels (Higgsfield's 14, in their order). */
export const RESEARCH_LABELS = [
  "Reading your website",
  "Determining the name of your brand",
  "Distilling your primary colours",
  "Tuning in to your tone of voice",
  "Decoding your aesthetics",
  "Stalking your competitors",
  "Sharpening your selling points",
  "Profiling your audience",
  "Scrolling through your socials",
  "Unearthing your values",
  "Gathering brand details",
  "Preparing your brand images",
  "Building your brand kit",
  "Finding your products",
] as const;

/** Labels the client cycles through while the server sits in the LLM stage (it can take a while). */
export const LLM_STAGE = { from: 3, to: 10 } as const;

/**
 * The label to show: the server's own step, except during the writing stage, where the labels
 * from LLM_STAGE rotate every `every` ms so a slow LLM still reads as progress.
 */
export function researchLabel(p: Pick<BrandProgress, "index" | "startedAt"> | null | undefined, now: number, every = 2200): { index: number; label: string } {
  if (!p) return { index: 0, label: RESEARCH_LABELS[0] };
  if (p.index < LLM_STAGE.from || p.index > LLM_STAGE.to) return { index: p.index, label: RESEARCH_LABELS[Math.min(p.index, RESEARCH_LABELS.length - 1)] };
  const span = LLM_STAGE.to - p.index + 1;
  const i = p.index + (Math.floor(Math.max(0, now - p.startedAt) / every) % span);
  return { index: i, label: RESEARCH_LABELS[i] };
}

/**
 * How far the research is (0–100) for the bar: the server's own step, eased forward over time during
 * the writing stage so it keeps moving — and never goes back while the labels rotate.
 */
export function researchProgress(p: Pick<BrandProgress, "index" | "startedAt"> | null | undefined, now: number, settle = 25_000): number {
  const total = RESEARCH_LABELS.length;
  if (!p) return (1 / total) * 100;
  const at = ((Math.min(p.index, total - 1) + 1) / total) * 100;
  if (p.index < LLM_STAGE.from || p.index > LLM_STAGE.to) return at;
  const end = ((LLM_STAGE.to + 1) / total) * 100;
  return at + (end - at) * (1 - Math.exp(-Math.max(0, now - p.startedAt) / settle));
}

/** Click to Ad's product-kit labels. */
export const KIT_LABELS = ["Connecting to website", "Extracting product images", "Finding brand colors", "Locating logo", "Processing details", "Finalizing product kit"] as const;

/** "Describe your business" examples for a manual brand kit (Fuobe's own). */
export const BRAND_EXAMPLES: { label: string; text: string }[] = [
  { label: "Food & Beverage", text: "Ember & Oat — small-batch granola and nut butters, roasted in Portland and sold online and at farmers' markets to busy people who still read labels." },
  { label: "Home & Lifestyle", text: "Hollow Pine — hand-poured soy candles and linen sprays that smell like a cabin weekend, for renters who want a cozy home on a budget." },
  { label: "Fashion", text: "Studio Marlow — relaxed tailoring in deadstock fabrics, made in limited runs for women who want one great blazer instead of five okay ones." },
  { label: "Beauty & Skincare", text: "Dew Theory — fragrance-free barrier creams for sensitive and reactive skin, developed with dermatologists and sold direct online." },
  { label: "Digital Services", text: "Northbound — a two-person studio that designs and builds fast marketing sites for seed-stage SaaS teams in four weeks." },
];

/** Brand kit languages (as Higgsfield lists them). */
export const BRAND_LANGUAGES = [
  "Arabic", "Chinese", "Czech", "Danish", "Dutch", "English", "Finnish", "French", "German", "Greek", "Hebrew", "Hindi", "Hungarian", "Indonesian",
  "Italian", "Japanese", "Kazakh", "Korean", "Norwegian", "Polish", "Portuguese", "Romanian", "Russian", "Spanish", "Swedish", "Thai", "Turkish",
  "Ukrainian", "Vietnamese",
];

export const SOCIAL_NETWORKS = ["Instagram", "TikTok", "YouTube", "Facebook", "LinkedIn", "Pinterest", "X", "Threads", "Snapchat", "Telegram", "Discord"];

export function emptyKit(name = ""): BrandKitFields {
  return { name, colors: [], fonts: {}, values: [], aesthetics: [], tone: [], sellingPoints: [], competitors: [], socials: [], images: [], details: [] };
}

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (s: string) => HEX.test(s);

/** One sentence about the brand for image prompts (name, look, palette), kept short. */
export function brandLine(kit: Pick<BrandKitFields, "name" | "tagline" | "aesthetics" | "colors" | "tone"> | null | undefined): string {
  if (!kit?.name) return "";
  const look = kit.aesthetics.slice(0, 3).join(", ");
  const colors = kit.colors.filter(isHex).slice(0, 4);
  return [
    `Brand: ${kit.name}${kit.tagline ? ` (“${kit.tagline}”)` : ""}`,
    look && `look and feel: ${look}`,
    colors.length && `brand colours ${colors.join(", ")}`,
  ]
    .filter(Boolean)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Marketing Studio: categories → formats → capabilities

export type MarketingCategory = "product-shot" | "motion" | "ugc" | "tiktok" | "ads" | "posters" | "marketplace";

export const CATEGORIES: { id: MarketingCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "product-shot", label: "Product shot" },
  { id: "motion", label: "Motion" },
  { id: "ugc", label: "UGC" },
  { id: "tiktok", label: "TikTok" },
  { id: "ads", label: "Ads" },
  { id: "posters", label: "Posters" },
  { id: "marketplace", label: "Marketplace" },
];

export type FormatId =
  | "product-standalone"
  | "product-with-model"
  | "motion-2d"
  | "motion-hyper"
  | "motion-mixed"
  | "motion-saas"
  | "ugc-talking"
  | "tiktok"
  | "ads"
  | "poster"
  | "marketplace";

export type Need = "required" | "optional" | "none";
export type Pipeline = "image" | "motion" | "ugc";

export interface FormatDef {
  id: FormatId;
  category: MarketingCategory;
  name: string;
  kind: "image" | "video";
  /** The chip on template cards. */
  cardLabel: string;
  product: Need;
  avatar: Need;
  /** At least one of these must be given. */
  oneOf?: ("product" | "avatar" | "prompt" | "website")[];
  hookAndSetting?: boolean;
  durations?: { min: number; max: number; default: number };
  aspectRatios: string[];
  defaultAspect: string;
  /** Most results per run. */
  batch: number;
  brandKit: boolean;
  /** Exact on-image text (headline, CTA): in the prompt on cloud models, drawn on top for open ones. */
  text?: boolean;
  pipeline: Pipeline;
  promptPlaceholder: string;
}

const VIDEO_RATIOS = ["9:16", "1:1", "3:4", "4:3", "16:9", "21:9"];
const SHOT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"];

export const FORMATS: Record<FormatId, FormatDef> = {
  "product-standalone": {
    id: "product-standalone", category: "product-shot", name: "Standalone", kind: "image", cardLabel: "Product shot",
    product: "required", avatar: "none", aspectRatios: SHOT_RATIOS, defaultAspect: "3:4", batch: 4, brandKit: true, pipeline: "image",
    promptPlaceholder: "Describe your edit, e.g. “add a few coffee beans around it”",
  },
  "product-with-model": {
    id: "product-with-model", category: "product-shot", name: "With model", kind: "image", cardLabel: "Product shot",
    product: "optional", avatar: "optional", oneOf: ["product", "avatar"], aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9"], defaultAspect: "3:4",
    batch: 4, brandKit: false, pipeline: "image", promptPlaceholder: "What should look different? e.g. “she's laughing, wind in her hair”",
  },
  "motion-2d": {
    id: "motion-2d", category: "motion", name: "2D product motion", kind: "video", cardLabel: "Product motion",
    product: "required", avatar: "none", durations: { min: 5, max: 15, default: 5 }, aspectRatios: VIDEO_RATIOS, defaultAspect: "9:16", batch: 4,
    brandKit: true, pipeline: "motion", promptPlaceholder: "What do you want to change? e.g. “use our mint green”",
  },
  "motion-hyper": {
    id: "motion-hyper", category: "motion", name: "Hypermotion", kind: "video", cardLabel: "Product motion",
    product: "required", avatar: "none", durations: { min: 5, max: 15, default: 10 }, aspectRatios: VIDEO_RATIOS, defaultAspect: "9:16", batch: 4,
    brandKit: true, pipeline: "motion", promptPlaceholder: "Describe the scene you imagine…",
  },
  "motion-mixed": {
    id: "motion-mixed", category: "motion", name: "Mixed media", kind: "video", cardLabel: "Product motion",
    product: "required", avatar: "none", durations: { min: 5, max: 15, default: 10 }, aspectRatios: VIDEO_RATIOS, defaultAspect: "9:16", batch: 4,
    brandKit: true, pipeline: "motion", promptPlaceholder: "Describe the scene you imagine…",
  },
  "motion-saas": {
    id: "motion-saas", category: "motion", name: "SaaS", kind: "video", cardLabel: "Product motion",
    product: "optional", avatar: "none", oneOf: ["prompt", "product", "website"], durations: { min: 5, max: 15, default: 5 }, aspectRatios: VIDEO_RATIOS,
    defaultAspect: "16:9", batch: 4, brandKit: true, pipeline: "motion", promptPlaceholder: "What does your app do? e.g. “invoices that chase themselves”",
  },
  "ugc-talking": {
    id: "ugc-talking", category: "ugc", name: "Talking head", kind: "video", cardLabel: "UGC video",
    product: "optional", avatar: "optional", hookAndSetting: true, durations: { min: 10, max: 30, default: 15 }, aspectRatios: ["9:16", "1:1", "3:4", "16:9"],
    defaultAspect: "9:16", batch: 2, brandKit: true, pipeline: "ugc", promptPlaceholder: "What should they say? e.g. “it saved my 7 a.m. meetings”",
  },
  tiktok: {
    id: "tiktok", category: "tiktok", name: "TikTok", kind: "video", cardLabel: "TikTok",
    product: "optional", avatar: "optional", hookAndSetting: true, durations: { min: 8, max: 15, default: 12 }, aspectRatios: ["9:16"], defaultAspect: "9:16",
    batch: 2, brandKit: true, pipeline: "ugc", promptPlaceholder: "The angle, e.g. “a hack nobody tells you about”",
  },
  ads: {
    id: "ads", category: "ads", name: "Ads", kind: "image", cardLabel: "Ads",
    product: "required", avatar: "optional", aspectRatios: ["1:1", "4:5", "9:16", "3:4", "4:3", "16:9"], defaultAspect: "4:5", batch: 4, brandKit: true, text: true,
    pipeline: "image", promptPlaceholder: "Notes for the ad, e.g. “winter sale, 20% off”",
  },
  poster: {
    id: "poster", category: "posters", name: "Poster", kind: "image", cardLabel: "Poster",
    product: "optional", avatar: "none", oneOf: ["prompt", "product"], aspectRatios: ["3:4", "2:3", "4:5", "1:1", "9:16"], defaultAspect: "3:4", batch: 4, brandKit: true,
    text: true, pipeline: "image", promptPlaceholder: "Describe the poster you want to create.",
  },
  marketplace: {
    id: "marketplace", category: "marketplace", name: "Marketplace", kind: "image", cardLabel: "Marketplace",
    product: "required", avatar: "optional", aspectRatios: ["1:1", "3:4", "4:5", "2:3", "4:3", "16:9"], defaultAspect: "1:1", batch: 4, brandKit: true, text: true,
    pipeline: "image", promptPlaceholder: "Key facts to call out, e.g. “500 ml · BPA-free · dishwasher safe”",
  },
};

export const MAX_PROMPT = 5000;

// ---------------------------------------------------------------------------
// Templates (Fuobe's own set; procedural previews)

/** What the procedural card draws. */
export type PreviewScene =
  | "pedestal" | "flatlay" | "splash" | "float" | "ice" | "shadow" | "blocks" | "nature" | "studio" | "water" | "shelf" | "noir" | "picnic" | "citrus"
  | "model" | "orbit" | "kinetic" | "collage" | "cards" | "selfie" | "split" | "headline" | "type" | "listing" | "badge" | "burst" | "stars";

export interface TemplateLook {
  scene: PreviewScene;
  hue: number;
  /** Second hue for gradients and props. */
  hue2?: number;
  /** Dark backdrop. */
  dark?: boolean;
}

export interface MarketingTemplate {
  id: string;
  name: string;
  format: FormatId;
  /** The scene or motion, written as an image/video prompt. */
  prompt: string;
  aspect?: string;
  duration?: number;
  look: TemplateLook;
  /** A built-in UGC hook. */
  hook?: string;
  setting?: string;
  /** Default on-image headline ("{product}" and "{brand}" fill in). */
  headline?: string;
  cta?: string;
  /** Drawn by Fuobe Kinetic Motion in the browser (exact words, the brand's fonts and colours), not prompted to a model. */
  render?: "code";
  /** The Kinetic Motion scene that draws it (render: "code"). */
  scene?: string;
  /** The words the person types for it, in order. */
  fields?: TemplateField[];
  /** Its quick choices (2 to 4 groups). */
  easy?: EasyGroup[];
  /** It shows a picture: the product (a cut-out traces best), else the logo; or a photo that fills its panel. */
  picture?: "product" | "photo";
  /** Its length range when it differs from the format's (seconds). */
  lengths?: { min: number; max: number; default: number };
  /** Only the owner sees it and opens it (a new template not yet ready for everyone). */
  ownerOnly?: true;
}

export interface TemplateField {
  key: string;
  label: string;
  max: number;
  /** Lines the box offers (1: a single-line field). */
  lines: number;
  /** A short tip under the field. */
  hint?: string;
}

export interface EasyGroup {
  id: string;
  label: string;
  choices: { id: string; label: string }[];
  /** The choice picks the scene itself (`<scene family>/<choice id>`), as the end card's styles do. */
  scene?: string;
}

/** The sizes a code-drawn template comes in. */
export const KINETIC_SIZES = ["9:16", "4:5", "1:1", "16:9"] as const;

const PACE: EasyGroup = { id: "pace", label: "Pace", choices: [{ id: "calm", label: "Calm" }, { id: "punchy", label: "Punchy" }] };
const LOOK: EasyGroup = { id: "look", label: "Look", choices: [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }, { id: "brand", label: "Brand colour" }] };

/** A code-drawn piece runs 5 to 8 seconds: its beats spread over the length, so a longer one has more to watch. */
const CODE_LENGTHS = { min: 5, max: 8, default: 5 };

/** A template drawn by code: its scene, the words it takes and its quick choices. */
const code = (scene: string, fields: TemplateField[], extra: Partial<MarketingTemplate> = {}): Partial<MarketingTemplate> => ({ render: "code", scene, fields, easy: [PACE, LOOK], duration: 5, lengths: CODE_LENGTHS, ...extra });
const field = (key: string, label: string, max: number, lines = 1, hint?: string): TemplateField => ({ key, label, max, lines, ...(hint && { hint }) });

/** Whether a template is drawn by Kinetic Motion. */
export const isCodeTemplate = (t: Pick<MarketingTemplate, "render"> | null | undefined): boolean => t?.render === "code";

const t = (id: string, name: string, format: FormatId, look: TemplateLook, prompt: string, extra: Partial<MarketingTemplate> = {}): MarketingTemplate => ({
  id,
  name,
  format,
  look,
  prompt,
  ...extra,
});

export const TEMPLATES: MarketingTemplate[] = [
  // Product shot · standalone
  t("ps-sunlit-plinth", "Sunlit Plinth", "product-standalone", { scene: "pedestal", hue: 55, hue2: 35 }, "The product stands on a travertine plinth against a warm plaster wall; low morning sun rakes across from the left and throws a long, crisp shadow; quiet, premium, lots of negative space"),
  t("ps-ice-bath", "Ice Bath", "product-standalone", { scene: "ice", hue: 220, hue2: 200 }, "The product is half buried in crushed ice with frost and cold droplets on its surface, cool blue rim light, shallow depth of field, refreshing and crisp"),
  t("ps-citrus-burst", "Citrus Burst", "product-standalone", { scene: "citrus", hue: 85, hue2: 55 }, "The product surrounded by halved lemons, oranges and grapefruit on a saturated yellow backdrop, hard on-camera flash, bold summer energy"),
  t("ps-floating-trio", "Floating Trio", "product-standalone", { scene: "float", hue: 300, hue2: 260 }, "Three copies of the product float at different angles in a soft pastel void, each with its own gentle shadow below, playful and weightless"),
  t("ps-linen-flatlay", "Linen Flat Lay", "product-standalone", { scene: "flatlay", hue: 40, hue2: 25 }, "Overhead flat lay of the product on wrinkled oatmeal linen with dried flowers, a ceramic dish and a sprig of eucalyptus, soft diffused daylight"),
  t("ps-splash-crown", "Splash Crown", "product-standalone", { scene: "splash", hue: 210, hue2: 190, dark: true }, "A crown of clear liquid splashes up around the product, frozen at 1/8000 s, droplets glinting against a deep backdrop, high-speed studio flash"),
  t("ps-palm-shadow", "Palm Shadow", "product-standalone", { scene: "shadow", hue: 45, hue2: 140 }, "The product sits on a sunlit ledge while palm-leaf shadows fall across it and the warm wall behind, holiday afternoon light"),
  t("ps-color-block", "Color Block", "product-standalone", { scene: "blocks", hue: 15, hue2: 200 }, "The product balanced on stacked geometric blocks in two bold complementary colours, clean studio light, graphic and modern"),
  t("ps-moss-stone", "Moss & Stone", "product-standalone", { scene: "nature", hue: 135, hue2: 100 }, "The product nestled on moss and smooth river stones, soft forest light filtering through mist, earthy and natural"),
  t("ps-studio-white", "Studio White", "product-standalone", { scene: "studio", hue: 250, hue2: 250 }, "Clean e-commerce packshot on a seamless white sweep, large soft boxes, a subtle floor reflection, true-to-life colour"),
  t("ps-golden-ripple", "Golden Ripple", "product-standalone", { scene: "water", hue: 50, hue2: 25 }, "The product stands in a shallow pool of still water with soft ripples and a mirror reflection, golden-hour backlight"),
  t("ps-bathroom-shelf", "Bathroom Shelf", "product-standalone", { scene: "shelf", hue: 175, hue2: 200 }, "The product on a tiled bathroom shelf next to everyday items, soft window light, real and lived-in, slightly from below"),
  t("ps-midnight-gloss", "Midnight Gloss", "product-standalone", { scene: "noir", hue: 270, hue2: 300, dark: true }, "The product on glossy black acrylic with a sharp rim light and a long reflection, deep shadows, luxurious and moody"),
  t("ps-gingham-picnic", "Gingham Picnic", "product-standalone", { scene: "picnic", hue: 355, hue2: 120 }, "The product on a red gingham picnic blanket with fresh strawberries and a glass bottle, bright sunny park light, cheerful"),

  // Product shot · with model
  t("pm-mirror-selfie", "Mirror Selfie", "product-with-model", { scene: "selfie", hue: 20, hue2: 340 }, "A mirror selfie: the person holds their phone in one hand and shows the product in the other, bedroom mirror, natural morning light, candid"),
  t("pm-golden-closeup", "Golden Close-up", "product-with-model", { scene: "model", hue: 45, hue2: 20 }, "Close-up portrait, the person holds the product near their face and smiles softly, golden-hour sun, warm skin tones, shallow depth of field"),
  t("pm-street-style", "Street Style", "product-with-model", { scene: "model", hue: 210, hue2: 30 }, "Full-body street-style shot of the person walking across a city crosswalk with the product clearly visible, editorial fashion photography"),
  t("pm-editorial-lounge", "Editorial Lounge", "product-with-model", { scene: "model", hue: 330, hue2: 280 }, "The person lounges on a velvet vintage sofa with the product, magazine editorial lighting, rich colours, confident pose"),
  t("pm-morning-routine", "Morning Routine", "product-with-model", { scene: "model", hue: 190, hue2: 160 }, "The person uses the product at a bright bathroom sink during their morning routine, fresh and relaxed, soft window light"),
  t("pm-courtside", "Courtside", "product-with-model", { scene: "model", hue: 140, hue2: 30 }, "The person in sporty clothes on a clay tennis court holds the product, harsh midday sun, athletic and upbeat"),
  t("pm-kitchen-candid", "Kitchen Candid", "product-with-model", { scene: "model", hue: 30, hue2: 90 }, "Candid shot of the person leaning on a kitchen counter with the product, mug and fruit in the background, natural daylight"),
  t("pm-studio-smile", "Studio Smile", "product-with-model", { scene: "model", hue: 260, hue2: 220 }, "Clean studio portrait, the person holds the product toward the camera and smiles, solid colour backdrop, soft beauty lighting"),

  // Motion · 2D
  t("m2-sticker-pop", "Sticker Pop", "motion-2d", { scene: "collage", hue: 330, hue2: 60 }, "Flat 2D animation: the product pops in as a die-cut sticker, bouncy squash and stretch, doodled stars and sparkles burst around it on a flat colour background", { duration: 5 }),
  t("m2-paper-parade", "Paper Parade", "motion-2d", { scene: "collage", hue: 30, hue2: 200 }, "Paper cut-out animation: layered paper shapes slide in like a theatre set and the product rises from behind them, gentle stop-motion jitter", { duration: 5 }),
  t("m2-line-reveal", "Line-Art Reveal", "motion-2d", { scene: "kinetic", hue: 160, hue2: 160 }, "A single continuous line draws the outline of the product, then the real product fills in inside it, clean minimal background", code("marketing/line-reveal", [field("headline", "Headline", 60, 2), field("cta", "Call to action", 30), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "product", aspect: "9:16", easy: [PACE, LOOK, { id: "line", label: "Line", choices: [{ id: "fine", label: "Fine" }, { id: "bold", label: "Bold" }] }] })),
  t("m2-comic-panels", "Comic Panels", "motion-2d", { scene: "split", hue: 50, hue2: 0 }, "Pop-art comic panels flip one after another, each showing the product from a new angle with halftone dots and bold outlines", { duration: 5 }),
  t("m2-retro-starburst", "Retro Starburst", "motion-2d", { scene: "burst", hue: 25, hue2: 330 }, "A rotating retro starburst background in warm colours while the product spins slowly in the centre, groovy 70s motion graphics", code("marketing/starburst", [field("headline", "Headline", 40, 2), field("badge", "Badge", 12, 2), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "product", aspect: "9:16" })),
  t("m2-offer-badge", "Offer Badge", "motion-2d", { scene: "badge", hue: 350, hue2: 40 }, "A starburst offer badge pops and turns, the product slides in under it and the call to action follows", code("marketing/offer-badge", [field("offer", "Offer", 14, 2), field("headline", "Headline", 40, 2), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "product", aspect: "9:16" })),
  t("m2-midnight-drop", "Midnight Drop", "motion-2d", { scene: "kinetic", hue: 15, hue2: 0, dark: true }, "A launch countdown: the drop's name cuts in huge, the countdown flips into place tile by tile and the time and call to action follow on a dark field of moving light", code("marketing/drop-countdown", [field("headline", "Drop name", 28, 2), field("count", "Countdown", 12, 1, "Type it as it should read, e.g. 03:12:45"), field("when", "When", 32), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "9:16" })),
  t("m2-nocturne", "Nocturne", "motion-2d", { scene: "noir", hue: 40, hue2: 270, dark: true }, "A fragrance reveal: ribbons of light cross a night field, the bottle rises into a pool of light and a fine serif name settles over it", code("marketing/fragrance-reveal", [field("headline", "Name", 40, 2), field("line", "Line", 60, 2), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "product", aspect: "9:16" })),
  t("m2-season-finale", "Season Finale", "motion-2d", { scene: "type", hue: 8, hue2: 30 }, "An editorial sale poster: a fashion photo, the sale in huge condensed type that bleeds off the frame, the offer on a highlighter and a tilted pill", code("marketing/editorial-sale", [field("headline", "Headline", 24, 2), field("offer", "Offer", 28, 2), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "photo", aspect: "4:5" })),
  t("m2-prism-stage", "Prism Stage", "motion-2d", { scene: "pedestal", hue: 150, hue2: 45, dark: true }, "A glass product spotlight: the product stands on a glass plinth inside rings of light while its name and a short line set beside it", code("marketing/glass-spotlight", [field("headline", "Headline", 40, 2), field("line", "Line", 60, 2), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "product", aspect: "4:5" })),
  t("m2-grid-shuffle", "Grid Shuffle", "motion-2d", { scene: "cards", hue: 200, hue2: 280 }, "A Swiss-style grid of colour tiles shuffles and slides; one tile opens to reveal the product, crisp geometric transitions", { duration: 5 }),

  // Motion · hypermotion
  t("mh-orbit-hero", "Orbit Hero", "motion-hyper", { scene: "orbit", hue: 230, hue2: 200, dark: true }, "Pure CGI commercial: the camera orbits the product on a dark stage as a sweeping light reveals its edges, then settles on a hero angle"),
  t("mh-liquid-wrap", "Liquid Wrap", "motion-hyper", { scene: "splash", hue: 30, hue2: 10 }, "Ribbons of glossy liquid swirl around the product and wrap it, then fall away to reveal it spotless, macro slow motion"),
  t("mh-exploded-view", "Exploded View", "motion-hyper", { scene: "float", hue: 190, hue2: 220, dark: true }, "The product splits into an exploded view with its parts floating apart, then snaps back together, technical and precise"),
  t("mh-ingredient-rain", "Ingredient Rain", "motion-hyper", { scene: "citrus", hue: 95, hue2: 40 }, "The product's ingredients rain down from above in slow motion and bounce around it, bright studio light, fresh and vivid"),
  t("mh-spotlight-spin", "Spotlight Spin", "motion-hyper", { scene: "noir", hue: 280, hue2: 320, dark: true }, "A single spotlight snaps on and the product rotates on a turntable, dust motes in the beam, dramatic theatre mood"),
  t("mh-drop-bounce", "Drop & Bounce", "motion-hyper", { scene: "blocks", hue: 350, hue2: 50 }, "The product drops into frame, bounces once on a coloured floor with a satisfying squash, and lands on its hero angle"),
  t("mh-slow-splash", "Slow Splash", "motion-hyper", { scene: "water", hue: 200, hue2: 180 }, "The product plunges into clear water in extreme slow motion, bubbles trail upward and light caustics dance across it"),
  t("mh-neon-sweep", "Neon Sweep", "motion-hyper", { scene: "kinetic", hue: 300, hue2: 180, dark: true }, "Neon light bars sweep across the product in sync with a beat, reflections streak over its surface, night-club energy"),

  // Motion · mixed media
  t("mm-scrapbook-flip", "Scrapbook Flip", "motion-mixed", { scene: "collage", hue: 40, hue2: 340 }, "Mixed-media scrapbook: torn paper, tape and doodles animate around a real photo of the product as pages flip"),
  t("mm-riso-loop", "Riso Loop", "motion-mixed", { scene: "type", hue: 350, hue2: 210 }, "Risograph-print look with grain and slight misregistration; the product cycles through two-colour duotone frames"),
  t("mm-y2k-desktop", "Y2K Desktop", "motion-mixed", { scene: "cards", hue: 190, hue2: 300 }, "A Y2K computer desktop: pop-up windows, chrome icons and a cursor open a window that shows the product"),
  t("mm-clay-diorama", "Clay Diorama", "motion-mixed", { scene: "pedestal", hue: 20, hue2: 140 }, "Claymation diorama: tiny clay props and a little set animate in stop motion around the real product"),
  t("mm-marquee", "Marquee", "motion-mixed", { scene: "noir", hue: 280, hue2: 30, dark: true }, "An event announcement: a night photo, the event's name lit up in big warm type, the date, the place and the call to action set on the grid", code("marketing/announcement", [field("headline", "Event", 32, 2), field("when", "When", 40), field("place", "Where", 48), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "photo", aspect: "9:16" })),
  t("mm-runway-titles", "Runway Titles", "motion-mixed", { scene: "model", hue: 40, hue2: 20 }, "Fashion lookbook titles: a full-bleed editorial photo, a giant title cut in letter by letter with a script word laid over it and tiny facts in the corners", code("marketing/lookbook", [field("headline", "Title", 28, 2), field("accent", "Script word", 20), field("line", "Line", 48), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "photo", aspect: "4:5" })),
  t("mm-halftone-collage", "Halftone Collage", "motion-mixed", { scene: "split", hue: 0, hue2: 50 }, "Halftone street-poster collage: cut-out shapes and the product slide in with punchy, rhythmic cuts"),

  // Motion · SaaS
  t("ms-kinetic-headline", "Kinetic Headline", "motion-saas", { scene: "kinetic", hue: 210, hue2: 260 }, "Kinetic typography: the product's promise types itself out word by word with confident motion, then resolves to the logo", code("marketing/kinetic-headline", [field("headline", "Headline", 90, 3, "Put *stars* round a word to highlight it"), field("cta", "Call to action", 24), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "9:16", easy: [PACE, LOOK, { id: "align", label: "Align", choices: [{ id: "centre", label: "Centred" }, { id: "left", label: "Left" }] }] })),
  t("ms-five-star-quote", "Five-Star Quote", "motion-saas", { scene: "stars", hue: 45, hue2: 30 }, "Five stars fill one by one, then a customer's words set line by line with their name", code("marketing/quote", [field("quote", "Quote", 180, 5, "Their words exactly, with your own quotation marks"), field("name", "Name", 48, 2), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { picture: "photo", aspect: "4:5" })),
  t("ms-big-number", "Big Number", "motion-saas", { scene: "headline", hue: 230, hue2: 260, dark: true }, "One huge stat fills the frame and counts up to its value, a caption rises under it, and it ends on the logo", code("marketing/big-number", [field("stat", "The number", 12, 1, "Type it as it should read, e.g. 3× or 98%"), field("caption", "Caption", 60, 3), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),
  t("ms-logo-sting", "Logo Sting", "motion-saas", { scene: "burst", hue: 270, hue2: 210 }, "A short logo sting: geometric shapes converge and click together into the brand mark with a light flare", code("marketing/logo-sting", [field("tagline", "Line under the logo", 60, 2), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),
  t("ms-device-float", "Device Float", "motion-saas", { scene: "float", hue: 220, hue2: 170 }, "A laptop and a phone float in a soft gradient space showing the app's interface, the camera drifts slowly between them", { duration: 5 }),
  t("ms-end-card", "Logo End Card", "motion-saas", { scene: "headline", hue: 160, hue2: 45, dark: true }, "An animated end card: the logo draws on, the line rises and the call-to-action pill pops", code("end-card/draw-on", [field("product", "Line", 60, 2), field("cta", "Call to action", 24), field("website", "Web address", 40)], { aspect: "9:16", duration: 4, lengths: { min: 2, max: 5, default: 4 }, easy: [{ id: "style", label: "Style", scene: "end-card", choices: [{ id: "draw-on", label: "Draw-on" }, { id: "rise", label: "Rise" }, { id: "iris", label: "Iris" }, { id: "split", label: "Split" }, { id: "glint", label: "Glint" }] }, { id: "mark", label: "Mark", choices: [{ id: "logo", label: "Logo" }, { id: "name", label: "Name" }] }] })),
  t("ms-dashboard-zoom", "Dashboard Zoom", "motion-saas", { scene: "cards", hue: 160, hue2: 220, dark: true }, "The camera pushes into a sleek dark dashboard; charts animate up and a key number counts to its value", code("marketing/stat-dashboard", [field("stat", "Key number", 16, 1, "Type it as it should read, e.g. $1,284,000"), field("label", "What it measures", 60, 2), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),
  t("ms-feature-cards", "Feature Cards", "motion-saas", { scene: "cards", hue: 250, hue2: 200 }, "Clean SaaS motion design: rounded feature cards fly in and stack, each one highlighting a benefit, soft gradients and smooth easing", code("marketing/feature-cards", [field("headline", "Headline", 60, 2), field("point1", "First benefit", 60, 2), field("point2", "Second benefit", 60, 2), field("point3", "Third benefit", 60, 2), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),
  t("ms-stat-stack", "Stat Stack", "motion-saas", { scene: "headline", hue: 220, hue2: 15 }, "Three big numbers stacked on an editorial grid, each rolling up to its value with its label, the brand signing off at the foot", code("marketing/stat-stack", [field("stat1", "First number", 10, 1, "Type it as it should read, e.g. 98%"), field("label1", "What it measures", 40), field("stat2", "Second number", 10), field("label2", "What it measures", 40), field("stat3", "Third number", 10), field("label3", "What it measures", 40), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),
  t("ms-kind-words", "Kind Words", "motion-saas", { scene: "stars", hue: 210, hue2: 40 }, "A testimonial carousel: three customers' words slide through one after another on cards, each with its stars and name", code("marketing/testimonials", [field("quote1", "First quote", 120, 3), field("name1", "Name", 40), field("quote2", "Second quote", 120, 3), field("name2", "Name", 40), field("quote3", "Third quote", 120, 3), field("name3", "Name", 40), field("website", "Web address", 40), field("note", "Corner note", 24, 1, "A small fact for the corner, e.g. Collection 07 or Est. 2019")], { aspect: "4:5" })),

  // UGC · talking head
  t("ugc-honest-review", "Honest Review", "ugc-talking", { scene: "selfie", hue: 25, hue2: 200 }, "A relaxed, honest review straight to the phone camera: what they liked, one small catch and why they'd still buy it again", { setting: "bedroom" }),
  t("ugc-unboxing-home", "Unboxing at Home", "ugc-talking", { scene: "selfie", hue: 35, hue2: 15 }, "They open the package at the kitchen table, pull the product out and react to it for the first time", { setting: "kitchen" }),
  t("ugc-morning-routine", "Morning Routine", "ugc-talking", { scene: "selfie", hue: 190, hue2: 50 }, "A get-ready-with-me morning routine where the product is the step they never skip", { setting: "bathroom" }),
  t("ugc-before-after", "Before & After", "ugc-talking", { scene: "split", hue: 140, hue2: 20 }, "They describe the problem they had before, show the product, and talk through the difference it made", { setting: "office" }),
  t("ugc-quick-tutorial", "Quick Tutorial", "ugc-talking", { scene: "selfie", hue: 205, hue2: 160 }, "A 3-step how-to: they talk and demonstrate how they use the product at the same time", { setting: "kitchen" }),
  t("ugc-try-on", "Try-On Haul", "ugc-talking", { scene: "selfie", hue: 320, hue2: 280 }, "A try-on haul: they show the product on, turn around for the camera and say how it fits and feels", { setting: "bedroom" }),
  t("ugc-delivery-day", "Delivery Day", "ugc-talking", { scene: "selfie", hue: 30, hue2: 210 }, "Doorstep delivery: they pick up the parcel, open it right there and share their first impression", { setting: "street" }),
  t("ugc-wing-review", "Sky-High Review", "ugc-talking", { scene: "selfie", hue: 205, hue2: 220 }, "A completely calm product review in an absurd place, played straight for laughs", { setting: "airplane-wing", hook: "product-hit" }),

  // TikTok
  t("tt-gadget-saved", "This Saved My Week", "tiktok", { scene: "selfie", hue: 160, hue2: 45 }, "Creator-led recommendation: “this little thing saved my week” — the problem, the product, the payoff", { setting: "office" }),
  t("tt-secret-hack", "Secret Hack", "tiktok", { scene: "selfie", hue: 280, hue2: 50 }, "They lean in to share a clever hack with the product that most people don't know about", { setting: "kitchen" }),
  t("tt-pov-camera", "POV Camera", "tiktok", { scene: "selfie", hue: 15, hue2: 190 }, "First-person POV: we see their hands use the product in an everyday moment while they narrate", { setting: "in-car" }),
  t("tt-mess-to-fresh", "Mess to Fresh", "tiktok", { scene: "split", hue: 100, hue2: 190 }, "A messy situation turns fresh and tidy thanks to the product, with a satisfying reveal", { setting: "bathroom" }),
  t("tt-couple-test", "Couple Test", "tiktok", { scene: "selfie", hue: 345, hue2: 30 }, "A couple at home tries the product together and banters about it", { setting: "bedroom" }),
  t("tt-direct-camera", "Direct to Camera", "tiktok", { scene: "selfie", hue: 230, hue2: 15 }, "Fast, punchy talking-to-camera with jump cuts: three reasons to get the product", { setting: "street" }),

  // Ads
  t("ad-hero-headline", "Hero Headline", "ads", { scene: "headline", hue: 15, hue2: 35 }, "A bold hero ad: the product large in the centre on a rich colour field, dramatic light, space at the top for a big headline", { headline: "Meet {product}", cta: "Shop now" }),
  t("ad-problem-solution", "Problem → Solution", "ads", { scene: "split", hue: 0, hue2: 140 }, "Split composition: the left side shows the everyday problem in muted tones, the right side shows the product solving it in bright colour", { headline: "Before: hassle. After: {product}.", cta: "Try it" }),
  t("ad-before-after", "Before / After", "ads", { scene: "split", hue: 200, hue2: 45 }, "Clean before-and-after diptych with a thin divider, the product shown on the after side, honest natural light", { headline: "See the difference", cta: "Learn more" }),
  t("ad-five-stars", "Five Stars", "ads", { scene: "stars", hue: 45, hue2: 25 }, "Social-proof ad: the product on a soft backdrop with room for a short customer quote and a five-star row", { headline: "“My new favourite.”", cta: "Read reviews" }),
  t("ad-compare-switch", "Compare & Switch", "ads", { scene: "split", hue: 220, hue2: 140 }, "Side-by-side comparison: a generic alternative in grey on one side, the product glowing on the other", { headline: "Why people switch", cta: "Switch today" }),
  t("ad-benefit-ladder", "Benefit Ladder", "ads", { scene: "listing", hue: 160, hue2: 200 }, "The product on the right with three short benefit callouts stacked on the left, tidy and clear", { headline: "3 reasons to love {product}", cta: "Shop now" }),
  t("ad-ingredient-halo", "Ingredient Halo", "ads", { scene: "citrus", hue: 110, hue2: 60 }, "The product in the centre ringed by its key ingredients or materials arranged in a neat halo", { headline: "Only what matters", cta: "See inside" }),
  t("ad-offer-burst", "Offer Burst", "ads", { scene: "burst", hue: 350, hue2: 45 }, "Promotional ad: the product with a bright starburst badge for the offer, energetic colour", { headline: "20% off this week", cta: "Get the deal" }),
  t("ad-big-number", "Big Number", "ads", { scene: "type", hue: 260, hue2: 200 }, "A huge stat set in type behind the product, minimal layout, confident and modern", { headline: "10,000+ happy customers", cta: "Join them" }),
  t("ad-dark-premium", "Dark Premium", "ads", { scene: "noir", hue: 40, hue2: 270, dark: true }, "Luxurious dark ad: the product lit like jewellery on black, thin gold accents, elegant serif headline", { headline: "{product}. Quietly exceptional.", cta: "Discover" }),

  // Posters
  t("po-swiss-grid", "Swiss Grid", "poster", { scene: "type", hue: 5, hue2: 0 }, "International Typographic Style poster: strict grid, oversized grotesk type, one bold accent colour, the product or subject cropped tight", { headline: "{brand}" }),
  t("po-riso-bloom", "Riso Bloom", "poster", { scene: "collage", hue: 330, hue2: 190 }, "Two-colour risograph poster with grain, overprint and blooming botanical shapes", { headline: "In bloom" }),
  t("po-giant-type", "Giant Type", "poster", { scene: "type", hue: 60, hue2: 250 }, "Poster where one giant word fills the frame edge to edge and the subject peeks through the letters", { headline: "NOW" }),
  t("po-retro-sunburst", "Retro Sunburst", "poster", { scene: "burst", hue: 30, hue2: 10 }, "1970s travel-poster sunburst with layered warm stripes and rounded retro type", { headline: "Good days ahead" }),
  t("po-brutalist-stack", "Brutalist Stack", "poster", { scene: "type", hue: 0, hue2: 0, dark: true }, "Neo-brutalist poster: stacked heavy type, hard black borders, raw layout, one acid accent colour", { headline: "{brand}" }),
  t("po-botanical-gallery", "Botanical Gallery", "poster", { scene: "nature", hue: 120, hue2: 40 }, "Museum exhibition poster: a botanical illustration plate, cream paper, elegant serif headline and small caption", { headline: "{product}" }),
  t("po-chrome-y2k", "Chrome Y2K", "poster", { scene: "kinetic", hue: 200, hue2: 300 }, "Y2K poster with liquid chrome lettering, lens flares and an iridescent gradient", { headline: "{brand}" }),
  t("po-zine-riot", "Zine Riot", "poster", { scene: "collage", hue: 50, hue2: 350 }, "Photocopied punk zine poster: ransom-note letters, staples, tape and xerox grain", { headline: "Make some noise" }),

  // Marketplace
  t("mk-clean-listing", "Clean Listing", "marketplace", { scene: "listing", hue: 210, hue2: 210 }, "Marketplace main image: the product centred on pure white, fills 85% of the frame, soft shadow, true colour", { headline: "{product}" }),
  t("mk-feature-callouts", "Feature Callouts", "marketplace", { scene: "listing", hue: 200, hue2: 160 }, "Listing infographic: the product with thin leader lines pointing to three key features, clean sans-serif labels", { headline: "{product}" }),
  t("mk-dimensions", "Dimensions Card", "marketplace", { scene: "studio", hue: 220, hue2: 220 }, "Product dimensions image: the product on light grey with neat measurement lines for height and width", { headline: "Size guide" }),
  t("mk-whats-inside", "What's in the Box", "marketplace", { scene: "flatlay", hue: 35, hue2: 210 }, "Knolling layout of everything in the box laid out at right angles around the product on a light surface", { headline: "What's in the box" }),
  t("mk-lifestyle-badge", "Lifestyle + Badge", "marketplace", { scene: "badge", hue: 140, hue2: 45 }, "The product in a bright lifestyle setting with a round quality badge in one corner", { headline: "Best seller" }),
  t("mk-dark-premium", "Dark Premium Listing", "marketplace", { scene: "noir", hue: 30, hue2: 45, dark: true }, "Premium listing image: the product on charcoal with warm gold rim light and a slim feature strip", { headline: "{product}" }),
];

export const TEMPLATE_INDEX = new Map(TEMPLATES.map((x) => [x.id, x]));

/**
 * The shape a picked template (or format) opens in: the template's own, else the ratio in use while
 * the format stays the same, else the format's default (a UGC talking head opens 9:16, not the 3:4 of
 * the product shot picked before it).
 */
export function openingAspect(current: { format: FormatId; aspectRatio: string }, t: Pick<MarketingTemplate, "aspect"> | null | undefined, format: FormatId): string {
  const f = FORMATS[format];
  if (t?.aspect && f.aspectRatios.includes(t.aspect)) return t.aspect;
  if (format === current.format && f.aspectRatios.includes(current.aspectRatio)) return current.aspectRatio;
  return f.defaultAspect;
}

/** "www.example.com" → true: a web address the server accepts (a host with a dot, no spaces). */
export function looksLikeWebsite(s: string): boolean {
  const v = s.trim();
  if (!v || /\s/.test(v)) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes(".") && !u.hostname.endsWith(".");
  } catch {
    return false;
  }
}

/** A template the person may see and open (an owner-only one for the owner alone). */
export const visibleTemplate = (x: Pick<MarketingTemplate, "ownerOnly"> | null | undefined, owner: boolean): boolean => !!x && (!x.ownerOnly || owner);

export function templatesFor(category: MarketingCategory | "all", media: "all" | "image" | "video", owner = false): MarketingTemplate[] {
  return TEMPLATES.filter((x) => {
    const f = FORMATS[x.format];
    return visibleTemplate(x, owner) && (category === "all" || f.category === category) && (media === "all" || f.kind === media);
  });
}

/** "All": one template of each category in turn, so the first row shows the range. */
export function interleaved(list: MarketingTemplate[]): MarketingTemplate[] {
  const by = new Map<MarketingCategory, MarketingTemplate[]>();
  for (const x of list) {
    const c = FORMATS[x.format].category;
    by.set(c, [...(by.get(c) ?? []), x]);
  }
  const queues = [...by.values()];
  const out: MarketingTemplate[] = [];
  for (let i = 0; out.length < list.length; i++) for (const q of queues) if (q[i]) out.push(q[i]);
  return out;
}

// ---------------------------------------------------------------------------
// UGC hooks and settings (the mechanics are Higgsfield's; the prompts are Fuobe's own words)

export interface UgcHook {
  id: string;
  name: string;
  type: "stunt" | "subtle";
  prompt: string;
}

export const UGC_HOOKS: UgcHook[] = [
  { id: "product-hit", name: "Product Hit", type: "stunt", prompt: "Something flies into frame and bonks the creator; a beat of surprise, then they laugh it off and pivot straight to the product." },
  { id: "spicy", name: "Spicy", type: "subtle", prompt: "Opens on an extreme close-up of the collarbone, tilts slowly up to a flawless face, pulls back to selfie framing and holds a silent beat before the pitch." },
  { id: "interview", name: "Interview", type: "subtle", prompt: "A street interviewer asks a stranger an odd follow-up question; confusion builds until the stranger spots the product and starts a casual review." },
  { id: "random-mic", name: "Random Object Mic", type: "stunt", prompt: "Mid-vlog, an absurd object drops into the creator's hand from above and they use it as a microphone to deliver a dead-serious review." },
  { id: "product-crash", name: "Product Crash", type: "subtle", prompt: "The product tumbles from above and the scene glitches into chaos, then snaps back clean and calm as the creator begins reviewing it." },
  { id: "blizzard", name: "Blizzard", type: "stunt", prompt: "A cozy room is hit by an impossible indoor blizzard; everything is covered in snow except the product, which keeps working perfectly." },
  { id: "camera-bump", name: "Camera Bump", type: "subtle", prompt: "The camera bumps the creator's forehead by accident; they flinch, laugh, recover and naturally reveal the product while explaining it." },
  { id: "product-dodge", name: "Product Dodge", type: "stunt", prompt: "The product flies at the creator's face; they duck just in time, then pop back up already holding it and start the review as if nothing happened." },
  { id: "epic-fail", name: "Epic Fail", type: "subtle", prompt: "The creator attempts a backflip, lands badly, and without missing a beat pulls out the product and starts an unbothered review." },
];

export interface UgcSetting {
  id: string;
  name: string;
  type: "realistic" | "unrealistic";
  prompt: string;
}

export const UGC_SETTINGS: UgcSetting[] = [
  { id: "bedroom", name: "Bedroom", type: "realistic", prompt: "sitting up in bed against pillows, soft window light, rumpled sheets, a relaxed morning feel" },
  { id: "nature", name: "Nature", type: "realistic", prompt: "outdoors on a trail, in a park or at the beach depending on the product, natural light, open sky" },
  { id: "gym", name: "Gym", type: "realistic", prompt: "on a gym bench after a workout, bright overhead lights, equipment behind, freshly-finished energy" },
  { id: "bathroom", name: "Bathroom", type: "realistic", prompt: "front-camera selfie in a bathroom, vanity lights, tiles behind, getting-ready energy" },
  { id: "kitchen", name: "Kitchen", type: "realistic", prompt: "leaning on a kitchen counter in daylight, a mug and fruit in the background, casual midday vibe" },
  { id: "in-car", name: "In Car", type: "realistic", prompt: "selfie from the driver's or passenger seat of a parked car, window light on the face, between errands" },
  { id: "street", name: "Street", type: "realistic", prompt: "walking down a city sidewalk, handheld selfie, storefronts and traffic behind, talking while moving" },
  { id: "office", name: "Office", type: "realistic", prompt: "at a desk with a laptop open and coffee nearby, soft overhead light, a quick mention between tasks" },
  { id: "airplane-wing", name: "Airplane Wing", type: "unrealistic", prompt: "sitting on the wing of a plane in flight above the clouds, wind whipping, completely unbothered" },
  { id: "rooftop", name: "Rooftop Edge", type: "unrealistic", prompt: "perched on the edge of a skyscraper rooftop at golden hour, the whole city below, totally relaxed" },
  { id: "volcano", name: "Volcano Rim", type: "unrealistic", prompt: "sitting on the rim of an active volcano, lava bubbling below and smoke drifting past, zero reaction" },
  { id: "tiny", name: "Tiny Reviewer", type: "unrealistic", prompt: "shrunk to 15 cm tall and leaning on a giant version of the product, a normal selfie review at an impossible scale" },
  { id: "car-roof", name: "Car Roof", type: "unrealistic", prompt: "sitting on the roof of a moving car on a desert highway at golden hour, swaying calmly as a truck passes" },
  { id: "train", name: "Train Surf", type: "unrealistic", prompt: "hanging out of the door of a moving train filming a selfie, wind pressing against them as the live demo" },
];

export const hookById = (id?: string | null) => UGC_HOOKS.find((h) => h.id === id);
export const settingById = (id?: string | null) => UGC_SETTINGS.find((s) => s.id === id);

// ---------------------------------------------------------------------------
// Click to Ad styles (the 10 preset names; Fuobe's own direction for each)

export interface AdStyle {
  id: string;
  name: string;
  description: string;
  /** A presenter talks to camera (else product-only shots). */
  presenter: boolean;
  /** How the shots look. */
  visual: string;
  /** How the script sounds. */
  voice: string;
  hue: number;
  dark?: boolean;
}

export const AD_STYLES: AdStyle[] = [
  { id: "simple-ugc", name: "Simple UGC", description: "A creator shows it on their phone camera", presenter: true, visual: "authentic phone-camera UGC look, natural light, handheld", voice: "casual, first person, like telling a friend", hue: 25 },
  { id: "clean-minimal", name: "Clean Minimal", description: "Calm studio shots, lots of white space", presenter: false, visual: "minimal studio shots on a soft seamless backdrop, slow controlled camera moves", voice: "calm, confident, few words", hue: 210 },
  { id: "unboxing", name: "Unboxing", description: "Hands open the box and reveal it", presenter: false, visual: "close-up hands unboxing the product on a clean desk, satisfying reveal", voice: "excited first impressions", hue: 35 },
  { id: "customer-reviews", name: "Customer Reviews", description: "A happy customer tells why they love it", presenter: true, visual: "testimonial selfie video at home, warm natural light", voice: "a genuine customer review with one specific detail", hue: 45 },
  { id: "viral-chaos", name: "Viral Chaos", description: "Fast cuts, bold motion, high energy", presenter: false, visual: "fast whip pans, punchy zooms and bold colour, maximum energy", voice: "fast, punchy, meme-aware", hue: 330 },
  { id: "luxury", name: "Luxury", description: "Dark, glossy, premium lighting", presenter: false, visual: "luxurious dark set, glossy reflections, slow elegant camera moves, gold accents", voice: "unhurried, refined, aspirational", hue: 45, dark: true },
  { id: "product-story", name: "Product Story", description: "Where it comes from and why it matters", presenter: false, visual: "cinematic product story: materials, making-of details and the finished product", voice: "storytelling, warm narrator", hue: 20 },
  { id: "cozy-morning", name: "Cozy Morning", description: "A slow, warm morning ritual", presenter: false, visual: "soft morning light, steam, blankets, the product in a slow morning ritual", voice: "gentle and warm", hue: 35 },
  { id: "red-carpet", name: "Red Carpet", description: "Flash bulbs, glamour, star treatment", presenter: true, visual: "red-carpet glamour with camera flashes and a confident presenter", voice: "glamorous, playful hype", hue: 0, dark: true },
  { id: "elegant-minimal", name: "Elegant Minimal", description: "Soft neutrals and graceful motion", presenter: false, visual: "soft neutral palette, linen and stone textures, graceful slow motion", voice: "soft-spoken and elegant", hue: 30 },
];

export const styleById = (id?: string | null) => AD_STYLES.find((s) => s.id === id);

/** Click to Ad makes a 9:16 ad of at most 12 seconds. */
export const CLICK_TO_AD = { aspect: "9:16", maxSeconds: 12, shots: 3 } as const;

// ---------------------------------------------------------------------------
// The logo end card a Click to Ad video ends on

/**
 * The card is drawn in the browser (brand colour, logo, product name, CTA; components/marketing/end-card.ts)
 * at the ad's 9:16 size, then held for 2–3 s: a gentle push-in on the cloud (fal image-to-video, zoom 1 → 1.05),
 * a still on the open engine. Without a drawn card the cloud puts the logo on the brand colour itself. An animated
 * card (Kinetic Motion's end-card styles, rendered in the browser) arrives as a clip and is joined as it is.
 */
export const END_CARD = { seconds: 2.5, minSeconds: 2, maxSeconds: 3, zoomTo: 1.05, fps: 24, size: { w: 720, h: 1280 }, cta: "Shop now" } as const;

export const END_CARD_MODELS = {
  cloud: { art: "overlay-image", clip: "ken-burns", sound: "merge-audio-video", join: "join-clips" },
  open: { append: "oss-append-endcard", clip: "oss-still-to-clip", join: "oss-join-sound1" },
} as const;

export interface EndCardStep {
  key: string;
  label: string;
  request: GenerationRequest;
  after?: string[];
  chain?: ChainSlot[];
}

export interface EndCardInput {
  engine: Engine;
  /** The step whose clip the card follows (the finished ad). */
  ad: string;
  /** The card the page drew (/api/files/…). */
  card?: string;
  /**
   * The animated card the page rendered (/api/files/… MP4, or WebM on the open engine): used as it is, in place of
   * the still and its push-in.
   */
  clip?: string;
  /** Cloud, no drawn card: the brand-colour background and the logo overlay-image puts on it. */
  background?: string;
  logo?: string;
  /**
   * Cloud: a silent WAV as long as the card (the server writes it). The card clip gets it as its sound track, so
   * both clips merge-videos joins carry sound and the ad's voiceover goes through the join.
   */
  silence?: string;
  seconds?: number;
  feature: string;
  title: string;
  aspectRatio: string;
  resolution?: string;
  /**
   * Open engine: who encoded the ad. video-append-endcard copies the ad's packets and only takes clips ComfyUI
   * encoded (every open step does); others get still-to-clip + the join that keeps the first clip's sound.
   */
  adEncodedBy?: "comfyui" | "other";
}

/**
 * The steps that make the end card and put it after the ad, and the key of the finished video. Cloud:
 * [overlay-image: the logo on the brand colour →] ken-burns (zoom 1 → 1.05) → a silent sound track under it
 * (merge-audio-video) → merge-videos after the ad. Open: video-append-endcard (the ad's sound kept, padded with
 * silence under the card), or still-to-clip + oss-join-sound1 for a clip the open engine didn't make. An animated card
 * (a clip rendered in the page) goes through oss-join-sound1 with the ad, which re-encodes the ad at 25 fps.
 */
export function endCardSteps(o: EndCardInput): { steps: EndCardStep[]; final: string } {
  const seconds = Math.max(END_CARD.minSeconds, Math.min(END_CARD.maxSeconds, o.seconds ?? END_CARD.seconds));
  const result = { feature: o.feature, title: o.title, batchTitle: o.title };
  const helper = { feature: `${o.feature}-step` };
  if (o.engine === "open") {
    const M = END_CARD_MODELS.open;
    // The animated card: joined after the ad (put first by the chain), keeping the ad's sound with silence under the card.
    // Unlike the still card's append (which copies the ad's picture), this join re-encodes the ad too, at 25 fps and the
    // run's resolution: a small generation loss on the ad itself. Not yet run end to end on a GPU (unit-tested plan only).
    if (o.clip) {
      return {
        final: "endcard",
        steps: [
          {
            key: "endcard",
            label: "Adding the end card",
            request: { ...result, modelId: M.join, op: "concat", prompt: o.title, inputs: { videos: [o.clip] }, params: { aspectRatio: o.aspectRatio, ...(o.resolution && { resolution: o.resolution }) } },
            after: [o.ad],
            chain: [{ slot: "videos", position: "first" }],
          },
        ],
      };
    }
    if (!o.card) throw new Error("The open engine needs the end card drawn on the page — turn End card off, or make the ad from Click to Ad");
    if ((o.adEncodedBy ?? "comfyui") === "comfyui") {
      return {
        final: "endcard",
        steps: [
          {
            key: "endcard",
            label: "End card",
            request: { ...result, modelId: M.append, op: "concat", prompt: o.title, inputs: { images: [o.card] }, params: { duration: seconds } },
            after: [o.ad],
            chain: [{ slot: "video" }],
          },
        ],
      };
    }
    return {
      final: "endcard",
      steps: [
        { key: "endcardClip", label: "End card", request: { ...helper, modelId: M.clip, op: "still-motion", inputs: { images: [o.card] }, params: { duration: seconds, fps: 25, aspectRatio: o.aspectRatio, ...(o.resolution && { resolution: o.resolution }) } } },
        {
          key: "endcard",
          label: "Adding the end card",
          request: { ...result, modelId: M.join, op: "concat", prompt: o.title, params: { aspectRatio: o.aspectRatio, ...(o.resolution && { resolution: o.resolution }) } },
          after: [o.ad, "endcardClip"],
          chain: [{ slot: "videos" }, { slot: "videos" }],
        },
      ],
    };
  }
  const M = END_CARD_MODELS.cloud;
  if (!o.silence) throw new Error("The end card needs its silent sound track");
  const steps: EndCardStep[] = [];
  if (o.clip) {
    // The animated card is the clip: it only needs its silent track (it can start at once, beside the ad), then the join.
    steps.push({ key: "endcardSound", label: "End card sound", request: { ...helper, modelId: M.sound, op: "mux", inputs: { video: o.clip, audio: o.silence } } });
    steps.push({
      key: "endcard",
      label: "Adding the end card",
      request: { ...result, modelId: M.join, op: "concat", prompt: o.title, params: { aspectRatio: o.aspectRatio } },
      after: [o.ad, "endcardSound"],
      chain: [{ slot: "videos" }, { slot: "videos" }],
    });
    return { steps, final: "endcard" };
  }
  if (!o.card) {
    if (!o.background || !o.logo) throw new Error("Add a logo to the brand kit for the end card, or turn End card off");
    steps.push({ key: "endcardArt", label: "End card", request: { ...helper, modelId: M.art, op: "overlay", inputs: { images: [o.background, o.logo] }, params: { position: { x: 0.5, y: 0.45 }, scale: 1 } } });
  }
  const move = { duration: seconds, fps: END_CARD.fps, zoomFrom: 1, zoomTo: END_CARD.zoomTo, panFrom: { x: 0.5, y: 0.5 }, panTo: { x: 0.5, y: 0.5 }, easing: "ease-in-out" as const };
  steps.push({
    key: "endcardClip",
    label: "End card motion",
    request: { ...helper, modelId: M.clip, op: "still-motion", ...(o.card ? { inputs: { images: [o.card] } } : {}), params: move },
    ...(o.card ? {} : { after: ["endcardArt"], chain: [{ slot: "images" as const }] }),
  });
  // The card's clip has no sound: give it silence, so merge-videos joins two clips that both have sound (whether it
  // keeps the first clip's voiceover when the second has no audio stream at all is unknown).
  steps.push({
    key: "endcardSound",
    label: "End card sound",
    request: { ...helper, modelId: M.sound, op: "mux", inputs: { audio: o.silence } },
    after: ["endcardClip"],
    chain: [{ slot: "video" }],
  });
  steps.push({
    key: "endcard",
    label: "Adding the end card",
    request: { ...result, modelId: M.join, op: "concat", prompt: o.title, params: { aspectRatio: o.aspectRatio } },
    after: [o.ad, "endcardSound"],
    chain: [{ slot: "videos" }, { slot: "videos" }],
  });
  return { steps, final: "endcard" };
}

// ---------------------------------------------------------------------------
// Ads Studio

export const MAX_ADS_PER_PRODUCT = 20;
export const MAX_PRODUCTS_PER_RUN = 10;
export const AD_RATIOS = ["1:1", "4:5", "9:16"] as const;
export type AdRatio = (typeof AD_RATIOS)[number];

export interface AdAngle {
  id: string;
  name: string;
  /** What the copy leads with. */
  copy: string;
  /** What the picture shows. */
  visual: string;
}

export const AD_ANGLES: AdAngle[] = [
  { id: "benefit", name: "Key benefit", copy: "lead with the single biggest benefit", visual: "the product as a confident hero shot" },
  { id: "pain-point", name: "Pain point", copy: "name a frustration the buyer has and show the product as the fix", visual: "the product in the moment it solves an everyday problem" },
  { id: "real-life", name: "Real-life use", copy: "show how it fits into an ordinary day", visual: "the product being used in a real, lived-in setting" },
  { id: "offer", name: "Offer", copy: "lead with the price, a deal or free shipping", visual: "the product on a bold colour field with room for an offer badge" },
  { id: "material", name: "Ingredients & materials", copy: "tell the story of what it's made of", visual: "the product surrounded by its ingredients or raw materials" },
  { id: "how-to", name: "How it works", copy: "explain in one line how it's used", visual: "hands using the product, close up" },
  { id: "lifestyle", name: "Lifestyle moment", copy: "sell the feeling of the moment it belongs to", visual: "an aspirational lifestyle scene featuring the product" },
  { id: "social-proof", name: "Social proof", copy: "quote a happy customer or a number of buyers", visual: "the product in soft light with space for a quote" },
  { id: "comparison", name: "Comparison", copy: "contrast it with the usual alternative", visual: "the product standing out next to a dull generic alternative" },
];

export interface AdConcept {
  angle: string;
  headline: string;
  body: string;
  cta: string;
  /** The picture to render (no text in it). */
  visual: string;
}

export type CreativeStatus = "writing" | "queued" | "rendering" | "ready" | "failed" | "canceled";

export interface AdCreative extends AdConcept {
  id: string;
  batchId: string;
  brandId: string;
  productId: string | null;
  position: number;
  status: CreativeStatus;
  /** Human words for the status ("Creative is on its way"). */
  message?: string | null;
  error?: string | null;
  generationId?: string | null;
  /** The rendered visual (or, for a baked ad, the whole ad). */
  image?: string | null;
  /** The visual already holds the text (an ad drawn whole in one call before build plan O7): don't draw over it. */
  baked?: boolean;
  /** A baked creative's one format. */
  ratio?: "1:1" | "4:5" | "9:16";
  layout?: string | null;
  engine: Engine;
  modelId: string;
  costUsd?: number | null;
  createdAt: number;
}

export function creativeStatusText(s: CreativeStatus, error?: string | null): string {
  switch (s) {
    case "writing":
      return "Writing the copy…";
    case "queued":
      return "In queue";
    case "rendering":
      return "Creative is on its way";
    case "ready":
      return "Ready";
    case "canceled":
      return "Canceled before it was made";
    default:
      return error ? `Creative generation failed — ${error}` : "Creative generation failed";
  }
}

// ---------------------------------------------------------------------------
// Ad Multiplier

export const MULTIPLIER = { minSeconds: 4, maxSeconds: 30, maxImages: 20, maxChars: 4000, defaultPrompt: "Recreate this ad.", qualities: ["480p", "720p", "1080p"] as const } as const;

/** The part of the reference clip that's used (seconds). */
export interface ClipRange {
  start: number;
  end: number;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/** The first usable part of a fresh clip: all of it, or its first 30 s. */
export const initialClip = (duration: number): ClipRange => ({ start: 0, end: tenth(Math.min(duration, MULTIPLIER.maxSeconds)) });

export interface MultiplierParts {
  mode: "prompt" | "sections";
  prompt?: string;
  hook?: string | null;
  cta?: string | null;
}

/** The text sent for a run: the prompt, or "HOOK: …\n\nCTA: …" in sections mode. */
export function multiplierText(p: MultiplierParts): string {
  if (p.mode === "prompt") return (p.prompt ?? "").trim() || MULTIPLIER.defaultPrompt;
  return [p.hook != null && `HOOK: ${p.hook.trim() || "Write a new opening hook."}`, p.cta != null && `CTA: ${p.cta.trim() || "Write a new call to action."}`].filter(Boolean).join("\n\n");
}

/** Images named in the prompt (@image_3 → 3), in order of first mention. */
export function mentionedImages(prompt: string): number[] {
  const out: number[] = [];
  for (const m of prompt.matchAll(/@image_(\d{1,2})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The images a model gets, and the prompt rewritten for it: the mentioned images first (then the
 * rest) up to the model's limit, renumbered; Kling and Happy Horse bind "@Image1" (their prompt
 * fields say so), the others read "image 1".
 */
export function mentionsFor(prompt: string, images: string[], modelId: string, max: number): { prompt: string; images: string[]; dropped: number } {
  const order = [...mentionedImages(prompt).filter((n) => n <= images.length), ...images.map((_, i) => i + 1)].filter((n, i, a) => a.indexOf(n) === i);
  const used = order.slice(0, Math.max(0, max));
  const kling = modelId.startsWith("kling") || modelId.startsWith("happy-horse");
  const text = prompt.replace(/@image_(\d{1,2})\b/g, (all, d: string) => {
    const at = used.indexOf(Number(d));
    if (at < 0) return "the reference";
    return kling ? `@Image${at + 1}` : `image ${at + 1}`;
  });
  return { prompt: text, images: used.map((n) => images[n - 1]), dropped: images.length - used.length };
}

// ---------------------------------------------------------------------------
// Scripts and captions

/** Speaking rate used to size scripts and time estimated captions (ElevenLabs/Chatterbox ≈ 2.4–2.8 w/s). */
export const WORDS_PER_SECOND = 2.5;

export const wordBudget = (seconds: number) => Math.max(6, Math.round(seconds * WORDS_PER_SECOND));

const wordsIn = (s: string) => s.split(" ").filter(Boolean).length;

/**
 * Trim a script to its word budget at sentence ends. The closing sentence (the call to action) stays
 * when it takes at most half the budget: sentences give way from the middle, never the end.
 */
export function fitScript(script: string, seconds: number): string {
  const max = wordBudget(seconds);
  const text = script.replace(/\s+/g, " ").trim();
  if (wordsIn(text) <= max) return text;
  const sentences = (text.match(/[^.!?]+(?:[.!?]+["”’']?|$)/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const last = sentences.length > 1 ? sentences[sentences.length - 1] : null;
  const tail = last && wordsIn(last) <= max / 2 ? last : null;
  const room = max - (tail ? wordsIn(tail) : 0);
  const head: string[] = [];
  let used = 0;
  for (const s of tail ? sentences.slice(0, -1) : sentences) {
    if (used + wordsIn(s) > room) break;
    head.push(s);
    used += wordsIn(s);
  }
  if (!head.length || used < room * 0.5) {
    // The opening sentence alone runs past the budget: cut it at a word.
    const cut = (tail ? sentences.slice(0, -1).join(" ") : text).split(" ").slice(0, room).join(" ").replace(/[,;:\s]+$/, "");
    head.splice(0, head.length, /[.!?]$/.test(cut) ? cut : `${cut}.`);
  }
  return [...head, ...(tail ? [tail] : [])].join(" ");
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * Captions timed from the script at the speaking rate (the open caption burn-in needs timed lines;
 * the cloud captioner transcribes the clip itself). Short TikTok-style chunks of ≤ `words` words.
 */
export function estimateCues(script: string, words = 4, rate = WORDS_PER_SECOND, offset = 0): Cue[] {
  const tokens = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const cues: Cue[] = [];
  let t = offset;
  for (let i = 0; i < tokens.length; ) {
    let n = Math.min(words, tokens.length - i);
    // End a chunk at punctuation so captions follow the phrasing.
    for (let k = 0; k < n; k++)
      if (/[.!?,;:]$/.test(tokens[i + k])) {
        n = k + 1;
        break;
      }
    const chunk = tokens.slice(i, i + n);
    const pause = /[.!?]$/.test(chunk[chunk.length - 1]) ? 0.25 : 0;
    const dur = chunk.length / rate + pause;
    cues.push({ start: round2(t), end: round2(t + dur), text: chunk.join(" ") });
    t += dur;
    i += n;
  }
  return cues;
}

/** "0.00-1.60: text" lines, the format the open caption burn-in reads from its prompt. */
export const cueLines = (cues: Cue[]) => cues.map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)}: ${c.text}`).join("\n");

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Durations and models

/** The allowed duration closest to the wanted one (ties go to the shorter, cheaper clip). */
export function snapDuration(want: number, allowed: number[] | undefined): number {
  if (!allowed?.length) return want;
  return [...allowed].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
}

/**
 * Split a clip into shots a model can make (open models top out at a few seconds): equal shots of
 * at most `longest`, each snapped to an allowed length. Sums to roughly `seconds`.
 */
export function shotPlan(seconds: number, allowed: number[] | undefined): number[] {
  const longest = Math.max(...(allowed?.length ? allowed : [seconds]));
  const n = Math.max(1, Math.ceil(seconds / longest - 0.01));
  return Array.from({ length: n }, () => snapDuration(seconds / n, allowed));
}

export interface ModelChoice {
  id: string;
  /** Why it's the pick ("exact text", "keeps the product pixel-exact"). */
  note?: string;
  /** Its name, where the page has no model facts (Ads Studio's picture picker). */
  name?: string;
  /** Listed with its note but not picked on this engine, and why: it runs on your GPU only. */
  unavailable?: string;
}

/** The choices a run can pick: one listed only to say it runs on your GPU is left out. */
export const pickable = <T extends ModelChoice>(choices: readonly T[]): T[] => choices.filter((c) => !c.unavailable);

/**
 * Why the Original makes no Standalone shot in the cloud. The GPU's recipe cuts the product out with BiRefNet, puts it on
 * white and relights it into the scene with Qwen-Image-Edit 2509 + the White_to_Scene LoRA (product-shot-qwen-edit-2509).
 * fal hosts BiRefNet (fal-ai/birefnet/v2) and 2509 with LoRAs by URL (fal-ai/qwen-image-edit-plus-lora), but nothing
 * hosted puts the cut-out on white (checked 2026-11-01: neither BiRefNet nor Bria's remover takes a background colour, and
 * the LoRA was trained on products on white), so the recipe stays on the GPU and the cloud offers the partners instead.
 */
export const STANDALONE_CLOUD_WHY = "its cut-out and studio relight aren't offered in the cloud";
export const STANDALONE_CLOUD_NOTE = `Fuobe Original · runs on your GPU only: ${STANDALONE_CLOUD_WHY}`;

/**
 * Marketing Studio Image's Original (build plan O10) with Fuobe's template prompts: Qwen-Image 2.1 on the user's GPU
 * (its edit with up to 4 references, its text-to-image without a product photo; a Standalone product shot relit by the
 * White_to_Scene LoRA), Qwen-Image-Edit 2511 hosted on fal. Its pictures carry no words: the headline and CTA are set
 * over them in the browser, so they come out exact.
 */
export const MARKETING_IMAGE_MODEL = "fuobe-marketing-image";

/** The Original's line in the model menus, per engine. */
export const MARKETING_IMAGE_NOTE: Record<Engine, string> = {
  open: "Fuobe Original · Qwen-Image 2.1 on your GPU",
  cloud: "Fuobe Original · Qwen-Image-Edit 2511, hosted",
};

/**
 * Whether a run's words are set over the picture in the browser (an open model, or the Original on either engine), not
 * drawn by the model (GPT Image 2.5, Ideogram, Recraft, Nano Banana Pro in the cloud).
 */
export const wordsOnTop = (engine: Engine, modelId: string, drawn = false): boolean => !drawn && (engine === "open" || modelId === MARKETING_IMAGE_MODEL);

/**
 * "Words drawn by the model", a choice on the formats with words (Ads, Poster, Marketplace) and in Ads Studio:
 * the copy's places (planAd, src/lib/layout-surfaces.ts) become a layout, and a model that reads boxes draws the
 * headline, the button and the product in them. Setting the words on top in the browser stays the default: it gives
 * your exact fonts. MOSS-Image on your GPU; MOSS-Image hosted on fal, Ideogram 4.5 or FLUX.3 in the cloud, each with
 * prompt expansion off (src/lib/catalog/plan.ts planLayout).
 */
export const DRAWN_WORDS_MODELS: Record<Engine, ModelChoice[]> = {
  open: [{ id: "oss-moss-image", name: "MOSS-Image", note: "MOSS-Image on your GPU · draws your words in place, free" }],
  cloud: [
    { id: "moss-image", name: "MOSS-Image", note: "MOSS-Image, hosted on fal · draws your words in place" },
    { id: "ideogram-4-5", name: "Ideogram 4.5", note: "Draws the exact text in place and keeps your product photo" },
    { id: "flux-3", name: "FLUX.3", note: "Draws the text in place and keeps your product photo" },
  ],
};

export const DRAWN_WORDS_LABEL = "Words drawn by the model";
/** The option's hint, beside the default it leaves alone. */
export const DRAWN_WORDS_HINT = "The headline and button are drawn into the picture, in their places. Off: they're set on top in your brand fonts, letter for letter.";

/** The model that draws the words on an engine: the one asked for when it is a choice there, else the first. */
export function drawnWordsModel(engine: Engine, asked?: string | null): string {
  return asked && DRAWN_WORDS_MODELS[engine].some((c) => c.id === asked) ? asked : DRAWN_WORDS_MODELS[engine][0].id;
}

/** The models a Marketing Studio format can use on an engine, the default first: the Original for every image format. */
export function formatModels(format: FormatDef, engine: Engine, has: { product: boolean; avatar: boolean }, drawn = false): ModelChoice[] {
  if (drawn && format.text && format.pipeline === "image") return DRAWN_WORDS_MODELS[engine];
  const original: ModelChoice = { id: MARKETING_IMAGE_MODEL, note: MARKETING_IMAGE_NOTE[engine] };
  if (engine === "open") {
    switch (format.pipeline) {
      case "motion":
        return [
          { id: "oss-minimax-h3", note: "One 5–15 s clip with sound" },
          { id: "oss-wan22-14b-fast", note: "Wan 2.2 14B, shot by shot" },
        ];
      case "ugc":
        return [{ id: "oss-infinitetalk", note: "InfiniteTalk presenter" }];
      default:
        return [original];
    }
  }
  switch (format.id) {
    case "product-standalone":
      // The GPU's Standalone recipe (cut out, on white, relit by a LoRA) has no hosted copy: the Original is listed last,
      // can't be picked in the cloud, and says it runs on your GPU (no other model makes its shot under its name).
      return [
        { id: "bria-product-shot", note: "Keeps the product pixel-exact" },
        { id: "nano-banana-pro" },
        { id: "gpt-image-2-5" },
        { id: "product-photography", note: "One-tap studio shot" },
        { ...original, note: STANDALONE_CLOUD_NOTE, unavailable: STANDALONE_CLOUD_WHY },
      ];
    case "product-with-model":
      return [original, { id: "nano-banana-pro", note: "Product + person references" }, { id: "gpt-image-2-5" }];
    case "ads":
    case "marketplace":
      return [original, { id: "gpt-image-2-5", note: "Draws the exact text" }, { id: "nano-banana-pro" }, { id: "ideogram-4-5" }];
    case "poster":
      return has.product
        ? [original, { id: "gpt-image-2-5", note: "Draws the exact text" }, { id: "nano-banana-pro" }, { id: "ideogram-4-5" }]
        : [original, { id: "ideogram-4-5", note: "Draws the exact text" }, { id: "recraft-4-1" }, { id: "gpt-image-2-5" }];
    case "ugc-talking":
    case "tiktok":
      return [{ id: "omnihuman-2", note: "Full-body presenter" }, { id: "kling-avatar-2" }];
    default:
      return [{ id: "seedance-2-5", note: "Multi-shot with sound" }, { id: "kling-o3" }, { id: "gemini-omni-flash" }];
  }
}

/**
 * Ads Studio's visual models (the copy and layout are Fuobe's; the picture has no text): Fuobe Marketing Image on both
 * engines (the product photo as reference, else made from the concept), partner models as choices in the cloud.
 */
export const AD_VISUAL_MODELS: Record<Engine, ModelChoice[]> = {
  open: [{ id: MARKETING_IMAGE_MODEL, name: "Fuobe Marketing Image", note: "Fuobe Original · Qwen-Image 2.1 with your product photo, free on your GPU" }],
  cloud: [
    { id: MARKETING_IMAGE_MODEL, name: "Fuobe Marketing Image", note: "Fuobe Original · Qwen-Image-Edit 2511 with your product photo, hosted on fal" },
    { id: "nano-banana-pro", name: "Nano Banana Pro", note: "Google's Gemini 3 Pro Image, through fal" },
    { id: "gpt-image-2-5", name: "GPT Image 2.5", note: "OpenAI's GPT Image 2.5 Flare, through fal" },
    // A model that reads boxes gets a "keep clear" layout: the product placed where the words leave room (src/server/ads.ts).
    { id: "flux-3", name: "FLUX.3", note: "Black Forest Labs' FLUX.3 through fal, with the product kept clear of the words" },
  ],
};

/** Ads Studio's visual model on an engine: the one asked for when this engine offers it, else the Original. */
export function adVisualModel(engine: Engine, asked?: string | null): string {
  return asked && AD_VISUAL_MODELS[engine].some((c) => c.id === asked) ? asked : AD_VISUAL_MODELS[engine][0].id;
}

/**
 * Talking-presenter / voice / caption models for UGC pipelines (Marketing Studio UGC and TikTok, Click to Ad, the Ad
 * Multiplier's new hook and CTA). `still` makes the presenter from reference photos (up to 4 on Qwen-Image 2.1 Turbo);
 * `stillFromWords` without any. A clip's own sound never reaches the film: the open joins keep the picture and one
 * chosen soundtrack (the presenter's voice, or the reference ad's), and the mux lays the voiceover in its place.
 */
export const UGC_MODELS = {
  cloud: { voice: "elevenlabs-v4", still: "nano-banana-pro", stillFromWords: "nano-banana-pro", talk: "omnihuman-2", clip: "seedance-2-5", captions: "auto-subtitle", join: "join-clips", mux: "merge-audio-video", trim: "trim-video", frame: "extract-frame" },
  open: {
    voice: "oss-chatterbox",
    still: "oss-qwen-image-21-turbo",
    stillFromWords: "oss-qwen-image-21",
    talk: "oss-infinitetalk",
    clip: "oss-minimax-h3",
    captions: "oss-captions-burnin",
    join: "oss-join-clips",
    mux: "oss-mux",
    trim: "oss-trim",
    frame: "oss-extract-frame",
  },
} as const;

/**
 * Open joins that keep one clip's own sound (oss-join-clips drops every soundtrack): the first clip's
 * from the start, or the second clip's starting where the first ends (a silent hook before the voice).
 */
export const OPEN_SOUND_JOIN = { first: "oss-join-sound1", second: "oss-join-sound2" } as const;

/** The models the Ad Multiplier can recreate with, per engine (the first that's usable is the default). */
export const MULTIPLIER_MODELS: Record<Engine, ModelChoice[]> = {
  cloud: [
    { id: "kling-o3", note: "Kling O3 edit, up to 4 @images, keeps the sound · 15 s at most" },
    { id: "happy-horse-video-edit", note: "Happy Horse video edit, up to 4 @images, keeps the sound · 15 s at most" },
    { id: "gemini-omni-flash", note: "Gemini Omni Flash edit, prompt only" },
  ],
  open: [{ id: "fuobe-genjutsu-motion", note: "Fuobe Genjutsu: your first @image takes over the performance" }],
};

/**
 * The longest part of the reference a cloud edit model recreates (docs/research/paid-model-apis-3/4.json): Kling O3's
 * edit takes 3–15 s clips; Happy Horse's takes up to 60 s but returns at most the first 15 s. A longer selection is
 * cut to its first seconds (so no second is sent that doesn't come back), and the run says so.
 */
export const MULTIPLIER_WINDOW: Readonly<Record<string, number>> = { "kling-o3": 15, "happy-horse-video-edit": 15 };

/** Ad Multiplier quality → the resolution sent; open models top out at 720p. */
export const multiplierResolution = (q: string, engine: Engine) => (engine === "open" && q === "1080p" ? "720p" : q);

// ---------------------------------------------------------------------------
// Runs (Marketing Studio, Click to Ad, Ad Multiplier): a batch of chained generations and what made it

export type RunFeature = "marketing" | "click-to-ad" | "ad-multiplier";

export interface RunOverlay {
  headline?: string;
  body?: string;
  cta?: string;
}

/**
 * How the browser sets the words over an open-engine poster / ad / listing: posters framed on paper
 * (the words beside the picture), the rest over a soft shade at the bottom. The open prompt leaves room to match.
 */
export const overlayLayout = (format?: FormatId): "frame" | "overlay" => (format === "poster" ? "frame" : "overlay");

export interface MarketingRunMeta {
  format?: FormatId;
  templateId?: string;
  productId?: string | null;
  brandId?: string | null;
  styleId?: string;
  /** Open-engine text formats: the exact words the browser sets over the picture. */
  overlay?: RunOverlay | null;
  /** The picture with those words set (a Library generation), made in the browser once the picture is ready. */
  composed?: { id: string; url: string } | null;
  script?: string;
  mode?: "prompt" | "sections";
  notes?: string[];
  /** What the run was made from, so "Run again" can repeat it. */
  input?: Record<string, unknown>;
  /** Click to Ad: the logo end card it ends on (the card the page drew; null: the kit's logo on its colour). */
  endCard?: string | null;
  /** Click to Ad: the animated end card it ends on, and its style (none: the still card). */
  endCardClip?: string | null;
  endCardVariant?: string | null;
}

export interface MarketingRun {
  id: string;
  feature: RunFeature;
  batchId: string;
  engine: Engine;
  title: string;
  /** The results (the last step of a pipeline, or every output request). */
  finalIds: string[];
  meta: MarketingRunMeta;
  createdAt: number;
  /** Every step, oldest first. */
  generations: Generation[];
}

export interface PlannedStep {
  key: string;
  label: string;
  modelId: string;
  modelName: string;
  costUsd: number | null;
}

export interface RunEstimate {
  costUsd: number | null;
  demo: boolean;
  steps: PlannedStep[];
  notes: string[];
  /** Why it can't run yet (shown on the Generate button). */
  blocker?: string;
  runs: number;
}

/** The state of a whole run: its results', else the first step that failed on its own, else running. */
export function runStatus(r: Pick<MarketingRun, "generations" | "finalIds">): { state: "done" | "failed" | "running" | "canceled"; step?: string; error?: string } {
  const finals = r.generations.filter((g) => r.finalIds.includes(g.id));
  if (finals.length && finals.every((g) => g.status === "succeeded")) return { state: "done" };
  const failed = r.generations.find((g) => g.status === "failed" && !/earlier step/i.test(g.error ?? ""));
  if (failed) return { state: "failed", step: failed.request.step?.label, error: failed.error ?? undefined };
  if (!finals.length || finals.every((g) => g.status === "canceled" || g.status === "failed")) return { state: finals.some((g) => g.status === "failed") ? "failed" : "canceled" };
  return { state: "running" };
}
