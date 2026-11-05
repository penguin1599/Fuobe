import "server-only";
import { MAX_KEYS } from "@/lib/camera-path";
import { RECIPE_MAX_BYTES, RecipeSchema } from "@/lib/motion/recipe";
import { CameraKeySchema, ExactOrbitSchema } from "./fly-around";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  BOARD_COLORS,
  BOARD_LIMITS,
  FIRST_PAGE_ID,
  groupTargets,
  nextPageName,
  pageContent,
  pageName,
  pageOf,
  readPages,
  withPageGraph,
  type CanvasPage,
} from "@/lib/catalog/canvas-board";
import {
  CANVAS_TEXT_MAX as TEXT_MAX,
  CONCAT_LIMITS,
  TABLE_LIMITS,
  LAYOUT_NODE_LIMITS,
  cleanGraph,
  concatClips,
  depIdentity,
  EMPTY_GRAPH,
  getTemplate,
  keptRow,
  NODE_SPECS,
  nodeLabel,
  nodeMap,
  nodeSignature,
  outline,
  planCanvas,
  rowSignature,
  silenceSeconds,
  withCurrentModels,
  withCurrentElements,
  type Canvas,
  type CanvasGraph,
  type CanvasNodeType,
  type CanvasPlan,
  type CanvasRuns,
  type NodeRun,
  type CanvasSummary,
  type StepSource,
} from "@/lib/catalog/canvas";
import type { Engine, Generation, GenerationRequest, MediaKind } from "@/lib/catalog/types";
import { readLayout } from "@/lib/layout-prompt";
import { LATENT_EXTRA } from "@/lib/catalog/regenerate";
import { createPipeline } from "./chains";
import { db } from "./db";
import { listElements } from "./elements";
import { isOffered } from "./model-access";
import { createGenerations, getGeneration } from "./generations";
import { silentWav } from "./marketing";
import { engineMode } from "./settings";
import { absolutePath, saveFile } from "./storage";
import { fillSamples, isPublishedSample } from "./canvas-samples";

/**
 * Canvas boards (Higgsfield Canvas): the pages the user edits (each a graph, with its groups, comments and
 * drawings), plus the last run of each generator node. Running turns a page's graph into chained generations
 * (src/lib/catalog/canvas.ts plans it; createGenerations + dependsOn runs it, createPipeline for a node made in
 * several steps), so results survive restarts like any other job. graph_json holds {pages}; a row saved before
 * pages holds one graph, read as page 1 (readPages).
 */

interface Row {
  id: string;
  name: string;
  graph_json: string;
  runs_json: string;
  template_id: string | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
}

const toCanvas = (r: Row): Canvas => ({
  id: r.id,
  name: r.name,
  pages: readPages(JSON.parse(r.graph_json)).map((p) => ({ ...p, graph: withCurrentModels(p.graph) })),
  runs: JSON.parse(r.runs_json) as CanvasRuns,
  templateId: r.template_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  editedAt: r.edited_at,
});

// ---------------------------------------------------------------------------
// Validation of graphs coming from the browser

const NODE_TYPES = [
  "prompt",
  "image-input",
  "video-input",
  "audio-input",
  "element",
  "model",
  "join",
  "frame",
  "upscale",
  "bg-remove",
  "tts",
  "voice-change",
  "clean-voice",
  "split-soundtrack",
  "clone-voice",
  "translate",
  "concat",
  "restore",
  "table",
  "layout",
  "camera-path",
  "fly-around",
  "kinetic",
  "output",
  "note",
] as const satisfies readonly CanvasNodeType[];
const KINDS = ["image", "video", "audio", "text", "model3d"] as const satisfies readonly MediaKind[];

/** The settings a node may send (the same limits as POST /api/generations). */
const Params = z.object({
  aspectRatio: z.string().max(20).optional(),
  resolution: z.string().max(20).optional(),
  duration: z.number().positive().max(600).optional(),
  numOutputs: z.number().int().min(1).max(8).optional(),
  seed: z.number().int().optional(),
  generateAudio: z.boolean().optional(),
  voice: z.string().max(200).optional(),
  targetLanguage: z.string().max(80).optional(),
  sourceLanguage: z.string().max(80).optional(),
  // Less the server's own (MiniMax H3's 2K hand-off), as POST /api/generations drops them.
  extra: z
    .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
    .transform((extra) => Object.fromEntries(Object.entries(extra).filter(([k]) => !(LATENT_EXTRA as readonly string[]).includes(k))))
    .optional(),
});

/** Free text is clamped, not refused: one over-long paste must never stop the whole board from saving. */
const clamped = (max: number) => z.string().transform((s) => s.slice(0, max));

/** Element handles are letters, digits, `_` and `-` (handleFor); anything else is dropped. */
const Handle = z
  .string()
  .max(200)
  .transform((h) => h.replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 60) || undefined);

/** A Layout node's draft: up to 64 boxes with their words clamped, fractions on the canvas (readLayout keeps the rest). */
const LayoutData = z
  .unknown()
  .transform((v) => readLayout(v) ?? undefined)
  .refine((d) => !d || d.items.length <= LAYOUT_NODE_LIMITS.boxes, `A layout holds up to ${LAYOUT_NODE_LIMITS.boxes} boxes`)
  .transform((d) =>
    d
      ? {
          ...d,
          summary: { ...d.summary, caption: d.summary.caption.slice(0, TEXT_MAX), meta: d.summary.meta.slice(0, 20).map((m) => m.slice(0, 80)) },
          items: d.items.map((it) => ({ ...it, caption: it.caption.slice(0, 2000), ...(it.text !== undefined && { text: it.text.slice(0, 2000) }) })),
        }
      : undefined,
  );

/** Media on the owner's boards: Fuobe's own storage (uploads, the library, generated outputs). */
const OWN_MEDIA = z.string().startsWith("/api/files/").max(2000);

/**
 * Media on an account's own board: a stored file (the file route checks whose it is when it is read), or one of Fuobe's
 * published example files a ready board starts with (/examples/…, /samples/…, /previews/presets/…, /starters/…), as a
 * plain path that never steps out of its folder.
 */
const VISITOR_MEDIA = z
  .string()
  .max(2000)
  .refine((u) => u.startsWith("/api/files/") || isPublishedSample(u), "Not a file this board can hold");

const nodeData = (media: z.ZodType<string>) =>
  z.object({
  label: clamped(80).optional(),
  text: clamped(TEXT_MAX).optional(),
  url: media.optional(),
  name: clamped(200).optional(),
  elementId: z.string().max(40).optional(),
  handle: Handle.optional(),
  preview: media.optional(),
  modelId: z.string().max(120).optional(),
  // A Fuobe Original (runs on both engines): the engine the node runs it on.
  engine: z.enum(["open", "cloud"]).optional(),
  op: z.string().max(40).optional(),
  prompt: clamped(TEXT_MAX).optional(),
  params: Params.optional(),
  pinned: z.boolean().optional(),
  mediaKind: z.enum(KINDS).optional(),
  // Video Concatenator: each clip's cut and sound (by source node id) and the clips' order.
  clips: z
    .record(
      z.string().max(80),
      z.object({
        start: z.number().min(0).max(36_000).optional(),
        end: z.number().min(0).max(36_000).optional(),
        mute: z.boolean().optional(),
        length: z.number().min(0).max(36_000).optional(),
        width: z.number().int().min(1).max(16_384).optional(),
        height: z.number().int().min(1).max(16_384).optional(),
        audio: z.boolean().optional(),
      }),
    )
    .optional(),
  order: z.array(z.string().max(80)).max(CONCAT_LIMITS.clips * 2).optional(),
  // Table: column names and rows of cells (a few empty rows past the limit are fine; only filled rows run).
  columns: z.array(z.string().max(TABLE_LIMITS.column)).min(1).max(TABLE_LIMITS.columns).optional(),
  rows: z.array(z.array(z.string().max(TABLE_LIMITS.cell)).max(TABLE_LIMITS.columns)).max(TABLE_LIMITS.rows * 2).optional(),
  // Translate (video) on the open engine: the dub it started in Translate & dub.
  dubId: z.string().max(40).optional(),
  // Layout: its boxes (read as a Fuobe draft, anything else dropped).
  layout: LayoutData.optional(),
  // Camera path: a preset, an exact orbit or keys; Fly around: the clip's length.
  pathPreset: z.string().max(40).optional(),
  orbit: ExactOrbitSchema.optional(),
  keys: z.array(CameraKeySchema).min(1).max(MAX_KEYS).optional(),
  duration: z.number().min(1).max(15).optional(),
  // Kinetic: its scene and settings as a recipe (one that doesn't read as one is dropped, never refused).
  kinetic: z
    .unknown()
    .transform((v) => {
      const r = RecipeSchema.safeParse(v);
      return r.success && JSON.stringify(r.data).length <= RECIPE_MAX_BYTES ? r.data : undefined;
    })
    .optional(),
});

const Num = z.number().finite();
const Color = z.enum(BOARD_COLORS);

const Group = z.object({
  id: z.string().min(1).max(80),
  title: clamped(BOARD_LIMITS.groupTitle),
  color: Color,
  x: Num,
  y: Num,
  width: Num.positive().max(40_000),
  height: Num.positive().max(40_000),
});

const Reply = z.object({ id: z.string().min(1).max(80), author: clamped(60), text: clamped(BOARD_LIMITS.commentText), at: Num });

const Comment = z.object({
  id: z.string().min(1).max(80),
  x: Num,
  y: Num,
  author: clamped(60),
  text: clamped(BOARD_LIMITS.commentText),
  at: Num,
  resolved: z.boolean().optional(),
  replies: z.array(Reply).max(BOARD_LIMITS.replies).optional(),
});

const Shape = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["rect", "ellipse", "arrow", "text", "pen"]),
  x: Num,
  y: Num,
  width: Num.positive().max(40_000),
  height: Num.positive().max(40_000),
  color: Color,
  text: clamped(BOARD_LIMITS.shapeText).optional(),
  points: z.array(z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)])).max(BOARD_LIMITS.penPoints).optional(),
});

const graphSchema = (media: z.ZodType<string>) =>
  z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        type: z.enum(NODE_TYPES),
        position: z.object({ x: Num, y: Num }),
        data: nodeData(media),
        width: Num.positive().max(4000).optional(),
        height: Num.positive().max(4000).optional(),
      }),
    )
    .max(300),
  edges: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        source: z.string().min(1).max(80),
        target: z.string().min(1).max(80),
        sourceHandle: z.string().max(40).nullish(),
        targetHandle: z.string().max(40).nullish(),
      }),
    )
    .max(1200),
  viewport: z.object({ x: Num, y: Num, zoom: Num.positive().max(10) }).optional(),
  groups: z.array(Group).max(BOARD_LIMITS.groups).optional(),
  comments: z.array(Comment).max(BOARD_LIMITS.comments).optional(),
  shapes: z.array(Shape).max(BOARD_LIMITS.shapes).optional(),
});

export const GraphSchema = graphSchema(OWN_MEDIA);

const pagesSchema = (graph: typeof GraphSchema) =>
  z
    .array(z.object({ id: z.string().min(1).max(40), name: clamped(60), graph }))
    .min(1)
    .max(BOARD_LIMITS.pages);

export const PagesSchema = pagesSchema(GraphSchema);
/** An account's own board (account-canvas.ts): the same limits, and Fuobe's published example files may stay in it. */
const VisitorPagesSchema = pagesSchema(graphSchema(VISITOR_MEDIA));

/** Why a graph from the browser was refused, naming the node (the editor shows it in a toast). */
export function graphProblem(input: unknown): string {
  const parsed = GraphSchema.safeParse(input);
  const fallback = "That board couldn't be saved — reload the page";
  if (parsed.success) return fallback;
  const [list, index, ...rest] = parsed.error.issues[0]?.path ?? [];
  if (list === "nodes" && typeof index === "number") {
    const n = (input as { nodes?: { type?: string; data?: { label?: unknown } }[] }).nodes?.[index];
    const custom = typeof n?.data?.label === "string" && n.data.label.trim() ? n.data.label.trim().slice(0, 80) : undefined;
    const label = custom ?? NODE_SPECS[n?.type as CanvasNodeType]?.label ?? "A node";
    const field = rest.filter((p): p is string => typeof p === "string" && p !== "data").join(" ");
    return `“${label}” couldn't be saved${field ? ` (its ${field})` : ""}: change it or remove the node`;
  }
  if (list === "nodes") return "This board has too many nodes to save (300 at most)";
  if (list === "edges") return "This board has too many connections to save (1,200 at most)";
  // One drawing, group or comment that doesn't fit (not too many of them): say which kind, and what to do.
  if (list === "shapes" && typeof index === "number") {
    const kind = (input as { shapes?: { kind?: string }[] }).shapes?.[index]?.kind;
    return rest[0] === "points" ? "A drawing has too many points to save — erase it and draw it again in shorter strokes" : `A ${kind === "text" ? "text" : "drawing"} on this board couldn't be saved — erase it and make it again`;
  }
  if (list === "groups" && typeof index === "number") return "A group on this board couldn't be saved — ungroup it and group the nodes again";
  if (list === "comments" && typeof index === "number") return "A comment on this board couldn't be saved — delete it and pin it again";
  if (list === "groups") return `This board has too many groups to save (${BOARD_LIMITS.groups} at most)`;
  if (list === "comments") return `This board has too many comments to save (${BOARD_LIMITS.comments} at most)`;
  if (list === "shapes") return `This board has too many drawings to save (${BOARD_LIMITS.shapes} at most) — erase a few`;
  return fallback;
}

/** Why pages from the browser were refused (the page and the node, when one is to blame). */
export function pagesProblem(input: unknown): string {
  if (!Array.isArray(input) || !input.length) return "A canvas needs at least one page";
  if (input.length > BOARD_LIMITS.pages) return `A canvas holds up to ${BOARD_LIMITS.pages} pages`;
  for (const [i, p] of input.entries()) {
    const g = (p as { graph?: unknown } | null)?.graph;
    if (!GraphSchema.safeParse(g).success) {
      const name = typeof (p as { name?: unknown })?.name === "string" ? (p as { name: string }).name : pageName(i);
      return `${name}: ${graphProblem(g)}`;
    }
  }
  return "Those pages couldn't be saved — reload the page";
}

/** A parsed graph, with duplicate node ids, dangling edges and edges into missing handles removed. */
export function parseGraph(input: unknown): CanvasGraph | null {
  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) return null;
  const g = parsed.data as CanvasGraph;
  const seen = new Set<string>();
  const nodes = g.nodes.filter((n) => !seen.has(n.id) && seen.add(n.id));
  return cleanGraph({ ...g, nodes });
}

/**
 * Parsed pages: page ids made unique, and a node id used on an earlier page dropped from later ones
 * (results are kept by node id, so two pages can't share one).
 */
export function parsePages(input: unknown, schema: typeof PagesSchema = PagesSchema): CanvasPage[] | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return null;
  const ids = new Set<string>();
  const nodeIds = new Set<string>();
  return parsed.data.map((p, i) => {
    let id = p.id;
    for (let k = 2; ids.has(id); k++) id = `${p.id}-${k}`;
    ids.add(id);
    const g = p.graph as CanvasGraph;
    const nodes = g.nodes.filter((n) => !nodeIds.has(n.id) && nodeIds.add(n.id));
    return { id, name: p.name.trim() || pageName(i), graph: cleanGraph({ ...g, nodes }) };
  });
}

/** An account's own pages (parsePages, where Fuobe's published example files may stay in an input). */
export function parseVisitorPages(input: unknown): CanvasPage[] | null {
  return parsePages(input, VisitorPagesSchema);
}

// ---------------------------------------------------------------------------
// CRUD

export function getCanvas(id: string): Canvas | null {
  const r = db().prepare("SELECT * FROM canvases WHERE id = ?").get(id) as Row | undefined;
  return r ? toCanvas(r) : null;
}

/** Generations in the Trash count as gone: never a card preview, never a fresh result to reuse. */
const NOT_TRASHED = "NOT EXISTS (SELECT 1 FROM generation_trash t WHERE t.generation_id = g.id)";

/** The newest finished image among the canvas's results (a video when it made no image). */
function previewOf(runs: CanvasRuns): CanvasSummary["preview"] {
  const ids = Object.values(runs)
    .sort((a, b) => b.at - a.at)
    // A node made in steps shows its result, not one of its cuts.
    .flatMap((r) => (r.out ? [r.out] : r.ids))
    .slice(0, 60);
  if (!ids.length) return null;
  const rows = db()
    .prepare(
      `SELECT g.outputs_json FROM generations g WHERE g.id IN (${ids.map(() => "?").join(",")}) AND g.status = 'succeeded' AND g.kind IN ('image','video') AND ${NOT_TRASHED} ORDER BY g.kind = 'image' DESC, g.completed_at DESC LIMIT 1`,
    )
    .all(...ids) as { outputs_json: string }[];
  const o = rows[0] ? (JSON.parse(rows[0].outputs_json) as { url: string; kind: MediaKind; meta?: { poster?: unknown } }[]).find((x) => x.kind === "image" || x.kind === "video") : undefined;
  if (!o) return null;
  // A clip's own poster (a Kinetic clip's last frame) shows on the card instead of its empty first frame.
  const poster = o.kind === "video" && typeof o.meta?.poster === "string" ? o.meta.poster : undefined;
  return { url: o.url, kind: o.kind, ...(poster && { poster }) };
}

export function listCanvases(): CanvasSummary[] {
  const rows = db().prepare("SELECT * FROM canvases ORDER BY updated_at DESC LIMIT 200").all() as Row[];
  return rows.map((r) => {
    const c = toCanvas(r);
    return {
      id: c.id,
      name: c.name,
      nodeCount: c.pages.reduce((n, p) => n + p.graph.nodes.length, 0),
      pageCount: c.pages.length,
      templateId: c.templateId,
      preview: previewOf(c.runs),
      outline: outline(c.pages[0].graph),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      editedAt: c.editedAt,
    };
  });
}

export interface CreateCanvasInput {
  name?: string;
  graph?: CanvasGraph;
  pages?: CanvasPage[];
  /** Start from a template, in the cloud or the all-open-source variant. */
  templateId?: string;
  engine?: Engine;
}

export function createCanvas(input: CreateCanvasInput = {}): Canvas {
  const template = input.templateId ? getTemplate(input.templateId) : undefined;
  if (input.templateId && !template) throw new Error("That template doesn't exist");
  // A locked install only ever gets the variant it can run.
  const mode = engineMode();
  const engine: Engine = mode === "both" ? (input.engine ?? "cloud") : mode;
  // A ready board starts with its sample files in place, so it runs as it is.
  const graph = template ? fillSamples(template.build(engine, (id) => isOffered(id, engine)), template.samples) : (input.graph ?? EMPTY_GRAPH);
  const pages = !template && input.pages?.length ? input.pages : [{ id: FIRST_PAGE_ID, name: pageName(0), graph: cleanGraph(graph) }];
  const now = Date.now();
  const row: Row = {
    id: nanoid(10),
    name: (input.name?.trim() || template?.name || "Untitled canvas").slice(0, 80),
    graph_json: JSON.stringify({ pages }),
    runs_json: "{}",
    template_id: template?.id ?? null,
    created_at: now,
    updated_at: now,
    edited_at: null,
  };
  db()
    .prepare(`INSERT INTO canvases (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toCanvas(row);
}

export interface CanvasPatch {
  name?: string;
  /** Every page, as the editor has them (page tabs added, renamed, reordered or removed). */
  pages?: CanvasPage[];
  /** One page's board: `page` (the first page when omitted, as before pages). */
  graph?: CanvasGraph;
  page?: string;
}

/** A change the canvas can't take as it is now (a 409: the editor shows the message). */
export class CanvasConflict extends Error {
  readonly status = 409;
}

/**
 * Save a new name, pages and/or one page's graph. Moving a viewport alone doesn't count as an edit. A graph for a
 * page the canvas doesn't have yet (one the editor added, run before its autosave) adds that page; with no room for
 * it, the save is refused (CanvasConflict) rather than written over another page.
 */
export function updateCanvas(id: string, patch: CanvasPatch): Canvas | null {
  const current = getCanvas(id);
  if (!current) return null;
  const now = Date.now();
  const name = patch.name?.trim() ? patch.name.trim().slice(0, 80) : current.name;
  let pages = current.pages;
  if (patch.pages?.length) pages = patch.pages.map((p) => ({ ...p, graph: cleanGraph(p.graph) }));
  if (patch.graph) {
    const known = !patch.page || pages.some((p) => p.id === patch.page);
    if (!known && pages.length >= BOARD_LIMITS.pages) throw new CanvasConflict(`This canvas already holds ${BOARD_LIMITS.pages} pages, so the new one couldn't be saved — reload the canvas`);
    const target = patch.page ?? pages[0].id;
    // Results are kept by node id, so two pages can't share one: a node another page holds stays there (as parsePages does).
    const elsewhere = new Set(pages.filter((p) => p.id !== target).flatMap((p) => p.graph.nodes.map((n) => n.id)));
    const graph = cleanGraph({ ...patch.graph, nodes: patch.graph.nodes.filter((n) => !elsewhere.has(n.id)) });
    pages = known ? withPageGraph(pages, target, graph) : [...pages, { id: target, name: nextPageName(pages), graph }];
  }
  const edited = pageContent(pages) !== pageContent(current.pages) ? now : current.editedAt;
  db().prepare("UPDATE canvases SET name = ?, graph_json = ?, updated_at = ?, edited_at = ? WHERE id = ?").run(name, JSON.stringify({ pages }), now, edited, id);
  return getCanvas(id);
}

export function duplicateCanvas(id: string): Canvas | null {
  const c = getCanvas(id);
  if (!c) return null;
  const now = Date.now();
  const row: Row = {
    id: nanoid(10),
    name: `Copy of ${c.name}`.slice(0, 80),
    graph_json: JSON.stringify({ pages: c.pages }),
    // The copy shows the same results until it's run again.
    runs_json: JSON.stringify(c.runs),
    template_id: c.templateId,
    created_at: now,
    updated_at: now,
    edited_at: c.editedAt,
  };
  db()
    .prepare(`INSERT INTO canvases (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toCanvas(row);
}

/** Deletes the board; what it made stays in the library. */
export function deleteCanvas(id: string): boolean {
  return db().prepare("DELETE FROM canvases WHERE id = ?").run(id).changes > 0;
}

/** The canvas with the generations its nodes made (for status, progress and outputs). */
export function canvasView(id: string): { canvas: Canvas; generations: Generation[] } | null {
  const stored = getCanvas(id);
  if (!stored) return null;
  // Element nodes show (and mention) their element as it's called now, after a rename.
  const elements = listElements();
  const canvas = { ...stored, pages: stored.pages.map((p) => ({ ...p, graph: withCurrentElements(p.graph, elements) })) };
  const ids = [...new Set(Object.values(canvas.runs).flatMap((r) => r.ids))];
  // getGeneration also makes sure the runner is polling after a restart.
  const generations = ids.map((g) => getGeneration(g)).filter((g): g is Generation => !!g);
  return { canvas, generations };
}

// ---------------------------------------------------------------------------
// Run

export interface RunOptions {
  /** The page to run (the first one when omitted). */
  page?: string;
  /** Every page as the editor has them (saved first, like an autosave): the run saves the whole canvas. */
  pages?: CanvasPage[];
  /** Nodes to run with their upstream; omit for Run all (of the page). */
  targets?: string[];
  /** Run a group: its nodes and what they need. */
  group?: string;
  /** Re-run the targets even when their result is fresh. */
  force?: boolean;
  /** The page's board as the editor has it now (saved first, so an autosave in flight can't race the run). */
  graph?: CanvasGraph;
}

export interface RunResult {
  canvas: Canvas;
  /** Generations created, in run order. */
  items: Generation[];
  /** Node ids that started, in order. */
  ran: string[];
  reused: CanvasPlan["reused"];
  errors: CanvasPlan["errors"];
  costUsd: number;
}

/** A result's status; undefined once it's gone (deleted, or in the Trash), so its node runs again. */
function statusOf(id: string): Generation["status"] | undefined {
  return (db().prepare(`SELECT g.status FROM generations g WHERE g.id = ? AND ${NOT_TRASHED}`).get(id) as { status: Generation["status"] } | undefined)?.status;
}

/** A clip on the board that the concatenator refuses: a stored file over 512 MB. */
function oversizedClip(graph: CanvasGraph, nodeId: string): string | null {
  const nodes = nodeMap(graph);
  const n = nodes.get(nodeId);
  if (n?.type !== "concat") return null;
  for (const [i, c] of concatClips(graph, n).entries()) {
    const url = nodes.get(c.nodeId)?.data.url;
    if (!url?.startsWith("/api/files/")) continue;
    try {
      if (fs.statSync(absolutePath(decodeURIComponent(url.slice("/api/files/".length)))).size > CONCAT_LIMITS.maxBytes) return `Clip ${i + 1} is over 512 MB — trim or compress it first`;
    } catch {
      // Gone: the job says so.
    }
  }
  return null;
}

/**
 * The silent tracks a run's steps name (silenceRef: a muted or soundless clip of the cloud concatenator), written
 * as WAV files when the run starts; one file per length.
 */
export function silenceWriter(): (req: GenerationRequest) => GenerationRequest {
  const files = new Map<number, string>();
  return (req) => {
    const seconds = silenceSeconds(req.inputs?.audio);
    if (seconds === null) return req;
    let url = files.get(seconds);
    if (!url) {
      url = saveFile({ data: silentWav(seconds), contentType: "audio/wav", source: "generation", name: "canvas-silence.wav" }).url;
      files.set(seconds, url);
    }
    return { ...req, inputs: { ...req.inputs, audio: url } };
  };
}

export function runCanvas(id: string, opts: RunOptions = {}): RunResult | null {
  let canvas = getCanvas(id);
  if (!canvas) return null;
  if (opts.pages?.length) canvas = updateCanvas(id, { pages: opts.pages })!;
  if (opts.graph) canvas = updateCanvas(id, { graph: opts.graph, page: opts.page })!;
  // A page named is run, never another one in its place.
  if (opts.page && !canvas.pages.some((p) => p.id === opts.page)) throw new CanvasConflict("That page isn't on this canvas any more — reload it");
  // An element renamed since the board was saved: its node mentions the new @handle.
  const graph = withCurrentElements(pageOf(canvas.pages, opts.page).graph, listElements());
  const targets = opts.group ? groupTargets(graph, opts.group) : opts.targets;
  if (opts.group && !targets?.length) return { canvas, items: [], ran: [], reused: [], errors: [{ nodeId: opts.group, message: "This group has no nodes in it yet" }], costUsd: 0 };
  const plan = planCanvas(graph, { targets, force: opts.force, runs: canvas.runs, status: statusOf, engineMode: engineMode() });
  const nodes = nodeMap(graph);
  const batchId = nanoid(10);
  const made = new Map<string, string>(plan.reused.map((r) => [r.nodeId, r.generationId]));
  // Nodes run per row of a table: each row's generation (a row of the next node waits for the same row).
  const madeRows = new Map<string, string[]>(plan.reused.flatMap((r) => (canvas.runs[r.nodeId]?.rows ? [[r.nodeId, canvas.runs[r.nodeId].rows!] as [string, string[]]] : [])));
  const errors = [...plan.errors];
  const withSilence = silenceWriter();
  const items: Generation[] = [];
  const ran: string[] = [];
  const runs: CanvasRuns = {};
  /** What each started node costs (a node run per row: only the rows that run again). */
  const spent = new Map<string, number>();
  const n = plan.steps.length;
  plan.steps.forEach((step, i) => {
    const depIds = step.deps.map((d) => made.get(d));
    const missing = step.deps.find((d, k) => !depIds[k]);
    if (missing) {
      errors.push({ nodeId: step.nodeId, message: `Waiting on “${nodeLabel(nodes.get(missing)!)}”, which couldn't start` });
      return;
    }
    try {
      const sig = nodeSignature(step.request, step.deps.map((d, k) => depIdentity({ rows: madeRows.get(d) }, depIds[k] as string)), step.steps);
      if (step.steps) {
        const big = oversizedClip(graph, step.nodeId);
        if (big) throw new Error(big);
        // A node made in several steps: one pipeline, waiting on the upstream nodes' results like on its own steps.
        const existing: Record<string, string> = Object.fromEntries(step.deps.map((d, k) => [`node:${d}`, depIds[k] as string]));
        const at = (f: StepSource) => {
          if (!("node" in f)) return f.step;
          if (f.row === undefined) return `node:${f.node}`;
          const id = madeRows.get(f.node)?.[f.row];
          if (!id) throw new Error(`Row ${f.row + 1} of “${nodeLabel(nodes.get(f.node)!)}” has no result yet — run it again`);
          existing[`node:${f.node}#${f.row}`] = id;
          return `node:${f.node}#${f.row}`;
        };
        // A node run per row keeps the rows whose result is live and whose inputs didn't change: one failed row
        // (or a row added to the table) runs, and is paid for, on its own.
        const source = (f: StepSource) => ("node" in f ? (f.row === undefined ? made.get(f.node) : madeRows.get(f.node)?.[f.row]) : undefined);
        const rowSigs = step.rows ? step.steps.map((st) => rowSignature(st.request, st.from.map(source))) : undefined;
        const prev = canvas.runs[step.nodeId];
        const kept = step.steps.map((_, r) => (rowSigs && step.reason !== "forced" ? keptRow(prev, r, rowSigs[r], sig, statusOf) : undefined));
        const todo = step.steps.filter((_, r) => !kept[r]);
        const pipe = todo.length
          ? createPipeline(
              todo.map((st) => ({
                key: st.key,
                request: withSilence({ ...st.request, step: { label: st.request.step?.label ?? step.label, index: i, of: n } }),
                after: st.from.map(at),
              })),
              { batchId, existing },
            )
          : null;
        if (step.rows) {
          // Every row is a result; the next node takes the first one, or its own row.
          const rows = step.steps.map((st, r) => kept[r] ?? pipe!.byKey[st.key].id);
          made.set(step.nodeId, rows[0]);
          madeRows.set(step.nodeId, rows);
          const ids = [...rows, ...(pipe?.items.map((g) => g.id).filter((g) => !rows.includes(g)) ?? [])];
          runs[step.nodeId] = { sig, ids, rows, rowSigs, at: Date.now() };
          spent.set(step.nodeId, (step.rowCostUsd ?? 0) * todo.length);
        } else {
          const out = pipe!.byKey[step.steps[step.steps.length - 1].key];
          made.set(step.nodeId, out.id);
          runs[step.nodeId] = { sig, ids: pipe!.items.map((g) => g.id), out: out.id, at: Date.now() };
          spent.set(step.nodeId, step.costUsd ?? 0);
        }
        if (!pipe) return;
        items.push(...pipe.items);
      } else {
        const created = createGenerations(
          { ...step.request, step: { label: step.label, index: i, of: n } },
          { batchId, ...(depIds.length && { dependsOn: depIds as string[] }) },
        );
        made.set(step.nodeId, created[0].id);
        runs[step.nodeId] = { sig, ids: created.map((g) => g.id), at: Date.now() };
        spent.set(step.nodeId, step.costUsd ?? 0);
        items.push(...created);
      }
      ran.push(step.nodeId);
    } catch (e) {
      errors.push({ nodeId: step.nodeId, message: (e as Error).message });
    }
  });
  if (Object.keys(runs).length) {
    // Merge into the latest runs (another run may have finished writing meanwhile).
    db().transaction(() => {
      const row = db().prepare("SELECT runs_json FROM canvases WHERE id = ?").get(id) as { runs_json: string } | undefined;
      const merged = { ...(row ? (JSON.parse(row.runs_json) as CanvasRuns) : {}), ...runs };
      db().prepare("UPDATE canvases SET runs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), Date.now(), id);
    })();
  }
  return {
    canvas: getCanvas(id)!,
    items,
    ran,
    reused: plan.reused,
    errors,
    costUsd: Math.round([...spent.values()].reduce((sum, c) => sum + c, 0) * 10000) / 10000,
  };
}

// ---------------------------------------------------------------------------
// Kinetic: runs made in the browser

/** At most this many rows of a Kinetic node are kept as one run. */
export const KINETIC_RUN_ROWS = 50;

export class KineticRunProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Keeps the run of a Kinetic node (rendered in the owner's browser, each row saved as a result): the node must be a
 * Kinetic node on this canvas, and every id a finished Kinetic Motion result (model local-motion) of the owner's own
 * (an account's run never joins a canvas). Merged into the latest runs, as a server run is.
 */
export function recordKineticRun(id: string, nodeId: string, run: { sig: string; ids: string[]; rows?: string[]; rowSigs?: string[] }): Canvas {
  const canvas = getCanvas(id);
  if (!canvas) throw new KineticRunProblem("Not found", 404);
  const node = canvas.pages.flatMap((p) => p.graph.nodes).find((n) => n.id === nodeId);
  if (!node || node.type !== "kinetic") throw new KineticRunProblem("That isn't a Kinetic node on this canvas", 400);
  if (!run.ids.length || run.ids.length > KINETIC_RUN_ROWS) throw new KineticRunProblem(`A Kinetic run keeps 1 to ${KINETIC_RUN_ROWS} results`, 400);
  const mine = db().prepare(`SELECT 1 FROM generations g WHERE g.id = ? AND g.status = 'succeeded' AND g.model_id = 'local-motion' AND json_extract(g.request_json, '$.account') IS NULL AND ${NOT_TRASHED}`);
  if (run.ids.some((g) => !mine.get(g))) throw new KineticRunProblem("We can't find that.", 404);
  const value: NodeRun = { sig: run.sig, ids: run.ids, at: Date.now(), ...(run.rows && { rows: run.rows }), ...(run.rowSigs && { rowSigs: run.rowSigs }) };
  db().transaction(() => {
    const row = db().prepare("SELECT runs_json FROM canvases WHERE id = ?").get(id) as { runs_json: string } | undefined;
    const merged = { ...(row ? (JSON.parse(row.runs_json) as CanvasRuns) : {}), [nodeId]: value };
    db().prepare("UPDATE canvases SET runs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), Date.now(), id);
  })();
  return getCanvas(id)!;
}
