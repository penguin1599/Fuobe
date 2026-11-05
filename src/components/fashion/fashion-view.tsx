"use client";

import { ArrowLeft, ArrowRight, Library, Loader2, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader, PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { EngineSwitch } from "@/components/studio/engine-switch";
import type { SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { DownloadAll, ResultsGrid } from "@/components/photodump/results";
import { useRun, useRunPreview } from "@/components/photodump/hooks";
import { RunLine, Steps } from "@/components/photodump/steps";
import { CharacterPicker } from "@/components/photodump/subject";
import { UploadBox } from "@/components/photodump/upload-box";
import { useEngine, useGenerations, useModelAccess } from "@/lib/api";
import { keepOffered, offered } from "@/lib/model-access";
import { FASHION, FASHION_MODELS, FASHION_START, FASHION_STEPS, fashionBlocker, fashionReducer, getTemplate, type FashionState } from "@/lib/catalog/packs";
import type { Generation } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { useStoredReducer } from "./stored";
import { TemplatePreview } from "./template-preview";

const LABELS = ["Select a template", "Character", "Generation", "Clothing", "Photoset"];
/**
 * The outfit and photoset models' names (FASHION_MODELS has each step's per engine): Fuobe Try-On (the Original, FLUX.2
 * [klein] 4B + a try-on LoRA), the Qwen-Image and Krea 2 edit models, partners after.
 */
const MODEL_LABELS: Record<string, string> = {
  "fuobe-tryon": "Fuobe Try-On",
  "fashn-tryon": "FASHN Try-On",
  "nano-banana-pro": "Nano Banana Pro",
  "qwen-image-edit-2511-cloud": "Qwen-Image-Edit 2511",
  "oss-qwen-image-21": "Qwen-Image 2.1",
  "oss-qwen-image-21-turbo": "Qwen-Image 2.1 Turbo",
  "oss-krea2-identity-edit": "Krea 2 Identity Edit",
};

/** /fashion-factory: template → character → pick 1 of 4 base shots → outfit → photoset. */
export function FashionView() {
  const [s, dispatch] = useStoredReducer<FashionState, Parameters<typeof fashionReducer>[1]>("fuobe.fashion", fashionReducer, FASHION_START);
  const [engine, setEngine] = useEngine();
  const [garment, setGarment] = useState<SlotValue | null>(null);
  const [pickedOutfit, setOutfitModel] = useState<string>();
  const [pickedSet, setSetModel] = useState<string>();
  // Models switched off in Settings → Models & licences (Fuobe Try-On with its try-on LoRA off too) leave the choice;
  // the pick falls back to one that is on.
  const access = useModelAccess();
  const choices = (ids: readonly string[]) => keepOffered(ids, (id) => offered(access, id, engine));
  const outfitModels = choices(FASHION_MODELS.outfit[engine]);
  const outfitModel = pickedOutfit && outfitModels.includes(pickedOutfit) ? pickedOutfit : outfitModels[0];
  const setModels = choices(FASHION_MODELS.photoset[engine]);
  const setModel = pickedSet && setModels.includes(pickedSet) ? pickedSet : setModels[0];
  const { data } = useGenerations({ features: ["fashion"], limit: 200 });
  const base = useRun<Record<string, unknown>>("/api/photodump/fashion");
  const outfit = useRun<Record<string, unknown>>("/api/photodump/fashion");
  const photoset = useRun<Record<string, unknown>>("/api/photodump/fashion");
  const t = s.templateId ? getTemplate(s.templateId) : undefined;
  const at = FASHION_STEPS.indexOf(s.step);
  const reached = Math.max(at, s.photosetBatch ? 4 : s.outfitIds.length ? 3 : s.baseIds.length ? 2 : s.elementId ? 1 : 0);

  const baseItems = useMemo(() => (data ?? []).filter((g) => s.baseIds.includes(g.id)), [data, s.baseIds]);
  const outfitItems = useMemo(() => (data ?? []).filter((g) => s.outfitIds.includes(g.id)), [data, s.outfitIds]);
  const setItems = useMemo(() => (data ?? []).filter((g) => !!s.photosetBatch && g.batchId === s.photosetBatch), [data, s.photosetBatch]);
  const busy = (gs: Generation[]) => gs.some((g) => g.status === "queued" || g.status === "running");

  // The garment shown: the one being uploaded here, else the saved one (after a reload).
  const garmentValue: SlotValue | null = garment ?? (s.garment?.url ? { ref: s.garment.url, preview: s.garment.url, kind: "image" } : null);
  const setGarmentValue = (v: SlotValue | null) => {
    setGarment(v);
    dispatch({ type: "garment", garment: v ? { url: v.ref, uploading: !!v.uploading } : undefined });
  };

  const baseBody = t && s.elementId ? { step: "base", templateId: t.id, elementId: s.elementId, engine } : null;
  const outfitBody = t && s.base && s.garment && !s.garment.uploading ? { step: "outfit", templateId: t.id, base: s.base, garment: s.garment.url, engine, modelId: outfitModel } : null;
  const setBody = t && s.outfit ? { step: "photoset", templateId: t.id, dressed: s.outfit, engine, modelId: setModel } : null;
  const preview = useRunPreview("/api/photodump/fashion", s.step === "character" ? baseBody : s.step === "clothing" ? (s.outfit ? setBody : outfitBody) : null);

  const block = (msg: string | null) => {
    if (msg) toast(msg, { id: "fashion-blocker" });
    return !!msg;
  };
  const startBase = () => {
    if (block(fashionBlocker(s)) || !baseBody) return;
    base.mutate(baseBody, {
      onSuccess: (r) => dispatch({ type: "baseStarted", ids: r.items.map((g) => g.id) }),
      onError: (e) => toastError(e, "JobSet wasn't created"),
    });
  };
  const startOutfit = () => {
    if (block(fashionBlocker(s, "outfit")) || !outfitBody) return;
    outfit.mutate(outfitBody, {
      onSuccess: (r) => dispatch({ type: "outfitStarted", ids: r.items.map((g) => g.id) }),
      onError: (e) => toastError(e, "JobSet wasn't created"),
    });
  };
  const startSet = () => {
    if (block(fashionBlocker(s)) || !setBody) return;
    photoset.mutate(setBody, {
      onSuccess: (r) => dispatch({ type: "photosetStarted", batchId: r.batchId ?? r.items[0]?.batchId ?? r.items[0]?.id }),
      onError: (e) => toastError(e, "JobSet wasn't created"),
    });
  };

  return (
    <PageShell wide>
      <PageHeader title="Fashion Factory" description="Your product on one consistent model, across a full photoshoot.">
        <div className="flex items-center gap-2">
          {at > 0 && (
            <Button variant="ghost" size="sm" onClick={() => (dispatch({ type: "reset" }), setGarment(null))}>
              <RotateCcw /> Start over
            </Button>
          )}
          <EngineSwitch value={engine} onChange={setEngine} />
        </div>
      </PageHeader>

      <div className="mb-6">
        <Steps steps={LABELS} current={at} reached={reached} onGo={(i) => dispatch({ type: "goto", step: FASHION_STEPS[i] })} />
      </div>

      {s.step === "template" && (
        <section aria-label="Select a template" className="space-y-4">
          <div>
            <h2 className="font-heading text-[26px] leading-tight">Select a template</h2>
            <p className="text-[14px] text-muted-foreground">Choose a template or aesthetic for the photo set</p>
          </div>
          <div role="radiogroup" aria-label="Templates" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {FASHION.map((x) => {
              const sel = x.id === s.templateId;
              return (
                <div key={x.id} className="min-w-0">
                  <div
                    onClick={() => dispatch({ type: "template", id: x.id })}
                    className={cn("relative cursor-pointer overflow-hidden rounded-xl ring-offset-2 ring-offset-background", sel && "ring-3 ring-primary")}
                  >
                    <TemplatePreview t={x} className="aspect-[6/7]" />
                  </div>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    onClick={() => dispatch({ type: "template", id: x.id })}
                    className="mt-1.5 block w-full rounded px-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="block text-[13px] font-semibold">{x.name.replace(/(^|[\s-])(\p{Ll})/gu, (_, a: string, c: string) => a + c.toUpperCase())}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {x.shots} shots · {x.description}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="sticky bottom-[calc(var(--chrome-bottom)+0.75rem)] z-10 flex items-center justify-between gap-3 rounded-2xl border bg-background/95 p-3 shadow-normal backdrop-blur">
            <p className="min-w-0 truncate text-[13px]">{t ? <span className="font-medium">{t.name}</span> : <span className="text-muted-foreground">Pick a template</span>}</p>
            <Button aria-disabled={!t} className={cn(!t && "opacity-50")} onClick={() => !block(fashionBlocker(s)) && dispatch({ type: "next" })}>
              Continue <ArrowRight />
            </Button>
          </div>
        </section>
      )}

      {s.step === "character" && t && (
        <section aria-label="Character" className="space-y-4">
          <div>
            <h2 className="font-heading text-[26px] leading-tight">Pick your character</h2>
            <p className="text-[14px] text-muted-foreground">Select or create the character who wears your product. Next makes 4 base shots in the {t.name} set at 3:4.</p>
          </div>
          <CharacterPicker value={s.elementId} onChange={(id) => dispatch({ type: "element", id })} />
          <Footer onBack={() => dispatch({ type: "back" })} line={<RunLine preview={baseBody ? preview.data : undefined} loading={preview.isFetching} />}>
            <Button onClick={startBase} disabled={base.isPending || !!(baseBody && preview.data?.error)}>
              {base.isPending ? <Loader2 className="animate-spin" /> : null} {base.isPending ? "Generating..." : "Next"}
            </Button>
          </Footer>
        </section>
      )}

      {s.step === "generation" && t && (
        <section aria-label="Generation" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-heading text-[26px] leading-tight">See instant variations of the selected character</h2>
              <p className="text-[14px] text-muted-foreground">Pick the base shot to dress.</p>
            </div>
            <Button variant="outline" size="sm" onClick={startBase} disabled={base.isPending || busy(baseItems)}>
              <RefreshCw /> Regenerate
            </Button>
          </div>
          <ResultsGrid items={baseItems} picked={s.base} onPick={(url) => dispatch({ type: "pickBase", url })} onRetried={(from, to) => dispatch({ type: "retried", from, to })} />
          <Footer onBack={() => dispatch({ type: "back" })}>
            <Button onClick={() => !block(fashionBlocker(s)) && dispatch({ type: "next" })}>
              Next <ArrowRight />
            </Button>
          </Footer>
        </section>
      )}

      {s.step === "clothing" && t && (
        <section aria-label="Clothing" className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-3">
            <h2 className="font-heading text-[26px] leading-tight">Upload outfit</h2>
            <div className="grid grid-cols-2 gap-2">
              <div className="overflow-hidden rounded-xl bg-muted">
                {s.base && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.base} alt="Base shot" className="aspect-[3/4] w-full object-cover" />
                )}
              </div>
              <UploadBox value={garmentValue} onChange={setGarmentValue} title="Upload outfit" hint="The product: a garment on a model or flat-lay" className="aspect-[3/4]" />
            </div>
            <ModelChips label="Outfit model" ids={outfitModels} value={outfitModel} onChange={setOutfitModel} />
            <RunLine preview={outfitBody && !s.outfit ? preview.data : undefined} loading={!s.outfit && preview.isFetching} />
            <Button className="w-full" variant={s.outfitIds.length ? "outline" : "default"} onClick={startOutfit} disabled={outfit.isPending}>
              {outfit.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} {outfit.isPending ? "Generating..." : "Generate outfit"}
            </Button>
          </div>
          <div className="min-w-0 space-y-3">
            {s.outfitIds.length ? (
              <>
                <p className="text-[14px] text-muted-foreground">Select a result to generate your photoset from. Edit your outfit or continue</p>
                <ResultsGrid
                  items={outfitItems}
                  picked={s.outfit}
                  onPick={(url) => dispatch({ type: "pickOutfit", url })}
                  onRetried={(from, to) => dispatch({ type: "retried", from, to })}
                  className="lg:grid-cols-3"
                />
              </>
            ) : (
              <div className="grid h-full min-h-48 place-items-center rounded-2xl border border-dashed p-6 text-center text-[13px] text-muted-foreground">Upload the outfit, then Generate outfit to dress your base shot.</div>
            )}
            {s.outfit && <ModelChips label="Photoset model" ids={setModels} value={setModel} onChange={setSetModel} />}
            <Footer onBack={() => dispatch({ type: "back" })} line={s.outfit ? <RunLine preview={preview.data} loading={preview.isFetching} /> : undefined}>
              <Button onClick={startSet} disabled={photoset.isPending}>
                {photoset.isPending ? <Loader2 className="animate-spin" /> : null} {photoset.isPending ? "Generating..." : "Get your photoset"}
              </Button>
            </Footer>
          </div>
        </section>
      )}

      {s.step === "photoset" && t && (
        <section aria-label="Photoset" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-heading text-[26px] leading-tight">Get your photoset</h2>
              <p className="text-[14px] text-muted-foreground">{busy(setItems) ? `Shooting ${setItems.length} photos in the ${t.name} set…` : `${t.name} · ${setItems.length} photos`}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DownloadAll items={setItems} />
              <Button variant="outline" size="sm" className="h-8" onClick={() => dispatch({ type: "goto", step: "clothing" })}>
                <ArrowLeft /> Edit outfit
              </Button>
              <Button asChild variant="outline" size="sm" className="h-8">
                <Link href="/library">
                  <Library /> Go to Library
                </Link>
              </Button>
            </div>
          </div>
          <ResultsGrid items={setItems} />
        </section>
      )}
    </PageShell>
  );
}

/** A step's model choice (shown when there is more than one): the Original first, partners after. */
function ModelChips({ label, ids, value, onChange }: { label: string; ids: readonly string[]; value: string; onChange: (id: string) => void }) {
  if (ids.length < 2) return null;
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys} className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <button key={id} role="radio" aria-checked={value === id} tabIndex={radioTab(value === id)} onClick={() => onChange(id)} className={cn("h-8 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors", value === id ? "border-primary bg-brand-faint text-brand-text" : "text-muted-foreground hover:bg-accent")}>
          {MODEL_LABELS[id] ?? id}
        </button>
      ))}
    </div>
  );
}

function Footer({ onBack, line, children }: { onBack: () => void; line?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="sticky bottom-[calc(var(--chrome-bottom)+0.75rem)] z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-background/95 p-3 shadow-normal backdrop-blur">
      <Button variant="outline" onClick={onBack}>
        <ArrowLeft /> Back
      </Button>
      <div className="min-w-0 flex-1">{line}</div>
      {children}
    </div>
  );
}
