import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

const dir = tempDir("fuobe-lows-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_SELF_ADDRESSES;

const auth = await import("@/server/auth");
const { db } = await import("@/server/db");
const gens = await import("@/server/generations");
const { libraryFacets } = await import("@/server/library");
const live = await import("@/server/live");
const remote = await import("@/server/remote-fetch");
const { gpuState } = await import("@/server/account-gpu");
const nextConfig = (await import("../next.config")).default;

// Placeholders where nothing is connected, as these runs were written for ("auto": code in this process only).
beforeAll(async () => (await import("@/server/settings")).setSetting("demoMode", "auto"));
beforeAll(() => auth.setPassword("install password"));
afterEach(() => {
  delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
  delete process.env.FUOBE_SELF_ADDRESSES;
  globalThis.__fuobeSelfAddresses = undefined;
  globalThis.__fuobeTestGpuPort = undefined;
});

/** A run of `account` (or the owner's), finished. */
function runOf(account?: string): string {
  const [g] = gens.createGenerations({ feature: "image", modelId: "fuobe-soul", prompt: "a fox", engine: "open" });
  db()
    .prepare("UPDATE generations SET status = 'succeeded', request_json = CASE WHEN ? IS NULL THEN request_json ELSE json_set(request_json, '$.account', ?) END WHERE id = ?")
    .run(account ?? null, account ?? null, g.id);
  return g.id;
}

describe("L-3: an account's GPU status is asked once at a time, and its answer is small", () => {
  let hits = 0;
  let body = JSON.stringify({ system: { comfyui_version: "1" }, devices: [{ name: "GPU", vram_total: 1 }] });
  let server: http.Server;
  let url = "";
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      setTimeout(() => res.end(body), 200);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends one check for many status requests that arrive together", async () => {
    globalThis.__fuobeTestGpuPort = Number(new URL(url).port);
    hits = 0;
    const answers = await Promise.all(Array.from({ length: 20 }, () => gpuState("acct-l3", { url })));
    expect(answers.every((a) => a.online)).toBe(true);
    expect(hits).toBe(1);
  });

  it("reads at most 64 KB of the answer", async () => {
    globalThis.__fuobeTestGpuPort = Number(new URL(url).port);
    body = JSON.stringify({ system: { comfyui_version: "1" }, pad: "x".repeat(100 * 1024) });
    expect((await gpuState("acct-l3-big", { url })).online).toBe(false);
  });
});

describe("L-6: links the owner pastes never reach this server's own public address", () => {
  it("refuses this machine's public addresses, and still fetches other public ones", () => {
    process.env.FUOBE_SELF_ADDRESSES = "8.8.4.4";
    expect(remote.blockedForLinks("8.8.4.4")).toBe(true);
    expect(remote.blockedForLinks("8.8.8.8")).toBe(false);
    expect(remote.blockedForLinks("10.0.0.5")).toBe(true);
    // A LAN install that allows private addresses still may reach its LAN.
    process.env.FUOBE_ALLOW_PRIVATE_URLS = "1";
    expect(remote.blockedForLinks("10.0.0.5")).toBe(false);
    expect(remote.blockedForLinks("8.8.4.4")).toBe(true);
  });
});

describe("L-7: an account's GPU is never a link-local or cloud metadata address", () => {
  it("refuses them even where FUOBE_ALLOW_PRIVATE_URLS=1 lets LAN addresses through", () => {
    process.env.FUOBE_ALLOW_PRIVATE_URLS = "1";
    for (const ip of ["169.254.169.254", "169.254.0.1", "fe80::1", "100.100.100.200", "fd00:ec2::254"]) expect(remote.blockedForAccounts(ip), ip).toBe(true);
    expect(remote.blockedForAccounts("192.168.1.20")).toBe(false);
  });
});

describe("L-12: an account's list is read through an index", () => {
  it("has an index on the run's account", () => {
    const plan = db().prepare("EXPLAIN QUERY PLAN SELECT id FROM generations g WHERE json_extract(g.request_json, '$.account') = ?").all("x") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX generations_account/);
  });
});

describe("L-13: the owner's Library counts and live feed leave accounts' runs out", () => {
  it("counts only the owner's runs", () => {
    const before = libraryFacets().total;
    runOf("someone-else");
    expect(libraryFacets().total).toBe(before);
    runOf();
    expect(libraryFacets().total).toBe(before + 1);
  });

  it("sends no live update for an account's run", async () => {
    const mine = runOf();
    const theirs = runOf("someone-else");
    const seen: string[] = [];
    const off = live.subscribe((e) => seen.push(e.id));
    try {
      db().prepare("UPDATE generations SET message = 'tick' WHERE id IN (?, ?)").run(mine, theirs);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      off();
    }
    expect(seen).toContain(mine);
    expect(seen).not.toContain(theirs);
  });
});

describe("L-14: a switched-off account's GPU is never used", () => {
  it("has no GPU while it is off", () => {
    const a = auth.createAccount("switched-off@example.com", "long enough").id;
    auth.setAccountGpu(a, { url: "https://gpu.example.com" });
    expect(auth.accountGpu(a)).toEqual({ url: "https://gpu.example.com" });
    auth.setAccountDisabled(a, true);
    expect(auth.accountGpu(a)).toBeNull();
    auth.setAccountDisabled(a, false);
    expect(auth.accountGpu(a)).not.toBeNull();
  });
});

describe("L-16: pages carry a Content-Security-Policy, and no X-Powered-By", () => {
  it("sends a static policy on pages, never on stored files (they have their own)", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    const csp = rules.filter((r) => r.headers.some((h) => h.key === "Content-Security-Policy"));
    expect(csp).toHaveLength(1);
    const value = csp[0].headers.find((h) => h.key === "Content-Security-Policy")!.value;
    for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'", "form-action 'self'"]) expect(value).toContain(d);
    // The source is a path-to-regexp pattern: "/:path(<regex>)".
    const re = new RegExp(`^/${/^\/:path\((.*)\)$/.exec(csp[0].source)![1]}$`);
    expect(re.test("/")).toBe(true);
    expect(re.test("/motions")).toBe(true);
    expect(re.test("/s/abc")).toBe(true);
    expect(re.test("/api/files/outputs/a.svg")).toBe(false);
    expect(re.test("/s/abc/f/outputs/a.svg")).toBe(false);
  });
});

describe("L-17: sign-in fails closed when the sign-in data can't be read", () => {
  it("keeps sign-in on, signs nobody in and writes nothing while the sign-in tables can't be used", () => {
    const owner = auth.createSession().value;
    const before = auth.listAccounts().length;
    globalThis.__fuobeAuthTablesError = "a test";
    try {
      expect(auth.authEnabled()).toBe(true);
      expect(auth.validSession(owner)).toBe(false);
      expect(() => auth.createAccount("late@example.com", "long enough")).toThrow(/can't be read/);
    } finally {
      globalThis.__fuobeAuthTablesError = null;
    }
    expect(auth.validSession(owner)).toBe(true);
    expect(auth.listAccounts()).toHaveLength(before);
    // An auth.json that can't be read, waiting to move into the database: tests/auth-migration.test.ts.
  });
});

describe("L-4: the local deploy notes can't be committed by accident", () => {
  it("git-ignores them", () => {
    const ignore = fs.readFileSync(path.join(import.meta.dirname, "..", ".gitignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain("/docs/deploy.md");
    expect(ignore).toContain("/deploy/");
  });
});

describe("L-2: an unknown record or link answers 404 behind an HTTPS reverse proxy", () => {
  it("makes the 404 page itself instead of a rewrite Next would send to another server", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const at = (url: string) => proxy(new NextRequest(url, { headers: { host: "fuobe.example", "x-forwarded-proto": "https" } }));
    for (const [p, title, back] of [
      ["/apps/does-not-exist", "This app isn’t here", "/apps"],
      ["/canvas/nope-nope-nope", "This canvas isn’t here", "/canvas"],
      ["/upscale/nope", "This page isn’t here", "/upscale"],
    ]) {
      const r = at(`https://fuobe.example${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("x-middleware-rewrite"), p).toBeNull();
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      const html = await r.text();
      // Branded: the site's mark and fonts, the visitor's theme, a way back to the section; nothing about a library.
      expect(html, p).toContain(`<h1>${title}</h1>`);
      expect(html, p).toContain(`href="${back}"`);
      expect(html, p).toMatch(/Instrument Serif/);
      expect(html, p).toMatch(/localStorage\.getItem\("theme"\)/);
      expect(html, p).not.toMatch(/library/);
    }
    // An unknown app points at the apps, then Home; a guest isn't told about a library they don't have.
    const app = await at("https://fuobe.example/apps/does-not-exist").text();
    expect(app).toMatch(/<a class="back" href="\/apps">Browse apps<\/a><a class="go" href="\/">Home<\/a>/);
    expect(app).not.toMatch(/library/);
    expect(await at("https://fuobe.example/canvas/nope-nope-nope").text()).not.toMatch(/Browse apps/);
    const share = at(`https://fuobe.example/s/${"A".repeat(44)}`);
    expect(share.status).toBe(404);
    expect(share.headers.get("x-middleware-rewrite")).toBeNull();
    expect(share.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(await share.text()).toMatch(/This link isn.t available/);
    // A link that can't be a share (a wrong length) is the same 404, not a page with a 200.
    for (const p of ["/s/badtoken", `/s/${"A".repeat(43)}`, "/s/gone"]) {
      const r = at(`https://fuobe.example${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("x-robots-tag"), p).toMatch(/noindex/);
      expect(await r.text(), p).toMatch(/Make your own with Fuobe/);
    }
    // Old ?mode= links open the mode's own page (any case), without the mode in the query.
    const mode = at("https://fuobe.example/audio?mode=Music&x=1");
    expect(mode.status).toBe(307);
    expect(new URL(mode.headers.get("location")!, "https://fuobe.example").pathname).toBe("/audio/music");
    expect(new URL(mode.headers.get("location")!, "https://fuobe.example").search).toBe("?x=1");
    // /audio opens on Clean up voice: an old link to Speech there (its voice, words or model) opens Speech, query kept.
    for (const q of ["?voice=%2Fapi%2Ffiles%2Fa.wav", "?prompt=Hello", "?model=elevenlabs-v4&x=1"]) {
      const old = at(`https://fuobe.example/audio${q}`);
      expect(old.status, q).toBe(307);
      const to = new URL(old.headers.get("location")!, "https://fuobe.example");
      expect(to.pathname + to.search, q).toBe(`/audio/speech${q}`);
    }
    // Clean up voice's own hand-off (?audio=, ?video=) stays on /audio.
    expect(at("https://fuobe.example/audio?audio=%2Fapi%2Ffiles%2Fa.wav").headers.get("location")).toBeNull();
    // A plain-HTTP install keeps the rewrite to the app's own 404 pages.
    expect(proxy(new NextRequest("http://localhost:3000/apps/does-not-exist")).headers.get("x-middleware-rewrite")).toMatch(/_fuobe-not-found$/);
  });
});
