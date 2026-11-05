/**
 * The search palette's ranking (pure, so it's testable and instant: a couple of milliseconds for every studio, tool,
 * app, motion, effect and model). It reads a query the way people type one ("ad for my perfume"): filler words out,
 * plurals and -ing folded, every word matched against names and search words, and a table of intents that knows a
 * perfume ad is a job for Marketing Studio. The word match itself is command-search.ts's (wordScore).
 */
import { GROUP_LIMIT, KIND_LABELS, normalize, wordScore, type PaletteEntry, type PaletteKind } from "./command-search";
import { entry as navEntry, STUDIO_SUBS, THEME_ACTION, type NavEntry, type NavKind } from "./nav-model";

export type HitKind = PaletteKind | "studio" | "tool";

/** What the palette searches: the index's entries (PaletteEntry) and the navigation's (navSearchEntries). */
export interface SearchEntry extends Omit<PaletteEntry, "kind"> {
  kind: HitKind;
  /** The nav entry id, or the preset / model id. */
  id?: string;
  /** One line under the name. */
  what?: string;
  /** A preset id (nav covers) or a full thumb URL (index presets). */
  cover?: string;
  /** The nav entry's kind (studio, create, tool…), which decides its tag and its weight. */
  navKind?: NavKind;
  /** A nav icon name. */
  icon?: string;
  popular?: boolean;
  /** A tool's studio id (a nav entry's parent): a studio found as the best match lists its tools after it. */
  parent?: string;
}

export interface NavHit {
  key: string;
  kind: HitKind;
  label: string;
  what?: string;
  href: string;
  /** A preset id or a full thumb URL. */
  cover?: string;
  /** Where it comes from, before its name ("Camera motions" › Dolly In). */
  from?: string;
  hint?: string;
  icon?: string;
  navKind?: NavKind;
  id?: string;
  score: number;
}

export interface Intent {
  id: string;
  /** Query words (or phrases) that mean it. */
  triggers: string[];
  /** Nav entry ids or preset ids, best first. */
  targets: string[];
}

export interface SearchResult {
  /** The top three, whatever their kind. */
  best: NavHit[];
  /** The next two apps, motions or effects, with where they come from. */
  also: NavHit[];
  /** Everything else that matched, by kind, each group capped. */
  groups: { kind: string; label: string; hits: NavHit[] }[];
}

/** Words that carry no meaning for finding a tool ("make me an ad for my perfume" is about an ad and a perfume). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  "a an the for my our your of to with in on and me i we want need some something like please make create do can how new turn into change add get put use using from this that it".split(" "),
);

/** What people mean, and where it's done best (the first target first). */
export const INTENTS: readonly Intent[] = [
  {
    id: "product-ad",
    triggers: [..."ad advert advertisement commercial promo perfume fragrance cosmetic skincare lipstick product packshot sell shop brand campaign ecommerce amazon shopify launch".split(" "), "product photo", "product shot"],
    targets: ["marketing", "ads", "app-giant-product", "app-billboard-ad", "app-product-shot", "motion-dolly-in", "effect-turning-metal"],
  },
  { id: "ugc", triggers: ["ugc", "testimonial", "review", "unboxing"], targets: ["marketing", "app-unboxing-video", "lipsync"] },
  { id: "reel", triggers: ["reel", "reels", "tiktok", "short", "shorts", "vertical", "instagram", "story", "viral"], targets: ["shorts", "reframe", "virality", "content-factory"] },
  { id: "channel", triggers: ["youtube", "channel", "faceless", "episode", "series", "podcast"], targets: ["faceless", "content-factory", "explainer", "audio"] },
  { id: "film", triggers: ["film", "movie", "cinematic", "scene", "shot", "director", "trailer", "music video"], targets: ["cinema", "storyboard", "motions", "katana"] },
  { id: "dance", triggers: ["dance", "choreography", "pose", "moves", "tiktok dance"], targets: ["motion-control", "app-dance", "genjutsu"] },
  { id: "talk", triggers: ["talk", "talking", "speak", "lipsync", "lip sync", "avatar", "presenter", "spokesperson"], targets: ["lipsync", "app-talking-photo", "audio-speech"] },
  { id: "sound", triggers: ["sound", "audio"], targets: ["audio", "audio-clean", "audio-sfx", "audio-music"] },
  { id: "voice", triggers: ["voice", "voiceover", "voice over", "narration", "narrator", "tts", "text to speech", "read aloud"], targets: ["audio-speech", "audio", "lipsync"] },
  { id: "music", triggers: ["music", "song", "soundtrack", "beat", "jingle", "score", "background music"], targets: ["audio-music", "audio", "audio-video"] },
  { id: "sfx", triggers: ["sfx", "foley", "whoosh", "sound effect"], targets: ["audio-sfx", "audio-video", "audio"] },
  { id: "clean-audio", triggers: ["noise", "echo", "denoise", "clean audio", "mic"], targets: ["audio-clean", "app-clean-up-voice"] },
  { id: "dub", triggers: ["translate", "dub", "dubbing", "language", "localize"], targets: ["audio-translate", "video-tools-captions"] },
  { id: "captions", triggers: ["caption", "captions", "subtitle", "subtitles", "srt"], targets: ["video-tools-captions", "audio-transcribe"] },
  { id: "fashion", triggers: ["outfit", "dress", "clothes", "fashion", "try on", "tryon", "lookbook", "wear", "model shoot"], targets: ["fashion-factory", "app-virtual-try-on", "app-outfit-swap", "effect-outfit-switch"] },
  { id: "character", triggers: ["character", "consistent", "same face", "turnaround", "angles", "persona"], targets: ["character-sheet", "influencer", "elements", "app-fuobe-angles"] },
  { id: "influencer", triggers: ["influencer", "creator", "persona", "ai model"], targets: ["influencer", "photodump", "fashion-factory"] },
  { id: "swap", triggers: ["swap", "replace", "face swap", "insert", "deepfake", "recast"], targets: ["character-swap", "genjutsu", "app-face-swap", "app-recast"] },
  { id: "upscale", triggers: ["upscale", "4k", "8k", "sharper", "sharpen", "enhance", "hd", "resolution", "blurry"], targets: ["upscale", "upscale-video", "app-upscale"] },
  { id: "background", triggers: ["background", "bg", "remove background", "cutout", "green screen", "transparent"], targets: ["video-tools-matte", "app-remove-background", "app-change-background", "layers"] },
  { id: "fix", triggers: ["fix", "retouch", "remove", "erase", "object", "inpaint"], targets: ["inpaint", "video-tools-remove-object", "app-object-remover", "edit"] },
  { id: "animate", triggers: ["animate", "motion", "move", "bring to life", "image to video"], targets: ["video", "motions", "app-bring-to-life"] },
  // Not "model": an AI model, a fashion model and a 3D model are three things.
  { id: "3d", triggers: ["3d", "mesh", "glb", "turntable", "figure", "figurine"], targets: ["image-to-3d", "app-3d-figure", "app-3d-rotation"] },
  { id: "photos", triggers: ["photos", "photoshoot", "headshot", "portrait", "profile picture", "dating"], targets: ["photodump", "app-headshot-generator", "image"] },
  { id: "moodboard", triggers: ["moodboard", "mood", "style", "look", "aesthetic", "reference"], targets: ["moodboards", "app-steal-the-look", "app-style-transfer"] },
  { id: "colour", triggers: ["color", "colour", "grade", "lut", "cinematic look"], targets: ["color-grade", "app-color-grading"] },
  { id: "longer", triggers: ["longer", "extend", "continue"], targets: ["extend"] },
  { id: "aspect", triggers: ["aspect", "ratio", "crop", "resize", "vertical", "square", "widescreen"], targets: ["reframe", "app-expand-image"] },
  { id: "slides", triggers: ["slides", "pdf", "presentation", "explain", "tutorial"], targets: ["explainer"] },
  { id: "collage", triggers: ["collage", "paper", "paint", "scrapbook", "magazine"], targets: ["mixed-media", "effect-magazine"] },
  { id: "scene", triggers: ["sky", "backdrop", "scenery", "sunset", "weather", "location", "setting"], targets: ["app-change-background", "edit", "inpaint", "live-edit"] },
  {
    id: "cartoon",
    triggers: ["anime", "cartoon", "cartoonify", "toon", "comic", "manga", "pixar", "ghibli", "illustration", "illustrated", "drawing", "stylize", "stylise"],
    targets: ["app-style-transfer", "app-comic-book", "effect-comic", "app-3d-figure", "mixed-media"],
  },
  {
    id: "restore",
    triggers: ["restore", "restoration", "old photo", "old picture", "damaged", "scratched", "faded", "colorize", "colourise", "colorise", "colourize", "black and white"],
    targets: ["app-restore-photo", "app-colorize", "video-tools-restore", "upscale", "video-tools"],
  },
  { id: "logo", triggers: ["logo", "wordmark", "lettering", "typography", "font", "signage"], targets: ["image", "app-text-edit", "ads"] },
  {
    id: "property",
    triggers: ["real estate", "property", "interior", "apartment", "listing", "realtor", "house tour", "home tour", "walkthrough"],
    targets: ["motions", "edit", "upscale", "video"],
  },
  { id: "hook", triggers: ["hook", "thumbnail", "first seconds", "retention", "engagement"], targets: ["virality", "app-hook-frame"] },
];

/**
 * A word's plain form, for matching only: plurals ("ads" → "ad", "perfumes" → "perfume", "dresses" → "dress") and
 * -ing ("talking" → "talk", "dubbing" → "dub"). Short words and words that only look plural ("dress", "canvas")
 * stay as they are.
 */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) {
    let s = word.slice(0, -3);
    // A doubled last letter ("dubb", "runn"), but not ss / ll ("dressing", "selling").
    if (s.length > 3 && s.at(-1) === s.at(-2) && !/[sl]$/.test(s)) s = s.slice(0, -1);
    return s.length >= 3 ? s : word;
  }
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length >= 3 && word.endsWith("s") && !/(ss|us|is|as)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The words that matter in a query: normalized, filler words out (unless that leaves none). */
export function queryWords(query: string): string[] {
  const all = normalize(query).split(" ").filter(Boolean);
  const kept = all.filter((w) => !STOPWORDS.has(w));
  return kept.length ? kept : all;
}

// ---------------------------------------------------------------------------
// Scoring

interface Prepared {
  label: string;
  keywords: string;
  hint: string;
  what: string;
}

const prepared = new WeakMap<SearchEntry, Prepared>();
function prep(e: SearchEntry): Prepared {
  let p = prepared.get(e);
  if (!p) {
    p = { label: normalize(e.label), keywords: normalize(e.keywords ?? ""), hint: normalize(e.hint ?? ""), what: normalize(e.what ?? "") };
    prepared.set(e, p);
  }
  return p;
}

/** wordScore without its letters-in-order guess: for the hint and the line, where a guess is only noise. */
function plainScore(word: string, text: string): number {
  if (!text) return 0;
  if (text === word) return 100;
  if (text.startsWith(word)) return 80;
  if (text.includes(` ${word}`)) return 60;
  // Inside a word only from three letters ("ad" is not in "grade").
  return word.length > 2 && text.includes(word) ? 40 : 0;
}

/** Words this short are never a letters-in-order guess ("logo" is not "Log in", nor "longer"). */
const GUESS_FROM = 5;

/**
 * wordScore for a name: a short word only as written (no guess), and the start of a longer word ("photo" in
 * "Photodump") worth less than a whole word ("photo" in "Restore Photo"), so a name that only shares letters with
 * the query doesn't beat one that has its word.
 */
function nameScore(w: string, text: string): number {
  const s = w.length < GUESS_FROM ? plainScore(w, text) : wordScore(w, text);
  if (s === 80 && text.length > w.length && text[w.length] !== " ") return 62;
  return s;
}

/** One query word against one entry: its name counts in full, its search words half, its hint and its line less. */
function wordBest(w: string, p: Prepared): number {
  return Math.max(nameScore(w, p.label), nameScore(w, p.keywords) / 2, p.hint ? plainScore(w, p.hint) * 0.4 - 1 : 0, plainScore(w, p.what) / 2.5);
}

/** A word or its plain form, whichever matches better. */
function wordMatch(w: string, s: string, p: Prepared): number {
  return s === w ? wordBest(w, p) : Math.max(wordBest(w, p), wordBest(s, p));
}

/**
 * How well the words match an entry: every word matching (strict), else at least half of them, worth less (loose: a
 * query with a filler word the table doesn't know still finds its studio).
 */
function textScore(words: string[], stems: string[], p: Prepared): number {
  let total = 0;
  let matched = 0;
  for (let i = 0; i < words.length; i++) {
    const s = wordMatch(words[i], stems[i], p);
    if (s > 0) matched++;
    total += s;
  }
  if (!matched) return 0;
  if (matched === words.length) {
    // The whole query reading as the label's start beats the same words matched one by one; every word of a longer
    // query matching is worth something over an intent that names the entry for one of them ("upscale video": the
    // Upscale studio's Video tool before the studio).
    const bonus = words.length > 1 ? (p.label.startsWith(words.join(" ")) ? 20 : 16) : 0;
    return (total + bonus) / words.length;
  }
  return matched * 2 >= words.length ? (total / words.length) * 0.8 : 0;
}

/** Where people mostly go wins close calls: a studio over a preset of the same name. */
function kindBonus(e: SearchEntry): number {
  switch (e.navKind) {
    case "studio":
      return 10;
    case "tool":
      return 6;
    case "settings":
      return 4;
    case "create":
    case "presets":
    case "home":
    case "library":
    case "action":
      return 8;
    case "area":
      // An overview loses close calls to the page it lists ("studios" finds a studio first, the overview next).
      return 5;
  }
  return e.kind === "page" ? 8 : e.kind === "setting" ? 4 : 0;
}

/**
 * An intent's weight for its targets, by place: its first target beats a name that only has one of the query's words
 * ("film" finds Cinema Studio before the Film Colors effect), and loses to a name that is the query ("dance" → Dance).
 */
const intentWeight = (position: number) => 75 - 5 * position;
const INTENT_CAP = 95;

/** The intents a query means: a trigger is one of its words (or that word's plain form), or a phrase in it. */
function firedIntents(query: string, words: string[], stems: string[], intents: readonly Intent[]): Intent[] {
  const text = ` ${normalize(query)} `;
  const set = new Set([...words, ...stems]);
  // A query word or its plain form ("ads" fires "ad"); not the other way round, so "photo" doesn't fire "photos".
  return intents.filter((it) => it.triggers.some((t) => (t.includes(" ") ? text.includes(` ${t} `) : set.has(t))));
}

/** Weaker matches than this share of the best are noise next to it (as in rankPalette). */
const KEEP_FROM_BEST = 0.35;
const KEEP_FROM_REAL_MATCH = 0.6;
const REAL_MATCH = 39;
/** Below this, nothing is shown as the best match (a word shared with a name: "real" in "Sketch to Real"). */
const BEST_FROM = 30;

/** The id an intent target names: a nav entry's id, or a preset's ("app:app-dance" → "app-dance"). */
const idOf = (e: SearchEntry) => e.id ?? e.key.slice(e.key.indexOf(":") + 1);

/** Where a group of hits is listed, and how many it shows. */
function groupOf(kind: HitKind): { kind: string; label: string; limit: number } {
  if (kind === "studio" || kind === "tool" || kind === "page") return { kind: "studio", label: "Studios & tools", limit: GROUP_LIMIT.page };
  return { kind, label: KIND_LABELS[kind], limit: GROUP_LIMIT[kind] };
}
const GROUP_ORDER = ["studio", "app", "motion", "effect", "model", "skill", "setting", "recent"];

const toHit = (e: SearchEntry, score: number): NavHit => ({
  key: e.key,
  kind: e.kind,
  label: e.label,
  href: e.href,
  score,
  ...(e.what !== undefined && { what: e.what }),
  ...(e.cover && { cover: e.cover }),
  ...(e.hint && { hint: e.hint }),
  ...(e.icon && { icon: e.icon }),
  ...(e.navKind && { navKind: e.navKind }),
  ...(e.id && { id: e.id }),
});

/**
 * The matches for a query: the best three, two presets to also try, and the rest by kind. An empty query matches
 * nothing (the palette shows its own start: recent work and every studio).
 */
export function searchNav(query: string, entries: SearchEntry[], opts: { intents?: readonly Intent[] } = {}): SearchResult {
  const empty: SearchResult = { best: [], also: [], groups: [] };
  const words = queryWords(query);
  if (!words.length) return empty;
  const stems = words.map(stem);
  const fired = firedIntents(query, words, stems, opts.intents ?? INTENTS);
  // An intent that explains only part of the query counts for less ("upscale video": Upscale's Video tool, which has
  // both words, before the studio the intent names for "upscale").
  const triggerWords = new Set(fired.flatMap((it) => it.triggers.flatMap((t) => t.split(" "))));
  const explained = words.filter((w, i) => triggerWords.has(w) || triggerWords.has(stems[i])).length;
  const share = 0.5 + (0.5 * explained) / words.length;
  const boosts = new Map<string, number>();
  for (const it of fired) {
    it.targets.forEach((t, i) => boosts.set(t, Math.min(INTENT_CAP, (boosts.get(t) ?? 0) + intentWeight(i) * share)));
  }

  const scored: { e: SearchEntry; text: number; boost: number; bonus: number }[] = [];
  let top = 0;
  for (const e of entries) {
    const text = textScore(words, stems, prep(e));
    const boost = boosts.size ? (boosts.get(idOf(e)) ?? 0) : 0;
    if (!text && !boost) continue;
    const bonus = kindBonus(e) + (e.popular ? 2 : 0) - e.label.length / 100;
    if (text) top = Math.max(top, text + bonus);
    scored.push({ e, text, boost, bonus });
  }
  // Letters-in-order guesses next to a real match are noise; what an intent names always stays.
  // With an intent to go by, the faintest guesses go too ("real estate" is not "Sign up free").
  const floor = Math.max(top * (top >= REAL_MATCH ? KEEP_FROM_REAL_MATCH : KEEP_FROM_BEST), fired.length ? 20 : 0);
  const hrefs = new Set<string>();
  const hits = scored
    .filter((x) => x.boost > 0 || x.text + x.bonus >= floor)
    .map((x) => toHit(x.e, Math.max(x.text, x.boost) + 0.1 * Math.min(x.text, x.boost) + x.bonus))
    .sort((a, b) => b.score - a.score)
    // One hit per address: a page listed twice (Any Angle, a tool of Create and an app) shows once, as its best match.
    .filter((h) => {
      if (hrefs.has(h.href)) return false;
      hrefs.add(h.href);
      return true;
    });

  // Only real matches are "best" (and so what Enter opens): a word that merely appears in a name is listed by kind.
  // A single long word that matches nothing as written is a typo ("cinma"), and its guess is the match.
  const strong = fired.length > 0 || top >= BEST_FROM || (words.length === 1 && words[0].length >= GUESS_FROM);
  const best = strong ? hits.slice(0, 3) : [];
  const also = (strong ? hits.slice(3) : [])
    .filter((h) => (h.kind === "app" || h.kind === "motion" || h.kind === "effect") && h.score >= REAL_MATCH)
    .slice(0, 2)
    .map((h) => ({ ...h, from: KIND_LABELS[h.kind as PaletteKind] }));
  const shown = new Set([...best, ...also].map((h) => h.key));
  const inside = insideOf(best[0], entries, shown);
  for (const h of inside?.hits ?? []) shown.add(h.key);
  const byGroup = new Map<string, { kind: string; label: string; limit: number; hits: NavHit[] }>();
  for (const h of hits) {
    if (shown.has(h.key)) continue;
    const g = groupOf(h.kind);
    const list = byGroup.get(g.kind) ?? { ...g, hits: [] };
    if (list.hits.length < g.limit) list.hits.push(h);
    byGroup.set(g.kind, list);
  }
  const groups = [...byGroup.values()]
    .sort((a, b) => b.hits[0].score - a.hits[0].score || GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind))
    .map(({ kind, label, hits }) => ({ kind, label, hits }));
  return { best, also, groups: inside ? [inside, ...groups] : groups };
}

/** How many of a studio's tools its "In <studio>" group lists. */
export const INSIDE_LIMIT = 8;

/** Each studio's tools in a set of entries (STUDIO_SUBS order first), worked out once per set: the palette keeps its set. */
const toolsCache = new WeakMap<SearchEntry[], Map<string, SearchEntry[]>>();
function studioTools(entries: SearchEntry[]): Map<string, SearchEntry[]> {
  const cached = toolsCache.get(entries);
  if (cached) return cached;
  const byId = new Map<string, SearchEntry>();
  const byParent = new Map<string, SearchEntry[]>();
  for (const e of entries) {
    if (!e.key.startsWith("nav:")) continue;
    if (e.id && !byId.has(e.id)) byId.set(e.id, e);
    if (e.parent) byParent.set(e.parent, [...(byParent.get(e.parent) ?? []), e]);
  }
  const out = new Map<string, SearchEntry[]>();
  for (const parent of new Set([...Object.keys(STUDIO_SUBS), ...byParent.keys()])) {
    const listed = (STUDIO_SUBS[parent]?.ids ?? []).map((id) => byId.get(id)).filter((e): e is SearchEntry => !!e);
    const keys = new Set(listed.map((e) => e.key));
    out.set(parent, [...listed, ...(byParent.get(parent) ?? []).filter((e) => !keys.has(e.key))]);
  }
  toolsCache.set(entries, out);
  return out;
}

/**
 * A studio found as the best match: what it holds inside (its tabs and modes, STUDIO_SUBS order, then its other tools),
 * as a group right after it ("genjutsu" lists Motion transfer, Character swap…). Not the ones already shown, nor a tab
 * that is the studio's own page. Undefined for anything else, or a studio with nothing inside.
 */
function insideOf(lead: NavHit | undefined, entries: SearchEntry[], shown: ReadonlySet<string>): SearchResult["groups"][number] | undefined {
  if (lead?.kind !== "studio" || !lead.id) return undefined;
  const hits = (studioTools(entries).get(lead.id) ?? [])
    .filter((e) => !shown.has(e.key) && e.href !== lead.href)
    .slice(0, INSIDE_LIMIT)
    .map((e) => toHit(e, 0));
  return hits.length ? { kind: `in-${lead.id}`, label: `In ${lead.label}`, hits } : undefined;
}

// ---------------------------------------------------------------------------
// Entries

const HIT_KIND: Record<NavKind, HitKind> = {
  home: "page",
  action: "page",
  create: "page",
  presets: "page",
  library: "page",
  area: "page",
  studio: "studio",
  tool: "tool",
  settings: "setting",
};

/** A nav entry as the palette searches it: a tool under its studio ("Audio › Clean up voice"), with its studio's cover. */
export function navSearchEntry(e: NavEntry): SearchEntry {
  const parent = e.parent ? navEntry(e.parent) : undefined;
  return {
    key: `nav:${e.id}`,
    kind: HIT_KIND[e.kind],
    id: e.id,
    label: e.label,
    href: e.href,
    hint: parent?.label ?? (e.kind === "settings" ? "Settings" : undefined),
    // A tool is found by its studio's name too ("upscale video", "audio music").
    keywords: parent ? `${e.keywords} ${parent.label} ${parent.keywords}` : e.keywords,
    what: e.what,
    navKind: e.kind,
    icon: e.icon,
    ...((e.cover ?? parent?.cover) && { cover: e.cover ?? parent?.cover }),
    ...(e.popular && { popular: true }),
    ...(e.parent && { parent: e.parent }),
  };
}

/** The palette's entries for a set of nav entries (entriesFor(kind): nothing a viewer can't see is ever searched). */
export function navSearchEntries(entries: readonly NavEntry[]): SearchEntry[] {
  return entries.map(navSearchEntry);
}

/** Whether a hit is a page on this site (else an action: the theme, or a link to open in a new tab). */
export const isThemeAction = (href: string) => href === THEME_ACTION;
export const isExternal = (href: string) => /^https?:/.test(href);
