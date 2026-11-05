import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NAV } from "@/components/nav-items";
import { APPS, EFFECTS, MODELS, MOTIONS, getPreset, modelCounts } from "@/lib/catalog";
import { CAMERA_MOVES } from "@/lib/catalog/cinema";
import { TEMPLATES } from "@/lib/catalog/marketing";
import { ASSIST_PROMPT_MAX, ASSIST_SUGGESTIONS, assistDraft } from "@/lib/assist";
import { HUB_MODES } from "@/lib/hubs";
import { NAV_ENTRIES } from "@/lib/nav-model";
import {
  HOME_BEFORE_AFTER,
  HOME_CAPTION_MAX,
  HOME_EFFECTS,
  HOME_MOTIONS,
  HOME_NEW_OPEN,
  HOME_OWN_SECTIONS,
  HOME_REVEALS,
  HOME_SKILLS,
  HOME_STUDIOS,
  HOME_TRY,
  HOME_WALL,
  homeShowcase,
  newOpenModels,
  presetHref,
  roundedDown,
} from "@/lib/home-showcase";
import { BENTO_CLIPS, BENTO_REEL } from "@/lib/home-bento";
import { PRESET_BEFORE_AFTER } from "@/lib/preset-before-after.generated";
import { onPeak, thumbOf } from "@/lib/preset-cards";
import { PRESET_PEAKS } from "@/lib/preset-peaks.generated";
import { PRESET_PREVIEWS } from "@/lib/preset-previews.generated";
import { STUDIO_COVERS, isStudioCover } from "@/lib/studio-covers";
import { mp4Seconds } from "./helpers/mp4-length";

// homeShowcase() is kept with "use cache" and cacheLife, which only a Next render reads.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));

/*
 * Home's showcase (src/lib/home-showcase.ts) against the catalog and the files in public/: every preset it names is
 * real, has its cover (and its clip where the slot plays one), shows once, and every number it quotes is the
 * catalog's own.
 */

const root = process.cwd();
/** Whether a cover URL's file is there (without its version, ?v=). */
const exists = (url: string) => (fs.statSync(path.join(root, "public", url.split("?")[0]), { throwIfNoEntry: false })?.size ?? 0) > 0;

/** Covers the reviews turned down: no real cover yet, or white bars at the sides (and Text Edit's white edge). */
const NO_COVER = ["app-fuobe-angles", "app-talking-photo", "motion-dolly-zoom-out", "motion-buckle-up"];
const WHITE_BARS = ["app-dance", "app-simlife", "app-game-dump", "app-japanese-show", "app-comic-book", "app-banana-eating", "app-change-background", "effect-boiling-point", "effect-color-rain", "app-text-edit"];
/** Studio cards that rest on a still: Marketing's product shot. */
const STILLS = ["app-macroshot-product"];
/**
 * Slots whose clip was taken down with the still it was made from (Flying's eagle had three wings): the card rests
 * on its new still until the new clip is published. Take an id out when its clip is back.
 */
const CLIP_PENDING = ["motion-flying"];

const studioIds = HOME_STUDIOS.flatMap((s) => (s.id ? [s.id] : []));
const rows = [...HOME_EFFECTS, ...HOME_MOTIONS, ...HOME_REVEALS];
/**
 * Every preset whose clip plays on Home under its own id: the 3D tile's, the rows, the before/after and the studio
 * cards. The video tile plays its reel (BENTO_REEL) under an id of its own, so a camera move in it may also have its card.
 */
const homeIds = [...Object.values(BENTO_CLIPS), ...rows.map((r) => r.id), ...HOME_BEFORE_AFTER.map((p) => p.id), ...studioIds];
/** Effects whose first frame is the strong one, so their card rests on the poster as the camera motions' do (none now). */
const ON_POSTER: string[] = [];
/** The frames at a clip cover's end crossfaded into its first ones (LOOP_FADE at 24 fps, scripts/eval/lib/covers.mjs). */
const LOOP_FADE_SECONDS = 6 / 24;

/** A cover clip's length (s). */
const clipSeconds = (url: string) => mp4Seconds(path.join(root, "public", url.split("?")[0]));

describe("Home's showcase", () => {
  it("names real presets (or a studio's own cover), each with its cover and, where the slot plays one, its clip", () => {
    for (const id of [...homeIds, ...BENTO_REEL]) {
      // A studio card may show a cover of its studio's own instead (studio-covers.ts): Genjutsu's lake swap.
      expect(getPreset(id) ?? (studioIds.includes(id) && isStudioCover(id) ? STUDIO_COVERS[id] : undefined), id).toBeDefined();
      const cover = PRESET_PREVIEWS[id];
      expect(cover, `${id} has a real cover`).toBeDefined();
      expect(exists(cover.poster), cover.poster).toBe(true);
      if (!STILLS.includes(id) && !(CLIP_PENDING.includes(id) && !cover.video)) {
        expect(cover.video, `${id} has a clip`).toBeDefined();
        expect(exists(cover.video!), cover.video).toBe(true);
      }
      expect(NO_COVER, id).not.toContain(id);
      expect(WHITE_BARS, id).not.toContain(id);
    }
    expect(fs.existsSync(path.join(root, "public", "previews", "presets", "thumbs", `${HOME_BEFORE_AFTER[0].id}.jpg`))).toBe(true);
  });

  it("shows each preset once (the playback store keys by id: a repeat would play in two places)", () => {
    expect(new Set(homeIds).size).toBe(homeIds.length);
  });

  it("rests effects and apps on their peak frame, cut and listed; camera motions on their poster", async () => {
    const home = await homeShowcase();
    const rowCards = [...home.effects, ...home.motions, ...home.reveals].map((r) => r.card);
    const cards = [...rowCards, ...home.studios.flatMap((s) => (s.card ? [s.card] : []))];
    for (const c of cards) {
      const peaked = !!PRESET_PEAKS[c.id];
      expect(!!c.preview.rest, c.id).toBe(peaked);
      if (c.preview.rest) {
        // With its version, which its small copy's URL keeps (thumbOf).
        const { at, from, v } = PRESET_PEAKS[c.id];
        expect(c.preview.rest).toEqual({ src: `/previews/presets/peak/${c.id}.jpg?v=${v}`, at, from });
        expect(exists(c.preview.rest.src), c.preview.rest.src).toBe(true);
        // Its 320 px copy, for a small screen (PresetPreview's sizes).
        expect(exists(thumbOf(c.preview.rest.src)), thumbOf(c.preview.rest.src)).toBe(true);
      }
      expect(exists(thumbOf(c.preview.poster)), thumbOf(c.preview.poster)).toBe(true);
      if (c.id.startsWith("motion-")) expect(c.preview.rest, c.id).toBeUndefined();
    }
    const peakedIds = [...HOME_EFFECTS, ...HOME_REVEALS, ...HOME_WALL.filter((t) => !t.id.startsWith("motion-"))].map((t) => t.id).filter((id) => !ON_POSTER.includes(id));
    for (const id of peakedIds) expect(PRESET_PEAKS[id], id).toBeDefined();
    for (const id of ON_POSTER) expect(PRESET_PEAKS[id], id).toBeUndefined();
    // The before/after: each app's HD stills (512 px, and 960 and 1280 px for sharper screens), with their version, so
    // none shows a small cover enlarged; the poster's small copy on its tab.
    for (const p of home.beforeAfter) {
      const v = PRESET_BEFORE_AFTER[p.id];
      expect(v, `${p.id} has HD stills (node scripts/gen-before-after.mjs)`).toBeDefined();
      for (const side of ["before", "after"] as const) {
        const url = (w: number) => `/previews/presets/ba/${w}/${p.id}-${side}.jpg?v=${v}`;
        expect(p[side]).toEqual({ src: url(512), hd: { 960: url(960), 1280: url(1280) } });
        for (const u of [p[side].src, p[side].hd![960], p[side].hd![1280]]) expect(exists(u), u).toBe(true);
      }
      expect(p.thumb).toBe(thumbOf(PRESET_PREVIEWS[p.id].poster));
      expect(exists(p.thumb), p.thumb).toBe(true);
      expect(p.tags).toHaveLength(2);
    }
    // Every cover URL Home gives (the first screen, the rows, the before/after, the studios' cards) carries its version (?v=),
    // and so does each small copy a tile asks for (thumbOf): a cover made again shows at once.
    const urls = [...JSON.stringify(home).matchAll(/"(\/previews\/[^"]*)"/g)].map((m) => m[1]);
    const stills = cards.flatMap((c) => [c.preview.poster, ...(c.preview.rest ? [c.preview.rest.src] : [])]);
    expect(urls.length).toBeGreaterThan(cards.length);
    for (const url of [...urls, ...stills.map(thumbOf)]) expect(url).toMatch(/^\/previews\/[^?]+\?v=[0-9a-f]{8}$/);
    // Every peak in the list has its file, and every file is in the list; a peak starts inside its clip's last second.
    const peakDir = path.join(root, "public", "previews", "presets", "peak");
    const files = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).map((f) => f.replace(/\.jpg$/, "")).sort();
    expect(files(peakDir)).toEqual(Object.keys(PRESET_PEAKS).sort());
    expect(files(path.join(peakDir, "thumbs"))).toEqual(Object.keys(PRESET_PEAKS).sort());
    // A peak sits past the clip's still opening and before its closing crossfade, however long the clip is (4 s, or
    // its whole length where its cover keeps it); its loop comes back to a point before the peak.
    for (const [id, { at, from }] of Object.entries(PRESET_PEAKS)) {
      expect(PRESET_PREVIEWS[id]?.video, id).toBeDefined();
      const length = clipSeconds(PRESET_PREVIEWS[id].video!);
      expect(at, id).toBeGreaterThan(1);
      expect(at, id).toBeLessThan(length - LOOP_FADE_SECONDS);
      expect(from, id).toBeGreaterThan(0);
      expect(from, id).toBeLessThanOrEqual(at);
    }
    // The preset header rests on the same frame (onPeak), and a preset without one keeps its poster.
    const effect = home.effects.find((r) => r.card.id === "effect-nature-bloom")!.card;
    expect(onPeak({ ...effect, preview: { ...effect.preview, rest: undefined } }).preview.rest).toEqual(effect.preview.rest);
    const dolly = home.motions.find((r) => r.card.id === "motion-dolly-in")!.card;
    expect(onPeak(dolly)).toBe(dolly);
  });

  it("gives every card a short line that fits whole: a phone's wall tile, two lines of a row's card", async () => {
    for (const t of HOME_WALL) expect(t.caption.length, t.id).toBeLessThanOrEqual(HOME_CAPTION_MAX.wall);
    for (const r of rows) expect(r.caption.length, r.id).toBeLessThanOrEqual(HOME_CAPTION_MAX.card);
    const home = await homeShowcase();
    expect(home.effects.map((r) => [r.card.id, r.caption])).toEqual(HOME_EFFECTS.map((r) => [r.id, r.caption]));
  });

  it("links effects and motions to the Video studio with the preset picked, apps to their own page", async () => {
    expect(presetHref("effect-outfit-switch")).toBe("/video?preset=effect-outfit-switch");
    expect(presetHref("motion-glam")).toBe("/video?preset=motion-glam");
    expect(presetHref("app-relight")).toBe("/apps/app-relight");
    const home = await homeShowcase();
    for (const p of home.beforeAfter) expect(p.href).toBe(`/apps/${p.id}`);
    const routes = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
    for (const s of home.studios) expect(routes.has(s.href), s.href).toBe(true);
    for (const p of home.pills) expect(routes.has(p.href), p.href).toBe(true);
  });

  it("covers every place to create: the studio cards, the pills and the five with a section of their own", async () => {
    const home = await homeShowcase();
    const create = NAV.find((g) => g.label === "Create")!.items.filter((i) => i.href !== "/");
    const studios = NAV.find((g) => g.label === "Studios")!.items;
    expect(home.facts.destinations).toBe(create.length + studios.length);
    expect(home.studios.length + home.pills.length + HOME_OWN_SECTIONS.length).toBe(home.facts.destinations);
    const shown = [...home.studios.map((s) => s.href), ...home.pills.map((p) => p.href), ...HOME_OWN_SECTIONS];
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(shown)).toEqual(new Set([...create, ...studios].map((i) => i.href)));
    // Every studio of the navigation model is one of them, so each has a card or a pill and is counted (Kinetic Motion).
    for (const e of NAV_ENTRIES.filter((x) => x.kind === "studio" && x.group)) expect(shown, e.id).toContain(e.href);
    // The pills keep the sidebar's order and labels.
    const order = [...create, ...studios].map((i) => i.href);
    expect(home.pills.map((p) => order.indexOf(p.href))).toEqual(home.pills.map((p) => order.indexOf(p.href)).sort((a, b) => a - b));
    // Audio shows a real cover too: Clean up voice’s demo, as its page does.
    expect(home.studios.find((s) => s.href === "/audio")?.card?.id).toBe("app-clean-up-voice");
    expect(home.studios.every((s) => s.card)).toBe(true);
  });

  it("quotes the catalog's own numbers", async () => {
    const { facts, studios, audioTools } = await homeShowcase();
    const visible = MODELS.filter((m) => !m.hidden);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "manifest.json"), "utf8")) as { workflows: unknown[] };
    expect(facts.workflows).toBe(manifest.workflows.length);
    expect(facts.presets).toBe(APPS.length + MOTIONS.length + EFFECTS.length);
    expect([facts.apps, facts.motions, facts.effects]).toEqual([APPS.length, MOTIONS.length, EFFECTS.length]);
    expect(facts.originals).toBe(visible.filter((m) => m.vendor === "Fuobe Original").length);
    expect(facts.originals).toBeGreaterThan(0);
    // The open and partner models are the counts every page quotes (modelCounts: Home, /models, Project status, About).
    expect(facts.openModels).toBe(modelCounts().open);
    expect(facts.partners).toBe(modelCounts().cloud);
    expect(facts.partners).toBe(visible.filter((m) => m.engine === "cloud" && !m.engines?.includes("open")).length);
    expect(facts.cinemaMoves).toBe(CAMERA_MOVES.length);
    expect(facts.adTemplates).toBe(TEMPLATES.filter((t) => !t.ownerOnly).length);
    expect(facts.mixedLooks).toBe(EFFECTS.filter((e) => e.category === "Mixed Media").length);
    expect(facts.audioTools).toBe(HUB_MODES.audio.length);
    expect(facts.skills).toBe(fs.readdirSync(path.join(root, "skills")).filter((d) => fs.existsSync(path.join(root, "skills", d, "SKILL.md"))).length);
    // The studio cards' lines carry them.
    expect(studios.find((s) => s.href === "/cinema")?.line).toContain(`${facts.cinemaMoves} moves`);
    expect(studios.find((s) => s.href === "/marketing")?.line).toContain(`${facts.adTemplates} ad templates`);
    expect(studios.find((s) => s.href === "/mixed-media")?.line).toContain(`${facts.mixedLooks} looks`);
    expect(audioTools.named).toEqual(["Speech", "Dialogue", "Music", "Sound effects", "Split soundtrack"]);
    expect(audioTools.named.length + audioTools.more).toBe(HUB_MODES.audio.length);
  });

  it("rounds the open models down to ten, so the subtitle never overstates", () => {
    expect(roundedDown(131)).toBe("130+");
    expect(roundedDown(140)).toBe("140+");
    expect(roundedDown(149)).toBe("140+");
  });

  it("lists Just added from the catalog's live open models, newest first", () => {
    const models = newOpenModels();
    expect(models.length).toBeGreaterThanOrEqual(6);
    expect(models.length).toBeLessThanOrEqual(8);
    // A typo would hide a model: every id on the list is in the catalog.
    for (const id of HOME_NEW_OPEN) expect(MODELS.some((m) => m.id === id), id).toBe(true);
    const listed = HOME_NEW_OPEN.filter((id) => MODELS.some((m) => m.id === id && !m.hidden));
    expect(models.map((m) => m.id)).toEqual(listed.slice(0, 8));
    for (const m of models) expect(m.href).toMatch(/^\//);
    // A model not merged yet (or hidden) doesn't show, and the catalog's other new open models fill in.
    const fewer = newOpenModels(MODELS.filter((m) => !HOME_NEW_OPEN.slice(0, 10).includes(m.id)));
    expect(fewer.length).toBeGreaterThanOrEqual(6);
    for (const m of fewer) expect(HOME_NEW_OPEN.slice(0, 10)).not.toContain(m.id);
  });

  it("reads the starter skills from the skills folder", async () => {
    const { skills } = await homeShowcase();
    // The starter skills exist, each with its SKILL.md title.
    expect(skills.map((s) => s.name)).toEqual(HOME_SKILLS);
    for (const s of skills) expect(fs.readFileSync(path.join(root, "skills", s.name, "SKILL.md"), "utf8")).toContain(`title: ${s.title}`);
  });

  it("fills the composer from a Try chip in one of its three modes", () => {
    for (const c of HOME_TRY) {
      expect(["image", "video", "edit"]).toContain(c.mode);
      expect(c.prompt.length).toBeGreaterThan(c.label.length);
    }
    // The owner's three (Assist's chip takes the last one's place) show one of each.
    expect(new Set(HOME_TRY.slice(0, -1).map((c) => c.mode)).size).toBe(3);
  });
});

describe("Assist's address prefill", () => {
  it("types ?prompt= into a new chat (cut to its limit), and ?skill= wins over it; nothing is sent", () => {
    expect(assistDraft(null, ASSIST_SUGGESTIONS[0])).toBe(ASSIST_SUGGESTIONS[0]);
    expect(assistDraft(null, null)).toBe("");
    expect(assistDraft(null, "x".repeat(ASSIST_PROMPT_MAX + 50))).toHaveLength(ASSIST_PROMPT_MAX);
    expect(assistDraft("ugc-video", "ignored")).toBe("/ugc-video ");
    expect(assistDraft("Not a skill!", "ignored")).toBe("");
  });
});
