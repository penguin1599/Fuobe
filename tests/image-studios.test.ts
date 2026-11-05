import { describe, expect, it } from "vitest";
import { getModel, getPreset } from "@/lib/catalog";
import { castName, randomizeCast, SOUL_CAST_FIELDS } from "@/lib/catalog/cinema";
import { applyMentions, type StudioElement } from "@/lib/catalog/elements";
import { onEngine } from "@/lib/catalog/engines";
import fs from "node:fs";
import { PHOTODUMP_PACKS } from "@/lib/catalog/studio-packs.generated";
import { SOUL_LEGACY_IDS } from "@/lib/catalog/soul-looks.generated";
import { lookCard } from "@/lib/catalog/soul-cards";
import {
  castFieldVisible,
  castNameFor,
  castSheetModel,
  coverTone,
  customPack,
  FASHION,
  FASHION_MODELS,
  FASHION_START,
  fashionBaseRequest,
  fashionBlocker,
  fashionOutfitRequest,
  fashionPhotosetRequests,
  fashionReducer,
  getPack,
  PACKS,
  PHOTODUMP_MODELS,
  photodumpModel,
  planPhotodump,
  randomCast,
  sheetFromReference,
  shotPrompt,
  spreadHue,
  type FashionState,
  type PhotoSubject,
} from "@/lib/catalog/packs";
import {
  applySignature,
  cardStrip,
  extractPalette,
  kmeans,
  normalizeHex,
  paletteColors,
  paletteError,
  randomPalettes,
  rng,
  samplePixels,
  SIGNATURE_MODELS,
  styleWords,
  suggestName,
  type MoodboardPick,
  type PalettePick,
  type RGB,
  type SignatureCaps,
  reuseSignature,
  withBackground,
  withSignatureWords,
} from "@/lib/catalog/palettes";
import { buildPayload } from "@/lib/catalog/payload";
import { planGeneration } from "@/lib/catalog/plan";
import type { GenerationRequest } from "@/lib/catalog/types";
import { studioCatalog } from "@/lib/studio-catalog";
import { IMAGE_STUDIO } from "@/lib/studios";
import {
  collageGroups,
  colorFeature,
  coverCrop,
  CURATED_SETS,
  CURATED_TABS,
  curatedPick,
  imageProblem,
  inCuratedTab,
  moodboardError,
  moodboardStatus,
  representativeOrder,
  SOUL_STYLES,
  soulPick,
} from "@/components/moodboards/logic";

// The caps GET /api/palettes sends (src/server/palettes.ts signatureCaps, checked against the catalog in image-studios-api.test.ts).
const CAPS: SignatureCaps = {
  native: {
    "recraft-4-1": { max: 10, background: "background_color" },
    "recraft-4-1-pro": { max: 10, background: "background_color" },
    "recraft-4-style": { max: 10, background: "background_color" },
    "recraft-4-style-pro": { max: 10, background: "background_color" },
    "recraft-4-style-saved": { max: 10, background: "background_color" },
    "ideogram-3": { max: 12 },
  },
};
const ctx = { caps: CAPS, getModel };
const plan = (r: GenerationRequest) => planGeneration(r, getModel, getPreset);
/** The prompt as the server runs it: the user's words plus the signature's sentences. */
const said = (s: { request: GenerationRequest }) => withSignatureWords(s.request).prompt;
/** A look described in words after the user's prompt (how a model without Fuobe Soul's looks gets one). */
const lookPrompt = (look: { name: string; description?: string }, prompt: string) => `${prompt}. ${styleWords(look)}`;
/** Soul's 139 presets as the research recorded them (their ids are the old style ids). */
const SOUL_RESEARCH = (JSON.parse(fs.readFileSync("docs/research/higgsfield-image-studios.json", "utf8")) as { soulPresets: { id: string; name: string; model: string; description: string }[] }).soulPresets.filter(
  (p) => p.model === "soul-v1" || p.model === "soul-v2",
);

const fill = (rgb: RGB, n: number): RGB[] => Array.from({ length: n }, () => [...rgb] as RGB);
const PAL: PalettePick = { id: "p1", name: "Teal Dusk", colors: ["#102030", "#2A9D8F", "#E9C46A", "#F4A261"], background: "#264653", slug: null };
const CINEMA_PAL: PalettePick = { id: "builtin-static-noon", name: "Static Noon", colors: ["#0C0C0C", "#69483B"], background: "#69483B", slug: "static-noon" };

describe("palettes: k-means extraction", () => {
  it("finds each image's colours, gives every image a say, and orders them dark → light", () => {
    const a = [...fill([200, 30, 30], 900), ...fill([20, 20, 20], 100)];
    const b = fill([30, 60, 220], 50);
    const r = extractPalette([a, b], { count: 4, seed: 1 });
    expect(r.colors).toContain("#C81E1E");
    expect(r.colors).toContain("#1E3CDC");
    expect(r.colors).toContain("#141414");
    // Dark → light by luminance.
    expect(r.colors[0]).toBe("#141414");
    // The dominant colour is the background.
    expect(["#C81E1E", "#1E3CDC"]).toContain(r.background);
    expect(r.weights.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 1);
  });

  it("merges near-identical clusters and is deterministic", () => {
    const px = [...fill([100, 100, 100], 500), ...fill([104, 102, 101], 500), ...fill([250, 250, 250], 200)];
    const one = extractPalette([px], { count: 6, seed: 3 });
    expect(one).toEqual(extractPalette([px], { count: 6, seed: 3 }));
    expect(one.colors.length).toBeLessThanOrEqual(2);
  });

  it("k-means sorts clusters by share; samplePixels skips transparent pixels", () => {
    const cl = kmeans([...fill([0, 0, 0], 30), ...fill([255, 255, 255], 70)], 2);
    expect(cl.map((c) => c.color)).toEqual(["#FFFFFF", "#000000"]);
    expect(cl[0].share).toBeCloseTo(0.7);
    const rgba = [10, 20, 30, 255, 1, 2, 3, 0];
    expect(samplePixels(rgba)).toEqual([[10, 20, 30]]);
    expect(extractPalette([[]])).toEqual({ colors: [], background: null, weights: [] });
  });

  it("validates, normalises and names palettes; random palettes have 2–12 colours", () => {
    expect(normalizeHex(" #abc ")).toBe("#AABBCC");
    expect(normalizeHex("12345g")).toBeNull();
    expect(paletteError({ name: "x", colors: [] })).toMatch(/at least one/);
    expect(paletteError({ name: "x", colors: Array(13).fill("#FFFFFF") })).toMatch(/up to 12/);
    expect(paletteError({ name: "x", colors: ["#GG0000"] })).toMatch(/isn't a color/);
    expect(paletteError({ name: "ok", colors: ["#FFFFFF"], background: "#000000" })).toBeNull();
    expect(cardStrip({ colors: ["#111111", "#222222", "#111111"], background: "#222222" })).toEqual(["#222222", "#111111"]);
    expect(paletteColors({ colors: ["#111111"], background: "#333333" })).toEqual(["#111111", "#333333"]);
    expect(suggestName(["#0A0A0A", "#123456"])).toMatch(/\w+ \w+/);
    for (const row of randomPalettes(rng(5))) {
      expect(row.length).toBeGreaterThanOrEqual(2);
      expect(row.length).toBeLessThanOrEqual(12);
      expect(row.every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
    }
  });
});

describe("palettes: the manual editor", () => {
  it("Use as background keeps the colour that loses the flag", () => {
    const start = { colors: ["#FFFFFF", "#D1FE17", "#1C1E20"], background: "#53C546" };
    const moved = withBackground(start, "#FFFFFF", true);
    expect(moved).toEqual({ colors: ["#FFFFFF", "#D1FE17", "#1C1E20", "#53C546"], background: "#FFFFFF" });
    // Turning the flag off leaves the colour in the palette.
    expect(withBackground(start, "#53C546", false)).toEqual({ colors: ["#FFFFFF", "#D1FE17", "#1C1E20", "#53C546"], background: null });
    // Off on a colour that isn't the background changes nothing; the 12-colour limit holds.
    expect(withBackground(start, "#FFFFFF", false)).toBe(start);
    const full = { colors: Array.from({ length: 12 }, (_, i) => `#0000${(i * 16).toString(16).padStart(2, "0").toUpperCase()}`), background: "#ABCDEF" };
    expect(withBackground(full, full.colors[0], true).colors).toHaveLength(12);
  });
});

describe("palettes: routing per model", () => {
  it("the Image studio can look up every model a signature routes to, without listing them in its picker", () => {
    const slice = studioCatalog(IMAGE_STUDIO);
    const listed = slice.models.map((m) => m.id);
    const known = new Set([...listed, ...(slice.lookup ?? []).map((m) => m.id)]);
    for (const id of Object.values(SIGNATURE_MODELS)) expect(known.has(id), id).toBe(true);
    // Edit-only and hidden routing targets stay out of the picker list (Krea 2 Style Reference is a text-to-image
    // model, listed already); their field maps stay on the server.
    for (const id of ["recraft-4-style", "recraft-4-style-saved", "oss-palette-image"]) expect(listed, id).not.toContain(id);
    expect(listed).toContain("oss-style-krea2");
    expect((slice.lookup ?? []).every((m) => m.routes.every((r) => !r.map))).toBe(true);
  });

  const req = (modelId: string, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ feature: "image", modelId, prompt: "a lighthouse at dusk", params: { numOutputs: 1 }, ...extra });

  it("sends the palette field to Recraft (≤10 colours, background in its own field) and Ideogram", () => {
    const r = applySignature(req("recraft-4-1"), { palette: PAL }, ctx);
    expect(r.request.params?.palette).toEqual(PAL.colors);
    expect(r.request.params?.extra?.background_color).toBe("#264653");
    expect(r.request.prompt).toBe("a lighthouse at dusk");
    const payload = buildPayload(getModel("recraft-4-1")!.routes[0].map!, { prompt: "x", palette: r.request.params!.palette, extra: r.request.params!.extra });
    expect(payload.colors).toEqual([{ r: 16, g: 32, b: 48 }, { r: 42, g: 157, b: 143 }, { r: 233, g: 196, b: 106 }, { r: 244, g: 162, b: 97 }]);
    expect(payload.background_color).toEqual({ r: 38, g: 70, b: 83 });

    const twelve = { ...PAL, colors: Array.from({ length: 12 }, (_, i) => `#0000${(i * 16).toString(16).padStart(2, "0").toUpperCase()}`) };
    const trimmed = applySignature(req("recraft-4-1"), { palette: twelve }, ctx);
    expect(trimmed.request.params?.palette).toHaveLength(10);
    expect(trimmed.notes.join()).toMatch(/takes 10 colors/);

    const ideo = applySignature(req("ideogram-3"), { palette: PAL }, ctx);
    expect(ideo.request.params?.palette).toEqual(PAL.colors);
    expect(ideo.request.params?.extra).toBeUndefined();
  });

  it("writes the hex list into the prompt for other cloud models (Nano Banana Pro, GPT Image)", () => {
    for (const id of ["nano-banana-pro", "imagen-4", "gpt-image-2-5"]) {
      const r = applySignature(req(id), { palette: PAL }, ctx);
      expect(r.modelId).toBe(id);
      // The user's words stay in the prompt; the server adds the palette sentence when it plans the run.
      expect(r.request.prompt).toBe("a lighthouse at dusk");
      expect(said(r)).toMatch(/^a lighthouse at dusk\. Color palette: use only these colors.*#102030.*background color #264653\.$/);
      expect(r.lock).toBeUndefined();
      expect(() => plan(r.request)).not.toThrow();
    }
  });

  it("gives Fuobe Cinema a built-in palette's colours in words: its slug is sent nowhere", () => {
    const r = applySignature({ feature: "video", modelId: "fuobe-cinema", engine: "cloud", prompt: "a chase" }, { palette: CINEMA_PAL }, ctx);
    expect(r.request.params?.extra?.color_palette).toBeUndefined();
    expect(r.request.prompt).toBe("a chase");
    expect(said(r)).toMatch(/^a chase\. Color palette: use only these colors/);
  });

  it("moves open Z-Image Turbo to Z-Image Turbo · Palette, and locks other open models with a post-step", () => {
    const r = applySignature(req("oss-z-image-turbo", { params: { aspectRatio: "16:9", resolution: "1K" } }), { palette: PAL }, ctx);
    expect(r.modelId).toBe("oss-zimage-palette");
    expect(r.request.params?.palette).toEqual([...PAL.colors, "#264653"]);
    expect(r.request.params?.aspectRatio).toBe("16:9");
    expect(r.notes[0]).toMatch(/Z-Image Turbo · Palette/);
    expect(plan(r.request).model.id).toBe("oss-zimage-palette");

    const free = applySignature(req("oss-qwen-image"), { palette: PAL }, ctx);
    expect(free.lock).toBeUndefined();
    expect(said(free)).toMatch(/Color palette/);
    const locked = applySignature(req("oss-qwen-image"), { palette: { ...PAL, lock: true } }, ctx);
    expect(locked.lock?.colors).toEqual([...PAL.colors, "#264653"]);
    expect(locked.notes).toEqual(["Then kept to the colors of “Teal Dusk” after it's made"]);
    // A guest or a free account never gets the lock (a run on the studio's own ComfyUI): the colors stay in the prompt.
    const visitor = applySignature(req("oss-qwen-image"), { palette: { ...PAL, lock: true } }, { ...ctx, visitor: true });
    expect(visitor.lock).toBeUndefined();
    expect(visitor.notes).toEqual([]);
    expect(said(visitor)).toMatch(/Color palette/);
  });

  it("leaves requests alone without a signature or an unknown model", () => {
    const r = req("nano-banana-pro");
    expect(applySignature(r, undefined, ctx).request).toBe(r);
    expect(applySignature({ ...r, modelId: "nope" }, { palette: PAL }, ctx).request.modelId).toBe("nope");
  });
});

describe("moodboards: routing per model", () => {
  const refs = Array.from({ length: 12 }, (_, i) => `/api/files/uploads/r${i}.png`);
  const board: MoodboardPick = { id: "mb1", kind: "personal", name: "Neon Haze", status: "complete", refs: refs.slice(0, 10), collages: ["/api/files/uploads/c1.jpg", "/api/files/uploads/c2.jpg"] };
  const curated: MoodboardPick = { id: CURATED_SETS["soul-v2"][0].id, kind: "curated", name: CURATED_SETS["soul-v2"][0].name, description: CURATED_SETS["soul-v2"][0].description, status: "complete" };
  const req = (modelId: string, images?: string[]): GenerationRequest => ({ feature: "image", modelId, prompt: "a rooftop party", inputs: images ? { images } : undefined, params: { numOutputs: 1 } });

  it("curated looks are Fuobe Soul looks: the look itself on Fuobe Soul, its words elsewhere", () => {
    const soul = applySignature(req("fuobe-soul"), { moodboard: curated }, ctx);
    expect(soul.request.presetId).toBe("v2-general");
    expect(soul.request.prompt).toBe("a rooftop party");
    expect(soul.request.signature?.words).toBeUndefined();
    expect(soul.notes).toEqual([]);
    // A partner model gets the words, and a hint where the look runs whole.
    const nano = applySignature(req("nano-banana-pro"), { moodboard: curated }, ctx);
    expect(nano.request.params?.extra?.style_id).toBeUndefined();
    expect(nano.notes[0]).toMatch(/General is a Fuobe Soul look — described in words on Nano Banana Pro .*Fuobe Soul applies it with its LoRAs/);
    const open = applySignature(req("oss-z-image-turbo"), { moodboard: curated }, ctx);
    expect(open.modelId).toBe("oss-z-image-turbo");
    expect(open.request.prompt).toBe("a rooftop party");
    expect(said(open)).toBe(lookPrompt({ name: curated.name, description: curated.description! }, "a rooftop party"));
  });

  it("personal boards: style references on multi-reference cloud models, Nano Banana Pro for the rest", () => {
    const nano = applySignature(req("nano-banana-pro", ["/api/files/uploads/own.png"]), { moodboard: board }, ctx);
    expect(nano.request.op).toBe("edit");
    expect(nano.request.inputs?.images).toEqual(["/api/files/uploads/own.png", ...refs.slice(0, 6)]);
    expect(said(nano)).toMatch(/Use images 2–7 only as a style reference/);
    expect(plan(nano.request).op).toBe("edit");

    const imagen = applySignature(req("imagen-4"), { moodboard: board }, ctx);
    expect(imagen.modelId).toBe("nano-banana-pro");
    expect(imagen.notes[0]).toMatch(/can't take style references/);
    expect(imagen.request.inputs?.images).toHaveLength(6);
  });

  it("Recraft models use the board's saved style id, or its 10 images on Recraft V4 Styles", () => {
    const saved = applySignature(req("recraft-4-1"), { moodboard: { ...board, styleId: "3f6c1a2b-0000-4000-8000-000000000000" } }, ctx);
    expect(saved.modelId).toBe("recraft-4-style-saved");
    expect(saved.request.params?.styleId).toBe("3f6c1a2b-0000-4000-8000-000000000000");
    const p = plan(saved.request);
    expect(p.op).toBe("t2i");
    expect(buildPayload(p.model.routes[0].map!, { prompt: p.prompt, styleId: p.params.styleId })).toMatchObject({ prompt: "a rooftop party", style_id: "3f6c1a2b-0000-4000-8000-000000000000" });

    const fresh = applySignature(req("recraft-4-1"), { moodboard: board }, ctx);
    expect(fresh.modelId).toBe("recraft-4-style");
    expect(fresh.request.inputs?.images).toEqual(refs.slice(0, 10));
    expect(plan(fresh.request).op).toBe("edit");
  });

  it("open engine: collages on Krea 2 Style Reference, single refs on FLUX.2 klein, the trained LoRA on Z-Image Turbo", () => {
    const def = applySignature(req("oss-z-image-turbo"), { moodboard: board }, ctx);
    expect(def.modelId).toBe("oss-style-krea2");
    expect(def.request.inputs?.images).toEqual(board.collages);
    expect(() => plan(def.request)).not.toThrow();
    // The 2511 style graph still runs a board when it is picked.
    expect(applySignature(req("oss-style-qwen-edit"), { moodboard: board }, ctx).modelId).toBe("oss-style-qwen-edit");

    const klein = applySignature(req("oss-style-flux2-klein"), { moodboard: board }, ctx);
    expect(klein.modelId).toBe("oss-style-flux2-klein");
    expect(klein.request.inputs?.images).toEqual(refs.slice(0, 4));

    const lora = applySignature(req("oss-z-image-turbo"), { moodboard: { ...board, loraHandle: "Neon_Haze" } }, ctx);
    expect(lora.modelId).toBe("oss-z-image-turbo");
    expect(said(lora)).toBe("a rooftop party. In the style of @Neon_Haze.");
  });

  it("Soul's 106 looks are curated picks too: the look on Fuobe Soul, words everywhere else", () => {
    expect(SOUL_STYLES).toHaveLength(106);
    expect(CURATED_TABS["soul-v1"]).toEqual(["All presets", "New", "TikTok Core", "Instagram Aesthetics", "Camera Presets", "Beauty", "Mood", "Surreal", "Graphic Art"]);
    // Soul's looks sit in several categories at once.
    const sunset = SOUL_STYLES.find((s) => s.name === "Sunset beach")!;
    expect(sunset.id).toBe("v1-sunset-beach");
    expect(["New", "Camera Presets", "Beauty"].every((c) => inCuratedTab(sunset, c))).toBe(true);
    const pick = curatedPick(sunset);
    expect(pick.source).toBe("soul-v1");
    expect(soulPick(sunset.id)).toEqual(pick);
    // A pick saved with the retired provider's old style id reads as its Fuobe look.
    const oldGeneral = Object.entries(SOUL_LEGACY_IDS).find(([, id]) => id === "v2-general")![0];
    expect(soulPick(oldGeneral)?.id).toBe("v2-general");
    expect(soulPick("not-a-preset")).toBeUndefined();

    const soul = applySignature(req("fuobe-soul"), { moodboard: pick }, ctx);
    expect(soul.request.presetId).toBe("v1-sunset-beach");
    const turbo = applySignature(req("oss-z-image-turbo"), { moodboard: pick }, ctx);
    expect(said(turbo)).toBe(lookPrompt(sunset, "a rooftop party"));
  });

  it("curated sets are Fuobe's own looks: Fuobe ids and words, no Higgsfield description or preview", () => {
    const base = CURATED_SETS["soul-v2"];
    expect(base).toHaveLength(33);
    expect(base.every((c) => c.id.startsWith("v2-") && !c.preview)).toBe(true);
    const theirs = new Map(SOUL_RESEARCH.filter((p) => p.model === "soul-v2").map((p) => [p.name, p.description]));
    expect(base.every((c) => c.description !== theirs.get(c.name))).toBe(true);
  });

  it("an older run that kept the sentences in its prompt isn't styled twice; Run again doesn't add the board twice", () => {
    const once = applySignature(req("oss-z-image-turbo"), { moodboard: curated, palette: PAL }, ctx);
    const legacy = { ...req(once.modelId), prompt: said(once), inputs: once.request.inputs };
    const twice = applySignature(legacy, { moodboard: curated, palette: PAL }, ctx);
    expect(said(twice)).toBe(said(once));
    const nano = applySignature(req("nano-banana-pro"), { moodboard: board }, ctx);
    const again = applySignature({ ...nano.request, op: undefined, signature: undefined }, { moodboard: board }, ctx);
    expect(again.request.inputs?.images).toEqual(nano.request.inputs?.images);
  });

  it("a look goes native on every model that takes looks; Fuobe Soul Cinema (one fixed look) gets words", () => {
    const style = SOUL_STYLES[0];
    const pick = curatedPick(style);
    const cinema = applySignature(req("fuobe-soul-cinema"), { moodboard: pick }, ctx);
    expect(cinema.request.presetId).toBeUndefined();
    expect(cinema.notes[0]).toBe(`Fuobe Soul Cinema has one fixed look — ${style.name} is described in words`);
    expect(said(cinema)).toMatch(/In the style of/);
    const hd = applySignature(req("fuobe-soul-hd"), { moodboard: pick }, ctx);
    expect(hd.request.presetId).toBe(style.id);
    expect(hd.request.signature?.words).toBeUndefined();
    expect(hd.notes).toEqual([]);
  });

  it("Recraft V4 Styles keeps your own images first and fills up to 10 with the board's", () => {
    const own = ["/api/files/uploads/mine.png"];
    const r = applySignature(req("recraft-4-1", own), { moodboard: board }, ctx);
    expect(r.modelId).toBe("recraft-4-style");
    expect(r.request.inputs?.images).toEqual([...own, ...refs.slice(0, 9)]);
    expect(r.notes.join()).toMatch(/Your image is used as style references too/);
  });

  it("a board that isn't ready blocks with Higgsfield's copy; palette + moodboard combine", () => {
    expect(applySignature(req("nano-banana-pro"), { moodboard: { ...board, status: "running" } }, ctx).blocker).toBe("This moodboard is still training. Try again once it is ready.");
    const both = applySignature(req("oss-z-image-turbo"), { moodboard: board, palette: PAL }, ctx);
    // The moodboard moves it to the style model, which then gets the palette in words (not the palette model).
    expect(both.modelId).toBe("oss-style-krea2");
    expect(said(both)).toMatch(/Color palette/);
  });
});

describe("style signature: the request record and Reuse", () => {
  const req = (modelId: string, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ feature: "image", modelId, prompt: "a lighthouse at dusk", params: { numOutputs: 1, aspectRatio: "16:9" }, ...extra });
  const board: MoodboardPick = { id: "mb1", kind: "personal", name: "Neon Haze", status: "complete", refs: ["/api/files/uploads/r1.png", "/api/files/uploads/r2.png"], collages: [] };

  it("keeps the user's words in the prompt and the sentences in signature.words (titles and Reuse show the words)", () => {
    const r = applySignature(req("nano-banana-pro"), { palette: PAL }, ctx);
    expect(r.request.prompt).toBe("a lighthouse at dusk");
    expect(r.request.signature?.words).toMatch(/^Color palette: use only these colors/);
    expect(r.request.signature?.palette).toEqual(PAL);
    expect(r.request.signature?.from).toEqual({ modelId: "nano-banana-pro", params: { numOutputs: 1, aspectRatio: "16:9" }, images: 0 });
    // The server plans it with the sentences.
    expect(plan(withSignatureWords(r.request)).prompt).toMatch(/^a lighthouse at dusk\. Color palette/);
    // Without words there's nothing to add.
    const plain = req("nano-banana-pro");
    expect(withSignatureWords(plain)).toBe(plain);
  });

  it("Reuse of a Recraft palette run: Recraft V4.1 without the hidden palette fields, the palette back on the chip", () => {
    const r = applySignature(req("recraft-4-1"), { palette: PAL }, ctx);
    expect(r.request.params?.palette).toHaveLength(4);
    const back = reuseSignature(r.request)!;
    expect(back.modelId).toBe("recraft-4-1");
    expect(back.params).toEqual({ numOutputs: 1, aspectRatio: "16:9" });
    expect(back.params.extra?.background_color).toBeUndefined();
    expect(back.signature).toEqual({ palette: PAL });
    // Applying the restored chip again gives the same run.
    const again = applySignature({ ...req(back.modelId), params: back.params }, back.signature, ctx);
    expect(again.request.params).toEqual(r.request.params);
  });

  it("Reuse of an open Z-Image palette run goes back to Z-Image Turbo (not the hidden Palette model)", () => {
    const r = applySignature(req("oss-z-image-turbo"), { palette: PAL }, ctx);
    expect(r.modelId).toBe("oss-zimage-palette");
    const back = reuseSignature(r.request)!;
    expect(back.modelId).toBe("oss-z-image-turbo");
    expect(back.params.palette).toBeUndefined();
    expect(back.signature.palette?.id).toBe("p1");
  });

  it("Reuse of a moodboard run keeps only your own images and the board on the chip; Soul's style id too", () => {
    const own = "/api/files/uploads/own.png";
    const r = applySignature(req("nano-banana-pro", { inputs: { images: [own] } }), { moodboard: board }, ctx);
    expect(r.request.inputs?.images).toEqual([own, ...board.refs!]);
    const back = reuseSignature(r.request)!;
    expect(back.images).toEqual([own]);
    expect(back.signature.moodboard?.id).toBe("mb1");

    const look = curatedPick(CURATED_SETS["soul-v2"][3]);
    const soul = applySignature(req("fuobe-soul"), { moodboard: look }, ctx);
    expect(soul.request.presetId).toBe(look.id);
    const soulBack = reuseSignature(soul.request)!;
    expect(soulBack.params.extra).toBeUndefined();
    expect(soulBack.signature.moodboard).toEqual(look);
    // A run without a signature isn't touched.
    expect(reuseSignature(req("fuobe-soul"))).toBeNull();
  });
});

describe("Soul's old style ids", () => {
  it("open their Fuobe look, one way: all 139 from the research, and nothing else", () => {
    expect(SOUL_RESEARCH).toHaveLength(139);
    for (const p of SOUL_RESEARCH) expect(lookCard(p.id)?.id, p.name).toMatch(p.model === "soul-v1" ? /^v1-/ : /^v2-/);
    expect(Object.keys(SOUL_LEGACY_IDS)).toHaveLength(139);
    expect(lookCard("not-a-style")).toBeUndefined();
  });
});

describe("Photodump packs and planning", () => {
  const maya: PhotoSubject = { kind: "element", handle: "Maya", name: "Maya", references: ["/api/files/uploads/m1.png", "/api/files/uploads/m2.png"], loras: [] };
  const selfie: PhotoSubject = { kind: "selfie", url: "/api/files/uploads/me.jpg" };

  it("has exactly as many photo prompts as Higgsfield's packs have photos", () => {
    expect(PACKS).toHaveLength(14);
    for (const p of PACKS) {
      expect(p.shots, p.name).toHaveLength(p.count);
      expect(new Set(p.shots).size, p.name).toBe(p.count);
    }
    expect(PHOTODUMP_PACKS.filter((p) => p.product === "instadump").map((p) => [p.name, p.count])).toEqual([
      ["Winter special", 9],
      ["Aura farming", 14],
      ["Looksmaxing", 15],
      ["2000s nostalgia", 15],
      ["Editorial shots", 15],
    ]);
  });

  it("builds per-photo prompts: @mention for a character, image 1 for a selfie, the reference photo in user packs", () => {
    const pack = getPack("zen")!;
    expect(shotPrompt(pack, pack.shots[0], maya)).toMatch(/^A photo of @Maya, seated cross-legged/);
    expect(shotPrompt(pack, pack.shots[0], selfie)).toMatch(/^A photo of the person in image 1, .*Keep their exact face/);
    const mine = customPack({ id: "user-1", name: "Mine", refs: ["/api/files/uploads/a.png", "/api/files/uploads/b.png"] });
    expect(mine.count).toBe(2);
    expect(shotPrompt(mine, mine.shots[0], selfie, 2)).toMatch(/^The person in image 1 recreated in image 2: .*Replace the person in image 2/);
  });

  it("plans one single-image request per photo, on the identity's own model when it has one", () => {
    const pack = getPack("winter-special")!;
    const cloud = planPhotodump({ pack, subject: maya, engine: "cloud", aspectRatio: "3:4" }, {});
    // Before a Soul ID: Instadump's Original, Qwen-Image-Edit 2511 hosted, with the character's photos (build plan O10).
    expect(cloud.modelId).toBe("qwen-image-edit-2511-cloud");
    expect(planPhotodump({ pack, subject: maya, engine: "cloud", modelId: "nano-banana-pro" }, {}).modelId).toBe("nano-banana-pro");
    expect(planPhotodump({ pack, subject: maya, engine: "cloud", modelId: "seedream-5-pro" }, {}).modelId).toBe("seedream-5-pro");
    expect(cloud.requests).toHaveLength(9);
    expect(cloud.requests[2].step).toEqual({ label: "Photo 3 of 9", index: 2, of: 9 });
    expect(cloud.requests.every((r) => r.params?.numOutputs === 1 && r.params.aspectRatio === "3:4" && r.feature === "photodump")).toBe(true);

    // A trained Soul ID (build plan O3): Fuobe Soul with the character's LoRA on either engine; Higgsfield's is gone.
    const soulMaya: PhotoSubject = { ...maya, loras: [{ engine: "cloud", modelId: "fuobe-soul", family: "z-image-turbo", file: "fuobe/maya-a1.safetensors", url: "https://v3.fal.media/maya.safetensors", own: true, trigger: "mayfz" }] };
    for (const engine of ["cloud", "open"] as const) {
      const run = planPhotodump({ pack, subject: soulMaya, engine }, {});
      expect(run.modelId).toBe("fuobe-soul");
      expect(run.requests.every((r) => r.engine === engine)).toBe(true);
    }
    const oldSoulId: PhotoSubject = { ...maya, loras: [{ engine: "cloud", modelId: "soul-2", file: "", trigger: "", referenceId: "ref-123" }] };
    expect(planPhotodump({ pack, subject: oldSoulId, engine: "cloud" }, {}).modelId).toBe("qwen-image-edit-2511-cloud");
    const untrained = planPhotodump({ pack, subject: maya, engine: "cloud", modelId: "fuobe-soul" }, {});
    expect(untrained.modelId).toBe("qwen-image-edit-2511-cloud");
    expect(untrained.notes[0]).toMatch(/No Soul ID yet/);
    expect(planPhotodump({ pack, subject: soulMaya, engine: "cloud", modelId: "seedream-5-pro" }, {}).modelId).toBe("seedream-5-pro");
    expect(planPhotodump({ pack, subject: maya, engine: "cloud", modelId: "seedream-5-pro" }, {}).modelId).toBe("seedream-5-pro");

    // A LoRA trained before O3 for plain Z-Image Turbo is the same family: it runs on Fuobe Soul too.
    const loraMaya: PhotoSubject = { ...maya, loras: [{ engine: "open", modelId: "oss-z-image-turbo", file: "maya.safetensors", trigger: "mayfz" }] };
    expect(planPhotodump({ pack, subject: loraMaya, engine: "open" }, {}).modelId).toBe("fuobe-soul");
    // A GPU-only LoRA (no copy Fuobe can send) stays off the cloud: reference photos there.
    expect(planPhotodump({ pack, subject: loraMaya, engine: "cloud" }, {}).modelId).toBe("qwen-image-edit-2511-cloud");
    const qwen = planPhotodump({ pack, subject: selfie, engine: "open", aspectRatio: "auto" }, {});
    expect(qwen.modelId).toBe("oss-qwen-image-21");
    expect(qwen.requests[0].inputs?.images).toEqual([selfie.url]);
    expect(qwen.requests[0].params?.aspectRatio).toBeUndefined();

    const mine = customPack({ id: "user-1", name: "Mine", refs: ["/api/files/uploads/a.png", "/api/files/uploads/b.png"] });
    const custom = planPhotodump({ pack: mine, subject: selfie, engine: "cloud" }, {});
    expect(custom.requests.map((r) => r.inputs?.images)).toEqual([
      [selfie.url, "/api/files/uploads/a.png"],
      [selfie.url, "/api/files/uploads/b.png"],
    ]);
    expect(custom.requests[0].prompt).toMatch(/^The person in image 1 recreated in image 2: .*Replace the person in image 2 with them/);
    // Krea 2 Identity Edit reads the scene first and the person last (its likeness boost is on the last picture).
    const krea = planPhotodump({ pack: mine, subject: selfie, engine: "open", modelId: "oss-krea2-identity-edit" }, {});
    expect(krea.modelId).toBe("oss-krea2-identity-edit");
    expect(krea.requests.map((r) => r.inputs?.images)).toEqual([
      ["/api/files/uploads/a.png", selfie.url],
      ["/api/files/uploads/b.png", selfie.url],
    ]);
    expect(krea.requests[0].prompt).toMatch(/^The person in image 2 recreated in image 1: .*Replace the person in image 1 with them/);
    // A pack of Fuobe's own has only the selfie: image 1 on every model.
    const kreaOwn = planPhotodump({ pack, subject: selfie, engine: "open", modelId: "oss-krea2-identity-edit" }, {});
    expect(kreaOwn.requests[0].inputs?.images).toEqual([selfie.url]);
    expect(kreaOwn.requests[0].prompt).toContain("the person in image 1");
    // A saved character goes in as one photo of theirs (two pictures would read as two people), after a pack's reference.
    const kreaMaya = planPhotodump({ pack, subject: maya, engine: "open", modelId: "oss-krea2-identity-edit" }, {});
    expect(kreaMaya.requests[0].inputs?.images).toEqual(["/api/files/uploads/m1.png"]);
    expect(kreaMaya.requests[0].prompt).not.toContain("@Maya");
    const kreaMayaMine = planPhotodump({ pack: mine, subject: maya, engine: "open", modelId: "oss-krea2-identity-edit" }, {});
    expect(kreaMayaMine.requests[0].inputs?.images).toEqual(["/api/files/uploads/a.png", "/api/files/uploads/m1.png"]);
    expect(kreaMayaMine.requests[0].prompt).toMatch(/^The person in image 2 recreated in image 1: /);
    // Other models still @mention the character (the server attaches their photos or Soul ID).
    expect(planPhotodump({ pack, subject: maya, engine: "open" }, {}).requests[0].prompt).toContain("@Maya");
    expect(() => planPhotodump({ pack, subject: { ...maya, references: [] }, engine: "cloud" }, {})).toThrow(/Add a photo of Maya/);
  });

  it("each planned photo resolves and plans (mentions become references, LoRAs or a Soul ID)", () => {
    const el = (loras: StudioElement["loras"]): StudioElement => ({ id: "e1", name: "Maya", handle: "Maya", kind: "character", description: null, references: ["/api/files/uploads/m1.png"], loras, status: "ready", createdAt: 0 });
    const check = (subject: PhotoSubject, engine: "cloud" | "open", element: StudioElement) => {
      const p = planPhotodump({ pack: getPack("zen")!, subject, engine, aspectRatio: "3:4" }, {});
      const r = p.requests[0];
      const resolved = applyMentions(r, getModel(r.modelId)!, [element]).request;
      return { resolved, plan: plan(resolved) };
    };
    const refs = check(maya, "cloud", el([]));
    expect(refs.plan.op).toBe("edit");
    expect(refs.resolved.inputs?.images).toEqual(["/api/files/uploads/m1.png"]);
    // The Soul ID's LoRA on Fuobe Soul, first in its slots, on the engine the run asked for.
    const trained = [{ engine: "cloud" as const, modelId: "fuobe-soul", family: "z-image-turbo" as const, file: "fuobe/maya-a1.safetensors", url: "https://v3.fal.media/maya.safetensors", own: true as const, trigger: "mayfz" }];
    for (const engine of ["cloud", "open"] as const) {
      const p = planPhotodump({ pack: getPack("zen")!, subject: { ...maya, loras: trained }, engine, aspectRatio: "3:4" }, {});
      const r = p.requests[0];
      const model = onEngine(getModel(r.modelId)!, r.engine!);
      const resolved = applyMentions(r, model, [el(trained)]).request;
      const planned = planGeneration(resolved, (id) => (id === model.id ? model : getModel(id)), getPreset);
      expect(planned.model).toMatchObject({ id: "fuobe-soul", engine });
      expect(planned.loras[0]).toMatchObject({ file: "fuobe/maya-a1.safetensors", own: true });
      expect(planned.prompt).toMatch(/mayfz Maya/);
      expect(resolved.inputs?.images).toBeUndefined();
    }
  });
});

describe("Photodump: model choice and retries", () => {
  const selfie: PhotoSubject = { kind: "selfie", url: "/api/files/uploads/me.png" };

  it("says why a pick that can't run ends up on another model", () => {
    expect(photodumpModel(selfie, "open", {}, "fuobe-soul")).toEqual({ modelId: "oss-qwen-image-21", note: "Fuobe Soul needs a character with a trained Soul ID — Qwen-Image 2.1 works from your photo" });
    // Your GPU's choices after Fuobe Soul: Qwen-Image 2.1, Krea 2 Identity Edit and Qwen-Image 2.1 Turbo.
    expect(PHOTODUMP_MODELS.open).toEqual(["fuobe-soul", "oss-qwen-image-21", "oss-krea2-identity-edit", "oss-qwen-image-21-turbo"]);
    expect(PHOTODUMP_MODELS.cloud).toEqual(["fuobe-soul", "qwen-image-edit-2511-cloud", "nano-banana-pro", "nano-banana-2-1", "seedream-5-pro"]);
    expect(photodumpModel(selfie, "open", {}, "oss-krea2-identity-edit").modelId).toBe("oss-krea2-identity-edit");
    expect(photodumpModel(selfie, "open", {}, "oss-qwen-image-21-turbo").modelId).toBe("oss-qwen-image-21-turbo");
    expect(photodumpModel(selfie, "cloud", {}, "nano-banana-2-1").modelId).toBe("nano-banana-2-1");
    // A pick of Qwen-Image-Edit 2511 saved before runs on Qwen-Image 2.1.
    expect(photodumpModel(selfie, "open", {}, "oss-qwen-edit").modelId).toBe("oss-qwen-image-21");
    expect(photodumpModel(selfie, "open", {}, "fuobe-soul", true).note).toBe("Your own packs recreate each reference photo — Qwen-Image 2.1 runs them");
    expect(photodumpModel(selfie, "cloud", {}, "fuobe-soul")).toEqual({ modelId: "qwen-image-edit-2511-cloud", note: "Fuobe Soul needs a character with a trained Soul ID — Qwen-Image-Edit 2511 works from your photo" });
    expect(photodumpModel(selfie, "cloud", {}, "nano-banana-pro").modelId).toBe("nano-banana-pro");
    expect(photodumpModel(selfie, "cloud", {}).modelId).toBe("qwen-image-edit-2511-cloud");
    expect(photodumpModel(selfie, "open", {}, "fuobe-soul", true).note).toMatch(/Your own packs recreate each reference photo/);
    expect(photodumpModel(selfie, "open", {}).note).toBeUndefined();
    // An account's own character (its photo, no Soul ID) picked with Fuobe Soul: the run says what makes its photos,
    // with no step it couldn't take.
    const mine: PhotoSubject = { kind: "selfie", url: "/api/files/accounts/a/maya.png", name: "Maya" };
    expect(photodumpModel(mine, "cloud", {}, "fuobe-soul")).toEqual({ modelId: "qwen-image-edit-2511-cloud", note: "Qwen-Image-Edit 2511 makes Maya's photos from their saved photo, keeping their face" });
    expect(photodumpModel(mine, "open", {}, "fuobe-soul").note).not.toMatch(/Elements|trained|train/);
    // A demo training's stand-in isn't a Soul ID.
    const demo: PhotoSubject = { kind: "element", handle: "Maya", name: "Maya", references: ["/a.png"], loras: [{ engine: "cloud", modelId: "fuobe-soul", family: "z-image-turbo", file: "fuobe/x.safetensors", trigger: "t", demo: true }] };
    expect(photodumpModel(demo, "open", {}).modelId).toBe("oss-qwen-image-21");
  });

  it("a retried base shot or outfit takes the failed one's place in the wizard", () => {
    let s: FashionState = { ...FASHION_START, step: "generation", templateId: "red-room", elementId: "el1", baseIds: ["g1", "g2"], outfitIds: ["o1"] };
    s = fashionReducer(s, { type: "retried", from: "g2", to: ["g3"] });
    expect(s.baseIds).toEqual(["g1", "g3"]);
    s = fashionReducer(s, { type: "retried", from: "o1", to: ["o2", "o3"] });
    expect(s.outfitIds).toEqual(["o2", "o3"]);
    expect(fashionReducer(s, { type: "retried", from: "nope", to: ["x"] })).toBe(s);
  });
});

describe("Fashion Factory", () => {
  const maya = { kind: "element" as const, handle: "Maya", name: "Maya", references: ["/api/files/uploads/m1.png"], loras: [] };

  it("has the six templates with one photoset prompt per preview shot", () => {
    expect(FASHION.map((t) => t.name)).toEqual(["Ultra bold", "Blue-Green Gradient", "Street style Paparazzi", "View from the top", "Light blue studio", "Red room"]);
    for (const t of FASHION) expect(t.photoset, t.name).toHaveLength(t.shots);
  });

  it("plans the three generating steps on both engines", () => {
    const t = FASHION[0];
    const base = fashionBaseRequest(t, maya, "cloud", {});
    // No Soul ID yet: Qwen-Image-Edit 2511 from the character's photos (with one, Fuobe Soul and the LoRA).
    expect(base).toMatchObject({ modelId: "qwen-image-edit-2511-cloud", params: { aspectRatio: "3:4", numOutputs: 4 } });
    expect(base.prompt).toMatch(/@Maya in a bold, saturated colour-blocked studio set/);
    expect(fashionBaseRequest(t, maya, "open", {}).modelId).toBe("oss-qwen-image-21");

    // Fuobe Try-On on both engines (FLUX.2 [klein] 4B + the try-on LoRA); FASHN and Nano Banana Pro stay cloud choices.
    const outfit = fashionOutfitRequest(t, "/api/files/base.png", "/api/files/shirt.png", "cloud");
    expect(outfit).toMatchObject({ modelId: "fuobe-tryon", engine: "cloud", op: "edit", inputs: { images: ["/api/files/base.png", "/api/files/shirt.png"] } });
    const cloudPlan = planGeneration(outfit, (id) => (id === "fuobe-tryon" ? onEngine(getModel(id)!, "cloud") : getModel(id)), getPreset);
    expect(cloudPlan.op).toBe("edit");
    expect(cloudPlan.prompt).toMatch(/^TRYON a full-body photo of a person\. Replace the outfit/);
    expect(cloudPlan.loras).toEqual([expect.objectContaining({ file: "tryon-klein-4b.safetensors", strength: 1, licence: expect.objectContaining({ commercial: true, hostedOk: true }) })]);
    expect(cloudPlan.loras[0].url).toMatch(/^https:\/\/huggingface\.co\/xocialize\/tryon-FLUX\.2-klein-4B-lora\/resolve\/[0-9a-f]{40}\/tryon-klein-4b\.safetensors$/);
    expect(fashionOutfitRequest(t, "b", "g", "cloud", "fashn-tryon").modelId).toBe("fashn-tryon");
    expect(fashionOutfitRequest(t, "b", "g", "cloud", "nano-banana-pro").prompt).toMatch(/Dress the person in image 1/);
    const openOutfit = fashionOutfitRequest(t, "/api/files/base.png", "/api/files/shirt.png", "open");
    expect(openOutfit).toMatchObject({ modelId: "fuobe-tryon", engine: "open" });
    // A partner pick means nothing on the user's GPU.
    expect(fashionOutfitRequest(t, "b", "g", "open", "fashn-tryon").modelId).toBe("fuobe-tryon");
    const openPlan = planGeneration(openOutfit, (id) => (id === "fuobe-tryon" ? onEngine(getModel(id)!, "open") : getModel(id)), getPreset);
    expect(openPlan.model.routes).toEqual([expect.objectContaining({ provider: "comfyui", endpoint: "tryon-flux2-klein-4b" })]);

    const set = fashionPhotosetRequests(t, "/api/files/dressed.png", "cloud");
    expect(set).toHaveLength(t.shots);
    expect(set[0]).toMatchObject({ modelId: "qwen-image-edit-2511-cloud", inputs: { images: ["/api/files/dressed.png"] }, step: { label: `Photoset 1 of ${t.shots}` } });
    expect(fashionPhotosetRequests(t, "/api/files/dressed.png", "cloud", "nano-banana-pro")[0].modelId).toBe("nano-banana-pro");
    expect(fashionPhotosetRequests(t, "/api/files/dressed.png", "open")[0].modelId).toBe("oss-qwen-image-21");
    expect(fashionPhotosetRequests(t, "/api/files/dressed.png", "open", "oss-krea2-identity-edit")[0].modelId).toBe("oss-krea2-identity-edit");
    // A pick the step no longer lists falls back to its first model.
    expect(fashionPhotosetRequests(t, "/api/files/dressed.png", "open", "oss-qwen-edit")[0].modelId).toBe("oss-qwen-image-21");
    // When the try-on can't run on your GPU: Qwen-Image 2.1 Turbo, then Qwen-Image 2.1, both dressing from image 2. Krea 2
    // Identity Edit makes the photoset only: it takes a second picture as a person, and the outfit step's is a garment.
    expect(FASHION_MODELS.outfit.open).toEqual(["fuobe-tryon", "oss-qwen-image-21-turbo", "oss-qwen-image-21"]);
    expect(FASHION_MODELS.photoset.open).toEqual(["oss-qwen-image-21", "oss-krea2-identity-edit"]);
    expect(fashionOutfitRequest(t, "/api/files/base.png", "/api/files/shirt.png", "open", undefined, { has: (id) => id !== "fuobe-tryon" }).modelId).toBe("oss-qwen-image-21-turbo");
    const dressed = fashionOutfitRequest(t, "/api/files/base.png", "/api/files/shirt.png", "open", "oss-qwen-image-21");
    expect(dressed).toMatchObject({ modelId: "oss-qwen-image-21", op: "edit", inputs: { images: ["/api/files/base.png", "/api/files/shirt.png"] } });
    expect(() => plan(dressed)).not.toThrow();
    expect(fashionOutfitRequest(t, "b", "g", "open", "oss-krea2-identity-edit").modelId).toBe("fuobe-tryon");
  });

  it("walks the wizard with Higgsfield's validation messages", () => {
    let s: FashionState = FASHION_START;
    expect(fashionBlocker(s)).toBe("Template required");
    expect(fashionReducer(s, { type: "next" })).toBe(s);
    s = fashionReducer(s, { type: "template", id: "red-room" });
    s = fashionReducer(s, { type: "next" });
    expect(s.step).toBe("character");
    expect(fashionBlocker(s)).toMatch(/character/);
    s = fashionReducer(s, { type: "element", id: "el1" });
    s = fashionReducer(s, { type: "baseStarted", ids: ["g1", "g2"] });
    expect(s.step).toBe("generation");
    expect(fashionBlocker(s)).toBe("Select an image at the generation step");
    s = fashionReducer(s, { type: "pickBase", url: "/api/files/b.png" });
    s = fashionReducer(s, { type: "next" });
    expect(s.step).toBe("clothing");
    expect(fashionBlocker(s, "outfit")).toBe("No product to generate");
    s = fashionReducer(s, { type: "garment", garment: { url: "", uploading: true } });
    expect(fashionBlocker(s, "outfit")).toBe("Please wait for the image to finish processing before generating");
    s = fashionReducer(s, { type: "garment", garment: { url: "/api/files/g.png", uploading: false } });
    expect(fashionBlocker(s, "outfit")).toBeNull();
    expect(fashionBlocker(s)).toBe("Select an image at the clothing step");
    s = fashionReducer(s, { type: "outfitStarted", ids: ["o1"] });
    s = fashionReducer(s, { type: "pickOutfit", url: "/api/files/o.png" });
    s = fashionReducer(s, { type: "photosetStarted", batchId: "b1" });
    expect(s.step).toBe("photoset");
    // Back to an earlier step keeps the picks; a new template starts over (but keeps the character).
    expect(fashionReducer(s, { type: "goto", step: "template" }).outfit).toBe("/api/files/o.png");
    const fresh = fashionReducer(s, { type: "template", id: "ultra-bold" });
    expect(fresh).toMatchObject({ step: "template", templateId: "ultra-bold", elementId: "el1", baseIds: [] });
    expect(fresh.outfit).toBeUndefined();
    // Jumping ahead stops at the first step that isn't done.
    expect(fashionReducer({ ...FASHION_START, templateId: "red-room" }, { type: "goto", step: "photoset" }).step).toBe("character");
    expect(fashionReducer(s, { type: "reset" })).toBe(FASHION_START);
  });
});

describe("apps on the newer tools", () => {
  it("Upscale on SeedVR2 (image) on your GPU, the avatar apps on Kling Avatar 2.0, and the sound note says which clips are silent", () => {
    expect(getPreset("app-upscale")!.open).toMatchObject({ modelId: "oss-seedvr2-image", op: "upscale-image" });
    for (const id of ["app-talking-photo", "app-asmr-host", "app-asmr-promo"]) {
      expect(getPreset(id)!.cloud, id).toMatchObject({ modelId: "kling-avatar-2", op: "avatar" });
    }
    // Kling Avatar 2.0 takes what Kling AI Avatar took: the portrait and the voice.
    const map = (id: string) => getModel(id)!.routes.find((r) => r.op === "avatar")!.map;
    expect(map("kling-avatar-2")).toEqual(map("kling-avatar"));
    expect(getPreset("app-asmr-classic")!.parity).toBe("This makes a silent clip. Add sound with Video to audio.");
  });
});

describe("Character Sheet", () => {
  it("From Reference takes 1–5 photos (4 on the open route, Qwen-Image 2.1)", () => {
    const imgs = Array.from({ length: 5 }, (_, i) => `/api/files/uploads/p${i}.png`);
    expect(() => sheetFromReference([], "cloud")).toThrow("Upload at least 1 image");
    expect(() => sheetFromReference([...imgs, "x"], "cloud")).toThrow("Maximum 5 images");
    const cloud = sheetFromReference(imgs, "cloud", "freckles");
    expect(cloud.request).toMatchObject({ modelId: "nano-banana-pro", op: "edit", inputs: { images: imgs } });
    expect(cloud.request.prompt).toMatch(/turnaround sheet.*freckles\.$/);
    const open = sheetFromReference(imgs, "open");
    // Qwen-Image 2.1 at 25 steps: a sheet is camera turns, which its Turbo misses.
    expect(open.request).toMatchObject({ modelId: "oss-qwen-image-21", op: "edit" });
    expect(open.request.inputs?.images).toEqual(imgs.slice(0, 4));
    expect(open.notes[0]).toBe("Qwen-Image 2.1 takes 4 photos — the first 4 are used");
    expect(open.notes[1]).toMatch(/^Qwen-Image 2.1 keeps the shape of your first photo/);
    expect(sheetFromReference(imgs.slice(0, 4), "open").notes).toHaveLength(1);
    const planned = plan(open.request);
    expect(planned.op).toBe("edit");
    expect(planned.model.routes.find((r) => r.op === "edit")!.endpoint).toBe("qwen-image-21-edit");
  });

  it("Build from scratch runs on Fuobe Soul (Nano Banana Pro when it is switched off) or the Soul Cast sheet workflow", () => {
    expect(castSheetModel("cloud", {})).toBe("fuobe-soul");
    expect(castSheetModel("cloud", { has: () => true })).toBe("fuobe-soul");
    expect(castSheetModel("cloud", { has: (id) => id !== "fuobe-soul" })).toBe("nano-banana-pro");
    expect(castSheetModel("open", { has: () => true })).toBe("oss-zimage-soul-cast");
    expect(castSheetModel("open", { has: () => false })).toBe("oss-z-image-turbo");
  });

  it("randomizes and names a cast like Cinema Studio", () => {
    const fields = SOUL_CAST_FIELDS.map((f) => ({ key: f.key, label: f.label, tab: f.tab, kind: f.kind, options: f.options }));
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(randomCast(fields, { budget: 250 }, rng(seed))).toEqual(randomizeCast({ budget: 250 }, rng(seed)));
    }
    for (const v of [{ archetype: "Rebel", age: 30 }, { archetype: "Sage" }, { genre: "Western" }, {}]) expect(castNameFor(v)).toBe(castName(v));
  });

  it("hides the same Soul Cast fields as Cinema Studio", () => {
    const cases = [{ gender: "Female" }, { gender: "Male" }, { gender: "Male", facial_hair: "Beard" }, { gender: "Male", facial_hair: "Clean-shaven" }, {}];
    for (const v of cases) for (const f of SOUL_CAST_FIELDS) expect(castFieldVisible(f.key, v), `${f.key} ${JSON.stringify(v)}`).toBe(f.when ? f.when(v) : true);
  });
});

describe("drawn covers", () => {
  it("curated looks and packs get spread hues and a treatment from their words", () => {
    expect(coverTone("Retro BW", "Grainy black-and-white film portrait")).toBe("mono");
    expect(coverTone("80s horror", "1980s horror lighting: red and blue gels, fog")).toBe("gel");
    expect(coverTone("Flash editorial", "Direct on-camera flash fashion editorial")).toBe("flash");
    expect(coverTone("Neutral pastel film", "Film stock with neutral pastel tones")).toBe("pastel");
    expect(coverTone("Old smartphone", "Low-res early phone camera: noise, soft focus")).toBe("film");
    expect(coverTone("General", "Soul 2.0's neutral default look")).toBe("plain");
    // Neighbours in a set never share a hue band.
    const looks = CURATED_SETS["soul-v2"].slice(0, 6);
    for (let i = 1; i < looks.length; i++) {
      const d = Math.abs(looks[i].hue - looks[i - 1].hue) % 360;
      expect(Math.min(d, 360 - d)).toBeGreaterThan(40);
    }
    expect(CURATED_SETS["soul-v2"].find((l) => l.name === "Retro BW")?.tone).toBe("mono");
    expect(new Set(PACKS.map((p) => p.hue)).size).toBe(PACKS.length);
    expect(getPack("2000s-nostalgia")?.tone).toBe("flash");
    expect(spreadHue(0)).not.toBe(spreadHue(1));
  });
});

describe("moodboard logic", () => {
  it("uses Higgsfield's limits and copy", () => {
    const five = Array.from({ length: 5 }, (_, i) => `i${i}`);
    expect(moodboardError({ name: "x", images: five.slice(0, 4) })).toBe("Upload at least 5 photos to continue.");
    expect(moodboardError({ name: "x", images: Array(81).fill("i") })).toBe("Maximum images per moodboard is 80");
    expect(moodboardError({ name: " ", images: five })).toBe("Please enter a moodboard name");
    expect(moodboardError({ name: "x".repeat(101), images: five })).toBe("Name is too long, maximum 100 characters allowed");
    expect(moodboardError({ name: "Ok", images: five })).toBeNull();
    expect(imageProblem({ width: 255, height: 900, key: "a" }, [])).toBe("Image dimensions too small: minimum size is 256x256px.");
    expect(imageProblem({ width: 300, height: 300, key: "a" }, ["a"])).toBe("This image is already added");
    expect(imageProblem({ width: 256, height: 256, key: "b" }, ["a"])).toBeNull();
  });

  it("follows the cover job: In queue → In progress → Preparing cover → Complete / Failed", () => {
    expect(moodboardStatus({ status: "queued", progress: null, error: null }).status).toBe("queued");
    expect(moodboardStatus({ status: "running", progress: 0.2, error: null }).status).toBe("running");
    expect(moodboardStatus({ status: "running", progress: 0.7, error: null }).status).toBe("cover");
    expect(moodboardStatus({ status: "succeeded", progress: 1, error: null }).status).toBe("complete");
    expect(moodboardStatus({ status: "failed", progress: null, error: "boom" })).toEqual({ status: "failed", error: "boom" });
    expect(moodboardStatus(null).status).toBe("failed");
  });

  it("orders images so the first ones cover the board's range, and groups collages of 4", () => {
    const red = colorFeature(fill([220, 20, 20], 50));
    const blue = colorFeature(fill([20, 20, 220], 50));
    const order = representativeOrder([red, red, red, blue, red]);
    // The typical (red) one first, then the outlier that represents the rest, not another red.
    expect(order[0]).toBe(0);
    expect(order[1]).toBe(3);
    expect(order).toHaveLength(5);
    expect(collageGroups([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(collageGroups([1, 2, 3, 4, 5, 6])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 3, 4],
    ]);
    expect(coverCrop(200, 100, 50, 50)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 });
  });
});
