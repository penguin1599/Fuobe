import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexEntries } from "@/lib/command-search";
import { paletteIndex } from "@/lib/palette-index";
import { tempDir } from "./helpers/temp-dir";

/**
 * Settings → Models & licences in the places that list or pick models: GET /api/models (the CLI's list and the
 * studios' defaults), /api/status (what the browser filters its pickers with), Assist's and MCP's search_models,
 * the ⌘K palette, Assist's own picks, and POST /api/generations (the API refuses a model that is off).
 */

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-access-listings-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
const { GET: listModels } = await import("@/app/api/models/route");
const { GET: status } = await import("@/app/api/status/route");
const { POST: postGeneration } = await import("@/app/api/generations/route");
const settingsRoute = await import("@/app/api/settings/models/route");
const { changeAccess } = await import("@/server/model-access");
const tools = await import("@/server/assist/tools");
const { offlinePlan } = await import("@/server/assist/agent");
const { setSetting } = await import("@/server/settings");

type Body = { defaults: Record<string, { cloud?: string; open?: string }>; items: { id: string; engines: string[] }[] };
const models = async (query = "") => (await (await listModels(new Request(`http://localhost/api/models${query}`))).json()) as Body;

beforeEach(() => {
  changeAccess([{ kind: "reset" }]);
  setSetting("engineMode", "both");
  setSetting("demoMode", "on");
});

describe("Models & licences in listings and picks", () => {
  it("lists only what is on, and a studio default that is off gives way to the next model that is on", async () => {
    const before = await models("?kind=image");
    expect(before.items.map((m) => m.id)).toContain("nano-banana-pro");
    expect(before.defaults.image.cloud).toBe("nano-banana-pro");
    changeAccess([{ kind: "model", id: "nano-banana-pro", on: false }]);
    const after = await models("?kind=image");
    expect(after.items.map((m) => m.id)).not.toContain("nano-banana-pro");
    expect(after.defaults.image.cloud).toBeTruthy();
    expect(after.defaults.image.cloud).not.toBe("nano-banana-pro");
    // A whole licence class: the paid APIs. Fuobe Soul stays, on your GPU.
    changeAccess([{ kind: "class", id: "paid-api", on: false }]);
    const open = await models("?kind=image");
    expect(open.items.every((m) => m.engines.every((e) => e === "open"))).toBe(true);
    expect(open.items.find((m) => m.id === "fuobe-soul")?.engines).toEqual(["open"]);
  });

  it("tells the browser what is off through /api/status, and nothing while everything is on", async () => {
    expect(((await (await status()).json()) as { access?: unknown }).access).toBeUndefined();
    changeAccess([{ kind: "provider", id: "replicate", on: false }, { kind: "class", id: "research", on: false }]);
    const body = (await (await status()).json()) as { access: { off: string[] } };
    expect(body.access.off).toContain("oss-reactor");
    expect(body.access.off.length).toBeGreaterThan(5);
  });

  it("leaves switched-off models out of Assist's and MCP's search_models", async () => {
    const ids = async () => (JSON.parse((await tools.executeTool("search_models", { kind: "image" }, { engine: "cloud" })).content as string).models as { id: string }[]).map((m) => m.id);
    expect(await ids()).toContain("nano-banana-pro");
    changeAccess([{ kind: "model", id: "nano-banana-pro", on: false }]);
    expect(await ids()).not.toContain("nano-banana-pro");
  });

  it("picks Assist's model past one that is off", () => {
    const plan = () => (offlinePlan("a photo of a red bicycle", "cloud")!.input.jobs as { model_id: string }[])[0].model_id;
    expect(plan()).toBe("nano-banana-pro");
    changeAccess([{ kind: "model", id: "nano-banana-pro", on: false }]);
    expect(plan()).not.toBe("nano-banana-pro");
  });

  it("leaves a switched-off model out of the ⌘K palette, and an Original off on one engine out of that engine's list", () => {
    const index = paletteIndex();
    expect(indexEntries(index, "both").some((e) => e.key === "model:nano-banana-pro")).toBe(true);
    expect(indexEntries(index, "both", { off: ["nano-banana-pro"] }).some((e) => e.key === "model:nano-banana-pro")).toBe(false);
    const soulOpenOnly = { off: [], engines: { "fuobe-soul": ["open" as const] } };
    expect(indexEntries(index, "cloud", soulOpenOnly).some((e) => e.key === "model:fuobe-soul")).toBe(false);
    expect(indexEntries(index, "open", soulOpenOnly).some((e) => e.key === "model:fuobe-soul")).toBe(true);
  });

  it("refuses a model that is off through the API, naming the switch", async () => {
    changeAccess([{ kind: "class", id: "non-commercial", on: false }]);
    const res = await postGeneration(new Request("http://localhost/api/generations?preview=1", { method: "POST", body: JSON.stringify({ feature: "image", modelId: "oss-flux1-dev", prompt: "a cat" }) }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/^FLUX\.1 \[dev\] is turned off in Settings → Models & licences \(Non-commercial is switched off\)/);
  });

  it("lists every model, LoRA and node pack with its licence, and flips switches through the settings API", async () => {
    const list = (await (await settingsRoute.GET()).json()) as import("@/lib/model-access").AccessList;
    expect(list.models.length).toBeGreaterThan(300);
    // The library's 118 LoRAs (Fuobe Try-On's try-on LoRA, the Storyboard's next-scene LoRA, and since O11 Fuobe Angles'
    // Multiple-angles and Fuobe Speak's FusioniX among them), the preset LoRA map's files that aren't library files, and
    // MiniMax H3's four (Akatz Labs' swap LoRA V1.5 and V1 and Person Remover V1, lightx2v's H3 Turbo), and Fuobe Restore's
    // two gated IC-LoRAs (Lightricks' Restore and Detail Refine), Open-H3 Regenerate's merged refiner LoRA, and Any Angle's
    // AnyAngle LoRA for Qwen-Image 2.1, each once. Qwen-Image 2.1's three speed LoRAs and its Next-Scene LoRA are four more,
    // the QMA camera-angles LoRA one more, Fuobe Animation's AniSora 3.2 and lightx2v 4-step low-noise LoRAs two more, Pika H3
    // Flex's two adapters two more, and lightx2v's H3 Turbo 4-step v1.2 (MiniMax H3's 2K draft) one more.
    expect(list.loras.length).toBe(188);
    expect(list.loras.find((l) => l.file === "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors")).toMatchObject({ group: "adapter", base: "MiniMax H3", on: true, licence: { name: "Apache-2.0", class: "commercial" } });
    expect(list.loras.find((l) => l.file === "open_h3_regenerate_2k_lora.safetensors")).toMatchObject({ group: "adapter", base: "MiniMax H3", on: true, licence: { name: "MiniMax H3 Community License", class: "regions" } });
    expect(list.packs.find((p) => p.name === "ComfyUI-Open-H3-Regenerate")).toMatchObject({ licence: { name: "Apache-2.0" }, on: true, models: 1 });
    expect(list.packs.find((p) => p.name === "Comfyui_Minimax_h3_latent_Upscaler")).toMatchObject({ licence: { name: "MIT" }, on: true, models: 1 });
    expect(list.loras.find((l) => l.file === "next-scene_lora-v2-3000.safetensors")).toMatchObject({ group: "adapter", on: true, licence: { name: "MIT", class: "commercial" } });
    expect(list.loras.find((l) => l.file === "qwen-edit-2509-multiple-angles-dx8152.safetensors")).toMatchObject({ group: "adapter", on: true, licence: { name: "Apache-2.0", class: "commercial" } });
    expect(list.loras.find((l) => l.file === "Wan2.1_I2V_14B_FusionX_LoRA.safetensors")).toMatchObject({ group: "adapter", on: true });
    expect(list.loras.find((l) => l.file === "tryon-klein-4b.safetensors")).toMatchObject({ group: "adapter", on: true, licence: { name: "Apache-2.0", class: "commercial" } });
    expect(list.loras.find((l) => l.file === "h3_character_swap_v1.5.safetensors")).toMatchObject({ group: "adapter", base: "MiniMax H3", on: true, licence: { name: "MiniMax H3 Community License", class: "regions" } });
    expect(list.packs.find((p) => p.name === "h3_character_swap")).toMatchObject({ licence: { name: "GPL-3.0" }, on: true });
    expect(new Set(list.loras.map((l) => l.file)).size).toBe(list.loras.length);
    expect(list.loras.find((l) => l.file === "crane_up.safetensors")).toMatchObject({
      name: "Crane up",
      group: "motion",
      licence: { class: "commercial", name: "Apache-2.0", url: "https://huggingface.co/Remade-AI/Crane_up" },
      on: true,
    });
    expect(list.loras.find((l) => l.file === "crane_up.safetensors")!.licence.note).toMatch(/In the preset LoRA map: Jib Up/);
    expect(list.loras.find((l) => l.file === "cakeify_16_epochs.safetensors")).toMatchObject({ group: "effect" });
    expect(list.packs.find((p) => p.name === "ComfyUI-Whisper")).toMatchObject({ licence: { class: "non-commercial" }, models: 1, on: true });
    expect(list.models.find((m) => m.id === "fuobe-soul")).toMatchObject({ licence: { class: "commercial" }, cloud: { class: "paid-api" }, engines: ["open", "cloud"], on: true });
    expect(list.loras.find((l) => l.file === "BTSMovieSet_LTX25_v1.safetensors")!.licence.note).toMatch(/research holds this licence/);
    expect(list.classes.find((c) => c.id === "non-commercial")).toMatchObject({ on: true });
    const put = (changes: unknown) => settingsRoute.PUT(new Request("http://localhost/api/settings/models", { method: "PUT", body: JSON.stringify({ changes }) }));
    expect((await put([{ kind: "class", id: "free", on: false }])).status).toBe(400);
    expect((await put([{ kind: "model", on: false }])).status).toBe(400);
    expect((await put([])).status).toBe(400);
    // A switch that names nothing this install has is refused, not stored.
    for (const [kind, id] of [["model", "nano-bananna-pro"], ["provider", "nope"], ["pack", "ComfyUI-Nope"], ["lora", "nope.safetensors"]]) {
      const res = await put([{ kind, id, on: false }]);
      expect(res.status, `${kind} ${id}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/isn't one this install has/);
    }
    expect((await put([{ kind: "lora", id: "crane_up.safetensors", on: false }])).status).toBe(200);
    expect((await put([{ kind: "lora", id: "crane_up.safetensors", on: true }])).status).toBe(200);
    const after = (await (await put([{ kind: "provider", id: "fal", on: false }, { kind: "keepGpuOnlyLoras", on: true }])).json()) as import("@/lib/model-access").AccessList;
    expect(after.access).toMatchObject({ providers: ["fal"], keepGpuOnlyLoras: true });
    expect(after.providers.find((p) => p.id === "fal")!.on).toBe(false);
    // A model only fal hosts is off by that switch, and says which.
    expect(after.models.find((m) => m.id === "fal-ai-flux-dev" || (m.providers.length === 1 && m.providers[0] === "fal"))!.offBy).toEqual(["fal.ai is switched off"]);
  });
});
