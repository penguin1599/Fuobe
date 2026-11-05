import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { forwardOf, type FlyPose } from "@/lib/scene3d";
import {
  EMPTY_SCENE,
  MAX_PROPS,
  PROP_SIZE,
  bringToCamera,
  parseSceneState,
  placeProp,
  propCandidate,
  propMakerBlocker,
  sceneStateKey,
  serializeSceneState,
  sizeRange,
  turnOver,
  wrapDeg,
  type SceneProp,
} from "@/lib/scene-props";

/**
 * Props in Cinema's 3D scene (idol-9): which Library results can be placed, where a new prop lands and how it faces
 * the camera, the scene state's round trip through this browser's storage, the transforms, and who may make one from
 * a picture. The pixel check (a path render shows the prop) is in tests/e2e/cinema-props.mjs.
 */

const gen = (over: Partial<Generation> & { outputs: Generation["outputs"] }): Pick<Generation, "id" | "status" | "outputs" | "request"> => ({
  id: "g1",
  status: "succeeded",
  request: { feature: "image-to-3d", modelId: "oss-idol", op: "splat", inputs: { images: ["/api/files/uploads/cup.png"] } },
  ...over,
});

const START: FlyPose = { position: [0, 0, 0], yaw: 0, pitch: 0 };
const close = (a: number[], b: number[], eps = 1e-3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], -Math.log10(eps)));

describe("what can be placed", () => {
  it("a finished splat result from either engine (Idol 3D's .spz, cloud TripoSplat's .ply), with its still", () => {
    const idol = propCandidate(
      gen({
        outputs: [
          { url: "/api/files/g1/splat.spz", kind: "model3d", meta: { format: "spz", role: "splat" } },
          { url: "/api/files/g1/orbit.mp4", kind: "video", meta: { role: "turntable" } },
          { url: "/api/files/g1/seen.png", kind: "image", meta: { role: "preview" } },
        ],
      }),
    );
    expect(idol).toEqual({ url: "/api/files/g1/splat.spz", format: "spz", generationId: "g1", modelId: "oss-idol", poster: "/api/files/g1/seen.png" });
    const tripo = propCandidate(gen({ id: "g2", request: { feature: "image-to-3d", modelId: "triposplat", op: "splat" }, outputs: [{ url: "/api/files/g2/model.ply", kind: "model3d" }] }));
    expect(tripo).toMatchObject({ url: "/api/files/g2/model.ply", format: "ply", modelId: "triposplat" });
  });

  it("not a GLB, an unfinished run or a failed one", () => {
    expect(propCandidate(gen({ outputs: [{ url: "/api/files/g1/model.glb", kind: "model3d", meta: { format: "glb" } }] }))).toBeNull();
    expect(propCandidate(gen({ status: "running", outputs: [] }))).toBeNull();
    expect(propCandidate(gen({ status: "failed", outputs: [{ url: "/api/files/g1/splat.spz", kind: "model3d" }] }))).toBeNull();
  });
});

describe("placing a prop", () => {
  const c = { url: "/api/files/g1/splat.spz", format: "spz", generationId: "g1", modelId: "oss-idol", name: "Idol 3D" };

  it("lands ahead of the camera, a little before the subject, sized to the scene and facing the camera", () => {
    const p = placeProp(c, START, 4, 0, "a");
    close(p.position, [0, 0, -2.8]);
    expect(p.size).toBeCloseTo(4 * PROP_SIZE.start);
    expect(p.rotation).toEqual([0, 0, 0]);
    // Idol 3D starts with its faint haze hidden (idol-4's 0.05); TripoSplat draws everything.
    expect(p.cutoff).toBe(0.05);
    expect(placeProp({ ...c, modelId: "triposplat" }, START, 4, 0, "b").cutoff).toBe(0);
  });

  it("follows the camera's turn: its front (+z) points back at the camera, level whatever the pitch", () => {
    const pose: FlyPose = { position: [1, 0.5, 2], yaw: Math.PI / 2, pitch: 0.4 };
    const p = placeProp(c, pose, 2, 0, "a");
    close(p.position, [1 + forwardOf(pose.yaw, 0)[0] * 1.4, 0.5, 2 + forwardOf(pose.yaw, 0)[2] * 1.4]);
    expect(p.rotation[1]).toBe(90);
    // The prop's +z after a 90° yaw is +x, from the prop towards the camera.
    const front = [Math.sin(Math.PI / 2), 0, Math.cos(Math.PI / 2)];
    const toCamera = [pose.position[0] - p.position[0], 0, pose.position[2] - p.position[2]];
    expect(front[0] * toCamera[0] + front[2] * toCamera[2]).toBeGreaterThan(0);
  });

  it("puts a second and third prop to either side, not on top of the first", () => {
    const xs = [0, 1, 2].map((n) => placeProp(c, START, 4, n, `p${n}`).position[0]);
    expect(new Set(xs).size).toBe(3);
    expect(xs[1] * xs[2]).toBeLessThan(0);
  });

  it("brings a prop back in front of the camera, keeping its size and tilt", () => {
    const p: SceneProp = { ...placeProp(c, START, 4, 0, "a"), position: [9, 9, 9], rotation: [180, 10, 5], size: 0.5 };
    const back = bringToCamera(p, { position: [0, 0, 0], yaw: Math.PI, pitch: 0 }, 4);
    close(back.position, [0, 0, 2.8]);
    expect(back.rotation).toEqual([180, 180, 5]);
    expect(back.size).toBe(0.5);
  });

  it("turns over about its own x, and keeps degrees within -180…180", () => {
    const p = placeProp(c, START, 4, 0, "a");
    expect(turnOver(p).rotation).toEqual([180, 0, 0]);
    expect(turnOver(turnOver(p)).rotation).toEqual([0, 0, 0]);
    expect([wrapDeg(190), wrapDeg(-190), wrapDeg(540), wrapDeg(-180), wrapDeg(-0)]).toEqual([-170, 170, 180, 180, 0]);
  });

  it("sizes within 2% to 4× the subject distance", () => {
    expect(sizeRange(5)).toEqual({ min: 5 * PROP_SIZE.min, max: 5 * PROP_SIZE.max });
  });
});

describe("the scene state round trip", () => {
  const c = { url: "/api/files/g1/splat.spz", format: "spz", generationId: "g1", modelId: "oss-idol", name: "Idol 3D", poster: "/api/files/g1/seen.png" };

  it("keeps a moved, turned and sized prop exactly", () => {
    const moved: SceneProp = { ...placeProp(c, START, 3, 0, "a"), position: [0.25, -0.4, -1.75], rotation: [180, -35.5, 12], size: 0.42, cutoff: 0.12 };
    const state = { version: 1 as const, props: [moved, placeProp({ ...c, url: "/api/files/g2/model.ply", format: "ply", modelId: "triposplat", name: "TripoSplat" }, START, 3, 1, "b")] };
    const back = parseSceneState(serializeSceneState(state));
    expect(back).toEqual(state);
    expect(sceneStateKey("gen-1")).toBe("fuobe.cinema.scene.gen-1");
  });

  it("drops what isn't a well-formed prop and never throws", () => {
    expect(parseSceneState(null)).toEqual(EMPTY_SCENE);
    expect(parseSceneState("{not json")).toEqual(EMPTY_SCENE);
    expect(parseSceneState(JSON.stringify({ props: "x" }))).toEqual(EMPTY_SCENE);
    const good = placeProp(c, START, 3, 0, "ok");
    const bad = [
      { ...good, id: "" },
      { ...good, id: "u", url: "javascript:alert(1)" },
      { ...good, id: "pr", url: "//elsewhere.example/x.spz" },
      { ...good, id: "f", format: "glb" },
      { ...good, id: "n", position: [0, Number.NaN, 0] },
      { ...good, id: "s", size: -1 },
      { ...good, id: "r", rotation: [0, 0] },
      "a string",
      null,
    ];
    const back = parseSceneState(JSON.stringify({ version: 1, props: [...bad, good, { ...good }] }));
    expect(back.props.map((p) => p.id)).toEqual(["ok"]);
  });

  it("keeps cut-offs in the slider's range, angles wrapped, and at most MAX_PROPS", () => {
    const p = placeProp(c, START, 3, 0, "a");
    const back = parseSceneState(JSON.stringify({ props: [{ ...p, cutoff: 2, rotation: [0, 270, -540] }] }));
    expect(back.props[0].cutoff).toBe(0.3);
    expect(back.props[0].rotation).toEqual([0, -90, 180]);
    const many = Array.from({ length: MAX_PROPS + 3 }, (_, i) => ({ ...p, id: `p${i}` }));
    expect(parseSceneState(JSON.stringify({ props: many })).props).toHaveLength(MAX_PROPS);
    expect(JSON.parse(serializeSceneState({ version: 1, props: many })).props).toHaveLength(MAX_PROPS);
  });
});

describe("making a prop from a picture (Idol 3D on your GPU only)", () => {
  const owner = { engineMode: "both", demoMode: "off", providers: { comfyui: { configured: true } }, idolOn: true };

  it("runs for the owner with a GPU connected, or with placeholder results on", () => {
    expect(propMakerBlocker(owner)).toBeNull();
    expect(propMakerBlocker({ ...owner, providers: {}, demoMode: "on" })).toBeNull();
    expect(propMakerBlocker({ ...owner, providers: {}, ownerGpu: { device: "x" } })).toBeNull();
  });

  it("opens to a visitor, on its own GPU (the press sets it up), whatever the owner's GPU", () => {
    expect(propMakerBlocker({ ...owner, viewer: { kind: "account" } })).toBeNull();
    expect(propMakerBlocker({ ...owner, viewer: { kind: "guest" }, providers: {} })).toBeNull();
    const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
    expect(read("src/components/cinema/scene-props.tsx")).toContain("press(PROP_SETUP, make)");
  });

  it("says why not otherwise: Paid APIs only, Idol 3D switched off, no GPU", () => {
    expect(propMakerBlocker({ ...owner, engineMode: "cloud" })).toMatch(/your GPU \(open source\), which Paid APIs only leaves out/);
    expect(propMakerBlocker({ ...owner, idolOn: false })).toMatch(/turned off in Settings → Models & licences/);
    expect(propMakerBlocker({ ...owner, providers: {} })).toMatch(/Connect ComfyUI in Settings/);
    // Visitor copy names no files, codes or engines' internals, and no refusal.
    const visitor = propMakerBlocker({ ...owner, viewer: { kind: "account" }, idolOn: false })!;
    expect(visitor).not.toMatch(/ComfyUI|GPU|Idol|owner|install|isn't available/i);
  });
});

describe("the scene draws props in its own render", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

  it("the path render sorts the splats for each frame before drawing it, and the handle never reaches a render", () => {
    const engine = read("src/components/cinema/scene-engine.ts");
    const record = engine.slice(engine.indexOf("async recordPath("));
    expect(record).toMatch(/await this\.splats\.settle\(this\.scene, this\.camera\)/);
    // The handle is drawn only on screen (out === null) and never for a shot.
    expect(engine).toMatch(/if \(!out && !shot && this\.gizmo\?\.object\)/);
  });

  it("reads frames with no pixel-pack buffer bound (Spark's async sort readback leaves one: frame 0 came out black)", () => {
    const engine = read("src/components/cinema/scene-engine.ts");
    expect(engine).toMatch(/gl\.bindBuffer\(gl\.PIXEL_PACK_BUFFER, null\);\r?\n\s+this\.renderer\.readRenderTargetPixels/);
    expect(engine.match(/this\.renderer\.readRenderTargetPixels\(/g)).toHaveLength(1);
  });

  it("props write depth, so the post pass doesn't take them for holes (Uni3C's transparent black)", () => {
    expect(read("src/components/model3d/splat-engine.ts")).toMatch(/new SparkRenderer\(\{ renderer, onDirty, depthWrite: true/);
  });

  it("doesn't draw the screen while a path records, so every path frame keeps its own camera's sort", () => {
    const engine = read("src/components/cinema/scene-engine.ts");
    // step() draws only when not recording (a screen draw would start a sort for the on-screen camera mid-frame).
    expect(engine).toMatch(/if \(this\.dirty && this\.view && this\.info && !this\.recording\)/);
    const record = engine.slice(engine.indexOf("async recordPath("), engine.indexOf("dispose() {"));
    expect(record).toMatch(/this\.recording = true;/);
    // ...and gives the screen back however the recording ends.
    expect(record.slice(record.indexOf("} finally {"))).toMatch(/this\.recording = false;/);
  });

  it("makes no Spark renderer for a viewer that closed while Spark was loading", () => {
    const engine = read("src/components/cinema/scene-engine.ts");
    const add = engine.slice(engine.indexOf("async addProp("), engine.indexOf("updateProp(p: SceneProp)"));
    expect(add.indexOf("if (this.disposed)")).toBeGreaterThan(-1);
    expect(add.indexOf("if (this.disposed)")).toBeLessThan(add.indexOf("new SceneSplats("));
  });

  it("a prop made from a picture says so when it couldn't go in the scene, and props being made count towards the most", () => {
    const viewer = read("src/components/cinema/scene-viewer.tsx");
    const made = viewer.slice(viewer.indexOf("const madeProp"), viewer.indexOf("const changeProp"));
    expect(made).toMatch(/if \(placed === "placed"\) toast\.success\("Your prop is in the scene"\)/);
    expect(made).toMatch(/placed === "full"/);
    expect(viewer).toMatch(/full=\{props\.length \+ making\.length >= MAX_PROPS\}/);
    // A new scene opened in place starts from its own props.
    expect(read("src/components/cinema/workspace.tsx")).toMatch(/<SceneViewer\s+key=\{openScene\.generation\.id\}/);
  });

  it("the Make the prop button shows no price until the preview has one", () => {
    const ui = read("src/components/cinema/scene-props.tsx");
    expect(ui).not.toMatch(/priceLine\(preview\.data\) \?\? "Free"/);
    expect(ui).toMatch(/Make the prop\{price \? ` · \$\{price\}` : ""\}/);
  });
});
