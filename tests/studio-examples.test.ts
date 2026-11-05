import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getPreset, MODELS } from "@/lib/catalog";
import { GENJUTSU_MODES } from "@/lib/catalog/genjutsu";
import { HOME_CAPTION_MAX, HOME_WALL } from "@/lib/home-showcase";
import { KINETIC_SCENES } from "@/lib/motion/kinetic-catalog";
import { thumbOf } from "@/lib/preset-cards";
import { PRESET_BEFORE_AFTER } from "@/lib/preset-before-after.generated";
import { PRESET_PEAKS } from "@/lib/preset-peaks.generated";
import { PRESET_PREVIEWS } from "@/lib/preset-previews.generated";
import { STUDIO_COVERS, isStudioCover } from "@/lib/studio-covers";
import { EXAMPLE_LINES, STUDIO_EXAMPLES, studioExamples, type ExampleStudio } from "@/lib/studio-examples";
import plan from "@/lib/examples/plan.json";

// home-showcase.ts (which the examples borrow from) imports next/cache for its own showcase.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));

/*
 * The studios' and tools' rows of examples (src/lib/studio-examples.ts) against the catalog and the files in public/:
 * every preset a row names is real and has its cover, clip, peak frame and small copies, every line fits a phone's
 * tile and reads as plain copy, and every page that has a row passes it on.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, "src", ...p), "utf8");
/** A cover URL's file in public/ is there and not empty: the URL as the site gives it, ending in its version (?v=). */
const exists = (url: string) => {
  expect(url, url).toMatch(/^\/previews\/[^?]+\?v=[0-9a-f]{8}$/);
  return (fs.statSync(path.join(root, "public", url.split("?")[0]), { throwIfNoEntry: false })?.size ?? 0) > 0;
};
const studios = Object.keys(STUDIO_EXAMPLES) as ExampleStudio[];

/** The Studio pages (a composer of their own), the hubs (ModeSwitchStudio) and the tools or project lists (ExampleRow). */
const COMPOSER = ["image", "video", "edit", "video-edit", "extend", "reframe", "inpaint", "lipsync", "motion-control"] as const;
const HUBS = ["upscale", "video-tools", "audio"] as const;
/** Each tool's or list's component, which shows the row itself. */
const ROW_IN: Record<string, string[][]> = {
  layers: [["components", "layers", "projects-view.tsx"]],
  genjutsu: [["components", "genjutsu", "genjutsu-studio.tsx"]],
  "character-swap": [["components", "swap-studio", "home.tsx"]],
  "image-to-3d": [["components", "model3d", "model3d-studio.tsx"]],
  katana: [["components", "katana", "katana-studio.tsx"]],
  cinema: [["components", "cinema", "projects-view.tsx"]],
  ads: [
    ["components", "ads", "ads-home.tsx"],
    ["components", "ads", "multiplier.tsx"],
  ],
};

describe("the studios' examples", () => {
  it("has a row for every studio and tool without covers of its own: four each, none twice, and Mixed Media's one reveal", () => {
    expect([...studios].sort()).toEqual([...COMPOSER, ...HUBS, ...Object.keys(ROW_IN), "mixed-media"].sort());
    for (const s of studios) {
      const ids = STUDIO_EXAMPLES[s].tiles.map((e) => e.id);
      expect(ids, s).toHaveLength(s === "mixed-media" ? 1 : 4);
      expect(new Set(ids).size, s).toBe(ids.length);
    }
  });

  it("says over Image's and Edit's apps that they are apps, over Mixed Media's reveal that it plays, and elsewhere what the studio makes", () => {
    for (const s of studios) {
      const heading = { image: "Or start from an app", edit: "Or start from an app", upscale: "Or start from an app", "mixed-media": "See a look play out" }[s as string] ?? "See what it makes";
      expect(studioExamples(s).heading, s).toBe(heading);
    }
  });

  it("names real presets (or a studio's own cover), each with its cover, its clip, its peak frame and their small copies", () => {
    for (const s of studios) {
      for (const { card } of studioExamples(s).tiles) {
        expect(getPreset(card.id) ?? (isStudioCover(card.id) ? STUDIO_COVERS[card.id] : undefined), card.id).toBeDefined();
        const cover = PRESET_PREVIEWS[card.id];
        expect(cover, `${card.id} has a real cover`).toBeDefined();
        expect(card.preview.poster, card.id).toBe(cover.poster);
        expect(exists(cover.poster), cover.poster).toBe(true);
        expect(exists(thumbOf(cover.poster)), thumbOf(cover.poster)).toBe(true);
        expect(cover.video, `${card.id} has a clip`).toBeDefined();
        expect(exists(cover.video!), cover.video).toBe(true);
        // An effect or an app rests on its peak frame (what it made), as on Home; a camera motion on its poster.
        if (card.id.startsWith("motion-")) expect(card.preview.rest, card.id).toBeUndefined();
        else {
          expect(PRESET_PEAKS[card.id], `${card.id} has a peak frame (node scripts/gen-preset-peaks.mjs ${card.id})`).toBeDefined();
          expect(exists(card.preview.rest!.src), card.preview.rest!.src).toBe(true);
          expect(exists(thumbOf(card.preview.rest!.src)), thumbOf(card.preview.rest!.src)).toBe(true);
        }
      }
    }
  });

  it("gives each a line that fits a phone's tile whole, and says what kind it is", () => {
    const wallKinds = new Map<string, string>(HOME_WALL.map((t) => [t.id, t.kind]));
    for (const s of studios) {
      for (const e of studioExamples(s).tiles) {
        expect(e.caption.length, e.card.id).toBeGreaterThan(0);
        expect(e.caption.length, e.card.id).toBeLessThanOrEqual(HOME_CAPTION_MAX.card);
        const type = getPreset(e.card.id)?.type;
        // An app whose cover wipes from a before to an after (Home's wall says so, or it has Home's HD pair) says so; a
        // studio's own cover names its studio.
        const kind = !type
          ? STUDIO_COVERS[e.card.id].category
          : type === "motion"
            ? "Camera motion"
            : type === "effect"
              ? "Effect"
              : (wallKinds.get(e.card.id) ?? (PRESET_BEFORE_AFTER[e.card.id] ? "App · before → after" : "App"));
        expect(e.kind, e.card.id).toBe(kind);
      }
    }
  });

  it("writes every line as plain copy: no model or maker, no status words, a sentence without a full stop", () => {
    const lines = studios.flatMap((s) => studioExamples(s).tiles.map((e) => [e.card.id, e.caption] as const));
    // Every line of EXAMPLE_LINES is shown by a row, and every line a row shows is checked here.
    const shown = new Set(lines.map(([id]) => id));
    for (const id of Object.keys(EXAMPLE_LINES)) expect(shown.has(id), `${id} is in no row`).toBe(true);
    const names = [...new Set(MODELS.flatMap((m) => [m.name, m.vendor]).filter((n) => n.trim().length >= 3))];
    const status = /\b(placeholder|demo|sample|beta|unverified|not checked|coming soon|todo|tbd|draft|gpu|comfy|lora|checkpoint)\b/i;
    for (const [id, line] of lines) {
      expect(line, id).toBe(line.trim());
      expect(line, id).toMatch(/^[A-Z]/);
      expect(line, id).not.toMatch(/[.!?;:]$/);
      expect(line, id).not.toMatch(status);
      for (const n of names) expect(line.toLowerCase().includes(n.toLowerCase()), `${id}: "${line}" names ${n}`).toBe(false);
    }
  });

  it("opens an app on its own page, picks a motion or effect in the Video studio, and opens a studio's cover in its studio", () => {
    for (const s of studios) {
      for (const e of studioExamples(s).tiles) {
        const href = isStudioCover(e.card.id)
          ? STUDIO_COVERS[e.card.id].href
          : getPreset(e.card.id)!.type === "app"
            ? `/apps/${e.card.id}`
            : `/video?preset=${e.card.id}`;
        expect(e.href, e.card.id).toBe(href);
      }
    }
    // Edit and Image show apps, Video shows what its studio picks.
    for (const s of ["image", "edit"] as const) for (const e of studioExamples(s).tiles) expect(getPreset(e.card.id)!.type, e.card.id).toBe("app");
    for (const e of studioExamples("video").tiles) expect(["motion", "effect"], e.card.id).toContain(getPreset(e.card.id)!.type);
  });

  it("shows Genjutsu's own group swap in its row, opening its Character swap mode on that example", () => {
    const row = studioExamples("genjutsu").tiles;
    const own = row.find((e) => e.card.id === "genjutsu-group-swap");
    expect(own, "Genjutsu's row has its group swap").toBeDefined();
    expect(own!.card.name).toBe("Group swap");
    expect(own!.caption).toBe("Two people swapped in one take");
    expect(own!.kind).toBe("Genjutsu");
    // No effect stands for Genjutsu: its row shows swaps of people.
    for (const e of row) expect(getPreset(e.card.id)?.type, e.card.id).not.toBe("effect");
    // Every studio cover's link names its studio and a mode of it; one that names an example names one of that mode
    // (plan.json). Home's lake swap is no example of the studio's: it opens Character swap.
    for (const [id, c] of Object.entries(STUDIO_COVERS)) {
      const url = new URL(c.href, "https://fuobe.com");
      expect(url.pathname, id).toBe(`/${c.category.toLowerCase()}`);
      // Kinetic's cover opens the scene it shows, by the scene's own name (kinetic-catalog.ts).
      if (c.category === "Kinetic") {
        const scene = KINETIC_SCENES.find((s) => s.slug === url.searchParams.get("scene"));
        expect(scene?.name, id).toBe(c.name);
        continue;
      }
      const modes: string[] = c.category === "Genjutsu" ? GENJUTSU_MODES.map((m) => m.id) : [];
      expect(modes, id).toContain(url.searchParams.get("mode"));
      if (!url.searchParams.has("example")) continue;
      const example = (plan as { id: string; surface: string }[]).find((r) => r.id === url.searchParams.get("example"));
      expect(example?.surface, id).toBe(`tool:${url.pathname.slice(1)}/${url.searchParams.get("mode")}`);
    }
    expect(STUDIO_COVERS["genjutsu-lake-swap"].href).toBe("/genjutsu?mode=character");
  });

  it("stays on the server: the pages and the rows take only the examples' types", () => {
    expect(read("lib", "studio-examples.ts")).toMatch(/^import "server-only";$/m);
    expect(read("lib", "examples", "catalog.ts")).toMatch(/^import "server-only";$/m);
    const page = read("components", "studio", "studio-page.tsx");
    expect(page).not.toMatch(/from "@\/lib\/(studio-examples|examples\/catalog)"/);
    const row = read("components", "studio", "example-row.tsx");
    expect(row).toMatch(/^import type \{ ExampleRowData \} from "@\/lib\/examples\/types";$/m);
    for (const [s, files] of Object.entries(ROW_IN)) {
      for (const f of files) {
        const code = read(...f);
        expect(code, f.join("/")).toMatch(/^import type \{ ExampleRowData \} from "@\/lib\/examples\/types";$/m);
        expect(code, f.join("/")).not.toMatch(/from "@\/lib\/(studio-examples|examples\/catalog)"/);
        // Ads Studio's row leaves out the cards its own ready brands already show (moreToTry, from its examples).
        expect(code, `${s}: ${f.join("/")}`).toMatch(/<ExampleRow row=\{(examples|moreToTry)\}/);
      }
    }
  });

  it("is passed on by every page that shows a row", () => {
    const pageOf = (...p: string[]) => read("app", "(studio)", ...p, "page.tsx");
    const surface = (s: string) => ((COMPOSER as readonly string[]).includes(s) ? `studio:${s}` : s === "cinema" || s === "ads" ? `suite:${s}` : `tool:${s}`);
    for (const s of [...COMPOSER, ...Object.keys(ROW_IN)]) expect(pageOf(s), s).toContain(`examples={exampleRow("${surface(s)}")}`);
    // Every hub mode finds its own row (its examples, else its hub's covers) and hands it to its studio.
    for (const s of HUBS) expect(pageOf(s), s).toContain(`<ModeSwitchStudio kind="${s}" />`);
    expect(read("components", "studio", "mode-switch-studio.tsx")).toMatch(/const examples = exampleRow\(/);
    // Ad Multiplier shows Ads Studio's row; Mixed Media's reveal opens "How it works".
    expect(pageOf("ads", "multiplier")).toContain('examples={exampleRow("suite:ads")}');
    expect(pageOf("mixed-media")).toContain('how={studioExamples("mixed-media")}');
    const mixed = read("components", "mixed-media", "mixed-studio.tsx");
    expect(mixed).toMatch(/<How onStart=\{[^}]+\} cloud=\{[^}]+\} reveal=\{how\} \/>/);
    expect(mixed).toMatch(/\{!!reveal\?\.tiles\.length && <HowReveal row=\{reveal\} \/>\}/);
    // A hub hands its row to its first mode's studio (the hub's own URL), as the Studio pages do.
    expect(read("components", "studio", "mode-switch-studio.tsx")).toMatch(/<StudioPage [^>]*examples=\{examples\} \/>/);
  });

  it("shows only once the feed is known to be empty, and a loaded example goes to its own studio's composer", () => {
    const page = read("components", "studio", "studio-page.tsx");
    // Its skeleton until the feed has answered; the cards then (a guest's after FEED_WAIT_MS at most), never for results.
    expect(page).toMatch(/\{!hasItems && !!examples\?\.cards\.length && <StudioExamples row=\{examples\} ready=\{!feed\.isPending\} \/>\}/);
    expect(page).toMatch(/if \(!ready && !\(guest && waited\)\) return skeleton;/);
    expect(page).toMatch(/if \(ready \|\| !guest\) return;/);
    expect(read("components", "studio", "composer.tsx")).toMatch(/bridgeRef\.pick = pickPreset;/);
    // Its own studio's composer, not a hidden studio's (one left earlier stays in the page).
    expect(page).toMatch(/document\.querySelectorAll<HTMLElement>\("\[data-studio\] \[data-composer\]"\)\]\.find\(\(el\) => el\.offsetParent !== null\)/);
    expect(page).toMatch(/^\s+data-studio$/m);
    // The first pick loads the move's card: only the card waits for its code, so the studio (and the focus) stays.
    expect(page).toMatch(/<Suspense fallback=\{null\}>\s*<ActivePresetHeader \/>\s*<\/Suspense>/);
  });
});
