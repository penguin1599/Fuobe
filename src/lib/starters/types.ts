/**
 * Ready-made starters outside Canvas (client-safe: no catalog). A starter is a real piece of work, a chat's whole job, a
 * film, a story, an element, a channel, a series, an explainer, a brand kit or a product with its photo, filled with its own words and settings, so it runs as it is.
 * The list lives on the server (src/lib/starters/catalog.ts); pages get these slim cards as props.
 */
import type { TemplateCover } from "@/lib/template-covers";

export type StarterSurface = "assist" | "library" | "cinema" | "storyboard" | "elements" | "faceless" | "content-factory" | "explainer" | "ads" | "click-to-ad" | "marketing";

/**
 * Where each surface lives, and where its starters' pages are (`<base>/start/<id>`). `note` is the line under the
 * section's title; `visitorNote`, where it differs, a guest's or an account's.
 */
export const STARTER_SURFACES: Record<StarterSurface, { base: string; name: string; section: string; note: string; visitorNote?: string; unavailable: string }> = {
  assist: {
    base: "/assist",
    name: "Assist",
    section: "Start from a ready job",
    note: "Each one types a whole job into the box above. Change anything, then send.",
    visitorNote: "A whole job in one message. See how each one is made.",
    unavailable: "Assist isn't available here.",
  },
  library: { base: "/library", name: "Library", section: "Make your first", note: "Each one opens a studio with everything in place. Change anything, then make it.", unavailable: "" },
  cinema: {
    base: "/cinema",
    name: "Cinema Studio",
    section: "Start from a ready film",
    note: "Each one comes with its look, its brief and three shots. It opens with shot 1 ready to make.",
    unavailable: "Projects aren't available here.",
  },
  storyboard: {
    base: "/storyboard",
    name: "Storyboard",
    section: "Start from a ready story",
    note: "Each one puts its story, frames, shape and look into the box above. Change anything, then make it.",
    visitorNote: "A story, its frames, its shape and its look, ready to make.",
    unavailable: "Storyboards aren't available here.",
  },
  elements: {
    base: "/elements",
    name: "Elements",
    section: "Start with a ready element",
    note: "A model, a place, a product and a look, each saved from its own pictures. Then type its @name in any image or video prompt.",
    visitorNote: "A model, a place, a product and a look, each made from its own pictures.",
    unavailable: "Elements aren't available here.",
  },
  faceless: { base: "/faceless", name: "Faceless Studio", section: "Start from a ready channel", note: "Each one comes with its idea, its first episode and its look, so it runs as it is.", unavailable: "Faceless channels aren't available here." },
  "content-factory": { base: "/content-factory", name: "Content Factory", section: "Start from a ready series", note: "A style and an idea, ready to make. Change anything before you start.", unavailable: "Content Factory isn't available here." },
  explainer: { base: "/explainer", name: "Explainer", section: "Start from a ready explainer", note: "A topic, a style and a length, ready to make.", unavailable: "Explainer videos aren't available here." },
  ads: { base: "/ads", name: "Ads Studio", section: "Start from a ready brand", note: "A brand kit with a product and its photo, ready for ads.", unavailable: "Brand kits aren't available here." },
  "click-to-ad": { base: "/marketing/click-to-ad", name: "Click to Ad", section: "Start from a ready product", note: "A product with its photo and words, ready for a video ad.", unavailable: "Click to Ad isn't available here." },
  marketing: { base: "/marketing", name: "Marketing Studio", section: "Start from a ready shoot", note: "A product photo and a scene, ready to make.", unavailable: "Marketing Studio isn't available here." },
};

/** What goes in, as a starter's page shows it: its words, or its photo. */
export interface StarterInput {
  label: string;
  text?: string;
  image?: { thumb: string; name: string };
  /** A recording, played on its page. */
  audio?: { src: string; name: string };
}

/**
 * What the owner's "Use template" does: make it on the server (POST /api/starters/<id>), or fill the composer on this
 * page. A "link" (the Library's row) opens another studio with everything loaded there, for everyone.
 */
export type StarterUse =
  | { kind: "create" }
  | { kind: "fill"; href: string }
  /** `ownerHref`: where it opens for the owner, when that differs (a ready board the owner can save). */
  | { kind: "link"; href: string; ownerHref?: string };

/** A starter as its card and its page show it. Its words are visitor words: no model names. */
export interface StarterCardData {
  id: string;
  surface: StarterSurface;
  rank: number;
  name: string;
  description: string;
  /** lucide icon name (StarterIcon). */
  icon: string;
  hue: number;
  /** The steps as a word or two each, over the cover's corner. */
  flow: string[];
  /** The steps in plain words (its page's "The steps"). */
  steps: string[];
  /** What comes out, in plain words. */
  makes: string;
  inputs: StarterInput[];
  /** Its real cover, when it has one: visitors only see starters that have it. */
  cover?: TemplateCover;
  /** The cover's key, for one-clip-at-a-time playback. */
  coverKey: string;
  /** A portrait cover: shown from its top, so a head is never cut off in a wide frame. */
  coverTop?: boolean;
  use: StarterUse;
  /**
   * Where a guest or an account goes on from its page: the app that makes the same from the same photo, its example
   * loaded (`example`), or the studio with this starter in its composer. `text`: the button's words, when "Try it in
   * <label>" would promise more than a visitor can do there.
   */
  tryIn?: { href: string; label: string; example?: string; text?: string };
}

/**
 * The composer a "fill" starter loads (Assist, Storyboard, Content Factory, Explainer): small enough to pass to the page, read when the
 * page opens with `?starter=<id>` or when the owner taps "Use template" on its card.
 */
export type StarterFill = (
  | { kind: "assist"; text: string }
  | { kind: "storyboard"; story: string; frames: number; aspectRatio: string; look?: string }
  | { kind: "content-factory"; presetId: string; prompt: string; length: number; episodes: number }
  | { kind: "explainer"; prompt: string; styleId: string; duration: "auto" | number; aspect: "9:16" | "16:9"; voice?: string }
) & {
  /** The starter's narrator sample, stored for the owner (/api/files/…): the open engine's narrator clones a voice. */
  voiceSample?: string;
};

/** GET /api/starters?surface=: every starter of a surface, for the owner (a page's props carry only covered ones). */
export interface OwnerStarters {
  starters: StarterCardData[];
  fills: Record<string, StarterFill>;
}

/** The starter's page (`<base>/start/<id>`); a link's is where it opens (for the owner, its `ownerHref` when it has one). */
export const starterHref = (s: Pick<StarterCardData, "id" | "surface"> & { use?: StarterUse }, owner = false) =>
  s.use?.kind === "link" ? (owner && s.use.ownerHref) || s.use.href : `${STARTER_SURFACES[s.surface].base}/start/${s.id}`;

/** Who sees a starter's card: a visitor only one with its real cover (the owner sees all, marked). */
export const starterShown = (s: Pick<StarterCardData, "cover">, visitor: boolean) => !visitor || !!s.cover;

/**
 * Surfaces whose starters a visitor makes too: a signed-in account's Cinema film and Faceless channel are its own
 * projects, and a ready series or explainer fills its own composer (a guest is offered a free account first). Elsewhere
 * a starter is saved to the owner's library, so only the owner makes it.
 */
export const VISITOR_MAKES: ReadonlySet<StarterSurface> = new Set<StarterSurface>(["cinema", "faceless", "content-factory", "explainer"]);
