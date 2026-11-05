import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildIndex, hfParts, indexHash, loadInputs, packOfClass, PT_EXTENSIONS } from "../scripts/comfy/build-requirements.mjs";
import { CUSTOM_NODE_REPOS } from "../scripts/comfy/library.spec.mjs";
import type { Manifest } from "@/lib/comfy";
import type { RequirementIndex } from "@/lib/gpu/types";

/** The GPU pre-flight's requirement index (workflows/comfyui/requirements.json) against the library it is built from. */

const LIBRARY = path.join(process.cwd(), "workflows/comfyui");
const read = (f: string) => fs.readFileSync(path.join(LIBRARY, f), "utf8");
const text = read("requirements.json");
const index = JSON.parse(text) as RequirementIndex;
const manifest = JSON.parse(read("manifest.json")) as Manifest;
type PackPin = { repo: string; commit: string; registry: { id: string; version: string } | null; subdir: string | null; file?: string; folders: string[]; isolated: boolean };
const packs = JSON.parse(read("packs.json")) as Record<string, PackPin>;
const pins = JSON.parse(read("model-pins.json")) as Record<string, { revision: string; sizeBytes: number; sha256?: string }>;
const script = (f: string) => fs.readFileSync(path.join(process.cwd(), "scripts/comfy", f), "utf8");
/** `[Name]="repo commit"` and `NODES[Name]="repo commit"` lines of an install script. */
const scriptPins = (sh: string) => Object.fromEntries([...sh.matchAll(/\[([^\]]+)\]="(\S+) ([0-9a-f]{40})"/g)].map((m) => [m[1], { repo: m[2], commit: m[3] }]));
const files = Object.entries(index.files);
/** A pinned GitHub release asset: the one model file that isn't on Hugging Face. */
const RELEASE_ASSET = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+$/;

describe("requirements.json", () => {
  it("is what build-requirements.mjs makes of the committed library (run node scripts/comfy/build-requirements.mjs)", () => {
    const fresh = buildIndex(loadInputs(LIBRARY));
    expect(index).toEqual(fresh);
    expect(index.hash).toBe(indexHash(index));
  });

  it("covers every workflow, file and pack of the manifest", () => {
    expect(Object.keys(index.workflows).sort()).toEqual(manifest.workflows.map((w) => w.id).sort());
    const keys = new Set(manifest.workflows.flatMap((w) => w.models.map((m) => `${m.folder}/${m.file}`)));
    expect(Object.keys(index.files).sort()).toEqual([...keys].sort());
    for (const w of manifest.workflows) for (const n of w.customNodes) expect(packs[n.name], `${w.id}: ${n.name} in packs.json`).toBeDefined();
    expect(Object.keys(index.packs).sort()).toEqual([...new Set(manifest.workflows.flatMap((w) => w.customNodes.map((n) => n.name)))].sort());
  });

  it("puts every class of every graph in core or in a pack, and the pack is the one the manifest names", () => {
    for (const w of manifest.workflows) {
      const graph = JSON.parse(read(w.file)) as Record<string, { class_type: string }>;
      const iw = index.workflows[w.id];
      const placed = [...iw.core, ...Object.values(iw.packs).flat()];
      expect(new Set(placed).size, w.id).toBe(placed.length);
      // Classes the app adds per run (runtimeNodes: the References clip loaders) count as the graph's.
      expect(placed.sort(), w.id).toEqual([...new Set([...Object.values(graph).map((n) => n.class_type), ...(w.runtimeNodes ?? [])])].sort());
      expect(Object.keys(iw.packs).sort(), w.id).toEqual(w.customNodes.map((n) => n.name).sort());
      for (const [p, classes] of Object.entries(iw.packs)) for (const c of classes) expect(index.packs[p].classes, `${w.id}: ${c}`).toContain(c);
    }
  });

  it("pins every file to a size, a Hugging Face URL and (unless gated) a revision, or a release asset to its tag and hash", () => {
    for (const [key, f] of files) {
      expect(f.sizeBytes, key).toBeGreaterThan(0);
      expect(f.pinnedUrl, key).toBeTruthy();
      if (RELEASE_ASSET.test(f.url)) {
        // A GitHub release asset (Zen Image Edit's adapter): its owner can replace it, so its sha256 rides along to be checked.
        expect(f.pinnedUrl, key).toBe(f.url);
        expect(f.sha256, key).toMatch(/^[0-9a-f]{64}$/);
        continue;
      }
      expect(hfParts(f.url), key).not.toBeNull();
      const rev = hfParts(f.pinnedUrl)!.rev;
      // Only gated files can't be read without a token: they keep the plain URL until a maintainer refreshes with HF_TOKEN.
      if (!f.gated) expect(rev, key).toMatch(/^[0-9a-f]{40}$/);
      if (f.sha256) expect(f.sha256, key).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const [url, p] of Object.entries(pins)) {
      // A release asset's revision is its tag, in its URL; a Hugging Face file's a commit.
      if (RELEASE_ASSET.test(url)) expect(url, url).toContain(`/releases/download/${p.revision}/`);
      else expect(p.revision, url).toMatch(/^[0-9a-f]{40}$/);
      expect(p.sizeBytes, url).toBeGreaterThan(0);
    }
  });

  it("downloads from huggingface.co, and only Zen Image Edit's adapter from its GitHub release", () => {
    const hosts = new Set(files.flatMap(([, f]) => [new URL(f.url).host, new URL(f.pinnedUrl).host]));
    expect([...hosts].sort()).toEqual(["github.com", "huggingface.co"]);
    expect(files.filter(([, f]) => new URL(f.url).host === "github.com").map(([k]) => k)).toEqual(["text_encoders/adapter_v12.safetensors"]);
  });

  it("marks exactly the LTX-2.5 files (the model's repo, and Lightricks' Restore and Detail Refine IC-LoRAs), FLUX 3 Image Klein's and Bria VRMBG 3.0's as gated", () => {
    const gated = files.filter(([, f]) => f.gated).map(([k]) => k);
    const gatedUrl = (u: string) => /\/Lightricks\/LTX-2\.5(\/|-22b-IC-LoRA-(Restore|Refine-Details)\/)/.test(u) || u.includes("/black-forest-labs/flux-3-image-klein-comfy/") || u.includes("/briaai/VRMBG-3.0/");
    expect(gated.sort()).toEqual(files.filter(([, f]) => gatedUrl(f.url)).map(([k]) => k).sort());
    expect(gated.length).toBeGreaterThan(0);
  });

  it("says how each file is seen: its loader's list, the folder listing, or not at all", () => {
    for (const [key, f] of files) {
      if (f.presence === "loader") {
        expect(f.loaders?.length, key).toBeGreaterThan(0);
      } else {
        expect(f.loaders, key).toBeUndefined();
        if (f.presence === "list") expect(PT_EXTENSIONS, key).toContain(path.extname(f.file).toLowerCase());
      }
    }
    // A .gguf or .onnx never shows in /experiment/models: it is checked through its loader.
    for (const [key, f] of files.filter(([, f]) => /\.(gguf|onnx)$/.test(f.file))) expect(f.presence, key).toBe("loader");
  });

  it("names the pack that registers a pack-only model folder", () => {
    for (const [key, f] of files) {
      const owner = Object.entries(packs).find(([, p]) => p.folders.includes(f.folder))?.[0];
      expect(f.packFolder, key).toBe(owner);
    }
    expect(index.files["mmaudio/mmaudio_large_44k_v2_fp16.safetensors" as keyof typeof index.files].packFolder).toBe("ComfyUI-MMAudio");
  });

  it("reads every pack's classes one by one when /object_info can't be read", () => {
    for (const p of Object.values(index.packs)) for (const c of p.classes) expect(index.sentinels).toContain(c);
    expect(index.sentinels).toContain("ComfyMathExpression");
  });

  it("installs every pack by hand until a registry version is validated", () => {
    for (const [name, p] of Object.entries(index.packs)) expect(p.install, name).toBe(p.registry?.version ? "registry" : "manual");
    expect(index.packs.h3_character_swap.subdir).toBe("worker_nodes/h3_character_swap");
    expect(index.packs["ComfyUI-ThinkSound_Wrapper"].isolated).toBe(true);
  });

  // Raised together with Restore & colourise's graph and pack, which took the index from 202.1 to
  // 204.4 KB (24.9 to 25.3 KB gzipped), leaving the old 200 KB / 25 KB no room. Each graph adds about 1-2.5 KB raw and
  // 0.2-0.5 KB gzipped, so 216 KB / 27 KB leaves room for the next few graphs (n7-3's among them) while still catching a
  // build that bloats it. The server parses it once per change, and /api/gpu/requirements serves it compressed.
  // FLUX 3 Image Klein's three graphs and seven files (nm10-flux3-klein) add about 6 KB. Clean up voice (its pack, two
  // weight files and two graphs) adds about 0.5 KB gzipped, and Live edit (its node file, LoRA and graph) about 1.6 KB.
  // Open-H3 Regenerate (its graph, two packs and three files) and Blockout to film's depth graph took it to 214 KB /
  // 27.1 KB gzipped, so the budget moved to 256 KB / 32 KB. Keyframe animation, Idol 3D, full songs, Remove a person, Clean up
  // dialogue and MiniMax H3 on smaller cards (eleven graphs and their files) took it to 264 KB / 33.1 KB gzipped, so the budget
  // moves to 320 KB / 40 KB. Green screen, RTX Video, Edit speech, Pika H3 Flex, Kandinsky 6.0, World mode, MiniMax H3's 2K
  // draft and finish, Hi3D and Idol 3D's clean splats, quick mesh and four views beside them took it to 310 KB / 38.7 KB gzipped.
  it("stays within its size budget (320 KB, 40 KB gzipped)", () => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(320 * 1024);
    expect(zlib.gzipSync(text).length).toBeLessThanOrEqual(40 * 1024);
  });
});

describe("which pack a node class belongs to (packOfClass)", () => {
  // A ComfyUI with comfyui-workflow-encrypt reports that pack as the module of other packs' classes.
  const WRAPPED = "custom_nodes.comfyui-workflow-encrypt";

  it("takes the pack PACK_CLASSES names, whatever module the server reports", () => {
    expect(packOfClass("AUSBOSS_NODES_StitchInpaint", WRAPPED)).toBe("ausboss-nodes");
    expect(packOfClass("Krea2EditGroundedEncode", WRAPPED)).toBe("comfyui-krea2edit");
    expect(packOfClass("H3RelayWindowPlan", undefined)).toBe("h3-relay");
  });

  it("else the module's pack, else the pack the committed subset recorded", () => {
    expect(packOfClass("VHS_LoadVideo", "custom_nodes.ComfyUI-VideoHelperSuite")).toBe("ComfyUI-VideoHelperSuite");
    expect(packOfClass("ImageResizeKJv2", WRAPPED, "custom_nodes.ComfyUI-KJNodes")).toBe("ComfyUI-KJNodes");
  });

  it("refuses to guess when only the wrapper names a class", () => {
    expect(() => packOfClass("SomeNewNode", WRAPPED)).toThrow(/can't tell which pack SomeNewNode/);
    expect(() => packOfClass("SomeNewNode", WRAPPED, WRAPPED)).toThrow(/PACK_CLASSES/);
  });

  it("records the committed subset's custom classes under packs that packs.json pins", () => {
    const subset = JSON.parse(read("object_info.subset.json")) as Record<string, { python_module?: string } | null>;
    for (const [cls, e] of Object.entries(subset)) {
      const pack = /^custom_nodes.([^.]+)/.exec(e?.python_module ?? "")?.[1];
      if (pack) expect(packs[pack], `${cls}: ${pack}`).toBeDefined();
    }
  });
});

describe("packs.json: the single source of pack pins", () => {
  it("equals the install scripts' pins", () => {
    const main = scriptPins(script("install-comfyui.sh"));
    const isolated = scriptPins(script("install-isolated-worker.sh"));
    for (const [name, pin] of Object.entries({ ...main, ...isolated })) {
      expect(packs[name], name).toBeDefined();
      expect({ repo: packs[name].repo, commit: packs[name].commit }, name).toEqual(pin);
    }
    for (const name of Object.keys(isolated)) if (!main[name]) expect(packs[name].isolated, name).toBe(true);
    // The H3 packs are pinned by variables (H3_TOOL_REF, H3_RELAY_REF) and cloned from their repos.
    const sh = script("install-comfyui.sh");
    expect(sh).toContain(`H3_TOOL_REF="\${H3_TOOL_REF:-${packs.h3_character_swap.commit}}"`);
    expect(sh).toContain(`H3_RELAY_REF="\${H3_RELAY_REF:-${packs["h3-relay"].commit}}"`);
    expect(sh).toContain(packs.h3_character_swap.repo);
    expect(sh).toContain(packs["h3-relay"].repo);
  });

  it("equals library.spec.mjs CUSTOM_NODE_REPOS (the manifest's repo addresses)", () => {
    const repos = CUSTOM_NODE_REPOS as Record<string, string>;
    expect(Object.keys(repos).sort()).toEqual(Object.keys(packs).sort());
    for (const [name, url] of Object.entries(repos)) {
      const tree = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([0-9a-f]{40})(?:\/(.+))?$/.exec(url);
      // One node file in a Hugging Face model repo (viggle_turbo): the repo, the commit and the file.
      const hfFile = /^(https:\/\/huggingface\.co\/[^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+\.py)$/.exec(url);
      if (hfFile) {
        expect({ repo: packs[name].repo, commit: packs[name].commit, file: packs[name].file }, name).toEqual({ repo: hfFile[1], commit: hfFile[2], file: hfFile[3] });
      } else if (tree) {
        expect({ repo: packs[name].repo, commit: packs[name].commit, subdir: packs[name].subdir }, name).toEqual({ repo: tree[1], commit: tree[2], subdir: tree[3] ?? null });
      } else {
        expect(packs[name].repo, name).toBe(url);
      }
    }
  });

  it("no longer installs the SeedVR2 pack (SeedVR2 is part of core ComfyUI)", () => {
    expect(packs["ComfyUI-SeedVR2_VideoUpscaler"]).toBeUndefined();
    expect(script("install-comfyui.sh")).not.toContain("ComfyUI-SeedVR2_VideoUpscaler");
  });
});
