import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL3D_MODES, readModel3dLink } from "@/lib/av/model3d";
import { GENJUTSU_MODES, modeOpen } from "@/lib/catalog/genjutsu";
import { HUB_MODES, type HubKind } from "@/lib/hubs";
import { megaSubs, studiosMenu } from "@/lib/mega-menus";
import { megaCurrent } from "@/components/nav/mega-launcher";
import { areaSections } from "@/lib/nav-areas";
import {
  entriesFor,
  entry,
  launcherEntries,
  NAV_ENTRIES,
  OWNER_RUNS,
  STUDIO_SUBS,
  studioSubs,
  subActive,
  subLabel,
  subParent,
  visibleTo,
  type ViewerKind,
} from "@/lib/nav-model";
import { navSearchEntries, searchNav } from "@/lib/nav-search";
import { genjutsuLive } from "@/server/genjutsu-live";

/*
 * What each studio holds inside (its tabs and modes) in the top nav: the catalogue (STUDIO_SUBS) and the links the
 * Studios menu, the phone's Studios sheet, /studios and search make of it. Every link opens a real page on the right
 * tab, by the studio's own name for it, and what is the owner's stays the owner's.
 */

const root = path.join(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const KINDS = [undefined, "guest", "account", "owner"] as const;
const VISITORS = [undefined, "guest", "account"] as const;
const subs = () => Object.entries(STUDIO_SUBS).flatMap(([parent, s]) => s.ids.map((id) => ({ parent, id, e: entry(id)! })));

/** The page file a path is served by (a folder of its own, else a dynamic [segment] folder beside it). */
function pageFile(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  let dir = path.join(root, "src/app/(studio)");
  for (const p of parts) {
    const own = path.join(dir, p);
    if (fs.existsSync(own)) {
      dir = own;
      continue;
    }
    const dynamic = fs.readdirSync(dir).find((d) => /^\[[^.]+\]$/.test(d));
    if (!dynamic) return undefined;
    dir = path.join(dir, dynamic);
  }
  const file = path.join(dir, "page.tsx");
  return fs.existsSync(file) ? file : undefined;
}

describe("the catalogue of studio features", () => {
  it("names only entries of the navigation model, each under one studio, a tool of it (Ads Studio is a studio of Marketing's suite)", () => {
    const seen = new Set<string>();
    for (const { parent, id, e } of subs()) {
      expect(e, id).toBeDefined();
      expect(entry(parent), parent).toBeDefined();
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      if (id === "ads") expect(e.kind).toBe("studio");
      else expect([e.kind, e.parent], id).toEqual(["tool", parent]);
    }
    expect(subParent("ads")).toBe("marketing");
    expect(entry("ads-multiplier")!.parent).toBe("marketing");
  });

  it("links every feature to a page that exists", () => {
    for (const { id, e } of subs()) {
      const [pathname] = e.href.split("?");
      expect(pageFile(pathname), `${id}: ${e.href}`).toBeDefined();
    }
    // A hub mode's [mode] page knows the mode.
    for (const { e } of subs().filter((s) => s.parent in HUB_MODES)) {
      const [, hub, mode] = e.href.split("/");
      if (mode) expect(HUB_MODES[hub as HubKind].some((m) => m.id === mode), e.href).toBe(true);
    }
  });

  it("opens the right tab: every ?mode= and ?tab= is one the studio's page reads", () => {
    const query = (id: string) => new URLSearchParams(entry(id)!.href.split("?")[1] ?? "");
    for (const id of STUDIO_SUBS.genjutsu.ids) expect(GENJUTSU_MODES.map((m) => m.id), id).toContain(query(id).get("mode"));
    expect(read("src/components/genjutsu/genjutsu-studio.tsx")).toMatch(/fresh\("mode"\)/);
    for (const id of STUDIO_SUBS["image-to-3d"].ids) expect(MODEL3D_MODES.map((m) => m.id), id).toContain(query(id).get("mode"));
    // Image to 3D reads its link through readModel3dLink (src/lib/av/model3d.ts), which takes ?mode=.
    expect(read("src/components/model3d/model3d-studio.tsx")).toContain("readModel3dLink(params)");
    for (const id of STUDIO_SUBS["image-to-3d"].ids) expect(readModel3dLink(query(id)).mode, id).toBe(query(id).get("mode"));
    const sheet = read("src/components/fashion/character-sheet.tsx");
    expect(sheet).toContain('<TabFromLink param="mode" ids={MODE_IDS}');
    for (const id of STUDIO_SUBS["character-sheet"].ids) expect(sheet, id).toContain(`["${query(id).get("mode")}", "${entry(id)!.label}"]`);
    const dump = read("src/components/photodump/photodump-view.tsx");
    expect(dump).toContain('<TabFromLink param="tab" ids={TAB_IDS}');
    expect(dump).toContain(`["${query("photodump-instadump").get("tab")}", "From a selfie"]`);
    expect(read("src/components/canvas/canvas-list.tsx")).toContain('params.get("tab") === "skills"');
    // Cinema reads ?blockout=1 (and World mode's ?world=1) in its project list.
    expect(read("src/components/cinema/projects-view.tsx")).toContain('params.get("blockout") === "1"');
  });

  it("calls every feature by its studio's own name for it", () => {
    for (const m of GENJUTSU_MODES) expect(entry(`genjutsu-${m.id}`)?.label, m.id).toBe(m.label);
    for (const m of MODEL3D_MODES) expect(entry(`image-to-3d-${m.id}`)?.label, m.id).toBe(m.label);
    for (const hub of Object.keys(HUB_MODES) as HubKind[]) for (const m of HUB_MODES[hub]) expect(subLabel(entry(`${hub}-${m.id}`)!), m.id).toBe(m.label);
    const suite = read("src/components/marketing/shell.tsx");
    for (const id of STUDIO_SUBS.marketing.ids) expect(suite, id).toContain(`href: "${entry(id)!.href}", label: "${entry(id)!.label}"`);
    const rail = read("src/components/assist/shell.tsx");
    for (const id of STUDIO_SUBS.assist.ids) expect(rail, id).toContain(`href="${entry(id)!.href}" icon={`);
    for (const id of STUDIO_SUBS.assist.ids) expect(rail, id).toContain(`label="${entry(id)!.label}"`);
    expect(read("src/components/canvas/canvas-list.tsx")).toContain(entry("canvas-skills")!.label);
    expect(read("src/components/cinema/blockout-panel.tsx")).toContain(`>${entry("cinema-blockout")!.label}<`);
  });
});

describe("who sees a studio's features", () => {
  it("keeps the owner's own modes the owner's, in every place", () => {
    // Restore & colourise shows to everyone, labelled: it runs on a visitor's own GPU or key (own-setup.ts).
    expect(entry("video-tools-restore")!.visibility).toBeUndefined();
    for (const kind of VISITORS) expect(entriesFor(kind).some((e) => e.id === "video-tools-restore"), kind).toBe(true);
    for (const id of ["canvas-skills", "assist-memory", "assist-scheduled"]) {
      expect(entry(id)!.visibility, id).toEqual(["owner"]);
      for (const kind of VISITORS) expect(entriesFor(kind).some((e) => e.id === id), `${kind}: ${id}`).toBe(false);
    }
    for (const kind of VISITORS) {
      for (const parent of Object.keys(STUDIO_SUBS)) {
        for (const place of ["list", "sheet", "menu"] as const) for (const e of studioSubs(parent, kind, place)) expect(visibleTo(e, kind), `${kind} ${place}: ${e.id}`).toBe(true);
      }
      const menu = studiosMenu(kind).columns.flatMap((c) => [c.lead!, ...c.rows]).flatMap((e) => e.subs ?? []);
      for (const s of menu.filter((x) => !x.more)) expect(entry(s.id)!.visibility ?? [], `${kind}: ${s.id}`).not.toEqual(["owner"]);
      const hub = areaSections("studios", kind).flatMap((s) => (s.subs ?? []).flatMap((x) => x.ids));
      for (const id of hub) expect(visibleTo(entry(id)!, kind), `${kind}: ${id}`).toBe(true);
    }
  });

  it("links Cinema Studio's Blockout for everyone: a guest sees it (and is offered a free account on a run), an account uses it", () => {
    expect(entry("cinema-blockout")!.visibility).toBeUndefined();
    expect(OWNER_RUNS.has("cinema-blockout")).toBe(false);
    for (const kind of [...VISITORS, "owner" as const]) {
      expect(studioSubs("cinema", kind, "list").map((e) => e.id), String(kind)).toEqual(["cinema-blockout"]);
      expect(studioSubs("cinema", kind, "sheet").map((e) => e.id), String(kind)).toEqual(["cinema-blockout"]);
      // The Studios menu's Cinema column has no room for it, for anyone, as before: the sheet, /studios and search carry it.
      expect(studioSubs("cinema", kind, "menu"), String(kind)).toEqual([]);
    }
    // It opens the project list on Blockout: with no project yet (a guest, a new account) the list says to start one, and
    // a guest's New project is the free sign-up card.
    const list = read("src/components/cinema/projects-view.tsx");
    expect(list).toContain("Blockout to film: start a new project to film it in.");
    expect(list).toContain('askToSignUp("run")');
  });

  it("links Genjutsu's Finish for everyone exactly when its page shows it to everyone", () => {
    const live = genjutsuLive();
    const open = modeOpen("finish", (f) => live[f]);
    expect(open).toBe(true);
    const finish = entry("genjutsu-finish")!;
    for (const kind of VISITORS) {
      expect(visibleTo(finish, kind), kind).toBe(open);
      expect(studioSubs("genjutsu", kind, "sheet").some((e) => e.id === finish.id), kind).toBe(open);
      const menu = studiosMenu(kind).columns.flatMap((c) => [c.lead!, ...c.rows]).flatMap((e) => e.subs ?? []);
      expect(menu.some((s) => s.id === finish.id), kind).toBe(open);
    }
  });

  it("links Genjutsu's From picture for everyone: it runs on a visitor's own GPU until it opens here", () => {
    const picture = entry("genjutsu-picture")!;
    expect(picture.visibility).toBeUndefined();
    for (const kind of VISITORS) {
      expect(visibleTo(picture, kind), kind).toBe(true);
      expect(studioSubs("genjutsu", kind, "sheet").some((e) => e.id === picture.id), kind).toBe(true);
    }
  });

  it("links a feature a visitor may open but not run here (its page says so) in the menus and sheets for the owner only", () => {
    for (const id of OWNER_RUNS) {
      for (const kind of VISITORS) {
        const parent = subParent(id)!;
        expect(studioSubs(parent, kind, "sheet").some((e) => e.id === id), `${kind}: ${id}`).toBe(false);
        expect(studioSubs(parent, kind, "menu").some((e) => e.id === id), `${kind}: ${id}`).toBe(false);
      }
    }
    expect(studioSubs("audio", "owner", "sheet").map((e) => e.id)).toContain("audio-split");
    // Image to 3D runs for accounts too (on their own GPU or key): its modes are linked for everyone.
    for (const kind of [...VISITORS, "owner" as const]) expect(studioSubs("image-to-3d", kind, "menu").length, String(kind)).toBe(3);
    // Character Sheet and Photodump run for accounts too (on their own GPU or key): their modes are linked for everyone.
    for (const kind of [...VISITORS, "owner" as const]) {
      expect(studioSubs("character-sheet", kind, "sheet").length, String(kind)).toBe(3);
      expect(studioSubs("photodump", kind, "sheet").map((e) => e.id), String(kind)).toEqual(["photodump-instadump"]);
    }
    // Search still finds them, as before.
    expect(entriesFor("guest").some((e) => e.id === "audio-split")).toBe(true);
  });

  it("lists in the menu only as many as its column has room for, then See all to the studio's page", () => {
    for (const kind of KINDS) {
      for (const e of launcherEntries(kind)) {
        const spec = STUDIO_SUBS[e.id];
        const list = megaSubs(e, kind);
        if (!spec || spec.menu === 0) {
          expect(list, e.id).toEqual([]);
          continue;
        }
        const more = list.filter((s) => s.more);
        expect(more.length, e.id).toBeLessThanOrEqual(1);
        if (more.length) {
          expect(list.at(-1)!.more, e.id).toBe(true);
          expect(more[0].href, e.id).toBe(e.href);
          expect(more[0].label, e.id).toMatch(/^See all \d+$/);
          // The studio's own page is "See all", not one of the links before it.
          expect(list.slice(0, -1).some((s) => s.href === e.href), e.id).toBe(false);
        }
        if (spec.menu !== undefined) expect(list.filter((s) => !s.more).length, e.id).toBeLessThanOrEqual(spec.menu);
      }
    }
  });
});

describe("finding a studio's features", () => {
  const find = (kind: ViewerKind | undefined, q: string) => searchNav(q, navSearchEntries(entriesFor(kind)));

  it("finds each by name, shown under its studio", () => {
    const top = (q: string) => find("guest", q).best[0];
    expect(top("restyle")).toMatchObject({ id: "genjutsu-restyle", hint: "Genjutsu" });
    expect(top("click to ad")).toMatchObject({ id: "marketing-click-to-ad", hint: "Marketing Studio" });
    expect(top("ad multiplier")).toMatchObject({ id: "ads-multiplier", hint: "Marketing Studio" });
    expect(top("from a selfie")).toMatchObject({ id: "photodump-instadump", hint: "Photodump" });
    expect(top("build from scratch")).toMatchObject({ id: "character-sheet-cast", hint: "Character Sheet" });
    expect(top("motion transfer")).toMatchObject({ id: "genjutsu-motion", href: "/genjutsu?mode=motion" });
  });

  it("lists a studio's features right after it when the studio is the best match, in the studio's order", () => {
    const inside = (kind: ViewerKind | undefined, q: string) => find(kind, q).groups[0];
    expect(find("guest", "genjutsu").best[0]).toMatchObject({ id: "genjutsu" });
    expect(inside("guest", "genjutsu")).toMatchObject({ label: "In Genjutsu" });
    expect(inside("guest", "genjutsu").hits.map((h) => h.label)).toEqual(["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert", "From picture", "Finish"]);
    expect(inside("owner", "genjutsu").hits.map((h) => h.label)).toEqual(["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert", "From picture", "Finish"]);
    expect(inside("guest", "character sheet").hits.map((h) => h.label)).toEqual(["From Reference", "Build from scratch", "From a description"]);
    // Not a tab that is the studio's own page (Upscale's Image), nor one already among the best matches.
    const upscale = find("guest", "upscale");
    const listed = [...upscale.best, ...upscale.groups[0].hits].map((h) => h.label);
    for (const t of ["video", "fps boost", "sdr to hdr", "export"]) expect(listed.some((l) => l.toLowerCase().includes(t)), `${t}: ${listed.join(", ")}`).toBe(true);
    expect(upscale.groups[0].hits.some((h) => h.href === "/upscale")).toBe(false);
    expect(new Set(listed).size).toBe(listed.length);
    // Up to eight, and never a group for something that isn't a studio.
    expect(inside("guest", "audio").hits.length).toBeLessThanOrEqual(8);
    expect(find("guest", "restyle").groups.some((g) => g.label.startsWith("In "))).toBe(false);
  });

  it("finds the owner's own only for the owner", () => {
    const hits = (kind: ViewerKind | undefined, q: string) => {
      const r = find(kind, q);
      return [...r.best, ...r.groups.flatMap((g) => g.hits)].map((h) => h.id);
    };
    expect(hits("owner", "skills as canvases")).toContain("canvas-skills");
    expect(hits("owner", "scheduled")).toContain("assist-scheduled");
    // Cinema Studio's Blockout is everyone's ("Cinema Studio › Blockout").
    for (const kind of [...VISITORS, "owner" as const]) expect(hits(kind, "blockout"), String(kind)).toContain("cinema-blockout");
    for (const kind of VISITORS) {
      expect(hits(kind, "skills as canvases"), String(kind)).not.toContain("canvas-skills");
      expect(hits(kind, "assist memory"), String(kind)).not.toContain("assist-memory");
    }
  });
});

describe("the open feature", () => {
  it("is the feature whose link the page's path and query match, and its studio where they are one page", () => {
    expect(subActive("/genjutsu", "mode=restyle")).toBe("genjutsu-restyle");
    expect(subActive("/genjutsu", "mode=restyle&video=x")).toBe("genjutsu-restyle");
    expect(subActive("/genjutsu", "")).toBeUndefined();
    expect(subActive("/ads/multiplier")).toBe("ads-multiplier");
    expect(subActive("/ads")).toBe("ads");
    expect(subActive("/audio/dialogue")).toBe("audio-dialogue");
    expect(subActive("/upscale")).toBeUndefined(); // Upscale's Image tab is Upscale's own page
    expect(megaCurrent("studios", "/upscale")).toBe("upscale");
    expect(megaCurrent("studios", "/marketing/click-to-ad")).toBe("marketing-click-to-ad");
    expect(megaCurrent("studios", "/genjutsu", "mode=insert")).toBe("genjutsu-insert");
    expect(megaCurrent("studios", "/genjutsu")).toBe("genjutsu");
  });

  it("names every feature once in the whole model", () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
