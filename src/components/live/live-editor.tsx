"use client";

import {
  ArrowLeftRight,
  Brush,
  Check,
  ChevronLeft,
  CornerDownLeft,
  Download,
  Expand,
  ImagePlus,
  Keyboard,
  Layers,
  Loader2,
  MoreHorizontal,
  Redo2,
  Save,
  Shuffle,
  Undo2,
  Upload,
  X,
  Zap,
  ZapOff,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CompareSlider } from "@/components/studio/compare-slider";
import { SketchEditor, type SketchResult } from "@/components/studio/sketch-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postFile } from "@/lib/upload";
import type { LiveEvent } from "@/lib/live/frames";
import { aspectOf, AutoSize, isAspect, keepAuto, KEEP_LADDER, LIVE_LADDER, type Aspect, type KeepRes, type LiveSize } from "@/lib/live/sizes";
import { pictureExt, pngSize } from "@/lib/live/names";
import { DEFAULT_METHOD, restoreStack, StepStack, type Method, type Step } from "@/lib/live/steps";
import { changeCount, completedWords, dropLastChange, endsWord, MAX_LIVE_TEXT, nextChange, normalize } from "@/lib/live/text";
import { cn } from "@/lib/utils";
import { keyOf, type LiveFacts, type LiveTransport, type RenderOut, type RenderReq, type TransportStatus } from "./live-transport";
import { idbDel, idbGet, idbPrune, idbPut } from "./live-store";

/**
 * Live edit: change a picture as you type. One prompt keeps growing, and every frame renders the whole of it on the
 * same picture (the original, or the picture the person started fresh from), with one seed for the session, so the
 * picture stays steady while the words change. The text box drives throwaway live frames (small WebP); a pause renders
 * the text on screen at full quality (the settled frame). Enter ends a change (", ") and Undo drops the newest one.
 * Start fresh stores the picture on screen as a lossless master, makes it the new start and clears the words (Undo
 * brings them back). Hold C to compare with the picture before the words (Shift+C: the original); B paints a region
 * to change. The owner's lab switch (?lab=1) brings back stacking, where Enter keeps each change as a step. Two
 * shells: the full-screen app (/live-edit) and a panel in the Edit studio.
 */

export interface LiveEditorProps {
  variant: "app" | "embedded";
  transport: LiveTransport;
  /** A Fuobe file to start from. */
  image?: string;
  /** Starting text (not kept). */
  text?: string;
  /** Where the editor was opened from (the back link, provenance on save). */
  from?: string;
  /** The owner may save to the Library; an account downloads instead. */
  canSave: boolean;
  /** The owner's lab: the method can be switched (compose, or stacking: hybrid, chain). */
  lab?: boolean;
  /** Embedded: hand the kept picture to the Edit studio. */
  onUse?: (url: string) => void;
  onClose?: () => void;
}

/** When a keystroke's exact text renders (the words so far render at once at a word boundary). */
const IDLE_MS = 250;
/** When the text on screen renders at full quality (what Keep stores). */
const SETTLE_MS = 1200;
const CACHE_SIZE = 120;
const MAX_TRIES = 6;
/** Compose: from this many changes in one prompt, the editor suggests a fresh start. */
const LONG_PROMPT_CHANGES = 12;

interface Shown {
  url: string;
  key: string;
  seq: number;
  kind: "live" | "settled" | "master";
  w: number;
  h: number;
  ms: number;
  sha256: string;
}

interface Cached {
  url: string;
  out: RenderOut;
  kind: "live" | "settled";
  seed: number;
  text: string;
}

interface Try {
  key: string;
  url: string;
  seed: number;
  text: string;
}

type Phase = { s: "connecting" } | { s: "ready" } | { s: "setup"; facts: LiveFacts } | { s: "error"; message: string; code?: string };

const storageKey = (image: string | undefined) => `fuobe-live:${image ?? "new"}`;
/** Remembered dismissals (this browser only). */
const HIGHVRAM_HINT = "fuobe-live-hint:highvram";
const HOLD_HINT = "fuobe-live-hint:hold";

/** The masters stored in this browser that any saved session still refers to. */
function idbInUse(): Set<string> {
  const keep = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("fuobe-live:")) continue;
      const st = load<{ stack?: { steps?: { master?: { idb?: unknown } }[] } }>(k);
      for (const step of st?.stack?.steps ?? []) if (typeof step?.master?.idb === "string") keep.add(step.master.idb);
    }
  } catch {}
  return keep;
}

/** What the page shows of the kept steps (a snapshot: the stack itself lives in a ref and changes in handlers). */
interface StackView {
  head: Step | null;
  original: Step | null;
  previous: Step | null;
  path: Step[];
  all: readonly Step[];
  canUndo: boolean;
  canRedo: boolean;
}
const viewOf = (s: StepStack): StackView => ({ head: s.head, original: s.original, previous: s.previous(), path: s.path(), all: [...s.all], canUndo: s.canUndo(), canRedo: s.canRedo() });
const EMPTY_VIEW: StackView = { head: null, original: null, previous: null, path: [], all: [], canUndo: false, canRedo: false };

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const dataUrlBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

/**
 * Render timings for the page's own checks: a page that sets `window.__fuobeLiveTrace = []` gets one row per render
 * (when it was sent and answered, and ComfyUI's own time). Nothing is kept otherwise.
 */
function trace(row: { slot: string; seq: number; sent: number; got: number; ms?: number; outcome: string }) {
  const t = (window as unknown as { __fuobeLiveTrace?: unknown[] }).__fuobeLiveTrace;
  if (Array.isArray(t) && t.length < 5000) t.push(row);
}

export function LiveEditor(props: LiveEditorProps) {
  const { transport, variant } = props;
  const embedded = variant === "embedded";
  const [phase, setPhase] = useState<Phase>({ s: "connecting" });
  const [facts, setFacts] = useState<LiveFacts | null>(null);
  const [status, setStatus] = useState<TransportStatus>({ online: false, running: null, queue: 0, otherRan: false });
  const [image, setImage] = useState<string | undefined>(props.image);
  const persistKey = storageKey(image);

  // Kept steps and the picture on screen.
  const stack = useRef<StepStack>(new StepStack());
  const [view, setView] = useState<StackView>(EMPTY_VIEW);
  const bump = () => setView(viewOf(stack.current));
  const [shown, setShown] = useState<Shown | null>(null);
  const shownSeq = useRef(-1);
  const shownKey = useRef("");
  const masterUrls = useRef(new Map<string, string>());
  const [urls, setUrls] = useState<Record<string, string>>({});
  const setMasterUrl = (name: string, url: string) => {
    masterUrls.current.set(name, url);
    setUrls((u) => ({ ...u, [name]: url }));
  };

  // The open change.
  const [text, setText] = useState(props.text ?? "");
  const textRef = useRef(text);
  const seedRef = useRef(0);
  const [seed, setSeed] = useState(0);
  const [tries, setTries] = useState<Try[]>([]);
  const [mask, setMask] = useState<{ name: string; preview: string } | null>(null);

  // Settings.
  const [liveOn, setLiveOn] = useState(true);
  const [liveChoice, setLiveChoice] = useState<"auto" | LiveSize>("auto");
  const [keepChoice, setKeepChoice] = useState<"auto" | KeepRes>("auto");
  const [aspect, setAspect] = useState<Aspect>("3:4");
  const [method, setMethod] = useState<Method>(DEFAULT_METHOD);
  /** One growing prompt on the start picture (everyone); the others stack kept steps (the owner's lab). */
  const compose = method === "compose";
  /** What Undo took off the end of the words, for Redo (while the words are still what Undo left). */
  const [textRedo, setTextRedo] = useState<{ text: string; was: string }[]>([]);
  const auto = useRef(new AutoSize(512));
  const [liveSize, setLiveSize] = useState<LiveSize>(512);
  const sizeShown: LiveSize = liveChoice === "auto" ? liveSize : liveChoice;

  // Work in flight.
  const seq = useRef(0);
  const inflight = useRef(new Map<string, number>());
  const cache = useRef(new Map<string, Cached>());
  /** A live frame of the same text at another live size (the auto size moved): it shows instead of a new render. */
  const anySize = useRef(new Map<string, string>());
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState<{ what: "rendering" | "warming" | "keeping" | "saving" | "adding"; since: number; progress?: number } | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [keptFlash, setKeptFlash] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [highvramHint, setHighvramHint] = useState(() => load<boolean>(HIGHVRAM_HINT) !== false);

  // Compare and tools.
  const [hold, setHold] = useState<"prev" | "orig" | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareWith, setCompareWith] = useState<"prev" | "orig">("prev");
  const [brushOpen, setBrushOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const head = view.head;
  const hasPicture = !!head;
  const keepRes: number = keepChoice === "auto" ? keepAuto(head ? Math.max(head.master.w, head.master.h) : undefined) : keepChoice;

  // ---------------------------------------------------------------------------
  // Opening: the transport, the stored session, the starting picture

  const urlOfMaster = useCallback((s: Step | null): string | null => {
    if (!s) return null;
    return masterUrls.current.get(s.master.name) ?? s.master.url ?? null;
  }, []);
  /** The same, for what the page draws. */
  const urlOf = (s: Step | null): string | null => (s ? (urls[s.master.name] ?? s.master.url ?? null) : null);

  const persist = useCallback(() => {
    save(persistKey, { v: 1, stack: stack.current.toJSON(), seed: seedRef.current, keepChoice, liveChoice, aspect, text: textRef.current });
  }, [persistKey, keepChoice, liveChoice, aspect]);

  const showMaster = useCallback(
    (s: Step | null) => {
      if (!s) return setShown(null);
      const url = urlOfMaster(s);
      if (!url) return;
      // Late live frames can't cover a picture the person chose.
      shownSeq.current = seq.current;
      shownKey.current = `master:${s.id}`;
      setShown({ url, key: `master:${s.id}`, seq: seq.current, kind: "master", w: s.master.w, h: s.master.h, ms: s.ms, sha256: s.master.sha256 });
    },
    [urlOfMaster],
  );

  /** Make sure a step's master is staged in ComfyUI under its name (after a reload, or on another session). */
  const ensureStaged = useCallback(
    async (s: Step) => {
      const url = s.master.url ?? masterUrls.current.get(s.master.name);
      if (url) {
        const st = await transport.stageFile(url);
        if (st.name !== s.master.name) s.master.name = st.name;
        return;
      }
      if (s.master.idb) {
        const key = s.master.idb;
        const bytes = await idbGet(key);
        if (bytes) await transport.stageBytes(bytes, "master", () => idbGet(key));
      }
    },
    [transport],
  );

  const onEvent = (e: LiveEvent) => {
    if (e.type === "progress") setBusy((b) => (b ? { ...b, progress: e.value / e.max } : b));
    if (e.type === "reconnecting") setStatus((s) => ({ ...s, online: false }));
  };

  /** A throwaway render that loads the model (and, with a base, the edit path) before the first keystroke. */
  const warm = (base?: string) => {
    setBusy({ what: "warming", since: performance.now() });
    const req: RenderReq = { seq: ++seq.current, slot: "warm", text: "", seed: 0, size: 384 as LiveSize, keepRes: 1024, aspect: "1:1", method: "hybrid", ...(base && { base }) };
    void transport.render(req, onEvent).then(() => setBusy((b) => (b?.what === "warming" ? null : b)));
  };
  /** The newest handlers, for effects and timers. */
  const latest = useRef({ warm, render: (() => {}) as (slot: "live" | "settle", t: string, o?: { urgent?: boolean }) => void, schedule: (() => {}) as (t: string, typed?: string, whole?: boolean) => void, addFile: (async () => {}) as (f: File) => Promise<void> });

  useEffect(() => {
    let alive = true;
    const off = transport.onStatus((s) => alive && setStatus(s));
    void (async () => {
      const r = await transport.open();
      if (!alive) return;
      if (!r.ok) return setPhase({ s: "error", message: r.error, code: r.code });
      setFacts(r);
      if (!r.nodes || r.missing.length) {
        setPhase({ s: "setup", facts: r });
        return;
      }
      // Masters this browser kept for steps no saved session refers to any more go.
      void idbPrune(idbInUse());
      // A stored session for this picture comes back as it was.
      const stored = load<{ stack: unknown; seed: number; keepChoice?: "auto" | KeepRes; liveChoice?: "auto" | LiveSize; aspect?: string; text?: unknown }>(storageKey(props.image));
      const restored = stored ? restoreStack(stored.stack) : new StepStack();
      seedRef.current = stored?.seed ?? r.seed;
      setSeed(seedRef.current);
      if (stored?.keepChoice) setKeepChoice(stored.keepChoice);
      if (stored?.liveChoice) setLiveChoice(stored.liveChoice);
      if (stored?.aspect && isAspect(stored.aspect)) setAspect(stored.aspect);
      // The words come back with the picture (a link's own text wins).
      if (!props.text && typeof stored?.text === "string" && stored.text) {
        textRef.current = stored.text.slice(0, MAX_LIVE_TEXT);
        setText(textRef.current);
      }
      try {
        if (!restored.empty) {
          stack.current = restored;
          for (const s of [restored.original, restored.head]) if (s) await ensureStaged(s);
        } else if (props.image) {
          setBusy({ what: "adding", since: performance.now() });
          const st = await transport.stageFile(props.image);
          const ext = props.image.split("?")[0].split(".").pop()?.toLowerCase();
          stack.current = StepStack.from({ url: props.image, name: st.name, w: st.w, h: st.h, sha256: st.sha256, format: ext === "png" ? "png" : ext === "webp" ? "webp" : "jpg" });
          setAspect(aspectOf(st.w, st.h));
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        if (alive) setBusy(null);
      }
      if (!alive) return;
      bump();
      showMaster(stack.current.head);
      setPhase({ s: "ready" });
      latest.current.warm(stack.current.head?.master.name);
    })();
    return () => {
      alive = false;
      off();
      transport.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per transport
  }, [transport]);

  useEffect(() => {
    if (phase.s === "ready") persist();
  }, [view, text, phase.s, persist]);

  // The tab in view: renders pause while it is hidden.
  useEffect(() => {
    const on = () => setHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // ---------------------------------------------------------------------------
  // Rendering

  const paused = !liveOn || hidden || status.running === "other" || !status.online || phase.s !== "ready";
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const sizeNow = (): LiveSize => (liveChoice === "auto" ? auto.current.size : liveChoice);

  const reqFor = (slot: RenderReq["slot"], t: string, o: { urgent?: boolean; seed?: number } = {}): RenderReq => {
    const s = stack.current;
    const base = s.base()?.name;
    return {
      seq: ++seq.current,
      slot,
      urgent: o.urgent,
      text: t,
      seed: o.seed ?? seedRef.current,
      size: sizeNow(),
      keepRes,
      ...(base && { base }),
      ...(mask && { mask: mask.name }),
      aspect,
      method,
    };
  };

  const remember = (key: string, c: Cached) => {
    cache.current.delete(key);
    cache.current.set(key, c);
    while (cache.current.size > CACHE_SIZE) {
      const [k, v] = cache.current.entries().next().value!;
      cache.current.delete(k);
      if (![...masterUrls.current.values()].includes(v.url)) URL.revokeObjectURL(v.url);
    }
  };

  /** Show a frame once its picture is decoded, if nothing newer is already on screen. */
  const present = useCallback((c: Cached, seqNo: number, key: string) => {
    if (seqNo <= shownSeq.current) return;
    const img = new Image();
    img.src = c.url;
    void img
      .decode()
      .catch(() => {})
      .then(() => {
        if (seqNo <= shownSeq.current) return;
        shownSeq.current = seqNo;
        shownKey.current = key;
        setShown({ url: c.url, key, seq: seqNo, kind: c.kind, w: c.out.w, h: c.out.h, ms: c.out.ms, sha256: c.out.sha256 });
      });
  }, []);

  const failed = (error: string, code?: string) => {
    if (code === "missing-nodes") return setPhase({ s: "setup", facts: { ...(facts ?? { highvram: null, missing: [] }), nodes: 0 } });
    if (code === "offline" || code === "stopped") return;
    if (code === "session") return setPhase({ s: "error", message: "This live session ended. Reload the page to go on.", code });
    toast.error(error);
  };

  /** A live or settle render of this text (skipped when it is on screen, in flight, or cached). */
  const render = (slot: "live" | "settle", t: string, o: { urgent?: boolean } = {}) => {
      if (pausedRef.current) return;
      if (!normalize(t) && !stack.current.head) return;
      if (!normalize(t)) {
        // An empty box shows the kept picture.
        showMaster(stack.current.head);
        return;
      }
      const req = reqFor(slot, t, o);
      const key = keyOf(req);
      if (shownKey.current === key) return;
      const alias = slot === "live" ? keyOf({ ...req, size: 0 }) : "";
      const hadKey = cache.current.has(key) ? key : alias && anySize.current.get(alias);
      const had = hadKey ? cache.current.get(hadKey) : undefined;
      if (had && hadKey) {
        present(had, req.seq, hadKey);
        return;
      }
      // A settled picture of the same text can stand in for a live frame.
      const settledKey = keyOf({ ...req, slot: "settle" });
      const settled = slot === "live" ? cache.current.get(settledKey) : undefined;
      if (settled) {
        present(settled, req.seq, settledKey);
        return;
      }
      const going = inflight.current.get(key);
      if (going !== undefined) {
        if (o.urgent) transport.hurry(going);
        return;
      }
      inflight.current.set(key, req.seq);
      const baseAtStart = req.base;
      setBusy((b) => b ?? { what: "rendering", since: performance.now() });
      const sent = performance.now();
      void transport.render(req, onEvent).then((res) => {
        trace({ slot, seq: req.seq, sent, got: performance.now(), ms: res.ok ? res.out.ms : undefined, outcome: res.ok ? "frame" : "dropped" in res ? `dropped:${res.dropped}` : "error" });
        inflight.current.delete(key);
        if (!inflight.current.size) setBusy((b) => (b?.what === "rendering" ? null : b));
        if (!res.ok) {
          if ("error" in res) failed(res.error, res.code);
          return;
        }
        const out = res.out;
        const url = URL.createObjectURL(new Blob([out.data as BlobPart], { type: out.type }));
        const c: Cached = { url, out, kind: slot === "settle" ? "settled" : "live", seed: req.seed, text: t };
        remember(key, c);
        if (alias) anySize.current.set(alias, key);
        if (slot === "live") {
          stack.current.sawLive(out.sha256);
          const next = auto.current.record(out.ms);
          if (next !== liveSize) setLiveSize(next);
        } else {
          setTries((ts) => (ts.some((x) => x.key === key) ? ts : [...ts, { key, url, seed: req.seed, text: t }].slice(-MAX_TRIES)));
        }
        setLastMs(out.ms);
        // A frame for a base that is no longer the head doesn't show.
        if (baseAtStart !== stack.current.base()?.name) return;
        present(c, req.seq, key);
      });
  };


  // Another job ran on the GPU since our last render: the model may be out of memory, warm it first.
  const wasOther = useRef(false);
  useEffect(() => {
    if (status.running === "other") wasOther.current = true;
    else if (wasOther.current && status.online && phase.s === "ready") {
      wasOther.current = false;
      latest.current.warm(stack.current.head?.master.name);
      // The words render again, settle included (a settle the pause dropped would never come back otherwise).
      if (normalize(textRef.current)) latest.current.schedule(textRef.current, undefined, true);
    }
  }, [status.running, status.online, phase.s]);

  // Coming back from a pause (live switched on, the tab in view again, the connection back): the newest text renders,
  // and settles.
  useEffect(() => {
    if (!paused && phase.s === "ready" && normalize(textRef.current)) latest.current.schedule(textRef.current, undefined, true);
  }, [paused, phase.s]);

  const schedule = (t: string, typed?: string, whole = false) => {
      clearTimeout(idle.current);
      clearTimeout(settle.current);
      // A word boundary, a line break or a paste: the words so far render at once (all of them, for a paste, an undo
      // or a redo).
      if (whole || typed === undefined || (typed.length === 1 && endsWord(typed)) || typed.length > 1) {
        const words = whole || (typed && typed.length > 1) ? t : completedWords(t);
        if (normalize(words)) render("live", words);
      }
      // A pause: the exact text, urgently.
      idle.current = setTimeout(() => latest.current.render("live", t, { urgent: true }), IDLE_MS);
      // A longer pause: the full-quality picture of the text on screen (what Keep stores).
      settle.current = setTimeout(() => normalize(t) && latest.current.render("settle", t), SETTLE_MS);
  };

  /** New words in the box: they render (whole: all of them at once). */
  const applyText = (next: string, typed?: string, whole = false) => {
    const t = next.slice(0, MAX_LIVE_TEXT);
    setText(t);
    textRef.current = t;
    if (!normalize(t)) {
      clearTimeout(idle.current);
      clearTimeout(settle.current);
      transport.cancel((_, slot) => slot === "live" || slot === "settle");
      showMaster(stack.current.head);
      return;
    }
    schedule(t, typed, whole);
  };

  const onType = (next: string, typed?: string) => {
    if (textRedo.length) setTextRedo([]);
    applyText(next, typed);
  };

  // A starting text from the link renders once ready.
  useEffect(() => {
    if (phase.s === "ready" && normalize(textRef.current)) latest.current.schedule(textRef.current);
  }, [phase.s]);

  // ---------------------------------------------------------------------------
  // Keeping, undo and redo

  /**
   * Let go of this tab's copies of older masters that the server keeps (the step trail and undo read them from their
   * file): only the newest few, the original and the step before stay in memory.
   */
  const releaseBlobs = () => {
    const s = stack.current;
    const near = new Set([s.head, s.previous(), s.original, ...s.path().slice(-4)].flatMap((x) => (x ? [x.master.name] : [])));
    const drop: string[] = [];
    for (const [name, url] of masterUrls.current) {
      const step = s.all.find((x) => x.master.name === name);
      if (near.has(name) || !step?.master.url || !url.startsWith("blob:")) continue;
      // A settled frame's picture is also the render cache's: that one is let go when the cache drops it.
      if (![...cache.current.values()].some((c) => c.url === url)) URL.revokeObjectURL(url);
      masterUrls.current.delete(name);
      drop.push(name);
    }
    if (drop.length)
      setUrls((u) => {
        const next = { ...u };
        for (const n of drop) delete next[n];
        return next;
      });
  };

  const [keeping, setKeeping] = useState(false);
  /** A keep is running (a ref: two Enters in one tick must not both start one). */
  const keepingRef = useRef(false);

  /**
   * The full-quality picture of this text as a lossless master: the server's file (or this browser's copy, when the
   * account's space is full), staged in ComfyUI under its name. Null when the render didn't come back.
   */
  const makeMaster = async (t: string, keepSeed: number) => {
        const req = reqFor("keep", t, { seed: keepSeed });
        const settledKey = keyOf({ ...req, slot: "settle" });
        const held = cache.current.get(settledKey);
        let out: RenderOut;
        if (held && transport.kind === "computer") {
          // What you saw is what you keep: the settled picture, as it is.
          out = { ...held.out, reused: true };
        } else {
          const res = await transport.render(req, onEvent);
          if (!res.ok) {
            if ("error" in res) failed(res.error, res.code);
            return null;
          }
          out = res.out;
        }
        if (out.type !== "image/png") throw new Error("A kept picture must be a PNG master");
        const size = pngSize(out.data) ?? { w: out.w, h: out.h };
        let url = out.masterUrl;
        let name = out.masterName;
        let idb: string | undefined;
        let local = false;
        // Where the master lives once this tab lets its copy go: the server's file, or this browser's.
        const where: { url?: string; idb?: string } = {};
        if (!name) {
          const st = await transport.stageBytes(out.data, "master", async () => (where.url ? dataUrlBytes(where.url) : where.idb ? idbGet(where.idb) : null));
          name = st.name;
        }
        const blobUrl = held?.url ?? URL.createObjectURL(new Blob([out.data as BlobPart], { type: "image/png" }));
        setMasterUrl(name, blobUrl);
        if (!url) {
          // The computer path: the server keeps the master; this browser keeps it until then, and only if it can't.
          idb = `master:${out.sha256}`;
          await idbPut(idb, out.data);
          const posted = await fetch("/api/live/masters", { method: "POST", headers: { "content-type": "image/png" }, body: out.data as BodyInit }).catch(() => null);
          if (posted?.ok) url = ((await posted.json()) as { url?: string }).url;
          if (url) {
            void idbDel(idb);
            idb = undefined;
          } else local = true;
        }
        where.url = url;
        where.idb = idb;
        return { req, out, size, name, url, idb, local, blobUrl };
  };

  /**
   * Keep the picture of this text. Compose: a fresh start (the picture on screen becomes the new start). The lab's
   * stacking: a new step. The words clear either way; Undo brings them back.
   */
  const keep = async (choice?: { text: string; seed: number }, download = false) => {
      if (keepingRef.current || phase.s !== "ready") return;
      const t = choice?.text ?? textRef.current;
      if (!normalize(t)) return;
      const keepSeed = choice?.seed ?? seedRef.current;
      keepingRef.current = true;
      // The step joins the head it started from (undo, redo and a new picture wait until the keep is done).
      const parent = stack.current.head?.id ?? null;
      setKeeping(true);
      clearTimeout(idle.current);
      clearTimeout(settle.current);
      setBusy({ what: "keeping", since: performance.now() });
      try {
        // Stale live renders of the old base stop now.
        transport.cancel((_, slot) => slot === "live" || slot === "settle");
        const m = await makeMaster(t, keepSeed);
        if (!m) return;
        const step = stack.current.keep({
          text: t,
          norm: normalize(t),
          seed: keepSeed,
          method,
          keepRes: m.req.keepRes,
          ...(mask && { mask: { name: mask.name } }),
          master: { name: m.name, w: m.size.w, h: m.size.h, sha256: m.out.sha256, format: "png", ...(m.url && { url: m.url }), ...(m.idb && { idb: m.idb }) },
          ms: m.out.ms,
          ...(m.local && { local: true }),
        }, parent);
        bump();
        releaseBlobs();
        setText("");
        textRef.current = "";
        setTextRedo([]);
        setTries([]);
        setMask(null);
        showMaster(step);
        setKeptFlash(true);
        setTimeout(() => setKeptFlash(false), 1000);
        if (download) downloadUrl(m.blobUrl, `live-edit-${step.id}.png`);
        if (m.local) toast.message("Kept in this browser only", { description: "Your files are full, so this picture stays here. Download it to keep it." });
        // Once, on a touch screen: how to compare.
        if (load<boolean>(HOLD_HINT) === null && window.matchMedia?.("(pointer: coarse)").matches) {
          save(HOLD_HINT, true);
          toast.message(compose ? "Press and hold the picture to see it before the words" : "Press and hold the picture to see the step before", { description: "The … menu compares with the original too." });
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        keepingRef.current = false;
        setKeeping(false);
        setBusy(null);
      }
  };

  const move = async (to: "undo" | "redo" | string) => {
      if (keepingRef.current) return;
      const s = stack.current;
      const from = s.path();
      const step = to === "undo" ? s.undo() : to === "redo" ? s.redo() : s.jump(to);
      if (!step) return;
      transport.cancel((_, slot) => slot === "live" || slot === "settle");
      setTries([]);
      setTextRedo([]);
      bump();
      if (compose) {
        // Back to an earlier start: the words that led on from it come back, with their seed. Forward: a clean box.
        const at = from.findIndex((x) => x.id === step.id);
        const next = at >= 0 && at < from.length - 1 ? from[at + 1] : null;
        textRef.current = next?.text ?? "";
        setText(textRef.current);
        if (next) {
          seedRef.current = next.seed;
          setSeed(next.seed);
        }
      }
      showMaster(step);
      try {
        await ensureStaged(step);
      } catch {}
      if (normalize(textRef.current)) {
        if (compose) schedule(textRef.current, undefined, true);
        else render("live", textRef.current, { urgent: true });
      }
  };

  /** Undo: compose takes the newest change off the words first, then goes back past a fresh start. */
  const undo = () => {
    const t = textRef.current;
    if (compose && normalize(t)) {
      const left = dropLastChange(t);
      setTextRedo((r) => [...r, { text: left, was: t }]);
      applyText(left, undefined, true);
      return;
    }
    void move("undo");
  };
  const textRedoTop = textRedo.at(-1);
  const canTextRedo = compose && !!textRedoTop && textRedoTop.text === text;
  const redo = () => {
    if (canTextRedo && textRedoTop) {
      setTextRedo((r) => r.slice(0, -1));
      applyText(textRedoTop.was, undefined, true);
      return;
    }
    void move("redo");
  };

  /** A click on a try. Compose: a try is a moment of the session, and the click goes back to its words (and seed). The lab: keep it. */
  const onTry = (e: React.MouseEvent<HTMLButtonElement>) => {
    const t = tries.find((x) => x.key === e.currentTarget.dataset.try);
    if (!t) return;
    if (!compose) return void keep({ text: t.text, seed: t.seed });
    seedRef.current = t.seed;
    setSeed(t.seed);
    if (textRedo.length) setTextRedo([]);
    applyText(t.text, undefined, true);
  };

  /** Live off stops what is rendering for the text; on again, the newest text renders. */
  const toggleLive = () => {
    if (liveOn) {
      clearTimeout(idle.current);
      clearTimeout(settle.current);
      transport.cancel((_, slot) => slot === "live" || slot === "settle");
    }
    setLiveOn(!liveOn);
  };

  const shuffle = () => {
    seedRef.current = Math.floor(Math.random() * 2 ** 31);
    setSeed(seedRef.current);
    if (normalize(textRef.current)) render("live", textRef.current, { urgent: true });
  };

  // ---------------------------------------------------------------------------
  // Pictures in: a file, a paste, a drop

  const addFile = async (file: File) => {
      if (keepingRef.current) {
        toast.message("One moment: keeping the change");
        return;
      }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        toast.error("Add a PNG, JPEG or WebP picture");
        return;
      }
      setBusy({ what: "adding", since: performance.now() });
      try {
        const asset = await postFile(file);
        const st = await transport.stageFile(asset.url);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const ext = pictureExt(bytes);
        stack.current = StepStack.from({ url: asset.url, name: st.name, w: st.w, h: st.h, sha256: st.sha256, format: ext ?? "jpg" });
        setImage(asset.url);
        setAspect(aspectOf(st.w, st.h));
        setTries([]);
        setMask(null);
        bump();
        showMaster(stack.current.head);
        warm(st.name);
        if (normalize(textRef.current)) schedule(textRef.current);
        if (variant === "app") {
          const u = new URL(window.location.href);
          u.searchParams.set("image", asset.url);
          window.history.replaceState(null, "", u);
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(null);
      }
  };
  useEffect(() => {
    latest.current = { warm, render, schedule, addFile };
  });

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) {
        e.preventDefault();
        void latest.current.addFile(f);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const onBrushDone = async (r: SketchResult) => {
    if (!r.mask) return;
    try {
      const st = await transport.stageBytes(await dataUrlBytes(r.mask), "mask");
      setMask({ name: st.name, preview: r.overlay });
      if (normalize(textRef.current)) render("live", textRef.current, { urgent: true });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ---------------------------------------------------------------------------
  // Saving and downloading

  const current = shown?.url ?? urlOf(head);

  /** Compose: the full-quality picture of the words on screen (the settled frame, rendered now if it isn't there yet). */
  const settledNow = async (): Promise<Cached | null> => {
    const t = textRef.current;
    const req = reqFor("settle", t);
    const key = keyOf(req);
    const had = cache.current.get(key);
    if (had) return had;
    setBusy((b) => b ?? { what: "rendering", since: performance.now() });
    const res = await transport.render(req, onEvent);
    setBusy((b) => (b?.what === "rendering" && !inflight.current.size ? null : b));
    if (!res.ok) {
      if ("error" in res) failed(res.error, res.code);
      return null;
    }
    const c: Cached = { url: URL.createObjectURL(new Blob([res.out.data as BlobPart], { type: res.out.type })), out: res.out, kind: "settled", seed: req.seed, text: t };
    remember(key, c);
    present(c, req.seq, key);
    return c;
  };

  const download = async () => {
    if (compose && normalize(textRef.current)) {
      const c = await settledNow();
      if (c) downloadUrl(c.url, `live-edit-${head?.id ?? "frame"}.png`);
      return;
    }
    if (current) downloadUrl(current, `live-edit-${head?.id ?? "frame"}.${shown?.kind === "live" ? "webp" : "png"}`);
  };

  /** What Save and Use hand on: compose with words, the picture on screen as a new master (the words stay); else the kept head. */
  const canHandOn = compose ? !!normalize(text) || view.path.length > 1 : !!head?.master.url && view.path.length > 1;
  const handOn = async (): Promise<string | null> => {
    const h = stack.current.head;
    if (!(compose && normalize(textRef.current))) return h?.master.url ?? null;
    if (keepingRef.current || phase.s !== "ready") return null;
    keepingRef.current = true;
    setKeeping(true);
    setBusy({ what: "saving", since: performance.now() });
    try {
      const m = await makeMaster(textRef.current, seedRef.current);
      if (m && !m.url) toast.error("Your files are full, so this picture can't be handed on. Download it instead.");
      return m?.url ?? null;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    } finally {
      keepingRef.current = false;
      setKeeping(false);
      setBusy(null);
    }
  };
  const sendToEdit = async () => {
    const url = await handOn();
    if (url) props.onUse?.(url);
  };
  const saveToLibrary = async () => {
    const s = stack.current;
    const open = compose && normalize(textRef.current) ? textRef.current : "";
    const seedNow = seedRef.current;
    const url = await handOn();
    if (!url) return open ? undefined : toast.error("Make a change first");
    const steps = [...s.path().filter((x) => x.text).map((x) => ({ text: x.text, seed: x.seed })), ...(open ? [{ text: open, seed: seedNow }] : [])];
    const res = await fetch("/api/live/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master: url, ...(s.original?.master.url && s.original.parent === null && s.original.text === "" && { original: s.original.master.url }), steps, ...(props.from && { from: props.from }) }),
    });
    if (res.ok) toast.success("Saved to your Library");
    else toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save");
  };

  const canKeep = !!normalize(text) && phase.s === "ready" && !keeping;

  // ---------------------------------------------------------------------------
  // Keys

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inBox = el === box.current;
      const inOther = !inBox && !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (inOther || brushOpen || compareOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z") && !e.shiftKey && (!inBox || !textRef.current)) {
        e.preventDefault();
        undo();
      } else if (mod && (((e.key === "z" || e.key === "Z") && e.shiftKey) || e.key === "y") && (!inBox || !textRef.current)) {
        e.preventDefault();
        redo();
      }
      if (inBox || mod || e.altKey) return;
      const k = e.key;
      if (k === "/") {
        e.preventDefault();
        box.current?.focus();
      } else if (k === "r" || k === "R") shuffle();
      else if (k === "l" || k === "L") toggleLive();
      else if (k === "c" || k === "C") setHold(e.shiftKey ? "orig" : "prev");
      else if ((k === "b" || k === "B") && hasPicture) setBrushOpen(true);
      else if (k === "d" || k === "D") void download();
      else if ((k === "f" || k === "F") && compose && canKeep) void keep();
      else if ((k === "s" || k === "S") && props.canSave) void saveToLibrary();
      else if (k === "?") setKeysOpen(true);
      else if (k === "ArrowLeft" || k === "ArrowRight") {
        const path = stack.current.path();
        const all = stack.current.all;
        const at = all.findIndex((x) => x.id === stack.current.head?.id);
        const next = all[at + (k === "ArrowLeft" ? -1 : 1)];
        if (next) void move(next.id);
        else if (!path.length) return;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "c" || e.key === "C" || e.key === "Shift") setHold(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  });

  // ---------------------------------------------------------------------------
  // The page

  const path = view.path;
  const previous = view.previous;
  const original = view.original;
  /** "Before": with words in the box (compose), the picture they change; otherwise the step before. */
  const before = compose && normalize(text) ? head : (previous ?? original);
  const heldUrl = hold === "orig" ? urlOf(original) : hold === "prev" ? urlOf(before) : null;
  const stageUrl = heldUrl ?? current;
  /** A very long prompt: a late change can lose out to the earlier ones, and the box nears its limit. */
  const longPrompt = changeCount(text) >= LONG_PROMPT_CHANGES || text.length > MAX_LIVE_TEXT - 60;
  const link = transport.kind === "link";

  const pill = (() => {
    if (phase.s === "connecting") return { tone: "wait", text: "Connecting…" };
    if (phase.s === "setup") return { tone: "warn", text: "Set up needed" };
    if (phase.s === "error") return { tone: "warn", text: "Not available" };
    if (!status.online) return { tone: "wait", text: "Reconnecting…" };
    if (status.running === "other") return { tone: "warn", text: "Paused: GPU busy" };
    if (busy?.what === "keeping") return { tone: "busy", text: compose ? "Starting fresh…" : "Keeping…" };
    if (busy?.what === "saving") return { tone: "busy", text: "Getting it ready…" };
    if (busy?.what === "warming") return { tone: "busy", text: "Warming up (about 20 s)" };
    if (busy?.what === "adding") return { tone: "busy", text: "Adding the picture…" };
    if (!liveOn) return { tone: "off", text: "Live off" };
    if (keptFlash) return { tone: "ok", text: compose ? "Fresh start ✓" : "Kept ✓" };
    const label = link ? "Live (slower over a link)" : "Live";
    // A kept picture's size is on its badge; the pill tells the live size and time only for live and settled frames.
    if (!shown || shown.kind === "master") return { tone: busy ? "busy" : "ok", text: label };
    const size = shown.kind === "live" ? sizeShown : Math.max(shown.w, shown.h);
    return { tone: busy ? "busy" : "ok", text: label, detail: `${size}${lastMs !== null ? ` · ${(lastMs / 1000).toFixed(2)} s` : ""}` };
  })() as { tone: string; text: string; detail?: string };

  const setupPanel = phase.s === "setup" ? <LiveSetup facts={phase.facts} computer={transport.kind === "computer"} /> : null;
  const errorPanel = phase.s === "error" ? <LiveProblem message={phase.message} code={phase.code} /> : null;

  return (
    <div
      className={cn("flex min-h-0 w-full flex-col bg-background", embedded ? "h-full rounded-2xl border" : "h-content")}
      data-live-editor
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
        setDragging(false);
        if (f) {
          e.preventDefault();
          void addFile(f);
        }
      }}
    >
      {/* Top bar */}
      <header className={cn("flex min-w-0 shrink-0 items-center gap-1.5 px-3 sm:px-4", embedded ? "h-12" : "h-14")}>
        {!embedded && (
          <Link href={props.from === "edit" ? "/edit" : props.from === "library" ? "/library" : "/"} className="-ml-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent md:hidden" aria-label="Back">
            <ChevronLeft className="size-4" />
          </Link>
        )}
        <h1 className={cn("flex shrink-0 items-center gap-2 font-heading leading-none whitespace-nowrap", embedded ? "text-[18px]" : "text-[22px]")}>
          <Zap className="size-4 text-primary" />
          <span className="max-sm:sr-only">Live edit</span>
        </h1>
        <StatusPill tone={pill.tone} text={pill.text} detail={pill.detail} progress={busy?.progress} />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ToolButton label={compose && normalize(text) ? "Undo the last change" : "Undo"} keys="Ctrl+Z" onClick={() => undo()} disabled={!(compose && normalize(text)) && !view.canUndo}>
            <Undo2 />
          </ToolButton>
          <ToolButton label="Redo" keys="Ctrl+Shift+Z" onClick={() => redo()} disabled={!canTextRedo && !view.canRedo}>
            <Redo2 />
          </ToolButton>
          <ToolButton label="Compare" keys="hold C" onClick={() => setCompareOpen(true)} disabled={!previous && !original} className="max-sm:hidden">
            <ArrowLeftRight />
          </ToolButton>
          <ToolButton label="Shuffle" keys="R" onClick={shuffle} disabled={!normalize(text)} className="max-sm:hidden">
            <Shuffle />
          </ToolButton>
          <ToolButton label={mask ? "Change the painted region" : "Paint a region"} keys="B" onClick={() => setBrushOpen(true)} disabled={!hasPicture} active={!!mask} className="max-sm:hidden">
            <Brush />
          </ToolButton>
          <ToolButton label={liveOn ? "Live on" : "Live off"} keys="L" onClick={toggleLive} active={!liveOn} className="max-sm:hidden">
            {liveOn ? <Zap /> : <ZapOff />}
          </ToolButton>
          <Settings
            liveChoice={liveChoice}
            setLiveChoice={setLiveChoice}
            keepChoice={keepChoice}
            setKeepChoice={setKeepChoice}
            aspect={aspect}
            setAspect={setAspect}
            hasPicture={hasPicture}
            seed={seed}
            lab={props.lab}
            compose={compose}
            method={method}
            setMethod={setMethod}
            onKeys={() => setKeysOpen(true)}
            phone={{
              shuffle: normalize(text) ? shuffle : undefined,
              brush: hasPicture ? () => setBrushOpen(true) : undefined,
              brushLabel: mask ? "Change the painted region" : "Paint a region",
              compare: previous || original ? () => setCompareOpen(true) : undefined,
              liveOn,
              toggleLive,
              download: current ? () => void download() : undefined,
              save: !embedded && props.canSave && canHandOn ? () => void saveToLibrary() : undefined,
              fullScreen: embedded ? `/live-edit${image ? `?image=${encodeURIComponent(image)}&from=edit` : "?from=edit"}` : undefined,
            }}
          />
          <ToolButton label="Download" keys="D" onClick={() => void download()} disabled={!current} className="max-sm:hidden">
            <Download />
          </ToolButton>
          {embedded ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="ghost" asChild className="max-sm:hidden">
                    <Link href={`/live-edit${image ? `?image=${encodeURIComponent(image)}&from=edit` : "?from=edit"}`} aria-label="Full screen">
                      <Expand className="size-4" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Full screen</TooltipContent>
              </Tooltip>
              <Button size="sm" onClick={() => void sendToEdit()} disabled={!canHandOn || keeping} className="ml-1 max-sm:px-2.5">
                <span className="max-sm:hidden">Use in Edit</span>
                <span className="sm:hidden">Use</span>
              </Button>
              {props.onClose && (
                <ToolButton label="Close live" onClick={props.onClose}>
                  <X />
                </ToolButton>
              )}
            </>
          ) : props.canSave ? (
            <Button size="sm" variant="secondary" onClick={() => void saveToLibrary()} disabled={!canHandOn || keeping} className="ml-1 max-sm:hidden">
              <Save className="size-4" />
              Save
            </Button>
          ) : null}
        </div>
      </header>

      {/* Stage */}
      <div className={cn("relative mx-3 min-h-0 flex-1 overflow-hidden rounded-2xl bg-media sm:mx-4", dragging && "ring-2 ring-primary")} data-live-stage onPointerDown={(e) => e.pointerType !== "mouse" && setHold("prev")} onPointerUp={() => setHold(null)} onPointerLeave={() => setHold(null)}>
        {setupPanel ?? errorPanel ?? (stageUrl ? <StageImage src={stageUrl} alt={hold ? "The picture before this change" : "Your picture"} /> : <EmptyStage busy={busy?.what === "adding"} compose={compose} onBrowse={() => fileInput.current?.click()} />)}
        {mask && !hold && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mask.preview} alt="" className="pointer-events-none absolute inset-0 size-full object-contain opacity-35 mix-blend-screen" />
        )}
        {stageUrl && phase.s === "ready" && (
          <span className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white tabular-nums backdrop-blur" data-live-badge>
            {hold
              ? hold === "orig"
                ? "Original"
                : "Before"
              : shown?.kind === "master"
                ? `${shown.w}×${shown.h} · ${compose ? (head?.parent ? "fresh start" : "original") : "kept ✓"}`
                : shown?.kind === "settled"
                  ? `${shown.w}×${shown.h} · ${compose ? "full quality" : "ready to keep"}`
                  : `${sizeShown} · live`}
          </span>
        )}
      </div>

      {/* Steps, the box, tries */}
      <div className={cn("shrink-0 px-3 pt-2 sm:px-4", embedded ? "pb-3" : "pb-[max(12px,env(safe-area-inset-bottom))]")}>
        {/* Compose shows its starts only once there is a fresh start to go back to. */}
        {(!compose || path.length > 1) && <StepTrail path={path} all={view.all} headId={head?.id} onJump={(id) => void move(id)} urlOf={urlOf} />}
        <div className="mt-2 flex items-end gap-2">
          <div className="relative min-w-0 flex-1 rounded-2xl border bg-card shadow-soft focus-within:border-primary/60 focus-within:ring-3 focus-within:ring-ring/25">
            <textarea
              ref={box}
              value={text}
              rows={1}
              maxLength={MAX_LIVE_TEXT}
              placeholder={hasPicture ? (compose ? "Type a change, then keep adding…" : head?.parent ? "Type the next change…" : "Type a change…") : "Describe a picture, or drop one here…"}
              aria-label="Type a change"
              className="block max-h-28 min-h-11 w-full resize-none bg-transparent px-3.5 py-3 text-[15px] leading-5 outline-none placeholder:text-muted-foreground [field-sizing:content]"
              onChange={(e) => {
                const native = e.nativeEvent as InputEvent;
                onType(e.target.value, native.data ?? (native.inputType === "insertLineBreak" ? "\n" : native.inputType === "insertFromPaste" ? e.target.value : undefined));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && compose && !e.nativeEvent.isComposing) {
                  // Enter ends this change and starts the next (Ctrl+Enter: download the picture).
                  e.preventDefault();
                  if (e.metaKey || e.ctrlKey) return void download();
                  const next = nextChange(textRef.current);
                  if (next !== textRef.current) onType(next, ", ");
                } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void keep(undefined, e.metaKey || e.ctrlKey);
                } else if (e.key === "Escape") box.current?.blur();
              }}
              disabled={phase.s !== "ready"}
            />
          </div>
          {compose ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="lg" variant="secondary" className={cn("h-11 shrink-0 rounded-2xl px-4 max-sm:w-11 max-sm:px-0", keptFlash && "bg-success text-white hover:bg-success")} onClick={() => void keep()} disabled={!canKeep} aria-label="Start fresh from this picture" data-live-keep>
                  {keeping ? <Loader2 className="size-4 animate-spin" /> : keptFlash ? <Check className="motion-confirm size-4" /> : <Layers className="size-4" />}
                  <span className="max-sm:hidden">Start fresh</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">Start fresh from this picture: it becomes the new original and the words clear. Undo brings them back.</TooltipContent>
            </Tooltip>
          ) : (
            <Button size="lg" className={cn("h-11 shrink-0 rounded-2xl px-4", keptFlash && "bg-success hover:bg-success")} onClick={() => void keep()} disabled={!canKeep} data-live-keep>
              {keeping ? <Loader2 className="size-4 animate-spin" /> : keptFlash ? <Check className="motion-confirm size-4" /> : <CornerDownLeft className="size-4" />}
              {keptFlash ? "Kept" : "Keep"}
            </Button>
          )}
        </div>
        {(tries.length > 0 || hasPicture) && (
          // The row keeps its height from the start, so the picture doesn't move when the first try comes in.
          <div className="mt-2 flex h-[46px] items-center gap-1.5 overflow-x-auto pb-0.5" data-live-tries={tries.length > 0 ? "" : undefined}>
            <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">{compose ? "Takes" : "Tries"}</span>
            {tries.length === 0 && (
              <span className="truncate text-[11.5px] text-subtle-foreground">{compose ? "Each pause lands here. Tap one to go back to it." : "Pause while typing and each take lands here. Click one to keep it."}</span>
            )}
            {tries.map((t) => (
              <Tooltip key={t.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onTry}
                    data-try={t.key}
                    className={cn("relative size-11 shrink-0 overflow-hidden rounded-lg ring-1 ring-border hover:ring-2 hover:ring-primary", shown?.key === t.key && "ring-2 ring-primary")}
                    aria-label={compose ? `Go back to: ${t.text}` : `Keep this try (seed ${t.seed})`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.url} alt="" className="size-full object-cover" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">{compose ? t.text : "Keep this one"}</TooltipContent>
              </Tooltip>
            ))}
            {tries.length > 0 && (
              <span className="shrink-0 text-[11.5px] text-muted-foreground max-sm:hidden">
                <Kbd>R</Kbd> for another
              </span>
            )}
          </div>
        )}
        {compose && longPrompt && phase.s === "ready" && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground" data-live-long>
            <span className="min-w-0 flex-1 truncate">A long prompt: a new change may not show.</span>
            <button type="button" onClick={() => void keep()} disabled={!canKeep} className="shrink-0 font-medium text-brand-text hover:underline disabled:opacity-50">
              Start fresh from this picture
            </button>
          </p>
        )}
        {facts?.highvram === false && highvramHint && phase.s === "ready" && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground" data-live-highvram>
            <span className="min-w-0 flex-1 truncate">Faster: start ComfyUI with --highvram (live frames take about twice as long without it).</span>
            <button
              type="button"
              onClick={() => {
                setHighvramHint(false);
                save(HIGHVRAM_HINT, false);
              }}
              className="shrink-0 rounded p-0.5 hover:bg-accent"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </p>
        )}
        {!embedded && !hasPicture && phase.s === "ready" && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            No picture? Typing makes one. <button type="button" onClick={() => fileInput.current?.click()} className="font-medium text-brand-text hover:underline">Add a picture</button> to change it instead.
          </p>
        )}
      </div>

      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0])} />

      {current && (head || shown) && (
        <SketchEditor open={brushOpen} onOpenChange={setBrushOpen} image={urlOf(head) ?? current} mode="mask" onDone={(r) => void onBrushDone(r)} />
      )}
      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        after={current}
        before={compareWith === "prev" ? urlOf(before) : urlOf(original)}
        which={compareWith}
        setWhich={setCompareWith}
        prevLabel={compose && normalize(text) ? "Before the words" : "With the step before"}
        same={before?.id === original?.id}
      />
      <KeysDialog open={keysOpen} onOpenChange={setKeysOpen} canSave={props.canSave} compose={compose} />
    </div>
  );
}

export function downloadUrl(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Parts

/** The live status. `detail` (size and time) is left out on phones, where the picture's badge has the size. */
function StatusPill({ tone, text, detail, progress }: { tone: string; text: string; detail?: string; progress?: number }) {
  return (
    <span
      role="status"
      data-live-pill
      className={cn(
        "relative ml-1 inline-flex h-7 min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap tabular-nums",
        tone === "warn" && "border-warning/40 text-warning",
        tone === "off" && "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", tone === "ok" ? "bg-success" : tone === "busy" ? "animate-pulse bg-primary" : tone === "warn" ? "bg-warning" : tone === "wait" ? "animate-pulse bg-muted-foreground" : "bg-subtle-foreground")} />
      <span className="truncate">
        {text}
        {detail && <span className="max-sm:hidden"> · {detail}</span>}
      </span>
      {tone === "busy" && progress !== undefined && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/70 origin-left transition-transform duration-(--motion-slow) ease-standard" style={{ transform: `scaleX(${(Math.round(progress * 100)) / 100})` }} />}
    </span>
  );
}

function ToolButton({ label, keys, onClick, disabled, active, className, children }: { label: string; keys?: string; onClick: () => void; disabled?: boolean; active?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active} className={cn("size-8 [&_svg]:size-4", active && "bg-brand-faint text-brand-text", className)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys && <Kbd className="ml-1.5">{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Two stacked pictures: a new one is decoded first, then faded in over the last (no flash between frames). */
function StageImage({ src, alt }: { src: string; alt: string }) {
  const [layers, setLayers] = useState<{ a: string; b: string | null }>({ a: src, b: null });
  useEffect(() => {
    if (src === layers.a) return;
    let alive = true;
    const img = new Image();
    img.src = src;
    void img
      .decode()
      .catch(() => {})
      .then(() => alive && setLayers((l) => ({ a: src, b: l.a })));
    return () => {
      alive = false;
    };
  }, [src, layers.a]);
  return (
    <div className="absolute inset-0">
      {layers.b && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={layers.b} alt="" aria-hidden className="absolute inset-0 box-border size-full object-contain p-2 sm:p-4" draggable={false} />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img key={layers.a} src={layers.a} alt={alt} className="absolute inset-0 box-border size-full animate-[live-fade_120ms_ease-out] object-contain p-2 sm:p-4" draggable={false} data-live-frame />
    </div>
  );
}

function EmptyStage({ busy, compose, onBrowse }: { busy: boolean; compose: boolean; onBrowse: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
      <div className="max-w-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white/10">{busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}</span>
        <p className="mt-4 font-heading text-[24px] leading-tight">Drop a picture, paste one, or start typing to make one</p>
        <p className="mt-2 text-[13px] text-white/65">{compose ? "The picture follows as you type. Keep adding to the words: every change lands on your picture." : "Each change shows up as you type. Press Enter to keep it, then type the next."}</p>
        <Button variant="secondary" className="mt-5" onClick={onBrowse}>
          <Upload className="size-4" />
          Add a picture
        </Button>
      </div>
    </div>
  );
}

function StepTrail({ path, all, headId, onJump, urlOf }: { path: Step[]; all: readonly Step[]; headId?: string; onJump: (id: string) => void; urlOf: (s: Step) => string | null }) {
  if (!path.length) return null;
  const branches = all.length - path.length;
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5 text-[12px]" data-live-steps>
      {path.map((s, i) => (
        <div key={s.id} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span className="text-subtle-foreground">›</span>}
          <button
            type="button"
            onClick={() => onJump(s.id)}
            className={cn("inline-flex h-7 max-w-52 items-center gap-1.5 rounded-full border pr-2.5 pl-0.5 transition-colors hover:bg-accent", s.id === headId && "border-primary/50 bg-brand-faint text-brand-text")}
            title={s.text || "Original"}
            data-live-step={s.id}
          >
            {urlOf(s) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urlOf(s)!} alt="" className="size-6 rounded-full object-cover" />
            ) : (
              <span className="size-6 rounded-full bg-muted" />
            )}
            <span className="truncate">{i === 0 && !s.text ? "Original" : `${i} · ${s.text}`}</span>
            {s.local && <span className="text-[10px] text-warning">this browser</span>}
          </button>
        </div>
      ))}
      {branches > 0 && <span className="ml-1 shrink-0 text-[11px] text-muted-foreground">+{branches} on another branch</span>}
    </div>
  );
}

function Settings(p: {
  liveChoice: "auto" | LiveSize;
  setLiveChoice: (v: "auto" | LiveSize) => void;
  keepChoice: "auto" | KeepRes;
  setKeepChoice: (v: "auto" | KeepRes) => void;
  aspect: Aspect;
  setAspect: (a: Aspect) => void;
  hasPicture: boolean;
  seed: number;
  lab?: boolean;
  compose: boolean;
  method: Method;
  setMethod: (m: Method) => void;
  onKeys: () => void;
  /** On phones the header keeps Undo, Redo and this menu: the other actions are here. */
  phone: {
    shuffle?: () => void;
    brush?: () => void;
    brushLabel: string;
    compare?: () => void;
    liveOn: boolean;
    toggleLive: () => void;
    download?: () => void;
    save?: () => void;
    fullScreen?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const act = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };
  const item = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] hover:bg-accent disabled:opacity-40 [&_svg]:size-4 [&_svg]:text-muted-foreground";
  const ph = p.phone;
  const row = "flex items-center justify-between gap-3 py-1.5";
  const seg = <T extends string | number>(value: T, options: { v: T; label: string }[], set: (v: T) => void) => (
    <div className="flex rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button key={String(o.v)} type="button" onClick={() => set(o.v)} className={cn("h-6 rounded-md px-2 text-[12px]", value === o.v ? "bg-background font-medium shadow-soft" : "text-muted-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8 [&_svg]:size-4" aria-label="Live settings">
              <MoreHorizontal />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-24px)] text-[13px]">
        <div className="-mx-1 mb-2 grid gap-0.5 border-b pb-2 sm:hidden" data-live-phone-menu>
          {ph.save && (
            <button type="button" className={item} onClick={act(ph.save)}>
              <Save />
              Save to your Library
            </button>
          )}
          <button type="button" className={item} onClick={act(ph.compare)} disabled={!ph.compare}>
            <ArrowLeftRight />
            Compare
          </button>
          <button type="button" className={item} onClick={act(ph.brush)} disabled={!ph.brush}>
            <Brush />
            {ph.brushLabel}
          </button>
          <button type="button" className={item} onClick={act(ph.shuffle)} disabled={!ph.shuffle}>
            <Shuffle />
            Shuffle: another take
          </button>
          <button type="button" className={item} onClick={act(ph.toggleLive)} aria-pressed={!ph.liveOn}>
            {ph.liveOn ? <ZapOff /> : <Zap />}
            {ph.liveOn ? "Pause live" : "Live on"}
          </button>
          <button type="button" className={item} onClick={act(ph.download)} disabled={!ph.download}>
            <Download />
            Download
          </button>
          {ph.fullScreen && (
            <Link href={ph.fullScreen} className={item} onClick={() => setOpen(false)}>
              <Expand />
              Full screen
            </Link>
          )}
        </div>
        <div className={row}>
          <span>Live size</span>
          {seg<"auto" | LiveSize>(p.liveChoice, [{ v: "auto", label: "Auto" }, ...LIVE_LADDER.map((n) => ({ v: n as LiveSize, label: String(n) }))], p.setLiveChoice)}
        </div>
        <div className={row}>
          <span>Keep detail</span>
          {seg<"auto" | KeepRes>(p.keepChoice, [{ v: "auto", label: "Auto" }, ...KEEP_LADDER.map((n) => ({ v: n as KeepRes, label: String(n) }))], p.setKeepChoice)}
        </div>
        {!p.hasPicture && (
          <div className={row}>
            <span>Shape</span>
            <select value={p.aspect} onChange={(e) => p.setAspect(e.target.value as Aspect)} className="h-7 rounded-md border bg-background px-2 text-[12px]">
              {["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </div>
        )}
        <div className={row}>
          <span>Seed</span>
          <span className="font-mono text-[12px] text-muted-foreground">{p.seed}</span>
        </div>
        {p.lab && (
          <div className={row}>
            <span>Method</span>
            {seg<Method>(p.method, [{ v: "compose", label: "Compose" }, { v: "hybrid", label: "Hybrid" }, { v: "chain", label: "Chain" }], p.setMethod)}
          </div>
        )}
        <p className="mt-2 border-t pt-2 text-[12px] text-muted-foreground">
          {p.compose
            ? "Every frame renders all your words on the same picture, so nothing blurs however long they get. Start fresh makes the picture on screen the new original."
            : "Kept steps are lossless masters at full size: unchanged parts of the picture stay exactly as they were, however many changes you stack."}
        </p>
        <button type="button" onClick={p.onKeys} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-text hover:underline">
          <Keyboard className="size-3.5" />
          Keyboard shortcuts
        </button>
      </PopoverContent>
    </Popover>
  );
}

function CompareDialog({
  open,
  onOpenChange,
  before,
  after,
  which,
  setWhich,
  prevLabel,
  same,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  before: string | null;
  after: string | null;
  which: "prev" | "orig";
  setWhich: (w: "prev" | "orig") => void;
  prevLabel: string;
  /** "Before" is the original: one choice, so no switch. */
  same: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,1100px)] max-w-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Compare</DialogTitle>
          <DialogDescription>Drag across the picture, or use the arrow keys.</DialogDescription>
        </DialogHeader>
        {!same && (
          <div className="flex gap-1 self-start rounded-lg bg-muted p-0.5 text-[12.5px]">
            {(["prev", "orig"] as const).map((w) => (
              <button key={w} type="button" onClick={() => setWhich(w)} className={cn("h-7 rounded-md px-2.5", which === w ? "bg-background font-medium shadow-soft" : "text-muted-foreground")}>
                {w === "prev" ? prevLabel : "With the original"}
              </button>
            ))}
          </div>
        )}
        <div className="grid max-h-[72vh] place-items-center overflow-hidden rounded-xl bg-media">{before && after ? <CompareSlider before={before} after={after} /> : <p className="p-10 text-white/70">Keep a change to compare.</p>}</div>
      </DialogContent>
    </Dialog>
  );
}

const COMPOSE_KEYS: [string, string][] = [
  ["/", "Type a change (Esc leaves the box)"],
  ["Enter", "End this change and type the next"],
  ["Ctrl+Enter", "Download the picture"],
  ["Ctrl+Z", "Undo the last change (in the box: when it is empty)"],
  ["Ctrl+Shift+Z", "Redo"],
  ["F", "Start fresh from this picture"],
  ["R", "Shuffle: another take of the words"],
  ["L", "Live on or off"],
  ["C (hold)", "Compare with the picture before the words"],
  ["Shift+C (hold)", "Compare with the original"],
  ["B", "Paint a region to change"],
  ["D", "Download"],
  ["S", "Save to your Library"],
  ["← →", "Step through your fresh starts"],
  ["?", "These shortcuts"],
];

const KEYS: [string, string][] = [
  ["/", "Type a change (Esc leaves the box)"],
  ["Enter", "Keep the change (Shift+Enter: a new line)"],
  ["Ctrl+Enter", "Keep it and download it"],
  ["Ctrl+Z", "Undo a step (in the box: when it is empty)"],
  ["Ctrl+Shift+Z", "Redo"],
  ["R", "Shuffle: another take of this change"],
  ["L", "Live on or off"],
  ["C (hold)", "Compare with the step before"],
  ["Shift+C (hold)", "Compare with the original"],
  ["B", "Paint a region to change"],
  ["D", "Download"],
  ["S", "Save to your Library"],
  ["← →", "Step through the kept steps"],
  ["?", "These shortcuts"],
];

function KeysDialog({ open, onOpenChange, canSave, compose }: { open: boolean; onOpenChange: (o: boolean) => void; canSave: boolean; compose: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Outside the text box, unless it says otherwise.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {(compose ? COMPOSE_KEYS : KEYS).filter(([k]) => canSave || k !== "S").map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** What this ComfyUI still needs for live edit: Fuobe's live nodes, model files, and a restart. */
export function LiveSetup({ facts, computer }: { facts: LiveFacts; computer: boolean }) {
  const [files, setFiles] = useState<{ key: string; url: string; sizeBytes: number; folder: string; file: string }[]>([]);
  useEffect(() => {
    void fetch("/api/gpu/requirements")
      .then((r) => (r.ok ? r.json() : null))
      .then((idx: { files?: Record<string, { folder: string; file: string; pinnedUrl: string; sizeBytes: number }> } | null) => {
        if (!idx?.files) return;
        setFiles(facts.missing.flatMap((k) => (idx.files![k] ? [{ key: k, url: idx.files![k].pinnedUrl, sizeBytes: idx.files![k].sizeBytes, folder: idx.files![k].folder, file: idx.files![k].file }] : [])));
      })
      .catch(() => {});
  }, [facts.missing]);
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background/95 p-5 sm:p-8" data-live-setup>
      <div className="mx-auto max-w-xl">
        <p className="font-heading text-[26px] leading-tight">Set up live edit on your GPU</p>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">Live edit runs Qwen-Image 2.1 with a 2-step LoRA on your own ComfyUI. Best on a GPU with 20 GB or more.</p>
        <ol className="mt-5 space-y-3 text-[13.5px]">
          {!facts.nodes && (
            <li className="rounded-xl border p-3.5">
              <p className="font-medium">{facts.outdated ? "Update Fuobe's live nodes" : "Add Fuobe's live nodes"}</p>
              <p className="mt-1 text-muted-foreground">
                {facts.outdated ? "ComfyUI has another copy of fuobe_live.py. Put this one in its place in custom_nodes, then restart ComfyUI." : "One file for ComfyUI's custom_nodes folder (fuobe_live.py). Then restart ComfyUI."}
              </p>
              <Button asChild size="sm" className="mt-2.5">
                <a href="/api/live/nodes" download>
                  <Download className="size-4" />
                  Download Fuobe&apos;s live nodes
                </a>
              </Button>
            </li>
          )}
          {facts.missing.length > 0 && (
            <li className="rounded-xl border p-3.5">
              <p className="font-medium">Add the model files</p>
              <ul className="mt-2 space-y-1.5">
                {(files.length ? files : facts.missing.map((k) => ({ key: k, url: "", sizeBytes: 0, folder: k.split("/")[0], file: k.split("/").slice(1).join("/") }))).map((f) => (
                  <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                    {f.url ? (
                      <a href={f.url} className="font-medium text-brand-text hover:underline" rel="noreferrer">
                        {f.file}
                      </a>
                    ) : (
                      <span className="font-medium">{f.file}</span>
                    )}
                    <span className="text-muted-foreground">
                      into models/{f.folder}
                      {f.sizeBytes ? ` · ${(f.sizeBytes / 1e9).toFixed(f.sizeBytes > 1e9 ? 2 : 3)} GB` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          )}
          <li className="rounded-xl border p-3.5 text-muted-foreground">
            Restart ComfyUI{facts.highvram === false ? " with --highvram (live frames take about twice as long without it)" : ""}, then reload this page.{" "}
            <Link href={computer ? "/settings" : "/connect"} className="font-medium text-brand-text hover:underline">
              {computer ? "Your GPU" : "Check your GPU"}
            </Link>
          </li>
        </ol>
      </div>
    </div>
  );
}

function LiveProblem({ message, code }: { message: string; code?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
      <div className="max-w-sm">
        <p className="font-heading text-[24px] leading-tight">{code === "off" ? "Live edit is off" : "Live edit can't start"}</p>
        <p className="mt-2 text-[13px] text-white/70">{message}</p>
        <Button variant="secondary" className="mt-5" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
