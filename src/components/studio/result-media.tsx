"use client";

import { AudioLines, Box, Download, FileText, Film, Layers, Rotate3d } from "lucide-react";
import { createElement, useEffect, useState } from "react";
import { loadModelViewer, useViewerSrc, viewerLook } from "@/components/model3d/model-viewer";
import { hasWebgl2, SplatViewer, useReducedMotion } from "@/components/model3d/splat-viewer";
import { useHydrated } from "@/lib/api";
import { FALLBACK_TEXT, hazeCutoffFor, splatFallback } from "@/lib/av/splat-view";
import { TurnChips } from "@/components/model3d/turn-chips";
import { FORMAT_INFO } from "@/lib/av/formats";
import { FRONT_YAW, splatFormatOf, turnOrbit, viewerGlb } from "@/lib/av/model3d";
import type { Generation, OutputFile, VideoFormat } from "@/lib/catalog/types";
import { extensionOf } from "@/lib/library";
import { cuesOf, cueTime, editOnlyFormat, isLayered, layerInfo, modelPreview, textOf, videoPoster } from "@/lib/output-actions";
import { cn } from "@/lib/utils";

/** Any result as a tile picture: image, video (plays on hover), audio, text card, 3D preview. */
export function MediaThumb({
  output,
  g,
  className,
  autoPlay,
  fit,
  tag,
  inset,
}: {
  output: OutputFile;
  /** The generation it belongs to (3D models show a sibling turntable or poster; a clip, its start frame as poster; pro exports a file card). */
  g?: Pick<Generation, "outputs"> & Partial<Pick<Generation, "op" | "request">>;
  className?: string;
  autoPlay?: boolean;
  /** Letterbox instead of crop (Library "Fit"). */
  fit?: boolean;
  /** A small badge ("Placeholder") a text card shows in its own header row, where it can't cover the label. */
  tag?: string;
  /** Room at the end of a text card's header for a control in the tile's top-right corner (the feed's ⋯ or heart). */
  inset?: boolean;
}) {
  const object = fit ? "object-contain" : "object-cover";
  if (output.kind === "video") {
    const pro = editOnlyFormat(g, output);
    if (pro) return <VideoFileCard output={output} format={pro} className={className} />;
    // With a poster the clip isn't fetched until it plays (a grid of clips no longer loads every one's metadata).
    return <TileVideo output={output} poster={videoPoster(g, output)} autoPlay={autoPlay} className={cn("size-full", object, className)} />;
  }
  if (output.kind === "audio") {
    // A song's stem (vocals, drums…) says which track it is.
    const stem = typeof output.meta?.stem === "string" && output.meta.stem.trim() ? output.meta.stem.trim() : null;
    return (
      <div className={cn("flex size-full flex-col items-center justify-center gap-3 bg-brand-faint p-4 text-brand-text", className)}>
        <AudioLines className="size-8" />
        {stem && <span className="max-w-full truncate text-[13px] font-medium first-letter:uppercase">{stem}</span>}
        <audio src={output.url} controls className="w-full max-w-64" onClick={(e) => e.stopPropagation()} />
      </div>
    );
  }
  if (output.kind === "text") return <TextPreview output={output} className={className} tag={tag} inset={inset} />;
  if (output.kind === "model3d") {
    const { poster, video } = modelPreview(g ?? { outputs: [output] }, output);
    if (video) return <MediaThumb output={{ url: video, kind: "video" }} autoPlay={autoPlay} fit={fit} className={className} />;
    return (
      <div className={cn("relative flex size-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground", className)}>
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" loading="lazy" decoding="async" className={cn("absolute inset-0 size-full", object)} />
        ) : (
          <>
            <Box className="size-8" />
            <span className="text-[12px] font-medium">3D model</span>
          </>
        )}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={output.url} alt="" loading="lazy" decoding="async" className={cn("size-full", object, className)} />;
}

/** A muted tile video that plays on hover; a file card when the browser can't decode it (a 10-bit or HEVC file). */
function TileVideo({ output, poster, autoPlay, className }: { output: OutputFile; poster?: string; autoPlay?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <VideoFileCard output={output} className={className} />;
  return (
    <video
      src={`${output.url}#t=0.1`}
      poster={poster}
      muted
      loop
      playsInline
      preload={poster ? "none" : "metadata"}
      autoPlay={autoPlay}
      onError={() => setFailed(true)}
      onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
      onMouseLeave={(e) => {
        if (!autoPlay) e.currentTarget.pause();
      }}
      className={className}
    />
  );
}

/** A video the browser doesn't play (ProRes, FFV1, some 10-bit files) as what it is: a file for an editor or player. */
export function VideoFileCard({ output, format, className }: { output: Pick<OutputFile, "url" | "kind">; format?: VideoFormat; className?: string }) {
  const info = format ? FORMAT_INFO[format] : undefined;
  return (
    <div className={cn("flex size-full flex-col items-center justify-center gap-1.5 bg-muted p-4 text-center text-muted-foreground", className)}>
      <Film className="size-7" aria-hidden />
      <span className="text-[13px] font-medium text-foreground">{info?.label ?? "Video file"}</span>
      <span className="max-w-56 text-[12px] leading-snug">
        .{extensionOf(output)} · {info ? "made for your editor; browsers don't play it. Download it to use it" : "this browser can't play it here. Download it to watch"}
      </span>
    </div>
  );
}

/** A 56 px thumbnail for list rows: media where it reads at that size, an icon where it doesn't. */
export function SmallThumb({ g, output }: { g: Generation; output: OutputFile }) {
  if (output.kind === "audio" || output.kind === "text") {
    const Icon = output.kind === "audio" ? AudioLines : FileText;
    return (
      <div className="grid size-full place-items-center bg-brand-faint text-brand-text">
        <Icon className="size-5" />
      </div>
    );
  }
  if (isLayered(g)) return <LayersStack g={g} bare />;
  return <MediaThumb output={output} g={g} />;
}

/** A transcript, translation or script as a readable card: the first lines and a cue count. */
export function TextPreview({ output, className, tag, inset }: { output: OutputFile; className?: string; tag?: string; inset?: boolean }) {
  const cues = cuesOf(output);
  const text = textOf(output).trim();
  return (
    // A size container: on a narrow tile (a phone's three-column grid) the header drops its icon to keep the label readable.
    <div className={cn("@container flex size-full flex-col gap-2 bg-card p-4 text-left", className)}>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase", inset && "pr-7")}>
        <FileText className="size-3.5 shrink-0 @max-[8rem]:hidden" />
        <span className="min-w-0 flex-1 truncate">{cues.length ? `Transcript · ${cues.length} lines` : "Text"}</span>
        {tag && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tracking-normal text-foreground normal-case">{tag}</span>}
      </span>
      <p className="line-clamp-[8] min-h-0 flex-1 overflow-hidden text-[13px] leading-relaxed break-words whitespace-pre-line text-foreground">{text || "Empty"}</p>
    </div>
  );
}

/** The full text, with cue timings when there are any (viewer). */
export function TextReader({ output }: { output: OutputFile }) {
  const cues = cuesOf(output);
  if (!cues.length) {
    return <div className="size-full overflow-y-auto p-6 text-body leading-relaxed whitespace-pre-wrap text-foreground sm:p-10">{textOf(output) || "Empty"}</div>;
  }
  return (
    <ol className="size-full space-y-1 overflow-y-auto p-4 sm:p-8">
      {cues.map((c, i) => (
        <li key={i} className="grid grid-cols-[auto_1fr] gap-x-4 rounded-lg px-2 py-1.5 hover:bg-accent">
          <span className="pt-0.5 font-mono text-[12px] text-muted-foreground tabular-nums">
            {cueTime(c.start)} – {cueTime(c.end)}
          </span>
          <span className="text-body leading-relaxed">{c.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Layers of one picture as a stack: the composite on a checkerboard and the layer names. */
export function LayersStack({ g, className, bare }: { g: Generation; className?: string; bare?: boolean }) {
  const layers = g.outputs.map((o, i) => ({ o, ...layerInfo(o, i) })).sort((a, b) => a.z - b.z);
  const composite = (
    <div className="checkerboard absolute inset-0">
      {layers.map((l) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={l.o.url} src={l.o.url} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain" />
      ))}
    </div>
  );
  if (bare) return <div className={cn("relative size-full overflow-hidden", className)}>{composite}</div>;
  return (
    <div className={cn("relative size-full overflow-hidden", className)}>
      {composite}
      <div className="absolute top-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] font-medium text-white backdrop-blur">
          <Layers className="size-3" /> {layers.length} layers
        </span>
      </div>
      <ul className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
        {[...layers].reverse().slice(0, 4).map((l) => (
          <li key={l.o.url} className="max-w-32 truncate rounded-full bg-background/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur">
            {l.name}
          </li>
        ))}
        {layers.length > 4 && <li className="rounded-full bg-background/85 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur">+{layers.length - 4}</li>}
      </ul>
    </div>
  );
}

/**
 * A .glb in an orbitable viewer. @google/model-viewer (with three.js) loads only when one is opened. A Gaussian
 * splat (.ply / .spz / .ksplat) opens in the splat viewer (Spark, loaded only then), its orbit video or picture
 * staying where it can't (see SplatPanel). A rigged character plays its animation instead of turning; a still model
 * turns, and the chips under it turn it to a side.
 */
export function ModelViewer({ output, g }: { output: OutputFile; g: Generation }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [viewer, setViewer] = useState<HTMLElement | null>(null);
  const splat = splatFormatOf(output);
  // The web GLB (meshopt, WebP) when the server made one, else (older results, or if it fails to load) the original.
  const src = useViewerSrc(viewer, viewerGlb(output), output.url);
  const material = (output.meta?.finish as { material?: unknown } | undefined)?.material;
  useEffect(() => {
    if (splat) return;
    let live = true;
    loadModelViewer().then(
      () => live && setReady(true),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [splat]);
  const { poster, video } = modelPreview(g, output);
  if (splat) return <SplatPanel output={output} format={splat} poster={poster} video={video} g={g} />;
  if (failed) return <p className="text-[13px] text-white/80">Couldn&apos;t load the 3D viewer. Download the .glb to open it.</p>;
  if (!ready) {
    return (
      <div className="flex flex-col items-center gap-2 text-white/80">
        <Box className="size-8 animate-pulse" />
        <span className="text-[13px]">Loading 3D viewer…</span>
      </div>
    );
  }
  const rigged = output.meta?.rigged === true;
  const frontYaw = FRONT_YAW[g.modelId] ?? 0;
  const model = createElement("model-viewer", {
    ref: setViewer,
    src,
    poster,
    alt: g.request.prompt || "3D model",
    loading: "lazy",
    reveal: "auto",
    "camera-controls": "",
    // A rigged character plays its animation; a still model turns.
    ...(rigged ? { autoplay: "" } : { "auto-rotate": "" }),
    "touch-action": "pan-y",
    ...viewerLook(typeof material === "string" ? material : undefined),
    ...(frontYaw ? { "camera-orbit": turnOrbit("front", frontYaw) } : {}),
    style: { width: "100%", height: "100%", background: "transparent" },
  });
  if (rigged) return model;
  return (
    <div className="relative size-full">
      {model}
      <TurnChips viewer={viewer} frontYaw={frontYaw} dark className="absolute inset-x-3 bottom-3" />
    </div>
  );
}

/**
 * A splat in the full-screen viewer (the Library's 3D tab and "View in 3D" open it): the splat viewer, with the file
 * to download. The orbit video (or the picture) stays instead where the browser has no WebGL2 or the file is too big
 * for the device, and when the user prefers reduced motion until they choose "Look around in 3D". The viewer takes
 * focus only when they chose it: otherwise the arrow keys keep browsing the results (the Viewer's own keys).
 */
function SplatPanel({ output, format, poster, video, g }: { output: OutputFile; format: string; poster?: string; video?: string; g: Generation }) {
  const hydrated = useHydrated();
  const reducedMotion = useReducedMotion();
  const [asked, setAsked] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fallback = !hydrated ? "reduced-motion" : note ? "too-big" : splatFallback({ webgl2: hasWebgl2(), coarse: false, reducedMotion, asked });
  const name = (g.modelName ?? "splat").replace(/[^\w .-]+/g, "");
  const download = (
    <a href={output.url} download={`${name}.${format}`} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-[13px] font-medium text-white hover:bg-white/25">
      <Download className="size-4" aria-hidden /> .{format}
    </a>
  );
  if (!fallback) {
    return (
      <div className="flex size-full flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden md:rounded-lg">
          <SplatViewer url={output.url} format={format} poster={poster} name={name} defaultCutoff={hazeCutoffFor(g.modelId)} tone="panel" label={g.request.prompt || "the splat"} autoFocus={asked} onUnavailable={setNote} />
        </div>
        <div className="flex shrink-0 justify-center pt-2">{download}</div>
      </div>
    );
  }
  const text = note ?? (fallback === "reduced-motion" ? null : FALLBACK_TEXT[fallback]);
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center text-white/80">
      {video ? (
        // Reduced motion: the orbit video waits for play.
        <video src={video} poster={poster} controls autoPlay={!reducedMotion} loop muted playsInline aria-label="Orbit video of the splat" className="max-h-[70%] max-w-full" />
      ) : poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="The subject the splat was made from" className="max-h-[70%] max-w-full object-contain" />
      ) : (
        <Box className="size-10" aria-hidden />
      )}
      {text && <p className="max-w-md text-[13px]">{text}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {hydrated && fallback === "reduced-motion" && (
          <button type="button" onClick={() => setAsked(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3.5 text-[13px] font-medium text-black hover:bg-white/90">
            <Rotate3d className="size-4" aria-hidden /> Look around in 3D
          </button>
        )}
        {download}
      </div>
    </div>
  );
}
