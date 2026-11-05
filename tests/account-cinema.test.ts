import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Cinema Studio for a signed-in account (public sign-up): its own projects (account-projects.ts, kind "cinema"), its
 * takes on its own ComfyUI (a stand-in here) through the same generations every studio run makes, with only its own
 * files. Another account's project and the owner's projects and files are never reached; a guest gets the sign-up card.
 */
// The routes' reads wait for a request (connection) and the Director keeps its answer going (after): outside Next here.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {}, after: () => {} }));

const dir = tempDir("fuobe-account-cinema-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
// The studio's own AI helper: recorded, so a test sees that an account's Director never reaches it.
process.env.OLLAMA_URL = "http://owner-llm.test:11434";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI ("owner-comfy.test") or AI helper: recorded, so a test sees that nothing reached them.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  fetched.push(url.toString());
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  return Response.json({});
}) as typeof fetch;

const auth = await import("@/server/auth");
const projectsRoute = await import("@/app/api/cinema/projects/route");
const projectRoute = await import("@/app/api/cinema/projects/[id]/route");
const directorRoute = await import("@/app/api/cinema/projects/[id]/director/route");
const foldersRoute = await import("@/app/api/cinema/projects/[id]/folders/route");
const folderRoute = await import("@/app/api/cinema/projects/[id]/folders/[folderId]/route");
const itemsRoute = await import("@/app/api/cinema/projects/[id]/items/route");
const generateRoute = await import("@/app/api/cinema/projects/[id]/generate/route");
const retryRoute = await import("@/app/api/cinema/projects/[id]/items/[generationId]/retry/route");
const finishRoute = await import("@/app/api/cinema/projects/[id]/items/[generationId]/finish/route");
const tilesRoute = await import("@/app/api/cinema/projects/[id]/items/[generationId]/tiles/route");
const startersRoute = await import("@/app/api/starters/[id]/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const cinema = await import("@/server/cinema");
const { cancelGeneration, getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const { ACCOUNT_PROJECT_LIMITS, listAccountProjects } = await import("@/server/account-projects");
const { accountRecordExists } = await import("@/server/records");
const { purgeAccount } = await import("@/server/account-sweep");
const { WORLD_MODEL } = await import("@/lib/world");

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "image" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "cinema-a@example.com"],
    ["b", "cinema-b@example.com"],
    ["c", "cinema-c@example.com"],
  ] as const) {
    const id = auth.createAccount(email, "long enough").id;
    cookies[k] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    if (k === "a") a = id;
    if (k === "b") b = id;
    if (k === "c") c = id;
  }
  cookies.owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
  // A and B link their own ComfyUI; C has neither a GPU nor a key.
  for (const who of ["a", "b"]) expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }, who))).status).toBe(200);
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  for (const id of [a, b]) clearAccountLoras(id);
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') IS NOT NULL").run();
});

function json(url: string, method: string, body?: unknown, who?: string): Request {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", ...(text !== undefined && { "content-length": String(Buffer.byteLength(text)) }), ...(who && { cookie: cookies[who] }) },
    ...(text !== undefined && { body: text }),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const viaProxy = (url: string, method = "GET", who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && { body: "{}" }) }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, data: Buffer, type: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": type, "x-file-name": name, "content-length": String(data.length) }, body: new Uint8Array(data) }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { url: string }).url;
}

/** Tick the runner until the row is done (or the time is up). */
async function settle(id: string, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Make a project as `who` (through the route), answering its id. */
async function makeProject(who: string, name: string): Promise<string> {
  const r = await projectsRoute.POST(json("/api/cinema/projects", "POST", { name }, who));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

const STILL = {
  engine: "open",
  mode: "image",
  action: "generate",
  prompt: "A detective under a neon sign in the rain, a wide shot",
  batch: 1,
  aspectRatio: "16:9",
  settings: { camera: "modern", lens: "clean-sharp", focal: "35mm" },
};

/** A take; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function take(project: string, input: Record<string, unknown>, who: string, folderId: string | null = null): Promise<Response> {
  const send = () => generateRoute.POST(json(`/api/cinema/projects/${project}/generate`, "POST", { input, folderId }, who), params({ id: project }));
  let r = await send();
  if (r.status === 409) {
    const j = (await r.clone().json()) as { code: string; fix?: { items: { file: string }[] } };
    if (j.code === "comfy_missing_model" && j.fix) {
      fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((i) => i.file)];
      for (const id of [a, b]) clearAccountLoras(id);
      r = await send();
    }
  }
  return r;
}

/** The owner's own project, made outside any account's work (as the owner's routes make it). */
const ownerProject = () => cinema.createProject({ name: "The owner's film" });

describe("the proxy opens Cinema Studio to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on every change and run; its list is empty and a project is closed", async () => {
    for (const [method, p] of [
      ["POST", "/api/cinema/projects"],
      ["PATCH", "/api/cinema/projects/p1"],
      ["DELETE", "/api/cinema/projects/p1"],
      ["POST", "/api/cinema/projects/p1/director"],
      ["POST", "/api/cinema/projects/p1/folders"],
      ["PATCH", "/api/cinema/projects/p1/items"],
      ["POST", "/api/cinema/projects/p1/generate"],
      ["POST", "/api/cinema/projects/p1/items/g1/retry"],
      ["POST", "/api/cinema/projects/p1/items/g1/finish"],
      ["PUT", "/api/cinema/projects/p1/items/g1/tiles"],
      ["POST", "/api/starters/cinema.desert-couture"],
    ] as const) {
      const r = viaProxy(p, method);
      expect(r.status, `${method} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
    }
    const list = viaProxy("/api/cinema/projects");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
    expect(viaProxy("/api/cinema/projects/p1").status).toBe(401);
    // The routes answer a guest the same way themselves.
    expect((await projectsRoute.POST(json("/api/cinema/projects", "POST", { name: "x" }))).status).toBe(401);
    expect((await generateRoute.POST(json("/api/cinema/projects/p1/generate", "POST", { input: STILL }), params({ id: "p1" }))).status).toBe(401);
    expect(await (await projectsRoute.GET(json("/api/cinema/projects", "GET"))).json()).toEqual({ items: [] });
  });

  it("an account reaches its project routes; runs need its own GPU or key", async () => {
    for (const [method, p] of [
      ["GET", "/api/cinema/projects"],
      ["POST", "/api/cinema/projects"],
      ["GET", "/api/cinema/projects/p1"],
      ["PATCH", "/api/cinema/projects/p1"],
      ["DELETE", "/api/cinema/projects/p1"],
      ["GET", "/api/cinema/projects/p1/director"],
      ["POST", "/api/cinema/projects/p1/director"],
      ["POST", "/api/cinema/projects/p1/folders"],
      ["PATCH", "/api/cinema/projects/p1/folders/f1"],
      ["GET", "/api/cinema/projects/p1/items"],
      ["DELETE", "/api/cinema/projects/p1/items"],
      ["PUT", "/api/cinema/projects/p1/items/g1/tiles"],
      ["POST", "/api/starters/cinema.desert-couture"],
    ] as const) {
      expect(passed(viaProxy(p, method, "a")), `${method} ${p}`).toBe(true);
      // Without a GPU or a key too: a project needs neither.
      expect(passed(viaProxy(p, method, "c")), `c: ${method} ${p}`).toBe(true);
    }
    for (const p of ["/api/cinema/projects/p1/generate", "/api/cinema/projects/p1/items/g1/retry", "/api/cinema/projects/p1/items/g1/finish"]) {
      expect(passed(viaProxy(p, "POST", "a")), p).toBe(true);
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    // Another studio's starter is still the owner's library.
    const other = viaProxy("/api/starters/elements.amara", "POST", "a");
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("library");
    // Not a run the route list knows.
    expect(access.ownGpuRun("POST", "/api/cinema/projects/p1/director")).toBe(false);
    expect(access.ownGpuRun("GET", "/api/cinema/projects/p1/generate")).toBe(false);
  });
});

describe("an account's own projects", () => {
  let mine = "";
  it("makes, lists, opens, renames and deletes its own projects", async () => {
    mine = await makeProject("a", "Night Shift");
    const list = (await (await projectsRoute.GET(json("/api/cinema/projects", "GET", undefined, "a"))).json()) as { items: { id: string; name: string }[] };
    expect(list.items.map((p) => p.id)).toEqual([mine]);
    const open = await projectRoute.GET(json(`/api/cinema/projects/${mine}`, "GET", undefined, "a"), params({ id: mine }));
    expect(open.status).toBe(200);
    const view = (await open.json()) as { project: { name: string }; folders: unknown[]; context: { civitai?: boolean; worldcast?: boolean } };
    expect(view.project.name).toBe("Night Shift");
    expect(view.context.civitai).toBe(false);
    expect(view.context.worldcast).toBeUndefined();
    const renamed = await projectRoute.PATCH(json(`/api/cinema/projects/${mine}`, "PATCH", { name: "Night Shift II", brief: { body: "Neo-noir." }, director: { genre: "noir" }, pinned: true }, "a"), params({ id: mine }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Night Shift II", brief: { body: "Neo-noir." }, director: { genre: "noir" }, pinned: true });
    // It is the account's own project (account-projects.ts), never a row of the owner's table.
    expect(listAccountProjects(a, "cinema").map((p) => p.id)).toEqual([mine]);
    expect(db().prepare("SELECT 1 FROM cinema_projects WHERE id = ?").get(mine)).toBeUndefined();
    // Its page opens for it alone; an unknown id, or another account's, is a 404 page.
    expect(accountRecordExists({ kind: "cinema", ids: [mine] }, a)).toBe(true);
    expect(accountRecordExists({ kind: "cinema", ids: [mine] }, b)).toBe(false);
    expect(accountRecordExists({ kind: "cinema", ids: ["nope"] }, a)).toBe(false);
    expect(passed(viaProxy(`/cinema/${mine}`, "GET", "a"))).toBe(true);
    expect(viaProxy(`/cinema/${mine}`, "GET", "b").status).toBe(404);
    const gone = await makeProject("a", "Scratch");
    expect((await projectRoute.DELETE(json(`/api/cinema/projects/${gone}`, "DELETE", undefined, "a"), params({ id: gone }))).status).toBe(204);
    expect(listAccountProjects(a, "cinema").map((p) => p.id)).toEqual([mine]);
  });

  it("another account and the owner never see it; it never sees theirs", async () => {
    const theirs = ownerProject();
    // B: not in its list, and every route reads A's project as not found.
    expect(((await (await projectsRoute.GET(json("/api/cinema/projects", "GET", undefined, "b"))).json()) as { items: unknown[] }).items).toEqual([]);
    for (const id of [mine, theirs.id]) {
      expect((await projectRoute.GET(json(`/api/cinema/projects/${id}`, "GET", undefined, "b"), params({ id }))).status, id).toBe(404);
      expect((await projectRoute.PATCH(json(`/api/cinema/projects/${id}`, "PATCH", { name: "Mine now" }, "b"), params({ id }))).status, id).toBe(404);
      expect((await itemsRoute.GET(json(`/api/cinema/projects/${id}/items`, "GET", undefined, "b"), params({ id }))).status, id).toBe(404);
      expect((await itemsRoute.GET(json(`/api/cinema/projects/${id}/items?scope=studio`, "GET", undefined, "b"), params({ id }))).status, id).toBe(404);
      expect((await directorRoute.GET(json(`/api/cinema/projects/${id}/director`, "GET", undefined, "b"), params({ id }))).status, id).toBe(404);
      expect((await foldersRoute.POST(json(`/api/cinema/projects/${id}/folders`, "POST", { name: "Scene 1" }, "b"), params({ id }))).status, id).toBe(404);
      const run = await generateRoute.POST(json(`/api/cinema/projects/${id}/generate`, "POST", { input: STILL }, "b"), params({ id }));
      expect(run.status, id).toBe(404);
    }
    // Deleting another's project does nothing.
    await projectRoute.DELETE(json(`/api/cinema/projects/${mine}`, "DELETE", undefined, "b"), params({ id: mine }));
    await projectRoute.DELETE(json(`/api/cinema/projects/${theirs.id}`, "DELETE", undefined, "a"), params({ id: theirs.id }));
    expect(listAccountProjects(a, "cinema").map((p) => p.id)).toEqual([mine]);
    expect(cinema.getProject(theirs.id)?.name).toBe("The owner's film");
    // A never sees the owner's project; the owner's list never holds A's.
    const aList = (await (await projectsRoute.GET(json("/api/cinema/projects", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(aList.items.map((p) => p.id)).not.toContain(theirs.id);
    const ownerList = (await (await projectsRoute.GET(json("/api/cinema/projects", "GET", undefined, "owner"))).json()) as { items: { id: string }[] };
    expect(ownerList.items.map((p) => p.id)).toContain(theirs.id);
    expect(ownerList.items.map((p) => p.id)).not.toContain(mine);
    expect((await projectRoute.GET(json(`/api/cinema/projects/${mine}`, "GET", undefined, "owner"), params({ id: mine }))).status).toBe(404);
  });

  it("names only its own files: the owner's file or another's is refused as a cover or a tile", async () => {
    const ownerFile = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner.png" }).url;
    const bFile = runAsTenant({ kind: "account", id: b }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "b.png" }).url);
    for (const cover of [ownerFile, bFile]) {
      const r = await projectRoute.PATCH(json(`/api/cinema/projects/${mine}`, "PATCH", { cover }, "a"), params({ id: mine }));
      expect(r.status, cover).toBe(403);
      expect((await r.json()).code).toBe("input-not-yours");
      expect((await projectsRoute.POST(json("/api/cinema/projects", "POST", { name: "x", cover }, "a"))).status, cover).toBe(403);
    }
    const own = await upload("a", TINY_PNG, "image/png", "cover.png");
    expect((await projectRoute.PATCH(json(`/api/cinema/projects/${mine}`, "PATCH", { cover: own }, "a"), params({ id: mine }))).status).toBe(200);
    // An owner's file as a take's start frame: refused before anything is planned or sent.
    fake.log.length = 0;
    const r = await take(mine, { ...STILL, mode: "video", images: [ownerFile] }, "a");
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
  });

  it("keeps its folders: make, rename, delete; another account can't touch them", async () => {
    const r = await foldersRoute.POST(json(`/api/cinema/projects/${mine}/folders`, "POST", { name: "Scene 1" }, "a"), params({ id: mine }));
    expect(r.status).toBe(201);
    const f = (await r.json()) as { id: string };
    expect((await folderRoute.PATCH(json(`/api/cinema/projects/${mine}/folders/${f.id}`, "PATCH", { name: "Rooftop" }, "a"), params({ id: mine, folderId: f.id }))).status).toBe(200);
    expect((await folderRoute.PATCH(json(`/api/cinema/projects/${mine}/folders/${f.id}`, "PATCH", { name: "Taken" }, "b"), params({ id: mine, folderId: f.id }))).status).toBe(404);
    expect((await folderRoute.DELETE(json(`/api/cinema/projects/${mine}/folders/${f.id}`, "DELETE", undefined, "b"), params({ id: mine, folderId: f.id }))).status).toBe(404);
    const view = (await (await projectRoute.GET(json(`/api/cinema/projects/${mine}`, "GET", undefined, "a"), params({ id: mine }))).json()) as { folders: { name: string }[] };
    expect(view.folders.map((x) => x.name)).toEqual(["Rooftop"]);
    expect((await folderRoute.DELETE(json(`/api/cinema/projects/${mine}/folders/${f.id}`, "DELETE", undefined, "a"), params({ id: mine, folderId: f.id }))).status).toBe(204);
  });

  it("its AI Director writes the breakdown without the studio's AI helper, and the chat is its own", async () => {
    fetched.length = 0;
    const r = await directorRoute.POST(json(`/api/cinema/projects/${mine}/director`, "POST", { text: "Generate a 4-shot storyboard for a rooftop chase at night" }, "a"), params({ id: mine }));
    expect(r.status).toBe(200);
    const { messages } = (await r.json()) as { messages: { role: string; source?: string; shots?: unknown[] }[] };
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", source: "offline" });
    expect(messages[1].shots?.length).toBe(4);
    expect(fetched).toEqual([]);
    const read = (await (await directorRoute.GET(json(`/api/cinema/projects/${mine}/director`, "GET", undefined, "a"), params({ id: mine }))).json()) as { messages: unknown[] };
    expect(read.messages).toHaveLength(2);
    expect((await directorRoute.DELETE(json(`/api/cinema/projects/${mine}/director`, "DELETE", undefined, "b"), params({ id: mine }))).status).toBe(404);
    expect((await directorRoute.DELETE(json(`/api/cinema/projects/${mine}/director`, "DELETE", undefined, "a"), params({ id: mine }))).status).toBe(204);
  });

  it("keeps its limit of projects", async () => {
    const before = listAccountProjects(c, "cinema").length;
    for (let i = before; i < ACCOUNT_PROJECT_LIMITS.projects; i++) runAsTenant({ kind: "account", id: c }, () => cinema.createProject({ name: `P${i}` }));
    const r = await projectsRoute.POST(json("/api/cinema/projects", "POST", { name: "One too many" }, "c"));
    expect(r.status).toBe(409);
  });
});

describe("an account's takes run on its own ComfyUI", () => {
  let project = "";
  let still = "";
  beforeAll(async () => {
    project = await makeProject("a", "Takes");
  });

  it("makes a take end to end: every step is its own, on its ComfyUI, and the result is its own file in its project", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await take(project, STILL, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { items: { id: string }[]; folderId: string | null };
    expect(body.items.length).toBeGreaterThan(0);
    for (const g of body.items) {
      expect(getGeneration(g.id)!.request.account, g.id).toBe(a);
      expect(getGeneration(g.id)!.provider).toBe("comfyui");
    }
    still = body.items[0].id;
    const done = await settle(still);
    expect(done?.status, done?.error ?? "").toBe("succeeded");
    // It went to its own ComfyUI; nothing reached the install's (the runner's own look at the studio's servers when it
    // starts, /system_stats and /api/tags, carries nothing of the account's).
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBeGreaterThan(0);
    expect(fetched.filter((u) => !u.endsWith("/system_stats") && !u.endsWith("/api/tags"))).toEqual([]);
    const out = done!.outputs[0];
    expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(a);
    // It shows in its project and its runs, opens and downloads for it alone.
    const items = (await (await itemsRoute.GET(json(`/api/cinema/projects/${project}/items`, "GET", undefined, "a"), params({ id: project }))).json()) as { items: { id: string }[] };
    expect(items.items.map((g) => g.id)).toContain(still);
    const studio = (await (await itemsRoute.GET(json(`/api/cinema/projects/${project}/items?scope=studio`, "GET", undefined, "a"), params({ id: project }))).json()) as { items: { id: string; projectId: string }[] };
    expect(studio.items.find((g) => g.id === still)?.projectId).toBe(project);
    expect(passed(viaProxy(out.url, "GET", "a"))).toBe(true);
    expect(passed(viaProxy(`/api/generations/${still}`, "GET", "a"))).toBe(true);
    expect(viaProxy(out.url, "GET", "b").status).toBe(403);
    expect(viaProxy(`/api/generations/${still}`, "GET", "b").status).toBe(403);
    // The project's card counts it.
    const list = (await (await projectsRoute.GET(json("/api/cinema/projects", "GET", undefined, "a"))).json()) as { items: { id: string; stats: { items: number } }[] };
    expect(list.items.find((p) => p.id === project)?.stats.items).toBeGreaterThan(0);
    // The owner's "My Generations" never lists it.
    expect(cinema.listStudioGenerations().map((g) => g.id)).not.toContain(still);
  });

  it("runs World mode's opening turn on its own ComfyUI", async () => {
    const script = {
      opening: { words: "A small orange fox stands on a stone path in a forest at dusk.", subject: "a small orange fox", move: "zoom_in", seconds: 5 },
      turns: [],
      seed: 1234,
    };
    const r = await take(project, { engine: "open", mode: "video", action: "world", prompt: "", world: { script, turn: 0 } }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { items: { id: string; modelId: string; op: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ modelId: WORLD_MODEL, op: "world-turn" });
    const g = getGeneration(body.items[0].id)!;
    expect(g.request.account).toBe(a);
    expect(g.provider).toBe("comfyui");
    const item = runAsTenant({ kind: "account", id: a }, () => cinema.listItems(project)).find((x) => x.id === g.id);
    expect(item?.take?.action).toBe("world");
    // Outside the account's work (the owner's), its project isn't there.
    expect(() => cinema.listItems(project)).toThrow(/not found/);
  });

  it("builds a 3D scene from its still and films an exact orbit on its own ComfyUI (the 3D step under its own limits)", async () => {
    const pic = await upload("a", TINY_PNG, "image/png", "start.png");
    const scene = await take(project, { engine: "open", mode: "image", action: "scene", prompt: "", source: { url: pic, kind: "image" }, aspectRatio: "16:9" }, "a");
    expect(scene.status, await scene.clone().text()).toBe(201);
    for (const g of ((await scene.json()) as { items: { id: string }[] }).items) {
      expect(getGeneration(g.id)!.request.account).toBe(a);
      expect(getGeneration(g.id)!.provider).toBe("comfyui");
    }
    const orbit = await take(project, { ...STILL, mode: "video", moves: ["drone-orbit"], exact: { degrees: 90, direction: "cw" }, images: [pic], duration: 5 }, "a");
    expect(orbit.status, await orbit.clone().text()).toBe(201);
    const steps = ((await orbit.json()) as { items: { id: string; op: string }[] }).items;
    expect(steps.map((s) => s.op)).toContain("camera-path");
    for (const g of steps) expect(getGeneration(g.id)!.request.account).toBe(a);
  });

  it("retries a canceled take as its own run; another account can't retry it", async () => {
    const r = await take(project, STILL, "a");
    expect(r.status).toBe(201);
    const first = ((await r.json()) as { items: { id: string }[] }).items[0].id;
    await cancelGeneration(first);
    const other = await retryRoute.POST(json(`/api/cinema/projects/${project}/items/${first}/retry`, "POST", undefined, "b"), params({ id: project, generationId: first }));
    expect(other.status).toBe(404);
    const again = await retryRoute.POST(json(`/api/cinema/projects/${project}/items/${first}/retry`, "POST", undefined, "a"), params({ id: project, generationId: first }));
    expect(again.status, await again.clone().text()).toBe(201);
    const items = ((await again.json()) as { items: { id: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(getGeneration(items[0].id)!.request.account).toBe(a);
    const listed = runAsTenant({ kind: "account", id: a }, () => cinema.listItems(project)).map((g) => g.id);
    expect(listed).toContain(items[0].id);
    expect(listed).not.toContain(first);
  });

  it("2K finish: only for its own takes, and only for a MiniMax H3 take", async () => {
    const other = await finishRoute.POST(json(`/api/cinema/projects/${project}/items/${still}/finish`, "POST", { requestId: "fin-1" }, "b"), params({ id: project, generationId: still }));
    expect(other.status).toBe(404);
    const r = await finishRoute.POST(json(`/api/cinema/projects/${project}/items/${still}/finish`, "POST", { requestId: "fin-1" }, "a"), params({ id: project, generationId: still }));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/MiniMax H3/);
  });

  it("saves a grid's tiles from its own files only", async () => {
    const own = await upload("a", TINY_PNG, "image/png", "tile.png");
    const ownerFile = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner-tile.png" }).url;
    const bad = await tilesRoute.PUT(json(`/api/cinema/projects/${project}/items/${still}/tiles`, "PUT", { tiles: [{ url: ownerFile, row: 0, col: 0 }] }, "a"), params({ id: project, generationId: still }));
    expect(bad.status).toBe(403);
    const good = await tilesRoute.PUT(json(`/api/cinema/projects/${project}/items/${still}/tiles`, "PUT", { tiles: [{ url: own, row: 0, col: 0 }] }, "a"), params({ id: project, generationId: still }));
    expect(good.status).toBe(200);
    const theirs = await tilesRoute.PUT(json(`/api/cinema/projects/${project}/items/${still}/tiles`, "PUT", { tiles: [] }, "b"), params({ id: project, generationId: still }));
    expect(theirs.status).toBe(404);
  });

  it("keeps the account's limits: runs going at once, and a body too big", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'cinema', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-cinema-${i}`, JSON.stringify({ feature: "cinema", modelId: "oss-trim", account: a }), now, now);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const r = await take(project, STILL, "a");
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-cinema-%'").run();
    const big = new Request(`http://localhost:3000/api/cinema/projects/${project}/generate`, { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await generateRoute.POST(big, params({ id: project }))).status).toBe(413);
  });

  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    // One of its own projects (it keeps as many as it may).
    const own = listAccountProjects(c, "cinema")[0];
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const r = await take(own.id, STILL, "c");
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await r.json()).code).toBe("connect-gpu");
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
  });

  it("its Delete deletes a take for good (no Trash), its own only", async () => {
    const r = await take(project, STILL, "a");
    const id = ((await r.json()) as { items: { id: string }[] }).items[0].id;
    await settle(id);
    const theirs = await itemsRoute.DELETE(json(`/api/cinema/projects/${project}/items`, "DELETE", { ids: [id], deleteGenerations: true }, "b"), params({ id: project }));
    expect(theirs.status).toBe(404);
    const del = await itemsRoute.DELETE(json(`/api/cinema/projects/${project}/items`, "DELETE", { ids: [id], deleteGenerations: true }, "a"), params({ id: project }));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ removed: 1 });
    expect(getGeneration(id, { includeDeleted: true })).toBeNull();
  });
});

describe("a ready film and the account's deletion", () => {
  it("an account makes Cinema's ready film as its own project; the owner's list never shows it", async () => {
    const r = await startersRoute.POST(json("/api/starters/cinema.desert-couture", "POST", { engine: "open" }, "b"), params({ id: "cinema.desert-couture" }));
    expect(r.status, await r.clone().text()).toBe(201);
    const made = (await r.json()) as { href: string; id: string };
    expect(made.href).toBe(`/cinema/${made.id}?shot=1`);
    expect(listAccountProjects(b, "cinema").map((p) => p.id)).toContain(made.id);
    expect(cinema.listProjects().map((p) => p.id)).not.toContain(made.id);
    // Its proposed shots are in its own Director chat.
    const chat = (await (await directorRoute.GET(json(`/api/cinema/projects/${made.id}/director`, "GET", undefined, "b"), params({ id: made.id }))).json()) as { messages: { shots?: unknown[] }[] };
    expect(chat.messages.some((m) => m.shots?.length)).toBe(true);
    // Made again before anything is made in it: the same project.
    const again = await startersRoute.POST(json("/api/starters/cinema.desert-couture", "POST", { engine: "open" }, "b"), params({ id: "cinema.desert-couture" }));
    expect(((await again.json()) as { id: string }).id).toBe(made.id);
    // Another studio's starter stays the owner's library.
    const other = await startersRoute.POST(json("/api/starters/elements.amara", "POST", { engine: "open" }, "b"), params({ id: "elements.amara" }));
    expect(other.status).toBe(403);
    // A guest signs up first.
    expect((await startersRoute.POST(json("/api/starters/cinema.desert-couture", "POST", { engine: "open" }), params({ id: "cinema.desert-couture" }))).status).toBe(401);
  });

  it("deleting the account deletes its projects, their folders and takes' rows", async () => {
    const p = runAsTenant({ kind: "account", id: b }, () => cinema.createProject({ name: "Gone soon" }));
    runAsTenant({ kind: "account", id: b }, () => cinema.createFolder(p.id, { name: "Scene" }));
    expect((db().prepare("SELECT COUNT(*) AS n FROM cinema_folders WHERE project_id = ?").get(p.id) as { n: number }).n).toBe(1);
    await purgeAccount(b);
    expect(listAccountProjects(b, "cinema")).toEqual([]);
    expect((db().prepare("SELECT COUNT(*) AS n FROM cinema_folders WHERE project_id = ?").get(p.id) as { n: number }).n).toBe(0);
  });
});
