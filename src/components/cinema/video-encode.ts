"use client";

import { muxMp4 } from "@/lib/mp4";
import { muxWebM, type EncodedFrame } from "@/lib/webm";

/**
 * Frame-exact video from frames drawn in the browser (Cinema's fly path render, N7-5, and the blockout builder): WebCodecs
 * VP8 into WebM (what ComfyUI reads), WebCodecs H.264 into MP4 (what the cloud models read: Seedance 2.5 takes MP4 or
 * MOV), and MediaRecorder as the fallback where WebCodecs can't, which may drop a frame.
 */

/** The type MediaRecorder records a path in when WebCodecs can't: MP4 (H.264) where it writes it, else WebM. Null: none. */
export function pathVideoType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

const VP8 = (width: number, height: number, fps: number, bitrate = 8_000_000): VideoEncoderConfig => ({ codec: "vp8", width, height, bitrate, framerate: fps });

/**
 * A frame to encode: RGBA pixels, or a canvas (or any image source) handed to the encoder as it is, which spares a
 * copy of every frame (about 8 MB at 1080 × 1920).
 */
export type FrameSource = ImageData | CanvasImageSource;

/** Options for a render: the bit rate (8 Mbps by default) and a way to stop it. */
export interface EncodeOptions {
  bitrate?: number;
  signal?: AbortSignal;
}

const isPixels = (f: FrameSource): f is ImageData => typeof ImageData !== "undefined" && f instanceof ImageData;

function videoFrame(src: FrameSource, width: number, height: number, timestamp: number, duration: number): VideoFrame {
  if (isPixels(src)) return new VideoFrame(src.data, { format: "RGBA", codedWidth: width, codedHeight: height, timestamp, duration });
  return new VideoFrame(src as CanvasImageSource, { timestamp, duration, alpha: "discard" });
}

/** Lets the page breathe between frames without a timer (timers slow to a crawl in a hidden tab; messages don't). */
export function breathe(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** Waits until the encoder holds at most `max` frames (its dequeue event, else short polls). */
async function drain(e: VideoEncoder, max: number): Promise<void> {
  while (e.encodeQueueSize > max) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        e.removeEventListener?.("dequeue", finish);
        resolve();
      };
      e.addEventListener?.("dequeue", finish);
      setTimeout(finish, 20);
    });
  }
}

const stopIfAsked = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The render was stopped", "AbortError");
};

/** WebCodecs can encode VP8 at this size here. */
export async function vp8Supported(width: number, height: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
  try {
    return !!(await VideoEncoder.isConfigSupported(VP8(width, height, fps))).supported;
  } catch {
    return false;
  }
}

/**
 * `count` frames of two streams (`draw(i)` gives frame i of each, or a promise of them: a frame may wait for a splat's sort) encoded with WebCodecs and written as two WebM files:
 * every frame kept, frame i at i / fps, a keyframe each second.
 */
export async function encodeVp8(count: number, width: number, height: number, fps: number, outputs: number, draw: (i: number) => FrameSource[] | Promise<FrameSource[]>, opts: EncodeOptions = {}): Promise<Uint8Array[]> {
  const chunks: EncodedFrame[][] = Array.from({ length: outputs }, () => []);
  let failure: unknown;
  const encoders = chunks.map((_, k) => {
    const e = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks[k].push({ data, key: chunk.type === "key" });
      },
      error: (err) => (failure = err),
    });
    e.configure(VP8(width, height, fps, opts.bitrate));
    return e;
  });
  try {
    const step = 1e6 / fps;
    for (let i = 0; i < count; i++) {
      stopIfAsked(opts.signal);
      const images = await draw(i);
      images.forEach((img, k) => {
        const f = videoFrame(img, width, height, Math.round(i * step), Math.round(step));
        encoders[k].encode(f, { keyFrame: i % Math.max(1, Math.round(fps)) === 0 });
        f.close();
      });
      if (failure) throw failure;
      // Let the encoders and the page breathe (the progress label repaints).
      for (const e of encoders) await drain(e, 4);
      if (i % 4 === 3) await breathe();
    }
    await Promise.all(encoders.map((e) => e.flush()));
    if (failure) throw failure;
  } finally {
    encoders.forEach((e) => e.state !== "closed" && e.close());
  }
  if (chunks.some((c) => c.length !== count)) throw new Error(`The path render lost frames (${chunks[0].length} of ${count})`);
  const track = { codec: "V_VP8" as const, width, height, fps };
  return chunks.map((c) => muxWebM(track, c));
}

/** The fallback: a canvas per stream recorded with MediaRecorder, each frame handed over 1/fps apart. */
export async function recordWithMediaRecorder(type: string, count: number, width: number, height: number, fps: number, outputs: number, draw: (i: number) => ImageData[] | Promise<ImageData[]>): Promise<Blob[]> {
  const canvases = Array.from({ length: outputs }, () => Object.assign(document.createElement("canvas"), { width, height }));
  const ctxs = canvases.map((c) => c.getContext("2d")!);
  const streams = canvases.map((c) => c.captureStream(0));
  const tracks = streams.map((s) => s.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void });
  const recorders = streams.map((s) => new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 8_000_000 }));
  const chunks: Blob[][] = recorders.map(() => []);
  const stopped = recorders.map((r, i) => {
    r.ondataavailable = (e) => e.data.size && chunks[i].push(e.data);
    return new Promise<void>((resolve) => (r.onstop = () => resolve()));
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const step = 1000 / Math.max(1, fps);
  try {
    recorders.forEach((r) => r.start());
    await wait(step);
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      (await draw(i)).forEach((img, k) => ctxs[k].putImageData(img, 0, 0));
      tracks.forEach((t) => t.requestFrame?.());
      await wait(Math.max(0, t0 + (i + 1) * step - performance.now()));
    }
    await wait(step);
  } finally {
    recorders.forEach((r) => r.state !== "inactive" && r.stop());
    await Promise.all(stopped);
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  }
  const base = type.split(";")[0];
  return chunks.map((c) => new Blob(c, { type: base }));
}

/** The H.264 profiles tried in order (baseline 3.1 holds 1280 × 720 at 30 fps; main and high 4.0 more). */
const AVC_CODECS = ["avc1.42001f", "avc1.4d0028", "avc1.640028"];
const AVC = (codec: string, width: number, height: number, fps: number, bitrate = 8_000_000): VideoEncoderConfig => ({ codec, width, height, bitrate, framerate: fps, avc: { format: "avc" } });

/** The H.264 profile WebCodecs encodes at this size here, or null (Chromium without proprietary codecs, Firefox). */
export async function avcCodec(width: number, height: number, fps: number, bitrate?: number): Promise<string | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  for (const c of AVC_CODECS) {
    try {
      if ((await VideoEncoder.isConfigSupported(AVC(c, width, height, fps, bitrate))).supported) return c;
    } catch {}
  }
  return null;
}

/**
 * `count` frames (`draw(i)` gives frame i: pixels, or a canvas handed over as it is) encoded with WebCodecs H.264 and
 * written as one MP4: every frame kept.
 */
export async function encodeMp4(codec: string, count: number, width: number, height: number, fps: number, draw: (i: number) => FrameSource | Promise<FrameSource>, opts: EncodeOptions = {}): Promise<Uint8Array> {
  const frames: EncodedFrame[] = [];
  let avcC: Uint8Array | null = null;
  let failure: unknown;
  const e = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !avcC) avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, key: chunk.type === "key" });
    },
    error: (err) => (failure = err),
  });
  e.configure(AVC(codec, width, height, fps, opts.bitrate));
  try {
    const step = 1e6 / fps;
    for (let i = 0; i < count; i++) {
      stopIfAsked(opts.signal);
      const img = await draw(i);
      const f = videoFrame(img, width, height, Math.round(i * step), Math.round(step));
      e.encode(f, { keyFrame: i % Math.max(1, Math.round(fps)) === 0 });
      f.close();
      if (failure) throw failure;
      await drain(e, 4);
      if (i % 4 === 3) await breathe();
    }
    await e.flush();
    if (failure) throw failure;
  } finally {
    if (e.state !== "closed") e.close();
  }
  if (frames.length !== count) throw new Error(`The render lost frames (${frames.length} of ${count})`);
  if (!avcC) throw new Error("The H.264 encoder gave no decoder description");
  return muxMp4({ width, height, fps, avcC }, frames);
}

/**
 * One stream of `count` frames as the best video this browser makes: MP4 (H.264) when `preferMp4` and WebCodecs can,
 * else WebM (VP8), else MediaRecorder's own type. Frame-exact except on the MediaRecorder fallback.
 */
export async function encodeFrames(count: number, width: number, height: number, fps: number, draw: (i: number) => ImageData | Promise<ImageData>, preferMp4 = false): Promise<{ blob: Blob; type: string; exact: boolean }> {
  const avc = preferMp4 ? await avcCodec(width, height, fps) : null;
  if (avc) return { blob: new Blob([(await encodeMp4(avc, count, width, height, fps, draw)) as BlobPart], { type: "video/mp4" }), type: "video/mp4", exact: true };
  if (await vp8Supported(width, height, fps)) {
    const [a] = await encodeVp8(count, width, height, fps, 1, async (i) => [await draw(i)]);
    return { blob: new Blob([a as BlobPart], { type: "video/webm" }), type: "video/webm", exact: true };
  }
  const type = pathVideoType();
  if (!type) throw new Error("This browser can't record video — try Chrome or Edge, or upload a render from your 3D app");
  const [b] = await recordWithMediaRecorder(type, count, width, height, fps, 1, async (i) => [await draw(i)]);
  return { blob: b, type: type.split(";")[0], exact: false };
}
