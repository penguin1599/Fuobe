import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ path: "/" }));
const search = vi.hoisted(() => ({ open: () => {}, close: () => {}, warm: () => {}, isOpen: false }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/nav/search-context", () => ({ useSearchPalette: () => search }));

import { NavUiProvider } from "@/components/nav/nav-ui";
import { activePhoneTab, KEYBOARD_MIN, keyboardOpen, toggleSheet, typesText } from "@/components/nav/phone-nav";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { PhoneTabs } from "@/components/nav/phone-tabs";
import { StudiosSheet } from "@/components/nav/studios-sheet";
import { PhoneBar } from "@/components/phone-bar";
import { navCovers } from "@/lib/nav-covers";
import { activeEntry, LAUNCHER_GROUPS, launcherEntries, studioCount } from "@/lib/nav-model";

/*
 * The phone's navigation (below md): the tab bar (Home, Create, Studios, Library, You), the Studios sheet with every
 * studio on one screen, and the header button that opens search (or, in a full-screen studio, the menu sheet).
 */

const covers = navCovers();
// The provider as createElement types it with its children passed after the props.
const Nav = NavUiProvider as (p: { covers: typeof covers; children?: ReactNode }) => ReactNode;
const render = (node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Nav, { covers }, node)));
const at = (pathname: string, node: () => ReactNode) => {
  nav.path = pathname;
  return render(node());
};
/** Every link's href in the markup, in order (React escapes & as &amp;). */
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
/** The markup's words, without its tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&amp;", "&");
/** The opening tag of the element carrying `attr` (data-tab="home"…). */
const tagWith = (html: string, attr: string) => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? "";
const NO_SEARCH = new URLSearchParams();
const tabFor = (pathname: string) => activePhoneTab(pathname, null, activeEntry(pathname, NO_SEARCH));
/** Words that describe the install's own setup: never on the phone's chrome itself (the owner sees them in the You sheet only). */
const STATUS_WORDS = ["ComfyUI", "add key", "offline", "online", "Paid APIs only", "Open source only", "Placeholder"];

describe("the selected tab", () => {
  it("is the open sheet's while one is open", () => {
    expect(activePhoneTab("/", "studios")).toBe("studios");
    expect(activePhoneTab("/library", "create")).toBe("create");
    expect(activePhoneTab("/cinema", "you")).toBe("you");
  });

  it("is the page's tab otherwise", () => {
    expect(tabFor("/")).toBe("home");
    expect(tabFor("/library")).toBe("library");
    expect(tabFor("/library/abc")).toBe("library");
    expect(tabFor("/settings")).toBe("you");
    expect(tabFor("/settings/models")).toBe("you");
    expect(tabFor("/connect")).toBe("you");
  });

  it("is Studios in a studio, its pages and the apps, and Create in a create tool", () => {
    for (const p of ["/cinema", "/cinema/abc", "/marketing/click-to-ad", "/audio/clean", "/apps", "/apps/app-3d-figure", "/fashion-factory"]) expect(tabFor(p), p).toBe("studios");
    for (const p of ["/image", "/video", "/edit", "/assist", "/canvas"]) expect(tabFor(p), p).toBe("create");
  });

  it("is none on a page no tab leads to", () => {
    expect(tabFor("/motions")).toBeNull();
    expect(tabFor("/effects")).toBeNull();
    expect(activePhoneTab("", null)).toBeNull();
  });
});

describe("a sheet tab", () => {
  it("opens its sheet, switches from another, and closes its own when tapped again", () => {
    expect(toggleSheet(null, "studios")).toBe("studios");
    expect(toggleSheet("studios", "studios")).toBeNull();
    expect(toggleSheet("create", "studios")).toBe("studios");
    expect(toggleSheet("studios", "you")).toBe("you");
  });
});

describe("the on-screen keyboard", () => {
  it("counts only fields you type in", () => {
    for (const type of [undefined, "", "text", "search", "email", "url", "tel", "password", "number", "TEXT"]) expect(typesText({ tagName: "INPUT", type }), String(type)).toBe(true);
    for (const type of ["checkbox", "radio", "range", "button", "submit", "file", "color", "date", "time"]) expect(typesText({ tagName: "INPUT", type }), type).toBe(false);
    expect(typesText({ tagName: "TEXTAREA" })).toBe(true);
    expect(typesText({ tagName: "textarea" })).toBe(true);
    expect(typesText({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typesText({ tagName: "DIV" })).toBe(false);
    expect(typesText({ tagName: "BUTTON" })).toBe(false);
    expect(typesText({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(typesText({ tagName: "TEXTAREA", disabled: true })).toBe(false);
    expect(typesText(null)).toBe(false);
    expect(typesText(undefined)).toBe(false);
  });

  it("is up when someone types and the visible viewport lost more than the browser bars do", () => {
    expect(keyboardOpen(844 - 336, 844, true)).toBe(true);
    expect(keyboardOpen(844 - KEYBOARD_MIN - 1, 844, true)).toBe(true);
    expect(keyboardOpen(844 - KEYBOARD_MIN, 844, true)).toBe(false);
    // The address bar showing or hiding moves the viewport by less.
    expect(keyboardOpen(844 - 60, 844, true)).toBe(false);
    // Pinch-zoomed or a short window without a field in focus: not the keyboard.
    expect(keyboardOpen(400, 844, false)).toBe(false);
  });
});

describe("the tab bar", () => {
  it("is a Main nav fixed to the bottom of a phone, clear of the home indicator, and steps aside when it must", () => {
    const html = at("/", () => createElement(PhoneTabs));
    const bar = tagWith(html, "data-phone-tabs");
    expect(bar).toMatch(/^<nav /);
    expect(bar).toContain('aria-label="Main"');
    for (const c of [
      "md:hidden",
      "print:hidden",
      "fixed",
      "bottom-0",
      "grid-cols-5",
      "h-[calc(4rem+env(safe-area-inset-bottom))]",
      "pb-[calc(0.25rem+env(safe-area-inset-bottom))]",
      "pl-[max(0.5rem,env(safe-area-inset-left))]",
      "pr-[max(0.5rem,env(safe-area-inset-right))]",
      "[html[data-fullscreen-studio]_&amp;]:hidden",
      "[html[data-keyboard-open]_&amp;]:hidden",
      "pointer-events-auto",
      "z-40",
    ])
      expect(bar, c).toContain(c);
  });

  it("has Home, Create, Studios, Library and You, in that order; the links prefetch and the sheet tabs say they open a dialog", () => {
    const html = at("/", () => createElement(PhoneTabs));
    expect([...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual(["home", "create", "studios", "library", "you"]);
    expect(hrefs(html)).toEqual(["/", "/library"]);
    expect(words(html).replace(/\s+/g, " ").trim()).toBe("Home Create Studios Library You");
    for (const tab of ["create", "studios", "you"]) {
      const t = tagWith(html, `data-tab="${tab}"`);
      expect(t).toMatch(/^<button /);
      expect(t).toContain('type="button"');
      expect(t).toContain('aria-haspopup="dialog"');
      expect(t).toContain('aria-expanded="false"');
    }
  });

  it("marks the page's tab: aria-current on a link, the selected look on a sheet tab", () => {
    const home = at("/", () => createElement(PhoneTabs));
    expect(tagWith(home, 'data-tab="home"')).toContain('aria-current="page"');
    expect(tagWith(home, 'data-tab="home"')).toContain("data-active");
    expect(tagWith(home, 'data-tab="library"')).not.toContain("aria-current");

    const library = at("/library", () => createElement(PhoneTabs));
    expect(tagWith(library, 'data-tab="library"')).toContain('aria-current="page"');
    expect(tagWith(library, 'data-tab="home"')).not.toContain("aria-current");

    const studio = at("/cinema/abc", () => createElement(PhoneTabs));
    expect(tagWith(studio, 'data-tab="studios"')).toContain("data-active");
    expect(studio).not.toContain("aria-current");

    const create = at("/image", () => createElement(PhoneTabs));
    expect(tagWith(create, 'data-tab="create"')).toContain("data-active");

    const gallery = at("/motions", () => createElement(PhoneTabs));
    expect(gallery).not.toContain("data-active");
  });

  it("gives each tab the bar's whole 56 px row (4rem less the 1 px border, 3 px above and 4 px below) and a fifth of its width", () => {
    const html = at("/", () => createElement(PhoneTabs));
    for (const tab of ["home", "create", "studios", "library", "you"]) expect(tagWith(html, `data-tab="${tab}"`)).toContain("h-full");
    const bar = tagWith(html, "data-phone-tabs");
    for (const c of ["border-t", "pt-[3px]", "pb-[calc(0.25rem+env(safe-area-inset-bottom))]"]) expect(bar, c).toContain(c);
  });

  it("shows no dot and no setup words in the server's HTML (who is looking is known only after hydration)", () => {
    const html = at("/", () => createElement(PhoneTabs));
    expect(html).not.toContain("data-dot");
    for (const w of STATUS_WORDS) expect(words(html), w).not.toContain(w);
  });
});

describe("the Studios sheet", () => {
  const sheet = (props: { group?: (typeof LAUNCHER_GROUPS)[number]["id"] } = {}) => createElement(StudiosSheet, { ...props, onSearch: () => {} });
  // The grid ends on a See all tile (/studios): the family's whole set. A studio's features are pills under it.
  const tiles = (html: string) =>
    [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>/g)]
      .filter((m) => !m[0].includes("data-sub"))
      .map((m) => m[1].replaceAll("&amp;", "&"))
      .filter((h) => h !== "/" && h !== "/library" && h !== "/studios");
  const pills = (html: string) => [...html.matchAll(/<a data-sub=""[^>]*>([^<]*)</g)].map((m) => m[1]);

  it("shows every studio, Apps and the Sound modes (34 tiles, 29 studios), in launcher order, each with a real cover", () => {
    const html = at("/", () => sheet());
    const all = launcherEntries(undefined);
    // Ads Studio keeps its tile here (the desktop menu lists it under Marketing Studio).
    expect(all).toHaveLength(34);
    // All is one screen of tiles: a studio's features show under one group only.
    expect(pills(html)).toEqual([]);
    expect(studioCount()).toBe(29);
    expect(tiles(html)).toEqual(all.map((e) => e.href));
    for (const e of all) {
      expect(e.cover, e.id).toBeTruthy();
      expect(covers[e.cover!], e.id).toBeTruthy();
      // A tile shows the 96 px copy.
      expect(html, e.id).toContain(`src="${covers[e.cover!].mini ?? covers[e.cover!].thumb}"`);
    }
  });

  it("labels tiles short enough for a 5-column phone grid, with the full name for screen readers", () => {
    const html = at("/", () => sheet());
    for (const e of launcherEntries(undefined)) {
      // Up to two lines of 12 (the label wraps; it never shows an abbreviation).
      for (const w of (e.short ?? e.label).split(" ")) expect(w.length, e.id).toBeLessThanOrEqual(12);
      expect(e.short ?? e.label, e.id).not.toContain(".");
      expect(words(html), e.id).toContain(e.label);
    }
    expect(html).toContain("grid-cols-5");
  });

  it("has a chip per group, All first and pressed, in a labelled group", () => {
    const html = at("/", () => sheet());
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Show the studios for one goal"');
    const chips = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(chips).toEqual([
      ["All", "true"],
      ...LAUNCHER_GROUPS.map((g) => [g.chip, "false"]),
    ]);
    expect(chips.map((c) => c[0])).toEqual(["All", "Film", "Social", "Sell", "People", "Sound", "Finish"]);
  });

  it("starts on the group it was opened for", () => {
    const sizes = { film: 8, social: 6, sell: 6, people: 6, sound: 5, finish: 3 } as const;
    for (const g of LAUNCHER_GROUPS) {
      const html = at("/", () => sheet({ group: g.id }));
      expect(tiles(html), g.id).toEqual(launcherEntries(undefined, g.id).map((e) => e.href));
      expect(tiles(html), g.id).toHaveLength(sizes[g.id]);
      expect(html, g.id).toMatch(new RegExp(`aria-pressed="true"[^>]*>${g.chip}<`));
    }
  });

  it("lists what a group's studios hold inside as pills under the tiles, by their tabs' names, as a visitor may run them", () => {
    const sell = at("/", () => sheet({ group: "sell" }));
    // Ads Studio is a tile of the group already: not a pill again.
    expect(pills(sell)).toEqual(["Click to Ad", "Ad Multiplier", "From a selfie"]);
    expect(words(sell)).toContain("Marketing Studio");
    const people = at("/", () => sheet({ group: "people" }));
    expect(pills(people)).toEqual(["From Reference", "Build from scratch", "From a description", "Motion transfer", "Character swap", "Object swap", "Restyle", "Insert", "From picture", "Finish"]);
    // Split soundtrack and Remove dialogue run for visitors with an account (on their own GPU or key): linked too.
    for (const w of ["Split soundtrack", "Remove dialogue"]) expect(LAUNCHER_GROUPS.some((g) => pills(at("/", () => sheet({ group: g.id }))).includes(w)), w).toBe(true);
    // Cinema Studio's Blockout is linked for everyone (a guest is offered a free account on a run).
    const film = at("/", () => sheet({ group: "film" }));
    expect(pills(film)).toContain("Blockout");
    expect(hrefs(film)).toContain("/cinema?blockout=1");
    // Image to 3D runs for visitors with an account (on their own GPU or key): its modes are linked too.
    const finish = at("/", () => sheet({ group: "finish" }));
    expect(pills(finish)).toEqual(["Image", "Video", "FPS Boost", "SDR to HDR", "Export", "From an image", "From several images", "From text", "Pick an object", "Splat"]);
    // Each pill links its feature (a route, or its studio with ?mode= / ?tab=).
    expect(hrefs(sell)).toEqual(expect.arrayContaining(["/marketing/click-to-ad", "/ads", "/ads/multiplier"]));
    expect(hrefs(people)).toEqual(expect.arrayContaining(["/genjutsu?mode=motion", "/genjutsu?mode=insert"]));
  });

  it("marks a studio's feature you are on, and its studio's tile", () => {
    const html = at("/ads/multiplier", () => sheet({ group: "sell" }));
    expect(tagWith(html, 'href="/ads/multiplier"')).toContain('aria-current="page"');
    expect(tagWith(html, 'href="/marketing"')).toContain('aria-current="page"');
    // A feature with a tile of its own marks that tile.
    const ads = at("/ads", () => sheet({ group: "sell" }));
    expect(tagWith(ads, 'href="/ads"')).toContain('aria-current="page"');
    expect(tagWith(ads, 'href="/marketing"')).not.toContain('aria-current="page"');
  });

  it("marks the studio you are in", () => {
    const html = at("/cinema/abc", () => sheet());
    expect(tagWith(html, 'href="/cinema"')).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks an Audio mode in the Sound group as the one you are in, and only it", () => {
    const html = at("/audio/music", () => sheet());
    expect(tagWith(html, 'href="/audio/music"')).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const studio = at("/audio/dialogue", () => sheet());
    expect(tagWith(studio, 'href="/audio"')).toContain('aria-current="page"');
    expect(studio.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("offers Home, Library, You and Search only in a full-screen studio (elsewhere Search everything is in the sheet's title row)", () => {
    const html = at("/", () => sheet());
    expect(hrefs(html).slice(0, 2)).toEqual(["/", "/library"]);
    expect(html).toContain("hidden shrink-0 grid-cols-4");
    expect(html).toContain("[html[data-fullscreen-studio]_&amp;]:grid");
    // The grid takes the room under the chips: Search everything sits next to Close, so 33 tiles fit a 390 x 844 phone.
    expect(words(html)).not.toContain("Search everything");
  });

  it("names nothing about the install's setup", () => {
    const html = at("/", () => sheet());
    for (const w of STATUS_WORDS) expect(words(html), w).not.toContain(w);
  });
});

describe("the header button and the phone bar", () => {
  it("opens search, and is the menu in a full-screen studio (switched by CSS from the pre-paint attribute)", () => {
    const html = at("/", () => createElement(PhoneNavButton));
    const button = tagWith(html, 'aria-haspopup="dialog"');
    expect(button).toMatch(/^<button /);
    expect(button).toContain("md:hidden");
    expect(button).toContain("size-11");
    expect(html).toMatch(/<span class="sr-only \[html\[data-fullscreen-studio\]_&amp;\]:hidden">Search<\/span>/);
    expect(html).toMatch(/<span class="sr-only hidden \[html\[data-fullscreen-studio\]_&amp;\]:inline">Menu<\/span>/);
  });

  it("is the wordmark (home) and search on gallery and settings pages, clear of the notch", () => {
    const html = at("/apps", () => createElement(PhoneBar));
    expect(hrefs(html)).toEqual(["/"]);
    expect(html).toContain('aria-label="Fuobe home"');
    expect(html).toContain("pt-[env(safe-area-inset-top)]");
    expect(html).toContain("md:hidden");
    expect(words(html)).toContain("Search");
    expect(html).not.toContain("Toggle Sidebar");
  });
});

describe("the phone sheets", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/components/nav/phone-sheets.tsx"), "utf8");

  it("end at the tab bar and let a tap on it be the tab's own", () => {
    expect(src).toContain("bottom-[var(--chrome-bottom,0px)]");
    expect(src).toMatch(/onInteractOutside=\{\(e\) => \{[\s\S]*?closest\("\[data-phone-tabs\]"\)\) e\.preventDefault\(\)/);
  });

  it("animate only for people who allow motion", () => {
    const animated = src.match(/(?<![\w:-])(?:data-open|data-closed):animate-(?:in|out)/g) ?? [];
    expect(animated).toEqual([]);
    expect(src).toContain("motion-safe:data-open:animate-in");
  });
});
