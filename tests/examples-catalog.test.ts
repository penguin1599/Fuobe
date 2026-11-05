import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getModel, getPreset, MODELS } from "@/lib/catalog";
import type { StudioConfig } from "@/components/studio/studio-context";
import { HOME_CAPTION_MAX } from "@/lib/home-showcase";
import { HUB_MODES, type HubKind } from "@/lib/hubs";
import { GENJUTSU_MODES } from "@/lib/catalog/genjutsu";
import { appStudio, EDIT_STUDIO, IMAGE_STUDIO, INPAINT_STUDIO, UPSCALE_STUDIO, VIDEO_STUDIO } from "@/lib/studios";
import { EXAMPLE_MEDIA } from "@/lib/examples/media.generated";
import { STUDIO_COVERS, isStudioCover } from "@/lib/studio-covers";
import { EXAMPLE_CAPTION_MAX, EXAMPLE_WORDS_MAX, EXAMPLES_HEADING, MORE_HEADING, exampleFits, type ExampleCard, type ExampleMedia } from "@/lib/examples/types";
import type { Draft } from "@/components/studio/studio-context";

// home-showcase.ts (which the fallback rows borrow from) imports next/cache for its own showcase.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));

const { PLAN, FALLBACK_ROWS, MODE_FALLBACK, MAX_CARDS, exampleById, exampleRow, examplesFor, exampleSurfaceOf, exampleSurfaces, splitSurface } = await import("@/lib/examples/catalog");
const { isExampleRef } = await import("@/server/example-files");
const { applyExample, initialDraft } = await import("@/components/studio/draft");
const { buildRequest } = await import("@/components/studio/build-request");

/*
 * "Start from an example" (src/lib/examples): every example on every page against the catalog and the files in public/.
 * Each names a real page, preset, setting and file; what a tap puts in the composer is the run the example was made
 * with; every word a visitor reads is plain; and the files stay small enough for a phone.
 */

const root = process.cwd();
const publicFile = (src: string) => path.join(root, "public", src.split("?")[0]);
const cards = PLAN.map((r) => exampleById(r.id)!);
const lookup = { getModel, getPreset };

/** Each surface kind's page file: studio, hub and tool names are routes under src/app/(studio). */
function pageExists(surface: string): boolean {
  const [kind, name] = splitSurface(surface);
  if (kind === "app" || kind === "preset") return !!getPreset(name);
  if (kind === "hub") {
    const [hub, mode] = name.split("/");
    if (!(hub in HUB_MODES)) return false;
    return !mode || HUB_MODES[hub as HubKind].some((m) => m.id === mode);
  }
  // A Genjutsu mode's examples: the Genjutsu page, on that mode (?mode=).
  const genjutsu = /^genjutsu\/([a-z]+)$/.exec(name);
  if (kind === "tool" && genjutsu) return GENJUTSU_MODES.some((m) => m.id === genjutsu[1]);
  return fs.existsSync(path.join(root, "src", "app", "(studio)", ...name.split("/"), "page.tsx"));
}

/** The composer an example's surface loads into. */
const STUDIO_OF: Record<string, StudioConfig> = {
  "studio:image": IMAGE_STUDIO,
  "studio:video": VIDEO_STUDIO,
  "studio:edit": EDIT_STUDIO,
  "studio:inpaint": INPAINT_STUDIO,
  "hub:upscale": UPSCALE_STUDIO,
};
function configOf(surface: string): StudioConfig {
  const [kind, name] = splitSurface(surface);
  if (kind === "app") return appStudio(getPreset(name)!);
  if (kind === "preset") return VIDEO_STUDIO;
  return STUDIO_OF[surface] ?? (() => { throw new Error(`no composer for ${surface}`); })();
}

const allMedia = (c: ExampleCard): ExampleMedia[] => [...c.inputs.map((i) => i.media), c.output];

describe("the examples' catalog", () => {
  it("gives every example a unique id on a page that exists", () => {
    expect(PLAN.length).toBeGreaterThan(0);
    expect(new Set(PLAN.map((r) => r.id)).size).toBe(PLAN.length);
    for (const r of PLAN) {
      expect(pageExists(r.surface), `${r.id}: ${r.surface}`).toBe(true);
      expect(r.id.startsWith(`${splitSurface(r.surface)[1].replace(/\//g, "-")}.`), `${r.id} is named after ${r.surface}`).toBe(true);
    }
    for (const s of Object.keys(FALLBACK_ROWS)) expect(pageExists(s), s).toBe(true);
    // An app whose page sends the visitor elsewhere (next.config.ts redirects) would never show its example.
    const redirected = [...fs.readFileSync(path.join(root, "next.config.ts"), "utf8").matchAll(/source: "\/apps\/:id\(([^)]+)\)"/g)].flatMap((m) => m[1].split("|"));
    expect(redirected.length).toBeGreaterThan(0);
    for (const r of PLAN) if (r.surface.startsWith("app:")) expect(redirected, r.id).not.toContain(splitSurface(r.surface)[1]);
  });

  it("names presets that match their page, settings that exist and models that exist", () => {
    for (const r of PLAN) {
      const [kind, name] = splitSurface(r.surface);
      const card = exampleById(r.id)!;
      if (card.load.via !== "draft") continue;
      const req = card.load.request;
      if (kind === "app" || kind === "preset") expect(req.presetId, r.id).toBe(name);
      if (req.presetId) expect(getPreset(req.presetId), r.id).toBeTruthy();
      if (req.modelId) expect(getModel(req.modelId), r.id).toBeTruthy();
      const preset = req.presetId ? getPreset(req.presetId) : undefined;
      for (const [k, v] of Object.entries(req.presetOptions ?? {})) {
        const option = preset?.options?.find((o) => o.key === k);
        expect(option, `${r.id}: option ${k}`).toBeTruthy();
        expect(option!.choices.some((c) => c.value === v), `${r.id}: ${k}=${v}`).toBe(true);
      }
    }
  });

  it("puts each file in a slot that takes its kind: two pictures for a two-picture app, an end frame for a transition, a painted area for an inpaint", () => {
    for (const r of PLAN) {
      const preset = r.presetId || splitSurface(r.surface)[0] === "app" || splitSurface(r.surface)[0] === "preset" ? getPreset(r.presetId ?? splitSurface(r.surface)[1]) : undefined;
      const card = exampleById(r.id)!;
      if (card.load.via !== "draft") continue;
      const inputs = card.load.request.inputs;
      if (preset?.type === "app") {
        const required = preset.inputs.filter((s) => s.required);
        const images = required.filter((s) => s.accept === "image").length;
        expect(inputs.images?.length ?? 0, `${r.id}: its pictures`).toBeGreaterThanOrEqual(images);
        for (const s of required.filter((x) => x.accept !== "image")) expect(inputs[s.key as "video" | "audio"], `${r.id}: ${s.key}`).toBeTruthy();
      }
      if (preset && /transition/.test(preset.id) && preset.inputs.some((s) => s.key === "endImage" && s.required)) expect(inputs.endImage, `${r.id}: its end frame`).toBeTruthy();
      if (r.surface === "studio:inpaint") {
        expect(inputs.mask, `${r.id}: its painted area`).toBeTruthy();
        expect(inputs.images?.length, r.id).toBe(1);
      }
    }
  });

  it("lists every file a run reads as a published input, and every file a card shows is in public/ at the size the list says", () => {
    for (const c of cards) {
      if (c.load.via === "draft") {
        const { images = [], ...single } = c.load.request.inputs;
        for (const ref of [...images, ...Object.values(single).filter((v): v is string => typeof v === "string")]) {
          expect(isExampleRef(ref), `${c.id}: ${ref}`).toBe(true);
          expect(fs.statSync(publicFile(ref)).size, ref).toBe(EXAMPLE_MEDIA[ref].bytes);
        }
      }
      for (const m of allMedia(c)) {
        for (const src of [m.src, m.thumb, m.poster, m.rest?.src].filter((s): s is string => !!s)) {
          expect(fs.existsSync(publicFile(src)), `${c.id}: ${src}`).toBe(true);
          const listed = EXAMPLE_MEDIA[src.split("?")[0]];
          if (listed) {
            expect(fs.statSync(publicFile(src)).size, src).toBe(listed.bytes);
            if (src.includes("?v=")) expect(src.endsWith(`?v=${listed.v}`), src).toBe(true);
          }
        }
      }
    }
  });

  it("loads into the composer the very run the example was made with", () => {
    for (const r of PLAN) {
      const card = exampleById(r.id)!;
      if (card.load.via !== "draft") continue;
      const ex = card.load.request;
      const config = configOf(r.surface);
      for (const engine of ["cloud", "open"] as const) {
        const sp = new URLSearchParams(ex.presetId && ex.presetId !== config.preset?.id ? { preset: ex.presetId } : {});
        const base = initialDraft(config, sp, engine, lookup);
        const draft = applyExample(ex, base, config, lookup);
        const run = buildRequest(config.feature, draft, undefined);
        const label = `${r.id} (${engine})`;
        expect(run.presetId, label).toBe(ex.presetId ?? config.preset?.id);
        expect(run.prompt, label).toBe(ex.prompt ?? "");
        expect(run.presetOptions, label).toEqual(ex.presetOptions ?? {});
        const sent = Object.fromEntries(Object.entries(run.inputs ?? {}).filter(([, v]) => v !== undefined));
        expect(sent, label).toEqual(ex.inputs);
        if (ex.modelId) expect(run.modelId, label).toBe(ex.modelId);
        for (const [k, v] of Object.entries(ex.params ?? {})) expect(run.params?.[k as keyof typeof run.params], `${label}: ${k}`).toEqual(v);
      }
    }
  });

  it("takes off a Color signature and Moodboard picked before the example (the composer merges what it gets)", () => {
    const card = exampleById(PLAN.find((r) => r.surface === "studio:image")!.id)!;
    expect(card.load.via).toBe("draft");
    const ex = (card.load as { request: Parameters<typeof applyExample>[0] }).request;
    const base = initialDraft(IMAGE_STUDIO, new URLSearchParams(), "cloud", lookup);
    const signed: Draft = { ...base, prompt: "my own words", signature: { palette: { id: "x" }, moodboard: { id: "y" } } as unknown as Draft["signature"] };
    const patch = applyExample(ex, base, IMAGE_STUDIO, lookup);
    expect("signature" in patch).toBe(true);
    // As setDraft applies it: the patch over the draft on screen.
    const draft = { ...signed, ...patch };
    expect(draft.signature).toBeUndefined();
    const run = buildRequest(IMAGE_STUDIO.feature, draft, undefined);
    expect(run.prompt).toBe(ex.prompt ?? "");
    expect((run as { signature?: unknown }).signature).toBeUndefined();
  });

  it("writes every line a visitor reads as plain copy: short, no model or maker, no status words, no prompt markup", () => {
    expect(EXAMPLE_CAPTION_MAX).toBeLessThanOrEqual(HOME_CAPTION_MAX.card);
    // Names as they are written (a maker's name that is also a word, "down the runway", is fine in lower case), less the
    // few that are plain verbs a visitor uses ("Relight it with warm sun").
    const WORDS = new Set(["Relight", "Runway"]);
    const names = [...new Set(MODELS.flatMap((m) => [m.name, m.vendor]).filter((n): n is string => !!n && n.trim().length >= 3 && !WORDS.has(n)))];
    const named = names.map((n) => [n, new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)] as const);
    const status = /\b(unverified|not checked|todo|tbd|test|placeholder|preview made with|gpu|comfy|lora|checkpoint)\b/i;
    const markup = /<image|picture 1|\{option|\[shot/i;
    const problems: string[] = [];
    for (const c of cards) {
      if (!c.caption.length || c.caption.length > EXAMPLE_CAPTION_MAX) problems.push(`${c.id}: its caption is ${c.caption.length} characters`);
      if (c.words && c.words.length > EXAMPLE_WORDS_MAX) problems.push(`${c.id}: its words are ${c.words.length} characters`);
      const texts = [c.caption, c.words ?? "", ...(c.chips ?? []), ...c.inputs.map((i) => i.label ?? "")];
      for (const t of texts) {
        if (status.test(t)) problems.push(`${c.id}: "${t}" has a status word`);
        if (markup.test(t)) problems.push(`${c.id}: "${t}" has prompt markup`);
        for (const [n, re] of named) if (re.test(t)) problems.push(`${c.id}: "${t}" names ${n}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("shows one to four cards a page, premium first, and a heading that says what they do", () => {
    const short: string[] = [];
    for (const s of exampleSurfaces()) {
      const list = examplesFor(s as never);
      expect(list.length, s).toBeGreaterThanOrEqual(1);
      expect(list.length, s).toBeLessThanOrEqual(MAX_CARDS);
      const ranks = list.map((c) => PLAN.find((r) => r.id === c.id)!.rank);
      expect([...ranks].sort((a, b) => a - b), s).toEqual(ranks);
      expect(exampleRow(s as never)?.heading, s).toBe(EXAMPLES_HEADING);
      if (list.length < 2) short.push(s);
    }
    // Surfaces with one example so far (more come later): printed, not failed.
    if (short.length) console.log(`${short.length} pages have one example so far`);
    for (const s of Object.keys(FALLBACK_ROWS)) {
      const row = exampleRow(s as never);
      expect(row, s).toBeTruthy();
      if (!examplesFor(s as never).length) {
        expect(row!.heading, s).toBe(MORE_HEADING);
        for (const c of row!.cards) {
          expect(c.load, c.id).toMatchObject({ via: "look" });
          // A studio's own cover opens its studio (studio-covers.ts); a preset's its own page.
          const cover = c.id.replace(/^more\./, "");
          if (isStudioCover(cover)) expect((c.load as { href?: string }).href, c.id).toBe(STUDIO_COVERS[cover].href);
          else expect((c.load as { href?: string }).href, c.id).toMatch(/^\/(apps\/app-[a-z0-9-]+|video\?preset=[a-z0-9-]+)$/);
        }
      }
    }
    // A hub's other modes: their own examples, or only the hub's covers that fit them (MODE_FALLBACK); else no row.
    for (const [hub, modes] of Object.entries(HUB_MODES)) {
      for (const m of modes.slice(1)) {
        const surface = `hub:${hub}/${m.id}`;
        const row = exampleRow(surface as never);
        if (examplesFor(surface as never).length) continue;
        const fits = MODE_FALLBACK[surface];
        if (!fits) expect(row, `${surface} borrows nothing`).toBeNull();
        else expect(row?.cards.map((c) => c.id.replace(/^more\./, "")), surface).toEqual(fits);
      }
    }
    // Video upscale, FPS Boost, SDR to HDR and Export never show a still photo's app.
    for (const m of ["video", "fps", "hdr", "export"]) expect(exampleRow(`hub:upscale/${m}` as never), m).toBeNull();
    // Every row names its page, so a linked example loads only where it belongs.
    for (const s of [...exampleSurfaces(), ...Object.keys(FALLBACK_ROWS)]) expect(exampleRow(s as never)?.surface, s).toBe(s);
  });

  it("loads a linked example only on its own page (or a motion's, an effect's or a clip app's in the Video studio)", () => {
    expect(exampleSurfaceOf("effect-levitation.1")).toBe("preset:effect-levitation");
    expect(exampleFits("preset:effect-levitation", "studio:video")).toBe(true);
    expect(exampleFits("app:app-dance", "studio:video")).toBe(true);
    expect(exampleFits("preset:effect-levitation", "studio:image")).toBe(false);
    expect(exampleFits("studio:image", "studio:edit")).toBe(false);
    expect(exampleFits("app:app-relight", "app:app-relight")).toBe(true);
    expect(exampleFits("app:app-relight", "app:app-face-swap")).toBe(false);
    expect(exampleFits("studio:image", undefined)).toBe(false);
    expect(exampleFits(undefined, "studio:video")).toBe(false);
  });

  it("reads every input from Fuobe's own copies, never a file another script rewrites", () => {
    for (const r of PLAN) for (const ref of Object.values(r.inputs)) expect(ref, r.id).toMatch(/^\/(examples|samples)\//);
    for (const [p, f] of Object.entries(EXAMPLE_MEDIA)) if (f.role === "in") expect(p).toMatch(/^\/(examples|samples)\//);
    // A clip's card rests on a still where the change shows: the cover's own peak, or the example's.
    for (const c of cards) if (c.output.kind === "video") expect(c.output.rest?.src, c.id).toBeTruthy();
  });

  it("keeps the files small for a phone, and each card small for the page", () => {
    for (const [p, f] of Object.entries(EXAMPLE_MEDIA)) {
      if (/\.384\.webp$/.test(p)) expect(f.bytes, p).toBeLessThanOrEqual(40_000);
      else if (f.role === "in" && f.type.startsWith("image/")) expect(f.bytes, p).toBeLessThanOrEqual(300_000);
      else if (f.role === "in" && f.type.startsWith("video/")) expect(f.bytes, p).toBeLessThanOrEqual(3_000_000);
      else if (f.type.startsWith("video/")) expect(f.bytes, p).toBeLessThanOrEqual(1_500_000);
    }
    for (const c of cards) expect(JSON.stringify(c).length, c.id).toBeLessThanOrEqual(1_500);
  });
});
