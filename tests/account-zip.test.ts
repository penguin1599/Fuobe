import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";
// Route handlers call connection(); outside a request scope it would throw.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * A signed-in account (public sign-up) downloads its own runs as one zip (the Library's Download, a result's Download
 * all, Shorts' Download parts): never anyone else's, within its limits, one zip at a time. A guest is offered to sign up.
 */

const dir = tempDir("fuobe-account-zip-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOWED_ORIGINS;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
const auth = await import("@/server/auth");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { db } = await import("@/server/db");
const { FILES_DIR } = await import("@/server/storage");
const { ACCOUNT_LIMITS, ACCOUNT_MESSAGES } = await import("@/server/account-files");
const { accountZipBusy } = await import("@/server/account-zip");
const { GET } = await import("@/app/api/generations/zip/route");
afterAll(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
});

let a = "";
let aId = "";
let b = "";
let bId = "";
let owner = "";

/** A finished run with one output file: whose run it is (null: the owner's), and whose file (held: waiting for its check). */
function run(id: string, who: string | null, opts: { held?: boolean; fileOwner?: string | null } = {}) {
  const rel = `outputs/${id}.png`;
  fs.mkdirSync(path.join(FILES_DIR, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, rel), `png of ${id}`);
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'image', 'm', 'open', 'comfyui', 'text-to-image', 'image', 'succeeded', ?, ?, ?, ?)",
    )
    .run(id, JSON.stringify({ feature: "image", modelId: "m", prompt: id, ...(who && { account: who }) }), JSON.stringify([{ url: `/api/files/${rel}` }]), now, now);
  db()
    .prepare("INSERT INTO assets (id, kind, rel_path, content_type, size, source, generation_id, account_id, held, created_at) VALUES (?, 'image', ?, 'image/png', ?, 'generation', ?, ?, ?, ?)")
    .run(`as-${id}`, rel, fs.statSync(path.join(FILES_DIR, rel)).size, id, opts.fileOwner === undefined ? who : opts.fileOwner, opts.held ? 1 : 0, now);
}

const get = (ids: string[], cookie?: string, extra = "") =>
  GET(new Request(`http://localhost:3000/api/generations/zip?ids=${ids.join(",")}${extra}`, cookie ? { headers: { cookie: `${auth.SESSION_COOKIE}=${cookie}` } } : undefined));

async function names(r: Response): Promise<string[]> {
  const buf = Buffer.from(await r.arrayBuffer());
  expect(buf.length).toBe(Number(r.headers.get("content-length")));
  // The central directory's names (signature 0x02014b50, name length at +28, name at +46).
  const out: string[] = [];
  for (let i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); i >= 0; i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 4)) {
    out.push(buf.subarray(i + 46, i + 46 + buf.readUInt16LE(i + 28)).toString("utf8"));
  }
  return out;
}

beforeAll(() => {
  auth.setPassword("install password");
  const accA = auth.createAccount("zip-a@example.com", "long enough");
  aId = accA.id;
  a = auth.createSession(aId).value;
  const accB = auth.createAccount("zip-b@example.com", "long enough");
  bId = accB.id;
  b = auth.createSession(bId).value;
  owner = auth.createSession().value;
  run("a-1", aId);
  run("a-2", aId);
  run("a-held", aId, { held: true });
  run("b-1", bId);
  run("owner-1", null);
  // An account's run naming a file that isn't its own (it may not open it, so it isn't zipped either).
  run("a-odd", aId, { fileOwner: bId });
});

describe("the proxy", () => {
  it("passes an account's zip to the route, and offers a guest to sign up", async () => {
    expect(proxy(new NextRequest("http://localhost:3000/api/generations/zip?ids=a-1", { headers: { cookie: `${auth.SESSION_COOKIE}=${a}` } })).headers.get("x-middleware-next")).toBe("1");
    const guest = proxy(new NextRequest("http://localhost:3000/api/generations/zip?ids=a-1"));
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
    expect((await guest.json()).error).toBe(access.GUEST_LIBRARY_MESSAGE);
  });
});

describe("an account's zip", () => {
  it("holds its own runs", async () => {
    const r = await get(["a-1", "a-2"], a);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect((await names(r)).sort()).toEqual([expect.stringMatching(/^a-1/), expect.stringMatching(/^a-2/)]);
  });

  it("leaves out anyone else's runs, as if they didn't exist", async () => {
    const mixed = await get(["a-1", "b-1", "owner-1"], a);
    expect(mixed.status).toBe(200);
    const got = await names(mixed);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^a-1/);
    // Only someone else's: the same answer as an id that isn't there at all.
    const foreign = await get(["b-1", "owner-1"], a);
    const missing = await get(["no-such-run"], a);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    // B can't zip A's either.
    expect((await get(["a-1", "a-2"], b)).status).toBe(404);
  });

  it("leaves out a file held for its check, and a file that isn't its own", async () => {
    expect((await get(["a-held", "a-odd"], a)).status).toBe(404);
  });

  it("says how big it is first, when asked", async () => {
    const r = await get(["a-1", "a-2", "b-1"], a, "&check=1");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: number; size: number };
    expect(body.files).toBe(2);
    expect(body.size).toBeGreaterThan(0);
    expect(accountZipBusy(aId)).toBe(false);
  });

  it(`takes up to ${access.ACCOUNT_ZIP_MAX_RUNS} runs and 1 GB`, async () => {
    expect(ACCOUNT_LIMITS.zipRuns).toBe(200);
    expect(ACCOUNT_LIMITS.zipBytes).toBe(2 ** 30);
    const many = ["a-1", ...Array.from({ length: ACCOUNT_LIMITS.zipRuns }, (_, i) => `x-${i}`)];
    const tooMany = await get(many, a);
    expect(tooMany.status).toBe(413);
    expect((await tooMany.json()).error).toBe(ACCOUNT_MESSAGES.zipTooMany);
    // The same id twice counts once.
    expect((await get(["a-1", ...many.slice(1, ACCOUNT_LIMITS.zipRuns), "a-1"], a, "&check=1")).status).toBe(200);
    const limits = ACCOUNT_LIMITS as { zipBytes: number };
    const was = limits.zipBytes;
    limits.zipBytes = 100;
    try {
      const big = await get(["a-1", "a-2"], a);
      expect(big.status).toBe(413);
      expect((await big.json()).error).toBe(ACCOUNT_MESSAGES.zipTooBig);
    } finally {
      limits.zipBytes = was;
    }
  });

  it("makes one zip at a time, and frees the account when it ends, is stopped or stalls", async () => {
    const first = await get(["a-1"], a);
    expect(first.status).toBe(200);
    expect(accountZipBusy(aId)).toBe(true);
    const second = await get(["a-2"], a);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe(ACCOUNT_MESSAGES.zipBusy);
    // Another account isn't held up.
    expect((await get(["b-1"], b)).status).toBe(200);
    await first.arrayBuffer();
    expect(accountZipBusy(aId)).toBe(false);
    // Stopped part way.
    const stopped = await get(["a-1"], a);
    await stopped.body!.cancel();
    expect(accountZipBusy(aId)).toBe(false);
    // Stalled: free after the idle time, whatever its reader does.
    const stalled = await get(["a-1"], a);
    expect(accountZipBusy(aId)).toBe(true);
    expect(accountZipBusy(aId, Date.now() + ACCOUNT_LIMITS.zipIdleMs + 1)).toBe(false);
    await stalled.body!.cancel();
  });
});

describe("the owner's zip", () => {
  it("is as it was: any run, no account limits", async () => {
    const r = await get(["a-1", "b-1", "owner-1"], owner);
    expect(r.status).toBe(200);
    expect(await names(r)).toHaveLength(3);
    const many = ["owner-1", ...Array.from({ length: 300 }, (_, i) => `x-${i}`)];
    expect((await get(many, owner)).status).toBe(200);
    // Two at once.
    const one = await get(["owner-1"], owner);
    const two = await get(["owner-1"], owner);
    expect([one.status, two.status]).toEqual([200, 200]);
    await one.arrayBuffer();
    await two.arrayBuffer();
  });

  it("says how big it is first, when asked, as an account's does", async () => {
    const r = await get(["a-1", "owner-1"], owner, "&check=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(((await r.json()) as { files: number }).files).toBe(2);
    expect((await get(["no-such-run"], owner, "&check=1")).status).toBe(404);
  });
});

describe("a guest", () => {
  it("gets the sign-up card from the route too", async () => {
    const r = await get(["a-1"]);
    expect(r.status).toBe(401);
    expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
    expect((await r.json()).error).toBe(access.GUEST_LIBRARY_MESSAGE);
  });
});
