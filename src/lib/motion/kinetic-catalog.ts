/**
 * Kinetic's scene catalogue (pure, bundled with the page: no data route). Built from Marketing's code-drawn templates,
 * so names, fields, Easy choices, sizes and lengths stay in one place; this file adds each scene's address, what the
 * editor offers on it (a clip under the words, the Pro controls), its motion groups and the four examples.
 */

import { TEMPLATES, type MarketingTemplate } from "@/lib/catalog/marketing";
import { applyPreset, type PresetCategory } from "./edit";
import { CLIP_SCENES, groupDefsFor, groupIdsFor, type MotionGroupDef } from "./kinetic-groups";
import { normalizeRecipe, type Recipe } from "./recipe";
import { END_CARD_VARIANTS, type EndCardVariant } from "./scenes/end-card/shared";
import type { ScenePlan } from "./scene";
import { SHOWCASES, showcaseRecipe } from "./showcase";
import { initialState, templateLengths, templateRecipe, templateSizes, type TemplateBrand } from "./template";

export type KineticSlug =
  | "kinetic-headline"
  | "line-reveal"
  | "logo-sting"
  | "feature-cards"
  | "stat-dashboard"
  | "starburst"
  | "offer-badge"
  | "big-number"
  | "quote"
  | "end-card"
  | "drop-countdown"
  | "fragrance-reveal"
  | "editorial-sale"
  | "glass-spotlight"
  | "announcement"
  | "lookbook"
  | "stat-stack"
  | "testimonials";

export interface KineticEntry {
  slug: KineticSlug;
  /** The Marketing template it comes from (fields, Easy choices, sizes, lengths, showcase). */
  template: string;
  name: string;
  /** One line of purpose. */
  blurb: string;
  /** The scene ids it plays: one, or the end card's five styles. */
  scenes: string[];
  /** It takes the person's own clip under its words. */
  clip: boolean;
  /** Which wrapper-level Pro controls apply (end cards have no Pace, Look or Ground light). */
  pro: { pace: boolean; look: boolean; light: boolean };
  groups: MotionGroupDef[];
}

const ORDER: { slug: KineticSlug; template: string; blurb: string }[] = [
  { slug: "kinetic-headline", template: "ms-kinetic-headline", blurb: "Your promise sets itself letter by letter in huge type over a lit field." },
  { slug: "big-number", template: "ms-big-number", blurb: "One huge stat counts up to its value, with a caption and your logo." },
  { slug: "end-card", template: "ms-end-card", blurb: "Your logo, line and call to action in one of five animated styles." },
  { slug: "quote", template: "ms-five-star-quote", blurb: "A customer's words set line by line beside a photo, then five stars pop in." },
  { slug: "logo-sting", template: "ms-logo-sting", blurb: "Your name comes into focus in polished metal, and your mark lands last." },
  { slug: "feature-cards", template: "ms-feature-cards", blurb: "Three cards slide in under a big headline, one benefit each." },
  { slug: "stat-dashboard", template: "ms-dashboard-zoom", blurb: "The camera pushes into a dashboard as a key number counts up." },
  { slug: "drop-countdown", template: "m2-midnight-drop", blurb: "Your drop's name cuts in huge, then a countdown flips into place tile by tile." },
  { slug: "fragrance-reveal", template: "m2-nocturne", blurb: "Ribbons of light cross the night as your bottle rises under a fine serif name." },
  { slug: "editorial-sale", template: "m2-season-finale", blurb: "Your sale in huge type beside a fashion photo, the offer on a highlighter." },
  { slug: "glass-spotlight", template: "m2-prism-stage", blurb: "Your product stands on a glass plinth in rings of light, its name beside it." },
  { slug: "announcement", template: "mm-marquee", blurb: "Your event's name lights up over a night photo, with the date and place." },
  { slug: "lookbook", template: "mm-runway-titles", blurb: "A giant title cuts in letter by letter over a full-bleed fashion photo." },
  { slug: "stat-stack", template: "ms-stat-stack", blurb: "Three big numbers roll up on an editorial grid, each with its label." },
  { slug: "testimonials", template: "ms-kind-words", blurb: "Three customers' words slide through on cards, each with its stars and name." },
  { slug: "line-reveal", template: "m2-line-reveal", blurb: "One line draws your product, then the real product fills in." },
  { slug: "starburst", template: "m2-retro-starburst", blurb: "A retro starburst turns behind your product and headline." },
  { slug: "offer-badge", template: "m2-offer-badge", blurb: "An offer badge lands beside your product under a bold headline." },
];

const byTemplate = new Map(TEMPLATES.map((t) => [t.id, t]));

export const templateOf = (e: Pick<KineticEntry, "template">): MarketingTemplate => byTemplate.get(e.template)!;

export const KINETIC_SCENES: KineticEntry[] = ORDER.map((o) => {
  const t = byTemplate.get(o.template)!;
  const endCard = t.scene!.startsWith("end-card/");
  const scenes = endCard ? END_CARD_VARIANTS.map((v) => `end-card/${v}`) : [t.scene!];
  return {
    slug: o.slug,
    template: o.template,
    name: t.name,
    blurb: o.blurb,
    scenes,
    clip: scenes.every((s) => CLIP_SCENES.includes(s)),
    pro: { pace: !endCard, look: !endCard, light: !endCard },
    groups: groupDefsFor(scenes[0]),
  };
});

export const KINETIC_SLUGS = KINETIC_SCENES.map((e) => e.slug);

export const entryBySlug = (slug: string | null | undefined): KineticEntry | undefined => KINETIC_SCENES.find((e) => e.slug === slug);

/** The entry a recipe belongs to: by its template first, then by its scene (Click to Ad's end cards have no template). */
export function entryForRecipe(r: Pick<Recipe, "scene" | "controls">): KineticEntry | undefined {
  const t = r.controls?.template;
  return (typeof t === "string" && KINETIC_SCENES.find((e) => e.template === t)) || KINETIC_SCENES.find((e) => e.scenes.includes(r.scene));
}

export interface KineticExample {
  slug: KineticSlug;
  /** The end card's style. */
  style?: EndCardVariant;
  label: string;
  /** One line of what it shows. */
  purpose: string;
  /** The presets it is finished with (Appearance, Motion, Camera), so it is more than the scene's own tile. */
  presets: Partial<Record<PresetCategory, string>>;
}

/** The four examples on the opening screen: each scene finished with a look, a feel and a camera. */
export const KINETIC_EXAMPLES: KineticExample[] = [
  { slug: "kinetic-headline", label: "Kinetic Headline", purpose: "A launch line in film grain, with a slow push", presets: { appearance: "film", camera: "push" } },
  { slug: "big-number", label: "Big Number", purpose: "A record stat that lands hard, in rich colour", presets: { appearance: "rich", motion: "snappy" } },
  { slug: "end-card", style: "glint", label: "Logo End Card", purpose: "Your logo caught by a sweep of light", presets: { appearance: "film" } },
  { slug: "quote", label: "Five-Star Quote", purpose: "A review set softly, word by word", presets: { appearance: "soft", motion: "steady" } },
];

/** An example's opening recipe: its scene's showcase with the example's presets, in the feed's 4:5 where it is offered. */
export function exampleRecipe(x: KineticExample): Recipe {
  const e = entryBySlug(x.slug)!;
  let r = startRecipe(e, { style: x.style });
  if (templateSizes(templateOf(e)).includes("4:5")) r = { ...r, size: "4:5" };
  for (const [category, id] of Object.entries(x.presets) as [PresetCategory, string][]) r = applyPreset(category, id, r);
  return r;
}

/**
 * Where a scene rests when it can't play (reduced motion) or is shown still: its showcase's telling moment when that
 * comes before the end (Kinetic Headline: the headline set, before its end card), else its last frame.
 */
export function restingTime(plan: ScenePlan, r: Pick<Recipe, "controls">): number {
  const id = r.controls?.template;
  const poster = typeof id === "string" ? SHOWCASES[id]?.poster : undefined;
  const at = poster ? plan.timeline.events.find((e) => e.id === poster)?.start : undefined;
  return typeof at === "number" ? Math.min(plan.rest, Math.max(0, Math.round((at - 0.08) * 100) / 100)) : plan.rest;
}

/** The scenes that take a clip, for the opening screen's chip. */
export const clipScenes = () => KINETIC_SCENES.filter((e) => e.clip).map((e) => e.slug);

/** Every group id a scene can hold in a recipe (its groups and a Camera group per shot). */
export const groupIdsOf = (e: KineticEntry): string[] => groupIdsFor(e.scenes[0]);

/** A saved or typed recipe, checked and held to its scene (a clip it can't take and unknown groups are dropped). */
export function normalizeKinetic(input: unknown): { recipe: Recipe; entry: KineticEntry } | null {
  let r: Recipe;
  try {
    r = normalizeRecipe(input);
  } catch {
    return null;
  }
  const entry = entryForRecipe(r);
  if (!entry || !entry.scenes.includes(r.scene)) return null;
  const t = templateOf(entry);
  // Click to Ad's end cards keep their own length (2 to 3 s), which the end card's own limits hold too.
  const recipe = normalizeRecipe(r, templateLengths(t), { clip: entry.clip, groups: groupIdsOf(entry) });
  return { recipe, entry };
}

/** A scene's opening recipe: its showcase (the person's stored brand when they set one), the end card in `style`. */
export function startRecipe(e: KineticEntry, o: { brand?: TemplateBrand | null; style?: EndCardVariant | null } = {}): Recipe {
  const t = templateOf(e);
  if (!o.brand) {
    const show = showcaseRecipe(t.id, t.scene!, templateLengths(t).default);
    if (show) {
      const style = o.style && e.slug === "end-card" ? o.style : null;
      return style ? { ...show, scene: `end-card/${style}`, controls: { ...show.controls, style } } : show;
    }
  }
  const state = initialState(t, o.brand ?? null);
  if (o.style && e.slug === "end-card") state.controls.style = o.style;
  return templateRecipe(t, state);
}

/** The scene's address for a recipe ("/kinetic?scene=end-card&style=glint"). */
export function kineticHref(e: Pick<KineticEntry, "slug">, style?: string | null): string {
  return `/kinetic?scene=${e.slug}${style ? `&style=${style}` : ""}`;
}
