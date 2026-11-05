"use client";

import { useMutation, useQuery, keepPreviousData } from "@tanstack/react-query";
import { AlertTriangle, Check, ImageOff, Loader2, Rotate3d, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { COMPUTER_KICK_EVENT, useEngine, useGenerations, useLikelyVisitor } from "@/lib/api";
import { SOUL_ID_COPY } from "@/lib/catalog/training";
import {
  FILL_NAMES,
  SIDE_NAMES,
  SIDES_HINT,
  TURN_PATHS,
  TURN_ROUTES,
  TURN_SIDES,
  elementPictures,
  startingViews,
  type TurnPicture,
  type TurnFill,
  type TurnRoute,
  type TurnSide,
  type TurnaroundPreview,
} from "@/lib/catalog/turnaround";
import type { Engine, Generation } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { responseError, toastError } from "@/lib/refusals";

/** The body /api/turnaround takes (src/server/turnaround.ts TurnaroundSchema). */
export interface TurnaroundBody {
  engine: Engine;
  views: Partial<Record<TurnSide, string>>;
  sheet?: string;
  route?: TurnRoute;
  fill?: boolean;
  fillWith?: TurnFill;
  path?: string;
  duration?: number;
  aspectRatio?: "9:16" | "16:9";
  name?: string;
  realPerson?: boolean;
  consent?: boolean;
  elementId?: string;
}

interface Props {
  /** The pictures the sheet or the character offers (src/lib/catalog/turnaround.ts sheetPictures / elementPictures). */
  pictures: TurnPicture[];
  name?: string;
  /** Start with "A real person" on (photos the user brought), so the consent line is asked for. */
  realPerson?: boolean;
  /** Made from a character's page: the film goes into its feed. */
  elementId?: string;
  /** A fixed engine (Cinema's project engine); otherwise the app's engine switch. */
  engine?: Engine;
  /** Run it elsewhere (Cinema files it as a take); otherwise POST /api/turnaround. Returns the generations made. */
  onRun?: (body: TurnaroundBody) => Promise<Generation[]>;
  /** The features the run's rows are filed under, to follow its progress. */
  features?: string[];
  title?: string;
  /** "Fly around": the character page's wording, with the camera path's moves. */
  flyAround?: boolean;
  /** A person Fuobe made up (Soul Cast): no consent line to ask for. */
  fictional?: boolean;
  /** The route the dialog starts on, on your GPU (the pre-flight board's "Turnaround stills · 8 views" link). */
  route?: TurnRoute;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, out.error ?? "Something went wrong. Please try again.");
  return out;
}

/** A started run; `front`: a still set's own front picture (shown first with the drawn views). */
type Run = { ids: string[]; filmId: string; front?: string };

const runFeatures = (p: Pick<Props, "features" | "elementId">) => p.features ?? (p.elementId ? [`element:${p.elementId}`, "turnaround-step"] : ["turnaround", "turnaround-step"]);

/** A run's rows as the live feed has them: how many steps are done, what is working, the film once it's made. */
function useRunState(run: Run | null, features: string[]) {
  const list = useGenerations({ features, limit: 200 });
  const rows = run ? (list.data ?? []).filter((g) => run.ids.includes(g.id)) : [];
  const film = run ? rows.find((g) => g.id === run.filmId) : undefined;
  const failed = rows.find((g) => g.status === "failed" || g.status === "canceled");
  return {
    rows,
    film,
    failed,
    done: rows.filter((g) => g.status === "succeeded").length,
    total: run?.ids.length ?? 0,
    working: rows.find((g) => g.status === "running") ?? rows.filter((g) => g.status === "queued" && g.id !== run?.filmId).at(-1),
    video: film?.status === "succeeded" ? film.outputs.find((o) => o.kind === "video") : undefined,
  };
}

/**
 * "Turnaround video" / "Fly around this character": a button that opens the dialog. The run it starts stays with the
 * button while the page is open: the button says how far it got, and opening it again shows the progress or the film.
 */
export function TurnaroundButton({
  label,
  variant = "outline",
  size = "sm",
  className,
  compact,
  ...props
}: Props & { label?: string; variant?: "outline" | "secondary" | "ghost" | "default"; size?: "sm" | "default"; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const state = useRunState(run, runFeatures(props));
  const text = label ?? (props.flyAround ? "Fly around this character" : "Turnaround video");
  // A still set has no film: it is ready once every picture is drawn.
  const ready = !!state.video || (!!run && state.total > 0 && state.done === state.total);
  const status = !run ? undefined : ready ? "ready" : state.failed ? "stopped" : `${state.done} of ${state.total}`;
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={!props.pictures.length}
        onClick={() => setOpen(true)}
        aria-label={compact ? `${text}${status ? ` (${status})` : ""}` : undefined}
      >
        {run && !ready && !state.failed ? <Loader2 className="animate-spin" /> : <Rotate3d />}
        <span className={cn(compact && "hidden sm:inline")}>{text}</span>
        {status && <span className={cn("font-mono text-[11px] text-muted-foreground", compact && "hidden sm:inline")}>· {status}</span>}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[92svh] gap-3 overflow-y-auto sm:max-w-[640px]"
          // Focus the dialog itself, not its first control: no tooltip or focus ring pops up on the engine switch or a slot.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          {open && (run ? <RunView heading={headingOf(props)} state={state} front={run.front} elementId={props.elementId} onAgain={() => setRun(null)} /> : <TurnaroundForm {...props} onStarted={setRun} />)}
        </DialogContent>
      </Dialog>
    </>
  );
}

const headingOf = (p: Pick<Props, "title" | "flyAround" | "name">) => p.title ?? (p.flyAround ? `Fly around ${p.name ?? "this character"}` : "Turnaround video");

const SLOT_KEYS = [...TURN_SIDES, "sheet"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

function Thumb({ url, className }: { url?: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className={cn("size-full object-cover", className)} /> : null;
}

function TurnaroundForm({ pictures, name, realPerson: realDefault = false, elementId, engine: fixedEngine, onRun, title, flyAround, fictional, route: startRoute, onStarted }: Props & { onStarted: (run: Run) => void }) {
  const [appEngine, setAppEngine, engineMode] = useEngine();
  const engine = fixedEngine ?? appEngine;
  // The note about your GPU is for the studio's own install with both engines: guests and accounts run in the cloud.
  const visitor = useLikelyVisitor();
  const start = useMemo(() => startingViews(pictures), [pictures]);
  const [views, setViews] = useState<Partial<Record<TurnSide, string>>>(start.views);
  const [sheet, setSheet] = useState<string | undefined>(start.sheet);
  const [fill, setFill] = useState<boolean | undefined>(undefined);
  const [fillWith, setFillWith] = useState<TurnFill>("angles");
  // The route and length picked hold for the engine they were picked on: another engine starts from its own defaults.
  const [picked, setPicked] = useState<{ engine: Engine; route?: TurnRoute; duration?: number }>({ engine, ...(engine === "open" && startRoute && { route: startRoute }) });
  const route = picked.engine === engine ? picked.route : undefined;
  const duration = picked.engine === engine ? picked.duration : undefined;
  const setRoute = (r: TurnRoute) => setPicked({ engine, route: r });
  const setDuration = (d: number) => setPicked((x) => ({ ...(x.engine === engine ? x : { engine }), duration: d }));
  const [path, setPath] = useState<string | undefined>(undefined);
  const [aspectRatio, setAspect] = useState<"9:16" | "16:9">("9:16");
  // A character is a person whatever the switch says: the server asks for its consent line (or has it on file).
  const [realPerson, setReal] = useState(realDefault || !!elementId);
  const [consent, setConsent] = useState(false);
  const guard = useSubmitGuard();

  const body: TurnaroundBody = {
    engine,
    views,
    ...(sheet && { sheet }),
    ...(route && { route }),
    ...(fill !== undefined && { fill }),
    ...(engine === "open" && fillWith !== "angles" && { fillWith }),
    ...(path && { path }),
    ...(duration && { duration }),
    aspectRatio,
    ...(name && { name }),
    ...(realPerson && { realPerson, consent }),
    ...(elementId && { elementId }),
  };
  const preview = useQuery({
    queryKey: ["turnaround-preview", body],
    queryFn: () => post<TurnaroundPreview>("/api/turnaround?preview=1", body),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const p = preview.data;
  const make = useMutation({
    // The request id stays the same for the same body until it succeeds, so a repeat (a lost answer, a second click)
    // gets the first run. useSubmitGuard's id, not crypto.randomUUID: that is missing on a plain-http LAN address.
    mutationFn: async ({ b, requestId }: { b: TurnaroundBody; requestId: string }): Promise<{ items: Generation[]; filmId?: string }> =>
      onRun ? { items: await onRun(b) } : post<{ items: Generation[]; filmId: string }>("/api/turnaround", { ...b, requestId }),
    // The film: the one the server names, else the joined clips, else the one video the run makes (drawn pictures are stills).
    onSuccess: ({ items, filmId }) => {
      // The tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for them at once.
      window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
      const front = (p?.route ?? route) === "stills" ? p?.frames.find((f) => f.side === "front")?.url : undefined;
      onStarted({ ids: items.map((g) => g.id), filmId: filmId ?? (items.find((g) => g.op === "concat") ?? items.find((g) => g.kind === "video") ?? items[0])?.id, ...(front && { front }) });
    },
    onError: (e) => toastError(e),
  });
  const makeIt = () => void guard(JSON.stringify(body), (requestId) => make.mutateAsync({ b: body, requestId })).catch(() => {});

  const usedRoute = p?.route ?? route;
  const camera = usedRoute === "camera";
  const stills = usedRoute === "stills";
  // QMA · 96 views is offered on your GPU when this install has it (its Stills route is listed then).
  const qmaHere = engine === "open" && !!p?.routes.includes("stills");
  const slotUrl = (k: SlotKey) => (k === "sheet" ? sheet : views[k]);
  const setSlot = (k: SlotKey, url: string | undefined) => {
    if (k === "sheet") setSheet(url);
    else setViews((v) => ({ ...v, [k]: url }));
  };
  const price = !p ? "" : p.demo ? "Placeholder · free" : engine === "open" ? `Free · on your GPU${p.gpuGb ? `, about ${p.gpuGb} GB` : ""}` : p.costUsd != null ? `≈ ${formatCost(p.costUsd)}` : "";
  const heading = headingOf({ title, flyAround, name });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-heading text-[24px] font-normal">{heading}</DialogTitle>
        <DialogDescription>The camera goes all the way round the character, starting and ending on the front: the front, their right side, their back, their left side.</DialogDescription>
      </DialogHeader>

      {!fixedEngine && (
        <div className="flex flex-wrap items-center gap-2">
          <EngineSwitch value={appEngine} onChange={setAppEngine} size="sm" compact={false} />
        </div>
      )}

      <section aria-label="Views" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[13px] font-medium">Views</p>
          <p className="text-[11.5px] text-muted-foreground">{SIDES_HINT}</p>
        </div>
        <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {SLOT_KEYS.map((k) => {
            const url = slotUrl(k);
            const frame = p?.frames.find((f) => f.side === k);
            const drawn = !url && (frame?.from === "angles" || frame?.from === "sheet");
            const label = k === "sheet" ? "Sheet" : SIDE_NAMES[k];
            return (
              <DropdownMenu key={k}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${label}: ${url ? "a picture" : drawn ? "drawn first" : k === "front" ? "pick one" : "not used"} — change`}
                    className="group flex min-w-0 flex-col gap-1 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        "relative grid aspect-[3/4] w-full place-items-center overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/30",
                        !url && "border-dashed",
                        k === "front" && !url && !drawn && "border-destructive/60",
                      )}
                    >
                      {url ? (
                        <Thumb url={url} />
                      ) : drawn ? (
                        <span className="flex flex-col items-center gap-1 px-1 text-center text-[10.5px] leading-tight text-muted-foreground">
                          <Sparkles className="size-4" aria-hidden />
                          {frame?.from === "sheet" ? "From the sheet" : "Drawn first"}
                        </span>
                      ) : (
                        <ImageOff className="size-4 text-muted-foreground/70" aria-hidden />
                      )}
                    </span>
                    <span className="truncate text-[11.5px] font-medium">{label}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>{label}</DropdownMenuLabel>
                  {pictures
                    .filter((pic) => (k === "sheet" ? pic.sheet : !pic.sheet))
                    .map((pic) => (
                      <DropdownMenuItem key={pic.url} onSelect={() => setSlot(k, pic.url)}>
                        <span className="size-8 shrink-0 overflow-hidden rounded-md bg-muted">
                          <Thumb url={pic.url} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{pic.label}</span>
                        {slotUrl(k) === pic.url && <Check className="size-4" />}
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setSlot(k, undefined)}>
                    {k === "sheet" ? "Don't use the sheet" : k === "front" ? (sheet ? "Draw it from the sheet" : "None") : "Draw it from the front, or leave it out"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
        </div>
        {!camera && !stills && (
          <label className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">Draw the missing sides</span>
              <span className="block text-[11.5px] text-muted-foreground">The Angles app turns the front view round first; without it, the film goes from one view you have to the next</span>
            </span>
            <Switch checked={p?.fill ?? fill ?? true} onCheckedChange={(v) => setFill(v)} aria-label="Draw the missing sides" />
          </label>
        )}
        {qmaHere && !camera && !stills && (p?.fill ?? fill ?? true) && (
          <Chips
            label="Drawn with"
            value={fillWith}
            options={(Object.keys(FILL_NAMES) as TurnFill[]).map((k) => ({ value: k, label: FILL_NAMES[k] }))}
            onChange={(v) => setFillWith(v as TurnFill)}
            hint={fillWith === "qma" ? "Turns the camera round the front view on your GPU, one of 96 set angles" : undefined}
          />
        )}
      </section>

      {p && p.routes.length > 1 && (
        <Chips label="Route" value={usedRoute} options={p.routes.map((r) => ({ value: r, label: TURN_ROUTES[r].name }))} onChange={(v) => setRoute(v as TurnRoute)} hint={usedRoute ? TURN_ROUTES[usedRoute].detail : undefined} />
      )}
      {p && p.routes.length === 1 && usedRoute && <p className="text-[12px] text-muted-foreground">{TURN_ROUTES[usedRoute].detail}.</p>}
      {engine === "cloud" && !visitor && engineMode === "both" && <p className="text-[12px] text-muted-foreground">The 8-view still set, and sides drawn with QMA · 96 views, run on your GPU (open source).</p>}
      {camera && <Chips label="Path" value={path ?? TURN_PATHS[0].id} options={TURN_PATHS.map((x) => ({ value: x.id, label: x.name }))} onChange={setPath} hint={TURN_PATHS.find((x) => x.id === (path ?? TURN_PATHS[0].id))?.description} />}
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {p && p.durations.length > 0 && <Chips label="Length" value={String(p.duration)} options={p.durations.map((d) => ({ value: String(d), label: `${d} s` }))} onChange={(v) => setDuration(Number(v))} />}
        {!camera && !stills && (
          <Chips
            label="Shape"
            value={aspectRatio}
            options={[
              { value: "9:16", label: "Portrait" },
              { value: "16:9", label: "Landscape" },
            ]}
            onChange={(v) => setAspect(v as "9:16" | "16:9")}
          />
        )}
      </div>

      {!fictional && (
        <section aria-label="Consent" className="space-y-2 rounded-xl border p-3">
          {elementId ? (
            // A character always is a person, as for a Soul ID: no switch to turn it off.
            <p className="text-[13px] font-medium">Consent</p>
          ) : (
            <label className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">A real person</span>
              <Switch checked={realPerson} onCheckedChange={setReal} aria-label="These pictures show a real person" />
            </label>
          )}
          {p?.consent === "on-file" ? (
            <p className="flex items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
              <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Confirmed when {name ?? "this character"} was trained for Soul ID: {SOUL_ID_COPY.consent}
            </p>
          ) : realPerson ? (
            <label className="flex items-start gap-2 text-[12px] leading-snug text-muted-foreground">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" aria-label="I confirm the consent line" />
              <span>{SOUL_ID_COPY.consent}</span>
            </label>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">Turn this on when the pictures show someone real: their consent is needed, as for a Soul ID.</p>
          )}
          <p className="text-[11.5px] text-muted-foreground">Don&apos;t use a turnaround to pass someone off as doing something they didn&apos;t.</p>
        </section>
      )}

      {p && (p.notes.length > 0 || p.blocker) && (
        <ul className="space-y-0.5 text-[12px] text-muted-foreground">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t pt-3">
        {preview.isError && !preview.isFetching ? (
          // The plan couldn't be priced (the server didn't answer): say so, and let it be asked again.
          <p role="status" className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> Couldn&apos;t price it: {(preview.error as Error).message}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void preview.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          p?.blocker && (
            <p role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-[12.5px] text-destructive">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> {p.blocker}
            </p>
          )
        )}
        <span className="font-mono text-[12px] whitespace-nowrap text-muted-foreground" aria-live="polite">
          {preview.isFetching && !p ? "Pricing…" : price}
        </span>
        <Button onClick={makeIt} disabled={!p || !!p.blocker || preview.isError || make.isPending || preview.isFetching}>
          {make.isPending ? <Loader2 className="animate-spin" /> : <Rotate3d />} {stills ? "Make 8 views" : flyAround ? "Fly around" : "Make turnaround"}
        </Button>
      </div>
    </>
  );
}

function Chips({ label, value, options, onChange, hint }: { label: string; value?: string; options: { value: string; label: string }[]; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-[12.5px] font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} onKeyDown={radioKeys} className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            tabIndex={radioTab(value === o.value)}
            onClick={() => onChange(o.value)}
            className={cn("h-8 rounded-full border px-3 text-[12.5px] font-medium transition-colors", value === o.value ? "border-primary bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent")}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint && <p className="text-[11.5px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A character's pictures with their shapes, measured in the browser (a wide one is its sheet): elementPictures, before the
 * sizes are in with every picture taken as a photo.
 */
export function useCharacterPictures(urls: string[]): TurnPicture[] {
  const key = urls.join("\n");
  const [sizes, setSizes] = useState<{ key: string; list: { url: string; width?: number; height?: number }[] } | null>(null);
  useEffect(() => {
    let live = true;
    const list = key ? key.split("\n") : [];
    void Promise.all(
      list.map(
        (url) =>
          new Promise<{ url: string; width?: number; height?: number }>((done) => {
            const img = new Image();
            img.onload = () => done({ url, width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => done({ url });
            img.src = url;
          }),
      ),
    ).then((measured) => live && setSizes({ key, list: measured }));
    return () => {
      live = false;
    };
  }, [key]);
  return useMemo(() => elementPictures(sizes?.key === key ? sizes.list : urls.map((url) => ({ url }))), [sizes, key, urls]);
}

/** A run's progress, then the finished turnaround. */
function RunView({ heading, state, front, elementId, onAgain }: { heading: string; state: ReturnType<typeof useRunState>; front?: string; elementId?: string; onAgain: () => void }) {
  const { video, failed, done, total, working } = state;
  // A still set (Stills · 8 views): once every one is drawn, the front first, then the views in the run's order, each named.
  const drawn =
    !video && total > 0 && done === total
      ? [...state.rows]
          .sort((a, b) => (a.request.step?.index ?? 0) - (b.request.step?.index ?? 0))
          .flatMap((g) => g.outputs.filter((o) => o.kind === "image").map((o) => ({ url: o.url, label: g.request.step?.label?.startsWith("Front view") ? "Front" : (g.request.step?.label ?? "") })))
      : [];
  const pictures = drawn.length ? [...(front ? [{ url: front, label: "Front" }] : []), ...drawn] : [];
  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-heading text-[24px] font-normal">{pictures.length ? "Turnaround stills" : heading}</DialogTitle>
        <DialogDescription>{pictures.length ? "Your views are ready." : video ? "Your turnaround is ready." : failed ? "A step didn't finish." : "Making it now: you can close this, it carries on."}</DialogDescription>
      </DialogHeader>
      {pictures.length > 0 ? (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {pictures.map((o) => (
            <a key={o.url} href={o.url} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-lg bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={o.url} alt={o.label} className="aspect-[3/4] w-full object-cover" />
              {o.label && <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-0.5 text-[11.5px] font-medium text-white">{o.label}</span>}
            </a>
          ))}
        </div>
      ) : video ? (
        <video src={video.url} controls loop playsInline autoPlay muted className="max-h-[60svh] w-full rounded-xl bg-black object-contain" aria-label={`${heading}, the video`} />
      ) : failed ? (
        <p role="alert" className="rounded-xl border border-destructive/40 p-3 text-[13px] text-destructive">
          {failed.request.step?.label ? `${failed.request.step.label}: ` : ""}
          {failed.error ?? "It stopped before the end"}
        </p>
      ) : (
        <div className="space-y-2" role="status" aria-live="polite">
          <Progress value={total ? (done / total) * 100 : 0} aria-label="Turnaround progress" />
          <p className="text-[12.5px] text-muted-foreground">
            {done} of {total} steps done{working ? ` · ${working.request.step?.label ?? working.message ?? "Working"}` : ""}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
        <p className="mr-auto text-[12px] text-muted-foreground">{elementId ? "It's in this character's feed and the Library." : "It's in the Library too."}</p>
        <Button asChild variant="ghost" size="sm">
          <Link href="/library">Open the Library</Link>
        </Button>
        <Button variant="outline" size="sm" onClick={onAgain}>
          Make another
        </Button>
      </div>
    </>
  );
}
