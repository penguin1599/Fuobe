"use client";

import { Box, Camera, CircleHelp, Loader2, Package, Route, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { uploadFile, useDeleteUpload, useModelAccess, useStatus } from "@/lib/api";
import { getModel } from "@/lib/catalog";
import { IMAGE_ASPECTS, PATH_MODELS, PATH_RENDER_FIRST, RECOMPOSE_MODELS, planCinema, type CinemaGenerateInput, type DirectorSettings } from "@/lib/catalog/cinema";
import { PATH_FPS, PATH_FRAMES, PHOTO_KEY, addKey, flyPoseOf, framePoses, fromScenePose, keyAt, keyPose, presetKeys, removeKey, renderSize, type CameraKey } from "@/lib/camera-path";
import type { Engine, Generation } from "@/lib/catalog/types";
import { ACCESS_PLACE, offered } from "@/lib/model-access";
import { APERTURE, FLY_KEYS, F_STOPS, LENS, LENS_STOPS, captureSize, formatStop, frameRect, ratioOf, scenePose, twoFinger, type Rect } from "@/lib/scene3d";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { SPLAT_MAX_BYTES } from "@/lib/av/splat-view";
import { MAX_PROPS, bringToCamera, parseSceneState, placeProp, propCandidate as propCandidateOf, sceneStateKey, serializeSceneState, sizeRange, turnOver, type PropCandidate, type SceneProp } from "@/lib/scene-props";
import { useCinemaGenerate } from "./hooks";
import { usePlanPrice, type SceneTake } from "./scene-actions";
import { FilmButton, OPEN_SECONDS, PathKeys, PathOptions } from "./scene-path";
import { WORLDCAST_SECONDS } from "@/lib/catalog/worldcast-plan";
import type { PropHandle, SceneEngine, SceneInfo } from "./scene-engine";
import { AddPropDialog, MakingWatch, PropsPanel, propName } from "./scene-props";

/**
 * The full-screen 3D scene viewer (Higgsfield's "3D Scene", higgsfield-delta-4.md §4.4): fly with W A S D Q E
 * (Shift faster), drag to look, scroll or pinch to move, two fingers to slide; a full-frame lens (18–300 mm),
 * an aperture that previews the depth of field, the project's frame ratios, and Capture, which renders the
 * frame to a PNG, uploads it and queues the recomposition as a new take next to the scene.
 *
 * Fly path (build plan N7-5): keyframe the camera (or pick a move), preview the flight, and "Film this path" films the
 * still along it as a new take: H3 Max camera-controls on the cloud; on the open engine the browser first records the
 * scene along the path, which guides Wan 2.1 through Uni3C on the user's GPU.
 *
 * Props (idol-9): "Add a prop" places a splat (an Idol 3D or TripoSplat result from the Library, or a picture made into
 * one with Idol 3D on your GPU) in the scene with move, turn and size handles. The props are part of the scene's own
 * render, so a capture, a blockout and the open engine's path render (Uni3C's guide) show them; they are kept per
 * scene in this browser.
 */

export interface SceneViewerProps {
  take: SceneTake;
  projectId: string;
  engine: Engine;
  onEngine: (e: Engine) => void;
  settings: DirectorSettings;
  context: { cloudAllowed: boolean; civitai?: boolean; worldcast?: boolean };
  brief: string;
  onClose: () => void;
  /** Blockout to film: the path rendered through the scene (24 fps) handed to the composer as a blockout. */
  /** `type`: the render's own type ("video/mp4", or "video/webm" where the browser can't write MP4). */
  onUseAsBlockout?: (b: { video: string; seconds: number; aspect: string; still: string; type: string }) => void;
}

const SPEEDS = [
  { value: 0.4, label: "Slow" },
  { value: 1, label: "Normal" },
  { value: 2.5, label: "Fast" },
];
const LN_MIN = Math.log(LENS.min);
const LN_MAX = Math.log(LENS.max);
/** The lens slider is logarithmic, so 18–85 mm gets as much room as 85–300 mm. */
const lensToPos = (mm: number) => Math.round(((Math.log(mm) - LN_MIN) / (LN_MAX - LN_MIN)) * 1000);
const posToLens = (pos: number) => Math.round(Math.exp(LN_MIN + (pos / 1000) * (LN_MAX - LN_MIN)));
const clampLens = (mm: number) => Math.max(LENS.min, Math.min(LENS.max, Math.round(mm)));
/** What the planner needs to price a recomposition before anything is captured (and a path before it is recorded). */
const PLACEHOLDER_CAPTURE = "/api/files/placeholder.png";
const PLACEHOLDER_RENDER = "/api/files/placeholder.mp4";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || !!el.closest?.("input,textarea,select,[contenteditable]"));
};

function errorText(e: unknown): string {
  const m = (e as Error)?.message ?? "";
  if (/webgl|context/i.test(m)) return "This browser can't show 3D here (WebGL is off or unavailable). Try another browser, or turn on hardware acceleration.";
  return m || "Couldn't load the scene";
}

function Section({ title, value, children }: { title: string; value?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        {value !== undefined && <span className="font-mono text-[12.5px]">{value}</span>}
      </div>
      {children}
    </section>
  );
}

export default function SceneViewer({ take, projectId, engine, onEngine, settings, context, brief, onClose, onUseAsBlockout }: SceneViewerProps) {
  // Elements in state, not refs: the dialog's portal mounts its content a render after this component.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SceneEngine | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [info, setInfo] = useState<SceneInfo | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [lens, setLens] = useState<number>(LENS.default);
  const [aperture, setAperture] = useState<number>(APERTURE.default);
  const [aspect, setAspect] = useState(take.aspect);
  const [dof, setDof] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [focus, setFocus] = useState<number | null>(null);
  const [help, setHelp] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [picked, setPicked] = useState<string>(RECOMPOSE_MODELS[engine][0]);
  const [note, setNote] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [queued, setQueued] = useState(0);
  // The path: its keys (the first is the still's own camera), the move it came from, and how it is filmed.
  const [keys, setKeys] = useState<CameraKey[]>([PHOTO_KEY]);
  const [preset, setPreset] = useState<string | null>(null);
  const [pathSeconds, setPathSeconds] = useState(5);
  const [pathQuality, setPathQuality] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const [pathOpen, setPathOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [filming, setFilming] = useState<"render" | "send" | null>(null);
  const [progress, setProgress] = useState(0);
  const previewRef = useRef<AbortController | null>(null);
  // Props: kept per scene in this browser; `loaded` is what the current engine holds.
  const stateKey = sceneStateKey(take.generation.id);
  const [props, setProps] = useState<SceneProp[]>(() => {
    try {
      return parseSceneState(localStorage.getItem(stateKey)).props;
    } catch {
      return [];
    }
  });
  const [pickedProp, setPickedProp] = useState<string | null>(null);
  const [handle, setHandle] = useState<PropHandle>("translate");
  const [propLoading, setPropLoading] = useState<Record<string, "loading" | "error">>({});
  const [addOpen, setAddOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [making, setMaking] = useState<string[]>([]);
  const loadedRef = useRef(new Set<string>());
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);
  const generate = useCinemaGenerate(take.generation.projectId ?? projectId);
  const noteId = useId();

  const models = RECOMPOSE_MODELS[engine];
  const modelId = models.includes(picked) ? picked : models[0];
  const input: Omit<CinemaGenerateInput, "brief"> = useMemo(
    () => ({ engine, mode: "image", action: "recompose", modelId, prompt: note, settings, source: { url: take.still, kind: "image" }, aspectRatio: aspect }),
    [engine, modelId, note, settings, take.still, aspect],
  );
  const plan = useMemo(
    () => planCinema({ ...input, brief, capture: { url: PLACEHOLDER_CAPTURE, lens, aperture, pose: { horizontal: 0, vertical: 0, zoom: 5 } } }, context),
    [input, brief, context, lens, aperture],
  );
  const price = usePlanPrice(plan);

  const pathModel = getModel(PATH_MODELS[engine]);
  const qualities = engine === "cloud" ? (pathModel?.options.resolutions ?? []) : [];
  const quality = pathQuality && qualities.includes(pathQuality) ? pathQuality : (pathModel?.defaults?.resolution ?? qualities[0] ?? "");
  const seconds = engine === "open" ? (context.worldcast ? WORLDCAST_SECONDS : OPEN_SECONDS) : pathSeconds;
  const pathInput: Omit<CinemaGenerateInput, "brief"> = useMemo(
    () => ({
      engine,
      mode: "video",
      action: "path",
      prompt: words,
      settings,
      source: { url: take.still, kind: "image" },
      ...(engine === "cloud" && quality ? { resolution: quality } : {}),
      path: { keys, duration: pathSeconds, ...(preset ? { preset } : {}) },
    }),
    [engine, words, settings, take.still, quality, keys, pathSeconds, preset],
  );
  const pathPlan = useMemo(
    () => planCinema({ ...pathInput, brief, path: { ...pathInput.path!, ...(engine === "open" && !context.worldcast ? { render: PLACEHOLDER_RENDER } : {}) } }, context),
    [pathInput, brief, context, engine],
  );
  const pathPrice = usePlanPrice(pathPlan);
  const pathBusy = previewing || !!filming;
  const appStatus = useStatus().data;
  const access = useModelAccess();
  const deleteUpload = useDeleteUpload();

  /**
   * What would refuse an open run anyway, asked before the browser renders every frame and uploads them: the model
   * switched off, or (demo mode off) no ComfyUI to run it on. The server checks again when the run is sent.
   */
  const openRefusal = (): string | undefined => {
    const m = pathPlan.model;
    if (!offered(access, m.id, "open")) return `${m.name} is turned off in ${ACCESS_PLACE}. Turn it back on there, or film on the cloud engine`;
    if (appStatus && !pathPrice.demo && !m.routes.some((r) => appStatus.providers[r.provider]?.configured))
      return m.routes.some((r) => r.provider === "worldcast") ? "Connect the WorldCast worker in Settings to film a path with it" : "Connect ComfyUI in Settings to film a path on your GPU";
    return undefined;
  };

  // The frame: the ratio's largest rectangle, centred, leaving room for the bars over the view.
  const frame: Rect | null = useMemo(() => {
    if (!stage.w || !stage.h) return null;
    const mx = stage.w < 640 ? 12 : 32;
    const my = stage.w < 640 ? 56 : 68;
    const r = frameRect(stage.w - 2 * mx, stage.h - 2 * my, ratioOf(aspect));
    return { ...r, x: r.x + mx, y: r.y + my };
  }, [stage, aspect]);

  // Load three.js and the scene (again on Try again, which mounts a fresh canvas).
  useEffect(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctl = new AbortController();
    let eng: SceneEngine | null = null;
    import("./scene-engine")
      .then(async ({ SceneEngine }) => {
        if (ctl.signal.aborted) return;
        eng = new SceneEngine(canvas);
        engineRef.current = eng;
        loadedRef.current = new Set();
        eng.onFocus = setFocus;
        eng.onPropChange = (id, t) => setProps((ps) => ps.map((p) => (p.id === id ? { ...p, ...t } : p)));
        const { w, h } = sizeRef.current;
        if (w && h) eng.resize(w, h, Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
        const loaded = await eng.load(take.source, { maxPoints: coarse ? 150_000 : 400_000, signal: ctl.signal });
        if (ctl.signal.aborted) return;
        setInfo(loaded);
        setLens(clampLens(loaded.photoLens));
        setStatus("ready");
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setError(errorText(e));
        setStatus("error");
      });
    return () => {
      ctl.abort();
      eng?.dispose();
      engineRef.current = null;
    };
  }, [take.source, canvasEl, coarse]);

  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    // Layout size, not getBoundingClientRect: the dialog opens with a zoom, which a transform-aware size would keep.
    const measure = () => {
      const r = { width: el.clientWidth, height: el.clientHeight };
      sizeRef.current = { w: r.width, h: r.height };
      setStage({ w: r.width, h: r.height });
      engineRef.current?.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [stageEl, coarse]);

  useEffect(() => {
    if (frame && status === "ready") engineRef.current?.setView({ lens, aperture, aspect: ratioOf(aspect), dof, frame, speed });
  }, [lens, aperture, aspect, dof, frame, speed, status]);

  // Props into the engine: new ones load (Spark comes with the first), changed ones move, removed ones go.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || status !== "ready") return;
    const loaded = loadedRef.current;
    for (const p of props) {
      if (loaded.has(p.id)) {
        eng.updateProp(p);
        continue;
      }
      loaded.add(p.id);
      setPropLoading((m) => ({ ...m, [p.id]: "loading" }));
      eng
        .addProp(p, { maxBytes: coarse ? SPLAT_MAX_BYTES.coarse : SPLAT_MAX_BYTES.fine })
        .then(() => {
          if (engineRef.current !== eng) return;
          // The latest state of it (a slider may have moved while it loaded).
          const now = propsRef.current.find((x) => x.id === p.id);
          if (now) eng.updateProp(now);
          else eng.removeProp(p.id);
          setPropLoading((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== p.id)));
        })
        .catch((e) => {
          if (engineRef.current !== eng || (e as Error).name === "AbortError") return;
          setPropLoading((m) => ({ ...m, [p.id]: "error" }));
        });
    }
    for (const id of [...loaded]) {
      if (props.some((p) => p.id === id)) continue;
      loaded.delete(id);
      eng.removeProp(id);
    }
  }, [props, status, coarse]);

  useEffect(() => {
    try {
      if (props.length) localStorage.setItem(stateKey, serializeSceneState({ version: 1, props }));
      else localStorage.removeItem(stateKey);
    } catch {}
  }, [props, stateKey]);

  // The handle sits on the picked prop once it has loaded.
  const pickedReady = !!pickedProp && props.some((p) => p.id === pickedProp) && !propLoading[pickedProp];
  useEffect(() => {
    if (status === "ready") engineRef.current?.pickProp(pickedReady ? pickedProp : null, handle);
  }, [pickedProp, pickedReady, handle, status]);

  /** Place a Library splat in the scene; says why not when it can't (the scene isn't ready, or it is full). */
  const placeCandidate = useCallback(
    (c: PropCandidate & { name: string }): "placed" | "not-ready" | "full" => {
      const eng = engineRef.current;
      if (!eng || !info) return "not-ready";
      const ps = propsRef.current;
      if (ps.length >= MAX_PROPS) return "full";
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const next = [...ps, placeProp(c, eng.getPose(), info.pivotDepth, ps.length, id)];
      propsRef.current = next;
      setProps(next);
      setPickedProp(id);
      setHandle("translate");
      setAddOpen(false);
      return "placed";
    },
    [info],
  );

  const madeProp = useCallback(
    (id: string, g: Generation | null) => {
      setMaking((m) => m.filter((x) => x !== id));
      const c = g && propCandidateOf(g);
      if (c) {
        const placed = placeCandidate({ ...c, name: propName(c.modelId) });
        if (placed === "placed") toast.success("Your prop is in the scene");
        else if (placed === "full") toast.info(`Your prop is ready in your Library. The scene holds ${MAX_PROPS} props: remove one, then add it from Add a prop`);
        else toast.info("Your prop is ready in your Library. Add it to the scene from Add a prop");
      } else toast.error("Couldn't make the prop from that picture. Try another picture, with one object on a plain background");
    },
    [placeCandidate],
  );

  const changeProp = (id: string, f: (p: SceneProp) => SceneProp) => setProps((ps) => ps.map((p) => (p.id === id ? f(p) : p)));
  const propSizes = sizeRange(info?.pivotDepth ?? 1);
  const propNote =
    engine === "cloud"
      ? "Props show in captures and blockouts. Filming on the cloud follows the still itself, so they don't show there; film on your GPU to keep them."
      : context.worldcast
        ? "Props show in captures and blockouts. WorldCast films from the still's depth, so they don't show there."
        : "Props show in captures, blockouts and the path filmed on your GPU.";

  // The camera of a key as the path films it: the still's own lens (a key's distance already counts the lens it was set with).
  const goTo = (i: number) => {
    const eng = engineRef.current;
    if (!eng || !info || !keys[i]) return;
    setLens(clampLens(info.photoLens));
    eng.setPose(flyPoseOf(keyPose(keys[i], info.pivotDepth)));
  };

  const addKeyframe = () => {
    const eng = engineRef.current;
    if (!eng || !info || pathBusy) return;
    const last = keys[keys.length - 1];
    const k = fromScenePose(scenePose(eng.getPose(), lens, info.photoLens, info.pivotDepth), 1, last.azimuth);
    if (Math.abs(k.azimuth - last.azimuth) < 0.5 && Math.abs(k.elevation - last.elevation) < 0.5 && Math.abs(k.distance / last.distance - 1) < 0.02) {
      toast.info("Fly the camera somewhere new first, then add a keyframe");
      return;
    }
    setKeys(addKey(keys, k));
    setPreset(null);
  };
  // K on the view adds a keyframe (the key listener is set up once).
  const onKeyframeKey = useEffectEvent(() => addKeyframe());

  // W A S D Q E fly from anywhere in the viewer except a text field; arrows and R act on the focused view.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng) return;
      eng.setBoost(e.shiftKey);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (FLY_KEYS.has(e.code)) {
        e.preventDefault();
        eng.key(e.code, true);
        return;
      }
      if (e.target !== canvasRef.current) return;
      const turn: Record<string, [number, number]> = { ArrowLeft: [3, 0], ArrowRight: [-3, 0], ArrowUp: [0, 3], ArrowDown: [0, -3] };
      if (turn[e.key]) {
        e.preventDefault();
        eng.turn(...turn[e.key]);
      } else if (e.code === "KeyR") eng.reset();
      else if (e.code === "KeyK") onKeyframeKey();
    };
    const up = (e: KeyboardEvent) => {
      engineRef.current?.key(e.code, false);
      engineRef.current?.setBoost(e.shiftKey);
    };
    const release = () => engineRef.current?.releaseKeys();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, []);

  const pickPreset = (id: string) => {
    const k = presetKeys(id);
    if (!k) return;
    setKeys(k);
    setPreset(id);
  };

  const preview = async () => {
    const eng = engineRef.current;
    if (previewing) {
      previewRef.current?.abort();
      return;
    }
    if (!eng || !info || keys.length < 2 || filming) return;
    setPathOpen(false);
    const ctl = new AbortController();
    previewRef.current = ctl;
    const lensBefore = lens;
    setLens(clampLens(info.photoLens));
    setPreviewing(true);
    try {
      await eng.playPath((t) => flyPoseOf(keyPose(keyAt(keys, t), info.pivotDepth)), seconds, ctl.signal);
    } finally {
      setPreviewing(false);
      setLens(lensBefore);
    }
  };

  const filmPath = async () => {
    const eng = engineRef.current;
    if (!eng || !info || filming || previewing) return;
    const blocker = (pathPlan.blocker && pathPlan.blocker !== PATH_RENDER_FIRST ? pathPlan.blocker : undefined) ?? (engine === "open" ? openRefusal() : undefined);
    if (blocker) {
      toast.error(blocker);
      return;
    }
    setPathOpen(false);
    let uploaded: string | undefined;
    try {
      let render: string | undefined;
      // WorldCast (N7-9) renders the path on the server from the still's depth: nothing to record here.
      if (engine === "open" && !context.worldcast) {
        // The still's own view along the path: Uni3C's guide, in the still's shape (the open run keeps it).
        setFilming("render");
        setProgress(0);
        const poses = framePoses(keys, PATH_FRAMES, info.pivotDepth, info.photoFov.h, renderSize(info.photoAspect));
        const rec = await eng.recordPath(poses, { fps: PATH_FPS, onProgress: setProgress });
        const ext = rec.type.includes("mp4") ? "mp4" : "webm";
        setFilming("send");
        const asset = await uploadFile(new File([rec.render], `path-render.${ext}`, { type: rec.type }));
        uploaded = asset.id;
        render = asset.url;
      } else setFilming("send");
      await generate.mutateAsync({ input: { ...pathInput, path: { ...pathInput.path!, ...(render ? { render } : {}) } }, folderId: take.generation.folderId });
      setQueued((n) => n + 1);
      toast.success("Filming this path — it lands next to the scene as a new take", { duration: 3000 });
    } catch (e) {
      // A render the run didn't take isn't left in Uploads (the server refuses to delete one that is used).
      if (uploaded) deleteUpload.mutate(uploaded);
      // Closing the viewer stops a recording: nothing to report then.
      if ((e as Error).name !== "AbortError") toastError(e, "Couldn't film this path");
    } finally {
      setFilming(null);
    }
  };

  /** The path rendered through the scene at 24 fps for its length, then handed to the Blockout composer with the still. */
  const takeAsBlockout = async () => {
    const eng = engineRef.current;
    if (!eng || !info || filming || previewing || !onUseAsBlockout) return;
    if (keys.length < 2) {
      toast.error("Add a keyframe or pick a move first");
      return;
    }
    setPathOpen(false);
    try {
      setFilming("render");
      setProgress(0);
      const fps = 24;
      const frames = Math.max(2, Math.round(pathSeconds * fps));
      const poses = framePoses(keys, frames, info.pivotDepth, info.photoFov.h, renderSize(info.photoAspect, 1280));
      const rec = await eng.recordPath(poses, { fps, mp4: true, onProgress: setProgress });
      setFilming("send");
      const asset = await uploadFile(new File([rec.render], `blockout-path.${rec.type.includes("mp4") ? "mp4" : "webm"}`, { type: rec.type }));
      onUseAsBlockout({ video: asset.url, seconds: Math.round((frames / fps) * 100) / 100, aspect, still: take.still, type: rec.type });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toastError(e, "Couldn't render the path as a blockout");
    } finally {
      setFilming(null);
    }
  };

  const blockoutButton = (className?: string) =>
    onUseAsBlockout ? (
      <Button variant="secondary" onClick={() => void takeAsBlockout()} disabled={status !== "ready" || previewing || !!filming || keys.length < 2} className={cn("rounded-full", className)}>
        <Box /> Use as blockout
      </Button>
    ) : null;

  const resetView = () => {
    engineRef.current?.reset();
    if (info) setLens(clampLens(info.photoLens));
  };

  const capture = async () => {
    const eng = engineRef.current;
    if (!eng || !info || capturing) return;
    const blocker = plan.blocker && plan.blocker !== "Capture a view first" ? plan.blocker : undefined;
    if (blocker) {
      toast.error(blocker);
      return;
    }
    setCapturing(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const { width, height } = captureSize(ratioOf(aspect));
      const blob = await eng.capture(width, height);
      const asset = await uploadFile(new File([blob], "capture.png", { type: "image/png" }));
      const pose = scenePose(eng.getPose(), lens, info.photoLens, info.pivotDepth);
      await generate.mutateAsync({ input: { ...input, capture: { url: asset.url, lens, aperture, pose } }, folderId: take.generation.folderId });
      setQueued((n) => n + 1);
      toast.success("Re-rendering this view — it lands next to the scene as a new take", { duration: 3000 });
    } catch (e) {
      toastError(e, "Couldn't capture this view");
    } finally {
      setCapturing(false);
    }
  };

  const kind = info?.kind ?? take.source.kind;
  const sizeText = info ? `${info.size >= 1000 ? `${Math.round(info.size / 1000)}k` : info.size} ${info.kind === "points" ? "points" : "triangles"}` : null;
  const captureLabel = capturing ? "Capturing…" : "Capture";

  const camera = (
    <div className="space-y-6">
      <Section title="Lens" value={`${lens} mm`}>
        <Slider
          min={0}
          max={1000}
          step={1}
          value={[lensToPos(lens)]}
          onValueChange={([v]) => setLens(clampLens(posToLens(v)))}
          aria-label="Lens focal length"
          aria-valuetext={`${lens} millimetres`}
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Lens presets">
          {LENS_STOPS.map((mm) => (
            <button
              key={mm}
              type="button"
              aria-pressed={lens === mm}
              aria-label={`${mm} mm`}
              onClick={() => setLens(mm)}
              className={cn("h-7 rounded-full px-2.5 font-mono text-[11.5px]", lens === mm ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}
            >
              {mm}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Aperture" value={`f/${formatStop(aperture)}`}>
        <Slider
          min={0}
          max={F_STOPS.length - 1}
          step={1}
          value={[Math.max(0, F_STOPS.indexOf(aperture))]}
          onValueChange={([i]) => setAperture(F_STOPS[i])}
          aria-label="Aperture"
          aria-valuetext={`f/${formatStop(aperture)}`}
        />
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span>
            Preview depth of field
            <span className="block text-[11.5px] text-muted-foreground">{focus ? `Focused at ${focus.toFixed(1)} m, on the centre of the frame` : "Focuses on the centre of the frame"}</span>
          </span>
          <Switch checked={dof} onCheckedChange={setDof} aria-label="Preview depth of field" />
        </label>
      </Section>
      <Section title="Frame" value={aspect}>
        <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Frame ratio">
          {IMAGE_ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={aspect === a}
              onClick={() => setAspect(a)}
              className={cn("h-8 rounded-lg font-mono text-[11.5px]", aspect === a ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")}
            >
              {a}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Speed">
        <div className="inline-flex h-8 rounded-full bg-muted p-0.5" role="radiogroup" aria-label="Flying speed">
          {SPEEDS.map((s) => (
            <button
              key={s.label}
              type="button"
              role="radio"
              aria-checked={speed === s.value}
              onClick={() => setSpeed(s.value)}
              className={cn("rounded-full px-3 text-[12.5px] font-medium", speed === s.value ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );

  const rerender = (
    <div className="space-y-3">
      <Section title="Re-render">
        <EngineSwitch value={engine} onChange={onEngine} size="sm" />
        {models.length > 1 ? (
          <Select value={modelId} onValueChange={setPicked}>
            <SelectTrigger className="w-full" aria-label="Re-render with">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((id) => (
                <SelectItem key={id} value={id}>
                  {getModel(id)?.name ?? id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-[13px]">{getModel(modelId)?.name} + Multiple-Angles LoRA</p>
        )}
        <label htmlFor={noteId} className="sr-only">
          Anything to change (optional)
        </label>
        <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to change? (optional) e.g. “golden hour”" className="min-h-16 text-[13px]" maxLength={2000} />
        {plan.notes.map((n) => (
          <p key={n} className="text-[12px] leading-snug text-muted-foreground">
            {n}
          </p>
        ))}
      </Section>
    </div>
  );

  const propsPanel = (
    <PropsPanel
      props={props}
      picked={pickedProp}
      onPick={setPickedProp}
      handle={handle}
      onHandle={setHandle}
      loading={propLoading}
      making={making.length}
      sizeRange={propSizes}
      onChange={(p) => changeProp(p.id, () => p)}
      onRemove={(id) => {
        setProps((ps) => ps.filter((p) => p.id !== id));
        if (pickedProp === id) setPickedProp(null);
      }}
      onBring={(id) => {
        const eng = engineRef.current;
        if (eng && info) changeProp(id, (p) => bringToCamera(p, eng.getPose(), info.pivotDepth));
      }}
      onTurnOver={(id) => changeProp(id, turnOver)}
      onAdd={() => setAddOpen(true)}
      disabled={status !== "ready" || pathBusy}
      note={propNote}
    />
  );

  const pathKeys = (tone: "overlay" | "panel") => (
    <PathKeys
      keys={keys}
      seconds={seconds}
      disabled={status !== "ready" || pathBusy}
      previewing={previewing}
      onAdd={addKeyframe}
      onRemove={(i) => {
        setKeys(removeKey(keys, i));
        setPreset(null);
      }}
      onGoTo={goTo}
      onPreview={() => void preview()}
      tone={tone}
    />
  );

  const pathOptions = (
    <PathOptions
      engine={engine}
      preset={preset}
      onPreset={pickPreset}
      duration={pathSeconds}
      onDuration={setPathSeconds}
      resolution={quality}
      resolutions={qualities}
      onResolution={setPathQuality}
      words={words}
      onWords={setWords}
      notes={pathPlan.notes}
      worldcast={engine === "open" && !!context.worldcast}
      disabled={status !== "ready" || pathBusy}
    />
  );

  const filmButton = (className?: string) => (
    <FilmButton
      onClick={() => void filmPath()}
      busy={filming}
      progress={progress}
      price={pathPrice.label}
      disabled={status !== "ready" || previewing || keys.length < 2}
      className={className}
    />
  );

  const captureButton = (className?: string) => (
    <Button onClick={() => void capture()} disabled={status !== "ready" || capturing} className={cn("rounded-full", className)}>
      {capturing ? <Loader2 className="animate-spin" /> : <Camera />} {captureLabel} <span className="opacity-80">· {price.label}</span>
    </Button>
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          canvasRef.current?.focus();
        }}
        className="flex h-[100svh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none md:flex-row"
      >
        <DialogTitle className="sr-only">3D scene</DialogTitle>
        <DialogDescription className="sr-only">Fly the camera through the scene, frame a view and capture it to re-render it as a new take.</DialogDescription>
        <div ref={setStageEl} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0b0b0c]">
          <canvas
            key={attempt}
            ref={(el) => {
              canvasRef.current = el;
              setCanvasEl(el);
            }}
            tabIndex={0}
            role="application"
            aria-roledescription="3D view"
            aria-label="3D scene. W A S D to move, Q and E to go down and up, Shift to go faster, arrow keys to look around, R to reset the view."
            className="absolute inset-0 size-full cursor-grab touch-none outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onPointerDown={(e) => {
              // The prop's handle takes this drag.
              if (engineRef.current?.handleActive()) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }}
            onPointerMove={(e) => {
              const map = pointers.current;
              const prev = map.get(e.pointerId);
              const eng = engineRef.current;
              if (!prev || !eng) return;
              // The scene follows the pointer: drag right and the view turns left.
              if (map.size === 1) {
                map.set(e.pointerId, { x: e.clientX, y: e.clientY });
                eng.look(-(e.clientX - prev.x), -(e.clientY - prev.y));
                return;
              }
              const ids = [...map.keys()].slice(0, 2);
              if (!ids.includes(e.pointerId)) return;
              const before = ids.map((id) => map.get(id)!) as [{ x: number; y: number }, { x: number; y: number }];
              map.set(e.pointerId, { x: e.clientX, y: e.clientY });
              const after = ids.map((id) => map.get(id)!) as [{ x: number; y: number }, { x: number; y: number }];
              const g = twoFinger(before, after);
              eng.pan(g.dx, g.dy);
              if (g.scale !== 1) eng.dolly(Math.log(g.scale) * 0.8);
            }}
            onPointerUp={(e) => pointers.current.delete(e.pointerId)}
            onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
            onWheel={(e) => engineRef.current?.dolly(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))}
          />
          {frame && (
            <div
              aria-hidden
              className={cn("pointer-events-none absolute rounded-[2px] border border-white/70 transition-[background-color] duration-150", flash && "bg-white/60")}
              style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, boxShadow: "0 0 0 100vmax rgba(0,0,0,0.55)" }}
            >
              <span className="absolute top-1.5 left-1.5 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-white/90">
                {aspect} · {lens} mm · f/{formatStop(aperture)}
              </span>
            </div>
          )}

          <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pt-2.5 pb-6 text-white sm:px-4">
            <Box className="size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">3D scene</p>
              <p className="truncate text-[11.5px] text-white/70">
                {kind === "points" ? "Point cloud from a depth map" : info?.layout === "object" ? "3D model" : "MoGe 2 mesh"}
                {sizeText ? ` · ${sizeText}` : ""}
                {props.length ? ` · ${props.length} prop${props.length > 1 ? "s" : ""}` : ""}
                {queued ? ` · ${queued} new take${queued > 1 ? "s" : ""} queued` : ""}
              </p>
            </div>
            <button type="button" onClick={() => setHelp((v) => !v)} aria-pressed={help} aria-label="Controls" className="grid size-9 place-items-center rounded-full hover:bg-white/15">
              <CircleHelp className="size-[18px]" />
            </button>
            <button type="button" onClick={resetView} aria-label="Reset the view to the still" className="grid size-9 place-items-center rounded-full hover:bg-white/15">
              <RotateCcw className="size-[18px]" />
            </button>
            <button type="button" onClick={onClose} aria-label="Close the 3D scene" className="grid size-9 place-items-center rounded-full hover:bg-white/15">
              <X className="size-5" />
            </button>
          </div>

          {/* Wide screens: the path's keys over the view, beside the frame (phones get them in the Path sheet). */}
          {status === "ready" && (
            <div className="absolute inset-x-3 bottom-3 hidden justify-center md:flex">
              <div role="group" aria-label="Fly path" className="flex max-w-full min-w-0 items-center gap-2 rounded-full bg-black/65 py-1 pr-1 pl-3 text-white backdrop-blur">
                <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium">
                  <Route className="size-3.5" aria-hidden /> Path
                </span>
                {pathKeys("overlay")}
              </div>
            </div>
          )}

          {help && status === "ready" && (
            <div className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] rounded-xl bg-black/65 px-3 py-2 text-[12px] leading-relaxed text-white/90 backdrop-blur md:bottom-16">
              {coarse ? (
                <p>Drag to look · two fingers to move · pinch to go forward or back</p>
              ) : (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    <Kbd>W</Kbd> <Kbd>A</Kbd> <Kbd>S</Kbd> <Kbd>D</Kbd> move
                  </span>
                  <span>
                    <Kbd>Q</Kbd> <Kbd>E</Kbd> down / up
                  </span>
                  <span>
                    <Kbd>Shift</Kbd> faster
                  </span>
                  <span>drag to look · scroll to go forward</span>
                  <span>
                    <Kbd>K</Kbd> keyframe
                  </span>
                </p>
              )}
            </div>
          )}

          {status !== "ready" && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-white" role="status">
              {status === "loading" ? (
                <p className="flex items-center gap-2 text-[14px]">
                  <Loader2 className="size-4 animate-spin" /> {take.source.kind === "points" ? "Building the point cloud from the depth map…" : "Loading the 3D scene…"}
                </p>
              ) : (
                <div className="max-w-sm space-y-3">
                  <p className="text-[14px]">{error}</p>
                  <div className="flex justify-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setStatus("loading");
                        setInfo(null);
                        setAttempt((n) => n + 1);
                      }}
                    >
                      Try again
                    </Button>
                    <Button variant="ghost" className="text-white hover:bg-white/15 hover:text-white" onClick={onClose}>
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Phones: the capture stays in reach; the camera and re-render settings open in a sheet. */}
        <div className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#0b0b0c] px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          <Button variant="secondary" size="icon" className="shrink-0 rounded-full" onClick={() => setPanelOpen(true)} aria-label="Camera" title="Camera: lens, aperture, frame">
            <SlidersHorizontal />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="relative shrink-0 rounded-full"
            onClick={() => setPropsOpen(true)}
            disabled={status !== "ready"}
            aria-label={`Props, ${props.length} in the scene`}
            title="Props: objects in the scene"
          >
            <Package />
            {props.length > 0 && <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">{props.length}</span>}
          </Button>
          <Button variant="secondary" className="shrink-0 rounded-full px-3" onClick={() => setPathOpen(true)} disabled={status !== "ready"} aria-label={`Path, ${keys.length - 1} keyframe${keys.length === 2 ? "" : "s"}`}>
            {filming ? <Loader2 className="animate-spin" /> : <Route />} Path{keys.length > 1 ? ` · ${keys.length - 1}` : ""}
          </Button>
          {captureButton("min-w-0 flex-1")}
        </div>
        <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
          <SheetContent side="bottom" className="max-h-[75svh] gap-0 overflow-y-auto rounded-t-2xl p-0 md:hidden">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="font-heading text-[20px] font-normal">Camera</SheetTitle>
              <SheetDescription className="sr-only">Lens, aperture, frame and how the capture is re-rendered</SheetDescription>
            </SheetHeader>
            <div className="space-y-6 p-4">
              {camera}
              {rerender}
              {captureButton("w-full")}
            </div>
          </SheetContent>
        </Sheet>
        <Sheet open={propsOpen} onOpenChange={setPropsOpen}>
          <SheetContent side="bottom" className="max-h-[80svh] gap-0 overflow-y-auto rounded-t-2xl p-0 md:hidden">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="font-heading text-[20px] font-normal">Props</SheetTitle>
              <SheetDescription className="text-[12.5px]">Objects made from pictures, placed in the scene. Pick one, close this and drag its handle in the view.</SheetDescription>
            </SheetHeader>
            <div className="p-4">{propsPanel}</div>
          </SheetContent>
        </Sheet>
        <Sheet open={pathOpen} onOpenChange={setPathOpen}>
          <SheetContent side="bottom" className="max-h-[80svh] gap-0 overflow-y-auto rounded-t-2xl p-0 md:hidden">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="font-heading text-[20px] font-normal">Fly path</SheetTitle>
              <SheetDescription className="text-[12.5px]">Fly the camera, add keyframes or pick a move, then film the still along the path.</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 p-4">
              {pathKeys("panel")}
              {pathOptions}
              <EngineSwitch value={engine} onChange={onEngine} size="sm" />
              {filmButton("w-full")}
              {blockoutButton("w-full")}
            </div>
          </SheetContent>
        </Sheet>

        <aside className="hidden w-[320px] shrink-0 flex-col border-l bg-background md:flex" aria-label="Camera and re-render">
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            {camera}
            <Section title="Props">{propsPanel}</Section>
            {rerender}
            <Section title="Fly path">{pathOptions}</Section>
          </div>
          <div className="space-y-1.5 border-t p-4">
            {captureButton("w-full")}
            {filmButton("w-full")}
            {blockoutButton("w-full")}
            <p className="text-center text-[11.5px] text-muted-foreground">Capture re-renders the frame; Film follows the path. Both land next to the scene</p>
          </div>
        </aside>
        <AddPropDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onPlace={placeCandidate}
          onMaking={(id) => {
            setMaking((m) => [...m, id]);
            setAddOpen(false);
            toast.success("Making your prop — it lands in the scene when it's ready", { duration: 3000 });
          }}
          full={props.length + making.length >= MAX_PROPS}
        />
        {making.length > 0 && <MakingWatch ids={making} onDone={madeProp} />}
      </DialogContent>
    </Dialog>
  );
}
