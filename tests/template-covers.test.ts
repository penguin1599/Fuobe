import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CANVAS_TEMPLATES } from "@/lib/catalog/canvas";
import { PRESETS } from "@/lib/catalog/content-factory";
import { EXPLAINER_STYLE_IDS } from "@/lib/catalog/faceless";
import { AD_STYLES, TEMPLATES } from "@/lib/catalog/marketing";
import { MIXED_PRESETS } from "@/lib/catalog/mixed-media";
import { FASHION, PACKS } from "@/lib/catalog/packs";
import { SHORTS_PRESETS } from "@/lib/catalog/shorts";
import { lookSet } from "@/lib/catalog/soul-cards";
import { CREATURE_TYPES, HUMAN_TIERS } from "@/lib/influencer";
import { PRESET_PEAKS } from "@/lib/preset-peaks.generated";
import { PRESET_PREVIEWS } from "@/lib/preset-previews.generated";
import { STARTERS } from "@/lib/starters/catalog";
import { TEMPLATE_GROUPS, templateCover, type TemplateGroup } from "@/lib/template-covers";
import { TEMPLATE_COVERS } from "@/lib/template-covers.generated";
import { templateHdFiles } from "@/lib/template-hd";
import { TEMPLATE_HD } from "@/lib/template-hd.generated";
import { tempDir } from "./helpers/temp-dir";

/*
 * The template tiles' covers manifest (src/lib/template-covers.generated.ts, written by pnpm eval:covers --templates)
 * against the catalogs and the files in public/previews, unmocked; and the generator itself, on sample media.
 * tests/template-cover-tiles.test.ts covers the tiles with a mocked manifest.
 */

type Entry = { poster: string; video?: string; at?: number; frames?: string[] };
type Made = Entry & { key: string; kind: string; kept?: true; same?: string };
const gen = (await import("../scripts/eval/lib/template-covers.mjs")) as unknown as {
  TEMPLATE_GROUPS: string[];
  slimEntry: (key: string, e: Entry) => unknown;
  readTemplateManifest: (file: string) => Record<string, Entry>;
  writeTemplateManifest: (entries: Record<string, Entry>, file: string) => void;
  templateCoversFromMasters: (dir: string, opts: Record<string, unknown>) => { covers: Made[]; skipped: { key: string; why: string }[] };
  versionTemplateCovers: (opts: { publicDir?: string; manifest?: string; dryRun?: boolean }) => { entries: number; urls: number; changed: number; thumbs: string[]; unversioned: string[] };
};

const root = process.cwd();
/** Every tile of each group, by id: what the manifest's keys may name. */
const TILES: Record<TemplateGroup, string[]> = {
  // Marketing's templates, and Click to Ad's styles as cta-<style>.
  marketing: [...TEMPLATES.map((t) => t.id), ...AD_STYLES.map((s) => `cta-${s.id}`)],
  fashion: FASHION.map((t) => t.id),
  photodump: PACKS.map((p) => p.id),
  shorts: SHORTS_PRESETS.map((p) => p.id),
  "mixed-media": MIXED_PRESETS.map((p) => p.id),
  canvas: CANVAS_TEMPLATES.map((t) => t.id),
  "content-factory": PRESETS.map((p) => p.id),
  explainer: [...EXPLAINER_STYLE_IDS],
  // Fuobe Soul's looks, Soul 2.0's and Soul's, by look id.
  soul: [...lookSet("v2").items, ...lookSet("v1").items].map((c) => c.id),
  // AI Influencer's character types as tier-<type>.
  influencer: [...HUMAN_TIERS, ...CREATURE_TYPES].map((t) => `tier-${t.id}`),
  // The example pictures of the empty pages: Character Sheet, Storyboard (six frames), Elements (four pictures).
  examples: ["character-sheet", "storyboard-heist", "element-maya", "element-rooftop-bar", "element-aurora", "element-together"],
  // The studios' ready-made starters, by starter id (src/lib/starters/catalog.ts).
  // A starter that shows another tile's cover, an example's or its own published photos (coverOf) gets none of its own.
  starters: STARTERS.filter((s) => !s.coverOf).map((s) => s.id),
};
const VERSIONED = /^(\/previews\/[^?]+)\?v=([0-9a-f]{8})$/;
const sha8 = (...files: string[]) => {
  const hash = createHash("sha256");
  for (const f of files) hash.update(fs.readFileSync(f));
  return hash.digest("hex").slice(0, 8);
};
const fileOf = (url: string, publicDir = path.join(root, "public")) => path.join(publicDir, url.split("?")[0]);
const thumbOf = (url: string) => url.replace(/\/([^/?]+)(\?|$)/, "/thumbs/$1$2");

describe("the template covers manifest", () => {
  it("lists the same groups as the generator, and only real tiles", () => {
    expect([...TEMPLATE_GROUPS]).toEqual(gen.TEMPLATE_GROUPS);
    for (const key of Object.keys(TEMPLATE_COVERS)) {
      const [group, id, ...rest] = key.split("/");
      expect(rest, key).toEqual([]);
      expect(TILES[group as TemplateGroup] ?? [], key).toContain(id);
    }
  });

  it("gives every URL its files' version: a still's with its 320 px copy, a clip's alone", () => {
    for (const key of Object.keys(TEMPLATE_COVERS)) {
      const [group, id] = key.split("/") as [TemplateGroup, string];
      const c = templateCover(group, id)!;
      for (const f of c.frames) {
        const [, , v] = VERSIONED.exec(f.src) ?? [];
        expect(v, f.src).toBeDefined();
        expect(fs.existsSync(fileOf(f.thumb)), f.thumb).toBe(true);
        expect(sha8(fileOf(f.src), fileOf(f.thumb)), f.src).toBe(v);
      }
      if (c.video) expect(VERSIONED.exec(c.video)?.[2], c.video).toBe(sha8(fileOf(c.video)));
    }
  });

  it("leaves no file in public/previews/templates that no entry names (with each still's small copy)", () => {
    const named = new Set<string>();
    for (const key of Object.keys(TEMPLATE_COVERS)) {
      const [group, id] = key.split("/") as [TemplateGroup, string];
      const c = templateCover(group, id)!;
      for (const f of c.frames) for (const u of [f.src, f.thumb]) named.add(u.split("?")[0]);
      if (c.video) named.add(c.video.split("?")[0]);
    }
    // The posters' larger copies (scripts/gen-template-hd.mjs, tests/template-hd.test.ts).
    for (const key of Object.keys(TEMPLATE_HD)) for (const u of templateHdFiles(key)) named.add(u);
    const dir = path.join(root, "public", "previews", "templates");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /.(jpg|mp4)$/.test(f)) : [];
    const orphans = files.map((f) => `/previews/templates/${f.replaceAll("\\", "/")}`).filter((u) => !named.has(u));
    expect(orphans).toEqual([]);
  });

  it("stays small with every tile listed: it ships with the studios' pages", () => {
    const pick = <T,>(list: T[], i: number) => list[i % list.length];
    // A tile that shows a preset's cover rests on its peak frame where it has one (the longer entry).
    const presetCovers = Object.entries(PRESET_PREVIEWS).map(([id, c]): Entry => {
      const peak = PRESET_PEAKS[id];
      return c.video && peak ? { poster: `/previews/presets/peak/${id}.jpg?v=${peak.v}`, video: c.video, at: peak.at } : c;
    });
    const v = (n: number) => n.toString(16).padStart(8, "0");
    const t = (key: string, n: number, more = "") => `/previews/templates/${key}${more}.jpg?v=${v(n)}`;
    const lines: string[] = [];
    let n = 0;
    for (const [group, ids] of Object.entries(TILES)) {
      for (const id of ids) {
        const key = `${group}/${id}`;
        n++;
        let e: Entry;
        if (group === "mixed-media" || id.startsWith("effect-chain-")) e = pick(presetCovers, n);
        else if (group === "fashion" || group === "photodump" || ["product-angles", "script-film", "table-film", "clips-film", "compare-image", "storyboard-heist"].includes(id))
          e = { poster: t(key, n), frames: [2, 3, 4, 5, 6].slice(0, id === "storyboard-heist" ? 5 : group === "photodump" ? 3 : 2).map((k) => t(key, n + k, `-${k}`)) };
        else if (group === "shorts") e = { poster: t(key, n), video: `/previews/templates/${key}.mp4?v=${v(n + 1)}`, at: 3.542 };
        else if (group === "marketing" || group === "content-factory" || group === "starters") e = { poster: t(key, n), video: `/previews/templates/${key}.mp4?v=${v(n + 1)}` };
        else e = { poster: t(key, n) };
        lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(gen.slimEntry(key, { poster: e.poster, ...(e.video && { video: e.video }), ...(e.at && { at: e.at }), ...(e.frames && { frames: e.frames }) }))}`);
      }
    }
    // The studios' tiles (254, with Keyframes → animation, Outfit lookbook, Music video and Marketing's twelve code-drawn
    // templates), Fuobe Soul's looks (139), AI Influencer's types (9), the empty pages' examples (6) and the studios'
    // ready-made starters with a cover of their own (24).
    expect(lines).toHaveLength(254 + 139 + 9 + 6 + 24);
    const text = `{\n${lines.join(",\n")}\n}`;
    // More preset covers are clips now (a poster and a video each), so the shared preset entries are longer.
    expect(text.length).toBeLessThan(38_000);
    expect(gzipSync(text).length).toBeLessThan(8_000);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = tempDir("fuobe-template-covers-");
const SAMPLE_CLIP = path.join(root, "public", "samples", "demo-landscape.mp4");

describe.skipIf(!hasFfmpeg)("pnpm eval:covers --templates", () => {
  const masters = path.join(dir, "masters");
  const publicDir = path.join(dir, "public");
  const manifest = path.join(dir, "template-covers.generated.ts");
  const still = path.join(dir, "still.png");
  const put = (key: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(masters, key), { recursive: true });
    for (const [name, from] of Object.entries(files)) {
      if (from.startsWith("{")) fs.writeFileSync(path.join(masters, key, name), from);
      else fs.copyFileSync(from, path.join(masters, key, name));
    }
  };
  const run = (opts: Record<string, unknown> = {}) => gen.templateCoversFromMasters(masters, { publicDir, manifest, ...opts });
  // A preset with no peak frame, and a clip with one (a look that draws itself in, as Mixed Media's effects do).
  const sameId = Object.keys(PRESET_PREVIEWS).find((id) => !PRESET_PEAKS[id])!;
  const peakId = Object.keys(PRESET_PEAKS).find((id) => PRESET_PREVIEWS[id]?.video)!;
  /** The site's copy of a file under public/, in the sample public folder (in this order, so a 320 px copy is never older than its still). */
  const copyIn = (...urls: (string | undefined)[]) => {
    for (const url of urls.filter((u): u is string => !!u)) {
      fs.mkdirSync(path.dirname(fileOf(url, publicDir)), { recursive: true });
      fs.copyFileSync(fileOf(url), fileOf(url, publicDir));
    }
  };

  it("encodes stills, clips, reveals and frames, versions every URL, and lists a preset's cover as it is", () => {
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", SAMPLE_CLIP, "-frames:v", "1", still]);
    put("marketing/ps-sunlit-plinth", { "still.png": still });
    put("marketing/m2-sticker-pop", { "clip.mp4": SAMPLE_CLIP });
    put("shorts/shorts-warm-glow", { "clip.mp4": SAMPLE_CLIP, "meta.json": '{"rest":"end"}' });
    put("marketing/ms-kinetic-headline", { "clip.mp4": SAMPLE_CLIP, "meta.json": '{"rest":0.5}' });
    put("photodump/zen", { "still.png": still, "frame-2.png": still, "frame-3.png": still, "frame-4.png": still });
    put("mixed-media/mixed-sketch", { "meta.json": JSON.stringify({ same: sameId }) });
    put("mixed-media/mixed-paper", { "meta.json": JSON.stringify({ same: peakId }) });
    // The presets' own files, as the site has them: their covers, and the one's peak frame.
    const p = PRESET_PREVIEWS[sameId];
    copyIn(p.poster, thumbOf(p.poster), p.video);
    const peak = `/previews/presets/peak/${peakId}.jpg?v=${PRESET_PEAKS[peakId].v}`;
    copyIn(PRESET_PREVIEWS[peakId].video, peak, thumbOf(peak));
    put("nope/x", { "still.png": still });

    const r = run();
    expect(r.covers.map((c) => c.key).sort()).toEqual([
      "marketing/m2-sticker-pop",
      "marketing/ms-kinetic-headline",
      "marketing/ps-sunlit-plinth",
      "mixed-media/mixed-paper",
      "mixed-media/mixed-sketch",
      "photodump/zen",
      "shorts/shorts-warm-glow",
    ]);
    expect(r.skipped).toEqual([{ key: "nope", why: expect.stringMatching(/not a tile group/) }]);
    const m = gen.readTemplateManifest(manifest);
    const out = (f: string) => path.join(publicDir, "previews", "templates", f);
    expect(m["marketing/ps-sunlit-plinth"]).toEqual({ poster: `/previews/templates/marketing/ps-sunlit-plinth.jpg?v=${sha8(out("marketing/ps-sunlit-plinth.jpg"), out("marketing/thumbs/ps-sunlit-plinth.jpg"))}` });
    expect(m["marketing/m2-sticker-pop"].video).toBe(`/previews/templates/marketing/m2-sticker-pop.mp4?v=${sha8(out("marketing/m2-sticker-pop.mp4"))}`);
    // A reveal rests on its last frame: the clip is kept to its end.
    const reveal = m["shorts/shorts-warm-glow"];
    expect(reveal.at).toBeGreaterThan(1);
    expect(reveal.video).toMatch(VERSIONED);
    // A clip whose telling moment comes earlier rests on it (the frame nearest that time), kept whole too.
    const moment = m["marketing/ms-kinetic-headline"];
    expect(moment.at).toBeCloseTo(0.5, 1);
    expect(moment.video).toMatch(VERSIONED);
    expect(m["photodump/zen"].frames).toEqual([2, 3, 4].map((k) => `/previews/templates/photodump/zen-${k}.jpg?v=${sha8(out(`photodump/zen-${k}.jpg`), out(`photodump/thumbs/zen-${k}.jpg`))}`));
    expect(m["mixed-media/mixed-sketch"]).toEqual({ poster: PRESET_PREVIEWS[sameId].poster, ...(PRESET_PREVIEWS[sameId].video && { video: PRESET_PREVIEWS[sameId].video }) });
    // A clip with a peak rests on it: the look, not the photo the clip starts from (and the versions stay the peak's own).
    expect(m["mixed-media/mixed-paper"]).toEqual({ poster: peak, video: PRESET_PREVIEWS[peakId].video, at: PRESET_PEAKS[peakId].at });
    expect(templateCover("mixed-media", "mixed-paper", { "mixed-media/mixed-paper": gen.slimEntry("mixed-media/mixed-paper", m["mixed-media/mixed-paper"]) } as never)).toMatchObject({ poster: peak, at: PRESET_PEAKS[peakId].at });
    // The file lists a plain cover by its versions alone.
    const text = fs.readFileSync(manifest, "utf8");
    expect(text).toMatch(/"marketing\/ps-sunlit-plinth": "[0-9a-f]{8}"/);
    expect(text).toMatch(/"marketing\/m2-sticker-pop": \["[0-9a-f]{8}","[0-9a-f]{8}"\]/);
    expect(text).toMatch(/"shorts\/shorts-warm-glow": \{"poster":/);
  });

  it("keeps what's up to date, and removes the files a tile no longer uses", () => {
    expect(run().covers.filter((c) => !c.same).every((c) => c.kept)).toBe(true);
    // The clip becomes a still, and the pack loses a frame.
    fs.rmSync(path.join(masters, "marketing/m2-sticker-pop/clip.mp4"));
    put("marketing/m2-sticker-pop", { "still.png": still });
    fs.rmSync(path.join(masters, "photodump/zen/frame-4.png"));
    run({ only: ["marketing/m2-sticker-pop", "photodump/zen"] });
    const m = gen.readTemplateManifest(manifest);
    expect(m["marketing/m2-sticker-pop"].video).toBeUndefined();
    expect(m["photodump/zen"].frames).toHaveLength(2);
    expect(fs.existsSync(path.join(publicDir, "previews/templates/marketing/m2-sticker-pop.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "previews/templates/photodump/zen-4.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, "previews/templates/photodump/thumbs/zen-4.jpg"))).toBe(false);
    // The other tiles stay as they were.
    expect(Object.keys(m)).toHaveLength(7);
  });

  it("versions the manifest from the files as they are (--versions), and finds nothing to do when it's current", () => {
    expect(gen.versionTemplateCovers({ publicDir, manifest, dryRun: true })).toMatchObject({ entries: 7, changed: 0, thumbs: [], unversioned: [] });
    // A still replaced by hand: its copy is made again first, then both get a new version.
    const poster = path.join(publicDir, "previews/templates/marketing/ps-sunlit-plinth.jpg");
    const was = gen.readTemplateManifest(manifest)["marketing/ps-sunlit-plinth"].poster;
    fs.appendFileSync(poster, Buffer.from([0]));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(poster, later, later);
    expect(gen.versionTemplateCovers({ publicDir, manifest, dryRun: true }).thumbs).toEqual(["/previews/templates/marketing/thumbs/ps-sunlit-plinth.jpg"]);
    const r = gen.versionTemplateCovers({ publicDir, manifest });
    expect(r.changed).toBe(1);
    const now = gen.readTemplateManifest(manifest)["marketing/ps-sunlit-plinth"].poster;
    expect(now).not.toBe(was);
    expect(now).toBe(`/previews/templates/marketing/ps-sunlit-plinth.jpg?v=${sha8(poster, fileOf(thumbOf(now), publicDir))}`);
  });

  it("takes an example board's six frames (the cover and five more), and no more", () => {
    put("examples/storyboard-heist", Object.fromEntries([["still.png", still], ...[2, 3, 4, 5, 6, 7].map((k) => [`frame-${k}.png`, still])]));
    const r = run({ only: ["examples/storyboard-heist"] });
    expect(r.covers.map((c) => c.key)).toEqual(["examples/storyboard-heist"]);
    const board = gen.readTemplateManifest(manifest)["examples/storyboard-heist"];
    expect(board.frames).toEqual([2, 3, 4, 5, 6].map((k) => expect.stringMatching(new RegExp(`^/previews/templates/examples/storyboard-heist-${k}\\.jpg\\?v=[0-9a-f]{8}$`))));
    expect(templateCover("examples", "storyboard-heist", { "examples/storyboard-heist": gen.slimEntry("examples/storyboard-heist", board) } as never)?.frames).toHaveLength(6);
  });
});

describe("a template cover that rests on its peak", () => {
  it("rests on the finished scene and plays the effect's whole published clip, the same one its gallery card plays, looping", async () => {
    const { templatePreview } = await import("@/lib/template-covers");
    const { PRESET_PREVIEWS } = await import("@/lib/preset-previews.generated");
    const cover = (k: string) => templateCover(k.split("/")[0] as TemplateGroup, k.split("/")[1]);
    const rests = Object.keys(TEMPLATE_COVERS).filter((k) => cover(k)?.at !== undefined);
    const withPeak = rests.filter((k) => cover(k)!.poster.startsWith("/previews/presets/peak/"));
    expect(withPeak.length).toBeGreaterThan(0);
    // Every Canvas ready board's cover is an effect's peak.
    expect(rests.filter((k) => k.startsWith("canvas/")).every((k) => withPeak.includes(k))).toBe(true);
    // A reveal (its poster is the clip's last frame) still plays from the start up to it.
    for (const key of rests.filter((k) => !withPeak.includes(k))) expect(templatePreview(cover(key)!).rest, key).toEqual({ src: cover(key)!.poster, at: cover(key)!.at, from: 0 });
    for (const key of withPeak) {
      const [group, id] = key.split("/") as [TemplateGroup, string];
      const c = templateCover(group, id)!;
      const p = templatePreview(c);
      // At rest: the finished scene. Playing: the clip from its first frame to its end, looped (no window, no seek).
      expect(p.poster, key).toBe(c.poster);
      expect(p.rest, key).toBeUndefined();
      // The clip is the effect's own published cover clip, the very file (and version) its gallery card plays.
      const effect = /\/previews\/presets\/peak\/([a-z0-9-]+)\.jpg/.exec(c.poster)![1];
      expect(p.video, key).toBe((PRESET_PREVIEWS as Record<string, { video?: string }>)[effect]?.video);
      // Each canvas clip is 4 s long and its peak is within it.
      if (group === "canvas") expect(c.at!, key).toBeLessThan(4);
    }
  });
});
