"use client";

import { Dices, ImagePlus, Loader2, RotateCcw, Sparkles, TriangleAlert, Info, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { SaveCharacter } from "@/components/fashion/character-sheet";
import { PageHeader, PageShell } from "@/components/page-shell";
import { useAskFirst } from "@/components/photodump/ask-first";
import { useRun, useRunPreview, type RunPreview } from "@/components/photodump/hooks";
import { ResultsGrid } from "@/components/photodump/results";
import { UploadBox } from "@/components/photodump/upload-box";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { fileToList, type SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAskBeforeUpload, useEngine, useGenerations, useModelAccess } from "@/lib/api";
import { keepOffered, offered } from "@/lib/model-access";
import {
  categoriesFor,
  CREATURE_TYPES,
  describeInfluencer,
  faceOfRun,
  FEATURE,
  HUMAN_TIERS,
  INFLUENCER_START,
  influencerBlocker,
  influencerName,
  MAX_CLOTHING,
  MAX_DIRECTION,
  resetPicks,
  seededRandom,
  setTier,
  shuffleInfluencer,
  summaryRows,
  togglePick,
  toggleLock,
  type InfluencerStart,
  type InfluencerState,
} from "@/lib/influencer";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow, useSwapFade } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { CATEGORY_ICON, LockButton, OptionTiles, pickRule, TierPanel } from "./option-panel";

const STARTS: [InfluencerStart, string][] = [
  ["scratch", "From scratch"],
  ["reference", "From a reference"],
  ["face", "Add your face"],
];

const CLOUD_MODELS: { id: string; label: string; note: string }[] = [
  { id: "fuobe-soul", label: "Fuobe Soul", note: "Drawn in Fuobe Soul's Realistic look. Add a photo or clothing and we dress them in it." },
  { id: "nano-banana-pro", label: "Nano Banana Pro", note: "A wide 2K sheet from your picks, keeps a face and clothing closely" },
  { id: "seedream-5-pro", label: "Seedream 5.0 Pro", note: "Photoreal, from the same picks" },
];

/** The rail is a column from the lg breakpoint up and a sideways scroller below it: its tablist says which. */
const WIDE = "(min-width: 1024px)";
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(WIDE);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

type Message = { kind: "conflict" | "note"; text: string } | null;

/** Arrow keys move along the rail's tabs (and pick), Home / End jump to the ends. */
function tabKeys(e: React.KeyboardEvent<HTMLElement>) {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  e.preventDefault();
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (Math.max(at, 0) + step + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

/** The body priced on the server, settled for a moment so a run of clicks prices once. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function RunInfo({ preview, loading, blocker }: { preview?: RunPreview & { steps?: number }; loading: boolean; blocker: string | null }) {
  if (blocker) return <p className="text-[12.5px] text-destructive">{blocker}</p>;
  if (!preview) return <p className="h-5 text-[12.5px] text-muted-foreground">{loading ? "Pricing…" : ""}</p>;
  if (preview.error) return <p className="text-[12.5px] text-destructive">{preview.error}</p>;
  const cost = preview.demo ? "Placeholder · free" : preview.costUsd === 0 ? "Free · your GPU" : preview.costUsd == null ? "price unknown" : `≈ $${preview.costUsd.toFixed(2)}`;
  return (
    <div className="space-y-0.5 text-[12.5px] text-muted-foreground" aria-live="polite">
      <p>
        Runs on <span className="font-medium text-foreground">{preview.modelName}</span> · 1 character sheet · <span className="font-medium text-foreground tabular-nums">{cost}</span>
      </p>
      {preview.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

/**
 * /influencer: the AI Influencer builder, game-style (after Higgsfield's). Pick a character type (three
 * human tiers, six creature types), then options in 18 categories, or Shuffle; conflicts are refused in
 * Higgsfield's words. A live summary, a Direction, a face or reference photo and up to three
 * clothing references, then one character sheet to save as a character.
 */
export function InfluencerBuilder() {
  const [engine, setEngine] = useEngine();
  // A guest is asked to sign up before choosing photos, and an account with neither its own GPU nor its own key to
  // connect one.
  const askFirst = useAskBeforeUpload();
  // The sheet itself: a guest gets the sign-up card and an account with nothing to run on "Connect your GPU" before it is
  // sent (a press before the page knows who is looking waits for that).
  const askRun = useAskFirst();
  const wide = useWide();
  const [state, setState] = useState<InfluencerState>(INFLUENCER_START);
  const [active, setActive] = useState("tier");
  const [message, setMessage] = useState<Message>(null);
  const [start, setStart] = useState<InfluencerStart>("scratch");
  const [photo, setPhoto] = useState<SlotValue | null>(null);
  const [clothing, setClothing] = useState<SlotValue[]>([]);
  const [direction, setDirection] = useState("");
  const [picked, setModelId] = useState(CLOUD_MODELS[0].id);
  const [ids, setIds] = useState<string[]>([]);
  const clothingInput = useRef<HTMLInputElement>(null);
  // Models switched off in Settings → Models & licences leave the menu, and the pick falls back to one that is on.
  const access = useModelAccess();
  const cloudModels = useMemo(() => keepOffered(CLOUD_MODELS, (m) => offered(access, m.id, "cloud")), [access]);
  const model = cloudModels.find((m) => m.id === picked) ?? cloudModels[0];
  const modelId = model.id;

  const categories = useMemo(() => categoriesFor(state.tier), [state.tier]);
  const category = categories.find((c) => c.id === active);
  const tab = category ? category.id : "tier";
  const panel = useSwapFade<HTMLElement>(tab);
  // The rail scrolls sideways on phones: keep the open category in view (a summary chip can open any).
  const railMoved = useRef(false);
  useEffect(() => {
    if (!railMoved.current) return void (railMoved.current = true);
    document.getElementById(`ib-tab-${tab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const summary = describeInfluencer(state);
  const rows = summaryRows(state);
  const tierLabel = HUMAN_TIERS.find((t) => t.id === state.tier)?.label ?? CREATURE_TYPES.find((c) => c.id === state.tier)?.label ?? "";

  const uploading = !!photo?.uploading || clothing.some((c) => c.uploading);
  const photoRef = start === "scratch" ? undefined : photo?.ref;
  const blocker = influencerBlocker({ state, direction, start, photo: photoRef, clothing: clothing.map((c) => c.ref) });
  const body = useMemo(
    () =>
      uploading
        ? null
        : { engine, state, direction: direction.trim() || undefined, start, photo: photoRef, clothing: clothing.map((c) => c.ref), modelId: engine === "cloud" ? modelId : undefined },
    [uploading, engine, state, direction, start, photoRef, clothing, modelId],
  );
  const settled = useSettled(body);
  const preview = useRunPreview("/api/influencer", blocker ? null : settled);
  const run = useRun<NonNullable<typeof body>>("/api/influencer");

  const { data } = useGenerations({ features: [FEATURE], limit: 30 });
  // This visit's sheets; after a reload, the most recent ones.
  const mine = useMemo(() => (ids.length ? (data ?? []).filter((g) => ids.includes(g.id)) : (data ?? []).slice(0, 2)), [data, ids]);
  const latest = mine.find((g) => g.status === "succeeded");

  const pick = (cat: string, id: string) => {
    const r = togglePick(state, cat, id);
    setState(r.state);
    setMessage(r.conflict ? { kind: "conflict", text: r.conflict } : r.note ? { kind: "note", text: r.note } : null);
  };
  const changeTier = (tier: InfluencerState["tier"]) => {
    const r = setTier(state, tier);
    setState(r.state);
    setMessage(r.dropped.length ? { kind: "note", text: `Not in ${HUMAN_TIERS.find((t) => t.id === tier)?.label ?? CREATURE_TYPES.find((c) => c.id === tier)?.label}: ${r.dropped.join(", ")} — removed` } : null);
  };
  const shuffle = () => {
    setState((s) => shuffleInfluencer(s, seededRandom(Math.floor(Math.random() * 2 ** 31)), { reference: start !== "scratch" && !!photo }));
    setMessage(null);
  };
  const addClothing = (files: Iterable<File>) => {
    if (askFirst()) return;
    const list = [...files].filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
    if (clothing.length + list.length > MAX_CLOTHING) toast("You can add up to three clothing references");
    list.slice(0, MAX_CLOTHING - clothing.length).forEach((f) => fileToList(f, setClothing, "image"));
  };
  const create = () =>
    askRun(() => {
      if (blocker) return toast(blocker);
      if (!body) return toast("Wait for the uploads to finish");
      run.mutate(body, {
        onSuccess: (r) => setIds((xs) => [...r.items.map((g) => g.id), ...xs]),
        onError: (e) => toastError(e, "Couldn't start the sheet"),
      });
    }, "run");

  return (
    <PageShell wide>
      <PageHeader title="AI Influencer" description="Build an original character like in a game: pick a type, style it or hit Shuffle, then save the sheet.">
        <EngineSwitch value={engine} onChange={setEngine} />
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[212px_minmax(0,1fr)] xl:grid-cols-[212px_minmax(0,1fr)_340px]">
        {/* The rail: Character type, then the categories this type shows. Phones scroll it sideways inside itself. */}
        <TabRow
          role="tablist"
          aria-label="Categories"
          aria-orientation={wide ? "vertical" : "horizontal"}
          onKeyDown={tabKeys}
          follow
          className="max-lg:-mx-4 max-lg:px-4 lg:flex-col lg:items-stretch lg:overflow-visible"
        >
          {[{ id: "tier", label: "Character type" }, ...categories].map((c) => {
            const Icon = CATEGORY_ICON[c.id];
            const on = tab === c.id;
            const count = c.id === "tier" ? 0 : (state.picks[c.id]?.length ?? 0);
            return (
              <button
                key={c.id}
                id={`ib-tab-${c.id}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls="ib-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(c.id)}
                className={cn(TAB_PILL, "lg:justify-start")}
                {...onAttr(on)}
              >
                {Icon && <Icon aria-hidden />}
                <span className="lg:min-w-0 lg:flex-1 lg:truncate lg:text-left">{c.label}</span>
                {c.id === "tier" ? (
                  <span className="text-[11.5px] text-muted-foreground">{tierLabel}</span>
                ) : count ? (
                  <span className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-primary px-1 text-[11px] text-primary-foreground tabular-nums" aria-label={`${count} picked`}>
                    {count}
                  </span>
                ) : null}
                {state.locked.includes(c.id) && <span className="sr-only">(kept on Shuffle)</span>}
              </button>
            );
          })}
        </TabRow>

        <section ref={panel} id="ib-panel" role="tabpanel" aria-labelledby={`ib-tab-${tab}`} className="min-w-0 space-y-4 rounded-2xl border bg-background p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <h2 className="font-heading text-[22px] leading-tight">{category?.label ?? "Character type"}</h2>
              <p className="text-[12.5px] text-muted-foreground">{category ? pickRule(category) : "Human tiers or a creature, then everything else"}</p>
            </div>
            {category && <LockButton locked={state.locked.includes(category.id)} label={category.label} onToggle={() => setState((s) => toggleLock(s, category.id))} />}
            <Button variant="outline" size="sm" onClick={shuffle}>
              <Dices /> Shuffle
            </Button>
            <Button variant="ghost" size="sm" onClick={() => (setState(resetPicks), setMessage(null))}>
              <RotateCcw /> Reset all
            </Button>
          </div>
          <div aria-live="polite">
            {message && (
              <p className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]", message.kind === "conflict" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                {message.kind === "conflict" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
                {message.text}
              </p>
            )}
          </div>
          {category ? (
            <OptionTiles category={category} state={state} onPick={(id) => pick(category.id, id)} />
          ) : (
            <TierPanel
              state={state}
              onTier={changeTier}
              onSpecies={(species) => setState((s) => ({ ...s, species }))}
              onBodyColor={(bodyColor) => setState((s) => ({ ...s, bodyColor }))}
            />
          )}
        </section>

        <aside aria-label="Your character" className="min-w-0 space-y-4 lg:col-span-2 xl:col-span-1">
          <div className="space-y-3 rounded-2xl border bg-background p-4">
            <h2 className="text-[13px] font-medium">Your character</h2>
            <p className="font-heading text-[18px] leading-snug" aria-live="polite">
              {summary}
            </p>
            {rows.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Your picks">
                {rows.map((r) => (
                  <li key={r.category}>
                    <button type="button" onClick={() => setActive(r.category)} className="max-w-full rounded-full bg-muted px-2.5 py-1 text-left text-[12px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      {r.label}: <span className="font-medium text-foreground">{r.options}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 rounded-2xl border bg-background p-4">
            <div role="radiogroup" aria-label="How to start" onKeyDown={radioKeys} className="grid grid-cols-3 rounded-2xl bg-muted p-0.5">
              {STARTS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={start === id}
                  tabIndex={radioTab(start === id)}
                  onClick={() => setStart(id)}
                  className={cn("min-h-8 rounded-[14px] px-1.5 py-1 text-[12.5px] leading-tight font-medium text-muted-foreground transition outline-none focus-visible:ring-2 focus-visible:ring-ring", start === id && "bg-background text-foreground shadow-soft")}
                >
                  {label}
                </button>
              ))}
            </div>
            {start !== "scratch" && (
              <div className="space-y-1.5">
                <UploadBox
                  value={photo}
                  onChange={setPhoto}
                  title={start === "face" ? "Your photo" : "Reference image"}
                  hint={start === "face" ? "A clear, front-facing photo of your face" : "A character whose look to start from"}
                  className="h-44"
                />
                <p className="text-[12px] text-muted-foreground">
                  {start === "face" ? "Your face goes on the character you build." : "The character starts from this look; your picks change it."} Shuffle keeps the gender, ethnicity and age{state.tier === "normal" ? ", skin and eye colour" : ""} the photo decides.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-[13px] font-medium">
                Clothing references <span className="font-normal text-muted-foreground">· up to {MAX_CLOTHING}</span>
              </p>
              <div className="grid grid-cols-4 gap-2">
                {clothing.map((c, i) => (
                  <div key={c.id ?? i} className="relative aspect-square overflow-hidden rounded-lg bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.preview} alt={`Clothing reference ${i + 1}`} className="size-full object-cover" />
                    {c.uploading && (
                      <span className="absolute inset-0 grid place-items-center bg-background/60" role="status" aria-label="Uploading">
                        <Loader2 className="size-4 animate-spin" />
                      </span>
                    )}
                    <button type="button" aria-label={`Remove clothing reference ${i + 1}`} onClick={() => setClothing((xs) => xs.filter((x) => x !== c))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background">
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                {clothing.length < MAX_CLOTHING && (
                  <button
                    type="button"
                    onClick={() => askFirst() || clothingInput.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => (e.preventDefault(), addClothing(e.dataTransfer.files))}
                    className="grid aspect-square place-items-center rounded-lg border border-dashed text-muted-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    aria-label="Add clothing references"
                  >
                    <ImagePlus className="size-5" />
                  </button>
                )}
                <input ref={clothingInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => (addClothing(e.target.files ?? []), (e.target.value = ""))} />
              </div>
            </div>
            <label className="block space-y-1.5">
              <span className="flex items-baseline justify-between gap-2 text-[13px] font-medium">
                Direction
                <span className={cn("text-[11.5px] font-normal text-muted-foreground tabular-nums", direction.length > MAX_DIRECTION && "text-destructive")}>
                  {direction.length.toLocaleString("en-US")} / {MAX_DIRECTION.toLocaleString("en-US")}
                </span>
              </span>
              <Textarea value={direction} onChange={(e) => setDirection(e.target.value)} rows={3} placeholder="Who are they? e.g. “a ceramicist from Porto who posts studio vlogs”" />
            </label>
          </div>

          <div className="space-y-3 rounded-2xl border bg-background p-4">
            {engine === "cloud" ? (
              <div className="space-y-1.5">
                <label htmlFor="ib-model" className="text-[13px] font-medium">
                  Model
                </label>
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger id="ib-model" className="w-full" aria-describedby="ib-model-note">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cloudModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="ib-model-note" className="text-[12px] leading-snug text-muted-foreground">
                  {model.note}
                </p>
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                Fuobe Soul on your GPU: drawn in its Realistic look. Add a photo or clothing and we dress them in it. <span className="font-medium text-foreground">Free</span> on your GPU.
              </p>
            )}
            <RunInfo preview={blocker ? undefined : (settled ? preview.data : undefined)} loading={preview.isFetching} blocker={blocker} />
            <Button className="w-full" onClick={create} disabled={run.isPending || uploading}>
              {run.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} {run.isPending ? "Starting…" : "Generate character sheet"}
            </Button>
          </div>
        </aside>
      </div>

      <section className="mt-8 space-y-3" aria-labelledby="ib-sheets">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ib-sheets" className="font-heading text-[22px]">
            {ids.length ? "Your sheets" : "Recent sheets"}
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            Also in <Link href="/character-sheet" className="text-brand-text underline underline-offset-2">Character Sheet</Link> from your own photos
          </p>
        </div>
        {mine.length ? (
          <>
            <ResultsGrid
              items={mine}
              ratio={2}
              className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-2"
              onRetried={(from, to) => setIds((xs) => (xs.length ? xs.flatMap((id) => (id === from ? to : [id])) : xs))}
            />
            {/* The face and the name come from the run that made the sheet, not from what the page shows now. */}
            {latest && <SaveCharacter key={latest.id} item={latest} extra={[faceOfRun(latest.request)].filter((x): x is string => !!x)} defaultName={latest.request.title ?? influencerName(state)} />}
          </>
        ) : (
          <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed p-6 text-center">
            <div className="max-w-md space-y-1">
              <p className="font-heading text-[20px]">Your character sheet appears here</p>
              <p className="text-[13px] text-muted-foreground">A portrait and full-body views of the same character on white — then save it as a character to use in any prompt with @.</p>
            </div>
          </div>
        )}
      </section>
    </PageShell>
  );
}
