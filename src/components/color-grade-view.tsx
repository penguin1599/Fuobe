"use client";

import { Columns2, Download, ImagePlus, Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { downloadBlob } from "@/components/ads/render";
import { Button } from "@/components/ui/button";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Slider } from "@/components/ui/slider";
import { kindOfFile, MAX_MB, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { askToSignUp, uploadFile, useIsAccount, useIsGuest, useViewer } from "@/lib/api";
import { applyPreset, CONTROLS, describeGrade, FRAGMENT, isNeutral, NEUTRAL, PRESETS, uniforms, VERTEX, type Grade } from "@/lib/grade";
import { cn } from "@/lib/utils";
import { loseContext as loseGlContext, releaseVideo } from "@/lib/media-release";
import { responseError, toastError } from "@/lib/refusals";

type Source = HTMLImageElement | HTMLVideoElement;

/** One WebGL context that grades an image or video frame into its canvas. */
class GradeRenderer {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  tex: WebGLTexture;
  loc = new Map<string, WebGLUniformLocation | null>();

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL isn't available in this browser");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  get maxSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  render(src: Source, grade: Grade, width: number, height: number, original = false) {
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    const u = uniforms(original ? NEUTRAL : grade);
    for (const [k, v] of Object.entries(u)) {
      if (Array.isArray(v)) gl.uniform3f(this.u(k), v[0], v[1], v[2]);
      else gl.uniform1f(this.u(k), v);
    }
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth;
    const shh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
    gl.uniform2f(this.u("u_texel"), 1 / Math.max(1, sw), 1 / Math.max(1, shh));
    gl.uniform1f(this.u("u_seed"), src instanceof HTMLVideoElement ? (src.currentTime * 7.31) % 100 : 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function loadSource(url: string, kind: "image" | "video"): Promise<Source> {
  return new Promise((resolve, reject) => {
    if (kind === "video") {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.src = url;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.onloadeddata = () => resolve(v);
      v.onerror = () => {
        // A clip this browser can't decode (HEVC .mov, a broken file): let go of it right away.
        v.onerror = null;
        releaseVideo(v);
        reject(new Error("Couldn't play that video here — try an MP4 (H.264) or WebM file"));
      };
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load the image"));
    img.src = url;
  });
}

const dims = (s: Source) => (s instanceof HTMLVideoElement ? [s.videoWidth, s.videoHeight] : [s.naturalWidth, s.naturalHeight]);

/** Stop a detached video for good (it would keep decoding after the page or the clip changes). */
function release(s: Source | null | undefined) {
  if (s instanceof HTMLVideoElement) releaseVideo(s);
}

/** Free a WebGL context now instead of waiting for garbage collection (browsers cap live contexts). */
function loseContext(r: GradeRenderer | null | undefined) {
  loseGlContext(r?.gl);
}

/** Bundled still the looks are previewed on before anything is loaded. */
const SAMPLE = "/samples/grade-sample.jpg";

/**
 * "Start from an example" on the empty stage: a photo or a clip with a look, opened with that look picked. Graded in
 * this browser like any file, so anyone can try them.
 */
const GRADE_EXAMPLES: { id: string; url: string; thumb: string; kind: "image" | "video"; look: string; label: string }[] = [
  { id: "grade.1", url: SAMPLE, thumb: SAMPLE, kind: "image", look: "portra", label: "Portra 400 at sunset" },
  {
    id: "grade.2",
    url: "/previews/presets/ba/1280/app-color-grading-before.jpg",
    thumb: "/previews/presets/ba/512/app-color-grading-before.jpg",
    kind: "image",
    look: "teal-orange",
    label: "Teal & Orange",
  },
  { id: "grade.3", url: "/previews/presets/motion-catwalk.mp4", thumb: "/previews/presets/thumbs/motion-catwalk.jpg", kind: "video", look: "film-colors", label: "Film Colors on a runway clip" },
];

/** What is being graded: a file on the server (a library pick, ?image=, the sample), or one picked here (`file`, read from this browser). */
type Input = { url: string; kind: "image" | "video"; file?: File };

function Grader() {
  const sp = useSearchParams();
  const initial = sp.get("video") ? { url: sp.get("video")!, kind: "video" as const } : sp.get("image") ? { url: sp.get("image")!, kind: "image" as const } : null;
  const [input, setInput] = useState<Input | null>(initial);
  const [source, setSource] = useState<Source | null>(null);
  // A clip handed over with its grade (?preset=, a Fuobe DoP colour-grade effect) opens with that grade picked.
  const handed = PRESETS.find((p) => p.id === sp.get("preset"));
  const [grade, setGrade] = useState<Grade>(() => (handed ? applyPreset(handed) : NEUTRAL));
  const [preset, setPreset] = useState<string | undefined>(handed?.id);
  const [holding, setHolding] = useState(false);
  /** The graded file being rendered, where it goes and (for a clip) how far along it is. */
  const [saving, setSaving] = useState<null | { to: "download" | "library"; progress?: number }>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The owner saves to the studio's library, an account to its own runs; a guest's Save asks it to sign up first.
  const owner = useViewer().data?.owner;
  const account = useIsAccount();
  const guest = useIsGuest();
  const canSave = !!owner || account || guest;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GradeRenderer | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [sample, setSample] = useState<HTMLImageElement | null>(null);
  /** False once the page is gone, so a running export stops instead of playing on in the background. */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      loseContext(renderer.current);
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    let loaded: Source | null = null;
    loadSource(input.url, input.kind).then(
      (s) => {
        if (cancelled) return release(s);
        loaded = s;
        setSource(s);
        if (s instanceof HTMLVideoElement) void s.play().catch(() => {});
      },
      (e) => {
        if (cancelled) return;
        toastError(e);
        // Back to the empty stage (upload slots, sample photo) instead of a spinner that never ends.
        setSource(null);
        setInput(null);
      },
    );
    return () => {
      cancelled = true;
      release(loaded);
    };
  }, [input]);

  // A file picked here is read from this browser (a blob: address): let it go once another replaces it or the page closes.
  useEffect(() => {
    const url = input?.url;
    if (!url?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(url);
  }, [input]);

  // The looks are previewed on a bundled sample until the user brings their own picture.
  useEffect(() => {
    if (source || sample) return;
    let cancelled = false;
    loadSource(SAMPLE, "image").then(
      (s) => !cancelled && setSample(s as HTMLImageElement),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [source, sample]);

  // Fit the preview to the stage.
  useEffect(() => {
    if (!source || !box.current) return;
    const [w, h] = dims(source);
    const fit = () => {
      const r = box.current!.getBoundingClientRect();
      const s = Math.min(r.width / w, r.height / h, 2);
      setView({ w: Math.round(w * s), h: Math.round(h * s) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [source]);

  // Draw (every frame for video).
  useEffect(() => {
    if (!source || !canvas.current || !view.w) return;
    try {
      renderer.current ??= new GradeRenderer(canvas.current);
    } catch (e) {
      toastError(e);
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const draw = () => renderer.current!.render(source, grade, Math.round(view.w * dpr), Math.round(view.h * dpr), holding);
    if (!(source instanceof HTMLVideoElement)) {
      draw();
      return;
    }
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [source, grade, view, holding]);

  // Preset thumbnails, rendered once per source (or on the sample) with a throwaway WebGL context.
  const thumbSource = source ?? sample;
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!thumbSource) return out;
    const c = document.createElement("canvas");
    let r: GradeRenderer;
    try {
      r = new GradeRenderer(c);
    } catch {
      return out;
    }
    const [w, h] = dims(thumbSource);
    const s = 120 / Math.max(w, h);
    for (const p of PRESETS) {
      r.render(thumbSource, applyPreset(p), Math.round(w * s), Math.round(h * s));
      out[p.id] = c.toDataURL("image/jpeg", 0.8);
    }
    loseContext(r);
    return out;
  }, [thumbSource]);

  const set = (k: keyof Grade, v: number) => {
    setPreset(undefined);
    setGrade((g) => ({ ...g, [k]: v }));
  };

  /** A picked file's upload, made the first time the owner saves a grade of it (the stage reads it from this browser). */
  const uploadedSource = useRef<{ file: File; url: string } | null>(null);
  /**
   * Where the graded file came from, as the library keeps it: a file on the server, never this browser's blob: address.
   * An account's run names only its own stored files (a file picked here stays in its browser), so none otherwise.
   */
  const sourceUrl = async (from: Input): Promise<string | null> => {
    if (account) return !from.file && from.url.startsWith("/api/files/") ? from.url : null;
    if (!from.file) return from.url;
    if (from.file.size > MAX_MB * 1024 * 1024) throw new Error(`That file's over ${MAX_MB} MB, so it can't go in your library. Download keeps the graded copy.`);
    if (uploadedSource.current?.file !== from.file) uploadedSource.current = { file: from.file, url: (await uploadFile(from.file)).url };
    return uploadedSource.current.url;
  };

  /** Keeps the graded file in the library (an account's: in its runs), made from `from` (sourceUrl). */
  const record = async (file: File, kind: "image" | "video", from: string | null) => {
    // Rendered here, so any account may keep it (no model made it).
    const asset = await uploadFile(file, { kinetic: account });
    const res = await fetch("/api/generations/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feature: "grade",
        modelId: "local-color-grade",
        op: "grade",
        prompt: describeGrade(grade, PRESETS.find((p) => p.id === preset)?.name),
        inputs: !from ? {} : kind === "video" ? { video: from } : { images: [from] },
        params: { extra: { grade } },
        output: { url: asset.url, kind, contentType: asset.contentType },
      }),
    });
    if (!res.ok) throw responseError(res, ((await res.json()) as { error?: string }).error ?? "Couldn't save");
    setSaved(asset.url);
    toast.success(account ? "Saved to your runs" : "Saved to your library");
  };

  /** The graded picture as a PNG, at full size (or the largest this browser's WebGL draws). */
  const renderImage = async (img: HTMLImageElement): Promise<File> => {
    const c = document.createElement("canvas");
    const r = new GradeRenderer(c);
    try {
      const [w, h] = dims(img);
      const s = Math.min(1, r.maxSize / Math.max(w, h));
      r.render(img, grade, Math.round(w * s), Math.round(h * s));
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      if (!blob) throw new Error("Couldn't export the image");
      return new File([blob], "graded.png", { type: "image/png" });
    } finally {
      loseContext(r);
    }
  };

  /**
   * Re-plays the clip once through the grader and records the canvas (WebM, with the original audio when the browser
   * allows). Null when the page closed before the end.
   */
  const renderVideo = async (playing: HTMLVideoElement, onProgress: (p: number) => void): Promise<File | null> => {
    let clip: HTMLVideoElement | null = null;
    try {
      const c = document.createElement("canvas");
      const r = new GradeRenderer(c);
      const [w, h] = dims(playing);
      const s = Math.min(1, 1920 / Math.max(w, h));
      const W = Math.round((w * s) / 2) * 2;
      const H = Math.round((h * s) / 2) * 2;
      const v = (await loadSource(input!.url, "video")) as HTMLVideoElement;
      clip = v;
      v.loop = false;
      v.muted = false;
      v.volume = 0.0001;
      const stream = c.captureStream(30);
      try {
        const audio = (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.().getAudioTracks() ?? [];
        audio.forEach((t) => stream.addTrack(t));
      } catch {}
      const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((res) => (rec.onstop = () => res()));
      r.render(v, grade, W, H);
      rec.start(250);
      await v.play();
      await new Promise<void>((res) => {
        const tick = () => {
          if (!alive.current) return res();
          r.render(v, grade, W, H);
          onProgress(Math.min(0.99, v.currentTime / (v.duration || 1)));
          if (v.ended) res();
          else requestAnimationFrame(tick);
        };
        tick();
      });
      rec.stop();
      await done;
      loseContext(r);
      if (!alive.current) return null;
      return new File(chunks, "graded.webm", { type: "video/webm" });
    } finally {
      release(clip);
    }
  };

  /**
   * Renders the graded picture or clip in the browser, then downloads it or saves it (the owner's library, an account's
   * runs). A save keeps the picked file first, so one the library can't take says so before a clip plays through.
   */
  const exportTo = async (to: "download" | "library") => {
    if (!source || !input) return;
    if (to === "library" && guest) return askToSignUp("upload");
    setSaving({ to, progress: source instanceof HTMLVideoElement ? 0 : undefined });
    try {
      const from = to === "library" ? await sourceUrl(input) : null;
      const file = source instanceof HTMLVideoElement ? await renderVideo(source, (progress) => setSaving({ to, progress })) : await renderImage(source);
      if (!file || !alive.current) return;
      if (to === "download") downloadBlob(file, file.name);
      else await record(file, file.type.startsWith("video/") ? "video" : "image", from);
    } catch (e) {
      if (alive.current) toastError(e);
    } finally {
      if (alive.current) setSaving(null);
    }
  };
  const rendering = (to: "download" | "library") => saving?.to === to && saving.progress !== undefined && `Rendering ${Math.round(saving.progress * 100)}%`;

  const groups = useMemo(() => [...new Set(CONTROLS.map((c) => c.group))], []);
  const neutral = isNeutral(grade);

  const open = (next: Input) => {
    loseContext(renderer.current);
    renderer.current = null;
    setSource(null);
    setSaved(null);
    setInput(next);
  };
  /** A library pick. */
  const pick = (v: SlotValue | null) => {
    if (!v?.ref || v.uploading) return;
    open({ url: v.ref, kind: v.kind === "video" ? "video" : "image" });
  };
  /** A file picked or dropped here: graded in this browser, so anyone can grade their own (the owner's is uploaded when they save). */
  const pickFile = (f: File) => open({ url: URL.createObjectURL(f), kind: kindOfFile(f) === "video" ? "video" : "image", file: f });

  return (
    <div className="flex flex-col lg:h-content">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-6">
        <h1 className="font-heading text-[22px] leading-none">Color grading</h1>
        <span className="ml-2 hidden rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success sm:inline">Free · runs in your browser</span>
        <div className="ml-auto flex items-center gap-2">
          {input && <MediaSlot label="Replace" kind={input.kind} value={null} onChange={pick} onFile={pickFile} local />}
        </div>
        <PhoneNavButton />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3 sm:px-6 lg:flex-row">
        <div
          ref={box}
          className={cn(
            "relative grid min-h-[40vh] place-items-center overflow-hidden rounded-xl bg-media lg:flex-1",
            // On a phone the picture stays at the top while the looks and sliders scroll under it.
            input && "max-lg:sticky max-lg:top-chrome max-lg:z-10 max-lg:h-[40svh] max-lg:min-h-0",
          )}
        >
          {!input ? (
            <div className="flex flex-col items-center gap-4 text-center text-white/80">
              <ImagePlus className="size-8" />
              <div>
                <p className="font-heading text-[24px] text-white">Grade a photo or a clip</p>
                <p className="mt-1 text-[13px]">
                  {/* The owner saves to the library, an account to its runs; a guest downloads the graded copy. */}
                  {owner
                    ? "Drop a file, or pick one from your library. Nothing is uploaded until you save."
                    : account
                      ? "Drop a photo or a clip, or pick one. It stays in your browser until you save the graded copy."
                      : "Drop a photo or a clip, or pick one. It stays in your browser, and Download saves the graded copy."}
                </p>
              </div>
              <div className="flex gap-2">
                <MediaSlot label="Image" kind="image" value={null} onChange={pick} onFile={pickFile} local size="lg" />
                <MediaSlot label="Video" kind="video" value={null} onChange={pick} onFile={pickFile} local size="lg" />
              </div>
              <div className="flex flex-col items-center gap-2">
                <p className="text-[12px] font-medium text-white/70">
                  <Sparkles className="mr-1 inline size-3.5 align-[-2px]" />
                  Start from an example
                </p>
                <div className="flex max-w-[560px] flex-wrap justify-center gap-2 px-2">
                  {GRADE_EXAMPLES.map((ex) => (
                    <button
                      key={ex.url}
                      type="button"
                      data-example={ex.id}
                      onClick={() => {
                        const look = PRESETS.find((p) => p.id === ex.look);
                        open({ url: ex.url, kind: ex.kind });
                        if (look) {
                          setPreset(look.id);
                          setGrade(applyPreset(look));
                        }
                      }}
                      className="inline-flex h-11 items-center gap-2 rounded-full bg-white/10 py-1 pr-4 pl-1 text-[13px] font-medium text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ex.thumb} alt="" loading="lazy" decoding="async" className="h-9 w-12 rounded-full object-cover" />
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : !source ? (
            <Loader2 className="size-5 animate-spin text-white/70" />
          ) : (
            <canvas ref={canvas} style={{ width: view.w, height: view.h }} className="rounded-sm" />
          )}
          {source && (
            <button
              onPointerDown={() => setHolding(true)}
              onPointerUp={() => setHolding(false)}
              onPointerLeave={() => setHolding(false)}
              className={cn(
                "absolute bottom-4 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium backdrop-blur transition-colors select-none",
                holding ? "bg-white text-black" : "bg-white/15 text-white hover:bg-white/25",
              )}
            >
              <Columns2 className="size-4" /> {holding ? "Original" : "Hold to compare"}
            </button>
          )}
        </div>

        <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:w-[340px]">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <div>
              <p className="mb-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">Looks</p>
              <div className="grid grid-cols-4 gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={preset === p.id}
                    title={source ? p.name : `${p.name} — opens the sample photo`}
                    onClick={() => {
                      // Before anything is loaded, a look opens the sample with that look applied.
                      if (!input) open({ url: SAMPLE, kind: "image" });
                      setPreset(p.id);
                      setGrade(applyPreset(p));
                    }}
                    className={cn("group flex flex-col gap-1 rounded-lg p-1 text-left ring-primary transition hover:bg-accent", preset === p.id && "ring-2")}
                  >
                    <span className="aspect-square w-full overflow-hidden rounded-md bg-muted">
                      {thumbs[p.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbs[p.id]} alt="" className="size-full object-cover" />
                      ) : (
                        <span className="block size-full animate-pulse bg-muted" />
                      )}
                    </span>
                    <span className="line-clamp-2 px-0.5 text-[11px] leading-tight font-medium">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
            {groups.map((g) => (
              <div key={g} className="space-y-3">
                <p className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{g}</p>
                {CONTROLS.filter((c) => c.group === g).map((c) => (
                  <div key={c.key} className="space-y-1.5">
                    <div className="flex items-center justify-between text-[13px]">
                      <span id={`grade-${c.key}`}>{c.label}</span>
                      <button
                        type="button"
                        onDoubleClick={() => set(c.key, NEUTRAL[c.key])}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === "Backspace") && set(c.key, NEUTRAL[c.key])}
                        title="Double-click to reset"
                        aria-label={`Reset ${c.label}`}
                        className={cn("font-mono text-[12px] text-muted-foreground tabular-nums", grade[c.key] !== NEUTRAL[c.key] && "text-brand-text")}
                      >
                        {c.min < 0 && grade[c.key] > 0 ? "+" : ""}
                        {grade[c.key]}
                        {c.max === 360 ? "°" : ""}
                      </button>
                    </div>
                    <Slider
                      value={[grade[c.key]]}
                      min={c.min}
                      max={c.max}
                      step={1}
                      disabled={!source}
                      aria-label={c.group === "Split tone" ? `Split tone ${c.label.toLowerCase()}` : c.label}
                      aria-valuetext={`${c.min < 0 && grade[c.key] > 0 ? "+" : ""}${grade[c.key]}${c.max === 360 ? "°" : ""}`}
                      onValueChange={([v]) => set(c.key, v)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="space-y-2 border-t p-3">
            {saving?.progress !== undefined && (
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(saving.progress * 100) / 100})` }} />
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={neutral} onClick={() => (setGrade(NEUTRAL), setPreset(undefined))}>
                <RotateCcw /> Reset
              </Button>
              <Button className={cn(!canSave && "flex-1")} variant={canSave ? "outline" : "default"} size="sm" disabled={!source || saving !== null} onClick={() => exportTo("download")}>
                {saving?.to === "download" ? <Loader2 className="animate-spin" /> : <Download />}
                {rendering("download") || "Download"}
              </Button>
              {canSave && (
                <Button className="flex-1" size="sm" disabled={!source || neutral || saving !== null} onClick={() => exportTo("library")}>
                  {saving?.to === "library" ? <Loader2 className="animate-spin" /> : <Save />}
                  {rendering("library") || (account ? "Save to your runs" : "Save to library")}
                </Button>
              )}
            </div>
            {saved && (
              <Link href="/library" className="block text-[12px] text-brand-text underline underline-offset-2">
                {account ? "Open your runs" : "Open library"}
              </Link>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function ColorGradeView() {
  return (
    <Suspense fallback={null}>
      <Grader />
    </Suspense>
  );
}
