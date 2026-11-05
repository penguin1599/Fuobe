"use client";

import { Box, Loader2, PersonStanding } from "lucide-react";
import { nanoid } from "nanoid";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FailedTile, PendingTile } from "@/components/studio/feed";
import { MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { MediaDrop } from "@/components/av/media-drop";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { HandoffImage } from "@/components/nav/next-steps";
import { ExampleRow } from "@/components/studio/example-row";
import { useEngine, useGenerations, useHydrated, useIsOwner, useModelAccess, useStatus } from "@/lib/api";
import {
  FINAL_3D,
  IDOL_QUALITIES,
  MAX_3D_PROMPT,
  MODEL3D_FEATURE,
  MODEL3D_KEY,
  MODEL3D_FILM_FEATURE,
  MODEL3D_MODES,
  MODELS_3D,
  SIDE_LABELS,
  SIDES_HINT,
  VIEW_SIDES,
  idolPhotoFor,
  isIdol,
  MAKE_3D_HINT,
  isIdolMesh,
  model3dBlocker,
  readModel3dLink,
  linkedIdolQuality,
  linkedPicture,
  linkedPhoto,
  model3dFor,
  model3dRequest,
  modeOf,
  type IdolQuality,
  type Model3dInput,
  type Model3dMode,
  type ViewSide,
} from "@/lib/av/model3d";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { keepOffered, offered } from "@/lib/model-access";
import type { ExampleRowData } from "@/lib/examples/types";
import { cn } from "@/lib/utils";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import { Model3dSetupsProvider, useModel3dSetup, type Model3dSetups } from "./own-setups";
import { toastError } from "@/lib/refusals";
import { priceLine, useCreate3d, useRunPreview } from "./hooks";
import { ModelCard } from "./model-card";
import { RefineOption } from "./refine-option";
import { OtherSides, useOtherSidesOffered } from "./other-sides";
import { IDOL_VIEWS_NOTE, canMakeOtherSides, fillOtherSides } from "@/lib/av/idol-views";
import { HI3D_MODEL, withRefine, type Hi3dResolution } from "@/lib/av/hi3d";

/** A model's name, as the picker shows it (the page reads it from the catalog). */
export interface Model3dInfo {
  name: string;
}

/** What a mode's input looks like before anything is uploaded (the price is asked for with these). */
const PLACEHOLDER = "/api/files/placeholder.png";

const HINTS: Record<Model3dMode, string> = {
  image: "One clear photo → a 3D model (.glb) you can spin, download, rig and animate, record as a turntable and turn into a video.",
  multi: "Photos of the same object from 2–4 sides → one 3D model that's right all the way round.",
  text: "Describe one object → a textured 3D model of it.",
  objects: "Name something in a photo → just that object, rebuilt in 3D as it stands.",
  splat: "One photo → a Gaussian splat of the subject: soft, photo-real detail, the background left out.",
};

/**
 * A link's ?model= (from ⌘K, or an image result's Make it 3D) picks that model, its mode and its engine; ?mode= picks a
 * mode; ?model=meshy-rigging (rigging works on a finished model) says where Rig & animate is; ?quality= sets Idol 3D's
 * look and ?image= fills the photo slot (readModel3dLink: an image result's Make it 3D, or an Idol 3D result's "Build the
 * final with TRELLIS.2"). Under its own Suspense: it reads the URL.
 */
function UrlModel({
  onModel,
  onMode,
  onRig,
  onImage,
}: {
  onModel: (mode: Model3dMode, engine: Engine, id: string, quality?: IdolQuality) => void;
  onMode: (mode: Model3dMode) => void;
  onRig: () => void;
  onImage: (url: string, photo?: boolean) => void;
}) {
  const params = useSearchParams();
  useEffect(() => {
    const link = readModel3dLink(params);
    if (link.model) onModel(link.model.mode, link.model.engine, link.model.id, link.quality);
    else if (link.rig) onRig();
    else if (link.mode) onMode(link.mode);
    if (link.image) onImage(link.image, linkedPhoto(link));
  }, [params, onModel, onMode, onRig, onImage]);
  return null;
}

/**
 * Idol 3D's settings: Best or Quick look (labelled by steps and Gaussians), and "It's a photo", which gives the object
 * Idol's looser crop. On your GPU, Advanced → "Trim spikes" also drops the thin spikes at the edges (fal has no such
 * setting, so the cloud doesn't offer it).
 */
function IdolSettings({
  quality,
  onQuality,
  photo,
  onPhoto,
  trim,
}: {
  quality: IdolQuality;
  onQuality: (q: IdolQuality) => void;
  photo: boolean;
  onPhoto: (v: boolean) => void;
  trim?: { on: boolean; onChange: (v: boolean) => void };
}) {
  // Only the owner reads what trimming needs on the ComfyUI (it's theirs to set up).
  const owner = useIsOwner();
  // A visitor's trim runs on its own GPU: what that needs, until the trim's graph is validated here.
  const cleanSetup = useModel3dSetup("clean");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, by: number) => {
    const i = (from + by + IDOL_QUALITIES.length) % IDOL_QUALITIES.length;
    onQuality(IDOL_QUALITIES[i].id);
    refs.current[i]?.focus();
  };
  return (
    <div className="mt-3 space-y-3">
      <div>
        <div role="radiogroup" aria-label="Quality" className="grid grid-cols-2 gap-0.5 rounded-full bg-muted p-0.5">
          {IDOL_QUALITIES.map((q, i) => (
            <button
              key={q.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={quality === q.id}
              tabIndex={quality === q.id ? 0 : -1}
              onClick={() => onQuality(q.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              className={cn("h-8 rounded-full px-3 text-[13px] font-medium", quality === q.id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
            >
              {q.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted-foreground">{IDOL_QUALITIES.find((q) => q.id === quality)?.hint}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="m3d-idol-photo" className="text-[13px] font-normal">
          It&apos;s a photo (looser crop)
        </Label>
        <Switch id="m3d-idol-photo" checked={photo} onCheckedChange={onPhoto} />
      </div>
      {trim && (
        <details className="group rounded-xl border px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
          <summary className="cursor-pointer list-none text-[13px] font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">
            Advanced{trim.on && <span className="text-[12px] font-normal text-muted-foreground"> · trimming spikes</span>}
          </summary>
          <div className="flex items-center justify-between gap-3 pt-3">
            <div className="min-w-0">
              {/* A visitor's run is on its own GPU: what that needs (the owner reads the line below instead). On a phone the
                  chip wraps under the name, flush with it. */}
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Label htmlFor="m3d-idol-trim" className="text-[13px] font-normal">
                  Trim spikes
                </Label>
                <OwnSetupChip setup={cleanSetup} />
              </div>
              <p id="m3d-idol-trim-hint" className="mt-0.5 text-[12px] text-muted-foreground">
                Drops the thin, needle-like bits around the edges of the 3D file.
              </p>
              {owner && (
                <p className="mt-0.5 text-[12px] text-muted-foreground">Needs the ComfyUI-Idol nodes on your ComfyUI; without them the file is saved untrimmed.</p>
              )}
            </div>
            <Switch id="m3d-idol-trim" aria-describedby="m3d-idol-trim-hint" checked={trim.on} onCheckedChange={trim.onChange} />
          </div>
        </details>
      )}
    </div>
  );
}

/** The five modes as one row of pills (wrapping on a phone); arrow keys move between them. */
function ModePicker({ mode, onChange }: { mode: Model3dMode; onChange: (m: Model3dMode) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, by: number) => {
    const i = (from + by + MODEL3D_MODES.length) % MODEL3D_MODES.length;
    onChange(MODEL3D_MODES[i].id);
    refs.current[i]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Make a 3D model" className="mx-auto mt-6 flex max-w-full flex-wrap justify-center gap-1.5">
      {MODEL3D_MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          tabIndex={mode === m.id ? 0 : -1}
          title={m.hint}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(i, 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(i, -1);
            }
          }}
          className={cn(
            "h-8 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
            mode === m.id ? "border-foreground bg-foreground text-background" : "bg-background text-muted-foreground hover:border-border-strong hover:text-foreground",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Image to 3D: a photo, several photos, words, an object in a photo or a splat → a model to spin, download, rig and animate.
 * examples: "See what it makes" (studioExamples("image-to-3d"), from the page), where the models go until there is one.
 */
export function Model3dStudio({ setups = {}, ...props }: { info: Record<string, Model3dInfo>; setups?: Model3dSetups; examples?: ExampleRowData | null }) {
  return (
    <Model3dSetupsProvider value={setups}>
      <Model3dStudioBody {...props} />
    </Model3dSetupsProvider>
  );
}

function Model3dStudioBody({ info, examples }: { info: Record<string, Model3dInfo>; examples?: ExampleRowData | null }) {
  const [engine, setEngine, engineMode] = useEngine();
  // An account makes its models on its own GPU or key (POST /api/image-to-3d); a guest gets the sign-up card when it
  // uploads or runs. The extras (Refine detail, the TRELLIS.2 final, Idol 3D's other sides) show to everyone, marked
  // with what they run on until their graphs are validated on this studio's GPU (MODEL3D_SETUPS).
  const owner = useIsOwner();
  const refineSetup = useModel3dSetup("refine");
  const cleanSetup = useModel3dSetup("clean");
  const press = useOwnSetupPress();
  const access = useModelAccess();
  const create = useCreate3d();
  const results = useGenerations({ features: [MODEL3D_FEATURE, "app:app-image-to-3d", "app:app-photo-to-3d", MODEL3D_FILM_FEATURE], limit: 24 });
  const [mode, setMode] = useState<Model3dMode>("image");
  const router = useRouter();
  // A mode picked here goes in the URL (?mode=), so a reload or a shared link opens it again (UrlModel reads it).
  const pickMode = (m: Model3dMode) => {
    setMode(m);
    router.replace(m === "image" ? "/image-to-3d" : `/image-to-3d?mode=${m}`, { scroll: false });
  };
  // The engine is known once the install's engine mode is: no price asked for a cloud model an open-only install refuses.
  const statusKnown = !!useStatus().data;
  const hydrated = useHydrated();
  const engineKnown = statusKnown && hydrated;
  const [photo, setPhoto] = useState<SlotValue | null>(null);
  // Idol 3D (Splat): Best or Quick look, kept per mode and engine like the model pick, and whether the picture is a
  // photo, which belongs to the picture (shared by every mode). A picture uploaded or dropped here, or an earlier upload
  // picked from the library, is taken for a photo; a result made here for a render or a generated image.
  const [idolQualities, setIdolQualities] = useState<Record<string, IdolQuality>>({});
  const [idolPhoto, setIdolPhoto] = useState(true);
  // Idol 3D on your GPU: Advanced → Trim spikes (the open graph's max_scale; the cloud has no such setting).
  const [idolTrim, setIdolTrim] = useState(false);
  // The last value the drop gave (an upload reports twice: uploading, then done, from one closure).
  const lastPhoto = useRef<SlotValue | null>(null);
  const takePhoto = (v: SlotValue | null) => {
    const prev = lastPhoto.current;
    lastPhoto.current = v;
    setPhoto(v);
    const asPhoto = idolPhotoFor(v, prev);
    if (asPhoto !== undefined) setIdolPhoto(asPhoto);
  };
  const [views, setViews] = useState<Partial<Record<ViewSide, SlotValue | null>>>({});
  const [text, setText] = useState("");
  const [object, setObject] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [rigHint, setRigHint] = useState(false);
  // Refine detail · Hi3D 1.0 (open engine, From an image and From several images): the resolution, or off.
  const [refine, setRefine] = useState<Hi3dResolution | null>(null);
  const showRigHint = useCallback(() => setRigHint(true), []);
  // A picture handed over in the link (?image=). An image result's Make it 3D names Idol 3D and says what the picture is:
  // a result made here goes in as one, so Idol's photo crop starts off (the tighter crop suits a generated picture), and an
  // upload (?photo=1) starts it on. Other links (an Idol 3D result's "Build the final with TRELLIS.2") leave Idol's
  // "It's a photo" as it is: they don't say whether the picture is a photo (an Idol 3D draft's is usually the user's own upload).
  const [handed, setHanded] = useState<string | null>(null);
  const fromImage = useCallback((url: string, asPhoto?: boolean) => {
    const v: SlotValue = asPhoto === undefined ? { ref: url, preview: url, kind: "image" } : linkedPicture(url, asPhoto);
    lastPhoto.current = v;
    setPhoto(v);
    if (asPhoto === undefined) return;
    setIdolPhoto(asPhoto);
    setHanded(url);
  }, []);
  const fromUrl = useCallback(
    (m: Model3dMode, e: Engine, id: string, quality?: IdolQuality) => {
      setMode(m);
      setPicked((p) => ({ ...p, [`${m}:${e}`]: id }));
      setIdolQualities((p) => linkedIdolQuality(p, m, e, id, quality));
      setEngine(e);
    },
    [setEngine],
  );
  // "Build the final with TRELLIS.2" on a result card: fills the form on every click, also when the link is the URL already.
  const toFinal = useCallback(
    (url: string) => {
      const found = modeOf(FINAL_3D.model);
      if (found) fromUrl(found.mode, found.engine, FINAL_3D.model);
      fromImage(url);
    },
    [fromUrl, fromImage],
  );
  // A picture sent here ("Turn it into 3D" under a result): the photo of From an image, and the front of Several sides.
  const takeHandoff = useCallback((url: string) => {
    const slot: SlotValue = { ref: url, preview: url, kind: "image", id: nanoid(8) };
    setMode((m) => (m === "multi" || m === "text" ? "image" : m));
    setPhoto((p) => (p?.ref === url ? p : slot));
    setViews((v) => (v.front ? v : { ...v, front: slot }));
  }, []);
  // Models switched off in Settings → Models & licences leave the menu, and the pick falls back to one that is on.
  const choices = keepOffered(MODELS_3D[mode][engine], (m) => offered(access, m.id, engine));
  const wanted = picked[`${mode}:${engine}`];
  const modelId = model3dFor(mode, engine, wanted && choices.some((m) => m.id === wanted) ? wanted : choices[0]?.id);
  const sides = Object.fromEntries(VIEW_SIDES.flatMap((s) => (views[s] ? [[s, views[s]!.ref]] : []))) as Partial<Record<ViewSide, string>>;
  // Idol 3D in Splat, and Idol 3D quick mesh in From an image (Idol's graph runs first): Best or Quick look and the crop.
  const idolSplat = mode === "splat" && isIdol(modelId);
  const idol = idolSplat || (mode === "image" && engine === "open" && isIdolMesh(modelId));
  const idolQuality = idolQualities[`${mode}:${engine}`] ?? "best";
  const setIdolQuality = (q: IdolQuality) => setIdolQualities((p) => ({ ...p, [`${mode}:${engine}`]: q }));
  const input: Model3dInput = {
    engine,
    mode,
    modelId: modelId ?? undefined,
    photo: photo?.ref,
    views: sides,
    prompt: mode === "text" ? text : mode === "objects" ? object : undefined,
    ...(idol && { quality: idolQuality, photoCrop: idolPhoto, ...(engine === "open" && { trimSpikes: idolTrim }) }),
  };
  const uploading = !!photo?.uploading || VIEW_SIDES.some((s) => views[s]?.uploading);
  const blocker = model3dBlocker(input) ?? (uploading ? "Uploading…" : null);
  // The price before anything is attached: placeholders stand in for the files and the words.
  const priced: GenerationRequest | null = modelId
    ? model3dRequest({ ...input, photo: input.photo || PLACEHOLDER, views: { front: PLACEHOLDER, left: PLACEHOLDER, ...sides }, prompt: input.prompt?.trim() || "an object" })
    : null;
  const preview = useRunPreview(engineKnown ? priced : null);
  const price = priceLine(preview.data);
  const cloudAllowed = engineMode !== "open";
  // A guest, or an account without a key, on open models only: the cloud models run with its own fal.ai key, labelled,
  // and a press opens the step that sets it up (own-setup.ts).
  const visitorView = useStatus().data?.viewer;
  const keyInstead = !cloudAllowed && !!visitorView && visitorView.paidAllowed !== false;
  // Those models, after the open ones in the picker.
  const paidChoices = keyInstead ? MODELS_3D[mode].cloud : [];
  // Hi3D runs on your GPU only: offered while the install runs open models and the model is switched on (a visitor's
  // runs on its own GPU, its label beside the switch).
  const refineAllowed = engineMode !== "cloud" && offered(access, HI3D_MODEL, "open");
  // "Build the final with TRELLIS.2" on an Idol 3D result: while TRELLIS.2 runs here and is switched on.
  const finalAllowed = engineMode !== "cloud" && offered(access, FINAL_3D.model, "open");
  const refining = refineAllowed && engine === "open" && (mode === "image" || mode === "multi") && refine !== null ? refine : null;
  // A run with a step on the visitor's own GPU: a guest gets the sign-up card, an account without a GPU "Connect your GPU".
  const needs = refining !== null ? refineSetup : idolSplat && engine === "open" && idolTrim ? cleanSetup : null;
  const go = () => {
    if (blocker) return void toast(blocker, { id: "3d-blocker" });
    if (needs) return void press(needs, start);
    start();
  };
  const start = () => {
    create.mutate(withRefine(model3dRequest(input), engine, refining), {
      onSuccess: () =>
        toast.success(
          mode === "splat" ? "Making your splat" : mode === "text" && engine === "open" ? "Drawing the object, then building it in 3D" : refining ? "Building your 3D model, then refining its detail" : "Building your 3D model",
        ),
      onError: (e) => toastError(e),
    });
  };
  const items = (results.data ?? []).filter((g) => g.feature !== "image-to-3d-step");
  const setSide = (s: ViewSide) => (v: SlotValue | null) => setViews((cur) => ({ ...cur, [s]: v }));
  // From several images on your GPU, with only the front in: Idol 3D makes the other three sides from it (idol-8).
  const sidesOffered = useOtherSidesOffered();
  const front = views.front;
  const [sidesBusy, setSidesBusy] = useState(false);
  const otherSides = mode === "multi" && engine === "open" && sidesOffered && !!front && !front.uploading && (sidesBusy || canMakeOtherSides(views));
  // The views it made, so the note about them stays while they're in the slots.
  const [madeSides, setMadeSides] = useState<string[]>([]);
  const takeSides = useCallback((made: Partial<Record<ViewSide, string>>) => {
    setMadeSides((cur) => [...cur, ...Object.values(made).filter((u): u is string => !!u)]);
    setViews((cur) => fillOtherSides(cur, made, (url) => ({ ref: url, preview: url, kind: "image", source: "generation" })));
  }, []);
  const showsMade = mode === "multi" && VIEW_SIDES.some((s) => s !== "front" && !!views[s] && madeSides.includes(views[s]!.ref));
  return (
    <ToolShell title="Image to 3D">
      <Suspense fallback={null}>
        <UrlModel onModel={fromUrl} onMode={setMode} onRig={showRigHint} onImage={fromImage} />
        <HandoffImage onImage={takeHandoff} />
      </Suspense>
      <ToolHero title="Your product, in 3D" subtitle={HINTS[mode]} />
      <ModePicker mode={mode} onChange={pickMode} />
      {rigHint && (
        <p role="status" className="mx-auto mt-4 max-w-[880px] rounded-2xl border bg-brand-faint px-4 py-3 text-[13px] text-brand-text">
          <PersonStanding className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
          Rig &amp; animate works on a finished model: make one here
          {items.length > 0 && (
            <>
              {" "}
              or pick one under{" "}
              <a href="#your-3d-models" className="font-medium underline underline-offset-2">
                Your 3D models
              </a>
            </>
          )}
          , then press Rig &amp; animate on its card. Rigging runs on Meshy, in the cloud.
        </p>
      )}
      <div className="mx-auto mt-6 grid max-w-[880px] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {mode === "multi" ? (
          <Panel title="Photos of each side" aside={<span className="text-[12px] text-muted-foreground">{Object.keys(sides).length} of 4</span>}>
            {/* Four 80 px slots in a row when the panel has room for them (22rem), two by two when it doesn't. */}
            <div className="@container">
              <div className="grid grid-cols-2 justify-items-center gap-2 @[22rem]:grid-cols-4">
                {VIEW_SIDES.map((s) => (
                  <div key={s} className="flex flex-col items-center gap-1">
                    <MediaSlot label={SIDE_LABELS[s]} kind="image" value={views[s] ?? null} onChange={setSide(s)} required={s === "front"} size="lg" caption />
                    <span className="text-[11px] text-muted-foreground">{s === "front" ? "Needed" : "Optional"}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-[12px] text-muted-foreground">
              The front and at least one more side. Same object, same distance and light in each; a plain background helps.
              {engine === "open" && ` The open model puts each photo on the side you add it to. ${SIDES_HINT}`}
            </p>
            {otherSides && front && (
              <OtherSides className="mt-3" photo={front.ref} asPhoto={front.source !== "generation"} label="Make the other sides from the front (Idol 3D)" onMade={takeSides} onBusy={setSidesBusy} />
            )}
            {!otherSides && showsMade && <p className="mt-2 text-[12px] text-muted-foreground">Made by Idol 3D: {IDOL_VIEWS_NOTE.charAt(0).toLowerCase() + IDOL_VIEWS_NOTE.slice(1)}</p>}
          </Panel>
        ) : mode === "text" ? (
          <Panel title="Describe the object">
            <Label htmlFor="m3d-text" className="sr-only">
              Describe the object
            </Label>
            <Textarea
              id="m3d-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_3D_PROMPT))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
              }}
              placeholder="A brass ship's lantern with a glass globe and a carry ring"
              className="min-h-28 rounded-xl"
            />
            <p className="mt-2 text-[12px] text-muted-foreground">
              One object: what it is, its material and colours.{engine === "open" && " Qwen-Image 2.1 draws it on a plain background first; the finished model's card links to that still."}
            </p>
          </Panel>
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="min-w-0">
              <MediaDrop
                kind="image"
                value={photo}
                onChange={takePhoto}
                title={mode === "objects" ? "Add a photo" : "Add a photo of the object"}
                hint={mode === "objects" ? "A room, a shelf, a street: anything with the object in it" : "One object, plain background, well lit"}
                compact
              />
            </div>
            {mode === "objects" && (
              <Panel title="What to take out">
                <Label htmlFor="m3d-object" className="sr-only">
                  What to take out
                </Label>
                <Input
                  id="m3d-object"
                  value={object}
                  onChange={(e) => setObject(e.target.value.slice(0, 200))}
                  onKeyDown={(e) => e.key === "Enter" && go()}
                  placeholder="the green armchair"
                  className="h-9 rounded-full"
                />
                <p className="mt-2 text-[12px] text-muted-foreground">Name one thing, or several separated by commas. It&apos;s rebuilt where it stands; the rest of the photo is left out.</p>
              </Panel>
            )}
          </div>
        )}
        <Panel title="Model">
          {!modelId ? (
            <div className="space-y-3 text-[13px]">
              <p className="text-muted-foreground">
                Pick an object runs on SAM 3D Objects, a cloud model; no open model rebuilds one named object yet. On the open engine, crop the photo to the object and use From an image: Pixal3D cuts it out for you.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {cloudAllowed && (
                  <Button size="sm" className="rounded-full" onClick={() => setEngine("cloud")}>
                    Use the cloud
                  </Button>
                )}
                {keyInstead && (
                  <Button size="sm" className="rounded-full" onClick={() => press(MODEL3D_KEY)}>
                    Use the cloud
                    <OwnSetupChip setup={MODEL3D_KEY} className="bg-primary-foreground/15 text-primary-foreground" />
                  </Button>
                )}
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => setMode("image")}>
                  From an image
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m3d-model" className="sr-only">
                  Model
                </Label>
                <Select
                  value={modelId}
                  onValueChange={(v) => {
                    // A paid model a visitor runs with its own key: the step that sets it up (the pick stays).
                    if (v.startsWith(PAID_3D)) return void press(MODEL3D_KEY);
                    setPicked((p) => ({ ...p, [`${mode}:${engine}`]: v }));
                  }}
                >
                  <SelectTrigger id="m3d-model" className="h-9 w-full rounded-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {info[m.id]?.name ?? m.id}
                      </SelectItem>
                    ))}
                    {keyInstead &&
                      paidChoices.map((m) => (
                        <SelectItem key={m.id} value={`${PAID_3D}${m.id}`}>
                          {info[m.id]?.name ?? m.id}
                          <OwnSetupChip setup={MODEL3D_KEY} />
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-[12px] text-muted-foreground">{modelNote(choices.find((m) => m.id === modelId)?.note, owner)}</p>
              </div>
              {!idolSplat && (mode === "image" || mode === "multi") && <RefineOption engine={engine} value={refine} onChange={setRefine} openAllowed={refineAllowed} onUseGpu={() => setEngine("open")} />}
              {idol && (
                <IdolSettings
                  quality={idolQuality}
                  onQuality={setIdolQuality}
                  photo={idolPhoto}
                  onPhoto={setIdolPhoto}
                  trim={idolSplat && engine === "open" ? { on: idolTrim, onChange: setIdolTrim } : undefined}
                />
              )}
              {idolSplat && engine === "open" && !!handed && photo?.ref === handed && (
                <p className="mt-3 rounded-xl bg-brand-faint px-3 py-2 text-[12px] text-brand-text" data-testid="make-3d-hint">
                  {MAKE_3D_HINT}
                </p>
              )}
              <Button size="lg" className={cn("mt-4 w-full rounded-full", blocker && "bg-muted text-muted-foreground hover:bg-muted")} onClick={go} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Box className="size-4" />} {mode === "splat" ? "Make the splat" : "Make it 3D"}
              </Button>
              <p className="mt-2 text-[12px] text-muted-foreground" aria-live="polite">
                {blocker ? `${blocker} · ` : ""}
                {preview.isError ? (preview.error as Error).message : (price ?? "Working out the price…")}
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {idolSplat
                  ? engine === "open"
                    ? "Idol cuts the object out, builds the splat and renders an orbit video on your GPU. One object per picture."
                    : "Idol cuts the object out and builds the splat, ready to download. One object per picture."
                  : mode === "splat"
                    ? engine === "open"
                      ? "Cuts the subject out and comes with an orbit video."
                      : "Cuts the subject out, ready to download."
                    : engine === "open" && owner
                      ? "Comes with a turntable video of your model."
                      : "Download your model, or record a turntable right here."}
              </p>
            </>
          )}
        </Panel>
      </div>
      {examples && results.isSuccess && !items.length && <ExampleRow row={examples} layout="column" maxWidth={880} className="mt-12" />}
      <section id="your-3d-models" className="mx-auto mt-12 max-w-[880px] scroll-mt-6" aria-labelledby="models3d">
        {(results.isLoading || items.length > 0) && (
          <h3 id="models3d" className="mb-3 font-heading text-[22px]">
            Your 3D models
          </h3>
        )}
        {results.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="aspect-[4/3] rounded-2xl" />
            <Skeleton className="aspect-[4/3] rounded-2xl" />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((g) => (
              <ResultCard key={g.id} g={g} cloudAllowed={cloudAllowed} keyInstead={keyInstead} refineAllowed={refineAllowed} finalAllowed={finalAllowed} onFinal={toFinal} />
            ))}
          </div>
        )}
      </section>
    </ToolShell>
  );
}

/** A paid model's value in the picker (it never becomes the pick: choosing it opens the step that sets up a key). */
const PAID_3D = "paid:";

/**
 * A model's note under the picker. This studio renders the turntable of a model made on its own GPU; anyone else's
 * model comes without one (its card records one in the browser), so their note leaves it out.
 */
function modelNote(note: string | undefined, owner: boolean): string | undefined {
  return owner ? note : note?.replace(/, with a turntable video$/, "");
}

/** Retry runs the same request; a step of the open text-to-3D chain starts the chain again from the words. */
function retryOf(g: Generation): GenerationRequest {
  const r = g.request;
  if (r.chain?.length && r.op === "image-to-3d" && !r.inputs?.images?.length && r.prompt?.trim()) {
    return { feature: r.feature, modelId: "oss-text-trellis2", op: "text-to-3d", prompt: r.prompt, ...(r.params && { params: r.params }) };
  }
  return r;
}

function ResultCard({
  g,
  cloudAllowed,
  keyInstead,
  refineAllowed,
  finalAllowed,
  onFinal,
}: {
  g: Generation;
  cloudAllowed: boolean;
  keyInstead: boolean;
  refineAllowed: boolean;
  finalAllowed: boolean;
  onFinal: (photo: string) => void;
}) {
  const create = useCreate3d();
  if (g.status === "queued" || g.status === "running") return <PendingTile g={g} ratio={4 / 3} />;
  if (g.status !== "succeeded") return <FailedTile g={g} ratio={4 / 3} onRetry={() => create.mutate(retryOf(g), { onError: (e) => toastError(e) })} />;
  if (g.kind === "video") return <FilmCard g={g} />;
  return <ModelCard g={g} cloudAllowed={cloudAllowed} keyInstead={keyInstead} refineAllowed={refineAllowed} finalAllowed={finalAllowed} onFinal={onFinal} />;
}

/** A photoreal orbit filmed from a model ("Film it photoreal"): the clip, to watch and download. */
function FilmCard({ g }: { g: Generation }) {
  const video = g.outputs.find((o) => o.kind === "video");
  if (!video) return null;
  return (
    <article className="overflow-hidden rounded-2xl border bg-card">
      <video src={video.url} controls playsInline preload="metadata" className="aspect-[4/3] w-full bg-muted object-contain" aria-label="Photoreal orbit" />
      <div className="flex items-center justify-between gap-2 p-3">
        <p className="min-w-0 truncate text-[13px] font-medium">Photoreal orbit</p>
        <a href={video.url} download="photoreal orbit.mp4" className="shrink-0 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Download
        </a>
      </div>
    </article>
  );
}
