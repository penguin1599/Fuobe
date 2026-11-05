import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanGraph,
  connectionError,
  defaultModelForNode,
  describeNode,
  edgeStem,
  modelChoices,
  NODE_SPECS,
  OUT,
  outputHandles,
  outputLabel,
  paletteItems,
  SPLIT_OUTPUTS,
  type Canvas,
  type CanvasGraph,
  type CanvasNode,
} from "@/lib/catalog/canvas";
import { CLOUD_SPLIT_PROBLEM, SPLIT_MODEL } from "@/lib/av/split";
import type { Generation } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

// Canvas → Split soundtrack (DBS D8): a utility node with four outputs (Dialogue, Music, Effects, Music & effects), each
// edge carrying its stem on to the next node's chain; OUT stays as Dialogue for boards saved before; DBS on the open
// engine only, so the node is disabled on the cloud with the reason.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-canvas-split-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { db } = await import("@/server/db");
const list = await import("@/app/api/canvases/route");
const one = await import("@/app/api/canvases/[id]/route");
const run = await import("@/app/api/canvases/[id]/run/route");
const { parseGraph } = await import("@/server/canvas");

beforeAll(() => setSetting("demoMode", "auto"));

const at = (x: number) => ({ x, y: 0 });
const clip: CanvasNode = { id: "clip", type: "video-input", position: at(0), data: { url: "/api/files/uploads/2026-11-01/interview.mp4" } };
const split: CanvasNode = { id: "split", type: "split-soundtrack", position: at(320), data: { modelId: SPLIT_MODEL } };
const words: CanvasNode = { id: "words", type: "model", position: at(640), data: { modelId: "oss-qwen3-asr", op: "transcribe" } };
const mux: CanvasNode = { id: "mux", type: "model", position: at(640), data: { modelId: "oss-mux", op: "mux" } };
const board = (edges: CanvasGraph["edges"]): CanvasGraph => ({ nodes: [clip, split, words, mux], edges: [{ id: "in", source: "clip", sourceHandle: OUT, target: "split", targetHandle: "video" }, ...edges] });

describe("the node and its outputs", () => {
  it("has four labelled outputs mapped to the stems, with OUT kept as Dialogue", () => {
    expect(SPLIT_OUTPUTS.map((o) => [o.id, o.label])).toEqual([
      ["voice", "Dialogue"],
      ["music", "Music"],
      ["effects", "Effects"],
      ["background", "Music & effects"],
    ]);
    expect(outputHandles(split)).toEqual([OUT, "voice", "music", "effects", "background"]);
    expect(outputHandles(words)).toEqual([OUT]);
    expect(edgeStem(split, "background")).toBe("background");
    expect(edgeStem(split, OUT)).toBe("voice");
    expect(edgeStem(split, null)).toBe("voice");
    expect(edgeStem(words, OUT)).toBeUndefined();
    expect(outputLabel(split, "music")).toBe("Music");
    expect(outputLabel(words, OUT)).toBe("");
  });

  it("runs DBS on the open engine and is disabled on the cloud with the reason (never another model in its place)", () => {
    expect(defaultModelForNode({ type: "split-soundtrack", data: {} }, "open")?.id).toBe(SPLIT_MODEL);
    expect(defaultModelForNode({ type: "split-soundtrack", data: {} }, "cloud")).toBeUndefined();
    expect(modelChoices(split).map((m) => m.id)).toEqual([SPLIT_MODEL]);
    expect(paletteItems("both").find((p) => p.id === "split-soundtrack")?.disabled).toBeUndefined();
    expect(paletteItems("both", "cloud").find((p) => p.id === "split-soundtrack")?.disabled).toBe(CLOUD_SPLIT_PROBLEM);
    expect(paletteItems("cloud").find((p) => p.id === "split-soundtrack")?.disabled).toBe(CLOUD_SPLIT_PROBLEM);
  });

  it("connects from each output, and refuses an output it doesn't have", () => {
    const g = board([]);
    for (const h of [OUT, "voice", "music", "effects", "background"]) expect(connectionError(g, { source: "split", sourceHandle: h, target: "words", targetHandle: "audio" }), h).toBeNull();
    expect(connectionError(g, { source: "split", sourceHandle: "drums", target: "words", targetHandle: "audio" })).toBe("Split soundtrack has no output");
    expect(connectionError(g, { source: "words", sourceHandle: "music", target: "mux", targetHandle: "audio" })).toMatch(/has no output/);
  });
});

describe("edges carry their stem into the next node's chain", () => {
  it("Dialogue into Transcribe and Music & effects into a mux", () => {
    const g = board([
      { id: "a", source: "split", sourceHandle: "voice", target: "words", targetHandle: "audio" },
      { id: "b", source: "split", sourceHandle: "background", target: "mux", targetHandle: "audio" },
      { id: "c", source: "clip", sourceHandle: OUT, target: "mux", targetHandle: "video" },
    ]);
    const s = describeNode(g, split);
    expect(s.error).toBeUndefined();
    expect(s.request).toMatchObject({ modelId: SPLIT_MODEL, op: "separate-audio", inputs: { video: clip.data.url } });
    expect(s.costUsd).toBe(0);
    expect(describeNode(g, words).request?.chain).toEqual([{ slot: "audio", stem: "voice" }]);
    const m = describeNode(g, mux);
    expect(m.request?.chain).toEqual([{ slot: "audio", stem: "background" }]);
    expect(m.request?.inputs).toEqual({ video: clip.data.url });
    expect(m.deps).toEqual(["split"]);
  });

  it("an old single-OUT edge carries the dialogue", () => {
    const g = board([{ id: "a", source: "split", sourceHandle: OUT, target: "words", targetHandle: "audio" }]);
    expect(describeNode(g, words).request?.chain).toEqual([{ slot: "audio", stem: "voice" }]);
    // Other nodes' edges carry no stem, as before.
    const tts: CanvasNode = { id: "t", type: "model", position: at(0), data: { modelId: "oss-ace-step", op: "music", prompt: "calm piano" } };
    const g2: CanvasGraph = { nodes: [clip, tts, mux], edges: [{ id: "x", source: "t", sourceHandle: OUT, target: "mux", targetHandle: "audio" }, { id: "y", source: "clip", sourceHandle: OUT, target: "mux", targetHandle: "video" }] };
    expect(describeNode(g2, mux).request?.chain).toEqual([{ slot: "audio" }]);
  });

  it("keeps every output's edge through the storage round trip, and drops an unknown one", () => {
    const g = board([
      { id: "a", source: "split", sourceHandle: "music", target: "words", targetHandle: "audio" },
      { id: "b", source: "split", sourceHandle: "effects", target: "mux", targetHandle: "audio" },
      { id: "c", source: "split", sourceHandle: "drums", target: "mux", targetHandle: "audio" },
      { id: "d", source: "split", sourceHandle: OUT, target: "mux", targetHandle: "audio" },
    ]);
    expect(cleanGraph(g).edges.map((e) => [e.id, e.sourceHandle])).toEqual([
      ["in", OUT],
      ["a", "music"],
      ["b", "effects"],
      ["d", OUT],
    ]);
  });
});

describe("saving a board", () => {
  it("every node type can be saved", () => {
    for (const type of Object.keys(NODE_SPECS) as CanvasNode["type"][]) {
      expect(parseGraph({ nodes: [{ id: "n", type, position: at(0), data: {} }], edges: [] }), type).not.toBeNull();
    }
  });
});

describe("a board whose DBS step runs (demo mode)", () => {
  const req = (method: string, body?: unknown) => new Request("http://localhost/api/canvases", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

  it("saves the four outputs' edges and runs the mux on the Music & effects stem of the split", async () => {
    const g = board([
      { id: "b", source: "split", sourceHandle: "background", target: "mux", targetHandle: "audio" },
      { id: "c", source: "clip", sourceHandle: OUT, target: "mux", targetHandle: "video" },
    ]);
    const { saveFile } = await import("@/server/storage");
    const url = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "interview.mp4" }).url;
    g.nodes = g.nodes.filter((n) => n.id !== "words").map((n) => (n.id === "clip" ? { ...n, data: { url } } : n));
    const created = (await (await list.POST(req("POST", {}))).json()) as Canvas;
    const patched = await one.PATCH(req("PATCH", { graph: g }), ctx(created.id));
    const saved = (await patched.json()) as Canvas;
    expect(patched.status, JSON.stringify(saved)).toBe(200);
    expect(saved.pages[0].graph.edges.find((e) => e.id === "b")?.sourceHandle).toBe("background");
    const res = await run.POST(req("POST", { targets: ["mux"] }), ctx(created.id));
    const body = (await res.json()) as { ran: string[]; items: Generation[]; errors: unknown[] };
    expect(body.errors).toEqual([]);
    expect(body.ran).toEqual(["split", "mux"]);
    const [s, m] = body.items;
    expect(s).toMatchObject({ modelId: SPLIT_MODEL, op: "separate-audio" });
    expect(m.request.chain).toEqual([{ slot: "audio", stem: "background" }]);
    expect((db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(m.id) as { depends_on: string }).depends_on).toBe(s.id);
    expect(gens.getGeneration(m.id)).toBeTruthy();
  });
});
