import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ComfyWorkflow, Manifest } from "@/lib/comfy";
import { getModel } from "@/lib/catalog";
import { ATTRIBUTIONS, nodePack } from "@/lib/licences";
import { OPENJUTSU_WORKFLOWS } from "@/lib/openjutsu-graphs";
import { resolveWorkflowId } from "@/lib/comfy-variants";

// Genjutsu's Openjutsu modes in the ComfyUI library: nine graphs with pinned weights, their node packs pinned the same in
// packs.json and install-comfyui.sh (opt-in), both patches, and the licences the About page and CREDITS.md read.
const ROOT = process.cwd();
const dir = path.join(ROOT, "workflows/comfyui");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
const packs = JSON.parse(fs.readFileSync(path.join(dir, "packs.json"), "utf8")) as Record<string, { repo: string; commit: string }>;
const install = fs.readFileSync(path.join(ROOT, "scripts/comfy/install-comfyui.sh"), "utf8");
const credits = fs.readFileSync(path.join(ROOT, "CREDITS.md"), "utf8");
const pins = JSON.parse(fs.readFileSync(path.join(dir, "model-pins.json"), "utf8")) as Record<string, { revision: string }>;
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const graph = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as ComfyWorkflow;
const IDS = Object.values(OPENJUTSU_WORKFLOWS);
// Checked against a ComfyUI with the packs installed (validate-workflows.mjs).
const CHECKED = new Set<string>(["video-group-swap-h3","video-scene-edit-h3","video-fix-faces-h3","video-fix-colours","video-scene-describe","video-from-picture-solar","video-from-picture-h3","video-group-swap-h3-one-by-one"]);

const PINS: Record<string, [string, string]> = {
  "ComfyUI-MiniMaxH3-Context-Loop": ["OJ_CONTEXT_LOOP_REF", "43afeffcc570beb5f7382593e79e4b211c7e02f6"],
  "ComfyUI-Fantastic-MiniMaxH3-PromptBuilder": ["OJ_PROMPT_BUILDER_REF", "22e719fe89336c628383363182a4da3cb58d4f9b"],
  "comfyui-h3-oneclick-swap": ["OJ_ONECLICK_SWAP_REF", "e44a56e92920000e675d14be484aea0d7498d63e"],
  "comfyui-image-detail-contrast": ["OJ_DETAIL_CONTRAST_REF", "485a5e246424ce012b998862b45f06d21e8d63b2"],
  Orion4D_FXMax: ["OJ_ORION_FXMAX_REF", "7048e8423ad7d1a6a52119d0d4870c2b7fc2885f"],
  SolarRenderer: ["OJ_SOLAR_REF", "0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d"],
};

describe("the Openjutsu graphs in the library", () => {
  it("are all in the manifest, validated only once checked against ComfyUI, with every weight pinned to a revision and sized", () => {
    for (const id of IDS) {
      const w = entry(id);
      expect(w, id).toBeDefined();
      expect(w.validated, id).toBe(CHECKED.has(id));
      for (const m of w.models) {
        // At a revision in its address, or pinned to one in model-pins.json.
        const pinned = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//.test(m.url ?? "") || /^[0-9a-f]{40}$/.test(pins[m.url ?? ""]?.revision ?? "");
        expect(pinned, `${id} ${m.file}`).toBe(true);
        expect(m.sizeGb, `${id} ${m.file}`).toBeGreaterThan(0);
      }
    }
    // Fuobe's remaps: the NVFP4 H3 text encoder, BFL's Klein file, the rank-64 Solar pair, largest_face.
    const files = (id: string) => entry(id).models.map((m) => m.file);
    expect(files(OPENJUTSU_WORKFLOWS.group)).toContain("qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
    expect(files(OPENJUTSU_WORKFLOWS.group)).toContain("minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors");
    expect(files(OPENJUTSU_WORKFLOWS.prepare)).toContain("flux3-image-klein-int8-convrot.safetensors");
    expect(files(OPENJUTSU_WORKFLOWS.solar)).toEqual(expect.arrayContaining(["solarrenderer_4step_lora_rank64.safetensors", "solarrenderer_control_lora_rank64.safetensors"]));
    for (const id of IDS) expect(JSON.stringify(graph(id)), id).not.toMatch(/int4_convrot|flux3_image_klein_sd|"select":"largest"/);
  });

  it("every media loader is bound", () => {
    for (const id of IDS) {
      const w = entry(id);
      const loaders = Object.entries(graph(id)).filter(([, n]) => n.class_type === "LoadImage" || n.class_type === "VHS_LoadVideo").map(([k]) => k);
      const bound = new Set(Object.values(w.bindings).flatMap((b) => (b ?? []).map((x) => x.node)));
      for (const k of loaders) expect(bound.has(k), `${id} ${k}`).toBe(true);
    }
  });

  it("the models Genjutsu runs point at them, one by one and the H3 renderer as variants", () => {
    expect(getModel("oss-h3-group-swap")!.routes[0].endpoint).toBe(OPENJUTSU_WORKFLOWS.group);
    expect(getModel("oss-from-picture")!.routes[0].endpoint).toBe(OPENJUTSU_WORKFLOWS.solar);
    expect(getModel("oss-h3-motion")!.routes[0]).toMatchObject({ op: "motion-transfer", provider: "comfyui", endpoint: OPENJUTSU_WORKFLOWS.motionH3 });
    expect(getModel("oss-h3-motion")!.name).toBe("MiniMax H3");
    const has = () => true;
    const r = (endpoint: string, extra: Record<string, unknown>) => resolveWorkflowId(endpoint, { op: "x", clips: 0, images: 0, audio2: false, extra, has });
    expect(r(OPENJUTSU_WORKFLOWS.group, { openjutsu: { onePerPerson: true } })).toBe(OPENJUTSU_WORKFLOWS.groupOneByOne);
    expect(r(OPENJUTSU_WORKFLOWS.group, { openjutsu: {} })).toBe(OPENJUTSU_WORKFLOWS.group);
    expect(r(OPENJUTSU_WORKFLOWS.solar, { openjutsu: { renderer: "h3" } })).toBe(OPENJUTSU_WORKFLOWS.h3);
  });

  it("name their packs, pinned the same in packs.json and install-comfyui.sh (opt-in), with both patches", () => {
    for (const [name, [variable, sha]] of Object.entries(PINS)) {
      expect(packs[name]?.commit, name).toBe(sha);
      expect(install, name).toContain(`${variable}="\${${variable}:-${sha}}"`);
    }
    expect(install).toMatch(/OPENJUTSU_MODES:-0\}" = "1"/);
    expect(install).toContain("git -c core.longpaths=true clone");
    for (const p of ["solarrenderer-long-clips.patch", "h3-oneclick-swap-wording.patch"]) {
      expect(fs.existsSync(path.join(ROOT, "scripts/comfy/patches", p)), p).toBe(true);
      expect(install, p).toContain(`patches/${p}`);
    }
    const wording = fs.readFileSync(path.join(ROOT, "scripts/comfy/patches/h3-oneclick-swap-wording.patch"), "utf8");
    expect(wording).toMatch(/^\+.*at the original speed in one continuous take/m);
    expect(wording).not.toMatch(/^\+.*(without adding|do not enter|no part of the original|not replaced)/m);
    // The websocket reconnect fix only serves upstream's proxy: not installed.
    expect(install).not.toMatch(/websocket-reconnect/);
    // Patches keep their bytes (upstream files use CRLF).
    expect(fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8")).toContain("scripts/comfy/patches/*.patch -text");
  });

  it("their packs and the graphs' source are credited", () => {
    for (const id of IDS) for (const n of entry(id).customNodes) expect(nodePack(n.name), `${id} ${n.name}`).toBeDefined();
    expect(ATTRIBUTIONS.some((a) => a.url === "https://github.com/D3voz/openjutsu" && a.licence === "MIT")).toBe(true);
    expect(credits).toContain("D3voz");
    expect(credits).toContain("SolarRenderer");
  });
});
