import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { tempDir } from "./helpers/temp-dir";

/**
 * Restore & colourise under the owner's public sign-up rules (docs/public-signup.md): its price
 * check is open to guests and accounts and priced for their own GPU, never a demo; an account's run goes to its own GPU
 * (a guest signs up first, an account without one connects one), while the prompt writer, which asks the
 * studio's own AI helpers, stays the owner's (own-gpu-tool); the owner's are unchanged. The GPU pre-flight board has its row, on graphs the requirement index knows.
 */

const dir = tempDir("fuobe-restore-signup-");
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
const estimate = await import("@/app/api/restore/estimate/route");
const { PromptSchema } = await import("@/server/restore");
const { planRestore } = await import("@/lib/catalog/restore");
const { STUDIO_ROWS, studioTool, toolFor } = await import("@/server/gpu/tools");
const { loadIndex } = await import("@/server/gpu/index-file");

const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

function req(url: string, init: { method?: string; cookie?: string } = {}) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  return new NextRequest(`http://localhost:3000${url}`, { method, headers, ...(method !== "GET" && method !== "HEAD" && { body: "{}" }) });
}

function call(url: string, body: unknown, cookie?: string) {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) },
    body: JSON.stringify(body),
  });
}

let n = 0;
const newAccount = () => auth.createAccount(`restore${++n}@example.com`, "long enough");
const RUNS = ["/api/restore", "/api/restore/prompt"];
const source = { url: "/api/files/uploads/old-film.mp4", name: "old-film.mp4", duration: 8, fps: 16, width: 640, height: 480 };

beforeAll(() => {
  auth.setPassword("install password");
  // The owner's own runs would be free demos: a visitor's price never is (src/server/visitor.ts).
  setSetting("demoMode", "on");
});
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
});

describe("the proxy: Restore & colourise as main treats a tool", () => {
  it("knows the estimate for a price check, and the run and the prompt writer for runs", () => {
    expect(access.isPriceCheck("POST", "/api/restore/estimate", "")).toBe(true);
    for (const p of RUNS) expect(access.isPriceCheck("POST", p, ""), p).toBe(false);
    expect(access.isPriceCheck("POST", "/api/restore", "?preview=1")).toBe(false);
  });

  it("lets guests and accounts open the page", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(newAccount().id).value;
    expect(passed(proxy(req("/video-tools/restore")))).toBe(true);
    expect(passed(proxy(req("/video-tools/restore", { cookie })))).toBe(true);
  });

  it("opens the price check to guests and accounts, the run to an account's own GPU; the writer stays the owner's", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const bare = auth.createSession(newAccount().id).value;
    const withGpu = newAccount();
    auth.setAccountGpu(withGpu.id, { url: "https://gpu.example" });
    const gpu = auth.createSession(withGpu.id).value;
    // The run: a guest signs up, an account with neither a GPU nor a key connects one, one with a GPU passes.
    const guest = proxy(req("/api/restore", { method: "POST" }));
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
    const none = proxy(req("/api/restore", { method: "POST", cookie: bare }));
    expect(none.status).toBe(403);
    expect(none.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect(passed(proxy(req("/api/restore", { method: "POST", cookie: gpu })))).toBe(true);
    for (const cookie of [undefined, bare, gpu]) {
      expect(passed(proxy(req("/api/restore/estimate", { method: "POST", cookie }))), String(cookie)).toBe(true);
      for (const p of ["/api/restore/prompt"]) {
        const r = proxy(req(p, { method: "POST", cookie }));
        expect(r.status, p).toBe(403);
        expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBeNull();
        expect(r.headers.get(access.GUEST_HEADER), p).toBeNull();
        expect(await r.json(), p).toEqual({ error: access.OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" });
      }
    }
  });

  it("keeps the owner's runs unchanged", () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const owner = auth.createSession().value;
    for (const p of [...RUNS, "/api/restore/estimate"]) expect(passed(proxy(req(p, { method: "POST", cookie: owner }))), p).toBe(true);
  });
});

describe("the estimate route: a visitor's price is its own GPU's", () => {
  it("prices a guest's and an account's restoration on their own GPU, never a demo; the owner's stays the install's", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const account = auth.createSession(newAccount().id).value;
    for (const [who, cookie] of [
      ["guest", undefined],
      ["account", account],
    ] as const) {
      const r = await estimate.POST(call("/api/restore/estimate", { engine: "open", source }, cookie));
      expect(r.status, who).toBe(200);
      expect(await r.json(), who).toMatchObject({ engine: "open", demo: false, costUsd: 0, pieces: 2, canvas: { width: 1440, height: 1088 } });
    }
    const owner = await estimate.POST(call("/api/restore/estimate", { engine: "open", source }, auth.createSession().value));
    expect(await owner.json()).toMatchObject({ demo: true, costUsd: 0 });
  });

  it("never tells a visitor whether the owner set a Hugging Face token, nor asks it to add one", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    setSetting("huggingfaceDownloadToken", "");
    const account = auth.createSession(newAccount().id).value;
    for (const [who, cookie] of [
      ["guest", undefined],
      ["account", account],
    ] as const) {
      const e = await (await estimate.POST(call("/api/restore/estimate", { engine: "open", source, refine: true }, cookie))).json();
      expect(e, who).not.toHaveProperty("loraReady");
      expect(e.notes.join(" "), who).not.toMatch(/gated on Hugging Face|Settings → LoRAs/);
    }
    // The owner, with no token and no copy, is told what to set up.
    const owner = await (await estimate.POST(call("/api/restore/estimate", { engine: "open", source }, auth.createSession().value))).json();
    expect(owner.loraReady).toBe(false);
    expect(owner.notes.join(" ")).toMatch(/gated on Hugging Face/);
  });
});

describe("the prompt writer's body stays under the sign-in proxy's 4 MB", () => {
  it("takes four frames at the largest it allows, and refuses a bigger one", () => {
    const frame = (chars: number) => `data:image/jpeg;base64,${"A".repeat(chars - "data:image/jpeg;base64,".length)}`;
    const biggest = { engine: "open", hint: "x".repeat(600), frames: Array.from({ length: 4 }, () => frame(900_000)) };
    expect(PromptSchema.safeParse(biggest).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(biggest))).toBeLessThan(4 * 2 ** 20);
    expect(PromptSchema.safeParse({ ...biggest, frames: [frame(900_001)] }).success).toBe(false);
    expect(PromptSchema.safeParse({ ...biggest, frames: [...biggest.frames, frame(100)] }).success).toBe(false);
  });
});

describe("the GPU pre-flight board", () => {
  it("has a Restore & colourise row on the tiled graph, the joins and the gated Restore IC-LoRA", () => {
    const idx = loadIndex();
    const row = STUDIO_ROWS.find((r) => r.href === "/video-tools/restore")!;
    expect(row).toMatchObject({ label: "Restore & colourise", group: "Video tools" });
    const t = studioTool(row)!;
    expect(t.ref).toBe("studio:/video-tools/restore");
    expect(t.workflows).toContain("video-restore-ltx25-tiled");
    for (const wf of t.workflows) expect(idx.workflows[wf], wf).toBeDefined();
    expect(t.loras).toEqual([expect.objectContaining({ file: "ltx-2.5-22b-ic-lora-restore-1.0.safetensors", download: "hf-gated" })]);
    expect(toolFor("studio:/video-tools/restore")?.workflows).toEqual(t.workflows);
    // The row checks the graphs a run uses: a multi-window GPU plan with its sound (windows, join, sound back).
    const plan = planRestore({ engine: "open", title: "R", prompt: "p", negative: "n", source: { url: "/api/files/a.mp4", duration: 12, frames: 192, fps: 16, width: 640, height: 480, hasAudio: true } });
    const used = new Map(plan.steps.map((s) => [`${s.request.modelId}|${s.request.op}`, { modelId: s.request.modelId, op: s.request.op! }]));
    expect(used.size).toBe(3);
    const planned = studioTool({ href: "/video-tools/restore", label: "x", group: "Video tools", steps: [...used.values()] })!;
    expect(new Set(t.workflows)).toEqual(new Set(planned.workflows));
    expect(t.workflows).toContain("video-concat-encoded");
    // The graph's node pack is pinned, so the board can say what to install.
    expect(Object.keys(idx.workflows["video-restore-ltx25-tiled"].packs)).toContain("ComfyUI-LTXVideo");
    expect(idx.packs["ComfyUI-LTXVideo"]).toMatchObject({ commit: "220e1d45aa0469f518e982102fca4dca92a61862" });
  });
});

describe("the page a visitor sees", () => {
  const page = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\s+/g, " ");

  it("is the GPU's: the open engine for a visitor, its upload asking for a GPU (no key runs it), and its price never 'Not available here'", () => {
    const tool = page("src/components/restore/restore-tool.tsx");
    expect(tool).toContain('const engine: Engine = visitor ? "open" : chosen;');
    expect(tool).toMatch(/<ClipDrop accept=\{RESTORE\.accept\} limits=\{LIMITS\} gpuOnly /);
    expect(tool).toContain("{costText(est, engine)}");
    expect(page("src/components/shorts/ui.tsx")).toContain("useAskBeforeUpload({ gpuOnly })");
    expect(page("src/components/shorts/ui.tsx")).not.toContain("Not available here");
  });
});
