/**
 * Turnaround video (build plan N7-6; research new-models-7.md §3.7 recipes (B) and (C), §3.10 row 2): one click on a cast
 * sheet or a saved character makes a 360° turnaround of the same person, on both engines, with routes Fuobe already has.
 *
 * - The views: the person's front, right side, back and left side (their own left and right, as Image to 3D's side picker
 *   names them), filmed in that order and back to the front. Sides nobody has a picture of are drawn first from the front
 *   view by the Angles app's route (the Multiple-Angles LoRA); a sheet with no front view gets one drawn from it.
 * - Open engine: Frames mode's chain (Wan 2.2 14B start / end-frame clips, src/server/chains.ts createKeyframeFilm) with
 *   the views at 0, ¼, ½, ¾ and the end of the clip, and the orbit words.
 * - Cloud: MiniMax H3 Max reference-to-video with the views as Image 1…n (recipe C), FLUX 3 Max keyframes-to-video with
 *   the views at their quarters (recipe B), or, from the front view alone, H3 Max camera controls on an exact path (A).
 *
 * N7-9 later puts WorldCast behind the same buttons on the open engine; its side names and angles are written down here.
 * Pure: the browser prices it live, the server runs the same steps (src/server/turnaround.ts, Cinema's "turnaround").
 */
import { DEFAULT_MOTION, PATH_PRESETS, presetKeys, type CameraKey } from "@/lib/camera-path";
import { poseWords } from "@/lib/scene3d";
import { QMA_AZIMUTH_LABELS, QMA_MODEL, qmaAzimuth } from "@/lib/qma";
import { getModel, getPreset } from "./index";
import { onEngine } from "./engines";
import { FRAMES_MODELS, chainGapProblem, chainTiming, frameTimes } from "./keyframes";
import { ANGLES_2511_LORA } from "./open-tools";
import { estimateCost, planGeneration } from "./plan";
import { WORLDCAST_AFTER, WORLDCAST_MODELS, WORLDCAST_SECONDS, worldcastFallback, worldcastNote, worldcastSteps } from "./worldcast-plan";
import type { ChainSlot, Engine, Generation, GenerationRequest, GenParams, ModelDef } from "./types";

// ---------------------------------------------------------------------------
// Sides

export type TurnSide = "front" | "right" | "back" | "left";
/** The order the camera passes the sides: front → right side → back → left side (then the front again). */
export const TURN_SIDES: readonly TurnSide[] = ["front", "right", "back", "left"];
export const SIDE_NAMES: Record<TurnSide, string> = { front: "Front", right: "Right side", back: "Back", left: "Left side" };
/** Said beside the side picker (Image to 3D says the same of objects, src/lib/av/model3d.ts SIDES_HINT). */
export const SIDES_HINT = "Left and right are the person's own: facing them, their right side is on your left.";

const AZIMUTH: Record<TurnSide, number> = { front: 0, right: 90, back: 180, left: 270 };

/**
 * Where the camera stands to see a side, in degrees round the person from their front: front 0°, right side 90°, back 180°,
 * left side 270°. Left and right are the person's own (their right side faces your left when they face you), like Image to
 * 3D's side picker. A turnaround passes them in this order, so its azimuth only grows.
 */
export function viewAzimuth(side: TurnSide): number {
  return AZIMUTH[side];
}

/** The film's frames: the four sides at 0, ¼, ½ and ¾ of the clip, and the front again at its end. */
export const TURN_FRAMES: readonly { side: TurnSide; t: number }[] = [...TURN_SIDES.map((side) => ({ side, t: viewAzimuth(side) / 360 })), { side: "front" as const, t: 1 }];

/**
 * The same camera in the camera-path library's terms (src/lib/camera-path.ts, where + is moved round to the viewer's
 * right): seeing the person's right side means moving round to the viewer's left, so a turnaround is a clockwise orbit
 * seen from above (presetKeys("orbit_360_cw")).
 */
export function pathAzimuth(side: TurnSide): number {
  return -viewAzimuth(side) + 0;
}

// WorldCast's names for the sides (N7-9) live with its cases: src/lib/worldcast.ts.
export { WORLDCAST, worldcastAnchor, type WorldcastView } from "@/lib/worldcast";

/**
 * The Angles app's horizontal_angle for a side. The Multiple-Angles LoRA calls 90° the "right side view", read here as the
 * person's own right side. Neither its card nor fal's page says whose right that is: one constant to flip after the first
 * real run (as N7-5 keeps H3's azimuth sign behind H3_AZIMUTH_SIGN).
 */
export const ANGLES_SIDE_SIGN: 1 | -1 = 1;
export function anglesHorizontal(side: TurnSide): number {
  return (((viewAzimuth(side) * ANGLES_SIDE_SIGN) % 360) + 360) % 360;
}

/**
 * QMA's horizontal_angle for a side. QMA turns the ORIGINAL CAMERA (its card: "right side view" = the camera swings 90° to its
 * own right round the subject), and a camera that swings to its right sees the person's LEFT side: their right side is QMA's
 * 270° ("left side view"), their back 180°.
 */
export function qmaHorizontal(side: TurnSide): number {
  return (360 - viewAzimuth(side)) % 360;
}

/**
 * A still's name by the person's own side (Character Sheet's way), for QMA's camera angle `horizontal`: the camera at 90°
 * (QMA's "right side view") shows the person's left side. The camera's words stay in the prompt only.
 */
export function qmaStillName(horizontal: number): string {
  return QMA_AZIMUTH_LABELS[qmaAzimuth(360 - horizontal)];
}

/** The still set's camera angles, going round the person to their right: front right, right side, … front left. */
export const QMA_STILL_ANGLES: readonly number[] = [1, 2, 3, 4, 5, 6, 7].map((i) => (360 - i * 45) % 360);

// ---------------------------------------------------------------------------
// Routes

export type TurnRoute = "worldcast" | "frames" | "references" | "keyframes" | "camera" | "stills";

export interface TurnRouteInfo {
  engine: Engine;
  modelId: string;
  name: string;
  /** One line under the choice. */
  detail: string;
  durations: number[];
  duration: number;
  resolution: string;
}

/** The routes, the open engine's first, then the cloud's in the order they are offered. */
export const TURN_ROUTES: Record<TurnRoute, TurnRouteInfo> = {
  // N7-9: WorldCast on the studio's WorldCast worker, offered when it answers (TurnaroundContext.worldcast).
  worldcast: {
    engine: "open",
    modelId: WORLDCAST_MODELS.film,
    name: "WorldCast",
    detail: "WorldCast films an exact orbit from the front view; the back and sides follow your views",
    durations: [],
    duration: WORLDCAST_SECONDS,
    resolution: "480 × 832",
  },
  frames: {
    engine: "open",
    modelId: FRAMES_MODELS.open.id,
    name: "Frames",
    detail: "Wan 2.2 14B films each quarter turn from one view to the next, then joins them",
    durations: [5, 8, 10, 15, 20],
    duration: 8,
    resolution: "480p",
  },
  references: {
    engine: "cloud",
    modelId: "minimax-h3-max",
    name: "References",
    detail: "MiniMax H3 Max takes every view as a reference (Image 1, Image 2…) and turns the camera from your words",
    durations: [5, 8, 10, 15],
    duration: 5,
    resolution: "768P",
  },
  keyframes: {
    engine: "cloud",
    modelId: FRAMES_MODELS.cloud.id,
    name: "Keyframes",
    detail: "FLUX 3 Max puts each view at its quarter of the turn",
    durations: [5, 6, 8, 10, 12, 15, 20],
    duration: 8,
    resolution: "720p",
  },
  camera: {
    engine: "cloud",
    modelId: "minimax-h3-max-camera",
    name: "Camera path",
    detail: "MiniMax H3 Max camera controls follow an exact path from the front view alone; it invents the sides and back",
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    duration: 5,
    resolution: "768P",
  },
  // Turnaround stills · 8 views: QMA · 96 views draws the person from all 8 sides at eye level, one batch of
  // pictures and no film. Your GPU only: fal's Qwen-Image 2.1 takes no LoRAs.
  stills: {
    engine: "open",
    modelId: QMA_MODEL,
    name: "Stills · 8 views",
    detail: "QMA · 96 views draws the character from all 8 sides at eye level: eight pictures, no video",
    durations: [],
    duration: 0,
    resolution: "",
  },
};

export const ROUTES_ON: Record<Engine, TurnRoute[]> = { open: ["worldcast", "frames", "stills"], cloud: ["references", "keyframes", "camera"] };

/** How the missing sides are drawn on your GPU: the Angles app's Multiple-Angles route (the default), or QMA · 96 views. */
export type TurnFill = "angles" | "qma";
export const FILL_NAMES: Record<TurnFill, string> = { angles: "Multiple Angles", qma: "QMA · 96 views" };

/** The Angles app's routes, which draw a missing side from the front view (on your GPU the Multiple-Angles LoRA's base). */
export const FILL_MODELS: Record<Engine, string> = { cloud: "qwen-multiple-angles", open: "oss-qwen-edit" };
/** What draws a front view from a whole sheet, when no picture shows the front alone (Qwen-Image 2.1 on your GPU). */
export const SHEET_FRONT_MODELS: Record<Engine, string> = { cloud: "nano-banana-pro", open: "oss-qwen-image-21" };

/** The camera route's paths (N7-5's moves); the turnaround's own Orbit 360° passes the right side first, as the views do. */
export const TURN_PATHS = [
  { id: "orbit_360_cw", name: "Orbit 360°", description: "A full level ring, past their right side first, as the views are ordered" },
  ...PATH_PRESETS.filter((p) => ["orbit_90_cw", "orbit_90_ccw", "orbit_180_push", "orbit_tilt_20", "zoom_in", "zoom_out"].includes(p.id)),
];
export const DEFAULT_PATH = TURN_PATHS[0].id;

/** The words a turnaround films to (the open engine's and FLUX 3 Max's frames, the camera path's level rings). */
export const ORBIT_PROMPT = "The camera orbits 360 degrees around the person at a constant height; the person stands naturally";

/**
 * The camera route's words for a path: the orbit's own words only for a level full ring (Orbit 360°, either way round);
 * any other move (an arc, a tilted ring, a dolly) gets N7-5's neutral words, so the prompt never fights the path the
 * model follows exactly (prompt expansion is off on this route, so nothing reconciles the two).
 */
export function cameraWords(path: string, extra?: string): string {
  return withWords(/^orbit_360(_c?cw)?$/.test(path) ? ORBIT_PROMPT : DEFAULT_MOTION, extra);
}

const FILL_KEEP = "Keep the same person: identity, face, hair, body, outfit, lighting and plain background";
/** The edit that draws a front view from a whole sheet, when no picture shows the front alone. */
export const SHEET_FRONT_PROMPT =
  "Image 1 is a character turnaround sheet. Show only this character's front view as one full-body picture, centred and facing the camera, on the same plain backdrop and light. Keep the face, hair, body and outfit exactly as on the sheet; this one view alone fills the clean picture";

const tidy = (p: string | undefined) => (p ?? "").trim().replace(/[.\s]+$/, "");
const withWords = (base: string, extra: string | undefined) => (tidy(extra) ? `${base}. ${tidy(extra)}` : base);

/** What a reference is to H3 Max, in its prompt ("Image 2 is their right side"). */
const REF_WORDS: Record<TurnSide | "sheet", string> = {
  front: "the person's front view",
  right: "their right side",
  back: "their back",
  left: "their left side",
  sheet: "a turnaround sheet of the same person",
};

/**
 * The reference-to-video words: each Image N named for the side it shows, then the orbit, in the sides' order. H3 Max
 * reads Image 1…n in reference_image_urls order (fal's schema), and Image 1 is also the first frame.
 */
export function referencesPrompt(order: (TurnSide | "sheet")[], extra?: string): string {
  const named = order.map((k, i) => `Image ${i + 1} is ${REF_WORDS[k]}`).join(", ");
  const seen = order.filter((k): k is TurnSide => k !== "sheet");
  const path = seen.length > 1 || order.includes("sheet") ? "from the front past their right side, their back and their left side back to the front" : "all the way round them";
  return withWords(`${named}. The camera orbits 360 degrees around the person at a constant height, ${path}; the person stands naturally and looks the same from every side as in the images`, extra);
}

// ---------------------------------------------------------------------------
// The pictures a sheet or a character offers

export interface TurnPicture {
  url: string;
  label: string;
  /** The side it shows, when known (the Soul Cast sheet graph's cut views). */
  side?: TurnSide;
  /** A whole turnaround sheet (several views in one picture). */
  sheet?: boolean;
}

/** The open Soul Cast sheet graph cuts the sheet into four views, in this order (soul-cast-sheet-zimage, ImageGridtoBatch 4×1). */
const TILES: { label: string; side?: TurnSide }[] = [{ label: "Front", side: "front" }, { label: "Three-quarter" }, { label: "Profile" }, { label: "Back", side: "back" }];

/**
 * The pictures a finished Character Sheet or Soul Cast result offers: its whole sheets, the views its graph cut (front
 * and back known; the three-quarter and profile turn either way, so the user places them), and the photos it was made
 * from (the first is the front when nothing else is). Every picture that isn't a cut view is a whole sheet: the graph's
 * own, or each variant of a cloud batch, which one generation returns as its outputs. `picked` (a variant the user chose,
 * by its url or the url it was finished from) comes first, so the dialog starts on it.
 */
export function sheetPictures(g: Pick<Generation, "outputs" | "request">, picked?: string): TurnPicture[] {
  const images = g.outputs.filter((o) => o.kind === "image");
  const tiles = images.filter((o) => o.meta?.role === "tiles");
  const sheets = images.filter((o) => o.meta?.role !== "tiles");
  const isPicked = (o: (typeof images)[number]) => !!picked && (o.url === picked || o.meta?.original === picked);
  const out: TurnPicture[] = [...sheets.filter(isPicked), ...sheets.filter((o) => !isPicked(o))].map((o) => ({
    url: o.url,
    label: sheets.length > 1 ? `Sheet ${sheets.indexOf(o) + 1}` : "Sheet",
    sheet: true,
  }));
  tiles.forEach((o, n) => {
    const tile = TILES[typeof o.meta?.index === "number" ? (o.meta.index as number) : n];
    out.push({ url: o.url, label: tile?.label ?? `View ${n + 1}`, ...(tile?.side && { side: tile.side }) });
  });
  const photos = (g.request.inputs?.images ?? []).filter((u) => u.startsWith("/api/files/"));
  const hasFront = out.some((p) => p.side === "front");
  photos.forEach((url, i) => out.push({ url, label: `Photo ${i + 1}`, ...(i === 0 && !hasFront && { side: "front" as const }) }));
  return out;
}

/**
 * A saved character's pictures: a wide one (1.6:1 or wider: a sheet's shape) is its sheet, and the first other one its
 * front, until the user says otherwise. Sizes come from the browser; a picture not measured yet counts as a photo.
 */
export function elementPictures(refs: { url: string; width?: number; height?: number }[]): TurnPicture[] {
  let sheet = false;
  let front = false;
  return refs.map((r, i) => {
    const wide = !!r.width && !!r.height && r.width / r.height >= 1.6;
    if (wide && !sheet) {
      sheet = true;
      return { url: r.url, label: "Sheet", sheet: true };
    }
    if (!wide && !front) {
      front = true;
      return { url: r.url, label: `Photo ${i + 1}`, side: "front" as const };
    }
    return { url: r.url, label: `Photo ${i + 1}` };
  });
}

/** The views and sheet a set of pictures starts with (each side's first picture; the first sheet). */
export function startingViews(pics: TurnPicture[]): { views: Partial<Record<TurnSide, string>>; sheet?: string } {
  const views: Partial<Record<TurnSide, string>> = {};
  for (const p of pics) if (p.side && !views[p.side]) views[p.side] = p.url;
  return { views, ...(pics.find((p) => p.sheet) && { sheet: pics.find((p) => p.sheet)!.url }) };
}

// ---------------------------------------------------------------------------
// The plan

export interface TurnaroundInput {
  engine: Engine;
  /** The pictures by side (the person's own left and right). The front is the hero: the film starts and ends on it. */
  views?: Partial<Record<TurnSide, string>>;
  /** A whole turnaround sheet: a reference on the cloud's References route, and where a missing front view is drawn from. */
  sheet?: string;
  /** The route (the engine's default when left out or not offered: ROUTES_ON, defaultRoute). */
  route?: TurnRoute;
  /** Draw the sides nobody has a picture of with the Angles app first (default on, except References with a sheet). */
  fill?: boolean;
  /** What draws them on your GPU: the Angles app's route (default) or QMA · 96 views. */
  fillWith?: TurnFill;
  /** The camera route's path (TURN_PATHS; any N7-5 preset id is taken). */
  path?: string;
  duration?: number;
  aspectRatio?: "9:16" | "16:9";
  /** Words added after the orbit's own. */
  prompt?: string;
  /** The character's name, for the title. */
  name?: string;
  /** Where the film is filed (its feature); default "turnaround". */
  feature?: string;
  /** The feature of the pictures drawn first (a helper "-step" feature by default, so feeds show the film, not its parts). */
  stepFeature?: string;
  seed?: number;
}

export interface TurnaroundContext {
  /** Whether this install offers a model (Settings → Models & licences); every model by default. */
  has?: (id: string) => boolean;
  /**
   * The studio's WorldCast worker answers (N7-9): the WorldCast route is offered and is the GPU's default. False: it doesn't,
   * and Frames says so. Undefined: nothing is said (a visitor, or WorldCast is off).
   */
  worldcast?: boolean;
}

export interface TurnStep {
  key: string;
  request: GenerationRequest;
  /** Keys of earlier steps it waits for (one per chain slot, in order), as Cinema's steps do. */
  after?: string[];
}

/** A frame of the film (or a reference, on References): where its picture comes from. */
export interface TurnFrame {
  side: TurnSide | "sheet";
  /** Its time, 0–1 (frames and keyframes); undefined for a reference. */
  t?: number;
  from: "picture" | "angles" | "sheet";
  url?: string;
}

export interface TurnaroundPlan {
  engine: Engine;
  route: TurnRoute;
  /** The routes this engine offers here. */
  routes: TurnRoute[];
  model: ModelDef;
  steps: TurnStep[];
  frames: TurnFrame[];
  /** The sides drawn first by the Angles app. */
  fills: TurnSide[];
  /** Whether a front view is drawn from the sheet first. */
  frontFromSheet: boolean;
  fill: boolean;
  duration: number;
  durations: number[];
  notes: string[];
  blocker?: string;
  /** What it costs at list (or launch) price; 0 on the open engine. Null when a step has no known price. */
  costUsd: number | null;
}

export const NEEDS_FRONT = "Pick the front view: the person facing the camera";
export const NEEDS_SECOND_VIEW = "Add another side, or let Fuobe draw the missing sides";

const offered = (ctx: TurnaroundContext) => (id: string) => (ctx.has ? ctx.has(id) : !!getModel(id));

/**
 * The route a turnaround takes when none is asked for. Open: Frames. Cloud (research §3.7: "default to (A); use (C) or (B)
 * when the user has three or more views or a cast sheet"): References when there are two or more views or a sheet,
 * else the camera path from the front alone.
 */
export function defaultRoute(engine: Engine, input: Pick<TurnaroundInput, "views" | "sheet">, routes: TurnRoute[] = ROUTES_ON[engine]): TurnRoute {
  const own = TURN_SIDES.filter((s) => input.views?.[s]).length;
  const want: TurnRoute = engine === "open" ? (routes.includes("worldcast") ? "worldcast" : "frames") : own >= 2 || input.sheet ? "references" : "camera";
  return routes.includes(want) ? want : (routes[0] ?? want);
}

/** The route a model runs on this engine (an API client or the evaluation harness names the model, not the route). */
export function routeOfModel(engine: Engine, modelId: string | undefined): TurnRoute | undefined {
  return ROUTES_ON[engine].find((r) => TURN_ROUTES[r].modelId === modelId);
}

/** The duration a route takes: the one asked for when offered, else the nearest it offers. */
export function turnDuration(route: TurnRoute, asked?: number): number {
  const { durations, duration } = TURN_ROUTES[route];
  if (!durations.length) return duration;
  const want = asked ?? duration;
  return durations.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), durations[0]);
}

/** A request whose chained inputs are placeholders (to price it before they exist), as the runner fills them. */
function placeholders(req: GenerationRequest): GenerationRequest {
  if (!req.chain?.length) return req;
  const inputs = { ...req.inputs };
  const png = "/api/files/placeholder.png";
  const placed = req.chain.filter((c) => c.slot === "images" && c.at !== undefined).sort((a, b) => a.at! - b.at!);
  for (const c of req.chain) {
    if (c.slot === "images" && c.at === undefined) inputs.images = [...(inputs.images ?? []), png];
    if (c.slot === "endImage") inputs.endImage = png;
  }
  for (const c of placed) {
    const list = [...(inputs.images ?? [])];
    list.splice(Math.min(c.at!, list.length), 0, png);
    inputs.images = list;
  }
  return { ...req, inputs };
}

function stepCost(req: GenerationRequest, engine: Engine): number | null {
  const lookup = (id: string) => {
    const m = getModel(id);
    return m && onEngine(m, engine);
  };
  const p = planGeneration(placeholders(req), lookup, getPreset);
  return estimateCost(p.model, p.params, 1, p.op);
}

type Source = { url: string } | { key: string };

/**
 * Everything a Turnaround press runs, in order, priced, without running it: a front drawn from the sheet (when no picture
 * shows the front), the sides drawn by the Angles app, then the film on the route. The steps are Cinema-shaped (key,
 * request, after) so Cinema's runner and src/server/turnaround.ts run them the same way.
 */
export function planTurnaround(input: TurnaroundInput, ctx: TurnaroundContext = {}): TurnaroundPlan {
  const { engine } = input;
  const has = offered(ctx);
  const routes = ROUTES_ON[engine].filter((r) => has(TURN_ROUTES[r].modelId) && (r !== "worldcast" || ctx.worldcast === true));
  const route = input.route && routes.includes(input.route) ? input.route : defaultRoute(engine, input, routes);
  const info = TURN_ROUTES[route];
  const model = getModel(info.modelId)!;
  const feature = input.feature ?? "turnaround";
  const stepFeature = input.stepFeature ?? "turnaround-step";
  const views: Partial<Record<TurnSide, string>> = {};
  for (const s of TURN_SIDES) if (input.views?.[s]) views[s] = input.views[s];
  const sheet = input.sheet || undefined;
  const camera = route === "camera";
  const stills = route === "stills";
  const frontFromSheet = !views.front && !!sheet;
  // WorldCast takes the views there are (one to four): drawn sides only when asked, since a drawn side may drift.
  const fill = camera || stills ? false : (input.fill ?? !((route === "references" && sheet) || route === "worldcast"));
  const byQma = engine === "open" && input.fillWith === "qma" && has(QMA_MODEL);
  const fills = fill && (views.front || frontFromSheet) ? TURN_SIDES.filter((s) => s !== "front" && !views[s]) : [];
  const duration = turnDuration(route, input.duration);
  const aspectRatio = input.aspectRatio ?? "9:16";
  const notes: string[] = [];
  const steps: TurnStep[] = [];

  // A front view drawn from the sheet first, when no picture shows the front alone.
  if (frontFromSheet) {
    const m = getModel(SHEET_FRONT_MODELS[engine])!;
    steps.push({
      key: "front",
      request: {
        feature: stepFeature,
        modelId: m.id,
        op: "edit",
        prompt: SHEET_FRONT_PROMPT,
        inputs: { images: [sheet!] },
        params: { numOutputs: 1, ...(engine === "cloud" && { aspectRatio }) },
      },
    });
    notes.push(`${m.name} draws a front view from the sheet first`);
  }
  // The missing sides, drawn from the front view by the Angles app's route.
  const fillModel = getModel(byQma ? QMA_MODEL : FILL_MODELS[engine])!;
  for (const side of fills) {
    const horizontal = anglesHorizontal(side);
    const request: GenerationRequest = byQma
      ? // QMA turns the camera, so the person's own side is the other way round (qmaHorizontal); its words come from the pose.
        { feature: stepFeature, modelId: fillModel.id, op: "edit", prompt: FILL_KEEP, params: { numOutputs: 1, extra: { horizontal_angle: qmaHorizontal(side), vertical_angle: 0, zoom: 5 } } }
      : engine === "cloud"
        ? { feature: stepFeature, modelId: fillModel.id, op: "edit", prompt: FILL_KEEP, params: { numOutputs: 1, extra: { horizontal_angle: horizontal, vertical_angle: 0, zoom: 5 } } }
        : {
            feature: stepFeature,
            modelId: fillModel.id,
            op: "edit",
            prompt: `<sks> ${poseWords({ horizontal, vertical: 0, zoom: 5 })}. ${FILL_KEEP}`,
            params: { numOutputs: 1 },
            loras: [ANGLES_2511_LORA],
          };
    if (frontFromSheet) steps.push({ key: `fill-${side}`, request: { ...request, chain: [{ slot: "images" }] }, after: ["front"] });
    else steps.push({ key: `fill-${side}`, request: { ...request, inputs: { images: [views.front!] } } });
  }
  if (fills.length) {
    const list = fills.map((s) => SIDE_NAMES[s].toLowerCase());
    const said = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
    notes.push(byQma ? `${fillModel.name} draws the ${said} from the front view first, on your GPU` : `The Angles app (${fillModel.name} with the Multiple-Angles LoRA) draws the ${said} from the front view first`);
  }

  const sourceOf = (side: TurnSide): Source | undefined =>
    views[side] ? { url: views[side]! } : side === "front" && frontFromSheet ? { key: "front" } : fills.includes(side) ? { key: `fill-${side}` } : undefined;
  const fromOf = (src: Source, side: TurnSide): TurnFrame["from"] => ("url" in src ? "picture" : side === "front" ? "sheet" : "angles");
  /** The request's own pictures, and the ones steps make put in at their places (ChainSlot.at). */
  const gather = (list: Source[]) => {
    const images: string[] = [];
    const chain: ChainSlot[] = [];
    const after: string[] = [];
    list.forEach((src, i) => {
      if ("url" in src) images.push(src.url);
      else {
        chain.push({ slot: "images", at: i });
        after.push(src.key);
      }
    });
    return { images, chain, after };
  };
  const title = `Turnaround${input.name?.trim() ? ` · ${input.name.trim()}` : ""}`;
  const seed = input.seed !== undefined ? { seed: input.seed } : {};
  let frames: TurnFrame[] = [];
  let main: TurnStep | undefined;
  let blocker: string | undefined = views.front || frontFromSheet ? undefined : NEEDS_FRONT;

  if (stills) {
    // Eight eye-level pictures round the person, each drawn from the front view; the front's own picture stays the first.
    const src = sourceOf("front");
    const turns = QMA_STILL_ANGLES;
    frames = src ? [{ side: "front", from: fromOf(src, "front"), ...("url" in src && { url: src.url }) }] : [];
    for (const h of turns) {
      const request: GenerationRequest = {
        feature,
        modelId: model.id,
        op: "edit",
        prompt: withWords(FILL_KEEP, input.prompt),
        title: `${title.replace(/^Turnaround/, "Turnaround stills")} · ${qmaStillName(h)}`,
        params: { numOutputs: 1, extra: { horizontal_angle: h, vertical_angle: 0, zoom: 5 }, ...seed },
      };
      const key = `still-${h}`;
      if (src && "key" in src) steps.push({ key, request: { ...request, chain: [{ slot: "images" }] }, after: [src.key] });
      else steps.push({ key, request: { ...request, ...(src && { inputs: { images: [src.url] } }) } });
    }
    notes.push(`${model.name} draws the character from ${turns.length} more sides at eye level, each from the front view, on your GPU: ${turns.length + 1} pictures with the front`);
  } else if (route === "frames" || route === "keyframes") {
    const list = TURN_FRAMES.flatMap((f) => {
      const src = sourceOf(f.side);
      return src ? [{ ...f, src }] : [];
    });
    frames = list.map((f) => ({ side: f.side, t: f.t, from: fromOf(f.src, f.side), ...("url" in f.src && { url: f.src.url }) }));
    const times = frameTimes(
      list.map((f) => f.t),
      duration,
    );
    const { images, chain, after } = gather(list.map((f) => f.src));
    const params: GenParams = {
      numOutputs: 1,
      duration,
      keyframeTimes: times,
      aspectRatio,
      resolution: info.resolution,
      ...(route === "keyframes" && { generateAudio: false }),
      ...seed,
    };
    main = {
      key: "main",
      request: { feature, modelId: model.id, op: "keyframes", prompt: withWords(ORBIT_PROMPT, input.prompt), title, ...(images.length && { inputs: { images } }), ...(chain.length && { chain }), params },
      ...(after.length && { after }),
    };
    if (!blocker && list.filter((f) => f.side !== "front").length === 0) blocker = NEEDS_SECOND_VIEW;
    if (!blocker && route === "frames") {
      // Wan 2.2 14B's longest clip between two frames: a missing side doubles the gap.
      const timing = chainTiming(onEngine(model, "open"));
      if (chainGapProblem(times, duration, timing)) {
        const missing = TURN_SIDES.some((s) => !sourceOf(s));
        blocker = `${model.name} films up to ${timing.maxSeconds} s from one view to the next — make the turnaround shorter${missing ? " or let Fuobe draw the missing sides" : ""}`;
      }
    }
    notes.push(
      route === "frames"
        ? `${model.name} films each turn from one view to the next (${list.length - 1} clips), then joins them, on your GPU`
        : `${model.name} puts each view at its place in the turn (${list.map((f) => SIDE_NAMES[f.side].toLowerCase()).join(", ")})`,
    );
  } else if (route === "references") {
    const list: { key: TurnSide | "sheet"; src: Source }[] = TURN_SIDES.flatMap((s) => {
      const src = sourceOf(s);
      return src ? [{ key: s, src }] : [];
    });
    if (sheet) list.push({ key: "sheet", src: { url: sheet } });
    frames = list.map((f) => ({ side: f.key, from: f.key === "sheet" ? "picture" : fromOf(f.src, f.key), ...("url" in f.src && { url: f.src.url }) }));
    const { images, chain, after } = gather(list.map((f) => f.src));
    // The front is the first frame (Image 1 goes as image_url) and the last (end_image_url), so the turn comes back to it.
    const front = sourceOf("front");
    const inputs: GenerationRequest["inputs"] = { ...(images.length && { images }), ...(front && "url" in front && { endImage: front.url }) };
    if (front && "key" in front) {
      chain.push({ slot: "endImage" });
      after.push(front.key);
    }
    const max = model.options.maxImages ?? 9;
    if (list.length > max) blocker ??= `${model.name} takes up to ${max} references`;
    main = {
      key: "main",
      request: {
        feature,
        modelId: model.id,
        op: "ref2v",
        prompt: referencesPrompt(
          list.map((f) => f.key),
          input.prompt,
        ),
        title,
        ...(Object.keys(inputs).length && { inputs }),
        ...(chain.length && { chain }),
        params: { numOutputs: 1, duration, resolution: info.resolution, aspectRatio, ...seed },
      },
      ...(after.length && { after }),
    };
    notes.push(
      `${model.name} takes ${list.length === 1 ? "the front view" : `the ${list.length} pictures`} as references, starts and ends on the front, and turns the camera from the words: identity holds, the path is loose`,
    );
  } else if (route === "worldcast") {
    // The front view is the first frame and an anchor (as WorldCast's demo case); every side with a picture is an anchor.
    const path = input.path && presetKeys(input.path) ? input.path : DEFAULT_PATH;
    const front = sourceOf("front");
    const anchors = TURN_SIDES.flatMap((side) => {
      const src = sourceOf(side);
      return src ? [{ side, src }] : [];
    });
    frames = anchors.map((a) => ({ side: a.side, from: fromOf(a.src, a.side), ...("url" in a.src && { url: a.src.url }) }));
    const ws = worldcastSteps({ feature, stepFeature, title, still: front, anchors, keys: presetKeys(path)!, prompt: cameraWords(path, input.prompt), seed: input.seed });
    for (const st of ws) {
      if (st.key === "main") main = st;
      else steps.push(st);
    }
    notes.push(worldcastNote(anchors.length), WORLDCAST_AFTER);
  } else {
    const path = input.path && presetKeys(input.path) ? input.path : DEFAULT_PATH;
    const keys: CameraKey[] = presetKeys(path)!;
    const src = sourceOf("front");
    frames = src ? [{ side: "front", t: 0, from: fromOf(src, "front"), ...("url" in src && { url: src.url }) }] : [];
    main = {
      key: "main",
      request: {
        feature,
        modelId: model.id,
        op: "camera-path",
        prompt: cameraWords(path, input.prompt),
        title,
        ...(src && "url" in src && { inputs: { images: [src.url] } }),
        ...(src && "key" in src && { chain: [{ slot: "images" as const }] }),
        params: { numOutputs: 1, duration, resolution: info.resolution, cameraPath: keys, ...seed },
      },
      ...(src && "key" in src && { after: [src.key] }),
    };
    const name = TURN_PATHS.find((p) => p.id === path)?.name ?? path;
    notes.push(`${model.name} follows ${name} from the front view alone, with prompt expansion off: it invents the sides and back`);
    if (TURN_SIDES.some((s) => s !== "front" && views[s]) || sheet) notes.push("Your other views aren't used on this route: References or Keyframes keep them");
  }
  // The pictures drawn first are numbered steps of the run, before the film (whose own clips the keyframe film numbers).
  const stepLabel = (k: string) =>
    k === "front"
      ? "Front view from the sheet"
      : k.startsWith("still-")
        ? qmaStillName(Number(k.slice(6)))
        : `${SIDE_NAMES[k.slice(5) as TurnSide]} (${byQma ? "QMA" : "Angles"})`;
  const total = steps.length + (main ? 1 : 0);
  steps.forEach((s, i) => (s.request.step = { label: s.request.step?.label ?? stepLabel(s.key), index: i, of: total }));
  if (main && route === "worldcast") main.request.step = { label: main.request.step?.label ?? "Film", index: total - 1, of: total };
  if (engine === "open" && route === "frames" && ctx.worldcast === false) notes.push(worldcastFallback("Frames"));
  if (main) steps.push(main);

  // Prices at list (or launch) rates; free on the open engine.
  let cost: number | null = 0;
  if (!blocker) {
    for (const s of steps) {
      try {
        const c = stepCost(s.request, engine);
        cost = c === null || cost === null ? null : cost + c;
      } catch (e) {
        blocker ??= (e as Error).message;
      }
    }
  }
  return {
    engine,
    route,
    routes,
    model,
    steps,
    frames,
    fills,
    frontFromSheet,
    fill,
    duration,
    durations: info.durations,
    notes,
    ...(blocker && { blocker }),
    costUsd: cost === null ? null : Math.round(cost * 1000) / 1000,
  };
}

/** What /api/turnaround?preview=1 answers: the plan as this install would run it (src/server/turnaround.ts). */
export interface TurnaroundPreview {
  route: TurnRoute;
  routes: TurnRoute[];
  model: { id: string; name: string };
  duration: number;
  durations: number[];
  frames: TurnFrame[];
  fills: TurnSide[];
  frontFromSheet: boolean;
  fill: boolean;
  steps: number;
  notes: string[];
  blocker?: string;
  costUsd: number | null;
  /** Some step runs on the demo provider (no key, or ComfyUI not reachable, with demo mode on). */
  demo: boolean;
  /** The open engine: the most VRAM a step needs (GB). */
  gpuGb?: number;
  /**
   * A real person (the client says so, or a character, which always is): Soul ID's consent line is asked for, or it is
   * on file from the character's Soul ID training.
   */
  consent?: "asked" | "on-file";
}
