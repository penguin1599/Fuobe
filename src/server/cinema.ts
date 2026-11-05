import "server-only";
import { nanoid } from "nanoid";
import { getModel } from "@/lib/catalog";
import type { CinemaFolder, CinemaItem, CinemaProject, CinemaTakeInfo, CinemaTile, DirectorMessage, DirectorSettings } from "@/lib/catalog/cinema";
import { finishIn2k, REGEN_COPY, REGEN_OFFERED } from "@/lib/catalog/regenerate";
import { ownSetupGate } from "./own-setup-run";
import { tenant, tenantAccount } from "./tenant";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { createAccountProject, deleteAccountProject, getAccountProject, listAccountProjects, updateAccountProject, type AccountProject } from "./account-projects";
import { db } from "./db";
import { ConnectComfyError, createGenerations, getGeneration, listGenerations, previewChained, previewGeneration, toGeneration } from "./generations";
import { deleteForever, trashGenerations } from "./library";
import { engineMode } from "./settings";

/**
 * Cinema Studio projects: Director settings, brief and AI Director chat per project, nested folders
 * (scenes) and which generations live where. Generations stay ordinary rows in `generations`; a
 * project only records their ids (cinema_items), written when a take is made from the workspace.
 *
 * Whose projects: the owner's are rows of `cinema_projects`. A signed-in account's (public sign-up) are its own
 * projects in account-projects.ts (kind "cinema"), read and changed only inside its own work (tenant.ts asAccount):
 * every function here reads the projects of whoever the work is for, so an account never reaches the owner's projects
 * or another account's (they read as "not found"), and the owner's lists never hold an account's. A project's folders
 * and takes are rows of `cinema_folders` and `cinema_items` under its id either way, reached only through its project.
 */

export class CinemaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  cost_cap_usd: number | null;
  director_json: string;
  palettes_json: string;
  brief_title: string;
  brief_body: string;
  chat_json: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

interface FolderRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  pinned: number;
  position: number;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  project_id: string;
  generation_id: string;
  folder_id: string | null;
  meta_json: string | null;
  created_at: number;
}

const parse = <T,>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toProject = (r: ProjectRow): CinemaProject => ({
  id: r.id,
  name: r.name,
  description: r.description,
  cover: r.cover_url,
  costCapUsd: r.cost_cap_usd,
  director: parse<DirectorSettings>(r.director_json, {}),
  palettes: parse(r.palettes_json, []),
  brief: { title: r.brief_title, body: r.brief_body },
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toFolder = (r: FolderRow): CinemaFolder => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id,
  name: r.name,
  color: r.color,
  pinned: !!r.pinned,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** What a project keeps per take besides its folder (cinema_items.meta_json). */
interface ItemMeta {
  tiles?: CinemaTile[];
  take?: CinemaTakeInfo;
  /** Estimated cost when the take was made: still counted once the generation is deleted for good. */
  cost?: number;
  /** A chained step's request before its inputs were filled in, so Retry can run it against its dependencies again. */
  req?: GenerationRequest;
  /** Taken out of the project: hidden, but kept so what it cost still counts toward the cap. */
  removed?: boolean;
}

const toItem = (r: ItemRow): CinemaItem => {
  const meta = parse<ItemMeta>(r.meta_json, {});
  return {
    generationId: r.generation_id,
    folderId: r.folder_id,
    createdAt: r.created_at,
    ...(meta.tiles?.length ? { tiles: meta.tiles } : {}),
    ...(meta.take ? { take: meta.take } : {}),
  };
};

/** SQL: a membership row that wasn't taken out of its project. */
const LISTED = "json_extract(i.meta_json, '$.removed') IS NULL";

/** A generation that still exists (soft-deleted rows from the Trash, when there is one, are left out). */
function liveGeneration(id: string): Generation | null {
  const g = getGeneration(id) as (Generation & { deletedAt?: number | null }) | null;
  return g && !g.deletedAt ? g : null;
}

// ---------------------------------------------------------------------------
// Projects

/** An account's project kind in account-projects.ts. */
const ACCOUNT_KIND = "cinema";

/** What an account's project keeps beside its name (account-projects.ts data): the columns of `cinema_projects`. */
interface AccountCinema {
  description: string | null;
  cover: string | null;
  costCapUsd: number | null;
  director: DirectorSettings;
  palettes: CinemaProject["palettes"];
  brief: { title: string; body: string };
  chat: DirectorMessage[];
  pinned: boolean;
}

/** An account's AI Director chat keeps its last messages (a project's data stays well under its size limit). */
const ACCOUNT_CHAT = 50;

const accountRow = (p: AccountProject<AccountCinema>): ProjectRow => ({
  id: p.id,
  name: p.name,
  description: p.data.description ?? null,
  cover_url: p.data.cover ?? null,
  cost_cap_usd: p.data.costCapUsd ?? null,
  director_json: JSON.stringify(p.data.director ?? {}),
  palettes_json: JSON.stringify(p.data.palettes ?? []),
  brief_title: p.data.brief?.title ?? "",
  brief_body: p.data.brief?.body ?? "",
  chat_json: JSON.stringify(p.data.chat ?? []),
  pinned: p.data.pinned ? 1 : 0,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
});

const accountData = (r: ProjectRow): AccountCinema => ({
  description: r.description,
  cover: r.cover_url,
  costCapUsd: r.cost_cap_usd,
  director: parse<DirectorSettings>(r.director_json, {}),
  palettes: parse(r.palettes_json, []),
  brief: { title: r.brief_title, body: r.brief_body },
  chat: parse<DirectorMessage[]>(r.chat_json, []).slice(-ACCOUNT_CHAT),
  pinned: !!r.pinned,
});

/** One project of whoever the work is for: the owner's row, or the account's own project (another's reads as none). */
function projectRow(id: string): ProjectRow | undefined {
  const account = tenantAccount();
  if (account) {
    const p = getAccountProject<AccountCinema>(account, ACCOUNT_KIND, id);
    return p ? accountRow(p) : undefined;
  }
  return db().prepare("SELECT * FROM cinema_projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

/** Write an account's project back (its name and data): the account's own only. */
function saveAccountRow(account: string, r: ProjectRow): void {
  if (!updateAccountProject(account, ACCOUNT_KIND, r.id, { name: r.name, data: accountData(r) })) throw new CinemaError("Project not found", 404);
}

export function getProject(id: string): CinemaProject | null {
  const r = projectRow(id);
  return r ? toProject(r) : null;
}

function requireProject(id: string): CinemaProject {
  const p = getProject(id);
  if (!p) throw new CinemaError("Project not found", 404);
  return p;
}

/**
 * What the project's takes cost, summed in SQL: a generation's recorded cost unless it failed, and for
 * one deleted for good (emptied from the Trash) the cost recorded when the take was made. Deleting
 * or taking out takes never lowers it: that money is spent.
 */
const SPENT = `COALESCE(SUM(CASE
    WHEN g.id IS NULL OR json_extract(i.meta_json, '$.costLocked') THEN COALESCE(json_extract(i.meta_json, '$.cost'), 0)
    WHEN g.status IN ('failed', 'canceled') THEN 0
    ELSE COALESCE(g.cost_usd, 0) END), 0)`;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Estimated spend so far: the cost of every take made in the project that didn't fail. */
export function spentUsd(projectId: string): number {
  const r = db().prepare(`SELECT ${SPENT} AS s FROM cinema_items i LEFT JOIN generations g ON g.id = i.generation_id WHERE i.project_id = ?`).get(projectId) as { s: number };
  return round3(r.s);
}

/**
 * Newest finished image (or video) of a project: the card cover when none was picked. One query. A 3D scene's
 * depth map is an image output too, but not a picture of the project: it is skipped.
 */
function autoCover(projectId: string): string | null {
  const rows = db()
    .prepare(
      `SELECT g.outputs_json FROM cinema_items i JOIN generations g ON g.id = i.generation_id LEFT JOIN generation_trash t ON t.generation_id = g.id
       WHERE i.project_id = ? AND g.status = 'succeeded' AND t.deleted_at IS NULL AND ${LISTED} ORDER BY i.created_at DESC LIMIT 40`,
    )
    .all(projectId) as { outputs_json: string }[];
  let video: string | null = null;
  for (const r of rows) {
    const outs = parse<{ url: string; kind: string; meta?: { role?: unknown } }[]>(r.outputs_json, []);
    const img = outs.find((o) => o.kind === "image" && o.meta?.role !== "depth");
    if (img) return img.url;
    video ??= outs.find((o) => o.kind === "video")?.url ?? null;
  }
  return video;
}

/** The projects of whoever the work is for: the owner's rows, or an account's own projects (pinned first, then newest). */
function projectRows(): ProjectRow[] {
  const account = tenantAccount();
  if (!account) return db().prepare("SELECT * FROM cinema_projects ORDER BY pinned DESC, updated_at DESC").all() as ProjectRow[];
  const rows = listAccountProjects(account, ACCOUNT_KIND).flatMap((x) => {
    const p = getAccountProject<AccountCinema>(account, ACCOUNT_KIND, x.id);
    return p ? [accountRow(p)] : [];
  });
  return rows.sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at);
}

export function listProjects(): CinemaProject[] {
  const rows = projectRows();
  if (!rows.length) return [];
  // Counts and spend for these projects in two grouped queries (not one per project).
  const ids = rows.map((r) => r.id);
  const counts = new Map(
    (
      db()
        .prepare(
          `SELECT i.project_id AS p, COUNT(*) AS n FROM cinema_items i JOIN generations g ON g.id = i.generation_id
           LEFT JOIN generation_trash t ON t.generation_id = g.id WHERE i.project_id IN (${marks(ids.length)}) AND t.deleted_at IS NULL AND ${LISTED} GROUP BY i.project_id`,
        )
        .all(...ids) as { p: string; n: number }[]
    ).map((r) => [r.p, r.n]),
  );
  const spent = new Map(
    (
      db()
        .prepare(`SELECT i.project_id AS p, ${SPENT} AS s FROM cinema_items i LEFT JOIN generations g ON g.id = i.generation_id WHERE i.project_id IN (${marks(ids.length)}) GROUP BY i.project_id`)
        .all(...ids) as { p: string; s: number }[]
    ).map((r) => [r.p, round3(r.s)]),
  );
  return rows.map((r) => ({ ...toProject(r), stats: { items: counts.get(r.id) ?? 0, spentUsd: spent.get(r.id) ?? 0, cover: r.cover_url ?? autoCover(r.id) } }));
}

export function createProject(input: { name: string; description?: string | null; cover?: string | null; costCapUsd?: number | null }): CinemaProject {
  const account = tenantAccount();
  if (account) {
    // An account's own project (account-projects.ts keeps its limit): never a row of the owner's table.
    const data: AccountCinema = {
      description: input.description?.trim().slice(0, 140) || null,
      cover: input.cover ?? null,
      costCapUsd: input.costCapUsd ?? null,
      director: {},
      palettes: [],
      brief: { title: "", body: "" },
      chat: [],
      pinned: false,
    };
    return toProject(accountRow(createAccountProject(account, ACCOUNT_KIND, { name: input.name.trim().slice(0, 80) || "Untitled project", data })));
  }
  const now = Date.now();
  const row: ProjectRow = {
    id: nanoid(10),
    name: input.name.trim().slice(0, 80) || "Untitled project",
    description: input.description?.trim().slice(0, 140) || null,
    cover_url: input.cover ?? null,
    cost_cap_usd: input.costCapUsd ?? null,
    director_json: "{}",
    palettes_json: "[]",
    brief_title: "",
    brief_body: "",
    chat_json: "[]",
    pinned: 0,
    created_at: now,
    updated_at: now,
  };
  db()
    .prepare(`INSERT INTO cinema_projects (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toProject(row);
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
  cover?: string | null;
  costCapUsd?: number | null;
  director?: DirectorSettings;
  palettes?: CinemaProject["palettes"];
  brief?: { title?: string; body?: string };
  pinned?: boolean;
}

export function updateProject(id: string, patch: ProjectPatch): CinemaProject {
  const cur = requireProject(id);
  const next = {
    id,
    name: patch.name?.trim().slice(0, 80) || cur.name,
    description: patch.description === undefined ? cur.description : patch.description?.trim().slice(0, 140) || null,
    cover_url: patch.cover === undefined ? cur.cover : patch.cover,
    cost_cap_usd: patch.costCapUsd === undefined ? cur.costCapUsd : patch.costCapUsd,
    director_json: JSON.stringify(patch.director ?? cur.director),
    palettes_json: JSON.stringify((patch.palettes ?? cur.palettes).slice(0, 60)),
    brief_title: patch.brief?.title === undefined ? cur.brief.title : patch.brief.title.slice(0, 120),
    brief_body: patch.brief?.body === undefined ? cur.brief.body : patch.brief.body.slice(0, 20_000),
    pinned: patch.pinned === undefined ? Number(cur.pinned) : Number(patch.pinned),
    updated_at: Date.now(),
  };
  const account = tenantAccount();
  if (account) {
    saveAccountRow(account, { ...projectRow(id)!, ...next });
    return getProject(id)!;
  }
  db()
    .prepare(
      `UPDATE cinema_projects SET name = @name, description = @description, cover_url = @cover_url, cost_cap_usd = @cost_cap_usd,
       director_json = @director_json, palettes_json = @palettes_json, brief_title = @brief_title, brief_body = @brief_body,
       pinned = @pinned, updated_at = @updated_at WHERE id = @id`,
    )
    .run(next);
  return getProject(id)!;
}

/** Deletes the project and its folders; its generations stay in the library. */
export function deleteProject(id: string): void {
  const account = tenantAccount();
  if (account) {
    // Only the account's own project, then its folders and memberships (its runs stay its own).
    if (!deleteAccountProject(account, ACCOUNT_KIND, id)) return;
    db().transaction(() => {
      db().prepare("DELETE FROM cinema_items WHERE project_id = ?").run(id);
      db().prepare("DELETE FROM cinema_folders WHERE project_id = ?").run(id);
    })();
    return;
  }
  db().transaction(() => {
    db().prepare("DELETE FROM cinema_items WHERE project_id = ?").run(id);
    db().prepare("DELETE FROM cinema_folders WHERE project_id = ?").run(id);
    db().prepare("DELETE FROM cinema_projects WHERE id = ?").run(id);
  })();
}

function touch(projectId: string): void {
  const account = tenantAccount();
  if (account) updateAccountProject(account, ACCOUNT_KIND, projectId, {});
  else db().prepare("UPDATE cinema_projects SET updated_at = ? WHERE id = ?").run(Date.now(), projectId);
}

/**
 * When an account is deleted (account-sweep.ts purgeAccount, before its projects go): the folders and memberships of
 * its Cinema projects. Its runs are deleted with the account.
 */
export function deleteAccountCinema(accountId: string): void {
  const ids = listAccountProjects(accountId, ACCOUNT_KIND).map((p) => p.id);
  if (!ids.length) return;
  db().transaction(() => {
    db().prepare(`DELETE FROM cinema_items WHERE project_id IN (${marks(ids.length)})`).run(...ids);
    db().prepare(`DELETE FROM cinema_folders WHERE project_id IN (${marks(ids.length)})`).run(...ids);
  })();
}

// ---------------------------------------------------------------------------
// AI Director chat (kept on the project: one production, one conversation)

export function getChat(projectId: string): DirectorMessage[] {
  const r = projectRow(projectId);
  if (!r) throw new CinemaError("Project not found", 404);
  return parse<DirectorMessage[]>(r.chat_json, []);
}

export function appendChat(projectId: string, ...messages: DirectorMessage[]): DirectorMessage[] {
  const account = tenantAccount();
  const next = [...getChat(projectId), ...messages].slice(account ? -ACCOUNT_CHAT : -100);
  if (account) saveAccountRow(account, { ...projectRow(projectId)!, chat_json: JSON.stringify(next) });
  else db().prepare("UPDATE cinema_projects SET chat_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), Date.now(), projectId);
  return next;
}

export function clearChat(projectId: string): void {
  const account = tenantAccount();
  if (account) {
    const r = projectRow(projectId);
    if (!r) throw new CinemaError("Project not found", 404);
    saveAccountRow(account, { ...r, chat_json: "[]" });
  } else db().prepare("UPDATE cinema_projects SET chat_json = '[]' WHERE id = ?").run(projectId);
}

// ---------------------------------------------------------------------------
// Folders (scenes)

export function listFolders(projectId: string): CinemaFolder[] {
  // Inside an account's work, only its own project's folders.
  if (tenantAccount() && !projectRow(projectId)) return [];
  return (db().prepare("SELECT * FROM cinema_folders WHERE project_id = ? ORDER BY pinned DESC, position ASC, created_at ASC").all(projectId) as FolderRow[]).map(toFolder);
}

function folderRow(id: string): FolderRow | undefined {
  return db().prepare("SELECT * FROM cinema_folders WHERE id = ?").get(id) as FolderRow | undefined;
}

/** A folder and everything nested in it. */
export function descendants(projectId: string, folderId: string): Set<string> {
  const folders = listFolders(projectId);
  const out = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Whether a folder (scene) of this project still exists: one deleted in another tab or the sidebar doesn't. */
export function folderExists(projectId: string, folderId: string): boolean {
  return folderRow(folderId)?.project_id === projectId;
}

function checkParent(projectId: string, parentId: string | null | undefined, self?: string): void {
  if (!parentId) return;
  const p = folderRow(parentId);
  if (!p || p.project_id !== projectId) throw new CinemaError("That folder doesn't exist", 404);
  if (self && descendants(projectId, self).has(parentId)) throw new CinemaError("Cannot move into a subfolder");
}

export function createFolder(projectId: string, input: { name: string; parentId?: string | null; color?: string | null }): CinemaFolder {
  requireProject(projectId);
  checkParent(projectId, input.parentId);
  const now = Date.now();
  const position = (db().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cinema_folders WHERE project_id = ?").get(projectId) as { p: number }).p;
  const row: FolderRow = {
    id: nanoid(10),
    project_id: projectId,
    parent_id: input.parentId ?? null,
    name: input.name.trim().slice(0, 60) || "New scene",
    color: input.color ?? null,
    pinned: 0,
    position,
    created_at: now,
    updated_at: now,
  };
  db()
    .prepare(`INSERT INTO cinema_folders (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  touch(projectId);
  return toFolder(row);
}

export function updateFolder(projectId: string, id: string, patch: { name?: string; color?: string | null; pinned?: boolean; parentId?: string | null; position?: number }): CinemaFolder {
  requireProject(projectId);
  const cur = folderRow(id);
  if (!cur || cur.project_id !== projectId) throw new CinemaError("Folder not found", 404);
  if (patch.parentId !== undefined) checkParent(projectId, patch.parentId, id);
  db()
    .prepare("UPDATE cinema_folders SET name = ?, color = ?, pinned = ?, parent_id = ?, position = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.name?.trim().slice(0, 60) || cur.name,
      patch.color === undefined ? cur.color : patch.color,
      patch.pinned === undefined ? cur.pinned : Number(patch.pinned),
      patch.parentId === undefined ? cur.parent_id : patch.parentId,
      patch.position ?? cur.position,
      Date.now(),
      id,
    );
  touch(projectId);
  return toFolder(folderRow(id)!);
}

/** Deleting a folder moves its takes and subfolders up to its parent (as Higgsfield does). */
export function deleteFolder(projectId: string, id: string): void {
  requireProject(projectId);
  const cur = folderRow(id);
  if (!cur || cur.project_id !== projectId) throw new CinemaError("Folder not found", 404);
  db().transaction(() => {
    db().prepare("UPDATE cinema_items SET folder_id = ? WHERE project_id = ? AND folder_id = ?").run(cur.parent_id, projectId, id);
    db().prepare("UPDATE cinema_folders SET parent_id = ? WHERE project_id = ? AND parent_id = ?").run(cur.parent_id, projectId, id);
    db().prepare("DELETE FROM cinema_folders WHERE id = ?").run(id);
  })();
  touch(projectId);
}

// ---------------------------------------------------------------------------
// Items: the project's generations

export type CinemaGeneration = Generation & {
  folderId: string | null;
  tiles?: CinemaTile[];
  take?: CinemaTakeInfo;
  /** The project the take belongs to ("My Generations" lists every project's). */
  projectId?: string | null;
};

export interface ItemQuery {
  /** A folder id; null = the project root only; undefined = everything in the project. */
  folderId?: string | null;
  /** With a folder: also the takes in its subfolders. */
  nested?: boolean;
  favorites?: boolean;
}

/** Library columns plus the membership row, as one JOIN (no query per take). */
const ITEMS_FROM = `SELECT g.*, t.deleted_at AS deleted_at, fi.folder_id AS folder_id, i.project_id AS c_project, i.folder_id AS c_folder, i.meta_json AS c_meta
  FROM cinema_items i JOIN generations g ON g.id = i.generation_id
  LEFT JOIN generation_trash t ON t.generation_id = g.id LEFT JOIN folder_items fi ON fi.generation_id = g.id
  WHERE t.deleted_at IS NULL AND ${LISTED}`;

type JoinedRow = Parameters<typeof toGeneration>[0] & { c_project: string; c_folder: string | null; c_meta: string | null };

function toCinemaGeneration(r: JoinedRow): CinemaGeneration {
  const meta = parse<ItemMeta>(r.c_meta, {});
  return {
    ...toGeneration(r),
    folderId: r.c_folder,
    projectId: r.c_project,
    ...(meta.tiles?.length ? { tiles: meta.tiles } : {}),
    ...(meta.take ? { take: meta.take } : {}),
  };
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export function listItems(projectId: string, q: ItemQuery = {}): CinemaGeneration[] {
  requireProject(projectId);
  const where = ["i.project_id = ?"];
  const args: unknown[] = [projectId];
  if (q.folderId === null) where.push("i.folder_id IS NULL");
  else if (q.folderId) {
    const set = [...(q.nested ? descendants(projectId, q.folderId) : new Set([q.folderId]))];
    where.push(`i.folder_id IN (${marks(set.length)})`);
    args.push(...set);
  }
  if (q.favorites) where.push("g.favorite = 1");
  const rows = db()
    .prepare(`${ITEMS_FROM} AND ${where.join(" AND ")} ORDER BY g.created_at DESC, g.id DESC`)
    .all(...args) as JoinedRow[];
  return rows.map(toCinemaGeneration);
}

/** Every Cinema Studio generation, whichever project it's in ("My Generations"), with its project. */
export function listStudioGenerations(): CinemaGeneration[] {
  // An account's own runs only (the owner's list never holds an account's).
  const account = tenantAccount();
  const list = listGenerations({ features: ["cinema*"], limit: 200, ...(account && { account }) }).filter((g) => !(g as Generation & { deletedAt?: number | null }).deletedAt);
  if (!list.length) return [];
  const rows = db()
    .prepare(`SELECT i.generation_id, i.project_id, i.folder_id, i.meta_json FROM cinema_items i WHERE i.generation_id IN (${marks(list.length)}) AND ${LISTED}`)
    .all(...list.map((g) => g.id)) as { generation_id: string; project_id: string; folder_id: string | null; meta_json: string | null }[];
  const by = new Map(rows.map((r) => [r.generation_id, r]));
  return list.map((g) => {
    const r = by.get(g.id);
    const meta = parse<ItemMeta>(r?.meta_json, {});
    return { ...g, folderId: r?.folder_id ?? null, projectId: r?.project_id ?? null, ...(meta.tiles?.length ? { tiles: meta.tiles } : {}), ...(meta.take ? { take: meta.take } : {}) };
  });
}

/**
 * Write membership rows. Re-adding a take that was taken out brings it back; a take already listed
 * in the project is left as it is.
 */
function insertItems(projectId: string, entries: { id: string; meta: ItemMeta }[], folderId: string | null): void {
  const now = Date.now();
  const ins = db().prepare(
    `INSERT INTO cinema_items (project_id, generation_id, folder_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, generation_id) DO UPDATE SET folder_id = excluded.folder_id, meta_json = excluded.meta_json, created_at = excluded.created_at
     WHERE json_extract(cinema_items.meta_json, '$.removed') IS NOT NULL`,
  );
  db().transaction(() => entries.forEach((e, i) => ins.run(projectId, e.id, folderId, Object.keys(e.meta).length ? JSON.stringify(e.meta) : null, now + i)))();
  touch(projectId);
}

const dependsOf = (v: string | null | undefined): string[] => (!v ? [] : v.startsWith("[") ? (JSON.parse(v) as string[]) : [v]);

/** What each generation waits for (generations.depends_on). */
function dependencies(ids: string[]): Map<string, string[]> {
  if (!ids.length) return new Map();
  const rows = db().prepare(`SELECT id, depends_on FROM generations WHERE id IN (${marks(ids.length)})`).all(...ids) as { id: string; depends_on: string | null }[];
  return new Map(rows.map((r) => [r.id, dependsOf(r.depends_on)]));
}

/** The meta a new take starts with: its estimated cost and, for a chained step, its request before the inputs were filled in. */
function metaFor(g: Pick<Generation, "costUsd" | "request">, deps: string[] | undefined, take?: CinemaTakeInfo): ItemMeta {
  return { ...(take ? { take } : {}), cost: g.costUsd ?? 0, ...(deps?.length ? { req: g.request } : {}) };
}

export function addItems(projectId: string, generationIds: string[], folderId: string | null = null, take?: CinemaTakeInfo): void {
  requireProject(projectId);
  if (folderId) checkParent(projectId, folderId);
  const deps = dependencies(generationIds);
  const entries = generationIds.map((id) => {
    const g = getGeneration(id, { includeDeleted: true });
    return { id, meta: g ? metaFor(g, deps.get(id), take) : take ? { take } : {} };
  });
  insertItems(projectId, entries, folderId);
}

/** Record generations just made from the workspace (their requests are still the unfilled originals). */
export function recordTakes(projectId: string, made: Generation[], folderId: string | null, take?: CinemaTakeInfo): void {
  if (!made.length) return;
  const deps = dependencies(made.map((g) => g.id));
  insertItems(
    projectId,
    made.map((g) => ({ id: g.id, meta: metaFor(g, deps.get(g.id), take) })),
    folderId,
  );
}

/** The ids among `ids` that are listed in the project. */
function memberIds(projectId: string, ids: string[]): string[] {
  const list = [...new Set(ids)];
  if (!list.length) return [];
  return (
    db()
      .prepare(`SELECT generation_id FROM cinema_items i WHERE i.project_id = ? AND i.generation_id IN (${marks(list.length)}) AND ${LISTED}`)
      .all(projectId, ...list) as { generation_id: string }[]
  ).map((r) => r.generation_id);
}

export function moveItems(projectId: string, generationIds: string[], folderId: string | null): number {
  requireProject(projectId);
  if (folderId) checkParent(projectId, folderId);
  const up = db().prepare("UPDATE cinema_items SET folder_id = ? WHERE project_id = ? AND generation_id = ?");
  const ids = memberIds(projectId, generationIds);
  db().transaction(() => ids.forEach((id) => up.run(folderId, projectId, id)))();
  touch(projectId);
  return ids.length;
}

/**
 * Take takes out of the project. With `deleteGenerations` (the workspace's Delete) they move to the
 * library's Trash and stay filed here, so Restore brings them back where they were; otherwise they're
 * only taken out. The rows are kept either way (hidden), so what the takes cost still counts toward
 * the cap. Only this project's takes are touched.
 */
export function removeItems(projectId: string, generationIds: string[], opts: { deleteGenerations?: boolean } = {}): number {
  const ids = takeOut(projectId, generationIds, !!opts.deleteGenerations);
  if (ids.length && opts.deleteGenerations) trashGenerations(ids);
  return ids.length;
}

/**
 * Snapshot what each take cost (nothing if it failed) before it goes: taking it out hides it, and
 * the Trash cancels a running take, which would otherwise read as free. Answers the project's takes among `generationIds`.
 */
function takeOut(projectId: string, generationIds: string[], deleting: boolean): string[] {
  requireProject(projectId);
  const ids = memberIds(projectId, generationIds);
  if (!ids.length) return [];
  const cost = `COALESCE((SELECT CASE WHEN g.status IN ('failed', 'canceled') THEN 0 ELSE COALESCE(g.cost_usd, 0) END FROM generations g WHERE g.id = cinema_items.generation_id), json_extract(meta_json, '$.cost'), 0)`;
  const snapshot = db().prepare(
    deleting
      ? `UPDATE cinema_items SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.costLocked', json('true'), '$.cost', ${cost}) WHERE project_id = ? AND generation_id = ?`
      : `UPDATE cinema_items SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.removed', json('true'), '$.cost', ${cost}) WHERE project_id = ? AND generation_id = ?`,
  );
  db().transaction(() => ids.forEach((id) => snapshot.run(projectId, id)))();
  touch(projectId);
  return ids;
}

/**
 * An account's Delete (it has no Trash): the project's takes among `generationIds` are deleted for good, their files
 * with them, so its space comes back at once. What they cost still counts toward the project's limit.
 */
export async function deleteTakes(projectId: string, generationIds: string[]): Promise<number> {
  const ids = takeOut(projectId, generationIds, true);
  if (ids.length) await deleteForever(ids);
  return ids.length;
}

export function setFavorites(projectId: string, generationIds: string[], favorite: boolean): number {
  requireProject(projectId);
  const ids = memberIds(projectId, generationIds);
  const up = db().prepare("UPDATE generations SET favorite = ?, updated_at = ? WHERE id = ?");
  db().transaction(() => ids.forEach((id) => up.run(favorite ? 1 : 0, Date.now(), id)))();
  return ids.length;
}

// ---------------------------------------------------------------------------
// Retry

const BROKEN = new Set<Generation["status"]>(["failed", "canceled"]);

function itemRow(projectId: string, generationId: string): ItemRow | undefined {
  const r = db().prepare("SELECT * FROM cinema_items WHERE project_id = ? AND generation_id = ?").get(projectId, generationId) as ItemRow | undefined;
  return r && !parse<ItemMeta>(r.meta_json, {}).removed ? r : undefined;
}

/** Generations that wait for `id`. */
function dependentsOf(id: string): string[] {
  return (
    db()
      .prepare("SELECT id FROM generations WHERE depends_on = ? OR (substr(depends_on, 1, 1) = '[' AND instr(depends_on, ?) > 0) ORDER BY created_at")
      .all(id, `"${id}"`) as { id: string }[]
  ).map((r) => r.id);
}

/** Queued behind a dependency that will never finish (the runner fails it on its next pass). */
const waiting = (g: Generation, deps: string[]) => g.status === "queued" && deps.length > 0;

interface RedoStep {
  g: Generation;
  deps: string[];
  row: ItemRow;
}

/**
 * The request a step runs again with, and what it waits for. A root step makes one job (one take of
 * a batch of 4 is one take: the other three are still there).
 */
function redoRequest(s: RedoStep, launched: boolean): { req: GenerationRequest; deps: string[] } {
  const meta = parse<ItemMeta>(s.row.meta_json, {});
  if (s.deps.length && meta.req) return { req: structuredClone(meta.req), deps: s.deps };
  const req = structuredClone(s.g.request);
  if (s.deps.length && !launched) return { req, deps: s.deps };
  // A root step, or (takes recorded before the unfilled request was kept) a step whose inputs were already filled in.
  delete req.chain;
  delete req.chainFrom;
  const requested = req.params?.numOutputs ?? 1;
  if (requested > 1) req.params = { ...req.params, numOutputs: Math.max(1, Math.min(requested, getModel(req.modelId)?.options.maxOutputs ?? 1)) };
  return { req, deps: [] };
}

/**
 * Run a failed or canceled take again, in the same folder. Chained takes retry as a unit: the failed
 * steps it waits for and the steps that failed because of it are made again too, wired to the new
 * ids, while steps that finished are reused rather than re-run. Every step is checked before any
 * starts; the replaced failures move to the Trash so the new run takes their place in the feed.
 */
export function retryItem(projectId: string, generationId: string): Generation[] {
  return startRetry(planRetry(projectId, generationId));
}

/** A retry, checked: the steps to make again (dependencies first), each with its request and what it waits for. */
export interface RetryPlan {
  projectId: string;
  order: RedoStep[];
  plans: { s: RedoStep; req: GenerationRequest; deps: string[] }[];
}

/** A retry's steps as an account's run checks them (account-tool-run.ts): each request and how many steps it waits for. */
export const retrySteps = (plan: RetryPlan): { request: GenerationRequest; deps: number }[] => plan.plans.map((p) => ({ request: p.req, deps: p.deps.length }));

/** Plan a retry (see retryItem) and check every step; nothing is made yet. */
export function planRetry(projectId: string, generationId: string): RetryPlan {
  requireProject(projectId);
  const start = itemRow(projectId, generationId);
  const first = start ? liveGeneration(generationId) : null;
  if (!start || !first) throw new CinemaError("That take isn't in this project", 404);
  if (first.status === "queued" || first.status === "running") throw new CinemaError("That take is still rendering", 422);

  const redo = new Map<string, RedoStep>([[generationId, { g: first, deps: dependencies([generationId]).get(generationId) ?? [], row: start }]]);
  const consider = (id: string, upstream: boolean): boolean => {
    if (redo.has(id)) return false;
    const g = getGeneration(id, { includeDeleted: true });
    if (!g) {
      if (upstream) throw new CinemaError("An earlier step of this take was deleted — make the take again", 422);
      return false;
    }
    const deps = dependencies([id]).get(id) ?? [];
    // Upstream, a finished or still-running step is waited on as it is; downstream, only steps that failed (or will) are redone.
    if (!BROKEN.has(g.status) && !(!upstream && waiting(g, deps))) return false;
    const row = itemRow(projectId, id);
    if (!row) {
      if (upstream) throw new CinemaError("An earlier step of this take isn't in this project any more — make the take again", 422);
      return false;
    }
    redo.set(id, { g, deps, row });
    return true;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of [...redo.values()]) {
      for (const d of s.deps) grew = consider(d, true) || grew;
      for (const c of dependentsOf(s.g.id)) grew = consider(c, false) || grew;
    }
  }

  // Dependencies first.
  const order: RedoStep[] = [];
  const placed = new Set<string>();
  while (order.length < redo.size) {
    const next = [...redo.values()].filter((s) => !placed.has(s.g.id) && s.deps.every((d) => !redo.has(d) || placed.has(d)));
    if (!next.length) throw new CinemaError("This take's steps wait for each other in a loop", 422);
    for (const s of next.sort((a, b) => a.g.createdAt - b.g.createdAt)) {
      order.push(s);
      placed.add(s.g.id);
    }
  }
  const launched = new Set(
    (
      db()
        .prepare(`SELECT id FROM generations WHERE id IN (${marks(order.length)}) AND (external_id IS NOT NULL OR provider_input_json IS NOT NULL)`)
        .all(...order.map((s) => s.g.id)) as { id: string }[]
    ).map((r) => r.id),
  );
  const plans = order.map((s) => ({ s, ...redoRequest(s, launched.has(s.g.id)) }));
  // Check every step before starting any: a refusal must not leave half a chain running.
  for (const p of plans) {
    try {
      if (p.deps.length) previewChained(p.req, p.deps.length);
      else previewGeneration(p.req);
    } catch (e) {
      if (e instanceof ConnectComfyError) throw e;
      throw new CinemaError((e as Error).message, 422);
    }
  }
  return { projectId, order, plans };
}

/** Make a planned retry: the steps in order, wired to the new ids, then the replaced failures go to the Trash. */
export function startRetry({ projectId, order, plans }: RetryPlan): Generation[] {
  const fresh = new Map<string, string>();
  const created: Generation[] = [];
  try {
    for (const p of plans) {
      const deps = p.deps.map((d) => fresh.get(d) ?? d);
      const opts = p.s.g.batchId ? { batchId: p.s.g.batchId } : {};
      const made = deps.length ? createGenerations(p.req, { ...opts, dependsOn: deps.length === 1 ? deps[0] : deps }) : createGenerations(p.req, opts);
      // A joined film comes first: dependents wait for it.
      fresh.set(p.s.g.id, made[0].id);
      created.push(...made);
      recordTakes(projectId, made, p.s.row.folder_id, parse<ItemMeta>(p.s.row.meta_json, {}).take);
    }
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new CinemaError((e as Error).message, 422);
  }
  const replaced = order.filter((s) => BROKEN.has(s.g.status) || waiting(s.g, s.deps)).map((s) => s.g.id);
  if (replaced.length) {
    trashGenerations(replaced);
    // They cost nothing (they failed), even after the Trash is emptied.
    const zero = db().prepare("UPDATE cinema_items SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.cost', 0) WHERE project_id = ? AND generation_id = ?");
    db().transaction(() => replaced.forEach((id) => zero.run(projectId, id)))();
  }
  return created;
}

/**
 * "Finish in 2K" on a MiniMax H3 take, in the same folder: a fal take renders again at 2K on the same hosted model (priced
 * per second, within the project's limit); a take from your GPU is redrawn at 2K by Open-H3 Regenerate, from its saved
 * 768p latent when its draft kept one (finishIn2k). The 2K take lands beside the first one.
 */
export function finishTake(projectId: string, generationId: string): Generation[] {
  return startFinish(planFinish(projectId, generationId));
}

/** A 2K finish, checked: the take, its membership row and the request that finishes it. */
export interface FinishPlan {
  projectId: string;
  row: ItemRow;
  g: Generation;
  request: GenerationRequest;
}

/** Plan a 2K finish (see finishTake) and check it, the project's limit included; nothing is made yet. */
export function planFinish(projectId: string, generationId: string): FinishPlan {
  requireProject(projectId);
  const row = itemRow(projectId, generationId);
  const g = row ? liveGeneration(generationId) : null;
  if (!row || !g) throw new CinemaError("That take isn't in this project", 404);
  // A take from your GPU is finished by Open-H3 Regenerate (perSecond null): a 48 GB card. An account runs it on its own
  // GPU when that GPU fits it (own-setup-run.ts), never on this studio's; the owner's only while it is offered (REGEN_OFFERED).
  const finish = finishIn2k(g, engineMode());
  if (!finish) throw new CinemaError("Finish in 2K is for finished MiniMax H3 takes made below 2K", 422);
  if (finish.perSecond === null) {
    if (tenant()) ownSetupGate("regenerate:cinema-finish");
    else if (!REGEN_OFFERED) throw new CinemaError(REGEN_COPY.heldFinish, 422);
  }
  // Once per take: a 2K finish under way or made (this action's, or the 2K run's own finish of its draft) isn't repeated.
  if (finishedIn2k(generationId)) throw new CinemaError("This take already has a 2K finish", 409);
  const project = getProject(projectId);
  let cost = 0;
  try {
    cost = previewGeneration(finish.request).costUsd ?? 0;
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new CinemaError((e as Error).message, 422);
  }
  if (project?.costCapUsd != null && cost > 0) {
    const spent = spentUsd(projectId);
    if (spent + cost > project.costCapUsd + 1e-9) {
      throw new CinemaError(`Finishing in 2K (≈ $${cost.toFixed(2)}) would take the project past its $${project.costCapUsd.toFixed(2)} limit — $${spent.toFixed(2)} is already spent. Raise the limit in project settings.`, 422);
    }
  }
  return { projectId, row, g, request: finish.request };
}

/** Make a planned 2K finish beside its take. */
export function startFinish({ projectId, row, g, request }: FinishPlan): Generation[] {
  let made: Generation[];
  try {
    made = createGenerations(request, g.batchId ? { batchId: g.batchId } : {});
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new CinemaError((e as Error).message, 422);
  }
  recordTakes(projectId, made, row.folder_id, parse<ItemMeta>(row.meta_json, {}).take);
  return made;
}

/** Whether a take has a 2K finish that hasn't failed (request.finishOf; one in the Trash doesn't count). */
function finishedIn2k(generationId: string): boolean {
  return !!db()
    .prepare(
      `SELECT 1 FROM generations g LEFT JOIN generation_trash t ON t.generation_id = g.id
       WHERE json_extract(g.request_json, '$.finishOf') = ? AND g.status NOT IN ('failed', 'canceled') AND t.deleted_at IS NULL LIMIT 1`,
    )
    .get(generationId);
}

export function setTiles(projectId: string, generationId: string, tiles: CinemaTile[]): CinemaItem {
  requireProject(projectId);
  const r = itemRow(projectId, generationId);
  if (!r) throw new CinemaError("That take isn't in this project", 404);
  const meta = { ...parse<ItemMeta>(r.meta_json, {}), tiles: tiles.slice(0, 16) };
  db().prepare("UPDATE cinema_items SET meta_json = ? WHERE project_id = ? AND generation_id = ?").run(JSON.stringify(meta), projectId, generationId);
  return toItem({ ...r, meta_json: JSON.stringify(meta) });
}
