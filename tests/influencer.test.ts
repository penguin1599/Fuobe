import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getModel, getPreset } from "@/lib/catalog";
import { planGeneration } from "@/lib/catalog/plan";
import { CAST_LOOK } from "@/lib/catalog/soul-cards";
import {
  categoriesFor,
  cleanState,
  colorName,
  compileCastPrompt,
  compileDressPrompt,
  compileSheetPrompt,
  CONFLICT_MESSAGES,
  conflictFor,
  CREATURE_TYPES,
  describeInfluencer,
  faceOfRun,
  getOption,
  INFLUENCER_CATEGORIES,
  INFLUENCER_LOOK,
  INFLUENCER_START,
  influencerBlocker,
  influencerName,
  optionVisible,
  PHRASES,
  OPEN_EDIT_IMAGES,
  planInfluencer,
  RAIL_ORDER,
  resetPicks,
  RETIRED_OPTIONS,
  seededRandom,
  setTier,
  shuffleInfluencer,
  SPECIES_PHRASES,
  speciesNoun,
  summaryRows,
  tierStyle,
  togglePick,
  toggleLock,
  type InfluencerRun,
  type InfluencerState,
  type InfluencerTier,
} from "@/lib/influencer";

const research = JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/research/higgsfield-delta-4.json"), "utf8")).aiInfluencerBuilder as {
  categories: { id: string; label: string; max: number; options: { id: string; label: string; swatch?: string; slot?: string; visibleIn?: string[] }[] }[];
  creatureTypes: Record<string, string[]>;
};

const S = (tier: InfluencerTier, picks: Record<string, string[]> = {}, extra: Partial<InfluencerState> = {}): InfluencerState => ({ tier, picks, locked: [], ...extra });
/** Pick several options in order through the rules. */
const pickAll = (state: InfluencerState, ...pairs: [string, string][]) => pairs.reduce((s, [c, id]) => togglePick(s, c, id).state, state);
const HUMAN: InfluencerTier[] = ["normal", "freak", "total"];
const ALL_TIERS: InfluencerTier[] = [...HUMAN, ...CREATURE_TYPES.map((c) => c.id)];

describe("option data (generated from the research JSON)", () => {
  it("has the 19 categories, every option with its id, label, swatch and slot, and the 6 creature types", () => {
    expect(INFLUENCER_CATEGORIES).toHaveLength(19);
    expect(INFLUENCER_CATEGORIES.map((c) => [c.id, c.label, c.max])).toEqual(research.categories.map((c) => [c.id, c.label, c.max]));
    // Gender is Fuobe's own (Male, Female, Other: see "gender" below); the rest is the research's.
    for (const c of research.categories.filter((x) => x.id !== "gender")) {
      const ours = INFLUENCER_CATEGORIES.find((x) => x.id === c.id)!;
      expect(ours.options.map((o) => [o.id, o.label, o.swatch, o.slot])).toEqual(c.options.map((o) => [o.id, o.label, o.swatch?.toLowerCase(), o.slot]));
    }
    expect(INFLUENCER_CATEGORIES.find((c) => c.id === "skin_tone")!.options.map((o) => o.swatch)).toEqual(["#f1e2d5", "#e8c9b5", "#dab49a", "#b6976e", "#bc8e67", "#805135", "#543621", "#2d211b"]);
    expect(CREATURE_TYPES.map((c) => [c.id, c.species.map((s) => s.id)])).toEqual(Object.entries(research.creatureTypes));
    expect(CREATURE_TYPES.map((c) => c.label)).toEqual(["Insect", "Frog", "Cat", "Dog", "Rodent", "Bird"]);
  });

  it("names every option and species in the prompt, and nothing that no longer exists", () => {
    const ids = INFLUENCER_CATEGORIES.filter((c) => c.id !== "tier").flatMap((c) => c.options.map((o) => o.id));
    expect(ids.filter((id) => !PHRASES[id])).toEqual([]);
    expect(Object.keys(PHRASES).filter((id) => !ids.includes(id))).toEqual([]);
    const species = CREATURE_TYPES.flatMap((c) => c.species.map((s) => s.id));
    expect(species.filter((id) => !SPECIES_PHRASES[id])).toEqual([]);
    expect(Object.keys(SPECIES_PHRASES).filter((id) => !species.includes(id))).toEqual([]);
  });

  it("lists Character type, then gender, build, hairstyle, hair colour and style, then the rest", () => {
    expect(RAIL_ORDER.slice(0, 6)).toEqual(["tier", "gender", "body_type", "hair", "hair_colour", "aesthetic"]);
    expect(new Set(RAIL_ORDER).size).toBe(19);
  });
});

describe("what each tier shows", () => {
  const visible = (tier: InfluencerTier, cat: string) => categoriesFor(tier).find((c) => c.id === cat)?.options.map((o) => o.id) ?? [];

  it("Average hides the Bold and Extreme options; Bold adds †; Extreme adds ‡", () => {
    expect(visible("normal", "hair")).not.toContain("hs_lampshade");
    expect(visible("freak", "hair")).toContain("hs_lampshade");
    expect(visible("normal", "freak_face")).not.toContain("ff_nose_0");
    expect(visible("freak", "freak_head")).toContain("head_tiny");
    expect(visible("freak", "freak_head")).not.toContain("head_herojaw");
    expect(visible("total", "freak_head")).toEqual(expect.arrayContaining(["head_ancient", "head_herojaw", "head_megachin"]));
    expect(visible("freak", "body_type")).not.toContain("pr_centaur");
    expect(visible("total", "body_type")).toContain("pr_centaur");
    for (const t of HUMAN) expect(visible(t, "height")).not.toContain("h_short");
    expect(categoriesFor("normal")).toHaveLength(18);
  });

  it("creature types show their 10 categories with every option but Centaur, and Short", () => {
    for (const c of CREATURE_TYPES) {
      const cats = categoriesFor(c.id);
      expect(cats.map((x) => x.id).sort()).toEqual(["accessory", "aesthetic", "body_type", "distinctive", "facial_hair", "gender", "hair", "hair_colour", "height", "proportions"]);
      expect(visible(c.id, "height")).toContain("h_short");
      expect(visible(c.id, "body_type")).not.toContain("pr_centaur");
      expect(visible(c.id, "hair")).toContain("hs_lampshade");
    }
    expect(optionVisible(getOption("skin_tone", "st_fair")!, "cats", "skin_tone")).toBe(false);
  });
});

describe("gender", () => {
  it("is exactly Male, Female and Other, in that order, in every human tier", () => {
    for (const t of HUMAN) {
      const gender = categoriesFor(t).find((c) => c.id === "gender")!;
      expect(gender.options.filter((o) => optionVisible(o, t, "gender")).map((o) => [o.id, o.label])).toEqual([
        ["male", "Male"],
        ["female", "Female"],
        ["other", "Other"],
      ]);
    }
    expect(INFLUENCER_CATEGORIES.find((c) => c.id === "gender")!.options.map((o) => o.id)).toEqual(["male", "female", "other"]);
  });

  it("words each option in the prompt", () => {
    expect(describeInfluencer(S("normal", { gender: ["male"] }))).toBe("A man.");
    expect(describeInfluencer(S("normal", { gender: ["female"] }))).toBe("A woman.");
    expect(describeInfluencer(S("normal", { gender: ["other"] }))).toBe("An androgynous person.");
    expect(describeInfluencer(S("normal", { gender: ["other"], age: ["senior"] }))).toContain("androgynous person");
    expect(describeInfluencer(S("cats", { gender: ["other"] }))).toBe("An androgynous anthropomorphic cat.");
    for (const id of ["male", "female", "other"]) expect(compileSheetPrompt({ state: S("freak", { gender: [id] }), direction: "" })).toContain(PHRASES[id]);
  });

  it("turns old Trans man, Trans woman and Non-binary picks into Male, Female and Other", () => {
    expect(RETIRED_OPTIONS.gender).toEqual({ trans_man: "male", trans_woman: "female", non_binary: "other" });
    for (const [old, now] of [["trans_man", "male"], ["trans_woman", "female"], ["non_binary", "other"]]) {
      for (const tier of HUMAN) expect(cleanState({ tier, picks: { gender: [old] } }).state.picks).toEqual({ gender: [now] });
      expect(cleanState({ tier: "cats", picks: { gender: [old] } }).state.picks).toEqual({ gender: [now] });
    }
    expect(cleanState({ tier: "normal", picks: { gender: ["trans_man", "male"] } }).state.picks).toEqual({ gender: ["male"] });
    expect(cleanState({ tier: "normal", picks: { gender: ["toString"] } }).state.picks).toEqual({});
  });

  it("Shuffle picks only shown options", () => {
    const shown = new Set(["male", "female", "other"]);
    for (let i = 1; i <= 200; i++) expect(shown.has(shuffleInfluencer(S("normal"), seededRandom(i)).picks.gender[0])).toBe(true);
  });
});

describe("pick rules", () => {
  it("one-pick categories replace the pick, and a second click unpicks", () => {
    let s = pickAll(INFLUENCER_START, ["gender", "male"], ["gender", "female"]);
    expect(s.picks.gender).toEqual(["female"]);
    s = togglePick(s, "gender", "female").state;
    expect(s.picks.gender).toBeUndefined();
  });

  it("None clears the other accessories, another accessory clears None, and the oldest makes room past 3", () => {
    let s = pickAll(INFLUENCER_START, ["accessory", "acc_glasses"], ["accessory", "acc_hat"], ["accessory", "acc_none"]);
    expect(s.picks.accessory).toEqual(["acc_none"]);
    s = togglePick(s, "accessory", "acc_bag").state;
    expect(s.picks.accessory).toEqual(["acc_bag"]);
    s = pickAll(s, ["accessory", "acc_glasses"], ["accessory", "acc_hat"]);
    const r = togglePick(s, "accessory", "acc_jewelry");
    expect(r.state.picks.accessory).toEqual(["acc_glasses", "acc_hat", "acc_jewelry"]);
    expect(r.note).toBe("Accessories: up to 3 — Bag was replaced");
  });

  it("Features keep one option per slot, up to 4", () => {
    let s = pickAll(S("freak"), ["freak_face", "fn_freckles"], ["freak_face", "ff_marks_12"]);
    expect(s.picks.freak_face).toEqual(["ff_marks_12"]);
    s = pickAll(s, ["freak_face", "fn_dimples"], ["freak_face", "ff_nose_1"], ["freak_face", "fn_fulllips"], ["freak_face", "ff_brows_5"]);
    expect(s.picks.freak_face).toEqual(["fn_dimples", "ff_nose_1", "fn_fulllips", "ff_brows_5"]);
    // Same slot as Full lips: replaces it, nothing else goes.
    s = togglePick(s, "freak_face", "ff_lips_3").state;
    expect(s.picks.freak_face).toEqual(["fn_dimples", "ff_nose_1", "ff_brows_5", "ff_lips_3"]);
  });

  it("refuses options the tier doesn't show", () => {
    expect(togglePick(S("normal"), "hair", "hs_lampshade").state.picks.hair).toBeUndefined();
    expect(togglePick(S("cats"), "skin_tone", "st_fair").state.picks).toEqual({});
  });
});

describe("conflicts (Higgsfield's messages)", () => {
  it("Heavy build with Tall or Very tall, either way round, in every tier", () => {
    for (const tier of ALL_TIERS) {
      const heavy = pickAll(S(tier), ["body_type", "body_heavy"]);
      for (const h of ["h_tall", "h_very_tall"]) {
        const r = togglePick(heavy, "height", h);
        expect(r.conflict).toBe("Heavy build cannot be combined with Tall or Very tall.");
        expect(r.state).toBe(heavy);
      }
      const tall = pickAll(S(tier), ["height", "h_tall"]);
      expect(conflictFor(tall, "body_type", "body_heavy")).toBe(CONFLICT_MESSAGES.heavyTall);
      expect(conflictFor(tall, "body_type", "body_slim")).toBeNull();
    }
  });

  it("Heavy, Muscular or Ultra Muscular with Short legs or Long limbs, except in Average", () => {
    for (const body of ["body_heavy", "body_muscular", "body_ultra"]) {
      for (const p of ["pr_shortlegs", "pr_longlimbs"]) {
        expect(conflictFor(pickAll(S("freak"), ["body_type", body]), "proportions", p)).toBe("This build cannot be combined with Short legs or Long limbs in this mode.");
        expect(conflictFor(pickAll(S("dogs"), ["proportions", p]), "body_type", body)).toBe(CONFLICT_MESSAGES.buildLegs);
        expect(conflictFor(pickAll(S("normal"), ["body_type", body]), "proportions", p)).toBeNull();
      }
    }
    expect(conflictFor(pickAll(S("total"), ["body_type", "body_athletic"]), "proportions", "pr_shortlegs")).toBeNull();
    // Replacing the conflicting build is fine: the new pick is what counts.
    const s = pickAll(S("freak"), ["proportions", "pr_shortlegs"], ["body_type", "body_slim"]);
    expect(conflictFor(s, "body_type", "body_athletic")).toBeNull();
  });

  it("unpicking never conflicts", () => {
    const s = S("freak", { body_type: ["body_muscular"], proportions: ["pr_shortlegs"] });
    expect(conflictFor(s, "proportions", "pr_shortlegs")).toBeNull();
    expect(togglePick(s, "proportions", "pr_shortlegs").state.picks.proportions).toBeUndefined();
  });
});

describe("switching the character type", () => {
  it("drops what the new tier doesn't show and names it", () => {
    const s = pickAll(S("total"), ["hair", "hs_horns"], ["freak_head", "head_ancient"], ["gender", "female"]);
    const r = setTier(s, "normal");
    expect(r.state.picks).toEqual({ gender: ["female"] });
    expect(r.dropped).toEqual(["Hair horns", "Caveman"]);
  });

  it("Average → Bold drops the leg proportions a big build can't have there", () => {
    const s = pickAll(S("normal"), ["body_type", "body_muscular"], ["proportions", "pr_shortlegs"], ["proportions", "pr_shoulders"]);
    const r = setTier(s, "freak");
    expect(r.state.picks.proportions).toEqual(["pr_shoulders"]);
    expect(r.dropped).toEqual(["Short legs"]);
  });

  it("keeps a tall height that never conflicted: only the leg proportions give way", () => {
    const s = pickAll(S("normal"), ["body_type", "body_muscular"], ["height", "h_tall"], ["proportions", "pr_shortlegs"]);
    for (const tier of ["freak", "cats"] as const) {
      const r = setTier(s, tier);
      expect(r.state.picks).toEqual({ body_type: ["body_muscular"], height: ["h_tall"] });
      expect(r.dropped).toEqual(["Short legs"]);
    }
    // Heavy with a tall height is refused in every tier, so only a state from outside has it: the height goes.
    const outside = setTier(S("normal", { body_type: ["body_heavy"], height: ["h_very_tall"], proportions: ["pr_longlimbs"] }), "total");
    expect(outside.state.picks).toEqual({ body_type: ["body_heavy"] });
    expect(outside.dropped).toEqual(["Very tall", "Long limbs"]);
  });

  it("drops the species of the old type, and keeps the body colour for creatures", () => {
    const cat = S("cats", { gender: ["male"] }, { species: "persian", bodyColor: "#ff8800" });
    expect(setTier(cat, "dogs").state).toMatchObject({ tier: "dogs", bodyColor: "#ff8800", picks: { gender: ["male"] } });
    expect(setTier(cat, "dogs").state.species).toBeUndefined();
    expect(setTier(cat, "normal").state.bodyColor).toBeUndefined();
    expect(setTier(S("normal", { skin_tone: ["st_fair"], freak_face: ["fn_freckles", "fn_dimples"], gender: ["male"] }), "cats").dropped).toEqual(["Skin color", "Features"]);
  });

  it("Reset all clears the picks and locks but keeps the type", () => {
    expect(resetPicks(S("birds", { gender: ["male"] }, { locked: ["gender"], species: "duck" }))).toEqual({ tier: "birds", picks: {}, locked: [] });
  });
});

describe("Shuffle", () => {
  const runs = (state: InfluencerState, n: number, opts = {}) => Array.from({ length: n }, (_, i) => shuffleInfluencer(state, seededRandom(i + 1), opts));
  const share = (xs: InfluencerState[], cat: string, id: string) => xs.filter((x) => x.picks[cat]?.[0] === id).length / xs.length;

  it("is repeatable with a seed", () => {
    expect(shuffleInfluencer(S("freak"), seededRandom(42))).toEqual(shuffleInfluencer(S("freak"), seededRandom(42)));
    expect(shuffleInfluencer(S("freak"), seededRandom(42))).not.toEqual(shuffleInfluencer(S("freak"), seededRandom(43)));
  });

  it("uses the researched weights: male 67% / female 33%, Suits 40%, Retro 20%, Bob 20% where it shows", () => {
    const freak = runs(S("freak"), 4000);
    expect(new Set(freak.map((x) => x.picks.gender[0]))).toEqual(new Set(["male", "female"]));
    expect(share(freak, "gender", "male")).toBeCloseTo(0.67, 1);
    expect(share(freak, "aesthetic", "suits")).toBeCloseTo(0.4, 1);
    expect(share(freak, "aesthetic", "retro")).toBeCloseTo(0.2, 1);
    expect(share(freak, "aesthetic", "goth")).toBeCloseTo(0.4 / 6, 1);
    expect(share(freak, "hair", "hs_lampshade")).toBeCloseTo(0.2, 1);
    const normal = runs(S("normal"), 1000);
    expect(share(normal, "hair", "hs_lampshade")).toBe(0);
    // Without Bob every hairstyle is equally likely.
    expect(share(normal, "hair", "hair_mullet")).toBeCloseTo(1 / 11, 1);
  });

  it("never shuffles a build it shouldn't, nor a conflict", () => {
    for (const tier of ALL_TIERS) {
      for (const s of runs(S(tier), 600)) {
        const body = s.picks.body_type?.[0];
        const height = s.picks.height?.[0] ?? "";
        const props = s.picks.proportions ?? [];
        expect(body).not.toBe("body_curvy");
        if (tier === "normal") expect(body).not.toBe("body_ultra");
        if (body === "body_heavy") {
          expect(["h_tall", "h_very_tall"]).not.toContain(height);
          expect(props).not.toContain("pr_waist");
        }
        if (body === "pr_centaur") expect(props).not.toContain("pr_egg");
        if (body === "body_ultra") expect(s.picks.freak_neck?.[0]).not.toBe("neck_long");
        expect(cleanState(s).problem).toBeNull();
        // Everything it picks is something the tier shows, within each category's limit.
        expect(cleanState(s).state.picks).toEqual(s.picks);
      }
    }
  });

  it("keeps the build rules whichever side is locked (Keep on Shuffle)", () => {
    const tall = ["h_tall", "h_very_tall"];
    const check = (state: InfluencerState) => {
      const out = runs(state, 400);
      for (const s of out) {
        const body = s.picks.body_type?.[0];
        const props = s.picks.proportions ?? [];
        // The locked picks stay, and nothing shuffled conflicts with them.
        for (const k of state.locked) expect(s.picks[k]).toEqual(state.picks[k]);
        expect(cleanState(s).problem).toBeNull();
        if (body === "body_heavy") {
          expect(tall).not.toContain(s.picks.height?.[0]);
          // Unless the user locked both: their picks are theirs.
          if (!state.locked.includes("proportions")) expect(props).not.toContain("pr_waist");
        }
        if (body === "pr_centaur") expect(props).not.toContain("pr_egg");
        if (body === "body_ultra") expect(s.picks.freak_neck?.[0]).not.toBe("neck_long");
      }
      return out;
    };
    const lock = (tier: InfluencerTier, picks: Record<string, string[]>) => S(tier, picks, { locked: Object.keys(picks) });
    // A locked build: heights, proportions and neck give way.
    const heavy = check(lock("normal", { body_type: ["body_heavy"] }));
    const short = categoriesFor("normal").find((c) => c.id === "height")!.options.map((o) => o.id).filter((id) => !tall.includes(id));
    expect(new Set(heavy.map((s) => s.picks.height?.[0]))).toEqual(new Set(short));
    check(lock("freak", { body_type: ["body_muscular"] }));
    check(lock("total", { body_type: ["body_ultra"] }));
    check(lock("total", { body_type: ["pr_centaur"] }));
    // A locked height, proportion or neck: the build gives way.
    for (const s of check(lock("normal", { height: ["h_very_tall"] }))) expect(s.picks.body_type?.[0]).not.toBe("body_heavy");
    for (const s of check(lock("freak", { proportions: ["pr_shortlegs"] }))) expect(["body_heavy", "body_muscular", "body_ultra"]).not.toContain(s.picks.body_type?.[0]);
    for (const s of check(lock("total", { freak_neck: ["neck_long"] }))) expect(s.picks.body_type?.[0]).not.toBe("body_ultra");
    // Two locked picks the rules allow together (Heavy with a Tiny waist) stay, and nothing clashing is added.
    for (const s of check(lock("normal", { body_type: ["body_heavy"], proportions: ["pr_waist"] }))) expect(tall).not.toContain(s.picks.height?.[0]);
  });

  it("gives facial hair only to men", () => {
    for (const s of runs(S("total"), 600)) {
      const g = s.picks.gender[0];
      if (g !== "male") expect(s.picks.facial_hair).toEqual(["fh_none"]);
    }
    expect(new Set(runs(S("total"), 600).filter((s) => s.picks.gender[0] === "male").map((s) => s.picks.facial_hair[0])).size).toBeGreaterThan(4);
  });

  it("keeps locked picks, and what a photo decides", () => {
    const locked = toggleLock(S("freak", { gender: ["other"], hair: ["hs_wings"] }), "hair");
    for (const s of runs(locked, 50)) expect(s.picks.hair).toEqual(["hs_wings"]);
    const fixed = S("normal", { gender: ["other"], ethnicity_origin_base: ["indian"], skin_tone: ["st_tan"], age: ["senior"], eye_color: ["eye_green"] });
    for (const s of runs(fixed, 50, { reference: true })) expect(s.picks).toMatchObject(fixed.picks);
    // Bold keeps gender, ethnicity and age; skin and eyes shuffle.
    const bold = runs({ ...fixed, tier: "freak" }, 50, { reference: true });
    for (const s of bold) expect(s.picks).toMatchObject({ gender: ["other"], ethnicity_origin_base: ["indian"], age: ["senior"] });
    expect(bold.some((s) => s.picks.skin_tone[0] !== "st_tan")).toBe(true);
    // Without a photo nothing is kept.
    expect(runs(fixed, 50).some((s) => s.picks.gender[0] !== "other")).toBe(true);
  });

  it("leaves the type, species and body colour alone", () => {
    const s = shuffleInfluencer(S("cats", {}, { species: "sphynx", bodyColor: "#336699" }), seededRandom(7));
    expect(s).toMatchObject({ tier: "cats", species: "sphynx", bodyColor: "#336699" });
  });
});

describe("the prompt compiler", () => {
  it("puts every category's phrase into the description", () => {
    for (const tier of ["total", "cats"] as InfluencerTier[]) {
      for (const c of categoriesFor(tier)) {
        for (const o of c.options) {
          const d = describeInfluencer(S(tier, { [c.id]: [o.id] }));
          // A hairstyle with no colour picked: "a {color}afro" reads "an afro".
          const phrase = PHRASES[o.id].includes("{color}") ? PHRASES[o.id].replace("{color}", "").replace(/\ba ([aeiou])/, "an $1") : PHRASES[o.id];
          const want = c.id === "gender" && tier === "cats" ? undefined : c.id === "eye_shape" || c.id === "eye_color" ? `${phrase} eyes` : c.id === "hair_colour" ? `${phrase} hair` : phrase;
          if (want) expect(d.toLowerCase(), `${c.id}/${o.id}`).toContain(want.toLowerCase());
        }
      }
    }
  });

  it("reads like a sentence", () => {
    const s = S("normal", {
      gender: ["male"],
      age: ["adult"],
      ethnicity_origin_base: ["european"],
      height: ["h_tall"],
      body_type: ["body_athletic"],
      eye_shape: ["es_almond"],
      eye_color: ["eye_hazel"],
      hair: ["hair_mullet"],
      hair_colour: ["hc_black"],
      facial_hair: ["fh_stubble"],
      aesthetic: ["suits"],
      accessory: ["acc_glasses", "acc_hat"],
    });
    expect(describeInfluencer(s)).toBe("A young adult European man, tall, with an athletic build, almond-shaped hazel eyes, a jet black mullet and stubble, wearing a tailored suit, with glasses and a hat.");
    expect(describeInfluencer(INFLUENCER_START)).toBe("A person.");
    expect(describeInfluencer(S("normal", { hair: ["hair_afro"] }))).toBe("A person, with an afro.");
    expect(describeInfluencer(S("normal", { hair: ["hair_long"], hair_colour: ["hc_platinum"] }))).toContain("long platinum blonde hair");
    expect(describeInfluencer(S("normal", { hair: ["hair_bald"], hair_colour: ["hc_red"] }))).toContain("a bald head");
    expect(describeInfluencer(S("normal", { gender: ["female"], facial_hair: ["fh_none"], accessory: ["acc_none"] }))).toBe("A woman, no accessories.");
    expect(describeInfluencer(S("normal", { gender: ["male"], facial_hair: ["fh_none"] }))).toBe("A man, clean-shaven.");
  });

  it("words the tier: realistic, bold caricature, extreme caricature, anthropomorphic {species}", () => {
    expect(tierStyle(S("normal"))).toMatch(/^Realistic/);
    expect(tierStyle(S("freak"))).toMatch(/^Bold caricature/);
    expect(tierStyle(S("total"))).toMatch(/^Extreme caricature/);
    expect(tierStyle(S("cats", {}, { species: "maine_coon" }))).toMatch(/^Anthropomorphic Maine Coon cat: an upright Maine Coon cat/);
    expect(tierStyle(S("frogs"))).toMatch(/^Anthropomorphic frog/);
    expect(describeInfluencer(S("capybaras", { gender: ["female"] }, { species: "barrel", bodyColor: "#f4c2d7" }))).toBe("A female anthropomorphic barrel-shaped capybara with pale pink fur.");
    expect(describeInfluencer(S("insects", {}, { species: "ant" }))).toBe("An anthropomorphic ant.");
    expect(speciesNoun("dogs", "persian")).toBe("dog");
  });

  it("names body colours", () => {
    expect(colorName("#000000")).toBe("black");
    expect(colorName("#ffffff")).toBe("white");
    expect(colorName("#808080")).toBe("grey");
    expect(colorName("#ff0000")).toBe("red");
    expect(colorName("#102a6b")).toBe("deep blue");
    expect(colorName("#22c55e")).toBe("green");
    expect(colorName("#8b5a2b")).toBe("brown");
    expect(colorName("#14b8a6")).toBe("teal");
    expect(colorName("nope")).toBe("");
  });

  it("builds the sheet prompt with the photo's and the clothing's roles and the Direction", () => {
    const s = S("freak", { gender: ["female"] });
    const p = compileSheetPrompt({ state: s, direction: "  She runs a ceramics studio.  ", start: "face", clothing: 2 });
    expect(p).toMatch(/^Character sheet of an original AI influencer on a pure white background: a close-up portrait of the face, then full-body/);
    expect(p).toContain("The character: A woman");
    expect(p).toContain("Bold caricature");
    expect(p).toContain("the face of the person in image 1");
    expect(p).toContain("the clothing shown in images 2 and 3");
    expect(p).toContain("Direction: She runs a ceramics studio.");
    expect(compileSheetPrompt({ state: s, clothing: 1 })).toContain("the clothing shown in image 1");
    expect(compileSheetPrompt({ state: s, start: "reference" })).toContain("Base the character on the one in image 1");
    expect(compileCastPrompt({ state: s, direction: "loves surfing" })).toBe("A woman. Bold caricature: photographic, but the chosen features are exaggerated for a memorable, slightly cartoonish look. loves surfing.");
    expect(compileDressPrompt({ state: s, start: "face", clothing: 1 })).toBe(
      "Image 1 is a character turnaround sheet. Give the character in every view the face of the person in image 2: the same identity, facial features and skin tone. Dress the character in every view in the clothing shown in image 3. Keep the poses, the layout, the number of views and the white background of image 1 unchanged.",
    );
    expect(compileDressPrompt({ state: s, clothing: 2 })).toContain("clothing shown in images 2 and 3");
  });

  it("reads the face back from a finished run, for Save as character", () => {
    const s = S("freak", { gender: ["female"] });
    const me = "/api/files/me.jpg";
    const coat = "/api/files/coat.png";
    // Cloud: the face is image 1, the clothing after it.
    expect(faceOfRun({ prompt: compileSheetPrompt({ state: s, start: "face", clothing: 1 }), inputs: { images: [me, coat] } })).toBe(me);
    // Open: the sheet went in first when the edit launched.
    expect(faceOfRun({ prompt: compileDressPrompt({ state: s, start: "face", clothing: 1 }), inputs: { images: ["/api/files/sheet.png", me, coat] } })).toBe(me);
    // A reference or clothing isn't the character's face.
    expect(faceOfRun({ prompt: compileSheetPrompt({ state: s, start: "reference" }), inputs: { images: [me] } })).toBeNull();
    expect(faceOfRun({ prompt: compileDressPrompt({ state: s, clothing: 1 }), inputs: { images: ["/api/files/sheet.png", coat] } })).toBeNull();
    expect(faceOfRun({ prompt: compileCastPrompt({ state: s }) })).toBeNull();
  });

  it("summarises and names", () => {
    const s = S("normal", { gender: ["male"], aesthetic: ["suits"], hair: ["hair_mullet"], accessory: ["acc_glasses", "acc_hat"] });
    expect(summaryRows(s)).toEqual([
      { category: "gender", label: "Gender", options: "Male" },
      { category: "hair", label: "Hairstyle", options: "Mullet" },
      { category: "aesthetic", label: "Style", options: "Suits" },
      { category: "accessory", label: "Accessories", options: "Glasses, Hat" },
    ]);
    expect(influencerName(s)).toBe("Suits · Mullet");
    expect(influencerName(S("freak"))).toBe("Bold influencer");
    expect(influencerName(S("cats", {}, { species: "maine_coon" }))).toBe("Maine Coon cat");
  });
});

describe("checking what the browser sends", () => {
  it("drops unknown, hidden and surplus picks, keeps one per slot, and reports a conflict", () => {
    const { state, problem } = cleanState({
      tier: "normal",
      picks: { gender: ["male", "female"], hair: ["hs_lampshade", "nope"], freak_face: ["fn_freckles", "fn_mole"], bogus: ["x"], accessory: ["acc_glasses", "acc_none"] },
      species: "pug",
      bodyColor: "#123456",
      locked: ["gender", "bogus"],
    });
    expect(state).toEqual({ tier: "normal", picks: { gender: ["female"], freak_face: ["fn_mole"], accessory: ["acc_none"] }, locked: ["gender"] });
    expect(problem).toBeNull();
    expect(cleanState({ tier: "freak", picks: { body_type: ["body_heavy"], height: ["h_very_tall"] } }).problem).toBe(CONFLICT_MESSAGES.heavyTall);
    expect(cleanState({ tier: "dogs", species: "pug", bodyColor: "#ABCDEF" }).state).toEqual({ tier: "dogs", picks: {}, locked: [], species: "pug", bodyColor: "#abcdef" });
    expect(cleanState({ tier: "dogs", species: "persian", bodyColor: "red" }).state).toEqual({ tier: "dogs", picks: {}, locked: [] });
    expect(cleanState(null).state).toEqual(INFLUENCER_START);
  });
});

describe("the plan per engine", () => {
  const face = "/api/files/me.jpg";
  const clothes = ["/api/files/a.png", "/api/files/b.png", "/api/files/c.png"];
  const state = S("freak", { gender: ["female"], hair: ["hs_beehive"], aesthetic: ["goth"] });
  const run = (o: Partial<InfluencerRun>): InfluencerRun => ({ engine: "cloud", state, start: "scratch", ...o });
  const ALL = { has: () => true };
  const valid = (p: ReturnType<typeof planInfluencer>) => p.steps.map((s) => planGeneration(s.request, getModel, getPreset));

  it("cloud: Fuobe Soul draws the wide sheet, then hosted Qwen-Image-Edit 2511 puts your face and clothing on it", () => {
    const p = planInfluencer(run({ start: "face", photo: face, clothing: clothes }), ALL);
    expect(p.modelId).toBe("qwen-image-edit-2511-cloud");
    expect(p.notes).toEqual(["Two steps: Fuobe Soul draws the sheet, then Qwen-Image-Edit 2511 puts your face on it"]);
    expect(p.steps.map((s) => [s.key, s.request.feature, s.request.modelId, s.after])).toEqual([
      ["sheet", "influencer-step", "fuobe-soul", undefined],
      ["dress", "influencer", "qwen-image-edit-2511-cloud", "sheet"],
    ]);
    // The sheet in Soul's casting look, wide and 1080p; fal's Qwen edit takes the face and all three clothing references.
    expect(p.steps[0].request).toMatchObject({ engine: "cloud", presetId: INFLUENCER_LOOK, op: "t2i", prompt: compileSheetPrompt({ state }), params: { aspectRatio: "16:9", resolution: "1080p", numOutputs: 1 } });
    expect(p.steps[1].request.inputs?.images).toEqual([face, ...clothes]);
    expect(p.steps[1].request.prompt).toContain("the face of the person in image 2");
    expect(p.steps[1].request.prompt).toContain("clothing shown in images 3, 4 and 5");
    expect(p.steps[1].chain).toEqual([{ slot: "images", position: "first" }]);
    const [sheet] = valid(p);
    expect(sheet.model.id).toBe("fuobe-soul");
    expect(sheet.soul?.look).toBe(INFLUENCER_LOOK);
    const scratch = planInfluencer(run({ direction: "A potter from Porto" }), ALL);
    expect(scratch.modelId).toBe("fuobe-soul");
    expect(scratch.steps).toHaveLength(1);
    expect(scratch.steps[0].request).toMatchObject({ feature: "influencer", op: "t2i", prompt: compileSheetPrompt({ state, direction: "A potter from Porto" }) });
    valid(scratch);
    // Fuobe Soul switched off in the cloud (or the hosted edit): Nano Banana Pro draws it in one pass, and says why.
    const off = planInfluencer(run({ start: "face", photo: face }), { has: (id, engine) => !(id === "fuobe-soul" && engine === "cloud") });
    expect(off.modelId).toBe("nano-banana-pro");
    expect(off.notes).toEqual(["Fuobe Soul is switched off in Settings → Models & licences — Nano Banana Pro draws the sheet"]);
    expect(INFLUENCER_LOOK).toBe(CAST_LOOK);
  });

  it("cloud partners: Nano Banana Pro draws a wide sheet from the compiled prompt, Seedream 5.0 Pro when asked", () => {
    const p = planInfluencer(run({ modelId: "nano-banana-pro", start: "face", photo: face, clothing: [clothes[0]] }), ALL);
    expect(p.modelId).toBe("nano-banana-pro");
    expect(p.notes).toEqual([]);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].request).toMatchObject({ feature: "influencer", op: "edit", inputs: { images: [face, clothes[0]] }, params: { aspectRatio: "16:9", resolution: "2K", numOutputs: 1 } });
    expect(p.steps[0].request.prompt).toContain("the face of the person in image 1");
    expect(p.steps[0].request.prompt).toContain("clothing shown in image 2");
    valid(p);
    const seedream = planInfluencer(run({ modelId: "seedream-5-pro", clothing: clothes }), ALL);
    expect(seedream.modelId).toBe("seedream-5-pro");
    expect(seedream.steps[0].request.params).toEqual({ numOutputs: 1, aspectRatio: "16:9" });
    expect(seedream.steps[0].request.inputs?.images).toEqual(clothes);
    valid(seedream);
    // Nothing else is asked for: not Higgsfield's AI Influencer, not a model the builder doesn't list: the default runs.
    for (const modelId of ["ai-influencer", "flux-3-max"]) {
      const other = planInfluencer(run({ modelId }), ALL);
      expect(other.modelId).toBe("fuobe-soul");
      expect(other.steps[0].request.params?.extra).toBeUndefined();
    }
    // Seedream missing from the install: Nano Banana Pro.
    expect(planInfluencer(run({ modelId: "seedream-5-pro" }), { has: (id) => id !== "seedream-5-pro" }).modelId).toBe("nano-banana-pro");
  });

  it("open from scratch: the Soul Cast sheet workflow with the compiled character", () => {
    const p = planInfluencer(run({ engine: "open", direction: "loves jazz" }), ALL);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].request).toMatchObject({ feature: "influencer", modelId: "oss-zimage-soul-cast", op: "t2i", prompt: compileCastPrompt({ state, direction: "loves jazz" }) });
    valid(p);
  });

  it("open with your face: the sheet, then Qwen-Image 2.1 puts the face (and two clothing references) on it", () => {
    expect(clothes).toHaveLength(3);
    expect(OPEN_EDIT_IMAGES).toBe(4);
    const p = planInfluencer(run({ engine: "open", start: "face", photo: face, clothing: clothes }), ALL);
    expect(p.modelId).toBe("oss-qwen-image-21");
    expect(p.steps.map((s) => [s.key, s.request.feature, s.request.modelId, s.after])).toEqual([
      ["sheet", "influencer-step", "oss-zimage-soul-cast", undefined],
      ["dress", "influencer", "oss-qwen-image-21", "sheet"],
    ]);
    expect(p.steps[1].chain).toEqual([{ slot: "images", position: "first" }]);
    // The sheet (chained in first), your face and two clothing references: Qwen-Image 2.1's four images.
    expect(p.steps[1].request.inputs?.images).toEqual([face, clothes[0], clothes[1]]);
    expect(p.steps[1].request.prompt).toBe(compileDressPrompt({ state, start: "face", clothing: 2 }));
    expect(p.notes[0]).toBe("Qwen-Image 2.1 takes 4 images (the sheet, your photo and clothing) — the first 2 clothing references are used");
    expect(p.notes[1]).toBe("Two steps: Z-Image Turbo draws the sheet, then Qwen-Image 2.1 puts your face on it");
    valid(p);
    // Without a photo, all three clothing references fit beside the sheet.
    const dressed = planInfluencer(run({ engine: "open", clothing: clothes }), ALL);
    expect(dressed.steps[1].request.inputs?.images).toEqual(clothes);
    expect(dressed.notes).toEqual(["Two steps: Z-Image Turbo draws the sheet, then Qwen-Image 2.1 dresses it in your clothing"]);
    // A photo only matters when the run starts from it.
    expect(planInfluencer(run({ engine: "open", start: "scratch", photo: face }), ALL).steps).toHaveLength(1);
  });

  it("says what is missing or too much, in Higgsfield's words where it has them", () => {
    expect(influencerBlocker(run({ direction: "x".repeat(4001) }))).toBe("Keep the direction under 4,000 characters");
    expect(influencerBlocker(run({ direction: "x".repeat(4000) }))).toBeNull();
    expect(influencerBlocker(run({ clothing: [...clothes, "/api/files/d.png"] }))).toBe("You can add up to three clothing references");
    expect(influencerBlocker(run({ start: "face" }))).toBe("Add your photo first");
    expect(influencerBlocker(run({ start: "reference" }))).toBe("Add a reference image first");
    expect(() => planInfluencer(run({ state: S("freak", { body_type: ["body_ultra"], proportions: ["pr_longlimbs"] }) }), ALL)).toThrow(CONFLICT_MESSAGES.buildLegs);
  });
});
