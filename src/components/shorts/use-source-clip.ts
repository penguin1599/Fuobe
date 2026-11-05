"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refusalShown } from "@/lib/refusals";
import { postFileWithProgress } from "@/lib/upload";

/**
 * The clip a studio works on: shown at once from the file (object URL), uploaded in the background
 * with progress, then read by the server (length, frame rate, sound) from its header. Shared by
 * Shorts Studio and Mixed Media.
 */

export interface SourceInfo {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}

export interface SourceClip {
  name: string;
  size: number;
  /** What the trimmer plays: the local file until the upload is done, then the uploaded copy. */
  preview: string;
  /** The uploaded file (/api/files/…), once uploaded. */
  url?: string;
  /** 0–1 while uploading. */
  progress: number;
  uploading: boolean;
  error?: string;
  info?: SourceInfo;
  /** Length and size as the browser read them (formats the server can't read). */
  browserDuration?: number;
  browserWidth?: number;
  browserHeight?: number;
}

const VIDEO_TYPE = /^video\/(mp4|quicktime|webm|x-m4v)$/;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

export function checkClipFile(file: File, maxBytes: number): string | null {
  if (!VIDEO_TYPE.test(file.type) && !VIDEO_EXT.test(file.name)) return "That isn't a video — use an MP4 or MOV";
  if (file.size > maxBytes) return `That file's over ${Math.round(maxBytes / 1024 / 1024)} MB. Try a shorter or smaller clip.`;
  return null;
}

/** The file as the body (streamed to disk): an account's clip up to its limit, not only a small form. */
const upload = (file: File, onProgress: (p: number) => void, signal: AbortSignal) => postFileWithProgress(file, onProgress, signal);

/** The clip's header, read on the server (a signed-in account's own files only: src/app/api/media/probe). */
async function probe(url: string): Promise<SourceInfo> {
  const res = await fetch("/api/media/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
  return res.ok ? ((await res.json()) as SourceInfo) : {};
}

export function useSourceClip(maxBytes: number) {
  const [clip, setClip] = useState<SourceClip | null>(null);
  const abort = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);

  const release = () => {
    abort.current?.abort();
    abort.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => release, []);

  const pick = useCallback(
    (file: File): string | null => {
      const problem = checkClipFile(file, maxBytes);
      if (problem) return problem;
      release();
      const local = URL.createObjectURL(file);
      objectUrl.current = local;
      const ctrl = new AbortController();
      abort.current = ctrl;
      setClip({ name: file.name, size: file.size, preview: local, progress: 0, uploading: true });
      void (async () => {
        try {
          const up = await upload(file, (p) => setClip((c) => (c && c.preview === local ? { ...c, progress: p } : c)), ctrl.signal);
          const info = await probe(up.url).catch(() => ({}) as SourceInfo);
          if (ctrl.signal.aborted) return;
          // Keep playing the local copy (no reload mid-trim); the uploaded one is what jobs use.
          setClip((c) => (c && c.preview === local ? { ...c, url: up.url, uploading: false, progress: 1, info } : c));
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          // Refused with its own card open (sign up, or connect a GPU or key): the slot is empty again, ready for the clip.
          if (refusalShown(e)) return setClip((c) => (c && c.preview === local ? null : c));
          setClip((c) => (c && c.preview === local ? { ...c, uploading: false, error: (e as Error).message } : c));
        }
      })();
      return null;
    },
    [maxBytes],
  );

  /** Use a clip that is already uploaded (a hand-off from the Library or a result). */
  const adopt = useCallback((url: string, name = "clip") => {
    release();
    setClip({ name, size: 0, preview: url, url, progress: 1, uploading: true });
    void probe(url)
      .catch(() => ({}) as SourceInfo)
      .then((info) => setClip((c) => (c && c.url === url ? { ...c, uploading: false, info } : c)));
  }, []);

  const clear = useCallback(() => {
    release();
    setClip(null);
  }, []);

  /** What the browser's player read (the trimmer's onMeta). */
  const setBrowserMeta = useCallback(
    (m: { duration: number; width?: number; height?: number }) =>
      setClip((c) => (c && m.duration > 0 ? { ...c, browserDuration: m.duration, ...(m.width && m.height ? { browserWidth: m.width, browserHeight: m.height } : {}) } : c)),
    [],
  );

  return { clip, pick, adopt, clear, setBrowserMeta };
}

/** The clip's length: its header's, else what the browser read. */
export const clipDuration = (c: SourceClip | null) => c?.info?.duration ?? c?.browserDuration;

/** The clip's picture size: its header's, else what the browser read. */
export const clipSize = (c: SourceClip | null): { width?: number; height?: number } =>
  c?.info?.width && c.info.height ? { width: c.info.width, height: c.info.height } : { width: c?.browserWidth, height: c?.browserHeight };
