import { isIdol, model3dView, splatFormatOf } from "@/lib/av/model3d";
import { HAZE_MAX, hazeCutoffFor } from "@/lib/av/splat-view";
import type { Generation } from "@/lib/catalog/types";
import { forwardOf, type FlyPose, type Vec3 } from "@/lib/scene3d";

/**
 * Props in Cinema Studio's 3D scene (idol-9, docs/research/idol-9.md §8–9): an object made from a picture (an Idol 3D
 * splat, or any splat result in the Library, a cloud TripoSplat .ply included) placed in the MoGe scene, moved, turned
 * and sized, and filmed with it. The scene viewer draws them with idol-4's splat renderer
 * (src/components/model3d/splat-engine.ts) inside the scene's own three.js graph, so captures, path renders and
 * blockouts show them. Pure, so the tests can check the state and the placing.
 */

/** At most this many props in one scene (each is a splat the browser sorts every time the camera moves). */
export const MAX_PROPS = 4;
/** A prop's size: its longest side, as a share of the scene's subject distance, from this to that. */
export const PROP_SIZE = { min: 0.02, max: 4, start: 0.35 } as const;

export interface SceneProp {
  id: string;
  /** The splat file (.spz, .ply, .ksplat or .splat). */
  url: string;
  format: string;
  /** What the list calls it ("Idol 3D", "TripoSplat"). */
  name: string;
  /** The Library result it came from. */
  generationId?: string;
  modelId?: string;
  /** A still of it for the list (the result's preview or poster). */
  poster?: string;
  /** Where its centre is, in scene units (the scene's camera space). */
  position: Vec3;
  /** Its turn in degrees about x, y and z (three.js Euler order "YXZ": yaw first, as the fly camera turns). */
  rotation: Vec3;
  /** Its longest side, in scene units. */
  size: number;
  /** The opacity it hides Gaussians under (Idol 3D's faint haze; idol-4's cut-off). */
  cutoff: number;
}

/** What the viewer keeps for one scene take: its props (in this browser, next to the scene they were placed in). */
export interface SceneState {
  version: 1;
  props: SceneProp[];
}

export const EMPTY_SCENE: SceneState = { version: 1, props: [] };

/** Where a scene's state is kept in this browser. */
export const sceneStateKey = (sceneId: string) => `fuobe.cinema.scene.${sceneId}`;

/** A Library result that can be placed as a prop: a finished 3D result whose file is a splat. */
export interface PropCandidate {
  url: string;
  format: string;
  generationId: string;
  modelId: string;
  poster?: string;
}

export function propCandidate(g: Pick<Generation, "id" | "status" | "outputs" | "request">): PropCandidate | null {
  if (g.status !== "succeeded") return null;
  const view = model3dView(g);
  if (!view.splat) return null;
  return { url: view.splat.url, format: view.splat.format, generationId: g.id, modelId: g.request.modelId, ...(view.poster ? { poster: view.poster } : {}) };
}

const add = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * A new prop where the camera looks, facing it: `pivotDepth` × 0.7 ahead (a little in front of the subject), its
 * longest side 0.35 × pivotDepth, turned so its front (+z in its own file, the side Idol saw in the picture) faces the
 * camera. A second or third prop lands a little to the side, so they don't stack.
 */
export function placeProp(c: PropCandidate & { name: string }, pose: FlyPose, pivotDepth: number, taken: number, id: string): SceneProp {
  const d = Math.max(pivotDepth, 0.05);
  const ahead = add(pose.position, forwardOf(pose.yaw, 0), d * 0.7);
  const side: Vec3 = [Math.cos(pose.yaw), 0, -Math.sin(pose.yaw)];
  const shift = taken === 0 ? 0 : (taken % 2 ? 1 : -1) * Math.ceil(taken / 2) * 0.3 * d;
  return {
    id,
    url: c.url,
    format: c.format,
    name: c.name,
    generationId: c.generationId,
    modelId: c.modelId,
    ...(c.poster ? { poster: c.poster } : {}),
    position: round3(add(ahead, side, shift)),
    rotation: [0, round(deg(pose.yaw), 1), 0],
    size: round(d * PROP_SIZE.start, 4),
    cutoff: hazeCutoffFor(c.modelId),
  };
}

/** Put a prop back in front of the camera, keeping its size and its turn relative to the view. */
export function bringToCamera(p: SceneProp, pose: FlyPose, pivotDepth: number): SceneProp {
  const ahead = add(pose.position, forwardOf(pose.yaw, 0), Math.max(pivotDepth, 0.05) * 0.7);
  return { ...p, position: round3(ahead), rotation: [p.rotation[0], round(deg(pose.yaw), 1), p.rotation[2]] };
}

/** Turn it over (a file saved upside down): half a turn about its own x. */
export const turnOver = (p: SceneProp): SceneProp => ({ ...p, rotation: [wrapDeg(p.rotation[0] + 180), p.rotation[1], wrapDeg(p.rotation[2])] });

/** The size slider's range for a scene, in scene units. */
export const sizeRange = (pivotDepth: number) => ({ min: Math.max(pivotDepth, 0.05) * PROP_SIZE.min, max: Math.max(pivotDepth, 0.05) * PROP_SIZE.max });

export function serializeSceneState(s: SceneState): string {
  return JSON.stringify({ version: 1, props: s.props.slice(0, MAX_PROPS) });
}

/**
 * A kept state read back: anything that isn't a well-formed prop is dropped (an edited or older entry never breaks
 * the viewer), numbers are kept finite, sizes positive, cut-offs in the slider's range, at most MAX_PROPS.
 */
export function parseSceneState(text: string | null | undefined): SceneState {
  if (!text) return EMPTY_SCENE;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_SCENE;
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { props?: unknown }).props) ? ((raw as { props: unknown[] }).props as unknown[]) : [];
  const props: SceneProp[] = [];
  const ids = new Set<string>();
  for (const item of list) {
    const p = parseProp(item);
    if (!p || ids.has(p.id)) continue;
    ids.add(p.id);
    props.push(p);
    if (props.length >= MAX_PROPS) break;
  }
  return { version: 1, props };
}

function parseProp(v: unknown): SceneProp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 && x.length <= 2048 ? x : undefined);
  const id = str(o.id);
  const url = str(o.url);
  if (!id || !url || !/^(\/(?!\/)|https?:\/\/)/.test(url)) return null;
  const format = typeof o.format === "string" ? splatFormatOf({ url: `x.${o.format}` }) : undefined;
  if (!format) return null;
  const vec = (x: unknown): Vec3 | null => (Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === "number" && Number.isFinite(n)) ? [x[0], x[1], x[2]] : null);
  const position = vec(o.position);
  const rotation = vec(o.rotation);
  const size = typeof o.size === "number" && Number.isFinite(o.size) && o.size > 0 ? o.size : null;
  if (!position || !rotation || !size) return null;
  const cutoff = typeof o.cutoff === "number" && Number.isFinite(o.cutoff) ? Math.min(HAZE_MAX, Math.max(0, o.cutoff)) : 0;
  const modelId = str(o.modelId);
  return {
    id,
    url,
    format,
    name: str(o.name)?.slice(0, 80) ?? "Prop",
    ...(str(o.generationId) ? { generationId: str(o.generationId) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(str(o.poster) ? { poster: str(o.poster) } : {}),
    position,
    rotation: [wrapDeg(rotation[0]), wrapDeg(rotation[1]), wrapDeg(rotation[2])],
    size,
    cutoff,
  };
}

/** Whether a prop came from Idol 3D (its haze cut-off starts at 0.05). */
export const isIdolProp = (p: Pick<SceneProp, "modelId">) => isIdol(p.modelId);

function deg(rad: number) {
  return (rad * 180) / Math.PI;
}
/** Degrees into -180…180. */
export function wrapDeg(d: number): number {
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : Object.is(w, -0) ? 0 : w;
}
function round(n: number, places: number) {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
const round3 = (v: Vec3): Vec3 => [round(v[0], 4), round(v[1], 4), round(v[2], 4)];

/** What the status says about who is looking and what runs here (src/lib/connections.ts ConnectionState, loosely). */
export interface PropMakerStatus {
  viewer?: unknown;
  engineMode?: string;
  demoMode?: string;
  providers?: Record<string, { configured?: boolean } | undefined>;
  ownerGpu?: unknown;
  /** Idol 3D on the open engine is switched on in Settings → Models & licences. */
  idolOn: boolean;
}

/**
 * Why "Make a prop from a picture" (Idol 3D on your GPU, open source; Idol has no hosted route for this) can't run
 * here, or null when it can. The same rule as src/lib/connections.ts make3dOffered (Idol 3D on the open engine): a
 * guest or an account makes it on its own GPU (the press asks a guest to sign up, an account without a GPU to connect
 * one: own-setup.ts), Paid APIs only leaves the open engine out, the model can be off, and the owner's GPU must be
 * connected (or placeholder results on). A splat already in the Library can be placed either way.
 */
export function propMakerBlocker(s: PropMakerStatus | undefined): string | null {
  if (!s) return "Checking what runs here…";
  if (s.viewer) return s.idolOn ? null : "Make a splat in Image to 3D → Splat, then place it here from your Library.";
  if (s.engineMode === "cloud") return "Making a prop from a picture runs Idol 3D on your GPU (open source), which Paid APIs only leaves out. You can still place splats from your Library.";
  if (!s.idolOn) return "Idol 3D is turned off in Settings → Models & licences. Turn it on there to make props from pictures.";
  if (s.demoMode !== "on" && !s.providers?.comfyui?.configured && !s.ownerGpu) return "Connect ComfyUI in Settings to make props from pictures on your GPU.";
  return null;
}
