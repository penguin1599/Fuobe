import { describe, expect, it } from "vitest";
import { indexEntries, presetThumb, skillEntries } from "@/lib/command-search";
import { entriesFor, NAV_ENTRIES, type ViewerKind } from "@/lib/nav-model";
import { INTENTS, navSearchEntries, queryWords, searchNav, stem, STOPWORDS, type SearchEntry } from "@/lib/nav-search";
import { paletteIndex } from "@/lib/palette-index";

const index = paletteIndex();
/** What the palette searches for a viewer, with every app, motion, effect and model (both engines on). */
const entriesOf = (kind: ViewerKind | undefined, mode: "both" | "open" | "cloud" = "both"): SearchEntry[] => [
  ...navSearchEntries(entriesFor(kind)),
  ...indexEntries(index, mode),
];
const OWNER = entriesOf("owner");
const GUEST = entriesOf("guest");
const ACCOUNT = entriesOf("account");

const labels = (q: string, entries = OWNER) => searchNav(q, entries).best.map((h) => h.label);
const all = (q: string, entries = OWNER) => {
  const r = searchNav(q, entries);
  return [...r.best, ...r.also, ...r.groups.flatMap((g) => g.hits)];
};

describe("reading a query", () => {
  it("drops filler words, unless that leaves nothing", () => {
    expect(queryWords("ad for my perfume")).toEqual(["ad", "perfume"]);
    expect(queryWords("make my product video for amazon")).toEqual(["product", "video", "amazon"]);
    expect(queryWords("how do I")).toEqual(["how", "do", "i"]);
    expect(queryWords("  ")).toEqual([]);
    for (const w of ["a", "the", "for", "my", "make", "create", "new"]) expect(STOPWORDS.has(w)).toBe(true);
  });

  it("folds plurals and -ing, and leaves words that only look plural", () => {
    expect(stem("ads")).toBe("ad");
    expect(stem("perfumes")).toBe("perfume");
    expect(stem("dresses")).toBe("dress");
    expect(stem("talking")).toBe("talk");
    expect(stem("dubbing")).toBe("dub");
    expect(stem("dressing")).toBe("dress");
    expect(stem("dress")).toBe("dress");
    expect(stem("canvas")).toBe("canvas");
    expect(stem("sing")).toBe("sing");
    expect(stem("4k")).toBe("4k");
  });

  it("has intents whose targets all exist", () => {
    const ids = new Set([...NAV_ENTRIES.map((e) => e.id), ...[...index.apps, ...index.motions, ...index.effects].map((p) => p.id)]);
    for (const it of INTENTS) for (const t of it.targets) expect(ids.has(t), `${it.id} → ${t}`).toBe(true);
    expect(new Set(INTENTS.map((i) => i.id)).size).toBe(INTENTS.length);
  });
});

describe("search by what you want to make", () => {
  it("“ad for my perfume” → Marketing Studio, Ads Studio, Giant Product", () => {
    expect(labels("ad for my perfume")).toEqual(["Marketing Studio", "Ads Studio", "Giant Product"]);
    expect(labels("ad for my perfume", GUEST)).toEqual(["Marketing Studio", "Ads Studio", "Giant Product"]);
    // The next ideas are presets, with where they come from.
    const also = searchNav("ad for my perfume", OWNER).also;
    expect(also.length).toBe(2);
    for (const h of also) {
      expect(["app", "motion", "effect"]).toContain(h.kind);
      expect(h.from).toBeTruthy();
    }
  });

  it("“talking photo” → Lipsync & avatars and the Talking Photo app", () => {
    const top = labels("talking photo");
    expect(top).toContain("Lipsync & avatars");
    expect(top).toContain("Talking Photo");
  });

  it("“make my product video for amazon” → Marketing Studio first", () => {
    expect(labels("make my product video for amazon")[0]).toBe("Marketing Studio");
  });

  it("“tiktok dance” → Shorts Studio and Motion control", () => {
    const top = labels("tiktok dance");
    expect(top).toContain("Shorts Studio");
    expect(top).toContain("Motion control");
  });

  it("“remove background” → Video tools › Remove background first", () => {
    const first = searchNav("remove background", OWNER).best[0];
    expect(first.label).toBe("Remove background");
    expect(first.kind).toBe("tool");
    expect(first.hint).toBe("Video tools");
    expect(first.href).toBe("/video-tools");
  });

  it("“4k” → Upscale first; “try on a dress” → Fashion Factory; “youtube channel” → Faceless Studio", () => {
    expect(labels("4k")[0]).toBe("Upscale");
    expect(labels("try on a dress")[0]).toBe("Fashion Factory");
    expect(labels("youtube channel")[0]).toBe("Faceless Studio");
  });

  it("“music”, “voiceover”, “sound effect” and “sound” → the Sound studio's modes, then Audio", () => {
    const first = (q: string) => searchNav(q, GUEST).best[0];
    expect(first("music")).toMatchObject({ label: "Music", hint: "Audio", href: "/audio/music" });
    expect(first("background music").label).toBe("Music");
    expect(first("voiceover")).toMatchObject({ label: "Speech", hint: "Audio", href: "/audio/speech" });
    expect(searchNav("voice over for my video", GUEST).best.slice(0, 2).map((h) => h.href)).toContain("/audio/speech");
    // "audio": the studio, then Clean up voice (the mode it opens on, its highlight).
    expect(searchNav("audio", GUEST).best.slice(0, 2).map((h) => h.label)).toEqual(["Audio", "Clean up voice"]);
    expect(first("sound effect")).toMatchObject({ label: "Sound effects", href: "/audio/sfx" });
    expect(first("whoosh").label).toBe("Sound effects");
    expect(searchNav("sound", GUEST).best.slice(0, 3).map((h) => h.label)).toEqual(expect.arrayContaining(["Audio", "Sound effects"]));
    expect(first("dub my video")).toMatchObject({ label: "Translate & dub", href: "/audio/translate" });
  });

  it("forgives a typo: “cinma” → Cinema Studio", () => {
    expect(labels("cinma")[0]).toBe("Cinema Studio");
    expect(labels("libary")).toContain("All creations");
  });

  it("still matches every word of a name first: “video tools”, “video”, “upscale video”", () => {
    expect(labels("video tools")[0]).toBe("Video tools");
    expect(labels("video")[0]).toBe("Video");
    expect(labels("upscale video")[0]).toBe("Upscale video");
    expect(searchNav("upscale video", OWNER).best[0].hint).toBe("Upscale");
    expect(labels("settings")[0]).toBe("Settings");
    expect(labels("library")[0]).toBe("All creations");
  });

  it("finds apps, motions and effects by name", () => {
    const app = index.apps.find((a) => a.id === "app-packshot")!;
    expect(all(app.name).map((h) => h.label)).toContain(app.name);
    const motion = index.motions[0];
    expect(all(motion.name).map((h) => h.label)).toContain(motion.name);
  });

  it("gives a preset its small cover and a studio its cover id", () => {
    const giant = searchNav("ad for my perfume", OWNER).best.find((h) => h.label === "Giant Product")!;
    expect(giant.cover).toMatch(/^\/previews\/presets\/thumbs\/app-giant-product\.jpg\?v=[0-9a-f]{8}$/);
    expect(searchNav("cinema", OWNER).best[0].cover).toBe("motion-arc-left");
  });

  it("matches nothing for an empty query or a word that means nothing", () => {
    expect(searchNav("", OWNER)).toEqual({ best: [], also: [], groups: [] });
    expect(searchNav("   ", OWNER).best).toEqual([]);
    expect(all("zqx")).toEqual([]);
  });

  it("groups the rest by kind, capped, without repeating the best or the ideas", () => {
    const r = searchNav("zoom", OWNER);
    const keys = [...r.best, ...r.also, ...r.groups.flatMap((g) => g.hits)].map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
    const caps: Record<string, number> = { studio: 6, setting: 4, skill: 4, app: 5, motion: 4, effect: 4, model: 5 };
    for (const g of r.groups) expect(g.hits.length, g.kind).toBeLessThanOrEqual(caps[g.kind]);
    const firsts = r.groups.map((g) => g.hits[0].score);
    expect(firsts).toEqual([...firsts].sort((a, b) => b - a));
  });

  it("finds skills that run by themselves", () => {
    const skills = skillEntries([{ name: "lamp-turntable", title: "Lamp turntable", description: "A turntable from a product photo.", recipe: true, enabled: true }]);
    expect(all("turntable", [...OWNER, ...skills]).map((h) => h.label)).toContain("Run Lamp turntable…");
  });
});

describe("search and who is looking", () => {
  it("finds the ComfyUI server setting for the owner only", () => {
    expect(labels("comfyui server")[0]).toBe("ComfyUI server");
    for (const entries of [GUEST, ACCOUNT, entriesOf(undefined)]) {
      const hits = all("comfyui server", entries);
      expect(hits.map((h) => h.label)).not.toContain("ComfyUI server");
      expect(hits.some((h) => h.key.startsWith("nav:setting-"))).toBe(false);
    }
    // A guest finds the way to connect their own GPU instead.
    expect(labels("comfyui server", GUEST)[0]).toBe("Connect your GPU");
  });

  it("offers Restore and Remove dialogue to everyone (their pages say what they run on)", () => {
    for (const entries of [GUEST, ACCOUNT]) {
      for (const q of ["restore colourise", "restore old footage"]) expect(all(q, entries).map((h) => h.id), q).toContain("video-tools-restore");
      expect(all("remove dialogue", entries).map((h) => h.id)).toContain("video-tools-remove-dialogue");
    }
    expect(all("restore colourise").map((h) => h.id)).toContain("video-tools-restore");
  });

  it("offers sign-up and log-in to a guest only", () => {
    expect(labels("sign up", GUEST)[0]).toBe("Sign up free");
    expect(all("sign up", OWNER).map((h) => h.id)).not.toContain("signup");
    expect(all("log in", ACCOUNT).map((h) => h.id)).not.toContain("login");
  });

  it("leaves out presets a locked engine can't run", () => {
    const open = entriesOf("guest", "open");
    for (const h of all("ad for my perfume", open)) if (h.kind === "app") expect(index.apps.find((a) => a.name === h.label)?.open, h.label).toBe(true);
  });
});

describe("search speed", () => {
  it("ranks 1,500 entries in under 2 ms on average", () => {
    const base = OWNER;
    const big: SearchEntry[] = [];
    for (let i = 0; big.length < 1500; i++) big.push(...base.map((e) => ({ ...e, key: `${e.key}#${i}` })));
    big.length = 1500;
    const queries = ["ad for my perfume", "talking photo", "4k", "remove background", "cinma", "tiktok dance", "zoom", "video tools", "youtube channel", "x"];
    searchNav("warm up", big);
    // The best of three rounds of 100: other test files share the CPU.
    const rounds = [0, 1, 2].map(() => {
      const t0 = performance.now();
      for (let r = 0; r < 100; r++) searchNav(queries[r % queries.length], big);
      return (performance.now() - t0) / 100;
    });
    expect(Math.min(...rounds)).toBeLessThan(2);
  });
});

describe("the index's covers", () => {
  it("carries a version for a cover at the usual place and a URL for another, and the palette builds the small copy", () => {
    expect(presetThumb("app-x", "1234abcd")).toBe("/previews/presets/thumbs/app-x.jpg?v=1234abcd");
    expect(presetThumb("motion-3d-rotation", "/previews/presets/app-3d-rotation.jpg?v=d6a7603e")).toBe("/previews/presets/thumbs/app-3d-rotation.jpg?v=d6a7603e");
    expect(presetThumb("app-x", undefined)).toBeUndefined();
    const withCover = index.apps.filter((a) => a.cover);
    expect(withCover.length).toBeGreaterThan(index.apps.length / 2);
    for (const a of [...index.apps, ...index.motions, ...index.effects]) if (a.cover) expect(a.cover, a.id).toMatch(/^([0-9a-f]{8}|\/previews\/[^?]+\.jpg\?v=[0-9a-f]{8})$/);
  });
});

describe("plain requests find the right place", () => {
  const top = (q: string) => searchNav(q, GUEST).best.map((h) => h.label);
  it("an intent beats a name that only shares a word", () => {
    expect(top("make a film")[0]).toBe("Cinema Studio");
    expect(top("ad for my perfume")[0]).toBe("Marketing Studio");
    expect(top("product photo")[0]).toBe("Marketing Studio");
  });
  it("an app named for the request comes first", () => {
    expect(top("restore an old photo")[0]).toBe("Restore Photo");
    expect(top("old photo")[0]).toBe("Restore Photo");
    expect(top("turn me into a cartoon")).toContain("Style Transfer");
    expect(top("anime")).not.toContain("Expand Image");
    expect(top("change the sky")).toContain("Change Background");
    expect(top("change the sky")).not.toContain("Voice change");
  });
  it("a short word is never a letters-in-order guess, and a weak match is never the best one", () => {
    expect(all("logo", GUEST).map((h) => h.label)).not.toContain("Log in");
    expect(all("make a song", GUEST).map((h) => h.label)).not.toContain("Source on GitHub");
    expect(all("real estate", GUEST).map((h) => h.label)).not.toContain("Sign up free");
    expect(searchNav("zzqx", GUEST).best).toEqual([]);
    // "photo" alone doesn't fire the photo-pack intent.
    expect(top("restore photo").slice(0, 2)).not.toContain("Photodump");
  });
  it("never names ComfyUI as a maker to a guest or an account, and does to the owner", () => {
    for (const entries of [GUEST, ACCOUNT]) expect(entries.some((e) => /comfy/i.test(e.hint ?? "") && e.kind === "model")).toBe(false);
    const owner = [...navSearchEntries(entriesFor("owner")), ...indexEntries(index, "both", undefined, { owner: true })];
    expect(owner.some((e) => e.kind === "model" && /ComfyUI/.test(e.hint ?? ""))).toBe(true);
  });
});
