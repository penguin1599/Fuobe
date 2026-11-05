import { describe, expect, it } from "vitest";
import {
  FAST_FILES,
  TRIM_FILES,
  chooseH3Tier,
  cuda13,
  gpuArch,
  h3TierFor,
  h3TierNote,
  tierChoice,
  tierGraphFor,
  tierOfGraph,
} from "@/lib/gpu/h3-tier";

// MiniMax H3 on smaller cards (docs/research/new-models-10.md §6.4): which MiniMax H3 build a card runs, at every memory and
// generation edge. The card names are /system_stats device names as ComfyUI reports them.
const RTX5090 = "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync";
const RTX5070 = "cuda:0 NVIDIA GeForce RTX 5070 : cudaMallocAsync";
const RTX5060 = "cuda:0 NVIDIA GeForce RTX 5060 : cudaMallocAsync";
const RTX4090 = "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync";
const RTX4070 = "cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync";
const RTX3090 = "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync";
const CU130 = "2.12.0+cu130";
const CU128 = "2.9.1+cu128";

describe("the card's generation", () => {
  it.each([
    [RTX5090, "blackwell"],
    ["cuda:0 NVIDIA RTX PRO 6000 Blackwell Workstation Edition : cudaMallocAsync", "blackwell"],
    ["cuda:0 NVIDIA GB10 : cudaMallocAsync", "blackwell"],
    ["cuda:0 NVIDIA B200 : cudaMallocAsync", "blackwell"],
    ["cuda:0 NVIDIA H100 80GB HBM3 : cudaMallocAsync", "hopper"],
    [RTX4090, "ada"],
    ["cuda:0 NVIDIA GeForce RTX 4060 Laptop GPU : cudaMallocAsync", "ada"],
    ["cuda:0 NVIDIA RTX 6000 Ada Generation : cudaMallocAsync", "ada"],
    ["cuda:0 NVIDIA L40S : cudaMallocAsync", "ada"],
    ["cuda:0 NVIDIA L4 : cudaMallocAsync", "ada"],
    [RTX3090, "ampere"],
    ["cuda:0 NVIDIA RTX A6000 : cudaMallocAsync", "ampere"],
    ["cuda:0 NVIDIA A100-SXM4-80GB : cudaMallocAsync", "ampere"],
    ["cuda:0 NVIDIA A10G : cudaMallocAsync", "ampere"],
    ["cuda:0 NVIDIA GeForce RTX 2080 Ti : cudaMallocAsync", "turing"],
    ["cuda:0 Tesla T4 : cudaMallocAsync", "turing"],
    ["cuda:0 NVIDIA GeForce GTX 1080 Ti : cudaMallocAsync", "older"],
    ["cuda:0 Tesla V100-SXM2-32GB : cudaMallocAsync", "older"],
    ["cuda:0 AMD Radeon RX 7900 XTX : native", "other"],
    ["cuda:0 Some Future Card : cudaMallocAsync", "unknown"],
  ])("%s → %s", (name, arch) => expect(gpuArch(name, "cuda")).toBe(arch));

  it("an Apple or Intel device isn't CUDA, and a CPU is unknown", () => {
    expect(gpuArch("mps", "mps")).toBe("other");
    expect(gpuArch("xpu:0 Intel Arc A770", "xpu")).toBe("other");
    expect(gpuArch("cpu", "cpu")).toBe("unknown");
  });

  it("reads a CUDA 13 PyTorch build", () => {
    expect(cuda13(CU130)).toBe(true);
    expect(cuda13("2.12.0+cu131")).toBe(true);
    expect(cuda13(CU128)).toBe(false);
    expect(cuda13(undefined)).toBe(false);
  });
});

describe("Auto: the tier a card gets", () => {
  // [vram GB, name, torch] → [tier, weights, label, too small]
  it.each<[number | undefined, string | undefined, string | undefined, string, string | undefined, string, boolean]>([
    // No reading, a CPU, or a card it can't place: Standard (the default graph), never a guess.
    [undefined, RTX4090, CU130, "standard", undefined, "Standard", false],
    [0, RTX4090, CU130, "standard", undefined, "Standard", false],
    [16, "cuda:0 Some Future Card", CU130, "standard", undefined, "Standard", false],
    // 32 GB and up: Standard on every generation.
    [32, RTX5090, CU130, "standard", undefined, "Standard", false],
    [80, "cuda:0 NVIDIA A100-SXM4-80GB", CU130, "standard", undefined, "Standard", false],
    [48, "cuda:0 NVIDIA RTX 6000 Ada Generation", CU128, "standard", undefined, "Standard", false],
    // 16-31 GB: FastH3 V2, NVFP4 on Blackwell, int8 elsewhere (V2 has no fp8 build for ComfyUI).
    [31, RTX4090, CU130, "fast", "int8", "FastH3 V2 (int8)", false],
    [24, RTX4090, CU130, "fast", "int8", "FastH3 V2 (int8)", false],
    [24, RTX4090, CU128, "fast", "int8", "FastH3 V2 (int8)", false],
    [16, RTX4070, CU130, "fast", "int8", "FastH3 V2 (int8)", false],
    [16, RTX5060, CU130, "fast", "nvfp4", "FastH3 V2 (nvfp4)", false],
    // 12-15 GB: Trim. NVFP4 on Blackwell; int8 on a CUDA 13 PyTorch, fp8 on an older one; int8 when the build is unknown.
    [15, RTX4070, CU130, "trim", "int8", "FastH3 Trim (int8)", false],
    [12, RTX4070, CU128, "trim", "fp8", "FastH3 Trim (fp8)", false],
    [12, RTX4070, undefined, "trim", "int8", "FastH3 Trim (int8)", false],
    [12, RTX5070, CU130, "trim", "nvfp4", "FastH3 Trim (nvfp4)", false],
    // 8-11 GB: Trim on Blackwell only.
    [11, RTX5060, CU130, "trim", "nvfp4", "FastH3 Trim (nvfp4)", false],
    [8, RTX5060, CU130, "trim", "nvfp4", "FastH3 Trim (nvfp4)", false],
    [11, RTX4070, CU130, "standard", undefined, "Needs a bigger GPU", true],
    [8, RTX4070, CU130, "standard", undefined, "Needs a bigger GPU", true],
    // Under 8 GB: nothing fits.
    [7.9, RTX5060, CU130, "standard", undefined, "Needs a bigger GPU", true],
    [6, RTX4070, CU130, "standard", undefined, "Needs a bigger GPU", true],
    // Older than Ada under 32 GB: needs a bigger GPU (FastVideo measured RTX 40 and 50 only).
    [24, RTX3090, CU130, "standard", undefined, "Needs a bigger GPU", true],
    [16, "cuda:0 Tesla T4", CU130, "standard", undefined, "Needs a bigger GPU", true],
    [24, "cuda:0 AMD Radeon RX 7900 XTX", CU130, "standard", undefined, "Needs a bigger GPU", true],
  ])("%s GB %s (%s) → %s %s", (vramGb, name, torch, tier, weights, label, tooSmall) => {
    const c = chooseH3Tier({ vramGb, name, type: "cuda", torch });
    expect(c.tier).toBe(tier);
    expect(c.weights).toBe(weights);
    expect(c.label).toBe(label);
    expect(!!c.tooSmall).toBe(tooSmall);
    if (tooSmall) expect(c.reason).toBeTruthy();
  });

  it("names the file each tier loads, and offloads when it is bigger than the card", () => {
    expect(chooseH3Tier({ vramGb: 24, name: RTX4090, type: "cuda", torch: CU130 })).toMatchObject({ unet: FAST_FILES.int8.file, offload: true });
    expect(chooseH3Tier({ vramGb: 16, name: RTX5060, type: "cuda", torch: CU130 })).toMatchObject({ unet: FAST_FILES.nvfp4.file, offload: false });
    expect(chooseH3Tier({ vramGb: 12, name: RTX4070, type: "cuda", torch: CU128 })).toMatchObject({ unet: TRIM_FILES.fp8.file, offload: true });
    expect(chooseH3Tier({ vramGb: 12, name: RTX5070, type: "cuda", torch: CU130 })).toMatchObject({ unet: TRIM_FILES.nvfp4.file, offload: true });
    expect(chooseH3Tier({ vramGb: 32, name: RTX5090, type: "cuda" }).unet).toBeUndefined();
  });

  it("a Mac or an Intel card under 32 GB needs a bigger GPU; with no memory reading it keeps Standard", () => {
    expect(chooseH3Tier({ vramGb: 24, name: "mps", type: "mps" }).tooSmall).toBe(true);
    expect(chooseH3Tier({ name: "mps", type: "mps" })).toEqual({ tier: "standard", offload: false, label: "Standard" });
  });
});

describe("Options → GPU tier", () => {
  it("an explicit pick wins on any card, with the card's file", () => {
    expect(h3TierFor("trim", { vramGb: 24, name: RTX3090, type: "cuda", torch: CU130 })).toMatchObject({ tier: "trim", weights: "int8" });
    expect(h3TierFor("fast", { vramGb: 32, name: RTX5090, type: "cuda" })).toMatchObject({ tier: "fast", weights: "nvfp4", offload: false });
    expect(h3TierFor("standard", { vramGb: 12, name: RTX4070, type: "cuda" })).toMatchObject({ tier: "standard" });
    // A pick on a card with no reading takes the templates' default format.
    expect(h3TierFor("trim", {})).toMatchObject({ tier: "trim", weights: "int8", offload: false });
  });

  it("Auto (no pick, or a value it doesn't know) is the chooser's", () => {
    expect(h3TierFor(undefined, { vramGb: 16, name: RTX4070, type: "cuda", torch: CU130 }).tier).toBe("fast");
    expect(h3TierFor("huge", { vramGb: 16, name: RTX4070, type: "cuda", torch: CU130 }).tier).toBe("fast");
  });

  it("tierChoice for Standard loads the graph's own file", () => {
    expect(tierChoice("standard", { vramGb: 8 })).toEqual({ tier: "standard", offload: false, label: "Standard" });
  });
});

describe("the graph each tier runs", () => {
  const all = () => true;
  it("fast has text, start frame and start + end frames; trim text to video only", () => {
    expect(tierGraphFor("minimax-h3-t2v", "fast", all)).toBe("minimax-h3-fast-t2v");
    expect(tierGraphFor("minimax-h3-i2v", "fast", all)).toBe("minimax-h3-fast-i2v");
    expect(tierGraphFor("minimax-h3-flf2v", "fast", all)).toBe("minimax-h3-fast-flf2v");
    expect(tierGraphFor("minimax-h3-t2v", "trim", all)).toBe("minimax-h3-trim-t2v");
    expect(tierGraphFor("minimax-h3-i2v", "trim", all)).toBeUndefined();
    expect(tierGraphFor("minimax-h3-flf2v", "trim", all)).toBeUndefined();
    expect(tierGraphFor("minimax-h3-t2v", "standard", all)).toBeUndefined();
    expect(tierGraphFor("minimax-h3-t2v", "fast", () => false)).toBeUndefined();
    expect(tierOfGraph("minimax-h3-trim-t2v")).toBe("trim");
    expect(tierOfGraph("minimax-h3-fast-flf2v")).toBe("fast");
    expect(tierOfGraph("minimax-h3-t2v")).toBeUndefined();
  });

  it("the composer's note says what a smaller tier changes", () => {
    expect(h3TierNote({ gpuTier: "trim" }, "t2v")).toMatch(/experimental/);
    expect(h3TierNote({ gpuTier: "trim" }, "i2v")).toBeUndefined();
    expect(h3TierNote({ gpuTier: "fast", quality: "best" }, "i2v")).toMatch(/Sharper needs a 32 GB GPU/);
    expect(h3TierNote({}, "t2v")).toBeUndefined();
    expect(h3TierNote({ gpuTier: "trim", decoder: "fast" }, "t2v")).toMatch(/Fast decode needs a 32 GB GPU/);
    // Auto: what the card the GPU check read runs, in plain words.
    expect(h3TierNote({}, "i2v", "fast")).toMatch(/^On your GPU this runs as FastH3 V2/);
    expect(h3TierNote({}, "i2v", "trim")).toBeUndefined();
    expect(h3TierNote({ gpuTier: "standard" }, "t2v", "trim")).toBeUndefined();
  });
});
