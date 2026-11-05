import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-workers-pairing-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;

const auth = await import("@/server/auth");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { getSetting, setSetting } = await import("@/server/settings");
const workers = await import("@/server/computer/workers");
const { principalOf, requestWorker } = await import("@/server/computer/http");
const { proxy } = await import("@/proxy");
const pairRoute = await import("@/app/api/gpu/pair/route");
const startRoute = await import("@/app/api/gpu/pair/start/route");
const pollRoute = await import("@/app/api/gpu/pair/poll/route");
const pairedRoute = await import("@/app/api/gpu/paired/route");
const pairedIdRoute = await import("@/app/api/gpu/paired/[id]/route");
const unpairRoute = await import("@/app/api/gpu/computer/unpair/route");
const tasks = await import("@/server/computer/tasks");
const { accountMayChange, accountOwnRead } = await import("@/lib/guest-access");
const { pairCode, trustedByDefault, isConnectAnswer } = await import("@/lib/fuobe-connect");

const HOST = "localhost:3000";
const SITE = `http://${HOST}`;
let a = "";
let b = "";
const cookies: Record<string, string> = {};

const browser = (who: string, url: string, init: RequestInit = {}) =>
  new Request(`${SITE}${url}`, { ...init, headers: { host: HOST, cookie: cookies[who], origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(init.headers ?? {}) } });
const program = (url: string, token?: string, init: RequestInit = {}) =>
  new Request(`${SITE}${url}`, { method: "POST", ...init, headers: { host: HOST, "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(init.headers ?? {}) } });

/** Pair a ComfyUI for `who` through the routes, as Fuobe Connect and the person's browser do. */
async function pair(who: string, name = "pc") {
  const s = await (await startRoute.POST(program("/api/gpu/pair/start", undefined, { body: JSON.stringify({ name, facts: { device: "cuda:0 Test", vramBytes: 7 } }) }))).json();
  const ok = await pairRoute.POST(browser(who, "/api/gpu/pair", { method: "POST", body: JSON.stringify({ code: s.code }) }));
  expect(ok.status).toBe(200);
  const p = await (await pollRoute.POST(program("/api/gpu/pair/poll", undefined, { body: JSON.stringify({ id: s.id, secret: s.secret }) }))).json();
  expect(p.state).toBe("approved");
  return { token: p.token as string, id: p.workerId as string, code: s.code as string, secret: s.secret as string, pairId: s.id as string, account: p.account as string };
}

beforeAll(() => {
  auth.setPassword("install password");
  a = auth.createAccount("a@example.com", "long enough").id;
  b = auth.createAccount("b@example.com", "long enough").id;
  cookies.a = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
  cookies.b = `${auth.SESSION_COOKIE}=${auth.createSession(b).value}`;
  cookies.owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
});
beforeEach(() => {
  resetRates();
  db().prepare("DELETE FROM relay_workers").run();
  db().prepare("DELETE FROM relay_pairings").run();
});

describe("pairing a ComfyUI", () => {
  it("gives a short code and a link, and nothing else until a person approves", async () => {
    const res = await startRoute.POST(program("/api/gpu/pair/start", undefined, { body: JSON.stringify({ name: "My PC <script>", facts: { device: "x", loras: ["a"] } }) }));
    const s = await res.json();
    expect(s.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    // The studio's own address, as the request reached it.
    // The page asks for the code: the link never carries one to fill in.
    expect(s.url).toBe(`${SITE}/connect?pair=1`);
    expect(s.url).not.toContain(s.code);
    expect(s.secret).toMatch(/^[0-9a-f]{64}$/);
    const p = await (await pollRoute.POST(program("/api/gpu/pair/poll", undefined, { body: JSON.stringify({ id: s.id, secret: s.secret }) }))).json();
    expect(p.state).toBe("waiting");
    // The wrong secret learns nothing.
    const wrong = await pollRoute.POST(program("/api/gpu/pair/poll", undefined, { body: JSON.stringify({ id: s.id, secret: "0".repeat(64) }) }));
    expect(wrong.status).toBe(404);
    const look = await (await pairRoute.GET(browser("a", `/api/gpu/pair?code=${s.code.toLowerCase().replace("-", " ")}`))).json();
    expect(look.name).toBe("My PC script");
    expect(look.facts).toEqual({ device: "x" });
  });

  it("approval needs a signed-in person in a browser, never a token", async () => {
    const s = workers.startPairing({ name: "pc" });
    const guest = await pairRoute.POST(new Request(`${SITE}/api/gpu/pair`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify({ code: s.code }) }));
    expect(guest.status).toBe(401);
    const { token } = auth.createToken("script");
    const tok = await pairRoute.POST(new Request(`${SITE}/api/gpu/pair`, { method: "POST", headers: { host: HOST, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ code: s.code }) }));
    expect(tok.status).toBe(403);
  });

  it("delivers the token once, only its hash is kept, and the account's GPU becomes its computer", async () => {
    auth.setAccountGpu(a, null);
    const p = await pair("a");
    expect(p.token).toMatch(/^fuobe_wkr_[A-Za-z0-9_-]{43}$/);
    // ComfyUI's window says who approved it, masked.
    expect(p.account).toBe("a•••@example.com");
    expect(auth.accountGpu(a)?.mode).toBe("computer");
    const rows = JSON.stringify(db().prepare("SELECT * FROM relay_workers").all()) + JSON.stringify(db().prepare("SELECT * FROM relay_pairings").all());
    expect(rows).not.toContain(p.token);
    const again = await pollRoute.POST(program("/api/gpu/pair/poll", undefined, { body: JSON.stringify({ id: p.pairId, secret: p.secret }) }));
    expect(again.status).toBe(404);
    const reuse = await pairRoute.POST(browser("b", "/api/gpu/pair", { method: "POST", body: JSON.stringify({ code: p.code }) }));
    expect(reuse.status).toBe(404);
  });

  it("an expired or denied code can't be approved", async () => {
    const old = workers.startPairing({ name: "pc" }, Date.now() - workers.PAIR_MS - 1000);
    expect(workers.approvePairing(old.code, `acct:${a}`)).toBeNull();
    const s = workers.startPairing({ name: "pc" });
    expect(workers.denyPairing(s.code)).toBe(true);
    expect(workers.approvePairing(s.code, `acct:${a}`)).toBeNull();
    expect(workers.pollPairing(s.id, s.secret).state).toBe("gone");
  });

  it("the owner can pair too: ComfyUI then runs on the owner's computer", async () => {
    setSetting("comfyWhere", "server");
    const p = await pair("owner");
    expect(p.account).toBe("the studio's owner");
    expect(getSetting("comfyWhere")).toBe("computer");
    const req = program("/api/gpu/computer/beat", p.token);
    expect(principalOf(req)).toBe("owner");
    expect(requestWorker(req)?.id).toBe(p.id);
    setSetting("comfyWhere", "server");
  });

  it("codes are case- and dash-blind", () => {
    expect(pairCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(pairCode("abcd-efg")).toBeNull();
    expect(pairCode("ABCD-EFG1")).toBeNull();
    expect(workers.normaliseCode("abcdefgh")).toBe("ABCD-EFGH");
  });
});

describe("a paired ComfyUI's token", () => {
  it("acts only as its own person's computer", async () => {
    const pa = await pair("a");
    const pb = await pair("b");
    expect(principalOf(program("/api/gpu/computer/claim", pa.token))).toBe(`acct:${a}`);
    expect(principalOf(program("/api/gpu/computer/claim", pb.token))).toBe(`acct:${b}`);
    // A's waiting task never reaches B's ComfyUI.
    db().prepare("INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES ('g-a', 'image', 'm', 'open', 'comfyui', 't2i', 'image', 'queued', ?, '[]', ?, ?)").run(JSON.stringify({ account: a }), Date.now(), Date.now());
    tasks.createTask({ principal: `acct:${a}`, generationId: "g-a", graph: { "1": { class_type: "SaveImage", inputs: {} } } });
    tasks.beat(`acct:${b}`, { device: "connect-bobpc01", ready: true });
    expect(tasks.claim(`acct:${b}`, "connect-bobpc01", [])).toBeNull();
    tasks.beat(`acct:${a}`, { device: "connect-alice01", ready: true });
    expect(tasks.claim(`acct:${a}`, "connect-alice01", [])?.generationId).toBe("g-a");
  });

  it("is never the owner, and reaches no route but the computer's", async () => {
    const p = await pair("a");
    expect(auth.validToken(`Bearer ${p.token}`)).toBe(false);
    const other = proxy(new NextRequest(`${SITE}/api/settings`, { headers: { host: HOST, authorization: `Bearer ${p.token}` } }));
    expect(other.status).toBe(403);
    const own = proxy(new NextRequest(`${SITE}/api/gpu/computer/beat`, { method: "POST", headers: { host: HOST, authorization: `Bearer ${p.token}` } }));
    expect(own.headers.get("x-middleware-next")).toBe("1");
    // A made-up worker token is no token.
    const fake = principalOf(program("/api/gpu/computer/beat", `fuobe_wkr_${"A".repeat(43)}`));
    expect((fake as Response).status).toBe(401);
  });

  it("an owner API token can't act as a worker", async () => {
    const { token } = auth.createToken("script");
    const r = principalOf(program("/api/gpu/computer/beat", token));
    expect((r as Response).status).toBe(403);
  });

  it("stops at its next call when the person disconnects it, or it disconnects itself", async () => {
    const p = await pair("a");
    const list = await (await pairedRoute.GET(browser("a", "/api/gpu/paired"))).json();
    expect(list.paired.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect((await (await pairedRoute.GET(browser("b", "/api/gpu/paired"))).json()).paired).toEqual([]);
    // B can't disconnect A's.
    const notYours = await pairedIdRoute.DELETE(browser("b", `/api/gpu/paired/${p.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: p.id }) });
    expect(notYours.status).toBe(404);
    const gone = await pairedIdRoute.DELETE(browser("a", `/api/gpu/paired/${p.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: p.id }) });
    expect(gone.status).toBe(200);
    expect((principalOf(program("/api/gpu/computer/beat", p.token)) as Response).status).toBe(401);
    const q = await pair("a");
    expect((await unpairRoute.POST(program("/api/gpu/computer/unpair", q.token))).status).toBe(200);
    expect((principalOf(program("/api/gpu/computer/beat", q.token)) as Response).status).toBe(401);
  });

  it("follows the person's own setting: a link-mode GPU, a disabled account or sign-up turned off stop it", async () => {
    const p = await pair("a");
    auth.setAccountGpu(a, { url: "https://gpu.example.com" });
    expect((principalOf(program("/api/gpu/computer/beat", p.token)) as Response).status).toBe(409);
    auth.setAccountGpu(a, { mode: "computer" });
    auth.setAccountDisabled(a, true);
    expect((principalOf(program("/api/gpu/computer/beat", p.token)) as Response).status).toBe(401);
    auth.setAccountDisabled(a, false);
    process.env.FUOBE_PUBLIC_SIGNUP = "0";
    expect((principalOf(program("/api/gpu/computer/beat", p.token)) as Response).status).toBe(401);
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(principalOf(program("/api/gpu/computer/beat", p.token))).toBe(`acct:${a}`);
  });

  it("goes with a deleted account", async () => {
    const p = await pair("b");
    tasks.purgeComputer(`acct:${b}`);
    expect(workers.getWorker(p.id)).toBeNull();
  });
});

describe("paths", () => {
  it("accounts may pair and list their own; the start and poll calls are open", () => {
    expect(accountOwnRead("/api/gpu/pair")).toBe(true);
    expect(accountOwnRead("/api/gpu/paired")).toBe(true);
    expect(accountMayChange("POST", "/api/gpu/pair", "")).toBe(true);
    expect(accountMayChange("DELETE", "/api/gpu/paired/abc", "")).toBe(true);
    const start = proxy(new NextRequest(`${SITE}/api/gpu/pair/start`, { method: "POST", headers: { host: HOST } }));
    expect(start.headers.get("x-middleware-next")).toBe("1");
  });

  it("Fuobe Connect's words", () => {
    expect(trustedByDefault("https://fuobe.com/")).toBe(true);
    expect(trustedByDefault("https://studio.example.com")).toBe(false);
    expect(isConnectAnswer({ connect: 1 })).toBe(true);
    expect(isConnectAnswer({ guard: 1 })).toBe(false);
  });
});
