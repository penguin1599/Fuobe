import { describe, expect, it } from "vitest";
import type { Generation, OutputFile } from "@/lib/catalog/types";
import { coverIds } from "@/lib/nav-model";
import { imageSubject, keepGoing, type KeepGoingContext } from "@/lib/next-steps";

function gen(outputs: Partial<OutputFile>[], over: Partial<Generation> = {}): Generation {
  return {
    id: "g1",
    batchId: null,
    feature: "image",
    presetId: null,
    modelId: "nano-banana-pro",
    engine: "cloud",
    provider: "fal",
    op: "t2i",
    kind: (outputs[0]?.kind ?? "image") as Generation["kind"],
    status: "succeeded",
    progress: 1,
    message: null,
    prompt: "a fox in the snow",
    request: { feature: "image", modelId: "nano-banana-pro", prompt: "a fox in the snow" },
    outputs: outputs.map((o, i) => ({ url: `/api/files/out-${i}.png`, kind: "image", ...o }) as OutputFile),
    error: null,
    costUsd: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: 0,
    ...over,
  };
}

const withPrompt = (prompt: string, over: Partial<Generation> = {}) => gen([{ kind: "image", url: "/api/files/pic one.png" }], { prompt, request: { feature: "image", modelId: "nano-banana-pro", prompt }, ...over });
const person = () => withPrompt("a fashion model in a red velvet suit on a rooftop at dusk");
const product = () => withPrompt("a perfume bottle on black marble");
const other = () => withPrompt("a fox in the snow");
const clip = (over: Partial<Generation> = {}) => gen([{ kind: "video", url: "/api/files/clip.mp4" }], { kind: "video", op: "t2v", feature: "video", ...over });
const sound = (over: Partial<Generation> = {}) => gen([{ kind: "audio", url: "/api/files/voice.mp3" }], { kind: "audio", op: "tts", feature: "audio", ...over });
const model = (meta: Record<string, unknown> = { poster: "/api/files/chair.png" }) =>
  gen([{ kind: "model3d", url: "/api/files/chair.glb", meta }], {
    kind: "model3d",
    op: "image-to-3d",
    feature: "image-to-3d",
    request: { feature: "image-to-3d", modelId: "hunyuan-3d-3-1-pro", inputs: { images: ["/api/files/photo.png"] } },
  });

const ALL_ADAPTERS: KeepGoingContext = { engineMode: "both", adapters: { characterSheet: true, imageTo3d: true } };
const ids = (g: Generation, ctx: KeepGoingContext = ALL_ADAPTERS, max = 5) => keepGoing(g, 0, ctx, max).map((s) => s.id);
const U = encodeURIComponent("/api/files/pic one.png");

describe("what a picture is of", () => {
  it("reads its studio first, then its words", () => {
    expect(imageSubject(person())).toBe("person");
    expect(imageSubject(product())).toBe("product");
    expect(imageSubject(other())).toBe("other");
    expect(imageSubject(withPrompt("a fox", { feature: "fashion" }))).toBe("person");
    expect(imageSubject(withPrompt("a fox", { feature: "click-to-ad" }))).toBe("product");
    // A model holding the product: the product wins only with more product words.
    expect(imageSubject(withPrompt("a woman holding a perfume bottle"))).toBe("product");
    expect(imageSubject(withPrompt("a woman in a dress holding a bag"))).toBe("person");
  });
});

describe("Keep going with this", () => {
  it("offers a person's picture: animate, talk, character sheet, an ad, sharpen", () => {
    const steps = keepGoing(person(), 0, ALL_ADAPTERS);
    expect(steps.map((s) => s.id)).toEqual(["animate", "talk", "character-sheet", "billboard", "upscale"]);
    expect(steps.map((s) => s.href)).toEqual([`/video?image=${U}`, `/lipsync?image=${U}`, `/character-sheet?image=${U}`, `/apps/app-billboard-ad?image=${U}`, `/upscale?image=${U}`]);
    expect(steps[0]).toMatchObject({ verb: "Animate it", where: "Video" });
  });

  it("offers a product's picture: animate, an ad, 3D, sharpen, change", () => {
    expect(ids(product())).toEqual(["animate", "giant", "image-to-3d", "upscale", "edit"]);
    expect(keepGoing(product(), 0, ALL_ADAPTERS)[1].href).toBe(`/apps/app-giant-product?image=${U}`);
  });

  it("offers any other picture: animate, change, sharpen, grade, 3D", () => {
    expect(ids(other())).toEqual(["animate", "edit", "upscale", "grade", "image-to-3d"]);
  });

  it("links no studio that can't take the picture yet", () => {
    const off: KeepGoingContext = { engineMode: "both" };
    expect(ids(person(), off)).toEqual(["animate", "talk", "billboard", "upscale"]);
    expect(ids(product(), off)).not.toContain("image-to-3d");
    expect(ids(other(), off)).not.toContain("image-to-3d");
  });

  it("offers a clip: longer first, then sharper, sound, phones, a swap", () => {
    expect(ids(clip())).toEqual(["extend", "upscale", "add-sound", "reframe", "genjutsu"]);
    const steps = keepGoing(clip(), 0, ALL_ADAPTERS);
    expect(steps[0].href).toBe(`/extend?video=${encodeURIComponent("/api/files/clip.mp4")}`);
    expect(steps.every((s) => s.href.includes("video=%2Fapi%2Ffiles%2Fclip.mp4"))).toBe(true);
  });

  it("splits a sounded clip's soundtrack, and offers Remove dialogue to everyone (an account runs it on its own GPU)", () => {
    const sounded = clip({ op: "lipsync", feature: "lipsync" });
    expect(ids(sounded)).toContain("split-soundtrack");
    expect(ids(sounded)).toContain("remove-dialogue");
    expect(ids(sounded, { ...ALL_ADAPTERS, visitor: true })).toContain("remove-dialogue");
    // Restore & colourise is offered to a visitor as to the owner (labelled: its own GPU or key).
    expect(ids(sounded, { ...ALL_ADAPTERS, visitor: true }).includes("restore-video")).toBe(ids(sounded, ALL_ADAPTERS).includes("restore-video"));
  });

  it("offers a sound: a photo that says it, another voice, a loop, the parts", () => {
    expect(ids(sound())).toEqual(["lipsync", "voice-change", "loop-audio", "split-soundtrack", "clean-voice"]);
    expect(keepGoing(sound(), 0, ALL_ADAPTERS)[0].href).toBe(`/lipsync?audio=${encodeURIComponent("/api/files/voice.mp3")}`);
    // Music keeps no voice to clean.
    expect(ids(sound({ op: "music" }))).not.toContain("clean-voice");
  });

  it("offers a 3D model its spin, an ad and a sharper still, the last two only with a still", () => {
    expect(ids(model())).toEqual(["animate-spin", "product-360", "upscale"]);
    expect(keepGoing(model(), 0, ALL_ADAPTERS)[1].href).toBe(`/apps/app-product-360?image=${encodeURIComponent("/api/files/chair.png")}`);
    const bare = model({});
    // Its photo still animates; nothing else without a still.
    expect(ids({ ...bare, outputs: bare.outputs })).not.toContain("product-360");
    expect(ids({ ...bare, outputs: bare.outputs })).not.toContain("upscale");
  });

  it("honours the most it may show", () => {
    expect(keepGoing(person(), 0, ALL_ADAPTERS, 3)).toHaveLength(3);
    expect(keepGoing(clip(), 0, ALL_ADAPTERS, 2).map((s) => s.id)).toEqual(["extend", "upscale"]);
  });

  it("offers nothing for a failed, deleted, text or vector result, or a missing output", () => {
    expect(keepGoing(person(), 0, ALL_ADAPTERS).length).toBeGreaterThan(0);
    expect(keepGoing({ ...person(), status: "failed" }, 0, ALL_ADAPTERS)).toEqual([]);
    expect(keepGoing({ ...person(), deletedAt: 1 }, 0, ALL_ADAPTERS)).toEqual([]);
    expect(keepGoing(gen([{ kind: "text", url: "/api/files/t.txt", text: "hi" }], { kind: "text" }), 0, ALL_ADAPTERS)).toEqual([]);
    expect(keepGoing(gen([{ kind: "image", url: "/api/files/logo.svg", contentType: "image/svg+xml" }], { provider: "fal" }), 0, ALL_ADAPTERS)).toEqual([]);
    expect(keepGoing(person(), 3, ALL_ADAPTERS)).toEqual([]);
  });

  it("names only covers the navigation resolves, and no step twice", () => {
    const covers = new Set(coverIds());
    for (const g of [person(), product(), other(), clip(), clip({ op: "lipsync" }), sound(), model()]) {
      const steps = keepGoing(g, 0, ALL_ADAPTERS);
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const s of steps) if (s.cover) expect(covers.has(s.cover), s.cover).toBe(true);
    }
  });
});
