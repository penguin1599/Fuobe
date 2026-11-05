import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav-items";
import { APPS, EFFECTS, getPreset, MOTIONS } from "@/lib/catalog";
import { HUB_MODES } from "@/lib/hubs";
import { navCovers } from "@/lib/nav-covers";
import { NAV_ICONS } from "@/lib/nav-icons";
import {
  activeEntry,
  coverIds,
  entriesFor,
  entry,
  GOALS,
  goalBand,
  isNew,
  LAUNCHER_GROUPS,
  launcherColumns,
  launcherEntries,
  NAV_ENTRIES,
  STEP_COVERS,
  studioCount,
  tapHref,
  viewerKindOf,
  visibleTo,
  type ViewerKind,
} from "@/lib/nav-model";
import { PRESET_COVERS } from "@/lib/preset-covers.generated";
import { hubModePaths, studioRoutes } from "./e2e/_routes.mjs";

const root = path.resolve(__dirname, "..");
const routes = (() => {
  const { routes, patterns } = studioRoutes(root);
  return { paths: new Set([...routes, ...hubModePaths(root)]), patterns };
})();
const pathOf = (href: string) => href.split(/[?#]/)[0];
const q = (s = "") => new URLSearchParams(s);
const KINDS: (ViewerKind | undefined)[] = ["guest", "account", "owner", undefined];

/** The sidebar's 44 rows before the navigation model (origin/main), in their groups and order, and Kinetic Motion since. */
const OLD_NAV: [string, [string, string][]][] = [
  [
    "Create",
    [
      ["/", "Home"],
      ["/assist", "Assist"],
      ["/image", "Image"],
      ["/video", "Video"],
      ["/edit", "Edit"],
      ["/live-edit", "Live edit"],
      ["/layers", "Layers"],
      ["/inpaint", "Inpaint"],
      ["/color-grade", "Color grading"],
      ["/motions", "Camera motions"],
      ["/effects", "Effects"],
      ["/storyboard", "Storyboard"],
      ["/canvas", "Canvas"],
      ["/apps", "Apps"],
    ],
  ],
  [
    "Library",
    [
      ["/library", "All creations"],
      ["/library?tab=favorites", "Favorites"],
    ],
  ],
  [
    "Studios",
    [
      ["/cinema", "Cinema Studio"],
      ["/shorts", "Shorts Studio"],
      ["/mixed-media", "Mixed Media"],
      ["/marketing", "Marketing Studio"],
      ["/ads", "Ads Studio"],
      ["/kinetic", "Fuobe Kinetic Motion"],
      ["/moodboards", "Moodboards"],
      ["/photodump", "Photodump"],
      ["/fashion-factory", "Fashion Factory"],
      ["/character-sheet", "Character Sheet"],
      ["/influencer", "AI Influencer"],
      ["/faceless", "Faceless Studio"],
      ["/content-factory", "Content Factory"],
      ["/explainer", "Explainer"],
      ["/lipsync", "Lipsync & avatars"],
      ["/genjutsu", "Genjutsu"],
      ["/character-swap", "Character Swap"],
      ["/motion-control", "Motion control"],
      ["/video-edit", "Edit video"],
      ["/extend", "Extend video"],
      ["/reframe", "Reframe"],
      ["/video-tools", "Video tools"],
      ["/elements", "Elements"],
      ["/upscale", "Upscale"],
      ["/audio", "Audio"],
      ["/katana", "Katana"],
      ["/image-to-3d", "Image to 3D"],
      ["/virality", "Hook check"],
    ],
  ],
  ["More", [["/settings", "Settings"]]],
];

describe("nav model: entries", () => {
  it("has unique ids, and unique links apart from a hub's first mode (the hub's own page)", () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Audio's first mode, Clean up voice, has a row in the Sound column: it links its own page (the same tool as /audio).
    const firstModes = new Set(Object.entries(HUB_MODES).map(([hub, modes]) => `${hub}-${modes[0].id}`).filter((id) => id !== "audio-clean"));
    const hrefs = NAV_ENTRIES.filter((e) => !firstModes.has(e.id)).map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const id of firstModes) expect(entry(id)?.href).toBe(`/${entry(id)!.parent}`);
    expect(entry("audio-clean")?.href).toBe("/audio/clean");
  });

  it("links only to pages that exist (or a settings section, an action, the source)", () => {
    const form = ["settings-form.tsx", "gpu/account-gpu-section.tsx", "keys/your-keys.tsx", "owner-settings.tsx"]
      .map((f) => fs.readFileSync(path.join(root, "src/components", f), "utf8"))
      .join("\n");
    for (const e of NAV_ENTRIES) {
      if (e.href === "action:theme") continue;
      if (/^https:\/\/github\.com\//.test(e.href)) continue;
      if (e.href.startsWith("/login")) {
        expect(fs.existsSync(path.join(root, "src/app/login/page.tsx")), e.id).toBe(true);
        continue;
      }
      // An app's own page (/apps/<id>) is the dynamic /apps/[id] route, for an app the catalog has.
      const app = /^\/apps\/(app-[\w-]+)$/.exec(pathOf(e.href));
      if (app) {
        expect(routes.patterns, e.id).toContain("/apps/[id]");
        expect(APPS.some((a) => a.id === app[1]), `${e.id}: ${app[1]}`).toBe(true);
        continue;
      }
      expect(routes.paths.has(pathOf(e.href)), `${e.id} → ${e.href}`).toBe(true);
      const hash = e.href.split("#")[1];
      if (hash) expect(form, `${e.id}: section #${hash}`).toContain(`id="${hash}"`);
    }
  });

  it("keeps every link the sidebar had, with its label", () => {
    for (const [, rows] of OLD_NAV) for (const [href, label] of rows) expect(NAV_ENTRIES.find((e) => e.href === href)?.label, href).toBe(label);
  });

  it("derives the four groups (Create, Library, Studios, More) exactly as they were, with Kinetic Motion: 45 rows", () => {
    expect(NAV.map((g) => [g.label, g.items.map((i) => [i.href, i.label])])).toEqual(OLD_NAV);
    expect(NAV.flatMap((g) => g.items)).toHaveLength(45);
    expect(NAV.find((g) => g.label === "Studios")?.collapsible).toBe(true);
    // The same rows prefetch eagerly, with an icon each and search words.
    expect(
      NAV.flatMap((g) => g.items)
        .filter((i) => i.eager)
        .map((i) => i.href),
    ).toEqual(["/", "/assist", "/image", "/video", "/library"]);
    for (const i of NAV.flatMap((g) => g.items)) {
      expect(typeof i.icon === "function" || typeof i.icon === "object", i.href).toBe(true);
      expect(i.keywords?.length, i.href).toBeGreaterThan(0);
    }
    expect(NAV.flatMap((g) => g.items).find((i) => i.href === "/character-swap")?.short).toBe("Character swap");
  });

  it("names only icons the icon map has", () => {
    for (const e of NAV_ENTRIES) expect(Object.hasOwn(NAV_ICONS, e.icon), `${e.id}: ${e.icon}`).toBe(true);
    for (const g of GOALS) expect(Object.hasOwn(NAV_ICONS, g.icon), g.id).toBe(true);
  });

  it("gives every studio a group, a goal, a short line, a phone label and a real cover", () => {
    for (const e of NAV_ENTRIES.filter((x) => x.kind === "studio")) {
      expect(e.group, e.id).toBeTruthy();
      expect(e.goals.length, e.id).toBeGreaterThan(0);
      // A phone tile shows it on up to two lines of 12.
      expect(e.short, e.id).toBeTruthy();
      for (const w of e.short!.split(" ")) expect(w.length, e.id).toBeLessThanOrEqual(12);
      expect(Object.hasOwn(PRESET_COVERS, e.cover!), `${e.id}: ${e.cover}`).toBe(true);
    }
    for (const e of NAV_ENTRIES) {
      expect(e.what.length, `${e.id}: ${e.what}`).toBeLessThanOrEqual(34);
      expect(e.what, e.id).not.toMatch(/\.$/);
      if (e.kind === "presets") expect(Object.hasOwn(PRESET_COVERS, e.cover!), e.id).toBe(true);
      if (e.short) expect(e.short.length, e.id).toBeLessThanOrEqual(16);
    }
  });

  it("makes every hub mode a tool of its studio, owner-only modes for the owner only", () => {
    for (const [hub, modes] of Object.entries(HUB_MODES)) {
      for (const m of modes) {
        const e = entry(`${hub}-${m.id}`);
        expect(e?.kind, `${hub}/${m.id}`).toBe("tool");
        expect(e?.parent).toBe(hub);
        expect(e?.what).not.toBe(m.label);
        expect(!!e?.visibility, `${hub}/${m.id}`).toBe(!!m.ownerOnly);
        if (m.ownerOnly) expect(e?.visibility).toEqual(["owner"]);
      }
    }
    expect(entry("video-tools-captions")?.href).toBe("/video-tools/captions");
    expect(entry("audio-clean")?.href).toBe("/audio/clean");
  });

  it("marks only entries added after the first studios as new, and the badge ends", () => {
    const fresh = NAV_ENTRIES.filter((e) => e.newUntil).map((e) => e.id);
    expect(fresh.length).toBeLessThan(8);
    const day = (s: string) => Date.parse(s);
    for (const e of NAV_ENTRIES.filter((x) => x.newUntil)) {
      expect(isNew(e, day("2026-11-02"))).toBe(true);
      expect(isNew(e, day("2027-01-01"))).toBe(false);
    }
    expect(isNew(entry("cinema")!)).toBe(false);
  });
});

describe("nav model: launcher", () => {
  it("has 29 studios, Apps and four Audio modes in six columns of 8, 6, 6, 6, 5 and 3, one lead each", () => {
    expect(studioCount()).toBe(29);
    const cols = launcherColumns("owner");
    expect(cols.map((c) => c.group.id)).toEqual(["film", "social", "sell", "people", "sound", "finish"]);
    expect(cols.map((c) => 1 + c.rest.length)).toEqual([8, 6, 6, 6, 5, 3]);
    expect(cols.map((c) => c.lead.id)).toEqual(["cinema", "shorts", "marketing", "fashion-factory", "audio", "upscale"]);
    for (const g of LAUNCHER_GROUPS) expect(NAV_ENTRIES.filter((e) => e.group === g.id && e.lead)).toHaveLength(1);
    expect(launcherEntries("guest")).toHaveLength(34);
    expect(launcherEntries("guest", "sell").map((e) => e.id)).toEqual(["marketing", "ads", "kinetic", "mixed-media", "moodboards", "photodump"]);
    expect(launcherEntries(undefined, "finish").map((e) => e.id)).toEqual(["upscale", "image-to-3d", "apps"]);
    // Sound: the Audio studio, then Clean up voice (its first mode), music, sound effects, translate & dub; Lipsync stays in Social.
    expect(launcherEntries(undefined, "sound").map((e) => e.href)).toEqual(["/audio", "/audio/clean", "/audio/music", "/audio/sfx", "/audio/translate"]);
    expect(launcherEntries(undefined, "sound").map((e) => e.short)).toEqual(["Audio", "Clean up", "Music", "Sound effects", "Translate"]);
    expect(entry("audio-translate")?.label).toBe("Translate & dub");
    expect(entry("lipsync")?.group).toBe("social");
    for (const e of launcherEntries(undefined)) expect(Object.hasOwn(PRESET_COVERS, e.cover!), `${e.id}: ${e.cover}`).toBe(true);
    // Storyboard is a film studio now.
    expect(entry("storyboard")?.group).toBe("film");
  });

  it("shows the same 34 to everyone", () => {
    for (const k of KINDS) expect(launcherEntries(k).map((e) => e.id)).toEqual(launcherEntries("owner").map((e) => e.id));
  });
});

describe("nav model: who sees what", () => {
  const ids = (k: ViewerKind | undefined) => new Set(entriesFor(k).map((e) => e.id));
  const OWNER_ONLY = ["setting-cloud", "setting-comfyui", "setting-engine", "setting-loras", "setting-training", "setting-text-ai", "setting-assist-connectors", "setting-notifications", "setting-security", "setting-demo"];

  it("keeps the install's settings and its own tools from guests and accounts", () => {
    for (const k of ["guest", "account", undefined] as const) for (const id of OWNER_ONLY) expect(ids(k).has(id), `${k} sees ${id}`).toBe(false);
    for (const id of OWNER_ONLY) expect(ids("owner").has(id), id).toBe(true);
  });

  it("gives an account its own GPU, keys and account, and a guest the way in", () => {
    for (const id of ["your-gpu", "your-keys", "account", "connect", "thanks", "settings"]) expect(ids("account").has(id), id).toBe(true);
    for (const id of ["connect", "signup", "login", "thanks"]) expect(ids("guest").has(id), id).toBe(true);
    // Thanks & licences is everyone's to read; Models & licences' switches are the owner's.
    for (const k of ["guest", "account", undefined] as const) expect(ids(k).has("models-licences"), String(k)).toBe(false);
    for (const id of ["thanks", "models-licences"]) expect(ids("owner").has(id), id).toBe(true);
    for (const id of ["your-gpu", "your-keys", "account"]) expect(ids("guest").has(id), id).toBe(false);
    for (const id of ["signup", "login", "connect", "your-gpu"]) expect(ids("owner").has(id), id).toBe(false);
  });

  it("shows a viewer not known yet what a guest sees, and no more", () => {
    expect([...ids(undefined)]).toEqual([...ids("guest")]);
    expect(visibleTo(entry("setting-comfyui")!, undefined)).toBe(false);
  });

  it("reads the viewer as the sidebar did", () => {
    expect(viewerKindOf(undefined)).toBeUndefined();
    expect(viewerKindOf({ owner: true, publicSignup: true })).toBe("owner");
    expect(viewerKindOf({ owner: false, account: { email: "a@example.com" }, publicSignup: true })).toBe("account");
    expect(viewerKindOf({ owner: false, publicSignup: true })).toBe("guest");
    expect(viewerKindOf({ owner: false, publicSignup: false })).toBe("owner");
  });
});

describe("nav model: goal bands", () => {
  it("has the six goals in order, each with cards, one-tap presets and finishing links", () => {
    expect(GOALS.map((g) => g.id)).toEqual(["film", "social", "sell", "people", "edit", "sound"]);
    for (const g of GOALS) {
      const band = goalBand(g.id, "guest");
      expect(band.cards.length, g.id).toBeGreaterThanOrEqual(4);
      expect(band.cards.length, g.id).toBeLessThanOrEqual(5);
      expect(band.finish.length, g.id).toBeGreaterThanOrEqual(2);
      for (const c of band.cards) expect(c.cover, `${g.id}: ${c.id}`).toBeTruthy();
      expect(g.taps.length, g.id).toBeGreaterThanOrEqual(2);
    }
    expect(goalBand("sell", "guest").cards.map((e) => e.label)).toEqual(["Marketing Studio", "Ads Studio", "Photodump", "Mixed Media", "Moodboards"]);
    expect(GOALS.filter((g) => g.assist).map((g) => g.id)).toEqual(["film", "social", "sell"]);
  });

  it("taps only listed presets with real covers, of the kind it says", () => {
    const listed = new Set([...APPS, ...MOTIONS, ...EFFECTS].map((p) => p.id));
    const kinds = { App: "app", "Camera motion": "motion", Effect: "effect" } as const;
    for (const g of GOALS) {
      for (const t of g.taps) {
        expect(listed.has(t.preset), t.preset).toBe(true);
        expect(getPreset(t.preset)?.type, t.preset).toBe(kinds[t.kind]);
        expect(Object.hasOwn(PRESET_COVERS, t.preset), t.preset).toBe(true);
      }
    }
    expect(tapHref("app-giant-product")).toBe("/apps/app-giant-product");
    expect(tapHref("motion-drone-reveal")).toBe("/video?preset=motion-drone-reveal");
  });
});

describe("nav model: the current page", () => {
  const at = (pathname: string, search = "") => activeEntry(pathname, q(search))?.id;

  it("finds the entry a path is on, the best match winning", () => {
    expect(at("/")).toBe("home");
    expect(at("/cinema")).toBe("cinema");
    expect(at("/cinema/abc123")).toBe("cinema");
    expect(at("/library")).toBe("library");
    expect(at("/library", "tab=favorites")).toBe("favorites");
    expect(at("/settings")).toBe("settings");
    expect(at("/settings/models")).toBe("models-licences");
    expect(at("/settings/licences")).toBe("thanks");
    expect(at("/apps/app-face-swap")).toBe("apps");
    expect(at("/nowhere")).toBeUndefined();
  });

  it("counts a hub's modes and a studio's own pages as the studio", () => {
    expect(at("/audio/clean")).toBe("audio");
    expect(at("/upscale/video")).toBe("upscale");
    expect(at("/video-tools/captions")).toBe("video-tools");
    expect(at("/marketing/click-to-ad")).toBe("marketing");
    expect(at("/assist/skills")).toBe("assist");
  });
});

describe("nav model: covers", () => {
  it("names every cover it shows, and every one resolves to a versioned still and its small copy", () => {
    const ids = coverIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of NAV_ENTRIES) if (e.cover) expect(ids).toContain(e.cover);
    for (const id of Object.values(STEP_COVERS)) expect(ids).toContain(id);
    const covers = navCovers();
    expect(Object.keys(covers).sort()).toEqual([...ids].sort());
    for (const [id, c] of Object.entries(covers)) {
      expect(c.poster, id).toMatch(/^\/previews\/[^?]+\.jpg\?v=[0-9a-f]{8}$/);
      expect(c.thumb, id).toMatch(/^\/previews\/[^?]+\/thumbs\/[^?/]+\.jpg\?v=[0-9a-f]{8}$/);
    }
    // Small enough to pass down from the layout on every page.
    expect(JSON.stringify(covers).length).toBeLessThan(12_000);
  });
});
