"use client";

import { AtSign, Check, Dices, ImagePlus, Loader2, RotateCcw, Shuffle, Sparkles, UserRoundPlus, X } from "lucide-react";
import Link from "next/link";
import { nanoid } from "nanoid";
import { Suspense, useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PageHeader, PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { fileToList, type SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useAskFirst } from "@/components/photodump/ask-first";
import { usePhotoCharacters, useRun, useRunPreview, useSaveCharacter } from "@/components/photodump/hooks";
import { ResultsGrid } from "@/components/photodump/results";
import { RunLine } from "@/components/photodump/steps";
import { AnimatePosesButton } from "@/components/turnaround/animate-poses";
import { TurnaroundButton } from "@/components/turnaround/turnaround-dialog";
import { HandoffImage } from "@/components/nav/next-steps";
import { useAskBeforeUpload, useEngine, useGenerations } from "@/lib/api";
import { castFieldVisible, castNameFor, randomCast, SHEET_MAX_REFS, type CastAnswers, type CastFieldData } from "@/lib/catalog/packs";
import { sheetPictures } from "@/lib/catalog/turnaround";
import type { Generation } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { SheetExample } from "@/components/empty-examples";
import { linkTab, TabFromLink } from "@/components/nav/tab-from-link";

type Mode = "reference" | "cast" | "describe";
const MODES: [Mode, string][] = [
  ["reference", "From Reference"],
  ["cast", "Build from scratch"],
  ["describe", "From a description"],
];
/** The tabs a link can open (?mode=reference|cast|describe: the bar's menus, search). */
const MODE_IDS: readonly Mode[] = MODES.map(([id]) => id);

const fmt = (f: CastFieldData, v: string | number) => (f.format ? f.format.replace("{v}", String(v)) : String(v));

function CastForm({ fields, values, set }: { fields: CastFieldData[]; values: CastAnswers; set: (patch: CastAnswers) => void }) {
  const tabs = useMemo(() => [...new Set(fields.map((f) => f.tab))], [fields]);
  const [tab, setTab] = useState(tabs[0]);
  return (
    <div className="space-y-4">
      <TabRow role="tablist" aria-label="Soul Cast" follow>
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={TAB_PILL} {...onAttr(tab === t)}>
            {t}
          </button>
        ))}
      </TabRow>
      {fields
        .filter((f) => f.tab === tab && castFieldVisible(f.key, values))
        .map((f) => {
          const v = values[f.key];
          const multi = f.kind === "multi";
          const chosen = (o: string | number) => (multi ? Array.isArray(v) && v.includes(String(o)) : v === o);
          return (
            <div key={f.key} className="space-y-2">
              <p className="text-[13px] font-medium">{f.question ?? f.label}</p>
              <div role={multi ? "group" : "radiogroup"} aria-label={f.label} onKeyDown={multi ? undefined : radioKeys} className="flex flex-wrap gap-1.5">
                {f.options.map((o) => {
                  const sel = chosen(o);
                  return (
                    <button
                      key={String(o)}
                      type="button"
                      role={multi ? undefined : "radio"}
                      aria-checked={multi ? undefined : sel}
                      aria-pressed={multi ? sel : undefined}
                      tabIndex={multi ? undefined : radioTab(sel || (v === undefined && o === f.options[0]))}
                      onClick={() => {
                        if (multi) {
                          const cur = Array.isArray(v) ? v : [];
                          set({ [f.key]: sel ? cur.filter((x) => x !== String(o)) : [...cur, String(o)] });
                        } else set({ [f.key]: sel && f.default === undefined ? undefined : o });
                      }}
                      className={cn("h-8 rounded-full border px-3 text-[12.5px] font-medium transition-colors", sel ? "border-primary bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent")}
                    >
                      {fmt(f, o)}
                    </button>
                  );
                })}
              </div>
              {f.manual && (
                <Input
                  value={String(values[`${f.key}_text`] ?? "")}
                  onChange={(e) => set({ [`${f.key}_text`]: e.target.value.slice(0, 300) })}
                  placeholder={`Or describe the ${f.label.toLowerCase()}`}
                  aria-label={`Describe the ${f.label.toLowerCase()}`}
                  className="h-8 max-w-md"
                />
              )}
            </div>
          );
        })}
    </div>
  );
}

/**
 * Save a finished sheet as a character (its sheet, views and the source photos as references), once:
 * a sheet that is already a character (its image is one of the character's references) shows that
 * character instead, also after a reload.
 */
export function SaveCharacter({ item, extra, defaultName }: { item: Generation; extra: string[]; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  // The owner's character is an element (@mentions, its page); an account's is its own, picked by name in Photodump
  // and Fashion Factory.
  const save = useSaveCharacter();
  const elements = usePhotoCharacters();
  const refs = [...item.outputs.filter((o) => o.kind === "image").map((o) => o.url), ...extra].slice(0, 20);
  const saved = save.data ?? elements.data?.find((e) => e.kind === "character" && !!refs[0] && e.references.includes(refs[0]));
  if (saved && !save.owner)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-background p-3">
        <span className="grid size-7 place-items-center rounded-full bg-success/15 text-success">
          <Check className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-[13px]">
          Saved as <span className="font-medium">{saved.name}</span> — pick it under My character in <Link href="/photodump" className="text-brand-text underline underline-offset-2">Photodump</Link> or{" "}
          <Link href="/fashion-factory" className="text-brand-text underline underline-offset-2">Fashion Factory</Link>.
        </p>
      </div>
    );
  if (saved)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-background p-3">
        <span className="grid size-7 place-items-center rounded-full bg-success/15 text-success">
          <Check className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-[13px]">
          Saved as <span className="font-medium">@{saved.handle}</span> — use it anywhere with <AtSign className="inline size-3" />
          mentions, in <Link href="/photodump" className="text-brand-text underline underline-offset-2">Photodump</Link> or <Link href="/fashion-factory" className="text-brand-text underline underline-offset-2">Fashion Factory</Link>.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/elements/${saved.id}`}>Open @{saved.handle}</Link>
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-2xl border bg-background p-3">
      <label className="min-w-40 flex-1 space-y-1">
        <span className="text-[12px] text-muted-foreground">Character name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-8" />
      </label>
      <Button
        disabled={!name.trim() || save.isPending || elements.isLoading}
        onClick={() =>
          save.save(
            { name: name.trim(), references: refs },
            {
              // The card turns into "Saved as @handle · Open": no toast needed.
              onError: (e) => toastError(e),
            },
          )
        }
      >
        {save.isPending ? <Loader2 className="animate-spin" /> : <UserRoundPlus />} Save as character
      </Button>
      <p className="w-full text-[12px] text-muted-foreground">
        Use it anywhere with <AtSign className="inline size-3" />
        mentions, in <Link href="/photodump" className="text-brand-text underline underline-offset-2">Photodump</Link> or <Link href="/fashion-factory" className="text-brand-text underline underline-offset-2">Fashion Factory</Link> — or train its Soul ID from its page.
      </p>
    </div>
  );
}

/**
 * /character-sheet ("Build your AI avatar"): a consistent character as a turnaround sheet — from 1–5
 * reference photos, from a Soul Cast build, or from a description (the AI Influencer app) — saved as
 * a character element.
 */
type TurnaroundProps = ComponentProps<typeof TurnaroundButton>;

/** ?stills=1 (the GPU pre-flight board's "Turnaround stills · 8 views"): the dialog starts on the 8-view still set. */
function TurnaroundFromLink(props: TurnaroundProps) {
  const stills = useSearchParams().get("stills") === "1";
  return <TurnaroundButton {...props} {...(stills && { route: "stills" as const })} />;
}

function SheetTurnaround(props: TurnaroundProps) {
  return (
    <Suspense fallback={<TurnaroundButton {...props} />}>
      <TurnaroundFromLink {...props} />
    </Suspense>
  );
}

export function CharacterSheetView({ fields, defaults }: { fields: CastFieldData[]; defaults: CastAnswers }) {
  const [engine, setEngine] = useEngine();
  // A guest is asked to sign up before choosing photos, and an account with neither its own GPU nor its own key to
  // connect one.
  const askFirst = useAskBeforeUpload();
  // The sheet itself: a guest gets the sign-up card and an account with nothing to run on "Connect your GPU" before it is
  // sent (a press before the page knows who is looking waits for that).
  const askRun = useAskFirst();
  const [mode, setMode] = useState<Mode>("reference");
  const [photos, setPhotos] = useState<SlotValue[]>([]);
  const [details, setDetails] = useState("");
  const [cast, setCast] = useState<CastAnswers>(defaults);
  const [brief, setBrief] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = useRun<Record<string, unknown>>("/api/photodump/character");
  const { data } = useGenerations({ features: ["character-sheet", "app:app-ai-influencer"], limit: 60 });
  // This visit's sheets; after a reload, the most recent ones.
  const mine = useMemo(() => (ids.length ? (data ?? []).filter((g) => ids.includes(g.id)) : (data ?? []).slice(0, 2)), [data, ids]);
  const latest = mine.find((g) => g.status === "succeeded");

  const uploading = photos.some((p) => p.uploading);
  const body =
    mode === "reference"
      ? photos.length && !uploading
        ? { mode, engine, images: photos.map((p) => p.ref), details: details || undefined }
        : null
      : mode === "cast"
        ? { mode, engine, cast, details: details || undefined }
        : brief.trim()
          ? { mode, engine, prompt: brief }
          : null;
  const preview = useRunPreview("/api/photodump/character", body);
  const addFiles = (files: Iterable<File>) => {
    if (askFirst()) return;
    const list = [...files].filter((f) => /^image\//.test(f.type));
    if (photos.length + list.length > SHEET_MAX_REFS) toast(`Maximum ${SHEET_MAX_REFS} images`);
    list.slice(0, SHEET_MAX_REFS - photos.length).forEach((f) => fileToList(f, setPhotos, "image"));
  };
  // A result sent here ("Make a character sheet" under a picture): the first reference photo, From Reference.
  const takeHandoff = useCallback((url: string) => {
    setMode("reference");
    setPhotos((xs) => (xs.some((x) => x.ref === url) ? xs : [{ ref: url, preview: url, kind: "image" as const, id: nanoid(8) }, ...xs].slice(0, SHEET_MAX_REFS)));
  }, []);
  const create = () =>
    askRun(() => {
      if (mode === "reference" && !photos.length) return toast("Upload at least 1 image");
      if (!body) return toast(mode === "describe" ? "Describe your character first" : "Wait for the uploads to finish");
      run.mutate(body, {
        // The run line already says which model runs and why (its notes), so no toast here.
        onSuccess: (r) => setIds((xs) => [...r.items.map((g) => g.id), ...xs]),
        onError: (e) => toastError(e, "Failed to create character sheet"),
      });
    }, "run");

  return (
    <PageShell wide>
      <Suspense fallback={null}>
        <HandoffImage onImage={takeHandoff} />
      </Suspense>
      <TabFromLink param="mode" ids={MODE_IDS} onTab={setMode} />
      <PageHeader title="Character Sheet" description="Build your AI avatar: a consistent character for your videos, from a reference or defined from scratch.">
        <EngineSwitch value={engine} onChange={setEngine} />
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-4">
          <TabRow role="tablist" aria-label="How to build it" follow>
            {MODES.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={mode === id}
                onClick={() => {
                  setMode(id);
                  linkTab("mode", id);
                }}
                className={TAB_PILL}
                {...onAttr(mode === id)}
              >
                {label}
              </button>
            ))}
          </TabRow>

          {mode === "reference" && (
            <div className="space-y-3">
              <div
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  addFiles(e.dataTransfer.files);
                }}
                onPaste={(e) => addFiles(e.clipboardData.files)}
                className={cn("rounded-2xl border border-dashed transition-colors", over && "border-primary bg-brand-faint")}
              >
                <button
                  type="button"
                  onClick={() => askFirst() || fileInput.current?.click()}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl px-4 py-10 text-center outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50"
                >
                  <ImagePlus className="size-6 text-muted-foreground" />
                  <span className="text-[14px] font-medium">Drop images here</span>
                  <span className="text-[12.5px] text-muted-foreground">1–{SHEET_MAX_REFS} photos of one person · PNG, JPG or WebP · or click to choose</span>
                </button>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => (addFiles(e.target.files ?? []), (e.target.value = ""))} />
              </div>
              {photos.length > 0 && (
                <div className="grid grid-cols-5 gap-2">
                  {photos.map((p, i) => (
                    <div key={p.id ?? i} className="relative aspect-square overflow-hidden rounded-lg bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.preview} alt="" className="size-full object-cover" />
                      {p.uploading && (
                        <span className="absolute inset-0 grid place-items-center bg-background/60">
                          <Loader2 className="size-4 animate-spin" />
                        </span>
                      )}
                      <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((xs) => xs.filter((x) => x !== p))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background">
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Input value={details} onChange={(e) => setDetails(e.target.value.slice(0, 300))} placeholder="Optional details, e.g. “keep the denim jacket”" aria-label="Details" />
            </div>
          )}

          {mode === "cast" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="mr-auto text-[13px] text-muted-foreground">Build your film&apos;s cast from scratch - genre, budget, appearance, and every detail in between.</p>
                <Button variant="outline" size="sm" onClick={() => setCast((v) => randomCast(fields, v))}>
                  <Shuffle /> Randomize
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCast(defaults)}>
                  <RotateCcw /> Reset
                </Button>
              </div>
              <CastForm fields={fields} values={cast} set={(patch) => setCast((v) => ({ ...v, ...patch }))} />
              <Input value={details} onChange={(e) => setDetails(e.target.value.slice(0, 300))} placeholder="Distinguishing details (optional)" aria-label="Distinguishing details" />
            </div>
          )}

          {mode === "describe" && (
            <div className="space-y-2">
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} placeholder="Who are they? e.g. “a 26-year-old surfer and photographer from Lisbon, freckles, sun-bleached curls”" aria-label="Describe your character" />
            </div>
          )}

          {mode !== "reference" && (
            <Link
              href="/influencer"
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Dices className="size-3.5" aria-hidden /> Build one game-style in the AI Influencer builder: 18 categories, creatures, Shuffle
            </Link>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-2xl border p-3">
            <div className="min-w-0 flex-1">
              <RunLine preview={body ? preview.data : undefined} loading={preview.isFetching} />
            </div>
            <Button onClick={create} disabled={run.isPending || uploading}>
              {run.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} {run.isPending ? "Submitting..." : "Create AI Avatar"}
            </Button>
          </div>
        </section>

        <section className="min-w-0 space-y-3" aria-label="Your sheets">
          {mine.length ? (
            <>
              {!ids.length && <p className="text-[13px] font-medium text-muted-foreground">Recent sheets</p>}
              <ResultsGrid
                items={mine}
                ratio={16 / 9}
                className="sm:grid-cols-1 lg:grid-cols-1"
                onRetried={(from, to) => setIds((xs) => (xs.length ? xs.flatMap((id) => (id === from ? to : [id])) : xs))}
              />
              {latest && (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-background p-3">
                    <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">Film the character all the way round: front, right side, back, left side.</p>
                    <SheetTurnaround
                      key={latest.id}
                      pictures={sheetPictures(latest)}
                      name={mode === "cast" ? castNameFor(cast) : undefined}
                      // Photos someone brought are of a real person: the consent line is asked for.
                      realPerson={(latest.request.inputs?.images ?? []).some((u) => u.startsWith("/api/files/"))}
                    />
                    <AnimatePosesButton key={`poses-${latest.id}`} pictures={sheetPictures(latest)} name={mode === "cast" ? castNameFor(cast) : undefined} />
                  </div>
                  <SaveCharacter
                    key={`save-${latest.id}`}
                    item={latest}
                    extra={(latest.request.inputs?.images ?? []).filter((u) => u.startsWith("/api/files/"))}
                    defaultName={mode === "cast" ? castNameFor(cast) : "My character"}
                  />
                </>
              )}
            </>
          ) : (
            <div className="grid min-h-64 place-items-center gap-5 rounded-2xl border border-dashed p-6 text-center">
              <SheetExample />
              <div className="max-w-sm space-y-1">
                <p className="font-heading text-[22px]">Your character sheet appears here</p>
                <p className="text-[13px] text-muted-foreground">Front, three-quarter, profile and back views of the same person — then save it as a character to use in any prompt with @.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
