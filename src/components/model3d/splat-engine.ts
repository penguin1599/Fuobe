"use client";

import { dyno, SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * The splat viewer's three.js side (idol-4): Spark (@sparkjsdev/spark 2.3.1, MIT, World Labs) draws the Gaussians
 * inside a plain three.js scene with OrbitControls. Loaded only through a dynamic import from splat-viewer.tsx, so
 * no page pays for it until a splat opens. It renders on demand (a drag, a slider, Spark's sort finishing), not in
 * a loop, so an idle viewer costs nothing.
 */

const FILE_TYPES: Record<string, SplatFileType> = { ply: SplatFileType.PLY, spz: SplatFileType.SPZ, ksplat: SplatFileType.KSPLAT, splat: SplatFileType.SPLAT };

export interface SplatLoadInfo {
  splats: number;
  bytes: number;
}

export class SplatEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private controls: OrbitControls;
  private spark: SparkRenderer;
  private mesh: SplatMesh | null = null;
  private cutoff = dyno.dynoFloat(0);
  private home = { position: new THREE.Vector3(0, 0, 3), target: new THREE.Vector3() };
  private frame = 0;
  /** Keep drawing until then (performance.now()): Spark builds, sorts and uploads over a few frames after a change. */
  private until = 0;
  private disposed = false;
  /** The last frame's CPU time in milliseconds (renderer.render), for the numbers in docs/research/idol-9.md. */
  lastFrameMs = 0;

  private onLost = (e: Event) => {
    e.preventDefault();
    if (!this.disposed) this.onContextLost?.();
  };

  /** onContextLost: the browser took the WebGL context away (too many open, a GPU reset) while this was showing. */
  constructor(
    private canvas: HTMLCanvasElement,
    private onContextLost?: () => void,
  ) {
    canvas.addEventListener("webglcontextlost", this.onLost);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: () => this.requestRender() });
    this.scene.add(this.spark);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = false;
    this.controls.addEventListener("change", () => this.requestRender());
  }

  /** Fetch the file (abortable, its size checked against maxBytes first), then build the splat. */
  async load(url: string, format: string, { signal, maxBytes, onProgress }: { signal?: AbortSignal; maxBytes?: number; onProgress?: (p: number) => void } = {}): Promise<SplatLoadInfo> {
    const bytes = await fetchSplat(url, { signal, maxBytes, onProgress });
    if (this.disposed || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const mesh = await buildSplatMesh(bytes, format, this.cutoff);
    if (this.disposed || signal?.aborted) {
      mesh.dispose();
      throw new DOMException("Aborted", "AbortError");
    }
    this.mesh = mesh;
    this.scene.add(mesh);
    this.frameObject(mesh.getBoundingBox(true));
    this.requestRender(1500);
    return { splats: mesh.packedSplats?.numSplats ?? 0, bytes: bytes.byteLength };
  }

  /** Point the camera at the splat from the front, a little above, far enough to see all of it. */
  private frameObject(box: THREE.Box3) {
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 2 : Math.max(...box.getSize(new THREE.Vector3()).toArray(), 0.01);
    const distance = (size * 0.62) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.home.target.copy(center);
    this.home.position.copy(center).add(new THREE.Vector3(0, size * 0.18, distance));
    this.camera.near = Math.max(distance / 200, 0.001);
    this.camera.far = distance * 50;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = size * 0.25;
    this.controls.maxDistance = distance * 6;
    this.reset();
  }

  reset() {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
    this.requestRender();
  }

  /** Turn the splat over (a file saved y-down shows upside down). */
  flip() {
    if (!this.mesh) return;
    this.mesh.rotateX(Math.PI);
    this.mesh.updateMatrixWorld();
    const box = this.mesh.getBoundingBox(true).applyMatrix4(this.mesh.matrixWorld);
    this.frameObject(box);
  }

  /** Orbit by angles in radians (the arrow keys), around the target. */
  orbit(azimuth: number, polar: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    s.theta -= azimuth;
    s.phi = THREE.MathUtils.clamp(s.phi - polar, 0.05, Math.PI - 0.05);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
    this.controls.update();
    this.requestRender();
  }

  /** Move closer (factor < 1) or further (> 1), within the controls' limits (the + and - keys). */
  zoom(factor: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(d));
    this.controls.update();
    this.requestRender();
  }

  setCutoff(value: number) {
    this.cutoff.value = value;
    this.mesh?.updateVersion();
    this.requestRender(500);
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
    this.requestRender();
  }

  resize(width: number, height: number, dpr: number) {
    if (!width || !height) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** The current view as a PNG, at the canvas's own size (rendered and read in the same task). */
  capture(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) => this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't save the still"))), "image/png"));
  }

  /** Draw on the next frame, and keep drawing for `settleMs` (Spark finishing its work), or while the camera glides. */
  private requestRender(settleMs = 150) {
    this.until = Math.max(this.until, performance.now() + settleMs);
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
      // Damping keeps the camera gliding after a drag: keep drawing until it settles.
      const gliding = this.controls.update();
      if (gliding || performance.now() < this.until) this.requestRender(0);
    });
  }

  private render() {
    if (this.disposed) return;
    const t = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.lastFrameMs = performance.now() - t;
  }

  dispose() {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.mesh?.dispose();
    this.spark.dispose();
    this.renderer.dispose();
    // Give the context back now rather than at garbage collection: browsers keep only about 16 live, and a feed
    // of cards that open and close the viewer would otherwise push out the one that is showing.
    this.renderer.forceContextLoss();
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
  }
}

/** Fetch a splat file (abortable; refused past maxBytes, by its length or as it streams). */
export async function fetchSplat(url: string, { signal, maxBytes, onProgress }: { signal?: AbortSignal; maxBytes?: number; onProgress?: (p: number) => void } = {}): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The splat didn't load (${res.status})`);
  const length = Number(res.headers.get("content-length")) || 0;
  if (maxBytes && length > maxBytes) throw new SplatTooBigError(length);
  return readAll(res, length, maxBytes, onProgress);
}

/** A splat built from its file, with the haze cut-off: a Gaussian fainter than `cutoff`'s value isn't drawn (its opacity goes to 0). */
export async function buildSplatMesh(bytes: Uint8Array, format: string, cutoff: dyno.DynoFloat<string>): Promise<SplatMesh> {
  const mesh = new SplatMesh({ fileBytes: bytes, fileType: FILE_TYPES[format], fileName: `splat.${format}` });
  await mesh.initialized;
  mesh.objectModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error("no splat");
    const { opacity } = dyno.splitGsplat(gsplat).outputs;
    return { gsplat: dyno.combineGsplat({ gsplat, opacity: dyno.select(dyno.lessThan(opacity, cutoff), dyno.dynoConst("float", 0), opacity) }) };
  });
  mesh.updateGenerator();
  return mesh;
}

/**
 * Splats inside another engine's three.js scene: Cinema Studio's 3D scene props (idol-9). One SparkRenderer draws
 * every prop in the scene's own render pass, depth-tested against the MoGe mesh or point cloud and sorted with it.
 * Unlike the viewer's, it writes depth: the scene's post pass reads depth to tell a surface from a hole (what the path
 * render leaves transparent for Uni3C), so a splat that wrote none would vanish from the render. Spark sorts back to
 * front, so writing depth hides nothing behind a nearer Gaussian; the faintest edges (under minAlpha) are dropped so
 * they don't mark a hole as seen. Each prop sits in a group whose scale is its longest side (the splat is centred and
 * fitted to 1 inside), so the scene sets a prop's place, turn and size on the group.
 */
export class SceneSplats {
  readonly root = new THREE.Group();
  private spark: SparkRenderer;
  private props = new Map<string, { group: THREE.Group; mesh: SplatMesh; cutoff: dyno.DynoFloat<string> }>();
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, onDirty: () => void) {
    this.spark = new SparkRenderer({ renderer, onDirty, depthWrite: true, minAlpha: 1 / 16 });
    this.root.add(this.spark);
  }

  /** Load a prop's splat into a new group under `root`; resolves with the group (its transform is the scene's to set). */
  async add(id: string, url: string, format: string, o: { cutoff: number; signal?: AbortSignal; maxBytes?: number }): Promise<{ group: THREE.Group; splats: number }> {
    const bytes = await fetchSplat(url, { signal: o.signal, maxBytes: o.maxBytes });
    if (this.disposed || o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const cutoff = dyno.dynoFloat(o.cutoff);
    const mesh = await buildSplatMesh(bytes, format, cutoff);
    if (this.disposed || o.signal?.aborted) {
      mesh.dispose();
      throw new DOMException("Aborted", "AbortError");
    }
    const box = mesh.getBoundingBox(true);
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const longest = box.isEmpty() ? 1 : Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-3);
    const fit = new THREE.Group();
    fit.scale.setScalar(1 / longest);
    mesh.position.copy(center).multiplyScalar(-1);
    fit.add(mesh);
    const group = new THREE.Group();
    group.name = `prop:${id}`;
    group.add(fit);
    this.remove(id);
    this.props.set(id, { group, mesh, cutoff });
    this.root.add(group);
    return { group, splats: mesh.packedSplats?.numSplats ?? 0 };
  }

  setCutoff(id: string, value: number) {
    const p = this.props.get(id);
    if (!p || p.cutoff.value === value) return;
    p.cutoff.value = value;
    p.mesh.updateVersion();
  }

  remove(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    this.props.delete(id);
    p.group.removeFromParent();
    p.mesh.dispose();
  }

  get size() {
    return this.props.size;
  }

  /**
   * Bring the splats up to date for `camera` and wait for their sort (a path render draws each frame once, so the
   * order must be this frame's, not the last one's). Spark sorts on a worker: wait out a sort already running first.
   */
  async settle(scene: THREE.Scene, camera: THREE.Camera) {
    if (!this.props.size) return;
    for (let i = 0; this.spark.sorting && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    await this.spark.update({ scene, camera });
    for (let i = 0; this.spark.sorting && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  }

  dispose() {
    this.disposed = true;
    for (const id of [...this.props.keys()]) this.remove(id);
    this.root.removeFromParent();
    this.spark.dispose();
  }
}

export class SplatTooBigError extends Error {
  constructor(readonly bytes: number) {
    super("This splat is too big to open on this device");
  }
}

/** Read a response body, reporting progress and stopping once it passes maxBytes (a server that sent no length). */
async function readAll(res: Response, length: number, maxBytes: number | undefined, onProgress?: (p: number) => void): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (maxBytes && got > maxBytes) {
      void reader.cancel();
      throw new SplatTooBigError(got);
    }
    if (length) onProgress?.(Math.min(1, got / length));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
