import "server-only";
import { nanoid } from "nanoid";
import { outline, type CanvasSummary, type Outline } from "@/lib/catalog/canvas";
import { FIRST_PAGE_ID, pageName, readPages, type CanvasPage } from "@/lib/catalog/canvas-board";
import { db } from "./db";

/**
 * An account's own canvases (public sign-up): boards it builds and keeps, in a table of their own, never in the owner's
 * `canvases`. Every read and change names the account, so one account never reaches another's board, and the owner's
 * boards are never in reach. A board here holds only its pages: running a canvas stays the owner's (an account's Run
 * says so), so there are no runs to keep.
 */

export const ACCOUNT_CANVAS_LIMITS = {
  /** Boards an account keeps. */
  boards: 50,
  /** A board's pages as JSON (characters). */
  bytes: 1_000_000,
  /** Saves a minute (the editor's autosave is debounced, so this is far above what editing sends). */
  savesPerMinute: 120,
} as const;

// The table is made in db.ts (ACCOUNT_CANVAS_TABLES).

interface Row {
  id: string;
  account_id: string;
  name: string;
  pages_json: string;
  template_id: string | null;
  created_at: number;
  updated_at: number;
  /** What its list shows (Summary), kept with each save so the list never reads every board's pages. */
  summary_json: string | null;
}

/** A board's line in its list. */
interface Summary {
  nodeCount: number;
  pageCount: number;
  outline: Outline;
}

/** What a save answers: the board's name and when it changed (the editor keeps its pages). */
export interface AccountCanvasSaved {
  id: string;
  name: string;
  updatedAt: number;
}

/** An account's board as the editor opens it. */
export interface AccountCanvas {
  id: string;
  name: string;
  pages: CanvasPage[];
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Why a change was refused, with the status the route answers. */
export class AccountCanvasError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const toCanvas = (r: Row): AccountCanvas => ({
  id: r.id,
  name: r.name,
  pages: readPages(JSON.parse(r.pages_json)),
  templateId: r.template_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const cleanName = (name: string | undefined, fallback: string) => (name?.trim() || fallback).slice(0, 80);

function pagesJson(pages: CanvasPage[]): string {
  const json = JSON.stringify({ pages });
  if (json.length > ACCOUNT_CANVAS_LIMITS.bytes) throw new AccountCanvasError("This board is too big to save. Remove a few nodes or pages, then try again.", 413);
  return json;
}

const summaryJson = (pages: CanvasPage[]): string =>
  JSON.stringify({ nodeCount: pages.reduce((n, p) => n + p.graph.nodes.length, 0), pageCount: pages.length, outline: outline(pages[0].graph) } satisfies Summary);

/** A board's summary; a row saved before summaries were kept gets one now, from its pages (once). */
function summaryOf(accountId: string, r: Pick<Row, "id" | "summary_json">): Summary {
  if (r.summary_json) return JSON.parse(r.summary_json) as Summary;
  const row = db().prepare("SELECT pages_json FROM account_canvases WHERE id = ? AND account_id = ?").get(r.id, accountId) as Pick<Row, "pages_json"> | undefined;
  const json = summaryJson(readPages(JSON.parse(row?.pages_json ?? "{}")));
  db().prepare("UPDATE account_canvases SET summary_json = ? WHERE id = ? AND account_id = ?").run(json, r.id, accountId);
  return JSON.parse(json) as Summary;
}

/** The account's boards, newest first: each one's summary, never its pages. */
export function listAccountCanvases(accountId: string): CanvasSummary[] {
  const rows = db()
    .prepare("SELECT id, name, template_id, created_at, updated_at, summary_json FROM account_canvases WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(accountId, ACCOUNT_CANVAS_LIMITS.boards) as Omit<Row, "account_id" | "pages_json">[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ...summaryOf(accountId, r),
    templateId: r.template_id,
    preview: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editedAt: r.updated_at,
  }));
}

/** One of the account's boards, or null (another account's board, or none, reads the same). */
export function getAccountCanvas(accountId: string, id: string): AccountCanvas | null {
  const r = db().prepare("SELECT * FROM account_canvases WHERE id = ? AND account_id = ?").get(id, accountId) as Row | undefined;
  return r ? toCanvas(r) : null;
}

export function createAccountCanvas(accountId: string, input: { name?: string; pages?: CanvasPage[]; templateId?: string | null }): AccountCanvas {
  const count = (db().prepare("SELECT COUNT(*) AS n FROM account_canvases WHERE account_id = ?").get(accountId) as { n: number }).n;
  if (count >= ACCOUNT_CANVAS_LIMITS.boards) throw new AccountCanvasError(`You can keep up to ${ACCOUNT_CANVAS_LIMITS.boards} canvases. Delete one to save another.`, 409);
  const pages = input.pages?.length ? input.pages : [{ id: FIRST_PAGE_ID, name: pageName(0), graph: { nodes: [], edges: [] } }];
  const now = Date.now();
  const row: Row = {
    id: nanoid(12),
    account_id: accountId,
    name: cleanName(input.name, "Untitled canvas"),
    pages_json: pagesJson(pages),
    template_id: input.templateId?.slice(0, 60) ?? null,
    created_at: now,
    updated_at: now,
    summary_json: summaryJson(pages),
  };
  db()
    .prepare(`INSERT INTO account_canvases (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toCanvas(row);
}

/**
 * A new name and/or pages for one of the account's boards; null when it has no such board. Only what changed is
 * written, and the answer is small (the editor's autosave sends here often).
 */
export function updateAccountCanvas(accountId: string, id: string, patch: { name?: string; pages?: CanvasPage[] }): AccountCanvasSaved | null {
  const name = patch.name?.trim() ? cleanName(patch.name, "") : null;
  const pages = patch.pages?.length ? patch.pages : null;
  const json = pages ? pagesJson(pages) : null;
  const now = Date.now();
  const done = db()
    .prepare(
      "UPDATE account_canvases SET name = COALESCE(?, name), pages_json = COALESCE(?, pages_json), summary_json = COALESCE(?, summary_json), updated_at = ? WHERE id = ? AND account_id = ?",
    )
    .run(name, json, pages && summaryJson(pages), now, id, accountId);
  if (!done.changes) return null;
  const r = db().prepare("SELECT name FROM account_canvases WHERE id = ? AND account_id = ?").get(id, accountId) as Pick<Row, "name">;
  return { id, name: r.name, updatedAt: now };
}

export function deleteAccountCanvas(accountId: string, id: string): boolean {
  return db().prepare("DELETE FROM account_canvases WHERE id = ? AND account_id = ?").run(id, accountId).changes > 0;
}

/** Every board of an account, when the account is deleted. */
export function deleteAccountCanvases(accountId: string): number {
  return db().prepare("DELETE FROM account_canvases WHERE account_id = ?").run(accountId).changes;
}
