import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

const dir = tempDir("fuobe-glb-safety-");
process.env.FUOBE_DATA_DIR = path.join(dir, "data");
process.env.FUOBE_TEST_SECRET = "do-not-pass-this-on";
const { ACCOUNT_TURNTABLE, finishModel, pendingTurntable, scriptEnv } = await import("@/server/model3d-finish");
const { saveFile } = await import("@/server/storage");
const { asAccount, createGenerations } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { withRunStamp } = await import("@/server/run-stamp");
const { OWN_GPU_TOOL_MESSAGE } = await import("@/lib/guest-access");
afterAll(() => {
  delete process.env.FUOBE_TEST_SECRET;
});

const SCRIPT = path.join(process.cwd(), "scripts", "model3d", "finish-glb.mjs");
const MARKER = "FAKE_SECRET_MARKER_0123456789";

/** A one-triangle GLB; `image` adds an image (and a texture using it) with that URI. */
function glb(image?: string): Buffer {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(image && { material: 0 }) }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...(image && {
      images: [{ uri: image, mimeType: "image/png" }],
      textures: [{ source: 0 }],
      materials: [{ emissiveTexture: { index: 0 }, emissiveFactor: [1, 1, 1] }],
    }),
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, bin]);
}

const run = (input: string, output: string, ...extra: string[]) => spawnSync(process.execPath, [SCRIPT, "--in", input, "--out", output, ...extra], { encoding: "utf8", timeout: 60_000, cwd: dir });

describe("the 3D finish reads only the model it was given", () => {
  it("refuses a GLB whose image points at another file, and never reads it", () => {
    const work = fs.mkdtempSync(path.join(dir, "job-"));
    fs.writeFileSync(path.join(dir, "marker.txt"), MARKER);
    const raw = path.join(work, "raw.glb");
    const out = path.join(work, "web.glb");
    fs.writeFileSync(raw, glb("../marker.txt"));
    const r = run(raw, out);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/external file reference/);
    expect(fs.existsSync(out)).toBe(false);
    expect(r.stdout).not.toContain(MARKER);
  });

  it("refuses a .gltf (JSON) model and anything that isn't a binary glTF 2", () => {
    const work = fs.mkdtempSync(path.join(dir, "job-"));
    const gltf = path.join(work, "model.gltf");
    fs.writeFileSync(gltf, JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "../marker.txt", byteLength: 10 }] }));
    const r = run(gltf, path.join(work, "web.glb"));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/not a binary glTF 2/);
  });

  it("finishes a self-contained GLB as before", () => {
    const work = fs.mkdtempSync(path.join(dir, "job-"));
    const raw = path.join(work, "raw.glb");
    const out = path.join(work, "web.glb");
    fs.writeFileSync(raw, glb());
    const r = run(raw, out);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("refuses an account's model with a texture over 4096 x 4096 before decoding it", async () => {
    const sharp = (await import("sharp")).default;
    const big = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "#808080" } }).png({ compressionLevel: 9 }).toBuffer();
    const work = fs.mkdtempSync(path.join(dir, "job-"));
    const raw = path.join(work, "raw.glb");
    fs.writeFileSync(raw, glb(`data:image/png;base64,${big.toString("base64")}`));
    const r = run(raw, path.join(work, "web.glb"), "--limits", "account");
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/texture over 4096 x 4096/);
    // The owner's model with the same texture is finished as before.
    const own = run(raw, path.join(work, "own.glb"));
    expect(own.status, own.stderr).toBe(0);
  }, 60_000);

  it("runs the scripts with a short environment, never the server's secrets", () => {
    const env = scriptEnv();
    expect(env.FUOBE_TEST_SECRET).toBeUndefined();
    expect(Object.values(env)).not.toContain("do-not-pass-this-on");
    expect(env.FUOBE_PARENT_PIPE).toBe("1");
    expect(Object.keys(env).every((k) => /^(PATH|Path|SYSTEMROOT|SystemRoot|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|FFMPEG_PATH|CHROMIUM_PATH|FUOBE_CHROMIUM|PLAYWRIGHT_BROWSERS_PATH|FUOBE_PARENT_PIPE)$/.test(k))).toBe(true);
  });

  it("gives an account's model its web GLB but no server turntable", async () => {
    const asset = saveFile({ data: glb(), contentType: "model/gltf-binary", source: "generation", accountId: "acct-3d" });
    const outputs = [{ url: asset.url, kind: "model3d" as const, contentType: "model/gltf-binary", assetId: asset.id }];
    const done = await finishModel("gen-3d", outputs, { op: "image-to-3d", provider: "comfyui", account: "acct-3d" });
    const finish = done[0].meta?.finish as { turntable?: string; webAsset?: string; error?: string };
    expect(finish.error).toBeUndefined();
    expect(finish.webAsset).toBeTruthy();
    expect(finish.turntable).toBe(ACCOUNT_TURNTABLE);
    expect(pendingTurntable(done)).toBe(-1);
    // The owner's model still queues one.
    const own = saveFile({ data: glb(), contentType: "model/gltf-binary", source: "generation" });
    const mine = await finishModel("gen-3d-owner", [{ url: own.url, kind: "model3d", contentType: "model/gltf-binary", assetId: own.id }], { op: "image-to-3d", provider: "comfyui" });
    expect(pendingTurntable(mine)).toBe(0);
  }, 60_000);
});

describe("an account's 3D model runs on its own GPU or key, never on this install's GPUs", () => {
  const photo = () => saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload", accountId: "acct-1" }).url;
  const request = (extra: Record<string, unknown> = {}) =>
    ({ feature: "image-to-3d", modelId: "oss-pixal3d", op: "image-to-3d", prompt: "", inputs: { images: [photo()] }, engine: "open", ...extra }) as Parameters<typeof createGenerations>[0];

  it("makes an account's Image to 3D run on its own placement", () => {
    const made = asAccount("acct-1", () => createGenerations(request()));
    expect(made).toHaveLength(1);
    expect(made[0].kind).toBe("model3d");
    expect(made[0].request.account).toBe("acct-1");
    expect(made[0].request.place).toBeUndefined();
  });

  it("refuses the same run on this install's GPUs (the pool's stamp) before anything is queued", () => {
    const rows = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const before = rows();
    expect(() => asAccount("acct-1", () => withRunStamp({ place: "pool" }, () => createGenerations(request())))).toThrow(OWN_GPU_TOOL_MESSAGE);
    expect(rows()).toBe(before);
  });

  it("a place sent in the request changes nothing: it is stripped, and only the stamp counts", () => {
    for (const place of ["pool", "own"]) {
      const made = asAccount("acct-1", () => createGenerations(request({ place })));
      expect(made[0].request.place, place).toBeUndefined();
    }
    expect(() => asAccount("acct-1", () => withRunStamp({ place: "pool" }, () => createGenerations(request({ place: "own" }))))).toThrow(OWN_GPU_TOOL_MESSAGE);
  });
});
