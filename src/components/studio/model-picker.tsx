"use client";

import { ChevronDown, Cloud, Cpu, SearchX, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { KEY_ADDED_EVENT, openAddKey } from "@/components/keys/your-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { RowDot } from "@/components/gpu/readiness-chip";
import { badgeFor, useGpuBadges } from "@/hooks/use-gpu";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToday } from "@/hooks/use-today";
import type { Badge as BadgeT } from "@/lib/gpu/types";
import { type Engine, type ModelDef, type Operation } from "@/lib/catalog/types";
import { askToSignUp, useEngineMode, useStatus } from "@/lib/api";
import { groupModels, studioBest, toggleIn } from "@/lib/composer";
import { readsBoxes } from "@/lib/layout-prompt";
import { pickerPrice } from "@/lib/model-rows";
import { cn } from "@/lib/utils";
import { ownSetupLabel } from "@/lib/own-setup";
import { addKeyLabel, billedTo, CLOUD_KEY, CLOUD_PROVIDERS, needsKey, type CloudProvider } from "@/lib/your-keys";
import { EngineSwitch } from "./engine-switch";
import { ResponsivePanel } from "./responsive-panel";
import { RECENT_MODELS, STARRED_MODELS, useStoredList } from "./stored-list";
import { VendorMark } from "./vendor-mark";
import { placeholdersOn } from "@/lib/demo-mode";
import { plainTagline } from "@/lib/plain-tagline";

const BADGE_LABEL: Record<string, string> = {
  new: "New",
  top: "Top",
  fast: "Fast",
  audio: "Audio",
  "4k": "4K",
  hd: "1080p",
  pro: "Pro",
  open: "Open",
  uncensored: "Uncensored",
  beta: "Beta",
  "30s": "30 s",
};

export function ModelBadges({ model, max }: { model: ModelDef; max?: number }) {
  const badges = (model.badges ?? []).filter((b) => b !== "open").slice(0, max);
  if (!badges.length) return null;
  return (
    <span className="flex shrink-0 flex-wrap gap-1">
      {badges.map((b) => (
        <Badge
          key={b}
          variant="secondary"
          className={cn(
            "h-4 rounded-[4px] px-1 text-[10px] font-medium",
            b === "new" && "bg-highlight text-highlight-foreground",
            b === "top" && "bg-brand-faint text-brand-text",
          )}
        >
          {BADGE_LABEL[b]}
        </Badge>
      ))}
    </span>
  );
}

const STAR_KEY_HINT = "Alt+S";

/**
 * Alt+S (or ⌥S) stars or unstars the highlighted model, so starring works from the keyboard
 * while focus stays in the search field. Rows are cmdk items valued "<group>:<model id>".
 */
function starKey(e: React.KeyboardEvent<HTMLElement>, toggle: (id: string) => void) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== "KeyS") return;
  const value = e.currentTarget.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-value");
  const id = value?.slice(value.indexOf(":") + 1);
  if (!id) return;
  e.preventDefault();
  toggle(id);
}

function ModelRow({
  m,
  selected,
  starred,
  showEngine,
  boxes,
  today,
  onStar,
  gpu,
  gpuName,
  needs,
  made,
  edits,
  guest,
}: {
  m: ModelDef;
  selected: boolean;
  starred: boolean;
  showEngine: boolean;
  /** Layout mode: a "Reads boxes" badge on the models that place boxes by their coordinates. */
  boxes?: boolean;
  /** The browser's day: a launch price holds through its last day (null until hydrated: no price shown for one). */
  today: number | null;
  onStar: () => void;
  /** Its state on the viewer's GPU (the GPU pre-flight). */
  gpu?: BadgeT | null;
  gpuName?: string;
  /** An account's paid model it has no key for yet: dimmed, "Add your fal.ai key" in place of the price. */
  needs?: CloudProvider[] | null;
  /** A guest: the same row says "Use your own fal.ai key" (choosing it offers a free account first). */
  guest?: boolean;
  /** The active preset's live preview was made with this model. */
  made?: boolean;
  /** The studio edits clips (Edit video): the price is an edit's, on the seconds in and out (Kling 4.0). */
  edits?: boolean;
}) {
  return (
    <>
      <VendorMark vendor={m.vendor} engine={m.engine} />
      <span className={cn("min-w-0 flex-1", needs && "opacity-60")}>
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate text-[13px] font-medium", selected && "text-brand-text")}>
            {m.name}
            {starred && <span className="sr-only">, starred</span>}
          </span>
          {/* A dimmed row on a phone: the name first (its badges would cut it to "Na…"). */}
          {boxes && readsBoxes(m) ? (
            <Badge variant="secondary" className="h-4 shrink-0 rounded-[4px] bg-brand-faint px-1 text-[10px] font-medium text-brand-text">
              Reads boxes
            </Badge>
          ) : needs ? (
            <span className="contents max-sm:hidden">
              <ModelBadges model={m} max={2} />
            </span>
          ) : (
            <ModelBadges model={m} max={2} />
          )}
          {gpu && <RowDot badge={gpu} gpu={gpuName} />}
          {showEngine && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground">
              {m.engine === "open" ? <Cpu className="size-2.5!" /> : <Cloud className="size-2.5!" />}
              {m.engine === "open" ? "Open source" : "Cloud"}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] leading-snug text-muted-foreground">
          {m.vendor} · {plainTagline(m.tagline)}
        </span>
        {made && (
          <span className="mt-0.5 flex items-center gap-1 text-[11px] leading-snug font-medium text-brand-text">
            <Sparkles className="size-3! shrink-0" aria-hidden />
            Used for this preview
          </span>
        )}
      </span>
      {needs ? (
        // On a phone the short words, so the model's name keeps its room.
        <span className="shrink-0 text-right text-[11px] font-medium text-brand-text">
          <span className="sm:hidden">{guest ? "Your key" : "Add key"}</span>
          <span className="max-sm:hidden">{guest ? ownSetupLabel({ need: "key", provider: needs[0] }) : addKeyLabel(needs[0])}</span>
        </span>
      ) : (
        <span className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{pickerPrice(m, today, edits)}</span>
      )}
      {/* Pointer only: inside an option it would be a nested control. Keyboard: Alt+S on the highlighted row (starKey). */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        title={starred ? `Unstar (${STAR_KEY_HINT})` : `Star (${STAR_KEY_HINT})`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full text-subtle-foreground transition hover:bg-accent hover:text-foreground focus-visible:opacity-100",
          starred ? "text-highlight-foreground" : "opacity-100 sm:opacity-0 sm:group-hover/command-item:opacity-100 sm:group-data-selected/command-item:opacity-100",
        )}
      >
        <Star className={cn("size-3.5!", starred && "fill-highlight text-highlight-foreground")} />
      </button>
    </>
  );
}

interface PickerProps {
  models: ModelDef[];
  value: ModelDef | undefined;
  onChange: (m: ModelDef) => void;
  engine: Engine;
  onEngineChange: (e: Engine) => void;
  defaultModels?: { cloud: string; open: string };
  /** Layout mode: the models that read boxes come first, badged. */
  boxes?: boolean;
  /** The operations the studio offers, its main one first: "Best for this studio" ranks the models that do it. */
  ops?: Operation[];
  /** The model the active preset's preview was made with (its recipe): first in "Best for this studio". */
  recipe?: string;
  /** A short list in its own order (an app's models): one group, no Recent, Starred or Best. */
  flat?: boolean;
  /** The model the active preset's live preview really came from: "Used for this preview" on its row. */
  madeWith?: string;
}

/**
 * Model picker on cmdk: Recent, Starred and "Best for this studio" above the full list for the
 * current engine; typing searches both engines at once (each row says which). A popover on
 * desktop, a bottom sheet on phones. The list is built only while the panel is open (a canvas
 * board shows dozens of closed pickers).
 */
/**
 * A model's name on a phone's narrow button: Qwen-Image's family name shortened ("Qwen 2.1 Turbo"), so the word that
 * tells two models apart (Turbo) stays in view. The full name is the button's label.
 */
export function phoneName(name: string): string {
  return name.replace(/^Qwen-Image(-Edit)? /, (_, edit?: string) => (edit ? "Qwen Edit " : "Qwen "));
}

export function ModelPicker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  const { value, models, onChange } = props;
  const made = !!value && value.id === props.madeWith;
  // The model a dimmed row was chosen for (by this picker only): picked once its key is saved and the studio knows it
  // (the status has the key, so the engine switch is on Cloud and nothing swaps the model back to an open one).
  const waiting = useRef<string | null>(null);
  const saved = useRef<string | null>(null);
  useEffect(() => {
    const added = (e: Event) => {
      const id = (e as CustomEvent<{ modelId?: string }>).detail?.modelId;
      if (id && id === waiting.current) saved.current = id;
      waiting.current = null;
    };
    window.addEventListener(KEY_ADDED_EVENT, added);
    return () => window.removeEventListener(KEY_ADDED_EVENT, added);
  }, []);
  // (Saving a key refreshes the status, which runs this again.)
  const status = useStatus().data;
  const mode = useEngineMode();
  useEffect(() => {
    const m = saved.current ? models.find((x) => x.id === saved.current && !needsKey(x, status) && (x.engine === "open" || mode !== "open")) : undefined;
    if (!m) return;
    saved.current = null;
    onChange(m);
  }, [models, status, mode, onChange]);
  return (
    <ResponsivePanel
      open={open}
      onOpenChange={setOpen}
      title="Choose a model"
      className="w-[min(92vw,440px)] p-0 shadow-strong"
      sheetClassName="h-[80svh]"
      trigger={
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-[13px] font-medium"
          aria-label={`Model: ${value?.name ?? "none"}${made ? ", used for this preview" : ""}. Change model`}
          title={made ? "Used for this preview" : undefined}
        >
          {value?.engine === "open" ? <Cpu className="size-3.5" /> : <Cloud className="size-3.5" />}
          <span className="max-w-40 truncate max-sm:hidden sm:max-w-44">{value?.name ?? "Choose model"}</span>
          <span className="max-w-40 truncate sm:hidden">{value ? phoneName(value.name) : "Choose model"}</span>
          {made && <Sparkles className="size-3.5 text-brand-text" aria-hidden />}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      }
    >
      <PickerList
        {...props}
        onPicked={() => setOpen(false)}
        onNeedsKey={(m, p) => {
          waiting.current = m.id;
          setOpen(false);
          openAddKey(p, m.id);
        }}
      />
    </ResponsivePanel>
  );
}

/** The searchable list (mounted by the popover / sheet only while it shows). */
function PickerList({
  models,
  value,
  onChange,
  engine,
  onEngineChange,
  defaultModels,
  boxes,
  ops,
  recipe,
  flat,
  madeWith,
  onPicked,
  onNeedsKey,
}: PickerProps & { onPicked: () => void; onNeedsKey?: (m: ModelDef, p: CloudProvider) => void }) {
  const [q, setQ] = useState("");
  const status = useStatus().data;
  const badges = useGpuBadges().data;
  const mode = useEngineMode();
  const mobile = useIsMobile();
  const [recent] = useStoredList(RECENT_MODELS);
  const [starred, setStarred] = useStoredList(STARRED_MODELS);
  const today = useToday();
  // A studio for clip edits (Edit video: its first operation edits a clip) prices models as an edit bills.
  const editsClips = ops?.[0] === "v2v" || ops?.[0] === "video-swap" || ops?.[0] === "video-insert";
  const engines = useMemo<Engine[]>(() => (mode === "both" ? ["cloud", "open"] : [mode]), [mode]);
  // "Best" ranks models that do what the studio is for, not single-purpose tools.
  // A preset's recipe leads, when it runs on this engine.
  const best = useMemo(() => {
    const ranked = studioBest(models, engine, defaultModels?.[engine], ops);
    return recipe && models.some((m) => m.id === recipe && m.engine === engine) ? [recipe, ...ranked.filter((id) => id !== recipe)] : ranked;
  }, [models, engine, defaultModels, ops, recipe]);
  const { groups, count } = useMemo(
    () => groupModels({ models, engine, engines, query: q, recent, starred, best, flat, boxes }),
    [models, engine, engines, q, recent, starred, best, flat, boxes],
  );
  const demo = placeholdersOn(status?.demoMode);
  const otherEngine = engine === "cloud" ? "open" : "cloud";
  const noneForEngine = !q && !models.some((m) => m.engine === engine);

  // An account (public sign-up): paid models it has no key for are dimmed; choosing one asks for the key first.
  const viewer = status?.viewer?.kind === "account" ? status.viewer : null;
  const keys = viewer ? (viewer.keys ?? []) : null;
  const payer = keys?.length && engine === "cloud" ? keys : null;
  // A guest sees them as an account without a key does; choosing one offers a free account first.
  const guest = status?.viewer?.kind === "guest" && status.viewer.paidAllowed !== false;
  // With no key yet it is on open models only: the paid models follow, dimmed (a search lists the ones it matches), so
  // every model shows, with the way to run it.
  const keyless = (!!viewer && !keys?.length && viewer.paidAllowed !== false) || guest;
  const paid = useMemo(
    () => (keyless && !engines.includes("cloud") ? (groupModels({ models, engine: "cloud", engines: ["cloud"], query: q, recent: [], starred: [], best: [] }).groups[0]?.models ?? []) : []),
    [keyless, q, engines, models],
  );
  const listed = paid.length ? [...groups, { id: "paid" as const, label: "Paid models · with your own key", models: paid }] : groups;
  // The key a paid row needs: an account's (needsKey), or for a guest the providers that serve it.
  const rowNeeds = (m: ModelDef): CloudProvider[] | null => {
    if (!guest) return needsKey(m, status);
    if (m.engine === "open") return null;
    const served = CLOUD_PROVIDERS.filter((p) => m.routes.some((r) => r.provider === p));
    return served.length ? served : null;
  };
  const pick = (m: ModelDef) => {
    if (guest && rowNeeds(m)) {
      onPicked();
      return askToSignUp("run");
    }
    const needs = needsKey(m, status);
    if (needs && onNeedsKey) return onNeedsKey(m, needs[0]);
    onChange(m);
    onPicked();
  };
  const addKey = () => {
    onPicked();
    openAddKey("fal");
  };

  return (
    <Command shouldFilter={false} loop label="Models" onKeyDown={(e) => starKey(e, (id) => setStarred((s) => toggleIn(s, id)))} className="rounded-none! bg-transparent p-0">
      <div className="flex items-center gap-2 p-1 sm:p-2 sm:pb-1">
        <div className="min-w-0 flex-1 [&_[data-slot=command-input-wrapper]]:p-0">
          <CommandInput value={q} onValueChange={setQ} placeholder={mobile ? "Search" : mode === "both" ? "Search all models" : "Search models"} aria-label="Search models" autoFocus={!mobile} />
        </div>
        <EngineSwitch value={engine} onChange={onEngineChange} size="sm" />
      </div>
      <div className="flex items-baseline gap-x-2 px-3 pb-1.5 leading-snug text-[11px] text-muted-foreground sm:px-3.5">
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {q ? `${count + paid.length} result${count + paid.length === 1 ? "" : "s"}` : `${count} ${engine === "open" ? "open-source" : "cloud"} model${count === 1 ? "" : "s"}`}
        </span>
        {payer ? (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0">
              {`Paid models are billed to ${payer.length > 1 ? "your fal.ai and Replicate accounts" : billedTo(payer[0])} · `}
              <Link href="/settings#your-keys" className="text-brand-text underline underline-offset-2">
                Your keys
              </Link>
            </span>
          </>
        ) : (
          keyless && (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0">
                Paid models like Nano Banana and Kling need your own fal.ai or Replicate key ·{" "}
                {guest ? (
                  <button
                    type="button"
                    onClick={() => {
                      onPicked();
                      askToSignUp("run");
                    }}
                    className="text-brand-text underline underline-offset-2"
                  >
                    Create a free account
                  </button>
                ) : (
                  <button type="button" onClick={addKey} className="text-brand-text underline underline-offset-2">
                    Add a key
                  </button>
                )}
              </span>
            </>
          )
        )}
        {demo && !keys && (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0">
              Placeholder results are on, so outputs are stand-ins.{" "}
              <Link href="/settings#demo" className="text-brand-text underline underline-offset-2">
                Settings
              </Link>
            </span>
          </>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap max-sm:hidden">
          <kbd className="font-sans">{STAR_KEY_HINT}</kbd> to star
        </span>
      </div>
      <CommandList className="max-h-[min(52vh,420px)] border-t sm:max-h-[min(56vh,440px)]">
        {listed.map((g) => (
          <CommandGroup key={g.id} heading={g.label}>
            {g.models.map((m) => (
              <CommandItem
                key={`${g.id}:${m.id}`}
                value={`${g.id}:${m.id}`}
                onSelect={() => pick(m)}
                data-checked={value?.id === m.id}
                aria-label={rowNeeds(m) ? `${m.name} needs your ${CLOUD_KEY[rowNeeds(m)![0]].label} key` : undefined}
                className={cn("gap-2.5 rounded-lg px-2 py-1.5 [&>svg:last-child]:hidden", value?.id === m.id && "bg-brand-faint data-selected:bg-brand-faint-hover")}
              >
                <ModelRow
                  m={m}
                  selected={value?.id === m.id}
                  starred={starred.includes(m.id)}
                  showEngine={g.id !== "paid" && (!!q || m.engine !== engine)}
                  boxes={boxes}
                  today={today}
                  onStar={() => setStarred((s) => toggleIn(s, m.id))}
                  gpu={m.engine === "open" ? badgeFor(badges, { modelId: m.id }) : null}
                  gpuName={badges?.gpu}
                  needs={rowNeeds(m)}
                  guest={guest}
                  made={m.id === madeWith}
                  edits={editsClips}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {!listed.length && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <SearchX className="size-5 text-subtle-foreground" />
            {noneForEngine ? (
              <>
                <p className="text-[13px] text-muted-foreground">No {engine === "open" ? "open-source" : "cloud"} models for this yet.</p>
                {engines.includes(otherEngine) && (
                  <Button variant="secondary" size="sm" onClick={() => onEngineChange(otherEngine)}>
                    Show {otherEngine === "open" ? "open-source" : "cloud"} models
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-[13px] text-muted-foreground">No models match “{q}”</p>
                <Button variant="secondary" size="sm" onClick={() => setQ("")}>
                  Clear search
                </Button>
              </>
            )}
          </div>
        )}
      </CommandList>
    </Command>
  );
}
