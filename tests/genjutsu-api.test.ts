import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { CLOUD_NO_LORA } from "@/lib/catalog/character-swap";
import { CLOUD_CLICK_PROBLEM } from "@/lib/catalog/genjutsu";
import type { Generation } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });

// /api/genjutsu end to end in demo mode (no keys, no ComfyUI): each mode on both engines becomes one pipeline of
// ordinary generations, which the mock provider runs through; estimates with keys set price the real routes.
const dir = tempDir("fuobe-genjutsu-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const { db } = await import("@/server/db");
const createRoute = await import("@/app/api/genjutsu/route");
const estimateRoute = await import("@/app/api/genjutsu/estimate/route");
const describeRoute = await import("@/app/api/genjutsu/describe/route");
const transcribeRoute = await import("@/app/api/genjutsu/transcribe/route");
const { changeAccess } = await import("@/server/model-access");

const json = (body?: unknown) => new Request("http://x/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let clip = "";
let hero = "";
let mask = "";
beforeAll(() => {
  setSetting("demoMode", "auto");
  // A 12 s, 16 fps, 72×128 clip with a sound track.
  clip = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "dance.mp4" }).url;
  const px = (w: number, h: number, on: (x: number, y: number) => boolean) => {
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4;
        data.fill(on(x, y) ? 255 : 0, at, at + 3);
        data[at + 3] = 255;
      }
    return encodePng({ width: w, height: h, data });
  };
  hero = saveFile({ data: px(64, 64, () => true), contentType: "image/png", source: "upload", name: "hero.png" }).url;
  mask = saveFile({ data: px(72, 128, (x, y) => x >= 20 && x < 50 && y >= 80 && y < 110), contentType: "image/png", source: "upload", name: "mask.png" }).url;
});

async function settle(id: string, ms = 90_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const batchOf = (id: string) => {
  const b = (db().prepare("SELECT batch_id FROM generations WHERE id = ?").get(id) as { batch_id: string }).batch_id;
  return db().prepare("SELECT id, model_id, op, feature FROM generations WHERE batch_id = ? ORDER BY created_at, id").all(b) as { id: string; model_id: string; op: string; feature: string }[];
};

const src = { duration: 12, fps: 16, width: 1280, height: 720, hasAudio: true };
const body = (over: Record<string, unknown> = {}) => ({ engine: "cloud", mode: "motion", references: [hero], source: { url: clip, name: "dance.mp4" }, ...over });

describe("Genjutsu: estimates", () => {
  it("no keys: the Original's Lite tier, run as a demo; no Higgsfield anywhere", async () => {
    const res = await estimateRoute.POST(json(body({ source: { url: clip, ...src } })));
    expect(res.status).toBe(200);
    const e = await res.json();
    expect(e).toMatchObject({ modelId: "fuobe-genjutsu-motion-lite", source: "original", tier: "standard", quality: "480p", pieces: 1, seconds: 12, demo: true });
    expect(e.higgsfield).toBeUndefined();
  });

  describe("with keys (estimates submit nothing, so the prices are the routes' own)", () => {
    beforeAll(() => setSetting("falKey", "fal-test-key"));
    afterAll(() => setSetting("falKey", ""));

    it("motion: Lite is Wan 2.2 Animate at 480p turbo; Quality: High is the full model at its own price per resolution", async () => {
      // 12 s at 16 fps = 192 frames = 12 video seconds: $0.04 each, then the sound put back.
      const lite = await (await estimateRoute.POST(json(body({ source: { url: clip, ...src } })))).json();
      expect(lite).toMatchObject({ modelId: "fuobe-genjutsu-motion-lite", tier: "standard", quality: "480p", pieces: 1, steps: 2, demo: false, providers: ["fal"] });
      expect(lite.costUsd).toBeGreaterThanOrEqual(0.48);
      expect(lite.costUsd).toBeLessThan(0.49);
      const high = await (await estimateRoute.POST(json(body({ source: { url: clip, ...src }, tier: "high", quality: "720p" })))).json();
      expect(high).toMatchObject({ modelId: "fuobe-genjutsu-motion", tier: "high", quality: "720p" });
      expect(high.costUsd).toBeGreaterThanOrEqual(0.96);
      expect(high.costUsd).toBeLessThan(0.97);
      // fal bills frames ÷ 16: a 30 fps clip costs 1.9× its length, and says so.
      const fast = await (await estimateRoute.POST(json(body({ source: { url: clip, ...src, fps: 30 } })))).json();
      expect(fast.notes.join(" ")).toMatch(/fal bills this clip's 30 fps as 1\.9× its length/);
    });

    it("Kling O3 swap at its edit price; the hosted VACE per 16-frame second", async () => {
      const kling = await (await estimateRoute.POST(json(body({ mode: "swap", modelId: "kling-o3", subject: "the red car", source: { url: clip, ...src, duration: 10 }, range: { start: 0, end: 10 } })))).json();
      expect(kling).toMatchObject({ modelId: "kling-o3", source: "partner", pieces: 1 });
      expect(kling.costUsd).toBeCloseTo(1.68, 3);
      expect(kling.notes.join(" ")).toMatch(/keeps your clip's size/);
      const vace = await (await estimateRoute.POST(json(body({ mode: "insert", target: "paint", mask: "/api/files/m.png", quality: "480p", source: { url: clip, ...src }, range: { start: 0, end: 10 } })))).json();
      // 160 frames at 16 fps → one piece of 157 frames, billed as 157 / 16 s at $0.05, then the sound put back.
      expect(vace).toMatchObject({ modelId: "wan-22-vace-inpaint", source: "open", pieces: 1, quality: "480p" });
      expect(vace.costUsd).toBeGreaterThanOrEqual((157 / 16) * 0.05);
      expect(vace.costUsd).toBeLessThan((157 / 16) * 0.05 + 0.01);
    });

    it("Character swap on fal: H3 with the swap LoRA per second, the first frame on its own price (or said when billed by tokens), the limits", async () => {
      const part = { source: { url: clip, ...src }, mode: "character", range: { start: 2, end: 9 } };
      const sun = await (await estimateRoute.POST(json(body(part)))).json();
      // 7 s at 768p: $0.075 a second; Sunburst's first frame is billed by tokens and left out, in words.
      expect(sun).toMatchObject({ modelId: "fuobe-character-swap", source: "original", quality: "768p", pieces: 1, anchors: 1, demo: false });
      expect(sun.costUsd).toBeGreaterThanOrEqual(0.525);
      expect(sun.costUsd).toBeLessThan(0.535);
      expect(sun.notes.join(" ")).toMatch(/billed by tokens .* isn't in the price/);
      expect(sun.notes.join(" ")).not.toMatch(/licen[cs]e/i);
      expect(sun.limits).toContain("One continuous shot: a hard cut breaks the swap");
      expect(sun.gpu).toBeUndefined();
      const nbp = await (await estimateRoute.POST(json(body({ ...part, character: { anchorModel: "nano-banana-pro" } })))).json();
      expect(nbp.costUsd).toBeCloseTo(sun.costUsd + 0.15, 3);
      // No first frame, 480p: $0.0625 a second.
      const bare = await (await estimateRoute.POST(json(body({ ...part, quality: "480p", character: { anchor: false } })))).json();
      expect(bare).toMatchObject({ anchors: 0, quality: "480p" });
      expect(bare.costUsd).toBeGreaterThanOrEqual(0.4375);
      expect(bare.costUsd).toBeLessThan(0.445);
      // MiniMax's own Recast, a partner: $0.30 a second at 768p.
      const recast = await (await estimateRoute.POST(json(body({ ...part, modelId: "h3-max-recast", range: { start: 2, end: 12 } })))).json();
      expect(recast).toMatchObject({ modelId: "h3-max-recast", source: "partner" });
      expect(recast.costUsd).toBeCloseTo(3, 2);
    });
  });

  it("Character swap on the open engine: free on your GPU, the windows, the GPU it was tested on, and no licence line", async () => {
    const e = await (await estimateRoute.POST(json(body({ engine: "open", mode: "character", source: { url: clip, ...src }, range: { start: 2, end: 9 } })))).json();
    expect(e).toMatchObject({ modelId: "fuobe-character-swap", source: "original", costUsd: 0, anchors: 1, gpu: { weightsGb: 46.33 } });
    expect(e.notes.join(" ")).toMatch(/2 windows of up to 124 frames at 24 fps, each continuing from the 18 frames before it/);
    expect(e.notes.join(" ")).not.toMatch(/licen[cs]e|GPL/i);
    expect(e.notes.join(" ")).toMatch(/Qwen-Image 2.1 first puts your character into the part's first frame/);
  });

  it("a clip run as windows says how it is joined, with no test status in the notes", async () => {
    const e = await (await estimateRoute.POST(json(body({ engine: "open", mode: "swap", subject: "the skateboard", source: { url: clip, ...src } })))).json();
    const said = e.notes.join(" ");
    expect(said).toMatch(/runs as 3 windows, joined with the clip's own sound/);
    expect(said).not.toMatch(/tested|validat|install-comfyui|scripts\//i);
  });

  describe("key mixes: a run is all real or all a demo, so a missing key is said before anything is paid for", () => {
    const say = async (b: Record<string, unknown>, route: { POST: (r: Request) => Promise<Response> } = estimateRoute) => {
      const res = await route.POST(json(b));
      const out = await res.json();
      expect(res.status, JSON.stringify(out)).toBe(422);
      return out.error as string;
    };
    afterAll(() => {
      setSetting("replicateToken", "");
      setSetting("falKey", "");
      setSetting("demoMode", "auto");
    });

    it("only a Replicate token: P-Video Replace runs the whole clip; a part needs a cut on fal", async () => {
      setSetting("replicateToken", "r8_test");
      const whole = await (await estimateRoute.POST(json(body({ mode: "character", modelId: "p-video-replace", source: { url: clip, ...src } })))).json();
      expect(whole).toMatchObject({ modelId: "p-video-replace", source: "partner", steps: 1, demo: false, providers: ["replicate"] });
      expect(await say(body({ mode: "character", modelId: "p-video-replace", source: { url: clip, ...src }, range: { start: 0, end: 10 } }))).toBe("Cutting the clip runs on fal.ai — add a fal.ai key in Settings → Paid API configuration");
      // Starting it is refused the same way, and nothing is made.
      const before = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
      expect(await say(body({ mode: "character", modelId: "p-video-replace", source: { url: clip }, range: { start: 0, end: 10 } }), createRoute)).toMatch(/^Cutting the clip runs on fal\.ai/);
      expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(before);
      setSetting("replicateToken", "");
    });

    it("demo mode off and no keys: the key it needs, in words", async () => {
      setSetting("demoMode", "off");
      expect(await say(body({ source: { url: clip, ...src } }))).toBe("Fuobe Genjutsu Lite · Motion runs on fal.ai, and putting the sound back runs on fal.ai — add a fal.ai key in Settings → Paid API configuration");
      setSetting("demoMode", "auto");
    });
  });

  it("blockers come back in words", async () => {
    const say = async (b: Record<string, unknown>) => {
      const res = await estimateRoute.POST(json(b));
      expect(res.status).toBe(422);
      return (await res.json()).error as string;
    };
    expect(await say(body({ references: [], source: { url: clip, ...src } }))).toBe("Add a picture of your character");
    expect(await say(body({ source: { url: clip, ...src }, range: { start: 0, end: 3 } }))).toMatch(/between 4 and 30 seconds/);
    // Painting on your GPU is Scene edit's (the owner sees it before it opens to everyone).
    expect(await say(body({ mode: "swap", target: "paint", engine: "open", source: { url: clip, ...src } }))).toBe("Paint over what changes");
    expect(await say(body({ mode: "swap", modelId: "kling-o3", source: { url: clip, ...src, duration: 10 }, range: { start: 0, end: 10 } }))).toMatch(/Say what to swap/);
    expect(await say(body({ mode: "restyle", references: [], source: { url: clip, ...src } }))).toBe("Pick a look");
    // Character swap: a part of 5–15 s, a click only on the open engine.
    expect(await say(body({ mode: "character", source: { url: clip, ...src }, range: { start: 0, end: 4.5 } }))).toMatch(/Pick a part of 5–15 seconds/);
    expect(await say(body({ mode: "character", target: "click", source: { url: clip, ...src }, range: { start: 0, end: 6 } }))).toBe(CLOUD_CLICK_PROBLEM);
    expect(await say(body({ engine: "open", mode: "character", target: "click", source: { url: clip, ...src }, range: { start: 0, end: 6 } }))).toBe("Click the person to swap on the first frame");
    // fal's H3 route needs a swap LoRA; the pack refuses a history as long as the window.
    expect(await say(body({ mode: "character", source: { url: clip, ...src }, range: { start: 0, end: 6 }, character: { lora: "none" } }))).toBe(CLOUD_NO_LORA);
    expect(await say(body({ engine: "open", mode: "character", source: { url: clip, ...src }, range: { start: 0, end: 6 }, character: { windowFrames: 22, historyFrames: 35 } }))).toBe(
      "History (35 frames) must be shorter than the window (22 frames)",
    );
    setSetting("engineMode", "open");
    expect(await say(body({ source: { url: clip, ...src } }))).toMatch(/open-source models only/);
    setSetting("engineMode", "both");
  });
});

describe("Character swap and Settings → Models & licences", () => {
  afterAll(() => changeAccess([{ kind: "reset" }]));
  const estimate = async (b: Record<string, unknown>) => {
    const res = await estimateRoute.POST(json(body({ mode: "character", source: { url: clip, ...src }, range: { start: 0, end: 6 }, ...b })));
    const out = await res.json();
    return { status: res.status, ...out } as { status: number; error?: string; notes: string[]; anchors?: number };
  };

  it("a first-frame model switched off gives way to the next one that is on, else no first frame", async () => {
    changeAccess([{ kind: "model", id: "gpt-image-2-5-sunburst", on: false }]);
    const next = await estimate({});
    expect(next.status).toBe(200);
    expect(next.notes).toContain("GPT Image 2.5 Sunburst is switched off in Settings → Models & licences: Nano Banana Pro makes the first frame");
    expect(next.anchors).toBe(1);
    changeAccess([{ kind: "model", id: "nano-banana-pro", on: false }]);
    const none = await estimate({});
    expect(none.notes).toContain("The first-frame models are switched off in Settings → Models & licences: the swap runs without a first frame");
    expect(none.anchors).toBe(0);
    changeAccess([{ kind: "reset" }]);
  });

  it("the swap LoRA switched off: H3 alone on your GPU; refused on fal, which needs one", async () => {
    changeAccess([{ kind: "lora", id: "h3_character_swap_v1.5.safetensors", on: false }]);
    const open = await estimate({ engine: "open" });
    expect(open.status).toBe(200);
    expect(open.notes).toContain("The swap LoRA is switched off in Settings → Models & licences: H3 runs with the Turbo LoRA alone");
    const cloud = await estimate({});
    expect(cloud.status).toBe(422);
    expect(cloud.error).toMatch(/V1\.5 \(recommended\)\) is switched off in Settings → Models & licences, and fal's H3 route needs one/);
    // The other release is on: picking it runs.
    expect((await estimate({ character: { lora: "v1" } })).status).toBe(200);
    changeAccess([{ kind: "lora", id: "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", on: false }]);
    expect((await estimate({ engine: "open", character: { lora: "v1" } })).error).toMatch(/Turbo LoRA is switched off/);
    changeAccess([{ kind: "reset" }]);
  });
});

describe("Character swap helpers: Describe my character and the clip's words", () => {
  let server: http.Server;
  let seen: { images?: string[]; system?: string } = {};
  beforeAll(async () => {
    // A stand-in Ollama with a vision model: it answers /api/chat with a description.
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = JSON.parse(raw || "{}") as { messages?: { role: string; content: string; images?: string[] }[] };
        seen = { images: b.messages?.find((m) => m.role === "user")?.images, system: b.messages?.find((m) => m.role === "system")?.content };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: { content: '"A tall knight in silver armour with a red cape."' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    setSetting("ollamaUrl", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  });
  afterAll(async () => {
    setSetting("ollamaUrl", "http://127.0.0.1:9");
    await new Promise((r) => server.close(r));
  });

  it("describes the character from their picture with the site's text model on the cloud engine (Ollama sees the picture)", async () => {
    const res = await describeRoute.POST(json({ engine: "cloud", image: hero }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ description: "a tall knight in silver armour with a red cape" });
    expect(seen.images).toHaveLength(1);
    expect(seen.system).toMatch(/who they are and what they wear/);
  });

  it("says why it can't: demo mode, a switched-off text model, a picture that isn't one", async () => {
    setSetting("demoMode", "on");
    expect(await (await describeRoute.POST(json({ engine: "cloud", image: hero }))).json()).toMatchObject({ error: expect.stringMatching(/needs a text model/) });
    setSetting("demoMode", "auto");
    changeAccess([{ kind: "model", id: "text-llm", on: false }]);
    expect(await (await describeRoute.POST(json({ engine: "cloud", image: hero }))).json()).toMatchObject({ error: expect.stringMatching(/text model is switched off/) });
    changeAccess([{ kind: "reset" }]);
    expect((await describeRoute.POST(json({ engine: "cloud", image: clip }))).status).toBe(422);
    expect((await describeRoute.POST(json({ engine: "open", image: clip }))).status).toBe(422);
    expect((await describeRoute.POST(json({ engine: "open", image: "https://example.com/x.png" }))).status).toBe(400);
  });

  it("on the open engine the GPU describer writes it; with no GPU to run it, it says so instead of a made-up answer", async () => {
    const res = await describeRoute.POST(json({ engine: "open", image: hero }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/needs your GPU/) });
    changeAccess([{ kind: "model", id: "oss-character-describe", on: false }]);
    expect(await (await describeRoute.POST(json({ engine: "open", image: hero }))).json()).toMatchObject({ error: expect.stringMatching(/switched off/) });
    changeAccess([{ kind: "reset" }]);
  });

  it("transcribes the clip once, as a Genjutsu step, on the engine's transcriber (timed lines for any part)", async () => {
    const res = await transcribeRoute.POST(json({ engine: "cloud", source: { url: clip, duration: 12 } }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as { id: string; modelId: string };
    expect(out.modelId).toBe("scribe-v2");
    const g = await settle(out.id);
    expect(g).toMatchObject({ status: "succeeded", feature: "genjutsu-step", modelId: "scribe-v2" });
    const text = g.outputs.find((o) => o.kind === "text")!;
    expect(Array.isArray(text.meta?.cues)).toBe(true);
    const open = (await (await transcribeRoute.POST(json({ engine: "open", source: { url: clip } }))).json()) as { modelId: string };
    expect(open.modelId).toBe("oss-qwen3-asr");
  });
});

describe("Genjutsu: runs (demo)", () => {
  const run = async (b: Record<string, unknown>) => {
    const res = await createRoute.POST(json(b));
    const out = await res.json();
    expect(res.status, out.error).toBe(201);
    return out as { final: Generation; items: Generation[] };
  };

  it("cloud motion transfer on the Original: one call and the sound, the finished video under feature genjutsu", async () => {
    const { final, items } = await run(body({ prompt: "a knight in silver armour" }));
    expect(final.feature).toBe("genjutsu");
    expect(items.filter((g) => g.feature === "genjutsu")).toHaveLength(1);
    const rows = batchOf(final.id);
    // Wan 2.2 Animate takes the whole 12 s selection in one call; the sound goes back on after.
    expect(rows.filter((r) => r.op === "motion-transfer").map((r) => r.model_id)).toEqual(["fuobe-genjutsu-motion-lite"]);
    expect(rows.some((r) => r.op === "mux")).toBe(true);
    expect((await settle(final.id)).status).toBe("succeeded");
  });

  it("a repeated requestId gets the first run", async () => {
    const b = body({ requestId: "genjutsu-nonce-1" });
    const a = await run(b);
    const again = await run(b);
    expect(again.final.id).toBe(a.final.id);
  });

  it("open object swap by name: VACE windows from the upload, joined under the sound", async () => {
    const { final } = await run(body({ engine: "open", mode: "swap", subject: "the skateboard", references: [hero, hero] }));
    const rows = batchOf(final.id);
    // 192 frames at 16 fps → 3 windows of ≤81.
    expect(rows.filter((r) => r.op === "video-swap").map((r) => r.model_id)).toEqual(["fuobe-genjutsu-swap-lite", "fuobe-genjutsu-swap-lite", "fuobe-genjutsu-swap-lite"]);
    const swap = gens.getGeneration(rows.find((r) => r.op === "video-swap")!.id)!;
    expect(swap.request.params?.extra).toEqual({ maskPrompt: "the skateboard" });
    expect(swap.request.inputs?.images).toEqual([hero]);
    expect((await settle(final.id)).status).toBe("succeeded");
  });

  it("cloud swap by paint on one hosted VACE piece: the paint itself, no track", async () => {
    const { final } = await run(body({ mode: "swap", modelId: "wan-22-vace-inpaint", target: "paint", mask, range: { start: 0, end: 12 } }));
    const rows = batchOf(final.id);
    expect(rows.some((r) => r.model_id === "sam-3-1-video-mask")).toBe(false);
    // 12 s at 16 fps is one hosted VACE piece (≤241 frames): the paint itself, no track.
    expect(rows.filter((r) => r.op === "video-swap").map((r) => r.model_id)).toEqual(["wan-22-vace-inpaint"]);
    expect((await settle(final.id)).status).toBe("succeeded");
  });

  it("insert on the open engine and restyle on a Fuobe look run through", async () => {
    const ins = await run(body({ engine: "open", mode: "insert", target: "paint", mask, prompt: "a lamp on the table", range: { start: 0, end: 5 } }));
    expect(batchOf(ins.final.id).filter((r) => r.op === "video-insert").length).toBe(1);
    expect((await settle(ins.final.id)).status).toBe("succeeded");
    const look = await run(body({ mode: "restyle", references: [], look: { kind: "preset", id: "shorts-claymation" } }));
    const rows = batchOf(look.final.id);
    expect(rows.filter((r) => r.op === "v2v").every((r) => r.feature === "genjutsu-step")).toBe(true);
    expect(rows.filter((r) => r.feature === "genjutsu")).toHaveLength(1);
    expect((await settle(look.final.id)).status).toBe("succeeded");
  });

  it("Character swap on fal: the part cut, its first frame, the anchor, H3 with the swap LoRA, the sound put back", async () => {
    const { final } = await run(body({ mode: "character", range: { start: 2, end: 9 }, seed: 9, character: { who: "rightmost" } }));
    const rows = batchOf(final.id);
    // The part and the sound's part cut, the first frame, the anchor, the swap, the sound put back.
    expect(rows.map((r) => `${r.model_id}:${r.op}`).sort()).toEqual(
      ["trim-video:trim", "trim-video:trim", "extract-frame:frame", "gpt-image-2-5-sunburst:edit", "fuobe-character-swap:video-swap", "merge-audio-video:mux"].sort(),
    );
    const swapRow = rows.find((r) => r.op === "video-swap")!;
    expect(swapRow.model_id).toBe("fuobe-character-swap");
    expect((await settle(final.id)).status).toBe("succeeded");
    const swap = gens.getGeneration(swapRow.id)!;
    expect(swap.request.loras).toEqual([expect.objectContaining({ file: "h3_character_swap_v1.5.safetensors" })]);
    expect(swap.request.params).toMatchObject({ duration: 7, resolution: "768p", seed: 9 });
    expect(swap.request.prompt).toMatch(/^Replace the person on the right in Video 1 with the character in Image 1\./);
    // The character first, then the anchor frame made from the part's first frame.
    const anchor = gens.getGeneration(rows.find((r) => r.model_id === "gpt-image-2-5-sunburst")!.id)!;
    expect(swap.request.inputs?.images).toEqual([hero, anchor.outputs[0].url]);
  });

  it("Character swap on fal of a silent clip: silent too (H3's own soundtrack replaced with the clip's silence)", async () => {
    const silent = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-silent.webm")), contentType: "video/webm", source: "upload", name: "silent.webm" }).url;
    const { final } = await run(body({ mode: "character", source: { url: silent, name: "silent.webm" }, range: { start: 0, end: 5 }, character: { anchor: false } }));
    expect(final).toMatchObject({ modelId: "merge-audio-video", op: "mux", feature: "genjutsu" });
    // The silent track is a real WAV the run wrote, as long as the part.
    const audio = final.request.inputs?.audio ?? "";
    expect(audio).toMatch(/^\/api\/files\//);
    expect((await settle(final.id)).status).toBe("succeeded");
    const rows = batchOf(final.id);
    expect(rows.map((r) => `${r.model_id}:${r.op}`)).toEqual(expect.arrayContaining(["fuobe-character-swap:video-swap", "merge-audio-video:mux"]));
    expect(rows.filter((r) => r.feature === "genjutsu")).toHaveLength(1);
  });

  it("Character swap on the open engine: the first frame, the anchor on Qwen-Image 2.1, one H3 job on the upload", async () => {
    const { final } = await run(body({ engine: "open", mode: "character", range: { start: 2, end: 9 }, character: { who: "index", index: 1, subject: "the drummer", lora: "v1" } }));
    const rows = batchOf(final.id);
    expect(rows.map((r) => r.model_id).sort()).toEqual(["fuobe-character-swap", "oss-extract-frame", "oss-qwen-image-21"]);
    expect(final.modelId).toBe("fuobe-character-swap");
    expect(final.request.params).toMatchObject({ startTime: 2, endTime: 9, resolution: "768p", extra: { selection: "index", subjectIndex: 1, maskPrompt: "the drummer", lora: "v1" } });
    expect((await settle(final.id)).status).toBe("succeeded");
  });
});
