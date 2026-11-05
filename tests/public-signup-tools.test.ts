import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";

/**
 * PR #15's tools under the owner's public sign-up rules (docs/public-signup.md): Split soundtrack (and its Export mix),
 * MOSS-Image, Cinema's fly path and the turnaround. Guests and accounts get what main gives the same kind of route:
 * price checks open and priced for their own GPU, runs refused (sign up, Connect your GPU, or own-gpu-tool), the
 * owner's library closed, and the GPU pre-flight board lists the tools like main's studios.
 */

const dir = tempDir("fuobe-signup-tools-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_PUBLIC_SIGNUP;
delete process.env.FUOBE_ALLOWED_ORIGINS;

const auth = await import("@/server/auth");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { setSetting } = await import("@/server/settings");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const { createElement } = await import("@/server/elements");
const turnaround = await import("@/app/api/turnaround/route");
const turnaroundEstimate = await import("@/app/api/turnaround/estimate/route");
const flyAround = await import("@/app/api/fly-around/route");
const audioTools = await import("@/app/api/audio-tools/route");
const { STUDIO_ROWS, studioOthers, studioTool, toolFor } = await import("@/server/gpu/tools");
const { loadIndex } = await import("@/server/gpu/index-file");

const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

function req(url: string, init: { method?: string; cookie?: string } = {}) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  return new NextRequest(`http://localhost:3000${url}`, { method, headers, ...(method !== "GET" && method !== "HEAD" && { body: "{}" }) });
}

/** A route call as the proxy hands it on: JSON body, the visitor's session cookie (none for a guest). */
function call(url: string, body: unknown, cookie?: string) {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) },
    body: JSON.stringify(body),
  });
}

const png = (name: string) => saveFile({ data: encodePng({ width: 18, height: 32, data: Buffer.alloc(18 * 32 * 4, 128) }), contentType: "image/png", name, source: "upload" }).url;

/** A two-second 16-bit stereo WAV, saved as the owner's upload. */
function wav(name = "film.wav", accountId?: string): string {
  const rate = 8000;
  const n = rate * 2;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  return saveFile({ data: buf, contentType: "audio/wav", name, source: "upload", ...(accountId && { accountId }) }).url;
}

let n = 0;
const newAccount = () => auth.createAccount(`tools${++n}@example.com`, "long enough");

beforeAll(() => {
  auth.setPassword("install password");
  // The owner's own runs would be free demos: a visitor's price never is (src/server/visitor.ts).
  setSetting("demoMode", "on");
  setSetting("enhanceProvider", "none");
});
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
});

describe("the proxy: PR #15's routes as main treats their kind", () => {
  it("lets guests and accounts open the tools' pages", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(newAccount().id).value;
    for (const p of ["/audio/split", "/audio/clean", "/apps/app-clean-up-voice", "/samples/clean-voice/clean.m4a", "/video-tools/remove-dialogue", "/character-sheet", "/cinema", "/image", "/connect"]) {
      expect(passed(proxy(req(p))), `guest ${p}`).toBe(true);
      expect(passed(proxy(req(p, { cookie }))), `account ${p}`).toBe(true);
    }
  });

  it("knows the turnaround's price checks from its run", () => {
    expect(access.isPriceCheck("POST", "/api/turnaround/estimate", "")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/turnaround", "?preview=1")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/audio-tools", "?preview=1")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/turnaround", "")).toBe(false);
    expect(access.isPriceCheck("POST", "/api/turnaround", "?preview=true")).toBe(false);
    expect(access.isPriceCheck("POST", "/api/audio-tools/export", "?preview=1")).toBe(false);
    expect(access.isPriceCheck("GET", "/api/turnaround/estimate", "")).toBe(false);
  });

  it("opens the price checks to guests, gives their tool runs the account's own-gpu-tool, and their saves the sign-up prompt", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    for (const p of ["/api/turnaround/estimate", "/api/turnaround?preview=1", "/api/audio-tools?preview=1"]) expect(passed(proxy(req(p, { method: "POST" }))), p).toBe(true);
    // Signing up wouldn't run these (an account's own GPU or key doesn't either): the account's answer, not the card.
    for (const p of ["/api/marketing/runs", "/api/layers/l1/jobs", "/api/layout/plan"]) {
      const r = proxy(req(p, { method: "POST" }));
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.GUEST_HEADER), p).toBeNull();
      expect(await r.json(), p).toEqual({ error: access.OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" });
    }
    // The studios' runs, the tools an account runs on its own GPU (Shorts, Turnaround video, Katana, the Audio tools), an
    // upload and a save to the library: signing up is the next step there.
    for (const p of ["/api/generations", "/api/shorts/sessions", "/api/turnaround", "/api/katana", "/api/audio-tools", "/api/media/probe", "/api/audio-tools/export?offset=0", "/api/canvases"]) {
      const r = proxy(req(p, { method: "POST" }));
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error, p).toMatch(/free account/);
    }
  });

  it("gives an account the price checks, Connect your GPU for the Audio tools, and its own Export mix", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(newAccount().id).value;
    for (const p of ["/api/turnaround/estimate", "/api/turnaround?preview=1", "/api/audio-tools?preview=1"]) expect(passed(proxy(req(p, { method: "POST", cookie }))), p).toBe(true);
    // The Audio tools run on its own GPU or key (tests/account-audio.test.ts): with neither, it's asked to connect one.
    const tools = proxy(req("/api/audio-tools", { method: "POST", cookie }));
    expect(tools.status).toBe(403);
    expect(tools.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await tools.json()).code).toBe("connect-gpu");
    // The mix is kept as the account's own run (the route checks its room, run rate and the studio's checks), whatever the GPU.
    expect(passed(proxy(req("/api/audio-tools/export?offset=0", { method: "POST", cookie })))).toBe(true);
  });

  it("runs an account's MOSS-Image and the Audio tools on its own GPU; the other tools say own-gpu-tool", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const a = newAccount();
    const cookie = auth.createSession(a.id).value;
    auth.setAccountGpu(a.id, { url: "https://gpu.example" });
    expect(passed(proxy(req("/api/generations", { method: "POST", cookie })))).toBe(true);
    // Turnaround video and the Audio tools run on its own GPU too (tests/account-video-tools.test.ts, account-audio.test.ts).
    expect(passed(proxy(req("/api/turnaround", { method: "POST", cookie })))).toBe(true);
    expect(passed(proxy(req("/api/audio-tools", { method: "POST", cookie })))).toBe(true);
    for (const p of ["/api/layout/plan"]) {
      const r = proxy(req(p, { method: "POST", cookie }));
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBeNull();
      expect((await r.json()).code, p).toBe("own-gpu-tool");
    }
    expect(passed(proxy(req("/api/audio-tools/export?offset=0", { method: "POST", cookie })))).toBe(true);
    // Cinema Studio's takes run on its own GPU too (tests/account-cinema.test.ts).
    expect(passed(proxy(req("/api/cinema/projects/p1/generate", { method: "POST", cookie })))).toBe(true);
  });

  it("keeps the owner's runs and saves unchanged", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const owner = auth.createSession().value;
    for (const p of ["/api/turnaround", "/api/turnaround/estimate", "/api/audio-tools", "/api/audio-tools/export?offset=0"]) expect(passed(proxy(req(p, { method: "POST", cookie: owner }))), p).toBe(true);
  });
});

describe("Fly around under the sign-up rules", () => {
  it("opens its price check to guests and accounts; an account runs it on its own GPU and a guest signs up first", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    expect(access.isPriceCheck("POST", "/api/fly-around", "?preview=1")).toBe(true);
    expect(access.isPriceCheck("POST", "/api/fly-around", "")).toBe(false);
    const a = newAccount();
    auth.setAccountGpu(a.id, { url: "https://gpu.example" });
    const cookie = auth.createSession(a.id).value;
    for (const c of [undefined, cookie]) expect(passed(proxy(req("/api/fly-around?preview=1", { method: "POST", cookie: c })))).toBe(true);
    // Its run goes to the route, which runs it on the account's own GPU or key (tests/account-video-tools.test.ts).
    expect(passed(proxy(req("/api/fly-around", { method: "POST", cookie })))).toBe(true);
    const guest = proxy(req("/api/fly-around", { method: "POST" }));
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
    expect(passed(proxy(req("/api/fly-around", { method: "POST", cookie: auth.createSession().value })))).toBe(true);
  });

  it("prices a visitor's fly-around for its own GPU, never a demo", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const image = png("fly.png");
    const account = auth.createSession(newAccount().id).value;
    for (const cookie of [undefined, account]) {
      const r = await flyAround.POST(call("/api/fly-around?preview=1", { engine: "open", image, orbit: { degrees: 90, direction: "cw" } }, cookie));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ engine: "open", demo: false, costUsd: 0, steps: 2 });
    }
  });
});

describe("the routes: a visitor's price is its own GPU's, and the owner's characters stay hidden", () => {
  it("prices a guest's and an account's turnaround on their own GPU, never a demo; the owner's stays the install's", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const views = { front: png("front.png"), back: png("back.png") };
    const owner = auth.createSession().value;
    const account = auth.createSession(newAccount().id).value;
    for (const [who, cookie] of [
      ["guest", undefined],
      ["account", account],
    ] as const) {
      const est = await turnaroundEstimate.POST(call("/api/turnaround/estimate", { engine: "open", views }, cookie));
      expect(est.status, who).toBe(200);
      expect(await est.json(), who).toMatchObject({ route: "frames", demo: false, costUsd: 0, modelId: "oss-wan22-14b" });
      const preview = await turnaround.POST(call("/api/turnaround?preview=1", { engine: "open", views }, cookie));
      expect(preview.status, who).toBe(200);
      expect(await preview.json(), who).toMatchObject({ route: "frames", fills: ["right", "left"], demo: false });
    }
    // The owner, with Demo mode on: a free demo, as before.
    expect(await (await turnaroundEstimate.POST(call("/api/turnaround/estimate", { engine: "open", views }, owner))).json()).toMatchObject({ demo: true, costUsd: 0 });
  });

  it("never tells a visitor whether one of the owner's characters exists", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const views = { front: png("ada-front.png"), back: png("ada-back.png") };
    const el = createElement({ name: "Ada", kind: "character", references: [views.front] });
    const owner = auth.createSession().value;
    const account = auth.createSession(newAccount().id).value;
    for (const cookie of [undefined, account]) {
      for (const [route, url] of [
        [turnaroundEstimate, "/api/turnaround/estimate"],
        [turnaround, "/api/turnaround?preview=1"],
      ] as const) {
        const real = await route.POST(call(url, { engine: "open", views, elementId: el.id, consent: true }, cookie));
        const made = await route.POST(call(url, { engine: "open", views, elementId: "no-such-id", consent: true }, cookie));
        expect([real.status, made.status], url).toEqual([404, 404]);
        expect((await real.json()).error).toBe("Character not found");
      }
    }
    const mine = await turnaroundEstimate.POST(call("/api/turnaround/estimate", { engine: "open", views, elementId: el.id, consent: true }, owner));
    expect(mine.status).toBe(200);
    expect((await turnaroundEstimate.POST(call("/api/turnaround/estimate", { engine: "open", views, elementId: "no-such-id" }, owner))).status).toBe(404);
  });

  it("prices a visitor's Split soundtrack on its own GPU, never a demo, and only of its own file", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const who = newAccount();
    const cookie = auth.createSession(who.id).value;
    const owners = wav();
    const body = (media: string) => ({ tool: "split", engine: "open", media, kind: "audio", name: "Film" });
    // A price check reads only the asker's own files (storage.ts storedMedia): the owner's file answers a guest, who owns
    // none, and an account as a file that is gone, saying nothing of what it holds.
    for (const c of [undefined, cookie]) {
      const r = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), c));
      expect(r.status).toBe(422);
      expect((await r.json()).error).toBe("That audio file is gone — add it again");
    }
    const account = await audioTools.POST(call("/api/audio-tools?preview=1", body(wav("mine.wav", who.id)), cookie));
    expect(await account.json()).toMatchObject({ steps: 1, costUsd: 0, demo: false, channels: 2 });
    const owner = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), auth.createSession().value));
    expect(await owner.json()).toMatchObject({ steps: 1, demo: true, channels: 2 });
  });

  it("prices a visitor's Clean up voice on its own GPU without asking any GPU, never a demo, and only of its own file", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const who = newAccount();
    const cookie = auth.createSession(who.id).value;
    const owners = wav();
    const body = (media: string) => ({ tool: "clean", engine: "open", media, kind: "audio", name: "Take" });
    for (const c of [undefined, cookie]) {
      const r = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), c));
      expect(r.status).toBe(422);
      expect((await r.json()).error).toBe("That audio file is gone — add it again");
    }
    const asked = vi.spyOn(globalThis, "fetch");
    try {
      const account = await audioTools.POST(call("/api/audio-tools?preview=1", body(wav("mine.wav", who.id)), cookie));
      const p = await account.json();
      expect(p).toMatchObject({ steps: 1, costUsd: 0, demo: false, channels: 2 });
      // No device known for it yet: a CPU's rate and estimate, and no files listed (the run checks them on its GPU).
      expect(p.reuse).toEqual({ rate: 24000, seconds: expect.any(Number) });
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
    }
  });
});

describe("Clean up dialogue (DBS D5) on /api/audio-tools", () => {
  it("prices a visitor's run on its own GPU, never a demo, only of its own file; a run without a GPU or key asks to connect one", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const who = newAccount();
    const cookie = auth.createSession(who.id).value;
    const owners = wav();
    const body = (media: string, engine = "open") => ({ tool: "clean-dialogue", engine, media, kind: "audio", name: "Take" });
    for (const c of [undefined, cookie]) {
      const r = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), c));
      expect(r.status).toBe(422);
      expect((await r.json()).error).toBe("That audio file is gone — add it again");
    }
    const account = await audioTools.POST(call("/api/audio-tools?preview=1", body(wav("mine.wav", who.id)), cookie));
    expect(await account.json()).toMatchObject({ steps: 1, costUsd: 0, demo: false, channels: 2 });
    const owner = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), auth.createSession().value));
    expect(await owner.json()).toMatchObject({ steps: 1, demo: true });
    const run = proxy(req("/api/audio-tools", { method: "POST", cookie }));
    expect(run.status).toBe(403);
    expect((await run.json()).code).toBe("connect-gpu");
  });
});

describe("Remove dialogue (DBS D2) on /api/audio-tools", () => {
  it("prices a visitor's run on its own GPU, never a demo, and only of its own video; a run without a GPU or key asks to connect one", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const who = newAccount();
    const cookie = auth.createSession(who.id).value;
    const clip = (accountId?: string) => saveFile({ data: Buffer.from("a clip the header reader doesn't know"), contentType: "video/mp4", name: "talk.mp4", source: "upload", ...(accountId && { accountId }) }).url;
    const owners = clip();
    const body = (video: string) => ({ tool: "remove-dialogue", engine: "open", video, name: "Talk", sourceDuration: 12 });
    for (const c of [undefined, cookie]) {
      const r = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), c));
      expect(r.status).toBe(422);
      expect((await r.json()).error).toBe("That video is gone — add it again");
    }
    const account = await audioTools.POST(call("/api/audio-tools?preview=1", body(clip(who.id)), cookie));
    expect(await account.json()).toMatchObject({ steps: 2, costUsd: 0, demo: false, length: 12 });
    const owner = await audioTools.POST(call("/api/audio-tools?preview=1", body(owners), auth.createSession().value));
    expect(await owner.json()).toMatchObject({ steps: 2, demo: true });
    const run = proxy(req("/api/audio-tools", { method: "POST", cookie }));
    expect(run.status).toBe(403);
    expect((await run.json()).code).toBe("connect-gpu");
  });
});

describe("Split soundtrack's, Remove dialogue's and Edit speech's pages are open to guests and accounts", () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  it("still say 'Not available here' only where a price function is asked to", async () => {
    const { openToolPrice } = await import("@/lib/av/split");
    expect(openToolPrice({ demo: false })).toBe("Free");
    expect(openToolPrice({ demo: true })).toBe("Placeholder · free");
    expect(openToolPrice(undefined)).toBe("…");
    for (const p of [{ demo: false }, { demo: true }, undefined]) expect(openToolPrice(p, true)).toBe("Not available here");
  });

  it("carry no 'isn't available here' note, and ask a guest to sign up (an account to connect its GPU) before an upload", () => {
    for (const file of ["src/components/audio-tools/split-tool.tsx", "src/components/audio-tools/remove-dialogue-tool.tsx", "src/components/audio-tools/speech-edit-tool.tsx", "src/components/dub/dub-studio.tsx"]) {
      const page = src(file).replace(/\s+/g, " ");
      expect(page, file).not.toContain("SelfHostNote");
      expect(page, file).not.toContain("useLikelyVisitor");
      expect(page, file).not.toContain("selfHostedOnly");
      expect(page, file).not.toMatch(/isn(&apos;|')t available here/);
      expect(page, file).not.toContain("openToolPrice(p, true)");
    }
    for (const file of ["src/components/audio-tools/split-tool.tsx", "src/components/audio-tools/remove-dialogue-tool.tsx", "src/components/audio-tools/speech-edit-tool.tsx"]) {
      expect(src(file).replace(/\s+/g, " "), file).toMatch(/if \(!f \|\| disabled \|\| askFirst\(\)\) return;/);
    }
    // Edit speech needs its own GPU (AuK, 24 GB): its own-setup label, and its runs ask for the GPU first.
    const speech = src("src/components/audio-tools/speech-edit-tool.tsx").replace(/\s+/g, " ");
    expect(speech).toContain('const OWN_SETUP = "audio:edit-speech";');
    expect(speech).toContain("useAskBeforeUpload({ gpuOnly: true })");
    // The label the page read (ownSetupsNow: none once AuK's graph is validated), else the static entry.
    expect(speech).toContain("const item = setup === undefined ? OWN_SETUP : setup;");
    expect(speech.match(/press\(item\)/g)?.length).toBe(2);
    expect(src("src/components/studio/mode-switch-studio.tsx")).toContain('<SpeechEditTool setup={ownSetupsNow(["audio:edit-speech"])["audio:edit-speech"]} />');
  });
});

describe("the GPU pre-flight board lists PR #15's tools like main's studios", () => {
  const idx = loadIndex();
  const row = (href: string) => STUDIO_ROWS.find((r) => r.href === href)!;

  it("has a row for Split soundtrack, the fly path and the turnaround, each on graphs the requirement index knows", () => {
    const want: Record<string, { label: string; group: string; workflows: string[]; loras?: string[] }> = {
      "/audio/split": { label: "Split soundtrack", group: "Audio", workflows: ["separate-soundtrack-dbs"] },
      "/video-tools/remove-dialogue": { label: "Remove dialogue", group: "Video tools", workflows: ["separate-soundtrack-dbs", "video-mux-audio"] },
      "/audio/clean": { label: "Clean up voice", group: "Audio", workflows: ["voice-clean-reuse"] },
      "/cinema": { label: "Fly path", group: "Video", workflows: ["wan21-i2v-uni3c-path"] },
      "/cinema?blockout=1": { label: "Blockout to film", group: "Video", workflows: ["video-blockout-wan22-fun-vace", "qwen-image-edit-2511-multi", "video-segment-resample", "frame-extract", "video-concat-encoded"] },
      "/character-sheet": { label: "Turnaround", group: "Video", workflows: ["wan22-flf2v-14b", "qwen-image-edit-2511-multi"], loras: ["qwen-image-edit-2511-multiple-angles-lora.safetensors"] },
    };
    for (const [href, w] of Object.entries(want)) {
      const r = row(href);
      expect(r, href).toBeDefined();
      expect({ label: r.label, group: r.group }).toEqual({ label: w.label, group: w.group });
      const t = studioTool(r)!;
      expect(t, href).not.toBeNull();
      expect(t.local, href).toBeUndefined();
      expect(t.ref).toBe(`studio:${href}`);
      for (const wf of w.workflows) expect(t.workflows, href).toContain(wf);
      for (const wf of t.workflows) expect(idx.workflows[wf], `${href}: ${wf}`).toBeDefined();
      for (const l of w.loras ?? []) expect(t.loras.map((x) => x.file), href).toContain(l);
      // The plan route takes the row's ref.
      expect(toolFor(`studio:${href}`)?.workflows).toEqual(t.workflows);
    }
    // The turnaround's film joins its quarter turns.
    expect(studioTool(row("/character-sheet"))!.workflows.some((w) => /^video-concat-\d+$/.test(w))).toBe(true);
    expect(new Set(STUDIO_ROWS.map((r) => r.href)).size).toBe(STUDIO_ROWS.length);
  });

  it("lists MOSS-Image among the Image studio's other tools, on its own graph", () => {
    const moss = studioOthers(row("/image")).find((t) => t.ref === "model:oss-moss-image#t2i");
    expect(moss).toBeDefined();
    expect(moss!.workflows).toEqual(["moss-image-t2i"]);
    expect(idx.workflows["moss-image-t2i"]).toBeDefined();
    expect(toolFor("model:oss-moss-image#t2i")?.local).toBeUndefined();
  });

  it("needs ComfyUI-DBS and its weights for Split soundtrack", () => {
    const w = idx.workflows["separate-soundtrack-dbs"];
    expect(Object.keys(w.packs)).toEqual(["ComfyUI-DBS"]);
    expect(idx.packs["ComfyUI-DBS"]).toMatchObject({ commit: "f656e53434b5485c148a2866fbd6ddc6b6152ed6", folders: ["dbs"] });
    expect(Object.keys(idx.files).filter((k) => k.startsWith("dbs/")).sort()).toEqual([
      "dbs/DBS-BSRNN-DnR/config.json",
      "dbs/DBS-BSRNN-DnR/model.safetensors",
      "dbs/DBS-TIGER-DnR/config.json",
      "dbs/DBS-TIGER-DnR/model.safetensors",
    ]);
  });
});
