/**
 * World mode (package nm10-hy-nomas-world): a world you describe once, then steer turn by turn with words and camera
 * moves, on Hy-Nomas (Tencent Hunyuan, Apache-2.0) through Nynxz's ComfyUI port. Open engine only: Hy-Nomas is hosted on
 * neither fal nor Replicate.
 *
 * The state is a script: the opening (the scene, who the camera follows, the look) and the turns after it, each with its
 * words (what changes, what the subject does), a camera move from the fly-path library and its length. Running turn k
 * sends the script up to k; the graph chains the opening and every turn up to k, and saves turn k only.
 *
 * How the earlier turns' state reaches turn k: the port holds a world in ComfyUI's memory (its NOMAS_WORLD output and a
 * key/value cache in ComfyUI's temp folder), and ComfyUI keeps the outputs of the last prompt it ran. The chain for turn k
 * repeats turns 0…k−1 with exactly the same inputs, so ComfyUI reuses them and only turn k is generated. When the cache
 * no longer holds them (another job ran in between, a restart), ComfyUI simply generates them again from the same seed,
 * which takes longer and gives the same world. Redo from turn k changes turn k's inputs, so turns 0…k−1 are reused and k
 * onwards are made afresh.
 *
 * Pure: the browser and the server share it.
 */

import type { ComfyNode, ComfyWorkflow } from "./comfy";
import { PATH_PRESETS } from "./camera-path";
import { STILL_MOVE, WORLD_FPS, WORLD_SIZE, moveKeys, turnFrames, worldScripts, type WorldTurnCamera } from "./world-path";

/** The model, its op and the graph. */
export const WORLD_MODEL = "oss-hy-nomas-world";
export const WORLD_WORKFLOW = "world-hy-nomas-turn";
/** The open engine's join (video-concat-encoded: the turns share one size, rate and codec). */
export const WORLD_JOIN = "oss-join-encoded";

/** The port's subject token: the opening's subject is written this way in the scene and action text. */
export const SUBJECT_TOKEN = "<|Subject1|>";

export const WORLD_LIMITS = {
  /** Seconds per turn (Hy-Nomas's turns: 3–12 s; steps of half a second keep the frame count whole). */
  minSeconds: 3,
  maxSeconds: 12,
  step: 0.5,
  /** Turns, the opening included. */
  maxTurns: 10,
  /** The whole world: the port's noise bank is 120 s (it extends it, but the reference's interactive bank is 120 s). */
  maxTotal: 120,
  /** Characters of the scene and of each turn's words. */
  maxScene: 1200,
  maxWords: 400,
} as const;

/** The opening's camera, as Hy-Nomas's prompt enhancer names it (nomas/prompt.py PERSPECTIVES). */
export const PERSPECTIVES = [
  { id: "third-person follow", name: "Follows the subject" },
  { id: "third-person observer", name: "Watches from a distance" },
  { id: "first-person", name: "Through their eyes" },
  { id: "second-person", name: "Looking at the viewer" },
] as const;
/** The look (nomas/prompt.py STYLES, the ones that make sense for a film). */
export const STYLES = [
  { id: "real-world footage", name: "Real footage" },
  { id: "CG", name: "CG" },
  { id: "animation/anime", name: "Animation" },
  { id: "video game", name: "Video game" },
] as const;
export type Perspective = (typeof PERSPECTIVES)[number]["id"];
export type WorldStyle = (typeof STYLES)[number]["id"];

/** The camera moves a turn offers: a still camera, then the fly-path library. */
export const WORLD_MOVES: { id: string; name: string; description: string }[] = [
  { id: STILL_MOVE, name: "Still", description: "The camera stays put: only the words steer this turn" },
  ...PATH_PRESETS,
];

export interface WorldTurn {
  /** What changes in the world ("a wooden bridge crosses a stream ahead"). The opening's are its scene. */
  words: string;
  /** What the subject does during the turn (optional). */
  action?: string;
  /** A move id from WORLD_MOVES. */
  move: string;
  seconds: number;
}

export interface WorldOpening extends WorldTurn {
  /** Who or what the camera follows ("a small orange fox"); empty for a world with no one in it. */
  subject?: string;
  /** How they look. */
  details?: string;
  perspective?: Perspective;
  style?: WorldStyle;
}

export interface WorldScript {
  opening: WorldOpening;
  /** The turns after the opening. */
  turns: WorldTurn[];
  seed: number;
}

/** A turn of the script by index: 0 = the opening. */
export function turnAt(script: WorldScript, k: number): WorldTurn | undefined {
  return k === 0 ? script.opening : script.turns[k - 1];
}

/** Every turn, the opening first. */
export function allTurns(script: WorldScript): WorldTurn[] {
  return [script.opening, ...script.turns];
}

export const newTurn = (): WorldTurn => ({ words: "", move: "orbit_90_ccw", seconds: 5 });

export function newWorld(seed = Math.floor(Math.random() * 2 ** 31)): WorldScript {
  return {
    opening: { words: "", subject: "", details: "", action: "", perspective: "third-person follow", style: "real-world footage", move: "zoom_in", seconds: 5 },
    turns: [],
    seed,
  };
}

/** A turn's length as World mode takes it: on the half second, 3–12 s. */
export const clampSeconds = (s: number) => {
  const n = Number.isFinite(s) ? s : 5;
  return Math.min(WORLD_LIMITS.maxSeconds, Math.max(WORLD_LIMITS.minSeconds, Math.round(n / WORLD_LIMITS.step) * WORLD_LIMITS.step));
};
const knownMove = (m: string | undefined) => (m && WORLD_MOVES.some((x) => x.id === m) ? m : STILL_MOVE);
const text = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

function tidyTurn(t: Partial<WorldTurn> | undefined): WorldTurn {
  const action = text(t?.action, WORLD_LIMITS.maxWords);
  return { words: text(t?.words, WORLD_LIMITS.maxWords), ...(action ? { action } : {}), move: knownMove(t?.move), seconds: clampSeconds(Number(t?.seconds)) };
}

/** A script as the planner runs it: lengths on the half second within 3–12 s, known moves, at most WORLD_LIMITS.maxTurns turns. */
export function normalizeWorld(s: Partial<WorldScript> | undefined): WorldScript {
  const o = s?.opening;
  const opening: WorldOpening = {
    ...tidyTurn(o),
    words: text(o?.words, WORLD_LIMITS.maxScene),
    subject: text(o?.subject, 120),
    details: text(o?.details, WORLD_LIMITS.maxWords),
    perspective: PERSPECTIVES.some((p) => p.id === o?.perspective) ? o!.perspective : "third-person follow",
    style: STYLES.some((p) => p.id === o?.style) ? o!.style : "real-world footage",
  };
  const seed = Number.isInteger(s?.seed) && (s!.seed as number) >= 0 ? (s!.seed as number) : 0;
  return { opening, turns: (s?.turns ?? []).slice(0, WORLD_LIMITS.maxTurns - 1).map(tidyTurn), seed };
}

/** Seconds of the world up to and including turn k (all of it by default). */
export function worldSeconds(script: WorldScript, upTo = script.turns.length): number {
  return allTurns(script)
    .slice(0, upTo + 1)
    .reduce((sum, t) => sum + t.seconds, 0);
}

/** What stops turn k from running, or null. */
export function worldProblem(script: WorldScript, k: number): string | null {
  if (!script.opening.words.trim()) return "Describe the world first: the opening is where it starts";
  if (k < 0 || k > script.turns.length) return "That turn isn't in this world";
  const t = turnAt(script, k)!;
  if (k > 0 && !t.words.trim() && !t.action?.trim() && t.move === STILL_MOVE) return `Turn ${k} needs words or a camera move`;
  if (worldSeconds(script, k) > WORLD_LIMITS.maxTotal + 1e-9) return `A world runs up to ${WORLD_LIMITS.maxTotal} s: shorten a turn`;
  return null;
}

// ---------------------------------------------------------------------------
// Turn state in the browser: which turns have a clip, and what Redo from here keeps

export interface WorldClip {
  /** The turn's generation and, once it has finished, its clip. */
  generationId: string;
  url?: string;
  /** The script the clip was made from, up to its turn: a clip is current only while that part is unchanged. */
  made: string;
}

/**
 * The part of the script that turn k's clip depends on (everything up to k, and the seed), read from the script as the
 * planner runs it (normalizeWorld): words typed with spaces round them, or a length off the half second, key the same
 * as the take the server filed for them.
 */
export function scriptKey(script: WorldScript, k: number): string {
  const tidy = normalizeWorld(script);
  const o = tidy.opening;
  return JSON.stringify([tidy.seed, o.subject ?? "", o.details ?? "", o.perspective ?? "", o.style ?? "", allTurns(tidy).slice(0, k + 1).map((t) => [t.words, t.action ?? "", t.move, t.seconds])]);
}

/** Whether turn k's clip still matches the script (nothing up to k has changed since it was made). */
export function clipCurrent(script: WorldScript, k: number, clip: WorldClip | undefined): boolean {
  return !!clip && clip.made === scriptKey(script, k);
}

/** The next turn to run: the first one with no current clip (−1 when every turn has one). */
export function nextTurn(script: WorldScript, clips: readonly (WorldClip | undefined)[]): number {
  const n = script.turns.length + 1;
  for (let k = 0; k < n; k++) if (!clipCurrent(script, k, clips[k])) return k;
  return -1;
}

/** Whether turn k can run now: every earlier turn has a current, finished clip (the world continues from them). */
export function canRun(script: WorldScript, clips: readonly (WorldClip | undefined)[], k: number): boolean {
  for (let i = 0; i < k; i++) if (!clipCurrent(script, i, clips[i]) || !clips[i]?.url) return false;
  return worldProblem(script, k) === null;
}

/**
 * Redo from turn k: the turns before k keep their clips; turn k and every later turn lose theirs (the world after k is
 * made again from k), and their words and moves stay to be run again.
 */
export function redoFrom(clips: readonly (WorldClip | undefined)[], k: number): (WorldClip | undefined)[] {
  return clips.slice(0, Math.max(0, k));
}

/** The clips to join for Export: every turn's, in order, when every turn has a current finished clip; else null. */
export function exportClips(script: WorldScript, clips: readonly (WorldClip | undefined)[]): string[] | null {
  const n = script.turns.length + 1;
  const urls: string[] = [];
  for (let k = 0; k < n; k++) {
    const c = clips[k];
    if (!clipCurrent(script, k, c) || !c?.url) return null;
    urls.push(c.url);
  }
  return urls;
}

/** What a World take carries (a Cinema take's generation and its take.world). */
export interface WorldTakeLike {
  id: string;
  status: string;
  createdAt: number;
  outputs?: { url: string; kind?: string }[];
  take?: { world?: { turn: number; made: string; joined?: boolean } };
}

/** A turn's status on the timeline. */
export type TurnState = "done" | "running" | "failed" | "stale" | "none";

/**
 * The clips of the script's turns from the project's takes: per turn, the newest take made from the script as it is now
 * (nothing up to that turn changed since), made after the turn's last Redo from here (`redoAt[k]`, ms), and made after
 * the clips of the turns before it (the world continues from them, so a take older than one of them was filmed from an
 * earlier chain: this is what keeps a Redo from here after a reload, when `redoAt` is gone). A take that failed or was
 * cancelled is not a clip. Also each turn's state, for the timeline.
 */
export function clipsFromTakes(script: WorldScript, takes: readonly WorldTakeLike[], redoAt: Readonly<Record<number, number>> = {}): { clips: (WorldClip | undefined)[]; states: TurnState[] } {
  const n = script.turns.length + 1;
  const clips: (WorldClip | undefined)[] = [];
  const states: TurnState[] = [];
  const sorted = [...takes].filter((t) => t.take?.world && !t.take.world.joined).sort((a, b) => b.createdAt - a.createdAt);
  let floor = 0;
  for (let k = 0; k < n; k++) {
    const key = scriptKey(script, k);
    const since = Math.max(floor, ...Object.entries(redoAt).filter(([i]) => Number(i) <= k).map(([, at]) => at));
    const mine = sorted.filter((t) => t.take!.world!.turn === k && t.createdAt >= since);
    const current = mine.find((t) => t.take!.world!.made === key && t.status !== "failed" && t.status !== "canceled");
    if (current) {
      const url = current.status === "succeeded" ? current.outputs?.find((o) => !o.kind || o.kind === "video")?.url : undefined;
      clips.push({ generationId: current.id, made: key, ...(url ? { url } : {}) });
      floor = Math.max(floor, current.createdAt);
      states.push(url ? "done" : current.status === "succeeded" ? "failed" : "running");
      continue;
    }
    clips.push(undefined);
    const last = mine[0];
    states.push(!last ? "none" : last.take!.world!.made !== key ? "stale" : last.status === "failed" ? "failed" : "none");
  }
  return { clips, states };
}

/** A turn's label for the timeline ("Opening", "Turn 2 · Arc 90° left · 5 s"). */
export function turnLabel(t: WorldTurn, k: number): string {
  const move = WORLD_MOVES.find((m) => m.id === t.move)?.name ?? "Still";
  return `${k === 0 ? "Opening" : `Turn ${k}`} · ${move} · ${t.seconds} s`;
}

// ---------------------------------------------------------------------------
// The port's turn lengths (nomas/nodes.py turn_frames and NomasWorldGenerate's lengths)

/** Latent frames of a turn (4 video frames each): a camera move makes frames + 1 poses, words alone round(s × 24) frames. */
export function turnLatents(t: Pick<WorldTurn, "move" | "seconds">): number {
  const n = turnFrames(t.seconds);
  return moveKeys(t.move).length ? Math.floor(n / 4) + 1 : Math.floor((Math.max(n, 5) - 1) / 4) + 1;
}

/** Latent frames before turn k: what the graph trims off so only turn k is decoded. */
export function latentsBefore(script: WorldScript, k: number): number {
  return allTurns(script)
    .slice(0, k)
    .reduce((sum, t) => sum + turnLatents(t), 0);
}

/** Seconds turn k's clip runs (VAE Decode makes 4 frames per latent frame). */
export function clipSeconds(t: Pick<WorldTurn, "move" | "seconds">): number {
  return Math.round(((turnLatents(t) * 4) / WORLD_FPS) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Words as the port reads them

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The subject named in the text written as the port's token (case-insensitive, whole words). */
export function withSubject(text: string, subject: string | undefined): string {
  const s = subject?.trim();
  if (!s) return text.trim();
  return text.trim().replace(new RegExp(`\\b${escapeRe(s)}\\b`, "gi"), SUBJECT_TOKEN);
}

/** The opening as Nomas World Prompt's inputs. A scene that never names the subject gets it placed in view. */
export function openingInputs(o: WorldOpening): Record<string, string | number> {
  const subject = o.subject?.trim();
  let scene = withSubject(o.words, subject);
  if (subject && !scene.includes(SUBJECT_TOKEN)) scene = `${scene} ${SUBJECT_TOKEN} is in view.`.trim();
  return {
    perspective: o.perspective ?? "third-person follow",
    style: o.style ?? "real-world footage",
    // A world with no one in it: the camera itself is who the prompt follows.
    subject: subject || "the camera",
    subject_details: o.details?.trim() ?? "",
    scene,
    action: withSubject(o.action ?? "", subject),
    seconds: o.seconds,
  };
}

// ---------------------------------------------------------------------------
// The graph: the opening and every turn up to k chained, turn k decoded and saved

export class WorldGraphError extends Error {}

const linkFrom = (v: unknown): string | undefined => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);

/**
 * world-hy-nomas-turn for turn k of a script: the template's loaders, its opening (Nomas World Prompt → Nomas World,
 * with the opening's camera script or none), one Nomas World Continue per later turn up to k (each with its own camera
 * script or none), then TrimVideoLatent cuts the earlier turns' latents off so VAE Decode, CreateVideo and SaveVideo
 * write turn k alone. Seed, size and steps stay as the bindings set them on the template's Nomas World node. Node ids are
 * the same for the same turn every time (o, c0; t1, c1 …), so ComfyUI reuses the turns it already made.
 */
export function expandWorldWorkflow(template: ComfyWorkflow, script: WorldScript, k: number): ComfyWorkflow {
  const wf: ComfyWorkflow = structuredClone(template);
  const of = (type: string) => Object.keys(wf).filter((id) => wf[id].class_type === type);
  const [promptId] = of("NomasWorldPrompt");
  const [genId] = of("NomasWorldGenerate");
  const [trimId] = of("TrimVideoLatent");
  const cont = of("NomasWorldContinue")[0];
  if (!promptId || !genId || !trimId || !cont) throw new WorldGraphError("This isn't the World graph (Nomas World Prompt, Nomas World, Nomas World Continue and TrimVideoLatent)");
  const problem = worldProblem(script, k);
  if (problem) throw new WorldGraphError(problem);
  const model = wf[genId].inputs.model;
  const clip = wf[genId].inputs.clip;
  const steps = wf[cont].inputs.steps ?? wf[genId].inputs.steps ?? 8;
  // Take the template's turn and camera nodes out: they are rebuilt below.
  const template_ = { gen: wf[genId], prompt: wf[promptId] };
  for (const id of [...of("NomasCameraPath"), ...of("NomasWorldContinue"), promptId, genId]) delete wf[id];

  const cameras: WorldTurnCamera[] = allTurns(script).slice(0, k + 1).map((t) => ({ move: t.move, seconds: t.seconds }));
  const scripts = worldScripts(cameras);
  const subject = script.opening.subject;
  const cam = (i: number): string | null => {
    if (!scripts[i].script) return null;
    const id = `c${i}`;
    wf[id] = { class_type: "NomasCameraPath", inputs: { script: scripts[i].script }, _meta: { title: i === 0 ? "Opening camera move" : `Turn ${i} camera move` } };
    return id;
  };

  wf.o = { class_type: "NomasWorldPrompt", inputs: openingInputs(script.opening), _meta: template_.prompt._meta ?? { title: "Opening turn" } };
  const c0 = cam(0);
  const gen: ComfyNode = { ...template_.gen, inputs: { ...template_.gen.inputs, turn: ["o", 0] } };
  if (c0) gen.inputs.camera = [c0, 0];
  else delete gen.inputs.camera;
  wf.w0 = gen;
  let last = "w0";
  for (let i = 1; i <= k; i++) {
    const t = script.turns[i - 1];
    const ci = cam(i);
    wf[`w${i}`] = {
      class_type: "NomasWorldContinue",
      inputs: {
        model,
        clip,
        world: [last, 1],
        change: withSubject(t.words, subject),
        action: withSubject(t.action ?? "", subject),
        ...(ci ? { camera: [ci, 0] } : {}),
        seconds: t.seconds,
        steps,
      },
      _meta: { title: `World: turn ${i}` },
    };
    last = `w${i}`;
  }
  wf[trimId].inputs.samples = [last, 0];
  wf[trimId].inputs.trim_amount = latentsBefore(script, k);
  // Nothing else may still point at a node taken out.
  for (const n of Object.values(wf)) for (const v of Object.values(n.inputs)) {
    const from = linkFrom(v);
    if (from && !wf[from]) throw new WorldGraphError(`The World graph still links to node ${from}`);
  }
  return wf;
}

/** The opening's size: Hy-Nomas was trained at 1280 × 704. */
export const WORLD_FRAME = WORLD_SIZE;

/** Read a script sent in params.extra.world (null when it isn't one). */
export function readWorld(v: unknown): WorldScript | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<WorldScript>;
  if (!s.opening || typeof s.opening !== "object" || !Array.isArray(s.turns ?? [])) return null;
  return normalizeWorld(s);
}
