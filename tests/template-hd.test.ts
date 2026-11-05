import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { templateCover, type TemplateGroup } from "@/lib/template-covers";
import { templateHdFiles, templateStillSources } from "@/lib/template-hd";
import { TEMPLATE_HD } from "@/lib/template-hd.generated";

/*
 * Larger copies of template tiles' posters (scripts/gen-template-hd.mjs, src/lib/template-hd.ts): every listed copy is
 * there at its width and weight, shows what the published poster shows, and a tile's srcsets list them, so a box takes
 * one at least as wide as it shows.
 */

const root = process.cwd();
const local = (url: string) => path.join(root, "public", ...url.split("?")[0].split("/").filter(Boolean));
const grey = (file: string) => sharp(file).resize(128, 96, { fit: "fill" }).greyscale().raw().toBuffer();
const mean = (x: Buffer) => x.reduce((s, v) => s + v, 0) / x.length;
/** As gen-template-hd.mjs: each from its own mean brightness. */
const gap = (a: Buffer, b: Buffer) => {
  const [ma, mb] = [mean(a), mean(b)];
  return a.reduce((sum, v, i) => sum + Math.abs(v - ma - (b[i] - mb)), 0) / a.length;
};
/** The generator checks the decoded frame against 7; its AVIF and JPEG copies add a little of their own. */
const MATCH = 8;
/** The most a copy may weigh, by width (a painted, detailed scene is the heaviest). */
const MAX_STILL = { 320: 30_000, 640: 120_000, 1024: 260_000 } as Record<number, number>;

const urls = (srcset: string) => srcset.split(", ").map((s) => ({ url: s.split(" ")[0], w: Number(s.split(" ")[1].slice(0, -1)) }));

describe("template tiles' larger copies", () => {
  const keys = Object.keys(TEMPLATE_HD);

  it("lists tiles with a poster of their own, at widths past the published one's", () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const [group, id] = key.split("/") as [TemplateGroup, string];
      const c = templateCover(group, id);
      expect(c?.poster, key).toMatch(new RegExp(`^/previews/templates/${key}\\.jpg\\?v=[0-9a-f]{8}$`));
      expect(TEMPLATE_HD[key].w.every((w) => w > (TEMPLATE_HD[key].still ?? 512)), key).toBe(true);
    }
  });

  it.each(keys)("%s: every copy is there, at its width and weight, showing the published poster", async (key) => {
    const [group, id] = key.split("/") as [TemplateGroup, string];
    const c = templateCover(group, id)!;
    const src = templateStillSources(c.poster, c.thumb)!;
    expect(src).toBeDefined();
    const published = await grey(local(c.poster));
    const ownW = (await sharp(local(c.poster)).metadata()).width!;
    // The published poster and its thumb, at their own widths, then the copies.
    expect(src.jpeg).toContain(`${c.thumb} 320w, ${c.poster} ${ownW}w`);
    for (const { url, w } of [...urls(src.avif), ...urls(src.jpeg).filter((x) => x.w > ownW)]) {
      expect(url).toMatch(new RegExp(`^/previews/templates/hd/${w}/${key}\\.(avif|jpg)\\?v=${TEMPLATE_HD[key].v}$`));
      const file = local(url);
      expect((await sharp(file).metadata()).width, url).toBe(w);
      expect(fs.statSync(file).size, url).toBeLessThan(MAX_STILL[w]);
      expect(gap(await grey(file), published), url).toBeLessThan(MATCH);
    }
  });

  it("leaves no file in public/previews/templates/hd that no entry names", () => {
    const named = new Set(keys.flatMap(templateHdFiles));
    const dir = path.join(root, "public", "previews", "templates", "hd");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(jpg|avif)$/.test(f)) : [];
    expect(files.map((f) => `/previews/templates/hd/${f.replaceAll("\\", "/")}`).filter((u) => !named.has(u))).toEqual([]);
    for (const u of named) expect(fs.existsSync(local(u)), u).toBe(true);
  });

  it("a poster without copies, or a preset's cover, keeps its own files", () => {
    expect(templateStillSources("/previews/templates/canvas/no-such-tile.jpg?v=1", "/t.jpg")).toBeUndefined();
    expect(templateStillSources("/previews/presets/peak/effect-agamemnon.jpg?v=1")).toBeUndefined();
  });
});
