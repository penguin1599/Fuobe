import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

/**
 * Edit speech on the server (nm10-speech-edit): POST /api/audio-tools tool "speech-edit" in demo mode, the open-engine
 * rule (Engine mode "Paid APIs only" refuses it), the public sign-up rules for its price check and run, Assist / MCP's
 * edit_speech, the ⋯ menu's link, the licence row and the GPU pre-flight board's row.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-speech-edit-server-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_PUBLIC_SIGNUP;
const auth = await import("@/server/auth");
const { proxy } = await import("@/proxy");
const { setSetting } = await import("@/server/settings");
const { saveFile } = await import("@/server/storage");
const gens = await import("@/server/generations");
const route = await import("@/app/api/audio-tools/route");
const { STUDIO_ROWS, studioOthers, studioTool } = await import("@/server/gpu/tools");
const { outputActions } = await import("@/lib/output-actions");
const { getModel } = await import("@/lib/catalog");
const { NODE_PACKS, licenceInfo } = await import("@/lib/licences");
const { handleMcp } = await import("@/server/mcp");

beforeAll(() => setSetting("demoMode", "on"));
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
  setSetting("engineMode", "both");
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function wav(name = "take.wav", accountId?: string, seconds = 9): string {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return saveFile({ data: b, contentType: "audio/wav", name, source: "upload", ...(accountId && { accountId }) }).url;
}

const CUES = [
  { start: 0.2, end: 2.4, text: "We open the new studio" },
  { start: 3, end: 4.8, text: "on Tuesday morning." },
  { start: 5.5, end: 8.6, text: "Everyone is welcome to come along." },
];
const body = (media: string, extra: Record<string, unknown> = {}) => ({ tool: "speech-edit", engine: "open", media, kind: "audio", name: "Take", cues: CUES, edited: [CUES[0].text, "on Thursday morning.", CUES[2].text], ...extra });
function call(url: string, b: unknown, cookie?: string) {
  return new Request(`http://localhost:3000${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) }, body: JSON.stringify(b) });
}

describe("POST /api/audio-tools speech-edit (demo mode)", () => {
  it("prices a word edit as free on your GPU and runs it into the Library as one track", async () => {
    const media = wav();
    const p = await (await route.POST(call("/api/audio-tools?preview=1", body(media)))).json();
    expect(p).toMatchObject({ steps: 1, costUsd: 0, demo: true });
    expect(p.summary).toMatch(/re-spoken by AuK in the same voice/);
    const res = await route.POST(call("/api/audio-tools", body(media)));
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.result).toMatchObject({ modelId: "oss-auk", op: "speech-edit", feature: "speech-edit" });
    expect(run.result.request.params.extra.speechWindows[0].instruction).toBe("Replace 'Tuesday' with 'Thursday'.");
    const deadline = Date.now() + 15_000;
    let g = gens.getGeneration(run.result.id)!;
    while (g.status !== "succeeded" && g.status !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      g = gens.getGeneration(run.result.id)!;
    }
    expect(g.status).toBe("succeeded");
    expect(g.outputs.filter((o) => o.kind === "audio")).toHaveLength(1);
  }, 30_000);

  it("prices an effect on a range, and says what's missing in words", async () => {
    const media = wav();
    const fx = await (await route.POST(call("/api/audio-tools?preview=1", body(media, { edited: undefined, range: { start: 0, end: 4.8 }, effect: { kind: "pitch", semitones: 2 } })))).json();
    expect(fx).toMatchObject({ steps: 1, costUsd: 0 });
    const same = await route.POST(call("/api/audio-tools?preview=1", body(media, { edited: CUES.map((c) => c.text) })));
    expect(same.status).toBe(422);
    expect((await same.json()).error).toMatch(/Nothing changed/);
    const odd = await route.POST(call("/api/audio-tools?preview=1", body(media, { edited: undefined, range: { start: 0, end: 4 }, effect: { kind: "pitch", semitones: 7 } })));
    expect(odd.status).toBe(400);
    expect((await odd.json()).error).toBe("Pick one of the offered settings for the effect");
    const none = await route.POST(call("/api/audio-tools?preview=1", { ...body(media), cues: [] }));
    expect((await none.json()).error).toBe("Transcribe the recording first, then edit its lines");
  });

  it("runs on your GPU only: the cloud engine and Paid APIs only say so", async () => {
    const media = wav();
    const cloud = await route.POST(call("/api/audio-tools?preview=1", body(media, { engine: "cloud" })));
    expect(cloud.status).toBe(422);
    expect((await cloud.json()).error).toMatch(/runs on your GPU \(open source\): AuK isn't hosted on fal or Replicate/);
    setSetting("engineMode", "cloud");
    const paid = await route.POST(call("/api/audio-tools?preview=1", body(media)));
    expect((await paid.json()).error).toMatch(/set to paid cloud APIs only/);
  });

  it("a video gets its new sound back on the picture", async () => {
    const media = wav("clip.wav");
    const p = await (await route.POST(call("/api/audio-tools?preview=1", body(media, { kind: "video" })))).json();
    expect(p.steps).toBe(2);
    expect(p.notes.join(" ")).toMatch(/Lipsync/);
  });
});

describe("public sign-up", () => {
  const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";
  const req = (url: string, cookie?: string) =>
    new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: cookie ? { cookie: `${auth.SESSION_COOKIE}=${cookie}` } : {}, body: "{}" });
  let n = 0;
  const newAccount = () => auth.createAccount(`speech${++n}@example.com`, "long enough");

  it("prices a visitor's edit on its own GPU, never a demo, and only of its own file; an account without a GPU is asked to connect one", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    auth.setPassword("install password");
    const who = newAccount();
    const cookie = auth.createSession(who.id).value;
    // Through the sign-in proxy: the price check passes; the run goes to its own GPU, and with none it's asked to connect one.
    expect(passed(proxy(req("/api/audio-tools?preview=1", cookie)))).toBe(true);
    const run = proxy(req("/api/audio-tools", cookie));
    expect(run.status).toBe(403);
    expect((await run.json()).code).toBe("connect-gpu");
    // The owner's file answers a guest and an account as one that's gone.
    const owners = wav("owners.wav");
    for (const c of [undefined, cookie]) {
      const r = await route.POST(call("/api/audio-tools?preview=1", body(owners), c));
      expect(r.status).toBe(422);
      expect((await r.json()).error).toBe("That recording is gone — add it again");
    }
    const mine = await route.POST(call("/api/audio-tools?preview=1", body(wav("mine.wav", who.id)), cookie));
    expect(await mine.json()).toMatchObject({ steps: 1, costUsd: 0, demo: false });
  });
});

describe("Assist and MCP's edit_speech", () => {
  const rpc = (method: string, params?: unknown) => handleMcp({ jsonrpc: "2.0", id: 1, method, params });
  const args = (media: string) => ({ media, kind: "audio", transcript: CUES, changes: [{ line: 1, text: "on Thursday morning." }] });

  it("is listed with its schema, priced with estimate_job and runs as a pipeline in demo mode", async () => {
    const list = (await rpc("tools/list")) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] }; description: string }[] } };
    const t = list.result.tools.find((x) => x.name === "edit_speech")!;
    expect(t).toBeTruthy();
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(["changes", "effect", "kind", "media", "quality", "range", "transcript"]);
    expect(t.inputSchema.required.sort()).toEqual(["kind", "media", "transcript"]);
    expect(t.description).toMatch(/estimate_job/);
    const media = wav();
    const est = (await rpc("tools/call", { name: "estimate_job", arguments: { tool: "edit_speech", arguments: args(media) } })) as { result: { structuredContent: { jobs: { modelId: string; op: string; error?: string }[] } } };
    expect(est.result.structuredContent.jobs).toMatchObject([{ modelId: "oss-auk", op: "speech-edit" }]);
    expect(est.result.structuredContent.jobs[0].error).toBeUndefined();
    const out = (await rpc("tools/call", { name: "edit_speech", arguments: args(media) })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(false);
    expect(JSON.parse(out.result.content[0].text).steps).toHaveLength(1);
    // An effect with a value AuK doesn't take is refused on the card.
    const bad = (await rpc("tools/call", { name: "estimate_job", arguments: { tool: "edit_speech", arguments: { media, kind: "audio", transcript: CUES, effect: { kind: "pitch", semitones: 9 }, range: { start: 0, end: 4 } } } })) as {
      result: { structuredContent: { jobs: { error?: string }[] } };
    };
    expect(bad.result.structuredContent.jobs[0].error).toMatch(/semitones/);
  });
});

describe("where Edit speech shows up", () => {
  it("in the ⋯ menu of speech results, never in Paid APIs only, and not on music", () => {
    const g = (op: string, kind: "audio" | "video", feature = "studio") =>
      ({ id: "g", op, feature, status: "succeeded", favorite: false, engine: "open", request: { modelId: "m", op }, outputs: [{ url: "/api/files/x.wav", kind }] }) as never;
    const has = (x: ReturnType<typeof outputActions>) => x.find((a) => a.id === "edit-speech");
    expect(has(outputActions(g("tts", "audio"), 0))?.href).toBe(`/audio/edit-speech?audio=${encodeURIComponent("/api/files/x.wav")}`);
    expect(has(outputActions(g("music", "audio"), 0))).toBeUndefined();
    expect(has(outputActions(g("tts", "audio"), 0, { engineMode: "cloud" }))).toBeUndefined();
    expect(has(outputActions(g("lipsync", "video"), 0))?.href).toMatch(/^\/audio\/edit-speech\?video=/);
    // A guest or an account (public sign-up) gets it too: an account runs it on its own GPU.
    expect(has(outputActions(g("tts", "audio"), 0, { visitor: true }))?.href).toMatch(/^\/audio\/edit-speech\?audio=/);
    expect(has(outputActions(g("lipsync", "video"), 0, { visitor: true }))?.href).toMatch(/^\/audio\/edit-speech\?video=/);
  });

  it("has its model, licence and a row on the GPU pre-flight board", () => {
    const m = getModel("oss-auk")!;
    expect(m.routes.map((r) => [r.op, r.endpoint])).toEqual([
      ["speech-edit", "speech-edit-auk"],
      ["tts", "speech-tts-auk"],
    ]);
    expect(NODE_PACKS.find((p) => p.name === "ComfyUI-AuK")?.licence).toMatchObject({ name: "MIT", class: "commercial" });
    // The encoder's licence links to its own model's licence, not another Qwen model's.
    expect(licenceInfo("AuK code and weights MIT (Tencent); its Qwen2.5-Omni-3B encoder Qwen Research License (NON-COMMERCIAL)")).toMatchObject({
      name: "Qwen Research License",
      class: "non-commercial",
      url: "https://huggingface.co/Qwen/Qwen2.5-Omni-3B/blob/main/LICENSE",
    });
    expect(licenceInfo("Qwen Research License (NON-COMMERCIAL)").url).toMatch(/Qwen-Image-2\.1/);
    const row = STUDIO_ROWS.find((r) => r.href === "/audio/edit-speech")!;
    expect(row).toMatchObject({ label: "Edit speech", group: "Audio" });
    expect(studioTool(row)!.workflows).toEqual(expect.arrayContaining(["speech-edit-auk"]));
    // AuK's text to speech is one of Voice's other open models, on the board with its own graph, and its picker line names its languages.
    const voice = STUDIO_ROWS.find((r) => r.href === "/audio/speech")!;
    expect(studioOthers(voice).find((t) => t.workflows.includes("speech-tts-auk"))).toBeTruthy();
    expect(m.tagline).toMatch(/English and Chinese/);
  });
});
