import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SwapProject, SwapTake } from "@/lib/catalog/swap-studio";
import type { SwapProjectView } from "@/server/swap-studio";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 240_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

// Character Swap Studio's Sharpen through the API in demo mode (no keys, no ComfyUI):
// the cloud makes each chosen take again at 2K as a version beside it, the assembly uses it once it is picked; and the
// route under public sign-up (guests and accounts get own-gpu-tool, as for every studio job).
// Your GPU's sizes regenerate with Open-H3 Regenerate, which is switched off for now (REGEN_OFFERED); these tests check
// them as they run once it is on. tests/regenerate-offered.test.ts checks that nothing offers them while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));
const dir = tempDir("fuobe-swap-sharpen-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_PUBLIC_SIGNUP;

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const projects = await import("@/app/api/swap-studio/projects/route");
const project = await import("@/app/api/swap-studio/projects/[id]/route");
const clips = await import("@/app/api/swap-studio/projects/[id]/clips/route");
const queue = await import("@/app/api/swap-studio/projects/[id]/queue/route");
const sharpen = await import("@/app/api/swap-studio/projects/[id]/sharpen/route");
const assemble = await import("@/app/api/swap-studio/projects/[id]/assemble/route");
const estimate = await import("@/app/api/swap-studio/projects/[id]/estimate/route");
const stop = await import("@/app/api/swap-studio/projects/[id]/stop/route");
const masks = await import("@/app/api/swap-studio/projects/[id]/masks/route");
const genjutsuEstimate = await import("@/app/api/genjutsu/estimate/route");

const req = (method: string, body?: unknown) => new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny MP4 header `seconds` long with one `width`×`height` video track: enough for the server's header read. */
function mp4(seconds: number, width: number, height: number): Buffer {
  const box = (type: string, ...body: Buffer[]) => {
    const data = Buffer.concat(body);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + data.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(0x10000, 40);
  tkhd.writeUInt32BE(0x10000, 56);
  tkhd.writeUInt32BE(width << 16, 76);
  tkhd.writeUInt32BE(height << 16, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(1000, 12);
  mdhd.writeUInt32BE(seconds * 1000, 16);
  const hdlr = Buffer.alloc(24);
  hdlr.write("vide", 8, "latin1");
  const trak = box("trak", box("tkhd", tkhd), box("mdia", box("mdhd", mdhd), box("hdlr", hdlr)));
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isomiso2mp41", "latin1")), box("moov", box("mvhd", mvhd), trak)]);
}

let clip = "";
let square = "";
let hero = "";
beforeAll(() => {
  setSetting("demoMode", "auto");
  clip = saveFile({ data: mp4(6, 1920, 1080), contentType: "video/mp4", source: "upload", name: "street.mp4" }).url;
  square = saveFile({ data: mp4(6, 2048, 2048), contentType: "video/mp4", source: "upload", name: "square.mp4" }).url;
  hero = saveFile({ data: encodePng({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 200) }), contentType: "image/png", source: "upload", name: "hero.png" }).url;
});

async function view(id: string): Promise<SwapProjectView> {
  const res = await project.GET(req("GET"), ctx(id) as never);
  expect(res.status).toBe(200);
  return res.json();
}
async function patch(id: string, edit: unknown): Promise<SwapProject> {
  const res = await project.PATCH(req("PATCH", edit), ctx(id) as never);
  if (res.status !== 200) throw new Error(`${res.status}: ${(await res.json()).error}`);
  return res.json();
}
async function post(route: { POST: (r: Request, c: never) => Promise<Response> }, id: string, body: unknown, status = 201) {
  const res = await route.POST(req("POST", body), ctx(id) as never);
  const out = await res.json();
  if (res.status !== status) throw new Error(`${res.status}: ${out.error}`);
  return out;
}
async function until(id: string, done: (v: SwapProjectView) => boolean, ms = 150_000): Promise<SwapProjectView> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await view(id);
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(Object.values(v.gens).map((g) => g.status))}`);
    await sleep(300);
  }
}

describe("Sharpen on the cloud (demo mode)", () => {
  let id = "";

  it("makes each chosen take again at 2K beside it, priced first; the assembly uses it once picked", async () => {
    id = (await post(projects, "", { name: "Street", engine: "cloud", character: { image: hero, description: "a chrome robot" } })).id;
    let p = await post(clips, id, { url: clip, name: "street.mp4" });
    let c = p.clips[0];
    expect(c.source).toMatchObject({ width: 1920, height: 1080 });
    const shot = c.shots[0];
    p = await patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { settings: { useAnchor: false } } });
    p = await patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "partition", frames: 144 } });
    const seg = p.clips[0].shots[0].segments![0];

    // Nothing chosen yet: Sharpen says so.
    await expect(post(sharpen, id, { clipId: c.id, tier: "2K" })).rejects.toThrow(/Choose a take for every swapped segment first/);
    await post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: seg.id, mode: "all" });
    let v = await until(id, (x) => x.project.clips[0].shots[0].segments!.every((g) => !!g.selectedTake && x.gens[g.takes[0].genId!]?.status === "succeeded"));
    const take = v.project.clips[0].shots[0].segments![0].takes[0];

    // The price: one 6 s take at 2K is 6 whole seconds at $0.1625 (a demo here, so it costs nothing to run).
    const est = await (await estimate.GET(req("GET"), ctx(id) as never)).json();
    expect(est.sharpen[c.id]).toMatchObject({ takes: 1, seconds: 6 });
    expect(Object.keys(est.sharpen[c.id].costUsd)).toEqual(["2K"]);

    // The cloud makes 2K or 4K; 4K adds nothing to a film joined at 1920 × 1080; 1080p isn't on fal.
    await expect(post(sharpen, id, { clipId: c.id, tier: "1080p" })).rejects.toThrow(/The cloud makes 2K or 4K/);
    p = await post(sharpen, id, { clipId: c.id, tier: "4K" });
    let t: SwapTake = p.clips[0].shots[0].segments![0].takes[0];
    expect(t.finish).toMatchObject({ engine: "cloud", asked: "4K", tier: "2K", use: false });
    const steps = t.finish!.stepIds!.map((s) => gens.getGeneration(s)!);
    expect(steps.map((g) => g.modelId)).toEqual(["trim-video", "fuobe-character-swap", "trim-video"]);
    const swap = steps[1].request;
    expect(swap.params).toMatchObject({ resolution: "2K", seed: take.seed, duration: 6, sourceDuration: 6 });
    expect(swap.prompt).toBe(gens.getGeneration(take.stepIds![1])!.request.prompt);
    expect(swap.loras?.[0]?.file).toMatch(/swap/);
    // Asked again while it is being made: nothing to do.
    await expect(post(sharpen, id, { clipId: c.id, tier: "2K" })).rejects.toThrow(/already has a 2K version/);

    v = await until(id, (x) => x.gens[x.project.clips[0].shots[0].segments![0].takes[0].finish!.genId!]?.status === "succeeded");
    t = v.project.clips[0].shots[0].segments![0].takes[0];
    c = v.project.clips[0];
    // Not picked: the assembly is the 768p take.
    let q = await post(assemble, id, { clipId: c.id });
    expect(q.clips[0].assembly.takes).toEqual([t.id]);
    const first = await until(id, (x) => ["succeeded", "failed"].includes(x.gens[x.project.clips[0].assembly!.genId!]?.status ?? ""));
    const failed = Object.entries(first.gens).filter(([, g]) => g.status === "failed");
    expect(failed.map(([gid, g]) => `${gens.getGeneration(gid)?.modelId}: ${g.error}`)).toEqual([]);
    // Picked after comparing: a new assembly with the 2K version in it.
    await patch(id, { type: "take", clipId: c.id, shotId: shot.id, segmentId: seg.id, takeId: t.id, finishUse: true });
    q = await post(assemble, id, { clipId: c.id });
    expect(q.clips[0].assembly.takes).toEqual([`${t.id}@${t.finish!.id}`]);
    const parts = q.clips[0].assembly.stepIds.map((s: string) => gens.getGeneration(s)!);
    // The take's piece is the 2K version scaled to the film (1920 × 1080: fal merge-videos' 512–2048 px).
    const scaled = parts.find((g: { modelId: string }) => g.modelId === "scale-video")!;
    expect(scaled.request.inputs?.video).toBe(v.gens[t.finish!.genId!].url);
    expect(scaled.request.params).toMatchObject({ extra: { width: 1920, height: 1080 } });
  });

  it("only a finished version can be picked, and Stop stops what is being made", async () => {
    const p = (await view(id)).project;
    const c = p.clips[0];
    const shot = c.shots[0];
    const seg = shot.segments![0];
    await expect(patch(id, { type: "take", clipId: c.id, shotId: shot.id, segmentId: seg.id, takeId: "take-nope", finishUse: true })).rejects.toThrow(/422/);
    const r = await post(stop, id, { kind: "finish", clipId: c.id }, 200);
    expect(r.id).toBe(id);
  });
});

describe("Sharpen on your GPU (demo mode)", () => {
  it("a version still being made keeps its take; Sharpen at another size stops it before replacing it", async () => {
    const id = (await post(projects, "", { name: "Square", engine: "open", character: { image: hero, description: "a knight" } })).id;
    let p: SwapProject = await post(clips, id, { url: square, name: "square.mp4" });
    const c = p.clips[0];
    const shot = c.shots[0];
    await until(id, (x) => !!x.project.clips[0].normalized?.url);
    p = await patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { settings: { useAnchor: false } } });
    p = await patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "partition", frames: 144 } });
    const seg = p.clips[0].shots[0].segments![0];
    p = await patch(id, { type: "segment", clipId: c.id, shotId: shot.id, segmentId: seg.id, patch: { anchorMode: "none" } });
    // Who to swap: a tracked mask, approved.
    p = await post(masks, id, { clipId: c.id, shotId: shot.id, kind: "track", frame: 0, points: [{ x: 1024, y: 1024, label: "positive" }] });
    const m = p.clips[0].shots[0].masks[0];
    await until(id, (x) => !!x.project.clips[0].shots[0].masks[0].pieces[0]?.url);
    await patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { approvedMask: m.id } });
    await post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: seg.id, mode: "all" });
    let v = await until(id, (x) => x.project.clips[0].shots[0].segments!.every((g) => !!g.selectedTake && x.gens[g.takes[0].genId!]?.status === "succeeded"));
    const take = v.project.clips[0].shots[0].segments![0].takes[0];
    const ref = { clipId: c.id, shotId: shot.id, segmentId: seg.id, takeId: take.id };

    // A 2048 square: 2K adds a little over 1080p (a 2048 × 1170 part is redrawn), and 1080p is the default; 4K adds nothing.
    const est = await (await estimate.GET(req("GET"), ctx(id) as never)).json();
    expect(Object.keys(est.sharpen[c.id].costUsd)).toEqual(["1080p", "2K"]);
    p = await post(sharpen, id, { clipId: c.id, tier: "1080p" });
    const first = p.clips[0].shots[0].segments![0].takes[0].finish!;
    expect(first).toMatchObject({ engine: "open", tier: "1080p" });
    const firstIds = [...first.stepIds!, first.genId!];
    expect(firstIds.map((g) => gens.getGeneration(g)!.modelId)).toEqual(expect.arrayContaining(["oss-h3-regenerate", "oss-composite-mask"]));

    // While it is being made, its take stays, and so does the shot's layout.
    await expect(patch(id, { type: "take", ...ref, remove: true })).rejects.toThrow(/sharper version is still being made/);
    await expect(patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "partition", frames: 72 } })).rejects.toThrow(/409/);

    // Sharpen again at 2K: the 1080p version still being made is stopped first, then replaced.
    p = await post(sharpen, id, { clipId: c.id, tier: "2K" });
    const second = p.clips[0].shots[0].segments![0].takes[0].finish!;
    expect(second).toMatchObject({ tier: "2K", asked: "2K" });
    expect(second.id).not.toBe(first.id);
    expect(firstIds.map((g) => gens.getGeneration(g)!.status).filter((st) => st === "queued" || st === "running")).toEqual([]);
    expect(gens.getGeneration(first.genId!)!.status).toBe("canceled");
    // The 2K version's regenerate is drawn at 1440p.
    expect(second.stepIds!.map((g) => gens.getGeneration(g)!).find((g) => g.modelId === "oss-h3-regenerate")!.request.params).toMatchObject({ resolution: "1440p" });

    // Stop reaches it; then the take can go.
    await post(stop, id, { kind: "finish", clipId: c.id }, 200);
    v = await until(id, (x) => !["queued", "running"].includes(x.gens[x.project.clips[0].shots[0].segments![0].takes[0].finish!.genId!]?.status ?? ""), 20_000);
    expect(v.gens[second.genId!].status).toBe("canceled");
    const after = await patch(id, { type: "take", ...ref, remove: true });
    expect(after.clips[0].shots[0].segments![0].takes.find((t) => t.id === take.id)).toBeUndefined();
  });
});

describe("Genjutsu's notes for a finishing size", () => {
  const est = async (body: unknown) => {
    const res = await genjutsuEstimate.POST(req("POST", body) as never);
    const out = await res.json();
    if (res.status !== 200) throw new Error(`${res.status}: ${out.error}`);
    return out as { notes: string[]; quality?: string };
  };
  const base = (engine: string, quality: string, over: Record<string, unknown> = {}) => ({
    engine,
    mode: "character",
    references: [hero],
    quality,
    source: { url: clip, name: "street.mp4", duration: 30, fps: 30, width: 3840, height: 2160, hasAudio: true },
    range: { start: 0, end: 10 },
    ...over,
  });

  it("your GPU names the clip's own size and the 2048 px join when it sharpens at a smaller size", async () => {
    const e = await est(base("open", "4K"));
    expect(e.notes).toContain("Your clip is 3840×2160, joined at 2048×1152 (up to 2048 px a side), and your character is redrawn in a 1964×1122 part of it, so it is sharpened at 2K");
    expect(e.notes.join(" ")).not.toMatch(/never above the clip's own size/);
  });

  it("the cloud's 4K over 15 s says its pieces are joined at up to 2048 px a side; a single piece doesn't", async () => {
    const long = await est(base("cloud", "4K", { range: { start: 0, end: 20 } }));
    expect(long.notes).toContain("A part over 15 s is made in pieces, and the pieces are joined at up to 2048 px a side");
    const short = await est(base("cloud", "4K"));
    expect(short.notes.join(" ")).not.toMatch(/joined at up to 2048/);
    const k2 = await est(base("cloud", "2K", { range: { start: 0, end: 20 } }));
    expect(k2.notes.join(" ")).not.toMatch(/joined at up to 2048/);
  });
});

describe("the route under public sign-up", () => {
  it("lets an account with its own GPU reach the route (a studio job, like Assemble); a guest signs up first", async () => {
    process.env.FUOBE_PASSWORD = "install password";
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    try {
      const auth = await import("@/server/auth");
      const { proxy } = await import("@/proxy");
      const access = await import("@/lib/guest-access");
      const account = auth.createAccount("sharpen@example.com", "long enough");
      const cookie = auth.createSession(account.id).value;
      auth.setAccountGpu(account.id, { url: "https://gpu.example" });
      const at = (url: string, c?: string) => new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: c ? { cookie: `${auth.SESSION_COOKIE}=${c}` } : {}, body: "{}" });
      // Character Swap Studio's jobs run on an account's own GPU or key (the route makes the account's checks, on its own
      // projects only: tests/account-swap-studio.test.ts).
      for (const p of ["/api/swap-studio/projects/swap-1/sharpen", "/api/swap-studio/projects/swap-1/assemble"]) {
        expect(proxy(at(p, cookie)).headers.get("x-middleware-next"), p).toBe("1");
        const r = proxy(at(p));
        expect(r.status, p).toBe(401);
        expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
      }
      // Genjutsu runs on an account's own GPU (its route makes the account's checks); a guest signs up first.
      expect(proxy(at("/api/genjutsu", cookie)).headers.get("x-middleware-next")).toBe("1");
      const guest = proxy(at("/api/genjutsu"));
      expect(guest.status).toBe(401);
      expect((await guest.json()).error).toBe(access.GUEST_RUN_MESSAGE);
      // Genjutsu's price check (2K included) stays open to visitors.
      expect(access.isPriceCheck("POST", "/api/genjutsu/estimate", "")).toBe(true);
      expect(proxy(at("/api/genjutsu/estimate")).headers.get("x-middleware-next")).toBe("1");
    } finally {
      delete process.env.FUOBE_PASSWORD;
      delete process.env.FUOBE_PUBLIC_SIGNUP;
    }
  });

  it("an account's composite through /api/generations reads only its own files", async () => {
    const auth = await import("@/server/auth");
    const { accountInputProblem } = await import("@/server/account-inputs");
    const a = auth.createAccount("composite@example.com", "long enough");
    const own = saveFile({ data: mp4(3, 1920, 1080), contentType: "video/mp4", source: "upload", name: "mine.mp4", accountId: a.id }).url;
    const request = (videos: string[], mask: string) => ({ inputs: { videos, mask }, params: { extra: { windowStart: 0, takeStart: 0, maskStart: 0 } } });
    expect(accountInputProblem(request([own, own, own], own), a.id)).toBeNull();
    // The owner's footage, or a link, is refused.
    expect(accountInputProblem(request([clip, own, own], own), a.id)).toMatchObject({ code: "input-not-yours" });
    expect(accountInputProblem(request([own, own, own], "https://x.example/m.mp4"), a.id)).toMatchObject({ code: "input-not-allowed" });
  });
});
