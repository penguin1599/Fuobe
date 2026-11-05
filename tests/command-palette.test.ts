import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav-items";
import { APPS, EFFECTS, getModel, MODELS, MOTIONS } from "@/lib/catalog";
import { entryScore, indexEntries, normalize, rankPalette, skillEntries, wordScore, type PaletteEntry } from "@/lib/command-search";
import { modelHref, paletteIndex } from "@/lib/palette-index";
import { rowPriceOn, toModelRow } from "@/lib/model-rows";
import { entriesFor, type ViewerKind } from "@/lib/nav-model";
import { navSearchEntries } from "@/lib/nav-search";
import { hubModePaths, studioRoutes } from "./e2e/_routes.mjs";

const page = (label: string, href: string, keywords?: string): PaletteEntry => ({ key: `page:${href}`, kind: "page", label, href, keywords });
const PAGES = NAV.flatMap((g) => g.items.map((i) => page(i.label, i.href, i.keywords)));
const index = paletteIndex();
const ALL = [...PAGES, ...indexEntries(index, "both")];
const top = (q: string, entries = ALL) => rankPalette(entries, q).flatMap((g) => g.entries.map((e) => e.label));

describe("palette word match", () => {
  it("normalizes case, accents and punctuation", () => {
    expect(normalize("  Lipsync & Avatars ")).toBe("lipsync avatars");
    expect(normalize("Café — Crème")).toBe("cafe creme");
    expect(normalize("FLUX.2 [klein]")).toBe("flux.2 klein");
  });

  it("ranks whole > start > word start > inside > letters in order", () => {
    const scores = [wordScore("video", "video"), wordScore("vid", "video tools"), wordScore("tools", "video tools"), wordScore("deo", "video"), wordScore("vdo", "video")];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(scores.length);
    expect(scores.at(-1)).toBeGreaterThan(0);
  });

  it("forgives a missing space and a typo, but not noise", () => {
    expect(wordScore("faceswap", "face swap")).toBeGreaterThan(0);
    expect(wordScore("cinma", "cinema studio")).toBeGreaterThan(0);
    expect(wordScore("zq", "cinema studio")).toBe(0);
    // Letters strewn across a long label are no match.
    expect(wordScore("cso", "cinema studio of something")).toBe(0);
    // One letter only matches the start of a word.
    expect(wordScore("s", "cinema studio")).toBeGreaterThan(0);
    expect(wordScore("t", "cinema studio")).toBe(0);
  });

  it("needs every word, from the label or (worth less) the keywords", () => {
    const audio = page("Audio", "/audio", "voice tts music");
    expect(entryScore("tts", audio)).toBeGreaterThan(0);
    expect(entryScore("audio", audio)).toBeGreaterThan(entryScore("tts", audio));
    expect(entryScore("audio guitar", audio)).toBe(0);
    expect(entryScore("", audio)).toBe(0);
  });
});

describe("palette ranking", () => {
  it("puts the page first when a page and presets share a word", () => {
    expect(top("video")[0]).toBe("Video");
    expect(top("cinema")[0]).toBe("Cinema Studio");
    expect(top("settings")[0]).toBe("Settings");
    expect(top("upscale")[0]).toBe("Upscale");
  });

  it("opens the page a group is named after, not its shortest row", () => {
    // Every Library row has the hint "Library"; All creations also has it as a keyword.
    expect(top("library")[0]).toBe("All creations");
    expect(top("favorites")[0]).toBe("Favorites");
    // A hint alone still finds rows (a model by its vendor).
    expect(entryScore("google", { key: "m", kind: "model", label: "Veo 4", hint: "Google", href: "/video" })).toBeGreaterThan(0);
  });

  it("finds a page by a keyword and with a typo", () => {
    expect(top("tts")).toContain("Audio");
    expect(top("cinma")[0]).toBe("Cinema Studio");
    expect(top("libary")).toContain("All creations");
  });

  it("finds apps, motions, effects and models by name", () => {
    const app = APPS.find((a) => a.id === "app-packshot")!;
    expect(top(app.name)).toContain(app.name);
    const motion = MOTIONS[0];
    const groups = rankPalette(ALL, motion.name);
    expect(groups.find((g) => g.kind === "motion")?.entries.map((e) => e.label)).toContain(motion.name);
    const model = MODELS.find((m) => !m.hidden && m.engine === "cloud")!;
    expect(rankPalette(ALL, model.name).find((g) => g.kind === "model")?.entries.map((e) => e.label)).toContain(model.name);
  });

  it("orders groups by their best match and caps each group", () => {
    const groups = rankPalette(ALL, "zoom");
    for (const g of groups) expect(g.entries.length).toBeLessThanOrEqual({ page: 6, setting: 4, skill: 4, app: 5, motion: 4, effect: 4, model: 5, recent: 5 }[g.kind]);
    const best = groups.map((g) => entryScore("zoom", g.entries[0]));
    expect(best).toEqual([...best].sort((a, b) => b - a));
  });

  it("lists “Run <skill>…” for skills that run by themselves, and finds them", () => {
    const skills = [
      { name: "lamp-turntable", title: "Lamp turntable", description: "A turntable from a product photo.", recipe: true, enabled: true },
      { name: "off", title: "Switched off", description: "x", recipe: true, enabled: false },
      { name: "playbook", title: "Playbook only", description: "x", enabled: true },
    ];
    const entries = skillEntries(skills);
    expect(entries).toEqual([expect.objectContaining({ kind: "skill", label: "Run Lamp turntable…", href: "/assist/skills?run=lamp-turntable" })]);
    expect(rankPalette([...ALL, ...entries], "turntable").find((g) => g.kind === "skill")?.entries.map((e) => e.label)).toEqual(["Run Lamp turntable…"]);
  });

  it("drops letters-in-order guesses next to a real match", () => {
    // An open-source-only install (every visitor's): IndexTTS-2 is the one model with "tts" in its name.
    const tts = top("tts", [...PAGES, ...indexEntries(index, "open")]);
    expect(tts).toContain("IndexTTS-2");
    for (const noise of ["Settings", "Tentacle Horror", "Glitter Sticker", "Bullet Time Scene"]) expect(tts, noise).not.toContain(noise);
    // With no real match, the guesses stay: a typo still finds its page.
    expect(top("cinma")).toContain("Cinema Studio");
  });

  it("matches nothing on an empty query (the palette shows its own start list)", () => {
    expect(rankPalette(ALL, "")).toEqual([]);
    expect(rankPalette(ALL, "   ")).toEqual([]);
  });
});

describe("palette index", () => {
  const routes = (() => {
    const root = path.resolve(__dirname, "..");
    const { routes, patterns } = studioRoutes(root);
    return { paths: new Set([...routes, ...hubModePaths(root)]), patterns };
  })();
  const pathOf = (href: string) => href.split("?")[0];

  it("lists every app, motion, effect and offered model, slim", () => {
    expect(index.apps).toHaveLength(APPS.length);
    expect(index.motions).toHaveLength(MOTIONS.length);
    expect(index.effects).toHaveLength(EFFECTS.length);
    expect(index.models).toHaveLength(MODELS.filter((m) => !m.hidden).length);
    // No prompt templates, routes or LoRA URLs: the whole thing stays small.
    expect(JSON.stringify(index).length).toBeLessThan(160_000);
    // A cover travels as a version (a still at the usual place) or a URL, so the palette shows the real cover.
    for (const p of [...index.apps, ...index.motions, ...index.effects]) for (const k of Object.keys(p)) expect(["category", "cloud", "cover", "id", "name", "open"], k).toContain(k);
    expect(index.apps.find((a) => a.id === "app-giant-product")?.cover).toMatch(/^[0-9a-f]{8}$/);
  });

  it("opens every model somewhere that exists, in a studio of its kind when there is one", () => {
    const apps = new Set(APPS.map((a) => `/apps/${a.id}`));
    for (const m of index.models) {
      const p = pathOf(m.href);
      expect(routes.paths.has(p) || apps.has(p), `${m.id} → ${m.href}`).toBe(true);
    }
    expect(modelHref(getModel("nano-banana-pro")!)).toBe("/image?model=nano-banana-pro");
    expect(modelHref(getModel("seedance-2-5")!)).toBe("/video?model=seedance-2-5");
    expect(modelHref(getModel("oss-qwen-edit")!)).toMatch(/^\/(edit|image)\?model=oss-qwen-edit$/);
  });

  it("opens tool models where they run: Video tools, Image to 3D, an app, Layers, the tool of their kind", () => {
    expect(modelHref(getModel("bria-video-bg")!)).toBe("/video-tools?model=bria-video-bg");
    expect(modelHref(getModel("oss-video-depth-vda")!)).toBe("/video-tools/depth?model=oss-video-depth-vda");
    expect(modelHref(getModel("oss-join-clips")!)).toBe("/video-tools/join?model=oss-join-clips");
    expect(modelHref(getModel("hunyuan-3d-3-1-pro")!)).toBe("/image-to-3d?model=hunyuan-3d-3-1-pro");
    expect(modelHref(getModel("oss-trellis2")!)).toBe("/image-to-3d?model=oss-trellis2");
    expect(modelHref(getModel("recraft-vectorize")!)).toBe("/apps/app-vectorize?model=recraft-vectorize");
    expect(modelHref(getModel("oss-reactor")!)).toBe("/apps/app-face-swap?model=oss-reactor");
    expect(modelHref(getModel("seedream-5-layers")!)).toBe("/layers");
    expect(modelHref(getModel("ideogram-3-text-layers")!)).toBe("/layers");
    expect(modelHref(getModel("auto-subtitle")!)).toBe("/video-tools/captions");
    expect(modelHref(getModel("heygen-translate")!)).toBe("/audio/translate");
    // An app link names one of the app's own models, so the app opens on that route.
    for (const m of index.models.filter((x) => x.href.startsWith("/apps/"))) {
      const app = APPS.find((a) => `/apps/${a.id}` === pathOf(m.href))!;
      expect([app.cloud?.modelId, app.open?.modelId], m.id).toContain(m.id);
    }
  });

  it("opens a model nothing else runs in the studio of what it makes", () => {
    const home: Record<string, string> = { image: "/image", video: "/video", audio: "/audio/speech", text: "/assist", model3d: "/image-to-3d" };
    const fallback = index.models.filter((m) => !m.href.includes("?") && Object.values(home).includes(m.href));
    expect(fallback.length).toBeLessThan(40);
    for (const m of fallback) expect(m.href, m.id).toBe(home[getModel(m.id)!.kind]);
    expect(index.models.some((m) => pathOf(m.href) === "/models")).toBe(false);
  });

  it("opens every page and settings section the palette lists", () => {
    for (const p of PAGES) expect(routes.paths.has(pathOf(p.href)), p.href).toBe(true);
    // The owner's settings sections (the navigation model's, src/lib/nav-model.ts) are in the settings form.
    const form = fs.readFileSync(path.resolve(__dirname, "../src/components/settings-form.tsx"), "utf8");
    const ids = entriesFor("owner")
      .filter((e) => e.id.startsWith("setting-"))
      .map((e) => e.href.split("#")[1]);
    expect(ids.length).toBeGreaterThan(4);
    for (const id of ids) expect(form, `settings section #${id}`).toContain(`id="${id}"`);
  });

  it("leaves out what a locked engine can't run", () => {
    const open = indexEntries(index, "open");
    const cloud = indexEntries(index, "cloud");
    expect(open.filter((e) => e.kind === "model").every((e) => e.keywords?.includes("open source"))).toBe(true);
    expect(cloud.filter((e) => e.kind === "model").every((e) => e.keywords?.includes("cloud"))).toBe(true);
    const openApps = new Set(open.filter((e) => e.kind === "app").map((e) => e.key));
    for (const a of index.apps) expect(openApps.has(`app:${a.id}`)).toBe(a.open);
    expect(indexEntries(index, "both").length).toBeGreaterThan(open.length);
  });

  it("tells a model's two engines apart when both are on", () => {
    const hints = (mode: "both" | "open") => indexEntries(index, mode).filter((e) => e.key === "model:oss-trellis2" || e.key === "model:trellis-2").map((e) => e.hint);
    expect(new Set(hints("both")).size).toBe(2);
    expect(hints("both")).toContain("Microsoft · Open source");
    // One engine locked: nothing to tell apart.
    expect(hints("open")).toEqual(["Microsoft"]);
  });

  it("links presets the way their galleries do", () => {
    const entries = indexEntries(index, "both");
    expect(entries.find((e) => e.kind === "app")?.href).toMatch(/^\/apps\/app-/);
    expect(entries.find((e) => e.kind === "motion")?.href).toMatch(/^\/video\?preset=/);
    expect(entries.find((e) => e.kind === "effect")?.href).toMatch(/^\/video\?preset=/);
  });
});

describe("palette settings by viewer", () => {
  /** The settings a viewer's search offers (src/lib/nav-model.ts): sections, pages and Connect your GPU. */
  const hrefs = (kind: ViewerKind | undefined) =>
    navSearchEntries(entriesFor(kind))
      .filter((e) => e.kind === "setting")
      .map((e) => e.href)
      .sort();

  it("offers the install's settings to its owner only; an account gets its own GPU, its own keys, its account and Thanks & licences", () => {
    expect(hrefs("owner")).toEqual(expect.arrayContaining(["/settings#engine", "/settings#cloud", "/settings#security", "/settings/models", "/settings/licences", "/settings"]));
    expect(hrefs("account")).toEqual(["/connect", "/settings", "/settings#account", "/settings#your-gpu", "/settings#your-keys", "/settings/licences"]);
    // "api key", "fal", "nano banana": an account finds where its own key goes.
    const keys = navSearchEntries(entriesFor("account")).find((e) => e.href === "/settings#your-keys");
    expect(keys?.keywords).toMatch(/api key/);
    expect(keys?.keywords).toMatch(/nano banana/);
    expect(hrefs("guest")).toEqual(["/connect", "/settings", "/settings/licences"]);
    // Not known yet: nothing of the owner's.
    expect(hrefs(undefined)).toEqual(["/connect", "/settings", "/settings/licences"]);
  });
});

describe("Models page rows", () => {
  it("open a model where it runs, and show one engine's price when the install runs one", () => {
    const soul = getModel("fuobe-soul")!;
    const row = toModelRow(soul);
    expect(row.engines).toEqual(["open", "cloud"]);
    expect(modelHref(soul)).toMatch(/\?model=fuobe-soul$/);
    expect(rowPriceOn(row, Date.UTC(2026, 9, 31), "open")).toBe("Free");
    expect(rowPriceOn(row, Date.UTC(2026, 9, 31), "cloud")).not.toMatch(/^Free/);
    expect(rowPriceOn(row, Date.UTC(2026, 9, 31))).toMatch(/^Free · /);
  });
});
