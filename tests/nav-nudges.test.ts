import { createElement, type FC, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generation, OutputFile } from "@/lib/catalog/types";

// The hooks NextSteps and the covers read: who is looking and the engine mode (the real ones need the app's queries).
const viewer = vi.hoisted(() => ({ visitor: false, engineMode: "both" as "both" | "open" | "cloud" }));
vi.mock("@/lib/api", () => ({
  useEngineMode: () => viewer.engineMode,
  useLikelyVisitor: () => viewer.visitor,
  useHydrated: () => true,
  useViewer: () => ({ data: undefined }),
}));
// IntentLink prefetches through the router, which a static render has no app router for.
vi.mock("next/navigation", async (load) => ({ ...(await load<typeof import("next/navigation")>()), useRouter: () => ({ prefetch() {}, replace() {}, push() {} }) }));

const { NextSteps, handoffFile, keepGoingTitle } = await import("@/components/nav/next-steps");
const { ExploreProgress, ExploreView } = await import("@/components/nav/explore-progress");
const { exploredEntry, markExplored, readExplored, subscribeExplored } = await import("@/components/nav/explore-tracker");
const { NavUiProvider } = await import("@/components/nav/nav-ui");
const { keepGoing } = await import("@/lib/next-steps");
const { EXPLORE_KEY } = await import("@/lib/nav-explore");
const { coverIds, entry } = await import("@/lib/nav-model");
const { getPreset } = await import("@/lib/catalog");

function gen(outputs: Partial<OutputFile>[], over: Partial<Generation> = {}): Generation {
  return {
    id: "g1",
    batchId: null,
    feature: "image",
    presetId: null,
    modelId: "nano-banana-pro",
    engine: "cloud",
    provider: "fal",
    op: "t2i",
    kind: (outputs[0]?.kind ?? "image") as Generation["kind"],
    status: "succeeded",
    progress: 1,
    message: null,
    prompt: "a fox in the snow",
    request: { feature: "image", modelId: "nano-banana-pro", prompt: "a fox in the snow" },
    outputs: outputs.map((o, i) => ({ url: `/api/files/out-${i}.png`, kind: "image", ...o }) as OutputFile),
    error: null,
    costUsd: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: 0,
    ...over,
  };
}

const person = (prompt = "a fashion model in a red velvet suit on a rooftop at dusk") => gen([{ kind: "image" }], { prompt, request: { feature: "image", modelId: "nano-banana-pro", prompt } });
const product = () => gen([{ kind: "image" }], { prompt: "a perfume bottle on black marble", request: { feature: "image", modelId: "nano-banana-pro", prompt: "a perfume bottle on black marble" } });
const clip = () => gen([{ kind: "video", url: "/api/files/clip.mp4" }], { kind: "video", op: "t2v", feature: "video" });
const sound = () => gen([{ kind: "audio", url: "/api/files/voice.mp3" }], { kind: "audio", op: "tts", feature: "audio" });
const model = () =>
  gen([{ kind: "model3d", url: "/api/files/chair.glb", meta: { poster: "/api/files/chair.png" } }], { kind: "model3d", op: "image-to-3d", feature: "image-to-3d", request: { feature: "image-to-3d", modelId: "hunyuan-3d-3-1-pro", inputs: { images: ["/api/files/photo.png"] } } });

/** Every cover the steps can name, as the server would resolve them. */
const COVERS = Object.fromEntries(coverIds().map((id) => [id, { thumb: `/previews/presets/${id}-thumb.jpg`, poster: `/previews/presets/${id}.jpg` }]));
/** The covers context the chrome provides (children passed the way createElement takes them). */
const Covers = NavUiProvider as FC<{ covers: typeof COVERS; children?: ReactNode }>;
const html = (node: ReactNode) => renderToStaticMarkup(createElement(Covers, { covers: COVERS }, node));
const steps = (g: Generation, variant: "row" | "list" = "row", max?: number, skip?: string[]) => html(createElement(NextSteps, { g, index: 0, variant, max, skip }));
const hrefs = (markup: string) => [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

afterEach(() => {
  viewer.visitor = false;
  viewer.engineMode = "both";
  vi.unstubAllGlobals();
});

describe("Keep going with this: under a finished result", () => {
  it("names the result by its kind", () => {
    expect(keepGoingTitle("image")).toBe("Keep going with this picture");
    expect(keepGoingTitle("video")).toBe("Keep going with this clip");
    expect(keepGoingTitle("audio")).toBe("Keep going with this sound");
    expect(keepGoingTitle("model3d")).toBe("Keep going with this model");
  });

  it("shows 3 to 5 steps that each carry the picture, in a group named by its heading", () => {
    const out = steps(person());
    const id = /<div role="group" aria-labelledby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<p id="${id}"`);
    expect(out).toContain("Keep going with this picture</p>");
    const links = hrefs(out);
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links.length).toBeLessThanOrEqual(5);
    for (const h of links) expect(h).toContain(`image=${encodeURIComponent("/api/files/out-0.png")}`);
    // A list of links (ul > li > a), each with a verb and where it goes.
    expect(out).toMatch(/<ul[^>]*><li[^>]*><a /);
  });

  it("covers sit in fixed boxes: decorative, lazy, sized", () => {
    const out = steps(product());
    const imgs = [...out.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toContain('alt=""');
      expect(img).toContain('loading="lazy"');
      expect(img).toMatch(/width="40" height="40"/);
    }
  });

  it("honours max, and skips what the view already offers", () => {
    expect(hrefs(steps(person(), "row", 2))).toHaveLength(2);
    const all = keepGoing(person(), 0, { engineMode: "both", visitor: false, adapters: { characterSheet: true, imageTo3d: true } }, 5);
    const first = all[0];
    const out = hrefs(steps(person(), "row", 5, [first.id]));
    expect(out).not.toContain(first.href);
    expect(out.length).toBeGreaterThanOrEqual(Math.min(3, all.length - 1));
  });

  it("sends everyone to Character Sheet and Image to 3D (an account runs them on its own GPU or key)", () => {
    for (const visitor of [false, true]) {
      viewer.visitor = visitor;
      expect(hrefs(steps(person())).some((h) => h.startsWith("/character-sheet?image=")), String(visitor)).toBe(true);
      expect(hrefs(steps(product())).some((h) => h.startsWith("/image-to-3d?image=")), String(visitor)).toBe(true);
    }
  });

  it("goes on from clips, sounds and 3D models too", () => {
    const v = steps(clip());
    expect(v).toContain("Keep going with this clip");
    expect(hrefs(v)[0]).toBe(`/extend?video=${encodeURIComponent("/api/files/clip.mp4")}`);
    expect(steps(sound())).toContain("Keep going with this sound");
    const m = steps(model(), "row", 3);
    expect(m).toContain("Keep going with this model");
    expect(hrefs(m).length).toBeGreaterThan(0);
  });

  it("is absent where a result can't go on: failed, deleted, text", () => {
    expect(steps(gen([{ kind: "image" }], { status: "failed" }))).toBe("");
    expect(steps(gen([{ kind: "image" }], { deletedAt: 1 }))).toBe("");
    expect(steps(gen([{ kind: "text", url: "/api/files/t.txt", text: "hi" }], { kind: "text", op: "transcribe" }))).toBe("");
  });

  it("the Viewer's list is stacked rows", () => {
    const out = steps(person(), "list");
    expect(out).toContain("Keep going with this picture");
    expect(out).toContain("min-h-12");
    expect(hrefs(out).length).toBeGreaterThanOrEqual(3);
  });

  it("every step's cover is one the server resolves for the nav", () => {
    const ids = new Set(coverIds());
    for (const g of [person(), product(), gen([{ kind: "image" }]), clip(), sound(), model()]) {
      for (const s of keepGoing(g, 0, { engineMode: "both", visitor: false, adapters: { characterSheet: true, imageTo3d: true } }, 5)) {
        if (s.cover) expect(ids, `${s.id} → ${s.cover}`).toContain(s.cover);
      }
    }
  });

  it("an app a step opens takes the picture in its image slot", () => {
    for (const g of [person(), product(), gen([{ kind: "image" }]), model()]) {
      for (const s of keepGoing(g, 0, { engineMode: "both", visitor: false, adapters: { characterSheet: true, imageTo3d: true } }, 5)) {
        const m = /^\/apps\/([\w-]+)\?image=/.exec(s.href);
        if (!m) continue;
        const preset = getPreset(m[1]);
        expect(preset, m[1]).toBeTruthy();
        expect(preset!.inputs.some((slot) => slot.key === "image" && slot.accept === "image"), m[1]).toBe(true);
      }
    }
  });
});

describe("a picture handed to Character Sheet or Image to 3D", () => {
  it("takes only Fuobe files", () => {
    expect(handoffFile("/api/files/abc123.png")).toBe("/api/files/abc123.png");
    expect(handoffFile("/api/files/uploads/my%20photo.jpg")).toBe("/api/files/uploads/my%20photo.jpg");
    for (const bad of [null, undefined, "", "https://example.com/a.png", "//example.com/a.png", "/api/files/", "/api/other/a.png", "javascript:alert(1)", "/api/files/a.png?x=1", "/api/files/../auth/me", "/api/files/%2e%2e/auth/me", "/api/files/%2E%2E/x", `/api/files/${"a".repeat(301)}`]) {
      expect(handoffFile(bad), String(bad)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Explore: what this browser has opened

function fakeWindow(opts: { throwGet?: boolean; throwSet?: boolean; noStorage?: boolean } = {}) {
  const store = new Map<string, string>();
  const handlers = new Set<(e: { key: string | null }) => void>();
  const localStorage = {
    getItem: (k: string) => {
      if (opts.throwGet) throw new Error("blocked");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwSet) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
  };
  const w: Record<string, unknown> = {
    addEventListener: (t: string, h: (e: { key: string | null }) => void) => t === "storage" && handlers.add(h),
    removeEventListener: (t: string, h: (e: { key: string | null }) => void) => handlers.delete(h),
  };
  // Some browsers throw on the accessor itself when site data is blocked.
  if (opts.noStorage)
    Object.defineProperty(w, "localStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
  else w.localStorage = localStorage;
  vi.stubGlobal("window", w);
  return { store, fire: (key: string | null) => handlers.forEach((h) => h({ key })), handlers };
}

describe("explore progress: storage", () => {
  it("is unknown on the server (no window)", () => {
    expect(readExplored()).toBeNull();
    expect(() => markExplored("cinema")).not.toThrow();
  });

  it("marks once, keeps the snapshot stable, and reads junk as nothing", () => {
    const { store } = fakeWindow();
    expect(readExplored()).toEqual([]);
    markExplored("cinema");
    markExplored("cinema");
    markExplored("shorts");
    expect(JSON.parse(store.get(EXPLORE_KEY)!)).toEqual(["cinema", "shorts"]);
    const a = readExplored();
    expect(readExplored()).toBe(a);
    store.set(EXPLORE_KEY, "{not json");
    expect(readExplored()).toEqual([]);
  });

  it("never throws when storage is blocked or full, and then shows nothing", () => {
    fakeWindow({ throwGet: true });
    expect(readExplored()).toBeNull();
    expect(() => markExplored("cinema")).not.toThrow();
    fakeWindow({ noStorage: true });
    expect(readExplored()).toBeNull();
    expect(() => markExplored("cinema")).not.toThrow();
    const full = fakeWindow({ throwSet: true });
    expect(() => markExplored("cinema")).not.toThrow();
    expect(full.store.size).toBe(0);
  });

  it("tells subscribers about a mark here and about another tab's, and stops when unsubscribed", () => {
    const w = fakeWindow();
    const seen = vi.fn();
    const off = subscribeExplored(seen);
    markExplored("marketing");
    expect(seen).toHaveBeenCalledTimes(1);
    w.fire(EXPLORE_KEY);
    w.fire(null);
    w.fire("fuobe:viewer");
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    markExplored("ads");
    w.fire(EXPLORE_KEY);
    expect(seen).toHaveBeenCalledTimes(3);
    expect(w.handlers.size).toBe(0);
  });

  it("counts studios, create tools and preset hubs, not Home, the Library or Settings", () => {
    const at = (path: string, q = "") => exploredEntry(path, new URLSearchParams(q))?.id;
    expect(at("/cinema")).toBe("cinema");
    expect(at("/cinema/abc123")).toBe("cinema");
    expect(at("/audio/clean")).toBe("audio");
    expect(at("/image")).toBe("image");
    expect(at("/motions")).toBe("motions");
    expect(at("/apps/app-billboard-ad")).toBe("apps");
    for (const path of ["/", "/library", "/settings", "/settings/models", "/connect"]) expect(at(path), path).toBeUndefined();
    expect(at("/library", "tab=favorites")).toBeUndefined();
  });
});

describe("explore progress: what it shows", () => {
  const genjutsu = entry("genjutsu")!;

  it("renders nothing on the server, whatever is stored", () => {
    fakeWindow().store.set(EXPLORE_KEY, JSON.stringify(["cinema"]));
    expect(html(createElement(ExploreProgress, { variant: "sheet" }))).toBe("");
  });

  it("shows the next studio and the count as one small row", () => {
    const out = html(createElement(ExploreView, { variant: "sheet", done: 9, total: 28, next: genjutsu }));
    expect(out).toContain("9 of 28 studios tried</span>");
    expect(out).toContain("Genjutsu");
    expect(hrefs(out)).toEqual(["/genjutsu"]);
    expect(out).toContain(`aria-label="Next to try: Genjutsu, ${genjutsu.what}. 9 of 28 studios tried"`);
    // Its cover at 40 px, decorative; no big card.
    expect(out).toMatch(/<img [^>]*alt=""/);
    expect(out).toContain("size-10");
    expect(out).not.toContain("aspect-video");
  });

  it("says so warmly when everything is tried", () => {
    const all = html(createElement(ExploreView, { variant: "sheet", done: 28, total: 28 }));
    expect(all).toContain("You have tried every studio");
    expect(hrefs(all)).toEqual([]);
  });
});
