import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Canvas, CanvasGraph, CanvasSummary } from "@/lib/catalog/canvas";
import type { Generation } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

// Route handlers are called directly, outside a Next request: connection() has nothing to wait for.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-canvas-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const lib = await import("@/server/library");
const { db } = await import("@/server/db");
const list = await import("@/app/api/canvases/route");
const one = await import("@/app/api/canvases/[id]/route");
const dup = await import("@/app/api/canvases/[id]/duplicate/route");
const run = await import("@/app/api/canvases/[id]/run/route");

beforeAll(() => setSetting("demoMode", "auto"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/canvases", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function settle(id: string, ms = 40_000) {
  const until = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > until) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const dependsOn = (id: string) => (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(id) as { depends_on: string | null }).depends_on;

/** Text prompt → image → video → output: the three-node graph the editor is verified with. */
const board: CanvasGraph = {
  nodes: [
    { id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { text: "A red fox in fresh snow" } },
    { id: "img", type: "model", position: { x: 320, y: 0 }, data: { modelId: "nano-banana-pro", label: "Still", params: { aspectRatio: "16:9" } } },
    { id: "vid", type: "model", position: { x: 640, y: 0 }, data: { modelId: "kling-2-5-turbo", op: "i2v", prompt: "It looks up", params: { duration: 5 } } },
    { id: "out", type: "output", position: { x: 960, y: 0 }, data: {} },
  ],
  edges: [
    { id: "e1", source: "p", sourceHandle: "out", target: "img", targetHandle: "prompt" },
    { id: "e2", source: "img", sourceHandle: "out", target: "vid", targetHandle: "images" },
    { id: "e3", source: "vid", sourceHandle: "out", target: "out", targetHandle: "in" },
  ],
};

describe("canvas API", () => {
  let id = "";

  it("creates, lists, renames and autosaves", async () => {
    let res = await list.POST(req("POST", {}));
    expect(res.status).toBe(201);
    const blank = (await res.json()) as Canvas;
    expect(blank).toMatchObject({ name: "Untitled canvas", pages: [{ id: "page-1", name: "Page 1", graph: { nodes: [], edges: [] } }], runs: {}, editedAt: null });
    id = blank.id;

    res = await one.PATCH(req("PATCH", { name: "Fox film", graph: board }), ctx(id));
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Canvas;
    expect(saved.name).toBe("Fox film");
    expect(saved.pages[0].graph.nodes).toHaveLength(4);
    expect(saved.pages[0].graph.edges).toHaveLength(3);
    expect(saved.editedAt).not.toBeNull();

    // Media must come from Fuobe's own storage; bad graphs are refused.
    res = await one.PATCH(req("PATCH", { graph: { nodes: [{ id: "x", type: "image-input", position: { x: 0, y: 0 }, data: { url: "http://evil.example/a.png" } }], edges: [] } }), ctx(id));
    expect(res.status).toBe(400);
    // Edges into inputs a node doesn't have are dropped on save.
    res = await one.PATCH(req("PATCH", { graph: { ...board, edges: [...board.edges, { id: "bad", source: "p", target: "vid", targetHandle: "audio" }] } }), ctx(id));
    expect(((await res.json()) as Canvas).pages[0].graph.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);

    res = await list.GET();
    const items = ((await res.json()) as { items: CanvasSummary[] }).items;
    expect(items[0]).toMatchObject({ id, name: "Fox film", nodeCount: 4, preview: null });
    expect(items[0].outline.boxes).toHaveLength(4);
    expect(items[0].outline.links).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("runs the graph as chained generations, then reuses fresh results", async () => {
    let res = await run.POST(req("POST", {}), ctx(id));
    expect(res.status).toBe(201);
    let body = (await res.json()) as { ran: string[]; items: Generation[]; canvas: Canvas; errors: unknown[] };
    expect(body.errors).toEqual([]);
    expect(body.ran).toEqual(["img", "vid"]);
    const [img, vid] = body.items;
    expect(img).toMatchObject({ feature: "canvas", modelId: "nano-banana-pro", op: "t2i", prompt: "A red fox in fresh snow" });
    expect(img.request.step).toEqual({ label: "Still", index: 0, of: 2 });
    expect(vid).toMatchObject({ modelId: "kling-2-5-turbo", op: "i2v", status: "queued" });
    expect(vid.request.chain).toEqual([{ slot: "images", position: "first" }]);
    expect(dependsOn(vid.id)).toBe(img.id);
    expect(body.canvas.runs.img.ids).toEqual([img.id]);
    expect(body.canvas.runs.vid.ids).toEqual([vid.id]);

    // Demo mode: the image lands, then the video is made from it.
    const done = await settle(vid.id);
    expect(done.status).toBe("succeeded");
    expect(done.request.inputs?.images?.[0]).toBe(gens.getGeneration(img.id)!.outputs[0].url);

    res = await one.GET(req("GET"), ctx(id));
    const view = (await res.json()) as { canvas: Canvas; generations: Generation[] };
    expect(view.generations.map((g) => g.status).sort()).toEqual(["succeeded", "succeeded"]);
    const listed = ((await (await list.GET()).json()) as { items: CanvasSummary[] }).items.find((c) => c.id === id)!;
    // Cards prefer a still over a clip.
    expect(listed.preview).toEqual({ url: gens.getGeneration(img.id)!.outputs[0].url, kind: "image" });

    // Nothing changed: Run all starts nothing.
    res = await run.POST(req("POST", {}), ctx(id));
    expect(res.status).toBe(200);
    body = (await res.json()) as typeof body;
    expect(body.ran).toEqual([]);

    // Re-run the video only: it builds on the image that's already there.
    res = await run.POST(req("POST", { targets: ["vid"], force: true }), ctx(id));
    body = (await res.json()) as typeof body;
    expect(body.ran).toEqual(["vid"]);
    expect(dependsOn(body.items[0].id)).toBe(img.id);

    // Editing the prompt (sent with the run) re-runs the image and what's downstream.
    const edited = structuredClone(board);
    edited.nodes[0].data.text = "A grey wolf in fresh snow";
    res = await run.POST(req("POST", { graph: edited, targets: ["img"] }), ctx(id));
    body = (await res.json()) as typeof body;
    expect(body.ran).toEqual(["img"]);
    expect(body.canvas.pages[0].graph.nodes[0].data.text).toBe("A grey wolf in fresh snow");
    await settle(body.items[0].id);
  }, 60_000);

  it("treats a result moved to the Trash as gone: Run all makes it again", async () => {
    // Bring the whole board up to date (the last test re-ran only the image).
    let res = await run.POST(req("POST", {}), ctx(id));
    for (const g of ((await res.json()) as { items: Generation[] }).items) await settle(g.id);
    expect((await run.POST(req("POST", {}), ctx(id))).status).toBe(200);
    let view = (await (await one.GET(req("GET"), ctx(id))).json()) as { canvas: Canvas; generations: Generation[] };
    const imgId = view.canvas.runs.img.ids[0];
    expect(gens.getGeneration(imgId)?.status).toBe("succeeded");

    lib.trashGenerations([imgId]);
    view = (await (await one.GET(req("GET"), ctx(id))).json()) as typeof view;
    expect(view.generations.map((g) => g.id)).not.toContain(imgId);
    // The card's preview no longer shows the trashed image.
    const card = ((await (await list.GET()).json()) as { items: CanvasSummary[] }).items.find((c) => c.id === id)!;
    expect(card.preview?.url).not.toBe(gens.getGeneration(imgId, { includeDeleted: true })!.outputs[0].url);

    res = await run.POST(req("POST", {}), ctx(id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ran: string[]; reused: { nodeId: string }[]; items: Generation[] };
    expect(body.ran).toEqual(["img", "vid"]);
    expect(body.reused).toEqual([]);
    await settle(body.items[1].id);
  }, 60_000);

  it("clamps over-long text instead of refusing the board, and names the node it can't save", async () => {
    const long = structuredClone(board);
    long.nodes[0].data.text = "x".repeat(10_001);
    long.nodes[2].data.prompt = "y".repeat(12_000);
    long.nodes[1].data.label = "L".repeat(200);
    let res = await one.PATCH(req("PATCH", { graph: long }), ctx(id));
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Canvas;
    expect(saved.pages[0].graph.nodes[0].data.text).toHaveLength(10_000);
    expect(saved.pages[0].graph.nodes[2].data.prompt).toHaveLength(10_000);
    expect(saved.pages[0].graph.nodes[1].data.label).toHaveLength(80);

    // Element handles keep letters, digits, _ and - only (they end up in prompts as @handle).
    const odd = structuredClone(board);
    odd.nodes.push({ id: "el", type: "element", position: { x: 0, y: 300 }, data: { handle: "a(b", elementId: "x" } });
    odd.edges.push({ id: "e4", source: "el", sourceHandle: "out", target: "img", targetHandle: "elements" });
    res = await one.PATCH(req("PATCH", { graph: odd }), ctx(id));
    expect(((await res.json()) as Canvas).pages[0].graph.nodes.find((n) => n.id === "el")!.data.handle).toBe("ab");
    // Planning a board with an odd handle never throws (it used to build a RegExp from it).
    res = await run.POST(req("POST", { graph: odd, targets: ["out"] }), ctx(id));
    expect(res.status).toBeLessThan(500);
    for (const g of ((await res.json()) as { items?: Generation[] }).items ?? []) await gens.cancelGeneration(g.id);

    // What can't be clamped is refused with the node's name.
    const bad = structuredClone(board);
    bad.nodes[1].data.label = "Hero shot";
    bad.nodes[1].data.preview = "http://evil.example/a.png";
    res = await one.PATCH(req("PATCH", { graph: bad }), ctx(id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("“Hero shot” couldn't be saved (its preview): change it or remove the node");
    await one.PATCH(req("PATCH", { graph: board }), ctx(id));
  }, 60_000);

  it("says what to fix when nothing can start", async () => {
    const broken = structuredClone(board);
    broken.nodes[1].data.modelId = undefined;
    const res = await run.POST(req("POST", { graph: broken }), ctx(id));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; errors: { nodeId: string; message: string }[] };
    expect(body.error).toBe("Pick a model (and 1 more)");
    expect(body.errors.map((e) => e.nodeId)).toEqual(["img", "vid"]);
  });

  it("respects the engine mode", async () => {
    setSetting("engineMode", "open");
    try {
      // A template asked for in its cloud variant comes out open-source on an open-only install.
      let res = await list.POST(req("POST", { templateId: "image-animate", engine: "cloud" }));
      const c = (await res.json()) as Canvas;
      expect(c.name).toBe("Image → Animate");
      expect(c.pages[0].graph.nodes.filter((n) => n.data.modelId).map((n) => n.data.modelId)).toEqual(["oss-qwen-image-21", "oss-minimax-h3"]);
      // Cloud nodes are refused with a reason.
      res = await run.POST(req("POST", { graph: board }), ctx(id));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(/^Nano Banana Pro is a cloud model: pick an open-source model/);
      // The open variant runs.
      res = await run.POST(req("POST", {}), ctx(c.id));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { items: Generation[] };
      expect(body.items.map((g) => g.engine)).toEqual(["open", "open"]);
      for (const g of body.items) await gens.cancelGeneration(g.id);
    } finally {
      setSetting("engineMode", "both");
    }
    const res = await list.POST(req("POST", { templateId: "nope" }));
    expect(res.status).toBe(422);
  });

  it("duplicates and deletes", async () => {
    let res = await dup.POST(req("POST"), ctx(id));
    expect(res.status).toBe(201);
    const copy = (await res.json()) as Canvas;
    expect(copy.name).toBe("Copy of Fox film");
    expect(copy.pages[0].graph.nodes).toHaveLength(4);
    expect(Object.keys(copy.runs).sort()).toEqual(["img", "vid"]);

    res = await one.DELETE(req("DELETE"), ctx(copy.id));
    expect(res.status).toBe(204);
    res = await one.GET(req("GET"), ctx(copy.id));
    expect(res.status).toBe(404);
    // The original and its results are untouched.
    res = await one.GET(req("GET"), ctx(id));
    expect(((await res.json()) as { generations: Generation[] }).generations.length).toBeGreaterThan(0);
  });

  it("follows an element renamed after it was put on the board", async () => {
    const elements = await import("@/server/elements");
    const el = elements.createElement({ name: "Maya", kind: "character", references: [] });
    const graph: CanvasGraph = {
      nodes: [
        { id: "el", type: "element", position: { x: 0, y: 0 }, data: { elementId: el.id, handle: el.handle, name: el.name } },
        { id: "img", type: "model", position: { x: 320, y: 0 }, data: { modelId: "nano-banana-pro", prompt: "A portrait" } },
      ],
      edges: [{ id: "e1", source: "el", sourceHandle: "out", target: "img", targetHandle: "elements" }],
    };
    const created = (await (await list.POST(req("POST", { name: "Cast", graph }))).json()) as Canvas;
    const renamed = elements.updateElement(el.id, { name: "Maya Lee" })!;
    expect(renamed.handle).not.toBe(el.handle);
    // The board shows the element's name now, and a run mentions its new @handle.
    const view = (await (await one.GET(req("GET"), ctx(created.id))).json()) as { canvas: Canvas };
    expect(view.canvas.pages[0].graph.nodes[0].data).toMatchObject({ handle: renamed.handle, name: "Maya Lee" });
    const body = (await (await run.POST(req("POST", { graph }), ctx(created.id))).json()) as { items: Generation[] };
    expect(body.items[0].request.prompt).toContain(`@${renamed.handle}`);
    // …which the server resolves to the element (it has no photos: its name goes into the prompt).
    expect(body.items[0].prompt).toContain("Maya Lee");
  });
});
