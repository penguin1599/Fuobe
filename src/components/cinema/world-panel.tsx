"use client";

import { Clapperboard, Film, Globe, Loader2, Music, Plus, Route, RotateCcw, Trash2, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStatus } from "@/lib/api";
import { useOwnSetupPress } from "@/components/own-setup";
import { planCinema, type CinemaGenerateInput, type DirectorSettings } from "@/lib/catalog/cinema";
import type { Engine } from "@/lib/catalog/types";
import { placeholdersOn } from "@/lib/demo-mode";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import {
  PERSPECTIVES,
  STYLES,
  WORLD_LIMITS,
  WORLD_MOVES,
  allTurns,
  canRun,
  clampSeconds,
  clipSeconds,
  clipsFromTakes,
  exportClips,
  newTurn,
  newWorld,
  nextTurn,
  normalizeWorld,
  worldProblem,
  worldSeconds,
  type TurnState,
  type WorldScript,
  type WorldTakeLike,
  type WorldTurn,
} from "@/lib/world";
import { pathSketch } from "@/lib/world-path";
import { useCinemaGenerate } from "./hooks";

/**
 * World mode in Cinema's take composer (package nm10-hy-nomas-world): the opening (the world in words, who the camera
 * follows, the look), then turns, each with what changes, a camera move from the fly-path library and its length; the
 * camera's path from above; Run turn, Redo from here (the turns before it stay), and Export, which joins the turns into
 * one film. Hy-Nomas runs on your GPU only, and makes no sound: Sound for video and Music come after.
 */

const STORE = (projectId: string) => `fuobe.cinema.world.${projectId}`;
const section = "space-y-2.5 border-t pt-4 first:border-t-0 first:pt-0";
const h3 = "text-[12px] font-medium tracking-wide text-muted-foreground uppercase";
const select = "h-8 min-w-0 rounded-full border bg-background px-3 text-[12.5px]";
/** A colour per turn, for the timeline and the path (the brand hue turning round the wheel). */
const hue = (k: number) => `oklch(0.66 0.15 ${(250 + k * 47) % 360})`;

function restore(projectId: string, takes: readonly WorldTakeLike[]): WorldScript {
  try {
    const raw = localStorage.getItem(STORE(projectId));
    if (raw) return normalizeWorld(JSON.parse(raw) as WorldScript);
  } catch {
    // A private window or blocked storage: start from the takes, or a new world.
  }
  const last = [...takes].filter((t) => t.take?.world && !t.take.world.joined).sort((a, b) => b.createdAt - a.createdAt)[0] as (WorldTakeLike & { take?: { world?: { script?: WorldScript } } }) | undefined;
  return last?.take?.world?.script ? normalizeWorld(last.take.world.script) : newWorld();
}

const STATE_WORDS: Record<TurnState, string> = { done: "Ready", running: "Filming…", failed: "Didn't finish", stale: "Changed: run it again", none: "Not run yet" };

export interface WorldPanelProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  folderId: string | null;
  engine: Engine;
  onEngine: (e: Engine) => void;
  /** The engine mode allows the open engine (not "Paid APIs only"). */
  openAllowed: boolean;
  settings: DirectorSettings;
  brief: string;
  context: { cloudAllowed: boolean; civitai?: boolean; worldcast?: boolean };
  /** The project's takes: the World turns' clips come from them. */
  takes: readonly WorldTakeLike[];
}

export function WorldPanel(props: WorldPanelProps) {
  const { open, onOpenChange, projectId, folderId, engine, onEngine, openAllowed, settings, brief, context, takes } = props;
  const generate = useCinemaGenerate(projectId);
  const demo = placeholdersOn(useStatus().data?.demoMode);
  const [script, setScript] = useState<WorldScript | null>(null);
  const [redoAt, setRedoAt] = useState<Record<number, number>>({});
  const [showPath, setShowPath] = useState(false);
  const [busy, setBusy] = useState<number | "export" | null>(null);

  // The script is read once the panel opens (the browser's copy, else the newest World take's), then kept as edited.
  if (open && !script) setScript(restore(projectId, takes));
  useEffect(() => {
    if (!script) return;
    try {
      localStorage.setItem(STORE(projectId), JSON.stringify(script));
    } catch {
      // Not saved in this browser: the takes keep the script each turn was made from.
    }
  }, [script, projectId]);

  const w = script ?? newWorld(0);
  // The script as it runs (words trimmed, lengths on the half second): what is sent, keyed and checked. `w` is what the
  // fields show while they are edited.
  const tidy = useMemo(() => normalizeWorld(w), [w]);
  const { clips, states } = useMemo(() => clipsFromTakes(tidy, takes, redoAt), [tidy, takes, redoAt]);
  const next = nextTurn(tidy, clips);
  const exported = exportClips(tidy, clips);
  const target = next >= 0 ? next : tidy.turns.length;
  const input = (k: number, join?: string[]): Omit<CinemaGenerateInput, "brief"> => ({ engine, mode: "video", action: "world", prompt: "", settings, world: { script: tidy, turn: k, ...(join ? { join } : {}) } });
  const plan = useMemo(() => planCinema({ ...input(target), brief }, context), [tidy, target, engine, settings, brief, context]); // eslint-disable-line react-hooks/exhaustive-deps
  const price = demo ? "Placeholder · free" : "Free";
  const total = worldSeconds(tidy);
  const sketch = useMemo(() => pathSketch(allTurns(tidy).map((t) => ({ move: t.move, seconds: t.seconds }))), [tidy]);

  const set = (fn: (s: WorldScript) => WorldScript) => setScript((s) => fn(s ?? newWorld()));
  const setTurn = (k: number, patch: Partial<WorldTurn>) =>
    set((s) => (k === 0 ? { ...s, opening: { ...s.opening, ...patch } } : { ...s, turns: s.turns.map((t, i) => (i === k - 1 ? { ...t, ...patch } : t)) }));

  // A visitor films on its own GPU: a guest gets the sign-up card, an account without one "Connect your GPU".
  const press = useOwnSetupPress();
  const run = (k: number) => void press("cinema:world", () => void film(k));
  const film = async (k: number) => {
    const problem = engine !== "open" ? "World mode runs on your GPU (open source)" : worldProblem(tidy, k);
    if (problem) return toast.error(problem);
    setBusy(k);
    try {
      await generate.mutateAsync({ input: input(k) as CinemaGenerateInput, folderId });
      toast.success(k === 0 ? "Filming the opening on your GPU — it lands in this scene as a new take" : `Filming turn ${k} on your GPU — it lands in this scene as a new take`);
    } catch (e) {
      toastError(e, "Couldn't film that turn");
    } finally {
      setBusy(null);
    }
  };
  const redo = (k: number) =>
    void press("cinema:world", () => {
      // A little before now: the take's time is the server's clock.
      setRedoAt((r) => ({ ...r, [k]: Date.now() - 2000 }));
      void film(k);
    });
  const exportFilm = async () => {
    if (!exported) return;
    setBusy("export");
    try {
      await generate.mutateAsync({ input: input(tidy.turns.length, exported) as CinemaGenerateInput, folderId });
      toast.success("Joining the turns into one film — it lands in this scene as a new take", {
        duration: 8000,
        description: "Hy-Nomas makes no sound: add it afterwards.",
        action: { label: "Sound for video", onClick: () => window.open("/audio/video", "_self") },
      });
    } catch (e) {
      toastError(e, "Couldn't join the turns");
    } finally {
      setBusy(null);
    }
  };

  const turnCard = (t: WorldTurn, k: number) => {
    const clip = clips[k];
    const state = states[k];
    const runnable = canRun(tidy, clips, k);
    const opening = k === 0;
    return (
      <li key={k} className="grid gap-2 rounded-xl border p-3" style={{ borderLeft: `4px solid ${hue(k)}` }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{opening ? "Opening" : `Turn ${k}`}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", state === "done" ? "bg-brand-faint text-brand-text" : state === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
            {state === "running" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
            {STATE_WORDS[state]}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {!opening && (
              <button type="button" onClick={() => set((s) => ({ ...s, turns: s.turns.filter((_, i) => i !== k - 1) }))} className="grid size-7 place-items-center rounded-md hover:bg-accent" aria-label={`Remove turn ${k}`}>
                <Trash2 className="size-3.5" />
              </button>
            )}
          </span>
        </div>
        <Textarea
          value={t.words}
          onChange={(e) => setTurn(k, { words: e.target.value.slice(0, opening ? WORLD_LIMITS.maxScene : WORLD_LIMITS.maxWords) })}
          rows={opening ? 3 : 2}
          placeholder={opening ? "The world it starts in: a stone path through a forest at dusk, blue fireflies between mossy trees, mist on the ground" : "What changes: a wooden bridge crosses a glowing stream ahead"}
          className="min-h-0 resize-none text-[13px]"
          aria-label={opening ? "The world, in words" : `Turn ${k}: what changes`}
        />
        {opening && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={w.opening.subject ?? ""} onChange={(e) => set((s) => ({ ...s, opening: { ...s.opening, subject: e.target.value.slice(0, 120) } }))} placeholder="Who the camera follows (optional): a small orange fox" className="h-8 text-[13px]" aria-label="Who the camera follows" />
            <Input value={w.opening.details ?? ""} onChange={(e) => set((s) => ({ ...s, opening: { ...s.opening, details: e.target.value.slice(0, WORLD_LIMITS.maxWords) } }))} placeholder="How they look (optional)" className="h-8 text-[13px]" aria-label="How they look" />
          </div>
        )}
        <Input value={t.action ?? ""} onChange={(e) => setTurn(k, { action: e.target.value.slice(0, WORLD_LIMITS.maxWords) })} placeholder={opening ? "What happens first (optional): the fox walks along the path" : "What they do (optional)"} className="h-8 text-[13px]" aria-label={opening ? "What happens first" : `Turn ${k}: what they do`} />
        <div className="flex flex-wrap items-center gap-2">
          {opening && (
            <>
              <select value={w.opening.perspective} onChange={(e) => set((s) => ({ ...s, opening: { ...s.opening, perspective: e.target.value as WorldScript["opening"]["perspective"] } }))} className={select} aria-label="Camera">
                {PERSPECTIVES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select value={w.opening.style} onChange={(e) => set((s) => ({ ...s, opening: { ...s.opening, style: e.target.value as WorldScript["opening"]["style"] } }))} className={select} aria-label="Look">
                {STYLES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <select value={t.move} onChange={(e) => setTurn(k, { move: e.target.value })} className={cn(select, "font-medium")} aria-label={opening ? "Opening camera move" : `Turn ${k}: camera move`} title={WORLD_MOVES.find((m) => m.id === t.move)?.description}>
            {WORLD_MOVES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[12.5px] text-muted-foreground">
            <Input
              type="number"
              min={WORLD_LIMITS.minSeconds}
              max={WORLD_LIMITS.maxSeconds}
              step={WORLD_LIMITS.step}
              value={t.seconds}
              onChange={(e) => setTurn(k, { seconds: Number(e.target.value) })}
              onBlur={() => setTurn(k, { seconds: clampSeconds(t.seconds) })}
              className="h-8 w-16 px-2 text-[12.5px] tabular-nums"
              aria-label={opening ? "Opening length in seconds" : `Turn ${k} length in seconds`}
            />
            s
          </label>
        </div>
        {clip?.url && <video src={clip.url} controls muted playsInline className="aspect-video w-full rounded-lg bg-black" aria-label={opening ? "The opening" : `Turn ${k}`} />}
        <div className="flex flex-wrap gap-1.5">
          {!clip && (
            <Button size="sm" onClick={() => run(k)} disabled={!runnable || busy !== null}>
              {busy === k ? <Loader2 className="size-3.5 animate-spin" /> : <Clapperboard className="size-3.5" />} Run {opening ? "the opening" : "turn"}
            </Button>
          )}
          {(clip || state === "stale") && (
            <Button size="sm" variant="outline" onClick={() => redo(k)} disabled={!runnable || busy !== null} title="Films this turn again and the ones after it; the turns before it stay. The same words and move give the same turn: change them for a different one">
              <RotateCcw className="size-3.5" /> Redo from here
            </Button>
          )}
          {!runnable && !clip && k > 0 && <span className="self-center text-[12px] text-muted-foreground">Runs once the turn before it is ready</span>}
        </div>
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[100svh] w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[92svh] sm:max-w-2xl">
        <DialogHeader className="border-b px-4 pt-4 pb-3 text-left sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Globe className="size-4" /> World
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">Describe a world once, then steer it turn by turn with words and camera moves. Each turn picks up where the last one stopped.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {engine !== "open" && (
            <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-3 text-[12.5px] sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1">
                <span className="font-medium">Runs on your GPU (open source).</span> World mode uses Hy-Nomas, which no cloud service offers yet.
              </p>
              {openAllowed && (
                <Button size="sm" variant="outline" onClick={() => onEngine("open")}>
                  Use your GPU
                </Button>
              )}
            </div>
          )}
          <section className={section} aria-label="Turns">
            <div className="flex items-center justify-between gap-2">
              <h3 className={h3}>Turns</h3>
              <span className="text-[12px] text-muted-foreground tabular-nums">
                {total} s of {WORLD_LIMITS.maxTotal} s
              </span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              {allTurns(tidy).map((t, k) => (
                <div key={k} style={{ width: `${(t.seconds / WORLD_LIMITS.maxTotal) * 100}%`, background: hue(k), opacity: states[k] === "done" ? 1 : 0.35 }} />
              ))}
            </div>
            <ol className="space-y-2">{allTurns(w).map((t, k) => turnCard(t, k))}</ol>
            <Button
              size="sm"
              variant="outline"
              onClick={() => set((s) => ({ ...s, turns: [...s.turns, newTurn()] }))}
              disabled={w.turns.length + 1 >= WORLD_LIMITS.maxTurns || total + newTurn().seconds > WORLD_LIMITS.maxTotal}
            >
              <Plus className="size-3.5" /> Add a turn
            </Button>
          </section>

          <section className={section} aria-label="Camera path">
            <div className="flex items-center justify-between gap-2">
              <h3 className={h3}>Camera path</h3>
              <Button size="sm" variant="ghost" onClick={() => setShowPath((v) => !v)} aria-expanded={showPath}>
                <Route className="size-3.5" /> {showPath ? "Hide the path" : "Preview the path"}
              </Button>
            </div>
            {showPath && <PathSketch sketch={sketch} />}
          </section>

          <section className={section} aria-label="Sound">
            <h3 className={h3}>Sound</h3>
            <p className="text-[12.5px] text-muted-foreground">Hy-Nomas films without sound. Add it to the finished film afterwards:</p>
            <div className="flex flex-wrap gap-1.5">
              <Button asChild size="sm" variant="outline">
                <Link href="/audio/video">
                  <Volume2 className="size-3.5" /> Sound for video
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/audio/music">
                  <Music className="size-3.5" /> Music
                </Link>
              </Button>
            </div>
          </section>
        </div>
        <div className="border-t px-4 py-3 sm:px-5">
          {!!plan.notes.length && engine === "open" && (
            <ul className="mb-2 space-y-0.5 text-[12px] text-muted-foreground">
              {plan.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[12.5px]">
              <span className="font-medium">{price}</span>
              <span className="text-muted-foreground"> · Hy-Nomas on your GPU · about {clipSeconds(allTurns(tidy)[target] ?? tidy.opening)} s a turn</span>
              {plan.blocker && <span className="block truncate text-[12px] text-muted-foreground">{plan.blocker}</span>}
            </p>
            <Button variant="outline" onClick={exportFilm} disabled={!exported || exported.length < 2 || busy !== null || engine !== "open"}>
              {busy === "export" ? <Loader2 className="size-4 animate-spin" /> : <Film className="size-4" />} Export
            </Button>
            {next >= 0 && (
              <Button onClick={() => run(next)} disabled={!!plan.blocker || !canRun(tidy, clips, next) || busy !== null}>
                {busy === next ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />} {next === 0 ? "Run the opening" : `Run turn ${next}`}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The camera's path from above: one line per turn in its colour, a dot where each turn starts, the camera's heading at the end. */
function PathSketch({ sketch }: { sketch: ReturnType<typeof pathSketch> }) {
  const { points, starts, headings } = sketch;
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const pad = 0.4;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad;
  const maxZ = Math.max(...zs) + pad;
  const size = Math.max(maxX - minX, maxZ - minZ, 1);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const view = `${cx - size / 2} ${cz - size / 2} ${size} ${size}`;
  const stroke = size / 120;
  const segments = starts.map((s, k) => points.slice(s, (starts[k + 1] ?? points.length - 1) + 1));
  const last = points[points.length - 1];
  const yaw = headings[headings.length - 1] ?? 0;
  const arrow = size / 14;
  return (
    <figure className="space-y-1.5">
      <svg viewBox={view} className="aspect-square w-full max-w-[320px] rounded-xl border bg-muted/40" role="img" aria-label="The camera's path from above, one colour per turn">
        {segments.map((seg, k) => (
          <polyline key={k} points={seg.map((p) => p.join(",")).join(" ")} fill="none" stroke={hue(k)} strokeWidth={stroke * 2.2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {starts.map((s, k) => (
          <circle key={k} cx={points[s][0]} cy={points[s][1]} r={stroke * 3} fill={hue(k)} />
        ))}
        {last && <line x1={last[0]} y1={last[1]} x2={last[0] - Math.sin(yaw) * arrow} y2={last[1] - Math.cos(yaw) * arrow} stroke="currentColor" strokeWidth={stroke * 1.6} strokeLinecap="round" />}
      </svg>
      <figcaption className="text-[12px] text-muted-foreground">Seen from above: the camera starts at the first dot; the line at the end shows where it looks.</figcaption>
    </figure>
  );
}
