"use client";

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { flyPoseOf, type FramePoses } from "@/lib/camera-path";
import {
  LENS,
  blurScale,
  buildPointCloud,
  canvasFov,
  dolly,
  flySpeed,
  flyStep,
  focalForFov,
  focusDistance,
  keysToInput,
  lensFov,
  lookStep,
  medianDepth,
  objectStart,
  sceneFov,
  strafe,
  type FlyPose,
  type Pixels,
  type Rect,
} from "@/lib/scene3d";
import type { SceneProp } from "@/lib/scene-props";
import type { SceneSplats } from "../model3d/splat-engine";
import type { SceneSource } from "./scene-actions";
import { encodeFrames, encodeVp8, pathVideoType, recordWithMediaRecorder, vp8Supported } from "./video-encode";

/**
 * The 3D scene viewer's renderer (three.js, loaded only when a scene opens): a MoGe mesh (GLB) or a point cloud
 * built from the still and its depth map, a fly camera, the frame-fitted lens, a depth-of-field pass, the capture
 * of exactly what the frame shows, and (Fly path, N7-5) a preview flight and a recording of the scene along a camera
 * path. The maths is in src/lib/scene3d.ts and src/lib/camera-path.ts; this file only draws.
 *
 * Props (idol-9): splats placed in the scene (src/lib/scene-props.ts), drawn by idol-4's renderer (Spark, loaded only
 * when the first prop is added) in the same scene graph, so the capture, the path render and the blockout show them.
 * A move / turn / size handle (three's TransformControls) is drawn over the finished frame on screen only.
 */

export type { SceneSource };

export interface SceneInfo {
  kind: "mesh" | "points";
  /** "scene": in the photo's camera space, so the start is the photo's view; "object": a model framed from the front. */
  layout: "scene" | "object";
  /** The lens (mm) that shows the photo's own view from the start. */
  photoLens: number;
  /** The subject distance: the orbit pivot for the re-shot angles and camera paths. */
  pivotDepth: number;
  /** The photo's own field of view (degrees) and shape: what a path render starts from. */
  photoFov: { h: number; v: number };
  photoAspect: number;
  /** Points, or triangles, drawn. */
  size: number;
}

export interface ViewSettings {
  lens: number;
  aperture: number;
  aspect: number;
  dof: boolean;
  /** The frame, in CSS px of the canvas. */
  frame: Rect;
  /** Flying speed multiplier. */
  speed: number;
}

const POINTS_VERT = /* glsl */ `
attribute float size;
attribute vec3 rgb;
uniform float scale;
varying vec3 vColor;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * scale / max(-mv.z, 1e-4), 1.0, 256.0);
  vColor = toLinear(rgb);
}`;

const POINTS_FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * Cracks filled, then a thin-lens blur gathered over a golden-angle disc (a sample only counts where its own blur
 * reaches and where there is a surface), then sRGB.
 *
 * Cracks: where the depth jumps nothing was seen behind the edge (MoGe drops those triangles, points spread apart),
 * so thin black outlines would show even from where the photo was taken. An empty pixel that surfaces surround on
 * most sides within `holeRadius` px takes the farthest of them: the background closes over the crack, as it would
 * behind the edge. Open space (past the scene's border, wide unseen areas) stays empty for the re-render to fill.
 */
const POST_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform float cameraNear;
uniform float cameraFar;
uniform float focus;
uniform float blur;
uniform float framePx;
uniform float maxRadius;
uniform float holeRadius;
uniform float holeAlpha;
varying vec2 vUv;
const float EMPTY = 0.99999;
float rawAt(vec2 uv) { return texture2D(tDepth, uv).x; }
float distOf(float raw) { return -perspectiveDepthToViewZ(raw, cameraNear, cameraFar); }
float coc(float d) { return min(maxRadius, 0.5 * blur * framePx * abs(d - focus) / max(d, 1e-4)); }
vec3 toSRGB(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 base = texture2D(tColor, vUv).rgb;
  float raw = rawAt(vUv);
  if (raw >= EMPTY && holeRadius > 0.0) {
    int hits = 0;
    float farthest = -1.0;
    vec3 fill = base;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.78539816;
      vec2 dir = vec2(cos(a), sin(a)) * texel * holeRadius;
      for (int s = 1; s <= 6; s++) {
        vec2 uv = vUv + dir * (float(s) / 6.0);
        float r = rawAt(uv);
        if (r < EMPTY) {
          hits++;
          if (r > farthest) {
            farthest = r;
            fill = texture2D(tColor, uv).rgb;
          }
          break;
        }
      }
    }
    if (hits >= 5) {
      base = fill;
      raw = farthest;
    }
  }
  float r0 = blur > 0.0 && raw < EMPTY ? coc(distOf(raw)) : 0.0;
  if (r0 > 0.75) {
    vec3 acc = base;
    float wsum = 1.0;
    for (int i = 0; i < 40; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / 40.0) * r0;
      float a = fi * 2.39996323;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
      float d = rawAt(uv);
      float w = d < EMPTY ? clamp(coc(distOf(d)) / max(r, 0.5), 0.0, 1.0) : 0.0;
      acc += texture2D(tColor, uv).rgb * w;
      wsum += w;
    }
    base = acc / wsum;
  }
  // What nothing covers: the background colour on screen, transparent black in a path render (Uni3C's holes).
  gl_FragColor = raw >= EMPTY ? vec4(toSRGB(base) * holeAlpha, holeAlpha) : vec4(toSRGB(base), 1.0);
}`;

const VOID = 0x0b0b0c;
const START: FlyPose = { position: [0, 0, 0], yaw: 0, pitch: 0 };

async function pixelsOf(url: string, maxSide: number, signal?: AbortSignal): Promise<Pixels> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  if (signal?.aborted) throw new DOMException("Closed", "AbortError");
  const w0 = img.naturalWidth || 1024;
  const h0 = img.naturalHeight || 1024;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * k));
  const height = Math.max(1, Math.round(h0 * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** How a prop's handle moves it. */
export type PropHandle = "translate" | "rotate" | "scale";

/** A prop's place, turn (degrees, Euler "YXZ") and size, as the handle left it. */
export type PropTransform = Pick<SceneProp, "position" | "rotation" | "size">;

/** Every vertex of the loaded model in world space, at most `max` of them (for the field of view, depth and focus). */
function sampleVertices(root: THREE.Object3D, max = 80_000): Float32Array {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  const total = meshes.reduce((n, m) => n + (m.geometry.getAttribute("position")?.count ?? 0), 0);
  const step = Math.max(1, Math.ceil(total / max));
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  return Float32Array.from(out);
}

export class SceneEngine {
  info: SceneInfo | null = null;
  /** Called when the autofocus distance changes (scene units ≈ m). */
  onFocus?: (distance: number) => void;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  private target: THREE.WebGLRenderTarget;
  private postMat: THREE.ShaderMaterial;
  private post: FullScreenQuad;
  private pointsMat: THREE.ShaderMaterial | null = null;
  private sample: Float32Array = new Float32Array(0);
  /** The loaded model (mesh scenes), for focusing on the surface the frame's centre sees. */
  private model: THREE.Object3D | null = null;
  private raycaster = new THREE.Raycaster();
  private pose: FlyPose = START;
  private view: ViewSettings | null = null;
  private keys = new Set<string>();
  private boost = false;
  private focus = 1;
  private dirty = true;
  private raf = 0;
  private last = 0;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private size = { w: 1, h: 1, dpr: 1 };
  private disposed = false;
  /** A path preview or recording owns the camera. */
  private playing = false;
  /**
   * A path is being recorded: the screen isn't drawn meanwhile. Drawing it would make Spark sort the props for the
   * on-screen camera while a path frame waits for its own sort, and the frame would be drawn in the wrong order.
   */
  private recording = false;
  /** Props: their splats (Spark, once the first is added) and their groups by id. */
  private splats: SceneSplats | null = null;
  private splatsLoading: Promise<SceneSplats> | null = null;
  private props = new Map<string, THREE.Group>();
  /** The handle on the picked prop, drawn after the frame (never in a capture or a path render). */
  private gizmo: TransformControls | null = null;
  private overlay = new THREE.Scene();
  /** A prop's size when the handle took it (sizes stay uniform). */
  private sizeAtGrab = 1;
  /** The handle moved, turned or sized a prop. */
  onPropChange?: (id: string, t: PropTransform) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(VOID, 1);
    const ext = this.renderer.extensions;
    const half = ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float");
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthTexture: new THREE.DepthTexture(1, 1) });
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        texel: { value: new THREE.Vector2(1, 1) },
        cameraNear: { value: 0.01 },
        cameraFar: { value: 1000 },
        focus: { value: 1 },
        blur: { value: 0 },
        framePx: { value: 1 },
        maxRadius: { value: 0 },
        holeRadius: { value: 0 },
        holeAlpha: { value: 1 },
      },
    });
    this.post = new FullScreenQuad(this.postMat);
    const tick = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const dt = this.last ? (t - this.last) / 1000 : 0;
      this.last = t;
      this.step(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Load the scene; resolves with what the panel needs (the photo's lens, the scene's scale). */
  async load(source: SceneSource, opts: { maxPoints: number; signal?: AbortSignal }): Promise<SceneInfo> {
    let info: SceneInfo;
    if (source.kind === "mesh") {
      const gltf = await new GLTFLoader().loadAsync(source.url);
      if (this.disposed || opts.signal?.aborted) throw new DOMException("Closed", "AbortError");
      const root = gltf.scene;
      let triangles = 0;
      let lit = false;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = mesh.geometry;
        triangles += (geo.index?.count ?? geo.getAttribute("position").count) / 3;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
        // A scanned scene carries its light in the texture: show it unlit. Untextured models keep their shading.
        const next = mats.map((m) => {
          if (m.map) {
            const basic = new THREE.MeshBasicMaterial({ map: m.map, side: THREE.DoubleSide, vertexColors: !!geo.getAttribute("color") });
            m.dispose();
            return basic;
          }
          lit = true;
          m.side = THREE.DoubleSide;
          return m;
        });
        mesh.material = Array.isArray(mesh.material) ? next : next[0];
      });
      if (lit) {
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 2.2));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(2, 3, 4);
        this.scene.add(sun);
      }
      root.updateMatrixWorld(true);
      let sample = sampleVertices(root);
      const fov = sceneFov(sample);
      if (fov) {
        const aspect = Math.tan((fov.h * Math.PI) / 360) / Math.tan((fov.v * Math.PI) / 360);
        info = { kind: "mesh", layout: "scene", photoLens: focalForFov(fov.h, aspect), pivotDepth: medianDepth(sample), size: Math.round(triangles), photoFov: fov, photoAspect: aspect };
      } else {
        // An object around its centre: move it so the camera starts at the origin, looking at it from the front.
        const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
        const lens = 35;
        const start = objectStart([sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, lensFov(lens, 16 / 9).v);
        root.position.sub(new THREE.Vector3(...start.position));
        root.updateMatrixWorld(true);
        sample = sampleVertices(root);
        info = {
          kind: "mesh",
          layout: "object",
          photoLens: lens,
          pivotDepth: start.position[2] - sphere.center.z,
          size: Math.round(triangles),
          photoFov: lensFov(lens, 16 / 9),
          photoAspect: 16 / 9,
        };
      }
      this.sample = sample;
      this.model = root;
      this.scene.add(root);
    } else {
      const [photo, depth] = await Promise.all([pixelsOf(source.photo, 1600, opts.signal), pixelsOf(source.depth, 1600, opts.signal)]);
      if (this.disposed) throw new DOMException("Closed", "AbortError");
      // Built as a 24 mm view of the still, so the default lens starts on the photo.
      const aspect = photo.width / photo.height;
      const cloud = buildPointCloud(photo, depth, { hFov: lensFov(LENS.default, aspect).h, maxPoints: opts.maxPoints });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(cloud.positions, 3));
      geo.setAttribute("rgb", new THREE.BufferAttribute(cloud.colors, 3));
      geo.setAttribute("size", new THREE.BufferAttribute(cloud.sizes, 1));
      this.pointsMat = new THREE.ShaderMaterial({ vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG, uniforms: { scale: { value: 1 } } });
      const points = new THREE.Points(geo, this.pointsMat);
      points.frustumCulled = false;
      this.scene.add(points);
      this.sample = cloud.positions;
      info = { kind: "points", layout: "scene", photoLens: LENS.default, pivotDepth: cloud.depth, size: cloud.count, photoFov: lensFov(LENS.default, aspect), photoAspect: aspect };
    }
    this.info = info;
    this.camera.near = Math.max(0.005, info.pivotDepth * 0.01);
    this.camera.far = info.pivotDepth * 80;
    this.pose = START;
    this.refocus(0);
    this.dirty = true;
    return info;
  }

  setView(view: ViewSettings) {
    this.view = view;
    this.dirty = true;
  }

  resize(w: number, h: number, dpr: number) {
    this.size = { w: Math.max(1, w), h: Math.max(1, h), dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.target.setSize(Math.round(this.size.w * dpr), Math.round(this.size.h * dpr));
    this.dirty = true;
  }

  // ---- Input

  key(code: string, down: boolean) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  setBoost(on: boolean) {
    this.boost = on;
  }

  releaseKeys() {
    this.keys.clear();
    this.boost = false;
  }

  /** Drag to look: across the frame's height turns by the lens's vertical field of view. */
  look(dxPx: number, dyPx: number) {
    if (!this.view) return;
    const perPx = (lensFov(this.view.lens, this.view.aspect).v * Math.PI) / 180 / Math.max(100, this.view.frame.height);
    this.move(lookStep(this.pose, dxPx, dyPx, perPx));
  }

  /** Turn by degrees (the arrow keys). */
  turn(yawDeg: number, pitchDeg: number) {
    this.move(lookStep(this.pose, -yawDeg, -pitchDeg, Math.PI / 180));
  }

  /** The wheel and pinches move along the view, in steps of the scene's size. */
  dolly(amount: number) {
    if (!this.info) return;
    this.move(dolly(this.pose, amount * this.info.pivotDepth));
  }

  /** Two fingers: the scene follows them (px at the subject's distance). */
  pan(dxPx: number, dyPx: number) {
    if (!this.info || !this.view) return;
    const perPx = (2 * Math.tan((lensFov(this.view.lens, this.view.aspect).v * Math.PI) / 360) * this.info.pivotDepth) / Math.max(100, this.view.frame.height);
    this.move(strafe(this.pose, -dxPx * perPx, dyPx * perPx));
  }

  reset() {
    this.move(START);
  }

  getPose(): FlyPose {
    return this.pose;
  }

  /** Put the camera at a pose (a path's keyframe). */
  setPose(pose: FlyPose) {
    this.move(pose);
  }

  /**
   * Fly the camera along a path in real time (`poseAt(0…1)` for `seconds`), then put it back where it was. Flying keys
   * do nothing meanwhile; the signal stops it early.
   */
  async playPath(poseAt: (t: number) => FlyPose, seconds: number, signal?: AbortSignal): Promise<void> {
    const before = this.pose;
    this.playing = true;
    this.keys.clear();
    try {
      await new Promise<void>((resolve) => {
        const t0 = performance.now();
        const tick = () => {
          if (this.disposed || signal?.aborted) return resolve();
          const t = Math.min(1, (performance.now() - t0) / 1000 / Math.max(0.1, seconds));
          this.pose = poseAt(t);
          this.dirty = true;
          if (t >= 1) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    } finally {
      this.playing = false;
      if (!this.disposed) this.move(before);
    }
  }

  private move(pose: FlyPose) {
    this.pose = pose;
    this.dirty = true;
    this.refocus();
  }

  /** Focus on what the frame's centre sees once the camera settles. */
  private refocus(delay = 120) {
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      if (this.disposed || !this.info) return;
      const d = this.surfaceAhead() ?? focusDistance(this.sample, this.pose) ?? this.info.pivotDepth;
      if (Math.abs(d - this.focus) > 1e-4) {
        this.focus = d;
        this.dirty = true;
        this.onFocus?.(d);
      }
    }, delay);
  }

  /** A mesh's surface straight ahead (a low-poly model has too few vertices to sample). */
  private surfaceAhead(): number | null {
    if (!this.model) return null;
    const cam = this.camera;
    cam.position.set(...this.pose.position);
    cam.rotation.set(this.pose.pitch, this.pose.yaw, 0, "YXZ");
    cam.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), cam);
    return this.raycaster.intersectObject(this.model, true)[0]?.distance ?? null;
  }

  // ---- Drawing

  private step(dt: number) {
    if (this.info && this.view && this.keys.size && !this.playing) {
      const input = keysToInput(this.keys);
      if (input.forward || input.right || input.up) {
        this.pose = flyStep(this.pose, input, dt, flySpeed(this.info.pivotDepth) * this.view.speed, this.boost);
        this.dirty = true;
        this.refocus();
      }
    }
    if (this.dirty && this.view && this.info && !this.recording) {
      this.dirty = false;
      this.draw(null, Math.round(this.size.w * this.size.dpr), Math.round(this.size.h * this.size.dpr), this.view.frame.width * this.size.dpr, this.view.frame.height * this.size.dpr);
    }
  }

  /**
   * Render into `out` (null = the screen) at w×h px; the frame is frameW×frameH px of it, centred. `shot` renders from
   * another camera instead (a path frame: its pose and vertical field of view, no depth of field, holes transparent).
   */
  private draw(out: THREE.WebGLRenderTarget | null, w: number, h: number, frameW: number, frameH: number, color = this.target, shot?: { pose: FlyPose; vFov: number }) {
    const v = this.view!;
    const cam = this.camera;
    this.poseCamera(shot?.pose ?? this.pose, shot ? shot.vFov : canvasFov(lensFov(v.lens, v.aspect).v, frameH, h), w / h);
    if (this.pointsMat) this.pointsMat.uniforms.scale.value = h / 2 / Math.tan((cam.fov * Math.PI) / 360);
    this.renderer.setRenderTarget(color);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    const u = this.postMat.uniforms;
    u.tColor.value = color.texture;
    u.tDepth.value = color.depthTexture;
    u.texel.value.set(1 / w, 1 / h);
    u.cameraNear.value = cam.near;
    u.cameraFar.value = cam.far;
    u.focus.value = this.focus;
    u.blur.value = v.dof && !shot ? blurScale(v.lens, v.aperture, this.focus, v.aspect) : 0;
    u.holeAlpha.value = shot ? 0 : 1;
    u.framePx.value = frameW;
    u.maxRadius.value = Math.min(0.025 * frameW, 48);
    // Cracks up to about 1.4% of the frame's width close; wider unseen areas stay empty.
    u.holeRadius.value = Math.max(2, frameW / 70);
    this.renderer.setRenderTarget(out);
    this.post.render(this.renderer);
    // The prop's handle, over the finished frame on screen only.
    if (!out && !shot && this.gizmo?.object) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.overlay, cam);
      this.renderer.autoClear = true;
    }
  }

  private poseCamera(pose: FlyPose, vFov: number, aspect: number) {
    const cam = this.camera;
    cam.fov = vFov;
    cam.aspect = aspect;
    cam.position.set(...pose.position);
    cam.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // ---- Props

  /** Load a prop's splat into the scene (Spark comes in with the first one); resolves with its Gaussian count. */
  async addProp(p: SceneProp, o: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<number> {
    if (!this.splatsLoading) {
      const loading = import("../model3d/splat-engine").then(({ SceneSplats }) => {
        // The viewer closed while Spark was loading: make nothing for it.
        if (this.disposed) throw new DOMException("Closed", "AbortError");
        const splats = new SceneSplats(this.renderer, () => (this.dirty = true));
        this.scene.add(splats.root);
        this.splats = splats;
        return splats;
      });
      // A failed load (offline, a chunk that didn't arrive) is tried again with the next prop.
      loading.catch(() => (this.splatsLoading = null));
      this.splatsLoading = loading;
    }
    const splats = await this.splatsLoading;
    if (this.disposed) throw new DOMException("Closed", "AbortError");
    const { group, splats: count } = await splats.add(p.id, p.url, p.format, { cutoff: p.cutoff, signal: o.signal, maxBytes: o.maxBytes });
    if (this.disposed) throw new DOMException("Closed", "AbortError");
    this.props.set(p.id, group);
    this.updateProp(p);
    return count;
  }

  /** Put a prop where the state says (place, turn, size, haze cut-off). */
  updateProp(p: SceneProp) {
    const g = this.props.get(p.id);
    if (!g) return;
    g.position.set(...p.position);
    g.rotation.set(THREE.MathUtils.degToRad(p.rotation[0]), THREE.MathUtils.degToRad(p.rotation[1]), THREE.MathUtils.degToRad(p.rotation[2]), "YXZ");
    g.scale.setScalar(p.size);
    g.updateMatrixWorld(true);
    this.splats?.setCutoff(p.id, p.cutoff);
    this.dirty = true;
  }

  removeProp(id: string) {
    const g = this.props.get(id);
    if (!g) return;
    if (this.gizmo?.object === g) this.gizmo.detach();
    this.props.delete(id);
    this.splats?.remove(id);
    this.dirty = true;
  }

  hasProp(id: string) {
    return this.props.has(id);
  }

  /** Put the handle on a prop (null: none), in a mode. */
  pickProp(id: string | null, mode: PropHandle) {
    const g = id ? this.props.get(id) : undefined;
    if (!g) {
      this.gizmo?.detach();
      this.dirty = true;
      return;
    }
    const gizmo = this.ensureGizmo();
    gizmo.setMode(mode);
    if (gizmo.object !== g) gizmo.attach(g);
    this.dirty = true;
  }

  /** The pointer is on the handle or dragging it (the view's own drag-to-look waits). */
  handleActive(): boolean {
    return !!this.gizmo?.object && (this.gizmo.dragging || this.gizmo.axis !== null);
  }

  private propIdOf(g: THREE.Object3D | undefined): string | undefined {
    for (const [id, v] of this.props) if (v === g) return id;
    return undefined;
  }

  private ensureGizmo(): TransformControls {
    if (this.gizmo) return this.gizmo;
    const gizmo = new TransformControls(this.camera, this.canvas);
    gizmo.setSpace("world");
    gizmo.addEventListener("change", () => (this.dirty = true));
    gizmo.addEventListener("mouseDown", () => (this.sizeAtGrab = gizmo.object?.scale.x ?? 1));
    gizmo.addEventListener("objectChange", () => {
      const g = gizmo.object;
      const id = this.propIdOf(g);
      if (!g || !id) return;
      // Sizes stay uniform: whichever axis the handle moved most sets all three.
      const s = g.scale;
      const from = this.sizeAtGrab;
      const size = Math.max(1e-3, Math.abs([s.x, s.y, s.z].reduce((a, b) => (Math.abs(b - from) > Math.abs(a - from) ? b : a), s.x)));
      g.scale.setScalar(size);
      const r = new THREE.Euler().setFromQuaternion(g.quaternion, "YXZ");
      const deg = (x: number) => Math.round(THREE.MathUtils.radToDeg(x) * 10) / 10;
      const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
      this.onPropChange?.(id, { position: [r4(g.position.x), r4(g.position.y), r4(g.position.z)], rotation: [deg(r.x), deg(r.y), deg(r.z)], size: r4(size) });
    });
    this.overlay.add(gizmo.getHelper());
    this.gizmo = gizmo;
    return gizmo;
  }

  /**
   * A render target's pixels, read now. Spark reads its sort keys back with three's readRenderTargetPixelsAsync, which
   * leaves its pixel-pack buffer bound while it waits: a synchronous read then would land in that buffer and leave
   * `buf` empty (a black frame in the path render). Unbind it first; three binds its own again before collecting.
   */
  private readPixels(target: THREE.WebGLRenderTarget, width: number, height: number, buf: Uint8Array) {
    const gl = this.renderer.getContext();
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, buf);
  }

  /** What the frame shows, rendered at width×height (the frame's ratio), as a PNG. */
  async capture(width: number, height: number): Promise<Blob> {
    if (!this.view || !this.info) throw new Error("The scene isn't ready yet");
    const color = new THREE.WebGLRenderTarget(width, height, { type: this.target.texture.type, depthTexture: new THREE.DepthTexture(width, height) });
    const out = new THREE.WebGLRenderTarget(width, height);
    try {
      this.draw(out, width, height, width, height, color);
      const buf = new Uint8Array(width * height * 4);
      this.readPixels(out, width, height, buf);
      const img = new ImageData(width, height);
      // WebGL reads bottom-up.
      for (let y = 0; y < height; y++) img.data.set(buf.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("Couldn't save the capture");
      return blob;
    } finally {
      color.depthTexture?.dispose();
      color.dispose();
      out.dispose();
      this.renderer.setRenderTarget(null);
      this.dirty = true;
    }
  }

  /**
   * Record the scene along a path (build plan N7-5): every frame of `path` (OpenCV camera-to-world poses and a pixel
   * intrinsic, src/lib/camera-path.ts framePoses) rendered at its size with nothing behind the scene, as two videos at
   * `fps`: `render` (black where nothing was seen: Uni3C's render_video) and, when `mask` is asked for, the hole mask
   * (white = a hole; core's Uni3C node has no mask input, so only WorldCast will ask, and Film doesn't pay for a second
   * encode). With WebCodecs every frame is encoded (VP8) and written to WebM at its exact time; without it MediaRecorder
   * records the frames handed over 1/fps apart, which may drop one.
   */
  async recordPath(
    path: FramePoses,
    o: { fps: number; mask?: boolean; mp4?: boolean; onProgress?: (p: number) => void; signal?: AbortSignal },
  ): Promise<{ render: Blob; mask?: Blob; type: string; frames: number }> {
    if (!this.view || !this.info) throw new Error("The scene isn't ready yet");
    const { width, height, poses, intrinsic } = path;
    const exact = await vp8Supported(width, height, o.fps);
    const type = exact ? "video/webm" : pathVideoType();
    if (!type) throw new Error("This browser can't record video — use the cloud engine, or another browser");
    const vFov = (2 * Math.atan(height / 2 / intrinsic[1][1]) * 180) / Math.PI;
    const color = new THREE.WebGLRenderTarget(width, height, { type: this.target.texture.type, depthTexture: new THREE.DepthTexture(width, height) });
    const out = new THREE.WebGLRenderTarget(width, height);
    const buf = new Uint8Array(width * height * 4);
    const render = new ImageData(width, height);
    const mask = o.mask ? new ImageData(width, height) : null;
    const images = mask ? [render, mask] : [render];
    /**
     * Frame i into `render` (and `mask`): WebGL reads bottom-up, and a pixel nothing covered is transparent black. With
     * props, their splats are sorted for this frame's camera first.
     */
    const frame = async (i: number) => {
      const pose = flyPoseOf(poses[i]);
      if (this.splats?.size) {
        this.poseCamera(pose, vFov, width / height);
        await this.splats.settle(this.scene, this.camera);
        stop();
      }
      this.draw(out, width, height, width, height, color, { pose, vFov });
      this.readPixels(out, width, height, buf);
      for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4;
        const dst = y * width * 4;
        for (let x = 0; x < width * 4; x += 4) {
          const hole = buf[src + x + 3] < 128;
          render.data[dst + x] = hole ? 0 : buf[src + x];
          render.data[dst + x + 1] = hole ? 0 : buf[src + x + 1];
          render.data[dst + x + 2] = hole ? 0 : buf[src + x + 2];
          render.data[dst + x + 3] = 255;
          if (!mask) continue;
          const m = hole ? 255 : 0;
          mask.data[dst + x] = m;
          mask.data[dst + x + 1] = m;
          mask.data[dst + x + 2] = m;
          mask.data[dst + x + 3] = 255;
        }
      }
    };
    const stop = () => {
      if (o.signal?.aborted || this.disposed) throw new DOMException("Stopped", "AbortError");
    };
    this.playing = true;
    this.recording = true;
    try {
      // Blockout to film: the render as the cloud models read it (MP4 where the browser encodes H.264).
      if (o.mp4 && !mask) {
        const out = await encodeFrames(
          poses.length,
          width,
          height,
          o.fps,
          async (i) => {
            stop();
            await frame(i);
            o.onProgress?.((i + 1) / poses.length);
            return render;
          },
          true,
        );
        return { render: out.blob, type: out.type, frames: poses.length };
      }
      if (exact) {
        const [a, b] = await encodeVp8(poses.length, width, height, o.fps, images.length, async (i) => {
          stop();
          await frame(i);
          o.onProgress?.((i + 1) / poses.length);
          return images;
        });
        return { render: new Blob([a as BlobPart], { type }), ...(b ? { mask: new Blob([b as BlobPart], { type }) } : {}), type, frames: poses.length };
      }
      const [r, m] = await recordWithMediaRecorder(type, poses.length, width, height, o.fps, images.length, async (i) => {
        stop();
        await frame(i);
        o.onProgress?.((i + 1) / poses.length);
        return images;
      });
      return { render: r, ...(m ? { mask: m } : {}), type: type.split(";")[0], frames: poses.length };
    } finally {
      color.depthTexture?.dispose();
      color.dispose();
      out.dispose();
      this.renderer.setRenderTarget(null);
      this.playing = false;
      this.recording = false;
      this.dirty = true;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.focusTimer);
    if (this.gizmo) {
      this.gizmo.detach();
      this.gizmo.getHelper().removeFromParent();
      this.gizmo.dispose();
    }
    // Spark's objects dispose themselves (before the generic sweep below).
    this.splats?.dispose();
    this.props.clear();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.MeshBasicMaterial[]) {
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.postMat.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
