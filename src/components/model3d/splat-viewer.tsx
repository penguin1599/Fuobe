"use client";

import { Camera, FlipVertical2, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { uploadFile, useViewer } from "@/lib/api";
import { backgroundColor, FALLBACK_TEXT, HAZE_MAX, HAZE_STEP, SPLAT_BACKGROUNDS, SPLAT_MAX_BYTES, stillFileName, type SplatBackground } from "@/lib/av/splat-view";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import type { SplatEngine } from "./splat-engine";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the user prefers reduced motion (true until hydrated, so nothing moves before it's known). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );
}

let webgl2: boolean | undefined;
/** Whether this browser draws WebGL2 (checked once; false before hydration). */
export function hasWebgl2(): boolean {
  if (typeof document === "undefined") return false;
  if (webgl2 === undefined) {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      webgl2 = !!gl;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

const isCoarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

type Status = "loading" | "ready" | "too-big" | "error";

/**
 * Look around a Gaussian splat (.spz / .ply / .ksplat): drag to turn it, pinch or scroll to zoom, the arrow keys and
 * + / − from the keyboard, Reset view, a light / grey / dark background, "Hide faint haze" (an opacity cut-off) and
 * "Save a still" to the Library. The renderer (Spark on three.js) loads only when this mounts; the poster shows
 * until the splat is drawn, and a file the device can't take leaves the poster with a note.
 */
export function SplatViewer({
  url,
  format,
  poster,
  name,
  defaultCutoff,
  tone = "card",
  label = "the splat",
  autoFocus = false,
  onUnavailable,
}: {
  url: string;
  format: string;
  poster?: string;
  name: string;
  defaultCutoff: number;
  /** "card": compact controls on a result card; "panel": the full-screen viewer's dark stage. */
  tone?: "card" | "panel";
  label?: string;
  autoFocus?: boolean;
  /** The viewer can't open this file here (too big, no WebGL, it failed): the caller shows its fallback. */
  onUnavailable?: (reason: string) => void;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SplatEngine | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState(0);
  const [cutoff, setCutoff] = useState(defaultCutoff);
  const { resolvedTheme } = useTheme();
  const [background, setBackground] = useState<SplatBackground>(() => (tone === "panel" ? "dark" : resolvedTheme === "dark" ? "dark" : "light"));
  const [saving, setSaving] = useState(false);
  // "Save a still" waits until who is viewing is known: a guest can't save (the upload would be refused).
  const viewer = useViewer().data;
  const canSave = !!viewer && !(viewer.publicSignup && !viewer.signedIn);
  const helpId = useId();
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => void (onUnavailableRef.current = onUnavailable));
  const cutoffRef = useRef(cutoff);
  const backgroundRef = useRef(background);

  // Load Spark and the file (again for another file).
  useEffect(() => {
    if (!canvas) return;
    const ctl = new AbortController();
    let eng: SplatEngine | null = null;
    const coarse = isCoarse();
    import("./splat-engine")
      .then(async ({ SplatEngine, SplatTooBigError }) => {
        if (ctl.signal.aborted) return;
        eng = new SplatEngine(canvas, () => {
          // The browser took the WebGL context back (too many open, or the GPU reset): show the fallback.
          if (ctl.signal.aborted) return;
          setStatus("error");
          onUnavailableRef.current?.("The 3D view stopped here. Open it again, or download the file to look around it in a splat viewer.");
        });
        engineRef.current = eng;
        const el = stageRef.current;
        if (el) eng.resize(el.clientWidth, el.clientHeight, Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
        eng.setBackground(backgroundColor(backgroundRef.current));
        eng.setCutoff(cutoffRef.current);
        try {
          await eng.load(url, format, { signal: ctl.signal, maxBytes: coarse ? SPLAT_MAX_BYTES.coarse : SPLAT_MAX_BYTES.fine, onProgress: setProgress });
          if (!ctl.signal.aborted) setStatus("ready");
        } catch (e) {
          if (ctl.signal.aborted) return;
          if (e instanceof SplatTooBigError) {
            setStatus("too-big");
            onUnavailableRef.current?.(FALLBACK_TEXT["too-big"]);
          } else throw e;
        }
      })
      .catch(() => {
        if (ctl.signal.aborted) return;
        setStatus("error");
        onUnavailableRef.current?.("The 3D view couldn't open here. Download the file to look around it in a splat viewer.");
      });
    return () => {
      ctl.abort();
      eng?.dispose();
      engineRef.current = null;
    };
  }, [canvas, url, format]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const coarse = isCoarse();
    const ro = new ResizeObserver(() => engineRef.current?.resize(el.clientWidth, el.clientHeight, Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    cutoffRef.current = cutoff;
    engineRef.current?.setCutoff(cutoff);
  }, [cutoff]);
  useEffect(() => {
    backgroundRef.current = background;
    engineRef.current?.setBackground(backgroundColor(background));
  }, [background]);
  // The stage takes ArrowLeft / ArrowRight only once the user has reached for it (tabbed to it, pressed on it, used
  // one of its keys, or chose to open it). A dialog that focuses it by itself on opening leaves those two keys to
  // the page, so the full-screen viewer keeps browsing the results.
  const engaged = useRef(false);
  const tabbed = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => void (tabbed.current = e.key === "Tab");
    const onPointer = () => void (tabbed.current = false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  useEffect(() => {
    if (!autoFocus || status !== "ready") return;
    engaged.current = true;
    stageRef.current?.focus({ preventScroll: true });
  }, [autoFocus, status]);

  const ready = status === "ready";
  const onKey = (e: React.KeyboardEvent) => {
    const eng = engineRef.current;
    if (!eng || !ready || e.altKey || e.metaKey || e.ctrlKey) return;
    const step = Math.PI / 12;
    const act: Record<string, () => void> = {
      ArrowLeft: () => eng.orbit(-step, 0),
      ArrowRight: () => eng.orbit(step, 0),
      ArrowUp: () => eng.orbit(0, step),
      ArrowDown: () => eng.orbit(0, -step),
      "+": () => eng.zoom(0.85),
      "=": () => eng.zoom(0.85),
      "-": () => eng.zoom(1 / 0.85),
      "0": () => eng.reset(),
      Home: () => eng.reset(),
    };
    const fn = act[e.key];
    if (!fn) return;
    if (!engaged.current && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    engaged.current = true;
    e.preventDefault();
    fn();
  };

  const saveStill = async () => {
    const eng = engineRef.current;
    if (!eng) return;
    setSaving(true);
    try {
      const blob = await eng.capture();
      await uploadFile(new File([blob], stillFileName(name), { type: "image/png" }));
      toast.success("Still saved to your Library (Uploads)");
    } catch (e) {
      toastError(e, "Couldn't save the still");
    } finally {
      setSaving(false);
    }
  };

  const panel = tone === "panel";
  const haze = (
    <div className={cn("flex items-center gap-2", panel ? "w-56" : "w-full")}>
      <label id={`${helpId}-haze`} className="shrink-0 text-[12px] font-medium">
        Hide faint haze
      </label>
      <Slider
        aria-labelledby={`${helpId}-haze`}
        aria-valuetext={cutoff === 0 ? "Off: every Gaussian drawn" : `Under ${Math.round(cutoff * 100)}% opacity hidden`}
        min={0}
        max={HAZE_MAX}
        step={HAZE_STEP}
        value={[cutoff]}
        onValueChange={([v]) => setCutoff(v)}
        disabled={!ready}
        className="min-w-20 flex-1"
      />
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums opacity-80">{cutoff === 0 ? "Off" : `${Math.round(cutoff * 100)}%`}</span>
    </div>
  );

  return (
    // Touches stay here: a drag that turns the splat isn't a swipe to the next result (the studio viewer's).
    <div className="relative size-full overflow-hidden" style={{ background: backgroundColor(background) }} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-roledescription="3D viewer"
        aria-label={`Look around ${label}`}
        aria-describedby={helpId}
        aria-busy={!ready}
        onKeyDown={onKey}
        onFocus={() => void (engaged.current ||= tabbed.current)}
        onBlur={() => void (engaged.current = false)}
        onPointerDown={() => void (engaged.current = true)}
        className="absolute inset-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <canvas ref={setCanvas} className={cn("size-full transition-opacity", ready ? "opacity-100" : "opacity-0")} />
        <p id={helpId} className="sr-only">
          Drag to turn it, pinch or scroll to zoom. From the keyboard: the arrow keys turn it, plus and minus zoom, 0 resets the view.
        </p>
      </div>
      {!ready && (
        <div className="pointer-events-none absolute inset-0" role="status" aria-label={status === "loading" ? "Loading the 3D view" : undefined}>
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} alt="" className="size-full object-contain p-4" />
          )}
          {status === "loading" && (
            <span className={cn("absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shadow-soft", panel ? "bg-white/15 text-white" : "bg-background/85")}>
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> {progress > 0 && progress < 1 ? `Loading ${Math.round(progress * 100)}%` : "Loading the 3D view"}
            </span>
          )}
        </div>
      )}
      {ready && (
        <div
          role="toolbar"
          aria-label="3D view"
          className={cn(
            "absolute inset-x-2 bottom-2 flex flex-wrap items-center justify-center gap-1 rounded-2xl px-1.5 py-1 shadow-soft backdrop-blur sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2",
            panel ? "bg-black/55 text-white" : "bg-background/85 text-foreground",
          )}
        >
          <IconButton text="Reset view" panel={panel} onClick={() => engineRef.current?.reset()}>
            <RotateCcw className="size-3.5" />
          </IconButton>
          <IconButton text="Turn it over" panel={panel} onClick={() => engineRef.current?.flip()}>
            <FlipVertical2 className="size-3.5" />
          </IconButton>
          <div role="radiogroup" aria-label="Background" className="flex items-center gap-1 px-1">
            {SPLAT_BACKGROUNDS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={background === b.id}
                aria-label={`${b.label} background`}
                title={`${b.label} background`}
                onClick={() => setBackground(b.id)}
                className={cn("size-5 rounded-full border border-black/20 transition dark:border-white/30", background === b.id && "ring-2 ring-primary ring-offset-1 ring-offset-transparent")}
                style={{ background: b.color }}
              />
            ))}
          </div>
          {panel ? (
            <div className="px-1">{haze}</div>
          ) : (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" aria-label="Hide faint haze" className={cn("size-7 rounded-full", cutoff > 0 && "text-primary")}>
                      <SlidersHorizontal className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Hide faint haze</TooltipContent>
              </Tooltip>
              <PopoverContent side="top" className="w-64 p-3">
                {haze}
                <p className="mt-2 text-[11px] text-muted-foreground">Hides the near-transparent Gaussians around the object. The download keeps them all.</p>
              </PopoverContent>
            </Popover>
          )}
          {canSave && (
            <IconButton text={saving ? "Saving the still…" : "Save a still"} panel={panel} onClick={() => void saveStill()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({ text, panel, onClick, disabled, children }: { text: string; panel: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant="ghost" aria-label={text} onClick={onClick} disabled={disabled} className={cn("size-7 rounded-full", panel && "text-white hover:bg-white/15 hover:text-white")}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
