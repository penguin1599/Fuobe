import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { HUB_MODES } from "@/lib/hubs";
// Plain .mjs helper shared with the Playwright scripts.
import { dynamicSamples, hubModePaths, querySamples, studioRoutes } from "./e2e/_routes.mjs";
import { tempDir } from "./helpers/temp-dir";

const root = process.cwd();
// The proxy reads the sign-in settings from the data folder: use an empty one (no password).
process.env.FUOBE_DATA_DIR = tempDir("fuobe-polish-");

describe("/apps/<unknown> is a real 404", () => {
  it("the proxy rewrites unknown app ids to the not-found page with status 404", async () => {
    delete process.env.FUOBE_PASSWORD;
    const { proxy } = await import("@/proxy");
    const unknown = proxy(new NextRequest("http://localhost:3000/apps/does-not-exist"));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-middleware-rewrite")).toMatch(/\/_fuobe-not-found$/);
    const known = proxy(new NextRequest("http://localhost:3000/apps/app-packshot"));
    expect(known.status).toBe(200);
    expect(known.headers.get("x-middleware-rewrite")).toBeNull();
    expect(proxy(new NextRequest("http://localhost:3000/apps")).headers.get("x-middleware-rewrite")).toBeNull();
    // A malformed escape doesn't crash the proxy.
    expect(proxy(new NextRequest("http://localhost:3000/apps/%E0%A4%A")).status).toBe(404);
  });
});

describe("the 390 px sweep visits dynamic routes", () => {
  it("finds every dynamic route and has a sample for each", () => {
    const { routes, patterns } = studioRoutes(root) as { routes: string[]; patterns: string[] };
    expect(routes).toContain("/assist/skills");
    expect(patterns).toEqual(expect.arrayContaining(["/audio/[mode]", "/video-tools/[mode]", "/upscale/[mode]", "/cinema/[id]", "/canvas/[id]", "/apps/[id]", "/assist/projects/[id]"]));
    const { urls, byPattern } = dynamicSamples(root, { cinema: "c1", canvas: "v1", assistProject: "p1" }) as { urls: string[]; byPattern: Record<string, string[]> };
    // Every dynamic route is visited at least once, and no sample still has a [param] in it.
    for (const p of patterns) expect(byPattern[p]?.length, p).toBeGreaterThan(0);
    expect(urls.filter((u) => /\[/.test(u))).toEqual([]);
    expect(urls).toEqual(expect.arrayContaining(["/cinema/c1", "/cinema/does-not-exist", "/canvas/v1", "/canvas/does-not-exist", "/assist/projects/p1", "/apps/does-not-exist"]));
    // Dialogs and tabs a query opens: a skill's Run form, Genjutsu's From picture and Finish tabs, Marketing's
    // code-drawn templates.
    const genjutsu = ["/genjutsu?mode=picture", "/genjutsu?mode=finish"];
    const kinetic = ["ms-kinetic-headline", "ms-feature-cards", "m2-line-reveal", "ms-end-card"].map((id) => `/marketing?template=${id}`);
    expect(querySamples({ recipeSkill: "lamp" })).toEqual(["/assist/skills?run=lamp", "/assist/skills?run=does-not-exist", ...genjutsu, ...kinetic]);
    expect(querySamples()).toEqual(["/assist/skills?run=does-not-exist", ...genjutsu, ...kinetic]);
  });

  it("gives a route added later (another branch's /faceless/[id]/[episode]) a not-found sample by itself", () => {
    const tmp = tempDir("fuobe-routes-");
    const page = (rel: string) => {
      fs.mkdirSync(path.join(tmp, "src/app/(studio)", rel), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src/app/(studio)", rel, "page.tsx"), "export default function P() { return null; }\n");
    };
    fs.mkdirSync(path.join(tmp, "src/lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src/lib/hubs.ts"), "export const HUB_MODES = {\n};\n");
    for (const r of ["faceless", "faceless/[id]", "faceless/[id]/[episode]", "faceless/[id]/new", "cinema/[id]", "docs/[...slug]"]) page(r);
    try {
      const { byPattern, generated } = dynamicSamples(tmp, { cinema: "c1" }) as { byPattern: Record<string, string[]>; generated: string[] };
      expect(byPattern["/faceless/[id]"]).toEqual(["/faceless/does-not-exist"]);
      expect(byPattern["/faceless/[id]/[episode]"]).toEqual(["/faceless/does-not-exist/does-not-exist"]);
      expect(byPattern["/faceless/[id]/new"]).toEqual(["/faceless/does-not-exist/new"]);
      expect(byPattern["/docs/[...slug]"]).toEqual(["/docs/does-not-exist"]);
      expect(byPattern["/cinema/[id]"]).toEqual(["/cinema/c1", "/cinema/does-not-exist"]);
      expect(generated.sort()).toEqual(["/docs/[...slug]", "/faceless/[id]", "/faceless/[id]/[episode]", "/faceless/[id]/new"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads every hub mode from src/lib/hubs.ts (each has a path of its own; the first is also the hub's own page)", () => {
    const expected = Object.entries(HUB_MODES).flatMap(([hub, modes]) => modes.map((m) => `/${hub}/${m.id}`));
    expect((hubModePaths(root) as string[]).sort()).toEqual(expected.sort());
  });
});

describe("Cinema uses the shared live stream", () => {
  it("opens no EventSource of its own", () => {
    const src = fs.readFileSync(path.join(root, "src/components/cinema/hooks.ts"), "utf8");
    expect(src).not.toMatch(/new EventSource/);
    expect(src).toMatch(/useGenerationEvents/);
  });
});
