import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { recordForPath, unknownHubMode } from "@/lib/record-pages";
import { tempDir } from "./helpers/temp-dir";

const dir = tempDir("fuobe-records-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
const { db } = await import("@/server/db");
const { recordExists } = await import("@/server/records");
const { proxy } = await import("@/proxy");

/** Where the proxy sent a page request: its own path, or the not-found page (with the status). */
function routed(pathname: string): { status: number; to: string | null } {
  const res = proxy(new NextRequest(`http://localhost:3000${pathname}`, { headers: { host: "localhost:3000" } }));
  return { status: res.status, to: res.headers.get("x-middleware-rewrite") };
}

describe("record pages (real 404s)", () => {
  it("names the record behind every id page", () => {
    expect(recordForPath("/cinema/abc")).toEqual({ kind: "cinema", ids: ["abc"] });
    expect(recordForPath("/canvas/abc/")).toEqual({ kind: "canvas", ids: ["abc"] });
    expect(recordForPath("/assist/projects/p1")).toEqual({ kind: "assist-project", ids: ["p1"] });
    expect(recordForPath("/layers/l1")).toEqual({ kind: "layers", ids: ["l1"] });
    expect(recordForPath("/shorts/s1")).toEqual({ kind: "shorts", ids: ["s1"] });
    expect(recordForPath("/ads/b1")).toEqual({ kind: "brand", ids: ["b1"] });
    expect(recordForPath("/elements/e%201")).toEqual({ kind: "element", ids: ["e 1"] });
    expect(recordForPath("/faceless/c1")).toEqual({ kind: "channel", ids: ["c1"] });
    expect(recordForPath("/faceless/c1/new")).toEqual({ kind: "channel", ids: ["c1"] });
    expect(recordForPath("/faceless/c1/ep1")).toEqual({ kind: "episode", ids: ["c1", "ep1"] });
    expect(recordForPath("/explainer/x1")).toEqual({ kind: "explainer", ids: ["x1"] });
    expect(recordForPath("/content-factory/s1")).toEqual({ kind: "series", ids: ["s1"] });
  });

  it("leaves list pages and fixed sub-pages alone", () => {
    for (const p of ["/", "/cinema", "/canvas/", "/ads", "/ads/multiplier", "/assist/projects", "/assist/skills", "/faceless", "/explainer", "/content-factory", "/library", "/apps/app-face-swap", "/cinema/a/b"]) {
      expect(recordForPath(p), p).toBeNull();
    }
  });

  it("matches every id page in src/app, and none of the static pages beside them", () => {
    // The table is written by hand: a page added later under a record path (/shorts/new, /cinema/templates)
    // would be answered with the 404 page. Scan the app's pages so that can't go unnoticed.
    const app = path.join(process.cwd(), "src/app");
    const routes: string[] = [];
    const walk = (dir: string, segs: string[]) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !(segs.length === 0 && e.name === "api") && !e.name.startsWith("_")) walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name]);
        else if (e.name === "page.tsx") routes.push(`/${segs.join("/")}`);
      }
    };
    walk(app, []);
    expect(routes.length).toBeGreaterThan(40);
    // Ids the catalog answers for (apps, hub modes, Canvas templates, ready-made starters' pages), not stored records, and
    // share tokens: the proxy checks those itself. A visitor's Canvas boards aren't records either: a ready board is the
    // catalog's (/canvas/try), a draft lives in the browser (/canvas/draft) and an account's board is checked by its API
    // (/canvas/saved).
    const catalog = /^\/(apps|audio|video-tools|upscale|s|canvas\/(start|try|draft|saved))\/\[|\/start\/\[id\]$/;
    for (const route of routes) {
      if (!route.includes("[")) {
        expect(recordForPath(route), route).toBeNull();
        expect(unknownHubMode(route), route).toBe(false);
      } else if (!catalog.test(route)) expect(recordForPath(route.replace(/\[[^\]]+\]/g, "x1")), route).not.toBeNull();
    }
  });

  it("knows each hub's modes", () => {
    expect(unknownHubMode("/audio/music")).toBe(false);
    expect(unknownHubMode("/video-tools/trim/")).toBe(false);
    expect(unknownHubMode("/upscale/video")).toBe(false);
    expect(unknownHubMode("/audio/nope")).toBe(true);
    expect(unknownHubMode("/video-tools/captions%20x")).toBe(true);
    // The hub's own page and other paths aren't hub modes.
    expect(unknownHubMode("/audio")).toBe(false);
    expect(unknownHubMode("/apps/nope")).toBe(false);
  });

  it("looks the record up in its table", () => {
    const now = Date.now();
    db().prepare("INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("cv1", "Board", now, now);
    db()
      .prepare("INSERT INTO faceless_channels (id, name, idea, genre, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("ch1", "Channel", "idea", "history", "{}", now, now);
    db()
      .prepare("INSERT INTO faceless_episodes (id, channel_id, kind, title, topic, status, settings_json, script_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ep1", "ch1", "faceless", "Episode", "topic", "draft", "{}", "[]", now, now);
    expect(recordExists({ kind: "canvas", ids: ["cv1"] })).toBe(true);
    expect(recordExists({ kind: "canvas", ids: ["nope"] })).toBe(false);
    expect(recordExists({ kind: "cinema", ids: ["cv1"] })).toBe(false);
    expect(recordExists({ kind: "channel", ids: ["ch1"] })).toBe(true);
    expect(recordExists({ kind: "episode", ids: ["ch1", "ep1"] })).toBe(true);
    // An episode of another channel is not this channel's episode.
    expect(recordExists({ kind: "episode", ids: ["other", "ep1"] })).toBe(false);
    expect(recordExists({ kind: "explainer", ids: ["ep1"] })).toBe(true);
  });

  it("answers unknown ids with a 404 before the page streams", () => {
    expect(routed("/canvas/nope")).toEqual({ status: 404, to: "http://localhost:3000/_fuobe-not-found" });
    expect(routed("/faceless/ch1/nope").status).toBe(404);
    expect(routed("/audio/nope").status).toBe(404);
    expect(routed("/apps/nope").status).toBe(404);
    // Stored records, real modes and other pages go through.
    for (const p of ["/canvas/cv1", "/faceless/ch1", "/faceless/ch1/new", "/faceless/ch1/ep1", "/audio/music", "/ads/multiplier", "/library"]) {
      expect(routed(p), p).toEqual({ status: 200, to: null });
    }
  });
});
