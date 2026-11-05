/**
 * What Home shows: which presets, studios, models and skills, and every number it quotes, read
 * from the catalog, the ComfyUI manifest and the skills folder, never typed in. Server only: the page gets slim
 * cards and strings, and the catalog stays here (tests/home-showcase.test.ts checks every id and number).
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type { BeforeAfterStill } from "@/components/home/before-after";
import { NAV } from "@/components/nav-items";
import { APPS, EFFECTS, MODELS, MOTIONS, getPreset, isListed, modelCounts } from "@/lib/catalog";
import { CAMERA_MOVES } from "@/lib/catalog/cinema";
import { TEMPLATES } from "@/lib/catalog/marketing";
import type { ModelDef } from "@/lib/catalog/types";
import type { Manifest } from "@/lib/comfy";
import { homeBento, openModelsOf } from "@/lib/home-bento";
import { NAV_ENTRIES, studioCount } from "@/lib/nav-model";
import { HUB_MODES } from "@/lib/hubs";
import { modelHref } from "@/lib/palette-index";
import { cacheLife } from "next/cache";
import { studioCoverCard, toPresetCard } from "@/lib/preset-card-data";
import { PRESET_BEFORE_AFTER } from "@/lib/preset-before-after.generated";
import { onPeak, thumbOf, type PresetCardData } from "@/lib/preset-cards";

/**
 * Captions and kinds for these presets' tiles elsewhere (a studio's row of examples reads them: studio-examples.ts), in
 * a line that fits a phone's tile (HOME_CAPTION_MAX.wall). Home itself opens on its first screen's grid (home-bento.ts).
 */
export const HOME_WALL = [
  { id: "motion-crane-up", kind: "Camera motion", caption: "Rises over a pink lake" },
  { id: "effect-outfit-switch", kind: "Effect", caption: "Jeans to a ball gown" },
  { id: "app-behind-the-scenes", kind: "App · before → after", caption: "Reveals the film set" },
  { id: "effect-sand-storm", kind: "Effect", caption: "A wall of red sand" },
  { id: "motion-glam", kind: "Camera motion", caption: "A slow arc in gold" },
  { id: "effect-train-rush", kind: "Effect", caption: "A train rushes past" },
  { id: "motion-catwalk", kind: "Camera motion", caption: "Down the runway" },
  { id: "motion-fpv-drone", kind: "Camera motion", caption: "Diving over the cove" },
] as const;

/** The longest caption a wall tile (a phone's, 136 px at 360) and a row's card (two lines) hold whole. */
export const HOME_CAPTION_MAX = { wall: 22, card: 40 };

/**
 * Each card says in a few words what it does (the catalog's description stays its tooltip). Four rows wherever it is a
 * grid: all 24 from xl (six a row), the first 16 from lg (four a row), the first 12 from sm (three a row); a phone's
 * rail has all of them (home-sections.tsx). Premium first, no two alike side by side.
 */
export const HOME_EFFECTS = [
  { id: "effect-nature-bloom", caption: "Flowers overgrow the old station" },
  { id: "effect-wind-to-face", caption: "A gale sweeps back hair and coat" },
  { id: "effect-lens-flare", caption: "An anamorphic flare sweeps the frame" },
  { id: "effect-dirty-lens", caption: "Rain beads on the lens as it drifts" },
  { id: "effect-levitation", caption: "They float up off the dune" },
  { id: "effect-pearl-earring", caption: "Dressed as the Girl with a Pearl Earring" },
  { id: "effect-aquarium", caption: "The room floods into an aquarium" },
  { id: "effect-shadow-smoke", caption: "Ink-dark smoke rises around them" },
  { id: "effect-car-drive", caption: "A drive along the coast road" },
  { id: "effect-building-explosion", caption: "The building behind them explodes" },
  { id: "effect-flood", caption: "Water and candles rise around them" },
  { id: "effect-northern-lights", caption: "An aurora ripples across the sky" },
  { id: "effect-train-rush", caption: "A train rushes past by the mountains" },
  { id: "effect-blue-depth", caption: "She sinks slowly into the deep blue" },
  { id: "effect-contre-jour", caption: "The sun flares behind her in the wheat" },
  { id: "effect-pigeons", caption: "A flock of pigeons bursts up around him" },
  { id: "effect-marble", caption: "She turns to living marble by the sea" },
  { id: "effect-particles", caption: "Her gown streams into glowing particles" },
  { id: "effect-monet-muse", caption: "The garden turns into a Monet painting" },
  { id: "effect-agamemnon", caption: "A bronze-clad king before his army" },
  { id: "effect-silhouette", caption: "Backlit into a glowing silhouette" },
  { id: "effect-ice-rose", caption: "A rose of ice grows in his hands" },
  { id: "effect-diamond", caption: "She crystallizes into faceted diamond" },
  { id: "effect-fairytale-castle", caption: "A castle rises over the lake at dusk" },
];

/**
 * Four rows, as the effects (HOME_EFFECTS). None repeats the first screen: its video tile plays One take, and its image
 * tile is the gold sequins on the sea cliff (Glam's cover).
 */
export const HOME_MOTIONS = [
  { id: "motion-dolly-in", caption: "A slow push in through the library" },
  { id: "motion-classic-static", caption: "Locked off, framed like a painting" },
  { id: "motion-slow-motion", caption: "Every droplet in slow motion" },
  { id: "motion-double-dolly", caption: "Glides along with them, as if floating" },
  { id: "motion-crash-zoom-in", caption: "A crash zoom into the face" },
  { id: "motion-helicopter-shot", caption: "Circles high over the castle" },
  { id: "motion-super-dolly-out", caption: "From a close-up out to the whole valley" },
  { id: "motion-aerial-pullback", caption: "Pulls back to reveal the hedge maze" },
  { id: "motion-car-chasing", caption: "Chasing the car at speed" },
  { id: "motion-crane-over-the-head", caption: "Rises over their head to the view" },
  { id: "motion-lazy-susan", caption: "They turn as if on a turntable" },
  { id: "motion-crane-up", caption: "Rises over a pink salt lake" },
  { id: "motion-super-dolly-in", caption: "From the hangar door to a close-up" },
  { id: "motion-dreamy-flow", caption: "Drifts through the lavender like a dream" },
  { id: "motion-crane-down", caption: "Down from the rooftops to her level" },
  { id: "motion-snorricam", caption: "Locked to her as Paris moves around her" },
  { id: "motion-epic-scale", caption: "A lone figure against vast mountains" },
  { id: "motion-zoom-in", caption: "A slow zoom in on the chess player" },
  { id: "motion-arc-right", caption: "Arcs around him on a Greek hillside" },
  { id: "motion-low-shutter", caption: "Light trails swirl around the carousel" },
  { id: "motion-silent-machine", caption: "A cold, precise slide down the corridor" },
  { id: "motion-overhead", caption: "Turns slowly above the canoe and lilies" },
  { id: "motion-drone-reveal", caption: "Rises to reveal the lagoon and seaplane" },
  { id: "motion-intimate-observer", caption: "Close by his shoulder at the window" },
];

/**
 * The before/after under Apps: the app's HD stills (preset-before-after.generated.ts, at 512, 960 and 1280 px), else its
 * poster as the before and its peak frame as the after. `zoom` enlarges both alike: the sketch is a sheet of paper on
 * white, and its edges would show.
 */
export const HOME_BEFORE_AFTER = [
  { id: "app-sketch-to-real", tags: ["Sketch", "Photo"], zoom: 1.22 },
  { id: "app-relight", tags: ["Overcast", "Golden hour"], zoom: 1.02 },
  { id: "app-makeup-studio", tags: ["Bare", "Evening"], zoom: 1.02 },
] as const;

/**
 * Apps whose clip wipes from before to after: at rest they show the after. Twelve: from xl, six beside the before/after
 * and six in a row under it; four a row from lg, three from sm; a phone's rail has all of them.
 */
export const HOME_REVEALS = [
  { id: "app-outfit-swap", caption: "Wear the outfit from any photo" },
  { id: "app-steal-the-look", caption: "Copy the style of a reference" },
  { id: "app-product-shot", caption: "Your product, relit in a new scene" },
  { id: "app-match-colors", caption: "Take the colors of any photo" },
  { id: "app-outfit-shot", caption: "From a flat lay to a model shoot" },
  { id: "app-color-grading", caption: "A cinematic grade in one click" },
  { id: "app-behind-the-scenes", caption: "The film set behind the shot" },
  { id: "app-age-shift", caption: "The same face, decades older" },
  { id: "app-colorize", caption: "Black and white, now in color" },
  { id: "app-hairstyle-try-on", caption: "Try a new cut and color" },
  { id: "app-chameleon", caption: "The dress turns iridescent" },
  { id: "app-style-snap", caption: "From a sweater to black tie" },
];

/** A page's own card line from the navigation model, so its card says the same on Home and on its area page. */
const modelLine = (href: string) => () => {
  const line = NAV_ENTRIES.find((e) => e.href === href)?.line;
  if (!line) throw new Error(`Home's studio card for ${href} needs a line in the navigation model`);
  return line;
};

/**
 * Studio cards: a real cover (a clip, or a still: Marketing's product shot and Image to 3D's
 * turntable shot) and one line each. Audio’s is the demo its Clean up voice tool opens on (a studio without a cover
 * would show its tools by name: AudioCard). Four rows: all 16 from lg (four a row), the first 8 from sm (two a row); a
 * phone's rail has all of them. The last eight show their own covers (the navigation model's) and lines, premium first:
 * by the featured band of their covers (preset-featured.ts), no two alike side by side.
 */
export const HOME_STUDIOS: { href: string; id?: string; line: (f: HomeFacts) => string }[] = [
  { href: "/cinema", id: "motion-arc-left", line: (f) => `Direct a film shot by shot: camera, lens, light and ${f.cinemaMoves} moves.` },
  // A swap as it happens (studio-covers.ts): the original take, then the swapped one wiped in across it.
  { href: "/genjutsu", id: "genjutsu-lake-swap", line: () => "Keep a clip’s motion. Change what’s in it." },
  { href: "/character-swap", id: "app-character-swap", line: () => "Put your character into whole clips, shot by shot." },
  { href: "/marketing", id: "app-macroshot-product", line: (f) => `From a product link to a finished ad. ${f.adTemplates} ad templates.` },
  { href: "/mixed-media", id: "effect-paper", line: (f) => `Redraw a clip as collage, paper or paint, in ${f.mixedLooks} looks.` },
  { href: "/motion-control", id: "motion-static", line: () => "Give anyone the moves from any clip." },
  { href: "/audio", id: "app-clean-up-voice", line: () => "Voices, music and sound for any clip, made or split apart." },
  // The collectible figure: the first screen's 3D tile plays the turning gown (home-bento.ts), and a clip plays in one place.
  { href: "/image-to-3d", id: "app-3d-figure", line: () => "A photo or a sentence to a 3D model you can spin." },
  { href: "/shorts", id: "motion-catwalk", line: modelLine("/shorts") },
  { href: "/video-edit", id: "effect-outfit-switch", line: modelLine("/video-edit") },
  { href: "/storyboard", id: "app-shots", line: modelLine("/storyboard") },
  { href: "/photodump", id: "app-headshot-generator", line: modelLine("/photodump") },
  { href: "/ads", id: "app-billboard-ad", line: modelLine("/ads") },
  { href: "/reframe", id: "app-expand-image", line: modelLine("/reframe") },
  // Kinetic draws its own cover (studio-covers.ts): Runway Titles at the card's shape, its title cutting in over the gold gown.
  { href: "/kinetic", id: "kinetic-runway-titles", line: () => "Motion graphics in your brand: titles, offers and end cards." },
  { href: "/image", id: "app-poster", line: modelLine("/image") },
];

/** Destinations with a section of their own on Home, so they aren't pills as well. */
export const HOME_OWN_SECTIONS = ["/assist", "/motions", "/effects", "/apps", "/live-edit"];

/** Live edit's moment on Home: a recorded session plays (no GPU, no requests), with one way in. */
export const HOME_LIVE = {
  href: "/live-edit?from=home",
  title: "Change it as you type",
  line: "Type a change and the picture follows, a live frame every few words. Every change joins one sentence drawn on your original, so go back through the words and each picture returns, sharp.",
};

/** Assist's starter skills, as its empty chat lists them first (assist-view.tsx). */
export const HOME_SKILLS = ["product-photoshoot", "ugc-video", "thumbnail-generation", "faceless-video", "short-film", "localization"];

/**
 * "Just added", newest first: only the ones in the catalog and not hidden show, so a model shows the day its
 * branch merges. Fewer than 6 left, the catalog's other new open models fill in.
 */
export const HOME_NEW_OPEN = [
  "oss-minimax-h3",
  "oss-qwen-image-21",
  "oss-ideogram-4",
  "oss-krea2-realism",
  "oss-fibo2-dev",
  "oss-moss-image",
  "oss-ltx25",
  "oss-wan-move",
  "oss-void-remove",
  "oss-dbs-separate",
  "oss-trellis2",
  "oss-pixal3d",
  "oss-qwen-layered",
  "oss-stable-audio-3",
  "oss-triposplat",
];

/**
 * The chips under the composer. Each fills it with a prompt that looks like a picture on this page (the gold sequins
 * on the first screen, Relight under Apps); nothing runs until Start. Whoever runs the studio gets Assist's chip in
 * place of the last (home-view.tsx): only the owner can use Assist.
 */
export const HOME_TRY = [
  {
    mode: "image",
    label: "Gold sequins on a sea cliff",
    prompt: "Editorial fashion photo of a model in a gold sequin dress and a flowing gold cape on a white cliff above a turquoise bay, golden hour",
  },
  {
    mode: "video",
    label: "Drone dive over a turquoise cove",
    prompt: "FPV drone dives off a limestone cliff and skims a turquoise cove past a white yacht, bright morning sun",
  },
  { mode: "edit", label: "Make it golden hour", prompt: "Make it golden hour: warm low sun, long soft shadows and a glowing sky" },
  {
    mode: "image",
    label: "Silk on a pink salt lake",
    prompt: "Editorial fashion photo of a model in a yellow silk slip dress on a white salt road across a pink salt lake, bright sun",
  },
] as const;

export interface HomeFacts {
  /** Models a visitor can pick that run on their own GPU (modelCounts().open). */
  openModels: number;
  workflows: number;
  originals: number;
  /** Models that run only in the cloud, through the viewer's own fal.ai or Replicate key (modelCounts().cloud). */
  partners: number;
  presets: number;
  apps: number;
  motions: number;
  effects: number;
  /** Every place to create from the navigation: Create (but Home) and Studios. */
  destinations: number;
  cinemaMoves: number;
  adTemplates: number;
  mixedLooks: number;
  audioTools: number;
  skills: number;
}

/** "130+": the open models rounded down to ten, so it never overstates. */
export const roundedDown = (n: number) => `${Math.floor(n / 10) * 10}+`;

const isOpen = (m: ModelDef) => m.engine === "open" || !!m.engines?.includes("open");

/** A preset's card, resting on its peak frame when it has one (onPeak). */
export function homeCard(id: string): PresetCardData {
  const p = getPreset(id);
  // A studio's own cover (studio-covers.ts) where no preset has the id: Genjutsu's group swap.
  const card = p ? toPresetCard(p) : studioCoverCard(id);
  if (!card) throw new Error(`Home names ${id}, which isn't in the catalog or a studio's cover`);
  return onPeak(card);
}

/** Where a preset's card opens: an app's own page, else the Video studio with it picked. */
export const presetHref = (id: string) => (id.startsWith("app-") ? `/apps/${id}` : `/video?preset=${id}`);

const navItems = (label: string) => NAV.find((g) => g.label === label)?.items ?? [];
export const navLabel = (href: string) => [...navItems("Create"), ...navItems("Studios")].find((i) => i.href === href)?.label ?? href;

/** The navigation's places to create, but Home. */
export const homeDestinations = () => [...navItems("Create"), ...navItems("Studios")].filter((i) => i.href !== "/");

/** The places to create that have no card or section of their own on Home, in the navigation's order. */
export const homePills = () =>
  homeDestinations()
    .filter((i) => !HOME_OWN_SECTIONS.includes(i.href) && !HOME_STUDIOS.some((s) => s.href === i.href))
    .map((i) => ({ href: i.href, label: i.label }));

/** The Just added models: the list's live ones, then other new open models up to 6. */
export function newOpenModels(models: ModelDef[] = MODELS) {
  const live = (m: ModelDef | undefined): m is ModelDef => !!m && !m.hidden && isOpen(m);
  const listed = HOME_NEW_OPEN.map((id) => models.find((m) => m.id === id)).filter(live);
  const more =
    listed.length < 6
      ? models.filter((m) => live(m) && m.badges?.includes("new") && m.vendor !== "Fuobe Original" && !m.name.includes("(") && !listed.includes(m))
      : [];
  return [...listed, ...more].slice(0, 8).map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, kind: m.kind, tagline: m.tagline, href: modelHref(m) }));
}

/** The Audio card's words: five of the studio's tools by name, then how many more it has. */
export function audioTools() {
  const named = ["speech", "dialogue", "music", "sfx", "split"].flatMap((id) => HUB_MODES.audio.filter((m) => m.id === id).map((m) => m.label));
  return { named, more: HUB_MODES.audio.length - named.length };
}

/** A JSON file's contents, or null when it's missing or unreadable (as the About page reads it). */
async function readJson<T>(text: Promise<string>): Promise<T | null> {
  try {
    return JSON.parse(await text) as T;
  } catch {
    return null;
  }
}

/** The skills folder: how many skills there are, and the starters' titles (each SKILL.md's metadata.title). */
async function readSkills() {
  const dir = path.join(process.cwd(), "skills");
  const names = await fs.readdir(dir, { withFileTypes: true }).then(
    (all) => all.filter((d) => d.isDirectory()).map((d) => d.name),
    () => [] as string[],
  );
  const has = await Promise.all(names.map((n) => fs.access(path.join(dir, n, "SKILL.md")).then(() => n, () => null)));
  const titles = await Promise.all(
    HOME_SKILLS.map(async (name) => {
      const text = await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => "");
      return { name, title: /^\s+title:\s*(.+)$/m.exec(text)?.[1].trim() };
    }),
  );
  return { count: has.filter(Boolean).length, starters: titles.flatMap((t) => (t.title ? [{ name: t.name, title: t.title }] : [])) };
}

/** A row's card with its short line. */
const captioned = ({ id, caption }: { id: string; caption: string }) => ({ card: homeCard(id), caption });

/**
 * Everything Home shows, from its first screen down, computed once per build (the page stays prerendered): all of it changes
 * only with a deploy, so it's kept for as long as Next keeps anything ("max").
 */
export async function homeShowcase() {
  "use cache";
  cacheLife("max");
  const [manifest, skills] = await Promise.all([
    readJson<Manifest>(fs.readFile(path.join(process.cwd(), "workflows", "comfyui", "manifest.json"), "utf8")),
    readSkills(),
  ]);
  const workflows = manifest?.workflows ?? [];
  const visible = MODELS.filter(isListed);
  const counts = modelCounts();
  const facts: HomeFacts = {
    openModels: counts.open,
    workflows: workflows.length,
    originals: visible.filter((m) => m.vendor === "Fuobe Original").length,
    partners: counts.cloud,
    presets: APPS.length + MOTIONS.length + EFFECTS.length,
    apps: APPS.length,
    motions: MOTIONS.length,
    effects: EFFECTS.length,
    destinations: homeDestinations().length,
    cinemaMoves: CAMERA_MOVES.length,
    adTemplates: TEMPLATES.filter((t) => !t.ownerOnly).length,
    mixedLooks: EFFECTS.filter((e) => e.category === "Mixed Media").length,
    audioTools: HUB_MODES.audio.length,
    skills: skills.count,
  };
  const bento = await homeBento({
    studios: studioCount(),
    apps: facts.apps,
    effectsAndMotions: facts.effects + facts.motions,
    motions: facts.motions,
    openModels: facts.openModels,
    imageModels: openModelsOf("image"),
    videoModels: openModelsOf("video"),
    models3d: openModelsOf("model3d"),
    soundTools: facts.audioTools,
  });
  return {
    facts,
    bento,
    effects: HOME_EFFECTS.map(captioned),
    motions: HOME_MOTIONS.map(captioned),
    reveals: HOME_REVEALS.map(captioned),
    beforeAfter: HOME_BEFORE_AFTER.map(({ id, tags, zoom }) => {
      const card = homeCard(id);
      const v = PRESET_BEFORE_AFTER[id];
      const still = (side: "before" | "after"): BeforeAfterStill =>
        v
          ? {
              src: `/previews/presets/ba/512/${id}-${side}.jpg?v=${v}`,
              hd: { 960: `/previews/presets/ba/960/${id}-${side}.jpg?v=${v}`, 1280: `/previews/presets/ba/1280/${id}-${side}.jpg?v=${v}` },
            }
          : { src: side === "before" ? card.preview.poster : (card.preview.rest?.src ?? card.preview.poster) };
      return { id, name: card.name, before: still("before"), after: still("after"), thumb: thumbOf(card.preview.poster), tags: [...tags], zoom, href: presetHref(id) };
    }),
    studios: HOME_STUDIOS.map((s) => ({ href: s.href, label: navLabel(s.href), line: s.line(facts), card: s.id ? homeCard(s.id) : undefined })),
    audioTools: audioTools(),
    pills: homePills(),
    newModels: newOpenModels(),
    skills: skills.starters,
  };
}

export type HomeShowcase = Awaited<ReturnType<typeof homeShowcase>>;
