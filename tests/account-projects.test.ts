import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";

/**
 * An account's own projects (src/server/account-projects.ts): the store the tools that keep projects use once they open
 * to accounts. Every read and change names the account and the kind, so another account's project, another kind's and
 * the owner's are never in reach, and everything goes with the account.
 */
const dir = tempDir("fuobe-account-projects-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;

const auth = await import("@/server/auth");
const store = await import("@/server/account-projects");
const access = await import("@/lib/guest-access");
const { proxy } = await import("@/proxy");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { purgeAccount } = await import("@/server/account-sweep");
const { resetRates } = await import("@/server/rate");
const { db } = await import("@/server/db");

let a = "";
let b = "";
const cookies: Record<string, string> = {};
beforeAll(() => {
  auth.setPassword("install password");
  a = auth.createAccount("projects-a@example.com", "long enough").id;
  b = auth.createAccount("projects-b@example.com", "long enough").id;
  cookies.a = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
});

describe("an account's projects are its own", () => {
  it("one account's project is out of another's reach, and out of another kind's", () => {
    const p = store.createAccountProject(a, "shorts", { name: "  My   short  ", data: { scenes: [1, 2] }, summary: { scenes: 2 } });
    expect(p).toMatchObject({ kind: "shorts", name: "My short", data: { scenes: [1, 2] }, summary: { scenes: 2 } });
    expect(store.getAccountProject(a, "shorts", p.id)?.data).toEqual({ scenes: [1, 2] });
    // B, and A under another kind, read nothing, change nothing and delete nothing.
    expect(store.getAccountProject(b, "shorts", p.id)).toBeNull();
    expect(store.getAccountProject(a, "cinema", p.id)).toBeNull();
    expect(store.updateAccountProject(b, "shorts", p.id, { name: "mine now" })).toBeNull();
    expect(store.updateAccountProject(a, "cinema", p.id, { name: "mine now" })).toBeNull();
    expect(store.deleteAccountProject(b, "shorts", p.id)).toBe(false);
    expect(store.listAccountProjects(b, "shorts")).toEqual([]);
    expect(store.listAccountProjects(a, "cinema")).toEqual([]);
    // Its list holds the summary, never the data.
    const [line] = store.listAccountProjects(a, "shorts");
    expect(line).toMatchObject({ id: p.id, name: "My short", summary: { scenes: 2 } });
    expect(line).not.toHaveProperty("data");
    // Its own changes go through.
    expect(store.updateAccountProject(a, "shorts", p.id, { name: "Renamed", data: { scenes: [] } })).toMatchObject({ id: p.id, name: "Renamed" });
    expect(store.getAccountProject(a, "shorts", p.id)?.data).toEqual({ scenes: [] });
    expect(store.deleteAccountProject(a, "shorts", p.id)).toBe(true);
    expect(store.getAccountProject(a, "shorts", p.id)).toBeNull();
  });

  it("keeps its limits: projects per kind, a project's size and its summary's", () => {
    const k = "storyboard";
    for (let i = 0; i < store.ACCOUNT_PROJECT_LIMITS.projects; i++) store.createAccountProject(a, k, { data: { i } });
    expect(() => store.createAccountProject(a, k, { data: {} })).toThrow(store.AccountProjectError);
    // Another kind, and another account, have room of their own.
    expect(store.createAccountProject(a, "swap", { data: {} }).kind).toBe("swap");
    expect(store.createAccountProject(b, k, { data: {} }).kind).toBe(k);
    const big = "x".repeat(store.ACCOUNT_PROJECT_LIMITS.bytes);
    expect(() => store.createAccountProject(b, "swap", { data: { big } })).toThrow(/too big/);
    expect(() => store.createAccountProject(b, "swap", { data: {}, summary: { big } })).toThrow(/too big/);
    try {
      store.createAccountProject(a, k, { data: {} });
    } catch (e) {
      expect(store.projectRefused(e).status).toBe(409);
    }
    expect(() => store.listAccountProjects(a, "Not a kind")).toThrow();
  });

  it("names only its own files and runs", () => {
    const own = runAsTenant({ kind: "account", id: a }, () => saveFile({ data: Buffer.from("abc"), contentType: "image/png", source: "upload", name: "a.png" }).url);
    const owners = saveFile({ data: Buffer.from("abc"), contentType: "image/png", source: "upload", name: "o.png" }).url;
    const others = runAsTenant({ kind: "account", id: b }, () => saveFile({ data: Buffer.from("abc"), contentType: "image/png", source: "upload", name: "b.png" }).url);
    expect(store.projectRefsProblem(a, { files: [own] })).toBeNull();
    expect(store.projectRefsProblem(a, { files: [owners] })?.code).toBe("input-not-yours");
    expect(store.projectRefsProblem(a, { files: [others] })?.code).toBe("input-not-yours");
    expect(store.projectRefsProblem(a, { files: ["https://example.com/x.png"] })?.code).toBe("input-not-allowed");
    const t = Date.now();
    const run = (id: string, account?: string) =>
      db()
        .prepare("INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'shorts', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'succeeded', ?, '[]', ?, ?)")
        .run(id, JSON.stringify(account ? { account } : {}), t, t);
    run("proj-run-a", a);
    run("proj-run-b", b);
    run("proj-run-owner");
    expect(store.projectRefsProblem(a, { runs: ["proj-run-a"] })).toBeNull();
    expect(store.projectRefsProblem(a, { runs: ["proj-run-b"] })?.status).toBe(404);
    expect(store.projectRefsProblem(a, { runs: ["proj-run-owner"] })?.status).toBe(404);
    expect(store.projectRefsProblem(a, { runs: ["no-such-run"] })?.status).toBe(404);
  });

  it("limits saves a minute, every kind together", () => {
    resetRates();
    for (let i = 0; i < store.ACCOUNT_PROJECT_LIMITS.savesPerMinute; i++) expect(store.projectSavesLimited(b)).toBeNull();
    expect(store.projectSavesLimited(b)?.status).toBe(429);
    expect(store.projectSavesLimited(a)).toBeNull();
    resetRates();
  });

  it("goes with the account", async () => {
    const gone = auth.createAccount("projects-gone@example.com", "long enough").id;
    store.createAccountProject(gone, "cinema", { data: {} });
    store.createAccountProject(gone, "shorts", { data: {} });
    store.createAccountProject(a, "cinema", { data: {} });
    await purgeAccount(gone);
    expect(store.listAccountProjects(gone, "cinema")).toEqual([]);
    expect(store.listAccountProjects(gone, "shorts")).toEqual([]);
    expect(store.listAccountProjects(a, "cinema").length).toBeGreaterThan(0);
  });
});

describe("a tool's project routes go through the proxy for accounts only", () => {
  const route = /^\/api\/test-tool\/projects(\/[^/]+)?$/;
  afterEach(() => {
    access.ACCOUNT_PROJECT_ROUTES.splice(access.ACCOUNT_PROJECT_ROUTES.indexOf(route), 1);
  });
  const call = (method: string, url: string, cookie?: string) =>
    proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(cookie && { cookie }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && { body: "{}" }) }));
  const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

  it("lets an account's reads and changes reach the route, and gives a guest's change the sign-up card", async () => {
    // Not listed: an account's change to a tool's projects is refused as before.
    expect(passed(call("POST", "/api/test-tool/projects", cookies.a))).toBe(false);
    access.ACCOUNT_PROJECT_ROUTES.push(route);
    for (const [method, url] of [
      ["GET", "/api/test-tool/projects"],
      ["POST", "/api/test-tool/projects"],
      ["GET", "/api/test-tool/projects/p1"],
      ["PATCH", "/api/test-tool/projects/p1"],
      ["DELETE", "/api/test-tool/projects/p1"],
    ] as const) {
      expect(passed(call(method, url, cookies.a)), `${method} ${url}`).toBe(true);
    }
    const g = call("POST", "/api/test-tool/projects");
    expect(g.status).toBe(401);
    expect(g.headers.get(access.GUEST_HEADER)).toBe("1");
    // A guest's read goes by guestRead (closed here: nothing of anyone's).
    expect(call("GET", "/api/test-tool/projects").status).toBe(401);
  });
});
