import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";

/**
 * The public Canvas: a guest or an account opens ready boards (and blank ones) in the editor, keeps a guest's in the
 * browser, and an account saves its own canvases to its account (/api/account/canvases), never anyone else's, and never
 * the owner's. A ready board for a visitor names Fuobe's published example files, never a copy in anyone's storage.
 */
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/headers", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/headers")>()), cookies: async () => ({ delete: () => {}, get: () => undefined }) }));

const dir = tempDir("fuobe-canvas-public-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ENGINE_MODE;

const auth = await import("@/server/auth");
const listRoute = await import("@/app/api/account/canvases/route");
const oneRoute = await import("@/app/api/account/canvases/[id]/route");
const { proxy } = await import("@/proxy");
const { resetRates } = await import("@/server/rate");
const { accountMayChange, accountOwnRead, guestRead } = await import("@/lib/guest-access");
const { visitorBoard, visitorBoardIds, BLANK_BOARD } = await import("@/server/visitor-board");
const { parseVisitorPages, parsePages, listCanvases } = await import("@/server/canvas");
const { purgeAccount } = await import("@/server/account-sweep");
const { db } = await import("@/server/db");
const { CANVAS_TEMPLATES } = await import("@/lib/catalog/canvas");
const { templateCover } = await import("@/lib/template-covers");

let A = "";
let B = "";
let cookieA = "";
let cookieB = "";
beforeAll(() => {
  auth.setPassword("install password");
  A = auth.createAccount("canvas-a@example.com", "long enough").id;
  B = auth.createAccount("canvas-b@example.com", "long enough").id;
  cookieA = `${auth.SESSION_COOKIE}=${auth.createSession(A).value}`;
  cookieB = `${auth.SESSION_COOKIE}=${auth.createSession(B).value}`;
});
beforeEach(() => resetRates());

const req = (url: string, method: string, body?: unknown, cookie = cookieA) =>
  new Request(`http://localhost:3000${url}`, { method, headers: { cookie, host: "localhost:3000", "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const page = (nodes: unknown[] = []) => [{ id: "page-1", name: "Page 1", graph: { nodes, edges: [] } }];
const prompt = (text: string) => ({ id: "p1", type: "prompt", position: { x: 0, y: 0 }, data: { text } });

describe("a ready board for a visitor's editor", () => {
  const visible = visitorBoardIds().filter((id) => id !== BLANK_BOARD);

  it("opens every ready board a visitor's /canvas shows, and a blank one", () => {
    expect(visitorBoardIds()[0]).toBe(BLANK_BOARD);
    expect(visible.length).toBeGreaterThan(5);
    expect(visitorBoard(BLANK_BOARD)!.pages[0].graph.nodes).toEqual([]);
    for (const id of visible) {
      const b = visitorBoard(id)!;
      expect(b.templateId).toBe(id);
      expect(b.pages[0].graph.nodes.length, id).toBeGreaterThan(1);
      expect(b.pages[0].graph.edges.length, id).toBeGreaterThan(0);
    }
  });

  it("is null for a board a visitor doesn't see (no real cover yet, or not a ready board)", () => {
    const hidden = CANVAS_TEMPLATES.filter((t) => t.starter === false || !templateCover("canvas", t.id));
    expect(hidden.length).toBeGreaterThan(0);
    for (const t of hidden) expect(visitorBoard(t.id), t.id).toBeNull();
    expect(visitorBoard("no-such-board")).toBeNull();
  });

  it("starts with Fuobe's published example files in place, never a copy in anyone's storage", () => {
    let withFiles = 0;
    for (const id of visible) {
      for (const n of visitorBoard(id)!.pages[0].graph.nodes) {
        if (!n.data.url) continue;
        withFiles++;
        expect(n.data.url, id).toMatch(/^\/(examples|samples|previews\/presets|starters)\//);
      }
    }
    expect(withFiles).toBeGreaterThan(0);
    // Nothing was stored for it.
    expect((db().prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n).toBe(0);
  });

  it("shows the template's own published film on the step that makes it, and its one-step effect", () => {
    const b = visitorBoard("effect-chain-pearl-earring")!;
    expect(b.example).toMatchObject({ kind: "video", url: templateCover("canvas", "effect-chain-pearl-earring")!.video });
    const node = b.pages[0].graph.nodes.find((n) => n.id === b.example!.nodeId)!;
    expect(node.type).not.toBe("output");
    expect(b.oneStep?.href).toMatch(/^\/video/);
  });

  it("an account may keep those example paths on its own board; the owner's boards and anything else stay refused", () => {
    const board = visitorBoard("effect-chain-pearl-earring")!.pages;
    expect(parseVisitorPages(board)).not.toBeNull();
    expect(parsePages(board)).toBeNull();
    const withUrl = (url: string) => page([{ id: "i1", type: "image-input", position: { x: 0, y: 0 }, data: { url } }]);
    for (const url of ["https://evil.example/x.jpg", "/examples/../../.env", "/examples/nope.jpg", "/api/../secret", "data:image/png;base64,AAAA", "/samples/%2e%2e/x"]) expect(parseVisitorPages(withUrl(url)), url).toBeNull();
    expect(parseVisitorPages(withUrl("/api/files/abc.png"))).not.toBeNull();
  });
});

describe("the access rules for an account's own canvases", () => {
  it("an account reads and changes its own boards there; a guest is asked to sign up", () => {
    expect(accountOwnRead("/api/account/canvases")).toBe(true);
    expect(accountOwnRead("/api/account/canvases/abc")).toBe(true);
    expect(accountOwnRead("/api/account/canvases/abc/x")).toBe(false);
    expect(accountMayChange("POST", "/api/account/canvases", "")).toBe(true);
    expect(accountMayChange("PATCH", "/api/account/canvases/abc", "")).toBe(true);
    expect(accountMayChange("DELETE", "/api/account/canvases/abc", "")).toBe(true);
    expect(accountMayChange("PUT", "/api/account/canvases/abc", "")).toBe(false);
    expect(guestRead("/api/account/canvases")).toEqual({ kind: "closed" });
  });

  it("through the proxy: a guest gets 401, an account passes, the owner's canvases stay 403 for an account", async () => {
    const at = (url: string, method: string, cookie?: string) => proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: cookie ? { cookie } : {}, ...(method !== "GET" && { body: "{}" }) }));
    expect((await at("/api/account/canvases", "GET")).status).toBe(401);
    expect((await at("/api/account/canvases", "POST")).status).toBe(401);
    const passed = await at("/api/account/canvases", "POST", cookieA);
    expect(passed.headers.get("x-middleware-next")).toBe("1");
    expect((await at("/api/canvases", "POST", cookieA)).status).toBe(403);
  });
});

describe("an account's own canvases", () => {
  let id = "";

  it("saves a board (a ready board's example paths kept), lists it, and opens it", async () => {
    const res = await listRoute.POST(req("/api/account/canvases", "POST", { name: "My pearl", templateId: "effect-chain-pearl-earring", pages: visitorBoard("effect-chain-pearl-earring")!.pages }));
    expect(res.status).toBe(201);
    id = ((await res.json()) as { id: string }).id;
    const list = (await (await listRoute.GET(req("/api/account/canvases", "GET"))).json()) as { items: { id: string; name: string; nodeCount: number }[] };
    expect(list.items).toEqual([expect.objectContaining({ id, name: "My pearl" })]);
    expect(list.items[0].nodeCount).toBeGreaterThan(1);
    const one = (await (await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET"), ctx(id))).json()) as { pages: unknown[]; templateId: string };
    expect(one.templateId).toBe("effect-chain-pearl-earring");
    // Never in the owner's canvases.
    expect(listCanvases()).toEqual([]);
  });

  it("renames it and saves its pages", async () => {
    const r1 = await oneRoute.PATCH(req(`/api/account/canvases/${id}`, "PATCH", { name: "Renamed" }), ctx(id));
    expect(r1.status).toBe(200);
    const r2 = await oneRoute.PATCH(req(`/api/account/canvases/${id}`, "PATCH", { pages: page([prompt("a red coat")]) }), ctx(id));
    // A save answers small: the name and when it changed, not the pages.
    expect(await r2.json()).toEqual({ id, name: "Renamed", updatedAt: expect.any(Number) });
    const c = (await (await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET"), ctx(id))).json()) as { name: string; pages: { graph: { nodes: { data: { text: string } }[] } }[] };
    expect(c.name).toBe("Renamed");
    expect(c.pages[0].graph.nodes[0].data.text).toBe("a red coat");
    // The list reads the summary kept with the save.
    const list = (await (await listRoute.GET(req("/api/account/canvases", "GET"))).json()) as { items: { id: string; nodeCount: number; outline: { boxes: unknown[] } }[] };
    expect(list.items[0]).toEqual(expect.objectContaining({ id, nodeCount: 1 }));
    expect(list.items[0].outline.boxes).toHaveLength(1);
  });

  it("lists a board saved before summaries were kept, and keeps its summary from then on", async () => {
    db().prepare("UPDATE account_canvases SET summary_json = NULL WHERE id = ?").run(id);
    const list = (await (await listRoute.GET(req("/api/account/canvases", "GET"))).json()) as { items: { id: string; nodeCount: number }[] };
    expect(list.items.find((x) => x.id === id)).toEqual(expect.objectContaining({ nodeCount: 1 }));
    expect((db().prepare("SELECT summary_json FROM account_canvases WHERE id = ?").get(id) as { summary_json: string | null }).summary_json).toContain('"nodeCount":1');
  });

  it("is another account's to neither read, change nor delete (it reads as not found), and a guest's to none", async () => {
    expect((await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET", undefined, cookieB), ctx(id))).status).toBe(404);
    expect((await oneRoute.PATCH(req(`/api/account/canvases/${id}`, "PATCH", { name: "Taken" }, cookieB), ctx(id))).status).toBe(404);
    expect((await oneRoute.DELETE(req(`/api/account/canvases/${id}`, "DELETE", undefined, cookieB), ctx(id))).status).toBe(404);
    expect(((await (await listRoute.GET(req("/api/account/canvases", "GET", undefined, cookieB))).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET", undefined, ""), ctx(id))).status).toBe(401);
    expect((await listRoute.POST(req("/api/account/canvases", "POST", { pages: page() }, ""))).status).toBe(401);
    // Still A's, unchanged.
    const mine = (await (await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET"), ctx(id))).json()) as { name: string };
    expect(mine.name).toBe("Renamed");
  });

  it("refuses a board it can't read, one too big, and more than the limit", async () => {
    expect((await listRoute.POST(req("/api/account/canvases", "POST", { pages: [{ id: "x", name: "x", graph: { nodes: "no" } }] }))).status).toBe(400);
    const huge = page(Array.from({ length: 300 }, (_, i) => ({ ...prompt("x".repeat(20_000)), id: `n${i}` })));
    expect((await listRoute.POST(req("/api/account/canvases", "POST", { pages: huge }))).status).toBe(413);
    const { ACCOUNT_CANVAS_LIMITS } = await import("@/server/account-canvas");
    for (let i = 1; i < ACCOUNT_CANVAS_LIMITS.boards; i++) {
      resetRates();
      expect((await listRoute.POST(req("/api/account/canvases", "POST", { name: `b${i}`, pages: page() }))).status).toBe(201);
    }
    const over = await listRoute.POST(req("/api/account/canvases", "POST", { pages: page() }));
    expect(over.status).toBe(409);
  });

  it("deletes it, and every board goes with the account", async () => {
    expect((await oneRoute.DELETE(req(`/api/account/canvases/${id}`, "DELETE"), ctx(id))).status).toBe(204);
    expect((await oneRoute.GET(req(`/api/account/canvases/${id}`, "GET"), ctx(id))).status).toBe(404);
    await listRoute.POST(req("/api/account/canvases", "POST", { pages: page() }, cookieB));
    await purgeAccount(A);
    const left = db().prepare("SELECT account_id, COUNT(*) AS n FROM account_canvases GROUP BY account_id").all() as { account_id: string; n: number }[];
    expect(left).toEqual([{ account_id: B, n: 1 }]);
  });
});
