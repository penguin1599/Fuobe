import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";

// Route handlers call connection() (no request scope in a test).
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-library-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const lib = await import("@/server/library");
const { saveFile, absolutePath, listAssets } = await import("@/server/storage");
const { zipStream, zipSize } = await import("@/server/zip");
const { TOOLS } = await import("@/server/assist/tools");
const skills = await import("@/server/skills");
const { POST: bulk } = await import("@/app/api/generations/bulk/route");
const folderRoutes = await import("@/app/api/folders/route");
const folderIdRoutes = await import("@/app/api/folders/[id]/route");
const folderZipRoute = await import("@/app/api/folders/[id]/zip/route");
const generationRoutes = await import("@/app/api/generations/route");
const generationIdRoutes = await import("@/app/api/generations/[id]/route");
const assetIdRoutes = await import("@/app/api/assets/[id]/route");
const { db } = await import("@/server/db");
const projects = await import("@/server/account-projects");
const canvases = await import("@/server/account-canvas");
const { childFolders, folderTree } = await import("@/lib/library");

beforeAll(() => setSetting("demoMode", "auto"));

const DAY = 86_400_000;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

/** A finished generation with a real output file (recorded like a browser colour grade). */
function made(prompt: string, feature = "grade") {
  const asset = saveFile({ data: Buffer.concat([PNG, Buffer.from(prompt)]), contentType: "image/png", source: "generation" });
  const g = gens.recordLocalGeneration({
    feature,
    modelId: "local-color-grade",
    op: "grade",
    prompt,
    inputs: { images: ["/api/files/uploads/x.png"] },
    output: { url: asset.url, kind: "image", contentType: "image/png" },
  });
  db().prepare("UPDATE assets SET generation_id = ? WHERE id = ?").run(g.id, asset.id);
  return { g, asset };
}

const fileOf = (url: string) => absolutePath(decodeURIComponent(url.slice("/api/files/".length)));
const listIds = (o: Parameters<typeof gens.listGenerations>[0] = {}) => gens.listGenerations({ limit: 200, ...o }).map((g) => g.id);

describe("generation names", () => {
  it("carries the model and preset names and the aspect ratio, so result views need no catalog", () => {
    const { g } = made("names");
    expect(g.modelName).toBe("Color Grading");
    expect(g.presetName).toBeNull();
    const [img] = gens.createGenerations({ feature: "image", modelId: "nano-banana-pro", prompt: "a fox", params: { aspectRatio: "16:9" } });
    expect(img.modelName).toBe("Nano Banana Pro");
    expect(img.aspectRatio).toBe("16:9");
    expect(img.deletedAt).toBeNull();
    expect(img.folderId).toBeNull();
  });
});

describe("trash (soft delete)", () => {
  it("hides trashed generations from every reader and restores them", async () => {
    const a = made("alpha lighthouse").g;
    const b = made("beta lighthouse").g;
    expect(lib.trashGenerations([a.id])).toBe(1);
    expect(lib.trashGenerations([a.id])).toBe(0); // already there
    expect(listIds()).not.toContain(a.id);
    expect(listIds()).toContain(b.id);
    expect(listIds({ q: "lighthouse" })).toEqual([b.id]);
    expect(gens.getGeneration(a.id)).toBeNull();
    expect(gens.getGeneration(a.id, { includeDeleted: true })?.deletedAt).toBeGreaterThan(0);
    // Assist / MCP list_recent goes through listGenerations.
    const recent = TOOLS.find((t) => t.name === "list_recent")!;
    const out = await recent.run({ limit: 30 }, {} as never);
    expect(String(out.content)).not.toContain(a.id);
    // The Trash lists it, newest deletion first.
    const trash = gens.listGenerations({ trashed: true });
    expect(trash.map((g) => g.id)).toEqual([a.id]);
    expect(trash[0].deletedAt).toBeTypeOf("number");
    expect(lib.libraryFacets().trash).toBe(1);

    expect(lib.restoreGenerations([a.id])).toBe(1);
    expect(gens.getGeneration(a.id)?.deletedAt).toBeNull();
    expect(listIds()).toContain(a.id);
  });

  it("deletes for good, keeping output files something else still uses", async () => {
    const lone = made("lone");
    const used = made("used as a character");
    db()
      .prepare("INSERT INTO characters (id, name, reference_asset_ids_json, status, created_at, updated_at) VALUES ('c1', 'Maya', ?, 'ready', 0, 0)")
      .run(JSON.stringify([used.asset.url]));
    lib.trashGenerations([lone.g.id, used.g.id]);
    expect(await lib.deleteForever([lone.g.id, used.g.id])).toBe(2);
    expect(gens.getGeneration(lone.g.id, { includeDeleted: true })).toBeNull();
    expect(fs.existsSync(fileOf(lone.asset.url))).toBe(false);
    expect(fs.existsSync(fileOf(used.asset.url))).toBe(true);
    expect(gens.listGenerations({ trashed: true }).map((g) => g.id)).not.toContain(lone.g.id);
  });

  it("purges what has been in the Trash for 30 days", async () => {
    const old = made("old").g;
    const recent = made("recent").g;
    const now = Date.now();
    lib.trashGenerations([old.id], now - 31 * DAY);
    lib.trashGenerations([recent.id], now - 2 * DAY);
    expect(await lib.purgeTrash(now)).toBe(1);
    expect(gens.getGeneration(old.id, { includeDeleted: true })).toBeNull();
    expect(gens.getGeneration(recent.id, { includeDeleted: true })?.deletedAt).toBe(now - 2 * DAY);
    expect(await lib.emptyTrash()).toBeGreaterThanOrEqual(1);
    expect(gens.listGenerations({ trashed: true })).toEqual([]);
  });

  it("cancels a job moved to the Trash (Restore brings it back canceled), and one deleted for good", async () => {
    const [job] = gens.createGenerations({ feature: "image", modelId: "nano-banana-pro", prompt: "a slow one" });
    lib.trashGenerations([job.id]);
    // It doesn't keep rendering (and billing) out of sight.
    await vi.waitFor(() => expect(gens.getGeneration(job.id, { includeDeleted: true })!.status).toBe("canceled"));
    lib.restoreGenerations([job.id]);
    expect(gens.getGeneration(job.id)?.status).toBe("canceled");
    const [other] = gens.createGenerations({ feature: "image", modelId: "nano-banana-pro", prompt: "another slow one" });
    await lib.deleteForever([other.id]);
    expect(gens.getGeneration(other.id, { includeDeleted: true })).toBeNull();
  });

  it("keeps output files still used by Cinema, canvases or Assist chats when deleting for good", async () => {
    const cover = made("cinema cover");
    const node = made("canvas input");
    const chat = made("chat attachment");
    const lone = made("nobody uses this");
    const now = Date.now();
    db().prepare("INSERT INTO cinema_projects (id, name, cover_url, created_at, updated_at) VALUES ('p-keep', 'Keep', ?, ?, ?)").run(cover.asset.url, now, now);
    // Its own Cinema membership doesn't keep a take's files.
    db().prepare("INSERT INTO cinema_items (project_id, generation_id, meta_json, created_at) VALUES ('p-keep', ?, ?, ?)").run(lone.g.id, JSON.stringify({ tiles: [{ url: lone.asset.url, row: 0, col: 0 }] }), now);
    db()
      .prepare("INSERT INTO canvases (id, name, graph_json, created_at, updated_at) VALUES ('c-keep', 'Board', ?, ?, ?)")
      .run(JSON.stringify({ nodes: [{ id: "n1", data: { url: node.asset.url } }], edges: [] }), now, now);
    db()
      .prepare("INSERT INTO assist_threads (id, title, status, agent, engine, messages_json, created_at, updated_at) VALUES ('t-keep', 'Chat', 'idle', 'offline', 'cloud', ?, ?, ?)")
      .run(JSON.stringify([{ role: "user", content: [{ type: "text", text: `see ${chat.asset.url}` }] }]), now, now);
    expect(gens.assetInUse(cover.asset.id)).toBe(true);
    expect(gens.assetInUse(lone.asset.id, lone.g.id)).toBe(false);
    lib.trashGenerations([cover.g.id, node.g.id, chat.g.id, lone.g.id]);
    expect(await lib.deleteForever([cover.g.id, node.g.id, chat.g.id, lone.g.id])).toBe(4);
    for (const kept of [cover, node, chat]) expect(fs.existsSync(fileOf(kept.asset.url))).toBe(true);
    expect(fs.existsSync(fileOf(lone.asset.url))).toBe(false);
  });

  it("empties a Trash with dangling entries (rows already gone)", async () => {
    const a = made("dangling a").g;
    lib.trashGenerations([a.id]);
    db().prepare("INSERT INTO generation_trash (generation_id, deleted_at) VALUES ('ghost', ?)").run(Date.now());
    expect(await lib.emptyTrash()).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM generation_trash").get()).toEqual({ n: 0 });
  });
});

describe("paging", () => {
  const pageAll = (o: NonNullable<Parameters<typeof gens.listGenerations>[0]>, limit: number) => {
    const seen: string[] = [];
    let cursor: { before?: number; beforeId?: string } = {};
    for (let i = 0; i < 20; i++) {
      const page = gens.listGenerations({ ...o, ...cursor, limit });
      seen.push(...page.map((g) => g.id));
      if (page.length < limit) break;
      const last = page.at(-1)!;
      cursor = lib.cursorFrom(`${o.trashed ? last.deletedAt : last.createdAt}:${last.id}`);
    }
    return seen;
  };

  it("pages a bulk trash (one deletedAt for all) without skipping any", () => {
    const items = Array.from({ length: 70 }, (_, i) => made(`tie-trash ${i}`).g.id);
    expect(lib.trashGenerations(items)).toBe(70);
    const seen = pageAll({ trashed: true, q: "tie-trash" }, 60);
    expect(seen).toHaveLength(70);
    expect(new Set(seen).size).toBe(70);
    // The old timestamp-only cursor lost the 10 that share the boundary's deletedAt.
    const first = gens.listGenerations({ trashed: true, q: "tie-trash", limit: 60 });
    expect(gens.listGenerations({ trashed: true, q: "tie-trash", limit: 60, before: first.at(-1)!.deletedAt! })).toHaveLength(0);
    lib.restoreGenerations(items);
  });

  it("pages rows made in the same millisecond (storyboard frames, pipelines) without skipping any", () => {
    const items = Array.from({ length: 6 }, (_, i) => made(`tie-created ${i}`).g.id);
    db().prepare(`UPDATE generations SET created_at = 1234 WHERE id IN (${items.map(() => "?").join(",")})`).run(...items);
    const seen = pageAll({ q: "tie-created" }, 4);
    expect(seen.sort()).toEqual([...items].sort());
  });

  it("pages uploads (the Uploads tab) the same way", () => {
    const ups = Array.from({ length: 5 }, (_, i) => saveFile({ data: Buffer.concat([PNG, Buffer.from(`up ${i}`)]), contentType: "image/png", source: "upload" }).id);
    db().prepare(`UPDATE assets SET created_at = 4321 WHERE id IN (${ups.map(() => "?").join(",")})`).run(...ups);
    const seen: string[] = [];
    let cursor: { before?: number; beforeId?: string } = { before: 4322 };
    for (let i = 0; i < 5; i++) {
      const page = listAssets({ source: "upload", limit: 2, ...cursor }).filter((a) => a.createdAt === 4321);
      seen.push(...page.map((a) => a.id));
      if (page.length < 2) break;
      cursor = lib.cursorFrom(`${page[1].createdAt}:${page[1].id}`);
    }
    expect(seen.sort()).toEqual([...ups].sort());
  });

  it("reads the cursor in both forms", () => {
    expect(lib.cursorFrom("1700000000000:Ab_c-9")).toEqual({ before: 1700000000000, beforeId: "Ab_c-9" });
    expect(lib.cursorFrom("1700000000000")).toEqual({ before: 1700000000000 });
    expect(lib.cursorFrom("nope")).toEqual({});
    expect(lib.cursorFrom(null)).toEqual({});
  });
});

describe("list filters (GET /api/generations)", () => {
  it("maps every query field and ignores unknown values", () => {
    const sp = new URLSearchParams({
      kinds: "image,video,bogus",
      models: "a,b",
      statuses: "failed,canceled,exploded",
      since: "100",
      until: "200",
      folder: "f1",
      q: "koi",
      favorites: "1",
      trash: "1",
      limit: "30",
      before: "150:xyz",
      features: "image,video*",
      kind: "nope",
    });
    expect(lib.listOptionsFrom(sp)).toMatchObject({
      kinds: ["image", "video"],
      models: ["a", "b"],
      statuses: ["failed", "canceled"],
      since: 100,
      until: 200,
      folderId: "f1",
      q: "koi",
      favorites: true,
      trashed: true,
      limit: 30,
      before: 150,
      beforeId: "xyz",
      features: ["image", "video*"],
      kind: undefined,
    });
  });

  it("filters by kind, model, status, date, folder and the user's own words", () => {
    const a = made("filter alpha").g;
    const b = made("filter beta").g;
    db().prepare("UPDATE generations SET status = 'failed', created_at = 50, request_json = ? WHERE id = ?").run(JSON.stringify({ ...b.request, prompt: "my words: zebra" }), b.id);
    const f = lib.createFolder({ name: "Filters" });
    lib.moveToFolder([a.id], f.id);
    const ids = (q: Record<string, string>) => gens.listGenerations({ ...lib.listOptionsFrom(new URLSearchParams(q)), limit: 200 }).map((g) => g.id);
    expect(ids({ q: "zebra" })).toEqual([b.id]); // request.prompt, not only the model's prompt
    expect(ids({ statuses: "failed", q: "filter" })).toEqual([b.id]);
    expect(ids({ until: "100", q: "filter" })).toEqual([b.id]);
    expect(ids({ since: "100", q: "filter" })).toEqual([a.id]);
    expect(ids({ folder: f.id })).toEqual([a.id]);
    expect(ids({ kinds: "video", q: "filter" })).toEqual([]);
    expect(ids({ models: "local-color-grade", q: "filter" }).sort()).toEqual([a.id, b.id].sort());
    expect(ids({ models: "other", q: "filter" })).toEqual([]);
    lib.deleteFolder(f.id);
  });

  it("counts facets for the filter menus", () => {
    const before = lib.libraryFacets();
    const g = made("facet one").g;
    lib.setFavorites([g.id], true);
    const failed = made("facet two").g;
    db().prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(failed.id);
    const gone = made("facet three").g;
    lib.trashGenerations([gone.id]);
    const after = lib.libraryFacets();
    expect(after.total - before.total).toBe(2);
    expect(after.favorites - before.favorites).toBe(1);
    expect(after.failed - before.failed).toBe(1);
    expect(after.trash - before.trash).toBe(1);
    expect((after.kinds.image ?? 0) - (before.kinds.image ?? 0)).toBe(2);
    expect(after.models.find((m) => m.id === "local-color-grade")?.name).toBe("Color Grading");
  });
});

describe("Assist plans", () => {
  it("puts a plan's independent jobs in one batch, titled with its summary, so the Library stacks them", async () => {
    const generate = TOOLS.find((t) => t.name === "generate")!;
    const out = await generate.run(
      {
        summary: "Two animal posters",
        jobs: [
          { model_id: "nano-banana-pro", prompt: "a fox poster" },
          { model_id: "nano-banana-pro", prompt: "an owl poster" },
        ],
      },
      { engine: "cloud" },
    );
    const ids = (out.items?.[0] as { ids: string[] }).ids;
    const made = ids.map((id) => gens.getGeneration(id)!);
    expect(made).toHaveLength(2);
    expect(made[0].batchId).toBeTruthy();
    expect(made[1].batchId).toBe(made[0].batchId);
    expect(made.map((g) => g.request.batchTitle)).toEqual(["Two animal posters", "Two animal posters"]);
  });
});

describe("folder routes", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
  const body = (b: unknown, method = "POST") => new Request("http://x/api/folders", { method, body: JSON.stringify(b) });

  it("creates, refuses duplicates, renames, 404s and deletes", async () => {
    const res = await folderRoutes.POST(body({ name: "Routes", color: "cyan" }));
    expect(res.status).toBe(201);
    const f = (await res.json()) as { id: string; name: string };
    expect((await folderRoutes.POST(body({ name: "routes" }))).status).toBe(409);
    expect((await folderRoutes.POST(body({ name: " " }))).status).toBe(400);
    expect(((await (await folderRoutes.GET()).json()) as { items: { id: string }[] }).items.map((x) => x.id)).toContain(f.id);
    const renamed = await folderIdRoutes.PATCH(body({ name: "Routes 2" }, "PATCH"), ctx(f.id));
    expect(((await renamed.json()) as { name: string }).name).toBe("Routes 2");
    expect((await folderIdRoutes.PATCH(body({ name: "x" }, "PATCH"), ctx("missing"))).status).toBe(404);
    expect((await folderIdRoutes.GET(new Request("http://x"), ctx("missing"))).status).toBe(404);
    expect((await folderIdRoutes.DELETE(new Request("http://x"), ctx(f.id))).status).toBe(204);
    expect((await folderIdRoutes.DELETE(new Request("http://x"), ctx(f.id))).status).toBe(404);
  });
});

describe("folders", () => {
  it("creates, renames, recolours, moves into and deletes folders", () => {
    const f = lib.createFolder({ name: "Campaign", color: "pink" });
    expect(f).toMatchObject({ name: "Campaign", color: "pink", count: 0, cover: null });
    expect(() => lib.createFolder({ name: "campaign" })).toThrow(/already a folder/);
    expect(lib.createFolder({ name: "Other", color: "nope" }).color).toBe("lime");
    const a = made("in folder a").g;
    const b = made("in folder b").g;
    // The cover is the newest: make b clearly newer (both can land in the same millisecond).
    db().prepare("UPDATE generations SET created_at = created_at + 1000 WHERE id = ?").run(b.id);
    expect(lib.moveToFolder([a.id, b.id], f.id)).toBe(2);
    expect(lib.getFolder(f.id)).toMatchObject({ count: 2 });
    expect(lib.getFolder(f.id)!.cover?.url).toBe(b.outputs[0].url);
    expect(listIds({ folderId: f.id }).sort()).toEqual([a.id, b.id].sort());
    expect(gens.getGeneration(a.id)?.folderId).toBe(f.id);
    // Trashed items don't count.
    lib.trashGenerations([b.id]);
    expect(lib.getFolder(f.id)!.count).toBe(1);
    lib.restoreGenerations([b.id]);
    // Moving back to the root.
    lib.moveToFolder([b.id], null);
    expect(listIds({ folderId: f.id })).toEqual([a.id]);
    expect(lib.updateFolder(f.id, { name: "Launch", color: "cyan" })).toMatchObject({ name: "Launch", color: "cyan" });
    expect(() => lib.moveToFolder([a.id], "missing")).toThrow(/doesn't exist/);
    // Deleting the folder keeps what was in it.
    expect(lib.deleteFolder(f.id)).toBe(true);
    expect(gens.getGeneration(a.id)?.folderId).toBeNull();
    expect(lib.listFolders().map((x) => x.name)).toEqual(["Other"]);
  });
});

describe("bulk endpoint", () => {
  const call = async (body: unknown) => {
    const res = await bulk(new Request("http://x/api/generations/bulk", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as { count?: number; error?: string } };
  };

  it("favorites, moves, trashes, restores and deletes many at once", async () => {
    const items = [made("bulk 1").g, made("bulk 2").g, made("bulk 3").g];
    const ids = items.map((g) => g.id);
    expect(await call({ action: "favorite", ids })).toEqual({ status: 200, body: { count: 3 } });
    expect(gens.listGenerations({ favorites: true }).filter((g) => ids.includes(g.id))).toHaveLength(3);
    const folder = lib.createFolder({ name: "Bulk" });
    expect((await call({ action: "move", ids, folderId: folder.id })).body.count).toBe(3);
    expect((await call({ action: "trash", ids: ids.slice(0, 2) })).body.count).toBe(2);
    expect(listIds({ folderId: folder.id })).toEqual([ids[2]]);
    expect((await call({ action: "restore", ids: [ids[0]] })).body.count).toBe(1);
    expect((await call({ action: "delete", ids: [ids[1]] })).body.count).toBe(1);
    expect(gens.getGeneration(ids[1], { includeDeleted: true })).toBeNull();
    expect((await call({ action: "move", ids, folderId: "gone" })).status).toBe(422);
    expect((await call({ action: "explode", ids })).status).toBe(400);
    expect((await call({ action: "trash", ids: [] })).status).toBe(400);
  });
});

describe("zip download", () => {
  it("streams a zip other tools can read, with unique readable names", async () => {
    const a = made("zip me").g;
    const b = made("zip me").g;
    const entries = lib.zipEntries([a.id, b.id, "missing"]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.name)).size).toBe(2);
    expect(entries[0].name).toMatch(/^zip-me-.{6}\.png$/);
    const chunks: Uint8Array[] = [];
    const reader = zipStream(entries).getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBe(zipSize(entries));
    const file = path.join(dir, "out.zip");
    fs.writeFileSync(file, buf);
    const out = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), len(z.namelist()), z.read(z.namelist()[0])[-6:].decode())", file]).toString();
    expect(out.trim()).toBe("None 2 zip me");
  });
});

// ---------------------------------------------------------------------------
// Round 4 (library-plus): helper steps, nested folders, pins, review status, deleting uploads, ASSET_REFS

const ctxOf = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const jsonReq = (url: string, method: string, b?: unknown) => new Request(`http://x${url}`, { method, ...(b !== undefined && { body: JSON.stringify(b) }) });

describe("helper steps", () => {
  it("are left out of the Library, the home feed and Assist's list_recent, unless asked for", async () => {
    const final = made("helper final", "shorts").g;
    const cut = made("helper cut", "shorts-step").g;
    const preview = made("helper preview", "mixed-media-preview").g;
    const avatar = made("helper avatar", "faceless-avatar").g;
    db().prepare(`UPDATE generations SET batch_id = 'hb1' WHERE id IN (?, ?)`).run(final.id, cut.id);
    const q = { q: "helper", limit: 200 };
    expect(gens.listGenerations(q).map((g) => g.id)).toEqual([final.id]);
    expect(gens.listGenerations({ ...q, steps: true }).map((g) => g.id).sort()).toEqual([final.id, cut.id, preview.id, avatar.id].sort());
    // Lists that name their features (a studio's own feed) or their batch get the steps as asked.
    expect(gens.listGenerations({ ...q, features: ["shorts", "shorts-step"] }).map((g) => g.id).sort()).toEqual([final.id, cut.id].sort());
    expect(gens.listGenerations({ ...q, features: ["mixed-media*"] }).map((g) => g.id)).toEqual([preview.id]);
    expect(gens.listGenerations({ ...q, feature: "faceless-avatar" }).map((g) => g.id)).toEqual([avatar.id]);
    expect(gens.listGenerations({ batchId: "hb1" }).map((g) => g.id).sort()).toEqual([final.id, cut.id].sort());
    // GET /api/generations: steps=1 shows them.
    const get = async (qs: string) => ((await (await generationRoutes.GET(new Request(`http://x/api/generations?${qs}`))).json()) as { items: { id: string }[] }).items.map((g) => g.id);
    expect(await get("q=helper")).toEqual([final.id]);
    expect((await get("q=helper&steps=1")).length).toBe(4);
    // Assist / MCP list_recent reads the same list.
    const recent = TOOLS.find((t) => t.name === "list_recent")!;
    const out = String((await recent.run({ limit: 30 }, {} as never)).content);
    expect(out).not.toContain(cut.id);
    // Facets count them apart, for the Show steps toggle.
    const hidden = lib.libraryFacets();
    const shown = lib.libraryFacets({ steps: true });
    expect(hidden.steps).toBeGreaterThanOrEqual(3);
    expect(shown.total - hidden.total).toBe(hidden.steps);
    lib.trashGenerations([final.id, cut.id, preview.id, avatar.id]);
  });
});

describe("nested folders", () => {
  it("makes subfolders, with names unique among siblings only", () => {
    const top = lib.createFolder({ name: "Nest top" });
    const sub = lib.createFolder({ name: "Shots", parentId: top.id });
    expect(sub.parentId).toBe(top.id);
    expect(lib.getFolder(top.id)).toMatchObject({ folders: 1, parentId: null });
    // Another "Shots" is fine elsewhere, not next to this one.
    const elsewhere = lib.createFolder({ name: "Shots" });
    expect(() => lib.createFolder({ name: "shots", parentId: top.id })).toThrow(/already a folder/);
    expect(() => lib.createFolder({ name: "Lost", parentId: "missing" })).toThrow(/doesn't exist/);
    expect(lib.listFolders().find((f) => f.id === sub.id)).toMatchObject({ parentId: top.id, pinnedAt: null });
    for (const f of [sub, top, elsewhere]) lib.deleteFolder(f.id);
  });

  it("moves folders into others, refusing loops, namesakes and depth past the limit", () => {
    const a = lib.createFolder({ name: "Move A" });
    const b = lib.createFolder({ name: "Move B", parentId: a.id });
    const c = lib.createFolder({ name: "Move C", parentId: b.id });
    const d = lib.createFolder({ name: "Move D" });
    expect(() => lib.moveFolder(a.id, a.id)).toThrow("Cannot move into itself");
    expect(() => lib.moveFolder(a.id, c.id)).toThrow("Cannot move into a subfolder");
    expect(() => lib.moveFolder(a.id, "missing")).toThrow(/doesn't exist/);
    expect(lib.moveFolder(c.id, d.id)).toMatchObject({ parentId: d.id });
    expect(lib.getFolder(b.id)!.folders).toBe(0);
    expect(lib.moveFolder(c.id, null)).toMatchObject({ parentId: null });
    // A namesake already there.
    const twin = lib.createFolder({ name: "Move C", parentId: d.id });
    expect(() => lib.moveFolder(c.id, d.id)).toThrow(/already a folder called “Move C” there/);
    // Renaming and moving at once is checked against the new place.
    expect(lib.updateFolder(c.id, { name: "Move C2", parentId: d.id })).toMatchObject({ name: "Move C2", parentId: d.id });
    // Depth: a chain at the limit takes no more.
    let parent = d.id;
    const chain: string[] = [];
    for (let i = 1; i < 8; i++) chain.push((parent = lib.createFolder({ name: `Deep ${i}`, parentId: parent }).id));
    expect(() => lib.createFolder({ name: "Too deep", parentId: parent })).toThrow(/levels deep/);
    expect(() => lib.moveFolder(a.id, chain[5])).toThrow(/levels deep/);
    for (const id of [...chain.reverse(), twin.id, c.id, d.id, b.id, a.id]) lib.deleteFolder(id);
  });

  it("deletes a folder by moving its results and subfolders up to its parent", () => {
    const top = lib.createFolder({ name: "Del top" });
    const mid = lib.createFolder({ name: "Del mid", parentId: top.id });
    const leaf = lib.createFolder({ name: "Drafts", parentId: mid.id });
    const clash = lib.createFolder({ name: "Drafts", parentId: top.id });
    const g1 = made("del in mid").g;
    const g2 = made("del in leaf").g;
    lib.moveToFolder([g1.id], mid.id);
    lib.moveToFolder([g2.id], leaf.id);
    expect(lib.deleteFolder(mid.id)).toBe(true);
    expect(gens.getGeneration(g1.id)!.folderId).toBe(top.id);
    expect(gens.getGeneration(g2.id)!.folderId).toBe(leaf.id);
    // The subfolder moved up next to a namesake, so it was renamed.
    expect(lib.getFolder(leaf.id)).toMatchObject({ parentId: top.id, name: "Drafts 2" });
    expect(lib.getFolder(clash.id)!.name).toBe("Drafts");
    // A top-level folder: everything goes to the library root.
    expect(lib.deleteFolder(top.id)).toBe(true);
    expect(gens.getGeneration(g1.id)!.folderId).toBeNull();
    expect(lib.getFolder(leaf.id)!.parentId).toBeNull();
    expect(lib.deleteFolder(top.id)).toBe(false);
    for (const f of [leaf, clash]) lib.deleteFolder(f.id);
  });

  it("lists a folder with its subfolders' results (folders=…), and keeps the flat routes working", async () => {
    const top = (await (await folderRoutes.POST(jsonReq("/api/folders", "POST", { name: "Route top" }))).json()) as { id: string; parentId: null };
    expect(top.parentId).toBeNull();
    const subRes = await folderRoutes.POST(jsonReq("/api/folders", "POST", { name: "Route sub", parentId: top.id }));
    expect(subRes.status).toBe(201);
    const sub = (await subRes.json()) as { id: string; parentId: string };
    expect(sub.parentId).toBe(top.id);
    expect((await folderRoutes.POST(jsonReq("/api/folders", "POST", { name: "Orphan", parentId: "missing" }))).status).toBe(404);
    // The flat list has both, each with its parent.
    const all = ((await (await folderRoutes.GET()).json()) as { items: { id: string; parentId: string | null }[] }).items;
    expect(all.find((f) => f.id === sub.id)?.parentId).toBe(top.id);
    // PATCH moves (409 into its own subfolder), pins and unpins.
    expect((await folderIdRoutes.PATCH(jsonReq("/x", "PATCH", { parentId: sub.id }), ctxOf(top.id))).status).toBe(409);
    const pinned = (await (await folderIdRoutes.PATCH(jsonReq("/x", "PATCH", { pinned: true }), ctxOf(sub.id))).json()) as { pinnedAt: number | null };
    expect(pinned.pinnedAt).toBeTypeOf("number");
    const moved = (await (await folderIdRoutes.PATCH(jsonReq("/x", "PATCH", { parentId: null }), ctxOf(sub.id))).json()) as { parentId: string | null; pinnedAt: number | null };
    expect(moved).toMatchObject({ parentId: null, pinnedAt: pinned.pinnedAt });
    await folderIdRoutes.PATCH(jsonReq("/x", "PATCH", { parentId: top.id, pinned: false }), ctxOf(sub.id));
    // Results in either, through GET /api/generations?folders=.
    const a = made("tree a").g;
    const b = made("tree b").g;
    lib.moveToFolder([a.id], top.id);
    lib.moveToFolder([b.id], sub.id);
    const ids = (qs: string) => gens.listGenerations({ ...lib.listOptionsFrom(new URLSearchParams(qs)), limit: 200 }).map((g) => g.id);
    expect(ids(`folder=${top.id}`)).toEqual([a.id]);
    expect(ids(`folders=${top.id},${sub.id}`).sort()).toEqual([a.id, b.id].sort());
    lib.deleteFolder(sub.id);
    lib.deleteFolder(top.id);
  });

  it("orders folders with the pinned ones first", () => {
    const x = lib.createFolder({ name: "Order x" });
    const y = lib.createFolder({ name: "Order y" });
    lib.updateFolder(y.id, { pinned: true });
    const order = lib.listFolders().map((f) => f.id);
    expect(order.indexOf(y.id)).toBeLessThan(order.indexOf(x.id));
    expect(order[0]).toBe(y.id);
    lib.deleteFolder(x.id);
    lib.deleteFolder(y.id);
  });

  it("downloads a folder as a zip with its subfolders inside", async () => {
    const top = lib.createFolder({ name: "Zip/top" });
    const sub = lib.createFolder({ name: "Close ups", parentId: top.id });
    const deeper = lib.createFolder({ name: "Hands", parentId: sub.id });
    const empty = lib.createFolder({ name: "Zip empty" });
    const a = made("zip top").g;
    const b = made("zip sub").g;
    const c = made("zip deep").g;
    const gone = made("zip trashed").g;
    lib.moveToFolder([a.id], top.id);
    lib.moveToFolder([b.id, gone.id], sub.id);
    lib.moveToFolder([c.id], deeper.id);
    lib.trashGenerations([gone.id]);
    const zip = lib.folderZipEntries(top.id)!;
    expect(zip.name).toBe("Zip/top");
    expect(zip.entries.map((e) => e.name.replace(/-[\w-]{6}\.png$/, "")).sort()).toEqual(["Close ups/Hands/zip-deep", "Close ups/zip-sub", "zip-top"]);
    expect(lib.folderZipEntries("missing")).toBeNull();
    // The route: ?check=1 answers the count, then the zip itself reads back in Python.
    const check = await folderZipRoute.GET(new Request("http://x/zip?check=1"), ctxOf(top.id));
    expect(await check.json()).toMatchObject({ files: 3 });
    const res = await folderZipRoute.GET(new Request("http://x/zip"), ctxOf(top.id));
    expect(res.headers.get("Content-Disposition")).toMatch(/filename="Zip-top-\d{4}-\d{2}-\d{2}\.zip"/);
    const file = path.join(dir, "folder.zip");
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const names = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('|'.join(sorted(z.namelist())))", file]).toString().trim();
    expect(names.split("|").map((n) => n.replace(/-[\w-]{6}\.png$/, ""))).toEqual(["Close ups/Hands/zip-deep", "Close ups/zip-sub", "zip-top"]);
    expect((await folderZipRoute.GET(new Request("http://x/zip"), ctxOf(empty.id))).status).toBe(404);
    expect((await folderZipRoute.GET(new Request("http://x/zip"), ctxOf("missing"))).status).toBe(404);
    for (const f of [deeper, sub, top, empty]) lib.deleteFolder(f.id);
  });

  it("refuses an empty parentId in the routes, and reads one as the root everywhere else", async () => {
    const top = lib.createFolder({ name: "Blank parent top" });
    expect((await folderRoutes.POST(jsonReq("/api/folders", "POST", { name: "Ghost", parentId: "" }))).status).toBe(400);
    const patch = await folderIdRoutes.PATCH(jsonReq("/x", "PATCH", { parentId: "" }), ctxOf(top.id));
    expect(patch.status).toBe(400);
    expect(((await patch.json()) as { error: string }).error).toMatch(/Pick a folder/);
    // Called directly (Assist, the CLI), "" is the library root: never a parent nothing has.
    const ghost = lib.createFolder({ name: "Ghost", parentId: "" });
    expect(ghost.parentId).toBeNull();
    const sub = lib.createFolder({ name: "Blank parent sub", parentId: top.id });
    expect(lib.updateFolder(sub.id, { parentId: "" })).toMatchObject({ parentId: null });
    const all = lib.listFolders();
    expect(childFolders(all, null).map((f) => f.id)).toEqual(expect.arrayContaining([top.id, ghost.id, sub.id]));
    expect(folderTree(all).map((t) => t.folder.id)).toEqual(expect.arrayContaining([top.id, ghost.id, sub.id]));
    expect(db().prepare("SELECT COUNT(*) AS n FROM folders WHERE parent_id = ''").get()).toEqual({ n: 0 });
    for (const f of [sub, ghost, top]) lib.deleteFolder(f.id);
  });

  it("counts, covers and zips a folder as its page shows it: helper steps only with Show steps", async () => {
    const f = lib.createFolder({ name: "Steps inside" });
    const result = made("steps inside result", "shorts").g;
    const step = made("steps inside cut", "shorts-step").g;
    lib.moveToFolder([result.id, step.id], f.id);
    // The step is the newest, but the cover is the result's.
    db().prepare("UPDATE generations SET created_at = created_at + 1000 WHERE id = ?").run(step.id);
    expect(lib.getFolder(f.id)).toMatchObject({ count: 1, cover: { url: result.outputs[0].url } });
    expect(listIds({ folderId: f.id })).toEqual([result.id]);
    expect(listIds({ folderId: f.id, steps: true }).sort()).toEqual([result.id, step.id].sort());
    expect(lib.folderZipEntries(f.id)!.entries).toHaveLength(1);
    expect(lib.folderZipEntries(f.id, { steps: true })!.entries).toHaveLength(2);
    const check = async (qs: string) => (await (await folderZipRoute.GET(new Request(`http://x/zip?${qs}`), ctxOf(f.id))).json()) as { files: number };
    expect((await check("check=1")).files).toBe(1);
    expect((await check("steps=1&check=1")).files).toBe(2);
    lib.deleteFolder(f.id);
    lib.trashGenerations([result.id, step.id]);
  });
});

describe("pins and review status", () => {
  it("pins results to their own list, most recently pinned first, and unpins them", () => {
    const [a, b, c] = [made("pin a").g, made("pin b").g, made("pin c").g];
    expect(lib.setPinned([a.id], true, 1000)).toBe(1);
    expect(lib.setPinned([c.id, b.id], true, 2000)).toBe(2);
    // Pinning again keeps the first pin time (its place).
    lib.setPinned([a.id], true, 9000);
    expect(gens.getGeneration(a.id)!.pinnedAt).toBe(1000);
    const pinned = gens.listGenerations({ q: "pin ", pinned: true });
    expect(pinned.map((g) => g.id)).toEqual([[b.id, c.id].sort().reverse(), a.id].flat());
    expect(gens.listGenerations({ q: "pin ", pinned: false })).toEqual([]);
    // Paging a pinned list goes by pin time.
    const first = gens.listGenerations({ q: "pin ", pinned: true, limit: 2 });
    const next = gens.listGenerations({ q: "pin ", pinned: true, limit: 2, ...lib.cursorFrom(`${first[1].pinnedAt}:${first[1].id}`) });
    expect(next.map((g) => g.id)).toEqual([a.id]);
    expect(lib.libraryFacets().pinned).toBeGreaterThanOrEqual(3);
    lib.setPinned([a.id, b.id, c.id], false);
    expect(gens.getGeneration(a.id)!.pinnedAt).toBeNull();
    expect(gens.listGenerations({ q: "pin ", pinned: true })).toEqual([]);
  });

  it("sets, filters and clears review statuses", async () => {
    const [a, b] = [made("review a").g, made("review b").g];
    expect(lib.setReview([a.id], "approved")).toBe(1);
    expect(gens.getGeneration(a.id)!.review).toBe("approved");
    expect(() => lib.setReview([a.id], "great" as never)).toThrow(/review status/);
    const ids = (qs: string) => gens.listGenerations({ ...lib.listOptionsFrom(new URLSearchParams(qs)), limit: 200 }).map((g) => g.id);
    expect(ids("q=review&reviews=approved")).toEqual([a.id]);
    expect(ids("q=review&reviews=none")).toEqual([b.id]);
    expect(ids("q=review&reviews=approved,none").sort()).toEqual([a.id, b.id].sort());
    expect(ids("q=review&reviews=bogus").sort()).toEqual([a.id, b.id].sort());
    expect(lib.libraryFacets().reviews.approved).toBeGreaterThanOrEqual(1);
    // The bulk endpoint and the single PATCH.
    const call = async (body: unknown) => (await bulk(jsonReq("/api/generations/bulk", "POST", body))).json() as Promise<{ count?: number }>;
    expect(await call({ action: "review", ids: [a.id, b.id], review: "needs-review" })).toEqual({ count: 2 });
    expect(gens.getGeneration(b.id)!.review).toBe("needs-review");
    expect((await bulk(jsonReq("/api/generations/bulk", "POST", { action: "review", ids: [a.id], review: "great" }))).status).toBe(400);
    expect(await call({ action: "pin", ids: [a.id] })).toEqual({ count: 1 });
    expect(gens.getGeneration(a.id)!.pinnedAt).toBeTypeOf("number");
    expect(await call({ action: "unpin", ids: [a.id] })).toEqual({ count: 1 });
    const patched = (await (await generationIdRoutes.PATCH(jsonReq("/x", "PATCH", { review: null, pinned: true }), ctxOf(b.id))).json()) as { review: string | null; pinnedAt: number | null };
    expect(patched.review).toBeNull();
    expect(patched.pinnedAt).toBeTypeOf("number");
    expect((await generationIdRoutes.PATCH(jsonReq("/x", "PATCH", { review: "great" }), ctxOf(b.id))).status).toBe(400);
    expect(await call({ action: "review", ids: [a.id], review: null })).toEqual({ count: 1 });
    expect(gens.getGeneration(a.id)!.review).toBeNull();
    lib.setPinned([b.id], false);
  });
});

describe("deleting uploads", () => {
  const upload = (tag: string) => saveFile({ data: Buffer.concat([PNG, Buffer.from(tag)]), contentType: "image/png", source: "upload", name: `${tag}.png` });
  const del = async (id: string) => {
    const res = await assetIdRoutes.DELETE(new Request("http://x", { method: "DELETE" }), ctxOf(id));
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as { error?: string; usedBy?: string }) };
  };

  it("deletes an upload nothing uses, file and all", async () => {
    const free = upload("free upload");
    const file = fileOf(free.url);
    expect(fs.existsSync(file)).toBe(true);
    const info = (await (await assetIdRoutes.GET(new Request("http://x"), ctxOf(free.id))).json()) as { usedBy: string; uses: unknown[] };
    expect(info).toMatchObject({ usedBy: "", uses: [] });
    expect((await del(free.id)).status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect(listAssets({ source: "upload", limit: 500 }).map((a) => a.id)).not.toContain(free.id);
    expect((await del(free.id)).status).toBe(404);
  });

  it("refuses while a result's request uses it (in the Trash too), and says where", async () => {
    const used = upload("used upload");
    const [g] = gens.createGenerations({ feature: "edit", modelId: "nano-banana-pro", op: "edit", prompt: "make it blue", inputs: { images: [used.url] } });
    let r = await del(used.id);
    expect(r.status).toBe(409);
    expect(r.body?.usedBy).toBe("1 result");
    expect(r.body?.error).toBe("It's still used by 1 result.");
    // Trashed results can be restored (and retried), so they still count.
    lib.trashGenerations([g.id]);
    r = await del(used.id);
    expect(r.status).toBe(409);
    expect(r.body?.usedBy).toBe("1 result (in the Trash)");
    expect(fs.existsSync(fileOf(used.url))).toBe(true);
    // Deleted for good: now it can go.
    await lib.deleteForever([g.id]);
    expect((await del(used.id)).status).toBe(204);
  });

  it("names the elements, Assist projects and studio sessions that use it", async () => {
    const pic = upload("element upload");
    const now = Date.now();
    db().prepare("INSERT INTO characters (id, name, reference_asset_ids_json, status, created_at, updated_at) VALUES ('c-up', 'Juno', ?, 'ready', 0, 0)").run(JSON.stringify([pic.url]));
    db().prepare("INSERT INTO assist_projects (id, name, created_at, updated_at) VALUES ('ap-up', 'Launch', ?, ?)").run(now, now);
    db().prepare("INSERT INTO assist_project_sources (id, project_id, kind, title, url, created_at) VALUES ('s-up', 'ap-up', 'image', 'Ref', ?, ?)").run(pic.url, now);
    db().prepare("INSERT INTO dub_sessions (id, data_json, created_at, updated_at) VALUES ('d-up', ?, ?, ?)").run(JSON.stringify({ title: "Interview", video: pic.url }), now, now);
    const r = await del(pic.id);
    expect(r.status).toBe(409);
    expect(r.body?.usedBy).toBe("the element “Juno”, the Assist project “Launch” and the dub “Interview”");
    for (const t of ["characters WHERE id = 'c-up'", "assist_project_sources WHERE id = 's-up'", "dub_sessions WHERE id = 'd-up'"]) db().prepare(`DELETE FROM ${t}`).run();
    expect((await del(pic.id)).status).toBe(204);
  });
});

describe("ASSET_REFS", () => {
  it("keeps outputs a dub or Katana job still points at when their result is deleted for good", async () => {
    const dubbed = made("dub source clip");
    const cut = made("katana subject");
    const now = Date.now();
    db().prepare("INSERT INTO dub_sessions (id, data_json, created_at, updated_at) VALUES ('d-keep', ?, ?, ?)").run(JSON.stringify({ title: "Dub", video: dubbed.asset.url }), now, now);
    db().prepare("INSERT INTO katana_jobs (id, data_json, created_at, updated_at) VALUES ('k-keep', ?, ?, ?)").run(JSON.stringify({ title: "Cut", subject: cut.asset.url }), now, now);
    expect(gens.assetUses(dubbed.asset.id, { exceptGeneration: dubbed.g.id })).toEqual([{ what: "dub", key: "d-keep", name: "Dub" }]);
    expect(gens.assetUses(cut.asset.id, { exceptGeneration: cut.g.id })).toEqual([{ what: "Katana job", key: "k-keep", name: "Cut" }]);
    await lib.deleteForever([dubbed.g.id, cut.g.id]);
    expect(fs.existsSync(fileOf(dubbed.asset.url))).toBe(true);
    expect(fs.existsSync(fileOf(cut.asset.url))).toBe(true);
  });

  it("keeps a file that only a skill's recipe.json names through Empty trash", async () => {
    const example = made("recipe example photo");
    skills.createSkill({ name: "keep-example", title: "Keep example", description: "x", body: "x" });
    const recipe = {
      fuobeRecipe: 1,
      params: [{ id: "photo", label: "Photo", type: "image", required: true, example: example.asset.url }],
      steps: [{ key: "edit", kind: "generate", request: { feature: "skill", modelId: "nano-banana-pro", op: "edit", prompt: "warmer", inputs: { images: ["{{photo}}"] } } }],
    };
    skills.setSkillFile("keep-example", "recipe.json", JSON.stringify(recipe));
    expect(gens.assetUses(example.asset.id, { exceptGeneration: example.g.id })).toEqual([{ what: "skill", key: "keep-example", name: "Keep example" }]);
    lib.trashGenerations([example.g.id]);
    expect(await lib.emptyTrash()).toBeGreaterThanOrEqual(1);
    expect(gens.getGeneration(example.g.id, { includeDeleted: true })).toBeNull();
    expect(fs.existsSync(fileOf(example.asset.url))).toBe(true);
    // Without the skill, nothing keeps it.
    skills.deleteSkill("keep-example");
    expect(gens.assetUses(example.asset.id)).toEqual([]);
  });

  it("keeps files an account's own project or board names when their results are deleted for good", async () => {
    const short = made("account short final");
    const character = made("account swap character");
    const board = made("account board picture");
    for (const f of [short, character, board]) db().prepare("UPDATE assets SET account_id = 'acct-keep' WHERE id = ?").run(f.asset.id);
    // A Shorts session names its final video in its data and its list line; a swap project's list line names its character.
    const session = projects.createAccountProject("acct-keep", "shorts", { name: "Launch short", data: { stitches: [{ final: short.asset.url }] }, summary: { final: short.asset.url } });
    const swap = projects.createAccountProject("acct-keep", "swap", { name: "Swap", data: { clips: [] }, summary: { character: character.asset.url } });
    const canvas = canvases.createAccountCanvas("acct-keep", {
      name: "Board",
      pages: [{ id: "p1", name: "Page 1", graph: { nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 }, data: { url: board.asset.url } }], edges: [] } }] as never,
    });
    expect(gens.assetUses(short.asset.id, { exceptGeneration: short.g.id })).toEqual([{ what: "account project", key: session.id, name: "Launch short" }]);
    expect(gens.assetUses(character.asset.id, { exceptGeneration: character.g.id })).toEqual([{ what: "account project", key: swap.id, name: "Swap" }]);
    expect(gens.assetUses(board.asset.id, { exceptGeneration: board.g.id })).toEqual([{ what: "account canvas", key: canvas.id, name: "Board" }]);
    lib.trashGenerations([short.g.id, character.g.id, board.g.id]);
    expect(await lib.emptyTrash()).toBeGreaterThanOrEqual(3);
    for (const f of [short, character, board]) expect(fs.existsSync(fileOf(f.asset.url))).toBe(true);
    // Uploads → Delete says where it's used, and keeps it.
    const r = await assetIdRoutes.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: short.asset.id }) } as never);
    expect(r.status).toBe(409);
    expect((await r.json()).usedBy).toBe("the account project “Launch short”");
    // Without the project or board, nothing keeps them.
    projects.deleteAccountProjects("acct-keep");
    canvases.deleteAccountCanvases("acct-keep");
    for (const f of [short, character, board]) expect(gens.assetUses(f.asset.id)).toEqual([]);
  });

  it("never lets an account's board or project keep the owner's or another account's file", async () => {
    // The owner's upload, named by a stranger's board (a board takes any /api/files/ link; the file route checks it on read).
    const upload = saveFile({ data: Buffer.concat([PNG, Buffer.from("owner upload")]), contentType: "image/png", source: "upload" });
    // Another account's result, named in a stranger's project free text (a Cinema brief) and on its board.
    const theirs = made("another account's result");
    db().prepare("UPDATE assets SET account_id = 'acct-other' WHERE id = ?").run(theirs.asset.id);
    const page = (url: string) => ({ id: "p1", name: "Page 1", graph: { nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 }, data: { url } }], edges: [] } });
    canvases.createAccountCanvas("acct-stranger", { name: "anything I like", pages: [page(upload.url), page(theirs.asset.url)] as never });
    projects.createAccountProject("acct-stranger", "cinema", { name: "Brief", data: { brief: { body: `see ${upload.id} and ${theirs.asset.id}` } }, summary: { cover: theirs.asset.url } });
    expect(gens.assetUses(upload.id)).toEqual([]);
    expect(gens.assetUses(theirs.asset.id, { exceptGeneration: theirs.g.id })).toEqual([]);
    // Uploads → Delete works for the owner, and Delete forever removes the other account's file.
    const r = await assetIdRoutes.DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: upload.id }) } as never);
    expect(r.status).toBe(204);
    await lib.deleteForever([theirs.g.id]);
    expect(fs.existsSync(fileOf(theirs.asset.url))).toBe(false);
    projects.deleteAccountProjects("acct-stranger");
    canvases.deleteAccountCanvases("acct-stranger");
  });

  it("covers every column that can hold a file, and every entry's query runs", () => {
    // account_projects is made the first time it's used.
    projects.listAccountProjects("nobody", "shorts");
    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const columns = new Map(tables.map((t) => [t, (db().prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)]));
    const covered = new Set(gens.ASSET_REFS.flatMap((r) => r.cols.map((c) => `${r.table}.${c}`)));
    const missing: string[] = [];
    for (const [t, cols] of columns) {
      for (const c of cols) {
        const key = `${t}.${c}`;
        if (/(_json|_url|^url|_file)$/.test(c) && !covered.has(key) && !(key in gens.ASSET_FREE)) missing.push(key);
      }
    }
    // A table that stores file URLs must be in ASSET_REFS (or in ASSET_FREE with the reason it never holds one).
    expect(missing).toEqual([]);
    for (const key of [...covered, ...Object.keys(gens.ASSET_FREE)]) {
      const [t, c] = key.split(".");
      expect(columns.get(t), `${key} is not a column`).toContain(c);
    }
    // assetUses skips a table whose query fails (an older install), so a typo here would go unnoticed: prepare each one.
    for (const r of gens.ASSET_REFS) expect(() => db().prepare(gens.assetRefSql(r)).all({ id: "nothing-uses-this", g: "", max: 1 }), r.table).not.toThrow();
    expect(gens.ASSET_REFS.map((r) => r.table)).toEqual(expect.arrayContaining(["dub_sessions", "katana_jobs", "assist_project_sources", "layer_projects", "faceless_episodes"]));
  });
});
