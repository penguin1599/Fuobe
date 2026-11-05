/**
 * The AI Influencer builder (Higgsfield's game-style character builder, docs/research/higgsfield-delta-4.md
 * §4.5): which options each tier shows, the pick rules and the two conflict messages, Shuffle with the
 * researched weights, and the prompt compiler (every option → a short English phrase, the tier → a
 * style clause) plus the plan per engine. Pure: shared by the page and the server.
 *
 * The option lists themselves are generated from the research JSON (scripts/gen-influencer-options.py).
 */
import {
  CONFLICT_MESSAGES,
  CREATURE_CATEGORIES,
  CREATURE_TYPES,
  DISPLAY_ORDER_FIRST,
  INFLUENCER_CATEGORIES,
  RETIRED_OPTIONS,
  SHUFFLE_RESEARCH,
  type CreatureType,
  type HumanTier,
  type InfluencerCategory,
  type InfluencerOption,
  type InfluencerTier,
} from "@/lib/catalog/influencer-options.generated";
import type { PlanCaps } from "@/lib/catalog/packs";
import { CAST_LOOK } from "@/lib/catalog/soul-cards";
import type { ChainSlot, Engine, GenerationRequest } from "@/lib/catalog/types";

export { CONFLICT_MESSAGES, CREATURE_TYPES, INFLUENCER_CATEGORIES, RETIRED_OPTIONS };
export type { CreatureType, HumanTier, InfluencerCategory, InfluencerOption, InfluencerTier };

export const HUMAN_TIERS: { id: HumanTier; label: string; hint: string }[] = [
  { id: "normal", label: "Average", hint: "Realistic" },
  { id: "freak", label: "Bold", hint: "Bold caricature" },
  { id: "total", label: "Extreme", hint: "Extreme caricature" },
];

/** Higgsfield's limits: "You can add up to three clothing references"; Direction up to 4,000 characters. */
export const MAX_CLOTHING = 3;
export const MAX_DIRECTION = 4000;

export interface InfluencerState {
  tier: InfluencerTier;
  /** Picks per category id, in the order they were made. */
  picks: Record<string, string[]>;
  /** Creature types: the pinned species (none = any of the type). */
  species?: string;
  /** Creature types: body colour as #rrggbb (none = natural). */
  bodyColor?: string;
  /** Categories Shuffle leaves as they are. */
  locked: string[];
}

export const INFLUENCER_START: InfluencerState = { tier: "normal", picks: {}, locked: [] };

export const isCreature = (tier: InfluencerTier): tier is CreatureType => CREATURE_TYPES.some((c) => c.id === tier);
export const isTier = (v: unknown): v is InfluencerTier => typeof v === "string" && (HUMAN_TIERS.some((t) => t.id === v) || CREATURE_TYPES.some((c) => c.id === v));
export const creatureOf = (tier: InfluencerTier) => CREATURE_TYPES.find((c) => c.id === tier);

const CATEGORY = new Map(INFLUENCER_CATEGORIES.map((c) => [c.id, c]));
export const getCategory = (id: string) => CATEGORY.get(id);
export const getOption = (category: string, id: string) => CATEGORY.get(category)?.options.find((o) => o.id === id);

/** The rail's order: Character type, then gender, build, hairstyle, hair colour and style, then the rest. */
export const RAIL_ORDER: string[] = ["tier", ...DISPLAY_ORDER_FIRST, ...INFLUENCER_CATEGORIES.map((c) => c.id).filter((id) => id !== "tier" && !DISPLAY_ORDER_FIRST.includes(id))];

/** Whether a tier shows an option: human tiers read its visibleIn; creature types get every option of their categories but Centaur. */
export function optionVisible(option: InfluencerOption, tier: InfluencerTier, category: string): boolean {
  if (isCreature(tier)) return CREATURE_CATEGORIES.includes(category) && option.id !== "pr_centaur";
  return !option.visibleIn || option.visibleIn.includes(tier);
}

/** The categories a tier shows (in rail order, without Character type), each with only its visible options. */
export function categoriesFor(tier: InfluencerTier): InfluencerCategory[] {
  return RAIL_ORDER.flatMap((id) => {
    const c = CATEGORY.get(id);
    if (!c || id === "tier" || (isCreature(tier) && !CREATURE_CATEGORIES.includes(id))) return [];
    const options = c.options.filter((o) => optionVisible(o, tier, id));
    return options.length ? [{ ...c, options }] : [];
  });
}

// ---------------------------------------------------------------------------
// Pick rules and conflicts

const TALL = ["h_tall", "h_very_tall"];
const BIG_BUILDS = ["body_heavy", "body_muscular", "body_ultra"];
const LEG_PROPORTIONS = ["pr_shortlegs", "pr_longlimbs"];
const has = (picks: Record<string, string[]>, category: string, ids: string[]) => (picks[category] ?? []).some((x) => ids.includes(x));

/** The conflict in a set of picks, in Higgsfield's words (null when they go together). */
export function conflictIn(tier: InfluencerTier, picks: Record<string, string[]>): string | null {
  if (has(picks, "body_type", ["body_heavy"]) && has(picks, "height", TALL)) return CONFLICT_MESSAGES.heavyTall;
  // "in this mode": Bold, Extreme and the creature types; Average allows it.
  if (tier !== "normal" && has(picks, "body_type", BIG_BUILDS) && has(picks, "proportions", LEG_PROPORTIONS)) return CONFLICT_MESSAGES.buildLegs;
  return null;
}

/** A category's picks after choosing `id`, before conflicts: max 1 replaces, None clears the others, Features keep one per slot. */
function picked(category: InfluencerCategory, current: string[], id: string): { next: string[]; replaced?: string } {
  if (current.includes(id)) return { next: current.filter((x) => x !== id) };
  if (category.max === 1) return { next: [id] };
  if (id === "acc_none") return { next: [id] };
  let next = current.filter((x) => x !== "acc_none");
  const slot = category.options.find((o) => o.id === id)?.slot;
  if (slot) next = next.filter((x) => category.options.find((o) => o.id === x)?.slot !== slot);
  next = [...next, id];
  // Over the limit: the oldest pick makes room.
  return next.length > category.max ? { next: next.slice(1), replaced: next[0] } : { next };
}

/** Why `id` can't be picked right now (a conflict message), or null. Unpicking never conflicts. */
export function conflictFor(state: InfluencerState, category: string, id: string): string | null {
  const c = CATEGORY.get(category);
  if (!c || (state.picks[category] ?? []).includes(id)) return null;
  return conflictIn(state.tier, { ...state.picks, [category]: picked(c, state.picks[category] ?? [], id).next });
}

export interface PickResult {
  state: InfluencerState;
  /** The pick was refused: Higgsfield's conflict message. */
  conflict?: string;
  /** Said when an older pick made room ("Up to 2 — Long limbs was replaced"). */
  note?: string;
}

/** Pick or unpick an option, following Higgsfield's rules. */
export function togglePick(state: InfluencerState, category: string, id: string): PickResult {
  const c = CATEGORY.get(category);
  const option = c?.options.find((o) => o.id === id);
  if (!c || !option || !optionVisible(option, state.tier, category)) return { state };
  const conflict = conflictFor(state, category, id);
  if (conflict) return { state, conflict };
  const { next, replaced } = picked(c, state.picks[category] ?? [], id);
  const picks = { ...state.picks };
  if (next.length) picks[category] = next;
  else delete picks[category];
  const was = replaced ? c.options.find((o) => o.id === replaced)?.label : undefined;
  return { state: { ...state, picks }, ...(was && { note: `${c.label}: up to ${c.max} — ${was} was replaced` }) };
}

/**
 * Switch the character type: picks the new tier doesn't show are dropped, and so are new conflicts.
 * `dropped` names them: the option, or the category when the new type doesn't show it at all.
 */
export function setTier(state: InfluencerState, tier: InfluencerTier): { state: InfluencerState; dropped: string[] } {
  if (tier === state.tier) return { state, dropped: [] };
  const dropped: string[] = [];
  const picks: Record<string, string[]> = {};
  const shown = new Set(categoriesFor(tier).map((c) => c.id));
  for (const [cat, ids] of Object.entries(state.picks)) {
    const c = CATEGORY.get(cat);
    if (!c) continue;
    const keep = ids.filter((id) => {
      const o = c.options.find((x) => x.id === id);
      const ok = !!o && optionVisible(o, tier, cat);
      // A whole category the new type doesn't have is named once ("Skin color"), else the option ("Hair horns").
      if (!ok && o) dropped.push(shown.has(cat) ? o.label : c.label);
      return ok;
    });
    if (keep.length) picks[cat] = keep;
  }
  // Average allowed a big build with Short legs; Bold doesn't: the leg proportions give way. Only the
  // picks the conflict is about go (Heavy with a tall height is refused everywhere, so it can only come in from outside).
  for (let conflict = conflictIn(tier, picks); conflict; conflict = conflictIn(tier, picks)) {
    const [cat, ids] = conflict === CONFLICT_MESSAGES.heavyTall ? (["height", TALL] as const) : (["proportions", LEG_PROPORTIONS] as const);
    const gone = (picks[cat] ?? []).filter((x) => ids.includes(x));
    if (!gone.length) break;
    dropped.push(...gone.map((x) => getOption(cat, x)?.label ?? x));
    picks[cat] = (picks[cat] ?? []).filter((x) => !ids.includes(x));
    if (!picks[cat].length) delete picks[cat];
  }
  // A species belongs to its type; a body colour carries over to another creature.
  return {
    state: { tier, picks, locked: state.locked, ...(isCreature(tier) && state.bodyColor && { bodyColor: state.bodyColor }) },
    dropped: [...new Set(dropped)],
  };
}

/** Reset all: no picks and nothing locked; the character type stays. */
export const resetPicks = (state: InfluencerState): InfluencerState => ({ tier: state.tier, picks: {}, locked: [] });

export function toggleLock(state: InfluencerState, category: string): InfluencerState {
  return { ...state, locked: state.locked.includes(category) ? state.locked.filter((x) => x !== category) : [...state.locked, category] };
}

// ---------------------------------------------------------------------------
// Shuffle

/** A small seeded generator (mulberry32): the same seed shuffles the same character. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uniform = <T>(xs: T[], rand: () => number): T | undefined => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))] : undefined);

/** A weighted pick: the listed ids get their weight, every other option shares what is left equally. */
function weighted(options: string[], weights: Record<string, number>, rand: () => number): string | undefined {
  const listed = options.filter((o) => o in weights);
  const rest = options.filter((o) => !(o in weights));
  const listedTotal = listed.reduce((n, o) => n + weights[o], 0);
  const restWeight = rest.length ? Math.max(0, 1 - listedTotal) / rest.length : 0;
  const total = listedTotal + restWeight * rest.length;
  if (!total) return uniform(options, rand);
  let r = rand() * total;
  for (const o of options) {
    r -= o in weights ? weights[o] : restWeight;
    if (r < 0) return o;
  }
  return options[options.length - 1];
}

/** Several picks from different Features slots (or just different options), without repeats; `ok` vets each one with those before it. */
function several(c: InfluencerCategory, count: number, rand: () => number, ok: (ids: string[]) => boolean = () => true): string[] {
  const out: string[] = [];
  let pool = c.options.filter((o) => ok([o.id]));
  while (out.length < count && pool.length) {
    const o = uniform(pool, rand)!;
    out.push(o.id);
    pool = pool.filter((x) => x.id !== o.id && (!o.slot || x.slot !== o.slot) && ok([...out, x.id]));
  }
  return out;
}

/**
 * What Shuffle never puts together: the two conflicts, and the research's build exclusions that pair a
 * build with another pick (Heavy with a tall height or a Tiny waist, Centaur with an Egg body, Ultra
 * Muscular with a Long neck). Each rule by name, so a pick can be vetted against the ones already made.
 */
const SHUFFLE_RULES: [string, (tier: InfluencerTier, p: Record<string, string[]>) => boolean][] = [
  ["heavyTall", (_, p) => has(p, "body_type", ["body_heavy"]) && has(p, "height", TALL)],
  ["buildLegs", (tier, p) => tier !== "normal" && has(p, "body_type", BIG_BUILDS) && has(p, "proportions", LEG_PROPORTIONS)],
  ["heavyWaist", (_, p) => has(p, "body_type", ["body_heavy"]) && has(p, "proportions", ["pr_waist"])],
  ["centaurEgg", (_, p) => has(p, "body_type", ["pr_centaur"]) && has(p, "proportions", ["pr_egg"])],
  ["ultraLongNeck", (_, p) => has(p, "body_type", ["body_ultra"]) && has(p, "freak_neck", ["neck_long"])],
];
const clashes = (tier: InfluencerTier, picks: Record<string, string[]>) => SHUFFLE_RULES.filter(([, broken]) => broken(tier, picks)).map(([name]) => name);

/**
 * Whether Shuffle may give `category` these picks next to the ones it has (kept ones included): no rule
 * breaks that wasn't already broken. Kept picks are the user's (a locked Heavy with a Tiny waist stays),
 * but nothing shuffled is added to them that clashes, whichever side was kept.
 */
function fits(tier: InfluencerTier, picks: Record<string, string[]>, category: string, ids: string[]): boolean {
  const before = clashes(tier, picks);
  return clashes(tier, { ...picks, [category]: ids }).every((name) => before.includes(name));
}

/** Categories Shuffle fills before others: build reads height, proportions and neck; facial hair reads gender. */
const SHUFFLE_ORDER = ["gender", "height", "proportions", "freak_neck"];
const LATE = ["body_type", "facial_hair"];

export interface ShuffleOptions {
  /** A reference or face photo is in: it keeps gender, ethnicity and age (and skin and eye colour in Average). */
  reference?: boolean;
}

const one = (id: string | undefined): string[] => (id ? [id] : []);

/**
 * Higgsfield's Shuffle: keeps locked picks (and, with a photo, what the photo decides); gender is male 67%,
 * female 33%; style Suits 40%, Retro 20%, else any other; hairstyle Bob 20% where Bob shows; build is never
 * Curvy, never Ultra Muscular in Average, never Heavy with Tall heights or a Tiny waist, never Centaur with
 * an Egg body or Ultra Muscular with a Long neck (nor any pick that would conflict). Those pairs hold whichever
 * side is kept: with a locked Heavy, Shuffle picks no tall height and no Tiny waist. Facial hair is Clean
 * unless the gender is male. How many multi-pick options it adds is Fuobe's choice (up to 1
 * proportion, 1–2 features, up to 1 distinctive feature, 1 accessory).
 */
export function shuffleInfluencer(state: InfluencerState, rand: () => number, opts: ShuffleOptions = {}): InfluencerState {
  const keep = new Set(state.locked);
  if (opts.reference) for (const k of SHUFFLE_RESEARCH.keepsWithReference[state.tier === "normal" ? "normal" : "other"]) keep.add(k);
  const picks: Record<string, string[]> = {};
  for (const k of keep) if (state.picks[k]?.length) picks[k] = state.picks[k];
  const cats = categoriesFor(state.tier);
  const rank = (id: string) => (SHUFFLE_ORDER.includes(id) ? SHUFFLE_ORDER.indexOf(id) - 10 : LATE.includes(id) ? 10 + LATE.indexOf(id) : 0);
  const ordered = [...cats].sort((a, b) => rank(a.id) - rank(b.id));
  const W = SHUFFLE_RESEARCH.weights;
  for (const c of ordered) {
    if (keep.has(c.id)) continue;
    const ok = (ids: string[]) => fits(state.tier, picks, c.id, ids);
    const ids = c.options.map((o) => o.id).filter((id) => ok([id]));
    let pick: string[] = [];
    switch (c.id) {
      case "gender":
        pick = one(weighted(ids.filter((id) => id in W.gender), W.gender, rand) ?? uniform(ids, rand));
        break;
      case "aesthetic":
        pick = one(weighted(ids, W.aesthetic, rand));
        break;
      case "hair":
        pick = one(weighted(ids, W.hair, rand));
        break;
      case "body_type":
        pick = one(uniform(ids.filter((id) => id !== "body_curvy" && !(id === "body_ultra" && state.tier === "normal")), rand));
        break;
      case "facial_hair": {
        const g = picks.gender?.[0];
        pick = g === "male" ? one(uniform(ids, rand)) : ids.includes("fh_none") ? ["fh_none"] : [];
        break;
      }
      case "proportions":
        pick = rand() < 0.5 ? several(c, 1, rand, ok) : [];
        break;
      case "freak_face":
        pick = several(c, 1 + Math.floor(rand() * 2), rand, ok);
        break;
      case "distinctive":
        pick = rand() < 0.4 ? several(c, 1, rand, ok) : [];
        break;
      default:
        pick = one(uniform(ids, rand));
    }
    if (pick.length) picks[c.id] = pick;
  }
  return { ...state, picks };
}

// ---------------------------------------------------------------------------
// The prompt compiler

/**
 * Every option as a short English phrase. Hairstyles take the hair colour where "{color}" is
 * (an empty string when none is picked); eye shapes and hair colours are adjectives.
 */
export const PHRASES: Record<string, string> = {
  // gender (people; creatures read CREATURE_GENDER)
  female: "woman",
  male: "man",
  other: "androgynous person",
  // ethnicity
  african: "African",
  east_asian: "East Asian",
  european: "European",
  indian: "Indian",
  middle_eastern: "Middle Eastern",
  latin_american: "mixed-heritage Latin American",
  // age
  adult: "young adult",
  mature: "middle-aged",
  senior: "elderly",
  // skin
  st_porcelain: "porcelain skin",
  st_fair: "fair skin",
  st_light: "light skin",
  st_olive: "olive skin",
  st_tan: "tan skin",
  st_brown: "brown skin",
  st_deep: "deep brown skin",
  st_ebony: "very dark ebony skin",
  // height
  h_short: "short and small",
  h_average: "average height",
  h_tall: "tall",
  h_very_tall: "very tall",
  // build
  body_slim: "a slim build",
  body_athletic: "an athletic build",
  body_muscular: "a muscular build",
  body_curvy: "a curvy figure",
  body_heavy: "a heavy, large build",
  body_ultra: "an ultra-muscular bodybuilder physique",
  pr_centaur: "a centaur body: a human torso on a horse's body",
  // proportions
  pr_longlimbs: "long limbs",
  pr_shortlegs: "short legs",
  pr_shoulders: "broad shoulders",
  pr_waist: "a tiny waist",
  pr_egg: "an egg-shaped body",
  // head
  head_oval: "an oval head",
  head_long: "a long head",
  head_tiny: "a tiny head",
  head_forehead: "a high forehead",
  head_ancient: "a caveman-like heavy brow and skull",
  head_herojaw: "a chiseled gigachad jaw",
  head_megachin: "a giant mega jaw",
  head_round: "a round face",
  head_square: "a square face",
  head_heart: "a heart-shaped face",
  // neck
  neck_normal: "a normal neck",
  neck_column: "a thick column neck",
  neck_long: "a long neck",
  neck_short: "a short neck",
  // eye shape (adjectives)
  es_almond: "almond-shaped",
  es_round: "round",
  es_monolid: "monolid",
  es_close: "close-set",
  es_wide: "wide-set",
  es_uneven: "slightly uneven",
  es_large: "large",
  es_huge: "huge cartoonish",
  es_hooded: "hooded",
  es_upturned: "upturned",
  es_downturned: "downturned",
  // eye colour (adjectives)
  eye_black: "black",
  eye_brown: "brown",
  eye_hazel: "hazel",
  eye_green: "green",
  eye_blue: "blue",
  eye_ice_blue: "ice-blue",
  eye_amber: "amber",
  eye_grey: "grey",
  // features
  fn_freckles: "freckles",
  fn_dimples: "dimples",
  fn_eyebags: "heavy eye bags",
  ff_marks_12: "rosy blushing cheeks",
  fn_cheekbones: "high cheekbones",
  fn_fulllips: "full lips",
  fn_thickbrows: "thick brows",
  fn_mole: "a beauty mark",
  ff_nose_0: "a big potato nose",
  ff_nose_1: "a button nose",
  ff_nose_2: "a pointy nose",
  fn_tinynose: "a tiny nose",
  ff_lips_3: "pouty lips",
  ff_lips_4: "a tiny pursed mouth",
  fn_widemouth: "a wide mouth",
  ff_brows_5: "a unibrow",
  ff_brows_6: "thin, high-arched brows",
  ff_brows_7: "bushy brush brows",
  ff_ears_8: "jug ears",
  ff_ears_9: "uneven ears",
  ff_teeth_10: "a gap between the front teeth",
  ff_teeth_11: "buck teeth",
  fn_pointychin: "a pointy chin",
  ff_chin_13: "a weak, receding chin",
  ff_forehead_14: "a big forehead",
  // facial hair
  fh_none: "clean-shaven",
  fh_stubble: "stubble",
  fh_beard: "a full beard",
  fh_goatee: "a goatee",
  fh_moustache: "a moustache",
  fh_pencil: "a pencil moustache",
  fh_pushbroom: "a push-broom moustache",
  fh_braid: "a braided beard",
  // hairstyles ({color} = the hair colour and a space, or nothing)
  hs_lampshade: "a {color}lampshade bob",
  hair_bald: "a bald head",
  hair_buzz: "a {color}buzz cut",
  hair_bowl: "a {color}bowl cut",
  hair_mullet: "a {color}mullet",
  hair_braids: "{color}braids",
  hair_pigtails: "{color}pigtails",
  hair_afro: "a {color}afro",
  hair_punk: "a {color}mohawk",
  hs_pompadour: "big, voluminous {color}waves",
  hs_beehive: "a tall {color}beehive updo",
  hs_dome: "a {color}dome-shaped perm",
  hair_long: "long {color}hair",
  hair_short: "short {color}hair",
  hs_horns: "{color}hair shaped into two horns",
  hs_softserve: "{color}hair piled up in a soft-serve swirl",
  hs_sphere: "{color}curls in a perfect sphere",
  hs_mouse: "two round {color}mouse-ear hair puffs",
  hs_wings: "{color}hair swept out like wings",
  hs_hedgehog: "{color}hair in hedgehog spikes",
  hs_tufts: "{color}hair in side tufts",
  hs_stairs: "{color}hair cut in stair steps",
  hs_shelf: "a flat {color}shelf bob",
  hs_corkscrews: "{color}corkscrew curls",
  hs_sidecoil: "a single {color}side coil of hair",
  hs_mushroom: "a {color}mushroom haircut",
  // hair colour (adjectives)
  hc_black: "jet black",
  hc_darkbrown: "dark brown",
  hc_chestnut: "chestnut",
  hc_ginger: "ginger",
  hc_red: "red",
  hc_blonde: "blonde",
  hc_platinum: "platinum blonde",
  hc_grey: "grey",
  hc_white: "white",
  hc_pink: "pastel pink",
  hc_lilac: "lilac",
  hc_blue: "blue",
  hc_green: "green",
  // distinctive features
  df_hetero: "heterochromia (two different eye colours)",
  df_facetattoo: "a small face tattoo",
  df_septum: "a septum piercing",
  df_ears: "ear piercings",
  df_slits: "brow slits",
  df_bleached: "bleached eyebrows",
  df_nobrows: "no eyebrows",
  df_grill: "a gold grill on the teeth",
  df_braces: "braces on the teeth",
  df_scar: "a scar through one eyebrow",
  df_gems: "face gems",
  df_elf: "pointed elf ears",
  df_lashes: "big dramatic lashes",
  df_bandage: "a strip of tape across the nose",
  // style
  retro: "a retro vintage outfit",
  sporty: "a sporty athleisure outfit",
  y2k: "a Y2K outfit",
  theatrical: "a theatrical stage costume",
  goth: "an all-black goth outfit",
  suits: "a tailored suit",
  streetstyle: "a streetwear outfit",
  casual: "a casual everyday outfit",
  // accessories
  acc_none: "no accessories",
  acc_glasses: "glasses",
  acc_headphones: "headphones",
  acc_jewelry: "jewelry",
  acc_hat: "a hat",
  acc_bag: "a bag",
};

const CREATURE_GENDER: Record<string, string> = { female: "female", male: "male", other: "androgynous" };
const CREATURE_NOUN: Record<CreatureType, string> = { insects: "insect", frogs: "frog", cats: "cat", dogs: "dog", capybaras: "capybara", birds: "bird" };
const CREATURE_COAT: Record<CreatureType, string> = { insects: "body", frogs: "skin", cats: "fur", dogs: "fur", capybaras: "fur", birds: "feathers" };

/** Each species as the prompt names it (creature types' species ids, from the research). */
export const SPECIES_PHRASES: Record<string, string> = {
  // insects
  ant: "ant",
  mantis: "praying mantis",
  grasshopper: "grasshopper",
  honeybee: "honeybee",
  bumblebee: "bumblebee",
  butterfly: "butterfly",
  moth: "moth",
  dragonfly: "dragonfly",
  ladybird: "ladybird",
  fluffy_tarantula: "fluffy tarantula",
  // frogs
  tree_frog: "tree frog",
  bullfrog: "bullfrog",
  horned_frog: "horned frog",
  tomato_frog: "tomato frog",
  rain_frog: "rain frog",
  // cats
  sphynx: "Sphynx cat",
  maine_coon: "Maine Coon cat",
  british_shorthair: "British Shorthair cat",
  siamese: "Siamese cat",
  persian: "Persian cat",
  // dogs
  pug: "pug",
  borzoi: "borzoi",
  dachshund: "dachshund",
  poodle: "poodle",
  corgi: "corgi",
  // rodents (capybara body shapes)
  cylindrical: "cylindrical capybara",
  barrel: "barrel-shaped capybara",
  slender: "slender capybara",
  pear: "pear-shaped capybara",
  broad_shoulders: "broad-shouldered capybara",
  // birds
  goose: "goose",
  duck: "duck",
  platypus: "platypus",
  puffin: "puffin",
  pigeon: "pigeon",
};

/** "Maine Coon cat", "tree frog", "barrel-shaped capybara", or the type ("cat") when no species is pinned. */
export function speciesNoun(tier: CreatureType, species?: string): string {
  const ok = !!species && !!creatureOf(tier)?.species.some((s) => s.id === species);
  return (ok && SPECIES_PHRASES[species!]) || CREATURE_NOUN[tier];
}

/** The nearest everyday name for a body colour (#hex), for the prompt: "deep teal", "pale pink". */
export function colorName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || d < 0.06) return l < 0.15 ? "black" : l > 0.88 ? "white" : l < 0.4 ? "dark grey" : l > 0.7 ? "light grey" : "grey";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hue =
    h < 15 || h >= 345 ? "red" : h < 40 ? (l < 0.45 ? "brown" : "orange") : h < 65 ? (l < 0.4 ? "olive" : "yellow") : h < 160 ? "green" : h < 190 ? "teal" : h < 250 ? "blue" : h < 290 ? "purple" : "pink";
  const shade = l < 0.3 ? "deep " : l > 0.75 ? "pale " : "";
  return `${shade}${hue}`;
}

const pick1 = (state: InfluencerState, category: string) => state.picks[category]?.[0];
const phrases = (state: InfluencerState, category: string) => (state.picks[category] ?? []).map((id) => PHRASES[id]).filter(Boolean);
const an = (word: string) => (/^[aeiou]/i.test(word) && !/^(uni|eu|one)/i.test(word) ? "an" : "a");
/** "a afro" → "an afro" after a colour was (or wasn't) put in front. */
const articles = (s: string) => s.replace(/\b(a|an) (\w)/g, (_, _a: string, w: string) => `${an(w)} ${w}`);
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function hairPhrase(state: InfluencerState): string | undefined {
  const style = pick1(state, "hair");
  const color = pick1(state, "hair_colour");
  const c = color ? PHRASES[color] : "";
  if (!style) return c ? `${c} hair` : undefined;
  if (style === "hair_bald") return PHRASES[style];
  return articles(PHRASES[style].replace("{color}", c ? `${c} ` : ""));
}

function eyesPhrase(state: InfluencerState): string | undefined {
  const shape = pick1(state, "eye_shape");
  const color = pick1(state, "eye_color");
  if (!shape && !color) return undefined;
  return [shape && PHRASES[shape], color && PHRASES[color], "eyes"].filter(Boolean).join(" ");
}

/** Who it is: "a young adult East Asian woman", "a female anthropomorphic Maine Coon cat with pale pink fur". */
function subject(state: InfluencerState): string {
  if (isCreature(state.tier)) {
    const g = pick1(state, "gender");
    const noun = `${g ? `${CREATURE_GENDER[g]} ` : ""}anthropomorphic ${speciesNoun(state.tier, state.species)}`;
    const color = state.bodyColor ? colorName(state.bodyColor) : "";
    return `${an(noun)} ${noun}${color ? ` with ${color} ${CREATURE_COAT[state.tier]}` : ""}`;
  }
  const words = [pick1(state, "age"), pick1(state, "ethnicity_origin_base")].filter(Boolean).map((id) => PHRASES[id!]);
  const g = pick1(state, "gender");
  words.push(g ? PHRASES[g] : "person");
  const s = words.join(" ");
  return `${an(s)} ${s}`;
}

/**
 * The character in one sentence, from the picks (the live summary, and the description every
 * prompt starts from): "A young adult European man, tall, with an athletic build, …, wearing a tailored suit."
 */
export function describeInfluencer(state: InfluencerState): string {
  const body = [pick1(state, "height") && PHRASES[pick1(state, "height")!], ...phrases(state, "skin_tone")].filter(Boolean);
  const withs = [
    ...phrases(state, "body_type"),
    ...phrases(state, "proportions"),
    ...phrases(state, "freak_head"),
    ...phrases(state, "freak_neck"),
    eyesPhrase(state),
    ...phrases(state, "freak_face"),
    hairPhrase(state),
    ...(pick1(state, "facial_hair") && pick1(state, "facial_hair") !== "fh_none" ? phrases(state, "facial_hair") : []),
    ...phrases(state, "distinctive"),
  ].filter((x): x is string => !!x);
  const accessories = state.picks.accessory ?? [];
  const parts = [subject(state), ...body];
  // "Clean" is what Shuffle gives everyone but men: said only where it means something.
  const g = pick1(state, "gender");
  if (pick1(state, "facial_hair") === "fh_none" && (g === "male" || !g)) parts.push("clean-shaven");
  if (withs.length) parts.push(`with ${list(withs)}`);
  const outfit = phrases(state, "aesthetic")[0];
  if (outfit) parts.push(`wearing ${outfit}`);
  if (accessories.includes("acc_none")) parts.push("no accessories");
  else if (accessories.length) parts.push(`${outfit ? "with" : "wearing"} ${list(phrases(state, "accessory"))}`);
  const s = parts.join(", ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** The tier's style clause: realistic, bold caricature, extreme caricature, or anthropomorphic {species}. */
export function tierStyle(state: InfluencerState): string {
  if (isCreature(state.tier)) {
    const noun = speciesNoun(state.tier, state.species);
    return `Anthropomorphic ${noun}: an upright ${noun} character with a human-like body and posture, photographed for real, with true-to-life ${CREATURE_COAT[state.tier]} texture`;
  }
  if (state.tier === "freak") return "Bold caricature: photographic, but the chosen features are exaggerated for a memorable, slightly cartoonish look";
  if (state.tier === "total") return "Extreme caricature: wildly exaggerated proportions and features, like a sculpted caricature brought to life, still photographic";
  return "Realistic: a photorealistic person with natural proportions and real skin texture";
}

/** What the character's photos are: Add your face (their face goes on the character) or a reference (its look). */
export type InfluencerStart = "scratch" | "reference" | "face";

export interface CompileInput {
  state: InfluencerState;
  direction?: string;
  start?: InfluencerStart;
  /** How many clothing references go with the prompt (after the photo, if any). */
  clothing?: number;
}

const tidy = (s?: string) => s?.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");

/** "Add your face" in each prompt: the cloud sheet takes the face as image 1, the open edit as image 2 (after the sheet). */
const FACE_ON_SHEET = "The character has the face of the person in image 1: keep their identity and facial features exactly";
const FACE_ON_EDIT = "Give the character in every view the face of the person in image 2: the same identity, facial features and skin tone";
const imageList = (from: number, n: number) => (n === 1 ? `image ${from}` : `images ${list(Array.from({ length: n }, (_, i) => String(from + i)))}`);

/**
 * The whole prompt for an image model that draws the sheet itself (Nano Banana Pro, Seedream 5.0): a white
 * background portrait plus full-body views, the character, the tier's style, the photos' roles and the Direction.
 */
export function compileSheetPrompt({ state, direction, start = "scratch", clothing = 0 }: CompileInput): string {
  const photo = start !== "scratch";
  return [
    "Character sheet of an original AI influencer on a pure white background: a close-up portrait of the face, then full-body front, three-quarter, side profile and back views side by side",
    `The character: ${tidy(describeInfluencer(state))}`,
    tierStyle(state),
    start === "face" && FACE_ON_SHEET,
    start === "reference" && "Base the character on the one in image 1 (face and overall look), changed as described",
    clothing > 0 && `They wear the clothing shown in ${imageList(photo ? 2 : 1, clothing)}`,
    tidy(direction) && `Direction: ${tidy(direction)}`,
    "The same face, hair, body and outfit in every view; no text, no labels",
  ]
    .filter(Boolean)
    .join(". ")
    .concat(".");
}

/** The character for the open Soul Cast sheet workflow, whose graph adds the turnaround wording itself. */
export function compileCastPrompt({ state, direction }: CompileInput): string {
  return [tidy(describeInfluencer(state)), tierStyle(state), tidy(direction)].filter(Boolean).join(". ").concat(".");
}

/** Qwen-Image-Edit's instruction for the open engine's second step: the sheet is image 1, the photo and clothing follow. */
export function compileDressPrompt({ start = "scratch", clothing = 0 }: CompileInput): string {
  const photo = start !== "scratch";
  return [
    "Image 1 is a character turnaround sheet",
    start === "face" && FACE_ON_EDIT,
    start === "reference" && "Redraw the character in every view to look like the character in image 2: their face, hair and overall look",
    clothing > 0 && `Dress the character in every view in the clothing shown in ${imageList(photo ? 3 : 2, clothing)}`,
    "Keep the poses, the layout, the number of views and the white background of image 1 unchanged",
  ]
    .filter(Boolean)
    .join(". ")
    .concat(".");
}

/**
 * The face an "Add your face" sheet was made with, read back from its finished request (null for From
 * scratch and From a reference): Save as character keeps it as a reference, whatever the page shows now.
 * The open engine's edit got the sheet as image 1 when it launched, so the face is image 2 there.
 */
export function faceOfRun(request: Pick<GenerationRequest, "prompt" | "inputs">): string | null {
  const images = request.inputs?.images ?? [];
  const face = request.prompt?.includes(FACE_ON_SHEET) ? images[0] : request.prompt?.includes(FACE_ON_EDIT) ? images[1] : undefined;
  return face?.startsWith("/api/files/") ? face : null;
}

/** The picks as chips for the summary: [Category label, "Option, Option"]. */
export function summaryRows(state: InfluencerState): { category: string; label: string; options: string }[] {
  return categoriesFor(state.tier).flatMap((c) => {
    const ids = state.picks[c.id] ?? [];
    const labels = ids.map((id) => c.options.find((o) => o.id === id)?.label).filter(Boolean);
    return labels.length ? [{ category: c.id, label: c.label, options: labels.join(", ") }] : [];
  });
}

/** A starting name for the saved character: "Suits mullet", "Maine Coon cat", "Bold character". */
export function influencerName(state: InfluencerState): string {
  if (isCreature(state.tier)) {
    const s = speciesNoun(state.tier, state.species);
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  }
  const style = getOption("aesthetic", pick1(state, "aesthetic") ?? "")?.label;
  const hair = getOption("hair", pick1(state, "hair") ?? "")?.label;
  if (style && hair) return `${style} · ${hair}`;
  return `${HUMAN_TIERS.find((t) => t.id === state.tier)?.label ?? "My"} influencer`;
}

// ---------------------------------------------------------------------------
// Checking what comes in

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A state from the browser made safe: a retired option id becomes its new option (an old Trans man pick is
 * Male, Trans woman is Female, Non-binary is Other); unknown categories and options, options the tier doesn't
 * show and picks over a category's limit are dropped (Features: one per slot). A conflict is reported, not fixed.
 */
export function cleanState(raw: unknown): { state: InfluencerState; problem: string | null } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tier = isTier(r.tier) ? r.tier : "normal";
  const picks: Record<string, string[]> = {};
  const rawPicks = (r.picks && typeof r.picks === "object" ? r.picks : {}) as Record<string, unknown>;
  for (const c of categoriesFor(tier)) {
    const retired = RETIRED_OPTIONS[c.id] ?? {};
    const ids = Array.isArray(rawPicks[c.id]) ? (rawPicks[c.id] as unknown[]).filter((x): x is string => typeof x === "string").map((id) => (Object.hasOwn(retired, id) ? retired[id] : id)) : [];
    let next: string[] = [];
    for (const id of ids) if (c.options.some((o) => o.id === id) && !next.includes(id)) next = picked(c, next, id).next;
    if (next.length) picks[c.id] = next;
  }
  const creature = isCreature(tier);
  const species = creature && typeof r.species === "string" && creatureOf(tier)?.species.some((s) => s.id === r.species) ? r.species : undefined;
  const bodyColor = creature && typeof r.bodyColor === "string" && HEX.test(r.bodyColor) ? r.bodyColor.toLowerCase() : undefined;
  const locked = Array.isArray(r.locked) ? r.locked.filter((x): x is string => typeof x === "string" && CATEGORY.has(x)) : [];
  const state: InfluencerState = { tier, picks, locked, ...(species && { species }), ...(bodyColor && { bodyColor }) };
  return { state, problem: conflictIn(tier, picks) };
}

// ---------------------------------------------------------------------------
// The plan per engine

/**
 * The cloud models that draw the sheet: Fuobe Soul (the default, build plan O10: the sheet in Soul's casting look, then
 * hosted Qwen-Image-Edit 2511 puts your face and clothing on it), or Nano Banana Pro / Seedream 5.0 Pro in one pass with them.
 */
export const INFLUENCER_CLOUD_MODELS = ["fuobe-soul", "nano-banana-pro", "seedream-5-pro"] as const;
/** On your GPU: the Soul Cast sheet, then Qwen-Image 2.1 (up to 4 references) puts your face and clothing on it. */
export const INFLUENCER_OPEN_MODELS = { sheet: "oss-zimage-soul-cast", edit: "oss-qwen-image-21" } as const;
/** Fuobe Soul's steps in the cloud: the sheet on its hosted half, your face and clothing on hosted Qwen-Image-Edit 2511. */
export const INFLUENCER_SOUL = { sheet: "fuobe-soul", edit: "qwen-image-edit-2511-cloud" } as const;
/** The look the sheet is drawn in (Soul Cast's casting look: natural, unretouched skin and fabric). */
export const INFLUENCER_LOOK = CAST_LOOK;
/** Qwen-Image 2.1 takes four images on your GPU (the sheet, then the photo and clothing); fal takes more. */
export const OPEN_EDIT_IMAGES = 4;
/** The edit step's model, by name, per engine. */
const EDIT_NAME: Record<Engine, string> = { open: "Qwen-Image 2.1", cloud: "Qwen-Image-Edit 2511" };

export interface InfluencerRun {
  engine: Engine;
  state: InfluencerState;
  direction?: string;
  start: InfluencerStart;
  /** The reference or face photo (start "reference" / "face"). */
  photo?: string;
  /** Up to three clothing references. */
  clothing?: string[];
  /** The cloud model asked for (INFLUENCER_CLOUD_MODELS); the best available one when left out. */
  modelId?: string;
}

/** A step of the run, as createPipeline takes it (src/server/chains.ts). */
export interface InfluencerStep {
  key: string;
  request: GenerationRequest;
  after?: string;
  chain?: ChainSlot[];
}

export interface InfluencerPlan {
  steps: InfluencerStep[];
  /** The model that makes the sheet you get. */
  modelId: string;
  notes: string[];
}

export const FEATURE = "influencer";

/** Why a run can't start yet (null when it can): Higgsfield's words where it has them. */
export function influencerBlocker(run: Pick<InfluencerRun, "state" | "direction" | "start" | "photo" | "clothing">): string | null {
  const conflict = conflictIn(run.state.tier, run.state.picks);
  if (conflict) return conflict;
  if ((run.direction ?? "").length > MAX_DIRECTION) return "Keep the direction under 4,000 characters";
  if ((run.clothing?.length ?? 0) > MAX_CLOTHING) return "You can add up to three clothing references";
  if (run.start === "face" && !run.photo) return "Add your photo first";
  if (run.start === "reference" && !run.photo) return "Add a reference image first";
  return null;
}

/**
 * The jobs for a run. Open: the Soul Cast sheet workflow (Z-Image Turbo, with the casting look's LoRAs the server adds)
 * draws the character; with a photo or clothing, Qwen-Image 2.1 then puts your face and clothes on that sheet, so
 * the sheet keeps its wide shape. Cloud: the same two steps on Fuobe Soul and hosted Qwen-Image-Edit 2511 by default, or
 * Nano Banana Pro (Seedream 5.0 Pro when asked) drawing the sheet from the compiled prompt with the photos as references.
 */
export function planInfluencer(run: InfluencerRun, caps: Pick<PlanCaps, "has">): InfluencerPlan {
  const blocker = influencerBlocker(run);
  if (blocker) throw new Error(blocker);
  const { state, start } = run;
  const direction = run.direction?.trim() || undefined;
  const photo = start === "scratch" ? undefined : run.photo;
  const clothing = run.clothing ?? [];
  const title = influencerName(state);
  const notes: string[] = [];
  const has = (id: string, engine?: Engine) => !caps.has || caps.has(id, engine);
  const asked = run.modelId && (INFLUENCER_CLOUD_MODELS as readonly string[]).includes(run.modelId) ? run.modelId : undefined;
  // Fuobe Soul in the cloud unless another model is asked for (or this install switched Fuobe Soul off there, or hosted
  // Qwen-Image-Edit when your photo or clothing needs it).
  const edits = !!photo || clothing.length > 0;
  const cloudSoul = run.engine === "cloud" && (asked ?? INFLUENCER_SOUL.sheet) === INFLUENCER_SOUL.sheet && has(INFLUENCER_SOUL.sheet, "cloud") && (!edits || has(INFLUENCER_SOUL.edit));

  if (run.engine === "open" || cloudSoul) {
    const open = run.engine === "open";
    const sheetModel = open ? INFLUENCER_OPEN_MODELS.sheet : INFLUENCER_SOUL.sheet;
    const editModel = open ? INFLUENCER_OPEN_MODELS.edit : INFLUENCER_SOUL.edit;
    const sheet: InfluencerStep = {
      key: "sheet",
      request: open
        ? { feature: FEATURE, modelId: sheetModel, op: "t2i", prompt: compileCastPrompt({ state, direction }), params: { numOutputs: 1 }, title }
        : {
            feature: FEATURE,
            modelId: sheetModel,
            engine: "cloud",
            presetId: INFLUENCER_LOOK,
            op: "t2i",
            prompt: compileSheetPrompt({ state, direction }),
            params: { numOutputs: 1, aspectRatio: "16:9", resolution: "1080p" },
            title,
          },
    };
    if (!edits) return { steps: [sheet], modelId: sheetModel, notes };
    const takes = open ? OPEN_EDIT_IMAGES : 1 + 1 + MAX_CLOTHING;
    const room = takes - 1 - (photo ? 1 : 0);
    const used = clothing.slice(0, room);
    const editor = EDIT_NAME[run.engine];
    if (clothing.length > used.length) notes.push(`${editor} takes ${takes} images (the sheet${photo ? ", your photo" : ""} and clothing) — the first ${used.length === 1 ? "clothing reference is" : `${used.length} clothing references are`} used`);
    const drawer = open ? "Z-Image Turbo" : "Fuobe Soul";
    notes.push(
      photo
        ? start === "face"
          ? `Two steps: ${drawer} draws the sheet, then ${editor} puts your face on it`
          : `Two steps: ${drawer} draws the sheet, then ${editor} matches it to your reference`
        : `Two steps: ${drawer} draws the sheet, then ${editor} dresses it in your clothing`,
    );
    return {
      steps: [
        { ...sheet, request: { ...sheet.request, feature: `${FEATURE}-step`, title: `${title} · sheet`, step: { label: "Drawing the sheet", index: 0, of: 2 } } },
        {
          key: "dress",
          after: "sheet",
          chain: [{ slot: "images", position: "first" }],
          request: {
            feature: FEATURE,
            modelId: editModel,
            op: "edit",
            prompt: compileDressPrompt({ state, start, clothing: used.length }),
            inputs: { images: [...(photo ? [photo] : []), ...used] },
            // The graph keeps image 1's shape on your GPU; in the cloud "auto" leaves the size out, so the sheet stays 16:9.
            params: { numOutputs: 1, ...(!open && { aspectRatio: "auto" }) },
            title,
            step: { label: start === "face" ? "With your face" : start === "reference" ? "Matched to your reference" : "Dressed", index: 1, of: 2 },
          },
        },
      ],
      modelId: editModel,
      notes,
    };
  }

  const images = [...(photo ? [photo] : []), ...clothing];
  // Nano Banana Pro unless Seedream 5.0 Pro is asked for (Fuobe Soul switched off falls back here too).
  const modelId = asked && asked !== INFLUENCER_SOUL.sheet && has(asked) ? asked : "nano-banana-pro";
  if (run.engine === "cloud" && (asked ?? INFLUENCER_SOUL.sheet) === INFLUENCER_SOUL.sheet) {
    const off = !has(INFLUENCER_SOUL.sheet, "cloud") ? "Fuobe Soul is" : "Qwen-Image-Edit 2511 (hosted) is";
    notes.push(`${off} switched off in Settings → Models & licences — Nano Banana Pro draws the sheet`);
  }
  return {
    steps: [
      {
        key: "sheet",
        request: {
          feature: FEATURE,
          modelId,
          op: images.length ? "edit" : "t2i",
          prompt: compileSheetPrompt({ state, direction, start: photo ? start : "scratch", clothing: clothing.length }),
          ...(images.length && { inputs: { images } }),
          params: { numOutputs: 1, aspectRatio: "16:9", ...(modelId === "nano-banana-pro" && { resolution: "2K" }) },
          title,
        },
      },
    ],
    modelId,
    notes,
  };
}
