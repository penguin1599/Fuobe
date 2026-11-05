import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandSpeechEditWorkflow, FADE_TAIL, HEADROOM_DB, speechFadeWav } from "@/lib/av/speech-edit-graph";
import type { ComfyWorkflow } from "@/lib/comfy";
import { editedLength, type SpeechWindow } from "@/lib/speech-edit";

/**
 * Edit speech on your GPU (nm10-speech-edit): the AuK graphs, their pack pinned for the GPU pre-flight, the node list
 * they are checked against (ComfyUI-AuK is not on the validation server), the windows' rebuild, and what the ComfyUI
 * provider binds.
 */

process.env.FUOBE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-speech-edit-comfy-"));
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const root = path.resolve(__dirname, "..");
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
type Entry = { id: string; capability: string; customNodes?: { name: string; repo: string }[]; validated: boolean; license?: string; expand?: string; bindings: Record<string, { node: string; input: string }[]> };
const manifest = read("workflows/comfyui/manifest.json") as { workflows: Entry[] };
const packs = read("workflows/comfyui/packs.json") as Record<string, { repo: string; commit: string; subdir: string | null }>;
const requirements = read("workflows/comfyui/requirements.json") as { workflows: Record<string, { packs: Record<string, string[]>; firstRun: string[]; vramGb: number }> };
const subset = read("workflows/comfyui/object_info.subset.json") as Record<string, { python_module: string; input: { required: Record<string, unknown>; optional?: Record<string, unknown> } } | null>;
const graph = (id: string) => read(`workflows/comfyui/${id}.json`) as ComfyWorkflow;

/** The inputs of ComfyUI-AuK's two nodes at the pinned commit (comfyui/ComfyUI-AuK/nodes.py, define_schema). */
const AUK_NODES: Record<string, string[]> = {
  AuKModelLoader: ["checkpoint_path", "config_path", "qwen_path", "device", "dtype", "cpu_offload"],
  AuKGenerateEdit: ["engine", "instruction", "generation_seconds", "use_prompt_enhancer", "seed", "input_audio", "nfe_steps", "cfg_strength", "sway_sampling_coef"],
};

describe("the AuK graphs in the library", () => {
  it.each([
    ["speech-edit-auk", "speech-edit", ["audio", "fadeCurve", "seed", "device", "filenamePrefix"]],
    ["speech-tts-auk", "tts", ["audio", "prompt", "seed", "device", "filenamePrefix"]],
  ])("%s: its pack pinned, checked against AuK's node list, MIT and its downloads stated", (id, capability, bindings) => {
    const w = manifest.workflows.find((x) => x.id === id)!;
    expect(w.capability).toBe(capability);
    expect(Object.keys(w.bindings).sort()).toEqual([...bindings].sort());
    expect(w.customNodes?.map((c) => c.name)).toEqual(["ComfyUI-AuK"]);
    expect(w.validated).toBe(false);
    expect(w.license).toMatch(/MIT/);
    expect(w.license).toMatch(/Qwen Research License/);
    expect(packs["ComfyUI-AuK"]).toMatchObject({ repo: "https://github.com/Tencent-Hunyuan/AuK", subdir: "comfyui/ComfyUI-AuK" });
    expect(packs["ComfyUI-AuK"].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(requirements.workflows[id].packs["ComfyUI-AuK"]).toEqual(["AuKGenerateEdit", "AuKModelLoader"]);
    expect(requirements.workflows[id].firstRun.join(" ")).toMatch(/tencent\/AuK-Flash at 575b92f0.*Qwen\/Qwen2\.5-Omni-3B/);
    expect(requirements.workflows[id].vramGb).toBe(24);
    for (const n of Object.values(graph(id))) {
      const info = subset[n.class_type];
      expect(info, n.class_type).toBeTruthy();
      const allowed = AUK_NODES[n.class_type];
      if (!allowed) continue;
      expect(info!.python_module).toBe("custom_nodes.ComfyUI-AuK");
      for (const input of Object.keys(n.inputs)) expect(allowed, `${n.class_type}.${input}`).toContain(input);
      expect(Object.keys({ ...info!.input.required, ...info!.input.optional }).sort()).toEqual([...allowed].sort());
    }
    // Prompt Enhancer off, AuK-Flash's settings.
    const gen = Object.values(graph(id)).find((n) => n.class_type === "AuKGenerateEdit")!;
    expect(gen.inputs).toMatchObject({ use_prompt_enhancer: false, nfe_steps: 4, cfg_strength: 0, sway_sampling_coef: -1 });
    expect(w.expand).toBe(id === "speech-edit-auk" ? "speech" : undefined);
  });

  it("is pinned the same in the install script", () => {
    const sh = fs.readFileSync(path.join(root, "scripts/comfy/install-comfyui.sh"), "utf8");
    expect(sh).toContain(`AUK_REF="\${AUK_REF:-${packs["ComfyUI-AuK"].commit}}"`);
    expect(sh).toMatch(/AUK:-0/);
  });
});

describe("the windows' rebuild", () => {
  const windows: SpeechWindow[] = [
    { start: 0, end: 3, seconds: 3.4, instruction: "Replace 'a' with 'b'.", label: "a → b" },
    { start: 5, end: 9, seconds: 4, instruction: "Raise the pitch by 2 semitones.", label: "Pitch +2" },
  ];

  it("gives every window its own AuK call on one engine, and stitches the rest of the recording around them", () => {
    const wf = expandSpeechEditWorkflow(graph("speech-edit-auk"), windows, { duration: 12, seed: 7, quality: "best" });
    const auk = Object.values(wf).filter((n) => n.class_type === "AuKGenerateEdit");
    expect(auk.map((n) => [n.inputs.instruction, n.inputs.generation_seconds, n.inputs.seed])).toEqual([
      ["Replace 'a' with 'b'.", 3.4, 7],
      ["Raise the pitch by 2 semitones.", 4, 8],
    ]);
    expect(auk.every((n) => n.inputs.nfe_steps === 32 && n.inputs.cfg_strength === 2 && n.inputs.use_prompt_enhancer === false)).toBe(true);
    expect(Object.values(wf).filter((n) => n.class_type === "AuKModelLoader")).toHaveLength(1);
    expect(Object.values(wf).find((n) => n.class_type === "AuKModelLoader")!.inputs.checkpoint_path).toBe("ckpts/AuK/auk_base.safetensors");
    // Each window's cut is from the recording at one rate, at the window's times.
    const cuts = Object.entries(wf).filter(([id]) => /^w\d_cut$/.test(id)).map(([, n]) => [n.inputs.start_index, n.inputs.duration]);
    expect(cuts).toEqual([
      [0, 3],
      [5, 4],
    ]);
    // Every link points at a node that exists, and the save gets the whole chain.
    for (const n of Object.values(wf)) for (const v of Object.values(n.inputs)) if (Array.isArray(v) && typeof v[0] === "string") expect(wf[v[0]], `${v[0]}`).toBeTruthy();
    const save = Object.values(wf).find((n) => n.class_type === "SaveAudio")!;
    // The stitch runs HEADROOM_DB down (AudioMerge rescales anything over 1.0) and is brought back up once before the save.
    const out = wf[(save.inputs.audio as [string, number])[0]];
    expect(out).toMatchObject({ class_type: "AudioAdjustVolume", inputs: { volume: HEADROOM_DB } });
    expect(wf[(out.inputs.audio as [string, number])[0]].class_type).toBe("AudioConcat");
    const gains = Object.entries(wf).filter(([, n]) => n.class_type === "AudioAdjustVolume");
    expect(wf.src_low.inputs.volume).toBe(-HEADROOM_DB);
    // AuK hears each window at the recording's level, and its edit goes back down before the seams.
    for (const k of [1, 2]) {
      expect(wf[`w${k}_in`].inputs).toMatchObject({ volume: HEADROOM_DB, audio: [`w${k}_cut`, 0] });
      expect(wf[`w${k}_auk`].inputs.input_audio).toEqual([`w${k}_in`, 0]);
      expect(wf[`w${k}_low`].inputs).toMatchObject({ volume: -HEADROOM_DB, audio: [`w${k}_auk`, 0] });
    }
    // Down and up in pairs: the net gain is 0 dB.
    expect(gains).toHaveLength(2 + 2 * windows.length);
    expect(gains.reduce((t, [, n]) => t + Number(n.inputs.volume), 0)).toBe(0);
    // Every node is one the server knows (core audio nodes, AuK's checked against its node list).
    for (const n of Object.values(wf)) expect(subset[n.class_type], n.class_type).toBeTruthy();
    // The pieces' lengths add up to the edited recording's length: the original's untouched parts plus each new window.
    const trims = Object.entries(wf).filter(([id, n]) => n.class_type === "TrimAudioDuration" && /^p\d+_(orig|edit)$/.test(id));
    const seams = Object.keys(wf).filter((id) => /_seam$/.test(id)).length;
    const len = trims.reduce((t, [, n]) => t + Math.min(Number(n.inputs.duration), 12 - Number(n.inputs.start_index)), 0) + seams * 0.12;
    expect(len).toBeCloseTo(editedLength(windows, 12), 6);
    // The first window starts the recording: no seam before it.
    expect(seams).toBe(3);
  });

  it("writes a fade-in that ramps to 1 and stays there for the tail AudioMerge trims off", () => {
    const wav = speechFadeWav(0.12);
    const v = new DataView(wav.buffer);
    const n = (wav.length - 44) / 4;
    expect(n).toBe(Math.round(0.12 * 8000) + Math.round(FADE_TAIL * 8000));
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(44 + (Math.round(0.12 * 8000) - 1) * 4, true)).toBe(32767);
    expect(v.getInt16(44 + (n - 1) * 4, true)).toBe(32767);
  });
});

describe("what the ComfyUI provider binds", () => {
  const WAV = "data:audio/wav;base64,UklGRg==";
  const ctx = (op: "speech-edit" | "tts", device?: string, duration = 12) => ({
    generationId: "g",
    op,
    upload: async (_b: Buffer, _t: string, name: string) => name,
    device: async () => device,
    media: () => ({ duration, container: "wav" as const, hasVideo: false, hasAudio: true }),
  });

  it("rebuilds the windows from params.extra, on the GPU's device, with the fade-in it writes", async () => {
    const { prepareWorkflow } = await import("@/server/providers/comfyui");
    const windows: SpeechWindow[] = [{ start: 2, end: 6, seconds: 4.3, instruction: "Replace 'Tuesday' with 'Thursday'.", label: "x" }];
    const p = await prepareWorkflow("speech-edit-auk", { audio: WAV, extra: { speechWindows: windows } }, ctx("speech-edit", "cpu"));
    const nodes = Object.values(p.workflow);
    expect(nodes.find((n) => n.class_type === "AuKModelLoader")!.inputs).toMatchObject({ device: "cpu", dtype: "fp32", checkpoint_path: "ckpts/AuK-Flash/auk_flash.safetensors" });
    expect(nodes.find((n) => n.class_type === "AuKGenerateEdit")!.inputs).toMatchObject({ instruction: "Replace 'Tuesday' with 'Thursday'.", generation_seconds: 4.3 });
    expect(nodes.filter((n) => n.class_type === "LoadAudio").map((n) => n.inputs.audio)).toContain("speech_fade.wav");
    // An NVIDIA GPU: cuda:0 in bf16. Apple's GPU isn't one AuK's nodes take.
    const gpu = await prepareWorkflow("speech-edit-auk", { audio: WAV, extra: { speechWindows: windows } }, ctx("speech-edit", "cuda"));
    expect(Object.values(gpu.workflow).find((n) => n.class_type === "AuKModelLoader")!.inputs).toMatchObject({ device: "cuda:0", dtype: "bf16" });
    await expect(prepareWorkflow("speech-edit-auk", { audio: WAV, extra: { speechWindows: windows } }, ctx("speech-edit", "mps"))).rejects.toThrow(/Apple/);
    await expect(prepareWorkflow("speech-edit-auk", { audio: WAV, extra: {} }, ctx("speech-edit"))).rejects.toThrow(/Nothing to change/);
  });

  it("speaks a line in a sample's voice, or from a description with the loader gone", async () => {
    const { prepareWorkflow } = await import("@/server/providers/comfyui");
    const clone = await prepareWorkflow("speech-tts-auk", { prompt: "Welcome back.", voiceAudio: WAV }, ctx("tts", undefined, 5));
    expect(clone.workflow["3"].inputs).toMatchObject({ instruction: 'Say the following with the same voice: "Welcome back."', input_audio: ["1", 0] });
    expect(Number(clone.workflow["3"].inputs.generation_seconds)).toBeGreaterThan(1);
    const design = await prepareWorkflow("speech-tts-auk", { prompt: "Welcome back.", voiceDescription: "A bright young host" }, ctx("tts"));
    expect(design.workflow["1"]).toBeUndefined();
    expect(design.workflow["3"].inputs.input_audio).toBeUndefined();
    expect(design.workflow["3"].inputs.instruction).toBe('Generate speech based on the following description: "A bright young host". The content to speak is: "Welcome back.".');
  });
});
