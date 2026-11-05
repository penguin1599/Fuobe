import { describe, expect, it } from "vitest";
import { getModel, MODELS } from "@/lib/catalog";
import type { Generation, InputSlot } from "@/lib/catalog/types";
import {
  acceptedKinds,
  bestForStudio,
  blockerFor,
  filterModels,
  firstMissingSlot,
  fitAttachments,
  handoffKey,
  mergeHandoff,
  needsMask,
  noRoomMessage,
  onImageChange,
  promptShown,
  type Attachment,
  type DraftShape,
} from "@/lib/composer";
import { HUB_MODES, modeHref } from "@/lib/hubs";
import { outputActions } from "@/lib/output-actions";
import { AUDIO_STUDIO, EDIT_STUDIO, IMAGE_STUDIO, INPAINT_STUDIO, LIPSYNC_STUDIO, VIDEO_STUDIO, VOICE_CHANGE_STUDIO } from "@/lib/studios";

const att = (id: string, kind: Attachment["kind"] = "image", extra: Partial<Attachment> = {}): Attachment => ({ id, ref: `/api/files/${id}`, preview: `/api/files/${id}`, kind, ...extra });

const draft = (p: Partial<DraftShape> = {}): DraftShape => ({
  prompt: "",
  negativePrompt: "",
  modelId: "kling-2-5-turbo",
  params: { duration: 5 },
  slots: {},
  refs: [],
  presetOptions: {},
  ...p,
});

describe("a drawing belongs to its image", () => {
  const motion = { motionPaths: { paths: [[0, 0, 1, 1]] }, cfg: 3 };
  const drawn = { slots: { image: att("a"), mask: att("m"), sketch: att("s") }, params: { extra: motion } };

  it("drops the mask, the sketch and the motion paths when the image is replaced or removed", () => {
    const replaced = onImageChange(drawn, { ...drawn.slots, image: att("b") });
    expect(replaced.slots).toMatchObject({ image: { id: "b" }, mask: null, sketch: null });
    expect(replaced.params?.extra).toEqual({ cfg: 3 });
    const removed = onImageChange(drawn, { ...drawn.slots, image: null });
    expect(removed.slots).toMatchObject({ image: null, mask: null, sketch: null });
  });

  it("keeps the drawing when the same image finishes uploading (same id) or another slot changes", () => {
    const uploading = { ...drawn, slots: { ...drawn.slots, image: att("a", "image", { ref: "", uploading: true }) } };
    expect(onImageChange(uploading, { ...uploading.slots, image: att("a") })).toEqual({ slots: { ...uploading.slots, image: att("a") } });
    const other = onImageChange(drawn, { ...drawn.slots, endImage: att("e") });
    expect(other.slots.mask).toEqual(att("m"));
    expect(other.params).toBeUndefined();
  });

  it("leaves params alone when there were no motion paths", () => {
    const r = onImageChange({ slots: { image: att("a") }, params: { duration: 5 } }, { image: att("b") });
    expect(r.params).toBeUndefined();
    expect(r.slots).toMatchObject({ mask: null, sketch: null });
  });
});

describe("room for attachments", () => {
  const imageSlot: InputSlot[] = [{ key: "image", label: "Image", accept: "image" }];

  it("rejects files with nowhere to go before they upload", () => {
    // Image studio, a model that takes one reference: the second paste has no room.
    expect(fitAttachments({ slots: {}, refs: [] }, [], { kind: "image" }, 1, ["image", "image"])).toEqual({ placed: [0], rejected: [1] });
    expect(fitAttachments({ slots: {}, refs: [att("r")] }, [], { kind: "image" }, 1, ["image"])).toEqual({ placed: [], rejected: [0] });
    // A slot of the kind is always a place (the new file replaces the old one).
    expect(fitAttachments({ slots: { image: att("a") }, refs: [] }, imageSlot, undefined, 0, ["image", "video"])).toEqual({ placed: [0], rejected: [1] });
  });

  it("says why", () => {
    expect(noRoomMessage(3)).toBe("This model takes up to 3 reference images");
    expect(noRoomMessage(1)).toBe("This model takes up to 1 reference image");
    expect(noRoomMessage(0)).toMatch(/doesn't take reference images/);
    expect(noRoomMessage(4, "video")).toBe("This model takes up to 4 clips");
  });

  it("offers the + menu only what paste and drop accept (voice samples have their own picker)", () => {
    expect(acceptedKinds(VOICE_CHANGE_STUDIO.slots)).not.toContain(undefined);
    expect(acceptedKinds([{ key: "voiceAudio", label: "Voice", accept: "audio" }])).toEqual([]);
  });
});

describe("one of several inputs", () => {
  const slots = LIPSYNC_STUDIO.slots;
  const anyOf = LIPSYNC_STUDIO.anyOf;

  it("names the group, in tile order, and points at its first tile", () => {
    const voiceOnly = { audio: { ref: "/a.wav" } };
    const m = firstMissingSlot(slots, voiceOnly, anyOf);
    expect(m?.key).toBe("image");
    expect(blockerFor({ model: true, missing: m, uploading: false, promptMissing: false })).toEqual({ message: "Add a portrait or a video", slot: "image" });
    // Nothing attached: the group comes first (it's the first tile).
    expect(blockerFor({ model: true, missing: firstMissingSlot(slots, {}, anyOf), uploading: false, promptMissing: false })?.message).toBe("Add a portrait or a video");
  });

  it("is satisfied by any member, then asks for the next required slot", () => {
    expect(firstMissingSlot(slots, { video: { ref: "/v.mp4" } }, anyOf)?.key).toBe("audio");
    expect(firstMissingSlot(slots, { image: { ref: "", uploading: true } }, anyOf)?.key).toBe("audio");
    expect(firstMissingSlot(slots, { image: { ref: "/p.png" }, audio: { ref: "/a.wav" } }, anyOf)).toBeUndefined();
  });

  it("ignores groups whose slots the studio doesn't show (a preset's own inputs)", () => {
    expect(firstMissingSlot([{ key: "audio", label: "Voice", accept: "audio", required: true }], {}, anyOf)?.key).toBe("audio");
  });
});

describe("hand-off params after the first paint", () => {
  it("keys only the params a studio prefills from", () => {
    expect(handoffKey("?mode=music&prompt=hi&tab=x&image=%2Fa.png")).toBe("image=%2Fa.png&prompt=hi");
    expect(handoffKey("")).toBe("");
    expect(handoffKey(new URLSearchParams("ref=1&image=2"))).toBe(handoffKey("image=2&ref=1"));
  });

  it("fills what the person hasn't touched and keeps what they typed before hydration", () => {
    const base = draft();
    const typed = { ...base, prompt: "early words" };
    const next = draft({ prompt: "from the link", slots: { image: att("h") }, modelId: "veo-3-1", params: { duration: 8 } });
    const patch = mergeHandoff(base, typed, next);
    expect(patch.prompt).toBeUndefined();
    expect(patch.slots?.image).toEqual(att("h"));
    expect(patch).toMatchObject({ modelId: "veo-3-1", params: { duration: 8 } });
  });

  it("keeps an attachment or a model the person already chose", () => {
    const base = draft();
    const current = { ...base, slots: { image: att("mine") }, modelId: "seedance-2-5", params: { duration: 5 } };
    const patch = mergeHandoff(base, current, draft({ slots: { image: att("h") }, prompt: "go" }));
    expect(patch.slots).toBeUndefined();
    expect(patch.modelId).toBeUndefined();
    expect(patch.prompt).toBe("go");
  });

  it("changes nothing when the link carries nothing new", () => {
    const base = draft();
    expect(mergeHandoff(base, base, draft())).toEqual({});
  });

  it("takes the hand-off references and preset when untouched", () => {
    const base = draft();
    const next = draft({ refs: [att("r")], presetId: "motion-zoom-in" });
    expect(mergeHandoff(base, base, next)).toMatchObject({ refs: [att("r")], presetId: "motion-zoom-in" });
    const withRef = { ...base, refs: [att("mine")] };
    expect(mergeHandoff(base, withRef, next).refs).toBeUndefined();
  });
});

describe("best for this studio", () => {
  it("ranks only models that do the studio's main operation (no try-on in the Image studio)", () => {
    const models = filterModels(MODELS, { kind: IMAGE_STUDIO.kind, ops: IMAGE_STUDIO.ops });
    const def = getModel(IMAGE_STUDIO.defaultModels.cloud)!;
    const best = bestForStudio(models, "cloud", def.id, 4, def.routes[0].op);
    expect(best[0].id).toBe(def.id);
    for (const m of best) expect(m.routes.some((r) => r.op === "t2i")).toBe(true);
  });

  it("uses each studio's default model's first operation as its main one", () => {
    for (const s of [IMAGE_STUDIO, VIDEO_STUDIO, AUDIO_STUDIO, LIPSYNC_STUDIO]) {
      const op = getModel(s.defaultModels.cloud)?.routes[0]?.op;
      expect(op && s.ops.includes(op)).toBe(true);
    }
  });
});

describe("studio hubs", () => {
  it("give every mode its own path; the hub's path is its first mode", () => {
    expect(modeHref("audio", "clean")).toBe("/audio");
    expect(modeHref("audio", "speech")).toBe("/audio/speech");
    expect(modeHref("audio", "music")).toBe("/audio/music");
    expect(modeHref("upscale", "video", { video: "/v.mp4" })).toBe("/upscale/video?video=%2Fv.mp4");
    for (const modes of Object.values(HUB_MODES)) expect(new Set(modes.map((m) => m.id)).size).toBe(modes.length);
  });

  it("hand results to the mode's own page (prerendered with the right studio)", () => {
    const base = { batchId: null, presetId: null, engine: "cloud", provider: "mock", status: "succeeded", progress: 1, message: null, prompt: "", error: null, costUsd: 0, favorite: false, createdAt: 1, updatedAt: 1, completedAt: null, deletedAt: null, folderId: null } as const;
    const video = { ...base, id: "v1", feature: "video", modelId: "kling-2-5-turbo", op: "t2v", kind: "video", request: { feature: "video", modelId: "kling-2-5-turbo", prompt: "" }, outputs: [{ url: "/api/files/o/v.mp4", kind: "video" }] } as unknown as Generation;
    const audio = { ...base, id: "a1", feature: "audio", modelId: "elevenlabs-v3", op: "tts", kind: "audio", request: { feature: "audio", modelId: "elevenlabs-v3", prompt: "" }, outputs: [{ url: "/api/files/o/a.mp3", kind: "audio" }] } as unknown as Generation;
    const href = (g: Generation, id: string) => outputActions(g, 0).find((a) => a.id === id)?.href;
    expect(href(video, "upscale")).toMatch(/^\/upscale\/video\?video=/);
    expect(href(video, "add-sound")).toMatch(/^\/audio\/video\?video=/);
    expect(href(audio, "voice-change")).toMatch(/^\/audio\/voice-change\?audio=/);
  });
});

describe("Inpaint asks for the painted area once the image is in", () => {
  const fill = getModel("oss-flux-fill")!;
  const sketch = INPAINT_STUDIO.sketch;

  it("knows a mask-only model (FLUX Fill) is waiting for the painting", () => {
    expect(needsMask(fill, sketch, { image: att("a") })).toBe(true);
    // Still uploading: the same (Uploading… comes first in the blocker).
    expect(needsMask(fill, sketch, { image: att("a", "image", { ref: "", uploading: true }) })).toBe(true);
    // Painted, or no image yet (the image's own blocker says what to add).
    expect(needsMask(fill, sketch, { image: att("a"), mask: att("m") })).toBe(false);
    expect(needsMask(fill, sketch, {})).toBe(false);
    // A model with an instruction edit runs without a mask; a studio without the brush never asks.
    expect(needsMask(getModel(INPAINT_STUDIO.defaultModels.cloud), sketch, { image: att("a") })).toBe(false);
    expect(needsMask(fill, undefined, { image: att("a") })).toBe(false);
  });

  it("says “Paint the area to change” and points at the brush, not “Add an image…”", () => {
    // A new image dropped the old painting (onImageChange): the planner's message names both inputs.
    const after = onImageChange({ slots: { image: att("a"), mask: att("m"), sketch: att("s") }, params: {} }, { image: att("b"), mask: att("m"), sketch: att("s") });
    const maskMissing = needsMask(fill, sketch, after.slots);
    expect(maskMissing).toBe(true);
    const planError = "Add an image and paint the area to change";
    expect(blockerFor({ model: true, uploading: false, maskMissing, planError, promptMissing: false })).toEqual({ message: "Paint the area to change", slot: "mask" });
    // Inpaint asks for the painting before the prompt; an image still missing or uploading comes first.
    expect(blockerFor({ model: true, uploading: false, maskMissing, planError: "Write a prompt first", promptMissing: true })?.message).toBe("Paint the area to change");
    expect(blockerFor({ model: true, uploading: true, maskMissing, promptMissing: false })?.message).toBe("Uploading…");
    const image = firstMissingSlot(INPAINT_STUDIO.slots, {});
    expect(blockerFor({ model: true, missing: image, uploading: false, maskMissing: false, promptMissing: true })).toEqual({ message: "Add an image", slot: "image" });
  });
});

describe("prompt suggestions follow the prompt box", () => {
  it("hides them for models that take no prompt (FASHN try-on in Edit) and for prompt-less studios", () => {
    expect(EDIT_STUDIO.suggestions?.length).toBeGreaterThan(0);
    expect(promptShown(EDIT_STUDIO.hidePrompt, undefined, getModel(EDIT_STUDIO.defaultModels.cloud)?.options.promptless)).toBe(true);
    expect(promptShown(EDIT_STUDIO.hidePrompt, undefined, getModel("fashn-tryon")?.options.promptless)).toBe(false);
    expect(promptShown(true, undefined, false)).toBe(false);
    expect(promptShown(false, "none", false)).toBe(false);
    expect(promptShown(false, "optional", false)).toBe(true);
  });
});
