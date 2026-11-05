import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherInventory, OBJECT_INFO_MAX_BYTES } from "@/lib/gpu/gather";
import { TopLevelScanner, comboOptions } from "@/lib/gpu/json-scan";
import { filePresence, toolReadiness } from "@/lib/gpu/readiness";
import { parseIndex } from "@/lib/gpu/requirements";
import { fetchTransport, TransportError } from "@/lib/gpu/transport";
import type { CheckLine, RequirementIndex } from "@/lib/gpu/types";
import { startFakeComfy, type FakeComfy, type FakeScenario } from "./helpers/fake-comfy";

vi.setConfig({ testTimeout: 30_000 });

const idx: RequirementIndex = parseIndex(JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui/requirements.json"), "utf8")));
const zImage = idx.workflows["z-image-turbo-t2i"];

/** A ComfyUI that has everything Z-Image Turbo's text-to-image graph needs. */
function zImageReady(extra: Partial<FakeScenario> = {}): FakeScenario {
  const files: Record<string, { name: string; size: number }[]> = {};
  const combos: Record<string, Record<string, string[]>> = {};
  for (const k of zImage.files) {
    const f = idx.files[k];
    (files[f.folder] ??= []).push({ name: f.file, size: f.sizeBytes });
    for (const [cls, input] of f.loaders ?? []) ((combos[cls] ??= {})[input] ??= []).push(f.file);
  }
  return { classes: [...zImage.core], files, combos, folders: idx.folders.filter((f) => !["mmaudio", "foley", "thinksound", "insightface", "facerestore_models"].includes(f)), ...extra };
}

let fake: FakeComfy | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const transport = (url: string, headers: Record<string, string> = {}) => fetchTransport("server", url, (u, init) => fetch(u, init), { headers, decodes: false });

describe("the probe", () => {
  it("reads a ready ComfyUI and says so line by line", async () => {
    fake = await startFakeComfy(zImageReady({ manager: { api: "v4", installed: {} }, argv: ["main.py", "--enable-manager"] }));
    const lines: CheckLine[] = [];
    const inv = await gatherInventory(transport(fake.url), idx, { onLine: (l) => lines.push(l) });
    expect(inv.reachable).toBe(true);
    expect(inv.comfy?.version).toBe("0.41.2");
    expect(inv.nodes.how).toBe("object_info");
    expect(inv.manager.api).toBe("v4");
    expect(inv.devices[0].vramTotal).toBe(12 * 2 ** 30);
    const t = toolReadiness("model:oss-z-image-turbo#t2i", "Z-Image Turbo", ["z-image-turbo-t2i"], [], inv, idx, { account: true });
    expect(t.state).toBe("ready");
    expect(lines.find((l) => l.step === "found" && l.state === "done")?.text).toMatch(/Found ComfyUI 0\.41\.2/);
    expect(lines.find((l) => l.step === "gpu")?.text).toBe("Graphics card: NVIDIA GeForce RTX 4070, 12 GB");
    expect(inv.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only reads (R8): GETs, plus the Manager's import-error lookup, never a prompt or an upload", async () => {
    const kj = idx.packs["ComfyUI-KJNodes"];
    fake = await startFakeComfy({
      ...zImageReady(),
      argv: ["main.py", "--enable-manager"],
      manager: { api: "v4", installed: { "comfyui-kjnodes": { cnr_id: "comfyui-kjnodes", ver: "1.0.0", enabled: true } }, importErrors: { "comfyui-kjnodes": "Traceback: No module named 'color_matcher'" } },
    });
    const inv = await gatherInventory(transport(fake.url), idx);
    expect(inv.packs["ComfyUI-KJNodes"]?.importError).toMatch(/color_matcher/);
    const posts = fake.requests.filter((r) => r.method !== "GET");
    expect(posts.map((r) => r.path)).toEqual(["/v2/customnode/import_fail_info_bulk"]);
    expect(JSON.parse(posts[0].body)).toEqual({ cnr_ids: [kj.registry!.id], urls: [] });
    expect(fake.requests.some((r) => /\/(prompt|upload|internal)/.test(r.path))).toBe(false);
  });

  it("falls back to one class at a time when /object_info is refused, and reads the /api prefix", async () => {
    fake = await startFakeComfy({ ...zImageReady(), apiPrefixOnly: true, objectInfoStatus: 500 });
    const inv = await gatherInventory(transport(fake.url), idx);
    expect(inv.comfy?.apiPrefix).toBe("/api");
    expect(inv.nodes.how).toBe("per-class");
    expect(fake.requests.some((r) => r.path.startsWith("/api/object_info/"))).toBe(true);
    // Loader classes are read one by one too, so files still count by their loader.
    const f = idx.files[zImage.files[0]];
    expect(filePresence(f, inv)).toBe("present");
  });

  it("cuts off a /object_info over the cap and still finishes", async () => {
    expect(OBJECT_INFO_MAX_BYTES).toBe(64 * 1024 * 1024);
    fake = await startFakeComfy({ ...zImageReady(), objectInfoPadBytes: 3 * 1024 * 1024 });
    const small = fetchTransport("server", fake.url, (u, init) => fetch(u, init));
    const res = await small.request("GET", "/object_info", { maxBytes: 1024 * 1024 });
    await expect(res.text()).rejects.toBeInstanceOf(TransportError);
  });

  it("stops a server that drips bytes at the deadline", async () => {
    fake = await startFakeComfy({ ...zImageReady(), drip: ["/object_info"] });
    const t0 = Date.now();
    const res = await transport(fake.url).request("GET", "/object_info", { timeoutMs: 800 });
    await expect(res.text()).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("refuses a compressed body it can't read with a cap", async () => {
    fake = await startFakeComfy({ ...zImageReady(), gzip: true });
    await expect(transport(fake.url).request("GET", "/system_stats")).rejects.toMatchObject({ kind: "encoding" });
  });

  it("tells a wrong key, a web page, a Cloudflare Access login and a dead link apart", async () => {
    fake = await startFakeComfy({ ...zImageReady(), auth: { header: "Authorization", value: "Bearer right" } });
    expect((await gatherInventory(transport(fake.url), idx)).problem).toBe("auth");
    const ok = await gatherInventory(transport(fake.url, { Authorization: "Bearer right" }), idx);
    expect(ok.reachable).toBe(true);
    await fake.close();
    fake = await startFakeComfy({ ...zImageReady(), html: true });
    expect((await gatherInventory(transport(fake.url), idx)).problem).toBe("not-comfy");
    await fake.close();
    fake = await startFakeComfy({ ...zImageReady(), redirect: "https://team.cloudflareaccess.com/cdn-cgi/access/login" });
    expect((await gatherInventory(transport(fake.url), idx)).problem).toBe("auth");
    await fake.close();
    fake = await startFakeComfy({ ...zImageReady(), redirect: "https://elsewhere.example/" });
    expect((await gatherInventory(transport(fake.url), idx)).problem).toBe("redirect");
    const port = fake.port;
    await fake.close();
    fake = null;
    expect((await gatherInventory(transport(`http://127.0.0.1:${port}`), idx, { statsTimeoutMs: 1500 })).problem).toBe("unreachable");
  });

  it("gives a partial snapshot when a step times out", async () => {
    fake = await startFakeComfy({ ...zImageReady(), slow: { "/models": 3000 } });
    const inv = await gatherInventory(transport(fake.url), idx, { budgetMs: 2000 });
    expect(inv.reachable).toBe(true);
    expect(inv.errors.some((e) => e.step === "models")).toBe(true);
    // What wasn't read isn't missing.
    const t = toolReadiness("model:oss-z-image-turbo#t2i", "Z-Image Turbo", ["z-image-turbo-t2i"], [], inv, idx, { account: true });
    expect(t.state).toBe("ready");
  });

  it("reads folder listings, plain ones on an older ComfyUI, and marks folders that aren't there", async () => {
    const s = zImageReady({ noExperiment: true, combos: {} });
    s.folders = s.folders!.filter((f) => f !== "loras");
    fake = await startFakeComfy(s);
    const inv = await gatherInventory(transport(fake.url), idx, { loraNames: ["some_style.safetensors"] });
    const f = idx.files[zImage.files[0]];
    expect(inv.models[f.folder].have[f.file]).toBeNull();
    expect(filePresence(f, inv)).toBe("present");
    expect(inv.models.loras?.folderMissing).toBe(true);
    expect(inv.models.mmaudio?.folderMissing).toBe(true);
  });

  it("finds a folder a pack lists in another case from its directory (ComfyUI-RMBG's models/RMBG as \"rmbg\")", async () => {
    const f = idx.files["RMBG/VRMBG-3.0/model.safetensors"];
    expect(f.folder).toBe("RMBG");
    const s = zImageReady();
    s.folders = [...s.folders!.filter((x) => x !== "RMBG"), "rmbg"];
    s.files = { ...s.files, rmbg: [{ name: f.file, size: f.sizeBytes }] };
    fake = await startFakeComfy(s);
    const inv = await gatherInventory(transport(fake.url), idx);
    expect(inv.models.RMBG?.folderMissing).toBeUndefined();
    expect(filePresence(f, inv)).toBe("present");
  });
});

describe("reading a big /object_info a piece at a time", () => {
  it("keeps the keys and the asked-for values only", () => {
    const body = JSON.stringify({ A: { input: { required: { x: [["one.safetensors", "two.safetensors"]] } } }, "B \"quoted\"": { n: [1, { "}": "{" }] }, C: 3 });
    const sc = new TopLevelScanner(new Set(["A", "C"]));
    for (let i = 0; i < body.length; i += 7) sc.push(body.slice(i, i + 7));
    expect(sc.done()).toBe(true);
    expect(sc.keys).toEqual(["A", 'B "quoted"', "C"]);
    expect(comboOptions(sc.captured.A, "x")).toEqual(["one.safetensors", "two.safetensors"]);
    expect(sc.captured.C).toBe(3);
    expect(sc.captured).not.toHaveProperty('B "quoted"');
  });

  it("reads both combo shapes", () => {
    expect(comboOptions({ input: { required: { m: ["COMBO", { options: ["a.gguf"] }] } } }, "m")).toEqual(["a.gguf"]);
    expect(comboOptions({ input: { optional: { m: [["b.pth"], {}] } } }, "m")).toEqual(["b.pth"]);
    expect(comboOptions({ input: { required: { m: ["STRING", {}] } } }, "m")).toBeNull();
  });
});
