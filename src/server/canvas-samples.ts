import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanvasGraph, CanvasTemplate } from "@/lib/catalog/canvas";
import { db } from "./db";
import { exampleStat } from "./example-files";
import { absolutePath, contentTypeFor, getAsset, saveFile } from "./storage";

/**
 * A ready board's starting files (a template's `samples`): Fuobe's own public files, copied into the owner's storage
 * when the board is made, so its inputs hold a picture, a clip or a voice and "Run all" runs as it is. A canvas input
 * only takes a stored file (/api/files/…), so the copy is what the node names. Each file is stored once, as a file the
 * Library lists don't show ("derived"), and reused by the next board while it is still there.
 */

const PUBLIC_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "public");

/** Where a sample may come from: Fuobe's published example inputs, its samples, its preview covers and its starters' files. */
const FOLDERS = ["/examples/", "/samples/", "/previews/presets/", "/starters/"];

/** The file on disk a sample names, or null: a plain path under one of FOLDERS, never one that steps out of public/. */
export function sampleFile(src: string): string | null {
  if (!FOLDERS.some((f) => src.startsWith(f)) || /[?#\\\0%]/.test(src) || src.split("/").some((p) => p === "..")) return null;
  // A published example input is read only when its bytes are the ones listed (example-files.ts).
  if (src.startsWith("/examples/")) return exampleStat(src)?.abs ?? null;
  const abs = path.resolve(PUBLIC_DIR, `.${src}`);
  return abs.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(abs) ? abs : null;
}

/** The stored copy of a sample: the one made before while its file is there, else a new one. Its name carries the content hash. */
function storedSample(abs: string): string {
  const data = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const key = `starter-${crypto.createHash("sha256").update(data).digest("hex").slice(0, 16)}${ext}`;
  const row = db().prepare("SELECT id FROM assets WHERE source = 'derived' AND name = ? AND account_id IS NULL ORDER BY created_at DESC LIMIT 1").get(key) as { id: string } | undefined;
  const known = row && getAsset(row.id);
  if (known && fs.existsSync(absolutePath(known.relPath))) return known.url;
  return saveFile({ data, contentType: contentTypeFor(abs), name: key, source: "derived" }).url;
}

/** A sample's stored copy (/api/files/…), made once and reused, or null when it names no file Fuobe ships (other starters' photos). */
export function adoptSample(src: string): string | null {
  const abs = sampleFile(src);
  return abs ? storedSample(abs) : null;
}

/**
 * The board with its starting files in place: each input node a sample names gets the stored copy and a plain name. A
 * sample whose file isn't there leaves its input empty (the board still opens, and asks for that one file).
 */
export function fillSamples(graph: CanvasGraph, samples: CanvasTemplate["samples"], copy = true): CanvasGraph {
  if (!samples) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const s = samples[n.id];
      if (!s || n.data.url) return n;
      const abs = sampleFile(s.src);
      if (!abs) return n;
      return { ...n, data: { ...n.data, url: copy ? storedSample(abs) : s.src, name: s.name } };
    }),
  };
}

/**
 * Whether a board's file is one of Fuobe's published example files, named by its plain public path: a visitor's board
 * (a guest's draft, an account's own canvas) keeps it as it is, never a copy in anyone's storage.
 */
export const isPublishedSample = (src: string): boolean => sampleFile(src) !== null;
