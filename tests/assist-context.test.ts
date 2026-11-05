import { beforeAll, describe, expect, it, vi } from "vitest";
import { claudeStream } from "./fixtures/claude-sse";
import type Anthropic from "@anthropic-ai/sdk";
import type { AssistItem } from "@/lib/assist";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 60_000 });
const dir = tempDir("fuobe-assist-ctx-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const agent = await import("@/server/assist/agent");
const tools = await import("@/server/assist/tools");
const studio = await import("@/server/assist/studio-tools");
const { changeAccess } = await import("@/server/model-access");
const memory = await import("@/server/assist/memory");
const projects = await import("@/server/assist/projects");
const { handleMcp } = await import("@/server/mcp");
const { db } = await import("@/server/db");
const { memoryCardLine, planRunnable } = await import("@/lib/assist");

type Msg = Anthropic.Beta.BetaMessage;
type Block = Anthropic.Beta.BetaContentBlock;
type Param = Anthropic.Beta.BetaMessageParam;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Block;
const reply = (content: Block[], stop: Anthropic.Beta.BetaStopReason, extra: Partial<Msg> = {}) => ({ content, stop_reason: stop, stop_details: null, ...extra }) as Msg;

/** A model that answers from a script and records each request. */
function scripted(...turns: Msg[]) {
  const seen: { system: { stable: string; turn: string }; messages: Param[] }[] = [];
  const call: import("@/server/assist/agent").ModelCall = async ({ system, messages }) => {
    seen.push({ system: structuredClone(system), messages: structuredClone(messages) });
    const next = turns.shift();
    if (!next) throw new Error("script ran out");
    return next;
  };
  return { call, seen };
}
const history = (id: string) => JSON.parse((db().prepare("SELECT messages_json FROM assist_threads WHERE id = ?").get(id) as { messages_json: string }).messages_json) as Param[];
const sysText = (m: Param) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""));

beforeAll(() => setSetting("demoMode", "auto"));

describe("a chat's context", () => {
  it("freezes the system prompt at the first call and appends changes as one Context update", async () => {
    memory.addMemory({ text: "Prefers vertical 9:16", category: "Preference" });
    const t = agent.createThread({ engine: "cloud", agent: "offline" });
    agent.addMessage(t.id, "Hello");
    const m = scripted(reply([text("Hi!")], "end_turn"), reply([text("Noted.")], "end_turn"), reply([text("Again.")], "end_turn"));
    await agent.run(t.id, m.call);
    const first = m.seen[0].system.turn;
    expect(first).toContain("[Preference] Prefers vertical 9:16");
    expect(first).toContain("/product-photoshoot — Product Photographer");
    expect(first).toMatch(/Ask-first is on/);
    expect(m.seen[0].system.stable).toMatch(/load_skill/);
    // Something changes: a new memory and auto-run.
    memory.addMemory({ text: "Brand colour is teal", category: "Convention" });
    await agent.updateThread(t.id, { autoApprove: true });
    agent.addMessage(t.id, "Next");
    await agent.run(t.id, m.call);
    expect(m.seen[1].system).toEqual(m.seen[0].system);
    const last = m.seen[1].messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(sysText(last)).toMatch(/^Context update/);
    expect(sysText(last)).toContain("Brand colour is teal");
    expect(sysText(last)).toContain("Auto-run is on");
    expect(sysText(last)).not.toContain("Prefers vertical 9:16");
    // It stays in the history (append-only), right before the reply it led to; nothing new next time.
    const h = history(t.id);
    expect(h.map((x) => x.role)).toEqual(["user", "assistant", "user", "system", "assistant"]);
    agent.addMessage(t.id, "Once more");
    await agent.run(t.id, m.call);
    expect(m.seen[2].messages.at(-1)!.role).toBe("user");
    expect(m.seen[2].messages.slice(0, 5)).toEqual(h);
  });

  it("doesn't commit an update the model refused to answer", async () => {
    const t = agent.createThread({ engine: "cloud", agent: "offline" });
    agent.addMessage(t.id, "Hi");
    await agent.run(t.id, scripted(reply([text("Hello")], "end_turn")).call);
    memory.addMemory({ text: "Likes film grain", category: "Style" });
    agent.addMessage(t.id, "Something");
    const m = scripted(reply([], "refusal", { stop_details: { type: "refusal", category: null, explanation: "No." } as never }), reply([text("ok")], "end_turn"));
    await agent.run(t.id, m.call);
    expect(history(t.id).some((x) => x.role === "system")).toBe(false);
    agent.addMessage(t.id, "Try again");
    await agent.run(t.id, m.call);
    expect(sysText(m.seen[1].messages.at(-1)!)).toContain("Likes film grain");
  });

  it("loads a skill named with /name before the first call, and shows it on the message", async () => {
    const t = agent.createThread({ engine: "cloud", agent: "offline" });
    const th = agent.addMessage(t.id, "/product-photoshoot a matte black perfume bottle");
    expect(th.skills).toEqual(["product-photoshoot"]);
    expect(th.items.at(-1)).toMatchObject({ role: "user", text: "a matte black perfume bottle", skills: ["product-photoshoot"] });
    expect(th.title).toBe("a matte black perfume bottle");
    const m = scripted(reply([text("Shooting it.")], "end_turn"));
    await agent.run(t.id, m.call);
    expect(m.seen[0].system.turn).toContain("### /product-photoshoot — Product Photographer");
    expect(sysText(m.seen[0].messages[0])).toBe("a matte black perfume bottle");
    // Only "/katana" plus files: the model still gets words to act on.
    const k = agent.createThread({ engine: "cloud", agent: "offline" });
    agent.addMessage(k.id, "/katana", ["/api/files/uploads/x.mp4"]);
    expect(sysText(history(k.id)[0])).toMatch(/^Use the Katana skill with the attached files\./);
  });

  it("load_skill adds the skill's instructions as a system message right after its result", async () => {
    const t = agent.createThread({ engine: "cloud", agent: "offline" });
    agent.addMessage(t.id, "Make me a thumbnail");
    const m = scripted(reply([use("toolu_ls", "load_skill", { name: "thumbnail-generation" })], "tool_use"), reply([text("Following it.")], "end_turn"));
    await agent.run(t.id, m.call);
    const second = m.seen[1].messages;
    expect(second.at(-2)!.role).toBe("user");
    expect(JSON.stringify(second.at(-2)!.content)).toMatch(/Loaded \/thumbnail-generation/);
    expect(second.at(-1)!.role).toBe("system");
    expect(sysText(second.at(-1)!)).toContain("### /thumbnail-generation — Thumbnail Generator");
    const v = agent.getThread(t.id)!;
    expect(v.thread.skills).toEqual(["thumbnail-generation"]);
    expect(v.thread.items.find((i) => i.role === "tool")).toMatchObject({ text: "Using the Thumbnail Generator skill", href: "/assist/skills?skill=thumbnail-generation" });
  });

  it("asks before remembering in ask-first mode, then saves the memory where the chat lives", async () => {
    const p = projects.createProject({ name: "Remember project" });
    const t = agent.createThread({ engine: "cloud", agent: "offline", projectId: p.id });
    agent.addMessage(t.id, "Our logo is always bottom right");
    const m = scripted(reply([use("toolu_r", "remember", { text: "Logo always bottom right.", category: "Convention" })], "tool_use"), reply([text("Got it.")], "end_turn"));
    await agent.run(t.id, m.call);
    let v = agent.getThread(t.id)!;
    expect(v.thread.status).toBe("waiting");
    const card = () => v.thread.items.find((i) => i.role === "approval") as Extract<AssistItem, { role: "approval" }>;
    expect(card()).toMatchObject({ summary: "Remember this?", status: "pending", jobs: [{ tool: "remember", op: "memory", prompt: "Logo always bottom right.", note: "This project" }] });
    // The card's line doesn't say it's saved before the person says yes.
    expect(memoryCardLine(card().status)).toBe("Saves to memory for future chats");
    expect(memory.listMemories({ scope: "project", projectId: p.id })).toHaveLength(0);
    await agent.answerApproval(t.id, true);
    await agent.run(t.id, m.call);
    v = agent.getThread(t.id)!;
    expect(memory.listMemories({ scope: "project", projectId: p.id }).map((x) => [x.text, x.source])).toEqual([["Logo always bottom right.", "agent"]]);
    expect(v.thread.items.some((i) => i.role === "tool" && /Remembered/.test(i.text))).toBe(true);
    expect(card().status).toBe("approved");
    expect(memoryCardLine(card().status)).toBe("Saved to memory for future chats");
  });

  it("a memory declined with Not now isn't saved, and its card says so", async () => {
    const t = agent.createThread({ engine: "cloud", agent: "offline" });
    agent.addMessage(t.id, "Remember that captions are always yellow");
    const m = scripted(reply([use("toolu_n", "remember", { text: "Captions are always yellow.", category: "Style" })], "tool_use"), reply([text("Okay.")], "end_turn"));
    await agent.run(t.id, m.call);
    await agent.answerApproval(t.id, false);
    await agent.run(t.id, m.call);
    const card = agent.getThread(t.id)!.thread.items.find((i) => i.role === "approval") as Extract<AssistItem, { role: "approval" }>;
    expect(card.status).toBe("declined");
    expect(memoryCardLine(card.status)).toBe("Not saved to memory");
    expect(memory.listMemories({ scope: "all" }).some((x) => x.text === "Captions are always yellow.")).toBe(false);
  });

  it("gives project chats the instructions and sources, and read_source the full text", async () => {
    const p = projects.createProject({ name: "Launch", instructions: "Always pastel. Always 9:16.", skills: ["product-photoshoot", "thumbnail-generation"] });
    const note = await projects.addSource(p.id, { kind: "text", title: "Brief", text: `${"Context. ".repeat(60)}The drop is on Friday.` });
    const t = agent.createThread({ engine: "cloud", agent: "offline", projectId: p.id });
    agent.addMessage(t.id, "Plan the shoot");
    const m = scripted(reply([use("toolu_s", "read_source", { id: note.id })], "tool_use"), reply([text("Planned.")], "end_turn"));
    await agent.run(t.id, m.call);
    const ctx = m.seen[0].system.turn;
    expect(ctx).toContain("This chat is in the project “Launch”");
    expect(ctx).toContain("Always pastel. Always 9:16.");
    expect(ctx).toContain(`[${note.id}] text: Brief`);
    // Project skills only.
    expect(ctx).toContain("/thumbnail-generation");
    expect(ctx).not.toContain("/katana —");
    expect(JSON.stringify(m.seen[1].messages.at(-1)!.content)).toContain("The drop is on Friday.");
    // /name of a skill the project doesn't offer stays plain text.
    agent.addMessage(t.id, "/katana do it");
    expect(agent.getThread(t.id)!.thread.skills).toEqual([]);
  });
});

describe("modes", () => {
  it("falls back from Smart and Manual Claude to Free with nothing connected, with a note", async () => {
    setSetting("anthropicKey", "");
    expect(await agent.resolveMode({ mode: "smart" })).toMatchObject({ mode: "free", agent: "offline", note: expect.stringMatching(/Smart needs a model: add a key in Settings \(Anthropic, OpenAI, Google, OpenRouter…\)/) });
    expect(await agent.resolveMode({ mode: "manual", agent: "claude", model: "claude-haiku-5-5" })).toMatchObject({ agent: "offline", note: expect.any(String) });
    expect(await agent.resolveMode({ mode: "manual", agent: "offline" })).toMatchObject({ mode: "manual", agent: "offline" });
    expect(await agent.resolveMode({ mode: "manual", agent: "local", model: "llama3.2:3b" })).toMatchObject({
      agent: "local",
      model: "llama3.2:3b",
      note: expect.stringMatching(/No local model server is answering \(Ollama, LM Studio or Unsloth Studio\)/),
    });
    expect(await agent.resolveMode({ mode: "manual", agent: "local", model: "bad name; rm -rf" })).toMatchObject({ model: null });
    // LM Studio names its models publisher/model@quant.
    expect(await agent.resolveMode({ mode: "manual", agent: "local", model: "qwen/qwen3-8b@q4_k_m" })).toMatchObject({ model: "qwen/qwen3-8b@q4_k_m" });
    // A choice saved by an older browser still says "ollama".
    const { ModeChoice } = await import("@/server/assist/schemas");
    expect(await agent.resolveMode(ModeChoice.parse({ mode: "manual", agent: "ollama", model: "llama3.2:3b" }))).toMatchObject({ mode: "manual", agent: "local", model: "llama3.2:3b" });
    setSetting("enhanceProvider", "none");
    expect(await agent.resolveMode({ mode: "smart" })).toMatchObject({ agent: "offline", note: expect.stringMatching(/AI helper is off/) });
    setSetting("enhanceProvider", "auto");
    expect((await agent.availability()).defaultMode).toBe("free");
  });

  it("sends the picked Claude model and effort; only models with fallbacks get them", async () => {
    setSetting("anthropicKey", "sk-ant-test");
    try {
      expect(await agent.resolveMode({ mode: "smart" })).toMatchObject({ agent: "claude", model: "claude-opus-5-5", effort: "medium" });
      const r = await agent.resolveMode({ mode: "manual", agent: "claude", model: "claude-haiku-5-5", effort: "high" });
      const t = agent.createThread({ engine: "cloud", agent: r.agent, mode: r.mode, model: r.model, effort: r.effort });
      agent.addMessage(t.id, "Hi");
      const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
      const realFetch = globalThis.fetch;
      // The reply streams (server-sent events); the agent keeps the final message.
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push({ headers: new Headers(init.headers), body });
        return claudeStream({ content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", model: String(body.model) });
      }) as typeof fetch;
      try {
        await agent.run(t.id);
        // Switch to Opus mid-chat: the same frozen system prompt goes to the new model.
        await agent.updateThread(t.id, { mode: { mode: "manual", agent: "claude", model: "claude-opus-5-5", effort: "max" } });
        agent.addMessage(t.id, "Again");
        await agent.run(t.id);
      } finally {
        globalThis.fetch = realFetch;
      }
      const [a, b] = sent;
      expect(a.body).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "high" }, thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }, cache_control: { type: "ephemeral" } });
      expect(a.body.fallbacks).toBeUndefined();
      expect(a.headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01");
      expect(b.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "max" }, fallbacks: "default" });
      expect(b.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
      expect(b.body.system).toEqual(a.body.system);
      // Streamed, with more room at Extra/Max effort.
      expect(a.body).toMatchObject({ stream: true, max_tokens: 32_000 });
      expect(b.body).toMatchObject({ stream: true, max_tokens: 64_000 });
      expect(agent.getThread(t.id)!.thread.items.filter((i) => i.role === "assistant").map((i) => (i as { text: string }).text)).toEqual(["Hello", "Hello"]);
      const v = agent.getThread(t.id)!.thread;
      expect(v).toMatchObject({ mode: "manual", agent: "claude", model: "claude-opus-5-5", effort: "max" });
    } finally {
      setSetting("anthropicKey", "");
    }
  });

  it("the offline planner follows a loaded skill's hints and turns 'remember that' into a memory", () => {
    expect(agent.offlinePlan("a cozy cafe", "cloud", { kind: "video", aspect: "9:16", style: "handheld" })).toMatchObject({
      input: { jobs: [{ model_id: "minimax-h3", aspect_ratio: "9:16", prompt: "a cozy cafe. handheld" }] },
    });
    expect(agent.offlinePlan("a cozy cafe", "cloud", { kind: "image", outputs: 4, aspect: "1:1" })).toMatchObject({ input: { jobs: [{ outputs: 4, aspect_ratio: "1:1" }] } });
    expect(agent.offlinePlan("Remember that I always want vertical 9:16 videos", "cloud")).toEqual({ tool: "remember", input: { text: "I always want vertical 9:16 videos.", category: "Convention" }, say: "I'll remember that for every chat." });
  });
});

describe("studio tools", () => {
  const plan = (name: string, input: unknown, engine: "cloud" | "open" = "open") => tools.planFor(name, input, { engine });
  const video = "/api/files/uploads/2026-10-19/clip.mp4";

  it("are in the tool list with closed schemas, gated, and not strict", () => {
    const api = tools.apiTools();
    for (const n of ["split_layers", "restyle_footage", "dub_video", "faceless_episode", "create_ads", "add_captions", "list_skills", "load_skill", "remember", "read_source"]) {
      const t = api.find((x) => x.name === n);
      expect(t, n).toBeTruthy();
      expect(t!.strict).toBeUndefined();
    }
    expect(new Set(api.map((t) => t.name)).size).toBe(api.length);
    expect(tools.getTool("dub_video")!.gated).toBe(true);
  });

  it("dub on the open engine: stems → transcript → translation → cloned voice → lip sync → mix, per language", () => {
    const steps = studio.fallbackSteps.dub({ video, languages: ["Spanish", "German"] }, { engine: "open" });
    expect(steps.map((s) => s.request.op)).toEqual(["separate-audio", "transcribe", "translate", "tts", "lipsync", "mux", "translate", "tts", "lipsync", "mux"]);
    expect(steps.find((s) => s.key === "voice1")).toMatchObject({ after: ["tr1", "stems"], chain: [{ slot: "prompt" }, { slot: "voiceAudio", stem: "voice" }] });
    expect(steps.find((s) => s.key === "film0")).toMatchObject({ after: ["lips0", "voice0", "stems"], chain: [{ slot: "video" }, { slot: "audio" }, { slot: "audio2", stem: "background" }] });
    expect(steps[3].request.step).toMatchObject({ label: "Voice · Spanish", of: 10 });
    expect(steps[0].request.modelId).toBe("oss-voice-separate");
    // The Voice split: DBS keeps the music and effects; the rest of the plan is the same.
    const withDbs = studio.fallbackSteps.dub({ video, languages: ["Spanish", "German"], voice_split: "dbs" }, { engine: "open" });
    expect(withDbs[0].request.modelId).toBe("oss-dbs-voice-separate");
    expect(withDbs.slice(1)).toEqual(steps.slice(1));
    // With MelBand RoFormer switched off in Settings → Models & licences, a plan that names no split uses DBS.
    changeAccess([{ kind: "model", id: "oss-voice-separate", on: false }]);
    try {
      expect(studio.fallbackSteps.dub({ video, languages: ["Spanish"] }, { engine: "open" })[0].request.modelId).toBe("oss-dbs-voice-separate");
    } finally {
      changeAccess([{ kind: "reset" }]);
    }
    const noLips = studio.fallbackSteps.dub({ video, languages: ["French"], lipsync: false }, { engine: "open" });
    expect(noLips.map((s) => s.request.op)).toEqual(["separate-audio", "transcribe", "translate", "tts", "mux"]);
    // Cloud: one HeyGen job per language.
    expect(studio.fallbackSteps.dub({ video, languages: ["Spanish"] }, { engine: "cloud" }).map((s) => [s.request.modelId, s.request.params?.targetLanguage])).toEqual([["heygen-translate", "Spanish"]]);
    // Dubbing in one go on the open engine is the one case the dub studio can't take: the card says so.
    const jobs = plan("dub_video", { video, languages: ["Spanish"], review: false });
    expect(jobs.jobs).toHaveLength(6);
    expect(jobs.jobs.every((j) => !j.error)).toBe(true);
    expect(jobs).toMatchObject({ fallback: expect.stringMatching(/cloud service.*Library/) });
    expect(jobs.studio).toBeUndefined();
  });

  it("a faceless episode joins all its clips at once on both engines (the copy join on your GPU)", () => {
    const scenes = Array.from({ length: 6 }, (_, i) => ({ narration: `Line ${i}`, visual: `Scene ${i}` }));
    const steps = studio.fallbackSteps.faceless({ scenes, style: "flat 2D", aspect_ratio: "9:16" }, { engine: "open" });
    expect(steps.filter((s) => s.request.op === "t2i")).toHaveLength(6);
    expect(steps.filter((s) => s.request.op === "concat").map((s) => [s.key, s.request.modelId])).toEqual([["film", "oss-join-encoded"]]);
    expect(steps.find((s) => s.key === "film")!.after).toEqual(scenes.map((_, k) => `clip${k}`));
    expect(steps.find((s) => s.key === "episode")).toMatchObject({ after: ["film", "voice"], request: { op: "mux", modelId: "oss-mux" } });
    expect(steps.find((s) => s.key === "voice")!.request.prompt).toBe(scenes.map((s) => s.narration).join("\n\n"));
    const cloud = studio.fallbackSteps.faceless({ scenes, style: "flat 2D" }, { engine: "cloud" });
    expect(cloud.filter((s) => s.request.op === "concat")).toHaveLength(1);
    expect(cloud.find((s) => s.key === "clip0")!.request.modelId).toBe("gemini-omni-flash");
    expect(() => studio.fallbackSteps.faceless({ scenes: scenes.slice(0, 1), style: "x" }, { engine: "open" })).toThrow(/at least 2 scenes/);
  });

  it("captions, layers, restyle and ads plan with real models", () => {
    expect(studio.fallbackSteps.captions({ video, translate_to: "Spanish" }, { engine: "open" }).map((s) => s.request.modelId)).toEqual(["oss-qwen3-asr", "oss-text-llm", "oss-captions-burnin"]);
    expect(studio.fallbackSteps.captions({ video, translate_to: "Spanish" }, { engine: "cloud" })[0].request).toMatchObject({ modelId: "veed-subtitles", params: { targetLanguage: "Spanish" } });
    expect(plan("split_layers", { image: "/api/files/uploads/a.png", layers: 5 }).jobs).toMatchObject([{ op: "layers", modelId: "oss-qwen-layered" }]);
    expect(plan("restyle_footage", { video, style: "claymation" }, "cloud").jobs).toMatchObject([{ op: "v2v", modelId: "kling-o3" }]);
    // On your GPU: Fuobe Mixed Media's per-frame pass on the GPU, one seed (its graph reads no reference images).
    const [open] = studio.fallbackSteps.restyle({ video, style: "anime", references: ["/api/files/uploads/r.png"] }, { engine: "open" });
    expect(open.request).toMatchObject({ modelId: "fuobe-mixed-media", engine: "open", op: "v2v", prompt: "anime", params: { seed: 424242 }, inputs: { video } });
    expect(open.request.inputs?.images).toBeUndefined();
    expect(plan("restyle_footage", { video, style: "claymation" }, "open").jobs).toMatchObject([{ op: "v2v", modelId: "fuobe-mixed-media" }]);
    const ads =studio.fallbackSteps.ads({ brief: "oat milk", product_image: "/api/files/uploads/p.png", count: 8, aspect_ratios: ["1:1", "4:5", "9:16"] }, { engine: "cloud" });
    expect(ads).toHaveLength(12);
    expect(ads[0]).toMatchObject({ modelId: "nano-banana-pro", op: "edit", inputs: { images: ["/api/files/uploads/p.png"] } });
  });

  // Words that name what a picture or clip should leave out: an image or video model with no negative branch adds them.
  const NEGATION = /\b(no|not|never|without|none|nothing|avoid|don't|do not|free of)\b/i;

  it("a faceless episode on your GPU: Qwen-Image 2.1 stills, MiniMax H3 clips, the narration in place of their sound", () => {
    const scenes = Array.from({ length: 3 }, (_, i) => ({ narration: `Line ${i}`, visual: `Scene ${i}` }));
    const steps = studio.fallbackSteps.faceless({ scenes, style: "flat 2D", aspect_ratio: "9:16" }, { engine: "open" });
    const still = steps.find((s) => s.key === "still0")!;
    expect(still.request).toMatchObject({ modelId: "oss-qwen-image-21", op: "t2i", params: { aspectRatio: "9:16" } });
    const clip = steps.find((s) => s.key === "clip0")!;
    expect(clip.request).toMatchObject({ modelId: "oss-minimax-h3", op: "i2v", params: { aspectRatio: "9:16", duration: 5 } });
    // The clips are joined by copy (one canvas, no decode), and the mux lays the narration on in place of their sound.
    expect(steps.find((s) => s.key === "film")!.request.modelId).toBe("oss-join-encoded");
    expect(steps.find((s) => s.key === "episode")).toMatchObject({ after: ["film", "voice"], chain: [{ slot: "video" }, { slot: "audio" }], request: { modelId: "oss-mux" } });
    for (const s of steps.filter((x) => x.key.startsWith("still") || x.key.startsWith("clip"))) expect(s.request.prompt, s.key).not.toMatch(NEGATION);
  });

  it("ads on your GPU run on Qwen-Image 2.1 (its edit with the product photo, text-to-image without), worded as what is wanted", () => {
    const withProduct = studio.fallbackSteps.ads({ brief: "oat milk", product_image: "/api/files/uploads/p.png", count: 2, cta: "Shop now" }, { engine: "open" });
    expect(withProduct[0]).toMatchObject({ modelId: "oss-qwen-image-21", op: "edit", inputs: { images: ["/api/files/uploads/p.png"] } });
    expect(withProduct[0].prompt).toMatch(/the headline and the button are the only added lettering, spelled exactly\.$/);
    const words = studio.fallbackSteps.ads({ brief: "oat milk", count: 2 }, { engine: "open" });
    expect(words[0]).toMatchObject({ modelId: "oss-qwen-image-21", op: "t2i" });
    expect(words[0].inputs).toBeUndefined();
    expect(words[0].prompt).toMatch(/the headline is the only added lettering, spelled exactly\.$/);
    for (const r of [...withProduct, ...words]) expect(r.prompt).not.toMatch(NEGATION);
  });

  const image = "/api/files/uploads/2026-10-19/still.png";
  const scenes = [
    { narration: "Tea began as medicine.", visual: "A misty mountain tea garden" },
    { narration: "Then it became a ritual.", visual: "Hands pouring tea in a quiet room" },
    { narration: "Today it's everywhere.", visual: "A busy café counter" },
  ];
  const SAMPLES: Record<string, unknown[]> = {
    split_layers: [{ image }, { image, layers: 8, focus: "the person and the text" }],
    restyle_footage: [{ video, style: "claymation" }, { video, style: "anime", references: [image] }],
    dub_video: [{ video, languages: ["Spanish"] }, { video, languages: ["Spanish", "German"], lipsync: false }],
    faceless_episode: [
      { scenes, style: "flat 2D" },
      { title: "Tea", scenes: [...scenes, ...scenes], style: "watercolour", aspect_ratio: "1:1" },
      { scenes, style: "flat 2D", voice_sample: "/api/files/uploads/2026-10-19/me.wav" },
    ],
    create_ads: [{ brief: "oat milk for runners" }, { brief: "oat milk", product_image: image, count: 2, aspect_ratios: ["1:1", "9:16"] }],
    add_captions: [{ video }, { video, translate_to: "Spanish" }],
    restore_video: [{ video }, { video, prompt: "a harbour in the 1930s, natural colour", reference: image }],
    remove_person: [{ video, who: "the man in the grey shirt" }, { video, who: "the woman on the left", start: 0, end: 1, mask_grow: 9 }],
    fly_around: [
      { image, degrees: 180, direction: "cw", tilt: 10, pulse: true },
      { image, preset: "orbit_90_ccw", views: [image], duration: 8 },
    ],
    blockout_film: [
      { video, seconds: 8, beats: [{ start: 0, label: "Arrival", words: "She walks in." }] },
      { video, seconds: 40, beats: [{ start: 0, label: "Arrival" }, { start: 20, label: "Lights out" }], references: [{ url: image, role: "character", name: "Mara" }], model: "minimax-h3-max-3d", sounds: ["Footsteps"] },
    ],
    world_film: [
      { scene: "A stone path through a forest at dusk, blue fireflies between mossy trees", turns: [] },
      { scene: "A harbour at dawn", subject: "a fishing boat", turns: [{ words: "the fog lifts", move: "orbit_90_ccw", seconds: 12 }, { words: "gulls circle the mast", move: "zoom_in" }, { words: "", move: "truck_left", seconds: 6 }], seed: 3 },
    ],
    edit_speech: [
      { media: video, kind: "video", transcript: [{ start: 0, end: 2.4, text: "We open on Tuesday." }, { start: 3, end: 5, text: "Everyone is welcome." }], changes: [{ line: 0, text: "We open on Thursday." }] },
      { media: video, kind: "video", transcript: [{ start: 0, end: 2.4, text: "We open on Tuesday." }], effect: { kind: "pitch", semitones: 2 }, range: { start: 0, end: 2.4 } },
    ],
  };
  /** Tools that run on your GPU only: "Paid APIs only" refuses them on the card, with the reason. */
  const OPEN_ONLY = new Set(["edit_speech", "world_film"]);

  it("every studio tool plans without errors on both engines in demo mode", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(studio.STUDIO_TOOLS.map((t) => t.name).sort());
    for (const mode of ["both", "open", "cloud"] as const) {
      setSetting("engineMode", mode);
      try {
        for (const [name, inputs] of Object.entries(SAMPLES))
          for (const input of inputs)
            for (const engine of ["cloud", "open"] as const) {
              const p = plan(name, input, engine);
              if (OPEN_ONLY.has(name) && mode === "cloud") {
                expect(p.jobs.find((j) => j.error)?.error ?? p.error, `${name} ${engine}/${mode}`).toMatch(/runs on your GPU/);
                continue;
              }
              // Remove a person runs on your GPU only (MiniMax H3 with the Person Remover LoRA): an install that runs the
              // cloud alone says so on the card.
              if (name === "remove_person" && mode === "cloud") {
                expect(p.jobs.find((j) => j.error)?.error ?? p.error, `${name} ${engine}/${mode}`).toBeTruthy();
                continue;
              }
              expect(p.error, `${name} ${engine}/${mode}`).toBeUndefined();
              expect(p.jobs.length, `${name} ${engine}/${mode}`).toBeGreaterThan(0);
              for (const j of p.jobs) expect(j.error, `${name} ${engine}/${mode}: ${j.modelId}`).toBeUndefined();
              expect(planRunnable(p.jobs)).toBe(true);
            }
      } finally {
        setSetting("engineMode", "both");
      }
    }
  });

  it("an open-source narrator needs a voice sample to clone once it runs for real", () => {
    // No sample on a real open engine: the card says what to add and can't run, in Faceless Studio
    // and in the pipeline it falls back to (a square episode).
    setSetting("demoMode", "off");
    const g = globalThis as unknown as { __fuobeComfyReach?: { ok: boolean; at: number; url: string } };
    const before = g.__fuobeComfyReach;
    try {
      // Nothing connected: the card says to connect ComfyUI first, not to add a sample it couldn't use yet.
      const none = plan("faceless_episode", { scenes, style: "flat 2D" }, "open");
      expect(none.jobs.find((j) => j.error)?.error ?? none.error).toMatch(/Connect ComfyUI in Settings/);
      expect(planRunnable(none.jobs)).toBe(false);
      // A ComfyUI that answers: now the sample is what's missing.
      g.__fuobeComfyReach = { ok: true, at: Date.now(), url: "http://127.0.0.1:9" };
      const p = plan("faceless_episode", { scenes, style: "flat 2D" }, "open");
      expect(p.studio).toBe("Faceless Studio");
      expect(p.jobs.find((j) => j.error)?.error).toMatch(/Pick the narrator's voice/);
      expect(planRunnable(p.jobs)).toBe(false);
      const square = plan("faceless_episode", { scenes, style: "flat 2D", aspect_ratio: "1:1" }, "open");
      expect(square.fallback).toMatch(/16:9 and 9:16/);
      const voice = square.jobs.find((j) => j.note === "Narration")!;
      expect(voice).toMatchObject({ modelId: "oss-chatterbox", atomic: true });
      expect(voice.error).toMatch(/Add a voice sample for the narrator/);
      expect(planRunnable(square.jobs)).toBe(false);
    } finally {
      g.__fuobeComfyReach = before;
      setSetting("demoMode", "auto");
    }
    // A sample is cloned on either engine; the cloud engine otherwise uses a premade voice.
    const sample = "/api/files/uploads/2026-10-19/me.wav";
    const open = studio.fallbackSteps.faceless({ scenes, style: "x", voice_sample: sample }, { engine: "open" }).find((s) => s.key === "voice")!;
    expect(open.request).toMatchObject({ modelId: "oss-chatterbox", inputs: { voiceAudio: sample } });
    const cloud = studio.fallbackSteps.faceless({ scenes, style: "x", voice_sample: sample }, { engine: "cloud" }).find((s) => s.key === "voice")!;
    expect(cloud.request).toMatchObject({ modelId: "chatterbox-cloud", inputs: { voiceAudio: sample } });
    const premade = studio.fallbackSteps.faceless({ scenes, style: "x", voice: "rachel" }, { engine: "cloud" }).find((s) => s.key === "voice")!;
    expect(premade.request).toMatchObject({ modelId: "elevenlabs-v4", params: { voice: "rachel" } });
  });

  it("a demo faceless episode on the open engine clones a saved demo voice", async () => {
    // In Faceless Studio…
    const out = await tools.executeTool("faceless_episode", { scenes, style: "flat 2D" }, { engine: "open" });
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content as string) as { episode: string };
    const plan_ = JSON.parse((db().prepare("SELECT plan_json FROM faceless_episodes WHERE id = ?").get(body.episode) as { plan_json: string }).plan_json) as { ids: Record<string, string> };
    const narration = db().prepare("SELECT request_json FROM generations WHERE id = ?").get(plan_.ids.narration) as { request_json: string };
    expect(JSON.parse(narration.request_json).inputs.voiceAudio).toMatch(/^\/api\/files\/uploads\/.+\.wav$/);
    // …and in the pipeline a square episode falls back to.
    const square = await tools.executeTool("faceless_episode", { scenes, style: "flat 2D", aspect_ratio: "1:1" }, { engine: "open" });
    expect(square.isError).toBeFalsy();
    const steps = JSON.parse(square.content as string) as { steps: { step: string; id: string }[]; demo: boolean; ranIn: string };
    expect(steps).toMatchObject({ demo: true, ranIn: "Library" });
    const voiceId = steps.steps.find((s) => s.step === "Narration")!.id;
    const row = db().prepare("SELECT request_json FROM generations WHERE id = ?").get(voiceId) as { request_json: string };
    expect(JSON.parse(row.request_json).inputs.voiceAudio).toMatch(/^\/api\/files\/uploads\/.+\.wav$/);
  });

  it("one broken step blocks a pipeline's card; a separate job only blocks itself", () => {
    const chained = plan("generate", { summary: "s", jobs: [{ model_id: "nope", prompt: "a" }, { model_id: "oss-wan22-14b-fast", prompt: "b", after: 0 }] }, "open");
    expect(chained.jobs.every((j) => j.atomic)).toBe(true);
    expect(planRunnable(chained.jobs)).toBe(false);
    const separate = plan("generate", { summary: "s", jobs: [{ model_id: "nope", prompt: "a" }, { model_id: "oss-z-image-turbo", prompt: "b" }] }, "open");
    expect(separate.jobs.some((j) => j.atomic)).toBe(false);
    expect(planRunnable(separate.jobs)).toBe(true);
  });

  it("runs as one demo pipeline, final result in the chat", async () => {
    const out = await tools.executeTool("dub_video", { video, languages: ["Spanish"], lipsync: false, review: false }, { engine: "open" });
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content as string) as { steps: { id: string; waitsFor: string[] }[]; results: string[]; demo: boolean };
    expect(body.steps).toHaveLength(5);
    expect(body.demo).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(out.items?.find((i) => i.role === "generations")).toMatchObject({ ids: body.results });
    const deps = db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(body.results[0]) as { depends_on: string };
    expect(JSON.parse(deps.depends_on)).toEqual(body.steps.at(-1)!.waitsFor);
  });

  it("hands the job to the studio module in STUDIO_ROUTES", async () => {
    const seen: unknown[] = [];
    const real = studio.STUDIO_ROUTES.split_layers;
    expect(real?.studio).toBe("Layers");
    studio.STUDIO_ROUTES.split_layers = { studio: "Layers", page: "/layers", run: async (i) => (seen.push(i), { ids: [], href: "/layers/abc", info: { project: "abc" } }) };
    try {
      const out = await tools.executeTool("split_layers", { image: "/api/files/uploads/a.png" }, { engine: "open" });
      expect(seen).toEqual([{ image: "/api/files/uploads/a.png" }]);
      expect(JSON.parse(out.content as string)).toEqual({ studio: "Layers", href: "/layers/abc", results: [], project: "abc" });
      expect(out.items).toEqual([{ id: "", role: "tool", text: "Opened a Layers project", href: "/layers/abc", studio: "Layers" }]);
    } finally {
      studio.STUDIO_ROUTES.split_layers = real;
    }
  });
});

describe("a project's assets", () => {
  it("are the finished results of its chats, newest first, with the chat each came from", async () => {
    const p = projects.createProject({ name: "Assets project" });
    const t = agent.createThread({ engine: "cloud", agent: "offline", projectId: p.id, autoApprove: true });
    agent.addMessage(t.id, "Two stills of a red kite");
    const gen = { summary: "Kites", jobs: [{ model_id: "nano-banana-pro", prompt: "a red kite", outputs: 2 }] };
    await agent.run(t.id, scripted(reply([use("u1", "generate", gen)], "tool_use"), reply([text("Started.")], "end_turn")).call);
    const ids = agent.getThread(t.id)!.thread.items.flatMap((i) => (i.role === "generations" ? i.ids : []));
    expect(ids.length).toBeGreaterThan(0);
    // Not finished yet: nothing to show.
    db().prepare("UPDATE generations SET status = 'running' WHERE id IN (" + ids.map(() => "?").join(",") + ")").run(...ids);
    expect(agent.projectAssets(p.id)).toEqual([]);
    db()
      .prepare("UPDATE generations SET status = 'succeeded', outputs_json = ? WHERE id = ?")
      .run(JSON.stringify([{ url: "/samples/previews/city.svg", contentType: "image/svg+xml" }]), ids[0]);
    const assets = agent.projectAssets(p.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ chatId: t.id, chatTitle: "Two stills of a red kite", generation: { id: ids[0], status: "succeeded" } });
    // A chat outside the project doesn't count.
    expect(agent.projectAssets("nope")).toEqual([]);
  });
});

describe("MCP", () => {
  const rpc = (method: string, params?: unknown) => handleMcp({ jsonrpc: "2.0", id: 7, method, params });

  it("offers skills as prompts", async () => {
    const init = (await rpc("initialize", { protocolVersion: "2025-11-25" })) as { result: { capabilities: { prompts?: unknown } } };
    expect(init.result.capabilities.prompts).toBeTruthy();
    const list = (await rpc("prompts/list")) as { result: { prompts: { name: string; arguments: unknown[] }[] } };
    expect(list.result.prompts.map((p) => p.name)).toContain("product-photoshoot");
    const got = (await rpc("prompts/get", { name: "faceless-video", arguments: { request: "a 60s history of tea" } })) as { result: { messages: { content: { text: string } }[] } };
    expect(got.result.messages[0].content.text).toMatch(/Faceless Studio[\s\S]*The job: a 60s history of tea$/);
    expect(await rpc("prompts/get", { name: "nope" })).toMatchObject({ error: { code: -32602 } });
  });

  it("lists the new tools with the right hints and prices studio jobs", async () => {
    const r = (await rpc("tools/list")) as { result: { tools: { name: string; description: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }[] } };
    const by = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    expect(by.load_skill.annotations.readOnlyHint).toBe(true);
    expect(by.dub_video.description).toMatch(/estimate_job/);
    expect(by.dub_video.description).not.toMatch(/approval card/);
    expect(by.remember.description).toMatch(/confirm with the user first/);
    expect(by.remember.description).not.toMatch(/estimate/);
    const est = (await rpc("tools/call", { name: "estimate_job", arguments: { tool: "add_captions", arguments: { video } } })) as {
      result: { structuredContent: { jobs: { modelId: string }[]; studio: string; href: string }; isError: boolean };
    };
    expect(est.result.isError).toBe(false);
    // The Captions studio's quick burn, and the transcript its editor opens with.
    expect(est.result.structuredContent).toMatchObject({ studio: "Captions", href: "/video-tools/captions" });
    expect(est.result.structuredContent.jobs.map((j) => j.modelId)).toEqual(["scribe-v2", "auto-subtitle"]);
    expect(await rpc("tools/call", { name: "estimate_job", arguments: { tool: "remember", arguments: {} } })).toMatchObject({ result: { isError: true } });
    // Without a chat, load_skill returns the instructions themselves.
    const ls = (await rpc("tools/call", { name: "load_skill", arguments: { name: "narration" } })) as { result: { content: { text: string }[] } };
    expect(ls.result.content[0].text).toMatch(/^# Narration \(\/narration\)/);
  });

  it("read_source over MCP lists the projects' sources, then reads one by project and id", async () => {
    const p = projects.createProject({ name: "MCP brief" });
    const note = await projects.addSource(p.id, { kind: "text", text: "Tone\nWarm and plain." });
    type Call = { result: { content: { text: string }[]; isError: boolean } };
    const listed = (await rpc("tools/call", { name: "read_source", arguments: {} })) as Call;
    expect(listed.result.isError).toBe(false);
    const all = JSON.parse(listed.result.content[0].text) as { project_id: string; sources: { id: string; title: string }[] }[];
    expect(all.find((x) => x.project_id === p.id)?.sources).toEqual([expect.objectContaining({ id: note.id, title: "Tone" })]);
    const read = (await rpc("tools/call", { name: "read_source", arguments: { project_id: p.id, id: note.id } })) as Call;
    expect(read.result.isError).toBe(false);
    expect(read.result.content[0].text).toMatch(/^# Tone[\s\S]*Warm and plain\.$/);
    expect(await rpc("tools/call", { name: "read_source", arguments: { project_id: "nope", id: note.id } })).toMatchObject({ result: { isError: true } });
    // In a chat outside a project there is still nothing to read, whatever project_id says.
    const chat = await tools.executeTool("read_source", { id: note.id, project_id: p.id }, { engine: "cloud", thread: { id: "t", projectId: null, skills: [], loadSkill: () => {} } });
    expect(chat).toMatchObject({ isError: true, content: expect.stringMatching(/isn't in a project/) });
  });
});

const video = "/api/files/uploads/2026-10-19/clip.mp4";
