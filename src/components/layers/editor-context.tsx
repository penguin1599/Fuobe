"use client";

import { createContext, useContext } from "react";
import { pricingAt } from "@/lib/catalog/promo";
import type { Engine } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import type { Box, LayerDoc, LayerJob, LayerJobInput, LayerModelInfo, LayerNode, LayerProject, LayerTool, LayerVersion } from "@/lib/layers";

export type StageMode = "select" | "hand" | "brush" | "eraser" | "region" | "frame" | "inpaint";

/** The part of the picture a tool works on. */
export type Target = { kind: "node"; node: LayerNode } | { kind: "whole" } | { kind: "region"; rect: Box };

/** A tool run as the editor asks for it: the editor renders and uploads the picture and fills in engine and frame. */
export type RunInput = Omit<LayerJobInput, "engine" | "frame" | "image" | "nodeId"> & { target: Target; image?: string; frame?: Box };

export interface MaskEdit {
  nodeId: string;
  canvas: HTMLCanvasElement;
  size: number;
  version: number;
}

/**
 * Inpaint's painted area: white strokes on a transparent canvas the size of the picture the tool
 * sends, over a layer (it follows the layer as it moves) or the whole image.
 */
export interface PaintEdit {
  /** The layer it's painted on; none = the whole image. */
  nodeId?: string;
  canvas: HTMLCanvasElement;
  /** The eraser takes paint away. */
  erase: boolean;
}

export interface EditorCtx {
  projectId: string;
  project: LayerProject;
  versions: LayerVersion[];
  headVersionId: string;
  doc: LayerDoc;
  /** Save an edit as an undo step; commits with the same `merge` key in quick succession (a slider drag) are one step. */
  commit: (doc: LayerDoc, merge?: string) => void;
  selectedId: string | null;
  selected: LayerNode | undefined;
  select: (id: string | null) => void;
  engine: Engine;
  models: Record<string, LayerModelInfo>;
  /**
   * A tool's model ids as Settings → Models & licences offers them: the ones switched off leave its menu and its
   * default (all of them stay when none is on, and a run names the switch).
   */
  offeredIds: (ids: readonly string[]) => string[];
  isDemo: (m: LayerModelInfo | undefined) => boolean;
  jobs: LayerJob[];
  /** The job still working on a layer (queued, running, or finished but not laid out yet). */
  busyJob: (nodeId: string) => LayerJob | undefined;
  /** The newest failed run on a layer the user hasn't dismissed yet. */
  failedJob: (nodeId: string) => LayerJob | undefined;
  /** Show a job's tool (and its layer): where its failure can be retried. */
  showJob: (job: LayerJob) => void;
  /** “An image can only be decomposed once”: the project's fact, whichever version is open. */
  decomposed: boolean;
  /** Start a tool; resolves to the job, or null when it couldn't start (the reason was shown). */
  run: (input: RunInput) => Promise<LayerJob | null>;
  /** Dismiss a failed job, cancel a running one, or mark one used (a text detection that filled Edit text). */
  endJob: (jobId: string, how: "dismiss" | "cancel" | "applied") => void;
  mode: StageMode;
  setMode: (m: StageMode) => void;
  region: Box | null;
  setRegion: (r: Box | null) => void;
  frame: Box | null;
  setFrame: (r: Box | null) => void;
  mask: MaskEdit | null;
  /** Inpaint's painted area (the stage paints into it while the mode is "inpaint"). */
  paint: PaintEdit | null;
  setPaint: (p: PaintEdit | null) => void;
  /** Bumped on every stroke into the painted area. */
  paintVersion: number;
  /** Brush size in document pixels (masks and Inpaint). */
  brushSize: number;
  setBrushSize: (n: number) => void;
  /** A box (doc px) to outline on the canvas (an Edit text row under the pointer). */
  setHighlight: (b: Box | null) => void;
  /** Live previews drawn instead of a layer (colour grading), by node id ("__whole" = an overlay over everything). */
  setPreview: (id: string, c: HTMLCanvasElement | null) => void;
  /** The tool form shown in the rail. */
  tool: ToolId | null;
  openTool: (t: ToolId | null) => void;
  /** Layer id to split when the decomposition tool opens from a layer's menu. */
  splitTarget: string | null;
  setSplitTarget: (id: string | null) => void;
}

export type ToolId = "decompose" | "edit-text" | "remove-bg" | "regional" | "inpaint" | "upscale" | "enhance" | "relight" | "angles" | "expand" | "grade" | "rerender";

/** The tool form that started each kind of job (none: the layer card or the Generate layer dialog). */
export const TOOL_FOR_JOB: Record<LayerTool, ToolId | null> = {
  decompose: "decompose",
  split: "decompose",
  regenerate: null,
  "generate-layer": null,
  "text-detect": "edit-text",
  "text-edit": "edit-text",
  "bg-remove": "remove-bg",
  regional: "regional",
  upscale: "upscale",
  relight: "relight",
  angles: "angles",
  expand: "expand",
  inpaint: "inpaint",
  enhance: "enhance",
  rerender: "rerender",
};

/**
 * A key press the editor's shortcuts should leave alone: already handled, typed into a field, or
 * pressed in a dialog, menu or list (a Delete in the Edit history sheet mustn't delete a layer).
 */
export function keysBelongElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  if (t instanceof Element && t.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return true;
  // A modal is open (focus can sit on its overlay or the page behind for a moment).
  return !!document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"]');
}

export const Ctx = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useEditor outside the Layers editor");
  return c;
}

/**
 * "Placeholder · free", "Free · your GPU", "≈ $0.27" or "Price unknown". A launch price is read on the browser's clock, the day
 * the editor shows it (the editor renders once its project has loaded in the browser, never while a page prerenders).
 */
export function costLabel(m: LayerModelInfo | undefined, demo: boolean, usd?: number | null): string {
  if (!m) return "";
  if (demo) return "Placeholder · free";
  if (m.engine === "open") return "Free · your GPU";
  const p = m.pricing && pricingAt(m.pricing);
  const v = usd !== undefined ? usd : p && ["image", "request", "megapixel"].includes(p.unit) ? p.usd : null;
  return v == null ? "Price unknown" : v === 0 ? "Free" : `≈ ${formatCost(v)}`;
}

/** The tool's models on an engine, as the page described them. */
export function modelsFor(models: Record<string, LayerModelInfo>, ids: string[]): LayerModelInfo[] {
  return ids.map((id) => models[id]).filter((m): m is LayerModelInfo => !!m);
}

export const isRunning = (j: LayerJob) => j.state === "pending" && (!j.result || j.result.status === "queued" || j.result.status === "running");
export const isFailed = (j: LayerJob) => j.state === "pending" && !!j.result && (j.result.status === "failed" || j.result.status === "canceled");

/** The newest job of these tools that isn't dismissed (what a tool form shows). */
export function latestJob(jobs: LayerJob[], tools: LayerTool[], nodeId?: string | null): LayerJob | undefined {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (tools.includes(j.tool) && j.state !== "dismissed" && (nodeId === undefined || (j.nodeId ?? null) === nodeId)) return j;
  }
  return undefined;
}
