"use client";

import { ArrowLeft, ArrowRight, History, Library, Loader2, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader, PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { fileToList, type SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { useEngine, useGenerations, useModelAccess } from "@/lib/api";
import { keepOffered, offered } from "@/lib/model-access";
import { customPack, DEFAULT_ASPECT, MAX_PACK_REFS, MAX_SELFIE_MB, PACKS, PHOTODUMP_ASPECTS, PHOTODUMP_MODELS, PHOTODUMP_SOUL, soulIdOf, type Pack } from "@/lib/catalog/packs";
import type { Generation } from "@/lib/catalog/types";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { linkTab, TabFromLink } from "@/components/nav/tab-from-link";
import { toastError } from "@/lib/refusals";
import { useAskFirst } from "./ask-first";
import { PackCover } from "./covers";
import { useOwnsElements, usePhotoCharacters, useRun, useRunPreview, usePackActions, useUserPacks } from "./hooks";
import { DownloadAll, ResultsGrid, runState } from "./results";
import { RunLine, Steps } from "./steps";
import { CharacterPicker } from "./subject";
import { UploadBox } from "./upload-box";

const STEPS = ["Choose a pack", "Add your photo", "Get your photos"];
const MODEL_NAMES: Record<string, string> = {
  "fuobe-soul": "Fuobe Soul (keeps your face)",
  "nano-banana-pro": "Nano Banana Pro",
  "nano-banana-2-1": "Nano Banana 2.1",
  "seedream-5-pro": "Seedream 5.0 Pro",
  "qwen-image-edit-2511-cloud": "Qwen-Image-Edit 2511",
  "oss-qwen-image-21": "Qwen-Image 2.1",
  "oss-qwen-image-21-turbo": "Qwen-Image 2.1 Turbo",
  "oss-krea2-identity-edit": "Krea 2 Identity Edit",
};
const TABS = [
  ["all", "All"],
  ["photodump", "Photodump"],
  ["instadump", "From a selfie"],
  ["mine", "My packs"],
] as const;
type PackTab = (typeof TABS)[number][0];
/** The tabs a link can open (?tab=instadump: the bar's menus, search). */
const TAB_IDS: readonly PackTab[] = TABS.map(([id]) => id);
const ratioOf = (a: string) => {
  const [w, h] = a.split(":").map(Number);
  return w && h ? w / h : 3 / 4;
};

/** Instadump's "Create pack": a name and up to 15 reference photos, each recreated with you in it. */
function CreatePack({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [refs, setRefs] = useState<SlotValue[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const { create } = usePackActions();
  const busy = refs.some((r) => r.uploading);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create new pack</DialogTitle>
          <DialogDescription>Create a pack from reference photos to generate new images in that style.</DialogDescription>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pack name" aria-label="Pack name" maxLength={60} />
        <p className="text-[12.5px] text-muted-foreground">Upload your reference set up to {MAX_PACK_REFS} photos</p>
        <div className="grid grid-cols-5 gap-1.5">
          {refs.map((r, i) => (
            <div key={r.id ?? i} className="relative aspect-square overflow-hidden rounded-md bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.preview} alt="" className="size-full object-cover" />
              {r.uploading && (
                <span className="absolute inset-0 grid place-items-center bg-background/60">
                  <Loader2 className="size-4 animate-spin" />
                </span>
              )}
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setRefs((xs) => xs.filter((x) => x !== r))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {refs.length < MAX_PACK_REFS && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label="Add reference photos"
              className="grid aspect-square place-items-center rounded-md border border-dashed text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => ([...(e.target.files ?? [])].slice(0, MAX_PACK_REFS - refs.length).forEach((f) => fileToList(f, setRefs, "image")), (e.target.value = ""))}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || !refs.length || busy || create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), refs: refs.map((r) => r.ref).filter(Boolean) },
                {
                  // The new pack shows up selected under My packs: no toast needed.
                  onSuccess: (p) => {
                    setName("");
                    setRefs([]);
                    onOpenChange(false);
                    onCreated(p.id);
                  },
                  onError: (e) => toastError(e),
                },
              )
            }
          >
            {(busy || create.isPending) && <Loader2 className="animate-spin" />} Create pack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Run {
  batchId: string;
  title: string;
  items: Generation[];
  at: number;
}

/** Past runs (this feature's generations grouped by batch), newest first. */
function useRuns(feature: string) {
  const { data } = useGenerations({ features: [feature], limit: 200 });
  return useMemo(() => {
    const by = new Map<string, Run>();
    for (const g of data ?? []) {
      const id = g.batchId ?? g.id;
      const run = by.get(id) ?? { batchId: id, title: g.request.batchTitle ?? g.prompt ?? "Run", items: [], at: g.createdAt };
      run.items.push(g);
      run.at = Math.max(run.at, g.createdAt);
      by.set(id, run);
    }
    return [...by.values()].sort((a, b) => b.at - a.at);
  }, [data]);
}

/** /photodump: Photodump (trained characters) and Instadump (one selfie) — choose a pack, add your photo, get the set. */
export function PhotodumpView() {
  const [engine, setEngine] = useEngine();
  // A pack of your own is made of photos you upload: a guest is asked to sign up first, and an account with neither its
  // own GPU nor its own key to connect one (as before any upload). An account's packs and runs are its own.
  const askFirst = useAskFirst();
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [tab, setTab] = useState<PackTab>("all");
  // A link to a tab (the bar's menus, search) shows that tab's packs: back to the first step.
  const tabFromLink = useCallback((id: PackTab) => {
    setTab(id);
    setStep(0);
  }, []);
  const [q, setQ] = useState("");
  const [packId, setPackId] = useState<string>();
  const [subjectMode, setSubjectMode] = useState<"selfie" | "character">("selfie");
  const [selfie, setSelfie] = useState<SlotValue | null>(null);
  const [elementId, setElementId] = useState<string>();
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [modelPick, setModelPick] = useState<string>();
  const [batchId, setBatchId] = useState<string>();
  const [creatingPack, setCreatingPack] = useState(false);
  const userPacks = useUserPacks();
  const { remove } = usePackActions();
  const run = useRun<Record<string, unknown>>("/api/photodump");
  const runs = useRuns("photodump");

  const all: Pack[] = useMemo(() => [...PACKS, ...(userPacks.data ?? []).map(customPack)], [userPacks.data]);
  const needle = q.trim().toLowerCase();
  const shown = all.filter(
    (p) =>
      (tab === "all" || (tab === "mine" ? p.custom : !p.custom && p.product === tab)) &&
      (!needle || `${p.name} ${p.description} ${p.author ?? ""}`.toLowerCase().includes(needle)),
  );
  const pack = all.find((p) => p.id === packId);
  const go = (i: number) => {
    setStep(i);
    setReached((r) => Math.max(r, i));
  };

  const subjectReady = subjectMode === "selfie" ? !!selfie?.ref && !selfie.uploading : !!elementId;
  // The Model choice follows the engine: a pick the other engine had counts as Auto (one radio is always checked).
  const elements = usePhotoCharacters();
  const character = subjectMode === "character" ? elements.data?.find((e) => e.id === elementId) : undefined;
  // Models switched off in Settings → Models & licences leave the choices (Auto picks among the ones on).
  const access = useModelAccess();
  const choices: (string | undefined)[] = [undefined, ...keepOffered(PHOTODUMP_MODELS[engine], (m) => offered(access, m, engine))];
  // The owner trains a character's Soul ID (Elements) for Fuobe Soul. A visitor's characters are its own photos: Fuobe
  // Soul stays a choice, its press opens "My character" (pick one, or make one there), and the run line says which model
  // makes the set from that character's photo.
  const owner = useOwnsElements();
  const unavailable = (m?: string): string | null => {
    if (m !== PHOTODUMP_SOUL) return null;
    if (pack?.custom) return "Your own packs recreate each reference photo with an edit model";
    if (!owner) return null;
    if (!character) return "Pick a trained character";
    return soulIdOf({ kind: "element", handle: character.handle, name: character.name, references: character.references, loras: character.loras }, engine) ? null : `${character.name} isn't trained yet`;
  };
  const pick = choices.includes(modelPick) && !unavailable(modelPick) ? modelPick : undefined;
  const body = pack && subjectReady
    ? { packId: pack.id, engine, aspectRatio: aspect, modelId: pick, ...(subjectMode === "selfie" ? { selfie: selfie!.ref } : { elementId }) }
    : null;
  const preview = useRunPreview("/api/photodump", step === 1 ? body : null);
  const fixedAspect = !!body && !!preview.data?.fixedAspect;
  const current = runs.find((r) => r.batchId === batchId);
  const items = current?.items ?? [];
  const state = runState(items);
  const product = "photo set";

  const generate = () => {
    if (!body) return toast(subjectMode === "selfie" ? "Add your photo first" : "Pick a character first");
    run.mutate(body, {
      // The run line showed the model and its notes before Generate: no toast.
      onSuccess: (res) => {
        setBatchId(res.batchId ?? res.items[0]?.batchId ?? undefined);
        go(2);
      },
      onError: (e) => toastError(e, "Cannot start photodump generation, please try again"),
    });
  };

  return (
    <PageShell wide>
      <TabFromLink param="tab" ids={TAB_IDS} onTab={tabFromLink} />
      <PageHeader title="Photodump" description="A whole set of photos of you in one go, from one selfie or a saved character, in a pack of styles.">
        <EngineSwitch value={engine} onChange={setEngine} />
      </PageHeader>
      <div className="mb-6">
        <Steps steps={STEPS} current={step} reached={reached} onGo={go} />
      </div>

      {step === 0 && (
        <section aria-label="Choose a pack" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <TabRow role="tablist" aria-label="Packs" follow className="max-w-full">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                    linkTab("tab", id);
                  }}
                  className={TAB_PILL}
                  {...onAttr(tab === id)}
                >
                  {label}
                </button>
              ))}
            </TabRow>
            <label className="flex h-9 w-full min-w-0 items-center gap-2 rounded-full border bg-background px-3 focus-within:border-primary sm:w-auto sm:max-w-xs sm:flex-1">
              <Search className="size-4 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search packs" aria-label="Search packs" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <button
              type="button"
              onClick={() => askFirst(() => setCreatingPack(true))}
              className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-6" />
              <span className="text-[13.5px] font-medium">Create pack</span>
              <span className="text-[12px]">From up to {MAX_PACK_REFS} reference photos</span>
            </button>
            {shown.map((p) => {
              const sel = p.id === packId;
              return (
                <div key={p.id} className="group/pack relative min-w-0">
                  <button
                    type="button"
                    aria-pressed={sel}
                    onClick={() => setPackId(p.id)}
                    onDoubleClick={() => (setPackId(p.id), go(1))}
                    className={cn("block w-full overflow-hidden rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", sel && "ring-3 ring-primary")}
                  >
                    <PackCover id={p.id} name={p.name} count={p.count} refs={p.refs} hue={p.hue} tone={p.tone} className="aspect-[3/4]" />
                  </button>
                  <p className="mt-1.5 line-clamp-2 px-0.5 text-[12px] text-muted-foreground">
                    {p.custom ? "Your pack · " : ""}{p.description}
                  </p>
                  {p.custom && (
                    <button
                      type="button"
                      aria-label={`Delete pack ${p.name}`}
                      onClick={() => remove.mutate(p.id, { onSuccess: () => (packId === p.id && setPackId(undefined), toast("Pack deleted")) })}
                      className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-background/90 opacity-100 shadow-soft transition sm:opacity-0 sm:group-hover/pack:opacity-100 sm:focus-visible:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {!shown.length && <p className="py-10 text-center text-[14px] text-muted-foreground">{tab === "mine" && !needle ? "No packs of your own yet — create one from your reference photos." : `No packs match “${q}”`}</p>}
          <div className="sticky bottom-[calc(var(--chrome-bottom)+0.75rem)] z-10 flex items-center justify-between gap-3 rounded-2xl border bg-background/95 p-3 shadow-normal backdrop-blur">
            <p className="min-w-0 truncate text-[13px]">{pack ? <><span className="font-medium">{pack.name}</span> · {pack.count} photos</> : <span className="text-muted-foreground">Pick a pack to continue</span>}</p>
            <Button disabled={!pack} onClick={() => go(1)}>
              Use this pack <ArrowRight />
            </Button>
          </div>
          {runs.length > 0 && (
            <section aria-label="History" className="space-y-2 pt-4">
              <h2 className="flex items-center gap-2 text-[14px] font-medium">
                <History className="size-4" /> History
              </h2>
              <ul className="divide-y rounded-xl border">
                {runs.slice(0, 8).map((r) => {
                  const ok = r.items.filter((g) => g.status === "succeeded").length;
                  return (
                    <li key={r.batchId}>
                      <button type="button" onClick={() => (setBatchId(r.batchId), go(2))} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent">
                        <span className="min-w-0 truncate text-[13px] font-medium">{r.title}</span>
                        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                          {ok}/{r.items.length} · {timeAgo(r.at)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </section>
      )}

      {step === 1 && pack && (
        <section aria-label="Add your photo" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <div>
              <h2 className="font-heading text-[26px] leading-tight">Add your photo</h2>
              <p className="text-[14px] text-muted-foreground">Add one clear selfie, and every photo in the pack is made from it. Or use a saved character.</p>
            </div>
            <div role="radiogroup" aria-label="Who is in the photos" onKeyDown={radioKeys} className="inline-flex rounded-full bg-muted p-0.5">
              {(
                [
                  ["selfie", "One selfie"],
                  ["character", "My character"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="radio" aria-checked={subjectMode === id} tabIndex={radioTab(subjectMode === id)} onClick={() => setSubjectMode(id)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium text-muted-foreground transition", subjectMode === id && "bg-background text-foreground shadow-soft")}>
                  {label}
                </button>
              ))}
            </div>
            {subjectMode === "selfie" ? (
              <div className="space-y-2">
                <UploadBox value={selfie} onChange={setSelfie} title="Add your photo" hint="Use a clear, well-lit photo for best results." maxMb={MAX_SELFIE_MB} className="aspect-[4/3] max-h-[420px] w-full" />
                <p className="text-[12px] text-muted-foreground">A clear, sharp photo of your face works best.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <CharacterPicker value={elementId} onChange={setElementId} />
                <p className="text-[12px] text-muted-foreground">Trained characters keep the face best.</p>
              </div>
            )}
          </div>
          <aside className="space-y-5 rounded-2xl border p-4 lg:sticky lg:top-[calc(var(--chrome-top)+1.5rem)] lg:self-start">
            <div className="flex items-center gap-3">
              <PackCover id={pack.id} name={pack.name} count={pack.count} refs={pack.refs} hue={pack.hue} tone={pack.tone} bare className="size-14 shrink-0 rounded-lg" />
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium">{pack.name}</p>
                <p className="text-[12px] text-muted-foreground">{pack.count} photos</p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[12.5px] font-medium">Aspect ratio</p>
              {/* A model that keeps the photo's shape (Qwen-Image 2.1's edit) ignores the aspect ratio: the picker is off and the run line says why. */}
              <div role="radiogroup" aria-label="Aspect ratio" aria-disabled={fixedAspect || undefined} onKeyDown={radioKeys} className="flex flex-wrap gap-1">
                {PHOTODUMP_ASPECTS.map((a) => (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={aspect === a}
                    tabIndex={radioTab(aspect === a)}
                    disabled={fixedAspect && aspect !== a}
                    onClick={() => setAspect(a)}
                    className={cn(
                      "h-8 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-40",
                      aspect === a ? "border-primary bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent",
                      fixedAspect && aspect === a && "opacity-60",
                    )}
                  >
                    {a === "auto" ? "Auto" : a}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[12.5px] font-medium">Model</p>
              <div role="radiogroup" aria-label="Model" onKeyDown={radioKeys} className="flex flex-wrap gap-1">
                {choices.map((m) => {
                  const why = unavailable(m);
                  return (
                    <button
                      key={m ?? "auto"}
                      role="radio"
                      aria-checked={pick === m}
                      tabIndex={radioTab(pick === m)}
                      disabled={!!why}
                      title={why ?? undefined}
                      aria-label={why ? `${m ? MODEL_NAMES[m] : "Auto"} — ${why}` : undefined}
                      onClick={() => {
                        setModelPick(m);
                        // A visitor's Fuobe Soul starts from a character of its own: "My character" picks one or makes one.
                        if (m === PHOTODUMP_SOUL && !owner && !pack.custom) setSubjectMode("character");
                      }}
                      className={cn(
                        "h-8 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                        pick === m ? "border-primary bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {m ? MODEL_NAMES[m] : "Auto"}
                    </button>
                  );
                })}
              </div>
            </div>
            <RunLine preview={body ? preview.data : undefined} loading={preview.isFetching} />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => go(0)}>
                <ArrowLeft /> Back
              </Button>
              <Button className="flex-1" disabled={!body || run.isPending || !!preview.data?.error} onClick={generate}>
                {run.isPending && <Loader2 className="animate-spin" />} Generate {pack.count}
              </Button>
            </div>
          </aside>
        </section>
      )}

      {step === 2 && (
        <section aria-label="Get your photos" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-heading text-[26px] leading-tight">Get your {product}</h2>
              <p className="text-[14px] text-muted-foreground">
                {!items.length
                  ? "Starting…"
                  : state.busy
                    ? `Making ${state.total} photos — they appear here as they finish.`
                    : state.failed
                      ? `${state.done} of ${state.total} photos are ready — retry the ${state.failed === 1 ? "one" : "ones"} that didn't make it.`
                      : "Your new photos are ready - download, post, share and enjoy!"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DownloadAll items={items} />
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => {
                  setBatchId(undefined);
                  setStep(0);
                  setReached(0);
                }}
              >
                <RotateCcw /> Restart
              </Button>
              <Button asChild variant="outline" size="sm" className="h-8">
                <Link href="/library">
                  <Library /> Go to Library
                </Link>
              </Button>
            </div>
          </div>
          <ResultsGrid items={items} ratio={ratioOf(items[0]?.request.params?.aspectRatio ?? aspect)} />
        </section>
      )}

      <CreatePack open={creatingPack} onOpenChange={setCreatingPack} onCreated={(id) => (setTab("mine"), setPackId(id))} />
    </PageShell>
  );
}
