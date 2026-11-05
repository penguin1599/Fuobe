import { describe, expect, it } from "vitest";
import { getModel } from "@/lib/catalog";
import {
  CANVAS_TEMPLATES,
  cleanGraph,
  connectionError,
  convertEngine,
  defaultModelForNode,
  describeNode,
  effectiveOp,
  elementUpdates,
  graphEngine,
  inputPorts,
  isGenerator,
  modelChoices,
  nodeEngine,
  nodeSignature,
  outputType,
  paletteItems,
  planCanvas,
  promptPlaceholder,
  singleInput,
  topoOrder,
  withCurrentElements,
  withPlaceholders,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type CanvasRuns,
} from "@/lib/catalog/canvas";
import { estimateCost } from "@/lib/catalog/plan";
import type { GenerationStatus, Operation } from "@/lib/catalog/types";

const node = (id: string, type: CanvasNode["type"], x: number, y: number, data: CanvasNode["data"] = {}): CanvasNode => ({ id, type, position: { x, y }, data });
const edge = (source: string, target: string, targetHandle = "in"): CanvasEdge => ({ id: `${source}>${target}:${targetHandle}`, source, sourceHandle: "out", target, targetHandle });

/** Text prompt → image model → video model → output. */
function threeNodes(): CanvasGraph {
  return {
    nodes: [
      node("p", "prompt", 0, 0, { text: "A red fox in fresh snow" }),
      node("img", "model", 300, 0, { modelId: "nano-banana-pro", params: { aspectRatio: "16:9" } }),
      node("vid", "model", 600, 0, { modelId: "kling-2-5-turbo", op: "i2v", prompt: "It looks up at the camera", params: { duration: 5 } }),
      node("out", "output", 900, 0),
    ],
    edges: [edge("p", "img", "prompt"), edge("img", "vid", "images"), edge("vid", "out")],
  };
}

const statuses = (m: Record<string, GenerationStatus>) => (id: string) => m[id];

describe("canvas graph → plan", () => {
  it("orders steps topologically and maps edges to chain slots", () => {
    const plan = planCanvas(threeNodes());
    expect(plan.errors).toEqual([]);
    expect(plan.order).toEqual(["img", "vid"]);
    expect(plan.steps.map((s) => [s.nodeId, s.reason])).toEqual([
      ["img", "new"],
      ["vid", "new"],
    ]);
    const [img, vid] = plan.steps;
    // A literal text node becomes the prompt; the model infers text-to-image.
    expect(img.request).toMatchObject({ feature: "canvas", modelId: "nano-banana-pro", prompt: "A red fox in fresh snow", params: { aspectRatio: "16:9" } });
    expect(img.request.chain).toBeUndefined();
    expect(img.deps).toEqual([]);
    // The image edge becomes a chained start frame.
    expect(vid.request).toMatchObject({ modelId: "kling-2-5-turbo", op: "i2v", prompt: "It looks up at the camera", chain: [{ slot: "images", position: "first" }] });
    expect(vid.deps).toEqual(["img"]);
    expect(plan.costUsd).toBeCloseTo(0.15 + 0.07 * 5);
  });

  it("works out the op and the output type from what's connected", () => {
    const g = threeNodes();
    expect(effectiveOp(g, g.nodes[1])).toBe("t2i");
    expect(outputType(g, g.nodes[1])).toBe("image");
    expect(outputType(g, g.nodes[2])).toBe("video");
    g.nodes.push(node("ref", "image-input", 0, 200, { url: "/api/files/uploads/ref.png" }));
    g.edges.push(edge("ref", "img", "images"));
    expect(effectiveOp(g, g.nodes[1])).toBe("edit");
    expect(planCanvas(g).steps[0].request.inputs).toEqual({ images: ["/api/files/uploads/ref.png"] });
  });

  it("keeps the board's top-to-bottom order for image lists that mix files and generated images", () => {
    const g: CanvasGraph = {
      nodes: [
        node("a", "model", 0, 0, { modelId: "nano-banana-pro", prompt: "a hat" }),
        node("file", "image-input", 0, 200, { url: "/api/files/u/face.png" }),
        node("b", "model", 0, 400, { modelId: "nano-banana-pro", prompt: "a scarf" }),
        node("edit", "model", 400, 200, { modelId: "nano-banana-pro", op: "edit", prompt: "Combine them" }),
      ],
      edges: [edge("b", "edit", "images"), edge("file", "edit", "images"), edge("a", "edit", "images")],
    };
    const step = planCanvas(g).steps.find((s) => s.nodeId === "edit")!;
    expect(step.deps).toEqual(["a", "b"]);
    expect(step.request.inputs?.images).toEqual(["/api/files/u/face.png"]);
    expect(step.request.chain).toEqual([
      { slot: "images", position: "first" },
      { slot: "images", position: "last" },
    ]);
    // Filled in the same way the server does: [a, file, b].
    expect(withPlaceholders(step.request).inputs?.images).toEqual(["/api/files/placeholder.png", "/api/files/u/face.png", "/api/files/placeholder.png"]);
  });

  it("maps clips, audio, voices and elements", () => {
    const g: CanvasGraph = {
      nodes: [
        node("c1", "model", 0, 0, { modelId: "kling-2-5-turbo", prompt: "shot one" }),
        node("c2", "video-input", 0, 200, { url: "/api/files/u/two.mp4" }),
        node("join", "join", 300, 100, { modelId: "join-clips" }),
        node("sample", "audio-input", 0, 400, { url: "/api/files/u/me.wav" }),
        node("script", "prompt", 0, 600, { text: "Hello there" }),
        node("tts", "tts", 300, 500, { modelId: "chatterbox-cloud" }),
        node("face", "image-input", 300, 700, { url: "/api/files/u/face.png" }),
        node("avatar", "model", 600, 600, { modelId: "kling-avatar-2", op: "avatar" }),
        node("maya", "element", 0, 900, { handle: "Maya", elementId: "e1" }),
        node("still", "model", 300, 900, { modelId: "nano-banana-pro", prompt: "On a rooftop at night" }),
      ],
      edges: [
        edge("c1", "join", "videos"),
        edge("c2", "join", "videos"),
        edge("sample", "tts", "voice"),
        edge("script", "tts", "prompt"),
        edge("face", "avatar", "images"),
        edge("tts", "avatar", "audio"),
        edge("maya", "still", "elements"),
      ],
    };
    const plan = planCanvas(g);
    expect(plan.errors).toEqual([]);
    const by = Object.fromEntries(plan.steps.map((s) => [s.nodeId, s]));
    expect(by.join.request).toMatchObject({ op: "concat", inputs: { videos: ["/api/files/u/two.mp4"] }, chain: [{ slot: "videos", position: "first" }] });
    expect(by.tts.request).toMatchObject({ op: "tts", prompt: "Hello there", inputs: { voiceAudio: "/api/files/u/me.wav" } });
    expect(by.avatar.request).toMatchObject({ op: "avatar", inputs: { images: ["/api/files/u/face.png"] }, chain: [{ slot: "audio" }] });
    expect(by.avatar.deps).toEqual(["tts"]);
    expect(by.still.request.prompt).toBe("On a rooftop at night\n\nWith @Maya.");
    // The element's reference images turn text-to-image into an edit (as the server's applyMentions does).
    expect(effectiveOp(g, g.nodes.find((n) => n.id === "still")!)).toBe("edit");
    // Tool order: join's clip and the voice come before the nodes that use them.
    expect(plan.order.indexOf("tts")).toBeLessThan(plan.order.indexOf("avatar"));
    expect(plan.order.indexOf("c1")).toBeLessThan(plan.order.indexOf("join"));
  });

  it("puts connected text where {text} is", () => {
    const g: CanvasGraph = {
      nodes: [node("s", "prompt", 0, 0, { text: "a paper boat in the rain" }), node("f", "model", 300, 0, { modelId: "nano-banana-pro", prompt: "Frame 1: {text}. Cinematic still." })],
      edges: [edge("s", "f", "prompt")],
    };
    expect(planCanvas(g).steps[0].request.prompt).toBe("Frame 1: a paper boat in the rain. Cinematic still.");
  });

  it("chains a generated text into the prompt slot", () => {
    // Placeholder handling is the same as the server's withChainInputs.
    expect(withPlaceholders({ feature: "canvas", modelId: "x", prompt: "Say: {text}", chain: [{ slot: "prompt" }] }).prompt).toBe("Say: Placeholder text from an earlier step");
    expect(withPlaceholders({ feature: "canvas", modelId: "x", prompt: "{text}", chain: [{ slot: "prompt" }] }).prompt).toBe("Placeholder text from an earlier step");
  });

  it.skipIf(!getModel("text-llm"))("uses a text model's output as the prompt of the next node", () => {
    const g: CanvasGraph = {
      nodes: [node("w", "model", 0, 0, { modelId: "text-llm", op: "write", prompt: "Write a one-line ad for a lemonade stand" }), node("img", "model", 300, 0, { modelId: "nano-banana-pro", prompt: "Poster:" })],
      edges: [edge("w", "img", "prompt")],
    };
    const step = planCanvas(g).steps.find((s) => s.nodeId === "img")!;
    expect(step.request).toMatchObject({ prompt: "Poster:\n\n{text}", chain: [{ slot: "prompt" }] });
    expect(step.deps).toEqual(["w"]);
  });

  it("a new Text model node writes; picking a language makes it translate", () => {
    const item = paletteItems().find((p) => p.id === "model-text")!;
    const data = { ...item.data, modelId: defaultModelForNode({ type: item.type, data: item.data ?? {} }, "cloud")!.id, prompt: "Write a slogan for a lemonade stand" };
    expect(data.modelId).toBe("text-llm");
    const w = node("w", "model", 0, 0, data);
    const g: CanvasGraph = { nodes: [w], edges: [] };
    expect(effectiveOp(g, w)).toBe("write");
    // The request says so (left out, the server would infer the catalog's first op: translate).
    expect(planCanvas(g).steps[0].request).toMatchObject({ modelId: "text-llm", op: "write", prompt: "Write a slogan for a lemonade stand" });
    expect(promptPlaceholder("write")).toMatch(/^What should it write/);
    expect(promptPlaceholder("translate")).toMatch(/^Text to translate/);
    expect(promptPlaceholder("tts")).toMatch(/^Text to speak/);

    w.data.params = { targetLanguage: "French" };
    expect(effectiveOp(g, w)).toBe("translate");
    expect(planCanvas(g).steps[0].request).toMatchObject({ op: "translate", params: { targetLanguage: "French" } });
    // Translate chosen by hand needs a language.
    w.data.params = undefined;
    w.data.op = "translate";
    expect(describeNode(g, w).error).toBe("Pick a language to translate into");
  });

  it("joins elements with any handle into the prompt without building a regex from it", () => {
    const g: CanvasGraph = {
      nodes: [node("el", "element", 0, 0, { handle: "a(b", elementId: "x" }), node("img", "model", 300, 0, { modelId: "nano-banana-pro", prompt: "A portrait" })],
      edges: [edge("el", "img", "elements")],
    };
    const d = describeNode(g, g.nodes[1]);
    expect(d.request?.prompt).toBe("A portrait\n\nWith @a(b.");
    // A handle already mentioned isn't added twice.
    g.nodes[1].data.prompt = "A portrait of @Maya";
    g.nodes[0].data.handle = "maya";
    expect(describeNode(g, g.nodes[1]).request?.prompt).toBe("A portrait of @Maya");
  });

  it("follows a renamed element: the node shows its new name and mentions its new @handle", () => {
    const g: CanvasGraph = {
      nodes: [
        node("el", "element", 0, 0, { elementId: "e1", handle: "Maya", name: "Maya", preview: "/api/files/maya.png" }),
        node("gone", "element", 0, 200, { elementId: "deleted", handle: "Old", name: "Old" }),
        node("img", "model", 300, 0, { modelId: "nano-banana-pro", prompt: "A portrait" }),
      ],
      edges: [edge("el", "img", "elements")],
    };
    const now = [{ id: "e1", handle: "Maya_Lee", name: "Maya Lee", references: ["/api/files/maya.png"] }];
    expect([...elementUpdates(g, now)]).toEqual([["el", { handle: "Maya_Lee", name: "Maya Lee" }]]);
    const fresh = withCurrentElements(g, now);
    expect(fresh.nodes[0].data).toMatchObject({ elementId: "e1", handle: "Maya_Lee", name: "Maya Lee" });
    // An element that's gone keeps what the node had; the rest of the board is the same object.
    expect(fresh.nodes[1]).toBe(g.nodes[1]);
    expect(describeNode(fresh, fresh.nodes[2]).request?.prompt).toBe("A portrait\n\nWith @Maya_Lee.");
    // A new first photo follows too; nothing changed → the same graph.
    expect(elementUpdates(fresh, [{ ...now[0], references: ["/api/files/new.png"] }]).get("el")).toEqual({ preview: "/api/files/new.png" });
    expect(withCurrentElements(fresh, now)).toBe(fresh);
  });

  it("reports validation errors on the node and blocks what depends on it", () => {
    const g = threeNodes();
    g.nodes[1].data.modelId = undefined;
    let plan = planCanvas(g);
    expect(plan.steps).toEqual([]);
    expect(plan.errors).toEqual([
      { nodeId: "img", message: "Pick a model" },
      { nodeId: "vid", message: "Waiting on “Model” — fix it first" },
    ]);

    // A video model with nothing connected to its start frame.
    plan = planCanvas({ nodes: [node("v", "model", 0, 0, { modelId: "kling-2-5-turbo", op: "i2v", prompt: "go" })], edges: [] });
    expect(plan.errors).toEqual([{ nodeId: "v", message: "Add a start frame" }]);

    // An empty upload node.
    plan = planCanvas({ nodes: [node("i", "image-input", 0, 0, { label: "Product photo" }), node("e", "model", 300, 0, { modelId: "nano-banana-pro", op: "edit", prompt: "x" })], edges: [edge("i", "e", "images")] });
    expect(plan.errors).toEqual([{ nodeId: "e", message: "Add an image to “Product photo”" }]);

    // The engine mode is enforced per node.
    plan = planCanvas(threeNodes(), { engineMode: "open" });
    expect(plan.errors[0]).toEqual({ nodeId: "img", message: "Nano Banana Pro is a cloud model: pick an open-source model" });
  });

  it("finds loops", () => {
    const g: CanvasGraph = {
      nodes: [node("a", "model", 0, 0, { modelId: "nano-banana-pro", op: "edit", prompt: "x" }), node("b", "model", 300, 0, { modelId: "nano-banana-pro", op: "edit", prompt: "y" }), node("c", "upscale", 600, 0, { modelId: "topaz-image" })],
      edges: [edge("a", "b", "images"), edge("b", "a", "images"), edge("b", "c", "images")],
    };
    expect(topoOrder(g)).toEqual({ order: [], cyclic: ["a", "b", "c"] });
    const plan = planCanvas(g);
    expect(plan.steps).toEqual([]);
    expect(plan.errors.map((e) => e.message)).toEqual([
      "This node is part of a loop — remove one of its connections",
      "This node is part of a loop — remove one of its connections",
      "This node comes after a loop — remove one of the loop's connections",
    ]);
    // The editor refuses the edge that would close a loop.
    expect(connectionError({ ...g, edges: [edge("a", "b", "images")] }, { source: "b", target: "a", sourceHandle: "out", targetHandle: "images" })).toBe("That would make a loop");
  });

  it("validates connections by type", () => {
    const g = threeNodes();
    g.nodes.push(node("clip", "video-input", 0, 300, { url: "/api/files/u/a.mp4" }));
    expect(connectionError(g, { source: "clip", target: "vid", sourceHandle: "out", targetHandle: "images" })).toBe("Video can't go into Start frame");
    expect(connectionError(g, { source: "p", target: "vid", sourceHandle: "out", targetHandle: "prompt" })).toBeNull();
    expect(connectionError(g, { source: "p", target: "vid", sourceHandle: "out", targetHandle: "audio" })).toBe("Kling 2.5 Turbo Pro has no audio input");
    expect(connectionError(g, { source: "out", target: "vid", sourceHandle: "out", targetHandle: "prompt" })).toBe("Output has no output");
    expect(connectionError(g, { source: "clip", target: "out", sourceHandle: "out", targetHandle: "in" })).toBeNull();
    expect(singleInput(g, "vid", "endImage")).toBe(true);
    expect(singleInput(g, "vid", "prompt")).toBe(false);
    // Kling 2.5 Turbo takes an end frame on its image-to-video route.
    expect(inputPorts(g.nodes[2]).map((p) => p.id)).toEqual(["prompt", "elements", "images", "endImage"]);
  });

  it("skips fresh nodes, re-runs changed, failed and forced ones", () => {
    const g = threeNodes();
    const first = planCanvas(g);
    const imgSig = nodeSignature(first.steps[0].request, []);
    const vidSig = nodeSignature(first.steps[1].request, ["gen-img"]);
    const runs: CanvasRuns = { img: { sig: imgSig, ids: ["gen-img"], at: 1 }, vid: { sig: vidSig, ids: ["gen-vid"], at: 2 } };
    const ok = statuses({ "gen-img": "succeeded", "gen-vid": "running" });

    let plan = planCanvas(g, { runs, status: ok });
    expect(plan.steps).toEqual([]);
    expect(plan.reused).toEqual([
      { nodeId: "img", reason: "fresh", generationId: "gen-img" },
      { nodeId: "vid", reason: "fresh", generationId: "gen-vid" },
    ]);

    // Run node with its upstream: the fresh image is reused, a forced video runs again.
    plan = planCanvas(g, { runs, status: ok, targets: ["vid"], force: true });
    expect(plan.steps.map((s) => [s.nodeId, s.reason])).toEqual([["vid", "forced"]]);

    // A changed prompt re-runs the image, and the video because its input changes.
    const changed = threeNodes();
    changed.nodes[0].data.text = "A grey wolf in fresh snow";
    plan = planCanvas(changed, { runs, status: ok });
    expect(plan.steps.map((s) => [s.nodeId, s.reason])).toEqual([
      ["img", "changed"],
      ["vid", "upstream"],
    ]);

    // Running only the image leaves the video alone.
    plan = planCanvas(changed, { runs, status: ok, targets: ["img"] });
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["img"]);

    // A failed result runs again; a deleted generation counts as new.
    plan = planCanvas(g, { runs, status: statuses({ "gen-img": "succeeded", "gen-vid": "failed" }) });
    expect(plan.steps.map((s) => [s.nodeId, s.reason])).toEqual([["vid", "failed"]]);
    plan = planCanvas(g, { runs, status: statuses({ "gen-vid": "succeeded" }) });
    expect(plan.steps.map((s) => [s.nodeId, s.reason])).toEqual([
      ["img", "new"],
      ["vid", "upstream"],
    ]);

    // An Output node stands for what feeds it.
    plan = planCanvas(changed, { runs, status: ok, targets: ["out"] });
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["img", "vid"]);
  });

  it("never re-runs a pinned node", () => {
    const g = threeNodes();
    g.nodes[1].data.pinned = true;
    g.nodes[0].data.text = "changed after pinning";
    const runs: CanvasRuns = { img: { sig: "old", ids: ["gen-img"], at: 1 } };
    let plan = planCanvas(g, { runs, status: statuses({ "gen-img": "succeeded" }), force: true });
    expect(plan.reused).toEqual([{ nodeId: "img", reason: "pinned", generationId: "gen-img" }]);
    expect(plan.steps.map((s) => [s.nodeId, s.reason, s.deps])).toEqual([["vid", "forced", ["img"]]]);
    plan = planCanvas(g, {});
    expect(plan.errors[0]).toEqual({ nodeId: "img", message: "Pinned, but there's no result to use yet — unpin it to run it" });
  });

  it("fans one prompt out to several models for a side-by-side compare", () => {
    const g = CANVAS_TEMPLATES.find((t) => t.id === "compare-image")!.build("cloud");
    const plan = planCanvas(g);
    expect(plan.errors).toEqual([]);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.every((s) => s.deps.length === 0 && s.request.prompt?.startsWith("Editorial beauty portrait"))).toBe(true);
    expect(new Set(plan.steps.map((s) => s.request.modelId)).size).toBe(3);
  });
});

describe("canvas templates", () => {
  it.each(CANVAS_TEMPLATES.flatMap((t) => (["cloud", "open"] as const).map((e) => [t.id, e] as const)))("%s (%s) is a valid graph on that engine", (id, engine) => {
    const g = CANVAS_TEMPLATES.find((t) => t.id === id)!.build(engine);
    expect(cleanGraph(g).edges).toHaveLength(g.edges.length);
    for (const n of g.nodes.filter(isGenerator)) {
      const m = getModel(n.data.modelId!);
      expect(m, `${id}/${n.id}: ${n.data.modelId}`).toBeDefined();
      // A Fuobe Original (both engines) runs on the engine its node names.
      expect(nodeEngine(n, m!)).toBe(engine);
    }
    expect(graphEngine(g)).toBe(engine);
    const plan = planCanvas(g, { engineMode: engine });
    // Only the empty upload nodes need the user.
    for (const e of plan.errors) expect(e.message).toMatch(/^(Row \d+: )?(Add (an image|an audio clip|a video|a voice sample) to|Waiting on)/);
    if (!plan.errors.length) expect(plan.steps.length).toBe(g.nodes.filter(isGenerator).length);
    if (engine === "open") expect(plan.costUsd).toBe(0);
  });

  it("all filled in, the avatar template plans voice clone → avatar", () => {
    const g = CANVAS_TEMPLATES.find((t) => t.id === "talking-avatar")!.build("open");
    g.nodes.find((n) => n.id === "portrait")!.data.url = "/api/files/u/face.png";
    g.nodes.find((n) => n.id === "sample")!.data.url = "/api/files/u/me.wav";
    const plan = planCanvas(g, { engineMode: "open" });
    expect(plan.errors).toEqual([]);
    expect(plan.steps.map((s) => [s.nodeId, s.request.modelId, s.deps])).toEqual([
      ["voice", "oss-chatterbox", []],
      ["avatar", "oss-infinitetalk", ["voice"]],
    ]);
  });

  it("switches a whole board to open-source models", () => {
    const g = CANVAS_TEMPLATES.find((t) => t.id === "script-film")!.build("cloud");
    const { graph, changed, missing } = convertEngine(g, "open");
    expect(changed).toBe(10);
    expect(missing).toEqual([]);
    expect(graphEngine(graph)).toBe("open");
    expect(graph.nodes.find((n) => n.id === "film")!.data.modelId).toBe("oss-join-clips");
    expect(graph.nodes.find((n) => n.id === "beat1")!.data).toMatchObject({ modelId: "oss-text-llm", op: "write" });
    expect(graph.nodes.find((n) => n.id === "shot1")!.data).toMatchObject({ modelId: "oss-minimax-h3", op: "i2v" });
    expect(planCanvas(graph, { engineMode: "open" }).errors).toEqual([]);
  });

  it.each(["cloud", "open"] as const)("script → film (%s): the script reaches every frame and shot through a text model", (engine) => {
    const g = CANVAS_TEMPLATES.find((t) => t.id === "script-film")!.build(engine);
    const llm = engine === "open" ? "oss-text-llm" : "text-llm";
    const plan = planCanvas(g, { engineMode: engine });
    expect(plan.errors).toEqual([]);
    const step = (id: string) => plan.steps.find((s) => s.nodeId === id)!;
    for (const i of [1, 2, 3]) {
      // The shot text is written from the script…
      expect(step(`beat${i}`).request).toMatchObject({ modelId: llm, op: "write" });
      expect(step(`beat${i}`).request.prompt).toContain(`shot ${i} of 3`);
      expect(step(`beat${i}`).request.prompt).toContain("emerald silk ball gown");
      // …and becomes the frame's prompt and the shot's prompt (with the frame as its start).
      expect(step(`frame${i}`)).toMatchObject({ deps: [`beat${i}`], request: { chain: [{ slot: "prompt" }] } });
      expect(step(`frame${i}`).request.prompt).toContain("{text}");
      expect(step(`shot${i}`).deps).toEqual([`beat${i}`, `frame${i}`]);
      expect(step(`shot${i}`).request.chain).toEqual([{ slot: "prompt" }, { slot: "images", position: "first" }]);
    }
    // A new script changes what every shot is written from: no gown left anywhere.
    g.nodes.find((n) => n.id === "script")!.data.text = "An astronaut plants a flower on Mars";
    const again = planCanvas(g, { engineMode: engine });
    const prompts = again.steps.map((s) => s.request.prompt ?? "").join("\n");
    expect(prompts).toContain("An astronaut plants a flower on Mars");
    expect(prompts).not.toMatch(/gown/i);
  });

  it("disables palette entries with no model on an install's only engine", () => {
    expect(paletteItems("both").filter((p) => p.disabled)).toEqual([]);
    const open = paletteItems("open");
    // ComfyUI's frame-extract workflow (oss-extract-frame) runs Extract frame on open-only installs too.
    expect(open.find((p) => p.id === "frame")?.disabled).toBeUndefined();
    expect(open.find((p) => p.id === "model-image")?.disabled).toBeUndefined();
    expect(open.find((p) => p.id === "join")?.disabled).toBeUndefined();
  });

  it("offers palette entries for every node type the catalog can run", () => {
    const ids = paletteItems().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["prompt", "image-input", "video-input", "audio-input", "element", "model-image", "model-video", "join", "frame", "upscale", "bg-remove", "tts", "output"]));
    // Utilities pick a working model on each engine (or say there's none).
    const frame = node("f", "frame", 0, 0, {});
    expect(describeNode({ nodes: [frame], edges: [] }, frame).error).toBe("Pick a model");
  });
});

describe("round-4 models on the canvas", () => {
  const modelNode = (modelId: string, op?: Operation): CanvasNode => node("m", "model", 300, 0, { modelId, mediaKind: getModel(modelId)!.kind, ...(op && { op }) });
  const ports = (id: string, op?: Operation) => inputPorts(modelNode(id, op)).map((p) => p.id);

  it("gives the new operations their inputs", () => {
    expect(ports("kling-o3", "remove-object")).toEqual(["prompt", "video"]);
    expect(ports("kling-o3", "video-swap")).toEqual(["prompt", "elements", "images", "video"]);
    expect(ports("bria-video-erase")).toEqual(["prompt", "video"]);
    expect(ports("p-video-replace")).toEqual(["prompt", "elements", "images", "video"]);
    expect(ports("florence-2-ocr")).toEqual(["images"]);
    expect(ports("topaz-sdr-to-hdr")).toEqual(["video"]);
    expect(ports("triposplat")).toEqual(["images"]);
    expect(ports("tripo-h3-1-text")).toEqual(["prompt"]);
    expect(ports("recraft-vectorize")).toEqual(["images"]);
    const keyframes = inputPorts(modelNode("flux-3-max", "keyframes"));
    expect(keyframes.map((p) => p.id)).toEqual(["prompt", "images"]);
    expect(keyframes.find((p) => p.id === "images")!.multiple).toBe(true);
  });

  it("keeps Wan 2.2 14B's image port a start frame on Auto; its keyframe film is picked, and fed uploaded images", () => {
    for (const id of ["oss-wan22-14b-fast", "oss-wan22-14b"]) {
      const auto = inputPorts(modelNode(id)).find((p) => p.id === "images")!;
      expect(auto).toMatchObject({ label: "Start frame", multiple: false });
      expect(inputPorts(modelNode(id, "keyframes")).find((p) => p.id === "images")).toMatchObject({ label: "Images", multiple: true });
    }
    // Uploaded stills: a film is planned.
    const files: CanvasGraph = {
      nodes: [
        node("a", "image-input", 0, 0, { url: "/api/files/a.png" }),
        node("b", "image-input", 0, 200, { url: "/api/files/b.png" }),
        node("m", "model", 300, 0, { modelId: "oss-wan22-14b", mediaKind: "video", op: "keyframes", prompt: "dawn over the bay", params: { duration: 5 } }),
      ],
      edges: [edge("a", "m", "images"), edge("b", "m", "images")],
    };
    const film = describeNode(files, files.nodes[2]);
    expect(film.error).toBeUndefined();
    expect(film.plan?.op).toBe("keyframes");
    // Generated stills: said on the node before Run (the film's clips are planned from its inputs when it starts).
    const generated: CanvasGraph = {
      nodes: [node("img", "model", 0, 0, { modelId: "nano-banana-pro", prompt: "a bay at dawn" }), { ...files.nodes[2] }, files.nodes[0]],
      edges: [edge("a", "m", "images"), edge("img", "m", "images")],
    };
    const d = describeNode(generated, generated.nodes[1]);
    expect(d.error).toBe("Wan 2.2 14B builds this film from several clips of the images you add when it starts — give it uploaded images and a typed prompt, not another step's output");
    expect(planCanvas(generated).errors.map((e) => e.nodeId)).toEqual(["m"]);
  });

  it("runs an eraser fed from the board", () => {
    const g: CanvasGraph = {
      nodes: [node("clip", "video-input", 0, 0, { url: "/api/files/clip.mp4" }), node("m", "model", 300, 0, { modelId: "bria-video-erase", prompt: "the coffee cup" })],
      edges: [edge("clip", "m", "video")],
    };
    const d = describeNode(g, g.nodes[1]);
    expect(d.error).toBeUndefined();
    expect(d.plan?.op).toBe("remove-object");
  });

  it("leaves out models and operations the canvas can't feed", () => {
    const video = modelChoices({ type: "model", data: { mediaKind: "video" } }).map((m) => m.id);
    expect(video).toContain("bria-video-erase");
    // VACE runs only on a painted first-frame mask.
    expect(video).not.toContain("wan-22-vace-inpaint");
    // Rigging needs a 3D model input, which the canvas has no port for.
    expect(modelChoices({ type: "model", data: { mediaKind: "model3d" } }).map((m) => m.id)).not.toContain("meshy-rigging");
  });
});

describe("canvas prices with LoRAs", () => {
  // A node whose run loads LoRAs goes to the route's LoRA endpoint, at its own price (or an unknown one, never free):
  // the canvas prices it as the composer and the server do (N7-1 review).
  it("prices Fuobe Soul's look LoRAs at the LoRA endpoint's rate", () => {
    const g: CanvasGraph = { nodes: [node("s", "model", 0, 0, { modelId: "fuobe-soul", prompt: "a cat on a windowsill" })], edges: [] };
    const d = describeNode(g, g.nodes[0], { engineMode: "cloud" });
    expect(d.plan!.loras.length).toBeGreaterThan(0);
    const p = d.plan!;
    expect(d.costUsd).toBe(estimateCost(p.model, p.params, p.jobs, p.op, true));
    expect(d.costUsd).toBeGreaterThan(estimateCost(p.model, p.params, p.jobs, p.op)!);
  });

  it("leaves a model without LoRAs at its own price", () => {
    const g: CanvasGraph = { nodes: [node("m", "model", 0, 0, { modelId: "moss-image", prompt: "a neon OPEN sign" })], edges: [] };
    expect(describeNode(g, g.nodes[0]).costUsd).toBe(0.05);
  });
});
