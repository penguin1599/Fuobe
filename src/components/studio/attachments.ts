"use client";

import { nanoid } from "nanoid";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useAskBeforeUpload } from "@/lib/api";
import { MAX_KEYFRAMES } from "@/lib/catalog/keyframes";
import { acceptedKinds, addFrame, fitAttachments, noRoomMessage, onImageChange, placeAttachment, removeFrame, replaceAttachment } from "@/lib/composer";
import type { InputSlot, MediaKind } from "@/lib/catalog/types";
import { fileToSlot, kindOfFile, type SlotValue } from "./media-slot";
import { useStudio, type Draft, type SlotKey } from "./studio-context";

/**
 * In-flight uploads by attachment id. `seen` turns true once the attachment is in the draft;
 * when a seen attachment leaves the draft (removed, replaced, the draft reset by Reuse) its
 * upload is aborted, and a result that arrives anyway finds nothing to replace.
 */
const inflight = new Map<string, { ac: AbortController; seen: boolean }>();

/** Abort uploads whose attachment is gone from the draft. Mount once, where the draft is read. */
export function useUploadReaper(draft: Pick<Draft, "slots" | "refs" | "frames" | "refClips" | "refAudios">) {
  useEffect(() => {
    if (!inflight.size) return;
    const ids = new Set(
      [...Object.values(draft.slots), ...draft.refs, ...(draft.refClips ?? []), ...(draft.refAudios ?? []), ...(draft.frames ?? []).map((f) => f.value)].map((v) => v?.id).filter(Boolean),
    );
    for (const [id, e] of inflight) {
      if (ids.has(id)) e.seen = true;
      else if (e.seen) {
        e.ac.abort();
        inflight.delete(id);
      }
    }
  }, [draft.slots, draft.refs, draft.refClips, draft.refAudios, draft.frames]);
}

/** Frames mode is full. */
const FRAMES_FULL = `Frames mode takes up to ${MAX_KEYFRAMES} frames — remove one to add another`;

/** Paste / drop / "+" take at most this many files in one go. */
const MAX_AT_ONCE = 8;

/**
 * Attach files to the studio draft: paste, drop, the "+" menu and the slot tiles all go through
 * here. Each file is placed once with its local preview, then swapped for the uploaded asset by
 * id (never re-added if it was removed meanwhile). A file with no room (references full, or a
 * model that takes none) is never uploaded: the person is told why instead. Someone whose upload
 * would be refused (a guest, an account with neither its own GPU nor its own key) gets that card
 * at once, before any preview is placed.
 */
export function useAttach(slots: InputSlot[], refMax: number) {
  const { config, draft, setDraft } = useStudio();
  // The latest draft, to check for room before an upload starts (callbacks outlive renders).
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });
  const askFirst = useAskBeforeUpload();

  /** Upload a file: `place` runs once with the local preview, the result replaces it by id. */
  const start = useCallback(
    (file: File, place: (v: SlotValue) => void, kind?: MediaKind) => {
      if (askFirst()) return;
      const id = nanoid(8);
      const entry = { ac: new AbortController(), seen: false };
      inflight.set(id, entry);
      let placed = false;
      void fileToSlot(
        file,
        (v) => {
          if (!placed) {
            placed = true;
            if (v) place({ ...v, id });
            else inflight.delete(id);
            return;
          }
          inflight.delete(id);
          setDraft((d) => {
            const r = replaceAttachment(d, id, v);
            // An image whose upload failed takes its drawing with it.
            return r?.slots ? { ...r, ...onImageChange(d, r.slots) } : (r ?? {});
          });
        },
        kind,
        { signal: entry.ac.signal },
      );
    },
    [setDraft, askFirst],
  );

  const kinds = useMemo(() => new Set<MediaKind>(acceptedKinds(slots, config.multiRef)), [slots, config.multiRef]);

  const noRoom = useCallback(() => toast(noRoomMessage(refMax, config.multiRef?.kind)), [refMax, config.multiRef]);

  /** Put it wherever it fits best: the first empty slot of its kind, else the references (in Frames mode: the next frame). */
  const place = useCallback(
    (v: SlotValue) =>
      setDraft((d) => {
        if (d.frames) return d.frames.length < MAX_KEYFRAMES && v.kind === "image" ? { frames: addFrame(d.frames, v) } : {};
        const r = placeAttachment(d, slots, config.multiRef, refMax, v);
        if (!r) return {};
        // Pasting over a full image slot drops the drawing made on the old image.
        return r.slots ? { ...r, ...onImageChange(d, r.slots) } : r;
      }),
    [setDraft, slots, config.multiRef, refMax],
  );

  /** A library pick (an attachment that needs no upload). */
  const attach = useCallback(
    (v: SlotValue) => {
      const frames = latest.current.frames;
      if (frames) {
        if (v.kind !== "image") return void toast("Frames are images — add a still");
        if (frames.length >= MAX_KEYFRAMES) return void toast(FRAMES_FULL);
      } else if (!placeAttachment(latest.current, slots, config.multiRef, refMax, v)) return noRoom();
      place(v);
    },
    [place, noRoom, slots, config.multiRef, refMax],
  );

  const attachFiles = useCallback(
    (files: File[]) => {
      // A paste, a drop on the page or the "+" menu: one card for the lot, and no toast about kinds or room on top.
      if (askFirst()) return;
      const frames = latest.current.frames;
      // Frames mode: each still becomes the next frame, up to ten.
      const usable = files.filter((f) => (frames ? kindOfFile(f) === "image" : kinds.has(kindOfFile(f))));
      if (usable.length < files.length) toast(frames ? "Frames are images — the other files were left out" : files.length - usable.length > 1 ? "This studio doesn't take those files" : "This studio doesn't take that kind of file");
      if (frames) {
        const room = MAX_KEYFRAMES - frames.length;
        if (usable.length > room) toast(FRAMES_FULL);
        for (const f of usable.slice(0, Math.max(0, room))) start(f, place, "image");
        return;
      }
      if (usable.length > MAX_AT_ONCE) toast(`Added the first ${MAX_AT_ONCE} — that's the most at once`);
      const batch = usable.slice(0, MAX_AT_ONCE);
      // Room first: a file with nowhere to go never uploads.
      const { placed, rejected } = fitAttachments(latest.current, slots, config.multiRef, refMax, batch.map(kindOfFile));
      if (rejected.length) noRoom();
      for (const i of placed) start(batch[i], place);
    },
    [askFirst, kinds, start, place, noRoom, slots, config.multiRef, refMax],
  );

  /** A slot tile: replace its value (an upload it held is cancelled by the reaper). A drawing belongs to the image it was made on. */
  const setSlotValue = useCallback((key: SlotKey, v: SlotValue | null) => setDraft((d) => onImageChange(d, { ...d.slots, [key]: v })), [setDraft]);

  const uploadToSlot = useCallback((key: SlotKey, file: File, kind: MediaKind) => start(file, (v) => setSlotValue(key, v), kind), [start, setSlotValue]);

  const removeRef = useCallback((r: SlotValue) => setDraft((d) => ({ refs: d.refs.filter((x) => (r.id ? x.id !== r.id : x !== r)) })), [setDraft]);

  const addRefFile = useCallback(
    (file: File) => {
      if (latest.current.refs.length >= refMax) return noRoom();
      start(file, (v) => setDraft((d) => ({ refs: [...d.refs, v] })), config.multiRef?.kind);
    },
    [start, setDraft, config.multiRef, refMax, noRoom],
  );

  /** References mode's clips and voice or music clips (Pika H3 Flex): appended in order, up to `max`. */
  const addListFile = useCallback(
    (list: "refClips" | "refAudios", file: File, max: number) => {
      if ((latest.current[list]?.length ?? 0) >= max) return void toast(list === "refClips" ? `Up to ${max} reference clips` : `Up to ${max} voice or music clips`);
      start(file, (v) => setDraft((d) => ({ [list]: [...(d[list] ?? []), v] })), list === "refClips" ? "video" : "audio");
    },
    [start, setDraft],
  );

  /** A clip or voice picked from the library: appended the same way, up to `max`. */
  const addToList = useCallback(
    (list: "refClips" | "refAudios", v: SlotValue, max: number) => {
      if ((latest.current[list]?.length ?? 0) >= max) return void toast(list === "refClips" ? `Up to ${max} reference clips` : `Up to ${max} voice or music clips`);
      setDraft((d) => ({ [list]: [...(d[list] ?? []), v] }));
    },
    [setDraft],
  );

  const removeFromList = useCallback(
    (list: "refClips" | "refAudios", r: SlotValue) => setDraft((d) => ({ [list]: (d[list] ?? []).filter((x) => (r.id ? x.id !== r.id : x !== r)) })),
    [setDraft],
  );

  /** A frame's tile: a new still in its place (its time stays), or null to take the frame out. */
  const setFrameValue = useCallback(
    (i: number, v: SlotValue | null) =>
      setDraft((d) => {
        if (!d.frames?.[i]) return {};
        return { frames: v ? d.frames.map((f, j) => (j === i ? { ...f, value: v } : f)) : removeFrame(d.frames, i) };
      }),
    [setDraft],
  );

  const uploadToFrame = useCallback((i: number, file: File) => start(file, (v) => setFrameValue(i, v), "image"), [start, setFrameValue]);

  return useMemo(
    () => ({ kinds, attach, attachFiles, setSlotValue, uploadToSlot, removeRef, addRefFile, addListFile, addToList, removeFromList, setFrameValue, uploadToFrame }),
    [kinds, attach, attachFiles, setSlotValue, uploadToSlot, removeRef, addRefFile, addListFile, addToList, removeFromList, setFrameValue, uploadToFrame],
  );
}

/**
 * The page's drop zone hands files to the composer, which knows the current slots (they change
 * with the model and preset). The composer registers its `attachFiles` here, and its camera
 * motion and effect picker as `pick` (the studio's example tiles pick through it).
 */
export interface ComposerBridge {
  current: ((files: File[]) => void) | null;
  pick?: ((id: string) => void) | null;
}

export const ComposerBridgeCtx = createContext<ComposerBridge | null>(null);

export function useComposerBridge(): ComposerBridge | null {
  return useContext(ComposerBridgeCtx);
}
