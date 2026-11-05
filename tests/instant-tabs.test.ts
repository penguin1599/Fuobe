import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_MODES, hubOfPath, modeHref, modeOfPath, type HubKind } from "@/lib/hubs";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const HUBS = Object.keys(HUB_MODES) as HubKind[];

describe("hub paths", () => {
  it("reads the hub and the mode of a path", () => {
    expect(hubOfPath("/audio")).toBe("audio");
    expect(hubOfPath("/audio/music?x=1")).toBe("audio");
    expect(hubOfPath("/video-tools/trim")).toBe("video-tools");
    expect(hubOfPath("/audiobook")).toBeUndefined();
    expect(hubOfPath("/image")).toBeUndefined();
    expect(modeOfPath("audio", "/audio")).toBe("clean");
    expect(modeOfPath("audio", "/audio/speech")).toBe("speech");
    expect(modeOfPath("audio", "/audio/music")).toBe("music");
    expect(modeOfPath("audio", "/audio/nope")).toBeUndefined();
    expect(modeOfPath("audio", "/audio/music/more")).toBeUndefined();
    expect(modeOfPath("upscale", "/audio/music")).toBeUndefined();
  });

  it("round-trips every mode's URL", () => {
    for (const kind of HUBS) for (const m of HUB_MODES[kind]) expect(modeOfPath(kind, modeHref(kind, m.id))).toBe(m.id);
  });
});

describe("hub tabs never leave the screen during a switch", () => {
  it("each hub's layout draws the title bar and the tabs, shared by every mode", () => {
    for (const kind of HUBS) {
      const layout = src(`src/app/(studio)/${kind}/layout.tsx`);
      expect(layout).toContain(`<HubFrame kind="${kind}" skeleton={<HubBodySkeleton />}>`);
      // A mode still on its way (a cold load's stream, a page not prefetched) is the body's skeleton under the hub's bar.
      expect(src(`src/app/(studio)/${kind}/loading.tsx`)).toMatch(/return <HubBodySkeleton \/>;/);
    }
  });

  it("the frame's context never changes after the first render, so it never reaches a part of the page still hydrating", () => {
    const chrome = src("src/components/studio/hub-chrome.tsx");
    expect(chrome).toMatch(/const \[store\] = useState\(createSlotStore\);/);
    expect(chrome).toMatch(/<HubCtx\.Provider value=\{store\}>/);
    expect(chrome).toMatch(/const slotRef = useCallback\(\(el: HTMLElement \| null\) => store\.set\(el\), \[store\]\);/);
    expect(chrome).toMatch(/<div ref=\{slotRef\} className="contents" \/>/);
    // The phone's answer comes in a transition after hydration, for the same reason.
    expect(src("src/hooks/use-mobile.ts")).toMatch(/React\.startTransition\(read\)/);
  });

  it("a tapped tab whose page wasn't prefetched shows the body's skeleton within 100 ms, and never over a page that came", () => {
    const chrome = src("src/components/studio/hub-chrome.tsx");
    expect(Number(chrome.match(/export const HUB_SKELETON_AFTER_MS = (\d+);/)?.[1])).toBeLessThanOrEqual(70);
    // useLinkStatus is pending only while a navigation waits (a prefetched page skips it); it is reported before paint.
    const link = chrome.slice(chrome.indexOf("<Link"), chrome.indexOf("</Link>"));
    expect(link).toMatch(/<TabWaiting onWaiting=\{onWaiting\} \/>/);
    expect(chrome).toMatch(/const \{ pending \} = useLinkStatus\(\);\s+\/\/[^\n]*\n\s+useLayoutEffect\(/);
    expect(chrome).toMatch(/const skeletonShown = waiting && late;/);
    // The old page stays mounted under the skeleton.
    expect(chrome).toMatch(/<div className=\{skeletonShown \? "hidden" : "contents"\}>\{children\}<\/div>/);
  });

  it("a row swiped before the page is interactive stays where it was put", () => {
    expect(src("src/components/studio/hub-chrome.tsx")).toMatch(/if \(first && row\.scrollLeft > 0\) return;/);
  });

  it("no mode page draws its own tabs, and the per-mode boundary has a skeleton, never an empty fallback", () => {
    const hub = src("src/components/studio/mode-switch-studio.tsx");
    expect(hub).not.toMatch(/fallback=\{null\}/);
    expect(hub).toMatch(/fallback=\{<HubBodySkeleton \/>\}/);
    expect(hub).not.toMatch(/ModeTabs|tabs=\{/);
  });

  it("the tabs prefetch whole mode pages, also the ones scrolled out of a phone's row", () => {
    const chrome = src("src/components/studio/hub-chrome.tsx");
    // The tab's <Link> has a bare `prefetch` (prefetch={true}: the whole mode page, not only the route's shared shell).
    const link = chrome.slice(chrome.indexOf("<Link"), chrome.indexOf("</Link>"));
    expect(link).toMatch(/^ +prefetch\r?$/m);
    expect(chrome).toMatch(/useIdlePrefetch\(\s*modes\.map\(\(m\) => modeHref\(kind, m\.id\)\),\s*"page",\s*true,?\s*\)/);
    // The tapped tab is marked at once, before the route commits.
    expect(chrome).toMatch(/useTappedTab<string>\(pathname\)/);
    expect(chrome).toMatch(/onClick=\{\(e\) => isPlainClick\(e\) && tap\(m\.id\)\}/);
  });

  it("the hub's engine badge says self-hosted for the same modes as their tools", () => {
    const files: Record<string, string> = {
      "audio/translate": "src/components/dub/dub-studio.tsx",
      "audio/split": "src/components/audio-tools/split-tool.tsx",
      "audio/clean": "src/components/audio-tools/clean-voice-tool.tsx",
      "video-tools/remove-object": "src/components/remove-object/remove-object-tool.tsx",
      "video-tools/remove-dialogue": "src/components/audio-tools/remove-dialogue-tool.tsx",
      "video-tools/evolution": "src/components/evolution/evolution-tool.tsx",
      "video-tools/restore": "src/components/restore/restore-tool.tsx",
      "video-tools/captions": "src/components/captions/captions-studio.tsx",
      "video-tools/trim": "src/components/av/trim-tool.tsx",
    };
    for (const [key, file] of Object.entries(files)) {
      const [kind, id] = key.split("/") as [HubKind, string];
      const mode = HUB_MODES[kind].find((m) => m.id === id);
      const shell = src(file).match(/<ToolShell[^>]*>/)?.[0] ?? "";
      expect(!!mode?.selfHostedOnly, key).toBe(/\bselfHostedOnly\b/.test(shell));
    }
  });
});

describe("other tab bars switch without a round trip", () => {
  it("Library sections update the address with the History API, not a router navigation", () => {
    const lib = src("src/components/library-view.tsx");
    expect(lib).toMatch(/window\.history\.replaceState\(null, "", /);
    expect(lib).not.toMatch(/router\.replace\(/);
  });

  it("the bar's routes prefetch on hover, touch or focus, a panel's when it opens, after the page's own tabs; a clicked bar link is marked at once", () => {
    const bar = src("src/components/nav/top-bar.tsx");
    // The clicked link is the open page's item from the next frame on; the address takes over once it moves.
    expect(bar).toMatch(/const \[tapped, onTap\] = useTappedTab<string>\(pathname\);/);
    expect(bar).toMatch(/active=\{barActive\(tapped \?\? pathname\)\}/);
    expect(bar).toMatch(/isPlainClick\(e\) && onTap\?\.\(href\)/);
    // A panel's routes (the launcher, Create, More, a phone sheet) wait in the "nav" lane, behind the page's own tabs.
    expect(src("src/components/nav/nav-prefetch.tsx")).toMatch(/queueIdlePrefetch\("nav", href, \(\) => go\(href\)\)/);
    const link = src("src/components/intent-link.tsx");
    // A settled link prefetches also when scrolled out of view, in the "nav" lane (after the page's own tabs), not the Link's viewport prefetch.
    expect(link).toMatch(/useIdlePrefetch\(settled && href \? \[href\] : null, "nav"\);/);
    expect(link).toMatch(/prefetch=\{eager \|\| intent \? null : false\}/);
  });

  it("a tapped tab is marked before the route commits, and dropped once the route moves or the page is hidden", () => {
    const hook = src("src/lib/use-tapped-tab.ts");
    expect(hook).toMatch(/if \(tapped && tapped\.at !== pathname\) setTapped\(null\);/);
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \(\) => setTapped\(null\), \[\]\);/);
    const marketing = src("src/components/marketing/shell.tsx");
    expect(marketing).toMatch(/useTappedTab<SuiteTab>\(active\)/);
    expect(marketing).toMatch(/aria-current=\{t\.id === current \? "page" : undefined\}/);
    // The other tools' pages go ahead of the navigation's routes.
    expect(marketing).toMatch(/useIdlePrefetch\(\s*TABS\.filter\(\(t\) => t\.id !== active\)\.map\(\(t\) => t\.href\),\s*"page",?\s*\)/);
  });

  it("the marketing suite's route skeletons draw its real header and tabs, the page's own tab current", () => {
    expect(src("src/components/marketing/skeletons.tsx")).toMatch(/<MarketingHeader title=\{title\} active=\{active\}/);
    expect(src("src/app/(studio)/marketing/loading.tsx")).toMatch(/<MarketingSkeleton \/>/);
    for (const [file, title, active] of [
      ["marketing/click-to-ad", "Click to Ad", "click"],
      ["ads", "Ads Studio", "ads"],
      ["ads/multiplier", "Ad Multiplier", "multiplier"],
    ])
      expect(src(`src/app/(studio)/${file}/loading.tsx`)).toContain(`<MarketingToolSkeleton title="${title}" active="${active}" />`);
  });

  it("Library sections show the tapped section before useSearchParams follows", () => {
    const lib = src("src/components/library-view.tsx");
    expect(lib).toMatch(/setSet\(\{ from: routed\.toString\(\), to: next \}\);/);
    expect(lib).toMatch(/if \(set && set\.from !== routed\.toString\(\)\) setSet\(null\);/);
  });

  it("gallery categories change the chip and the grid in the same frame", () => {
    // A deferred grid marked the chip a little sooner but showed the filtered grid much later.
    const gallery = src("src/components/preset-gallery.tsx");
    expect(gallery).not.toMatch(/useDeferredValue\(cat\)/);
    expect(gallery).toMatch(/p\.category === cat\)/);
  });

  it("the studio's route skeleton keeps a hub's bar and tabs on the way in", () => {
    // Each studio folder's loading.tsx (none around Home: tests/home-first-paint.test.ts).
    expect(src("src/components/studio/route-loading.tsx")).toMatch(/<StudioRouteSkeleton /);
    expect(src("src/app/(studio)/image/loading.tsx")).toMatch(/@\/components\/studio\/route-loading/);
  });

  it("example cards (a lazy chunk) load under their own placeholder, so a tapped page never waits for them", () => {
    // Without a loading option next/dynamic adds no Suspense boundary, and the chunk's load suspends the whole page up to
    // the route's skeleton after the tap.
    const page = src("src/components/studio/studio-page.tsx");
    const lazy = page.split("\n").filter((l) => /^const \w+ = dynamic\(\(\) => import\("@\/components\/examples\/example-cards"\)/.test(l));
    expect(lazy.length).toBe(2);
    for (const line of lazy) expect(line).toMatch(/\{ loading: /);
    // The row is a lazy() under its own Suspense boundary, whose fallback is the row's skeleton (the same heading and cards).
    expect(page).toMatch(/^const ExampleRow = lazy\(\(\) => import\("@\/components\/examples\/example-cards"\)/m);
    expect(page).toMatch(/<Suspense fallback=\{skeleton\}>\s*<ExampleRow /);
    expect(page).toMatch(/const skeleton = <ExampleRowSkeleton /);
  });
});

describe("idle prefetches: the page's own tabs go before the navigation's routes", () => {
  let clock = 0;
  let idle: (() => void)[] = [];
  let observed: ((list: { getEntries(): unknown[] }) => void) | null = null;
  let order: string[] = [];

  async function load() {
    vi.useFakeTimers();
    clock = 0;
    idle = [];
    observed = null;
    order = [];
    vi.stubGlobal("document", { readyState: "complete" });
    vi.stubGlobal("performance", { now: () => clock });
    vi.stubGlobal("window", {
      location: { href: "http://app.test/audio" },
      requestIdleCallback: (fn: () => void) => idle.push(fn),
      cancelIdleCallback: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (t: number) => clearTimeout(t),
    });
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(cb: (list: { getEntries(): unknown[] }) => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    return import("@/lib/idle-prefetch");
  }
  const tick = (ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      clock += 10;
      vi.advanceTimersByTime(10);
    }
  };
  const answered = (path: string) => observed!({ getEntries: () => [{ name: `http://app.test${path}?_rsc=x`, responseEnd: clock }] });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("issues the page's tabs first, and the navigation's routes once the server has answered every tab and gone quiet", async () => {
    const { queueIdlePrefetch } = await load();
    queueIdlePrefetch("nav", "/image", () => order.push("row image"));
    queueIdlePrefetch("page", "/audio/music", () => order.push("tab music"));
    queueIdlePrefetch("page", "/audio/sfx", () => order.push("tab sfx"));
    const cancel = queueIdlePrefetch("nav", "/gone", () => order.push("row gone"));
    cancel();
    expect(order).toEqual([]);
    expect(idle).toHaveLength(1);
    idle[0]();
    expect(order).toEqual(["tab music", "tab sfx"]);
    answered("/audio/music");
    tick(1000);
    expect(order).toEqual(["tab music", "tab sfx"]);
    answered("/audio/sfx");
    tick(400);
    expect(order).toHaveLength(2);
    tick(200);
    expect(order).toEqual(["tab music", "tab sfx", "row image"]);
    // A page that mounts later (a client navigation into a hub) gets its own idle moment.
    queueIdlePrefetch("page", "/audio/loop", () => order.push("tab loop"));
    expect(idle).toHaveLength(2);
    idle[1]();
    expect(order.at(-1)).toBe("tab loop");
  });

  it("lets the navigation's routes go after 8 s at the latest", async () => {
    const { queueIdlePrefetch } = await load();
    queueIdlePrefetch("page", "/audio/music", () => order.push("tab music"));
    queueIdlePrefetch("nav", "/image", () => order.push("row image"));
    idle[0]();
    tick(7900);
    expect(order).toEqual(["tab music"]);
    tick(200);
    expect(order).toEqual(["tab music", "row image"]);
  });

  it("with no tabs on the page, prefetches the navigation's routes once the page's own prefetches have gone quiet", async () => {
    const { queueIdlePrefetch } = await load();
    queueIdlePrefetch("nav", "/image", () => order.push("row image"));
    idle[0]();
    expect(order).toEqual([]);
    tick(300);
    answered("/gallery-card");
    tick(400);
    expect(order).toEqual([]);
    tick(200);
    expect(order).toEqual(["row image"]);
  });

  it("drops the navigation's idle prefetches for someone who asked to save data, never the page's own tabs", async () => {
    const { queueIdlePrefetch } = await load();
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    queueIdlePrefetch("nav", "/image", () => order.push("row image"));
    queueIdlePrefetch("page", "/audio/music", () => order.push("tab music"));
    idle[0]();
    tick(9000);
    expect(order).toEqual(["tab music"]);
  });

  it('relies on Next still reading router.prefetch\'s undocumented `kind` ("full": the whole page, not only the shell)', async () => {
    const next = (p: string) => fs.readFileSync(path.join(__dirname, "..", "node_modules/next/dist/client/components", p), "utf8");
    const prefetch = next("prefetch.js");
    expect(prefetch).toMatch(/const prefetchKind = options\?\.kind \?\? _routerreducertypes\.PrefetchKind\.AUTO;/);
    expect(prefetch).toMatch(/case _routerreducertypes\.PrefetchKind\.FULL:\s*\{\s*fetchStrategy = _types\.FetchStrategy\.Full;/);
    expect(next("router-reducer/router-reducer-types.js")).toMatch(/PrefetchKind\["FULL"\] = "full";/);
    const { prefetchOptions } = await load();
    expect(prefetchOptions(true)).toMatchObject({ kind: "full" });
    expect(prefetchOptions(false)).toMatchObject({ kind: "auto" });
  });

  it("relies on Next serving route trees and shells before any URL-specific part (the phase order of its prefetch queue)", () => {
    const scheduler = fs.readFileSync(path.join(__dirname, "..", "node_modules/next/dist/client/components/segment-cache/scheduler.js"), "utf8");
    const compare = scheduler.slice(scheduler.indexOf("function compareQueuePriority"), scheduler.indexOf("function heapPush"));
    expect(compare).toMatch(/const phaseDiff = b\.phase - a\.phase;/);
  });
});
