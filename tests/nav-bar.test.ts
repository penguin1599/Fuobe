import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusInfo, ViewerInfo } from "@/lib/api";

/*
 * The top bar (src/components/nav/top-bar.tsx) and what hangs from it: the Studios launcher, the Create menu, the
 * account menu and the status the sidebar's footer used to show. The static shell is the same for everyone and says no
 * status; once the viewer is known, the owner's words go only to the owner.
 */

const state = vi.hoisted(() => ({
  path: "/",
  hydrated: false,
  viewer: undefined as ViewerInfo | undefined,
  status: undefined as StatusInfo | undefined,
  mode: "both" as "both" | "open" | "cloud",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => state.path,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/api", async (load) => ({
  ...(await load<typeof import("@/lib/api")>()),
  useHydrated: () => state.hydrated,
  useViewer: () => ({ data: state.viewer }),
  useStatus: () => ({ data: state.status }),
  useEngineMode: () => state.mode,
}));

const { TopBar, barActive, prefetchHrefs } = await import("@/components/nav/top-bar");
const { launcherCurrent, launcherMove, LAUNCHER_ID } = await import("@/components/nav/mega-launcher");
const { LauncherColumns } = await import("@/components/nav/mega-panel");
const { CREATE_HREFS, createColumns } = await import("@/components/nav/create-menu");
const { AccountSections } = await import("@/components/nav/account-menu");
const { avatarDot, refillWords } = await import("@/components/nav/status-chips");
const { COVER_SIZES, CoverThumb } = await import("@/components/nav/cover-thumb");
const { NavUiProvider } = await import("@/components/nav/nav-ui");
const { navCovers } = await import("@/lib/nav-covers");
const { entriesFor, entry, launcherColumns, NAV_ENTRIES, studioCount } = await import("@/lib/nav-model");
const { studiosMenu } = await import("@/lib/mega-menus");

const covers = navCovers();
const Nav = NavUiProvider as (p: { covers: typeof covers; children?: ReactNode }) => ReactNode;
const render = (node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Nav, { covers }, node)));
/** Every link in the markup: its tag (attributes) and its href (React escapes & as &amp;). */
const anchors = (html: string) => [...html.matchAll(/<a\s[^>]*>/g)].map((m) => ({ tag: m[0], href: (/href="([^"]*)"/.exec(m[0])?.[1] ?? "").replaceAll("&amp;", "&") }));
const hrefs = (html: string) => anchors(html).map((a) => a.href);
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const count = (html: string, s: string) => html.split(s).length - 1;

/** What only the owner may read: the install's status and its modes. */
const OWNER_WORDS = ["ComfyUI", "add key", "offline", "Paid APIs only", "Open source only", "Placeholder", "Cloud models", "Your setup", "Models &amp; licences"];

const OWNER: ViewerInfo = { signedIn: true, owner: true, publicSignup: true };
const ACCOUNT: ViewerInfo = { signedIn: true, owner: false, publicSignup: true, account: { email: "ana@example.com" } };
const GUEST: ViewerInfo = { signedIn: false, owner: false, publicSignup: true };
const install = (extra: Partial<StatusInfo> = {}): StatusInfo => ({
  providers: { fal: { label: "fal.ai", configured: false }, replicate: { label: "Replicate", configured: false }, comfyui: { label: "ComfyUI", configured: false } },
  demoMode: "on",
  engineMode: "both",
  cloudProvider: "fal",
  ...extra,
});

beforeEach(() => {
  state.path = "/";
  state.hydrated = false;
  state.viewer = undefined;
  state.status = undefined;
  state.mode = "both";
});

describe("launcher keys", () => {
  const cols = [8, 6, 5, 6, 4];

  it("moves up and down a column and stops at its ends", () => {
    expect(launcherMove(cols, { col: 0, row: 0 }, "ArrowDown")).toEqual({ col: 0, row: 1 });
    expect(launcherMove(cols, { col: 0, row: 7 }, "ArrowDown")).toBeNull();
    expect(launcherMove(cols, { col: 2, row: 3 }, "ArrowUp")).toEqual({ col: 2, row: 2 });
    expect(launcherMove(cols, { col: 2, row: 0 }, "ArrowUp")).toBeNull();
  });

  it("goes to the same place in the next column, or its last link when it is shorter", () => {
    expect(launcherMove(cols, { col: 0, row: 2 }, "ArrowRight")).toEqual({ col: 1, row: 2 });
    expect(launcherMove(cols, { col: 0, row: 7 }, "ArrowRight")).toEqual({ col: 1, row: 5 });
    expect(launcherMove(cols, { col: 3, row: 5 }, "ArrowRight")).toEqual({ col: 4, row: 3 });
    expect(launcherMove(cols, { col: 1, row: 4 }, "ArrowLeft")).toEqual({ col: 0, row: 4 });
    expect(launcherMove(cols, { col: 0, row: 4 }, "ArrowLeft")).toBeNull();
    expect(launcherMove(cols, { col: 4, row: 1 }, "ArrowRight")).toBeNull();
  });

  it("jumps to a column's first and last with Home and End, and leaves other keys alone", () => {
    expect(launcherMove(cols, { col: 1, row: 3 }, "Home")).toEqual({ col: 1, row: 0 });
    expect(launcherMove(cols, { col: 1, row: 3 }, "End")).toEqual({ col: 1, row: 5 });
    expect(launcherMove(cols, { col: 1, row: 0 }, "Home")).toBeNull();
    for (const key of ["Enter", " ", "Tab", "Escape", "a"]) expect(launcherMove(cols, { col: 1, row: 1 }, key)).toBeNull();
  });

  it("skips an empty column and does nothing in one", () => {
    expect(launcherMove([3, 0, 2], { col: 0, row: 2 }, "ArrowRight")).toEqual({ col: 2, row: 1 });
    expect(launcherMove([3, 0, 2], { col: 1, row: 0 }, "ArrowDown")).toBeNull();
  });
});

describe("which bar item holds the page", () => {
  it("marks Studios for a studio and its own pages, Create for the create tools", () => {
    expect(barActive("/marketing")).toMatchObject({ studios: true, create: false });
    expect(barActive("/marketing/click-to-ad").studios).toBe(true);
    expect(barActive("/audio/clean").studios).toBe(true);
    expect(barActive("/cinema/abc123").studios).toBe(true);
    expect(barActive("/image")).toMatchObject({ create: true, studios: false });
    expect(barActive("/live-edit").create).toBe(true);
  });

  it("marks the galleries, Canvas, Assist and Library on their pages", () => {
    expect(barActive("/apps")).toMatchObject({ apps: true, studios: false });
    expect(barActive("/apps/app-billboard-ad").apps).toBe(true);
    expect(barActive("/motions").motions).toBe(true);
    expect(barActive("/effects").motions).toBe(true);
    expect(barActive("/canvas/p1").canvas).toBe(true);
    expect(barActive("/assist/skills").assist).toBe(true);
    expect(barActive("/library").library).toBe(true);
  });

  it("marks nothing on Home, Settings or a page outside the nav", () => {
    for (const p of ["/", "/settings", "/privacy", ""]) expect(Object.values(barActive(p)).some(Boolean), p).toBe(false);
  });

  it("names the launcher entry of the open page for aria-current", () => {
    expect(launcherCurrent("/marketing")).toBe("marketing");
    expect(launcherCurrent("/audio/music")).toBe("audio-music");
    expect(launcherCurrent("/audio")).toBe("audio");
    expect(launcherCurrent("/audio/dialogue")).toBe("audio");
    expect(launcherCurrent("/apps/app-x")).toBe("apps");
    expect(launcherCurrent("/image")).toBeUndefined();
  });
});

describe("the launcher's columns", () => {
  const html = render(createElement(LauncherColumns, { kind: undefined, now: Date.parse("2026-11-02") }));

  it("shows every studio, Apps and the Sound column, 8/6/5/6/5/3 (Ads Studio under Marketing Studio), each column's lead first", () => {
    const main = anchors(html).filter((a) => !a.tag.includes("data-sub"));
    expect(main).toHaveLength(33);
    expect(new Set(main.map((a) => a.href)).size).toBe(33);
    expect(launcherColumns(undefined).map((c) => 1 + c.rest.length)).toEqual([8, 6, 6, 6, 5, 3]);
    // Ads Studio stays in the model (the phone's sheet keeps its tile); the desktop menu lists it under Marketing Studio.
    expect(studiosMenu(undefined).columns.map((c) => 1 + c.rows.filter((e) => !e.under).length)).toEqual([8, 6, 5, 6, 5, 3]);
    expect(studiosMenu(undefined).columns.flatMap((c) => c.rows.filter((e) => e.under).map((e) => [e.id, e.under]))).toEqual([["ads", "marketing"]]);
    expect(launcherColumns(undefined).map((c) => c.lead.id)).toEqual(["cinema", "shorts", "marketing", "fashion-factory", "audio", "upscale"]);
    expect(html).toContain("grid-cols-6");
    // The arrow keys' places: the lead, its features, then each row and its features, top to bottom.
    for (const [i, c] of studiosMenu(undefined).columns.entries()) {
      const at = (href: string, sub: boolean) => anchors(html).find((a) => a.href === href && a.tag.includes(`data-col="${i}"`) && a.tag.includes("data-sub") === sub)?.tag ?? "";
      let r = 0;
      for (const e of [c.lead!, ...c.rows.filter((x) => !x.under)]) {
        expect(at(e.href, false), e.id).toContain(`data-col="${i}" data-row="${r++}"`);
        for (const s of e.subs ?? []) expect(at(s.href, true), s.id).toContain(`data-col="${i}" data-row="${r++}"`);
      }
    }
    expect(studioCount()).toBe(29);
  });

  it("lists what a studio holds inside under it, by the names of its own tabs", () => {
    const subs = (id: string) =>
      studiosMenu(undefined)
        .columns.flatMap((c) => [c.lead!, ...c.rows])
        .find((e) => e.id === id)
        ?.subs?.map((s) => s.label);
    expect(subs("marketing")).toEqual(["Click to Ad", "Ads Studio", "Ad Multiplier"]);
    expect(subs("genjutsu")).toEqual(["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert", "From picture", "Finish"]);
    expect(subs("upscale")).toEqual(["Image", "Video", "FPS Boost", "SDR to HDR", "Export"]);
    expect(subs("audio")).toEqual(["Speech", "Dialogue", "Voice change", "See all 15"]);
    expect(subs("video-tools")).toEqual(["Relight", "Captions", "Remove object", "See all 13"]);
    for (const w of ["Click to Ad", "Ads Studio", "Ad Multiplier", "Motion transfer", "FPS Boost"]) expect(words(html)).toContain(w);
    // Under a hairline, quieter than a row, with no picture and no line of their own (nav-subs.css: 24 px
    // names with a mouse, 44 px pills to tap on a touch screen).
    const sub = anchors(html).find((a) => a.tag.includes("data-sub"))!.tag;
    expect(sub).toContain("text-muted-foreground");
    expect(html).toMatch(/<ul[^>]*class="nav-subs /);
    // A "See all N" says whose.
    expect(html).toContain('aria-label="See all 15 in Audio"');
  });

  it("labels the groups, and every link has its studio's real cover in a box of fixed size", () => {
    for (const label of ["Film &amp; video", "Social &amp; shorts", "Sell &amp; advertise", "People &amp; fashion", ">Sound<", "Finish &amp; convert"]) expect(html).toContain(label);
    for (const c of launcherColumns(undefined)) {
      for (const e of [c.lead, ...c.rest].filter((x) => x.id !== "ads")) {
        const cover = covers[e.cover!];
        expect(cover, e.id).toBeDefined();
        // The lead card shows the 320 px copy (and the poster by its srcset); a row the 96 px one.
        expect(html).toContain(`src="${(e === c.lead ? cover.thumb : (cover.mini ?? cover.thumb)).replaceAll("&", "&amp;")}"`);
      }
      // The lead's 4:3 card picks the poster on sharp screens.
      expect(html).toContain(`${covers[c.lead.cover!].poster} 512w`);
    }
    // The six lead cards load as the panel warms; a row's picture when the row shows (lazy). A studio's features have none.
    expect(count(html, 'loading="eager"')).toBe(6);
    expect(count(html, 'alt=""')).toBe(33);
  });

  it("marks the open page's studio, and nothing else", () => {
    expect(html).not.toContain("aria-current");
    const on = render(createElement(LauncherColumns, { kind: undefined, current: "katana", now: 0 }));
    expect(count(on, 'aria-current="page"')).toBe(1);
    expect(anchors(on).find((a) => a.href === "/katana")?.tag).toContain('aria-current="page"');
  });

  it("on a studio's feature, marks the feature and shows its studio as holding the page (no second aria-current)", () => {
    const studio = (html: string, href: string) => anchors(html).find((a) => a.href === href && !a.tag.includes("data-sub"))?.tag ?? "";
    const restyle = render(createElement(LauncherColumns, { kind: undefined, current: "genjutsu-restyle", now: 0 }));
    expect(count(restyle, 'aria-current="page"')).toBe(1);
    expect(anchors(restyle).find((a) => a.href === "/genjutsu?mode=restyle")?.tag).toContain('aria-current="page"');
    expect(studio(restyle, "/genjutsu")).toContain('data-active=""');
    expect(studio(restyle, "/genjutsu")).not.toContain("aria-current");
    // A lead card too (Marketing Studio on Click to Ad), and a feature the menu doesn't link for a visitor (Character
    // Sheet's modes): its studio is still marked.
    expect(studio(render(createElement(LauncherColumns, { kind: undefined, current: "marketing-click-to-ad", now: 0 })), "/marketing")).toContain('data-active=""');
    const cast = render(createElement(LauncherColumns, { kind: undefined, current: "character-sheet-cast", now: 0 }));
    expect(count(cast, 'aria-current="page"')).toBe(0);
    expect(studio(cast, "/character-sheet")).toContain('data-active=""');
    // Nothing is marked as holding a page on a studio's own page.
    expect(render(createElement(LauncherColumns, { kind: undefined, current: "genjutsu", now: 0 }))).not.toContain("data-active");
  });

  it("gives Genjutsu's modes wrapped lines on a short window, and hangs a row's features on its name's column", () => {
    const ul = (id: string) => html.match(new RegExp(`<ul[^>]*data-subs="${id}"[^>]*>`))?.[0] ?? "";
    expect(ul("genjutsu")).toContain("data-subs-line");
    // With a mouse it never hides (the line takes over); on a touch screen it needs 1024 px.
    expect(ul("genjutsu")).not.toContain("[@media(max-height:799.98px)]:hidden");
    expect(ul("genjutsu")).toContain("[@media(pointer:coarse)_and_(max-height:1023.98px)]:hidden");
    expect(ul("video-tools")).toContain("[@media(max-height:879.98px)]:hidden");
    expect(ul("video-tools")).not.toContain("data-subs-line");
    // No pad after an odd list (the next row follows 4 px below, as rows do); features under a row are marked to
    // start on its name (nav-subs.css), under a lead card on the card's words.
    expect(html).not.toContain("data-odd");
    expect(ul("genjutsu")).toContain("data-under");
    expect(ul("marketing")).not.toContain("data-under");
  });

  it("shows New badges only until their date", () => {
    const newOnes = NAV_ENTRIES.filter((e) => e.group && e.newUntil);
    const before = render(createElement(LauncherColumns, { kind: undefined, now: 0 }));
    expect(count(before, ">New<")).toBe(newOnes.length);
    const after = render(createElement(LauncherColumns, { kind: undefined, now: Date.parse("2100-01-01") }));
    expect(count(after, ">New<")).toBe(0);
  });
});

describe("cover boxes", () => {
  it("keeps the box when a preset has no cover, with the entry's icon in it", () => {
    const html = render(createElement(CoverThumb, { id: "no-such-preset", size: "row", icon: "Clapperboard" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("<svg");
    expect(html).toContain(COVER_SIZES.row.box);
  });

  it("lets a caller resize the box", () => {
    const html = render(createElement(CoverThumb, { id: "app-upscale", size: "row", className: "h-[42px] w-14" }));
    expect(html).toContain("h-[42px] w-14");
    expect(html).not.toContain("h-[27px]");
    expect(html).toContain('loading="lazy"');
  });
});

describe("the bar's shell", () => {
  it("renders the same for everyone before the viewer is known, with no status words and no panel", () => {
    const html = render(createElement(TopBar));
    expect(html).toContain("<header");
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain('aria-label="Fuobe home"');
    // Each menu's section is on the page from the first paint (hidden and empty until warmed), so aria-controls
    // always points at something.
    expect(html).toContain(`aria-controls="${LAUNCHER_ID}"`);
    expect(html).toMatch(new RegExp(`<section[^>]*id="${LAUNCHER_ID}"[^>]*hidden`));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`>${studioCount()}<`);
    for (const h of ["/", "/assist", "/library", "/?new=1"]) expect(hrefs(html), h).toContain(h);
    for (const h of ["/create", "/studios", "/apps", "/motions-and-effects", "/canvas"]) expect(html, h).toContain(`data-href="${h}"`);
    // Search's name is the words it shows (sr-only below lg).
    expect(html).toContain(">Search Fuobe</span>");
    expect(html).not.toContain('aria-label="Search Fuobe"');
    expect(html).toContain('aria-keyshortcuts="/ Meta+K Control+K"');
    // The viewer's room is kept: Sign up's by default, the avatar's where an account or the owner was last.
    expect(html).toMatch(/data-slot="viewer" class="[^"]*w-\[132px\]/);
    for (const w of OWNER_WORDS) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
    expect(html).not.toContain("Sign up");
  });

  it("gives a guest Sign up and Log in that come back to the page, and no status", () => {
    state.hydrated = true;
    state.viewer = GUEST;
    state.status = install({ viewer: { kind: "guest", gpu: { connected: false } } });
    state.path = "/marketing";
    const html = render(createElement(TopBar));
    expect(hrefs(html)).toContain("/login?signup=1&next=%2Fmarketing");
    expect(hrefs(html)).toContain("/login?next=%2Fmarketing");
    expect(html).toContain('aria-label="Menu"');
    for (const w of OWNER_WORDS) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
    expect(html).not.toContain("data-dot");
    // On a studio's page the Studios item is marked.
    expect(html).toMatch(/<button[^>]*data-bar-menu="studios"[^>]*data-active="true"/);
  });

  it("gives an account its avatar, with a dot only when its own GPU answers", () => {
    state.hydrated = true;
    state.viewer = ACCOUNT;
    state.status = install({ viewer: { kind: "account", gpu: { connected: false } } });
    let html = render(createElement(TopBar));
    expect(html).toContain('aria-label="Account: ana@example.com"');
    expect(html).not.toContain("data-dot");
    state.status = install({ viewer: { kind: "account", gpu: { connected: true, online: true } } });
    html = render(createElement(TopBar));
    expect(html).toContain('data-dot="ok"');
    for (const w of OWNER_WORDS) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
  });

  it("gives the owner a dot for the install's status and keeps the words for the menu", () => {
    state.hydrated = true;
    state.viewer = OWNER;
    state.status = install();
    const html = render(createElement(TopBar));
    expect(html).toContain('data-dot="warn"');
    expect(html).toContain("Account and settings, something needs a look");
    // Placeholders on: the owner's pill (it says so itself).
    expect(html).toContain("Placeholders on");
    expect(html).not.toContain("ComfyUI");
  });
});

describe("the account menu's sections (as the phone's You sheet shows them)", () => {
  const sheet = () => render(createElement(AccountSections, { variant: "sheet" }));
  /** Rows that live in Settings → About, not in the menu, for every viewer. */
  const IN_ABOUT = ["Thanks & licences", "Models & licences", "Source on GitHub"];
  const inAbout = (html: string) => IN_ABOUT.filter((w) => words(html).replaceAll("&amp;", "&").includes(w));

  it("shows a guest how to sign up and their own GPU, nothing of the install", () => {
    state.hydrated = true;
    state.viewer = GUEST;
    state.status = install({ viewer: { kind: "guest", gpu: { connected: false } } });
    state.path = "/image";
    const html = sheet();
    expect(words(html)).toContain("Sign up free");
    expect(hrefs(html)).toContain("/login?signup=1&next=%2Fimage");
    expect(hrefs(html)).toContain("/login?signup=1&next=%2Fconnect");
    expect(words(html)).toContain("Your GPU");
    // Settings (its About has Thanks & licences and the source) and the theme.
    expect(hrefs(html)).toContain("/settings");
    expect(words(html)).toContain("Dark mode");
    expect(inAbout(html)).toEqual([]);
    for (const w of [...OWNER_WORDS, "Sign out"]) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
  });

  it("shows an account its email, its own GPU, Settings and Sign out, nothing of the install", () => {
    state.hydrated = true;
    state.viewer = ACCOUNT;
    state.status = install({ viewer: { kind: "account", gpu: { connected: false } } });
    const html = sheet();
    expect(words(html)).toContain("ana@example.com");
    for (const w of ["Settings", "Your GPU", "Dark mode", "Sign out"]) expect(words(html), w).toContain(w);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/settings", "/connect"]));
    expect(inAbout(html)).toEqual([]);
    for (const w of OWNER_WORDS) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
  });

  it("shows an account's balance instead of the GPU line when the studio bills", () => {
    state.hydrated = true;
    state.viewer = ACCOUNT;
    state.status = install({ viewer: { kind: "account", gpu: { connected: false }, balance: { amount: 3, chip: "3 runs left", text: "Free runs", detail: [] } } });
    const html = sheet();
    expect(words(html)).toContain("3 runs left");
  });

  it("shows the owner the install's status as the sidebar's footer did", () => {
    state.hydrated = true;
    state.viewer = OWNER;
    state.status = install({ providers: { fal: { label: "fal.ai", configured: true }, comfyui: { label: "ComfyUI", configured: false } } });
    const html = sheet();
    for (const w of ["Your setup", "Cloud models", "connected", "ComfyUI", "offline", "Placeholders on", "Settings", "Dark mode"]) expect(words(html).replaceAll("&amp;", "&"), w).toContain(w);
    expect(words(html)).not.toContain("Sign out");
    // Models & licences is in Settings (its own section, and a link in About).
    expect(inAbout(html)).toEqual([]);
    state.mode = "open";
    expect(words(sheet())).toContain("Open source only");
    expect(words(sheet())).not.toContain("Cloud models");
  });

  it("shows only what anyone may see while the viewer is unknown", () => {
    state.status = install();
    const html = sheet();
    for (const w of [...OWNER_WORDS, "Sign out", "Settings", "Sign up"]) expect(words(html), w).not.toContain(w.replace("&amp;", "&"));
    expect(words(html)).toContain("Dark mode");
    expect(inAbout(html)).toEqual([]);
  });
});

describe("the avatar's dot", () => {
  it("is the owner's install status, green or amber by the engine mode's needs", () => {
    const none = install();
    const cloud = install({ providers: { fal: { label: "", configured: true } } });
    const both = install({ providers: { fal: { label: "", configured: true }, comfyui: { label: "", configured: true } } });
    expect(avatarDot("owner", none, "both")).toBe("warn");
    expect(avatarDot("owner", cloud, "both")).toBe("warn");
    expect(avatarDot("owner", cloud, "cloud")).toBe("ok");
    expect(avatarDot("owner", both, "both")).toBe("ok");
    expect(avatarDot("owner", install({ ownerGpu: { mode: "computer", online: true } }), "open")).toBe("ok");
    expect(avatarDot("owner", install({ ownerGpu: { mode: "computer", online: false } }), "open")).toBe("warn");
  });

  it("is only ever green for an account, and absent for a guest or an unknown status", () => {
    const own = (online: boolean) => install({ viewer: { kind: "account", gpu: { connected: true, online } } });
    expect(avatarDot("account", own(true), "both")).toBe("ok");
    expect(avatarDot("account", own(false), "both")).toBeNull();
    expect(avatarDot("account", install({ viewer: { kind: "account", gpu: { connected: false } } }), "both")).toBeNull();
    expect(avatarDot("guest", own(true), "both")).toBeNull();
    expect(avatarDot("owner", undefined, "both")).toBeNull();
    expect(avatarDot(undefined, install(), "both")).toBeNull();
    // A visitor's status (viewer set) never lights the owner's dot.
    expect(avatarDot("owner", own(true), "both")).toBeNull();
  });

  it("says when a balance refills in the visitor's own time", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(refillWords(now + 5 * 3_600_000, now)).toBe("refills in 5 h");
    expect(refillWords(now + 10 * 60_000, now)).toBe("refills in 10 min");
    expect(refillWords(now - 1, now)).toBe("refills soon");
  });
});

describe("menu items: one button each, the area's page inside its menu", () => {
  /** The opening tag of the link to `href` in the bar's markup. */
  const linkTo = (html: string, href: string) => anchors(html).find((a) => a.href === href)?.tag ?? "";
  /** The opening tag of a menu item's button. */
  const item = (html: string, id: string) => new RegExp(`<button[^>]*data-bar-menu="${id}"[^>]*>`).exec(html)?.[0] ?? "";

  it("gives Create, Studios, Apps, Motions & effects, Canvas and More one button each, named by its words", () => {
    const html = render(createElement(TopBar));
    const hubs = [
      ["create", "/create"],
      ["studios", "/studios"],
      ["apps", "/apps"],
      ["motions", "/motions-and-effects"],
      ["canvas", "/canvas"],
    ] as const;
    for (const [id, href] of hubs) {
      expect(item(html, id), id).toContain('aria-expanded="false"');
      expect(item(html, id), id).toMatch(/aria-controls="[^"]+"/);
      // The area's page is the menu's "See all" (and Ctrl-click on the item): no separate link beside it.
      expect(item(html, id), id).toContain(`data-href="${href}"`);
      expect(linkTo(html, href), href).toBe("");
    }
    expect(item(html, "more")).toContain('aria-expanded="false"');
    expect(item(html, "more")).not.toContain("data-href");
    // Its spoken name starts with its visible words ("Studios, 29 studios"): the count's words are hidden text, not a label.
    expect(item(html, "studios")).not.toContain("aria-label=");
    expect(html).toMatch(new RegExp(`Studios<span class="sr-only">, </span><span[^>]*>${studioCount()}</span><span class="sr-only"> studios</span>`));
    // The Studios item is still the launcher's disclosure button (search hands focus back to it).
    expect(item(html, "studios")).toContain("data-studios-trigger");
    for (const name of ["Create menu", "Studios menu", "Apps menu", "Motions &amp; effects menu", "Canvas menu"]) expect(html, name).not.toContain(`aria-label="${name}"`);
    expect(html).not.toContain("data-bar-split");
    expect(html).not.toMatch(/role="menu"|role="menuitem"|aria-haspopup="menu"/);
    expect(count(html, "data-bar-menu=")).toBe(6);
  });

  it("marks the item anywhere in its area, its own page included, and only that item", () => {
    state.path = "/create";
    let html = render(createElement(TopBar));
    expect(item(html, "create")).toContain('data-active="true"');
    expect(item(html, "studios")).not.toContain("data-active");
    state.path = "/image";
    html = render(createElement(TopBar));
    expect(item(html, "create")).toContain('data-active="true"');
    expect(count(html, 'data-active="true"')).toBe(1);
    state.path = "/canvas";
    html = render(createElement(TopBar));
    expect(item(html, "create")).not.toContain("data-active");
    expect(item(html, "canvas")).toContain('data-active="true"');
  });

  it("links the launcher's header to every studio with previews", async () => {
    const { LauncherPanel } = await import("@/components/nav/mega-panel");
    const html = render(createElement(LauncherPanel, { onClose: () => {}, onSearch: () => {} }));
    expect(linkTo(html, "/studios")).not.toBe("");
    expect(words(html)).toContain("See all");
    expect(linkTo(html, "/studios")).toContain('aria-label="See all studios"');
    // Not a grid cell: the grid's arrow keys skip it.
    expect(linkTo(html, "/studios")).not.toContain("data-col");
  });
});

describe("create and prefetch", () => {
  it("puts the create tools in two columns of five", () => {
    const cols = createColumns(undefined);
    expect(cols.map((c) => c.label)).toEqual(["Make", "Edit a picture"]);
    expect(cols.map((c) => c.entries.map((e) => e.id))).toEqual([
      ["image", "video", "assist", "canvas", "storyboard"],
      ["edit", "live-edit", "inpaint", "layers", "color-grade"],
    ]);
    expect(CREATE_HREFS).toHaveLength(10);
    for (const kind of ["guest", "account", "owner"] as const) expect(createColumns(kind).flatMap((c) => c.entries)).toHaveLength(10);
  });

  it("prefetches every launcher, create and library route once, and nothing off the site", () => {
    const list = prefetchHrefs(undefined);
    expect(new Set(list).size).toBe(list.length);
    for (const c of launcherColumns(undefined)) for (const e of [c.lead, ...c.rest]) expect(list).toContain(e.href);
    for (const id of ["image", "video", "edit", "live-edit", "inpaint", "layers", "color-grade", "canvas", "assist", "library", "favorites"]) expect(list).toContain(entry(id)!.href);
    for (const h of list) expect(h.startsWith("/") && !h.includes("#"), h).toBe(true);
    // The same for every viewer: none of these is owner-only.
    expect(prefetchHrefs("owner")).toEqual(list);
    expect(list.every((h) => entriesFor("guest").some((e) => e.href === h))).toBe(true);
  });
});
