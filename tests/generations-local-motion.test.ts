import fs from "node:fs";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";

// Results made in the browser through Fuobe (POST /api/generations/local): the owner records its own clip; an account
// records its own clip, colour grade or Relight blend, made from its own files, as its own run (its list, never the
// owner's Library), within its run rate and through the studio's checks; a guest is told to sign up; the proxy lets an
// account through to the route. Split soundtrack's Export mix (POST /api/audio-tools/export) is an account's run too.

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.setConfig({ testTimeout: 30_000 });

const dir = tempDir("fuobe-local-motion-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_MODERATION_URL;
const auth = await import("@/server/auth");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { POST } = await import("@/app/api/generations/local/route");
const exportRoute = await import("@/app/api/audio-tools/export/route");
const { filesRel, saveFile, scratchDir } = await import("@/server/storage");
const { generationAccount, fileAccount, fileRecord } = await import("@/server/account-library");
const { mixPart, mixPlan } = await import("@/lib/av/split");
const { listGenerations, getGeneration } = await import("@/server/generations");
const { hit } = await import("@/server/rate");
const { RECIPE_MAX_BYTES } = await import("@/lib/motion/recipe");
const { recipe } = await import("./helpers/motion");
const { designSize, exportSize } = await import("@/lib/motion/sizes");

let moderation: http.Server | null = null;
let answer: Record<string, unknown> = { allowed: true };
/** What the studio's checks were last asked about. */
let asked: { prompt?: string; run?: { kind?: string; place?: string } } = {};
beforeAll(async () => {
  auth.setPassword("install password");
  moderation = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        asked = JSON.parse(body);
      } catch {}
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => moderation!.listen(0, "127.0.0.1", () => r()));
});
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
  delete process.env.FUOBE_MODERATION_URL;
  answer = { allowed: true };
});
afterAll(() => {
  moderation?.close();
});

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 1)]);
const ownerFile = (type = "video/mp4", name = "k.mp4") => saveFile({ data: MP4, contentType: type, name, source: "upload" }).url;
const accountFile = (id: string, type = "video/mp4", name = "k.mp4") => saveFile({ data: MP4, contentType: type, name, source: "upload", accountId: id }).url;

const body = (output: string, over: Record<string, unknown> = {}) => ({
  feature: "kinetic-end-card",
  modelId: "local-motion",
  op: "motion",
  prompt: "Maison Ardent · Barrier Cream · Shop now",
  title: "Maison Ardent end card · Draw-on",
  inputs: {},
  params: { extra: { motion: recipe("end-card/draw-on") } },
  output: { url: output, kind: "video", contentType: "video/mp4" },
  ...over,
});

const call = (b: unknown, cookie?: string) =>
  POST(new Request("http://localhost:3000/api/generations/local", { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) }, body: JSON.stringify(b) }));

const owner = () => auth.createSession().value;
let n = 0;
function newAccount(): { id: string; cookie: string } {
  const a = auth.createAccount(`motion-${n++}@example.com`, "long enough");
  return { id: a.id, cookie: auth.createSession(a.id).value };
}

describe("the owner", () => {
  it("records a Kinetic Motion clip with its recipe, in the Library", async () => {
    const url = ownerFile();
    const r = await call(body(url), owner());
    expect(r.status).toBe(201);
    const g = await r.json();
    expect(g).toMatchObject({ modelId: "local-motion", op: "motion", status: "succeeded", kind: "video", feature: "kinetic-end-card" });
    expect(generationAccount(g.id)).toBeNull();
    expect(getGeneration(g.id)!.request.params?.extra?.motion).toMatchObject({ scene: "end-card/draw-on" });
  });

  it("refuses a recipe that is too big or not a recipe, and an output that isn't a clip under /api/files/", async () => {
    const url = ownerFile();
    const huge = { ...recipe("end-card/draw-on"), controls: Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`k${i}`, "y".repeat(78)])) };
    expect(JSON.stringify(huge).length).toBeGreaterThan(RECIPE_MAX_BYTES);
    expect((await call(body(url, { params: { extra: { motion: huge } } }), owner())).status).toBe(400);
    expect((await call(body(url, { params: { extra: { motion: { scene: "x" } } } }), owner())).status).toBe(400);
    expect((await call(body(url, { params: {} }), owner())).status).toBe(400);
    expect((await call(body(url, { output: { url, kind: "image", contentType: "image/png" } }), owner())).status).toBe(400);
    expect((await call(body(url, { output: { url: "https://elsewhere.example/a.mp4", kind: "video", contentType: "video/mp4" } }), owner())).status).toBe(400);
    expect((await call(body(url, { inputs: { images: ["/api/files/a.png", "/api/files/b.png", "/api/files/c.png", "/api/files/d.png", "/api/files/e.png"] } }), owner())).status).toBe(400);
  });

  it("refuses a picture recorded as a clip: the stored file's type is what counts", async () => {
    const png = ownerFile("image/png", "p.png");
    expect((await call(body(png), owner())).status).toBe(400);
    const webm = ownerFile("video/webm", "k.webm");
    expect((await call(body(webm), owner())).status).toBe(400);
    expect((await call(body(webm, { output: { url: webm, kind: "video", contentType: "video/webm" } }), owner())).status).toBe(201);
  });

  it("never records an account's file as the owner's", async () => {
    const a = newAccount();
    expect((await call(body(accountFile(a.id)), owner())).status).toBe(403);
  });

  it("still takes a grade with one picture, and refuses two", async () => {
    const out = ownerFile("image/png", "g.png");
    const grade = { feature: "grade", modelId: "local-color-grade", op: "grade", prompt: "Warm", inputs: { images: [ownerFile("image/png", "s.png")] }, output: { url: out, kind: "image" } };
    expect((await call(grade, owner())).status).toBe(201);
    expect((await call({ ...grade, inputs: { images: [out, out] } }, owner())).status).toBe(400);
  });
});

describe("an account", () => {
  it("records its own clip as its own run: in its list, not the owner's", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const logo = accountFile(a.id, "image/png", "logo.png");
    const r = await call(body(accountFile(a.id), { inputs: { images: [logo] } }), a.cookie);
    expect(r.status).toBe(201);
    const g = await r.json();
    expect(generationAccount(g.id)).toBe(a.id);
    expect(listGenerations({ account: a.id }).map((x) => x.id)).toContain(g.id);
    // Not in the owner's own list.
    expect(listGenerations().map((x) => x.id)).not.toContain(g.id);
  });

  it("can't record the owner's file or another account's, or name someone else's input", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const b = newAccount();
    expect((await call(body(ownerFile()), a.cookie)).status).toBe(403);
    expect((await call(body(accountFile(b.id)), a.cookie)).status).toBe(403);
    const r = await call(body(accountFile(a.id), { inputs: { images: [accountFile(b.id, "image/png", "logo.png")] } }), a.cookie);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/can't find/);
  });

  it("can't name someone else's file anywhere in the clip: a video input, the recipe's product, pictures or logo", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const theirs = ownerFile("image/png", "o.png");
    // A clip is made from pictures, never from a video.
    expect((await call(body(accountFile(a.id), { inputs: { video: ownerFile() } }), a.cookie)).status).toBe(400);
    expect((await call(body(accountFile(a.id), { inputs: { video: accountFile(a.id) } }), a.cookie)).status).toBe(400);
    for (const over of [{ media: { product: theirs } }, { media: { images: [theirs] } }, { brand: { ...recipe("end-card/draw-on").brand, logo: theirs } }]) {
      const r = await call(body(accountFile(a.id), { params: { extra: { motion: recipe("end-card/draw-on", over) } } }), a.cookie);
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/can't find/);
    }
    // Its own files there are fine.
    const mine = accountFile(a.id, "image/png", "p.png");
    expect((await call(body(accountFile(a.id), { params: { extra: { motion: recipe("end-card/draw-on", { media: { product: mine }, brand: { ...recipe("end-card/draw-on").brand, logo: mine } }) } } }), a.cookie)).status).toBe(201);
  });

  it("can't record a picture as a clip", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    expect((await call(body(accountFile(a.id, "image/png", "p.png")), a.cookie)).status).toBe(400);
  });

  it("records its own colour grade and Relight blend as its runs, from its own files only", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const b = newAccount();
    const png = (id: string, name = "g.png") => accountFile(id, "image/png", name);
    const grade = (output: string, over: Record<string, unknown> = {}) => ({
      feature: "grade",
      modelId: "local-color-grade",
      op: "grade",
      prompt: "Warm film · contrast +10",
      inputs: {},
      params: { extra: { grade: { contrast: 0.1 } } },
      output: { url: output, kind: "image", contentType: "image/png" },
      ...over,
    });
    const r = await call(grade(png(a.id)), a.cookie);
    expect(r.status).toBe(201);
    const g = await r.json();
    expect(g).toMatchObject({ modelId: "local-color-grade", op: "grade", kind: "image", status: "succeeded" });
    expect(generationAccount(g.id)).toBe(a.id);
    expect(listGenerations({ account: a.id }).map((x) => x.id)).toContain(g.id);
    expect(listGenerations().map((x) => x.id)).not.toContain(g.id);
    // Made from its own picture: fine. From another account's or the owner's, or another account's output: refused.
    expect((await call(grade(png(a.id), { inputs: { images: [png(a.id, "s.png")] } }), a.cookie)).status).toBe(201);
    expect((await call(grade(png(a.id), { inputs: { images: [png(b.id, "s.png")] } }), a.cookie)).status).toBe(403);
    expect((await call(grade(png(a.id), { inputs: { images: [ownerFile("image/png", "s.png")] } }), a.cookie)).status).toBe(403);
    expect((await call(grade(png(b.id)), a.cookie)).status).toBe(403);
    // Only what the page renders: a PNG picture, or an MP4 or WebM clip.
    const jpeg = accountFile(a.id, "image/jpeg", "g.jpg");
    expect((await call(grade(jpeg, { output: { url: jpeg, kind: "image", contentType: "image/jpeg" } }), a.cookie)).status).toBe(400);
    const clip = accountFile(a.id, "video/webm", "g.webm");
    expect((await call(grade(clip, { inputs: { video: accountFile(a.id) }, output: { url: clip, kind: "video", contentType: "video/webm" } }), a.cookie)).status).toBe(201);
    // A Relight blend of its own photo.
    const blend = await call(
      {
        feature: "relight",
        modelId: "local-relight",
        op: "relight",
        prompt: "Warm key light from the left",
        title: "Golden hour",
        inputs: { images: [png(a.id, "photo.png")] },
        params: { extra: { relight: { intensity: 0.8 } } },
        output: { url: png(a.id, "b.png"), kind: "image", contentType: "image/png" },
      },
      a.cookie,
    );
    expect(blend.status).toBe(201);
    expect(generationAccount((await blend.json()).id)).toBe(a.id);
    // A grade is never recorded as a Relight blend.
    expect((await call(grade(png(a.id), { modelId: "local-relight" }), a.cookie)).status).toBe(422);
  });

  it("is held to its run rate", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    // Its saves and its runs share one hourly budget.
    for (let i = 0; i < 60; i++) hit(`run:${a.id}`, 60, 60 * 60_000);
    const r = await call(body(accountFile(a.id)), a.cookie);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("goes through the studio's checks: a refusal answers 422 with its words, a held output waits for its check", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const addr = moderation!.address() as { port: number };
    process.env.FUOBE_MODERATION_URL = `http://127.0.0.1:${addr.port}`;
    const a = newAccount();
    answer = { allowed: false, code: "blocked", text: "This can't be made here." };
    const refused = await call(body(accountFile(a.id)), a.cookie);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "This can't be made here.", code: "blocked" });
    answer = { allowed: true, checkOutputs: true };
    const url = accountFile(a.id);
    const held = await call(body(url), a.cookie);
    expect(held.status).toBe(201);
    const g = await held.json();
    expect(g.status).toBe("running");
    expect(fileRecord(url.replace("/api/files/", ""))?.held).toBe(true);
  });

  it("checks the words drawn on the clip and its title, not the page's summary, and keeps them as the run's words", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const addr = moderation!.address() as { port: number };
    process.env.FUOBE_MODERATION_URL = `http://127.0.0.1:${addr.port}`;
    const a = newAccount();
    answer = { allowed: true };
    const fields = { brand: "Halden & Rowe", product: "The Overcoat", cta: "Shop the coat" };
    const r = await call(body(accountFile(a.id), { prompt: "", title: "Winter end card", params: { extra: { motion: recipe("end-card/rise", { fields }) } } }), a.cookie);
    expect(r.status).toBe(201);
    for (const w of [...Object.values(fields), "Maison Ardent", "Winter end card"]) expect(asked.prompt).toContain(w);
    expect(asked.run).toMatchObject({ kind: "video", place: "pool" });
    const g = await r.json();
    expect(getGeneration(g.id)!.prompt).toBe(asked.prompt);
  });

  it("checks a grade's description with its title, as a picture, and keeps its description", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const addr = moderation!.address() as { port: number };
    process.env.FUOBE_MODERATION_URL = `http://127.0.0.1:${addr.port}`;
    const a = newAccount();
    answer = { allowed: true };
    const out = accountFile(a.id, "image/png", "g.png");
    const grade = (prompt: string, title?: string, url = out) => ({ feature: "grade", modelId: "local-color-grade", op: "grade", prompt, ...(title && { title }), inputs: {}, output: { url, kind: "image", contentType: "image/png" } });
    const r = await call(grade("Teal and orange", "Night grade"), a.cookie);
    expect(r.status).toBe(201);
    expect(asked.prompt).toBe("Teal and orange · Night grade");
    expect(asked.run).toMatchObject({ kind: "image", place: "pool" });
    expect(getGeneration((await r.json()).id)!.prompt).toBe("Teal and orange");
    answer = { allowed: false, code: "blocked", text: "This can't be made here." };
    expect((await call(grade("x", undefined, accountFile(a.id, "image/png", "h.png")), a.cookie)).status).toBe(422);
  });
});

describe("an account's Export mix (Split soundtrack)", () => {
  const send = (q: string, part: Uint8Array, cookie?: string) =>
    exportRoute.POST(
      new Request(`http://localhost:3000/api/audio-tools/export?${q}`, {
        method: "POST",
        headers: { host: "localhost:3000", "content-type": "application/octet-stream", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) },
        body: Buffer.from(part),
      }),
    );
  const plan = mixPlan([{ channels: [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) / 2)], gain: 1 }], 8000);
  const parts = () => fs.readdirSync(scratchDir()).filter((f) => f.startsWith("mix-"));

  it("keeps the mix as the account's own run, in its own files, and nobody else sends its parts", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const b = newAccount();
    const first = await send("offset=0", mixPart(plan, 0, 500), a.cookie);
    expect(first.status).toBe(200);
    const { id, received } = await first.json();
    for (const cookie of [b.cookie, owner()]) expect((await send(`offset=${received}&id=${id}`, mixPart(plan, 500, 1000), cookie)).status).toBe(404);
    const done = await send(`offset=${received}&id=${id}&last=1&name=${encodeURIComponent("Film · No dialogue.wav")}`, mixPart(plan, 500, 1000), a.cookie);
    expect(done.status).toBe(201);
    const g = await done.json();
    expect(g).toMatchObject({ feature: "audio-split-mix", modelId: "local-mix", op: "mix", kind: "audio", status: "succeeded", prompt: "Film · No dialogue" });
    expect(generationAccount(g.id)).toBe(a.id);
    expect(listGenerations({ account: a.id }).map((x) => x.id)).toContain(g.id);
    expect(listGenerations().map((x) => x.id)).not.toContain(g.id);
    expect(fileAccount(filesRel(g.outputs[0].url)!)).toBe(a.id);
    expect(parts()).toEqual([]);
  });

  it("holds it to the room its files have left, one export at a time, and its run rate", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    // A header that says more than its uploads have room for.
    const big = mixPart(plan, 0, 10);
    new DataView(big.buffer).setUint32(4, 1.5 * 1024 ** 3, true);
    const over = await send("offset=0", big, a.cookie);
    expect(over.status).toBe(413);
    expect((await over.json()).error).toMatch(/1 GB/);
    // A new export drops the unfinished one.
    const one = await (await send("offset=0", mixPart(plan, 0, 500), a.cookie)).json();
    const two = await (await send("offset=0", mixPart(plan, 0, 500), a.cookie)).json();
    expect((await send(`offset=${one.received}&id=${one.id}`, mixPart(plan, 500, 600), a.cookie)).status).toBe(404);
    // Past its run rate the finished mix isn't kept.
    for (let i = 0; i < 60; i++) hit(`run:${a.id}`, 60, 60 * 60_000);
    const late = await send(`offset=${two.received}&id=${two.id}&last=1&name=Mix`, mixPart(plan, 500, 1000), a.cookie);
    expect(late.status).toBe(429);
    expect(listGenerations({ account: a.id })).toEqual([]);
    expect(parts()).toEqual([]);
  });
});

describe("guests and the proxy", () => {
  const req = (cookie?: string) =>
    new NextRequest("http://localhost:3000/api/generations/local", { method: "POST", headers: { "content-type": "application/json", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) }, body: "{}" });

  it("lets an account's call through to the route, and gives a guest the sign-up card", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(access.accountMayChange("POST", "/api/generations/local", "")).toBe(true);
    expect(access.isLibraryChange("POST", "/api/generations/local")).toBe(false);
    const a = newAccount();
    expect(proxy(req(a.cookie)).headers.get("x-middleware-next")).toBe("1");
    const guest = proxy(req());
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
    expect((await call(body(ownerFile()))).status).toBe(401);
  });
});

describe("Kinetic page results: frames, contact sheets, versions and a clip under the words", () => {
  /** A PNG's first bytes: the signature and an IHDR chunk with its size (enough for the route's size check). */
  const pngOf = (w: number, h: number) => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    ihdr[16] = 8;
    ihdr[17] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(100, 2)]);
  };
  /** The size a picture result of the default recipe (the draw-on end card) is made at. */
  const sizeFor = (feature: string) => {
    const r = recipe("end-card/draw-on");
    if (feature === "kinetic-version") {
      const d = designSize(r.size);
      const k = 540 / Math.max(d.w, d.h);
      return { w: Math.round(d.w * k), h: Math.round(d.h * k) };
    }
    const e = exportSize(r.size);
    return { w: e.w - (e.w % 2), h: e.h - (e.h % 2) };
  };
  const png = (accountId?: string, feature = "kinetic-frame", size = sizeFor(feature)) =>
    saveFile({ data: pngOf(size.w, size.h), contentType: "image/png", name: "k.png", source: "upload", ...(accountId && { accountId }) }).url;
  const picture = (url: string, feature: string, over: Record<string, unknown> = {}) => body(url, { feature, output: { url, kind: "image", contentType: "image/png" }, ...over });
  const layer = (src: string) => ({ src, from: 0, fit: "cover", dim: 0.2, scrim: "bottom" });

  it("records a frame, a contact sheet and a version as PNG pictures; a PNG is never a clip", async () => {
    for (const f of ["kinetic-frame", "kinetic-sheet", "kinetic-version"]) {
      const r = await call(picture(png(undefined, f), f), owner());
      expect(r.status, f).toBe(201);
      const o = (await r.json()).outputs[0];
      expect(o.kind).toBe("image");
      // Recorded with its size, so its tile shows it whole.
      expect({ w: o.width, h: o.height }, f).toEqual(sizeFor(f));
    }
    expect((await call(picture(png(), "kinetic"), owner())).status).toBe(400);
    // A clip recorded as a frame, and a frame stored as a clip, are refused.
    expect((await call(body(ownerFile(), { feature: "kinetic-frame" }), owner())).status).toBe(400);
    expect((await call(body(png(), { feature: "kinetic-frame", output: { url: png(), kind: "video", contentType: "video/mp4" } }), owner())).status).toBe(400);
  });

  it("takes a picture only at the size its recipe makes, and records a clip with its size", async () => {
    // Any other PNG (a picture that isn't this recipe's frame) is refused, as is one whose header can't be read.
    for (const f of ["kinetic-frame", "kinetic-sheet", "kinetic-version"]) {
      expect((await call(picture(png(undefined, f, { w: 640, h: 640 }), f), owner())).status, f).toBe(400);
    }
    const bare = saveFile({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), contentType: "image/png", name: "cut.png", source: "upload" }).url;
    expect((await call(picture(bare, "kinetic-frame"), owner())).status).toBe(400);
    const r = await call(body(ownerFile()), owner());
    expect(r.status).toBe(201);
    const o = (await r.json()).outputs[0];
    expect({ w: o.width, h: o.height }).toEqual(sizeFor("kinetic"));
  });

  it("takes only a stored video as the clip under the words", async () => {
    const picture = saveFile({ data: pngOf(64, 64), contentType: "image/png", name: "still.png", source: "upload" }).url;
    const motion = recipe("marketing/big-number", { layers: { video: layer(picture) } } as never);
    expect((await call(body(ownerFile(), { feature: "kinetic", params: { extra: { motion } } }), owner())).status).toBe(400);
  });

  it("takes a video input only when it is the recipe's own clip", async () => {
    const clip = ownerFile("video/mp4", "under.mp4");
    const motion = recipe("marketing/big-number", { layers: { video: layer(clip) } } as never);
    expect((await call(body(ownerFile(), { feature: "kinetic", inputs: { video: clip }, params: { extra: { motion } } }), owner())).status).toBe(201);
    expect((await call(body(ownerFile(), { feature: "kinetic", inputs: { video: ownerFile("video/mp4", "other.mp4") }, params: { extra: { motion } } }), owner())).status).toBe(400);
  });

  it("an account's clip under the words must be its own file", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const b = newAccount();
    const mine = accountFile(a.id, "video/mp4", "mine.mp4");
    const ok = await call(body(accountFile(a.id), { feature: "kinetic", inputs: { video: mine }, params: { extra: { motion: recipe("marketing/big-number", { layers: { video: layer(mine) } } as never) } } }), a.cookie);
    expect(ok.status).toBe(201);
    for (const theirs of [accountFile(b.id, "video/mp4", "theirs.mp4"), ownerFile("video/mp4", "owners.mp4")]) {
      const r = await call(body(accountFile(a.id), { feature: "kinetic", inputs: { video: theirs }, params: { extra: { motion: recipe("marketing/big-number", { layers: { video: layer(theirs) } } as never) } } }), a.cookie);
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/can't find/);
      // Named in the recipe only, it is checked all the same.
      const r2 = await call(body(accountFile(a.id), { feature: "kinetic", params: { extra: { motion: recipe("marketing/big-number", { layers: { video: layer(theirs) } } as never) } } }), a.cookie);
      expect(r2.status).toBe(403);
    }
    // Its own frame as a picture result.
    expect((await call(picture(png(a.id, "kinetic-version"), "kinetic-version"), a.cookie)).status).toBe(201);
  });
});
