import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";
import { authDb, authSecret, dbBytes } from "./helpers/auth-db";
// Route handlers call connection(); outside a request scope it would throw.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
// Route handlers set the session cookie through cookies() (no request scope in a test): a jar that only records.
const jar = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn(), get: vi.fn() }));
vi.mock("next/headers", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/headers")>()), cookies: async () => jar }));

const dir = tempDir("fuobe-signup-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_PUBLIC_SIGNUP;
delete process.env.FUOBE_ALLOWED_ORIGINS;
const auth = await import("@/server/auth");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");

const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";
const toLogin = (r: Response) => r.status === 307 && new URL(r.headers.get("location") ?? "", "http://x").pathname === "/login";

function req(url: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  return new NextRequest(`http://localhost:3000${url}`, { method, headers, ...(method !== "GET" && method !== "HEAD" && { body: "{}" }) });
}

beforeAll(() => auth.setPassword("install password"));
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
  delete process.env.FUOBE_ALLOWED_ORIGINS;
});

describe("accounts", () => {
  it("signs up with a lower-cased email and a salted scrypt hash, never the password", () => {
    const a = auth.createAccount("  Judge@Example.COM ", "long enough");
    expect(a.email).toBe("judge@example.com");
    expect(a.hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(a.createdAt).toBeGreaterThan(0);
    expect(dbBytes(dir)).not.toContain("long enough");
    expect(authDb().prepare("SELECT email FROM auth_accounts WHERE id = ?").get(a.id)).toEqual({ email: "judge@example.com" });
  });

  it("logs in with the right password only", () => {
    expect(auth.checkAccount("JUDGE@example.com", "long enough")?.email).toBe("judge@example.com");
    expect(auth.checkAccount("judge@example.com", "wrong password")).toBeNull();
    expect(auth.checkAccount("nobody@example.com", "long enough")).toBeNull();
    expect(auth.checkAccount("not an email", "long enough")).toBeNull();
  });

  it("refuses a duplicate email, a bad email and a short password", () => {
    expect(() => auth.createAccount("judge@EXAMPLE.com", "another one")).toThrow(/already exists/);
    expect(() => auth.createAccount("judge@example.com", "another one")).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => auth.createAccount("no-at-sign", "long enough")).toThrow(/valid email/);
    expect(() => auth.createAccount("new@example.com", "short")).toThrow(/8 characters/);
  });

  it("keeps the install password working, and an account session is never the owner's", () => {
    expect(auth.checkPassword("install password")).toBe(true);
    const a = auth.checkAccount("judge@example.com", "long enough")!;
    const s = auth.createSession(a.id);
    expect(auth.sessionViewer(s.value)).toMatchObject({ kind: "account", account: { id: a.id } });
    expect(auth.validSession(s.value)).toBe(false);
    // Dropping the account id doesn't make an owner session.
    const [exp, , mac] = s.value.split(".");
    expect(auth.sessionViewer(`${exp}.${mac}`)).toBeNull();
    expect(auth.sessionViewer(s.value.replace(a.id, "0".repeat(a.id.length)))).toBeNull();
    expect(auth.validSession(auth.createSession().value)).toBe(true);
  });
});

describe("the switch", () => {
  it("is off by default, on with FUOBE_PUBLIC_SIGNUP=1 or the Settings switch, and FUOBE_PUBLIC_SIGNUP=0 wins", () => {
    expect(auth.publicSignup("localhost:3000")).toBe(false);
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(auth.publicSignup("localhost:3000")).toBe(true);
    process.env.FUOBE_PUBLIC_SIGNUP = "0";
    expect(() => auth.setPublicSignup(true)).toThrow(/FUOBE_PUBLIC_SIGNUP/);
    delete process.env.FUOBE_PUBLIC_SIGNUP;
    auth.setPublicSignup(true);
    expect(auth.publicSignup("localhost:3000")).toBe(true);
    process.env.FUOBE_PUBLIC_SIGNUP = "0";
    expect(auth.publicSignup("localhost:3000")).toBe(false);
    delete process.env.FUOBE_PUBLIC_SIGNUP;
    auth.setPublicSignup(false);
    expect(auth.publicSignup("localhost:3000")).toBe(false);
  });

  it("is on at fuobe.com, but only on the install that names fuobe.com as its address", () => {
    // A self-hosted studio reached by IP: a forged Host header doesn't open it.
    expect(auth.publicSignup("fuobe.com")).toBe(false);
    process.env.FUOBE_ALLOWED_ORIGINS = "fuobe.com";
    expect(auth.publicSignup("fuobe.com")).toBe(true);
    expect(auth.publicSignup("www.fuobe.com")).toBe(true);
    expect(auth.publicSignup("evil.example")).toBe(false);
    process.env.FUOBE_PUBLIC_SIGNUP = "0";
    expect(auth.publicSignup("fuobe.com")).toBe(false);
  });
});

describe("proxy with public sign-up on", () => {
  let account = "";
  beforeAll(() => {
    account = auth.createSession(auth.createAccount("proxy@example.com", "long enough").id).value;
  });

  it("lets a guest open pages and the catalog reads", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const p of ["/", "/motions", "/layers", "/cinema", "/image-to-3d", "/settings"]) expect(passed(proxy(req(p))), p).toBe(true);
    for (const p of ["/api/status", "/api/models", "/api/search-index"]) expect(passed(proxy(req(p))), p).toBe(true);
    expect(passed(proxy(req("/motions", { method: "HEAD" })))).toBe(true);
  });

  it("never shows a guest the owner's library", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const list = proxy(req("/api/generations?limit=40"));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
    for (const p of ["/api/files/outputs/a.png", "/api/settings", "/api/auth/tokens", "/api/generations/abc", "/api/layers/abc", "/api/uploads", "/api/assist/t1"]) {
      const r = proxy(req(p));
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
    }
    // Assist's memory: none.
    expect(await proxy(req("/api/assist/memory?scope=personal")).json()).toEqual({ items: [] });
    // Catalogs mixed with the owner's items: the route is told it's a guest.
    for (const p of ["/api/moodboards", "/api/assist"]) {
      const r = proxy(req(p));
      expect(passed(r), p).toBe(true);
      expect(r.headers.get(`x-middleware-request-${access.GUEST_HEADER}`), p).toBe("1");
    }
  });

  it("refuses a guest's every change with a 401 the client turns into the sign-up prompt", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const [method, p] of [
      ["POST", "/api/generations"],
      ["POST", "/api/uploads"],
      ["PUT", "/api/settings"],
      ["POST", "/api/layers"],
      ["DELETE", "/api/generations/abc"],
      ["PATCH", "/api/cinema/projects/abc"],
    ]) {
      const r = proxy(req(p, { method }));
      expect(r.status, `${method} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
      expect((await r.json()).error).toMatch(/free account/);
    }
    // Price checks only plan a run.
    expect(passed(proxy(req("/api/generations?preview=1", { method: "POST" })))).toBe(true);
    expect(passed(proxy(req("/api/shorts/estimate", { method: "POST" })))).toBe(true);
  });

  it("lets an account open every page, but never settings, keys or tokens", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const p of ["/", "/motions", "/layers", "/settings", "/api/status", "/api/models"]) expect(passed(proxy(req(p, { cookie: account }))), p).toBe(true);
    for (const [method, p] of [
      ["PUT", "/api/settings"],
      ["PUT", "/api/settings/models"],
      ["POST", "/api/auth/password"],
      ["GET", "/api/auth/tokens"],
      ["POST", "/api/auth/tokens"],
      ["PUT", "/api/auth/public"],
      ["POST", "/api/loras"],
      ["POST", "/api/assist/connectors"],
    ]) {
      const r = proxy(req(p, { method, cookie: account }));
      expect(r.status, `${method} ${p}`).toBe(403);
      expect((await r.json()).error).toMatch(/aren't part of your account/);
    }
  });

  it("keeps the install password and API tokens working, with everything open", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const owner = auth.createSession().value;
    expect(passed(proxy(req("/api/settings", { method: "PUT", cookie: owner })))).toBe(true);
    expect(passed(proxy(req("/api/auth/tokens", { cookie: owner })))).toBe(true);
    const { token } = auth.createToken("CI");
    expect(passed(proxy(req("/api/settings", { method: "PUT", headers: { authorization: `Bearer ${token}` } })))).toBe(true);
  });

  it("opens sign-up, log-in and who-am-I to everyone", () => {
    for (const p of ["/login", "/api/auth/login", "/api/auth/signup", "/api/auth/me"]) {
      expect(passed(proxy(req(p, { method: p === "/login" || p === "/api/auth/me" ? "GET" : "POST" }))), p).toBe(true);
    }
  });
});

describe("proxy with public sign-up off (today's behaviour)", () => {
  it("sends guests to sign in and refuses accounts; the owner still gets in", async () => {
    const account = auth.createSession(auth.createAccount("off@example.com", "long enough").id).value;
    expect(toLogin(proxy(req("/motions")))).toBe(true);
    expect(toLogin(proxy(req("/")))).toBe(true);
    expect(proxy(req("/api/status")).status).toBe(401);
    const list = proxy(req("/api/generations"));
    expect(list.status).toBe(401);
    expect(list.headers.get(access.GUEST_HEADER)).toBeNull();
    expect(proxy(req("/api/generations", { method: "POST" })).status).toBe(401);
    expect(toLogin(proxy(req("/motions", { cookie: account })))).toBe(true);
    expect(proxy(req("/api/generations", { cookie: account })).status).toBe(401);
    const owner = auth.createSession().value;
    expect(passed(proxy(req("/motions", { cookie: owner })))).toBe(true);
    expect(passed(proxy(req("/api/generations", { method: "POST", cookie: owner })))).toBe(true);
  });
});

describe("accounts never run on the owner's keys or GPU", () => {
  it("refuses an account's runs with Connect your GPU, and the tools a GPU wouldn't unlock with own-gpu-tool", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(auth.createAccount("gpu@example.com", "long enough").id).value;
    // The studios' generations run on its own GPU: connect one.
    const run = proxy(req("/api/generations", { method: "POST", cookie }));
    expect(run.status).toBe(403);
    expect(run.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await run.json()).code).toBe("connect-gpu");
    // Everything else wouldn't run on it even once connected: said first, with no Connect your GPU card.
    for (const p of [
      "/api/canvases/c1/run",
      "/api/layers/l1/jobs",
      "/api/enhance",
      "/api/brands/b1/chat",
      // Faceless, Explainer and Content Factory runs go to their routes (tests/account-content.test.ts); handing a brief
      // to Claude stays the owner's.
      "/api/content-factory/claude",
      // A run route that ignores ?preview=1 isn't a price check.
      "/api/faceless/episodes/e1/estimate",
      // Restore & colourise's prompt writer (the studio's AI helper).
      "/api/restore/prompt",
      // Plan layout plans with the studio's own AI helper.
      "/api/layout/plan",
    ]) {
      const r = proxy(req(p, { method: "POST", cookie }));
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBeNull();
      expect((await r.json()).code, p).toBe("own-gpu-tool");
    }
    // Cinema Studio's takes and the video tools (Remove a person's mask preview and "Redo from here", Katana's retry) run
    // on its own GPU or key (tests/account-cinema.test.ts, tests/account-video-tools.test.ts): with neither, connect one
    // first. A run route that ignores ?preview=1 isn't a price check.
    for (const p of [
      "/api/cinema/projects/p1/generate",
      "/api/cinema/projects/p1/generate?preview=1",
      "/api/cinema/projects/p1/items/g1/finish",
      "/api/remove-object/preview",
      "/api/remove-object/reroll",
      "/api/katana/k1/retry",
      // Restore & colourise runs on its own GPU.
      "/api/restore",
    ]) {
      const r = proxy(req(p, { method: "POST", cookie }));
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBe("1");
      expect((await r.json()).code, p).toBe("connect-gpu");
    }
    // Regenerate to 1080p in Faceless and Enhance in Shorts run on its own GPU: the routes check its own episode or
    // session, then its GPU (tests/account-content.test.ts, tests/account-shorts.test.ts).
    for (const p of ["/api/faceless/episodes/e1/regenerate", "/api/shorts/sessions/s1/segments/0/enhance"]) expect(passed(proxy(req(p, { method: "POST", cookie }))), p).toBe(true);
    // Owner-only routes say so (not "connect your GPU").
    expect(proxy(req("/api/mcp", { method: "POST", cookie })).headers.get(access.CONNECT_GPU_HEADER)).toBeNull();
    // Price checks and signing out are fine.
    for (const [method, p] of [
      ["POST", "/api/generations?preview=1"],
      ["POST", "/api/ads/estimate"],
      ["POST", "/api/restore/estimate"],
      ["POST", "/api/assist/skills/s1/estimate"],
      ["POST", "/api/auth/logout"],
    ]) {
      expect(passed(proxy(req(p, { method, cookie }))), `${method} ${p}`).toBe(true);
    }
  });
});

describe("accounts never see or change the owner's library", () => {
  const families: Record<string, { lists: string[]; records: string[]; changes: [string, string][] }> = {
    generations: {
      // (/api/generations, its facets, its zip and its bulk changes go to the routes, which take only the account's own runs:
      // tests/account-gpu.test.ts, tests/public-signup-visitors.test.ts, tests/account-zip.test.ts.)
      lists: ["/api/generations/trash"],
      records: ["/api/generations/g1"],
      changes: [["PATCH", "/api/generations/g1"], ["DELETE", "/api/generations/g1"], ["DELETE", "/api/generations/trash"], ["POST", "/api/generations/g1/cancel"]],
    },
    // (POST /api/uploads is the account's own: the route checks it, tests/account-uploads.test.ts; so is the list of its
    // files, /api/assets: tests/public-signup-visitors.test.ts.)
    files: { lists: [], records: ["/api/files/outputs/a.png", "/api/assets/a1", "/api/uploads"], changes: [["DELETE", "/api/assets/a1"]] },
    folders: { lists: ["/api/folders"], records: ["/api/folders/f1", "/api/folders/f1/zip"], changes: [["POST", "/api/folders"], ["PATCH", "/api/folders/f1"], ["DELETE", "/api/folders/f1"]] },
    shares: { lists: ["/api/shares"], records: ["/api/shares/s1"], changes: [["POST", "/api/shares"], ["PATCH", "/api/shares/s1"], ["DELETE", "/api/shares/s1"]] },
    layers: { lists: ["/api/layers"], records: ["/api/layers/l1"], changes: [["POST", "/api/layers"], ["PATCH", "/api/layers/l1"], ["DELETE", "/api/layers/l1"], ["POST", "/api/layers/l1/versions"]] },
    elements: { lists: ["/api/elements"], records: ["/api/elements/e1"], changes: [["POST", "/api/elements"], ["PATCH", "/api/elements/e1"], ["DELETE", "/api/elements/e1"]] },
    canvases: { lists: ["/api/canvases"], records: ["/api/canvases/c1"], changes: [["POST", "/api/canvases"], ["PATCH", "/api/canvases/c1"], ["DELETE", "/api/canvases/c1"], ["POST", "/api/canvases/c1/duplicate"]] },
    // (Cinema Studio's projects go to the routes, which answer an account with its own projects only:
    // tests/account-cinema.test.ts.)
    storyboards: { lists: [], records: ["/api/storyboards"], changes: [["POST", "/api/storyboards"]] },
    assist: {
      lists: ["/api/assist/projects", "/api/assist/memory"],
      records: ["/api/assist/t1", "/api/assist/projects/p1"],
      changes: [["PATCH", "/api/assist/t1"], ["DELETE", "/api/assist/t1"], ["POST", "/api/assist/projects"], ["POST", "/api/assist/memory"]],
    },
    brands: { lists: ["/api/brands", "/api/products"], records: ["/api/brands/b1"], changes: [["POST", "/api/brands"], ["DELETE", "/api/brands/b1"], ["POST", "/api/products"]] },
  };

  for (const [family, f] of Object.entries(families)) {
    it(`hides and protects ${family}`, async () => {
      process.env.FUOBE_PUBLIC_SIGNUP = "1";
      const cookie = auth.createSession(auth.createAccount(`lib-${family}@example.com`, "long enough").id).value;
      for (const p of f.lists) {
        const r = proxy(req(p, { cookie }));
        expect(r.status, p).toBe(200);
        const body = (await r.json()) as { items?: unknown[]; total?: number };
        expect(body.items ?? [], p).toEqual([]);
        if ("total" in body) expect(body.total).toBe(0);
      }
      for (const p of f.records) expect(proxy(req(p, { cookie })).status, p).toBe(403);
      for (const [method, p] of f.changes) {
        const r = proxy(req(p, { method, cookie }));
        expect(r.status, `${method} ${p}`).toBe(403);
      }
    });
  }

  it("says the library isn't theirs, not \"connect your GPU\", for a library change", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(auth.createAccount("lib-message@example.com", "long enough").id).value;
    const r = proxy(req("/api/folders", { method: "POST", cookie }));
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBeNull();
    expect((await r.json()).code).toBe("library");
    const read = proxy(req("/api/generations/g1", { cookie }));
    expect(read.headers.get(access.GUEST_HEADER)).toBeNull();
    expect((await read.json()).error).toMatch(/can't find/);
  });

  it("keeps the owner's runs unchanged", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const owner = auth.createSession().value;
    for (const p of ["/api/generations", "/api/enhance", "/api/canvases/c1/run"]) expect(passed(proxy(req(p, { method: "POST", cookie: owner }))), p).toBe(true);
  });

  it("knows a price check from a run", () => {
    expect(access.isPriceCheck("POST", "/api/generations", "?preview=1")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/dub/d1/voice", "?preview=1")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/generations", "")).toBe(false);
    expect(access.isPriceCheck("POST", "/api/canvases/c1/run", "?preview=1")).toBe(false);
    expect(access.isPriceCheck("POST", "/api/shorts/sessions/s1/segments/estimate", "")).toBe(false);
    expect(access.isPriceCheck("GET", "/api/shorts/estimate", "")).toBe(false);
    // AI Influencer, Photodump, Fashion Factory and Character Sheet price on load: a visitor's page never opens a card for it.
    for (const p of ["/api/influencer", "/api/photodump", "/api/photodump/fashion", "/api/photodump/character"]) {
      expect(access.isPriceCheck("POST", p, "?preview=1"), p).toBe(true);
      expect(access.isPriceCheck("POST", p, ""), p).toBe(false);
    }
  });

  it("lets a guest's and an account's price check on AI Influencer through", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(auth.createAccount("influencer@example.com", "long enough").id).value;
    expect(passed(proxy(req("/api/influencer?preview=1", { method: "POST" })))).toBe(true);
    expect(passed(proxy(req("/api/influencer?preview=1", { method: "POST", cookie })))).toBe(true);
    // Its run is open to accounts (on their own GPU or key): a guest gets the sign-up card.
    const guest = proxy(req("/api/influencer", { method: "POST" }));
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
  });
});

describe("accounts with their own GPU", () => {
  it("run the studios' generations once connected; other tools still say so", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = auth.createAccount("own-gpu@example.com", "long enough");
    const cookie = auth.createSession(a.id).value;
    expect(passed(proxy(req("/api/account/gpu", { method: "PUT", cookie })))).toBe(true);
    expect(passed(proxy(req("/api/account/gpu", { method: "DELETE", cookie })))).toBe(true);
    expect(proxy(req("/api/generations", { method: "POST", cookie })).headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    auth.setAccountGpu(a.id, { url: "https://gpu.example" });
    expect(passed(proxy(req("/api/generations", { method: "POST", cookie })))).toBe(true);
    const tool = proxy(req("/api/canvases/c1/run", { method: "POST", cookie }));
    expect(tool.status).toBe(403);
    expect(tool.headers.get(access.CONNECT_GPU_HEADER)).toBeNull();
    expect((await tool.json()).code).toBe("own-gpu-tool");
    // Still never settings, keys or tokens.
    expect(proxy(req("/api/settings", { method: "PUT", cookie })).status).toBe(403);
  });

  it("keeps a guest out of Your GPU", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(proxy(req("/api/account/gpu", { method: "PUT" })).status).toBe(401);
    expect(proxy(req("/api/account/gpu")).status).toBe(401);
  });
});

describe("one reading of the session cookie (audit: proxy and routes must agree on who is asking)", () => {
  let account = "";
  beforeAll(() => {
    account = auth.createSession(auth.createAccount("cookie-twice@example.com", "long enough").id).value;
  });
  const raw = (url: string, cookie: string, method = "GET") =>
    new NextRequest(`http://localhost:3000${url}`, { method, headers: { cookie }, ...(method !== "GET" && { body: "{}" }) });
  const doubled = () => `${auth.SESSION_COOKIE}=x; ${auth.SESSION_COOKIE}=${account}`;
  const encoded = () => `${auth.SESSION_COOKIE}=${account.replaceAll(".", "%2E")}`;

  it("reads exactly one plain session pair, and nothing else", () => {
    expect(auth.sessionCookieFrom(`${auth.SESSION_COOKIE}=${account}`)).toBe(account);
    expect(auth.sessionCookieFrom(`a=1; ${auth.SESSION_COOKIE}=${account}; b=2`)).toBe(account);
    expect(auth.sessionCookieFrom(doubled())).toBeUndefined();
    expect(auth.sessionCookieFrom(`${auth.SESSION_COOKIE}=${account}; ${auth.SESSION_COOKIE}=${account}`)).toBeUndefined();
    expect(auth.sessionCookieFrom(encoded())).toBeUndefined();
    expect(auth.sessionCookieFrom(`${auth.SESSION_COOKIE}="${account}"`)).toBeUndefined();
    expect(auth.sessionCookieFrom(null)).toBeUndefined();
  });

  it("treats a doubled or encoded cookie as a guest in the proxy AND in the routes", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const cookie of [doubled(), encoded()]) {
      // The proxy: an account may list its own runs and start one; a guest may not start one.
      expect(proxy(raw("/api/generations", cookie, "POST")).status, cookie).toBe(401);
      expect(proxy(raw("/api/account/gpu", cookie)).status, cookie).toBe(401);
      // The routes see the same guest, never "no account, so the owner".
      expect(auth.requestViewer(raw("/api/generations", cookie)).kind, cookie).toBe("guest");
      expect(auth.requestAccount(raw("/api/generations", cookie)), cookie).toBeNull();
    }
    // The plain cookie is still the account, in both.
    expect(auth.requestViewer(raw("/api/generations", `${auth.SESSION_COOKIE}=${account}`)).kind).toBe("account");
    expect(passed(proxy(raw("/api/account/gpu", `${auth.SESSION_COOKIE}=${account}`)))).toBe(true);
  });

  it("the run and list routes answer a guest as a guest, never as the owner", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const { GET, POST } = await import("@/app/api/generations/route");
    const list = await GET(raw("/api/generations", doubled()));
    expect(await list.json()).toEqual({ items: [] });
    const run = await POST(raw("/api/generations", doubled(), "POST"));
    expect(run.status).toBe(401);
  });
});

describe("an account changes its password (Settings → Account)", () => {
  const me = () => import("@/app/api/auth/me/route");
  const patch = (cookie: string, body: unknown) =>
    new Request("http://localhost:3000/api/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: `${auth.SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify(body),
    });
  const remove = (cookie: string, body: unknown) =>
    new Request("http://localhost:3000/api/auth/me", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: `${auth.SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify(body),
    });
  const secret = authSecret;
  /** An account cookie signed with the secret alone, as before account keys held the password's fingerprint. */
  const legacy = (id: string) => {
    const payload = `${Date.now() + 86_400_000}.${id}`;
    return `${payload}.${crypto.createHmac("sha256", secret()).update(payload).digest("base64url")}`;
  };
  afterEach(() => jar.set.mockClear());

  it("needs the current password, ends every other sign-in, and keeps this browser signed in", async () => {
    const a = auth.createAccount("new-password@example.com", "first password");
    const here = auth.createSession(a.id).value;
    // Another browser's sign-in, a moment later: a different cookie, not the same string again.
    await new Promise((r) => setTimeout(r, 5));
    const elsewhere = auth.createSession(a.id).value;
    expect(elsewhere).not.toBe(here);
    const old = legacy(a.id);
    const owner = auth.createSession().value;
    // A cookie from before this change still works, until the account changes its password.
    expect(auth.sessionViewer(old)?.kind).toBe("account");

    const wrong = await (await me()).PATCH(patch(here, { current: "not my password", next: "second password" }));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toMatch(/current password is wrong/);
    const short = await (await me()).PATCH(patch(here, { current: "first password", next: "short" }));
    expect(short.status).toBe(400);
    expect((await short.json()).error).toMatch(/8 characters/);
    // The same password again isn't a change: nobody is signed out for it.
    const same = await (await me()).PATCH(patch(here, { current: "first password", next: "first password" }));
    expect(same.status).toBe(400);
    expect((await same.json()).error).toMatch(/new password/);
    expect(auth.sessionViewer(here)?.kind).toBe("account");
    expect(auth.sessionViewer(elsewhere)?.kind).toBe("account");
    expect(jar.set).not.toHaveBeenCalled();

    const ok = await (await me()).PATCH(patch(here, { current: "first password", next: "second password" }));
    expect(ok.status).toBe(200);
    // Every cookie the account had is refused now: this browser's old one, another browser's, one from before.
    for (const cookie of [here, elsewhere, old]) expect(auth.sessionViewer(cookie)).toBeNull();
    // This browser has a new one, which works.
    expect(jar.set).toHaveBeenCalledWith(auth.SESSION_COOKIE, expect.any(String), expect.objectContaining({ httpOnly: true, path: "/" }));
    const fresh = jar.set.mock.calls[0][1] as string;
    expect(auth.sessionViewer(fresh)).toMatchObject({ kind: "account", account: { id: a.id } });
    expect(legacy(a.id)).not.toBe(fresh);
    expect(auth.sessionViewer(legacy(a.id))).toBeNull();
    // The new password logs in, the old one doesn't, and the owner is still signed in.
    expect(auth.checkAccount("new-password@example.com", "second password")?.id).toBe(a.id);
    expect(auth.checkAccount("new-password@example.com", "first password")).toBeNull();
    expect(auth.validSession(owner)).toBe(true);
    // The old cookie can't try again: it's signed out (401, so the page shows Log in).
    const again = await (await me()).PATCH(patch(here, { current: "second password", next: "third password" }));
    expect(again.status).toBe(401);
    expect((await again.json()).error).toMatch(/signed out/);
  });

  it("allows five tries a minute, then answers 429", async () => {
    const a = auth.createAccount("password-guesser@example.com", "the real one");
    const cookie = auth.createSession(a.id).value;
    for (let i = 0; i < 5; i++) expect((await (await me()).PATCH(patch(cookie, { current: `guess ${i}`, next: "a new password" }))).status).toBe(403);
    const sixth = await (await me()).PATCH(patch(cookie, { current: "the real one", next: "a new password" }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(auth.checkAccount("password-guesser@example.com", "the real one")?.id).toBe(a.id);
  });

  it("counts deleting the account with changing its password: five guesses a minute in all, not five each", async () => {
    const a = auth.createAccount("two-door-guesser@example.com", "the real one");
    const cookie = auth.createSession(a.id).value;
    for (let i = 0; i < 3; i++) expect((await (await me()).PATCH(patch(cookie, { current: `guess ${i}`, next: "a new password" }))).status).toBe(403);
    for (let i = 3; i < 5; i++) expect((await (await me()).DELETE(remove(cookie, { password: `guess ${i}` }))).status).toBe(403);
    expect((await (await me()).DELETE(remove(cookie, { password: "the real one" }))).status).toBe(429);
    expect((await (await me()).PATCH(patch(cookie, { current: "the real one", next: "a new password" }))).status).toBe(429);
    expect(auth.checkAccount("two-door-guesser@example.com", "the real one")?.id).toBe(a.id);
  });

  it("refuses a guest (signed out: 401) and the owner (403): it's an account's own password", async () => {
    const owner = auth.createSession().value;
    expect((await (await me()).PATCH(patch(owner, { current: "install password", next: "a new password" }))).status).toBe(403);
    expect((await (await me()).PATCH(patch("", { current: "x", next: "a new password" }))).status).toBe(401);
    expect(auth.checkPassword("install password")).toBe(true);
  });

  it("deleting from a browser that was signed out elsewhere is a 401 (Log in), not a wrong password", async () => {
    const a = auth.createAccount("signed-out-deleter@example.com", "first password");
    const here = auth.createSession(a.id).value;
    await new Promise((r) => setTimeout(r, 5));
    const elsewhere = auth.createSession(a.id).value;
    expect((await (await me()).PATCH(patch(elsewhere, { current: "first password", next: "second password" }))).status).toBe(200);
    const del = await (await me()).DELETE(remove(here, { password: "second password" }));
    expect(del.status).toBe(401);
    expect((await del.json()).error).toMatch(/signed out/);
    expect(auth.checkAccount("signed-out-deleter@example.com", "second password")?.id).toBe(a.id);
    // The owner still gets a 403: the studio isn't an account.
    expect((await (await me()).DELETE(remove(auth.createSession().value, { password: "install password" }))).status).toBe(403);
  });
});

describe("Set it up with my AI", () => {
  it("opens a setup's status, the steps for an AI and Fuobe's files to everyone", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const p of ["/api/setup/ABCD-EFGH-JKMN", "/api/setup/abcdefghjkmn", "/api/setup/guide/direct/windows", "/api/setup/guide/address/other", "/api/setup/files/fuobe_guard.py", "/api/setup/files/start/8188"]) {
      expect(access.guestRead(p), p).toEqual({ kind: "pass" });
      expect(passed(proxy(req(p))), p).toBe(true);
    }
    for (const p of ["/api/setup/ABCD-EFGH", "/api/setup/guide/direct/android", "/api/setup/files/other.py", "/api/setup/session", "/api/setup/session/ABCD-EFGH-JKMN/wait"]) {
      expect(access.guestRead(p), p).toEqual({ kind: "closed" });
    }
  });

  it("lets an account make, report on, wait on and end its own code, and a guest gets the sign-up card", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(access.accountMayChange("POST", "/api/setup/session", "")).toBe(true);
    expect(access.accountMayChange("POST", "/api/setup/session/ABCD-EFGH-JKMN/report", "")).toBe(true);
    expect(access.accountMayChange("DELETE", "/api/setup/session/ABCD-EFGH-JKMN", "")).toBe(true);
    expect(access.accountMayChange("DELETE", "/api/setup/session", "")).toBe(false);
    expect(access.accountOwnRead("/api/setup/session/ABCD-EFGH-JKMN/wait")).toBe(true);
    const cookie = auth.createSession(auth.createAccount("ai-setup@example.com", "long enough").id).value;
    expect(passed(proxy(req("/api/setup/session", { method: "POST", cookie })))).toBe(true);
    expect(passed(proxy(req("/api/setup/session/ABCD-EFGH-JKMN/report", { method: "POST", cookie })))).toBe(true);
    expect(passed(proxy(req("/api/setup/session/ABCD-EFGH-JKMN/wait", { cookie })))).toBe(true);
    expect(passed(proxy(req("/api/setup/session/ABCD-EFGH-JKMN", { method: "DELETE", cookie })))).toBe(true);
    for (const [method, p] of [
      ["POST", "/api/setup/session"],
      ["POST", "/api/setup/session/ABCD-EFGH-JKMN/report"],
      ["DELETE", "/api/setup/session/ABCD-EFGH-JKMN"],
      ["GET", "/api/setup/session/ABCD-EFGH-JKMN/wait"],
    ]) {
      const r = proxy(req(p, { method }));
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
    }
  });
});
