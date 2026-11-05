import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import type { CinemaGenerateInput } from "@/lib/catalog/cinema";
import type { ComfyWorkflow, Manifest } from "@/lib/comfy";
import type { WorldScript } from "@/lib/world";

/**
 * World mode (nm10-hy-nomas-world): Hy-Nomas's graph in the library (its pack and weights pinned, checked against the
 * port's node list, which isn't on the validation server), the graph rebuilt per turn, the turn state, the provider's
 * bindings, Cinema's World take (open engine only) and the GPU pre-flight row.
 */

const tmp = tempDir("fuobe-world-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const cinema = await import("@/server/cinema");
const generateRoute = await import("@/app/api/cinema/projects/[id]/generate/route");
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { STUDIO_ROWS } = await import("@/server/gpu/tools");
const { getModel, getPreset } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { planCinema, worldTake, WORLD_OPEN_ONLY, WORLD_SOUND } = await import("@/lib/catalog/cinema");
const { NODE_PACKS } = await import("@/lib/licences");
const W = await import("@/lib/world");
const { parseScript } = await import("@/lib/world-path");

beforeAll(() => {
  setSetting("demoMode", "auto");
  setSetting("enhanceProvider", "none");
});

const dir = path.join(process.cwd(), "workflows/comfyui");
const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
const manifest = read<Manifest>("manifest.json");
const packs = read<Record<string, { repo: string; commit: string; subdir: string | null; registry: unknown }>>("packs.json");
const pins = read<Record<string, { revision: string; sizeBytes: number; sha256?: string }>>("model-pins.json");
const requirements = read<{ workflows: Record<string, { packs: Record<string, string[]>; files: string[]; optional: string[]; vramGb: number }> }>("requirements.json");
type Info = { python_module: string; input: { required: Record<string, [unknown, Record<string, unknown>?]>; optional?: Record<string, [unknown, Record<string, unknown>?]> }; output: string[] };
const subset = read<Record<string, Info>>("object_info.subset.json");
const ID = "world-hy-nomas-turn";
const entry = manifest.workflows.find((w) => w.id === ID)!;
const template = read<ComfyWorkflow>(`${ID}.json`);

/** The inputs of the port's nodes at a89e0515 (nomas/nodes.py define_schema). */
const PORT_NODES: Record<string, string[]> = {
  NomasWorldPrompt: ["perspective", "style", "subject", "subject_details", "scene", "action", "seconds"],
  NomasCameraPath: ["script"],
  NomasWorldGenerate: ["model", "clip", "turn", "camera", "seed", "width", "height", "steps", "history"],
  NomasWorldContinue: ["model", "clip", "world", "change", "action", "camera", "seconds", "steps"],
};

/** ComfyUI's own check of a prompt, against the node list: known classes, known inputs, required ones present, links typed. */
function validate(wf: ComfyWorkflow): string[] {
  const problems: string[] = [];
  for (const [id, n] of Object.entries(wf)) {
    const info = subset[n.class_type];
    if (!info) {
      problems.push(`${id}: ${n.class_type} unknown`);
      continue;
    }
    const all = { ...info.input.required, ...(info.input.optional ?? {}) };
    for (const [k, v] of Object.entries(n.inputs)) {
      if (k.includes(".")) continue; // dynamic combo children (SaveVideo format.codec)
      const spec = all[k];
      if (!spec) problems.push(`${id}.${k}: not an input of ${n.class_type}`);
      else if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "number") {
        const from = wf[v[0]];
        if (!from) problems.push(`${id}.${k}: links to missing node ${v[0]}`);
        else {
          const out = subset[from.class_type]?.output?.[v[1]];
          const want = spec[0];
          if (typeof want === "string" && want !== "*" && out !== want) problems.push(`${id}.${k}: ${out} into ${want}`);
        }
      } else if (/_name$/.test(k)) continue; // a model file: the validation server lists placeholders, not the weights
      else if (Array.isArray(spec[0]) && !spec[0].includes(v as never) && (spec[0] as unknown[]).length) problems.push(`${id}.${k}: ${String(v)} not offered`);
      else if (spec[0] === "COMBO" && !(spec[1]?.options as unknown[] | undefined)?.some((o) => o === v || (o as { key?: unknown })?.key === v)) problems.push(`${id}.${k}: ${String(v)} not offered`);
    }
    for (const k of Object.keys(info.input.required)) if (!(k in n.inputs)) problems.push(`${id}.${k}: required, missing`);
  }
  return problems;
}

const script = (over: Partial<WorldScript> = {}): WorldScript =>
  W.normalizeWorld({
    opening: { words: "A small orange fox stands on a stone path in a forest at dusk.", subject: "a small orange fox", details: "Orange fur, a white chest.", action: "The fox walks along the path.", move: "zoom_in", seconds: 5 },
    turns: [
      { words: "a wooden bridge crosses a glowing stream ahead", action: "a small orange fox trots onto the bridge", move: "orbit_90_ccw", seconds: 4 },
      { words: "rain begins to fall", move: "still", seconds: 3 },
    ],
    seed: 1234,
    ...over,
  });

describe("Hy-Nomas's graph in the library", () => {
  it("waits for the pinned port, lists its weights pinned, and says each file's licence", () => {
    expect(entry.capability).toBe("world-turn");
    expect(entry.expand).toBe("world");
    expect(entry.validated).toBe(false);
    expect(entry.customNodes.map((c) => c.name)).toEqual(["ComfyUI-HyNomas"]);
    expect(packs["ComfyUI-HyNomas"]).toMatchObject({ repo: "https://github.com/Nynxz/ComfyUI-HyNomas", commit: "a89e0515619924da71093aa3fe52dbb7104cb06e", registry: null });
    expect(entry.license).toMatch(/^Apache-2\.0 \(Hy-Nomas DiT/);
    expect(entry.license).toMatch(/NVIDIA One-Way Noncommercial License \(NON-COMMERCIAL/);
    expect(entry.vramGb).toBe(24);
    const files = entry.models.filter((m) => !m.optional);
    expect(files.map((m) => m.file).sort()).toEqual(["nomas_dit_distilled_int8_convrot.safetensors", "nomas_pixelumm_vae_bf16.safetensors", "qwen_2.5_vl_7b.safetensors"]);
    // About 25 GB of new files beside the text encoder Qwen-Image already pins.
    const own = files.filter((m) => m.file.startsWith("nomas_")).reduce((s, m) => s + (m.sizeGb ?? 0), 0);
    expect(own).toBeGreaterThan(24);
    expect(own).toBeLessThan(25.5);
    for (const m of entry.models.filter((x) => x.file.startsWith("nomas_"))) {
      const pin = pins[m.url!];
      expect(pin, m.file).toMatchObject({ revision: "e8ddc4bfa664d69213930552493c220c3af56f41" });
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(requirements.workflows[ID].packs["ComfyUI-HyNomas"]).toEqual(["NomasCameraPath", "NomasWorldContinue", "NomasWorldGenerate", "NomasWorldPrompt"]);
    expect(requirements.workflows[ID].optional).toEqual(["diffusion_models/nomas_dit_distilled_bf16.safetensors"]);
    const sh = fs.readFileSync(path.join(process.cwd(), "scripts/comfy/install-comfyui.sh"), "utf8");
    expect(sh).toContain(`[ComfyUI-HyNomas]="https://github.com/Nynxz/ComfyUI-HyNomas ${packs["ComfyUI-HyNomas"].commit}"`);
    const pack = NODE_PACKS.find((p) => p.name === "ComfyUI-HyNomas")!;
    expect(pack).toBeTruthy();
    expect(JSON.stringify(pack)).toMatch(/Apache-2\.0/);
  });

  it("follows the port's node list, and the template passes ComfyUI's checks against it", () => {
    for (const [cls, inputs] of Object.entries(PORT_NODES)) {
      expect(subset[cls].python_module).toBe("custom_nodes.ComfyUI-HyNomas");
      expect(Object.keys({ ...subset[cls].input.required, ...subset[cls].input.optional }).sort()).toEqual([...inputs].sort());
    }
    expect(subset.NomasWorldGenerate.output).toEqual(["LATENT", "NOMAS_WORLD"]);
    expect(validate(template)).toEqual([]);
    expect(template["2"].inputs).toMatchObject({ clip_name: "qwen_2.5_vl_7b.safetensors", type: "qwen_image" });
    expect(template["6"].inputs).toMatchObject({ width: 1280, height: 704, steps: 8, history: "window" });
  });
});

describe("the graph for one turn", () => {
  it("chains the opening and every turn up to the one asked for, and saves that turn alone", () => {
    const s = script();
    for (let k = 0; k <= 2; k++) {
      const wf = W.expandWorldWorkflow(template, s, k);
      expect(validate(wf), `turn ${k}`).toEqual([]);
      const turns = Object.entries(wf).filter(([, n]) => n.class_type === "NomasWorldContinue");
      expect(turns.map(([id]) => id)).toEqual(Array.from({ length: k }, (_, i) => `w${i + 1}`));
      expect(wf["9"].inputs).toEqual({ samples: [k ? `w${k}` : "w0", 0], trim_amount: W.latentsBefore(s, k) });
    }
  });

  it("gives the same nodes the same ids and inputs every time, so ComfyUI reuses the turns it already made", () => {
    const s = script();
    const a = W.expandWorldWorkflow(template, s, 1);
    const b = W.expandWorldWorkflow(template, s, 2);
    for (const id of ["o", "c0", "w0", "c1", "w1"]) expect(b[id], id).toEqual(a[id]);
    // Changing turn 2 leaves the opening and turn 1 as they were.
    const c = W.expandWorldWorkflow(template, { ...s, turns: [s.turns[0], { ...s.turns[1], words: "snow begins to fall" }] }, 2);
    for (const id of ["o", "c0", "w0", "c1", "w1"]) expect(c[id], id).toEqual(b[id]);
    expect(c.w2.inputs.change).toBe("snow begins to fall");
  });

  it("writes the subject as the port's token, places it in view, and leaves a still turn without a camera", () => {
    const wf = W.expandWorldWorkflow(template, script(), 2);
    expect(wf.o.inputs).toMatchObject({ subject: "a small orange fox", scene: "<|Subject1|> stands on a stone path in a forest at dusk.", action: "The fox walks along the path.", seconds: 5, perspective: "third-person follow" });
    expect(wf.w1.inputs).toMatchObject({ change: "a wooden bridge crosses a glowing stream ahead", action: "<|Subject1|> trots onto the bridge", seconds: 4, world: ["w0", 1], camera: ["c1", 0] });
    expect(wf.w2.inputs.camera).toBeUndefined();
    expect(wf.c2).toBeUndefined();
    expect(parseScript(String(wf.c0.inputs.script))).toHaveLength(5 * 24);
    expect(parseScript(String(wf.c1.inputs.script))).toHaveLength(4 * 24);
    expect(W.openingInputs({ words: "A misty valley at dawn.", move: "still", seconds: 5, subject: "a heron" }).scene).toBe("A misty valley at dawn. <|Subject1|> is in view.");
    expect(W.openingInputs({ words: "A misty valley at dawn.", move: "still", seconds: 5 }).subject).toBe("the camera");
  });

  it("counts each turn's latent frames as the port does", () => {
    // A camera move makes frames + 1 poses: 5 s → 120 ticks → 121 frames → 31 latents. Words alone: 120 frames → 30.
    expect(W.turnLatents({ move: "zoom_in", seconds: 5 })).toBe(31);
    expect(W.turnLatents({ move: "still", seconds: 5 })).toBe(30);
    expect(W.turnLatents({ move: "still", seconds: 3 })).toBe(18);
    expect(W.latentsBefore(script(), 2)).toBe(31 + 25);
    expect(W.clipSeconds({ move: "still", seconds: 3 })).toBe(3);
  });

  it("refuses a script it can't run", () => {
    expect(() => W.expandWorldWorkflow(template, script({ opening: { words: "", move: "still", seconds: 5 } }), 0)).toThrow(/Describe the world first/);
    expect(() => W.expandWorldWorkflow(template, script(), 5)).toThrow(/isn't in this world/);
    const empty = script({ turns: [{ words: "", move: "still", seconds: 5 }] });
    expect(W.worldProblem(empty, 1)).toMatch(/needs words or a camera move/);
    // Ten turns of 12 s are the whole 120 s the port's noise bank holds: the longest world fits.
    const long = script({ opening: { words: "A plain.", move: "still", seconds: 12 }, turns: Array.from({ length: 12 }, () => ({ words: "on", move: "still", seconds: 12 })) });
    expect(long.turns).toHaveLength(9);
    expect(W.worldSeconds(long)).toBe(120);
    expect(W.worldProblem(long, 9)).toBeNull();
  });
});

describe("the turn state", () => {
  const s = script();
  const take = (id: string, turn: number, made: string, status = "succeeded", createdAt = 1000, url = `/api/files/${id}.mp4`) => ({
    id,
    status,
    createdAt,
    outputs: status === "succeeded" ? [{ url, kind: "video" }] : [],
    take: { world: { turn, made } },
  });

  it("tidies a script: lengths on the half second within 3–12 s, known moves, at most 10 turns", () => {
    const n = W.normalizeWorld({ opening: { words: " x ", move: "warp", seconds: 1.3 }, turns: Array.from({ length: 12 }, () => ({ words: "y", move: "orbit_360", seconds: 20.2 })), seed: -1 });
    expect(n.opening).toMatchObject({ words: "x", move: "still", seconds: 3 });
    expect(n.turns).toHaveLength(9);
    expect(n.turns[0]).toMatchObject({ move: "orbit_360", seconds: 12 });
    expect(n.seed).toBe(0);
  });

  it("keeps a turn's clip only while nothing up to it has changed", () => {
    const takes = [take("a", 0, W.scriptKey(s, 0)), take("b", 1, W.scriptKey(s, 1))];
    let r = W.clipsFromTakes(s, takes);
    expect(r.states).toEqual(["done", "done", "none"]);
    expect(W.nextTurn(s, r.clips)).toBe(2);
    expect(W.canRun(s, r.clips, 2)).toBe(true);
    // Turn 1's words change: its clip and everything after it are out of date; the opening stays.
    const edited = { ...s, turns: [{ ...s.turns[0], words: "a stone bridge" }, s.turns[1]] };
    r = W.clipsFromTakes(edited, takes);
    expect(r.states).toEqual(["done", "stale", "none"]);
    expect(W.nextTurn(edited, r.clips)).toBe(1);
    expect(W.canRun(edited, r.clips, 2)).toBe(false);
  });

  it("says a turn is filming until its clip arrives, and doesn't count a failed one", () => {
    const r = W.clipsFromTakes(s, [take("a", 0, W.scriptKey(s, 0), "running"), take("b", 1, W.scriptKey(s, 1), "failed")]);
    expect(r.states.slice(0, 2)).toEqual(["running", "failed"]);
    expect(r.clips[0]).toMatchObject({ generationId: "a" });
    expect(r.clips[0]?.url).toBeUndefined();
    expect(W.canRun(s, r.clips, 1)).toBe(false);
  });

  it("Redo from here keeps the turns before it and drops the clips from it on", () => {
    const takes = [take("a", 0, W.scriptKey(s, 0), "succeeded", 1000), take("b", 1, W.scriptKey(s, 1), "succeeded", 1000), take("c", 2, W.scriptKey(s, 2), "succeeded", 1000)];
    const r = W.clipsFromTakes(s, takes, { 1: 5000 });
    expect(r.clips.map((c) => c?.generationId)).toEqual(["a", undefined, undefined]);
    expect(W.redoFrom(W.clipsFromTakes(s, takes).clips, 1).map((c) => c?.generationId)).toEqual(["a"]);
    // The new take of turn 1 counts again.
    const again = W.clipsFromTakes(s, [...takes, take("d", 1, W.scriptKey(s, 1), "succeeded", 6000)], { 1: 5000 });
    expect(again.clips.map((c) => c?.generationId)).toEqual(["a", "d", undefined]);
  });

  it("matches a take filed for the tidied script while the fields still hold spaces or an odd length", () => {
    const typed = { ...s, opening: { ...s.opening, words: `${s.opening.words} \n`, subject: ` ${s.opening.subject ?? "a fox"} ` }, turns: [{ ...s.turns[0], words: ` ${s.turns[0].words} `, seconds: 4.3 }, s.turns[1]] };
    const tidy = W.normalizeWorld(typed);
    expect(tidy.turns[0].seconds).toBe(4.5);
    // The server keys the take from the tidied script (worldTake); the browser keys the script as typed.
    const filed = worldTake({ world: { script: typed, turn: 1 } })!;
    const takes = [take("a", 0, worldTake({ world: { script: typed, turn: 0 } })!.made), take("b", 1, filed.made)];
    const r = W.clipsFromTakes(typed, takes);
    expect(r.states).toEqual(["done", "done", "none"]);
    expect(W.nextTurn(typed, r.clips)).toBe(2);
    expect(W.canRun(typed, r.clips, 2)).toBe(true);
    expect(W.scriptKey(typed, 1)).toBe(W.scriptKey(tidy, 1));
  });

  it("keeps a Redo from here after a reload: a later turn's take older than the redone turn's isn't current", () => {
    const takes = [take("a", 0, W.scriptKey(s, 0), "succeeded", 1000), take("b", 1, W.scriptKey(s, 1), "succeeded", 2000), take("c", 2, W.scriptKey(s, 2), "succeeded", 3000)];
    expect(W.clipsFromTakes(s, takes).clips.map((c) => c?.generationId)).toEqual(["a", "b", "c"]);
    // Turn 1 filmed again (no redoAt: the panel was closed or the page reloaded): turn 2's old take no longer counts.
    const redone = [...takes, take("d", 1, W.scriptKey(s, 1), "running", 4000)];
    const r = W.clipsFromTakes(s, redone);
    expect(r.clips.map((c) => c?.generationId)).toEqual(["a", "d", undefined]);
    expect(r.states).toEqual(["done", "running", "none"]);
    expect(W.exportClips(s, r.clips)).toBeNull();
    // A redo that failed leaves the earlier film standing.
    const failed = W.clipsFromTakes(s, [...takes, take("e", 1, W.scriptKey(s, 1), "failed", 4000)]);
    expect(failed.clips.map((c) => c?.generationId)).toEqual(["a", "b", "c"]);
  });

  it("exports only when every turn has a finished, current clip", () => {
    const done = [0, 1, 2].map((k) => take(`t${k}`, k, W.scriptKey(s, k)));
    expect(W.exportClips(s, W.clipsFromTakes(s, done).clips)).toEqual(["/api/files/t0.mp4", "/api/files/t1.mp4", "/api/files/t2.mp4"]);
    expect(W.exportClips(s, W.clipsFromTakes(s, done.slice(0, 2)).clips)).toBeNull();
  });
});

describe("the provider", () => {
  it("rebuilds the graph for the turn asked for, on the script's own seed", async () => {
    const s = script();
    const out = await prepareWorkflow(ID, { prompt: "", seed: 7, extra: { world: s, turn: 2 } }, { generationId: "g-world", op: "world-turn", upload: async (_d, _t, name) => `up_${name}` });
    const wf = out.workflow;
    expect(wf.w0.inputs).toMatchObject({ seed: 1234, width: 1280, height: 704, steps: 8, history: "window", turn: ["o", 0], camera: ["c0", 0] });
    expect(wf.w2.inputs).toMatchObject({ world: ["w1", 1], change: "rain begins to fall", seconds: 3 });
    expect(wf["9"].inputs.trim_amount).toBe(56);
    expect(wf["12"].inputs.filename_prefix).toBe("fuobe/g-world");
    expect(validate(wf)).toEqual([]);
  });

  it("refuses a run with no script, or a turn it doesn't have", async () => {
    const ctx = { generationId: "g", op: "world-turn" as const, upload: async () => "x" };
    await expect(prepareWorkflow(ID, { prompt: "", extra: {} }, ctx)).rejects.toThrow(/Describe the world first/);
    await expect(prepareWorkflow(ID, { prompt: "", extra: { world: script(), turn: 4 } }, ctx)).rejects.toThrow(/isn't in this world/);
  });

  it("plans as a free open-engine run with the script's words checked", () => {
    const model = getModel(W.WORLD_MODEL)!;
    expect(model.engine).toBe("open");
    expect(model.hidden).toBe(true);
    expect(model.routes.map((r) => [r.provider, r.endpoint, r.op])).toEqual([["comfyui", ID, "world-turn"]]);
    const ok = planGeneration({ feature: "cinema-world", modelId: model.id, op: "world-turn", params: { numOutputs: 1, extra: { world: script(), turn: 1 } } } as never, getModel, getPreset);
    expect(ok).toBeTruthy();
    expect(() => planGeneration({ feature: "cinema-world", modelId: model.id, op: "world-turn", params: { numOutputs: 1, extra: {} } } as never, getModel, getPreset)).toThrow(/Describe the world first/);
  });
});

describe("Cinema's World take", () => {
  const ctx = { cloudAllowed: true };
  const take = (engine: "open" | "cloud", world: CinemaGenerateInput["world"]): CinemaGenerateInput => ({ engine, mode: "video", action: "world", prompt: "", settings: {}, world });

  it("runs on your GPU only: the cloud says so and offers no stand-in", () => {
    const plan = planCinema(take("cloud", { script: script(), turn: 0 }), ctx);
    expect(plan.blocker).toBe(WORLD_OPEN_ONLY);
    expect(plan.steps).toEqual([]);
  });

  it("plans one turn: free, 1280 × 704 at 24 fps, no sound", () => {
    const plan = planCinema(take("open", { script: script(), turn: 1 }), ctx);
    expect(plan.blocker).toBeUndefined();
    expect(plan.costUsd).toBe(0);
    expect(plan.model.id).toBe(W.WORLD_MODEL);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].request).toMatchObject({ feature: "cinema-world", op: "world-turn", params: { extra: { turn: 1 } } });
    expect(plan.notes.join(" ")).toMatch(/Turn 1 of 2 on your GPU/);
    expect(plan.notes).toContain(WORLD_SOUND);
  });

  it("exports the turns as one film with the open engine's join", () => {
    const plan = planCinema(take("open", { script: script(), turn: 2, join: ["/api/files/a.mp4", "/api/files/b.mp4", "/api/files/c.mp4"] }), ctx);
    expect(plan.blocker).toBeUndefined();
    expect(plan.steps[0].request).toMatchObject({ modelId: W.WORLD_JOIN, op: "concat", inputs: { videos: ["/api/files/a.mp4", "/api/files/b.mp4", "/api/files/c.mp4"] } });
  });

  it("files a turn in demo mode as a take that remembers its turn and script", async () => {
    const p = cinema.createProject({ name: "Worlds" });
    const req = new Request("http://x/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: take("open", { script: script(), turn: 0 }) }) });
    const res = await generateRoute.POST(req, { params: Promise.resolve({ id: p.id }) });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { items: { id: string; feature: string; op: string }[] };
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ feature: "cinema-world", op: "world-turn" });
    const item = cinema.listItems(p.id)[0];
    expect(item.take?.action).toBe("world");
    expect(item.take?.world).toMatchObject({ turn: 0, made: W.scriptKey(script(), 0) });
    expect(item.take?.world?.script.turns).toEqual([]);
    expect(gens.getGeneration(out.items[0].id)!.provider).toBe("mock");
    // The cloud is refused before anything runs.
    const cloud = new Request("http://x/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: take("cloud", { script: script(), turn: 0 }) }) });
    const refused = await generateRoute.POST(cloud, { params: Promise.resolve({ id: p.id }) });
    expect(refused.status).toBe(422);
  });

  it("films a 60 s walk-through for Assist: five 12 s turns, each after the one before, then joined", async () => {
    const { worldFilmSteps } = await import("@/lib/catalog/cinema");
    const { worldFilmScript } = await import("@/server/assist/studio-tools");
    const s = worldFilmScript({ scene: "A stone path through a forest at dusk", turns: Array.from({ length: 4 }, (_, i) => ({ words: `turn ${i + 1}`, move: "orbit_90_ccw" })), seed: 9 });
    expect(W.worldSeconds(s)).toBe(60);
    const steps = worldFilmSteps(s, "open");
    expect(steps.map((x) => x.key)).toEqual(["turn0", "turn1", "turn2", "turn3", "turn4", "join"]);
    expect(steps[3].after).toEqual(["turn2"]);
    expect(steps[3].request.params?.extra).toMatchObject({ turn: 3, world: { seed: 9 } });
    expect(steps[5]).toMatchObject({ after: ["turn0", "turn1", "turn2", "turn3", "turn4"], request: { modelId: W.WORLD_JOIN, op: "concat" } });
    expect(() => worldFilmSteps(s, "cloud")).toThrow(WORLD_OPEN_ONLY);
  });

  it("has a row on the GPU pre-flight board", () => {
    const row = STUDIO_ROWS.find((r) => r.href === "/cinema?world=1")!;
    expect(row).toMatchObject({ label: "World mode", group: "Video" });
    expect(row.steps?.map((s) => [s.modelId, s.op])).toEqual([
      [W.WORLD_MODEL, "world-turn"],
      [W.WORLD_JOIN, "concat"],
    ]);
    expect(new Set(STUDIO_ROWS.map((r) => r.href)).size).toBe(STUDIO_ROWS.length);
  });
});
