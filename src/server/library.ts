import "server-only";
import fs from "node:fs";
import { nanoid } from "nanoid";
import { getModel } from "@/lib/catalog";
import type { MediaKind, OutputFile, ReviewStatus } from "@/lib/catalog/types";
import {
  DEFAULT_FOLDER_COLOR,
  downloadName,
  FOLDER_COLORS,
  folderAndDescendants,
  folderMoveError,
  folderPath,
  freeName,
  HELPER_FEATURES,
  HELPER_SUFFIX,
  isReviewStatus,
  MAX_FOLDER_DEPTH,
  TRASH_DAYS,
  zipSegment,
  type AssetUse,
  type Folder,
  type ReviewFilter,
} from "@/lib/library";
import { fileAccount, generationAccount } from "./account-library";
import { db } from "./db";
import { assetUses, cancelGeneration, deleteGeneration, getGeneration, type ListOptions } from "./generations";
import { absolutePath, deleteAsset, getAsset } from "./storage";
import type { ZipEntry } from "./zip";

/**
 * The Assets library on top of generations: the Trash (soft delete, kept 30 days), nested folders,
 * pins, review statuses, bulk actions, zip downloads and deleting uploads nothing uses. Every
 * generation reader leaves trashed rows out (listGenerations / getGeneration join generation_trash).
 */

const DAY = 86_400_000;
const MAX_IDS = 500;

const STATUSES = new Set(["queued", "running", "succeeded", "failed", "canceled"]);
export const KINDS = new Set(["image", "video", "audio", "text", "model3d"]);

/** A library request that can't be done, with the HTTP status the routes answer with. */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** `before=<ts>` or `before=<ts>:<id>` (the last row of the previous page) → the paging cursor. */
export function cursorFrom(v: string | null): Pick<ListOptions, "before" | "beforeId"> {
  const m = /^(\d+)(?::([\w-]{1,40}))?$/.exec(v?.trim() ?? "");
  if (!m || !Number(m[1])) return {};
  return { before: Number(m[1]), ...(m[2] && { beforeId: m[2] }) };
}

/** GET /api/generations query → listGenerations options (unknown values are ignored). */
export function listOptionsFrom(sp: URLSearchParams): ListOptions {
  const list = (k: string) => sp.get(k)?.split(",").map((s) => s.trim()).filter(Boolean);
  const num = (k: string) => {
    const v = Number(sp.get(k));
    return sp.get(k) && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const reviews = list("reviews")?.filter((r): r is ReviewFilter => r === "none" || isReviewStatus(r));
  const pinned = sp.get("pinned");
  return {
    feature: sp.get("feature") ?? undefined,
    features: list("features"),
    kind: sp.get("kind") && KINDS.has(sp.get("kind")!) ? sp.get("kind")! : undefined,
    kinds: list("kinds")?.filter((k) => KINDS.has(k)),
    models: list("models"),
    favorites: sp.get("favorites") === "1",
    status: sp.get("status") ?? undefined,
    statuses: list("statuses")?.filter((s) => STATUSES.has(s)),
    template: sp.get("template")?.slice(0, 80) || undefined,
    folderId: sp.get("folder") ?? undefined,
    folderIds: list("folders")?.filter((id) => id.length <= 40).slice(0, MAX_IDS),
    trashed: sp.get("trash") === "1",
    pinned: pinned === "1" ? true : pinned === "0" ? false : undefined,
    reviews: reviews?.length ? reviews : undefined,
    steps: sp.get("steps") === "1",
    q: sp.get("q") ?? undefined,
    ...cursorFrom(sp.get("before")),
    since: num("since"),
    until: num("until"),
    limit: num("limit"),
    batchId: sp.get("batch") ?? undefined,
  };
}

const ids = (list: string[]) => [...new Set(list)].slice(0, MAX_IDS);
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function existing(list: string[]): string[] {
  if (!list.length) return [];
  return (db().prepare(`SELECT id FROM generations WHERE id IN (${placeholders(list.length)})`).all(...list) as { id: string }[]).map((r) => r.id);
}

/** Touch rows so anything watching updated_at (the live stream) sees the change. */
function touch(list: string[]): void {
  if (list.length) db().prepare(`UPDATE generations SET updated_at = ? WHERE id IN (${placeholders(list.length)})`).run(Date.now(), ...list);
}

// ---------------------------------------------------------------------------
// Trash

/**
 * Move to the Trash. Jobs still queued or rendering are canceled (in the background), so a deleted
 * job doesn't keep running and billing out of sight; Restore brings them back as canceled, with Retry.
 */
export function trashGenerations(list: string[], now = Date.now()): number {
  const found = existing(ids(list));
  const insert = db().prepare("INSERT OR IGNORE INTO generation_trash (generation_id, deleted_at) VALUES (?, ?)");
  let n = 0;
  db().transaction(() => {
    for (const id of found) n += insert.run(id, now).changes;
    touch(found);
  })();
  for (const id of activeIds(found)) void cancelGeneration(id).catch(() => {});
  return n;
}

/** The ones among `list` still queued or rendering. */
function activeIds(list: string[]): string[] {
  if (!list.length) return [];
  return (db().prepare(`SELECT id FROM generations WHERE status IN ('queued', 'running') AND id IN (${placeholders(list.length)})`).all(...list) as { id: string }[]).map((r) => r.id);
}

export function restoreGenerations(list: string[]): number {
  const found = ids(list);
  if (!found.length) return 0;
  let n = 0;
  db().transaction(() => {
    n = db().prepare(`DELETE FROM generation_trash WHERE generation_id IN (${placeholders(found.length)})`).run(...found).changes;
    // A folder deleted meanwhile no longer holds it: it comes back to the library root.
    db().prepare(`DELETE FROM folder_items WHERE generation_id IN (${placeholders(found.length)}) AND folder_id NOT IN (SELECT id FROM folders)`).run(...found);
    touch(found);
  })();
  return n;
}

/** Delete for good; jobs still running are canceled first. */
export async function deleteForever(list: string[]): Promise<number> {
  const found = existing(ids(list));
  const active = new Set(activeIds(found));
  for (const id of found) {
    if (active.has(id)) await cancelGeneration(id).catch(() => {});
    deleteGeneration(id);
  }
  return found.length;
}

export function trashedIds(before?: number): string[] {
  const rows = before
    ? db().prepare("SELECT generation_id FROM generation_trash WHERE deleted_at < ?").all(before)
    : db().prepare("SELECT generation_id FROM generation_trash").all();
  return (rows as { generation_id: string }[]).map((r) => r.generation_id);
}

export async function emptyTrash(): Promise<number> {
  let n = 0;
  for (let batch = trashedIds().slice(0, MAX_IDS); batch.length; batch = trashedIds().slice(0, MAX_IDS)) {
    const done = await deleteForever(batch);
    // Ids whose generation row is already gone: drop the dangling trash entries.
    db().prepare(`DELETE FROM generation_trash WHERE generation_id IN (${placeholders(batch.length)})`).run(...batch);
    n += done;
  }
  return n;
}

/** Delete what has been in the Trash for more than 30 days. */
export async function purgeTrash(now = Date.now()): Promise<number> {
  const old = trashedIds(now - TRASH_DAYS * DAY);
  let n = 0;
  for (let i = 0; i < old.length; i += MAX_IDS) n += await deleteForever(old.slice(i, i + MAX_IDS));
  if (old.length) db().prepare("DELETE FROM generation_trash WHERE deleted_at < ?").run(now - TRASH_DAYS * DAY);
  return n;
}

declare global {
  var __fuobeTrashPurge: { timer: NodeJS.Timeout } | undefined;
}

/** Purge once at startup (the first library read) and then daily. */
export function ensureTrashPurge(): void {
  if (globalThis.__fuobeTrashPurge) return;
  const run = () => void purgeTrash().catch((e) => console.warn(`[fuobe] trash purge failed: ${(e as Error).message}`));
  const timer = setInterval(run, DAY);
  timer.unref?.();
  globalThis.__fuobeTrashPurge = { timer };
  run();
}

export function trashCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM generation_trash t JOIN generations g ON g.id = t.generation_id").get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Favorites, pins, review status

export function setFavorites(list: string[], favorite: boolean): number {
  const found = ids(list);
  if (!found.length) return 0;
  return db().prepare(`UPDATE generations SET favorite = ?, updated_at = ? WHERE id IN (${placeholders(found.length)})`).run(favorite ? 1 : 0, Date.now(), ...found).changes;
}

/** Pin to the top of the Library's views (one already pinned keeps its place), or unpin. */
export function setPinned(list: string[], pinned: boolean, now = Date.now()): number {
  const found = ids(list);
  if (!found.length) return 0;
  const value = pinned ? "COALESCE(pinned_at, ?)" : "?";
  return db().prepare(`UPDATE generations SET pinned_at = ${value}, updated_at = ? WHERE id IN (${placeholders(found.length)})`).run(pinned ? now : null, Date.now(), ...found).changes;
}

/** Set a review status (null clears it). */
export function setReview(list: string[], review: ReviewStatus | null): number {
  if (review !== null && !isReviewStatus(review)) throw new LibraryError("Pick a review status", 400);
  const found = ids(list);
  if (!found.length) return 0;
  return db().prepare(`UPDATE generations SET review = ?, updated_at = ? WHERE id IN (${placeholders(found.length)})`).run(review, Date.now(), ...found).changes;
}

// ---------------------------------------------------------------------------
// Folders (nested: each has a parent, null at the library root; one folder per generation)

/** The SQL test for a helper step of `g` (isHelperFeature); the names are constants, not input. */
export const HELPER_SQL = `(g.feature LIKE '%${HELPER_SUFFIX}' OR g.feature IN (${HELPER_FEATURES.map((f) => `'${f}'`).join(", ")}))`;

interface FolderRow {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  pinned_at: number | null;
  created_at: number;
  updated_at: number;
  count: number;
  folders: number;
  cover_json: string | null;
}

const toFolder = (r: FolderRow): Folder => {
  const outputs = r.cover_json ? (JSON.parse(r.cover_json) as OutputFile[]) : [];
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    count: r.count,
    folders: r.folders,
    cover: outputs[0] ?? null,
    parentId: r.parent_id || null,
    pinnedAt: r.pinned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

/** A folder's count and cover are what its page shows by default: not the Trash, not helper steps (as the lists). */
const FOLDER_SELECT = `SELECT f.*,
  (SELECT COUNT(*) FROM folder_items i JOIN generations g ON g.id = i.generation_id LEFT JOIN generation_trash t ON t.generation_id = g.id
    WHERE i.folder_id = f.id AND t.generation_id IS NULL AND NOT ${HELPER_SQL}) AS count,
  (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS folders,
  (SELECT g.outputs_json FROM folder_items i JOIN generations g ON g.id = i.generation_id LEFT JOIN generation_trash t ON t.generation_id = g.id
    WHERE i.folder_id = f.id AND t.generation_id IS NULL AND NOT ${HELPER_SQL} AND g.status = 'succeeded' AND g.outputs_json != '[]' ORDER BY g.created_at DESC, g.id DESC LIMIT 1) AS cover_json
  FROM folders f`;

/** Every folder, flat (each with its parentId): pinned first in the order they were pinned, then oldest first. */
export function listFolders(): Folder[] {
  return (db().prepare(`${FOLDER_SELECT} ORDER BY f.pinned_at IS NULL, f.pinned_at ASC, f.created_at ASC, f.id ASC`).all() as FolderRow[]).map(toFolder);
}

export function getFolder(id: string): Folder | null {
  const r = db().prepare(`${FOLDER_SELECT} WHERE f.id = ?`).get(id) as FolderRow | undefined;
  return r ? toFolder(r) : null;
}

/** The tree without counts or covers (moves, deletes and zips walk it). */
function folderLinks(): { id: string; name: string; parentId: string | null }[] {
  return (db().prepare("SELECT id, name, parent_id FROM folders").all() as { id: string; name: string; parent_id: string | null }[]).map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id || null }));
}

/** Folder names are unique among siblings (case-insensitive), like files in a folder. */
const nameTaken = (name: string, parentId: string | null, except = "") =>
  !!db().prepare("SELECT 1 FROM folders WHERE lower(name) = lower(?) AND parent_id IS ? AND id != ?").get(name, parentId, except);

const GONE = "That folder doesn't exist anymore";
const colorOf = (c: string | undefined) => (FOLDER_COLORS.some((x) => x.id === c) ? c! : DEFAULT_FOLDER_COLOR);

/** A new folder, at the library root or inside `parentId` ("" counts as the root, like null). */
export function createFolder(input: { name: string; color?: string; parentId?: string | null }): Folder {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new LibraryError("Give the folder a name", 400);
  const parentId = input.parentId || null;
  if (parentId) {
    const links = folderLinks();
    if (!links.some((f) => f.id === parentId)) throw new LibraryError(GONE, 404);
    if (folderPath(links, parentId).length >= MAX_FOLDER_DEPTH) throw new LibraryError(`Folders go ${MAX_FOLDER_DEPTH} levels deep at most`);
  }
  if (nameTaken(name, parentId)) throw new LibraryError(`There's already a folder called “${name}”${parentId ? " here" : ""}`);
  const now = Date.now();
  const id = nanoid(10);
  db().prepare("INSERT INTO folders (id, name, color, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, colorOf(input.color), parentId, now, now);
  return getFolder(id)!;
}

/**
 * Rename, recolour, pin or move a folder. A move (`parentId`, null or "" for the root) is refused into
 * itself or one of its own subfolders, deeper than MAX_FOLDER_DEPTH, or next to a folder of the same name.
 */
export function updateFolder(id: string, patch: { name?: string; color?: string; parentId?: string | null; pinned?: boolean }): Folder | null {
  const f = getFolder(id);
  if (!f) return null;
  const name = patch.name !== undefined ? patch.name.trim().slice(0, 60) : f.name;
  if (!name) throw new LibraryError("Give the folder a name", 400);
  const parentId = patch.parentId !== undefined ? patch.parentId || null : f.parentId;
  if (parentId !== f.parentId) {
    const err = folderMoveError(folderLinks(), id, parentId);
    if (err) throw new LibraryError(err, err === GONE ? 404 : 409);
  }
  if ((name.toLowerCase() !== f.name.toLowerCase() || parentId !== f.parentId) && nameTaken(name, parentId, id)) {
    throw new LibraryError(`There's already a folder called “${name}”${parentId !== f.parentId ? " there" : ""}`);
  }
  const pinnedAt = patch.pinned === undefined ? f.pinnedAt : patch.pinned ? (f.pinnedAt ?? Date.now()) : null;
  const color = patch.color !== undefined ? colorOf(patch.color) : f.color;
  db().prepare("UPDATE folders SET name = ?, color = ?, parent_id = ?, pinned_at = ?, updated_at = ? WHERE id = ?").run(name, color, parentId, pinnedAt, Date.now(), id);
  return getFolder(id);
}

/** Move a folder into another (null: the library root); see updateFolder for what's refused. */
export const moveFolder = (id: string, parentId: string | null) => updateFolder(id, { parentId });

/**
 * Delete a folder; nothing in it is deleted. Its results and its subfolders move up to its parent
 * (the library root for a top-level folder); a subfolder whose name the parent already has becomes "Name 2".
 */
export function deleteFolder(id: string): boolean {
  const f = db().prepare("SELECT parent_id FROM folders WHERE id = ?").get(id) as { parent_id: string | null } | undefined;
  if (!f) return false;
  const parentId = f.parent_id || null;
  const now = Date.now();
  db().transaction(() => {
    const members = (db().prepare("SELECT generation_id FROM folder_items WHERE folder_id = ?").all(id) as { generation_id: string }[]).map((r) => r.generation_id);
    if (parentId) db().prepare("UPDATE folder_items SET folder_id = ?, added_at = ? WHERE folder_id = ?").run(parentId, now, id);
    else db().prepare("DELETE FROM folder_items WHERE folder_id = ?").run(id);
    const taken = (db().prepare("SELECT name FROM folders WHERE parent_id IS ? AND id != ?").all(parentId, id) as { name: string }[]).map((r) => r.name);
    const kids = db().prepare("SELECT id, name FROM folders WHERE parent_id = ? ORDER BY created_at ASC, id ASC").all(id) as { id: string; name: string }[];
    for (const k of kids) {
      const name = freeName(k.name, taken);
      taken.push(name);
      db().prepare("UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?").run(parentId, name, now, k.id);
    }
    db().prepare("DELETE FROM folders WHERE id = ?").run(id);
    if (parentId) db().prepare("UPDATE folders SET updated_at = ? WHERE id = ?").run(now, parentId);
    touch(members);
  })();
  return true;
}

/** Move generations into a folder (each is in at most one), or back to the library root with null. */
export function moveToFolder(list: string[], folderId: string | null): number {
  if (folderId && !db().prepare("SELECT 1 FROM folders WHERE id = ?").get(folderId)) throw new LibraryError(GONE, 404);
  const found = existing(ids(list));
  const now = Date.now();
  db().transaction(() => {
    const del = db().prepare("DELETE FROM folder_items WHERE generation_id = ?");
    const ins = db().prepare("INSERT INTO folder_items (generation_id, folder_id, added_at) VALUES (?, ?, ?)");
    for (const id of found) {
      del.run(id);
      if (folderId) ins.run(id, folderId, now);
    }
    if (folderId) db().prepare("UPDATE folders SET updated_at = ? WHERE id = ?").run(now, folderId);
    touch(found);
  })();
  return found.length;
}

// ---------------------------------------------------------------------------
// Facets for the filter menus

export interface LibraryFacets {
  models: { id: string; name: string; count: number }[];
  kinds: Partial<Record<MediaKind, number>>;
  total: number;
  favorites: number;
  failed: number;
  trash: number;
  pinned: number;
  /** Helper steps (counted whether they're shown or not, for the "Show steps" toggle). */
  steps: number;
  reviews: Partial<Record<ReviewStatus, number>>;
}

/**
 * Counts for the owner's Library tabs and filters; helper steps are left out unless `steps` (as the lists do). Accounts'
 * runs are theirs, never counted here (public sign-up); with `account`, that account's own runs only (it has no Trash).
 */
export function libraryFacets(opts: { steps?: boolean; account?: string } = {}): LibraryFacets {
  const whose = opts.account ? "json_extract(g.request_json, '$.account') = ?" : "json_extract(g.request_json, '$.account') IS NULL";
  const args = opts.account ? [opts.account] : [];
  const all = `FROM generations g LEFT JOIN generation_trash t ON t.generation_id = g.id WHERE t.generation_id IS NULL AND ${whose}`;
  const live = opts.steps ? all : `${all} AND NOT ${HELPER_SQL}`;
  const models = db().prepare(`SELECT g.model_id AS id, COUNT(*) AS n ${live} GROUP BY g.model_id ORDER BY n DESC`).all(...args) as { id: string; n: number }[];
  const kinds = db().prepare(`SELECT g.kind AS kind, COUNT(*) AS n ${live} GROUP BY g.kind`).all(...args) as { kind: MediaKind; n: number }[];
  const reviews = db().prepare(`SELECT g.review AS review, COUNT(*) AS n ${live} AND g.review IS NOT NULL GROUP BY g.review`).all(...args) as { review: string; n: number }[];
  const one = (sql: string) => (db().prepare(sql).get(...args) as { n: number }).n;
  return {
    models: models.map((m) => ({ id: m.id, name: getModel(m.id)?.name ?? m.id, count: m.n })),
    kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    total: one(`SELECT COUNT(*) AS n ${live}`),
    favorites: one(`SELECT COUNT(*) AS n ${live} AND g.favorite = 1`),
    failed: one(`SELECT COUNT(*) AS n ${live} AND g.status IN ('failed','canceled')`),
    trash: opts.account ? 0 : trashCount(),
    pinned: one(`SELECT COUNT(*) AS n ${live} AND g.pinned_at IS NOT NULL`),
    steps: one(`SELECT COUNT(*) AS n ${all} AND ${HELPER_SQL}`),
    reviews: Object.fromEntries(reviews.filter((r) => isReviewStatus(r.review)).map((r) => [r.review, r.n])),
  };
}

// ---------------------------------------------------------------------------
// Zip download

export const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 1;
/** Results a folder zip takes at most, its subfolders' included (the zip format counts entries in 16 bits). */
export const FOLDER_ZIP_MAX = 5000;

/**
 * Add the finished output files of these generations under `prefix`, with readable names unique in the zip. With
 * `account` (a signed-in account's zip): only its own runs, and of their files only those it may open itself
 * (fileAccount: its own, and not held for a check). Anything else is left out, as if it didn't exist.
 */
function addEntries(list: string[], prefix: string, used: Set<string>, out: ZipEntry[], account?: string): void {
  for (const id of list) {
    if (account !== undefined && generationAccount(id) !== account) continue;
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || g.status !== "succeeded") continue;
    g.outputs.forEach((o, i) => {
      if (!o.url.startsWith("/api/files/")) return;
      let file: string;
      try {
        const rel = decodeURIComponent(o.url.slice("/api/files/".length).split("?")[0]);
        if (account !== undefined && fileAccount(rel) !== account) return;
        file = absolutePath(rel);
      } catch {
        return;
      }
      if (!fs.existsSync(file)) return;
      const base = `${prefix}${downloadName(g, o, i)}`;
      let name = base;
      for (let k = 2; used.has(name); k++) name = base.replace(/(\.[^./]+)?$/, (ext) => `-${k}${ext}`);
      used.add(name);
      out.push({ name, path: file, size: fs.statSync(file).size });
    });
  }
}

/** The finished output files of these generations, with readable, unique names (`account`: that account's own only). */
export function zipEntries(list: string[], opts: { account?: string } = {}): ZipEntry[] {
  const out: ZipEntry[] = [];
  addEntries(ids(list), "", new Set(), out, opts.account);
  return out;
}

/**
 * A folder as a zip: its finished outputs at the top and each subfolder's in a folder of its own
 * ("Shots/Close-ups/fox-ab12cd.png"), at any depth. It holds what the folder pages show: results in
 * the Trash are left out, and helper steps too unless `steps` (the Library's Show steps is on).
 */
export function folderZipEntries(id: string, opts: { steps?: boolean } = {}): { name: string; entries: ZipEntry[] } | null {
  const links = folderLinks();
  const root = links.find((f) => f.id === id);
  if (!root) return null;
  const tree = folderAndDescendants(links, id);
  const members = db()
    .prepare(
      `SELECT i.generation_id AS id, i.folder_id AS folder FROM folder_items i JOIN generations g ON g.id = i.generation_id LEFT JOIN generation_trash t ON t.generation_id = g.id
       WHERE t.generation_id IS NULL${opts.steps ? "" : ` AND NOT ${HELPER_SQL}`} AND i.folder_id IN (${placeholders(tree.length)}) ORDER BY g.created_at DESC, g.id DESC`,
    )
    .all(...tree) as { id: string; folder: string }[];
  if (members.length > FOLDER_ZIP_MAX) throw new LibraryError(`“${root.name}” and its subfolders hold over ${FOLDER_ZIP_MAX.toLocaleString("en-US")} results. Download its subfolders one at a time.`, 413);
  const depth = folderPath(links, id).length;
  const out: ZipEntry[] = [];
  const used = new Set<string>();
  for (const fid of tree) {
    const prefix = folderPath(links, fid)
      .slice(depth)
      .map((f) => `${zipSegment(f.name)}/`)
      .join("");
    addEntries(
      members.filter((m) => m.folder === fid).map((m) => m.id),
      prefix,
      used,
      out,
    );
  }
  return { name: root.name, entries: out };
}

// ---------------------------------------------------------------------------
// Uploads

/**
 * Delete a stored file for good (the Uploads tab), its file on disk included, but only when nothing
 * refers to it (assetUses: results' requests and outputs, in the Trash too, elements, chats, every
 * studio). Otherwise nothing changes and `uses` says where it's used. null: no such file.
 */
export function deleteUnusedAsset(id: string): { deleted: boolean; uses: AssetUse[] } | null {
  if (!getAsset(id)) return null;
  const uses = assetUses(id);
  if (uses.length) return { deleted: false, uses };
  deleteAsset(id);
  return { deleted: true, uses: [] };
}
