import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { IDOL_MODELS, model3dView, splatFormatOf } from "@/lib/av/model3d";
import { FALLBACK_TEXT, hazeCutoffFor, SPLAT_MAX_BYTES, splatFallback, splatTooBig, stillFileName, viewerFor } from "@/lib/av/splat-view";

/**
 * Looking around splats (idol-4): which viewer a 3D output opens in, the haze cut-off each model starts with, when
 * the orbit video stays instead, the demo splats (parsed by Spark itself), and that only the splat viewer's
 * dynamic import brings Spark in.
 */

const samples = path.join(process.cwd(), "public", "samples");

describe("which viewer draws a 3D output", () => {
  it("a splat file goes to the splat viewer, a GLB to model-viewer", () => {
    expect(viewerFor({ url: "/api/files/g/a.spz", kind: "model3d" })).toBe("splat");
    expect(viewerFor({ url: "https://fal.test/x/splat.ply?sig=1", kind: "model3d" })).toBe("splat");
    expect(viewerFor({ url: "/api/files/g/a.bin", kind: "model3d", meta: { format: "ksplat" } })).toBe("splat");
    expect(viewerFor({ url: "/api/files/g/a.glb", kind: "model3d" })).toBe("glb");
    // The demo GLB marked as a splat (older demo results) stays a GLB.
    expect(viewerFor({ url: "sample:demo-model.glb", kind: "model3d", meta: { format: "glb", splat: true } })).toBe("glb");
    expect(viewerFor({ url: "/api/files/g/a.png", kind: "image" })).toBeUndefined();
    expect(viewerFor(undefined)).toBeUndefined();
  });

  it("the demo splats read as splats on the card", () => {
    expect(splatFormatOf({ url: "/api/files/outputs/x.spz", meta: { format: "spz" } })).toBe("spz");
    const view = model3dView({
      outputs: [
        { url: "/api/files/g/demo.spz", kind: "model3d", meta: { demo: true, format: "spz", role: "splat" } },
        { url: "/api/files/g/orbit.mp4", kind: "video", meta: { turntable: true } },
      ],
      request: { feature: "image-to-3d", modelId: "oss-triposplat", op: "splat" },
    } as never);
    expect(view).toMatchObject({ glb: undefined, splat: { url: "/api/files/g/demo.spz", format: "spz" }, turntable: "/api/files/g/orbit.mp4" });
  });
});

describe("the haze cut-off a result starts with", () => {
  it("Idol 3D hides Gaussians under 0.05 on both engines; TripoSplat and others draw them all", () => {
    expect(hazeCutoffFor(IDOL_MODELS.open)).toBe(0.05);
    expect(hazeCutoffFor(IDOL_MODELS.cloud)).toBe(0.05);
    expect(hazeCutoffFor("oss-triposplat")).toBe(0);
    expect(hazeCutoffFor("triposplat")).toBe(0);
    expect(hazeCutoffFor(undefined)).toBe(0);
  });
});

describe("when the orbit video stays instead of the viewer", () => {
  it("no WebGL2, a file too big for the device, reduced motion until asked", () => {
    expect(splatFallback({ webgl2: true, coarse: false, reducedMotion: false })).toBeNull();
    expect(splatFallback({ webgl2: false, coarse: false, reducedMotion: false })).toBe("no-webgl2");
    expect(splatFallback({ webgl2: true, coarse: true, reducedMotion: false, bytes: SPLAT_MAX_BYTES.coarse + 1 })).toBe("too-big");
    expect(splatFallback({ webgl2: true, coarse: false, reducedMotion: false, bytes: SPLAT_MAX_BYTES.coarse + 1 })).toBeNull();
    expect(splatFallback({ webgl2: true, coarse: false, reducedMotion: true })).toBe("reduced-motion");
    expect(splatFallback({ webgl2: true, coarse: false, reducedMotion: true, asked: true })).toBeNull();
    expect(FALLBACK_TEXT["no-webgl2"]).toMatch(/Download/);
  });

  it("a 262,144-Gaussian .ply opens on a phone; a 1,048,576-Gaussian one only on a computer", () => {
    const ply = (n: number) => n * 68 + 1000;
    expect(splatTooBig(ply(262_144), true)).toBe(false);
    expect(splatTooBig(ply(1_048_576), true)).toBe(true);
    expect(splatTooBig(ply(1_048_576), false)).toBe(false);
    expect(splatTooBig(undefined, true)).toBe(false);
  });

  it("a still is saved under the model's name", () => {
    expect(stillFileName("Idol 3D")).toBe("Idol 3D still.png");
    expect(stillFileName("<>")).toBe("splat still.png");
  });
});

describe("the demo splats", () => {
  const ply = fs.readFileSync(path.join(samples, "demo-splat.ply"));
  const spz = fs.readFileSync(path.join(samples, "demo-splat.spz"));

  it("are a standard 3DGS .ply (17 floats per Gaussian, as Idol writes) and a gzipped .spz v2", () => {
    const header = ply.subarray(0, ply.indexOf("end_header\n") + 11).toString("ascii");
    expect(header).toMatch(/^ply\nformat binary_little_endian 1\.0\nelement vertex 4096\n/);
    expect(header.match(/^property float /gm)).toHaveLength(17);
    expect(ply.length).toBe(header.length + 4096 * 17 * 4);
    const raw = zlib.gunzipSync(spz);
    expect(raw.readUInt32LE(0)).toBe(0x5053474e);
    expect(raw.readUInt32LE(4)).toBe(2);
    expect(raw.readUInt32LE(8)).toBe(4096);
    // Small enough for the repo: under 300 KB and 60 KB.
    expect(ply.length).toBeLessThan(300_000);
    expect(spz.length).toBeLessThan(60_000);
  });

  it("Spark reads both, and a 0.05 cut-off leaves the 2,816 solid Gaussians of 4,096", async () => {
    const spark = await import("@sparkjsdev/spark");
    expect(spark.getSplatFileType(new Uint8Array(ply))).toBe("ply");
    expect(spark.getSplatFileType(new Uint8Array(spz))).toBe("spz");
    for (const [bytes, fileType] of [
      [ply, spark.SplatFileType.PLY],
      [spz, spark.SplatFileType.SPZ],
    ] as const) {
      for (const [threshold, count] of [
        [undefined, 4096],
        [0.05, 2816],
      ] as const) {
        const { fileBytes } = await spark.transcodeSpz({ inputs: [{ fileBytes: new Uint8Array(bytes), fileType }], opacityThreshold: threshold });
        expect(zlib.gunzipSync(Buffer.from(fileBytes)).readUInt32LE(8), `${fileType} ${threshold}`).toBe(count);
      }
    }
  }, 30_000);
});

describe("Spark loads only with the splat viewer", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []));
  const src = files(path.join(process.cwd(), "src"));

  it("only splat-engine.ts imports it, and only through a dynamic import", () => {
    const importers = src.filter((f) => fs.readFileSync(f, "utf8").includes("@sparkjsdev/spark"));
    expect(importers.map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"))).toEqual(["src/components/model3d/splat-engine.ts"]);
    const engineUsers = src.filter((f) => /["']\.\/splat-engine["']|model3d\/splat-engine["']/.test(fs.readFileSync(f, "utf8")));
    for (const f of engineUsers) {
      const text = fs.readFileSync(f, "utf8");
      // Type imports vanish from the bundle; anything else must be import("./splat-engine").
      expect(text.replace(/import type [^;]+;/g, "").replace(/import\("(\.\/|\.\.\/model3d\/)splat-engine"\)/g, ""), path.relative(process.cwd(), f)).not.toMatch(/splat-engine/);
    }
    // The splat viewer, and Cinema's 3D scene for its props (idol-9; itself loaded only when a scene opens).
    expect(engineUsers.map((f) => path.relative(process.cwd(), f).split(path.sep).join("/")).sort()).toEqual(["src/components/cinema/scene-engine.ts", "src/components/model3d/splat-viewer.tsx"]);
  });
});

describe("the viewer leaves the page as it found it", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

  it("gives its WebGL context back when it closes, and falls back when the browser takes it", () => {
    const engine = read("src/components/model3d/splat-engine.ts");
    const dispose = engine.slice(engine.indexOf("  dispose() {"));
    expect(dispose.slice(0, dispose.indexOf("\n  }\n"))).toMatch(/this\.renderer\.forceContextLoss\(\)/);
    expect(engine).toMatch(/addEventListener\("webglcontextlost"/);
  });

  it("the full-screen panel takes focus only when the user chose 'Look around in 3D', so the arrow keys keep browsing", () => {
    const panel = read("src/components/studio/result-media.tsx");
    const tag = panel.match(/<SplatViewer[^>]*\/>/)![0];
    expect(tag).toMatch(/autoFocus=\{asked\}/);
    // A dialog that focuses the stage on opening doesn't hand it ArrowLeft / ArrowRight (tests/e2e/splat-viewer.mjs checks it in a browser).
    const viewer = read("src/components/model3d/splat-viewer.tsx");
    expect(viewer).toMatch(/if \(!engaged\.current && \(e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"\)\) return;/);
  });
});
